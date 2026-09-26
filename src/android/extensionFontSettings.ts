/**
 * `chrome.fontSettings` on the phone: Chrome's font preferences as a per-extension layer over
 * the user's page fonts (Settings › Appearance › Customize fonts, CT-25; `Settings.fonts`),
 * resolved by Chrome's precedence – the most recently installed attached extension first, per
 * preference, with `levelOfControl` per caller – by the shared model
 * (`core/extensions/api/fontSettings.ts`, the desktop host's resolution). The values are kept
 * per extension across sessions (the runtime's store, as the desktop keeps its bucket); the
 * user's own setting is never written, so a `clearFont`, a disable or an uninstall puts the
 * user's value back.
 *
 * What the layer reaches on the WebView, through the Kotlin host (`ext.fonts.apply`,
 * `Extensions.kt` → every tab WebView's `WebSettings`, live for the open ones and at creation
 * for the next): the six family setters, `setDefaultFontSize`, `setDefaultFixedFontSize`,
 * `setMinimumFontSize` – the common script's slotted families and the sizes as `WebSettings`'
 * own values, the slotless `cursive` and `fantasy` too. What `WebSettings` has no setter for –
 * a family for one script, the `math` family – goes as the `:lang()` stylesheet approximation
 * (`extensionFontStylesheet.ts`, its divergences stated there), inserted at document start and
 * replaced in place in the open documents on every layer change. What takes effect on this
 * engine is the recorded CT-25 limit's: the standard family and the three sizes; the
 * `serif`, `sansSerif`, `fixed`, `cursive` and `fantasy` setters are inert on Android WebView
 * (Blink resolves a page's generic keywords through Skia's `fonts.xml` aliases there,
 * `PageFonts.kt` says where), so a page's `font-family: serif` keeps the system serif – the
 * layer still holds them, `getFont` answers them, the controls publish them.
 *
 * `getFontList` on this engine: Blink resolves a family name through Skia's Android font
 * manager, whose name map is `fonts.xml`'s `<family name>` entries – a font file's own family
 * name ("Noto Sans CJK JP") does not resolve. So the list's `fontId`s are the named families
 * of the system's font configuration (what a page, and so the layer, can use), each with the
 * referenced font file's `name`-table family as its `displayName` (`FontFiles.kt`).
 *
 * The publish: every preference an extension holds goes to the core's
 * `state.setExtensionControls` under the Customize fonts row's keys (`fonts.<pref>`, #500's
 * shape; the desktop's six and the phone's `fonts.fixedSize`, `fonts.cursive`, `fonts.fantasy`,
 * `fonts.math`), the whole map on every change, never persisted – Android's W6-C6 Fonts page
 * reads it. Chrome's four events go to every attached extension holding the permission, each
 * with its own level of control.
 */
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
  effectiveFixedSize,
  extraPref,
  familyKey,
  hasFontValues,
  layerFonts,
  normalizeFontDetails,
  normalizeFontValues,
  normalizeSetFontDetails,
  normalizeSizeDetails,
  parseFamilyKey,
  sameLayered,
  withExtraValue,
  withFixedSize,
  withFontValue,
  type FontDetails,
  type FontName,
  type FontPref,
  type FontRank,
  type FontResult,
  type FontValues,
  type GenericFamily,
  type LayeredFonts,
  type SizeResult
} from '@core/extensions/api/fontSettings'
import { levelOfControlFor } from '@core/extensions/api/privacy'
import {
  FONT_FAMILY_SLOTS,
  type ExtensionFontLayer,
  type FontFamilySlot,
  type GenericFontSlot,
  type PageFontSettings
} from '@shared/fonts'
import type { ExtensionControl } from '@shared/types'
import type { AttachedExtension } from './extensionApi'
import { fontLayerStylesheet, fontStylesheetScript } from './extensionFontStylesheet'

export { FONT_SETTINGS_PERMISSION }

/**
 * The engine's own family per generic family on Android WebView: `WebSettings`' defaults are
 * the generic names, which Skia resolves through the system's `fonts.xml` (`PageFonts.kt`;
 * Zenium's standard is `serif`, Chrome's typographic default). `math` has no setter and no
 * default of its own: Chrome's empty name, "fall back".
 */
