import { WebContentsView, dialog, type Extension } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type {
  ExtensionInfo,
  ExtensionPromptRequest,
  ExtensionUpdateCheck,
  Rect
} from '../../shared/types'
import {
  buildMessageCatalog,
  localeFallbackChain,
  localizeManifest,
  type LocaleMessages
} from '../../core/extensions/manifest'
import { isExtensionId, parseStorePageUrl } from '../../core/extensions/store'
import { JsonStore } from '../../core/store/JsonStore'
import type { Browser } from '../../core/browser'
import type { ExtensionHost, PopupFrame } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import type { SessionManager } from './sessions'
import type { ElectronWindow } from './window'

interface Entry {
  path: string
  enabled: boolean
  // Extensions UI (W1-D): reconcile with the store PR on rebase.
  pinned?: boolean
  allowFileAccess?: boolean
  installedAt?: number
}

interface Persisted {
  version: 1
  extensions: Entry[]
  lastUpdateCheckAt?: number | null
}

interface Manifest {
  name?: string
  version?: string
  description?: string
  default_locale?: string
  manifest_version?: number
  icons?: Record<string, string>
  permissions?: unknown[]
  host_permissions?: unknown[]
  options_page?: string
  options_ui?: { page?: string; open_in_tab?: boolean }
  action?: { default_popup?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_popup?: string; default_icon?: string | Record<string, string> }
}

/** Chrome's popup limits: the document sizes the view between these, the frame follows. */
const POPUP_MIN = { width: 25, height: 25 }
const POPUP_MAX = { width: 800, height: 600 }
/** Width and height of the popup view before its document has asked for a size. */
const POPUP_INITIAL = { width: 380, height: 200 }

/**
 * Unpacked Chrome extensions (Electron supports a subset of the extension APIs – content
 * scripts, storage, webRequest, scripting, devtools panels). Extensions are loaded into every
 * persistent container session and remembered across restarts; browser-action popups are shown
 * from the toolbar since Electron has no extension UI of its own.
 *
 * The popup is a `WebContentsView` owned here, but the renderer draws the panel it sits in: it
 * hands over the exact bounds for the view (`extension.openPopup`), this service reports the
 * document's preferred size back (`extension.popupSize`) and moves or shows the view when the
 * renderer answers with `extension.resizePopup`. The view stays hidden until the frame has popped
 * in, so both appear as one surface.
 */
export class ExtensionService implements ExtensionHost {
  private entries: Entry[] = []
  private readonly loaded = new Map<string, Extension>()
  private readonly errors = new Map<string, string>()
  private readonly store: JsonStore<Persisted>
  private popup: { id: string; view: WebContentsView; win: ZenWindow } | null = null
  private lastUpdateCheckAt: number | null = null
  private checking = false
  /** Install and permission prompts waiting for the renderer's answer, by request id. */
  private readonly prompts = new Map<string, (accept: boolean) => void>()

