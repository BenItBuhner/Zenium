// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type KeyboardEvent, type FocusEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import { run } from '../api'
import {
  stripEntries,
  stripFocusIn,
  stripFocusOut,
  stripIntent,
  stripItemKind,
  stripKeyDown,
  useStripTabIndex,
  type StripItem
} from '../tabStrip'
import { uiStore } from '../ui'

/*
 * The tab strip's keyboard (lib/tabStrip.ts; a11y-07): one tab stop (roving tabindex), Up/Down
 * walk tiles, headers and rows in drawn order and wrap, Home/End jump, Enter/Space activate or
 * fold, Delete closes and moves to the neighbour, Left/Right fold a header or step along tiles,
 * Escape returns the keyboard to the page.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (key: string, parent: string | null = null, expanded?: boolean): StripItem => ({
  key,
  parent,
  ...(expanded === undefined ? {} : { expanded })
})

// Essentials (two lines of two), the pinned header with two rows, a folder with two rows, a
// loose row.
const STRIP: StripItem[] = [
  item('tile:e1'),
  item('tile:e2'),
  item('tile:e3'),
  item('header:s1', null, true),
  item('tab:p1', 'header:s1'),
  item('tab:p2', 'header:s1'),
  item('folder:f1', null, true),
  item('tab:f1a', 'folder:f1'),
  item('tab:f1b', 'folder:f1'),
  item('tab:r1')
]
const at = (key: string): number => STRIP.findIndex((it) => it.key === key)

describe('stripItemKind', () => {
  it('reads the kind off the key prefix, rows by default', () => {
    expect(stripItemKind('tile:x')).toBe('tile')
    expect(stripItemKind('header:x')).toBe('header')
    expect(stripItemKind('folder:x')).toBe('folder')
    expect(stripItemKind('tab:x')).toBe('tab')
    expect(stripItemKind('saved:g:0')).toBe('saved')
  })
})

// A saved folder (TAB-16's desktop half): its header with the pages it kept as rows under it,
// then a loose row.
const SAVED_STRIP: StripItem[] = [
  item('folder:g', null, true),
  item('saved:g:0', 'folder:g'),
  item('saved:g:1', 'folder:g'),
  item('tab:r1')
]
const savedAt = (key: string): number => SAVED_STRIP.findIndex((it) => it.key === key)

describe("stripIntent: a saved folder's page rows", () => {
  it('walk like rows: Down and Up along them, Left up to the header, Right and Left into and out of the fold', () => {
    expect(stripIntent(SAVED_STRIP, savedAt('folder:g'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: savedAt('saved:g:0')
    })
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:0'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: savedAt('saved:g:1')
    })
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:1'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: savedAt('tab:r1')
    })
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:1'), 'ArrowLeft')).toEqual({
      type: 'focus',
      index: savedAt('folder:g')
    })
    expect(stripIntent(SAVED_STRIP, savedAt('folder:g'), 'ArrowRight')).toEqual({
      type: 'focus',
      index: savedAt('saved:g:0')
    })
    expect(stripIntent(SAVED_STRIP, savedAt('folder:g'), 'ArrowLeft')).toEqual({
      type: 'fold',
      expanded: false
    })
  })

  it('Enter and Space activate a page row – it opens the folder – and Delete closes nothing there', () => {
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:0'), 'Enter')).toEqual({ type: 'activate' })
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:1'), ' ')).toEqual({ type: 'activate' })
    expect(stripIntent(SAVED_STRIP, savedAt('saved:g:0'), 'Delete')).toBeNull()
    expect(stripIntent(SAVED_STRIP, savedAt('folder:g'), 'Delete')).toBeNull()
  })
})

describe('stripIntent: Up and Down', () => {
  it('walk the rows in drawn order across headers and folders', () => {
    expect(stripIntent(STRIP, at('tab:p1'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: at('tab:p2')
    })
    expect(stripIntent(STRIP, at('tab:p2'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: at('folder:f1')
    })
    expect(stripIntent(STRIP, at('folder:f1'), 'ArrowDown')).toEqual({
      type: 'focus',
      index: at('tab:f1a')
    })
    expect(stripIntent(STRIP, at('tab:f1a'), 'ArrowUp')).toEqual({
      type: 'focus',
      index: at('folder:f1')
    })
    expect(stripIntent(STRIP, at('header:s1'), 'ArrowUp')).toEqual({
      type: 'focus',
      index: at('tile:e3')
    })
  })

  it('wrap at the ends', () => {
    expect(stripIntent(STRIP, at('tab:r1'), 'ArrowDown')).toEqual({ type: 'focus', index: 0 })
    expect(stripIntent(STRIP, 0, 'ArrowUp')).toEqual({ type: 'focus', index: at('tab:r1') })
  })

  it('step a line of tiles at a time in the Essentials grid, then leave it for the first row', () => {
    // Two tiles per line: e1 e2 / e3.
    expect(stripIntent(STRIP, at('tile:e1'), 'ArrowDown', 2)).toEqual({
      type: 'focus',
      index: at('tile:e3')
    })
    expect(stripIntent(STRIP, at('tile:e2'), 'ArrowDown', 2)).toEqual({
      type: 'focus',
      index: at('header:s1')
    })
    expect(stripIntent(STRIP, at('tile:e3'), 'ArrowUp', 2)).toEqual({
      type: 'focus',
      index: at('tile:e1')
    })
    // One tile per line (the compact sidebar): the tiles are a column.
    expect(stripIntent(STRIP, at('tile:e1'), 'ArrowDown', 1)).toEqual({
      type: 'focus',
      index: at('tile:e2')
    })
  })

  it("Home and End jump to the strip's ends", () => {
    expect(stripIntent(STRIP, at('tab:f1a'), 'Home')).toEqual({ type: 'focus', index: 0 })
    expect(stripIntent(STRIP, at('tab:f1a'), 'End')).toEqual({ type: 'focus', index: at('tab:r1') })
  })
})

describe('stripIntent: Left and Right', () => {
  it("step along the tiles and stop at the grid's ends", () => {
    expect(stripIntent(STRIP, at('tile:e1'), 'ArrowRight')).toEqual({
      type: 'focus',
      index: at('tile:e2')
    })
    expect(stripIntent(STRIP, at('tile:e3'), 'ArrowRight')).toBeNull()
    expect(stripIntent(STRIP, at('tile:e2'), 'ArrowLeft')).toEqual({
      type: 'focus',
      index: at('tile:e1')
    })
    expect(stripIntent(STRIP, at('tile:e1'), 'ArrowLeft')).toBeNull()
  })

  it('fold and unfold a header, Right on an open header goes to its first row (the tree pattern)', () => {
    expect(stripIntent(STRIP, at('folder:f1'), 'ArrowLeft')).toEqual({
      type: 'fold',
      expanded: false
    })
    expect(stripIntent(STRIP, at('folder:f1'), 'ArrowRight')).toEqual({
      type: 'focus',
      index: at('tab:f1a')
    })
    const folded = STRIP.map((it) =>
      it.key === 'folder:f1' ? item(it.key, null, false) : it
    ).filter((it) => it.parent !== 'folder:f1')
    const f = folded.findIndex((it) => it.key === 'folder:f1')
    expect(stripIntent(folded, f, 'ArrowRight')).toEqual({ type: 'fold', expanded: true })
    expect(stripIntent(folded, f, 'ArrowLeft')).toBeNull()
    // The pinned header folds the same way.
    expect(stripIntent(STRIP, at('header:s1'), 'ArrowLeft')).toEqual({
      type: 'fold',
      expanded: false
    })
    expect(stripIntent(STRIP, at('header:s1'), 'ArrowRight')).toEqual({
      type: 'focus',
      index: at('tab:p1')
    })
  })

  it('Left on a row inside a folder or the pinned section goes up to its header; a loose row stays', () => {
    expect(stripIntent(STRIP, at('tab:f1b'), 'ArrowLeft')).toEqual({
      type: 'focus',
      index: at('folder:f1')
    })
    expect(stripIntent(STRIP, at('tab:p2'), 'ArrowLeft')).toEqual({
      type: 'focus',
      index: at('header:s1')
    })
    expect(stripIntent(STRIP, at('tab:r1'), 'ArrowLeft')).toBeNull()
    expect(stripIntent(STRIP, at('tab:r1'), 'ArrowRight')).toBeNull()
  })
})

describe('stripIntent: Enter, Space, Delete, Escape', () => {
  it('Enter and Space activate a row or a tile and fold a header', () => {
    expect(stripIntent(STRIP, at('tab:r1'), 'Enter')).toEqual({ type: 'activate' })
    expect(stripIntent(STRIP, at('tile:e1'), ' ')).toEqual({ type: 'activate' })
    expect(stripIntent(STRIP, at('folder:f1'), 'Enter')).toEqual({ type: 'fold', expanded: false })
    expect(stripIntent(STRIP, at('header:s1'), ' ')).toEqual({ type: 'fold', expanded: false })
  })

  it('Delete closes a row or a tile, never a header', () => {
    expect(stripIntent(STRIP, at('tab:r1'), 'Delete')).toEqual({ type: 'close' })
    expect(stripIntent(STRIP, at('tile:e1'), 'Delete')).toEqual({ type: 'close' })
    expect(stripIntent(STRIP, at('folder:f1'), 'Delete')).toBeNull()
    expect(stripIntent(STRIP, at('header:s1'), 'Delete')).toBeNull()
  })

  it("Escape leaves for the page; other keys are not the strip's", () => {
    expect(stripIntent(STRIP, at('tab:r1'), 'Escape')).toEqual({ type: 'leave' })
    expect(stripIntent(STRIP, at('tab:r1'), 'Tab')).toBeNull()
    expect(stripIntent(STRIP, at('tab:r1'), 'a')).toBeNull()
    expect(stripIntent(STRIP, 99, 'ArrowDown')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The document side, under happy-dom
// ---------------------------------------------------------------------------

/** happy-dom lays nothing out: every connected element is "on screen" for these tests. */
const onScreen = (): DOMRect[] => [new DOMRect(0, 0, 10, 10)]

