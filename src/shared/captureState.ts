/**
 * Tab alert indicators (tabs-43): the state Chrome draws in a tab's indicator slot – the camera
 * or microphone in use ("media recording"), the tab's content being shared ("capturing"),
 * picture-in-picture – with Chrome's priority when a tab has more than one. The desktop engine
 * exposes permission grants but no live capture state per WebContents, so the page reports it
 * the way `installActivationReporter` reports gestures: a shim in the page's main world wraps
 * `getUserMedia` / `getDisplayMedia` and counts the live tracks each hands out (their `stop()`,
 * their `clone()`, their `ended`), announcing changes on `document`; the isolated-world reporter
 * hears them, watches picture-in-picture itself (a DOM event, seen from any world) and sends the
 * browser one small `capture-state` message per change. Every frame reports for itself under its
 * own id (a Meet call lives in an iframe as readily as at the top), and the core folds the frames'
 * reports into the tab's `alert`.
 */
import type { PageScriptMessage } from './pageScript'

/** What the tab's indicator slot shows for capture, above the audio indicator. */
export type TabAlert = 'recording' | 'capturing' | 'pip'

/** One frame's live state, as its reporter sends it (`capture-state`). */
export interface CaptureStateReport {
  /** The reporter's id: one per document, so the core keeps every frame's state apart. */
  id: string
  camera: boolean
  microphone: boolean
  /** A `getDisplayMedia` stream is live: the tab is sharing a screen, window or tab. */
  display: boolean
  /** The document has a picture-in-picture element. */
  pip: boolean
}

/** The shim's word on the tracks it counts, `detail` of the DOM event it dispatches. */
export interface CaptureTrackCounts {
  camera: boolean
  microphone: boolean
  display: boolean
}

/** DOM event the main world dispatches on `document` whenever the live-track kinds change. */
export const CAPTURE_STATE_EVENT = 'zen-capture-state'

/** Chrome's order: recording > capturing > picture-in-picture (audio, below them, is the tab's own). */
const ALERT_PRIORITY: readonly TabAlert[] = ['recording', 'capturing', 'pip']

/** The alert a frame's report asks for on its own, highest first, or null for none. */
export function alertOfReport(report: Omit<CaptureStateReport, 'id'>): TabAlert | null {
  if (report.camera || report.microphone) return 'recording'
  if (report.display) return 'capturing'
  if (report.pip) return 'pip'
  return null
}

/** The tab's alert from every frame's report: the highest any of them asks for. */
export function tabAlertFor(reports: Iterable<Omit<CaptureStateReport, 'id'>>): TabAlert | null {
  let best: TabAlert | null = null
  for (const report of reports) {
    const alert = alertOfReport(report)
    if (alert && (best === null || ALERT_PRIORITY.indexOf(alert) < ALERT_PRIORITY.indexOf(best)))
      best = alert
  }
  return best
}

/**
 * What the tab is capturing, kind by kind (omnibox-38): the URL pill's in-use chip names the
 * camera, the microphone or the screen where the `alert` above only ranks them. Picture-in-
 * picture is no capture and is not here.
 */
export interface TabCapture {
  camera: boolean
  microphone: boolean
  /** A `getDisplayMedia` stream is live somewhere in the tab. */
  display: boolean
}

/** The kinds live in any of the tab's frames, or null while none is. */
export function tabCaptureFor(
  reports: Iterable<Omit<CaptureStateReport, 'id'>>
): TabCapture | null {
  const capture: TabCapture = { camera: false, microphone: false, display: false }
  for (const report of reports) {
    if (report.camera) capture.camera = true
    if (report.microphone) capture.microphone = true
    if (report.display) capture.display = true
  }
  return capture.camera || capture.microphone || capture.display ? capture : null
}

/** Two readings of the tab's capture say the same, null included. */
export function sameCapture(a: TabCapture | null | undefined, b: TabCapture | null): boolean {
  if (!a || !b) return (a ?? null) === b
  return a.camera === b.camera && a.microphone === b.microphone && a.display === b.display
}

/** A report worth keeping: some kind is live. One with nothing live retires its frame's entry. */
export function reportIsLive(report: Omit<CaptureStateReport, 'id'>): boolean {
  return report.camera || report.microphone || report.display || report.pip
}

