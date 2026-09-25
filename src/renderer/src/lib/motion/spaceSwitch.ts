/**
 * The Space switch's motion in the phone's tab overview (design language v2 §11.4 / §11.6, the
 * Android matrix's MOT-05): the surface's colours blend (the theme blend, `useTheme.ts`, 240 ms),
 * the outgoing grid FADES over 120 ms, the incoming grid SLIDES in over 250 ms from the side the
 * new Space stands on in the strip's order, and the strip's indicator glides to the new chip.
 *
 * This module is the pure part: the direction, the phases' timings and the reduced-motion branch,
 * so that they can be pinned by tests without a DOM. `TabOverview.tsx` drives the elements.
 *
 * Reduced motion (§11.3): nothing travels. The incoming grid is a 120 ms opacity fade in place,
 * the outgoing grid's 120 ms fade stays (the fades are declared explicitly), the blend is a cut
 * (§11.6) and the indicator jumps.
 */

import { REDUCED_FADE_MS } from './fade'

/** How long the incoming grid's slide takes. */
export const SPACE_SLIDE_MS = 250

/** How long the outgoing grid's fade takes. */
export const SPACE_FADE_MS = REDUCED_FADE_MS

/**
 * How far the incoming grid travels: §11's short travel, not the pane's width. A full-width
 * slide would claim a carousel of Spaces the overview is not; the direction is the cue.
 */
export const SPACE_SLIDE_PX = 120

/** §11's standard curve for a state change. */
export const SPACE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** The slide's `Animation.id`, for whoever finds the slot's animations (tests, the drivers). */
export const SPACE_SLIDE_ID = 'zen-space-slide'

/**
 * Where the incoming Space stands relative to the outgoing one: `forward` when later in the
 * strip's order (the incoming grid comes from the trailing side), `back` when earlier, `none` when
 * there is no outgoing Space to relate it to (the first Space shown, or one no longer in the
 * order) – a slide then would claim a spatial relation there is not (§11.4), so nothing travels.
 */
export type SwitchDirection = 'forward' | 'back' | 'none'

export function switchDirection(
  order: readonly string[],
  from: string | null | undefined,
  to: string
): SwitchDirection {
  if (from == null || from === to) return 'none'
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  if (a < 0 || b < 0 || a === b) return 'none'
  return b > a ? 'forward' : 'back'
}

export interface SpaceSwitchOptions {
  /** `prefers-reduced-motion: reduce` (§11.3). */
  reduced: boolean
  /** A right-to-left layout: the strip's order runs the other way, so the sides swap. */
  rtl?: boolean
}

export interface SpaceSwitchPlan {
  /** Signed travel in px the incoming grid starts from (0: it fades in place). */
  slide: number
  /**
   * The incoming grid's keyframes and timing (Web Animations shape). With a slide the opacity
   * reaches 1 by the slide's first half, so its tail draws the cards solid at their landing.
   */
  incoming: { keyframes: Keyframe[]; duration: number; easing: string }
  /** The outgoing grid's still: a fade 1 → 0. */
  outgoing: { duration: number; easing: string }
  /** The theme blend runs (false: a cut, §11.6). */
  blend: boolean
  /** The strip's indicator glides (false: a jump). */
  indicatorGlides: boolean
}

/** The direction's sign in the layout's reading direction: +1 from the right, −1 from the left. */
export function slideSign(direction: SwitchDirection, rtl = false): -1 | 0 | 1 {
  if (direction === 'none') return 0
  const ltr: -1 | 1 = direction === 'forward' ? 1 : -1
  return rtl ? (-ltr as -1 | 1) : ltr
}

export function planSpaceSwitch(
  direction: SwitchDirection,
  options: SpaceSwitchOptions
): SpaceSwitchPlan {
  const sign = options.reduced ? 0 : slideSign(direction, options.rtl)
  const slide = sign * SPACE_SLIDE_PX
  if (slide === 0) {
    return {
      slide: 0,
      incoming: {
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        duration: REDUCED_FADE_MS,
        easing: SPACE_EASE
      },
      outgoing: { duration: SPACE_FADE_MS, easing: SPACE_EASE },
      blend: !options.reduced,
      indicatorGlides: !options.reduced
    }
  }
  return {
    slide,
    incoming: {
      keyframes: [
        { transform: `translate3d(${slide}px, 0, 0)`, opacity: 0, offset: 0 },
        { opacity: 1, offset: SPACE_FADE_MS / SPACE_SLIDE_MS },
        { transform: 'translate3d(0, 0, 0)', opacity: 1, offset: 1 }
      ],
      duration: SPACE_SLIDE_MS,
      easing: SPACE_EASE
    },
    outgoing: { duration: SPACE_FADE_MS, easing: SPACE_EASE },
    blend: true,
    indicatorGlides: true
  }
}

/** A chip's box along the strip, in the strip's scroll space. */
export interface StripBox {
  left: number
  width: number
}

/**
 * The indicator's FLIP frame at progress `p` (0: standing where the old chip was, 1: at rest on
 * the new one), written as a transform on an element already laid out at the new chip's box with
 * its origin at the left edge: `translate3d(dx px, 0, 0) scaleX(scale)`. A spring drives `p`;
 * under reduced motion the frame at 1 is written at once.
 */
export function indicatorFrame(
  from: StripBox,
  to: StripBox,
  p: number
): { dx: number; scale: number } {
  const k = 1 - p
  // `|| 0` folds a −0 at rest into 0.
  const dx = (from.left - to.left) * k || 0
  const scale = to.width > 0 ? 1 + (from.width / to.width - 1) * k : 1
  return { dx, scale }
}
