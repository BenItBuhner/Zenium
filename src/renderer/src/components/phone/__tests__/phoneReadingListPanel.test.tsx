// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReadingListEntry, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The reading list on a phone (HB-20; v2 draft §9.16, §9.17, §9.27, §10.4): the desktop's
 * `zen://reading-list` page as a panel on the History / Bookmarks chassis. The entries stand
 * under Unread (its count as the heading's aside) and Read, newest first in each; a row names
 * the page over its host and when it was added; a tap opens the page in the current tab and
 * marks it read through the desktop's one command (`readingList.open`) and the panel leaves;
 * the row's ⋮ – or the row held – hangs the desktop row menu's items from the row's name (Open
 * in New Tab, Mark as Read / Mark as Unread, Copy Link, Remove); the top row marks every entry
 * read while any is unread. The rows are keyed by id and the list re-renders from
 * `UIState.readingList`: an entry that goes under the open panel leaves no row behind, and a
 * menu still up for it drops what is picked. A synced entry arrives without a favicon and shows
 * the stand-in glyph unless the cache holds the icon. Rendered for real in happy-dom, the core
 * stubbed.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneReadingListPanel } = await import('../PhoneReadingListPanel')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, pickMenuItem, uiStore } = await import('@renderer/lib/ui')
const { faviconStore } = await import('@renderer/lib/favicons')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...patch
  } as Tab
}

function entry(
  id: string,
  url: string,
  title: string,
  addedAt: number,
  patch: Partial<ReadingListEntry> = {}
): ReadingListEntry {
  return { id, url, title, addedAt, updatedAt: addedAt, ...patch }
}

/** `tabs` in track order; the first is active. */
function stateOf(readingList: ReadingListEntry[], tabs: Tab[] = pages()): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    readingList
  } as unknown as UIState
}

const pages = (): Tab[] => [tab('ex', 'https://example.com/', { title: 'Example Domain' })]

/** Three saved pages: two unread (the newer first), one read. */
const list = (): ReadingListEntry[] => [
  entry('rl_a', 'https://a.example/long-read', 'A long read', NOW - 3 * HOUR),
  entry('rl_b', 'https://b.example/notes', 'Notes on B', NOW - 20 * 60_000, {
    favicon: 'data:image/png;base64,QUJD'
  }),
  entry('rl_c', 'https://c.example/done', 'Finished C', NOW - 2 * 24 * HOUR, {
    readAt: NOW - HOUR
  })
]

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function render(state: UIState): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(PhoneReadingListPanel, { state })))
}

/** The browser shows `state`, and the reading list panel is up over it. */
async function show(state: UIState): Promise<void> {
  act(() => browserStore.set({ state }))
  act(() => uiStore.set({ overlay: 'reading-list' as never }))
  render(state)
  await settle()
}

