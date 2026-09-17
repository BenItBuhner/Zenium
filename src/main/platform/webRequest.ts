/**
 * The single set of `webRequest` listeners per session, and the listener host on top of them.
 *
 * Electron lets a session have exactly one listener per `webRequest` event, and any listener the
 * host installs switches off extension `webRequest` / `declarativeNetRequest` handling for that
 * partition. So this module owns the one listener per event of every session (default,
 * containers, private) and fans each request out in two stages:
 *
 * 1. {@link RequestHandler}s, the browser's own participants in a fixed order: ad and tracker
 *    blocking registers here (`blocking.ts`); later features (Safe Browsing, HTTPS-only, GPC / DNT
 *    headers, cookie rules) register more handlers instead of adding listeners. The first
 *    definitive answer (cancel or redirect) of `onBeforeRequest` ends the request there.
 * 2. {@link WebRequestListener}s registered through {@link WebRequestMultiplexer.addListener}:
 *    the `chrome.webRequest` emulation of the extension platform registers one per extension
 *    listener. They see {@link WebRequestDetails} shaped like Chromium's, run in a stable
 *    per-registrant order (priority, registrant id, registration order) and their results are
 *    composed the way Chromium composes extension results ({@link composeBeforeRequest},
 *    {@link mergeRequestHeaders}, {@link mergeResponseHeaders}). Handlers decide first: a request
 *    a handler cancelled or redirected is not offered to the listeners of that event (Chromium
 *    evaluates declarativeNetRequest before dispatching `webRequest`), and header edits made by
 *    handlers count as the highest-precedence registrant when listener edits conflict with them.
 */
import type { Session } from 'electron'
import { resourceTypeFromElectron } from '../../core/blocking/engine'
import type { HeaderOp, RequestContext, ResourceType } from '../../core/blocking/rules'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'

export type BeforeRequestDetails = Electron.OnBeforeRequestListenerDetails
export type BeforeSendHeadersDetails = Electron.OnBeforeSendHeadersListenerDetails
export type HeadersReceivedDetails = Electron.OnHeadersReceivedListenerDetails
type SendHeadersDetails = Electron.OnSendHeadersListenerDetails
type ResponseStartedDetails = Electron.OnResponseStartedListenerDetails
type BeforeRedirectDetails = Electron.OnBeforeRedirectListenerDetails
type CompletedDetails = Electron.OnCompletedListenerDetails
type ErrorOccurredDetails = Electron.OnErrorOccurredListenerDetails
type AnyDetails =
  | BeforeRequestDetails
  | BeforeSendHeadersDetails
  | SendHeadersDetails
  | HeadersReceivedDetails
  | ResponseStartedDetails
  | BeforeRedirectDetails
  | CompletedDetails
  | ErrorOccurredDetails

// ---------------------------------------------------------------------------
// Handlers (the browser's own participants)
// ---------------------------------------------------------------------------

/** One request as the handlers see it: the core's context plus the host's bookkeeping. */
export interface HostRequest {
  ctx: RequestContext
  containerId: string
  tabId: string | undefined
  /** The request as listeners see it, minus the per-event fields. */
  base: WebRequestBase
  /** Scratch space a handler keeps between the phases of one request. */
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

/** Resolves the tab a request's `webContents` belongs to (the view host knows). */
export interface TabResolver {
  tabIdForWebContents(wc: Electron.WebContents): string | undefined
}

// ---------------------------------------------------------------------------
// Listeners (the chrome.webRequest emulation's participants)
// ---------------------------------------------------------------------------

/** The `chrome.webRequest` events, in request order. */
export type WebRequestEvent =
  | 'onBeforeRequest'
  | 'onBeforeSendHeaders'
  | 'onSendHeaders'
  | 'onHeadersReceived'
  | 'onResponseStarted'
  | 'onBeforeRedirect'
  | 'onCompleted'
  | 'onErrorOccurred'

export const WEB_REQUEST_EVENTS: readonly WebRequestEvent[] = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
]

/** Events whose listeners may be blocking (return a {@link BlockingResponse} the request waits for). */
export const BLOCKING_EVENTS: ReadonlySet<WebRequestEvent> = new Set<WebRequestEvent>([
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onHeadersReceived'
])

