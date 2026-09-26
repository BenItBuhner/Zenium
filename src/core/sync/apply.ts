import type { Boost, Container, ReadingListEntry, Settings, Space } from '../../shared/types'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { sanitizePhoneBar } from '../../shared/phoneBar'
import { sanitizeMenuOrder } from '../../shared/menuOrder'
import { sanitizeHomepage } from '../../shared/homepage'
import { migrateNewTabSettings, sanitizeNewTabSettings } from '../../shared/newTab'
import { sanitizeSearchEngines } from '../../shared/search'
import { sanitizeFontSettings } from '../../shared/fonts'
import { sanitizeLanguages } from '../../shared/languages'
import { sanitizeStartupSettings } from '../startup'
import {
  createTabRecord,
  getSpace,
  insertTabIntoSpace,
  removeTabFromLists,
  removeTabFromSplit
} from '../../core/model'
import type { Browser } from '../../core/browser'
import {
  ORDER_CONTAINERS,
  ORDER_ESSENTIALS,
  ORDER_SPACES,
  SETTINGS_RECORD_ID,
  SHORTCUTS_RECORD_ID,
  SITE_DATA_RECORD_ID,
  applyOrder,
  readBookmarkData,
  readCredentialData,
  readFolderAgentMark,
  readReadingListData,
  readSpaceAgentMark,
  withoutDeviceLocalSettings,
  type ContainerData,
  type FolderData,
  type OrderData,
  type ShortcutsData,
  type SpaceData,
  type SyncRecord,
  type TabData
} from './records'

const ORDER: Record<SyncRecord['type'], number> = {
  container: 0,
  space: 1,
  folder: 2,
  tab: 3,
  bookmark: 4,
  'reading-list-entry': 5,
  settings: 6,
  'site-data': 6,
  shortcuts: 7,
  boost: 8,
  credential: 9,
  order: 10
}

/**
 * Apply records that won the merge to the live browser state. Upserts run before deletes of the
 * same type so moved tabs are never closed by a stale tombstone; ordering records go last. The
 * reading list is the one exception, landed once per batch after the loop with its removals
 * first: a tombstone and a live record there are never the same entry (`newestByRecord` keeps
 * one record per id), and an entry a peer removed and saved again under a new id must be gone
 * before the new one meets the URL dedupe, or it could lose the URL to the very entry its
 * tombstone takes away.
 */
