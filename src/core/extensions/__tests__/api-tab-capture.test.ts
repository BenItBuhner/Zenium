import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CAPTURE_CANCELLED,
  DESKTOP_CAPTURE_INVALID_ORIGIN_ERROR,
  DESKTOP_CAPTURE_INVALID_STATE_ERROR,
  DESKTOP_CAPTURE_INVALID_TAB_ERROR,
  DESKTOP_CAPTURE_NO_SOURCES_ERROR,
  DESKTOP_CAPTURE_NO_TAB_ID_ERROR,
  DESKTOP_CAPTURE_NO_TAB_URL_ERROR,
  DESKTOP_CAPTURE_SOURCE_TYPES,
  DESKTOP_CAPTURE_TAB_URL_NOT_SECURE_ERROR,
  DESKTOP_CAPTURE_TARGET_NOT_FOUND_ERROR,
  DESKTOP_CAPTURE_WORKER_NEEDS_TAB_ERROR,
  TAB_CAPTURE_FINDING_TAB_ERROR,
  TAB_CAPTURE_GRANT_ERROR,
  TAB_CAPTURE_INVALID_TAB_ERROR,
  TAB_CAPTURE_NO_AUDIO_OR_VIDEO_ERROR,
  TAB_CAPTURE_NO_DOCUMENT_ERROR,
  TAB_CAPTURE_SAME_TAB_ERROR,
  TAB_CAPTURE_STATES,
  TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR,
  desktopSourceKinds,
  isCapturableUrl,
  isPotentiallyTrustworthyUrl,
  normalizeCaptureOptions,
  normalizeDesktopOptions,
  normalizeDesktopSources,
  normalizeDesktopTarget,
  normalizeStreamIdOptions,
  withTabSourceConstraints
} from '../api/tabCapture'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import {
  API_SPEC,
  DESKTOP_CAPTURE_INTERNAL_METHODS,
  TAB_CAPTURE_INTERNAL_METHODS
} from '../api/spec'
import { TabCaptureApi, type StreamRegistrar } from '../../../main/platform/extensionApi/tabCapture'
import type { ActiveTabGrants } from '../../../main/platform/extensionApi/activeTab'
import type { ApiContext, ApiHost } from '../../../main/platform/extensionApi/types'
import type { ScreenCaptureRequestInit } from '../../screenCapture'
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

  it("desktopCapture's panes: the kinds among the sources, in the picker's order, audio being the toggle", () => {
    expect(desktopSourceKinds(['screen', 'audio'])).toEqual(['screen'])
    expect(desktopSourceKinds(['screen', 'window', 'tab', 'audio'])).toEqual([
      'tab',
      'window',
      'screen'
    ])
    expect(desktopSourceKinds(['audio'])).toEqual([])
  })

  it("desktopCapture's targetTab, checked in Chrome's order: a URL, a valid one, a secure one, an id", () => {
    expect(normalizeDesktopTarget(undefined)).toBeNull()
    expect(normalizeDesktopTarget(null)).toBeNull()
    expect(normalizeDesktopTarget({ id: 5, url: 'https://docs.example/a' })).toEqual({
      id: 5,
      url: 'https://docs.example/a'
    })
    expect(normalizeDesktopTarget({ id: 5, url: `chrome-extension://${EXT}/rec.html` })).toEqual({
      id: 5,
      url: `chrome-extension://${EXT}/rec.html`
    })
    expect(() => normalizeDesktopTarget({ id: 5 })).toThrow(DESKTOP_CAPTURE_NO_TAB_URL_ERROR)
    expect(() => normalizeDesktopTarget({ id: 5, url: 'nonsense' })).toThrow(
      DESKTOP_CAPTURE_INVALID_ORIGIN_ERROR
    )
    expect(() => normalizeDesktopTarget({ id: 5, url: 'http://example.com/' })).toThrow(
      DESKTOP_CAPTURE_TAB_URL_NOT_SECURE_ERROR
    )
    expect(() => normalizeDesktopTarget({ url: 'https://docs.example/' })).toThrow(
      DESKTOP_CAPTURE_NO_TAB_ID_ERROR
    )
    expect(() => normalizeDesktopTarget({ id: -1, url: 'https://docs.example/' })).toThrow(
      DESKTOP_CAPTURE_NO_TAB_ID_ERROR
    )
    expect(() => normalizeDesktopTarget('tab')).toThrow(/No matching signature/)
  })

  it("desktopCapture's options: the two preferences the picker honours", () => {
    expect(normalizeDesktopOptions(undefined)).toEqual({
      excludeSystemAudio: false,
      excludeSelf: false
    })
    expect(
      normalizeDesktopOptions({ systemAudio: 'exclude', selfBrowserSurface: 'exclude' })
    ).toEqual({ excludeSystemAudio: true, excludeSelf: true })
    expect(normalizeDesktopOptions({ systemAudio: 'include' })).toEqual({
      excludeSystemAudio: false,
      excludeSelf: false
    })
    expect(() => normalizeDesktopOptions('exclude')).toThrow(/No matching signature/)
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
    expect(DESKTOP_CAPTURE_INTERNAL_METHODS).toEqual(['resolveStreamId'])
    expect(API_SPEC.desktopCapture.methods.chooseDesktopMedia.params.map((p) => p.name)).toEqual([
      'sources',
      'targetTab',
      'options'
    ])
  })
})

