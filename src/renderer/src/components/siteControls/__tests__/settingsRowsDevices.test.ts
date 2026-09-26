import { describe, expect, it, vi } from 'vitest'
import type { DeviceGrant, PermissionRule, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(async () => null),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { allRows, findRow, type RowGroup, type SettingsRow } from '../../pages/settings/model'
import type { SectionContext } from '../../pages/settings/sections'
import { siteSettingsGroups } from '../settingsRows'

/*
 * Settings › Site settings for the sound and device rows (siteControls/settingsRows.tsx;
 * MW-32..35): Sound in the Content group with Allow / Block as its default and the sites with
 * their own answer; the four device kinds in Permissions with Ask / Block, and – since a pick
 * grants one device and never an allow – the sites connected to devices of the kind standing
 * among the kind's exceptions as §10.4 detail rows with the count, each opening the depth-two
 * list of the devices with Revoke (Chrome's word; no confirmation at depth two, §9.24). The
 * phone's catalogue has Sound and no device rows.
 */

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

const GRANTS: DeviceGrant[] = [
  grant({}),
  grant({
    deviceId: 'usb-2',
    name: 'FT232R USB UART',
    vendorId: 0x0403,
    productId: 0x6001,
    grantedAt: 20
  }),
  grant({
    origin: 'https://ports.example',
    kind: 'serial',
    deviceId: 'port-1',
    name: 'USB Serial Port',
    vendorId: null,
    productId: null,
    serialNumber: 'A50285BI',
    grantedAt: 5
  }),
  grant({ origin: 'https://ports.example', deviceId: 'usb-9', name: 'Programmer', grantedAt: 40 })
]

const RULES: PermissionRule[] = [
  { origin: 'https://blocked.example', permission: 'usb', decision: 'deny' },
  { origin: 'https://quiet.example', permission: 'sound', decision: 'deny' }
] as PermissionRule[]

function groups(patch: Partial<UIState> = {}, platform = 'linux'): RowGroup[] {
  const state = {
    platform,
    permissionDefaults: {},
    permissionRules: [],
    deviceGrants: [],
    ...patch
  } as unknown as UIState
  return siteSettingsGroups({ state } as unknown as SectionContext)
}

function row(all: RowGroup[], id: string): SettingsRow {
  const found = findRow(all, id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

function sheetOf(r: SettingsRow): RowGroup[] {
  if (r.kind !== 'item' && r.kind !== 'detail') throw new Error(`${r.id} opens no sheet`)
  return r.sheet.groups
}

describe('Sound (Content)', () => {
  it('is an item row with Allow / Block as its default – Allow the built-in – and the sites that blocked their sound as its exceptions', () => {
    const all = groups({ permissionRules: RULES })
    const content = all.find((g) => g.id === 'sites-content')!
    expect(content.rows.map((r) => r.id)).toContain('sites:sound')
    const sound = row(all, 'sites:sound')
    expect(sound).toMatchObject({
      kind: 'item',
      label: 'Sound',
      description: 'Sites can play sound'
    })
    const value = row(all, 'sites:sound:default')
    if (value.kind !== 'value') throw new Error('not a value row')
    expect(value.value).toBe('allow')
    expect(value.options.map((o) => [o.label, o.description])).toEqual([
      ['Allow', 'Default'],
      ['Block', undefined]
    ])
    value.onChange('deny')
    expect(run).toHaveBeenCalledWith('permissions.setDefault', {
      permission: 'sound',
      decision: 'deny'
    })
    // The site's answer is an item row in the grant rows' shape: Forget trailing, named for the
    // host, running at once with no confirmation (the lead's #418 ruling 5).
    const exception = row(all, 'sites:sound:https://quiet.example:sound')
    expect(exception).toMatchObject({
      kind: 'item',
      label: 'quiet.example',
      description: 'Blocked',
      action: { label: 'Forget' }
    })
    if (exception.kind !== 'item') throw new Error('not an item')
    expect(exception.action?.destructive).toBeUndefined()
    exception.action?.onPress()
    expect(run).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://quiet.example',
      permission: 'sound'
    })
    // The phone opens the item's sheet: one Forget action row, no confirmation there either.
    const [forget] = sheetOf(exception)
    expect(forget.rows).toHaveLength(1)
    expect(forget.rows[0]).toMatchObject({ kind: 'action', button: 'Forget' })
    expect(forget.rows[0]).not.toHaveProperty('confirm')
    // A stored default reads on the row.
    const blocked = groups({ permissionDefaults: { sound: 'deny' } } as Partial<UIState>)
    expect(row(blocked, 'sites:sound').description).toBe('Sites cannot use sound')
  })

  it('is on the phone too, where no device row is (the device APIs are not the phone’s)', () => {
    const all = groups({}, 'android')
    expect(findRow(all, 'sites:sound')).not.toBeNull()
    for (const kind of ['usb', 'serial', 'hid', 'bluetooth'])
      expect(findRow(all, `sites:${kind}`), kind).toBeNull()
  })
})

describe('Background video (Content; MED-08 / EDGE-32)', () => {
  it('is the phone’s row after Sound with Allow / Block – Block the built-in – reading one line on the row and the same line on its sheet', () => {
    const all = groups({}, 'android')
    const content = all.find((g) => g.id === 'sites-content')!
    const ids = content.rows.map((r) => r.id)
    expect(ids.indexOf('sites:background-video')).toBe(ids.indexOf('sites:sound') + 1)
    const video = row(all, 'sites:background-video')
    expect(video).toMatchObject({
      kind: 'item',
      label: 'Background video',
      description: 'Sites cannot play video in the background'
    })
    if (video.kind !== 'item') throw new Error('not an item')
    // The sheet's title block reads the row's own description: one sentence, twice.
    expect(video.sheet.title).toBe('Background video')
    expect(video.sheet.description).toBe('Sites cannot play video in the background')
    const value = row(all, 'sites:background-video:default')
    if (value.kind !== 'value') throw new Error('not a value row')
    expect(value.value).toBe('deny')
    expect(value.options.map((o) => [o.label, o.description])).toEqual([
      ['Allow', undefined],
      ['Block', 'Default']
    ])
    value.onChange('allow')
    expect(run).toHaveBeenCalledWith('permissions.setDefault', {
      permission: 'background-video',
      decision: 'allow'
    })
  })

  it('reads its own Allow line – not the template’s "without asking" – on the row and the sheet once the default is Allow', () => {
    const all = groups(
      { permissionDefaults: { 'background-video': 'allow' } } as Partial<UIState>,
      'android'
    )
    const video = row(all, 'sites:background-video')
    expect(video.description).toBe('Sites can keep playing video in the background')
    if (video.kind !== 'item') throw new Error('not an item')
    expect(video.sheet.description).toBe('Sites can keep playing video in the background')
    const value = row(all, 'sites:background-video:default')
    if (value.kind !== 'value') throw new Error('not a value row')
    expect(value.value).toBe('allow')
  })

  it('is not a desktop row (the hold is the phone’s)', () => {
    expect(findRow(groups(), 'sites:background-video')).toBeNull()
  })
})

describe('the device kinds (Permissions)', () => {
  it('are four item rows in Chrome’s words with Ask / Block as their default', () => {
    const all = groups()
    const permissions = all.find((g) => g.id === 'sites-permissions')!
    const ids = permissions.rows.map((r) => r.id)
    for (const kind of ['usb', 'serial', 'hid', 'bluetooth']) expect(ids).toContain(`sites:${kind}`)
    expect(
      ['usb', 'serial', 'hid', 'bluetooth'].map((kind) => {
        const r = row(all, `sites:${kind}`)
        return [r.kind, r.label, r.description]
      })
    ).toEqual([
      ['item', 'USB devices', 'Sites can ask to connect to USB devices'],
      ['item', 'Serial ports', 'Sites can ask to connect to serial ports'],
      ['item', 'HID devices', 'Sites can ask to connect to HID devices'],
      ['item', 'Bluetooth devices', 'Sites can ask to connect to Bluetooth devices']
    ])
    const value = row(all, 'sites:usb:default')
    if (value.kind !== 'value') throw new Error('not a value row')
    expect(value.value).toBe('ask')
    expect(value.options.map((o) => [o.label, o.description])).toEqual([
      ['Ask', 'Default'],
      ['Block', undefined]
    ])
    value.onChange('deny')
    expect(run).toHaveBeenCalledWith('permissions.setDefault', {
      permission: 'usb',
      decision: 'deny'
    })
    // Nothing granted, nothing blocked: the exceptions are their one-line empty state.
    const [, sites] = sheetOf(row(all, 'sites:usb'))
    expect(sites).toMatchObject({
      heading: 'Sites with their own answer',
      rows: [],
      empty: 'No site has its own answer'
    })
  })

  it('list the sites connected to devices of the kind among the exceptions, alphabetical with the blocks, each a detail row counting its devices', () => {
    const all = groups({ permissionRules: RULES, deviceGrants: GRANTS })
    const [, sites] = sheetOf(row(all, 'sites:usb'))
    expect(sites.rows.map((r) => [r.kind, r.id, r.label])).toEqual([
      ['item', 'sites:usb:https://blocked.example:usb', 'blocked.example'],
      ['detail', 'sites:usb:https://ports.example:devices', 'ports.example'],
      ['detail', 'sites:usb:https://web.flasher.example:devices', 'web.flasher.example']
    ])
    expect(row(all, 'sites:usb:https://ports.example:devices')).toMatchObject({
      kind: 'detail',
      summary: '1 device'
    })
    expect(row(all, 'sites:usb:https://web.flasher.example:devices')).toMatchObject({
      kind: 'detail',
      summary: '2 devices'
    })
    // Each kind reads its own grants: the serial row has ports.example alone, HID nothing.
    const [, serialSites] = sheetOf(row(all, 'sites:serial'))
    expect(serialSites.rows.map((r) => r.id)).toEqual([
      'sites:serial:https://ports.example:devices'
    ])
    const [, hidSites] = sheetOf(row(all, 'sites:hid'))
    expect(hidSites.rows).toEqual([])
    // The blocks are item rows like the grants: Forget trailing, at once, no confirmation.
    const block = row(all, 'sites:usb:https://blocked.example:usb')
    expect(block).toMatchObject({
      kind: 'item',
      description: 'Blocked',
      action: { label: 'Forget' }
    })
  })

  it('a site’s detail row opens the depth-two list of its devices – name, vendor:product or serial under it – each an item row whose one action is Revoke, plain ink, named for its device, no confirmation, running devices.forget', () => {
    const all = groups({ deviceGrants: GRANTS })
    const site = row(all, 'sites:usb:https://web.flasher.example:devices')
    if (site.kind !== 'detail') throw new Error('not a detail row')
    expect(site.sheet.title).toBe('web.flasher.example')
    expect(site.sheet.description).toBe(
      'What this site may connect to. Revoking a device makes the site ask again.'
    )
    const [list] = site.sheet.groups
    expect(list.heading).toBeNull()
    expect(list.empty).toBe('No devices')
    expect(list.rows.map((r) => [r.kind, r.label, r.description])).toEqual([
      ['item', 'Arduino Uno', '2341:0043'],
      ['item', 'FT232R USB UART', '0403:6001']
    ])
    const device = list.rows[0]!
    if (device.kind !== 'item') throw new Error('not an item row')
    // The desktop's trailing 32 button (§10.5): "Revoke", read as "Revoke Arduino Uno"; not the
    // danger ink – a grant is the site's permission, not the user's data (§6, §10.4).
    expect(device.action).toMatchObject({ label: 'Revoke' })
    expect(device.action?.destructive).toBeUndefined()
    expect(device.menu).toBeUndefined()
    device.action?.onPress()
    expect(run).toHaveBeenCalledWith('devices.forget', {
      origin: 'https://web.flasher.example',
      kind: 'usb',
      deviceId: 'usb-1'
    })
    // The phone's form of the same row, its sheet: the one action as a plain row, no confirmation.
    expect(device.sheet.title).toBe('Arduino Uno')
    expect(device.sheet.description).toBe('2341:0043')
    const [actions] = device.sheet.groups
    expect(actions.rows.map((r) => [r.kind, r.label])).toEqual([['action', 'Revoke']])
    const revoke = actions.rows[0]!
    if (revoke.kind !== 'action') throw new Error('not an action')
    expect(revoke.button).toBe('Revoke')
    expect(revoke.destructive).toBeUndefined()
    expect(revoke.confirm).toBeUndefined()
    vi.mocked(run).mockClear()
    revoke.onPress?.()
    expect(run).toHaveBeenCalledWith('devices.forget', {
      origin: 'https://web.flasher.example',
      kind: 'usb',
      deviceId: 'usb-1'
    })
    // A serial port knows no vendor:product: its serial is the line; one without either has none.
    const port = row(all, 'sites:serial:https://ports.example:devices')
    if (port.kind !== 'detail') throw new Error('not a detail row')
    expect(port.sheet.groups[0]!.rows[0]).toMatchObject({
      label: 'USB Serial Port',
      description: 'A50285BI'
    })
    const bare = groups({
      deviceGrants: [grant({ vendorId: null, productId: null, serialNumber: null })]
    })
    const only = row(bare, 'sites:usb:https://web.flasher.example:devices')
    if (only.kind !== 'detail') throw new Error('not a detail row')
    expect(only.sheet.groups[0]!.rows[0]!.description).toBeUndefined()
  })

  it('keeps every id unique through the sheets and the detail sheets inside them', () => {
    const all = groups({ permissionRules: RULES, deviceGrants: GRANTS })
    const ids = allRows(all).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Automatic picture-in-picture (Additional permissions, MW-28)', () => {
  it('is the row after Fullscreen on the desktop and on the phone, whose auto-enter reads it', () => {
    const desktop = groups()
      .find((g) => g.id === 'sites-additional')!
      .rows.map((r) => r.id)
    expect(desktop.indexOf('sites:auto-picture-in-picture')).toBe(
      desktop.indexOf('sites:fullscreen') + 1
    )
    expect(row(groups(), 'sites:auto-picture-in-picture')).toMatchObject({
      kind: 'item',
      label: 'Automatic picture-in-picture',
      description: 'A playing video moves to a small window when you leave its tab'
    })
    const phone = groups({}, 'android')
      .find((g) => g.id === 'sites-additional')!
      .rows.map((r) => r.id)
    expect(phone.indexOf('sites:auto-picture-in-picture')).toBe(
      phone.indexOf('sites:fullscreen') + 1
    )
    expect(row(groups({}, 'android'), 'sites:auto-picture-in-picture')).toMatchObject({
      kind: 'item',
      label: 'Automatic picture-in-picture',
      description: 'A playing video moves to a small window when you leave its tab'
    })
  })

  it('reads a Block default plainly on the phone (no "without asking": the site never asks)', () => {
    const blocked = row(
      groups(
        { permissionDefaults: { 'auto-picture-in-picture': 'deny' } } as Partial<UIState>,
        'android'
      ),
      'sites:auto-picture-in-picture'
    )
    expect(blocked).toMatchObject({
      description: 'Sites cannot use automatic picture-in-picture'
    })
    // The site card's own write for a site lists under the row on the phone as on the desktop.
    const withRule = groups(
      {
        permissionRules: [
          {
            origin: 'https://video.example',
            permission: 'auto-picture-in-picture',
            decision: 'deny'
          }
        ]
      } as Partial<UIState>,
      'android'
    )
    const item = row(withRule, 'sites:auto-picture-in-picture')
    if (item.kind !== 'item') throw new Error('not an item row')
    expect(
      findRow(
        item.sheet.groups,
        'sites:auto-picture-in-picture:https://video.example:auto-picture-in-picture'
      )
    ).toMatchObject({ kind: 'item', label: 'video.example', description: 'Blocked' })
  })
})
