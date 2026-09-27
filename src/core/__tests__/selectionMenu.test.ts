import { describe, expect, it, vi } from 'vitest'
import type { Rect, SelectionMenuState } from '../../shared/types'
import { anchorInChrome } from '../credentials/fill'
import { SELECTION_MINI_MENU_ORDER } from '../menus'
import {
  estimateMiniMenuSize,
  MINI_MENU_FOLD_SLACK,
  MINI_MENU_GAP,
  MINI_MENU_HEIGHT,
  MINI_MENU_MARGIN,
  MINI_MENU_SURFACE_PAD,
  miniMenuFolds,
  parseSelectionReport,
  placeMiniMenuSurface,
  SELECTION_MENU_MAX_CHARS
} from '../selectionMenu'
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
 * document, the tab, the window's keyboard or the chip that ran. The pill stands on the
 * window's popup surface over the selection's box, at the size its document measures, hugging
 * its chips and folding as one row to glyph buttons where the view is narrower than it – the
 * fold changing its width alone, the box 46 in both poses.
 */

const RECT = { x: 100, y: 200, width: 120, height: 18 }

/** Where the chrome put the page: under 120 of chrome, the window's full width. */
const VIEW: Rect = { x: 0, y: 120, width: 1280, height: 680 }

const PAD = MINI_MENU_SURFACE_PAD

function layout(h: PageHarness, view: Rect = VIEW, contentHidden = false): void {
  h.win.applyLayout({
    contentHidden,
    glance: null,
    placements: contentHidden ? [] : [{ tabId: h.tabId, rect: view, radius: 0 }]
  })
}

/** Where the surface should stand for `rect` reported in a page at `view`, before any measurement (the model's pose). */
function expectedSurface(h: PageHarness, rect: Rect, view: Rect = VIEW): Rect {
  const menu = h.browser.state.snapshot(h.win).selectionMenu
  const actions = menu?.actions ?? []
  return placeMiniMenuSurface(
    anchorInChrome(rect, view, 1),
    view,
    estimateMiniMenuSize(actions, menu?.folded ?? false)
  )
}

function measure(h: PageHarness, width: number, height: number, folded = false): void {
  h.browser.handleCommand(h.win, 'selectionMenu.surfaceSize', {
    tabId: h.tabId,
    width,
    height,
    folded
  })
}

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

