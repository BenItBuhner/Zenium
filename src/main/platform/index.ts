import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  session,
  shell,
  type Session,
  type WebContents
} from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, join } from 'node:path'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { contentSettingId } from '../../shared/contentSettings'
import {
  NOTIFICATION_PERMISSION_CHANNEL,
  type NotificationPermissionStatus
} from '../../shared/notifications'
import { Browser } from '../../core/browser'
import { safeOrigin } from '../../core/permissions'
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
  ShellHost,
  ThemeHost
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
import { electronDownloadBridge } from './extensionApi/downloadsBridge'
import { createDnrSink } from './extensionApi/dnrSink'
import { ExtensionFavicons, faviconRequestHandler } from './extensionApi/favicons'
import { ExtensionResourceOrigin } from './extensionApi/resourceOrigin'
import { edgeStoreUserAgent, webstoreClientHints } from './requestHeaders'
import { ResourceGovernor } from './resources/governor'
import { SyncEngine } from '../sync/engine'
import { ElectronAgentTransport } from '../agent/server'
import { ElectronSiteData } from './siteData'
import { ElectronTranslateHost, focusedChromeWebContents } from './translate'
import { ElectronUpdateHost } from './updates'
import { applyAppIcon, iconPngPath } from './appIcon'
import { ElectronDefaultBrowser } from './defaultBrowser'
import { ensureWindowsAppIdRegistered, notificationPermissionStatus } from './notifications'
import { createPasswordsHost } from './passwords'
import {
  attachSecurityHandlers,
  permissionCheckDetails,
  permissionRequestDetails
} from './security'
import { ElectronBlocking, ElectronBundledLists, bundledListsDirectory } from './blocking'
import { supportsWindowMaterial } from './appShell'
import { ElectronPrivacy } from './privacy'

