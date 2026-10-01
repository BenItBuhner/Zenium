import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import { COVER_REPORT_CEILING_MS } from '../tabs'
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/**
 * A switched or woken tab shown on the activate commit (W8-P0, the Design Lead's ruling on the
 * jank audit's finding G): the core shows the page the moment it commits the activation, at the
 * FRAME's last reported rect – never the view's own, possibly stale, box – under the page the
 * window had in front, which stands over it until the shown page's word that it has painted
 * (`TabView.shownPainted`) or the failure ceiling (`COVER_REPORT_CEILING_MS`), then goes: the
 * reveal. The chrome's layout report still arrives, still sets the bounds, still tells the
 * chrome what it showed and hid, in the order it always did.
 */

function memoryIo(files: Record<string, string> = {}): StoreIO {
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** A live page of the fake host: what it was asked, in order, and its state. */
interface FakeView {
  view: TabView
  events: TabViewEvents
  calls: string[]
  url: string
  visible: boolean
  destroyed: boolean
  /** Every ask for the word that the page has painted (`shownPainted`), unanswered. */
  words: Array<{ resolve: (t: number) => void; reject: (reason: Error) => void }>
}

function fakeView(url: string, events: TabViewEvents, gives: boolean): FakeView {
  const record: FakeView = {
    view: stub<TabView>(),
    events,
    calls: [],
    url,
    visible: false,
    destroyed: false,
    words: []
  }
  const log = (name: string, ...args: unknown[]): void =>
    void record.calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`)
  record.view = stub<TabView>({
    // A view that cannot say when it has painted leaves the word out.
    shownPainted: gives
      ? () => {
          log('shownPainted')
          return new Promise<number>((resolve, reject) => record.words.push({ resolve, reject }))
        }
      : undefined,
    loadURL: (next) => {
      log('loadURL', next)
      record.url = next
    },
    getURL: () => record.url,
    getTitle: () => '',
    canGoBack: () => false,
    canGoForward: () => false,
    navigationEntries: () => ({ entries: [{ url: record.url, title: '' }], index: 0 }),
    restoreNavigation: () => Promise.resolve(),
    hasDocument: () => true,
    isCurrentlyAudible: () => false,
    getZoom: () => 1,
    executeJavaScript: () => Promise.resolve(undefined),
    isVisible: () => record.visible,
    setVisible: (visible) => {
      log('setVisible', visible)
      record.visible = visible
    },
    isFocused: () => false,
    focus: () => undefined,
    bringToFront: () => log('bringToFront'),
    isDestroyed: () => record.destroyed,
    destroy: () => {
      log('destroy')
      record.destroyed = true
      record.events.onDestroyed()
    },
    setBounds: (rect) => log('setBounds', rect),
    setBorderRadius: (radius) => log('setBorderRadius', radius),
    setBackgroundColor: () => undefined
  })
  return record
}

interface Host {
  platform: Platform
  /** The page of each tab, by tab id – the last one made for it (a woken tab gets a new one). */
  pages: Map<string, FakeView>
  /** Every event the core sent the chrome, in order. */
  sent: Array<{ name: string; payload: unknown }>
}

interface HostOptions {
  /** The host shows on the commit (the desktop's); left out, the phone's, which does not. */
  showsOnCommit?: boolean
  /** The views give the word that they have painted. */
  gives?: boolean
}

function fakeHost({ showsOnCommit = true, gives = true }: HostOptions = {}): Host {
  const pages = new Map<string, FakeView>()
  const sent: Host['sent'] = []
  const windowHost = (): WindowHost =>
    stub<WindowHost>({
      alive: true,
      contentSize: () => ({ width: 1280, height: 800 }),
      normalBounds: () => null,
      isFullScreen: () => false,
      isMaximized: () => false,
      isFocused: () => true,
      isVisible: () => true,
      send: (name, payload) => void sent.push({ name, payload })
    })
  const views: Partial<TabViewHost> = {
    createView: (tab: Tab, events: TabViewEvents) => {
      const page = fakeView(tab.url, events, gives)
      pages.set(tab.id, page)
      return page.view
    },
    ...(showsOnCommit ? { showsOnCommit: true } : {})
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, updates: false, agents: false }),
    io: memoryIo(),
    windows: { create: () => windowHost() },
    views: stub<TabViewHost>(views),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
  return { platform, pages, sent }
}

const A_URL = 'https://example.com/a'
const B_URL = 'https://example.org/b'
const RECT = { x: 0, y: 80, width: 1280, height: 720 }
const NARROW = { x: 240, y: 80, width: 1040, height: 720 }

interface Scene {
  browser: Browser
  win: ZenWindow
  host: Host
  a: { id: string; page: FakeView }
  b: { id: string; page: FakeView }
}

/** The chrome's layout report: `tabId` placed at `rect`, every other page down. */
function report(s: Scene, tabId: string, rect = RECT): void {
  s.browser.handleCommand(s.win, 'layout.report', {
    placements: [{ tabId, rect, radius: 0 }],
    glance: null,
    contentHidden: false
  })
}

/** The last `layout.applied` the chrome heard. */
function lastApplied(s: Scene): { contentHidden: boolean; hid: string[]; shown: string[] } {
  const applied = s.host.sent.filter((e) => e.name === 'layout.applied')
  return applied[applied.length - 1]!.payload as {
    contentHidden: boolean
    hid: string[]
    shown: string[]
  }
}

/**
 * A browser with two loaded tabs, A in front at `RECT` by the chrome's report, B's page live
 * and hidden; every page's log cleared.
 */
function scene(options: HostOptions = {}): Scene {
  const host = fakeHost(options)
  const browser = new Browser(host.platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  closeBootTabs(browser)
  const a = browser.tabs.createTab({ url: A_URL, active: true }, win)
  const b = browser.tabs.createTab({ url: B_URL, active: false }, win)
  browser.tabs.load(b.id, win)
  const s: Scene = {
    browser,
    win,
    host,
    a: { id: a.id, page: host.pages.get(a.id)! },
    b: { id: b.id, page: host.pages.get(b.id)! }
  }
  for (const p of [s.a.page, s.b.page]) {
    p.events.onNavigated(p.url, false)
    p.events.onDomReady()
  }
  report(s, a.id)
  expect(s.a.page.visible).toBe(true)
  expect(s.b.page.visible).toBe(false)
  s.a.page.calls.length = 0
  s.b.page.calls.length = 0
  host.sent.length = 0
  return s
}

/** Let the promise reactions of a word land. */
const landed = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** The page's word that it has painted: answer its oldest ask and let the word land. */
async function painted(v: FakeView): Promise<void> {
  const ask = v.words.shift()
  if (!ask) throw new Error(`${v.url} was not asked for its word`)
  ask.resolve(16.7)
  await landed()
}

afterEach(() => vi.useRealTimers())

describe('a switched tab shown on the activate commit (W8-P0)', () => {
  it('shows the page on the commit, at the frame’s last reported rect, under the page in front', () => {
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    // No report has come, and B is already placed where the frame last put a page, and shown.
    expect(s.b.page.calls).toEqual([
      `setBounds(${JSON.stringify(RECT)})`,
      'setBorderRadius(0)',
      'setVisible(true)',
      'shownPainted()'
    ])
    expect(s.b.page.visible).toBe(true)
    // A stays shown, raised over B: the stand-in.
    expect(s.a.page.visible).toBe(true)
    expect(s.a.page.calls).toEqual(['bringToFront()'])
  })

  it('still lets the layout report set the bounds and tell the chrome what it showed and hid', () => {
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    s.b.page.calls.length = 0
    report(s, s.b.id)
    // The report places B again – the bounds it names – and counts B shown, A hidden, as it
    // would have had it shown B itself.
    expect(s.b.page.calls).toEqual([`setBounds(${JSON.stringify(RECT)})`, 'setBorderRadius(0)'])
    expect(s.b.page.calls).not.toContain('setVisible(true)')
    expect(lastApplied(s)).toEqual({ contentHidden: false, hid: [s.a.id], shown: [s.b.id] })
    // ...but A, the stand-in, is still up over B: the engine's hide waits for the reveal.
    expect(s.a.page.visible).toBe(true)
  })

  it('takes the frame’s last rect, not the view’s own stale one', () => {
    const s = scene()
    // B was last placed at the full width; the sidebar unfolded meanwhile and A's report moved
    // the frame. B's own last box is stale; the frame's last reported rect is `NARROW`.
    report(s, s.b.id)
    report(s, s.a.id, NARROW)
    s.b.page.calls.length = 0
    s.browser.tabs.activateTab(s.b.id, s.win)
    expect(s.b.page.calls[0]).toBe(`setBounds(${JSON.stringify(NARROW)})`)
    expect(s.b.page.calls).toContain('setVisible(true)')
  })

  it('reveals on the shown page’s word: the stand-in goes down then, not before', async () => {
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    report(s, s.b.id)
    expect(s.a.page.visible).toBe(true)
    await painted(s.b.page)
    expect(s.a.page.visible).toBe(false)
    expect(s.a.page.calls).toEqual(['bringToFront()', 'setVisible(false)'])
    // The chrome heard nothing more: the reveal is the engine's alone.
    expect(s.host.sent.filter((e) => e.name === 'layout.applied')).toHaveLength(1)
  })

  it('reveals on the failure ceiling when the page never gives its word', () => {
    vi.useFakeTimers()
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    report(s, s.b.id)
    vi.advanceTimersByTime(COVER_REPORT_CEILING_MS - 1)
    expect(s.a.page.visible).toBe(true)
    vi.advanceTimersByTime(1)
    expect(s.a.page.visible).toBe(false)
  })

  it('a word before the report is no reveal yet: the report takes the stand-in down as before', async () => {
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    await painted(s.b.page)
    // No report has asked A down, so the word hides nothing of its own.
    expect(s.a.page.visible).toBe(true)
    report(s, s.b.id)
    expect(s.a.page.visible).toBe(false)
    expect(lastApplied(s)).toEqual({ contentHidden: false, hid: [s.a.id], shown: [s.b.id] })
  })

  it('the window’s close ends the hold: nothing fires at the ceiling', () => {
    vi.useFakeTimers()
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    report(s, s.b.id)
    s.win.onClosed()
    expect(() => vi.advanceTimersByTime(COVER_REPORT_CEILING_MS)).not.toThrow()
  })

  it('a switch back within the hold: the page in front stays, the early show is dropped', async () => {
    vi.useFakeTimers()
    const s = scene()
    s.browser.tabs.activateTab(s.b.id, s.win)
    s.browser.tabs.activateTab(s.a.id, s.win)
    // A is where the frame last placed a page: nothing to show early. The report placing A
    // hides B as the layout always did; nothing happens at the ceiling.
    report(s, s.a.id)
    expect(s.a.page.visible).toBe(true)
    expect(s.b.page.visible).toBe(false)
    expect(lastApplied(s)).toEqual({ contentHidden: false, hid: [s.b.id], shown: [] })
    vi.advanceTimersByTime(COVER_REPORT_CEILING_MS)
    expect(s.a.page.visible).toBe(true)
    // B's late word changes nothing either.
    await painted(s.b.page)
    expect(s.a.page.visible).toBe(true)
  })

  it('a second switch within the hold: the first stand-in’s deferred hide lands, the page shown takes its part', () => {
    const s = scene()
    const c = s.browser.tabs.createTab({ url: 'https://example.net/c', active: false }, s.win)
    s.browser.tabs.load(c.id, s.win)
    const cPage = s.host.pages.get(c.id)!
    cPage.events.onNavigated(cPage.url, false)
    cPage.events.onDomReady()
    s.browser.tabs.activateTab(s.b.id, s.win)
    report(s, s.b.id)
    expect(s.a.page.visible).toBe(true)
    // On to C before B's word: A's deferred hide is applied, B stands over C.
    s.browser.tabs.activateTab(c.id, s.win)
    expect(s.a.page.visible).toBe(false)
    expect(cPage.calls).toContain(`setBounds(${JSON.stringify(RECT)})`)
    expect(cPage.visible).toBe(true)
    expect(s.b.page.calls).toContain('bringToFront()')
    expect(s.b.page.visible).toBe(true)
  })

  it('shows nothing early while the chrome is over the content, after a glance, or into a split', () => {
    const s = scene()
    s.browser.handleCommand(s.win, 'layout.report', {
      placements: [],
      glance: null,
      contentHidden: true
    })
    s.b.page.calls.length = 0
    s.browser.tabs.activateTab(s.b.id, s.win)
    expect(s.b.page.calls).toEqual([])
    expect(s.b.page.visible).toBe(false)
    // The report that follows shows B as it always did.
    report(s, s.b.id)
    expect(s.b.page.visible).toBe(true)
    expect(lastApplied(s).shown).toEqual([s.b.id])
  })

  it('a woken tab: the new page is shown on the commit, under the page in front, until its word', async () => {
    const s = scene()
    s.browser.tabs.discard(s.b.id)
    expect(s.browser.tabs.tab(s.b.id)!.discarded).toBe(true)
    s.browser.tabs.activateTab(s.b.id, s.win)
    const woken = s.host.pages.get(s.b.id)!
    expect(woken).not.toBe(s.b.page)
    // The new page is made hidden, then shown on the commit at the frame's last rect.
    expect(woken.calls.filter((c) => /^(setBounds|setVisible|shownPainted)/.test(c))).toEqual([
      'setVisible(false)',
      `setBounds(${JSON.stringify(RECT)})`,
      'setVisible(true)',
      'shownPainted()'
    ])
    expect(s.a.page.visible).toBe(true)
    report(s, s.b.id)
    expect(s.a.page.visible).toBe(true)
    await painted(woken)
    expect(s.a.page.visible).toBe(false)
  })

  it('a host that does not show on the commit keeps the report’s show', () => {
    const s = scene({ showsOnCommit: false })
    s.browser.tabs.activateTab(s.b.id, s.win)
    expect(s.b.page.calls).toEqual([])
    expect(s.b.page.visible).toBe(false)
    report(s, s.b.id)
    expect(s.b.page.visible).toBe(true)
    expect(s.a.page.visible).toBe(false)
    expect(lastApplied(s)).toEqual({ contentHidden: false, hid: [s.a.id], shown: [s.b.id] })
  })

  it('a view with no word to give keeps the report’s show', () => {
    const s = scene({ gives: false })
    s.browser.tabs.activateTab(s.b.id, s.win)
    expect(s.b.page.calls).toEqual([])
    report(s, s.b.id)
    expect(s.b.page.visible).toBe(true)
    expect(s.a.page.visible).toBe(false)
  })
})
