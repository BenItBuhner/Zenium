import {
  GEOLOCATION_MESSAGES,
  GEOLOCATION_PERMISSION_DENIED,
  GEOLOCATION_POSITION_UNAVAILABLE,
  isGeolocationCall,
  type GeoPosition,
  type GeolocationCall,
  type GeolocationErrorCode,
  type GeolocationOptions,
  type WifiAccessPoint
} from '../shared/geolocation'
import type { Browser } from './browser'
import type { NetHost } from './platform'

/**
 * BeaconDB's geolocate endpoint (the Ichnaea / Mozilla Location Service API, free, no key,
 * ODbL data): Wi-Fi networks in range go in, a position and its accuracy come out; without
 * networks it falls back to the address's region (`considerIp`).
 */
export const BEACONDB_GEOLOCATE_URL = 'https://api.beacondb.net/v1/geolocate'

/** A watch asks the network again this often (Chrome's network provider polls at this rate). */
export const WATCH_INTERVAL_MS = 30_000

/** Two queries closer than this share one answer (a page calling in a loop). */
const QUERY_COALESCE_MS = 5_000

/** How long a fix serves a `maximumAge: 0`-less call without a new query. */
const DEFAULT_FRESH_MS = 30_000

export interface NetworkLocationProviderOptions {
  url?: string
  now?: () => number
  timeoutMs?: number
}

/** The Ichnaea request body. */
export function geolocateBody(accessPoints: WifiAccessPoint[]): string {
  const wifiAccessPoints = accessPoints
    .filter((ap) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(ap.macAddress))
    .map((ap) => {
      const out: Record<string, unknown> = { macAddress: ap.macAddress.toLowerCase() }
      if (typeof ap.signalStrength === 'number' && Number.isFinite(ap.signalStrength))
        out.signalStrength = Math.round(ap.signalStrength)
      if (typeof ap.frequency === 'number' && Number.isFinite(ap.frequency))
        out.frequency = Math.round(ap.frequency)
      return out
    })
  return JSON.stringify({ wifiAccessPoints, considerIp: true, fallbacks: { ipf: true } })
}

/** The position in an Ichnaea answer, or null for anything else. */
export function parseGeolocateResponse(text: string, timestamp: number): GeoPosition | null {
  try {
    const body = JSON.parse(text) as {
      location?: { lat?: unknown; lng?: unknown }
      accuracy?: unknown
    }
    const lat = body.location?.lat
    const lng = body.location?.lng
    if (typeof lat !== 'number' || typeof lng !== 'number') return null
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    const accuracy =
      typeof body.accuracy === 'number' && Number.isFinite(body.accuracy) && body.accuracy >= 0
        ? body.accuracy
        : 50_000
    return { latitude: lat, longitude: lng, accuracy, timestamp }
  } catch {
    return null
  }
}

/**
 * A network location provider: the host's Wi-Fi scan (when it has one) plus BeaconDB. Answers
 * are cached; concurrent and back-to-back queries share one request.
 */
