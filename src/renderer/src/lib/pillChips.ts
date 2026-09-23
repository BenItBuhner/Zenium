/*
 * The phone pill's chips at rest (OMN-02; design language v2 §9.29 as amended 2026-09-20 on
 * Bennett's ruling over the crowded bar).
 *
 * The phone pill does not tier, it is fixed: at rest it carries the favicon, the host and ONE
 * site-information glyph – the lock, or the mask on a private tab (§9.19) – and nothing else.
 * Every informational chip the pill used to carry (the blocking shield with its count, #115;
 * the translate offer, #106) is a row in the site-information sheet ALWAYS, not only when room
 * runs out: the count goes on the shield's row inside the sheet, Chrome's model, where the pill
 * carries only the security icon. With four chips up the host had about 50 px on a 412 phone
 * and read "githu…" (#237's audit, Bennett's screenshot); with the lock alone it keeps about
 * 200, never under 150.
 *
 * Transient state chips – Now playing or Media paused (§9.33's media chip, #233), a
 * save-password or save-address key – are the exception and the only one: a state chip shows
 * while its state is live and TAKES THE GLYPH SLOT'S ROOM, so the lock gives way to it and
 * returns when the state ends. Two states never stack: the newer one shows and the older waits
 * in the sheet as a row, coming back to the pill when the newer ends. A state chip is never
 * informational (a blocked count and an offer are not states).
 *
 * So the fold is a rule per chip, not a width computation: this module is that rule, pure and
 * deterministic; `components/phone/pillChips.tsx` builds the chips, remembers the states' order
 * of arrival and draws what stays.
 */

/**
 * How a chip of the phone pill relates to the pill at rest.
 * - `glyph`: the site-information glyph – the pill's anatomy; never a sheet row, gives way to a
 *   live state chip and returns when the state ends.
 * - `sheet`: an informational chip – always in the site-information sheet, never in the pill.
 * - `live`: a transient state chip – in the pill while its state is live, in the glyph's slot.
 */
export type PillChipFold = 'glyph' | 'sheet' | 'live'

export interface PillChipFoldSpec {
  /** A stable id (`lock` and the glyph's other states, `blocked`, `translate`, `media`, `save-prompt`). */
  id: string
  fold: PillChipFold
}

export interface PillFold<T extends PillChipFoldSpec> {
  /** The chips the pill draws after the host, in the order they were given: the glyph, or the one live state chip. */
  shown: T[]
  /** The chips the site-information sheet lists, in the order they were given: the informational chips, and a live state waiting behind a newer one. */
  folded: T[]
  /** The glyph while a live state has its slot: neither drawn nor listed (the sheet's title carries the connection, the favicon still opens the sheet). */
  yielded: T[]
}

/**
 * The fold each of the pill's known chips takes; an unknown id is informational and folds. The
 * glyph has one id per connection state (ERR-09: the lock, the open lock of a plain http page,
 * the triangle of a failed certificate, the shield of a Safe Browsing verdict) so that a
 * navigation changing the verdict cross-fades the slot; each is the one glyph and folds alike.
 */
export const PILL_CHIP_FOLDS: Readonly<Record<string, PillChipFold>> = {
  lock: 'glyph',
  'not-secure': 'glyph',
  'certificate-error': 'glyph',
  dangerous: 'glyph',
  blocked: 'sheet',
  translate: 'sheet',
  'save-prompt': 'live',
  media: 'live'
}

/** The fold of a chip by id, for a chip built without one. */
export function pillChipFold(id: string): PillChipFold {
  return PILL_CHIP_FOLDS[id] ?? 'sheet'
}

/**
 * The live states' order of arrival, oldest first, carried from one set of live chips to the
 * next: a state still live keeps its place, a state that ended leaves, a new one joins at the
 * end – so the newest is always last, whatever order the chips come in. Pure: the caller keeps
 * the result and passes it back with the next set.
 */
export function liveArrival(previous: readonly string[], live: readonly string[]): string[] {
  const kept = previous.filter((id) => live.includes(id))
  const fresh = live.filter((id) => !previous.includes(id))
  return [...kept, ...fresh]
}

/** Which of the live chips shows: the newest by arrival; a chip the record does not know yet is newer than any it does. */
function newestLive<T extends PillChipFoldSpec>(live: readonly T[], arrival: readonly string[]): T {
  let newest = live[0]!
  let rank = arrival.indexOf(newest.id)
  for (const chip of live.slice(1)) {
    const r = arrival.indexOf(chip.id)
    // Unknown (-1) beats every known rank; among unknowns the later given wins.
    if (rank === -1 ? r === -1 : r === -1 || r > rank) {
      newest = chip
      rank = r
    }
  }
  return newest
}

/**
 * Fold the pill's chips (§9.29): with no live state the glyph stays and every informational
 * chip goes to the sheet; with a live state the newest one – by `arrival`, the record
 * {@link liveArrival} keeps; without a record, the order given – takes the glyph's slot, the
 * glyph gives way, and any older live state waits in the sheet as a row. Nothing about the
 * pill's width comes into it – the same set folds the same way at every width and font scale.
 */
export function foldPillChips<T extends PillChipFoldSpec>(
  chips: readonly T[],
  arrival: readonly string[] = chips.filter((c) => c.fold === 'live').map((c) => c.id)
): PillFold<T> {
  const live = chips.filter((c) => c.fold === 'live')
  if (live.length === 0) {
    return {
      shown: chips.filter((c) => c.fold === 'glyph'),
      folded: chips.filter((c) => c.fold === 'sheet'),
      yielded: []
    }
  }
  const newest = newestLive(live, arrival)
  return {
    shown: [newest],
    folded: chips.filter((c) => c.fold === 'sheet' || (c.fold === 'live' && c !== newest)),
    yielded: chips.filter((c) => c.fold === 'glyph')
  }
}
