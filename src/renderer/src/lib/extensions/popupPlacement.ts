import type { Rect } from '@shared/types'

/** Desktop panel (design-language.md §8.1): radius 16, 8px below the trigger. */
export const POPUP_RADIUS = 16
export const POPUP_GAP = 8
/** The frame around the extension's document; inner radius = 16 − padding stays ≥ 10. */
export const POPUP_PADDING = 6
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

/**
 * Where an action popup goes: a level-3 frame 8px below its button with the button's centre
 * inside the frame's first 40px, hanging from the frame's right edge instead when the left
 * alignment would leave the window, clamped to the window and to Chrome's popup limits.
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

  const centre = anchor.x + anchor.width / 2
  let left = centre - POPUP_ANCHOR_INSET
  let side: PopupPlacement['side'] = 'left'
  if (left + width > viewport.width - margin) {
    left = centre + POPUP_ANCHOR_INSET - width
    side = 'right'
  }
  left = Math.round(clamp(left, margin, Math.max(margin, viewport.width - margin - width)))

  const frame = { x: left, y: Math.round(top), width, height }
  return {
    frame,
    inner: {
      x: frame.x + padding,
      y: frame.y + padding,
      width: innerWidth,
      height: innerHeight
    },
    radius: POPUP_RADIUS,
    innerRadius: Math.max(6, POPUP_RADIUS - padding),
    side
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
