import { createContext, useContext } from 'react'

/**
 * Dismiss the Settings sheet the caller sits in, with the sheet's motion; `after` runs once the
 * sheet has gone, right before the stack drops the request (`BottomSheetHandle.dismiss`).
 */
export type SheetDismiss = (after?: () => void) => void

/**
 * The function that dismisses the Settings sheet a component sits in. Provided by
 * `SettingsSheet`, read by the forms a sheet renders – so that a form's Cancel closes its sheet
 * without holding its handle – and by an action row that opens something of its own over the
 * page (`ActionRow.closesSheet`). `null` outside a sheet.
 */
export const SheetDismissContext = createContext<SheetDismiss | null>(null)

/** The sheet's dismissal; outside a sheet there is nothing to dismiss, and `after` runs at once. */
export function useSheetDismiss(): SheetDismiss {
  const dismiss = useContext(SheetDismissContext)
  return dismiss ?? ((after) => after?.())
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
