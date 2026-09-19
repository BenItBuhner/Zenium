/**
 * Download helpers shared by the browser core, the hosts and the renderer: the settings block
 * with its defaults (profiles from before it existed carry none), file-name utilities and the
 * suffix in-flight files are written under.
 */
import type { DownloadInterruptReason, DownloadSettings, Settings } from './types'

/** In-progress and quarantined files end in this (Chrome: `.crdownload`, Firefox: `.part`). */
export const PARTIAL_SUFFIX = '.zeniumdownload'

// ---------------------------------------------------------------------------
// Interrupt reasons
// ---------------------------------------------------------------------------

/** Every `DownloadInterruptReason`, in Chromium's order. */
export const INTERRUPT_REASONS: readonly DownloadInterruptReason[] = [
  'network-failed',
  'network-timeout',
  'network-disconnected',
  'network-server-down',
  'server-failed',
  'server-no-range',
  'server-bad-content',
  'server-unauthorized',
  'server-forbidden',
  'server-unreachable',
  'file-failed',
  'file-access-denied',
  'file-no-space',
  'file-name-too-long',
  'file-too-large',
  'file-virus-infected',
  'file-blocked',
  'file-security-check-failed',
  'file-same-as-source',
  'user-canceled',
  'user-shutdown',
  'crash'
]

const REASON_SET: ReadonlySet<string> = new Set(INTERRUPT_REASONS)

export function isInterruptReason(value: unknown): value is DownloadInterruptReason {
  return typeof value === 'string' && REASON_SET.has(value)
}

/**
 * Chromium's `net::` error names onto the interrupt reasons, exactly the cases of its download
 * core's `ConvertNetErrorToInterruptReason` (components/download, `download_utils.cc`) that land
 * in this set, plus `ERR_ABORTED`, which `HandleRequestCompletionStatus` reads as the user
 * cancelling. Everything else the network stack reports (`ERR_CONNECTION_REFUSED`,
 * `ERR_CONNECTION_RESET`, `ERR_NAME_NOT_RESOLVED`, `ERR_EMPTY_RESPONSE`, a connection closed
 * short of the announced length) is Chromium's `NETWORK_FAILED`, the source's default.
 */
const NET_ERRORS: Readonly<Record<string, DownloadInterruptReason>> = {
  ERR_TIMED_OUT: 'network-timeout',
  ERR_INTERNET_DISCONNECTED: 'network-disconnected',
  ERR_CONNECTION_FAILED: 'network-server-down',
  ERR_REQUEST_RANGE_NOT_SATISFIABLE: 'server-no-range',
  ERR_ACCESS_DENIED: 'file-access-denied',
  ERR_FILE_NO_SPACE: 'file-no-space',
  ERR_FILE_PATH_TOO_LONG: 'file-name-too-long',
  ERR_FILE_TOO_BIG: 'file-too-large',
  ERR_FILE_VIRUS_INFECTED: 'file-virus-infected',
  ERR_BLOCKED_BY_CLIENT: 'file-blocked',
  ERR_ABORTED: 'user-canceled'
}

/**
 * The reason behind a Chromium `net::` error name (`net::ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`),
 * as the Electron host sees them on `webRequest.onErrorOccurred`. Certificate and TLS errors read
 * as the site not being available (Chromium's `SERVER_CERT_PROBLEM` is outside this set; its
 * bubble words both the same way); anything unknown is a network failure, as in Chromium.
 */
export function interruptReasonFromNetError(error: string): DownloadInterruptReason {
  const name = error.trim().replace(/^net::/, '')
  const known = NET_ERRORS[name]
  if (known) return known
  if (/^ERR_(CERT_|SSL_)/.test(name)) return 'server-failed'
  return 'network-failed'
}

/**
 * The reason a download's HTTP status carries, as Chromium's download core reads it
 * (`HandleSuccessfulServerResponse`): no entity to download (404, and 204 / 205 which have
 * none by definition), the server wants credentials (401, 407) or refuses (403), a range it
 * cannot serve (416), or plainly failed (every other 4xx and 5xx). Null for statuses a download
 * proceeds under (2xx including 201 and 202, which Chromium downloads like any response;
 * 1xx and 3xx are handled earlier in the stack).
 */
