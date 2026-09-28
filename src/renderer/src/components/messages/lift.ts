/**
 * The seat of the phone's toast frame while a sheet stands (v2 draft §9.33, as ruled on #651):
 * a message up while a sheet stands – raised by an act taken in the sheet, or up already as it
 * opened – stands above that sheet for its clock, 8 over the sheet's edge and its content and
 * never over its footer's actions; the chassis rule that seats messages under sheets is for the
 * message frame's other cards. So the frame that holds the toast's slot lifts above the sheet
 * host for as long as a sheet stands and the slot holds a card, whichever came first: Chrome's
 * rule (`SnackbarManager`'s BOTTOM_SHEET parent override re-parents whatever snackbar is
 * showing into the sheet while it is at HALF or FULL, a snackbar up before the sheet included –
 * `ChromeActivitySnackbarHelper`, 152.0.7977.89). Once no sheet stands the frame comes back to
 * the layer's normal seat with the toast still up on its clock, the way Chrome's pop of the
 * override puts the snackbar back on the activity for what is left of its time. A sheet stacked
 * over another (§9.24's depth two) keeps the frame lifted over the top one.
 *
 * Where the lifted frame's bottom edge stands is the top sheet's to say: at the sheet's own edge
 * (the inset's line, the card 8 over it) for a sheet whose content runs to its edge, and on the
 * top edge of its footer band for a sheet with actions under its body – the band's height over
 * the chassis's padding, published to the recede registry by the sheet (`RecedeHandle.footer`,
 * `recedeFooter`), so the toast covers content but never a footer's buttons.
 *
 * The same rule seats the desktop's and the tablet's toast while a frame dialog stands (W8-F16,
 * lib/portals.tsx `useToastSeat`): the frame dialog host's seat is the frame, the host's
 * registry – a dialog standing, or a panel on its way out – is the sheet, and the footer is
 * the top dialog's only where it is a hosted sheet with a band (`ownScrim`). One mechanism,
 * two seats; the phone's is `PhoneMessages`'.
 */
export interface ToastSeat {
  /**
   * The frame stands above the sheet host (over the host's layer, out of the page's recede): a
   * sheet stands and the slot holds a card.
   */
  lifted: boolean
  /**
   * What the lifted frame's bottom edge stands over the inset's line by, in px: the top sheet's
   * footer band where it has one, 0 – the sheet's own edge – otherwise, and always 0 while the
   * frame is not lifted (the normal seat is the stylesheet's).
   */
  foot: number
}

/**
 * The toast frame's seat: `held` – the slot holds a card (a toast, live or leaving, or a
 * screenshot's card); `sheetStands` – a sheet is on the chassis's stack; `footer` – the top
 * sheet's footer band as the registry says it (`recedeFooter()`, px; 0 with none).
 */
export function toastSeat(held: boolean, sheetStands: boolean, footer: number): ToastSeat {
  const lifted = held && sheetStands
  return { lifted, foot: lifted && Number.isFinite(footer) && footer > 0 ? footer : 0 }
}
