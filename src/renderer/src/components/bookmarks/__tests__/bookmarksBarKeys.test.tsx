// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'

/*
 * The bookmarks bar's keyboard (bookmarks-19; design-language-v2-draft §9.22), with Chrome's bar
 * and a menu bar as the rule book: Down on a focused folder chip (or the ») opens its panel with
 * the first row under the keyboard; Up from that row, or Escape, closes it and hands the chip
 * the focus back; with a panel open Left and Right walk the bar – the neighbour folder's panel
 * opens in the open one's place, a neighbour that is a page takes the focus with the panel
 * closed – while deeper levels keep the cascade's own Left and Right.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { BookmarksBar } = await import('../BookmarksBar')

const node = (
  id: string,
  parentId: string,
  index: number,
  type: 'url' | 'folder',
  title: string
): BookmarkNode =>
  ({
    id,
    parentId,
    index,
    type,
    title,
    url: type === 'url' ? `https://${id}.example/` : undefined,
    dateAdded: 0
  }) as BookmarkNode

/** The bar: a page, the Reading folder (two pages and a folder inside), the Work folder, a page. */
const BOOKMARKS: BookmarkNode[] = [
  node(BOOKMARKS_BAR_ID, '0', 0, 'folder', 'Bookmarks bar'),
  node('docs', BOOKMARKS_BAR_ID, 0, 'url', 'Docs'),
  node('reading', BOOKMARKS_BAR_ID, 1, 'folder', 'Reading'),
  node('work', BOOKMARKS_BAR_ID, 2, 'folder', 'Work'),
  node('news', BOOKMARKS_BAR_ID, 3, 'url', 'News'),
  node('r1', 'reading', 0, 'url', 'Essay'),
  node('r2', 'reading', 1, 'url', 'Paper'),
  node('rf', 'reading', 2, 'folder', 'Later'),
  node('rf1', 'rf', 0, 'url', 'Someday'),
  node('w1', 'work', 0, 'url', 'Tracker')
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

const STATE = {
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
  settings: { showBookmarksBar: 'always' }
} as unknown as UIState

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

async function key(target: Element, k: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

const chip = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-bm-id="${id}"]`)!
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-bar-panel]')]
const panelLabels = (): string[] => panels().map((p) => p.getAttribute('aria-label') ?? '')
const row = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="menuitem"][data-bar-drop="row:${id}"]`)
const focused = (): HTMLElement | null => document.activeElement as HTMLElement | null

/** Land the roving stop on a chip as Tab or an arrow would. */
async function focusChip(id: string): Promise<void> {
  await act(async () => {
    chip(id).focus()
  })
}

async function mountBar(): Promise<void> {
  browserStore.set({ state: STATE })
  render(<BookmarksBar state={STATE} tab={TAB} />)
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
  document.getElementById('zen-chrome-layer')?.replaceChildren()
  uiStore.set({ barMenuOpen: false })
  vi.clearAllMocks()
})

