// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCREEN_CAPTURE_INTENT_EVENT,
  installScreenCaptureBridge,
  installScreenCaptureShim,
  type ScreenCaptureBridgeTransport
} from '../screenCapture'

interface FakeEngine {
  /** The constraints and `this` the engine's own `getDisplayMedia` saw, in order. */
  calls: Array<{ constraints: unknown; self: unknown }>
  /** The order of announcements and engine calls, to show the announcement comes first. */
  order: string[]
  devices: MediaDevices
  native: (...args: unknown[]) => Promise<unknown>
}

/** happy-dom has no `MediaDevices`: a stand-in with the engine's `getDisplayMedia` shape. */
function fakeEngine(): FakeEngine {
  const engine = { calls: [], order: [] } as unknown as FakeEngine
  const native = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    engine.calls.push({ constraints: args[0], self: this })
    engine.order.push('engine')
    return Promise.resolve({ stream: true })
  }
  Object.defineProperty(native, 'name', { value: 'getDisplayMedia' })
  class FakeMediaDevices {}
  Object.defineProperty(FakeMediaDevices.prototype, 'getDisplayMedia', {
    value: native,
    writable: true,
    configurable: true
  })
  Object.defineProperty(globalThis, 'MediaDevices', {
    value: FakeMediaDevices,
    configurable: true
  })
  engine.devices = new FakeMediaDevices() as unknown as MediaDevices
  engine.native = native
  return engine
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'MediaDevices')
})

/** The bridge with a transport that records announcements in the engine's order log. */
function bridge(engine: FakeEngine): { intents: boolean[] } {
  const intents: boolean[] = []
  const transport: ScreenCaptureBridgeTransport = {
    intent: (audio) => {
      intents.push(audio)
      engine.order.push(`intent:${audio}`)
    },
    installShim: (eventName) => installScreenCaptureShim(eventName)
  }
  installScreenCaptureBridge(transport)
  return { intents }
}

describe('screen capture shim', () => {
  it("announces whether the call asked for audio before the engine sees it; the call itself is the engine's", async () => {
    const engine = fakeEngine()
    const { intents } = bridge(engine)
    const withAudio = await engine.devices.getDisplayMedia({ video: true, audio: true })
    const videoOnly = await engine.devices.getDisplayMedia({ video: true })
    await engine.devices.getDisplayMedia()
    expect(intents).toEqual([true, false, false])
    expect(engine.order).toEqual([
      'intent:true',
      'engine',
      'intent:false',
      'engine',
      'intent:false',
      'engine'
    ])
    expect(withAudio).toEqual({ stream: true })
    expect(videoOnly).toEqual({ stream: true })
    // The constraints reach the engine untouched, on the same `this`.
    expect(engine.calls.map((c) => c.constraints)).toEqual([
      { video: true, audio: true },
      { video: true },
      undefined
    ])
    expect(engine.calls.every((c) => c.self === engine.devices)).toBe(true)
  })

  it('audio constraints of any truthy shape count, as the engine reads them', async () => {
    const engine = fakeEngine()
    const { intents } = bridge(engine)
    await engine.devices.getDisplayMedia({ audio: { echoCancellation: true } })
    await engine.devices.getDisplayMedia({ audio: false })
    await engine.devices.getDisplayMedia({ audio: 0 } as unknown as DisplayMediaStreamOptions)
    expect(intents).toEqual([true, false, false])
  })

  it("looks like the engine's function to a page: same name and length", () => {
    const engine = fakeEngine()
    bridge(engine)
    const wrapped = engine.devices.getDisplayMedia
    expect(wrapped).not.toBe(engine.native)
    expect(wrapped.name).toBe('getDisplayMedia')
    expect(wrapped.length).toBe(engine.native.length)
  })

  it('an unreachable browser does not stop the call', async () => {
    const engine = fakeEngine()
    installScreenCaptureBridge({
      intent: () => {
        throw new Error('ipc gone')
      },
      installShim: (eventName) => installScreenCaptureShim(eventName)
    })
    await expect(engine.devices.getDisplayMedia({ audio: true })).resolves.toEqual({
      stream: true
    })
    expect(engine.calls).toHaveLength(1)
  })

  it("a frozen prototype keeps the engine's own function", () => {
    const engine = fakeEngine()
    Object.freeze(Object.getPrototypeOf(engine.devices))
    expect(() => installScreenCaptureShim(SCREEN_CAPTURE_INTENT_EVENT)).not.toThrow()
    expect(engine.devices.getDisplayMedia).toBe(engine.native)
  })

  it('does nothing where the engine has no getDisplayMedia', () => {
    Reflect.deleteProperty(globalThis, 'MediaDevices')
    expect(() => installScreenCaptureShim(SCREEN_CAPTURE_INTENT_EVENT)).not.toThrow()
    class BareMediaDevices {}
    Object.defineProperty(globalThis, 'MediaDevices', {
      value: BareMediaDevices,
      configurable: true
    })
    expect(() => installScreenCaptureShim(SCREEN_CAPTURE_INTENT_EVENT)).not.toThrow()
    expect('getDisplayMedia' in BareMediaDevices.prototype).toBe(false)
  })

  it('the bridge hears only a true detail as audio', () => {
    const intents: boolean[] = []
    installScreenCaptureBridge(
      { intent: (audio) => intents.push(audio), installShim: vi.fn() },
      'zen-test-intent'
    )
    document.dispatchEvent(new CustomEvent('zen-test-intent', { detail: true }))
    document.dispatchEvent(new CustomEvent('zen-test-intent', { detail: 'true' }))
    document.dispatchEvent(new CustomEvent('zen-test-intent'))
    expect(intents).toEqual([true, false, false])
  })
})