export const WEBVIEW_FONT_DEFAULTS: Readonly<Record<GenericFontSlot, string>> = {
  standard: 'serif',
  serif: 'serif',
  sansSerif: 'sans-serif',
  fixed: 'monospace',
  cursive: 'cursive',
  fantasy: 'fantasy',
  math: ''
}

/**
 * What `ext.fonts.apply` carries to the Kotlin host: the `WebSettings` values the extensions
 * hold (null: the user's setting's, or the engine's own, stands), the stylesheet for what
 * `WebSettings` cannot carry (empty: none) and the script that puts it into a document –
 * registered at document start on every tab WebView and run in the open documents on a change
 * (for an empty sheet it takes the previous one out). `ExtensionFontLayer.kt` lays it over
 * `PageFonts`.
 */
export interface WebViewFontLayer {
  standard: string | null
  serif: string | null
  sansSerif: string | null
  fixed: string | null
  cursive: string | null
  fantasy: string | null
  size: number | null
  fixedSize: number | null
  minimumSize: number | null
  css: string
  script: string
}

export const EMPTY_WEBVIEW_FONT_LAYER: Readonly<WebViewFontLayer> = {
  standard: null,
  serif: null,
  sansSerif: null,
  fixed: null,
  cursive: null,
  fantasy: null,
  size: null,
  fixedSize: null,
  minimumSize: null,
  css: '',
  script: fontStylesheetScript('')
}

/**
 * `getFontList`'s entries as the Kotlin host reads them (`ext.fonts.list`, `FontFiles.kt`):
 * `fontId` a name a page's `font-family` resolves on this engine, `displayName` what the font
 * file calls the family. Empty ids and ids seen before go; the order is the display name's, as
 * Chrome lists them.
 */
export function fontNameList(entries: Iterable<FontName>): FontName[] {
  const seen = new Set<string>()
  const out: FontName[] = []
  for (const entry of entries) {
    const fontId = entry.fontId.trim()
    if (fontId === '' || seen.has(fontId)) continue
    seen.add(fontId)
    const displayName = entry.displayName.trim()
    out.push({ fontId, displayName: displayName === '' ? fontId : displayName })
  }
  return out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' })
  )
}

/** The seam to the runtime (`extensionRuntime.ts` implements it; tests hand a fake). */
export interface FontSettingsHost {
  attached(id: string): AttachedExtension | undefined
  allAttached(): Iterable<AttachedExtension>
  /** Whether the extension holds `fontSettings`: declared, or optional and granted (`permissions.request`). */
  holdsPermission(ext: AttachedExtension): boolean
  /** An extension's persisted values (the runtime's store), and the write of them (`{}` forgets). */
  persistedValues(id: string): unknown
  persistValues(id: string, values: FontValues): void
  /** The user's setting (`Settings.fonts`), read live. */
  userFonts(): PageFontSettings
  /** The core state's broadcast (a Settings row, a sync merge): the layer is re-laid over the user's new value. */
  subscribe(listener: () => void): () => void
  /** The layer to the Kotlin host (`ext.fonts.apply`); null once nothing is held. */
  apply(layer: WebViewFontLayer | null): Promise<void>
  /** The installed families (`ext.fonts.list`: `fonts.xml`'s named families, the font files' `name` tables for the display names). */
  listFonts(): Promise<FontName[]>
  /** The controls the extensions hold, whole (`state.setExtensionControls` through the runtime's merge). */
  publish(controls: Record<string, ExtensionControl>): void
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  warn(message: string): void
}

/** The `WebSettings` part of a layering and its stylesheet, or null when no extension holds anything. */
export function webViewFontLayer(layered: LayeredFonts): WebViewFontLayer | null {
  const held = (pref: FontPref): boolean => layered.controllers[pref] !== null
  const extras = layered.layer.families
  const css = fontLayerStylesheet(stylesheetLayer(layered))
  const layer: WebViewFontLayer = {
    standard: held('standard') ? layered.fonts.standard : null,
    serif: held('serif') ? layered.fonts.serif : null,
    sansSerif: held('sansSerif') ? layered.fonts.sansSerif : null,
    fixed: held('fixed') ? layered.fonts.fixed : null,
    cursive: extras.cursive ?? null,
    fantasy: extras.fantasy ?? null,
    size: held('size') ? layered.fonts.size : null,
    fixedSize: layered.layer.fixedSize,
    minimumSize: held('minimumSize') ? layered.fonts.minimumSize : null,
    css,
    script: fontStylesheetScript(css)
  }
  const empty =
    css === '' &&
    Object.entries(layer).every(
      ([key, value]) => key === 'css' || key === 'script' || value === null
    )
  return empty ? null : layer
}

