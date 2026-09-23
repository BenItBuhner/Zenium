import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const { fromFrame } = vi.hoisted(() => ({ fromFrame: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromFrame } }))

import type {
  BluetoothDevice,
  HIDDevice,
  SerialPort,
  Session,
  USBDevice,
  WebContents
} from 'electron'
import type { Browser } from '../../../core/browser'
import { DeviceChooserService } from '../../../core/deviceChooser'
import { PermissionService } from '../../../core/permissions'
import type { PermissionPromptHost, StoreIO } from '../../../core/platform'
import {
  attachBluetoothChooser,
  attachBluetoothChoosers,
  attachDeviceHandlers,
  serialCandidate,
  serialIdentity,
  unknownDeviceName,
  USB_PROTECTED_CLASSES,
  usbCandidate,
  type DeviceHostViews
} from '../devices'
import type { ElectronTabView } from '../views'

function fakeIo(): StoreIO {
  const files = new Map<string, string>()
  return {
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
}

const prompts: PermissionPromptHost = { show: async () => null, cancel: () => undefined }
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Electron's `Session` as the handlers see it: an emitter plus the three handler setters. */
class FakeSession extends EventEmitter {
  devicePermission: ((details: Electron.DevicePermissionHandlerHandlerDetails) => boolean) | null =
    null
  pairing:
    | ((
        details: Electron.BluetoothPairingHandlerHandlerDetails,
        callback: (response: { confirmed: boolean; pin?: string | null }) => void
      ) => void)
    | null = null
  protectedClasses:
    ((details: Electron.USBProtectedClassesHandlerHandlerDetails) => string[]) | null = null
  setDevicePermissionHandler(handler: FakeSession['devicePermission']): void {
    this.devicePermission = handler
  }
  setBluetoothPairingHandler(handler: FakeSession['pairing']): void {
    this.pairing = handler
  }
  setUSBProtectedClassesHandler(handler: FakeSession['protectedClasses']): void {
    this.protectedClasses = handler
  }
}

function fakeWebContents(id: number, url: string): WebContents {
  const wc = new EventEmitter() as unknown as WebContents & { id: number }
  wc.id = id
  wc.getURL = () => url
  return wc
}

const MOUSE: HIDDevice = {
  deviceId: 'hid-1',
  name: 'Gaming Mouse',
  vendorId: 0x046d,
  productId: 0xc52b,
  serialNumber: 'S1',
  collections: []
}
const KEYBOARD: HIDDevice = {
  deviceId: 'hid-2',
  name: '',
  vendorId: 0x04d9,
  productId: 0x0024,
  collections: []
}
const STICK: USBDevice = {
  deviceId: 'usb-1',
  productName: 'Blue Pill',
  manufacturerName: 'STMicroelectronics',
  vendorId: 0x0483,
  productId: 0xdf11,
  serialNumber: 'ABC',
  deviceClass: 0,
  deviceSubclass: 0,
  deviceProtocol: 0,
  deviceVersionMajor: 1,
  deviceVersionMinor: 0,
  deviceVersionSubminor: 0,
  usbVersionMajor: 2,
  usbVersionMinor: 0,
  usbVersionSubminor: 0
} as USBDevice
const PORT: SerialPort = {
  portId: 'port-1',
  portName: '/dev/ttyUSB0',
  displayName: 'FTDI USB Serial',
  vendorId: '1027',
  productId: '24577',
  serialNumber: 'FT1'
}

function fixture(os = 'linux'): {
  permissions: PermissionService
  devices: DeviceChooserService
  ses: FakeSession
  wc: WebContents
  frame: Electron.WebFrameMain
  views: DeviceHostViews & { created: Array<(view: ElectronTabView) => void> }
  browser: Browser
  chooserId(): string
} {
  const permissions = new PermissionService(fakeIo(), prompts, () => 1_000)
  const browser = { permissions, state: { commitVolatile: vi.fn() } } as unknown as Browser
  const devices = new DeviceChooserService(browser, () => 42)
  ;(browser as { devices: DeviceChooserService }).devices = devices
  const ses = new FakeSession()
  const wc = fakeWebContents(7, 'https://app.example/devices')
  const frame = {
    origin: 'https://app.example',
    url: 'https://app.example/devices'
  } as unknown as Electron.WebFrameMain
  fromFrame.mockImplementation((f: unknown) => (f === frame ? wc : null))
  const created: Array<(view: ElectronTabView) => void> = []
  const views = {
    created,
    tabIdForWebContents: (target: WebContents) => (target === wc ? 'tab-1' : undefined),
    onViewCreated: (listener: (view: ElectronTabView) => void) => {
      created.push(listener)
      return () => undefined
    }
  }
  attachDeviceHandlers(browser, views, ses as unknown as Session, os)
  return {
    permissions,
    devices,
    ses,
    wc,
    frame,
    views,
    browser,
    chooserId: () => {
      const chooser = devices.list()[0]
      if (!chooser) throw new Error('no chooser open')
      return chooser.id
    }
  }
}

beforeEach(() => {
  fromFrame.mockReset()
})

describe('attachDeviceHandlers: WebHID', () => {
  it('opens the chooser for the frame’s site, records the pick as a grant and then answers Electron', async () => {
    const f = fixture()
    const event = { preventDefault: vi.fn() }
    const grantsAtAnswer: number[] = []
    const callback = vi.fn(() => grantsAtAnswer.push(f.permissions.deviceGrants().length))
    f.ses.emit(
      'select-hid-device',
      event,
      { deviceList: [MOUSE, KEYBOARD], frame: f.frame },
      callback
    )
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(f.devices.list()).toEqual([
      {
        id: expect.any(String),
        tabId: 'tab-1',
        origin: 'https://app.example',
        kind: 'hid',
        candidates: [
          { id: 'hid-1', name: 'Gaming Mouse', detail: '' },
          { id: 'hid-2', name: 'Unknown device (04d9:0024)', detail: '' }
        ],
        scanning: false,
        hint: 'linux-udev',
        requestedAt: 42
      }
    ])
    expect(callback).not.toHaveBeenCalled()

    f.devices.respond(f.chooserId(), 'hid-1')
    await tick()
    expect(callback).toHaveBeenCalledWith('hid-1')
    expect(grantsAtAnswer).toEqual([1])
    expect(f.permissions.deviceGrants()).toEqual([
      {
        origin: 'https://app.example',
        kind: 'hid',
        deviceId: 'hid-1',
        name: 'Gaming Mouse',
        vendorId: 0x046d,
        productId: 0xc52b,
        serialNumber: 'S1',
        grantedAt: 1_000
      }
    ])
    expect(f.devices.list()).toEqual([])
  })

  it('answers Cancel with an empty callback and grants nothing', async () => {
    const f = fixture('win32')
    const callback = vi.fn()
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [], frame: f.frame },
      callback
    )
    expect(f.devices.list()[0]).toMatchObject({ candidates: [], hint: 'none' })
    f.devices.respond(f.chooserId(), null)
    await tick()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
    expect(f.permissions.deviceGrants()).toEqual([])
  })

  it('keeps the open list live from hid-device-added / -removed, and ignores them once answered', async () => {
    const f = fixture()
    const callback = vi.fn()
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [], frame: f.frame },
      callback
    )
    f.ses.emit('hid-device-added', {}, { device: MOUSE, frame: f.frame })
    f.ses.emit('hid-device-added', {}, { device: KEYBOARD, frame: f.frame })
    expect(f.devices.list()[0].candidates.map((c) => c.id)).toEqual(['hid-1', 'hid-2'])
    f.ses.emit('hid-device-removed', {}, { device: MOUSE, frame: f.frame })
    expect(f.devices.list()[0].candidates.map((c) => c.id)).toEqual(['hid-2'])
    // A device the page never saw, or another page's, changes nothing.
    f.ses.emit('hid-device-removed', {}, { device: MOUSE, frame: f.frame })
    f.ses.emit('hid-device-added', {}, { device: MOUSE, frame: null })
    expect(f.devices.list()[0].candidates.map((c) => c.id)).toEqual(['hid-2'])

    // A device that arrived after the request is picked and granted like any other.
    f.devices.respond(f.chooserId(), 'hid-2')
    await tick()
    expect(callback).toHaveBeenCalledWith('hid-2')
    expect(f.permissions.deviceGrants()[0]).toMatchObject({
      deviceId: 'hid-2',
      name: 'Unknown device (04d9:0024)',
      serialNumber: null
    })
    f.ses.emit('hid-device-added', {}, { device: MOUSE, frame: f.frame })
    expect(f.devices.list()).toEqual([])
  })

  it('refuses a blocked site and a request without a page at once, without a chooser', () => {
    const f = fixture()
    f.permissions.set('hid', 'https://app.example', 'deny')
    const blocked = vi.fn()
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [MOUSE], frame: f.frame },
      blocked
    )
    expect(blocked.mock.calls).toEqual([[]])
    const pageless = vi.fn()
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [MOUSE], frame: null },
      pageless
    )
    expect(pageless.mock.calls).toEqual([[]])
    expect(f.devices.list()).toEqual([])
  })

  it('lets a second request of the same page replace the first, which is answered as cancelled', async () => {
    const f = fixture()
    const first = vi.fn()
    const second = vi.fn()
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [MOUSE], frame: f.frame },
      first
    )
    f.ses.emit(
      'select-hid-device',
      { preventDefault: vi.fn() },
      { deviceList: [KEYBOARD], frame: f.frame },
      second
    )
    await tick()
    expect(first.mock.calls).toEqual([[]])
    expect(f.devices.list()).toHaveLength(1)
    expect(f.devices.list()[0].candidates.map((c) => c.id)).toEqual(['hid-2'])
    f.devices.respond(f.chooserId(), 'hid-2')
    await tick()
    expect(second).toHaveBeenCalledWith('hid-2')
  })

  it('forgets a grant the engine revokes', async () => {
    const f = fixture()
    f.permissions.grantDevice('hid', 'https://app.example', {
      deviceId: 'hid-1',
      name: 'Gaming Mouse',
      vendorId: 0x046d,
      productId: 0xc52b,
      serialNumber: 'S1'
    })
    f.ses.emit(
      'hid-device-revoked',
      {},
      { device: { ...MOUSE, deviceId: 'hid-9' }, origin: 'https://other.example' }
    )
    expect(f.permissions.deviceGrants()).toHaveLength(1)
    // Matched by identity: the engine's id of the day need not be the one granted.
    f.ses.emit(
      'hid-device-revoked',
      {},
      { device: { ...MOUSE, deviceId: 'hid-9' }, origin: 'https://app.example' }
    )
    expect(f.permissions.deviceGrants()).toEqual([])
    await tick()
  })
})

