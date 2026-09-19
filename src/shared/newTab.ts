/**
 * The new tab page's one model, for the desktop page (`zen://newtab`) and the phone's page alike:
 * the synced preferences (`Settings.newTab`), the device-local sets (`NewTabDeviceState`: the
 * user's shortcuts and the hosts removed from the most-visited tiles), their defaults and
 * sanitisers, the pure preset logic that turns the preferences into the sections a page renders,
 * the shortcut and host mutators both services share, and the one-time migration that folds the
 * two earlier models – the desktop's first `settings.newTab` and the phone's frozen
 * `settings.newTabPhone` – into this one.
 */
import type {
  NewTabBackgroundKind,
  NewTabDeviceState,
  NewTabMode,
  NewTabModules,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcut
} from './types'
import { newId } from './ids'

// ---------------------------------------------------------------------------
// Constants and defaults
// ---------------------------------------------------------------------------

/**
 * The grid is four columns by two rows (design language v2 §9.29) on both pages: eight tiles,
 * whichever source fills them, and so at most eight shortcuts.
 */
export const MAX_NEW_TAB_SHORTCUTS = 8

/** Most hosts the block list of the most-visited tiles keeps. */
export const MAX_NEW_TAB_HIDDEN_HOSTS = 500

export const NEW_TAB_PRESETS: readonly NewTabPreset[] = [
  'focused',
  'inspirational',
  'informational',
  'custom'
]

/** No feed core exists yet; the preset that needs one is offered as "not available". */
export const FEED_AVAILABLE = false

/**
 * Voice and visual search are later workers' rows. The phone's search field shows their buttons
 * only once something handles the `zen-voice-search` / `zen-visual-search` events they dispatch,
 * so no control that does nothing ships in the meantime.
 */
export const VOICE_SEARCH_AVAILABLE = false
export const VISUAL_SEARCH_AVAILABLE = false

/** What a page draws. Same shape as the modules: a preset is a fixed set of them. */
export type NewTabSections = NewTabModules

/** The `custom` preset's sections before the user touches them: the `focused` page. */
export const DEFAULT_NEW_TAB_MODULES: NewTabModules = {
  searchBox: true,
  shortcuts: true,
  wallpaper: false,
  feed: false,
  greeting: false
}

/**
 * Zen-quiet by default: the page opens (desktop), with the search field and the most visited
 * sites on the bare space gradient, no greeting.
 */
export const DEFAULT_NEW_TAB_SETTINGS: NewTabSettings = {
  enabled: true,
  mode: 'most-visited',
  preset: 'focused',
  modules: { ...DEFAULT_NEW_TAB_MODULES },
  background: 'space'
}

export function emptyNewTabDevice(): NewTabDeviceState {
  return { shortcuts: [], hiddenHosts: [] }
}

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function obj(raw: unknown): Raw {
  return raw && typeof raw === 'object' ? (raw as Raw) : {}
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isPreset(value: unknown): value is NewTabPreset {
  return typeof value === 'string' && (NEW_TAB_PRESETS as readonly string[]).includes(value)
}

function isBackground(value: unknown): value is NewTabBackgroundKind {
  return value === 'space' || value === 'solid' || value === 'image'
}

/**
 * The mode as any build wrote it. The desktop's first model spelt the user's own grid `custom`;
 * it is read as `my-shortcuts` for one release (0.3.x profiles carry it, so may a peer's record).
 */
function readMode(value: unknown): NewTabMode | null {
  if (value === 'most-visited' || value === 'my-shortcuts') return value
  if (value === 'custom') return 'my-shortcuts'
  return null
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function sanitizeNewTabModules(raw: unknown): NewTabModules {
  const m = obj(raw)
  const d = DEFAULT_NEW_TAB_MODULES
  return {
    searchBox: bool(m.searchBox, d.searchBox),
    shortcuts: bool(m.shortcuts, d.shortcuts),
    wallpaper: bool(m.wallpaper, d.wallpaper),
    feed: bool(m.feed, d.feed),
    greeting: bool(m.greeting, d.greeting)
  }
}

/**
 * Fill in missing keys and drop values that are not ours (older profiles, a peer's record, a
 * client's patch). Fields of the earlier models (`shortcuts`, `greeting`, `newTabPhone`) are the
 * migration's business, not this function's: run `migrateNewTabSettings` first on a document
 * that may still carry them.
 */
export function sanitizeNewTabSettings(raw: unknown): NewTabSettings {
  const r = obj(raw)
  const d = DEFAULT_NEW_TAB_SETTINGS
  return {
    enabled: bool(r.enabled, d.enabled),
    mode: readMode(r.mode) ?? d.mode,
    preset: isPreset(r.preset) ? r.preset : d.preset,
    modules: sanitizeNewTabModules(r.modules),
    background: isBackground(r.background) ? r.background : d.background
  }
}

/** Host block list from disk: lower-case, trimmed, no `www.`, unique, at most 500. */
export function sanitizeHiddenHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const host = normalizeHost(item)
    if (host && !out.includes(host)) out.push(host)
    if (out.length >= MAX_NEW_TAB_HIDDEN_HOSTS) break
  }
  return out
}

