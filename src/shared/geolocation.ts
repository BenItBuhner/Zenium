/**
 * Geolocation without an engine provider (MW-04). Chromium locates through the OS on Windows
 * and macOS; on Linux it has no provider and its network provider wants a Google key, so every
 * request there ends in POSITION_UNAVAILABLE. Zenium adds a network location provider of its
 * own (BeaconDB's geolocate API, free and keyless, fed by the Wi-Fi networks in range) behind
 * the same permission prompt as every other site permission: `installGeolocationShim` runs in
 * the page's main world and routes `navigator.geolocation` to the browser – every call where
 * the engine has no provider (`replace`), only the calls the engine fails (`fallback`) where it
 * has one – and `installGeolocationBridge` in the isolated world carries the calls and answers.
 */

/** A fix, as the page's `GeolocationPosition` shows it. */
export interface GeoPosition {
  latitude: number
  longitude: number
  /** Metres. */
  accuracy: number
  /** ms since the epoch, when the fix was made. */
  timestamp: number
}

/** The standard's codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. */
export type GeolocationErrorCode = 1 | 2 | 3

export const GEOLOCATION_PERMISSION_DENIED: GeolocationErrorCode = 1
export const GEOLOCATION_POSITION_UNAVAILABLE: GeolocationErrorCode = 2
export const GEOLOCATION_TIMEOUT: GeolocationErrorCode = 3

/** A Wi-Fi network in range, as the location API wants it (no names: the BSSID alone locates). */
export interface WifiAccessPoint {
  /** `aa:bb:cc:dd:ee:ff`, lowercase. */
  macAddress: string
  /** dBm, negative. */
  signalStrength?: number
  /** MHz. */
  frequency?: number
}

export interface GeolocationOptions {
  enableHighAccuracy?: boolean
  /** ms; the shim times the call out itself. */
  timeout?: number
  /** ms; a fix this fresh is answered from the cache. */
  maximumAge?: number
}

/** One request of the page's shim. `watch` keeps answering until `clear` for the same id. */
export interface GeolocationCall {
  id: string
  kind: 'get' | 'watch' | 'clear'
  options?: GeolocationOptions
}

export interface GeolocationShimEvents {
  /** Main world → isolated world: a `GeolocationCall`, JSON in `detail`. */
  request: string
  /** Isolated world → main world: `{ id, position }` or `{ id, error }`, JSON in `detail`. */
  result: string
}

export const GEOLOCATION_EVENTS: GeolocationShimEvents = {
  request: 'zen-geolocation-request',
  result: 'zen-geolocation-result'
}

/** The isolated world's answer to the shim. */
export interface GeolocationResult {
  id: string
  position?: GeoPosition
  error?: { code: GeolocationErrorCode; message: string }
}

export interface GeolocationBridgeTransport {
  send(call: GeolocationCall): void
  onResult(listener: (result: GeolocationResult) => void): void
  installShim(events: GeolocationShimEvents, mode: GeolocationShimMode): void
}

/** `replace`: the engine has no provider, every call is ours. `fallback`: only the calls it fails. */
export type GeolocationShimMode = 'replace' | 'fallback'

export function isGeolocationCall(value: unknown): value is GeolocationCall {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string' || !c.id) return false
  if (c.kind !== 'get' && c.kind !== 'watch' && c.kind !== 'clear') return false
  if (c.options === undefined) return true
  if (!c.options || typeof c.options !== 'object') return false
  const o = c.options as Record<string, unknown>
  return (
    (o.enableHighAccuracy === undefined || typeof o.enableHighAccuracy === 'boolean') &&
    (o.timeout === undefined || typeof o.timeout === 'number') &&
    (o.maximumAge === undefined || typeof o.maximumAge === 'number')
  )
}

