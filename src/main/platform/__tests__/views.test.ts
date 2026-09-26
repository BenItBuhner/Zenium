import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebPreferences } from 'electron'
import type { Tab } from '../../../shared/types'
import type {
  AgentInputEvent,
  TabViewEvents,
  WindowHost,
  WindowOpenTicket
} from '../../../core/platform'
import {
  DEFAULT_FONT_SETTINGS,
  electronFontDefaults,
  electronGenericFontDefaults,
  FONT_RESTYLE_SCRIPT,
  type ExtensionFontLayer,
  type PageFontSettings
} from '../../../shared/fonts'
import type { SessionManager } from '../sessions'
import {
  addForeignDebuggerOwner,
  removeForeignDebuggerOwner,
  setDebuggerRecycler
} from '../pageDebugger'
import { HANG_MISSES, HANG_PING_MS, HANG_PROBE_TIMEOUT_MS } from '../hangMonitor'
import { PAINT_STATE_SCRIPT } from '../firstPaint'
import { DevtoolsQuitHoldNotice } from '../devtoolsQuitHoldNotice'
import type { QuitHoldPanel } from '../../../shared/quitHoldPanel'
import {
  ElectronTabViewHost,
  ENDED_BY_USER_MS,
  fullPageCut,
  protocolClip,
  pageViewportFrom,
  visibleAreaClip,
  type ElectronTabView
} from '../views'

/** The options every `WebContentsView` in the test was constructed with, in order. */
const constructed: Array<Record<string, unknown>> = []

/**
 * Which page has the keyboard. `takeKeyboard` moves it the way Chromium does: the holder gets
 * `blur`, the taker `focus`.
 */
const { keyboard, takeKeyboard, cursor } = vi.hoisted(() => {
  /** Where the OS pointer stands on the screen (`screen.getCursorScreenPoint`); a test moves it. */
  const cursor = { x: -100, y: -100 }
  const keyboard = { current: null as { emit(event: string): unknown } | null }
  const takeKeyboard = (taker: { emit(event: string): unknown }): void => {
    const previous = keyboard.current
    if (previous === taker) return
    keyboard.current = taker
    previous?.emit('blur')
    taker.emit('focus')
  }
  return { keyboard, takeKeyboard, cursor }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  /**
   * The page's renderer main thread: gives everything sent to it its turn a tick later – or
   * not at all while `hung` (a `for(;;){}`), until `answer()` ends the loop.
   */
  class FakeRenderer {
    hung = false
    private readonly waiting: Array<() => void> = []
    /** One turn of the main thread. */
    async turn(): Promise<void> {
      if (this.hung) await new Promise<void>((r) => this.waiting.push(r))
      await new Promise((r) => setTimeout(r, 1))
    }
    /** The loop ends: everything queued while it ran gets its turn. */
    answer(): void {
      this.hung = false
      for (const next of this.waiting.splice(0)) next()
    }
  }
  /** A DevTools session as `webContents.debugger` offers it, recording what happened to it. */
  class FakeDebugger extends EventEmitter {
    constructor(private readonly renderer: FakeRenderer) {
      super()
    }
    attached = false
    /** Another client (DevTools) holds the page: `attach` refuses. */
    taken = false
    readonly log: string[] = []
    /** Every command with its parameters, for the tests that read what was sent. */
    readonly commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
    /** How many agents (attachments) have seen `Page.setFontFamilies`: Chromium allows one per agent. */
    private fontFamiliesSet = false
    isAttached(): boolean {
      return this.attached
    }
    attach(): void {
      if (this.attached || this.taken) throw new Error('Debugger is already attached')
      this.attached = true
      this.fontFamiliesSet = false
      this.log.push('attach')
    }
    detach(): void {
      this.attached = false
      this.log.push('detach')
    }
    async sendCommand(
      method: string,
      params?: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      if (!this.attached) throw new Error('Debugger is not attached')
      this.log.push(method)
      this.commands.push({ method, params })
      await this.renderer.turn()
      if (method === 'Page.setFontFamilies') {
        if (this.fontFamiliesSet) throw new Error('Font families can only be set once')
        this.fontFamiliesSet = true
      }
      return {}
    }
  }
  /**
   * A DevTools frontend page as `webContents.devToolsWebContents` gives it: records the scripts
   * the host runs in it and carries the `console-message` a dock change writes.
   */
  class FakeDevtoolsFrontend extends EventEmitter {
    readonly scripts: string[] = []
    /** Scripts that reject, by a substring: a frontend without the module the host imports. */
    rejecting: string | null = null
    /** The frontend document's own frame: the frame a console line of its own is said from. */
    readonly mainFrame = { name: 'devtools://devtools/bundled/devtools_app.html' }
    private closed = false
    isDestroyed(): boolean {
      return this.closed
    }
    executeJavaScript(code: string): Promise<unknown> {
      this.scripts.push(code)
      if (this.rejecting && code.includes(this.rejecting))
        return Promise.reject(new Error('module not found'))
      return Promise.resolve('ok')
    }
    close(): void {
      this.closed = true
    }
  }
  class FakeWebContents extends EventEmitter {
    private static nextId = 1
    readonly id = FakeWebContents.nextId++
    private closed = false
    readonly renderer = new FakeRenderer()
    readonly debugger = new FakeDebugger(this.renderer)
    /** Every `openDevTools` call's options, in order (`{ mode, activate }`). */
    readonly devtoolsOpened: Array<Record<string, unknown>> = []
    /** Every `inspectElement` call's point. */
    readonly inspected: Array<[number, number]> = []
    devtoolsClosedCount = 0
    private frontend: FakeDevtoolsFrontend | null = null
    /** The frontend of the toolbox that is up, as Electron's accessor gives it (null when closed). */
    get devToolsWebContents(): FakeDevtoolsFrontend | null {
      return this.frontend
    }
    isDevToolsOpened(): boolean {
      return this.frontend !== null
    }
    /** Opens synchronously; `devtools-opened` follows once the frontend has loaded, as Electron's does. */
    openDevTools(options: Record<string, unknown>): void {
      this.devtoolsOpened.push(options)
      if (this.frontend) return
      this.frontend = new FakeDevtoolsFrontend()
      setImmediate(() => {
        if (this.frontend) this.emit('devtools-opened')
      })
    }
    closeDevTools(): void {
      if (!this.frontend) return
      this.devtoolsClosedCount++
      this.frontend.close()
      this.frontend = null
      this.emit('devtools-closed')
    }
    inspectElement(x: number, y: number): void {
      this.inspected.push([x, y])
    }
    /** Events sent to the main frame's widget (`sendInputEvent`, the fallback path). */
    readonly widgetEvents: Array<Record<string, unknown>> = []
    /** The renderer's OS process; a test moves the page to another renderer by changing it. */
    pid = 1000
    getOSProcessId(): number {
      return this.pid
    }
    isDestroyed(): boolean {
      return this.closed
    }
    getTitle(): string {
      return ''
    }
    /** The page's address (`getURL`); a test navigates by setting it. */
    url = ''
    getURL(): string {
      return this.url
    }
    /** The page's session, for the tests that look something up by it. */
    session: object = {}
    getZoomFactor(): number {
      return 1
    }
    sendInputEvent(event: Record<string, unknown>): void {
      this.widgetEvents.push(event)
    }
    /** Every message posted to the page's preload (`webContents.send`), by channel. */
    readonly sent: Array<{ channel: string; args: unknown[] }> = []
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    }
    /**
     * What the main frame answers the first-paint probe (`firstPaint.ts`), one answer per
     * probe, the last repeating: painted unless a test holds the page.
     */
    paintAnswers: string[] = ['painted']
    /** Every paint probe run in the main frame. */
    readonly paintProbes: string[] = []
    /**
     * The main frame, for the scripts run in it alone (`WebFrameMain.executeJavaScript`): the
     * first-paint probe is answered from `paintAnswers` at once and recorded in `paintProbes`;
     * every other script (the hang monitor's literal) is recorded in `scripts` and answered
     * after a renderer turn – a hung renderer answers neither.
     */
    readonly mainFrame = {
      scripts: [] as string[],
      executeJavaScript: (code: string): Promise<unknown> => {
        if (code === PAINT_STATE_SCRIPT) {
          this.paintProbes.push(code)
          const answer =
            this.paintAnswers.length > 1 ? this.paintAnswers.shift()! : this.paintAnswers[0]!
          return Promise.resolve(answer)
        }
        this.mainFrame.scripts.push(code)
        return this.renderer.turn().then(() => 1)
      }
    }
    /** Scripts run in the page's main world (`showErrorPage`'s in-place document). */
    readonly scripts: string[] = []
    executeJavaScript(code: string): Promise<unknown> {
      this.scripts.push(code)
      return Promise.resolve(undefined)
    }
    /** Scripts run in the preload's isolated world, and when: a `restyle` entry in the session's log. */
    readonly isolatedScripts: Array<{ worldId: number; code: string }> = []
    executeJavaScriptInIsolatedWorld(
      worldId: number,
      scripts: Array<{ code: string }>
    ): Promise<unknown> {
      for (const script of scripts) this.isolatedScripts.push({ worldId, code: script.code })
      this.debugger.log.push('restyle')
      return Promise.resolve(undefined)
    }
    setWindowOpenHandler(): undefined {
      return undefined
    }
    readonly loaded: string[] = []
    loadURL(url: string): Promise<void> {
      this.loaded.push(url)
      return Promise.resolve()
    }
    /** How often the page was given the keyboard. */
    focusCalls = 0
    focus(): void {
      this.focusCalls++
      takeKeyboard(this)
    }
    isFocused(): boolean {
      return keyboard.current === this
    }
    close(): void {
      this.closed = true
      this.emit('destroyed')
    }
  }
  /**
   * Electron 44 resolves `WebContentsView.webContents` through a weak pointer to the API wrapper,
   * which is already gone when the wrapper emits `destroyed`; the accessor yields undefined there.
   */
  class FakeWebContentsView {
    private contents: FakeWebContents | undefined
    constructor(options: { webContents?: FakeWebContents } & Record<string, unknown> = {}) {
      constructed.push(options)
      this.contents = options.webContents ?? new FakeWebContents()
      this.contents.on('destroyed', () => {
        this.contents = undefined
      })
    }
    get webContents(): FakeWebContents | undefined {
      return this.contents
    }
    private visible = false
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    getVisible(): boolean {
      return this.visible
    }
    /** The box the chrome last laid the view out in. */
    bounds: { x: number; y: number; width: number; height: number } | null = null
    setBounds(rect: { x: number; y: number; width: number; height: number }): void {
      this.bounds = rect
    }
  }
  /** The view host follows the chrome's scheme for dark theme for sites; light and quiet here. */
  // Every view host in the tests listens for a flip (the app has one host; the tests many).
  const nativeTheme = Object.assign(new EventEmitter().setMaxListeners(0), {
    shouldUseDarkColors: false
  })
  /** One plain display: a full-page paint's cut is the CSS-pixel one. The pointer is `cursor`'s. */
  const screen = {
    getAllDisplays: () => [{ scaleFactor: 1 }],
    getCursorScreenPoint: () => ({ ...cursor })
  }
  return { WebContentsView: FakeWebContentsView, nativeTheme, screen }
})

/** A window's chrome page: the keyboard's home when no page on screen has it. */
class FakeChrome extends EventEmitter {
  focusCalls = 0
  /** The pointer events the host tells the chrome page of (`sendInputEvent`). */
  readonly inputEvents: Array<Record<string, unknown>> = []
  isDestroyed(): boolean {
    return false
  }
  focus(): void {
    this.focusCalls++
    takeKeyboard(this)
  }
  sendInputEvent(event: Record<string, unknown>): void {
    this.inputEvents.push(event)
  }
}

/**
 * A BrowserWindow as `attachTo` sees it: its chrome page, its `contentView`, its focus. Adding a
 * child again moves it to the top of the z-order, as Electron's `addChildView` does.
 */
class FakeBrowserWindow extends EventEmitter {
  focused = true
  readonly children: unknown[] = []
  readonly contentView = {
    children: this.children,
    addChildView: (view: unknown): void => {
      const at = this.children.indexOf(view)
      if (at >= 0) this.children.splice(at, 1)
      this.children.push(view)
    },
    removeChildView: (view: unknown): void => {
      const at = this.children.indexOf(view)
      if (at >= 0) this.children.splice(at, 1)
    }
  }
  constructor(readonly webContents: FakeChrome) {
    super()
  }
  isDestroyed(): boolean {
    return false
  }
  isFocused(): boolean {
    return this.focused
  }
  /** The window's content, in DIP: what a parked view's pixel is kept inside. */
  contentSize: [number, number] = [1280, 820]
  getContentSize(): [number, number] {
    return this.contentSize
  }
  /** The content's place on the screen: at (100, 60), for the pointer's screen point to map. */
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 100, y: 60, width: this.contentSize[0], height: this.contentSize[1] }
  }
}

/**
 * A window host as the view sees it: its `BrowserWindow`, its chrome page, its core window's
 * word on whether chrome UI covers the content (`ZenWindow.contentHidden`, off to begin with),
 * and whether a mouse button is down on the chrome (`buttonHeld`, up to begin with).
 */
function fakeWindow(): WindowHost & {
  win: FakeBrowserWindow
  chrome: FakeChrome
  zen: { contentHidden: boolean }
  buttonHeld: boolean
} {
  const chrome = new FakeChrome()
  const win = new FakeBrowserWindow(chrome)
  const host = {
    win,
    chrome,
    zen: { contentHidden: false },
    buttonHeld: false,
    pointerButtonHeld: (): boolean => host.buttonHeld
  }
  return host as unknown as WindowHost & {
    win: FakeBrowserWindow
    chrome: FakeChrome
    zen: { contentHidden: boolean }
    buttonHeld: boolean
  }
}

/** A page Chromium made for a script `window.open`, before any tab adopted it. */
async function guestWebContents(): Promise<Electron.WebContents> {
  const { WebContentsView } = await import('electron')
  const view = new WebContentsView({})
  constructed.pop()
  return view.webContents
}

/** The session manager as the host uses it: one session for every container, hooks kept. */
const sessionHooks: Array<(ses: object, containerId: string) => void> = []
const sessions = {
  get: () => ({}),
  containerOf: () => 'default',
  configure: (hook: (ses: object, containerId: string) => void) => {
    sessionHooks.push(hook)
  }
} as unknown as SessionManager
const detachedWindow = { win: { isDestroyed: () => true } } as unknown as WindowHost
const noEvents = new Proxy({} as TabViewEvents, { get: () => () => undefined })

