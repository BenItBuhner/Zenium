/**
 * `chrome.fontSettings` without the engine: the generic families and script codes it names,
 * what each method accepts (Chrome's own checks and error strings), how the fonts and sizes
 * several extensions set layer over the user's settings, and the `levelOfControl` each
 * extension sees. The host owns the values' persistence, the user's settings, the platform
 * defaults and the application to pages; everything here is pure.
 *
 * Chrome's model (`font_settings_api.cc`): every extension holding `fontSettings` may set every
 * pref; the prefs are `webkit.webprefs.fonts.<genericFamily>.<script>` (the script `Zyyy`, the
 * common script, when a call names none), `webkit.webprefs.default_font_size`,
 * `webkit.webprefs.default_fixed_font_size` and `webkit.webprefs.minimum_font_size`. When
 * several extensions set one pref, the most recently installed enabled extension's value wins
 * (`ExtensionPrefValueMap`); the user's own setting stays untouched underneath and returns
 * when the last extension's value is cleared or the extension goes.
 */

import type { LevelOfControl } from './privacy'

export type { LevelOfControl }

export const GENERIC_FAMILIES = [
  'standard',
  'sansserif',
  'serif',
  'fixed',
  'cursive',
  'fantasy',
  'math'
] as const

export type GenericFamily = (typeof GENERIC_FAMILIES)[number]

/** Chrome's `ScriptCode` enum, in its schema's order; `Zyyy` is the common (global) script. */
export const SCRIPT_CODES = [
  'Afak', 'Arab', 'Armi', 'Armn', 'Avst', 'Bali', 'Bamu', 'Bass', 'Batk', 'Beng', 'Blis', 'Bopo',
  'Brah', 'Brai', 'Bugi', 'Buhd', 'Cakm', 'Cans', 'Cari', 'Cham', 'Cher', 'Cirt', 'Copt', 'Cprt',
  'Cyrl', 'Cyrs', 'Deva', 'Dsrt', 'Dupl', 'Egyd', 'Egyh', 'Egyp', 'Elba', 'Ethi', 'Geor', 'Geok',
  'Glag', 'Goth', 'Gran', 'Grek', 'Gujr', 'Guru', 'Hang', 'Hani', 'Hano', 'Hans', 'Hant', 'Hebr',
  'Hluw', 'Hmng', 'Hung', 'Inds', 'Ital', 'Java', 'Jpan', 'Jurc', 'Kali', 'Khar', 'Khmr', 'Khoj',
  'Knda', 'Kpel', 'Kthi', 'Lana', 'Laoo', 'Latf', 'Latg', 'Latn', 'Lepc', 'Limb', 'Lina', 'Linb',
  'Lisu', 'Loma', 'Lyci', 'Lydi', 'Mand', 'Mani', 'Maya', 'Mend', 'Merc', 'Mero', 'Mlym', 'Moon',
  'Mong', 'Mroo', 'Mtei', 'Mymr', 'Narb', 'Nbat', 'Nkgb', 'Nkoo', 'Nshu', 'Ogam', 'Olck', 'Orkh',
  'Orya', 'Osma', 'Palm', 'Perm', 'Phag', 'Phli', 'Phlp', 'Phlv', 'Phnx', 'Plrd', 'Prti', 'Rjng',
  'Roro', 'Runr', 'Samr', 'Sara', 'Sarb', 'Saur', 'Sgnw', 'Shaw', 'Shrd', 'Sind', 'Sinh', 'Sora',
  'Sund', 'Sylo', 'Syrc', 'Syre', 'Syrj', 'Syrn', 'Tagb', 'Takr', 'Tale', 'Talu', 'Taml', 'Tang',
  'Tavt', 'Telu', 'Teng', 'Tfng', 'Tglg', 'Thaa', 'Thai', 'Tibt', 'Tirh', 'Ugar', 'Vaii', 'Visp',
  'Wara', 'Wole', 'Xpeo', 'Xsux', 'Yiii', 'Zmth', 'Zsym', 'Zyyy'
] as const

export type ScriptCode = (typeof SCRIPT_CODES)[number]

