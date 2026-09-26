import {
  COMMON_SCRIPT,
  FIXED_SIZE_KEY,
  FONT_PREFS,
  FONT_SETTINGS_PERMISSION,
  FONT_SETTINGS_PERMISSION_ERROR,
  GENERIC_SLOT_FAMILIES,
  SLOT_FAMILIES,
  checkDetails,
  controllableSlot,
  defaultFixedFontSizeResult,
  defaultFontSizeResult,
  effectiveFixedSize,
  extraPref,
  familyList,
  fontResult,
  hasFontValues,
  layerFonts,
  layerHolds,
  minimumFontSizeResult,
  normalizeFontDetails,
  normalizeFontValues,
  normalizeSetFontDetails,
  normalizeSizeDetails,
  pageFontLayer,
  parseFamilyKey,
  sameLayered,
  withExtraValue,
  withFixedSize,
  withFontValue,
  type FontEnvironment,
  type FontName,
  type FontPref,
  type FontRank,
  type FontValues,
  type GenericFamily,
  type LayeredFonts
} from '../../../core/extensions/api/fontSettings'
import { levelOfControlFor } from '../../../core/extensions/api/privacy'
import {
  FONT_FAMILY_SLOTS,
  electronScriptFontDefaults,
  type ExtensionFontLayer,
  type FontFamilySlot,
  type PageFontSettings
} from '../../../shared/fonts'
import type { ExtensionControl } from '../../../shared/types'
import { listFontFamilies } from './fontList'
import { installOrderRank } from './privacy'
import { ApiError, validated, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

export interface FontSettingsOptions {
  /** The OS the engine's default families are named for (`process.platform`). */
  platform?: string
  /** The installed families (the font directories' faces by default). */
  listFonts?: () => Promise<string[]>
}

/** The pages' hook for the part of the layer the setting has no slot for (`views.ts`). */
export interface FontPagesHook {
  /** The browser locale (`app.getLocale()`): the engine installs no per-script defaults for its own script. */
  locale: string
  /**
   * The seven-slot common families, the per-script families and the fixed-width size as the
   * extensions hold them, laid over whatever the pages have; null when nothing is held.
   */
  applyExtensionFonts(layer: ExtensionFontLayer | null): void
}

/**
 * `chrome.fontSettings` for the browser layer. Every extension holding `fontSettings` may set
 * any of Chrome's font preferences – a generic family for the common script or for one
 * script, the font size, the fixed-width size and the minimum font size; the values are kept
 * per extension (persisted across restarts) and laid over the user's page fonts setting
 * (Settings › Appearance › Customize fonts, CT-25) with Chrome's precedence – the most recently
 * installed loaded extension first, per preference (`core/extensions/api/fontSettings.ts`).
 * The preferences of the setting's shape reach the pages the way the user's setting does
 * (`Platform.pageFonts.apply`: new page views are made with it, open pages take it over the
 * DevTools protocol, the minimum size at their next load); the rest – the three slotless
 * families, every per-script family, the fixed-width size – goes through the pages' font hook
 * (`FontPagesHook`, `views.applyExtensionFonts`: `Page.setFontFamilies` with `forScripts`,
 * `Page.setFontSizes`' `fixed`, and a new page's web preferences). The user's own setting is
 * never written, so removing every extension value puts the user's fonts back. A user change
 * under the layer is re-layered (the state's broadcast is the one path every change takes).
 *
 * Chrome's events go to every loaded extension holding the permission, each with its own level
 * of control: `onFontChanged` per family whose face moved (with its script),
 * `onDefaultFontSizeChanged`, `onMinimumFontSizeChanged`, and `onDefaultFixedFontSizeChanged`
 * when the fixed-width size moved – an extension's, or the size's companion while none holds it.
 */
export class FontSettingsApi {
  /** By extension id. */
  private readonly values = new Map<string, FontValues>()
  /** The last layering handed to the pages (null before the first). */
  private effective: LayeredFonts | null = null
  /** Whether the pages hold a layer of ours right now (else the user's setting, untouched). */
  private layered = false
  /**
   * Per-script slots held once this session and let go (`familyKey`): the pages get the
   * engine's own family for them again rather than keeping the extension's.
   */
  private readonly released = new Set<string>()
  /** The last layer handed to the pages' hook (one string; `'null'`: nothing of ours), so an unchanged one is not sent. */
  private layerKey = 'null'
  private pages: FontPagesHook | null = null
  /** The user's setting as last seen (one string), for the state broadcast. */
  private userKey = ''
  private fontList: Promise<FontName[]> | null = null
  /** The installed families once the list was read (per-script defaults given as lists resolve against them). */
  private installed: ReadonlySet<string> | null = null
  private readonly platform: string
  private readonly listFonts: () => Promise<string[]>

  constructor(
    private readonly host: ApiHost,
    options: FontSettingsOptions = {}
  ) {
    this.platform = options.platform ?? process.platform
    this.listFonts = options.listFonts ?? (() => listFontFamilies())
  }

  readonly handlers: NamespaceHandlers = {
    getFontList: (ctx) => this.getFontList(ctx),
    getFont: (ctx, details) => this.getFont(ctx, details),
    setFont: (ctx, details) => this.setFont(ctx, details),
    clearFont: (ctx, details) => this.clearFont(ctx, details),
    getDefaultFontSize: (ctx, details) => this.getSize(ctx, details, 'size'),
    setDefaultFontSize: (ctx, details) => this.setSize(ctx, details, 'size'),
    clearDefaultFontSize: (ctx, details) => this.clearSize(ctx, details, 'size'),
    getDefaultFixedFontSize: (ctx, details) => this.getSize(ctx, details, 'fixed'),
    setDefaultFixedFontSize: (ctx, details) => this.setSize(ctx, details, 'fixed'),
    clearDefaultFixedFontSize: (ctx, details) => this.clearSize(ctx, details, 'fixed'),
    getMinimumFontSize: (ctx, details) => this.getSize(ctx, details, 'minimumSize'),
    setMinimumFontSize: (ctx, details) => this.setSize(ctx, details, 'minimumSize'),
    clearMinimumFontSize: (ctx, details) => this.clearSize(ctx, details, 'minimumSize')
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /**
   * Follow the user's setting: a change of it under a layer of ours is re-layered once the
   * broadcast is through (the page fonts service applies the user's setting on the same
   * broadcast, whichever of us the state calls first).
   */
  attach(): void {
    this.userKey = JSON.stringify(this.userFonts())
    this.host.browser.state.subscribe(() => {
      const key = JSON.stringify(this.userFonts())
      if (key === this.userKey) return
      this.userKey = key
      queueMicrotask(() => this.recompute())
    })
  }

  /**
   * The pages' hook for the layer beside the setting (`platform/index.ts`, once the views are
   * up): what the loaded extensions already hold goes out at once. Where the engine names
   * per-script defaults as lists (macOS, Windows), the installed families are read so the
   * lists resolve to what is there, as the engine resolves them.
   */
  attachPages(hook: FontPagesHook): void {
    this.pages = hook
    this.layerKey = 'null'
    if (this.effective) this.applyLayer(this.effective)
    if (Object.keys(electronScriptFontDefaults(this.platform, hook.locale)).length > 0) {
      // Once the list is in, a let-go slot's default may resolve to another installed family.
      void this.familyNames().then(() => {
        if (this.effective) this.applyLayer(this.effective)
      })
    }
  }

  /** An extension was loaded: its persisted values apply again. */
  load(extensionId: string): void {
    this.values.delete(extensionId)
    if (this.hasPermission(extensionId)) {
      const stored = normalizeFontValues(this.host.store.fontSettingsValues(extensionId))
      if (hasFontValues(stored)) this.values.set(extensionId, stored)
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

  /** The setting the pages have under the layer (for diagnostics and tests). */
  get fonts(): PageFontSettings {
    return this.current().fonts
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async getFontList(ctx: ApiContext): Promise<FontName[]> {
    this.checkPermission(ctx)
    return this.familyNames()
  }

  /** The installed families, read once; the set of them kept for the per-script defaults. */
  private familyNames(): Promise<FontName[]> {
    this.fontList ??= this.listFonts()
      .then((names) => {
        const list = familyList(names)
        this.installed = new Set(list.map((font) => font.fontId))
        return list
      })
      .catch(() => {
        this.fontList = null
        return []
      })
    return this.fontList
  }

  private getFont(ctx: ApiContext, details: unknown): unknown {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeFontDetails(details))
    return fontResult(wanted, this.current(), ctx.extensionId, this.platform, this.environment())
  }

  private setFont(ctx: ApiContext, details: unknown): void {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeSetFontDetails(details))
    const slot = controllableSlot(wanted)
    if (slot) this.write(ctx.extensionId, slot, wanted.fontId)
    else
      this.mutate(ctx.extensionId, (own) => withExtraValue(own, extraPref(wanted), wanted.fontId))
  }

  private clearFont(ctx: ApiContext, details: unknown): void {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeFontDetails(details))
    const slot = controllableSlot(wanted)
    if (slot) this.write(ctx.extensionId, slot, undefined)
    else this.mutate(ctx.extensionId, (own) => withExtraValue(own, extraPref(wanted), undefined))
  }

  private getSize(
    ctx: ApiContext,
    details: unknown,
    pref: 'size' | 'fixed' | 'minimumSize'
  ): unknown {
    this.checkPermission(ctx)
    validated(() => checkDetails(details))
    const layered = this.current()
    if (pref === 'size') return defaultFontSizeResult(layered, ctx.extensionId)
    if (pref === 'fixed') return defaultFixedFontSizeResult(layered, ctx.extensionId)
    return minimumFontSizeResult(layered, ctx.extensionId)
  }

  private setSize(ctx: ApiContext, details: unknown, pref: 'size' | 'fixed' | 'minimumSize'): void {
    this.checkPermission(ctx)
    if (pref === 'fixed') {
      // Chrome's `default_fixed_font_size` has the size's range.
      const value = validated(() => normalizeSizeDetails(details, 'size'))
      this.mutate(ctx.extensionId, (own) => withFixedSize(own, value))
      return
    }
    const value = validated(() => normalizeSizeDetails(details, pref))
    this.write(ctx.extensionId, pref, value)
  }

  private clearSize(
    ctx: ApiContext,
    details: unknown,
    pref: 'size' | 'fixed' | 'minimumSize'
  ): void {
    this.checkPermission(ctx)
    validated(() => checkDetails(details))
    if (pref === 'fixed') this.mutate(ctx.extensionId, (own) => withFixedSize(own, undefined))
    else this.write(ctx.extensionId, pref, undefined)
  }

  private checkPermission(ctx: ApiContext): void {
    if (!this.hasPermission(ctx.extensionId)) throw new ApiError(FONT_SETTINGS_PERMISSION_ERROR)
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private hasPermission(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(FONT_SETTINGS_PERMISSION)
  }

  private userFonts(): PageFontSettings {
    return this.host.browser.pageFonts.fonts
  }

  /** Chrome's precedence: installed most recently first, among the loaded extensions. */
  private ranker(): FontRank {
    const rank = installOrderRank(this.host, () => true)
    return (extensionId) => rank(extensionId, false)
  }

  /** The layering as it stands now (the user's setting read live: a change of it is on its way here). */
  private current(): LayeredFonts {
    return layerFonts(this.userFonts(), this.values, this.ranker())
  }

  /** Where the engine's own per-script and slotless families come from. */
  private environment(): FontEnvironment {
    return {
      platform: this.platform,
      locale: this.pages?.locale ?? 'en-US',
      installed: this.installed
    }
  }

  private write(extensionId: string, pref: FontPref, value: string | number | undefined): void {
    this.mutate(extensionId, (own) => withFontValue(own, pref, value))
  }

  /** Change one extension's values (`change` says whether anything moved); persisted, then re-layered. */
  private mutate(extensionId: string, change: (own: FontValues) => boolean): void {
    const own = this.values.get(extensionId) ?? {}
    if (!change(own)) return
    if (hasFontValues(own)) this.values.set(extensionId, own)
    else this.values.delete(extensionId)
    this.host.store.setFontSettingsValues(extensionId, own)
    this.recompute()
  }

  /**
   * Layer the values over the user's setting; a layering that moved is handed to the pages
   * (the user's own setting when the last extension value went, once) and, as in Chrome,
   * reported to every extension holding the permission, each with its own level of control.
   */
  private recompute(): void {
    const next = this.current()
    const prev = this.effective
    if (prev && sameLayered(prev, next)) return
    this.effective = next
    const controlled = layerHolds(next)
    if (controlled || this.layered) this.host.browser.platform.pageFonts?.apply(next.fonts)
    this.layered = controlled
    if (prev) {
      for (const key of Object.keys(prev.layer.controllers)) {
        if (parseFamilyKey(key) && !(key in next.layer.controllers)) this.released.add(key)
      }
    }
    for (const key of Object.keys(next.layer.controllers)) this.released.delete(key)
    this.applyLayer(next)
    this.publishControls(next)
    if (!prev) return
    this.announce(prev, next)
  }

  /** The layer beside the setting to the pages' hook, when it changed; null once nothing is held. */
  private applyLayer(layered: LayeredFonts): void {
    if (!this.pages) return
    const layer = pageFontLayer(layered, this.released, this.environment())
    const empty =
      Object.keys(layer.families).length === 0 &&
      Object.keys(layer.scripts).length === 0 &&
      Object.keys(layer.sizes).length === 0
    const key = empty ? 'null' : JSON.stringify(layer)
    if (key === this.layerKey) return
    this.layerKey = key
    this.pages.applyExtensionFonts(empty ? null : layer)
  }

  /**
   * The Settings page's "Controlled by <extension>" rows (`UIState.extensionControls`): every
   * preference an extension holds, under the Customize fonts row's key in `Settings['fonts']`
   * – the six preferences are the six rows, so the key is the preference's own name – with the
   * value in effect, the extension's, for the row's disabled control to show as Chrome's does.
   */
  private publishControls(layered: LayeredFonts): void {
    const controls: Record<string, ExtensionControl> = {}
    for (const pref of FONT_PREFS) {
      const controller = layered.controllers[pref]
      if (controller === null) continue
      const value = layered.fonts[pref]
      controls[`fonts.${pref}`] = {
        extensionId: controller,
        name: this.nameOf(controller),
        ...(value === null ? {} : { value })
      }
    }
    this.host.controls.publish('fontSettings', controls)
  }

  /** The extension's name as the Extensions page shows it (the id when nothing better is known). */
  private nameOf(extensionId: string): string {
    const info = this.host.browser.extensions.list().find((record) => record.id === extensionId)
    if (info?.name) return info.name
    const loaded = this.host.loaded(extensionId)
    return loaded?.extension.name || extensionId
  }

  private announce(prev: LayeredFonts, next: LayeredFonts): void {
    const listeners = this.host.allLoaded().filter((ext) => this.hasPermission(ext.id))
    if (listeners.length === 0) return
    const fire = (
      event: string,
      details: (extensionId: string) => Record<string, unknown>
    ): void => {
      for (const ext of listeners)
        this.host.dispatch(ext.id, 'fontSettings', event, [details(ext.id)])
    }
    const env = this.environment()
    const fontChanged = (script: string, genericFamily: GenericFamily): void => {
      fire('onFontChanged', (extensionId) => ({
        ...fontResult({ script, genericFamily }, next, extensionId, this.platform, env),
        script,
        genericFamily
      }))
    }
    for (const slot of FONT_FAMILY_SLOTS) {
      if (slotMoved(prev, next, slot)) fontChanged(COMMON_SCRIPT, SLOT_FAMILIES[slot])
    }
    // The families beside the setting: one held, let go, or moved to another extension's value.
    const keys = new Set([
      ...Object.keys(prev.layer.controllers),
      ...Object.keys(next.layer.controllers)
    ])
    for (const key of [...keys].sort()) {
      const family = parseFamilyKey(key)
      if (!family) continue
      const genericFamily = GENERIC_SLOT_FAMILIES[family.slot]
      const details = { script: family.script, genericFamily }
      const moved =
        prev.layer.controllers[key] !== next.layer.controllers[key] ||
        fontResult(details, prev, '', this.platform, env).fontId !==
          fontResult(details, next, '', this.platform, env).fontId
      if (moved) fontChanged(family.script, genericFamily)
    }
    if (prev.fonts.size !== next.fonts.size || prev.controllers.size !== next.controllers.size) {
      fire('onDefaultFontSizeChanged', (extensionId) => ({
        pixelSize: next.fonts.size,
        levelOfControl: levelOfControlFor(next.controllers.size, extensionId)
      }))
    }
    if (
      effectiveFixedSize(prev) !== effectiveFixedSize(next) ||
      prev.layer.controllers[FIXED_SIZE_KEY] !== next.layer.controllers[FIXED_SIZE_KEY]
    ) {
      fire('onDefaultFixedFontSizeChanged', (extensionId) => ({
        ...defaultFixedFontSizeResult(next, extensionId)
      }))
    }
    if (
      prev.fonts.minimumSize !== next.fonts.minimumSize ||
      prev.controllers.minimumSize !== next.controllers.minimumSize
    ) {
      fire('onMinimumFontSizeChanged', (extensionId) => ({
        pixelSize: next.fonts.minimumSize,
        levelOfControl: levelOfControlFor(next.controllers.minimumSize, extensionId)
      }))
    }
  }
}

function slotMoved(prev: LayeredFonts, next: LayeredFonts, slot: FontFamilySlot): boolean {
  return prev.fonts[slot] !== next.fonts[slot] || prev.controllers[slot] !== next.controllers[slot]
}
