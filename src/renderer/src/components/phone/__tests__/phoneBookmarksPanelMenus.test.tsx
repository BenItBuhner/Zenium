// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { createBookmarkRoots, MOBILE_BOOKMARKS_ID, OTHER_BOOKMARKS_ID } from '@shared/bookmarks'

/*
 * The bookmark row's menu and the selection bar on a phone against Chrome 152 (HB-12, HB-15;
 * `BookmarkManagerMediator.createListMenuForBookmark`, `BookmarkToolbarMediator`): a row's ⋮
 * hangs Select, Edit… (a folder's Rename…), Move to…, the open rows – Open in Private Tab only
 * where the host has private tabs – Copy Link, Share… where the host shares, and Delete; Select
 * starts selection mode with that row picked; the selection header's More hangs Edit… for
 * exactly one picked row, Move to… for any, then the open rows, Copy Link(s) and Delete. Move
 * to… is the `BookmarkMoveSheet` in the frame's dialog host: every folder the rows can land in
 * as radio rows, the current folder checked and Move disabled on it, New folder naming a
 * folder inside the checked one, the core's `bookmark.move` run once the sheet is gone. No
 * "Add to reading list" row anywhere: Chrome's manager has none. Rendered for real in
 * happy-dom on the frame's dialog host, the frame loop cranked by hand, the core stubbed.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000

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
const { COVERED_TIMEOUT_MS } = await import('@renderer/lib/pageView')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string): Tab {
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
    canGoForward: false
  } as unknown as Tab
}

function url(id: string, parentId: string, index: number, title: string): BookmarkNode {
  return { id, parentId, index, type: 'url', title, url: `https://${id}.example/`, dateAdded: NOW }
}
function folder(id: string, parentId: string, index: number, title: string): BookmarkNode {
  return { id, parentId, index, type: 'folder', title, dateAdded: NOW }
}

/**
 * Mobile bookmarks: the pages News and Mail, then the folder Work (holding Jira) and the folder
 * Home (empty). Other bookmarks: the page Docs. So the panel opens at the top level.
 */
const profile = (): BookmarkNode[] => [
  ...createBookmarkRoots(NOW),
  url('news', MOBILE_BOOKMARKS_ID, 0, 'News'),
  url('mail', MOBILE_BOOKMARKS_ID, 1, 'Mail'),
  folder('work', MOBILE_BOOKMARKS_ID, 2, 'Work'),
  url('jira', 'work', 0, 'Jira'),
  folder('home', MOBILE_BOOKMARKS_ID, 3, 'Home'),
  url('docs', OTHER_BOOKMARKS_ID, 0, 'Docs')
]

function stateOf(
  bookmarks: BookmarkNode[] = profile(),
  capabilities: Record<string, boolean> = { privateTabs: true }
): UIState {
  const tabs = [tab('ex', 'https://example.com/')]
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
    capabilities: { windowControls: false, ...capabilities },
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
    bookmarks,
    recentlyClosed: [],
    readingList: []
  } as unknown as UIState
}

// --- a clock and a frame loop ------------------------------------------------------------------

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/**
 * Run the springs out: a sheet lands, or leaves. A sheet waits for the page under it to be
 * covered before it comes up (Android: the chrome lies under the pages); no host answers here,
 * so the wait runs out first.
 */
