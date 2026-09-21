/**
 * `chrome.downloads` over Zenium's downloads model (`core/downloads`, owned by the downloads
 * engine program). Host-neutral: Chrome's `DownloadItem` shape, its query filters and sort
 * orders, the `onChanged` delta and the argument refusals of `download()`, all as pure functions
 * over the model's `DownloadItem`. The host module resolves ids, starts transfers and fires the
 * events from a diff of the list.
 *
 * State mapping. Chrome keeps a dangerous download `in_progress` until the user validates it;
 * Zenium marks the record `completed` and quarantines the file until Keep / Discard. A
 * quarantined record is therefore reported `in_progress` with its danger type, `complete` with
 * `danger: 'accepted'` once kept. `cancelled` is Chrome's `interrupted` + `USER_CANCELED`.
 */
import type { DownloadDanger, DownloadItem } from '../../../shared/types'
import { chromeInterruptReasonName } from '../../../shared/downloads'

export type ChromeDownloadState = 'in_progress' | 'interrupted' | 'complete'

export type ChromeDangerType =
  | 'file'
  | 'url'
  | 'content'
  | 'uncommon'
  | 'host'
  | 'unwanted'
  | 'safe'
  | 'accepted'
  | 'allowlistedByPolicy'
  | 'asyncScanning'
  | 'asyncLocalPasswordScanning'
  | 'passwordProtected'
  | 'blockedTooLarge'
  | 'sensitiveContentWarning'
  | 'sensitiveContentBlock'
  | 'deepScannedFailed'
  | 'deepScannedSafe'
  | 'deepScannedOpenedDangerous'
  | 'promptForScanning'
  | 'promptForLocalPasswordScanning'
  | 'accountCompromise'
  | 'blockedScanFailed'

export const INTERRUPT_REASONS = [
  'FILE_FAILED',
  'FILE_ACCESS_DENIED',
  'FILE_NO_SPACE',
  'FILE_NAME_TOO_LONG',
  'FILE_TOO_LARGE',
  'FILE_VIRUS_INFECTED',
  'FILE_TRANSIENT_ERROR',
  'FILE_BLOCKED',
  'FILE_SECURITY_CHECK_FAILED',
  'FILE_TOO_SHORT',
  'FILE_HASH_MISMATCH',
  'FILE_SAME_AS_SOURCE',
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN',
  'NETWORK_INVALID_REQUEST',
  'SERVER_FAILED',
  'SERVER_NO_RANGE',
  'SERVER_BAD_CONTENT',
  'SERVER_UNAUTHORIZED',
  'SERVER_CERT_PROBLEM',
  'SERVER_FORBIDDEN',
  'SERVER_UNREACHABLE',
  'SERVER_CONTENT_LENGTH_MISMATCH',
  'SERVER_CROSS_ORIGIN_REDIRECT',
  'USER_CANCELED',
  'USER_SHUTDOWN',
  'CRASH'
] as const

export type ChromeInterruptReason = (typeof INTERRUPT_REASONS)[number]

export type FilenameConflictAction = 'uniquify' | 'overwrite' | 'prompt'

export interface ChromeDownloadItem {
  id: number
  url: string
  finalUrl: string
  referrer: string
  /** Absolute local path of the target file (the suggested base name in `onDeterminingFilename`). */
  filename: string
  incognito: boolean
  danger: ChromeDangerType
  mime: string
  startTime: string
  endTime?: string
  estimatedEndTime?: string
  state: ChromeDownloadState
  paused: boolean
  canResume: boolean
  error?: ChromeInterruptReason
  bytesReceived: number
  totalBytes: number
  fileSize: number
  exists: boolean
  byExtensionId?: string
  byExtensionName?: string
}

/**
 * What the host knows about a record beyond the model: its Chrome id, target path, starter.
 * Whether the completed file is still there is the model's own `fileMissing`.
 */
export interface DownloadView {
  id: number
  /** Where the file is meant to end up while in flight (the model only carries the base name). */
  targetPath: string | null
  byExtension?: { id: string; name: string }
}

/** Fields `onChanged` reports; `bytesReceived` and `estimatedEndTime` never fire it, like Chrome. */
const DELTA_FIELDS = [
  'url',
  'finalUrl',
  'filename',
  'danger',
  'mime',
  'startTime',
  'endTime',
  'state',
  'canResume',
  'paused',
  'error',
  'totalBytes',
  'fileSize',
  'exists'
] as const