// ---------------------------------------------------------------------------
// Router over a fake model, grants and stream registry
// ---------------------------------------------------------------------------

interface FakeWebContents {
  id: number
  destroyed: boolean
  on(event: string, fn: () => void): void
  once(event: string, fn: () => void): void
  removeListener(event: string, fn: () => void): void
  /** The listeners still attached, by event: the router detaches its own when a request ends. */
  listenerCount(event: string): number
  destroy(): void
  /** A cross-document navigation of the main frame (Electron's `did-navigate`). */
  navigate(): void
  /** The renderer went (Electron's `render-process-gone`). */
  crash(): void
  /** Set on the page of a popup window, which the router reads the consumer's URL from. */
  getURL?(): string
  isDestroyed(): boolean
}

function fakeWebContents(id: number): FakeWebContents {
  const listeners = new Map<string, Array<{ fn: () => void; once: boolean }>>()
  const emit = (event: string): void => {
    for (const entry of [...(listeners.get(event) ?? [])]) {
      if (entry.once) wc.removeListener(event, entry.fn)
      entry.fn()
    }
  }
  const wc: FakeWebContents = {
    id,
    destroyed: false,
    isDestroyed: () => wc.destroyed,
    on: (event, fn) => {
      listeners.set(event, [...(listeners.get(event) ?? []), { fn, once: false }])
    },
    once: (event, fn) => {
      listeners.set(event, [...(listeners.get(event) ?? []), { fn, once: true }])
    },
    removeListener: (event, fn) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry.fn !== fn)
      )
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    destroy: () => {
      wc.destroyed = true
      emit('destroyed')
    },
    navigate: () => emit('did-navigate'),
    crash: () => emit('render-process-gone')
  }
  return wc
}

/** The core's picker as the router sees it: requests put up, each answered by a test. */
interface FakePicker {
  requests: Array<{ id: string; init: ScreenCaptureRequestInit }>
  /** The picker's answer to the request last put up (or the one named). */
  pick(sourceId: string | null, audio?: boolean, id?: string): void
  /** The chrome has no picker surface: `open` refuses at once. */
  down: boolean
}

