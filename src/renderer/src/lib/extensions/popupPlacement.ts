import type { Rect } from '@shared/types'
import type { Anchor } from '../anchor'

/** A panel (design-language v2 draft §2): radius 8. */
export const POPUP_RADIUS = 8
/**
 * The frame around the extension's document: a 1px ring of panel colour, so the view sits at
 * the concentric radius 7 (inner = outer − padding, floor 2) inside the frame's hairline border.
 */
export const POPUP_PADDING = 1
/** The concentric rule's floor. */
export const RADIUS_FLOOR = 2
/** Distance from the window edge a popover keeps (§9.20). */
export const POPUP_MARGIN = 8
/**
 * Zenium's own popovers are one of three widths, chosen by content and never fitted to it
 * (§9.20): 320 for a list without trailing controls, a notice or a single action; 400 for rows
 * with trailing controls, forms and descriptions that wrap; 480 only for two columns or a table.
 * An extension's own popup document keeps the size it asks for.
 */
export const POPOVER_WIDTH = { list: 320, form: 400, table: 480 } as const

/** Chrome's popup limits (CSS px). */
export const POPUP_MIN = { width: 25, height: 25 }
export const POPUP_MAX = { width: 800, height: 600 }
/** Size to open at before the document has reported its own. */
export const POPUP_DEFAULT = { width: 380, height: 280 }

export interface PopupSize {
  width: number
  height: number
}

export interface PopupPlacement {
  /** The panel the renderer draws. */
  frame: Rect
  /** Where the WebContentsView sits, in the same (window) coordinates. */
  inner: Rect
  radius: number
  innerRadius: number
  /** The frame hangs from its left or its right edge, depending on where the trigger is. */
  side: 'left' | 'right'
}

export interface PopupPlacementInput {
  /** The toolbar button, in window coordinates, with the bar it sits in when known. */
  anchor: Anchor
  /** The document's preferred size (CSS px); null until it reported one. */
  content: PopupSize | null
  viewport: PopupSize
  padding?: number
  margin?: number
}

export interface AnchoredRect extends Rect {
  side: 'left' | 'right'
}

/**
 * A desktop popover under its anchor (§9.20): its top flush with the bottom edge of the bar the
 * anchor sits in (gap 0; under the anchor's own box when it sits in no bar), no arrow and no
 * offset. Its start edge aligns with the anchor's; an anchor in the trailing half of its bar
 * end-aligns instead. Either alignment gives way to the other when it would leave the window,
 * as XUL panels flip, and the result is clamped `margin` inside the window on every side.
 */
export function anchorBelow(
  anchor: Anchor,
  size: PopupSize,
  viewport: PopupSize,
  { margin = POPUP_MARGIN } = {}
): AnchoredRect {
  const bar = anchor.bar
  const trailing = bar ? anchor.x + anchor.width / 2 > bar.x + bar.width / 2 : false
  const start = anchor.x
  const end = anchor.x + anchor.width - size.width
  const fits = (left: number): boolean =>
    left >= margin && left + size.width <= viewport.width - margin
  let side: AnchoredRect['side'] = trailing ? 'right' : 'left'
  let left = trailing ? end : start
  if (!fits(left) && fits(trailing ? start : end)) {
    side = trailing ? 'left' : 'right'
    left = trailing ? start : end
  }
  left = Math.round(clamp(left, margin, Math.max(margin, viewport.width - margin - size.width)))
  let top = bar ? bar.y + bar.height : anchor.y + anchor.height
  if (top + size.height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - margin - size.height)
  }
  return { x: left, y: Math.round(top), width: size.width, height: size.height, side }
}

/**
 * Where an action popup goes: the panel flush under the toolbar's bar, start- or end-aligned
 * with its button per §9.20, at the size the document asked for, clamped to the window and to
 * Chrome's popup limits.
 */
export function placePopup({
  anchor,
  content,
  viewport,
  padding = POPUP_PADDING,
  margin = POPUP_MARGIN
}: PopupPlacementInput): PopupPlacement {
  const size = content ?? POPUP_DEFAULT
  const maxInnerWidth = Math.max(
    POPUP_MIN.width,
    Math.min(POPUP_MAX.width, viewport.width - 2 * margin - 2 * padding)
  )
  const innerWidth = Math.round(clamp(size.width, POPUP_MIN.width, maxInnerWidth))
  const top = anchor.bar ? anchor.bar.y + anchor.bar.height : anchor.y + anchor.height
  const maxInnerHeight = Math.max(
    POPUP_MIN.height,
    Math.min(POPUP_MAX.height, viewport.height - top - margin - 2 * padding)
  )
  const innerHeight = Math.round(clamp(size.height, POPUP_MIN.height, maxInnerHeight))
  const width = innerWidth + 2 * padding
  const height = innerHeight + 2 * padding

  const { side, ...frame } = anchorBelow(anchor, { width, height }, viewport, { margin })
  return {
    frame,
    inner: {
      x: frame.x + padding,
      y: frame.y + padding,
      width: innerWidth,
      height: innerHeight
    },
    radius: POPUP_RADIUS,
    innerRadius: Math.max(RADIUS_FLOOR, POPUP_RADIUS - padding),
    side
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
