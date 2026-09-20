import { describe, expect, it } from 'vitest'
import {
  BEACONDB_GEOLOCATE_URL,
  GeolocationService,
  NetworkLocationProvider,
  WATCH_INTERVAL_MS,
  geolocateBody,
  parseGeolocateResponse
} from '../geolocation'
import type { Browser } from '../browser'
import type { NetHost, PageHostMessage } from '../platform'
import type { Tab } from '../../shared/types'
import type { GeoPosition, WifiAccessPoint } from '../../shared/geolocation'

const T0 = 1_700_000_000_000
const FIX = JSON.stringify({ location: { lat: 52.52, lng: 13.405 }, accuracy: 120 })
const APS: WifiAccessPoint[] = [
  { macAddress: 'aa:bb:cc:dd:ee:ff', signalStrength: -61.4, frequency: 2412 },
  { macAddress: 'not-a-mac' }
]

interface FakeNet {
  net: NetHost
  requests: Array<{ url: string; method?: string; body?: string }>
  answer: { ok: boolean; text: string }
}

function fakeNet(text = FIX): FakeNet {
  const state: FakeNet = {
    requests: [],
    answer: { ok: true, text },
    net: {} as NetHost
  }
  state.net = {
    fetchText: async (url, options) => {
      state.requests.push({ url, method: options.method, body: options.body })
      return {
        ok: state.answer.ok,
        status: state.answer.ok ? 200 : 500,
        text: state.answer.text,
        headers: {}
      }
    },
    resolveHost: async () => true
  }
  return state
}

describe('NetworkLocationProvider', () => {
  it('posts the Wi-Fi networks in the Ichnaea shape and reads the position back', async () => {
    const now = { value: T0 }
    const f = fakeNet()
    const provider = new NetworkLocationProvider(f.net, async () => APS, { now: () => now.value })
    const position = await provider.locate()
    expect(position).toEqual({ latitude: 52.52, longitude: 13.405, accuracy: 120, timestamp: T0 })
    expect(f.requests[0].url).toBe(BEACONDB_GEOLOCATE_URL)
    expect(f.requests[0].method).toBe('POST')
    expect(JSON.parse(f.requests[0].body ?? '')).toEqual({
      wifiAccessPoints: [{ macAddress: 'aa:bb:cc:dd:ee:ff', signalStrength: -61, frequency: 2412 }],
      considerIp: true,
      fallbacks: { ipf: true }
    })
  })

  it('shares one request between concurrent and back-to-back calls and serves a fresh fix from cache', async () => {
    const now = { value: T0 }
    const f = fakeNet()
    const provider = new NetworkLocationProvider(f.net, async () => [], { now: () => now.value })
    const [a, b] = await Promise.all([provider.locate(), provider.locate()])
    expect(a).toEqual(b)
    expect(f.requests).toHaveLength(1)
    now.value = T0 + 2_000
    await provider.locate()
    expect(f.requests).toHaveLength(1)
    expect(provider.cached(5_000)?.latitude).toBe(52.52)
    expect(provider.cached(1_000)).toBeNull()
    now.value = T0 + 20_000
    await provider.locate()
    expect(f.requests).toHaveLength(2)
  })

  it('locates by the address alone when the scanner fails, and gives null on a refused answer', async () => {
    const f = fakeNet()
    const provider = new NetworkLocationProvider(
      f.net,
      () => Promise.reject(new Error('no nmcli')),
      {
        now: () => T0
      }
    )
    expect(await provider.locate()).not.toBeNull()
    expect(JSON.parse(f.requests[0].body ?? '').wifiAccessPoints).toEqual([])
    const refused = fakeNet('')
    refused.answer.ok = false
    const p2 = new NetworkLocationProvider(refused.net, async () => [], { now: () => T0 })
    expect(await p2.locate()).toBeNull()
  })

  it('parses only sane answers', () => {
    expect(parseGeolocateResponse(FIX, 5)?.accuracy).toBe(120)
    expect(parseGeolocateResponse('{"location":{"lat":91,"lng":0}}', 5)).toBeNull()
    expect(parseGeolocateResponse('{"location":{"lat":1,"lng":2}}', 5)?.accuracy).toBe(50_000)
    expect(parseGeolocateResponse('nope', 5)).toBeNull()
    expect(geolocateBody([])).toContain('"wifiAccessPoints":[]')
  })
})