describe('ElectronTabViewHost', () => {
  it('forgets a closed tab by its captured webContents id without touching the dead accessor', () => {
    const host = new ElectronTabViewHost(sessions)
    const tab = { id: 'tab_1', containerId: 'default' } as Tab
    const view = host.createView(tab, noEvents, detachedWindow)
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    expect(host.tabIdForWebContents(wc)).toBe('tab_1')
    expect(host.viewForWebContents(wc)).toBe(view)

    expect(() => view.destroy()).not.toThrow()

    expect(host.tabIdForWebContents(wc)).toBeUndefined()
    expect(host.viewForWebContents(wc)).toBeUndefined()
  })

  it('reports each server redirect of the main-frame navigation under way as a hop, from the address it was bound for (history-23)', () => {
    const host = new ElectronTabViewHost(sessions)
    const hops: Array<[string, string]> = []
    const events = new Proxy({} as TabViewEvents, {
      get: (_t, name) =>
        name === 'onRedirected'
          ? (from: string, to: string) => hops.push([from, to])
          : () => undefined
    })
    const view = host.createView(
      { id: 'tab_redirect', containerId: 'default' } as Tab,
      events,
      detachedWindow
    )
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    const start = (url: string, isSameDocument = false): void => {
      wc.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument })
    }
    const redirect = (
      url: string,
      extra: Partial<{ isMainFrame: boolean; isSameDocument: boolean }> = {}
    ): void => {
      wc.emit('did-redirect-navigation', {
        url,
        isMainFrame: true,
        isSameDocument: false,
        ...extra
      })
    }

    // A typed shortener bouncing twice: two hops, each from the previous target.
    start('https://sho.rt/x')
    redirect('http://a.example/')
    redirect('https://a.example/')
    expect(hops).toEqual([
      ['https://sho.rt/x', 'http://a.example/'],
      ['http://a.example/', 'https://a.example/']
    ])
    // A sub-frame's or a same-document redirect is not the tab's chain.
    redirect('https://frame.example/', { isMainFrame: false })
    redirect('https://a.example/#x', { isSameDocument: true })
    expect(hops).toHaveLength(2)

    // The commit ends the navigation: a redirect with no navigation under way is not a hop.
    wc.emit('did-navigate', {}, 'https://a.example/')
    redirect('https://stray.example/')
    expect(hops).toHaveLength(2)

    // A same-document start does not open a navigation either; a failure closes one.
    start('https://a.example/#y', true)
    redirect('https://stray.example/')
    start('https://b.example/')
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://b.example/', true)
    redirect('https://stray.example/')
    expect(hops).toHaveLength(2)

    // A redirect onto the same address is no hop.
    start('https://c.example/')
    redirect('https://c.example/')
    redirect('https://d.example/')
    expect(hops.slice(2)).toEqual([['https://c.example/', 'https://d.example/']])
  })

  it('reports a renderer End process crashed as `ended`, once, and a crash of the page’s own as the engine says', () => {
    vi.useFakeTimers()
    try {
      const host = new ElectronTabViewHost(sessions)
      const reasons: Array<[string, number | undefined]> = []
      const events = new Proxy({} as TabViewEvents, {
        get: (_t, name) =>
          name === 'onCrashed'
            ? (reason: string, exitCode?: number) => reasons.push([reason, exitCode])
            : () => undefined
      })
      const view = host.createView(
        { id: 'tab_ended', containerId: 'default' } as Tab,
        events,
        detachedWindow
      )
      const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
      const gone = (reason: string, exitCode: number): void => {
        wc.emit('render-process-gone', {}, { reason, exitCode })
      }

      // The page's own crash: the engine's word, untouched.
      gone('crashed', 11)
      expect(reasons).toEqual([['crashed', 11]])

      // The task manager's End process: the view is told first, and the crash that follows
      // reads `ended`; the mark is spent by it, so the next crash is the page's own again.
      expect(host.noteEndedByUser(wc.id)).toBe(true)
      gone('crashed', 5)
      gone('crashed', 5)
      expect(reasons.slice(1)).toEqual([
        ['ended', 5],
        ['crashed', 5]
      ])

      // A mark never collected goes stale: a crash minutes later is not the user's doing.
      host.noteEndedByUser(wc.id)
      vi.advanceTimersByTime(ENDED_BY_USER_MS + 1)
      gone('killed', 9)
      expect(reasons.at(-1)).toEqual(['killed', 9])

      // Web contents that are no tab view's have nothing to mark.
      expect(host.noteEndedByUser(wc.id + 1000)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The resource governor's CPU clamp sits on background pages only (W5-15): it reads the
 * layout's showing and hiding of a page from the host, and its lifting of a shared session from
 * under the dark theme's hold is healed by the view.
 */
describe('the layout’s visibility and the page’s shared session', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 2))
  }
  const make = (
    host: ElectronTabViewHost,
    id: string
  ): { view: ElectronTabView; dbg: EventEmitter & { attached: boolean; log: string[] } } => {
    const view = host.createView(
      { id, containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    return {
      view,
      dbg: (
        view.webContents as unknown as {
          debugger: EventEmitter & { attached: boolean; log: string[] }
        }
      ).debugger
    }
  }

  it('tells its listeners of a flip of a page’s visibility, once per flip and not of a repeat', () => {
    const host = new ElectronTabViewHost(sessions)
    const { view } = make(host, 'tab_vis')
    const other = make(host, 'tab_vis_other').view
    const flips: Array<[ElectronTabView, boolean]> = []
    const off = host.onVisibilityChanged((v) => flips.push([v, v.isVisible()]))
    // Born hidden; the layout shows it.
    view.setVisible(true)
    expect(flips).toEqual([[view, true]])
    // The same layout again (a resize pass): no flip.
    view.setVisible(true)
    expect(flips).toHaveLength(1)
    // `refreshVisibility`'s hide-then-show is two flips – the clamp folds them.
    view.setVisible(false)
    view.setVisible(true)
    expect(flips.slice(1)).toEqual([
      [view, false],
      [view, true]
    ])
    // A page hidden that was hidden already says nothing.
    other.setVisible(false)
    expect(flips).toHaveLength(3)
    off()
    view.setVisible(false)
    expect(flips).toHaveLength(3)
  })

  it('puts the dark theme’s override back when the shared session goes from under its hold (the clamp lifting as the page comes in front)', async () => {
    const { nativeTheme } = await import('electron')
    const theme = nativeTheme as unknown as { shouldUseDarkColors: boolean }
    theme.shouldUseDarkColors = true
    try {
      const host = new ElectronTabViewHost(sessions)
      const { view, dbg } = make(host, 'tab_vis_dark')
      view.setDarkening(true)
      await settle()
      expect(dbg.log).toEqual(['attach', 'Emulation.setAutoDarkModeOverride'])
      // The governor detaches the session to clear its clamp; Electron emits `detach` after letting go.
      ;(dbg as unknown as { detach(): void }).detach()
      dbg.emit('detach', {}, 'target closed')
      await settle()
      expect(dbg.log.slice(2)).toEqual(['detach', 'attach', 'Emulation.setAutoDarkModeOverride'])
      expect(dbg.attached).toBe(true)
      // The hold ending takes the session it re-opened with it.
      view.setDarkening(false)
      await settle()
      expect(dbg.attached).toBe(false)
      // A page with no hold is left as the governor wants a page in front: with no session.
      dbg.emit('detach', {}, 'target closed')
      await settle()
      expect(dbg.attached).toBe(false)
    } finally {
      theme.shouldUseDarkColors = false
    }
  })

  it('switches JavaScript off on the page’s session for a blocked site’s document as its navigation starts, and back on for the next site (PS-64)', async () => {
    const host = new ElectronTabViewHost(sessions)
    const asked: Array<[string, string, string | undefined]> = []
    host.contentRules = {
      allows: (id, url, details) => {
        asked.push([id, url, details?.privateContainerId])
        return !(id === 'javascript' && url.startsWith('https://noscript.example'))
      },
      blockedGuards: () => []
    }
    const { view, dbg } = make(host, 'tab_scripts')
    const wc = view.webContents as unknown as EventEmitter
    const commands = (): Array<{ method: string; params: Record<string, unknown> | undefined }> =>
      (
        dbg as unknown as {
          commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
        }
      ).commands
    // An allowed site: nothing goes on the session (no attach for nothing).
    wc.emit('did-start-navigation', {
      url: 'https://fine.example/',
      isMainFrame: true,
      isSameDocument: false
    })
    await settle()
    expect(dbg.log).toEqual([])
    expect(asked).toEqual([['javascript', 'https://fine.example/', undefined]])
    // A blocked site's document: the switch goes on before the response is read.
    wc.emit('did-start-navigation', {
      url: 'https://noscript.example/a',
      isMainFrame: true,
      isSameDocument: false
    })
    await settle()
    expect(dbg.log).toEqual(['attach', 'Emulation.setScriptExecutionDisabled'])
    expect(commands()[0]).toEqual({
      method: 'Emulation.setScriptExecutionDisabled',
      params: { value: true }
    })
    // A same-document navigation and a frame's are no document of the page's: left alone.
    wc.emit('did-start-navigation', {
      url: 'https://noscript.example/a#x',
      isMainFrame: true,
      isSameDocument: true
    })
    wc.emit('did-start-navigation', {
      url: 'https://fine.example/frame',
      isMainFrame: false,
      isSameDocument: false
    })
    await settle()
    expect(dbg.log).toHaveLength(2)
    // A redirect hop to an allowed site takes it off, and the hold's session with it.
    wc.emit('did-redirect-navigation', {
      url: 'https://fine.example/landing',
      isMainFrame: true,
      isSameDocument: false
    })
    await settle()
    expect(dbg.log.slice(2)).toEqual(['Emulation.setScriptExecutionDisabled', 'detach'])
    expect(commands()[1]).toEqual({
      method: 'Emulation.setScriptExecutionDisabled',
      params: { value: false }
    })
    expect(dbg.attached).toBe(false)
    // The chrome's own documents are never asked about.
    wc.emit('did-start-navigation', {
      url: 'zen://settings',
      isMainFrame: true,
      isSameDocument: false
    })
    await settle()
    expect(asked.map(([, url]) => url)).not.toContain('zen://settings')
  })
})

/**
 * Electron 44 gives a new WebContentsView the keyboard once its renderer is up, hidden or not,
 * so a tab opened in the background (a middle-clicked link) would leave the next Ctrl+1 or
 * Ctrl+W with a page that is not on screen. A hidden page that finds itself with the keyboard
 * gives it back to whoever lost it (tabs-31).
 */
describe('a hidden tab page and the keyboard', () => {
  type Page = { focusCalls: number; emit(event: string): unknown }
  const pageOf = (view: ElectronTabView): Page => view.webContents as unknown as Page
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  const setup = (): {
    host: ElectronTabViewHost
    window: ReturnType<typeof fakeWindow>
    background: () => ElectronTabView
  } => {
    keyboard.current = null
    const host = new ElectronTabViewHost(sessions)
    const window = fakeWindow()
    let n = 0
    const background = (): ElectronTabView =>
      host.createView(
        { id: `tab_bg${++n}`, containerId: 'default' } as Tab,
        noEvents,
        window
      ) as ElectronTabView
    return { host, window, background }
  }

  it('gives the keyboard back to the chrome that lost it', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    const bg = background()
    // The background page's renderer comes up and takes the keyboard.
    takeKeyboard(pageOf(bg))
    expect(keyboard.current).toBe(pageOf(bg))
    await settle()
    expect(keyboard.current).toBe(window.chrome)
    expect(window.chrome.focusCalls).toBe(2)
  })

  it('gives it back to the page on screen that lost it', async () => {
    const { window, background } = setup()
    const shown = background()
    shown.setVisible(true)
    shown.focus()
    const bg = background()
    takeKeyboard(pageOf(bg))
    await settle()
    expect(keyboard.current).toBe(pageOf(shown))
    expect(pageOf(shown).focusCalls).toBe(2)
    expect(window.chrome.focusCalls).toBe(0)
  })

  it('falls back to the chrome when the page that lost it is off screen too', async () => {
    const { window, background } = setup()
    const hidden = background()
    hidden.focus()
    const bg = background()
    takeKeyboard(pageOf(bg))
    await settle()
    expect(keyboard.current).toBe(window.chrome)
    expect(pageOf(hidden).focusCalls).toBe(1)
  })

  it('leaves a page alone that is shown by the time it is checked (a tab being activated)', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    const next = background()
    takeKeyboard(pageOf(next))
    next.setVisible(true)
    await settle()
    expect(keyboard.current).toBe(pageOf(next))
    expect(window.chrome.focusCalls).toBe(1)
  })

  it('leaves a hidden page alone whose keyboard the core asked for (shown a frame later)', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    const next = background()
    // `focusContent` on activation: the chrome reports the layout that shows the page later.
    next.focus()
    expect(keyboard.current).toBe(pageOf(next))
    await settle()
    expect(keyboard.current).toBe(pageOf(next))
    expect(window.chrome.focusCalls).toBe(1)
    // The answer was consumed: the next unasked focus while hidden is given back again.
    window.chrome.focus()
    takeKeyboard(pageOf(next))
    await settle()
    expect(keyboard.current).toBe(window.chrome)
    expect(window.chrome.focusCalls).toBe(3)
  })

  it('leaves it alone when the core asks for it between the event and the check', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    const next = background()
    takeKeyboard(pageOf(next))
    // Ctrl+2 lands on the tab that just came up: `focus()` on a page that already has it.
    next.focus()
    await settle()
    expect(keyboard.current).toBe(pageOf(next))
    expect(window.chrome.focusCalls).toBe(1)
  })

  it('waits for the user to come back to a window that is not focused', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    window.win.focused = false
    const bg = background()
    takeKeyboard(pageOf(bg))
    await settle()
    // Nothing yet: focusing the chrome would pull the window to the front.
    expect(keyboard.current).toBe(pageOf(bg))
    expect(window.chrome.focusCalls).toBe(1)
    window.win.focused = true
    window.win.emit('focus')
    expect(keyboard.current).toBe(window.chrome)
    expect(window.chrome.focusCalls).toBe(2)
  })

  it('does nothing once the keyboard has moved on or the page is gone', async () => {
    const { window, background } = setup()
    window.chrome.focus()
    const bg = background()
    takeKeyboard(pageOf(bg))
    // Something else (the core showing a tab) already took it back.
    window.chrome.focus()
    await settle()
    expect(window.chrome.focusCalls).toBe(2)
    const late = background()
    takeKeyboard(pageOf(late))
    late.destroy()
    await settle()
    expect(window.chrome.focusCalls).toBe(2)
  })

  it('is quiet for a view whose window is gone', async () => {
    keyboard.current = null
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_late', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    expect(() => takeKeyboard(pageOf(view))).not.toThrow()
    await settle()
    expect(keyboard.current).toBe(pageOf(view))
  })

  /**
   * The core hears of the page taking the keyboard (`onFocused`: the chrome lets go of its
   * focused control, a split's pane becomes the active one) only for a focus that is the page's
   * own – not for the one Electron hands a hidden view and this host takes straight back, which
   * blurred the empty pane's URL field a moment after it opened (split-04).
   */
  describe('reporting the focus to the tab', () => {
    const withEvents = (
      host: ElectronTabViewHost,
      window: WindowHost
    ): { view: ElectronTabView; focused: () => number } => {
      let focused = 0
      const events = new Proxy({} as TabViewEvents, {
        get: (_t, name) =>
          name === 'onFocused'
            ? (): void => {
                focused++
              }
            : (): undefined => undefined
      })
      const view = host.createView(
        { id: 'tab_ev', containerId: 'default' } as Tab,
        events,
        window
      ) as ElectronTabView
      return { view, focused: () => focused }
    }

    it('says nothing of a hidden page handed the keyboard unasked, which is given back', async () => {
      const { host, window } = setup()
      window.chrome.focus()
      const { view, focused } = withEvents(host, window)
      takeKeyboard(pageOf(view))
      await settle()
      expect(keyboard.current).toBe(window.chrome)
      expect(focused()).toBe(0)
    })

    it('reports a page on screen taking it (the user clicked into the pane)', async () => {
      const { host, window } = setup()
      window.chrome.focus()
      const { view, focused } = withEvents(host, window)
      view.setVisible(true)
      takeKeyboard(pageOf(view))
      expect(focused()).toBe(1)
      await settle()
      expect(focused()).toBe(1)
      expect(keyboard.current).toBe(pageOf(view))
    })

    it('reports the answer to the core asking for it, hidden or not', async () => {
      const { host, window } = setup()
      window.chrome.focus()
      const { view, focused } = withEvents(host, window)
      view.focus()
      expect(focused()).toBe(1)
      await settle()
      expect(focused()).toBe(1)
      expect(keyboard.current).toBe(pageOf(view))
    })

    it('reports it once a page shown between the event and the check keeps it', async () => {
      const { host, window } = setup()
      window.chrome.focus()
      const { view, focused } = withEvents(host, window)
      takeKeyboard(pageOf(view))
      expect(focused()).toBe(0)
      view.setVisible(true)
      await settle()
      expect(focused()).toBe(1)
      expect(keyboard.current).toBe(pageOf(view))
    })
  })
})

/**
 * Chromium reports no hang for a page with a DevTools session on it (`hangMonitor.ts` says
 * why), so the view runs Zenium's own monitor for such a page while it is on screen in the
 * focused window, and its words and Chromium's reach the core through one relay (tabs-45).
 */
