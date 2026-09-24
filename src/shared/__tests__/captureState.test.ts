// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTURE_STATE_EVENT,
  DEVICE_STATE_EVENT,
  alertOfReport,
  installCaptureReporter,
  installCaptureShim,
  installDeviceShim,
  reportIsLive,
  sanitiseCaptureReport,
  tabAlertFor,
  tabAlertTooltip,
  type CaptureStateReport,
  type CaptureTrackCounts,
  type DeviceSessionCounts
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

/** A report with nothing live, less its id. */
const clear = (): Omit<CaptureStateReport, 'id'> => ({
  camera: false,
  microphone: false,
  display: false,
  pip: false,
  bluetooth: false,
  usb: false,
  hid: false,
  serial: false,
  vr: false
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
    expect(r.sent).toEqual([{ id: 'frame-1', ...clear(), camera: true }])
    // The same state again is not resent.
    announce({ camera: true, microphone: false, display: false })
    expect(r.sent).toHaveLength(1)
    announce({ camera: false, microphone: false, display: false })
    expect(r.sent.at(-1)).toEqual({ id: 'frame-1', ...clear() })
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
    expect(r.sent.at(-1)).toEqual({ id: 'frame-1', ...clear() })
    const n = r.sent.length
    window.dispatchEvent(new Event('pagehide'))
    expect(r.sent).toHaveLength(n)
  })
})