async function land(): Promise<void> {
  // The mount's frames: the sheet measures itself and asks for the page's cover.
  await act(async () => {
    frames.run(3)
  })
  await settle()
  await act(async () => {
    vi.advanceTimersByTime(COVERED_TIMEOUT_MS + 50)
  })
  await settle()
  await act(async () => {
    frames.run(150)
  })
  await settle()
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
  frames.install()
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  uiStore.set({ toasts: [], menu: null, bookmarkEdit: null, overlayFolderId: null })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ toasts: [], overlay: 'none', menu: null, bookmarkEdit: null })
  browserStore.set({ state: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-phone-row')]
const titles = (): string[] =>
  rows().map((r) => r.querySelector('.zen-list-title')?.textContent?.trim() ?? '')
/** The list row whose title reads `title`. */
const rowByTitle = (title: string): HTMLElement =>
  rows().find((r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title)!
const rowMain = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('.zen-list-main')!
const more = (title: string): HTMLElement | null =>
  rowByTitle(title).querySelector<HTMLElement>(`button[aria-label="More options for ${title}"]`)
const menu = (): { title: string | undefined; items: string[] } | null => {
  const m = uiStore.get().menu
  return m
    ? { title: m.title, items: m.items.map((i) => (i.type === 'separator' ? '-' : i.label)) }
    : null
}
/** Pick the menu sheet's item reading `label`: the sheet goes, the action runs once it is unpainted (two frames on). */
async function pick(label: string): Promise<void> {
  const item = uiStore.get().menu!.items.find((i) => i.label === label)!
  act(() => pickMenuItem(item.id))
  await act(async () => {
    frames.run(3)
    vi.advanceTimersByTime(50)
  })
  await settle()
}
/** Open a row's ⋮ menu. */
async function openMenu(title: string): Promise<void> {
  act(() => more(title)!.click())
  await settle()
}
/** Tap a row (a pick in selection mode, else it opens). */
async function tap(title: string): Promise<void> {
  act(() => rowMain(rowByTitle(title)).click())
  await settle()
}
/** The selection header's live count ("N selected"); null outside selection mode. */
const selectionHeader = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('header h2[aria-live="polite"]')
const picked = (): string[] =>
  rows()
    .filter((r) => r.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true')
    .map((r) => r.querySelector('.zen-list-title')?.textContent?.trim() ?? '')
async function openSelectionMenu(): Promise<void> {
  act(() => document.querySelector<HTMLElement>('button[aria-label="More"]')!.click())
  await settle()
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

// The Move to… sheet.
const sheet = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.zen-frame-dialogs [role="radiogroup"][aria-label="Folder"]')
const sheetTitle = (): string =>
  document
    .querySelector<HTMLElement>('.zen-frame-dialogs h2.zen-sheet-title')
    ?.textContent?.trim() ?? ''
const options = (): Array<{ title: string; depth: number; checked: boolean; current: boolean }> =>
  [...sheet()!.querySelectorAll<HTMLElement>('[role="radio"]')].map((r) => ({
    title: r.querySelector('.truncate')?.textContent?.trim() ?? '',
    depth: r.style.paddingInlineStart ? (parseInt(r.style.paddingInlineStart, 10) - 16) / 16 : 0,
    checked: r.getAttribute('aria-checked') === 'true',
    current: r.textContent?.includes('Current') ?? false
  }))
const option = (title: string): HTMLElement =>
  [...sheet()!.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (r) => r.querySelector('.truncate')?.textContent?.trim() === title
  )!
const footerButton = (label: string): HTMLButtonElement =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('.zen-frame-dialogs .zen-sheet-footer button')
  ].find((b) => b.textContent?.trim() === label)!
const newFolder = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(
    '.zen-frame-dialogs .zen-sheet-header-control[data-side="trailing"]'
  )!

// --- the row menu ------------------------------------------------------------------------------

describe("the bookmark row's menu (HB-12)", () => {
  it('opens at the top level and hangs Chrome’s rows from a page: Select, Edit…, Move to…, the open rows, Copy Link, then Delete – no reading-list row', async () => {
    await show()
    expect(titles()).toEqual(['Mobile bookmarks', 'Other bookmarks'])
    // The roots carry no menu (they neither move nor delete).
    expect(more('Mobile bookmarks')).toBeNull()
    await tap('Mobile bookmarks')
    expect(titles()).toEqual(['Work', 'Home', 'News', 'Mail'])
    await openMenu('News')
    expect(menu()).toEqual({
      title: 'News',
      items: [
        'Select',
        'Edit…',
        'Move to…',
        'Open in New Tab',
        'Open in Private Tab',
        'Copy Link',
        '-',
        'Delete'
      ]
    })
  })

  it('leaves the private row out on a host without private tabs, and adds Share… where the host shares', async () => {
    await show(stateOf(profile(), { share: true }))
    await tap('Mobile bookmarks')
    await openMenu('News')
    expect(menu()!.items).toEqual([
      'Select',
      'Edit…',
      'Move to…',
      'Open in New Tab',
      'Copy Link',
      'Share…',
      '-',
      'Delete'
    ])
  })

  it('reads Rename… and Open All (N) for a folder, its private row counting the pages under it', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('Work')
    expect(menu()).toEqual({
      title: 'Work',
      // One page under it: the private row reads as a page's (#203's `openInPrivateItems`).
      items: ['Select', 'Rename…', 'Move to…', 'Open All (1)', 'Open in Private Tab', '-', 'Delete']
    })
    await openMenu('Home')
    const items = uiStore.get().menu!.items
    expect(items.map((i) => (i.type === 'separator' ? '-' : i.label))).toEqual([
      'Select',
      'Rename…',
      'Move to…',
      'Open All (0)',
      '-',
      'Delete'
    ])
    // An empty folder has nothing to open.
    expect(items.find((i) => i.label === 'Open All (0)')).toMatchObject({ enabled: false })
  })

  it('Select starts selection mode with that row picked, as a long press does (Chrome’s toggleSelectionForItem)', async () => {
    await show()
    await tap('Mobile bookmarks')
    expect(selectionHeader()).toBeNull()
    await openMenu('Mail')
    await pick('Select')
    expect(selectionHeader()?.textContent).toBe('1 selected')
    expect(picked()).toEqual(['Mail'])
    // In selection mode a tap picks: the rows lose their ⋮.
    expect(more('News')).toBeNull()
    await tap('News')
    expect(picked()).toEqual(['News', 'Mail'])
    expect(selectionHeader()?.textContent).toBe('2 selected')
  })

  it('Open in Private Tab asks for a private tab on the page (#203’s row, kept)', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Open in Private Tab')
    expect(of('tab.newPrivate')).toEqual([{ url: 'https://news.example/' }])
    expect(uiStore.get().overlay).toBe('bookmarks')
  })

  it('Edit… opens the editor for the row, the panel staying', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Edit…')
    expect(uiStore.get().bookmarkEdit).toEqual({
      id: 'news',
      parentId: MOBILE_BOOKMARKS_ID,
      type: 'url'
    })
  })
})

// --- the selection bar -------------------------------------------------------------------------

describe('the selection bar’s More (HB-15)', () => {
  it('hangs Edit… for exactly one picked page, Move to…, the open rows, Copy Link and Delete', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Select')
    await openSelectionMenu()
    expect(menu()).toEqual({
      title: '1 selected',
      items: [
        'Edit…',
        'Move to…',
        'Open in New Tab',
        'Open in Private Tab',
        'Copy Link',
        '-',
        'Delete'
      ]
    })
  })

  it('reads Rename… for one picked folder and drops the edit row for two or more (Chrome: numSelected == 1)', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('Work')
    await pick('Select')
    await openSelectionMenu()
    expect(menu()!.items.slice(0, 2)).toEqual(['Rename…', 'Move to…'])
    act(() => uiStore.set({ menu: null }))
    await tap('News')
    await openSelectionMenu()
    expect(menu()).toEqual({
      title: '2 selected',
      items: [
        'Move to…',
        'Open All (2)',
        'Open All in Private (2)',
        'Copy Links',
        '-',
        'Delete 2 Items'
      ]
    })
  })

  it('Edit… for the one picked row opens the editor for it; the private row asks for a tab per page and leaves the selection', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('Mail')
    await pick('Select')
    await openSelectionMenu()
    await pick('Edit…')
    expect(uiStore.get().bookmarkEdit).toEqual({
      id: 'mail',
      parentId: MOBILE_BOOKMARKS_ID,
      type: 'url'
    })
    act(() => uiStore.set({ bookmarkEdit: null }))
    await tap('News')
    await openSelectionMenu()
    await pick('Open All in Private (2)')
    // In the list's order, whatever the order of the picks.
    expect(of('tab.newPrivate')).toEqual([
      { url: 'https://news.example/' },
      { url: 'https://mail.example/' }
    ])
    expect(selectionHeader()).toBeNull()
  })
})

