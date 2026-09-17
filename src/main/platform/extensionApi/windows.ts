import { BrowserWindow, type Rectangle } from 'electron'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import {
  type ChromeWindow,
  type WindowQueryOptions,
  windowMatchesQuery
} from '../../../core/extensions/api/windows'
import type { ModelSnapshot } from './model'
import {
  ApiError,
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  extensionUrl,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

const POPUP_DEFAULT = { width: 800, height: 600 }

/**
 * `chrome.windows` over Zenium windows (`BrowserWindow` ids) plus the bare popup windows
 * extensions open with `windows.create({ type: 'popup' })`.
 */
export class WindowsApi {
  /** Last bounds seen per window id, for `onBoundsChanged`. */
  private readonly bounds = new Map<number, Rectangle>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, windowId, options) => this.get(ctx, windowId, options),
    getCurrent: (ctx, options) => this.getCurrent(ctx, options),
    getLastFocused: (ctx, options) => this.getLastFocused(ctx, options),
    getAll: (ctx, options) => this.getAll(ctx, options),
    create: (ctx, data) => this.create(ctx, data),
    update: (ctx, windowId, info) => this.update(ctx, windowId, info),
    remove: (ctx, windowId) => this.remove(ctx, windowId)
  }

  private get model(): ApiHost['model'] {
    return this.host.model
  }

  private urlsFor(ext: LoadedExtension): (tab: { url: string }) => boolean {
    return (tab) => this.host.canSeeTab(ext, tab.url)
  }

  private queryOptions(options: unknown): WindowQueryOptions {
    return isRecord(options) ? (options as WindowQueryOptions) : {}
  }

  /** The window the caller sits in: a popup window's page, an anchored view, or a tab's window. */
  currentWindowId(ctx: ApiContext): number {
    if (ctx.sender.kind === 'frame') {
      const popup = this.model.popupForTabId(ctx.sender.webContents.id)
      if (popup) return popup.bw.id
    }
    if (ctx.window) return this.model.windowIdOf(ctx.window)
    const last = this.model.lastFocusedWindow()
    return last ? this.model.windowIdOf(last) : WINDOW_ID_NONE
  }

  private windowById(ctx: ApiContext, windowId: unknown, options: unknown): ChromeWindow {
    if (!isInteger(windowId)) throw new ApiError('Invalid window id')
    const id = windowId === WINDOW_ID_CURRENT ? this.currentWindowId(ctx) : windowId
    const q = this.queryOptions(options)
    const record = this.model.chromeWindowById(id, q.populate === true, this.urlsFor(ctx.extension))
    if (!record) throw new ApiError(`No window with id: ${windowId}.`)
    return record
  }

  private get(ctx: ApiContext, windowId: unknown, options: unknown): ChromeWindow {
    return this.windowById(ctx, windowId, options)
  }

  private getCurrent(ctx: ApiContext, options: unknown): ChromeWindow {
    return this.windowById(ctx, WINDOW_ID_CURRENT, options)
  }

  private getLastFocused(ctx: ApiContext, options: unknown): ChromeWindow {
    const focused = this.model.focusedWindowId()
    if (focused >= 0) return this.windowById(ctx, focused, options)
    const last = this.model.lastFocusedWindow()
    if (!last) throw new ApiError('No last-focused window')
    return this.windowById(ctx, this.model.windowIdOf(last), options)
  }

  private getAll(ctx: ApiContext, options: unknown): ChromeWindow[] {
    const q = this.queryOptions(options)
    const out: ChromeWindow[] = []
    for (const id of this.model.windowIds()) {
      const record = this.model.chromeWindowById(
        id,
        q.populate === true,
        this.urlsFor(ctx.extension)
      )
      if (record && windowMatchesQuery(record, q)) out.push(record)
    }
    return out
  }

  private urlsOf(ctx: ApiContext, raw: unknown): string[] {
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    return list.map((url) => {
      if (typeof url !== 'string') throw new ApiError('Invalid url')
      const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : extensionUrl(ctx.extensionId, url)
      if (/^\s*(javascript|chrome|devtools):/i.test(full))
        throw new ApiError(`Invalid url: "${url}".`)
      return full
    })
  }

  private create(ctx: ApiContext, data: unknown): ChromeWindow {
    const d = isRecord(data) ? data : {}
    const urls = this.urlsOf(ctx, d.url)
    const incognito = d.incognito === true
    const type = typeof d.type === 'string' ? d.type : 'normal'
    const bounds = boundsFrom(d)
    if (type === 'popup' || type === 'panel' || type === 'detached_panel') {
      return this.createPopup(ctx, urls, incognito, bounds, d.focused !== false)
    }
    const win = this.host.browser.createWindow({
      kind: incognito ? 'private' : 'synced',
      from: ctx.window
    })
    const bw = this.model.browserWindowOf(win)
    if (bw && bounds) bw.setBounds({ ...bw.getBounds(), ...bounds })
    if (bw && typeof d.state === 'string') applyState(bw, d.state)
    if (bw && d.focused === false) bw.once('show', () => bw.blur())
    urls.forEach((url, i) => {
      this.host.browser.tabs.createTab({ url, active: i === 0 }, win)
    })
    return this.model.chromeWindow(win, true, this.urlsFor(ctx.extension))
  }

  private createPopup(
    ctx: ApiContext,
    urls: string[],
    incognito: boolean,
    bounds: Partial<Rectangle> | null,
    focused: boolean
  ): ChromeWindow {
    const session = incognito
      ? this.host.sessions.get(PRIVATE_CONTAINER_ID)
      : ctx.extension.sessions[0]
    const bw = new BrowserWindow({
      width: bounds?.width ?? POPUP_DEFAULT.width,
      height: bounds?.height ?? POPUP_DEFAULT.height,
      x: bounds?.x,
      y: bounds?.y,
      show: false,
      autoHideMenuBar: true,
      title: ctx.extension.manifest.name ?? 'Zenium',
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    const popup = { bw, extensionId: ctx.extensionId, incognito }
    this.model.popups.set(bw.id, popup)
    bw.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) this.host.browser.tabs.createTab({ url, active: true })
      return { action: 'deny' }
    })
    bw.on('closed', () => {
      this.model.popups.delete(bw.id)
      this.host.scheduleTick()
    })
    const tick = (): void => this.host.scheduleTick()
    bw.on('focus', tick)
    bw.on('blur', tick)
    bw.on('resize', tick)
    bw.on('move', tick)
    bw.once('ready-to-show', () => (focused ? bw.show() : bw.showInactive()))
    void bw.loadURL(urls[0] ?? 'about:blank').catch(() => undefined)
    // Show even when the page never becomes ready (a failed load has no `ready-to-show`).
    setTimeout(() => {
      if (!bw.isDestroyed() && !bw.isVisible()) focused ? bw.show() : bw.showInactive()
    }, 1500)
    this.host.scheduleTick()
    return this.model.chromePopupWindow(popup, true)
  }

  private update(ctx: ApiContext, windowId: unknown, info: unknown): ChromeWindow {
    if (!isInteger(windowId)) throw new ApiError('Invalid window id')
    const id = windowId === WINDOW_ID_CURRENT ? this.currentWindowId(ctx) : windowId
    const bw = this.model.browserWindowById(id)
    if (!bw) throw new ApiError(`No window with id: ${windowId}.`)
    const u = isRecord(info) ? info : {}
    const bounds = boundsFrom(u)
    if (typeof u.state === 'string') applyState(bw, u.state)
    if (bounds) {
      if (bw.isMaximized()) bw.unmaximize()
      bw.setBounds({ ...bw.getBounds(), ...bounds })
    }
    if (u.focused === true) {
      if (bw.isMinimized()) bw.restore()
      bw.show()
      bw.focus()
    } else if (u.focused === false) {
      bw.blur()
    }
    if (u.drawAttention === true) bw.flashFrame(true)
    else if (u.drawAttention === false) bw.flashFrame(false)
    this.host.scheduleTick()
    const record = this.model.chromeWindowById(id, false, this.urlsFor(ctx.extension))
    if (!record) throw new ApiError(`No window with id: ${windowId}.`)
    return record
  }

  private remove(ctx: ApiContext, windowId: unknown): void {
    if (!isInteger(windowId)) throw new ApiError('Invalid window id')
    const id = windowId === WINDOW_ID_CURRENT ? this.currentWindowId(ctx) : windowId
    const popup = this.model.popups.get(id)
    if (popup) {
      popup.bw.close()
      return
    }
    const win = this.model.zenWindow(id)
    if (!win) throw new ApiError(`No window with id: ${windowId}.`)
    win.host.close()
  }

  // ---------------------------------------------------------------------------
  // Events (from snapshot diffs)
  // ---------------------------------------------------------------------------

  diff(prev: ModelSnapshot, next: ModelSnapshot): void {
    for (const windowId of next.windows.keys()) {
      if (prev.windows.has(windowId)) continue
      this.host.broadcast('windows', 'onCreated', (ext) => {
        const record = this.model.chromeWindowById(windowId, false, this.urlsFor(ext))
        return record ? [record] : null
      })
    }
    for (const windowId of prev.windows.keys()) {
      if (next.windows.has(windowId)) continue
      this.bounds.delete(windowId)
      this.host.broadcast('windows', 'onRemoved', () => [windowId])
    }
    if (prev.focused !== next.focused) {
      this.host.broadcast('windows', 'onFocusChanged', () => [next.focused])
    }
    for (const windowId of next.windows.keys()) {
      const bw = this.model.browserWindowById(windowId)
      if (!bw) continue
      const current = bw.getBounds()
      const before = this.bounds.get(windowId)
      this.bounds.set(windowId, current)
      if (!before || !prev.windows.has(windowId)) continue
      if (
        before.x === current.x &&
        before.y === current.y &&
        before.width === current.width &&
        before.height === current.height
      )
        continue
      this.host.broadcast('windows', 'onBoundsChanged', (ext) => {
        const record = this.model.chromeWindowById(windowId, false, this.urlsFor(ext))
        return record ? [record] : null
      })
    }
  }
}

function boundsFrom(d: Record<string, unknown>): Partial<Rectangle> | null {
  const out: Partial<Rectangle> = {}
  if (isInteger(d.left)) out.x = d.left
  if (isInteger(d.top)) out.y = d.top
  if (isInteger(d.width)) out.width = Math.max(1, d.width)
  if (isInteger(d.height)) out.height = Math.max(1, d.height)
  return Object.keys(out).length > 0 ? out : null
}

function applyState(bw: BrowserWindow, state: string): void {
  switch (state) {
    case 'minimized':
      bw.minimize()
      return
    case 'maximized':
      if (bw.isFullScreen()) bw.setFullScreen(false)
      if (bw.isMinimized()) bw.restore()
      bw.maximize()
      return
    case 'fullscreen':
      if (bw.isMinimized()) bw.restore()
      bw.setFullScreen(true)
      return
    case 'normal':
      if (bw.isMinimized()) bw.restore()
      if (bw.isFullScreen()) bw.setFullScreen(false)
      if (bw.isMaximized()) bw.unmaximize()
      return
    default:
      throw new ApiError(`Invalid value for state: ${state}.`)
  }
}
