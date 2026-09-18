import type { DesktopSiteDefault, PageControlsSettings, PageEnvironment, PageRules } from './types'
import { getDomain } from './url'

export type { PageEnvironment, PageRules } from './types'

/**
 * Page controls: how a site is presented, resolved per URL from the settings. Everything here
 * is pure and shared three ways – the core decides, the Android page script rewrites viewport
 * metas with the same rules, and Kotlin mirrors them (`PageRules.kt`) so a navigation switches
 * the user agent before the request leaves.
 */

export const DEFAULT_PAGE_CONTROLS: PageControlsSettings = {
  desktopSite: 'auto',
  desktopSites: {},
  darkenSites: false,
  darkenSiteExceptions: {},
  zoom: 1,
  zoomIncludesOsFontSize: true,
  siteZooms: {},
  forceZoom: false
}

/**
 * Chrome's preset zoom factors (`blink::kPresetBrowserZoomFactors`), 25 to 500 percent: the
 * ladder the desktop's Ctrl+plus / minus and Ctrl+wheel climb and the default-zoom menulist
 * offers; their ends bound every factor that is stored, whichever host wrote it.
 */
export const ZOOM_PRESETS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5
]
export const ZOOM_FLOOR = ZOOM_PRESETS[0]
export const ZOOM_CEILING = ZOOM_PRESETS[ZOOM_PRESETS.length - 1]
/** The zoom levels the sheet's slider and the minus / plus steps walk (the presets from 50 to 300 percent). */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const ZOOM_MIN = ZOOM_LEVELS[0]
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]

/** The layout width a desktop site is laid out at (Chrome's default viewport for pages without a meta). */
export const DESKTOP_VIEWPORT_WIDTH = 980

export const DEFAULT_PAGE_ENVIRONMENT: PageEnvironment = {
  largeScreen: false,
  pointerAndKeyboard: false,
  fontScale: 1
}

/** What a page gets: the three decisions, plus what the page script needs to rewrite viewports. */
export interface ResolvedPageControls {
  desktop: boolean
  darken: boolean
  /** The effective factor, system font size included; 1 for internal pages. */
  zoom: number
  forceZoom: boolean
}

const DESKTOP_DEFAULTS: DesktopSiteDefault[] = ['auto', 'on', 'off']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function booleanMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (key && typeof value === 'boolean') out[key] = value
  }
  return out
}

function zoomMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = clampZoom(value)
  }
  return out
}

/**
 * Zoom factors are kept to two decimals within Chrome's presets (25 to 500 percent): a factor
 * the desktop stored stays as it is when the same settings are read on a phone, whose own
 * controls only walk the middle of the range.
 */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1
  return Math.min(ZOOM_CEILING, Math.max(ZOOM_FLOOR, Math.round(factor * 100) / 100))
}

/** Stored settings from any version come out complete and well-typed (migrations-safe reading). */
export function sanitizePageControls(
  raw: Partial<PageControlsSettings> | undefined | null
): PageControlsSettings {
  const d = DEFAULT_PAGE_CONTROLS
  const r: Partial<PageControlsSettings> = isRecord(raw) ? raw : {}
  return {
    desktopSite: DESKTOP_DEFAULTS.includes(r.desktopSite as DesktopSiteDefault)
      ? (r.desktopSite as DesktopSiteDefault)
      : d.desktopSite,
    desktopSites: booleanMap(r.desktopSites),
    darkenSites: typeof r.darkenSites === 'boolean' ? r.darkenSites : d.darkenSites,
    darkenSiteExceptions: booleanMap(r.darkenSiteExceptions),
    zoom: typeof r.zoom === 'number' ? clampZoom(r.zoom) : d.zoom,
    zoomIncludesOsFontSize:
      typeof r.zoomIncludesOsFontSize === 'boolean'
        ? r.zoomIncludesOsFontSize
        : d.zoomIncludesOsFontSize,
    siteZooms: zoomMap(r.siteZooms),
    forceZoom: typeof r.forceZoom === 'boolean' ? r.forceZoom : d.forceZoom
  }
}

