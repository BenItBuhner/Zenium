import { describe, expect, it } from 'vitest'
import { toastSeat } from '../lift'

/*
 * The seat of the phone's toast frame while a sheet stands (v2 draft §9.33, as ruled on #651):
 * a toast up while a sheet stands – raised by an act taken in the sheet, or up already as it
 * opened (Chrome's rule) – stands above the sheet for its clock; the frame lifts for as long as
 * a sheet stands and the slot holds a card, and comes back to the normal seat as the stack
 * empties. Its bottom edge stands at the sheet's own edge, or on the top edge of the sheet's
 * footer band where the top sheet publishes one (the recede registry's `footer`), never over
 * the actions.
 */

describe('the toast frame lifted above the sheet host', () => {
  it('lifts while a sheet stands and the slot holds a card, whichever came first', () => {
    expect(toastSeat(true, true, 0).lifted).toBe(true)
    // The sheet has landed away: the normal seat, the toast still up.
    expect(toastSeat(true, false, 0).lifted).toBe(false)
  })

  it('has no seat to lift with nothing in the slot', () => {
    expect(toastSeat(false, true, 0)).toEqual({ lifted: false, foot: 0 })
    expect(toastSeat(false, false, 0)).toEqual({ lifted: false, foot: 0 })
  })

  it("stands at the sheet's edge for a sheet without a footer band: the card 8 over the edge", () => {
    expect(toastSeat(true, true, 0)).toEqual({ lifted: true, foot: 0 })
  })

  it("stands on the footer band's top edge where the top sheet publishes one, never over the actions", () => {
    // 64: a 56 band on the chassis's 8 (`.zen-sheet-footer`'s 16 + 40 button + 8, `SHEET_EDGE_PAD`).
    expect(toastSeat(true, true, 64)).toEqual({ lifted: true, foot: 64 })
    expect(toastSeat(true, true, 40.5)).toEqual({ lifted: true, foot: 40.5 })
  })

  it('says no foot while not lifted, whatever the registry says: the normal seat is the stylesheet’s', () => {
    expect(toastSeat(true, false, 64)).toEqual({ lifted: false, foot: 0 })
    expect(toastSeat(false, true, 64)).toEqual({ lifted: false, foot: 0 })
  })

  it('takes a footer it cannot stand on as none', () => {
    expect(toastSeat(true, true, -8).foot).toBe(0)
    expect(toastSeat(true, true, Number.NaN).foot).toBe(0)
    expect(toastSeat(true, true, Number.POSITIVE_INFINITY).foot).toBe(0)
  })
})
