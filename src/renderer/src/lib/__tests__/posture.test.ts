import { describe, expect, it } from 'vitest'
import { FLAT_POSTURE, devicePostureOf, samePosture } from '../posture'

describe('devicePostureOf', () => {
  it('reads a half-opened posture with its hinge as the host sends it', () => {
    const posture = devicePostureOf({
      kind: 'halfOpened',
      hinge: { left: 0, top: 400, right: 840, bottom: 420, orientation: 'horizontal', separating: true }
    })
    expect(posture.kind).toBe('halfOpened')
    expect(posture.hinge).toEqual({
      left: 0,
      top: 400,
      right: 840,
      bottom: 420,
      orientation: 'horizontal',
      separating: true
    })
  })

  it('is flat with no hinge for a host without the word, a null payload or an unknown kind', () => {
    expect(devicePostureOf(undefined)).toEqual(FLAT_POSTURE)
    expect(devicePostureOf(null)).toEqual(FLAT_POSTURE)
    expect(devicePostureOf({ kind: 'tabletop' })).toEqual(FLAT_POSTURE)
    expect(devicePostureOf('halfOpened')).toEqual(FLAT_POSTURE)
  })

  it('keeps the kind and drops a hinge whose sides or orientation are garbled', () => {
    expect(devicePostureOf({ kind: 'halfOpened', hinge: { left: 0, top: 'x', right: 1, bottom: 2, orientation: 'vertical' } })).toEqual({
      kind: 'halfOpened',
      hinge: null
    })
    expect(devicePostureOf({ kind: 'halfOpened', hinge: { left: 0, top: 0, right: 1, bottom: 2, orientation: 'diagonal' } })).toEqual({
      kind: 'halfOpened',
      hinge: null
    })
    expect(devicePostureOf({ kind: 'halfOpened', hinge: { left: 10, top: 0, right: 1, bottom: 2, orientation: 'vertical' } }).hinge).toBeNull()
    expect(devicePostureOf({ kind: 'flat', hinge: 'none' })).toEqual(FLAT_POSTURE)
  })

  it('reads a flat device that still has a hinge in the window (an unfolded book)', () => {
    const posture = devicePostureOf({
      kind: 'flat',
      hinge: { left: 410, top: 0, right: 430, bottom: 900, orientation: 'vertical', separating: false }
    })
    expect(posture.kind).toBe('flat')
    expect(posture.hinge?.orientation).toBe('vertical')
    expect(posture.hinge?.separating).toBe(false)
  })
})

describe('samePosture', () => {
  const hinge = { left: 0, top: 400, right: 840, bottom: 420, orientation: 'horizontal' as const, separating: true }

  it('is true for the same pose and false when the kind, a side or the orientation differs', () => {
    expect(samePosture(FLAT_POSTURE, { kind: 'flat', hinge: null })).toBe(true)
    expect(samePosture({ kind: 'halfOpened', hinge }, { kind: 'halfOpened', hinge: { ...hinge } })).toBe(true)
    expect(samePosture({ kind: 'halfOpened', hinge }, { kind: 'flat', hinge })).toBe(false)
    expect(samePosture({ kind: 'halfOpened', hinge }, { kind: 'halfOpened', hinge: { ...hinge, top: 401 } })).toBe(false)
    expect(samePosture({ kind: 'halfOpened', hinge }, { kind: 'halfOpened', hinge: { ...hinge, orientation: 'vertical' } })).toBe(false)
    expect(samePosture({ kind: 'halfOpened', hinge }, { kind: 'halfOpened', hinge: null })).toBe(false)
  })
})
