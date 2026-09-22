import type { SyncDeviceTabs, SyncRemoteTab, SyncStatus } from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { createStore } from './store'
import { relativeTime } from './utils'

/*
 * The other devices' open tabs where the phone lists them (matrix TAB-02, the #316 design gate's
 * ruling): the History page's "From your other devices" group (`OtherDevicesGroup`, beside its
 * Recently closed group as the desktop History page lists both, history-07) and the overview's
 * tab search, whose reach takes in the same tabs as rows under a heading (`OverviewSearchReach`).
 * The lists are services' `open-tabs` records (`sync.tabsFromDevices`, the engine of #302),
 * grouped under one heading per device. Pure, so what the group lists can be tested without it:
 * which devices, in what order, with which tabs, what the heading's aside reads, and what the
 * group shows when there is nothing to list and why.
 *
 * The core's model is services' and read-only here: the renderer takes the lists as the engine
 * hands them (`remoteTabsStore`, shared with Settings › Sync's Tabs from other devices, #314)
 * and only groups, orders and holds back what the user hid.
 */

/** One other device's tabs as the group lists them: a 15/600 heading, its tabs as rows. */
export interface RemoteDevice {
  deviceId: string
  deviceName: string
  /** When the device last published its list (epoch ms) – the heading's "Last active …". */
  updatedAt: number
  /** Newest activity first. */
  tabs: SyncRemoteTab[]
}

/** The name a device with none reads under; the engine fills one in, the fixtures may not. */
const UNNAMED_DEVICE = 'Another device'

/**
 * The devices the group lists: the ones with tabs and not hidden, the most recently published
 * first, each device's tabs by their own last activity, newest first – Chrome's order on both
 * counts. The engine already drops the stale and the empty (`sortDeviceTabs`); the group does
 * not rely on it, a seeded or a cached list may carry them.
 */