describe('tabAlertFor', () => {
  const frame = (over: Partial<CaptureStateReport>): CaptureStateReport => ({
    id: 'f',
    ...clear(),
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

  it('slots the device kinds where Chrome does: below recording and capturing, Bluetooth > USB > HID > serial, above picture-in-picture, VR last (tabs-43)', () => {
    expect(alertOfReport(frame({ vr: true }))).toBe('vr')
    expect(alertOfReport(frame({ vr: true, pip: true }))).toBe('pip')
    expect(alertOfReport(frame({ pip: true, serial: true }))).toBe('serial')
    expect(alertOfReport(frame({ serial: true, hid: true }))).toBe('hid')
    expect(alertOfReport(frame({ hid: true, usb: true }))).toBe('usb')
    expect(alertOfReport(frame({ usb: true, bluetooth: true }))).toBe('bluetooth')
    expect(alertOfReport(frame({ bluetooth: true, display: true }))).toBe('capturing')
    expect(alertOfReport(frame({ bluetooth: true, usb: true, microphone: true }))).toBe('recording')
    // Across frames the same order: a USB device in one frame outranks another's PiP, and a
    // sharing frame outranks both.
    expect(tabAlertFor([frame({ pip: true }), frame({ id: 'g', usb: true })])).toBe('usb')
    expect(
      tabAlertFor([
        frame({ usb: true }),
        frame({ id: 'g', display: true }),
        frame({ id: 'h', vr: true })
      ])
    ).toBe('capturing')
    expect(tabAlertFor([frame({ hid: true }), frame({ id: 'g', bluetooth: true })])).toBe(
      'bluetooth'
    )
  })

  it('a report with nothing live retires its frame', () => {
    expect(reportIsLive(frame({}))).toBe(false)
    expect(reportIsLive(frame({ pip: true }))).toBe(true)
    for (const kind of ['bluetooth', 'usb', 'hid', 'serial', 'vr'] as const)
      expect(reportIsLive(frame({ [kind]: true })), kind).toBe(true)
  })

  it('takes only a well-formed report from the page', () => {
    expect(sanitiseCaptureReport(null)).toBeNull()
    expect(sanitiseCaptureReport({ camera: true })).toBeNull()
    expect(sanitiseCaptureReport({ id: '', camera: true })).toBeNull()
    expect(sanitiseCaptureReport({ id: 'x'.repeat(65) })).toBeNull()
    expect(sanitiseCaptureReport({ id: 'f', camera: 'yes', display: 1, pip: true })).toEqual({
      id: 'f',
      ...clear(),
      pip: true
    })
    // The device booleans the same way: true alone counts, and a field left out reads false
    // (a report from a reporter older than the field).
    expect(
      sanitiseCaptureReport({
        id: 'f',
        bluetooth: true,
        usb: 'open',
        hid: 1,
        serial: true,
        vr: null
      })
    ).toEqual({ id: 'f', ...clear(), bluetooth: true, serial: true })
  })

  it("names each state the way Chrome's tooltip does", () => {
    expect(tabAlertTooltip('recording')).toBe('This tab is using your camera or microphone')
    expect(tabAlertTooltip('capturing')).toBe("This tab's content is being shared")
    expect(tabAlertTooltip('bluetooth')).toBe('This tab is connected to a Bluetooth device')
    expect(tabAlertTooltip('usb')).toBe('This tab is connected to a USB device')
    expect(tabAlertTooltip('hid')).toBe('This tab is connected to a HID device')
    expect(tabAlertTooltip('serial')).toBe('This tab is connected to a serial port')
    expect(tabAlertTooltip('pip')).toBe('This tab is playing picture-in-picture')
    expect(tabAlertTooltip('vr')).toBe('This tab is presenting VR content to a headset')
  })
})

/*
 * The device shim (tabs-43's device kinds): happy-dom has none of the device APIs, so each is
 * faked in the engine's shape – a constructor whose prototype carries the methods, an API
 * object on `navigator` that fires `disconnect` – and the shim wraps the prototypes as it
 * would the engine's.
 */
class FakeOpenable {
  opened = false
  /** What the engine answers the next open / close with. */
  nextOpen: () => Promise<void> = () => Promise.resolve()
  nextClose: () => Promise<void> = () => Promise.resolve()
}
// Two classes with their own prototypes, as the engine's: a shared prototype would make the
// USB wrapper count a HID device.
class FakeUsbDevice extends FakeOpenable {}
class FakeHidDevice extends FakeOpenable {}
class FakeSerialPort {
  readable: object | null = null
  writable: object | null = null
  nextOpen: () => Promise<void> = () => Promise.resolve()
  nextClose: () => Promise<void> = () => Promise.resolve()
}
class FakeBluetoothDevice extends EventTarget {
  gatt: FakeGattServer | null = null
}
class FakeGattServer {
  connected = false
  constructor(public device: FakeBluetoothDevice) {
    device.gatt = this
  }
  nextConnect: () => Promise<FakeGattServer> = () => Promise.resolve(this)
}
class FakeXrSession extends EventTarget {}
class FakeXrSystem {
  nextSession: () => Promise<FakeXrSession> = () => Promise.resolve(new FakeXrSession())
}

/** Puts a method on a prototype the way the engine's IDL would: writable, configurable, named. */
function method(proto: object, name: string, fn: (...args: unknown[]) => unknown): void {
  Object.defineProperty(fn, 'name', { value: name })
  Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true })
}

// The engine's method shapes, as the page sees them (TS's lib has none of these APIs).
interface Openable {
  open(...args: unknown[]): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
}
interface Gatt {
  connect(): Promise<unknown>
  disconnect(): void
}
interface Forgettable {
  forget(): Promise<void>
}
interface Xr {
  requestSession(mode: string): Promise<FakeXrSession & { end(): Promise<void> }>
}

interface FakeDevices {
  usb: EventTarget
  hid: EventTarget
  serial: EventTarget
}

