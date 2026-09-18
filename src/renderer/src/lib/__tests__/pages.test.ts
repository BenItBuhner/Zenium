// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'

/*
 * Internal pages from the chrome's side: which tabs are pages, when a system back inside the
 * Settings tab is the chrome's to answer (a section beneath the one shown, or a tab to return
 * to) and when it is the system's, and the one call every entry point opens Settings through.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { isPageTab, openPage, openSettings, pageTabWithBack } = await import('../pages')
const { backStore, handleSystemBack, refreshBackState } = await import('../back')
const { browserStore, uiStore } = await import('../ui')

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
  it('knows a page tab by its address, in either scheme', () => {
    expect(isPageTab(tab('t', 'zen://settings'))).toBe(true)
    expect(isPageTab(tab('t', 'zen://settings/privacy'))).toBe(true)
    expect(isPageTab(tab('t', 'zenium://settings/look'))).toBe(true)
    expect(isPageTab(tab('t', 'https://settings.example/'))).toBe(false)
    expect(isPageTab(tab('t', 'zen://newtab'))).toBe(false)
    expect(isPageTab(null)).toBe(false)
    expect(isPageTab(undefined)).toBe(false)
  })
})

describe('a system back inside the Settings tab', () => {
  it('is the chrome’s while a section sits over the landing', () => {
    const settings = tab('s', 'zen://settings/privacy', { canGoBack: true })
    expect(pageTabWithBack(state([settings], 's'))).toBe(settings)
  })

  it('is the chrome’s on the landing while another tab of the space can be returned to', () => {
    const settings = tab('s', 'zen://settings')
    const site = tab('a', 'https://a.test/')
    expect(pageTabWithBack(state([site, settings], 's'))).toBe(settings)
  })

  it('is the system’s when Settings is the only tab of its space and shows its landing', () => {
    const settings = tab('s', 'zen://settings')
    expect(pageTabWithBack(state([settings], 's'))).toBeNull()
    // A tab in another space is not where the page service would return to.
    const elsewhere = tab('w', 'https://work.test/')
    expect(pageTabWithBack(state([settings], 's', [elsewhere]))).toBeNull()
  })

  it('is nobody’s business when the active tab is a site, or there is none', () => {
    const site = tab('a', 'https://a.test/', { canGoBack: true })
    const settings = tab('s', 'zen://settings/look', { canGoBack: true })
    expect(pageTabWithBack(state([site, settings], 'a'))).toBeNull()
    expect(pageTabWithBack(state([site, settings], null))).toBeNull()
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

  it('registers the chrome for a page tab with somewhere to go, not for a page tab without', () => {
    const settings = tab('s', 'zen://settings')
    browserStore.set({ state: state([settings], 's') })
    refreshBackState()
    expect(backStore.get()).toEqual({ chrome: false, tabId: 's' })

    browserStore.set({ state: state([tab('a', 'https://a.test/'), settings], 's') })
    refreshBackState()
    expect(backStore.get()).toEqual({ chrome: true, tabId: 's' })
  })

  it('answers a back on a page tab with page.back, ahead of the tab’s own history', () => {
    const site = tab('a', 'https://a.test/')
    const settings = tab('s', 'zen://settings/privacy', { canGoBack: true })
    browserStore.set({ state: state([site, settings], 's') })
    expect(uiStore.get().overlay).toBe('none')
    expect(handleSystemBack()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('page.back', { tabId: 's' })
    expect(invoke).not.toHaveBeenCalledWith('tab.back', expect.anything())
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
})