describe('attachDeviceHandlers: WebUSB and Web Serial', () => {
  it('serves USB the same way, with the USB events’ shapes, and states Chrome’s protected classes', async () => {
    const f = fixture()
    const callback = vi.fn()
    f.ses.emit(
      'select-usb-device',
      { preventDefault: vi.fn() },
      { deviceList: [], frame: f.frame },
      callback
    )
    expect(f.devices.list()[0]).toMatchObject({
      kind: 'usb',
      origin: 'https://app.example',
      candidates: []
    })
    f.ses.emit('usb-device-added', {}, STICK, f.wc)
    expect(f.devices.list()[0].candidates).toEqual([{ id: 'usb-1', name: 'Blue Pill', detail: '' }])
    f.ses.emit('usb-device-removed', {}, STICK, f.wc)
    expect(f.devices.list()[0].candidates).toEqual([])
    f.ses.emit('usb-device-added', {}, STICK, f.wc)
    f.devices.respond(f.chooserId(), 'usb-1')
    await tick()
    expect(callback).toHaveBeenCalledWith('usb-1')
    expect(f.permissions.deviceGrants()).toEqual([
      {
        origin: 'https://app.example',
        kind: 'usb',
        deviceId: 'usb-1',
        name: 'Blue Pill',
        vendorId: 0x0483,
        productId: 0xdf11,
        serialNumber: 'ABC',
        grantedAt: 1_000
      }
    ])
    f.ses.emit('usb-device-revoked', {}, { device: STICK, origin: 'https://app.example' })
    expect(f.permissions.deviceGrants()).toEqual([])

    expect(f.ses.protectedClasses).not.toBeNull()
    expect(f.ses.protectedClasses!({ protectedClasses: ['audio', 'video'] })).toEqual([
      ...USB_PROTECTED_CLASSES
    ])
    expect(USB_PROTECTED_CLASSES).toEqual([
      'audio',
      'audio-video',
      'hid',
      'mass-storage',
      'smart-card',
      'video',
      'wireless'
    ])
  })

  it('serves serial ports under the page’s site, answering Cancel with the empty port id', async () => {
    const f = fixture()
    const cancelled = vi.fn()
    f.ses.emit('select-serial-port', { preventDefault: vi.fn() }, [PORT], f.wc, cancelled)
    expect(f.devices.list()[0]).toMatchObject({
      kind: 'serial',
      origin: 'https://app.example',
      tabId: 'tab-1',
      candidates: [{ id: 'port-1', name: 'FTDI USB Serial', detail: '/dev/ttyUSB0' }]
    })
    f.devices.respond(f.chooserId(), null)
    await tick()
    expect(cancelled).toHaveBeenCalledWith('')

    const picked = vi.fn()
    f.ses.emit('select-serial-port', { preventDefault: vi.fn() }, [], f.wc, picked)
    f.ses.emit('serial-port-added', {}, PORT, f.wc)
    expect(f.devices.list()[0].candidates.map((c) => c.id)).toEqual(['port-1'])
    f.ses.emit('serial-port-removed', {}, PORT, f.wc)
    expect(f.devices.list()[0].candidates).toEqual([])
    f.ses.emit('serial-port-added', {}, PORT, f.wc)
    f.devices.respond(f.chooserId(), 'port-1')
    await tick()
    expect(picked).toHaveBeenCalledWith('port-1')
    expect(f.permissions.deviceGrants()).toEqual([
      {
        origin: 'https://app.example',
        kind: 'serial',
        deviceId: 'port-1',
        name: 'FTDI USB Serial',
        vendorId: 1027,
        productId: 24577,
        serialNumber: 'FT1',
        grantedAt: 1_000
      }
    ])
    f.ses.emit('serial-port-revoked', {}, { port: PORT, origin: 'https://app.example' })
    expect(f.permissions.deviceGrants()).toEqual([])
  })

  it('answers Electron’s device permission handler from the grant store, by identity', () => {
    const f = fixture()
    const handler = f.ses.devicePermission!
    expect(handler({ deviceType: 'hid', origin: 'https://app.example', device: MOUSE })).toBe(false)
    f.permissions.grantDevice('hid', 'https://app.example', {
      deviceId: 'hid-old',
      name: 'Gaming Mouse',
      vendorId: 0x046d,
      productId: 0xc52b,
      serialNumber: 'S1'
    })
    expect(handler({ deviceType: 'hid', origin: 'https://app.example', device: MOUSE })).toBe(true)
    expect(handler({ deviceType: 'usb', origin: 'https://app.example', device: MOUSE })).toBe(false)
    expect(handler({ deviceType: 'hid', origin: 'https://other.example', device: MOUSE })).toBe(
      false
    )
    // A site blocked in Settings loses every device it held while blocked.
    f.permissions.set('hid', 'https://app.example', 'deny')
    expect(handler({ deviceType: 'hid', origin: 'https://app.example', device: MOUSE })).toBe(false)
    f.permissions.set('hid', 'https://app.example', null)
    expect(handler({ deviceType: 'hid', origin: 'https://app.example', device: MOUSE })).toBe(true)

    f.permissions.grantDevice('serial', 'https://app.example', serialIdentity(PORT))
    expect(
      handler({
        deviceType: 'serial',
        origin: 'https://app.example',
        device: { ...PORT, portId: 'port-2' }
      })
    ).toBe(true)
    f.permissions.grantDevice('usb', 'https://app.example', {
      deviceId: 'usb-old',
      name: 'Blue Pill',
      vendorId: 0x0483,
      productId: 0xdf11,
      serialNumber: 'ABC'
    })
    expect(handler({ deviceType: 'usb', origin: 'https://app.example', device: STICK })).toBe(true)
  })

  it('carries a Bluetooth pairing prompt to the core and its answer back', async () => {
    const f = fixture()
    const pairing = f.ses.pairing!
    const pin = vi.fn()
    pairing({ deviceId: 'aa:bb', pairingKind: 'providePin', frame: f.frame }, pin)
    expect(f.devices.listPairings()).toEqual([
      {
        id: expect.any(String),
        tabId: 'tab-1',
        deviceId: 'aa:bb',
        deviceName: 'aa:bb',
        kind: 'providePin',
        pin: ''
      }
    ])
    f.devices.respondPairing(f.devices.listPairings()[0].id, { confirmed: true, pin: '0000' })
    await tick()
    expect(pin).toHaveBeenCalledWith({ confirmed: true, pin: '0000' })

    const confirm = vi.fn()
    pairing(
      { deviceId: 'aa:bb', pairingKind: 'confirmPin', frame: f.frame, pin: '123456' },
      confirm
    )
    expect(f.devices.listPairings()[0]).toMatchObject({ kind: 'confirmPin', pin: '123456' })
    f.devices.respondPairing(f.devices.listPairings()[0].id, { confirmed: true })
    await tick()
    expect(confirm).toHaveBeenCalledWith({ confirmed: true })

    const cancelled = vi.fn()
    pairing({ deviceId: 'aa:bb', pairingKind: 'confirm', frame: f.frame }, cancelled)
    f.devices.respondPairing(f.devices.listPairings()[0].id, null)
    await tick()
    expect(cancelled).toHaveBeenCalledWith({ confirmed: false })
  })
})

