import type {
  BookmarkNode,
  BookmarkNodeType,
  Boost,
  Container,
  Credential,
  Folder,
  FolderAgentMark,
  FolderColor,
  KeyBinding,
  PasskeyEntry,
  Settings,
  Space,
  SpaceAgentMark,
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
 * exactly like Firefox Sync's engines – and, for the one settings record, per top-level key, as
 * Chrome Sync treats each preference as its own item (`SyncRecord.keys`, `diffSettings`).
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
  /**
   * The settings record only (`SETTINGS_RECORD_ID`): the `modified` of each top-level key of
   * `data` whose time differs from the record's – the record's is the newest of them – so a
   * reader on this build merges the record key by key, as Chrome Sync treats each preference as
   * its own item, while a build before it reads the record whole at the time of its newest edit,
   * exactly as it always did (`winningRemote`). Never on another record, and absent while every
   * key shares the record's time, so a record set no one edited under this build serialises and
   * hashes as before (`__tests__/compat.test.ts`); `hashData(data)` never sees it – it stands
   * beside `data`, not in it. A key the map does not name is at the record's time.
   */
  keys?: Record<string, number>
}

/** One top-level key of the settings record in the metadata: its value's hash and its own time. */
export interface KeyMeta {
  hash: string
  modified: number
}

export interface RecordMeta {
  type: RecordType
  hash: string
  modified: number
  deleted: boolean
  /**
   * The settings record only: each top-level key's own hash and `modified` (`SyncRecord.keys`
   * on the wire; `diffSettings` for the rules). Absent, the entry says what it always said –
   * every key at `modified`, no hash finer than the record's: a metadata from before per-key
   * merge, or a record first seen at the last diff – and the next diff that finds the record
   * unchanged fills it in at that time, as the boot seed does (`seedSettingsMeta`).
   */
  keys?: Record<string, KeyMeta>
}

export type MetaMap = Record<string, RecordMeta>

export interface SpaceData {
  name: string
  icon: string
  containerId: string
  theme: SpaceTheme | null
  pinnedCollapsed: boolean
  /**
   * The agents' mark (`Space.agent`), present only on a marked space so every other record
   * hashes as it always did; a peer without the field ignores it, and one whose record lacks it
   * leaves the local mark alone (`readSpaceAgentMark`).
   */
  agent?: SpaceAgentMark
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
  /** The agent's mark (`Folder.agent`); absent on the user's folders, as `color` is when none. */
  agent?: FolderAgentMark
}

/**
 * The agent's mark a folder record carries, when it carries a well-formed one: `undefined` when
 * the record has no such field (a peer older than the mark, or the user's folder – the local
 * mark, if any, stays), so a malformed field is the same as none.
 */
export function readFolderAgentMark(data: unknown): FolderAgentMark | undefined {
  const raw = (data as { agent?: unknown } | null)?.agent
  if (!raw || typeof raw !== 'object') return undefined
  const { name, createdAt } = raw as { name?: unknown; createdAt?: unknown }
  if (typeof name !== 'string' || typeof createdAt !== 'number' || !Number.isFinite(createdAt))
    return undefined
  return { name, createdAt }
}

