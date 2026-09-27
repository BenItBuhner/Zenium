import { describe, expect, it, vi } from 'vitest'
import type { SelectionMenuState } from '../../shared/types'
import { SELECTION_MINI_MENU_ORDER } from '../menus'
import { parseSelectionReport, SELECTION_MENU_MAX_CHARS } from '../selectionMenu'
import {
  ANDROID,
  DESKTOP,
  pageHarness,
  type HarnessOptions,
  type PageHarness
} from './menusFixture'

/*
 * The mini menu's model (CT-39, `core/selectionMenu`): the page's settled selection becomes
 * `UIState.selectionMenu` – its text, its box and the chips the page menu's own selection
 * actions give it – for the tab on screen in its window, and goes with the selection, the
 * document, the tab, the window's keyboard or the chip that ran.
 */

const RECT = { x: 100, y: 200, width: 120, height: 18 }

/** A desktop host with the translation engine and a speech engine: every chip can show. */
const FULL: HarnessOptions = { translate: true, speech: true }

function report(h: PageHarness, text: string, extra: Record<string, unknown> = {}): void {
  h.browser.handlePageMessage(h.tabId, {
    type: 'selection',
    selection: { text, rect: RECT, isEditable: false },
    frameId: 0,
    ...extra
  })
}

function model(h: PageHarness): SelectionMenuState | null {
  return h.browser.state.snapshot(h.win).selectionMenu
}

function chips(h: PageHarness): string[] {
  return model(h)?.actions.map((a) => a.id) ?? []
}

describe('parseSelectionReport', () => {
  it('takes a well-formed report, folding the text again, and refuses the rest', () => {
    expect(
      parseSelectionReport({ text: ' quantum \n foam ', rect: RECT, isEditable: true })
    ).toEqual({ text: 'quantum foam', rect: RECT, isEditable: true })
    expect(parseSelectionReport({ text: '', rect: null })).toEqual({
      text: '',
      rect: null,
      isEditable: false
    })
    expect(parseSelectionReport(null)).toBeNull()
    expect(parseSelectionReport('quantum foam')).toBeNull()
    expect(parseSelectionReport({ text: 12 })).toBeNull()
    expect(parseSelectionReport({ text: 'a'.repeat(SELECTION_MENU_MAX_CHARS + 1) })).toBeNull()
    expect(parseSelectionReport({ text: 'foam', rect: { x: 1, y: 2 } })).toBeNull()
    expect(parseSelectionReport({ text: 'foam', rect: { ...RECT, width: NaN } })).toBeNull()
    expect(parseSelectionReport({ text: 'foam', rect: { ...RECT, height: -1 } })).toBeNull()
    expect(parseSelectionReport({ text: 'foam', rect: 'box' })).toBeNull()
  })
})

