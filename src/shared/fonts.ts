/**
 * Page fonts (Settings › Appearance › Customize fonts; Chrome's chrome://settings/fonts, CT-25):
 * the families a page gets for text it leaves to the engine's defaults and for the generic
 * families it names (`serif`, `sans-serif`, `monospace`), the default size and the floor no text
 * may go under. Pure data and pure functions: the Electron host maps them onto a page view's
 * web preferences, the Android host onto every tab WebView's `WebSettings`, and the chrome's
 * Settings rows read the same shape.
 */

/**
 * The user's page fonts. A `null` family is the platform's own default (Electron's Times New
 * Roman / Arial / Courier New mapped by fontconfig on Linux; Android's `serif` / `sans-serif` /
 * `monospace`), so a profile that never touched the rows follows the OS like Chrome does.
 */
export interface PageFontSettings {
  /** Text a page leaves unstyled (Chrome's "Standard font"). */
  standard: string | null
  serif: string | null
  sansSerif: string | null
  /** Chrome's "Fixed-width font": `monospace`, `<pre>`, `<code>`. */
  fixed: string | null
  /** Chrome's "Font size" in CSS pixels (9–72; Chrome's medium is 16). */
  size: number
  /** Chrome's "Minimum font size" in CSS pixels (0–24; 0 is no floor). */
  minimumSize: number
}

export const FONT_SIZE_MIN = 9
export const FONT_SIZE_MAX = 72
export const FONT_SIZE_DEFAULT = 16
export const MINIMUM_FONT_SIZE_MAX = 24

/** Chrome's slider stops for "Font size" (`FONT_SIZE_RANGE` of appearance_fonts_page.ts). */
export const FONT_SIZE_STEPS: readonly number[] = [
  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 56, 64, 72
]
/** Chrome's slider stops for "Minimum font size" (0 is off). */
export const MINIMUM_FONT_SIZE_STEPS: readonly number[] = [
  0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24
]

export const DEFAULT_FONT_SETTINGS: PageFontSettings = {
  standard: null,
  serif: null,
  sansSerif: null,
  fixed: null,
  size: FONT_SIZE_DEFAULT,
  minimumSize: 0
}

/** The generic families every host can name; the pickers list them first. */
export const GENERIC_FONT_FAMILIES: readonly string[] = ['serif', 'sans-serif', 'monospace']

/**
 * The families Android's WebView resolves by name (the system font aliases of `fonts.xml`):
 * Chrome for Android offers no family picker at all, so the phone's rows stay to this honest
 * list rather than pretending to enumerate installed fonts.
 */
export const ANDROID_FONT_FAMILIES: readonly string[] = [
  'sans-serif',
  'serif',
  'monospace',
  'serif-monospace',
  'casual',
  'cursive',
  'sans-serif-condensed'
]

/** A family name a page could take in `font-family`: printable, no quotes, bounded. */
const FAMILY_MAX_CHARS = 120

function familyOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value
    .replace(/["'<>;{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null
  return name.slice(0, FAMILY_MAX_CHARS)
}

function sizeOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** Bring a stored, synced or client-sent document into shape; anything off comes from the defaults. */
export function sanitizeFontSettings(raw: unknown): PageFontSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const minimum = sizeOf(
    source.minimumSize,
    DEFAULT_FONT_SETTINGS.minimumSize,
    0,
    MINIMUM_FONT_SIZE_MAX
  )
  return {
    standard: familyOf(source.standard),
    serif: familyOf(source.serif),
    sansSerif: familyOf(source.sansSerif),
    fixed: familyOf(source.fixed),
    size: sizeOf(source.size, DEFAULT_FONT_SETTINGS.size, FONT_SIZE_MIN, FONT_SIZE_MAX),
    // Chrome's slider stops at 0 or 6 and up: 1–5 px floors are not offered, so none is stored.
    minimumSize: minimum > 0 && minimum < 6 ? 6 : minimum
  }
}

/** Whether the profile follows the platform's fonts entirely (the "Reset" row is idle). */
export function isDefaultFontSettings(fonts: PageFontSettings): boolean {
  return (
    fonts.standard === null &&
    fonts.serif === null &&
    fonts.sansSerif === null &&
    fonts.fixed === null &&
    fonts.size === DEFAULT_FONT_SETTINGS.size &&
    fonts.minimumSize === DEFAULT_FONT_SETTINGS.minimumSize
  )
}

/**
 * The fixed-width size that goes with a standard size: Chrome's defaults are 13 for 16, and the
 * ratio is kept as the size moves (13 at 16, 20 at 24, 7 at 9), so `<pre>` and `<code>` stay a
 * step under the running text the way they do in Chrome.
 */
export function monospaceFontSize(size: number): number {
  return Math.max(1, Math.round((size * 13) / 16))
}

/**
 * What a Chromium engine takes for the settings: Electron's `WebPreferences` fields (the
 * `defaultFontFamily` map holds only the families the user chose; the rest stay the engine's)
 * and the DevTools protocol's `Page.setFontFamilies` / `Page.setFontSizes` for an open page.
 */
export interface ChromiumFontPreferences {
  defaultFontFamily: {
    standard?: string
    serif?: string
    sansSerif?: string
    monospace?: string
  }
  defaultFontSize: number
  defaultMonospaceFontSize: number
  minimumFontSize: number
}

export function chromiumFontPreferences(fonts: PageFontSettings): ChromiumFontPreferences {
  const defaultFontFamily: ChromiumFontPreferences['defaultFontFamily'] = {}
  if (fonts.standard) defaultFontFamily.standard = fonts.standard
  if (fonts.serif) defaultFontFamily.serif = fonts.serif
  if (fonts.sansSerif) defaultFontFamily.sansSerif = fonts.sansSerif
  if (fonts.fixed) defaultFontFamily.monospace = fonts.fixed
  return {
    defaultFontFamily,
    defaultFontSize: fonts.size,
    defaultMonospaceFontSize: monospaceFontSize(fonts.size),
    minimumFontSize: fonts.minimumSize
  }
}

/** The engine's own families, by the setting's names (what a `null` family stands for). */
export type FontFamilyDefaults = Record<'standard' | 'serif' | 'sansSerif' | 'fixed', string>

/**
 * Electron's web preference defaults (`WebContentsPreferences`): the names Chrome ships on
 * Windows, which fontconfig maps to the system's serif / sans / monospace faces on Linux.
 */
export const ELECTRON_FONT_DEFAULTS: FontFamilyDefaults = {
  standard: 'Times New Roman',
  serif: 'Times New Roman',
  sansSerif: 'Arial',
  fixed: 'Courier New'
}

/**
 * The families for `Page.setFontFamilies` (the protocol's names: `fixed` for the monospace
 * family), every one named so a live update can also take a family back to the engine's own
 * (the protocol has no "unset"): the user's choice, else the engine's default for the slot.
 */
export function cdpFontFamilies(
  fonts: PageFontSettings,
  defaults: FontFamilyDefaults
): Record<'standard' | 'serif' | 'sansSerif' | 'fixed', string> {
  return {
    standard: fonts.standard ?? defaults.standard,
    serif: fonts.serif ?? defaults.serif,
    sansSerif: fonts.sansSerif ?? defaults.sansSerif,
    fixed: fonts.fixed ?? defaults.fixed
  }
}
