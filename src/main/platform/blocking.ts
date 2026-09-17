/**
 * Desktop ad and tracker blocking on top of the session's `webRequest` multiplexer
 * (`webRequest.ts`): one {@link BlockingHandler} that applies the core engine's decisions, the
 * text matcher for ABP filter lists and the bundled snapshot of the default lists.
 *
 * Matching: structured rules are decided by the core's `RuleEngine`; the ABP filter lists are
 * matched by Ghostery's `FiltersEngine` (MPL-2.0), which parses EasyList syntax natively and
 * answers in microseconds through its token index. It is faster and more complete than a matcher
 * written here would be, and it already handles `$redirect`, `$csp`, `$important` and
 * `$badfilter`. Its serialised form is cached so later starts skip parsing.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { app, type Session } from 'electron'
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import type { Browser } from '../../core/browser'
import {
  TEXT_MATCH_SET_ID,
  type RuleEngine,
  type TextMatch,
  type TextMatcher
} from '../../core/blocking/engine'
import type { BlockingHost, BundledFilterList } from '../../core/platform'
import type { Decision, RequestContext, RuleSet } from '../../core/blocking/rules'
import { BLOCKING_DIR, type RuleSetStore } from '../../core/blocking/store'
import {
  WebRequestMultiplexer,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type HostRequest,
  type RequestHandler,
  type TabResolver
} from './webRequest'

// ---------------------------------------------------------------------------
// The blocking handler
// ---------------------------------------------------------------------------

const DECISION_KEY = 'blocking.decision'

/** What the handler needs from the core: decisions and the counters. */
export interface BlockingDecider {
  decide(ctx: RequestContext): Decision
  recordBlocked(tabId: string | undefined, count?: number): void
}

/** The text matcher's extra answer for documents: `$csp` directives the lists inject. */
export interface CspSource {
  cspDirectives(ctx: RequestContext): string | null
}

/** Applies the core engine's decisions: cancel, redirect, header edits and `$csp` directives. */
export class BlockingHandler implements RequestHandler {
  readonly id = 'blocking'
  readonly order = 100

  constructor(
    private readonly decider: BlockingDecider,
    private readonly csp: CspSource | null
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (!/^(https?|wss?):/i.test(ctx.url)) return undefined
    const decision = this.decider.decide(ctx)
    switch (decision.action) {
      case 'block':
        this.decider.recordBlocked(request.tabId)
        return { cancel: true }
      case 'redirect':
      case 'upgrade':
        if (decision.redirectUrl && decision.redirectUrl !== ctx.url) {
          // A list's `$redirect` to a neutered resource is a blocked request from the user's
          // point of view; a translator's plain redirect or an upgrade is not.
          if (decision.matched?.setId === TEXT_MATCH_SET_ID)
            this.decider.recordBlocked(request.tabId)
          return { redirectURL: decision.redirectUrl }
        }
        return undefined
      case 'modifyHeaders':
        request.state.set(DECISION_KEY, decision)
        return undefined
      default:
        return undefined
    }
  }

