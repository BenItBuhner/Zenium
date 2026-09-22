// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClosedEntrySummary,
  HistoryDayGroup,
  SyncDeviceTabs,
  SyncStatus,
  Tab,
  UIState
} from '@shared/types'
import { dayKeyOf } from '@shared/dayKey'

/*
 * The History page tab (design language v2 §10.1; Chrome's chrome://history): the title block
 * with "Clear browsing data…", the search field that filters through `history.grouped` and
 * moves the tab's URL to `zen://history?q=` without a history entry, the day groups as §9.27
 * headings (their ⋮ on approach) over §9.21 two-line rows with no slot held at rest, selection
 * as a mode (§9.6, §10.1: entered by Ctrl/Shift-click, the row menu's Select or Ctrl+A, the
 * checkbox column on every row while it lasts, the count, Delete and Cancel in the title block's
 * slot), Recently closed as the page's first group, the other devices' tabs after it (ID-28:
 * each device its own group, folding for the session; the one "Tabs from other devices" group
 * with its §9.17 line and the row to Settings › Sync when there is nothing to list), and the
 * §9.17 empty state.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DAY = 86_400_000
const NOW = Date.now()
const TODAY = dayKeyOf(NOW)
const YESTERDAY = dayKeyOf(NOW - DAY)
const WEEKDAY = dayKeyOf(NOW - 3 * DAY)
const DATED = dayKeyOf(NOW - 10 * DAY)
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const GROUPS: HistoryDayGroup[] = [
  {
    dayKey: TODAY,
    visits: [
      {
        id: 'v1',
        url: 'https://example.com/docs',
        title: 'Example docs',
        favicon: null,
        visitTime: NOW - 60_000,
        transition: 'link'
      },
      {
        id: 'v2',
        url: 'https://news.example.org/story',
        title: 'A story',
        favicon: null,
        visitTime: NOW - 120_000,
        transition: 'typed'
      }
    ]
  },
  {
    dayKey: YESTERDAY,
    visits: [
      {
        id: 'v3',
        url: 'https://zen-browser.app/',
        title: 'Zen',
        favicon: null,
        visitTime: NOW - DAY,
        transition: 'link'
      }
    ]
  },
  {
    dayKey: WEEKDAY,
    visits: [
      {
        id: 'v4',
        url: 'https://react.dev/',
        title: 'React',
        favicon: null,
        visitTime: NOW - 3 * DAY,
        transition: 'link'
      }
    ]
  },
  {
    dayKey: DATED,
    visits: [
      {
        id: 'v5',
        url: 'https://developer.mozilla.org/',
        title: 'MDN',
        favicon: null,
        visitTime: NOW - 10 * DAY,
        transition: 'link'
      }
    ]
  }
]

const CLOSED: ClosedEntrySummary[] = [
  {
    id: 'c1',
    kind: 'tab',
    title: 'Settings',
    url: 'zen://settings',
    favicon: null,
    closedAt: NOW - 30_000,
    tabCount: 1
  },
  {
    id: 'c2',
    kind: 'tab',
    title: 'Example Domain',
    url: 'https://www.example.com/about',
    favicon: null,
    closedAt: NOW - 60_000,
    tabCount: 1
  }
]

/** Two other devices' open tabs, the phone's list the newer (`sync.tabsFromDevices` answers newest first). */
const DEVICES: SyncDeviceTabs[] = [
  {
    deviceId: 'phone',
    deviceName: 'Pixel 9',
    updatedAt: NOW - 5 * 60_000,
    tabs: [
      {
        tabId: 'p1',
        url: 'https://www.wikipedia.org/wiki/Zen',
        title: 'Zen – Wikipedia',
        favicon: null,
        lastActive: NOW - 5 * 60_000,
        windowId: null
      },
      {
        tabId: 'p2',
        url: 'https://recipes.example.net/ragu',
        title: 'Slow-cooked ragù',
        favicon: 'data:image/png;base64,iVBORw0KGgo=',
        lastActive: NOW - 9 * 60_000,
        windowId: null
      }
    ]
  },
  {
    deviceId: 'work',
    deviceName: 'Work laptop',
    updatedAt: NOW - 3 * 3_600_000,
    tabs: [
      {
        tabId: 'held-1',
        url: 'https://github.com/BenItBuhner/Zenium/pulls',
        title: 'Pull requests · Zenium',
        favicon: null,
        lastActive: NOW - 3 * 3_600_000,
        windowId: null
      }
    ]
  }
]

