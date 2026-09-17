import type { HostCapabilities, Platform } from './types'

/**
 * The toast, if any, that confirms a copy. Android below 13 says so for every copy; from 13 on
 * the OS shows its clipboard chip, and a second confirmation would only repeat it. Desktop is
 * another program's and keeps what it did before: nothing for the page menu's copies (Chrome
 * shows nothing either) and, where it always had one, its own toast (`desktopConfirmation`).
 */
export function copyConfirmation(
  os: Platform,
  capabilities: Pick<HostCapabilities, 'clipboardChip'>,
  confirmation: string,
  desktopConfirmation: string | null = null
): string | null {
  if (os === 'android') return capabilities.clipboardChip ? null : confirmation
  return desktopConfirmation
}