type DeltaField = (typeof DELTA_FIELDS)[number]

export type DownloadDelta = { id: number } & {
  [K in DeltaField]?: { previous?: ChromeDownloadItem[K]; current?: ChromeDownloadItem[K] }
}

// Chrome's download_extension_errors.cc, verbatim.
export const ERROR_INVALID_ID = 'Invalid download id'
export const ERROR_INVALID_URL = 'Invalid URL'
export const ERROR_INVALID_FILENAME = 'Invalid filename'
export const ERROR_INVALID_FILTER = 'Invalid query filter'
export const ERROR_INVALID_ORDER_BY = 'Invalid orderBy field'
export const ERROR_INVALID_LIMIT = 'Invalid query limit'
export const ERROR_INVALID_STATE = 'Invalid state'
export const ERROR_INVALID_DANGER = 'Invalid danger type'
export const ERROR_INVALID_HEADER_NAME = 'Invalid request header name'
export const ERROR_UNSAFE_HEADER = 'Unsafe request header name'
export const ERROR_INVALID_HEADER_VALUE = 'Invalid request header value'
export const ERROR_NOT_IN_PROGRESS = 'Download must be in progress'
export const ERROR_NOT_RESUMABLE = 'DownloadItem.canResume must be true'
export const ERROR_NOT_COMPLETE = 'Download must be complete'
export const ERROR_NOT_DANGEROUS = 'Download must be dangerous'
export const ERROR_FILE_ALREADY_DELETED = 'Download file already deleted'
export const ERROR_FILE_NOT_REMOVED = 'Unable to remove file'
export const ERROR_EMPTY_FILE = 'Filename not yet determined'
export const ERROR_ICON_NOT_FOUND = 'Icon not found'
export const ERROR_OPEN_PERMISSION = 'The "downloads.open" permission is required'
export const ERROR_UI_PERMISSION = 'downloads.ui permission required'
export const ERROR_SHELF_PERMISSION = 'downloads.shelf permission required'
export const ERROR_NO_PERMISSION = "The 'downloads' permission is required."
/** Zenium's own: the engine starts transfers by URL only. */
export const ERROR_POST_UNSUPPORTED = 'POST downloads are not supported'

export class DownloadArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadArgumentError'
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** A finished download whose file is held back behind a danger warning (the model's rule). */
export function quarantined(item: DownloadItem): boolean {
  return item.state === 'completed' && item.danger.level !== 'safe' && !item.dangerAccepted
}

export function chromeState(item: DownloadItem): ChromeDownloadState {
  switch (item.state) {
    case 'progressing':
    case 'paused':
      return 'in_progress'
    case 'completed':
      return quarantined(item) ? 'in_progress' : 'complete'
    // A blocked insecure download too: refused before a byte was written, nothing is in
    // progress and nothing is complete.
    case 'cancelled':
    case 'interrupted':
    case 'insecure-blocked':
      return 'interrupted'
  }
}

export function chromeDanger(danger: DownloadDanger, accepted: boolean): ChromeDangerType {
  if (danger.level === 'safe') return 'safe'
  if (accepted) return 'accepted'
  if (danger.reason === 'url-verdict') return 'url'
  return danger.level === 'dangerous' ? 'file' : 'uncommon'
}

/**
 * The model's reason in Chrome's spelling: every `DownloadInterruptReason` is one of Chrome's
 * (`network-failed` → `NETWORK_FAILED`); a cancelled row is `USER_CANCELED`, an interrupted one
 * without a reason (never written by this build) a plain network failure, and a row blocked by
 * the insecure-download rule `FILE_BLOCKED` (what Chrome's item reads when the browser refuses
 * the file).
 */
export function chromeInterruptReason(item: DownloadItem): ChromeInterruptReason | undefined {
  if (item.state === 'cancelled') return 'USER_CANCELED'
  if (item.state === 'insecure-blocked') return 'FILE_BLOCKED'
  if (item.state !== 'interrupted') return undefined
  const name = item.error ? chromeInterruptReasonName(item.error) : 'NETWORK_FAILED'
  return INTERRUPT_REASONS.includes(name as ChromeInterruptReason)
    ? (name as ChromeInterruptReason)
    : 'NETWORK_FAILED'
}

function directoryOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx === -1 ? '' : path.slice(0, idx + 1)
}

