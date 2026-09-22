/**
 * Desktop ad and tracker blocking on top of the session's `webRequest` multiplexer
 * (`webRequest.ts`): one {@link BlockingHandler} that applies the core engine's decisions, the
 * text matcher for ABP filter lists and the bundled snapshot of the default lists.
 *
 * Matching: structured rules are decided by the core's `RuleEngine`; the ABP filter lists are
 * matched by Ghostery's `FiltersEngine` (MPL-2.0), which parses EasyList syntax natively and
 * answers in microseconds through its token index. It is faster and more complete than a matcher
 * written here would be, and it already handles `$redirect`, `$csp`, `$important` and
 * `$badfilter`. Its serialised form is cached so later starts skip parsing. Top-level documents
 * are the one thing it is not asked about: the core's `DocumentFilters` decides navigations with
 * uBlock Origin's rule (only `$document` / `$all` filters block a page), as the Kotlin engine does.
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
import { DocumentFilters } from '../../core/blocking/documentFilters'
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
  GHOSTERY_COMPILE_TASK,
  compileGhosteryEngine,
  type GhosteryCompileOutput
} from './blockingCompile'
import type { RequestHeaderHandler } from './requestHeaders'
import {
  HANDLER_ORDER,
  WebRequestMultiplexer,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type HeaderRewriteOptions,
  type HeadersReceivedResult,
  type HostRequest,
  type ListenerOptions,
  type RequestHandler,
  type TabResolver,
  type WebRequestBase,
  type WebRequestEvent,
  type WebRequestListener
} from './webRequest'

export type {
  BlockingResponse,
  HeaderRewriteOptions,
  ListenerFilter,
  ListenerOptions,
  WebRequestBase,
  WebRequestDetails,
  WebRequestEvent,
  WebRequestListener
} from './webRequest'
export type { RequestHeaderHandler } from './requestHeaders'
export { BLOCKING_EVENTS, WEB_REQUEST_EVENTS } from './webRequest'

// ---------------------------------------------------------------------------
// The blocking handler
// ---------------------------------------------------------------------------

const DECISION_KEY = 'blocking.decision'

/**
 * Where a decision was taken: `request` at `onBeforeRequest`, `headersReceived` at
 * `onHeadersReceived`, when a header-conditioned rule made the engine decide again with the
 * response headers in hand. Both stages of one request can be reported, in that order.
 */
export type DecisionStage = 'request' | 'headersReceived'

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
  readonly order = HANDLER_ORDER.ruleEngine

  constructor(
    private readonly decider: BlockingDecider,
    private readonly csp: CspSource | null,
    /**
     * Told about every decision a named rule took, with the request it was about and the stage
     * it was taken at. A request decided by a header-conditioned rule is reported at both stages
     * unless the same rule decided both.
     */
    private readonly observer:
      ((request: HostRequest, decision: Decision, stage: DecisionStage) => void) | null = null
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (!/^(https?|wss?):/i.test(ctx.url)) return undefined
    const decision = this.decider.decide(ctx)
    if (decision.matched && this.observer) this.observer(request, decision, 'request')
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
        // An allow that a header-conditioned rule may still overturn once the response headers
        // are in: keep it so onHeadersReceived knows to ask the engine again.
        if (decision.needsHeaders) request.state.set(DECISION_KEY, decision)
        return undefined
    }
  }

  onBeforeSendHeaders(request: HostRequest, headers: Record<string, string>): undefined {
    const decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.requestHeaders?.length) applyRequestHeaderOps(headers, decision.requestHeaders)
    return undefined
  }

  onHeadersReceived(
    request: HostRequest,
    headers: Record<string, string[]>
  ): HeadersReceivedResult | undefined {
    const { ctx } = request
    let decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.needsHeaders) {
      // The headers-received stage: the engine decides again with the response headers, merging
      // the header-conditioned rules with what it found at the request stage; that decision's
      // header edits replace the request stage's (they contain them). Reported under its stage
      // when a different rule decided it: a header-conditioned modifyHeaders rule stacked behind
      // the request stage's rule stays unreported (Chrome records every header action).
      const late = this.decider.decide({ ...ctx, responseHeaders: headers })
      if (late.matched && this.observer && !sameMatch(late.matched, decision.matched))
        this.observer(request, late, 'headersReceived')
      switch (late.action) {
        case 'block':
          this.decider.recordBlocked(request.tabId)
          return { cancel: true }
        case 'redirect':
        case 'upgrade':
          if (late.redirectUrl && late.redirectUrl !== ctx.url) {
            if (late.matched?.setId === TEXT_MATCH_SET_ID) this.decider.recordBlocked(request.tabId)
            return { redirectURL: late.redirectUrl }
          }
          break
        default:
          break
      }
      decision = late
    }
    if (decision?.responseHeaders?.length) applyResponseHeaderOps(headers, decision.responseHeaders)
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