/** The agents' mark a space record carries, when well-formed; `undefined` otherwise (as above). */
export function readSpaceAgentMark(data: unknown): SpaceAgentMark | undefined {
  const raw = (data as { agent?: unknown } | null)?.agent
  if (!raw || typeof raw !== 'object') return undefined
  const mark = raw as { kind?: unknown; name?: unknown; createdAt?: unknown }
  if (mark.kind === 'shared') return { kind: 'shared' }
  if (
    mark.kind === 'own' &&
    typeof mark.name === 'string' &&
    typeof mark.createdAt === 'number' &&
    Number.isFinite(mark.createdAt)
  )
    return { kind: 'own', name: mark.name, createdAt: mark.createdAt }
  return undefined
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
 * The settings that are one device's own and travel in neither direction: this device's record
 * carries none of them, and a peer's record carrying one (a build from before a key joined the
 * list still sends it) leaves this device's value standing – the settings record is otherwise
 * merged key by key, a peer's later key landing (`winningSettings`), so a stray key would land
 * as a choice made here. Such a key is never a peer's to win, either: this device holds no entry
 * for it, so its "later" time would beat nothing every round and the apply would land nothing.
 * - `onboardingDone`: the one-time flag.
 * - `sidebarExpandOnHover`: a pointer's hover preference for the rail (tabs-03), on by default
 *   since profile v6; a peer on v5 still stores that build's default `false`, no choice.
 * - `searchChoice`: the EEA's search-engine choice screen's record (W6-2) – each device's to
 *   answer once, as Chrome's; the engine it set travels as `searchEngineId`, the record does not.
 */
export const DEVICE_LOCAL_SETTINGS = [
  'onboardingDone',
  'sidebarExpandOnHover',
  'searchChoice'
] as const
export type DeviceLocalSetting = (typeof DEVICE_LOCAL_SETTINGS)[number]
const DEVICE_LOCAL = new Set<string>(DEVICE_LOCAL_SETTINGS)

/** Whether `key` is one of `DEVICE_LOCAL_SETTINGS`. */
function isDeviceLocalSetting(key: string): boolean {
  return DEVICE_LOCAL.has(key)
}

/** A copy of `settings` without the device-local keys, the other keys in their order. */
export function withoutDeviceLocalSettings<T extends object>(
  settings: T
): Omit<T, DeviceLocalSetting> {
  const out = { ...settings } as Record<string, unknown>
  for (const key of DEVICE_LOCAL_SETTINGS) delete out[key]
  return out as Omit<T, DeviceLocalSetting>
}

/**
 * The whole `Settings` object but the device-local keys. The new tab page's device-local sets
 * (`BrowserState.newTabDevice`: this device's shortcuts and removed hosts) are not settings and
 * never travel; a peer on an older build may add the phone's frozen `newTabPhone` key, which the
 * apply path folds into `newTab`.
 */
export type SettingsData = Omit<Settings, DeviceLocalSetting>
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

// ---------------------------------------------------------------------------
// The settings record, key by key
// ---------------------------------------------------------------------------

/**
 * Top-level settings keys that only make sense together and so merge as one: `searchEngineId`
 * names an engine that `searchEngines` may be the only carrier of (an engine added by hand on
 * the peer), a 0.3.x phone's frozen `newTabPhone` is folded into `newTab` at apply, and the
 * 0.4.x `restoreSession` switch – retired by 0.4.83's `startup` (Settings › On startup) – is
 * folded into `startup` there. An edit of either member stamps both; a peer's copy wins or
 * loses for both at once; the two travel in one record from one device (`newestByRecord`). A
 * renamed key's group is what lets an old peer's key and this device's successor compare as one
 * item by time (`winningSettings`) and lets the successor inherit the retired key's time at the
 * upgrade (`seedSettingsMeta`).
 */
const SETTINGS_KEY_GROUPS: Readonly<Record<string, string>> = {
  searchEngineId: 'searchEngines',
  newTabPhone: 'newTab',
  restoreSession: 'startup'
}

/** The composite group a settings key merges under: its own name unless it is a member. */
export function settingsKeyGroup(key: string): string {
  return SETTINGS_KEY_GROUPS[key] ?? key
}

export function isSettingsRecord(id: string, type: RecordType): boolean {
  return type === 'settings' && id === SETTINGS_RECORD_ID
}

/**
 * The top-level keys of a settings record's data with the values they carry – what the wire
 * carries: a key set to `undefined` is not serialised and so does not exist to a peer. Nothing
 * for data that is no object.
 */