describe('the bookmarks bar’s keyboard (bookmarks-19, §9.22)', () => {
  it('Down on a focused folder chip opens its panel with the first row under the keyboard; a page chip has no panel', async () => {
    await mountBar()
    await focusChip('docs')
    await key(chip('docs'), 'ArrowDown')
    expect(panels()).toEqual([])
    expect(uiStore.get().barMenuOpen).toBe(false)
    expect(focused()).toBe(chip('docs'))

    await key(chip('docs'), 'ArrowRight')
    expect(focused()).toBe(chip('reading'))
    await key(chip('reading'), 'ArrowDown')
    expect(panelLabels()).toEqual(['Reading'])
    expect(chip('reading').getAttribute('aria-expanded')).toBe('true')
    expect(uiStore.get().barMenuOpen).toBe(true)
    // The first row, not the panel: the keyboard asked for it.
    expect(focused()).toBe(row('r1'))
  })

  it('Up from the panel’s first row closes it onto the chip, as Escape does; deeper in the list Up is the menu’s Up', async () => {
    await mountBar()
    await focusChip('reading')
    await key(chip('reading'), 'ArrowDown')
    expect(focused()).toBe(row('r1'))

    await key(row('r1')!, 'ArrowDown')
    expect(focused()).toBe(row('r2'))
    await key(row('r2')!, 'ArrowUp')
    expect(focused()).toBe(row('r1'))
    expect(panelLabels()).toEqual(['Reading'])

    await key(row('r1')!, 'ArrowUp')
    expect(panels()).toEqual([])
    expect(uiStore.get().barMenuOpen).toBe(false)
    expect(focused()).toBe(chip('reading'))
    expect(chip('reading').getAttribute('aria-expanded')).toBe('false')

    await key(chip('reading'), 'ArrowDown')
    expect(focused()).toBe(row('r1'))
    await key(row('r1')!, 'Escape')
    expect(panels()).toEqual([])
    expect(focused()).toBe(chip('reading'))
  })

  it('Up on the chip itself puts away a panel the pointer opened', async () => {
    await mountBar()
    await act(async () => {
      chip('work').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(panelLabels()).toEqual(['Work'])
    expect(uiStore.get().barMenuOpen).toBe(true)

    // The keyboard comes back to the chip while its panel stands: Up puts the panel away.
    await focusChip('work')
    await key(chip('work'), 'ArrowUp')
    expect(panels()).toEqual([])
    expect(uiStore.get().barMenuOpen).toBe(false)
    expect(focused()).toBe(chip('work'))
    // Without a panel, Up is not the strip's key.
    await key(chip('work'), 'ArrowUp')
    expect(focused()).toBe(chip('work'))
  })

  it('Right and Left with a panel open walk the bar: the neighbour folder’s panel opens in its place, on its first row', async () => {
    await mountBar()
    await focusChip('reading')
    await key(chip('reading'), 'ArrowDown')
    expect(focused()).toBe(row('r1'))

    await key(row('r1')!, 'ArrowRight')
    expect(panelLabels()).toEqual(['Work'])
    expect(focused()).toBe(row('w1'))
    expect(chip('work').getAttribute('aria-expanded')).toBe('true')
    expect(chip('reading').getAttribute('aria-expanded')).toBe('false')
    expect(uiStore.get().barMenuOpen).toBe(true)

    await key(row('w1')!, 'ArrowLeft')
    expect(panelLabels()).toEqual(['Reading'])
    expect(focused()).toBe(row('r1'))
  })

  it('a neighbour that is a page takes the focus with the panel closed, and the arrows wrap round the bar', async () => {
    await mountBar()
    await focusChip('work')
    await key(chip('work'), 'ArrowDown')
    expect(focused()).toBe(row('w1'))

    await key(row('w1')!, 'ArrowRight')
    expect(panels()).toEqual([])
    expect(uiStore.get().barMenuOpen).toBe(false)
    expect(focused()).toBe(chip('news'))
    // The roving stop moved with it: the next arrow walks on from there.
    await key(chip('news'), 'ArrowRight')
    expect(focused()).toBe(chip('docs'))

    await key(chip('docs'), 'ArrowLeft')
    expect(focused()).toBe(chip('news'))
    await key(chip('news'), 'ArrowLeft')
    expect(focused()).toBe(chip('work'))
    await key(chip('work'), 'ArrowDown')
    await key(row('w1')!, 'ArrowLeft')
    expect(panelLabels()).toEqual(['Reading'])
    expect(focused()).toBe(row('r1'))
    // Left from the first folder lands on the page chip before it.
    await key(row('r1')!, 'ArrowLeft')
    expect(panels()).toEqual([])
    expect(focused()).toBe(chip('docs'))
  })

  it('a folder row keeps the cascade’s Right and Left: its level opens beside, and Left comes back to the row, not the bar', async () => {
    await mountBar()
    await focusChip('reading')
    await key(chip('reading'), 'ArrowDown')
    await key(row('r1')!, 'End')
    expect(focused()).toBe(row('rf'))

    await key(row('rf')!, 'ArrowRight')
    expect(panelLabels()).toEqual(['Reading', 'Later'])
    expect(focused()).toBe(row('rf1'))
    // Up inside the deeper level is the menu's: one row, wrapping – never the bar's close.
    await key(row('rf1')!, 'ArrowUp')
    expect(focused()).toBe(row('rf1'))
    expect(panelLabels()).toEqual(['Reading', 'Later'])

    await key(row('rf1')!, 'ArrowLeft')
    expect(panelLabels()).toEqual(['Reading'])
    expect(focused()).toBe(row('rf'))
    expect(chip('reading').getAttribute('aria-expanded')).toBe('true')
    // Backspace at the root still closes the panel outright (no walk).
    await key(row('rf')!, 'Backspace')
    expect(panels()).toEqual([])
    expect(focused()).toBe(chip('reading'))
  })
})
