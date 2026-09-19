/**
 * Web app manifests: the metadata a page declares through `<link rel="manifest">`, the pure
 * decisions the browser makes from it (which icon to pin, whether a URL is inside the app's
 * scope, when the ambient "Add to Home screen" prompt is due), and the records the core keeps
 * about pinned apps. Everything here is JSON-serialisable and free of DOM / host dependencies so
 * the page script, the core and the chrome can share it.
 */
import { cssColorToHex, hexToRgb, isDarkColor } from './theme'
import type { Rect } from './types'

export type WebAppIconPurpose = 'any' | 'maskable' | 'monochrome'

export type WebAppDisplay = 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser'

export interface WebAppIcon {
  /** Absolute URL (resolved against the manifest). */
  src: string
  /** The manifest's `sizes` token list, e.g. `"192x192 512x512"` or `"any"`. */
  sizes: string
  type: string | null
  /** Parsed `purpose` tokens; an icon without one is `['any']`. */
  purpose: WebAppIconPurpose[]
}

export interface WebAppScreenshot {
  src: string
  sizes: string | null
  type: string | null
  formFactor: 'narrow' | 'wide' | null
  label: string | null
}

/** What the browser keeps about a page's web app manifest (`tab.webApp`). */
export interface WebAppInfo {
  manifestUrl: string
  /**
   * Identity of the app: the manifest's `id` resolved against the start URL's origin, or the
   * start URL itself when the manifest has none (the W3C default).
   */
  id: string
  name: string
  shortName: string | null
  description: string | null
  startUrl: string
  /** Absolute scope URL; the app's pages are those whose URL starts with it. */
  scope: string
  display: WebAppDisplay
  themeColor: string | null
  backgroundColor: string | null
  icons: WebAppIcon[]
  screenshots: WebAppScreenshot[]
}

/** The fields the page script lifts out of a manifest before posting it (raw, unresolved). */
export interface RawWebAppManifest {
  id?: unknown
  name?: unknown
  short_name?: unknown
  description?: unknown
  start_url?: unknown
  scope?: unknown
  display?: unknown
  theme_color?: unknown
  background_color?: unknown
  icons?: unknown
  screenshots?: unknown
}

/**
 * An installed app: a shortcut the user put on the Home screen or, on desktop, a launcher that
 * opens the app in a window of its own (the registry behind "Open <app>" and `--app=`).
 */
export interface PinnedWebApp {
  id: string
  name: string
  startUrl: string
  scope: string
  pinnedAt: number
  /**
   * The app's icon as the host kept it (a `file:` or data URL), for the app window's frame and
   * the installed-apps list; hosts whose launcher owns the tile (Android) leave it out.
   */
  icon?: string | null
  /** Where the app's window last stood (desktop); the next launch opens it there. */
  bounds?: Rect | null
}

/** How often and when a user came back to an app – the input to the ambient prompt. */
export interface EngagementRecord {
  /** Distinct visits (at least `MIN_VISIT_GAP_MS` apart). */
  visits: number
  firstVisitAt: number
  lastVisitAt: number
  /** The user swiped the ambient prompt away (starts the cooldown). */
  dismissedAt: number | null
  /** The ambient prompt was last shown. */
  promptedAt: number | null
}

export const MANIFEST_FIELDS: Array<keyof RawWebAppManifest> = [
  'id',
  'name',
  'short_name',
  'description',
  'start_url',
  'scope',
  'display',
  'theme_color',
  'background_color',
  'icons',
  'screenshots'
]

const MAX_ICONS = 32
const MAX_SCREENSHOTS = 8
const MAX_TEXT = 512
const DISPLAY_MODES: WebAppDisplay[] = ['fullscreen', 'standalone', 'minimal-ui', 'browser']
const PURPOSES: WebAppIconPurpose[] = ['any', 'maskable', 'monochrome']

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function resolveUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim(), base)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.href
  } catch {
    return null
  }
}

