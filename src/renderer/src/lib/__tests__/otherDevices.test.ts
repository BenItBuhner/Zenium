import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncDeviceTabs, SyncRemoteTab } from '@shared/types'
import {
  groupRemoteTabs,
  hiddenDeviceCount,
  hiddenDevicesStore,
  hideDevice,
  lastActiveLabel,
  OTHER_DEVICES_COPY,
  remoteTabsListed,
  remoteTabsSection,
  showHiddenDevices
} from '../otherDevices'

/*
 * The model of the History page's "From your other devices" group and of the tab search's reach
 * into the same tabs (TAB-02): the other devices' tabs grouped by device, the devices by their
 * last publish, the tabs by their last activity, the hidden device held back and counted, the
 * heading's aside, why the group is empty when it is, and the flat list the search looks through.
 */

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)
const MIN = 60_000

function remote(tabId: string, url: string, title: string, lastActive: number): SyncRemoteTab {
  return { tabId, url, title, favicon: null, lastActive, windowId: null }
}

// #302's fixture devices: the desk and the phone.
const desk: SyncDeviceTabs = {
  deviceId: 'desk',
  deviceName: 'Desk (Linux)',
  updatedAt: NOW - 5 * MIN,
  tabs: [
    remote('d1', 'https://a.example/one', 'One', NOW - 40 * MIN),
    remote('d2', 'https://a.example/two', 'Two', NOW - 6 * MIN),
    remote('d3', 'https://a.example/three', 'Three', NOW - 20 * MIN)
  ]
}
const pixel: SyncDeviceTabs = {
  deviceId: 'pixel',
  deviceName: 'Pixel 9',
  updatedAt: NOW - 3 * 60 * MIN,
  tabs: [remote('p1', 'https://news.ycombinator.com/', 'Hacker News', NOW - 4 * 60 * MIN)]
}
const laptop: SyncDeviceTabs = {
  deviceId: 'laptop',
  deviceName: 'Laptop',
  updatedAt: NOW - 1 * MIN,
  tabs: [remote('l1', 'https://github.com/zen/pulls', 'Pull requests', NOW - 2 * MIN)]
}
const idle: SyncDeviceTabs = {
  deviceId: 'idle',
  deviceName: 'Old tablet',
  updatedAt: NOW - 2 * 24 * 60 * MIN,
  tabs: []
}
const none = new Set<string>()
const syncOn = { enabled: true, scope: { openTabs: true } } as const

describe('groupRemoteTabs', () => {
  it('orders the devices by their last publish, newest first, whatever order the engine hands them in', () => {
    expect(groupRemoteTabs([pixel, desk, laptop], none).map((d) => d.deviceName)).toEqual([
      'Laptop',
      'Desk (Linux)',
      'Pixel 9'
    ])
  })

  it("orders a device's tabs by their last activity, newest first", () => {
    const [group] = groupRemoteTabs([desk], none)
    expect(group.tabs.map((t) => t.tabId)).toEqual(['d2', 'd3', 'd1'])
    // The engine's list is not reordered in place.
    expect(desk.tabs.map((t) => t.tabId)).toEqual(['d1', 'd2', 'd3'])
  })

  it('drops a device with no tabs and names one without a name', () => {
    expect(groupRemoteTabs([idle, desk], none).map((d) => d.deviceId)).toEqual(['desk'])
    const [unnamed] = groupRemoteTabs([{ ...laptop, deviceName: '  ' }], none)
    expect(unnamed.deviceName).toBe('Another device')
  })

  it('holds back a hidden device and counts it', () => {
    const hidden = new Set(['desk'])
    expect(groupRemoteTabs([pixel, desk, laptop], hidden).map((d) => d.deviceId)).toEqual([
      'laptop',
      'pixel'
    ])
    expect(hiddenDeviceCount([pixel, desk, laptop], hidden)).toBe(1)
    // A hidden id no device carries, or one whose device has no tabs, is nothing to show.
    expect(hiddenDeviceCount([pixel, laptop], hidden)).toBe(0)
    expect(hiddenDeviceCount([idle], new Set(['idle']))).toBe(0)
  })
})