describe('where the pill stands', () => {
  const SIZE = { width: 300, height: MINI_MENU_HEIGHT }

  it('centres the pill over the box, the gap above it, the surface padded for the shadow', () => {
    const anchor = { x: 100, y: 400, width: 120, height: 18 }
    const left = 100 + 60 - 150
    const top = 400 - MINI_MENU_GAP - SIZE.height
    expect(placeMiniMenuSurface(anchor, VIEW, SIZE)).toEqual({
      x: left - PAD,
      y: top - PAD,
      width: SIZE.width + PAD * 2,
      height: SIZE.height + PAD * 2
    })
  })

  it('goes below the box when the room above is short of the margin', () => {
    const anchor = { x: 100, y: VIEW.y + 20, width: 120, height: 18 }
    const placed = placeMiniMenuSurface(anchor, VIEW, SIZE)
    expect(placed.y + PAD).toBe(anchor.y + anchor.height + MINI_MENU_GAP)
    // Just enough room above keeps it above.
    const roomy = { ...anchor, y: VIEW.y + MINI_MENU_MARGIN + SIZE.height + MINI_MENU_GAP }
    expect(placeMiniMenuSurface(roomy, VIEW, SIZE).y + PAD).toBe(VIEW.y + MINI_MENU_MARGIN)
  })

  it('holds the pill inside the view at its sides, never over the chrome beside the page', () => {
    const view = { x: 200, y: 120, width: 800, height: 680 }
    const atLeft = placeMiniMenuSurface({ x: 205, y: 400, width: 20, height: 18 }, view, SIZE)
    expect(atLeft.x + PAD).toBe(view.x + MINI_MENU_MARGIN)
    const atRight = placeMiniMenuSurface({ x: 990, y: 400, width: 10, height: 18 }, view, SIZE)
    expect(atRight.x + PAD).toBe(view.x + view.width - MINI_MENU_MARGIN - SIZE.width)
  })

  it('clamps over the box when the view is too short for either side', () => {
    const view = { x: 0, y: 100, width: 1280, height: 60 }
    const placed = placeMiniMenuSurface({ x: 100, y: 100, width: 100, height: 60 }, view, SIZE)
    expect(placed.y + PAD).toBe(view.y + MINI_MENU_MARGIN)
    expect(placed.height).toBe(SIZE.height + PAD * 2)
  })

  it('estimates the pill from its chips hugging their labels (no floor), the gaps and sides; folded, from the 28 glyph buttons at the same 46', () => {
    const three = estimateMiniMenuSize([
      { id: 'copy', title: 'Copy' },
      { id: 'search', title: 'Search Google' },
      { id: 'define', title: 'Define' }
    ])
    expect(three.height).toBe(MINI_MENU_HEIGHT)
    // 12 each side around the 16 glyph, its 8 gap and the label at 7 a character: Copy is 76,
    // under the button primitive's 96 floor the chip gives up.
    const chip = (title: string): number => 12 + 16 + 8 + 12 + title.length * 7
    expect(chip('Copy')).toBe(76)
    expect(three.width).toBe(14 + chip('Copy') + chip('Search Google') + chip('Define') + 2 * 8)
    const five = estimateMiniMenuSize([
      { id: 'copy', title: 'Copy' },
      { id: 'search', title: 'Search Google' },
      { id: 'define', title: 'Define' },
      { id: 'translate', title: 'Translate' },
      { id: 'readAloud', title: 'Listen' }
    ])
    expect(five.width).toBeGreaterThan(three.width)
    expect(estimateMiniMenuSize([]).width).toBe(14)
    // Folded: five 28 glyph buttons, the gaps and sides – whatever the labels – in the SAME 46
    // box (the lead's line: the fold changes the width alone; the glyph buttons stand centred in
    // the 32 control band, so a resize across the threshold never moves the pill by 4).
    const folded = estimateMiniMenuSize(
      [
        { id: 'copy', title: 'Copy' },
        { id: 'search', title: 'Search Google' },
        { id: 'define', title: 'Define' },
        { id: 'translate', title: 'Translate' },
        { id: 'readAloud', title: 'Listen' }
      ],
      true
    )
    expect(folded).toEqual({ width: 14 + 5 * 28 + 4 * 8, height: MINI_MENU_HEIGHT })
    expect(folded.width).toBeLessThan(five.width)
    expect(folded.height).toBe(five.height)
    expect(MINI_MENU_HEIGHT).toBe(46)
  })

  it('folds where the view is narrower than the full pill and its two margins, and not at that width', () => {
    const full = { width: 500, height: MINI_MENU_HEIGHT }
    expect(MINI_MENU_FOLD_SLACK).toBe(2 * MINI_MENU_MARGIN)
    expect(miniMenuFolds(full, { width: 500 + MINI_MENU_FOLD_SLACK })).toBe(false)
    expect(miniMenuFolds(full, { width: 500 + MINI_MENU_FOLD_SLACK - 1 })).toBe(true)
    expect(miniMenuFolds(full, { width: 1280 })).toBe(false)
    expect(miniMenuFolds(full, { width: 300 })).toBe(true)
  })
})

