// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import { run } from '../api'
import {
  PANE_ORDER,
  URLBAR_LEAVE_EVENT,
  currentPane,
  focusPane,
  nextPane,
  paneFirstControl,
  paneOf,
  paneTarget,
  releaseChromeFocus,
  shownPanes
} from '../panes'
import { uiStore } from '../ui'

/*
 * Keyboard panes (lib/panes.ts): F6 rotates tab strip → toolbar → bookmarks bar → side panel →
 * page and wraps; Shift+F6 goes the other way; panes not on screen are skipped; the keyboard
 * lands on the pane's natural target (the active tab row, the address, the roving chip).
 */

describe('nextPane: the F6 rotation', () => {
  const all = PANE_ORDER

  it('walks every pane in Chrome order and wraps from the page to the tab strip', () => {
    expect(nextPane('tabs', all, 'next')).toBe('toolbar')
    expect(nextPane('toolbar', all, 'next')).toBe('bookmarks')
    expect(nextPane('bookmarks', all, 'next')).toBe('sidepanel')
    expect(nextPane('sidepanel', all, 'next')).toBe('page')
    expect(nextPane('page', all, 'next')).toBe('tabs')
  })

  it('walks back with Shift+F6 and wraps from the tab strip to the page', () => {
    expect(nextPane('page', all, 'prev')).toBe('sidepanel')
    expect(nextPane('sidepanel', all, 'prev')).toBe('bookmarks')
    expect(nextPane('bookmarks', all, 'prev')).toBe('toolbar')
    expect(nextPane('toolbar', all, 'prev')).toBe('tabs')
    expect(nextPane('tabs', all, 'prev')).toBe('page')
  })

  it('skips panes that are not on screen', () => {
    const shown = ['tabs', 'toolbar'] as const
    expect(nextPane('toolbar', shown, 'next')).toBe('page')
    expect(nextPane('page', shown, 'prev')).toBe('toolbar')
    expect(nextPane('tabs', ['tabs'], 'next')).toBe('page')
    expect(nextPane('page', ['tabs'], 'next')).toBe('tabs')
  })

  it('treats a keyboard outside every pane as being in the page', () => {
    expect(nextPane(null, all, 'next')).toBe('tabs')
    expect(nextPane(null, all, 'prev')).toBe('sidepanel')
    expect(nextPane(null, ['toolbar'], 'prev')).toBe('toolbar')
  })

  it('treats a keyboard in a pane that has since gone as being in the page', () => {
    expect(nextPane('bookmarks', ['tabs', 'toolbar'], 'next')).toBe('tabs')
    expect(nextPane('bookmarks', ['tabs', 'toolbar'], 'prev')).toBe('toolbar')
  })

  it('stays on the page when only the page is shown', () => {
    expect(nextPane('page', [], 'next')).toBe('page')
    expect(nextPane(null, [], 'prev')).toBe('page')
  })
})

// ---------------------------------------------------------------------------
// The document side, under happy-dom
// ---------------------------------------------------------------------------

/** happy-dom lays nothing out: every connected element is "on screen" for these tests. */
const onScreen = (): DOMRect[] => [new DOMRect(0, 0, 10, 10)]

function mount(html: string): void {
  document.body.innerHTML = html
}

beforeEach(() => {
  // getClientRects is the visibility test; happy-dom's returns an empty list for everything.
  Element.prototype.getClientRects = onScreen as unknown as typeof Element.prototype.getClientRects
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  document.body.innerHTML = ''
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  vi.mocked(run).mockClear()
  vi.restoreAllMocks()
})

const CHROME = `
  <aside data-pane="tabs">
    <div data-zen-nav-row data-pane="toolbar">
      <button id="back" disabled>Back</button>
      <button id="forward" disabled>Forward</button>
      <button id="reload">Reload</button>
      <div role="group" aria-label="Address"><button id="address">example.org</button><button id="star">Star</button></div>
      <button id="menu">Menu</button>
    </div>
    <div data-tab-scroller data-active="false" aria-hidden="true">
      <div class="zen-tab" data-tab-id="other" data-active="true" tabindex="0">Other space</div>
    </div>
    <div data-tab-scroller data-active="true">
      <div class="zen-tab" data-tab-id="t1" data-active="false" tabindex="-1">One</div>
      <div class="zen-tab" data-tab-id="t2" data-active="true" tabindex="0">Two</div>
      <button id="newtab">New Tab</button>
    </div>
  </aside>
  <div role="toolbar" aria-label="Bookmarks bar" data-pane="bookmarks">
    <button id="chip1" tabindex="-1">Docs</button>
    <button id="chip2" tabindex="0">News</button>
  </div>
  <aside data-pane="sidepanel"><button id="close-panel">Close side panel</button></aside>
`

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

