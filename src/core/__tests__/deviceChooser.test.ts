import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '../browser'
import { DeviceChooserService } from '../deviceChooser'
import { PermissionService } from '../permissions'
import type { PermissionPromptHost, StoreIO } from '../platform'
import type { DeviceCandidate } from '../../shared/types'

function fakeIo(initial: string | null = null): StoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readSync: (name) => files.get(name) ?? initial,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
}

const prompts: PermissionPromptHost = { show: async () => null, cancel: () => undefined }

function fixture(): {
  devices: DeviceChooserService
  permissions: PermissionService
  commits: number
} {
  const io = fakeIo()
  const permissions = new PermissionService(io, prompts, () => 1_000)
  const state = { commitVolatile: vi.fn() }
  const browser = { permissions, state } as unknown as Browser
  const devices = new DeviceChooserService(browser, () => 42)
  return {
    devices,
    permissions,
    get commits() {
      return state.commitVolatile.mock.calls.length
    }
  }
}

const MOUSE: DeviceCandidate = { id: 'hid-1', name: 'Gaming Mouse', detail: '' }
const KEYBOARD: DeviceCandidate = { id: 'hid-2', name: 'Keyboard', detail: '' }
const PAGE = { origin: 'https://app.example/devices', tabId: 'tab-1' }

describe('DeviceChooserService', () => {
  it('opens one chooser per request, under the site, and answers the pick', async () => {
    const f = fixture()
    const handle = f.devices.open('hid', [MOUSE], PAGE)
    expect(handle.id).not.toBeNull()
    expect(f.devices.list()).toEqual([
      {
        id: handle.id,
        tabId: 'tab-1',
        origin: 'https://app.example',
        kind: 'hid',
        candidates: [MOUSE],
        scanning: false,
        hint: 'none',
        requestedAt: 42
      }
    ])
    expect(f.commits).toBe(1)
    f.devices.respond(handle.id!, 'hid-1')
    await expect(handle.result).resolves.toBe('hid-1')
    expect(f.devices.list()).toEqual([])
  })

  it('keeps the list live and refuses a pick that is no longer in it', async () => {
    const f = fixture()
    const handle = f.devices.open('usb', [], { ...PAGE, hint: 'linux-udev' })
    expect(f.devices.list()[0].candidates).toEqual([])
    expect(f.devices.list()[0].hint).toBe('linux-udev')
    handle.update([MOUSE, KEYBOARD, KEYBOARD])
    expect(f.devices.list()[0].candidates).toEqual([MOUSE, KEYBOARD])
    handle.update([KEYBOARD])
    // The mouse went while the user clicked it: nothing happens, the chooser stays.
    f.devices.respond(handle.id!, 'hid-1')
    expect(f.devices.list()).toHaveLength(1)
    f.devices.respond(handle.id!, 'hid-2')
    await expect(handle.result).resolves.toBe('hid-2')
  })

  it('Cancel, a tab that leaves and a withdrawn request all answer null', async () => {
    const f = fixture()
    const cancelled = f.devices.open('serial', [MOUSE], PAGE)
    f.devices.respond(cancelled.id!, null)
    await expect(cancelled.result).resolves.toBeNull()

    const left = f.devices.open('serial', [MOUSE], PAGE)
    const other = f.devices.open('hid', [MOUSE], { ...PAGE, tabId: 'tab-2' })
    f.devices.cancelForTab('tab-1')
    await expect(left.result).resolves.toBeNull()
    expect(f.devices.list().map((c) => c.id)).toEqual([other.id])

    other.close()
    await expect(other.result).resolves.toBeNull()
    expect(f.devices.list()).toEqual([])
    // Answering a chooser that is gone changes nothing.
    f.devices.respond(other.id!, 'hid-1')
    expect(f.devices.list()).toEqual([])
  })

  it('refuses a blocked site and a page without a site without opening anything', async () => {
    const f = fixture()
    f.permissions.set('bluetooth', 'https://app.example', 'deny')
    const blocked = f.devices.open('bluetooth', [MOUSE], PAGE)
    expect(blocked.id).toBeNull()
    await expect(blocked.result).resolves.toBeNull()
    blocked.update([KEYBOARD])
    blocked.close()
    const siteless = f.devices.open('usb', [MOUSE], { origin: 'zen://settings', tabId: 'tab-1' })
    expect(siteless.id).toBeNull()
    await expect(siteless.result).resolves.toBeNull()
    expect(f.devices.list()).toEqual([])
    expect(f.commits).toBe(0)
    // The default blocked in Settings refuses every site the same way.
    f.permissions.chooseDefault('usb', 'deny')
    expect(f.devices.open('usb', [MOUSE], PAGE).id).toBeNull()
    // A site's own `ask` over a blocked default asks again.
    f.permissions.set('usb', 'https://app.example', 'allow')
    expect(f.devices.open('usb', [MOUSE], PAGE).id).not.toBeNull()
  })

  it('marks a Bluetooth chooser as scanning while its list grows', () => {
    const f = fixture()
    const handle = f.devices.open('bluetooth', [], { ...PAGE, scanning: true })
    expect(f.devices.list()[0].scanning).toBe(true)
    handle.update([{ id: 'aa:bb', name: 'Heart rate', detail: '' }], true)
    expect(f.devices.list()[0].candidates).toHaveLength(1)
    handle.update([{ id: 'aa:bb', name: 'Heart rate', detail: '' }], false)
    expect(f.devices.list()[0].scanning).toBe(false)
  })

  it('pairing prompts name the device the chooser knew and answer the OS once', async () => {
    const f = fixture()
    f.devices.open('bluetooth', [{ id: 'aa:bb', name: 'Heart rate', detail: '' }], PAGE)
    const pairing = f.devices.pair({
      deviceId: 'aa:bb',
      tabId: 'tab-1',
      kind: 'confirmPin',
      pin: '123456'
    })
    expect(f.devices.listPairings()).toEqual([
      {
        id: expect.any(String),
        tabId: 'tab-1',
        deviceId: 'aa:bb',
        deviceName: 'Heart rate',
        kind: 'confirmPin',
        pin: '123456'
      }
    ])
    f.devices.respondPairing(f.devices.listPairings()[0].id, { confirmed: true })
    await expect(pairing).resolves.toEqual({ confirmed: true })
    expect(f.devices.listPairings()).toEqual([])

    // A device the chooser never listed is named by a grant, else by its id; a tab that leaves cancels.
    f.permissions.grantDevice('bluetooth', 'https://app.example', {
      deviceId: 'cc:dd',
      name: 'Scale'
    })
    const byGrant = f.devices.pair({ deviceId: 'cc:dd', tabId: 'tab-3', kind: 'confirm' })
    const byId = f.devices.pair({ deviceId: 'ee:ff', tabId: 'tab-3', kind: 'providePin' })
    expect(f.devices.listPairings().map((p) => p.deviceName)).toEqual(['Scale', 'ee:ff'])
    f.devices.cancelForTab('tab-3')
    await expect(byGrant).resolves.toBeNull()
    await expect(byId).resolves.toBeNull()
  })
})

