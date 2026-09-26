/**
 * Page fonts (Settings › Appearance › Customize fonts; Chrome's chrome://settings/fonts, CT-25):
 * the families a page gets for text it leaves to the engine's defaults and for the generic
 * families it names (`serif`, `sans-serif`, `monospace`), the default size and the floor no text
 * may go under. Pure data and pure functions: the Electron host maps them onto a page view's
 * web preferences, the Android host onto every tab WebView's `WebSettings`, and the chrome's
 * Settings rows read the same shape.
 */

/**
 * The user's page fonts. A `null` family is the platform's own default (Chrome's per-platform
 * families, which Electron installs – `electronFontDefaults` – and fontconfig maps to the
 * system's faces on Linux; Android's `serif` / `sans-serif` / `monospace`), so a profile that
 * never touched the rows follows the OS like Chrome does.
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
    /** The three families only extensions name (`chrome.fontSettings`). */
    cursive?: string
    fantasy?: string
    math?: string
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

/** The setting's family slots, which are also the DevTools protocol's (`fixed` for monospace). */
export type FontFamilySlot = 'standard' | 'serif' | 'sansSerif' | 'fixed'
export const FONT_FAMILY_SLOTS: readonly FontFamilySlot[] = [
  'standard',
  'serif',
  'sansSerif',
  'fixed'
]

/** The engine's own families, by the setting's names (what a `null` family stands for). */
export type FontFamilyDefaults = Record<FontFamilySlot, string>

/**
 * The families a page is made with when the setting names none: Electron installs Chrome's
 * per-platform defaults on every page (`SetFontDefaults`, from Chrome's `locale_settings_*.grd`),
 * not Blink's own ("Courier New" everywhere). On Linux fontconfig maps the names to the
 * system's faces (`Monospace` is the generic alias, so the fixed face is the system's). Windows
 * has "Courier New" for fixed on paper and Consolas wherever ClearType is on – Chrome's alternate
 * default – which is the case that stands; the other is recorded, not handled.
 */
export function electronFontDefaults(platform: string): FontFamilyDefaults {
  switch (platform) {
    case 'darwin':
      return { standard: 'Times', serif: 'Times', sansSerif: 'Helvetica', fixed: 'Menlo' }
    case 'win32':
      return {
        standard: 'Times New Roman',
        serif: 'Times New Roman',
        sansSerif: 'Arial',
        fixed: 'Consolas'
      }
    default:
      return {
        standard: 'Times New Roman',
        serif: 'Times New Roman',
        sansSerif: 'Arial',
        fixed: 'Monospace'
      }
  }
}

/**
 * The families a page has under the setting, by slot: the user's choice, else the engine's
 * default for the slot (`electronFontDefaults`).
 */
export function cdpFontFamilies(
  fonts: PageFontSettings,
  defaults: FontFamilyDefaults
): Record<FontFamilySlot, string> {
  return {
    standard: fonts.standard ?? defaults.standard,
    serif: fonts.serif ?? defaults.serif,
    sansSerif: fonts.sansSerif ?? defaults.sansSerif,
    fixed: fonts.fixed ?? defaults.fixed
  }
}

/**
 * What `Page.setFontFamilies` gets to bring an open page from the families it `has` to the
 * ones `wanted` (both by `cdpFontFamilies`; a page starts with the families it was made with):
 * the slots that differ – a chosen family, or one chosen before and now let go, which is taken
 * back by naming the engine's default (the protocol has no "unset"). A slot the user never
 * touched is never named, so the page keeps exactly the face the engine gave it. `null` when
 * nothing needs sending.
 */
export function cdpFontFamilyChanges(
  has: Record<FontFamilySlot, string>,
  wanted: Record<FontFamilySlot, string>
): Partial<Record<FontFamilySlot, string>> | null {
  const changes: Partial<Record<FontFamilySlot, string>> = {}
  let any = false
  for (const slot of FONT_FAMILY_SLOTS) {
    if (has[slot] === wanted[slot]) continue
    changes[slot] = wanted[slot]
    any = true
  }
  return any ? changes : null
}

