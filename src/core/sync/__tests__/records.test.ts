import { describe, expect, it } from 'vitest'
import {
  DEVICE_LOCAL_SETTINGS,
  ORDER_SPACES,
  SETTINGS_RECORD_ID,
  applyOrder,
  collectLocal,
  defaultScope,
  diffLocal,
  frozenRecords,
  hashData,
  inScope,
  metaFromRemote,
  newestByRecord,
  readBookmarkData,
  readCredentialData,
  readFolderAgentMark,
  readSpaceAgentMark,
  seedSettingsMeta,
  settingsKeyGroup,
  settingsKeyTime,
  stableStringify,
  winningRemote,
  withoutDeviceLocalSettings,
  type BookmarkData,
  type MetaMap,
  type OrderData,
  type RecordMeta,
  type SyncRecord
} from '../records'
import {
  createFolder,
  createSpace,
  createTabRecord,
  emptyModel,
  insertTabIntoSpace
} from '../../../core/model'
import {
  BOOKMARKS_BAR_ID,
  BOOKMARK_ROOT_IDS,
  OTHER_BOOKMARKS_ID,
  createBookmarkRoots
} from '../../../shared/bookmarks'
import { DEFAULT_CONTAINERS, DEFAULT_SETTINGS } from '../../../shared/defaults'
import type { BookmarkNode, SearchEngine, Space, Tab } from '../../../shared/types'
import { emptyLeakFields } from '../../../shared/types'

type Fixture = Parameters<typeof collectLocal>[0] & {
  ids: { space: Space; pinned: Tab; regular: Tab; essential: Tab }
}

function sources(): Fixture {
  const model = emptyModel(structuredClone(DEFAULT_CONTAINERS))
  const space = createSpace('Work', '💼', 'work')
  model.spaces.push(space)
  model.activeSpaceId = space.id
  const pinned = createTabRecord({
    spaceId: space.id,
    containerId: 'work',
    url: 'https://github.com/',
    pinned: true
  })
  const regular = createTabRecord({
    spaceId: space.id,
    containerId: 'work',
    url: 'https://x.test/'
  })
  model.tabs[pinned.id] = pinned
  model.tabs[regular.id] = regular
  insertTabIntoSpace(model, space, pinned)
  insertTabIntoSpace(model, space, regular)
  const essential = createTabRecord({
    spaceId: null,
    containerId: 'default',
    url: 'https://mail.test/',
    essential: true
  })
  model.tabs[essential.id] = essential
  model.essentialTabIds.push(essential.id)
  return {
    model,
    settings: structuredClone(DEFAULT_SETTINGS),
    shortcutOverrides: {},
    bookmarks: [],
    boosts: [],
    ids: { space, pinned, regular, essential }
  }
}

describe('stableStringify / hashData', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
    expect(hashData({ x: 1, y: 2 })).toBe(hashData({ y: 2, x: 1 }))
  })
})