export function interruptReasonFromHttpStatus(status: number): DownloadInterruptReason | null {
  if (status === 204 || status === 205 || status === 404) return 'server-bad-content'
  if (status < 400) return null
  if (status === 401 || status === 407) return 'server-unauthorized'
  if (status === 403) return 'server-forbidden'
  if (status === 416) return 'server-no-range'
  return 'server-failed'
}

/**
 * What the answer to a resume's `Range: bytes=<offset>-` request says went wrong, for a host that
 * re-sends that request to learn why Chromium's own resume was refused: a refusing status is
 * read through `interruptReasonFromHttpStatus`; a 2xx that is not a 206 and carries no
 * `Content-Range` while a range past 0 was asked for is the server not doing ranges
 * (Chromium's `SERVER_NO_RANGE`); a 206, or a full answer to a request from byte 0, is the
 * server serving fine (null: the refusal was not the server's, or was not repeated).
 */
export function interruptReasonFromRangeResponse(
  status: number,
  contentRange: string | null | undefined,
  offset: number
): DownloadInterruptReason | null {
  if (status >= 400) return interruptReasonFromHttpStatus(status)
  if (status === 206 || status < 200 || status >= 300) return null
  if (offset > 0 && !contentRange?.trim()) return 'server-no-range'
  return null
}

/**
 * Any reason a host or an older `downloads.json` may name, onto the closed set: a member as is,
 * Chrome's own spelling (`NETWORK_TIMEOUT`, `DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE`), a
 * `net::` error name, the short reasons earlier builds wrote (`shutdown`, `file-error`), and
 * `fallback` for `interrupted`, nothing, or anything unknown.
 */
export function interruptReasonFrom(
  raw: unknown,
  fallback: DownloadInterruptReason = 'network-failed'
): DownloadInterruptReason {
  if (typeof raw !== 'string') return fallback
  const value = raw.trim()
  if (isInterruptReason(value)) return value
  if (value === 'shutdown') return 'user-shutdown'
  if (value === 'file-error') return 'file-failed'
  if (value === 'cancelled' || value === 'canceled') return 'user-canceled'
  if (/^(net::)?ERR_/.test(value)) return interruptReasonFromNetError(value)
  const chrome = value
    .replace(/^DOWNLOAD_INTERRUPT_REASON_/, '')
    .toLowerCase()
    .replace(/_/g, '-')
  if (isInterruptReason(chrome)) return chrome
  return fallback
}

/** A reason as `chrome.downloads` spells it: `network-failed` → `NETWORK_FAILED`. */
export function chromeInterruptReasonName(reason: DownloadInterruptReason): string {
  return reason.toUpperCase().replace(/-/g, '_')
}

/**
 * Chrome's one-line wording for each reason (the download bubble's `BubbleStatusTextBuilder`,
 * Chrome 112); the UI prefixes it as it likes ("Failed – Check internet connection").
 */
export function interruptMessage(reason: DownloadInterruptReason): string {
  switch (reason) {
    case 'network-failed':
    case 'network-timeout':
    case 'network-disconnected':
      return 'Check internet connection'
    case 'network-server-down':
    case 'server-failed':
    case 'server-unreachable':
      return 'Site wasn’t available'
    case 'server-unauthorized':
    case 'server-forbidden':
    case 'server-bad-content':
      return 'File wasn’t available on site'
    case 'server-no-range':
    case 'file-failed':
      return 'Something went wrong'
    case 'file-access-denied':
      return 'Needs permission to download'
    case 'file-no-space':
      return 'Out of storage space'
    case 'file-name-too-long':
      return 'File name or location is too long'
    case 'file-too-large':
      return 'File is too big for this device'
    case 'file-virus-infected':
      return 'Virus detected'
    case 'file-blocked':
      return 'Blocked by your organization'
    case 'file-security-check-failed':
      return 'Virus scan failed'
    case 'file-same-as-source':
      return 'Already downloaded'
    case 'user-canceled':
      return 'Cancelled'
    case 'user-shutdown':
    case 'crash':
      return 'Couldn’t finish download'
  }
}