/** The part of a layering the stylesheet carries: the per-script families and the `math` family. */
function stylesheetLayer(layered: LayeredFonts): ExtensionFontLayer {
  const families: ExtensionFontLayer['families'] = {}
  if (layered.layer.families.math !== undefined) families.math = layered.layer.families.math
  return { families, scripts: layered.layer.scripts, sizes: {} }
}

/** `getFont`'s answer on the WebView: the layer's face, else the user's, else the engine's own generic name. */
export function webViewFontResult(
  details: FontDetails,
  layered: LayeredFonts,
  extensionId: string
): FontResult {
  const slot = controllableSlot(details)
  if (slot) {
    return {
      fontId: layered.fonts[slot] ?? WEBVIEW_FONT_DEFAULTS[slot],
      levelOfControl: levelOfControlFor(layered.controllers[slot], extensionId)
    }
  }
  const pref = extraPref(details)
  if (pref.kind === 'extra') {
    return {
      fontId: layered.layer.families[pref.family] ?? WEBVIEW_FONT_DEFAULTS[pref.family],
      levelOfControl: levelOfControlFor(
        layered.layer.controllers[familyKey(pref.family, COMMON_SCRIPT)] ?? null,
        extensionId
      )
    }
  }
  // A script's family the engine has no table for: Chrome's empty name for a script never set.
  return {
    fontId: layered.layer.scripts[pref.script]?.[pref.slot] ?? '',
    levelOfControl: levelOfControlFor(
      layered.layer.controllers[familyKey(pref.slot, pref.script)] ?? null,
      extensionId
    )
  }
}

/** Chrome's precedence among the attached extensions: the most recently installed ranks first. */
export function installOrderRank(attached: Iterable<AttachedExtension>): FontRank {
  const order = [...attached]
    .sort((a, b) => b.record.installedAt - a.record.installedAt)
    .map((ext) => ext.record.id)
  const ranks = new Map(order.map((id, index) => [id, index]))
  return (extensionId) => ranks.get(extensionId)
}

type SizePref = 'size' | 'fixed' | 'minimumSize'