describe('Zenium’s hang monitor on a page with a session (tabs-45)', () => {
  interface HangPage {
    readonly id: number
    readonly renderer: { hung: boolean; answer(): void }
    readonly debugger: EventEmitter & {
      attached: boolean
      commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
    }
    readonly mainFrame: { scripts: string[] }
    openDevTools(options: Record<string, unknown>): void
    closeDevTools(): void
    emit(event: string, ...args: unknown[]): unknown
  }
  interface Made {
    view: ElectronTabView
    page: HangPage
    window: ReturnType<typeof fakeWindow>
    /** What the core heard, in order. */
    words: string[]
  }
  /** When the second probe of a page that answers nothing runs out. */
  const HUNG_AT = HANG_PING_MS + HANG_MISSES * HANG_PROBE_TIMEOUT_MS
  const evaluations = (page: HangPage): Array<Record<string, unknown> | undefined> =>
    page.debugger.commands.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params)
  const setup = (): Made => {
    keyboard.current = null
    const host = new ElectronTabViewHost(sessions)
    const window = fakeWindow()
    const words: string[] = []
    const events = new Proxy({} as TabViewEvents, {
      get: (_t, name) => {
        if (name === 'onUnresponsive') return () => words.push('hung')
        if (name === 'onResponsive') return () => words.push('answering')
        if (name === 'onCrashed') return () => words.push('gone')
        return () => undefined
      }
    })
    const view = host.createView(
      { id: 'tab_hang', containerId: 'default' } as Tab,
      events,
      window
    ) as ElectronTabView
    return { view, page: view.webContents as unknown as HangPage, window, words }
  }
  /** The page in front of the focused window, a session (the dark theme's hold) on it, hung. */
  const hungInFront = (): Made => {
    const made = setup()
    made.page.debugger.attached = true
    made.view.setVisible(true)
    made.page.renderer.hung = true
    return made
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the hang of a page in front that carries a session, probing over the session, and its answering again', async () => {
    const { page, words } = hungInFront()
    await vi.advanceTimersByTimeAsync(HUNG_AT - 1)
    expect(words).toEqual([])
    // Two probes so far, each the cheapest thing the main thread can answer, no domain enabled.
    expect(evaluations(page)).toEqual([
      { expression: '1', returnByValue: true },
      { expression: '1', returnByValue: true }
    ])
    expect(page.debugger.commands.map((c) => c.method)).not.toContain('Runtime.enable')
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung'])
    // The page's loop ends: the probes queued behind it are answered, and the core hears it.
    page.renderer.answer()
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung', 'answering'])
    // Answering, the page is asked at the idle pace and nothing more is said.
    await vi.advanceTimersByTimeAsync(HUNG_AT * 2)
    expect(words).toEqual(['hung', 'answering'])
  })

  it('probes through the main frame when the session on the page is an extension’s', async () => {
    const { page, words } = hungInFront()
    addForeignDebuggerOwner(page.id)
    try {
      await vi.advanceTimersByTimeAsync(HUNG_AT)
      expect(evaluations(page)).toEqual([])
      expect(page.mainFrame.scripts).toEqual(['1', '1', '1'])
      expect(words).toEqual(['hung'])
    } finally {
      removeForeignDebuggerOwner(page.id)
    }
  })

  it.each<[string, (made: Made) => void]>([
    [
      'no session on it (Chromium speaks for it)',
      ({ page }) => {
        page.debugger.attached = false
      }
    ],
    [
      'off screen',
      ({ view }) => {
        view.setVisible(false)
      }
    ],
    [
      'in a window that is not focused',
      ({ window }) => {
        window.win.focused = false
        window.win.emit('blur')
      }
    ],
    [
      'the toolbox open on it',
      ({ page }) => {
        page.openDevTools({ mode: 'bottom', activate: false })
      }
    ],
    [
      'paused at a breakpoint by the session’s client',
      ({ page }) => {
        page.debugger.emit('message', {}, 'Debugger.paused', {})
      }
    ]
  ])('asks nothing of a hung page with %s', async (_what, prepare) => {
    const made = hungInFront()
    prepare(made)
    await vi.advanceTimersByTimeAsync(HUNG_AT * 3)
    expect(evaluations(made.page)).toEqual([])
    expect(made.page.mainFrame.scripts).toEqual([])
    expect(made.words).toEqual([])
  })

  it('takes the watch up as the page comes in front of the focused window, and puts it down as it leaves – short of a hang reported', async () => {
    const { view, page, window, words } = setup()
    page.debugger.attached = true
    page.renderer.hung = true
    await vi.advanceTimersByTimeAsync(HUNG_AT)
    expect(evaluations(page)).toEqual([])
    // Shown: the count starts here.
    view.setVisible(true)
    await vi.advanceTimersByTimeAsync(HUNG_AT - 1)
    expect(words).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung'])
    // The window loses the focus with the hang standing: the page is asked on to its end.
    window.win.focused = false
    window.win.emit('blur')
    const asked = evaluations(page).length
    await vi.advanceTimersByTimeAsync(HANG_PROBE_TIMEOUT_MS + HANG_PING_MS)
    expect(evaluations(page).length).toBeGreaterThan(asked)
    page.renderer.answer()
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung', 'answering'])
    // Answering and out of the focused window: nothing more is asked.
    const settled = evaluations(page).length
    await vi.advanceTimersByTimeAsync(HUNG_AT * 2)
    expect(evaluations(page).length).toBe(settled)
    // Back in front: watched again.
    window.win.focused = true
    window.win.emit('focus')
    await vi.advanceTimersByTimeAsync(HANG_PING_MS)
    expect(evaluations(page).length).toBe(settled + 1)
  })

  it('counts the misses afresh once the session comes back on a page that lost it', async () => {
    const { page, words } = hungInFront()
    await vi.advanceTimersByTimeAsync(HANG_PING_MS + HANG_PROBE_TIMEOUT_MS)
    // One miss in; the hold lets go of the session (the governor's detach).
    page.debugger.attached = false
    page.debugger.emit('detach', {}, 'target closed')
    await vi.advanceTimersByTimeAsync(HANG_PROBE_TIMEOUT_MS)
    expect(words).toEqual([])
    page.debugger.attached = true
    await vi.advanceTimersByTimeAsync(HUNG_AT - 1)
    expect(words).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung'])
  })

  it('relays Chromium’s own words for a page without a session, and drops a `responsive` that answers no hang', () => {
    const { page, words } = setup()
    page.emit('responsive')
    expect(words).toEqual([])
    page.emit('unresponsive')
    page.emit('unresponsive')
    page.emit('responsive')
    page.emit('responsive')
    expect(words).toEqual(['hung', 'hung', 'answering'])
  })

  it('starts afresh for the renderer the page is reloaded into after a crash, saying nothing of the hang that went with the old one', async () => {
    const { page, words } = hungInFront()
    await vi.advanceTimersByTimeAsync(HUNG_AT)
    expect(words).toEqual(['hung'])
    page.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(words).toEqual(['hung', 'gone'])
    // Whatever the old renderer's probes come back with is nothing, and so is Chromium's word.
    page.renderer.answer()
    await vi.advanceTimersByTimeAsync(1)
    page.emit('responsive')
    expect(words).toEqual(['hung', 'gone'])
    // The new renderer hangs too: reported on its own count.
    page.renderer.hung = true
    await vi.advanceTimersByTimeAsync(HUNG_AT - 2)
    expect(words).toEqual(['hung', 'gone'])
    await vi.advanceTimersByTimeAsync(1)
    expect(words).toEqual(['hung', 'gone', 'hung'])
  })

  it('says nothing more once the page is gone', async () => {
    const { view, page, words } = hungInFront()
    await vi.advanceTimersByTimeAsync(HANG_PING_MS)
    expect(evaluations(page)).toHaveLength(1)
    view.destroy()
    await vi.advanceTimersByTimeAsync(HUNG_AT * 2)
    expect(evaluations(page)).toHaveLength(1)
    expect(words).toEqual([])
  })
})

/**
 * The site-information card's certificate comes from the session's own verification of the
 * page's host (`siteCertificates.ts`), read by the page's URL – never from a DevTools session,
 * which Electron's Security domain answers with nothing.
 */
describe('ElectronTabView.certificate', () => {
  interface HttpsPage {
    url: string
    session: object
    debugger: { log: string[] }
    close(): void
  }
  /** A session as `setCertificateVerifyProc` sees it, with the handshake it is asked about. */
  class FakeVerifyingSession {
    proc: ((request: unknown, callback: (verdict: number) => void) => void) | null = null
    readonly verdicts: number[] = []
    setCertificateVerifyProc(
      proc: (request: unknown, callback: (verdict: number) => void) => void
    ): void {
      this.proc = proc
    }
    verified(hostname: string, issuer: string): void {
      const cert = {
        data: '',
        subjectName: hostname,
        issuerName: 'R11',
        subject: { commonName: hostname, organizations: [] },
        issuer: { commonName: 'R11', organizations: [issuer] },
        validStart: 1_700_000_000,
        validExpiry: 1_707_000_000
      }
      this.proc?.({ hostname, certificate: cert, validatedCertificate: cert, errorCode: 0 }, (v) =>
        this.verdicts.push(v)
      )
    }
  }
  const setup = (): { view: ElectronTabView; page: HttpsPage; handshake: FakeVerifyingSession } => {
    sessionHooks.length = 0
    const host = new ElectronTabViewHost(sessions)
    // The host hooks every session as it is made; the manager runs the hook for this one.
    const handshake = new FakeVerifyingSession()
    for (const hook of sessionHooks) hook(handshake, 'default')
    const view = host.createView(
      { id: 'tab_https', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const page = view.webContents as unknown as HttpsPage
    page.session = handshake
    return { view, page, handshake }
  }

  it('reads the certificate the session verified for the page’s host, leaving the verdict to Chromium and the page’s debugger alone', async () => {
    const { view, page, handshake } = setup()
    expect(handshake.proc).not.toBeNull()
    handshake.verified('www.example.com', "Let's Encrypt")
    expect(handshake.verdicts).toEqual([-3])
    page.url = 'https://www.example.com/account'
    await expect(view.certificate()).resolves.toEqual({
      subject: 'www.example.com',
      issuer: "Let's Encrypt",
      validFrom: 1_700_000_000_000,
      validTo: 1_707_000_000_000,
      protocol: null
    })
    expect(page.debugger.log).toEqual([])
  })

  it('has nothing for an http page, a host no handshake named, or a page that is gone', async () => {
    const { view, page, handshake } = setup()
    handshake.verified('www.example.com', "Let's Encrypt")
    page.url = 'http://www.example.com/'
    await expect(view.certificate()).resolves.toBeNull()
    page.url = 'https://other.example/'
    await expect(view.certificate()).resolves.toBeNull()
    page.url = 'https://www.example.com/'
    page.close()
    await expect(view.certificate()).resolves.toBeNull()
  })
})

/**
 * The cause of the hidden page's keyboard: Electron 44 gives a `WebContentsView` in a window the
 * window's keyboard once its renderer is up, shown or not. A view is kept out of the window –
 * not a child of its `contentView` – until the layout first shows it, the core asks for its
 * keyboard or brings it to the front; out of the window there is no keyboard to take, and the
 * hand-back above stays as the backstop for a view hidden after it was shown.
 */
describe('a hidden tab page and the window', () => {
  type Page = { focusCalls: number; emit(event: string): unknown }
  const pageOf = (view: ElectronTabView): Page => view.webContents as unknown as Page
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  const box = { x: 0, y: 40, width: 800, height: 560 }
  const setup = (): {
    host: ElectronTabViewHost
    window: ReturnType<typeof fakeWindow>
    inWindow: (view: ElectronTabView, window?: ReturnType<typeof fakeWindow>) => boolean
    create: (window?: ReturnType<typeof fakeWindow>) => ElectronTabView
  } => {
    keyboard.current = null
    // The pointer off every window, unless a test puts it somewhere.
    cursor.x = -100
    cursor.y = -100
    const host = new ElectronTabViewHost(sessions)
    const window = fakeWindow()
    let n = 0
    const create = (target = window): ElectronTabView =>
      host.createView(
        { id: `tab_win${++n}`, containerId: 'default' } as Tab,
        noEvents,
        target
      ) as ElectronTabView
    const inWindow = (view: ElectronTabView, target = window): boolean =>
      target.win.children.includes(view.view)
    return { host, window, inWindow, create }
  }

  it('is made outside the window, hidden: a tab opened in the background has no keyboard to take', () => {
    const { window, inWindow, create } = setup()
    const view = create()
    expect(inWindow(view)).toBe(false)
    expect(window.win.children).toEqual([])
    expect(view.isVisible()).toBe(false)
    // Attached all the same: the window's chrome is followed for the keyboard from here.
    expect(window.chrome.listenerCount('blur')).toBe(1)
  })

  it('joins the window the first time the layout shows it, at the box it was given', () => {
    const { inWindow, create } = setup()
    const view = create()
    view.setBounds(box)
    expect(inWindow(view)).toBe(false)
    view.setVisible(true)
    expect(inWindow(view)).toBe(true)
    expect(view.view.getVisible()).toBe(true)
    expect((view.view as unknown as { bounds: unknown }).bounds).toEqual(box)
  })

  it('stays out of the window while hidden, and in it once hidden after being shown', () => {
    const { window, inWindow, create } = setup()
    const view = create()
    view.setVisible(false)
    view.setVisible(false)
    expect(inWindow(view)).toBe(false)
    view.setVisible(true)
    view.setVisible(false)
    // Hidden the way a tab switch hides a page: still the window's, shown again without re-entering.
    expect(inWindow(view)).toBe(true)
    expect(view.isVisible()).toBe(false)
    view.setVisible(true)
    expect(window.win.children).toEqual([view.view])
  })

  it('joins the window when the core asks for its keyboard (a tab activated a frame before its layout)', async () => {
    const { window, inWindow, create } = setup()
    window.chrome.focus()
    const view = create()
    view.focus()
    expect(inWindow(view)).toBe(true)
    expect(view.isVisible()).toBe(false)
    expect(keyboard.current).toBe(pageOf(view))
    await settle()
    // Its own, asked-for focus: not handed back.
    expect(keyboard.current).toBe(pageOf(view))
    expect(window.chrome.focusCalls).toBe(1)
    view.setBounds(box)
    view.setVisible(true)
    expect(window.win.children).toEqual([view.view])
  })

  it('joins the window when brought to the front (a glance at a page never shown), on top', () => {
    const { window, inWindow, create } = setup()
    const shown = create()
    shown.setVisible(true)
    const glanced = create()
    glanced.bringToFront()
    expect(inWindow(glanced)).toBe(true)
    expect(window.win.children).toEqual([shown.view, glanced.view])
    // Shown next, as the glance layout does: no second entry.
    glanced.setVisible(true)
    expect(window.win.children).toEqual([shown.view, glanced.view])
    shown.bringToFront()
    expect(window.win.children).toEqual([glanced.view, shown.view])
  })

  it('leaves the window with `detach` – and only what is in it is taken out', () => {
    const { window, inWindow, create } = setup()
    const shown = create()
    shown.setVisible(true)
    const hidden = create()
    expect(() => hidden.detach()).not.toThrow()
    expect(window.win.children).toEqual([shown.view])
    shown.detach()
    expect(inWindow(shown)).toBe(false)
    expect(window.win.children).toEqual([])
    // Detached: attaching again while still marked shown joins at once.
    shown.attachTo(window)
    expect(window.win.children).toEqual([shown.view])
    shown.destroy()
    expect(window.win.children).toEqual([])
  })

  it('moves between windows the way the tab manager moves it: hidden first, in the new window once shown there', () => {
    const { window, inWindow, create } = setup()
    const other = fakeWindow()
    const view = create()
    view.setVisible(true)
    expect(inWindow(view)).toBe(true)
    // `TabManager.claim`: detach, hide, attach to the other window, whose layout shows it.
    view.detach()
    view.setVisible(false)
    view.attachTo(other)
    expect(window.win.children).toEqual([])
    expect(inWindow(view, other)).toBe(false)
    expect(other.chrome.listenerCount('blur')).toBe(1)
    view.setVisible(true)
    expect(inWindow(view, other)).toBe(true)
    // Attaching to the window it is already attached to changes nothing.
    view.attachTo(other)
    expect(other.win.children).toEqual([view.view])
  })

  /** The engine's view as the fakes record it: shown or not, and where. */
  const engine = (view: ElectronTabView): { visible: boolean; bounds: unknown } => {
    const v = view.view as unknown as { getVisible(): boolean; bounds: unknown }
    return { visible: v.getVisible(), bounds: v.bounds }
  }
  /**
   * Where a parked view stands: its box, moved so only one corner pixel of it is inside the
   * window, in the window content's corner (0 bottom-right, 1 bottom-left, 2 top-right, 3
   * top-left; the fake window's content is 1280×820).
   */
  const parkedAt = (b: typeof box, corner = 0, content = [1280, 820]): typeof box => ({
    x: corner % 2 === 0 ? content[0] - 1 : -(b.width - 1),
    y: corner < 2 ? content[1] - 1 : -(b.height - 1),
    width: b.width,
    height: b.height
  })

  it('is parked, not hidden, when chrome UI covers the page: shown to the engine at its size, one pixel inside the window’s corner (W6-F5)', () => {
    const { host, window, create } = setup()
    const view = create()
    const flips: boolean[] = []
    host.onVisibilityChanged((v) => flips.push(v.isVisible()))
    view.setBounds(box)
    view.setVisible(true)
    // The omnibox dropdown opens over the page: the core's layout hides the view.
    window.zen.contentHidden = true
    view.setVisible(false)
    // Hidden to the core – the chrome shows its picture, the snapshot logic and the governor
    // read a page behind – but on screen to Chromium, which keeps prefetching for it.
    expect(view.isVisible()).toBe(false)
    expect(engine(view)).toEqual({ visible: true, bounds: parkedAt(box) })
    expect(flips).toEqual([true, false])
    // The dropdown closes: the layout places the view again, and it is back where it was.
    window.zen.contentHidden = false
    view.setBounds(box)
    view.setVisible(true)
    expect(engine(view)).toEqual({ visible: true, bounds: box })
    expect(flips).toEqual([true, false, true])
  })

  it('takes a new box parked, at the new box’s size in the window’s corner, until the layout shows it', () => {
    const { window, create } = setup()
    const view = create()
    view.setBounds(box)
    view.setVisible(true)
    window.zen.contentHidden = true
    view.setVisible(false)
    // The window shrinks under the cover: the layout speaks of a new box, and the pixel moves
    // with the window's corner.
    window.win.contentSize = [1000, 760]
    const smaller = { x: 0, y: 40, width: 1000, height: 700 }
    view.setBounds(smaller)
    expect(engine(view).bounds).toEqual(parkedAt(smaller, 0, [1000, 760]))
    window.zen.contentHidden = false
    view.setVisible(true)
    expect(engine(view).bounds).toEqual(smaller)
  })

  it('gives each pane of a split parked under the cover its own window corner, so none stands under another’s pixel', () => {
    const { window, create } = setup()
    const panes = [create(), create(), create(), create(), create()]
    const boxes = panes.map((_, i) => ({ x: i * 250, y: 40, width: 240, height: 700 }))
    panes.forEach((pane, i) => {
      pane.setBounds(boxes[i])
      pane.setVisible(true)
    })
    window.zen.contentHidden = true
    for (const pane of panes) pane.setVisible(false)
    // Four corners for four panes; a fifth shares the last.
    expect(panes.map((p) => p.parkedCorner())).toEqual([0, 1, 2, 3, 3])
    expect(engine(panes[1]).bounds).toEqual(parkedAt(boxes[1], 1))
    expect(engine(panes[2]).bounds).toEqual(parkedAt(boxes[2], 2))
    expect(engine(panes[3]).bounds).toEqual(parkedAt(boxes[3], 3))
    // The cover lifts with the first pane closed meanwhile: its corner is free for the next.
    window.zen.contentHidden = false
    panes[0].coverLifted()
    expect(panes[0].parkedCorner()).toBeNull()
    panes.slice(1).forEach((pane, i) => {
      pane.setBounds(boxes[i + 1])
      pane.setVisible(true)
    })
    expect(panes.map((p) => p.parkedCorner())).toEqual([null, null, null, null, null])
    window.zen.contentHidden = true
    panes[4].setVisible(false)
    expect(panes[4].parkedCorner()).toBe(0)
    // Another window's parked view takes no corner of this one's.
    const other = fakeWindow()
    const elsewhere = create(other)
    elsewhere.setBounds(box)
    elsewhere.setVisible(true)
    other.zen.contentHidden = true
    elsewhere.setVisible(false)
    expect(elsewhere.parkedCorner()).toBe(0)
  })

  it('hides the view as before when no chrome covers the page: a tab switch, a chrome page tab, a move between windows', () => {
    const { window, create } = setup()
    const view = create()
    view.setBounds(box)
    view.setVisible(true)
    view.setVisible(false)
    expect(engine(view)).toEqual({ visible: false, bounds: box })
    // A cover on, but this view was never on screen in the window: nothing to keep visible.
    window.zen.contentHidden = true
    const behind = create()
    behind.setBounds(box)
    behind.setVisible(false)
    expect(engine(behind).visible).toBe(false)
    expect(window.win.children).toEqual([view.view])
  })

  it('ends the parking when the cover lifts without the layout showing it (a tab switched away from under the cover), and on detach', () => {
    const { window, create } = setup()
    const view = create()
    view.setBounds(box)
    view.setVisible(true)
    window.zen.contentHidden = true
    view.setVisible(false)
    expect(engine(view).visible).toBe(true)
    // The uncovered layout placed another tab; the window host tells the rest.
    window.zen.contentHidden = false
    view.coverLifted()
    expect(engine(view)).toEqual({ visible: false, bounds: box })
    // Nothing for a view not parked.
    view.coverLifted()
    expect(engine(view).visible).toBe(false)
    view.setVisible(true)
    expect(engine(view)).toEqual({ visible: true, bounds: box })

    // Parked, then taken to another window (`TabManager.claim`): it leaves hidden, so entering
    // the other window for the keyboard does not put a shown view on its screen.
    window.zen.contentHidden = true
    view.setVisible(false)
    expect(engine(view).visible).toBe(true)
    view.detach()
    expect(engine(view)).toEqual({ visible: false, bounds: box })
    const other = fakeWindow()
    view.setVisible(false)
    view.attachTo(other)
    view.focus()
    expect(other.win.children).toEqual([view.view])
    expect(engine(view).visible).toBe(false)
  })

  it('hides a parked view for good when the hide comes with the cover already off', () => {
    const { window, create } = setup()
    const view = create()
    view.setBounds(box)
    view.setVisible(true)
    window.zen.contentHidden = true
    view.setVisible(false)
    // Still covered: hidden again (a `refreshVisibility` pass) stays parked.
    view.setVisible(false)
    expect(engine(view)).toEqual({ visible: true, bounds: parkedAt(box) })
    window.zen.contentHidden = false
    view.setVisible(false)
    expect(engine(view)).toEqual({ visible: false, bounds: box })
  })

  /**
   * Aura tells whatever lies under the pointer of a view hidden or shown under it with a
   * synthesized mouse move, and says nothing of a view moved: the host says it instead. The fake
   * window's content sits at (100, 60) on the screen; the box is 800×560 at (0, 40) in it.
   */
  it('tells the chrome where the pointer is when the view under it is parked, and hands the pointer back to the page when it returns', () => {
    const { window, create } = setup()
    const view = create()
    const page = view.webContents as unknown as { widgetEvents: Array<Record<string, unknown>> }
    view.setBounds(box)
    view.setVisible(true)
    // The pointer over the page, at (300, 200) of the window's content – (300, 160) of the box.
    cursor.x = 400
    cursor.y = 260
    window.zen.contentHidden = true
    view.setVisible(false)
    expect(engine(view).bounds).toEqual(parkedAt(box))
    // The chrome, under the pointer now: a move at the pointer's place, in its own coordinates.
    expect(window.chrome.inputEvents).toEqual([{ type: 'mouseMove', x: 300, y: 200 }])
    expect(page.widgetEvents).toEqual([])
    // The cover lifts: the view is back under the pointer – the chrome hears the pointer leave,
    // the page hears where it stands, in the page's own coordinates.
    window.zen.contentHidden = false
    view.setVisible(true)
    expect(window.chrome.inputEvents).toEqual([
      { type: 'mouseMove', x: 300, y: 200 },
      { type: 'mouseLeave', x: 300, y: 200 }
    ])
    expect(page.widgetEvents).toEqual([{ type: 'mouseMove', x: 300, y: 160 }])
  })

  it('says nothing of the pointer when it is off the page’s box, or a chrome mouse button is down (a tab drag is a cover)', () => {
    const { window, create } = setup()
    const view = create()
    const page = view.webContents as unknown as { widgetEvents: Array<Record<string, unknown>> }
    view.setBounds(box)
    view.setVisible(true)
    // Over the chrome's strip above the box (the box starts 40 down): nothing to say.
    cursor.x = 400
    cursor.y = 80
    window.zen.contentHidden = true
    view.setVisible(false)
    window.zen.contentHidden = false
    view.setVisible(true)
    expect(window.chrome.inputEvents).toEqual([])
    expect(page.widgetEvents).toEqual([])
    // Over the page, but a tab row is being dragged (the button down, the chrome holding the
    // pointer's capture): the moves would have no button in them, so none are sent.
    cursor.y = 260
    window.buttonHeld = true
    window.zen.contentHidden = true
    view.setVisible(false)
    expect(engine(view).bounds).toEqual(parkedAt(box))
    window.zen.contentHidden = false
    view.setVisible(true)
    expect(window.chrome.inputEvents).toEqual([])
    expect(page.widgetEvents).toEqual([])
  })

  it('is quiet for a view whose window is gone', () => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_nowin', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    expect(() => {
      view.setVisible(true)
      view.focus()
      view.bringToFront()
      view.detach()
    }).not.toThrow()
  })
})

