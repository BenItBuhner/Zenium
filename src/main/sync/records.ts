import { createHash } from 'node:crypto'
import type {
  Bookmark,
  Boost,
  Container,
  Folder,
  KeyBinding,
  Settings,
  Space,
  SpaceTheme,
  SyncScope,
  Tab
} from '../../shared/types'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import type { Model } from '../browser/model'

/**
 * Sync records: the unit of cross-device replication. Every syncable entity is flattened into
 * a small JSON payload with a stable id; conflicts are resolved last-writer-wins per record,
 * exactly like Firefox Sync's engines.
 */

export type RecordType =
  'space' | 'folder' | 'tab' | 'container' | 'bookmark' | 'settings' | 'shortcuts' | 'boost'

export interface SyncRecord {
  id: string
  type: RecordType
  /** Wall-clock ms of the last change on the device that made it. */
  modified: number
  deleted: boolean
  data: unknown
}

export interface RecordMeta {
  type: RecordType
  hash: string
  modified: number
  deleted: boolean
}

export type MetaMap = Record<string, RecordMeta>

export interface SpaceData {
  name: string
  icon: string
  containerId: string
  theme: SpaceTheme | null
  pinnedCollapsed: boolean
  position: number
}

export interface FolderData {
  spaceId: string
  name: string
  icon: string
  collapsed: boolean
}

export interface TabData {
  url: string
  pinnedUrl: string | null
  title: string
  customTitle: string | null
  customIcon: string | null
  favicon: string | null
  pinned: boolean
  essential: boolean
  spaceId: string | null
  folderId: string | null
  containerId: string
  muted: boolean
  position: number
}

export interface ContainerData {
  name: string
  color: Container['color']
  icon: Container['icon']
  position: number
}

export interface BookmarkData {
  url: string
  title: string
  favicon: string | null
  createdAt: number
}

export type SettingsData = Omit<Settings, 'onboardingDone'>
export interface ShortcutsData {
  overrides: Record<string, KeyBinding | null>
}

export const SETTINGS_RECORD_ID = 'settings'
export const SHORTCUTS_RECORD_ID = 'shortcuts'

export function defaultScope(): SyncScope {
  return {
    spaces: true,
    folders: true,
    pinnedTabs: true,
    essentials: true,
    openTabs: false,
    containers: true,
    bookmarks: true,
    settings: true,
    shortcuts: true,
    boosts: true
  }
}

/** JSON with sorted keys so equal payloads hash equally on every device. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function hashData(data: unknown): string {
  return createHash('sha1').update(stableStringify(data)).digest('hex')
}

export interface LocalSources {
  model: Model
  settings: Settings
  shortcutOverrides: Record<string, KeyBinding | null>
  bookmarks: Bookmark[]
  boosts: Boost[]
}

/** Snapshot of everything in scope as `{ id → { type, data } }`. */
export function collectLocal(
  src: LocalSources,
  scope: SyncScope
): Map<string, { type: RecordType; data: unknown }> {
  const out = new Map<string, { type: RecordType; data: unknown }>()
  const m = src.model
  if (scope.spaces) {
    m.spaces.forEach((s, i) => {
      const data: SpaceData = {
        name: s.name,
        icon: s.icon,
        containerId: s.containerId,
        theme: s.theme,
        pinnedCollapsed: s.pinnedCollapsed,
        position: i
      }
      out.set(s.id, { type: 'space', data })
    })
  }
  if (scope.folders) {
    for (const f of Object.values(m.folders)) {
      if (!m.spaces.some((s) => s.id === f.spaceId)) continue
      const data: FolderData = {
        spaceId: f.spaceId,
        name: f.name,
        icon: f.icon,
        collapsed: f.collapsed
      }
      out.set(f.id, { type: 'folder', data })
    }
  }
  if (scope.pinnedTabs || scope.essentials || scope.openTabs) {
    const position = (t: Tab): number => {
      if (t.essential) return m.essentialTabIds.indexOf(t.id)
      const space = m.spaces.find((s) => s.id === t.spaceId)
      if (!space) return 0
      const list = space.tabIds.filter(
        (id) => m.tabs[id]?.pinned === t.pinned && !m.tabs[id]?.windowId
      )
      return list.indexOf(t.id)
    }
    for (const t of Object.values(m.tabs)) {
      if (t.windowId) continue
      if (t.spaceId && m.localSpaces[t.spaceId]) continue
      if (!t.essential && (!t.spaceId || !m.spaces.some((s) => s.id === t.spaceId))) continue
      const wanted = t.essential ? scope.essentials : t.pinned ? scope.pinnedTabs : scope.openTabs
      if (!wanted) continue
      if (t.url.startsWith('zen://') && !t.pinnedUrl) continue
      const data: TabData = {
        url: t.url.startsWith('zen://') ? (t.pinnedUrl ?? t.url) : t.url,
        pinnedUrl: t.pinnedUrl,
        title: t.title,
        customTitle: t.customTitle,
        customIcon: t.customIcon,
        favicon: t.favicon,
        pinned: t.pinned,
        essential: t.essential,
        spaceId: t.essential ? null : t.spaceId,
        folderId: t.folderId,
        containerId: t.containerId,
        muted: t.muted,
        position: position(t)
      }
      out.set(t.id, { type: 'tab', data })
    }
  }
  if (scope.containers) {
    m.containers.forEach((c, i) => {
      if (c.id === DEFAULT_CONTAINER_ID) return
      const data: ContainerData = { name: c.name, color: c.color, icon: c.icon, position: i }
      out.set(c.id, { type: 'container', data })
    })
  }
  if (scope.bookmarks) {
    for (const b of src.bookmarks) {
      const data: BookmarkData = {
        url: b.url,
        title: b.title,
        favicon: b.favicon,
        createdAt: b.createdAt
      }
      out.set(b.id, { type: 'bookmark', data })
    }
  }
  if (scope.settings) {
    const { onboardingDone: _o, ...rest } = src.settings
    void _o
    const data: SettingsData = {
      ...rest,
      compactMode: { ...rest.compactMode, sidebarPersistent: false }
    }
    out.set(SETTINGS_RECORD_ID, { type: 'settings', data })
  }
  if (scope.shortcuts) {
    const data: ShortcutsData = { overrides: src.shortcutOverrides }
    out.set(SHORTCUTS_RECORD_ID, { type: 'shortcuts', data })
  }
  if (scope.boosts) {
    for (const b of src.boosts) out.set(`boost:${b.domain}`, { type: 'boost', data: b })
  }
  return out
}

