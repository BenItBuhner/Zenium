import type { ExtensionControl } from '../../shared/types'
import { overrideUrl, type ManifestSettingsOverrides } from './searchProvider'

/**
 * `chrome_settings_overrides.homepage`: the page an extension makes the homepage while it is
 * installed and enabled, and which of several holds it (Chrome's `SettingsOverridesAPI` over
 * `ExtensionPrefValueMap`: the most recently installed enabled extension's value is in effect).
 * The sibling of `core/startup.ts`'s startup-pages override, as the manifest key is the
 * sibling of `startup_pages`: manifest-driven, no namespace, nothing written to the settings
 * or synced – the user's own homepage waits underneath and stands again when the extension
 * is disabled or uninstalled. Pure: the host (`extensionApi/homepage.ts`) keeps the loaded set
 * and publishes what this resolves.
 */

/** An enabled extension's homepage, as the host offers it to the resolver. */
export interface HomepageOverride {
  extensionId: string
  /** The extension's name as the Extensions page shows it. */
  name: string
  /** The page, an `http(s)` address (`homepageOf`). */
  url: string
  /** When the extension was installed: the newest of several overriding extensions wins. */
  installedAt: number
}

/**
 * The manifest's `chrome_settings_overrides.homepage` as the address Chrome would set, or null
 * when it declares none or one Chrome drops at install (the installer's check,
 * `checkSettingsOverrides`, is the strict half; this stays lenient and consistent with it): an
 * `http(s)` URL alone, the Web Store's install parameter substituted as Chrome's
 * `SubstituteInstallParam` does (`overrideUrl`).
 */
export function homepageOf(manifest: { chrome_settings_overrides?: unknown }): string | null {
  const overrides = manifest.chrome_settings_overrides
  if (typeof overrides !== 'object' || overrides === null) return null
  const url = overrideUrl((overrides as ManifestSettingsOverrides).homepage)
  return url ? url.href : null
}

/**
 * Chrome's precedence among extensions setting the same preference: the most recently installed
 * enabled one's value is in effect; a tie in install time goes to the first candidate, so a
 * caller offering them in the registry's order answers as the registry would.
 */
export function resolveHomepageOverride(
  candidates: readonly HomepageOverride[]
): HomepageOverride | null {
  let best: HomepageOverride | null = null
  for (const candidate of candidates) {
    if (!best || candidate.installedAt > best.installedAt) best = candidate
  }
  return best
}

/**
 * The `UIState.extensionControls` entry the Settings page's Homepage rows read
 * (`extensionControlled(state, 'homepage')`) and the core's `effectiveHomepage()` follows: the
 * extension's page as the control's value; none when no extension holds the setting.
 */
export function homepageControls(
  override: HomepageOverride | null
): Record<'homepage', ExtensionControl> | Record<string, never> {
  if (!override) return {}
  return {
    homepage: { extensionId: override.extensionId, name: override.name, value: override.url }
  }
}
