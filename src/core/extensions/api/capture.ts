/**
 * `chrome.tabs.captureVisibleTab` without the engine: the option validation, Chrome's decision
 * whether an extension may capture the page it is looking at, and the two-calls-per-second quota.
 * The host takes the picture.
 */

export interface CaptureOptions {
  format: 'jpeg' | 'png'
  /** 0 to 100, JPEG only (Chrome ignores it for PNG). */
  quality: number
}

export const DEFAULT_CAPTURE_QUALITY = 90
export const MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2

const SIGNATURE =
  'tabs.captureVisibleTab(optional integer windowId, optional extensionTypes.ImageDetails options, function callback)'

function optionError(property: string, detail: string): TypeError {
  return new TypeError(
    `Error in invocation of ${SIGNATURE}: Error at parameter 'options': Error at property '${property}': ${detail}`
  )
}

/** Chrome's `extensionTypes.ImageDetails` validation; throws the binding's TypeError. */
export function normalizeCaptureOptions(raw: unknown): CaptureOptions {
  if (raw === undefined || raw === null) {
    return { format: 'jpeg', quality: DEFAULT_CAPTURE_QUALITY }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`Error in invocation of ${SIGNATURE}: No matching signature.`)
  }
  const input = raw as Record<string, unknown>
  let format: CaptureOptions['format'] = 'jpeg'
  if (input.format !== undefined && input.format !== null) {
    if (input.format !== 'jpeg' && input.format !== 'png') {
      throw optionError('format', 'Value must be one of jpeg, png.')
    }
    format = input.format
  }
  let quality = DEFAULT_CAPTURE_QUALITY
  if (input.quality !== undefined && input.quality !== null) {
    if (typeof input.quality !== 'number' || !Number.isInteger(input.quality)) {
      throw optionError('quality', 'Invalid type: expected integer.')
    }
    if (input.quality < 0) throw optionError('quality', 'Value must be at least 0.')
    if (input.quality > 100) throw optionError('quality', 'Value must not be greater than 100.')
    quality = input.quality
  }
  return { format, quality }
}

/** What the extension holds when it asks to capture a page. */
export interface CaptureGrants {
  /** Host permission for every site: `<all_urls>` or the all-schemes / http plus https wildcards. */
  allUrls: boolean
  /** An `activeTab` grant on the tab being captured. */
  activeTab: boolean
  /** The "Allow access to file URLs" toggle. */
  fileAccess: boolean
  /** The capturing extension (its own pages are always capturable). */
  extensionId: string
}

/** The schemes of Zenium's own pages, off limits like Chrome's `chrome://`. */
const INTERNAL_SCHEMES = ['zen:', 'chrome:', 'devtools:', 'chrome-devtools:', 'view-source:']

/**
 * Chrome's `PermissionsData::CanCaptureVisiblePage`, as an error message or null when allowed:
 * some host access is needed at all; `activeTab` on the tab lets the extension capture whatever is
 * there (the user pointed at it), `<all_urls>` alone stops at the browser's own pages, other
 * extensions' pages and, without file access, `file:` pages.
 */
export function captureDenial(url: string, grants: CaptureGrants): string | null {
  if (!grants.allUrls && !grants.activeTab) {
    return "Either the '<all_urls>' or 'activeTab' permission is required."
  }
  if (grants.activeTab) return null
  let parsed: URL | null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (!parsed) return null
  if (INTERNAL_SCHEMES.includes(parsed.protocol)) {
    return `Cannot access a ${parsed.protocol}// URL`
  }
  if (parsed.protocol === 'chrome-extension:') {
    return parsed.host === grants.extensionId
      ? null
      : 'Cannot access a chrome-extension:// URL of different extension'
  }
  if (parsed.protocol === 'file:' && !grants.fileAccess) {
    return `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`
  }
  return null
}

/** Whether a set of host patterns amounts to Chrome's "all hosts". */
export function coversAllUrls(hostPermissions: readonly string[]): boolean {
  const set = new Set(hostPermissions.map((p) => p.trim()))
  if (set.has('<all_urls>') || set.has('*://*/*')) return true
  return set.has('http://*/*') && set.has('https://*/*')
}

/**
 * Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota (a sliding one-second window per
 * extension). `take` reports whether a call may proceed and counts it when it may.
 */
export class CaptureQuota {
  private readonly calls = new Map<string, number[]>()

  constructor(
    private readonly limit = MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
    private readonly windowMs = 1000
  ) {}

  take(key: string, now: number): boolean {
    const recent = (this.calls.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.calls.set(key, recent)
      return false
    }
    recent.push(now)
    this.calls.set(key, recent)
    return true
  }

  forget(key: string): void {
    this.calls.delete(key)
  }
}

export const CAPTURE_QUOTA_ERROR =
  'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'
