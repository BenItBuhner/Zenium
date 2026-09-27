import {
  resolveExtensionSearch,
  searchProviderOf,
  type InstalledSearchProvider
} from '../../../core/extensions/searchProvider'
import type { ExtensionControl } from '../../../shared/types'
import type { ApiHost, LoadedExtension } from './types'

/**
 * The key the Settings page's default-engine row reads (`UIState.extensionControls`, the §10.5
 * controlled-setting primitive): Chrome's Search page marks its "Search engine used in the
 * address bar" row with the extension-controlled indicator while an extension holds the
 * default. The value is the extension's engine id, the row's picker value.
 */
export const SEARCH_CONTROL_KEY = 'search.defaultEngine'

/**
 * `chrome_settings_overrides.search_provider` on the desktop: the engine each loaded extension
 * declares reaches the browser's search model while the extension is loaded (installed and
 * enabled), and the most recently installed one asking for `is_default` holds the default, as
 * Chrome's `SettingsOverridesAPI` does. Not an API namespace: manifest-driven, no methods.
 * While one holds the default, the Settings page hears of it through `ApiHost.controls`
 * (`SEARCH_CONTROL_KEY`), dropped as the default returns to the user's pick.
 */
export class SearchProviderApi {
  private readonly installed = new Map<string, InstalledSearchProvider>()

  constructor(private readonly host: ApiHost) {}

  load(ext: LoadedExtension): void {
    const info = this.host.browser.extensions.list().find((record) => record.id === ext.id)
    const provider = searchProviderOf(ext.manifest, ext.id, info?.name || ext.extension.name)
    if (!provider) {
      if (this.installed.delete(ext.id)) this.apply()
      return
    }
    this.installed.set(ext.id, { provider, installedAt: info?.installedAt ?? Date.now() })
    this.apply()
  }

  unload(extensionId: string): void {
    if (this.installed.delete(extensionId)) this.apply()
  }

  private apply(): void {
    const { engines, control } = resolveExtensionSearch([...this.installed.values()])
    this.host.browser.state.setExtensionSearch(engines, control)
    const controls: Record<string, ExtensionControl> = {}
    if (control) {
      controls[SEARCH_CONTROL_KEY] = {
        extensionId: control.extensionId,
        name: control.extensionName,
        value: control.engineId
      }
    }
    this.host.controls.publish('searchProvider', controls)
  }
}
