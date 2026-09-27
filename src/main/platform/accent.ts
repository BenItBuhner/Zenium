/**
 * The OS accent colour for the chrome (Settings › Appearance › Use system accent colour,
 * settings-116; Chrome's `browser.theme.follows_system_colors`, whose Windows reading is
 * `ui/color/win/accent_color_observer.cc`): Electron's `systemPreferences.getAccentColor()`
 * gives it on Windows (the DWM accent, `RRGGBBAA`) and macOS (the Appearance pane's accent);
 * Linux has no reading through Electron – the method is there in Electron 44 but returns ""
 * (measured by the W8-3 drive), so the guard is the platform's, not the method's presence.
 * Windows reports a change through `accent-color-changed`; macOS through the system colours
 * notification.
 *
 * Pure apart from the system object handed in: the tests drive it with a fake. The drives'
 * `--test-system-accent=<hex>` (`systemAccentOverride`) stands in for an OS accent where the X
 * server has none.
 */

/** The slice of Electron's `systemPreferences` the accent uses; a member may be absent off its OS. */
export interface SystemAccentSource {
  getAccentColor?(): string
  on?(event: 'accent-color-changed', listener: (event: unknown, newColor: string) => void): unknown
  subscribeNotification?(event: string, callback: (event: string) => void): number
}

/** macOS's notice that the system colours (the accent among them) changed. */
export const MAC_SYSTEM_COLORS_NOTIFICATION = 'NSSystemColorsDidChangeNotification'

/** The drives' flag: `--test-system-accent=<#rrggbb | rrggbb | rrggbbaa>`. */
export const TEST_SYSTEM_ACCENT_FLAG = '--test-system-accent'

/**
 * Electron's `RRGGBBAA` (or `RRGGBB`, with or without `#`) as the `#rrggbb` the chrome's tokens
 * take; null for anything that is not a colour.
 */
export function accentHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hex = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null
  return `#${hex.slice(0, 6).toLowerCase()}`
}

/** The accent the drives asked for on the command line, or null when the launch carries none. */
export function systemAccentOverride(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith(`${TEST_SYSTEM_ACCENT_FLAG}=`))
  return flag ? accentHex(flag.slice(TEST_SYSTEM_ACCENT_FLAG.length + 1)) : null
}

/**
 * The OS accent right now, `#rrggbb`, or null: an override first, else Windows' and macOS's
 * reading, else nothing (Linux, a system whose reading throws).
 */
export function readSystemAccent(
  system: SystemAccentSource,
  platform: NodeJS.Platform,
  override: string | null = null
): string | null {
  if (override) return override
  if (platform !== 'win32' && platform !== 'darwin') return null
  if (typeof system.getAccentColor !== 'function') return null
  try {
    return accentHex(system.getAccentColor())
  } catch {
    return null
  }
}

/**
 * Whether the host has an accent to follow at all: Windows and macOS with the method, or a
 * launch with the override. Where false, `ThemeHost.systemAccent` is left out and the Settings
 * row is held.
 */
export function systemAccentReadable(
  system: SystemAccentSource,
  platform: NodeJS.Platform,
  override: string | null = null
): boolean {
  if (override) return true
  return (
    (platform === 'win32' || platform === 'darwin') && typeof system.getAccentColor === 'function'
  )
}

/** Hear the OS accent change: Windows' event, macOS's notification; nothing elsewhere. */
export function watchSystemAccent(
  system: SystemAccentSource,
  platform: NodeJS.Platform,
  listener: () => void
): void {
  if (platform === 'win32') system.on?.('accent-color-changed', () => listener())
  else if (platform === 'darwin')
    system.subscribeNotification?.(MAC_SYSTEM_COLORS_NOTIFICATION, () => listener())
}
