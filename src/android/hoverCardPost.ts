import type { HoverCardFrame } from '@renderer/lib/hoverCard'

/** What the host receives on `chrome.hoverCard`: a frame to draw, or a take-down. */
export type HoverCardPost = HoverCardFrame | { visible: false }

/**
 * The payload for `chrome.hoverCard` from the controller's frame (TABLET-05; `lib/hoverCard.ts`
 * keeps the card's machine, `Host.kt` draws the card above the live page): the frame itself, or
 * a take-down for `null`. The card is the tablet's by rule as well (the lead's ruling; Chrome's
 * tablet strip is where it raises one): on the phone layout whatever reaches the host goes out
 * as a take-down, so no frame can stand a 320 px card over a phone page whichever host raised
 * it. `phone` is the layout at the moment the frame leaves – read per frame, not at boot, since
 * the layout changes with a fold (a foldable booted closed is a phone, opened a tablet).
 */
export function hoverCardPost(frame: HoverCardFrame | null, phone: boolean): HoverCardPost {
  return frame && !phone ? frame : { visible: false }
}
