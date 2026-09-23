// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, createBookmarkRoots, OTHER_BOOKMARKS_ID } from '@shared/bookmarks'

/*
 * The bookmarks manager page tab (design language v2 §10.1, §10.5; Chrome's chrome://bookmarks):
 * the title block with Add bookmark, Add folder and the page's ⋮, the search field, the folder
 * tree in the nav column beside the shown folder's §9.21 rows under the breadcrumb; the folder
 * in the tab's URL (`?folder=`, moved by `page.navigate` with a history entry) and the search
 * in it too (`?q=`, replaced); §9.6 selection, the row's ⋮ and context menu, F2's inline rename,
 * Delete, Enter; the §9.17 empty state; one pane where two do not fit.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom has no ResizeObserver; the page's width falls back to the viewport's.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
})

const NOW = 1_700_000_000_000

function node(
  partial: Partial<BookmarkNode> & Pick<BookmarkNode, 'id' | 'parentId'>
): BookmarkNode {
  return {
    index: 0,
    type: 'url',
    title: partial.id,
    dateAdded: NOW,
    ...partial
  }
}

const NODES: BookmarkNode[] = [
  ...createBookmarkRoots(NOW),
  node({ id: 'docs', parentId: BOOKMARKS_BAR_ID, index: 0, type: 'folder', title: 'Docs' }),
  node({
    id: 'zen',
    parentId: BOOKMARKS_BAR_ID,
    index: 1,
    title: 'Zen Browser',
    url: 'https://zen-browser.app/'
  }),
  node({
    id: 'news',
    parentId: BOOKMARKS_BAR_ID,
    index: 2,
    title: 'News',
    url: 'https://news.example.org/'
  }),
  node({
    id: 'mdn',
    parentId: 'docs',
    index: 0,
    title: 'MDN Web Docs',
    url: 'https://developer.mozilla.org/'
  }),
  node({ id: 'api', parentId: 'docs', index: 1, type: 'folder', title: 'API' }),
  node({
    id: 'fetch',
    parentId: 'api',
    index: 0,
    title: 'Fetch API',
    url: 'https://developer.mozilla.org/docs/Web/API/Fetch_API'
  }),
  node({
    id: 'other',
    parentId: OTHER_BOOKMARKS_ID,
    index: 0,
    title: 'Other thing',
    url: 'https://other.example.com/'
  })
]

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'bookmark.create')
    return node({
      id: 'new-folder',
      parentId: BOOKMARKS_BAR_ID,
      type: 'folder',
      title: 'New folder'
    })
  if (name === 'bookmark.import') return { folderId: 'docs', count: 1 }
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { BookmarkManager } = await import('../BookmarkManager')
const { HOLD_TO_OPEN_MS } = await import('../useBookmarkDrag')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { uiStore } = await import('@renderer/lib/ui')

function state(nodes: BookmarkNode[] = NODES): UIState {
  return { bookmarks: nodes, platform: 'linux', shortcuts: [] } as unknown as UIState
}

function tab(url = 'zen://bookmarks'): Tab {
  return { id: 'bm', url, title: 'Bookmarks' } as unknown as Tab
}

/** A window of `width` with a mouse. */
function viewport(width: number, coarse = false): void {
  viewportStore.set({
    ...viewportStore.get(),
    width,
    height: 1000,
    hover: !coarse,
    coarse,
    formFactor: width >= 720 ? 'desktop' : 'phone'
  })
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function mountPage(t: Tab = tab(), s: UIState = state()): Promise<HTMLElement> {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(BookmarkManager, { state: s, tab: t })))
  await flush()
  return mount
}

async function rerender(t: Tab, s: UIState = state()): Promise<void> {
  await act(async () => root!.render(createElement(BookmarkManager, { state: s, tab: t })))
  await flush()
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function rowIds(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-testid="bookmarks-list"] li[data-bm-id]')].map((r) =>
    r.getAttribute('data-bm-id')!
  )
}

function row(el: HTMLElement, id: string): HTMLElement {
  return el.querySelector<HTMLElement>(`li[data-bm-id="${id}"]`)!
}