/** The fields every event carries (Chromium's `WebRequestDetails`, with Zenium's tab ids). */
export interface WebRequestBase {
  /** Chromium's request id, stable across the phases and the redirects of one request. */
  requestId: string
  url: string
  method: string
  resourceType: ResourceType
  /** 0 for the main frame, the frame's id for a subframe, -1 when the request has no frame. */
  frameId: number
  /** The wrapping frame's id, -1 when there is none. */
  parentFrameId: number
  /** The Zenium tab id, null for requests outside a tab (the emulation maps it to a number). */
  tabId: string | null
  /** The session partition (`default`, a container id or the private partition). */
  partition: string
  /** The origin that started the request, null when unknown or opaque. */
  initiator: string | null
  /** The document the request belongs to, null for a main-frame navigation. */
  documentUrl: string | null
  /** Milliseconds since the epoch. */
  timestamp: number
}

/** What a listener sees; the optional fields follow the event, as in `chrome.webRequest`. */
export interface WebRequestDetails extends WebRequestBase {
  event: WebRequestEvent
  /** `onBeforeSendHeaders`, `onSendHeaders`. */
  requestHeaders?: Record<string, string>
  /** `onHeadersReceived`, `onResponseStarted`, `onBeforeRedirect`, `onCompleted`. */
  responseHeaders?: Record<string, string[]>
  statusLine?: string
  statusCode?: number
  fromCache?: boolean
  ip?: string
  /** `onBeforeRedirect`. */
  redirectUrl?: string
  /** `onErrorOccurred`. */
  error?: string
}

/** What a blocking listener may answer (Chromium's `BlockingResponse`). */
export interface BlockingResponse {
  cancel?: boolean
  /** `onBeforeRequest` and `onHeadersReceived` (the latter becomes a 302). */
  redirectUrl?: string
  /** `onBeforeSendHeaders`: the complete request headers the listener wants sent. */
  requestHeaders?: Record<string, string>
  /** `onHeadersReceived`: the complete response headers the listener wants delivered. */
  responseHeaders?: Record<string, string | string[]>
}

export type WebRequestListener = (
  details: WebRequestDetails
) => BlockingResponse | undefined | void | Promise<BlockingResponse | undefined | void>

export interface ListenerFilter {
  types?: readonly ResourceType[]
  tabId?: string
  partition?: string
  /** Chromium match patterns are the caller's business; this is the compiled predicate. */
  url?: (url: string) => boolean
}

export interface ListenerOptions {
  /**
   * Who registers, an extension id. Results compose per registrant; a registrant's listeners
   * keep their registration order.
   */
  registrant: string
  /**
   * Precedence between registrants: higher runs first and wins conflicts (Chromium uses the
   * extension's installation time: newer wins). Equal priorities order by registrant id.
   */
  priority?: number
  /** The request waits for the result; only {@link BLOCKING_EVENTS} accept it. */
  blocking?: boolean
  filter?: ListenerFilter
}

interface Registration {
  seq: number
  event: WebRequestEvent
  registrant: string
  priority: number
  blocking: boolean
  filter: ListenerFilter | undefined
  listener: WebRequestListener
}

/** A blocking listener's answer with who gave it, in precedence order. */
export interface Answer {
  registrant: string
  response: BlockingResponse
}

/** Requests whose context outlived their completion events are dropped past this many. */
const MAX_TRACKED_REQUESTS = 4096

/** What Chromium reports for a request a rule or an extension cancelled. */
export const BLOCKED_BY_CLIENT = 'net::ERR_BLOCKED_BY_CLIENT'

/** Fans the session's `webRequest` events out to the ordered handlers, then the listeners. */
export class WebRequestMultiplexer {
  private readonly handlers: RequestHandler[] = []
  private readonly sessions = new Map<Session, string>()
  private readonly requests = new Map<number, HostRequest>()
  private readonly listeners = new Map<WebRequestEvent, Registration[]>()
  private readonly observed = new Set<WebRequestEvent>()
  private seq = 0
  /** Registrants whose answers were dropped in a conflict, for diagnostics and tests. */
  readonly conflicts: Array<{ event: WebRequestEvent; registrant: string; url: string }> = []

