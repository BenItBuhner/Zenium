import {
  homepageControls,
  homepageOf,
  resolveHomepageOverride,
  type HomepageOverride
} from '../../../core/extensions/homepage'
import type { ApiHost, LoadedExtension } from './types'

/**
 * `chrome_settings_overrides.homepage` on the desktop: while an extension declaring it is
 * installed and enabled its page is the homepage – the Home action lands on it
 * (`BrowserState.effectiveHomepage`, through `defaultHomepageOf`) and Settings' Homepage rows
 * say who holds it (§10.5's controlled row) – and the most recently installed one of several
 * wins, as Chrome's `SettingsOverridesAPI` layers the preference. Not an API namespace:
 * manifest-driven, no methods; the sibling of `StartupPagesApi`, as the manifest key is the
 * sibling of `startup_pages`. What it publishes is the one control (`UIState.extensionControls`
 * under `homepage`, the page as its value), which both halves read – the core's Home action and
 * the chrome's rows – so the two never name different pages. Kept from the loaded set (the
 * manifest is the loaded extension's; a disabled extension is unloaded, so its page goes with
 * it), with names and install times from the registry records, the candidates offered in the
 * registry's order so a tie in install time answers as the registry would; no registry field,
 * since nothing needs the homepage before the extensions load – the Home button waits for the
 * user. A publish that changes nothing is dropped by `ExtensionControls`.
 */
export class HomepageApi {
  private readonly installed = new Map<string, HomepageOverride>()

  constructor(private readonly host: ApiHost) {}

  load(ext: LoadedExtension): void {
    const url = homepageOf(ext.manifest)
    if (!url) {
      if (this.installed.delete(ext.id)) this.publish()
      return
    }
    const record = this.host.browser.extensions.list().find((entry) => entry.id === ext.id)
    this.installed.set(ext.id, {
      extensionId: ext.id,
      name: record?.name || ext.extension.name,
      url,
      installedAt: record?.installedAt ?? Date.now()
    })
    this.publish()
  }

  unload(extensionId: string): void {
    if (this.installed.delete(extensionId)) this.publish()
  }

  /** The extension holding the homepage now, or null (for tests and diagnostics). */
  current(): HomepageOverride | null {
    return resolveHomepageOverride(this.candidates())
  }

  private publish(): void {
    this.host.controls.publish('homepage', homepageControls(this.current()))
  }

  /** The loaded overrides in the registry's order (an extension the registry lacks after them). */
  private candidates(): HomepageOverride[] {
    const rank = new Map(this.host.browser.extensions.list().map((entry, i) => [entry.id, i]))
    return [...this.installed.values()].sort(
      (a, b) =>
        (rank.get(a.extensionId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.extensionId) ?? Number.MAX_SAFE_INTEGER)
    )
  }
}
