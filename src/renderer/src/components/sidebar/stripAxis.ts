import { createContext, useContext } from 'react'

/** The axis a tab list lays its rows along: the sidebar's column (`y`) or the strip's row (`x`). */
export type StripAxis = 'x' | 'y'

/**
 * The axis of the list a row is drawn in (design language v2 §9.37): the sidebar's rows run
 * down (`y`, the default, so every list that says nothing is as it was); the horizontal strip
 * lays the same rows along the caption band (`x`). A row reads it to turn what depends on the
 * axis – its drop halves, its indent, its trailing slot's form – and nothing else: the row's
 * favicon, title, fills and buttons are the sidebar's on either axis.
 */
export const StripAxisContext = createContext<StripAxis>('y')

export function useStripAxis(): StripAxis {
  return useContext(StripAxisContext)
}
