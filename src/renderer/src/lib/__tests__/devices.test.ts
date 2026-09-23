import { describe, expect, it } from 'vitest'
import type { DeviceChooser, DeviceGrant, DevicePairingPrompt, UIState } from '@shared/types'
import {
  CHOOSER_EMPTY,
  CHOOSER_SCANNING,
  CHOOSER_UDEV_HINT,
  DEVICE_KIND_ORDER,
  DEVICE_KIND_WORDS,
  chooserTabStop,
  chooserTitle,
  currentDeviceChooser,
  currentDevicePairing,
  grantDetail,
  grantsByKind,
  grantsOf,
  grantsRowLabel,
  isCompletePin,
  listMove,
  pairingDescription,
  pairingTitle,
  sanitizePin,
  sitesWithGrants
} from '../devices'

/*
 * The words and the state reads of the device chooser (lib/devices.ts; MW-32..35): Chrome's
 * title in its two parts, the one roving stop of the radio list, the arrow keys' moves, the
 * six-digit PIN, the pairing prompt's three sentences, and the grants read by site and by kind
 * for the site-information rows and Settings › Site settings.
 */

const CHOOSER: DeviceChooser = {
  id: 'ch-1',
  tabId: 't1',
  origin: 'https://web.flasher.example',
  kind: 'usb',
  candidates: [
    { id: 'usb-1', name: 'Arduino Uno', detail: '2341:0043' },
    { id: 'usb-2', name: 'FT232R USB UART', detail: '0403:6001 · A50285BI' }
  ],
  scanning: false,
  hint: 'none',
  requestedAt: 1
}

const PAIRING: DevicePairingPrompt = {
  id: 'pair-1',
  tabId: 't1',
  deviceId: 'bt-1',
  deviceName: 'Heart Rate Monitor',
  kind: 'confirm',
  pin: ''
}

function stateWith(
  choosers: DeviceChooser[],
  pairings: DevicePairingPrompt[] = [],
  activeTabId: string | null = 't1'
): UIState {
  return {
    tabs: {
      t1: { id: 't1', url: 'https://web.flasher.example/' },
      t2: { id: 't2', url: 'https://docs.example/' }
    },
    spaces: [{ id: 'space', activeTabId }],
    activeSpaceId: 'space',
    deviceChoosers: choosers,
    devicePairings: pairings
  } as unknown as UIState
}

function grant(patch: Partial<DeviceGrant>): DeviceGrant {
  return {
    origin: 'https://web.flasher.example',
    kind: 'usb',
    deviceId: 'usb-1',
    name: 'Arduino Uno',
    vendorId: 0x2341,
    productId: 0x0043,
    serialNumber: null,
    grantedAt: 10,
    ...patch
  }
}

describe('the chooser’s words', () => {
  it('titles Chrome’s way, the host apart from the asking so it is never elided, with the kind’s noun', () => {
    expect(chooserTitle(CHOOSER)).toEqual({
      host: 'web.flasher.example',
      asks: 'wants to connect to a USB device'
    })
    expect(chooserTitle({ origin: 'https://ports.example:8443', kind: 'serial' })).toEqual({
      host: 'ports.example:8443',
      asks: 'wants to connect to a serial port'
    })
    expect(chooserTitle({ origin: 'https://x.example', kind: 'hid' }).asks).toBe(
      'wants to connect to a HID device'
    )
    expect(chooserTitle({ origin: 'https://x.example', kind: 'bluetooth' }).asks).toBe(
      'wants to connect to a Bluetooth device'
    )
    // An origin that is not a URL (the engine's fallback) stands as it is.
    expect(chooserTitle({ origin: 'file://', kind: 'usb' }).host).toBe('file://')
  })

  it('names the kinds as Chrome’s Site settings do, in the catalogue’s order', () => {
    expect(DEVICE_KIND_ORDER).toEqual(['usb', 'serial', 'hid', 'bluetooth'])
    expect(DEVICE_KIND_ORDER.map((k) => DEVICE_KIND_WORDS[k].label)).toEqual([
      'USB devices',
      'Serial ports',
      'HID devices',
      'Bluetooth devices'
    ])
  })

  it('has one sentence for each state: scanning, empty, and the Linux udev notice', () => {
    expect(CHOOSER_SCANNING).toBe('Looking for devices…')
    expect(CHOOSER_EMPTY).toBe('No compatible devices found')
    expect(CHOOSER_UDEV_HINT).toBe('On Linux, a udev rule may be needed for this device')
  })
})

