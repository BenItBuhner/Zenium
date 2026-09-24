import type { DevicePosture, FoldHinge, PostureKind } from '@shared/types'
import { refreshViewport } from './formFactor'
import { createStore } from './store'

export type { DevicePosture, FoldHinge, PostureKind }

/**
 * A foldable's posture as the host reports it (`androidx.window`'s `WindowInfoTracker`, the
 * `FoldingFeature` of the window's layout, `Posture.kt`; OS-11): the device is `flat` (or has
 * no fold in this window), or `halfOpened` with the hinge across the window – a laptop or a
 * book pose. The chrome does not lay itself out by the posture (OS-11: no tabletop layout); the
 * form factor stays the window's width (`formFactor.ts`, re-derived here as the pose changes,
 * since the fold that moves the pose moves the window too). The pose is kept for what reads it
 * – the log, a driver (`data-posture` on the root), a later surface that keeps clear of the
 * hinge – and re-evaluates nothing else by itself.
 */
export const FLAT_POSTURE: DevicePosture = { kind: 'flat', hinge: null }

/**
 * The pose in a word – what the root's `data-posture` says and the log names: `flat`; half
 * opened with a horizontal hinge is `tabletop` (the laptop pose), with a vertical one `book`;
 * half opened with no hinge the host could place is `half-opened`.
 */
export type Pose = 'flat' | 'tabletop' | 'book' | 'half-opened'

export function poseOf(posture: DevicePosture): Pose {
  if (posture.kind !== 'halfOpened') return 'flat'
  if (!posture.hinge) return 'half-opened'
  return posture.hinge.orientation === 'horizontal' ? 'tabletop' : 'book'
}

export interface PostureState {
  posture: DevicePosture
  pose: Pose
}

export const postureStore = createStore<PostureState>(
  { posture: FLAT_POSTURE, pose: 'flat' },
  'posture'
)

/** Two postures name the same pose: the chrome logs and stores a change only when they differ. */
export function samePosture(a: DevicePosture, b: DevicePosture): boolean {
  if (a.kind !== b.kind) return false
  if (a.hinge === null || b.hinge === null) return a.hinge === b.hinge
  return (
    a.hinge.left === b.hinge.left &&
    a.hinge.top === b.hinge.top &&
    a.hinge.right === b.hinge.right &&
    a.hinge.bottom === b.hinge.bottom &&
    a.hinge.orientation === b.hinge.orientation &&
    a.hinge.separating === b.hinge.separating
  )
}

/** The pose and the hinge as one line of the log. */
export function describePosture(posture: DevicePosture): string {
  const pose = poseOf(posture)
  const hinge = posture.hinge
  if (!hinge) return pose
  const size =
    hinge.orientation === 'horizontal'
      ? `${hinge.bottom - hinge.top} tall at y ${hinge.top}`
      : `${hinge.right - hinge.left} wide at x ${hinge.left}`
  return `${pose}, ${hinge.orientation} hinge ${size}${hinge.separating ? ', separating' : ''}`
}

/**
 * The host's `posture` event (and the boot payload's copy, replayed by the bus): the store, the
 * root's `data-posture` and a line in the log when the pose differs from the last one heard – the
 * host reports on a change alone, but a boot replay repeats the last. The viewport re-derives
 * the layout from the window's width in the same breath (`formFactor.ts`): a fold that changed
 * the window has the class follow it, whether or not the resize was heard first. Answers whether
 * anything changed.
 */
export function applyDevicePosture(posture: DevicePosture): boolean {
  const was = postureStore.get().posture
  if (samePosture(was, posture)) return false
  const pose = poseOf(posture)
  postureStore.set({ posture, pose })
  if (typeof document !== 'undefined') document.documentElement.dataset.posture = pose
  console.info(`[zen] posture ${describePosture(posture)}`)
  refreshViewport()
  return true
}