/** The five APIs, faked on the globals and on `navigator`. */
function fakeDevices(): FakeDevices {
  for (const proto of [FakeUsbDevice.prototype, FakeHidDevice.prototype]) {
    method(proto, 'open', function (this: FakeOpenable) {
      return this.nextOpen().then(() => {
        this.opened = true
      })
    })
    method(proto, 'close', function (this: FakeOpenable) {
      return this.nextClose().then(() => {
        this.opened = false
      })
    })
    method(proto, 'forget', function (this: FakeOpenable) {
      this.opened = false
      return Promise.resolve()
    })
  }
  method(FakeSerialPort.prototype, 'open', function (this: FakeSerialPort) {
    return this.nextOpen().then(() => {
      this.readable = {}
      this.writable = {}
    })
  })
  method(FakeSerialPort.prototype, 'close', function (this: FakeSerialPort) {
    return this.nextClose().then(() => {
      this.readable = null
      this.writable = null
    })
  })
  method(FakeSerialPort.prototype, 'forget', function (this: FakeSerialPort) {
    this.readable = this.writable = null
    return Promise.resolve()
  })
  method(FakeGattServer.prototype, 'connect', function (this: FakeGattServer) {
    return this.nextConnect().then((server) => {
      this.connected = true
      return server
    })
  })
  method(FakeGattServer.prototype, 'disconnect', function (this: FakeGattServer) {
    this.connected = false
  })
  method(FakeBluetoothDevice.prototype, 'forget', function (this: FakeBluetoothDevice) {
    if (this.gatt) this.gatt.connected = false
    return Promise.resolve()
  })
  method(FakeXrSystem.prototype, 'requestSession', function (this: FakeXrSystem) {
    return this.nextSession()
  })
  method(FakeXrSession.prototype, 'end', function (this: FakeXrSession) {
    return Promise.resolve()
  })
  const devices: FakeDevices = {
    usb: new EventTarget(),
    hid: new EventTarget(),
    serial: new EventTarget()
  }
  for (const [name, ctor] of [
    ['USBDevice', FakeUsbDevice],
    ['HIDDevice', FakeHidDevice],
    ['SerialPort', FakeSerialPort],
    ['BluetoothRemoteGATTServer', FakeGattServer],
    ['BluetoothDevice', FakeBluetoothDevice],
    ['XRSystem', FakeXrSystem],
    ['XRSession', FakeXrSession]
  ] as const)
    Object.defineProperty(globalThis, name, { value: ctor, configurable: true })
  for (const name of ['usb', 'hid', 'serial'] as const)
    Object.defineProperty(navigator, name, { value: devices[name], configurable: true })
  return devices
}

function unfakeDevices(): void {
  for (const name of [
    'USBDevice',
    'HIDDevice',
    'SerialPort',
    'BluetoothRemoteGATTServer',
    'BluetoothDevice',
    'XRSystem',
    'XRSession'
  ])
    Reflect.deleteProperty(globalThis, name)
  for (const name of ['usb', 'hid', 'serial']) Reflect.deleteProperty(navigator, name)
  for (const proto of [
    FakeUsbDevice.prototype,
    FakeHidDevice.prototype,
    FakeSerialPort.prototype,
    FakeGattServer.prototype,
    FakeBluetoothDevice.prototype,
    FakeXrSystem.prototype,
    FakeXrSession.prototype
  ])
    for (const name of [
      'open',
      'close',
      'forget',
      'connect',
      'disconnect',
      'requestSession',
      'end'
    ])
      Reflect.deleteProperty(proto, name)
}

/** Collects the device shim's announcements on `document`. */
function deviceAnnouncements(): DeviceSessionCounts[] {
  const seen: DeviceSessionCounts[] = []
  document.addEventListener(DEVICE_STATE_EVENT, (e) =>
    seen.push((e as CustomEvent<DeviceSessionCounts>).detail)
  )
  return seen
}

const none: DeviceSessionCounts = {
  bluetooth: false,
  usb: false,
  hid: false,
  serial: false,
  vr: false
}

