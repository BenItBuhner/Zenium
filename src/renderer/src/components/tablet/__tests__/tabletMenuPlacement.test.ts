// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { POPOVER_MARGIN } from '@renderer/lib/portals'
import { menuAloneOverContent, uiStore, type UiState } from '@renderer/lib/ui'
import {
  TABLET_MENU_WIDTH,
  placeCascade,
  placeRootMenu,
  resolveMenuAnchor
} from '../tabletMenuPlacement'

/*
 * The tablet's menus (v2 §9.36) are §9.20 popovers: the app menu hangs from the toolbar's ⋯ –
 * flush under the toolbar row, aligned by the button's half of it – and a context menu stands
 * at the finger's point; a submenu cascades flush beside its parent, level with its row. The
 * geometry is plain functions over rects, tested against a 1280 × 800 tablet window and the 600
 * dp split-screen width.
 */

const LANDSCAPE = { width: 1280, height: 800 }
const SPLIT = { width: 600, height: 1000 }

/** A control in a toolbar row, with the boxes `getBoundingClientRect` reports for them. */
function toolbarControl(box: { x: number; y: number; width: number; height: number }): {
  control: HTMLElement
  bar: HTMLElement
} {
  const bar = document.createElement('div')
  bar.className = 'zen-tablet-toolbar'
  bar.getBoundingClientRect = () => rect({ x: 0, y: 0, width: LANDSCAPE.width, height: 56 })
  const control = document.createElement('button')
  control.getBoundingClientRect = () => rect(box)
  bar.appendChild(control)
  document.body.appendChild(bar)
  return { control, bar }
}

function rect(r: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    left: r.x,
    top: r.y,
    right: r.x + r.width,
    bottom: r.y + r.height,
    toJSON: () => r
  } as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolveMenuAnchor', () => {
  it('hangs the app menu from the ⋯ and its toolbar row when the core echoes its corner', () => {
    const { control } = toolbarControl({ x: 1228, y: 8, width: 40, height: 40 })
    // `showAppMenu` echoes the button's bottom start corner.
    const anchor = resolveMenuAnchor({ x: 1228, y: 48 }, control)
    expect(anchor.kind).toBe('control')
    if (anchor.kind !== 'control') return
    expect(anchor.element).toBe(control)
    expect(anchor.box).toEqual({ x: 1228, y: 8, width: 40, height: 40 })
    expect(anchor.bar).toEqual({ x: 0, y: 0, width: 1280, height: 56 })
  })

  it("is the finger's point when no control opened it, or the control no longer meets the point", () => {
    expect(resolveMenuAnchor({ x: 120, y: 316 }, null)).toEqual({ kind: 'point', x: 120, y: 316 })
    const { control } = toolbarControl({ x: 1228, y: 8, width: 40, height: 40 })
    // A context menu on a tab row while the ⋯ is still recorded from an earlier app menu.
    expect(resolveMenuAnchor({ x: 120, y: 316 }, control)).toEqual({
      kind: 'point',
      x: 120,
      y: 316
    })
    // A control that has left the document anchors nothing.
    control.remove()
    expect(resolveMenuAnchor({ x: 1228, y: 48 }, control)).toEqual({
      kind: 'point',
      x: 1228,
      y: 48
    })
  })

  it('opens at the last press when the descriptor carries no point', () => {
    expect(resolveMenuAnchor({ x: null, y: null }, null, { x: 300, y: 400 })).toEqual({
      kind: 'point',
      x: 300,
      y: 400
    })
  })

  it("falls back to the nearest [data-bar] and then to the control's own box for its bar", () => {
    const bar = document.createElement('div')
    bar.setAttribute('data-bar', '')
    bar.getBoundingClientRect = () => rect({ x: 0, y: 700, width: 600, height: 56 })
    const control = document.createElement('button')
    control.getBoundingClientRect = () => rect({ x: 500, y: 708, width: 40, height: 40 })
    bar.appendChild(control)
    document.body.appendChild(bar)
    const inBar = resolveMenuAnchor({ x: 520, y: 720 }, control)
    expect(inBar.kind === 'control' && inBar.bar).toEqual({ x: 0, y: 700, width: 600, height: 56 })

    const loose = document.createElement('button')
    loose.getBoundingClientRect = () => rect({ x: 100, y: 100, width: 40, height: 40 })
    document.body.appendChild(loose)
    const alone = resolveMenuAnchor({ x: 120, y: 120 }, loose)
    expect(alone.kind === 'control' && alone.bar).toEqual({ x: 100, y: 100, width: 40, height: 40 })
  })
})

