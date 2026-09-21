// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTURE_STATE_EVENT,
  alertOfReport,
  installCaptureReporter,
  installCaptureShim,
  reportIsLive,
  sanitiseCaptureReport,
  tabAlertFor,
  tabAlertTooltip,
  type CaptureStateReport,
  type CaptureTrackCounts
} from '../captureState'
import type { PageScriptMessage } from '../pageScript'

/** A stand-in for the engine's track: `stop()` ends it silently (as the real one fires no `ended`). */
class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  constructor(public kind: 'video' | 'audio') {
    super()
  }
  stop(): void {
    this.readyState = 'ended'
  }
  clone(): FakeTrack {
    return new FakeTrack(this.kind)
  }
  /** The source went away (a device unplugged): the engine fires `ended`. */
  end(): void {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

interface FakeEngine {
  devices: MediaDevices
  /** What the engine will answer the next `getUserMedia` / `getDisplayMedia` with. */
  nextUser: () => Promise<unknown>
  nextDisplay: () => Promise<unknown>
  userCalls: unknown[]
  displayCalls: unknown[]
}

/** happy-dom has neither `MediaDevices` nor `MediaStreamTrack`: the engine's shape, faked. */
function fakeEngine(): FakeEngine {
  const engine = {
    userCalls: [],
    displayCalls: [],
    nextUser: () => Promise.resolve(new FakeStream([])),
    nextDisplay: () => Promise.resolve(new FakeStream([]))
  } as unknown as FakeEngine
  const getUserMedia = function (this: unknown, constraints?: unknown): Promise<unknown> {
    engine.userCalls.push(constraints)
    return engine.nextUser()
  }
  const getDisplayMedia = function (this: unknown, constraints?: unknown): Promise<unknown> {
    engine.displayCalls.push(constraints)
    return engine.nextDisplay()
  }
  Object.defineProperty(getUserMedia, 'name', { value: 'getUserMedia' })
  Object.defineProperty(getDisplayMedia, 'name', { value: 'getDisplayMedia' })
  class FakeMediaDevices {}
  for (const [name, fn] of [
    ['getUserMedia', getUserMedia],
    ['getDisplayMedia', getDisplayMedia]
  ] as const)
    Object.defineProperty(FakeMediaDevices.prototype, name, {
      value: fn,
      writable: true,
      configurable: true
    })
  Object.defineProperty(globalThis, 'MediaDevices', { value: FakeMediaDevices, configurable: true })
  Object.defineProperty(globalThis, 'MediaStreamTrack', { value: FakeTrack, configurable: true })
  engine.devices = new FakeMediaDevices() as unknown as MediaDevices
  return engine
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'MediaDevices')
  Reflect.deleteProperty(globalThis, 'MediaStreamTrack')
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Collects the shim's announcements on `document`. */
function announcements(): CaptureTrackCounts[] {
  const seen: CaptureTrackCounts[] = []
  document.addEventListener(CAPTURE_STATE_EVENT, (e) =>
    seen.push((e as CustomEvent<CaptureTrackCounts>).detail)
  )
  return seen
}

describe('installCaptureShim', () => {
  it('announces the camera and the microphone from a getUserMedia stream, and their end', async () => {
    const engine = fakeEngine()
    const seen = announcements()
    installCaptureShim(CAPTURE_STATE_EVENT)
    const cam = new FakeTrack('video')
    const mic = new FakeTrack('audio')
    engine.nextUser = () => Promise.resolve(new FakeStream([cam, mic]))
    const stream = await engine.devices.getUserMedia({ video: true, audio: true })
    await flush()
    expect(stream).toBeInstanceOf(FakeStream)
    expect(engine.userCalls).toEqual([{ video: true, audio: true }])
    expect(seen.at(-1)).toEqual({ camera: true, microphone: true, display: false })
    // A stopped track fires no `ended`: the wrapped `stop()` is what the shim hears.
    cam.stop()
    expect(cam.readyState).toBe('ended')
    expect(seen.at(-1)).toEqual({ camera: false, microphone: true, display: false })
    // The engine ending a track (device gone) counts too.
    mic.end()
    expect(seen.at(-1)).toEqual({ camera: false, microphone: false, display: false })
    expect(seen).toHaveLength(3)
  })

  it('counts a getDisplayMedia stream as the display whatever its track kinds', async () => {
    const engine = fakeEngine()
    const seen = announcements()
    installCaptureShim(CAPTURE_STATE_EVENT)
    const video = new FakeTrack('video')
    const audio = new FakeTrack('audio')
    engine.nextDisplay = () => Promise.resolve(new FakeStream([video, audio]))
    await engine.devices.getDisplayMedia({ video: true })
    await flush()
    expect(seen.at(-1)).toEqual({ camera: false, microphone: false, display: true })
    video.stop()
    expect(seen).toHaveLength(1)
    audio.stop()
    expect(seen.at(-1)).toEqual({ camera: false, microphone: false, display: false })
  })

  it('a clone keeps the source open until it too stops', async () => {
    const engine = fakeEngine()
    const seen = announcements()
    installCaptureShim(CAPTURE_STATE_EVENT)
    const cam = new FakeTrack('video')
    engine.nextUser = () => Promise.resolve(new FakeStream([cam]))
    await engine.devices.getUserMedia({ video: true })
    await flush()
    const copy = cam.clone()
    cam.stop()
    expect(seen.at(-1)).toEqual({ camera: true, microphone: false, display: false })
    copy.stop()
    expect(seen.at(-1)).toEqual({ camera: false, microphone: false, display: false })
  })

  it("a refused call announces nothing and the page's rejection is untouched", async () => {
    const engine = fakeEngine()
    const seen = announcements()
    installCaptureShim(CAPTURE_STATE_EVENT)
    const refusal = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    engine.nextUser = () => Promise.reject(refusal)
    await expect(engine.devices.getUserMedia({ audio: true })).rejects.toBe(refusal)
    await flush()
    expect(seen).toEqual([])
  })

  it("keeps the engine's function shape and leaves a page without the API alone", () => {
    const engine = fakeEngine()
    installCaptureShim(CAPTURE_STATE_EVENT)
    const proto = Object.getPrototypeOf(engine.devices) as Record<
      string,
      (...a: unknown[]) => unknown
    >
    expect(proto.getUserMedia.name).toBe('getUserMedia')
    expect(proto.getUserMedia.length).toBe(1)
    expect(proto.getDisplayMedia.name).toBe('getDisplayMedia')
    Reflect.deleteProperty(globalThis, 'MediaDevices')
    expect(() => installCaptureShim(CAPTURE_STATE_EVENT)).not.toThrow()
  })
})

describe('installCaptureReporter', () => {
  function reporter(): { sent: CaptureStateReport[]; shimEvent: string | null } {
    const out = { sent: [] as CaptureStateReport[], shimEvent: null as string | null }
    installCaptureReporter({
      id: 'frame-1',
      send: (message: PageScriptMessage) => {
        if (message.type === 'capture-state' && message.capture) out.sent.push(message.capture)
      },
      installShim: (eventName) => {
        out.shimEvent = eventName
      }
    })
    return out
  }
  const announce = (counts: Partial<CaptureTrackCounts>): void => {
    document.dispatchEvent(new CustomEvent(CAPTURE_STATE_EVENT, { detail: counts }))
  }

  it("installs the shim under the shared event name and relays its counts under the frame's id", () => {
    const r = reporter()
    expect(r.shimEvent).toBe(CAPTURE_STATE_EVENT)
    announce({ camera: true, microphone: false, display: false })
    expect(r.sent).toEqual([
      { id: 'frame-1', camera: true, microphone: false, display: false, pip: false }
    ])
    // The same state again is not resent.
    announce({ camera: true, microphone: false, display: false })
    expect(r.sent).toHaveLength(1)
    announce({ camera: false, microphone: false, display: false })
    expect(r.sent.at(-1)).toEqual({
      id: 'frame-1',
      camera: false,
      microphone: false,
      display: false,
      pip: false
    })
  })

  it('reports picture-in-picture from the media element events, by the document element', () => {
    const r = reporter()
    const video = document.createElement('video')
    document.body.appendChild(video)
    Object.defineProperty(document, 'pictureInPictureElement', {
      value: video,
      configurable: true
    })
    // The events are fired at the video; the reporter listens in the capture phase.
    video.dispatchEvent(new Event('enterpictureinpicture'))
    expect(r.sent.at(-1)).toMatchObject({ pip: true })
    Object.defineProperty(document, 'pictureInPictureElement', { value: null, configurable: true })
    video.dispatchEvent(new Event('leavepictureinpicture'))
    expect(r.sent.at(-1)).toMatchObject({ pip: false })
    Reflect.deleteProperty(document, 'pictureInPictureElement')
  })

  it('sends an all-clear at pagehide, once, so a leaving frame takes its state with it', () => {
    const r = reporter()
    announce({ camera: false, microphone: true, display: false })
    window.dispatchEvent(new Event('pagehide'))
    expect(r.sent.at(-1)).toEqual({
      id: 'frame-1',
      camera: false,
      microphone: false,
      display: false,
      pip: false
    })
    const n = r.sent.length
    window.dispatchEvent(new Event('pagehide'))
    expect(r.sent).toHaveLength(n)
  })
})

describe('tabAlertFor', () => {
  const frame = (over: Partial<CaptureStateReport>): CaptureStateReport => ({
    id: 'f',
    camera: false,
    microphone: false,
    display: false,
    pip: false,
    ...over
  })

  it("folds the frames' reports with Chrome's priority: recording > capturing > pip", () => {
    expect(tabAlertFor([])).toBeNull()
    expect(tabAlertFor([frame({ pip: true })])).toBe('pip')
    expect(tabAlertFor([frame({ pip: true }), frame({ id: 'g', display: true })])).toBe('capturing')
    expect(
      tabAlertFor([frame({ display: true }), frame({ id: 'g', microphone: true, pip: true })])
    ).toBe('recording')
    expect(alertOfReport(frame({ camera: true }))).toBe('recording')
    expect(alertOfReport(frame({}))).toBeNull()
  })

  it('a report with nothing live retires its frame', () => {
    expect(reportIsLive(frame({}))).toBe(false)
    expect(reportIsLive(frame({ pip: true }))).toBe(true)
  })

  it('takes only a well-formed report from the page', () => {
    expect(sanitiseCaptureReport(null)).toBeNull()
    expect(sanitiseCaptureReport({ camera: true })).toBeNull()
    expect(sanitiseCaptureReport({ id: '', camera: true })).toBeNull()
    expect(sanitiseCaptureReport({ id: 'x'.repeat(65) })).toBeNull()
    expect(sanitiseCaptureReport({ id: 'f', camera: 'yes', display: 1, pip: true })).toEqual({
      id: 'f',
      camera: false,
      microphone: false,
      display: false,
      pip: true
    })
  })

  it("names each state the way Chrome's tooltip does", () => {
    expect(tabAlertTooltip('recording')).toBe('This tab is using your camera or microphone')
    expect(tabAlertTooltip('capturing')).toBe("This tab's content is being shared")
    expect(tabAlertTooltip('pip')).toBe('This tab is playing picture-in-picture')
  })
})
