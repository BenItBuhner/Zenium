// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, ReadingListEntry, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The star sheet's Reading list row (HB-20; v2 draft §9.11, §9.21, §10.4): under a bookmark's
 * Name and Address fields, the switch row that is the page's reading-list toggle – off while
 * the list lacks the page, on while it holds it – flipped in place through the desktop's
 * commands alone: `readingList.add` by the tab showing the page (the active tab first, the
 * star's own flow) and `readingList.remove` by the entry's id. A bookmark no tab shows and the
 * list lacks cannot be added from here (the model's add is by tab): its switch stands disabled
 * with the reason under the label. A folder's sheet, and a new bookmark's, have no row. The
 * switch reads the list as the core last pushed it. Rendered for real on the frame's dialog
 * host, the frame loop cranked by hand.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const PAGE = 'https://a.example/article'

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BookmarkEditSheet } = await import('../BookmarkEditSheet')
const { readingListToggle } = await import('../readingListToggle')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')

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

const BOOKMARK: BookmarkNode = {
  id: 'bm1',
  parentId: 'mobile',
  type: 'url',
  title: 'Alpha',
  url: PAGE,
  index: 0,
  dateAdded: NOW
} as unknown as BookmarkNode
const FOLDER: BookmarkNode = {
  id: 'f1',
  parentId: 'mobile',
  type: 'folder',
  title: 'Reads',
  index: 1,
  dateAdded: NOW
} as unknown as BookmarkNode

function entryFor(url: string): ReadingListEntry {
  return { id: 'rl_1', url, title: 'Alpha', addedAt: NOW - 60_000, updatedAt: NOW - 60_000 }
}

/** `tabs` in track order, the first active; the bookmarks and the reading list as given. */
function stateOf(
  tabs: Tab[],
  readingList: ReadingListEntry[] = [],
  bookmarks: BookmarkNode[] = [BOOKMARK, FOLDER]
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
    capabilities: { windowControls: false, extensions: false, pageTabs: true },
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
    readingList
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

/** Run the springs out: the sheet lands. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

/** The editor is up for `id` over `state`. */
async function show(
  state: UIState,
  id: string | null,
  type: 'url' | 'folder' = 'url'
): Promise<void> {
  act(() => browserStore.set({ state }))
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  const edit = { id, parentId: 'mobile', type }
  act(() => uiStore.set({ bookmarkEdit: edit }))
  act(() =>
    root!.render(
      createElement(FrameDialogHost, null, createElement(BookmarkEditSheet, { state, edit }))
    )
  )
  await settle()
  await land()
}

/** The core pushed a new state under the open sheet. */
async function push(state: UIState, id: string | null = 'bm1'): Promise<void> {
  act(() => browserStore.set({ state }))
  act(() =>
    root!.render(
      createElement(
        FrameDialogHost,
        null,
        createElement(BookmarkEditSheet, { state, edit: { id, parentId: 'mobile', type: 'url' } })
      )
    )
  )
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  frames.install()
  invoke.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
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
  uiStore.set({ bookmarkEdit: null, toasts: [] })
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
const row = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-testid="bookmark-reading-list"]')
const labels = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs label')].map(
    (l) => l.textContent?.trim() ?? ''
  )

// --- the row -----------------------------------------------------------------------------------

describe("the star sheet's Reading list row (HB-20)", () => {
  it('stands under the bookmark’s fields as the page’s switch – off while the list lacks the page – and adds the page by the tab showing it when flipped, the sheet staying up', async () => {
    await show(stateOf([tab('t1', PAGE), tab('t2', 'https://b.example/')]), 'bm1')
    expect(labels()).toEqual(['Name', 'Address'])
    const toggle = row()!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(false)
    expect(toggle.textContent?.trim()).toBe('Reading list')
    // The switch is the shared 36 × 20 track (§10.4), drawn on from the row's `aria-checked`.
    expect(toggle.querySelector('.zen-v2-switch')).not.toBeNull()
    // Under the fields, above the footer's Delete | Save.
    const form = toggle.closest('form')!
    const order = [...form.children].map((el) =>
      el.matches('[data-testid="bookmark-reading-list"]')
        ? 'reading-list'
        : el.classList.contains('zen-sheet-footer')
          ? 'footer'
          : 'field'
    )
    expect(order).toEqual(['field', 'field', 'reading-list', 'footer'])

    act(() => toggle.click())
    await settle()
    expect(of('readingList.add')).toEqual([{ tabId: 't1' }])
    expect(of('readingList.remove')).toEqual([])
    expect(uiStore.get().bookmarkEdit).not.toBeNull()
    expect(row()).not.toBeNull()

    // The core's push lands: the switch reads on from the list, and flipping it back removes
    // the entry by its id (no tab needed).
    await push(stateOf([tab('t1', PAGE), tab('t2', 'https://b.example/')], [entryFor(PAGE)]))
    expect(row()!.getAttribute('aria-checked')).toBe('true')
    act(() => row()!.click())
    await settle()
    expect(of('readingList.remove')).toEqual([{ id: 'rl_1' }])
    expect(of('readingList.add')).toEqual([{ tabId: 't1' }])
  })

  it('adds by the active tab when it shows the page, else by another tab that does, and stands disabled with the reason when none does and the list lacks the page', () => {
    const active = stateOf([tab('t1', PAGE), tab('t2', PAGE)])
    expect(readingListToggle(active, BOOKMARK)).toEqual({ entry: null, tabId: 't1' })
    const other = stateOf([tab('t0', 'https://z.example/'), tab('t2', PAGE)])
    expect(readingListToggle(other, BOOKMARK)).toEqual({ entry: null, tabId: 't2' })
    const none = stateOf([tab('t0', 'https://z.example/')])
    expect(readingListToggle(none, BOOKMARK)).toEqual({ entry: null, tabId: null })
    // Listed already: the entry, whether or not a tab shows the page.
    const listed = stateOf([tab('t0', 'https://z.example/')], [entryFor(PAGE)])
    expect(readingListToggle(listed, BOOKMARK)).toEqual({ entry: entryFor(PAGE), tabId: null })
    // A folder, or a node not here, has no toggle.
    expect(readingListToggle(active, FOLDER)).toBeNull()
    expect(readingListToggle(active, null)).toBeNull()
  })

  it('stands disabled with the reason under the label for a bookmark no tab shows (the model adds by tab), yet turns a listed one off by id', async () => {
    await show(stateOf([tab('t0', 'https://z.example/')]), 'bm1')
    const toggle = row()!
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.textContent).toContain('Open the page to add it to your reading list')
    act(() => toggle.click())
    await settle()
    expect(of('readingList.add')).toEqual([])

    await push(stateOf([tab('t0', 'https://z.example/')], [entryFor(PAGE)]))
    expect(row()!.disabled).toBe(false)
    expect(row()!.getAttribute('aria-checked')).toBe('true')
    expect(row()!.textContent?.trim()).toBe('Reading list')
    act(() => row()!.click())
    await settle()
    expect(of('readingList.remove')).toEqual([{ id: 'rl_1' }])
  })

  it('has no row on a folder’s sheet or a new bookmark’s', async () => {
    await show(stateOf([tab('t1', PAGE)]), 'f1', 'folder')
    expect(labels()).toEqual(['Name'])
    expect(row()).toBeNull()
    act(() => root?.unmount())
    root = null
    await show(stateOf([tab('t1', PAGE)]), null)
    expect(labels()).toEqual(['Name', 'Address'])
    expect(row()).toBeNull()
  })
})