let groups: HistoryDayGroup[] = GROUPS
let closed: ClosedEntrySummary[] = CLOSED
let devices: SyncDeviceTabs[] = []
/** The core's folded devices (`history.foldedDevices`), as the session holds them. */
let folded: string[] = []
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'history.grouped') return groups
  if (name === 'session.recentlyClosed') return closed
  if (name === 'sync.tabsFromDevices') return devices
  if (name === 'history.foldedDevices') return folded
  return null
})
/** The core's events the page listens for, fired by name. */
const listeners = new Map<string, Set<(payload: unknown) => void>>()
Object.assign(window, {
  zen: {
    invoke,
    on: (name: string, fn: (payload: unknown) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => set.delete(fn)
    }
  }
})
function emit(name: string, payload: unknown): void {
  for (const fn of listeners.get(name) ?? []) fn(payload)
}

const { HistoryPage } = await import('../HistoryPage')

/** Each status a test hands in carries a version of its own: the reader asks the core once per version. */
let version = 0

/** The sync status: off, or on with Open tabs among what it syncs (`openTabs` says whether). */
function sync(enabled: boolean, openTabs = true): SyncStatus {
  return {
    enabled,
    folder: enabled ? '/home/me/Sync' : null,
    folderName: enabled ? 'Sync' : null,
    folderLost: false,
    deviceId: 'this',
    deviceName: 'This laptop',
    scope: {
      spaces: true,
      folders: true,
      pinnedTabs: true,
      essentials: true,
      openTabs,
      containers: true,
      bookmarks: true,
      passwords: true,
      settings: true,
      shortcuts: true,
      boosts: true,
      history: true
    },
    lastSyncAt: enabled ? NOW - 60_000 : null,
    lastError: null,
    syncing: false,
    devices: enabled ? [{ id: 'phone', name: 'Pixel 9', lastSeen: NOW - 5 * 60_000 }] : [],
    pendingMerge: false,
    remoteTabsVersion: ++version
  }
}

/** What the page reads of the state: the sync capability and status, and this device's tabs. */
function state(status: SyncStatus = sync(false), held: string[] = []): UIState {
  return {
    capabilities: { sync: true },
    sync: status,
    tabs: Object.fromEntries(held.map((id) => [id, { id, url: 'https://held.example/' }]))
  } as unknown as UIState
}

function tab(url = 'zen://history'): Tab {
  return {
    id: 'history',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'History',
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
    openerTabId: null
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function mountPage(t: Tab = tab(), s: UIState = state()): Promise<HTMLElement> {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(HistoryPage, { state: s, tab: t })))
  await flush()
  return mount
}

async function rerender(t: Tab, s: UIState = state()): Promise<void> {
  await act(async () => root!.render(createElement(HistoryPage, { state: s, tab: t })))
  await flush()
}

/** The page mounted again in the same session (a second History tab, or the tab reopened). */
async function remount(t: Tab, s: UIState): Promise<HTMLElement> {
  act(() => root!.unmount())
  mount?.remove()
  return mountPage(t, s)
}

/** Let the fetches resolve and their state land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** Every `invoke` of `name`, in order. */
function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A click on a visit row's target (its text), with the modifiers a pointer would carry. */
function rowClick(el: HTMLElement, id: string, init: MouseEventInit = {}): void {
  el.querySelector<HTMLButtonElement>(
    `[data-visit-id="${id}"] button[data-row-focus]`
  )!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
}

/** The page's session store of folded devices, one per chrome document: a fresh one per test. */
function freshFoldStore(): void {
  const stores = (globalThis as { __zenStores?: Record<string, { set: (p: object) => void }> })
    .__zenStores
  stores?.historyCollapsedDevices?.set({ ids: new Set(), asked: false })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  groups = GROUPS
  closed = CLOSED
  devices = []
  folded = []
  freshFoldStore()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.useRealTimers()
})