describe('attachBluetoothChooser', () => {
  const HEART: BluetoothDevice = { deviceId: 'aa:bb', deviceName: 'Heart rate' }
  const SCALE: BluetoothDevice = { deviceId: 'cc:dd', deviceName: '' }

  it('opens on the first device found, grows on the later emissions and answers the latest callback', async () => {
    const f = fixture()
    attachBluetoothChooser(f.browser, f.views, f.wc)
    const first = { preventDefault: vi.fn() }
    const callback1 = vi.fn()
    f.wc.emit('select-bluetooth-device', first, [HEART], callback1)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(f.devices.list()).toEqual([
      {
        id: expect.any(String),
        tabId: 'tab-1',
        origin: 'https://app.example',
        kind: 'bluetooth',
        candidates: [{ id: 'aa:bb', name: 'Heart rate', detail: '' }],
        scanning: true,
        hint: 'none',
        requestedAt: 42
      }
    ])
    const second = { preventDefault: vi.fn() }
    const callback2 = vi.fn()
    f.wc.emit('select-bluetooth-device', second, [HEART, SCALE], callback2)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(f.devices.list()).toHaveLength(1)
    expect(f.devices.list()[0].candidates).toEqual([
      { id: 'aa:bb', name: 'Heart rate', detail: '' },
      { id: 'cc:dd', name: 'cc:dd', detail: '' }
    ])
    f.devices.respond(f.chooserId(), 'cc:dd')
    await tick()
    expect(callback1).not.toHaveBeenCalled()
    expect(callback2).toHaveBeenCalledWith('cc:dd')
    expect(f.permissions.deviceGrants()).toEqual([
      {
        origin: 'https://app.example',
        kind: 'bluetooth',
        deviceId: 'cc:dd',
        name: 'cc:dd',
        vendorId: null,
        productId: null,
        serialNumber: null,
        grantedAt: 1_000
      }
    ])
    // The next request is a new chooser: Electron asks again per requestDevice(), as Chrome does.
    const callback3 = vi.fn()
    f.wc.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [HEART], callback3)
    expect(f.devices.list()).toHaveLength(1)
    f.devices.respond(f.chooserId(), null)
    await tick()
    expect(callback3).toHaveBeenCalledWith('')
  })

  it('refuses a blocked site with the empty id, and closes with the page', async () => {
    const f = fixture()
    attachBluetoothChooser(f.browser, f.views, f.wc)
    f.permissions.set('bluetooth', 'https://app.example', 'deny')
    const blocked = vi.fn()
    f.wc.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [HEART], blocked)
    expect(blocked).toHaveBeenCalledWith('')
    expect(f.devices.list()).toEqual([])

    f.permissions.set('bluetooth', 'https://app.example', null)
    const open = vi.fn()
    f.wc.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [HEART], open)
    expect(f.devices.list()).toHaveLength(1)
    f.wc.emit('destroyed')
    await tick()
    expect(open).toHaveBeenCalledWith('')
    expect(f.devices.list()).toEqual([])
  })

  it('is attached to every tab view the host creates', () => {
    const f = fixture()
    attachBluetoothChoosers(f.browser, f.views)
    expect(f.views.created).toHaveLength(1)
    f.views.created[0]({ webContents: f.wc } as unknown as ElectronTabView)
    f.wc.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [HEART], vi.fn())
    expect(f.devices.list()[0]).toMatchObject({ kind: 'bluetooth', tabId: 'tab-1' })
  })
})

