/**
 * `chrome.fontSettings`, the pure part: Chrome's shape (the `ScriptCode` and `GenericFamily`
 * enums, the `details` of every member, the `levelOfControl` answers) laid over Zenium's page
 * fonts (`shared/fonts.ts`, CT-25). Chrome keeps one font preference per generic family and
 * script (`webkit.webprefs.fonts.<family>.<script>`) plus three sizes; the extension layer of
 * each preference (`ExtensionPrefValueMap`) sits over the user's value, the most recently
 * installed extension first. Zenium's setting has one family per slot for every script
 * (`standard`, `serif`, `sansSerif`, `fixed`), one size and one minimum size; the fixed-width
 * size follows the size (`monospaceFontSize`), and `cursive`, `fantasy` and `math` have no slot.
 *
 * So the layer is honest about what it holds: the common script's (`Zyyy`, Chrome's "Default")
 * family of the four slotted generic families and the two sizes are controllable and take an
 * extension's value; a per-script family, the three slotless families and the fixed-width size
 * answer with what the page has and `not_controllable`, and a `set` or `clear` on them is
 * accepted without effect (the way Chrome answers a preference it will not hand over). The host
 * (`main/platform/extensionApi/fontSettings.ts`) keeps the values, ranks them, and hands the
 * layered setting to the pages.
 */
import {
  electronFontDefaults,
  FONT_FAMILY_SLOTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MINIMUM_FONT_SIZE_MAX,
  monospaceFontSize,
  type FontFamilySlot,
  type PageFontSettings
} from '../../../shared/fonts'
import { levelOfControlFor, type LevelOfControl } from './privacy'

export const FONT_SETTINGS_PERMISSION = 'fontSettings'
export const FONT_SETTINGS_PERMISSION_ERROR =
  "You do not have permission to access the font settings. Be sure to declare the 'fontSettings' permission in your manifest."

/** Chrome's `ScriptCode` for text of no particular script: its "Default" font. */
export const COMMON_SCRIPT = 'Zyyy'

/** Chrome's `fontSettings.ScriptCode` enum (font_settings.json): ISO 15924 codes, `Zyyy` last. */
export const SCRIPT_CODES: readonly string[] = (
  'Afak Arab Armi Armn Avst Bali Bamu Bass Batk Beng Blis Bopo Brah Brai Bugi Buhd Cakm Cans ' +
  'Cari Cham Cher Cirt Copt Cprt Cyrl Cyrs Deva Dsrt Dupl Egyd Egyh Egyp Elba Ethi Geok Geor ' +
  'Glag Goth Gran Grek Gujr Guru Hang Hani Hano Hans Hant Hebr Hluw Hmng Hung Inds Ital Java ' +
  'Jpan Jurc Kali Khar Khmr Khoj Knda Kpel Kthi Lana Laoo Latf Latg Latn Lepc Limb Lina Linb ' +
  'Lisu Loma Lyci Lydi Mand Mani Maya Mend Merc Mero Mlym Mong Moon Mroo Mtei Mymr Narb Nbat ' +
  'Nkgb Nkoo Nshu Ogam Olck Orkh Orya Osma Palm Perm Phag Phli Phlp Phlv Phnx Plrd Prti Rjng ' +
  'Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Sind Sinh Sora Sund Sylo Syrc Syre Syrj Syrn ' +
  'Tagb Takr Tale Talu Taml Tang Tavt Telu Teng Tfng Tglg Thaa Thai Tibt Tirh Ugar Vaii Visp ' +
  'Wara Wole Xpeo Xsux Yiii Zmth Zsym ' +
  COMMON_SCRIPT
).split(' ')

/** Chrome's `fontSettings.GenericFamily` enum. */
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

/** The setting's slot behind a generic family; the slotless three are the engine's own. */
export const FAMILY_SLOTS: Readonly<Partial<Record<GenericFamily, FontFamilySlot>>> = {
  standard: 'standard',
  sansserif: 'sansSerif',
  serif: 'serif',
  fixed: 'fixed'
}

/** The generic family a slot answers for (`onFontChanged` names the family, not the slot). */
export const SLOT_FAMILIES: Readonly<Record<FontFamilySlot, GenericFamily>> = {
  standard: 'standard',
  sansSerif: 'sansserif',
  serif: 'serif',
  fixed: 'fixed'
}

/** The preferences an extension may control: the four slotted families and the two sizes. */
export type FontPref = FontFamilySlot | 'size' | 'minimumSize'
export const FONT_PREFS: readonly FontPref[] = [...FONT_FAMILY_SLOTS, 'size', 'minimumSize']

/** One extension's values (the regular scope; persisted). */
export interface FontValues {
  families?: Partial<Record<FontFamilySlot, string>>
  size?: number
  minimumSize?: number
}

