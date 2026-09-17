/**
 * Download helpers shared by the browser core, the hosts and the renderer: the settings block
 * with its defaults (profiles from before it existed carry none), file-name utilities and the
 * suffix in-flight files are written under.
 */
import type { DownloadSettings, Settings } from './types'

/** In-progress and quarantined files end in this (Chrome: `.crdownload`, Firefox: `.part`). */
export const PARTIAL_SUFFIX = '.zeniumdownload'

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  location: '',
  autoOpen: [],
  showNotifications: true,
  openPanelOnStart: false
}

/** The effective downloads settings, with defaults for anything the profile does not carry. */
export function resolveDownloadSettings(
  settings: Pick<Settings, 'downloads'> | undefined | null
): DownloadSettings {
  const r = settings?.downloads ?? {}
  const d = DEFAULT_DOWNLOAD_SETTINGS
  return {
    location: typeof r.location === 'string' ? r.location : d.location,
    autoOpen: Array.isArray(r.autoOpen)
      ? r.autoOpen.filter((e): e is string => typeof e === 'string').map(normalizeExtension)
      : [...d.autoOpen],
    showNotifications:
      typeof r.showNotifications === 'boolean' ? r.showNotifications : d.showNotifications,
    openPanelOnStart:
      typeof r.openPanelOnStart === 'boolean' ? r.openPanelOnStart : d.openPanelOnStart
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