/**
 * Shortcut records from disk: web addresses only, once each (by id and by address), a blank
 * title standing in as the address, at most a grid of them.
 */
export function sanitizeNewTabShortcuts(raw: unknown): NewTabShortcut[] {
  if (!Array.isArray(raw)) return []
  const out: NewTabShortcut[] = []
  const ids = new Set<string>()
  const urls = new Set<string>()
  for (const item of raw) {
    const { id, url, title } = obj(item)
    if (typeof id !== 'string' || !id || !isWebUrl(url) || ids.has(id) || urls.has(url)) continue
    ids.add(id)
    urls.add(url)
    out.push({ id, url, title: typeof title === 'string' && title.trim() ? title : url })
    if (out.length >= MAX_NEW_TAB_SHORTCUTS) break
  }
  return out
}

export function sanitizeNewTabDevice(raw: unknown): NewTabDeviceState {
  const r = obj(raw)
  return {
    shortcuts: sanitizeNewTabShortcuts(r.shortcuts),
    hiddenHosts: sanitizeHiddenHosts(r.hiddenHosts)
  }
}

// ---------------------------------------------------------------------------
// Presets and sections
// ---------------------------------------------------------------------------

/**
 * The fixed sections of the named presets (`custom` reads the toggles instead). A greeting is
 * what makes the inspirational page in Chrome, so the two wallpaper presets carry one.
 */
const PRESET_SECTIONS: Record<Exclude<NewTabPreset, 'custom'>, NewTabSections> = {
  focused: { searchBox: true, shortcuts: true, wallpaper: false, feed: false, greeting: false },
  inspirational: { searchBox: true, shortcuts: true, wallpaper: true, feed: false, greeting: true },
  informational: { searchBox: true, shortcuts: true, wallpaper: true, feed: true, greeting: true }
}

/**
 * The sections a preset stands for – what both pages read (never `modules` directly, which only
 * the `custom` preset honours). The named presets are fixed so that picking one always gives the
 * same page; the feed is only ever drawn once a feed core exists, whatever the preset or the
 * toggles say.
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

/** Presets the pickers let the user choose; the feed preset waits for a feed core. */
export function presetAvailable(preset: NewTabPreset): boolean {
  return preset !== 'informational' || FEED_AVAILABLE
}

/**
 * What a page paints behind its content: the chosen background while the wallpaper section is
 * on, the bare space gradient otherwise (the page is the space, as on a `focused` layout).
 */
export function newTabBackground(settings: NewTabSettings): NewTabBackgroundKind {
  return newTabSections(settings).wallpaper ? settings.background : 'space'
}

// ---------------------------------------------------------------------------
// Shortcuts and removed hosts (the device-local sets)
// ---------------------------------------------------------------------------

/** `www.` and case do not make a different site (matches `topSites` in history). */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
}

/** Host of a URL without `www.`, lower-cased; empty for URLs that have none. */
export function siteHost(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return ''
  }
}

/**
 * Pin a site: it becomes a shortcut at the end of the grid unless one already has its address or
 * the grid is full, and its host comes back to the most-visited tiles if the user had removed it.
 */
export function pinShortcut(
  device: NewTabDeviceState,
  shortcut: NewTabShortcut
): NewTabDeviceState {
  const host = siteHost(shortcut.url)
  const hiddenHosts = device.hiddenHosts.filter((h) => h !== host)
  if (
    device.shortcuts.some((s) => s.url === shortcut.url) ||
    device.shortcuts.length >= MAX_NEW_TAB_SHORTCUTS
  ) {
    return hiddenHosts.length === device.hiddenHosts.length ? device : { ...device, hiddenHosts }
  }
  return { shortcuts: [...device.shortcuts, shortcut], hiddenHosts }
}