/**
 * Agent input goes through the DevTools protocol's Input domain, whose session is held the way
 * the resource governor holds its own: attached for the action, detached once nothing is
 * pending, an existing session used and left alone, and never `Runtime.enable`.
 */
/**
 * The developer tools' dock (design language v2 §9.29): the toolbox opens at the dock the core
 * remembers – Electron's own `bottom` / `right` / `left` / `undocked` modes, never the Browser
 * Console's `detach`, which loses the frontend's dock buttons – and, once its frontend has
 * loaded, is dressed: the seam's hairline and the hook that reads its own dock buttons back.
 */
describe('ElectronTabView and the developer tools dock', () => {
  interface DevtoolsContents {
    devtoolsOpened: Array<Record<string, unknown>>
    inspected: Array<[number, number]>
    devtoolsClosedCount: number
    devToolsWebContents: {
      scripts: string[]
      rejecting: string | null
      emit(event: string, ...args: unknown[]): boolean
    } | null
    isDevToolsOpened(): boolean
  }
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  const setup = (): {
    view: ElectronTabView
    wc: DevtoolsContents
    docks: string[]
    /** The dock each `onDevtoolsOpened` named (undefined where the host could not say). */
    openedAt: Array<string | undefined>
    opened: () => number
    closed: () => number
  } => {
    const docks: string[] = []
    const openedAt: Array<string | undefined> = []
    let opened = 0
    let closed = 0
    const events = new Proxy({} as TabViewEvents, {
      get: (_t, name) => {
        if (name === 'onDevtoolsDockChanged') return (dock: string): void => void docks.push(dock)
        if (name === 'onDevtoolsOpened')
          return (dock?: string): void => {
            opened++
            openedAt.push(dock)
          }
        if (name === 'onDevtoolsClosed') return (): void => void closed++
        return (): undefined => undefined
      }
    })
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_devtools', containerId: 'default' } as Tab,
      events,
      detachedWindow
    ) as ElectronTabView
    const wc = view.webContents as unknown as DevtoolsContents
    return { view, wc, docks, openedAt, opened: () => opened, closed: () => closed }
  }

  it('opens at the remembered dock with Electron’s own mode names, and toggles closed', () => {
    for (const dock of ['bottom', 'right', 'left', 'undocked'] as const) {
      const { view, wc } = setup()
      view.openDevTools('toggle', dock)
      expect(wc.devtoolsOpened).toEqual([{ mode: dock, activate: true }])
      expect(wc.isDevToolsOpened()).toBe(true)
      view.openDevTools('toggle', dock)
      expect(wc.isDevToolsOpened()).toBe(false)
      expect(wc.devtoolsClosedCount).toBe(1)
    }
  })

  it('never opens a tab’s toolbox detached: that mode is the Browser Console’s', () => {
    const { view, wc } = setup()
    view.openDevTools('console', 'undocked')
    view.openDevTools('inspect', 'right')
    for (const call of wc.devtoolsOpened) expect(call.mode).not.toBe('detach')
  })

  it('inspects the clicked node at the dock when the toolbox was closed, in place when it is up', () => {
    const { view, wc } = setup()
    view.inspectElementAt(333, 44, 'right')
    expect(wc.devtoolsOpened).toEqual([{ mode: 'right', activate: true }])
    expect(wc.inspected).toEqual([[333, 44]])
    view.inspectElementAt(5, 6, 'bottom')
    // Up already: no second opening (which would move it), the node alone.
    expect(wc.devtoolsOpened).toHaveLength(1)
    expect(wc.inspected).toEqual([
      [333, 44],
      [5, 6]
    ])
    // The element picker from the chord opens the toolbox at the dock and picks from the corner.
    const chord = setup()
    chord.view.openDevTools('inspect', 'bottom')
    expect(chord.wc.devtoolsOpened).toEqual([{ mode: 'bottom', activate: true }])
    expect(chord.wc.inspected).toEqual([[0, 0]])
  })

  it('dresses the frontend once it has loaded – the seam’s hairline and the dock hook – and tells the core the toolbox’s opening', async () => {
    const { view, wc, opened } = setup()
    view.openDevTools('toggle', 'bottom')
    expect(opened()).toBe(0)
    await settle()
    expect(opened()).toBe(1)
    const scripts = wc.devToolsWebContents!.scripts
    expect(scripts.some((s) => s.includes('setIsDocked'))).toBe(true)
    expect(scripts.some((s) => s.includes('zenium-seam'))).toBe(true)
    // The hairline is the chrome's `--v2-border`, light and dark, and nothing wider than the
    // split widget's sidebar border is touched.
    const seam = scripts.find((s) => s.includes('zenium-seam'))!
    expect(seam).toContain('rgb(0 0 0 / 0.15)')
    expect(seam).toContain('rgb(255 255 255 / 0.12)')
    expect(seam).toContain('.shadow-split-widget-sidebar')
  })

  it('reads the toolbox’s own dock buttons back from its console and hands the dock to the core', async () => {
    const { view, wc, docks } = setup()
    view.openDevTools('toggle', 'bottom')
    await settle()
    const frontend = wc.devToolsWebContents!
    frontend.emit('console-message', { message: 'zenium-devtools-dock:right' })
    frontend.emit('console-message', { message: 'Request Autofill.enable failed.' })
    frontend.emit('console-message', { message: 'zenium-devtools-dock:undocked' })
    frontend.emit('console-message', { message: 'zenium-devtools-dock:sideways' })
    expect(docks).toEqual(['right', 'undocked'])
  })

  it('names the dock each view’s toolbox opened at, and the one it stands at once moved – per view, not one for all', async () => {
    // Tab A's toolbox at the bottom, tab B's undocked: each view reports its own.
    const a = setup()
    const b = setup()
    a.view.openDevTools('toggle', 'bottom')
    b.view.openDevTools('toggle', 'undocked')
    await settle()
    expect(a.openedAt).toEqual(['bottom'])
    expect(b.openedAt).toEqual(['undocked'])
    // B's own button docks it to the left: B's reading moves, A's stands.
    b.wc.devToolsWebContents!.emit('console-message', { message: 'zenium-devtools-dock:left' })
    expect(b.docks).toEqual(['left'])
    expect(a.docks).toEqual([])
    // Closed and opened again at another dock, A names the new one.
    a.view.openDevTools('toggle', 'bottom')
    expect(a.closed()).toBe(1)
    a.view.openDevTools('toggle', 'right')
    await settle()
    expect(a.openedAt).toEqual(['bottom', 'right'])
    // The element picker opens at its dock and names it too.
    const c = setup()
    c.view.inspectElementAt(10, 20, 'left')
    await settle()
    expect(c.openedAt).toEqual(['left'])
    // A move the menu asked for is the view's reading at once, before the frontend's read-back.
    const d = setup()
    d.view.openDevTools('toggle', 'bottom')
    await settle()
    d.view.setDevtoolsDock('right')
    await settle()
    // The frontend without the module: closed and reopened at the dock – the reopening names it.
    d.wc.devToolsWebContents!.rejecting = 'DockController'
    d.view.setDevtoolsDock('undocked')
    await settle()
    await settle()
    expect(d.openedAt).toEqual(['bottom', 'undocked'])
  })

  it('moves an open toolbox through the frontend’s own dock controller, and reopens at the dock when the frontend cannot – with a line on the log naming the tab and the dock', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { view, wc, closed } = setup()
      view.openDevTools('toggle', 'bottom')
      await settle()
      const frontend = wc.devToolsWebContents!
      view.setDevtoolsDock('right')
      await settle()
      const move = frontend.scripts.at(-1)!
      expect(move).toContain('DockController')
      expect(move).toContain('"right"')
      expect(closed()).toBe(0)
      expect(wc.devtoolsOpened).toHaveLength(1)
      // The happy path is silent: the frontend took the move.
      expect(warn).not.toHaveBeenCalled()

      // A frontend without the module: the toolbox is closed and reopened at the dock instead,
      // and the log says which tab's toolbox blinked, at which dock, and why.
      frontend.rejecting = 'DockController'
      view.setDevtoolsDock('undocked')
      await settle()
      await settle()
      expect(closed()).toBe(1)
      expect(wc.devtoolsOpened.at(-1)).toEqual({ mode: 'undocked', activate: true })
      expect(wc.isDevToolsOpened()).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]![0])
      expect(line).toContain('[zen] devtools:')
      expect(line).toContain('tab_devtools')
      expect(line).toContain('at undocked')
      expect(line).toContain('module not found')

      // Nothing to move while the toolbox is closed – and nothing on the log.
      const idle = setup()
      idle.view.setDevtoolsDock('right')
      expect(idle.wc.devtoolsOpened).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

/*
 * "Hold ⌘Q to quit" and a toolbox (#486's R2, design language v2 §9.23: the notice is drawn
 * where the keyboard is). The chord relayed from a page's toolbox is reported to the held-key
 * notice with the toolbox's window and dock; while the chord is down in a toolbox standing
 * undocked, the page's own panel is not posted – the toolbox draws it (`devtoolsKeys.ts`) – and
 * a docked toolbox changes nothing.
 */
describe('ElectronTabView and the held-key notice over a toolbox', () => {
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  const KEY_DOWN_LINE =
    'zenium-devtools-key:{"type":"keyDown","key":"q","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}'
  const KEY_UP_LINE =
    'zenium-devtools-key:{"type":"keyUp","key":"Meta","control":false,"alt":false,"shift":false,"meta":false,"isAutoRepeat":false}'
  const panel: QuitHoldPanel = {
    startedAt: 10_000,
    durationMs: 1500,
    chord: '⌘Q',
    dark: false,
    accent: '#3366cc'
  }
  interface HoldContents {
    sent: Array<{ channel: string; args: unknown[] }>
    devToolsWebContents: {
      scripts: string[]
      mainFrame: object
      emit(event: string, ...args: unknown[]): boolean
    } | null
  }
  const setup = (): {
    view: ElectronTabView
    wc: HoldContents
    win: FakeBrowserWindow
    notice: DevtoolsQuitHoldNotice
    keys: string[]
    /** The toolbox's frontend says `line` from its own document. */
    say(line: string): void
  } => {
    const keys: string[] = []
    const events = new Proxy({} as TabViewEvents, {
      get: (_t, name) => {
        if (name === 'onKey')
          return (key: { type: string; key: string }): void =>
            void keys.push(`${key.type}:${key.key}`)
        return (): undefined => undefined
      }
    })
    const host = new ElectronTabViewHost(sessions)
    const notice = new DevtoolsQuitHoldNotice((p) => (p ? `shown:${p.startedAt}` : 'down'))
    host.quitHoldNotice = notice
    const window = fakeWindow()
    const view = host.createView(
      { id: 'tab_hold', containerId: 'default' } as Tab,
      events,
      window
    ) as ElectronTabView
    const wc = view.webContents as unknown as HoldContents
    return {
      view,
      wc,
      win: window.win,
      notice,
      keys,
      say: (line) => {
        const frontend = wc.devToolsWebContents!
        frontend.emit('console-message', { message: line, frame: frontend.mainFrame })
      }
    }
  }
  const posted = (wc: HoldContents): unknown[] =>
    wc.sent.filter((m) => m.channel === 'zen:quit-hold').map((m) => m.args[0])

  it('posts the panel and its way down to the page while no toolbox has the chord', () => {
    const { view, wc } = setup()
    view.showQuitHold(panel)
    view.showQuitHold(null)
    expect(posted(wc)).toEqual([panel, null])
  })

  it('the chord down in the page’s undocked toolbox: the key reaches the tab, the toolbox is marked, the page’s panel yields and the toolbox draws the hold from the window’s state', async () => {
    const { view, wc, win, notice, keys, say } = setup()
    view.openDevTools('toggle', 'undocked')
    await settle()
    say(KEY_DOWN_LINE)
    expect(keys).toEqual(['keyDown:q'])
    expect(notice.inToolbox()).toBe(true)
    view.showQuitHold(panel)
    expect(posted(wc)).toEqual([])
    // The window's state stream, as `ElectronWindow.send` mirrors it: the toolbox is this window's.
    notice.mirror(win, panel)
    expect(wc.devToolsWebContents!.scripts.at(-1)).toBe('shown:10000')
    notice.mirror({}, panel)
    expect(wc.devToolsWebContents!.scripts.at(-1)).toBe('shown:10000')
    // The key up: the hold's way down goes to the page (nothing stood there) and to the toolbox.
    say(KEY_UP_LINE)
    expect(keys).toEqual(['keyDown:q', 'keyUp:Meta'])
    expect(notice.inToolbox()).toBe(false)
    view.showQuitHold(null)
    expect(posted(wc)).toEqual([null])
    notice.mirror(win, null)
    expect(wc.devToolsWebContents!.scripts.at(-1)).toBe('down')
  })

  it('a docked toolbox changes nothing: the chord down there, the page draws its panel as before', async () => {
    const { view, wc, win, notice, say } = setup()
    view.openDevTools('toggle', 'bottom')
    await settle()
    say(KEY_DOWN_LINE)
    expect(notice.inToolbox()).toBe(false)
    view.showQuitHold(panel)
    expect(posted(wc)).toEqual([panel])
    notice.mirror(win, panel)
    expect(wc.devToolsWebContents!.scripts.some((s) => s.startsWith('shown:'))).toBe(false)
    say(KEY_UP_LINE)
    // Undocked by its own button (the console read-back), the next hold is the toolbox's.
    say('zenium-devtools-dock:undocked')
    say(KEY_DOWN_LINE)
    expect(notice.inToolbox()).toBe(true)
    view.showQuitHold({ ...panel, startedAt: 12_000 })
    expect(posted(wc)).toEqual([panel])
    say(KEY_UP_LINE)
  })
})