export const COMMON_SCRIPT: ScriptCode = 'Zyyy'

export const LEVELS_OF_CONTROL: readonly LevelOfControl[] = [
  'not_controllable',
  'controlled_by_other_extensions',
  'controllable_by_this_extension',
  'controlled_by_this_extension'
]

export function isGenericFamily(value: unknown): value is GenericFamily {
  return typeof value === 'string' && (GENERIC_FAMILIES as readonly string[]).includes(value)
}

export function isScriptCode(value: unknown): value is ScriptCode {
  return typeof value === 'string' && (SCRIPT_CODES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Pref keys
// ---------------------------------------------------------------------------

export const FONT_PREF_PREFIX = 'webkit.webprefs.fonts.'
export const DEFAULT_FONT_SIZE_PREF = 'webkit.webprefs.default_font_size'
export const DEFAULT_FIXED_FONT_SIZE_PREF = 'webkit.webprefs.default_fixed_font_size'
export const MINIMUM_FONT_SIZE_PREF = 'webkit.webprefs.minimum_font_size'

export type FontSizePref =
  | typeof DEFAULT_FONT_SIZE_PREF
  | typeof DEFAULT_FIXED_FONT_SIZE_PREF
  | typeof MINIMUM_FONT_SIZE_PREF

export const FONT_SIZE_PREFS: readonly FontSizePref[] = [
  DEFAULT_FONT_SIZE_PREF,
  DEFAULT_FIXED_FONT_SIZE_PREF,
  MINIMUM_FONT_SIZE_PREF
]

/** The three size prefs' methods and events, by the pref they act on. */
export const FONT_SIZE_METHODS: Readonly<
  Record<FontSizePref, { get: string; set: string; clear: string; event: string }>
> = {
  [DEFAULT_FONT_SIZE_PREF]: {
    get: 'getDefaultFontSize',
    set: 'setDefaultFontSize',
    clear: 'clearDefaultFontSize',
    event: 'onDefaultFontSizeChanged'
  },
  [DEFAULT_FIXED_FONT_SIZE_PREF]: {
    get: 'getDefaultFixedFontSize',
    set: 'setDefaultFixedFontSize',
    clear: 'clearDefaultFixedFontSize',
    event: 'onDefaultFixedFontSizeChanged'
  },
  [MINIMUM_FONT_SIZE_PREF]: {
    get: 'getMinimumFontSize',
    set: 'setMinimumFontSize',
    clear: 'clearMinimumFontSize',
    event: 'onMinimumFontSizeChanged'
  }
}

export function isFontSizePref(key: string): key is FontSizePref {
  return (FONT_SIZE_PREFS as readonly string[]).includes(key)
}

export function fontPrefKey(genericFamily: GenericFamily, script: ScriptCode): string {
  return `${FONT_PREF_PREFIX}${genericFamily}.${script}`
}

/** The family and script a font pref key names, or undefined for any other key. */
export function parseFontPrefKey(
  key: string
): { genericFamily: GenericFamily; script: ScriptCode } | undefined {
  if (!key.startsWith(FONT_PREF_PREFIX)) return undefined
  const rest = key.slice(FONT_PREF_PREFIX.length).split('.')
  if (rest.length !== 2) return undefined
  const [genericFamily, script] = rest
  if (!isGenericFamily(genericFamily) || !isScriptCode(script)) return undefined
  return { genericFamily, script }
}

// ---------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------

export const INVALID_FONT_ID_ERROR = 'Invalid font ID.'

/** The longest font id `setFont` takes, in UTF-8 bytes (Chrome's `kMaxFontNameLength`). */
export const MAX_FONT_ID_BYTES = 256

const utf8 = new TextEncoder()

/**
 * Chrome's `IsValidFontName`: the empty string is valid (it means "fall back to the global
 * script's setting"); otherwise the id is at most 256 bytes of UTF-8, and every ASCII character
 * in it is alphanumeric, a space, `-`, `_`, `.` or `+`. Non-ASCII characters pass.
 */
export function isValidFontId(fontId: string): boolean {
  if (fontId.length === 0) return true
  if (utf8.encode(fontId).length > MAX_FONT_ID_BYTES) return false
  for (const ch of fontId) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x80) continue
    if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      ch === ' ' ||
      ch === '-' ||
      ch === '_' ||
      ch === '.' ||
      ch === '+'
    ) {
      continue
    }
    return false
  }
  return true
}

