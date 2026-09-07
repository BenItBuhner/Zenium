import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { EventName, Events, Rect } from '../../shared/types'
import type { Browser } from '../../core/browser'
import type { ZenWindow } from '../../core/window'
import type {
  KeyEventInput,
  WindowCreateInit,
  WindowHost,
  WindowHostFactory
} from '../../core/platform'
import icon from '../../../resources/icon.png?asset'

const MIN_WIDTH = 640
const MIN_HEIGHT = 420
/** Width (px) of the edge zone that reveals the sidebar in compact mode. */
const COMPACT_REVEAL_ZONE = 14

/**
 * The Electron side of one `ZenWindow`: a frameless `BrowserWindow` whose web contents render
 * Zen's chrome. Tab pages are `WebContentsView` children the core positions through the window's
 * layout reports. Frame events (focus, bounds, close) are forwarded to the core window.
 */
export class ElectronWindow implements WindowHost {
  readonly win: BrowserWindow
  private boundsTimer: ReturnType<typeof setTimeout> | null = null
  private compactTimer: ReturnType<typeof setInterval> | null = null
  private compactLastSent: boolean | null = null

  constructor(
    private readonly browser: Browser,
    private readonly zen: ZenWindow,
    init: WindowCreateInit
  ) {
    let initial = init.bounds
    if (!initial && init.cascadeFrom?.alive) {
      const b = (init.cascadeFrom.host as ElectronWindow).win.getNormalBounds()
      initial = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height }
    }
    const bounds = sanitizeBounds(initial)
    const isMac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      titleBarStyle: isMac ? 'hiddenInset' : undefined,
      trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
      backgroundColor: init.backgroundColor,
      autoHideMenuBar: true,
      title: init.title,
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
    const win = this.win
    if (init.maximized) win.maximize()

    win.once('ready-to-show', () => win.show())
    win.on('maximize', () => zen.onWindowStateChanged())
    win.on('unmaximize', () => zen.onWindowStateChanged())
    win.on('enter-full-screen', () => zen.onWindowStateChanged())
    win.on('leave-full-screen', () => zen.onWindowStateChanged())
    win.on('focus', () => zen.onFocused())
    win.on('blur', () => zen.onWindowStateChanged())
    win.on('resize', () => this.scheduleBoundsSave())
    win.on('move', () => this.scheduleBoundsSave())
    win.on('swipe', (_e, direction) => {
      // macOS three-finger swipe switches spaces like Zen's touchpad gesture.
      if (zen.kind !== 'synced') return
      if (direction === 'left') browser.actions.run('space.next', { sourceTabId: null, win: zen })
      if (direction === 'right') browser.actions.run('space.prev', { sourceTabId: null, win: zen })
    })
    win.on('close', () => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer)
      zen.onClosing()
    })
    win.on('closed', () => {
      this.stopCompactTracking()
      zen.onClosed()
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
      if (browser.keys.handle(key, null, zen)) event.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('context-menu', (event) => event.preventDefault())
    wc.on('did-finish-load', () => zen.onChromeReady())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  get alive(): boolean {
    return !this.win.isDestroyed()
  }

  // ---------------------------------------------------------------------------
  // WindowHost
  // ---------------------------------------------------------------------------

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (this.alive) this.win.webContents.send('zen:event', name, payload)
  }

  focusChrome(): void {
    if (this.alive) this.win.webContents.focus()
  }

  openChromeDevTools(): void {
    if (this.alive) this.win.webContents.openDevTools({ mode: 'detach' })
  }

  contentSize(): { width: number; height: number } {
    const [width, height] = this.win.getContentSize()
    return { width, height }
  }

  isFullScreen(): boolean {
    return this.alive && this.win.isFullScreen()
  }

  setFullScreen(fullscreen: boolean): void {
    if (this.alive) this.win.setFullScreen(fullscreen)
  }

  isMaximized(): boolean {
    return this.alive && this.win.isMaximized()
  }

  isFocused(): boolean {
    return this.alive && this.win.isFocused()
  }

  isVisible(): boolean {
    return this.alive && this.win.isVisible()
  }

  minimize(): void {
    if (this.alive) this.win.minimize()
  }

  maximize(): void {
    if (this.alive) this.win.maximize()
  }

  unmaximize(): void {
    if (this.alive) this.win.unmaximize()
  }

  show(): void {
    if (this.alive) this.win.show()
  }

  focus(): void {
    if (this.alive) this.win.focus()
  }

  close(): void {
    if (this.alive) this.win.close()
  }

  normalBounds(): Rect | null {
    return this.alive ? this.win.getNormalBounds() : null
  }

  // ---------------------------------------------------------------------------
  // Bounds persistence
  // ---------------------------------------------------------------------------

  private scheduleBoundsSave(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => this.zen.onBoundsChanged(), 500)
  }

  // ---------------------------------------------------------------------------
  // Compact mode: native cursor tracking
  // ---------------------------------------------------------------------------

  /**
   * Like Zen, reveal the hidden sidebar by tracking the real cursor position instead of relying
   * on DOM hover: the page view and the frameless resize border never deliver mouse events to
   * the chrome, so a DOM-only edge strip is unreliable.
   */
  private startCompactTracking(): void {
    if (this.compactTimer) return
    this.compactTimer = setInterval(() => this.pollCompactCursor(), 120)
  }

  private stopCompactTracking(): void {
    if (this.compactTimer) clearInterval(this.compactTimer)
    this.compactTimer = null
  }

  private pollCompactCursor(): void {
    if (!this.alive || !this.win.isVisible()) return
    const state = this.browser.state
    const zen = this.zen
    const cm = state.settings.compactMode
    const hidden = zen.compactEnabled && cm.hideSidebar && !zen.compactSidebarPersistent
    if (!hidden || zen.htmlFullscreenTabId) {
      this.compactLastSent = null
      return
    }
    if (!this.win.isFocused() && !zen.compactSidebarRevealed) return
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
      if (zen.compactSidebarRevealed) this.send('compact.reveal', { revealed: false })
    }
  }
}

/** Creates `ElectronWindow`s for the core and maps chrome web contents back to their windows. */
export class ElectronWindowFactory implements WindowHostFactory {
  private readonly byWebContentsId = new Map<number, ZenWindow>()
  private browser!: Browser

  bind(browser: Browser): void {
    this.browser = browser
  }

  create(win: ZenWindow, init: WindowCreateInit): WindowHost {
    const host = new ElectronWindow(this.browser, win, init)
    const id = host.win.webContents.id
    this.byWebContentsId.set(id, win)
    host.win.on('closed', () => this.byWebContentsId.delete(id))
    return host
  }

  windowForWebContents(id: number): ZenWindow | undefined {
    const win = this.byWebContentsId.get(id)
    return win?.alive ? win : undefined
  }
}

function sanitizeBounds(saved: Rect | null): Rect {
  const primary = screen.getPrimaryDisplay().workArea
  const fallback: Rect = {
    width: Math.min(1280, primary.width - 40),
    height: Math.min(820, primary.height - 40),
    x:
      primary.x + Math.max(0, Math.round((primary.width - Math.min(1280, primary.width - 40)) / 2)),
    y:
      primary.y + Math.max(0, Math.round((primary.height - Math.min(820, primary.height - 40)) / 2))
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
