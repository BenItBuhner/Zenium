import { describe, expect, it, vi } from 'vitest'
import type {
  EventName,
  Events,
  HostCapabilities,
  Platform as PlatformOs,
  Tab
} from '@shared/types'
import { BLANK_URL, NEW_TAB_URL } from '@shared/url'
import { Browser } from '@core/browser'
import { createTabRecord } from '@core/model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { landFromIntent, type LandingSurfaces } from '../landing'
import { androidCapabilities } from '../platform'
import { bootNeedsPlacement, healRestoredBlankTab } from '../startup'

/*
 * The boot's first tab on the phone (the P0 hotfix after #490, W5-F2): `Browser.ensureFirstTab`
 * gives every startup window a fresh tab so that no window comes up without one – on a host
 * with the new tab page that tab is `zen://newtab`, a chrome page READY has nothing to wait for.
 * The phone has no new tab page capability (`platform.ts` `newTabPage: false`): the fresh tab
 * would be `zen://blank`, which the chrome never places (`useLayoutReporter` leaves the blank
 * page out of every layout report and draws its own page there), so `bootAndroid`'s READY armed
 * on it waited for a placement that never came, and the splash held to the host's watchdog on
 * every fresh profile's start. The phone starts as it did before #490: the window without a tab,
 * READY on the theme's paint and the insets, the first run ending in the omnibox. And a profile
 * restored on a blank tab – the one #490's first tab left in every profile made on v0.4.71 to
 * v0.4.74, or one the user is on – arms READY without a placement to wait for, as the phone's
 * chrome never places that view; the tablet, which does, waits for it as for any page.
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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function fakeView(tab: Tab): TabView {
  let url = tab.url
  let destroyed = false
  return stub<TabView>({
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    loadURL: (u: string) => {
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    isVisible: () => true
  })
}

/**
 * The phone's capability table as `AndroidPlatform` builds it (API 34, no extension root), with
 * the hosts that would need a live bridge switched off, as the other Android suites do. What the
 * boot's first tab turns on – `newTabPage` false, `pageTabs` true, one window – is the real table's.
 */
function phoneCapabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    ...androidCapabilities({ sdkInt: 34, extensions: false, isolatedWorlds: true }),
    updates: false,
    agents: false,
    passwords: false,
    sync: false,
    translate: false,
    ...overrides
  }
}

/** A browser on a phone-shaped host, not yet started; the window host records what it is sent. */
function phone(capabilities: HostCapabilities): {
  browser: Browser
  sent: Array<{ name: EventName; payload: unknown }>
} {
  const sent: Array<{ name: EventName; payload: unknown }> = []
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 400, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: <K extends EventName>(name: K, payload: Events[K]) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => fakeView(tab)
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
  return { browser: new Browser(platform), sent }
}