describe('placeRootMenu', () => {
  it('puts the app menu flush under the toolbar row, end-aligned with a ⋯ in the trailing half', () => {
    const { control } = toolbarControl({ x: 1228, y: 8, width: 40, height: 40 })
    const anchor = resolveMenuAnchor({ x: 1228, y: 48 }, control)
    const box = placeRootMenu(anchor, 24 * 44 + 10, LANDSCAPE)
    expect(box.side).toBe('below')
    if (box.side !== 'below') return
    expect(box.top).toBe(56)
    expect(box.width).toBe(TABLET_MENU_WIDTH)
    // End edges aligned: the panel ends where the button ends, 12 from the window's edge.
    expect(box.left + box.width).toBe(1268)
    // A long menu is capped at 60% of the window and scrolls (§9.20).
    expect(box.maxHeight).toBe(800 * 0.6)
  })

  it('start-aligns under a control in the leading half of the row', () => {
    const { control } = toolbarControl({ x: 8, y: 8, width: 40, height: 40 })
    const anchor = resolveMenuAnchor({ x: 8, y: 48 }, control)
    const box = placeRootMenu(anchor, 200, LANDSCAPE)
    expect(box.side).toBe('below')
    expect(box.left).toBe(8)
    expect(box.maxHeight).toBe(200)
  })

  it('stands a context menu at the finger, its start edges on the point, below it when it fits', () => {
    const box = placeRootMenu({ kind: 'point', x: 120, y: 316 }, 476, LANDSCAPE)
    expect(box.side).toBe('below')
    if (box.side !== 'below') return
    expect(box.left).toBe(120)
    expect(box.top).toBe(316)
    expect(box.width).toBe(TABLET_MENU_WIDTH)
    expect(box.maxHeight).toBe(476)
  })

  it('ends a context menu on a finger in the trailing half of the window', () => {
    const box = placeRootMenu({ kind: 'point', x: 1100, y: 300 }, 200, LANDSCAPE)
    expect(box.left + box.width).toBe(1100)
  })

  it('flips a context menu above a finger near the bottom of the window', () => {
    const box = placeRootMenu({ kind: 'point', x: 120, y: 700 }, 476, LANDSCAPE)
    expect(box.side).toBe('above')
    if (box.side !== 'above') return
    // Its bottom edge flush with the point.
    expect(box.bottom).toBe(800 - 700)
    expect(box.maxHeight).toBe(476)
  })

  it('keeps its 332 in the 600 dp split-screen width and never crosses the margin', () => {
    const box = placeRootMenu({ kind: 'point', x: 500, y: 200 }, 300, SPLIT)
    expect(box.width).toBe(TABLET_MENU_WIDTH)
    expect(box.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(box.left + box.width).toBeLessThanOrEqual(SPLIT.width - POPOVER_MARGIN)
    // The finger in the trailing half: end edges on the point.
    expect(box.left + box.width).toBe(500)
  })
})

describe('placeCascade', () => {
  it("opens a submenu flush at its parent's end, level with the row that opened it", () => {
    const pos = placeCascade({ left: 120, width: TABLET_MENU_WIDTH }, 360, 5 * 44 + 10, LANDSCAPE)
    expect(pos.left).toBe(120 + TABLET_MENU_WIDTH)
    expect(pos.top).toBe(360)
    expect(pos.maxHeight).toBe(800 - 2 * POPOVER_MARGIN)
  })

  it("takes the parent's start side when its end would cross the window's margin", () => {
    const parentLeft = 1280 - 12 - TABLET_MENU_WIDTH
    const pos = placeCascade({ left: parentLeft, width: TABLET_MENU_WIDTH }, 100, 200, LANDSCAPE)
    expect(pos.left).toBe(parentLeft - TABLET_MENU_WIDTH)
  })

  it('slides up a submenu that would cross the bottom margin', () => {
    const pos = placeCascade({ left: 120, width: TABLET_MENU_WIDTH }, 700, 300, LANDSCAPE)
    expect(pos.top).toBe(800 - POPOVER_MARGIN - 300)
  })

  it('in a window with room on neither side stays inside the margins over its parent', () => {
    // 600 wide: 332 + 332 fits on neither side of a parent at 134; the child lands as far
    // along as the margin allows.
    const pos = placeCascade({ left: 134, width: TABLET_MENU_WIDTH }, 100, 200, SPLIT)
    expect(pos.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(pos.left + TABLET_MENU_WIDTH).toBeLessThanOrEqual(SPLIT.width - POPOVER_MARGIN)
  })
})

describe('menuAloneOverContent', () => {
  const base = (): UiState => uiStore.get()
  const menu = { id: 'm1', source: 'app', items: [] } as unknown as UiState['menu']

  it('is the core menu alone over the page, or over floating chrome that draws no dim either', () => {
    expect(menuAloneOverContent(base())).toBe(false)
    expect(menuAloneOverContent({ ...base(), menu })).toBe(true)
    // A tab row's long-press menu over the tablet's sidebar drawer (the drawer's scrim is the dim).
    expect(menuAloneOverContent({ ...base(), menu, floatingChrome: 1 })).toBe(true)
  })

  it('is not when another overlay is up as well', () => {
    expect(menuAloneOverContent({ ...base(), menu, overlay: 'history' })).toBe(false)
    expect(menuAloneOverContent({ ...base(), menu, drawerOpen: true })).toBe(false)
  })
})
