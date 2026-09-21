import { describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidPlatform, InProcessEvents, windowInsetsOf, type BootInfo } from '../platform'

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

/**
 * The boot order the chrome's layout must survive (Bennett's 0.3.79 report): Kotlin's `insets`
 * reach the bus before React has rendered and `useMainEvents` has subscribed – the boot payload's
 * copy from the platform's constructor, the queued host events from `hostGlobal.flush()` – and
 * Android sends them again only when they change. A late subscriber gets the latest at once.
 */
describe('the insets a late subscriber gets', () => {
  it('are replayed to a listener that subscribes after they were sent', () => {
    const events = new InProcessEvents()
    events.send('insets', { top: 24, right: 0, bottom: 16, left: 0 })
    events.send('insets', { top: 24, right: 0, bottom: 300, left: 0, settling: false })
    const listener = vi.fn()
    events.on('insets', listener)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({
      top: 24,
      right: 0,
      bottom: 300,
      left: 0,
      settling: false
    })
    // Then the live ones, as before.
    events.send('insets', { top: 24, right: 0, bottom: 16, left: 0 })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({ top: 24, right: 0, bottom: 16, left: 0 })
  })

  it('are nothing when none were sent, and other events are not replayed', () => {
    const events = new InProcessEvents()
    const insets = vi.fn()
    events.on('insets', insets)
    expect(insets).not.toHaveBeenCalled()
    events.send('urlbar.close', undefined)
    const late = vi.fn()
    events.on('urlbar.close', late)
    expect(late).not.toHaveBeenCalled()
  })

  it('come from the boot payload and then from the host, whichever was last', () => {
    const platform = new AndroidPlatform(bridge, {
      ...BOOT,
      insets: { top: 24, right: 0, bottom: 16, left: 0 }
    })
    const first = vi.fn()
    platform.events.on('insets', first)
    expect(first).toHaveBeenCalledWith({ top: 24, right: 0, bottom: 16, left: 0 })

    platform.hostEvent('insets', { top: 24, right: 0, bottom: 320, left: 0, settling: true })
    const second = vi.fn()
    platform.events.on('insets', second)
    expect(second).toHaveBeenCalledWith({ top: 24, right: 0, bottom: 320, left: 0, settling: true })
  })

  it('are four numbers even from a boot payload measured before the first dispatch', () => {
    // `MainActivity.insets` used to start as an empty JSONObject: `insets.top` undefined, written
    // as `--zen-inset-top: undefinedpx`, an invalid `calc()` and no padding at all.
    const platform = new AndroidPlatform(bridge, {
      ...BOOT,
      insets: {} as BootInfo['insets']
    })
    const listener = vi.fn()
    platform.events.on('insets', listener)
    expect(listener).toHaveBeenCalledWith({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})

describe('windowInsetsOf', () => {
  it('keeps finite sides and the settling flag', () => {
    expect(windowInsetsOf({ top: 24.5, right: 0, bottom: 16, left: 2, settling: true })).toEqual({
      top: 24.5,
      right: 0,
      bottom: 16,
      left: 2,
      settling: true
    })
  })

  it('reads a missing, garbled or negative side as 0 and drops a non-boolean settling', () => {
    expect(windowInsetsOf({})).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(windowInsetsOf(null)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(windowInsetsOf({ top: 'x', right: NaN, bottom: -3, left: Infinity, settling: 1 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    })
  })
})