const SIDEBAR = `
  <aside data-pane="tabs">
    <div data-zen-nav-row data-pane="toolbar"><button id="reload">Reload</button></div>
    <div role="tablist" aria-label="Essentials" style="display:grid">
      <div id="e1" role="tab" data-strip-item="tile:e1" tabindex="-1">E1</div>
      <div id="e2" role="tab" data-strip-item="tile:e2" tabindex="-1">E2</div>
    </div>
    <div aria-hidden="true" inert>
      <div data-tab-scroller data-active="false">
        <div role="tablist"><div id="other" role="tab" data-strip-item="tab:other" tabindex="-1">Other space</div></div>
      </div>
    </div>
    <div data-tab-scroller data-active="true">
      <div role="tablist" aria-orientation="vertical">
        <button id="h" data-strip-item="header:s1" aria-expanded="true" tabindex="-1">Space</button>
        <div id="p1" role="tab" data-strip-item="tab:p1" data-strip-parent="header:s1" tabindex="-1">Pinned</div>
        <div id="f" role="button" data-strip-item="folder:f1" aria-expanded="true" tabindex="-1">Folder</div>
        <div id="f1a" role="tab" data-strip-item="tab:f1a" data-strip-parent="folder:f1" tabindex="-1">In folder</div>
        <div id="r1" role="tab" data-strip-item="tab:r1" data-active="true" tabindex="0">Active<button tabindex="-1">Close</button></div>
        <div id="r2" role="tab" data-strip-item="tab:r2" tabindex="-1">Last</div>
      </div>
      <button id="newtab">New Tab</button>
    </div>
  </aside>
`

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