interface Harness {
  service: GeolocationService
  posted: PageHostMessage[]
  decisions: Array<{ permission: string; url: string }>
  timers: Array<{ fn: () => void; ms: number }>
  tab: Tab
  allow: { value: boolean }
  net: FakeNet
}

function harness(): Harness {
  const posted: PageHostMessage[] = []
  const decisions: Harness['decisions'] = []
  const timers: Harness['timers'] = []
  const allow = { value: true }
  const net = fakeNet()
  const tab = { id: 't1', url: 'https://maps.example/', title: 'Maps' } as Tab
  const browser = {
    platform: { net: net.net, geolocation: { scanWifi: async () => APS } },
    tabs: {
      tab: (id: string) => (id === 't1' ? tab : undefined),
      view: (id: string) =>
        id === 't1'
          ? { isDestroyed: () => false, postToPage: (m: PageHostMessage) => posted.push(m) }
          : undefined
    },
    permissions: {
      decide: async (permission: string, url: string) => {
        decisions.push({ permission, url })
        return allow.value
      },
      check: () => allow.value
    }
  }
  const service = new GeolocationService(browser as unknown as Browser, {
    now: () => T0,
    setTimer: (fn, ms) => {
      // Like `setTimeout`: a fired timer is gone from the pending list.
      const timer: Harness['timers'][number] = {
        ms,
        fn: () => {
          const index = timers.indexOf(timer)
          if (index >= 0) timers.splice(index, 1)
          fn()
        }
      }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as unknown as Harness['timers'][number])
      if (index >= 0) timers.splice(index, 1)
    }
  })
  return { service, posted, decisions, timers, tab, allow, net }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('GeolocationService', () => {
  it('asks the shared permission service once and answers the page with the network fix', async () => {
    const h = harness()
    h.service.handleMessage('t1', { id: 'g1', kind: 'get' })
    await flush()
    expect(h.decisions).toEqual([{ permission: 'geolocation', url: 'https://maps.example/' }])
    expect(h.posted).toEqual([
      {
        type: 'geolocation',
        id: 'g1',
        position: {
          latitude: 52.52,
          longitude: 13.405,
          accuracy: 120,
          timestamp: T0
        } as GeoPosition
      }
    ])
  })

  it('refuses with PERMISSION_DENIED when the site is not allowed and POSITION_UNAVAILABLE when the network has nothing', async () => {
    const h = harness()
    h.allow.value = false
    h.service.handleMessage('t1', { id: 'g1', kind: 'get' })
    await flush()
    expect(h.posted[0]).toMatchObject({ id: 'g1', error: { code: 1 } })

    const cold = harness()
    cold.net.answer = { ok: true, text: '{}' }
    cold.service.handleMessage('t1', { id: 'g2', kind: 'get' })
    await flush()
    expect(cold.posted[0]).toMatchObject({ id: 'g2', error: { code: 2 } })
  })

  it('keeps a watch alive on the network interval until it is cleared or the document goes', async () => {
    const h = harness()
    h.service.handleMessage('t1', { id: 'w1', kind: 'watch' })
    await flush()
    expect(h.posted).toHaveLength(1)
    expect(h.service.watchCount('t1')).toBe(1)
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBe(WATCH_INTERVAL_MS)
    // The next round reads the decision without a prompt.
    h.timers[0].fn()
    await flush()
    expect(h.posted).toHaveLength(2)
    expect(h.decisions).toHaveLength(1)
    h.service.handleMessage('t1', { id: 'w1', kind: 'clear' })
    expect(h.service.watchCount('t1')).toBe(0)
    expect(h.timers).toEqual([])

    h.service.handleMessage('t1', { id: 'w2', kind: 'watch' })
    await flush()
    h.service.onNavigated('t1', true)
    expect(h.service.watchCount('t1')).toBe(1)
    h.service.onNavigated('t1', false)
    expect(h.service.watchCount('t1')).toBe(0)
  })

  it('drops malformed calls, calls from unknown tabs and answers for a document that moved on', async () => {
    const h = harness()
    h.service.handleMessage('t1', { id: 'x', kind: 'fly' })
    h.service.handleMessage('t9', { id: 'g1', kind: 'get' })
    await flush()
    expect(h.posted).toEqual([])
    h.service.handleMessage('t1', { id: 'g1', kind: 'get' })
    h.tab.url = 'https://other.example/'
    await flush()
    expect(h.posted).toEqual([])
  })
})
