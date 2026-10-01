import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  ChromeSnapshot,
  ChromeSnapshotRequest,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * The picture of a page the chrome draws itself (`ZenWindow.snapshot` for a Settings tab, which
 * has no page view): on a host that copies its chrome (`WindowHost.snapshotChrome`, Android) the
 * window asks for the content area while the page is what the area shows – the active tab,
 * nothing of the chrome over it – answers the cover, and raises the card picture to the chrome
 * as `thumbnail.captured` while the tab is still at the address the picture was asked under
 * (BH-14). A host without the hook – the desktop – answers null as it always did, and a document
 * page's picture is still its view's.
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

const COVER = 'data:image/jpeg;base64,Y292ZXI='
const CARD = { data: 'data:image/jpeg;base64,Y2FyZA==', width: 344, height: 704 }

interface Fixture {
  browser: Browser
  win: ZenWindow
  /** What the host was asked for, in order. */
  asked: ChromeSnapshotRequest[]
  /** Events the core sent the chrome. */
  sent: Array<{ name: string; payload: unknown }>
  /** Page views' snapshot calls, by tab id. */
  viewSnapshots: string[]
}

function fixture(opts: {
  /** The host's answer to `snapshotChrome`; absent: a host without the hook (the desktop). */
  chrome?: (request: ChromeSnapshotRequest) => ChromeSnapshot | null
  /** A host with private tabs (the phone's), so Settings can open in the private container. */
  privateTabs?: boolean
}): Fixture {
  const asked: ChromeSnapshotRequest[] = []
  const sent: Array<{ name: string; payload: unknown }> = []
  const viewSnapshots: string[] = []
  const capabilities = stub<HostCapabilities>({
    windows: false,
    privateTabs: opts.privateTabs ?? false,
    updates: false,
    agents: false,
    pageTabs: true
  })
  const chrome = opts.chrome
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          },
          ...(chrome
            ? {
                snapshotChrome: async (request: ChromeSnapshotRequest) => {
                  asked.push(request)
                  return chrome(request)
                }
              }
            : {})
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          },
          snapshot: async () => {
            viewSnapshots.push(tab.id)
            return 'data:image/jpeg;base64,cGFnZQ=='
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  return { browser, win, asked, sent, viewSnapshots }
}

/** Settings opened as a tab, moved to `section` (and `subpage`); the tab's id. */
function openSettings(f: Fixture, section: string, subpage?: string): string {
  const id = f.browser.handleCommand(f.win, 'page.open', { id: 'settings', section }) as string
  if (subpage) f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section, subpage })
  return id
}

/** The chrome's layout: the page's frame, nothing over it. */
function layout(f: Fixture, tabId: string, contentHidden = false): void {
  f.browser.handleCommand(f.win, 'layout.report', {
    placements: [{ tabId, rect: { x: 8, y: 24, width: 344.4, height: 704 }, radius: 0 }],
    glance: null,
    contentHidden
  })
}

const captured = (f: Fixture): unknown[] =>
  f.sent.filter((e) => e.name === 'thumbnail.captured').map((e) => e.payload)

describe('the picture of a Settings tab', () => {
  it('is the host’s copy of the content area, asked under the tab’s address, its card raised to the chrome', async () => {
    const f = fixture({ chrome: () => ({ cover: COVER, card: CARD }) })
    const id = openSettings(f, 'privacy', 'site-data')
    layout(f, id)
    const cover = await f.win.snapshot(id)
    expect(cover).toBe(COVER)
    expect(f.asked).toEqual([
      {
        tabId: id,
        url: 'zen://settings/privacy/site-data',
        // The frame rounded to whole CSS px, as the host lays a page out by it.
        area: { x: 8, y: 24, width: 344, height: 704 },
        persist: true
      }
    ])
    expect(captured(f)).toEqual([{ tabId: id, ...CARD }])
  })

  it('asks for a private tab’s picture with nothing of it written: `persist` false, the card kept in memory alone as a private page’s is', async () => {
    const f = fixture({ chrome: () => ({ cover: COVER, card: CARD }), privateTabs: true })
    const id = f.browser.tabs.newPrivateTab('zen://settings/privacy', f.win)
    expect(id).not.toBeNull()
    if (!id) return
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: 'privacy',
      subpage: 'site-data'
    })
    layout(f, id)
    expect(await f.win.snapshot(id)).toBe(COVER)
    expect(f.asked.map((r) => [r.url, r.persist])).toEqual([
      ['zen://settings/privacy/site-data', false]
    ])
    // The host writes a card under `persist` alone; the picture it answers is the chrome's to
    // hold for the overview's card (`TabWebView.publishThumbnail` raises a private page's the
    // same way, without a save), where a private tab's cards never come from disk.
    expect(captured(f)).toEqual([{ tabId: id, ...CARD }])
  })

  it('answers the cover alone when the host’s card picture a moment old still stands', async () => {
    const f = fixture({ chrome: () => ({ cover: COVER, card: null }) })
    const id = openSettings(f, 'updates')
    layout(f, id)
    expect(await f.win.snapshot(id)).toBe(COVER)
    expect(captured(f)).toEqual([])
  })

  it('is not asked for while the page is not what the area shows: another tab in front, or the chrome over it', async () => {
    const f = fixture({ chrome: () => ({ cover: COVER, card: CARD }) })
    const id = openSettings(f, 'updates')
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, f.win)
    expect(await f.win.snapshot(id)).toBeNull()
    f.browser.tabs.activateTab(id, f.win)
    layout(f, id, true)
    expect(await f.win.snapshot(id)).toBeNull()
    expect(f.asked).toEqual([])
    layout(f, id)
    expect(await f.win.snapshot(id)).toBe(COVER)
    expect(f.asked.length).toBe(1)
  })

  it('does not raise a card of the page the tab has left while the host copied (BH-14)', async () => {
    let settle: (picture: ChromeSnapshot) => void = () => undefined
    const f = fixture({
      chrome: () => {
        // Answered later, by hand.
        return null
      }
    })
    // A host that answers once told to: the request is held in `asked`, the answer comes from `settle`.
    const host = f.win as unknown as {
      host: WindowHost & {
        snapshotChrome: (r: ChromeSnapshotRequest) => Promise<ChromeSnapshot | null>
      }
    }
    host.host.snapshotChrome = (request) => {
      f.asked.push(request)
      return new Promise((resolve) => {
        settle = resolve
      })
    }
    const id = openSettings(f, 'privacy')
    layout(f, id)
    const pending = f.win.snapshot(id)
    expect(f.asked[0]?.url).toBe('zen://settings/privacy')
    // The tab moves on to the drill-in page before the copy is back.
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: 'privacy',
      subpage: 'site-data'
    })
    settle({ cover: COVER, card: CARD })
    expect(await pending).toBe(COVER)
    expect(captured(f)).toEqual([])
  })

  it('is nothing on a host that takes no picture of its chrome (the desktop), as before', async () => {
    const f = fixture({})
    const id = openSettings(f, 'updates')
    layout(f, id)
    expect(await f.win.snapshot(id)).toBeNull()
    expect(f.sent.filter((e) => e.name === 'thumbnail.captured')).toEqual([])
  })

  it('leaves a document page’s picture to its view', async () => {
    const f = fixture({ chrome: () => ({ cover: COVER, card: CARD }) })
    const tab = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, f.win)
    expect(await f.win.snapshot(tab.id)).toBe('data:image/jpeg;base64,cGFnZQ==')
    expect(f.viewSnapshots).toEqual([tab.id])
    expect(f.asked).toEqual([])
  })
})