describe('lastActiveLabel', () => {
  it("reads the sync page's relative words after 'Last active'", () => {
    expect(lastActiveLabel(NOW - 20_000, NOW)).toBe('Last active just now')
    expect(lastActiveLabel(NOW - 5 * MIN, NOW)).toBe('Last active 5 min ago')
    expect(lastActiveLabel(NOW - 3 * 60 * MIN, NOW)).toBe('Last active 3 h ago')
    expect(lastActiveLabel(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('Last active 2 d ago')
  })
})

describe('remoteTabsSection', () => {
  it('is the prompt to turn sync on while it is off, whatever the lists hold', () => {
    expect(remoteTabsSection({ enabled: false, scope: { openTabs: true } }, [desk], none)).toEqual({
      kind: 'sync-off'
    })
  })

  it('names the open-tabs toggle when sync is on without it', () => {
    expect(remoteTabsSection({ enabled: true, scope: { openTabs: false } }, [desk], none)).toEqual({
      kind: 'tabs-off'
    })
  })

  it('steps aside with no device publishing tabs (none: sync on, Open tabs on, nothing to list and no way out)', () => {
    expect(remoteTabsSection(syncOn, [], none)).toEqual({ kind: 'none' })
    expect(remoteTabsSection(syncOn, [idle], none)).toEqual({ kind: 'none' })
    // A hidden id no device carries any more is nothing hidden: still none.
    expect(remoteTabsSection(syncOn, [idle], new Set(['gone']))).toEqual({ kind: 'none' })
  })

  it('stands with every publishing device hidden (the way back is the row that shows them)', () => {
    expect(remoteTabsSection(syncOn, [desk], new Set(['desk']))).toEqual({ kind: 'hidden' })
    expect(remoteTabsSection(syncOn, [desk, pixel, idle], new Set(['desk', 'pixel']))).toEqual({
      kind: 'hidden'
    })
  })

  it('lists the devices otherwise', () => {
    const section = remoteTabsSection(syncOn, [pixel, desk], none)
    expect(section.kind).toBe('devices')
    if (section.kind === 'devices') {
      expect(section.devices.map((d) => d.deviceId)).toEqual(['desk', 'pixel'])
    }
  })
})

describe('remoteTabsListed', () => {
  it("is every listed device's tabs in the group's order, each with its device", () => {
    const listed = remoteTabsListed(remoteTabsSection(syncOn, [pixel, desk], none))
    expect(listed.map((m) => `${m.device.deviceId}:${m.tab.tabId}`)).toEqual([
      'desk:d2',
      'desk:d3',
      'desk:d1',
      'pixel:p1'
    ])
  })

  it('is nothing while the group has no devices to show: sync off, tabs off, none, or all hidden', () => {
    expect(
      remoteTabsListed(
        remoteTabsSection({ enabled: false, scope: { openTabs: true } }, [desk], none)
      )
    ).toEqual([])
    expect(
      remoteTabsListed(
        remoteTabsSection({ enabled: true, scope: { openTabs: false } }, [desk], none)
      )
    ).toEqual([])
    expect(remoteTabsListed(remoteTabsSection(syncOn, [idle], none))).toEqual([])
    expect(remoteTabsListed(remoteTabsSection(syncOn, [desk], new Set(['desk'])))).toEqual([])
  })
})

describe('hiddenDevicesStore', () => {
  beforeEach(() => {
    showHiddenDevices()
  })

  it('hides a device once and shows them all again', () => {
    hideDevice('desk')
    hideDevice('desk')
    hideDevice('pixel')
    expect([...hiddenDevicesStore.get().hidden].sort()).toEqual(['desk', 'pixel'])
    const before = hiddenDevicesStore.get().hidden
    hideDevice('pixel')
    expect(hiddenDevicesStore.get().hidden).toBe(before)
    showHiddenDevices()
    expect(hiddenDevicesStore.get().hidden.size).toBe(0)
  })

  it("the group's words are §10.1's: plain action labels, the sentences without a full stop", () => {
    expect(OTHER_DEVICES_COPY.syncOffAction).toBe('Turn on sync')
    expect(OTHER_DEVICES_COPY.tabsOffAction).toBe('Open sync settings')
    expect(OTHER_DEVICES_COPY.showHidden).toBe('Show hidden devices')
    expect(OTHER_DEVICES_COPY.allHidden).toBe("You've hidden every device")
    for (const sentence of [
      OTHER_DEVICES_COPY.syncOff,
      OTHER_DEVICES_COPY.tabsOff,
      OTHER_DEVICES_COPY.allHidden
    ])
      expect(sentence.endsWith('.')).toBe(false)
  })
})
