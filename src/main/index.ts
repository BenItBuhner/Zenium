import { app, Menu, powerMonitor, systemPreferences } from 'electron'
import { join, resolve } from 'node:path'
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
import { holdBackgroundWorkRequested } from './platform/backgroundWork'
import {
  describeSwitches,
  droppedSecondInstanceSwitches,
  parseCliSwitches,
  windowSwitchesOf
} from './cli'
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

// `electron .` in development carries the app path as its second argument.
const argvOffset = app.isPackaged ? 1 : 2
/**
 * Chrome's launch switches (`cli.ts`): `--kiosk`, `--user-data-dir`, `--restore-last-session`,
 * `--start-maximized`; `--profile-directory` accepted and ignored. Parsed before anything reads
 * the profile: the MCP shim below relays to the browser of the same user data directory.
 */
const switches = parseCliSwitches(process.argv.slice(argvOffset))
// Electron resolves `--user-data-dir` itself; set explicitly so a relative path resolves against
// the working directory as Chrome's does, and so the choice is in one place. Per-directory
// single-instance lock as in Chrome: two profiles run side by side.
if (switches.userDataDir !== null) {
  app.setPath('userData', resolve(process.cwd(), switches.userDataDir))
}

// `zenium --mcp`: relay stdio to the running browser's MCP server and exit – no windows, no lock.
if (process.argv.slice(1).includes('--mcp')) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  void runStdioShim(app.getPath('userData')).then((code) => app.exit(code))
} else {
  main()
}

