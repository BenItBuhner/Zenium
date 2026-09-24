/**
 * A foldable's posture as the host reports it (`androidx.window`'s `WindowInfoTracker`, the
 * `FoldingFeature` of the window's layout; OS-11): the device is `flat` (or has no fold), or
 * `halfOpened` with the hinge across the window – a laptop or a book pose. The chrome does not
 * lay itself out by the posture (OS-11: no tabletop layout); the form factor stays the window's
 * width (`formFactor.ts`). The pose is kept for what reads it – the log, a driver, a later
 * surface that wants to avoid the hinge – and re-evaluates nothing by itself.
 */
export type PostureKind = 'flat' | 'halfOpened'

export interface FoldHinge {
  /** The hinge's bounds in CSS px, in the window's coordinates. */
  left: number
  top: number
  right: number
  bottom: number
  /** A `horizontal` hinge splits the window top / bottom (tabletop); `vertical` left / right (book). */
  orientation: 'horizontal' | 'vertical'
  /** A hinge with a width or height (`FoldingFeature.isSeparating`): the two halves are separate. */
  separating: boolean
}

export interface DevicePosture {
  kind: PostureKind
  /** The hinge, when the device has one in this window; a flat slab or an unfolded device has none. */
  hinge: FoldHinge | null
}

export const FLAT_POSTURE: DevicePosture = { kind: 'flat', hinge: null }

/**
 * The posture as a host reports it: a payload the host lacks or garbles (an old host, a device
 * without a fold, a preview without the word) is `flat` with no hinge; a hinge is kept only when
 * every side is a finite number and its orientation is one of the two.
 */
export function devicePostureOf(payload: unknown): DevicePosture {
  const raw = (payload ?? {}) as Partial<Record<string, unknown>>
  const kind: PostureKind = raw.kind === 'halfOpened' ? 'halfOpened' : 'flat'
  const hinge = hingeOf(raw.hinge)
  return { kind, hinge }
}

function hingeOf(payload: unknown): FoldHinge | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Partial<Record<string, unknown>>
  const sides = [raw.left, raw.top, raw.right, raw.bottom].map((value) => Number(value))
  if (sides.some((side) => !Number.isFinite(side))) return null
  const orientation = raw.orientation === 'horizontal' ? 'horizontal' : raw.orientation === 'vertical' ? 'vertical' : null
  if (!orientation) return null
  const [left, top, right, bottom] = sides as [number, number, number, number]
  if (right < left || bottom < top) return null
  return {
    left,
    top,
    right,
    bottom,
    orientation,
    separating: raw.separating === true
  }
}

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
