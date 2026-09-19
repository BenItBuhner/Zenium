/**
 * The open bottom sheets, bottom to top (design language v2 §9.24, §11.2). A sheet mounting
 * while another is up is the upper of a pair: its progress drives the lower's scrim, recede and
 * inertness, and the page keeps the recede the lower gave it. Depth two is the rule's limit; a
 * third sheet would treat the second as its lower all the same. `BottomSheet` is the one writer.
 */

/**
 * An open sheet as the stack knows it: its elements, the share of its own scrim its motion last
 * wrote (`share`, 0…1) and how far the sheet above it has come up (`covered`, 0…1) – its scrim
 * shows `share × (1 − covered)`, whichever of the two motions wrote a frame last.
 */
export interface OpenSheet {
  sheet: HTMLElement
  scrim: HTMLElement
  share: number
  covered: number
}

const openSheets: OpenSheet[] = []

/** Put a sheet on the stack; returns the sheet it opened over, if any. */
export function pushSheet(entry: OpenSheet): OpenSheet | null {
  const below = openSheets[openSheets.length - 1] ?? null
  openSheets.push(entry)
  return below
}

export function removeSheet(entry: OpenSheet): void {
  const at = openSheets.indexOf(entry)
  if (at !== -1) openSheets.splice(at, 1)
}

/** How many sheets are up, for the tests. */
export function openSheetCount(): number {
  return openSheets.length
}
