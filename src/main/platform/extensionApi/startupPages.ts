import { effectiveStartup, startupControls } from '../../../core/startup'
import type { ApiHost } from './types'

/**
 * `chrome_settings_overrides.startup_pages` on the desktop: while an extension declaring it is
 * installed and enabled it holds Settings › On startup – the mode is "Open a specific page or
 * set of pages" with its list – and the most recently installed one of several wins, as
 * Chrome's `SettingsOverridesAPI` layers the preference. Not an API namespace: manifest-driven,
 * no methods. What it publishes is the Settings page's half of the override
 * (`UIState.extensionControls` under `startup.mode` and `startup.pages`, §10.5's controlled
 * row). The extension it names comes from the registry (`ExtensionHost.startupPagesOverride`,
 * `startupOverrideOf`) – the very source the boot read before any extension loaded – not from
 * the loaded extensions in the order they came up: the resolver breaks an `installedAt` tie by
 * record order, and a set kept in load order would have named another extension after a
 * disable-and-enable or an update moved the tied one to its end. One source, one answer;
 * a load, an unload and every registry change re-read it (a publish that changes nothing is
 * dropped by `ExtensionControls`).
 */
export class StartupPagesApi {
  constructor(private readonly host: ApiHost) {}

  /** The registry or the loaded set changed: publish what the registry says now. */
  refresh(): void {
    const override = this.host.browser.extensions.startupPagesOverride?.() ?? null
    const effective = effectiveStartup(this.host.browser.state.settings, override)
    this.host.controls.publish('startupPages', startupControls(effective))
  }
}
