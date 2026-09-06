import { BrowserWindow, nativeImage, screen, shell, type WebContentsView } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type {
  EventName,
  Events,
  FindResult,
  GlanceState,
  LayoutReport,
  Rect,
  Space,
  WindowKind,
  WindowState
} from '../../shared/types'
import type { Browser } from './browser'
import type { PersistedWindow } from './state'
import { getSpace, tabVisibleIn } from './model'
import { resolveTheme, rgbToHex } from '../../shared/theme'
import icon from '../../../resources/icon.png?asset'

const MIN_WIDTH = 640
const MIN_HEIGHT = 420
/** Width (px) of the edge zone that reveals the sidebar in compact mode. */
const COMPACT_REVEAL_ZONE = 14

export interface WindowInit {
  id: string
  kind: WindowKind
  bounds: Rect | null
  maximized: boolean
  activeSpaceId: string
  selection: Record<string, string>
  compact: boolean
  /** The private space of a blank / private window (already registered in the model). */
  localSpace: Space | null
  /** Window to offset the new one from (new windows cascade like Firefox). */
  cascadeFrom?: ZenWindow
}

/**
 * One browser window. Its own web contents render Zen's chrome (sidebar, toolbar, overlays);
 * tab pages are `WebContentsView` children positioned wherever the renderer reports the content
 * area to be.
 *
 * Windows share the tab model (Zen's window sync) but each keeps its own space / tab selection,
 * Glance, find bar and compact-mode state. A tab's live page lives in one window at a time – the
 * others show a dimmed preview until they are focused.
 */
export class ZenWindow {
  readonly id: string
  readonly kind: WindowKind
  win!: BrowserWindow
  activeSpaceId: string
  /** Per-space selected tab of this window (falls back to the space's last selection). */
  readonly selection = new Map<string, string | null>()
  readonly localSpace: Space | null
  glance: GlanceState | null = null
  findResult: FindResult | null = null
  compactSidebarRevealed = false
  compactEnabled: boolean
  compactSidebarPersistent = false
  htmlFullscreenTabId: string | null = null
  lastFocusedAt = 0
  private boundsTimer: NodeJS.Timeout | null = null
  private lastLayout: LayoutReport | null = null
  private pendingContentFocus = false
  private compactTimer: NodeJS.Timeout | null = null
  private compactLastSent: boolean | null = null
  private initialBounds: Rect | null
  private initialMaximized: boolean
  private savedBounds: Rect | null
  private closing = false

