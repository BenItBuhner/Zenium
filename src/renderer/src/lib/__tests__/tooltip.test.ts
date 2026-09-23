// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/types'
import { POPOVER_MARGIN } from '../portals'
import {
  placeTooltip,
  TOOLTIP_ATTR,
  TOOLTIP_BROWSE,
  TOOLTIP_DELAY,
  TOOLTIP_GAP,
  TOOLTIP_HIDDEN,
  TooltipController,
  tooltipPaneOf,
  tooltipTargetOf,
  type TooltipState
} from '../tooltip'

/*
 * The chrome tooltip's timing and geometry (lib/tooltip.ts; v2 draft §9.31, a11y-26): the
 * 500 ms dwell, the browse window that reads a row of buttons without the wait, keyboard focus
 * at once, the leave, blur, press and Escape that take it down, and the placer that keeps it
 * 8 px from its control inside the control's pane and the window.
 */

const viewport = { width: 1600, height: 1000 }
const size = { width: 96, height: 30 }
const sidebar: Rect = { x: 0, y: 0, width: 240, height: 1000 }
const page: Rect = { x: 240, y: 0, width: 1360, height: 1000 }
const control = (x: number, y: number): Rect => ({ x, y, width: 28, height: 28 })

describe('placeTooltip', () => {
  it('centres under the control, 8 px below its box, inside its pane', () => {
    expect(placeTooltip(control(100, 40), size, viewport, sidebar, page)).toEqual({
      box: { side: 'below', left: 100 + 14 - 48, top: 40 + 28 + TOOLTIP_GAP },
      coversPage: false
    })
  })

  it('slides inside the pane’s margin rather than run out over the page beside it', () => {
    // The ⋯ at the sidebar's right edge: centred it would reach 260; it stops at 240 - 8.
    const placed = placeTooltip(control(204, 40), size, viewport, sidebar, page)
    expect(placed.box.left).toBe(sidebar.width - POPOVER_MARGIN - size.width)
    expect(placed.coversPage).toBe(false)
    // And at the left edge it stops at the margin.
    expect(placeTooltip(control(4, 40), size, viewport, sidebar, page).box.left).toBe(
      POPOVER_MARGIN
    )
  })

  it('the clamp at a margin lands on the whole pixel inside it, never a fraction over', () => {
    // The ⋯ tooltip measured 95.2 wide against the 240 sidebar: the clamp is 136.8, and a
    // round to 137 would end at 232.2, past the margin at 232. It lands on 136 (measured by the
    // a11y-2 drive, 2026-09-23).
    const wide = { width: 95.2, height: 30 }
    const placed = placeTooltip(control(204, 44), wide, viewport, sidebar, page)
    expect(placed.box.left).toBe(136)
    expect(placed.box.left + wide.width).toBeLessThanOrEqual(sidebar.width - POPOVER_MARGIN)
    // A pane starting on a fraction: the margin's inner edge is the next whole pixel.
    const shifted: Rect = { x: 0.5, y: 0, width: 240, height: 1000 }
    expect(placeTooltip(control(0, 40), size, viewport, shifted, page).box.left).toBe(9)
    // Centred with room to spare: the centre rounded, as before.
    expect(
      placeTooltip({ x: 100.3, y: 40, width: 28, height: 28 }, size, viewport, sidebar, page).box
        .left
    ).toBe(66)
  })

  it('flips above a control at the bottom of its pane', () => {
    const bottom = control(100, 1000 - 8 - 28)
    expect(placeTooltip(bottom, size, viewport, sidebar, page).box).toEqual({
      side: 'above',
      left: 66,
      top: bottom.y - TOOLTIP_GAP - size.height
    })
  })

  it('stays below up to the last row that fits the pane, then flips', () => {
    const last = 1000 - POPOVER_MARGIN - size.height - TOOLTIP_GAP - 28
    expect(placeTooltip(control(100, last), size, viewport, sidebar, page).box.side).toBe('below')
    expect(placeTooltip(control(100, last + 1), size, viewport, sidebar, page).box.side).toBe(
      'above'
    )
  })

  it('a pane too short for either side hands over to the window, and says it lies over the page', () => {
    // A toolbar band across the top of the window with the page right under it.
    const band: Rect = { x: 0, y: 0, width: 1600, height: 40 }
    const below: Rect = { x: 0, y: 40, width: 1600, height: 960 }
    const placed = placeTooltip(control(100, 6), size, viewport, band, below)
    expect(placed.box).toEqual({ side: 'below', left: 66, top: 6 + 28 + TOOLTIP_GAP })
    expect(placed.coversPage).toBe(true)
  })

  it('a pane too narrow for the text hands over to the window too', () => {
    const rail: Rect = { x: 0, y: 0, width: 48, height: 1000 }
    const placed = placeTooltip(control(10, 40), size, viewport, rail, { ...page, x: 48 })
    expect(placed.box).toEqual({ side: 'below', left: POPOVER_MARGIN, top: 40 + 28 + TOOLTIP_GAP })
    expect(placed.coversPage).toBe(true)
  })

  it('a tooltip in the window that misses the page does not ask for its cover', () => {
    // The caption strip's window buttons: the band is too short, but the toolbar row is under it.
    const band: Rect = { x: 0, y: 0, width: 1600, height: 36 }
    const lower: Rect = { x: 0, y: 80, width: 1600, height: 920 }
    expect(placeTooltip(control(1560, 4), size, viewport, band, lower)).toEqual({
      box: { side: 'below', left: 1600 - POPOVER_MARGIN - size.width, top: 4 + 28 + TOOLTIP_GAP },
      coversPage: false
    })
  })

  it('without a pane it places against the window alone, whole pixels', () => {
    const placed = placeTooltip(
      { x: 100.4, y: 40.6, width: 28, height: 28 },
      size,
      viewport,
      null,
      null
    )
    expect(placed.box).toEqual({ side: 'below', left: 66, top: 77 })
    expect(placed.coversPage).toBe(false)
  })
})

