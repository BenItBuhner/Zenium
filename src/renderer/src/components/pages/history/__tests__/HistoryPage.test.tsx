// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedEntrySummary, HistoryDayGroup, Tab } from '@shared/types'
import { dayKeyOf } from '@shared/dayKey'

/*
 * The History page tab (design language v2 §10.1; Chrome's chrome://history): the title block
 * with "Clear browsing data…", the search field that filters through `history.grouped` and
 * moves the tab's URL to `zen://history?q=` without a history entry, the day groups as §9.27
 * headings (their ⋮ on approach) over §9.21 two-line rows with no slot held at rest, selection
 * as a mode (§9.6, §10.1: entered by Ctrl/Shift-click, the row menu's Select or Ctrl+A, the
 * checkbox column on every row while it lasts, the count, Delete and Cancel in the title block's
 * slot), Recently closed as the page's first group, and the §9.17 empty state.
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

let groups: HistoryDayGroup[] = GROUPS
let closed: ClosedEntrySummary[] = CLOSED
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'history.grouped') return groups
  if (name === 'session.recentlyClosed') return closed
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

async function mountPage(t: Tab = tab()): Promise<HTMLElement> {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(HistoryPage, { tab: t })))
  await flush()
  return mount
}

async function rerender(t: Tab): Promise<void> {
  await act(async () => root!.render(createElement(HistoryPage, { tab: t })))
  await flush()
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  groups = GROUPS
  closed = CLOSED
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
    expect(headings).toEqual([
      'Recently closed',
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
    // The two closed tabs, then the five visits over four days.
    expect(targets.length).toBe(7)
    targets[1]!.focus()
    const key = (k: string): void => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    }
    await act(async () => key('ArrowDown'))
    expect(document.activeElement).toBe(targets[2])
    await act(async () => key('ArrowUp'))
    expect(document.activeElement).toBe(targets[1])
    await act(async () => key('End'))
    expect(document.activeElement).toBe(targets[6])
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
