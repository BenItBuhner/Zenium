import type { ExtensionControl } from '../../../shared/types'

/** Where the merged map goes: the core's state (`State.setExtensionControls`). */
export interface ExtensionControlsSink {
  setExtensionControls(controls: Record<string, ExtensionControl>): void
}

/**
 * The settings the extensions hold, for the Settings page's "Controlled by <extension>" rows
 * (`UIState.extensionControls`, Chrome's extension-controlled indicator). Each API that keeps
 * a layer of extension values over a user setting publishes the keys it holds under its own
 * name – `fontSettings` today; `privacy`, `proxy` as they take the primitive – and the sink
 * gets the merge of every API's map, so one API's re-publish never drops another's keys. A
 * publish that changes nothing stops here: the state would otherwise commit a snapshot for it.
 */
export class ExtensionControls {
  private readonly byApi = new Map<string, Record<string, ExtensionControl>>()
  private merged: Record<string, ExtensionControl> = {}

  constructor(private readonly sink: ExtensionControlsSink) {}

  /** The map as last published, merged (for tests and diagnostics). */
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
    this.sink.setExtensionControls(merged)
  }
}

function sameControls(
  a: Record<string, ExtensionControl>,
  b: Record<string, ExtensionControl>
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const other = b[key]
    return (
      other !== undefined && other.extensionId === a[key].extensionId && other.name === a[key].name
    )
  })
}
