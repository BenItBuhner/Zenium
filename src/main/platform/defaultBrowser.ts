import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { release } from 'node:os'

/**
 * The desktop entry electron-builder installs (`linux.executableName` → `zenium.desktop`); the
 * name `xdg-settings` and `xdg-mime` register. `app.setDesktopName` in main/index.ts announces
 * the same name to Electron for the Wayland app id.
 */
export const LINUX_DESKTOP_ID = 'zenium.desktop'
/** The value name under `HKCU\Software\RegisteredApplications` written by build/installer.nsh. */
const WINDOWS_REGISTERED_APP = 'Zenium'
const WINDOWS_11_BUILD = 22000
/**
 * `xdg-settings get` and `reg query` answer in milliseconds; a spurious "not default" from a
 * slow first run (the xdg scripts may autolaunch a session bus) is worse than a late answer.
 */
const QUERY_TIMEOUT_MS = 10_000
/** `xdg-settings set` runs one `xdg-mime` per scheme and may call into the desktop's own tools. */
const XDG_SET_TIMEOUT_MS = 30_000
/**
 * The OS asks the user outside the app (Windows Settings, the macOS prompt): how often and how
 * long to look for the answer before the request resolves "unknown" and the core reads the role
 * again on the next window focus.
 */
const CHOICE_POLL_MS = 1_000
const CHOICE_POLL_ROUNDS = 120

/** Options the tests use to run the wait without real time. */
export interface DefaultBrowserHostOptions {
  pollMs?: number
  pollRounds?: number
  wait?: (ms: number) => Promise<void>
}

/**
 * The desktop half of `AppHost.isDefaultBrowser` / `requestDefaultBrowser` (the core's
 * `DefaultBrowserService` asks at start, on every window focus and when the user presses Make
 * default). Status and registration on the three desktop OSes:
 *
 * - Windows: the installer registered Zenium Chrome-style (`RegisteredApplications`,
 *   `Clients\StartMenuInternet`, the `ZeniumHTML` ProgID). Since Windows 8 only the user can
 *   pick a default, in Settings → Apps → Default apps, so the request opens that page
 *   (Windows 11: Zenium's own page, which has the "Set default" button) and watches for the
 *   choice. Status comes from the shell's association query (`AssocQueryString`), which honours
 *   the user's choice. `app.setAsDefaultProtocolClient` / `isDefaultProtocolClient` are not used
 *   here: on Windows they write and read `HKCU\Software\Classes\http\shell\open\command`, which
 *   the user's choice overrides, so they would report "default" without Zenium being it (and
 *   leave a class behind that the uninstaller does not know about).
 * - macOS: LaunchServices; `setAsDefaultProtocolClient` makes the system ask the user.
 * - Linux: `xdg-settings` / `xdg-mime` with the installed desktop entry.
 *
 * `request` resolves with the role once the OS has answered, or null when the user has not
 * decided within the poll window (the core then reads the role again when the app regains focus).
 */
export class ElectronDefaultBrowser {
  /** macOS: an http request is out and https still has to be claimed once the user says yes. */
  private httpsPending = false
  private readonly pollMs: number
  private readonly pollRounds: number
  private readonly wait: (ms: number) => Promise<void>

  constructor(options: DefaultBrowserHostOptions = {}) {
    this.pollMs = options.pollMs ?? CHOICE_POLL_MS
    this.pollRounds = options.pollRounds ?? CHOICE_POLL_ROUNDS
    this.wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async isDefault(): Promise<boolean> {
    switch (process.platform) {
      case 'win32':
        return windowsIsDefault()
      case 'linux':
        return linuxIsDefault()
      default:
        return this.macIsDefault()
    }
  }

  async request(): Promise<boolean | null> {
    switch (process.platform) {
      case 'win32':
        return this.windowsRequest()
      case 'linux':
        return linuxRequest()
      default:
        return this.macRequest()
    }
  }

  /** Look for the user's answer until it is yes or the poll window closes (then unknown). */
  private async awaitChoice(): Promise<boolean | null> {
    for (let round = 0; round < this.pollRounds; round++) {
      await this.wait(this.pollMs)
      if (await this.isDefault()) return true
    }
    return null
  }

  // --- Windows ----------------------------------------------------------------------------------

  private async windowsRequest(): Promise<boolean | null> {
    if (await windowsIsDefault()) return true
    if (!(await windowsIsRegistered())) {
      console.warn(
        '[zen] default browser: Zenium is not registered with Windows (run the installer)'
      )
      return false
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
        return this.awaitChoice()
      } catch (error) {
        console.warn(`[zen] default browser: could not open ${page}:`, error)
      }
    }
    return false
  }

  // --- macOS ------------------------------------------------------------------------------------

  /**
   * LaunchServices keeps one "default web browser" and asks the user about it through the http
   * scheme ("Do you want to change your default web browser to Zenium?"). Like Chrome, only http
   * is requested up front: asking for https at the same time puts a second copy of that prompt on
   * screen and answers permErr (-54) while the first is pending (seen on a macOS 15.6 runner).
   * https is claimed once the user has said yes, which the system then grants without asking.
   */
  private async macRequest(): Promise<boolean | null> {
    if (macHandlesHttp()) {
      this.macClaimHttps()
      return true
    }
    if (!app.setAsDefaultProtocolClient('http')) return false
    this.httpsPending = true
    if (this.macIsDefault()) return true
    return this.awaitChoice()
  }

  /** http alone decides the status, like Chrome: https has no default-browser role of its own. */
  private macIsDefault(): boolean {
    const isDefault = macHandlesHttp()
    if (isDefault && this.httpsPending) this.macClaimHttps()
    return isDefault
  }

  private macClaimHttps(): void {
    this.httpsPending = false
    if (!app.isDefaultProtocolClient('https')) app.setAsDefaultProtocolClient('https')
  }
}

function macHandlesHttp(): boolean {
  return app.isDefaultProtocolClient('http')
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

/** Whether build/installer.nsh's `RegisteredApplications` entry is present for this user. */
function windowsIsRegistered(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKCU\\Software\\RegisteredApplications', '/v', WINDOWS_REGISTERED_APP],
      { windowsHide: true, timeout: QUERY_TIMEOUT_MS },
      (error) => resolve(!error)
    )
  })
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/^"|"$/g, '').toLowerCase()
  return norm(a) === norm(b)
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

async function linuxRequest(): Promise<boolean> {
  // `xdg-settings set default-web-browser` is what the desktop environments understand (KDE and
  // GNOME keep their own registry of the default browser).
  const set = await run(
    'xdg-settings',
    ['set', 'default-web-browser', LINUX_DESKTOP_ID],
    XDG_SET_TIMEOUT_MS
  )
  if (!set.ok) console.warn('[zen] default browser: xdg-settings set failed:', set.stderr.trim())
  // The explicit MIME defaults in mimeapps.list are what `xdg-open` and the file managers read;
  // they cover a desktop `xdg-settings` does not know and add HTML documents, like Chrome does.
  const mime = await run(
    'xdg-mime',
    [
      'default',
      LINUX_DESKTOP_ID,
      'x-scheme-handler/http',
      'x-scheme-handler/https',
      'text/html',
      'application/xhtml+xml'
    ],
    XDG_SET_TIMEOUT_MS
  )
  if (!mime.ok) console.warn('[zen] default browser: xdg-mime default failed:', mime.stderr.trim())
  // Either tool may have done the job: the outcome is what the desktop reports afterwards.
  return linuxIsDefault()
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
}

function run(command: string, args: string[], timeout = QUERY_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout, stderr })
    )
  })
}
