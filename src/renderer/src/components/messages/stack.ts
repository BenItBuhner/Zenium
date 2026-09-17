import type { ContentCover } from '@shared/types'

/** Space between stacked cards, and between a card and the frame's edge (`--zen-message-gap`). */
export const MESSAGE_GAP = 8

/**
 * Where each banner of a stack sits, from the top: the newest (first) at 0, the older ones
 * pushed down by everything above them. Cards whose height is not measured yet take no room.
 */
export function bannerSlots(heights: number[], gap = MESSAGE_GAP): { y: number[]; height: number } {
  const y: number[] = []
  let cursor = 0
  for (const h of heights) {
    y.push(cursor)
    if (h > 0) cursor += h + gap
  }
  return { y, height: cursor > 0 ? cursor - gap : 0 }
}

/**
 * The strips of the content area that the messages cover: each stack's height plus a gap on
 * either side, so the page ends clear of the cards.
 */
export function coverFor(bannerStack: number, toast: number, gap = MESSAGE_GAP): ContentCover {
  return {
    top: bannerStack > 0 ? bannerStack + 2 * gap : 0,
    bottom: toast > 0 ? toast + 2 * gap : 0
  }
}