function main(): void {
  for (const line of describeSwitches(switches, app.getPath('userData'))) {
    console.log('[zen] cli:', line)
  }
  // Before anything reads userData (and before `ready` creates it): a profile written by the app
  // while it was called Zen moves to the Zenium directory, so tabs, spaces and settings survive
  // the rename. The MCP shim above never migrates – it only runs while the browser is running.
  // Nor does a launch with `--user-data-dir`: the directory named is the profile, whatever the
  // default one holds.
  if (switches.userDataDir === null) {
    try {
      moveLegacyDirectory(
        join(app.getPath('appData'), LEGACY_APP_NAME),
        app.getPath('userData'),
        (message) => console.warn('[zen] profile:', message)
      )
    } catch (error) {
      console.error('[zen] profile: could not take over the Zen user data directory:', error)
    }
  }

  // Must run before `ready`.
  registerZenScheme()
  // Renderer process limit, V8 heap caps, GPU profile … are Chromium command-line switches and
  // can only be applied before the browser process finishes starting up.
  applyResourceSwitches(app.getPath('userData'))

  // Shortcuts are handled by Zenium's own table, not by menu accelerators. macOS still needs an
  // application menu for the standard Edit roles (Cmd+C/V/X/A only work through them there);
  // this minimal one stands until the browser starts and hands the host the full menu bar.
  if (process.platform === 'darwin') {
    // AppKit appends its own "Enter Full Screen" to any menu titled View unless told otherwise;
    // the View menu already carries Zenium's, with the chord from the key table.
    systemPreferences.setUserDefault('NSFullScreenMenuItemEverywhere', 'boolean', false)
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
   * the window. `--app=<url>` (an installed app's launcher) opens the page in a standalone app
   * window instead – a new one on every launch, as Chrome's `--app=` does and as its installed
   * apps do by default on desktop (the Launch Handler's `navigate-new`; a manifest's
   * `launch_handler.client_mode` is not read yet).
   */
  const openLaunch = (launch: LaunchArgs): void => {
    const b = browser
    if (!b) {
      queued.push(launch)
      return
    }
    // `--make-default-browser` is the ReinstallCommand Windows runs from its Default apps page.
    if (launch.makeDefault) void b.defaultBrowser.request('settings')
    if (launch.app) {
      const win = b.openAppWindow(launch.app)
      if (win) {
        win.host.show()
        win.host.focus()
      }
    }
    if (launch.urls.length === 0 && launch.window === 'current') return
    const win =
      launch.window === 'private'
        ? b.createWindow({ kind: 'private' })
        : launch.window === 'blank'
          ? b.createWindow({ kind: 'unsynced' })
          : launch.window === 'new'
            ? b.createWindow({ kind: 'synced' })
            : b.ensureBrowserWindow()
    // Blank and private windows start with one empty tab: the first URL goes there.
    const starter = win.localSpace ? win.selectedTabIn(win.localSpace) : null
    launch.urls.forEach((url, index) => {
      if (index === 0 && starter) b.tabs.navigate(starter, url)
      else b.openExternalUrl(url, win)
    })
    win.host.show()
    win.host.focus()
  }

  const openArgv = (argv: string[], cwd: string): void =>
    openLaunch(parseLaunchArgs(argv.slice(argvOffset), cwd))

  // A second `zenium …` on the same user data directory: its URLs and window flags open here;
  // its `--kiosk`, `--start-maximized`, `--restore-last-session` change nothing in a running
  // instance, as in Chrome, and are named in the log. (Another `--user-data-dir` is another
  // lock, so another instance.)
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const dropped = droppedSecondInstanceSwitches(parseCliSwitches(argv.slice(argvOffset)))
    if (dropped) console.warn('[zen] cli:', dropped)
    openArgv(argv, workingDirectory)
  })
  // macOS: links from other apps and documents from the Finder (also the initial launch).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    openLaunch(parseLaunchArgs([url], process.cwd()))
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    openLaunch({ urls: [pathToFileUrl(path)], window: 'current', makeDefault: false, app: null })
  })

  app.whenReady().then(() => {
    // Windows groups taskbar buttons and toast notifications by this id; it must be the one the
    // installer stamps on the shortcuts, in development too (electron-toolkit's helper would
    // substitute the executable's path there, which no toast registration can carry).
    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    const platform = new ElectronPlatform(app.getPath('userData'), {
      // The desktop demo drivers' hold on the startup sweeps (`--hold-background-work`; a normal
      // launch never carries it): the core's `performance.releaseBackgroundWork` ends it.
      holdBackgroundWork: holdBackgroundWorkRequested(process.argv),
      windowSwitches: windowSwitchesOf(switches)
    })
    // Launched for an app alone (`zenium --app=<url>`, an installed app's launcher): the app's
    // window comes up by itself, as Chrome's does; the browser windows wait for the first thing
    // that needs one (a link out of the app, the Dock, a second `zenium <url>`).
    const initial = parseLaunchArgs(process.argv.slice(argvOffset), process.cwd())
    const appAlone =
      initial.app !== null && initial.urls.length === 0 && initial.window === 'current'
    browser = platform.start({
      windows: !appAlone,
      restoreLastSession: switches.restoreLastSession
    })
    installShellTasks((kind) => void browser?.createWindow({ kind }))
    openLaunch(initial)
    for (const launch of queued.splice(0)) openLaunch(launch)

    app.on('activate', () => {
      if (browser && browser.allWindows().length === 0) browser.ensureWindow()
    })

    // Linux and macOS: the system is shutting down or the user logs off. Persist (with the
    // clean-exit marker) and exit at once; the dialogs would only hold the shutdown up.
    powerMonitor.on('shutdown', () => {
      browser?.shutdown()
      app.quit()
    })
  })

  // Every quit request (Cmd+Q on the app menu, the Dock, `app.quit()` from anywhere) goes
  // through the browser's checks – the open-tabs warning, every page's "Leave site?" – and quits
  // for real once they pass (`requestQuit` calls `shutdown`, then `app.quit()` again).
  app.on('before-quit', (event) => {
    const b = browser
    if (!b || b.quitting) return
    event.preventDefault()
    // Off the event: the checks may pass at once and quit again, which must not re-enter the
    // quit that is being cancelled here.
    setImmediate(() => void b.requestQuit())
  })

  // The windows are closed and the process is about to go: a write of the profile still in
  // flight (the OS-shutdown paths above quit right after `shutdown`'s synchronous write) lands
  // first, so the final document is the last one on disk.
  app.on('will-quit', (event) => {
    const b = browser
    if (!b || !b.writing) return
    event.preventDefault()
    void b.settled().then(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  // Certificate errors are decided with the other security prompts (`platform/security.ts`):
  // denied like Chrome does, unless the user proceeded past the interstitial this session.
}