describe('collectLocal', () => {
  it('includes spaces, pinned tabs and essentials but not unpinned tabs by default', () => {
    const src = sources()
    const records = collectLocal(src, defaultScope())
    expect(records.get(src.ids.space.id)?.type).toBe('space')
    expect(records.get(src.ids.pinned.id)?.type).toBe('tab')
    expect(records.get(src.ids.essential.id)?.type).toBe('tab')
    expect(records.has(src.ids.regular.id)).toBe(false)
    expect(records.has('settings')).toBe(true)
    // The default container is implicit on every device.
    expect(records.has('default')).toBe(false)
    expect(records.get('work')?.type).toBe('container')
  })

  it('syncs open tabs when the scope asks for it and never syncs window-local tabs', () => {
    const src = sources()
    src.ids.regular.windowId = 'window_1'
    const records = collectLocal(src, { ...defaultScope(), openTabs: true })
    expect(records.has(src.ids.regular.id)).toBe(false)
    src.ids.regular.windowId = null
    expect(collectLocal(src, { ...defaultScope(), openTabs: true }).has(src.ids.regular.id)).toBe(
      true
    )
  })

  it('carries a folder colour only when the folder has one, so old records keep their hashes', () => {
    const src = sources()
    const plain = createFolder(src.model, src.ids.space.id, 'Docs', '📁')
    const coloured = createFolder(src.model, src.ids.space.id, 'News', '📁', 'pink')
    const records = collectLocal(src, defaultScope())
    expect(records.get(plain.id)?.data).toEqual({
      spaceId: src.ids.space.id,
      name: 'Docs',
      icon: '📁',
      collapsed: false
    })
    expect(records.get(coloured.id)?.data).toMatchObject({ name: 'News', color: 'pink' })
  })

  it("carries the agents' mark on a space or folder only when set, so unmarked records keep their hashes", () => {
    const src = sources()
    const before = hashData(collectLocal(src, defaultScope()).get(src.ids.space.id)!.data)
    const shared = createSpace('Agents', '', 'work')
    shared.agent = { kind: 'shared' }
    const own = createSpace('Research bot', '', 'work')
    own.agent = { kind: 'own', name: 'Research bot', createdAt: 1_000 }
    src.model.spaces.push(shared, own)
    const group = createFolder(src.model, shared.id, 'A · 3f9a', '')
    group.agent = { name: 'A', createdAt: 2_000 }
    const plain = createFolder(src.model, src.ids.space.id, 'Docs', '')
    const records = collectLocal(src, defaultScope())
    expect(hashData(records.get(src.ids.space.id)!.data)).toBe(before)
    expect(records.get(src.ids.space.id)?.data).not.toHaveProperty('agent')
    expect(records.get(plain.id)?.data).not.toHaveProperty('agent')
    expect(records.get(shared.id)?.data).toMatchObject({
      name: 'Agents',
      agent: { kind: 'shared' }
    })
    expect(records.get(own.id)?.data).toMatchObject({
      agent: { kind: 'own', name: 'Research bot', createdAt: 1_000 }
    })
    expect(records.get(group.id)?.data).toEqual({
      spaceId: shared.id,
      name: 'A · 3f9a',
      icon: '',
      collapsed: false,
      agent: { name: 'A', createdAt: 2_000 }
    })
    // The readers take a well-formed mark off a record and nothing else.
    expect(readSpaceAgentMark(records.get(own.id)?.data)).toEqual(own.agent)
    expect(readSpaceAgentMark({ agent: { kind: 'shared', stray: true } })).toEqual({
      kind: 'shared'
    })
    expect(readSpaceAgentMark({ agent: { kind: 'own', name: 'A' } })).toBeUndefined()
    expect(readSpaceAgentMark({ agent: { kind: 'theirs' } })).toBeUndefined()
    expect(readSpaceAgentMark({ agent: 'shared' })).toBeUndefined()
    expect(readSpaceAgentMark({ name: 'Agents' })).toBeUndefined()
    expect(readSpaceAgentMark(null)).toBeUndefined()
    expect(readFolderAgentMark(records.get(group.id)?.data)).toEqual({
      name: 'A',
      createdAt: 2_000
    })
    expect(readFolderAgentMark({ agent: { name: '', createdAt: 5 } })).toEqual({
      name: '',
      createdAt: 5
    })
    expect(readFolderAgentMark({ agent: { name: 'A', createdAt: 'yesterday' } })).toBeUndefined()
    expect(readFolderAgentMark({ agent: { name: 7, createdAt: 5 } })).toBeUndefined()
    expect(readFolderAgentMark({ agent: { name: 'A' } })).toBeUndefined()
    expect(readFolderAgentMark({ agent: null })).toBeUndefined()
    expect(readFolderAgentMark({})).toBeUndefined()
    expect(readFolderAgentMark(undefined)).toBeUndefined()
  })

  it('does not leak onboardingDone through the settings record', () => {
    const src = sources()
    const data = collectLocal(src, defaultScope()).get('settings')?.data as Record<string, unknown>
    expect(data).not.toHaveProperty('onboardingDone')
    expect(data).toHaveProperty('searchEngineId')
  })

  it('sends the phone menu’s order as the settings hold it – no key while none is saved, the empty list after a Reset – never a key the settings lack', () => {
    const src = sources()
    const record = (): { type: string; data: unknown } =>
      collectLocal(src, defaultScope()).get('settings')!
    const settings = (): Record<string, unknown> => record().data as Record<string, unknown>
    // A device that never touched the menu sends the record the build before this one sent: the
    // same keys, the same hash, so its first sync after the upgrade manufactures no edit.
    expect('menuOrder' in src.settings).toBe(false)
    expect(settings()).not.toHaveProperty('menuOrder')
    const untouched = hashData(settings())
    src.settings.menuOrder = ['row.settings', 'row.newTab']
    expect(settings().menuOrder).toEqual(['row.settings', 'row.newTab'])
    // A Reset stores the empty list: a value the record carries and a peer reads as the reset.
    src.settings.menuOrder = []
    expect(settings().menuOrder).toEqual([])
    expect(hashData(settings())).not.toBe(untouched)
    delete src.settings.menuOrder
    expect(settings()).not.toHaveProperty('menuOrder')
    expect(hashData(settings())).toBe(untouched)
  })

  it('keeps the device-local settings out of the settings record, every other key in (W5-F3)', () => {
    const src = sources()
    // A device that chose both ways: the record carries neither choice.
    src.settings.sidebarExpandOnHover = false
    src.settings.onboardingDone = true
    const data = collectLocal(src, defaultScope()).get('settings')?.data as Record<string, unknown>
    expect(DEVICE_LOCAL_SETTINGS).toEqual(['onboardingDone', 'sidebarExpandOnHover'])
    expect(data).not.toHaveProperty('sidebarExpandOnHover')
    expect(data).not.toHaveProperty('onboardingDone')
    const local = new Set<string>(DEVICE_LOCAL_SETTINGS)
    // Every other key, plus the retired switch mirrored beside `startup` for a release.
    expect(Object.keys(data)).toEqual([
      ...Object.keys(DEFAULT_SETTINGS).filter((key) => !local.has(key)),
      'restoreSession'
    ])
    // The helper copies: the device's own settings keep their values.
    expect(withoutDeviceLocalSettings(src.settings)).not.toBe(src.settings)
    expect(src.settings.sidebarExpandOnHover).toBe(false)
    expect(src.settings.onboardingDone).toBe(true)
  })

  it('mirrors the 0.4.x restoreSession switch beside startup for one release – on unless the mode is newTab – stamped with it as one item; a profile from before the key sends its record as it was', () => {
    const src = sources()
    const data = (): Record<string, unknown> =>
      collectLocal(src, defaultScope()).get(SETTINGS_RECORD_ID)!.data as Record<string, unknown>
    expect(src.settings).not.toHaveProperty('restoreSession')
    expect(data().startup).toEqual({ mode: 'continue', pages: [] })
    expect(data().restoreSession).toBe(true)
    src.settings.startup = { mode: 'newTab', pages: [] }
    expect(data().restoreSession).toBe(false)
    // `pages` reads as on: the phone boots it as continue.
    src.settings.startup = { mode: 'pages', pages: ['https://zen.test/'] }
    expect(data().restoreSession).toBe(true)
    // An edit of the mode stamps the switch with it: the two are one item to a peer.
    src.settings.startup = { mode: 'continue', pages: [] }
    const seeded = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const migrated = diffLocal(seeded.meta, collectLocal(src, defaultScope()), 2000)
    src.settings.startup = { mode: 'newTab', pages: [] }
    const edited = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 3000)
    const keys = edited.meta[SETTINGS_RECORD_ID]!.keys!
    expect(keys.startup!.modified).toBe(3000)
    expect(keys.restoreSession!.modified).toBe(3000)
    expect(keys.colorScheme!.modified).toBe(0)
    // The switch alone changing cannot happen: it is derived. A settings object from a build
    // before `startup` (the golden fixtures) has no mode to mirror and sends the switch it holds.
    const old = { ...src.settings, restoreSession: true } as Record<string, unknown>
    delete old.startup
    const asBefore = collectLocal(
      { ...src, settings: old as unknown as typeof src.settings },
      defaultScope()
    ).get(SETTINGS_RECORD_ID)!.data as Record<string, unknown>
    expect(asBefore.restoreSession).toBe(true)
    expect(asBefore).not.toHaveProperty('startup')
  })
})

describe('diffLocal', () => {
  it('stamps first-seen records with 0, edits with now, and keeps unchanged timestamps', () => {
    const src = sources()
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(first.changed).toBe(true)
    // First-seen records must lose against copies that already exist on other devices.
    expect(first.records.every((r) => r.modified === 0)).toBe(true)

    const again = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    expect(again.changed).toBe(false)
    expect(again.records.every((r) => r.modified === 0)).toBe(true)

    src.ids.space.name = 'Renamed'
    const third = diffLocal(again.meta, collectLocal(src, defaultScope()), 3000)
    expect(third.changed).toBe(true)
    expect(third.records.find((r) => r.id === src.ids.space.id)?.modified).toBe(3000)
    expect(third.records.find((r) => r.id === src.ids.pinned.id)?.modified).toBe(0)
  })

  it('keeps ordering in separate records so reordering never re-stamps content', () => {
    const src = sources()
    const other = createSpace('Other', '')
    src.model.spaces.push(other)
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    src.model.spaces.reverse()
    const second = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    const changedIds = second.records.filter((r) => r.modified === 2000).map((r) => r.id)
    expect(changedIds).toEqual([ORDER_SPACES])
    expect((second.records.find((r) => r.id === ORDER_SPACES)?.data as OrderData).ids).toEqual([
      other.id,
      src.ids.space.id
    ])
  })
})

describe('applyOrder', () => {
  it('orders known ids and keeps unknown ones after them', () => {
    expect(applyOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'x'])).toEqual(['c', 'a', 'b', 'd'])
    expect(applyOrder(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(applyOrder([], ['a'])).toEqual([])
  })

  it('turns vanished records into tombstones and expires old ones', () => {
    const src = sources()
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    delete src.model.tabs[src.ids.pinned.id]
    src.ids.space.tabIds = src.ids.space.tabIds.filter((id) => id !== src.ids.pinned.id)
    const second = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    const tomb = second.records.find((r) => r.id === src.ids.pinned.id)
    expect(tomb).toEqual({
      id: src.ids.pinned.id,
      type: 'tab',
      modified: 2000,
      deleted: true,
      data: null
    })
    const later = diffLocal(
      second.meta,
      collectLocal(src, defaultScope()),
      2000 + 31 * 24 * 3600 * 1000
    )
    expect(later.records.some((r) => r.id === src.ids.pinned.id)).toBe(false)
  })
})