interface World {
  api: TabCaptureApi
  dispatched: Array<{ extensionId: string; event: string; args: unknown[] }>
  registered: Array<{ target: number; consumer: number; id: string }>
  picker: FakePicker
  grant(extensionId: string, chromeTabId: number): void
  addTab(zenId: string, chromeId: number, url: string): { tab: Tab; wc: FakeWebContents }
  /** An extension popup window (`windows.create({type: "popup"})`): its one tab is its page. */
  addPopupWindow(chromeId: number, url: string): FakeWebContents
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
  const popups = new Map<number, { wc: FakeWebContents; url: string }>()
  const pending = new Map<string, (answer: { sourceId: string | null; audio: boolean }) => void>()
  let pickerIds = 0
  const picker: FakePicker = {
    requests: [],
    down: false,
    pick: (sourceId, audio = false, id) => {
      const target = id ?? picker.requests.at(-1)?.id
      const resolve = target ? pending.get(target) : undefined
      if (!target || !resolve) throw new Error('no picker up')
      pending.delete(target)
      resolve({ sourceId, audio })
    }
  }
  const screenCapture = {
    open: (init: ScreenCaptureRequestInit) => {
      if (picker.down || !tabs.has(init.tabId))
        return { id: null, answer: Promise.resolve({ sourceId: null, audio: false }) }
      pickerIds += 1
      const id = `capture-${pickerIds}`
      picker.requests.push({ id, init })
      return {
        id,
        answer: new Promise<{ sourceId: string | null; audio: boolean }>((resolve) => {
          pending.set(id, resolve)
        })
      }
    },
    respond: (id: string, sourceId: string | null, audio = false) => {
      if (pending.has(id)) picker.pick(sourceId, audio, id)
    }
  }
  const model = {
    tab: (zenId: string) => tabs.get(zenId),
    zenTab: (chromeId: number) => [...tabs.values()].find((t) => chromeIds.get(t.id) === chromeId),
    chromeTabId: (tab: Tab) => chromeIds.get(tab.id) ?? -1,
    webContentsOf: (tab: Tab) => {
      const wc = contents.get(tab.id)
      return wc && !wc.destroyed ? (wc as unknown as WebContents) : undefined
    },
    windowOfTab: () => win,
    lastFocusedWindow: () => win,
    popupForTabId: (chromeId: number) => {
      const popup = popups.get(chromeId)
      if (!popup || popup.wc.destroyed) return undefined
      return { bw: { webContents: popup.wc, isDestroyed: () => popup.wc.destroyed } }
    }
  }
  const host = {
    model,
    browser: {
      tabs: { activeTabFor: () => active },
      screenCapture,
      extensions: {
        list: () => [{ id: EXT, name: 'Screen Recorder', icon: 'data:image/png;base64,ICON' }]
      }
    },
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
    picker,
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
    addPopupWindow: (chromeId, url) => {
      const wc = fakeWebContents(chromeId)
      wc.getURL = () => url
      pages.set(chromeId, wc)
      popups.set(chromeId, { wc, url })
      return wc
    },
    page: (id) => {
      const wc = fakeWebContents(id)
      pages.set(id, wc)
      return wc
    },
    workerCtx: (extensionId = EXT) =>
      ({
        extensionId,
        extension: { manifest: { name: 'Probe' } },
        sender: { kind: 'worker', worker: { versionId: 7 } },
        tabId: null,
        window: undefined
      }) as unknown as ApiContext,
    frameCtx: (wc, extensionId = EXT, parent = null) =>
      ({
        extensionId,
        extension: { manifest: { name: 'Probe' } },
        sender: { kind: 'frame', webContents: wc, frame: { parent, routingId: wc.id * 10 } },
        // An extension page opened as a tab is that tab's page.
        tabId: [...tabs.entries()].find(([, tab]) => contents.get(tab.id) === wc)?.[0] ?? null,
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

  it("the tab of an extension popup window is a consumer too (a recorder window naming itself), as Chrome's GetTabById finds it", () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    // The popup window's page (`windows.create({type: "popup", url: "window.html"})`): its tab id
    // is its WebContents id, the one `tabs.getCurrent()` answers it.
    const recorder = w.addPopupWindow(41, `chrome-extension://${EXT}/window.html?tabId=5`)
    const id = w.api.handlers.getMediaStreamId(w.frameCtx(recorder), {
      targetTabId: 5,
      consumerTabId: 41
    })
    expect(id).toBe('engine-1')
    expect(w.registered).toEqual([{ target: target.id, consumer: 41, id: 'engine-1' }])
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(true)
    // A popup window on a plain http page is refused as any insecure consumer is.
    const plain = w.addPopupWindow(42, 'http://plain.example/recorder')
    expect(() =>
      w.api.handlers.getMediaStreamId(w.frameCtx(plain), { targetTabId: 5, consumerTabId: 42 })
    ).toThrow(TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR)
    // A closed popup window is no tab; an id that is neither is Chrome's "Invalid tab specified.".
    recorder.destroy()
    expect(() =>
      w.api.handlers.getMediaStreamId(w.frameCtx(w.page(43)), { targetTabId: 5, consumerTabId: 41 })
    ).toThrow(TAB_CAPTURE_INVALID_TAB_ERROR)
    expect(() =>
      w.api.handlers.getMediaStreamId(w.frameCtx(w.page(43)), { targetTabId: 5, consumerTabId: 99 })
    ).toThrow(TAB_CAPTURE_INVALID_TAB_ERROR)
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

  it("a cross-document navigation of the consuming document (a reload of the recorder window) ends its capture and frees the tab, as Chrome's media request closes with the document", () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    w.grant(EXT, 5)
    // Sound Booster's flow: the popup window captures the active tab, naming itself the consumer.
    const recorder = w.addPopupWindow(41, `chrome-extension://${EXT}/window.html?tabId=5`)
    const first = w.api.handlers.getMediaStreamId(w.frameCtx(recorder), {
      targetTabId: 5,
      consumerTabId: 41
    }) as string
    w.api.handlers.streamState(w.frameCtx(recorder), first, 'pending')
    w.api.handlers.streamState(w.frameCtx(recorder), first, 'active')
    expect(() =>
      w.api.handlers.getMediaStreamId(w.frameCtx(w.page(43)), { targetTabId: 5 })
    ).toThrow(TAB_CAPTURE_SAME_TAB_ERROR)
    // The window reloads (its own `r` key): the document and its stream are gone; the next document
    // captures the tab again, with a fresh engine id, and the router's listeners went with the request.
    recorder.navigate()
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    const second = w.api.handlers.getMediaStreamId(w.frameCtx(recorder), {
      targetTabId: 5,
      consumerTabId: 41
    }) as string
    expect(second).not.toBe(first)
    expect(w.registered.map((r) => r.id)).toEqual(['engine-1', 'engine-2'])
    expect(recorder.listenerCount('did-navigate')).toBe(1)
    expect(recorder.listenerCount('destroyed')).toBe(1)
    // A request nothing has redeemed yet outlives the navigation (Chrome's TAB_CAPTURE_STATE_NONE
    // entry stands in the registry): the new document may still call getUserMedia with it.
    recorder.navigate()
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(true)
    expect(w.api.handlers.resolveStreamId(w.frameCtx(recorder), second)).toBe(second)
    w.api.handlers.streamState(w.frameCtx(recorder), second, 'active')
    // The renderer going ends the capture the same way; `capture`'s requests report the stop.
    recorder.crash()
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    expect(recorder.listenerCount('did-navigate')).toBe(0)
    expect(recorder.listenerCount('render-process-gone')).toBe(0)
    expect(recorder.listenerCount('destroyed')).toBe(0)
    const popup = w.page(31)
    const captured = w.api.handlers.capture(w.frameCtx(popup), { audio: true }) as Any
    const streamId = captured.audioConstraints.mandatory.chromeMediaSourceId as string
    w.api.handlers.resolveStreamId(w.frameCtx(popup), streamId)
    w.api.handlers.streamState(w.frameCtx(popup), streamId, 'active')
    popup.navigate()
    expect(w.dispatched.map((d) => (d.args[0] as Any).status)).toEqual([
      'pending',
      'active',
      'stopped'
    ])
    expect(w.api.handlers.getCapturedTabs(w.frameCtx(popup))).toEqual([])
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
})

// ---------------------------------------------------------------------------
// Router: chrome.desktopCapture over the core's picker
// ---------------------------------------------------------------------------

describe('TabCaptureApi for chrome.desktopCapture', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it("puts the picker up for the extension's own page with its name and icon, the panes asked for, and hands back an id its getUserMedia redeems natively", async () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const work = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      1,
      ['screen', 'window', 'audio'],
      undefined,
      undefined
    ) as Promise<unknown>
    expect(w.picker.requests).toHaveLength(1)
    expect(w.picker.requests[0]!.init).toEqual({
      tabId: 'rec',
      url: '',
      audio: true,
      extension: { name: 'Screen Recorder', icon: 'data:image/png;base64,ICON' },
      kinds: ['window', 'screen'],
      excludeSystemAudio: false,
      excludeSelf: false
    })
    w.picker.pick('screen:0:0', true)
    const result = (await work) as { streamId: string; options: { canRequestAudioTrack: boolean } }
    expect(result.streamId).toMatch(/^zen-desktop-capture-/)
    expect(result.options).toEqual({ canRequestAudioTrack: true })
    // Not before the consumer's call: the engine's request has nothing standing for it yet.
    expect(
      w.api.allowsMediaRequest(recorder as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    // The shim resolves the id: the engine's own source id, under `desktop`.
    expect(w.api.desktopHandlers.resolveStreamId(ctx, result.streamId)).toEqual({
      source: 'desktop',
      id: 'screen:0:0',
      audio: true
    })
    expect(w.registered).toEqual([])
    // The engine asks the consuming document's permission handler, once; the pick is spent by it.
    expect(
      w.api.allowsMediaRequest(recorder as unknown as WebContents, `chrome-extension://${OTHER}`)
    ).toBe(false)
    expect(
      w.api.allowsMediaRequest(recorder as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(true)
    expect(
      w.api.allowsMediaRequest(recorder as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
    expect(() => w.api.desktopHandlers.resolveStreamId(ctx, result.streamId)).toThrow(
      DESKTOP_CAPTURE_INVALID_STATE_ERROR
    )
  })

  it('a picked tab goes the tabCapture way: the engine’s tab stream registered for the consumer at getUserMedia, under `tab`, its audio on offer', async () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const work = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      1,
      ['tab', 'audio'],
      null,
      null
    ) as Promise<unknown>
    expect(w.picker.requests[0]!.init.kinds).toEqual(['tab'])
    w.picker.pick('tab:t1')
    const result = (await work) as { streamId: string; options: { canRequestAudioTrack: boolean } }
    expect(result.options).toEqual({ canRequestAudioTrack: true })
    expect(w.api.desktopHandlers.resolveStreamId(ctx, result.streamId)).toEqual({
      source: 'tab',
      id: 'engine-1',
      audio: true
    })
    expect(w.registered).toEqual([{ target: 5, consumer: 31, id: 'engine-1' }])
    // The engine's request arrives on the captured tab from the consumer's origin.
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(true)
    // No audio asked: none on offer with the tab either.
    const silent = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      2,
      ['tab'],
      undefined,
      undefined
    ) as Promise<unknown>
    w.picker.pick('tab:t1')
    expect(await silent).toMatchObject({ options: { canRequestAudioTrack: false } })
  })

  it('a window carries no audio; a screen’s audio is the box the user ticked', async () => {
    const w = world()
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const a = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      1,
      ['window', 'audio'],
      undefined,
      undefined
    ) as Promise<unknown>
    w.picker.pick('window:12:0', false)
    expect(await a).toMatchObject({ options: { canRequestAudioTrack: false } })
    const b = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      2,
      ['screen', 'audio'],
      undefined,
      undefined
    ) as Promise<unknown>
    w.picker.pick('screen:0:0', false)
    expect(await b).toMatchObject({ options: { canRequestAudioTrack: false } })
  })

  it('a cancelled picker answers Chrome’s cancel; cancelChooseDesktopMedia takes the picker down and answers the same', async () => {
    const w = world()
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const cancelled = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      1,
      ['screen'],
      undefined,
      undefined
    ) as Promise<unknown>
    w.picker.pick(null)
    expect(await cancelled).toEqual(DESKTOP_CAPTURE_CANCELLED)

    const withdrawn = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      2,
      ['screen'],
      undefined,
      undefined
    ) as Promise<unknown>
    // Another context's id 2, and an unknown id, take nothing down.
    w.api.desktopHandlers.cancelChooseDesktopMedia(w.frameCtx(w.page(32)), 2)
    w.api.desktopHandlers.cancelChooseDesktopMedia(ctx, 9)
    expect(w.picker.requests).toHaveLength(2)
    let settled = false
    void withdrawn.then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(false)
    w.api.desktopHandlers.cancelChooseDesktopMedia(ctx, 2)
    expect(await withdrawn).toEqual(DESKTOP_CAPTURE_CANCELLED)
    // Nothing to redeem after a cancel.
    expect(w.api.desktopHandlers.resolveStreamId(ctx, 'zen-desktop-capture-x-1')).toBeNull()
  })

  it('a targetTab of a site makes its page the consumer: the engine’s own source id, the site named, no tab pane, the engine’s request on that tab allowed once', async () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://docs.example/a')
    const work = w.api.desktopHandlers.chooseDesktopMedia(
      w.workerCtx(),
      1,
      ['screen', 'window', 'tab', 'audio'],
      { id: 5, url: 'https://docs.example/a' },
      { systemAudio: 'exclude', selfBrowserSurface: 'exclude' }
    ) as Promise<unknown>
    expect(w.picker.requests[0]!.init).toMatchObject({
      tabId: 't1',
      url: 'https://docs.example/a',
      audio: true,
      kinds: ['window', 'screen'],
      excludeSystemAudio: true,
      excludeSelf: true
    })
    w.picker.pick('window:12:0')
    expect(await work).toEqual({
      streamId: 'window:12:0',
      options: { canRequestAudioTrack: false }
    })
    // The page's getUserMedia: the engine asks the tab's permission handler from the page's origin.
    expect(
      w.api.allowsMediaRequest(target as unknown as WebContents, 'https://other.example')
    ).toBe(false)
    expect(w.api.allowsMediaRequest(target as unknown as WebContents, 'https://docs.example')).toBe(
      true
    )
    expect(w.api.allowsMediaRequest(target as unknown as WebContents, 'https://docs.example')).toBe(
      false
    )
  })

