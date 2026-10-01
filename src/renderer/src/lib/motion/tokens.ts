/**
 * The motion tokens (`docs/motion-and-interaction-spec.md` §1, W8-M1): the whole set, and
 * nothing else is used. Every surface imports its durations, its springs and its curve from
 * here; a lint pin (`components/__tests__/motionVocabulary.test.ts`) fails a literal duration
 * or spring written in a component, and the values are pinned to §1's by
 * `lib/__tests__/motionTokens.test.ts`. A new motion that needs a number not in this table is a
 * design question, not a constant.
 *
 * The module is a leaf: it imports the shared spring configs and the toast card's numbers and
 * nothing of the chrome's stores, so any motion module – and either host, the desktop's chrome
 * and Android's alike – can import it without a cycle. Values other code already imports from
 * their owners (`@shared/spring`, `@shared/toastCard`, `./spring`) are re-exported, not moved.
 */
import { TOAST_SHOW_MS } from '@shared/toastCard'
import type { SpringConfig } from './spring'

// ---------------------------------------------------------------------------------------------
// Durations (ms)
// ---------------------------------------------------------------------------------------------

/**
 * A control's state change: fill, ink, glyph swap, press release, a cross-fade in place – and
 * the reduced-motion rule's one fade (§0.5: every travel becomes a 120 ms opacity fade in
 * place). CSS `--zen-ease`.
 */
export const MOTION_STATE_MS = 120

/**
 * A surface arriving or leaving where a spring is not driving it: dialog, popover, menu, hint
 * bubble (scale .98 → 1 with opacity, `--zen-ease`).
 */
export const MOTION_POP_MS = 180

/** A toast's or a band's travel in and out when not finger-driven. */
export const MOTION_MESSAGE_MS = 200

/** No non-gesture motion rests later than this (a spring's eye-rest, not its formal rest). */
export const MOTION_CAP_MS = 300

// ---------------------------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------------------------

/**
 * `SPRING_SNAPPY` (k 420, c 40: ζ ≈ .98, ~250 ms to the eye) for lists (FLIP), sheets, cards,
 * carets, anything the finger just left inside the chrome; `SPRING_GENTLE` (k 300, c 31: ζ ≈
 * .9, ~320 ms) for page-scale travel: the page pulled down, the page-edge band, the overview's
 * open and close, a row's settle after a drag. Both are `@shared/spring`'s, re-exported through
 * the chrome's `./spring`; `SPRING_STEP_CLAMP_MS` (64) clamps every stepped motion's stalled
 * frame. The k / c values are pinned to §1's by `lib/__tests__/motionTokens.test.ts`.
 */
export { SPRING_GENTLE, SPRING_SNAPPY, SPRING_STEP_CLAMP_MS } from './spring'

/**
 * `SPRING_FOLLOW` (k 1200, c 68: ζ ≈ .98, a hair of lag and weight, no rubbery drag) for what
 * is in the hand and tracks the finger – the address bar's pill carried to the other edge
 * (`lib/gestures/dock.ts`), the overview's card in the hand (`components/phone/useCardLift.ts`).
 * Let go, the thing flies home on `SPRING_SNAPPY` or `SPRING_GENTLE`, never on this one: a
 * follow spring is for the finger's own motion. Rest at .2 px / 4 px/s – a follow that rested
 * on the grid's looser thresholds would stop a hair short of the finger.
 */
export const SPRING_FOLLOW: SpringConfig = {
  stiffness: 1200,
  damping: 68,
  mass: 1,
  restDelta: 0.2,
  restSpeed: 4
}

// ---------------------------------------------------------------------------------------------
// Clocks (ms)
// ---------------------------------------------------------------------------------------------

/**
 * Every plain toast (`TOAST_DURATION`: `@shared/toastCard`'s `TOAST_SHOW_MS`, 2 800 ms) and every
 * Undo toast (`TOAST_UNDO_MS`, 8 000). `lib/ui.ts` re-exports `TOAST_DURATION` from here for the
 * callers that always read it there.
 */
export { TOAST_SHOW_MS, TOAST_UNDO_MS } from '@shared/toastCard'
export const TOAST_DURATION: number = TOAST_SHOW_MS

/**
 * A toast with an action stands 5 000 ms, time to act on it: `lib/ui.ts`'s
 * `TOAST_ACTION_DURATION`, held to this value by its type.
 */
export const TOAST_ACTION_MS = 5000

/** A page-edge offer's clock (§3.2): paused under a finger, armed at the show. */
export const BAND_CLOCK_MS = 10_000

// ---------------------------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------------------------

/**
 * `--zen-ease`, the one CSS curve (main.css declares the same value; the tokens pin holds the two
 * equal), for the places that cannot read a custom property: the Web Animations API, an inline
 * style object.
 */
export const ZEN_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

// ---------------------------------------------------------------------------------------------
// Press and lift
// ---------------------------------------------------------------------------------------------

/** Press: `scale(.98)` over `MOTION_STATE_MS` on cards and buttons; rows take the fill, not the scale. */
export const PRESS_SCALE = 0.98

/** Lift (drags): level 2 shadow (`--zen-shadow-2`), `scale(1.02)`, 90 %, a `MOTION_STATE_MS` rise. */
export const LIFT_SCALE = 1.02
export const LIFT_OPACITY = 0.9
export const LIFT_SHADOW_LEVEL = 2