/**
 * The report a page sent, if it is one (the core trusts nothing a page says without a look):
 * a string id and four booleans.
 */
export function sanitiseCaptureReport(raw: unknown): CaptureStateReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 64) return null
  return {
    id: r.id,
    camera: r.camera === true,
    microphone: r.microphone === true,
    display: r.display === true,
    pip: r.pip === true
  }
}

/** The tooltip the indicator carries, Chrome's words. */
export function tabAlertTooltip(alert: TabAlert): string {
  switch (alert) {
    case 'recording':
      return 'This tab is using your camera or microphone'
    case 'capturing':
      return "This tab's content is being shared"
    case 'pip':
      return 'This tab is playing picture-in-picture'
  }
}

/**
 * Runs in the page's main world (serialised, self-contained; never throws into the page): wraps
 * `MediaDevices.prototype.getUserMedia` and `getDisplayMedia` to count the live tracks they hand
 * out – a `getUserMedia` video track is the camera, an audio track the microphone, anything from
 * `getDisplayMedia` the display – and `MediaStreamTrack.prototype.stop` / `clone`, since a
 * stopped track fires no `ended` and a clone keeps the source open. Each change in which kinds
 * are live is dispatched on `document` as `eventName` with the three booleans as `detail`. The
 * calls, their promises and their errors stay the engine's.
 */
export function installCaptureShim(eventName: string): void {
  const win = globalThis as Window & typeof globalThis
  type Kind = 'camera' | 'microphone' | 'display'
  type AnyFn = (...args: never[]) => unknown
  const devices = (win as unknown as { MediaDevices?: { prototype: MediaDevices } }).MediaDevices
    ?.prototype
  const trackProto = (win as unknown as { MediaStreamTrack?: { prototype: MediaStreamTrack } })
    .MediaStreamTrack?.prototype
  if (!devices || !trackProto) return
  const live = new Map<MediaStreamTrack, Kind>()
  let last = ''
  const report = (): void => {
    const counts = { camera: false, microphone: false, display: false }
    for (const kind of live.values()) counts[kind] = true
    const key = `${counts.camera}${counts.microphone}${counts.display}`
    if (key === last) return
    last = key
    try {
      win.document.dispatchEvent(new CustomEvent(eventName, { detail: counts }))
    } catch {
      /* best effort */
    }
  }
  const forget = (track: MediaStreamTrack): void => {
    if (live.delete(track)) report()
  }
  const remember = (track: MediaStreamTrack, kind: Kind): void => {
    if (!track || track.readyState === 'ended' || live.has(track)) return
    live.set(track, kind)
    try {
      track.addEventListener('ended', () => forget(track))
    } catch {
      /* a track without events is forgotten at stop() */
    }
  }
  const rememberStream = (stream: MediaStream, display: boolean): void => {
    let tracks: MediaStreamTrack[] = []
    try {
      tracks = stream.getTracks()
    } catch {
      return
    }
    for (const track of tracks)
      remember(track, display ? 'display' : track.kind === 'video' ? 'camera' : 'microphone')
    report()
  }
  const define = (target: object, name: string, wrapped: AnyFn, native: AnyFn): void => {
    try {
      // The engine's function has no declared parameters and its own name; a page comparing the
      // two (feature probes read `length` and `name`) sees the same.
      Object.defineProperty(wrapped, 'length', { value: native.length, configurable: true })
      Object.defineProperty(wrapped, 'name', { value: native.name, configurable: true })
    } catch {
      /* the shape is cosmetic */
    }
    try {
      Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapped })
    } catch {
      /* a frozen prototype keeps the engine's own */
    }
  }
  const wrapGetter = (name: 'getUserMedia' | 'getDisplayMedia', display: boolean): void => {
    const native = devices[name] as unknown
    if (typeof native !== 'function') return
    const call = native as (this: MediaDevices, ...args: unknown[]) => Promise<MediaStream>
    const wrapped = function (this: MediaDevices, ...args: unknown[]): Promise<MediaStream> {
      const result = call.apply(this, args)
      try {
        void Promise.resolve(result).then(
          (stream) => {
            if (stream) rememberStream(stream, display)
          },
          () => undefined
        )
      } catch {
        /* the page's promise is untouched */
      }
      return result
    }
    define(devices, name, wrapped, call as AnyFn)
  }
  wrapGetter('getUserMedia', false)
  wrapGetter('getDisplayMedia', true)
  const nativeStop = trackProto.stop
  if (typeof nativeStop === 'function') {
    const stop = function (this: MediaStreamTrack): void {
      try {
        return nativeStop.call(this)
      } finally {
        forget(this)
      }
    }
    define(trackProto, 'stop', stop, nativeStop as AnyFn)
  }
  const nativeClone = trackProto.clone
  if (typeof nativeClone === 'function') {
    const clone = function (this: MediaStreamTrack): MediaStreamTrack {
      const copy = nativeClone.call(this)
      const kind = live.get(this)
      if (kind) {
        remember(copy, kind)
        report()
      }
      return copy
    }
    define(trackProto, 'clone', clone, nativeClone as AnyFn)
  }
  // The legacy callback form (`navigator.webkitGetUserMedia`) still opens the camera in Chromium.
  const nav = win.navigator as Navigator & {
    webkitGetUserMedia?: (
      constraints: MediaStreamConstraints,
      onSuccess: (stream: MediaStream) => void,
      onError: (error: unknown) => void
    ) => void
  }
  const legacy = nav.webkitGetUserMedia
  if (typeof legacy === 'function') {
    const wrapped = function (
      this: Navigator,
      constraints: MediaStreamConstraints,
      onSuccess: (stream: MediaStream) => void,
      onError: (error: unknown) => void
    ): void {
      return legacy.call(
        this,
        constraints,
        (stream: MediaStream) => {
          try {
            rememberStream(stream, false)
          } catch {
            /* the page's callback still runs */
          }
          onSuccess(stream)
        },
        onError
      )
    }
    define(nav, 'webkitGetUserMedia', wrapped as AnyFn, legacy as AnyFn)
  }
}

