import { rubberBand, SWIPE_THRESHOLDS, type SwipeThresholds } from './swipe'

/**
 * Pure decisions for swiping a message card away (toasts, banners). A card may leave along one
 * or more directions – a toast down or sideways, a banner up or sideways – and rubber-bands the
 * rest. The card's own extent along the axis (plus its gap) is the distance at which it is gone,
 * and the release lets go where every dismissible card in the app does: on the shared
 * `SWIPE_THRESHOLDS` of the tab and row swipes (v2 §9.33), not a set of its own.
 */

export type Axis = 'x' | 'y'

/** Which ways a card may be swiped off: signs along each axis (`-1` up / left, `1` down / right). */
export interface DismissDirections {
  x: ReadonlyArray<-1 | 1>
  y: ReadonlyArray<-1 | 1>
}

/** Movement (px) before a touch counts as a drag rather than a tap. */
export const DISMISS_SLOP = 8
/** A card dragged where it cannot go gives this much at most. */
const RESIST_EXTENT = 40

/** The axis a drag has settled on once it has left the slop circle (null while it has not). */
export function dragAxis(dx: number, dy: number, slop = DISMISS_SLOP): Axis | null {
  if (dx * dx + dy * dy < slop * slop) return null
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
}

/** Whether the card may leave along `axis` in the direction of `delta`. */
export function allowedAlong(delta: number, axis: Axis, dirs: DismissDirections): boolean {
  if (delta === 0) return false
  return dirs[axis].includes(delta > 0 ? 1 : -1)
}

/**
 * Where a finger that moved `delta` px along `axis` puts the card: with it where it may leave,
 * held back by a short rubber band where it may not.
 */
export function dragOffset(delta: number, axis: Axis, dirs: DismissDirections): number {
  if (allowedAlong(delta, axis, dirs)) return delta
  return rubberBand(delta, RESIST_EXTENT)
}

/**
 * Which way a released card goes: `1` or `-1` off along the axis, `0` back to its slot. A fling
 * (`flingVelocity`) in a permitted direction commits from anywhere; a slow release, projected
 * `projectionSeconds` ahead, commits once it is `commitFraction` of the card's `extent` out.
 */
export function dismissSign(
  offset: number,
  velocity: number,
  extent: number,
  axis: Axis,
  dirs: DismissDirections,
  thresholds: SwipeThresholds = SWIPE_THRESHOLDS
): -1 | 0 | 1 {
  if (Math.abs(velocity) >= thresholds.flingVelocity && allowedAlong(velocity, axis, dirs)) {
    return velocity > 0 ? 1 : -1
  }
  const projected = offset + velocity * thresholds.projectionSeconds
  if (!allowedAlong(projected, axis, dirs)) return 0
  if (Math.abs(projected) < thresholds.commitFraction * Math.max(1, extent)) return 0
  return projected > 0 ? 1 : -1
}

/**
 * How present a card is, 1 in its slot and 0 once `reach` px out along its exit: drives the
 * opacity so a card thrown off fades as it goes and one arriving fades in.
 */
export function dismissPresence(offset: number, reach: number): number {
  if (reach <= 0) return 1
  return Math.min(1, Math.max(0, 1 - Math.abs(offset) / reach))
}
