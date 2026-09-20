// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GEOLOCATION_EVENTS,
  installGeolocationBridge,
  installGeolocationShim,
  isGeolocationCall,
  type GeolocationBridgeTransport,
  type GeolocationCall,
  type GeolocationResult,
  type GeolocationShimEvents,
  type GeolocationShimMode
} from '../geolocation'

const NATIVE_FIX = {
  coords: { latitude: 1, longitude: 2, accuracy: 3 },
  timestamp: 4
} as GeolocationPosition
const FIX = { latitude: 52.52, longitude: 13.405, accuracy: 120, timestamp: 1_700_000_000_000 }

interface Native {
  gets: number
  watches: number
  cleared: number[]
  /** What the engine's own provider answers: a fix, or an error code. */
  answer: 'fix' | 1 | 2
}

/** A stand-in for the engine's `Geolocation`, calling back in a task as the standard asks. */
function fakeGeolocation(): Native {
  const native: Native = { gets: 0, watches: 0, cleared: [], answer: 2 }
  const reply = (success: PositionCallback, failure?: PositionErrorCallback | null): void => {
    queueMicrotask(() => {
      if (native.answer === 'fix') success(NATIVE_FIX)
      else
        failure?.({
          code: native.answer,
          message: 'native',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3
        } as GeolocationPositionError)
    })
  }
  class Geolocation {
    getCurrentPosition(success: PositionCallback, failure?: PositionErrorCallback | null): void {
      native.gets++
      reply(success, failure)
    }
    watchPosition(success: PositionCallback, failure?: PositionErrorCallback | null): number {
      native.watches++
      reply(success, failure)
      return 100 + native.watches
    }
    clearWatch(handle: number): void {
      native.cleared.push(handle)
    }
  }
  Object.defineProperty(globalThis, 'Geolocation', { value: Geolocation, configurable: true })
  Object.defineProperty(navigator, 'geolocation', {
    value: new Geolocation(),
    configurable: true
  })
  return native
}

interface ScriptedBridge {
  events: GeolocationShimEvents
  sent: GeolocationCall[]
  answer: (result: GeolocationResult) => void
}

let installs = 0

/** The isolated-world half with the browser scripted; its own event names per install. */
function bridge(mode: GeolocationShimMode): ScriptedBridge {
  installs++
  const events: GeolocationShimEvents = {
    request: `${GEOLOCATION_EVENTS.request}-${installs}`,
    result: `${GEOLOCATION_EVENTS.result}-${installs}`
  }
  let push: (result: GeolocationResult) => void = () => undefined
  const state: ScriptedBridge = { events, sent: [], answer: (result) => push(result) }
  const transport: GeolocationBridgeTransport = {
    send: (call) => {
      state.sent.push(call)
    },
    onResult: (listener) => {
      push = listener
    },
    installShim: (e, m) => installGeolocationShim(e, m)
  }
  installGeolocationBridge(transport, mode, events)
  return state
}