/** Chrome's error messages, as pages see them. */
export const GEOLOCATION_MESSAGES: Record<GeolocationErrorCode, string> = {
  1: 'User denied Geolocation',
  2: 'Position unavailable',
  3: 'Timeout expired'
}

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`: one self-contained
 * function (it is serialised), taking everything it needs as arguments.
 */
export function installGeolocationShim(
  events: GeolocationShimEvents,
  mode: GeolocationShimMode
): void {
  const win = globalThis as Window & typeof globalThis
  const doc = win.document
  const proto = (win as unknown as { Geolocation?: { prototype: Geolocation } }).Geolocation
    ?.prototype
  if (!proto) return
  const nativeGet = proto.getCurrentPosition
  const nativeWatch = proto.watchPosition
  const nativeClear = proto.clearWatch
  if (
    typeof nativeGet !== 'function' ||
    typeof nativeWatch !== 'function' ||
    typeof nativeClear !== 'function'
  )
    return
  type Success = (position: GeolocationPosition) => void
  type Failure = ((error: GeolocationPositionError) => void) | null | undefined
  interface Fix {
    latitude: number
    longitude: number
    accuracy: number
    timestamp: number
  }
  interface Pending {
    success: Success
    failure: Failure
    watch: boolean
    timer: ReturnType<typeof setTimeout> | null
  }
  const define = (target: object, name: string, value: unknown): void => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      })
    } catch {
      /* a frozen prototype keeps the engine's own */
    }
  }
  const makeError = (code: 1 | 2 | 3, message: string): GeolocationPositionError => {
    const error = {
      code,
      message,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3
    }
    return Object.freeze(error) as unknown as GeolocationPositionError
  }
  const makePosition = (fix: Fix): GeolocationPosition => {
    const coords = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() {
        return {
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracy: fix.accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null
        }
      }
    }
    const position = {
      coords: Object.freeze(coords),
      timestamp: fix.timestamp,
      toJSON() {
        return { coords: coords.toJSON(), timestamp: fix.timestamp }
      }
    }
    return Object.freeze(position) as unknown as GeolocationPosition
  }

  const pending = new Map<string, Pending>()
  /** Our watch ids are the page's; the engine's own watches (fallback mode) keep theirs. */
  const watchIds = new Map<number, string>()
  let counter = 0
  const post = (call: { id: string; kind: 'get' | 'watch' | 'clear'; options?: unknown }): void => {
    doc.dispatchEvent(new CustomEvent(events.request, { detail: JSON.stringify(call) }))
  }

  const settle = (id: string, entry: Pending): void => {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    if (!entry.watch) pending.delete(id)
  }
  doc.addEventListener(events.result, (e) => {
    let result: { id?: unknown; position?: Fix; error?: { code: 1 | 2 | 3; message: string } }
    try {
      const detail = (e as CustomEvent<unknown>).detail
      result = typeof detail === 'string' ? JSON.parse(detail) : (detail as typeof result)
    } catch {
      return
    }
    if (!result || typeof result.id !== 'string') return
    const entry = pending.get(result.id)
    if (!entry) return
    settle(result.id, entry)
    try {
      if (result.position) entry.success(makePosition(result.position))
      else if (result.error && typeof entry.failure === 'function')
        entry.failure(makeError(result.error.code, String(result.error.message)))
    } catch {
      /* the page's callback threw */
    }
  })

  const cleanOptions = (options: unknown): Record<string, unknown> => {
    if (!options || typeof options !== 'object') return {}
    const o = options as PositionOptions
    const out: Record<string, unknown> = {}
    if (typeof o.enableHighAccuracy === 'boolean') out.enableHighAccuracy = o.enableHighAccuracy
    if (typeof o.timeout === 'number' && Number.isFinite(o.timeout)) out.timeout = o.timeout
    if (typeof o.maximumAge === 'number' && Number.isFinite(o.maximumAge))
      out.maximumAge = o.maximumAge
    return out
  }
  const ask = (
    kind: 'get' | 'watch',
    success: Success,
    failure: Failure,
    options: unknown
  ): string => {
    const id = `geo-${++counter}`
    const clean = cleanOptions(options)
    const entry: Pending = { success, failure, watch: kind === 'watch', timer: null }
    // The standard's timeout is the page's: a watch that times out reports and keeps watching.
    const timeout = clean.timeout as number | undefined
    if (timeout !== undefined && timeout >= 0 && timeout < 0x7fffffff) {
      entry.timer = setTimeout(() => {
        entry.timer = null
        if (!entry.watch) {
          pending.delete(id)
          post({ id, kind: 'clear' })
        }
        try {
          if (typeof failure === 'function') failure(makeError(3, 'Timeout expired'))
        } catch {
          /* the page's callback threw */
        }
      }, timeout)
    }
    pending.set(id, entry)
    post({ id, kind, options: clean })
    return id
  }
  const badCallback = (name: string): TypeError =>
    new TypeError(
      `Failed to execute '${name}' on 'Geolocation': The callback provided as parameter 1 is not a function.`
    )

  define(
    proto,
    'getCurrentPosition',
    function (
      this: Geolocation,
      success: Success,
      failure?: Failure,
      options?: PositionOptions
    ): void {
      if (typeof success !== 'function') throw badCallback('getCurrentPosition')
      if (mode === 'replace') {
        ask('get', success, failure, options)
        return
      }
      nativeGet.call(
        this,
        success,
        (error) => {
          // POSITION_UNAVAILABLE from the engine's provider: try the network.
          if (error.code === 2) ask('get', success, failure, options)
          else if (typeof failure === 'function') failure(error)
        },
        options
      )
    }
  )
  define(
    proto,
    'watchPosition',
    function (
      this: Geolocation,
      success: Success,
      failure?: Failure,
      options?: PositionOptions
    ): number {
      if (typeof success !== 'function') throw badCallback('watchPosition')
      if (mode === 'replace') {
        const id = ask('watch', success, failure, options)
        const handle = ++counter
        watchIds.set(handle, id)
        return handle
      }
      let handle = 0
      handle = nativeWatch.call(
        this,
        success,
        (error) => {
          if (error.code === 2 && !watchIds.has(handle)) {
            nativeClear.call(this, handle)
            watchIds.set(handle, ask('watch', success, failure, options))
          } else if (typeof failure === 'function') failure(error)
        },
        options
      )
      return handle
    }
  )
  define(proto, 'clearWatch', function (this: Geolocation, handle: number): void {
    const id = watchIds.get(handle)
    if (id !== undefined) {
      watchIds.delete(handle)
      const entry = pending.get(id)
      if (entry) settle(id, { ...entry, watch: false })
      pending.delete(id)
      post({ id, kind: 'clear' })
    }
    if (mode !== 'replace') nativeClear.call(this, handle)
  })
}

/** The isolated-world half. */
export function installGeolocationBridge(
  transport: GeolocationBridgeTransport,
  mode: GeolocationShimMode,
  events: GeolocationShimEvents = GEOLOCATION_EVENTS
): void {
  document.addEventListener(events.request, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    let value: unknown = detail
    if (typeof detail === 'string') {
      try {
        value = JSON.parse(detail)
      } catch {
        return
      }
    }
    if (isGeolocationCall(value)) transport.send(value)
  })
  transport.onResult((result) => {
    document.dispatchEvent(new CustomEvent(events.result, { detail: JSON.stringify(result) }))
  })
  transport.installShim(events, mode)
}