export class AndroidFontSettings {
  /** By extension id. */
  private readonly values = new Map<string, FontValues>()
  /** The last layering computed (null before the first). */
  private effective: LayeredFonts | null = null
  /** The last layer handed to the Kotlin host (one string; `'null'`: nothing of ours), so an unchanged one is not sent. */
  private layerKey = 'null'
  /** The user's setting as last seen (one string), for the state broadcast. */
  private userKey = ''
  private fontList: Promise<FontName[]> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly host: FontSettingsHost) {}

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** Follow the user's setting: a change of it under a layer of ours is re-laid once the broadcast is through. */
  attach(): void {
    this.userKey = JSON.stringify(this.host.userFonts())
    this.unsubscribe?.()
    this.unsubscribe = this.host.subscribe(() => {
      const key = JSON.stringify(this.host.userFonts())
      if (key === this.userKey) return
      this.userKey = key
      queueMicrotask(() => this.recompute())
    })
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** The extension attached: its persisted values apply again. */
  load(ext: AttachedExtension): void {
    this.values.delete(ext.record.id)
    if (this.hasPermission(ext)) {
      const stored = normalizeFontValues(this.host.persistedValues(ext.record.id))
      if (hasFontValues(stored)) this.values.set(ext.record.id, stored)
    }
    this.recompute()
  }

  /** Disabled or detached: its values stop applying (the store keeps them for its return). */
  unload(extensionId: string): void {
    if (this.values.delete(extensionId)) this.recompute()
  }

  /** Uninstalled: the values go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.persistValues(extensionId, {})
  }

  /** The layering as it stands (diagnostics, tests). */
  get current(): LayeredFonts {
    return this.layering()
  }

  // ---------------------------------------------------------------------------
  // The calls: `chrome.fontSettings.<method>(details)`
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: readonly unknown[]): unknown {
    if (!this.hasPermission(ext)) throw new Error(FONT_SETTINGS_PERMISSION_ERROR)
    const details = args[0]
    switch (method) {
      case 'getFontList':
        return this.familyNames()
      case 'getFont':
        return webViewFontResult(normalizeFontDetails(details), this.layering(), ext.record.id)
      case 'setFont': {
        const wanted = normalizeSetFontDetails(details)
        const slot = controllableSlot(wanted)
        if (slot) this.write(ext.record.id, slot, wanted.fontId)
        else
          this.mutate(ext.record.id, (own) => withExtraValue(own, extraPref(wanted), wanted.fontId))
        return undefined
      }
      case 'clearFont': {
        const wanted = normalizeFontDetails(details)
        const slot = controllableSlot(wanted)
        if (slot) this.write(ext.record.id, slot, undefined)
        else this.mutate(ext.record.id, (own) => withExtraValue(own, extraPref(wanted), undefined))
        return undefined
      }
      case 'getDefaultFontSize':
        return this.getSize(ext, details, 'size')
      case 'setDefaultFontSize':
        return this.setSize(ext, details, 'size')
      case 'clearDefaultFontSize':
        return this.clearSize(ext, details, 'size')
      case 'getDefaultFixedFontSize':
        return this.getSize(ext, details, 'fixed')
      case 'setDefaultFixedFontSize':
        return this.setSize(ext, details, 'fixed')
      case 'clearDefaultFixedFontSize':
        return this.clearSize(ext, details, 'fixed')
      case 'getMinimumFontSize':
        return this.getSize(ext, details, 'minimumSize')
      case 'setMinimumFontSize':
        return this.setSize(ext, details, 'minimumSize')
      case 'clearMinimumFontSize':
        return this.clearSize(ext, details, 'minimumSize')
      default:
        throw new Error(`chrome.fontSettings.${method} is not implemented on Zenium for Android`)
    }
  }

  /** The installed families, read once from the Kotlin host; an empty list on a failure, read again next time. */
  private familyNames(): Promise<FontName[]> {
    this.fontList ??= this.host
      .listFonts()
      .then((entries) => fontNameList(entries))
      .catch((error: unknown) => {
        this.fontList = null
        this.host.warn(
          `fontSettings: the font list could not be read: ${error instanceof Error ? error.message : String(error)}`
        )
        return []
      })
    return this.fontList
  }

  private getSize(ext: AttachedExtension, details: unknown, pref: SizePref): SizeResult {
    checkDetails(details)
    const layered = this.layering()
    if (pref === 'size') {
      return {
        pixelSize: layered.fonts.size,
        levelOfControl: levelOfControlFor(layered.controllers.size, ext.record.id)
      }
    }
    if (pref === 'fixed') {
      return {
        pixelSize: effectiveFixedSize(layered),
        levelOfControl: levelOfControlFor(
          layered.layer.controllers[FIXED_SIZE_KEY] ?? null,
          ext.record.id
        )
      }
    }
    return {
      pixelSize: layered.fonts.minimumSize,
      levelOfControl: levelOfControlFor(layered.controllers.minimumSize, ext.record.id)
    }
  }

  private setSize(ext: AttachedExtension, details: unknown, pref: SizePref): undefined {
    if (pref === 'fixed') {
      // Chrome's `default_fixed_font_size` has the size's range.
      const value = normalizeSizeDetails(details, 'size')
      this.mutate(ext.record.id, (own) => withFixedSize(own, value))
      return undefined
    }
    const value = normalizeSizeDetails(details, pref)
    this.write(ext.record.id, pref, value)
    return undefined
  }

  private clearSize(ext: AttachedExtension, details: unknown, pref: SizePref): undefined {
    checkDetails(details)
    if (pref === 'fixed') this.mutate(ext.record.id, (own) => withFixedSize(own, undefined))
    else this.write(ext.record.id, pref, undefined)
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private hasPermission(ext: AttachedExtension): boolean {
    return this.host.holdsPermission(ext)
  }

  private layering(): LayeredFonts {
    return layerFonts(this.host.userFonts(), this.values, installOrderRank(this.host.allAttached()))
  }

  private write(extensionId: string, pref: FontPref, value: string | number | undefined): void {
    this.mutate(extensionId, (own) => withFontValue(own, pref, value))
  }

  /** Change one extension's values (`change` says whether anything moved); persisted, then re-laid. */
  private mutate(extensionId: string, change: (own: FontValues) => boolean): void {
    const own = this.values.get(extensionId) ?? {}
    if (!change(own)) return
    if (hasFontValues(own)) this.values.set(extensionId, own)
    else this.values.delete(extensionId)
    this.host.persistValues(extensionId, own)
    this.recompute()
  }

  /**
   * Lay the values over the user's setting; a layering that moved goes to the WebViews (the
   * user's setting alone, once, when the last extension value went), to the controls map, and
   * – as in Chrome – to every extension holding the permission, each with its own level of control.
   */
  private recompute(): void {
    const next = this.layering()
    const prev = this.effective
    if (prev && sameLayered(prev, next)) return
    this.effective = next
    this.applyLayer(next)
    this.publishControls(next)
    if (prev) this.announce(prev, next)
  }

  private applyLayer(layered: LayeredFonts): void {
    const layer = webViewFontLayer(layered)
    const key = layer ? JSON.stringify(layer) : 'null'
    if (key === this.layerKey) return
    this.layerKey = key
    this.host.apply(layer).catch((error: unknown) => {
      this.host.warn(
        `fontSettings: the WebViews did not take the layer: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  /**
   * The Settings page's "Controlled by <extension>" rows (`UIState.extensionControls`, W6-C6's
   * Fonts page on the phone): every preference an extension holds under the Customize fonts
   * row's key – the desktop's six (`fonts.<pref>`) and the phone's `fonts.fixedSize`,
   * `fonts.cursive`, `fonts.fantasy`, `fonts.math` – with the value in effect.
   */
  private publishControls(layered: LayeredFonts): void {
    const controls: Record<string, ExtensionControl> = {}
    const control = (
      key: string,
      controller: string | null,
      value: string | number | null
    ): void => {
      if (controller === null) return
      controls[key] = {
        extensionId: controller,
        name: this.nameOf(controller),
        ...(value === null ? {} : { value })
      }
    }
    for (const pref of FONT_PREFS)
      control(`fonts.${pref}`, layered.controllers[pref], layered.fonts[pref])
    for (const family of ['cursive', 'fantasy', 'math'] as const) {
      control(
        `fonts.${family}`,
        layered.layer.controllers[familyKey(family, COMMON_SCRIPT)] ?? null,
        layered.layer.families[family] ?? null
      )
    }
    control(
      `fonts.${FIXED_SIZE_KEY}`,
      layered.layer.controllers[FIXED_SIZE_KEY] ?? null,
      layered.layer.fixedSize
    )
    for (const [key, controller] of Object.entries(layered.layer.controllers)) {
      const family = parseFamilyKey(key)
      if (!family || family.script === COMMON_SCRIPT) continue
      control(
        `fonts.${family.slot}.${family.script}`,
        controller,
        layered.layer.scripts[family.script]?.[family.slot] ?? null
      )
    }
    this.host.publish(controls)
  }

  /** The extension's name as the Extensions page shows it (the id when it is gone). */
  private nameOf(extensionId: string): string {
    return this.host.attached(extensionId)?.manifest.name || extensionId
  }

  private announce(prev: LayeredFonts, next: LayeredFonts): void {
    const listeners = [...this.host.allAttached()].filter((ext) => this.hasPermission(ext))
    if (listeners.length === 0) return
    const fire = (
      event: string,
      details: (extensionId: string) => Record<string, unknown>
    ): void => {
      for (const ext of listeners)
        this.host.emit(ext.record.id, 'fontSettings', event, [details(ext.record.id)])
    }
    const fontChanged = (script: string, genericFamily: GenericFamily): void => {
      fire('onFontChanged', (extensionId) => ({
        ...webViewFontResult({ script, genericFamily }, next, extensionId),
        script,
        genericFamily
      }))
    }
    for (const slot of FONT_FAMILY_SLOTS) {
      if (slotMoved(prev, next, slot)) fontChanged(COMMON_SCRIPT, SLOT_FAMILIES[slot])
    }
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
        webViewFontResult(details, prev, '').fontId !== webViewFontResult(details, next, '').fontId
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
        pixelSize: effectiveFixedSize(next),
        levelOfControl: levelOfControlFor(
          next.layer.controllers[FIXED_SIZE_KEY] ?? null,
          extensionId
        )
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