function settingsEntries(data: unknown): Array<[string, unknown]> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.entries(data as Record<string, unknown>).filter(([, value]) => value !== undefined)
}

/** The time a settings record gives one of its keys: its own, or the record's when it names none. */
export function settingsKeyTime(record: SyncRecord, key: string): number {
  const own = record.keys?.[key]
  return typeof own === 'number' && Number.isFinite(own) ? own : record.modified
}

/** The wire form of per-key times: only the keys whose time differs from the record's. */
function keysOnWire(
  times: Record<string, number>,
  modified: number
): Record<string, number> | undefined {
  let out: Record<string, number> | undefined
  for (const [key, time] of Object.entries(times)) {
    if (time === modified) continue
    ;(out ??= {})[key] = time
  }
  return out
}

/** The keys grouped by the composite group each merges under (`settingsKeyGroup`). */
function groupsOf(keys: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const key of keys) {
    const group = settingsKeyGroup(key)
    const members = groups.get(group)
    if (members) members.push(key)
    else groups.set(group, [key])
  }
  return groups
}

/** The newest of the per-key times, or `fallback` when there is no key. */
function newestOf(times: Iterable<number>, fallback: number): number {
  let out: number | undefined
  for (const time of times) if (out === undefined || time > out) out = time
  return out ?? fallback
}

/** The settings record `data` publishes under per-key times: `keys` on the wire when any differs. */
function settingsRecord(
  id: string,
  data: unknown,
  times: Record<string, number>,
  fallback: number
): SyncRecord {
  const modified = newestOf(Object.values(times), fallback)
  const record: SyncRecord = { id, type: 'settings', modified, deleted: false, data }
  const keys = keysOnWire(times, modified)
  if (keys) record.keys = keys
  return record
}

/**
 * The settings record's own diff, key by key: against the metadata's entry for each top-level
 * key (each composite group, `SETTINGS_KEY_GROUPS`), a value whose hash stands keeps the key's
 * time; a group with a changed, added or removed member takes `stamp` on every member present –
 * or, when the diff only notices (`stamp` null), each member keeps its own time and a member the
 * metadata did not know takes 0 (`DiffLocalOptions.stamp`: made, not noticed). A key the object
 * no longer holds loses its entry and the record simply lacks it, which says nothing to a peer
 * (the `menuOrder` precedent: a reset travels as an explicit value, `[]`). The record's
 * `modified` is the newest key's.
 *
 * An entry without `keys` speaks for the record whole. Unchanged, every key stands at the
 * record's time with its value's hash from here on – the boot seed's migration for an entry the
 * seed did not see (a record first seen at the last diff, a joiner's `confirmMerge` entry).
 * Changed, the change cannot be placed on a key: every key takes the record's stamp –
 * whole-record last-writer-wins, the rule the record had until per-key merge and the one "keep
 * this device's data" (`confirmMerge`, hash '') wants.
 *
 * The record's own hash is computed first and, unchanged, settles it: the entry's per-key part
 * was computed from this very data, so it stands as it is and no key is hashed – most state
 * commits (a tab moved, a bookmark added) touch no setting, and the diff they run costs the
 * settings record what it did before per-key merge. Only a changed record is placed key by key.
 */
