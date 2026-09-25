/**
 * `chrome.fontSettings` on the desktop: the extensions' fonts and sizes as a layer over the
 * user's Settings › Appearance › Customize fonts, resolved and reported as Chrome resolves its
 * font prefs (`font_settings_api.cc` over `ExtensionPrefValueMap`), and applied to pages the
 * way the user's setting is applied – the host hook `applyExtensionFonts` beside `applyFonts`
 * in `views.ts` takes the effective layer to open pages over the DevTools protocol and to new
 * ones through their web preferences.
 *
 * The values live per extension and per pref (`core/extensions/api/fontSettings.ts` has the
 * keys, the checks and the precedence), persisted in the API store so they survive a restart
 * as Chrome's do. The user's own setting is never written: what an extension sets sits over it,
 * and the setting stands again when the value is cleared or the extension is disabled or
 * uninstalled. `getFont` answers the value in effect – the controlling extension's, else the
 * user's setting for the four slots it has, else the engine's own default for this OS
 * (`electronGenericFontDefaults`; per script, Electron's per-script defaults on macOS and
 * Windows, none on Linux) – and every extension holding the permission hears of every change
 * of an effective value, with its own `levelOfControl`.
 *
 * `getFontList` is the installed families as the Settings page lists them: Local Font Access
 * (`queryLocalFonts()`) in a chrome document, which the desktop grants the permission to and
 * which the host runs with a user gesture (the API needs transient activation); cached for the
 * session.
 */

import {
  COMMON_SCRIPT,
  DEFAULT_FIXED_FONT_SIZE_PREF,
  DEFAULT_FONT_SIZE_PREF,
  FONT_SIZE_METHODS,
  FONT_SIZE_PREFS,
  MINIMUM_FONT_SIZE_PREF,
  effectivePref,
  fontChangedDetails,
  fontListOf,
  fontPrefKey,
  fontResult,
  fontSizeResult,
  isFontSizePref,
  levelOfControlFor,
  normalizeFontDetails,
  normalizeFontPrefValues,
  normalizePixelSize,
  normalizeSetFontDetails,
  normalizeUnusedDetails,
  parseFontPrefKey,
  sameEffective,
  type EffectivePref,
  type FontDetails,
  type FontName,
  type FontPrefValues,
  type FontRank,
  type FontSizePref,
  type GenericFamily,
  type ScriptCode
} from '../../../core/extensions/api/fontSettings'
import {
  DEFAULT_FONT_SETTINGS,
  electronGenericFontDefaults,
  electronScriptFontDefaults,
  firstAvailableFamily,
  monospaceFontSize,
  type ExtensionFontLayer,
  type FamilyMap,
  type GenericFontSlot,
  type PageFontSettings
} from '../../../shared/fonts'
import type { ExtensionControl } from '../../../shared/types'
import { installOrderRank } from './privacy'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** What the platform gives the API: the user's setting, the pages, the installed families. */
export interface FontSettingsPages {
  platform: string
  /** The browser's UI locale (`app.getLocale()`): its own script gets no per-script default. */
  locale: string
  userFonts(): PageFontSettings
  onUserFontsChanged(listener: (fonts: PageFontSettings) => void): () => void
  applyExtensionFonts(layer: ExtensionFontLayer | null): void
  /**
   * The installed families from a chrome document's `queryLocalFonts()`; null when no chrome
   * document is up to ask (the answer is not cached then).
   */
  installedFamilies(): Promise<string[] | null>
}

export const FONT_SETTINGS_PERMISSION_ERROR =
  "chrome.fontSettings requires the 'fontSettings' permission."

const PERMISSION = 'fontSettings'

/** Chrome's generic family names to the engine's slots. */
const SLOT_OF: Readonly<Record<GenericFamily, GenericFontSlot>> = {
  standard: 'standard',
  sansserif: 'sansSerif',
  serif: 'serif',
  fixed: 'fixed',
  cursive: 'cursive',
  fantasy: 'fantasy',
  math: 'math'
}

/** The four slots the user's setting has, by the engine's slot name. */
const USER_SLOTS: Readonly<Partial<Record<GenericFontSlot, keyof PageFontSettings>>> = {
  standard: 'standard',
  serif: 'serif',
  sansSerif: 'sansSerif',
  fixed: 'fixed'
}

/** The prefs the user's setting feeds: their effective value can change without any extension. */
const USER_PREF_KEYS: readonly string[] = [
  fontPrefKey('standard', COMMON_SCRIPT),
  fontPrefKey('serif', COMMON_SCRIPT),
  fontPrefKey('sansserif', COMMON_SCRIPT),
  fontPrefKey('fixed', COMMON_SCRIPT),
  ...FONT_SIZE_PREFS
]

