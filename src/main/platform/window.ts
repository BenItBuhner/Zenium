import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { EventName, Events, Rect } from '../../shared/types'
import type { Browser } from '../../core/browser'
import type { ChromeHost, KeyEventInput, WindowHost } from '../../core/platform'
import { resolveTheme, rgbToHex } from '../../shared/theme'
import icon from '../../../resources/icon.png?asset'

const MIN_WIDTH = 640
const MIN_HEIGHT = 420
/** Width (px) of the edge zone that reveals the sidebar in compact mode. */
const COMPACT_REVEAL_ZONE = 14

/**
 * The single browser window. Its own web contents render Zen's chrome (sidebar, toolbar,
 * overlays); tab pages are `WebContentsView` children the core positions through `Viewport`.
 */
export class ZenWindow implements ChromeHost, WindowHost {
  win: BrowserWindow | null = null
  private browser!: Browser
  private boundsTimer: ReturnType<typeof setTimeout> | null = null
  private compactTimer: ReturnType<typeof setInterval> | null = null
  private compactLastSent: boolean | null = null

  bind(browser: Browser): void {
    this.browser = browser
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  create(): BrowserWindow {
    const state = this.browser.state
    const bounds = this.sanitizeBounds(state.windowBounds)
    const theme = resolveTheme(
      this.browser.tabs.activeSpace.theme,
      state.settings.colorScheme === 'dark'
    )
    const isMac = process.platform === 'darwin'
    const win = new BrowserWindow({
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
    this.win = win
    if (state.window.maximized) win.maximize()

    win.once('ready-to-show', () => win.show())
    win.on('maximize', () => this.syncWindowState())
    win.on('unmaximize', () => this.syncWindowState())
    win.on('enter-full-screen', () => this.syncWindowState())
    win.on('leave-full-screen', () => this.syncWindowState())
    win.on('focus', () => this.syncWindowState())
    win.on('blur', () => this.syncWindowState())
    win.on('resize', () => this.scheduleBoundsSave())
    win.on('move', () => this.scheduleBoundsSave())
    win.on('close', () => {
      this.saveBounds()
      this.browser.state.flushSync()
    })
    win.on('closed', () => {
      this.stopCompactTracking()
      this.win = null
      this.browser.onWindowClosed()
    })
    this.startCompactTracking()

    const wc = win.webContents
    wc.on('before-input-event', (event, input) => {
      const key: KeyEventInput = {
        type: input.type as KeyEventInput['type'],
        key: input.key,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        meta: input.meta,
        isAutoRepeat: input.isAutoRepeat
      }
      if (this.browser.keys.handle(key, null)) event.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('context-menu', (event) => event.preventDefault())
    wc.on('did-finish-load', () => this.browser.pushState())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return win
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
    const win = this.window
    if (!win) return
    if (!win.isMaximized() && !win.isFullScreen()) {
      this.browser.state.windowBounds = win.getNormalBounds()
    }
    this.browser.state.window.maximized = win.isMaximized()
    this.browser.state.commit()
  }

  private syncWindowState(): void {
    const win = this.window
    if (!win) return
    const w = this.browser.state.window
    w.maximized = win.isMaximized()
    w.fullscreen = win.isFullScreen()
    w.focused = win.isFocused()
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
    const win = this.window
    if (!win || !win.isVisible()) return
    const state = this.browser.state
    const cm = state.settings.compactMode
    const hidden = cm.enabled && cm.hideSidebar && !cm.sidebarPersistent
    if (!hidden || state.window.htmlFullscreenTabId) {
      this.compactLastSent = null
      return
    }
    if (!win.isFocused() && !state.compactSidebarRevealed) return
    const bounds = win.getContentBounds()
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
  // ChromeHost
  // ---------------------------------------------------------------------------

  send<K extends EventName>(name: K, payload: Events[K]): void {
    const win = this.window
    if (!win) return
    win.webContents.send('zen:event', name, payload)
  }

  focus(): void {
    this.window?.webContents.focus()
  }

  openDevTools(): void {
    this.window?.webContents.openDevTools({ mode: 'detach' })
  }

  // ---------------------------------------------------------------------------
  // WindowHost
  // ---------------------------------------------------------------------------

  contentSize(): { width: number; height: number } {
    const win = this.window
    if (!win) return { width: 0, height: 0 }
    const [width, height] = win.getContentSize()
    return { width, height }
  }

  isFullScreen(): boolean {
    return this.window?.isFullScreen() ?? false
  }

  setFullScreen(fullscreen: boolean): void {
    this.window?.setFullScreen(fullscreen)
  }

  isMaximized(): boolean {
    return this.window?.isMaximized() ?? false
  }

  minimize(): void {
    this.window?.minimize()
  }

  maximize(): void {
    this.window?.maximize()
  }

  unmaximize(): void {
    this.window?.unmaximize()
  }

  close(): void {
    this.window?.close()
  }
}