function diffSettings(
  prev: RecordMeta,
  data: unknown,
  stamp: number | null
): { meta: RecordMeta; changed: boolean } {
  const hash = hashData(data)
  if (prev.keys && prev.hash === hash) {
    const modified = newestOf(
      Object.values(prev.keys).map((k) => k.modified),
      prev.modified
    )
    return {
      meta: { type: 'settings', hash, modified, deleted: false, keys: prev.keys },
      changed: false
    }
  }
  const entries = settingsEntries(data)
  const keys: Record<string, KeyMeta> = {}
  let changed = false
  if (!prev.keys) {
    const same = prev.hash === hash
    const time = same ? prev.modified : (stamp ?? prev.modified)
    for (const [key, value] of entries) keys[key] = { hash: hashData(value), modified: time }
    changed = !same
  } else {
    const previous = prev.keys
    const hashes = new Map(entries.map(([key, value]) => [key, hashData(value)] as const))
    const removed = new Set(
      Object.keys(previous)
        .filter((key) => !hashes.has(key))
        .map(settingsKeyGroup)
    )
    if (removed.size) changed = true
    for (const [group, members] of groupsOf(hashes.keys())) {
      const moved =
        removed.has(group) || members.some((key) => previous[key]?.hash !== hashes.get(key))
      if (moved) changed = true
      for (const key of members) {
        const kept = previous[key]?.modified ?? 0
        keys[key] = { hash: hashes.get(key)!, modified: moved ? (stamp ?? kept) : kept }
      }
    }
  }
  const modified = newestOf(
    Object.values(keys).map((k) => k.modified),
    prev.modified
  )
  return { meta: { type: 'settings', hash, modified, deleted: false, keys }, changed }
}

/**
 * The boot seed's form of the settings entry (`SyncEngine.seedMeta`): what differs at start is
 * the build's, adopted without a stamp, key by key. An entry from before per-key merge gains
 * every key at the record's time – nothing finer is known – with its value's hash; an entry
 * with keys adopts a changed value's hash at the key's own time, puts a key it did not know (a
 * default this build added) at the newest time of its group's other members the entry knew –
 * a key that succeeds a retired one (`startup` after `restoreSession`) is the same edit under a
 * new name, so the edit's time travels with the rename and an old peer's older switch cannot
 * beat this device's later choice – else at 0, a key no one edited never beats a peer's; and
 * drops a key the build no longer holds. The record's `modified` stands. Returns `prev` itself
 * when nothing differs.
 */
export function seedSettingsMeta(prev: RecordMeta, data: unknown): RecordMeta {
  const entries = settingsEntries(data)
  const hash = hashData(data)
  const keys: Record<string, KeyMeta> = {}
  if (!prev.keys) {
    for (const [key, value] of entries)
      keys[key] = { hash: hashData(value), modified: prev.modified }
    return { ...prev, hash, keys }
  }
  let changed = prev.hash !== hash
  for (const [key, value] of entries) {
    const before = prev.keys[key]
    const valueHash = hashData(value)
    if (before && before.hash === valueHash) {
      keys[key] = before
      continue
    }
    keys[key] = {
      hash: valueHash,
      modified: before ? before.modified : inheritedKeyTime(prev.keys, key)
    }
    changed = true
  }
  for (const key of Object.keys(prev.keys)) if (!(key in keys)) changed = true
  return changed ? { ...prev, hash, keys } : prev
}

/**
 * The time a key the entry did not know is seeded at: the newest of its group's other members
 * (`SETTINGS_KEY_GROUPS`) the entry holds, else 0. Never raises the group's time – a sibling's
 * time IS the group's – so the seed still beats no peer it did not beat before.
 */
function inheritedKeyTime(previous: Record<string, KeyMeta>, key: string): number {
  const group = settingsKeyGroup(key)
  const siblings = Object.entries(previous).filter(
    ([other]) => other !== key && settingsKeyGroup(other) === group
  )
  return newestOf(
    siblings.map(([, entry]) => entry.modified),
    0
  )
}

/**
 * The other devices' settings records as one: each composite group from the device whose copy
 * of it is newest (ties to the first read, as `newestByRecord` has always ruled), the record's
 * `modified` the newest of them. One record per id would not do here: a device whose newest
 * key is older than another's would never be read, so a key it alone edited could not reach a
 * third device while the other is away. A single live record is taken as it is; tombstones
 * count only when there is nothing else.
 */
