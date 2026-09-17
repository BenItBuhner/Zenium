/**
 * Desktop request blocking.
 *
 * Electron lets a session have exactly one listener per `webRequest` event, and any listener the
 * host installs switches off extension `webRequest` / `declarativeNetRequest` handling for that
 * partition. So this module owns the one `onBeforeRequest`, `onBeforeSendHeaders` and
 * `onHeadersReceived` listener of every session (default, containers, private) and multiplexes
 * them over an ordered list of {@link RequestHandler}s: ad and tracker blocking registers here,
 * and later features (Safe Browsing, HTTPS-only, GPC / DNT headers, cookie rules) register more
 * handlers instead of adding listeners.
 *
 * Matching: structured rules are decided by the core's `RuleEngine`; the ABP filter lists are
 * matched by Ghostery's `FiltersEngine` (MPL-2.0), which parses EasyList syntax natively and
 * answers in microseconds through its token index – faster and more complete than a matcher
 * written here would be, and it already handles `$redirect`, `$csp`, `$important` and `$badfilter`.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { app, type Session } from 'electron'
import { existsSync, mkdirSync, promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import type { Browser } from '../../core/browser'
import { TEXT_MATCH_SET_ID, resourceTypeFromElectron, type TextMatch, type TextMatcher } from '../../core/blocking/engine'
import type { BlockingHost, BundledFilterList } from '../../core/platform'
import type { Decision, HeaderOp, RequestContext, RuleSet } from '../../core/blocking/rules'
import { BLOCKING_DIR } from '../../core/blocking/store'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import type { ElectronTabViewHost } from './views'

type BeforeRequestDetails = Electron.OnBeforeRequestListenerDetails
type BeforeSendHeadersDetails = Electron.OnBeforeSendHeadersListenerDetails
type HeadersReceivedDetails = Electron.OnHeadersReceivedListenerDetails

/** One request as the handlers see it: the core's context plus the host's bookkeeping. */
export interface HostRequest {
  ctx: RequestContext
  containerId: string
  tabId: string | undefined
  /** Scratch space a handler keeps between the three phases of one request. */
  state: Map<string, unknown>
}

export type BeforeRequestResult = { cancel: true } | { redirectURL: string } | undefined

export interface BeforeSendHeadersResult {
  cancel?: boolean
}

export interface HeadersReceivedResult {
  cancel?: boolean
  statusLine?: string
}

/**
 * A participant in the request pipeline. Handlers run from the lowest `order` to the highest;
 * in `onBeforeRequest` the first definitive answer (cancel or redirect) ends the chain, in the
 * header phases every handler runs and edits the headers in place.
 */
export interface RequestHandler {
  id: string
  order: number
  onBeforeRequest?(request: HostRequest, details: BeforeRequestDetails): BeforeRequestResult
  onBeforeSendHeaders?(
    request: HostRequest,
    headers: Record<string, string>,
    details: BeforeSendHeadersDetails
  ): BeforeSendHeadersResult | undefined
  onHeadersReceived?(
    request: HostRequest,
    headers: Record<string, string[]>,
    details: HeadersReceivedDetails
  ): HeadersReceivedResult | undefined
}

/** Requests whose context outlived their completion events are dropped past this many. */
const MAX_TRACKED_REQUESTS = 4096

/**
 * The single set of `webRequest` listeners per session, fanned out to ordered handlers.
 */
export class WebRequestMultiplexer {
  private readonly handlers: RequestHandler[] = []
  private readonly attached = new WeakSet<Session>()
  private readonly requests = new Map<number, HostRequest>()

  constructor(private readonly views: ElectronTabViewHost) {}