describe('installDeviceShim (tabs-43)', () => {
  afterEach(unfakeDevices)

  it('announces a USB device from its open() to its close(), and a HID device the same; a refused open announces nothing', async () => {
    fakeDevices()
    const seen = deviceAnnouncements()
    installDeviceShim(DEVICE_STATE_EVENT)
    const usb = new FakeUsbDevice()
    const hid = new FakeHidDevice()
    await (usb as unknown as Openable).open()
    await flush()
    expect(usb.opened).toBe(true)
    expect(seen.at(-1)).toEqual({ ...none, usb: true })
    await (hid as unknown as Openable).open()
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, usb: true, hid: true })
    await (usb as unknown as Openable).close()
    await flush()
    expect(usb.opened).toBe(false)
    expect(seen.at(-1)).toEqual({ ...none, hid: true })
    await (hid as unknown as Openable).close()
    await flush()
    expect(seen.at(-1)).toEqual(none)
    expect(seen).toHaveLength(4)
    // A second device the engine refuses (busy, no permission): the page's rejection is
    // untouched and nothing is announced.
    const busy = new FakeUsbDevice()
    const refusal = Object.assign(new Error('Access denied'), { name: 'SecurityError' })
    busy.nextOpen = () => Promise.reject(refusal)
    await expect((busy as unknown as Openable).open()).rejects.toBe(refusal)
    await flush()
    expect(seen).toHaveLength(4)
  })

  it("drops a device on forget() and on the API's disconnect event – the engine's word that it went", async () => {
    const devices = fakeDevices()
    const seen = deviceAnnouncements()
    installDeviceShim(DEVICE_STATE_EVENT)
    const a = new FakeUsbDevice()
    const b = new FakeUsbDevice()
    await (a as unknown as Openable).open()
    await (b as unknown as Openable).open()
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, usb: true })
    // The engine fires `disconnect` at navigator.usb with the device that went.
    devices.usb.dispatchEvent(Object.assign(new Event('disconnect'), { device: a }))
    expect(seen).toHaveLength(1)
    await (b as unknown as Openable).forget()
    await flush()
    expect(seen.at(-1)).toEqual(none)
    // A device the shim never saw open going is nothing to announce.
    devices.usb.dispatchEvent(
      Object.assign(new Event('disconnect'), { device: new FakeUsbDevice() })
    )
    expect(seen).toHaveLength(2)
  })

  it('a serial port is open from open() until its close() settles; a close refused while its streams are locked keeps it', async () => {
    const devices = fakeDevices()
    const seen = deviceAnnouncements()
    installDeviceShim(DEVICE_STATE_EVENT)
    const port = new FakeSerialPort()
    await (port as unknown as Openable).open({ baudRate: 9600 })
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, serial: true })
    // The streams are locked: the engine refuses the close and the port stays open.
    const locked = Object.assign(new Error('locked'), { name: 'InvalidStateError' })
    port.nextClose = () => Promise.reject(locked)
    await expect((port as unknown as Openable).close()).rejects.toBe(locked)
    await flush()
    expect(seen).toHaveLength(1)
    port.nextClose = () => Promise.resolve()
    await (port as unknown as Openable).close()
    await flush()
    expect(seen.at(-1)).toEqual(none)
    // The port fires `disconnect` itself, bubbling to navigator.serial: the target is the port.
    await (port as unknown as Openable).open({ baudRate: 9600 })
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, serial: true })
    const gone = new Event('disconnect')
    Object.defineProperty(gone, 'target', { value: port })
    devices.serial.dispatchEvent(gone)
    expect(seen.at(-1)).toEqual(none)
  })

  it("a Bluetooth device is connected from the GATT server's connect() until disconnect(), the device's forget() or gattserverdisconnected", async () => {
    fakeDevices()
    const seen = deviceAnnouncements()
    installDeviceShim(DEVICE_STATE_EVENT)
    const device = new FakeBluetoothDevice()
    const server = new FakeGattServer(device)
    const connected = await (server as unknown as Gatt).connect()
    await flush()
    expect(connected).toBe(server)
    expect(seen.at(-1)).toEqual({ ...none, bluetooth: true })
    ;(server as unknown as Gatt).disconnect()
    expect(seen.at(-1)).toEqual(none)
    // Out of range: the engine fires `gattserverdisconnected` at the device.
    await (server as unknown as Gatt).connect()
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, bluetooth: true })
    device.dispatchEvent(new Event('gattserverdisconnected'))
    expect(seen.at(-1)).toEqual(none)
    // forget() on the device drops its server.
    await (server as unknown as Gatt).connect()
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, bluetooth: true })
    await (device as unknown as Forgettable).forget()
    await flush()
    expect(seen.at(-1)).toEqual(none)
    expect(seen).toHaveLength(6)
  })

  it('an immersive XR session presents from requestSession() until end() or the end event; an inline session is not one', async () => {
    fakeDevices()
    const seen = deviceAnnouncements()
    installDeviceShim(DEVICE_STATE_EVENT)
    const xr = new FakeXrSystem() as unknown as Xr
    const inline = await xr.requestSession('inline')
    await flush()
    expect(inline).toBeInstanceOf(FakeXrSession)
    expect(seen).toEqual([])
    const session = await xr.requestSession('immersive-vr')
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, vr: true })
    await session.end()
    await flush()
    expect(seen.at(-1)).toEqual(none)
    const again = await xr.requestSession('immersive-ar')
    await flush()
    expect(seen.at(-1)).toEqual({ ...none, vr: true })
    again.dispatchEvent(new Event('end'))
    expect(seen.at(-1)).toEqual(none)
  })

  it("keeps the engine's function shape and leaves a page without the APIs alone", () => {
    fakeDevices()
    installDeviceShim(DEVICE_STATE_EVENT)
    const { open } = FakeUsbDevice.prototype as unknown as Openable
    expect(open.name).toBe('open')
    expect(open.length).toBe(0)
    const { connect } = FakeGattServer.prototype as unknown as Gatt
    expect(connect.name).toBe('connect')
    unfakeDevices()
    expect(() => installDeviceShim(DEVICE_STATE_EVENT)).not.toThrow()
  })
})