/** The origin of an http(s) URL; null for anything else (an opaque origin is no app's). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

function parsePurpose(value: unknown): WebAppIconPurpose[] {
  if (typeof value !== 'string') return ['any']
  const tokens = value
    .toLowerCase()
    .split(/\s+/)
    .filter((t): t is WebAppIconPurpose => (PURPOSES as string[]).includes(t))
  return tokens.length ? [...new Set(tokens)] : ['any']
}

function parseIcons(value: unknown, base: string): WebAppIcon[] {
  if (!Array.isArray(value)) return []
  const icons: WebAppIcon[] = []
  for (const entry of value) {
    if (icons.length >= MAX_ICONS) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const src = resolveUrl(e.src, base)
    if (!src) continue
    icons.push({
      src,
      sizes: text(e.sizes, 128)?.toLowerCase() ?? '',
      type: text(e.type, 64)?.toLowerCase() ?? null,
      purpose: parsePurpose(e.purpose)
    })
  }
  return icons
}

function parseScreenshots(value: unknown, base: string): WebAppScreenshot[] {
  if (!Array.isArray(value)) return []
  const shots: WebAppScreenshot[] = []
  for (const entry of value) {
    if (shots.length >= MAX_SCREENSHOTS) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const src = resolveUrl(e.src, base)
    if (!src) continue
    const formFactor = text(e.form_factor, 16)?.toLowerCase()
    shots.push({
      src,
      sizes: text(e.sizes, 128)?.toLowerCase() ?? null,
      type: text(e.type, 64)?.toLowerCase() ?? null,
      formFactor: formFactor === 'narrow' || formFactor === 'wide' ? formFactor : null,
      label: text(e.label, 200)
    })
  }
  return shots
}

/** CSS colours are passed through as written but capped; the chrome only paints with them. */
function color(value: unknown): string | null {
  const t = text(value, 64)
  return t && /^[#a-zA-Z0-9(),.%\s-]+$/.test(t) ? t : null
}

/**
 * Turn a fetched manifest into the browser's view of the app, following the W3C processing
 * rules that matter for installation: URLs resolve against the manifest, the start URL must be
 * same-origin with the document, the scope defaults to the start URL's directory and the
 * start URL must be within it. Returns null when the manifest does not describe an app that
 * could be installed from `documentUrl`.
 */
export function parseWebAppManifest(
  raw: unknown,
  manifestUrl: string,
  documentUrl: string
): WebAppInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as RawWebAppManifest
  const documentOrigin = originOf(documentUrl)
  if (!documentOrigin) return null
  const manifestBase = resolveUrl(manifestUrl, documentUrl)
  if (!manifestBase) return null

  const startUrl = resolveUrl(m.start_url, manifestBase) ?? documentUrl
  if (originOf(startUrl) !== documentOrigin) return null

  let scope = resolveUrl(m.scope, manifestBase)
  if (!scope || originOf(scope) !== documentOrigin) scope = defaultScope(startUrl)
  scope = stripQueryAndFragment(scope)
  if (!isWithinScope(startUrl, scope)) scope = defaultScope(startUrl)

  const name = text(m.name, 200) ?? text(m.short_name, 200)
  if (!name) return null
  const shortName = text(m.short_name, 60)
  const displayRaw = text(m.display, 16)?.toLowerCase()
  const display = (DISPLAY_MODES as string[]).includes(displayRaw ?? '')
    ? (displayRaw as WebAppDisplay)
    : 'browser'

  const idRaw = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : null
  let id = startUrl
  if (idRaw) {
    try {
      const resolved = new URL(idRaw, documentOrigin + '/')
      if (resolved.origin === documentOrigin) id = resolved.href
    } catch {
      /* keep the start URL */
    }
  }

  return {
    manifestUrl: manifestBase,
    id,
    name,
    shortName: shortName && shortName !== name ? shortName : null,
    description: text(m.description, 400),
    startUrl,
    scope,
    display,
    themeColor: color(m.theme_color),
    backgroundColor: color(m.background_color),
    icons: parseIcons(m.icons, manifestBase),
    screenshots: parseScreenshots(m.screenshots, manifestBase)
  }
}

/** The directory of a URL with query and fragment removed (the manifest's default scope). */
export function defaultScope(startUrl: string): string {
  const u = new URL(startUrl)
  u.search = ''
  u.hash = ''
  u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/'
  return u.href
}

function stripQueryAndFragment(url: string): string {
  const u = new URL(url)
  u.search = ''
  u.hash = ''
  return u.href
}

// ---------------------------------------------------------------------------
// Scope (PWA-11 "Open <app>" awareness)
// ---------------------------------------------------------------------------

/** True when `url` is one of the app's pages: same origin and its path starts with the scope's. */
export function isWithinScope(url: string, scope: string): boolean {
  try {
    const u = new URL(url)
    const s = new URL(scope)
    if (u.origin !== s.origin) return false
    return u.pathname.startsWith(s.pathname)
  } catch {
    return false
  }
}

