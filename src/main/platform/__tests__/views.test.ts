import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { TabViewEvents, WindowHost, WindowOpenTicket } from '../../../core/platform'
import type { SessionManager } from '../sessions'
import { ElectronTabViewHost, type ElectronTabView } from '../views'

/** The options every `WebContentsView` in the test was constructed with, in order. */
const constructed: Array<Record<string, unknown>> = []

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebContents extends EventEmitter {
    private static nextId = 1
    readonly id = FakeWebContents.nextId++
    private closed = false
    isDestroyed(): boolean {
      return this.closed
    }
    getTitle(): string {
      return ''
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
  return { WebContentsView: FakeWebContentsView }
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
