/**
 * Tab alert indicators (tabs-43): the state Chrome draws in a tab's indicator slot – the camera
 * or microphone in use ("media recording"), the tab's content being shared ("capturing"), a
 * Bluetooth, USB, HID or serial device the page holds open, picture-in-picture, a VR headset
 * being presented to – with Chrome's priority when a tab has more than one. The desktop engine
 * exposes permission grants but no live capture or device state per WebContents, so the page
 * reports it the way `installActivationReporter` reports gestures: a shim in the page's main
 * world wraps `getUserMedia` / `getDisplayMedia` and counts the live tracks each hands out
 * (their `stop()`, their `clone()`, their `ended`), a second wraps the device sessions –
 * `USBDevice` / `HIDDevice` / `SerialPort` `open()` and `close()`, a GATT server's `connect()`,
 * an immersive `XRSession` – and both announce changes on `document`; the isolated-world
 * reporter hears them, watches picture-in-picture itself (a DOM event, seen from any world) and
 * sends the browser one small `capture-state` message per change. Every frame reports for
 * itself under its own id (a Meet call lives in an iframe as readily as at the top), and the
 * core folds the frames' reports into the tab's `alert`.
 *
 * Shared with the Android host, where the device half is inert: the WebView has no WebUSB, WebHID
 * or Web Serial (their constructors are absent, and the shim leaves a page without an API alone),
 * and Web Bluetooth – Android Chrome's – is not enabled in the WebView either; WebXR immersive
 * sessions need a runtime the WebView does not ship. The capture half works there as before.
 */
import type { PageScriptMessage } from './pageScript'

/**
 * What the tab's indicator slot shows above the audio indicator, in Chrome's order: the camera
 * or microphone in use, the content shared, a Bluetooth device connected, a USB device, a HID
 * device, a serial port, picture-in-picture, VR content presented to a headset.
 */
export type TabAlert =
  'recording' | 'capturing' | 'bluetooth' | 'usb' | 'hid' | 'serial' | 'pip' | 'vr'

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
  /** A Web Bluetooth GATT server the page connected is still connected. */
  bluetooth: boolean
  /** A WebUSB device the page opened is still open. */
  usb: boolean
  /** A WebHID device the page opened is still open. */
  hid: boolean
  /** A Web Serial port the page opened is still open. */
  serial: boolean
  /** An immersive WebXR session the page requested has not ended. */
  vr: boolean
}

/** The shim's word on the tracks it counts, `detail` of the DOM event it dispatches. */
export interface CaptureTrackCounts {
  camera: boolean
  microphone: boolean
  display: boolean
}

/** The device shim's word on the sessions it holds, `detail` of the DOM event it dispatches. */
export interface DeviceSessionCounts {
  bluetooth: boolean
  usb: boolean
  hid: boolean
  serial: boolean
  vr: boolean
}

/** DOM event the main world dispatches on `document` whenever the live-track kinds change. */
export const CAPTURE_STATE_EVENT = 'zen-capture-state'

/** DOM event the main world dispatches on `document` whenever the open device kinds change. */
export const DEVICE_STATE_EVENT = 'zen-device-state'

/**
 * Chrome's order (`GetTabAlertStatesForContents`): recording > capturing > Bluetooth > USB >
 * HID > serial > picture-in-picture > VR (audio, below them all, is the tab's own). Bluetooth
 * scanning (`BLUETOOTH_SCAN_ACTIVE`, between connected and USB) is not reported: the LE scan API
 * is behind a flag and no page of ours can start one.
 */
const ALERT_PRIORITY: readonly TabAlert[] = [
  'recording',
  'capturing',
  'bluetooth',
  'usb',
  'hid',
  'serial',
  'pip',
  'vr'
]

