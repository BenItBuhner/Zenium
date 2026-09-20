/**
 * `chrome.offscreen` without the engine's document host: the checks Chrome's
 * `OffscreenCreateDocumentFunction` makes on `createDocument`'s parameters (a URL of the
 * extension itself, at least one known reason, the `TESTING` reason refused without its switch),
 * the reasons enum, and Chrome's error texts. The host owns the document (a hidden page of the
 * browser's own) and its lifetime; everything here is pure.
 *
 * Why the browser layer hosts the document at all: Chromium hosts an MV3 offscreen document in an
 * `ExtensionHost`, whose media-access delegate on Electron `CHECK`s that the extension holds the
 * app-only `audioCapture` / `videoCapture` permissions the moment the document touches
 * `navigator.mediaDevices` (`enumerateDevices`, `getUserMedia`), so a recorder's or an AI
 * sidebar's offscreen page takes the whole browser down. A document the browser hosts itself goes
 * through the session's permission handlers instead, like any page, and can consume a
 * `tabCapture` stream id.
 */

export const OFFSCREEN_PERMISSION = 'offscreen'

/** Chrome's `offscreen.Reason` values (the enum's members, in Chrome's order). */
export const OFFSCREEN_REASONS = [
  'TESTING',
  'AUDIO_PLAYBACK',
  'IFRAME_SCRIPTING',
  'DOM_SCRAPING',
  'BLOBS',
  'DOM_PARSER',
  'USER_MEDIA',
  'DISPLAY_MEDIA',
  'WEB_RTC',
  'CLIPBOARD',
  'LOCAL_STORAGE',
  'WORKERS',
  'BATTERY_STATUS',
  'MATCH_MEDIA',
  'GEOLOCATION'
] as const

export type OffscreenReason = (typeof OFFSCREEN_REASONS)[number]

/** `chrome.offscreen.Reason`, for the namespace's constants. */
export const OFFSCREEN_REASON_CONSTANTS: Record<string, string> = Object.fromEntries(
  OFFSCREEN_REASONS.map((reason) => [reason, reason])
)

// Chrome's texts (`extensions/browser/api/offscreen/offscreen_api.cc`).
export const OFFSCREEN_INVALID_URL_ERROR = 'Invalid URL.'
export const OFFSCREEN_ONLY_ONE_ERROR = 'Only a single offscreen document may be created.'
export const OFFSCREEN_REASON_REQUIRED_ERROR = 'A `reason` must be provided.'
export const OFFSCREEN_TESTING_ERROR =
  'The `TESTING` reason is only available with the --offscreen-document-testing commandline switch applied.'
export const OFFSCREEN_CLOSED_WHILE_LOADING_ERROR =
  'Offscreen document closed before fully loading.'
export const OFFSCREEN_LOAD_FAILED_ERROR = 'Page failed to load.'
export const OFFSCREEN_NONE_ERROR = 'No current offscreen document.'

const SIGNATURE = 'offscreen.createDocument(object parameters, optional function callback)'

/** `createDocument`'s parameters once checked: the document's full URL and its reasons. */
export interface OffscreenRequest {
  url: string
  /** Deduplicated, in the order given. */
  reasons: OffscreenReason[]
  justification: string
}

/**
 * Chrome's checks on `CreateParameters`, in its order. The binding's part first (a `TypeError`
 * for a missing or mistyped property, an unknown reason): `url` a string, `reasons` an array of
 * the enum's values, `justification` a string. Then the function's: the URL is taken as given
 * when it is absolute and resolved against the extension root otherwise, and must be of the
 * extension's own origin; the deduplicated reasons must not be empty; `TESTING` needs Chrome's
 * command-line switch, which no store extension has.
 */
export function normalizeOffscreenRequest(extensionId: string, raw: unknown): OffscreenRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`Error in invocation of ${SIGNATURE}: No matching signature.`)
  }
  const params = raw as Record<string, unknown>
  if (typeof params.url !== 'string') {
    throw propertyError('url', `Invalid type: expected string, found ${typeOf(params.url)}.`)
  }
  if (!Array.isArray(params.reasons)) {
    throw propertyError('reasons', `Invalid type: expected array, found ${typeOf(params.reasons)}.`)
  }
  const reasons: OffscreenReason[] = []
  params.reasons.forEach((reason, index) => {
    if (typeof reason !== 'string' || !(OFFSCREEN_REASONS as readonly string[]).includes(reason)) {
      throw propertyError(
        'reasons',
        `Error at index ${index}: Value must be one of ${OFFSCREEN_REASONS.join(', ')}.`
      )
    }
    if (!reasons.includes(reason as OffscreenReason)) reasons.push(reason as OffscreenReason)
  })
  if (typeof params.justification !== 'string') {
    throw propertyError(
      'justification',
      `Invalid type: expected string, found ${typeOf(params.justification)}.`
    )
  }
  const url = resolveOffscreenUrl(extensionId, params.url)
  if (url === null) throw new Error(OFFSCREEN_INVALID_URL_ERROR)
  if (reasons.length === 0) throw new Error(OFFSCREEN_REASON_REQUIRED_ERROR)
  if (reasons.includes('TESTING')) throw new Error(OFFSCREEN_TESTING_ERROR)
  return { url, reasons, justification: params.justification }
}

/**
 * The document's URL the way Chrome settles it: a valid absolute URL stands as given, anything
 * else is resolved against the extension root; either way the origin must be the extension's.
 * Null for a URL of another origin or one that does not parse at all.
 */
export function resolveOffscreenUrl(extensionId: string, given: string): string | null {
  const root = `chrome-extension://${extensionId}/`
  let url: URL
  try {
    url = new URL(given)
  } catch {
    try {
      url = new URL(given, root)
    } catch {
      return null
    }
  }
  if (url.protocol !== 'chrome-extension:' || url.host !== extensionId) return null
  return url.href
}

function propertyError(property: string, detail: string): TypeError {
  return new TypeError(
    `Error in invocation of ${SIGNATURE}: Error at parameter 'parameters': Error at property '${property}': ${detail}`
  )
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
