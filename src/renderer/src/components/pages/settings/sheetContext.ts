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
