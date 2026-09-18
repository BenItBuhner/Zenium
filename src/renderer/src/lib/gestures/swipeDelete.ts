import { settleTarget, SWIPE_THRESHOLDS, type SwipeThresholds } from './swipe'

/**
 * Pure decisions for a row swiped sideways to delete it (history visits). The row is a
 * one-page track in either direction: page 0 is at rest, ±1 is off the screen. The same
 * thresholds as the tab track apply – a fling commits regardless of distance, a slow release
 * commits once the row is about half way, and flinging back over a drag cancels it.
 */
export type SwipeOutcome = 'delete' | 'reset'

/** Whether a released row leaves (`delete`) or springs home (`reset`). */
export function swipeOutcome(
  dx: number,
  velocity: number,
  width: number,
  thresholds: SwipeThresholds = SWIPE_THRESHOLDS
): SwipeOutcome {
  if (width <= 0) return 'reset'
  const page = settleTarget(
    { position: dx / width, origin: 0, velocity, extent: width, min: -1, max: 1 },
    thresholds
  )
  return page === 0 ? 'reset' : 'delete'
}

/** Where the row's spring heads after the decision: home, or off the edge it was moving towards. */
export function swipeRestTarget(
  outcome: SwipeOutcome,
  dx: number,
  velocity: number,
  width: number
): number {
  if (outcome === 'reset') return 0
  const direction = dx !== 0 ? Math.sign(dx) : Math.sign(velocity) || 1
  return direction * width
}

/**
 * How far along the delete the row is, 0…1: the glyph behind it fades and grows with this. Full
 * at the slow-release commit point, so what the finger sees agrees with what a release does.
 */
export function swipeReveal(
  dx: number,
  width: number,
  thresholds: SwipeThresholds = SWIPE_THRESHOLDS
): number {
  if (width <= 0) return 0
  return Math.min(1, Math.abs(dx) / (thresholds.commitFraction * width))
}
