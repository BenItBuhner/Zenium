import { app, Menu } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerZenScheme } from './browser/protocol'
import { Browser } from './browser/browser'

// Must run before `ready`.
registerZenScheme()
app.setName('Zen')

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
    const win = kind ? browser.createWindow({ kind }) : browser.focusedWindow()
    if (!kind) {
      win.win.show()
      win.win.focus()
    }
    if (url) browser.tabs.createTab({ url, active: true }, win)
  }

  app.on('second-instance', (_event, argv) => openFromArgv(argv))

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('app.zen-browser.chromium')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    browser = new Browser(app.getPath('userData'))
    browser.start()
    if (process.argv.slice(1).some((a) => /^https?:\/\//.test(a) || a.startsWith('--')))
      openFromArgv(process.argv.slice(1))

    app.on('activate', () => {
      if (browser && browser.allWindows().length === 0) browser.createWindow({ kind: 'synced' })
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