/** Page controls apply to web pages; internal and blank pages are the chrome's own. */
export function isWebPage(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** The key a site is remembered under (its registrable domain), or null for non-web pages. */
export function siteKey(url: string): string | null {
  if (!isWebPage(url)) return null
  const domain = getDomain(url)
  return domain || null
}

/**
 * Set or clear a per-site value: a value equal to the default is not an exception and drops out
 * of the map, so the per-site lists only ever show real overrides.
 */
export function withSiteOverride<T>(
  map: Record<string, T>,
  domain: string,
  value: T | null,
  defaultValue: T
): Record<string, T> {
  const next = { ...map }
  if (value === null || value === defaultValue) delete next[domain]
  else next[domain] = value
  return next
}

/** The default the `auto` desktop rule resolves to on this device. */
export function desktopByDefault(
  settings: PageControlsSettings,
  env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT
): boolean {
  switch (settings.desktopSite) {
    case 'on':
      return true
    case 'off':
      return false
    default:
      return env.largeScreen || env.pointerAndKeyboard
  }
}

export function resolveDesktop(
  settings: PageControlsSettings,
  url: string,
  env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT
): boolean {
  const key = siteKey(url)
  if (!key) return false
  return settings.desktopSites[key] ?? desktopByDefault(settings, env)
}

/**
 * Whether a site is to be darkened. Darkening is a dark-chrome feature – hosts apply it only
 * while the chrome itself is dark – so this is the policy, not the appearance.
 */
export function resolveDarkening(settings: PageControlsSettings, url: string): boolean {
  const key = siteKey(url)
  if (!key) return false
  return settings.darkenSiteExceptions[key] ?? settings.darkenSites
}

/** The factor stored for a site (its own, or the default) – before the system font size. */
export function siteZoom(settings: PageControlsSettings, url: string): number {
  const key = siteKey(url)
  if (!key) return 1
  return settings.siteZooms[key] ?? settings.zoom
}

/** The factor a page is shown at: the site's zoom times the system font scale when included. */
export function resolveZoom(
  settings: PageControlsSettings,
  url: string,
  env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT
): number {
  if (!isWebPage(url)) return 1
  const scale = settings.zoomIncludesOsFontSize ? env.fontScale || 1 : 1
  return Math.round(siteZoom(settings, url) * scale * 1000) / 1000
}

export function resolvePageControls(
  settings: PageControlsSettings,
  url: string,
  env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT
): ResolvedPageControls {
  return {
    desktop: resolveDesktop(settings, url, env),
    darken: resolveDarkening(settings, url),
    zoom: resolveZoom(settings, url, env),
    forceZoom: settings.forceZoom
  }
}

/**
 * The policy in the shape hosts keep (`PageRules`): every default resolved for this device, the
 * exceptions as they are stored. `zoom.sites` stay exact factors; hosts multiply `scale` in.
 */
export function pageRulesFor(
  settings: PageControlsSettings,
  env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT
): PageRules {
  return {
    desktop: { default: desktopByDefault(settings, env), sites: { ...settings.desktopSites } },
    darken: { default: settings.darkenSites, sites: { ...settings.darkenSiteExceptions } },
    zoom: {
      default: settings.zoom,
      sites: { ...settings.siteZooms },
      scale: settings.zoomIncludesOsFontSize ? env.fontScale || 1 : 1
    },
    forceZoom: settings.forceZoom
  }
}

/**
 * How a host looks a site up in the rules: the URL's host matched by suffix against the stored
 * registrable domains (`www.example.co.uk` is on the site `example.co.uk`). Kotlin mirrors this
 * in `PageRules.kt`; keeping the lookup this simple is what makes the mirror safe.
 */
export function siteValue<T>(sites: Record<string, T>, url: string): T | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (!host) return undefined
  let best: T | undefined
  let bestLength = -1
  for (const [domain, value] of Object.entries(sites)) {
    if ((host === domain || host.endsWith(`.${domain}`)) && domain.length > bestLength) {
      best = value
      bestLength = domain.length
    }
  }
  return best
}

/**
 * The next zoom level up (`direction` > 0) or down from `current`, along `levels` (the sheet's
 * `ZOOM_LEVELS` unless a host walks Chrome's full `ZOOM_PRESETS`): a factor between two levels
 * moves to the neighbouring one in that direction, the ends are sticky.
 */
export function stepZoom(
  current: number,
  direction: number,
  levels: readonly number[] = ZOOM_LEVELS
): number {
  const idx = levels.findIndex((l) => Math.abs(l - current) < 0.005)
  if (idx !== -1) {
    return levels[Math.min(levels.length - 1, Math.max(0, idx + Math.sign(direction)))]
  }
  if (direction > 0) return levels.find((l) => l > current) ?? levels[levels.length - 1]
  return [...levels].reverse().find((l) => l < current) ?? levels[0]
}

/** The slider position (index into `ZOOM_LEVELS`) nearest to `factor`. */
export function zoomLevelIndex(factor: number): number {
  let best = 0
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if (Math.abs(ZOOM_LEVELS[i] - factor) < Math.abs(ZOOM_LEVELS[best] - factor)) best = i
  }
  return best
}