  constructor(private readonly views: TabResolver) {}

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

  /**
   * Register a `chrome.webRequest`-style listener; returns the function that removes it.
   * Throws for a blocking listener on an event that has no blocking variant.
   */
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void {
    if (!WEB_REQUEST_EVENTS.includes(event)) throw new Error(`Unknown webRequest event ${event}`)
    const blocking = options.blocking === true
    if (blocking && !BLOCKING_EVENTS.has(event)) throw new Error(`${event} has no blocking variant`)
    const registration: Registration = {
      seq: this.seq++,
      event,
      registrant: options.registrant,
      priority: options.priority ?? 0,
      blocking,
      filter: options.filter,
      listener
    }
    const list = this.listeners.get(event) ?? []
    list.push(registration)
    list.sort(compareRegistrations)
    this.listeners.set(event, list)
    this.observe(event)
    return () => {
      const current = this.listeners.get(event)
      if (!current) return
      const index = current.indexOf(registration)
      if (index !== -1) current.splice(index, 1)
    }
  }

  /** Remove every listener of a registrant (an extension was unloaded). */
  removeListenersOf(registrant: string): void {
    for (const [event, list] of this.listeners)
      this.listeners.set(
        event,
        list.filter((r) => r.registrant !== registrant)
      )
  }

  /** `[registrant, blocking]` of the listeners of an event, in the order they run. */
  listenerOrder(event: WebRequestEvent): Array<[string, boolean]> {
    return (this.listeners.get(event) ?? []).map((r) => [r.registrant, r.blocking])
  }

  /** Requests currently between their first and last phase (for tests and diagnostics). */
  get inFlight(): number {
    return this.requests.size
  }

