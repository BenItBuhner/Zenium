/**
 * Pure decisions for paged swipes (tab switching, the overview sheet). A gesture lives on a
 * one-dimensional track measured in pages: the tab track has one page per tab, the overview has
 * page 0 = closed and page 1 = open. Positions are continuous while a finger drags; on release
 * these helpers pick the page to settle on.
 */
export interface SwipeThresholds {
  /** Speed (px/s) from which a release counts as a fling, regardless of distance. */
  flingVelocity: number
  /** Fraction of a page the finger has to cross (with velocity projected in) to commit. */
  commitFraction: number
  /** How far ahead (s) the release velocity is projected for slow releases. */
  projectionSeconds: number
}

export const SWIPE_THRESHOLDS: SwipeThresholds = {
  flingVelocity: 450,
  commitFraction: 0.45,
  projectionSeconds: 0.12
}

export interface SettleInput {
  /** Current position on the track, in pages. */
  position: number
  /** Release velocity along the track in px/s (positive = towards higher pages). */
  velocity: number
  /** Size of one page in px. */
  extent: number
  /** Lowest and highest page that exist. */
  min: number
  max: number
}

/**
 * Which page a released track settles on. A fling goes one page in its own direction – flinging
 * back over a page you dragged towards cancels it. A slow release commits when the (velocity
 * projected) position has crossed `commitFraction` of the way to the next page.
 */
export function settleTarget(input: SettleInput, thresholds = SWIPE_THRESHOLDS): number {
  const { position, velocity, extent, min, max } = input
  const clamp = (page: number): number => Math.min(max, Math.max(min, page))
  if (position <= min && velocity <= 0) return min
  if (position >= max && velocity >= 0) return max
  const lo = Math.floor(position)
  const hi = Math.ceil(position)
  if (Math.abs(velocity) >= thresholds.flingVelocity) {
    if (lo === hi) return clamp(lo + Math.sign(velocity))
    return clamp(velocity > 0 ? hi : lo)
  }
  if (lo === hi) return clamp(lo)
  const projected = position + (velocity / extent) * thresholds.projectionSeconds
  return clamp(projected - lo >= thresholds.commitFraction ? hi : lo)
}

/**
 * iOS-style rubber band: past an edge the content follows the finger with diminishing returns
 * and never travels further than `extent`. `overshoot` and the result are in px.
 */
export function rubberBand(overshoot: number, extent: number, coefficient = 0.55): number {
  if (overshoot === 0 || extent <= 0) return 0
  const d = Math.abs(overshoot)
  return Math.sign(overshoot) * (1 - 1 / ((d * coefficient) / extent + 1)) * extent
}

/**
 * Where a finger that started dragging at `start` (pages) and moved `delta` px along the track
 * puts the track, with rubber banding beyond the first and last page.
 */
export function dragPosition(
  start: number,
  delta: number,
  extent: number,
  min: number,
  max: number
): number {
  if (extent <= 0) return start
  const raw = start + delta / extent
  if (raw > max) return max + rubberBand((raw - max) * extent, extent) / extent
  if (raw < min) return min + rubberBand((raw - min) * extent, extent) / extent
  return raw
}

/** 0..1 how far `position` is between two pages (0 at either page). */
export function pageBlend(position: number): number {
  const frac = position - Math.floor(position)
  return Math.min(frac, 1 - frac) * 2
}
