/**
 * Windows brings Zenium back with its session after a restart or a sign-out (os-49). Chrome
 * registers itself with the Restart Manager (`RegisterApplicationRestart` with
 * `--restore-last-session`), and Windows relaunches it at the next sign-in when Settings ›
 * Accounts › Sign-in options › "Automatically save my restartable apps and restart them when I
 * sign back in" is on. Electron 44 exposes no `RegisterApplicationRestart`, so this is the
 * documented alternative Windows offers every app: when the session ends (the window's
 * `session-end`: a shutdown, a restart or a sign-out – past the point of no return, the process
 * is ended right after) the relaunch command goes under the user's `RunOnce` key, which Windows
 * runs once at the next sign-in and deletes. The same toggle gates it: its value
 * (`Winlogon\RestartApps`) is read at that moment, absent meaning the OS default – on since
 * Windows 11, off on Windows 10. A clean quit after a registration (nothing usual: the end of
 * the session normally ends the process) takes the entry back. No Electron here: the rules are
 * unit-tested, the hook takes the app and its windows structurally.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { RESTORE_LAST_SESSION_SWITCH, USER_DATA_DIR_SWITCH } from '../cli'
import type { WindowsRegistryCommand, WindowsRegistryResult } from './notifications'
import { quoteWindowsArg } from './webAppLauncher'

/** Where Windows runs a command once at the user's next sign-in, deleting the value first. */
export const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
/** The user's "restart my apps when I sign back in" toggle: `RestartApps` (REG_DWORD) here. */
export const RESTART_APPS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
export const RESTART_APPS_VALUE = 'RestartApps'
/** The first Windows 11 build: the toggle defaults to on from here, to off before. */
export const WINDOWS_11_BUILD = 22000
/** The RunOnce value's name: this for the default profile, `Zenium.<hash>` for another. */
export const RUN_ONCE_VALUE_PREFIX = 'Zenium'

/** How a Windows session ends, as Electron's `session-end` names it. */
export type SessionEndReason = 'shutdown' | 'close-app' | 'critical' | 'logoff'

export interface RestartEnvironment {
  execPath: string
  /** electron-builder's packaged app (true) or `electron <appPath>` in development. */
  isPackaged: boolean
  /** The app's directory in development (Electron's second argument). */
  appPath: string
  /** The profile the run was given with `--user-data-dir`, resolved; null for the default. */
  userDataDir: string | null
  /** `process.getSystemVersion()`: `10.0.22631` on Windows 11 23H2, `10.0.19045` on 10 22H2. */
  systemVersion: string
}

/** `reg.exe` run to completion: the session is ending, so nothing may wait on a promise. */
export type RunRegistrySync = (command: WindowsRegistryCommand) => WindowsRegistryResult

/**
 * Whether a sign-in follows this end of the session, so a relaunch registered now runs then: a
 * shutdown or restart (`shutdown`, `critical` when the system goes down hard) or a sign-out
 * (`logoff`). The Restart Manager closing the app for an installer (`close-app` alone) is no
 * end of the user's session – it restarts what it closed itself, in the same session – so a
 * RunOnce entry would surprise at some later sign-in instead. No reasons (a synthetic event)
 * read as a shutdown.
 */
export function relaunchAfter(reasons: readonly string[] | undefined): boolean {
  if (!reasons || reasons.length === 0) return true
  return reasons.some((reason) => reason === 'shutdown' || reason === 'logoff')
}

/**
 * The value name under RunOnce: `Zenium` for the default profile, `Zenium.<8 hex of the
 * profile's path>` for a `--user-data-dir` profile, so two profiles that were open both come
 * back and neither overwrites the other's entry.
 */
export function runOnceValueName(userDataDir: string | null): string {
  if (userDataDir === null) return RUN_ONCE_VALUE_PREFIX
  const hash = createHash('sha1').update(userDataDir.toLowerCase()).digest('hex').slice(0, 8)
  return `${RUN_ONCE_VALUE_PREFIX}.${hash}`
}

/**
 * The command Windows runs at the sign-in: this executable (Electron with the app's path in
 * development), the profile the run had when it was not the default, and
 * `--restore-last-session` – the switch that brings the last session back whatever "Restore
 * previous session" says, as Chrome's registration carries it. Each part quoted for spaces.
 */
export function restartCommand(env: RestartEnvironment): string {
  const parts = [env.execPath]
  if (!env.isPackaged) parts.push(env.appPath)
  if (env.userDataDir !== null) parts.push(`--${USER_DATA_DIR_SWITCH}=${env.userDataDir}`)
  parts.push(`--${RESTORE_LAST_SESSION_SWITCH}`)
  return parts.map(quoteWindowsArg).join(' ')
}

/** `reg.exe query` for the toggle's value alone. */
export const RESTART_APPS_QUERY: WindowsRegistryCommand = {
  file: 'reg.exe',
  args: ['query', RESTART_APPS_KEY, '/v', RESTART_APPS_VALUE]
}

/**
 * The DWORD `reg.exe query … /v <name>` printed (`    RestartApps    REG_DWORD    0x1`), or null
 * when the query failed (no such value) or printed no DWORD line.
 */
export function parseRegDword(result: WindowsRegistryResult): number | null {
  if (!result.ok) return null
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^\s+\S+\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/i.exec(line)
    if (m) return Number(m[1])
  }
  return null
}

/** The build number out of `process.getSystemVersion()` (`10.0.22631` → 22631); 0 when unreadable. */
export function windowsBuild(systemVersion: string): number {
  const m = /^\d+\.\d+\.(\d+)/.exec(systemVersion.trim())
  return m ? Number(m[1]) : 0
}