  onBeforeSendHeaders(request: HostRequest, headers: Record<string, string>): undefined {
    const decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.requestHeaders?.length) applyRequestHeaderOps(headers, decision.requestHeaders)
    return undefined
  }

  onHeadersReceived(request: HostRequest, headers: Record<string, string[]>): undefined {
    const decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.responseHeaders?.length) applyResponseHeaderOps(headers, decision.responseHeaders)
    const { ctx } = request
    if (this.csp && (ctx.type === 'main_frame' || ctx.type === 'sub_frame')) {
      const csp = this.csp.cspDirectives(ctx)
      if (csp)
        applyResponseHeaderOps(headers, [
          { header: 'Content-Security-Policy', operation: 'append', value: csp }
        ])
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Ghostery text matcher
// ---------------------------------------------------------------------------

/** Ghostery request types the core's resource types map to. */
function ghosteryType(type: RequestContext['type']): string {
  switch (type) {
    case 'webtransport':
    case 'webbundle':
      return 'other'
    default:
      return type
  }
}

/** What the matcher follows: the core engine (which sets are on) and the store (their text). */
export interface TextSource {
  engine: RuleEngine
  store: Pick<RuleSetStore, 'readFilterText'>
}

/**
 * Matches the enabled `filterText` sets with Ghostery's `FiltersEngine`. The engine is rebuilt
 * (off the current tick) whenever one of those sets changes, and its serialised form is cached
 * under `blocking/engine.bin` so later starts deserialise in milliseconds instead of parsing.
 */
export class GhosteryTextMatcher implements TextMatcher, CspSource {
  private engine: FiltersEngine | null = null
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private building = false
  private dirty = false
  /** Filter text of sets changed since the last build (persisted sets are read from disk). */
  private readonly pendingText = new Map<string, string>()
  /** Builds so far, for tests and diagnostics. */
  builds = 0
  /** Whether the current engine came out of the cache. */
  fromCache = false

  constructor(
    private readonly source: TextSource,
    private readonly cacheDir: string,
    private readonly cacheVersion: string = app.getVersion(),
    private readonly rebuildDelayMs = 50
  ) {}

  /** Follow the core engine; returns the unsubscribe function. */
  start(): () => void {
    const unsubscribe = this.source.engine.subscribe((change) => {
      if (change.kind === 'set' && change.set?.filterText !== undefined && !change.persisted)
        this.pendingText.set(change.id, change.set.filterText)
      else if (change.kind === 'remove') this.pendingText.delete(change.id)
      const textual =
        change.kind === 'remove' ||
        change.summary?.hasFilterText ||
        (change.set?.filterText ?? '').length > 0
      if (textual) this.scheduleRebuild()
    })
    this.scheduleRebuild()
    return () => {
      unsubscribe()
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
      this.rebuildTimer = null
    }
  }

  /** True once a build reflects the current sets. */
  get ready(): boolean {
    return this.engine !== null && !this.dirty && !this.building
  }

  match(ctx: RequestContext): TextMatch | null {
    const engine = this.engine
    if (!engine) return null
    const result = engine.match(this.requestFor(ctx))
    if (result.exception) return { action: 'allow', filter: result.exception.toString() }
    if (result.redirect)
      return {
        action: 'redirect',
        redirectUrl: result.redirect.dataUrl,
        filter: result.filter?.toString()
      }
    if (result.match) return { action: 'block', filter: result.filter?.toString() }
    return null
  }

  /** `$csp` directives the lists want injected into a document, or null. */
  cspDirectives(ctx: RequestContext): string | null {
    const engine = this.engine
    if (!engine) return null
    return engine.getCSPDirectives(this.requestFor(ctx)) ?? null
  }

  private requestFor(ctx: RequestContext): Request {
    return Request.fromRawDetails({
      url: ctx.url,
      sourceUrl: ctx.initiator ?? ctx.documentUrl ?? '',
      type: ghosteryType(ctx.type) as Request['type'],
      tabId: ctx.tabId ? Number(ctx.tabId.replace(/\D+/g, '')) || 0 : 0
    })
  }

  private scheduleRebuild(): void {
    this.dirty = true
    if (this.rebuildTimer) return
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.rebuild()
    }, this.rebuildDelayMs)
  }

  /** Parse (or deserialise) the enabled text sets. Synchronous; ~100 ms for the default lists. */
  rebuild(): void {
    if (this.building) {
      this.scheduleRebuild()
      return
    }
    this.building = true
    this.dirty = false
    const sets = this.source.engine.enabledTextSets()
    const fingerprint = sets.map((s) => `${s.id}:${s.updatedAt ?? 0}:${s.filterCount}`).join('|')
    try {
      const cached = this.readCache(fingerprint)
      if (cached) {
        this.engine = cached
        this.fromCache = true
        this.pendingText.clear()
        return
      }
      const parts: string[] = []
      for (const summary of sets) {
        const text =
          this.pendingText.get(summary.id) ?? this.source.store.readFilterText(summary.id)
        if (text) parts.push(text)
      }
      const engine = FiltersEngine.parse(parts.join('\n'), {
        loadCosmeticFilters: false,
        enableCompression: false,
        enableOptimizations: true,
        debug: false
      })
      this.engine = engine
      this.fromCache = false
      this.pendingText.clear()
      this.writeCache(fingerprint, engine)
    } catch (error) {
      console.error('[zenium] filter engine build failed', error)
    } finally {
      this.builds++
      this.building = false
      if (this.dirty) this.scheduleRebuild()
    }
  }

  private cachePaths(): { bin: string; meta: string } {
    return { bin: join(this.cacheDir, 'engine.bin'), meta: join(this.cacheDir, 'engine.json') }
  }

  private readCache(fingerprint: string): FiltersEngine | null {
    const { bin, meta } = this.cachePaths()
    try {
      if (!existsSync(bin) || !existsSync(meta)) return null
      const info = JSON.parse(readFileSync(meta, 'utf8')) as {
        fingerprint?: unknown
        version?: unknown
      }
      if (info.fingerprint !== fingerprint || info.version !== this.cacheVersion) return null
      return FiltersEngine.deserialize(new Uint8Array(readFileSync(bin)))
    } catch {
      return null
    }
  }

  private writeCache(fingerprint: string, engine: FiltersEngine): void {
    const { bin, meta } = this.cachePaths()
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const tmp = `${bin}.${process.pid}.tmp`
      writeFileSync(tmp, engine.serialize())
      renameSync(tmp, bin)
      writeFileSync(meta, JSON.stringify({ fingerprint, version: this.cacheVersion }))
    } catch (error) {
      console.warn('[zenium] filter engine cache not written', error)
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled snapshot
// ---------------------------------------------------------------------------

export interface BundleManifest {
  builtAt: number
  lists: Array<{ id: string; file: string; version: string | null; filterCount: number }>
}

/** The default lists' snapshot shipped in `resources/blocking/` (gzipped network filters). */
export class ElectronBundledLists implements BlockingHost {
  constructor(
    private readonly bundleDir: string,
    private readonly profileDir: string
  ) {}

  async bundledLists(): Promise<BundledFilterList[]> {
    const manifest = this.manifest()
    if (!manifest) return []
    return manifest.lists.map((l) => ({
      id: l.id,
      version: l.version,
      builtAt: manifest.builtAt,
      filterCount: l.filterCount
    }))
  }

  async installBundled(set: RuleSet, file: string): Promise<BundledFilterList | null> {
    const manifest = this.manifest()
    const entry = manifest?.lists.find((l) => l.id === set.id)
    if (!manifest || !entry) return null
    const text = gunzipSync(await fs.readFile(join(this.bundleDir, entry.file))).toString('utf8')
    const document: RuleSet = { ...set, filterText: text }
    const target = join(this.profileDir, file)
    await fs.mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(document), 'utf8')
    await fs.rename(tmp, target)
    return {
      id: entry.id,
      version: entry.version,
      builtAt: manifest.builtAt,
      filterCount: entry.filterCount
    }
  }

  private manifest(): BundleManifest | null {
    try {
      const raw = readFileSync(join(this.bundleDir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<BundleManifest>
      if (typeof parsed.builtAt !== 'number' || !Array.isArray(parsed.lists)) return null
      return { builtAt: parsed.builtAt, lists: parsed.lists }
    } catch {
      return null
    }
  }
}

/**
 * `resources/blocking` of this build. Packaged, `resources/**` is unpacked next to the asar
 * (electron-builder.yml `asarUnpack`) and Electron's fs resolves the asar path to it.
 */
export function bundledListsDirectory(): string {
  return join(app.getAppPath(), 'resources', 'blocking')
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Everything desktop blocking needs, created once per app and attached to every session. */
export class ElectronBlocking {
  readonly multiplexer: WebRequestMultiplexer
  readonly matcher: GhosteryTextMatcher
  private stopMatcher: (() => void) | null = null

  constructor(
    private readonly browser: Browser,
    views: TabResolver,
    profileDir: string
  ) {
    this.multiplexer = new WebRequestMultiplexer(views)
    this.matcher = new GhosteryTextMatcher(browser.blocking, join(profileDir, BLOCKING_DIR))
  }

  /** Register the blocking handler and start following the core engine. */
  start(): void {
    const { blocking } = this.browser
    this.multiplexer.register(
      new BlockingHandler(
        {
          decide: (ctx) => blocking.engine.decide(ctx),
          recordBlocked: (tabId, count) => blocking.recordBlocked(tabId, count)
        },
        this.matcher
      )
    )
    blocking.engine.setTextMatcher(this.matcher)
    this.stopMatcher = this.matcher.start()
  }

  /** Every session – default, containers and the private one – gets the listeners. */
  attach(ses: Session, containerId: string): void {
    this.multiplexer.attach(ses, containerId)
  }

  stop(): void {
    this.stopMatcher?.()
    this.stopMatcher = null
  }
}
