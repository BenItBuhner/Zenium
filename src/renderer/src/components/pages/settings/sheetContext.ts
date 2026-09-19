import { createContext, useContext } from 'react'

/**
 * The function that dismisses the Settings sheet a component sits in (with the sheet's motion;
 * the stack drops the request once the motion has ended). Provided by `SettingsSheet`, read by
 * the forms a sheet renders, so that a form's Cancel closes its sheet without holding its handle.
 */
export const SheetDismissContext = createContext<() => void>(() => undefined)

export function useSheetDismiss(): () => void {
  return useContext(SheetDismissContext)
}

/**
 * Asks the Settings sheet a component sits in to measure its detents again: a form whose body
 * changed height after the sheet opened (more rows shown, a field appeared) calls it, the way an
 * item sheet's row count changes its `contentKey`. Provided by `SettingsSheet`.
 */
export const SheetRelayoutContext = createContext<() => void>(() => undefined)

export function useSheetRelayout(): () => void {
  return useContext(SheetRelayoutContext)
}