  it('a targetTab that is the extension’s own page keeps the shim’s way: an id of this layer, the tab pane, no site named', async () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const work = w.api.desktopHandlers.chooseDesktopMedia(
      w.workerCtx(),
      1,
      ['screen', 'tab'],
      { id: 31, url: `chrome-extension://${EXT}/record.html` },
      undefined
    ) as Promise<unknown>
    expect(w.picker.requests[0]!.init).toMatchObject({
      tabId: 'rec',
      url: '',
      kinds: ['tab', 'screen']
    })
    w.picker.pick('screen:0:0')
    const result = (await work) as { streamId: string }
    expect(result.streamId).toMatch(/^zen-desktop-capture-/)
    expect(w.api.desktopHandlers.resolveStreamId(w.frameCtx(recorder), result.streamId)).toEqual({
      source: 'desktop',
      id: 'screen:0:0',
      audio: false
    })
  })

  it('a document without a tab (a popup, the side panel) anchors the picker to the focused window’s active tab; excludeSelf then leaves that tab alone', async () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    const popup = w.page(40)
    const work = w.api.desktopHandlers.chooseDesktopMedia(
      w.frameCtx(popup),
      1,
      ['tab'],
      undefined,
      { selfBrowserSurface: 'exclude' }
    ) as Promise<unknown>
    expect(w.picker.requests[0]!.init).toMatchObject({ tabId: 't1', excludeSelf: false })
    w.picker.pick(null)
    expect(await work).toEqual(DESKTOP_CAPTURE_CANCELLED)
  })

  it("keeps Chrome's errors: no sources, a worker without a target tab, a tab that is not there or has no page", async () => {
    const w = world()
    w.addTab('t1', 5, 'https://example.com/')
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const call = (c: ApiContext, sources: unknown, target?: unknown): Promise<unknown> =>
      w.api.desktopHandlers.chooseDesktopMedia(c, 1, sources, target, undefined) as Promise<unknown>
    await expect(call(ctx, [])).rejects.toThrow(DESKTOP_CAPTURE_NO_SOURCES_ERROR)
    await expect(call(w.workerCtx(), ['screen'])).rejects.toThrow(
      DESKTOP_CAPTURE_WORKER_NEEDS_TAB_ERROR
    )
    await expect(call(ctx, ['screen'], { id: 99, url: 'https://example.com/' })).rejects.toThrow(
      DESKTOP_CAPTURE_INVALID_TAB_ERROR
    )
    await expect(call(ctx, ['screen'], { id: 5 })).rejects.toThrow(DESKTOP_CAPTURE_NO_TAB_URL_ERROR)
    await expect(call(ctx, ['screen'], { id: 5, url: 'http://example.com/' })).rejects.toThrow(
      DESKTOP_CAPTURE_TAB_URL_NOT_SECURE_ERROR
    )
    // A tab whose page is unloaded has nothing to consume the stream.
    const { wc: sleeping } = w.addTab('t2', 6, 'https://example.org/')
    sleeping.destroy()
    await expect(call(ctx, ['screen'], { id: 6, url: 'https://example.org/' })).rejects.toThrow(
      DESKTOP_CAPTURE_TARGET_NOT_FOUND_ERROR
    )
    expect(w.picker.requests).toEqual([])
  })

  it('a chrome without the picker surface answers the cancel at once, as a page’s call gets', async () => {
    const w = world()
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    w.picker.down = true
    expect(
      await w.api.desktopHandlers.chooseDesktopMedia(
        w.frameCtx(recorder),
        1,
        ['screen'],
        undefined,
        undefined
      )
    ).toEqual(DESKTOP_CAPTURE_CANCELLED)
    expect(w.picker.requests).toEqual([])
  })

  it('binds the id to the one consuming main frame and to the moment: another document, a sub-frame, a late call and a gone tab are refused', async () => {
    const w = world()
    const { wc: target } = w.addTab('t1', 5, 'https://example.com/')
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const pick = async (sources: string[], sourceId: string): Promise<string> => {
      const work = w.api.desktopHandlers.chooseDesktopMedia(
        ctx,
        1,
        sources,
        undefined,
        undefined
      ) as Promise<{ streamId: string }>
      w.picker.pick(sourceId)
      return (await work).streamId
    }
    const id = await pick(['screen'], 'screen:0:0')
    expect(() => w.api.desktopHandlers.resolveStreamId(w.frameCtx(w.page(32)), id)).toThrow(
      DESKTOP_CAPTURE_INVALID_STATE_ERROR
    )
    expect(() => w.api.desktopHandlers.resolveStreamId(w.frameCtx(recorder, OTHER), id)).toThrow(
      DESKTOP_CAPTURE_INVALID_STATE_ERROR
    )
    expect(() => w.api.desktopHandlers.resolveStreamId(w.frameCtx(recorder, EXT, {}), id)).toThrow(
      DESKTOP_CAPTURE_INVALID_STATE_ERROR
    )
    // An id nobody redeemed lapses; the worker has no document to redeem with.
    w.clock.now += 61_000
    expect(w.api.desktopHandlers.resolveStreamId(ctx, id)).toBeNull()
    expect(w.api.desktopHandlers.resolveStreamId(w.workerCtx(), id)).toBeNull()
    // A picked tab that closed before the consumer's call.
    const tabId = await pick(['tab'], 'tab:t1')
    target.destroy()
    w.api.tabRemoved(5)
    expect(() => w.api.desktopHandlers.resolveStreamId(ctx, tabId)).toThrow(
      DESKTOP_CAPTURE_INVALID_STATE_ERROR
    )
    // The engine's request must follow the consumer's call closely.
    const late = await pick(['screen'], 'screen:0:0')
    w.api.desktopHandlers.resolveStreamId(ctx, late)
    w.clock.now += 11_000
    expect(
      w.api.allowsMediaRequest(recorder as unknown as WebContents, `chrome-extension://${EXT}`)
    ).toBe(false)
  })

  it('the unload of the extension drops its picks and takes its picker down', async () => {
    const w = world()
    const { wc: recorder } = w.addTab('rec', 31, `chrome-extension://${EXT}/record.html`)
    const ctx = w.frameCtx(recorder)
    const done = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      1,
      ['screen'],
      undefined,
      undefined
    ) as Promise<{ streamId: string }>
    w.picker.pick('screen:0:0')
    const { streamId } = await done
    const open = w.api.desktopHandlers.chooseDesktopMedia(
      ctx,
      2,
      ['screen'],
      undefined,
      undefined
    ) as Promise<unknown>
    w.api.unload(EXT)
    expect(await open).toEqual(DESKTOP_CAPTURE_CANCELLED)
    expect(w.api.desktopHandlers.resolveStreamId(ctx, streamId)).toBeNull()
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

  it("desktopCapture.chooseDesktopMedia: a request id at once, leading the host's arguments; the pick through the callback with canRequestAudioTrack", async () => {
    const { chrome, host } = install('frame')
    host.respond = (_ns, method) =>
      method === 'chooseDesktopMedia'
        ? {
            ok: true,
            value: { streamId: 'zen-desktop-capture-x-1', options: { canRequestAudioTrack: true } }
          }
        : { ok: true, value: undefined }
    const callback = vi.fn()
    const id = chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'audio'], callback)
    expect(typeof id).toBe('number')
    expect(host.calls.at(-1)).toEqual({
      namespace: 'desktopCapture',
      method: 'chooseDesktopMedia',
      args: [id, ['screen', 'window', 'audio'], undefined, undefined]
    })
    await flush()
    expect(callback).toHaveBeenCalledWith('zen-desktop-capture-x-1', { canRequestAudioTrack: true })
    expect(chrome.desktopCapture.DesktopCaptureSourceType.SCREEN).toBe('screen')
    // Without a callback the binding refuses, as Chrome's does.
    expect(() => chrome.desktopCapture.chooseDesktopMedia(['screen'])).toThrow(
      /No matching signature/
    )
    // The target tab and the options go along; an options object in the tab's place is the options.
    const tab = { id: 4, url: 'https://docs.example/', index: 0 }
    chrome.desktopCapture.chooseDesktopMedia(['tab'], tab, { systemAudio: 'exclude' }, vi.fn())
    expect(host.calls.at(-1)!.args.slice(1)).toEqual([['tab'], tab, { systemAudio: 'exclude' }])
    chrome.desktopCapture.chooseDesktopMedia(['tab'], { selfBrowserSurface: 'exclude' }, vi.fn())
    expect(host.calls.at(-1)!.args.slice(1)).toEqual([
      ['tab'],
      undefined,
      { selfBrowserSurface: 'exclude' }
    ])
    // A refused request: an empty answer with lastError set.
    host.respond = () => ({ ok: false, error: DESKTOP_CAPTURE_INVALID_TAB_ERROR })
    let seen: string | undefined
    const refused = vi.fn(() => {
      seen = chrome.runtime.lastError?.message
    })
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen'],
      { id: 99, url: 'https://x.example/' },
      refused
    )
    await flush()
    expect(refused).toHaveBeenCalled()
    expect(seen).toBe(DESKTOP_CAPTURE_INVALID_TAB_ERROR)
  })

  it("cancelChooseDesktopMedia names the call to the host, whose empty answer reaches the callback – Chrome's cancel", async () => {
    const { chrome, host } = install('frame')
    let answerChoose: ((result: InvokeResult) => void) | null = null
    host.invoke = (namespace, method, args) => {
      host.calls.push({ namespace, method, args })
      if (method === 'chooseDesktopMedia') {
        return new Promise<InvokeResult>((resolve) => {
          answerChoose = resolve
        })
      }
      // The host takes the picker down and answers the pending call with the cancel.
      if (method === 'cancelChooseDesktopMedia') {
        answerChoose?.({ ok: true, value: DESKTOP_CAPTURE_CANCELLED })
      }
      return Promise.resolve({ ok: true, value: undefined })
    }
    const callback = vi.fn()
    const id = chrome.desktopCapture.chooseDesktopMedia(['tab'], callback)
    chrome.desktopCapture.cancelChooseDesktopMedia(id)
    expect(host.calls.at(-1)).toEqual({
      namespace: 'desktopCapture',
      method: 'cancelChooseDesktopMedia',
      args: [id]
    })
    await flush()
    expect(callback).toHaveBeenCalledWith('', { canRequestAudioTrack: false })
    // An unknown or spent id is nothing to the host.
    chrome.desktopCapture.cancelChooseDesktopMedia(id)
    chrome.desktopCapture.cancelChooseDesktopMedia(999)
    expect(host.calls.filter((c) => c.method === 'cancelChooseDesktopMedia')).toHaveLength(1)
  })

  it("a desktopCapture id in getUserMedia goes to the host for the engine's terms: a screen's id under `desktop`, a tab's stream under `tab`, an unknown id untouched", async () => {
    const { chrome, host, getUserMedia } = install('frame', ['desktopCapture'])
    const stream = fakeStream(2)
    getUserMedia.mockResolvedValue(stream)
    host.respond = (_ns, method, args) => {
      if (method !== 'resolveStreamId') return { ok: true, value: undefined }
      const [id] = args as [string]
      if (id === 'zen-desktop-capture-x-1')
        return { ok: true, value: { source: 'desktop', id: 'screen:0:0', audio: true } }
      if (id === 'zen-desktop-capture-x-2')
        return { ok: true, value: { source: 'tab', id: 'engine-7', audio: false } }
      if (id === 'zen-desktop-capture-x-3')
        return { ok: true, value: { source: 'desktop', id: 'screen:0:0', audio: false } }
      return { ok: true, value: null }
    }
    const desktop = (id: string): unknown => ({
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id }
    })
    await g.navigator.mediaDevices.getUserMedia({
      audio: desktop('zen-desktop-capture-x-1'),
      video: desktop('zen-desktop-capture-x-1')
    } as Any)
    expect(host.calls.filter((c) => c.method === 'resolveStreamId')).toEqual([
      { namespace: 'desktopCapture', method: 'resolveStreamId', args: ['zen-desktop-capture-x-1'] }
    ])
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } }
    })
    // No tabCapture permission: no status reports for a desktop pick.
    expect(host.calls.some((c) => c.method === 'streamState')).toBe(false)
    await g.navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: 'zen-desktop-capture-x-2',
          maxWidth: 1280
        }
      }
    } as Any)
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'engine-7', maxWidth: 1280 }
      }
    })
    await g.navigator.mediaDevices.getUserMedia({ video: desktop('screen:1:0') } as Any)
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: desktop('screen:1:0') })
    // A pick without sound (the box unticked, or an OS without loopback), the extension asking
    // for an audio track under the id all the same (Screencastify's shape): the track is left
    // out and the stream comes video-only, as Chrome's does – the engine would open a loopback
    // device the OS has not got and fail the call.
    await g.navigator.mediaDevices.getUserMedia({
      audio: desktop('zen-desktop-capture-x-3'),
      video: desktop('zen-desktop-capture-x-3')
    } as Any)
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } }
    })
    // A tab id is left to tabCapture, which this extension has not got: untouched.
    await g.navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'zen-tab-capture-x-1' } }
    } as Any)
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'zen-tab-capture-x-1' } }
    })
    expect(host.calls.filter((c) => c.namespace === 'tabCapture')).toEqual([])
    // A refusal from the host is Chromium's InvalidStateError.
    host.respond = () => ({ ok: false, error: DESKTOP_CAPTURE_INVALID_STATE_ERROR })
    await expect(
      g.navigator.mediaDevices.getUserMedia({ video: desktop('zen-desktop-capture-x-9') } as Any)
    ).rejects.toMatchObject({
      name: 'InvalidStateError',
      message: DESKTOP_CAPTURE_INVALID_STATE_ERROR
    })
    // Nothing of desktopCapture reaches a page without the permission.
    expect(chrome.desktopCapture.chooseDesktopMedia).toBeTypeOf('function')
  })
})
