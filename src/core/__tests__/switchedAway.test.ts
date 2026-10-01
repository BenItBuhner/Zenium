import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
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
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/*
 * Page visibility under the tab overview (OS-39, the lead's ruling on #728): the chrome's layout
 * report names the hide of the pages under the overview a switch (`switchedAway`), and the
 * window carries the word to each view's hide (`TabView.setVisible(false, switched)`), for a
 * host whose pages are told so (Android's `BackgroundTabRule`). The word turning on over pages
 * hidden already – the stage hid them as the overview began to open – is carried once more to
 * the pages the report would place, and to no other hidden page; closing the overview shows
 * the page as any layout does; picking another card places that one and leaves the covered
 * page hidden, the host's rule keeping it behind. A view that reads the first parameter alone
 * (Electron's) sees every call it saw before.
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
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

interface FakeView {
  view: TabView
  events: TabViewEvents
  /** Every `setVisible` as the view got it: `hide`, `hide switched` or `show`. */
  calls: string[]
  url: string
  visible: boolean
}

function fakeView(url: string, events: TabViewEvents): FakeView {
  const record: FakeView = { view: stub<TabView>(), events, calls: [], url, visible: false }
  record.view = stub<TabView>({
    loadURL: (next) => {
      record.url = next
    },
    getURL: () => record.url,
    getTitle: () => '',
    canGoBack: () => false,
    canGoForward: () => false,
    navigationEntries: () => ({ entries: [{ url: record.url, title: '' }], index: 0 }),
    hasDocument: () => true,
    isCurrentlyAudible: () => false,
    getZoom: () => 1,
    executeJavaScript: () => Promise.resolve(undefined),
    isVisible: () => record.visible,
    setVisible: (visible, switched) => {
      record.calls.push(visible ? 'show' : switched ? 'hide switched' : 'hide')
      record.visible = visible
    },
    isFocused: () => false,
    isDestroyed: () => false,
    setBackgroundColor: () => undefined
  })
  return record
}

interface Scene {
  browser: Browser
  win: ZenWindow
  pages: Map<string, FakeView>
  a: string
  b: string
}

const RECT = { x: 0, y: 80, width: 412, height: 800 }

function report(s: Scene, tabId: string, hidden: boolean, switchedAway?: boolean): void {
  s.browser.handleCommand(s.win, 'layout.report', {
    placements: [{ tabId, rect: RECT, radius: 0 }],
    glance: null,
    contentHidden: hidden,
    ...(switchedAway === undefined ? {} : { switchedAway })
  })
}

/** Two web tabs, B visited once and A back in front and shown; every call so far forgotten. */
function scene(): Scene {
  const pages = new Map<string, FakeView>()
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: false, updates: false, agents: false }),
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 880 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        const page = fakeView(tab.url, events)
        pages.set(tab.id, page)
        return page.view
      }
    }),
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
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  closeBootTabs(browser)
  const a = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win).id
  const b = browser.tabs.createTab({ url: 'https://example.com/b', active: true }, win).id
  const s: Scene = { browser, win, pages, a, b }
  report(s, b, false)
  browser.tabs.activateTab(a, win)
  report(s, a, false)
  for (const p of pages.values()) p.calls.length = 0
  return s
}

const calls = (s: Scene, tabId: string): string[] => s.pages.get(tabId)!.calls

describe('the switch word on a hide (LayoutReport.switchedAway)', () => {
  it('a cover hides the page with no word, the overview with the switch; a switch between tabs carries none', () => {
    const s = scene()
    report(s, s.a, true)
    expect(calls(s, s.a)).toEqual(['hide'])
    report(s, s.a, false)
    expect(calls(s, s.a)).toEqual(['hide', 'show'])
    report(s, s.a, true, true)
    expect(calls(s, s.a)).toEqual(['hide', 'show', 'hide switched'])
    // B was hidden by A's show, a switch the host reads off the screen: no word rode with it.
    expect(calls(s, s.b)).toEqual([])
  })

  it('the word turning on over a page hidden already reaches that page once, and no other hidden page', () => {
    const s = scene()
    // The stage hides the page as the overview begins to open: a cover's hide.
    report(s, s.a, true)
    expect(calls(s, s.a)).toEqual(['hide'])
    // The overview on its way open: the same layout, now a switch – carried to the hidden page.
    report(s, s.a, true, true)
    expect(calls(s, s.a)).toEqual(['hide', 'hide switched'])
    // The same report again (a relayout under the open overview): the word was carried already.
    report(s, s.a, true, true)
    expect(calls(s, s.a)).toEqual(['hide', 'hide switched'])
    // B, hidden since the switch to A and not under the overview, hears nothing of it.
    expect(calls(s, s.b)).toEqual([])
  })

  it('closing the overview shows the page as before; picking another card places that one and leaves the covered page hidden', () => {
    const s = scene()
    report(s, s.a, true, true)
    report(s, s.a, false)
    expect(calls(s, s.a)).toEqual(['hide switched', 'show'])
    // Open again, and B's card picked: B comes on, A stays as it is – behind B by the host's rule.
    report(s, s.a, true, true)
    s.browser.tabs.activateTab(s.b, s.win)
    report(s, s.b, false)
    expect(calls(s, s.a)).toEqual(['hide switched', 'show', 'hide switched'])
    expect(calls(s, s.b)).toEqual(['show'])
  })
})
