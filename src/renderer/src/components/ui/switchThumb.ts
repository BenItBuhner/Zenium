/**
 * Geometry of the toggle (design-language.md §8.5): a 44 × 26 track and a 22 thumb, so the thumb
 * rests 2px in from either end.
 */
export const SWITCH_TRACK_WIDTH = 44
export const SWITCH_THUMB_SIZE = 22
export const SWITCH_THUMB_INSET = 2

/** Where the thumb rests for a state, in px from the track's left edge. */
export function switchThumbX(checked: boolean): number {
  return checked ? SWITCH_TRACK_WIDTH - SWITCH_THUMB_SIZE - SWITCH_THUMB_INSET : SWITCH_THUMB_INSET
}