/**
 * The Settings › Customise fonts rows, by their key in `UIState.extensionControls` (the
 * setting's path in `Settings`), and the pref each one sets: an extension holding the pref
 * holds the row. The fixed-width size has no row – Zenium derives it from the size – so an
 * extension's `setDefaultFixedFontSize` controls no row.
 */
const SETTINGS_ROWS: ReadonlyArray<readonly [key: string, pref: string]> = [
  ['fonts.standard', fontPrefKey('standard', COMMON_SCRIPT)],
  ['fonts.serif', fontPrefKey('serif', COMMON_SCRIPT)],
  ['fonts.sansSerif', fontPrefKey('sansserif', COMMON_SCRIPT)],
  ['fonts.fixed', fontPrefKey('fixed', COMMON_SCRIPT)],
  ['fonts.size', DEFAULT_FONT_SIZE_PREF],
  ['fonts.minimumSize', MINIMUM_FONT_SIZE_PREF]
]

const NO_PAGES: FontSettingsPages = {
  platform: process.platform,
  locale: 'en-US',
  userFonts: () => DEFAULT_FONT_SETTINGS,
  onUserFontsChanged: () => () => {},
  applyExtensionFonts: () => {},
  installedFamilies: async () => null
}

export class FontSettingsApi {
  /** Every loaded extension's values (the ones holding the permission), by extension id. */
  private readonly values = new Map<string, FontPrefValues>()
  /** The last resolution of every pref ever considered, for change detection and the layer. */
  private readonly effective = new Map<string, EffectivePref<string | number>>()
  /**
   * The per-script slots an extension controlled at some point this session: once named to
   * the pages, a slot keeps an entry in the layer (the engine's default once let go), so an
   * open page is taken back rather than left with the extension's family.
   */
  private readonly touchedScripts = new Map<string, Set<GenericFontSlot>>()
  private pages: FontSettingsPages = NO_PAGES
  private detachPages: (() => void) | null = null
  private fontList: Promise<FontName[]> | null = null
  /** The installed families once known (Chrome's `FirstAvailableOrFirst` for list defaults). */
  private installed: Set<string> | null = null
  private appliedLayer: string | null = null

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    getFontList: (ctx) => this.getFontList(ctx),
    getFont: (ctx, details) => this.getFont(ctx, details),
    setFont: (ctx, details) => this.setFont(ctx, details),
    clearFont: (ctx, details) => this.clearFont(ctx, details),
    ...this.sizeHandlers(DEFAULT_FONT_SIZE_PREF),
    ...this.sizeHandlers(DEFAULT_FIXED_FONT_SIZE_PREF),
    ...this.sizeHandlers(MINIMUM_FONT_SIZE_PREF)
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** The page views and the user's setting exist by the time the platform starts. */
  attach(pages: FontSettingsPages): void {
    this.detachPages?.()
    this.pages = pages
    this.detachPages = pages.onUserFontsChanged(() => this.recompute())
    this.recompute()
  }

  /** An extension was loaded: its persisted values apply again. */
  load(extensionId: string): void {
    this.values.delete(extensionId)
    if (this.hasPermission(extensionId)) {
      const stored = normalizeFontPrefValues(this.host.store.fontSettingsValues(extensionId))
      if (Object.keys(stored).length > 0) this.values.set(extensionId, stored)
    }
    this.recompute()
  }

  /** Disabled or gone from every session: its values stop applying (the store keeps them). */
  unload(extensionId: string): void {
    if (this.values.delete(extensionId)) this.recompute()
  }

  /** Uninstalled: the values go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.store.setFontSettingsValues(extensionId, {})
  }

  /** A newer install ranks above the older extensions' values. */
  installOrderChanged(): void {
    this.recompute()
  }

