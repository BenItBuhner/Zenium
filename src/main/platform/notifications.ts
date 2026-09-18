import { execFile } from 'node:child_process'
import type { PermissionService } from '../../core/permissions'
import type { NotificationPermissionStatus } from '../../shared/notifications'

/**
 * Must equal electron-builder's `appId`: the installer stamps it on the Start menu and desktop
 * shortcuts (`WinShell::SetLnkAUMI`), and Windows groups taskbar buttons and toast notifications
 * by it. A test holds the two in step.
 */
export const APP_USER_MODEL_ID = 'io.github.benitbuhner.zenium'

/** Where Windows looks a desktop app's AppUserModelId up when no shortcut carries it. */
export const WINDOWS_APP_ID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`

export type WindowsRegistryCommand = { file: 'reg.exe'; args: string[] }

/**
 * What a toast notification needs on Windows besides the process's AppUserModelId: the id must be
 * registered, or `ToastNotificationManager.CreateToastNotifier` refuses it and the toast is
 * dropped without a word. Installed builds get that from the shortcuts the NSIS installer
 * creates; a portable, unpacked or development copy has no shortcut, so the same registration is
 * written under the current user's AppUserModelId class instead (what Microsoft's notification
 * libraries do for unpackaged apps). `DisplayName` is the app name the toast shows; `IconUri` the
 * glyph next to it, when the copy ships one.
 */
export function windowsAppIdRegistration(
  displayName: string,
  iconPath: string | null
): { query: WindowsRegistryCommand; writes: WindowsRegistryCommand[] } {
  const add = (name: string, value: string): WindowsRegistryCommand => ({
    file: 'reg.exe',
    args: ['add', WINDOWS_APP_ID_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']
  })
  const writes = [add('DisplayName', displayName)]
  if (iconPath) writes.push(add('IconUri', iconPath))
  return {
    query: { file: 'reg.exe', args: ['query', WINDOWS_APP_ID_KEY, '/v', 'DisplayName'] },
    writes
  }
}

export type RunCommand = (command: WindowsRegistryCommand) => Promise<boolean>

const runRegistryCommand: RunCommand = (command) =>
  new Promise((resolve) => {
    execFile(command.file, command.args, { windowsHide: true }, (error) => resolve(!error))
  })

/**
 * Register the app id for toasts unless a registration exists already (an installed build's
 * shortcuts, or an earlier run). Best effort and silent: notifications are the only thing that
 * depends on it.
 */
export async function ensureWindowsAppIdRegistered(
  displayName: string,
  iconPath: string | null,
  run: RunCommand = runRegistryCommand
): Promise<boolean> {
  const { query, writes } = windowsAppIdRegistration(displayName, iconPath)
  if (await run(query)) return false
  for (const write of writes) if (!(await run(write))) return false
  return true
}

/**
 * What a page's `Notification.permission` should read. Electron's permission check is a yes or no,
 * which leaves an undecided site reading `denied` and never asking; the page preload reads this
 * instead and reports Chrome's three states.
 */
export function notificationPermissionStatus(
  permissions: PermissionService,
  pageUrl: string,
  tabId?: string
): NotificationPermissionStatus {
  if (!pageUrl) return 'denied'
  switch (permissions.resolve('notifications', pageUrl, { tabId })) {
    case 'allow':
      return 'granted'
    case 'deny':
      return 'denied'
    case 'ask':
      return 'default'
  }
}
