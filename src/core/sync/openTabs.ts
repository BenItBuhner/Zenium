import type { SyncDeviceTabs, SyncRemoteTab, Tab } from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { hashData } from './records'

/**
 * The `open-tabs` record (ID-28, "Tabs from other devices"): what a device has open right now,
 * as one document of its own in the folder (`<deviceId>.tabs.zenpage`), rewritten as the tabs
 * change and read by every other device for its per-device list. It is a VIEW of the device, not
 * a merge: nothing here enters another device's spaces (the `openTabs` scope's tab records do
 * that, ID-10); the reader shows the list and opens a tab from it on request.
 *
 * Wire shape (`OpenTabsDocument`, under the folder's key): `{ v: 1, tabs: [{ tabId, url, title,
 * favicon, lastActive, windowId }] }`, most recently active first, `OPEN_TABS_MAX` at most.
 * Private tabs never travel (Chrome's incognito is not in "Tabs from other devices" either),
 * nor the browser's own `zen://` pages; an unloaded tab is still an open tab.
 *
 * The document follows the "Open tabs" toggle both ways: a device with it off publishes no
 * list (its document is removed) and shows none.
 */
export interface OpenTabsDocument {
  v: 1
  tabs: SyncRemoteTab[]
}

/** Tabs a device publishes at most (the most recently active). */
export const OPEN_TABS_MAX = 200
/** How long a device's list stays in the others' view after its last write (its device is gone). */
export const OPEN_TABS_STALE_MS = 30 * 86_400_000

/** Whether a tab is one the device shows to the others. */
export function isPublishedTab(tab: Tab): boolean {
  if (tab.containerId === PRIVATE_CONTAINER_ID) return false
  if (!tab.url || tab.url.startsWith('zen://')) return false
  return /^https?:/i.test(tab.url)
}

/** The device's list in the wire shape. */
export function collectOpenTabs(tabs: Iterable<Tab>): OpenTabsDocument {
  const out: SyncRemoteTab[] = []
  for (const t of tabs) {
    if (!isPublishedTab(t)) continue
    out.push({
      tabId: t.id,
      url: t.url,
      title: t.customTitle || t.title || t.url,
      favicon: t.favicon,
      lastActive: t.lastActiveAt,
      windowId: t.windowId
    })
  }
  out.sort((a, b) => b.lastActive - a.lastActive)
  return { v: 1, tabs: out.slice(0, OPEN_TABS_MAX) }
}

/** A fingerprint of the list, so an unchanged one is not rewritten (and re-encrypted). */
export function openTabsHash(doc: OpenTabsDocument): string {
  return hashData(doc.tabs)
}

/** Read another device's document; null for garbage. Malformed tabs are dropped, not fatal. */
export function readOpenTabs(data: unknown): OpenTabsDocument | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Partial<OpenTabsDocument>
  if (r.v !== 1 || !Array.isArray(r.tabs)) return null
  const tabs: SyncRemoteTab[] = []
  for (const t of r.tabs as Array<Partial<SyncRemoteTab>>) {
    if (!t || typeof t !== 'object') continue
    if (typeof t.url !== 'string' || !/^https?:/i.test(t.url)) continue
    tabs.push({
      tabId: typeof t.tabId === 'string' ? t.tabId : t.url,
      url: t.url,
      title: typeof t.title === 'string' && t.title ? t.title : t.url,
      favicon: typeof t.favicon === 'string' && t.favicon ? t.favicon : null,
      lastActive:
        typeof t.lastActive === 'number' && Number.isFinite(t.lastActive) ? t.lastActive : 0,
      windowId: typeof t.windowId === 'string' ? t.windowId : null
    })
  }
  tabs.sort((a, b) => b.lastActive - a.lastActive)
  return { v: 1, tabs: tabs.slice(0, OPEN_TABS_MAX) }
}

/** The lists the chrome shows: devices with tabs, most recently published first, stale ones out. */
export function sortDeviceTabs(lists: SyncDeviceTabs[], now: number): SyncDeviceTabs[] {
  return lists
    .filter((d) => d.tabs.length > 0 && now - d.updatedAt < OPEN_TABS_STALE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
