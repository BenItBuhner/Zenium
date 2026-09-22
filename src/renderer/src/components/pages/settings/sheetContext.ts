import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

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

/**
 * The sheet's footer slot (§9.11), outside the body that scrolls: a form whose body is a long
 * list (the site-data viewer's thousand origins) puts the actions that belong to the whole sheet
 * there through `SheetFooter` (blocks.tsx), where they stay in reach however far the list has
 * scrolled. The chassis draws the footer only while something claims it, so a form without one
 * keeps the body's 16 as its end. `null` outside a Settings sheet or dialog: the actions then
 * draw in place.
 */
export interface SheetFooterSlot {
  /** The footer's element once the chassis has drawn it; null until a claim brought it up. */
  element: HTMLElement | null
  /** Ask the chassis for the footer; the function returned gives it back. */
  claim(): () => void
}

export const SheetFooterContext = createContext<SheetFooterSlot | null>(null)

/**
 * The chassis's half of the slot (`SettingsSheet`, `SettingsDialog`): how many claim the footer
 * and the element once drawn. `claim` is stable, so a claimant's effect runs once; the element
 * is read at render, so the portal follows it up.
 */
export function useSheetFooterSlot(): {
  slot: SheetFooterSlot
  claimed: boolean
  setElement(element: HTMLElement | null): void
} {
  const [claims, setClaims] = useState(0)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const claim = useCallback((): (() => void) => {
    setClaims((n) => n + 1)
    return () => setClaims((n) => n - 1)
  }, [])
  const slot = useMemo<SheetFooterSlot>(() => ({ element, claim }), [element, claim])
  return { slot, claimed: claims > 0, setElement }
}

/**
 * Tells the Settings dialog a component sits in that a dialog of the component's own stands
 * over it – a form's confirmation, a picker over a form – so it goes `inert` for the while
 * (§9.24), as one the page's stack opened over it would. Provided by `SettingsDialog`, which
 * reads its own parent's as it mounts, so a dialog nested in a dialog covers it with no call
 * from the form; on the phone the sheet chassis recedes and covers the lower sheet by itself.
 */
export const SheetCoveredContext = createContext<((covered: boolean) => void) | null>(null)

/** While `open`, the enclosing Settings dialog stands covered. */
export function useCoversSheet(open: boolean): void {
  const setCovered = useContext(SheetCoveredContext)
  useEffect(() => {
    if (!open || !setCovered) return
    setCovered(true)
    return () => setCovered(false)
  }, [open, setCovered])
}
