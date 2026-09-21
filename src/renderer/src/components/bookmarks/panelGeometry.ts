import type { Rect } from '@shared/types'
import {
  POPOVER_HEIGHT_FLOOR,
  POPOVER_MARGIN,
  type PopoverBox,
  type Size
} from '@renderer/lib/portals'

/*
 * Geometry of the bookmarks bar's cascading folder panels (design-language-v2-draft §5 menus,
 * §9.20 placement). The root panel hangs from its chip through `placePopover`; a nested panel
 * stands beside the panel that holds its folder's row, which is what this file places. Pure,
 * so the rules can be tested without a layout; `layoutRect` and `rowRect` read the DOM for it.
 */

/** Which side of its parent panel a nested panel stands on. */
export type BesideEdge = 'after' | 'before'

/**
 * The distance from a menu panel's outer top edge to its first row: the 1 px border and the
 * `.zen-v2-menu` 4 px block padding. A nested panel is offset by it so its first row lines up
 * with the folder row that opened it, as Chrome's and Firefox's submenus do.
 */
export const PANEL_INSET = 5

/**
 * Where a nested panel goes, in viewport coordinates for a `fixed` element (`popoverStyle`
 * turns it into the inline style): flush against its parent panel's trailing edge (gap 0),
 * its first row on the folder row that opened it (`anchor`, `inset` above the row's top).
 * Against the window it follows §9.20's order with `POPOVER_MARGIN`: a panel that would cross
 * the trailing margin flips to the parent's leading side; if neither side fits it slides the
 * least distance inside the margins on the trailing side, still overlapping its parent; wider
 * than the window minus 16 it shrinks to that. Vertically it starts on the row and, when it
 * would cross the bottom margin, flips above – its last row on the row's bottom – when there is
 * more room above than below (or the room below is under `POPOVER_HEIGHT_FLOOR`); otherwise it
 * stays and shrinks to the room left, never taller than the window minus 16. Pure: pass
 * `viewportSize()` for the window.
 */
export function placeBeside(
  anchor: Rect,
  parent: Rect,
  viewport: Size,
  size: Size,
  inset = PANEL_INSET
): PopoverBox & { edge: BesideEdge } {
  const width = Math.max(0, Math.min(size.width, viewport.width - 2 * POPOVER_MARGIN))
  const minLeft = POPOVER_MARGIN
  const maxLeft = viewport.width - POPOVER_MARGIN - width
  const fits = (left: number): boolean => left >= minLeft && left <= maxLeft
  const after = parent.x + parent.width
  const before = parent.x - width
  let edge: BesideEdge = 'after'
  let left: number
  if (fits(after)) left = after
  else if (fits(before)) {
    edge = 'before'
    left = before
  } else left = Math.min(Math.max(minLeft, after), Math.max(minLeft, maxLeft))

  const edgeRoom = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const wanted = Math.max(0, Math.min(size.height, edgeRoom))
  // Start-aligned: the panel's first row on the anchor row's top, never above the margin.
  // End-aligned: its last row on the row's bottom, never under the margin.
  const top = Math.max(POPOVER_MARGIN, anchor.y - inset)
  const bottom = Math.max(POPOVER_MARGIN, viewport.height - (anchor.y + anchor.height + inset))
  const below = Math.max(0, viewport.height - POPOVER_MARGIN - top)
  const above = Math.max(0, viewport.height - POPOVER_MARGIN - bottom)
  const side: PopoverBox['side'] =
    wanted <= below ? 'below' : above > below || below < POPOVER_HEIGHT_FLOOR ? 'above' : 'below'
  const maxHeight = Math.min(wanted, side === 'below' ? below : above)
  return side === 'below'
    ? { side, left, top, width, maxHeight, edge }
    : { side, left, bottom, width, maxHeight, edge }
}

/**
 * The pop's origin for a nested panel (design-language.md §7): it grows out of the folder row
 * that opened it, from the row's vertical centre on the panel's edge nearest its parent.
 */
export function besideOrigin(
  anchor: Rect,
  box: PopoverBox & { edge: BesideEdge },
  viewport: Size,
  height: number
): string {
  const top = box.side === 'below' ? box.top : viewport.height - box.bottom - height
  const y = Math.max(0, Math.min(height, anchor.y + anchor.height / 2 - top))
  return `${box.edge === 'after' ? '0' : '100%'} ${y}px`
}

/**
 * A `fixed` panel's box as laid out – its offsets, which ignore the transform the pop animation
 * scales it by, where the client rect on the animation's first frame would be 6% off.
 */
export function layoutRect(el: HTMLElement): Rect {
  return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
}

/**
 * A row's box in the viewport, from its offsets inside the panel that holds it (`panel`, the
 * row's offset parent and its scroll container) and that panel's own `layoutRect`: the offsets
 * count from the panel's padding edge, so its border (`clientTop` / `clientLeft`) is added back.
 */
export function rowRect(row: HTMLElement, panel: HTMLElement, panelBox: Rect): Rect {
  return {
    x: panelBox.x + panel.clientLeft + row.offsetLeft,
    y: panelBox.y + panel.clientTop + row.offsetTop - panel.scrollTop,
    width: row.offsetWidth,
    height: row.offsetHeight
  }
}
