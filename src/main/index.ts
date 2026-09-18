import { app, Menu } from 'electron'
import { join } from 'node:path'
import { optimizer } from '@electron-toolkit/utils'
import { registerZenScheme } from './platform/protocol'
import { ElectronPlatform } from './platform'
import { APP_USER_MODEL_ID } from './platform/notifications'
import { moveLegacyDirectory } from './platform/legacyPaths'
import { applyResourceSwitches } from './platform/resources/startup'
import { installShellTasks } from './platform/shellTasks'
import { runStdioShim } from './agent/shim'
import { LINUX_DESKTOP_ID } from './platform/defaultBrowser'
import { parseLaunchArgs, pathToFileUrl, type LaunchArgs } from '../shared/launchArgs'
import type { Browser } from '../core/browser'

app.setName('Zenium')
// The desktop entry electron-builder installs; Electron uses it for the Wayland app id, and
// desktop environments match it to the window (StartupWMClass in the .desktop file).
if (process.platform === 'linux') app.setDesktopName(LINUX_DESKTOP_ID)
/** The product name up to v0.2.0; its userData directory is taken over on the first launch. */
const LEGACY_APP_NAME = 'Zen'

// Last resort: with no listener Electron shows a modal "A JavaScript error occurred in the main
// process" dialog and blocks the main process (a quit never completes). Log to stderr instead.
process.on('uncaughtException', (error) => console.error('[zenium] uncaught', error))

// `zenium --mcp`: relay stdio to the running browser's MCP server and exit – no windows, no lock.
if (process.argv.slice(1).includes('--mcp')) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  void runStdioShim(app.getPath('userData')).then((code) => app.exit(code))
} else {
  main()
}

function main(): void {
  // Before anything reads userData (and before `ready` creates it): a profile written by the app
  // while it was called Zen moves to the Zenium directory, so tabs, spaces and settings survive
  // the rename. The MCP shim above never migrates – it only runs while the browser is running.
  try {
    moveLegacyDirectory(
      join(app.getPath('appData'), LEGACY_APP_NAME),
      app.getPath('userData'),
      (message) => console.warn('[zen] profile:', message)
    )
  } catch (error) {
    console.error('[zen] profile: could not take over the Zen user data directory:', error)
  }

  // Must run before `ready`.
  registerZenScheme()
  // Renderer process limit, V8 heap caps, GPU profile … are Chromium command-line switches and
  // can only be applied before the browser process finishes starting up.
  applyResourceSwitches(app.getPath('userData'))

  // Shortcuts are handled by Zenium's own table, not by menu accelerators. macOS still needs an
  // application menu for the standard Edit roles (Cmd+C/V/X/A only work through them there).
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }
  let browser: Browser | null = null
  /** Handoffs that arrived before the browser existed (macOS delivers open-url before `ready`). */
  const queued: LaunchArgs[] = []

  /**
   * `zenium [--new-window|--blank-window|--private-window] [urls|files]`, from the command line,
   * a second instance, a file association or a protocol launch. URLs open as tabs in the window
   * the flags ask for (Zen Browser ships the same `--blank-window` flag); a bare flag just opens
   * the window.
   */
  const openLaunch = (launch: LaunchArgs): void => {
    const b = browser
    if (!b) {
      queued.push(launch)
      return
    }
    // `--make-default-browser` is the ReinstallCommand Windows runs from its Default apps page.
    if (launch.makeDefault) void b.defaultBrowser.request('settings')
    if (launch.urls.length === 0 && launch.window === 'current') return
    const win =
      launch.window === 'private'
        ? b.createWindow({ kind: 'private' })
        : launch.window === 'blank'
          ? b.createWindow({ kind: 'unsynced' })
          : launch.window === 'new'
            ? b.createWindow({ kind: 'synced' })
            : b.ensureWindow()
    // Blank and private windows start with one empty tab: the first URL goes there.
    const starter = win.localSpace ? win.selectedTabIn(win.localSpace) : null
    launch.urls.forEach((url, index) => {
      if (index === 0 && starter) b.tabs.navigate(starter, url)
      else b.openExternalUrl(url, win)
    })
    win.host.show()
    win.host.focus()
  }

  // `electron .` in development carries the app path as its second argument.
  const argvOffset = app.isPackaged ? 1 : 2
  const openArgv = (argv: string[], cwd: string): void =>
    openLaunch(parseLaunchArgs(argv.slice(argvOffset), cwd))

  app.on('second-instance', (_event, argv, workingDirectory) => openArgv(argv, workingDirectory))
  // macOS: links from other apps and documents from the Finder (also the initial launch).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    openLaunch(parseLaunchArgs([url], process.cwd()))
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    openLaunch({ urls: [pathToFileUrl(path)], window: 'current', makeDefault: false })
  })

  app.whenReady().then(() => {
    // Windows groups taskbar buttons and toast notifications by this id; it must be the one the
    // installer stamps on the shortcuts, in development too (electron-toolkit's helper would
    // substitute the executable's path there, which no toast registration can carry).
    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    const platform = new ElectronPlatform(app.getPath('userData'))
    browser = platform.start()
    installShellTasks((kind) => void browser?.createWindow({ kind }))
    openArgv(process.argv, process.cwd())
    for (const launch of queued.splice(0)) openLaunch(launch)

    app.on('activate', () => {
      if (browser && browser.allWindows().length === 0) browser.ensureWindow()
    })
  })

  app.on('before-quit', () => browser?.shutdown())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Deny insecure certificates like Chrome does; the error page explains the failure.
  app.on('certificate-error', (event, _wc, _url, _error, _cert, callback) => {
    event.preventDefault()
    callback(false)
  })
}
