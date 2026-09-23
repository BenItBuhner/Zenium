import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Tab } from '../../../shared/types'
import type { TabViewEvents, WindowHost, WindowOpenTicket } from '../../../core/platform'
import {
  DEFAULT_FONT_SETTINGS,
  electronFontDefaults,
  type PageFontSettings
} from '../../../shared/fonts'
import type { SessionManager } from '../sessions'
import {
  addForeignDebuggerOwner,
  removeForeignDebuggerOwner,
  setDebuggerRecycler
} from '../pageDebugger'
import { ElectronTabViewHost, fullPagePaint, pageViewportFrom, type ElectronTabView } from '../views'

/** The options every `WebContentsView` in the test was constructed with, in order. */
const constructed: Array<Record<string, unknown>> = []

/**
 * Which page has the keyboard. `takeKeyboard` moves it the way Chromium does: the holder gets
 * `blur`, the taker `focus`.
 */
const { keyboard, takeKeyboard } = vi.hoisted(() => {
  const keyboard = { current: null as { emit(event: string): unknown } | null }
  const takeKeyboard = (taker: { emit(event: string): unknown }): void => {
    const previous = keyboard.current
    if (previous === taker) return
    keyboard.current = taker
    previous?.emit('blur')
    taker.emit('focus')
  }
  return { keyboard, takeKeyboard }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  /** A DevTools session as `webContents.debugger` offers it, recording what happened to it. */
  class FakeDebugger extends EventEmitter {
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
      await new Promise((r) => setTimeout(r, 1))
      if (method === 'Page.setFontFamilies') {
        if (this.fontFamiliesSet) throw new Error('Font families can only be set once')
        this.fontFamiliesSet = true
      }
      return {}
    }
  }
  class FakeWebContents extends EventEmitter {
    private static nextId = 1
    readonly id = FakeWebContents.nextId++
    private closed = false
    readonly debugger = new FakeDebugger()
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
    getZoomFactor(): number {
      return 1
    }
    sendInputEvent(event: Record<string, unknown>): void {
      this.widgetEvents.push(event)
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
  }
  /** The view host follows the chrome's scheme for dark theme for sites; light and quiet here. */
  // Every view host in the tests listens for a flip (the app has one host; the tests many).
  const nativeTheme = Object.assign(new EventEmitter().setMaxListeners(0), {
    shouldUseDarkColors: false
  })
  return { WebContentsView: FakeWebContentsView, nativeTheme }
})

/** A window's chrome page: the keyboard's home when no page on screen has it. */
class FakeChrome extends EventEmitter {
  focusCalls = 0
  isDestroyed(): boolean {
    return false
  }
  focus(): void {
    this.focusCalls++
    takeKeyboard(this)
  }
}

