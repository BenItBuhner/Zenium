import { WebContentsView, dialog, type Extension } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ExtensionInfo, Rect } from '../../shared/types'
import { JsonStore } from '../../core/store/JsonStore'
import type { Browser } from '../../core/browser'
import type { ExtensionHost } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import type { SessionManager } from './sessions'
import type { ElectronWindow } from './window'

interface Persisted {
  version: 1
  extensions: Array<{ path: string; enabled: boolean }>
}

interface Manifest {
  name?: string
  version?: string
  description?: string
  manifest_version?: number
  icons?: Record<string, string>
  action?: { default_popup?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_popup?: string; default_icon?: string | Record<string, string> }
}

const POPUP_WIDTH = 380
const POPUP_MAX_HEIGHT = 600

/**
 * Unpacked Chrome extensions (Electron supports a subset of the extension APIs – content
 * scripts, storage, webRequest, scripting, devtools panels). Extensions are loaded into every
 * persistent container session and remembered across restarts; browser-action popups are shown
 * from the toolbar since Electron has no extension UI of its own.
 */
export class ExtensionService implements ExtensionHost {
  private entries: Array<{ path: string; enabled: boolean }> = []
  private readonly loaded = new Map<string, Extension>()
  private readonly errors = new Map<string, string>()
  private readonly store: JsonStore<Persisted>
  private popup: { view: WebContentsView; win: ZenWindow } | null = null

  constructor(
    private readonly browser: Browser,
    private readonly sessions: SessionManager
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'extensions.json', 300)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.extensions)) {
      this.entries = data.extensions.filter((e) => e && typeof e.path === 'string')
    }
  }

  async start(): Promise<void> {
    for (const entry of this.entries) if (entry.enabled) await this.load(entry.path)
    this.browser.state.commitVolatile()
  }

  /** Load into every persistent session so content scripts run in all containers. */
  private async load(path: string): Promise<void> {
    this.errors.delete(path)
    if (!existsSync(join(path, 'manifest.json'))) {
      this.errors.set(path, 'manifest.json not found')
      return
    }
    for (const [, ses] of this.sessions.persistent()) {
      try {
        const ext =
          ses.extensions.getAllExtensions().find((e) => e.path === path) ??
          (await ses.extensions.loadExtension(path, { allowFileAccess: true }))
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
    for (const entry of this.entries) if (entry.enabled) await this.load(entry.path)
  }

  list(): ExtensionInfo[] {
    return this.entries.map((entry) => {
      const manifest = readManifest(entry.path)
      const ext = this.loaded.get(entry.path)
      const action = manifest?.action ?? manifest?.browser_action
      return {
        id: ext?.id ?? entry.path,
        name: ext?.name ?? manifest?.name ?? entry.path.split(/[\\/]/).pop() ?? 'Extension',
        version: ext?.version ?? manifest?.version ?? '',
        description: manifest?.description ?? '',
        path: entry.path,
        enabled: entry.enabled,
        icon: iconDataUrl(entry.path, manifest),
        popup: action?.default_popup ?? null,
        error: this.errors.get(entry.path) ?? null
      }
    })
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
    this.entries.push({ path, enabled: true })
    await this.load(path)
    this.persist()
    const error = this.errors.get(path)
    this.browser.toast(
      error
        ? `Could not load extension: ${error}`
        : `Loaded ${readManifest(path)?.name ?? 'extension'}`,
      error ? 'error' : 'info',
      win
    )
    this.browser.state.commitVolatile()
  }

  remove(idOrPath: string): void {
    const entry = this.entries.find(
      (e) => e.path === idOrPath || this.loaded.get(e.path)?.id === idOrPath
    )
    if (!entry) return
    this.unload(entry.path)
    this.entries = this.entries.filter((e) => e !== entry)
    this.errors.delete(entry.path)
    this.persist()
    this.browser.state.commitVolatile()
  }

  async setEnabled(idOrPath: string, enabled: boolean): Promise<void> {
    const entry = this.entries.find(
      (e) => e.path === idOrPath || this.loaded.get(e.path)?.id === idOrPath
    )
    if (!entry || entry.enabled === enabled) return
    entry.enabled = enabled
    if (enabled) await this.load(entry.path)
    else this.unload(entry.path)
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Browser-action popups
  // ---------------------------------------------------------------------------

  openPopup(id: string, anchor: Rect, win: ZenWindow): void {
    this.closePopup()
    const entry = this.entries.find((e) => this.loaded.get(e.path)?.id === id || e.path === id)
    const ext = entry ? this.loaded.get(entry.path) : undefined
    const info = entry ? this.list().find((e) => e.path === entry.path) : undefined
    if (!entry || !ext || !info?.popup) return
    const ses = this.sessions.persistent()[0]?.[1]
    if (!ses) return
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setBackgroundColor('#00000000')
    view.setBorderRadius(12)
    const bw = (win.host as ElectronWindow).win
    const contentBounds = bw.getContentBounds()
    const place = (height: number): void => {
      const width = POPUP_WIDTH
      const x = Math.max(
        8,
        Math.min(anchor.x + anchor.width - width, contentBounds.width - width - 8)
      )
      const y = Math.min(anchor.y + anchor.height + 6, contentBounds.height - height - 8)
      view.setBounds({ x: Math.round(x), y: Math.round(y), width, height: Math.round(height) })
    }
    place(200)
    bw.contentView.addChildView(view)
    this.popup = { view, win }
    const wc = view.webContents
    wc.on('dom-ready', () => {
      void wc
        .executeJavaScript(
          'Math.min(document.documentElement.scrollHeight, document.body.scrollHeight || 1e9)',
          true
        )
        .then((h) => {
          if (this.popup?.view !== view) return
          place(Math.max(80, Math.min(POPUP_MAX_HEIGHT, Number(h) + 8 || 200)))
        })
        .catch(() => undefined)
      wc.focus()
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

  closePopup(): void {
    if (!this.popup) return
    const { view, win } = this.popup
    this.popup = null
    if (win.alive) (win.host as ElectronWindow).win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private persist(): void {
    this.store.write({ version: 1, extensions: this.entries })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Manifest
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
