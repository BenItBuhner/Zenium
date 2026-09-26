import { describe, expect, it } from 'vitest'
import { resolveSearchChoiceRegion, searchChoiceRequired } from '@core/searchChoice'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

/**
 * The host's region reaches the shared model (OMN-26): `Host.kt`'s boot payload carries
 * `region` (`DeviceRegion.kt`), the platform puts it on `PlatformInfo.region`, and the core's
 * gate reads it as the desktop's. An old host's payload has none: never in the EEA.
 */

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

describe('the Android host region', () => {
  it('is passed through to PlatformInfo as the host reports it', () => {
    const platform = new AndroidPlatform(bridge, { ...BOOT, region: 'DE' })
    expect(platform.info.region).toBe('DE')
    expect(resolveSearchChoiceRegion(null, platform.info.region)).toBe('DE')
    expect(searchChoiceRequired({ region: platform.info.region ?? null, record: null })).toBe(true)
  })

  it('is null when the device names no country, and absent from an old host', () => {
    expect(new AndroidPlatform(bridge, { ...BOOT, region: null }).info.region).toBeNull()
    const old = new AndroidPlatform(bridge, BOOT)
    expect(old.info.region).toBeNull()
    expect(searchChoiceRequired({ region: old.info.region ?? null, record: null })).toBe(false)
  })

  it('leaves a region outside the Area out of the gate', () => {
    const platform = new AndroidPlatform(bridge, { ...BOOT, region: 'US' })
    expect(platform.info.region).toBe('US')
    expect(searchChoiceRequired({ region: 'US', record: null })).toBe(false)
  })
})
