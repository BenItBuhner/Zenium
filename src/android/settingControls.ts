import type { LayeredFonts, FontPref } from '@core/extensions/api/fontSettings'
import type { ExtensionControl } from '@shared/types'

/*
 * The settings the installed extensions hold, on Android: the host's side of #500's
 * controlled-setting primitive (`UIState.extensionControls`, the Settings page's "Controlled by
 * <extension>" rows – on the phone the action row whose press opens the extension's own page).
 * The Android twin of the desktop's `ExtensionControls` (`src/main/platform/extensionApi/
 * controls.ts`): each API that keeps a layer of extension values over a user setting publishes
 * the keys it holds under its own name and the core's state gets the merge of every API's map,
 * so one API's re-publish never drops another's keys; a publish that moves nothing stops here
 * (the state would otherwise commit a snapshot for it). Unlike the desktop's, a change of the
 * VALUE alone re-publishes too: the held row shows the value in effect, and an extension that
 * sets a new size is a change the row must draw.
 *
 * This is the seam the extension runtime calls; nothing on Android calls it yet. The WebView
 * `chrome.fontSettings` bridge (the extensions program's, round 20) resolves its extensions'
 * values into a `LayeredFonts` (`layerFonts`, `src/core/extensions/api/fontSettings.ts`) and
 * hands it to [publishFonts] – at load, on every `set*` / `clear*`, and on an extension's
 * disable, unload or uninstall (its layer gone: the pref falls to the next holder or to the
 * user's own, and the row stands free again) – beside applying the layered setting to the
 * pages through `platform.pageFonts.apply(layered.fonts)`, the one path the page WebViews take
 * (`PageFonts.kt`: the standard family and the sizes take effect; the generic-family slots are
 * inert on Android WebView, `capabilities.genericFontFamilies` off).
 */

/** Where the merged map goes: the core's state (`State.setExtensionControls`). */
export interface SettingControlsSink {
  setExtensionControls(controls: Record<string, ExtensionControl>): void
}

export class SettingControls {
  private readonly byApi = new Map<string, Record<string, ExtensionControl>>()
  private merged: Record<string, ExtensionControl> = {}

  constructor(private readonly sink: SettingControlsSink) {}

  /** The map as last published, merged (for tests and diagnostics). */
  get current(): Readonly<Record<string, ExtensionControl>> {
    return this.merged
  }

  /**
   * One API's layer, whole: the keys it holds now (an empty map lets go of everything it held).
   * The sink hears the merge when a key, its holder or its value moved.
   */
  publish(api: string, controls: Record<string, ExtensionControl>): void {
    if (Object.keys(controls).length === 0) this.byApi.delete(api)
    else this.byApi.set(api, controls)
    const merged: Record<string, ExtensionControl> = {}
    for (const map of this.byApi.values()) Object.assign(merged, map)
    if (sameControls(this.merged, merged)) return
    this.merged = merged
    this.sink.setExtensionControls(merged)
  }

  /**
   * The `fontSettings` layer as the bridge resolves it: every preference an extension holds,
   * under the Fonts page's key for it (`fonts.<pref>` – the six preferences are the six rows
   * of Settings › Customize fonts; the phone draws the standard family and the two sizes), with
   * the value in effect, the extension's, for the held row's control to show. `null` says no
   * extension holds any preference: the layer goes and the user's own values stand again.
   */
  publishFonts(layered: LayeredFonts | null, nameOf: (extensionId: string) => string): void {
    this.publish('fontSettings', fontControlsOf(layered, nameOf))
  }
}

/** The Fonts page's keys for a resolved layer (see `SettingControls.publishFonts`). */
export function fontControlsOf(
  layered: LayeredFonts | null,
  nameOf: (extensionId: string) => string
): Record<string, ExtensionControl> {
  const controls: Record<string, ExtensionControl> = {}
  if (!layered) return controls
  for (const [key, controller] of Object.entries(layered.controllers)) {
    if (controller === null) continue
    const pref = key as FontPref
    const value = layered.fonts[pref]
    controls[`fonts.${pref}`] = {
      extensionId: controller,
      name: nameOf(controller),
      // A `null` family is the engine's own (Chrome's "fall back"): the row keeps to the setting.
      ...(value === null ? {} : { value })
    }
  }
  return controls
}

function sameControls(
  a: Record<string, ExtensionControl>,
  b: Record<string, ExtensionControl>
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const mine = a[key]
    const other = b[key]
    return (
      mine !== undefined &&
      other !== undefined &&
      other.extensionId === mine.extensionId &&
      other.name === mine.name &&
      other.value === mine.value
    )
  })
}