describe('first sync merges into existing data', () => {
  it('a fresh device adopts remote singletons instead of overwriting them', () => {
    const src = sources()
    const local = diffLocal({}, collectLocal(src, defaultScope()), 5000)
    const remoteSettings: SyncRecord = {
      id: 'settings',
      type: 'settings',
      modified: 10,
      deleted: false,
      data: { searchEngineId: 'duckduckgo' }
    }
    const winners = winningRemote(local.meta, new Map([['settings', remoteSettings]]))
    expect(winners.map((r) => r.id)).toEqual(['settings'])
  })
})

describe('merge', () => {
  const rec = (
    id: string,
    modified: number,
    data: unknown = { v: id },
    deleted = false
  ): SyncRecord => ({
    id,
    type: 'space',
    modified,
    deleted,
    data
  })

  it('newestByRecord keeps the latest copy across devices', () => {
    const merged = newestByRecord([
      [rec('a', 1), rec('b', 5)],
      [rec('a', 3), rec('b', 2)]
    ])
    expect(merged.get('a')?.modified).toBe(3)
    expect(merged.get('b')?.modified).toBe(5)
  })

  it('winningRemote applies strictly newer remote records, local wins ties', () => {
    const local: MetaMap = {
      a: { type: 'space', hash: hashData({ v: 'a' }), modified: 5, deleted: false },
      b: { type: 'space', hash: hashData({ v: 'b' }), modified: 5, deleted: false },
      c: { type: 'space', hash: hashData({ v: 'c' }), modified: 5, deleted: false }
    }
    const remote = new Map<string, SyncRecord>([
      ['a', rec('a', 5, { v: 'a2' })], // tie → local wins
      ['b', rec('b', 9, { v: 'b2' })], // newer → remote wins
      ['c', rec('c', 9, { v: 'c' })], // newer but identical → skipped
      ['d', rec('d', 1)], // unknown → added
      ['e', rec('e', 1, null, true)] // unknown tombstone → ignored
    ])
    expect(winningRemote(local, remote).map((r) => r.id)).toEqual(['b', 'd'])
  })

  it('remote deletions beat older local copies and are recorded in meta', () => {
    const local: MetaMap = { a: { type: 'space', hash: 'x', modified: 1, deleted: false } }
    const winners = winningRemote(local, new Map([['a', rec('a', 2, null, true)]]))
    expect(winners).toHaveLength(1)
    expect(metaFromRemote(winners).a).toEqual({
      type: 'space',
      hash: '',
      modified: 2,
      deleted: true
    })
  })
})

/**
 * The settings record merges key by key (`SyncRecord.keys`, `RecordMeta.keys`): each top-level
 * key carries the time of its own edit, the record's `modified` is the newest of them, and the
 * wire names only the keys that are older – additive, outside `data`, so `hashData(data)` and
 * every pinned hash stand. `searchEngines`+`searchEngineId` and `newTab`+`newTabPhone` are one
 * item each (`settingsKeyGroup`).
 */