describe('the History page tab (§10.1)', () => {
  it('draws the title block with Clear browsing data… and the search field, no overlay chrome', async () => {
    const el = await mountPage()
    const page = el.querySelector('[data-testid="history-page"]')!
    expect(page.classList.contains('zen-page')).toBe(true)
    const title = page.querySelector('h1.zen-page-title')
    expect(text(title)).toBe('History')
    const clear = page.querySelector('[data-testid="history-clear-browsing-data"]')!
    expect(text(clear)).toBe('Clear browsing data…')
    expect(clear.classList.contains('zen-v2-button')).toBe(true)
    const field = page.querySelector<HTMLInputElement>('[data-testid="history-search"]')!
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('placeholder')).toBe('Search history')
    // Nothing of the overlay shell: no close button, no panel.
    expect(page.querySelector('[aria-label="Close"]')).toBeNull()
    expect(page.querySelector('.zen-overlay-shell, .zen-history')).toBeNull()
    // The header is the sticky part of the scroll column.
    expect(page.querySelector('.zen-page-scroll > header.zen-page-header')).not.toBeNull()
  })

  it('groups the visits by day under §9.27 headings, each a §9.21 two-line row', async () => {
    const el = await mountPage()
    expect(calls('history.grouped')).toEqual([{ query: { text: undefined, limit: 300 } }])
    const headings = [...el.querySelectorAll('.zen-page-group h2')].map(text)
    // The phone list's vocabulary (`historyGroups.ts`): a day within the week is its weekday,
    // an older one the date – "Friday", then "Friday, September 11".
    const weekday = WEEKDAY_NAMES[new Date(NOW - 3 * DAY).getDay()]!
    // Sync is off in the default state: the one "Tabs from other devices" group stands after
    // Recently closed with its §9.17 line (the devices' own groups take its place when it is on).
    expect(headings).toEqual([
      'Recently closed',
      'Tabs from other devices',
      'Today',
      'Yesterday',
      weekday,
      new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: DATED.slice(0, 4) === TODAY.slice(0, 4) ? undefined : 'numeric',
        timeZone: 'UTC'
      }).format(new Date(`${DATED}T12:00:00Z`))
    ])
    const today = el.querySelector(`[data-day="${TODAY}"]`)!
    expect(text(today.querySelector('.zen-page-heading-aside'))).toBe('2')
    // The day's ⋮ follows the rows' rule – on approach – so at rest the heading is its text and
    // count; Recently closed's clear the same. Both stay buttons in the tab order.
    const dayMenu = today.querySelector('.zen-page-heading > button[aria-haspopup="menu"]')!
    expect(dayMenu.classList.contains('zen-page-heading-reveal')).toBe(true)
    expect(dayMenu.getAttribute('aria-label')).toBe('Options for Today')
    expect(
      el
        .querySelector('[data-testid="history-recently-closed"] .zen-page-heading > button')!
        .classList.contains('zen-page-heading-reveal')
    ).toBe(true)
    const rows = [...today.querySelectorAll('li.zen-v2-row.zen-page-row')]
    expect(rows).toHaveLength(2)
    const first = rows[0]!
    expect(first.getAttribute('data-visit-id')).toBe('v1')
    // The favicon leads the row: no checkbox and no slot held for one at rest, on any row.
    expect(first.firstElementChild!.classList.contains('zen-page-row-lead')).toBe(true)
    expect(el.querySelectorAll('.zen-page-row-check, input.zen-v2-checkbox')).toHaveLength(0)
    expect(text(first.querySelector('.zen-page-row-label'))).toBe('Example docs')
    expect(text(first.querySelector('.zen-page-row-desc'))).toBe('example.com')
    expect(first.querySelector('time.zen-page-row-time')).not.toBeNull()
    expect(first.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
  })

  it('opens a row in the tab, in a new tab on a middle click (Ctrl-click picks), and anchors the ⋮ on the row menu', async () => {
    const el = await mountPage()
    const row = el.querySelector('[data-visit-id="v1"]')!
    const target = row.querySelector<HTMLButtonElement>('button[data-row-focus]')!
    await act(async () => target.click())
    expect(calls('urlbar.submit').at(-1)).toEqual({
      input: 'https://example.com/docs',
      newTab: false,
      tabId: 'history'
    })
    await act(async () =>
      target.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    )
    expect(calls('urlbar.submit').at(-1)).toMatchObject({ newTab: true })
    expect(calls('urlbar.submit')).toHaveLength(2)
    const more = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Example docs"]'
    )!
    await act(async () => more.click())
    expect(calls('history.contextMenu').at(-1)).toMatchObject({
      visitId: 'v1',
      url: 'https://example.com/docs'
    })
  })

  it('selection is a mode (§9.6, §10.1): Ctrl-click enters it, the checkbox column shows on every row, the slot shows the count, Delete removes the picked and leaves it', async () => {
    const el = await mountPage()
    const row = el.querySelector('[data-visit-id="v1"]')!
    await act(async () => rowClick(el, 'v1', { ctrlKey: true }))
    // Picked, not opened.
    expect(calls('urlbar.submit')).toEqual([])
    expect(row.hasAttribute('data-selected')).toBe(true)
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('1 selected')
    expect(el.querySelector('[data-testid="history-clear-browsing-data"]')).toBeNull()
    expect(el.querySelector('[data-selecting]')).not.toBeNull()
    // The column: a checkbox on each of the five visit rows, the two closed rows holding its
    // width so every favicon on the page moved as one.
    expect(
      el.querySelectorAll('[data-visit-id] input.zen-v2-checkbox.zen-page-row-check')
    ).toHaveLength(5)
    expect(el.querySelectorAll('[data-closed-id] .zen-page-row-check')).toHaveLength(2)
    expect(row.firstElementChild!.classList.contains('zen-page-row-check')).toBe(true)
    // In the mode a row's checkbox and a plain click on the row both pick or drop it.
    const second = el.querySelector<HTMLInputElement>('[data-visit-id="v2"] input.zen-v2-checkbox')!
    await act(async () => second.click())
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('2 selected')
    await act(async () => rowClick(el, 'v3'))
    expect(calls('urlbar.submit')).toEqual([])
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('3 selected')
    await act(async () => rowClick(el, 'v3'))
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('2 selected')
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[data-testid="history-delete-selected"]')!.click()
    )
    expect(calls('history.deleteVisits')).toEqual([{ ids: ['v1', 'v2'] }])
    // Deleting the selection leaves the mode: the column goes, the slot is Clear browsing
    // data… again, a plain click opens.
    expect(el.querySelector('.zen-page-title-count')).toBeNull()
    expect(el.querySelector('[data-selecting]')).toBeNull()
    expect(el.querySelectorAll('.zen-page-row-check')).toHaveLength(0)
    expect(el.querySelector('[data-testid="history-clear-browsing-data"]')).not.toBeNull()
    await act(async () => rowClick(el, 'v3'))
    expect(calls('urlbar.submit')).toEqual([
      { input: 'https://zen-browser.app/', newTab: false, tabId: 'history' }
    ])
  })

  it('Shift-click picks the run from the last picked row; Ctrl+A picks every visit shown; Escape leaves the mode', async () => {
    const el = await mountPage()
    await act(async () => rowClick(el, 'v2', { ctrlKey: true }))
    await act(async () => rowClick(el, 'v4', { shiftKey: true }))
    expect(
      [...el.querySelectorAll('[data-selected]')].map((r) => r.getAttribute('data-visit-id'))
    ).toEqual(['v2', 'v3', 'v4'])
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('3 selected')
    const target = el.querySelector<HTMLButtonElement>(
      '[data-visit-id="v1"] button[data-row-focus]'
    )!
    target.focus()
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    )
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('5 selected')
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(el.querySelector('[data-selected]')).toBeNull()
    expect(el.querySelectorAll('.zen-page-row-check')).toHaveLength(0)
    // Ctrl+A with nothing picked enters the mode by itself.
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    )
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('5 selected')
    expect(el.querySelectorAll('[data-visit-id] input.zen-v2-checkbox')).toHaveLength(5)
  })

  it('"Select" in the row’s ⋮ menu (the core’s history.select) picks the row and enters the mode; dropping the last picked leaves it', async () => {
    const el = await mountPage()
    await act(async () => emit('history.select', { visitId: 'v3' }))
    expect(el.querySelector('[data-visit-id="v3"]')!.hasAttribute('data-selected')).toBe(true)
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('1 selected')
    expect(el.querySelectorAll('[data-visit-id] input.zen-v2-checkbox')).toHaveLength(5)
    await act(async () =>
      el.querySelector<HTMLInputElement>('[data-visit-id="v3"] input.zen-v2-checkbox')!.click()
    )
    expect(el.querySelector('[data-selecting]')).toBeNull()
    expect(el.querySelectorAll('.zen-page-row-check')).toHaveLength(0)
  })

  it('Cancel leaves the mode; Delete on a focused row removes just that visit', async () => {
    const el = await mountPage()
    await act(async () => rowClick(el, 'v1', { ctrlKey: true }))
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>('.zen-page-title-actions button')]
        .find((b) => text(b) === 'Cancel')!
        .click()
    )
    expect(el.querySelector('[data-selected]')).toBeNull()
    expect(el.querySelectorAll('.zen-page-row-check')).toHaveLength(0)
    const target = el.querySelector<HTMLButtonElement>(
      '[data-visit-id="v3"] button[data-row-focus]'
    )!
    target.focus()
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    )
    expect(calls('history.deleteVisits')).toEqual([{ ids: ['v3'] }])
  })

  it('the arrows walk the rows across the groups, Home and End jump (§9.22)', async () => {
    const el = await mountPage()
    const targets = [...el.querySelectorAll<HTMLButtonElement>('button[data-row-focus]')]
    // The two closed tabs, the "Turn on sync" row (sync is off), then the five visits over four days.
    expect(targets.length).toBe(8)
    expect(targets[2]!.getAttribute('data-testid')).toBe('history-remote-tabs-settings')
    targets[1]!.focus()
    const key = (k: string): void => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    }
    await act(async () => key('ArrowDown'))
    expect(document.activeElement).toBe(targets[2])
    await act(async () => key('ArrowUp'))
    expect(document.activeElement).toBe(targets[1])
    await act(async () => key('End'))
    expect(document.activeElement).toBe(targets[7])
    await act(async () => key('Home'))
    expect(document.activeElement).toBe(targets[0])
  })

  it('a typed search filters through history.grouped and moves the URL to ?q= with replace', async () => {
    const el = await mountPage()
    groups = [GROUPS[0]!]
    const field = el.querySelector<HTMLInputElement>('[data-testid="history-search"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'example')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(calls('history.grouped')).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await flush()
    expect(calls('history.grouped').at(-1)).toEqual({ query: { text: 'example', limit: 300 } })
    expect(calls('page.navigate')).toEqual([
      { tabId: 'history', section: null, replace: true, query: { q: 'example' } }
    ])
    // Recently closed steps aside while searching; matches are marked.
    expect(el.querySelector('[data-testid="history-recently-closed"]')).toBeNull()
    expect(el.querySelectorAll('mark').length).toBeGreaterThan(0)
    // Clearing the field goes back to the plain URL.
    await act(async () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click()
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await flush()
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'history',
      section: null,
      replace: true,
      query: undefined
    })
  })

  it('a query the URL brings fills the field and filters; its echo is not adopted twice', async () => {
    const el = await mountPage(tab('zen://history?q=zen'))
    const field = el.querySelector<HTMLInputElement>('[data-testid="history-search"]')!
    expect(field.value).toBe('zen')
    expect(calls('history.grouped')).toEqual([{ query: { text: 'zen', limit: 300 } }])
    // The page did not push what it was given.
    expect(calls('page.navigate')).toEqual([])
    // "More from this site" (the omnibox, back, forward) moves the tab's URL: the field follows.
    await rerender(tab('zen://history?q=example.com'))
    expect(field.value).toBe('example.com')
    expect(calls('history.grouped').at(-1)).toEqual({ query: { text: 'example.com', limit: 300 } })
    expect(calls('page.navigate')).toEqual([])
  })

  it('says so when there is nothing, and when nothing matches', async () => {
    groups = []
    closed = []
    const el = await mountPage()
    const empty = el.querySelector('[data-testid="history-empty"]')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(text(empty)).toBe('Pages you visit will show up here')
    await rerender(tab('zen://history?q=nothing'))
    expect(text(el.querySelector('[data-testid="history-empty"]'))).toBe(
      'No history matches “nothing”'
    )
  })

  it('Recently closed is the first group: a row restores, the heading clears', async () => {
    const el = await mountPage()
    const group = el.querySelector('[data-testid="history-recently-closed"]')!
    expect(text(group.querySelector('h2'))).toBe('Recently closed')
    const row = group.querySelector('[data-closed-id="c1"]')!
    expect(text(row.querySelector('.zen-page-row-label'))).toBe('Settings')
    // A closed page tab carries its registered glyph in the favicon slot (§10.1), not the globe,
    // and its zenium:// address on the second line, where a site's row reads its host.
    const glyph = row.querySelector('.zen-page-row-lead svg')!
    expect(glyph.classList.contains('lucide-settings')).toBe(true)
    expect(glyph.classList.contains('zen-page-row-glyph')).toBe(true)
    expect(row.querySelector('.zen-page-row-favicon-fallback')).toBeNull()
    expect(text(row.querySelector('.zen-page-row-desc'))).toBe('zenium://settings')
    expect(row.querySelector('button[data-row-focus]')!.getAttribute('title')).toBe(
      'zenium://settings'
    )
    const site = group.querySelector('[data-closed-id="c2"]')!
    expect(text(site.querySelector('.zen-page-row-label'))).toBe('Example Domain')
    expect(text(site.querySelector('.zen-page-row-desc'))).toBe('example.com')
    await act(async () => row.querySelector<HTMLButtonElement>('button[data-row-focus]')!.click())
    expect(calls('session.restoreClosed')).toEqual([{ id: 'c1' }])
    await act(async () =>
      group
        .querySelector<HTMLButtonElement>('button[aria-label="Clear the recently closed list"]')!
        .click()
    )
    expect(calls('session.clearRecentlyClosed')).toHaveLength(1)
  })
})

