import { app, clipboard, dialog, ipcMain, net, shell, type Session } from 'electron'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../../core/browser'
import type {
  AppHost,
  ClipboardHost,
  ConfirmOptions,
  DialogHost,
  NetHost,
  PageMessage,
  PickedTextFile,
  Platform,
  PlatformInfo,
  ShellHost
} from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { FileStoreIO } from './storeIo'
import { SessionManager, buildUserAgent } from './sessions'
import { installZenProtocol } from './protocol'
import { ElectronDownloads } from './downloads'
import { ElectronMenus } from './menus'
import { ElectronTabViewHost, copyImageFromUrl } from './views'
import { ElectronWindowFactory, type ElectronWindow } from './window'
import { ExtensionService } from './extensions'
import { ResourceGovernor } from './resources/governor'
import { SyncEngine } from '../sync/engine'
import { ElectronAgentTransport } from '../agent/server'

export const ELECTRON_CAPABILITIES: HostCapabilities = {
  windowControls: true,
  nativeMenus: true,
  windowDrag: true,
  devtools: true,
  compactReveal: true,
  pictureInPicture: true,
  viewSource: true,
  windows: true,
  extensions: true,
  resourceGovernor: true,
  sync: true,
  print: true,
  agents: true
}

/**
 * Zen's browser core running inside Electron's main process. Everything here adapts Electron's
 * APIs to the `Platform` contract; the behaviour itself lives in `src/core`.
 */
export class ElectronPlatform implements Platform {
  readonly info: PlatformInfo
  readonly capabilities = ELECTRON_CAPABILITIES
  readonly io: FileStoreIO
  readonly windows: ElectronWindowFactory
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
    this.windows = new ElectronWindowFactory()
    this.sessions = new SessionManager(buildUserAgent())
    this.views = new ElectronTabViewHost(this.sessions)
    this.menus = new ElectronMenus()
    this.downloads = new ElectronDownloads(() => this.browser.state.settings.askWhereToSave)
    this.dialogs = {
      confirm: async (options: ConfirmOptions, win?: ZenWindow) => {
        const bw = browserWindowOf(win)
        const message = {
          type: 'question' as const,
          buttons: [options.okLabel, options.cancelLabel],
          defaultId: options.danger ? 1 : 0,
          cancelId: 1,
          message: options.message,
          detail: options.detail,
          noLink: true
        }
        const result = bw
          ? await dialog.showMessageBox(bw, message)
          : await dialog.showMessageBox(message)
        return result.response === 0
      },
      pickTextFiles: async (options, win?: ZenWindow) => {
        const bw = browserWindowOf(win)
        const dialogOptions = {
          title: options.title,
          properties: ['openFile' as const],
          filters: [
            { name: options.extensions.join(', ').toUpperCase(), extensions: options.extensions }
          ]
        }
        const result = bw
          ? await dialog.showOpenDialog(bw, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions)
        if (result.canceled) return []
        const files: PickedTextFile[] = []
        for (const path of result.filePaths)
          files.push({ name: basename(path), text: readFileSync(path, 'utf8') })
        return files
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
        const res = await net.fetch(url, {
          signal: options.signal,
          headers: options.headers,
          cache: 'no-store'
        })
        return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' }
      }
    }
    this.app = {
      quit: () => app.quit(),
      relaunch: () => {
        app.relaunch()
        app.quit()
      },
      lastWindowClosed: () => {
        if (process.platform !== 'darwin') app.quit()
      }
    }
  }

  /**
   * Mozilla's Readability is an externalised runtime dependency, read from `node_modules` (or the
   * asar) on first use.
   */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string | null {
    try {
      return readFileSync(require.resolve(`@mozilla/readability/${file}`), 'utf8')
    } catch {
      return null
    }
  }

  createGovernor(browser: Browser): ResourceGovernor {
    return new ResourceGovernor(browser)
  }

  createExtensions(browser: Browser): ExtensionService {
    return new ExtensionService(browser, this.sessions)
  }

  createSync(browser: Browser): SyncEngine {
    return new SyncEngine(browser)
  }

  createAgentTransport(): ElectronAgentTransport {
    return new ElectronAgentTransport()
  }

  /** Build the browser, wire IPC and sessions, and restore the windows. */
  start(): Browser {
    const browser = new Browser(this)
    this.browser = browser
    this.windows.bind(browser)
    this.downloads.bind(browser.downloads)
    this.sessions.configure((ses: Session, containerId: string) => {
      installZenProtocol(ses, (id) => browser.reader.pageHtml(id))
      this.attachPermissions(ses)
      this.downloads.attach(ses, (source) =>
        browser.onDownloadStarted(source ? (this.views.tabIdForWebContents(source) ?? null) : null)
      )
      ses.setSpellCheckerLanguages(['en-US'])
      if (this.sessions.isPersistent(containerId))
        void (browser.extensions as ExtensionService).attachSession()
    })
    this.sessions.get(DEFAULT_CONTAINER_ID)
    this.registerIpc(browser)
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
      const win = this.windows.windowForWebContents(event.sender.id)
      if (!win) throw new Error('Unauthorised sender')
      return browser.handleCommand(win, name, args)
    })
    ipcMain.on('zen:page', (event, message: PageMessage) => {
      this.views.viewForWebContents(event.sender)?.dispatchPageMessage(message)
    })
  }
}

function browserWindowOf(win: ZenWindow | undefined): Electron.BrowserWindow | undefined {
  const host = win?.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}
