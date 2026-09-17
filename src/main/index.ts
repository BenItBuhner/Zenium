import { app, Menu } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerZenScheme } from './platform/protocol'
import { ElectronPlatform } from './platform'
import { moveLegacyDirectory } from './platform/legacyPaths'
import { applyResourceSwitches } from './platform/resources/startup'
import { runStdioShim } from './agent/shim'
import type { Browser } from '../core/browser'

app.setName('Zenium')
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

  /** `zenium [--blank-window|--private-window] [url]` (Zen Browser ships the same `--blank-window` flag). */
  const openFromArgv = (argv: string[]): void => {
    if (!browser) return
    const url = argv.find((a) => /^https?:\/\//.test(a))
    const kind = argv.includes('--private-window')
      ? 'private'
      : argv.includes('--blank-window')
        ? 'unsynced'
        : null
    const win = kind ? browser.createWindow({ kind }) : browser.ensureWindow()
    if (!kind) {
      win.host.show()
      win.host.focus()
    }
    if (url) browser.tabs.createTab({ url, active: true }, win)
  }

  app.on('second-instance', (_event, argv) => openFromArgv(argv))

  app.whenReady().then(() => {
    // Must equal electron-builder's appId: the installer stamps it on the shortcuts, and Windows
    // groups taskbar buttons and notifications by it.
    electronApp.setAppUserModelId('io.github.benitbuhner.zenium')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    const platform = new ElectronPlatform(app.getPath('userData'))
    browser = platform.start()
    if (process.argv.slice(1).some((a) => /^https?:\/\//.test(a) || a.startsWith('--')))
      openFromArgv(process.argv.slice(1))

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