/** Unpin a site: its shortcut goes; its host stays visible among the most visited. */
export function unpinShortcut(device: NewTabDeviceState, url: string): NewTabDeviceState {
  if (!device.shortcuts.some((s) => s.url === url)) return device
  return { ...device, shortcuts: device.shortcuts.filter((s) => s.url !== url) }
}

/** Remove a site's host from the most-visited tiles (the newest removal wins a full list). */
export function hideSite(device: NewTabDeviceState, url: string): NewTabDeviceState {
  const host = siteHost(url)
  if (!host || device.hiddenHosts.includes(host)) return device
  return {
    ...device,
    hiddenHosts: [...device.hiddenHosts, host].slice(-MAX_NEW_TAB_HIDDEN_HOSTS)
  }
}

export function unhideSite(device: NewTabDeviceState, url: string): NewTabDeviceState {
  const host = siteHost(url)
  if (!host || !device.hiddenHosts.includes(host)) return device
  return { ...device, hiddenHosts: device.hiddenHosts.filter((h) => h !== host) }
}

/** Remove a tile: its shortcut goes and its host stays out of the most-visited tiles. */
export function removeSite(device: NewTabDeviceState, url: string): NewTabDeviceState {
  return hideSite(unpinShortcut(device, url), url)
}

// ---------------------------------------------------------------------------
// Migration from the two earlier models
// ---------------------------------------------------------------------------

/**
 * The frozen phone key (`settings.newTabPhone`, 0.3.x), exactly as its sanitiser wrote it: pins
 * and removed hosts inside the synced object, the shortcut source under another name, the
 * wallpaper source with no solid option, no greeting.
 */
interface LegacyPhoneSettings {
  preset: NewTabPreset
  modules: Omit<NewTabModules, 'greeting'>
  shortcutStyle: NewTabMode
  wallpaper: 'space' | 'image'
  pinned: Array<{ url: string; title: string }>
  hiddenHosts: string[]
}

function readLegacyPhone(raw: unknown): LegacyPhoneSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Raw
  const m = obj(r.modules)
  const d = DEFAULT_NEW_TAB_MODULES
  const pinned: LegacyPhoneSettings['pinned'] = []
  const seen = new Set<string>()
  if (Array.isArray(r.pinned)) {
    for (const item of r.pinned) {
      const { url, title } = obj(item)
      if (!isWebUrl(url) || seen.has(url)) continue
      seen.add(url)
      pinned.push({ url, title: typeof title === 'string' ? title : '' })
    }
  }
  return {
    preset: isPreset(r.preset) ? r.preset : 'focused',
    modules: {
      searchBox: bool(m.searchBox, d.searchBox),
      shortcuts: bool(m.shortcuts, d.shortcuts),
      wallpaper: bool(m.wallpaper, d.wallpaper),
      feed: bool(m.feed, d.feed)
    },
    shortcutStyle: readMode(r.shortcutStyle) ?? 'most-visited',
    wallpaper: r.wallpaper === 'image' ? 'image' : 'space',
    pinned,
    hiddenHosts: Array.isArray(r.hiddenHosts)
      ? r.hiddenHosts.filter((h): h is string => typeof h === 'string')
      : []
  }
}

/**
 * The desktop's first model (`settings.newTab`, 0.3.x): `shortcuts` in place of `mode`, with
 * `custom` for the user's own grid and `hidden` for no grid; `greeting` a top-level flag; no
 * preset. The page it described is `focused` unless something was turned on or off – a greeting,
 * a background other than the space gradient, no grid – which the `custom` preset carries.
 */
function readLegacyDesktop(r: Raw): NewTabSettings {
  const d = DEFAULT_NEW_TAB_SETTINGS
  const background = isBackground(r.background) ? r.background : d.background
  const greeting = bool(r.greeting, false)
  const shortcutsShown = r.shortcuts !== 'hidden'
  const modules: NewTabModules = {
    searchBox: true,
    shortcuts: shortcutsShown,
    wallpaper: background !== 'space',
    feed: false,
    greeting
  }
  const custom = greeting || background !== 'space' || !shortcutsShown
  return {
    enabled: bool(r.enabled, d.enabled),
    mode: r.shortcuts === 'custom' ? 'my-shortcuts' : 'most-visited',
    preset: custom ? 'custom' : 'focused',
    modules,
    background
  }
}

