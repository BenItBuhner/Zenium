// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '@shared/bookmarks'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'

/*
 * The desktop's folder editor owns the move (W8-F13, the lead's ruling on the HB-16 twin brief):
 * `EditBookmarkDialog` for an existing folder is titled "Edit folder" with a "Parent folder"
 * row – the phone's `BookmarkEditSheet` pair – "Edit bookmark" / "Folder" for a page, "New
 * folder" / "Add bookmark" for a new node; the folder being edited and every folder below it are
 * the field's `disabled` set (the core's own `move` rule): absent from the recent list, at
 * `aria-disabled` and unpickable in the chooser tree, and never a sibling or an ancestor; a
 * picked parent moves on Save (`bookmark.update` then `bookmark.move`), an unchanged one does
 * not; a pick the tree later puts inside the set falls back to the folder's own parent. Rendered
 * for real in happy-dom, the desktop form factor, the menulist and the tree as the primitives
 * draw them (`FolderField`, `MenulistPopover`, `FolderChooser`).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { EditBookmarkDialog } = await import('../EditBookmarkDialog')

const NOW = 1_700_000_000_000
const TAB = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: 'https://example.com/',
  title: 'Example',
  favicon: null,
  pinned: false,
  essential: false,
  loading: false
} as unknown as Tab

const folder = (
  id: string,
  parentId: string | null,
  index: number,
  title: string,
  modified = 0
): BookmarkNode => ({
  id,
  parentId,
  index,
  type: 'folder',
  title,
  dateAdded: NOW,
  dateGroupModified: modified
})
const url = (id: string, parentId: string, index: number, title: string): BookmarkNode => ({
  id,
  parentId,
  index,
  type: 'url',
  title,
  url: `https://${id}.example/`,
  dateAdded: NOW
})

/**
 * Bookmarks bar: the folder Work (holding the page Jira and the folder Specs, which holds the
 * folder Archive), then the folder Home. Other bookmarks: the page Docs. Specs and Archive were
 * filed into most recently, so the recent list would lead with them were they not excluded.
 */
const profile = (): BookmarkNode[] => [
  folder(BOOKMARKS_BAR_ID, null, 0, 'Bookmarks bar'),
  folder(OTHER_BOOKMARKS_ID, null, 1, 'Other bookmarks'),
  folder('3', null, 2, 'Mobile bookmarks'),
  folder('work', BOOKMARKS_BAR_ID, 0, 'Work', 40),
  url('jira', 'work', 0, 'Jira'),
  folder('specs', 'work', 1, 'Specs', 90),
  folder('archive', 'specs', 0, 'Archive', 80),
  folder('home', BOOKMARKS_BAR_ID, 1, 'Home', 30),
  url('docs', OTHER_BOOKMARKS_ID, 0, 'Docs')
]

function stateOf(bookmarks: BookmarkNode[] = profile()): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: true, extensions: true, pageTabs: true },
    tabs: { t1: TAB },
    spaces: [{ id: 'space', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    settings: {},
    bookmarks
  } as unknown as UIState
}

type Edit = { id: string | null; parentId: string; type: 'url' | 'folder' }

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

function show(edit: Edit, state: UIState = stateOf()): void {
  uiStore.set({ bookmarkEdit: edit })
  render(<EditBookmarkDialog key={edit.id ?? `new-${edit.type}`} state={state} edit={edit} />)
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector)
]
const dialog = (): HTMLElement | null => q('[role="dialog"].zen-v2-dialog')
const title = (): string => q('#zen-bm-edit-title')?.textContent?.trim() ?? ''
const labels = (): string[] => qa('.zen-v2-field-label').map((l) => l.textContent?.trim() ?? '')
const trigger = (): HTMLButtonElement | null => q<HTMLButtonElement>('.zen-v2-menulist')
const listbox = (): HTMLElement | null => q('[role="listbox"]')
const options = (): string[] =>
  qa('[role="listbox"] [role="option"]').map((o) => o.textContent?.trim() ?? '')
const tree = (): HTMLElement | null => q('[role="tree"]')
const rows = (): HTMLElement[] => qa('[role="tree"] [role="treeitem"]')
const rowOf = (id: string): HTMLElement | null => q(`[role="tree"] [data-pick-name="${id}"]`)
const disabledRows = (): string[] =>
  rows()
    .filter((r) => r.getAttribute('aria-disabled') === 'true')
    .map((r) => r.dataset.pickName ?? '')
const selectedRow = (): string | null =>
  rows().find((r) => r.getAttribute('aria-selected') === 'true')?.dataset.pickName ?? null