function mergeSettingsRecords(records: SyncRecord[]): SyncRecord {
  const live = records.filter((r) => !r.deleted && settingsEntries(r.data).length > 0)
  if (live.length === 0) return records.reduce((a, b) => (b.modified > a.modified ? b : a))
  if (live.length === 1) return live[0]
  const best = new Map<string, { time: number; from: SyncRecord; members: string[] }>()
  for (const r of live) {
    for (const [group, members] of groupsOf(settingsEntries(r.data).map(([key]) => key))) {
      const time = newestOf(
        members.map((key) => settingsKeyTime(r, key)),
        r.modified
      )
      const cur = best.get(group)
      if (!cur || time > cur.time) best.set(group, { time, from: r, members })
    }
  }
  const data: Record<string, unknown> = {}
  const times: Record<string, number> = {}
  for (const { from, members } of best.values()) {
    for (const key of members) {
      data[key] = (from.data as Record<string, unknown>)[key]
      times[key] = settingsKeyTime(from, key)
    }
  }
  return settingsRecord(SETTINGS_RECORD_ID, data, times, live[0].modified)
}

/**
 * The keys of a peer's settings record that beat this device's, as a record of those keys
 * alone – `applyRemote` lands what the record carries, so the winner IS the winning set. A
 * composite group wins when the peer's time for it (its newest member) is strictly newer than
 * this device's (the newest member it holds of the group, whether or not the peer carries that
 * member: an old peer's retired key is weighed against this device's successor, `restoreSession`
 * against `startup`, `newTabPhone` against `newTab`; a group it holds nothing of cannot be
 * beaten) and a member's value differs – ties keep the local, as they always have per record
 * (Chrome's preferences prefer the sync copy on a conflict, which a folder without a server
 * cannot do). A device-local key (`DEVICE_LOCAL_SETTINGS`, still sent by an older build) is no
 * one's to win. Null when nothing wins.
 */
function winningSettings(
  mine: RecordMeta & { keys: Record<string, KeyMeta> },
  r: SyncRecord
): SyncRecord | null {
  const entries = settingsEntries(r.data)
  if (entries.length === 0) return null
  const hashes = new Map(entries.map(([key, value]) => [key, hashData(value)] as const))
  const held = groupsOf(Object.keys(mine.keys))
  const won = new Set<string>()
  for (const [group, members] of groupsOf(hashes.keys())) {
    if (members.every(isDeviceLocalSetting)) continue
    const theirs = newestOf(
      members.map((key) => settingsKeyTime(r, key)),
      r.modified
    )
    const ours = newestOf(
      (held.get(group) ?? []).map((key) => mine.keys[key].modified),
      Number.NEGATIVE_INFINITY
    )
    if (theirs <= ours) continue
    if (!members.some((key) => mine.keys[key]?.hash !== hashes.get(key))) continue
    for (const key of members) won.add(key)
  }
  if (won.size === 0) return null
  const data: Record<string, unknown> = {}
  const times: Record<string, number> = {}
  for (const [key, value] of entries) {
    if (!won.has(key)) continue
    data[key] = value
    times[key] = settingsKeyTime(r, key)
  }
  return settingsRecord(r.id, data, times, r.modified)
}

/**
 * The metadata's settings entry once a peer's keys were applied: this device's entries with
 * the winner's keys at the peer's times and value hashes (every key of the record when this
 * device had no per-key entries – the record won whole; the device-local keys an older build's
 * record carries never land, so they get no entry). The record hash is the winner's until the
 * re-snapshot that follows an apply computes this device's own.
 */
