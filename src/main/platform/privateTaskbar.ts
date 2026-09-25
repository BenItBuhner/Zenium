/**
 * Private windows on a taskbar button of their own (os-56). Windows groups taskbar buttons by
 * AppUserModelID, so a private window's frame carries a second id – the app's with `.private`
 * – with the private icon and a relaunch command that opens a private window: the button's
 * hover card, its jump list and a pin of it are the private browser's, as Chrome's Incognito
 * windows (a second AUMID) and Firefox's private windows are. Electron writes the frame's
 * property store through `BrowserWindow.setAppDetails`; the values come from here, without
 * Electron, so a test can hold them – and so the class key Windows reads a name and an icon
 * from for that id (`notifications.ts` registers it beside the app's) says the same.
 */
import { USER_DATA_DIR_SWITCH } from '../cli'
import { APP_USER_MODEL_ID } from './notifications'
import { windowsCommandLine } from './webAppLauncher'

/** The private windows' AppUserModelID: the app's, suffixed – one group, whatever the profile. */
export const PRIVATE_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.private`

/** The AppUserModelId class key of the private id (the uninstaller deletes it with the app's). */
export const WINDOWS_PRIVATE_APP_ID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${PRIVATE_APP_USER_MODEL_ID}`

/** The launch flag a relaunch from the group carries (`shared/launchArgs.ts` reads it). */
export const PRIVATE_WINDOW_SWITCH = '--private-window'

/** How the running copy was started: what a relaunch from the taskbar has to repeat. */
export interface ZeniumLaunch {
  execPath: string
  /** electron-builder's packaged app (true) or `electron <appPath>` in development. */
  isPackaged: boolean
  /** The app's directory in development (Electron's second argument). */
  appPath: string
  /** The profile `--user-data-dir` named, resolved; null when the launch named none. */
  userDataDir: string | null
}

/**
 * The group's name – its hover card, the relaunch row of its jump list, a pinned button's
 * tooltip: the app's name with the suffix every private window's title carries
 * (`shared/windowTitle.ts`).
 */
export function privateRelaunchDisplayName(appName: string): string {
  return `${appName} (Private)`
}

/**
 * What a click on the pinned button or the jump list's relaunch row runs: this copy, on this
 * profile, opening a private window – `"<exe>" [<appPath>] ["--user-data-dir=<dir>"]
 * --private-window`.
 */
export function privateRelaunchCommand(launch: ZeniumLaunch): string {
  const args: string[] = []
  if (!launch.isPackaged) args.push(launch.appPath)
  if (launch.userDataDir !== null) args.push(`--${USER_DATA_DIR_SWITCH}=${launch.userDataDir}`)
  args.push(PRIVATE_WINDOW_SWITCH)
  return windowsCommandLine({ program: launch.execPath, args })
}

/** What `BrowserWindow.setAppDetails` takes for a private window. */
export interface PrivateAppDetails {
  appId: string
  /** The private ICO on disk; left out when the copy ships none (the button shows the exe's). */
  appIconPath?: string
  appIconIndex?: number
  relaunchCommand: string
  relaunchDisplayName: string
}

export function privateAppDetails(
  launch: ZeniumLaunch,
  appName: string,
  iconPath: string | null
): PrivateAppDetails {
  return {
    appId: PRIVATE_APP_USER_MODEL_ID,
    ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: privateRelaunchCommand(launch),
    relaunchDisplayName: privateRelaunchDisplayName(appName)
  }
}
