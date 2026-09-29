import { TOAST_CARD } from '@shared/toastCard'
import type { ContentCover } from '@shared/types'

/** Space between a card and the frame's edge (`--zen-message-inset`; one number with the page-drawn twin, `@shared/toastCard`). */
export const MESSAGE_INSET: number = TOAST_CARD.insetPx

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

/**
 * The in-product help bubble's width (HintBubbleCard.tsx): §9.20's notice, 320 – one of the
 * three fixed popover widths, never fitted to the sentence – so the words sit on two lines
 * inside its 288 (the lead's (c) on #641). The stylesheet's `.zen-hint-bubble` carries the same
 * numbers; lib/__tests__/v2Tokens.test.ts pins its `width` and `padding` to these two.
 */
export const HINT_BUBBLE_WIDTH = 320

/** The bubble's padding a side: Chrome's 16 dp (`textbubble_text.xml` l.17–23). */
export const HINT_BUBBLE_PADDING = 16

/**
 * The `left` of a bubble `width` wide in §9.20's anchored pose: end-aligned with its anchor –
 * the bubble's right edge on the button's right edge, `anchorEnd` (the chrome is LTR; the Tabs
 * button stands in the bar's trailing half, and an anchor there end-aligns) – then slid the
 * least distance that keeps it `inset` inside the layer on either side (the rule's step 3, no
 * flip: the other alignment would put the bubble past the frame's edge on a phone). A bubble
 * wider than the layer allows sits at the left inset.
 */
export function hintBubbleLeft(
  anchorEnd: number,
  width: number,
  layerWidth: number,
  inset = MESSAGE_INSET
): number {
  const max = Math.max(inset, layerWidth - inset - width)
  return Math.min(max, Math.max(inset, anchorEnd - width))
}

/** A box in the layer's own coordinates. */
export interface LayerBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a bubble stands on a card in the overview (the drag-to-group teaching): §9.20's pose
 * against the card's box, layer coordinates in and out. Across: start-aligned with the card
 * (the rule's (1)); a card whose middle is in the layer's trailing half end-aligns, as an anchor
 * in the trailing half of its bar does; if that crosses the `inset` margin, the other alignment
 * (2); if neither fits, slid the least distance that does (3) – a 320 bubble on a phone's two
 * columns is always that slide, so it reads as centred over the row. Down: flush under the card
 * at gap 0, no arrow, no offset; flipped above it (flush over its top) when the room below is
 * short and the room above is more (the rule's vertical order); otherwise kept below and slid up
 * to fit. Either way the bubble never leaves the card it is about: a card whose bottom the layer
 * clips is the hook's to scroll into view before it asks.
 */
export function hintBubbleOnCard(
  card: LayerBox,
  size: { width: number; height: number },
  layer: { width: number; height: number },
  inset = MESSAGE_INSET
): { left: number; top: number; side: 'below' | 'above' } {
  const trailing = card.x + card.width / 2 > layer.width / 2
  const start = card.x
  const end = card.x + card.width - size.width
  const fits = (left: number): boolean => left >= inset && left + size.width <= layer.width - inset
  const first = trailing ? end : start
  const second = trailing ? start : end
  let left: number
  if (fits(first)) left = first
  else if (fits(second)) left = second
  else left = hintBubbleLeft(first + size.width, size.width, layer.width, inset)

  const below = card.y + card.height
  const roomBelow = layer.height - inset - below
  const roomAbove = card.y - inset
  let side: 'below' | 'above' = 'below'
  let top = below
  if (size.height > roomBelow && roomAbove > roomBelow) {
    side = 'above'
    top = Math.max(inset, card.y - size.height)
  } else if (size.height > roomBelow) {
    top = Math.max(inset, layer.height - inset - size.height)
  }
  return { left, top, side }
}

/**
 * The strip the bubble covers on its edge: the card – flush against the bar band's inner edge at
 * gap 0, so its box starts at the edge – and the inset over it on the page's side.
 */
export function hintCoverFor(height: number, inset = MESSAGE_INSET): number {
  return height > 0 ? height + inset : 0
}
