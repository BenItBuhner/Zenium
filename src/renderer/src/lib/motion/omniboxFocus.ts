/**
 * The address pill becoming the omnibox's field and back (MOT-07, Chrome's omnibox focus
 * animation): the pure half of `lib/omniboxFocus.ts`. A tap on the pill over a page grows the
 * field out of the pill's slot to the whole bar band as the bar's buttons are pushed off either
 * side, the suggestion card fading in under it; a dismissal runs the same value back. One
 * `SPRING_SNAPPY` over the field's growth (v2 §11: at least {@link FOCUS_MIN_TRAVEL} px, so a
 * short travel still reads), interruptible and reversible with the velocity carried – a pill
 * tapped while the bar is closing turns round, a dismissal mid-flight runs back from where the
 * field is. The machine here is a scalar: 0 the bar's pose, 1 the omnibox's. What each part of
 * the chrome does at a value is the stylesheet's (`main.css`, `--zen-omnibox-focus`), on
 * transform and opacity only: nothing is laid out per frame.
 *
 * The new tab page's field has its own morph (`lib/motion/fakebox.ts`, §11.8), which owns the
 * bar when the omnibox was opened from that field; this machine owns it when the pill was.
 */
import type { Rect } from '@shared/types'

/**
 * `rest`: the pill is the bar's. `opening`: on the spring to the omnibox (mounting under it).
 * `open`: landed; the bar has left. `closing`: on the spring back to the pill (the bar mounted
 * again beneath; the omnibox closes as it lands).
 */
export type OmniboxFocusPhase = 'rest' | 'opening' | 'open' | 'closing'

export interface OmniboxFocusState {
  phase: OmniboxFocusPhase
  /** The value the running segment set out from, frozen at its start; 0 at rest, 1 open. */
  from: number
  /** Progress along the running segment, 0…1. */
  t: number
  /**
   * While open, how far the predictive back gesture has pulled the field back toward the pill
   * (the finger's own value, 0…1); a commit turns it into a `closing` segment, a cancel runs it
   * back to 0.
   */
  back: number
}

export const OMNIBOX_FOCUS_REST: OmniboxFocusState = { phase: 'rest', from: 0, t: 0, back: 0 }

/** The spring's shortest travel, in px: a one-button bar grows the field by less than a thumb. */
export const FOCUS_MIN_TRAVEL = 120

/** A value this close to the bar's pose is the bar's: nothing left to run back. */
const AT_BAR = 0.001

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/**
 * The pill's slot in the bar band, as the field's growth needs it: how far the band's start is
 * from the pill's (`left`, px), the band's end from the pill's (`right`, px), and the pill's
 * width as a fraction of the band's (`scale`) – the transform that puts the field's backdrop
 * exactly over the pill. Null when the rectangles are not a pill inside a band (either empty,
 * or the pill outside the band): the tap then opens the bar without the motion.
 */
export interface FocusSlot {
  left: number
  right: number
  scale: number
}

export function slotOf(band: Rect, pill: Rect): FocusSlot | null {
  if (band.width <= 0 || pill.width <= 0) return null
  const left = pill.x - band.x
  const right = band.x + band.width - (pill.x + pill.width)
  if (left < 0 || right < 0) return null
  return { left, right, scale: pill.width / band.width }
}

/** How far the field grows, in px: the two slots the buttons leave it. */
export function slotGrowth(slot: FocusSlot): number {
  return slot.left + slot.right
}

/** Where the field is between the pill (0) and the omnibox (1). */
export function focusValue(state: OmniboxFocusState): number {
  switch (state.phase) {
    case 'rest':
      return 0
    case 'opening':
      return state.from + (1 - state.from) * state.t
    case 'open':
      return 1 - state.back
    case 'closing':
      return state.from * (1 - state.t)
  }
}

/** Where the running segment is heading: the omnibox while opening, the pill while closing. */
export function focusTarget(state: OmniboxFocusState): number {
  return state.phase === 'opening' || state.phase === 'open' ? 1 : 0
}

/**
 * The spring's travel for a segment from `from` to `to` (values), in px: the field's growth,
 * or {@link FOCUS_MIN_TRAVEL} when that is shorter, over the part of the way that is left.
 */
export function focusTravel(from: number, to: number, growth: number): number {
  return Math.max(FOCUS_MIN_TRAVEL, growth) * Math.abs(to - from)
}

/**
 * The pill was tapped: from rest, or from a closing run (the bar still up, its close held), the
 * field sets out for the omnibox from exactly where it is. Already opening or open: nothing.
 */
export function tapped(state: OmniboxFocusState): OmniboxFocusState {
  if (state.phase === 'opening' || state.phase === 'open') return state
  return { phase: 'opening', from: focusValue(state), t: 0, back: 0 }
}

/** The spring reports where along the segment it is. */
export function progressed(state: OmniboxFocusState, t: number): OmniboxFocusState {
  if (state.phase !== 'opening' && state.phase !== 'closing') return state
  const k = clamp01(t)
  return k === state.t ? state : { ...state, t: k }
}

/** The spring came to rest: opening has opened, closing is the pill again. */
export function landed(state: OmniboxFocusState): OmniboxFocusState {
  if (state.phase === 'opening') return { phase: 'open', from: 1, t: 0, back: 0 }
  if (state.phase === 'closing') return OMNIBOX_FOCUS_REST
  return state
}

/**
 * The omnibox is being dismissed – the scrim, the back gesture's commit, Escape – while the
 * field is on its way up or has arrived: it runs back to the pill from where it is (a back
 * gesture's pull included). At rest or already closing: nothing to do.
 */
export function dismissed(state: OmniboxFocusState): OmniboxFocusState {
  if (state.phase !== 'opening' && state.phase !== 'open') return state
  return { phase: 'closing', from: focusValue(state), t: 0, back: 0 }
}

/**
 * The predictive back gesture pulls the open omnibox: the field follows the finger back toward
 * the pill (its value 0…1) and a cancelled gesture runs it back to 0. Only an open field
 * follows; one still on its spring keeps flying, and the gesture's commit is `dismissed`.
 */
export function backPulled(state: OmniboxFocusState, value: number): OmniboxFocusState {
  if (state.phase !== 'open') return state
  const back = clamp01(value)
  return back === state.back ? state : { ...state, back }
}

/** Whether the omnibox is up under this machine: on its way, landed, or on its way back. */
export function omniboxUp(state: OmniboxFocusState): boolean {
  return state.phase !== 'rest'
}

/**
 * Whether the motion holds the chrome's layout: the bar stays mounted under the omnibox while
 * the field is on its way either way – and while a back gesture holds it part way – so its
 * buttons are seen to leave and to come back.
 */
export function holdsChrome(state: OmniboxFocusState): boolean {
  return (
    state.phase === 'opening' ||
    state.phase === 'closing' ||
    (state.phase === 'open' && state.back > 0)
  )
}

/**
 * Whether a segment set out from the bar's own pose – a closing run with nothing to run back:
 * the back gesture's spring finished the pull, or the bar was dismissed before it came up – so
 * the close can go through now rather than hold its scrim for the spring's settling time.
 */
export function atBar(state: OmniboxFocusState): boolean {
  return focusValue(state) <= AT_BAR
}