/** The isolated world's transport. */
export interface CaptureReporterTransport {
  send(message: PageScriptMessage): void
  /** Run `installCaptureShim` in the main world with this event name. */
  installShim(eventName: string): void
  /** The reporter's id; a random one by default (tests pass a fixed one). */
  id?: string
}

/** A document's fullscreen-independent PiP element, under the standard name. */
function pipElementOf(doc: Document): Element | null {
  return (
    (doc as Document & { pictureInPictureElement?: Element | null }).pictureInPictureElement ?? null
  )
}

/**
 * The isolated-world half, in every frame: installs the shim, hears its counts, watches
 * picture-in-picture (`enterpictureinpicture` / `leavepictureinpicture` reach a capture listener
 * on the document from any world) and sends the browser one `capture-state` message per change
 * – and an all-clear at `pagehide`, so a frame that navigates away or is removed takes its state
 * with it even where the engine tells the browser nothing.
 */
export function installCaptureReporter(
  transport: CaptureReporterTransport,
  eventName: string = CAPTURE_STATE_EVENT
): void {
  const id = transport.id ?? Math.random().toString(36).slice(2, 12)
  const state: CaptureStateReport = {
    id,
    camera: false,
    microphone: false,
    display: false,
    pip: false
  }
  let sent = ''
  const send = (): void => {
    const key = `${state.camera}${state.microphone}${state.display}${state.pip}`
    if (key === sent) return
    sent = key
    try {
      transport.send({ type: 'capture-state', capture: { ...state } })
    } catch {
      /* the browser is unreachable; the next change tries again */
    }
  }
  document.addEventListener(eventName, (e) => {
    const detail = (e as CustomEvent<Partial<CaptureTrackCounts> | null>).detail
    state.camera = detail?.camera === true
    state.microphone = detail?.microphone === true
    state.display = detail?.display === true
    send()
  })
  const onPip = (): void => {
    state.pip = pipElementOf(document) !== null
    send()
  }
  document.addEventListener('enterpictureinpicture', onPip, true)
  document.addEventListener('leavepictureinpicture', onPip, true)
  window.addEventListener('pagehide', () => {
    state.camera = state.microphone = state.display = state.pip = false
    send()
  })
  transport.installShim(eventName)
}
