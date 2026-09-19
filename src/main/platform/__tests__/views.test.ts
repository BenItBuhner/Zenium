import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { TabViewEvents, WindowHost, WindowOpenTicket } from '../../../core/platform'
import type { SessionManager } from '../sessions'
import { ElectronTabViewHost, type ElectronTabView } from '../views'

/** The options every `WebContentsView` in the test was constructed with, in order. */
const constructed: Array<Record<string, unknown>> = []

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
    setVisible(): undefined {
      return undefined
    }
  }
  /** The view host follows the chrome's scheme for dark theme for sites; light and quiet here. */
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  return { WebContentsView: FakeWebContentsView, nativeTheme }
})

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