describe('ElectronTabView.sendInput and the DevTools session', () => {
  interface FakeDebug {
    attached: boolean
    taken: boolean
    log: string[]
  }
  /** The page as `sendInput` probes it: the frame's paint answers and how often it was asked. */
  interface FakePaint {
    paintAnswers: string[]
    paintProbes: string[]
    emit(event: string, ...args: unknown[]): boolean
  }
  const viewWithDebugger = (): {
    view: ElectronTabView
    dbg: FakeDebug
    widget: unknown[]
    page: FakePaint
  } => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_agent', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = view.webContents as unknown as {
      debugger: FakeDebug
      widgetEvents: unknown[]
    } & FakePaint
    return { view, dbg: wc.debugger, widget: wc.widgetEvents, page: wc }
  }
  const CLICK: AgentInputEvent = {
    type: 'click',
    x: 10,
    y: 20,
    button: 'left',
    clickCount: 1,
    modifiers: []
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('attaches for the action and detaches right after it, sending only Input commands', async () => {
    const { view, dbg, widget } = viewWithDebugger()
    await view.sendInput({
      type: 'click',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
      modifiers: []
    })
    expect(dbg.log).toEqual([
      'attach',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'detach'
    ])
    expect(dbg.attached).toBe(false)
    expect(widget).toEqual([])
    await view.sendInput({ type: 'key', key: 'Enter', modifiers: [] })
    expect(dbg.log.slice(5)).toEqual([
      'attach',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'detach'
    ])
    expect(dbg.log).not.toContain('Runtime.enable')
  })

  it('holds one session across overlapping actions and lets go when the last one ends', async () => {
    const { view, dbg } = viewWithDebugger()
    await Promise.all([
      view.sendInput({ type: 'mouseMove', x: 1, y: 1 }),
      view.sendInput({ type: 'click', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: [] }),
      view.sendInput({ type: 'text', text: 'hi' })
    ])
    expect(dbg.log.filter((e) => e === 'attach')).toHaveLength(1)
    expect(dbg.log.filter((e) => e === 'detach')).toHaveLength(1)
    expect(dbg.log[0]).toBe('attach')
    expect(dbg.log[dbg.log.length - 1]).toBe('detach')
    expect(dbg.attached).toBe(false)
  })

  it("uses a session another client holds and leaves it in place (the governor's overrides)", async () => {
    const { view, dbg } = viewWithDebugger()
    dbg.attached = true
    await view.sendInput({ type: 'mouseMove', x: 5, y: 5 })
    expect(dbg.log).toEqual(['Input.dispatchMouseEvent'])
    expect(dbg.attached).toBe(true)
  })

  it('falls back to the main-frame widget when the page cannot be attached (DevTools open)', async () => {
    const { view, dbg, widget } = viewWithDebugger()
    dbg.taken = true
    await view.sendInput({
      type: 'click',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
      modifiers: []
    })
    expect(dbg.log).toEqual([])
    expect(widget.map((e) => (e as { type: string }).type)).toEqual([
      'mouseMove',
      'mouseDown',
      'mouseUp'
    ])
    // The failed attempt leaves nothing pending: the next action attaches normally.
    dbg.taken = false
    await view.sendInput({ type: 'mouseMove', x: 1, y: 1 })
    expect(dbg.log).toEqual(['attach', 'Input.dispatchMouseEvent', 'detach'])
  })

  /**
   * Paint holding (in-house fix, row 3): before a new http(s) document's first paint the
   * renderer drops presses and keys with a success ack. `sendInput` waits for the paint on
   * both its paths – the DevTools protocol's and the widget fallback's – bounded, and moves
   * go at once (they are never dropped).
   */
  it('holds a click on the CDP path until the page has painted, then sends it; the painted document is not asked again', async () => {
    const { view, dbg, page } = viewWithDebugger()
    page.paintAnswers = ['holding', 'holding', 'painted']
    let sent = false
    const click = view.sendInput(CLICK).then(() => {
      sent = true
    })
    await new Promise((r) => setTimeout(r, 5))
    // Asked, holding: nothing has gone to the page yet.
    expect(page.paintProbes.length).toBeGreaterThanOrEqual(1)
    expect(dbg.log).toEqual([])
    expect(sent).toBe(false)
    await click
    expect(page.paintProbes).toHaveLength(3)
    expect(dbg.log).toEqual([
      'attach',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'detach'
    ])
    // The next key on the same document costs no probe.
    await view.sendInput({ type: 'key', key: 'Enter', modifiers: [] })
    expect(page.paintProbes).toHaveLength(3)
    expect(dbg.log.slice(5)).toEqual([
      'attach',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'detach'
    ])
    // A new document is asked in its own right.
    page.emit('did-start-navigation', {
      url: 'https://b.example/',
      isMainFrame: true,
      isSameDocument: false
    })
    page.paintAnswers = ['painted']
    await view.sendInput({ type: 'text', text: 'hi' })
    expect(page.paintProbes).toHaveLength(4)
  })

  it('holds a click on the widget fallback the same way, and sends the sequence whole once painted', async () => {
    const { view, dbg, widget, page } = viewWithDebugger()
    dbg.taken = true
    page.paintAnswers = ['holding', 'painted']
    const click = view.sendInput(CLICK)
    await new Promise((r) => setTimeout(r, 5))
    expect(widget).toEqual([])
    await click
    expect(page.paintProbes).toHaveLength(2)
    expect(widget.map((e) => (e as { type: string }).type)).toEqual([
      'mouseMove',
      'mouseDown',
      'mouseUp'
    ])
  })

  it('lets a bare mouse move through without asking: moves are never dropped', async () => {
    const { view, dbg, page } = viewWithDebugger()
    page.paintAnswers = ['holding']
    await view.sendInput({ type: 'mouseMove', x: 3, y: 4 })
    expect(page.paintProbes).toEqual([])
    expect(dbg.log).toEqual(['attach', 'Input.dispatchMouseEvent', 'detach'])
  })

  it('sends anyway after the deadline, with one warning, when the page never paints', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { view, dbg, page } = viewWithDebugger()
      page.paintAnswers = ['holding']
      let sent = false
      void view.sendInput({ type: 'key', key: 'a', modifiers: [] }).then(() => {
        sent = true
      })
      await vi.advanceTimersByTimeAsync(9_900)
      expect(dbg.log).toEqual([])
      expect(sent).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(dbg.log).toEqual([
        'attach',
        'Input.dispatchKeyEvent',
        'Input.dispatchKeyEvent',
        'detach'
      ])
      expect(sent).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('has not painted after 10 s')
    } finally {
      warn.mockRestore()
    }
  })

  it('reads the paint state for hasPainted from the same place, and answers yes when unsure', async () => {
    const { view, page } = viewWithDebugger()
    page.paintAnswers = ['holding']
    expect(await view.hasPainted()).toBe(false)
    page.paintAnswers = ['loading']
    expect(await view.hasPainted()).toBe(false)
    page.paintAnswers = ['ready']
    expect(await view.hasPainted()).toBe(true)
    // Known now: a later ask costs no probe.
    const probes = page.paintProbes.length
    expect(await view.hasPainted()).toBe(true)
    expect(page.paintProbes).toHaveLength(probes)
    view.destroy()
    expect(await view.hasPainted()).toBe(true)
  })
})

/**
 * The page fonts (Settings › Appearance › Customize fonts, CT-25): every new page is made with
 * the setting in its web preferences; a page already open takes a change over the DevTools
 * protocol where its debugger is free, and keeps its floor (no protocol command) until its
 * contents are remade.
 */
describe('page fonts (CT-25)', () => {
  interface FakeDebug {
    attached: boolean
    taken: boolean
    log: string[]
    commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
  }
  const FONTS: PageFontSettings = {
    standard: 'Georgia',
    serif: null,
    sansSerif: 'Inter',
    fixed: null,
    size: 20,
    minimumSize: 12
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 2))
  }
  const page = (
    host: ElectronTabViewHost,
    id: string
  ): { view: ElectronTabView; dbg: FakeDebug; prefs: Record<string, unknown> } => {
    constructed.length = 0
    const view = host.createView(
      { id, containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = view.webContents as unknown as { debugger: FakeDebug }
    return {
      view,
      dbg: wc.debugger,
      prefs: (constructed[0] as { webPreferences: Record<string, unknown> }).webPreferences
    }
  }
  const sent = (dbg: FakeDebug, method: string): Array<Record<string, unknown> | undefined> =>
    dbg.commands.filter((c) => c.method === method).map((c) => c.params)

  afterEach(() => {
    const host = new ElectronTabViewHost(sessions)
    host.applyFonts(DEFAULT_FONT_SETTINGS)
    host.applyExtensionFonts(null)
  })

  it('makes a new page with the engine’s own fonts until the core says otherwise', () => {
    const host = new ElectronTabViewHost(sessions)
    const { prefs } = page(host, 'tab_fonts_default')
    expect(prefs.defaultFontFamily).toEqual({})
    expect(prefs.defaultFontSize).toBe(16)
    expect(prefs.defaultMonospaceFontSize).toBe(13)
    expect(prefs.minimumFontSize).toBe(0)
    expect(ElectronTabViewHost.currentFonts()).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('makes every page after a change with the setting in its web preferences, families chosen only', () => {
    const host = new ElectronTabViewHost(sessions)
    host.applyFonts(FONTS)
    const { prefs, dbg } = page(host, 'tab_fonts_new')
    expect(prefs.defaultFontFamily).toEqual({ standard: 'Georgia', sansSerif: 'Inter' })
    expect(prefs.defaultFontSize).toBe(20)
    // Chrome's fixed-width size rides along: 13 for 16, so 16 for 20.
    expect(prefs.defaultMonospaceFontSize).toBe(16)
    expect(prefs.minimumFontSize).toBe(12)
    // A page made with the setting has nothing to take live.
    expect(dbg.log).toEqual([])
  })

  it('brings an open page to the setting over its own DevTools session and lets go', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { dbg } = page(host, 'tab_fonts_live')
    host.applyFonts(FONTS)
    await settle()
    expect(dbg.log).toEqual(['attach', 'Page.setFontFamilies', 'Page.setFontSizes', 'detach'])
    expect(dbg.attached).toBe(false)
    // Only the chosen slots are named: the serif and fixed faces stay exactly the engine's.
    expect(sent(dbg, 'Page.setFontFamilies')).toEqual([
      { fontFamilies: { standard: 'Georgia', sansSerif: 'Inter' } }
    ])
    expect(sent(dbg, 'Page.setFontSizes')).toEqual([{ fontSizes: { standard: 20, fixed: 16 } }])
    // The same setting again is nothing to send.
    host.applyFonts({ ...FONTS })
    await settle()
    expect(dbg.log).toHaveLength(4)
  })

  it('sends the sizes alone when only the size moved, and takes families back to the engine’s own', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { dbg } = page(host, 'tab_fonts_size')
    host.applyFonts({ ...DEFAULT_FONT_SETTINGS, size: 24 })
    await settle()
    expect(dbg.log).toEqual(['attach', 'Page.setFontSizes', 'detach'])
    expect(sent(dbg, 'Page.setFontSizes')).toEqual([{ fontSizes: { standard: 24, fixed: 20 } }])
    host.applyFonts({ ...DEFAULT_FONT_SETTINGS, size: 24, fixed: 'Fira Code' })
    await settle()
    // A family with the sizes as they were: the document is asked to restyle once the commands are in.
    expect(dbg.log.slice(3)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach',
      'restyle'
    ])
    expect(sent(dbg, 'Page.setFontFamilies').at(-1)).toEqual({
      fontFamilies: { fixed: 'Fira Code' }
    })
    host.applyFonts({ ...DEFAULT_FONT_SETTINGS, size: 24 })
    await settle()
    // Back to the engine's own monospace by its name for this OS (the protocol has no "unset");
    // a fresh agent each time, so "once" never bites.
    expect(sent(dbg, 'Page.setFontFamilies').at(-1)).toEqual({
      fontFamilies: { fixed: electronFontDefaults(process.platform).fixed }
    })
    expect(dbg.log.slice(8)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach',
      'restyle'
    ])
    expect(dbg.attached).toBe(false)
  })

  it('asks the open document to restyle after a family change alone, in the preload’s world, never for a size', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { view, dbg } = page(host, 'tab_fonts_restyle')
    const wc = view.webContents as unknown as {
      isolatedScripts: Array<{ worldId: number; code: string }>
    }
    // Sizes moved (with a family): Blink restyles on its own, nothing is asked.
    host.applyFonts(FONTS)
    await settle()
    expect(dbg.log).toEqual(['attach', 'Page.setFontFamilies', 'Page.setFontSizes', 'detach'])
    expect(wc.isolatedScripts).toEqual([])
    // A family alone: the registration of an unused custom property, in the isolated world.
    host.applyFonts({ ...FONTS, standard: 'Palatino' })
    await settle()
    expect(dbg.log.slice(4)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach',
      'restyle'
    ])
    expect(wc.isolatedScripts).toEqual([{ worldId: 999, code: FONT_RESTYLE_SCRIPT }])
    expect(FONT_RESTYLE_SCRIPT).toContain('CSS.registerProperty')
    expect(FONT_RESTYLE_SCRIPT).toContain("'--zenium-fonts-'")
    // No family moved: the sizes go out as ever and nothing is asked.
    host.applyFonts({ ...FONTS, standard: 'Palatino', minimumSize: 0 })
    await settle()
    expect(dbg.log.slice(9)).toEqual(['attach', 'Page.setFontSizes', 'detach'])
    expect(wc.isolatedScripts).toHaveLength(1)
  })

  it('leaves a page an extension’s chrome.debugger holds alone, and tries again on its next load', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { view, dbg } = page(host, 'tab_fonts_held')
    const id = (view.webContents as unknown as { id: number }).id
    dbg.attached = true
    addForeignDebuggerOwner(id)
    host.applyFonts(FONTS)
    await settle()
    expect(dbg.log).toEqual([])
    // The extension detached; the page navigates: the new document is brought to the setting.
    removeForeignDebuggerOwner(id)
    dbg.attached = false
    ;(view.webContents as unknown as EventEmitter).emit('did-navigate', {}, 'https://a.example/')
    await settle()
    expect(dbg.log).toEqual(['attach', 'Page.setFontFamilies', 'Page.setFontSizes', 'detach'])
  })

  it('sends a live change again when a navigation moved the page to another renderer with no session on it', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { view, dbg } = page(host, 'tab_fonts_swap')
    const wc = view.webContents as unknown as EventEmitter & { pid: number }
    host.applyFonts(FONTS)
    await settle()
    expect(dbg.log).toHaveLength(4)
    // The same renderer keeps the page's settings across the document: nothing to send.
    wc.emit('did-navigate', {}, 'https://a.example/next')
    await settle()
    expect(dbg.log).toHaveLength(4)
    // Another renderer starts from the web preferences the page was made with.
    wc.pid = 2000
    wc.emit('did-navigate', {}, 'https://b.example/')
    await settle()
    expect(dbg.log.slice(4)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach'
    ])
    // With a session attached across the swap the agent restored its own state: nothing to send.
    dbg.attached = true
    wc.pid = 3000
    wc.emit('did-navigate', {}, 'https://c.example/')
    await settle()
    expect(dbg.log).toHaveLength(8)
  })

  it('shares the session the resource governor holds, and recycles it for a second family change', async () => {
    const recycled: number[] = []
    // The governor's lifecycle: drop the session, put its own overrides back on a new one.
    setDebuggerRecycler(async (wc) => {
      recycled.push(wc.id)
      wc.debugger.detach()
      wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Emulation.setHardwareConcurrencyOverride', {
        hardwareConcurrency: 2
      })
    })
    try {
      const host = new ElectronTabViewHost(sessions)
      const { dbg } = page(host, 'tab_fonts_governed')
      dbg.attached = true
      host.applyFonts(FONTS)
      await settle()
      // Sent on the governor's session, which stays.
      expect(dbg.log).toEqual(['Page.setFontFamilies', 'Page.setFontSizes'])
      expect(dbg.attached).toBe(true)
      expect(recycled).toEqual([])
      host.applyFonts({ ...FONTS, standard: 'Palatino' })
      await settle()
      // "Font families can only be set once" on the agent: a fresh one through the governor.
      expect(dbg.log.slice(2)).toEqual([
        'Page.setFontFamilies',
        'detach',
        'attach',
        'Emulation.setHardwareConcurrencyOverride',
        'Page.setFontFamilies',
        'Page.setFontSizes',
        'restyle'
      ])
      expect(recycled).toHaveLength(1)
      // The slot that moved, on the new agent (the other choice already stands in the settings).
      expect(sent(dbg, 'Page.setFontFamilies').at(-1)).toEqual({
        fontFamilies: { standard: 'Palatino' }
      })
      expect(dbg.attached).toBe(true)
    } finally {
      setDebuggerRecycler(null)
    }
  })

  it('reattaches for itself when the recycled session had nothing of the governor’s to come back for', async () => {
    const { nativeTheme } = await import('electron')
    const theme = nativeTheme as unknown as { shouldUseDarkColors: boolean }
    theme.shouldUseDarkColors = true
    try {
      const host = new ElectronTabViewHost(sessions)
      const { view, dbg } = page(host, 'tab_fonts_dark')
      // The dark theme for sites holds the session (its override is the session's).
      view.setDarkening(true)
      await settle()
      expect(dbg.log).toEqual(['attach', 'Emulation.setAutoDarkModeOverride'])
      host.applyFonts(FONTS)
      await settle()
      host.applyFonts({ ...FONTS, standard: 'Palatino' })
      await settle()
      expect(dbg.log.slice(2)).toEqual([
        'Page.setFontFamilies',
        'Page.setFontSizes',
        'Page.setFontFamilies',
        'detach',
        'attach',
        'Emulation.setAutoDarkModeOverride',
        'Page.setFontFamilies',
        'Page.setFontSizes',
        'restyle'
      ])
      // The hold keeps the (new) session; it goes when the hold ends.
      expect(dbg.attached).toBe(true)
      view.setDarkening(false)
      await settle()
      expect(dbg.attached).toBe(false)
    } finally {
      theme.shouldUseDarkColors = false
    }
  })

  it('sends a live change again after the engine re-read the page’s web preferences (a scheme flip)', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { dbg } = page(host, 'tab_fonts_flip')
    host.applyFonts(FONTS)
    await settle()
    expect(dbg.log).toHaveLength(4)
    const { nativeTheme } = await import('electron')
    ;(nativeTheme as unknown as EventEmitter).emit('updated')
    await settle()
    // The flip took the page back to the fonts it was made with: the setting goes out again.
    expect(dbg.log.slice(4)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach'
    ])
    // A page made with the setting has nothing to re-send after a flip.
    const made = page(host, 'tab_fonts_flip_made')
    ;(nativeTheme as unknown as EventEmitter).emit('updated')
    await settle()
    expect(made.dbg.log).toEqual([])
  })

  // --- the extensions' layer (chrome.fontSettings) ---------------------------------

  const LAYER: ExtensionFontLayer = {
    families: { standard: 'Verdana', cursive: 'Zapfino', math: 'STIX Two Math' },
    scripts: { Jpan: { sansSerif: 'Noto Sans JP' } },
    sizes: { standard: 24, minimum: 10 }
  }

  it('makes a new page with the extensions’ layer over the setting, the user’s setting untouched', () => {
    const host = new ElectronTabViewHost(sessions)
    host.applyFonts(FONTS)
    host.applyExtensionFonts(LAYER)
    const { prefs, dbg } = page(host, 'tab_ext_fonts_new')
    // The layer's standard over the user's Georgia; the user's Inter stands; the extras named.
    expect(prefs.defaultFontFamily).toEqual({
      standard: 'Verdana',
      sansSerif: 'Inter',
      cursive: 'Zapfino',
      math: 'STIX Two Math'
    })
    expect(prefs.defaultFontSize).toBe(24)
    // Chrome's fixed-width size is a pref of its own: the user's 20 keeps its 16.
    expect(prefs.defaultMonospaceFontSize).toBe(16)
    expect(prefs.minimumFontSize).toBe(10)
    expect(ElectronTabViewHost.currentFonts()).toEqual(FONTS)
    // Web preferences carry no per-script family: the page takes it once its first load commits.
    expect(dbg.log).toEqual([])
  })

  it('brings an open page to the layer, per script too, and takes it back when the layer goes', async () => {
    const host = new ElectronTabViewHost(sessions)
    host.applyFonts(FONTS)
    const { dbg } = page(host, 'tab_ext_fonts_live')
    host.applyExtensionFonts(LAYER)
    await settle()
    expect(dbg.log).toEqual(['attach', 'Page.setFontFamilies', 'Page.setFontSizes', 'detach'])
    expect(sent(dbg, 'Page.setFontFamilies')).toEqual([
      {
        fontFamilies: { standard: 'Verdana', cursive: 'Zapfino', math: 'STIX Two Math' },
        forScripts: [{ script: 'Jpan', fontFamilies: { sansSerif: 'Noto Sans JP' } }]
      }
    ])
    expect(sent(dbg, 'Page.setFontSizes')).toEqual([{ fontSizes: { standard: 24, fixed: 16 } }])
    // A layer with the extension's fixed-width size: the sizes alone move.
    host.applyExtensionFonts({ ...LAYER, sizes: { ...LAYER.sizes, fixed: 11 } })
    await settle()
    expect(dbg.log.slice(4)).toEqual(['attach', 'Page.setFontSizes', 'detach'])
    expect(sent(dbg, 'Page.setFontSizes').at(-1)).toEqual({
      fontSizes: { standard: 24, fixed: 11 }
    })
    // The layer goes: the user's own standard, the engine's cursive and math by name, the
    // script's slot taken back with '' (Blink erases the entry: the common family again).
    host.applyExtensionFonts(null)
    await settle()
    expect(dbg.log.slice(7)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach'
    ])
    const defaults = electronGenericFontDefaults(process.platform)
    expect(sent(dbg, 'Page.setFontFamilies').at(-1)).toEqual({
      fontFamilies: { standard: 'Georgia', cursive: defaults.cursive, math: defaults.math },
      forScripts: [{ script: 'Jpan', fontFamilies: { sansSerif: '' } }]
    })
    expect(sent(dbg, 'Page.setFontSizes').at(-1)).toEqual({
      fontSizes: { standard: 20, fixed: 16 }
    })
  })

  it('keeps the layer’s slots over a change of the setting; the layer never reaches the setting', async () => {
    const host = new ElectronTabViewHost(sessions)
    host.applyExtensionFonts({ families: { standard: 'Verdana' }, scripts: {}, sizes: {} })
    const { dbg } = page(host, 'tab_ext_fonts_user')
    // The user picks a standard and a serif: the standard stays the extension's on the page.
    host.applyFonts({ ...DEFAULT_FONT_SETTINGS, standard: 'Inter', serif: 'Lora' })
    await settle()
    expect(sent(dbg, 'Page.setFontFamilies')).toEqual([{ fontFamilies: { serif: 'Lora' } }])
    expect(ElectronTabViewHost.currentFonts()).toMatchObject({ standard: 'Inter' })
    // A new page too.
    const made = page(host, 'tab_ext_fonts_user_new')
    expect(made.prefs.defaultFontFamily).toEqual({ standard: 'Verdana', serif: 'Lora' })
    host.applyFonts(DEFAULT_FONT_SETTINGS)
    expect(ElectronTabViewHost.currentFonts()).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('takes a per-script family to a page made under the layer once its first load commits', async () => {
    const host = new ElectronTabViewHost(sessions)
    host.applyExtensionFonts(LAYER)
    const { view, dbg } = page(host, 'tab_ext_fonts_script')
    expect(dbg.log).toEqual([])
    ;(view.webContents as unknown as EventEmitter).emit('did-navigate', {}, 'https://a.example/')
    await settle()
    // The common slots were made into the page; the script's family alone goes over the
    // protocol, and the document is asked to restyle (a family alone, no size moved).
    expect(dbg.log).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach',
      'restyle'
    ])
    expect(sent(dbg, 'Page.setFontFamilies')).toEqual([
      {
        fontFamilies: {},
        forScripts: [{ script: 'Jpan', fontFamilies: { sansSerif: 'Noto Sans JP' } }]
      }
    ])
    // The next document in the same renderer keeps it: nothing to send.
    ;(view.webContents as unknown as EventEmitter).emit('did-navigate', {}, 'https://a.example/b')
    await settle()
    expect(dbg.log).toHaveLength(5)
  })
})