describe('tooltipTargetOf / tooltipPaneOf', () => {
  it('finds the control an event landed in by its attribute, and skips one with no text', () => {
    document.body.innerHTML = `
      <aside><button ${TOOLTIP_ATTR}="Back (Alt+←)"><svg></svg></button>
      <button ${TOOLTIP_ATTR}=""><svg></svg></button><button>plain</button></aside>`
    const [back, empty, plain] = Array.from(document.querySelectorAll('button'))
    expect(tooltipTargetOf(back!.querySelector('svg'))).toBe(back)
    expect(tooltipTargetOf(empty!.querySelector('svg'))).toBeNull()
    expect(tooltipTargetOf(plain!)).toBeNull()
    expect(tooltipTargetOf(null)).toBeNull()
    expect(tooltipPaneOf(back!)).toBe(document.querySelector('aside'))
  })

  it('knows a toolbar band and the caption strip as panes, and a bare control as none', () => {
    document.body.innerHTML = `<header><button ${TOOLTIP_ATTR}="Reload"></button></header>
      <div data-tab-strip><button ${TOOLTIP_ATTR}="Close"></button></div>
      <button ${TOOLTIP_ATTR}="Loose"></button>`
    const [reload, close, loose] = Array.from(document.querySelectorAll('button'))
    expect(tooltipPaneOf(reload!)).toBe(document.querySelector('header'))
    expect(tooltipPaneOf(close!)).toBe(document.querySelector('[data-tab-strip]'))
    expect(tooltipPaneOf(loose!)).toBeNull()
  })
})

