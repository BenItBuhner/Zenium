import { app, clipboard, dialog, ipcMain, net, shell, type Session } from 'electron'
import { join } from 'node:path'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../../core/browser'
import type {
  AppHost,
  ClipboardHost,
  ConfirmOptions,
  DialogHost,
  NetHost,
  PageMessage,
  Platform,
  PlatformInfo,
  ShellHost
} from '../../core/platform'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { FileStoreIO } from './storeIo'
import { SessionManager, buildUserAgent } from './sessions'
import { installZenProtocol } from './protocol'
import { ElectronDownloads } from './downloads'
import { ElectronMenus } from './menus'
import { ElectronTabViewHost, copyImageFromUrl } from './views'
import { ZenWindow } from './window'

export const ELECTRON_CAPABILITIES: HostCapabilities = {
  windowControls: true,
  nativeMenus: true,
  windowDrag: true,
  devtools: true,
  compactReveal: true,
  pictureInPicture: true,
  viewSource: true
}

/**
 * Zen's browser core running inside Electron's main process. Everything here adapts Electron's
 * APIs to the `Platform` contract; the behaviour itself lives in `src/core`.
 */
export class ElectronPlatform implements Platform {
  readonly info: PlatformInfo
  readonly io: FileStoreIO
  readonly window: ZenWindow
  readonly chrome: ZenWindow
  readonly views: ElectronTabViewHost
  readonly menus: ElectronMenus
  readonly sessions: SessionManager
  readonly downloads: ElectronDownloads
  readonly dialogs: DialogHost
  readonly clipboard: ClipboardHost
  readonly shell: ShellHost
  readonly net: NetHost
  readonly app: AppHost
  browser!: Browser

  constructor(userDataDir: string) {
    this.info = { os: process.platform as PlatformOs, version: app.getVersion() }
    this.io = new FileStoreIO(join(userDataDir, 'zen'))
    this.window = new ZenWindow()
    this.chrome = this.window
    this.sessions = new SessionManager(buildUserAgent())
    this.views = new ElectronTabViewHost(this.sessions)
    this.views.bindWindow(() => this.window.window)
    this.menus = new ElectronMenus(() => this.window.window)
    this.downloads = new ElectronDownloads(() => this.browser.state.settings.askWhereToSave)
    this.dialogs = {
      confirm: async (options: ConfirmOptions) => {
        const win = this.window.window
        const message = {
          type: 'question' as const,
          buttons: [options.okLabel, options.cancelLabel],
          defaultId: options.danger ? 1 : 0,
          cancelId: 1,
          message: options.message,
          detail: options.detail,
          noLink: true
        }
        const result = win
          ? await dialog.showMessageBox(win, message)
          : await dialog.showMessageBox(message)
        return result.response === 0
      }
    }
    this.clipboard = {
      writeText: (text) => clipboard.writeText(text),
      writeImageFromUrl: (url) => copyImageFromUrl(url)
    }
    this.shell = {
      openExternal: (url) => void shell.openExternal(url),
      openPath: async (path) => {
        await shell.openPath(path)
      },
      showItemInFolder: (path) => shell.showItemInFolder(path)
    }
    this.net = {
      fetchText: async (url, options) => {
        const res = await net.fetch(url, { signal: options.signal, headers: options.headers })
        return { ok: res.ok, text: res.ok ? await res.text() : '' }
      }
    }
    this.app = {
      quit: () => app.quit(),
      downloadsDirectory: () => app.getPath('downloads')
    }
  }

  /** Build the browser, wire IPC and sessions, and show the window. */
  start(): Browser {
    const browser = new Browser(this, ELECTRON_CAPABILITIES)
    this.browser = browser
    this.window.bind(browser)
    this.downloads.bind(browser.downloads)
    this.sessions.configure((ses: Session) => {
      installZenProtocol(ses)
      this.attachPermissions(ses)
      this.downloads.attach(ses, (source) =>
        browser.onDownloadStarted(source ? (this.views.tabIdForWebContents(source) ?? null) : null)
      )
      ses.setSpellCheckerLanguages(['en-US'])
    })
    this.sessions.get(DEFAULT_CONTAINER_ID)
    this.registerIpc(browser)
    this.window.create()
    browser.start()
    return browser
  }

  private attachPermissions(ses: Session): void {
    const { permissions } = this.browser
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const url = details.requestingUrl || webContents?.getURL() || ''
      void permissions.decide(permission, url).then(callback)
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
      permissions.check(permission, requestingOrigin)
    )
  }

  private registerIpc(browser: Browser): void {
    ipcMain.handle('zen:cmd', async (event, name: string, args: unknown) => {
      if (event.sender !== this.window.window?.webContents) throw new Error('Unauthorised sender')
      return browser.handleCommand(name, args)
    })
    ipcMain.on('zen:page', (event, message: PageMessage) => {
      const tabId = this.views.tabIdForWebContents(event.sender)
      if (tabId) browser.handlePageMessage(tabId, message)
    })
  }
}
