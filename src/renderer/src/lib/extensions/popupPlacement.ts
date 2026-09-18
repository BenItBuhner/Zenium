import type { Rect } from '@shared/types'
import { placeUnder, type Anchor } from '../anchor'
import type { PopoverAlignment, PopoverBox, Size } from '../portals'

/*
 * The extension popup's surface: what is specific to a document main hosts in a WebContentsView.
 * Where the surface hangs (§9.20: flush under the bar, start- or end-aligned with its button,
 * flipped, slid or shrunk to stay 8 inside the window, above the bar when there is more room
 * there; opened from the puzzle panel, on the panel's alignment while that fits) is
 * `placePopover`'s (lib/portals.tsx), through `placeUnder`, at the measured width and height
 * the manifest asked for – the exemption §9.20 grants an extension's own popup.
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
  /** Hanging below its bar, or flipped above it (§9.20): where the pop grows from. */
  side: PopoverBox['side']
  /** Which of the button's edges the frame lined up with. */
  alignment: PopoverAlignment
  radius: number
  innerRadius: number
}

export interface PopupPlacementInput {
  /** The toolbar button, in window coordinates, with the bar it sits in when known. */
  anchor: Anchor
  /** The document's preferred size (CSS px); null until it reported one. */
  content: Size | null
  viewport: Size
  /**
   * The alignment of the surface this popup replaces on the same button – the puzzle panel's,
   * when the popup was opened from one of its rows (§9.20's continuity clause) – or none for a
   * popup from a pinned button, which takes §9.20's order from its half of the bar.
   */
  alignment?: PopoverAlignment
}

/**
 * Where an action popup goes: the panel flush under the toolbar's bar, start- or end-aligned
 * with its button per §9.20 – or with the puzzle panel it was opened from, while that fits –
 * at the size the document asked for: an extension's popup keeps its manifest's size, within
 * Chrome's 25×25 to 800×600, rather than one of §9.20's three widths or its 60% height, and
 * only the window caps it, at the window minus 16 on either axis, flipping above the bar when
 * the room there is greater. Integer bounds: main sets the view's with them.
 */
export function placePopup({
  anchor,
  content,
  viewport,
  alignment
}: PopupPlacementInput): PopupPlacement {
  const size = content ?? POPUP_DEFAULT
  const padding = POPUP_PADDING
  const asked = {
    width: Math.round(clamp(size.width, POPUP_MIN.width, POPUP_MAX.width)) + 2 * padding,
    height: Math.round(clamp(size.height, POPUP_MIN.height, POPUP_MAX.height)) + 2 * padding
  }
  const box = placeUnder(anchor, { measured: asked.width }, asked.height, viewport, alignment)
  // A window too small for the document shrinks the frame (§9.20's window minus 16); the view
  // still gets Chrome's least size, which only a window under 41px tall could not hold.
  const width = Math.max(POPUP_MIN.width + 2 * padding, Math.round(box.width))
  const height = Math.max(POPUP_MIN.height + 2 * padding, Math.round(box.maxHeight))
  const y = box.side === 'below' ? box.top : viewport.height - box.bottom - height
  const frame = { x: Math.round(box.left), y: Math.round(y), width, height }
  return {
    frame,
    inner: {
      x: frame.x + padding,
      y: frame.y + padding,
      width: width - 2 * padding,
      height: height - 2 * padding
    },
    side: box.side,
    alignment: box.alignment,
    radius: POPUP_RADIUS,
    innerRadius: Math.max(RADIUS_FLOOR, POPUP_RADIUS - padding)
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
