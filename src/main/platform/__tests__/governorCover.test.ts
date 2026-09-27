import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Browser } from '../../../core/browser'

vi.mock('electron', () => ({ app: {}, powerMonitor: {} }))

/**
 * The tab views as the governor tells them apart (`instanceof`): a light stand-in for the
 * Electron host's, carrying the web contents alone.
 */
vi.mock('../views', () => ({
  ElectronTabView: class {
    constructor(readonly webContents: WebContents) {}
  },
  ElectronTabViewHost: class {}
}))

const { ResourceGovernor } = await import('../resources/governor')
const { ElectronTabView } = await import('../views')

const TAB = 'tab-1'

function contents(id: number): WebContents {
  return { id, isDestroyed: () => false } as unknown as WebContents
}

/**
 * A browser with one tab whose page stands beneath the reader's cover: `view` answers with the
 * cover (the document in front), `pageView` with the page.
 */
function covered(): {
  browser: Browser
  page: WebContents
  cover: WebContents
  tab: { frozen: boolean; cpuThrottle: number }
} {
  const page = contents(1)
  const cover = contents(2)
  const tab = { id: TAB, title: 'Story', frozen: true, cpuThrottle: 1 }
  const pageView = new (ElectronTabView as unknown as new (wc: WebContents) => object)(page)
  const coverView = new (ElectronTabView as unknown as new (wc: WebContents) => object)(cover)
  const browser = {
    tabs: {
      view: (id: string) => (id === TAB ? coverView : undefined),
      pageView: (id: string) => (id === TAB ? pageView : undefined),
      tab: (id: string) => (id === TAB ? tab : undefined),
      loadedCount: () => 1,
      allViews: () => [[TAB, coverView]],
      allVisibleTabIds: () => new Set<string>()
    },
    state: {
      settings: { resources: { enabled: true, maxLoadedTabs: 1, maxConcurrentLoads: 2 } },
      commit: () => undefined
    },
    allWindows: () => [],
    windows: new Map(),
    platform: { views: {} },
    toast: () => undefined
  } as unknown as Browser
  return { browser, page, cover, tab }
}

/**
 * The governor speaks to the tab's PAGE – the site's memory, media and frozen state – and
 * never to the reader document standing over it: `view()` is the document in front, which the
 * reader's cover is while it stands; the governor reads `pageView()`.
 */
describe('the governor beneath the reader’s cover', () => {
  it('a thaw, a wake and a freeze of a covered tab reach the page’s web contents, not the cover’s', async () => {
    const { browser, page, cover, tab } = covered()
    const governor = new ResourceGovernor(browser)
    const thaw = vi.fn<(wc: WebContents, quiet?: boolean) => Promise<boolean>>(async () => true)
    const freeze = vi.fn<(wc: WebContents) => Promise<boolean>>(async () => true)
    governor.lifecycle.thaw = thaw
    governor.lifecycle.freeze = freeze
    await governor.thaw(TAB)
    expect(thaw).toHaveBeenCalledTimes(1)
    expect(thaw.mock.calls[0][0]).toBe(page)
    await governor.wakeTab(TAB)
    expect(tab.frozen).toBe(false)
    expect(thaw).toHaveBeenCalledTimes(2)
    expect(thaw.mock.calls[1][0]).toBe(page)
    // The tab is not in front of any window here: it may be frozen, and the page is what freezes.
    await governor.freezeTab(TAB)
    expect(freeze).toHaveBeenCalledTimes(1)
    expect(freeze.mock.calls[0][0]).toBe(page)
    expect(tab.frozen).toBe(true)
    for (const call of [...thaw.mock.calls, ...freeze.mock.calls]) expect(call[0]).not.toBe(cover)
  })

  it('a tab with a live page beneath its cover needs no room made for it at the cap', () => {
    const { browser } = covered()
    const governor = new ResourceGovernor(browser)
    const evict = vi.fn()
    ;(governor as unknown as { evictOne: () => void }).evictOne = evict
    governor.makeRoomFor(TAB)
    expect(evict).not.toHaveBeenCalled()
    // A tab with no page at all: the cap makes room.
    governor.makeRoomFor('tab-2')
    expect(evict).toHaveBeenCalledTimes(1)
  })
})