  /** Install the listeners on the session of `containerId` (once per session). */
  attach(ses: Session, containerId: string): void {
    if (this.sessions.has(ses)) return
    this.sessions.set(ses, containerId)
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
        this.cancelled(request, details.id)
        callback({ cancel: true })
        return
      }
      if (result) {
        callback({ redirectURL: result.redirectURL })
        return
      }
      this.dispatch('onBeforeRequest', request, {}, (answers) => {
        const composed = composeBeforeRequest(details.url, answers, (registrant) =>
          this.conflict('onBeforeRequest', registrant, details.url)
        )
        if (composed.cancel) {
          this.cancelled(request, details.id)
          callback({ cancel: true })
        } else if (composed.redirectUrl) callback({ redirectURL: composed.redirectUrl })
        else callback({})
      })
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
        this.cancelled(request, details.id)
        callback({ cancel: true })
        return
      }
      this.dispatch('onBeforeSendHeaders', request, { requestHeaders: headers }, (answers) => {
        if (answers.some((a) => a.response.cancel)) {
          this.cancelled(request, details.id)
          callback({ cancel: true })
          return
        }
        const merged = mergeRequestHeaders(
          headers,
          requestHeaderAnswers(answers),
          (registrant) => this.conflict('onBeforeSendHeaders', registrant, details.url),
          { ...details.requestHeaders }
        )
        callback({ requestHeaders: merged })
      })
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
        this.cancelled(request, details.id)
        callback({ cancel: true })
        return
      }
      const extra: Partial<WebRequestDetails> = {
        responseHeaders: headers,
        statusLine: details.statusLine,
        statusCode: details.statusCode
      }
      this.dispatch('onHeadersReceived', request, extra, (answers) => {
        if (answers.some((a) => a.response.cancel)) {
          this.cancelled(request, details.id)
          callback({ cancel: true })
          return
        }
        const conflict = (registrant: string): void =>
          this.conflict('onHeadersReceived', registrant, details.url)
        const merged = mergeResponseHeaders(
          headers,
          responseHeaderAnswers(answers),
          conflict,
          normalizeResponseHeaders(details.responseHeaders)
        )
        const redirect = mergeRedirect(details.url, answers, conflict)
        if (redirect) {
          // Chromium turns a headers-received redirect into a synthetic 302.
          statusLine = 'HTTP/1.1 302 Found'
          applyResponseHeaderOps(merged, [
            { header: 'Location', operation: 'set', value: redirect }
          ])
        }
        callback(statusLine ? { responseHeaders: merged, statusLine } : { responseHeaders: merged })
      })
    })
    ses.webRequest.onCompleted((details) => {
      const request = this.requests.get(details.id)
      if (request && this.listeners.get('onCompleted')?.length)
        this.dispatch(
          'onCompleted',
          request,
          {
            responseHeaders: normalizeResponseHeaders(details.responseHeaders),
            statusLine: details.statusLine,
            statusCode: details.statusCode,
            fromCache: details.fromCache
          },
          noop
        )
      this.requests.delete(details.id)
    })
    ses.webRequest.onErrorOccurred((details) => {
      const request = this.requests.get(details.id)
      if (request && this.listeners.get('onErrorOccurred')?.length)
        this.dispatch(
          'onErrorOccurred',
          request,
          { error: details.error, fromCache: details.fromCache },
          noop
        )
      this.requests.delete(details.id)
    })
    for (const event of this.observed) this.installObserver(ses, event, containerId)
  }

  /** The observe-only events cost a message per request, so they are installed on first use. */
  private observe(event: WebRequestEvent): void {
    if (event !== 'onSendHeaders' && event !== 'onResponseStarted' && event !== 'onBeforeRedirect')
      return
    if (this.observed.has(event)) return
    this.observed.add(event)
    for (const [ses, containerId] of this.sessions) this.installObserver(ses, event, containerId)
  }

  private installObserver(ses: Session, event: WebRequestEvent, containerId: string): void {
    const record = (details: AnyDetails): HostRequest =>
      this.requests.get(details.id) ?? this.begin(details, containerId)
    switch (event) {
      case 'onSendHeaders':
        ses.webRequest.onSendHeaders((details) =>
          this.dispatch(
            'onSendHeaders',
            record(details),
            { requestHeaders: { ...details.requestHeaders } },
            noop
          )
        )
        break
      case 'onResponseStarted':
        ses.webRequest.onResponseStarted((details) =>
          this.dispatch(
            'onResponseStarted',
            record(details),
            {
              responseHeaders: normalizeResponseHeaders(details.responseHeaders),
              statusLine: details.statusLine,
              statusCode: details.statusCode,
              fromCache: details.fromCache
            },
            noop
          )
        )
        break
      case 'onBeforeRedirect':
        ses.webRequest.onBeforeRedirect((details) =>
          this.dispatch(
            'onBeforeRedirect',
            record(details),
            {
              responseHeaders: normalizeResponseHeaders(details.responseHeaders),
              statusLine: details.statusLine,
              statusCode: details.statusCode,
              fromCache: details.fromCache,
              ip: details.ip,
              redirectUrl: details.redirectURL
            },
            noop
          )
        )
        break
      default:
        break
    }
  }

  /**
   * Call the listeners of `event` that match the request, in order, and hand the blocking ones'
   * answers (in the same order) to `done`. Synchronous unless a blocking listener returned a
   * promise; listeners run concurrently and the composition waits for all of them.
   */
  private dispatch(
    event: WebRequestEvent,
    request: HostRequest,
    extra: Partial<WebRequestDetails>,
    done: (answers: Answer[]) => void
  ): void {
    const registrations = this.listeners.get(event)
    if (!registrations || registrations.length === 0) {
      done([])
      return
    }
    const pending: Array<Promise<void>> = []
    const answers: Array<Answer | null> = []
    for (const registration of registrations) {
      if (!matchesFilter(registration.filter, request)) continue
      const details = detailsFor(event, request, extra)
      let out: ReturnType<WebRequestListener>
      try {
        out = registration.listener(details)
      } catch (error) {
        console.error(`[zenium] webRequest listener of ${registration.registrant} failed`, error)
        continue
      }
      if (!registration.blocking) {
        if (isPromise(out)) out.catch(() => undefined)
        continue
      }
      const slot = answers.length
      answers.push(null)
      if (isPromise(out)) {
        pending.push(
          out.then(
            (response) => {
              if (response) answers[slot] = { registrant: registration.registrant, response }
            },
            (error) => {
              console.error(
                `[zenium] webRequest listener of ${registration.registrant} failed`,
                error
              )
            }
          )
        )
      } else if (out) answers[slot] = { registrant: registration.registrant, response: out }
    }
    const finish = (): void => done(answers.filter((a): a is Answer => a !== null))
    if (pending.length === 0) finish()
    else void Promise.all(pending).then(finish)
  }

  /**
   * A handler or listener cancelled the request: Chromium reports it to `onErrorOccurred` as
   * `net::ERR_BLOCKED_BY_CLIENT`, so the listeners hear that here and now (the Kotlin registry
   * does the same) and the record is dropped before Electron's own error event, which then
   * finds nothing to report twice.
   */
  private cancelled(request: HostRequest, id: number): void {
    if (this.listeners.get('onErrorOccurred')?.length)
      this.dispatch(
        'onErrorOccurred',
        request,
        { error: BLOCKED_BY_CLIENT, fromCache: false },
        noop
      )
    this.requests.delete(id)
  }

  private conflict(event: WebRequestEvent, registrant: string, url: string): void {
    if (this.conflicts.length >= 256) this.conflicts.shift()
    this.conflicts.push({ event, registrant, url })
  }

  /** Build the shared request record for `details` (the first phase that sees a request). */
  private begin(details: AnyDetails, containerId: string): HostRequest {
    const wc = details.webContents
    const tabId = wc && !wc.isDestroyed() ? this.views.tabIdForWebContents(wc) : undefined
    const ctx = contextFor(details, containerId, tabId)
    const frames = frameIdsOf(details, ctx.type)
    const request: HostRequest = {
      ctx,
      containerId,
      tabId,
      base: {
        requestId: String(details.id),
        url: details.url,
        method: details.method,
        resourceType: ctx.type,
        frameId: frames.frameId,
        parentFrameId: frames.parentFrameId,
        tabId: tabId ?? null,
        partition: containerId,
        initiator: originOf(ctx.initiator),
        documentUrl: ctx.documentUrl ?? null,
        timestamp: details.timestamp
      },
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

const noop = (): void => undefined

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function compareRegistrations(a: Registration, b: Registration): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.registrant !== b.registrant) return a.registrant < b.registrant ? -1 : 1
  return a.seq - b.seq
}

