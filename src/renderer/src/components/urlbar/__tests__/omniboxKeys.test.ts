import { describe, expect, it } from 'vitest'
import {
  arrowStep,
  clickTarget,
  escapeIntent,
  pageStep,
  selectionAfterRemoval,
  submitTarget,
  tabStep
} from '../omniboxKeys'

/*
 * The omnibox's keyboard model (omnibox-50, -22, -24, -25) as pure decisions, against Chrome's
 * `OmniboxViewViews::HandleKeyEvent` and `OmniboxPopupSelection`: every fixture is a state the
 * bar can be in, never a date or a DOM.
 */

describe('escapeIntent: Chrome staged Escape', () => {
  it('leaves keyword mode first, whatever else is up', () => {
    expect(escapeIntent({ keywordMode: true, popupOpen: true, atRestText: false })).toBe(
      'exit-keyword'
    )
    expect(escapeIntent({ keywordMode: true, popupOpen: false, atRestText: true })).toBe(
      'exit-keyword'
    )
  })

  it('closes the popup and keeps the typed text, then reverts to the page, then closes the bar', () => {
    expect(escapeIntent({ keywordMode: false, popupOpen: true, atRestText: false })).toBe(
      'close-popup'
    )
    expect(escapeIntent({ keywordMode: false, popupOpen: false, atRestText: false })).toBe('revert')
    expect(escapeIntent({ keywordMode: false, popupOpen: false, atRestText: true })).toBe(
      'close-bar'
    )
  })

  it('over a field already at rest a popup still closes first (zero-suggest on focus)', () => {
    expect(escapeIntent({ keywordMode: false, popupOpen: true, atRestText: true })).toBe(
      'close-popup'
    )
  })
})

describe('arrowStep: Down and Up wrap through the rows and the typed text', () => {
  it('walks down from the typed text to the last row and wraps back to the text', () => {
    expect(arrowStep(-1, 3, 1)).toBe(0)
    expect(arrowStep(0, 3, 1)).toBe(1)
    expect(arrowStep(2, 3, 1)).toBe(-1)
  })

  it('walks up from the typed text to the last row', () => {
    expect(arrowStep(-1, 3, -1)).toBe(2)
    expect(arrowStep(0, 3, -1)).toBe(-1)
  })

  it('has nowhere to go with no rows', () => {
    expect(arrowStep(-1, 0, 1)).toBe(-1)
    expect(arrowStep(-1, 0, -1)).toBe(-1)
  })
})

describe('pageStep: PageDown and PageUp move a page and stop at the ends', () => {
  it('moves a page of rows down and clamps to the last row', () => {
    expect(pageStep(-1, 10, 1, 4)).toBe(3)
    expect(pageStep(3, 10, 1, 4)).toBe(7)
    expect(pageStep(7, 10, 1, 4)).toBe(9)
    expect(pageStep(9, 10, 1, 4)).toBe(9)
  })

  it('moves a page up and clamps to the typed text, never wrapping', () => {
    expect(pageStep(9, 10, -1, 4)).toBe(5)
    expect(pageStep(1, 10, -1, 4)).toBe(-1)
    expect(pageStep(-1, 10, -1, 4)).toBe(-1)
  })

  it('takes the whole list as the page when the list shows all its rows', () => {
    expect(pageStep(-1, 6, 1, 6)).toBe(5)
    expect(pageStep(5, 6, -1, 6)).toBe(-1)
  })

  it('never steps less than one row', () => {
    expect(pageStep(0, 5, 1, 0)).toBe(1)
  })
})

