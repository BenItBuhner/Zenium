import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  session,
  shell,
  type IpcMainEvent,
  type Session,
  type WebContents
} from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, join } from 'node:path'
import type {
  HostCapabilities,
  NewTabPageAction,
  NewTabPageState,
  Platform as PlatformOs
} from '../../shared/types'
import { isNewTabUrl } from '../../shared/url'
import { contentSettingId } from '../../shared/contentSettings'
import { DISPLAY_MODE_CHANNEL } from '../../shared/displayMode'
import { SCREEN_CAPTURE_INTENT_CHANNEL } from '../../shared/screenCapture'
import {
  NOTIFICATION_PERMISSION_CHANNEL,
  type NotificationPermissionStatus
} from '../../shared/notifications'
import { Browser } from '../../core/browser'
import { permissionSite } from '../../core/permissions'
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
import {
  DISMISSED_ANSWER,
  PAGE_DIALOG_CHANNEL,
  sanitizeDialogCall,
  type PageDialogAnswer
} from '../../shared/pageDialogIpc'
import { FileStoreIO } from './storeIo'
import { SessionManager, buildUserAgent } from './sessions'
import { installZenProtocol } from './protocol'
import { ElectronDownloads } from './downloads'
import { ElectronDownloadsShell } from './downloadsShell'
import { ElectronMenus } from './menus'
import { ElectronTabViewHost, copyImageFromUrl } from './views'
import { ElectronWindowFactory, type ElectronWindow } from './window'
import { ElectronNewTabBackground } from './newTabBackground'
import { ExtensionService } from './extensions'
import { WebstoreBridge } from './webstoreBridge'
import { ExtensionApiHost } from './extensionApi'
import { electronDownloadBridge } from './extensionApi/downloadsBridge'
import { createDnrSink } from './extensionApi/dnrSink'
import { ExtensionFavicons, faviconRequestHandler } from './extensionApi/favicons'
import { ExtensionResourceOrigin } from './extensionApi/resourceOrigin'
import { edgeStoreUserAgent, navigationClientHints, webstoreClientHints } from './requestHeaders'
import { ResourceGovernor } from './resources/governor'
import { ElectronSyncHost } from '../sync/host'
import { ElectronAgentTransport } from '../agent/server'
import { ElectronSiteData } from './siteData'
import { ElectronTranslateHost, focusedChromeWebContents } from './translate'
import { ElectronPrintingHost } from './printing'
import { ElectronUpdateHost } from './updates'
import { applyAppIcon, iconPngPath } from './appIcon'
import { ElectronDefaultBrowser } from './defaultBrowser'
import { ElectronShortcuts } from './shortcuts'
import { ensureWindowsAppIdRegistered, notificationPermissionStatus } from './notifications'
import { createPasswordsHost } from './passwords'
import { attachWebAuthnHandlers, configurePlatformAuthenticators } from './webauthn'
import {
  attachSecurityHandlers,
  permissionCheckDetails,
  permissionName,
  permissionRequestDetails
} from './security'
import { ElectronBlocking, ElectronBundledLists, bundledListsDirectory } from './blocking'
import { supportsWindowMaterial } from './appShell'
import { ElectronPrivacy } from './privacy'
import { ElectronSpellcheck } from './spellcheck'
import { ElectronScreenCapture } from './screenCapture'
import { ElectronShareSheet } from './shareSheet'
import { ElectronGeolocation } from './geolocation'
import { ElectronMpris } from './mpris'
import { ElectronSpeechHost } from './speech'
import { sharedSpeechEngine } from './extensionApi/ttsBridge'

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
  // Pages render to PDF (`printToPDF`) and printers are listed (`getPrintersAsync`): Ctrl+P opens
  // Zenium's preview; Chromium's own preview is not part of Electron.
  printPreview: true,
  // Chromium's PDF viewer draws PDFs in the page itself.
  pdfViewer: false,
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
  darkenSites: true,
  // Private browsing is a window of its own on desktop (`windows`).
  privateTabs: false,
  secureDns: true,
  // `zen://newtab` is served by the zen protocol and bridged by the page preload.
  newTabPage: true,
  // Settings stays an overlay on the desktop until its program adopts the page-tab model.
  pageTabs: false,
  // Installed web apps get a launcher (Start menu / applications menu / ~/Applications) that
  // opens them in a window of their own (platform/shortcuts.ts, MW-22 / MW-23).
  pinShortcuts: true,
  translate: true,
  // No speech recogniser on the desktop hosts; the mic buttons stay away.
  voiceSearch: false,
  screenCapture: true,
  shareSheet: true,
  // Selected text gets the page context menu on the desktop; the floating toolbar is Android's.
  selectionToolbar: false,
  // The autofill picker floats in a `WebContentsView` above the pages (`ElectronWindow.setPopupSurface`).
  popupSurface: true,
  // No camera to scan with on the desktop hosts; the camera buttons stay away.
  qrScan: false,
  // Chromium's `speechSynthesis` behind a hidden page (`platform/speech.ts`).
  readAloud: true
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
  /** Chromium's per-session spellchecker, one setting for every session. */
  readonly spellcheck: ElectronSpellcheck
  /** The print preview's printers and Save as PDF dialog. */
  readonly printing = new ElectronPrintingHost(browserWindowOf)
  /** Default-browser status and registration on Windows, macOS and Linux. */
  readonly defaultBrowser = new ElectronDefaultBrowser()
  /** Installed web apps' launchers and icons (MW-22). */
  readonly shortcuts: ElectronShortcuts
  /** `getDisplayMedia`: the sources behind the core's picker and the grant to the engine (MW-19). */
  readonly screenCapture: ElectronScreenCapture
  /** Shared files to the downloads folder; macOS's own share sheet (MW-21). */
  readonly shareSheet: ElectronShareSheet
  /** The Wi-Fi scan behind the network location provider; Linux and Windows have a scanner (MW-04). */
  readonly geolocation = new ElectronGeolocation()
  /** Cross-device sync: the system folder dialog, the hostname, a node:fs folder transport (ID-08). */
  readonly sync = new ElectronSyncHost()
  /** Linux: Zenium as an MPRIS player on the session bus (MW-18). */
  readonly mediaSession?: ElectronMpris
  /** Read aloud's voices and utterances over the hidden `speechSynthesis` page (CT-12 / CT-13). */
  readonly speech: ElectronSpeechHost = new ElectronSpeechHost(sharedSpeechEngine())
  readonly newTabBackground: ElectronNewTabBackground
  /** Taskbar progress, dock badge and completion notifications for downloads. */
  downloadsShell: ElectronDownloadsShell | null = null
  browser!: Browser
  private readonly profileDir: string

  constructor(private readonly userDataDir: string) {
    this.info = { os: process.platform as PlatformOs, version: app.getVersion() }
    this.profileDir = join(userDataDir, 'zen')
    this.io = new FileStoreIO(this.profileDir)
    this.blocking = new ElectronBundledLists(bundledListsDirectory(), this.profileDir)
    this.newTabBackground = new ElectronNewTabBackground(join(this.profileDir, 'newtab'))
    // The launcher confirms to the core once its files are written (the browser exists by then:
    // pins are asked for from a page).
    this.shortcuts = new ElectronShortcuts(join(this.profileDir, 'webapps'), (id, details) =>
      this.browser.webApps.onPinned(id, details)
    )
    this.windows = new ElectronWindowFactory()
    this.translate = new ElectronTranslateHost(userDataDir, () =>
      focusedChromeWebContents((id) => this.windows.windowForWebContents(id) !== undefined)
    )
    this.sessions = new SessionManager(buildUserAgent())
    this.spellcheck = new ElectronSpellcheck(this.sessions)
    this.downloads = new ElectronDownloads(
      () => {
        const downloads = resolveDownloadSettings(this.browser.state.settings)
        return { askWhereToSave: downloads.askWhereToSave, directory: downloads.directory }
      },
      () => this.browser.state.settings.appIcon
    )
    // The views hand "Save … As…" downloads to the downloads host, which then asks where to save.
    this.views = new ElectronTabViewHost(this.sessions, this.downloads)
    this.screenCapture = new ElectronScreenCapture(this.views, () => this.browser.screenCapture)
    this.shareSheet = new ElectronShareSheet(
      () =>
        resolveDownloadSettings(this.browser.state.settings).directory ?? app.getPath('downloads'),
      (win) => browserWindowOf(win)
    )
    if (process.platform === 'linux') this.mediaSession = new ElectronMpris(() => this.browser)
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
      // Asynchronous since Electron 44; the host contract stays fire-and-forget. Electron has no
      // sensitive flag for the system clipboard; the core's timed clearing covers desktop.
      writeText: (text) =>
        void clipboard
          .writeText(text)
          .catch((error: Error) => console.warn('[zen] clipboard:', error.message)),
      writeImageFromUrl: (url) => copyImageFromUrl(url),
      readText: () => clipboard.readText().catch(() => ''),
      clearText: async (expected) => {
        try {
          if ((await clipboard.readText()) === expected) clipboard.clear()
        } catch (error) {
          console.warn('[zen] clipboard:', (error as Error).message)
        }
      }
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
          method: options.method ?? 'GET',
          body: options.method === 'POST' ? (options.body ?? '') : undefined,
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
        if (!res.ok) return { ok: false, status: res.status, text: '', headers }
        if (options.maxBytes !== undefined) {
          // The cap bounds the download: the body is read in chunks and dropped, the connection
          // with it, as soon as it runs past the cap (the same failure shape as Android's).
          const text = await readCapped(res, options.maxBytes)
          if (text === null) return { ok: false, status: 0, text: '', headers: {} }
          return { ok: true, status: res.status, text, headers }
        }
        return { ok: true, status: res.status, text: await res.text(), headers }
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

  createAgentTransport(): ElectronAgentTransport {
    return new ElectronAgentTransport()
  }

  createUpdateHost(): ElectronUpdateHost {
    return new ElectronUpdateHost()
  }

  /**
   * Build the browser, wire IPC and sessions, and restore the windows (`windows: false` holds
   * the browser windows back for a run that begins on an app window alone, `Browser.start`).
   */
  start(options: { windows?: boolean } = {}): Browser {
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
    // How a download's request ends (a refusing status, a `net::` error) names the reason an
    // interrupted row shows; Electron's download item alone only says "interrupted".
    this.downloads.observeRequests(this.requestBlocking)
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
    // Chrome's low-entropy client hints on the navigations Electron sends without any (every
    // session, the private window's included), then the stores' header rewrites (Chrome's brand
    // for the Chrome Web Store, Edge's user agent and brand for Edge Add-ons); all builtin
    // handlers of the multiplexer, which owns each session's one onBeforeSendHeaders slot. The
    // store rewrites run after the hints, so the brand they add lands in a list that exists;
    // persistent sessions only, like the store preload.
    this.requestBlocking.registerHeaderRewrite(navigationClientHints)
    this.requestBlocking.registerHeaderRewrite(webstoreClientHints, { persistentOnly: true })
    this.requestBlocking.registerHeaderRewrite(edgeStoreUserAgent, { persistentOnly: true })
    // Safe Browsing ahead of the rules, the cookie and signal edits after them; the upgrade
    // observer and the page preload's signals IPC.
    this.privacy.attach(this.requestBlocking)
    this.downloadsShell = new ElectronDownloadsShell(browser)
    this.sessions.configure((ses: Session, containerId: string) => {
      installZenProtocol(
        ses,
        (id) => browser.reader.pageHtml(id),
        () => this.newTabBackground.response()
      )
      extensionResources.install(ses)
      // The one webRequest listener set of the session; every request hook goes through it.
      this.requestBlocking.attach(ses, containerId)
      this.attachPermissions(ses, (target, origin) =>
        extensionApi.tabCapture.allowsMediaRequest(target, origin)
      )
      // `getDisplayMedia` goes to the core's picker instead of Electron's flat refusal.
      this.screenCapture.attach(ses)
      attachWebAuthnHandlers(browser, this.views, ses)
      this.downloads.attach(ses, containerId, (sourceTabId) =>
        browser.onDownloadStarted(sourceTabId)
      )
      if (this.sessions.isPersistent(containerId)) {
        webstore.attach(ses)
        extensionApi.attachSession(ses, containerId)
        void (browser.extensions as ExtensionService).attachSession(ses)
      }
    })
    this.sessions.get(DEFAULT_CONTAINER_ID)
    this.registerIpc(browser)
    attachSecurityHandlers(browser, this.views, extensionApi.webRequest)
    configurePlatformAuthenticators(__ZENIUM_APPLE_TEAM_ID__)
    browser.start(options)
    // The engine has its persisted rule sets now: the ones of extensions removed or disabled
    // while Zenium was closed go before the enabled ones load (`extensions.start`, above).
    extensionApi.declarativeNetRequest.reconcile()
    // Toasts need the app id registered with Windows; a copy without installer shortcuts
    // (development, portable) registers it itself.
    if (process.platform === 'win32')
      void ensureWindowsAppIdRegistered(app.getName(), iconPngPath(browser.state.settings.appIcon))
    return browser
  }

  /**
   * `tabCaptureAllows`: whether an extension's `chrome.tabCapture` request stands behind a media
   * request the engine makes on a tab for a consuming document of `securityOrigin`.
   */
  private attachPermissions(
    ses: Session,
    tabCaptureAllows: (target: WebContents, securityOrigin: string | undefined) => boolean
  ): void {
    const { permissions, external } = this.browser
    ses.setPermissionRequestHandler((webContents, rawPermission, callback, details) => {
      const url = details.requestingUrl || webContents?.getURL() || ''
      const tabId = webContents ? this.views.tabIdForWebContents(webContents) : undefined
      const request = permissionRequestDetails(webContents, details, tabId)
      // A `getDisplayMedia` call arrives as `media` without devices: the screen-sharing row,
      // whose Allow puts the picker up right here – the picker is the consent, and only a
      // refusal at this stage reads as Chrome's `NotAllowedError` to the page. Its answer waits
      // for the engine's display-media request (`screenCapture.attach`).
      const permission = permissionName(rawPermission, details)
      // An extension's tab capture arrives the same way, on the captured tab, from the
      // consuming document's origin: the user's gesture on the extension was the consent
      // (Chrome's `tabCaptureForTab`), and the engine's stream registry already tied the id to
      // that one document and moment.
      if (
        permission === 'display-capture' &&
        webContents &&
        tabCaptureAllows(
          webContents,
          'securityOrigin' in details ? details.securityOrigin : undefined
        )
      ) {
        callback(true)
        return
      }
      if (permission === 'display-capture' && tabId && webContents) {
        void permissions
          .decide(permission, url, request)
          .then((allowed) =>
            allowed ? this.screenCapture.permission(webContents, tabId, url) : false
          )
          .then(callback)
        return
      }
      // Chromium does not tell us whether a page's launch of another application had a
      // gesture, so the core's own activation tracking decides: without one the launch is
      // listed with the tab's blocked pop-ups instead of prompting.
      if (permission === 'openExternal' && tabId && request.externalUrl) {
        void external.request(tabId, request.externalUrl).then(callback)
        return
      }
      // A page locking the keyboard keeps Esc: the fullscreen hint says to hold it instead.
      if (permission === 'keyboardLock' && tabId)
        this.browser.fullscreen.keyboardLockRequested(tabId)
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
    // A page's `alert` / `confirm` / `prompt`: the renderer blocks on `sendSync` until
    // `returnValue` is set, which happens once the chrome's dialog is answered. Every path must
    // set it, or the page would hang.
    ipcMain.on(PAGE_DIALOG_CHANNEL, (event, raw: unknown) => {
      const answer = (value: PageDialogAnswer): void => {
        try {
          event.returnValue = value
        } catch {
          // The page went away while its dialog was up.
        }
      }
      const view = this.views.viewForWebContents(event.sender)
      const call = sanitizeDialogCall(raw)
      if (!view || !call) {
        answer(DISMISSED_ANSWER)
        return
      }
      view
        .askDialog(call, event.senderFrame?.url ?? '')
        .then(answer, () => answer(DISMISSED_ANSWER))
    })
    // The new tab page: its preload fetches the first state synchronously (before the first
    // paint) and sends actions. Only the main frame of a tab view showing `zen://newtab` is heard.
    ipcMain.on('zen:newtab-state', (event) => {
      const tabId = this.newTabSender(event)
      const state: NewTabPageState | null = tabId ? browser.newTab.stateFor(tabId) : null
      event.returnValue = state
    })
    ipcMain.on('zen:newtab', (event, action: NewTabPageAction) => {
      const tabId = this.newTabSender(event)
      if (!tabId || !action || typeof action.type !== 'string') return
      if (!isNewTabUrl(event.senderFrame?.url ?? event.sender.getURL())) return
      browser.newTab.handleAction(tabId, action)
    })
    // A page's `display-mode` (MW-23), asked synchronously at document start by every frame of a
    // tab's page; anything else that asks (the chrome, an extension page) is a browser page.
    ipcMain.on(DISPLAY_MODE_CHANNEL, (event) => {
      const tabId = this.views.tabIdForWebContents(event.sender)
      event.returnValue = tabId ? browser.displayModeFor(tabId) : 'browser'
    })
    // A page's `getDisplayMedia` call, announced synchronously by its main-world shim right
    // before the engine sees it (MW-19): whether it asked for audio, which the permission
    // request that follows does not say. Only a tab's page is heard; the answer is immediate,
    // as the page's call waits on it.
    ipcMain.on(SCREEN_CAPTURE_INTENT_CHANNEL, (event, audio: unknown) => {
      if (this.views.viewForWebContents(event.sender))
        this.screenCapture.intent(event.sender, audio === true)
      event.returnValue = true
    })
    this.attachNotificationStatus(browser)
  }

  /** The tab (or preloaded placeholder) whose main frame sent a new tab page message. */
  private newTabSender(event: IpcMainEvent): string | undefined {
    if (!this.views.viewForWebContents(event.sender)) return undefined
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return undefined
    return this.views.tabIdForWebContents(event.sender)
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
        if (change.origin !== null && permissionSite(url) !== change.origin) continue
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

/**
 * A response body read no further than `maxBytes` (`NetHost.fetchText`'s cap): the stream is
 * cancelled and null returned as soon as the bytes read run past it, so an oversized body is
 * not downloaded whole and then thrown away. Decoded as UTF-8, as `Response.text()` would.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.byteLength
    if (read > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function browserWindowOf(win: ZenWindow | undefined): Electron.BrowserWindow | undefined {
  const host = win?.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}