/** `settings.newTab` as any build wrote it: the one model, or the desktop's first. */
function readNewTab(raw: unknown): NewTabSettings {
  const r = obj(raw)
  if ('mode' in r || 'preset' in r || 'modules' in r) return sanitizeNewTabSettings(r)
  return readLegacyDesktop(r)
}

/**
 * The phone key next to the desktop key: the non-default value wins, and where both are set the
 * phone's does. The phone key exists only where a phone user touched the sheet, while
 * `settings.newTab` is written on every profile whether touched or not, so "desktop wins" would
 * mean "defaults win" and lose the phone user every choice.
 */
function foldPhone(desktop: NewTabSettings, phone: LegacyPhoneSettings): NewTabSettings {
  const d = DEFAULT_NEW_TAB_SETTINGS
  const pick = <T>(phoneValue: T, desktopValue: T, fallback: T): T =>
    phoneValue !== fallback ? phoneValue : desktopValue
  const modules: NewTabModules = { ...desktop.modules }
  for (const key of ['searchBox', 'shortcuts', 'wallpaper', 'feed'] as const)
    modules[key] = pick(phone.modules[key], desktop.modules[key], d.modules[key])
  return {
    enabled: desktop.enabled,
    mode: pick(phone.shortcutStyle, desktop.mode, d.mode),
    preset: pick(phone.preset, desktop.preset, d.preset),
    modules,
    background: pick(phone.wallpaper, desktop.background, d.background)
  }
}

/** The keys a `settings` object of any build may carry for the new tab page. */
export interface NewTabSettingsSources {
  newTab?: unknown
  /** The frozen phone key, while a profile or a peer's record still has it. */
  newTabPhone?: unknown
}

/**
 * The synced preferences from a document of any build: the one model as it is, the desktop's
 * first model translated, and the phone key – when still present – folded in. Idempotent: the
 * result read again is the result; the caller deletes `newTabPhone` once it has been folded.
 * Runs before `sanitizeNewTabSettings`, which knows nothing of the earlier fields.
 */
export function migrateNewTabSettings(sources: NewTabSettingsSources): NewTabSettings {
  const desktop = readNewTab(sources.newTab)
  const phone = readLegacyPhone(sources.newTabPhone)
  return phone ? foldPhone(desktop, phone) : desktop
}

/** Where a profile of any build keeps the device-local sets. */
export interface NewTabDeviceSources {
  /** v5: the one device-local document. */
  newTabDevice?: unknown
  /** v4: the desktop's shortcuts and block list as two top-level lists. */
  newTabShortcuts?: unknown
  newTabHiddenHosts?: unknown
  /** The frozen phone key: its pins and removed hosts move out of the synced settings. */
  newTabPhone?: unknown
}

/**
 * The device-local sets from a profile of any build. A phone's pins become shortcuts after the
 * device's own, in their order, once per address, within the grid's eight; its removed hosts join
 * the block list through the normalising sanitiser (`www.` dropped, so a host it listed twice is
 * one). Pinning a site brings its host back, as it did on the phone.
 */
export function migrateNewTabDevice(
  sources: NewTabDeviceSources,
  id: () => string = () => newId('shortcut')
): NewTabDeviceState {
  const current =
    sources.newTabDevice !== undefined
      ? sanitizeNewTabDevice(sources.newTabDevice)
      : {
          shortcuts: sanitizeNewTabShortcuts(sources.newTabShortcuts),
          hiddenHosts: sanitizeHiddenHosts(sources.newTabHiddenHosts)
        }
  const phone = readLegacyPhone(sources.newTabPhone)
  if (!phone) return current
  let device: NewTabDeviceState = {
    shortcuts: current.shortcuts,
    hiddenHosts: sanitizeHiddenHosts([...current.hiddenHosts, ...phone.hiddenHosts])
  }
  for (const pin of phone.pinned) device = pinShortcut(device, { id: id(), ...pin })
  return sanitizeNewTabDevice(device)
}
