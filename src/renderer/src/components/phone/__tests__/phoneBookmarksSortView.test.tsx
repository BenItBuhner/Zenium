// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Settings, Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { createBookmarkRoots, MOBILE_BOOKMARKS_ID, OTHER_BOOKMARKS_ID } from '@shared/bookmarks'

/*
 * The phone bookmarks panel's "Sort and view options" against Chrome 152 (HB-13;
 * `BookmarkUiPrefs`, `bookmark_toolbar_menu_improved.xml`, `ImprovedBookmarkQueryHandler.
 * sortByStoredPref`, `ImprovedBookmarkRowCoordinator`): the header's button hangs Chrome's six
 * orders and two views as radio rows with Chrome's words, the current ones checked; a pick
 * writes the device-local setting and announces Chrome's line; the order applies to a folder's
 * rows and to search results, folders first, the id breaking ties; the Visual row is a tile
 * showing an open tab's card picture (never a private tab's) or the favicon on a card, the
 * Compact row the plain favicon row. Rendered for real in happy-dom, the core stubbed.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const DAY = 86_400_000

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBookmarksPanel } = await import('../PhoneBookmarksPanel')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, pickMenuItem, uiStore } = await import('@renderer/lib/ui')
const { announcerStore, resetAnnouncer } = await import('@renderer/lib/announce')
const { rememberThumbnail, thumbnailStore } = await import('@renderer/lib/thumbnails')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string, containerId = 'default'): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId,
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false
  } as unknown as Tab
}

function page(
  id: string,
  parentId: string,
  index: number,
  title: string,
  extra: Partial<Pick<BookmarkNode, 'url' | 'dateAdded' | 'dateLastUsed'>> = {}
): BookmarkNode {
  return {
    id,
    parentId,
    index,
    type: 'url',
    title,
    url: `https://${id}.example/`,
    dateAdded: NOW - index * DAY,
    ...extra
  }
}
function folder(id: string, parentId: string, index: number, title: string): BookmarkNode {
  return { id, parentId, index, type: 'folder', title, dateAdded: NOW - index * DAY }
}

/**
 * Mobile bookmarks, in stored order: the pages Zebra (added 1 day ago, opened 3 days ago) and
 * apple (added 5 days ago, never opened), the folder Work, the page Mango (added 2 days ago,
 * opened an hour ago, the open tab's page), the folder arts. Other bookmarks: Docs.
 */
const profile = (): BookmarkNode[] => [
  ...createBookmarkRoots(NOW),
  page('zebra', MOBILE_BOOKMARKS_ID, 0, 'Zebra', {
    dateAdded: NOW - DAY,
    dateLastUsed: NOW - 3 * DAY
  }),
  page('apple', MOBILE_BOOKMARKS_ID, 1, 'apple', { dateAdded: NOW - 5 * DAY }),
  folder('work', MOBILE_BOOKMARKS_ID, 2, 'Work'),
  page('mango', MOBILE_BOOKMARKS_ID, 3, 'Mango', {
    url: 'https://example.com/fruit#top',
    dateAdded: NOW - 2 * DAY,
    dateLastUsed: NOW - 3_600_000
  }),
  folder('arts', MOBILE_BOOKMARKS_ID, 4, 'arts'),
  page('docs', OTHER_BOOKMARKS_ID, 0, 'Docs', { dateAdded: NOW - 4 * DAY })
]

function stateOf(
  settings: Partial<Settings> = {},
  tabs: Tab[] = [tab('ex', 'https://example.com/fruit')]
): UIState {
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
    capabilities: { windowControls: false, privateTabs: true },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, ...settings },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: profile(),
    recentlyClosed: [],
    readingList: []
  } as unknown as UIState
}

// --- the harness -------------------------------------------------------------------------------

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
  act(() =>
    root!.render(
      createElement(FrameDialogHost, null, createElement(PhoneBookmarksPanel, { state }))
    )
  )
}

/** The browser shows `state`, and the Bookmarks panel is up over it. */
async function show(state: UIState = stateOf()): Promise<void> {
  act(() => browserStore.set({ state }))
  act(() => uiStore.set({ overlay: 'bookmarks' as never }))
  render(state)
  await settle()
}

