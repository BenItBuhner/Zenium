// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'

/*
 * A private window and its bookmarks (bookmarks-43). The store is the profile's, as Chrome's
 * Incognito bookmarks are, so: Ctrl+D's star bubble names the bookmark as a private window's on
 * its first line, never filing a page without a word; and the bar of a private window reads and
 * opens but never writes – no drop (a tab, a link), no paste, no Delete, F2 or Cut on a chip, no
 * drop or Delete in a folder's panel – while Copy and opening stay. The menus' rows are the
 * core's (`bookmarkBarMenus.test.ts`).
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
const { StarDialog, PRIVATE_STAR_TITLE, PRIVATE_STAR_DESCRIPTION } = await import('../StarDialog')
type StarTarget = import('../StarDialog').StarTarget

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

const BOOKMARKS: BookmarkNode[] = [
  node(BOOKMARKS_BAR_ID, '0', 0, 'folder', 'Bookmarks bar'),
  node('docs', BOOKMARKS_BAR_ID, 0, 'url', 'Docs'),
  node('reading', BOOKMARKS_BAR_ID, 1, 'folder', 'Reading'),
  node('r1', 'reading', 0, 'url', 'Essay')
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

function state(kind: 'synced' | 'private', bookmarks = BOOKMARKS, tabs?: Tab[]): UIState {
  const list = tabs ?? [tab('t1', kind === 'private' ? PRIVATE_CONTAINER_ID : DEFAULT_CONTAINER_ID)]
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    window: { kind, fullscreen: false, htmlFullscreenTabId: null },
    tabs: Object.fromEntries(list.map((t) => [t.id, t])),
    spaces: [{ id: 'space', name: 'Home', tabIds: list.map((t) => t.id), activeTabId: list[0].id }],
    activeSpaceId: 'space',
    folders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    bookmarks,
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

async function key(target: Element, k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
    )
  })
  await flush()
}

/** A link's HTML5 drag as the bar reads it: `text/uri-list` with a plain-text twin. */
function linkTransfer(url: string): DataTransfer {
  const data: Record<string, string> = { 'text/uri-list': url, 'text/plain': url }
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    files: [],
    dropEffect: 'none',
    effectAllowed: 'all'
  } as unknown as DataTransfer
}

/** Dispatch a drag event (happy-dom has no `DragEvent`) carrying `dataTransfer`; true when accepted. */
async function drag(
  target: Element,
  type: 'dragover' | 'drop',
  dt: DataTransfer
): Promise<boolean> {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  Object.defineProperty(e, 'clientX', { value: 5 })
  Object.defineProperty(e, 'clientY', { value: 5 })
  let accepted = false
  await act(async () => {
    accepted = !target.dispatchEvent(e)
  })
  await flush()
  return accepted
}

const chip = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-bm-id="${id}"]`)!
const strip = (): HTMLElement => document.querySelector<HTMLElement>('.zen-bm-strip')!
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-bar-panel]')]
const row = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="menuitem"][data-bar-drop="row:${id}"]`)
const calls = (name: string): unknown[][] => vi.mocked(run).mock.calls.filter((c) => c[0] === name)

const TAB_DRAG = {
  tabId: 't1',
  remote: false,
  title: 'T1',
  favicon: null,
  width: 200,
  height: 32,
  tile: false,
  settling: false
}

async function mountBar(s: UIState): Promise<void> {
  browserStore.set({ state: s })
  render(<BookmarksBar state={s} tab={s.tabs.t1 ?? null} />)
  await flush()
}

async function focusChip(id: string): Promise<void> {
  await act(async () => {
    chip(id).focus()
  })
}

beforeEach(() => {
  uiStore.set({ barMenuOpen: false, starDialog: null, bookmarkEdit: null, drag: null })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.replaceChildren()
  uiStore.set({ barMenuOpen: false, drag: null, bookmarkEdit: null })
  vi.clearAllMocks()
})

