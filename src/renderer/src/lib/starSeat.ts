import type { Rect } from '@shared/types'
import { POPOVER_MARGIN, viewportSize } from './portals'

/** The star chip's box in the pill: §9.3's 28 icon button. */
const STAR_SEAT = 28

/** Where the star bubble hangs from, and the pill it hangs under (null with no pill on screen). */
export interface StarSeat {
  anchor: Rect
  pill: Rect | null
}

/** An element's box in viewport coordinates, or null for one not laid out (`display: none`). */
function boxOf(el: Element | null | undefined): Rect | null {
  const r = el?.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * Where the star bubble hangs from, measured as the request arrives (v2 §9.20: the bubble's
 * top edge is the pill's bottom edge, end-aligned with the star in it). The star folds out of
 * the pill under the width tier (`pillChipTiers.ts`) and under the 240 sidebar's container
 * query (`.zen-pill-chip`, main.css), so when Ctrl+D or the app menu's Bookmark This Tab asks
 * there is often no star on screen: the bubble then hangs from the star's SEAT – the 28 box at
 * the pill's trailing end, where the chip sits when the pill has room – still flush under the
 * pill, over the address it speaks for, rather than floating in the window's corner. With no
 * pill in the row (the compact column) the seat is the ⋯ button, where the folded Bookmark This
 * Tab lives; with nothing at all, the window's top trailing corner.
 */
export function starSeat(): StarSeat {
  const chip = document.querySelector('[data-bm-star]')
  const pill = boxOf(chip?.closest('.zen-pill') ?? document.querySelector('.zen-pill'))
  const star = boxOf(chip)
  if (star) return { anchor: star, pill }
  if (pill) {
    return {
      anchor: {
        x: pill.x + pill.width - STAR_SEAT,
        y: pill.y + (pill.height - STAR_SEAT) / 2,
        width: STAR_SEAT,
        height: STAR_SEAT
      },
      pill
    }
  }
  const menu = boxOf(document.querySelector('[data-zen-app-menu-button]'))
  if (menu) return { anchor: menu, pill: null }
  const viewport = viewportSize()
  return {
    anchor: {
      x: viewport.width - POPOVER_MARGIN - STAR_SEAT,
      y: STAR_SEAT,
      width: STAR_SEAT,
      height: STAR_SEAT
    },
    pill: null
  }
}
