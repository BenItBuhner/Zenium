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
 * Chromium's `net::` error names onto the interrupt reasons, as `ConvertNetErrorToInterruptReason`
 * reads them; everything else the network stack reports (`ERR_CONNECTION_RESET`,
 * `ERR_EMPTY_RESPONSE`, a closed connection short of the announced length) is a plain network
 * failure, and file-system errors without a closer reason fail as `file-failed`.
 */
const NET_ERRORS: Readonly<Record<string, DownloadInterruptReason>> = {
  ERR_TIMED_OUT: 'network-timeout',
  ERR_CONNECTION_TIMED_OUT: 'network-timeout',
  ERR_INTERNET_DISCONNECTED: 'network-disconnected',
  ERR_NETWORK_CHANGED: 'network-disconnected',
  ERR_NETWORK_IO_SUSPENDED: 'network-disconnected',
  ERR_CONNECTION_REFUSED: 'network-server-down',
  ERR_NAME_NOT_RESOLVED: 'server-unreachable',
  ERR_ADDRESS_UNREACHABLE: 'server-unreachable',
  ERR_PROXY_CONNECTION_FAILED: 'server-unreachable',
  ERR_HTTP_RESPONSE_CODE_FAILURE: 'server-failed',
  ERR_INVALID_RESPONSE: 'server-bad-content',
  ERR_INVALID_URL: 'server-bad-content',
  ERR_UNSAFE_REDIRECT: 'server-failed',
  ERR_UNSAFE_PORT: 'server-failed',
  ERR_ACCESS_DENIED: 'file-access-denied',
  ERR_FILE_NO_SPACE: 'file-no-space',
  ERR_FILE_PATH_TOO_LONG: 'file-name-too-long',
  ERR_FILE_TOO_BIG: 'file-too-large',
  ERR_FILE_VIRUS_INFECTED: 'file-virus-infected',
  ERR_BLOCKED_BY_CLIENT: 'file-blocked',
  ERR_BLOCKED_BY_ADMINISTRATOR: 'file-blocked',
  ERR_FILE_NOT_FOUND: 'file-failed',
  ERR_FILE_EXISTS: 'file-failed',
  ERR_ABORTED: 'user-canceled'
}

/**
 * The reason behind a Chromium `net::` error name (`net::ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`),
 * as the Electron host sees them on `webRequest.onErrorOccurred`; certificate errors read as
 * the site not being available, anything unknown as a network failure.
 */
export function interruptReasonFromNetError(error: string): DownloadInterruptReason {
  const name = error.trim().replace(/^net::/, '')
  const known = NET_ERRORS[name]
  if (known) return known
  if (/^ERR_(CERT_|SSL_)/.test(name)) return 'server-failed'
  if (/^ERR_FILE_/.test(name)) return 'file-failed'
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
