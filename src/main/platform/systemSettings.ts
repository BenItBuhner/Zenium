import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { release } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ProxySettingsDoor } from '../../shared/types'

/**
 * The desktop half of `ShellHost.openProxySettings` – Settings › System › "Open your computer's
 * proxy settings" – doing per OS what Chrome's `settings_utils::ShowNetworkProxySettings` does
 * (chrome/browser/ui/webui/settings/settings_utils_{win.cc,mac.mm,linux.cc}):
 *
 * - Windows: the Settings app's Proxy page, `ms-settings:network-proxy` (settings_utils_win.cc).
 * - macOS: System Settings › Network › Proxies through the `x-apple.systempreferences:` URL of the
 *   Network settings extension with its Proxies anchor (base/mac/mac_util.mm, `kNetwork_Proxies`,
 *   "tested on macOS 13, 14, 15, and 26"). Electron 44 still runs on macOS 11 and 12, whose
 *   System Preferences answers the older `com.apple.preference.network` URL Chromium used before
 *   its pane table; the Darwin kernel major picks (22 = Ventura). A refused URL falls back to
 *   opening the Network preference pane itself, without the anchor.
 * - Linux: Chrome's table of desktops and their network-settings tools (settings_utils_linux.cc
 *   `DetectAndStartProxyConfigUtil`), the desktop read as `base::nix::GetDesktopEnvironment`
 *   reads it (base/nix/xdg_util.cc): a tool found on the PATH is spawned detached with no stdio,
 *   never through a shell. A desktop the table does not know (XFCE, LXQt, none) or whose tool is
 *   not there launches nothing – where Chrome opens its `chrome://linux-proxy-config` help page,
 *   Zenium answers `unsupported` and the Settings page says so in one sentence.
 */

/** Windows Settings › Network & internet › Proxy (settings_utils_win.cc). */
export const WINDOWS_PROXY_PAGE = 'ms-settings:network-proxy'
/** System Settings › Network › Proxies on macOS 13+ (base/mac/mac_util.mm `kNetwork_Proxies`). */
export const MAC_PROXY_PANE =
  'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies'
/** System Preferences › Network › Proxies on macOS 11 and 12 (Chromium's earlier URL). */
export const MAC_LEGACY_PROXY_PANE =
  'x-apple.systempreferences:com.apple.preference.network?Proxies'
/** The Network pane itself, for a URL the system refused: no Proxies anchor, the right pane. */
export const MAC_NETWORK_PREF_PANE = '/System/Library/PreferencePanes/Network.prefPane'
/** Darwin 22 is macOS 13 Ventura, the first with the System Settings app and its extensions. */
const MAC_VENTURA_DARWIN_MAJOR = 22

/** The desktops Chromium's `base::nix::DesktopEnvironment` tells apart. */
export type LinuxDesktop =
  | 'cinnamon'
  | 'cosmic'
  | 'deepin'
  | 'gnome'
  | 'kde3'
  | 'kde4'
  | 'kde5'
  | 'kde6'
  | 'lxqt'
  | 'pantheon'
  | 'ukui'
  | 'unity'
  | 'xfce'
  | 'other'

/**
 * Chromium's `GetDesktopEnvironment` (base/nix/xdg_util.cc): `XDG_CURRENT_DESKTOP`'s values in
 * priority order first (a Unity value with a gnome-fallback `DESKTOP_SESSION` is GNOME; KDE's
 * version from `KDE_SESSION_VERSION`, 4 when it says neither 5 nor 6), then the 2010-era
 * `DESKTOP_SESSION`, then the GNOME and KDE session markers; `other` when none says.
 */
export function linuxDesktop(env: NodeJS.ProcessEnv): LinuxDesktop {
  const current = env.XDG_CURRENT_DESKTOP
  if (current !== undefined) {
    for (const value of current.split(':').map((v) => v.trim())) {
      switch (value) {
        case 'Unity':
          return (env.DESKTOP_SESSION ?? '').includes('gnome-fallback') ? 'gnome' : 'unity'
        case 'Deepin':
          return 'deepin'
        case 'GNOME':
          return 'gnome'
        case 'X-Cinnamon':
          return 'cinnamon'
        case 'KDE':
          return kdeVersion(env)
        case 'Pantheon':
          return 'pantheon'
        case 'XFCE':
          return 'xfce'
        case 'UKUI':
          return 'ukui'
        case 'LXQt':
          return 'lxqt'
        case 'COSMIC':
          return 'cosmic'
      }
    }
  }
  const session = env.DESKTOP_SESSION ?? ''
  if (session === 'deepin') return 'deepin'
  if (session === 'gnome' || session === 'mate') return 'gnome'
  if (session === 'kde4' || session === 'kde-plasma') return 'kde4'
  if (session === 'kde') return env.KDE_SESSION_VERSION !== undefined ? 'kde4' : 'kde3'
  if (session.includes('xfce') || session === 'xubuntu') return 'xfce'
  if (session === 'ukui') return 'ukui'
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return 'gnome'
  if (env.KDE_FULL_SESSION !== undefined) {
    return env.KDE_SESSION_VERSION !== undefined ? 'kde4' : 'kde3'
  }
  return 'other'
}

