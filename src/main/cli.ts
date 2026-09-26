/**
 * Chrome's launch switches Zenium honours (os-14), read from the process's argv: `--kiosk`,
 * `--user-data-dir=<path>`, `--restore-last-session`, `--start-maximized`; and
 * `--profile-directory=<name>`, which is accepted and ignored (Zenium keeps one profile per user
 * data directory). The launch arguments proper – URLs, files and the window flags – are
 * `shared/launchArgs.ts`'s, which skips every `-` argument, so the two parsers never compete.
 *
 * Pure: no Electron, so the parse and the decisions taken from it are unit-tested as functions.
 */
import type { WindowChrome } from '../shared/types'

export interface CliSwitches {
  /**
   * `--kiosk`: every browser window is fullscreen for the run, without the chrome, the fullscreen
   * hint, or a way out by keyboard (F11 and Esc leave nothing), as Chrome's kiosk mode.
   */
  kiosk: boolean
  /** `--user-data-dir=<path>`: the profile directory, as given on the command line. */
  userDataDir: string | null
  /**
   * `--restore-last-session`: the last session's windows and tabs come back on this launch
   * whatever "Restore previous session" says (Chrome: the switch overrides the startup pref).
   */
  restoreLastSession: boolean
  /** `--start-maximized`: browser windows open maximised on this run. */
  startMaximized: boolean
  /** `--profile-directory=<name>`: Chrome's profile within the user data directory; ignored. */
  profileDirectory: string | null
  /**
   * `--zen-region=<code>`: the region the EEA's search-engine choice screen is gated on
   * (W6-2), in the OS's place – a tester's or a drive's switch, as Chrome's
   * `--search-engine-choice-country`. The code as given; the core normalises it
   * (`resolveSearchChoiceRegion`). Null when the launch carried none.
   */
  region: string | null
}

export const KIOSK_SWITCH = 'kiosk'
export const USER_DATA_DIR_SWITCH = 'user-data-dir'
export const RESTORE_LAST_SESSION_SWITCH = 'restore-last-session'
export const START_MAXIMIZED_SWITCH = 'start-maximized'
export const PROFILE_DIRECTORY_SWITCH = 'profile-directory'
export const REGION_SWITCH = 'zen-region'
/** The environment's spelling of `--zen-region` (the switch wins when both are set). */
export const REGION_ENV = 'ZEN_REGION'

const NO_SWITCHES: CliSwitches = {
  kiosk: false,
  userDataDir: null,
  restoreLastSession: false,
  startMaximized: false,
  profileDirectory: null,
  region: null
}

/**
 * The switches in `argv` (the arguments after the executable, and after the app path in
 * development). Chromium's spelling: `--name` or `--name=value`, the last value winning; a
 * value's surrounding quotes (a shell command's `"%1"` leftovers) are dropped. Anything else –
 * URLs, Chromium's own switches – is left alone.
 */
export function parseCliSwitches(argv: readonly string[]): CliSwitches {
  const switches: CliSwitches = { ...NO_SWITCHES }
  for (const raw of argv) {
    const parsed = splitSwitch(raw)
    if (!parsed) continue
    const { name, value } = parsed
    switch (name) {
      case KIOSK_SWITCH:
        switches.kiosk = true
        break
      case USER_DATA_DIR_SWITCH:
        if (value) switches.userDataDir = value
        break
      case RESTORE_LAST_SESSION_SWITCH:
        switches.restoreLastSession = true
        break
      case START_MAXIMIZED_SWITCH:
        switches.startMaximized = true
        break
      case PROFILE_DIRECTORY_SWITCH:
        switches.profileDirectory = value ?? ''
        break
      case REGION_SWITCH:
        if (value) switches.region = value
        break
    }
  }
  return switches
}

/**
 * The region override a launch carries, if any: `--zen-region=<code>` first, else the
 * environment's `ZEN_REGION`; null when neither is set. Read by the host for `PlatformInfo.
 * region` in the OS's place; the core normalises and gates (`core/searchChoice.ts`).
 */
export function regionOverride(
  switches: Pick<CliSwitches, 'region'>,
  env: Readonly<Record<string, string | undefined>>
): string | null {
  if (switches.region) return switches.region
  const fromEnv = env[REGION_ENV]
  return fromEnv && fromEnv.trim() ? fromEnv : null
}

/**
 * `--name[=value]` split into its parts; null for anything that is not a switch. The whole
 * argument may be quoted (`"--user-data-dir=C:\…"`), or the value alone (`--user-data-dir="…"`).
 */
