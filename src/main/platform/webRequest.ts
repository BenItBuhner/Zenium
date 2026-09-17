/**
 * The single set of `webRequest` listeners per session.
 *
 * Electron lets a session have exactly one listener per `webRequest` event, and any listener the
 * host installs switches off extension `webRequest` / `declarativeNetRequest` handling for that
 * partition. So this module owns the one `onBeforeRequest`, `onBeforeSendHeaders` and
 * `onHeadersReceived` listener of every session (default, containers, private) and multiplexes
 * them over an ordered list of {@link RequestHandler}s: ad and tracker blocking registers here
 * (`blocking.ts`), and later features (Safe Browsing, HTTPS-only, GPC / DNT headers, cookie
 * rules) register more handlers instead of adding listeners.
 */
import type { Session } from 'electron'
import { resourceTypeFromElectron } from '../../core/blocking/engine'
import type { HeaderOp, RequestContext } from '../../core/blocking/rules'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'

export type BeforeRequestDetails = Electron.OnBeforeRequestListenerDetails
export type BeforeSendHeadersDetails = Electron.OnBeforeSendHeadersListenerDetails
export type HeadersReceivedDetails = Electron.OnHeadersReceivedListenerDetails
type AnyDetails = BeforeRequestDetails | BeforeSendHeadersDetails | HeadersReceivedDetails

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

/** Resolves the tab a request's `webContents` belongs to (the view host knows). */
export interface TabResolver {
  tabIdForWebContents(wc: Electron.WebContents): string | undefined
}

/** Requests whose context outlived their completion events are dropped past this many. */
const MAX_TRACKED_REQUESTS = 4096

/** Fans the session's `webRequest` events out to the ordered handlers. */
export class WebRequestMultiplexer {
  private readonly handlers: RequestHandler[] = []
  private readonly attached = new WeakSet<Session>()
  private readonly requests = new Map<number, HostRequest>()

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

  /** Requests currently between their first and last phase (for tests and diagnostics). */
  get inFlight(): number {
    return this.requests.size
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
        callback(
          statusLine ? { responseHeaders: headers, statusLine } : { responseHeaders: headers }
        )
      }
    })
    ses.webRequest.onCompleted((details) => this.requests.delete(details.id))
    ses.webRequest.onErrorOccurred((details) => this.requests.delete(details.id))
  }

  /** Build the shared request record for `details` (the first phase that sees a request). */
  private begin(details: AnyDetails, containerId: string): HostRequest {
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
