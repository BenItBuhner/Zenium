/**
 * The phone's new tab page: defaults, the sanitiser for persisted / client-supplied settings,
 * and the pure preset logic that turns the settings into the sections the page renders.
 */
import type {
  NewTabModules,
  NewTabPinnedSite,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcutStyle,
  NewTabWallpaper
} from './types'

/** Zen-quiet by default: the search field and the tiles on the bare space gradient. */
export const DEFAULT_NEW_TAB_SETTINGS: NewTabSettings = {
  preset: 'focused',
  modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false },
  shortcutStyle: 'most-visited',
  wallpaper: 'space',
  pinned: [],
  hiddenHosts: []
}

/** Most tiles the page shows: two rows of four. */
export const MAX_TOP_SITES = 8
const MAX_PINNED = MAX_TOP_SITES
const MAX_HIDDEN_HOSTS = 500

export const NEW_TAB_PRESETS: readonly NewTabPreset[] = [
  'focused',
  'inspirational',
  'informational',
  'custom'
]

/** No feed core exists yet; the preset that needs one is offered as "not available". */
export const FEED_AVAILABLE = false

/**
 * Voice and visual search are later workers' rows. The search field shows their buttons only
 * once something handles the `zen-voice-search` / `zen-visual-search` events they dispatch, so
 * no control that does nothing ships in the meantime.
 */
export const VOICE_SEARCH_AVAILABLE = false
export const VISUAL_SEARCH_AVAILABLE = false

/** What the page draws. Same shape as the modules: a preset is a fixed set of them. */
export type NewTabSections = NewTabModules

function isPreset(value: unknown): value is NewTabPreset {
  return typeof value === 'string' && (NEW_TAB_PRESETS as readonly string[]).includes(value)
}

function isShortcutStyle(value: unknown): value is NewTabShortcutStyle {
  return value === 'most-visited' || value === 'my-shortcuts'
}

function isWallpaper(value: unknown): value is NewTabWallpaper {
  return value === 'space' || value === 'image'
}

function sanitizePinned(raw: unknown): NewTabPinnedSite[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: NewTabPinnedSite[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { url, title } = item as Partial<NewTabPinnedSite>
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ url, title: typeof title === 'string' ? title : '' })
    if (out.length >= MAX_PINNED) break
  }
  return out
}

function sanitizeHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const hosts = raw
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(hosts)].slice(0, MAX_HIDDEN_HOSTS)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Fill in missing fields and drop values that are not ours. */
export function sanitizeNewTabSettings(
  raw: Partial<NewTabSettings> | undefined | null
): NewTabSettings {
  const d = DEFAULT_NEW_TAB_SETTINGS
  const r = raw ?? {}
  const m = (r.modules && typeof r.modules === 'object' ? r.modules : {}) as Partial<NewTabModules>
  return {
    preset: isPreset(r.preset) ? r.preset : d.preset,
    modules: {
      searchBox: bool(m.searchBox, d.modules.searchBox),
      shortcuts: bool(m.shortcuts, d.modules.shortcuts),
      wallpaper: bool(m.wallpaper, d.modules.wallpaper),
      feed: bool(m.feed, d.modules.feed)
    },
    shortcutStyle: isShortcutStyle(r.shortcutStyle) ? r.shortcutStyle : d.shortcutStyle,
    wallpaper: isWallpaper(r.wallpaper) ? r.wallpaper : d.wallpaper,
    pinned: sanitizePinned(r.pinned),
    hiddenHosts: sanitizeHosts(r.hiddenHosts)
  }
}

/** The fixed sections of the named presets (`custom` reads the toggles instead). */
const PRESET_SECTIONS: Record<Exclude<NewTabPreset, 'custom'>, NewTabSections> = {
  focused: { searchBox: true, shortcuts: true, wallpaper: false, feed: false },
  inspirational: { searchBox: true, shortcuts: true, wallpaper: true, feed: false },
  informational: { searchBox: true, shortcuts: true, wallpaper: true, feed: true }
}

/**
 * The sections a preset stands for. The named presets are fixed so that picking one always
 * gives the same page; the feed is only ever drawn once a feed core exists, whatever the
 * preset or the toggles say.
 */
export function newTabSections(settings: NewTabSettings): NewTabSections {
  const sections =
    settings.preset === 'custom' ? settings.modules : PRESET_SECTIONS[settings.preset]
  return { ...sections, feed: sections.feed && FEED_AVAILABLE }
}

/**
 * Toggling a section while a named preset is on moves to `custom`, seeded with what that preset
 * showed, so the page only changes in the one thing that was toggled.
 */
export function toggleNewTabModule(
  settings: NewTabSettings,
  module: keyof NewTabModules,
  enabled: boolean
): NewTabSettings {
  const modules: NewTabModules = { ...newTabSections(settings), [module]: enabled }
  return { ...settings, preset: 'custom', modules }
}

/**
 * Picking a preset: the named ones simply apply; `custom` starts from the sections of the preset
 * the user is leaving, so the switch itself changes nothing on the page.
 */
export function pickNewTabPreset(settings: NewTabSettings, preset: NewTabPreset): NewTabSettings {
  if (preset === 'custom' && settings.preset !== 'custom') {
    return { ...settings, preset, modules: newTabSections(settings) }
  }
  return { ...settings, preset }
}

/** Presets the customise sheet lets the user pick; the feed preset waits for a feed core. */
export function presetAvailable(preset: NewTabPreset): boolean {
  return preset !== 'informational' || FEED_AVAILABLE
}

/** Host of a URL without `www.`, lower-cased; empty for URLs that have none. */
export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function pinSite(settings: NewTabSettings, site: NewTabPinnedSite): NewTabSettings {
  if (settings.pinned.some((p) => p.url === site.url)) return settings
  const host = siteHost(site.url)
  return {
    ...settings,
    pinned: [...settings.pinned, site].slice(0, MAX_PINNED),
    // Pinning a site the user had removed brings its host back.
    hiddenHosts: settings.hiddenHosts.filter((h) => h !== host)
  }
}

export function unpinSite(settings: NewTabSettings, url: string): NewTabSettings {
  return { ...settings, pinned: settings.pinned.filter((p) => p.url !== url) }
}

/** Remove a tile: its pin goes and its host stays out of the most-visited tiles. */
export function removeSite(settings: NewTabSettings, url: string): NewTabSettings {
  const host = siteHost(url)
  return {
    ...settings,
    pinned: settings.pinned.filter((p) => p.url !== url),
    hiddenHosts:
      host && !settings.hiddenHosts.includes(host)
        ? [...settings.hiddenHosts, host].slice(-MAX_HIDDEN_HOSTS)
        : settings.hiddenHosts
  }
}