function kdeVersion(env: NodeJS.ProcessEnv): LinuxDesktop {
  switch (env.KDE_SESSION_VERSION) {
    case '5':
      return 'kde5'
    case '6':
      return 'kde6'
    default:
      return 'kde4'
  }
}

/**
 * GNOME 2's tool first, GNOME 3's control centre second – Chrome's order, because the older
 * command existed under GNOME 3 too doing something else, and is gone where the newer one is
 * right (settings_utils_linux.cc, the comment on `kGNOME3ProxyConfigCommand`).
 */
const GNOME_COMMANDS: readonly (readonly string[])[] = [
  ['gnome-network-properties'],
  ['gnome-control-center', 'network']
]

/** Chrome's table (settings_utils_linux.cc 36-59): the tools tried, in order, per desktop. */
export const LINUX_PROXY_COMMANDS: Readonly<Record<LinuxDesktop, readonly (readonly string[])[]>> =
  {
    cinnamon: [['cinnamon-settings', 'network']],
    cosmic: [['cosmic-settings', 'network']],
    deepin: [['dde-control-center', '-m', 'network']],
    gnome: GNOME_COMMANDS,
    pantheon: GNOME_COMMANDS,
    ukui: GNOME_COMMANDS,
    unity: GNOME_COMMANDS,
    kde3: [['kcmshell', 'proxy']],
    kde4: [['kcmshell4', 'proxy']],
    kde5: [['kcmshell5', 'proxy']],
    kde6: [['kcmshell6', 'kcm_proxy']],
    lxqt: [],
    xfce: [],
    other: []
  }

/** Open the computer's proxy settings panel for the OS this process runs on. */
export async function openProxySettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<ProxySettingsDoor> {
  switch (process.platform) {
    case 'win32':
      return openUrl(WINDOWS_PROXY_PAGE)
    case 'darwin':
      return openMacPane()
    case 'linux':
      return openLinuxTool(env)
    default:
      return 'unsupported'
  }
}

async function openUrl(url: string): Promise<ProxySettingsDoor> {
  try {
    await shell.openExternal(url)
    return 'opened'
  } catch (error) {
    console.warn(`[zen] proxy settings: could not open ${url}:`, (error as Error).message)
    return 'unsupported'
  }
}

async function openMacPane(): Promise<ProxySettingsDoor> {
  const major = Number(release().split('.')[0] ?? 0)
  const url = major >= MAC_VENTURA_DARWIN_MAJOR ? MAC_PROXY_PANE : MAC_LEGACY_PROXY_PANE
  if ((await openUrl(url)) === 'opened') return 'opened'
  // `openPath` answers with the error message, '' for success.
  const refused = await shell.openPath(MAC_NETWORK_PREF_PANE)
  if (refused === '') return 'opened'
  console.warn(`[zen] proxy settings: could not open ${MAC_NETWORK_PREF_PANE}: ${refused}`)
  return 'unsupported'
}

async function openLinuxTool(env: NodeJS.ProcessEnv): Promise<ProxySettingsDoor> {
  const desktop = linuxDesktop(env)
  for (const command of LINUX_PROXY_COMMANDS[desktop]) {
    const [file = '', ...args] = command
    if (!(await onPath(file, env.PATH))) continue
    if (await launch(file, args)) return 'opened'
  }
  // Chrome's "Could not find <desktop> network settings in $PATH" – for a desktop it knows.
  if (desktop !== 'other') {
    console.warn(`[zen] proxy settings: could not find ${desktop} network settings in $PATH`)
  }
  return 'unsupported'
}

/** Chromium's `ExecutableExistsInPath`: the file, executable, in one of PATH's directories. */
async function onPath(file: string, path: string | undefined): Promise<boolean> {
  if (file === '' || !path) return false
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    try {
      await access(join(dir, file), constants.X_OK)
      return true
    } catch {
      // Not here; the next directory.
    }
  }
  return false
}

/**
 * Start the desktop's tool as its own process: detached, no stdio of Zenium's, unreferenced, so
 * the panel outlives the browser and the browser never waits on it; an argument list, never a
 * shell string. Resolves with whether the process started.
 */
function launch(file: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, [...args], { detached: true, stdio: 'ignore' })
      child.once('error', (error) => {
        console.warn(`[zen] proxy settings: could not start ${file}:`, error.message)
        resolve(false)
      })
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch (error) {
      console.warn(`[zen] proxy settings: could not start ${file}:`, (error as Error).message)
      resolve(false)
    }
  })
}
