// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'
import { BOOKMARK_DRAG_TYPE } from '@renderer/lib/addressDrag'

/*
 * A bookmark dragged off the bar (bookmarks-15, dnd-13): a chip's press that moves off the bar
 * becomes an HTML5 drag of the page's link – `text/uri-list`, `text/plain`, an anchor named for
 * the bookmark, the chip's own mark – with the link card as its image, so a file manager makes
 * a link file of it and a tab row or the page navigates to it; a press that moves along the
 * bar stays the pointer reorder's (the native drag is refused). The bar and its panels take
 * the chip back as a move, never as a second bookmark. What the drag carries is
 * `lib/addressDrag.ts`'s (its own tests).
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
const { slotWithout } = await import('../tree')

const node = (
  id: string,
  parentId: string,
  index: number,
  type: 'url' | 'folder',
  title: string,
  url = type === 'url' ? `https://${id}.example/` : undefined
): BookmarkNode => ({ id, parentId, index, type, title, url, dateAdded: 0 }) as BookmarkNode

const BOOKMARKS: BookmarkNode[] = [
  node(BOOKMARKS_BAR_ID, '0', 0, 'folder', 'Bookmarks bar'),
  node('docs', BOOKMARKS_BAR_ID, 0, 'url', 'Docs'),
  node('reading', BOOKMARKS_BAR_ID, 1, 'folder', 'Reading'),
  node('news', BOOKMARKS_BAR_ID, 2, 'url', 'News'),
  node('let', BOOKMARKS_BAR_ID, 3, 'url', 'Bookmarklet', 'javascript:alert(1)'),
  node('r1', 'reading', 0, 'url', 'Essay'),
  node('r2', 'reading', 1, 'url', 'Paper')
]

function tab(id: string, containerId: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    folderId: null,
    splitGroupId: null,
    canGoBack: false,
    canGoForward: false
  } as unknown as Tab
}

function state(kind: 'synced' | 'private'): UIState {
  const t = tab('t1', kind === 'private' ? PRIVATE_CONTAINER_ID : DEFAULT_CONTAINER_ID)
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    window: { kind, fullscreen: false, htmlFullscreenTabId: null },
    tabs: { t1: t },
    spaces: [{ id: 'space', name: 'Home', tabIds: ['t1'], activeTabId: 't1' }],
    activeSpaceId: 'space',
    folders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    bookmarks: BOOKMARKS,
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
  render(<BookmarksBar state={s} tab={s.tabs.t1 ?? null} />)
  await flush()
}

const chip = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-bm-id="${id}"]`)!
const strip = (): HTMLElement => document.querySelector<HTMLElement>('.zen-bm-strip')!
const row = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="menuitem"][data-bar-drop="row:${id}"]`)
const calls = (name: string): unknown[][] => vi.mocked(run).mock.calls.filter((c) => c[0] === name)

/** What a `dragstart` wrote, and the transfer a `dragover` or `drop` reads it back from. */
interface Transfer {
  effectAllowed: string
  dropEffect: string
  data: Map<string, string>
  image: { el: Element; x: number; y: number } | null
  types: string[]
  getData(type: string): string
  setData(type: string, value: string): void
  setDragImage(el: Element, x: number, y: number): void
  files: File[]
}

function transfer(data: Record<string, string> = {}): Transfer {
  const map = new Map(Object.entries(data))
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    data: map,
    image: null,
    get types() {
      return [...map.keys()]
    },
    getData: (type) => map.get(type) ?? '',
    setData: (type, value) => void map.set(type, value),
    setDragImage(el, x, y) {
      this.image = { el, x, y }
    },
    files: []
  }
}

/** A drag of the bar's own chip `id`, as its `dragstart` writes it (`writeBookmarkDrag`). */
const ownChip = (id: string): Transfer =>
  transfer({
    'text/uri-list': `https://${id}.example/`,
    'text/plain': `https://${id}.example/`,
    'text/html': `<a href="https://${id}.example/">${id}</a>`,
    [BOOKMARK_DRAG_TYPE]: id
  })

/** A link's HTML5 drag from a page. */
const link = (url: string): Transfer => transfer({ 'text/uri-list': url, 'text/plain': url })

/** Dispatch a drag event (happy-dom has no `DragEvent`) at `(x, y)`; true when it was accepted. */
async function drag(
  target: Element,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  dt: Transfer,
  x = 5,
  y = 5
): Promise<boolean> {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  Object.defineProperty(e, 'clientX', { value: x })
  Object.defineProperty(e, 'clientY', { value: y })
  let accepted = false
  await act(async () => {
    accepted = !target.dispatchEvent(e)
  })
  await flush()
  return accepted
}

/** The press a drag grows out of: where the pointer went down on the chip. */
async function press(target: Element, x: number, y: number): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse',
        clientX: x,
        clientY: y
      })
    )
  })
  await flush()
}

