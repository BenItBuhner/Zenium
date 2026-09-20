import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CAPTURE_CANCELLED,
  DESKTOP_CAPTURE_INVALID_TAB_ERROR,
  DESKTOP_CAPTURE_NO_SOURCES_ERROR,
  DESKTOP_CAPTURE_SOURCE_TYPES,
  TAB_CAPTURE_FINDING_TAB_ERROR,
  TAB_CAPTURE_GRANT_ERROR,
  TAB_CAPTURE_INVALID_TAB_ERROR,
  TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR,
  TAB_CAPTURE_NO_DOCUMENT_ERROR,
  TAB_CAPTURE_SAME_TAB_ERROR,
  TAB_CAPTURE_STATES,
  TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR,
  isCapturableUrl,
  isPotentiallyTrustworthyUrl,
  normalizeCaptureOptions,
  normalizeDesktopSources,
  normalizeStreamIdOptions,
  withTabSourceConstraints
} from '../api/tabCapture'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC, TAB_CAPTURE_INTERNAL_METHODS } from '../api/spec'
import { TabCaptureApi, type StreamRegistrar } from '../../../main/platform/extensionApi/tabCapture'
import type { ActiveTabGrants } from '../../../main/platform/extensionApi/activeTab'
import type { ApiContext, ApiHost } from '../../../main/platform/extensionApi/types'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'

/** The engine's page object as the registrar sees it (core tests may not import Electron). */
type WebContents = Parameters<StreamRegistrar['register']>[0]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

// ---------------------------------------------------------------------------
// Pure: Chrome's checks on the parameters, the constraints it hands the binding
// ---------------------------------------------------------------------------

