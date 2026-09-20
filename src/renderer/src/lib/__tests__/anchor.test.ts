// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { Rect } from '@shared/types'
import { anchorOf, placeUnder } from '../anchor'
import { POPOVER_MARGIN, placePopover } from '../portals'

const viewport = { width: 1280, height: 800 }

/** An element that reports `rect` as its box, as the layout would. */
function boxed<T extends HTMLElement>(el: T, rect: Rect): T {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect
    }) as DOMRect
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * §9.20 (1) read against a column (the #235 ruling): a menulist at the trailing end of a print
 * dialog's option column – a scrolling column 240 wide on the frame's end side – end-aligns its
 * popup, while one in the leading half start-aligns; the popup hangs from the control's own box
 * either way, never from the column's bottom edge.
 */
describe('anchorOf: the column a bar-less control stands in (§9.20)', () => {
  it('is the nearest scroll container, and the popover end-aligns from the trailing half of it', () => {
    const column = boxed(document.createElement('div'), {
      x: 1000,
      y: 100,
      width: 240,
      height: 600
    })
    column.style.overflowY = 'auto'
    const row = document.createElement('div')
    const trailing = boxed(document.createElement('button'), {
      x: 1112,
      y: 300,
      width: 112,
      height: 32
    })
    const leading = boxed(document.createElement('button'), {
      x: 1016,
      y: 400,
      width: 112,
      height: 32
    })
    row.append(leading, trailing)
    column.append(row)
    document.body.append(column)

    const anchor = anchorOf(trailing)
    expect(anchor.bar).toBeUndefined()
    expect(anchor.column).toEqual({ x: 1000, y: 100, width: 240, height: 600 })
    expect(anchor.element).toBe(trailing)
    // The trigger's centre (1168) is past the column's midpoint (1120): end edges line up.
    const end = placeUnder(anchor, { measured: 200 }, 160, viewport)
    expect(end.alignment).toBe('end')
    expect(end.left).toBe(1112 + 112 - 200)
    expect(end.side === 'below' && end.top).toBe(300 + 32)

    // The trigger's centre (1072) is before the midpoint: start edges line up.
    const start = placeUnder(anchorOf(leading), { measured: 200 }, 160, viewport)
    expect(start.alignment).toBe('start')
    expect(start.left).toBe(1016)
    expect(start.side === 'below' && start.top).toBe(400 + 32)
  })

  it('is the window when nothing up the tree scrolls', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    const page = document.createElement('main')
    const right = boxed(document.createElement('button'), {
      x: 900,
      y: 200,
      width: 120,
      height: 32
    })
    const left = boxed(document.createElement('button'), { x: 200, y: 200, width: 120, height: 32 })
    page.append(left, right)
    document.body.append(page)
    expect(anchorOf(right).column).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(placeUnder(anchorOf(right), { measured: 232 }, 200, viewport).alignment).toBe('end')
    expect(placeUnder(anchorOf(left), { measured: 232 }, 200, viewport).alignment).toBe('start')
  })

  it('yields to a bar: a control in a [data-bar] keeps the bar as its half and gets no column', () => {
    const bar = boxed(document.createElement('div'), { x: 0, y: 40, width: 1280, height: 30 })
    bar.setAttribute('data-bar', '')
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const button = boxed(document.createElement('button'), {
      x: 1200,
      y: 42,
      width: 28,
      height: 26
    })
    bar.append(button)
    scroller.append(bar)
    document.body.append(scroller)
    const anchor = anchorOf(button)
    expect(anchor.bar).toEqual({ x: 0, y: 40, width: 1280, height: 30 })
    expect(anchor.column).toBeUndefined()
    // Hangs from the bar, end-aligned by its half of the bar, as before.
    const box = placeUnder(anchor, 320, undefined, viewport)
    expect(box.side === 'below' && box.top).toBe(70)
    expect(box.alignment).toBe('end')
  })
})

describe('placePopover with a column (§9.20)', () => {
  const column = { x: 1000, y: 100, width: 240, height: 600 }

  it('reads the half against the column and hangs from the anchor', () => {
    const trailing = { x: 1112, y: 300, width: 112, height: 32 }
    const box = placePopover(trailing, trailing, viewport, { measured: 200 }, 160, undefined, {
      column
    })
    expect(box.alignment).toBe('end')
    expect(box.left).toBe(1024)
    expect(box.side === 'below' && box.top).toBe(332)
    const leading = { x: 1016, y: 300, width: 112, height: 32 }
    const start = placePopover(leading, leading, viewport, { measured: 200 }, 160, undefined, {
      column
    })
    expect(start.alignment).toBe('start')
    expect(start.left).toBe(1016)
  })

  it('still flips when the aligned box would cross the margin', () => {
    // A trailing-half trigger in a column at the window's start edge: its end-aligned popup
    // would cross the left margin, so it flips to start on the anchor's edge (§9.20 (2)).
    const atStart = { x: 0, y: 100, width: 240, height: 600 }
    const trigger = { x: 130, y: 300, width: 100, height: 32 }
    const box = placePopover(trigger, trigger, viewport, { measured: 300 }, 160, undefined, {
      column: atStart
    })
    expect(box.alignment).toBe('start')
    expect(box.left).toBe(130)
    expect(box.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
  })

  it('without a column an anchor standing alone start-aligns whatever its half of the window', () => {
    const trigger = { x: 700, y: 300, width: 112, height: 32 }
    expect(placePopover(trigger, trigger, viewport, { measured: 200 }, 160).alignment).toBe('start')
    const window = { x: 0, y: 0, ...viewport }
    expect(
      placePopover(trigger, trigger, viewport, { measured: 200 }, 160, undefined, {
        column: window
      }).alignment
    ).toBe('end')
  })
})
