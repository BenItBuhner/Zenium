import type { ContentCover } from '@shared/types'

/** Space between a card and the frame's edge (`--zen-message-inset`). */
export const MESSAGE_INSET = 8

/**
 * Stacked banners touch (v2 §9.21: a list of rows has no gap, the room around a control is the
 * row's own padding), overlapping by their hairline so the seam is one line, not two.
 */
export const STACK_GAP = -1

/**
 * Where each banner of a stack sits, from the top: the newest (first) at 0, the older ones
 * pushed down by everything above them. Cards whose height is not measured yet take no room.
 */
export function bannerSlots(heights: number[], gap = STACK_GAP): { y: number[]; height: number } {
  const y: number[] = []
  let cursor = 0
  for (const h of heights) {
    y.push(cursor)
    if (h > 0) cursor += h + gap
  }
  return { y, height: cursor > 0 ? cursor - gap : 0 }
}

/**
 * The strips of the content area that the messages cover: each stack's height plus the inset
 * on either side, so the page ends clear of the cards.
 */
export function coverFor(bannerStack: number, toast: number, inset = MESSAGE_INSET): ContentCover {
  return {
    top: bannerStack > 0 ? bannerStack + 2 * inset : 0,
    bottom: toast > 0 ? toast + 2 * inset : 0
  }
}