/** The pointer moving (or lifting) after the press, as Blink dispatches it before `dragstart`. */
async function pointer(
  target: Element,
  type: 'pointermove' | 'pointerup',
  x: number,
  y: number
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: type === 'pointerup' ? 0 : -1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y
      })
    )
  })
  await flush()
}

async function key(target: Element, k: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

const elementFromPoint = document.elementFromPoint

beforeEach(() => {
  uiStore.set({ barMenuOpen: false, starDialog: null, bookmarkEdit: null, drag: null })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.replaceChildren()
  document.elementFromPoint = elementFromPoint
  uiStore.set({ barMenuOpen: false, drag: null, bookmarkEdit: null })
  vi.clearAllMocks()
})

describe('a chip dragged off the bar is the page’s link (bookmarks-15, dnd-13)', () => {
  it('a page chip is draggable and names its address; a folder and a bookmarklet lift nothing', async () => {
    await mountBar(state('synced'))
    expect(chip('docs').getAttribute('draggable')).toBe('true')
    expect(chip('docs').getAttribute('data-drag-address')).toBe('https://docs.example/')
    expect(chip('reading').hasAttribute('draggable')).toBe(false)
    expect(chip('let').hasAttribute('draggable')).toBe(false)
    expect(chip('let').hasAttribute('data-drag-address')).toBe(false)
  })

  it('a press moved off the bar lifts the link, the text, an anchor named for the bookmark and the chip’s mark, with the link card as the image', async () => {
    await mountBar(state('synced'))
    await press(chip('docs'), 20, 10)
    // The card stands from the press, drawn for the chip under it.
    const ghost = document.querySelector<HTMLElement>('.zen-link-ghost')!
    expect(ghost).not.toBeNull()
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.querySelector('.zen-link-ghost-card span')?.textContent).toBe('Docs')

    const dt = transfer()
    // Three pixels down: off the bar.
    expect(await drag(chip('docs'), 'dragstart', dt, 20, 14)).toBe(false)
    expect(dt.effectAllowed).toBe('all')
    expect([...dt.data.keys()]).toEqual([
      'text/uri-list',
      'text/plain',
      'text/html',
      BOOKMARK_DRAG_TYPE
    ])
    expect(dt.data.get('text/uri-list')).toBe('https://docs.example/')
    expect(dt.data.get('text/plain')).toBe('https://docs.example/')
    expect(dt.data.get('text/html')).toBe('<a href="https://docs.example/">Docs</a>')
    expect(dt.data.get(BOOKMARK_DRAG_TYPE)).toBe('docs')
    expect(dt.image).toEqual({ el: ghost, x: 12, y: 14 })
    // Nothing of the bar's own happened: no open, no edit.
    expect(calls('bookmark.open')).toEqual([])
    expect(calls('bookmark.move')).toEqual([])
    // The drag's end puts the card away.
    await drag(chip('docs'), 'dragend', dt)
    expect(document.querySelector('.zen-link-ghost')).toBeNull()
  })

  it('a press moved along the bar is the reorder’s: the native drag is refused and nothing is written', async () => {
    await mountBar(state('synced'))
    await press(chip('docs'), 20, 10)
    const dt = transfer()
    expect(await drag(chip('docs'), 'dragstart', dt, 26, 11)).toBe(true)
    expect([...dt.data.keys()]).toEqual([])
    expect(dt.image).toBeNull()
    // A press that never told where it began (no pointer press) reads as a link drag.
    act(() => root?.unmount())
    root = null
    await mountBar(state('synced'))
    const second = transfer()
    expect(await drag(chip('docs'), 'dragstart', second, 26, 11)).toBe(false)
    expect(second.data.get(BOOKMARK_DRAG_TYPE)).toBe('docs')
  })

  it('Chromium’s dragstart carries the press’s coordinates: the direction is the pointer’s last move', async () => {
    // Blink dispatches `dragstart` from the mousedown it kept (Electron 44.4.5: a press moved
    // 14 px straight down raised it at the press point), so the event's own place says nothing
    // of where the pointer went; the `pointermove` dispatched before it does.
    await mountBar(state('synced'))
    await press(chip('docs'), 20, 10)
    await pointer(chip('docs'), 'pointermove', 20, 14)
    const down = transfer()
    expect(await drag(chip('docs'), 'dragstart', down, 20, 10)).toBe(false)
    expect(down.data.get('text/uri-list')).toBe('https://docs.example/')
    expect(down.data.get(BOOKMARK_DRAG_TYPE)).toBe('docs')
    await drag(chip('docs'), 'dragend', down)

    // The same press point, the pointer gone along the bar: the reorder's.
    await press(chip('docs'), 20, 10)
    await pointer(chip('docs'), 'pointermove', 26, 11)
    const along = transfer()
    expect(await drag(chip('docs'), 'dragstart', along, 20, 10)).toBe(true)
    expect([...along.data.keys()]).toEqual([])
    expect(along.image).toBeNull()
    expect(calls('bookmark.open')).toEqual([])
    expect(calls('bookmark.move')).toEqual([])
  })

  it('each press is followed afresh, and no further once it lifts', async () => {
    await mountBar(state('synced'))
    // A first press that went down, lifted; a second that goes along the bar.
    await press(chip('docs'), 20, 10)
    await pointer(chip('docs'), 'pointermove', 20, 14)
    await pointer(chip('docs'), 'pointerup', 20, 14)
    await press(chip('docs'), 20, 10)
    await pointer(chip('docs'), 'pointermove', 26, 11)
    const along = transfer()
    expect(await drag(chip('docs'), 'dragstart', along, 20, 10)).toBe(true)
    expect([...along.data.keys()]).toEqual([])

    // A move after the lift is nobody's: the press it belonged to is over, so `dragstart` with
    // no motion followed reads as no motion – along the bar, refused.
    await pointer(chip('docs'), 'pointerup', 26, 11)
    await pointer(chip('docs'), 'pointermove', 20, 40)
    await press(chip('docs'), 20, 10)
    await pointer(chip('docs'), 'pointerup', 20, 10)
    await pointer(chip('docs'), 'pointermove', 20, 40)
    const stale = transfer()
    expect(await drag(chip('docs'), 'dragstart', stale, 20, 10)).toBe(true)
    expect([...stale.data.keys()]).toEqual([])
  })

  it('in a private window every direction lifts the link (the bar has no reorder), and the bar takes no chip back', async () => {
    await mountBar(state('private'))
    expect(chip('docs').getAttribute('draggable')).toBe('true')
    await press(chip('docs'), 20, 10)
    const dt = transfer()
    expect(await drag(chip('docs'), 'dragstart', dt, 40, 10)).toBe(false)
    expect(dt.data.get('text/uri-list')).toBe('https://docs.example/')
    expect(dt.data.get(BOOKMARK_DRAG_TYPE)).toBe('docs')
    // The drop back is an edit a private window's bar does not make.
    expect(await drag(strip(), 'dragover', ownChip('docs'))).toBe(false)
    expect(await drag(strip(), 'drop', ownChip('docs'))).toBe(false)
    expect(calls('bookmark.move')).toEqual([])
    expect(calls('bookmark.create')).toEqual([])
  })
})