function matchesFilter(filter: ListenerFilter | undefined, request: HostRequest): boolean {
  if (!filter) return true
  if (filter.types && !filter.types.includes(request.ctx.type)) return false
  if (filter.tabId !== undefined && filter.tabId !== request.tabId) return false
  if (filter.partition !== undefined && filter.partition !== request.containerId) return false
  if (filter.url && !filter.url(request.ctx.url)) return false
  return true
}

/** Each listener gets its own copy of the headers (it may return them edited). */
function detailsFor(
  event: WebRequestEvent,
  request: HostRequest,
  extra: Partial<WebRequestDetails>
): WebRequestDetails {
  const details: WebRequestDetails = { ...request.base, event }
  if (extra.requestHeaders) details.requestHeaders = { ...extra.requestHeaders }
  if (extra.responseHeaders) {
    const copy: Record<string, string[]> = {}
    for (const [name, values] of Object.entries(extra.responseHeaders)) copy[name] = [...values]
    details.responseHeaders = copy
  }
  if (extra.statusLine !== undefined) details.statusLine = extra.statusLine
  if (extra.statusCode !== undefined) details.statusCode = extra.statusCode
  if (extra.fromCache !== undefined) details.fromCache = extra.fromCache
  if (extra.ip !== undefined) details.ip = extra.ip
  if (extra.redirectUrl !== undefined) details.redirectUrl = extra.redirectUrl
  if (extra.error !== undefined) details.error = extra.error
  return details
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** Chromium frame ids from Electron's `WebFrameMain`: 0 is the main frame, -1 is "no frame". */
function frameIdsOf(
  details: AnyDetails,
  type: ResourceType
): { frameId: number; parentFrameId: number } {
  try {
    const frame = details.frame
    if (!frame) return { frameId: type === 'main_frame' ? 0 : -1, parentFrameId: -1 }
    const parent = frame.parent
    if (!parent) return { frameId: 0, parentFrameId: -1 }
    return {
      frameId: frame.frameTreeNodeId,
      parentFrameId: parent.parent ? parent.frameTreeNodeId : 0
    }
  } catch {
    return { frameId: type === 'main_frame' ? 0 : -1, parentFrameId: -1 }
  }
}

// ---------------------------------------------------------------------------
// Composition (Chromium's web_request_api_helpers merge rules)
// ---------------------------------------------------------------------------

/** A redirect to `data:` or `about:blank` is a way of cancelling and beats every other redirect. */
function isCancelRedirect(url: string): boolean {
  return /^data:/i.test(url) || url === 'about:blank'
}

/**
 * The redirect the answers agree on: cancel-style redirects first, otherwise the first answer in
 * precedence order; later, different targets are conflicts. Null when nobody redirects (or every
 * redirect points at the request's own URL).
 */
export function mergeRedirect(
  url: string,
  answers: readonly Answer[],
  conflict: (registrant: string) => void = noop
): string | null {
  let chosen: string | null = null
  for (const onlyCancelStyle of [true, false]) {
    for (const { registrant, response } of answers) {
      const target = response.redirectUrl
      if (!target || target === url) continue
      if (onlyCancelStyle && !isCancelRedirect(target)) continue
      if (chosen === null || chosen === target) chosen = target
      else conflict(registrant)
    }
    if (chosen !== null) return chosen
  }
  return null
}

/** `onBeforeRequest`: any cancel cancels; otherwise the merged redirect. */
export function composeBeforeRequest(
  url: string,
  answers: readonly Answer[],
  conflict: (registrant: string) => void = noop
): { cancel: boolean; redirectUrl: string | null } {
  if (answers.some((a) => a.response.cancel)) return { cancel: true, redirectUrl: null }
  return { cancel: false, redirectUrl: mergeRedirect(url, answers, conflict) }
}

/** A registrant's complete request headers (what its listener returned). */
export interface RequestHeadersAnswer {
  registrant: string
  headers: Record<string, string>
}

export interface ResponseHeadersAnswer {
  registrant: string
  headers: Record<string, string[]>
}

function requestHeaderAnswers(answers: readonly Answer[]): RequestHeadersAnswer[] {
  const out: RequestHeadersAnswer[] = []
  for (const { registrant, response } of answers)
    if (response.requestHeaders) out.push({ registrant, headers: response.requestHeaders })
  return out
}

function responseHeaderAnswers(answers: readonly Answer[]): ResponseHeadersAnswer[] {
  const out: ResponseHeadersAnswer[] = []
  for (const { registrant, response } of answers)
    if (response.responseHeaders)
      out.push({ registrant, headers: normalizeResponseHeaders(response.responseHeaders) })
  return out
}

/**
 * Merge request-header answers into `base` the way Chromium merges `onBeforeSendHeaders`
 * results: each answer is a delta against `base` (headers it removed, headers it set); deltas
 * apply in precedence order, and a delta that sets a header an earlier one removed, sets a
 * header an earlier one set to a different value, or removes a header an earlier one set is
 * dropped whole (`conflict` is told who). Header names compare case-insensitively. When
 * `original` is given, `base` is the handlers' edit of it and those edits take precedence over
 * every answer.
 */
export function mergeRequestHeaders(
  base: Record<string, string>,
  answers: readonly RequestHeadersAnswer[],
  conflict: (registrant: string) => void = noop,
  original?: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = { ...base }
  const removed = new Set<string>()
  const set = new Set<string>()
  if (original) {
    const host = requestHeaderDelta(original, base)
    for (const name of host.removed) removed.add(name.toLowerCase())
    for (const [name] of host.set) set.add(name.toLowerCase())
  }
  for (const { registrant, headers } of answers) {
    const delta = requestHeaderDelta(base, headers)
    if (delta.removed.length === 0 && delta.set.length === 0) continue
    let conflicts = false
    for (const [name, value] of delta.set) {
      const lower = name.toLowerCase()
      if (removed.has(lower)) conflicts = true
      if (set.has(lower)) {
        const current = findHeader(merged, name)
        if (current === undefined || merged[current] !== value) conflicts = true
      }
    }
    for (const name of delta.removed) if (set.has(name.toLowerCase())) conflicts = true
    if (conflicts) {
      conflict(registrant)
      continue
    }
    for (const [name, value] of delta.set) {
      const existing = findHeader(merged, name)
      if (existing !== undefined && existing !== name) delete merged[existing]
      merged[name] = value
      set.add(name.toLowerCase())
    }
    for (const name of delta.removed) {
      const existing = findHeader(merged, name)
      if (existing !== undefined) delete merged[existing]
      removed.add(name.toLowerCase())
    }
  }
  return merged
}

function requestHeaderDelta(
  base: Record<string, string>,
  headers: Record<string, string>
): { removed: string[]; set: Array<[string, string]> } {
  const removed: string[] = []
  const set: Array<[string, string]> = []
  for (const name of Object.keys(base))
    if (findHeader(headers, name) === undefined) removed.push(name)
  for (const [name, value] of Object.entries(headers)) {
    const existing = findHeader(base, name)
    if (existing === undefined || base[existing] !== value) set.push([name, value])
  }
  return { removed, set }
}

/**
 * Merge response-header answers into `base` the way Chromium merges `onHeadersReceived`
 * results: headers are a multiset of `name: value` lines, each answer is the lines it deleted
 * and the lines it added, and a delta that adds a line an earlier one deleted or deletes a line
 * an earlier one added is dropped whole. Names compare case-insensitively, values exactly.
 * `original` works as in {@link mergeRequestHeaders}.
 */
export function mergeResponseHeaders(
  base: Record<string, string[]>,
  answers: readonly ResponseHeadersAnswer[],
  conflict: (registrant: string) => void = noop,
  original?: Record<string, string[]>
): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(base)) merged[name] = [...values]
  const removed = new Set<string>()
  const added = new Set<string>()
  if (original) {
    const host = responseHeaderDelta(original, base)
    for (const [name, value] of host.deleted) removed.add(lineKey(name, value))
    for (const [name, value] of host.added) added.add(lineKey(name, value))
  }
  for (const { registrant, headers } of answers) {
    const delta = responseHeaderDelta(base, headers)
    if (delta.deleted.length === 0 && delta.added.length === 0) continue
    const conflicts =
      delta.deleted.some(([name, value]) => added.has(lineKey(name, value))) ||
      delta.added.some(([name, value]) => removed.has(lineKey(name, value)))
    if (conflicts) {
      conflict(registrant)
      continue
    }
    for (const [name, value] of delta.deleted) {
      const existing = findHeader(merged, name)
      if (existing === undefined) continue
      const index = merged[existing].indexOf(value)
      if (index !== -1) merged[existing].splice(index, 1)
      if (merged[existing].length === 0) delete merged[existing]
      removed.add(lineKey(name, value))
    }
    for (const [name, value] of delta.added) {
      const existing = findHeader(merged, name)
      if (existing !== undefined) merged[existing].push(value)
      else merged[name] = [value]
      added.add(lineKey(name, value))
    }
  }
  return merged
}

