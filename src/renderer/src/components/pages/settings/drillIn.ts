import { createContext, useContext } from 'react'

/**
 * The drill-in pane's way out (`SettingsPage`'s `DrillIn`: the back chevron's press – the pane
 * slides off and `tab.back` runs once it is gone), for a page that leaves on its own: Add
 * language returns as it picks (§10.2, "a tap picking and returning"). Null outside a pane.
 */
export const DrillInBackContext = createContext<(() => void) | null>(null)

/** The enclosing drill-in pane's back, or null (the two-pane layout draws no pane). */
export function useDrillInBack(): (() => void) | null {
  return useContext(DrillInBackContext)
}
