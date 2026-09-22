import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ChevronRight, Globe } from 'lucide-react'
import type { SyncDeviceTabs, SyncRemoteTab, UIState } from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { cmd } from '@renderer/lib/api'
import { historyAdapter, type ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import {
  RECENT_COPY,
  hiddenDeviceCount,
  hiddenDevicesStore,
  lastActiveLabel,
  remoteTabsSection,
  showHiddenDevices,
  type RecentDevice
} from '@renderer/lib/recentPane'
import { PhoneGroupHeading, PhoneListRow, RowFavicon } from './PhoneList'
import { ClosedTabRow } from './RecentlyClosedSheet'
import { useRowGestures } from './useRowGestures'

/**
 * The overview's Recent pane (matrix TAB-02; Chrome's "Recent tabs" page as a segment of the
 * switcher, `lib/recentPane.ts` for what it lists): two groups of rows on the overview's window
 * backdrop (§9.29: the rows and headings read the window family through the overview's control
 * roles, `.zen-overview-recent` in main.css) – "Recently closed", this device's closed tabs
 * (`session.recentlyClosed`, read again whenever the core says it changed, so a row never names
 * a tab that is back already), and "From your other devices", services' `sync.tabsFromDevices`
 * under one 15/600 heading per device with its name and when it last published, read again as
 * the status' `remoteTabsVersion` moves. A tap on a closed tab restores it, on another device's
 * tab opens its address in a new tab, and the overview leaves on the tab either way
 * (`TabOverview`). A device's heading is held (or tapped) for its menu – Hide device – on the
 * overview's sheet. The groups' empty states are §9.17's group form: one plain 44 row in the
 * heading's gutter, sentence case, and the follow-up (Turn on sync, the sync settings) as the
 * group's next row, an action row that leaves the overview for Settings › Sync.
 */
export function RecentPane({
  state,
  onRestore,
  onOpenUrl,
  onOpenSync,
  onDeviceMenu
}: {
  state: UIState
  /** A recently closed tab picked: it comes back and the overview leaves on it. */
  onRestore: (entry: ClosedEntrySummary) => void
  /** Another device's tab picked: its address opens in a new tab the overview leaves on. */
  onOpenUrl: (url: string) => void
  /** The row to Settings › Sync. */
  onOpenSync: () => void
  /** A device's heading held: its menu. */
  onDeviceMenu: (device: RecentDevice) => void
}): JSX.Element {
  const closed = useRecentlyClosed()
  // The lists are asked for only when they are wanted: sync on, and Open tabs among what it
  // syncs (the section says why otherwise, without a read).
  const lists = useRemoteTabs(
    state.sync.enabled && state.sync.scope.openTabs,
    state.sync.remoteTabsVersion
  )
  const hidden = hiddenDevicesStore.use((s) => s.hidden)
  const section = remoteTabsSection(state.sync, lists, hidden)
  const hiddenCount = hiddenDeviceCount(lists, hidden)
  // "Today" and the times are judged as the pane comes up: it is a glance, not a page left open.
  const [now] = useState(() => Date.now())
  return (
    <div
      className="zen-overview-recent zen-phone-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4"
      data-pane="recent"
      data-testid="overview-recent"
      style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
    >
      <section aria-label={RECENT_COPY.closedHeading}>
        <PhoneGroupHeading>{RECENT_COPY.closedHeading}</PhoneGroupHeading>
        {closed.length === 0 ? (
          <EmptyRow testId="overview-recent-no-closed">{RECENT_COPY.noClosed}</EmptyRow>
        ) : (
          closed.map((entry) => (
            <ClosedTabRow key={entry.id} entry={entry} now={now} onTap={() => onRestore(entry)} />
          ))
        )}
      </section>
      <section aria-label={RECENT_COPY.devicesHeading}>
        <PhoneGroupHeading>{RECENT_COPY.devicesHeading}</PhoneGroupHeading>
        {section.kind === 'sync-off' && (
          <>
            <EmptyRow testId="overview-recent-sync-off">{RECENT_COPY.syncOff}</EmptyRow>
            <ActionRow label={RECENT_COPY.syncOffAction} leaves onPick={onOpenSync} />
          </>
        )}
        {section.kind === 'tabs-off' && (
          <>
            <EmptyRow testId="overview-recent-tabs-off">{RECENT_COPY.tabsOff}</EmptyRow>
            <ActionRow label={RECENT_COPY.tabsOffAction} leaves onPick={onOpenSync} />
          </>
        )}
        {section.kind === 'empty' && (
          <EmptyRow testId="overview-recent-no-devices">{RECENT_COPY.noDevices}</EmptyRow>
        )}
        {section.kind === 'devices' &&
          section.devices.map((device) => (
            <DeviceGroup
              key={device.deviceId}
              device={device}
              now={now}
              onOpen={onOpenUrl}
              onMenu={onDeviceMenu}
            />
          ))}
        {hiddenCount > 0 && (
          <ActionRow
            label={RECENT_COPY.showHidden(hiddenCount)}
            testId="overview-recent-show-hidden"
            onPick={showHiddenDevices}
          />
        )}
      </section>
    </div>
  )
}

/** This device's recently closed tabs, newest first, read again whenever the core says so. */
function useRecentlyClosed(): ClosedEntrySummary[] {
  const [entries, setEntries] = useState<ClosedEntrySummary[]>([])
  useEffect(() => {
    let live = true
    const read = (): void => {
      void historyAdapter
        .recentlyClosed()
        .then((list) => {
          if (live) setEntries(list.filter((entry) => entry.kind === 'tab'))
        })
        .catch(() => undefined)
    }
    read()
    const off = historyAdapter.onRecentlyClosedChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  return entries
}

/**
 * The other devices' open tabs as the engine has them, read while sync is on and again each
 * time the status says another device's list changed (the last list stands while the next is
 * read, so a refresh never blinks the group empty); nothing is read – and nothing shown – while
 * sync is off, so a list from before never shows under the prompt to turn it on.
 */
function useRemoteTabs(enabled: boolean, version: number): SyncDeviceTabs[] {
  const [lists, setLists] = useState<SyncDeviceTabs[]>([])
  useEffect(() => {
    if (!enabled) return
    let live = true
    void cmd('sync.tabsFromDevices', undefined)
      .then((list) => {
        if (live) setLists(list)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [enabled, version])
  return enabled ? lists : []
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
  device: RecentDevice
  now: number
  onOpen: (url: string) => void
  onMenu: (device: RecentDevice) => void
}): JSX.Element {
  const aside = lastActiveLabel(device.updatedAt, now)
  const menu = (): void => onMenu(device)
  const { onKeyDown, ...pointer } = useRowGestures({ onTap: menu, onLongPress: menu })
  return (
    <div data-testid="overview-recent-device" data-device-id={device.deviceId}>
      <h3 className="zen-v2-heading zen-list-heading zen-recent-device">
        <button
          type="button"
          className="zen-recent-device-button"
          aria-haspopup="menu"
          aria-label={`${device.deviceName}, ${aside}`}
          onKeyDown={onKeyDown}
          {...pointer}
        >
          <span className="min-w-0 truncate">{device.deviceName}</span>
          <span className="zen-recent-device-aside shrink-0">{aside}</span>
        </button>
      </h3>
      {device.tabs.map((tab) => (
        <RemoteTabRow key={tab.tabId} tab={tab} onTap={() => onOpen(tab.url)} />
      ))}
    </div>
  )
}

function RemoteTabRow({ tab, onTap }: { tab: SyncRemoteTab; onTap: () => void }): JSX.Element {
  const title = tab.title || displayUrl(tab.url)
  const host = getHost(tab.url).replace(/^www\./, '') || displayUrl(tab.url)
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={tab.favicon}
          fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
        />
      }
      title={title}
      subtitle={host}
      ariaLabel={`${title}, ${host}`}
      onTap={onTap}
    />
  )
}

/**
 * A group with nothing to list (§9.17's group form): one plain row at the gutter, the sentence
 * 15 at 69% left-aligned as a row's label, no centring – a static row, not a target.
 */
function EmptyRow({ children, testId }: { children: ReactNode; testId: string }): JSX.Element {
  return (
    <div className="zen-v2-row zen-recent-empty" data-static data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * The group's follow-up as its next row (§9.17, §10.4's action row): the label, and the 16
 * chevron at 69% only when the row leaves the overview for a page.
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
      className="zen-v2-row zen-phone-row zen-recent-action"
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