describe('tabStep: Tab walks a row into its actions, then on, then out to the toolbar', () => {
  // Three rows: the first and third removable (one action each), the second not.
  const actions = [1, 0, 1]

  it('from the typed text Tab goes to the first row, then into its X, then to the next row', () => {
    expect(tabStep(-1, -1, actions, 1)).toEqual({ kind: 'focus', selected: 0, action: -1 })
    expect(tabStep(0, -1, actions, 1)).toEqual({ kind: 'focus', selected: 0, action: 0 })
    expect(tabStep(0, 0, actions, 1)).toEqual({ kind: 'focus', selected: 1, action: -1 })
    // A row without actions is one stop.
    expect(tabStep(1, -1, actions, 1)).toEqual({ kind: 'focus', selected: 2, action: -1 })
  })

  it('past the last row\u2019s last action Tab leaves the popup for the toolbar', () => {
    expect(tabStep(2, 0, actions, 1)).toEqual({ kind: 'leave', dir: 1 })
    expect(tabStep(1, -1, [0, 0], 1)).toEqual({ kind: 'leave', dir: 1 })
  })

  it('Shift+Tab walks back: out of an action to its row, to the previous row\u2019s last action', () => {
    expect(tabStep(2, 0, actions, -1)).toEqual({ kind: 'focus', selected: 2, action: -1 })
    expect(tabStep(2, -1, actions, -1)).toEqual({ kind: 'focus', selected: 1, action: -1 })
    expect(tabStep(1, -1, actions, -1)).toEqual({ kind: 'focus', selected: 0, action: 0 })
    expect(tabStep(0, 0, actions, -1)).toEqual({ kind: 'focus', selected: 0, action: -1 })
    expect(tabStep(0, -1, actions, -1)).toEqual({ kind: 'focus', selected: -1, action: -1 })
  })

  it('Shift+Tab from the typed text leaves the bar backwards', () => {
    expect(tabStep(-1, -1, actions, -1)).toEqual({ kind: 'leave', dir: -1 })
  })

  it('with no rows Tab leaves the bar at once', () => {
    expect(tabStep(-1, -1, [], 1)).toEqual({ kind: 'leave', dir: 1 })
  })
})

describe('selectionAfterRemoval: the highlight moves to the row that took the place', () => {
  it('stays at the removed index while a row is there, else the new last row', () => {
    expect(selectionAfterRemoval(1, 4)).toBe(1)
    expect(selectionAfterRemoval(3, 3)).toBe(2)
  })

  it('clears only when the list is empty', () => {
    expect(selectionAfterRemoval(0, 0)).toBe(-1)
  })
})

describe('submitTarget: Enter with modifiers (Chrome\u2019s table)', () => {
  const mods = (ctrl = false, shift = false, alt = false): Parameters<typeof submitTarget>[0] => ({
    ctrl,
    shift,
    alt
  })

  it('plain Enter opens here; Alt a new foreground tab; Shift a new window; Alt+Shift behind', () => {
    expect(submitTarget(mods())).toEqual({ where: 'current', wwwCom: false })
    expect(submitTarget(mods(false, false, true))).toEqual({ where: 'tab', wwwCom: false })
    expect(submitTarget(mods(false, true))).toEqual({ where: 'window', wwwCom: false })
    expect(submitTarget(mods(false, true, true))).toEqual({ where: 'background', wwwCom: false })
  })

  it('Ctrl adds www. and .com here, Ctrl+Shift in a new window, Ctrl+Alt in a new tab', () => {
    expect(submitTarget(mods(true))).toEqual({ where: 'current', wwwCom: true })
    expect(submitTarget(mods(true, true))).toEqual({ where: 'window', wwwCom: true })
    expect(submitTarget(mods(true, false, true))).toEqual({ where: 'tab', wwwCom: true })
  })
})

describe('clickTarget: a row picked with the mouse', () => {
  const click = (
    button: number,
    ctrl = false,
    shift = false,
    alt = false
  ): Parameters<typeof clickTarget>[0] => ({ button, ctrl, shift, alt })

  it('a middle click or Ctrl+click opens a BACKGROUND tab (Chrome)', () => {
    expect(clickTarget(click(1))).toBe('background')
    expect(clickTarget(click(0, true))).toBe('background')
  })

  it('Shift+click a new window, Alt+click a new foreground tab, a plain click here', () => {
    expect(clickTarget(click(0, false, true))).toBe('window')
    expect(clickTarget(click(0, false, false, true))).toBe('tab')
    expect(clickTarget(click(0))).toBe('current')
  })
})
