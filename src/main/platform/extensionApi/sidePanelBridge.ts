import { WebContentsView, type WebContents } from 'electron'
import type { Rect } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import type { ApiModel } from './model'
import type { LoadedExtension } from './types'

/** The view a side panel's page lives in, as the API module drives it. */
export interface PanelView {
  loadURL(url: string): void
  setBounds(rect: Rect): void
  setVisible(visible: boolean): void
  visible(): boolean
  focus(): void
  destroyed(): boolean
  /** Take the view out of its window and close its page. */
  close(): void
  hostsWebContents(wc: WebContents): boolean
}

export interface PanelViewHooks {
  /** The page asked for a new window (a link with `target=_blank`): open `url` as a tab. */
  openUrl(url: string): void
  /** The view went away underneath the API module (its window closed). */
  gone(): void
}

/** How the API module gets a panel view docked in a window. */
export interface PanelViewHost {
  /** Null when the window has no native frame to dock into (not alive). */
  create(win: ZenWindow, ext: LoadedExtension, hooks: PanelViewHooks): PanelView | null
}

/**
 * Electron's panel view: a `WebContentsView` in the extension's primary session, a child of the
 * window's content view like the toolbar popup, hidden until the chrome lays the strip out.
 */
export function electronPanelViewHost(model: ApiModel): PanelViewHost {
  return {
    create(win, ext, hooks) {
      const bw = model.browserWindowOf(win)
      const ses = ext.sessions[0]
      if (!bw || !ses) return null
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // The API layer's preload must reach iframes the panel embeds.
          nodeIntegrationInSubFrames: true
        }
      })
      view.setVisible(false)
      bw.contentView.addChildView(view)
      const wc = view.webContents
      wc.setWindowOpenHandler(({ url }) => {
        if (/^(https?|chrome-extension):/.test(url)) hooks.openUrl(url)
        return { action: 'deny' }
      })
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        if (!bw.isDestroyed()) bw.contentView.removeChildView(view)
        if (!wc.isDestroyed()) wc.close()
      }
      bw.once('closed', () => {
        if (closed) return
        closed = true
        hooks.gone()
      })
      wc.once('destroyed', () => {
        if (closed) return
        closed = true
        hooks.gone()
      })
      return {
        loadURL: (url) => void wc.loadURL(url).catch(() => undefined),
        setBounds: (rect) =>
          view.setBounds({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }),
        setVisible: (visible) => view.setVisible(visible),
        visible: () => view.getVisible(),
        focus: () => wc.focus(),
        destroyed: () => closed || wc.isDestroyed(),
        close,
        hostsWebContents: (other) => other === wc
      }
    }
  }
}