  /** Add a handler; returns the function that removes it again. */
  register(handler: RequestHandler): () => void {
    this.handlers.push(handler)
    this.handlers.sort((a, b) => a.order - b.order)
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index !== -1) this.handlers.splice(index, 1)
    }
  }

  handlerIds(): string[] {
    return this.handlers.map((h) => h.id)
  }

  /** Install the listeners on the session of `containerId` (once per session). */
  attach(ses: Session, containerId: string): void {
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.webRequest.onBeforeRequest((details, callback) => {
      const request = this.begin(details, containerId)
      let result: BeforeRequestResult
      for (const handler of this.handlers) {
        if (!handler.onBeforeRequest) continue
        try {
          result = handler.onBeforeRequest(request, details)
        } catch (error) {
          console.error(`[zenium] request handler ${handler.id} failed`, error)
          result = undefined
        }
        if (result) break
      }
      if (result && 'cancel' in result) {
        this.requests.delete(details.id)
        callback({ cancel: true })
      } else if (result) {
        callback({ redirectURL: result.redirectURL })
      } else {
        callback({})
      }
    })
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const request = this.requests.get(details.id) ?? this.begin(details, containerId)
      const headers: Record<string, string> = { ...details.requestHeaders }
      let cancel = false
      for (const handler of this.handlers) {
        if (!handler.onBeforeSendHeaders) continue
        try {
          const result = handler.onBeforeSendHeaders(request, headers, details)
          if (result?.cancel) cancel = true
        } catch (error) {
          console.error(`[zenium] request handler ${handler.id} failed`, error)
        }
      }
      if (cancel) {
        this.requests.delete(details.id)
        callback({ cancel: true })
      } else {
        callback({ requestHeaders: headers })
      }
    })
    ses.webRequest.onHeadersReceived((details, callback) => {
      const request = this.requests.get(details.id) ?? this.begin(details, containerId)
      const headers = normalizeResponseHeaders(details.responseHeaders)
      let cancel = false
      let statusLine: string | undefined
      for (const handler of this.handlers) {
        if (!handler.onHeadersReceived) continue
        try {
          const result = handler.onHeadersReceived(request, headers, details)
          if (result?.cancel) cancel = true
          if (result?.statusLine) statusLine = result.statusLine
        } catch (error) {
          console.error(`[zenium] request handler ${handler.id} failed`, error)
        }
      }
      if (cancel) {
        this.requests.delete(details.id)
        callback({ cancel: true })
      } else {
        callback(statusLine ? { responseHeaders: headers, statusLine } : { responseHeaders: headers })
      }
    })
    ses.webRequest.onCompleted((details) => this.requests.delete(details.id))
    ses.webRequest.onErrorOccurred((details) => this.requests.delete(details.id))
  }

  /** Build the shared request record for `details` (the first phase that sees a request). */
  private begin(
    details: BeforeRequestDetails | BeforeSendHeadersDetails | HeadersReceivedDetails,
    containerId: string
  ): HostRequest {
    const wc = details.webContents
    const tabId = wc && !wc.isDestroyed() ? this.views.tabIdForWebContents(wc) : undefined
    const request: HostRequest = {
      ctx: contextFor(details, containerId, tabId),
      containerId,
      tabId,
      state: new Map()
    }
    if (this.requests.size >= MAX_TRACKED_REQUESTS) {
      const oldest = this.requests.keys().next().value
      if (oldest !== undefined) this.requests.delete(oldest)
    }
    this.requests.set(details.id, request)
    return request
  }
}

/** The core's request context for an Electron `webRequest` details object. */
export function contextFor(
  details: BeforeRequestDetails | BeforeSendHeadersDetails | HeadersReceivedDetails,
  containerId: string,
  tabId: string | undefined
): RequestContext {
  const type = resourceTypeFromElectron(details.resourceType)
  let frameUrl: string | undefined
  try {
    frameUrl = details.frame?.url || undefined
  } catch {
    frameUrl = undefined
  }
  const wc = details.webContents
  const topUrl = wc && !wc.isDestroyed() ? wc.getURL() || undefined : undefined
  // The referrer is the requesting document; a frame's own URL stands in when the referrer
  // policy stripped it. For a frame navigation `frame` is the frame being navigated, so the
  // referrer (its parent) comes first.
  const initiator = details.referrer || frameUrl || (type === 'main_frame' ? undefined : topUrl)
  const ctx: RequestContext = {
    url: details.url,
    type,
    method: details.method,
    partition: containerId,
    isPrivate: containerId === PRIVATE_CONTAINER_ID
  }
  if (initiator) ctx.initiator = initiator
  if (type !== 'main_frame' && (topUrl || initiator)) ctx.documentUrl = topUrl ?? initiator
  if (tabId) ctx.tabId = tabId
  return ctx
}

function normalizeResponseHeaders(
  headers: Record<string, string | string[]> | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!headers) return out
  for (const [name, value] of Object.entries(headers))
    out[name] = Array.isArray(value) ? [...value] : [value]
  return out
}

// ---------------------------------------------------------------------------
// Header operations
// ---------------------------------------------------------------------------

function findHeader<T>(headers: Record<string, T>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(headers).find((k) => k.toLowerCase() === lower)
}

/** Apply declarativeNetRequest header edits to a request-header map. */
export function applyRequestHeaderOps(headers: Record<string, string>, ops: HeaderOp[]): void {
  for (const op of ops) {
    const existing = findHeader(headers, op.header)
    switch (op.operation) {
      case 'remove':
        if (existing) delete headers[existing]
        break
      case 'set':
        if (existing) delete headers[existing]
        if (op.value !== undefined) headers[op.header] = op.value
        break
      case 'append':
        // Request headers are single valued: append joins with a comma as Chrome does.
        if (existing) headers[existing] = `${headers[existing]}, ${op.value ?? ''}`
        else if (op.value !== undefined) headers[op.header] = op.value
        break
    }
  }
}

/** Apply declarativeNetRequest header edits to a response-header map. */
export function applyResponseHeaderOps(headers: Record<string, string[]>, ops: HeaderOp[]): void {
  for (const op of ops) {
    const existing = findHeader(headers, op.header)
    switch (op.operation) {
      case 'remove':
        if (existing) delete headers[existing]
        break
      case 'set':
        if (existing) delete headers[existing]
        if (op.value !== undefined) headers[op.header] = [op.value]
        break
      case 'append':
        if (op.value === undefined) break
        if (existing) headers[existing].push(op.value)
        else headers[op.header] = [op.value]
        break
    }
  }
}