/** The setting the pages get and, per preference, the extension whose value it is (null: the user's). */
export interface LayeredFonts {
  fonts: PageFontSettings
  controllers: Record<FontPref, string | null>
}

/** Chrome's precedence: the rank of a loaded extension (lower first), undefined for one that does not count. */
export type FontRank = (extensionId: string) => number | undefined

export interface FontName {
  fontId: string
  displayName: string
}

export interface FontDetails {
  script: string
  genericFamily: GenericFamily
}

export interface FontResult {
  fontId: string
  levelOfControl: LevelOfControl
}

export interface SizeResult {
  pixelSize: number
  levelOfControl: LevelOfControl
}

export const CONSTANTS = {
  ScriptCode: Object.fromEntries(SCRIPT_CODES.map((code) => [code.toUpperCase(), code])),
  GenericFamily: Object.fromEntries(
    GENERIC_FAMILIES.map((family) => [family.toUpperCase(), family])
  ),
  LevelOfControl: {
    NOT_CONTROLLABLE: 'not_controllable',
    CONTROLLED_BY_OTHER_EXTENSIONS: 'controlled_by_other_extensions',
    CONTROLLABLE_BY_THIS_EXTENSION: 'controllable_by_this_extension',
    CONTROLLED_BY_THIS_EXTENSION: 'controlled_by_this_extension'
  }
} as const

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------

function record(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid details.')
  return raw as Record<string, unknown>
}

function isGenericFamily(value: unknown): value is GenericFamily {
  return typeof value === 'string' && (GENERIC_FAMILIES as readonly string[]).includes(value)
}

/** `getFont` / `clearFont` details: `genericFamily` required, `script` one of the codes (`Zyyy` when absent). */
export function normalizeFontDetails(raw: unknown): FontDetails {
  const details = record(raw)
  if (!('genericFamily' in details)) throw new Error("Missing required property 'genericFamily'.")
  if (!isGenericFamily(details.genericFamily)) {
    throw new Error(
      `Invalid value for 'genericFamily': expected one of ${GENERIC_FAMILIES.join(', ')}.`
    )
  }
  const script = details.script
  if (script === undefined || script === null) {
    return { script: COMMON_SCRIPT, genericFamily: details.genericFamily }
  }
  if (typeof script !== 'string' || !SCRIPT_CODES.includes(script)) {
    throw new Error(`Invalid value for 'script': expected a fontSettings.ScriptCode.`)
  }
  return { script, genericFamily: details.genericFamily }
}

/** `setFont` details: the font details plus the family name, which may be empty (the engine's own). */
export function normalizeSetFontDetails(raw: unknown): FontDetails & { fontId: string } {
  const details = normalizeFontDetails(raw)
  const fontId = record(raw).fontId
  if (fontId === undefined) throw new Error("Missing required property 'fontId'.")
  if (typeof fontId !== 'string') throw new Error("Invalid value for 'fontId': expected a string.")
  return { ...details, fontId: fontId.trim() }
}

/**
 * A size setter's `pixelSize`: an integer, brought into the setting's range (Chrome's slider
 * offers 9–72 for the size, 0–24 for the minimum; a floor of 1–5 px is not on its slider and
 * `sanitizeFontSettings` reads it as 6).
 */
export function normalizeSizeDetails(raw: unknown, pref: 'size' | 'minimumSize'): number {
  const details = record(raw)
  if (!('pixelSize' in details)) throw new Error("Missing required property 'pixelSize'.")
  const value = details.pixelSize
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error("Invalid value for 'pixelSize': expected an integer.")
  }
  if (pref === 'size') return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value))
  const floor = Math.min(MINIMUM_FONT_SIZE_MAX, Math.max(0, value))
  return floor > 0 && floor < 6 ? 6 : floor
}