/** The alert a frame's report asks for on its own, highest first, or null for none. */
export function alertOfReport(report: Omit<CaptureStateReport, 'id'>): TabAlert | null {
  if (report.camera || report.microphone) return 'recording'
  if (report.display) return 'capturing'
  if (report.bluetooth) return 'bluetooth'
  if (report.usb) return 'usb'
  if (report.hid) return 'hid'
  if (report.serial) return 'serial'
  if (report.pip) return 'pip'
  if (report.vr) return 'vr'
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

/** A report worth keeping: some kind is live. One with nothing live retires its frame's entry. */
export function reportIsLive(report: Omit<CaptureStateReport, 'id'>): boolean {
  return (
    report.camera ||
    report.microphone ||
    report.display ||
    report.pip ||
    report.bluetooth ||
    report.usb ||
    report.hid ||
    report.serial ||
    report.vr
  )
}

/**
 * The report a page sent, if it is one (the core trusts nothing a page says without a look):
 * a string id and nine booleans (a field a page left out reads false).
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
    pip: r.pip === true,
    bluetooth: r.bluetooth === true,
    usb: r.usb === true,
    hid: r.hid === true,
    serial: r.serial === true,
    vr: r.vr === true
  }
}

/**
 * The tooltip the indicator carries, Chrome's words (`IDS_TOOLTIP_TAB_ALERT_STATE_*`; the HID
 * one with its noun, where Chrome's stops at "a HID").
 */
export function tabAlertTooltip(alert: TabAlert): string {
  switch (alert) {
    case 'recording':
      return 'This tab is using your camera or microphone'
    case 'capturing':
      return "This tab's content is being shared"
    case 'bluetooth':
      return 'This tab is connected to a Bluetooth device'
    case 'usb':
      return 'This tab is connected to a USB device'
    case 'hid':
      return 'This tab is connected to a HID device'
    case 'serial':
      return 'This tab is connected to a serial port'
    case 'pip':
      return 'This tab is playing picture-in-picture'
    case 'vr':
      return 'This tab is presenting VR content to a headset'
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

/**
 * Runs in the page's main world (serialised, self-contained; never throws into the page): wraps
 * the device sessions a page can hold – `USBDevice`, `HIDDevice` and `SerialPort` `open()` /
 * `close()` / `forget()`, a `BluetoothRemoteGATTServer`'s `connect()` / `disconnect()` and its
 * device's `forget()`, `XRSystem.requestSession` for an immersive session and `XRSession.end()`
 * – and keeps the set of sessions that are open: added when an open or connect resolves, dropped
 * when a close, forget, disconnect or end settles (a close refused – a serial port whose streams
 * are still locked – keeps a port that reads as open), and when the engine says the device went
 * (`disconnect` on `navigator.usb` / `navigator.hid` / `navigator.serial`, the device's
 * `gattserverdisconnected`, the session's `end`). Each change in which kinds are open is
 * dispatched on `document` as `eventName` with five booleans as `detail`. The calls, their
 * promises and their errors stay the engine's; a page without an API is left alone.
 */
export function installDeviceShim(eventName: string): void {
  const win = globalThis as Window & typeof globalThis
  type Kind = 'bluetooth' | 'usb' | 'hid' | 'serial' | 'vr'
  type AnyFn = (...args: never[]) => unknown
  type Proto = Record<string, unknown>
  const globals = win as unknown as Record<string, { prototype?: Proto } | undefined>
  const nav = win.navigator as Navigator & Record<string, EventTarget | undefined>
  const open = new Map<object, Kind>()
  let last = ''
  const report = (): void => {
    const counts = { bluetooth: false, usb: false, hid: false, serial: false, vr: false }
    for (const kind of open.values()) counts[kind] = true
    const key = `${counts.bluetooth}${counts.usb}${counts.hid}${counts.serial}${counts.vr}`
    if (key === last) return
    last = key
    try {
      win.document.dispatchEvent(new CustomEvent(eventName, { detail: counts }))
    } catch {
      /* best effort */
    }
  }
  const add = (session: unknown, kind: Kind): void => {
    if (!session || typeof session !== 'object' || open.has(session)) return
    open.set(session, kind)
    report()
  }
  const drop = (session: unknown): void => {
    if (session && typeof session === 'object' && open.delete(session)) report()
  }
  const define = (target: object, name: string, wrapped: AnyFn, native: AnyFn): void => {
    try {
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
  /**
   * Wrap a method whose result (a promise, or not) tells `after` how it settled: `ok` true on a
   * resolve or a plain return, false on a rejection or a throw; the result is handed back as the
   * engine gave it, the throw rethrown.
   */
  const wrap = (
    proto: Proto | undefined,
    name: string,
    after: (self: object, ok: boolean, value: unknown, args: unknown[]) => void
  ): void => {
    const native = proto?.[name]
    if (!proto || typeof native !== 'function') return
    const call = native as (this: object, ...args: unknown[]) => unknown
    const wrapped = function (this: object, ...args: unknown[]): unknown {
      let result: unknown
      try {
        result = call.apply(this, args)
      } catch (error) {
        try {
          after(this, false, undefined, args)
        } catch {
          /* the page's error is what matters */
        }
        throw error
      }
      try {
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void Promise.resolve(result).then(
            (value) => after(this, true, value, args),
            () => after(this, false, undefined, args)
          )
        } else after(this, true, result, args)
      } catch {
        /* the page's result is untouched */
      }
      return result
    }
    define(proto, name, wrapped, call as AnyFn)
  }
  // The engine's own word on whether a session is still open, where it has one.
  const stillOpen = (session: object, kind: Kind): boolean => {
    const s = session as Record<string, unknown>
    switch (kind) {
      case 'usb':
      case 'hid':
        return s.opened === true
      case 'serial':
        return s.readable != null || s.writable != null
      case 'bluetooth':
        return s.connected === true
      default:
        return false
    }
  }
  // WebUSB, WebHID, Web Serial: open() adds, close() and forget() drop, the API's `disconnect`
  // event drops the device that went.
  const wrapDevice = (
    ctor: string,
    api: string,
    kind: Kind,
    eventDevice: 'device' | 'target'
  ): void => {
    const proto = globals[ctor]?.prototype
    if (!proto) return
    wrap(proto, 'open', (self, ok) => {
      if (ok || stillOpen(self, kind)) add(self, kind)
    })
    wrap(proto, 'close', (self, ok) => {
      if (ok || !stillOpen(self, kind)) drop(self)
    })
    wrap(proto, 'forget', (self) => drop(self))
    try {
      nav[api]?.addEventListener('disconnect', (e) => {
        const gone =
          eventDevice === 'device' ? (e as Event & { device?: unknown }).device : e.target
        drop(gone)
      })
    } catch {
      /* no API on this navigator */
    }
  }
  wrapDevice('USBDevice', 'usb', 'usb', 'device')
  wrapDevice('HIDDevice', 'hid', 'hid', 'device')
  wrapDevice('SerialPort', 'serial', 'serial', 'target')
  // Web Bluetooth: the GATT server's connect() adds it, disconnect() and the device's forget()
  // drop it, and so does `gattserverdisconnected` at the device (the engine's word: the device
  // went out of range, or another page took it).
  const gatt = globals.BluetoothRemoteGATTServer?.prototype
  const watched = new WeakSet<object>()
  wrap(gatt, 'connect', (self, ok) => {
    if (!ok && !stillOpen(self, 'bluetooth')) return
    add(self, 'bluetooth')
    const device = (self as { device?: EventTarget }).device
    if (device && typeof device.addEventListener === 'function' && !watched.has(device)) {
      watched.add(device)
      try {
        device.addEventListener('gattserverdisconnected', () => drop(self))
      } catch {
        /* disconnect() and forget() still drop it */
      }
    }
  })
  wrap(gatt, 'disconnect', (self) => drop(self))
  wrap(globals.BluetoothDevice?.prototype, 'forget', (self) =>
    drop((self as { gatt?: unknown }).gatt)
  )
  // WebXR: an immersive session (`immersive-vr`, `immersive-ar`) presents to the headset from
  // the moment `requestSession` resolves until it ends – by `end()` or the runtime's `end` event.
  // An `inline` session draws in the page and is not one.
  wrap(globals.XRSystem?.prototype, 'requestSession', (_self, ok, session, args) => {
    if (!ok || typeof args[0] !== 'string' || !args[0].startsWith('immersive')) return
    add(session, 'vr')
    const target = session as EventTarget | null
    if (target && typeof target.addEventListener === 'function') {
      try {
        target.addEventListener('end', () => drop(session))
      } catch {
        /* end() still drops it */
      }
    }
  })
  wrap(globals.XRSession?.prototype, 'end', (self) => drop(self))
}

/** The isolated world's transport. */
export interface CaptureReporterTransport {
  send(message: PageScriptMessage): void
  /** Run `installCaptureShim` in the main world with this event name. */
  installShim(eventName: string): void
  /**
   * Run `installDeviceShim` in the main world with this event name (tabs-43's device kinds);
   * a host without it reports no device sessions.
   */
  installDeviceShim?(eventName: string): void
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
 * The isolated-world half, in every frame: installs the shims, hears their counts, watches
 * picture-in-picture (`enterpictureinpicture` / `leavepictureinpicture` reach a capture listener
 * on the document from any world) and sends the browser one `capture-state` message per change
 * – and an all-clear at `pagehide`, so a frame that navigates away or is removed takes its state
 * with it even where the engine tells the browser nothing.
 */
export function installCaptureReporter(
  transport: CaptureReporterTransport,
  eventName: string = CAPTURE_STATE_EVENT,
  deviceEventName: string = DEVICE_STATE_EVENT
): void {
  const id = transport.id ?? Math.random().toString(36).slice(2, 12)
  const state: CaptureStateReport = {
    id,
    camera: false,
    microphone: false,
    display: false,
    pip: false,
    bluetooth: false,
    usb: false,
    hid: false,
    serial: false,
    vr: false
  }
  let sent = ''
  const send = (): void => {
    const key =
      `${state.camera}${state.microphone}${state.display}${state.pip}` +
      `${state.bluetooth}${state.usb}${state.hid}${state.serial}${state.vr}`
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
  document.addEventListener(deviceEventName, (e) => {
    const detail = (e as CustomEvent<Partial<DeviceSessionCounts> | null>).detail
    state.bluetooth = detail?.bluetooth === true
    state.usb = detail?.usb === true
    state.hid = detail?.hid === true
    state.serial = detail?.serial === true
    state.vr = detail?.vr === true
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
    state.bluetooth = state.usb = state.hid = state.serial = state.vr = false
    send()
  })
  transport.installShim(eventName)
  transport.installDeviceShim?.(deviceEventName)
}
