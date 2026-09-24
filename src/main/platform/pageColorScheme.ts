import type { ColorScheme } from '../../shared/types'

/** The `prefers-color-scheme` a page view is made to see; null leaves it to the engine. */
export type EmulatedColorScheme = Exclude<ColorScheme, 'system'>

/**
 * Whether a page view's `prefers-color-scheme` has to be emulated for the Appearance setting to
 * reach it. On Windows and macOS `nativeTheme.themeSource` flips every renderer's media query
 * with the native UI; on Linux (X11 and Wayland alike, measured under Xvfb with no settings
 * daemon) it flips `shouldUseDarkColors` and the native menus only – the web colour scheme stays
 * the system's, so an explicit Light or Dark never reaches pages. There, and only for an
 * explicit scheme, the view puts the setting's value on the page's session as an emulated media
 * feature (`Emulation.setEmulatedMedia`); `system` and the other platforms leave the engine to it.
 */
export function emulatedColorScheme(
  platform: NodeJS.Platform,
  scheme: ColorScheme
): EmulatedColorScheme | null {
  if (platform !== 'linux' || scheme === 'system') return null
  return scheme
}

/**
 * `Emulation.setEmulatedMedia`'s parameters for the override; an empty feature list releases it
 * (the page reads the engine's scheme again).
 */
export function emulatedMediaParams(scheme: EmulatedColorScheme | null): {
  features: Array<{ name: string; value: string }>
} {
  return { features: scheme ? [{ name: 'prefers-color-scheme', value: scheme }] : [] }
}