function settingsMetaFromRemote(r: SyncRecord, mine: RecordMeta | undefined): RecordMeta {
  const keys: Record<string, KeyMeta> = mine && !mine.deleted && mine.keys ? { ...mine.keys } : {}
  for (const [key, value] of settingsEntries(r.data)) {
    if (isDeviceLocalSetting(key)) continue
    keys[key] = { hash: hashData(value), modified: settingsKeyTime(r, key) }
  }
  const modified = newestOf(
    Object.values(keys).map((k) => k.modified),
    r.modified
  )
  return { type: 'settings', hash: hashData(r.data), modified, deleted: false, keys }
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
      if (s.agent) data.agent = s.agent
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
      if (f.agent) data.agent = f.agent
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
    // The record carries the settings as they are and never a key they lack: a key invented here
    // would change every device's record – its hash, so `diffLocal` stamps it `now` at the first
    // sync after the upgrade, a whole-record edit no one made that beats and reverts a peer's
    // settings change the device had not yet pulled. The phone menu's order (`menuOrder`) rides
    // along only once the settings hold it: the empty list after a Reset (`shared/menuOrder.ts`),
    // so the reset reaches the peers as an edit of the key, where a key the record lacks says
    // nothing to `apply`.
    const rest = withoutDeviceLocalSettings(src.settings)
    const data: SettingsData & { restoreSession?: boolean } = {
      ...rest,
      compactMode: { ...rest.compactMode, sidebarPersistent: false }
    }
    // The 0.4.x `restoreSession` switch rides beside its successor `startup` for one release –
    // mirrored here, in the same group, so an edit stamps both and a peer on the old build still
    // hears this device's choice (a new peer prefers `startup`, `apply` folds the switch for an
    // old one). Coarse on purpose: `pages` reads as on, as the phone boots it (continue). Comes
    // off in 0.4.84, the release after the one that retires the key. Only a settings object that
    // holds `startup` mirrors it: a profile from before the key (the golden fixtures) sends the
    // record its build sent, switch and all, and manufactures no edit.
    if (rest.startup) data.restoreSession = rest.startup.mode !== 'newTab'
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

export interface DiffLocalOptions {
  /**
   * The `modified` a record takes when its hash differs from its `previous` entry: the
   * wall-clock moment the change was made, or `null` to keep the previous `modified`.
   *
   * THE RULE: an edit is stamped where it is MADE, never where it is NOTICED. The engine's state
   * subscriber (`SyncEngine.onLocalChange`) runs at the commit that carries an edit and stamps
   * it `now`; the engine's round (`SyncEngine.run`) only notices, and passes `null`. A hash the
   * round alone finds changed was not a user's edit: a build's new settings default that the
   * load spread onto the settings, a sanitiser's new normal form, this device normalising a
   * remote value differently from the peer that sent it (the boot seed, `SyncEngine.seedMeta`,
   * adopts the first two before any round). Stamped at the round, such a change would publish a
   * whole-record edit no one made, which wins last-writer-wins over a peer's real change this
   * device had not pulled – the settings record at every device's first sync after a release.
   *
   * A record without a previous entry takes `modified = 0` either way; a vanished record's
   * tombstone is stamped `now` either way (its deletion is what the diff notices, and a device
   * that stops holding a record has, so far, always done so by the user's hand or a merge).
   */
  stamp: number | null
  tombstoneTtlMs?: number
  frozen?: (id: string, prev: RecordMeta) => boolean
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Compare the current local snapshot with the metadata of the last sync: changed records get
 * `options.stamp` as their `modified` (or keep the previous one, see `DiffLocalOptions`),
 * vanished records become tombstones at `now`, everything else keeps its timestamp. Without
 * options the change is stamped `now` – the subscriber's mode, and the one the pre-move engine
 * had (`__tests__/compat.test.ts` pins it).
 *
 * Records seen for the first time get `modified = 0`: they still replicate to devices that lack
 * them, but a copy that already exists elsewhere wins – so joining a sync folder merges *into*
 * the existing data instead of a fresh device overwriting everyone's settings and ordering.
 *
 * A record absent from `current` for which `frozen` answers true is held rather than deleted:
 * its metadata stays as it was and it is left out of the published set (see `frozenRecords`).
 *
 * The settings record the metadata already knows is diffed key by key (`diffSettings`) and
 * published with each key's time (`SyncRecord.keys`); first seen, it takes `0` like any other
 * record, whole – every key at 0 – and gains its per-key entries at the next diff.
 */
export function diffLocal(
  previous: MetaMap,
  current: Map<string, { type: RecordType; data: unknown }>,
  now: number,
  options: DiffLocalOptions = { stamp: now }
): DiffResult {
  const { stamp, tombstoneTtlMs = TOMBSTONE_TTL_MS, frozen = () => false } = options
  const meta: MetaMap = {}
  const records: SyncRecord[] = []
  let changed = false
  for (const [id, { type, data }] of current) {
    const prev = previous[id]
    if (prev && !prev.deleted && isSettingsRecord(id, type)) {
      const settings = diffSettings(prev, data, stamp)
      if (settings.changed) changed = true
      meta[id] = settings.meta
      const times: Record<string, number> = {}
      for (const [key, entry] of Object.entries(settings.meta.keys!)) times[key] = entry.modified
      records.push(settingsRecord(id, data, times, settings.meta.modified))
      continue
    }
    const hash = hashData(data)
    let modified: number
    if (!prev) modified = 0
    else if (prev.hash === hash && !prev.deleted) modified = prev.modified
    else modified = stamp ?? prev.modified
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

/**
 * Newest version of every record across all remote devices; the settings record merged key by
 * key across them (`mergeSettingsRecords`).
 */
export function newestByRecord(remote: SyncRecord[][]): Map<string, SyncRecord> {
  const out = new Map<string, SyncRecord>()
  const settings: SyncRecord[] = []
  for (const list of remote) {
    for (const r of list) {
      if (isSettingsRecord(r.id, r.type)) {
        settings.push(r)
        continue
      }
      const cur = out.get(r.id)
      if (!cur || r.modified > cur.modified) out.set(r.id, r)
    }
  }
  if (settings.length) out.set(SETTINGS_RECORD_ID, mergeSettingsRecords(settings))
  return out
}

/**
 * Remote records that beat the local copy (strictly newer). Local wins ties, and unchanged
 * remote records (same hash) are skipped so nothing is re-applied needlessly. The settings
 * record is judged key by key once this device holds per-key entries (`winningSettings`): what
 * comes back is the record narrowed to the keys that won. Against an entry without them (a
 * metadata from before per-key merge, a record first seen at the last diff) it is judged whole,
 * as every record always was.
 */
export function winningRemote(local: MetaMap, remote: Map<string, SyncRecord>): SyncRecord[] {
  const winners: SyncRecord[] = []
  for (const r of remote.values()) {
    const mine = local[r.id]
    if (!mine) {
      if (!r.deleted) winners.push(r)
      continue
    }
    if (mine.keys && !mine.deleted && !r.deleted && isSettingsRecord(r.id, r.type)) {
      const won = winningSettings(mine as RecordMeta & { keys: Record<string, KeyMeta> }, r)
      if (won) winners.push(won)
      continue
    }
    if (r.modified <= mine.modified) continue
    if (!r.deleted && !mine.deleted && hashData(r.data) === mine.hash) continue
    if (r.deleted && mine.deleted) continue
    winners.push(r)
  }
  return winners
}

/**
 * Meta entries for records we just applied from remote (so we do not echo them as our edits).
 * The settings winner is a set of keys: given `local`, its entry is this device's with those
 * keys at the peer's times (`settingsMetaFromRemote`).
 */
export function metaFromRemote(records: SyncRecord[], local?: MetaMap): MetaMap {
  const meta: MetaMap = {}
  for (const r of records) {
    if (!r.deleted && isSettingsRecord(r.id, r.type)) {
      meta[r.id] = settingsMetaFromRemote(r, local?.[r.id])
      continue
    }
    meta[r.id] = {
      type: r.type,
      hash: r.deleted ? '' : hashData(r.data),
      modified: r.modified,
      deleted: r.deleted
    }
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