describe('the settings record, key by key', () => {
  type Json = Record<string, unknown>
  const settings = (): SyncRecord => ({
    id: SETTINGS_RECORD_ID,
    type: 'settings',
    modified: 0,
    deleted: false,
    data: {}
  })
  const record = (modified: number, data: Json, keys?: Record<string, number>): SyncRecord => ({
    ...settings(),
    modified,
    data,
    ...(keys ? { keys } : {})
  })
  const entry = (hash: string, modified: number): { hash: string; modified: number } => ({
    hash,
    modified
  })
  const meta = (modified: number, data: Json, keys?: Record<string, number>): RecordMeta => ({
    type: 'settings',
    hash: hashData(data),
    modified,
    deleted: false,
    keys: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        entry(hashData(value), keys?.[key] ?? modified)
      ])
    )
  })
  const engine = (id: string): Json => ({
    id,
    name: id,
    searchUrl: `https://${id}.test/?q=%s`,
    suggestUrl: null,
    keyword: id,
    glyph: id[0]!.toUpperCase(),
    active: true
  })

  it('settingsKeyGroup: the three pairs merge as one item each, every other key on its own', () => {
    expect(settingsKeyGroup('searchEngineId')).toBe('searchEngines')
    expect(settingsKeyGroup('searchEngines')).toBe('searchEngines')
    expect(settingsKeyGroup('newTabPhone')).toBe('newTab')
    expect(settingsKeyGroup('newTab')).toBe('newTab')
    expect(settingsKeyGroup('restoreSession')).toBe('startup')
    expect(settingsKeyGroup('startup')).toBe('startup')
    expect(settingsKeyGroup('colorScheme')).toBe('colorScheme')
  })

  it('settingsKeyTime: a key named in `keys` has its own time, any other the record’s – a record without `keys` reads as every key at its `modified`', () => {
    const r = record(30, { x: 1, y: 2 }, { y: 10 })
    expect(settingsKeyTime(r, 'x')).toBe(30)
    expect(settingsKeyTime(r, 'y')).toBe(10)
    expect(settingsKeyTime(record(30, { x: 1 }), 'x')).toBe(30)
    expect(settingsKeyTime(record(30, { x: 1 }), 'absent')).toBe(30)
  })

  it('diffLocal: first seen the record is whole at 0 and the entry has no per-key part; the next diff gives every key its entry at that time, stamps nothing and publishes no `keys`', () => {
    const src = sources()
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const firstEntry = first.meta[SETTINGS_RECORD_ID]!
    expect(firstEntry.modified).toBe(0)
    expect(firstEntry).not.toHaveProperty('keys')
    expect(first.records.find((r) => r.id === SETTINGS_RECORD_ID)).not.toHaveProperty('keys')

    const second = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    expect(second.changed).toBe(false)
    const migrated = second.meta[SETTINGS_RECORD_ID]!
    expect(migrated.modified).toBe(0)
    expect(migrated.hash).toBe(firstEntry.hash)
    const data = collectLocal(src, defaultScope()).get(SETTINGS_RECORD_ID)!.data as Json
    expect(Object.keys(migrated.keys!).sort()).toEqual(Object.keys(data).sort())
    for (const [key, value] of Object.entries(data)) {
      expect(migrated.keys![key]).toEqual(entry(hashData(value), 0))
    }
    const published = second.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(published.modified).toBe(0)
    expect(published).not.toHaveProperty('keys')
    expect(hashData(published.data)).toBe(firstEntry.hash)
    // A record whose hash stands settles on it: the per-key part is the entry's own, unhashed
    // (most commits touch no setting; the diff costs the record what it did before).
    const third = diffLocal(second.meta, collectLocal(src, defaultScope()), 3000)
    expect(third.changed).toBe(false)
    expect(third.meta[SETTINGS_RECORD_ID]!.keys).toBe(migrated.keys)
  })

  it('diffLocal: an edit stamps the key it is on and no other; the record is at its newest key with the older ones named on the wire; a change only noticed keeps the key’s time', () => {
    const src = sources()
    const seeded = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const migrated = diffLocal(seeded.meta, collectLocal(src, defaultScope()), 2000)

    src.settings.colorScheme = 'dark'
    const edited = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 3000)
    expect(edited.changed).toBe(true)
    const entryAfter = edited.meta[SETTINGS_RECORD_ID]!
    expect(entryAfter.modified).toBe(3000)
    expect(entryAfter.keys!.colorScheme).toEqual(entry(hashData('dark'), 3000))
    expect(entryAfter.keys!.sidebarWidth!.modified).toBe(0)
    const published = edited.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(published.modified).toBe(3000)
    expect(published.keys).not.toHaveProperty('colorScheme')
    const data = published.data as Json
    for (const key of Object.keys(data).filter((k) => k !== 'colorScheme')) {
      expect(published.keys![key]).toBe(0)
    }
    expect(Object.keys(published.keys!)).toHaveLength(Object.keys(data).length - 1)
    // `hashData(data)` is the same function of the same data: `keys` sits outside it.
    expect(hashData(published.data)).toBe(entryAfter.hash)

    // The round notices a change no state event carried (`stamp: null`): the key keeps its
    // time, the content goes out, the entry adopts the hash.
    src.settings.sidebarWidth = 300
    const noticed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000, {
      stamp: null
    })
    expect(noticed.changed).toBe(true)
    expect(noticed.meta[SETTINGS_RECORD_ID]!.keys!.sidebarWidth).toEqual(entry(hashData(300), 0))
    expect(noticed.meta[SETTINGS_RECORD_ID]!.modified).toBe(3000)
    const republished = noticed.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(republished.modified).toBe(3000)
    expect((republished.data as Json).sidebarWidth).toBe(300)
    expect(republished.keys!.sidebarWidth).toBe(0)
  })

  it('diffLocal: an edit of either member of a pair stamps both, and a key removed from the settings loses its entry and leaves the record – which says nothing to a peer', () => {
    const src = sources()
    const seeded = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const migrated = diffLocal(seeded.meta, collectLocal(src, defaultScope()), 2000)

    src.settings.searchEngines = [engine('kagi') as unknown as SearchEngine]
    const added = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 3000)
    expect(added.meta[SETTINGS_RECORD_ID]!.keys!.searchEngines!.modified).toBe(3000)
    expect(added.meta[SETTINGS_RECORD_ID]!.keys!.searchEngineId!.modified).toBe(3000)

    src.settings.searchEngineId = 'kagi'
    const chosen = diffLocal(added.meta, collectLocal(src, defaultScope()), 4000)
    const pair = chosen.meta[SETTINGS_RECORD_ID]!.keys!
    expect(pair.searchEngineId!.modified).toBe(4000)
    expect(pair.searchEngines!.modified).toBe(4000)
    expect(pair.colorScheme!.modified).toBe(0)
    const published = chosen.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(published.modified).toBe(4000)
    expect(published.keys).not.toHaveProperty('searchEngines')
    expect(published.keys).not.toHaveProperty('searchEngineId')

    src.settings.menuOrder = ['row.settings']
    const ordered = diffLocal(chosen.meta, collectLocal(src, defaultScope()), 5000)
    expect(ordered.meta[SETTINGS_RECORD_ID]!.keys!.menuOrder!.modified).toBe(5000)
    delete src.settings.menuOrder
    const removed = diffLocal(ordered.meta, collectLocal(src, defaultScope()), 6000)
    expect(removed.changed).toBe(true)
    expect(removed.meta[SETTINGS_RECORD_ID]!.keys).not.toHaveProperty('menuOrder')
    expect(removed.meta[SETTINGS_RECORD_ID]!.modified).toBe(4000)
    const without = removed.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(without.data).not.toHaveProperty('menuOrder')
    expect(without.modified).toBe(4000)
    // A peer that holds the key keeps it, and this device takes the peer's copy back when it
    // is offered: a removal has no time to speak with (the Reset travels as `[]`).
    const peers = winningRemote(
      removed.meta,
      new Map([[SETTINGS_RECORD_ID, record(7, { menuOrder: ['row.settings'] })]])
    )
    expect(peers).toHaveLength(1)
    expect(peers[0]!.data).toEqual({ menuOrder: ['row.settings'] })
  })

  it('newestByRecord: the devices’ settings records merge key by key – each pair or key from the device whose copy is newest, ties to the first read, the record at the newest of them', () => {
    const merged = newestByRecord([
      [record(30, { x: 'a', y: 'a', z: 'a' }, { y: 10, z: 30 })],
      [record(20, { x: 'b', y: 'b', z: 'b' }, { x: 5, z: 30 })]
    ]).get(SETTINGS_RECORD_ID)!
    expect(merged.data).toEqual({ x: 'a', y: 'b', z: 'a' })
    expect(merged.modified).toBe(30)
    expect(merged.keys).toEqual({ y: 20 })

    // A pair travels from one device: the newer default brings that device's list, whatever
    // the list's own time.
    const pair = newestByRecord([
      [record(50, { searchEngines: [engine('a')], searchEngineId: 'a' }, { searchEngines: 5 })],
      [record(40, { searchEngines: [engine('b')], searchEngineId: 'b' })]
    ]).get(SETTINGS_RECORD_ID)!
    expect(pair.data).toEqual({ searchEngines: [engine('a')], searchEngineId: 'a' })
    expect(pair.modified).toBe(50)
    expect(pair.keys).toEqual({ searchEngines: 5 })

    // A single live record is taken as it is; a tombstone counts only when there is nothing else.
    const alone = record(9, { x: 1 }, { x: 9 })
    expect(
      newestByRecord([[alone], [{ ...settings(), modified: 99, deleted: true, data: null }]]).get(
        SETTINGS_RECORD_ID
      )
    ).toBe(alone)
    expect(
      newestByRecord([
        [{ ...settings(), modified: 1, deleted: true, data: null }],
        [{ ...settings(), modified: 2, deleted: true, data: null }]
      ]).get(SETTINGS_RECORD_ID)?.modified
    ).toBe(2)
    // Every other record is one copy per id, newest wins, as before.
    const space: SyncRecord = {
      id: 's',
      type: 'space',
      modified: 3,
      deleted: false,
      data: { v: 1 }
    }
    expect(newestByRecord([[{ ...space, modified: 1 }], [space]]).get('s')).toBe(space)
  })

  it('winningRemote: against a per-key entry, a peer’s key wins when strictly newer and different, and the winner is the record narrowed to the keys that won', () => {
    const local: MetaMap = {
      [SETTINGS_RECORD_ID]: meta(10, { x: 'x1', y: 'y1', z: 'z1' })
    }
    const remote = record(20, { x: 'x2', y: 'y1', z: 'z2', w: 'w1' }, { z: 5, y: 20 })
    const winners = winningRemote(local, new Map([[SETTINGS_RECORD_ID, remote]]))
    expect(winners).toHaveLength(1)
    // x: newer and different – won. y: newer but the same value – nothing to apply. z: older –
    // the local copy stands. w: a key this device holds nothing of – taken.
    expect(winners[0]).toEqual({ ...settings(), modified: 20, data: { x: 'x2', w: 'w1' } })
    // A tie keeps the local copy, as it always has per record.
    expect(winningRemote(local, new Map([[SETTINGS_RECORD_ID, record(10, { x: 'x2' })]]))).toEqual(
      []
    )
    expect(winningRemote(local, new Map([[SETTINGS_RECORD_ID, record(11, { x: 'x2' })]]))).toEqual([
      { ...settings(), modified: 11, data: { x: 'x2' } }
    ])
    // The narrowed record keeps each key's own time.
    const older = winningRemote(
      local,
      new Map([[SETTINGS_RECORD_ID, record(30, { x: 'x2', y: 'y2' }, { y: 12 })]])
    )
    expect(older).toEqual([
      { ...settings(), modified: 30, data: { x: 'x2', y: 'y2' }, keys: { y: 12 } }
    ])
  })

  it('winningRemote: a pair wins or loses whole – its newest member against this device’s – and a peer’s record without `keys` is judged at its `modified` for every key', () => {
    const local: MetaMap = {
      [SETTINGS_RECORD_ID]: meta(
        10,
        { searchEngines: [engine('a')], searchEngineId: 'a', colorScheme: 'dark' },
        { searchEngines: 10, searchEngineId: 10, colorScheme: 40 }
      )
    }
    // The peer's default is newer than this device's pair: list and default land together,
    // though the peer's list itself is older than this device's.
    const later = winningRemote(
      local,
      new Map([
        [
          SETTINGS_RECORD_ID,
          record(
            20,
            { searchEngines: [engine('b')], searchEngineId: 'b', colorScheme: 'light' },
            { searchEngines: 5, colorScheme: 20 }
          )
        ]
      ])
    )
    expect(later).toEqual([
      {
        ...settings(),
        modified: 20,
        data: { searchEngines: [engine('b')], searchEngineId: 'b' },
        keys: { searchEngines: 5 }
      }
    ])
    // The pair's newest member decides for both: a newer list brings an older default with it,
    // and a pair no newer than this device's loses whole.
    const listNewer = record(
      15,
      { searchEngines: [engine('b')], searchEngineId: 'b' },
      { searchEngineId: 5 }
    )
    expect(winningRemote(local, new Map([[SETTINGS_RECORD_ID, listNewer]]))).toEqual([listNewer])
    expect(
      winningRemote(
        local,
        new Map([
          [
            SETTINGS_RECORD_ID,
            record(10, { searchEngines: [engine('b')], searchEngineId: 'b' }, { searchEngineId: 5 })
          ]
        ])
      )
    ).toEqual([])
    // A record from a build before per-key merge names no `keys`: every key is at its
    // `modified`, so a newer record brings each key of it that differs.
    const legacy = record(50, {
      searchEngines: [engine('b')],
      searchEngineId: 'b',
      colorScheme: 'dark'
    })
    expect(winningRemote(local, new Map([[SETTINGS_RECORD_ID, legacy]]))).toEqual([
      {
        ...settings(),
        modified: 50,
        data: { searchEngines: [engine('b')], searchEngineId: 'b' }
      }
    ])
  })

  it('winningRemote: an entry without per-key part – a metadata from before, a record first seen at the last diff – judges the record whole, as every record always was', () => {
    const before: MetaMap = {
      [SETTINGS_RECORD_ID]: {
        type: 'settings',
        hash: hashData({ x: 'x1' }),
        modified: 10,
        deleted: false
      }
    }
    const newer = record(20, { x: 'x2', y: 'y1' }, { y: 3 })
    expect(winningRemote(before, new Map([[SETTINGS_RECORD_ID, newer]]))).toEqual([newer])
    expect(winningRemote(before, new Map([[SETTINGS_RECORD_ID, record(10, { x: 'x2' })]]))).toEqual(
      []
    )
    expect(winningRemote(before, new Map([[SETTINGS_RECORD_ID, record(20, { x: 'x1' })]]))).toEqual(
      []
    )
    // A tombstone is weighed against the record whole, per-key entries or not.
    const tomb: SyncRecord = { ...settings(), modified: 99, deleted: true, data: null }
    expect(
      winningRemote(
        { [SETTINGS_RECORD_ID]: meta(10, { x: 1 }) },
        new Map([[SETTINGS_RECORD_ID, tomb]])
      )
    ).toEqual([tomb])
  })

  it('winningRemote: a device-local key an older build still sends never wins – this device holds no entry for it, so it would be "newer" every round and land nothing – and never enters the per-key metadata', () => {
    const local: MetaMap = { [SETTINGS_RECORD_ID]: meta(10, { colorScheme: 'light' }) }
    for (const key of DEVICE_LOCAL_SETTINGS) {
      const stray = record(20, { colorScheme: 'light', [key]: true })
      expect(winningRemote(local, new Map([[SETTINGS_RECORD_ID, stray]]))).toEqual([])
      // Alongside a real edit the edit wins alone; the stray key is left out of the winner.
      const edited = record(20, { colorScheme: 'dark', [key]: true })
      const won = winningRemote(local, new Map([[SETTINGS_RECORD_ID, edited]]))
      expect(won).toHaveLength(1)
      expect(won[0]!.data).toEqual({ colorScheme: 'dark' })
      // A record that won whole (no per-key entry here) gets an entry per key but that one.
      const fresh = metaFromRemote([edited])[SETTINGS_RECORD_ID]!
      expect(fresh.keys).toEqual({ colorScheme: entry(hashData('dark'), 20) })
    }
  })

  it('metaFromRemote: the settings winner is a set of keys – this device’s entry with those keys at the peer’s times – or every key of the record when there was no per-key entry', () => {
    const local: MetaMap = { [SETTINGS_RECORD_ID]: meta(10, { x: 'x1', y: 'y1', z: 'z1' }) }
    const won = record(20, { x: 'x2', w: 'w1' }, { w: 15 })
    const merged = metaFromRemote([won], local)[SETTINGS_RECORD_ID]!
    expect(merged.modified).toBe(20)
    expect(merged.deleted).toBe(false)
    expect(merged.keys).toEqual({
      x: entry(hashData('x2'), 20),
      y: entry(hashData('y1'), 10),
      z: entry(hashData('z1'), 10),
      w: entry(hashData('w1'), 15)
    })
    const fresh = metaFromRemote([won])[SETTINGS_RECORD_ID]!
    expect(fresh.keys).toEqual({ x: entry(hashData('x2'), 20), w: entry(hashData('w1'), 15) })
    expect(fresh.modified).toBe(20)
    // Any other record's entry is as it was.
    const space: SyncRecord = {
      id: 's',
      type: 'space',
      modified: 3,
      deleted: false,
      data: { v: 1 }
    }
    expect(metaFromRemote([space], local).s).toEqual({
      type: 'space',
      hash: hashData({ v: 1 }),
      modified: 3,
      deleted: false
    })
  })

  it('winningRemote: across a rename, an old peer’s retired key is weighed against this device’s successor as one item – a device holding `startup` alone is not an unheld group the switch beats once per value', () => {
    const NEWTAB = { mode: 'newTab', pages: [] }
    // This device on the new build, the mirror already off: `startup` alone, edited at 10.
    const alone: MetaMap = { [SETTINGS_RECORD_ID]: meta(10, { startup: NEWTAB, x: 'x1' }) }
    // The peer's older switch loses: nothing lands, the meta is untouched.
    expect(
      winningRemote(alone, new Map([[SETTINGS_RECORD_ID, record(5, { restoreSession: true })]]))
    ).toEqual([])
    expect(
      winningRemote(alone, new Map([[SETTINGS_RECORD_ID, record(10, { restoreSession: true })]]))
    ).toEqual([])
    // The peer's later flip wins, as the switch alone: `apply` folds it.
    expect(
      winningRemote(alone, new Map([[SETTINGS_RECORD_ID, record(20, { restoreSession: true })]]))
    ).toEqual([{ ...settings(), modified: 20, data: { restoreSession: true } }])
    // With the mirror on (this device sends both, stamped together), the same three answers –
    // and a peer's switch that says what this device's already says has nothing to apply.
    const mirrored: MetaMap = {
      [SETTINGS_RECORD_ID]: meta(10, { startup: NEWTAB, restoreSession: false, x: 'x1' })
    }
    expect(
      winningRemote(mirrored, new Map([[SETTINGS_RECORD_ID, record(5, { restoreSession: true })]]))
    ).toEqual([])
    expect(
      winningRemote(mirrored, new Map([[SETTINGS_RECORD_ID, record(20, { restoreSession: true })]]))
    ).toEqual([{ ...settings(), modified: 20, data: { restoreSession: true } }])
    expect(
      winningRemote(
        mirrored,
        new Map([[SETTINGS_RECORD_ID, record(20, { restoreSession: false })]])
      )
    ).toEqual([])
    // A new peer carries both: the pair wins or loses whole, `startup` preferred at apply.
    const both = record(20, {
      startup: { mode: 'pages', pages: ['https://p.test/'] },
      restoreSession: true
    })
    expect(winningRemote(mirrored, new Map([[SETTINGS_RECORD_ID, both]]))).toEqual([both])
    // The same rule for the older rename: a 0.3.x phone's `newTabPhone` against `newTab`.
    const desk: MetaMap = { [SETTINGS_RECORD_ID]: meta(10, { newTab: { enabled: true } }) }
    expect(
      winningRemote(desk, new Map([[SETTINGS_RECORD_ID, record(5, { newTabPhone: { a: 1 } })]]))
    ).toEqual([])
    expect(
      winningRemote(desk, new Map([[SETTINGS_RECORD_ID, record(11, { newTabPhone: { a: 1 } })]]))
    ).toEqual([{ ...settings(), modified: 11, data: { newTabPhone: { a: 1 } } }])
  })

  it('seedSettingsMeta: a key the entry did not know inherits the newest time of its group siblings – `startup` the retired switch’s – so an old peer’s older switch cannot revert this device’s later choice', () => {
    const YESTERDAY = 1_000_000
    const TWO_WEEKS_AGO = YESTERDAY - 13 * 24 * 60 * 60 * 1000
    const NEWTAB = { mode: 'newTab', pages: [] }
    // The desktop flipped its switch off yesterday, on the old build; the phone flipped its
    // own on two weeks ago and the desktop had pulled nothing since (a tie at 0 elsewhere).
    const before = meta(0, { restoreSession: false, x: 'x1' }, { restoreSession: YESTERDAY, x: 0 })
    // Upgrade: the boot folds the switch into `startup`, the record carries it and the mirror.
    const seeded = seedSettingsMeta(before, { startup: NEWTAB, restoreSession: false, x: 'x1' })
    expect(seeded.keys).toEqual({
      startup: entry(hashData(NEWTAB), YESTERDAY),
      restoreSession: entry(hashData(false), YESTERDAY),
      x: entry(hashData('x1'), 0)
    })
    expect(seeded.modified).toBe(0)
    // The phone's two-week-old flip meets the group at yesterday: the desktop's choice stands.
    const phone = record(TWO_WEEKS_AGO, { restoreSession: true, x: 'x1' })
    expect(
      winningRemote({ [SETTINGS_RECORD_ID]: seeded }, new Map([[SETTINGS_RECORD_ID, phone]]))
    ).toEqual([])
    // A flip the phone makes after the desktop's is newer and wins, as it should.
    const later = record(YESTERDAY + 1, { restoreSession: true, x: 'x1' })
    expect(
      winningRemote({ [SETTINGS_RECORD_ID]: seeded }, new Map([[SETTINGS_RECORD_ID, later]]))
    ).toEqual([{ ...settings(), modified: YESTERDAY + 1, data: { restoreSession: true } }])
    // Without the mirror the successor alone carries the time; a key without siblings is at 0.
    const bare = seedSettingsMeta(before, { startup: NEWTAB, x: 'x1', fresh: 1 })
    expect(bare.keys).toEqual({
      startup: entry(hashData(NEWTAB), YESTERDAY),
      x: entry(hashData('x1'), 0),
      fresh: entry(hashData(1), 0)
    })
    // The seed never raises the group's time: `searchEngineId` new beside `searchEngines` at 7
    // takes 7, what the group was at already.
    const pair = seedSettingsMeta(meta(0, { searchEngines: [] }, { searchEngines: 7 }), {
      searchEngines: [],
      searchEngineId: 'a'
    })
    expect(pair.keys).toEqual({
      searchEngines: entry(hashData([]), 7),
      searchEngineId: entry(hashData('a'), 7)
    })
  })

  it('seedSettingsMeta: an entry from before gains every key at the record’s time; one with keys adopts a changed value at the key’s time, a new key at 0, drops a gone key, and is returned itself when nothing differs', () => {
    const before: RecordMeta = {
      type: 'settings',
      hash: 'as-the-previous-build-wrote-it',
      modified: 10,
      deleted: false
    }
    const migrated = seedSettingsMeta(before, { x: 'x1', y: 'y1' })
    expect(migrated).toEqual({
      type: 'settings',
      hash: hashData({ x: 'x1', y: 'y1' }),
      modified: 10,
      deleted: false,
      keys: { x: entry(hashData('x1'), 10), y: entry(hashData('y1'), 10) }
    })
    expect(seedSettingsMeta(migrated, { x: 'x1', y: 'y1' })).toBe(migrated)
    const upgraded = seedSettingsMeta(migrated, { x: 'x1', y: 'y2', added: 'on' })
    expect(upgraded.modified).toBe(10)
    expect(upgraded.hash).toBe(hashData({ x: 'x1', y: 'y2', added: 'on' }))
    expect(upgraded.keys).toEqual({
      x: entry(hashData('x1'), 10),
      y: entry(hashData('y2'), 10),
      added: entry(hashData('on'), 0)
    })
    const dropped = seedSettingsMeta(migrated, { x: 'x1' })
    expect(dropped.keys).toEqual({ x: entry(hashData('x1'), 10) })
    expect(dropped.modified).toBe(10)
  })
})

