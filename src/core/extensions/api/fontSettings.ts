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
 * The layer holds every preference Chrome's does. The common script's (`Zyyy`, Chrome's
 * "Default") family of the four slotted generic families and the two sizes fold into the
 * setting's own shape (`LayeredFonts.fonts`, applied the way the setting is applied); the rest
 * – a family for one script, the three slotless families, the fixed-width size – has no slot
 * in the setting and travels beside it (`LayeredFonts.layer`, applied through the pages' font
 * hook: `Page.setFontFamilies`' `forScripts` and the seven-slot `fontFamilies`,
 * `Page.setFontSizes`' `fixed`, and a new page's web preferences). What no extension holds
 * reads as the engine's own: Electron's per-platform families (`electronGenericFontDefaults`),
 * its per-script tables for macOS and Windows (`electronScriptFontDefaults`; Linux has none, so
 * the empty name, as Chrome answers a script the user never set), the size's fixed-width
 * companion (`monospaceFontSize`). The host (`main/platform/extensionApi/fontSettings.ts`)
 * keeps the values, ranks them, and hands both parts to the pages.
 */
import {
  electronFontDefaults,
  electronGenericFontDefaults,
  electronScriptFontDefaults,
  firstAvailableFamily,
  FONT_FAMILY_SLOTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  GENERIC_FONT_SLOTS,
  MINIMUM_FONT_SIZE_MAX,
  monospaceFontSize,
  type ExtensionFontLayer,
  type FamilyMap,
  type FontFamilySlot,
  type GenericFontSlot,
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

/** The three generic families the setting has no slot for: the engine's own until an extension names them. */
export type ExtraFamily = 'cursive' | 'fantasy' | 'math'
export const EXTRA_FAMILIES: readonly ExtraFamily[] = ['cursive', 'fantasy', 'math']

/** Every generic family's page-side slot (the DevTools protocol's `FontFamilies` has all seven). */
export const GENERIC_FAMILY_SLOTS: Readonly<Record<GenericFamily, GenericFontSlot>> = {
  ...FAMILY_SLOTS,
  cursive: 'cursive',
  fantasy: 'fantasy',
  math: 'math'
} as Record<GenericFamily, GenericFontSlot>

export const GENERIC_SLOT_FAMILIES: Readonly<Record<GenericFontSlot, GenericFamily>> = {
  ...SLOT_FAMILIES,
  cursive: 'cursive',
  fantasy: 'fantasy',
  math: 'math'
}

/**
 * The preferences that fold into the setting's shape: the four slotted families for the common
 * script and the two sizes (the Customize fonts rows, one each).
 */
export type FontPref = FontFamilySlot | 'size' | 'minimumSize'
export const FONT_PREFS: readonly FontPref[] = [...FONT_FAMILY_SLOTS, 'size', 'minimumSize']

/** The key of a preference beside the setting: a family's `<slot>.<script>`, or the fixed-width size. */
export const FIXED_SIZE_KEY = 'fixedSize'
export function familyKey(slot: GenericFontSlot, script: string): string {
  return `${slot}.${script}`
}
export function parseFamilyKey(key: string): { slot: GenericFontSlot; script: string } | null {
  const dot = key.indexOf('.')
  if (dot < 0) return null
  const slot = key.slice(0, dot)
  if (!(GENERIC_FONT_SLOTS as readonly string[]).includes(slot)) return null
  return { slot: slot as GenericFontSlot, script: key.slice(dot + 1) }
}

/** One extension's values (the regular scope; persisted). */
export interface FontValues {
  /** The common script's family of the four slotted generic families. */
  families?: Partial<Record<FontFamilySlot, string>>
  size?: number
  minimumSize?: number
  /** The common script's family of the three slotless generic families. */
  extras?: Partial<Record<ExtraFamily, string>>
  /** A family for one script (any generic family), by Chrome's script code. */
  scripts?: Record<string, FamilyMap>
  /** Chrome's `default_fixed_font_size`: a preference of its own, not the size's companion. */
  fixedSize?: number
}

/**
 * The part of the layer the setting has no slot for, resolved by the same precedence: the
 * first-ranked extension's value per entry, and who holds it (`familyKey` / `FIXED_SIZE_KEY`).
 */
export interface FontLayerExtras {
  families: Partial<Record<ExtraFamily, string>>
  scripts: Record<string, FamilyMap>
  /** An extension's fixed-width size; null while it follows the size. */
  fixedSize: number | null
  controllers: Record<string, string>
}

/** The setting the pages get and, per preference, the extension whose value it is (null: the user's). */
export interface LayeredFonts {
  fonts: PageFontSettings
  controllers: Record<FontPref, string | null>
  layer: FontLayerExtras
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

/** Whether the details name a preference that folds into the setting (the common script of a slotted family). */
export function controllableSlot(details: FontDetails): FontFamilySlot | null {
  if (details.script !== COMMON_SCRIPT) return null
  return FAMILY_SLOTS[details.genericFamily] ?? null
}

/**
 * A preference beside the setting, for details `controllableSlot` declines: the common
 * script's slotless family (`extra`), or a family for one script (`script`, any generic family).
 */
export type ExtraPref =
  { kind: 'extra'; family: ExtraFamily } | { kind: 'script'; script: string; slot: GenericFontSlot }

export function extraPref(details: FontDetails): ExtraPref {
  if (details.script === COMMON_SCRIPT) {
    return { kind: 'extra', family: details.genericFamily as ExtraFamily }
  }
  return {
    kind: 'script',
    script: details.script,
    slot: GENERIC_FAMILY_SLOTS[details.genericFamily]
  }
}

function familyName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name === '' ? null : name
}

/** A stored record brought into shape: known slots with non-empty names, sizes in range. */
export function normalizeFontValues(raw: unknown): FontValues {
  const out: FontValues = {}
  if (!raw || typeof raw !== 'object') return out
  const source = raw as Record<string, unknown>
  if (source.families && typeof source.families === 'object') {
    const families = source.families as Record<string, unknown>
    for (const slot of FONT_FAMILY_SLOTS) {
      const name = familyName(families[slot])
      if (name !== null) (out.families ??= {})[slot] = name
    }
  }
  if (typeof source.size === 'number' && Number.isInteger(source.size)) {
    out.size = normalizeSizeDetails({ pixelSize: source.size }, 'size')
  }
  if (typeof source.minimumSize === 'number' && Number.isInteger(source.minimumSize)) {
    out.minimumSize = normalizeSizeDetails({ pixelSize: source.minimumSize }, 'minimumSize')
  }
  if (typeof source.fixedSize === 'number' && Number.isInteger(source.fixedSize)) {
    out.fixedSize = normalizeSizeDetails({ pixelSize: source.fixedSize }, 'size')
  }
  if (source.extras && typeof source.extras === 'object') {
    const extras = source.extras as Record<string, unknown>
    for (const family of EXTRA_FAMILIES) {
      const name = familyName(extras[family])
      if (name !== null) (out.extras ??= {})[family] = name
    }
  }
  if (source.scripts && typeof source.scripts === 'object') {
    for (const [script, raw] of Object.entries(source.scripts as Record<string, unknown>)) {
      if (!SCRIPT_CODES.includes(script) || script === COMMON_SCRIPT) continue
      if (!raw || typeof raw !== 'object') continue
      const entry: FamilyMap = {}
      for (const slot of GENERIC_FONT_SLOTS) {
        const name = familyName((raw as Record<string, unknown>)[slot])
        if (name !== null) entry[slot] = name
      }
      if (Object.keys(entry).length > 0) (out.scripts ??= {})[script] = entry
    }
  }
  return out
}

export function hasFontValues(values: FontValues): boolean {
  return (
    values.size !== undefined ||
    values.minimumSize !== undefined ||
    values.fixedSize !== undefined ||
    Object.keys(values.families ?? {}).length > 0 ||
    Object.keys(values.extras ?? {}).length > 0 ||
    Object.keys(values.scripts ?? {}).length > 0
  )
}

/** An extension's value for a preference beside the setting, if it set one. */
export function extraValueOf(values: FontValues, pref: ExtraPref): string | undefined {
  if (pref.kind === 'extra') return values.extras?.[pref.family]
  return values.scripts?.[pref.script]?.[pref.slot]
}

/** Set a preference beside the setting (an empty name clears it, as `withFontValue`); whether anything moved. */
export function withExtraValue(
  values: FontValues,
  pref: ExtraPref,
  value: string | undefined
): boolean {
  if (value === '') value = undefined
  if (extraValueOf(values, pref) === value) return false
  if (pref.kind === 'extra') {
    if (value === undefined) {
      if (values.extras) delete values.extras[pref.family]
      if (values.extras && Object.keys(values.extras).length === 0) delete values.extras
    } else {
      ;(values.extras ??= {})[pref.family] = value
    }
    return true
  }
  const scripts = values.scripts ?? {}
  if (value === undefined) {
    const entry = scripts[pref.script]
    if (entry) {
      delete entry[pref.slot]
      if (Object.keys(entry).length === 0) delete scripts[pref.script]
    }
    if (Object.keys(scripts).length === 0) delete values.scripts
  } else {
    ;(scripts[pref.script] ??= {})[pref.slot] = value
    values.scripts = scripts
  }
  return true
}

/** Set the fixed-width size (undefined clears it); whether anything moved. */
export function withFixedSize(values: FontValues, value: number | undefined): boolean {
  if (values.fixedSize === value) return false
  if (value === undefined) delete values.fixedSize
  else values.fixedSize = value
  return true
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
  /** The first-ranked extension's value for one preference, read by `read`. */
  const winner = <T extends string | number>(
    read: (values: FontValues) => T | undefined
  ): { extensionId: string; value: T } | null => {
    let best: { extensionId: string; value: T; rank: number } | null = null
    for (const [extensionId, values] of layers) {
      const value = read(values)
      if (value === undefined) continue
      const r = rank(extensionId)
      if (r === undefined) continue
      if (!best || r < best.rank || (r === best.rank && extensionId < best.extensionId)) {
        best = { extensionId, value, rank: r }
      }
    }
    return best
  }

  const fonts: PageFontSettings = { ...user }
  const controllers = {} as Record<FontPref, string | null>
  for (const pref of FONT_PREFS) {
    const best = winner((values) => valueOf(values, pref))
    controllers[pref] = best ? best.extensionId : null
    if (!best) continue
    if (pref === 'size' || pref === 'minimumSize') fonts[pref] = best.value as number
    else fonts[pref] = best.value as string
  }

  const layer: FontLayerExtras = { families: {}, scripts: {}, fixedSize: null, controllers: {} }
  for (const family of EXTRA_FAMILIES) {
    const best = winner((values) => values.extras?.[family])
    if (!best) continue
    layer.families[family] = best.value
    layer.controllers[familyKey(family, COMMON_SCRIPT)] = best.extensionId
  }
  const scripts = new Set<string>()
  for (const values of layers.values()) {
    for (const script of Object.keys(values.scripts ?? {})) scripts.add(script)
  }
  for (const script of [...scripts].sort()) {
    for (const slot of GENERIC_FONT_SLOTS) {
      const best = winner((values) => values.scripts?.[script]?.[slot])
      if (!best) continue
      ;(layer.scripts[script] ??= {})[slot] = best.value
      layer.controllers[familyKey(slot, script)] = best.extensionId
    }
  }
  const fixed = winner((values) => values.fixedSize)
  if (fixed) {
    layer.fixedSize = fixed.value
    layer.controllers[FIXED_SIZE_KEY] = fixed.extensionId
  }
  return { fonts, controllers, layer }
}

export function sameLayered(a: LayeredFonts, b: LayeredFonts): boolean {
  return (
    JSON.stringify(a.fonts) === JSON.stringify(b.fonts) &&
    FONT_PREFS.every((pref) => a.controllers[pref] === b.controllers[pref]) &&
    JSON.stringify(a.layer) === JSON.stringify(b.layer)
  )
}

/** Whether any extension holds a preference of the setting's shape (the pages then take `fonts`). */
export function layerHolds(layered: LayeredFonts): boolean {
  return FONT_PREFS.some((pref) => layered.controllers[pref] !== null)
}

/**
 * What the effective fixed-width size is: an extension's, else the size's companion – Chrome's
 * `default_fixed_font_size` is its own preference, which the layer's `setDefaultFontSize`
 * leaves where it is, and Zenium's setting derives from the size.
 */
export function effectiveFixedSize(layered: LayeredFonts): number {
  return layered.layer.fixedSize ?? monospaceFontSize(layered.fonts.size)
}

/** Where the engine's own per-script and slotless families come from, for what no extension holds. */
export interface FontEnvironment {
  /** `process.platform`: the engine's tables are per OS. */
  platform: string
  /** The browser locale (`app.getLocale()`): its own script's per-script defaults are not installed. */
  locale: string
  /** The installed families once known (a default given as a list resolves to the first installed). */
  installed: ReadonlySet<string> | null
}

/** The engine's own family for a script's slot: Electron's table for the platform, `''` where it has none. */
export function scriptDefault(env: FontEnvironment, script: string, slot: GenericFontSlot): string {
  const list = electronScriptFontDefaults(env.platform, env.locale)[script]?.[slot]
  return list ? firstAvailableFamily(list, env.installed) : ''
}

/**
 * The layer the pages' font hook takes: the slotless families and the fixed-width size as the
 * extensions hold them, and per script every slot an extension holds – plus, for a script's
 * slot once held and let go (`released`, by `familyKey`), the engine's own family for it
 * again (`''` where the engine installs none), so the page does not keep the old face.
 */
export function pageFontLayer(
  layered: LayeredFonts,
  released: ReadonlySet<string>,
  env: FontEnvironment
): ExtensionFontLayer {
  const scripts: Record<string, FamilyMap> = {}
  for (const [script, families] of Object.entries(layered.layer.scripts)) {
    scripts[script] = { ...families }
  }
  for (const key of released) {
    const family = parseFamilyKey(key)
    if (!family) continue
    const { slot, script } = family
    if (script === COMMON_SCRIPT || scripts[script]?.[slot] !== undefined) continue
    // Where the engine has no family of its own the hook erases the slot by itself (a slot
    // that goes from the layer is sent as `''`); only a real default needs naming again.
    const fallback = scriptDefault(env, script, slot)
    if (fallback !== '') (scripts[script] ??= {})[slot] = fallback
  }
  const sizes: ExtensionFontLayer['sizes'] = {}
  if (layered.layer.fixedSize !== null) sizes.fixed = layered.layer.fixedSize
  return { families: { ...layered.layer.families }, scripts, sizes }
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

const DEFAULT_ENVIRONMENT: Omit<FontEnvironment, 'platform'> = { locale: 'en-US', installed: null }

/**
 * `getFont`'s answer: the family the pages have and the caller's say over it. For the common
 * script of a slotted family that is the user's or the layer's choice, else the engine's
 * default for the platform; for a slotless family the layer's, else the engine's own; for a
 * script's family the layer's, else the engine's per-script table for the platform, else the
 * empty name (Chrome's own value for a script the user never set, which the callers read as
 * "the Default font"). Never `not_controllable`: every preference is the layer's to hand over.
 */
export function fontResult(
  details: FontDetails,
  layered: LayeredFonts,
  extensionId: string,
  platform: string,
  env: Omit<FontEnvironment, 'platform'> = DEFAULT_ENVIRONMENT
): FontResult {
  const slot = controllableSlot(details)
  if (slot) {
    return {
      fontId: layered.fonts[slot] ?? electronFontDefaults(platform)[slot],
      levelOfControl: levelOfControlFor(layered.controllers[slot], extensionId)
    }
  }
  const pref = extraPref(details)
  if (pref.kind === 'extra') {
    return {
      fontId:
        layered.layer.families[pref.family] ?? electronGenericFontDefaults(platform)[pref.family],
      levelOfControl: levelOfControlFor(
        layered.layer.controllers[familyKey(pref.family, COMMON_SCRIPT)] ?? null,
        extensionId
      )
    }
  }
  return {
    fontId:
      layered.layer.scripts[pref.script]?.[pref.slot] ??
      scriptDefault({ platform, ...env }, pref.script, pref.slot),
    levelOfControl: levelOfControlFor(
      layered.layer.controllers[familyKey(pref.slot, pref.script)] ?? null,
      extensionId
    )
  }
}

export function defaultFontSizeResult(layered: LayeredFonts, extensionId: string): SizeResult {
  return {
    pixelSize: layered.fonts.size,
    levelOfControl: levelOfControlFor(layered.controllers.size, extensionId)
  }
}

/** The fixed-width size: an extension's where one set it, else the size's companion, and the caller's say. */
export function defaultFixedFontSizeResult(layered: LayeredFonts, extensionId: string): SizeResult {
  return {
    pixelSize: effectiveFixedSize(layered),
    levelOfControl: levelOfControlFor(
      layered.layer.controllers[FIXED_SIZE_KEY] ?? null,
      extensionId
    )
  }
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