/** The core pushed a new state under the open panel (a setting written, a tab opened). */
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
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    cb(16)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  uiStore.set({ toasts: [], menu: null, bookmarkEdit: null, overlayFolderId: null })
  resetAnnouncer()
  thumbnailStore.set({ cards: new Map(), covers: new Map() })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ toasts: [], overlay: 'none', menu: null, bookmarkEdit: null })
  browserStore.set({ state: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- helpers -----------------------------------------------------------------------------------

const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-phone-row')]
const titles = (): string[] =>
  rows().map((r) => r.querySelector('.zen-list-title')?.textContent?.trim() ?? '')
const rowByTitle = (title: string): HTMLElement =>
  rows().find((r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title)!
const rowMain = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('.zen-list-main')!
const menu = (): Array<{ label: string; type: string; checked: boolean }> | null => {
  const m = uiStore.get().menu
  return m
    ? m.items.map((i) => ({
        label: i.type === 'separator' ? '-' : i.label,
        type: i.type,
        checked: i.checked
      }))
    : null
}
const sortViewButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Sort and view options"]')
async function openSortView(): Promise<void> {
  act(() => sortViewButton()!.click())
  await settle()
}
/** Pick the menu sheet's item reading `label`: the sheet goes and the action runs. */
async function pick(label: string): Promise<void> {
  const item = uiStore.get().menu!.items.find((i) => i.label === label)!
  act(() => pickMenuItem(item.id))
  await act(async () => {
    vi.advanceTimersByTime(50)
  })
  await settle()
}
async function tap(title: string): Promise<void> {
  act(() => rowMain(rowByTitle(title)).click())
  await settle()
}
/** Start selection mode with the row's own menu's Select (as a long press would). */
async function select(title: string): Promise<void> {
  act(() =>
    rowByTitle(title)
      .querySelector<HTMLElement>(`button[aria-label="More options for ${title}"]`)!
      .click()
  )
  await settle()
  await pick('Select')
}
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
/** What each row leads with: its tile's picture, its tile's mark, or the compact lead. */
const leads = (): string[] =>
  rows().map((r) => {
    if (r.querySelector('.zen-list-picture > .zen-list-page')) return 'tile:picture'
    if (r.querySelector('.zen-list-picture > .zen-list-mark')) return 'tile:mark'
    if (r.querySelector('.zen-list-lead')) return 'lead'
    return 'none'
  })

// --- the menu ----------------------------------------------------------------------------------

describe('the header’s Sort and view options (Chrome’s sort_submenu)', () => {
  it('hangs the six orders then the two views as radio rows in Chrome’s words, manual order and the visual view checked by default', async () => {
    await show()
    expect(sortViewButton()).not.toBeNull()
    await openSortView()
    expect(uiStore.get().menu?.title).toBe('Sort and view options')
    expect(menu()).toEqual([
      { label: 'Sort by manual order', type: 'radio', checked: true },
      { label: 'Sort by newest', type: 'radio', checked: false },
      { label: 'Sort by oldest', type: 'radio', checked: false },
      { label: 'Sort by last opened', type: 'radio', checked: false },
      { label: 'Sort by A to Z', type: 'radio', checked: false },
      { label: 'Sort by Z to A', type: 'radio', checked: false },
      { label: '-', type: 'separator', checked: false },
      { label: 'Visual view', type: 'radio', checked: true },
      { label: 'Compact view', type: 'radio', checked: false }
    ])
  })

  it('a pick writes the device’s setting through the core and announces Chrome’s line; the checked rows follow the state', async () => {
    await show()
    await openSortView()
    await pick('Sort by A to Z')
    expect(of('settings.update')).toEqual([{ bookmarkRowSortOrder: 'a-z' }])
    expect(announcerStore.get().text).toBe('Sorting from A to Z')
    expect(uiStore.get().menu).toBeNull()
    await push(stateOf({ bookmarkRowSortOrder: 'a-z' }))
    await openSortView()
    expect(
      menu()!
        .filter((i) => i.checked)
        .map((i) => i.label)
    ).toEqual(['Sort by A to Z', 'Visual view'])
    await pick('Compact view')
    expect(of('settings.update')).toEqual([
      { bookmarkRowSortOrder: 'a-z' },
      { bookmarkRowDisplay: 'compact' }
    ])
    expect(announcerStore.get().text).toBe('Showing compact view')
  })

  it('a pick of the checked row writes nothing', async () => {
    await show()
    await openSortView()
    await pick('Sort by manual order')
    await openSortView()
    await pick('Visual view')
    expect(of('settings.update')).toEqual([])
  })

  it('has no place in the selection header, as Chrome’s selection toolbar has none', async () => {
    await show()
    await tap('Mobile bookmarks')
    await select('Zebra')
    expect(document.querySelector('header h2[aria-live="polite"]')?.textContent).toBe('1 selected')
    expect(sortViewButton()).toBeNull()
  })
})

// --- the orders --------------------------------------------------------------------------------

describe('the orders (ImprovedBookmarkQueryHandler.sortByStoredPref)', () => {
  it('manual order shows the folder as stored – folders and pages interleaved, nothing grouped (Chrome returns the model’s order untouched)', async () => {
    await show()
    await tap('Mobile bookmarks')
    expect(titles()).toEqual(['Zebra', 'apple', 'Work', 'Mango', 'arts'])
  })

  it.each([
    ['newest', ['Work', 'arts', 'Zebra', 'Mango', 'apple']],
    ['oldest', ['arts', 'Work', 'apple', 'Mango', 'Zebra']],
    // Neither folder was ever opened (0 and 0): the id breaks the tie, as Chrome's does.
    ['last-opened', ['arts', 'Work', 'Mango', 'Zebra', 'apple']],
    ['a-z', ['arts', 'Work', 'apple', 'Mango', 'Zebra']],
    ['z-a', ['Work', 'arts', 'Zebra', 'Mango', 'apple']]
  ] as const)(
    '%s puts the folders first and orders the rows by the key',
    async (order, expected) => {
      await show(stateOf({ bookmarkRowSortOrder: order }))
      await tap('Mobile bookmarks')
      expect(titles()).toEqual(expected)
    }
  )

  it('re-orders the open folder as the setting changes, and orders the roots too', async () => {
    await show()
    expect(titles()).toEqual(['Mobile bookmarks', 'Other bookmarks'])
    await push(stateOf({ bookmarkRowSortOrder: 'z-a' }))
    expect(titles()).toEqual(['Other bookmarks', 'Mobile bookmarks'])
    await tap('Mobile bookmarks')
    expect(titles()).toEqual(['Work', 'arts', 'Zebra', 'Mango', 'apple'])
    await push(stateOf({ bookmarkRowSortOrder: 'newest' }))
    expect(titles()).toEqual(['Work', 'arts', 'Zebra', 'Mango', 'apple'])
    await push(stateOf({ bookmarkRowSortOrder: 'oldest' }))
    expect(titles()).toEqual(['arts', 'Work', 'apple', 'Mango', 'Zebra'])
  })

  it('orders search results by the same setting (Chrome’s buildBookmarkListForSearch)', async () => {
    await show(stateOf({ bookmarkRowSortOrder: 'a-z' }))
    type('a')
    await settle()
    // Zebra, apple, Mango, arts and Docs all carry an "a"; the folder first, then A to Z.
    expect(titles()).toEqual(['arts', 'apple', 'Docs', 'Mango', 'Zebra'])
    await push(stateOf({ bookmarkRowSortOrder: 'z-a' }))
    expect(titles()).toEqual(['arts', 'Zebra', 'Mango', 'Docs', 'apple'])
  })

  it('every row is a FLIP cell keyed by its node, so a re-order glides it', async () => {
    await show()
    await tap('Mobile bookmarks')
    const cells = [...document.querySelectorAll<HTMLElement>('.zen-phone-list [data-cell]')].map(
      (c) => c.dataset.cell
    )
    expect(cells).toEqual(['zebra', 'apple', 'work', 'mango', 'arts'])
  })
})

// --- the views ---------------------------------------------------------------------------------

describe('the views (BookmarkRowDisplayPref)', () => {
  it('the visual view stands every row on a tile – the open tab’s card picture where one is on the page, the favicon or folder glyph on a card otherwise', async () => {
    await show()
    await tap('Mobile bookmarks')
    expect(document.querySelector('.zen-phone-list')?.getAttribute('data-display')).toBe('visual')
    expect(rows().every((r) => r.hasAttribute('data-picture'))).toBe(true)
    // No picture of the open tab yet: every tile shows its mark.
    expect(leads()).toEqual(['tile:mark', 'tile:mark', 'tile:mark', 'tile:mark', 'tile:mark'])
    // The chrome captured the open tab (example.com/fruit; the bookmark names it with a fragment).
    act(() => rememberThumbnail('ex', 'data:image/png;base64,AAAA'))
    await settle()
    expect(leads()).toEqual(['tile:mark', 'tile:mark', 'tile:mark', 'tile:picture', 'tile:mark'])
    expect(
      rowByTitle('Mango').querySelector<HTMLImageElement>('.zen-list-page')?.getAttribute('src')
    ).toBe('data:image/png;base64,AAAA')
  })

  it('never shows a private tab’s picture', async () => {
    await show(stateOf({}, [tab('secret', 'https://example.com/fruit', PRIVATE_CONTAINER_ID)]))
    act(() => rememberThumbnail('secret', 'data:image/png;base64,BBBB'))
    await tap('Mobile bookmarks')
    expect(leads()).toEqual(['tile:mark', 'tile:mark', 'tile:mark', 'tile:mark', 'tile:mark'])
  })

  it('the compact view is the plain favicon row, no tile; the switch is a cut (a new FLIP epoch) and back again', async () => {
    await show(stateOf({ bookmarkRowDisplay: 'compact' }))
    await tap('Mobile bookmarks')
    expect(document.querySelector('.zen-phone-list')?.getAttribute('data-display')).toBe('compact')
    expect(rows().some((r) => r.hasAttribute('data-picture'))).toBe(false)
    expect(leads()).toEqual(['lead', 'lead', 'lead', 'lead', 'lead'])
    await push(stateOf({ bookmarkRowDisplay: 'visual' }))
    expect(leads()).toEqual(['tile:mark', 'tile:mark', 'tile:mark', 'tile:mark', 'tile:mark'])
  })

  it('while rows are picked the checkbox leads and the tile stays beside it, never under it (9.6)', async () => {
    await show()
    await tap('Mobile bookmarks')
    await select('Zebra')
    const row = rowByTitle('Zebra')
    expect(row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    const main = rowMain(row)
    expect([...main.children].map((c) => c.className.split(' ')[0])).toEqual([
      'zen-v2-checkbox',
      'zen-list-picture',
      'zen-list-text'
    ])
    expect(row.querySelector('.zen-list-lead')).toBeNull()
  })
})
