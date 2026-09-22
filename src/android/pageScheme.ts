import type { ColorScheme } from '@shared/types'

/**
 * The colour scheme handed to the host for the pages (`chrome.setTheme`'s `scheme`, which
 * `Host.applyTheme` turns into the app's night mode – `PageTheme.nightMode` – and dispatches to
 * every page WebView, so their `prefers-color-scheme` follows Zenium's Light / Dark choice): the
 * chrome's setting, once the chrome has painted the polarity that setting asks for.
 *
 * The setting changes a blend ahead of the colours (§11.6: the phone's tokens run from the theme
 * as painted to the new one over 240 ms, the scheme flipping at the midpoint, where the status
 * bar turns too – `zen-theme-painted`). Handed over on the setting itself, the pages flipped as
 * the blend began and the chrome followed half a blend later (the first emulator run of the fix
 * behind PC-13's note: the page's change event 400–450 ms before the chrome's `data-theme`).
 * Handed over as the paint crosses, every open page flips with the chrome – a frame apart on a
 * device – and a cut (the desktop's, reduced motion's, a hidden document's) crosses at once, so
 * nothing waits. Until the paint crosses the host keeps the scheme it has (`handed`; `null`
 * before the first hand-over, which is the setting as it stands).
 *
 * `paintedDark` is the polarity on the root (the last `zen-theme-painted`, or the setting's own
 * reading before the first paint); `systemDark` is what the chrome's own media query says, which
 * under `system` is the OS's side (the host follows the system then, so the chrome's WebView
 * reads the OS's scheme). A private surface in view paints dark whatever the setting (MOT-14):
 * a Light setting waits behind it and is handed over as the chrome blends back, with the pages.
 */
export function schemeForPages(
  handed: ColorScheme | null,
  scheme: ColorScheme,
  paintedDark: boolean,
  systemDark: boolean
): ColorScheme {
  const wanted = scheme === 'system' ? systemDark : scheme === 'dark'
  return handed === null || paintedDark === wanted ? scheme : handed
}
