import type { Rect } from '@shared/types'
import { placeUnder, type Anchor } from '../anchor'
import { POPOVER_MARGIN, type Size } from '../portals'

/*
 * The extension popup's surface: what is specific to a document main hosts in a WebContentsView.
 * Where the surface hangs (§9.20: flush under the bar, start- or end-aligned with its button,
 * clamped 8 inside the window) is `placePopover`'s (lib/portals.tsx), through `placeUnder`.
 */

/** A panel (design-language v2 draft §2): radius 8. */
export const POPUP_RADIUS = 8
/**
 * The frame around the extension's document: a 1px ring of panel colour, so the view sits at
 * the concentric radius 7 (inner = outer − padding, floor 2) inside the frame's hairline border.
 */
export const POPUP_PADDING = 1
/** The concentric rule's floor. */
export const RADIUS_FLOOR = 2

/** Chrome's popup limits (CSS px). */
export const POPUP_MIN = { width: 25, height: 25 }
export const POPUP_MAX = { width: 800, height: 600 }
/** Size to open at before the document has reported its own. */
export const POPUP_DEFAULT = { width: 380, height: 280 }

export interface PopupPlacement {
  /** The panel the renderer draws. */
  frame: Rect
  /** Where the WebContentsView sits, in the same (window) coordinates. */
  inner: Rect
  radius: number
  innerRadius: number
}

export interface PopupPlacementInput {
  /** The toolbar button, in window coordinates, with the bar it sits in when known. */
  anchor: Anchor
  /** The document's preferred size (CSS px); null until it reported one. */
  content: Size | null
  viewport: Size
}

/**
 * Where an action popup goes: the panel flush under the toolbar's bar, start- or end-aligned
 * with its button per §9.20, at the size the document asked for – an extension's popup keeps
 * its manifest's size rather than one of §9.20's three widths or its 60% height – clamped to
 * the window and to Chrome's popup limits. Integer bounds: main sets the view's with them.
 */
export function placePopup({ anchor, content, viewport }: PopupPlacementInput): PopupPlacement {
  const size = content ?? POPUP_DEFAULT
  const padding = POPUP_PADDING
  const maxInnerWidth = Math.max(
    POPUP_MIN.width,
    Math.min(POPUP_MAX.width, viewport.width - 2 * POPOVER_MARGIN - 2 * padding)
  )
  const innerWidth = Math.round(clamp(size.width, POPUP_MIN.width, maxInnerWidth))
  const width = innerWidth + 2 * padding
  const box = placeUnder(anchor, width, viewport)
  const top = Math.round(box.top)
  const maxInnerHeight = Math.max(
    POPUP_MIN.height,
    Math.min(POPUP_MAX.height, viewport.height - top - POPOVER_MARGIN - 2 * padding)
  )
  const innerHeight = Math.round(clamp(size.height, POPUP_MIN.height, maxInnerHeight))
  const frame = { x: Math.round(box.left), y: top, width, height: innerHeight + 2 * padding }
  return {
    frame,
    inner: {
      x: frame.x + padding,
      y: frame.y + padding,
      width: innerWidth,
      height: innerHeight
    },
    radius: POPUP_RADIUS,
    innerRadius: Math.max(RADIUS_FLOOR, POPUP_RADIUS - padding)
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
