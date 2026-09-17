import { describe, expect, it } from 'vitest'
import type { Tab } from '../../shared/types'
import type { Browser } from '../browser'
import type { DialogHost, StoreIO } from '../platform'
import { PermissionService } from '../permissions'
import { ACTIVATION_LIFESPAN_MS, PopupBlocker, UserActivation } from '../popups'

function fakeIo(): StoreIO {
  return { readSync: () => null, write: async () => undefined, writeSync: () => undefined }
}

function silentDialogs(): DialogHost {
  return {
    confirm: async () => false,
    pickTextFiles: async () => [],
    saveTextFile: async () => false
  }
}

interface Harness {
  browser: Browser
  clock: { now: number }
  created: Array<{ url: string; afterTabId?: string; active?: boolean }>
  launched: Array<{ tabId: string; url: string }>
  synced: string[]
  commits: () => number
  tabs: Record<string, Tab>
}

function harness(): Harness {
  const clock = { now: 10_000 }
  const created: Harness['created'] = []
  const launched: Harness['launched'] = []
  const synced: string[] = []
  let commits = 0
  const tabs: Record<string, Tab> = {
    t1: { id: 't1', url: 'https://opener.example/page', spaceId: 's1', containerId: 'c1' } as Tab,
    t2: { id: 't2', url: 'https://other.example/', spaceId: 's1', containerId: 'c1' } as Tab
  }
  const permissions = new PermissionService(fakeIo(), silentDialogs())
  const browser = {
    permissions,
    state: {
      commitVolatile: () => {
        commits++
      }
    },
    tabs: {
      tab: (id: string) => tabs[id],
      createTab: (opts: { url: string; afterTabId?: string; active?: boolean }) => {
        created.push({ url: opts.url, afterTabId: opts.afterTabId, active: opts.active })
      },
      windowFor: () => ({}),
      syncPopupPolicy: (origin: string) => {
        synced.push(origin)
      }
    },
    external: {
      launch: async (tabId: string, url: string) => {
        launched.push({ tabId, url })
        return true
      }
    }
  }
  const b = browser as unknown as Browser
  // The blocker reaches itself through the browser (external launches record into it).
  ;(browser as unknown as { popups: PopupBlocker }).popups = new PopupBlocker(b, () => clock.now)
  return { browser: b, clock, created, launched, synced, commits: () => commits, tabs }
}

describe('UserActivation', () => {
  it('is transient: a gesture activates for a few seconds, once', () => {
    const a = new UserActivation()
    expect(a.isActive(0)).toBe(false)
    expect(a.hasBeenActive()).toBe(false)
    a.activate(1000)
    expect(a.isActive(1000)).toBe(true)
    expect(a.isActive(1000 + ACTIVATION_LIFESPAN_MS - 1)).toBe(true)
    expect(a.isActive(1000 + ACTIVATION_LIFESPAN_MS)).toBe(false)
    expect(a.hasBeenActive()).toBe(true)
    a.activate(9000)
    a.consume()
    expect(a.isActive(9001)).toBe(false)
    expect(a.hasBeenActive()).toBe(true)
    a.reset()
    expect(a.hasBeenActive()).toBe(false)
  })
})

