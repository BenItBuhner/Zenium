// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, ReadingListEntry, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'

/*
 * The bookmarks bar's Reading list control (W6-1, bookmarks-33; Chrome M89's seat at the bar's
 * trailing end): a chip with the book glyph and its label, §9.19's badge carrying the unread
 * count while anything waits – none otherwise – opening the `zen://reading-list` page tab, and
 * the strip's last roving stop (bookmarks-19) after the visible chips and the ».
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { BookmarksBar } = await import('../BookmarksBar')

const node = (id: string, parentId: string, index: number, title: string): BookmarkNode =>
  ({
    id,
    parentId,
    index,
    type: 'url',
    title,
    url: `https://${id}.example/`,
    dateAdded: 0
  }) as BookmarkNode

const BOOKMARKS: BookmarkNode[] = [
  { ...node(BOOKMARKS_BAR_ID, '0', 0, 'Bookmarks bar'), type: 'folder', url: undefined },
  node('docs', BOOKMARKS_BAR_ID, 0, 'Docs'),
  node('news', BOOKMARKS_BAR_ID, 1, 'News')
]

const TAB = {
  id: 't1',
  spaceId: 'space',
  url: 'https://page.example/',
  title: 'Page',
  folderId: null,
  splitGroupId: null,
  canGoBack: false,
  canGoForward: false
} as unknown as Tab

function entry(id: string, read = false): ReadingListEntry {
  const e: ReadingListEntry = {
    id,
    url: `https://${id}.read/`,
    title: id,
    addedAt: 1_000,
    updatedAt: 1_000
  }
  if (read) e.readAt = 2_000
  return e
}

function state(readingList: ReadingListEntry[]): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: { t1: TAB },
    spaces: [{ id: 'space', name: 'Home', tabIds: ['t1'], activeTabId: 't1' }],
    activeSpaceId: 'space',
    folders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    bookmarks: BOOKMARKS,
    readingList,
    settings: { showBookmarksBar: 'always' }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountBar(s: UIState): Promise<void> {
  browserStore.set({ state: s })
  render(<BookmarksBar state={s} tab={TAB} />)
  await flush()
}

const control = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-testid="bookmarks-bar-reading-list"]')!
const badge = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="bookmarks-bar-reading-list-count"]')
const chip = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-bm-id="${id}"]`)!
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function key(target: Element, k: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

beforeEach(() => {
  uiStore.set({ barMenuOpen: false, starDialog: null })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ barMenuOpen: false })
  vi.clearAllMocks()
})

describe('the bookmarks bar’s Reading list control (W6-1)', () => {
  it('stands at the bar’s trailing end as a chip with the book glyph, its label and no badge while nothing waits', async () => {
    await mountBar(state([]))
    const c = control()
    expect(c.classList.contains('zen-bm-chip')).toBe(true)
    expect(c.getAttribute('data-bm-id')).toBe('reading-list')
    expect(c.querySelector('svg.zen-bm-chip-icon')).not.toBeNull()
    expect(text(c.querySelector('.zen-bm-chip-label'))).toBe('Reading list')
    expect(c.getAttribute('aria-label')).toBe('Reading list')
    expect(badge()).toBeNull()
    expect(c.hasAttribute('data-unread')).toBe(false)
    // After the strip (the chips and the ») – the bar's own children, in order.
    const bar = c.closest('.zen-bm-bar')!
    const children = [...bar.children]
    expect(children.indexOf(c)).toBeGreaterThan(
      children.indexOf(bar.querySelector('.zen-bm-strip')!)
    )
  })

  it('carries the unread count as §9.19’s badge, read entries not counted, and names it for the reader', async () => {
    await mountBar(state([entry('a'), entry('b'), entry('c', true)]))
    const c = control()
    expect(text(badge())).toBe('2')
    expect(badge()!.classList.contains('zen-v2-badge')).toBe(true)
    expect(c.getAttribute('aria-label')).toBe('Reading list, 2 unread')
    expect(c.getAttribute('data-unread')).toBe('2')
    // Every entry read: the badge goes.
    await mountBar(state([entry('a', true), entry('c', true)]))
    expect(badge()).toBeNull()
    expect(control().getAttribute('aria-label')).toBe('Reading list')
  })

  it('opens the reading list page tab from this tab', async () => {
    await mountBar(state([entry('a')]))
    await act(async () => {
      control().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run).toHaveBeenCalledWith('page.open', { id: 'reading-list', openerTabId: 't1' })
  })

  it('is the strip’s last roving stop: End lands on it, Right wraps from it to the first chip, Down opens nothing', async () => {
    await mountBar(state([]))
    await act(async () => {
      chip('docs').focus()
    })
    await key(chip('docs'), 'End')
    expect(document.activeElement).toBe(control())
    expect(control().getAttribute('tabindex')).toBe('0')
    expect(chip('docs').getAttribute('tabindex')).toBe('-1')
    await key(control(), 'ArrowDown')
    expect(document.querySelectorAll('[data-bar-panel]')).toHaveLength(0)
    expect(document.activeElement).toBe(control())
    await key(control(), 'ArrowRight')
    expect(document.activeElement).toBe(chip('docs'))
    await key(chip('docs'), 'ArrowLeft')
    expect(document.activeElement).toBe(control())
    await key(control(), 'Home')
    expect(document.activeElement).toBe(chip('docs'))
  })
})