/** The pinned app whose scope contains `url`; the most specific (longest) scope wins. */
export function pinnedAppFor(url: string, pinned: PinnedWebApp[]): PinnedWebApp | null {
  let best: PinnedWebApp | null = null
  for (const app of pinned) {
    if (!isWithinScope(url, app.scope)) continue
    if (!best || app.scope.length > best.scope.length) best = app
  }
  return best
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** Launcher icons: Android wants 192 px or more; bigger than 1024 is only bytes. */
export const SHORTCUT_ICON_TARGET = 192

/** Largest dimension the `sizes` token list declares (Infinity for `any`, 0 when unknown). */
export function iconSize(icon: Pick<WebAppIcon, 'sizes'>): number {
  let max = 0
  for (const token of icon.sizes.split(/\s+/)) {
    if (!token) continue
    if (token === 'any') return Infinity
    const m = /^(\d+)x(\d+)$/i.exec(token)
    if (m) max = Math.max(max, Number(m[1]), Number(m[2]))
  }
  return max
}

/** Android's `BitmapFactory` cannot decode SVG, so vector icons never reach the launcher. */
export function isVectorIcon(icon: Pick<WebAppIcon, 'src' | 'type'>): boolean {
  if (icon.type && icon.type.includes('svg')) return true
  try {
    return new URL(icon.src).pathname.toLowerCase().endsWith('.svg')
  } catch {
    return false
  }
}

/**
 * The icon to draw for `purpose`: the smallest raster icon at or above `target`, else the
 * largest one below it. Vector icons are skipped unless `allowVector`.
 */
export function pickIcon(
  icons: WebAppIcon[],
  purpose: WebAppIconPurpose,
  options: { target?: number; allowVector?: boolean } = {}
): WebAppIcon | null {
  const target = options.target ?? SHORTCUT_ICON_TARGET
  const candidates = icons.filter(
    (icon) => icon.purpose.includes(purpose) && (options.allowVector || !isVectorIcon(icon))
  )
  if (!candidates.length) return null
  const sized = candidates.map((icon) => ({ icon, size: iconSize(icon) }))
  const atLeast = sized
    .filter((s) => s.size >= target && s.size !== Infinity)
    .sort((a, b) => a.size - b.size)
  if (atLeast.length) return atLeast[0].icon
  const any = sized.find((s) => s.size === Infinity)
  if (any) return any.icon
  return sized.sort((a, b) => b.size - a.size)[0].icon
}

export type ShortcutIconKind = 'maskable' | 'any' | 'monochrome'

/**
 * What the launcher tile should be built from: a maskable icon becomes the adaptive icon as
 * is, an `any` icon is inset on a background, a monochrome glyph is tinted on the theme colour,
 * and with none of them the host draws a letter tile.
 */
export function shortcutIcon(
  info: Pick<WebAppInfo, 'icons'>
): { url: string; kind: ShortcutIconKind } | null {
  const maskable = pickIcon(info.icons, 'maskable')
  if (maskable) return { url: maskable.src, kind: 'maskable' }
  const any = pickIcon(info.icons, 'any')
  if (any) return { url: any.src, kind: 'any' }
  const mono = pickIcon(info.icons, 'monochrome')
  if (mono) return { url: mono.src, kind: 'monochrome' }
  return null
}

/** The icon the chrome shows in its sheets (vectors are fine there). */
export function displayIcon(info: Pick<WebAppInfo, 'icons'>): string | null {
  return (
    pickIcon(info.icons, 'any', { allowVector: true })?.src ??
    pickIcon(info.icons, 'maskable', { allowVector: true })?.src ??
    null
  )
}

/**
 * Whether the manifest describes something worth offering as an app: a name, an installable
 * icon, a start URL in a secure context and a display mode that asks for its own window (the
 * same bar Chromium sets for its install prompt).
 */
export function isInstallable(info: WebAppInfo): boolean {
  if (!isSecureContextUrl(info.startUrl)) return false
  if (!shortcutIcon(info)) return false
  return info.display !== 'browser'
}

/**
 * A potentially trustworthy URL (W3C Secure Contexts): https, or plain http on a loopback host –
 * `localhost`, its subdomains, `127.0.0.0/8` and `[::1]` – which is what Chromium installs from
 * too, so an app under development on its own machine gets the same prompt as its deployment.
 */
export function isSecureContextUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  const host = u.hostname
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

// ---------------------------------------------------------------------------
// Engagement (PWA-03 ambient prompt)
// ---------------------------------------------------------------------------

/** Two page loads closer together than this are the same visit. */
export const MIN_VISIT_GAP_MS = 5 * 60 * 1000
/** Visits before the ambient prompt is offered (Chromium's historic "twice, five minutes apart"). */
export const PROMPT_AFTER_VISITS = 2
/** Swiping the prompt away silences it for this long. */
export const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000
/** Ignoring the prompt (letting it time out) keeps it away for a day. */
export const PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * The ambient banner leaves on its own after this long (an ignored prompt is not a dismissal).
 * The core's clock and the chrome's banner card both run on it.
 */
export const BANNER_TIMEOUT_MS = 12_000

/** Count a page load as a visit when it is far enough from the previous one. */
export function recordVisit(record: EngagementRecord | undefined, now: number): EngagementRecord {
  if (!record) {
    return { visits: 1, firstVisitAt: now, lastVisitAt: now, dismissedAt: null, promptedAt: null }
  }
  if (now - record.lastVisitAt < MIN_VISIT_GAP_MS) return record
  return { ...record, visits: record.visits + 1, lastVisitAt: now }
}

/** Whether the ambient prompt is due for an app with this history. */
export function shouldPrompt(record: EngagementRecord | undefined, now: number): boolean {
  if (!record || record.visits < PROMPT_AFTER_VISITS) return false
  if (record.dismissedAt !== null && now - record.dismissedAt < DISMISS_COOLDOWN_MS) return false
  if (record.promptedAt !== null && now - record.promptedAt < PROMPT_INTERVAL_MS) return false
  return true
}

export function markPrompted(record: EngagementRecord, now: number): EngagementRecord {
  return { ...record, promptedAt: now }
}

export function markDismissed(record: EngagementRecord, now: number): EngagementRecord {
  return { ...record, dismissedAt: now, promptedAt: now }
}

/** The name the launcher shows: the short name when there is one (tiles truncate long names). */
export function launcherName(info: Pick<WebAppInfo, 'name' | 'shortName'>): string {
  return info.shortName ?? info.name
}

/**
 * Where an installed app lands: a tile on the phone's Home screen (`homeScreen`), or – on hosts
 * with windows – a launcher on the desktop / in the Start menu / Applications that opens the app
 * in a window of its own (`desktop`, Chrome's installed apps). The copy below follows it, so the
 * phone keeps saying "Home screen" and the desktop speaks of installing, as Chrome does.
 */
export type InstallSurface = 'homeScreen' | 'desktop'

/** The app menu item that installs: Chrome's "Install <app>…" / "Create shortcut…" on desktop. */
export function installMenuLabel(surface: InstallSurface, info: WebAppInfo | null): string {
  if (surface === 'homeScreen') return 'Add to Home Screen'
  return info && isInstallable(info) ? `Install ${launcherName(info)}…` : 'Create shortcut…'
}

/** The app menu item inside an installed app's scope ("Open in <app>" launches its window). */
export function openAppMenuLabel(surface: InstallSurface, name: string): string {
  return surface === 'desktop' ? `Open in ${name}` : `Open ${name}`
}

/** The install sheet's title and primary button. */
export function installSheetCopy(
  surface: InstallSurface,
  info: WebAppInfo | null
): { title: string; action: string } {
  if (surface === 'homeScreen') return { title: 'Add to Home screen', action: 'Add' }
  return info && isInstallable(info)
    ? { title: 'Install app', action: 'Install' }
    : { title: 'Create shortcut', action: 'Create' }
}

/** The confirmation after the launcher took the app ("Added <app> to Home screen"). */
export function installedMessage(surface: InstallSurface, name: string): string {
  return surface === 'desktop' ? `Installed ${name}` : `Added ${name} to Home screen`
}

/** The error when the host could not create the launcher. */
export function installFailedMessage(surface: InstallSurface): string {
  return surface === 'desktop' ? "Couldn't install the app" : "Couldn't add to Home screen"
}

/** Title for a shortcut to a page without a manifest: the page title, else its host. */
export function fallbackShortcutTitle(title: string, url: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  if (t) return t.slice(0, 60)
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Shortcut'
  }
}