describe('TooltipController', () => {
  let state: TooltipState
  let writes: TooltipState[]
  let blocked: boolean
  let clock: number
  let controller: TooltipController
  let a: HTMLButtonElement
  let b: HTMLButtonElement

  const store = {
    get: () => state,
    set: (next: TooltipState) => {
      state = next
      writes.push(next)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    state = TOOLTIP_HIDDEN
    writes = []
    blocked = false
    clock = 10_000
    document.body.innerHTML = `<button ${TOOLTIP_ATTR}="Back (Alt+←)">a</button><button ${TOOLTIP_ATTR}="Forward (Alt+→)">b</button>`
    ;[a, b] = Array.from(document.querySelectorAll('button'))
    controller = new TooltipController(store, { blocked: () => blocked, now: () => clock })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const tick = (ms: number): void => {
    clock += ms
    vi.advanceTimersByTime(ms)
  }

  it('shows after the dwell, not before, for the pointer', () => {
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY - 1)
    expect(state.target).toBeNull()
    tick(1)
    expect(state).toEqual({ target: a, by: 'pointer' })
  })

  it('the pointer leaving before the dwell leaves nothing behind', () => {
    controller.pointerEnter(a)
    tick(200)
    controller.pointerLeave(a)
    tick(TOOLTIP_DELAY)
    expect(writes).toEqual([])
  })

  it('moves to the next control without the wait while one is showing', () => {
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    controller.pointerEnter(b)
    expect(state.target).toBe(b)
  })

  it('reads a row of buttons in browse mode: the next shows at once within the window after a leave', () => {
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    controller.pointerLeave(a)
    expect(state.target).toBeNull()
    tick(TOOLTIP_BROWSE - 1)
    controller.pointerEnter(b)
    expect(state.target).toBe(b)
  })

  it('past the browse window the dwell is back', () => {
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    controller.pointerLeave(a)
    tick(TOOLTIP_BROWSE)
    controller.pointerEnter(b)
    expect(state.target).toBeNull()
    tick(TOOLTIP_DELAY)
    expect(state.target).toBe(b)
  })

  it('keyboard focus shows at once and blur takes it down; a pointer tooltip ignores blur', () => {
    controller.focus(a)
    expect(state).toEqual({ target: a, by: 'focus' })
    controller.blur(a)
    expect(state.target).toBeNull()
    controller.pointerEnter(b)
    tick(TOOLTIP_DELAY)
    controller.blur(b)
    expect(state.target).toBe(b)
    controller.pointerLeave(b)
    expect(state.target).toBeNull()
  })

  it('a press or Escape dismisses, and the control stays silent until the pointer leaves it', () => {
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    expect(controller.dismiss()).toBe(true)
    expect(state.target).toBeNull()
    // The pointer is still on it: the child-to-parent pointerover that follows shows nothing.
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY * 2)
    expect(state.target).toBeNull()
    controller.pointerLeave(a)
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    expect(state.target).toBe(a)
  })

  it('Escape on a keyboard tooltip silences nothing: the pointer’s first visit shows it after the dwell', () => {
    // The a11y-2 drive's finding (2026-09-23): Escape on the focused Back button's tooltip left
    // Back silent for a pointer that had never been on it, so its first hover showed nothing
    // until the pointer had left it once.
    controller.focus(a)
    expect(controller.dismiss()).toBe(true)
    expect(state.target).toBeNull()
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    expect(state).toEqual({ target: a, by: 'pointer' })
    // The keyboard's Escape still leaves it down on the control: nothing re-shows for the focus.
    controller.pointerLeave(a)
    controller.focus(a)
    expect(controller.dismiss()).toBe(true)
    expect(state.target).toBeNull()
  })

  it('dismiss with nothing showing says so – Escape is not the tooltip’s then', () => {
    expect(controller.dismiss()).toBe(false)
    controller.pointerEnter(a)
    expect(controller.dismiss()).toBe(false)
    tick(TOOLTIP_DELAY)
    expect(state.target).toBeNull()
  })

  it('other chrome having the window blocks: on arrival, and again when the dwell has run', () => {
    blocked = true
    controller.pointerEnter(a)
    tick(TOOLTIP_DELAY)
    expect(writes).toEqual([])
    controller.focus(a)
    expect(writes).toEqual([])
    blocked = false
    controller.pointerEnter(a)
    blocked = true
    tick(TOOLTIP_DELAY)
    expect(state.target).toBeNull()
  })

  it('a control that left the DOM or lost its text shows nothing', () => {
    controller.pointerEnter(a)
    a.remove()
    tick(TOOLTIP_DELAY)
    expect(state.target).toBeNull()
    controller.pointerEnter(b)
    b.removeAttribute(TOOLTIP_ATTR)
    tick(TOOLTIP_DELAY)
    expect(state.target).toBeNull()
  })

  it('hide takes down what shows and what is on its way', () => {
    controller.pointerEnter(a)
    controller.hide()
    tick(TOOLTIP_DELAY)
    expect(state.target).toBeNull()
    controller.focus(a)
    controller.hide()
    expect(state.target).toBeNull()
    expect(controller.showing()).toBe(false)
  })
})
