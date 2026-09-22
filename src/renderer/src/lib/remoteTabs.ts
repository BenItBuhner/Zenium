import { useEffect } from 'react'
import type { SyncDeviceTabs, SyncStatus } from '@shared/types'
import { cmd } from './api'
import { createStore } from './store'
import { SYNC_COPY } from './syncSetup'

/**
 * The other devices' open tabs (ID-28, "Tabs from other devices"), as `sync.tabsFromDevices`
 * answers them. The list stays out of the browser state – it can run to hundreds of tabs – and
 * `SyncStatus.remoteTabsVersion` moves instead whenever another device's document changed; the
 * Settings › Sync builder reads the list here, and the page asks the core once per version
 * (`useRemoteTabs`), so a render never waits on the folder.
 */
export const remoteTabsStore = createStore<{ version: number; devices: SyncDeviceTabs[] }>(
  { version: -1, devices: [] },
  'remoteTabs'
)

/** Whether the other devices' tabs are wanted at all: sync on, and Open tabs among what it syncs. */
export function remoteTabsWanted(sync: SyncStatus): boolean {
  return sync.enabled && sync.scope.openTabs
}

let asked = -1

/**
 * Keep the store at the status's version: ask the core when the version moved (or the toggle came
 * back on), clear the list when the tabs are not wanted. Called by the Settings pages beside their
 * other page-level state, so the rows built from the store are current on the next render.
 */
export function useRemoteTabs(sync: SyncStatus): void {
  const wanted = remoteTabsWanted(sync)
  const version = sync.remoteTabsVersion
  useEffect(() => {
    if (!wanted) {
      asked = -1
      if (remoteTabsStore.get().devices.length > 0) remoteTabsStore.set({ version, devices: [] })
      return
    }
    if (asked === version) return
    asked = version
    void cmd('sync.tabsFromDevices', undefined).then((devices) => {
      remoteTabsStore.set({ version, devices })
    })
  }, [wanted, version])
  remoteTabsStore.use((s) => s.version)
}

/** How many tabs the list holds across the devices. */
export function remoteTabCount(devices: readonly SyncDeviceTabs[]): number {
  return devices.reduce((n, d) => n + d.tabs.length, 0)
}

/** "12 tabs on 2 devices": the row's one-line summary of the list; the empty sentence for none (§9.17). */
export function remoteTabsSummary(devices: readonly SyncDeviceTabs[]): string {
  const tabs = remoteTabCount(devices)
  if (tabs === 0) return SYNC_COPY.remoteTabsNone
  const withTabs = devices.filter((d) => d.tabs.length > 0).length
  return `${tabs} ${tabs === 1 ? 'tab' : 'tabs'} on ${withTabs} ${withTabs === 1 ? 'device' : 'devices'}`
}