export interface FontDetails {
  genericFamily: GenericFamily
  /** `Zyyy` when the call named none. */
  script: ScriptCode
}

export interface SetFontDetails extends FontDetails {
  fontId: string
}

function record(raw: unknown, required: boolean): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    if (required) throw new Error("Missing required argument 'details'.")
    return {}
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid details.')
  return raw as Record<string, unknown>
}

function enumError(property: string, values: readonly string[]): Error {
  return new Error(
    `Invalid value for '${property}': expected one of ${values.map((v) => `'${v}'`).join(', ')}.`
  )
}

/** `getFont` / `clearFont`: `genericFamily` required, `script` optional (`Zyyy` when absent). */
export function normalizeFontDetails(raw: unknown): FontDetails {
  const details = record(raw, true)
  const genericFamily = details.genericFamily
  if (genericFamily === undefined) throw new Error("Missing required property 'genericFamily'.")
  if (!isGenericFamily(genericFamily)) throw enumError('genericFamily', GENERIC_FAMILIES)
  const script = details.script
  if (script === undefined || script === null) return { genericFamily, script: COMMON_SCRIPT }
  if (!isScriptCode(script)) throw enumError('script', SCRIPT_CODES)
  return { genericFamily, script }
}

/** `setFont`: the font details plus a required `fontId` that passes Chrome's `IsValidFontName`. */
export function normalizeSetFontDetails(raw: unknown): SetFontDetails {
  const base = normalizeFontDetails(raw)
  const fontId = record(raw, true).fontId
  if (fontId === undefined) throw new Error("Missing required property 'fontId'.")
  if (typeof fontId !== 'string') throw new Error("Invalid value for 'fontId': expected string.")
  if (!isValidFontId(fontId)) throw new Error(INVALID_FONT_ID_ERROR)
  return { ...base, fontId }
}

/**
 * `setDefaultFontSize` and its siblings: `pixelSize` required, an integer as Chrome's schema
 * has it (Chrome sets whatever integer it is given; the renderer treats sizes under one pixel
 * as none).
 */
export function normalizePixelSize(raw: unknown): number {
  const details = record(raw, true)
  const pixelSize = details.pixelSize
  if (pixelSize === undefined) throw new Error("Missing required property 'pixelSize'.")
  if (typeof pixelSize !== 'number' || !Number.isInteger(pixelSize)) {
    throw new Error("Invalid value for 'pixelSize': expected integer.")
  }
  return pixelSize
}

/** The `get*` / `clear*` size methods take an optional, unused details object. */
export function normalizeUnusedDetails(raw: unknown): void {
  record(raw, false)
}

// ---------------------------------------------------------------------------
// Values and precedence
// ---------------------------------------------------------------------------

/** One extension's values, by pref key: a font id (fonts) or an integer (sizes). */
export type FontPrefValues = Record<string, string | number>

/** Every extension's values for one pref, by extension id. */
export type PrefValues = ReadonlyMap<string, string | number>

/**
 * An extension's position in the install order, newest first (a lower number wins), or
 * undefined when its values do not count because it is not enabled.
 */
export type FontRank = (extensionId: string) => number | undefined

export interface PrefController {
  extensionId: string
  value: string | number
}

/**
 * Who controls a pref: among the enabled extensions that set it, the most recently installed.
 * Equal ranks (ids the ranking does not order) settle by id.
 */
export function controllerOf(values: PrefValues, rank: FontRank): PrefController | undefined {
  let best: { extensionId: string; value: string | number; rank: number } | undefined
  for (const [extensionId, value] of values) {
    const r = rank(extensionId)
    if (r === undefined) continue
    if (!best || r < best.rank || (r === best.rank && extensionId < best.extensionId)) {
      best = { extensionId, value, rank: r }
    }
  }
  return best && { extensionId: best.extensionId, value: best.value }
}

