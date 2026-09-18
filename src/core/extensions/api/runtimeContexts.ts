/**
 * `chrome.runtime.getContexts`: the shapes Chrome hands out for an extension's live contexts and
 * the filter it accepts. The host builds the records from its context registry; everything that
 * does not need the engine (filter validation and matching, the type of a document) lives here.
 */

export type ContextType =
  'TAB' | 'POPUP' | 'BACKGROUND' | 'OFFSCREEN_DOCUMENT' | 'SIDE_PANEL' | 'DEVELOPER_TOOLS'

export const CONTEXT_TYPES: Record<ContextType, ContextType> = {
  TAB: 'TAB',
  POPUP: 'POPUP',
  BACKGROUND: 'BACKGROUND',
  OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
  SIDE_PANEL: 'SIDE_PANEL',
  DEVELOPER_TOOLS: 'DEVELOPER_TOOLS'
}

/** Chrome's `runtime.ExtensionContext`. */
export interface ExtensionContext {
  contextId: string
  contextType: ContextType
  /** Absent for the service worker. */
  documentId?: string
  documentOrigin?: string
  documentUrl?: string
  /** `-1` for the service worker. */
  frameId: number
  incognito: boolean
  /** `-1` for contexts outside a tab. */
  tabId: number
  windowId: number
}

/** Chrome's `runtime.ContextFilter`; every list narrows to the values it holds. */
export interface ContextFilter {
  contextIds?: string[]
  contextTypes?: ContextType[]
  documentIds?: string[]
  documentOrigins?: string[]
  documentUrls?: string[]
  frameIds?: number[]
  incognito?: boolean
  tabIds?: number[]
  windowIds?: number[]
}

const SIGNATURE = 'runtime.getContexts(runtime.ContextFilter filter, function callback)'

function fieldError(field: string, detail: string): TypeError {
  return new TypeError(
    `Error in invocation of ${SIGNATURE}: Error at parameter 'filter': Error at property '${field}': ${detail}`
  )
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isContextType(value: unknown): value is ContextType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONTEXT_TYPES, value)
}

/** A list property of the filter, checked item by item; absent (or null) means "no constraint". */
function listOf<T>(
  input: Record<string, unknown>,
  field: string,
  accepts: (item: unknown) => item is T,
  detail: string
): T[] | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw fieldError(field, 'Invalid type: expected array.')
  const out: T[] = []
  for (const item of value) {
    if (!accepts(item)) throw fieldError(field, detail)
    out.push(item)
  }
  return out
}

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Chrome's binding validation of the filter: lists of strings or integers, `contextTypes` from
 * the enum, `incognito` a boolean; unknown properties are ignored. Throws the binding's TypeError.
 */
export function normalizeContextFilter(raw: unknown): ContextFilter {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`Error in invocation of ${SIGNATURE}: No matching signature.`)
  }
  const input = raw as Record<string, unknown>
  const out: ContextFilter = {}
  const strings = 'Invalid type: expected string.'
  const integers = 'Invalid type: expected integer.'
  const enumeration = `Value must be one of ${Object.keys(CONTEXT_TYPES).join(', ')}.`
  const contextIds = listOf(input, 'contextIds', isString, strings)
  if (contextIds) out.contextIds = contextIds
  const contextTypes = listOf(input, 'contextTypes', isContextType, enumeration)
  if (contextTypes) out.contextTypes = contextTypes
  const documentIds = listOf(input, 'documentIds', isString, strings)
  if (documentIds) out.documentIds = documentIds
  const documentOrigins = listOf(input, 'documentOrigins', isString, strings)
  if (documentOrigins) out.documentOrigins = documentOrigins
  const documentUrls = listOf(input, 'documentUrls', isString, strings)
  if (documentUrls) out.documentUrls = documentUrls
  const frameIds = listOf(input, 'frameIds', isInteger, integers)
  if (frameIds) out.frameIds = frameIds
  const tabIds = listOf(input, 'tabIds', isInteger, integers)
  if (tabIds) out.tabIds = tabIds
  const windowIds = listOf(input, 'windowIds', isInteger, integers)
  if (windowIds) out.windowIds = windowIds
  if (input.incognito !== undefined && input.incognito !== null) {
    if (typeof input.incognito !== 'boolean') {
      throw fieldError('incognito', 'Invalid type: expected boolean.')
    }
    out.incognito = input.incognito
  }
  return out
}

/** Whether a context passes every list and flag of the filter (an absent field matches all). */
export function matchesContextFilter(context: ExtensionContext, filter: ContextFilter): boolean {
  if (filter.contextIds && !filter.contextIds.includes(context.contextId)) return false
  if (filter.contextTypes && !filter.contextTypes.includes(context.contextType)) return false
  if (filter.frameIds && !filter.frameIds.includes(context.frameId)) return false
  if (filter.tabIds && !filter.tabIds.includes(context.tabId)) return false
  if (filter.windowIds && !filter.windowIds.includes(context.windowId)) return false
  if (filter.incognito !== undefined && filter.incognito !== context.incognito) return false
  if (filter.documentIds) {
    if (context.documentId === undefined || !filter.documentIds.includes(context.documentId)) {
      return false
    }
  }
  if (filter.documentOrigins) {
    if (
      context.documentOrigin === undefined ||
      !filter.documentOrigins.includes(context.documentOrigin)
    ) {
      return false
    }
  }
  if (filter.documentUrls) {
    if (context.documentUrl === undefined || !filter.documentUrls.includes(context.documentUrl)) {
      return false
    }
  }
  return true
}

/**
 * The `contextType` of an extension document from where it is shown (the registry's kind) and
 * its URL: the manifest's `devtools_page` and `side_panel` pages have their own types, an
 * offscreen document (`offscreen.createDocument`) too; every other page shown outside a tab or
 * popup counts as a tab, like Chrome's fallback.
 */
export function contextTypeOf(
  kind: 'tab' | 'popup' | 'background' | 'options' | 'other',
  url: string,
  manifest: { devtools_page?: unknown; side_panel?: unknown }
): ContextType {
  if (kind === 'background') return 'BACKGROUND'
  if (kind === 'popup') return 'POPUP'
  const path = pathOf(url)
  if (path !== null) {
    if (
      typeof manifest.devtools_page === 'string' &&
      path === normalizePath(manifest.devtools_page)
    )
      return 'DEVELOPER_TOOLS'
    const panel =
      manifest.side_panel !== null && typeof manifest.side_panel === 'object'
        ? (manifest.side_panel as Record<string, unknown>).default_path
        : undefined
    if (typeof panel === 'string' && path === normalizePath(panel)) return 'SIDE_PANEL'
  }
  return 'TAB'
}

/**
 * Chrome's `documentOrigin`: scheme and host without a trailing slash. Built by hand because
 * Node's `URL.origin` is opaque (`"null"`) for schemes it does not know, `chrome-extension:` among them.
 */
export function documentOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (!parsed.host) return undefined
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\/+/, '')
  } catch {
    return null
  }
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').split(/[?#]/)[0]
}
