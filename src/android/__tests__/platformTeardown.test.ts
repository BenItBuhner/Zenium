import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

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
  send: () => undefined,
  callSync: () => undefined
} as unknown as Bridge

describe('the teardown host event (Host.destroy under the running browser)', () => {
  it('reaches Browser.onHostTeardown, once per event, and nothing else', () => {
    const platform = new AndroidPlatform(bridge, BOOT)
    const onHostTeardown = vi.fn()
    const flushSync = vi.fn()
    platform.bind({ onHostTeardown, flushSync } as unknown as Browser)

    platform.hostEvent('teardown', undefined)
    expect(onHostTeardown).toHaveBeenCalledTimes(1)
    expect(flushSync).not.toHaveBeenCalled()
    platform.hostEvent('teardown', undefined)
    expect(onHostTeardown).toHaveBeenCalledTimes(2)
  })
})
