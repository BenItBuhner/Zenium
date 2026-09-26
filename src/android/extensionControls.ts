import type { ExtensionControl } from '@shared/types'

/**
 * The settings the extensions hold, for the Settings page's "Controlled by <extension>" rows
 * (`UIState.extensionControls`; on the phone, W6-C6's Fonts page reads the `fonts.*` keys).
 * Each API that keeps a layer of extension values over a user setting publishes the keys it
 * holds under its own name – `fontSettings` today, as on the desktop (`extensionApi/controls.ts`
 * there, the same merge) – and the core's state gets the merge of every API's map, whole, so
 * one API's re-publish never drops another's keys. A publish that changes nothing stops here:
 * the state would otherwise commit a snapshot for it.
 */
export class ExtensionControlsMerge {
  private readonly byApi = new Map<string, Record<string, ExtensionControl>>()
  private merged: Record<string, ExtensionControl> = {}

  constructor(private readonly sink: (controls: Record<string, ExtensionControl>) => void) {}

  /** The map as last published, merged (tests and diagnostics). */
  get current(): Readonly<Record<string, ExtensionControl>> {
    return this.merged
  }

  publish(api: string, controls: Record<string, ExtensionControl>): void {
    if (Object.keys(controls).length === 0) this.byApi.delete(api)
    else this.byApi.set(api, controls)
    const merged: Record<string, ExtensionControl> = {}
    for (const map of this.byApi.values()) Object.assign(merged, map)
    if (sameControls(this.merged, merged)) return
    this.merged = merged
    this.sink(merged)
  }
}

/** Whether two maps name the same holder and value under every key (the rows would read the same). */
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
      other.extensionId === own.extensionId &&
      other.name === own.name &&
      other.value === own.value
    )
  })
}