/**
 * Chrome's defaults: a download animates the toolbar button (`openPanelOnStart` off; the
 * Firefox-style panel-on-start is the switch's other position) and the bubble opens once the
 * last transfer finishes – that bubble is the notice, so no OS notification unless asked for
 * (`notifyOnComplete` off; Edge's position is the switch's other one). `alwaysShowButton` is the
 * desktop toolbar's own key.
 */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  directory: null,
  askWhereToSave: false,
  notifyOnComplete: false,
  openPanelOnStart: false,
  openPanelOnComplete: true,
  autoOpenTypes: [],
  alwaysShowButton: false
}

/**
 * The effective downloads settings, with defaults for anything the profile does not carry.
 * `askWhereToSave` predates the block and lives at `Settings.askWhereToSave`; it is mirrored here
 * so readers see one shape.
 */
export function resolveDownloadSettings(
  settings: Partial<Pick<Settings, 'downloads' | 'askWhereToSave'>> | undefined | null
): DownloadSettings {
  const r = settings?.downloads ?? {}
  const d = DEFAULT_DOWNLOAD_SETTINGS
  return {
    directory: typeof r.directory === 'string' && r.directory !== '' ? r.directory : d.directory,
    askWhereToSave:
      typeof settings?.askWhereToSave === 'boolean' ? settings.askWhereToSave : d.askWhereToSave,
    notifyOnComplete:
      typeof r.notifyOnComplete === 'boolean' ? r.notifyOnComplete : d.notifyOnComplete,
    openPanelOnStart:
      typeof r.openPanelOnStart === 'boolean' ? r.openPanelOnStart : d.openPanelOnStart,
    openPanelOnComplete:
      typeof r.openPanelOnComplete === 'boolean' ? r.openPanelOnComplete : d.openPanelOnComplete,
    autoOpenTypes: Array.isArray(r.autoOpenTypes)
      ? r.autoOpenTypes
          .filter((e): e is string => typeof e === 'string')
          .map(normalizeExtension)
          .filter((e) => e !== '')
      : [...d.autoOpenTypes],
    alwaysShowButton:
      typeof r.alwaysShowButton === 'boolean' ? r.alwaysShowButton : d.alwaysShowButton
  }
}

/** `"  .TAR.GZ "` → `"tar.gz"`, `"exe"` → `"exe"`. */
export function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\.+/, '').toLowerCase()
}

/**
 * Lower-case extension of a file name without the dot (`""` when there is none). Double
 * extensions Chromium treats as one (`tar.gz`, `tar.bz2`, `tar.xz`, `user.js`) come back whole.
 */