const click = (el: Element | null): void => {
  if (!el) throw new Error('click: nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const key = (el: Element | null, k: string): void => {
  if (!el) throw new Error('key: no target')
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
const submit = (): void => {
  act(() => {
    q('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
const calls = (name: string): unknown[] =>
  run.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const order = (): string[] =>
  run.mock.calls.map(([n]) => n as string).filter((n) => n.startsWith('bookmark.'))

/** The menulist open, then "Choose another folder…": the tree in the field's place. */
function openTree(): void {
  click(trigger())
  expect(listbox()).not.toBeNull()
  const choose = qa('[role="listbox"] [role="option"]').find(
    (o) => o.textContent?.trim() === 'Choose another folder…'
  )
  click(choose ?? null)
  expect(tree()).not.toBeNull()
}
/** A closed branch opened by its twisty (the roots and the pick's ancestors alone start open). */
function expand(id: string): void {
  const row = rowOf(id)
  if (row?.getAttribute('aria-expanded') === 'true') return
  click(row?.querySelector('.zen-bm-pick-twisty') ?? null)
  expect(rowOf(id)?.getAttribute('aria-expanded')).toBe('true')
}

beforeEach(() => {
  run.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ bookmarkEdit: null })
  document.getElementById('zen-chrome-layer')?.replaceChildren()
})

describe('the folder editor’s words (W8-F13: "Edit folder", "Parent folder")', () => {
  it('an existing folder: "Edit folder", Name and "Parent folder" (no URL), the row reading the folder’s parent', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    expect(dialog()).not.toBeNull()
    expect(title()).toBe('Edit folder')
    expect(labels()).toEqual(['Name', 'Parent folder'])
    expect(q('#zen-bm-edit-url')).toBeNull()
    expect(q<HTMLInputElement>('#zen-bm-edit-name')?.value).toBe('Specs')
    expect(trigger()?.textContent?.trim()).toBe('Work')
    expect(trigger()?.id).toBe('zen-bm-edit-folder')
  })

  it('an existing bookmark keeps "Edit bookmark" with Name, URL and "Folder"', () => {
    show({ id: 'jira', parentId: 'work', type: 'url' })
    expect(title()).toBe('Edit bookmark')
    expect(labels()).toEqual(['Name', 'URL', 'Folder'])
    expect(trigger()?.textContent?.trim()).toBe('Work')
  })

  it('a new folder: "New folder" with Name and "Parent folder" – the phone’s pair, the label reading the same for both of a folder’s dialogs', () => {
    show({ id: null, parentId: 'work', type: 'folder' })
    expect(title()).toBe('New folder')
    expect(labels()).toEqual(['Name', 'Parent folder'])
    expect(q<HTMLInputElement>('#zen-bm-edit-name')?.value).toBe('New folder')
  })

  it('a new bookmark: "Add bookmark" with Name, URL and "Folder"', () => {
    show({ id: null, parentId: BOOKMARKS_BAR_ID, type: 'url' })
    expect(title()).toBe('Add bookmark')
    expect(labels()).toEqual(['Name', 'URL', 'Folder'])
  })

  it('a root has no parent row at all', () => {
    show({ id: BOOKMARKS_BAR_ID, parentId: BOOKMARKS_BAR_ID, type: 'folder' })
    expect(title()).toBe('Edit folder')
    expect(labels()).toEqual(['Name'])
    expect(trigger()).toBeNull()
  })

  it('the list and the tree take the row’s label as their accessible name: "Parent folder" on a folder’s editor, "Folder" on a bookmark’s', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    click(trigger())
    expect(listbox()?.getAttribute('aria-label')).toBe('Parent folder')
    openTreeFromOpenList()
    expect(tree()?.getAttribute('aria-label')).toBe('Parent folder')
    act(() => root!.unmount())
    root = null
    mount?.remove()
    mount = null
    show({ id: 'jira', parentId: 'work', type: 'url' })
    click(trigger())
    expect(listbox()?.getAttribute('aria-label')).toBe('Folder')
  })
})

function openTreeFromOpenList(): void {
  const choose = qa('[role="listbox"] [role="option"]').find(
    (o) => o.textContent?.trim() === 'Choose another folder…'
  )
  click(choose ?? null)
  expect(tree()).not.toBeNull()
}

describe('where a folder cannot go (the core’s move rule as the field’s disabled set)', () => {
  it('the recent list leaves out the folder and its subtree – Specs and Archive, filed into last, are not offered; the parent leads', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    click(trigger())
    const offered = options()
    expect(offered[0]).toBe('Work')
    expect(offered).not.toContain('Specs')
    expect(offered).not.toContain('Archive')
    expect(offered).toContain('Home')
    expect(offered).toContain('Bookmarks bar')
    expect(offered.at(-1)).toBe('Choose another folder…')
  })

  it('the slots the excluded folders leave are taken by the next recent folders – the list still offers five', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    click(trigger())
    // Specs and Archive would head the five recents; without them the roots fill the list.
    expect(options()).toEqual([
      'Work',
      'Home',
      'Bookmarks bar',
      'Other bookmarks',
      'Mobile bookmarks',
      'Choose another folder…'
    ])
  })

  it('the tree marks exactly the folder and its descendants disabled (§9.30) – never a sibling, an ancestor or a root', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    openTree()
    // The roots and the pick's ancestors start open: Work (the parent) is a row, its branch shut.
    expect(rowOf('work')).not.toBeNull()
    expand('work')
    expand('specs')
    expect(rows().map((r) => r.dataset.pickName)).toEqual([
      BOOKMARKS_BAR_ID,
      'work',
      'specs',
      'archive',
      'home',
      OTHER_BOOKMARKS_ID,
      '3'
    ])
    expect(disabledRows().sort()).toEqual(['archive', 'specs'])
    for (const id of ['work', 'home', BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, '3']) {
      expect(rowOf(id)?.getAttribute('aria-disabled')).toBeNull()
    }
    expect(selectedRow()).toBe('work')
  })

  it('a disabled row takes no pick – by the pointer or by Enter – and an enabled one does', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    openTree()
    expand('work')
    expand('specs')
    click(rowOf('specs'))
    expect(selectedRow()).toBe('work')
    click(rowOf('archive'))
    expect(selectedRow()).toBe('work')
    act(() => rowOf('archive')!.focus())
    key(rowOf('archive'), 'Enter')
    expect(selectedRow()).toBe('work')
    click(rowOf('home'))
    expect(selectedRow()).toBe('home')
  })

  it('a bookmark’s editor disables nothing: every folder can hold it', () => {
    show({ id: 'jira', parentId: 'work', type: 'url' })
    openTree()
    expand('work')
    expand('specs')
    expect(rows().length).toBe(7)
    expect(disabledRows()).toEqual([])
    click(rowOf('specs'))
    expect(selectedRow()).toBe('specs')
  })
})