/** The core pushed a new state under the open panel. */
async function push(state: UIState): Promise<void> {
  act(() => browserStore.set({ state }))
  render(state)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  invoke.mockClear()
  faviconStore.set({ index: new Map() })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  uiStore.set({ toasts: [], menu: null })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ toasts: [], overlay: 'none', menu: null })
  browserStore.set({ state: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- helpers -----------------------------------------------------------------------------------

const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-phone-row')]
/** The list row whose title reads `title`. */
const rowByTitle = (title: string): HTMLElement =>
  rows().find((r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title)!
const rowMain = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('.zen-list-main')!
/** The list: its headings (with their asides) and rows in order, as a reader meets them. */
const listTexts = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-v2-heading, .zen-phone-row')].map((el) =>
    el.classList.contains('zen-v2-heading')
      ? `# ${el.textContent?.trim()}`
      : (el.querySelector('.zen-list-title')?.textContent?.trim() ?? '')
  )
const subtitle = (row: HTMLElement): string =>
  row.querySelector('.zen-list-subtitle')?.textContent?.trim() ?? ''
const menu = (): { title: string | undefined; items: string[] } | null => {
  const m = uiStore.get().menu
  return m
    ? { title: m.title, items: m.items.map((i) => (i.type === 'separator' ? '-' : i.label)) }
    : null
}
/** Pick the sheet's item reading `label`: the sheet goes, the action runs once it is unpainted. */
async function pick(label: string): Promise<void> {
  const item = uiStore.get().menu!.items.find((i) => i.label === label)!
  act(() => pickMenuItem(item.id))
  await act(async () => {
    vi.advanceTimersByTime(50)
  })
  await settle()
}
const more = (title: string): HTMLElement =>
  rowByTitle(title).querySelector<HTMLElement>(`button[aria-label="More options for ${title}"]`)!
const search = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[type="search"]')!
const type = (text: string): void => {
  act(() => {
    const field = search()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// --- the panel ---------------------------------------------------------------------------------

describe("the phone's reading list panel (HB-20)", () => {
  it('stands the entries under Unread (its count as the aside) and Read, newest first in each, a row naming the page over its host and when it was added, under a Mark all as read row', async () => {
    await show(stateOf(list()))
    expect(document.querySelector('.zen-phone-panel h2')?.textContent).toBe('Reading list')
    expect(search().placeholder).toBe('Search reading list')
    // The field never takes the focus as the panel opens.
    expect(document.activeElement).not.toBe(search())
    expect(listTexts()).toEqual([
      'Mark all as read',
      '# Unread2',
      'Notes on B',
      'A long read',
      '# Read',
      'Finished C'
    ])
    const unread = document.querySelector<HTMLElement>('.zen-list-heading[data-aside]')!
    expect(unread.querySelector('.zen-list-heading-aside')?.textContent).toBe('2')
    expect(subtitle(rowByTitle('A long read'))).toBe('a.example · Added 3 h ago')
    expect(subtitle(rowByTitle('Notes on B'))).toBe('b.example · Added 20 min ago')
    expect(subtitle(rowByTitle('Finished C'))).toBe('c.example · Added 2 d ago')
    expect(rowMain(rowByTitle('A long read')).getAttribute('aria-label')).toBe(
      'A long read, a.example, Added 3 h ago, Unread'
    )
    expect(rowMain(rowByTitle('Finished C')).getAttribute('aria-label')).toBe(
      'Finished C, c.example, Added 2 d ago, Read'
    )
    // Each row's trailing 44 control is its ⋮ (§10.4: the tap is spoken for).
    expect(
      rows()
        .slice(1)
        .map((r) => r.querySelector('button')?.getAttribute('aria-label'))
    ).toEqual([
      'More options for Notes on B',
      'More options for A long read',
      'More options for Finished C'
    ])
  })

  it('phrases a page saved moments ago as the family does – "Added just now"', async () => {
    await show(stateOf([entry('rl_n', 'https://n.example/', 'Now', NOW - 10_000)]))
    expect(subtitle(rowByTitle('Now'))).toBe('n.example · Added just now')
  })

  it('opens a tapped page in the current tab through the desktop’s one command – which marks it read – and leaves', async () => {
    await show(stateOf(list()))
    act(() => rowMain(rowByTitle('A long read')).click())
    await settle()
    expect(of('readingList.open')).toEqual([{ id: 'rl_a', tabId: 'ex' }])
    expect(uiStore.get().overlay).toBe('none')
    // Nothing else: the read flip is the command's own (`openReadingEntry`).
    expect(of('readingList.setRead')).toEqual([])
  })

  it('hangs the desktop row menu’s items from the row’s name on its ⋮ and on a hold: Mark as Read flips the entry, Remove takes it out, Copy Link copies, Open in New Tab keeps the panel', async () => {
    await show(stateOf(list()))
    act(() => more('A long read').click())
    await settle()
    expect(menu()).toEqual({
      title: 'A long read',
      items: ['Open in New Tab', '-', 'Mark as Read', '-', 'Copy Link', 'Remove']
    })
    await pick('Mark as Read')
    expect(of('readingList.setRead')).toEqual([{ id: 'rl_a', read: true }])

    // A read row's verb is the other way round.
    act(() => more('Finished C').click())
    await settle()
    expect(menu()?.items).toContain('Mark as Unread')
    await pick('Mark as Unread')
    expect(of('readingList.setRead')).toEqual([
      { id: 'rl_a', read: true },
      { id: 'rl_c', read: false }
    ])

    act(() => more('Notes on B').click())
    await settle()
    await pick('Remove')
    expect(of('readingList.remove')).toEqual([{ id: 'rl_b' }])

    act(() => more('Notes on B').click())
    await settle()
    await pick('Copy Link')
    expect(of('clipboard.writeText')).toEqual([
      { text: 'https://b.example/notes', confirmation: 'Link copied' }
    ])

    act(() => more('Notes on B').click())
    await settle()
    await pick('Open in New Tab')
    expect(of('readingList.open')).toEqual([{ id: 'rl_b', tabId: 'ex', newTab: true }])
    expect(uiStore.get().overlay).toBe('reading-list')

    // The row held: the same menu (the `contextmenu` Chromium raises for a touch hold).
    act(() => {
      rowMain(rowByTitle('A long read')).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    await settle()
    expect(menu()?.title).toBe('A long read')
    // The Remove row is the menu's one destructive item.
    expect(uiStore.get().menu?.items.find((i) => i.label === 'Remove')?.danger).toBe(true)
  })

  it('marks every entry read from the top row, which stands only while something is unread and nothing is searched', async () => {
    await show(stateOf(list()))
    act(() => rowMain(rowByTitle('Mark all as read')).click())
    await settle()
    expect(of('readingList.markAllRead')).toEqual([undefined])

    // Every entry read: the row is gone, and so is the Unread heading.
    await push(stateOf(list().map((e) => ({ ...e, readAt: e.readAt ?? NOW }))))
    expect(listTexts()).toEqual(['# Read', 'Notes on B', 'A long read', 'Finished C'])

    // Searching: the row steps aside for the matches.
    await push(stateOf(list()))
    type('notes')
    await settle()
    expect(listTexts()).toEqual(['# Unread1', 'Notes on B'])
    type('nothing like this')
    await settle()
    expect(document.querySelector('.zen-phone-empty p')?.textContent).toBe('No matching pages')
  })

  it('says what an empty list is for (§9.17), in the desktop page’s words', async () => {
    await show(stateOf([]))
    expect(rows()).toEqual([])
    expect(document.querySelector('.zen-phone-empty p')?.textContent).toBe(
      'Pages you save to read later appear here'
    )
  })

  it('keys its rows by id, so two entries at one address are two rows, and an entry that goes under the open panel leaves no row – a menu still up for it drops what is picked', async () => {
    // The moment before a sync's dedupe resolves a page saved on two devices to one entry.
    const twins = [
      entry('rl_x', 'https://x.example/', 'Saved here', NOW - HOUR),
      entry('rl_y', 'https://x.example/', 'Saved there', NOW - 2 * HOUR)
    ]
    await show(stateOf(twins))
    expect(listTexts()).toEqual(['Mark all as read', '# Unread2', 'Saved here', 'Saved there'])

    act(() => more('Saved there').click())
    await settle()
    expect(menu()?.title).toBe('Saved there')
    // The dedupe lands while the menu is up: the row goes, the survivor stays.
    await push(stateOf([twins[0]!]))
    expect(listTexts()).toEqual(['Mark all as read', '# Unread1', 'Saved here'])
    await pick('Mark as Read')
    expect(of('readingList.setRead')).toEqual([])
    await push(stateOf([]))
    expect(rows()).toEqual([])
    expect(document.querySelector('.zen-phone-empty p')?.textContent).toBe(
      'Pages you save to read later appear here'
    )
  })

  it('draws a synced entry’s icon from the favicon cache by address, never assuming one came with it: the stand-in glyph without, the cached copy with', async () => {
    const icon = 'https://a.example/favicon.ico'
    const synced = [
      // A record from another device: no favicon field at all.
      entry('rl_a', 'https://a.example/long-read', 'A long read', NOW - HOUR),
      // This device's own save carries the icon inline.
      entry('rl_b', 'https://b.example/notes', 'Notes on B', NOW - 2 * HOUR, {
        favicon: 'data:image/png;base64,QUJD'
      }),
      // An icon address the cache holds a copy of.
      entry('rl_c', 'https://c.example/', 'C', NOW - 3 * HOUR, { favicon: icon })
    ]
    faviconStore.set({ index: new Map([[icon, 'h4sh']]) })
    await show(stateOf(synced))
    const lead = (title: string): HTMLElement =>
      rowByTitle(title).querySelector<HTMLElement>('.zen-list-lead')!
    expect(lead('A long read').querySelector('svg.zen-list-standin')).not.toBeNull()
    expect(lead('A long read').querySelector('img')).toBeNull()
    expect(lead('Notes on B').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,QUJD'
    )
    expect(lead('C').querySelector('img')?.getAttribute('src')).toContain('h4sh')
  })
})