export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`
}

/** A factor as a menulist key: "110" for 110 percent. */
export function zoomKey(factor: number): string {
  return String(Math.round(factor * 100))
}

/**
 * The preset ladder as menulist choices (Settings > Appearance > Page zoom); a stored factor off
 * the ladder is listed in its place so the menulist can show it.
 */
export function zoomChoices(current: number): Array<{ value: string; label: string }> {
  const factors = ZOOM_PRESETS.some((p) => Math.abs(p - current) < 0.005)
    ? ZOOM_PRESETS
    : [...ZOOM_PRESETS, current].sort((a, b) => a - b)
  return factors.map((f) => ({ value: zoomKey(f), label: formatZoom(f) }))
}

// ---------------------------------------------------------------------------
// Viewport meta rewrite (the page script's layout zoom, desktop layout and force-zoom)
// ---------------------------------------------------------------------------

export interface ViewportRewriteOptions {
  /** The effective zoom factor for this page. */
  zoom: number
  /** Lay the page out at the desktop width whatever its own meta says. */
  desktop: boolean
  /** Keep pinch zoom available whatever the page asked for. */
  forceZoom: boolean
  /** Width of the view in CSS px at scale 1 (`device-width`); 0 when unknown. */
  deviceWidth: number
}

/** Chromium's scale limits: the page cannot ask for less than 0.25 or more than 10. */
const SCALE_MIN = 0.25
const SCALE_MAX = 10

export function parseViewport(content: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of content.split(/[,;]/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
    if (key) out.set(key, value)
  }
  return out
}

export function serializeViewport(entries: Map<string, string>): string {
  return [...entries].map(([k, v]) => `${k}=${v}`).join(', ')
}

function scaleValue(value: string | undefined, zoom: number): string | undefined {
  if (value === undefined) return undefined
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return value
  return String(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n * zoom * 1000) / 1000)))
}

function round(n: number): number {
  return Math.max(1, Math.round(n))
}

/**
 * The viewport meta content a page should have under the given controls, or null when it can
 * stay as it is. Layout zoom is a real reflow: the layout viewport is narrowed by the zoom
 * factor (`device-width` → `width / zoom`) so the page lays out as on a smaller screen and is
 * shown scaled up to fill the view – text, images and media queries all follow, the way
 * Chrome's page zoom does. Every scale the page specified is multiplied by the zoom so its own
 * limits keep their meaning. A page with a scale but no width lays out at `device-width /
 * initial-scale` in Blink (its width resolves to extend-to-zoom), so scaling its scales is the
 * whole rewrite there – a width added beside them would become the layout width and overflow
 * the view; only a page with neither gets Chrome's 980 px desktop width as base. Desktop mode
 * ignores the page's width and scales entirely and asks for the desktop width (the view's own
 * where that is wider); force-zoom drops `user-scalable=no` and the maximum scale.
 */
export function rewriteViewport(
  content: string | null,
  options: ViewportRewriteOptions
): string | null {
  const zoom = options.zoom > 0 && Number.isFinite(options.zoom) ? options.zoom : 1
  const original = parseViewport(content ?? '')
  const next = new Map(original)

  if (options.desktop) {
    next.clear()
    next.set('width', String(round(Math.max(DESKTOP_VIEWPORT_WIDTH, options.deviceWidth) / zoom)))
  } else if (zoom !== 1) {
    const width = original.get('width')?.toLowerCase()
    if (width === 'device-width') {
      if (options.deviceWidth > 0) next.set('width', String(round(options.deviceWidth / zoom)))
      else next.delete('width')
    } else if (width !== undefined && /^\d+(\.\d+)?$/.test(width)) {
      next.set('width', String(round(parseFloat(width) / zoom)))
    } else if (!original.has('initial-scale')) {
      next.set('width', String(round(DESKTOP_VIEWPORT_WIDTH / zoom)))
    }
    next.delete('height')
    for (const key of ['initial-scale', 'minimum-scale', 'maximum-scale']) {
      const scaled = scaleValue(original.get(key), zoom)
      if (scaled !== undefined) next.set(key, scaled)
    }
    // A width alone makes the initial scale fit it – exactly the zoom – unless the page pinned
    // its scale, in which case the pinned value has been multiplied above.
    if (!original.has('initial-scale') && width === 'device-width' && options.deviceWidth <= 0) {
      next.set('initial-scale', String(Math.round(zoom * 1000) / 1000))
    }
  }

  if (options.forceZoom || options.desktop) {
    next.delete('user-scalable')
    next.delete('maximum-scale')
    if (options.forceZoom) {
      const min = next.get('minimum-scale')
      // A page that pinned its minimum above 1 was only doing so to lock the scale.
      if (min !== undefined && parseFloat(min) > 1 && !options.desktop) next.delete('minimum-scale')
    }
  }

  if (next.size === 0 && original.size === 0) return null
  const result = serializeViewport(next)
  return result === serializeViewport(original) ? null : result
}

/** Whether a page without any viewport meta needs one under these controls. */
export function needsViewportMeta(options: ViewportRewriteOptions): boolean {
  return options.desktop || options.zoom !== 1
}