/**
 * Whether the user has Windows restart their apps after a sign-in: the toggle's value when it
 * is set (non-zero is on), else the OS's default for it – on for Windows 11 (build 22000 and
 * up), off for Windows 10, which shipped the toggle off.
 */
export function restartAppsEnabled(toggle: WindowsRegistryResult, systemVersion: string): boolean {
  const value = parseRegDword(toggle)
  if (value !== null) return value !== 0
  return windowsBuild(systemVersion) >= WINDOWS_11_BUILD
}

/** The `reg.exe` write of the RunOnce entry for this profile. */
export function runOnceWrite(env: RestartEnvironment): WindowsRegistryCommand {
  return {
    file: 'reg.exe',
    args: [
      'add',
      RUN_ONCE_KEY,
      '/v',
      runOnceValueName(env.userDataDir),
      '/t',
      'REG_SZ',
      '/d',
      restartCommand(env),
      '/f'
    ]
  }
}

/** The `reg.exe` removal of this profile's RunOnce entry. */
export function runOnceDelete(userDataDir: string | null): WindowsRegistryCommand {
  return {
    file: 'reg.exe',
    args: ['delete', RUN_ONCE_KEY, '/v', runOnceValueName(userDataDir), '/f']
  }
}

/** `reg.exe query` for this profile's RunOnce entry alone (what the smoke reads back). */
export function runOnceQuery(userDataDir: string | null): WindowsRegistryCommand {
  return {
    file: 'reg.exe',
    args: ['query', RUN_ONCE_KEY, '/v', runOnceValueName(userDataDir)]
  }
}

/**
 * What a registration attempt came to: `registered` (the entry is written), `off` (the user
 * has the toggle off, nothing written), `skipped` (this end of the session has no sign-in
 * following it), `failed` (the registry refused the write).
 */
export type RestartRegistrationOutcome = 'registered' | 'off' | 'skipped' | 'failed'

export interface WindowsRestartRegistration {
  /** The session is ending for `reasons`: write the entry when a sign-in follows and the toggle allows. */
  register(reasons: readonly string[] | undefined): RestartRegistrationOutcome
  /** A clean quit: an entry this run wrote goes; `true` when one was there to take back. */
  unregister(): boolean
  /** Whether this run's entry stands. */
  readonly registered: boolean
}

/**
 * The registration for one run: `register` writes the RunOnce entry once (every window gets
 * its own `session-end`; the first one does the work), `unregister` takes back what this run
 * wrote and nothing else – another profile's entry, or one an earlier run left, is not this
 * run's to delete.
 */
export function windowsRestartRegistration(
  env: RestartEnvironment,
  run: RunRegistrySync
): WindowsRestartRegistration {
  let registered = false
  return {
    get registered() {
      return registered
    },
    register(reasons) {
      if (registered) return 'registered'
      if (!relaunchAfter(reasons)) return 'skipped'
      if (!restartAppsEnabled(run(RESTART_APPS_QUERY), env.systemVersion)) return 'off'
      if (!run(runOnceWrite(env)).ok) return 'failed'
      registered = true
      return 'registered'
    },
    unregister() {
      if (!registered) return false
      registered = false
      run(runOnceDelete(env.userDataDir))
      return true
    }
  }
}

/** A `BrowserWindow` as the hook sees one: the end of the session arrives per window. */
export interface SessionEndWindow {
  on(event: 'session-end', listener: (event: { reasons?: readonly string[] }) => void): unknown
}

/** The `app` as the hook sees it: the windows as they are made, and the clean quit. */
export interface SessionEndApp {
  on(
    event: 'browser-window-created',
    listener: (event: unknown, window: SessionEndWindow) => void
  ): unknown
  on(event: 'will-quit', listener: () => void): unknown
}

// The session is ending: a spawn that waited on the event loop would not run before Windows
// ends the process. reg.exe answers in tens of milliseconds; the timeout keeps a stuck one from
// eating the whole shutdown budget.
const REGISTRY_TIMEOUT_MS = 3_000

const runRegistrySync: RunRegistrySync = (command) => {
  const result = spawnSync(command.file, command.args, {
    windowsHide: true,
    timeout: REGISTRY_TIMEOUT_MS,
    encoding: 'utf8'
  })
  return { ok: !result.error && result.status === 0, stdout: String(result.stdout ?? '') }
}

/**
 * Hook the registration up: every window's `session-end` registers (the first one writes, the
 * others find it done), `will-quit` takes it back. Called once, on Windows, before the first
 * window; returns the registration for the log and the tests.
 */
export function installWindowsRestart(
  app: SessionEndApp,
  env: RestartEnvironment,
  run: RunRegistrySync = runRegistrySync,
  log: (line: string) => void = (line) => console.log('[zen] restart:', line)
): WindowsRestartRegistration {
  const registration = windowsRestartRegistration(env, run)
  app.on('browser-window-created', (_event, window) => {
    window.on('session-end', (event) => {
      const reasons = event?.reasons
      const outcome = registration.register(reasons)
      log(`session ending (${reasons?.join(', ') || 'shutdown'}): ${describeOutcome(outcome, env)}`)
    })
  })
  app.on('will-quit', () => {
    if (registration.unregister()) log('clean quit: the RunOnce relaunch entry is taken back')
  })
  return registration
}

function describeOutcome(outcome: RestartRegistrationOutcome, env: RestartEnvironment): string {
  switch (outcome) {
    case 'registered':
      return `relaunch registered under ${RUN_ONCE_KEY}\\${runOnceValueName(env.userDataDir)} (${restartCommand(env)})`
    case 'off':
      return 'not registered – "restart my apps when I sign back in" is off in Windows Settings'
    case 'skipped':
      return 'not registered – no sign-in follows this end of the session'
    case 'failed':
      return 'not registered – reg.exe refused the RunOnce write'
  }
}
