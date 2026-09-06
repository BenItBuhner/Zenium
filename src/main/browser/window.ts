import { BrowserWindow, nativeImage, screen, shell, type WebContentsView } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { EventName, Events, LayoutReport, Rect } from '../../shared/types'
import type { Browser } from './browser'
import { resolveTheme, rgbToHex } from '../../shared/theme'
import icon from '../../../resources/icon.png?asset'

const MIN_WIDTH = 640
const MIN_HEIGHT = 420
/** Width (px) of the edge zone that reveals the sidebar in compact mode. */
const COMPACT_REVEAL_ZONE = 14

/**
 * The single browser window. Its own web contents render Zen's chrome (sidebar, toolbar,
 * overlays); tab pages are `WebContentsView` children positioned wherever the renderer reports
 * the content area to be.
 */
export class ZenWindow {
  win!: BrowserWindow
  private boundsTimer: NodeJS.Timeout | null = null
  private lastLayout: LayoutReport | null = null
  private pendingContentFocus = false
  private compactTimer: NodeJS.Timeout | null = null
  private compactLastSent: boolean | null = null

  constructor(private readonly browser: Browser) {}

  create(): BrowserWindow {
    const state = this.browser.state
    const bounds = this.sanitizeBounds(state.windowBounds)
    const theme = resolveTheme(
      this.browser.tabs.activeSpace.theme,
      state.settings.colorScheme === 'dark'
    )
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
      title: 'Zen',
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
    if (state.window.maximized) this.win.maximize()

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('maximize', () => this.syncWindowState())
    this.win.on('unmaximize', () => this.syncWindowState())
    this.win.on('enter-full-screen', () => this.syncWindowState())
    this.win.on('leave-full-screen', () => this.syncWindowState())
    this.win.on('focus', () => this.syncWindowState())
    this.win.on('blur', () => this.syncWindowState())
    this.win.on('resize', () => this.scheduleBoundsSave())
    this.win.on('move', () => this.scheduleBoundsSave())
    this.win.on('close', () => {
      this.saveBounds()
      this.browser.state.flushSync()
    })
    this.win.on('closed', () => {
      this.stopCompactTracking()
      this.browser.onWindowClosed()
    })
    this.startCompactTracking()

    const wc = this.win.webContents
    wc.on('before-input-event', (event, input) => this.browser.keys.handle(event, input, null))
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('context-menu', (event) => event.preventDefault())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void this.win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return this.win
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
    if (!this.win || this.win.isDestroyed()) return
    if (!this.win.isMaximized() && !this.win.isFullScreen()) {
      this.browser.state.windowBounds = this.win.getNormalBounds()
    }
    this.browser.state.window.maximized = this.win.isMaximized()
    this.browser.state.commit()
  }

  private syncWindowState(): void {
    if (!this.win || this.win.isDestroyed()) return
    const w = this.browser.state.window
    w.maximized = this.win.isMaximized()
    w.fullscreen = this.win.isFullScreen()
    w.focused = this.win.isFocused()
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
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return
    const state = this.browser.state
    const cm = state.settings.compactMode
    const hidden = cm.enabled && cm.hideSidebar && !cm.sidebarPersistent
    if (!hidden || state.window.htmlFullscreenTabId) {
      this.compactLastSent = null
      return
    }
    if (!this.win.isFocused() && !state.compactSidebarRevealed) return
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
      if (state.compactSidebarRevealed) this.send('compact.reveal', { revealed: false })
    }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  attachView(view: WebContentsView): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.contentView.addChildView(view)
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  detachView(view: WebContentsView): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.contentView.removeChildView(view)
  }

  /** Re-apply the last layout (used when main-process state such as HTML fullscreen changes). */
  relayout(): void {
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  /** Position tab views exactly where the renderer laid the content area out. */
  applyLayout(report: LayoutReport): void {
    this.lastLayout = report
    if (!this.win || this.win.isDestroyed()) return
    const fullscreenTabId = this.browser.state.window.htmlFullscreenTabId
    if (fullscreenTabId && this.browser.tabs.view(fullscreenTabId)) {
      // An element in HTML fullscreen covers the whole window, chrome included.
      const [width, height] = this.win.getContentSize()
      for (const [tabId, view] of this.browser.tabs.allViews()) {
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
    for (const [tabId, view] of this.browser.tabs.allViews()) {
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
      const view = this.browser.tabs.view(glance.tabId)
      if (view) {
        // Re-adding moves the view to the top of the z-order.
        this.win.contentView.addChildView(view)
        view.setBounds(roundRect(glance.rect))
        view.setBorderRadius(Math.round(glance.radius))
        if (!view.getVisible()) view.setVisible(true)
      }
    }
    if (this.pendingContentFocus && !report.contentHidden) this.focusContent()
    // With no page visible (empty space / chrome overlay) keyboard input must go to the chrome,
    // otherwise shortcuts stop working after the focused view is hidden.
    if (report.contentHidden || (report.placements.length === 0 && !glance)) this.focusChrome()
  }

  /**
   * Give keyboard focus to the active page (after the chrome handled an action). If the page is
   * still hidden behind chrome UI, the focus is applied once the next layout shows it again.
   */
  focusContent(): void {
    const active = this.browser.tabs.activeTab
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
    if (wc && !wc.isDestroyed()) wc.focus()
  }

  focusChrome(): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.focus()
  }

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send('zen:event', name, payload)
  }

  /** JPEG snapshot of a tab, used to keep a dimmed preview behind overlays (URL bar, Glance). */
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