function listbox(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('ul[role="listbox"]')!
}

function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
}

function click(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
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
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  viewport(1200)
  uiStore.set({ bookmarkEdit: null })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.useRealTimers()
})

describe('the bookmarks manager page tab (§10.1, §10.5)', () => {
  it('draws the title block with its actions, the search field and the two panes, no overlay chrome', async () => {
    const el = await mountPage()
    const page = el.querySelector('[data-testid="bookmarks-manager"]')!
    expect(page.classList.contains('zen-page')).toBe(true)
    expect(page.getAttribute('data-layout')).toBe('two-pane')
    expect(text(page.querySelector('h1.zen-page-title'))).toBe('Bookmarks')
    const actions = [...page.querySelectorAll('.zen-page-title-actions button')]
    expect(actions.map(text)).toEqual(['Add bookmark', 'Add folder', ''])
    expect(actions[0]!.classList.contains('zen-v2-button')).toBe(true)
    expect(actions[2]!.getAttribute('aria-label')).toBe('More options')
    const field = page.querySelector<HTMLInputElement>('[data-testid="bookmarks-search"]')!
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('placeholder')).toBe('Search bookmarks')
    // The header stays over both panes; the tree is the nav column, the list the content one.
    expect(page.querySelector('header.zen-page-header.zen-bm-header')).not.toBeNull()
    expect(page.querySelector('.zen-bm-panes > nav.zen-bm-nav [role="tree"]')).not.toBeNull()
    expect(page.querySelector('.zen-bm-panes > .zen-bm-list .zen-page-body')).not.toBeNull()
    expect(page.querySelector('[aria-label="Close"]')).toBeNull()
    expect(page.querySelector('.zen-overlay-shell')).toBeNull()
  })

  it('opens on the bookmarks bar: its rows as §9.21 two-line rows, the tree marking it, the breadcrumb naming it', async () => {
    const el = await mountPage()
    expect(el.querySelector('[data-testid="bookmarks-manager"]')!.getAttribute('data-folder')).toBe(
      BOOKMARKS_BAR_ID
    )
    expect(rowIds(el)).toEqual(['docs', 'zen', 'news'])
    const zen = row(el, 'zen')
    expect(zen.classList.contains('zen-v2-row')).toBe(true)
    expect(zen.getAttribute('role')).toBe('option')
    expect(text(zen.querySelector('.zen-page-row-label'))).toBe('Zen Browser')
    expect(text(zen.querySelector('.zen-page-row-desc'))).toBe('zen-browser.app')
    expect(zen.querySelector('time.zen-page-row-time')).not.toBeNull()
    expect(zen.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    expect(text(row(el, 'docs').querySelector('.zen-page-row-desc'))).toBe('2 items')
    // The heading line is the folder's path: the shown folder is the group's h2.
    const heading = el.querySelector('#zen-bm-list-heading')!
    expect(heading.tagName).toBe('H2')
    expect(text(heading)).toBe('Bookmarks bar')
    expect(text(el.querySelector('.zen-page-heading-aside'))).toBe('3 items')
    const current = el.querySelector('[role="treeitem"][aria-selected="true"]')!
    expect(text(current)).toBe('Bookmarks bar')
    expect(current.getAttribute('tabindex')).toBe('0')
  })

  it('a folder in the tree, a folder row or Right moves the URL to ?folder= with a history entry; the URL shows the folder', async () => {
    const el = await mountPage()
    const docs = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (r) => text(r) === 'Docs'
    )!
    await act(async () => click(docs))
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'bm',
      section: null,
      replace: false,
      query: { folder: 'docs' }
    })
    // The core answers with the tab's URL: the list is the folder's, the crumbs its path.
    await rerender(tab('zen://bookmarks?folder=docs'))
    expect(rowIds(el)).toEqual(['mdn', 'api'])
    const crumbs = [...el.querySelectorAll('.zen-bm-crumbs button.zen-bm-crumb')].map(text)
    expect(crumbs).toEqual(['Bookmarks bar'])
    expect(text(el.querySelector('#zen-bm-list-heading'))).toBe('Docs')
    // A folder row opens on double-click; the keyboard's Right does the same.
    await act(async () =>
      row(el, 'api').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    )
    expect(calls('page.navigate').at(-1)).toMatchObject({ query: { folder: 'api' } })
    await act(async () => click(row(el, 'api')))
    await act(async () => key(listbox(el), 'ArrowRight'))
    expect(calls('page.navigate').at(-1)).toMatchObject({ query: { folder: 'api' } })
    // Left goes up; the breadcrumb's step goes there too.
    await act(async () => key(listbox(el), 'ArrowLeft'))
    expect(calls('page.navigate').at(-1)).toMatchObject({ query: { folder: BOOKMARKS_BAR_ID } })
  })

  it('a URL naming no folder, or a folder that is gone, shows the bar', async () => {
    const el = await mountPage(tab('zen://bookmarks?folder=nope'))
    expect(rowIds(el)).toEqual(['docs', 'zen', 'news'])
    expect(calls('page.navigate')).toEqual([])
  })

  it('a typed search filters every folder, moves the URL to ?q= with replace and names the results', async () => {
    const el = await mountPage()
    const field = el.querySelector<HTMLInputElement>('[data-testid="bookmarks-search"]')!
    await type(field, 'doc')
    expect(calls('page.navigate')).toEqual([
      { tabId: 'bm', section: null, replace: true, query: { q: 'doc' } }
    ])
    expect(rowIds(el)).toEqual(expect.arrayContaining(['docs', 'mdn']))
    expect(rowIds(el)).not.toContain('zen')
    expect(text(el.querySelector('#zen-bm-list-heading'))).toBe('Results for “doc”')
    // A result shows where it lives; the tree marks no folder while searching.
    expect(text(row(el, 'mdn').querySelector('.zen-page-row-desc'))).toBe('Bookmarks bar / Docs')
    expect(el.querySelector('[role="treeitem"][aria-selected="true"]')).toBeNull()
    expect(el.querySelector('[data-testid="bookmarks-manager"]')!.hasAttribute('data-folder')).toBe(
      false
    )
    // Clearing goes back to the folder.
    await act(async () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click()
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await flush()
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'bm',
      section: null,
      replace: true,
      query: undefined
    })
    expect(rowIds(el)).toEqual(['docs', 'zen', 'news'])
  })

  it('a query the URL brings fills the field and searches; the folder rides along in the URL', async () => {
    const el = await mountPage(tab('zen://bookmarks?folder=docs&q=fetch'))
    const field = el.querySelector<HTMLInputElement>('[data-testid="bookmarks-search"]')!
    expect(field.value).toBe('fetch')
    expect(rowIds(el)).toEqual(['fetch'])
    expect(calls('page.navigate')).toEqual([])
    await type(field, '')
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'bm',
      section: null,
      replace: true,
      query: { folder: 'docs' }
    })
  })

  it('selects per §9.6: click, Shift ranges, Ctrl+A all, Space toggles, Escape clears; Delete removes the selection', async () => {
    const el = await mountPage()
    const selected = (): string[] =>
      rowIds(el).filter((id) => row(el, id).hasAttribute('data-selected'))
    await act(async () => click(row(el, 'docs')))
    expect(row(el, 'docs').getAttribute('aria-selected')).toBe('true')
    expect(row(el, 'docs').hasAttribute('data-selected')).toBe(true)
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-docs')
    await act(async () => click(row(el, 'news'), { shiftKey: true }))
    expect(selected()).toEqual(['docs', 'zen', 'news'])
    await act(async () => click(row(el, 'zen'), { shiftKey: true }))
    expect(selected()).toEqual(['docs', 'zen'])
    // Ctrl+arrow moves the focus alone and Space toggles the focused row: the way to a pick
    // that is not one run, now that Ctrl-click is not the selection's.
    await act(async () => click(row(el, 'news')))
    expect(selected()).toEqual(['news'])
    await act(async () => key(listbox(el), 'ArrowUp', { ctrlKey: true }))
    await act(async () => key(listbox(el), 'ArrowUp', { ctrlKey: true }))
    expect(selected()).toEqual(['news'])
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-docs')
    await act(async () => key(listbox(el), ' '))
    expect(selected()).toEqual(['docs', 'news'])
    await act(async () => key(listbox(el), ' '))
    expect(selected()).toEqual(['news'])
    await act(async () => key(listbox(el), 'Escape'))
    expect(el.querySelector('[data-selected]')).toBeNull()
    await act(async () => key(listbox(el), 'a', { ctrlKey: true }))
    expect(el.querySelectorAll('[data-selected]')).toHaveLength(3)
    await act(async () => key(listbox(el), 'Delete'))
    expect(calls('bookmark.remove')).toEqual([{ ids: ['docs', 'zen', 'news'] }])
  })

  it('Ctrl-click has one meaning on every page row (§10.1): a bookmark opens behind this tab and nothing is picked; a middle click is the same; a folder is selected', async () => {
    const el = await mountPage()
    const selected = (): string[] =>
      rowIds(el).filter((id) => row(el, id).hasAttribute('data-selected'))
    await act(async () => click(row(el, 'docs')))
    expect(selected()).toEqual(['docs'])
    await act(async () => click(row(el, 'news'), { ctrlKey: true }))
    expect(calls('bookmark.open')).toEqual([
      { id: 'news', newTab: true, tabId: 'bm', background: true }
    ])
    // The selection is as it was: not added to, not moved.
    expect(selected()).toEqual(['docs'])
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-docs')
    await act(async () => click(row(el, 'zen'), { metaKey: true }))
    expect(calls('bookmark.open').at(-1)).toEqual({
      id: 'zen',
      newTab: true,
      tabId: 'bm',
      background: true
    })
    expect(selected()).toEqual(['docs'])
    // A Ctrl-double-click's second click and the double-click itself open nothing more.
    await act(async () =>
      row(el, 'zen').dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 2 })
      )
    )
    await act(async () =>
      row(el, 'zen').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('bookmark.open')).toHaveLength(2)
    // A middle click is the same tab behind.
    await act(async () =>
      row(el, 'news').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    )
    expect(calls('bookmark.open').at(-1)).toEqual({
      id: 'news',
      newTab: true,
      tabId: 'bm',
      background: true
    })
    expect(calls('bookmark.open')).toHaveLength(3)
    // A folder cannot open behind: Ctrl-click selects it as a plain click does.
    await act(async () => click(row(el, 'zen')))
    await act(async () => click(row(el, 'docs'), { ctrlKey: true }))
    expect(selected()).toEqual(['docs'])
    expect(calls('bookmark.open')).toHaveLength(3)
    // A plain double click still opens in this tab.
    await act(async () =>
      row(el, 'zen').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    )
    expect(calls('bookmark.open').at(-1)).toEqual({ id: 'zen', newTab: false, tabId: 'bm' })
  })

  it('Enter opens the focused bookmark in the tab, Ctrl+Enter in a new one; the arrows walk the rows (§9.22)', async () => {
    const el = await mountPage()
    await act(async () => click(row(el, 'docs')))
    await act(async () => key(listbox(el), 'ArrowDown'))
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-zen')
    await act(async () => key(listbox(el), 'Enter'))
    expect(calls('bookmark.open').at(-1)).toEqual({ id: 'zen', newTab: false, tabId: 'bm' })
    await act(async () => key(listbox(el), 'Enter', { ctrlKey: true }))
    expect(calls('bookmark.open').at(-1)).toEqual({ id: 'zen', newTab: true, tabId: 'bm' })
    await act(async () => key(listbox(el), 'End'))
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-news')
    await act(async () => key(listbox(el), 'Home'))
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe('bm-row-docs')
  })

  it("the row's ⋮ and a right click open the core's menu for the row; empty space asks for the folder's", async () => {
    const el = await mountPage()
    const more = row(el, 'zen').querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Zen Browser"]'
    )!
    await act(async () => more.click())
    expect(calls('bookmark.contextMenu').at(-1)).toMatchObject({
      ids: ['zen'],
      folderId: BOOKMARKS_BAR_ID
    })
    await act(async () =>
      row(el, 'news').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 })
      )
    )
    expect(calls('bookmark.contextMenu').at(-1)).toMatchObject({
      ids: ['news'],
      folderId: BOOKMARKS_BAR_ID
    })
    await act(async () =>
      listbox(el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    )
    expect(calls('bookmark.contextMenu').at(-1)).toMatchObject({
      ids: [],
      folderId: BOOKMARKS_BAR_ID
    })
  })

  it('F2 renames a folder in place (§9.12) and commits through bookmark.update; a bookmark goes to the Edit dialog', async () => {
    const el = await mountPage()
    await act(async () => click(row(el, 'docs')))
    await act(async () => key(listbox(el), 'F2'))
    const field = row(el, 'docs').querySelector<HTMLInputElement>('input.zen-bm-rename')!
    expect(field).not.toBeNull()
    expect(field.value).toBe('Docs')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'Documentation')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      key(field, 'Enter')
    })
    expect(calls('bookmark.update')).toEqual([{ id: 'docs', title: 'Documentation' }])
    expect(row(el, 'docs').querySelector('input.zen-bm-rename')).toBeNull()
    await act(async () => click(row(el, 'zen')))
    await act(async () => key(listbox(el), 'F2'))
    await flush()
    expect(uiStore.get().bookmarkEdit).toEqual({
      id: 'zen',
      parentId: BOOKMARKS_BAR_ID,
      type: 'url'
    })
  })

  it("the menus' folder rename and Add New Folder are done in place when the folder is in view", async () => {
    const el = await mountPage()
    await act(async () => {
      uiStore.set({ bookmarkEdit: { id: 'docs', parentId: BOOKMARKS_BAR_ID, type: 'folder' } })
    })
    await flush()
    // Taken by the page: no dialog is left asking.
    expect(uiStore.get().bookmarkEdit).toBeNull()
    expect(row(el, 'docs').querySelector('input.zen-bm-rename')).not.toBeNull()
    // A folder the list does not show is the dialog's.
    await act(async () => {
      uiStore.set({ bookmarkEdit: { id: 'api', parentId: 'docs', type: 'folder' } })
    })
    await flush()
    expect(uiStore.get().bookmarkEdit).toEqual({ id: 'api', parentId: 'docs', type: 'folder' })
  })

  it('Add folder creates one in the shown folder and names it in place; Add bookmark asks the Edit dialog', async () => {
    const el = await mountPage()
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.zen-page-title-actions > button')]
    await act(async () => buttons.find((b) => text(b) === 'Add folder')!.click())
    await flush()
    expect(calls('bookmark.create')).toEqual([
      { parentId: BOOKMARKS_BAR_ID, title: 'New folder', type: 'folder' }
    ])
    await act(async () => buttons.find((b) => text(b) === 'Add bookmark')!.click())
    await flush()
    expect(uiStore.get().bookmarkEdit).toEqual({
      id: null,
      parentId: BOOKMARKS_BAR_ID,
      type: 'url'
    })
  })

  it("the page's ⋮ holds the sort order, import and export", async () => {
    const el = await mountPage()
    const more = el.querySelector<HTMLButtonElement>('button[aria-label="More options"]')!
    await act(async () => more.click())
    const items = [...el.querySelectorAll('[role="menu"] [role^="menuitem"]')].map(text)
    expect(items).toEqual([
      'Manual Order',
      'Name',
      'URL',
      'Date Added',
      'Import Bookmarks…',
      'Export Bookmarks…'
    ])
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>('[role="menu"] [role^="menuitem"]')]
        .find((b) => text(b) === 'Name')!
        .click()
    )
    expect(rowIds(el)).toEqual(['docs', 'news', 'zen'])
    await act(async () => more.click())
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>('[role="menu"] [role^="menuitem"]')]
        .find((b) => text(b) === 'Export Bookmarks…')!
        .click()
    )
    expect(calls('bookmark.export')).toHaveLength(1)
  })

  it('says so when a folder is empty and when nothing matches (§9.17)', async () => {
    const el = await mountPage(tab('zen://bookmarks?folder=3'))
    const empty = el.querySelector('[data-testid="bookmarks-empty"]')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(text(empty)).toBe('This folder is empty')
    await rerender(tab('zen://bookmarks?q=zzz'))
    expect(text(el.querySelector('[data-testid="bookmarks-empty"]'))).toBe('No matching bookmarks')
  })

  it('narrower than two panes the tree column goes and the breadcrumb is the way up (§10.2)', async () => {
    viewport(600)
    const el = await mountPage(tab('zen://bookmarks?folder=docs'))
    const page = el.querySelector('[data-testid="bookmarks-manager"]')!
    expect(page.getAttribute('data-layout')).toBe('one-pane')
    expect(page.querySelector('nav.zen-bm-nav')).toBeNull()
    const up = el.querySelector<HTMLButtonElement>('.zen-bm-crumbs button.zen-bm-crumb')!
    expect(text(up)).toBe('Bookmarks bar')
    await act(async () => up.click())
    expect(calls('page.navigate').at(-1)).toMatchObject({
      replace: false,
      query: { folder: BOOKMARKS_BAR_ID }
    })
  })
})