// --- Move to… ----------------------------------------------------------------------------------

describe('Move to… and its folder picker', () => {
  it('stands every folder the page can land in as radio rows – the roots the list shows, each level 16 further in – the current folder checked and Move disabled on it (Chrome’s Move here on the original parent)', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Move to…')
    await land()
    expect(sheetTitle()).toBe('Move to')
    expect(options()).toEqual([
      { title: 'Mobile bookmarks', depth: 0, checked: true, current: true },
      { title: 'Work', depth: 1, checked: false, current: false },
      { title: 'Home', depth: 1, checked: false, current: false },
      { title: 'Other bookmarks', depth: 0, checked: false, current: false }
    ])
    // The empty Bookmarks bar stands nowhere in the list, as the panel's top level leaves it out.
    expect(footerButton('Move').disabled).toBe(true)
    expect(footerButton('Cancel').disabled).toBe(false)
    expect(newFolder().textContent?.trim()).toBe('New folder')
    expect(newFolder().disabled).toBe(false)
    // The checked row holds the focus as the sheet opens (§9.22).
    expect(document.activeElement).toBe(option('Mobile bookmarks'))
  })

  it('a tap checks a folder and Move slides the sheet away, then moves the page there through the core – no toast', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Move to…')
    await land()
    act(() => option('Work').click())
    await settle()
    expect(options().map((o) => o.checked)).toEqual([false, true, false, false])
    expect(footerButton('Move').disabled).toBe(false)
    act(() => footerButton('Move').click())
    // Nothing until the sheet has gone.
    expect(of('bookmark.move')).toEqual([])
    await land()
    expect(of('bookmark.move')).toEqual([{ ids: ['news'], parentId: 'work' }])
    expect(sheet()).toBeNull()
    expect(uiStore.get().toasts).toEqual([])
  })

  it('Cancel leaves everything as it was', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Move to…')
    await land()
    act(() => option('Work').click())
    act(() => footerButton('Cancel').click())
    await land()
    expect(sheet()).toBeNull()
    expect(of('bookmark.move')).toEqual([])
    expect(titles()).toEqual(['Work', 'Home', 'News', 'Mail'])
  })

  it('leaves a moved folder and everything under it out of the list', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('Work')
    await pick('Move to…')
    await land()
    expect(options().map((o) => o.title)).toEqual(['Mobile bookmarks', 'Home', 'Other bookmarks'])
    act(() => option('Home').click())
    act(() => footerButton('Move').click())
    await land()
    expect(of('bookmark.move')).toEqual([{ ids: ['work'], parentId: 'home' }])
  })

  it('moves a selection in its list order and ends the selection; a page picked with its folder goes with the folder', async () => {
    await show()
    await tap('Mobile bookmarks')
    await openMenu('Mail')
    await pick('Select')
    await tap('Work')
    await tap('News')
    await openSelectionMenu()
    await pick('Move to…')
    await land()
    // Work is moving: it and its subtree stand nowhere in the list.
    expect(options().map((o) => o.title)).toEqual(['Mobile bookmarks', 'Home', 'Other bookmarks'])
    expect(selectionHeader()?.textContent).toBe('3 selected')
    act(() => option('Other bookmarks').click())
    act(() => footerButton('Move').click())
    await land()
    expect(of('bookmark.move')).toEqual([
      { ids: ['work', 'news', 'mail'], parentId: OTHER_BOOKMARKS_ID }
    ])
    expect(selectionHeader()).toBeNull()
  })

  it('checks nothing for rows picked across folders (a search’s selection) – Move and New folder wait for a pick', async () => {
    await show()
    type('.example')
    await settle()
    expect(titles()).toEqual(['News', 'Mail', 'Jira', 'Docs'])
    await openMenu('News')
    await pick('Select')
    await tap('Docs')
    expect(selectionHeader()?.textContent).toBe('2 selected')
    await openSelectionMenu()
    await pick('Move to…')
    await land()
    expect(options()).toEqual([
      { title: 'Mobile bookmarks', depth: 0, checked: false, current: false },
      { title: 'Work', depth: 1, checked: false, current: false },
      { title: 'Home', depth: 1, checked: false, current: false },
      { title: 'Other bookmarks', depth: 0, checked: false, current: false }
    ])
    expect(footerButton('Move').disabled).toBe(true)
    expect(newFolder().disabled).toBe(true)
    // Nothing checked: the focus falls to the first row (the chassis's order).
    expect(document.activeElement).toBe(option('Mobile bookmarks'))
    act(() => option('Home').click())
    expect(footerButton('Move').disabled).toBe(false)
    expect(newFolder().disabled).toBe(false)
    act(() => footerButton('Move').click())
    await land()
    expect(of('bookmark.move')).toEqual([{ ids: ['news', 'docs'], parentId: 'home' }])
    expect(selectionHeader()).toBeNull()
  })

  it('New folder names a folder inside the checked one through the core and checks it once it arrives, ready for Move', async () => {
    const made = folder('reads', 'work', 1, 'Reads')
    invoke.mockImplementation(async (name) => (name === 'bookmark.create' ? made : null))
    await show()
    await tap('Mobile bookmarks')
    await openMenu('News')
    await pick('Move to…')
    await land()
    act(() => option('Work').click())
    act(() => newFolder().click())
    await land()
    // The one-field sheet over the picker (§9.12, §9.24): the field labelled by its header.
    const field = document.querySelector<HTMLInputElement>('.zen-frame-dialogs form input')!
    expect(field).not.toBeNull()
    expect(document.getElementById(field.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'New folder'
    )
    expect(field.placeholder).toBe('Folder in Work')
    // No autofocus on a phone (§9.22).
    expect(document.activeElement).not.toBe(field)
    expect(footerButton('Create').disabled).toBe(true)
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(field, '  Reads ')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(footerButton('Create').disabled).toBe(false)
    act(() => footerButton('Create').click())
    expect(of('bookmark.create')).toEqual([])
    await land()
    expect(of('bookmark.create')).toEqual([{ parentId: 'work', title: 'Reads', type: 'folder' }])
    // The core's state carries the folder: it stands under Work, checked.
    await push(stateOf([...profile(), made]))
    expect(options()).toEqual([
      { title: 'Mobile bookmarks', depth: 0, checked: false, current: true },
      { title: 'Work', depth: 1, checked: false, current: false },
      { title: 'Reads', depth: 2, checked: true, current: false },
      { title: 'Home', depth: 1, checked: false, current: false },
      { title: 'Other bookmarks', depth: 0, checked: false, current: false }
    ])
    act(() => footerButton('Move').click())
    await land()
    expect(of('bookmark.move')).toEqual([{ ids: ['news'], parentId: 'reads' }])
  })
})
