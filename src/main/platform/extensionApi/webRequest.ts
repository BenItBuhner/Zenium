import type {
  BlockingResponse,
  ListenerOptions,
  WebRequestDetails,
  WebRequestEvent,
  WebRequestListener
} from '../blocking'
import {
  BLOCKING_ANSWER_TIMEOUT_MS,
  BLOCKING_PERMISSION_ERROR,
  WEB_REQUEST_EVENT_NAMES,
  canAccessRequest,
  chromeRequestDetails,
  compileRequestFilter,
  normalizeBlockingResponse,
  normalizeRequestListener,
  requestFilterMatches,
  type CompiledRequestFilter,
  type RequestListenerSpec,
  type WebRequestEventName
} from '../../../core/extensions/api/webRequest'
import type { EventDelivery } from '../../../core/extensions/api/shim'
import type { FrameContext, WorkerContext } from './contexts'
import {
  ApiError,
  TAB_ID_NONE,
  WINDOW_ID_NONE,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type NamespaceHandlers
} from './types'

/**
 * What the emulation needs of the session's request pipeline: `ElectronBlocking`, whose
 * multiplexer owns each session's one `webRequest` hook and composes listener results the way
 * Chromium composes extension results.
 */
export interface WebRequestListenerHost {
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void
  removeListenersOf(registrant: string): void
}

type Context = FrameContext | WorkerContext

/** One `addListener` of one context, as the shim registered it. */
interface Registration {
  /** The shim's id of the listener, per context; deliveries are addressed to it. */
  id: number
  event: WebRequestEventName
  extensionId: string
  context: Context
  spec: RequestListenerSpec
  filter: CompiledRequestFilter
  /** Removes the pipeline listener; null until a listener host is attached (or for `onAuthRequired`). */
  off: (() => void) | null
}