describe('PermissionService: device grants', () => {
  const SITE = 'https://app.example'
  const mouse = {
    deviceId: 'g1',
    name: 'Mouse',
    vendorId: 0x046d,
    productId: 0xc52b,
    serialNumber: 'S1'
  }

  it('answers the engine: may the site open a chooser, and is it connected to this device', () => {
    const p = new PermissionService(fakeIo(), prompts, () => 5)
    // `ask` is the chooser: the status check says yes for every kind, but no device is granted.
    for (const kind of ['usb', 'serial', 'hid', 'bluetooth'] as const) {
      expect(p.check(kind, SITE)).toBe(true)
      expect(p.hasDeviceGrant(kind, SITE, mouse)).toBe(false)
    }
    p.grantDevice('hid', SITE, mouse)
    expect(p.hasDeviceGrant('hid', SITE, mouse)).toBe(true)
    expect(p.hasDeviceGrant('usb', SITE, mouse)).toBe(false)
    expect(p.hasDeviceGrant('hid', 'https://other.example', mouse)).toBe(false)
    expect(p.deviceGrants()).toEqual([{ origin: SITE, kind: 'hid', ...mouse, grantedAt: 5 }])
    // A blocked site is refused the chooser and every device it held.
    p.set('hid', SITE, 'deny')
    expect(p.check('hid', SITE)).toBe(false)
    expect(p.hasDeviceGrant('hid', SITE, mouse)).toBe(false)
    p.set('hid', SITE, null)
    expect(p.hasDeviceGrant('hid', SITE, mouse)).toBe(true)
    // Other permissions keep their "allow only" check.
    expect(p.check('geolocation', SITE)).toBe(false)
  })

  it('finds a device of an earlier session by identity and takes its new id', () => {
    const p = new PermissionService(fakeIo(), prompts, () => 5)
    p.grantDevice('usb', SITE, mouse)
    const replugged = { ...mouse, deviceId: 'g9' }
    expect(p.hasDeviceGrant('usb', SITE, replugged)).toBe(true)
    expect(p.deviceGrants()[0].deviceId).toBe('g9')
    // Without a serial number Chrome cannot recognise the device again, and neither do we.
    p.grantDevice('usb', SITE, { deviceId: 'g2', name: 'Stick', vendorId: 1, productId: 2 })
    expect(
      p.hasDeviceGrant('usb', SITE, { deviceId: 'g3', name: 'Stick', vendorId: 1, productId: 2 })
    ).toBe(false)
    expect(p.hasDeviceGrant('usb', SITE, { deviceId: 'g2', name: 'Stick' })).toBe(true)
    // Granting the same device again keeps one row.
    p.grantDevice('usb', SITE, { ...mouse, deviceId: 'g9' })
    expect(p.deviceGrants().filter((g) => g.serialNumber === 'S1')).toHaveLength(1)
  })

  it('forgets one device, a kind, a site, every site – and tells the listeners', () => {
    const p = new PermissionService(fakeIo(), prompts, () => 5)
    const changes: string[] = []
    p.subscribe((change) => changes.push(`${change.permission}@${change.origin}`))
    p.grantDevice('usb', SITE, mouse)
    p.grantDevice('usb', SITE, { deviceId: 'g2', name: 'Stick' })
    p.grantDevice('hid', SITE, { deviceId: 'g3', name: 'Pad' })
    p.grantDevice('hid', 'https://other.example', { deviceId: 'g4', name: 'Pad' })
    expect(changes).toEqual([
      `usb@${SITE}`,
      `usb@${SITE}`,
      `hid@${SITE}`,
      'hid@https://other.example'
    ])
    changes.length = 0

    p.forgetDevice('usb', SITE, { deviceId: 'g1', name: '' })
    expect(p.deviceGrantsFor(SITE, 'usb').map((g) => g.deviceId)).toEqual(['g2'])
    p.forgetDevice('usb', SITE)
    expect(p.deviceGrantsFor(SITE, 'usb')).toEqual([])
    expect(p.deviceGrantsFor(SITE).map((g) => g.deviceId)).toEqual(['g3'])
    p.forgetDevice('usb', SITE)
    expect(changes).toEqual([`usb@${SITE}`, `usb@${SITE}`])
    changes.length = 0

    p.resetOrigin(SITE)
    expect(p.deviceGrantsFor(SITE)).toEqual([])
    expect(p.deviceGrants().map((g) => g.origin)).toEqual(['https://other.example'])
    expect(changes).toEqual([`hid@${SITE}`])
    changes.length = 0

    p.set('hid', 'https://other.example', 'deny')
    changes.length = 0
    p.resetOrigin('https://other.example', 'hid')
    expect(p.deviceGrants()).toEqual([])
    // One notice for the row, not one per decision and per grant.
    expect(changes).toEqual(['hid@https://other.example'])

    p.grantDevice('serial', SITE, { deviceId: 'p1', name: 'ttyUSB0' })
    p.resetSites()
    expect(p.deviceGrants()).toEqual([])
    p.grantDevice('serial', SITE, { deviceId: 'p1', name: 'ttyUSB0' })
    p.reset()
    expect(p.deviceGrants()).toEqual([])
  })

  it('persists the grants beside the decisions and reads them back, malformed rows dropped', async () => {
    const io = fakeIo()
    const p = new PermissionService(io, prompts, () => 5)
    p.set('hid', 'https://other.example', 'deny')
    p.grantDevice('hid', SITE, mouse)
    await (p as unknown as { store: { flush(): Promise<void> } }).store.flush()
    const file = JSON.parse(io.files.get('permissions.json') ?? '{}')
    expect(file).toEqual({
      version: 1,
      decisions: { 'https://other.example|hid': 'deny' },
      devices: [{ origin: SITE, kind: 'hid', ...mouse, grantedAt: 5 }]
    })
    file.devices.push({ origin: SITE, kind: 'toaster', deviceId: 'x', name: 'x' }, 'junk', {
      origin: SITE,
      kind: 'usb',
      deviceId: 'g7',
      name: 'Old',
      vendorId: '1'
    })
    const again = new PermissionService(fakeIo(JSON.stringify(file)), prompts, () => 5)
    expect(again.deviceGrants()).toEqual([
      { origin: SITE, kind: 'hid', ...mouse, grantedAt: 5 },
      {
        origin: SITE,
        kind: 'usb',
        deviceId: 'g7',
        name: 'Old',
        vendorId: null,
        productId: null,
        serialNumber: null,
        grantedAt: 0
      }
    ])
    // A file without grants keeps its old shape when written.
    again.forgetDevice('hid', SITE)
    again.forgetDevice('usb', SITE)
    const io2 = fakeIo()
    const empty = new PermissionService(io2, prompts, () => 5)
    empty.set('ads', SITE, 'allow')
    await (empty as unknown as { store: { flush(): Promise<void> } }).store.flush()
    expect(JSON.parse(io2.files.get('permissions.json') ?? '{}')).toEqual({
      version: 1,
      decisions: { [`${SITE}|ads`]: 'allow' }
    })
  })
})