export const ELECTRON_CAPABILITIES: HostCapabilities = {
  windowControls: true,
  windowControlsOverlay: process.platform === 'win32',
  windowMaterial: supportsWindowMaterial(process.platform, release()),
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
  // Status from the OS (shell association, LaunchServices, xdg-settings); the request opens
  // Windows Settings, the macOS prompt or runs xdg-settings (platform/defaultBrowser.ts).
  defaultBrowser: true,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: false,
  // Private browsing is a window of its own on desktop (`windows`).
  privateTabs: false,
  secureDns: true
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
  readonly theme: ThemeHost
  readonly siteData: ElectronSiteData
  readonly passwords: PasswordsHost
  readonly blocking: ElectronBundledLists
  readonly privacy: ElectronPrivacy
  /** The webRequest multiplexer and text matcher; created with the browser in `start`. */
  requestBlocking!: ElectronBlocking
  readonly translate: ElectronTranslateHost
  /** Default-browser status and registration on Windows, macOS and Linux. */
  readonly defaultBrowser = new ElectronDefaultBrowser()
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
    this.downloads = new ElectronDownloads(() => {
      const downloads = resolveDownloadSettings(this.browser.state.settings)
      return { askWhereToSave: downloads.askWhereToSave, directory: downloads.directory }
    })
    // The views hand "Save … As…" downloads to the downloads host, which then asks where to save.
    this.views = new ElectronTabViewHost(this.sessions, this.downloads)
    // The core's Safe Browsing service exists once the browser does (`start`); no request runs before.
    this.privacy = new ElectronPrivacy(this.views, {
      lookup: (url) => (this.browser ? this.browser.protection.safeBrowsing.lookup(url) : null)
    })
    this.siteData = new ElectronSiteData(this.sessions)
    this.menus = new ElectronMenus()
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
      pickFiles: async (options, win?: ZenWindow) => {
        const bw = browserWindowOf(win)
        const dialogOptions = {
          title: options.title,
          properties: ['openFile' as const, 'multiSelections' as const]
        }
        const result = bw
          ? await dialog.showOpenDialog(bw, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions)
        return result.canceled ? [] : result.filePaths
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
      writeImageFromUrl: (url) => copyImageFromUrl(url),
      readText: () => clipboard.readText().catch(() => '')
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
        const target = redirectedOrigin(url)
        const res = await net.fetch(target.url, {
          signal: live.length > 0 ? AbortSignal.any(live) : undefined,
          headers: target.origin
            ? { ...options.headers, 'x-zen-origin': target.origin }
            : options.headers,
          cache: 'no-store'
        })
        const headers: Record<string, string> = {}
        for (const name of ['etag', 'last-modified', 'content-type']) {
          const value = res.headers.get(name)
          if (value) headers[name] = value
        }
        return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '', headers }
      },
      resolveHost: async (host, options) => {
        if (options.signal?.aborted) return false
        try {
          const timeout = new Promise<false>((resolve) => {
            const timer = setTimeout(() => resolve(false), 1500)
            options.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              resolve(false)
            })
          })
          const resolved = await Promise.race([
            session.defaultSession.resolveHost(host).then((r) => r.endpoints.length > 0),
            timeout
          ])
          return resolved
        } catch {
          return false
        }
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
      isDefaultBrowser: () => this.defaultBrowser.isDefault(),
      requestDefaultBrowser: () => this.defaultBrowser.request(),
      // Windows and macOS have a system emoji picker; Linux has none (Chrome shows no item there).
      ...(app.isEmojiPanelSupported() ? { showEmojiPanel: () => app.showEmojiPanel() } : {})
    }
    this.theme = {
      systemDark: () => nativeTheme.shouldUseDarkColors,
      onChanged: (listener) => void nativeTheme.on('updated', listener),
      setSource: (scheme) => {
        nativeTheme.themeSource = scheme
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
    // Extensions' `use_dynamic_url` resources and Chrome's `_favicon/` resource are served from
    // a per-run origin of Zenium's (the lookup runs once the API host below exists); the icons
    // come from the history and bookmarks models.
    const extensionResources = new ExtensionResourceOrigin((id) => extensionApi.loaded(id), {
      favicons: new ExtensionFavicons({ history: browser.history, bookmarks: browser.bookmarks })
    })
    const extensionApi = new ExtensionApiHost(
      browser,
      this.sessions,
      this.views,
      this.io,
      this.userDataDir,
      // Extensions' declarativeNetRequest rule sets go straight into the request-blocking
      // engine, each scoped to the sessions its extension is loaded into (never the private
      // window's unless the user allowed the extension there).
      createDnrSink(browser.blocking.engine, extensionResources, {
        partitionsOf: (id) => extensionApi.partitionsOf(id)
      }),
      electronDownloadBridge(this.downloads)
    )
    extensionApi.install()
    const extensionService = browser.extensions as ExtensionService
    extensionService.attachApi(extensionApi)
    extensionService.onChange((event) => extensionApi.registryChanged(event))
    this.requestBlocking = new ElectronBlocking(browser, this.views, this.profileDir)
    this.requestBlocking.start()
    // Extensions' chrome.webRequest listeners run over the same hook, after the rule engine;
    // so do the request-side effects of chrome.privacy (pings, Referer, DNT).
    extensionApi.webRequest.attach(this.requestBlocking)
    extensionApi.privacy.attach(this.requestBlocking)
    // `chrome-extension://<id>/_favicon/` requests go to the served origin's route (Electron's
    // loader would leave them hanging), for extensions granted the `favicon` permission.
    this.requestBlocking.multiplexer.register(
      faviconRequestHandler(extensionResources, (id) =>
        extensionApi.grants(id).permissions.includes('favicon')
      )
    )
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
    // Safe Browsing ahead of the rules, the cookie and signal edits after them; the upgrade
    // observer and the page preload's signals IPC.
    this.privacy.attach(this.requestBlocking)
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
    // Toasts need the app id registered with Windows; a copy without installer shortcuts
    // (development, portable) registers it itself.
    if (process.platform === 'win32')
      void ensureWindowsAppIdRegistered(app.getName(), iconPngPath(browser.state.settings.appIcon))
    return browser
  }

  private attachPermissions(ses: Session): void {
    const { permissions, external } = this.browser
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const url = details.requestingUrl || webContents?.getURL() || ''
      const tabId = webContents ? this.views.tabIdForWebContents(webContents) : undefined
      const request = permissionRequestDetails(webContents, details, tabId)
      // Chromium does not tell us whether a page's launch of another application had a
      // gesture, so the core's own activation tracking decides: without one the launch is
      // listed with the tab's blocked pop-ups instead of prompting.
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
    this.attachNotificationStatus(browser)
  }

  /**
   * `Notification.permission` for pages: the page preload asks synchronously on the page's
   * first read (the frame's URL is Chromium's word, not the page's), and every change to the
   * notification permission – an answer to a prompt, Settings, Clear browsing data – is pushed
   * to the open pages of the site (all pages when a default changed).
   */
  private attachNotificationStatus(browser: Browser): void {
    const { permissions } = browser
    const statusOf = (url: string, wc: WebContents): NotificationPermissionStatus =>
      notificationPermissionStatus(permissions, url, this.views.tabIdForWebContents(wc))
    ipcMain.on(NOTIFICATION_PERMISSION_CHANNEL, (event) => {
      const url = event.senderFrame?.url ?? event.sender.getURL()
      event.returnValue = statusOf(url, event.sender)
    })
    permissions.subscribe((change) => {
      if (contentSettingId(change.permission) !== 'notifications') return
      for (const view of this.views.all()) {
        if (view.isDestroyed()) continue
        const url = view.getURL()
        if (change.origin !== null && safeOrigin(url) !== change.origin) continue
        view.webContents.send(NOTIFICATION_PERMISSION_CHANNEL, statusOf(url, view.webContents))
      }
    })
  }
}

/**
 * Test hook: `ZEN_NET_ORIGIN=http://127.0.0.1:8788` sends every core fetch (search suggestions,
 * omnibox answers, Live Folders) to that origin instead, with the intended origin in an
 * `x-zen-origin` header, so a harness can answer deterministically. Unset in normal runs.
 */
function redirectedOrigin(url: string): { url: string; origin: string | null } {
  const override = process.env['ZEN_NET_ORIGIN']
  if (!override) return { url, origin: null }
  try {
    const original = new URL(url)
    const target = new URL(override)
    target.pathname = original.pathname
    target.search = original.search
    return { url: target.toString(), origin: original.origin }
  } catch {
    return { url, origin: null }
  }
}

function browserWindowOf(win: ZenWindow | undefined): Electron.BrowserWindow | undefined {
  const host = win?.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}