describe('bookmark records', () => {
  function tree(): { nodes: BookmarkNode[]; folder: BookmarkNode; leaf: BookmarkNode } {
    const folder: BookmarkNode = {
      id: 'bm_folder',
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      type: 'folder',
      title: 'Work',
      dateAdded: 10,
      dateGroupModified: 20
    }
    const leaf: BookmarkNode = {
      id: 'bm_leaf',
      parentId: 'bm_folder',
      index: 0,
      type: 'url',
      title: 'Docs',
      url: 'https://docs.test/',
      favicon: 'data:image/png;base64,AAAA',
      dateAdded: 15,
      dateLastUsed: 30
    }
    return { nodes: [...createBookmarkRoots(1), folder, leaf], folder, leaf }
  }

  it('collectLocal emits one record per node with its position and never the roots', () => {
    const src = sources()
    const t = tree()
    src.bookmarks = t.nodes
    const records = collectLocal(src, defaultScope())
    for (const id of BOOKMARK_ROOT_IDS) expect(records.has(id)).toBe(false)
    expect(records.get('bm_folder')).toEqual({
      type: 'bookmark',
      data: { parentId: BOOKMARKS_BAR_ID, index: 0, type: 'folder', title: 'Work', dateAdded: 10 }
    })
    expect(records.get('bm_leaf')).toEqual({
      type: 'bookmark',
      data: {
        parentId: 'bm_folder',
        index: 0,
        type: 'url',
        title: 'Docs',
        url: 'https://docs.test/',
        favicon: 'data:image/png;base64,AAAA',
        dateAdded: 15
      }
    })
    // Device-local usage is not part of the record, so opening a bookmark never re-stamps it.
    expect(records.get('bm_leaf')?.data).not.toHaveProperty('dateLastUsed')
    expect(records.get('bm_folder')?.data).not.toHaveProperty('dateGroupModified')
  })

  it('a move changes only the moved node, and the scope can turn bookmarks off', () => {
    const src = sources()
    const t = tree()
    src.bookmarks = t.nodes
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    t.leaf.parentId = OTHER_BOOKMARKS_ID
    t.leaf.index = 3
    const second = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    const changed = second.records.filter((r) => r.modified === 2000).map((r) => r.id)
    expect(changed).toEqual(['bm_leaf'])
    expect((second.records.find((r) => r.id === 'bm_leaf')?.data as BookmarkData).index).toBe(3)
    expect(collectLocal(src, { ...defaultScope(), bookmarks: false }).has('bm_leaf')).toBe(false)
  })

  it('readBookmarkData accepts tree records and repairs missing fields', () => {
    expect(
      readBookmarkData({ parentId: 'p', index: 2, type: 'folder', title: 'F', dateAdded: 5 })
    ).toEqual({ parentId: 'p', index: 2, type: 'folder', title: 'F', dateAdded: 5 })
    const url = readBookmarkData({
      parentId: 'p',
      type: 'url',
      url: 'https://a.test/',
      favicon: '',
      index: Number.NaN
    })
    expect(url?.title).toBe('https://a.test/')
    expect(url?.index).toBe(Number.MAX_SAFE_INTEGER)
    expect(url).not.toHaveProperty('favicon')
    expect(typeof url?.dateAdded).toBe('number')
    // A url node without a url is garbage.
    expect(readBookmarkData({ parentId: 'p', index: 0, type: 'url', title: 'x' })).toBeNull()
    expect(readBookmarkData({ parentId: 'p', index: 0, type: 'weird' })).toBeNull()
    expect(readBookmarkData(null)).toBeNull()
    expect(readBookmarkData('nope')).toBeNull()
  })

  it('readBookmarkData lands flat records from pre-tree devices in Other bookmarks', () => {
    const legacy = readBookmarkData({
      url: 'https://old.test/',
      title: 'Old',
      favicon: 'data:x',
      createdAt: 42
    })
    expect(legacy).toEqual({
      parentId: OTHER_BOOKMARKS_ID,
      index: Number.MAX_SAFE_INTEGER,
      type: 'url',
      title: 'Old',
      url: 'https://old.test/',
      favicon: 'data:x',
      dateAdded: 42
    })
    expect(readBookmarkData({ url: 'https://old.test/', title: '', favicon: null })?.title).toBe(
      'https://old.test/'
    )
    expect(readBookmarkData({ url: '', title: 'Empty' })).toBeNull()
  })

  it('per-node last-writer-wins: a newer remote move beats the local copy of that node only', () => {
    const src = sources()
    const t = tree()
    src.bookmarks = t.nodes
    const local = diffLocal({}, collectLocal(src, defaultScope()), 5000)
    const remoteLeaf: SyncRecord = {
      id: 'bm_leaf',
      type: 'bookmark',
      modified: 6000,
      deleted: false,
      data: { ...(local.records.find((r) => r.id === 'bm_leaf')?.data as BookmarkData), index: 1 }
    }
    const remoteFolder: SyncRecord = {
      id: 'bm_folder',
      type: 'bookmark',
      modified: 6000,
      deleted: false,
      data: local.records.find((r) => r.id === 'bm_folder')?.data
    }
    const winners = winningRemote(
      local.meta,
      new Map([
        ['bm_leaf', remoteLeaf],
        ['bm_folder', remoteFolder]
      ])
    )
    expect(winners.map((r) => r.id)).toEqual(['bm_leaf'])
  })
})

