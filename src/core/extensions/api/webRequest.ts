/**
 * `chrome.webRequest` without the engine: what a listener registration means (Chrome's
 * `RequestFilter` and `extraInfoSpec`), whether a request matches it, the details object an
 * event carries, and what a blocking listener may answer. The host feeds requests in from the
 * session's `webRequest` multiplexer and applies the answers; everything here is pure.
 */
import { RESOURCE_TYPES, type ResourceType } from '../../blocking/rules'
import { compileMatchPattern, type CompiledMatchPattern } from './matchPattern'

export type WebRequestEventName =
  | 'onBeforeRequest'
  | 'onBeforeSendHeaders'
  | 'onSendHeaders'
  | 'onHeadersReceived'
  | 'onAuthRequired'
  | 'onResponseStarted'
  | 'onBeforeRedirect'
  | 'onCompleted'
  | 'onErrorOccurred'

export const WEB_REQUEST_EVENT_NAMES: readonly WebRequestEventName[] = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onAuthRequired',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
]

export type ExtraInfoSpec =
  | 'blocking'
  | 'asyncBlocking'
  | 'requestHeaders'
  | 'responseHeaders'
  | 'extraHeaders'
  | 'requestBody'

/** Chrome's `extraInfoSpec` enum of each event (`On<Event>Options`). */
export const EXTRA_INFO_SPECS: Record<WebRequestEventName, readonly ExtraInfoSpec[]> = {
  onBeforeRequest: ['blocking', 'requestBody', 'extraHeaders'],
  onBeforeSendHeaders: ['requestHeaders', 'blocking', 'extraHeaders'],
  onSendHeaders: ['requestHeaders', 'extraHeaders'],
  onHeadersReceived: ['blocking', 'responseHeaders', 'extraHeaders'],
  onAuthRequired: ['responseHeaders', 'blocking', 'asyncBlocking', 'extraHeaders'],
  onResponseStarted: ['responseHeaders', 'extraHeaders'],
  onBeforeRedirect: ['responseHeaders', 'extraHeaders'],
  onCompleted: ['responseHeaders', 'extraHeaders'],
  onErrorOccurred: ['extraHeaders']
}

/** Events with a blocking variant (the request waits for the listener). */
export const BLOCKING_EVENT_NAMES: ReadonlySet<WebRequestEventName> = new Set<WebRequestEventName>([
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onHeadersReceived',
  'onAuthRequired'
])

export const MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20

export const BLOCKING_PERMISSION_ERROR =
  'You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.'

/**
 * How long the host waits for a blocking listener's answer before the request goes on
 * unchanged. Chrome has no such limit (its listeners run synchronously in the renderer, and a
 * slow one stalls the request); here the answer crosses a process boundary, so a background
 * page that hung must not hold every request of the browser.
 */
export const BLOCKING_ANSWER_TIMEOUT_MS = 2000

/**
 * Schemes `chrome.webRequest` reports: what a host permission can name. Requests to other
 * schemes (`chrome-extension:` resources, `data:`, `blob:`, `chrome:`) are never dispatched.
 */
const WEB_REQUEST_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'file:', 'ftp:'])

export function isWebRequestUrl(url: string): boolean {
  const colon = url.indexOf(':')
  return colon > 0 && WEB_REQUEST_SCHEMES.has(url.slice(0, colon + 1).toLowerCase())
}

/**
 * Chrome's access rule for dispatching an event to an extension: the extension needs host
 * access to the request URL, and, for anything but a navigation, to the request's initiator as
 * well (an unknown or opaque initiator passes). Another extension's page as the initiator is
 * never accessible; the extension's own pages always are.
 */