describe('tabCapture parameters', () => {
  it("capture's options: booleans, constraint objects, and at least one of audio and video", () => {
    expect(normalizeCaptureOptions({ audio: true })).toEqual({ audio: true, video: false })
    expect(
      normalizeCaptureOptions({
        video: true,
        videoConstraints: { mandatory: { maxWidth: 1280 }, optional: { minFrameRate: 30 } },
        presentationId: 'p'
      })
    ).toEqual({
      audio: false,
      video: true,
      videoConstraints: { mandatory: { maxWidth: 1280 }, optional: { minFrameRate: 30 } },
      presentationId: 'p'
    })
    expect(() => normalizeCaptureOptions(null)).toThrow(/No matching signature/)
    expect(() => normalizeCaptureOptions({ audio: 'yes' })).toThrow(
      /property 'audio': Invalid type: expected boolean, found string/
    )
    expect(() => normalizeCaptureOptions({ audio: true, audioConstraints: 3 })).toThrow(
      /property 'audioConstraints': Invalid type: expected object, found number/
    )
    expect(() => normalizeCaptureOptions({})).toThrow(TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR)
    expect(() => normalizeCaptureOptions({ audio: false, video: false })).toThrow(
      TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR
    )
  })

  it("getMediaStreamId's options: two optional integers, absent options allowed", () => {
    expect(normalizeStreamIdOptions(undefined)).toEqual({})
    expect(normalizeStreamIdOptions({ targetTabId: 4, consumerTabId: 9 })).toEqual({
      targetTabId: 4,
      consumerTabId: 9
    })
    expect(() => normalizeStreamIdOptions({ targetTabId: '4' })).toThrow(
      /property 'targetTabId': Invalid type: expected integer, found string/
    )
    expect(() => normalizeStreamIdOptions(7)).toThrow(/No matching signature/)
  })

  it("adds Chrome's source constraints to each requested kind, keeping the caller's", () => {
    const out = withTabSourceConstraints(
      { audio: true, video: true, videoConstraints: { mandatory: { maxWidth: 640 } } },
      'stream-1'
    )
    expect(out.audioConstraints).toEqual({
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-1' }
    })
    expect(out.videoConstraints).toEqual({
      mandatory: { maxWidth: 640, chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-1' }
    })
    expect(withTabSourceConstraints({ audio: true, video: false }, 'x').videoConstraints).toBe(
      undefined
    )
  })

  it('captures web pages and files, never the browser’s own pages', () => {
    expect(isCapturableUrl('https://example.com/')).toBe(true)
    expect(isCapturableUrl('http://localhost:3000/')).toBe(true)
    expect(isCapturableUrl('file:///tmp/a.html')).toBe(true)
    expect(isCapturableUrl('zen://settings')).toBe(false)
    expect(isCapturableUrl('chrome://extensions')).toBe(false)
    expect(isCapturableUrl('about:blank')).toBe(false)
    expect(isCapturableUrl('not a url')).toBe(false)
  })

  it('trusts secure, extension, file and loopback consumers only', () => {
    expect(isPotentiallyTrustworthyUrl('https://app.example/')).toBe(true)
    expect(isPotentiallyTrustworthyUrl(`chrome-extension://${EXT}/page.html`)).toBe(true)
    expect(isPotentiallyTrustworthyUrl('http://localhost:8080/')).toBe(true)
    expect(isPotentiallyTrustworthyUrl('http://127.0.0.1/')).toBe(true)
    expect(isPotentiallyTrustworthyUrl('http://example.com/')).toBe(false)
  })

  it("desktopCapture's sources: the enum's values, at least one", () => {
    expect(normalizeDesktopSources(['screen', 'window', 'screen'])).toEqual(['screen', 'window'])
    expect(() => normalizeDesktopSources('screen')).toThrow(/No matching signature/)
    expect(() => normalizeDesktopSources(['screen', 'camera'])).toThrow(
      /Error at index 1: Value must be one of screen, window, tab, audio/
    )
    expect(() => normalizeDesktopSources([])).toThrow(DESKTOP_CAPTURE_NO_SOURCES_ERROR)
  })

  it('is in the desktop spec, gated on the permissions, with Chrome’s enums', () => {
    expect(API_SPEC.tabCapture.permissions).toEqual(['tabCapture'])
    expect(Object.keys(API_SPEC.tabCapture.methods).sort()).toEqual([
      'capture',
      'getCapturedTabs',
      'getMediaStreamId'
    ])
    expect(Object.keys(API_SPEC.tabCapture.events)).toEqual(['onStatusChanged'])
    expect(
      Object.values(
        (API_SPEC.tabCapture.constants as Record<string, Record<string, string>>).TabCaptureState
      )
    ).toEqual([...TAB_CAPTURE_STATES])
    expect(API_SPEC.desktopCapture.permissions).toEqual(['desktopCapture'])
    expect(
      Object.values(
        (API_SPEC.desktopCapture.constants as Record<string, Record<string, string>>)
          .DesktopCaptureSourceType
      )
    ).toEqual([...DESKTOP_CAPTURE_SOURCE_TYPES])
    expect(TAB_CAPTURE_INTERNAL_METHODS).toEqual(['resolveStreamId', 'streamState'])
  })
})

// ---------------------------------------------------------------------------
// Router over a fake model, grants and stream registry
// ---------------------------------------------------------------------------

interface FakeWebContents {
  id: number
  destroyed: boolean
  once(event: string, fn: () => void): void
  destroy(): void
}

function fakeWebContents(id: number): FakeWebContents {
  const listeners: Array<() => void> = []
  const wc: FakeWebContents = {
    id,
    destroyed: false,
    once: (event, fn) => {
      if (event === 'destroyed') listeners.push(fn)
    },
    destroy: () => {
      wc.destroyed = true
      for (const fn of listeners.splice(0)) fn()
    }
  }
  return wc
}

interface World {
  api: TabCaptureApi
  dispatched: Array<{ extensionId: string; event: string; args: unknown[] }>
  registered: Array<{ target: number; consumer: number; id: string }>
  grant(extensionId: string, chromeTabId: number): void
  addTab(zenId: string, chromeId: number, url: string): { tab: Tab; wc: FakeWebContents }
  page(id: number): FakeWebContents
  workerCtx(extensionId?: string): ApiContext
  frameCtx(wc: FakeWebContents, extensionId?: string, parent?: unknown): ApiContext
  clock: { now: number }
  win: ZenWindow
}

function world(): World {
  const tabs = new Map<string, Tab>()
  const chromeIds = new Map<string, number>()
  const contents = new Map<string, FakeWebContents>()
  const pages = new Map<number, FakeWebContents>()
  const win = { id: 'w1', htmlFullscreenTabId: null as string | null } as unknown as ZenWindow
  let active: Tab | undefined
  const grants = new Set<string>()
  const dispatched: World['dispatched'] = []
  const registered: World['registered'] = []
  const clock = { now: 1_000 }
  let engineIds = 0
  const model = {
    tab: (zenId: string) => tabs.get(zenId),
    zenTab: (chromeId: number) => [...tabs.values()].find((t) => chromeIds.get(t.id) === chromeId),
    chromeTabId: (tab: Tab) => chromeIds.get(tab.id) ?? -1,
    webContentsOf: (tab: Tab) => contents.get(tab.id) as unknown as WebContents | undefined,
    windowOfTab: () => win,
    lastFocusedWindow: () => win
  }
  const host = {
    model,
    browser: { tabs: { activeTabFor: () => active } },
    dispatch: (extensionId: string, _namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ extensionId, event, args })
    }
  } as unknown as ApiHost
  const activeTab = {
    allowsCapture: (extensionId: string, chromeTabId: number) =>
      grants.has(`${extensionId}:${chromeTabId}`)
  } as unknown as ActiveTabGrants
  const registrar: StreamRegistrar = {
    register: (target, consumer) => {
      engineIds += 1
      const id = `engine-${engineIds}`
      registered.push({ target: target.id, consumer: consumer.id, id })
      return id
    },
    alive: (id) => {
      const wc = pages.get(id) ?? [...contents.values()].find((c) => c.id === id)
      return wc !== undefined && !wc.destroyed
    }
  }
  const api = new TabCaptureApi(host, activeTab, registrar, () => clock.now)
  return {
    api,
    dispatched,
    registered,
    clock,
    win,
    grant: (extensionId, chromeTabId) => grants.add(`${extensionId}:${chromeTabId}`),
    addTab: (zenId, chromeId, url) => {
      const tab = { id: zenId, url } as unknown as Tab
      // A Chrome tab id is the tab's WebContents id (`ApiModel.chromeTabId`).
      const wc = fakeWebContents(chromeId)
      tabs.set(zenId, tab)
      chromeIds.set(zenId, chromeId)
      contents.set(zenId, wc)
      active ??= tab
      return { tab, wc }
    },
    page: (id) => {
      const wc = fakeWebContents(id)
      pages.set(id, wc)
      return wc
    },
    workerCtx: (extensionId = EXT) =>
      ({ extensionId, sender: { kind: 'worker' }, window: undefined }) as unknown as ApiContext,
    frameCtx: (wc, extensionId = EXT, parent = null) =>
      ({
        extensionId,
        sender: { kind: 'frame', webContents: wc, frame: { parent } },
        window: win
      }) as unknown as ApiContext
  }
}