/** Whether the sizes an open page has (`has`) differ from the setting's (`wanted`): the change Blink restyles on its own. */
export function fontSizesMove(has: PageFontSettings, wanted: PageFontSettings): boolean {
  const a = chromiumFontPreferences(has)
  const b = chromiumFontPreferences(wanted)
  return (
    a.defaultFontSize !== b.defaultFontSize ||
    a.defaultMonospaceFontSize !== b.defaultMonospaceFontSize ||
    a.minimumFontSize !== b.minimumFontSize
  )
}

// ---------------------------------------------------------------------------
// The extensions' layer (`chrome.fontSettings`)
// ---------------------------------------------------------------------------

/**
 * Chrome's generic families: the setting's four slots plus the three the setting has no row
 * for, which only extensions name (the DevTools protocol's `FontFamilies` has all seven).
 */
export type GenericFontSlot = FontFamilySlot | 'cursive' | 'fantasy' | 'math'
export const GENERIC_FONT_SLOTS: readonly GenericFontSlot[] = [
  'standard',
  'serif',
  'sansSerif',
  'fixed',
  'cursive',
  'fantasy',
  'math'
]

/** Families by slot, for the common script or for one script; a slot absent is not named. */
export type FamilyMap = Partial<Record<GenericFontSlot, string>>

/**
 * What the extensions holding `fontSettings` control, resolved by the host
 * (`platform/extensionApi/fontSettings.ts`) and laid over the user's setting: Chrome layers an
 * extension's font prefs over the user's without writing them, and the user's own value comes
 * back when the extension's goes. Families are Chrome's font ids (family names); `''` is
 * Chrome's "fall back" (to the common script's family for a script, to the engine's own for
 * the common script). Per-script families have no counterpart in the setting, so `scripts`
 * is the layer's alone: every entry carries a concrete family (the host resolves a cleared
 * slot to the engine's per-script default, or `''` where the engine has none).
 */
export interface ExtensionFontLayer {
  families: FamilyMap
  scripts: Readonly<Record<string, FamilyMap>>
  sizes: { standard?: number; fixed?: number; minimum?: number }
}

const NO_EXTENSION_FONTS: ExtensionFontLayer = { families: {}, scripts: {}, sizes: {} }

/**
 * The fonts pages get: the user's setting with the extensions' layer over it. `settings` is
 * the setting's own shape with the layer's four slots and two sizes folded in (the shape the
 * setting's path consumes unchanged); the rest is the layer's alone.
 */
export interface EffectiveFonts {
  settings: PageFontSettings
  /**
   * The fixed-width size: the layer's when an extension set it, else the one that goes with
   * the user's size – Chrome's `default_fixed_font_size` is a pref of its own, which an
   * extension's `setDefaultFontSize` leaves where it is.
   */
  fixedSize: number
  /** The three families the setting has no row for, where the layer names them. */
  extras: Partial<Record<'cursive' | 'fantasy' | 'math', string>>
  scripts: Readonly<Record<string, FamilyMap>>
}

export function effectiveFonts(
  user: PageFontSettings,
  layer: ExtensionFontLayer | null
): EffectiveFonts {
  const over = layer ?? NO_EXTENSION_FONTS
  const slot = (name: FontFamilySlot): string | null => {
    const own = over.families[name]
    if (own === undefined) return user[name]
    return own === '' ? null : own
  }
  const size = over.sizes.standard ?? user.size
  const extras: EffectiveFonts['extras'] = {}
  for (const name of ['cursive', 'fantasy', 'math'] as const) {
    const own = over.families[name]
    if (own !== undefined && own !== '') extras[name] = own
  }
  return {
    settings: {
      standard: slot('standard'),
      serif: slot('serif'),
      sansSerif: slot('sansSerif'),
      fixed: slot('fixed'),
      size,
      minimumSize: over.sizes.minimum ?? user.minimumSize
    },
    fixedSize: over.sizes.fixed ?? monospaceFontSize(user.size),
    extras,
    scripts: over.scripts
  }
}

