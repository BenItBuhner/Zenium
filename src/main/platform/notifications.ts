import { execFile } from 'node:child_process'
import type { PermissionService } from '../../core/permissions'
import type { NotificationPermissionStatus } from '../../shared/notifications'

/**
 * Must equal electron-builder's `appId`: the installer stamps it on the Start menu and desktop
 * shortcuts (`WinShell::SetLnkAUMI`), and Windows groups taskbar buttons and toast notifications
 * by it. A test holds the two in step.
 */
export const APP_USER_MODEL_ID = 'io.github.benitbuhner.zenium'

/**
 * Where Windows looks a desktop app's AppUserModelId up when no shortcut carries it. Under the
 * user's hive whatever the install mode, so build/installer.nsh's uninstaller deletes it from
 * HKCU too.
 */
export const WINDOWS_APP_ID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`

export type WindowsRegistryCommand = { file: 'reg.exe'; args: string[] }

/** What `reg.exe` answered: whether it succeeded, and what it printed. */
export type WindowsRegistryResult = { ok: boolean; stdout: string }

export type RunCommand = (command: WindowsRegistryCommand) => Promise<WindowsRegistryResult>

/**
 * The two values of the registration: `DisplayName` is the app name the toast shows; `IconUri`
 * the glyph next to it, null when the copy ships no icon file (and, read off the key, null when
 * the key holds no such value).
 */
export type WindowsAppIdValues = { DisplayName: string | null; IconUri: string | null }

const APP_ID_VALUE_NAMES = ['DisplayName', 'IconUri'] as const

/** `reg.exe query <key>`: the whole key in one read (both values); a failure when it is absent. */
export const WINDOWS_APP_ID_QUERY: WindowsRegistryCommand = {
  file: 'reg.exe',
  args: ['query', WINDOWS_APP_ID_KEY]
}

/**
 * What a toast notification needs on Windows besides the process's AppUserModelId: the id must be
 * registered, or `ToastNotificationManager.CreateToastNotifier` refuses it and the toast is
 * dropped without a word. Installed builds get that from the shortcuts the NSIS installer
 * creates; a portable, unpacked or development copy has no shortcut, so the same registration is
 * written under the current user's AppUserModelId class instead (what Microsoft's notification
 * libraries do for unpackaged apps). This is the registration the running build wants there.
 */
export function windowsAppIdValues(
  displayName: string,
  iconPath: string | null
): WindowsAppIdValues {
  return { DisplayName: displayName, IconUri: iconPath }
}

/**
 * The values `reg.exe query` listed for the key – one line per value, `<name>    REG_SZ
 * <data>` – or null when the query failed, which is what an absent key answers. A value the
 * listing does not name reads null.
 */
export function parseWindowsAppIdKey(result: WindowsRegistryResult): WindowsAppIdValues | null {
  if (!result.ok) return null
  const values: WindowsAppIdValues = { DisplayName: null, IconUri: null }
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^\s+(DisplayName|IconUri)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line)
    if (m) values[m[1] as (typeof APP_ID_VALUE_NAMES)[number]] = m[2]
  }
  return values
}

/**
 * The `reg.exe` commands that bring the key from `existing` (the empty pair for an absent key)
 * to `wanted`: a write per value that differs, a removal of a value the build has no
 * counterpart for (an `IconUri` naming another copy's file when this copy ships none), nothing
 * when the two agree – so a start with an up-to-date registration writes nothing.
 */
export function windowsAppIdRefresh(
  existing: WindowsAppIdValues,
  wanted: WindowsAppIdValues
): WindowsRegistryCommand[] {
  const commands: WindowsRegistryCommand[] = []
  for (const name of APP_ID_VALUE_NAMES) {
    const want = wanted[name]
    if (want === existing[name]) continue
    commands.push({
      file: 'reg.exe',
      args:
        want === null
          ? ['delete', WINDOWS_APP_ID_KEY, '/v', name, '/f']
          : ['add', WINDOWS_APP_ID_KEY, '/v', name, '/t', 'REG_SZ', '/d', want, '/f']
    })
  }
  return commands
}

const REGISTRY_TIMEOUT_MS = 10_000

// reg.exe prints in the console's code page: a value outside it (a user name beyond ASCII in
// the icon's path) reads back garbled, compares unequal and is written again each start – the
// same write an absent key gets, so the registration is right either way.
const runRegistryCommand: RunCommand = (command) =>
  new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      { windowsHide: true, timeout: REGISTRY_TIMEOUT_MS },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })
    )
  })

/**
 * `registered` when the key was absent and is written now, `refreshed` when it held another
 * copy's values (an installed build after an unpacked one, a switched app icon) and carries
 * this build's now, `current` when nothing had to be written, `failed` when the registry
 * refused.
 */
export type WindowsAppIdOutcome = 'registered' | 'refreshed' | 'current' | 'failed'

/**
 * Register the app id for toasts, and keep the registration the running build's: the key is
 * read whole, and only a value that differs is written – an installed build started after an
 * unpacked one replaces the unpacked copy's `IconUri` with its own, a build whose values are
 * already there writes nothing. Best effort and silent: notifications are the only thing that
 * depends on it.
 */
export async function ensureWindowsAppIdRegistered(
  displayName: string,
  iconPath: string | null,
  run: RunCommand = runRegistryCommand
): Promise<WindowsAppIdOutcome> {
  const wanted = windowsAppIdValues(displayName, iconPath)
  const existing = parseWindowsAppIdKey(await run(WINDOWS_APP_ID_QUERY))
  const commands = windowsAppIdRefresh(existing ?? { DisplayName: null, IconUri: null }, wanted)
  if (commands.length === 0) return 'current'
  for (const command of commands) if (!(await run(command)).ok) return 'failed'
  return existing ? 'refreshed' : 'registered'
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