const only = (browser: Browser): ZenWindow => {
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

/** A page tab in the model's first space, as the last run left it. */
function seedTab(browser: Browser, url: string): string {
  const { state } = browser
  const space = state.model.spaces[0]
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
  state.model.tabs[tab.id] = tab
  space.tabIds.push(tab.id)
  space.activeTabId = tab.id
  return tab.id
}

describe("the boot's first tab on the phone (no new tab page capability)", () => {
  it('a fresh profile starts with no tab, so READY is armed without a placement to wait for', () => {
    const { browser } = phone(phoneCapabilities())
    expect(browser.state.settings.startup.mode).toBe('continue')
    browser.start()
    const win = only(browser)
    expect(browser.allWindows()).toHaveLength(1)
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
    expect(browser.tabs.activeTabFor(win)).toBeUndefined()
    expect(bootNeedsPlacement(browser, win, true)).toBe(false)
  })

  it('the boot itself raises no omnibox: the first run comes up without the keyboard', () => {
    // #490's fresh tab queued the new-tab omnibox for the chrome's ready (`urlbarOnReady`), so
    // main's fresh start put the keyboard up under the first-run overlay.
    const { browser, sent } = phone(phoneCapabilities())
    browser.start()
    const win = only(browser)
    sent.length = 0
    vi.useFakeTimers()
    try {
      win.onChromeReady()
      vi.advanceTimersByTime(1000)
    } finally {
      vi.useRealTimers()
    }
    expect(sent.filter((e) => e.name === 'urlbar.toggle')).toEqual([])
    expect(sent.some((e) => e.name === 'newtab.opened')).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
  })

  it('a first run past onboarding starts the same way: no tab', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    browser.start()
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
    expect(bootNeedsPlacement(browser, only(browser), true)).toBe(false)
  })

  it('the first run still ends in the omnibox over the empty space, as before #490', () => {
    const { browser, sent } = phone(phoneCapabilities())
    browser.start()
    const win = only(browser)
    sent.length = 0
    browser.handleCommand(win, 'onboarding.complete', {
      searchEngineId: browser.state.settings.searchEngineId,
      colorScheme: 'system',
      essentials: []
    })
    expect(browser.state.settings.onboardingDone).toBe(true)
    // No tab was made for the tour's end: the new-tab omnibox goes up over the empty space.
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
    expect(sent.filter((e) => e.name === 'urlbar.toggle').map((e) => e.payload)).toEqual([
      { mode: 'new-tab' }
    ])
    expect(sent.some((e) => e.name === 'newtab.opened')).toBe(false)
  })

  it('a restored profile whose active tab is a page keeps it, and READY waits for its placement', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    const id = seedTab(browser, 'https://open.example/')
    browser.start()
    const win = only(browser)
    expect(browser.tabs.activeTabFor(win)?.id).toBe(id)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
    expect(bootNeedsPlacement(browser, win, true)).toBe(true)
  })

  it('a restored space emptied of its tabs comes up empty too, as before #490', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    browser.start()
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
    expect(bootNeedsPlacement(browser, only(browser), true)).toBe(false)
  })

  it('a host with the new tab page keeps #490: one new tab page tab at startup', () => {
    // The capability is the whole difference between the hosts. The new tab page is a document
    // the host serves (`render: 'document'`, not a registry chrome page), so on a host that has
    // it the tab is a page view the host places, and the arm reads it as one.
    const { browser } = phone(phoneCapabilities({ newTabPage: true }))
    browser.state.settings.onboardingDone = true
    browser.start()
    const win = only(browser)
    expect(Object.values(browser.state.model.tabs).map((t) => t.url)).toEqual([NEW_TAB_URL])
    expect(browser.tabs.activeTabFor(win)?.url).toBe(NEW_TAB_URL)
    expect(bootNeedsPlacement(browser, win, true)).toBe(true)
  })

  it("a profile restored on the phone's own new tab (a blank tab) arms READY without a placement to wait for", () => {
    // The blank tab #490's first tab left in every profile made on v0.4.71–v0.4.74, and any blank
    // tab the user is on: the phone draws its new tab page in the chrome and reports no placement
    // for the tab, so the arm reads it as nothing to place (as `useLayoutReporter` leaves it out).
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    const id = seedTab(browser, BLANK_URL)
    browser.start()
    const win = only(browser)
    expect(browser.tabs.activeTabFor(win)?.id).toBe(id)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
    expect(bootNeedsPlacement(browser, win, true)).toBe(false)
  })

  it('the tablet places the blank view like any page, so its arm waits for it', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    seedTab(browser, BLANK_URL)
    browser.start()
    expect(bootNeedsPlacement(browser, only(browser), false)).toBe(true)
  })
})

/*
 * The heal (W6-HF2, hole 1): every phone profile made on v0.4.71–v0.4.76 restores with #490's
 * `zen://blank` tab as the space's only tab – the phone's new tab page where the space was empty
 * before #490. `healRestoredBlankTab` closes that tab once, right after `browser.start()` and
 * before the boot opens anything of its own, so the space is empty again and the arm reads the
 * healed state. The rules: the phone only; the window's active tab, exactly `zen://blank`; the
 * only tab the active space has; no history in the profile or on the tab. Everything else stays.
 */
