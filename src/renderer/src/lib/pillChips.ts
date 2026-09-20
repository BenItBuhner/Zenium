/*
 * The phone pill's chips at rest (OMN-02; Bennett's rule of 2026-09-20, which on the phone
 * overrides design language v2 §9.29's minimum-room rule).
 *
 * At rest the phone pill shows the favicon, the host and ONE site-information glyph – the lock,
 * or its private (the mask, §9.19) or extension-page (the extension's icon, §10.1) equivalent
 * in the leading slot – and nothing else. Every informational chip the pill used to carry (the
 * blocking shield with its count, #115; the translate offer, #106) folds into the
 * site-information sheet ALWAYS, not only when room runs out: the count goes on the shield's
 * row inside the sheet, Chrome's model, where the pill carries only the security icon. With
 * four chips up the host had about 50 px on a 412 phone and read "githu…" (#237's audit,
 * Bennett's screenshot); with the lock alone it keeps about 170.
 *
 * Transient state chips (the Now playing chip, #233; a save-password key) are a question with
 * the design lead. Until the amended ruling they show in the pill while their state is live and
 * are gone otherwise: there is nothing of them to fold.
 *
 * So the fold is a rule per chip, not a width computation: this module is that rule, pure and
 * deterministic; `components/phone/pillChips.tsx` builds the chips and draws what stays.
 */

/**
 * How a chip of the phone pill relates to the pill at rest.
 * - `glyph`: the site-information glyph – the pill's anatomy, never folds.
 * - `sheet`: an informational chip – always in the site-information sheet, never in the pill.
 * - `live`: a transient state chip – in the pill while its state is live (interim rule).
 */
export type PillChipFold = 'glyph' | 'sheet' | 'live'

export interface PillChipFoldSpec {
  /** A stable id (`lock`, `blocked`, `translate`, `media`). */
  id: string
  fold: PillChipFold
}

export interface PillFold<T extends PillChipFoldSpec> {
  /** The chips that stay in the pill, in the order they were given. */
  shown: T[]
  /** The chips the site-information sheet lists, in the order they were given. */
  folded: T[]
}

/** The fold each of the pill's known chips takes; an unknown id is informational and folds. */
export const PILL_CHIP_FOLDS: Readonly<Record<string, PillChipFold>> = {
  lock: 'glyph',
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
 * Fold the pill's chips: the site-information glyph and the live state chips stay, in the order
 * given; the informational chips go to the sheet, in the order given. Nothing about the pill's
 * width comes into it – the same set folds the same way at every width and font scale.
 */
export function foldPillChips<T extends PillChipFoldSpec>(chips: readonly T[]): PillFold<T> {
  return {
    shown: chips.filter((c) => c.fold !== 'sheet'),
    folded: chips.filter((c) => c.fold === 'sheet')
  }
}

/**
 * What TalkBack hears of the folded chips at the pill's one stop (#237's address label): their
 * states, in the pill's order, after the address – "Address, github.com, 5 requests blocked,
 * Translation offered". States rather than a count: "2 more in site information" would send the
 * user to the sheet to learn what a glance at the sheet's rows tells a sighted user; the states
 * say it here. A chip with nothing to report (nothing blocked yet) says nothing, so the label
 * on a quiet page is #237's alone.
 */
export function foldedChipsSpoken(states: readonly string[]): string {
  return states.filter((s) => s.length > 0).join(', ')
}
