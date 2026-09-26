import type { ExtensionControl } from '../../../shared/types'
import type { ApiHost } from './types'

/** Where the merged map goes: the core's state (`State.setExtensionControls`). */
export interface ExtensionControlsSink {
  setExtensionControls(controls: Record<string, ExtensionControl>): void
}

/**
 * The settings the extensions hold, for the Settings page's "Controlled by <extension>" rows
 * (`UIState.extensionControls`, Chrome's extension-controlled indicator). Each API that keeps
 * a layer of extension values over a user setting publishes the keys it holds under its own
 * name – `fontSettings`, `privacy`, `proxy`, `searchProvider` – and the sink gets the merge of
 * every API's map, so one API's re-publish never drops another's keys. A publish that changes
 * nothing stops here: the state would otherwise commit a snapshot for it.
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
      other !== undefined &&
      other.extensionId === a[key].extensionId &&
      other.name === a[key].name &&
      // The value in effect is part of what the row shows: the same extension moving its own
      // value (a family, a proxy mode, a switch) is a change the row must see.
      other.value === a[key].value
    )
  })
}

/**
 * The extension's name as the Extensions page shows it, for a control's "Controlled by <name>"
 * (the browser's record first, then the engine's, then the id when nothing better is known).
 */
export function extensionName(host: ApiHost, extensionId: string): string {
  const info = host.browser.extensions.list().find((record) => record.id === extensionId)
  if (info?.name) return info.name
  const loaded = host.loaded(extensionId)
  return loaded?.extension.name || extensionId
}