const geo = (): Geolocation => navigator.geolocation
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('navigator.geolocation shim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(globalThis, 'Geolocation')
  })

  it('replace: the call goes to the browser, cleaned of unknown options, and the fix comes back as a GeolocationPosition', () => {
    const native = fakeGeolocation()
    const b = bridge('replace')
    const success = vi.fn()
    const failure = vi.fn()
    geo().getCurrentPosition(success, failure, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 5_000,
      junk: 1
    } as PositionOptions)
    expect(b.sent).toEqual([
      {
        id: 'geo-1',
        kind: 'get',
        options: { enableHighAccuracy: true, timeout: 5_000, maximumAge: 60_000 }
      }
    ])
    expect(native.gets).toBe(0)
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).toHaveBeenCalledTimes(1)
    const position = success.mock.calls[0][0] as GeolocationPosition
    expect(position.coords.latitude).toBe(52.52)
    expect(position.coords.altitude).toBeNull()
    expect(position.timestamp).toBe(FIX.timestamp)
    expect(Object.isFrozen(position)).toBe(true)
    expect(JSON.parse(JSON.stringify(position))).toEqual({
      coords: {
        latitude: 52.52,
        longitude: 13.405,
        accuracy: 120,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null
      },
      timestamp: FIX.timestamp
    })
    // Answered: the timeout does not fire, and a second answer has nobody to go to.
    vi.advanceTimersByTime(5_000)
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).toHaveBeenCalledTimes(1)
    expect(failure).not.toHaveBeenCalled()
  })

  it('hands the browser’s refusal to the page as a GeolocationPositionError', () => {
    fakeGeolocation()
    const b = bridge('replace')
    const failure = vi.fn()
    geo().getCurrentPosition(() => undefined, failure)
    b.answer({ id: 'geo-1', error: { code: 1, message: 'User denied Geolocation' } })
    expect(failure).toHaveBeenCalledTimes(1)
    const error = failure.mock.calls[0][0] as GeolocationPositionError
    expect(error.code).toBe(1)
    expect(error.PERMISSION_DENIED).toBe(1)
    expect(error.message).toBe('User denied Geolocation')
    // A one-shot call without a failure callback just goes quiet.
    geo().getCurrentPosition(() => undefined)
    expect(() =>
      b.answer({ id: 'geo-2', error: { code: 2, message: 'Position unavailable' } })
    ).not.toThrow()
    // No callback at all: Chrome's TypeError.
    expect(() => (geo().getCurrentPosition as (cb: unknown) => void)(undefined)).toThrow(TypeError)
  })

  it('replace: a watch keeps taking answers until clearWatch, which tells the browser', () => {
    const native = fakeGeolocation()
    const b = bridge('replace')
    const success = vi.fn()
    const handle = geo().watchPosition(success)
    expect(typeof handle).toBe('number')
    expect(b.sent).toEqual([{ id: 'geo-1', kind: 'watch', options: {} }])
    b.answer({ id: 'geo-1', position: FIX })
    b.answer({ id: 'geo-1', position: { ...FIX, latitude: 52.53 } })
    expect(success).toHaveBeenCalledTimes(2)
    geo().clearWatch(handle)
    expect(b.sent[1]).toEqual({ id: 'geo-1', kind: 'clear' })
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).toHaveBeenCalledTimes(2)
    // The engine's own watch list is not involved, and a handle nobody knows is a no-op.
    expect(native.watches).toBe(0)
    expect(native.cleared).toEqual([])
    geo().clearWatch(12_345)
    expect(b.sent).toHaveLength(2)
  })

  it('times a call out itself: TIMEOUT to the page and a clear to the browser; a watch reports and keeps going', () => {
    fakeGeolocation()
    const b = bridge('replace')
    const success = vi.fn()
    const failure = vi.fn()
    geo().getCurrentPosition(success, failure, { timeout: 1_000 })
    vi.advanceTimersByTime(1_000)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure.mock.calls[0][0]).toMatchObject({ code: 3, message: 'Timeout expired' })
    expect(b.sent[1]).toEqual({ id: 'geo-1', kind: 'clear' })
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).not.toHaveBeenCalled()

    const watchSuccess = vi.fn()
    const watchFailure = vi.fn()
    geo().watchPosition(watchSuccess, watchFailure, { timeout: 500 })
    vi.advanceTimersByTime(500)
    expect(watchFailure).toHaveBeenCalledTimes(1)
    expect(b.sent.filter((c) => c.kind === 'clear')).toHaveLength(1)
    b.answer({ id: 'geo-2', position: FIX })
    expect(watchSuccess).toHaveBeenCalledTimes(1)
  })

  it('fallback: the engine answers first; only POSITION_UNAVAILABLE goes to the network', async () => {
    const native = fakeGeolocation()
    const b = bridge('fallback')
    const success = vi.fn()
    const failure = vi.fn()
    // The engine has a fix: the page gets it, the network is not asked.
    native.answer = 'fix'
    geo().getCurrentPosition(success, failure)
    await flush()
    expect(success).toHaveBeenCalledWith(NATIVE_FIX)
    expect(b.sent).toEqual([])
    // The engine refused (the user said no): that stands.
    native.answer = 1
    geo().getCurrentPosition(success, failure)
    await flush()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure.mock.calls[0][0]).toMatchObject({ code: 1, message: 'native' })
    expect(b.sent).toEqual([])
    // The engine has no provider: the network answers.
    native.answer = 2
    geo().getCurrentPosition(success, failure, { maximumAge: 10 })
    await flush()
    expect(b.sent).toEqual([{ id: 'geo-1', kind: 'get', options: { maximumAge: 10 } }])
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).toHaveBeenCalledTimes(2)
    expect(native.gets).toBe(3)
  })

  it('fallback: a watch the engine cannot serve moves to the network; clearWatch ends both', async () => {
    const native = fakeGeolocation()
    const b = bridge('fallback')
    const success = vi.fn()
    const handle = geo().watchPosition(success)
    expect(handle).toBe(101)
    await flush()
    expect(native.cleared).toEqual([101])
    expect(b.sent).toEqual([{ id: 'geo-1', kind: 'watch', options: {} }])
    b.answer({ id: 'geo-1', position: FIX })
    expect(success).toHaveBeenCalledTimes(1)
    geo().clearWatch(handle)
    expect(b.sent[1]).toEqual({ id: 'geo-1', kind: 'clear' })
    expect(native.cleared).toEqual([101, 101])
  })

  it('the bridge forwards only well-formed calls', () => {
    fakeGeolocation()
    const b = bridge('replace')
    const request = (detail: string): boolean =>
      document.dispatchEvent(new CustomEvent(b.events.request, { detail }))
    request(JSON.stringify({ id: 'x', kind: 'fly' }))
    request('{bad')
    expect(b.sent).toEqual([])
  })

  it('does nothing to a page without Geolocation', () => {
    Reflect.deleteProperty(globalThis, 'Geolocation')
    expect(() => installGeolocationShim(GEOLOCATION_EVENTS, 'replace')).not.toThrow()
  })
})

describe('isGeolocationCall', () => {
  it('accepts the three kinds with well-typed options only', () => {
    expect(isGeolocationCall({ id: 'a', kind: 'get' })).toBe(true)
    expect(isGeolocationCall({ id: 'a', kind: 'watch', options: { timeout: 5 } })).toBe(true)
    expect(isGeolocationCall({ id: 'a', kind: 'clear', options: {} })).toBe(true)
    expect(isGeolocationCall({ id: '', kind: 'get' })).toBe(false)
    expect(isGeolocationCall({ id: 'a', kind: 'fly' })).toBe(false)
    expect(isGeolocationCall({ id: 'a', kind: 'get', options: { timeout: '5' } })).toBe(false)
    expect(isGeolocationCall({ id: 'a', kind: 'get', options: null })).toBe(false)
    expect(isGeolocationCall('get')).toBe(false)
  })
})