/**
 * Chrome's `ExtensionPrefValueMap::GetLevelOfControl` for a pref every extension may modify:
 * the controlling extension sees `controlled_by_this_extension`; an extension sees
 * `controllable_by_this_extension` when no extension controls the pref or when the controller
 * was installed before it (its own value would win); otherwise
 * `controlled_by_other_extensions`. `not_controllable` is for prefs extensions cannot modify,
 * which none of these are.
 */
export function levelOfControlFor(
  controller: string | null,
  extensionId: string,
  rank: FontRank
): LevelOfControl {
  if (controller === null) return 'controllable_by_this_extension'
  if (controller === extensionId) return 'controlled_by_this_extension'
  const own = rank(extensionId)
  const theirs = rank(controller)
  if (own !== undefined && (theirs === undefined || own <= theirs)) {
    return 'controllable_by_this_extension'
  }
  return 'controlled_by_other_extensions'
}

/** The value in effect for a pref and who set it (null: the browser's own value applies). */
export interface EffectivePref<V extends string | number> {
  value: V
  controller: string | null
}

export function effectivePref<V extends string | number>(
  values: PrefValues,
  browserValue: V,
  rank: FontRank
): EffectivePref<V> {
  const controller = controllerOf(values, rank)
  return controller
    ? { value: controller.value as V, controller: controller.extensionId }
    : { value: browserValue, controller: null }
}

export function sameEffective<V extends string | number>(
  a: EffectivePref<V>,
  b: EffectivePref<V>
): boolean {
  return a.value === b.value && a.controller === b.controller
}

// ---------------------------------------------------------------------------
// Results and event details
// ---------------------------------------------------------------------------

export interface FontResult {
  fontId: string
  levelOfControl: LevelOfControl
}

export interface FontSizeResult {
  pixelSize: number
  levelOfControl: LevelOfControl
}

/** `onFontChanged`'s argument: Chrome always names the script, `Zyyy` for the global setting. */
export interface FontChangedDetails extends FontResult {
  script: ScriptCode
  genericFamily: GenericFamily
}

export function fontResult(
  effective: EffectivePref<string>,
  extensionId: string,
  rank: FontRank
): FontResult {
  return {
    fontId: effective.value,
    levelOfControl: levelOfControlFor(effective.controller, extensionId, rank)
  }
}

export function fontSizeResult(
  effective: EffectivePref<number>,
  extensionId: string,
  rank: FontRank
): FontSizeResult {
  return {
    pixelSize: effective.value,
    levelOfControl: levelOfControlFor(effective.controller, extensionId, rank)
  }
}

export function fontChangedDetails(
  details: FontDetails,
  effective: EffectivePref<string>,
  extensionId: string,
  rank: FontRank
): FontChangedDetails {
  return {
    ...fontResult(effective, extensionId, rank),
    script: details.script,
    genericFamily: details.genericFamily
  }
}

// ---------------------------------------------------------------------------
// The font list
// ---------------------------------------------------------------------------

export interface FontName {
  fontId: string
  displayName: string
}

/**
 * `getFontList`'s answer from the installed family names: one entry per distinct family, the
 * id and the display name both the family name (Chrome's `content::GetFontList` gives the
 * same string for both on every platform Zenium's desktop runs on), sorted by code point as
 * Chrome's list is. Empty names and names starting with `.` (macOS's hidden system fonts,
 * which the Settings page hides too) are left out.
 */
export function fontListOf(families: Iterable<string>): FontName[] {
  const seen = new Set<string>()
  for (const raw of families) {
    const family = raw.trim()
    if (family.length === 0 || family.startsWith('.')) continue
    seen.add(family)
  }
  return [...seen]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((family) => ({ fontId: family, displayName: family }))
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Read an extension's values back from persistence, keeping only keys and values that fit. */
export function normalizeFontPrefValues(raw: unknown): FontPrefValues {
  const out: FontPrefValues = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isFontSizePref(key)) {
      if (typeof value === 'number' && Number.isInteger(value)) out[key] = value
    } else if (parseFontPrefKey(key)) {
      if (typeof value === 'string' && isValidFontId(value)) out[key] = value
    }
  }
  return out
}