/**
 * Chrome's `filename` is the target path from the start; the model knows the partial file
 * and the final base name, the host the intended directory.
 */
export function chromeFilename(item: DownloadItem, targetPath: string | null): string {
  if (item.state === 'completed' && !quarantined(item) && item.savePath) return item.savePath
  if (targetPath) return targetPath
  if (item.savePath) return directoryOf(item.savePath) + item.finalName
  return item.finalName
}

export function toChromeDownloadItem(
  item: DownloadItem,
  view: DownloadView,
  now: number
): ChromeDownloadItem {
  const state = chromeState(item)
  const complete = state === 'complete'
  const known =
    item.totalBytes > 0 ? item.totalBytes : item.state === 'completed' ? item.receivedBytes : -1
  const result: ChromeDownloadItem = {
    id: view.id,
    url: item.url,
    finalUrl: item.url,
    referrer: item.referrer,
    filename: chromeFilename(item, view.targetPath),
    incognito: item.private,
    danger: chromeDanger(item.danger, item.dangerAccepted),
    mime: item.mimeType,
    startTime: new Date(item.startedAt).toISOString(),
    state,
    paused: item.state === 'paused',
    canResume: item.state === 'paused' || (item.state === 'interrupted' && item.canResume),
    bytesReceived: item.receivedBytes,
    totalBytes: known,
    fileSize: complete ? known : -1,
    exists: complete ? item.fileMissing !== true : true
  }
  if (state !== 'in_progress' && item.endedAt !== undefined)
    result.endTime = new Date(item.endedAt).toISOString()
  if (item.state === 'progressing' && item.etaMs !== null)
    result.estimatedEndTime = new Date(now + item.etaMs).toISOString()
  const error = chromeInterruptReason(item)
  if (error) result.error = error
  if (view.byExtension) {
    result.byExtensionId = view.byExtension.id
    result.byExtensionName = view.byExtension.name
  }
  return result
}

/**
 * A download as `onCreated` reported it: Chrome makes the item `in_progress` before a byte has
 * arrived and tells of everything after as changes. A row that settled (a small file completes,
 * a refused one is interrupted) between two ticks is first seen in its settled shape; reporting
 * its creation from this shape and the settling as the `onChanged` between the two keeps Chrome's
 * order, which listeners waiting for `state.current === 'complete'` depend on.
 */
export function creationShape(item: ChromeDownloadItem): ChromeDownloadItem {
  const created: ChromeDownloadItem = {
    ...item,
    state: 'in_progress',
    paused: false,
    canResume: false,
    bytesReceived: 0,
    fileSize: -1,
    exists: true
  }
  delete created.endTime
  delete created.estimatedEndTime
  delete created.error
  return created
}

/** The `onChanged` delta between two shapes of one download; null when nothing it reports changed. */
export function downloadDelta(
  prev: ChromeDownloadItem,
  next: ChromeDownloadItem
): DownloadDelta | null {
  let changed = false
  const delta: DownloadDelta = { id: next.id }
  for (const field of DELTA_FIELDS) {
    const before = prev[field]
    const after = next[field]
    if (before === after) continue
    changed = true
    const pair: { previous?: unknown; current?: unknown } = {}
    if (before !== undefined) pair.previous = before
    if (after !== undefined) pair.current = after
    ;(delta as Record<string, unknown>)[field] = pair
  }
  return changed ? delta : null
}

