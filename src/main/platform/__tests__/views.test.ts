import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Tab } from '../../../shared/types'
import type { TabViewEvents, WindowHost, WindowOpenTicket } from '../../../core/platform'
import type { SessionManager } from '../sessions'
import { ElectronTabViewHost, type ElectronTabView } from '../views'

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
    isAttached(): boolean {
      return this.attached
    }
    attach(): void {
      if (this.attached || this.taken) throw new Error('Debugger is already attached')
      this.attached = true
      this.log.push('attach')
    }
    detach(): void {
      this.attached = false
      this.log.push('detach')
    }
    async sendCommand(method: string): Promise<Record<string, unknown>> {
      if (!this.attached) throw new Error('Debugger is not attached')
      this.log.push(method)
      await new Promise((r) => setTimeout(r, 1))
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
  return { WebContentsView: FakeWebContentsView }
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