/** A blocking delivery waiting for the shim's answer. */
interface Pending {
  extensionId: string
  event: WebRequestEventName
  resolve: (answer: BlockingResponse | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

const PERMISSIONS = ['webRequest', 'webRequestBlocking']

/**
 * `chrome.webRequest` for the browser layer. Electron has the binding, but a session with its
 * own `webRequest` hook (the blocking engine's) never fires it, so the events run over that hook
 * instead: every listener an extension context registers becomes one listener of the session
 * pipeline (`WebRequestListenerHost`), registered under the extension's id so the pipeline
 * orders and composes the results as Chromium does across extensions (newer installs first).
 *
 * A request reaches a listener when the extension has host access to it (the URL, and for
 * anything but a navigation the initiator too), the registration's `RequestFilter` matches,
 * and the context that registered is still alive. The delivery carries Chrome's details for
 * the event with the headers the `extraInfoSpec` asked for, addressed to the listener's id.
 * A `blocking` listener's delivery also carries a token; the shim answers with the listener's
 * return value, which the pipeline applies (`cancel`, `redirectUrl`, `requestHeaders`,
 * `responseHeaders`). An answer that does not arrive within the timeout leaves the request
 * unchanged. Only MV2 extensions holding `webRequestBlocking` may block, as in Chrome.
 */
export class WebRequestApi {
  private listenerHost: WebRequestListenerHost | null = null
  /** By extension, then context key, then the shim's listener id. */
  private readonly registrations = new Map<string, Map<string, Map<number, Registration>>>()
  private readonly pending = new Map<number, Pending>()
  private tokens = 0
  /** Extensions already warned about a blocking listener that did not answer in time. */
  private readonly warned = new Set<string>()

  constructor(
    private readonly host: ApiHost,
    private readonly timeoutMs: number = BLOCKING_ANSWER_TIMEOUT_MS
  ) {}

  readonly handlers: NamespaceHandlers = {
    addListener: (ctx, event, filter, spec, id) => this.addListener(ctx, event, filter, spec, id),
    removeListener: (ctx, event, id) => this.removeListener(ctx, event, id)
  }

  /** The session pipeline is created after the API host: hook what registered meanwhile. */
  attach(listenerHost: WebRequestListenerHost): void {
    this.listenerHost = listenerHost
    for (const byContext of this.registrations.values())
      for (const own of byContext.values())
        for (const registration of own.values()) this.hook(registration)
  }

  /** An extension was unloaded: its listeners go, and its pending answers count as none. */
  unload(extensionId: string): void {
    const byContext = this.registrations.get(extensionId)
    if (byContext) {
      for (const own of byContext.values())
        for (const registration of own.values()) registration.off?.()
      this.registrations.delete(extensionId)
    }
    this.listenerHost?.removeListenersOf(extensionId)
    for (const [token, pending] of this.pending) {
      if (pending.extensionId !== extensionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(token)
      pending.resolve(undefined)
    }
  }

  /** The shim's answer to a blocking delivery (`webRequest-answer`). */
  answer(ctx: ApiContext, payload: unknown): void {
    if (!isRecord(payload) || !isInteger(payload.token)) return
    const pending = this.pending.get(payload.token)
    if (!pending || pending.extensionId !== ctx.extensionId) return
    clearTimeout(pending.timer)
    this.pending.delete(payload.token)
    pending.resolve(normalizeBlockingResponse(pending.event, payload.response))
  }

  /** Live registrations (of one extension, or all), for diagnostics and tests. */
  listenerCount(extensionId?: string): number {
    let count = 0
    for (const [id, byContext] of this.registrations) {
      if (extensionId !== undefined && id !== extensionId) continue
      for (const own of byContext.values()) count += own.size
    }
    return count
  }

  /** Blocking deliveries waiting for an answer, for tests. */
  get pendingAnswers(): number {
    return this.pending.size
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  private addListener(
    ctx: ApiContext,
    rawEvent: unknown,
    rawFilter: unknown,
    rawSpec: unknown,
    rawId: unknown
  ): void {
    const grants = this.host.grants(ctx.extensionId)
    if (!grants.permissions.some((p) => PERMISSIONS.includes(p))) {
      throw new ApiError("The 'webRequest' permission is required.")
    }
    const event = eventNamed(rawEvent)
    let spec: RequestListenerSpec
    try {
      spec = normalizeRequestListener(event, rawFilter, rawSpec)
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : String(error))
    }
    if (spec.blocking && !this.mayBlock(ctx, event)) throw new ApiError(BLOCKING_PERMISSION_ERROR)
    if (!isInteger(rawId) || rawId <= 0) throw new ApiError('Invalid listener id.')
    const context = this.contextOf(ctx)
    const byContext =
      this.registrations.get(ctx.extensionId) ?? new Map<string, Map<number, Registration>>()
    const own = byContext.get(context.key) ?? new Map<number, Registration>()
    // A new document in the same frame numbers its listeners from one again: whatever the
    // previous document registered under this key is gone with it.
    for (const [id, previous] of own) {
      if (previous.context !== context || id === rawId) {
        previous.off?.()
        own.delete(id)
      }
    }
    const registration: Registration = {
      id: rawId,
      event,
      extensionId: ctx.extensionId,
      context,
      spec,
      filter: compileRequestFilter(spec.filter),
      off: null
    }
    own.set(rawId, registration)
    byContext.set(context.key, own)
    this.registrations.set(ctx.extensionId, byContext)
    this.hook(registration)
  }

  private removeListener(ctx: ApiContext, rawEvent: unknown, rawId: unknown): void {
    const event = eventNamed(rawEvent)
    if (!isInteger(rawId)) throw new ApiError('Invalid listener id.')
    const context = this.contextOf(ctx)
    const registration = this.registrations.get(ctx.extensionId)?.get(context.key)?.get(rawId)
    if (!registration || registration.context !== context || registration.event !== event) return
    this.drop(registration)
  }

  /**
   * Chrome's rule: blocking listeners for MV2 extensions with `webRequestBlocking`, and
   * `onAuthRequired` for any extension with `webRequestAuthProvider` (the MV3 way for password
   * managers to answer proxy and server challenges).
   */
  private mayBlock(ctx: ApiContext, event: WebRequestEventName): boolean {
    const permissions = this.host.grants(ctx.extensionId).permissions
    if (event === 'onAuthRequired' && permissions.includes('webRequestAuthProvider')) return true
    if (ctx.extension.manifest.manifest_version !== 2) return false
    return permissions.includes('webRequestBlocking')
  }

  private contextOf(ctx: ApiContext): Context {
    const context =
      ctx.sender.kind === 'frame'
        ? this.host.registry.frameFor(ctx.sender.frame)
        : this.host.registry.workerFor(ctx.sender.worker, ctx.sender.session)
    if (!context) throw new ApiError('The calling context is not registered.')
    return context
  }

  private hook(registration: Registration): void {
    if (!this.listenerHost || registration.off) return
    const event = registration.event
    // Electron has no `onAuthRequired` hook on the session (`app.on('login')` is not per request).
    if (event === 'onAuthRequired') return
    const options: ListenerOptions = {
      registrant: registration.extensionId,
      priority: this.priorityOf(registration.extensionId),
      blocking: registration.spec.blocking
    }
    registration.off = this.listenerHost.addListener(
      event,
      (details) => this.fire(registration, details),
      options
    )
  }

  private drop(registration: Registration): void {
    registration.off?.()
    registration.off = null
    const byContext = this.registrations.get(registration.extensionId)
    const own = byContext?.get(registration.context.key)
    if (!byContext || !own) return
    if (own.get(registration.id) === registration) own.delete(registration.id)
    if (own.size === 0) byContext.delete(registration.context.key)
    if (byContext.size === 0) this.registrations.delete(registration.extensionId)
  }

  /** Chromium ranks extensions by install time, newest first; the pipeline takes it as priority. */
  private priorityOf(extensionId: string): number {
    return (
      this.host.browser.extensions.list().find((info) => info.id === extensionId)?.installedAt ?? 0
    )
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private fire(
    registration: Registration,
    details: WebRequestDetails
  ): BlockingResponse | undefined | Promise<BlockingResponse | undefined> {
    const { extensionId, event, context } = registration
    if (!this.host.registry.isLive(context)) {
      this.drop(registration)
      return undefined
    }
    if (!this.host.loaded(extensionId)) return undefined
    const request = { url: details.url, type: details.resourceType, initiator: details.initiator }
    if (!canAccessRequest((url) => this.host.hostAccess(extensionId, url), request, extensionId)) {
      return undefined
    }
    const place = this.placeOf(details.tabId)
    const probe = { url: details.url, type: details.resourceType, ...place }
    if (!requestFilterMatches(registration.filter, probe)) return undefined
    const chrome = chromeRequestDetails(
      event,
      details,
      place.tabId,
      registration.spec.extraInfoSpec
    )
    const delivery: EventDelivery = { unfiltered: false, matched: [registration.id] }
    if (!registration.spec.blocking) {
      this.host.registry.sendTo(context, 'webRequest', event, [chrome, null], delivery)
      return undefined
    }
    const token = ++this.tokens
    const answer = new Promise<BlockingResponse | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(token)
        this.timedOut(extensionId, event)
        resolve(undefined)
      }, this.timeoutMs)
      this.pending.set(token, { extensionId, event, resolve, timer })
    })
    this.host.registry.sendTo(context, 'webRequest', event, [chrome, token], delivery)
    return answer
  }

  /** Chrome's tab and window ids of the request's tab, `-1` for requests outside a tab. */
  private placeOf(zenTabId: string | null): { tabId: number; windowId: number } {
    const tab = zenTabId === null ? undefined : this.host.model.tab(zenTabId)
    if (!tab) return { tabId: TAB_ID_NONE, windowId: WINDOW_ID_NONE }
    const win = this.host.model.windowOfTab(tab)
    return {
      tabId: this.host.model.chromeTabId(tab),
      windowId: win ? this.host.model.windowIdOf(win) : WINDOW_ID_NONE
    }
  }

  private timedOut(extensionId: string, event: WebRequestEventName): void {
    if (this.warned.has(extensionId)) return
    this.warned.add(extensionId)
    console.warn(
      `[zen] webRequest ${extensionId}: a blocking ${event} listener did not answer within ${this.timeoutMs} ms; requests go on unchanged when that happens`
    )
  }
}

function eventNamed(raw: unknown): WebRequestEventName {
  if (typeof raw === 'string' && (WEB_REQUEST_EVENT_NAMES as readonly string[]).includes(raw)) {
    return raw as WebRequestEventName
  }
  throw new ApiError('Unknown webRequest event.')
}