describe('the document side', () => {
  it('names the pane of an element from its nearest data-pane root', () => {
    mount(CHROME)
    expect(paneOf(byId('address'))).toBe('toolbar')
    expect(paneOf(byId('newtab'))).toBe('tabs')
    expect(paneOf(byId('chip1'))).toBe('bookmarks')
    expect(paneOf(byId('close-panel'))).toBe('sidepanel')
    expect(paneOf(document.body)).toBeNull()
    expect(paneOf(null)).toBeNull()
  })

  it('lists the panes on screen that have something to focus, the page always', () => {
    mount(CHROME)
    expect(shownPanes()).toEqual(['tabs', 'toolbar', 'bookmarks', 'sidepanel', 'page'])
    // A side panel strip with nothing left to focus is not a stop.
    byId('close-panel').remove()
    expect(shownPanes()).toEqual(['tabs', 'toolbar', 'bookmarks', 'page'])
  })

  it('lands on the active tab row of the active space, the address, the roving chip', () => {
    mount(CHROME)
    expect(paneTarget('tabs')?.dataset.tabId).toBe('t2')
    expect(paneTarget('toolbar')?.id).toBe('address')
    expect(paneTarget('bookmarks')?.id).toBe('chip2')
    expect(paneTarget('sidepanel')?.id).toBe('close-panel')
    expect(paneTarget('page')).toBeNull()
  })

  it('gives Shift+Alt+T the first enabled control of the toolbar, skipping disabled buttons', () => {
    mount(CHROME)
    expect(paneFirstControl('toolbar')?.id).toBe('reload')
    byId('back').removeAttribute('disabled')
    expect(paneFirstControl('toolbar')?.id).toBe('back')
  })

  it("reads the keyboard as in the page on the core's word, else from the focused element", () => {
    mount(CHROME)
    byId('address').focus()
    expect(currentPane()).toBe('toolbar')
    // The chrome document still reports itself focused, and keeps its activeElement, while a
    // sibling page view holds the keyboard: the key's source (the core's `from`) decides.
    expect(currentPane(document, 'page')).toBe('page')
    vi.mocked(document.hasFocus).mockReturnValue(false)
    expect(currentPane()).toBe('page')
    byId('address').blur()
    vi.mocked(document.hasFocus).mockReturnValue(true)
    expect(currentPane()).toBeNull()
  })

  it('F6 from the page takes the chrome and focuses the active tab row', () => {
    mount(CHROME)
    expect(focusPane({ move: 'next', from: 'page' })).toBe('tabs')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(document.activeElement?.getAttribute('data-tab-id')).toBe('t2')
  })

  it('F6 from the page ignores a stale focused chrome control', () => {
    mount(CHROME)
    // The user pressed Shift+Alt+T, then clicked into the page: the chrome document still says
    // the back button is focused. A key from the page starts from the page all the same.
    byId('reload').focus()
    expect(focusPane({ move: 'next', from: 'page' })).toBe('tabs')
    expect(focusPane({ move: 'prev', from: 'page' })).toBe('sidepanel')
  })

  it('F6 from the tab strip goes to the address, then the bookmarks bar, then the page', () => {
    mount(CHROME)
    paneTarget('tabs')?.focus()
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('toolbar')
    expect(document.activeElement?.id).toBe('address')
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('bookmarks')
    expect(document.activeElement?.id).toBe('chip2')
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('sidepanel')
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('page')
    expect(run).toHaveBeenLastCalledWith('focus.content', undefined)
    expect(document.activeElement).toBe(document.body)
  })

  it('F6 from chrome that is in no pane starts the rotation at the tab strip', () => {
    mount(CHROME)
    expect(document.activeElement).toBe(document.body)
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('tabs')
  })

  it('Shift+F6 from the page goes to the last chrome pane on screen', () => {
    mount(CHROME)
    expect(focusPane({ move: 'prev', from: 'page' })).toBe('sidepanel')
    expect(document.activeElement?.id).toBe('close-panel')
  })

  it('lets go of the focused chrome control when a page view takes the keyboard', () => {
    mount(CHROME)
    byId('reload').focus()
    expect(releaseChromeFocus()).toBe(true)
    expect(document.activeElement).toBe(document.body)
    expect(releaseChromeFocus()).toBe(false)
  })

  it('puts the open URL bar away when the keyboard leaves the toolbar, keeping the keyboard on the target', () => {
    mount(CHROME + '<div data-pane="toolbar" class="zen-omnibox"><input id="omnibox" /></div>')
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    byId('omnibox').focus()
    expect(currentPane()).toBe('toolbar')
    const leave = vi.fn()
    window.addEventListener(URLBAR_LEAVE_EVENT, leave)
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('bookmarks')
    window.removeEventListener(URLBAR_LEAVE_EVENT, leave)
    // The bar is told to close itself (draft kept, as on Escape); with no bar listening the store
    // is closed directly. Either way the page's focus is not asked for: the chip holds the keyboard.
    expect(leave).toHaveBeenCalledTimes(1)
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(document.activeElement?.id).toBe('chip2')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('Shift+F6 from the open URL bar to the page closes the bar and gives the page the keyboard', () => {
    mount(CHROME + '<div data-pane="toolbar" class="zen-omnibox"><input id="omnibox" /></div>')
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    byId('omnibox').focus()
    expect(focusPane({ move: 'prev', from: 'chrome' })).toBe('tabs')
    expect(uiStore.get().urlbar.open).toBe(false)
    mount(CHROME + '<div data-pane="toolbar" class="zen-omnibox"><input id="omnibox" /></div>')
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    byId('omnibox').focus()
    byId('close-panel').remove()
    document.querySelector('[data-pane="bookmarks"]')?.remove()
    expect(focusPane({ move: 'next', from: 'chrome' })).toBe('page')
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(run).toHaveBeenLastCalledWith('focus.content', undefined)
  })

  it('Shift+Alt+B focuses the bookmarks bar and does nothing while the bar is hidden', () => {
    mount(CHROME)
    expect(focusPane({ pane: 'bookmarks' })).toBe('bookmarks')
    expect(document.activeElement?.id).toBe('chip2')
    mount(CHROME.replace(/<div role="toolbar"[\s\S]*?<\/div>/, ''))
    byId('address').focus()
    expect(focusPane({ pane: 'bookmarks' })).toBeNull()
    expect(document.activeElement?.id).toBe('address')
  })

  it('Shift+Alt+T focuses the first enabled toolbar control', () => {
    mount(CHROME)
    expect(focusPane({ pane: 'toolbar' })).toBe('toolbar')
    expect(document.activeElement?.id).toBe('reload')
  })
})