export function applyRemote(browser: Browser, winners: SyncRecord[]): void {
  const { state, tabs } = browser
  const m = state.model
  const sorted = [...winners].sort(
    (a, b) => ORDER[a.type] - ORDER[b.type] || Number(a.deleted) - Number(b.deleted)
  )
  const readingListLanded: ReadingListEntry[] = []
  const readingListGone: string[] = []

  for (const r of sorted) {
    switch (r.type) {
      case 'container': {
        if (r.deleted) {
          if (r.id === DEFAULT_CONTAINER_ID) break
          m.containers = m.containers.filter((c) => c.id !== r.id)
          for (const s of m.spaces) if (s.containerId === r.id) s.containerId = DEFAULT_CONTAINER_ID
          for (const t of Object.values(m.tabs))
            if (t.containerId === r.id) t.containerId = DEFAULT_CONTAINER_ID
          break
        }
        const data = r.data as ContainerData
        const existing = m.containers.find((c) => c.id === r.id)
        if (existing)
          Object.assign(existing, { name: data.name, color: data.color, icon: data.icon })
        else
          m.containers.push({
            id: r.id,
            name: data.name,
            color: data.color,
            icon: data.icon
          } as Container)
        break
      }
      case 'space': {
        if (r.deleted) {
          browser.removeSpace(r.id)
          break
        }
        const data = r.data as SpaceData
        const containerId = m.containers.some((c) => c.id === data.containerId)
          ? data.containerId
          : DEFAULT_CONTAINER_ID
        // The agents' mark travels when the record carries one; a record without the field
        // (a peer older than the mark) leaves the local mark as it is.
        const agent = readSpaceAgentMark(data)
        const existing = m.spaces.find((s) => s.id === r.id)
        if (existing) {
          existing.name = data.name
          existing.icon = data.icon
          existing.containerId = containerId
          existing.theme = data.theme
          existing.pinnedCollapsed = data.pinnedCollapsed
          if (agent) existing.agent = agent
        } else {
          const space: Space = {
            id: r.id,
            name: data.name,
            icon: data.icon,
            containerId,
            theme: data.theme,
            tabIds: [],
            activeTabId: null,
            pinnedCollapsed: data.pinnedCollapsed,
            ...(agent ? { agent } : {})
          }
          m.spaces.push(space)
        }
        break
      }
      case 'folder': {
        if (r.deleted) {
          if (m.folders[r.id]) {
            for (const t of Object.values(m.tabs)) if (t.folderId === r.id) t.folderId = null
            delete m.folders[r.id]
            browser.liveFolders.onFolderDeleted(r.id)
          }
          break
        }
        const data = r.data as FolderData
        if (!m.spaces.some((s) => s.id === data.spaceId)) break
        const agent = readFolderAgentMark(data)
        const existing = m.folders[r.id]
        if (existing)
          Object.assign(existing, {
            spaceId: data.spaceId,
            name: data.name,
            icon: data.icon,
            collapsed: data.collapsed,
            color: data.color ?? null,
            ...(agent ? { agent } : {})
          })
        else
          m.folders[r.id] = {
            id: r.id,
            spaceId: data.spaceId,
            name: data.name,
            icon: data.icon,
            collapsed: data.collapsed,
            ...(data.color ? { color: data.color } : {}),
            ...(agent ? { agent } : {})
          }
        break
      }
      case 'tab': {
        if (r.deleted) {
          if (m.tabs[r.id]) tabs.closeTab(r.id, true)
          break
        }
        const data = r.data as TabData
        const space = data.essential ? null : getSpace(m, data.spaceId)
        if (!data.essential && (!space || space.windowId)) break
        const containerId = m.containers.some((c) => c.id === data.containerId)
          ? data.containerId
          : (space?.containerId ?? DEFAULT_CONTAINER_ID)
        let tab = m.tabs[r.id]
        if (!tab) {
          tab = createTabRecord({
            id: r.id,
            spaceId: data.essential ? null : space!.id,
            containerId,
            url: data.url,
            title: data.title,
            favicon: data.favicon,
            pinned: data.pinned,
            essential: data.essential,
            pinnedUrl: data.pinnedUrl,
            customTitle: data.customTitle,
            customIcon: data.customIcon,
            muted: data.muted,
            discarded: true
          })
          m.tabs[tab.id] = tab
          if (tab.essential) m.essentialTabIds.push(tab.id)
          else insertTabIntoSpace(m, space!, tab)
        } else {
          // Never yank a page the user is looking at; unloaded tabs simply pick up the new URL.
          if (tab.discarded && tab.url !== data.url) {
            tab.url = data.url
            tab.title = data.title
          }
          tab.pinnedUrl = data.pinnedUrl
          tab.customTitle = data.customTitle
          tab.customIcon = data.customIcon
          if (tab.muted !== data.muted) tabs.toggleMute(tab.id)
          if (tab.favicon === null && data.favicon) tab.favicon = data.favicon
          const sectionChanged = tab.pinned !== data.pinned || tab.essential !== data.essential
          const spaceChanged = !data.essential && tab.spaceId !== space!.id
          if (sectionChanged || spaceChanged) {
            removeTabFromSplit(m, tab.id)
            removeTabFromLists(m, tab.id)
            tab.pinned = data.pinned
            tab.essential = data.essential
            tab.windowId = null
            if (tab.essential) {
              tab.spaceId = null
              m.essentialTabIds.push(tab.id)
            } else {
              insertTabIntoSpace(m, space!, tab)
            }
          }
        }
        tab.folderId =
          data.folderId && m.folders[data.folderId] && !tab.pinned && !tab.essential
            ? data.folderId
            : null
        break
      }
      case 'bookmark': {
        // Nodes land one by one; `state.repair()` below re-homes orphans and fixes indices once.
        if (r.deleted) {
          browser.bookmarks.removeSynced(r.id)
          break
        }
        const data = readBookmarkData(r.data)
        if (data) browser.bookmarks.applySynced(r.id, data)
        break
      }
      case 'reading-list-entry': {
        // Gathered for one pass over the list after the loop (see above); the record goes
        // through the apply side's sanitiser, which keeps a web address in the model's normal
        // form under the record's id and drops a favicon a peer's build may have sent.
        if (r.deleted) {
          readingListGone.push(r.id)
          break
        }
        const entry = readReadingListData(r.id, r.data)
        if (entry) readingListLanded.push(entry)
        break
      }
      case 'settings': {
        if (r.deleted || r.id !== SETTINGS_RECORD_ID) break
        // The record carries the keys that won, key by key against this device's own times
        // (`winningRemote`; the whole record from a peer or a metadata before per-key merge),
        // and every key it carries lands – a key it lacks says nothing about this device's.
        // A peer on an older build still sends the device-local keys (`DEVICE_LOCAL_SETTINGS`):
        // they are this device's own and never land, whatever the record says.
        const data = withoutDeviceLocalSettings(
          r.data as Partial<Settings> & { newTabPhone?: unknown; restoreSession?: unknown }
        )
        // A peer on a 0.3.x build still sends the phone's frozen `newTabPhone` key: it is folded
        // into `newTab` and never lands on the settings (else every sync would recreate it). The
        // 0.4.x `restoreSession` switch – sent by a peer on a build before `startup`, and by a
        // 0.4.83 one as the mirror beside it (`collectLocal`) – is folded into `startup` the same
        // way and never lands either.
        const { compactMode, newTabPhone, restoreSession, ...rest } = data
        Object.assign(state.settings, rest)
        if (compactMode)
          Object.assign(state.settings.compactMode, compactMode, { sidebarPersistent: false })
        // Another device's build may know bar items this one does not (or the other way round).
        if ('phoneBar' in rest) state.settings.phoneBar = sanitizePhoneBar(rest.phoneBar)
        // A peer's menu order names its build's items; the reading drops what this one lacks. A
        // list is kept as a list, the empty one included – a peer's Reset, carried forward in
        // this device's own records from now on, so a peer that held the old order offline
        // takes the reset when it returns; only a value that is no list deletes the key. A
        // record without the key (a peer that never touched the menu) says nothing about it.
        if ('menuOrder' in rest) {
          const menuOrder = sanitizeMenuOrder(rest.menuOrder)
          if (menuOrder !== undefined) state.settings.menuOrder = menuOrder
          else delete state.settings.menuOrder
        }
        // A peer's homepage is read like a profile's own: a known mode, a web address or none.
        if ('homepage' in rest) state.settings.homepage = sanitizeHomepage(rest.homepage)
        // A peer's engines (added by hand, discovered on its pages) are read like a profile's
        // own: complete entries only, capped, the default among them kept.
        if ('searchEngines' in rest)
          state.settings.searchEngines = sanitizeSearchEngines(
            rest.searchEngines,
            state.settings.searchEngineId
          )
        // Another device may run an older or newer build: its new tab values arrive in whichever
        // shape it writes (the desktop's first `newTab`, the phone's `newTabPhone`, the one
        // model) and only known values apply. The two keys merge as one (`settingsKeyGroup`),
        // so a record that carries either carries what the peer holds of both.
        if ('newTab' in data || 'newTabPhone' in data)
          state.settings.newTab = sanitizeNewTabSettings(
            migrateNewTabSettings({ newTab: state.settings.newTab, newTabPhone })
          )
        // The page fonts and the preferred languages (CT-25, CT-41) are read like a profile's
        // own: in range, canonical, never an empty languages list (a peer's list of nothing
        // valid leaves this device's standing).
        if ('fonts' in rest) state.settings.fonts = sanitizeFontSettings(rest.fonts)
        if ('languages' in rest)
          state.settings.languages = sanitizeLanguages(rest.languages, state.settings.languages)
        // Settings › On startup: a peer's `startup` is read like a profile's own (a mode this
        // build does not know reads as the default's, the list as web addresses, capped); a peer
        // that carries only the old switch – the two keys are one group, so the record carries
        // what the peer holds of both – sets the mode it stands for, on "Continue where you left
        // off", off "Open the New Tab page", over this device's own pages: a two-state switch
        // cannot speak of a list, and a later return to `pages` here finds them.
        if ('startup' in rest) state.settings.startup = sanitizeStartupSettings(rest.startup)
        else if (typeof restoreSession === 'boolean')
          state.settings.startup = {
            mode: restoreSession ? 'continue' : 'newTab',
            pages: state.settings.startup.pages
          }
        break
      }
      case 'site-data': {
        // One document, taken whole like the settings record (the sanitiser reads it).
        if (r.deleted || r.id !== SITE_DATA_RECORD_ID) break
        browser.siteData.applySynced(r.data)
        break
      }
      case 'shortcuts': {
        if (r.deleted || r.id !== SHORTCUTS_RECORD_ID) break
        const data = r.data as ShortcutsData
        state.setShortcutOverrides(data.overrides ?? {})
        break
      }
      case 'boost': {
        const domain = r.id.replace(/^boost:/, '')
        if (r.deleted) browser.boosts.remove(domain)
        else browser.boosts.put({ ...(r.data as Boost), domain })
        break
      }
      case 'credential': {
        // The engine hands credential records over only while the vault is open (a locked one
        // holds them for the next sync); the store keeps the other device's id and timestamps.
        if (r.deleted) {
          browser.passwords.removeSynced(r.id)
          break
        }
        const data = readCredentialData(r.data)
        if (!data) break
        if (data.kind === 'login') {
          const { kind: _kind, ...login } = data
          void _kind
          browser.passwords.applySyncedLogin({
            id: r.id,
            ...login,
            // Absent on the wire (unset, or a device on an older build): unknown here too.
            breached: login.breached ?? null,
            checkedAt: login.checkedAt ?? null,
            leakWarnedAt: login.leakWarnedAt ?? null,
            leakIgnoredAt: login.leakIgnoredAt ?? null
          })
        } else {
          const { kind: _kind, ...passkey } = data
          void _kind
          browser.passwords.applySyncedPasskey({ id: r.id, ...passkey })
        }
        break
      }
      case 'order': {
        if (r.deleted) break
        const data = r.data as OrderData
        if (r.id === ORDER_SPACES) {
          const ids = applyOrder(
            m.spaces.map((s) => s.id),
            data.ids
          )
          m.spaces = ids.map((id) => m.spaces.find((s) => s.id === id)!)
        } else if (r.id === ORDER_CONTAINERS) {
          const [first, ...rest] = m.containers
          const ids = applyOrder(
            rest.map((c) => c.id),
            data.ids
          )
          m.containers = [first, ...ids.map((id) => rest.find((c) => c.id === id)!)]
        } else if (r.id === ORDER_ESSENTIALS) {
          m.essentialTabIds = applyOrder(m.essentialTabIds, data.ids)
        } else if (r.id.startsWith('order:tabs:')) {
          const space = m.spaces.find((s) => s.id === r.id.slice('order:tabs:'.length))
          if (!space) break
          const pinned = space.tabIds.filter((id) => m.tabs[id]?.pinned)
          const regular = space.tabIds.filter((id) => m.tabs[id] && !m.tabs[id].pinned)
          space.tabIds = [...applyOrder(pinned, data.pinned), ...applyOrder(regular, data.regular)]
        }
        break
      }
    }
  }

  // The reading list, once: the peers' removals, then their entries through the URL dedupe and
  // the cap (`ReadingListService.applySynced`; the cap bounds READ entries only, the oldest by
  // `readAt` first – an unread entry is never trimmed). An entry the dedupe or the cap takes out
  // is no edit of this device's – not because of the engine's `applying` guard (the commit
  // below broadcasts a macrotask later, `BrowserState.schedule`, when the guard is already
  // down) but because the engine re-snapshots SYNCHRONOUSLY right after this call (`run()`,
  // `stamp: null`) and tombstones the vanished record at `now`, and because
  // `readReadingListData ∘ readingListEntryData` is idempotent: a landed entry re-collects to
  // the same bytes, so the deferred `onLocalChange` diff finds nothing to stamp.
  if (readingListGone.length) browser.readingList.removeSynced(readingListGone)
  if (readingListLanded.length) browser.readingList.applySynced(readingListLanded)

  state.repair()
  state.commit()
}
