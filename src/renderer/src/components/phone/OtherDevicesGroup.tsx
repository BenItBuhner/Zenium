import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { ChevronRight, Globe } from 'lucide-react'
import type { SyncRemoteTab, UIState } from '@shared/types'
import {
  OTHER_DEVICES_COPY,
  hiddenDeviceCount,
  hiddenDevicesStore,
  lastActiveLabel,
  remoteTabLines,
  remoteTabsSection,
  showHiddenDevices,
  type RemoteDevice
} from '@renderer/lib/otherDevices'
import { remoteTabsStore, useRemoteTabs } from '@renderer/lib/remoteTabs'
import { PhoneGroupHeading, PhoneListRow, RowFavicon } from './PhoneList'
import { useRowGestures } from './useRowGestures'

/**
 * The History page's "From your other devices" group (matrix TAB-02, history-07; the #316 gate:
 * the other devices' tabs are History's group beside Recently closed, as the desktop History
 * page lists both, and Settings › Sync's row – not a pane of the overview): services'
 * `sync.tabsFromDevices` under one 15/600 heading per device with its name and when it last
 * published (`lib/otherDevices.ts` for what it lists) – the list is the one Settings › Sync reads
 * (`remoteTabsStore`, asked of the core once per `remoteTabsVersion` by `useRemoteTabs`, only
 * while sync is on with Open tabs in its scope) – each tab a §10.4 row: favicon, title on one
 * line, host under it. A tap opens the tab's address in a new tab (or brings the tab to the
 * front when this device already holds it under that id, ID-10) and the page leaves. A device's
 * heading is held (or tapped) for its menu – Hide Device – the page's own sheet. The group's
 * empty states are §9.17's group form: one plain 44 row in the heading's gutter, sentence case,
 * and the follow-up (Turn on sync, the sync settings) as the group's next row, an action row
 * that leaves for Settings › Sync.
 */
export function OtherDevicesGroup({
  state,
  onOpenTab,
  onOpenSync,
  onDeviceMenu
}: {
  state: UIState
  /** Another device's tab picked: it opens here (or comes to the front) and the page leaves on it. */
  onOpenTab: (tab: SyncRemoteTab) => void
  /** The row to Settings › Sync. */
  onOpenSync: () => void
  /** A device's heading held: its menu. */
  onDeviceMenu: (device: RemoteDevice) => void
}): JSX.Element {
  useRemoteTabs(state.sync)
  const lists = remoteTabsStore.use((s) => s.devices)
  const hidden = hiddenDevicesStore.use((s) => s.hidden)
  const section = remoteTabsSection(state.sync, lists, hidden)
  const hiddenCount = hiddenDeviceCount(lists, hidden)
  // "Last active …" is judged as the group comes up, as the page's day groups judge "Today".
  const [now] = useState(() => Date.now())
  return (
    <section aria-label={OTHER_DEVICES_COPY.devicesHeading} data-testid="history-other-devices">
      <PhoneGroupHeading>{OTHER_DEVICES_COPY.devicesHeading}</PhoneGroupHeading>
      {section.kind === 'sync-off' && (
        <>
          <EmptyRow testId="history-devices-sync-off">{OTHER_DEVICES_COPY.syncOff}</EmptyRow>
          <ActionRow label={OTHER_DEVICES_COPY.syncOffAction} leaves onPick={onOpenSync} />
        </>
      )}
      {section.kind === 'tabs-off' && (
        <>
          <EmptyRow testId="history-devices-tabs-off">{OTHER_DEVICES_COPY.tabsOff}</EmptyRow>
          <ActionRow label={OTHER_DEVICES_COPY.tabsOffAction} leaves onPick={onOpenSync} />
        </>
      )}
      {section.kind === 'empty' && (
        <EmptyRow testId="history-devices-none">{OTHER_DEVICES_COPY.noDevices}</EmptyRow>
      )}
      {section.kind === 'devices' &&
        section.devices.map((device) => (
          <DeviceGroup
            key={device.deviceId}
            device={device}
            now={now}
            onOpen={onOpenTab}
            onMenu={onDeviceMenu}
          />
        ))}
      {hiddenCount > 0 && (
        <ActionRow
          label={OTHER_DEVICES_COPY.showHidden(hiddenCount)}
          testId="history-devices-show-hidden"
          onPick={showHiddenDevices}
        />
      )}
    </section>
  )
}

/**
 * One device: its 15/600 heading with the name and, as the heading's aside, when it last
 * published (§10.3) – the heading is the device's one control, a button held or tapped for its
 * menu (`aria-haspopup`, named with both lines for a reader) – and its tabs as rows, favicon,
 * title and host, newest activity first.
 */
function DeviceGroup({
  device,
  now,
  onOpen,
  onMenu
}: {
  device: RemoteDevice
  now: number
  onOpen: (tab: SyncRemoteTab) => void
  onMenu: (device: RemoteDevice) => void
}): JSX.Element {
  const aside = lastActiveLabel(device.updatedAt, now)
  const menu = (): void => onMenu(device)
  const { onKeyDown, ...pointer } = useRowGestures({ onTap: menu, onLongPress: menu })
  return (
    <div data-testid="history-device" data-device-id={device.deviceId}>
      <h3 className="zen-v2-heading zen-list-heading zen-device-heading">
        <button
          type="button"
          className="zen-device-heading-button"
          aria-haspopup="menu"
          aria-label={`${device.deviceName}, ${aside}`}
          onKeyDown={onKeyDown}
          {...pointer}
        >
          <span className="min-w-0 truncate">{device.deviceName}</span>
          <span className="zen-device-heading-aside shrink-0">{aside}</span>
        </button>
      </h3>
      {device.tabs.map((tab) => (
        <RemoteTabRow key={tab.tabId} tab={tab} onTap={() => onOpen(tab)} />
      ))}
    </div>
  )
}

/**
 * A tab of another device as a phone list row: favicon (the globe for none), the title on one
 * line (`remoteTabLines`), the host on the second – `subtitle`, when given, in the host's place
 * (the search's rows name the device after the host).
 */
export function RemoteTabRow({
  tab,
  subtitle,
  onTap
}: {
  tab: SyncRemoteTab
  subtitle?: string
  onTap: () => void
}): JSX.Element {
  const { title, host } = remoteTabLines(tab)
  const second = subtitle ?? host
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={tab.favicon}
          fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
        />
      }
      title={title}
      subtitle={second}
      ariaLabel={`${title}, ${second}`}
      onTap={onTap}
    />
  )
}

/**
 * A group with nothing to list (§9.17's group form): one plain row at the gutter, the sentence
 * 15 at 69% left-aligned as a row's label, no centring – a static row, not a target.
 */
export function EmptyRow({
  children,
  testId
}: {
  children: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="zen-v2-row zen-phone-row zen-list-empty-row" data-static data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * The group's follow-up as its next row (§9.17, §10.4's action row): the label, and the 16
 * chevron at 69% only when the row leaves the page.
 */
function ActionRow({
  label,
  leaves = false,
  testId,
  onPick
}: {
  label: string
  leaves?: boolean
  testId?: string
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-row zen-phone-row zen-list-action-row"
      data-testid={testId}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {leaves && (
        <ChevronRight className="h-4 w-4 shrink-0 opacity-[0.69]" strokeWidth={1.75} aria-hidden />
      )}
    </button>
  )
}