function splitSwitch(raw: string): { name: string; value: string | null } | null {
  let arg = raw.trim()
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1).trim()
  if (!arg.startsWith('--') || arg.length <= 2) return null
  const eq = arg.indexOf('=')
  if (eq < 0) return { name: unquote(arg.slice(2)).toLowerCase(), value: null }
  return { name: arg.slice(2, eq).toLowerCase(), value: unquote(arg.slice(eq + 1)) }
}

/** A value's quote pair, or the one trailing quote a `"%1"` shell command leaves, dropped. */
function unquote(raw: string): string {
  let arg = raw.trim()
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1)
  else if (arg.endsWith('"') && !arg.startsWith('"')) arg = arg.slice(0, -1)
  return arg.trim()
}

/**
 * The log lines for a launch's switches: what each one given does, and that
 * `--profile-directory` does nothing. `userDataDir` is the directory the app ended up with.
 */
export function describeSwitches(switches: CliSwitches, userDataDir: string): string[] {
  const lines: string[] = []
  if (switches.userDataDir !== null) {
    lines.push(`--${USER_DATA_DIR_SWITCH}: the profile is ${userDataDir}`)
  }
  if (switches.profileDirectory !== null) {
    lines.push(
      `--${PROFILE_DIRECTORY_SWITCH}=${switches.profileDirectory} ignored: Zenium keeps one profile per user data directory (${userDataDir})`
    )
  }
  if (switches.kiosk) lines.push(`--${KIOSK_SWITCH}: browser windows are fullscreen for the run`)
  if (switches.startMaximized) {
    lines.push(`--${START_MAXIMIZED_SWITCH}: browser windows open maximised`)
  }
  if (switches.restoreLastSession) {
    lines.push(
      `--${RESTORE_LAST_SESSION_SWITCH}: the last session is restored whatever the setting`
    )
  }
  if (switches.region !== null) {
    lines.push(`--${REGION_SWITCH}=${switches.region}: the search engine choice reads this region`)
  }
  return lines
}

/**
 * A second instance's switches reach the running one with its URLs (`second-instance`) and
 * change nothing there, as in Chrome, whose kiosk, maximised and restore decisions are read from
 * the running process's own command line: one line names the ones that were dropped.
 */
export function droppedSecondInstanceSwitches(switches: CliSwitches): string | null {
  const dropped: string[] = []
  if (switches.kiosk) dropped.push(`--${KIOSK_SWITCH}`)
  if (switches.startMaximized) dropped.push(`--${START_MAXIMIZED_SWITCH}`)
  if (switches.restoreLastSession) dropped.push(`--${RESTORE_LAST_SESSION_SWITCH}`)
  if (switches.profileDirectory !== null) dropped.push(`--${PROFILE_DIRECTORY_SWITCH}`)
  if (dropped.length === 0) return null
  return `${dropped.join(', ')} from a second instance: the running instance keeps its own mode`
}

/** What a launch's switches ask of the browser windows the host creates. */
export interface WindowSwitches {
  kiosk: boolean
  startMaximized: boolean
  /**
   * The profile `--user-data-dir` named, resolved to the directory in use (null when the launch
   * named none): what a relaunch from a window's taskbar button repeats, so it opens on the
   * same profile.
   */
  userDataDir: string | null
}

export const NO_WINDOW_SWITCHES: WindowSwitches = {
  kiosk: false,
  startMaximized: false,
  userDataDir: null
}

/** `userDataDir`: the resolved profile directory when the switches named one (the raw switch by default). */
export function windowSwitchesOf(
  switches: CliSwitches,
  userDataDir: string | null = switches.userDataDir
): WindowSwitches {
  return { kiosk: switches.kiosk, startMaximized: switches.startMaximized, userDataDir }
}

/**
 * How one window comes up under the run's switches: `kiosk` for a browser window (a popup or
 * an app window is never a kiosk), else `maximize` when `--start-maximized` asks or the window
 * was saved maximised. Kiosk wins over both, being fullscreen.
 */
export function windowLaunchState(
  switches: WindowSwitches,
  init: { chrome: WindowChrome; maximized: boolean }
): { kiosk: boolean; maximize: boolean } {
  const browserWindow = init.chrome === 'full'
  const kiosk = switches.kiosk && browserWindow
  if (kiosk) return { kiosk, maximize: false }
  return { kiosk, maximize: init.maximized || (switches.startMaximized && browserWindow) }
}