/** The effective fonts without the per-script families: what a page's web preferences can carry. */
export function effectiveFontsAsMade(fonts: EffectiveFonts): EffectiveFonts {
  return { ...fonts, scripts: {} }
}

/**
 * Electron's `WebPreferences` for the effective fonts: the setting's (`chromiumFontPreferences`)
 * with the layer's fixed-width size and the three extra families where the layer names them.
 */
export function chromiumEffectiveFontPreferences(fonts: EffectiveFonts): ChromiumFontPreferences {
  const prefs = chromiumFontPreferences(fonts.settings)
  prefs.defaultMonospaceFontSize = fonts.fixedSize
  if (fonts.extras.cursive) prefs.defaultFontFamily.cursive = fonts.extras.cursive
  if (fonts.extras.fantasy) prefs.defaultFontFamily.fantasy = fonts.extras.fantasy
  if (fonts.extras.math) prefs.defaultFontFamily.math = fonts.extras.math
  return prefs
}

/** The engine's own families for all seven slots. */
export type GenericFontDefaults = Record<GenericFontSlot, string>

/**
 * `electronFontDefaults` plus the three slots the setting has no row for. Electron's
 * `SetFontDefaults` copies Chrome's per-platform cursive (`IDS_CURSIVE_FONT_FAMILY`) onto every
 * page but has no map for fantasy or math (`font_defaults.cc`, `FamilyMapByName`), which stay
 * Blink's own: "Impact" and "Latin Modern Math" on every OS – what a page renders with, where
 * Chrome itself would say Papyrus and STIX Two Math on macOS and Cambria Math on Windows.
 */
export function electronGenericFontDefaults(platform: string): GenericFontDefaults {
  return {
    ...electronFontDefaults(platform),
    cursive: platform === 'darwin' ? 'Apple Chancery' : 'Comic Sans MS',
    fantasy: 'Impact',
    math: 'Latin Modern Math'
  }
}

/**
 * The per-script families Electron installs on every page (`font_defaults.cc`'s
 * `kFontDefaults`, the macOS and Windows tables of Chrome's `locale_settings_*.grd`; Linux
 * has none), by Chrome's script code and slot. A list is Chrome's ",a,b,c" form: the first
 * installed family, else the first (`gfx::FontList::FirstAvailableOrFirst`), resolved by
 * `firstAvailableFamily`. The entries for the browser locale's own script are left out, as
 * Electron leaves them out (the common-script families cover the user's own language).
 */
export type ScriptFontDefaults = Readonly<
  Record<string, Partial<Record<GenericFontSlot, readonly string[]>>>
>

const MAC_SCRIPT_FONT_DEFAULTS: ScriptFontDefaults = {
  Jpan: {
    standard: ['Hiragino Kaku Gothic ProN'],
    fixed: ['Osaka', 'BIZ UDGothic', 'Menlo'],
    serif: ['Hiragino Mincho ProN'],
    sansSerif: ['Hiragino Kaku Gothic ProN']
  },
  Hang: {
    standard: ['Apple SD Gothic Neo'],
    serif: ['AppleMyungjo'],
    sansSerif: ['Apple SD Gothic Neo']
  },
  Hans: {
    standard: ['PingFang SC', 'STHeiti'],
    serif: ['Songti SC'],
    sansSerif: ['PingFang SC', 'STHeiti'],
    cursive: ['Kaiti SC']
  },
  Hant: {
    standard: ['PingFang TC', 'Heiti TC'],
    serif: ['Songti TC'],
    sansSerif: ['PingFang TC', 'Heiti TC'],
    cursive: ['Kaiti TC']
  }
}

