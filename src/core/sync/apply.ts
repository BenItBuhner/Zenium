import type { Boost, Container, Space } from '../../shared/types'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { sanitizePhoneBar } from '../../shared/phoneBar'
import { sanitizeHomepage } from '../../shared/homepage'
import { migrateNewTabSettings, sanitizeNewTabSettings } from '../../shared/newTab'
import { sanitizeSearchEngines } from '../../shared/search'
import { sanitizeFontSettings } from '../../shared/fonts'
import { sanitizeLanguages } from '../../shared/languages'
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
  type ContainerData,
  type FolderData,
  type OrderData,
  type SettingsData,
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
  settings: 5,
  'site-data': 5,
  shortcuts: 6,
  boost: 7,
  credential: 8,
  order: 9
}

/**
 * Apply records that won the merge to the live browser state. Upserts run before deletes of the
 * same type so moved tabs are never closed by a stale tombstone; ordering records go last.
 */
export function applyRemote(browser: Browser, winners: SyncRecord[]): void {
  const { state, tabs } = browser
  const m = state.model
  const sorted = [...winners].sort(
    (a, b) => ORDER[a.type] - ORDER[b.type] || Number(a.deleted) - Number(b.deleted)
  )

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
        const existing = m.spaces.find((s) => s.id === r.id)
        if (existing) {
          existing.name = data.name
          existing.icon = data.icon
          existing.containerId = containerId
          existing.theme = data.theme
          existing.pinnedCollapsed = data.pinnedCollapsed
        } else {
          const space: Space = {
            id: r.id,
            name: data.name,
            icon: data.icon,
            containerId,
            theme: data.theme,
            tabIds: [],
            activeTabId: null,
            pinnedCollapsed: data.pinnedCollapsed
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
        const existing = m.folders[r.id]
        if (existing)
          Object.assign(existing, {
            spaceId: data.spaceId,
            name: data.name,
            icon: data.icon,
            collapsed: data.collapsed,
            color: data.color ?? null
          })
        else
          m.folders[r.id] = {
            id: r.id,
            spaceId: data.spaceId,
            name: data.name,
            icon: data.icon,
            collapsed: data.collapsed,
            ...(data.color ? { color: data.color } : {})
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
      case 'settings': {
        if (r.deleted || r.id !== SETTINGS_RECORD_ID) break
        const data = r.data as Partial<SettingsData> & { newTabPhone?: unknown }
        // A peer on a 0.3.x build still sends the phone's frozen `newTabPhone` key: it is folded
        // into `newTab` and never lands on the settings (else every sync would recreate it).
        const { compactMode, newTabPhone, ...rest } = data
        Object.assign(state.settings, rest)
        if (compactMode)
          Object.assign(state.settings.compactMode, compactMode, { sidebarPersistent: false })
        // Another device's build may know bar items this one does not (or the other way round).
        if ('phoneBar' in rest) state.settings.phoneBar = sanitizePhoneBar(rest.phoneBar)
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
        // model) and only known values apply.
        state.settings.newTab = sanitizeNewTabSettings(
          migrateNewTabSettings({ newTab: state.settings.newTab, newTabPhone })
        )
        // The page fonts and the preferred languages (CT-25, CT-41) are read like a profile's
        // own: in range, canonical, never an empty languages list (a peer's list of nothing
        // valid leaves this device's standing).
        if ('fonts' in rest) state.settings.fonts = sanitizeFontSettings(rest.fonts)
        if ('languages' in rest)
          state.settings.languages = sanitizeLanguages(rest.languages, state.settings.languages)
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

  state.repair()
  state.commit()
}