/**
 * A link dropped on a page's content area navigates the page, as Chrome's does (dnd-13): the
 * preference is Electron's `navigateOnDragDrop`, off by default, and it reaches Blink – a
 * synthesised (CDP `Input.dispatchDragEvent`) drop is accepted with it on and refused with it
 * off, though only a real OS drop runs the navigation itself. The W5-11 drive can therefore read
 * the browser's accept signal and no more; this pins the wiring so it cannot go quietly.
 */
describe('page web preferences', () => {
  const prefsOf = (tabId: string, host = new ElectronTabViewHost(sessions)): WebPreferences => {
    constructed.length = 0
    host.createView({ id: tabId, containerId: 'default' } as Tab, noEvents, detachedWindow)
    return (constructed[0] as { webPreferences: WebPreferences }).webPreferences
  }

  it('makes every page view with `navigateOnDragDrop` on, the popup’s adopted page included', async () => {
    const host = new ElectronTabViewHost(sessions)
    expect(prefsOf('tab_dnd', host).navigateOnDragDrop).toBe(true)
    // The page Chromium made for a `window.open`, given the tab page preferences on adoption.
    const opener = host.createView(
      { id: 'tab_dnd_opener', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const guest = await guestWebContents()
    constructed.length = 0
    host.openTicket(
      {
        action: 'window',
        url: 'https://example.com/',
        adopt: () => ({
          tab: { id: 'tab_dnd_popup', containerId: 'default' } as Tab,
          events: noEvents
        })
      },
      opener,
      guest,
      {}
    )
    const popup = constructed[0] as { webPreferences: WebPreferences }
    expect(popup.webPreferences.navigateOnDragDrop).toBe(true)
  })

  it('keeps the page sandboxed and isolated alongside it: the drop preference never widens the page’s powers', () => {
    const prefs = prefsOf('tab_dnd_sandbox')
    expect(prefs).toMatchObject({
      navigateOnDragDrop: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    })
  })
})

/**
 * The Appearance setting's Light / Dark on page views where the engine does not carry
 * `nativeTheme.themeSource` to pages (Linux): the setting's `prefers-color-scheme` as an
 * emulated media feature on the page's shared session, held like the dark theme for sites'
 * override, and released when the setting returns to System.
 */
describe('the Appearance setting’s colour scheme on page views', () => {
  interface FakeDebug {
    attached: boolean
    taken: boolean
    log: string[]
    commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
    detach(): void
    emit(event: string, ...args: unknown[]): boolean
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 2))
  }
  const page = (
    host: ElectronTabViewHost,
    id: string
  ): { view: ElectronTabView; dbg: FakeDebug } => {
    const view = host.createView(
      { id, containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    return { view, dbg: (view.webContents as unknown as { debugger: FakeDebug }).debugger }
  }
  const media = (dbg: FakeDebug): Array<Record<string, unknown> | undefined> =>
    dbg.commands.filter((c) => c.method === 'Emulation.setEmulatedMedia').map((c) => c.params)
  const DARK = { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
  const LIGHT = { features: [{ name: 'prefers-color-scheme', value: 'light' }] }

  it('puts an explicit scheme on every open page and on every page made after, and moves it with the setting', async () => {
    const host = new ElectronTabViewHost(sessions)
    const open = page(host, 'tab_scheme_open')
    expect(host.colorScheme).toBe('system')
    expect(host.pageColorScheme).toBeNull()
    host.applyColorScheme('dark', 'linux')
    await settle()
    expect(host.colorScheme).toBe('dark')
    expect(host.pageColorScheme).toBe('dark')
    expect(open.dbg.log).toEqual(['attach', 'Emulation.setEmulatedMedia'])
    expect(media(open.dbg)).toEqual([DARK])
    // A page made under the setting takes it as it is made, before any document.
    const made = page(host, 'tab_scheme_made')
    await settle()
    expect(made.dbg.log).toEqual(['attach', 'Emulation.setEmulatedMedia'])
    expect(media(made.dbg)).toEqual([DARK])
    // Light: the feature moves on the session the hold keeps; no second attach.
    host.applyColorScheme('light', 'linux')
    await settle()
    expect(open.dbg.log).toEqual([
      'attach',
      'Emulation.setEmulatedMedia',
      'Emulation.setEmulatedMedia'
    ])
    expect(media(open.dbg).at(-1)).toEqual(LIGHT)
    expect(media(made.dbg).at(-1)).toEqual(LIGHT)
    // The same setting again says nothing.
    host.applyColorScheme('light', 'linux')
    await settle()
    expect(open.dbg.log).toHaveLength(3)
    // System: released with an empty feature list, and the hold ends with its session.
    host.applyColorScheme('system', 'linux')
    await settle()
    expect(open.dbg.log.slice(3)).toEqual(['Emulation.setEmulatedMedia', 'detach'])
    expect(media(open.dbg).at(-1)).toEqual({ features: [] })
    expect(open.dbg.attached).toBe(false)
    expect(made.dbg.attached).toBe(false)
    expect(host.pageColorScheme).toBeNull()
    // A page made afterwards is left to the engine.
    const later = page(host, 'tab_scheme_later')
    await settle()
    expect(later.dbg.log).toEqual([])
  })

  it('leaves pages to the engine where it carries the setting itself, but still knows the setting for the zen:// documents', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { dbg } = page(host, 'tab_scheme_win')
    for (const platform of ['win32', 'darwin'] as const) {
      host.applyColorScheme('dark', platform)
      await settle()
      expect(host.colorScheme).toBe('dark')
      expect(host.pageColorScheme).toBeNull()
      expect(dbg.log).toEqual([])
      host.applyColorScheme('system', platform)
    }
  })

  it('puts the feature back when the shared session goes from under its hold, and re-sends it on a recycled session beside the dark theme’s override', async () => {
    const { nativeTheme } = await import('electron')
    const theme = nativeTheme as unknown as { shouldUseDarkColors: boolean }
    theme.shouldUseDarkColors = true
    try {
      const host = new ElectronTabViewHost(sessions)
      host.applyColorScheme('dark', 'linux')
      const { view, dbg } = page(host, 'tab_scheme_hold')
      await settle()
      expect(dbg.log).toEqual(['attach', 'Emulation.setEmulatedMedia'])
      // The governor lets the session go (the clamp lifting as the page comes in front).
      dbg.detach()
      dbg.emit('detach', {}, 'target closed')
      await settle()
      expect(dbg.log.slice(2)).toEqual(['detach', 'attach', 'Emulation.setEmulatedMedia'])
      expect(media(dbg).at(-1)).toEqual(DARK)
      expect(dbg.attached).toBe(true)
      // The dark theme for sites joins the same hold: no second attach, both overrides on.
      view.setDarkening(true)
      await settle()
      expect(dbg.log.slice(5)).toEqual(['Emulation.setAutoDarkModeOverride'])
      // A recycle (the fonts' once-per-agent command) puts both back on the fresh session.
      host.applyFonts({ ...DEFAULT_FONT_SETTINGS, standard: 'Georgia' })
      await settle()
      host.applyFonts({ ...DEFAULT_FONT_SETTINGS, standard: 'Palatino' })
      await settle()
      const recycled = dbg.log.indexOf('detach', 6)
      expect(recycled).toBeGreaterThan(6)
      expect(dbg.log.slice(recycled, recycled + 4)).toEqual([
        'detach',
        'attach',
        'Emulation.setEmulatedMedia',
        'Emulation.setAutoDarkModeOverride'
      ])
      // One override off keeps the session for the other; the last one off ends the hold.
      view.setDarkening(false)
      await settle()
      expect(dbg.log.at(-1)).toBe('Emulation.setAutoDarkModeOverride')
      expect(dbg.attached).toBe(true)
      host.applyColorScheme('system', 'linux')
      await settle()
      expect(dbg.log.slice(-2)).toEqual(['Emulation.setEmulatedMedia', 'detach'])
      expect(media(dbg).at(-1)).toEqual({ features: [] })
      expect(dbg.attached).toBe(false)
    } finally {
      theme.shouldUseDarkColors = false
      new ElectronTabViewHost(sessions).applyFonts(DEFAULT_FONT_SETTINGS)
    }
  })

  it('leaves a page another client holds alone, and tries again on the next change', async () => {
    const host = new ElectronTabViewHost(sessions)
    const { dbg } = page(host, 'tab_scheme_taken')
    dbg.taken = true
    host.applyColorScheme('dark', 'linux')
    await settle()
    expect(dbg.log).toEqual([])
    expect(dbg.attached).toBe(false)
    dbg.taken = false
    host.applyColorScheme('light', 'linux')
    await settle()
    expect(dbg.log).toEqual(['attach', 'Emulation.setEmulatedMedia'])
    expect(media(dbg).at(-1)).toEqual(LIGHT)
    host.applyColorScheme('system', 'linux')
    await settle()
    expect(dbg.attached).toBe(false)
  })

  it('writes the in-place error page with the setting’s scheme', () => {
    const host = new ElectronTabViewHost(sessions)
    const { view } = page(host, 'tab_scheme_error')
    const wc = view.webContents as unknown as { scripts: string[] }
    host.applyColorScheme('dark', 'win32')
    view.showErrorPage('zen://error?code=-105&description=net%3A%3AERR_NAME_NOT_RESOLVED')
    expect(wc.scripts).toHaveLength(1)
    expect(wc.scripts[0]).toContain("d.dataset.theme='dark';")
    expect(wc.scripts[0]).not.toContain('prefers-color-scheme')
    host.applyColorScheme('system', 'win32')
    view.showErrorPage('zen://error?code=-105&description=net%3A%3AERR_NAME_NOT_RESOLVED')
    expect(wc.scripts[1]).toContain("q('(prefers-color-scheme: dark)')")
  })
})

describe('ElectronTabViewHost.openTicket', () => {
  const ticket = (url: string): WindowOpenTicket & { adopted: ElectronTabView[] } => {
    const adopted: ElectronTabView[] = []
    return {
      action: 'window',
      url,
      adopted,
      adopt(view) {
        adopted.push(view as ElectronTabView)
        return { tab: { id: 'tab_popup', containerId: 'default' } as Tab, events: noEvents }
      }
    }
  }

  it('adopts a window.open guest with the tab page preferences, so the page preload runs in pop-ups', async () => {
    const host = new ElectronTabViewHost(sessions)
    const opener = host.createView(
      { id: 'tab_opener', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const guest = await guestWebContents()
    constructed.length = 0
    const t = ticket('https://accounts.google.com/o/oauth2/auth')
    const result = host.openTicket(t, opener, guest, {})
    // Electron only applies `webPreferences` to an existing page when both are handed over
    // together; the preload named there is the one the popup's document runs.
    expect(constructed).toHaveLength(1)
    const options = constructed[0] as {
      webContents?: unknown
      webPreferences?: { preload?: string; sandbox?: boolean; contextIsolation?: boolean }
    }
    expect(options.webContents).toBe(guest)
    expect(options.webPreferences?.preload).toMatch(/preload[\\/]page\.js$/)
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences).not.toHaveProperty('session')
    // The adopted page is the child window's page: `window.opener` stays connected.
    expect(result).toBe(guest)
    expect(t.adopted).toHaveLength(1)
    expect(host.tabIdForWebContents(guest)).toBe('tab_popup')
  })

  it('gives a link’s new window a fresh page in the opener’s session with the same preferences', async () => {
    const host = new ElectronTabViewHost(sessions)
    const opener = host.createView(
      { id: 'tab_opener', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const openerSession = {}
    Object.defineProperty(opener.webContents, 'session', { value: openerSession })
    constructed.length = 0
    const t = ticket('https://example.com/new')
    const result = host.openTicket(t, opener, undefined, { httpReferrer: 'https://a.example/' })
    const options = constructed[0] as {
      webContents?: unknown
      webPreferences?: { session?: unknown; preload?: string }
    }
    expect(options.webContents).toBeUndefined()
    expect(options.webPreferences?.session).toBe(openerSession)
    expect(options.webPreferences?.preload).toMatch(/preload[\\/]page\.js$/)
    expect(host.tabIdForWebContents(result)).toBe('tab_popup')
    // The browser starts the navigation itself (Electron only does so for windows it creates).
    expect((result as unknown as { loaded: string[] }).loaded).toEqual(['https://example.com/new'])
  })
})

/**
 * A NativeImage as `capturePage` resolves it: the device pixels as a 1x bitmap (its size, one
 * representation at scale 1), a `resize` that takes both sides and hands back another of these,
 * and encoders that record what they were asked for.
 */
function fakeCapture(
  width: number,
  height: number
): {
  image: Electron.NativeImage
  encoded: Array<{ width: number; height: number; quality: number }>
  resized: Array<{ width?: number; height?: number; quality?: string }>
} {
  const encoded: Array<{ width: number; height: number; quality: number }> = []
  const resized: Array<{ width?: number; height?: number; quality?: string }> = []
  const make = (w: number, h: number): Electron.NativeImage =>
    ({
      isEmpty: () => false,
      getSize: () => ({ width: w, height: h }),
      getScaleFactors: () => [1],
      resize: (to: { width?: number; height?: number; quality?: string }) => {
        resized.push(to)
        return make(to.width ?? w, to.height ?? Math.round((h * (to.width ?? w)) / w))
      },
      toJPEG: (quality: number) => {
        encoded.push({ width: w, height: h, quality })
        return Buffer.from(`jpeg-${w}x${h}-${quality}`)
      },
      toPNG: () => Buffer.from(`png-${w}`)
    }) as unknown as Electron.NativeImage
  return { image: make(width, height), encoded, resized }
}

/**
 * The stand-in behind overlays (`snapshot`): a JPEG at quality 90 of the capture at device
 * pixels, 1:1 through the 6.2 Mpx trigger and past it scaled down on both sides to the 3.7 Mpx
 * target with Hamming-1 (v2 draft §9.5) – no width clamp, so the frames the old 1400 clamp
 * resampled encode 1:1 (the Android host's cover takes its own path).
 */
describe('ElectronTabView.snapshot', () => {
  /** A tab view and its `webContents`, whose `capturePage` the tests replace per capture. */
  const tabView = (): { view: ElectronTabView; wc: Electron.WebContents } => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_1', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    return { view, wc: (view as unknown as { webContents: Electron.WebContents }).webContents }
  }

  it('encodes a capture at or under the trigger as it is, JPEG 90 – the pages the clamp used to resample, a 2560 × 1440 page and a DPR-2 1600 × 1000 frame included', async () => {
    const { view, wc } = tabView()
    for (const [w, h] of [
      [1536, 944],
      [1856, 1184],
      [1352, 944],
      // A 2560 × 1440 monitor's page with the sidebar collapsed: 3.55 Mpx.
      [2496, 1424],
      // A 1600 × 1000 DIP window at DPR 2: `capturePage` hands over 3072 × 1968 device pixels as
      // a 1x bitmap, 6.05 Mpx – the trigger's documented edge, still 1:1.
      [3072, 1968],
      // The trigger to the pixel counts as under it.
      [3100, 2000]
    ]) {
      const capture = fakeCapture(w, h)
      Object.assign(wc, { capturePage: () => Promise.resolve(capture.image) })
      await expect(view.snapshot()).resolves.toBe(
        `data:image/jpeg;base64,${Buffer.from(`jpeg-${w}x${h}-90`).toString('base64')}`
      )
      expect(capture.resized).toEqual([])
      expect(capture.encoded).toEqual([{ width: w, height: h, quality: 90 }])
    }
  })

  it('scales a capture past the trigger down to the target on both sides with Hamming-1 before the encode: a 4K monitor at 200 %', async () => {
    const { view, wc } = tabView()
    // A 1920 × 1080 DIP screen at DPR 2 with the sidebar collapsed: the page 1856 × 1064 CSS px,
    // 3712 × 2128 device pixels as a 1x bitmap (7.9 Mpx) → sqrt(3.7 / 7.9) = .684 → 2540 × 1456,
    // `quality: 'good'`.
    const page = fakeCapture(3712, 2128)
    Object.assign(wc, { capturePage: () => Promise.resolve(page.image) })
    await expect(view.snapshot()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-2540x1456-90').toString('base64')}`
    )
    expect(page.resized).toEqual([{ width: 2540, height: 1456, quality: 'good' }])
    expect(page.encoded).toEqual([{ width: 2540, height: 1456, quality: 90 }])
    expect(2540 * 1456).toBeLessThanOrEqual(3_700_000)
    expect(2540 * 1456).toBeGreaterThan(3_700_000 - (2540 + 1456))
    // The whole 3840 × 2160 screen (8.3 Mpx) → 2564 × 1442; a frame just past the trigger drops
    // to the target too, never to the trigger (3104 × 2000, 6.21 Mpx → 2396 × 1544, scale .77).
    for (const [w, h, sw, sh] of [
      [3840, 2160, 2564, 1442],
      [3104, 2000, 2396, 1544]
    ]) {
      const capture = fakeCapture(w, h)
      Object.assign(wc, { capturePage: () => Promise.resolve(capture.image) })
      await expect(view.snapshot()).resolves.toBe(
        `data:image/jpeg;base64,${Buffer.from(`jpeg-${sw}x${sh}-90`).toString('base64')}`
      )
      expect(capture.resized).toEqual([{ width: sw, height: sh, quality: 'good' }])
      expect(capture.encoded).toEqual([{ width: sw, height: sh, quality: 90 }])
      expect(sw * sh).toBeLessThanOrEqual(3_700_000)
    }
  })

  /*
   * The docked toolbox's picture for the cover (§9.29, W5-5): the frontend's own `capturePage`
   * – the whole box while the frontend has not said where the page's hole is – encoded as the
   * page's is; nothing with no toolbox up or one undocked (a window of its own), and the page's
   * own capture never stands in for it.
   */
  it('pictures a docked toolbox from its frontend, the whole box before the frontend has said where its hole is, and nothing with none docked in the frame', async () => {
    const { view, wc } = tabView()
    const page = fakeCapture(1200, 700)
    Object.assign(wc, { capturePage: () => Promise.resolve(page.image) })
    // Closed: nothing.
    await expect(view.snapshotDevtools()).resolves.toBeNull()
    for (const dock of ['bottom', 'right', 'left'] as const) {
      view.openDevTools('toggle', dock)
      const frontend = fakeCapture(1200, 1000)
      const asked: unknown[] = []
      Object.assign(wc.devToolsWebContents!, {
        capturePage: (rect?: unknown) => {
          asked.push(rect)
          return Promise.resolve(frontend.image)
        }
      })
      await expect(view.snapshotDevtools()).resolves.toBe(
        `data:image/jpeg;base64,${Buffer.from('jpeg-1200x1000-90').toString('base64')}`
      )
      // No cut asked for: the view's box is not known here, let alone the hole in it.
      expect(asked).toEqual([undefined])
      expect(frontend.encoded).toEqual([{ width: 1200, height: 1000, quality: 90 }])
      // The page's picture is its own capture still, untouched by the toolbox's.
      await expect(view.snapshot()).resolves.toBe(
        `data:image/jpeg;base64,${Buffer.from('jpeg-1200x700-90').toString('base64')}`
      )
      view.openDevTools('toggle', dock)
    }
    expect(page.encoded).toHaveLength(3)
    // Undocked: a window of its own, nothing of it in the frame's box.
    view.openDevTools('toggle', 'undocked')
    Object.assign(wc.devToolsWebContents!, {
      capturePage: () => Promise.resolve(fakeCapture(900, 600).image)
    })
    await expect(view.snapshotDevtools()).resolves.toBeNull()
    // Docked again by its own button (the console read-back): pictured again.
    await new Promise((r) => setImmediate(r))
    wc.devToolsWebContents!.emit('console-message', { message: 'zenium-devtools-dock:bottom' })
    await expect(view.snapshotDevtools()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-900x600-90').toString('base64')}`
    )
    // A frontend whose capture never comes: nothing, after the wait.
    Object.assign(wc.devToolsWebContents!, { capturePage: () => new Promise(() => undefined) })
    vi.useFakeTimers()
    try {
      const pending = view.snapshotDevtools()
      await vi.advanceTimersByTimeAsync(600)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * The cut to the toolbox's band (§9.5's budget): once the frontend has said where the page's
   * hole is (`setInspectedPageBounds`, read back on its console), the picture is the
   * frontend's `capturePage` of the part of the box beside the hole – under it for a bottom
   * dock, right of it for a right dock, left of it for a left one – at the box's DIP; the page's
   * hole, in the page's own picture already, is not pictured twice. A hole from another dock's
   * layout makes no band, and a closed toolbox forgets its hole: the whole box again until the
   * next frontend says.
   */
  it('cuts the picture to the toolbox’s band once the frontend has said where the page’s hole is, per dock, and forgets the hole with the toolbox', async () => {
    const { view, wc } = tabView()
    view.setBounds({ x: 0, y: 0, width: 1200, height: 1000 })
    /** The frontend's `capturePage`, recording the rect it is asked for and painting that size. */
    const frontendCapture = (): { asked: unknown[]; encoded: string[] } => {
      const asked: unknown[] = []
      const encoded: string[] = []
      Object.assign(wc.devToolsWebContents!, {
        capturePage: (rect?: { width: number; height: number }) => {
          asked.push(rect)
          const capture = rect ? fakeCapture(rect.width, rect.height) : fakeCapture(1200, 1000)
          encoded.push(`${capture.image.getSize().width}x${capture.image.getSize().height}`)
          return Promise.resolve(capture.image)
        }
      })
      return { asked, encoded }
    }
    const jpeg = (w: number, h: number): string =>
      `data:image/jpeg;base64,${Buffer.from(`jpeg-${w}x${h}-90`).toString('base64')}`

    view.openDevTools('toggle', 'bottom')
    // `devtools-opened` has followed: the host listens to the frontend's console.
    await new Promise((r) => setImmediate(r))
    const frontend = wc.devToolsWebContents!
    let capture = frontendCapture()
    // Before the frontend has said: the whole box.
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1200, 1000))
    expect(capture.asked).toEqual([undefined])
    // The frontend lays the page out in the top 700 DIP: the band is the 300 under it.
    frontend.emit('console-message', { message: 'zenium-devtools-page-bounds:0,0,1200,700' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1200, 300))
    expect(capture.asked).toEqual([{ x: 0, y: 700, width: 1200, height: 300 }])
    // The split dragged: the band follows the last reading.
    frontend.emit('console-message', { message: 'zenium-devtools-page-bounds:0,0,1200,550' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1200, 450))
    expect(capture.asked).toEqual([{ x: 0, y: 550, width: 1200, height: 450 }])

    // Moved to the right by its own button: the bottom's hole makes no right band – the whole
    // box until the frontend says the new hole – then the band right of the hole.
    frontend.emit('console-message', { message: 'zenium-devtools-dock:right' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1200, 1000))
    expect(capture.asked).toEqual([undefined])
    frontend.emit('console-message', { message: 'zenium-devtools-page-bounds:0,0,800,1000' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(400, 1000))
    expect(capture.asked).toEqual([{ x: 800, y: 0, width: 400, height: 1000 }])

    // Moved to the left: the band left of the hole.
    frontend.emit('console-message', { message: 'zenium-devtools-dock:left' })
    frontend.emit('console-message', { message: 'zenium-devtools-page-bounds:400,0,800,1000' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(400, 1000))
    expect(capture.asked).toEqual([{ x: 0, y: 0, width: 400, height: 1000 }])

    // The chrome lays the view out anew (the sidebar collapsed): the band is cut from the last
    // reading against the new box – the frontend's own resize says the new hole a moment later.
    view.setBounds({ x: 0, y: 0, width: 1500, height: 1000 })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(400, 1000))
    expect(capture.asked).toEqual([{ x: 0, y: 0, width: 400, height: 1000 }])
    frontend.emit('console-message', { message: 'zenium-devtools-page-bounds:500,0,1000,1000' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(500, 1000))
    expect(capture.asked).toEqual([{ x: 0, y: 0, width: 500, height: 1000 }])

    // Undocked: nothing of it in the frame, whatever the last hole said.
    frontend.emit('console-message', { message: 'zenium-devtools-dock:undocked' })
    await expect(view.snapshotDevtools()).resolves.toBeNull()

    // Closed and opened again: the hole went with the frontend – the whole box until the next
    // frontend says where its own hole is.
    view.openDevTools('toggle', 'bottom')
    view.openDevTools('toggle', 'bottom')
    await new Promise((r) => setImmediate(r))
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1200, 1000))
    expect(capture.asked).toEqual([undefined])
    const reopened = wc.devToolsWebContents!
    reopened.emit('console-message', { message: 'zenium-devtools-page-bounds:0,0,1500,600' })
    capture = frontendCapture()
    await expect(view.snapshotDevtools()).resolves.toBe(jpeg(1500, 400))
    expect(capture.asked).toEqual([{ x: 0, y: 600, width: 1500, height: 400 }])
  })
})

/**
 * Capture Full Page paints the document at the page's zoom, as Take Screenshot's `capturePage`
 * does, and cuts it so the painted picture stays under Chromium's texture height whatever the
 * zoom and the display's scale (the protocol multiplies the clip by the latter on its own).
 */
describe('fullPageCut', () => {
  it('keeps the agents’ cut at 100 percent on a plain display', () => {
    expect(fullPageCut(1, 1)).toBe(12_000)
    expect(fullPageCut(1.25, 1)).toBe(12_000)
  })

  it('shortens the cut as the zoom and the display scale grow, in CSS pixels', () => {
    expect(fullPageCut(2, 1)).toBe(8_000)
    // A Retina display: the protocol paints twice the CSS pixels.
    expect(fullPageCut(1, 2)).toBe(8_000)
    expect(fullPageCut(1.5, 2)).toBe(5_333)
  })

  it('treats a zoom or scale it cannot read as 100 percent', () => {
    expect(fullPageCut(Number.NaN, 0)).toBe(12_000)
    expect(fullPageCut(-1, Number.POSITIVE_INFINITY)).toBe(12_000)
  })
})

/**
 * `Page.captureScreenshot` reads its clip in the page's zoomed pixels (measured in Electron 44:
 * a CSS-pixel clip at 150 % painted the wrong area, and `scale: zoom` only enlarged it), so a
 * rectangle of CSS pixels is multiplied by the zoom and asked for at scale 1 – the protocol
 * adds the display's scale on its own, and the picture is the rectangle at the page's device
 * pixel ratio.
 */
describe('protocolClip', () => {
  it('is the CSS rectangle itself at 100 percent', () => {
    expect(protocolClip({ x: 200, y: 900, width: 300, height: 200 }, 1)).toEqual({
      x: 200,
      y: 900,
      width: 300,
      height: 200,
      scale: 1
    })
  })

  it('multiplies the rectangle by the zoom and keeps scale 1', () => {
    expect(protocolClip({ x: 200, y: 900, width: 300, height: 200 }, 1.5)).toEqual({
      x: 300,
      y: 1350,
      width: 450,
      height: 300,
      scale: 1
    })
    expect(protocolClip({ x: 200, y: 900, width: 300, height: 200 }, 0.8)).toEqual({
      x: 160,
      y: 720,
      width: 240,
      height: 160,
      scale: 1
    })
  })

  it('treats a zoom it cannot read as 100 percent', () => {
    expect(protocolClip({ x: 1, y: 2, width: 3, height: 4 }, Number.NaN)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      scale: 1
    })
    expect(protocolClip({ x: 1, y: 2, width: 3, height: 4 }, 0).scale).toBe(1)
  })
})

/**
 * The capture engine's `capture` (`page.capture`): a full page or region through the DevTools
 * protocol when the debugger is Zenium's to take, and when it is not – an extension's
 * `chrome.debugger` session (#328's ownership contract), DevTools open – the viewport paint
 * cropped to the region and marked as the stand-in it is (`fallback: 'viewport'`).
 */
describe('ElectronTabView.capture', () => {
  /** The page's geometry as `VIEWPORT_SCRIPT` reports it: a 1280 × 720 view over a 1280 × 4000 page, scrolled 600 down. */
  const GEOMETRY = { sx: 0, sy: 600, vw: 1280, vh: 720, dpr: 1, dw: 1280, dh: 4000 }

  /** A `capturePage` bitmap that records its `crop`. */
  const bitmap = (
    width: number,
    height: number
  ): {
    image: Electron.NativeImage
    crops: Array<{ x: number; y: number; width: number; height: number }>
  } => {
    const crops: Array<{ x: number; y: number; width: number; height: number }> = []
    const make = (w: number, h: number): Electron.NativeImage =>
      ({
        isEmpty: () => false,
        getSize: () => ({ width: w, height: h }),
        crop: (r: { x: number; y: number; width: number; height: number }) => {
          crops.push(r)
          return make(r.width, r.height)
        },
        toPNG: () => Buffer.from(`png-${w}x${h}`),
        toJPEG: (q: number) => Buffer.from(`jpeg-${w}x${h}-${q}`)
      }) as unknown as Electron.NativeImage
    return { image: make(width, height), crops }
  }

  /** A PNG's first 24 bytes – signature and IHDR – declaring `width` × `height`. */
  const pngHeader = (width: number, height: number): Buffer => {
    const bytes = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8)
    bytes.write('IHDR', 12, 'latin1')
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    return bytes
  }

  const tabView = (
    geometry: Record<string, unknown> | null = GEOMETRY,
    paint = bitmap(1280, 720),
    devtools: { zoom?: number; png?: Buffer } = {}
  ): {
    view: ElectronTabView
    wc: Electron.WebContents
    dbg: {
      log: string[]
      commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
      taken: boolean
    }
    paint: typeof paint
  } => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_1', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    Object.assign(wc, {
      capturePage: () => Promise.resolve(paint.image),
      getZoomFactor: () => devtools.zoom ?? 1,
      executeJavaScriptInIsolatedWorld: () =>
        geometry === null
          ? Promise.reject(new Error('Script failed to execute'))
          : Promise.resolve(geometry)
    })
    const dbg = wc.debugger as unknown as {
      log: string[]
      commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
      taken: boolean
      sendCommand: (
        method: string,
        params?: Record<string, unknown>
      ) => Promise<Record<string, unknown>>
    }
    // The protocol paints what it is asked for.
    const send = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (method, params) => {
      const result = await send(method, params)
      if (method === 'Page.getLayoutMetrics')
        return {
          cssContentSize: { width: 1280, height: 4000 },
          contentSize: { width: 1280 * (devtools.zoom ?? 1), height: 4000 * (devtools.zoom ?? 1) }
        }
      if (method === 'Page.captureScreenshot')
        return { data: (devtools.png ?? Buffer.from('devtools-png')).toString('base64') }
      return result
    }
    return { view, wc, dbg, paint }
  }

  afterEach(() => {
    removeForeignDebuggerOwner(1)
    removeForeignDebuggerOwner(2)
  })

  it('paints a region through the protocol when the debugger is free, and says nothing of a fallback', async () => {
    const { view, dbg, paint } = tabView()
    const result = await view.capture({
      mode: 'region',
      region: { x: 100, y: 700, width: 300, height: 200 },
      format: 'png'
    })
    expect(result).toEqual({
      data: Buffer.from('devtools-png').toString('base64'),
      mimeType: 'image/png',
      width: 300,
      height: 200
    })
    expect(result?.fallback).toBeUndefined()
    const shot = dbg.commands.find((c) => c.method === 'Page.captureScreenshot')
    expect(shot?.params).toMatchObject({
      format: 'png',
      clip: { x: 100, y: 700, width: 300, height: 200, scale: 1 },
      captureBeyondViewport: true
    })
    expect(paint.crops).toEqual([])
    // The session was Zenium's for the paint and is closed after it.
    expect(dbg.log).toContain('attach')
    expect(dbg.log[dbg.log.length - 1]).toBe('detach')
  })

  it('asks for a zoomed page’s region in its zoomed pixels, and reports the picture’s own size', async () => {
    // 150 % on a 2x display: the protocol paints the 450 × 300 zoomed pixels at the display's
    // scale, 900 × 600 device pixels – the region at the page's device pixel ratio of 3.
    const { view, dbg } = tabView(GEOMETRY, bitmap(1280, 720), {
      zoom: 1.5,
      png: pngHeader(900, 600)
    })
    const result = await view.capture({
      mode: 'region',
      region: { x: 200, y: 900, width: 300, height: 200 },
      format: 'png'
    })
    const shot = dbg.commands.find((c) => c.method === 'Page.captureScreenshot')
    expect(shot?.params?.clip).toEqual({ x: 300, y: 1350, width: 450, height: 300, scale: 1 })
    expect(result).toMatchObject({ width: 900, height: 600, mimeType: 'image/png' })
    expect(result?.fallback).toBeUndefined()
  })

  it('paints a full page as the document’s CSS size times the zoom, cut where the texture height says', async () => {
    const { view, dbg } = tabView(GEOMETRY, bitmap(1280, 720), { zoom: 1.5 })
    const result = await view.capture({ mode: 'fullPage', format: 'jpeg' })
    const shot = dbg.commands.find((c) => c.method === 'Page.captureScreenshot')
    expect(shot?.params).toMatchObject({
      format: 'jpeg',
      quality: 75,
      clip: { x: 0, y: 0, width: 1920, height: 6000, scale: 1 },
      captureBeyondViewport: true
    })
    // No header to read (the fake paint is not a picture): the clip's size stands in.
    expect(result).toMatchObject({ width: 1920, height: 6000, mimeType: 'image/jpeg' })
  })

  it('leaves a page an extension’s chrome.debugger holds alone: the viewport paint cropped to the region, marked as the stand-in', async () => {
    const { view, wc, dbg, paint } = tabView()
    addForeignDebuggerOwner(wc.id)
    const result = await view.capture({
      mode: 'region',
      region: { x: 100, y: 700, width: 300, height: 200 },
      format: 'png'
    })
    // No attach was even tried: `captureBeyondViewport`'s device-metrics override would clobber the extension's.
    expect(dbg.log).toEqual([])
    // The region's CSS px minus the scroll offset, at the page's device pixel ratio (1 here).
    expect(paint.crops).toEqual([{ x: 100, y: 100, width: 300, height: 200 }])
    expect(result).toEqual({
      data: Buffer.from('png-300x200').toString('base64'),
      mimeType: 'image/png',
      width: 300,
      height: 200,
      fallback: 'viewport'
    })
  })

  it('falls back the same way when DevTools holds the debugger, and for a full page hands the whole viewport over', async () => {
    const { view, dbg, paint } = tabView()
    dbg.taken = true
    const result = await view.capture({ mode: 'fullPage', format: 'jpeg' })
    expect(paint.crops).toEqual([])
    expect(result).toEqual({
      data: Buffer.from('jpeg-1280x720-75').toString('base64'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      fallback: 'viewport'
    })
  })

  it('crops the fallback at the page’s device pixel ratio on a scaled display, and cuts the region at the bitmap’s edge', async () => {
    // A 2x display: `capturePage` hands over 2560 × 1440 device pixels as a 1x bitmap.
    const { view, wc, paint } = tabView({ ...GEOMETRY, dpr: 2 }, bitmap(2560, 1440))
    addForeignDebuggerOwner(wc.id)
    const result = await view.capture({
      mode: 'region',
      region: { x: 100, y: 700, width: 300, height: 200 },
      format: 'png'
    })
    expect(paint.crops).toEqual([{ x: 200, y: 200, width: 600, height: 400 }])
    expect(result).toMatchObject({ width: 600, height: 400, fallback: 'viewport' })
    // A region reaching past the visible area is cut at it; one wholly outside is nothing.
    await view.capture({
      mode: 'region',
      region: { x: 1200, y: 1200, width: 300, height: 300 },
      format: 'png'
    })
    expect(paint.crops[1]).toEqual({ x: 2400, y: 1200, width: 160, height: 240 })
    await expect(
      view.capture({
        mode: 'region',
        region: { x: 0, y: 3000, width: 10, height: 10 },
        format: 'png'
      })
    ).resolves.toBeNull()
  })

  it('a plain viewport capture never touches the debugger and carries no fallback', async () => {
    const { view, dbg } = tabView()
    const result = await view.capture({ mode: 'viewport', format: 'png' })
    expect(dbg.log).toEqual([])
    expect(result).toEqual({
      data: Buffer.from('png-1280x720').toString('base64'),
      mimeType: 'image/png',
      width: 1280,
      height: 720
    })
  })

  // The visible-area picture is the layout viewport minus the scrollbar gutters, as Chrome's
  // is: `capturePage` paints the whole widget, a classic scrollbar's column included; the page
  // reports the area without it (`clientWidth` / `clientHeight`) and the bitmap is cut to it.
  it('cuts a viewport capture to the layout viewport minus a 15 px scrollbar gutter: clientWidth × dpr wide, no gutter column', async () => {
    const { view, dbg, paint } = tabView({ ...GEOMETRY, cw: 1265, ch: 720 })
    const result = await view.capture({ mode: 'viewport', format: 'png' })
    expect(dbg.log).toEqual([])
    expect(paint.crops).toEqual([{ x: 0, y: 0, width: 1265, height: 720 }])
    expect(result).toEqual({
      data: Buffer.from('png-1265x720').toString('base64'),
      mimeType: 'image/png',
      width: 1265,
      height: 720
    })
    // On a 2x display the gutter is 30 device pixels; a horizontal scrollbar takes the bottom rows.
    const scaled = tabView({ ...GEOMETRY, dpr: 2, cw: 1265, ch: 705 }, bitmap(2560, 1440))
    await expect(scaled.view.capture({ mode: 'viewport', format: 'png' })).resolves.toMatchObject({
      width: 2530,
      height: 1410
    })
    expect(scaled.paint.crops).toEqual([{ x: 0, y: 0, width: 2530, height: 1410 }])
  })

  // Measured on the packaged build: Chromium keeps the main frame's scrollbar on the right for
  // a right-to-left document too (`dir="rtl"` on the root, on the body, or by CSS – Blink's
  // `placeRTLScrollbarsOnLeftSideInMainFrame` is off), so the cut is anchored at the top-left in
  // either direction; `rtl` is information for the chrome, not a rule for the cut.
  it('cuts a right-to-left document from the top-left corner too: its scrollbar is on the right as well', async () => {
    const { view, paint } = tabView({ ...GEOMETRY, cw: 1265, ch: 720, rtl: true })
    await expect(view.capture({ mode: 'viewport', format: 'png' })).resolves.toMatchObject({
      width: 1265,
      height: 720
    })
    expect(paint.crops).toEqual([{ x: 0, y: 0, width: 1265, height: 720 }])
  })

  it('cuts the fallback stand-in the same way, and cuts a region at the visible area’s edge', async () => {
    // DevTools holds the debugger: a full page comes back as the visible area, minus the gutter.
    const { view, dbg, paint } = tabView({ ...GEOMETRY, cw: 1265, ch: 720 })
    dbg.taken = true
    await expect(view.capture({ mode: 'fullPage', format: 'png' })).resolves.toEqual({
      data: Buffer.from('png-1265x720').toString('base64'),
      mimeType: 'image/png',
      width: 1265,
      height: 720,
      fallback: 'viewport'
    })
    expect(paint.crops).toEqual([{ x: 0, y: 0, width: 1265, height: 720 }])
    // A region reaching past the visible area is cut at the area's edge, never into the gutter.
    await view.capture({
      mode: 'region',
      region: { x: 1200, y: 1200, width: 300, height: 300 },
      format: 'png'
    })
    expect(paint.crops[1]).toEqual({ x: 1200, y: 600, width: 65, height: 120 })
    // A right-to-left document measures the same: its scrollbar is on the right as well.
    const rtl = tabView({ ...GEOMETRY, cw: 1265, ch: 720, rtl: true })
    addForeignDebuggerOwner(rtl.wc.id)
    await expect(
      rtl.view.capture({
        mode: 'region',
        region: { x: 100, y: 700, width: 300, height: 200 },
        format: 'png'
      })
    ).resolves.toMatchObject({ width: 300, height: 200, fallback: 'viewport' })
    expect(rtl.paint.crops).toEqual([{ x: 100, y: 100, width: 300, height: 200 }])
    // ... and a region reaching into its gutter is cut at the area's edge too.
    await rtl.view.capture({
      mode: 'region',
      region: { x: 1200, y: 700, width: 300, height: 200 },
      format: 'png'
    })
    expect(rtl.paint.crops[1]).toEqual({ x: 1200, y: 100, width: 65, height: 200 })
  })

  it('leaves a page with overlay scrollbars – the area minus the gutters is the whole viewport – as it is', async () => {
    const { view, paint } = tabView({ ...GEOMETRY, cw: 1280, ch: 720, rtl: true })
    await expect(view.capture({ mode: 'viewport', format: 'png' })).resolves.toMatchObject({
      width: 1280,
      height: 720
    })
    expect(paint.crops).toEqual([])
    // A page that did not answer the geometry read: the bitmap stands as it is.
    const blind = tabView(null)
    await expect(blind.view.capture({ mode: 'viewport', format: 'png' })).resolves.toMatchObject({
      width: 1280,
      height: 720
    })
    expect(blind.paint.crops).toEqual([])
  })
})