/** A BrowserWindow as `attachTo` sees it: its chrome page, its `contentView`, its focus. */
class FakeBrowserWindow extends EventEmitter {
  focused = true
  readonly children: unknown[] = []
  readonly contentView = {
    children: this.children,
    addChildView: (view: unknown): void => {
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
}

function fakeWindow(): WindowHost & { win: FakeBrowserWindow; chrome: FakeChrome } {
  const chrome = new FakeChrome()
  const win = new FakeBrowserWindow(chrome)
  return { win, chrome } as unknown as WindowHost & { win: FakeBrowserWindow; chrome: FakeChrome }
}

/** A page Chromium made for a script `window.open`, before any tab adopted it. */
async function guestWebContents(): Promise<Electron.WebContents> {
  const { WebContentsView } = await import('electron')
  const view = new WebContentsView({})
  constructed.pop()
  return view.webContents
}

const sessions = { get: () => ({}) } as unknown as SessionManager
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
 * Agent input goes through the DevTools protocol's Input domain, whose session is held the way
 * the resource governor holds its own: attached for the action, detached once nothing is
 * pending, an existing session used and left alone, and never `Runtime.enable`.
 */
describe('ElectronTabView.sendInput and the DevTools session', () => {
  interface FakeDebug {
    attached: boolean
    taken: boolean
    log: string[]
  }
  const viewWithDebugger = (): { view: ElectronTabView; dbg: FakeDebug; widget: unknown[] } => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_agent', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = view.webContents as unknown as { debugger: FakeDebug; widgetEvents: unknown[] }
    return { view, dbg: wc.debugger, widget: wc.widgetEvents }
  }

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
    new ElectronTabViewHost(sessions).applyFonts(DEFAULT_FONT_SETTINGS)
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
    expect(dbg.log.slice(3)).toEqual([
      'attach',
      'Page.setFontFamilies',
      'Page.setFontSizes',
      'detach'
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
    expect(dbg.attached).toBe(false)
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
        'Page.setFontSizes'
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
        'Page.setFontSizes'
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
})

/**
 * Capture Full Page paints the document at the page's zoom, as Take Screenshot's `capturePage`
 * does, and cuts it so the painted picture stays under Chromium's texture height whatever the
 * zoom and the display's scale (the protocol multiplies the clip by the latter on its own).
 */
describe('fullPagePaint', () => {
  it('paints at the page zoom and keeps the agents’ cut at 100 percent on a plain display', () => {
    expect(fullPagePaint(1, 1)).toEqual({ scale: 1, maxHeight: 12_000 })
    expect(fullPagePaint(1.25, 1)).toEqual({ scale: 1.25, maxHeight: 12_000 })
  })

  it('shortens the cut as the zoom and the display scale grow, in CSS pixels', () => {
    expect(fullPagePaint(2, 1)).toEqual({ scale: 2, maxHeight: 8_000 })
    // A Retina display: the protocol paints twice the CSS pixels.
    expect(fullPagePaint(1, 2)).toEqual({ scale: 1, maxHeight: 8_000 })
    expect(fullPagePaint(1.5, 2)).toEqual({ scale: 1.5, maxHeight: 5_333 })
  })

  it('treats a zoom or scale it cannot read as 100 percent', () => {
    expect(fullPagePaint(Number.NaN, 0)).toEqual({ scale: 1, maxHeight: 12_000 })
    expect(fullPagePaint(-1, Number.POSITIVE_INFINITY)).toEqual({ scale: 1, maxHeight: 12_000 })
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
  ): { image: Electron.NativeImage; crops: Array<{ x: number; y: number; width: number; height: number }> } => {
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

  const tabView = (
    geometry: Record<string, unknown> | null = GEOMETRY,
    paint = bitmap(1280, 720)
  ): { view: ElectronTabView; wc: Electron.WebContents; dbg: { log: string[]; commands: Array<{ method: string; params: Record<string, unknown> | undefined }>; taken: boolean }; paint: typeof paint } => {
    const host = new ElectronTabViewHost(sessions)
    const view = host.createView(
      { id: 'tab_1', containerId: 'default' } as Tab,
      noEvents,
      detachedWindow
    ) as ElectronTabView
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    Object.assign(wc, {
      capturePage: () => Promise.resolve(paint.image),
      executeJavaScriptInIsolatedWorld: () =>
        geometry === null ? Promise.reject(new Error('Script failed to execute')) : Promise.resolve(geometry)
    })
    const dbg = wc.debugger as unknown as {
      log: string[]
      commands: Array<{ method: string; params: Record<string, unknown> | undefined }>
      taken: boolean
      sendCommand: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    // The protocol paints what it is asked for.
    const send = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (method, params) => {
      const result = await send(method, params)
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1280, height: 4000 } }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('devtools-png').toString('base64') }
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

  it('leaves a page an extension’s chrome.debugger holds alone: the viewport paint cropped to the region, marked as the stand-in', async () => {
    const { view, wc, dbg, paint } = tabView()
    addForeignDebuggerOwner(wc.id, 'ext_1')
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
    addForeignDebuggerOwner(wc.id, 'ext_1')
    const result = await view.capture({
      mode: 'region',
      region: { x: 100, y: 700, width: 300, height: 200 },
      format: 'png'
    })
    expect(paint.crops).toEqual([{ x: 200, y: 200, width: 600, height: 400 }])
    expect(result).toMatchObject({ width: 600, height: 400, fallback: 'viewport' })
    // A region reaching past the visible area is cut at it; one wholly outside is nothing.
    await view.capture({ mode: 'region', region: { x: 1200, y: 1200, width: 300, height: 300 }, format: 'png' })
    expect(paint.crops[1]).toEqual({ x: 2400, y: 1200, width: 160, height: 240 })
    await expect(
      view.capture({ mode: 'region', region: { x: 0, y: 3000, width: 10, height: 10 }, format: 'png' })
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
    const view = tabView(() => Promise.resolve({ sx: 0, sy: 600, vw: 1280, vh: 720, dpr: 2.5, dw: 1280, dh: 4000 }), 1.25)
    await expect(view.viewport()).resolves.toEqual({
      scrollX: 0,
      scrollY: 600,
      width: 1280,
      height: 720,
      zoom: 1.25,
      devicePixelRatio: 2.5,
      documentWidth: 1280,
      documentHeight: 4000
    })
  })

  it('is null for a page that throws or does not answer in time', async () => {
    await expect(tabView(() => Promise.reject(new Error('Script failed'))).viewport()).resolves.toBeNull()
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
    expect(pageViewportFrom({ ...raw, dpr: 0 }, 1.5)).toMatchObject({ zoom: 1.5, devicePixelRatio: 1.5 })
    expect(pageViewportFrom(raw, Number.NaN)).toMatchObject({ zoom: 1 })
  })

  it('is null for anything short of a laid-out page', () => {
    expect(pageViewportFrom(null, 1)).toBeNull()
    expect(pageViewportFrom('x', 1)).toBeNull()
    expect(pageViewportFrom({ ...raw, vw: 0 }, 1)).toBeNull()
    expect(pageViewportFrom({ sx: 0, sy: 0 }, 1)).toBeNull()
    expect(pageViewportFrom({ ...raw, sy: 'a' }, 1)).toBeNull()
  })
})