// ---------------------------------------------------------------------------
// Letter tile – the chrome's preview (`AppIcon`) and the launcher tile (`ShortcutTile.kt`) are
// drawn by the same three rules, so what the sheet shows is what lands on the Home screen.
// ---------------------------------------------------------------------------

/**
 * The colour a tile is painted as `#rrggbb`: the manifest's theme colour when it is one both
 * sides can paint (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`), else `fallback` (the
 * space accent). The core hands this one value to the sheet, the banner and the pin request.
 */
export function tileColor(themeColor: string | null, fallback: string): string {
  if (!themeColor) return fallback
  const t = themeColor.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(t)?.[1]
  if (hex) {
    const six = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6)
    return `#${six.toLowerCase()}`
  }
  return cssColorToHex(t)?.slice(0, 7) ?? fallback
}

/**
 * Ink for the letter on a tile of `color`: white on a dark tile, near-black (the v2 text
 * colour) on a light one, by WCAG relative luminance – `ShortcutTile.onColor` paints the same.
 */
export function tileInk(color: string): string {
  const rgb = hexToRgb(color)
  return !rgb || isDarkColor(rgb) ? '#ffffff' : '#15141a'
}

/**
 * The letter a tile shows: the title's first letter or digit as one code point (an emoji or a
 * symbol is never split), upper-cased; a leading symbol is skipped, a symbol-only title keeps
 * its first symbol whole, an empty one shows "?" – `ShortcutTile.letterFor`, in TypeScript.
 */
export function tileLetter(title: string): string {
  const trimmed = title.trim()
  for (const ch of trimmed) if (/[\p{L}\p{Nd}]/u.test(ch)) return ch.toUpperCase()
  return trimmed ? [...trimmed][0] : '?'
}