/** The part of a `capturePage` bitmap that is page content, in its pixels. */
describe('visibleAreaClip', () => {
  const page = { clientWidth: 1265, clientHeight: 705, devicePixelRatio: 1 }

  it('is the area minus the gutters at the page’s device pixel ratio, anchored at the top-left corner', () => {
    expect(visibleAreaClip(page, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 0,
      width: 1265,
      height: 705
    })
    // A fractional ratio: floored, so a half-pixel overshoot of the integer `clientWidth` never
    // keeps a sliver of the scrollbar (1265 × 1.5 = 1897.5; the proof at 150 % measured the
    // rounded cut one row into the horizontal scrollbar's track).
    expect(
      visibleAreaClip({ ...page, devicePixelRatio: 1.5 }, { width: 1920, height: 1080 })
    ).toEqual({
      x: 0,
      y: 0,
      width: 1897,
      height: 1057
    })
  })

  it('never reaches past the bitmap and is the whole bitmap where scrollbars overlay the page', () => {
    expect(
      visibleAreaClip(
        { ...page, clientWidth: 1300, clientHeight: 800 },
        { width: 1280, height: 720 }
      )
    ).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(
      visibleAreaClip(
        { clientWidth: 1280, clientHeight: 720, devicePixelRatio: Number.NaN },
        { width: 1280, height: 720 }
      )
    ).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })
})

