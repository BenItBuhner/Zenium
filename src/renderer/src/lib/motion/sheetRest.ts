import { createContext, useContext } from 'react'

/**
 * The box the sheet's body (its scroller) has when the sheet stands at the detent it rests at
 * or heads for: what a body that lays itself out for the sheet's rest works from – the picture's
 * fit in the long-screenshot editor – so that it is computed once per detent, never from the
 * body's live height as the sheet moves between its detents. The chassis (`BottomSheet`)
 * animates the sheet's height per frame; a body fitted to each frame would zoom on the way up,
 * and lay itself out per frame (§11.1: content anchored to the top edge as the sheet rises; the
 * perf rule: no layout per frame). The width is the body's; the height is the detent less the
 * grip, the footer and the bottom inset, which stand at every height of the sheet.
 */
export interface SheetRest {
  bodyWidth: number
  bodyHeight: number
}

/** Provided by the chassis around the body; a new value per measure and per resting detent. */
export const SheetRestContext = createContext<SheetRest | null>(null)

/**
 * The rest of the sheet the caller renders in (a new value when the detents are measured again or
 * the sheet heads for its other detent); null outside a sheet, or before its first measure.
 */
export function useSheetRest(): SheetRest | null {
  return useContext(SheetRestContext)
}