describe('TabCaptureApi', () => {
  it('getMediaStreamId from the worker answers an id of this layer; the offscreen document redeems it', () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    const streamId = w.api.handlers.getMediaStreamId(w.workerCtx(), undefined) as string
    expect(streamId).toMatch(/^zen-tab-capture-/)
    expect(w.registered).toHaveLength(0)
    // Not yet: no consumer has registered the stream.
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    const offscreen = w.page(77)
    const engineId = w.api.handlers.resolveStreamId(w.frameCtx(offscreen), streamId)
    expect(engineId).toBe('engine-1')
    expect(w.registered).toEqual([{ target: target.id, consumer: 77, id: 'engine-1' }])
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(true)
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${OTHER}`)
    ).toBe(false)
    expect(w.api.allowsMediaRequest(target as unknown as WebContents, undefined)).toBe(false)
    // Anonymous: no status events, absent from getCapturedTabs.
    w.api.handlers.streamState(w.frameCtx(offscreen), streamId, 'active')
    expect(w.dispatched).toEqual([])
    expect(w.api.handlers.getCapturedTabs(w.workerCtx())).toEqual([])
    // The consuming document going away ends the capture; the tab is free again.
    offscreen.destroy()
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    expect(() => w.api.handlers.getMediaStreamId(w.workerCtx(), {})).not.toThrow()
  })

  it("refuses without the user's invocation on the tab, and on the browser's own pages", () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    expect(() => w.api.handlers.getMediaStreamId(w.workerCtx(), undefined)).toThrow(
      TAB_CAPTURE_GRANT_ERROR
    )
    w.grant(EXT, 5)
    expect(() => w.api.handlers.getMediaStreamId(w.workerCtx(), { targetTabId: 9 })).toThrow(
      TAB_CAPTURE_INVALID_TAB_ERROR
    )
    w.addTab('t2', 6, 'zen://settings')
    w.grant(EXT, 6)
    expect(() => w.api.handlers.getMediaStreamId(w.workerCtx(), { targetTabId: 6 })).toThrow(
      TAB_CAPTURE_GRANT_ERROR
    )
    // Another extension's grant does not carry over.
    expect(() => w.api.handlers.getMediaStreamId(w.workerCtx(OTHER), { targetTabId: 5 })).toThrow(
      TAB_CAPTURE_GRANT_ERROR
    )
  })

  it('a consumer tab is registered at once and must be secure', () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    const { wc: consumer } = w.addTab('t2', 6, 'https://app.example/record')
    w.addTab('t3', 7, 'http://plain.example/')
    w.grant(EXT, 5)
    expect(() =>
      w.api.handlers.getMediaStreamId(w.workerCtx(), { targetTabId: 5, consumerTabId: 7 })
    ).toThrow(TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR)
    const id = w.api.handlers.getMediaStreamId(w.workerCtx(), {
      targetTabId: 5,
      consumerTabId: 6
    })
    expect(id).toBe('engine-1')
    expect(w.registered).toEqual([{ target: target.id, consumer: consumer.id, id: 'engine-1' }])
    expect(w.api.allowsMediaRequest(target as unknown as WebContents, 'https://app.example')).toBe(
      true
    )
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, 'https://other.example')
    ).toBe(false)
    // The engine's id passes through the shim's resolution untouched.
    expect(w.api.handlers.resolveStreamId(w.frameCtx(consumer), 'engine-1')).toBe('engine-1')
    expect(w.api.handlers.resolveStreamId(w.frameCtx(consumer), 'unknown-id')).toBe('unknown-id')
  })

  it('capture from a popup: the options come back with the source constraints, status follows the stream', () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    const popup = w.page(31)
    expect(() => w.api.handlers.capture(w.workerCtx(), { audio: true })).toThrow(
      TAB_CAPTURE_NO_DOCUMENT_ERROR
    )
    expect(() => w.api.handlers.capture(w.frameCtx(popup), {})).toThrow(
      TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR
    )
    const answer = w.api.handlers.capture(w.frameCtx(popup), { audio: true }) as Any
    const streamId = answer.audioConstraints.mandatory.chromeMediaSourceId as string
    expect(answer).toEqual({
      audio: true,
      video: false,
      audioConstraints: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    })
    expect(streamId).toMatch(/^zen-tab-capture-/)
    // Only the popup itself may redeem it, from its main frame.
    const stranger = w.page(32)
    expect(() => w.api.handlers.resolveStreamId(w.frameCtx(stranger), streamId)).toThrow(
      TAB_CAPTURE_INVALID_TAB_ERROR
    )
    expect(() => w.api.handlers.resolveStreamId(w.frameCtx(popup, OTHER), streamId)).toThrow(
      TAB_CAPTURE_INVALID_TAB_ERROR
    )
    expect(() => w.api.handlers.resolveStreamId(w.frameCtx(popup, EXT, {}), streamId)).toThrow(
      TAB_CAPTURE_INVALID_TAB_ERROR
    )
    expect(w.api.handlers.resolveStreamId(w.frameCtx(popup), streamId)).toBe('engine-1')
    expect(w.registered).toEqual([{ target: target.id, consumer: 31, id: 'engine-1' }])
    expect(w.dispatched).toEqual([
      {
        extensionId: EXT,
        event: 'onStatusChanged',
        args: [{ tabId: 5, status: 'pending', fullscreen: false }]
      }
    ])
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(popup))).toEqual([
      { tabId: 5, status: 'pending', fullscreen: false }
    ])
    // A second capture of the tab while this one stands is refused, as in Chrome.
    expect(() => w.api.handlers.capture(w.frameCtx(popup), { audio: true })).toThrow(
      TAB_CAPTURE_SAME_TAB_ERROR
    )
    w.api.handlers.streamState(w.frameCtx(popup), streamId, 'active')
    ;(w.win as Any).htmlFullscreenTabId = 't1'
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(popup))).toEqual([
      { tabId: 5, status: 'active', fullscreen: true }
    ])
    // Another extension sees nothing of it.
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(popup, OTHER))).toEqual([])
    w.api.handlers.streamState(w.frameCtx(popup), streamId, 'stopped')
    expect(w.dispatched.map((d) => (d.args[0] as Any).status)).toEqual([
      'pending',
      'active',
      'stopped'
    ])
    // Stopped: listed still (Chrome keeps the request); a state after the end is ignored.
    expect((w.api.handlers.getCapturedTabs(w.frameCtx(popup)) as Any)[0].status).toBe('stopped')
    w.api.handlers.streamState(w.frameCtx(popup), streamId, 'active')
    expect(w.dispatched).toHaveLength(3)
    // The tab is free for a new capture, which replaces the stopped request (Chrome's KillRequest).
    expect(() => w.api.handlers.capture(w.frameCtx(popup), { video: true })).not.toThrow()
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(popup))).toEqual([])
  })

  it('a consuming document that is gone frees the tab; the tab closing stops the capture', () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    const popup = w.page(31)
    const first = w.api.handlers.capture(w.frameCtx(popup), { audio: true }) as Any
    const firstId = first.audioConstraints.mandatory.chromeMediaSourceId as string
    w.api.handlers.resolveStreamId(w.frameCtx(popup), firstId)
    w.api.handlers.streamState(w.frameCtx(popup), firstId, 'active')
    popup.destroyed = true
    // The registry says the popup is gone (Electron's `destroyed` may not have fired yet).
    const again = w.page(33)
    const second = w.api.handlers.capture(w.frameCtx(again), { audio: true }) as Any
    const secondId = second.audioConstraints.mandatory.chromeMediaSourceId as string
    expect(secondId).not.toBe(firstId)
    expect(w.dispatched.map((d) => (d.args[0] as Any).status)).toEqual([
      'pending',
      'active',
      'stopped'
    ])
    w.api.handlers.resolveStreamId(w.frameCtx(again), secondId)
    w.api.tabRemoved(5)
    expect(w.dispatched.map((d) => (d.args[0] as Any).status)).toEqual([
      'pending',
      'active',
      'stopped',
      'pending',
      'stopped'
    ])
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(again))).toEqual([])
  })

  it('an id of this layer that waits too long, or whose tab is gone, fails to resolve', () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    const stale = w.api.handlers.getMediaStreamId(w.workerCtx(), undefined) as string
    w.clock.now += 61_000
    expect(() => w.api.handlers.resolveStreamId(w.frameCtx(w.page(70)), stale)).toThrow(
      TAB_CAPTURE_FINDING_TAB_ERROR
    )
    const fresh = w.api.handlers.getMediaStreamId(w.workerCtx(), undefined) as string
    w.api.tabRemoved(5)
    expect(w.api.handlers.resolveStreamId(w.frameCtx(w.page(71)), fresh)).toBe(fresh)
    // The unload of the extension drops its requests.
    w.addTab('t2', 6, 'https://example.org/')
    w.grant(EXT, 6)
    const late = w.api.handlers.getMediaStreamId(w.workerCtx(), { targetTabId: 6 }) as string
    w.api.unload(EXT)
    expect(w.api.handlers.resolveStreamId(w.frameCtx(w.page(72)), late)).toBe(late)
    expect(w.registered).toEqual([])
  })

  it("desktopCapture.chooseDesktopMedia answers Chrome's cancel until Zenium has a picker", () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    const ctx = w.frameCtx(w.page(31))
    expect(w.api.desktopHandlers.chooseDesktopMedia(ctx, ['screen', 'window'], undefined)).toEqual(
      DESKTOP_CAPTURE_CANCELLED
    )
    expect(w.api.desktopHandlers.chooseDesktopMedia(ctx, ['tab'], { id: 5 })).toEqual(
      DESKTOP_CAPTURE_CANCELLED
    )
    expect(() => w.api.desktopHandlers.chooseDesktopMedia(ctx, [], undefined)).toThrow(
      DESKTOP_CAPTURE_NO_SOURCES_ERROR
    )
    expect(() => w.api.desktopHandlers.chooseDesktopMedia(ctx, ['screen'], { id: 99 })).toThrow(
      DESKTOP_CAPTURE_INVALID_TAB_ERROR
    )
    expect(w.api.desktopHandlers.cancelChooseDesktopMedia(ctx, 1)).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------
// Shim: capture through the document's getUserMedia, the id resolution, desktopCapture's shape
// ---------------------------------------------------------------------------

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
  deliver(namespace: string, event: string, args: unknown[]): void
}

function fakeHost(kind: 'frame' | 'worker'): FakeHost {
  let listener: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const host: FakeHost = {
    kind,
    calls: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify: () => undefined,
    onEvent(fn) {
      listener = fn
    },
    deliver(namespace, event, args) {
      listener?.(namespace, event, args)
    }
  }
  return host
}

interface FakeStream {
  tracks: Array<{ end(): void }>
  getTracks(): unknown[]
  addEventListener(event: string, fn: () => void): void
}

function fakeStream(trackCount = 1): FakeStream {
  const tracks = Array.from({ length: trackCount }, () => {
    const listeners: Array<() => void> = []
    return {
      addEventListener: (event: string, fn: () => void) => {
        if (event === 'ended') listeners.push(fn)
      },
      end: () => listeners.splice(0).forEach((fn) => fn())
    }
  })
  return { tracks, getTracks: () => tracks, addEventListener: () => undefined }
}

function install(
  kind: 'frame' | 'worker',
  permissions: string[] = ['tabCapture', 'desktopCapture']
): { chrome: Any; host: FakeHost; getUserMedia: ReturnType<typeof vi.fn> } {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const chrome: Any = {
    runtime: {
      id: EXT,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${EXT}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent()
    },
    storage: { local: {}, session: {}, onChanged: nativeEvent() }
  }
  const getUserMedia = vi.fn()
  Object.defineProperty(g, 'navigator', {
    value: { mediaDevices: { getUserMedia } },
    configurable: true,
    writable: true
  })
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost(kind)
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host, getUserMedia }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('chrome.tabCapture and chrome.desktopCapture in the shim', () => {
  const g = globalThis as Any
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  afterEach(() => {
    delete g.chrome
    delete g.browser
    if (nativeNavigator) Object.defineProperty(globalThis, 'navigator', nativeNavigator)
    else delete g.navigator
    vi.restoreAllMocks()
  })

  it('capture in a document: the host adds the source constraints, the document’s getUserMedia makes the stream', async () => {
    const { chrome, host, getUserMedia } = install('frame')
    const stream = fakeStream()
    getUserMedia.mockResolvedValue(stream)
    host.respond = (_ns, method, args) => {
      if (method === 'capture') {
        return { ok: true, value: withTabSourceConstraints(args[0] as Any, 'zen-tab-capture-a-1') }
      }
      if (method === 'resolveStreamId') return { ok: true, value: 'engine-9' }
      return { ok: true, value: undefined }
    }
    const callback = vi.fn()
    expect(chrome.tabCapture.capture({ audio: true }, callback)).toBe(undefined)
    await flush()
    expect(host.calls.map((c) => [c.namespace, c.method, c.args])).toEqual([
      ['tabCapture', 'capture', [{ audio: true }]],
      ['tabCapture', 'resolveStreamId', ['zen-tab-capture-a-1']],
      ['tabCapture', 'streamState', ['zen-tab-capture-a-1', 'active']]
    ])
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'engine-9' } }
    })
    expect(callback).toHaveBeenCalledWith(stream)
    stream.tracks[0].end()
    await flush()
    expect(host.calls.at(-1)).toEqual({
      namespace: 'tabCapture',
      method: 'streamState',
      args: ['zen-tab-capture-a-1', 'stopped']
    })
    // The promise form works too, and browser.* is the same object.
    getUserMedia.mockResolvedValue(fakeStream())
    await expect(g.browser.tabCapture.capture({ video: true })).resolves.toBeTruthy()
    expect(chrome.tabCapture.TabCaptureState.ACTIVE).toBe('active')
  })

  it("a refused capture: the callback gets null, runtime.lastError Chrome's text", async () => {
    const { chrome, host, getUserMedia } = install('frame')
    host.respond = () => ({ ok: false, error: TAB_CAPTURE_GRANT_ERROR })
    let seen: string | undefined
    const callback = vi.fn(() => {
      seen = chrome.runtime.lastError?.message
    })
    chrome.tabCapture.capture({ audio: true }, callback)
    await flush()
    expect(callback).toHaveBeenCalledWith(null)
    expect(seen).toBe(TAB_CAPTURE_GRANT_ERROR)
    expect(getUserMedia).not.toHaveBeenCalled()
    await expect(chrome.tabCapture.capture({ audio: true })).rejects.toThrow(
      TAB_CAPTURE_GRANT_ERROR
    )
  })

  it('a getUserMedia naming a tab stream id (an offscreen document consuming getMediaStreamId’s answer) resolves it through the host', async () => {
    const { host, getUserMedia } = install('frame')
    const stream = fakeStream(2)
    getUserMedia.mockResolvedValue(stream)
    host.respond = (_ns, method) =>
      method === 'resolveStreamId'
        ? { ok: true, value: 'engine-3' }
        : { ok: true, value: undefined }
    const constraints = {
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'zen-tab-capture-b-2' }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: 'zen-tab-capture-b-2',
          maxWidth: 1
        }
      }
    }
    await expect(g.navigator.mediaDevices.getUserMedia(constraints)).resolves.toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'engine-3' } },
      video: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'engine-3', maxWidth: 1 }
      }
    })
    // One id, one resolution, one state report.
    expect(host.calls.filter((c) => c.method === 'resolveStreamId')).toHaveLength(1)
    expect(host.calls.filter((c) => c.method === 'streamState').map((c) => c.args[1])).toEqual([
      'active'
    ])
    // The stream ends when its last track has.
    stream.tracks[0].end()
    await flush()
    expect(host.calls.filter((c) => c.method === 'streamState')).toHaveLength(1)
    stream.tracks[1].end()
    await flush()
    expect(host.calls.filter((c) => c.method === 'streamState').map((c) => c.args[1])).toEqual([
      'active',
      'stopped'
    ])
    // A plain device request never touches the host.
    host.calls.length = 0
    await g.navigator.mediaDevices.getUserMedia({ audio: true })
    expect(host.calls).toEqual([])
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true })
  })

  it('a stream the host cannot register fails as an InvalidStateError; a failed getUserMedia is reported as an error state', async () => {
    const { host, getUserMedia } = install('frame')
    host.respond = (_ns, method) =>
      method === 'resolveStreamId'
        ? { ok: false, error: TAB_CAPTURE_FINDING_TAB_ERROR }
        : { ok: true, value: undefined }
    const tabConstraints = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'zen-tab-capture-c-3' } }
    }
    const failure: Any = await g.navigator.mediaDevices
      .getUserMedia(tabConstraints)
      .catch((e: Any) => e)
    expect(failure).toBeInstanceOf(DOMException)
    expect(failure.name).toBe('InvalidStateError')
    expect(failure.message).toBe(TAB_CAPTURE_FINDING_TAB_ERROR)
    expect(getUserMedia).not.toHaveBeenCalled()
    host.respond = (_ns, method) =>
      method === 'resolveStreamId'
        ? { ok: true, value: 'engine-4' }
        : { ok: true, value: undefined }
    getUserMedia.mockRejectedValue(new Error('NotAllowedError'))
    await expect(g.navigator.mediaDevices.getUserMedia(tabConstraints)).rejects.toThrow(
      'NotAllowedError'
    )
    expect(host.calls.at(-1)).toEqual({
      namespace: 'tabCapture',
      method: 'streamState',
      args: ['zen-tab-capture-c-3', 'error']
    })
  })

  it('in the worker: no capture (Chrome keeps it out of service workers), getMediaStreamId and the event stand', async () => {
    const { chrome, host } = install('worker')
    expect(chrome.tabCapture.capture).toBe(undefined)
    host.respond = () => ({ ok: true, value: 'zen-tab-capture-d-4' })
    await expect(chrome.tabCapture.getMediaStreamId({ targetTabId: 3 })).resolves.toBe(
      'zen-tab-capture-d-4'
    )
    expect(host.calls.at(-1)).toEqual({
      namespace: 'tabCapture',
      method: 'getMediaStreamId',
      args: [{ targetTabId: 3 }]
    })
    const listener = vi.fn()
    chrome.tabCapture.onStatusChanged.addListener(listener)
    host.deliver('tabCapture', 'onStatusChanged', [
      { tabId: 3, status: 'active', fullscreen: false }
    ])
    expect(listener).toHaveBeenCalledWith({ tabId: 3, status: 'active', fullscreen: false })
  })

  it('is absent without the permission', () => {
    const { chrome } = install('frame', ['storage'])
    expect(chrome.tabCapture).toBe(undefined)
    expect(chrome.desktopCapture).toBe(undefined)
  })

  it("desktopCapture.chooseDesktopMedia: a request id at once, Chrome's cancel through the callback; cancelChooseDesktopMedia withdraws it", async () => {
    const { chrome, host } = install('frame')
    host.respond = (_ns, method) =>
      method === 'chooseDesktopMedia'
        ? { ok: true, value: DESKTOP_CAPTURE_CANCELLED }
        : { ok: true, value: undefined }
    const callback = vi.fn()
    const id = chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], callback)
    expect(typeof id).toBe('number')
    expect(host.calls.at(-1)).toEqual({
      namespace: 'desktopCapture',
      method: 'chooseDesktopMedia',
      args: [['screen', 'window'], undefined]
    })
    await flush()
    expect(callback).toHaveBeenCalledWith('', { canRequestAudioTrack: false })
    expect(chrome.desktopCapture.DesktopCaptureSourceType.SCREEN).toBe('screen')
    // Without a callback the binding refuses, as Chrome's does.
    expect(() => chrome.desktopCapture.chooseDesktopMedia(['screen'])).toThrow(
      /No matching signature/
    )
    // A withdrawn request never calls back.
    const withdrawn = vi.fn()
    const second = chrome.desktopCapture.chooseDesktopMedia(['tab'], { id: 4 }, withdrawn)
    expect(second).not.toBe(id)
    chrome.desktopCapture.cancelChooseDesktopMedia(second)
    await flush()
    expect(withdrawn).not.toHaveBeenCalled()
    expect(host.calls.at(-1)).toEqual({
      namespace: 'desktopCapture',
      method: 'cancelChooseDesktopMedia',
      args: [second]
    })
    // A refused request: an empty answer with lastError set.
    host.respond = () => ({ ok: false, error: DESKTOP_CAPTURE_INVALID_TAB_ERROR })
    let seen: string | undefined
    const refused = vi.fn(() => {
      seen = chrome.runtime.lastError?.message
    })
    chrome.desktopCapture.chooseDesktopMedia(['screen'], { id: 99 }, refused)
    await flush()
    expect(refused).toHaveBeenCalled()
    expect(seen).toBe(DESKTOP_CAPTURE_INVALID_TAB_ERROR)
  })
})
