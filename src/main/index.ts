import { app, Menu } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerZenScheme } from './platform/protocol'
import { ElectronPlatform } from './platform'
import { applyResourceSwitches } from './platform/resources/startup'
import type { Browser } from '../core/browser'

// Must run before `ready`.
registerZenScheme()
app.setName('Zen')
// Renderer process limit, V8 heap caps, GPU profile … are Chromium command-line switches and can
// only be applied before the browser process finishes starting up.
applyResourceSwitches(app.getPath('userData'))

// Shortcuts are handled by Zen's own table, not by menu accelerators. macOS still needs an
// application menu for the standard Edit roles (Cmd+C/V/X/A only work through them there).
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
} else {
  Menu.setApplicationMenu(null)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let browser: Browser | null = null

  /** `zen [--blank-window|--private-window] [url]` (Zen ships the same `--blank-window` flag). */
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
    electronApp.setAppUserModelId('app.zen-browser.chromium')
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