export function fileExtension(filename: string): string {
  const name = filename.replace(PARTIAL_SUFFIX, '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  const ext = name.slice(dot + 1)
  const rest = name.slice(0, dot)
  const prevDot = rest.lastIndexOf('.')
  if (prevDot > 0) {
    const double = `${rest.slice(prevDot + 1)}.${ext}`
    if (DOUBLE_EXTENSIONS.has(double)) return double
  }
  return ext
}

const DOUBLE_EXTENSIONS = new Set(['tar.gz', 'tar.bz2', 'tar.xz', 'tar.z', 'tar.lz', 'user.js'])

/** Strip the partial-download suffix (`report.pdf.zeniumdownload` → `report.pdf`). */
export function finalName(partial: string): string {
  return partial.endsWith(PARTIAL_SUFFIX) ? partial.slice(0, -PARTIAL_SUFFIX.length) : partial
}

// ---------------------------------------------------------------------------
// Content-Disposition (RFC 6266), the twin of Kotlin's `DownloadLogic.filenameFor` helpers
// ---------------------------------------------------------------------------

/** The header asks for a download: its disposition type is `attachment` (any case, parameters or not). */
export function isAttachmentDisposition(header: string | null | undefined): boolean {
  if (!header) return false
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'attachment'
}

/** `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf; filename="fallback.pdf"` → `résumé.pdf`. */
export function dispositionFilename(header: string | null | undefined): string | null {
  if (!header || header.trim() === '') return null
  let plain: string | null = null
  for (const raw of splitDispositionParameters(header)) {
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    const key = raw.slice(0, eq).trim().toLowerCase()
    const value = raw.slice(eq + 1).trim()
    if (key === 'filename*') {
      const decoded = decodeExtValue(value)
      if (decoded) return decoded
    } else if (key === 'filename') {
      plain = unquote(value)
    }
  }
  return plain || null
}

/** Split on `;` outside quotes, keeping quoted strings (and their escapes) whole. */
function splitDispositionParameters(header: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < header.length; i++) {
    const c = header[i] as string
    if (c === '"') {
      quoted = !quoted
      current += c
    } else if (c === '\\' && quoted && i + 1 < header.length) {
      current += c + header[i + 1]
      i++
    } else if (c === ';' && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  parts.push(current)
  return parts
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  return value
}

/** RFC 8187 `charset'language'percent-encoded`; UTF-8 (the default) and Latin-1 are understood. */
function decodeExtValue(value: string): string | null {
  const first = value.indexOf("'")
  const second = first >= 0 ? value.indexOf("'", first + 1) : -1
  if (first < 0 || second < 0) return null
  const charset = (value.slice(0, first) || 'UTF-8').toUpperCase()
  const encoded = value.slice(second + 1)
  try {
    if (charset === 'UTF-8' || charset === 'UTF8') return decodeURIComponent(encoded) || null
    if (charset === 'ISO-8859-1' || charset === 'LATIN1' || charset === 'US-ASCII') {
      const decoded = encoded.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      return decoded || null
    }
  } catch {
    // Malformed escapes: the plain `filename` parameter, if any, stands.
  }
  return null
}

/** The last path segment of an http(s) / ftp URL, decoded; null when the path ends in `/`. */
export function urlFilename(url: string): string | null {
  const noQuery = (url.split('#', 1)[0] as string).split('?', 1)[0] as string
  const scheme = noQuery.indexOf('://')
  if (scheme === -1) return null
  const afterScheme = noQuery.slice(scheme + 3)
  const slash = afterScheme.indexOf('/')
  if (slash === -1) return null
  const path = afterScheme.slice(slash + 1)
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (!last) return null
  try {
    return decodeURIComponent(last.replace(/\+/g, '%2B'))
  } catch {
    return last
  }
}

const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])

/**
 * A file name no file system refuses and no path trick escapes with (Kotlin's `sanitizeFilename`):
 * control characters go, separators and the characters Windows forbids become `_`, a leading dot
 * would hide the file, reserved device names get a suffix, and 200 characters is the cap.
 */
export function sanitizeDownloadName(name: string): string {
  let s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
  s = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '')
  if (s === '') return ''
  const dot = s.lastIndexOf('.')
  const stem = dot > 0 ? s.slice(0, dot) : s
  if (RESERVED_DEVICE_NAMES.has(stem.toUpperCase())) s = `${stem}_${s.slice(stem.length)}`
  if (s.length > 200) {
    const ext = shortExtension(s)
    const keep = ext === '' ? 200 : Math.max(1, 200 - ext.length - 1)
    s = s.slice(0, keep).replace(/[. ]+$/, '') + (ext === '' ? '' : `.${ext}`)
  }
  return s
}

/** `report.pdf` → `pdf`; an "extension" over 10 characters or with punctuation is none. */
function shortExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  const ext = name.slice(dot + 1)
  return ext.length <= 10 && /^[\p{L}\p{N}]+$/u.test(ext) ? ext : ''
}

/**
 * The name Chromium gives a response it downloads: the `Content-Disposition` name (RFC 6266,
 * `filename*` first), else the URL's last path segment, sanitised; `download` when there is
 * nothing to go on.
 */
export function filenameForResponse(
  url: string,
  contentDisposition: string | null | undefined
): string {
  const named = sanitizeDownloadName(dispositionFilename(contentDisposition) ?? '')
  if (named) return named
  const fromUrl = /^(https?|ftp):/i.test(url) ? urlFilename(url) : null
  return sanitizeDownloadName(fromUrl ?? '') || 'download'
}

/** `https://cdn.example.com/x/y.zip` → `cdn.example.com`; `data:` / `blob:` say so. */
export function downloadHost(url: string): string {
  if (url.startsWith('data:')) return 'data URL'
  if (url.startsWith('blob:')) {
    const inner = url.slice(5)
    return downloadHost(inner) || 'blob'
  }
  if (url.startsWith('file:')) return 'this device'
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
