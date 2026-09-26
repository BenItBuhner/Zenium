// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingListEntry, Tab, UIState } from '@shared/types'

/*
 * The Reading List page tab (design language v2 §10.1; W6-1, bookmarks-33; Chrome's reading
 * list): the title block with Mark all as read, the search field that filters the list and moves
 * the tab's URL to `zen://reading-list?q=` without a history entry, the Unread and Read groups
 * as §9.27 headings (the count as Unread's aside) over §9.21 two-line rows – the favicon seat
 * with §9.29's dot on an unread row, the title over the host alone, the time trailing in the
 * rows' column (the family's row, the lead's C1 on #511) – the row's Mark as read / unread and
 * ⋮ on approach, the core's row menu from the ⋮ and a right click,
 * opening from the row (a click, Enter, the middle button behind), Delete removing, and the
 * §9.17 empty states.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOUR = 3_600_000
const NOW = Date.now()

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { ReadingListPage } = await import('../ReadingListPage')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore } = await import('@renderer/lib/browserStore')

function entry(over: Partial<ReadingListEntry> & { id: string; url: string }): ReadingListEntry {
  return {
    title: over.url,
    addedAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over
  }
}

const unreadNew = entry({
  id: 'a',
  url: 'https://long.read/essay',
  title: 'A long essay',
  addedAt: NOW - 5 * 60_000,
  updatedAt: NOW - 5 * 60_000
})
const unreadOld = entry({
  id: 'b',
  url: 'https://docs.example.org/guide',
  title: 'The guide',
  addedAt: NOW - 3 * HOUR,
  updatedAt: NOW - 3 * HOUR
})
const read = entry({
  id: 'c',
  url: 'https://news.example.com/story',
  title: 'Yesterday’s story',
  addedAt: NOW - 30 * HOUR,
  readAt: NOW - 2 * HOUR,
  updatedAt: NOW - 2 * HOUR
})
/** The model's order (unread first, newest first), as the snapshot hands it over. */
const ENTRIES: ReadingListEntry[] = [unreadNew, unreadOld, read]

/** What the page reads, plus the one space the store's listeners look an active tab up in. */
function state(entries: ReadingListEntry[] = ENTRIES): UIState {
  return {
    readingList: entries,
    platform: 'linux',
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {}
  } as unknown as UIState
}

function tab(url = 'zen://reading-list'): Tab {
  return {
    id: 'rl',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Reading List',
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
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(ReadingListPage, { state: s, tab: t })))
  return mount
}

async function rerender(t: Tab, s: UIState = state()): Promise<void> {
  browserStore.set({ state: s })
  await act(async () => root!.render(createElement(ReadingListPage, { state: s, tab: t })))
}

/** Every `invoke` of `name`, in order. */
function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function row(el: HTMLElement, id: string): HTMLElement {
  return el.querySelector<HTMLElement>(`[data-reading-id="${id}"]`)!
}

/** The rows on the page, in order. */
function ids(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-reading-id]')].map(
    (r) => r.getAttribute('data-reading-id') ?? ''
  )
}

function headings(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-reading-group]')].map(
    (g) => g.getAttribute('data-reading-group') ?? ''
  )
}

function action(r: HTMLElement, name: string): HTMLButtonElement {
  return r.querySelector<HTMLButtonElement>(`[data-zen-dl-action="${name}"]`)!
}

async function click(el: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  vi.useRealTimers()
})

