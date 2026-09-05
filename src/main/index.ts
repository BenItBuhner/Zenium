import { app, BrowserWindow, Menu } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerZenScheme } from './browser/protocol'
import { Browser } from './browser/browser'

// Must run before `ready`.
registerZenScheme()
app.setName('Zen')

// Ctrl+Shift+I etc. are handled by Zen's own shortcut table, not by menu accelerators.
Menu.setApplicationMenu(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let browser: Browser | null = null

  app.on('second-instance', (_event, argv) => {
    if (!browser) return
    browser.window.win.show()
    browser.window.win.focus()
    const url = argv.find((a) => /^https?:\/\//.test(a))
    if (url) browser.tabs.createTab({ url, active: true })
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('app.zen-browser.chromium')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    browser = new Browser(app.getPath('userData'))
    browser.start()

    // Open a URL passed on the command line (e.g. `zen https://example.com`).
    const url = process.argv.slice(1).find((a) => /^https?:\/\//.test(a))
    if (url) browser.tabs.createTab({ url, active: true })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && browser) browser.window.create()
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