describe('credential records (ID-09)', () => {
  const login = {
    id: 'cred_login1',
    origin: 'https://example.com',
    url: 'https://example.com/login',
    username: 'ada',
    password: 's3cret',
    realm: null,
    notes: '',
    createdAt: 100,
    updatedAt: 200,
    lastUsedAt: null,
    ...emptyLeakFields()
  }
  const passkey = {
    id: 'passkey_1',
    rpId: 'example.com',
    rpName: 'Example',
    userName: 'ada',
    userDisplayName: 'Ada',
    credentialId: 'cred-1',
    origin: 'https://example.com',
    createdAt: 300,
    lastUsedAt: 400
  }

  it('collectLocal emits one record per login and per passkey, under the store ids', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [passkey] }
    const out = collectLocal(src, defaultScope())
    expect(out.get('cred_login1')).toEqual({
      type: 'credential',
      data: {
        kind: 'login',
        origin: 'https://example.com',
        url: 'https://example.com/login',
        username: 'ada',
        password: 's3cret',
        realm: null,
        notes: '',
        createdAt: 100,
        updatedAt: 200,
        lastUsedAt: null
      }
    })
    expect(out.get('passkey_1')).toEqual({
      type: 'credential',
      data: {
        kind: 'passkey',
        rpId: 'example.com',
        rpName: 'Example',
        userName: 'ada',
        userDisplayName: 'Ada',
        credentialId: 'cred-1',
        origin: 'https://example.com',
        createdAt: 300,
        lastUsedAt: 400
      }
    })
    // The passkey's record carries no key material: there is none in the store to carry.
    expect(Object.keys(out.get('passkey_1')!.data as object)).not.toContain('privateKey')
  })

  it('the passwords toggle (default on) and a locked vault leave credentials out', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [passkey] }
    expect(defaultScope().passwords).toBe(true)
    expect(collectLocal(src, { ...defaultScope(), passwords: false }).has('cred_login1')).toBe(
      false
    )
    src.credentials = null
    expect(collectLocal(src, defaultScope()).has('cred_login1')).toBe(false)
    delete src.credentials
    expect(collectLocal(src, defaultScope()).has('cred_login1')).toBe(false)
  })

  it('publishes the site-data policy as its own settings-scope record, gated with the settings', () => {
    const src = sources()
    const siteData = {
      blockAll: false,
      allow: ['[*.]ok.example'],
      clearOnExit: [],
      block: ['never.example']
    }
    expect(collectLocal(src, defaultScope()).has('site-data')).toBe(false)
    const records = collectLocal({ ...src, siteData }, defaultScope())
    expect(records.get('site-data')).toEqual({ type: 'site-data', data: siteData })
    expect(
      collectLocal({ ...src, siteData }, { ...defaultScope(), settings: false }).has('site-data')
    ).toBe(false)
    const record: SyncRecord = {
      id: 'site-data',
      type: 'site-data',
      modified: 1,
      deleted: false,
      data: siteData
    }
    expect(inScope(record, defaultScope())).toBe(true)
    expect(inScope(record, { ...defaultScope(), settings: false })).toBe(false)
  })

  it('inScope gates credential records on the passwords toggle both ways', () => {
    const record: SyncRecord = {
      id: 'cred_login1',
      type: 'credential',
      modified: 1,
      deleted: false,
      data: { kind: 'login' }
    }
    expect(inScope(record, defaultScope())).toBe(true)
    expect(inScope(record, { ...defaultScope(), passwords: false })).toBe(false)
    expect(
      inScope({ ...record, deleted: true, data: null }, { ...defaultScope(), passwords: false })
    ).toBe(false)
  })

  it('carries a login\u2019s breach memory and note as additive fields: absent when unset, read back when present', () => {
    const src = sources()
    const flagged = {
      ...login,
      id: 'cred_login2',
      notes: 'the recovery codes are in the safe',
      breached: 12,
      checkedAt: 1_000,
      leakWarnedAt: 1_000,
      leakIgnoredAt: 2_000
    }
    src.credentials = { logins: [login, flagged], passkeys: [] }
    const out = collectLocal(src, defaultScope())
    // An unflagged login's record has none of the fields, so it hashes as it did before they existed.
    expect(Object.keys(out.get('cred_login1')!.data as object)).toEqual([
      'kind',
      'origin',
      'url',
      'username',
      'password',
      'realm',
      'notes',
      'createdAt',
      'updatedAt',
      'lastUsedAt'
    ])
    expect(out.get('cred_login2')!.data).toMatchObject({
      notes: 'the recovery codes are in the safe',
      breached: 12,
      checkedAt: 1_000,
      leakWarnedAt: 1_000,
      leakIgnoredAt: 2_000
    })
    // A reader on this build takes the fields along; one without them (an older device) reads
    // the rest of the record as before, and its own records lack them.
    expect(readCredentialData(out.get('cred_login2')!.data)).toMatchObject({
      breached: 12,
      checkedAt: 1_000,
      leakWarnedAt: 1_000,
      leakIgnoredAt: 2_000
    })
    const plain = readCredentialData(out.get('cred_login1')!.data)!
    expect('breached' in plain).toBe(false)
    expect(
      readCredentialData({
        kind: 'login',
        origin: 'https://a.example',
        password: 'x',
        breached: 'many'
      })
    ).not.toHaveProperty('breached')
  })

  it('readCredentialData accepts both kinds, repairs missing fields and rejects garbage', () => {
    expect(
      readCredentialData({ kind: 'login', origin: 'https://a.example', password: 'x' })
    ).toEqual({
      kind: 'login',
      origin: 'https://a.example',
      url: '',
      username: '',
      password: 'x',
      realm: null,
      notes: '',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null
    })
    expect(readCredentialData({ kind: 'passkey', rpId: 'a.example', lastUsedAt: 5 })).toMatchObject(
      {
        kind: 'passkey',
        rpId: 'a.example',
        credentialId: '',
        lastUsedAt: 5
      }
    )
    expect(readCredentialData({ kind: 'login', origin: 'https://a.example' })).toBeNull()
    expect(readCredentialData({ kind: 'passkey' })).toBeNull()
    expect(readCredentialData({ kind: 'totp', secret: 'x' })).toBeNull()
    expect(readCredentialData(null)).toBeNull()
    expect(readCredentialData('login')).toBeNull()
  })

  it('merges by id, last writer wins per entry, deletions travel as tombstones', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [] }
    const local = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const remoteNewer: SyncRecord = {
      id: 'cred_login1',
      type: 'credential',
      modified: 2000,
      deleted: false,
      data: {
        ...(local.records.find((r) => r.id === 'cred_login1')!.data as object),
        password: 'new'
      }
    }
    const remoteOther: SyncRecord = {
      id: 'cred_login2',
      type: 'credential',
      modified: 5,
      deleted: false,
      data: { kind: 'login', origin: 'https://b.example', password: 'y' }
    }
    const remoteGone: SyncRecord = {
      id: 'cred_login3',
      type: 'credential',
      modified: 5,
      deleted: true,
      data: null
    }
    const winners = winningRemote(
      local.meta,
      newestByRecord([[remoteNewer, remoteOther, remoteGone], [{ ...remoteNewer, modified: 1500 }]])
    )
    expect(winners.map((r) => r.id).sort()).toEqual(['cred_login1', 'cred_login2'])
    expect(
      (winners.find((r) => r.id === 'cred_login1')!.data as { password: string }).password
    ).toBe('new')
    // A local edit later than the remote copy wins the tie-break by time, not by device.
    src.credentials = { logins: [{ ...login, password: 'mine', updatedAt: 3000 }], passkeys: [] }
    const edited = diffLocal(local.meta, collectLocal(src, defaultScope()), 3000)
    expect(edited.meta.cred_login1.modified).toBe(3000)
    expect(winningRemote(edited.meta, new Map([['cred_login1', remoteNewer]]))).toEqual([])
    // Deleting locally produces a tombstone that beats the remote copy.
    src.credentials = { logins: [], passkeys: [] }
    const removed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000)
    expect(removed.records.find((r) => r.id === 'cred_login1')).toMatchObject({
      type: 'credential',
      deleted: true,
      modified: 4000
    })
  })

  it('frozenRecords: toggling passwords off or locking the vault never tombstones an entry', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [passkey] }
    const on = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(on.meta.cred_login1).toBeDefined()

    const off = { ...defaultScope(), passwords: false }
    const held = diffLocal(on.meta, collectLocal(src, off), 2000, {
      stamp: 2000,
      frozen: frozenRecords(src, off, on.meta)
    })
    expect(held.changed).toBe(false)
    expect(held.meta.cred_login1).toEqual(on.meta.cred_login1)
    expect(held.meta.passkey_1).toEqual(on.meta.passkey_1)
    expect(held.records.some((r) => r.type === 'credential')).toBe(false)

    src.credentials = null
    const locked = diffLocal(on.meta, collectLocal(src, defaultScope()), 3000, {
      stamp: 3000,
      frozen: frozenRecords(src, defaultScope(), on.meta)
    })
    expect(locked.changed).toBe(false)
    expect(locked.meta.cred_login1).toEqual(on.meta.cred_login1)
    expect(locked.records.some((r) => r.type === 'credential')).toBe(false)

    // Without the freeze the same absence would be a deletion – the guard is what keeps it out.
    const naive = diffLocal(on.meta, collectLocal(src, defaultScope()), 3000)
    expect(naive.records.find((r) => r.id === 'cred_login1')?.deleted).toBe(true)
  })

  it('hashes credential data key-order independently like every other record', () => {
    const a = hashData({ kind: 'login', origin: 'o', password: 'p' })
    const b = hashData({ password: 'p', origin: 'o', kind: 'login' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
  })
})