  constructor(
    private readonly browser: Browser,
    init: WindowInit
  ) {
    this.id = init.id
    this.kind = init.kind
    this.activeSpaceId = init.activeSpaceId
    this.localSpace = init.localSpace
    this.compactEnabled = init.compact
    for (const [spaceId, tabId] of Object.entries(init.selection))
      this.selection.set(spaceId, tabId)
    this.initialBounds = init.bounds
    this.savedBounds = init.bounds
    this.initialMaximized = init.maximized
    if (init.cascadeFrom && !init.bounds) {
      const b = init.cascadeFrom.win.getNormalBounds()
      this.initialBounds = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height }
    }
  }

  get isPrivate(): boolean {
    return this.kind === 'private'
  }

  get alive(): boolean {
    return Boolean(this.win) && !this.win.isDestroyed()
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /** The space this window is showing. */
  activeSpace(): Space {
    if (this.localSpace) return this.localSpace
    const m = this.browser.state.model
    return getSpace(m, this.activeSpaceId) ?? m.spaces[0]
  }

  /** Tab selected in `space` by this window, validated against the tabs the window can show. */
  selectedTabIn(space: Space): string | null {
    const m = this.browser.state.model
    const valid = (id: string | null | undefined): id is string => {
      if (!id) return false
      const tab = m.tabs[id]
      if (!tab || !tabVisibleIn(tab, this.id)) return false
      if (tab.essential) return !space.windowId
      return tab.spaceId === space.id
    }
    const own = this.selection.get(space.id)
    if (valid(own)) return own
    if (valid(space.activeTabId)) return space.activeTabId
    return null
  }

  select(space: Space, tabId: string | null): void {
    this.selection.set(space.id, tabId)
    if (tabId) space.activeTabId = tabId
  }

  windowState(): WindowState {
    const alive = this.alive
    return {
      id: this.id,
      kind: this.kind,
      maximized: alive ? this.win.isMaximized() : this.initialMaximized,
      fullscreen: alive ? this.win.isFullScreen() : false,
      focused: alive ? this.win.isFocused() : false,
      htmlFullscreenTabId: this.htmlFullscreenTabId
    }
  }

  /** Visible tabs whose live page is attached to another window right now. */
  foreignTabIds(): string[] {
    const tabs = this.browser.tabs
    return tabs.visibleTabIds(this).filter((id) => {
      const owner = tabs.ownerOf(id)
      return owner !== undefined && owner !== this
    })
  }

  toPersisted(): PersistedWindow {
    const selection: Record<string, string> = {}
    for (const [spaceId, tabId] of this.selection) if (tabId) selection[spaceId] = tabId
    return {
      id: this.id,
      bounds: this.savedBounds,
      maximized: this.alive ? this.win.isMaximized() : this.initialMaximized,
      activeSpaceId: this.activeSpaceId,
      selection,
      compact: this.compactEnabled
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  create(): BrowserWindow {
    const state = this.browser.state
    const bounds = this.sanitizeBounds(this.initialBounds)
    const theme = resolveTheme(this.activeSpace().theme, state.settings.colorScheme === 'dark')
    const isMac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      titleBarStyle: isMac ? 'hiddenInset' : undefined,
      trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
      backgroundColor: rgbToHex(theme.averageColor),
      autoHideMenuBar: true,
      title: this.isPrivate ? 'Zen (Private Browsing)' : 'Zen',
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    if (this.initialMaximized) this.win.maximize()

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('maximize', () => this.syncWindowState())
    this.win.on('unmaximize', () => this.syncWindowState())
    this.win.on('enter-full-screen', () => this.syncWindowState())
    this.win.on('leave-full-screen', () => this.syncWindowState())
    this.win.on('focus', () => {
      this.lastFocusedAt = Date.now()
      this.browser.onWindowFocused(this)
      this.syncWindowState()
    })
    this.win.on('blur', () => this.syncWindowState())
    this.win.on('resize', () => this.scheduleBoundsSave())
    this.win.on('move', () => this.scheduleBoundsSave())
    this.win.on('swipe', (_e, direction) => {
      // macOS three-finger swipe switches spaces like Zen's touchpad gesture.
      if (this.kind !== 'synced') return
      if (direction === 'left')
        this.browser.actions.run('space.next', { sourceTabId: null, win: this })
      if (direction === 'right')
        this.browser.actions.run('space.prev', { sourceTabId: null, win: this })
    })
    this.win.on('close', () => {
      this.closing = true
      this.saveBounds()
      this.browser.onWindowClosing(this)
      this.browser.state.flushSync()
    })
    this.win.on('closed', () => {
      this.stopCompactTracking()
      this.browser.onWindowClosed(this)
    })
    this.startCompactTracking()

    const wc = this.win.webContents
    wc.on('before-input-event', (event, input) =>
      this.browser.keys.handle(event, input, null, this)
    )
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('context-menu', (event) => event.preventDefault())
    wc.on('did-finish-load', () => this.send('state', this.browser.state.snapshot(this)))

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void this.win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return this.win
  }

  get isClosing(): boolean {
    return this.closing
  }

  private sanitizeBounds(saved: Rect | null): Rect {
    const primary = screen.getPrimaryDisplay().workArea
    const fallback: Rect = {
      width: Math.min(1280, primary.width - 40),
      height: Math.min(820, primary.height - 40),
      x:
        primary.x +
        Math.max(0, Math.round((primary.width - Math.min(1280, primary.width - 40)) / 2)),
      y:
        primary.y +
        Math.max(0, Math.round((primary.height - Math.min(820, primary.height - 40)) / 2))
    }
    if (!saved) return fallback
    const width = Math.max(MIN_WIDTH, Math.min(saved.width, primary.width))
    const height = Math.max(MIN_HEIGHT, Math.min(saved.height, primary.height))
    // Make sure the window is visible on some display.
    const visibleOnSomeDisplay = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return (
        saved.x + 100 < a.x + a.width &&
        saved.x + width - 100 > a.x &&
        saved.y + 50 < a.y + a.height &&
        saved.y >= a.y - 20
      )
    })
    return visibleOnSomeDisplay
      ? { x: saved.x, y: saved.y, width, height }
      : { ...fallback, width, height }
  }

  private scheduleBoundsSave(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => this.saveBounds(), 500)
  }

  private saveBounds(): void {
    if (!this.alive) return
    if (!this.win.isMaximized() && !this.win.isFullScreen()) {
      this.savedBounds = this.win.getNormalBounds()
    }
    if (this.kind === 'synced') this.browser.state.commit()
  }

  private syncWindowState(): void {
    if (!this.alive) return
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Compact mode: native cursor tracking
  // ---------------------------------------------------------------------------

  /**
   * Like Zen, reveal the hidden sidebar by tracking the real cursor position instead of relying
   * on DOM hover: the page view and the frameless resize border never deliver mouse events to
   * the chrome, so a DOM-only edge strip is unreliable.
   */
  startCompactTracking(): void {
    if (this.compactTimer) return
    this.compactTimer = setInterval(() => this.pollCompactCursor(), 120)
  }

  stopCompactTracking(): void {
    if (this.compactTimer) clearInterval(this.compactTimer)
    this.compactTimer = null
  }

  private pollCompactCursor(): void {
    if (!this.alive || !this.win.isVisible()) return
    const state = this.browser.state
    const cm = state.settings.compactMode
    const hidden = this.compactEnabled && cm.hideSidebar && !this.compactSidebarPersistent
    if (!hidden || this.htmlFullscreenTabId) {
      this.compactLastSent = null
      return
    }
    if (!this.win.isFocused() && !this.compactSidebarRevealed) return
    const bounds = this.win.getContentBounds()
    const cursor = screen.getCursorScreenPoint()
    const insideY = cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    const side = state.settings.sidebarSide
    const distance = side === 'left' ? cursor.x - bounds.x : bounds.x + bounds.width - cursor.x
    const sidebarWidth = state.settings.sidebarExpanded ? state.settings.sidebarWidth : 56
    const inRevealZone = insideY && distance >= -6 && distance <= COMPACT_REVEAL_ZONE
    const outsideSidebar = !insideY || distance > sidebarWidth + 32 || distance < -48
    // Each transition is sent once; re-sending "hide" would keep resetting the renderer's
    // hide delay.
    if (inRevealZone && this.compactLastSent !== true) {
      this.compactLastSent = true
      this.send('compact.reveal', { revealed: true })
    } else if (outsideSidebar && this.compactLastSent !== false) {
      this.compactLastSent = false
      if (this.compactSidebarRevealed) this.send('compact.reveal', { revealed: false })
    }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  attachView(view: WebContentsView): void {
    if (!this.alive) return
    this.win.contentView.addChildView(view)
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  detachView(view: WebContentsView): void {
    if (!this.alive) return
    this.win.contentView.removeChildView(view)
  }

  /** Re-apply the last layout (used when main-process state such as HTML fullscreen changes). */
  relayout(): void {
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  /** Position tab views exactly where the renderer laid the content area out. */
  applyLayout(report: LayoutReport): void {
    this.lastLayout = report
    if (!this.alive) return
    const tabs = this.browser.tabs
    const owned = tabs.viewsOwnedBy(this)
    const fullscreenTabId = this.htmlFullscreenTabId
    if (fullscreenTabId && owned.has(fullscreenTabId)) {
      // An element in HTML fullscreen covers the whole window, chrome included.
      const [width, height] = this.win.getContentSize()
      for (const [tabId, view] of owned) {
        if (tabId === fullscreenTabId) {
          this.win.contentView.addChildView(view)
          view.setBounds({ x: 0, y: 0, width, height })
          view.setBorderRadius(0)
          view.setVisible(true)
        } else if (view.getVisible()) {
          view.setVisible(false)
        }
      }
      return
    }
    const wanted = new Map<string, { rect: Rect; radius: number }>()
    if (!report.contentHidden) {
      for (const p of report.placements) wanted.set(p.tabId, { rect: p.rect, radius: p.radius })
    }
    const glance = report.glance
    for (const [tabId, view] of owned) {
      const placement = wanted.get(tabId)
      const isGlance = glance?.tabId === tabId
      if (isGlance) continue
      if (placement) {
        view.setBounds(roundRect(placement.rect))
        view.setBorderRadius(Math.round(placement.radius))
        if (!view.getVisible()) view.setVisible(true)
      } else if (view.getVisible()) {
        view.setVisible(false)
      }
    }
    if (glance) {
      const view = owned.get(glance.tabId)
      if (view) {
        // Re-adding moves the view to the top of the z-order.
        this.win.contentView.addChildView(view)
        view.setBounds(roundRect(glance.rect))
        view.setBorderRadius(Math.round(glance.radius))
        if (!view.getVisible()) view.setVisible(true)
      }
    }
    if (this.pendingContentFocus && !report.contentHidden) this.focusContent()
    // With no page visible (empty space / chrome overlay / preview of a page shown in another
    // window) keyboard input must go to the chrome, otherwise shortcuts stop working.
    const showsOwnPage = [...wanted.keys()].some((id) => owned.has(id))
    if (report.contentHidden || (!showsOwnPage && !glance)) this.focusChrome()
  }

  /**
   * Give keyboard focus to the active page (after the chrome handled an action). If the page is
   * still hidden behind chrome UI, the focus is applied once the next layout shows it again.
   */
  focusContent(): void {
    const active = this.browser.tabs.activeTabFor(this)
    if (!active) {
      this.focusChrome()
      return
    }
    if (!this.lastLayout || this.lastLayout.contentHidden) {
      this.pendingContentFocus = true
      return
    }
    this.pendingContentFocus = false
    const wc = this.browser.tabs.webContents(active.id)
    const ownsView = this.browser.tabs.ownerOf(active.id) === this
    // A view without a committed document has no renderer to deliver shortcuts through.
    if (ownsView && wc && !wc.isDestroyed() && wc.getURL() !== '') wc.focus()
    else this.focusChrome()
  }

  focusChrome(): void {
    if (this.alive) this.win.webContents.focus()
  }

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (!this.alive) return
    this.win.webContents.send('zen:event', name, payload)
  }

  /**
   * JPEG snapshot of a tab, used to keep a dimmed preview behind overlays (URL bar, Glance) and
   * for tabs whose live page is shown in another window.
   */
  async snapshot(tabId: string): Promise<string | null> {
    const wc = this.browser.tabs.webContents(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!wc || !view || !view.getVisible()) return null
    try {
      const image = await wc.capturePage()
      if (image.isEmpty()) return null
      const size = image.getSize()
      const scaled = size.width > 1400 ? image.resize({ width: 1400 }) : image
      return `data:image/jpeg;base64,${scaled.toJPEG(65).toString('base64')}`
    } catch {
      return null
    }
  }

  async screenshotToFile(tabId: string, filePath: string): Promise<boolean> {
    const wc = this.browser.tabs.webContents(tabId)
    if (!wc) return false
    try {
      const image = await wc.capturePage()
      if (image.isEmpty()) return false
      const { writeFile } = await import('node:fs/promises')
      await writeFile(filePath, nativeImage.createFromBuffer(image.toPNG()).toPNG())
      return true
    } catch {
      return false
    }
  }
}

function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)),
    height: Math.max(0, Math.round(r.height))
  }
}