/** The optional `details` of a getter or clearer: anything but a non-object. */
export function checkDetails(raw: unknown): void {
  record(raw)
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** Whether the details name a preference the layer controls (the common script of a slotted family). */
export function controllableSlot(details: FontDetails): FontFamilySlot | null {
  if (details.script !== COMMON_SCRIPT) return null
  return FAMILY_SLOTS[details.genericFamily] ?? null
}

/** A stored record brought into shape: known slots with non-empty names, sizes in range. */
export function normalizeFontValues(raw: unknown): FontValues {
  const out: FontValues = {}
  if (!raw || typeof raw !== 'object') return out
  const source = raw as Record<string, unknown>
  if (source.families && typeof source.families === 'object') {
    const families = source.families as Record<string, unknown>
    for (const slot of FONT_FAMILY_SLOTS) {
      const name = families[slot]
      if (typeof name === 'string' && name.trim() !== '') {
        ;(out.families ??= {})[slot] = name.trim()
      }
    }
  }
  if (typeof source.size === 'number' && Number.isInteger(source.size)) {
    out.size = normalizeSizeDetails({ pixelSize: source.size }, 'size')
  }
  if (typeof source.minimumSize === 'number' && Number.isInteger(source.minimumSize)) {
    out.minimumSize = normalizeSizeDetails({ pixelSize: source.minimumSize }, 'minimumSize')
  }
  return out
}

export function hasFontValues(values: FontValues): boolean {
  return (
    values.size !== undefined ||
    values.minimumSize !== undefined ||
    Object.keys(values.families ?? {}).length > 0
  )
}

/** An extension's value for one preference, if it set one. */
export function valueOf(values: FontValues, pref: FontPref): string | number | undefined {
  if (pref === 'size') return values.size
  if (pref === 'minimumSize') return values.minimumSize
  return values.families?.[pref]
}

/** Set `pref` in `values` (an empty family name clears the slot, as Chrome's `setFont('')` does); whether anything moved. */
export function withFontValue(
  values: FontValues,
  pref: FontPref,
  value: string | number | undefined
): boolean {
  if (typeof value === 'string' && value === '') value = undefined
  if (valueOf(values, pref) === value) return false
  if (pref === 'size' || pref === 'minimumSize') {
    if (value === undefined) delete values[pref]
    else values[pref] = value as number
    return true
  }
  if (value === undefined) {
    if (values.families) delete values.families[pref]
    if (values.families && Object.keys(values.families).length === 0) delete values.families
  } else {
    ;(values.families ??= {})[pref] = value as string
  }
  return true
}

/**
 * The setting the pages get: the user's, with every controllable preference an extension set
 * taken from the first-ranked extension that set it.
 */
export function layerFonts(
  user: PageFontSettings,
  layers: ReadonlyMap<string, FontValues>,
  rank: FontRank
): LayeredFonts {
  const fonts: PageFontSettings = { ...user }
  const controllers = {} as Record<FontPref, string | null>
  for (const pref of FONT_PREFS) {
    let best: { extensionId: string; value: string | number; rank: number } | null = null
    for (const [extensionId, values] of layers) {
      const value = valueOf(values, pref)
      if (value === undefined) continue
      const r = rank(extensionId)
      if (r === undefined) continue
      if (!best || r < best.rank || (r === best.rank && extensionId < best.extensionId)) {
        best = { extensionId, value, rank: r }
      }
    }
    controllers[pref] = best ? best.extensionId : null
    if (!best) continue
    if (pref === 'size' || pref === 'minimumSize') fonts[pref] = best.value as number
    else fonts[pref] = best.value as string
  }
  return { fonts, controllers }
}

export function sameLayered(a: LayeredFonts, b: LayeredFonts): boolean {
  return (
    JSON.stringify(a.fonts) === JSON.stringify(b.fonts) &&
    FONT_PREFS.every((pref) => a.controllers[pref] === b.controllers[pref])
  )
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/**
 * `getFont`'s answer: for the common script of a slotted family, the family the pages have (the
 * user's or the layer's choice, else the engine's default for the platform) and the caller's
 * say over it; for anything else, what Chrome answers for a preference outside the caller's
 * reach – the name the engine holds is not the layer's to read, so the empty name (Chrome's
 * own value for a script the user never set, which the callers read as "the Default font").
 */
export function fontResult(
  details: FontDetails,
  layered: LayeredFonts,
  extensionId: string,
  platform: string
): FontResult {
  const slot = controllableSlot(details)
  if (!slot) return { fontId: '', levelOfControl: 'not_controllable' }
  return {
    fontId: layered.fonts[slot] ?? electronFontDefaults(platform)[slot],
    levelOfControl: levelOfControlFor(layered.controllers[slot], extensionId)
  }
}

export function defaultFontSizeResult(layered: LayeredFonts, extensionId: string): SizeResult {
  return {
    pixelSize: layered.fonts.size,
    levelOfControl: levelOfControlFor(layered.controllers.size, extensionId)
  }
}

/** The fixed-width size is the setting's ratio of the size: read back, never handed over. */
export function defaultFixedFontSizeResult(layered: LayeredFonts): SizeResult {
  return { pixelSize: monospaceFontSize(layered.fonts.size), levelOfControl: 'not_controllable' }
}

export function minimumFontSizeResult(layered: LayeredFonts, extensionId: string): SizeResult {
  return {
    pixelSize: layered.fonts.minimumSize,
    levelOfControl: levelOfControlFor(layered.controllers.minimumSize, extensionId)
  }
}

/**
 * The `getFontList` answer from the installed families' names: Chrome's `{ fontId,
 * displayName }` pairs (the same name twice here; Chrome's `fontId` is the family name too),
 * each family once, sorted by name as Chrome's picker shows them.
 */
export function familyList(names: Iterable<string>): FontName[] {
  const seen = new Set<string>()
  const out: FontName[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push({ fontId: name, displayName: name })
  }
  return out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' })
  )
}