/** A stable positive 31-bit id for a model id (FNV-1a); the host settles collisions. */
export function hashDownloadId(zenId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < zenId.length; i++) {
    hash ^= zenId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash & 0x7fffffff || 1
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const STATES: readonly ChromeDownloadState[] = ['in_progress', 'interrupted', 'complete']

const DANGERS: readonly ChromeDangerType[] = [
  'file',
  'url',
  'content',
  'uncommon',
  'host',
  'unwanted',
  'safe',
  'accepted',
  'allowlistedByPolicy',
  'asyncScanning',
  'asyncLocalPasswordScanning',
  'passwordProtected',
  'blockedTooLarge',
  'sensitiveContentWarning',
  'sensitiveContentBlock',
  'deepScannedFailed',
  'deepScannedSafe',
  'deepScannedOpenedDangerous',
  'promptForScanning',
  'promptForLocalPasswordScanning',
  'accountCompromise',
  'blockedScanFailed'
]

/** Fields a query may match exactly and `orderBy` may sort on. */
const SCALAR_FIELDS = [
  'id',
  'url',
  'finalUrl',
  'filename',
  'danger',
  'mime',
  'startTime',
  'endTime',
  'state',
  'paused',
  'error',
  'bytesReceived',
  'totalBytes',
  'fileSize',
  'exists'
] as const

type ScalarField = (typeof SCALAR_FIELDS)[number]

export interface DownloadQuery {
  terms: string[]
  startedBefore: number | null
  startedAfter: number | null
  endedBefore: number | null
  endedAfter: number | null
  totalBytesGreater: number | null
  totalBytesLess: number | null
  filenameRegex: RegExp | null
  urlRegex: RegExp | null
  finalUrlRegex: RegExp | null
  /** 0 is unlimited; Chrome's default is 1000. */
  limit: number
  orderBy: Array<{ field: ScalarField; descending: boolean }>
  exact: Partial<Pick<ChromeDownloadItem, ScalarField>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScalarField(name: string): name is ScalarField {
  return (SCALAR_FIELDS as readonly string[]).includes(name)
}

/** ISO 8601 strings and epoch milliseconds (a number, or a string of digits) both name a time. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value === '') return null
  if (/^\d+$/.test(value)) return Number(value)
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function regexOf(value: unknown, field: string): RegExp | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new DownloadArgumentError(`Invalid ${field}`)
  try {
    return new RegExp(value)
  } catch {
    throw new DownloadArgumentError(ERROR_INVALID_FILTER)
  }
}

function timeOf(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  const ms = parseTime(value)
  if (ms === null) throw new DownloadArgumentError(`Invalid ${field}`)
  return ms
}

function numberOf(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new DownloadArgumentError(`Invalid ${field}`)
  return value
}

export function normalizeDownloadQuery(raw: unknown): DownloadQuery {
  const q = raw === undefined || raw === null ? {} : raw
  if (!isRecord(q)) throw new DownloadArgumentError(ERROR_INVALID_FILTER)
  const terms: string[] = []
  if (q.query !== undefined && q.query !== null) {
    if (!Array.isArray(q.query) || !q.query.every((t) => typeof t === 'string'))
      throw new DownloadArgumentError(ERROR_INVALID_FILTER)
    terms.push(...(q.query as string[]).filter((t) => t !== ''))
  }
  let limit = 1000
  if (q.limit !== undefined && q.limit !== null) {
    if (typeof q.limit !== 'number' || !Number.isInteger(q.limit) || q.limit < 0)
      throw new DownloadArgumentError(ERROR_INVALID_LIMIT)
    limit = q.limit
  }
  const orderBy: DownloadQuery['orderBy'] = []
  if (q.orderBy !== undefined && q.orderBy !== null) {
    const list = typeof q.orderBy === 'string' ? [q.orderBy] : q.orderBy
    if (!Array.isArray(list)) throw new DownloadArgumentError(ERROR_INVALID_ORDER_BY)
    for (const entry of list) {
      if (typeof entry !== 'string') throw new DownloadArgumentError(ERROR_INVALID_ORDER_BY)
      const descending = entry.startsWith('-')
      const field = descending ? entry.slice(1) : entry
      if (!isScalarField(field)) throw new DownloadArgumentError(ERROR_INVALID_ORDER_BY)
      orderBy.push({ field, descending })
    }
  }
  const exact: DownloadQuery['exact'] = {}
  for (const field of SCALAR_FIELDS) {
    const value = q[field]
    if (value === undefined || value === null) continue
    switch (field) {
      case 'state':
        if (!STATES.includes(value as ChromeDownloadState))
          throw new DownloadArgumentError(ERROR_INVALID_STATE)
        exact.state = value as ChromeDownloadState
        break
      case 'danger':
        if (!DANGERS.includes(value as ChromeDangerType))
          throw new DownloadArgumentError(ERROR_INVALID_DANGER)
        exact.danger = value as ChromeDangerType
        break
      case 'error':
        if (!INTERRUPT_REASONS.includes(value as ChromeInterruptReason))
          throw new DownloadArgumentError(ERROR_INVALID_FILTER)
        exact.error = value as ChromeInterruptReason
        break
      case 'paused':
      case 'exists':
        if (typeof value !== 'boolean') throw new DownloadArgumentError(ERROR_INVALID_FILTER)
        exact[field] = value
        break
      case 'id':
      case 'bytesReceived':
      case 'totalBytes':
      case 'fileSize':
        if (typeof value !== 'number') throw new DownloadArgumentError(ERROR_INVALID_FILTER)
        exact[field] = value
        break
      default:
        if (typeof value !== 'string') throw new DownloadArgumentError(ERROR_INVALID_FILTER)
        exact[field] = value
    }
  }
  return {
    terms,
    startedBefore: timeOf(q.startedBefore, 'startedBefore'),
    startedAfter: timeOf(q.startedAfter, 'startedAfter'),
    endedBefore: timeOf(q.endedBefore, 'endedBefore'),
    endedAfter: timeOf(q.endedAfter, 'endedAfter'),
    totalBytesGreater: numberOf(q.totalBytesGreater, 'totalBytesGreater'),
    totalBytesLess: numberOf(q.totalBytesLess, 'totalBytesLess'),
    filenameRegex: regexOf(q.filenameRegex, 'filenameRegex'),
    urlRegex: regexOf(q.urlRegex, 'urlRegex'),
    finalUrlRegex: regexOf(q.finalUrlRegex, 'finalUrlRegex'),
    limit,
    orderBy,
    exact
  }
}

function matchesTerm(item: ChromeDownloadItem, term: string): boolean {
  const needle = term.toLowerCase()
  return (
    item.filename.toLowerCase().includes(needle) ||
    item.url.toLowerCase().includes(needle) ||
    item.finalUrl.toLowerCase().includes(needle)
  )
}

export function matchesQuery(item: ChromeDownloadItem, query: DownloadQuery): boolean {
  for (const term of query.terms) {
    // A leading dash excludes: `-pdf` drops anything mentioning pdf.
    if (term.startsWith('-')) {
      if (term.length > 1 && matchesTerm(item, term.slice(1))) return false
    } else if (!matchesTerm(item, term)) return false
  }
  const started = Date.parse(item.startTime)
  if (query.startedBefore !== null && !(started < query.startedBefore)) return false
  if (query.startedAfter !== null && !(started > query.startedAfter)) return false
  if (query.endedBefore !== null || query.endedAfter !== null) {
    if (item.endTime === undefined) return false
    const ended = Date.parse(item.endTime)
    if (query.endedBefore !== null && !(ended < query.endedBefore)) return false
    if (query.endedAfter !== null && !(ended > query.endedAfter)) return false
  }
  if (query.totalBytesGreater !== null && !(item.totalBytes > query.totalBytesGreater)) return false
  if (query.totalBytesLess !== null && !(item.totalBytes < query.totalBytesLess)) return false
  if (query.filenameRegex && !query.filenameRegex.test(item.filename)) return false
  if (query.urlRegex && !query.urlRegex.test(item.url)) return false
  if (query.finalUrlRegex && !query.finalUrlRegex.test(item.finalUrl)) return false
  for (const [field, wanted] of Object.entries(query.exact)) {
    if (item[field as ScalarField] !== wanted) return false
  }
  return true
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a) < String(b) ? -1 : 1
}

/** Filter, sort and cap a list of shapes the way `search` and `erase` do. */
export function runDownloadQuery(
  items: readonly ChromeDownloadItem[],
  query: DownloadQuery
): ChromeDownloadItem[] {
  const hits = items.filter((item) => matchesQuery(item, query))
  if (query.orderBy.length > 0) {
    hits.sort((a, b) => {
      for (const { field, descending } of query.orderBy) {
        const cmp = compareValues(a[field], b[field])
        if (cmp !== 0) return descending ? -cmp : cmp
      }
      return 0
    })
  }
  return query.limit > 0 ? hits.slice(0, query.limit) : hits
}

// ---------------------------------------------------------------------------
// download(options)
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  url: string
  /** Relative to the downloads folder, already checked to be safe. */
  filename: string | null
  conflictAction: FilenameConflictAction
  saveAs: boolean | null
  headers: Record<string, string>
}

const CONFLICT_ACTIONS: readonly FilenameConflictAction[] = ['uniquify', 'overwrite', 'prompt']

/** Schemes the engine downloads from; `javascript:` and Zenium's own pages are not files. */
const DOWNLOADABLE_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'file:', 'data:', 'blob:'])

