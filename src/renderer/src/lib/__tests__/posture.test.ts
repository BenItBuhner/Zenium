// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevicePosture } from '@shared/types'
import {
  FLAT_POSTURE,
  applyDevicePosture,
  describePosture,
  poseOf,
  postureStore,
  samePosture
} from '../posture'

/*
 * The fold's posture on the chrome's side (OS-11, `lib/posture.ts`): the host's `posture` event
 * lands in a store, on the root as `data-posture`, and in the log – once per change, since the
 * boot's replay repeats the last pose – and the viewport re-derives the layout from the window's
 * width. No layout reads the pose (no tabletop layout): a driver and the log do.
 */

const TABLETOP: DevicePosture = {
  kind: 'halfOpened',
  hinge: { left: 0, top: 400, right: 840, bottom: 420, orientation: 'horizontal', separating: true }
}
const BOOK: DevicePosture = {
  kind: 'halfOpened',
  hinge: { left: 410, top: 0, right: 430, bottom: 900, orientation: 'vertical', separating: true }
}

let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  postureStore.set({ posture: FLAT_POSTURE, pose: 'flat' })
  delete document.documentElement.dataset.posture
})

afterEach(() => {
  postureStore.set({ posture: FLAT_POSTURE, pose: 'flat' })
  delete document.documentElement.dataset.posture
  vi.restoreAllMocks()
})

describe('poseOf', () => {
  it('names the pose: flat, tabletop for a horizontal hinge, book for a vertical one, half-opened with none placed', () => {
    expect(poseOf(FLAT_POSTURE)).toBe('flat')
    expect(poseOf({ kind: 'flat', hinge: TABLETOP.hinge })).toBe('flat')
    expect(poseOf(TABLETOP)).toBe('tabletop')
    expect(poseOf(BOOK)).toBe('book')
    expect(poseOf({ kind: 'halfOpened', hinge: null })).toBe('half-opened')
  })

  it('describes the pose and the hinge in one line for the log', () => {
    expect(describePosture(FLAT_POSTURE)).toBe('flat')
    expect(describePosture(TABLETOP)).toBe(
      'tabletop, horizontal hinge 20 tall at y 400, separating'
    )
    expect(describePosture({ ...BOOK, hinge: { ...BOOK.hinge!, separating: false } })).toBe(
      'book, vertical hinge 20 wide at x 410'
    )
  })
})

describe('samePosture', () => {
  it('is true for the same pose and hinge, false for a side, an orientation or a kind that differs', () => {
    expect(samePosture(FLAT_POSTURE, { kind: 'flat', hinge: null })).toBe(true)
    expect(samePosture(TABLETOP, { ...TABLETOP, hinge: { ...TABLETOP.hinge! } })).toBe(true)
    expect(samePosture(TABLETOP, { ...TABLETOP, hinge: { ...TABLETOP.hinge!, top: 401 } })).toBe(
      false
    )
    expect(samePosture(TABLETOP, BOOK)).toBe(false)
    expect(samePosture(TABLETOP, { kind: 'flat', hinge: TABLETOP.hinge })).toBe(false)
    expect(samePosture(TABLETOP, { kind: 'halfOpened', hinge: null })).toBe(false)
  })
})

describe('applyDevicePosture', () => {
  it('sets the store, marks the root and logs once per change; the same pose again is nothing', () => {
    expect(applyDevicePosture(TABLETOP)).toBe(true)
    expect(postureStore.get()).toEqual({ posture: TABLETOP, pose: 'tabletop' })
    expect(document.documentElement.dataset.posture).toBe('tabletop')
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenLastCalledWith(
      '[zen] posture tabletop, horizontal hinge 20 tall at y 400, separating'
    )
    // The boot's replay, or a host repeating itself: no second line, no store write.
    const before = postureStore.get()
    expect(applyDevicePosture({ ...TABLETOP, hinge: { ...TABLETOP.hinge! } })).toBe(false)
    expect(postureStore.get()).toBe(before)
    expect(info).toHaveBeenCalledTimes(1)
    // Back flat: the mark says so.
    expect(applyDevicePosture(FLAT_POSTURE)).toBe(true)
    expect(document.documentElement.dataset.posture).toBe('flat')
    expect(postureStore.get().pose).toBe('flat')
    expect(info).toHaveBeenCalledTimes(2)
  })
})
