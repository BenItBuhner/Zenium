// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { Rect } from '@shared/types'
import { POPOVER_HEIGHT_FLOOR, POPOVER_MARGIN } from '@renderer/lib/portals'
import { PANEL_INSET, besideOrigin, layoutRect, placeBeside, rowRect } from '../panelGeometry'

/*
 * The cascading folder panels' geometry (design-language-v2-draft §5, §9.20): a nested panel
 * stands flush beside the panel holding its folder's row, its first row on that row, and keeps
 * 8 inside the window by flipping to the other side, sliding, or shrinking – in that order.
 */

const viewport = { width: 1600, height: 1000 }
/** The root panel: 260 wide under a chip, 10 rows of 31 in 6 + 1 of padding and border. */
const parent: Rect = { x: 300, y: 36, width: 260, height: 324 }
/** A folder row in it, 6 in from the panel's edges (the menu's padding), 31 tall, `i` rows down. */
const rowAt = (i: number): Rect => ({
  x: parent.x + 1 + 6,
  y: parent.y + PANEL_INSET + i * 31,
  width: parent.width - 2 - 12,
  height: 31
})
const size = { width: 240, height: 200 }

describe('placeBeside', () => {
  it('stands flush on the parent’s trailing edge, its first row on the folder row (the inset above it)', () => {
    const row = rowAt(3)
    expect(placeBeside(row, parent, viewport, size)).toEqual({
      side: 'below',
      edge: 'after',
      left: parent.x + parent.width,
      top: row.y - PANEL_INSET,
      width: 240,
      maxHeight: 200
    })
  })

  it('the inset is the panel’s border plus the menu’s 6 padding, so row lines up with row', () => {
    expect(PANEL_INSET).toBe(1 + 6)
  })

  it('flips to the parent’s leading edge when the trailing side would cross the margin', () => {
    const wide: Rect = { ...parent, x: viewport.width - POPOVER_MARGIN - 100 - parent.width }
    const row = { ...rowAt(0), x: wide.x + 5 }
    const box = placeBeside(row, wide, viewport, size)
    expect(box.edge).toBe('before')
    expect(box.left).toBe(wide.x - size.width)
    expect(box.left + box.width).toBe(wide.x)
  })

  it('keeps the trailing side when it fits exactly inside the margin', () => {
    const snug: Rect = { ...parent, x: viewport.width - POPOVER_MARGIN - size.width - parent.width }
    const box = placeBeside(rowAt(0), snug, viewport, size)
    expect(box.edge).toBe('after')
    expect(box.left + box.width).toBe(viewport.width - POPOVER_MARGIN)
  })

  it('slides inside the margins, over its parent, when neither side fits', () => {
    const narrow = { width: 600, height: 1000 }
    const mid: Rect = { x: 150, y: 36, width: 300, height: 320 }
    const box = placeBeside(rowAt(0), mid, narrow, { width: 280, height: 200 })
    expect(box.edge).toBe('after')
    expect(box.left).toBe(narrow.width - POPOVER_MARGIN - 280)
    expect(box.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(box.left).toBeLessThan(mid.x + mid.width)
  })

  it('shrinks a panel wider than the window minus 16 to that', () => {
    const narrow = { width: 300, height: 1000 }
    const box = placeBeside(rowAt(0), { ...parent, x: 8, width: 100 }, narrow, {
      width: 500,
      height: 100
    })
    expect(box.width).toBe(narrow.width - 2 * POPOVER_MARGIN)
    expect(box.left).toBe(POPOVER_MARGIN)
  })

  it('never starts above the top margin', () => {
    const high: Rect = { ...parent, y: 0 }
    const row = { ...rowAt(0), y: 2 }
    const box = placeBeside(row, high, viewport, size)
    expect(box.side).toBe('below')
    expect(box).toHaveProperty('top', POPOVER_MARGIN)
  })

  it('flips above the row – its last row on the row’s bottom – when it would cross the bottom and more room is above', () => {
    const low: Rect = { ...parent, y: 600 }
    const row: Rect = { ...rowAt(0), y: 900 }
    const box = placeBeside(row, low, viewport, size)
    expect(box.side).toBe('above')
    expect(box).toHaveProperty('bottom', viewport.height - (row.y + row.height + PANEL_INSET))
    expect(box.maxHeight).toBe(200)
  })

  it('stays below and shrinks to the room left when that room is at least the floor and more than above', () => {
    // The row stands 300 from the top: 692 of room below, 300 + row + inset above.
    const row: Rect = { ...rowAt(0), y: 300 }
    const box = placeBeside(row, parent, viewport, { width: 240, height: 900 })
    expect(box.side).toBe('below')
    expect(box.maxHeight).toBe(viewport.height - POPOVER_MARGIN - (row.y - PANEL_INSET))
    expect(box.maxHeight).toBeGreaterThanOrEqual(POPOVER_HEIGHT_FLOOR)
  })

  it('flips above when the room below is under the floor, even with less room above than below', () => {
    // A 250 tall window: 149 below the row (under the 160 floor), 130 above it – the row's
    // bottom plus the inset, less the margin.
    const small = { width: 1600, height: 250 }
    const row: Rect = { ...rowAt(0), y: 100 }
    const box = placeBeside(row, { ...parent, y: 40, height: 200 }, small, size)
    expect(box.side).toBe('above')
    expect(box.maxHeight).toBe(row.y + row.height + PANEL_INSET - POPOVER_MARGIN)
  })

  it('is never taller than the window minus 16', () => {
    const box = placeBeside(rowAt(0), parent, viewport, { width: 240, height: 5000 })
    expect(box.maxHeight).toBeLessThanOrEqual(viewport.height - 2 * POPOVER_MARGIN)
  })
})

describe('besideOrigin', () => {
  it('grows from the row’s vertical centre on the edge nearest the parent', () => {
    const row = rowAt(2)
    const box = placeBeside(row, parent, viewport, size)
    const y = row.y + row.height / 2 - (row.y - PANEL_INSET)
    expect(besideOrigin(row, box, viewport, 200)).toBe(`0 ${y}px`)
  })

  it('uses the trailing edge when the panel stands before its parent, and counts from the top of a flipped panel', () => {
    const wide: Rect = {
      ...parent,
      x: viewport.width - POPOVER_MARGIN - 100 - parent.width,
      y: 600
    }
    const row: Rect = { ...rowAt(0), x: wide.x + 5, y: 900 }
    const box = placeBeside(row, wide, viewport, size)
    expect(box.side).toBe('above')
    expect(box.edge).toBe('before')
    const top = viewport.height - (box as { bottom: number }).bottom - 200
    const y = row.y + row.height / 2 - top
    expect(besideOrigin(row, box, viewport, 200)).toBe(`100% ${y}px`)
  })
})

describe('layoutRect and rowRect', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('read a panel’s offsets and a row’s inside it, the panel’s border and scroll accounted for', () => {
    document.body.innerHTML = `<div id="panel"><button id="row">Row</button></div>`
    const panel = document.getElementById('panel') as HTMLElement
    const row = document.getElementById('row') as HTMLElement
    // happy-dom lays nothing out: the offsets are stubbed to what a laid-out panel reports.
    const stub = (el: HTMLElement, values: Record<string, number>): void => {
      for (const [k, v] of Object.entries(values))
        Object.defineProperty(el, k, { value: v, configurable: true })
    }
    stub(panel, {
      offsetLeft: 300,
      offsetTop: 36,
      offsetWidth: 260,
      offsetHeight: 320,
      clientLeft: 1,
      clientTop: 1,
      scrollTop: 62
    })
    stub(row, { offsetLeft: 4, offsetTop: 4 + 3 * 31, offsetWidth: 250, offsetHeight: 31 })
    const panelBox = layoutRect(panel)
    expect(panelBox).toEqual({ x: 300, y: 36, width: 260, height: 320 })
    expect(rowRect(row, panel, panelBox)).toEqual({
      x: 300 + 1 + 4,
      y: 36 + 1 + 4 + 93 - 62,
      width: 250,
      height: 31
    })
  })
})