describe('the bar takes its own chip back as a move (bookmarks-15)', () => {
  it('badges the chip as a move and a link as a copy', async () => {
    await mountBar(state('synced'))
    const own = ownChip('docs')
    expect(await drag(strip(), 'dragover', own)).toBe(true)
    expect(own.dropEffect).toBe('move')
    const page = link('https://new.example/')
    expect(await drag(strip(), 'dragover', page)).toBe(true)
    expect(page.dropEffect).toBe('copy')
  })

  it('a chip dropped on the strip moves to the slot, counted without itself, and files nothing', async () => {
    await mountBar(state('synced'))
    // Every chip lies at the origin here, so a drop at x = 5 is past them all: the last slot
    // among the other chips (reading, news, the bookmarklet) is 3, not 4.
    await drag(strip(), 'drop', ownChip('docs'))
    expect(calls('bookmark.move')).toEqual([
      ['bookmark.move', { ids: ['docs'], parentId: BOOKMARKS_BAR_ID, index: 3 }]
    ])
    expect(calls('bookmark.create')).toEqual([])
    // A link dropped at the same spot is a new bookmark in the slot counted with every chip.
    await drag(strip(), 'drop', link('https://new.example/'))
    expect(calls('bookmark.create')).toHaveLength(1)
    expect(calls('bookmark.create')[0][1]).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      index: 4,
      url: 'https://new.example/'
    })
  })

  it('a chip dropped into a folder’s panel moves there, beside the row it landed on', async () => {
    await mountBar(state('synced'))
    await act(async () => {
      chip('reading').focus()
    })
    await key(chip('reading'), 'ArrowDown')
    const target = row('r1')!
    expect(target).not.toBeNull()
    document.elementFromPoint = () => target
    const own = ownChip('docs')
    expect(await drag(target, 'dragover', own)).toBe(true)
    expect(own.dropEffect).toBe('move')
    // The row lies at the origin: a drop at y = 5 is on its lower half, after it.
    await drag(target, 'drop', own)
    expect(calls('bookmark.move')).toEqual([
      ['bookmark.move', { ids: ['docs'], parentId: 'reading', index: 1 }]
    ])
    expect(calls('bookmark.create')).toEqual([])
  })
})

describe('slotWithout', () => {
  const siblings = [
    node('a', 'p', 0, 'url', 'A'),
    node('b', 'p', 1, 'url', 'B'),
    node('c', 'p', 2, 'url', 'C')
  ]
  it('counts a slot among the siblings once the node in the hand is taken out', () => {
    expect(slotWithout(siblings, 'b', 0)).toBe(0)
    expect(slotWithout(siblings, 'b', 1)).toBe(1)
    expect(slotWithout(siblings, 'b', 2)).toBe(1)
    expect(slotWithout(siblings, 'b', 3)).toBe(2)
    // A node from elsewhere changes nothing.
    expect(slotWithout(siblings, 'z', 2)).toBe(2)
  })
})