  /** The value in effect for a pref (for diagnostics and tests). */
  effectiveValue(key: string): string | number | undefined {
    return this.effective.get(key)?.value ?? this.browserValue(key)
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async getFontList(ctx: ApiContext): Promise<FontName[]> {
    this.requirePermission(ctx.extensionId)
    if (!this.fontList) {
      const pending = this.pages.installedFamilies().then(
        (families) => {
          if (families === null) {
            // No chrome document to ask right now: an empty list, asked again next time.
            if (this.fontList === pending) this.fontList = null
            return []
          }
          this.installed = new Set(families.map((f) => f.trim()))
          // A list default resolves against the installed families now: no event for that.
          this.recompute({ quiet: true })
          return fontListOf(families)
        },
        (error: unknown) => {
          if (this.fontList === pending) this.fontList = null
          throw new ApiError(error instanceof Error ? error.message : String(error))
        }
      )
      this.fontList = pending
    }
    return this.fontList
  }

  private getFont(ctx: ApiContext, details: unknown): unknown {
    this.requirePermission(ctx.extensionId)
    const font = wrap(() => normalizeFontDetails(details))
    const key = fontPrefKey(font.genericFamily, font.script)
    return fontResult(this.resolveFont(key, font), ctx.extensionId, this.ranker())
  }

  private setFont(ctx: ApiContext, details: unknown): void {
    this.requirePermission(ctx.extensionId)
    const font = wrap(() => normalizeSetFontDetails(details))
    this.setValue(ctx.extensionId, fontPrefKey(font.genericFamily, font.script), font.fontId)
  }

  private clearFont(ctx: ApiContext, details: unknown): void {
    this.requirePermission(ctx.extensionId)
    const font = wrap(() => normalizeFontDetails(details))
    this.clearValue(ctx.extensionId, fontPrefKey(font.genericFamily, font.script))
  }

  private sizeHandlers(pref: FontSizePref): NamespaceHandlers {
    const names = FONT_SIZE_METHODS[pref]
    return {
      [names.get]: (ctx, details) => {
        this.requirePermission(ctx.extensionId)
        wrap(() => normalizeUnusedDetails(details))
        return fontSizeResult(this.resolveSize(pref), ctx.extensionId, this.ranker())
      },
      [names.set]: (ctx, details) => {
        this.requirePermission(ctx.extensionId)
        const pixelSize = wrap(() => normalizePixelSize(details))
        this.setValue(ctx.extensionId, pref, pixelSize)
      },
      [names.clear]: (ctx, details) => {
        this.requirePermission(ctx.extensionId)
        wrap(() => normalizeUnusedDetails(details))
        this.clearValue(ctx.extensionId, pref)
      }
    }
  }

  private setValue(extensionId: string, key: string, value: string | number): void {
    const own = this.values.get(extensionId) ?? {}
    if (own[key] === value) return
    own[key] = value
    this.values.set(extensionId, own)
    this.host.store.setFontSettingsValues(extensionId, own)
    this.recompute()
  }

  private clearValue(extensionId: string, key: string): void {
    const own = this.values.get(extensionId)
    if (!own || !(key in own)) return
    delete own[key]
    if (Object.keys(own).length === 0) this.values.delete(extensionId)
    this.host.store.setFontSettingsValues(extensionId, own)
    this.recompute()
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private hasPermission(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(PERMISSION)
  }

  private requirePermission(extensionId: string): void {
    if (!this.hasPermission(extensionId)) throw new ApiError(FONT_SETTINGS_PERMISSION_ERROR)
  }

  /** Chrome's precedence: installed most recently first, among the loaded extensions. */
  private ranker(): FontRank {
    const rank = installOrderRank(this.host, () => true)
    return (extensionId) => rank(extensionId, false)
  }

  private valuesFor(key: string): ReadonlyMap<string, string | number> {
    const out = new Map<string, string | number>()
    for (const [extensionId, own] of this.values) {
      if (key in own) out.set(extensionId, own[key])
    }
    return out
  }

  private resolveFont(key: string, font: FontDetails): EffectivePref<string> {
    return effectivePref<string>(this.valuesFor(key), this.browserFont(font), this.ranker())
  }

  private resolveSize(pref: FontSizePref): EffectivePref<number> {
    return effectivePref<number>(this.valuesFor(pref), this.browserSize(pref), this.ranker())
  }

  /** The browser's own value for a pref: the user's setting, else the engine's default. */
  private browserValue(key: string): string | number | undefined {
    if (isFontSizePref(key)) return this.browserSize(key)
    const font = parseFontPrefKey(key)
    return font ? this.browserFont(font) : undefined
  }

  private browserSize(pref: FontSizePref): number {
    const user = this.pages.userFonts()
    if (pref === DEFAULT_FONT_SIZE_PREF) return user.size
    if (pref === MINIMUM_FONT_SIZE_PREF) return user.minimumSize
    return monospaceFontSize(user.size)
  }

  /**
   * The family in effect with no extension's value: for the common script the user's setting
   * where it has the slot, else the engine's own for this OS; for a script, Electron's
   * per-script default where this OS has one (a list resolving to the first installed family,
   * else the first), else none – text falls back to the common script's family.
   */
  private browserFont(font: FontDetails): string {
    const slot = SLOT_OF[font.genericFamily]
    if (font.script === COMMON_SCRIPT) {
      const userSlot = USER_SLOTS[slot]
      const chosen = userSlot ? this.pages.userFonts()[userSlot] : null
      if (typeof chosen === 'string' && chosen.length > 0) return chosen
      return electronGenericFontDefaults(this.pages.platform)[slot]
    }
    const list = electronScriptFontDefaults(this.pages.platform, this.pages.locale)[font.script]?.[
      slot
    ]
    return list ? firstAvailableFamily(list, this.installed) : ''
  }

  /**
   * Resolve every pref that has or had a value, or that the user's setting feeds; a value that
   * changed is reported through the pref's event to every loaded extension holding the
   * permission, each with its own level of control (a pref never resolved before counts as
   * having had the browser's value). Then the layer goes to the pages.
   */
  private recompute(options: { quiet?: boolean } = {}): void {
    const rank = this.ranker()
    const keys = new Set<string>([...USER_PREF_KEYS, ...this.effective.keys()])
    for (const own of this.values.values()) for (const key of Object.keys(own)) keys.add(key)
    for (const key of keys) {
      const browser = this.browserValue(key)
      if (browser === undefined) continue
      const next = effectivePref<string | number>(this.valuesFor(key), browser, rank)
      const prev = this.effective.get(key) ?? { value: browser, controller: null }
      this.effective.set(key, next)
      if (sameEffective(prev, next)) continue
      if (options.quiet) continue
      this.announce(key, next, rank)
    }
    this.applyLayer()
    this.publishControls()
  }

  /**
   * The Settings rows an extension holds, for the page's "Controlled by <extension>" lines:
   * the controlling extension of each row's pref, named as the Extensions page names it.
   */
  private publishControls(): void {
    const controls: Record<string, ExtensionControl> = {}
    for (const [key, pref] of SETTINGS_ROWS) {
      const controller = this.effective.get(pref)?.controller
      if (controller === null || controller === undefined) continue
      controls[key] = { extensionId: controller, name: this.nameOf(controller) }
    }
    this.host.controls.publish('fontSettings', controls)
  }

  private nameOf(extensionId: string): string {
    const info = this.host.browser.extensions.list().find((record) => record.id === extensionId)
    if (info?.name) return info.name
    const loaded = this.host.loaded(extensionId)
    return loaded?.extension.name || extensionId
  }

  private announce(key: string, next: EffectivePref<string | number>, rank: FontRank): void {
    const font = parseFontPrefKey(key)
    for (const ext of this.host.allLoaded()) {
      if (!this.hasPermission(ext.id)) continue
      if (font) {
        const details = fontChangedDetails(
          font,
          { value: String(next.value), controller: next.controller },
          ext.id,
          rank
        )
        this.host.dispatch(ext.id, 'fontSettings', 'onFontChanged', [details])
      } else if (isFontSizePref(key)) {
        this.host.dispatch(ext.id, 'fontSettings', FONT_SIZE_METHODS[key].event, [
          {
            pixelSize: Number(next.value),
            levelOfControl: levelOfControlFor(next.controller, ext.id, rank)
          }
        ])
      }
    }
  }

  /** The layer for the pages: every controlled pref, plus the per-script slots once controlled. */
  private applyLayer(): void {
    const families: FamilyMap = {}
    const scripts: Record<string, FamilyMap> = {}
    const sizes: ExtensionFontLayer['sizes'] = {}
    let any = false
    for (const [key, resolved] of this.effective) {
      if (resolved.controller === null) continue
      any = true
      if (isFontSizePref(key)) {
        const size = Number(resolved.value)
        if (key === DEFAULT_FONT_SIZE_PREF) sizes.standard = size
        else if (key === DEFAULT_FIXED_FONT_SIZE_PREF) sizes.fixed = size
        else sizes.minimum = size
        continue
      }
      const font = parseFontPrefKey(key)
      if (!font) continue
      const slot = SLOT_OF[font.genericFamily]
      if (font.script === COMMON_SCRIPT) {
        families[slot] = String(resolved.value)
        continue
      }
      ;(scripts[font.script] ??= {})[slot] = String(resolved.value)
      let touched = this.touchedScripts.get(font.script)
      if (!touched) this.touchedScripts.set(font.script, (touched = new Set()))
      touched.add(slot)
    }
    for (const [script, slots] of this.touchedScripts) {
      for (const slot of slots) {
        if (scripts[script]?.[slot] !== undefined) continue
        const genericFamily = (Object.keys(SLOT_OF) as GenericFamily[]).find(
          (name) => SLOT_OF[name] === slot
        )
        if (!genericFamily) continue
        ;(scripts[script] ??= {})[slot] = this.browserFont({
          genericFamily,
          script: script as ScriptCode
        })
        any = true
      }
    }
    const layer: ExtensionFontLayer | null = any ? { families, scripts, sizes } : null
    const key = JSON.stringify(layer)
    if (key === this.appliedLayer) return
    this.appliedLayer = key
    this.pages.applyExtensionFonts(layer)
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}
