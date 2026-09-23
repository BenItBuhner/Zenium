import {
  webContents as electronWebContents,
  type BluetoothDevice,
  type HIDDevice,
  type SerialPort,
  type Session,
  type USBDevice,
  type WebContents,
  type WebFrameMain
} from 'electron'
import type { Browser } from '../../core/browser'
import type { DeviceChooserHandle } from '../../core/deviceChooser'
import type { DeviceIdentity } from '../../core/permissions'
import type { DeviceCandidate, DeviceChooser, DeviceKind } from '../../shared/types'
import type { ElectronTabViewHost } from './views'

/**
 * Chrome's protected USB interface classes: what WebUSB never hands a page even after a pick
 * (the OS's own drivers own them). Returning the list Electron passes keeps exactly this set;
 * the handler is set so the policy is stated here and not left to a default.
 */
export const USB_PROTECTED_CLASSES = [
  'audio',
  'audio-video',
  'hid',
  'mass-storage',
  'smart-card',
  'video',
  'wireless'
] as const

/** What the host keeps of a chooser the engine is waiting on. */
interface LiveRequest {
  handle: DeviceChooserHandle
  candidates: Map<string, DeviceCandidate>
  /** Bluetooth re-emits with a fresh callback as devices appear; the latest one answers. */
  answer: (deviceId: string | null) => void
  settled: boolean
}

/** The least the host needs of the core to serve a chooser (the whole browser in production). */
export type DeviceHostBrowser = Pick<Browser, 'devices' | 'permissions'>

/** The least the host needs of the view host: which tab a page is. */
export type DeviceHostViews = Pick<ElectronTabViewHost, 'tabIdForWebContents' | 'onViewCreated'>

/**
 * The device choosers of WebUSB, Web Serial and WebHID for one session (Electron's
 * `select-*-device` events; the `*-added` / `*-removed` events keep the open list live), the
 * per-device grants (`setDevicePermissionHandler` reads the core's store, `*-revoked` prunes it)
 * and the protected USB classes.
 *
 * Electron asks the session's permission CHECK handler (`usb`, `serial`, `hid`) before it
 * enumerates at all – `PermissionService.check` answers "may the site open a chooser?" there, so
 * a blocked site is refused without one – and, once a site holds a device, asks this handler
 * whether it still does (`getDevices()`, `open()`). With a handler set Electron keeps no grants
 * of its own, so a pick is recorded here before the engine hears of it.
 */
