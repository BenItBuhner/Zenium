import type {
  BookmarkNode,
  BookmarkNodeType,
  Boost,
  Container,
  Credential,
  Folder,
  FolderColor,
  KeyBinding,
  PasskeyEntry,
  Settings,
  Space,
  SpaceTheme,
  SyncScope,
  Tab
} from '../../shared/types'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { OTHER_BOOKMARKS_ID, isBookmarkRoot } from '../../shared/bookmarks'
import type { Model } from '../model'
import type { SiteDataPolicy } from '../../shared/siteData'
import { sha1Hex } from './sha1'

/**
 * Sync records: the unit of cross-device replication. Every syncable entity is flattened into
 * a small JSON payload with a stable id; conflicts are resolved last-writer-wins per record,
 * exactly like Firefox Sync's engines.
 */

export type RecordType =
  | 'space'
  | 'folder'
  | 'tab'
  | 'container'
  | 'bookmark'
  | 'settings'
  | 'shortcuts'
  | 'boost'
  /** Ordering of spaces / containers / essentials / a space's tabs, separate from their content. */
  | 'order'
  /** One entry of the credential store: a saved login, or a passkey's public record (ID-09). */
  | 'credential'
  /**
   * The per-site cookie and site-data policy (`SiteDataPolicy`, one record of the settings
   * scope, PS-23): a peer on a build without it ignores the record, as `inScope` says nothing
   * for a type it does not know, and neither tombstones nor applies it.
   */
  | 'site-data'

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
}

/** `order:spaces`, `order:containers`, `order:essentials` → `{ ids }`; `order:tabs:<spaceId>` → sections. */
export interface OrderData {
  ids?: string[]
  pinned?: string[]
  regular?: string[]
}

export const ORDER_SPACES = 'order:spaces'
export const ORDER_CONTAINERS = 'order:containers'
export const ORDER_ESSENTIALS = 'order:essentials'
export const orderTabsId = (spaceId: string): string => `order:tabs:${spaceId}`

export interface FolderData {
  spaceId: string
  name: string
  icon: string
  collapsed: boolean
  /** Absent for folders without a group colour, so their records hash as they always did. */
  color?: FolderColor
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
}

export interface ContainerData {
  name: string
  color: Container['color']
  icon: Container['icon']
}

/**
 * One bookmark tree node (roots are fixed on every device and never replicate). Position is part
 * of the record: a move is a change of `parentId` / `index`, resolved last-writer-wins per node;
 * the receiving tree repairs index collisions and orphans (`normalizeBookmarkNodes`).
 */
export interface BookmarkData {
  parentId: string
  index: number
  type: BookmarkNodeType
  title: string
  url?: string
  favicon?: string
  dateAdded: number
}

/** Pre-tree devices (state.json v1–v2) sent flat bookmarks. */
interface LegacyBookmarkData {
  url: string
  title: string
  favicon: string | null
  createdAt: number
}

/**
 * Read a bookmark record from any device generation: tree records as they are, flat legacy
 * records as bookmarks appended to "Other bookmarks". Null for garbage.
 */
export function readBookmarkData(data: unknown): BookmarkData | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Partial<BookmarkData & LegacyBookmarkData>
  if (typeof r.parentId === 'string' && (r.type === 'url' || r.type === 'folder')) {
    if (r.type === 'url' && typeof r.url !== 'string') return null
    const out: BookmarkData = {
      parentId: r.parentId,
      index:
        typeof r.index === 'number' && Number.isFinite(r.index) ? r.index : Number.MAX_SAFE_INTEGER,
      type: r.type,
      title: typeof r.title === 'string' ? r.title : (r.url ?? ''),
      dateAdded: typeof r.dateAdded === 'number' ? r.dateAdded : Date.now()
    }
    if (r.type === 'url') {
      out.url = r.url
      if (typeof r.favicon === 'string' && r.favicon) out.favicon = r.favicon
    }
    return out
  }
  if (typeof r.url === 'string' && r.url) {
    const out: BookmarkData = {
      parentId: OTHER_BOOKMARKS_ID,
      index: Number.MAX_SAFE_INTEGER,
      type: 'url',
      title: typeof r.title === 'string' && r.title ? r.title : r.url,
      url: r.url,
      dateAdded: typeof r.createdAt === 'number' ? r.createdAt : Date.now()
    }
    if (typeof r.favicon === 'string' && r.favicon) out.favicon = r.favicon
    return out
  }
  return null
}

/**
 * The whole `Settings` object but the one-time flag. The new tab page's device-local sets
 * (`BrowserState.newTabDevice`: this device's shortcuts and removed hosts) are not settings and
 * never travel; a peer on an older build may add the phone's frozen `newTabPhone` key, which the
 * apply path folds into `newTab`.
 */
