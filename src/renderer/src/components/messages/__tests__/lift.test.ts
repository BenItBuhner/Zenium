import { describe, expect, it } from 'vitest'
import { createLiftLedger, toastsLifted } from '../lift'

/*
 * The seat of the phone's toasts while a sheet stands (v2 draft §9.33, ruled on #637): a
 * toast raised by an act taken in an open sheet stands above that sheet for its clock; the
 * chassis rule that seats messages under sheets is for messages the sheet did not cause. The
 * ledger stamps each toast with whether a sheet stood as it was raised; the frame lifts while
 * the toast leading the slot was born under a sheet and one still stands, comes back to the
 * normal seat as the stack empties, and does not lift again for a sheet that opens later.
 */

const t = (id: number, leaving = false): { id: number; leaving?: boolean } =>
  leaving ? { id, leaving } : { id }

describe('the lift ledger', () => {
  it('stamps a toast once, with the depth of the moment it is raised', () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], true)
    // A later look while no sheet stands does not re-stamp it.
    ledger.stamp([t(1)], false)
    expect(ledger.bornUnder(1)).toBe(true)
    ledger.stamp([t(1), t(2)], false)
    expect(ledger.bornUnder(2)).toBe(false)
    // And a toast stamped free stays free under a sheet that opens after it.
    ledger.stamp([t(1), t(2)], true)
    expect(ledger.bornUnder(2)).toBe(false)
  })

  it('knows nothing of a toast never stamped, and forgets one that has gone', () => {
    const ledger = createLiftLedger()
    expect(ledger.bornUnder(9)).toBe(false)
    ledger.stamp([t(1)], true)
    ledger.stamp([], true)
    // Gone and back under the same id (the ids never repeat in the app; here it shows the drop).
    ledger.stamp([t(1)], false)
    expect(ledger.bornUnder(1)).toBe(false)
  })

  it('grounds every toast up when the stack empties: a later sheet did not cause them', () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], true)
    ledger.ground()
    expect(ledger.bornUnder(1)).toBe(false)
    expect(toastsLifted([t(1)], ledger.bornUnder, true)).toBe(false)
  })
})

describe('the toast frame lifted above the sheet host', () => {
  it('lifts for a toast raised while a sheet stands, for as long as one stands', () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], true)
    expect(toastsLifted([t(1)], ledger.bornUnder, true)).toBe(true)
    // The sheet has landed away: the normal seat, the toast still up.
    expect(toastsLifted([t(1)], ledger.bornUnder, false)).toBe(false)
  })

  it('keeps a toast raised before the sheet opened under it', () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], false)
    expect(toastsLifted([t(1)], ledger.bornUnder, true)).toBe(false)
    expect(toastsLifted([t(1)], ledger.bornUnder, false)).toBe(false)
  })

  it('has no seat to lift with nothing up', () => {
    const ledger = createLiftLedger()
    expect(toastsLifted([], ledger.bornUnder, true)).toBe(false)
  })

  it("follows the live toast: the sheet's toast lifts the slot as an earlier one leaves", () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], false)
    // The sheet's act raises a toast: the earlier one is sent off and the new one is live.
    ledger.stamp([t(1, true), t(2)], true)
    expect(toastsLifted([t(1, true), t(2)], ledger.bornUnder, true)).toBe(true)
    // Its own leave, with nothing live behind it, keeps the seat it stood in.
    expect(toastsLifted([t(2, true)], ledger.bornUnder, true)).toBe(true)
  })

  it("seats by the live toast when the sheet's toast is the one leaving", () => {
    const ledger = createLiftLedger()
    ledger.stamp([t(1)], true)
    // A toast raised after the sheet closed, as the sheet's own is still on its way out, then a
    // new sheet: neither was raised by it.
    ledger.ground()
    ledger.stamp([t(1, true), t(2)], false)
    expect(toastsLifted([t(1, true), t(2)], ledger.bornUnder, true)).toBe(false)
  })
})