export function attachDeviceHandlers(
  browser: DeviceHostBrowser,
  views: DeviceHostViews,
  ses: Session,
  os: string = process.platform
): void {
  const hint: DeviceChooser['hint'] = os === 'linux' ? 'linux-udev' : 'none'
  const live = new Map<string, LiveRequest>()
  const key = (kind: DeviceKind, wc: WebContents | null): string => `${kind}|${wc?.id ?? 'none'}`

  const open = (
    kind: DeviceKind,
    wc: WebContents | null,
    frameOrigin: string | null,
    devices: DeviceCandidate[],
    answer: (deviceId: string | null) => void,
    identities: Map<string, DeviceIdentity>
  ): void => {
    const k = key(kind, wc)
    live.get(k)?.handle.close()
    const origin = frameOrigin || wc?.getURL() || ''
    const tabId = wc ? (views.tabIdForWebContents(wc) ?? null) : null
    const handle = browser.devices.open(kind, devices, { origin, tabId, hint })
    if (handle.id === null) {
      answer(null)
      return
    }
    const request: LiveRequest = {
      handle,
      candidates: new Map(devices.map((d) => [d.id, d])),
      answer,
      settled: false
    }
    live.set(k, request)
    void handle.result.then((deviceId) => {
      request.settled = true
      if (live.get(k) === request) live.delete(k)
      if (deviceId !== null) {
        const identity = identities.get(deviceId)
        if (identity) browser.permissions.grantDevice(kind, origin, identity)
      }
      request.answer(deviceId)
    })
  }

  const added = (kind: DeviceKind, wc: WebContents | null, candidate: DeviceCandidate): void => {
    const request = live.get(key(kind, wc))
    if (!request || request.settled) return
    request.candidates.set(candidate.id, candidate)
    request.handle.update([...request.candidates.values()])
  }

  const removed = (kind: DeviceKind, wc: WebContents | null, id: string): void => {
    const request = live.get(key(kind, wc))
    if (!request || request.settled || !request.candidates.delete(id)) return
    request.handle.update([...request.candidates.values()])
  }

  // ---- WebHID ---------------------------------------------------------------------------
  const hidIdentities = new Map<string, DeviceIdentity>()
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault()
    const wc = webContentsOf(details.frame)
    for (const device of details.deviceList) hidIdentities.set(device.deviceId, hidIdentity(device))
    open(
      'hid',
      wc,
      originOf(details.frame),
      details.deviceList.map(hidCandidate),
      (deviceId) => (deviceId === null ? callback() : callback(deviceId)),
      hidIdentities
    )
  })
  ses.on('hid-device-added', (_event, details) => {
    hidIdentities.set(details.device.deviceId, hidIdentity(details.device))
    added('hid', webContentsOf(details.frame), hidCandidate(details.device))
  })
  ses.on('hid-device-removed', (_event, details) => {
    removed('hid', webContentsOf(details.frame), details.device.deviceId)
  })
  ses.on('hid-device-revoked', (_event, details) => {
    if (details.origin)
      browser.permissions.forgetDevice('hid', details.origin, hidIdentity(details.device))
  })

  // ---- WebUSB ---------------------------------------------------------------------------
  const usbIdentities = new Map<string, DeviceIdentity>()
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault()
    const wc = webContentsOf(details.frame)
    for (const device of details.deviceList) usbIdentities.set(device.deviceId, usbIdentity(device))
    open(
      'usb',
      wc,
      originOf(details.frame),
      details.deviceList.map(usbCandidate),
      (deviceId) => (deviceId === null ? callback() : callback(deviceId)),
      usbIdentities
    )
  })
  ses.on('usb-device-added', (_event, device, wc) => {
    usbIdentities.set(device.deviceId, usbIdentity(device))
    added('usb', wc, usbCandidate(device))
  })
  ses.on('usb-device-removed', (_event, device, wc) => {
    removed('usb', wc, device.deviceId)
  })
  ses.on('usb-device-revoked', (_event, details) => {
    if (details.origin)
      browser.permissions.forgetDevice('usb', details.origin, usbIdentity(details.device))
  })
  ses.setUSBProtectedClassesHandler(() => [...USB_PROTECTED_CLASSES])

  // ---- Web Serial -----------------------------------------------------------------------
  const serialIdentities = new Map<string, DeviceIdentity>()
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault()
    for (const port of portList) serialIdentities.set(port.portId, serialIdentity(port))
    open(
      'serial',
      wc,
      null,
      portList.map(serialCandidate),
      (portId) => callback(portId ?? ''),
      serialIdentities
    )
  })
  ses.on('serial-port-added', (_event, port, wc) => {
    serialIdentities.set(port.portId, serialIdentity(port))
    added('serial', wc, serialCandidate(port))
  })
  ses.on('serial-port-removed', (_event, port, wc) => {
    removed('serial', wc, port.portId)
  })
  ses.on('serial-port-revoked', (_event, details) => {
    if (details.origin)
      browser.permissions.forgetDevice('serial', details.origin, serialIdentity(details.port))
  })

  // ---- Grants ---------------------------------------------------------------------------
  ses.setDevicePermissionHandler((details) => {
    const identity =
      details.deviceType === 'hid'
        ? hidIdentity(details.device as HIDDevice)
        : details.deviceType === 'usb'
          ? usbIdentity(details.device as USBDevice)
          : serialIdentity(details.device as SerialPort)
    return browser.permissions.hasDeviceGrant(details.deviceType, details.origin, identity)
  })

  // ---- Bluetooth pairing ----------------------------------------------------------------
  ses.setBluetoothPairingHandler((details, callback) => {
    const wc = webContentsOf(details.frame)
    const tabId = wc ? (views.tabIdForWebContents(wc) ?? null) : null
    void browser.devices
      .pair({ deviceId: details.deviceId, tabId, kind: details.pairingKind, pin: details.pin })
      .then((response) => {
        if (!response) callback({ confirmed: false })
        else if (details.pairingKind === 'providePin')
          callback({ confirmed: response.confirmed, pin: response.pin ?? '' })
        else callback({ confirmed: response.confirmed })
      })
  })
}

/**
 * Web Bluetooth's chooser is a `WebContents` event: Electron emits `select-bluetooth-device`
 * once a device is found and again for every device after it, each time with a callback that
 * answers the same request, and never for an empty list (with the adapter off or nothing in
 * range, the page's request fails by itself). The first emission opens the chooser, the later
 * ones keep its list live, and the latest callback carries the answer. Electron has no
 * permission hook for Bluetooth, so a blocked site is refused here, and a pick is recorded as a
 * grant for the rows (the engine asks again on the next `requestDevice()`, as Chrome does).
 */
