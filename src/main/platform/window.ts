import {
  BrowserWindow,
  WebContentsView,
  nativeImage,
  screen,
  shell,
  webContents,
  type NativeImage
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { ElectronShortcuts } from './shortcuts'
import type { EventName, Events, Rect, WindowChrome } from '../../shared/types'
import { CAPTION_HEIGHT, type CaptionColors } from '../../shared/theme'
import type { Browser } from '../../core/browser'
import type { ZenWindow } from '../../core/window'
import type {
  KeyEventInput,
  WindowCreateInit,
  WindowHost,
  WindowHostFactory
} from '../../core/platform'
import { TitleThrottle } from '../../shared/windowTitle'
import { windowIcon } from './appIcon'
import { EdgeTracker, edgeState, type EdgeZone } from './edgeReveal'
import { placeWindow, type DisplayArea } from './windowPlacement'

const MIN_WIDTH = 640
const MIN_HEIGHT = 420
/** A first window's size (within the display). */
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 820
/** Popups are as small as the page asked for, within reason. */
const POPUP_MIN_WIDTH = 320
const POPUP_MIN_HEIGHT = 200
/** An app window's first size (Chrome opens installed apps at about this); the app's own after. */
const APP_DEFAULT_WIDTH = 1024
const APP_DEFAULT_HEIGHT = 720
/** Width (px) of the edge zone that reveals the sidebar in compact mode. */
const COMPACT_REVEAL_ZONE = 14
/**
 * Height (px) of the top zone that reveals the hidden toolbar. Narrower than the sidebar's: a
 * fullscreen page's own top row sits right under it, and the cursor parks on the screen edge.
 */
const TOOLBAR_REVEAL_ZONE = 4
/** How far below the top edge the cursor may roam before a revealed toolbar is asked to go. */
const TOOLBAR_KEEP_ZONE = 120
/**
 * Windows 11 draws the caption buttons itself (Window Controls Overlay), which is what gives the
 * maximise button its Snap Layouts flyout. macOS keeps its traffic lights; Linux draws Zenium's.
 */
const CAPTION_OVERLAY = process.platform === 'win32'
/**
 * The popup surface is kept loaded for this long after it was last shown, so the next picker
 * comes up without a document load; then it is closed to give its memory back.
 */
const POPUP_SURFACE_IDLE_MS = 30_000

/** Where the factory keeps the chrome documents that may send commands for a window. */
export interface ChromeContentsRegistry {
  add(id: number): void
  remove(id: number): void
}

/**
 * The Electron side of one `ZenWindow`: a frameless `BrowserWindow` whose web contents render
 * Zen's chrome. Tab pages are `WebContentsView` children the core positions through the window's
 * layout reports. Frame events (focus, bounds, close) are forwarded to the core window. The popup
 * surface (`setPopupSurface`) is a second chrome document in a `WebContentsView` above the pages.
 */
export class ElectronWindow implements WindowHost {
  readonly win: BrowserWindow
  private boundsTimer: ReturnType<typeof setTimeout> | null = null
  private compactTimer: ReturnType<typeof setInterval> | null = null
  private readonly sidebarEdge = new EdgeTracker()
  private readonly toolbarEdge = new EdgeTracker()
  private readonly titles: TitleThrottle
  private captionColors: CaptionColors
  private popup: WebContentsView | null = null
  private popupIdleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly browser: Browser,
    readonly zen: ZenWindow,
    init: WindowCreateInit,
    private readonly registry: ChromeContentsRegistry = {
      add: () => undefined,
      remove: () => undefined
    }
  ) {
    let initial = init.bounds
    let displayId = init.displayId
    if (!initial && init.cascadeFrom?.alive) {
      const from = (init.cascadeFrom.host as ElectronWindow).win
      const b = from.getNormalBounds()
      initial = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height }
      displayId = screen.getDisplayMatching(b).id
    }
    const bounds = sanitizeBounds(initial, displayId, init.chrome)
    const isMac = process.platform === 'darwin'
    const mica = init.material === 'mica' && process.platform === 'win32'
    // Popups and app windows are as small as the page (or the app) wants, within reason.
    const compactChrome = init.chrome !== 'full'
    this.captionColors = init.captionColors
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: compactChrome ? POPUP_MIN_WIDTH : MIN_WIDTH,
      minHeight: compactChrome ? POPUP_MIN_HEIGHT : MIN_HEIGHT,
      show: false,
      frame: false,
      titleBarStyle: isMac ? 'hiddenInset' : CAPTION_OVERLAY ? 'hidden' : undefined,
      // Centred on the 38px header row (12px lights: 16 + 6 = 22 = 6 + 32 / 2); a toolbar-only
      // window's 40px toolbar row (and an app window's title row) is centred at 20.
      trafficLightPosition: isMac ? { x: 14, y: compactChrome ? 14 : 16 } : undefined,
      titleBarOverlay: CAPTION_OVERLAY
        ? {
            color: init.captionColors.color,
            symbolColor: init.captionColors.symbolColor,
            height: CAPTION_HEIGHT
          }
        : undefined,
      // A material window paints its web contents on a see-through background (no
      // `transparent`, which would cost the resize border); the chrome leaves the material
      // visible through its gradient.
      ...(mica
        ? { backgroundMaterial: 'mica' as const }
        : { backgroundColor: init.backgroundColor }),
      autoHideMenuBar: true,
      title: init.title,
      // Windows and Linux take the icon per window (macOS shows the bundle's, or the Dock's); an
      // app window carries its app's icon into the taskbar and the window switcher.
      ...(process.platform === 'darwin'
        ? {}
        : {
            icon:
              appWindowIcon(init.app?.icon ?? null) ?? windowIcon(browser.state.settings.appIcon)
          }),
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
    this.titles = new TitleThrottle((title) => {
      if (this.alive) win.setTitle(title)
    }, init.title)
    // Windows groups taskbar buttons by AppUserModelID: an installed app's windows get their
    // own group, icon and pin ("pin to taskbar" relaunches the app), as Chrome's app windows do.
    if (process.platform === 'win32' && init.app?.appId) {
      const icon = init.app.icon?.startsWith('file:') ? fileURLToPath(init.app.icon) : null
      const ico = icon ? icon.replace(/\.png$/i, '.ico') : null
      win.setAppDetails({
        appId: ElectronShortcuts.appUserModelId(init.app.appId),
        ...(ico ? { appIconPath: ico, appIconIndex: 0 } : {}),
        relaunchCommand: ElectronShortcuts.relaunchCommand(init.app.startUrl),
        relaunchDisplayName: init.app.name
      })
    }
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
    // The mouse's back and forward buttons (Windows: WM_APPCOMMAND; Linux: buttons 8 and 9),
    // wherever in the window they are pressed, navigate the active tab like Chrome's do.
    win.on('app-command', (_e, command) => {
      if (command === 'browser-backward')
        browser.actions.run('nav.back', { sourceTabId: null, win: zen })
      else if (command === 'browser-forward')
        browser.actions.run('nav.forward', { sourceTabId: null, win: zen })
    })
    win.on('close', (event) => {
      // The caption button, Alt+F4 and the window manager arrive here first: the browser runs
      // its checks (the tab-count warning, every page's "Leave site?") and closes again once
      // they pass. Windows the browser closes itself, and every window while quitting, go.
      if (!zen.closeApproved && !browser.quitting) {
        event.preventDefault()
        // Off the event: the checks may pass at once and close again, which must not re-enter
        // the close that is being cancelled here.
        setImmediate(() => void browser.requestWindowClose(zen))
        return
      }
      if (this.boundsTimer) clearTimeout(this.boundsTimer)
      zen.onClosing()
    })
    // Windows: the user logs off or the system shuts down and the process is about to be ended.
    // Persist (with the clean-exit marker) and go without questions.
    win.on('session-end', () => browser.shutdown())
    win.on('closed', () => {
      this.stopCompactTracking()
      this.titles.cancel()
      this.closePopupSurface()
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
    // The chrome's rows show their menus themselves (and cancel the DOM event, which keeps this
    // one from firing); what reaches here is a text field, the URL bar or plain chrome. Shift+F10
    // and the Menu key arrive as a keyboard-sourced event at the caret or the focused element.
    wc.on('context-menu', (_event, params) =>
      zen.onContextMenu({
        x: params.x,
        y: params.y,
        keyboard: params.menuSourceType === 'keyboard',
        isEditable: params.isEditable,
        selectionText: params.selectionText,
        editFlags: params.editFlags
      })
    )
    // The chrome document's <title> is a constant "Zenium"; keep Electron from copying it over the
    // per-window title the core sets (active tab name) via setTitle. This has to be the window's
    // event: BrowserWindow applies the title right after emitting it unless it was prevented.
    win.on('page-title-updated', (event) => event.preventDefault())
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
    if (!this.alive) return
    this.win.webContents.send('zen:event', name, payload)
    // The popup surface mirrors the window's state like the chrome does (the picker lives in it).
    const popup = this.popup?.webContents
    if (popup && !popup.isDestroyed()) popup.send('zen:event', name, payload)
  }

  focusChrome(): void {
    if (this.alive) this.win.webContents.focus()
  }

  focusedDocument(): 'chrome' | 'other' | 'none' {
    const focused = webContents.getFocusedWebContents()
    if (!focused || focused.isDestroyed()) return 'none'
    return this.alive && focused.id === this.win.webContents.id ? 'chrome' : 'other'
  }

  openChromeDevTools(): void {
    if (this.alive) this.win.webContents.openDevTools({ mode: 'detach' })
  }

  /** The `data-zen-menu` element under a chrome point, read from the chrome document itself. */
  async menuTargetAt(
    x: number,
    y: number
  ): Promise<{ target: string; tabId: string | null } | null> {
    if (!this.alive) return null
    const result: unknown = await this.win.webContents
      .executeJavaScript(
        `(() => {
          const hit = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
          const el = hit && hit.closest('[data-zen-menu]');
          if (!el) return null;
          return { target: el.getAttribute('data-zen-menu'), tabId: el.getAttribute('data-zen-menu-tab') || null };
        })()`,
        true
      )
      .catch(() => null)
    if (!result || typeof result !== 'object') return null
    const hit = result as { target?: unknown; tabId?: unknown }
    if (typeof hit.target !== 'string') return null
    return { target: hit.target, tabId: typeof hit.tabId === 'string' ? hit.tabId : null }
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

  /** Rate limited to ten native title changes a second (`TitleThrottle`). */
  setTitle(title: string): void {
    if (this.alive) this.titles.set(title)
  }

  normalBounds(): Rect | null {
    return this.alive ? this.win.getNormalBounds() : null
  }

  /** The chrome document's place on the screen (DIP); the frameless window has no frame to add. */
  contentBounds(): Rect | null {
    return this.alive && this.win.isVisible() && !this.win.isMinimized()
      ? this.win.getContentBounds()
      : null
  }

  displayId(): number | null {
    return this.alive ? screen.getDisplayMatching(this.win.getBounds()).id : null
  }

  setCaptionColors(colors: CaptionColors): void {
    if (!CAPTION_OVERLAY || !this.alive) return
    const current = this.captionColors
    if (colors.color === current.color && colors.symbolColor === current.symbolColor) return
    this.captionColors = colors
    this.win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor })
  }

  // ---------------------------------------------------------------------------
  // Popup surface
  // ---------------------------------------------------------------------------

  /**
   * The picker's document in a `WebContentsView` above every page view, at `bounds` (window CSS
   * pixels); null hides it. Showing never moves the keyboard: the view is added without focus and
   * the page field keeps typing. Hidden, the document stays loaded for `POPUP_SURFACE_IDLE_MS` so
   * the next picker is instant, then it is closed.
   */
  setPopupSurface(bounds: Rect | null): void {
    if (!this.alive) return
    if (!bounds) {
      this.hidePopupSurface()
      return
    }
    if (this.popupIdleTimer) {
      clearTimeout(this.popupIdleTimer)
      this.popupIdleTimer = null
    }
    const view = this.popup ?? this.createPopupSurface()
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
    // Adding again moves the view to the top of the z-order, over a page view placed since.
    this.win.contentView.addChildView(view)
    if (!view.getVisible()) view.setVisible(true)
  }

  private createPopupSurface(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    // The panel draws its own background and shadow; the margin around it shows the page.
    view.setBackgroundColor('#00000000')
    this.popup = view
    const wc = view.webContents
    const id = wc.id
    this.registry.add(id)
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('context-menu', (event) => event.preventDefault())
    wc.on('destroyed', () => {
      this.registry.remove(id)
      if (this.popup === view) this.popup = null
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const url = new URL(process.env['ELECTRON_RENDERER_URL'])
      url.searchParams.set('surface', 'autofill')
      void wc.loadURL(url.toString())
    } else {
      void wc.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { surface: 'autofill' }
      })
    }
    return view
  }

  private hidePopupSurface(): void {
    const view = this.popup
    if (!view) return
    if (view.getVisible()) view.setVisible(false)
    if (this.alive) this.win.contentView.removeChildView(view)
    if (this.popupIdleTimer) clearTimeout(this.popupIdleTimer)
    this.popupIdleTimer = setTimeout(() => {
      this.popupIdleTimer = null
      this.closePopupSurface()
    }, POPUP_SURFACE_IDLE_MS)
  }

  private closePopupSurface(): void {
    if (this.popupIdleTimer) clearTimeout(this.popupIdleTimer)
    this.popupIdleTimer = null
    const view = this.popup
    if (!view) return
    this.popup = null
    if (this.alive) this.win.contentView.removeChildView(view)
    const wc = view.webContents
    this.registry.remove(wc.id)
    if (!wc.isDestroyed()) wc.close()
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
   * the chrome, so a DOM-only edge strip is unreliable. The hidden top toolbar is revealed the
   * same way: in a fullscreen window the page runs edge to edge and covers every strip the
   * chrome could hover.
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
    // The window's fullscreen hides the chrome like compact mode with both switches on.
    const fullscreen = zen.chrome === 'full' && this.win.isFullScreen()
    const sidebarHidden =
      fullscreen || (zen.compactEnabled && cm.hideSidebar && !zen.compactSidebarPersistent)
    const toolbarHidden =
      state.settings.toolbarLayout === 'multiple' &&
      (fullscreen || (zen.compactEnabled && cm.hideToolbar))
    if (zen.htmlFullscreenTabId || (!sidebarHidden && !toolbarHidden)) {
      this.sidebarEdge.reset()
      this.toolbarEdge.reset()
      return
    }
    if (!this.win.isFocused() && !zen.compactSidebarRevealed && !zen.compactToolbarRevealed) return
    const bounds = this.win.getContentBounds()
    const cursor = screen.getCursorScreenPoint()
    if (sidebarHidden) {
      const sidebarWidth = state.settings.sidebarExpanded ? state.settings.sidebarWidth : 56
      const zone: EdgeZone = {
        edge: state.settings.sidebarSide,
        reveal: COMPACT_REVEAL_ZONE,
        keep: sidebarWidth + 32
      }
      const send = this.sidebarEdge.sample(
        edgeState(cursor, bounds, zone),
        zen.compactSidebarRevealed
      )
      if (send !== null) this.send('compact.reveal', { revealed: send, edge: 'sidebar' })
    } else {
      this.sidebarEdge.reset()
    }
    if (toolbarHidden) {
      const zone: EdgeZone = { edge: 'top', reveal: TOOLBAR_REVEAL_ZONE, keep: TOOLBAR_KEEP_ZONE }
      const send = this.toolbarEdge.sample(
        edgeState(cursor, bounds, zone),
        zen.compactToolbarRevealed
      )
      if (send !== null) this.send('compact.reveal', { revealed: send, edge: 'toolbar' })
    } else {
      this.toolbarEdge.reset()
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
    // The popup surface's document sends commands for the window like the chrome does.
    const host = new ElectronWindow(this.browser, win, init, {
      add: (id) => this.byWebContentsId.set(id, win),
      remove: (id) => this.byWebContentsId.delete(id)
    })
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

/**
 * Saved bounds go back onto the display they were saved on (or the one they lie on, or the
 * primary), fitted into its work area; see `placeWindow`.
 */
function sanitizeBounds(saved: Rect | null, displayId: number | null, chrome: WindowChrome): Rect {
  const primary = screen.getPrimaryDisplay()
  const displays: DisplayArea[] = [
    primary,
    ...screen.getAllDisplays().filter((d) => d.id !== primary.id)
  ].map((d) => ({ id: d.id, workArea: d.workArea }))
  return placeWindow(
    {
      saved,
      displayId,
      minWidth: chrome === 'full' ? MIN_WIDTH : POPUP_MIN_WIDTH,
      minHeight: chrome === 'full' ? MIN_HEIGHT : POPUP_MIN_HEIGHT,
      defaultSize:
        chrome === 'app'
          ? { width: APP_DEFAULT_WIDTH, height: APP_DEFAULT_HEIGHT }
          : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
    },
    displays
  )
}

/**
 * An app window's icon for the frame and taskbar: the launcher icon the shortcut host kept (a
 * `file:` URL under the profile) or a data URL; null when there is none or it cannot be read.
 */
function appWindowIcon(icon: string | null): NativeImage | null {
  if (!icon) return null
  try {
    const image = icon.startsWith('data:')
      ? nativeImage.createFromDataURL(icon)
      : icon.startsWith('file:')
        ? nativeImage.createFromPath(fileURLToPath(icon))
        : null
    return image && !image.isEmpty() ? image : null
  } catch {
    return null
  }
}