export function groupRemoteTabs(
  lists: readonly SyncDeviceTabs[],
  hidden: ReadonlySet<string>
): RemoteDevice[] {
  return lists
    .filter((device) => device.tabs.length > 0 && !hidden.has(device.deviceId))
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName.trim() || UNNAMED_DEVICE,
      updatedAt: device.updatedAt,
      tabs: [...device.tabs].sort((a, b) => b.lastActive - a.lastActive)
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * How many of the devices with tabs the list is holding back – whether the "Show hidden devices"
 * row stands, and whether a group with no device to list is `hidden` or `none`. A hidden id no
 * device carries any more counts for nothing: there is nothing to show.
 */
export function hiddenDeviceCount(
  lists: readonly SyncDeviceTabs[],
  hidden: ReadonlySet<string>
): number {
  return lists.filter((device) => device.tabs.length > 0 && hidden.has(device.deviceId)).length
}

/**
 * The heading's aside, "Last active 5 min ago": the device's last publish in the sync page's
 * own relative words (`relativeTime`: "Just now", "5 min ago", "3 h ago", "2 d ago", then the
 * date), so the two surfaces describe a device the same way.
 */
export function lastActiveLabel(updatedAt: number, now: number): string {
  const when = relativeTime(updatedAt, now)
  return `Last active ${when.charAt(0).toLowerCase()}${when.slice(1)}`
}

/**
 * What the "From your other devices" group shows and why there is nothing when there is not
 * (v2 §10.1 as the #326 ruling amended it, the phone carrying the desktop page's answers). Two
 * empty states stand, each with a §10.4 row as the way out: `sync-off` (the sentence and the
 * row to Settings › Sync, where sync is turned on) and `tabs-off` (Open tabs out of what syncs:
 * the sentence and the row to the same page's What you sync, where the switch is). A third the
 * user made – `hidden`, sync on with tabs published and every device hidden – keeps the group
 * too, its way back the row that shows the devices again. `none` – sync on, Open tabs on, and
 * NOTHING published by any device – steps aside as Recently closed does when it is empty: no
 * heading, no sentence, the group absent until a device publishes; a sentence with no way out
 * would be a permanent two lines of nothing for a single-device user.
 */
export type RemoteTabsSection =
  | { kind: 'sync-off' }
  | { kind: 'tabs-off' }
  | { kind: 'none' }
  | { kind: 'hidden' }
  | { kind: 'devices'; devices: RemoteDevice[] }

export function remoteTabsSection(
  sync: { enabled: SyncStatus['enabled']; scope: Pick<SyncStatus['scope'], 'openTabs'> },
  lists: readonly SyncDeviceTabs[],
  hidden: ReadonlySet<string>
): RemoteTabsSection {
  if (!sync.enabled) return { kind: 'sync-off' }
  if (!sync.scope.openTabs) return { kind: 'tabs-off' }
  const devices = groupRemoteTabs(lists, hidden)
  if (devices.length > 0) return { kind: 'devices', devices }
  return { kind: hiddenDeviceCount(lists, hidden) > 0 ? 'hidden' : 'none' }
}

/**
 * The title a remote tab reads under, and the host beneath it – the row's two lines (§10.4):
 * the address stands in for a title the device did not send, and for a host there is none of.
 */
export function remoteTabLines(tab: SyncRemoteTab): { title: string; host: string } {
  const title = tab.title.trim() || displayUrl(tab.url)
  const host = getHost(tab.url).replace(/^www\./, '') || displayUrl(tab.url)
  return { title, host }
}

/** A tab of another device with the device it is on: one row of the tab search's reach. */
export interface RemoteTabMatch {
  device: RemoteDevice
  tab: SyncRemoteTab
}

/**
 * Every listed tab of every listed device in the group's order (the devices by their last
 * publish, each one's tabs by their last activity): what the tab search looks through. Nothing
 * while the group has no devices to show – a search does not reach past a sync that is off.
 */
export function remoteTabsListed(section: RemoteTabsSection): RemoteTabMatch[] {
  if (section.kind !== 'devices') return []
  return section.devices.flatMap((device) => device.tabs.map((tab) => ({ device, tab })))
}

/**
 * The group's words: the headings (§9.27, the desktop History page's names), the empty
 * sentences (v2 §9.17, the group form: one plain row, sentence case, no full stop – the Open
 * tabs sentence is Settings › Sync's, `SYNC_COPY.remoteTabsOff`, without the row description's
 * full stop, so the two surfaces say the same thing; the hidden one is §10.1's), the follow-up
 * rows' labels (§10.1's: Turn on sync, Open sync settings, Show hidden devices – plain action
 * labels, no quoted group name), and the device sheet's one item (Title Case, a menu's, §9.1).
 */
export const OTHER_DEVICES_COPY = {
  closedHeading: 'Recently closed',
  devicesHeading: 'From your other devices',
  syncOff: 'Turn on sync to see tabs from your other devices',
  syncOffAction: 'Turn on sync',
  tabsOff: 'Turn on Open tabs in What you sync to see them',
  tabsOffAction: 'Open sync settings',
  allHidden: "You've hidden every device",
  showHidden: 'Show hidden devices',
  hideDevice: 'Hide Device'
} as const

/*
 * The devices the user hid from the list – the heading's hold, Hide Device – for this run of
 * the chrome: Chrome desktop's "Hide for now" on chrome://history/syncedTabs, back on the next
 * start. The set is the renderer's own (no core state, no setting: the sync model is services'
 * and a device hidden here is not a device unpaired), and the "Show hidden devices" row at the
 * group's end brings them back before then. The search's reach honours it too: a hidden
 * device's tabs are not listed anywhere until the device is shown again.
 */
export const hiddenDevicesStore = createStore<{ hidden: ReadonlySet<string> }>(
  { hidden: new Set() },
  'otherDevices.hidden'
)

export function hideDevice(deviceId: string): void {
  hiddenDevicesStore.set((prev) => {
    if (prev.hidden.has(deviceId)) return {}
    const hidden = new Set(prev.hidden)
    hidden.add(deviceId)
    return { hidden }
  })
}

export function showHiddenDevices(): void {
  hiddenDevicesStore.set((prev) => (prev.hidden.size === 0 ? {} : { hidden: new Set() }))
}
