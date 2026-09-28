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
 * A quiet state is the slot's third tenant (§9.29 as amended 2026-09-24 on the design gate for
 * NOT-03): a question the page waits on – the quiet notification ask's bell-off – sits in the
 * slot at rest, in the slot's rest ink (69 %, a stored block's), under a live state and above
 * the connection's glyph, and leaves when the question is answered. It is not live: it does not
 * enter the states' record, a live state folds it to the sheet as a row for as long as the state
 * lasts, and it comes back to the slot when the state ends. The slot's precedence, one glyph at a
 * time: the danger glyph, a live state, a stored site-level block, a quiet request, the
 * connection's own glyph.
 *
 * An offer is the slot's last tenant before the connection's own glyph (CT-37's phone half: the
 * reader indicator, the root's row of 2026-09-27; the design gate rules on its seat): an
 * informational chip the pill ALSO draws while the slot is otherwise quiet – Chrome's reader
 * entry is a toolbar button that appears on a distillable page, Zenium's phone bar has no
 * toolbar slot, so the pill's glyph slot is the seat with the least deviation and the host keeps
 * its 150 px floor. It is the sheet's row ALWAYS (#491's row stays whether or not the pill draws
 * it), takes the slot only when no live or quiet state has it, and never displaces a status
 * glyph: the caller gives it the sheet's fold under a warning or a danger glyph, as it does the
 * quiet bell under danger. The slot's precedence, one glyph at a time: the danger glyph, a live
 * state, a stored site-level block, a quiet request, an offer, the connection's own glyph.
 *
 * So the fold is a rule per chip, not a width computation: this module is that rule, pure and
 * deterministic; `components/phone/pillChips.tsx` builds the chips, remembers the states' order
 * of arrival and draws what stays.
 */

/**
 * How a chip of the phone pill relates to the pill at rest.
 * - `glyph`: the site-information glyph – the pill's anatomy; never a sheet row, gives way to a
 *   live state chip, a quiet one or an offer and returns when it ends.
 * - `sheet`: an informational chip – always in the site-information sheet, never in the pill.
 * - `live`: a transient state chip – in the pill while its state is live, in the glyph's slot.
 * - `quiet`: a quiet state – a question the page waits on (the quiet notification ask); in the
 *   glyph's slot at rest, under a live state (the sheet's row while one is up), above the glyph.
 * - `offer`: an offer – an entry the page makes possible (Reader View on an article); the
 *   sheet's row always, AND in the glyph's slot while no live or quiet state has it, above the
 *   connection's quiet glyph (the caller folds it to `sheet` under a status glyph).
 */
export type PillChipFold = 'glyph' | 'sheet' | 'live' | 'quiet' | 'offer'

export interface PillChipFoldSpec {
  /** A stable id (`lock` and the glyph's other states, `blocked`, `translate`, `reader`, `media`, `save-prompt`). */
  id: string
  fold: PillChipFold
}

export interface PillFold<T extends PillChipFoldSpec> {
  /** The chips the pill draws after the host, in the order they were given: the glyph, or the one live state chip, or the quiet state in its place, or the offer in its place. */
  shown: T[]
  /** The chips the site-information sheet lists, in the order they were given: the informational chips, a live state waiting behind a newer one, a quiet state under a live one, every offer (the drawn one too – its row is the sheet's always). */
  folded: T[]
  /** The glyph while a live or a quiet state has its slot: neither drawn nor listed (the sheet's title carries the connection, the favicon still opens the sheet). */
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
  // Reader View on an article page: §9.29's "reader chip". PUI-14 (#491) made it the sheet's row
  // alone – informational, as the translate offer is – and its design gate held to the fixed
  // pill; CT-37's phone half (the root's row of 2026-09-27) asks the pill for a readerable
  // indicator, so it is the one offer: the sheet's row still, and the glyph slot's while the
  // slot is quiet. The design gate for that PR rules on the seat.
  reader: 'offer',
  'save-prompt': 'live',
  media: 'live',
  // The quiet notification ask (NOT-03): a quiet state, not a live one (the design gate's
  // ruling on §9.29) – the bell-off glyph takes the slot at rest, in the slot's rest ink, and
  // the sheet opens from it; a live state folds it to the sheet for as long as the state lasts.
  // Under a danger glyph the pill folds it to the sheet instead (§9.29's first rule: the
  // identity in question beats every other state) – `phonePillChips` gives the chip that fold.
  'notifications-blocked': 'quiet'
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
 * glyph gives way, and any older live state waits in the sheet as a row. A quiet state has the
 * slot when no live state does – the glyph gives way to it as to a live state – and is the
 * sheet's row while a live state is up; it takes no part in the record, so it never outranks a
 * live state, however it arrived. An offer has the slot when neither a live nor a quiet state
 * does – the glyph gives way to it as to those – and is a row of the sheet whatever has the
 * slot, the pill's included. Nothing about the pill's width comes into it – the same set folds
 * the same way at every width and font scale.
 */
export function foldPillChips<T extends PillChipFoldSpec>(
  chips: readonly T[],
  arrival: readonly string[] = chips.filter((c) => c.fold === 'live').map((c) => c.id)
): PillFold<T> {
  const live = chips.filter((c) => c.fold === 'live')
  const quiet = chips.filter((c) => c.fold === 'quiet')
  // Every offer is the sheet's row, drawn or not: a listing is what the informational fold is.
  const listed = (c: T): boolean => c.fold === 'sheet' || c.fold === 'offer'
  if (live.length === 0) {
    if (quiet.length === 0) {
      const [offer] = chips.filter((c) => c.fold === 'offer')
      if (offer === undefined) {
        return {
          shown: chips.filter((c) => c.fold === 'glyph'),
          folded: chips.filter(listed),
          yielded: []
        }
      }
      // The first offer in the pill's order has the slot; another is a row alone.
      return {
        shown: [offer],
        folded: chips.filter(listed),
        yielded: chips.filter((c) => c.fold === 'glyph')
      }
    }
    // The first quiet state in the pill's order has the slot; another waits as a row.
    const [first] = quiet
    return {
      shown: [first!],
      folded: chips.filter((c) => listed(c) || (c.fold === 'quiet' && c !== first)),
      yielded: chips.filter((c) => c.fold === 'glyph')
    }
  }
  const newest = newestLive(live, arrival)
  return {
    shown: [newest],
    folded: chips.filter(
      (c) => listed(c) || c.fold === 'quiet' || (c.fold === 'live' && c !== newest)
    ),
    yielded: chips.filter((c) => c.fold === 'glyph')
  }
}