export type SettingsData = Omit<Settings, 'onboardingDone'>
export interface ShortcutsData {
  overrides: Record<string, KeyBinding | null>
}

export const SETTINGS_RECORD_ID = 'settings'
export const SHORTCUTS_RECORD_ID = 'shortcuts'
export const SITE_DATA_RECORD_ID = 'site-data'

/**
 * A saved login as Chrome's password sync carries it: the whole entry, secret included, under
 * the folder's end-to-end key. The record id is the entry's id, so the same login edited on two
 * devices merges last-writer-wins per entry and a deletion travels as the record's tombstone.
 */
export interface LoginCredentialData {
  kind: 'login'
  origin: string
  url: string
  username: string
  password: string
  realm: string | null
  /** The user's note (ID-34), '' when none; part of the record since the type existed. */
  notes: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /**
   * The breach state of the password value (ID-31: `Credential.breached` and its timestamps),
   * each present only when set, so a login without one hashes exactly as it always did and a
   * device on an older build, which knows none of them, reads the record as before.
   */
  breached?: number
  checkedAt?: number
  leakWarnedAt?: number
  leakIgnoredAt?: number
}

/** The `LoginCredentialData` breach fields, each taken along only when the login has a value. */
function leakFieldsOf(c: Credential): Partial<LoginCredentialData> {
  const out: Partial<LoginCredentialData> = {}
  if (c.breached !== null) out.breached = c.breached
  if (c.checkedAt !== null) out.checkedAt = c.checkedAt
  if (c.leakWarnedAt !== null) out.leakWarnedAt = c.leakWarnedAt
  if (c.leakIgnoredAt !== null) out.leakIgnoredAt = c.leakIgnoredAt
  return out
}

/**
 * A passkey's public record: relying party, account names, credential id, origin. This is all
 * the store holds and all that can travel – the private key lives in the platform authenticator
 * (Windows Hello, Touch ID, Android's credential manager) and never leaves the device, so a
 * synced passkey shows up in the other device's list but signing in there needs the passkey
 * created (or synced by the OS's own provider) on that device.
 */
export interface PasskeyCredentialData {
  kind: 'passkey'
  rpId: string
  rpName: string
  userName: string
  userDisplayName: string
  credentialId: string
  origin: string
  createdAt: number
  lastUsedAt: number | null
}

export type CredentialData = LoginCredentialData | PasskeyCredentialData

/** Read a credential record from another device; null for garbage or an unknown kind. */
export function readCredentialData(data: unknown): CredentialData | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Record<string, unknown>
  const str = (key: string): string => (typeof r[key] === 'string' ? (r[key] as string) : '')
  const num = (key: string, fallback: number): number =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) ? (r[key] as number) : fallback
  const nullableNum = (key: string): number | null =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) ? (r[key] as number) : null
  if (r.kind === 'login') {
    if (!str('origin') || !str('password')) return null
    const login: LoginCredentialData = {
      kind: 'login',
      origin: str('origin'),
      url: str('url'),
      username: str('username'),
      password: str('password'),
      realm: typeof r.realm === 'string' ? r.realm : null,
      notes: str('notes'),
      createdAt: num('createdAt', 0),
      updatedAt: num('updatedAt', 0),
      lastUsedAt: nullableNum('lastUsedAt')
    }
    for (const key of ['breached', 'checkedAt', 'leakWarnedAt', 'leakIgnoredAt'] as const) {
      const value = nullableNum(key)
      if (value !== null) login[key] = value
    }
    return login
  }
  if (r.kind === 'passkey') {
    if (!str('rpId')) return null
    return {
      kind: 'passkey',
      rpId: str('rpId'),
      rpName: str('rpName'),
      userName: str('userName'),
      userDisplayName: str('userDisplayName'),
      credentialId: str('credentialId'),
      origin: str('origin'),
      createdAt: num('createdAt', 0),
      lastUsedAt: nullableNum('lastUsedAt')
    }
  }
  return null
}

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
    boosts: true,
    passwords: true,
    history: true
  }
}

/** Every type on: what a device holds in total, whatever it currently chooses to sync. */
export function fullScope(): SyncScope {
  return {
    spaces: true,
    folders: true,
    pinnedTabs: true,
    essentials: true,
    openTabs: true,
    containers: true,
    bookmarks: true,
    settings: true,
    shortcuts: true,
    boosts: true,
    passwords: true,
    history: true
  }
}

