import { describe, expect, it, vi } from 'vitest'
import { ScreenCaptureService, tabIdOfSource, tabSource } from '../screenCapture'
import type { Browser } from '../browser'
import type { ScreenCaptureHost } from '../platform'
import type { ScreenCaptureSource, Tab } from '../../shared/types'
import type { ZenWindow } from '../window'

const SCREEN: ScreenCaptureSource = {
  id: 'screen:0:0',
  name: 'Entire screen',
  kind: 'screen',
  thumbnail: 'data:image/jpeg;base64,AAA',
  icon: null
}
const WINDOW: ScreenCaptureSource = {
  id: 'window:12:0',
  name: 'Notes',
  kind: 'window',
  thumbnail: null,
  icon: 'data:image/png;base64,BBB'
}

interface Harness {
  service: ScreenCaptureService
  browser: Browser
  commits: () => number
  host: ScreenCaptureHost & { calls: number; resolve: (sources: ScreenCaptureSource[]) => void }
}

function harness(
  options: { host?: boolean; systemAudio?: boolean; picker?: boolean } = {}
): Harness {
  const commit = vi.fn()
  // The window's chrome has the picker up unless a test says otherwise (`ui.surface`).
  const win = {
    id: 'w1',
    surfaces: new Set(options.picker === false ? [] : ['screenCapture'])
  } as unknown as ZenWindow
  const tabs: Record<string, Tab> = {
    t1: { id: 't1', title: 'Meet', url: 'https://meet.example/room', favicon: null } as Tab,
    t2: { id: 't2', title: 'Docs', url: 'https://docs.example/', favicon: 'data:x' } as Tab,
    t3: { id: 't3', title: 'Asleep', url: 'https://sleep.example/', favicon: null } as Tab
  }
  let resolveSources: (sources: ScreenCaptureSource[]) => void = () => undefined
  const host = {
    calls: 0,
    resolve: (sources: ScreenCaptureSource[]) => resolveSources(sources),
    sources: () => {
      host.calls++
      return new Promise<ScreenCaptureSource[]>((resolve) => {
        resolveSources = resolve
      })
    },
    systemAudio: () => options.systemAudio ?? false
  }
  const browser = {
    platform: { screenCapture: options.host === false ? undefined : host },
    state: { commitVolatile: commit },
    tabs: {
      tab: (id: string) => tabs[id],
      ownerOf: (id: string) => (tabs[id] ? win : undefined),
      viewsOwnedBy: () =>
        new Map([
          ['t1', { isDestroyed: () => false }],
          ['t2', { isDestroyed: () => false }],
          ['t3', { isDestroyed: () => true }]
        ])
    }
  }
  const service = new ScreenCaptureService(browser as unknown as Browser, {
    now: () => 1_700_000_000_000
  })
  return {
    service,
    browser: browser as unknown as Browser,
    commits: () => commit.mock.calls.length,
    host
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('ScreenCaptureService', () => {
  it('puts up a request with the calling tab first, then the live tabs of its window, and loads the OS list', async () => {
    const h = harness()
    const answer = h.service.request({ tabId: 't1', url: 'https://meet.example/room', audio: true })
    const [request] = h.service.list()
    expect(request).toMatchObject({
      tabId: 't1',
      origin: 'meet.example',
      audio: true,
      systemAudio: false,
      loading: true
    })
    expect(request.sources.map((s) => s.id)).toEqual(['tab:t1', 'tab:t2'])
    expect(request.sources[0].name).toBe('Meet')
    expect(h.host.calls).toBe(1)
    h.host.resolve([SCREEN, WINDOW])
    await flush()
    const [loaded] = h.service.list()
    expect(loaded.loading).toBe(false)
    expect(loaded.sources.map((s) => s.id)).toEqual([
      'screen:0:0',
      'window:12:0',
      'tab:t1',
      'tab:t2'
    ])
    h.service.respond(loaded.id, 'window:12:0', true)
    // Audio never rides along with a window.
    expect(await answer).toEqual({ sourceId: 'window:12:0', audio: false })
    expect(h.service.list()).toEqual([])
  })

  it('grants system audio for a screen only where the OS offers it and the page asked', async () => {
    const withLoopback = harness({ systemAudio: true })
    const a = withLoopback.service.request({
      tabId: 't1',
      url: 'https://meet.example/',
      audio: true
    })
    withLoopback.host.resolve([SCREEN])
    await flush()
    const [request] = withLoopback.service.list()
    expect(request.systemAudio).toBe(true)
    withLoopback.service.respond(request.id, 'screen:0:0', true)
    expect(await a).toEqual({ sourceId: 'screen:0:0', audio: true })

    const silent = harness({ systemAudio: true })
    const b = silent.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    silent.host.resolve([SCREEN])
    await flush()
    const [quiet] = silent.service.list()
    expect(quiet.systemAudio).toBe(false)
    silent.service.respond(quiet.id, 'screen:0:0', true)
    expect(await b).toEqual({ sourceId: 'screen:0:0', audio: false })
  })

  it('refuses on cancel, on an unknown source and when the tab navigates or closes', async () => {
    const h = harness()
    const cancelled = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    h.service.respond(h.service.list()[0].id, null)
    expect(await cancelled).toEqual({ sourceId: null, audio: false })

    const forged = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    h.service.respond(h.service.list()[0].id, 'screen:9:9')
    expect(await forged).toEqual({ sourceId: null, audio: false })

    const navigated = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    const other = h.service.request({ tabId: 't2', url: 'https://docs.example/', audio: false })
    h.service.cancelForTab('t1')
    expect(await navigated).toEqual({ sourceId: null, audio: false })
    expect(h.service.list().map((r) => r.tabId)).toEqual(['t2'])
    h.service.respond(h.service.list()[0].id, 'tab:t1')
    expect(await other).toEqual({ sourceId: 'tab:t1', audio: false })
  })

  it('keeps one picker per tab: a second call from the same tab cancels the first', async () => {
    const h = harness()
    const first = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    const second = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    expect(await first).toEqual({ sourceId: null, audio: false })
    expect(h.service.list()).toHaveLength(1)
    h.service.respond(h.service.list()[0].id, 'tab:t2')
    expect(await second).toEqual({ sourceId: 'tab:t2', audio: false })
  })

  it('answers a tab that is gone and a host that fails without a picker hanging', async () => {
    const h = harness()
    expect(await h.service.request({ tabId: 'zz', url: 'https://x/', audio: false })).toEqual({
      sourceId: null,
      audio: false
    })
    const failing = harness()
    failing.host.sources = () => {
      failing.host.calls++
      return Promise.reject(new Error('portal refused'))
    }
    void failing.service.request({ tabId: 't1', url: 'https://meet.example/', audio: false })
    await flush()
    const [request] = failing.service.list()
    expect(request.loading).toBe(false)
    expect(request.sources.map((s) => s.kind)).toEqual(['tab', 'tab'])
    // Without any host the request is complete at once.
    const hostless = harness({ host: false })
    void hostless.service.request({ tabId: 't1', url: 'https://meet.example/', audio: true })
    expect(hostless.service.list()[0]).toMatchObject({ loading: false, systemAudio: false })
  })

  it('refuses at once, as a cancelled picker, while the window has no picker up', async () => {
    const h = harness({ picker: false })
    const answer = h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: true })
    // Nothing is put up to wait on: no request in state, no OS list asked for.
    expect(h.service.list()).toEqual([])
    expect(h.commits()).toBe(0)
    expect(h.host.calls).toBe(0)
    expect(await answer).toEqual({ sourceId: null, audio: false })
    // The picker mounting (`ui.surface`) lets the next call through to it.
    ;(h.browser.tabs.ownerOf('t1') as ZenWindow).surfaces.add('screenCapture')
    void h.service.request({ tabId: 't1', url: 'https://meet.example/', audio: true })
    expect(h.service.list()).toHaveLength(1)
    expect(h.host.calls).toBe(1)
  })

  it('names tab sources and reads them back', () => {
    expect(tabSource({ id: 'abc', title: '', favicon: null })).toEqual({
      id: 'tab:abc',
      name: 'This tab',
      kind: 'tab',
      thumbnail: null,
      icon: null
    })
    expect(tabIdOfSource('tab:abc')).toBe('abc')
    expect(tabIdOfSource('screen:0:0')).toBeNull()
  })
})