describe('Save (the existing behaviour, pinned)', () => {
  it('a picked parent moves the folder: bookmark.update then bookmark.move into the pick', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    openTree()
    click(rowOf('home'))
    submit()
    expect(order()).toEqual(['bookmark.update', 'bookmark.move'])
    expect(calls('bookmark.update')).toEqual([{ id: 'specs', title: 'Specs' }])
    expect(calls('bookmark.move')).toEqual([{ ids: ['specs'], parentId: 'home' }])
    expect(uiStore.get().bookmarkEdit).toBeNull()
  })

  it('an unchanged parent moves nothing', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    submit()
    expect(order()).toEqual(['bookmark.update'])
    expect(uiStore.get().bookmarkEdit).toBeNull()
  })

  it('a bookmark moves the same way, its URL kept', () => {
    show({ id: 'jira', parentId: 'work', type: 'url' })
    openTree()
    click(rowOf('home'))
    submit()
    expect(order()).toEqual(['bookmark.update', 'bookmark.move'])
    expect(calls('bookmark.update')).toEqual([
      { id: 'jira', title: 'Jira', url: 'https://jira.example/' }
    ])
    expect(calls('bookmark.move')).toEqual([{ ids: ['jira'], parentId: 'home' }])
  })

  it('a pick the tree later puts inside the excluded set falls back to the folder’s own parent, and Save asks for no move the core would refuse', () => {
    show({ id: 'specs', parentId: 'work', type: 'folder' })
    openTree()
    click(rowOf('home'))
    expect(selectedRow()).toBe('home')
    // Elsewhere, Home was moved into Specs: the pick is now the folder's own subtree.
    const moved = profile().map((n) => (n.id === 'home' ? { ...n, parentId: 'specs' } : n))
    render(
      <EditBookmarkDialog
        key="specs"
        state={stateOf(moved)}
        edit={{ id: 'specs', parentId: 'work', type: 'folder' }}
      />
    )
    expect(selectedRow()).toBe('work')
    expand('work')
    expand('specs')
    expect(disabledRows().sort()).toEqual(['archive', 'home', 'specs'])
    submit()
    expect(order()).toEqual(['bookmark.update'])
  })
})
