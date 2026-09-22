// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'

/*
 * Internal pages from the chrome's side: which tabs are chrome pages, what a back does in the
 * Settings tab – a section beneath the one shown is the tab's own history (`tab.back`); at the
 * landing the one root-back rule (`rootBackAction`) closes it back to its opener, to the tab
 * before it, or to the app that sent the deep link – what the host is told ahead of the gesture,
 * and the one call every entry point opens Settings through.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { isPageTab, openPage, openSettings } = await import('../pages')
const { backStore, handleSystemBack, refreshBackState, rootBackAction } = await import('../back')
const { browserStore, openOverlay, overlayAvailable, uiStore } = await import('../ui')
const { viewportStore } = await import('../formFactor')

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url,
    title: url.startsWith('zen://') ? 'Settings' : 'Example',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    fromIntent: false,
    ...patch
  } as Tab
}

/** A window of one or two spaces; `tabs` are the first space's unless they say otherwise. */
function state(tabs: Tab[], activeTabId: string | null, other: Tab[] = []): UIState {
  const space: Space = {
    id: 'space',
    name: 'Personal',
    activeTabId,
    tabIds: tabs.map((t) => t.id)
  } as Space
  const work: Space = {
    id: 'work',
    name: 'Work',
    activeTabId: other[0]?.id ?? null,
    tabIds: other.map((t) => t.id)
  } as Space
  const all = [...tabs, ...other.map((t) => ({ ...t, spaceId: 'work' }))]
  return {
    tabs: Object.fromEntries(all.map((t) => [t.id, t])),
    essentialTabIds: [],
    spaces: other.length ? [space, work] : [space],
    activeSpaceId: 'space',
    folders: {},
    splitGroups: {},
    glance: null,
    capabilities: { pageTabs: true }
  } as unknown as UIState
}

describe('page tabs', () => {
  it('knows a chrome page tab by its address, in either scheme', () => {
    expect(isPageTab(tab('t', 'zen://settings'))).toBe(true)
    expect(isPageTab(tab('t', 'zen://settings/privacy'))).toBe(true)
    expect(isPageTab(tab('t', 'zenium://settings/look'))).toBe(true)
    expect(isPageTab(tab('t', 'zen://history'))).toBe(true)
    expect(isPageTab(tab('t', 'zen://history?q=a.test'))).toBe(true)
    expect(isPageTab(tab('t', 'zen://bookmarks?folder=f1'))).toBe(true)
    expect(isPageTab(tab('t', 'zenium://downloads'))).toBe(true)
    expect(isPageTab(tab('t', 'https://settings.example/'))).toBe(false)
    // Documents – the new tab page among them, registered or not – have a view of their own.
    expect(isPageTab(tab('t', 'zen://newtab'))).toBe(false)
    expect(isPageTab(tab('t', 'zen://blank'))).toBe(false)
    expect(isPageTab(null)).toBe(false)
    expect(isPageTab(undefined)).toBe(false)
  })
})

describe('a back at the landing of the Settings tab (rootBackAction)', () => {
  it('closes the tab back to the tab it was opened from', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings', { openerTabId: 'a' })
    expect(rootBackAction(settings, state([site, settings], 's'))).toBe('opener')
  })

  it('leaves for the app that sent the deep link when there is no opener', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings', { fromIntent: true })
    expect(rootBackAction(settings, state([site, settings], 's'))).toBe('caller')
  })

  it('closes back to the previous tab of the space when the opener is gone or was never there', () => {
    const site = tab('a', 'https://a.test/')
    const orphan = tab('s', 'zen://settings', { openerTabId: 'gone' })
    expect(rootBackAction(orphan, state([site, orphan], 's'))).toBe('previousTab')
    const restored = tab('s', 'zen://settings')
    expect(rootBackAction(restored, state([site, restored], 's'))).toBe('previousTab')
  })

  it('never gives way to a new-tab page: alone in its space it backgrounds the app, pinned it stays', () => {
    const settings = tab('s', 'zen://settings')
    expect(rootBackAction(settings, state([settings], 's'))).toBe('background')
    // A tab in another space is not where the user came from.
    const elsewhere = tab('w', 'https://work.test/')
    expect(rootBackAction(settings, state([settings], 's', [elsewhere]))).toBe('background')
    const pinned = tab('s', 'zen://settings', { pinned: true })
    expect(rootBackAction(pinned, state([tab('a', 'https://a.test/'), pinned], 's'))).toBe(
      'background'
    )
  })

  it('leaves sites to the rules they had', () => {
    const site = tab('a', 'https://a.test/')
    const other = tab('b', 'https://b.test/')
    expect(rootBackAction(site, state([site, other], 'a'))).toBe('newTabPage')
  })
})