// ---------------------------------------------------------------------------
// The blocking handler
// ---------------------------------------------------------------------------

const DECISION_KEY = 'blocking.decision'

/** Applies the core engine's decisions: cancel, redirect, header edits and `$csp` directives. */
export class BlockingHandler implements RequestHandler {
  readonly id = 'blocking'
  readonly order = 100

  constructor(
    private readonly browser: Browser,
    private readonly matcher: GhosteryTextMatcher
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (!/^(https?|wss?):/i.test(ctx.url)) return undefined
    const decision = this.browser.blocking.engine.decide(ctx)
    switch (decision.action) {
      case 'block':
        this.browser.blocking.recordBlocked(request.tabId)
        return { cancel: true }
      case 'redirect':
      case 'upgrade':
        if (decision.redirectUrl && decision.redirectUrl !== ctx.url) {
          if (decision.matched?.setId === TEXT_MATCH_SET_ID)
            this.browser.blocking.recordBlocked(request.tabId)
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
    if (decision?.responseHeaders?.length)
      applyResponseHeaderOps(headers, decision.responseHeaders)
    const { ctx } = request
    if (ctx.type === 'main_frame' || ctx.type === 'sub_frame') {
      const csp = this.matcher.cspDirectives(ctx)
      if (csp) applyResponseHeaderOps(headers, [{ header: 'Content-Security-Policy', operation: 'append', value: csp }])
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

/**
 * Matches the enabled `filterText` sets with Ghostery's `FiltersEngine`. The engine is rebuilt
 * (off the current tick) whenever one of those sets changes, and its serialised form is cached
 * under `blocking/engine.bin` so later starts deserialise in milliseconds instead of parsing.
 */
export class GhosteryTextMatcher implements TextMatcher {
  private engine: FiltersEngine | null = null
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private building = false
  private dirty = false
  /** Filter text of sets changed since the last build (persisted sets are read from disk). */
  private readonly pendingText = new Map<string, string>()

  constructor(
    private readonly browser: Browser,
    private readonly cacheDir: string
  ) {}

  /** Follow the core engine; returns the unsubscribe function. */
  start(): () => void {
    const unsubscribe = this.browser.blocking.engine.subscribe((change) => {
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
    return unsubscribe
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
      return { action: 'redirect', redirectUrl: result.redirect.dataUrl, filter: result.filter?.toString() }
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
    }, 50)
  }

  /** Parse (or deserialise) the enabled text sets. Synchronous; ~100 ms for the default lists. */
  rebuild(): void {
    if (this.building) {
      this.scheduleRebuild()
      return
    }
    this.building = true
    this.dirty = false
    const { blocking } = this.browser
    const sets = blocking.engine.enabledTextSets()
    const fingerprint = sets
      .map((s) => `${s.id}:${s.updatedAt ?? 0}:${s.filterCount}`)
      .join('|')
    try {
      const cached = this.readCache(fingerprint)
      if (cached) {
        this.engine = cached
        return
      }
      const parts: string[] = []
      for (const summary of sets) {
        const text = this.pendingText.get(summary.id) ?? blocking.store.readFilterText(summary.id)
        if (text) parts.push(text)
      }
      const engine = FiltersEngine.parse(parts.join('\n'), {
        loadCosmeticFilters: false,
        enableCompression: false,
        enableOptimizations: true,
        debug: false
      })
      this.engine = engine
      this.pendingText.clear()
      this.writeCache(fingerprint, engine)
    } catch (error) {
      console.error('[zenium] filter engine build failed', error)
    } finally {
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
      const info = JSON.parse(readFileSync(meta, 'utf8')) as { fingerprint?: unknown; version?: unknown }
      if (info.fingerprint !== fingerprint || info.version !== app.getVersion()) return null
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
      writeFileSync(meta, JSON.stringify({ fingerprint, version: app.getVersion() }))
    } catch (error) {
      console.warn('[zenium] filter engine cache not written', error)
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled snapshot
// ---------------------------------------------------------------------------

interface BundleManifest {
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
    return { id: entry.id, version: entry.version, builtAt: manifest.builtAt, filterCount: entry.filterCount }
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

/** `resources/blocking` of this build (inside the asar's unpacked resources when packaged). */
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
    views: ElectronTabViewHost,
    profileDir: string
  ) {
    this.multiplexer = new WebRequestMultiplexer(views)
    this.matcher = new GhosteryTextMatcher(browser, join(profileDir, BLOCKING_DIR))
  }

  /** Register the blocking handler and start following the core engine. */
  start(): void {
    this.multiplexer.register(new BlockingHandler(this.browser, this.matcher))
    this.browser.blocking.engine.setTextMatcher(this.matcher)
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
