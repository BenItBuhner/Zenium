// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/types'
import { starSeat } from '../starSeat'
import { POPOVER_MARGIN, POPOVER_WIDTH, placePopover } from '../portals'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

/*
 * Where the star bubble hangs from (v2 §9.20): the star chip in the pill when the pill has room
 * for it; the star's seat at the pill's trailing end when the chip has folded away (the width
 * tier, the 240 sidebar's container query) – so the bubble still hangs flush under the pill,
 * over the address, and never floats in the window's corner with nothing under it; the ⋯ with
 * no pill in the row (the compact column); the corner only with nothing on screen at all.
 */

const PILL: Rect = { x: 76, y: 26, width: 70, height: 32 }
const STAR: Rect = { x: 118, y: 28, width: 28, height: 28 }
const MENU: Rect = { x: 150, y: 28, width: 28, height: 28 }
const VIEWPORT = { width: 1600, height: 1000 }

/** Give an element a box (happy-dom lays nothing out); `null` for one that is `display: none`. */
function laidOut(el: Element, box: Rect | null): void {
  el.getBoundingClientRect = () =>
    ({
      x: box?.x ?? 0,
      y: box?.y ?? 0,
      left: box?.x ?? 0,
      top: box?.y ?? 0,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      right: (box?.x ?? 0) + (box?.width ?? 0),
      bottom: (box?.y ?? 0) + (box?.height ?? 0),
      toJSON: () => ({})
    }) as DOMRect
}

function pill(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'zen-pill'
  laidOut(el, PILL)
  document.body.appendChild(el)
  return el
}

function star(inPill: HTMLElement, box: Rect | null): HTMLElement {
  const el = document.createElement('button')
  el.setAttribute('data-bm-star', '')
  laidOut(el, box)
  inPill.appendChild(el)
  return el
}

function menuButton(): HTMLElement {
  const el = document.createElement('button')
  el.setAttribute('data-zen-app-menu-button', '')
  laidOut(el, MENU)
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('starSeat', () => {
  it('hangs from the star chip when the pill shows it', () => {
    star(pill(), STAR)
    expect(starSeat()).toEqual({ anchor: STAR, pill: PILL })
  })

  it('with the star folded out of the pill, hangs from the star’s seat at the pill’s end, flush under the pill', () => {
    pill()
    const seat = starSeat()
    // The 28 box where the chip sits when there is room: end-flush, centred in the pill's 32.
    expect(seat).toEqual({
      anchor: { x: PILL.x + PILL.width - 28, y: PILL.y + 2, width: 28, height: 28 },
      pill: PILL
    })
    const box = placePopover(seat.anchor, seat.pill!, VIEWPORT, POPOVER_WIDTH.form)
    // The bubble's top edge is the pill's bottom edge (gap 0), and its box overlaps the seat –
    // end-aligned where that fits, otherwise grown the other way from the seat's own edge.
    expect(box.side).toBe('below')
    expect(box.side === 'below' && box.top).toBe(PILL.y + PILL.height)
    expect(box.left).toBeLessThanOrEqual(seat.anchor.x)
    expect(box.left + box.width).toBeGreaterThanOrEqual(seat.anchor.x + seat.anchor.width)
    expect(box.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
  })

  it('a star chip in the tree but laid out as nothing (the container query’s display: none) is the folded star', () => {
    star(pill(), null)
    expect(starSeat().anchor).toEqual({
      x: PILL.x + PILL.width - 28,
      y: PILL.y + 2,
      width: 28,
      height: 28
    })
  })

  it('with no pill in the row (the compact column), hangs from the ⋯, where Bookmark This Tab lives', () => {
    menuButton()
    expect(starSeat()).toEqual({ anchor: MENU, pill: null })
  })

  it('with nothing on screen, stands in the window’s top trailing corner', () => {
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true })
    expect(starSeat()).toEqual({
      anchor: { x: VIEWPORT.width - POPOVER_MARGIN - 28, y: 28, width: 28, height: 28 },
      pill: null
    })
  })
})