describe('the Reading List page tab (§10.1, W6-1)', () => {
  it('draws the title block with Mark all as read and the search field on the page frame', async () => {
    const el = await mountPage()
    const pageEl = el.querySelector('[data-testid="reading-list-page"]')!
    expect(pageEl.classList.contains('zen-page')).toBe(true)
    expect(text(pageEl.querySelector('h1.zen-page-title'))).toBe('Reading List')
    const buttons = [
      ...pageEl.querySelectorAll<HTMLButtonElement>('.zen-page-title-actions button')
    ]
    expect(buttons.map(text)).toEqual(['Mark all as read'])
    expect(buttons[0].classList.contains('zen-v2-button')).toBe(true)
    expect(buttons[0].disabled).toBe(false)
    const field = pageEl.querySelector<HTMLInputElement>('[data-testid="reading-list-search"]')!
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('placeholder')).toBe('Search reading list')
    expect(pageEl.querySelector('.zen-page-scroll > header.zen-page-header')).not.toBeNull()
  })

  it('groups the rows under Unread (its count as the aside) and Read in the model’s order', async () => {
    const el = await mountPage()
    expect(headings(el)).toEqual(['unread', 'read'])
    expect(ids(el)).toEqual(['a', 'b', 'c'])
    const unreadGroup = el.querySelector('[data-reading-group="unread"]')!
    expect(text(unreadGroup.querySelector('.zen-v2-heading, .zen-page-heading'))).toBe('Unread2')
    const readGroup = el.querySelector('[data-reading-group="read"]')!
    expect(text(readGroup.querySelector('.zen-v2-heading, .zen-page-heading'))).toBe('Read')
    // Each row: the shared two-line row, focusable for the arrows (§9.22).
    for (const id of ['a', 'b', 'c']) {
      const r = row(el, id)
      expect(r.classList.contains('zen-v2-row')).toBe(true)
      expect(r.classList.contains('zen-page-row')).toBe(true)
      expect(r.getAttribute('tabindex')).toBe('0')
      expect(r.hasAttribute('data-row-focus')).toBe(true)
    }
  })

  it('an unread row carries §9.29’s dot on its favicon seat, a read row none; line 2 is the host alone', async () => {
    const el = await mountPage()
    const a = row(el, 'a')
    expect(a.hasAttribute('data-unread')).toBe(true)
    expect(a.querySelector('.zen-rl-favicon-seat[data-unread] > .zen-rl-unread-dot')).not.toBeNull()
    expect(a.querySelector('.zen-page-row-favicon')).not.toBeNull()
    expect(text(a.querySelector('.zen-page-row-label'))).toBe('A long essay')
    expect(text(a.querySelector('.zen-page-row-desc'))).toBe('long.read')
    expect(a.getAttribute('aria-label')).toBe('A long essay. Unread')

    const c = row(el, 'c')
    expect(c.hasAttribute('data-unread')).toBe(false)
    expect(c.querySelector('.zen-rl-unread-dot')).toBeNull()
    expect(c.getAttribute('aria-label')).toBe('Yesterday’s story. Read')
  })

  it('the family’s row (the lead’s C1 on #511): the time trails the text in the rows’ column as "Added when", and each heading holds the rows’ slot', async () => {
    const el = await mountPage()
    const a = row(el, 'a')
    const time = a.querySelector<HTMLTimeElement>('.zen-page-row-time')
    expect(time).not.toBeNull()
    expect(text(time)).toBe('Added 5 min ago')
    expect(time!.getAttribute('datetime')).toBe(new Date(unreadNew.addedAt).toISOString())
    // The time sits between the row's text and its on-approach slot, as in BookmarkRow and History.
    expect(time!.previousElementSibling?.classList.contains('zen-page-row-text')).toBe(true)
    expect(time!.nextElementSibling?.classList.contains('zen-rl-page-actions')).toBe(true)
    // Line 2 carries no time of its own.
    expect(a.querySelector('.zen-page-row-desc time')).toBeNull()
    expect(text(row(el, 'b').querySelector('.zen-page-row-time'))).toBe('Added 3 h ago')
    // Both headings reserve the rows' slot (two 28 boxes and their 8) so the count and the
    // times end on one right edge.
    const slots = [...el.querySelectorAll('.zen-page-heading > .zen-rl-heading-slot')]
    expect(slots).toHaveLength(2)
    expect(slots[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(a.querySelectorAll('.zen-rl-page-actions button')).toHaveLength(2)
    // An age after the verb is lower case (§9.1): "Added just now".
    await rerender(tab(), state([entry({ id: 'n', url: 'https://now.example/', addedAt: NOW })]))
    expect(text(row(el, 'n').querySelector('.zen-page-row-time'))).toBe('Added just now')
  })

  it('the trailing slot holds the state’s verb and the ⋮ on approach: Mark as read on an unread row, Mark as unread on a read one', async () => {
    const el = await mountPage()
    const a = row(el, 'a')
    const aActions = [...a.querySelectorAll<HTMLButtonElement>('.zen-rl-page-actions button')]
    expect(aActions.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Mark as read',
      'More actions'
    ])
    for (const b of aActions) {
      expect(b.classList.contains('zen-v2-icon-button')).toBe(true)
      expect(b.classList.contains('zen-page-row-reveal')).toBe(true)
    }
    await click(action(a, 'mark-read'))
    expect(calls('readingList.setRead')).toEqual([{ id: 'a', read: true }])

    const c = row(el, 'c')
    expect(action(c, 'mark-unread').getAttribute('aria-label')).toBe('Mark as unread')
    await click(action(c, 'mark-unread'))
    expect(calls('readingList.setRead').at(-1)).toEqual({ id: 'c', read: false })
    // Nothing opened: a control's click stays its own.
    expect(calls('readingList.open')).toEqual([])
  })

  it('opens the page from the row here, and behind from a middle or Ctrl click; Enter opens, Delete removes', async () => {
    const el = await mountPage()
    const a = row(el, 'a')
    const textButton = a.querySelector<HTMLButtonElement>('.zen-page-row-text')!
    expect(textButton.getAttribute('title')).toBe('https://long.read/essay')
    await click(textButton)
    expect(calls('readingList.open')).toEqual([
      { id: 'a', tabId: 'rl', newTab: false, background: false }
    ])
    await click(textButton, { ctrlKey: true })
    expect(calls('readingList.open').at(-1)).toEqual({
      id: 'a',
      tabId: 'rl',
      newTab: true,
      background: true
    })
    await act(async () => {
      textButton.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    })
    expect(calls('readingList.open')).toHaveLength(3)
    expect(calls('readingList.open').at(-1)).toMatchObject({ background: true })

    const b = row(el, 'b')
    await act(async () => {
      b.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(calls('readingList.open').at(-1)).toEqual({
      id: 'b',
      tabId: 'rl',
      newTab: false,
      background: false
    })
    await act(async () => {
      b.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      )
    })
    expect(calls('readingList.remove')).toEqual([{ id: 'b' }])
  })

  it('the ⋮ and a right click ask the core for the row’s menu, the ⋮ hanging it from itself', async () => {
    const el = await mountPage()
    const a = row(el, 'a')
    // A pointer's click reports `detail` 1; a key press's reports 0 and starts the menu on its
    // first item.
    await click(action(a, 'menu'), { detail: 1 })
    const fromButton = calls('readingList.contextMenu').at(-1) as Record<string, unknown>
    expect(fromButton.id).toBe('a')
    expect(typeof fromButton.x).toBe('number')
    expect(typeof fromButton.y).toBe('number')
    expect(fromButton.keyboard).toBe(false)
    await click(action(a, 'menu'))
    expect(calls('readingList.contextMenu').at(-1)).toMatchObject({ id: 'a', keyboard: true })
    await act(async () => {
      a.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
      )
    })
    expect(calls('readingList.contextMenu').at(-1)).toMatchObject({ id: 'a', x: 40, y: 50 })
  })

  it('Mark all as read runs the command, and is greyed while nothing waits', async () => {
    const el = await mountPage()
    const markAll = el.querySelector<HTMLButtonElement>('[data-testid="reading-list-mark-all"]')!
    await click(markAll)
    expect(calls('readingList.markAllRead')).toHaveLength(1)
    await rerender(tab(), state([read]))
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="reading-list-mark-all"]')!.disabled
    ).toBe(true)
    expect(headings(el)).toEqual(['read'])
  })

  it('the search filters on the title and the host, moves the tab’s URL without a history entry, and names an empty result', async () => {
    const el = await mountPage()
    const field = el.querySelector<HTMLInputElement>('[data-testid="reading-list-search"]')!
    await type(field, 'guide')
    expect(ids(el)).toEqual(['b'])
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'rl',
      section: null,
      replace: true,
      query: { q: 'guide' }
    })
    await type(field, 'news.example')
    expect(ids(el)).toEqual(['c'])
    expect(headings(el)).toEqual(['read'])
    await type(field, 'nothing here')
    expect(ids(el)).toEqual([])
    expect(text(el.querySelector('[data-testid="reading-list-empty"]'))).toBe(
      'No pages match “nothing here”'
    )
  })

  it('a restored tab comes back searching from its URL, and an empty list reads the §9.17 sentence', async () => {
    const el = await mountPage(tab('zen://reading-list?q=essay'))
    const field = el.querySelector<HTMLInputElement>('[data-testid="reading-list-search"]')!
    expect(field.value).toBe('essay')
    expect(ids(el)).toEqual(['a'])

    await rerender(tab(), state([]))
    expect(text(el.querySelector('[data-testid="reading-list-empty"]'))).toBe(
      'Pages you save to read later appear here'
    )
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="reading-list-mark-all"]')!.disabled
    ).toBe(true)
  })
})