describe('the selection menu model', () => {
  it('is null until the page reports a settled selection, then holds the text, the box and the chips in order', () => {
    const h = pageHarness({ ...DESKTOP, readAloud: true }, FULL)
    expect(model(h)).toBeNull()
    report(h, 'quantum foam')
    expect(model(h)).toEqual({
      tabId: h.tabId,
      text: 'quantum foam',
      rect: RECT,
      isEditable: false,
      actions: [
        { id: 'copy', title: 'Copy' },
        { id: 'search', title: 'Search Google' },
        { id: 'define', title: 'Define' },
        { id: 'translate', title: 'Translate' },
        { id: 'readAloud', title: 'Listen' }
      ]
    })
    expect(chips(h)).toEqual([...SELECTION_MINI_MENU_ORDER])
  })

  it('offers Define for one to three words alone, and Translate and Listen only with their engines', () => {
    const h = pageHarness({ ...DESKTOP, readAloud: true }, FULL)
    report(h, 'foam')
    expect(chips(h)).toContain('define')
    report(h, 'the quantum foam theory')
    expect(chips(h)).toEqual(['copy', 'search', 'translate', 'readAloud'])
    const bare = pageHarness()
    report(bare, 'quantum foam')
    expect(chips(bare)).toEqual(['copy', 'search', 'define'])
  })

  it('carries whether the selection is a text field\u2019s', () => {
    const h = pageHarness()
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'hello', rect: RECT, isEditable: true },
      frameId: 0
    })
    expect(model(h)?.isEditable).toBe(true)
  })

  it('clears on the empty report, and stays clear when nothing was shown', () => {
    const h = pageHarness()
    report(h, '')
    expect(model(h)).toBeNull()
    report(h, 'quantum foam')
    expect(model(h)).not.toBeNull()
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: '', rect: null, isEditable: false },
      frameId: 0
    })
    expect(model(h)).toBeNull()
  })

  it('drops a malformed report, a frame\u2019s report and one from a host without the capability', () => {
    const h = pageHarness()
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: 'quantum foam',
      frameId: 0
    })
    expect(model(h)).toBeNull()
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'quantum foam', rect: { x: 1 }, isEditable: false },
      frameId: 0
    })
    expect(model(h)).toBeNull()
    report(h, 'quantum foam', { frameId: 7 })
    expect(model(h)).toBeNull()
    // A frame's report leaves a standing model alone too: it is another document's selection.
    report(h, 'quantum foam')
    report(h, 'other words', { frameId: 7 })
    expect(model(h)?.text).toBe('quantum foam')
    // The phone's page script never posts one; a forged one costs the capability check alone.
    const phone = pageHarness(ANDROID, { formFactor: 'phone' })
    report(phone, 'quantum foam')
    expect(model(phone)).toBeNull()
    expect(phone.browser.selectionMenu.available).toBe(false)
  })

  it('shows nothing for a tab that is not on screen, and only in the window showing the tab', () => {
    const h = pageHarness()
    const background = h.browser.tabs.createTab(
      { url: 'https://example.com/b', active: false },
      h.win
    )
    h.browser.handlePageMessage(background.id, {
      type: 'selection',
      selection: { text: 'quantum foam', rect: RECT, isEditable: false },
      frameId: 0
    })
    expect(model(h)).toBeNull()
    report(h, 'quantum foam')
    expect(model(h)?.tabId).toBe(h.tabId)
    const other = h.browser.openWindow('unsynced', h.win)!
    expect(h.browser.state.snapshot(other).selectionMenu).toBeNull()
    expect(model(h)?.tabId).toBe(h.tabId)
  })

  it('goes when another tab comes in front, when the document changes, and when the tab closes', () => {
    const h = pageHarness()
    report(h, 'quantum foam')
    h.browser.tabs.createTab({ url: 'https://example.com/2', active: true }, h.win)
    expect(model(h)).toBeNull()
    h.browser.tabs.activateTab(h.tabId, h.win)
    report(h, 'quantum foam')
    h.browser.onNavigated(h.tabId, true)
    expect(model(h)?.text).toBe('quantum foam')
    h.browser.onNavigated(h.tabId)
    expect(model(h)).toBeNull()
    report(h, 'quantum foam')
    h.browser.tabs.closeTab(h.tabId, true, h.win)
    expect(h.browser.state.snapshot(h.win).selectionMenu).toBeNull()
  })

  it('goes when the window loses the keyboard, and on dismiss', () => {
    const h = pageHarness()
    report(h, 'quantum foam')
    h.win.onBlur()
    expect(model(h)).toBeNull()
    report(h, 'quantum foam')
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: h.tabId })
    expect(model(h)).toBeNull()
  })
})

describe('the selection menu\u2019s chips', () => {
  it('Copy asks the view for its copy of the selection and the menu goes', () => {
    const h = pageHarness()
    report(h, 'quantum foam')
    h.viewCalls.length = 0
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'copy' })
    ).toBe(true)
    expect(h.viewCalls).toEqual(['editCommand("copy")'])
    expect(model(h)).toBeNull()
  })

  it('Search opens the engine\u2019s results in front, with this tab as the opener', () => {
    const h = pageHarness()
    report(h, 'quantum foam')
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'search' })
    ).toBe(true)
    const active = h.browser.tabs.activeTabFor(h.win)!
    expect(active.id).not.toBe(h.tabId)
    expect(active.url).toContain('quantum')
    expect(active.url).toContain('foam')
    expect(active.openerTabId).toBe(h.tabId)
    expect(h.browser.state.snapshot(h.win).selectionMenu).toBeNull()
  })

  it('Define asks the chrome for the Define surface over the selection\u2019s box, and Translate for the translate popover', () => {
    const h = pageHarness(DESKTOP, FULL)
    const send = vi.spyOn(h.win, 'send')
    report(h, ' Quantum  foam ')
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'define' })
    ).toBe(true)
    expect(send).toHaveBeenCalledWith('define.show', {
      tabId: h.tabId,
      term: 'Quantum foam',
      rect: RECT
    })
    report(h, 'quantum foam')
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'translate' })
    ).toBe(true)
    expect(send.mock.calls.some(([name]) => name === 'translate.selection')).toBe(true)
  })

  it('runs on the text the page reported, not the caller\u2019s, and refuses a chip the model lacks or another tab', () => {
    const h = pageHarness()
    report(h, 'the quantum foam theory of everything')
    expect(chips(h)).not.toContain('define')
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'define' })
    ).toBe(false)
    expect(model(h)).not.toBeNull()
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: 'tab_gone', id: 'copy' })
    ).toBe(false)
    expect(model(h)).not.toBeNull()
    // Without a model nothing runs: a stale chrome cannot copy or search on the browser's behalf.
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: h.tabId })
    h.viewCalls.length = 0
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'copy' })
    ).toBe(false)
    expect(h.viewCalls).toEqual([])
  })
})
