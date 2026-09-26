import type { ExtensionControl } from '@shared/types'
import type { SettingControls } from './settingControls'

/**
 * The extension runtime's feed into the phone's ONE controls publisher, W6-C6's
 * `SettingControls` (`settingControls.ts`, #518): the settings the extensions hold, for the
 * Settings page's "Controlled by <extension>" rows (`UIState.extensionControls`; the phone's
 * Fonts page reads the `fonts.*` keys). Each API that keeps a layer of extension values over a
 * user setting publishes the keys it holds under its own name – `fontSettings` and `privacy`
 * today, as on the desktop (`extensionApi/controls.ts` there) – and `SettingControls` merges
 * every API's map, whole, into the core's state, so one API's re-publish never drops another's.
 *
 * What this gate adds is #525's value compare ahead of the merge: a publish whose keys, holders
 * and VALUES all stand as the API last published them stops here, a list value compared by its
 * entries (`sameValue`), so a re-publish of the same startup pages in a fresh array commits no
 * snapshot – `SettingControls` compares values by `===`, which is the same reading for the
 * scalars the phone's two APIs hold today and a stricter one for a list (round 21, R21-8: the
 * merge that lived here in round 20 folded into theirs; the one-line alternative, their
 * `sameControls` taking `sameValue`, is W6-C6's to take and would make this gate a plain pass).
 */
export class ExtensionControlsGate {
  private readonly last = new Map<string, Record<string, ExtensionControl>>()

  constructor(private readonly controls: SettingControls) {}

  /** The map as last published, merged over every API (tests and diagnostics). */
  get current(): Readonly<Record<string, ExtensionControl>> {
    return this.controls.current
  }

  /**
   * One API's layer, whole (an empty map lets go of everything it held). `true` when the layer
   * moved and went to the publisher; `false` when it read the same as the API's last publish.
   */
  publish(api: string, controls: Record<string, ExtensionControl>): boolean {
    const before = this.last.get(api) ?? {}
    if (sameControls(before, controls)) return false
    if (Object.keys(controls).length === 0) this.last.delete(api)
    else this.last.set(api, controls)
    this.controls.publish(api, controls)
    return true
  }
}

/**
 * Whether two maps name the same holder and value under every key (the rows would read the
 * same): a same-extension change of the VALUE alone is a change – the held row shows the value
 * in effect, so a new size or family republishes – the same value again is not.
 */
export function sameControls(
  a: Record<string, ExtensionControl>,
  b: Record<string, ExtensionControl>
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const other = b[key]
    const own = a[key]
    return (
      other !== undefined &&
      own !== undefined &&
      other.extensionId === own.extensionId &&
      other.name === own.name &&
      sameValue(other.value, own.value)
    )
  })
}

/**
 * The value in effect, a list compared by its entries (the desktop's `controls.ts` `sameValue`
 * of #525: scalars by `===`, a list by its length and entries in order – an extension's
 * startup pages; the phone's two publishing APIs hold scalars alone today).
 */
export function sameValue(a: ExtensionControl['value'], b: ExtensionControl['value']): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
    )
  return a === b
}