describe('the pill on the popup surface', () => {
  it('goes up over the selection on the window\u2019s surface as the page reports, and down with the model', () => {
    const h = pageHarness()
    layout(h)
    expect(h.popupCalls).toEqual([])
    report(h, 'quantum foam')
    expect(h.popupCalls).toEqual([expectedSurface(h, RECT)])
    const placed = h.popupCalls[0]!
    // Above the box, which stands 200 into a view that starts 120 down.
    expect(placed.y + PAD + (placed.height - PAD * 2) + MINI_MENU_GAP).toBe(VIEW.y + RECT.y)
    report(h, '')
    expect(h.popupCalls.at(-1)).toBeNull()
    expect(h.popupCalls.length).toBe(2)
  })

  it('follows the size the pill\u2019s document measures, and drops another tab\u2019s report or a nonsensical one', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    measure(h, 420, 46)
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 420 + PAD * 2, height: 46 + PAD * 2 })
    const placed = h.popupCalls.length
    h.browser.handleCommand(h.win, 'selectionMenu.surfaceSize', {
      tabId: 'tab_gone',
      width: 100,
      height: 46,
      folded: false
    })
    measure(h, Number.NaN, 46)
    measure(h, 420, 0)
    // The same size again places nothing anew.
    measure(h, 420, 46)
    expect(h.popupCalls.length).toBe(placed)
  })

  it('keeps the measurement for the same chips and starts from the estimate when the chips change', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'foam')
    measure(h, 400, 46)
    // Two words: the same three chips, so the pill is placed at the measured 400 at once.
    report(h, 'quantum foam')
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 400 + PAD * 2 })
    // Four words lose Define: another pill, estimated until it measures.
    report(h, 'the quantum foam theory')
    expect(chips(h)).toEqual(['copy', 'search'])
    expect(h.popupCalls.at(-1)).toEqual(expectedSurface(h, RECT))
  })

  it('follows the view through a layout, goes down while the chrome covers the page and comes back with it', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    const first = h.popupCalls.at(-1)!
    const moved = { ...VIEW, x: 300, width: 980 }
    layout(h, moved)
    expect(h.popupCalls.at(-1)).toEqual({ ...first, x: first.x + 300 })
    layout(h, VIEW, true)
    expect(h.popupCalls.at(-1)).toBeNull()
    expect(model(h)?.text).toBe('quantum foam')
    layout(h)
    expect(h.popupCalls.at(-1)).toEqual(first)
  })

  it('goes down while the box lies outside the view (the selection scrolled off), the model standing', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    expect(h.popupCalls.at(-1)).not.toBeNull()
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'quantum foam', rect: { ...RECT, y: -60 }, isEditable: false },
      frameId: 0
    })
    expect(h.popupCalls.at(-1)).toBeNull()
    expect(model(h)?.rect).toEqual({ ...RECT, y: -60 })
    // Nothing to hang from without a box either.
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'quantum foam', rect: null, isEditable: false },
      frameId: 0
    })
    expect(h.popupCalls.at(-1)).toBeNull()
    expect(model(h)?.text).toBe('quantum foam')
  })

  it('hangs from the box scaled by the page zoom', () => {
    const h = pageHarness()
    layout(h)
    h.browser.tabs.setZoom(h.tabId, 2)
    report(h, 'quantum foam')
    const actions = model(h)!.actions
    expect(h.popupCalls.at(-1)).toEqual(
      placeMiniMenuSurface(anchorInChrome(RECT, VIEW, 2), VIEW, estimateMiniMenuSize(actions))
    )
  })

  it('draws nothing on a host without a popup surface, the model standing for the chrome', () => {
    const h = pageHarness(DESKTOP, { popupSurface: false })
    layout(h)
    report(h, 'quantum foam')
    expect(model(h)?.text).toBe('quantum foam')
    expect(h.popupCalls).toEqual([])
    expect(h.win.hasPopupSurface).toBe(false)
  })

  it('lets the autofill picker have the one surface in front, and takes it back as the picker goes', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    const pill = h.popupCalls.at(-1)!
    const picker = { x: 40, y: 300, width: 336, height: 200 }
    h.win.setPopupSurface(picker, 'autofill')
    expect(h.popupCalls.at(-1)).toEqual(picker)
    // The pill placed again behind the picker changes nothing the host sees.
    measure(h, 500, 46)
    expect(h.popupCalls.at(-1)).toEqual(picker)
    h.win.setPopupSurface(null, 'autofill')
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 500 + PAD * 2 })
    expect(h.popupCalls.at(-1)).not.toEqual(pill)
    report(h, '')
    expect(h.popupCalls.at(-1)).toBeNull()
    // The picker alone, then the pill behind it: the picker's place still; the picker's going
    // hands the surface to the pill; the pill's going takes it down.
    h.win.setPopupSurface(picker, 'autofill')
    report(h, 'quantum foam')
    expect(h.popupCalls.at(-1)).toEqual(picker)
    h.win.setPopupSurface(null, 'autofill')
    // The same chips as the pill measured before: its 500 stands.
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 500 + PAD * 2, height: 46 + PAD * 2 })
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: h.tabId })
    expect(h.popupCalls.at(-1)).toBeNull()
  })

  it('is off with the setting, a standing menu going as it is turned off', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    expect(model(h)).not.toBeNull()
    h.browser.handleCommand(h.win, 'settings.update', { showSelectionMenu: false })
    expect(model(h)).toBeNull()
    expect(h.popupCalls.at(-1)).toBeNull()
    expect(h.browser.selectionMenu.available).toBe(false)
    report(h, 'quantum foam')
    expect(model(h)).toBeNull()
    h.browser.handleCommand(h.win, 'settings.update', { showSelectionMenu: true })
    expect(h.browser.selectionMenu.available).toBe(true)
    report(h, 'quantum foam')
    expect(model(h)?.text).toBe('quantum foam')
  })

  it('folds the whole row to glyph buttons where the view is narrower than the pill and its margins, and unfolds as the view widens', () => {
    const h = pageHarness({ ...DESKTOP, readAloud: true }, FULL)
    const full = estimateMiniMenuSize([
      { id: 'copy', title: 'Copy' },
      { id: 'search', title: 'Search Google' },
      { id: 'define', title: 'Define' },
      { id: 'translate', title: 'Translate' },
      { id: 'readAloud', title: 'Listen' }
    ])
    // A split pane: narrower than the five chips and their two margins.
    const narrow: Rect = { x: 0, y: 120, width: full.width + MINI_MENU_FOLD_SLACK - 1, height: 680 }
    layout(h, narrow)
    report(h, 'quantum foam')
    expect(model(h)?.folded).toBe(true)
    expect(chips(h)).toEqual([...SELECTION_MINI_MENU_ORDER])
    const foldedEstimate = estimateMiniMenuSize(model(h)!.actions, true)
    expect(h.popupCalls.at(-1)).toEqual(
      placeMiniMenuSurface(anchorInChrome(RECT, narrow, 1), narrow, foldedEstimate)
    )
    // The fold changed the surface's width alone: the box is the 46 it was.
    expect(h.popupCalls.at(-1)).toMatchObject({ height: MINI_MENU_HEIGHT + PAD * 2 })
    // The folded pill measures itself: the surface follows, the pose stands.
    measure(h, 190, 46, true)
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 190 + PAD * 2, height: 46 + PAD * 2 })
    expect(model(h)?.folded).toBe(true)
    // The view at exactly the pill and its margins: the row unfolds, at the full estimate until
    // the full pill has measured.
    const wide: Rect = { ...narrow, width: full.width + MINI_MENU_FOLD_SLACK }
    layout(h, wide)
    expect(model(h)?.folded).toBe(false)
    expect(h.popupCalls.at(-1)).toEqual(
      placeMiniMenuSurface(anchorInChrome(RECT, wide, 1), wide, full)
    )
    // The full pill measures wider than the estimate, past the view: the row folds again, at the
    // folded measurement it already has.
    measure(h, full.width + 4, 46)
    expect(model(h)?.folded).toBe(true)
    expect(h.popupCalls.at(-1)).toMatchObject({ width: 190 + PAD * 2, height: 46 + PAD * 2 })
    // A view with the room for the measured pill: unfolded, at the measured 46.
    layout(h, { ...narrow, width: full.width + 4 + MINI_MENU_FOLD_SLACK })
    expect(model(h)?.folded).toBe(false)
    expect(h.popupCalls.at(-1)).toMatchObject({ width: full.width + 4 + PAD * 2 })
    // A report over the same words keeps the pose; other chips start unfolded from the estimate.
    layout(h, narrow)
    expect(model(h)?.folded).toBe(true)
    report(h, 'quantum foam')
    expect(model(h)?.folded).toBe(true)
    report(h, 'the quantum foam theory')
    expect(chips(h)).toEqual(['copy', 'search', 'translate', 'readAloud'])
    expect(model(h)?.folded).toBe(miniMenuFolds(estimateMiniMenuSize(model(h)!.actions), narrow))
  })

  it('never folds one chip at a time: the pose is one answer for the row', () => {
    const h = pageHarness()
    layout(h, { x: 0, y: 120, width: 240, height: 680 })
    report(h, 'quantum foam')
    expect(model(h)?.folded).toBe(true)
    expect(chips(h)).toEqual(['copy', 'search', 'define'])
    layout(h)
    expect(model(h)?.folded).toBe(false)
    expect(chips(h)).toEqual(['copy', 'search', 'define'])
  })

  it('pushes the surface to the host once per layout while the pill is in front, and takes a window\u2019s stale surface down when its tab has moved on', () => {
    const h = pageHarness()
    layout(h)
    report(h, 'quantum foam')
    const before = h.popupCalls.length
    layout(h, { ...VIEW, x: 300, width: 980 })
    expect(h.popupCalls.length).toBe(before + 1)
    // The picker in front: the layout puts it back on top, and the pill's placing behind it
    // pushes the picker's bounds again – two pushes of the front owner's rect, nothing of the pill.
    const picker = { x: 40, y: 300, width: 336, height: 200 }
    h.win.setPopupSurface(picker, 'autofill')
    const withPicker = h.popupCalls.length
    layout(h)
    expect(h.popupCalls.slice(withPicker).every((call) => call === picker)).toBe(true)
    h.win.setPopupSurface(null, 'autofill')
    // The tab moves to another window: the source's surface is up until the source lays out, and
    // then it goes; the destination gets the pill as it lays out.
    const other = h.browser.openWindow('unsynced', h.win)!
    const source = vi.spyOn(h.win, 'setPopupSurface')
    const target = vi.spyOn(other, 'setPopupSurface')
    expect(h.browser.tabs.moveTabToWindow(h.tabId, other)).toBe(true)
    // The model stands – the tab is on screen in the other window – and is that window's now.
    expect(model(h)).toBeNull()
    expect(h.browser.state.snapshot(other).selectionMenu?.text).toBe('quantum foam')
    layout(h)
    expect(source).toHaveBeenCalledWith(null, 'selectionMenu')
    expect(target).not.toHaveBeenCalled()
    other.applyLayout({
      contentHidden: false,
      glance: null,
      placements: [{ tabId: h.tabId, rect: VIEW, radius: 0 }]
    })
    expect(target).toHaveBeenCalledWith(
      expect.objectContaining({ width: expect.any(Number) }),
      'selectionMenu'
    )
  })

  it('hands the keyboard back to the page as a chip runs and on dismiss', () => {
    const h = pageHarness()
    layout(h)
    const focus = vi.spyOn(h.win, 'focusContent')
    report(h, 'quantum foam')
    h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'copy' })
    expect(focus).toHaveBeenCalledTimes(1)
    report(h, 'quantum foam')
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: 'tab_gone' })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(model(h)).not.toBeNull()
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: h.tabId })
    expect(focus).toHaveBeenCalledTimes(2)
    expect(model(h)).toBeNull()
    // Nothing standing: dismiss moves nothing.
    h.browser.handleCommand(h.win, 'selectionMenu.dismiss', { tabId: h.tabId })
    expect(focus).toHaveBeenCalledTimes(2)
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
      actions: [
        { id: 'copy', title: 'Copy' },
        { id: 'search', title: 'Search Google' },
        { id: 'define', title: 'Define' },
        { id: 'translate', title: 'Translate' },
        { id: 'readAloud', title: 'Listen' }
      ],
      folded: false
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

  it('shows nothing over a text field\u2019s selection (the lead\u2019s ruling): the report arrives, clears what stood, and draws no surface', () => {
    const h = pageHarness()
    layout(h)
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'hello', rect: RECT, isEditable: true },
      frameId: 0
    })
    expect(model(h)).toBeNull()
    expect(h.popupCalls).toEqual([])
    // The page's selection stood; the field's replaced it: the menu goes with it.
    report(h, 'quantum foam')
    expect(model(h)?.text).toBe('quantum foam')
    h.browser.handlePageMessage(h.tabId, {
      type: 'selection',
      selection: { text: 'quantum foam', rect: RECT, isEditable: true },
      frameId: 0
    })
    expect(model(h)).toBeNull()
    expect(h.popupCalls.at(-1)).toBeNull()
    // The page context menu over a field's selection stands as it was (menus.test.ts: the
    // editable field's own items); the gate is the mini menu's alone.
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
    // One the host did not stamp with its frame is not the top document's either.
    report(h, 'quantum foam', { frameId: undefined })
    expect(model(h)).toBeNull()
    // A frame's report leaves a standing model alone too: it is another document's selection.
    report(h, 'quantum foam')
    report(h, 'other words', { frameId: 7 })
    report(h, 'other words', { frameId: undefined })
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
    // The stop and the quotes a drag took along go: the surface is asked for the bare word.
    report(h, '\u201cfoam.\u201d')
    expect(chips(h)).toContain('define')
    expect(
      h.browser.handleCommand(h.win, 'selectionMenu.run', { tabId: h.tabId, id: 'define' })
    ).toBe(true)
    expect(send).toHaveBeenLastCalledWith('define.show', {
      tabId: h.tabId,
      term: 'foam',
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