describe("the heal of #490's restored blank tab on the phone", () => {
  /** A phone past its first run, restored on one blank tab, as v0.4.71–v0.4.76 left it. */
  function upgraded(): { browser: Browser; id: string; win: ZenWindow } {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    const id = seedTab(browser, BLANK_URL)
    browser.start()
    return { browser, id, win: only(browser) }
  }

  it('closes the lone restored blank tab: the space is empty again, the arm reads no placement', () => {
    const { browser, id, win } = upgraded()
    expect(browser.tabs.activeTabFor(win)?.id).toBe(id)
    expect(healRestoredBlankTab(browser, win, true)).toBe(true)
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
    expect(browser.tabs.activeTabFor(win)).toBeUndefined()
    expect(win.activeSpace().tabIds).toEqual([])
    expect(bootNeedsPlacement(browser, win, true)).toBe(false)
    // An unvisited blank tab leaves no "Recently closed" entry behind (`captureClosed`).
    expect(browser.state.recentlyClosed).toEqual([])
  })

  it('heals exactly once: the healed profile has nothing to heal at its next boot', () => {
    const { browser, win } = upgraded()
    expect(healRestoredBlankTab(browser, win, true)).toBe(true)
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
  })

  it('leaves a blank tab that carries history (a back/forward stack with a page in it)', () => {
    const { browser, id, win } = upgraded()
    browser.state.tabNavigation.set(id, {
      entries: [
        { url: 'https://visited.example/', title: 'Visited' },
        { url: BLANK_URL, title: '' }
      ],
      index: 1
    })
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
  })

  it('leaves a blank tab that can go back or forward', () => {
    const { browser, id, win } = upgraded()
    browser.state.model.tabs[id].canGoBack = true
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
  })

  it('leaves a blank tab that sits among other restored tabs (the user opened more since)', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    const blank = seedTab(browser, BLANK_URL)
    const page = seedTab(browser, 'https://open.example/')
    // Back on the blank tab, as the last run left it.
    browser.state.model.spaces[0].activeTabId = blank
    browser.start()
    const win = only(browser)
    expect(browser.tabs.activeTabFor(win)?.id).toBe(blank)
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs).sort()).toEqual([blank, page].sort())
    // The arm still reads the blank tab as nothing to place (#503).
    expect(bootNeedsPlacement(browser, win, true)).toBe(false)
  })

  it('leaves a restored page tab alone', () => {
    const { browser } = phone(phoneCapabilities())
    browser.state.settings.onboardingDone = true
    const id = seedTab(browser, 'https://open.example/')
    browser.start()
    const win = only(browser)
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
    expect(bootNeedsPlacement(browser, win, true)).toBe(true)
  })

  it('does nothing on a fresh profile (no tab to heal)', () => {
    const { browser } = phone(phoneCapabilities())
    browser.start()
    const win = only(browser)
    expect(healRestoredBlankTab(browser, win, true)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([])
  })

  it("never touches the tablet's restored blank tab (its view is placed like any page)", () => {
    const { browser, id, win } = upgraded()
    expect(healRestoredBlankTab(browser, win, false)).toBe(false)
    expect(Object.keys(browser.state.model.tabs)).toEqual([id])
    expect(bootNeedsPlacement(browser, win, false)).toBe(true)
  })

  it('never closes the blank tab a widget or shortcut landing makes: the heal runs before the landing', () => {
    // `bootAndroid`'s order: `browser.start()`, the heal, then `landFromIntent` for the boot's
    // landing, the host queue's flush (an intent's page), and the arm. A landing over the
    // upgraded profile: the restored blank tab goes, the landing's own blank tab stands.
    const { browser, id, win } = upgraded()
    expect(healRestoredBlankTab(browser, win, true)).toBe(true)
    const surfaces: LandingSurfaces = {
      omnibox: () => undefined,
      voice: () => undefined,
      scan: () => undefined,
      unavailable: () => undefined
    }
    const landed = landFromIntent('search', browser, win, surfaces, (fn) => fn())
    expect(landed).not.toBeNull()
    expect(landed?.url).toBe(BLANK_URL)
    expect(landed?.id).not.toBe(id)
    expect(browser.tabs.activeTabFor(win)?.id).toBe(landed?.id)
    expect(Object.keys(browser.state.model.tabs)).toEqual([landed?.id])
    // A second heal at this point would take the landing's tab – the order is the guard.
    expect(bootNeedsPlacement(browser, win, true)).toBe(false)
  })
})