/** A React keyboard event as the strip's handlers see it, for `key` pressed on `el` itself. */
function keyEvent(
  el: HTMLElement,
  key: string,
  init: Partial<KeyboardEvent> = {}
): KeyboardEvent<HTMLElement> {
  return {
    key,
    target: el,
    currentTarget: el,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...init
  } as unknown as KeyboardEvent<HTMLElement>
}

function focusEvent(el: HTMLElement, relatedTarget: Element | null): FocusEvent<HTMLElement> {
  return { target: el, currentTarget: el, relatedTarget } as unknown as FocusEvent<HTMLElement>
}

beforeEach(() => {
  Element.prototype.getClientRects = onScreen as unknown as typeof Element.prototype.getClientRects
  document.body.innerHTML = SIDEBAR
})

afterEach(() => {
  document.body.innerHTML = ''
  uiStore.set({ stripFocus: null, selectedTabIds: [] })
  vi.mocked(run).mockClear()
  vi.restoreAllMocks()
})

describe('stripEntries', () => {
  it("lists the items on screen in drawn order, skipping the other spaces' inert panels", () => {
    const root = document.querySelector<HTMLElement>('[data-pane="tabs"]') as HTMLElement
    expect(stripEntries(root).map((e) => e.item.key)).toEqual([
      'tile:e1',
      'tile:e2',
      'header:s1',
      'tab:p1',
      'folder:f1',
      'tab:f1a',
      'tab:r1',
      'tab:r2'
    ])
    const header = stripEntries(root).find((e) => e.item.key === 'header:s1')
    expect(header?.item.expanded).toBe(true)
    const row = stripEntries(root).find((e) => e.item.key === 'tab:f1a')
    expect(row?.item.parent).toBe('folder:f1')
    expect(row?.item.expanded).toBeUndefined()
  })
})