export class NetworkLocationProvider {
  private last: GeoPosition | null = null
  private inFlight: Promise<GeoPosition | null> | null = null
  private lastQueryAt = -Infinity
  private readonly url: string
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(
    private readonly net: NetHost,
    private readonly scan: () => Promise<WifiAccessPoint[]>,
    options: NetworkLocationProviderOptions = {}
  ) {
    this.url = options.url ?? BEACONDB_GEOLOCATE_URL
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /** The last fix, if it is at most `maximumAge` ms old. */
  cached(maximumAge: number): GeoPosition | null {
    if (!this.last) return null
    return this.now() - this.last.timestamp <= maximumAge ? this.last : null
  }

  locate(): Promise<GeoPosition | null> {
    if (this.inFlight) return this.inFlight
    if (this.last && this.now() - this.lastQueryAt < QUERY_COALESCE_MS)
      return Promise.resolve(this.last)
    this.lastQueryAt = this.now()
    this.inFlight = this.query().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async query(): Promise<GeoPosition | null> {
    let accessPoints: WifiAccessPoint[] = []
    try {
      accessPoints = await this.scan()
    } catch {
      /* no scanner: the address alone locates, coarsely */
    }
    try {
      const response = await this.net.fetchText(this.url, {
        method: 'POST',
        body: geolocateBody(accessPoints),
        headers: { 'content-type': 'application/json' },
        timeoutMs: this.timeoutMs
      })
      if (!response.ok) return null
      const position = parseGeolocateResponse(response.text, this.now())
      if (position) this.last = position
      return position
    } catch {
      return null
    }
  }
}

interface Watch {
  tabId: string
  options: GeolocationOptions
  timer: ReturnType<typeof setTimeout> | null
}

export interface GeolocationServiceOptions {
  provider?: NetworkLocationProvider
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Geolocation for pages whose engine has no provider (MW-04): the page's shim asks here, the
 * site's permission is decided by the shared permission service (the same prompt, rules and
 * Settings row as everywhere else), and the network provider answers. A watch re-asks the
 * network every `WATCH_INTERVAL_MS` until the page clears it or leaves.
 */
export class GeolocationService {
  private readonly provider: NetworkLocationProvider
  private readonly watches = new Map<string, Watch>()
  private readonly now: () => number
  private readonly setTimer: NonNullable<GeolocationServiceOptions['setTimer']>
  private readonly clearTimer: NonNullable<GeolocationServiceOptions['clearTimer']>

  constructor(
    private readonly browser: Browser,
    options: GeolocationServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.provider =
      options.provider ??
      new NetworkLocationProvider(
        browser.platform.net,
        () => browser.platform.geolocation?.scanWifi() ?? Promise.resolve([]),
        { now: this.now }
      )
  }

  /** The page's shim asked. */
  handleMessage(tabId: string, call: unknown): void {
    if (!isGeolocationCall(call)) return
    if (!this.browser.tabs.view(tabId)) return
    const key = `${tabId}:${call.id}`
    switch (call.kind) {
      case 'get':
        void this.answer(tabId, call, true)
        return
      case 'watch': {
        this.stopWatch(key)
        this.watches.set(key, { tabId, options: call.options ?? {}, timer: null })
        void this.answer(tabId, call, true)
        return
      }
      case 'clear':
        this.stopWatch(key)
        return
    }
  }

  private async answer(tabId: string, call: GeolocationCall, first: boolean): Promise<void> {
    const key = `${tabId}:${call.id}`
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const url = tab.url
    const watching = call.kind === 'watch'
    // The first call may prompt; a watch's later rounds only read the decision, so a dismissed
    // prompt is not asked again every half minute.
    const allowed = first
      ? await this.browser.permissions.decide('geolocation', url, { tabId })
      : this.browser.permissions.check('geolocation', url, { tabId })
    if (watching && !this.watches.has(key)) return
    if (!allowed) {
      this.post(tabId, url, call.id, GEOLOCATION_PERMISSION_DENIED)
      this.stopWatch(key)
      return
    }
    const maximumAge = call.options?.maximumAge
    const cached = this.provider.cached(
      typeof maximumAge === 'number' ? Math.max(0, maximumAge) : DEFAULT_FRESH_MS
    )
    const position = cached ?? (await this.provider.locate())
    if (watching && !this.watches.has(key)) return
    if (position) this.post(tabId, url, call.id, position)
    else this.post(tabId, url, call.id, GEOLOCATION_POSITION_UNAVAILABLE)
    if (watching) {
      const watch = this.watches.get(key)
      if (!watch) return
      watch.timer = this.setTimer(() => {
        watch.timer = null
        void this.answer(tabId, call, false)
      }, WATCH_INTERVAL_MS)
    }
  }

  /** The answer, to the page that asked – not to a document that has since replaced it. */
  private post(
    tabId: string,
    url: string,
    id: string,
    result: GeoPosition | GeolocationErrorCode
  ): void {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view || view.isDestroyed()) return
    if (!sameSite(tab.url, url)) return
    if (typeof result === 'number')
      view.postToPage?.({
        type: 'geolocation',
        id,
        error: { code: result, message: GEOLOCATION_MESSAGES[result] }
      })
    else view.postToPage?.({ type: 'geolocation', id, position: result })
  }

  private stopWatch(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    if (watch.timer !== null) this.clearTimer(watch.timer)
    this.watches.delete(key)
  }

  /** How many watches a tab holds (tests, diagnostics). */
  watchCount(tabId: string): number {
    let n = 0
    for (const watch of this.watches.values()) if (watch.tabId === tabId) n++
    return n
  }

  /** A new document has no watches (an in-page navigation keeps them). */
  onNavigated(tabId: string, inPage: boolean): void {
    if (!inPage) this.onTabGone(tabId)
  }

  onTabGone(tabId: string): void {
    for (const [key, watch] of [...this.watches]) if (watch.tabId === tabId) this.stopWatch(key)
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return a === b
  }
}