export function canAccessRequest(
  hasAccess: (url: string) => boolean,
  request: { url: string; type: ResourceType; initiator: string | null },
  extensionId: string
): boolean {
  if (!isWebRequestUrl(request.url) || !hasAccess(request.url)) return false
  if (request.type === 'main_frame' || request.type === 'sub_frame') return true
  const initiator = request.initiator
  if (!initiator || initiator === 'null') return true
  if (initiator.startsWith('chrome-extension://')) {
    return initiator === `chrome-extension://${extensionId}`
  }
  if (!isWebRequestUrl(initiator)) return true
  return hasAccess(initiator.endsWith('/') ? initiator : `${initiator}/`)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Chrome's `webRequest.RequestFilter`. */
export interface RequestFilter {
  urls: string[]
  types?: ResourceType[]
  tabId?: number
  windowId?: number
}

export interface RequestListenerSpec {
  filter: RequestFilter
  extraInfoSpec: ExtraInfoSpec[]
  /** `blocking` or `asyncBlocking` in the spec: the listener's return value answers the request. */
  blocking: boolean
}

function signatureOf(event: WebRequestEventName): string {
  return `webRequest.${event}.addListener(function callback, webRequest.RequestFilter filter, optional array extraInfoSpec)`
}

function paramError(event: WebRequestEventName, detail: string): TypeError {
  return new TypeError(`Error in invocation of ${signatureOf(event)}: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value)
}

/**
 * The binding's validation of `addListener(fn, filter, extraInfoSpec)`: `urls` is required, the
 * types and the spec come from their enums (the spec's from the event's own), the tab and window
 * ids are integers. Throws the binding's `TypeError`; an invalid match pattern is the
 * `'<pattern>' is not a valid URL pattern.` error Chrome throws.
 */
export function normalizeRequestListener(
  event: WebRequestEventName,
  rawFilter: unknown,
  rawSpec: unknown
): RequestListenerSpec {
  if (!isRecord(rawFilter)) throw paramError(event, 'No matching signature.')
  const urls = rawFilter.urls
  if (!Array.isArray(urls)) {
    throw paramError(
      event,
      "Error at parameter 'filter': Error at property 'urls': Invalid type: expected array."
    )
  }
  const filter: RequestFilter = { urls: [] }
  for (const url of urls) {
    if (typeof url !== 'string') {
      throw paramError(
        event,
        "Error at parameter 'filter': Error at property 'urls': Invalid type: expected string."
      )
    }
    if (!compileMatchPattern(url)) throw new Error(`'${url}' is not a valid URL pattern.`)
    filter.urls.push(url)
  }
  if (rawFilter.types !== undefined && rawFilter.types !== null) {
    if (!Array.isArray(rawFilter.types)) {
      throw paramError(
        event,
        "Error at parameter 'filter': Error at property 'types': Invalid type: expected array."
      )
    }
    const types: ResourceType[] = []
    for (const type of rawFilter.types) {
      if (!isResourceType(type)) {
        throw paramError(
          event,
          `Error at parameter 'filter': Error at property 'types': Value must be one of ${RESOURCE_TYPES.join(', ')}.`
        )
      }
      types.push(type)
    }
    filter.types = types
  }
  if (rawFilter.tabId !== undefined && rawFilter.tabId !== null) {
    if (!isInteger(rawFilter.tabId)) {
      throw paramError(
        event,
        "Error at parameter 'filter': Error at property 'tabId': Invalid type: expected integer."
      )
    }
    filter.tabId = rawFilter.tabId
  }
  if (rawFilter.windowId !== undefined && rawFilter.windowId !== null) {
    if (!isInteger(rawFilter.windowId)) {
      throw paramError(
        event,
        "Error at parameter 'filter': Error at property 'windowId': Invalid type: expected integer."
      )
    }
    filter.windowId = rawFilter.windowId
  }
  const extraInfoSpec: ExtraInfoSpec[] = []
  if (rawSpec !== undefined && rawSpec !== null) {
    if (!Array.isArray(rawSpec)) {
      throw paramError(event, "Error at parameter 'extraInfoSpec': Invalid type: expected array.")
    }
    const allowed = EXTRA_INFO_SPECS[event]
    rawSpec.forEach((item, index) => {
      if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
        throw paramError(
          event,
          `Error at parameter 'extraInfoSpec': Error at index ${index}: Value must be one of ${allowed.join(', ')}.`
        )
      }
      if (!extraInfoSpec.includes(item as ExtraInfoSpec)) extraInfoSpec.push(item as ExtraInfoSpec)
    })
  }
  const blocking = extraInfoSpec.includes('blocking') || extraInfoSpec.includes('asyncBlocking')
  return { filter, extraInfoSpec, blocking }
}

/** A registration's filter compiled for matching. */
export interface CompiledRequestFilter {
  /** Empty when every URL matches (Chrome treats an empty `urls` list as "all URLs"). */
  urls: CompiledMatchPattern[]
  types: ReadonlySet<ResourceType> | null
  tabId?: number
  windowId?: number
}

export function compileRequestFilter(filter: RequestFilter): CompiledRequestFilter {
  const urls: CompiledMatchPattern[] = []
  for (const pattern of filter.urls) {
    const compiled = compileMatchPattern(pattern)
    if (compiled) urls.push(compiled)
  }
  const out: CompiledRequestFilter = {
    urls,
    types: filter.types && filter.types.length > 0 ? new Set(filter.types) : null
  }
  if (filter.tabId !== undefined) out.tabId = filter.tabId
  if (filter.windowId !== undefined) out.windowId = filter.windowId
  return out
}

/** The request as seen by a filter: Chrome tab and window ids (`-1` outside a tab). */
export interface RequestProbe {
  url: string
  type: ResourceType
  tabId: number
  windowId: number
}

export function requestFilterMatches(filter: CompiledRequestFilter, probe: RequestProbe): boolean {
  if (filter.types && !filter.types.has(probe.type)) return false
  if (filter.tabId !== undefined && filter.tabId !== probe.tabId) return false
  if (filter.windowId !== undefined && filter.windowId !== probe.windowId) return false
  if (filter.urls.length === 0) return true
  return filter.urls.some((pattern) => pattern.test(probe.url))
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** Chrome's `webRequest.HttpHeaders` item. */
export interface HttpHeader {
  name: string
  value?: string
  binaryValue?: number[]
}

/** Chrome's list shape of a header map (a multi-valued response header becomes several items). */
export function toHttpHeaders(headers: Record<string, string | string[]>): HttpHeader[] {
  const out: HttpHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) out.push({ name, value: v })
    else out.push({ name, value })
  }
  return out
}

function headerValue(item: Record<string, unknown>): string | null {
  if (typeof item.value === 'string') return item.value
  if (Array.isArray(item.binaryValue)) {
    if (!item.binaryValue.every((b) => isInteger(b) && b >= 0 && b <= 255)) return null
    return String.fromCharCode(...(item.binaryValue as number[]))
  }
  return null
}

/** Request headers from a listener's `HttpHeaders`: single valued, last one wins; null if malformed. */
export function requestHeadersFrom(list: unknown): Record<string, string> | null {
  if (!Array.isArray(list)) return null
  const out: Record<string, string> = {}
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== 'string') return null
    const name = item.name
    const value = headerValue(item)
    if (value === null) return null
    const existing = Object.keys(out).find((k) => k.toLowerCase() === name.toLowerCase())
    if (existing !== undefined) delete out[existing]
    out[name] = value
  }
  return out
}

/** Response headers from a listener's `HttpHeaders`: a multiset of lines; null if malformed. */
export function responseHeadersFrom(list: unknown): Record<string, string[]> | null {
  if (!Array.isArray(list)) return null
  const out: Record<string, string[]> = {}
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== 'string') return null
    const name = item.name
    const value = headerValue(item)
    if (value === null) return null
    const existing = Object.keys(out).find((k) => k.toLowerCase() === name.toLowerCase())
    if (existing !== undefined) out[existing].push(value)
    else out[name] = [value]
  }
  return out
}

/** Chrome's `requestBody` of `onBeforeRequest` with `requestBody` in the spec. */
export interface RequestBody {
  error?: string
  formData?: Record<string, string[]>
  raw?: Array<{ bytes?: ArrayBuffer; file?: string }>
}

/** One upload chunk as the engine reports it. */
export interface UploadChunk {
  bytes?: Uint8Array
  file?: string
  blobUUID?: string
}

/**
 * Chrome parses a form-encoded body into `formData` and hands anything else over as `raw`
 * chunks. The content type is not known at this phase, so a body that reads as
 * `application/x-www-form-urlencoded` is taken for one.
 */
export function requestBodyFrom(
  uploadData: readonly UploadChunk[] | undefined
): RequestBody | null {
  if (!uploadData || uploadData.length === 0) return null
  if (uploadData.length === 1 && uploadData[0].bytes && !uploadData[0].file) {
    const formData = parseUrlEncoded(uploadData[0].bytes)
    if (formData) return { formData }
  }
  const raw: RequestBody['raw'] = []
  for (const chunk of uploadData) {
    if (chunk.file) raw.push({ file: chunk.file })
    else if (chunk.bytes) {
      const copy = new Uint8Array(chunk.bytes.byteLength)
      copy.set(chunk.bytes)
      raw.push({ bytes: copy.buffer })
    } else if (chunk.blobUUID) raw.push({ file: `blob:${chunk.blobUUID}` })
  }
  return raw.length > 0 ? { raw } : { error: 'Unknown body type' }
}

function parseUrlEncoded(bytes: Uint8Array): Record<string, string[]> | null {
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) return null
  for (const byte of bytes) {
    // Printable ASCII only, no spaces (form encoding spells them `+` or `%20`).
    if (byte <= 0x20 || byte >= 0x7f) return null
  }
  const text = String.fromCharCode(...bytes)
  if (!/^[^=&]+=[^&]*(&[^=&]+=[^&]*)*&?$/.test(text)) return null
  const out: Record<string, string[]> = {}
  try {
    for (const [name, value] of new URLSearchParams(text)) (out[name] ??= []).push(value)
  } catch {
    return null
  }
  return out
}

/** The request as the multiplexer describes it (the fields this module reads). */
export interface HostRequestDetails {
  requestId: string
  url: string
  method: string
  resourceType: ResourceType
  frameId: number
  parentFrameId: number
  initiator: string | null
  documentUrl: string | null
  timestamp: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  statusLine?: string
  statusCode?: number
  fromCache?: boolean
  ip?: string
  redirectUrl?: string
  error?: string
  uploadData?: readonly UploadChunk[]
}

/** Chrome's `webRequest.WebRequestDetails` with the per-event fields. */
export interface ChromeRequestDetails {
  requestId: string
  url: string
  method: string
  frameId: number
  parentFrameId: number
  tabId: number
  type: ResourceType
  timeStamp: number
  initiator?: string
  documentLifecycle: 'active'
  frameType: 'outermost_frame' | 'sub_frame'
  requestHeaders?: HttpHeader[]
  responseHeaders?: HttpHeader[]
  statusLine?: string
  statusCode?: number
  fromCache?: boolean
  ip?: string
  redirectUrl?: string
  error?: string
  requestBody?: RequestBody
}

const HEADER_EVENTS = {
  request: new Set<WebRequestEventName>(['onBeforeSendHeaders', 'onSendHeaders']),
  response: new Set<WebRequestEventName>([
    'onHeadersReceived',
    'onAuthRequired',
    'onResponseStarted',
    'onBeforeRedirect',
    'onCompleted'
  ])
}

const STATUS_EVENTS = new Set<WebRequestEventName>([
  'onHeadersReceived',
  'onAuthRequired',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted'
])

const CACHE_EVENTS = new Set<WebRequestEventName>([
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
])

/**
 * The details a listener of `event` sees: Chrome's common fields, plus headers only when the
 * spec asked for them (`requestHeaders` / `responseHeaders`), the status of response phases, the
 * cache and address fields of the phases that have them, the redirect target and the error.
 */
export function chromeRequestDetails(
  event: WebRequestEventName,
  details: HostRequestDetails,
  tabId: number,
  spec: readonly ExtraInfoSpec[]
): ChromeRequestDetails {
  const out: ChromeRequestDetails = {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    tabId,
    type: details.resourceType,
    timeStamp: details.timestamp,
    documentLifecycle: 'active',
    frameType: details.frameId === 0 ? 'outermost_frame' : 'sub_frame'
  }
  if (details.initiator) out.initiator = details.initiator
  if (spec.includes('requestHeaders') && HEADER_EVENTS.request.has(event)) {
    out.requestHeaders = toHttpHeaders(details.requestHeaders ?? {})
  }
  if (spec.includes('responseHeaders') && HEADER_EVENTS.response.has(event)) {
    out.responseHeaders = toHttpHeaders(details.responseHeaders ?? {})
  }
  if (STATUS_EVENTS.has(event)) {
    if (details.statusLine !== undefined) out.statusLine = details.statusLine
    if (details.statusCode !== undefined) out.statusCode = details.statusCode
  }
  if (CACHE_EVENTS.has(event)) {
    out.fromCache = details.fromCache ?? false
    if (details.ip !== undefined) out.ip = details.ip
  }
  if (event === 'onBeforeRedirect' && details.redirectUrl !== undefined) {
    out.redirectUrl = details.redirectUrl
  }
  if (event === 'onErrorOccurred') out.error = details.error ?? 'net::ERR_FAILED'
  if (event === 'onBeforeRequest' && spec.includes('requestBody')) {
    const body = requestBodyFrom(details.uploadData)
    if (body) out.requestBody = body
  }
  return out
}

// ---------------------------------------------------------------------------
// onAuthRequired: a server's or proxy's challenge
// ---------------------------------------------------------------------------

/**
 * A challenge as the engine reports it (Electron's `login` event: no request of the pipeline,
 * so the host supplies the request-shaped fields it can know). `scheme` is the challenge's
 * authentication scheme, lower case (`basic`, `digest`, `ntlm`, `negotiate`).
 */
export interface AuthChallenge {
  requestId: string
  url: string
  method: string
  tabId: number
  type: ResourceType
  timestamp: number
  isProxy: boolean
  scheme: string
  realm: string
  host: string
  port: number
}

/** Chrome's details for `onAuthRequired`: the request fields plus the challenge. */
export interface ChromeAuthRequiredDetails extends ChromeRequestDetails {
  challenger: { host: string; port: number }
  isProxy: boolean
  scheme: string
  realm?: string
}

/**
 * The `onAuthRequired` details of a challenge: a 407 for a proxy's, a 401 for a server's, the
 * challenger's host and port, the scheme and realm; the frame fields are the top frame's (the
 * engine does not say which frame's request it was) and `responseHeaders` come only when asked
 * for (empty: the engine keeps the response).
 */
export function chromeAuthRequiredDetails(
  challenge: AuthChallenge,
  spec: readonly ExtraInfoSpec[]
): ChromeAuthRequiredDetails {
  const out: ChromeAuthRequiredDetails = {
    requestId: challenge.requestId,
    url: challenge.url,
    method: challenge.method,
    frameId: 0,
    parentFrameId: -1,
    tabId: challenge.tabId,
    type: challenge.type,
    timeStamp: challenge.timestamp,
    documentLifecycle: 'active',
    frameType: 'outermost_frame',
    statusLine: challenge.isProxy
      ? 'HTTP/1.1 407 Proxy Authentication Required'
      : 'HTTP/1.1 401 Unauthorized',
    statusCode: challenge.isProxy ? 407 : 401,
    challenger: { host: challenge.host, port: challenge.port },
    isProxy: challenge.isProxy,
    scheme: challenge.scheme
  }
  if (challenge.realm !== '') out.realm = challenge.realm
  if (spec.includes('responseHeaders')) out.responseHeaders = []
  return out
}

/** Chrome's `webRequest.AuthCredentials`. */
export interface AuthCredentials {
  username: string
  password: string
}

// ---------------------------------------------------------------------------
// Blocking answers
// ---------------------------------------------------------------------------

/** What a blocking listener's answer becomes for the multiplexer (or, for `onAuthRequired`, the challenge). */
export interface BlockingAnswer {
  cancel?: boolean
  redirectUrl?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  authCredentials?: AuthCredentials
}

/**
 * Chrome's `BlockingResponse`, reduced to what the event accepts: `cancel` everywhere,
 * `redirectUrl` in `onBeforeRequest` and `onHeadersReceived`, `requestHeaders` in
 * `onBeforeSendHeaders`, `responseHeaders` in `onHeadersReceived`, `authCredentials` in
 * `onAuthRequired`. Fields the event does not
 * take, malformed header lists and anything that is not an object are ignored, as Chrome
 * ignores them (it logs; the request proceeds).
 */
export function normalizeBlockingResponse(
  event: WebRequestEventName,
  raw: unknown
): BlockingAnswer | undefined {
  if (!isRecord(raw)) return undefined
  const out: BlockingAnswer = {}
  if (raw.cancel === true) out.cancel = true
  if (
    (event === 'onBeforeRequest' || event === 'onHeadersReceived') &&
    typeof raw.redirectUrl === 'string' &&
    raw.redirectUrl !== ''
  ) {
    out.redirectUrl = raw.redirectUrl
  }
  if (event === 'onBeforeSendHeaders' && raw.requestHeaders !== undefined) {
    const headers = requestHeadersFrom(raw.requestHeaders)
    if (headers) out.requestHeaders = headers
  }
  if (event === 'onHeadersReceived' && raw.responseHeaders !== undefined) {
    const headers = responseHeadersFrom(raw.responseHeaders)
    if (headers) out.responseHeaders = headers
  }
  if (event === 'onAuthRequired' && isRecord(raw.authCredentials)) {
    const { username, password } = raw.authCredentials
    if (typeof username === 'string' && typeof password === 'string') {
      out.authCredentials = { username, password }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