const WIN_SCRIPT_FONT_DEFAULTS: ScriptFontDefaults = {
  Jpan: {
    standard: ['Noto Sans JP', 'Noto Sans CJK JP', 'Meiryo', 'Yu Gothic'],
    fixed: ['BIZ UDGothic', 'MS Gothic'],
    serif: ['Noto Serif JP', 'Noto Serif CJK JP', 'Yu Mincho', 'MS PMincho'],
    sansSerif: ['Noto Sans JP', 'Noto Sans CJK JP', 'Meiryo', 'Yu Gothic']
  },
  Hang: {
    standard: ['Noto Sans KR', 'Noto Sans CJK KR', 'Malgun Gothic'],
    fixed: ['Gulimche'],
    serif: ['Noto Serif KR', 'Noto Serif CJK KR', 'Batang'],
    sansSerif: ['Noto Sans KR', 'Noto Sans CJK KR', 'Malgun Gothic'],
    cursive: ['Gungsuh']
  },
  Hans: {
    standard: ['Noto Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei'],
    fixed: ['NSimsun'],
    serif: ['Noto Serif SC', 'Noto Serif CJK SC', 'Simsun'],
    sansSerif: ['Noto Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei'],
    cursive: ['KaiTi']
  },
  Hant: {
    standard: ['Noto Sans TC', 'Noto Sans CJK TC', 'Microsoft JhengHei'],
    fixed: ['MingLiU'],
    serif: ['Noto Serif TC', 'Noto Serif CJK TC', 'PMingLiU'],
    sansSerif: ['Noto Sans TC', 'Noto Sans CJK TC', 'Microsoft JhengHei'],
    cursive: ['DFKai-SB']
  },
  Arab: { fixed: ['Courier New'], sansSerif: ['Segoe UI'] },
  Cyrl: {
    standard: ['Times New Roman'],
    fixed: ['Courier New'],
    serif: ['Times New Roman'],
    sansSerif: ['Arial']
  },
  Grek: {
    standard: ['Times New Roman'],
    fixed: ['Courier New'],
    serif: ['Times New Roman'],
    sansSerif: ['Arial']
  }
}

/**
 * The script Electron takes as the browser locale's own (`GetScriptOfBrowserLocale`): Chinese
 * by region, Korean and Japanese by name, else the language's script where one of the tables
 * has it. Only the scripts the tables know matter here.
 */
export function browserLocaleScript(locale: string): string | null {
  const tag = locale.replace(/_/g, '-')
  if (tag === 'zh-CN') return 'Hans'
  if (tag === 'zh-TW') return 'Hant'
  const language = tag.split('-')[0].toLowerCase()
  if (language === 'ko') return 'Hang'
  if (language === 'ja') return 'Jpan'
  if (['ar', 'fa', 'ur', 'ps', 'ug', 'ckb'].includes(language)) return 'Arab'
  if (['ru', 'uk', 'bg', 'be', 'mk', 'sr', 'kk', 'ky', 'mn', 'tg', 'tt', 'ba'].includes(language))
    return 'Cyrl'
  if (language === 'el') return 'Grek'
  return null
}

export function electronScriptFontDefaults(platform: string, locale: string): ScriptFontDefaults {
  const table =
    platform === 'darwin'
      ? MAC_SCRIPT_FONT_DEFAULTS
      : platform === 'win32'
        ? WIN_SCRIPT_FONT_DEFAULTS
        : {}
  const own = browserLocaleScript(locale)
  if (own === null || !(own in table)) return table
  const out: Record<string, Partial<Record<GenericFontSlot, readonly string[]>>> = {}
  for (const [script, slots] of Object.entries(table)) if (script !== own) out[script] = slots
  return out
}

/** Chrome's `FirstAvailableOrFirst` for a default given as a list: the first installed, else the first. */
export function firstAvailableFamily(
  list: readonly string[],
  installed: ReadonlySet<string> | null
): string {
  if (installed) for (const family of list) if (installed.has(family)) return family
  return list[0] ?? ''
}

/** The families an open page has or should have, for the common script and per script. */
export interface CdpFamilies {
  common: GenericFontDefaults
  scripts: Readonly<Record<string, FamilyMap>>
}

/**
 * The families a page has under the effective fonts: `cdpFontFamilies` for the four slots, the
 * layer's extras else the engine's own for the other three, and the layer's per-script
 * families as they are.
 */