describe("a private window's bookmarks bar reads and opens, never writes (bookmarks-43)", () => {
  it('takes no link drop and files nothing; the regular window’s bar takes it', async () => {
    await mountBar(state('private'))
    expect(await drag(strip(), 'dragover', linkTransfer('https://new.example/'))).toBe(false)
    expect(await drag(strip(), 'drop', linkTransfer('https://new.example/'))).toBe(false)
    expect(calls('bookmark.create')).toEqual([])

    act(() => root?.unmount())
    root = null
    await mountBar(state('synced'))
    expect(await drag(strip(), 'dragover', linkTransfer('https://new.example/'))).toBe(true)
    await drag(strip(), 'drop', linkTransfer('https://new.example/'))
    expect(calls('bookmark.create')).toHaveLength(1)
    expect(calls('bookmark.create')[0][1]).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      url: 'https://new.example/'
    })
  })

  it('a tab dragged from the sidebar finds no slot on it, where the regular bar offers one per chip edge', async () => {
    await mountBar(state('private'))
    act(() => uiStore.set({ drag: TAB_DRAG }))
    await flush()
    expect(document.querySelectorAll('[data-drop^="bookmark:"]')).toHaveLength(0)

    act(() => root?.unmount())
    root = null
    await mountBar(state('synced'))
    act(() => uiStore.set({ drag: TAB_DRAG }))
    await flush()
    expect(document.querySelectorAll('[data-drop^="bookmark:"]').length).toBeGreaterThan(0)
  })

  it('Delete, F2, Cut and paste do nothing on a chip; Copy and opening still work', async () => {
    await mountBar(state('private'))
    await focusChip('docs')
    await key(chip('docs'), 'Delete')
    await key(chip('docs'), 'F2')
    await key(chip('docs'), 'x', { ctrlKey: true })
    expect(calls('bookmark.remove')).toEqual([])
    expect(calls('bookmark.cut')).toEqual([])
    expect(uiStore.get().bookmarkEdit).toBeNull()

    await key(chip('docs'), 'c', { ctrlKey: true })
    expect(calls('bookmark.copy')).toEqual([['bookmark.copy', { ids: ['docs'] }]])

    await act(async () => {
      chip('docs').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls('bookmark.open')).toEqual([
      ['bookmark.open', { id: 'docs', newTab: false, tabId: 't1' }]
    ])

    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: linkTransfer('https://p.example/') })
    await act(async () => {
      chip('docs').dispatchEvent(paste)
    })
    await flush()
    expect(calls('bookmark.create')).toEqual([])
  })

  it('a folder still opens from the keyboard; its panel takes no drop and no Delete', async () => {
    await mountBar(state('private'))
    await focusChip('reading')
    await key(chip('reading'), 'ArrowDown')
    expect(panels()).toHaveLength(1)
    expect(document.activeElement).toBe(row('r1'))

    expect(await drag(row('r1')!, 'dragover', linkTransfer('https://new.example/'))).toBe(false)
    await drag(row('r1')!, 'drop', linkTransfer('https://new.example/'))
    await key(row('r1')!, 'Delete')
    expect(calls('bookmark.create')).toEqual([])
    expect(calls('bookmark.remove')).toEqual([])

    await key(row('r1')!, 'Enter')
    expect(calls('bookmark.open')).toEqual([
      ['bookmark.open', { id: 'r1', newTab: false, tabId: 't1' }]
    ])
  })

  it('an empty private bar shows no invitation to drag or add', async () => {
    await mountBar(state('private', [BOOKMARKS[0]]))
    expect(document.querySelector('.zen-bm-empty')).toBeNull()
    act(() => root?.unmount())
    root = null
    await mountBar(state('synced', [BOOKMARKS[0]]))
    expect(document.querySelector('.zen-bm-empty')?.textContent).toContain('Drag a tab')
  })
})

describe("the star bubble names a private window's bookmark (bookmarks-43)", () => {
  const star = (created: boolean): StarTarget => ({
    tabId: 't1',
    nodeId: 'docs',
    created,
    anchor: { x: 1200, y: 40, width: 28, height: 28 },
    pill: { x: 400, y: 30, width: 900, height: 36 }
  })
  const title = (): string =>
    document.getElementById('zen-bm-star-title')?.textContent?.trim() ?? ''
  const description = (): string | null =>
    document.getElementById('zen-bm-star-description')?.textContent?.trim() ?? null

  it('a page just filed from a private window: the first line says so, the second where it went', () => {
    const s = state('private')
    browserStore.set({ state: s })
    render(<StarDialog state={s} star={star(true)} />)
    expect(title()).toBe(PRIVATE_STAR_TITLE)
    expect(title()).toBe('Bookmark saved from a private window')
    expect(description()).toBe(PRIVATE_STAR_DESCRIPTION)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-describedby')).toBe('zen-bm-star-description')
    expect(dialog.dataset.privateSave).toBe('true')
    // The form is the bubble's: Name, Folder, Remove, Done.
    expect(document.getElementById('zen-bm-star-name')).not.toBeNull()
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Remove', 'Done'])
    )
  })

  it('a private tab in a regular window counts as private too; a regular tab reads "Bookmark added"', () => {
    const mixed = state('synced', BOOKMARKS, [tab('t1', PRIVATE_CONTAINER_ID)])
    browserStore.set({ state: mixed })
    render(<StarDialog state={mixed} star={star(true)} />)
    expect(title()).toBe(PRIVATE_STAR_TITLE)

    act(() => root?.unmount())
    root = null
    document.getElementById('zen-chrome-layer')?.replaceChildren()
    const regular = state('synced')
    browserStore.set({ state: regular })
    render(<StarDialog state={regular} star={star(true)} />)
    expect(title()).toBe('Bookmark added')
    expect(description()).toBeNull()
  })

  it('an existing bookmark starred again in a private window is edited, not saved anew', () => {
    const s = state('private')
    browserStore.set({ state: s })
    render(<StarDialog state={s} star={star(false)} />)
    expect(title()).toBe('Edit bookmark')
    expect(description()).toBeNull()
  })
})
