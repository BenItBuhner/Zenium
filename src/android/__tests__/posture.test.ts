import { describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidPlatform, FLAT_POSTURE, devicePostureOf, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

const bridge = {
  call: async () => null,
  callSync: () => null,
  send: () => undefined
} as unknown as Bridge

const HALF_OPENED = {
  kind: 'halfOpened',
  hinge: { left: 0, top: 400, right: 840, bottom: 420, orientation: 'horizontal', separating: true }
}

/*
 * A foldable's posture from the Kotlin host (`Posture.kt`, OS-11): `androidx.window`'s folding
 * feature as `{ kind, hinge }` in CSS px. The platform reads it field by field – an old host, a
 * slab or a preview without the word is flat with no hinge – and hands it to the bus as a state
 * of the window, replayed to a subscriber that comes late, as the insets are.
 */
describe('devicePostureOf', () => {
  it('reads a half-opened posture with its hinge as the host sends it', () => {
    expect(devicePostureOf(HALF_OPENED)).toEqual({
      kind: 'halfOpened',
      hinge: {
        left: 0,
        top: 400,
        right: 840,
        bottom: 420,
        orientation: 'horizontal',
        separating: true
      }
    })
    // A flat device with a fold across the window keeps the fold's line.
    expect(
      devicePostureOf({
        kind: 'flat',
        hinge: { left: 420, top: 0, right: 420, bottom: 900, orientation: 'vertical' }
      })
    ).toEqual({
      kind: 'flat',
      hinge: {
        left: 420,
        top: 0,
        right: 420,
        bottom: 900,
        orientation: 'vertical',
        separating: false
      }
    })
  })

  it('is flat with no hinge for a host without the word, a null payload or an unknown kind', () => {
    expect(devicePostureOf(undefined)).toEqual(FLAT_POSTURE)
    expect(devicePostureOf(null)).toEqual(FLAT_POSTURE)
    expect(devicePostureOf({ kind: 'tabletop' })).toEqual(FLAT_POSTURE)
    expect(devicePostureOf('halfOpened')).toEqual(FLAT_POSTURE)
  })

  it('keeps the kind and drops a hinge whose sides or orientation are garbled', () => {
    expect(
      devicePostureOf({
        kind: 'halfOpened',
        hinge: { left: 0, top: 'x', right: 1, bottom: 2, orientation: 'vertical' }
      })
    ).toEqual({ kind: 'halfOpened', hinge: null })
    expect(
      devicePostureOf({
        kind: 'halfOpened',
        hinge: { left: 0, top: 0, right: 1, bottom: 2, orientation: 'diagonal' }
      })
    ).toEqual({ kind: 'halfOpened', hinge: null })
    expect(
      devicePostureOf({
        kind: 'halfOpened',
        hinge: { left: 10, top: 0, right: 1, bottom: 2, orientation: 'vertical' }
      }).hinge
    ).toBeNull()
    expect(devicePostureOf({ kind: 'flat', hinge: 'none' })).toEqual(FLAT_POSTURE)
  })
})

describe('the posture on the bus', () => {
  it('comes from the boot payload and is replayed to a late subscriber; the host event follows it', () => {
    const platform = new AndroidPlatform(bridge, { ...BOOT, posture: FLAT_POSTURE })
    const first = vi.fn()
    platform.events.on('posture', first)
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(FLAT_POSTURE)

    platform.hostEvent('posture', HALF_OPENED as never)
    expect(first).toHaveBeenCalledTimes(2)
    const second = vi.fn()
    platform.events.on('posture', second)
    expect(second).toHaveBeenCalledWith(devicePostureOf(HALF_OPENED))
  })

  it('is never sent for a boot payload without the word: an old host or the preview stands flat by default', () => {
    const platform = new AndroidPlatform(bridge, BOOT)
    const listener = vi.fn()
    platform.events.on('posture', listener)
    expect(listener).not.toHaveBeenCalled()
  })
})
