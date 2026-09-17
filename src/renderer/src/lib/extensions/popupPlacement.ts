import type { Rect } from '@shared/types'

/** A panel (design-language v2 draft §2): radius 8, 8px below the trigger (v1 §8.1 gap). */
export const POPUP_RADIUS = 8
export const POPUP_GAP = 8
/**
 * The frame around the extension's document: a 1px ring of panel colour, so the view sits at
 * the concentric radius 7 (inner = outer − padding, floor 2) inside the frame's hairline border.
 */
export const POPUP_PADDING = 1
/** The concentric rule's floor. */
export const RADIUS_FLOOR = 2
/** Distance from the window edge the frame keeps. */
export const POPUP_MARGIN = 8
/** How far into the frame's leading edge the trigger's centre lands (its "first 40px"). */
export const POPUP_ANCHOR_INSET = 20

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
  /** The toolbar button, in window coordinates. */
  anchor: Rect
  /** The document's preferred size (CSS px); null until it reported one. */
  content: PopupSize | null
  viewport: PopupSize
  padding?: number
  gap?: number
  margin?: number
}

export interface AnchoredRect extends Rect {
  side: 'left' | 'right'
}

/**
 * A desktop panel under its trigger: `gap` below it with the trigger's centre `inset` into the
 * panel's leading edge, hanging from the panel's right edge
 * instead when the left alignment would leave the window, and kept `margin` from every edge.
 */
export function anchorBelow(
  anchor: Rect,
  size: PopupSize,
  viewport: PopupSize,
  { gap = POPUP_GAP, margin = POPUP_MARGIN, inset = POPUP_ANCHOR_INSET } = {}
): AnchoredRect {
  const centre = anchor.x + anchor.width / 2
  let left = centre - inset
  let side: AnchoredRect['side'] = 'left'
  if (left + size.width > viewport.width - margin) {
    left = centre + inset - size.width
    side = 'right'
  }
  left = Math.round(clamp(left, margin, Math.max(margin, viewport.width - margin - size.width)))
  let top = anchor.y + anchor.height + gap
  if (top + size.height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - margin - size.height)
  }
  return { x: left, y: Math.round(top), width: size.width, height: size.height, side }
}

/**
 * Where an action popup goes: a panel 8px below its button with the button's centre inside the
 * frame's first 40px, hanging from the frame's right edge instead when the left alignment would
 * leave the window, clamped to the window and to Chrome's popup limits.
 */
export function placePopup({
  anchor,
  content,
  viewport,
  padding = POPUP_PADDING,
  gap = POPUP_GAP,
  margin = POPUP_MARGIN
}: PopupPlacementInput): PopupPlacement {
  const size = content ?? POPUP_DEFAULT
  const maxInnerWidth = Math.max(
    POPUP_MIN.width,
    Math.min(POPUP_MAX.width, viewport.width - 2 * margin - 2 * padding)
  )
  const innerWidth = Math.round(clamp(size.width, POPUP_MIN.width, maxInnerWidth))
  const top = anchor.y + anchor.height + gap
  const maxInnerHeight = Math.max(
    POPUP_MIN.height,
    Math.min(POPUP_MAX.height, viewport.height - top - margin - 2 * padding)
  )
  const innerHeight = Math.round(clamp(size.height, POPUP_MIN.height, maxInnerHeight))
  const width = innerWidth + 2 * padding
  const height = innerHeight + 2 * padding

  const { side, ...frame } = anchorBelow(anchor, { width, height }, viewport, { gap, margin })
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