export interface DiffResult {
  meta: MetaMap
  records: SyncRecord[]
  changed: boolean
}

/**
 * Compare the current local snapshot with the metadata of the last sync: changed records get a
 * fresh `modified`, vanished records become tombstones, everything else keeps its timestamp.
 */
export function diffLocal(
  previous: MetaMap,
  current: Map<string, { type: RecordType; data: unknown }>,
  now: number,
  tombstoneTtlMs = 30 * 24 * 60 * 60 * 1000
): DiffResult {
  const meta: MetaMap = {}
  const records: SyncRecord[] = []
  let changed = false
  for (const [id, { type, data }] of current) {
    const hash = hashData(data)
    const prev = previous[id]
    const modified = prev && prev.hash === hash && !prev.deleted ? prev.modified : now
    if (!prev || prev.hash !== hash || prev.deleted) changed = true
    meta[id] = { type, hash, modified, deleted: false }
    records.push({ id, type, modified, deleted: false, data })
  }
  for (const [id, prev] of Object.entries(previous)) {
    if (current.has(id)) continue
    if (prev.deleted) {
      if (now - prev.modified > tombstoneTtlMs) continue
      meta[id] = prev
      records.push({ id, type: prev.type, modified: prev.modified, deleted: true, data: null })
      continue
    }
    changed = true
    meta[id] = { type: prev.type, hash: '', modified: now, deleted: true }
    records.push({ id, type: prev.type, modified: now, deleted: true, data: null })
  }
  return { meta, records, changed }
}

/** Newest version of every record across all remote devices. */
export function newestByRecord(remote: SyncRecord[][]): Map<string, SyncRecord> {
  const out = new Map<string, SyncRecord>()
  for (const list of remote) {
    for (const r of list) {
      const cur = out.get(r.id)
      if (!cur || r.modified > cur.modified) out.set(r.id, r)
    }
  }
  return out
}

/**
 * Remote records that beat the local copy (strictly newer). Local wins ties, and unchanged
 * remote records (same hash) are skipped so nothing is re-applied needlessly.
 */
export function winningRemote(local: MetaMap, remote: Map<string, SyncRecord>): SyncRecord[] {
  const winners: SyncRecord[] = []
  for (const r of remote.values()) {
    const mine = local[r.id]
    if (!mine) {
      if (!r.deleted) winners.push(r)
      continue
    }
    if (r.modified <= mine.modified) continue
    if (!r.deleted && !mine.deleted && hashData(r.data) === mine.hash) continue
    if (r.deleted && mine.deleted) continue
    winners.push(r)
  }
  return winners
}

/** Meta entries for records we just applied from remote (so we do not echo them as our edits). */
export function metaFromRemote(records: SyncRecord[]): MetaMap {
  const meta: MetaMap = {}
  for (const r of records)
    meta[r.id] = {
      type: r.type,
      hash: r.deleted ? '' : hashData(r.data),
      modified: r.modified,
      deleted: r.deleted
    }
  return meta
}

/** Order helper: sort ids by the `position` in their payload, unknown positions last. */
export function orderByPosition<T extends { position: number }>(
  ids: string[],
  lookup: (id: string) => T | undefined
): string[] {
  return [...ids].sort((a, b) => {
    const pa = lookup(a)?.position ?? Number.MAX_SAFE_INTEGER
    const pb = lookup(b)?.position ?? Number.MAX_SAFE_INTEGER
    return pa - pb
  })
}

export type { Space, Folder }
