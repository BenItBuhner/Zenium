/*
 * The phone pill's chip fold (design language v2 §9.29, OMN-02).
 *
 * The pill's chips – the site-information glyph at its start, then the blocked count, the lock,
 * a translate offer, the save prompt's key, the Now playing chip at its end – share the pill's
 * room with the host text. Each is one of §9.3's 44 × 44 boxes laid over a 28 px pitch (20 px of
 * flow under negative margins, plus the row's 8 px gap), so every chip present costs the host
 * 28 px, a chip with a badge some more. With four of them up the host is left about 50 px on a
 * 412 phone and reads "e…" (#237's audit).
 *
 * The rule: the host keeps AT LEAST `PILL_HOST_FLOOR` px. Chips that would take it below that
 * fold into the site-information sheet, the INFORMATIONAL ones first (the lock, the translate
 * offer – what the sheet says anyway) and the STATE-REPORTING ones last (the blocked count, the
 * save prompt's key, the media chip – what only the chip would tell); within a tier in
 * `PILL_FOLD_ORDER`. The site-information glyph is the anchor and never folds: it opens the
 * sheet the others fold into. The floor and the chips hold in px at every font scale (the
 * lead's #237 verdict: controls hold in px; only the text inside them grows), so the same
 * geometry folds the same way at scale 1.0 and 1.3 – the host box stays ≥ 120 px and the text
 * in it truncates sooner.
 *
 * This module is the pure model: what is present, how much each takes, how much there is, and
 * out comes which chips stay and which fold, deterministic for the same inputs. Measuring the
 * pill and drawing the fold is `components/phone/pillChips.tsx`'s.
 */

/** The least the host text keeps in the pill, in px (v2 §9.29). */
export const PILL_HOST_FLOOR = 120

/** The flex gap between the pill's items (`gap-2`): part of what every chip costs the host. */
export const PILL_CHIP_GAP = 8

/** A §9.3 chip's box on the phone. */
export const PILL_CHIP_BOX = 44

/**
 * The pitch chips sit on inside the pill: a 44 box over 20 px of flow (`-mx-3`) plus the gap.
 * The effective exclusive targets that leaves are 28 between two chips, 38 for the leading
 * glyph (the address wins 6 px of its box), 44 for the last chip (#237's measure).
 */
export const PILL_CHIP_PITCH = PILL_CHIP_BOX - 24 + PILL_CHIP_GAP

/**
 * What kind of thing a chip is to the fold: the `anchor` never folds (the site-information
 * glyph, which opens the sheet); `informational` chips fold first (they repeat what the sheet
 * says: the connection's state, that a translation is on offer); `state` chips fold last (they
 * report something the sheet would not otherwise carry: a blocked count, a pending save
 * prompt, playing media).
 */
export type PillChipTier = 'anchor' | 'informational' | 'state'

/** The chip ids the phone pill knows, with the tier each folds in. */
export const PILL_CHIP_TIERS: Readonly<Record<string, PillChipTier>> = {
  'site-info': 'anchor',
  lock: 'informational',
  translate: 'informational',
  blocked: 'state',
  'save-prompt': 'state',
  media: 'state'
}

/**
 * The order chips fold in, first to fold first: §9.29's tiers, and within each the order the
 * rule lists them – the lock before the translate offer; the blocked count, then the save
 * prompt's key, then media. A chip the table does not know folds after the known ones of its
 * tier, in the order given.
 */
export const PILL_FOLD_ORDER: readonly string[] = [
  'lock',
  'translate',
  'blocked',
  'save-prompt',
  'media'
]

export interface PillChipSpec {
  /** A stable id (`lock`, `translate`, `blocked`, `save-prompt`, `media`, `site-info`). */
  id: string
  /** Which tier the chip folds in; defaults to `PILL_CHIP_TIERS[id]`, else `state`. */
  tier?: PillChipTier
  /**
   * What the chip costs the host while it is in the pill, in px: its flow width (the box less
   * the negative margins that lay it over the pitch) plus the row's gap. `pillChipCost` builds
   * it from a measured or intrinsic flow width.
   */
  width: number
}

export interface PillFold {
  /** The ids of the chips that stay in the pill, in the order they were given. */
  shown: string[]
  /** The ids of the chips folded into the site-information sheet, the first to fold first. */
  folded: string[]
  /** The host's room after the fold, in px – under the floor only when nothing more can fold. */
  host: number
}

/** What a chip of flow width `flow` costs the host: the flow and the gap before it. */
export function pillChipCost(flow: number): number {
  return flow + PILL_CHIP_GAP
}

function tierOf(chip: PillChipSpec): PillChipTier {
  return chip.tier ?? PILL_CHIP_TIERS[chip.id] ?? 'state'
}

const TIER_RANK: Record<PillChipTier, number> = { anchor: 2, informational: 0, state: 1 }

/**
 * The chips of `chips` that may fold, first to fold first: informational before state, within a
 * tier by `PILL_FOLD_ORDER`, unknown ids after the known ones in the order given. Anchors are
 * left out. Stable for the same input.
 */
export function pillFoldOrder(chips: readonly PillChipSpec[]): PillChipSpec[] {
  const known = (chip: PillChipSpec): number => {
    const i = PILL_FOLD_ORDER.indexOf(chip.id)
    return i === -1 ? PILL_FOLD_ORDER.length : i
  }
  return chips
    .map((chip, index) => ({ chip, index }))
    .filter(({ chip }) => tierOf(chip) !== 'anchor')
    .sort((a, b) => {
      const tier = TIER_RANK[tierOf(a.chip)] - TIER_RANK[tierOf(b.chip)]
      if (tier !== 0) return tier
      const order = known(a.chip) - known(b.chip)
      if (order !== 0) return order
      return a.index - b.index
    })
    .map(({ chip }) => chip)
}

/**
 * Fold the pill's chips. `room` is what the host and the chips share, in px: the pill's content
 * width less whatever else stands in it (the space label). Every chip is in until the host
 * would have less than `floor`; then chips fold in `pillFoldOrder` until it has the floor again
 * or nothing more can fold. A `room` of 0 or less means the pill has not been laid out (a
 * detached or hidden pill measures 0): nothing folds on a measurement that is not one.
 */
export function foldPillChips(
  chips: readonly PillChipSpec[],
  room: number,
  floor: number = PILL_HOST_FLOOR
): PillFold {
  const ids = chips.map((c) => c.id)
  const total = chips.reduce((sum, c) => sum + c.width, 0)
  if (!(room > 0)) return { shown: ids, folded: [], host: Math.max(0, room - total) }
  let host = room - total
  const folded = new Set<string>()
  for (const chip of pillFoldOrder(chips)) {
    if (host >= floor) break
    folded.add(chip.id)
    host += chip.width
  }
  return {
    shown: ids.filter((id) => !folded.has(id)),
    folded: [...folded],
    host
  }
}

/**
 * What TalkBack hears of the folded chips at the pill's one stop (#237's address label): their
 * states, in the pill's order, after the address – "Address, example.com, 12 requests blocked,
 * Now playing". States rather than a count: "2 more in site information" would send the user
 * to the sheet to learn what a glance at the pill tells a sighted user; the states say it here.
 * Empty when nothing folded, so the label is #237's alone.
 */
export function foldedChipsSpoken(states: readonly string[]): string {
  return states.filter((s) => s.length > 0).join(', ')
}