describe('the back the host is told about', () => {
  beforeEach(() => {
    invoke.mockClear()
    browserStore.set({ state: null })
  })
  afterEach(() => {
    browserStore.set({ state: null })
  })

  it('claims the back for the chrome while a section sits over the landing (no WebView to ask)', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings/privacy', { canGoBack: true, openerTabId: 'a' })
    browserStore.set({ state: state([site, settings], 's') })
    refreshBackState()
    expect(backStore.get()).toEqual({ chrome: true, tabId: 's', root: true })
  })

  it('reports a root back at the landing while the tab has somewhere to go, none when alone', () => {
    const settings = tab('s', 'zen://settings')
    browserStore.set({ state: state([settings], 's') })
    refreshBackState()
    expect(backStore.get()).toEqual({ chrome: false, tabId: 's', root: false })

    browserStore.set({ state: state([tab('a', 'https://a.test/'), settings], 's') })
    refreshBackState()
    expect(backStore.get()).toEqual({ chrome: false, tabId: 's', root: true })
  })

  it('pops the section with tab.back while one sits over the landing', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings/privacy', { canGoBack: true, openerTabId: 'a' })
    browserStore.set({ state: state([site, settings], 's') })
    expect(uiStore.get().overlay).toBe('none')
    expect(handleSystemBack()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('tab.back', { tabId: 's' })
    expect(invoke).not.toHaveBeenCalledWith('tab.close', expect.anything())
  })

  it('closes the tab back to its opener at the landing', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings', { openerTabId: 'a' })
    browserStore.set({ state: state([site, settings], 's') })
    expect(handleSystemBack()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'a' })
    expect(invoke).toHaveBeenCalledWith('tab.close', { tabId: 's' })
  })

  it('closes the tab back to the most recently active tab when the opener is gone', () => {
    const older = tab('a', 'https://a.test/', { lastActiveAt: 1 })
    const recent = tab('b', 'https://b.test/', { lastActiveAt: 2 })
    const settings = tab('s', 'zen://settings', { openerTabId: 'gone' })
    browserStore.set({ state: state([older, recent, settings], 's') })
    expect(handleSystemBack()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'b' })
    expect(invoke).toHaveBeenCalledWith('tab.close', { tabId: 's' })
  })

  it('has nothing to do when Settings is alone on its landing (the host may leave the app)', () => {
    browserStore.set({ state: state([tab('s', 'zen://settings')], 's') })
    expect(handleSystemBack()).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('opening a page', () => {
  beforeEach(() => invoke.mockClear())

  it('goes through page.open, with the section as given (null lands, absent stays)', () => {
    openSettings()
    openSettings('privacy')
    openSettings(null)
    openPage('settings', 'look')
    expect(invoke.mock.calls.map(([, args]) => args)).toEqual([
      { id: 'settings', section: undefined },
      { id: 'settings', section: 'privacy' },
      { id: 'settings', section: null },
      { id: 'settings', section: 'look' }
    ])
    expect(invoke.mock.calls.every(([name]) => name === 'page.open')).toBe(true)
  })

  it("carries the page's own parameters when the entry has some (Privacy asked for a site)", () => {
    openSettings('privacy', { site: 'https://news.example' })
    expect(invoke).toHaveBeenCalledWith('page.open', {
      id: 'settings',
      section: 'privacy',
      query: { site: 'https://news.example' }
    })
  })
})

describe('the page overlays on a host with page tabs', () => {
  const desktop = viewportStore.get()
  beforeEach(() => {
    invoke.mockClear()
    uiStore.set({ overlay: 'none', overlaySection: null, overlayFolderId: null })
    viewportStore.set({ ...desktop, formFactor: 'desktop' })
  })
  afterEach(() => {
    browserStore.set({ state: null })
    viewportStore.set(desktop)
  })

  it('is not an overlay there: Settings, Shortcuts and Sync open the page’s tab through page.open instead', async () => {
    browserStore.set({ state: state([tab('a', 'https://a.test/')], 'a') })
    expect(overlayAvailable('settings')).toBe(false)
    expect(overlayAvailable('shortcuts')).toBe(false)
    expect(overlayAvailable('sync')).toBe(false)
    // Overlays in their own right, whatever the host: the theme picker, the Boosts panel.
    expect(overlayAvailable('theme')).toBe(true)
    expect(overlayAvailable('boosts')).toBe(true)
    expect(overlayAvailable('passwords')).toBe(true)
    await openOverlay('settings', 'a', null, null, 'privacy')
    await openOverlay('shortcuts', 'a')
    await openOverlay('sync', 'a')
    expect(uiStore.get().overlay).toBe('none')
    expect(invoke.mock.calls.filter(([name]) => name === 'page.open').map(([, a]) => a)).toEqual([
      { id: 'settings', section: 'privacy' },
      { id: 'settings', section: 'shortcuts' },
      { id: 'settings', section: 'sync' }
    ])
    expect(invoke.mock.calls.some(([name]) => name === 'overlay.snapshot')).toBe(false)
  })

  it('opens History, the bookmarks manager and Downloads as page tabs on the desktop and the tablet (v2 §10.1)', async () => {
    browserStore.set({ state: state([tab('a', 'https://a.test/')], 'a') })
    for (const formFactor of ['desktop', 'tablet'] as const) {
      viewportStore.set({ ...desktop, formFactor })
      expect(overlayAvailable('history')).toBe(false)
      expect(overlayAvailable('bookmarks')).toBe(false)
      expect(overlayAvailable('downloads')).toBe(false)
    }
    await openOverlay('history', 'a')
    // The bar's "Bookmark Manager" names the folder it was opened from: the page's `?folder=`.
    await openOverlay('bookmarks', 'a', null, 'f1')
    await openOverlay('downloads', 'a')
    expect(uiStore.get().overlay).toBe('none')
    expect(invoke.mock.calls.filter(([name]) => name === 'page.open').map(([, a]) => a)).toEqual([
      { id: 'history', section: null, query: undefined },
      { id: 'bookmarks', section: null, query: { folder: 'f1' } },
      { id: 'downloads', section: null, query: undefined }
    ])
    expect(invoke.mock.calls.some(([name]) => name === 'overlay.snapshot')).toBe(false)
  })

  it('keeps the phone’s History, Bookmarks and Downloads panels although the host has page tabs', async () => {
    browserStore.set({ state: state([tab('a', 'https://a.test/')], 'a') })
    viewportStore.set({ ...desktop, formFactor: 'phone' })
    expect(overlayAvailable('history')).toBe(true)
    expect(overlayAvailable('bookmarks')).toBe(true)
    expect(overlayAvailable('downloads')).toBe(true)
    // Settings names no layouts: the phone's Settings is the tab too.
    expect(overlayAvailable('settings')).toBe(false)
    await openOverlay('bookmarks', 'a', null, 'f1')
    expect(uiStore.get().overlay).toBe('bookmarks')
    expect(uiStore.get().overlayFolderId).toBe('f1')
    expect(invoke.mock.calls.some(([name]) => name === 'page.open')).toBe(false)
  })

  it('stays the desktop’s overlay where the host has no page tabs', async () => {
    const s = state([tab('a', 'https://a.test/')], 'a')
    browserStore.set({ state: { ...s, capabilities: { pageTabs: false } } as unknown as UIState })
    expect(overlayAvailable('settings')).toBe(true)
    expect(overlayAvailable('history')).toBe(true)
    await openOverlay('shortcuts', 'a')
    expect(uiStore.get().overlay).toBe('shortcuts')
    expect(invoke.mock.calls.some(([name]) => name === 'page.open')).toBe(false)
  })
})