  constructor(
    private readonly browser: Browser,
    private readonly sessions: SessionManager
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'extensions.json', 300)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.extensions)) {
      this.entries = data.extensions.filter((e) => e && typeof e.path === 'string')
      this.lastUpdateCheckAt = data.lastUpdateCheckAt ?? null
    }
  }

  async start(): Promise<void> {
    for (const entry of this.entries) if (entry.enabled) await this.load(entry)
    this.browser.state.commitVolatile()
  }

  /** Load into every persistent session so content scripts run in all containers. */
  private async load(entry: Entry): Promise<void> {
    const { path } = entry
    this.errors.delete(path)
    if (!existsSync(join(path, 'manifest.json'))) {
      this.errors.set(path, 'manifest.json not found')
      return
    }
    for (const [, ses] of this.sessions.persistent()) {
      try {
        const ext =
          ses.extensions.getAllExtensions().find((e) => e.path === path) ??
          (await ses.extensions.loadExtension(path, {
            allowFileAccess: entry.allowFileAccess ?? false
          }))
        if (!this.loaded.has(path)) this.loaded.set(path, ext)
      } catch (error) {
        this.errors.set(path, (error as Error).message)
      }
    }
  }

  private unload(path: string): void {
    const ext = this.loaded.get(path)
    if (!ext) return
    for (const [, ses] of this.sessions.persistent()) {
      try {
        ses.extensions.removeExtension(ext.id)
      } catch {
        /* not loaded in this session */
      }
    }
    this.loaded.delete(path)
  }

  /** A new container session appeared: bring the enabled extensions along. */
  async attachSession(): Promise<void> {
    for (const entry of this.entries) if (entry.enabled) await this.load(entry)
  }

  list(): ExtensionInfo[] {
    return this.entries.map((entry) => {
      const manifest = readManifest(entry.path)
      const ext = this.loaded.get(entry.path)
      const action = manifest?.action ?? manifest?.browser_action
      const optionsPage = manifest?.options_ui?.page ?? manifest?.options_page ?? null
      return {
        id: ext?.id ?? entry.path,
        name: ext?.name ?? manifest?.name ?? entry.path.split(/[\\/]/).pop() ?? 'Extension',
        version: ext?.version ?? manifest?.version ?? '',
        description: manifest?.description ?? '',
        path: entry.path,
        enabled: entry.enabled,
        icon: iconDataUrl(entry.path, manifest),
        popup: action?.default_popup ?? null,
        error: this.errors.get(entry.path) ?? null,
        source: 'unpacked',
        manifestVersion: manifest?.manifest_version,
        permissions: strings(manifest?.permissions),
        hostPermissions: strings(manifest?.host_permissions),
        optionsPage,
        pinned: entry.pinned ?? false,
        allowFileAccess: entry.allowFileAccess ?? false,
        installedAt: entry.installedAt,
        updateState: 'up-to-date',
        warnings: permissionWarnings(manifest)
      }
    })
  }

  updateCheck(): ExtensionUpdateCheck {
    return { lastCheckedAt: this.lastUpdateCheckAt, checking: this.checking }
  }

  private entryFor(idOrPath: string): Entry | undefined {
    return this.entries.find((e) => e.path === idOrPath || this.loaded.get(e.path)?.id === idOrPath)
  }

  async addFromDialog(win: ZenWindow): Promise<void> {
    const result = await dialog.showOpenDialog((win.host as ElectronWindow).win, {
      title: 'Load unpacked extension',
      properties: ['openDirectory'],
      buttonLabel: 'Load extension'
    })
    if (result.canceled || !result.filePaths[0]) return
    await this.add(result.filePaths[0], win)
  }

  async add(path: string, win?: ZenWindow): Promise<void> {
    if (this.entries.some((e) => e.path === path)) {
      this.browser.toast('This extension is already installed.', 'info', win)
      return
    }
    if (!existsSync(join(path, 'manifest.json'))) {
      this.browser.toast('That folder has no manifest.json.', 'error', win)
      return
    }
    const entry: Entry = { path, enabled: true, pinned: false, installedAt: Date.now() }
    this.entries.push(entry)
    await this.load(entry)
    this.persist()
    const error = this.errors.get(path)
    if (error) {
      this.browser.toast(`Could not load extension: ${error}`, 'error', win)
    } else {
      const ext = this.loaded.get(path)
      this.browser.emit(
        'extension.installed',
        {
          id: ext?.id ?? path,
          name: ext?.name ?? readManifest(path)?.name ?? 'Extension',
          pinned: false
        },
        win
      )
    }
    this.browser.state.commitVolatile()
  }

  remove(idOrPath: string): void {
    const entry = this.entryFor(idOrPath)
    if (!entry) return
    if (this.popup?.id === this.loaded.get(entry.path)?.id) this.closePopup()
    this.unload(entry.path)
    this.entries = this.entries.filter((e) => e !== entry)
    this.errors.delete(entry.path)
    this.persist()
    this.browser.state.commitVolatile()
  }

  async setEnabled(idOrPath: string, enabled: boolean): Promise<void> {
    const entry = this.entryFor(idOrPath)
    if (!entry || entry.enabled === enabled) return
    entry.enabled = enabled
    if (enabled) await this.load(entry)
    else {
      if (this.popup?.id === this.loaded.get(entry.path)?.id) this.closePopup()
      this.unload(entry.path)
    }
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Extensions UI (W1-D): management commands. The store PR replaces the install and update
  // stubs with the real download / verify / install flow; reload, options, pin and file access
  // are complete here.
  // ---------------------------------------------------------------------------

  async installFromStore(ref: string, win: ZenWindow): Promise<void> {
    const text = ref.trim()
    const target = isExtensionId(text) ? { id: text } : parseStorePageUrl(text)
    if (!target) {
      this.browser.toast('That is not a Chrome Web Store or Edge Add-ons link or id.', 'error', win)
      return
    }
    this.browser.toast('Installing from the store is not available yet.', 'info', win)
  }

  async installFromFile(win: ZenWindow): Promise<void> {
    const result = await dialog.showOpenDialog((win.host as ElectronWindow).win, {
      title: 'Install extension from file',
      properties: ['openFile'],
      filters: [{ name: 'Extension packages', extensions: ['crx', 'zip'] }],
      buttonLabel: 'Install'
    })
    if (result.canceled || !result.filePaths[0]) return
    await this.installFromDrop([result.filePaths[0]], win)
  }

  /**
   * Dropped or picked paths: a folder with a manifest is confirmed like a store install and then
   * loaded unpacked; packages wait for the store PR.
   */
  async installFromDrop(paths: string[], win: ZenWindow): Promise<void> {
    for (const path of paths) {
      const stat = statOf(path)
      if (stat?.isDirectory()) {
        if (this.entries.some((e) => e.path === path)) {
          this.browser.toast('This extension is already installed.', 'info', win)
          continue
        }
        const manifest = readManifest(path)
        if (!manifest) {
          this.browser.toast('That folder has no manifest.json.', 'error', win)
          continue
        }
        const accepted = await this.ask(
          {
            kind: 'install',
            name: manifest.name ?? path.split(/[\\/]/).pop() ?? 'Extension',
            icon: iconDataUrl(path, manifest),
            warnings: permissionWarnings(manifest),
            source: 'unpacked'
          },
          win
        )
        if (accepted) await this.add(path, win)
        continue
      }
      const ext = extname(path).toLowerCase()
      if (ext === '.crx' || ext === '.zip') {
        this.browser.toast('Installing packaged extensions is not available yet.', 'info', win)
      } else {
        this.browser.toast(
          'Drop a .crx or .zip package, or an unpacked extension folder.',
          'error',
          win
        )
      }
    }
  }

  /** Unpacked extensions have no update source; this records the check for the caption. */
  async checkForUpdates(): Promise<void> {
    this.checking = true
    this.browser.state.commitVolatile()
    this.lastUpdateCheckAt = Date.now()
    this.checking = false
    this.persist()
    this.browser.state.commitVolatile()
  }

  async update(id: string, win: ZenWindow): Promise<void> {
    if (!this.entryFor(id)) return
    this.browser.toast('Updating extensions is not available yet.', 'info', win)
  }

  async reload(id: string): Promise<void> {
    const entry = this.entryFor(id)
    if (!entry) return
    if (this.popup?.id === this.loaded.get(entry.path)?.id) this.closePopup()
    this.unload(entry.path)
    if (entry.enabled) await this.load(entry)
    this.browser.state.commitVolatile()
  }

  openOptions(id: string, win: ZenWindow): void {
    const entry = this.entryFor(id)
    const ext = entry ? this.loaded.get(entry.path) : undefined
    const manifest = entry ? readManifest(entry.path) : null
    const page = manifest?.options_ui?.page ?? manifest?.options_page
    if (!ext || !page) return
    this.closePopup()
    this.browser.tabs.createTab(
      { url: `chrome-extension://${ext.id}/${page.replace(/^\/+/, '')}`, active: true },
      win
    )
  }

  setPinned(id: string, pinned: boolean): void {
    const entry = this.entryFor(id)
    if (!entry || (entry.pinned ?? false) === pinned) return
    entry.pinned = pinned
    this.persist()
    this.browser.state.commitVolatile()
  }

  async setAllowFileAccess(id: string, allow: boolean): Promise<void> {
    const entry = this.entryFor(id)
    if (!entry || (entry.allowFileAccess ?? false) === allow) return
    entry.allowFileAccess = allow
    this.persist()
    if (entry.enabled) {
      this.unload(entry.path)
      await this.load(entry)
    }
    this.browser.state.commitVolatile()
  }

  /**
   * Put a question to the user through the renderer's dialog and wait for the answer. This is
   * the store PR's `confirmInstall` hook: install and update prompts raise
   * `extensionInstallRequest`, runtime `permissions.request` raises `extensionPermissionRequest`.
   */
  ask(prompt: Omit<ExtensionPromptRequest, 'requestId'>, win: ZenWindow): Promise<boolean> {
    const event =
      prompt.kind === 'permissions' ? 'extensionPermissionRequest' : 'extensionInstallRequest'
    const requestId = `${event}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    return new Promise<boolean>((resolve) => {
      this.prompts.set(requestId, resolve)
      this.browser.emit(event, { requestId, ...prompt }, win)
    })
  }

  respondPrompt(requestId: string, accept: boolean): void {
    const resolve = this.prompts.get(requestId)
    if (!resolve) return
    this.prompts.delete(requestId)
    resolve(accept)
  }

  // ---------------------------------------------------------------------------
  // Browser-action popups
  // ---------------------------------------------------------------------------

  openPopup(id: string, anchor: Rect, win: ZenWindow, frame?: PopupFrame): void {
    this.closePopup()
    const entry = this.entryFor(id)
    const ext = entry ? this.loaded.get(entry.path) : undefined
    const info = entry ? this.list().find((e) => e.path === entry.path) : undefined
    // No popup: Chrome fires `action.onClicked` instead (the API-layer PR dispatches it).
    if (!entry || !ext || !info?.popup) return
    const ses = this.sessions.persistent()[0]?.[1]
    if (!ses) return
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Chrome sizes a popup to its document; Chromium reports that as the preferred size.
        enablePreferredSizeMode: true
      }
    })
    view.setBackgroundColor('#00000000')
    const bw = (win.host as ElectronWindow).win
    const contentBounds = bw.getContentBounds()
    if (frame) {
      view.setBorderRadius(frame.radius)
      view.setBounds(roundRect(frame.bounds))
      // The renderer shows the view once its frame has popped in (extension.resizePopup).
      view.setVisible(false)
    } else {
      // Legacy placement (no renderer frame): under the anchor, sized by the document height.
      view.setBorderRadius(12)
      const x = Math.max(
        8,
        Math.min(
          anchor.x + anchor.width - POPUP_INITIAL.width,
          contentBounds.width - POPUP_INITIAL.width - 8
        )
      )
      view.setBounds({
        x: Math.round(x),
        y: Math.round(anchor.y + anchor.height + 6),
        width: POPUP_INITIAL.width,
        height: POPUP_INITIAL.height
      })
    }
    bw.contentView.addChildView(view)
    this.popup = { id: ext.id, view, win }
    const wc = view.webContents
    const report = (width: number, height: number): void => {
      if (this.popup?.view !== view) return
      const size = {
        width: Math.round(Math.max(POPUP_MIN.width, Math.min(POPUP_MAX.width, width))),
        height: Math.round(Math.max(POPUP_MIN.height, Math.min(POPUP_MAX.height, height)))
      }
      if (frame) this.browser.emit('extension.popupSize', { id: ext.id, ...size }, win)
      else {
        const b = view.getBounds()
        view.setBounds({
          ...b,
          width: POPUP_INITIAL.width,
          height: Math.min(size.height, contentBounds.height - b.y - 8)
        })
      }
    }
    // Chromium's preferred size is what Chrome sizes its popups by (the document's minimum width
    // and its height); a document that never reports one is measured once instead, a moment
    // after it is ready. The measurement must not overwrite a real report: `scrollWidth` is
    // only ever the view's own width.
    let preferredSeen = false
    wc.on('preferred-size-changed', (_event, size) => {
      preferredSeen = true
      report(size.width, size.height)
    })
    wc.on('dom-ready', () => {
      wc.focus()
      setTimeout(() => {
        if (preferredSeen || this.popup?.view !== view || wc.isDestroyed()) return
        void wc
          .executeJavaScript(
            '[document.body ? document.body.scrollWidth : 0, Math.min(document.documentElement.scrollHeight, (document.body && document.body.scrollHeight) || 1e9)]',
            true
          )
          .then((size) => {
            if (preferredSeen) return
            const [w, h] = size as [number, number]
            if (Number.isFinite(h) && h > 0) report(Number(w) || POPUP_INITIAL.width, Number(h))
          })
          .catch(() => undefined)
      }, 400)
    })
    wc.on('blur', () => setTimeout(() => this.popup?.view === view && this.closePopup(), 120))
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.closePopup()
      }
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) this.browser.tabs.createTab({ url, active: true }, win)
      this.closePopup()
      return { action: 'deny' }
    })
    void wc
      .loadURL(`chrome-extension://${ext.id}/${info.popup.replace(/^\/+/, '')}`)
      .catch(() => undefined)
  }

  resizePopup(bounds: Rect, visible: boolean): void {
    const popup = this.popup
    if (!popup || popup.view.webContents.isDestroyed()) return
    popup.view.setBounds(roundRect(bounds))
    popup.view.setVisible(visible)
    if (visible) popup.view.webContents.focus()
  }

  closePopup(): void {
    if (!this.popup) return
    const { id, view, win } = this.popup
    this.popup = null
    if (win.alive) {
      ;(win.host as ElectronWindow).win.contentView.removeChildView(view)
      this.browser.emit('extension.popupClosed', { id }, win)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private persist(): void {
    this.store.write({
      version: 1,
      extensions: this.entries,
      lastUpdateCheckAt: this.lastUpdateCheckAt
    })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// Extensions UI (W1-D): reconcile with the store PR on rebase – its `permissionMessages.ts`
// owns the full table; this is the handful of Chrome's install-warning strings the UI needs to
// show real rows until then.
const PERMISSION_WARNINGS: Record<string, string> = {
  tabs: 'Read your browsing history',
  history: 'Read and change your browsing history on all your signed-in devices',
  bookmarks: 'Read and change your bookmarks',
  downloads: 'Manage your downloads',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Modify data you copy and paste',
  notifications: 'Display notifications',
  geolocation: 'Detect your physical location',
  management: 'Manage your apps, extensions, and themes',
  nativeMessaging: 'Communicate with cooperating native applications',
  privacy: 'Change your privacy-related settings',
  topSites: 'Read a list of your most frequently visited websites',
  webNavigation: 'Read your browsing history',
  sessions: 'Read your recently closed tabs',
  contentSettings: 'Change your settings that control websites’ access to features',
  debugger: 'Access the page debugger backend',
  proxy: 'Read and change your proxy settings',
  pageCapture: 'Save the content of pages you visit',
  desktopCapture: 'Capture content of your screen',
  tabCapture: 'Capture content of your tabs',
  identity: 'Know your email address',
  declarativeNetRequestFeedback: 'Read your browsing history',
  ttsEngine: 'Read all text spoken using synthesized speech',
  browsingData: 'Clear browsing data'
}
const ALL_HOSTS = /^(<all_urls>|\*:\/\/\*\/|https?:\/\/\*\/|file:\/\/\/\*)/

function permissionWarnings(manifest: Manifest | null): string[] {
  if (!manifest) return []
  const permissions = strings(manifest.permissions)
  const hosts = [
    ...strings(manifest.host_permissions),
    ...permissions.filter((p) => p.includes('/'))
  ]
  const out: string[] = []
  if (hosts.some((h) => ALL_HOSTS.test(h)))
    out.push('Read and change all your data on all websites')
  else {
    const named = hosts
      .map((h) => h.replace(/^\*:\/\/|^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter((h) => h.length > 0 && h !== '*')
    const unique = [...new Set(named)]
    if (unique.length > 0)
      out.push(
        unique.length <= 3
          ? `Read and change your data on ${unique.join(', ')}`
          : 'Read and change your data on a number of websites'
      )
  }
  for (const permission of permissions) {
    const message = PERMISSION_WARNINGS[permission]
    if (message && !out.includes(message)) out.push(message)
  }
  return out
}

function statOf(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** The manifest with its `__MSG_` strings resolved from `_locales`, so a disabled extension still has its name. */
function readManifest(path: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Manifest &
      Record<string, unknown>
    if (!raw.default_locale) return raw
    const bundles = localeFallbackChain(null, raw.default_locale).map((locale) => {
      try {
        return JSON.parse(
          readFileSync(join(path, '_locales', locale, 'messages.json'), 'utf8')
        ) as LocaleMessages
      } catch {
        return null
      }
    })
    return localizeManifest(raw, buildMessageCatalog(bundles)).manifest
  } catch {
    return null
  }
}

function iconDataUrl(path: string, manifest: Manifest | null): string | null {
  if (!manifest) return null
  const action = manifest.action ?? manifest.browser_action
  const candidates: Record<string, string> = {}
  if (typeof action?.default_icon === 'string') candidates['0'] = action.default_icon
  else if (action?.default_icon) Object.assign(candidates, action.default_icon)
  if (Object.keys(candidates).length === 0 && manifest.icons)
    Object.assign(candidates, manifest.icons)
  const sizes = Object.keys(candidates)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  const pick = sizes.find((s) => s >= 32) ?? sizes[sizes.length - 1]
  const rel = pick === undefined ? Object.values(candidates)[0] : candidates[String(pick)]
  if (!rel) return null
  try {
    const file = join(path, rel)
    const mime =
      {
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
      }[extname(file).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
