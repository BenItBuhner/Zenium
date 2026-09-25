import {
  COMMON_SCRIPT,
  FONT_PREFS,
  FONT_SETTINGS_PERMISSION,
  FONT_SETTINGS_PERMISSION_ERROR,
  SLOT_FAMILIES,
  checkDetails,
  controllableSlot,
  defaultFixedFontSizeResult,
  defaultFontSizeResult,
  familyList,
  fontResult,
  hasFontValues,
  layerFonts,
  minimumFontSizeResult,
  normalizeFontDetails,
  normalizeFontValues,
  normalizeSetFontDetails,
  normalizeSizeDetails,
  sameLayered,
  withFontValue,
  type FontName,
  type FontPref,
  type FontRank,
  type FontValues,
  type LayeredFonts
} from '../../../core/extensions/api/fontSettings'
import { levelOfControlFor } from '../../../core/extensions/api/privacy'
import {
  FONT_FAMILY_SLOTS,
  monospaceFontSize,
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

/**
 * `chrome.fontSettings` for the browser layer. Every extension holding `fontSettings` may set
 * the common script's family of the four slotted generic families, the font size and the
 * minimum font size; the values are kept per extension (persisted across restarts) and laid
 * over the user's page fonts setting (Settings › Appearance › Customize fonts, CT-25) with
 * Chrome's precedence – the most recently installed loaded extension first, per preference
 * (`core/extensions/api/fontSettings.ts`). The layered setting reaches the pages the way the
 * user's does (`Platform.pageFonts.apply`: new page views are made with it, open pages take it
 * over the DevTools protocol, the minimum size at their next load); the user's own setting is
 * never written, so removing every extension value puts the user's fonts back. A user change
 * under the layer is re-layered (the state's broadcast is the one path every change takes).
 *
 * Chrome's events go to every loaded extension holding the permission, each with its own level
 * of control: `onFontChanged` per slotted family whose face moved (the common script),
 * `onDefaultFontSizeChanged`, `onMinimumFontSizeChanged`, and `onDefaultFixedFontSizeChanged`
 * when the derived fixed-width size moved (it follows the size and is `not_controllable`).
 */
export class FontSettingsApi {
  /** By extension id. */
  private readonly values = new Map<string, FontValues>()
  /** The last layering handed to the pages (null before the first). */
  private effective: LayeredFonts | null = null
  /** Whether the pages hold a layer of ours right now (else the user's setting, untouched). */
  private layered = false
  /** The user's setting as last seen (one string), for the state broadcast. */
  private userKey = ''
  private fontList: Promise<FontName[]> | null = null
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
    this.fontList ??= this.listFonts()
      .then((names) => familyList(names))
      .catch(() => {
        this.fontList = null
        return []
      })
    return this.fontList
  }

  private getFont(ctx: ApiContext, details: unknown): unknown {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeFontDetails(details))
    return fontResult(wanted, this.current(), ctx.extensionId, this.platform)
  }

  private setFont(ctx: ApiContext, details: unknown): void {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeSetFontDetails(details))
    const slot = controllableSlot(wanted)
    // A per-script or slotless family: Chrome's preference is not the layer's to hand over.
    if (!slot) return
    this.write(ctx.extensionId, slot, wanted.fontId)
  }

  private clearFont(ctx: ApiContext, details: unknown): void {
    this.checkPermission(ctx)
    const wanted = validated(() => normalizeFontDetails(details))
    const slot = controllableSlot(wanted)
    if (!slot) return
    this.write(ctx.extensionId, slot, undefined)
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
    if (pref === 'fixed') return defaultFixedFontSizeResult(layered)
    return minimumFontSizeResult(layered, ctx.extensionId)
  }

  private setSize(ctx: ApiContext, details: unknown, pref: 'size' | 'fixed' | 'minimumSize'): void {
    this.checkPermission(ctx)
    if (pref === 'fixed') {
      // Read for the shape; the fixed-width size follows the size here (`not_controllable`).
      validated(() => normalizeSizeDetails(details, 'size'))
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
    if (pref === 'fixed') return
    this.write(ctx.extensionId, pref, undefined)
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

  private write(extensionId: string, pref: FontPref, value: string | number | undefined): void {
    const own = this.values.get(extensionId) ?? {}
    if (!withFontValue(own, pref, value)) return
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
    const controlled = FONT_PREFS.some((pref) => next.controllers[pref] !== null)
    if (controlled || this.layered) this.host.browser.platform.pageFonts?.apply(next.fonts)
    this.layered = controlled
    this.publishControls(next)
    if (!prev) return
    this.announce(prev, next)
  }

  /**
   * The Settings page's "Controlled by <extension>" rows (`UIState.extensionControls`): every
   * preference an extension holds, under the Customize fonts row's key in `Settings['fonts']`
   * – the six preferences are the six rows, so the key is the preference's own name.
   */
  private publishControls(layered: LayeredFonts): void {
    const controls: Record<string, ExtensionControl> = {}
    for (const pref of FONT_PREFS) {
      const controller = layered.controllers[pref]
      if (controller === null) continue
      controls[`fonts.${pref}`] = { extensionId: controller, name: this.nameOf(controller) }
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
    for (const slot of FONT_FAMILY_SLOTS) {
      if (!slotMoved(prev, next, slot)) continue
      fire('onFontChanged', (extensionId) => ({
        ...fontResult(
          { script: COMMON_SCRIPT, genericFamily: SLOT_FAMILIES[slot] },
          next,
          extensionId,
          this.platform
        ),
        script: COMMON_SCRIPT,
        genericFamily: SLOT_FAMILIES[slot]
      }))
    }
    if (prev.fonts.size !== next.fonts.size || prev.controllers.size !== next.controllers.size) {
      fire('onDefaultFontSizeChanged', (extensionId) => ({
        pixelSize: next.fonts.size,
        levelOfControl: levelOfControlFor(next.controllers.size, extensionId)
      }))
    }
    if (monospaceFontSize(prev.fonts.size) !== monospaceFontSize(next.fonts.size)) {
      fire('onDefaultFixedFontSizeChanged', () => ({ ...defaultFixedFontSizeResult(next) }))
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
