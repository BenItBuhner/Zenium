import { app, clipboard, dialog, ipcMain, net, shell, type Session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
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
  PasswordsHost,
  PickedTextFile,
  Platform,
  PlatformInfo,
  ShellHost
} from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { resolveDownloadSettings } from '../../shared/downloads'
import { FileStoreIO } from './storeIo'
import { SessionManager, buildUserAgent } from './sessions'
import { installZenProtocol } from './protocol'
import { ElectronDownloads } from './downloads'
import { ElectronMenus } from './menus'
import { ElectronTabViewHost, copyImageFromUrl } from './views'
import { ElectronWindowFactory, type ElectronWindow } from './window'
import { ExtensionService } from './extensions'
import { WebstoreBridge } from './webstoreBridge'
import { ExtensionApiHost } from './extensionApi'
import { createDnrSink } from './extensionApi/dnrSink'
import { ExtensionResourceOrigin } from './extensionApi/resourceOrigin'
import { edgeStoreUserAgent, webstoreClientHints } from './requestHeaders'
import { ResourceGovernor } from './resources/governor'
import { SyncEngine } from '../sync/engine'
import { ElectronAgentTransport } from '../agent/server'
import { ElectronSiteData } from './siteData'
import { ElectronTranslateHost, focusedChromeWebContents } from './translate'
import { ElectronUpdateHost } from './updates'
import { applyAppIcon } from './appIcon'
import { createPasswordsHost } from './passwords'
import {
  attachSecurityHandlers,
  permissionCheckDetails,
  permissionRequestDetails
} from './security'
import { ElectronBlocking, ElectronBundledLists, bundledListsDirectory } from './blocking'

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
  agents: true,
  updates: true,
  share: false,
  clipboardChip: false,
  appLinkSettings: false,
  pullToRefresh: false,
  passwords: true,
  // The OS owns default-app choices on desktop; the desktop program decides if Zenium ever asks.
  defaultBrowser: false,
  requestBlocking: true
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
  readonly siteData: ElectronSiteData
  readonly passwords: PasswordsHost
  readonly blocking: ElectronBundledLists
  /** The webRequest multiplexer and text matcher; created with the browser in `start`. */
  requestBlocking!: ElectronBlocking
  readonly translate: ElectronTranslateHost
  browser!: Browser
  private readonly profileDir: string

  constructor(private readonly userDataDir: string) {
    this.info = { os: process.platform as PlatformOs, version: app.getVersion() }
    this.profileDir = join(userDataDir, 'zen')
    this.io = new FileStoreIO(this.profileDir)
    this.blocking = new ElectronBundledLists(bundledListsDirectory(), this.profileDir)
    this.windows = new ElectronWindowFactory()
    this.translate = new ElectronTranslateHost(userDataDir, () =>
      focusedChromeWebContents((id) => this.windows.windowForWebContents(id) !== undefined)
    )
    this.sessions = new SessionManager(buildUserAgent())
    this.views = new ElectronTabViewHost(this.sessions)
    this.siteData = new ElectronSiteData(this.sessions)
    this.menus = new ElectronMenus()
    this.downloads = new ElectronDownloads(() => {
      const downloads = resolveDownloadSettings(this.browser.state.settings)
      return { askWhereToSave: downloads.askWhereToSave, directory: downloads.directory }
    })
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
      },
      saveTextFile: async (options, win?: ZenWindow) => {
        const bw = browserWindowOf(win)
        const dialogOptions = {
          title: options.title,
          defaultPath: join(app.getPath('downloads'), options.defaultName),
          filters: [
            { name: options.extensions.join(', ').toUpperCase(), extensions: options.extensions }
          ]
        }
        const result = bw
          ? await dialog.showSaveDialog(bw, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)
        if (result.canceled || !result.filePath) return false
        try {
          writeFileSync(result.filePath, options.text, 'utf8')
          return true
        } catch (error) {
          console.warn('[zen] save file:', (error as Error).message)
          return false
        }
      }
    }
    this.passwords = createPasswordsHost()
    this.clipboard = {
      // Asynchronous since Electron 44; the host contract stays fire-and-forget.
      writeText: (text) =>
        void clipboard
          .writeText(text)
          .catch((error: Error) => console.warn('[zen] clipboard:', error.message)),
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
        const signals = [
          options.signal,
          options.timeoutMs && AbortSignal.timeout(options.timeoutMs)
        ]
        const live = signals.filter((s): s is AbortSignal => Boolean(s))
        const res = await net.fetch(url, {
          signal: live.length > 0 ? AbortSignal.any(live) : undefined,
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
      },
      setAppIcon: (id) =>
        applyAppIcon(
          id,
          this.browser
            .allWindows()
            .map((win) => browserWindowOf(win))
            .filter((bw): bw is Electron.BrowserWindow => bw !== undefined)
        ),
      isDefaultBrowser: async () => null,
      requestDefaultBrowser: async () => null
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
    return new ExtensionService(browser, this.sessions, this.userDataDir)
  }

  createSync(browser: Browser): SyncEngine {
    return new SyncEngine(browser)
  }

  createAgentTransport(): ElectronAgentTransport {
    return new ElectronAgentTransport()
  }

  createUpdateHost(): ElectronUpdateHost {
    return new ElectronUpdateHost()
  }

  /** Build the browser, wire IPC and sessions, and restore the windows. */
  start(): Browser {
    const browser = new Browser(this)
    this.browser = browser
    this.windows.bind(browser)
    this.downloads.bind(browser.downloads, {
      tabIdFor: (source) => this.views.tabIdForWebContents(source) ?? null,
      parentWindow: (sourceTabId) =>
        browserWindowOf(sourceTabId ? browser.tabs.windowFor(sourceTabId) : browser.focusedWindow())
    })
    const webstore = new WebstoreBridge(browser.extensions as ExtensionService, (wc) => {
      const tabId = this.views.tabIdForWebContents(wc)
      return tabId ? browser.tabs.ownerOf(tabId) : undefined
    })
    webstore.install()
    // Extensions' `use_dynamic_url` resources are served from a per-run origin of Zenium's (the
    // lookup runs once the API host below exists).
    const extensionResources = new ExtensionResourceOrigin((id) => extensionApi.loaded(id))
    const extensionApi = new ExtensionApiHost(
      browser,
      this.sessions,
      this.views,
      this.io,
      this.userDataDir,
      // Extensions' declarativeNetRequest rule sets go straight into the request-blocking engine.
      createDnrSink(browser.blocking.engine, extensionResources)
    )
    extensionApi.install()
    const extensionService = browser.extensions as ExtensionService
    extensionService.attachApi(extensionApi)
    extensionService.onChange((event) => extensionApi.registryChanged(event))
    this.requestBlocking = new ElectronBlocking(browser, this.views, this.profileDir)
    this.requestBlocking.start()
    // Decisions the engine took by an extension's rule feed getMatchedRules, the action badge
    // count and onRuleMatchedDebug.
    this.requestBlocking.onDecision((request, decision) =>
      extensionApi.declarativeNetRequest.decided(request, decision)
    )
    // The stores' header rewrites (Chrome's brand for the Chrome Web Store, Edge's user agent
    // and brand for Edge Add-ons) run as builtin handlers of the multiplexer, which owns each
    // session's one onBeforeSendHeaders slot; persistent sessions only, like the store preload.
    this.requestBlocking.registerHeaderRewrite(webstoreClientHints, { persistentOnly: true })
    this.requestBlocking.registerHeaderRewrite(edgeStoreUserAgent, { persistentOnly: true })
    this.sessions.configure((ses: Session, containerId: string) => {
      installZenProtocol(ses, (id) => browser.reader.pageHtml(id))
      extensionResources.install(ses)
      // The one webRequest listener set of the session; every request hook goes through it.
      this.requestBlocking.attach(ses, containerId)
      this.attachPermissions(ses)
      this.downloads.attach(ses, containerId, (sourceTabId) =>
        browser.onDownloadStarted(sourceTabId)
      )
      ses.setSpellCheckerLanguages(['en-US'])
      if (this.sessions.isPersistent(containerId)) {
        webstore.attach(ses)
        extensionApi.attachSession(ses, containerId)
        void (browser.extensions as ExtensionService).attachSession()
      }
    })
    this.sessions.get(DEFAULT_CONTAINER_ID)
    this.registerIpc(browser)
    attachSecurityHandlers(browser, this.views)
    browser.start()
    return browser
  }

  private attachPermissions(ses: Session): void {
    const { permissions, external } = this.browser
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const url = details.requestingUrl || webContents?.getURL() || ''
      const request = permissionRequestDetails(webContents, details)
      // Chromium does not tell us whether a page's launch of another application had a
      // gesture, so the core's own activation tracking decides: without one the launch is
      // listed with the tab's blocked pop-ups instead of prompting.
      const tabId = webContents ? this.views.tabIdForWebContents(webContents) : undefined
      if (permission === 'openExternal' && tabId && request.externalUrl) {
        void external.request(tabId, request.externalUrl).then(callback)
        return
      }
      void permissions.decide(permission, url, request).then(callback)
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
      permissions.check(
        permission,
        requestingOrigin,
        permissionCheckDetails(permission, requestingOrigin, details, this.browser)
      )
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