describe('the radio list’s keyboard (§9.13, §9.22)', () => {
  it('has one roving stop: the pick while it is listed, else the first row, none on an empty list', () => {
    expect(chooserTabStop(CHOOSER.candidates, null)).toBe('usb-1')
    expect(chooserTabStop(CHOOSER.candidates, 'usb-2')).toBe('usb-2')
    // A pick the host removed from the list is no stop: the list starts over at its first row.
    expect(chooserTabStop(CHOOSER.candidates, 'usb-gone')).toBe('usb-1')
    expect(chooserTabStop([], 'usb-1')).toBeNull()
  })

  it('moves the pick with Down, Up, Home and End, stays at the ends, and answers no other key', () => {
    expect(listMove('ArrowDown', 0, 3)).toBe(1)
    expect(listMove('ArrowUp', 2, 3)).toBe(1)
    expect(listMove('Home', 2, 3)).toBe(0)
    expect(listMove('End', 0, 3)).toBe(2)
    // Off the list's ends nothing moves; a key that lands where the pick is is no move either.
    expect(listMove('ArrowDown', 2, 3)).toBeNull()
    expect(listMove('ArrowUp', 0, 3)).toBeNull()
    expect(listMove('Home', 0, 3)).toBeNull()
    expect(listMove('End', 2, 3)).toBeNull()
    expect(listMove('ArrowRight', 0, 3)).toBeNull()
    expect(listMove('Enter', 0, 3)).toBeNull()
    expect(listMove('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('the pairing prompt’s words and PIN', () => {
  it('titles "Pair with <device>" and says what the OS wants in one sentence per form', () => {
    expect(pairingTitle(PAIRING)).toBe('Pair with Heart Rate Monitor')
    expect(pairingDescription(PAIRING)).toBe('Heart Rate Monitor wants to pair with this computer.')
    expect(pairingDescription({ ...PAIRING, kind: 'confirmPin', pin: '123456' })).toBe(
      'Check that this PIN matches the one shown on Heart Rate Monitor.'
    )
    expect(pairingDescription({ ...PAIRING, kind: 'providePin' })).toBe(
      'Enter the six-digit PIN shown on Heart Rate Monitor.'
    )
  })

  it('takes six digits and nothing else: a keystroke leaves only digits, at most six', () => {
    expect(sanitizePin('12a3-4 5')).toBe('12345')
    expect(sanitizePin('1234567890')).toBe('123456')
    expect(sanitizePin('')).toBe('')
    expect(isCompletePin('123456')).toBe(true)
    expect(isCompletePin('12345')).toBe(false)
    expect(isCompletePin('1234567')).toBe(false)
    expect(isCompletePin('12345a')).toBe(false)
  })
})

describe('the chooser and the pairing prompt this window shows', () => {
  it('shows the active tab’s request only: another tab in front hides it, and a request the host could not place under a tab shows here', () => {
    expect(currentDeviceChooser(stateWith([CHOOSER]))).toBe(CHOOSER)
    expect(currentDeviceChooser(stateWith([CHOOSER], [], 't2'))).toBeNull()
    const placeless = { ...CHOOSER, id: 'ch-2', tabId: null }
    expect(currentDeviceChooser(stateWith([placeless], [], 't2'))).toBe(placeless)
    // The tab's own request comes before a placeless one.
    expect(currentDeviceChooser(stateWith([placeless, CHOOSER]))).toBe(CHOOSER)
    expect(currentDeviceChooser(stateWith([CHOOSER], [], null))).toBeNull()
  })

  it('reads the pairing prompt by the same rule', () => {
    expect(currentDevicePairing(stateWith([], [PAIRING]))).toBe(PAIRING)
    expect(currentDevicePairing(stateWith([], [PAIRING], 't2'))).toBeNull()
    const placeless = { ...PAIRING, id: 'pair-2', tabId: null }
    expect(currentDevicePairing(stateWith([], [placeless], 't2'))).toBe(placeless)
    expect(currentDevicePairing(stateWith([], []))).toBeNull()
  })
})

describe('the grants, by site and by kind', () => {
  const GRANTS: DeviceGrant[] = [
    grant({
      deviceId: 'usb-2',
      name: 'FT232R USB UART',
      grantedAt: 30,
      vendorId: 0x0403,
      productId: 0x6001
    }),
    grant({}),
    grant({
      kind: 'hid',
      deviceId: 'hid-1',
      name: 'Gamepad',
      vendorId: 0x045e,
      productId: 0x028e,
      grantedAt: 20
    }),
    grant({
      origin: 'https://ports.example',
      kind: 'serial',
      deviceId: 'port-1',
      name: 'USB Serial Port (COM3)',
      vendorId: null,
      productId: null,
      serialNumber: 'A50285BI',
      grantedAt: 5
    }),
    grant({ origin: 'https://ports.example', deviceId: 'usb-9', name: 'Programmer', grantedAt: 40 })
  ]

  it('lists one site’s grants of one kind oldest first, and nothing for a kind it has none of', () => {
    expect(grantsOf(GRANTS, 'https://web.flasher.example', 'usb').map((g) => g.deviceId)).toEqual([
      'usb-1',
      'usb-2'
    ])
    expect(grantsOf(GRANTS, 'https://web.flasher.example', 'bluetooth')).toEqual([])
    expect(grantsOf(GRANTS, 'https://nowhere.example', 'usb')).toEqual([])
  })

  it('groups a site’s grants by kind in the catalogue’s order, kinds with none left out', () => {
    expect(
      grantsByKind(GRANTS, 'https://web.flasher.example').map((g) => [g.kind, g.grants.length])
    ).toEqual([
      ['usb', 2],
      ['hid', 1]
    ])
    expect(grantsByKind(GRANTS, 'https://ports.example').map((g) => g.kind)).toEqual([
      'usb',
      'serial'
    ])
    expect(grantsByKind(GRANTS, 'https://nowhere.example')).toEqual([])
  })

  it('lists the sites holding grants of one kind alphabetically by host, each with its count', () => {
    expect(sitesWithGrants(GRANTS, 'usb')).toEqual([
      { origin: 'https://ports.example', count: 1 },
      { origin: 'https://web.flasher.example', count: 2 }
    ])
    expect(sitesWithGrants(GRANTS, 'serial')).toEqual([
      { origin: 'https://ports.example', count: 1 }
    ])
    expect(sitesWithGrants(GRANTS, 'bluetooth')).toEqual([])
  })

  it('describes a grant by its vendor:product as four hex digits each, else its serial, else nothing', () => {
    expect(grantDetail(grant({}))).toBe('2341:0043')
    expect(grantDetail(grant({ vendorId: 0x0403, productId: 0x6001 }))).toBe('0403:6001')
    expect(grantDetail(grant({ vendorId: null, productId: null, serialNumber: 'A50285BI' }))).toBe(
      'A50285BI'
    )
    expect(grantDetail(grant({ vendorId: null, productId: null }))).toBe('')
    // One id without the other is no pair to print: the serial stands in.
    expect(grantDetail(grant({ productId: null, serialNumber: 'S1' }))).toBe('S1')
  })

  it('labels the site-information row "<kind> — N"', () => {
    expect(grantsRowLabel('usb', 2)).toBe('USB devices — 2')
    expect(grantsRowLabel('bluetooth', 1)).toBe('Bluetooth devices — 1')
  })
})
