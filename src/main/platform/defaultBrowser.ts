import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { release } from 'node:os'
import type { DefaultBrowserOutcome } from '../../shared/types'
import type { DefaultBrowserHost } from '../../core/platform'

/**
 * The desktop entry electron-builder installs (`linux.executableName` → `zenium.desktop`); the
 * name `xdg-settings` and `xdg-mime` register. `app.setDesktopName` in main/index.ts announces
 * the same name to Electron for the Wayland app id.
 */
export const LINUX_DESKTOP_ID = 'zenium.desktop'
/** The value name under `HKCU\Software\RegisteredApplications` written by build/installer.nsh. */
const WINDOWS_REGISTERED_APP = 'Zenium'
const WINDOWS_11_BUILD = 22000
const XDG_TIMEOUT_MS = 5_000

/**
 * Default-browser status and registration on the three desktop OSes.
 *
 * - Windows: the installer registered Zenium Chrome-style (`RegisteredApplications`,
 *   `Clients\StartMenuInternet`, the `ZeniumHTML` ProgID). Only the user can pick a default, in
 *   Settings → Apps → Default apps, so "Make default" opens that page (Windows 11: Zenium's own
 *   page, which has the "Set default" button). Status comes from the shell's association query,
 *   which honours the user's choice; `app.isDefaultProtocolClient` only looks at the `http`
 *   class and is wrong on Windows 8 and later.
 * - macOS: LaunchServices; `setAsDefaultProtocolClient` makes the system ask the user.
 * - Linux: `xdg-settings` / `xdg-mime` with the installed desktop entry.
 */
export class ElectronDefaultBrowser implements DefaultBrowserHost {
  async isDefault(): Promise<boolean> {
    switch (process.platform) {
      case 'win32':
        return windowsIsDefault()
      case 'linux':
        return linuxIsDefault()
      default:
        return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https')
    }
  }

  async makeDefault(): Promise<DefaultBrowserOutcome> {
    switch (process.platform) {
      case 'win32':
        return windowsMakeDefault()
      case 'linux':
        return linuxMakeDefault()
      default:
        return macMakeDefault()
    }
  }
}

// --- Windows ------------------------------------------------------------------------------------

async function windowsIsDefault(): Promise<boolean> {
  for (const protocol of ['http://', 'https://']) {
    let handler: string
    try {
      handler = (await app.getApplicationInfoForProtocol(protocol)).path
    } catch {
      return false
    }
    if (!samePath(handler, process.execPath)) return false
  }
  return true
}

async function windowsMakeDefault(): Promise<DefaultBrowserOutcome> {
  if (await windowsIsDefault()) return 'done'
  if (!(await windowsIsRegistered())) {
    console.warn('[zen] default browser: Zenium is not registered with Windows (run the installer)')
    return 'failed'
  }
  const build = Number(release().split('.')[2] ?? 0)
  const pages =
    build >= WINDOWS_11_BUILD
      ? [
          `ms-settings:defaultapps?registeredAppUser=${WINDOWS_REGISTERED_APP}`,
          'ms-settings:defaultapps'
        ]
      : ['ms-settings:defaultapps']
  for (const page of pages) {
    try {
      await shell.openExternal(page)
      return 'settings-opened'
    } catch (error) {
      console.warn(`[zen] default browser: could not open ${page}:`, error)
    }
  }
  return 'failed'
}

/** Whether build/installer.nsh's `RegisteredApplications` entry is present for this user. */
function windowsIsRegistered(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKCU\\Software\\RegisteredApplications', '/v', WINDOWS_REGISTERED_APP],
      { windowsHide: true, timeout: XDG_TIMEOUT_MS },
      (error) => resolve(!error)
    )
  })
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/^"|"$/g, '').toLowerCase()
  return norm(a) === norm(b)
}

// --- macOS --------------------------------------------------------------------------------------

async function macMakeDefault(): Promise<DefaultBrowserOutcome> {
  // LaunchServices shows "Do you want to change your default web browser?"; the answer arrives
  // later, so the service keeps polling until the status flips.
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https')
  if (!ok) return 'failed'
  const isDefault = app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https')
  return isDefault ? 'done' : 'settings-opened'
}

// --- Linux --------------------------------------------------------------------------------------

async function linuxIsDefault(): Promise<boolean> {
  const result = await run('xdg-settings', ['get', 'default-web-browser'])
  if (!result.ok) return false
  return isOurDesktopId(result.stdout.trim())
}

/**
 * AppImage integrators (AppImageLauncher, appimaged) install the entry under a prefixed name
 * such as `appimagekit_<hash>-zenium.desktop`; accept those as ours too.
 */
function isOurDesktopId(id: string): boolean {
  return id === LINUX_DESKTOP_ID || /(^|[-_])zenium\.desktop$/i.test(id)
}

async function linuxMakeDefault(): Promise<DefaultBrowserOutcome> {
  const set = await run('xdg-settings', ['set', 'default-web-browser', LINUX_DESKTOP_ID])
  if (!set.ok) {
    console.warn('[zen] default browser: xdg-settings set failed:', set.stderr.trim())
    return 'failed'
  }
  // `xdg-settings set default-web-browser` covers the scheme handlers on most desktops; the
  // explicit MIME defaults make sure of it and add HTML documents, like Chrome's Linux code.
  const mime = await run('xdg-mime', [
    'default',
    LINUX_DESKTOP_ID,
    'x-scheme-handler/http',
    'x-scheme-handler/https',
    'text/html',
    'application/xhtml+xml'
  ])
  if (!mime.ok) console.warn('[zen] default browser: xdg-mime default failed:', mime.stderr.trim())
  return (await linuxIsDefault()) ? 'done' : 'failed'
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: XDG_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })
    )
  })
}