describe('stripKeyDown', () => {
  it('moves the keyboard down the strip and takes the key', () => {
    byId('r1').focus()
    const e = keyEvent(byId('r1'), 'ArrowDown')
    expect(stripKeyDown(e)).toBe(true)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('r2')
    expect(stripKeyDown(keyEvent(byId('r2'), 'ArrowDown'))).toBe(true)
    expect(document.activeElement?.id).toBe('e1')
    expect(stripKeyDown(keyEvent(byId('e1'), 'ArrowUp'))).toBe(true)
    expect(document.activeElement?.id).toBe('r2')
  })

  it('leaves keys pressed on a control inside the row, and chords, alone', () => {
    const close = byId('r1').querySelector('button') as HTMLElement
    const inner = keyEvent(byId('r1'), 'Enter', { target: close } as Partial<KeyboardEvent>)
    expect(stripKeyDown(inner)).toBe(false)
    expect(stripKeyDown(keyEvent(byId('r1'), 'ArrowDown', { ctrlKey: true }))).toBe(false)
    expect(stripKeyDown(keyEvent(byId('r1'), 'Tab'))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('Enter activates the row and keeps the keyboard on the strip', () => {
    expect(stripKeyDown(keyEvent(byId('r2'), 'Enter'))).toBe(true)
    expect(run).toHaveBeenCalledWith('tab.activate', { tabId: 'r2', keepFocus: true })
  })

  it('Delete closes the row after moving the keyboard to its neighbour', () => {
    byId('r1').focus()
    expect(stripKeyDown(keyEvent(byId('r1'), 'Delete'))).toBe(true)
    expect(document.activeElement?.id).toBe('r2')
    expect(run).toHaveBeenCalledWith('tab.close', { tabId: 'r1', keepFocus: true })
    // The last row hands the keyboard to the one before it.
    byId('r2').focus()
    stripKeyDown(keyEvent(byId('r2'), 'Delete'))
    expect(document.activeElement?.id).toBe('r1')
  })

  it('Left and Right fold the pinned header and a folder through the core', () => {
    expect(stripKeyDown(keyEvent(byId('h'), 'ArrowLeft'))).toBe(true)
    expect(run).toHaveBeenCalledWith('space.togglePinnedCollapsed', { spaceId: 's1' })
    expect(stripKeyDown(keyEvent(byId('f'), 'ArrowLeft'))).toBe(true)
    expect(run).toHaveBeenCalledWith('folder.update', {
      folderId: 'f1',
      patch: { collapsed: true }
    })
    byId('f').setAttribute('aria-expanded', 'false')
    expect(stripKeyDown(keyEvent(byId('f'), 'ArrowRight'))).toBe(true)
    expect(run).toHaveBeenLastCalledWith('folder.update', {
      folderId: 'f1',
      patch: { collapsed: false }
    })
    // Open: Right goes into the folder, Left from inside comes back to it.
    byId('f').setAttribute('aria-expanded', 'true')
    stripKeyDown(keyEvent(byId('f'), 'ArrowRight'))
    expect(document.activeElement?.id).toBe('f1a')
    stripKeyDown(keyEvent(byId('f1a'), 'ArrowLeft'))
    expect(document.activeElement?.id).toBe('f')
  })

  it('Escape gives the keyboard back to the page, unless a multi-selection is waiting for it', () => {
    byId('r1').focus()
    uiStore.set({ selectedTabIds: ['r1', 'r2'] })
    expect(stripKeyDown(keyEvent(byId('r1'), 'Escape'))).toBe(false)
    uiStore.set({ selectedTabIds: [] })
    expect(stripKeyDown(keyEvent(byId('r1'), 'Escape'))).toBe(true)
    expect(document.activeElement).toBe(document.body)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it("Enter and Space on a saved folder's page row open the folder; Delete closes nothing and moves nowhere", () => {
    document.body.innerHTML = `
      <aside data-pane="tabs">
        <div data-tab-scroller data-active="true">
          <div role="tablist" aria-orientation="vertical">
            <div id="g" role="button" data-strip-item="folder:g" aria-expanded="true" tabindex="-1">Trip</div>
            <div id="s0" role="button" data-strip-item="saved:g:0" data-strip-parent="folder:g" tabindex="-1">Page one</div>
            <div id="s1" role="button" data-strip-item="saved:g:1" data-strip-parent="folder:g" tabindex="-1">Page two</div>
            <div id="r1" role="tab" data-strip-item="tab:r1" data-active="true" tabindex="0">Active</div>
          </div>
        </div>
      </aside>`
    byId('s0').focus()
    expect(stripKeyDown(keyEvent(byId('s0'), 'Enter'))).toBe(true)
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(stripKeyDown(keyEvent(byId('s1'), ' '))).toBe(true)
    expect(run).toHaveBeenLastCalledWith('folder.open', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('tab.activate', expect.anything())
    vi.mocked(run).mockClear()
    expect(stripKeyDown(keyEvent(byId('s0'), 'Delete'))).toBe(false)
    expect(document.activeElement?.id).toBe('s0')
    expect(run).not.toHaveBeenCalled()
    // The arrows: Down along the pages to the loose row, Left from a page up to the header.
    expect(stripKeyDown(keyEvent(byId('s0'), 'ArrowDown'))).toBe(true)
    expect(document.activeElement?.id).toBe('s1')
    expect(stripKeyDown(keyEvent(byId('s1'), 'ArrowDown'))).toBe(true)
    expect(document.activeElement?.id).toBe('r1')
    byId('s1').focus()
    expect(stripKeyDown(keyEvent(byId('s1'), 'ArrowLeft'))).toBe(true)
    expect(document.activeElement?.id).toBe('g')
  })
})

describe('the roving tab stop', () => {
  it('follows the item the keyboard is on and returns to the active row when the keyboard leaves', () => {
    stripFocusIn(focusEvent(byId('p1'), null))
    expect(uiStore.get().stripFocus).toBe('tab:p1')
    // Moving to another item keeps the strip's stop inside it.
    stripFocusOut(focusEvent(byId('p1'), byId('f1a')))
    stripFocusIn(focusEvent(byId('f1a'), byId('p1')))
    expect(uiStore.get().stripFocus).toBe('tab:f1a')
    // Into the row's own button: still the strip.
    stripFocusOut(focusEvent(byId('r1'), byId('r1').querySelector('button')))
    expect(uiStore.get().stripFocus).toBe('tab:f1a')
    // Out to the New Tab button, or to nowhere (the page took the keyboard): the stop resets.
    stripFocusOut(focusEvent(byId('f1a'), byId('newtab')))
    expect(uiStore.get().stripFocus).toBeNull()
    stripFocusIn(focusEvent(byId('p1'), null))
    stripFocusOut(focusEvent(byId('p1'), null))
    expect(uiStore.get().stripFocus).toBeNull()
  })

  it('ignores focus events bubbling from inside the item', () => {
    const close = byId('r1').querySelector('button') as HTMLElement
    stripFocusIn({
      target: close,
      currentTarget: byId('r1'),
      relatedTarget: null
    } as unknown as FocusEvent<HTMLElement>)
    expect(uiStore.get().stripFocus).toBeNull()
  })
})

describe('useStripTabIndex', () => {
  let mount: HTMLDivElement
  let root: Root
  const render = (ui: ReactElementLike): void => act(() => root.render(ui))
  type ReactElementLike = JSX.Element

  function Row({ id, active }: { id: string; active: boolean }): JSX.Element {
    const tabIndex = useStripTabIndex(`tab:${id}`, active)
    return <div data-testid={id} data-strip-item={`tab:${id}`} tabIndex={tabIndex} />
  }
  const tabIndexOf = (id: string): string | null =>
    mount.querySelector(`[data-testid="${id}"]`)?.getAttribute('tabindex') ?? null

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  })
  afterEach(() => {
    act(() => root.unmount())
    mount.remove()
  })

  it('puts the one tab stop on the active row until the keyboard is on another item', () => {
    render(
      <>
        <Row id="a" active={false} />
        <Row id="b" active />
      </>
    )
    expect(tabIndexOf('a')).toBe('-1')
    expect(tabIndexOf('b')).toBe('0')
    act(() => uiStore.set({ stripFocus: 'tab:a' }))
    expect(tabIndexOf('a')).toBe('0')
    expect(tabIndexOf('b')).toBe('-1')
    act(() => uiStore.set({ stripFocus: null }))
    expect(tabIndexOf('b')).toBe('0')
  })

  it('hands the stop back to the active row when the item holding it leaves the document', () => {
    render(
      <>
        <Row id="a" active={false} />
        <Row id="b" active />
      </>
    )
    act(() => uiStore.set({ stripFocus: 'tab:a' }))
    render(<Row id="b" active />)
    expect(uiStore.get().stripFocus).toBeNull()
    expect(tabIndexOf('b')).toBe('0')
  })
})
