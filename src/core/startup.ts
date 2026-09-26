import type { ExtensionControl, Settings, StartupMode, StartupSettings } from '../shared/types'
import { inputToUrl } from '../shared/url'

/**
 * Settings › On startup (settings-47, Chrome's `session.restore_on_startup` + `urls_to_restore_on_
 * startup`): the model the boot reads and the Settings rows edit. Pure: the setting as read from
 * disk or a peer, the pages list's sanitising, the 0.4.x `restoreSession` switch folded in, and
 * the mode in effect once an enabled extension's `chrome_settings_overrides.startup_pages` has
 * had its say (Chrome: the extension's pages replace the user's choice while it is enabled; the
 * newest-installed of several wins, as its `ExtensionPrefs` layer sits on top).
 */

export const STARTUP_MODES: readonly StartupMode[] = ['newTab', 'continue', 'pages']

/** Chrome caps nothing here; twenty tabs at every boot is past what any startup set should be. */
export const MAX_STARTUP_PAGES = 20

export const DEFAULT_STARTUP: StartupSettings = { mode: 'continue', pages: [] }

export function isStartupMode(value: unknown): value is StartupMode {
  return typeof value === 'string' && (STARTUP_MODES as readonly string[]).includes(value)
}

/**
 * What was typed for a startup page as the address it stands for: `example.com` becomes
 * `https://example.com/`, a full address keeps its path and query; null for anything that is
 * not a web page – an internal page, a search, an empty field (Chrome's "Add a new page" accepts
 * web addresses alone, as `chrome_settings_overrides.startup_pages` does).
 */
export function startupPageUrl(input: string): string | null {
  const address = inputToUrl(input.trim())
  if (!address || !/^https?:\/\//i.test(address)) return null
  try {
    return new URL(address).href
  } catch {
    return null
  }
}

/**
 * A pages list as read from anywhere (disk, a peer, a Settings patch, a manifest): web addresses
 * alone, each once, in their order, at most `MAX_STARTUP_PAGES`.
 */
export function sanitizeStartupPages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const url = startupPageUrl(entry)
    if (!url || out.includes(url)) continue
    out.push(url)
    if (out.length >= MAX_STARTUP_PAGES) break
  }
  return out
}

/**
 * The setting as read from disk or a peer: a mode this build does not know reads as the
 * default's (continue), the list as `sanitizeStartupPages` leaves it.
 */
export function sanitizeStartupSettings(raw: unknown): StartupSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STARTUP, pages: [] }
  const { mode, pages } = raw as Record<string, unknown>
  return {
    mode: isStartupMode(mode) ? mode : DEFAULT_STARTUP.mode,
    pages: sanitizeStartupPages(pages)
  }
}

/**
 * The setting of a persisted profile: its own `startup` when it has one, else the 0.4.x
 * `restoreSession` switch folded in – on was "Continue where you left off", off "Open the New
 * Tab page" (the boot's two behaviours before the third choice existed) – and the default for a
 * profile that had neither. The switch's key rides no further: `applyPersisted` drops it.
 */
export function migrateStartupSettings(persisted: {
  startup?: unknown
  restoreSession?: unknown
}): StartupSettings {
  if (persisted.startup && typeof persisted.startup === 'object')
    return sanitizeStartupSettings(persisted.startup)
  if (typeof persisted.restoreSession === 'boolean')
    return { mode: persisted.restoreSession ? 'continue' : 'newTab', pages: [] }
  return { ...DEFAULT_STARTUP, pages: [] }
}

/**
 * An enabled extension's `chrome_settings_overrides.startup_pages`, as the extension host offers
 * it to the boot and to the Settings page (`ExtensionControl` is the indicator's half).
 */
export interface StartupOverride {
  extensionId: string
  /** The extension's name as the Extensions page shows it. */
  name: string
  /** The extension's pages, sanitised as the user's are; never empty. */
  pages: string[]
  /** When the extension was installed: the newest of several overriding extensions wins. */
  installedAt: number
}

/** The startup in effect: the user's setting, or an extension's pages over it. */
export interface EffectiveStartup {
  mode: StartupMode
  pages: string[]
  /** The extension holding the setting, when one does. */
  control: (ExtensionControl & { pages: string[] }) | null
}

/**
 * Chrome's precedence among extensions setting the same preference: the most recently installed
 * enabled one's value is in effect (`ExtensionPrefValueMap`). Candidates without a valid page
 * count for nothing – an override with no page would leave the user with no startup at all.
 */
export function resolveStartupOverride(
  candidates: readonly StartupOverride[]
): StartupOverride | null {
  let best: StartupOverride | null = null
  for (const candidate of candidates) {
    if (candidate.pages.length === 0) continue
    if (!best || candidate.installedAt > best.installedAt) best = candidate
  }
  return best
}

/**
 * What the boot does, `settings.startup` and an enabled extension's override read together: the
 * extension's pages when one holds the setting (the user's own kept underneath, standing again
 * when it is disabled or uninstalled); else the user's mode – `pages` with no page left after
 * sanitising is `newTab`, the boot Chrome falls back to with an empty `urls_to_restore_on_
 * startup`. The pages come back sanitised, so a stale profile cannot make the boot open a
 * non-web address.
 */
export function effectiveStartup(
  settings: Pick<Settings, 'startup'>,
  override: StartupOverride | null | undefined
): EffectiveStartup {
  if (override) {
    const pages = sanitizeStartupPages(override.pages)
    if (pages.length > 0)
      return {
        mode: 'pages',
        pages,
        control: { extensionId: override.extensionId, name: override.name, value: pages, pages }
      }
  }
  const own = sanitizeStartupSettings(settings.startup)
  if (own.mode === 'pages' && own.pages.length === 0)
    return { mode: 'newTab', pages: [], control: null }
  return { mode: own.mode, pages: own.mode === 'pages' ? own.pages : [], control: null }
}

/**
 * The `UIState.extensionControls` entries the Settings page's On startup rows read
 * (`extensionControlled(state, key)`): the mode row under `startup.mode` showing "Open a specific
 * page or set of pages", the pages rows under `startup.pages` with the extension's list; none when
 * no extension holds the setting.
 */
export function startupControls(
  effective: EffectiveStartup
): Record<'startup.mode' | 'startup.pages', ExtensionControl> | Record<string, never> {
  const control = effective.control
  if (!control) return {}
  const base = { extensionId: control.extensionId, name: control.name }
  return {
    'startup.mode': { ...base, value: 'pages' },
    'startup.pages': { ...base, value: [...control.pages] }
  }
}