// ---------------------------------------------------------------------------
// Drag and drop: a drag held over a closed tree folder opens it (bookmarks-26)
// ---------------------------------------------------------------------------

function treeRow(el: HTMLElement, title: string): HTMLElement {
  return [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => text(r) === title)!
}

/** A mouse pointer event at `(x, y)`; the drag's events go to the window as the hook listens there. */
function pointer(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: x,
      clientY: y
    })
  )
}

/** Fold a tree folder's branch through its twisty (the tree opens every branch by default). */
async function collapse(el: HTMLElement, title: string): Promise<HTMLElement> {
  const item = treeRow(el, title)
  await act(async () => click(item.querySelector('.zen-bm-tree-twisty')!))
  expect(item.getAttribute('aria-expanded')).toBe('false')
  return item
}

async function hold(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('a drag held over a closed tree folder opens it (bookmarks-26, Chrome’s manager)', () => {
  /** What the pointer is over: the hook asks the document, and the tests answer for it. */
  let under: Element | null = null
  beforeEach(() => {
    under = null
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => under)
  })
  // A drag a failing test left in the hand would answer the next test's pointer: let it go.
  afterEach(() => {
    act(() => pointer(window, 'pointercancel', 0, 0))
  })

  /** Pick up a list row with the mouse and carry it over `over`. */
  async function dragOver(el: HTMLElement, id: string, over: Element): Promise<void> {
    await act(async () => pointer(row(el, id), 'pointerdown', 400, 300))
    under = over
    await act(async () => pointer(window, 'pointermove', 400, 320))
  }

  // The fake clock also runs with the wall clock (`shouldAdvanceTime`), so "before the hold is
  // up" is checked well short of it, never a millisecond short.
  const SHORT = HOLD_TO_OPEN_MS / 2

  it('opens the branch after the bar’s hold – one constant for both surfaces – with the drop-into mark on the row, and the ghost in the hand', async () => {
    const el = await mountPage()
    const docs = await collapse(el, 'Docs')
    // While it folds the row says so; the API folder is out of the tree.
    expect(docs.hasAttribute('data-bm-hold')).toBe(true)
    expect(treeRow(el, 'API')).toBeUndefined()
    await dragOver(el, 'zen', docs)
    expect(document.querySelector('.zen-bm-drag-ghost')).not.toBeNull()
    expect(docs.hasAttribute('data-target')).toBe(true)
    // Not before the hold is up.
    await hold(SHORT)
    expect(docs.getAttribute('aria-expanded')).toBe('false')
    await hold(HOLD_TO_OPEN_MS - SHORT)
    expect(docs.getAttribute('aria-expanded')).toBe('true')
    expect(docs.hasAttribute('data-bm-hold')).toBe(false)
    expect(treeRow(el, 'API')).toBeDefined()
    // The drop mark stayed the row's own (§9.4); nothing moved yet.
    expect(docs.hasAttribute('data-target')).toBe(true)
    expect(calls('bookmark.move')).toEqual([])
    expect(HOLD_TO_OPEN_MS).toBe(500)
    await act(async () => pointer(window, 'pointerup', 400, 320))
  })

  it('the hold is the row’s: the pointer’s jitter within it does not restart the timer, leaving it does', async () => {
    // Shown: Other bookmarks, so the bar's branch (Docs inside it) may fold.
    const el = await mountPage(tab(`zen://bookmarks?folder=${OTHER_BOOKMARKS_ID}`))
    const bar = await collapse(el, 'Bookmarks bar')
    expect(treeRow(el, 'Docs')).toBeUndefined()
    await dragOver(el, 'other', bar)
    await hold(SHORT)
    // Still over the row, a few pixels on: the same target, the same timer – it is up at the
    // hold from the arrival, not from the last move.
    await act(async () => pointer(window, 'pointermove', 404, 324))
    await hold(HOLD_TO_OPEN_MS - SHORT)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    // Docs, closed: the drag leaves it before the hold is up, and it stays closed.
    const docs = await collapse(el, 'Docs')
    under = docs
    await act(async () => pointer(window, 'pointermove', 400, 140))
    await hold(SHORT)
    under = el.querySelector('.zen-bm-list')!
    await act(async () => pointer(window, 'pointermove', 400, 500))
    await hold(HOLD_TO_OPEN_MS * 2)
    expect(docs.getAttribute('aria-expanded')).toBe('false')
    // Back on it, the hold starts over.
    under = docs
    await act(async () => pointer(window, 'pointermove', 400, 140))
    await hold(SHORT)
    expect(docs.getAttribute('aria-expanded')).toBe('false')
    await hold(HOLD_TO_OPEN_MS - SHORT)
    expect(docs.getAttribute('aria-expanded')).toBe('true')
    await act(async () => pointer(window, 'pointerup', 400, 140))
  })

  it('a folder opened by the hold stays open after the drop and after a let-go (Chrome leaves them open)', async () => {
    const el = await mountPage()
    const docs = await collapse(el, 'Docs')
    await dragOver(el, 'zen', docs)
    await hold(HOLD_TO_OPEN_MS)
    expect(docs.getAttribute('aria-expanded')).toBe('true')
    await act(async () => pointer(window, 'pointerup', 400, 320))
    expect(calls('bookmark.move').at(-1)).toEqual({
      ids: ['zen'],
      parentId: 'docs',
      index: undefined
    })
    await hold(1000)
    expect(docs.getAttribute('aria-expanded')).toBe('true')
    expect(treeRow(el, 'API')).toBeDefined()
    // Escape half-way through a second drag: the branch opened by the hold stays open too.
    await rerender(tab(`zen://bookmarks?folder=${OTHER_BOOKMARKS_ID}`))
    const bar = await collapse(el, 'Bookmarks bar')
    await dragOver(el, 'other', bar)
    await hold(HOLD_TO_OPEN_MS)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await hold(1000)
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    expect(calls('bookmark.move')).toHaveLength(1)
  })

  it('an open branch, the list’s empty space and a list folder row’s middle band ask nothing of the tree', async () => {
    const el = await mountPage()
    const docs = await collapse(el, 'Docs')
    // The list's folder row drops into Docs (its middle band) but the list does not nest: the
    // tree's branch is not the hold's to open from here.
    const docsRow = row(el, 'docs')
    vi.spyOn(docsRow, 'getBoundingClientRect').mockReturnValue({
      top: 300,
      bottom: 340,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 300,
      toJSON: () => ({})
    } as DOMRect)
    await dragOver(el, 'zen', docsRow)
    await hold(HOLD_TO_OPEN_MS * 2)
    expect(docs.getAttribute('aria-expanded')).toBe('false')
    // The list's empty space: nothing to open.
    under = el.querySelector('.zen-bm-list')!
    await act(async () => pointer(window, 'pointermove', 400, 600))
    await hold(HOLD_TO_OPEN_MS * 2)
    expect(docs.getAttribute('aria-expanded')).toBe('false')
    // An open branch carries no hold mark.
    expect(treeRow(el, 'Other bookmarks').hasAttribute('data-bm-hold')).toBe(false)
    await act(async () => pointer(window, 'pointerup', 400, 600))
  })
})
