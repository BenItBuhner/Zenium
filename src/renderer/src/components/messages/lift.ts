import type { Toast } from '@renderer/lib/ui'

/**
 * Which seat the phone's toasts take while a sheet stands (v2 draft §9.33): a message raised
 * by an act taken in an open sheet stands above that sheet for its clock, 8 over the sheet's
 * edge, where the sheet's own Undo can be reached; the chassis rule that seats messages under
 * sheets is for messages the sheet did not cause. So a toast remembers whether a sheet stood as
 * it was raised – "born under" a sheet – and the frame that holds the toasts lifts above the
 * sheet host while the toast leading the slot was born under a sheet and a sheet still stands.
 *
 * The rule is by birth, not by the moment (Chrome's is by the moment: `SnackbarManager`'s
 * BOTTOM_SHEET parent override re-parents whatever snackbar is showing into the sheet while it
 * is at HALF or FULL, a snackbar up before the sheet included – `ChromeActivitySnackbarHelper`,
 * 152.0.7977.89). A toast raised before the sheet opened keeps its place under it and is not
 * re-parented mid-life; once no sheet stands the lifted frame comes back to the layer's normal
 * seat with the toast still up on its clock, the way Chrome's pop of the override puts the
 * snackbar back on the activity for what is left of its time – and from there the toast is a
 * toast raised before any sheet that opens next, and stays under it (`ground`). A sheet that
 * stood under the one whose act raised the toast (§9.24's depth two) keeps it lifted: a sheet
 * has stood the whole while, and the Undo stays in reach over it.
 */
export interface LiftLedger {
  /**
   * Stamp the toasts not seen before with whether a sheet stands right now; toasts gone from
   * the list are forgotten. Called as the toasts change, with the depth of the moment.
   */
  stamp(toasts: ReadonlyArray<Pick<Toast, 'id'>>, sheetStands: boolean): void
  /**
   * No sheet stands any more: every toast up is seated normally from here, and stays there
   * under a sheet that opens later – that sheet did not cause it. Called as the stack empties.
   */
  ground(): void
  /**
   * Whether a sheet stood as the toast was raised and one has stood since (false for a toast
   * never stamped).
   */
  bornUnder(id: number): boolean
}

/** A ledger of the toasts' births, one per frame that seats toasts. */
export function createLiftLedger(): LiftLedger {
  const births = new Map<number, boolean>()
  return {
    stamp(toasts, sheetStands) {
      const present = new Set<number>()
      for (const t of toasts) {
        present.add(t.id)
        if (!births.has(t.id)) births.set(t.id, sheetStands)
      }
      for (const id of births.keys()) if (!present.has(id)) births.delete(id)
    },
    ground() {
      for (const id of births.keys()) births.set(id, false)
    },
    bornUnder(id) {
      return births.get(id) ?? false
    }
  }
}

/**
 * Whether the frame that holds the toasts stands lifted above the sheet host: a sheet stands,
 * and the toast leading the slot – the live one, else the newest on its way out – was born
 * under a sheet. One frame, one seat: a toast on its way out as a born-under toast arrives
 * rides up for its leave, and a born-free one leaving as the sheet's toast arrives likewise (the
 * slot holds one live toast, so the two overlap only for a leave).
 */
export function toastsLifted(
  toasts: ReadonlyArray<Pick<Toast, 'id' | 'leaving'>>,
  bornUnder: (id: number) => boolean,
  sheetStands: boolean
): boolean {
  if (!sheetStands) return false
  const lead = toasts.find((t) => !t.leaving) ?? toasts.at(-1)
  return lead !== undefined && bornUnder(lead.id)
}