export function cdpEffectiveFamilies(
  fonts: EffectiveFonts,
  defaults: GenericFontDefaults
): CdpFamilies {
  return {
    common: {
      ...cdpFontFamilies(fonts.settings, defaults),
      cursive: fonts.extras.cursive ?? defaults.cursive,
      fantasy: fonts.extras.fantasy ?? defaults.fantasy,
      math: fonts.extras.math ?? defaults.math
    },
    scripts: fonts.scripts
  }
}

/** What `Page.setFontFamilies` takes: the common-script slots that move, and per script the same. */
export interface CdpFamilyChanges {
  fontFamilies: FamilyMap
  forScripts?: Array<{ script: string; fontFamilies: FamilyMap }>
}

/**
 * `cdpFontFamilyChanges` over all seven slots and the per-script families: a script's slot
 * named before and now let go is taken back with `''`, which Blink reads as "no family for
 * this script" (the entry is erased and text falls back to the common script's family) – the
 * state the engine starts a page in where it installs no per-script default. `null` when
 * nothing needs sending.
 */
export function cdpEffectiveFamilyChanges(
  has: CdpFamilies,
  wanted: CdpFamilies
): CdpFamilyChanges | null {
  const fontFamilies: FamilyMap = {}
  let any = false
  for (const slot of GENERIC_FONT_SLOTS) {
    if (has.common[slot] === wanted.common[slot]) continue
    fontFamilies[slot] = wanted.common[slot]
    any = true
  }
  const forScripts: Array<{ script: string; fontFamilies: FamilyMap }> = []
  const scripts = new Set([...Object.keys(has.scripts), ...Object.keys(wanted.scripts)])
  for (const script of [...scripts].sort()) {
    const before = has.scripts[script] ?? {}
    const after = wanted.scripts[script] ?? {}
    const entry: FamilyMap = {}
    let moved = false
    for (const slot of GENERIC_FONT_SLOTS) {
      const from = before[slot]
      const to = after[slot]
      if (from === to) continue
      entry[slot] = to ?? ''
      moved = true
    }
    if (moved) forScripts.push({ script, fontFamilies: entry })
  }
  if (!any && forScripts.length === 0) return null
  return forScripts.length > 0 ? { fontFamilies, forScripts } : { fontFamilies }
}

/** `fontSizesMove` for the effective fonts: the layer's fixed-width size counts as well. */
export function effectiveSizesMove(has: EffectiveFonts, wanted: EffectiveFonts): boolean {
  return (
    fontSizesMove(has.settings, wanted.settings) ||
    has.fixedSize !== wanted.fixedSize ||
    has.settings.size !== wanted.settings.size ||
    has.settings.minimumSize !== wanted.settings.minimumSize
  )
}

/**
 * Told to an open document once a family changed and no size did (`views.ts` on the desktop in
 * the preload's isolated world, `PageFonts.kt` on Android through `evaluateJavascript`). A
 * generic-family change alone leaves the open document looking as it did: Blink's `kFontFamily`
 * invalidation ends in `StyleEngine::FontsNeedUpdate`, which since the reduced font-loading
 * invalidations only recomputes the elements whose style depends on font metrics (`ex`, `ch`,
 * `font-size-adjust`) – right for an `@font-face` load, where the family list stays and only
 * the face behind it changes, but the standard family's *name* is baked into every element's
 * computed font as its style is resolved (`FontBuilder::StandardFontFamily`), so text a page
 * leaves to the browser keeps the old face until something else recomputes its style. A size
 * change does that (`kStyle` → `StyleEngine::InitialStyleChanged`, every element); a family
 * alone needs asking. Registering an unused custom property asks exactly that
 * (`StyleEngine::PropertyRegistryChanged` marks every element for recalc and drops the
 * matched-properties cache) and renders nothing: no DOM mutation, no stylesheet, nothing a
 * page can see short of registering the same unguessable name. The name is fresh each time,
 * as a name registers once per document.
 */
export const FONT_RESTYLE_SCRIPT =
  "(() => { try { CSS.registerProperty({ name: '--zenium-fonts-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), syntax: '*', inherits: false }) } catch {} })()"
