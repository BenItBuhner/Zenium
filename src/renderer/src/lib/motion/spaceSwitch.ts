/**
 * The Space switch's motion in the phone's tab overview (design language v2 §11.4 / §11.6, the
 * Android matrix's MOT-05): the surface's colours blend (the theme blend, `useTheme.ts`, 240 ms),
 * the outgoing grid FADES over 120 ms and the incoming grid SLIDES in over 250 ms from the side
 * the new Space stands on in the spaces' order (the Spaces sheet's, the swipe's).
 *
 * This module is the pure part: the direction, the phases' timings and the reduced-motion branch,
 * so that they can be pinned by tests without a DOM. `TabOverview.tsx` drives the elements.
 *
 * Reduced motion (§11.3): nothing travels. The incoming grid is a 120 ms opacity fade in place
 * and the outgoing grid's 120 ms fade stays (the fades are declared explicitly). The theme blend
 * runs as under full motion: §11.3 removes springs and travel, not fades,
 * and a colour blend is a fade in colour that moves no pixel, where a whole window cutting from
 * one Space's colour to another's is a flash (§11.6 as amended at #497's design gate). The blend
 * itself is `useTheme.ts`'s, which reads no reduced-motion preference.
 */

import { REDUCED_FADE_MS } from './fade'
import { ZEN_EASE } from './tokens'

/** How long the incoming grid's slide takes. */
export const SPACE_SLIDE_MS = 250

/** How long the outgoing grid's fade takes. */
export const SPACE_FADE_MS = REDUCED_FADE_MS

/**
 * How far the incoming grid travels: §11's short travel, not the pane's width. A full-width
 * slide would claim a carousel of Spaces the overview is not; the direction is the cue.
 */
export const SPACE_SLIDE_PX = 120

/** §11's standard curve for a state change: the one curve. */
export const SPACE_EASE = ZEN_EASE

/** The slide's `Animation.id`, for whoever finds the slot's animations (tests, the drivers). */
export const SPACE_SLIDE_ID = 'zen-space-slide'

/**
 * Where the incoming Space stands relative to the outgoing one: `forward` when later in the
 * spaces' order (the incoming grid comes from the trailing side), `back` when earlier, `none` when
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
  /** A right-to-left layout: the spaces' order runs the other way, so the sides swap. */
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
  /**
   * The theme blend runs – on both branches: a colour blend is a fade, which reduced motion
   * keeps (§11.6 as amended). The field records the ruling where the plan's tests pin it.
   */
  blend: true
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
      blend: true
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
    blend: true
  }
}
