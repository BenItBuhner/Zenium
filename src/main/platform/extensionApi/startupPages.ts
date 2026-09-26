import {
  effectiveStartup,
  resolveStartupOverride,
  sanitizeStartupPages,
  startupControls,
  type StartupOverride
} from '../../../core/startup'
import type { ApiHost, LoadedExtension } from './types'

/**
 * `chrome_settings_overrides.startup_pages` on the desktop: while an extension declaring it is
 * loaded (installed and enabled) it holds Settings › On startup – the mode is "Open a specific
 * page or set of pages" with its list – and the most recently installed one of several wins,
 * as Chrome's `SettingsOverridesAPI` layers the preference. Not an API namespace: manifest-
 * driven, no methods. What it publishes is the Settings page's half of the override
 * (`UIState.extensionControls` under `startup.mode` and `startup.pages`, §10.5's controlled
 * row); the boot's half reads the registry before any extension loads
 * (`ExtensionManager.startupPagesOverride`), and the two agree once the extensions have loaded.
 */
export class StartupPagesApi {
  private readonly installed = new Map<string, StartupOverride>()

  constructor(private readonly host: ApiHost) {}

  load(ext: LoadedExtension): void {
    const pages = sanitizeStartupPages(ext.manifest.chrome_settings_overrides?.startup_pages)
    if (pages.length === 0) {
      if (this.installed.delete(ext.id)) this.apply()
      return
    }
    const info = this.host.browser.extensions.list().find((record) => record.id === ext.id)
    this.installed.set(ext.id, {
      extensionId: ext.id,
      name: info?.name || ext.extension.name || ext.id,
      pages,
      installedAt: info?.installedAt ?? Date.now()
    })
    this.apply()
  }

  unload(extensionId: string): void {
    if (this.installed.delete(extensionId)) this.apply()
  }

  private apply(): void {
    const override = resolveStartupOverride([...this.installed.values()])
    const effective = effectiveStartup(this.host.browser.state.settings, override)
    this.host.controls.publish('startupPages', startupControls(effective))
  }
}