export function attachBluetoothChooser(
  browser: DeviceHostBrowser,
  views: DeviceHostViews,
  wc: WebContents
): void {
  let request: LiveRequest | null = null
  const identities = new Map<string, DeviceIdentity>()
  wc.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    const answer = (deviceId: string | null): void => callback(deviceId ?? '')
    for (const device of devices) identities.set(device.deviceId, bluetoothIdentity(device))
    const candidates = devices.map(bluetoothCandidate)
    if (request && !request.settled) {
      request.answer = answer
      for (const c of candidates) request.candidates.set(c.id, c)
      request.handle.update([...request.candidates.values()], true)
      return
    }
    const origin = wc.getURL()
    const tabId = views.tabIdForWebContents(wc) ?? null
    const handle = browser.devices.open('bluetooth', candidates, { origin, tabId, scanning: true })
    if (handle.id === null) {
      answer(null)
      return
    }
    const current: LiveRequest = {
      handle,
      candidates: new Map(candidates.map((c) => [c.id, c])),
      answer,
      settled: false
    }
    request = current
    void handle.result.then((deviceId) => {
      current.settled = true
      if (request === current) request = null
      if (deviceId !== null) {
        const identity = identities.get(deviceId)
        if (identity) browser.permissions.grantDevice('bluetooth', origin, identity)
      }
      current.answer(deviceId)
    })
  })
  wc.once('destroyed', () => request?.handle.close())
}

/** Every tab view gets the Bluetooth chooser; the sessions' handlers cover the other kinds. */
export function attachBluetoothChoosers(browser: DeviceHostBrowser, views: DeviceHostViews): void {
  views.onViewCreated((view) => attachBluetoothChooser(browser, views, view.webContents))
}

// ---- Engine structures → the core's shapes ----------------------------------------------

function webContentsOf(frame: WebFrameMain | null): WebContents | null {
  if (!frame) return null
  try {
    return electronWebContents.fromFrame(frame) ?? null
  } catch {
    return null
  }
}

/** The requesting frame's origin (an embedded frame asks for its own site), where Electron says. */
function originOf(frame: WebFrameMain | null): string | null {
  if (!frame) return null
  try {
    return frame.origin || frame.url || null
  } catch {
    return null
  }
}

/** Chrome's name for a device without one: its ids in hex. */
export function unknownDeviceName(vendorId: number | null, productId: number | null): string {
  if (vendorId === null || productId === null) return 'Unknown device'
  return `Unknown device (${hex4(vendorId)}:${hex4(productId)})`
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

export function hidCandidate(device: HIDDevice): DeviceCandidate {
  return {
    id: device.deviceId,
    name: device.name || unknownDeviceName(device.vendorId, device.productId),
    detail: ''
  }
}

export function hidIdentity(device: HIDDevice): DeviceIdentity {
  return {
    deviceId: device.deviceId,
    name: device.name || unknownDeviceName(device.vendorId, device.productId),
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? null
  }
}

export function usbCandidate(device: USBDevice): DeviceCandidate {
  return {
    id: device.deviceId,
    name:
      device.productName ||
      device.manufacturerName ||
      unknownDeviceName(device.vendorId, device.productId),
    detail: ''
  }
}

export function usbIdentity(device: USBDevice): DeviceIdentity {
  return {
    deviceId: device.deviceId,
    name:
      device.productName ||
      device.manufacturerName ||
      unknownDeviceName(device.vendorId, device.productId),
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? null
  }
}

/** Chrome's serial row: the OS's display name with the port's path beside it. */
export function serialCandidate(port: SerialPort): DeviceCandidate {
  const name = port.displayName || port.portName
  return {
    id: port.portId,
    name,
    detail: port.displayName && port.portName !== port.displayName ? port.portName : ''
  }
}

export function serialIdentity(port: SerialPort): DeviceIdentity {
  return {
    deviceId: port.portId,
    name: port.displayName || port.portName,
    vendorId: serialNumber(port.vendorId),
    productId: serialNumber(port.productId),
    serialNumber: port.serialNumber ?? null
  }
}

/** Electron reports a serial port's USB ids as strings (decimal, or hex from some drivers). */
function serialNumber(text: string | undefined): number | null {
  if (text === undefined || text === '') return null
  const decimal = /^\d+$/.test(text) ? Number(text) : NaN
  if (Number.isFinite(decimal)) return decimal
  const hex = /^(0x)?[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : NaN
  return Number.isFinite(hex) ? hex : null
}

export function bluetoothCandidate(device: BluetoothDevice): DeviceCandidate {
  return { id: device.deviceId, name: device.deviceName || device.deviceId, detail: '' }
}

export function bluetoothIdentity(device: BluetoothDevice): DeviceIdentity {
  return {
    deviceId: device.deviceId,
    name: device.deviceName || device.deviceId,
    vendorId: null,
    productId: null,
    serialNumber: null
  }
}