describe('engine structures → the core’s rows', () => {
  it('names a device without one by its ids, as Chrome does', () => {
    expect(unknownDeviceName(0x046d, 0xc52b)).toBe('Unknown device (046d:c52b)')
    expect(unknownDeviceName(null, 1)).toBe('Unknown device')
    expect(usbCandidate({ ...STICK, productName: '' }).name).toBe('STMicroelectronics')
    expect(usbCandidate({ ...STICK, productName: '', manufacturerName: '' }).name).toBe(
      'Unknown device (0483:df11)'
    )
  })

  it('shows a serial port by its display name with the path beside it, and parses its ids', () => {
    expect(serialCandidate(PORT)).toEqual({
      id: 'port-1',
      name: 'FTDI USB Serial',
      detail: '/dev/ttyUSB0'
    })
    expect(serialCandidate({ portId: 'p', portName: 'COM3' })).toEqual({
      id: 'p',
      name: 'COM3',
      detail: ''
    })
    expect(
      serialIdentity({ portId: 'p', portName: 'COM3', vendorId: '0x0403', productId: '6001' })
    ).toEqual({
      deviceId: 'p',
      name: 'COM3',
      vendorId: 0x0403,
      productId: 6001,
      serialNumber: null
    })
    expect(serialIdentity({ portId: 'p', portName: 'COM3', vendorId: 'n/a' })).toMatchObject({
      vendorId: null,
      productId: null
    })
  })
})