describe('PopupBlocker.decide', () => {
  it('blocks a window opened without a gesture and lists it for the tab', () => {
    const h = harness()
    const popups = h.browser.popups
    expect(popups.decide('t1', h.tabs.t1.url, 'https://ads.example/x', null)).toBe('blocked')
    expect(popups.blockedFor('t1')).toEqual([
      { url: 'https://ads.example/x', at: h.clock.now, kind: 'popup' }
    ])
    expect(popups.all()).toEqual({ t1: popups.blockedFor('t1') })
    // The same URL twice is listed once; a tab the browser does not know is ignored.
    popups.decide('t1', h.tabs.t1.url, 'https://ads.example/x', null)
    expect(popups.blockedFor('t1').length).toBe(1)
    popups.record('ghost', 'https://ads.example/y')
    expect(popups.all()).not.toHaveProperty('ghost')
  })

  it('allows one window per gesture the core saw itself', () => {
    const h = harness()
    const popups = h.browser.popups
    popups.activate('t1')
    h.clock.now += 1000
    expect(popups.decide('t1', h.tabs.t1.url, 'https://a.example/', null)).toBe('allow')
    // The gesture is spent: a second window right away is a pop-under.
    expect(popups.decide('t1', h.tabs.t1.url, 'https://b.example/', null)).toBe('blocked')
    // Too late after the gesture.
    popups.activate('t1')
    h.clock.now += ACTIVATION_LIFESPAN_MS
    expect(popups.decide('t1', h.tabs.t1.url, 'https://c.example/', null)).toBe('blocked')
    expect(popups.blockedFor('t1').map((p) => p.url)).toEqual([
      'https://b.example/',
      'https://c.example/'
    ])
  })

  it("trusts the host's own gesture verdict where it has one", () => {
    const h = harness()
    const popups = h.browser.popups
    expect(popups.decide('t1', h.tabs.t1.url, 'https://a.example/', true)).toBe('allow')
    expect(popups.decide('t1', h.tabs.t1.url, 'https://b.example/', false)).toBe('blocked')
  })

  it('lets an allowed site open windows without a gesture and never a blocked one', () => {
    const h = harness()
    const popups = h.browser.popups
    h.browser.permissions.remember('popups', h.tabs.t1.url, 'allow')
    expect(popups.siteAllowed(h.tabs.t1.url)).toBe(true)
    expect(popups.decide('t1', h.tabs.t1.url, 'https://a.example/', null)).toBe('allow')
    expect(popups.decide('t1', h.tabs.t1.url, 'https://b.example/', false)).toBe('allow')
    h.browser.permissions.remember('popups', h.tabs.t2.url, 'deny')
    popups.activate('t2')
    expect(popups.decide('t2', h.tabs.t2.url, 'https://c.example/', true)).toBe('blocked')
  })

  it('starts over on a new document and forgets a closed tab', () => {
    const h = harness()
    const popups = h.browser.popups
    popups.activate('t1')
    popups.record('t1', 'https://x.example/')
    popups.onNavigated('t1', true)
    expect(popups.blockedFor('t1').length).toBe(1)
    expect(popups.activation('t1').hasBeenActive()).toBe(true)
    popups.onNavigated('t1', false)
    expect(popups.blockedFor('t1')).toEqual([])
    expect(popups.activation('t1').hasBeenActive()).toBe(false)
    popups.record('t2', 'https://y.example/')
    popups.onTabGone('t2')
    expect(popups.all()).toEqual({})
  })
})

describe('PopupBlocker: the user opens what was blocked', () => {
  it('opens one blocked page as a tab next to its opener', () => {
    const h = harness()
    const popups = h.browser.popups
    popups.record('t1', 'https://a.example/')
    popups.record('t1', 'https://b.example/')
    popups.open('t1', 'https://a.example/')
    expect(h.created).toEqual([{ url: 'https://a.example/', afterTabId: 't1', active: true }])
    expect(popups.blockedFor('t1').map((p) => p.url)).toEqual(['https://b.example/'])
    popups.open('t1', 'https://nope.example/')
    expect(h.created.length).toBe(1)
    popups.dismiss('t1')
    expect(popups.all()).toEqual({})
  })

  it('hands a blocked app launch to the external-app prompt instead', () => {
    const h = harness()
    const popups = h.browser.popups
    popups.record('t1', 'zoommtg://join?x', 'external')
    popups.open('t1', 'zoommtg://join?x')
    expect(h.created).toEqual([])
    expect(h.launched).toEqual([{ tabId: 't1', url: 'zoommtg://join?x' }])
  })

  it('"always allow" remembers the site, tells its pages and opens the blocked windows', () => {
    const h = harness()
    const popups = h.browser.popups
    popups.record('t1', 'https://a.example/')
    popups.record('t1', 'tel:+123', 'external')
    popups.setSiteAllowed('t1', true)
    expect(h.browser.permissions.stored('popups', h.tabs.t1.url)).toBe('allow')
    expect(h.synced).toEqual(['https://opener.example'])
    expect(h.created.map((c) => c.url)).toEqual(['https://a.example/'])
    // App launches still need the user's say-so; they stay listed.
    expect(popups.blockedFor('t1')).toEqual([
      { url: 'tel:+123', at: h.clock.now, kind: 'external' }
    ])
    popups.setSiteAllowed('t1', false)
    expect(h.browser.permissions.stored('popups', h.tabs.t1.url)).toBe(null)
    expect(h.synced.length).toBe(2)
    // Nothing happens for a tab the browser does not know or a page without an origin.
    popups.setSiteAllowed('ghost', true)
    h.tabs.t1.url = 'about:blank'
    popups.setSiteAllowed('t1', true)
    expect(h.browser.permissions.rules()).toEqual([])
  })

  it('re-renders the chrome whenever the list changes', () => {
    const h = harness()
    const before = h.commits()
    h.browser.popups.record('t1', 'https://a.example/')
    h.browser.popups.dismiss('t1')
    h.browser.popups.dismiss('t1')
    expect(h.commits() - before).toBe(2)
  })
})
