import {
  resolveExtensionSearch,
  searchProviderOf,
  type InstalledSearchProvider
} from '../../../core/extensions/searchProvider'
import type { ApiHost, LoadedExtension } from './types'

/**
 * `chrome_settings_overrides.search_provider` on the desktop: the engine each loaded extension
 * declares reaches the browser's search model while the extension is loaded (installed and
 * enabled), and the most recently installed one asking for `is_default` holds the default, as
 * Chrome's `SettingsOverridesAPI` does. Not an API namespace: manifest-driven, no methods.
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
  }
}
