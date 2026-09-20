import { BrowserWindow, type Session } from 'electron'
import type { OffscreenDocumentHost, OffscreenDocumentPage } from './offscreen'

/** Chrome gives an offscreen document a viewport; a page laid out at zero size misbehaves. */
const DOCUMENT_SIZE = { width: 1024, height: 768 }

/**
 * The engine side of `chrome.offscreen`: the document is a page in a window that is never
 * shown, on the extension's session (so the session's frame preload installs the API layer in
 * it and its permission handlers answer its media requests), unthrottled like Chrome's (a
 * document kept for audio or capture must not have its timers slowed to one a second). The
 * window never counts as one of the browser's: it opens no chrome and its closing closes nothing.
 */
export function electronOffscreenDocumentHost(): OffscreenDocumentHost {
  return {
    open(session: Session, url: string, onGone: () => void): OffscreenDocumentPage {
      const bw = new BrowserWindow({
        show: false,
        width: DOCUMENT_SIZE.width,
        height: DOCUMENT_SIZE.height,
        webPreferences: {
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // The API layer's preload must reach iframes the document embeds (`IFRAME_SCRIPTING`).
          nodeIntegrationInSubFrames: true,
          backgroundThrottling: false
        }
      })
      const wc = bw.webContents
      // An offscreen document has no window to open anything in; Chrome ignores its `window.open`.
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      let closing = false
      const loaded = new Promise<void>((resolve, reject) => {
        wc.once('did-finish-load', () => resolve())
        wc.once('did-fail-load', (_event, code, description, _url, isMainFrame) => {
          if (isMainFrame) reject(new Error(`${description || 'load failed'} (${code})`))
        })
        wc.once('destroyed', () => reject(new Error('document closed')))
        bw.loadURL(url).catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      })
      // A rejection nobody awaits (a document closed before its creator looked) must not surface.
      loaded.catch(() => undefined)
      bw.on('closed', () => {
        if (!closing) onGone()
      })
      return {
        webContents: wc,
        loaded,
        close: () => {
          closing = true
          if (!bw.isDestroyed()) bw.destroy()
        }
      }
    }
  }
}