export function isDownloadableUrl(url: string): boolean {
  try {
    return DOWNLOADABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

const RESERVED_NAMES = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(\..*)?$/i
const ILLEGAL_CHARS = /[<>:"|?*\\/]/

/** C0 controls and DEL: never part of a portable file name or a header value. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * `net::IsSafePortableRelativePath`: a relative path of portable components, no `..`, nothing
 * a shell treats specially. Forward slashes separate; the platform host joins it under the
 * downloads folder.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[a-z]:/i.test(path)) return false
  if (path.includes('\\')) return false
  for (const component of path.split('/')) {
    if (component === '' || component === '.' || component === '..') return false
    if (ILLEGAL_CHARS.test(component) || hasControlChars(component)) return false
    if (component.endsWith('.') || component.endsWith(' ')) return false
    if (RESERVED_NAMES.test(component)) return false
  }
  return true
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `net::HttpUtil::IsSafeHeader`: the request headers the network stack owns. */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via'
])

export function isSafeHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  return !FORBIDDEN_HEADERS.has(lower) && !lower.startsWith('proxy-') && !lower.startsWith('sec-')
}

export function normalizeConflictAction(value: unknown): FilenameConflictAction {
  if (value === undefined || value === null) return 'uniquify'
  if (!CONFLICT_ACTIONS.includes(value as FilenameConflictAction))
    throw new DownloadArgumentError('Invalid conflictAction')
  return value as FilenameConflictAction
}