function sameMatch(a: Decision['matched'], b: Decision['matched']): boolean {
  return a?.setId === b?.setId && a?.ruleId === b?.ruleId && a?.filter === b?.filter
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
 * The compile handed off the main process (`ElectronBlocking` gives the core's background queue
 * running `GHOSTERY_COMPILE_TASK`): the lists' text in, the serialised engine and the document
 * filters' lines out. Absent, the matcher parses on the spot (the tests, a host without a queue).
 */
export type GhosteryCompile = (parts: string[]) => Promise<GhosteryCompileOutput>

/**
 * Matches the enabled `filterText` sets with Ghostery's `FiltersEngine`. The engine is rebuilt
 * (off the current tick) whenever one of those sets changes – compiled in the background worker
 * when a {@link GhosteryCompile} is given, so the main process only deserialises the bytes, and
 * changes that land while a build is out are folded into the one build after it – and its
 * serialised form is cached under `blocking/engine.bin` so later starts deserialise in
 * milliseconds instead of parsing.
 */
export class GhosteryTextMatcher implements TextMatcher, CspSource {
  private engine: FiltersEngine | null = null
  /** The lists' document-level filters, decided here rather than by Ghostery. */
  private documents: DocumentFilters = DocumentFilters.EMPTY
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private building = false
  private dirty = false
  /** Filter text of sets changed since the last build (persisted sets are read from disk). */
  private readonly pendingText = new Map<string, string>()
  /** Builds so far, for tests and diagnostics. */
  builds = 0
  /** Whether the current engine came out of the cache. */
  fromCache = false
  /** Builds compiled off the main process so far (diagnostics and the tests). */
  compiledInBackground = 0

  constructor(
    private readonly source: TextSource,
    private readonly cacheDir: string,
    private readonly cacheVersion: string = app.getVersion(),
    private readonly rebuildDelayMs = 50,
    private readonly compile: GhosteryCompile | null = null
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
    if (ctx.type === 'main_frame') {
      const document = this.documents.decide(ctx.url)
      return document ? { action: document.action, filter: document.filter } : null
    }
    // An `@@…$document` exception on the page switches the lists off for everything it loads.
    const page = ctx.documentUrl ?? ctx.initiator
    if (page) {
      const exception = this.documents.exception(page)
      if (exception) return { action: 'allow', filter: exception }
    }
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

  /**
   * Parse (or deserialise) the enabled text sets. Synchronous without a {@link GhosteryCompile}
   * (~100 ms for the default lists on the spot); with one, the parse runs in the background and
   * the old engine answers until the new one is adopted (`ready` is false meanwhile).
   */
  rebuild(): void {
    if (this.building) {
      this.scheduleRebuild()
      return
    }
    this.building = true
    this.dirty = false
    const sets = this.source.engine.enabledTextSets()
    const fingerprint = sets.map((s) => `${s.id}:${s.updatedAt ?? 0}:${s.filterCount}`).join('|')
    let handedOff = false
    try {
      if (sets.length === 0) {
        // The master switch off disables every list. An empty engine is not worth caching, and
        // writing it would evict the lists' serialised form that the next switch on (and the
        // next start) deserialise instead of parsing.
        this.engine = FiltersEngine.parse('', { loadCosmeticFilters: false, debug: false })
        this.documents = DocumentFilters.parse([])
        this.fromCache = false
        this.pendingText.clear()
        return
      }
      const cached = this.readCache(fingerprint)
      if (cached) {
        this.engine = cached.engine
        this.documents = cached.documents
        this.fromCache = true
        this.pendingText.clear()
        return
      }
      const parts: string[] = []
      // The unpersisted text this build reads; only that is forgotten once it is in, so a set
      // that changes again while a background build is out keeps its newer text for the next.
      const used = new Map<string, string>()
      for (const summary of sets) {
        const pending = this.pendingText.get(summary.id)
        if (pending !== undefined) used.set(summary.id, pending)
        const text = pending ?? this.source.store.readFilterText(summary.id)
        if (text) parts.push(text)
      }
      if (this.compile) {
        handedOff = true
        void this.compile(parts)
          .then((output) => {
            this.compiledInBackground++
            this.adopt(
              FiltersEngine.deserialize(output.engine),
              DocumentFilters.parse([output.documents])
            )
            this.forgetUsed(used)
            this.writeCache(fingerprint, output.engine, output.documents)
          })
          .catch((error: unknown) => console.error('[zenium] filter engine build failed', error))
          .finally(() => this.finishBuild())
        return
      }
      const { engine, documents } = compileGhosteryEngine(parts)
      this.adopt(engine, documents)
      this.forgetUsed(used)
      this.writeCache(fingerprint, engine.serialize(), documents.lines.join('\n'))
    } catch (error) {
      console.error('[zenium] filter engine build failed', error)
    } finally {
      if (!handedOff) this.finishBuild()
    }
  }

  private adopt(engine: FiltersEngine, documents: DocumentFilters): void {
    this.engine = engine
    this.documents = documents
    this.fromCache = false
  }

  private forgetUsed(used: Map<string, string>): void {
    for (const [id, text] of used)
      if (this.pendingText.get(id) === text) this.pendingText.delete(id)
  }

  private finishBuild(): void {
    this.builds++
    this.building = false
    if (this.dirty) this.scheduleRebuild()
  }

  private cachePaths(): { bin: string; meta: string; documents: string } {
    return {
      bin: join(this.cacheDir, 'engine.bin'),
      meta: join(this.cacheDir, 'engine.json'),
      documents: join(this.cacheDir, 'documents.txt')
    }
  }

  private readCache(
    fingerprint: string
  ): { engine: FiltersEngine; documents: DocumentFilters } | null {
    const { bin, meta, documents } = this.cachePaths()
    try {
      if (!existsSync(bin) || !existsSync(meta) || !existsSync(documents)) return null
      const info = JSON.parse(readFileSync(meta, 'utf8')) as {
        fingerprint?: unknown
        version?: unknown
      }
      if (info.fingerprint !== fingerprint || info.version !== this.cacheVersion) return null
      return {
        engine: FiltersEngine.deserialize(new Uint8Array(readFileSync(bin))),
        documents: DocumentFilters.parse([readFileSync(documents, 'utf8')])
      }
    } catch {
      return null
    }
  }

  private writeCache(fingerprint: string, engine: Uint8Array, documents: string): void {
    const paths = this.cachePaths()
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const tmp = `${paths.bin}.${process.pid}.tmp`
      writeFileSync(tmp, engine)
      renameSync(tmp, paths.bin)
      writeFileSync(paths.documents, documents)
      writeFileSync(paths.meta, JSON.stringify({ fingerprint, version: this.cacheVersion }))
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

/**
 * A decision that named a rule, with the request (in `chrome.webRequest` shape) it was about and
 * the {@link DecisionStage} it was taken at. Listeners that do not tell the stages apart may
 * ignore the third argument; those that do see one request twice when a header-conditioned rule
 * overturned or extended the request stage's decision.
 */
export type DecisionListener = (
  request: WebRequestBase,
  decision: Decision,
  stage: DecisionStage
) => void

/** Everything desktop blocking needs, created once per app and attached to every session. */
export class ElectronBlocking {
  readonly multiplexer: WebRequestMultiplexer
  readonly matcher: GhosteryTextMatcher
  private stopMatcher: (() => void) | null = null
  private readonly decisionListeners = new Set<DecisionListener>()

  constructor(
    private readonly browser: Browser,
    views: TabResolver,
    profileDir: string
  ) {
    this.multiplexer = new WebRequestMultiplexer(views)
    this.matcher = new GhosteryTextMatcher(
      browser.blocking,
      join(profileDir, BLOCKING_DIR),
      undefined,
      undefined,
      // The compile in the core's background worker (inline on its fallback, as before).
      (parts) => browser.background.run(GHOSTERY_COMPILE_TASK, { parts })
    )
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
        this.matcher,
        (request, decision, stage) => {
          for (const listener of this.decisionListeners) listener(request.base, decision, stage)
        }
      )
    )
    blocking.engine.setTextMatcher(this.matcher)
    this.stopMatcher = this.matcher.start()
  }

  /**
   * Follow the decisions the engine took by a named rule (the default allow is not reported),
   * each with the stage it was taken at; the extensions' declarativeNetRequest layer keeps its
   * matched-rule log from them. Returns the function that stops following.
   */
  onDecision(listener: DecisionListener): () => void {
    this.decisionListeners.add(listener)
    return () => this.decisionListeners.delete(listener)
  }

  /** Every session – default, containers and the private one – gets the listeners. */
  attach(ses: Session, containerId: string): void {
    this.multiplexer.attach(ses, containerId)
  }

  /**
   * The listener host for the `chrome.webRequest` emulation: register a listener for one event
   * (blocking or not) and get back the function that removes it. The rule engine decides first;
   * listeners then run in a stable per-registrant order and their results compose as Chromium
   * composes extension results. See `webRequest.ts` for the details and result shapes.
   */
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void {
    return this.multiplexer.addListener(event, listener, options)
  }

  /** Remove every listener a registrant (an extension) added. */
  removeListenersOf(registrant: string): void {
    this.multiplexer.removeListenersOf(registrant)
  }

  /**
   * Register one of the browser's own header rewrites (the store's client hints, …). It runs
   * inside the session's one `onBeforeSendHeaders` hook, right after the rule engine; returns
   * the function that removes it.
   */
  registerHeaderRewrite(handler: RequestHeaderHandler, options?: HeaderRewriteOptions): () => void {
    return this.multiplexer.registerHeaderRewrite(handler, options)
  }

  stop(): void {
    this.stopMatcher?.()
    this.stopMatcher = null
  }
}