describe('Tabs from other devices (ID-28, §10.1)', () => {
  /** The groups' headings in page order. */
  const headings = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('.zen-page-group h2')].map(text)

  it('with sync off, the one group after Recently closed says to turn on sync, its row opening Settings › Sync', async () => {
    const el = await mountPage(tab(), state(sync(false)))
    expect(headings(el).slice(0, 3)).toEqual([
      'Recently closed',
      'Tabs from other devices',
      'Today'
    ])
    const group = el.querySelector('[data-testid="history-remote-tabs"]')!
    expect(group.getAttribute('data-state')).toBe('sync-off')
    const line = group.querySelector('[data-testid="history-remote-tabs-empty"]')!
    expect(line.getAttribute('role')).toBe('status')
    expect(text(line)).toBe('Turn on sync to see tabs from your other devices')
    const row = group.querySelector<HTMLButtonElement>(
      '[data-testid="history-remote-tabs-settings"]'
    )!
    expect(text(row)).toBe('Turn on sync')
    expect(row.closest('li')!.querySelector('.zen-page-row-chevron')).not.toBeNull()
    await act(async () => row.click())
    expect(calls('page.open')).toEqual([{ id: 'settings', section: 'sync' }])
    // Nothing was asked of the core while sync is off.
    expect(calls('sync.tabsFromDevices')).toEqual([])
    // No device group anywhere.
    expect(el.querySelector('[data-testid="history-remote-device"]')).toBeNull()
  })

  it('with sync on but Open tabs off in What you sync, the line names the scope and the row chooses it', async () => {
    const el = await mountPage(tab(), state(sync(true, false)))
    const group = el.querySelector('[data-testid="history-remote-tabs"]')!
    expect(group.getAttribute('data-state')).toBe('scope-off')
    expect(text(group.querySelector('[data-testid="history-remote-tabs-empty"]'))).toBe(
      'Turn on Open tabs in What you sync to see them'
    )
    const row = group.querySelector<HTMLButtonElement>(
      '[data-testid="history-remote-tabs-settings"]'
    )!
    expect(text(row)).toBe('Choose what to sync')
    await act(async () => row.click())
    expect(calls('page.open')).toEqual([{ id: 'settings', section: 'sync' }])
    expect(calls('sync.tabsFromDevices')).toEqual([])
  })

  it('with sync on and nothing published the group steps aside, as Recently closed does when empty (§10.1 as amended)', async () => {
    devices = []
    const el = await mountPage(tab(), state(sync(true)))
    // The core was asked and answered with nothing: no heading, no sentence, no row.
    expect(calls('sync.tabsFromDevices')).toHaveLength(1)
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
    expect(el.querySelector('[data-testid="history-remote-tabs-empty"]')).toBeNull()
    expect(el.querySelector('[data-testid="history-remote-device"]')).toBeNull()
    expect(el.textContent).not.toContain('No tabs from other devices')
    expect(el.textContent).not.toContain('Tabs from other devices')
    expect(headings(el).slice(0, 2)).toEqual(['Recently closed', 'Today'])
    // The way out stands only while a setting is the way: the scope turned off brings the group.
    await rerender(tab(), state(sync(true, false)))
    expect(
      el.querySelector('[data-testid="history-remote-tabs"]')!.getAttribute('data-state')
    ).toBe('scope-off')
    await rerender(tab(), state(sync(true)))
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
  })

  it('each device is its own group after Recently closed, newest first, its name the heading and "Last active …" the aside, its tabs §9.21 rows', async () => {
    devices = DEVICES
    const el = await mountPage(tab(), state(sync(true)))
    expect(headings(el).slice(0, 4)).toEqual(['Recently closed', 'Pixel 9', 'Work laptop', 'Today'])
    // No umbrella heading while devices are listed.
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
    const cards = [...el.querySelectorAll('[data-testid="history-remote-device"]')]
    expect(cards.map((c) => c.getAttribute('data-device-id'))).toEqual(['phone', 'work'])
    const phone = cards[0]!
    expect(phone.getAttribute('aria-labelledby')).toBe('zen-history-device-phone')
    expect(text(phone.querySelector('.zen-page-heading-aside'))).toBe('Last active 5 min ago')
    expect(text(cards[1]!.querySelector('.zen-page-heading-aside'))).toBe('Last active 3 h ago')
    const rows = [...phone.querySelectorAll('li.zen-v2-row.zen-page-row')]
    expect(rows).toHaveLength(2)
    const first = rows[0]!
    expect(first.getAttribute('data-remote-tab')).toBe('phone:p1')
    // The favicon leads (the globe for a tab with none), then the title over the host.
    expect(first.firstElementChild!.classList.contains('zen-page-row-lead')).toBe(true)
    expect(
      first.querySelector('.zen-page-row-lead svg.zen-page-row-favicon-fallback')
    ).not.toBeNull()
    expect(text(first.querySelector('.zen-page-row-label'))).toBe('Zen – Wikipedia')
    expect(text(first.querySelector('.zen-page-row-desc'))).toBe('wikipedia.org')
    const second = rows[1]!
    expect(second.querySelector('img.zen-page-row-favicon')!.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    )
    // No visit time, no checkbox: the row names a page another device holds, not a visit.
    expect(first.querySelector('time')).toBeNull()
    expect(first.querySelector('input')).toBeNull()
    expect(first.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    // The rows join the arrow walk between the closed tabs and the visits.
    const targets = [...el.querySelectorAll<HTMLButtonElement>('button[data-row-focus]')]
    expect(targets.length).toBe(2 + 3 + 5)
  })

  it('a click opens the page in a new tab in front; a middle or Ctrl click one behind; a tab this device holds comes to the front', async () => {
    devices = DEVICES
    const el = await mountPage(tab(), state(sync(true), ['held-1']))
    const target = el.querySelector<HTMLButtonElement>(
      '[data-remote-tab="phone:p1"] button[data-row-focus]'
    )!
    await act(async () => target.click())
    expect(calls('urlbar.submit').at(-1)).toEqual({
      input: 'https://www.wikipedia.org/wiki/Zen',
      newTab: true,
      tabId: 'history',
      background: false
    })
    await act(async () =>
      target.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    )
    expect(calls('urlbar.submit').at(-1)).toMatchObject({ newTab: true, background: true })
    await act(async () =>
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit').at(-1)).toMatchObject({ newTab: true, background: true })
    expect(calls('urlbar.submit')).toHaveLength(3)
    // Ctrl-click did not pick the row: these rows are not the mode's.
    expect(el.querySelector('[data-selecting]')).toBeNull()
    // The work laptop's tab is open here too (the Open tabs scope carries the tab records): a
    // click brings it to the front instead of opening it twice; a middle click still opens one behind.
    const held = el.querySelector<HTMLButtonElement>(
      '[data-remote-tab="work:held-1"] button[data-row-focus]'
    )!
    await act(async () => held.click())
    expect(calls('tab.activate')).toEqual([{ tabId: 'held-1' }])
    expect(calls('urlbar.submit')).toHaveLength(3)
    await act(async () =>
      held.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    )
    expect(calls('urlbar.submit').at(-1)).toEqual({
      input: 'https://github.com/BenItBuhner/Zenium/pulls',
      newTab: true,
      tabId: 'history',
      background: true
    })
  })

  it('the row’s ⋮ and right click hang the history menu for the page, with no visit named', async () => {
    devices = DEVICES
    const el = await mountPage(tab(), state(sync(true)))
    const row = el.querySelector<HTMLElement>('[data-remote-tab="phone:p2"]')!
    const more = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Slow-cooked ragù"]'
    )!
    await act(async () => more.click())
    expect(calls('history.contextMenu').at(-1)).toMatchObject({
      visitId: null,
      url: 'https://recipes.example.net/ragu'
    })
    await act(async () =>
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }))
    )
    expect(calls('history.contextMenu')).toHaveLength(2)
    expect(calls('history.contextMenu').at(-1)).toMatchObject({
      visitId: null,
      url: 'https://recipes.example.net/ragu'
    })
  })

  it('a device group folds on its heading’s chevron and stays folded for the session; the mode holds the column on its rows', async () => {
    devices = DEVICES
    let el = await mountPage(tab(), state(sync(true)))
    const card = (): HTMLElement =>
      el.querySelector<HTMLElement>(
        '[data-testid="history-remote-device"][data-device-id="phone"]'
      )!
    const twisty = (): HTMLButtonElement =>
      card().querySelector<HTMLButtonElement>('.zen-page-heading-twisty')!
    expect(twisty().getAttribute('aria-expanded')).toBe('true')
    expect(twisty().getAttribute('aria-label')).toBe('Hide tabs from Pixel 9')
    expect(twisty().querySelector('svg')!.hasAttribute('data-open')).toBe(true)
    await act(async () => twisty().click())
    expect(card().hasAttribute('data-collapsed')).toBe(true)
    // The fold is the session's: the core is told, and holds it for every window's chrome.
    expect(calls('history.foldDevice')).toEqual([{ deviceId: 'phone', folded: true }])
    expect(twisty().getAttribute('aria-expanded')).toBe('false')
    expect(twisty().getAttribute('aria-label')).toBe('Show tabs from Pixel 9')
    expect(twisty().querySelector('svg')!.hasAttribute('data-open')).toBe(false)
    // The rows left the DOM: the arrows walk what is shown; the heading and its aside stay.
    expect(card().querySelectorAll('li')).toHaveLength(0)
    expect(text(card().querySelector('h2'))).toBe('Pixel 9')
    expect(text(card().querySelector('.zen-page-heading-aside'))).toBe('Last active 5 min ago')
    // The other device is untouched.
    expect(el.querySelectorAll('[data-device-id="work"] li')).toHaveLength(1)
    // The page mounted again (the tab closed and reopened) finds the fold where it was left.
    el = await remount(tab(), state(sync(true)))
    expect(card().hasAttribute('data-collapsed')).toBe(true)
    expect(card().querySelectorAll('li')).toHaveLength(0)
    await act(async () => twisty().click())
    expect(card().hasAttribute('data-collapsed')).toBe(false)
    expect(card().querySelectorAll('li')).toHaveLength(2)
    expect(calls('history.foldDevice').at(-1)).toEqual({ deviceId: 'phone', folded: false })
    // Another window folded the laptop: the core's word reaches this one and it folds here too.
    await act(async () => emit('history.foldedDevicesChanged', ['work']))
    expect(el.querySelector('[data-device-id="work"]')!.hasAttribute('data-collapsed')).toBe(true)
    expect(el.querySelectorAll('[data-device-id="work"] li')).toHaveLength(0)
    expect(card().hasAttribute('data-collapsed')).toBe(false)
    await act(async () => emit('history.foldedDevicesChanged', []))
    expect(el.querySelectorAll('[data-device-id="work"] li')).toHaveLength(1)
    // Entering the mode: the remote rows hold the checkbox column's width, picked by nothing.
    await act(async () => rowClick(el, 'v1', { ctrlKey: true }))
    expect(el.querySelectorAll('[data-remote-tab] span.zen-page-row-check')).toHaveLength(3)
    expect(el.querySelectorAll('[data-remote-tab] input')).toHaveLength(0)
    // Ctrl+A picks the visits alone.
    const target = el.querySelector<HTMLButtonElement>(
      '[data-visit-id="v1"] button[data-row-focus]'
    )!
    target.focus()
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    )
    expect(text(el.querySelector('.zen-page-title-count'))).toBe('5 selected')
  })

  it('a fresh chrome (a second window) starts from the folds the core holds', async () => {
    devices = DEVICES
    folded = ['work']
    // A window's chrome is a document of its own: its store has not asked the core yet.
    const el = await mountPage(tab(), state(sync(true)))
    expect(calls('history.foldedDevices')).toHaveLength(1)
    expect(el.querySelector('[data-device-id="work"]')!.hasAttribute('data-collapsed')).toBe(true)
    expect(el.querySelectorAll('[data-device-id="work"] li')).toHaveLength(0)
    expect(el.querySelector('[data-device-id="phone"]')!.hasAttribute('data-collapsed')).toBe(false)
    // Mounted again in the same chrome, it does not ask twice.
    await remount(tab(), state(sync(true)))
    expect(calls('history.foldedDevices')).toHaveLength(1)
  })

  it('the search filters the devices’ rows too – a device left with nothing steps aside – and a match answers the search when history has none', async () => {
    devices = DEVICES
    // History finds nothing for any of these; the phone's tab answers "cooked", so no "No history matches".
    groups = []
    const el = await mountPage(tab('zen://history?q=cooked'), state(sync(true)))
    expect(calls('history.grouped').at(-1)).toEqual({ query: { text: 'cooked', limit: 300 } })
    expect(el.querySelector('[data-testid="history-empty"]')).toBeNull()
    const cards = [...el.querySelectorAll('[data-testid="history-remote-device"]')]
    expect(cards.map((c) => c.getAttribute('data-device-id'))).toEqual(['phone'])
    const rows = [...cards[0]!.querySelectorAll('[data-remote-tab]')]
    expect(rows.map((r) => r.getAttribute('data-remote-tab'))).toEqual(['phone:p2'])
    expect(rows[0]!.querySelectorAll('mark').length).toBeGreaterThan(0)
    // The host matches as the URL does.
    await rerender(tab('zen://history?q=github.com'), state(sync(true)))
    await flush()
    expect(
      [...el.querySelectorAll('[data-remote-tab]')].map((r) => r.getAttribute('data-remote-tab'))
    ).toEqual(['work:held-1'])
    // Nothing anywhere: History's own line, and no empty device group beside it.
    await rerender(tab('zen://history?q=nowhere'), state(sync(true)))
    await flush()
    expect(text(el.querySelector('[data-testid="history-empty"]'))).toBe(
      'No history matches “nowhere”'
    )
    expect(el.querySelector('[data-testid="history-remote-device"]')).toBeNull()
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
  })

  it('while searching, the empty group steps aside with Recently closed', async () => {
    const el = await mountPage(tab('zen://history?q=example'), state(sync(false)))
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
    expect(el.querySelector('[data-testid="history-recently-closed"]')).toBeNull()
    await rerender(tab('zen://history'), state(sync(false)))
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).not.toBeNull()
  })

  it('is not drawn on a host without sync', async () => {
    devices = DEVICES
    const s = state(sync(true))
    ;(s.capabilities as { sync: boolean }).sync = false
    const el = await mountPage(tab(), s)
    expect(el.querySelector('[data-testid="history-remote-tabs"]')).toBeNull()
    expect(el.querySelector('[data-testid="history-remote-device"]')).toBeNull()
  })
})