export function normalizeDownloadOptions(raw: unknown): DownloadOptions {
  if (!isRecord(raw) || typeof raw.url !== 'string')
    throw new DownloadArgumentError(ERROR_INVALID_URL)
  if (!isDownloadableUrl(raw.url)) throw new DownloadArgumentError(ERROR_INVALID_URL)
  let filename: string | null = null
  if (raw.filename !== undefined && raw.filename !== null && raw.filename !== '') {
    if (typeof raw.filename !== 'string' || !isSafeRelativePath(raw.filename))
      throw new DownloadArgumentError(ERROR_INVALID_FILENAME)
    filename = raw.filename
  }
  const conflictAction = normalizeConflictAction(raw.conflictAction)
  let saveAs: boolean | null = null
  if (raw.saveAs !== undefined && raw.saveAs !== null) {
    if (typeof raw.saveAs !== 'boolean') throw new DownloadArgumentError('Invalid saveAs')
    saveAs = raw.saveAs
  }
  if (raw.method !== undefined && raw.method !== null && raw.method !== 'GET') {
    if (raw.method === 'POST') throw new DownloadArgumentError(ERROR_POST_UNSUPPORTED)
    throw new DownloadArgumentError('Invalid method')
  }
  if (raw.body !== undefined && raw.body !== null)
    throw new DownloadArgumentError(ERROR_POST_UNSUPPORTED)
  const headers: Record<string, string> = {}
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!Array.isArray(raw.headers)) throw new DownloadArgumentError(ERROR_INVALID_HEADER_NAME)
    for (const header of raw.headers) {
      if (!isRecord(header) || typeof header.name !== 'string' || !TOKEN.test(header.name))
        throw new DownloadArgumentError(ERROR_INVALID_HEADER_NAME)
      if (!isSafeHeaderName(header.name)) throw new DownloadArgumentError(ERROR_UNSAFE_HEADER)
      const value = header.value === undefined ? '' : header.value
      if (typeof value !== 'string' || /[\r\n]/.test(value) || value.includes('\0'))
        throw new DownloadArgumentError(ERROR_INVALID_HEADER_VALUE)
      headers[header.name] = value
    }
  }
  return { url: new URL(raw.url).href, filename, conflictAction, saveAs, headers }
}

/** What an `onDeterminingFilename` listener passed to `suggest()`; null keeps the default. */
export interface FilenameSuggestion {
  filename: string
  conflictAction: FilenameConflictAction
}

/**
 * A listener's suggestion: `suggest()` with nothing (or an object without a name) declines;
 * an unsafe name is an error Chrome logs and ignores, so it declines too.
 */
export function normalizeSuggestion(raw: unknown): FilenameSuggestion | null {
  if (!isRecord(raw)) return null
  const filename = raw.filename
  if (typeof filename !== 'string' || filename === '') return null
  if (!isSafeRelativePath(filename)) return null
  let conflictAction: FilenameConflictAction
  try {
    conflictAction = normalizeConflictAction(raw.conflictAction)
  } catch {
    return null
  }
  return { filename, conflictAction }
}

export function isChromeDownloadState(value: unknown): value is ChromeDownloadState {
  return STATES.includes(value as ChromeDownloadState)
}