/** `page.viewport`: the page's geometry from the isolated world, with the engine's zoom factor. */
describe('ElectronTabView.viewport', () => {
  const tabView = (answer: () => Promise<unknown>, zoom = 1): ElectronTabView => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_1', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    Object.assign(wc, { executeJavaScriptInIsolatedWorld: answer, getZoomFactor: () => zoom })
    return view
  }

  it('maps the script’s answer, the zoom from the engine', async () => {
    const view = tabView(
      () =>
        Promise.resolve({
          sx: 0,
          sy: 600,
          vw: 1280,
          vh: 720,
          cw: 1268,
          ch: 720,
          rtl: true,
          dpr: 2.5,
          dw: 1280,
          dh: 4000
        }),
      1.25
    )
    await expect(view.viewport()).resolves.toEqual({
      scrollX: 0,
      scrollY: 600,
      width: 1280,
      height: 720,
      clientWidth: 1268,
      clientHeight: 720,
      rtl: true,
      zoom: 1.25,
      devicePixelRatio: 2.5,
      documentWidth: 1280,
      documentHeight: 4000
    })
  })

  it('is null for a page that throws or does not answer in time', async () => {
    await expect(
      tabView(() => Promise.reject(new Error('Script failed'))).viewport()
    ).resolves.toBeNull()
    vi.useFakeTimers()
    try {
      const pending = tabView(() => new Promise(() => undefined)).viewport()
      await vi.advanceTimersByTimeAsync(1500)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pageViewportFrom', () => {
  const raw = { sx: 10, sy: 20, vw: 800, vh: 600, dpr: 2, dw: 1600, dh: 3000 }

  it('takes a full answer and puts the document and the ratios right', () => {
    expect(pageViewportFrom(raw, 1)).toEqual({
      scrollX: 10,
      scrollY: 20,
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      rtl: false,
      zoom: 1,
      devicePixelRatio: 2,
      documentWidth: 1600,
      documentHeight: 3000
    })
    // A document narrower than the viewport is the viewport's size; a rubber-band scroll is 0.
    expect(pageViewportFrom({ ...raw, sx: -5, dw: 100, dh: 100 }, 1)).toMatchObject({
      scrollX: 0,
      documentWidth: 800,
      documentHeight: 600
    })
    // No `devicePixelRatio` from the page: the zoom stands in; no usable zoom: 1.
    expect(pageViewportFrom({ ...raw, dpr: 0 }, 1.5)).toMatchObject({
      zoom: 1.5,
      devicePixelRatio: 1.5
    })
    expect(pageViewportFrom(raw, Number.NaN)).toMatchObject({ zoom: 1 })
  })

  it('takes the area minus the scrollbar gutters within the viewport, and the direction', () => {
    expect(pageViewportFrom({ ...raw, cw: 785, ch: 585, rtl: true }, 1)).toMatchObject({
      clientWidth: 785,
      clientHeight: 585,
      rtl: true
    })
    // Not laid out (0), past the viewport, or missing: the viewport itself – no gutter.
    expect(pageViewportFrom({ ...raw, cw: 0, ch: 700, rtl: 'rtl' }, 1)).toMatchObject({
      clientWidth: 800,
      clientHeight: 600,
      rtl: false
    })
  })

  it('is null for anything short of a laid-out page', () => {
    expect(pageViewportFrom(null, 1)).toBeNull()
    expect(pageViewportFrom('x', 1)).toBeNull()
    expect(pageViewportFrom({ ...raw, vw: 0 }, 1)).toBeNull()
    expect(pageViewportFrom({ sx: 0, sy: 0 }, 1)).toBeNull()
    expect(pageViewportFrom({ ...raw, sy: 'a' }, 1)).toBeNull()
  })
})