/**
 * Whether a record another device published is wanted under `scope` (Chrome's per-type
 * toggles work both ways: a type turned off is neither sent nor received). Tab records are
 * read by section; a tab tombstone carries no data and is taken while any tab section syncs.
 */
export function inScope(record: SyncRecord, scope: SyncScope): boolean {
  switch (record.type) {
    case 'space':
      return scope.spaces
    case 'folder':
      return scope.folders
    case 'container':
      return scope.containers
    case 'bookmark':
      return scope.bookmarks
    case 'settings':
    case 'site-data':
      return scope.settings
    case 'shortcuts':
      return scope.shortcuts
    case 'boost':
      return scope.boosts
    case 'credential':
      return scope.passwords
    case 'tab': {
      if (record.deleted || !record.data || typeof record.data !== 'object')
        return scope.pinnedTabs || scope.essentials || scope.openTabs
      const data = record.data as Partial<TabData>
      if (data.essential) return scope.essentials
      if (data.pinned) return scope.pinnedTabs
      return scope.openTabs
    }
    case 'order':
      if (record.id === ORDER_SPACES) return scope.spaces
      if (record.id === ORDER_CONTAINERS) return scope.containers
      if (record.id === ORDER_ESSENTIALS) return scope.essentials
      return scope.pinnedTabs || scope.openTabs
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
  return sha1Hex(stableStringify(data))
}

/** The credential store's entries while it is unlocked. */
export interface CredentialSources {
  logins: Credential[]
  passkeys: PasskeyEntry[]
}

export interface LocalSources {
  model: Model
  settings: Settings
  shortcutOverrides: Record<string, KeyBinding | null>
  bookmarks: BookmarkNode[]
  boosts: Boost[]
  /**
   * The credential store's entries, or null while the vault is locked (or absent): its records
   * are then neither published nor tombstoned (`diffLocal`'s `frozen`) until it opens again.
   */
  credentials?: CredentialSources | null
  /** The per-site cookie policy (`SiteDataService.policy()`); published with the settings. */
  siteData?: SiteDataPolicy
}

/** Snapshot of everything in scope as `{ id → { type, data } }`. */
export function collectLocal(
  src: LocalSources,
  scope: SyncScope
): Map<string, { type: RecordType; data: unknown }> {
  const out = new Map<string, { type: RecordType; data: unknown }>()
  const m = src.model
  if (scope.spaces) {
    for (const s of m.spaces) {
      const data: SpaceData = {
        name: s.name,
        icon: s.icon,
        containerId: s.containerId,
        theme: s.theme,
        pinnedCollapsed: s.pinnedCollapsed
      }
      out.set(s.id, { type: 'space', data })
    }
    const order: OrderData = { ids: m.spaces.map((s) => s.id) }
    out.set(ORDER_SPACES, { type: 'order', data: order })
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
      if (f.color) data.color = f.color
      out.set(f.id, { type: 'folder', data })
    }
  }
  if (scope.pinnedTabs || scope.essentials || scope.openTabs) {
    const synced = (t: Tab | undefined): t is Tab => {
      if (!t || t.windowId) return false
      if (t.spaceId && m.localSpaces[t.spaceId]) return false
      if (!t.essential && (!t.spaceId || !m.spaces.some((s) => s.id === t.spaceId))) return false
      const wanted = t.essential ? scope.essentials : t.pinned ? scope.pinnedTabs : scope.openTabs
      if (!wanted) return false
      return !(t.url.startsWith('zen://') && !t.pinnedUrl)
    }
    for (const t of Object.values(m.tabs)) {
      if (!synced(t)) continue
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
        muted: t.muted
      }
      out.set(t.id, { type: 'tab', data })
    }
    if (scope.essentials) {
      const order: OrderData = { ids: m.essentialTabIds.filter((id) => synced(m.tabs[id])) }
      out.set(ORDER_ESSENTIALS, { type: 'order', data: order })
    }
    for (const space of m.spaces) {
      const order: OrderData = {
        pinned: space.tabIds.filter((id) => synced(m.tabs[id]) && m.tabs[id].pinned),
        regular: scope.openTabs
          ? space.tabIds.filter((id) => synced(m.tabs[id]) && !m.tabs[id].pinned)
          : []
      }
      if (order.pinned!.length || order.regular!.length)
        out.set(orderTabsId(space.id), { type: 'order', data: order })
    }
  }
  if (scope.containers) {
    for (const c of m.containers) {
      if (c.id === DEFAULT_CONTAINER_ID) continue
      const data: ContainerData = { name: c.name, color: c.color, icon: c.icon }
      out.set(c.id, { type: 'container', data })
    }
    const order: OrderData = {
      ids: m.containers.filter((c) => c.id !== DEFAULT_CONTAINER_ID).map((c) => c.id)
    }
    out.set(ORDER_CONTAINERS, { type: 'order', data: order })
  }
  if (scope.bookmarks) {
    for (const b of src.bookmarks) {
      if (isBookmarkRoot(b.id) || b.parentId === null) continue
      const data: BookmarkData = {
        parentId: b.parentId,
        index: b.index,
        type: b.type,
        title: b.title,
        dateAdded: b.dateAdded
      }
      if (b.type === 'url') {
        data.url = b.url
        if (b.favicon) data.favicon = b.favicon
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
    if (src.siteData) out.set(SITE_DATA_RECORD_ID, { type: 'site-data', data: src.siteData })
  }
  if (scope.shortcuts) {
    const data: ShortcutsData = { overrides: src.shortcutOverrides }
    out.set(SHORTCUTS_RECORD_ID, { type: 'shortcuts', data })
  }
  if (scope.boosts) {
    for (const b of src.boosts) out.set(`boost:${b.domain}`, { type: 'boost', data: b })
  }
  if (scope.passwords && src.credentials) {
    for (const c of src.credentials.logins) {
      const data: LoginCredentialData = {
        kind: 'login',
        origin: c.origin,
        url: c.url,
        username: c.username,
        password: c.password,
        realm: c.realm,
        notes: c.notes,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        lastUsedAt: c.lastUsedAt,
        ...leakFieldsOf(c)
      }
      out.set(c.id, { type: 'credential', data })
    }
    for (const p of src.credentials.passkeys) {
      const data: PasskeyCredentialData = {
        kind: 'passkey',
        rpId: p.rpId,
        rpName: p.rpName,
        userName: p.userName,
        userDisplayName: p.userDisplayName,
        credentialId: p.credentialId,
        origin: p.origin,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt
      }
      out.set(p.id, { type: 'credential', data })
    }
  }
  return out
}

/**
 * Records a device holds but does not sync right now: everything the full scope would collect
 * that `scope` leaves out, plus (while the vault is locked) whatever credential records the last
 * sync knew. `diffLocal` keeps their metadata as it was instead of tombstoning them, so turning a
 * type off – or a locked vault – never deletes the other devices' copies (Chrome's toggles only
 * stop syncing a type).
 */
export function frozenRecords(
  src: LocalSources,
  scope: SyncScope,
  previous: MetaMap
): (id: string, prev: RecordMeta) => boolean {
  const synced = collectLocal(src, scope)
  const held = new Set<string>()
  for (const id of collectLocal(src, fullScope()).keys()) if (!synced.has(id)) held.add(id)
  const vaultLocked = !src.credentials
  void previous
  return (id, prev) => held.has(id) || (vaultLocked && prev.type === 'credential')
}

export interface DiffResult {
  meta: MetaMap
  records: SyncRecord[]
  changed: boolean
}

/**
 * Compare the current local snapshot with the metadata of the last sync: changed records get a
 * fresh `modified`, vanished records become tombstones, everything else keeps its timestamp.
 *
 * Records seen for the first time get `modified = 0`: they still replicate to devices that lack
 * them, but a copy that already exists elsewhere wins – so joining a sync folder merges *into*
 * the existing data instead of a fresh device overwriting everyone's settings and ordering.
 *
 * A record absent from `current` for which `frozen` answers true is held rather than deleted:
 * its metadata stays as it was and it is left out of the published set (see `frozenRecords`).
 */
export function diffLocal(
  previous: MetaMap,
  current: Map<string, { type: RecordType; data: unknown }>,
  now: number,
  tombstoneTtlMs = 30 * 24 * 60 * 60 * 1000,
  frozen: (id: string, prev: RecordMeta) => boolean = () => false
): DiffResult {
  const meta: MetaMap = {}
  const records: SyncRecord[] = []
  let changed = false
  for (const [id, { type, data }] of current) {
    const hash = hashData(data)
    const prev = previous[id]
    let modified: number
    if (!prev) modified = 0
    else if (prev.hash === hash && !prev.deleted) modified = prev.modified
    else modified = now
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
    if (frozen(id, prev)) {
      meta[id] = prev
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

/**
 * Apply a synced ordering: known ids in the synced order first, anything the list does not
 * mention keeps its relative position after them.
 */
export function applyOrder(current: string[], wanted: string[] | undefined): string[] {
  if (!wanted) return current
  const present = new Set(current)
  const head = wanted.filter((id) => present.has(id))
  const mentioned = new Set(head)
  return [...head, ...current.filter((id) => !mentioned.has(id))]
}

export type { Space, Folder }