function lineKey(name: string, value: string): string {
  return `${name.toLowerCase()}\n${value}`
}

function responseHeaderDelta(
  base: Record<string, string[]>,
  headers: Record<string, string[]>
): { deleted: Array<[string, string]>; added: Array<[string, string]> } {
  const count = (map: Record<string, string[]>): Map<string, number> => {
    const out = new Map<string, number>()
    for (const [name, values] of Object.entries(map))
      for (const value of values) {
        const key = lineKey(name, value)
        out.set(key, (out.get(key) ?? 0) + 1)
      }
    return out
  }
  const before = count(base)
  const after = count(headers)
  const deleted: Array<[string, string]> = []
  const added: Array<[string, string]> = []
  for (const [name, values] of Object.entries(base))
    for (const value of values) {
      const key = lineKey(name, value)
      const remaining = after.get(key) ?? 0
      if (remaining > 0) after.set(key, remaining - 1)
      else deleted.push([name, value])
    }
  for (const [name, values] of Object.entries(headers))
    for (const value of values) {
      const key = lineKey(name, value)
      const remaining = before.get(key) ?? 0
      if (remaining > 0) before.set(key, remaining - 1)
      else added.push([name, value])
    }
  return { deleted, added }
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** The core's request context for an Electron `webRequest` details object. */
export function contextFor(
  details: AnyDetails,
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

export function normalizeResponseHeaders(
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
