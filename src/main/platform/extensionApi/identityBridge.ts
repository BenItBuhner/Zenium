import { BrowserWindow } from 'electron'
import type { AuthWindowHost } from './identity'
import type { ApiModel } from './model'

const AUTH_WINDOW = { width: 520, height: 680 }

/**
 * Electron's window for `identity.launchWebAuthFlow`: a plain `BrowserWindow` in the extension's
 * primary session, hidden until the flow decides to show it, centred on the caller's window. The
 * redirect back to `https://<id>.chromiumapp.org/` is caught before the request goes out
 * (`will-navigate` / `will-redirect`), so nothing is ever fetched from that host.
 */
export function electronAuthWindowHost(model: ApiModel): AuthWindowHost {
  return {
    open(ext, url, owner, events) {
      const parent = model.browserWindowOf(owner) ?? undefined
      const ses = ext.sessions[0]
      const bw = new BrowserWindow({
        ...AUTH_WINDOW,
        parent,
        show: false,
        autoHideMenuBar: true,
        title: ext.manifest.name ?? 'Sign in',
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      const wc = bw.webContents
      let closed = false
      const intercept = (event: { preventDefault(): void }, target: string): void => {
        events.navigating(target)
        if (/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(target)) event.preventDefault()
      }
      wc.on('will-navigate', intercept)
      wc.on('will-redirect', intercept)
      wc.on('did-finish-load', () => events.loaded())
      wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        // -3 is ABORTED: the navigation we cancelled ourselves, or the user moving on.
        if (isMainFrame && code !== -3) events.failed()
      })
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      bw.on('closed', () => {
        closed = true
        events.closed()
      })
      void wc.loadURL(url).catch(() => undefined)
      return {
        show: () => {
          if (!closed && !bw.isVisible()) bw.show()
        },
        close: () => {
          if (!closed && !bw.isDestroyed()) bw.close()
        }
      }
    }
  }
}