describe('installCaptureReporter with the device shim', () => {
  it('installs the device shim under its own event name and folds its counts into the one report; pagehide clears them too', () => {
    const sent: CaptureStateReport[] = []
    let deviceEvent: string | null = null
    installCaptureReporter({
      id: 'frame-2',
      send: (message: PageScriptMessage) => {
        if (message.type === 'capture-state' && message.capture) sent.push(message.capture)
      },
      installShim: () => undefined,
      installDeviceShim: (eventName) => {
        deviceEvent = eventName
      }
    })
    expect(deviceEvent).toBe(DEVICE_STATE_EVENT)
    document.dispatchEvent(
      new CustomEvent(DEVICE_STATE_EVENT, { detail: { ...none, usb: true, serial: true } })
    )
    expect(sent.at(-1)).toEqual({ id: 'frame-2', ...clear(), usb: true, serial: true })
    // The capture shim's counts and the device shim's ride together.
    document.dispatchEvent(
      new CustomEvent(CAPTURE_STATE_EVENT, {
        detail: { camera: true, microphone: false, display: false }
      })
    )
    expect(sent.at(-1)).toEqual({
      id: 'frame-2',
      ...clear(),
      camera: true,
      usb: true,
      serial: true
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(sent.at(-1)).toEqual({ id: 'frame-2', ...clear() })
  })

  it('a host without the device shim reports the capture half as before', () => {
    const sent: CaptureStateReport[] = []
    installCaptureReporter({
      id: 'frame-3',
      send: (message: PageScriptMessage) => {
        if (message.type === 'capture-state' && message.capture) sent.push(message.capture)
      },
      installShim: () => undefined
    })
    document.dispatchEvent(
      new CustomEvent(CAPTURE_STATE_EVENT, {
        detail: { camera: false, microphone: true, display: false }
      })
    )
    expect(sent).toEqual([{ id: 'frame-3', ...clear(), microphone: true }])
  })
})
