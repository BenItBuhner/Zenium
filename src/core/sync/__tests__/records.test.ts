import { describe, expect, it } from 'vitest'
import {
  DEVICE_LOCAL_SETTINGS,
  ORDER_SPACES,
  SETTINGS_RECORD_ID,
  addressData,
  applyOrder,
  collectLocal,
  defaultScope,
  diffLocal,
  extensionDeclineStands,
  extensionRecordData,
  extensionRecordReadable,
  extensionStoreOf,
  frozenRecords,
  fullScope,
  hashData,
  inScope,
  isVaultRecordType,
  metaFromRemote,
  modData,
  newestByRecord,
  paymentMethodData,
  pendingExtensionRequests,
  readAddressData,
  readBookmarkData,
  readCredentialData,
  readExtensionData,
  readFolderAgentMark,
  readModData,
  readPaymentMethodData,
  readReadingListData,
  readSpaceAgentMark,
  readingListEntryData,
  seedSettingsMeta,
  settingsKeyGroup,
  settingsKeyTime,
  stableStringify,
  syncedExtensionData,
  vaultRecordReadable,
  winningRemote,
  wireFavicon,
  withoutDeviceLocalSettings,
  type BookmarkData,
  type ExtensionSyncSource,
  type MetaMap,
  type OrderData,
  type RecordMeta,
  type RecordType,
  type SyncRecord,
  type TabData
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
import { MAX_MOD_CSS, UNTITLED_MOD } from '../../../shared/mods'
import type {
  AddressEntry,
  BookmarkNode,
  Mod,
  PaymentCard,
  ReadingListEntry,
  SearchEngine,
  Space,
  SyncScope,
  Tab
} from '../../../shared/types'
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

  it('keeps the device-local settings out of the settings record, every other key in (W5-F3, W8-2)', () => {
    const src = sources()
    // A device that chose both ways, and answered the choice screen: the record carries none.
    src.settings.sidebarExpandOnHover = false
    src.settings.onboardingDone = true
    src.settings.searchChoice = { engineId: 'duckduckgo', region: 'DE', madeAt: 1, version: 1 }
    // …and took the OS accent (W8-3): this machine's OS, so the record carries none of it.
    src.settings.useSystemAccent = true
    // A laptop that turned Energy Saver off and set Memory Saver to Balanced: the desktop and
    // the phone beside it keep their own answers, as Chrome's battery_saver_mode.state and
    // high_efficiency_mode.{state,aggressiveness} are local state (W8-2).
    src.settings.energySaver = 'off'
    src.settings.unloadEnabled = false
    src.settings.unloadTimeoutMinutes = 240
    // The touchpad swipe's Accessibility switch: Chrome's twin pref is Android-only and unsynced.
    src.settings.touchpadSwipeToNavigate = false
    // …and turned the hover card's memory line on (W8-10; off by default): Chrome's
    // browser.hovercard.memory_usage_enabled is local state too.
    src.settings.hoverCardMemoryUsage = true
    // …and last deleted all time from the Delete browsing data dialog (services pass 13, seed
    // #20): Chrome's browser.clear_data.time_period stopped syncing in CL 5398105 ("[CBD] Make
    // options not syncable"), so the range the dialog opens on is this device's alone.
    src.settings.clearBrowsingDataRange = 'all'
    const data = collectLocal(src, defaultScope()).get('settings')?.data as Record<string, unknown>
    expect(DEVICE_LOCAL_SETTINGS).toEqual([
      'onboardingDone',
      'sidebarExpandOnHover',
      'searchChoice',
      'useSystemAccent',
      'energySaver',
      'unloadEnabled',
      'unloadTimeoutMinutes',
      'touchpadSwipeToNavigate',
      'hoverCardMemoryUsage',
      'bookmarkRowSortOrder',
      'bookmarkRowDisplay',
      'iph',
      'clearBrowsingDataRange'
    ])
    expect(data).not.toHaveProperty('clearBrowsingDataRange')
    expect(data).not.toHaveProperty('sidebarExpandOnHover')
    expect(data).not.toHaveProperty('onboardingDone')
    expect(data).not.toHaveProperty('searchChoice')
    expect(data).not.toHaveProperty('useSystemAccent')
    expect(data).not.toHaveProperty('energySaver')
    expect(data).not.toHaveProperty('unloadEnabled')
    expect(data).not.toHaveProperty('unloadTimeoutMinutes')
    expect(data).not.toHaveProperty('touchpadSwipeToNavigate')
    expect(data).not.toHaveProperty('hoverCardMemoryUsage')
    // The hint bubbles' records stay on the phone that showed them (TB-19).
    expect(data).not.toHaveProperty('iph')
    // The keep-active hosts travel, as Chrome syncs tab_discarding.exceptions.
    expect(data).toHaveProperty('unloadExcludedDomains')
    // The Home pin syncs with the rest of the pins, as Chrome's `show_home_button` does.
    src.settings.toolbarPins = { home: true }
    expect(
      (collectLocal(src, defaultScope()).get('settings')?.data as Record<string, unknown>)
        .toolbarPins
    ).toEqual({ home: true })
    const local = new Set<string>(DEVICE_LOCAL_SETTINGS)
    // Every other key, and no key the settings lack (the retired `restoreSession` mirror is gone).
    expect(Object.keys(data)).toEqual(
      Object.keys(DEFAULT_SETTINGS).filter((key) => !local.has(key))
    )
    // The helper copies: the device's own settings keep their values.
    expect(withoutDeviceLocalSettings(src.settings)).not.toBe(src.settings)
    expect(src.settings.sidebarExpandOnHover).toBe(false)
    expect(src.settings.onboardingDone).toBe(true)
    expect(src.settings.energySaver).toBe('off')
    expect(src.settings.unloadEnabled).toBe(false)
    expect(src.settings.unloadTimeoutMinutes).toBe(240)
    expect(src.settings.touchpadSwipeToNavigate).toBe(false)
    expect(src.settings.clearBrowsingDataRange).toBe('all')
  })

  it('an edit of Memory Saver’s mode or timer, or of Energy Saver, stamps nothing – the per-key metadata holds no entry for a device-local key, and the record is unchanged by the edit (W8-2)', () => {
    const src = sources()
    // First seen, then diffed once unchanged: the entry gains its per-key part.
    const seeded = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const known = diffLocal(seeded.meta, collectLocal(src, defaultScope()), 1500)
    const keys = known.meta[SETTINGS_RECORD_ID]!.keys!
    for (const key of DEVICE_LOCAL_SETTINGS) expect(keys).not.toHaveProperty(key)
    expect(keys).toHaveProperty('unloadExcludedDomains')
    // The tier, the switch and the mode change on this device: no record changes, no key is
    // stamped – the choice stays here. The hosts list is an edit like any other.
    src.settings.unloadTimeoutMinutes = 120
    src.settings.unloadEnabled = false
    src.settings.energySaver = 'low-battery'
    const after = diffLocal(known.meta, collectLocal(src, defaultScope()), 2000)
    expect(after.changed).toBe(false)
    expect(after.meta[SETTINGS_RECORD_ID]!.modified).toBe(known.meta[SETTINGS_RECORD_ID]!.modified)
    expect(after.meta[SETTINGS_RECORD_ID]!.keys).toEqual(keys)
    src.settings.unloadExcludedDomains = ['zen.test']
    const hosts = diffLocal(after.meta, collectLocal(src, defaultScope()), 3000)
    expect(hosts.changed).toBe(true)
    expect(hosts.meta[SETTINGS_RECORD_ID]!.keys!.unloadExcludedDomains!.modified).toBe(3000)
    expect(hosts.meta[SETTINGS_RECORD_ID]!.keys).not.toHaveProperty('unloadTimeoutMinutes')
  })

  it('publishes startup alone – the 0.4.x restoreSession switch mirrored beside it for one release is retired – whatever the mode; an edit of the mode stamps startup and no other key; a profile from before the key sends its record as it was', () => {
    const src = sources()
    const data = (): Record<string, unknown> =>
      collectLocal(src, defaultScope()).get(SETTINGS_RECORD_ID)!.data as Record<string, unknown>
    expect(src.settings).not.toHaveProperty('restoreSession')
    expect(data().startup).toEqual({ mode: 'continue', pages: [] })
    expect(data()).not.toHaveProperty('restoreSession')
    src.settings.startup = { mode: 'newTab', pages: [] }
    expect(data()).not.toHaveProperty('restoreSession')
    src.settings.startup = { mode: 'pages', pages: ['https://zen.test/'] }
    expect(data()).not.toHaveProperty('restoreSession')
    // An edit of the mode stamps `startup` – the group of the retired switch – and nothing else.
    src.settings.startup = { mode: 'continue', pages: [] }
    const seeded = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const migrated = diffLocal(seeded.meta, collectLocal(src, defaultScope()), 2000)
    src.settings.startup = { mode: 'newTab', pages: [] }
    const edited = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 3000)
    const keys = edited.meta[SETTINGS_RECORD_ID]!.keys!
    expect(keys.startup!.modified).toBe(3000)
    expect(keys).not.toHaveProperty('restoreSession')
    expect(keys.colorScheme!.modified).toBe(0)
    // A settings object from a build before `startup` (the golden fixtures) holds the switch
    // itself and sends the record its build sent, switch and all: nothing is added or taken.
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

  it('the retired mirror leaving this device’s record at the upgrade is no edit of startup: diffLocal stamps nothing, the record goes out without the key at its old times, and the round’s mode is the same', () => {
    const src = sources()
    src.settings.startup = { mode: 'newTab', pages: [] }
    // The metadata the mirroring build left: `startup` and the switch stamped together at 3000
    // (one item), every other key at 0 – and the record hash of the data WITH the switch.
    const withMirror = collectLocal(src, defaultScope())
    const mirrored = withMirror.get(SETTINGS_RECORD_ID)!.data as Record<string, unknown>
    withMirror.set(SETTINGS_RECORD_ID, {
      type: 'settings',
      data: { ...mirrored, restoreSession: false }
    })
    const seeded = diffLocal({}, withMirror, 1000)
    const migrated = diffLocal(seeded.meta, withMirror, 2000)
    const before = migrated.meta[SETTINGS_RECORD_ID]!
    before.keys!.startup!.modified = 3000
    before.keys!.restoreSession!.modified = 3000
    before.modified = 3000
    // This build's first diff, in the subscriber's mode (stamped `now`): the switch is gone,
    // `startup` keeps 3000 – not 9000 – and the record leaves at 3000 without the key.
    const upgraded = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 9000)
    expect(upgraded.changed).toBe(true)
    const keys = upgraded.meta[SETTINGS_RECORD_ID]!.keys!
    expect(keys.startup).toEqual(entry(hashData({ mode: 'newTab', pages: [] }), 3000))
    expect(keys).not.toHaveProperty('restoreSession')
    expect(keys.colorScheme!.modified).toBe(0)
    expect(upgraded.meta[SETTINGS_RECORD_ID]!.modified).toBe(3000)
    const published = upgraded.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(published.modified).toBe(3000)
    expect(published.data).not.toHaveProperty('restoreSession')
    expect(published.keys).not.toHaveProperty('startup')
    // The round's mode (`stamp: null`) reads the same, and the diff after it is quiet.
    const noticed = diffLocal(migrated.meta, collectLocal(src, defaultScope()), 9000, {
      stamp: null
    })
    expect(noticed.meta[SETTINGS_RECORD_ID]!.keys!.startup!.modified).toBe(3000)
    expect(noticed.meta[SETTINGS_RECORD_ID]!.keys).not.toHaveProperty('restoreSession')
    const quiet = diffLocal(upgraded.meta, collectLocal(src, defaultScope()), 9500)
    expect(quiet.changed).toBe(false)
    // A key the user removes still stamps its group (the `menuOrder` rule is untouched): only a
    // RETIRED key leaves without a word.
    const peerless = diffLocal(upgraded.meta, collectLocal(src, defaultScope()), 9600)
    src.settings.searchEngines = [engine('kagi') as unknown as SearchEngine]
    const added = diffLocal(peerless.meta, collectLocal(src, defaultScope()), 9700)
    expect(added.meta[SETTINGS_RECORD_ID]!.keys!.searchEngineId!.modified).toBe(9700)
  })

  it('an old peer’s switch that won once does not win every round after the retirement: the successor inherits the retired key’s time when it leaves at the re-snapshot (and at the boot seed)', () => {
    const NEWTAB = { mode: 'newTab', pages: [] }
    const CONTINUE = { mode: 'continue', pages: [] }
    // This device's `startup` at 10; the phone (a 0.4.x build) flipped its switch on at 20.
    const mine: MetaMap = { [SETTINGS_RECORD_ID]: meta(10, { startup: NEWTAB, x: 'x1' }) }
    const phone = record(20, { restoreSession: true, x: 'x1' })
    const won = winningRemote(mine, new Map([[SETTINGS_RECORD_ID, phone]]))
    expect(won).toEqual([{ ...settings(), modified: 20, data: { restoreSession: true } }])
    // The apply folds the switch into `startup`; the entry holds the switch at the peer's 20.
    const merged: MetaMap = { ...mine, ...metaFromRemote(won, mine) }
    expect(merged[SETTINGS_RECORD_ID]!.keys!.restoreSession!.modified).toBe(20)
    // The re-snapshot (`stamp: null`): this build publishes no switch, so it leaves the entry –
    // and `startup`, folded to the phone's choice, stands at 20, the group's time, not at 10.
    const after = diffLocal(
      merged,
      new Map([[SETTINGS_RECORD_ID, { type: 'settings', data: { startup: CONTINUE, x: 'x1' } }]]),
      30,
      { stamp: null }
    )
    const keys = after.meta[SETTINGS_RECORD_ID]!.keys!
    expect(keys.startup).toEqual(entry(hashData(CONTINUE), 20))
    expect(keys).not.toHaveProperty('restoreSession')
    expect(keys.x!.modified).toBe(10)
    // Next round: the phone's same switch at 20 has nothing newer to say – no second win.
    expect(winningRemote(after.meta, new Map([[SETTINGS_RECORD_ID, phone]]))).toEqual([])
    // A later flip on the phone still wins, as it should.
    const later = record(21, { restoreSession: false, x: 'x1' })
    expect(winningRemote(after.meta, new Map([[SETTINGS_RECORD_ID, later]]))).toEqual([
      { ...settings(), modified: 21, data: { restoreSession: false } }
    ])
    // The boot seed reads the departure the same way: a metadata that still holds the switch at
    // 20 beside `startup` at 10 (the mirroring build's) seeds `startup` at 20 when the switch
    // is gone from the build's record – and never raises the group above what it was.
    const closed = meta(
      20,
      { startup: CONTINUE, restoreSession: true, x: 'x1' },
      {
        startup: 10,
        restoreSession: 20,
        x: 10
      }
    )
    const seeded = seedSettingsMeta(closed, { startup: CONTINUE, x: 'x1' })
    expect(seeded.keys).toEqual({
      startup: entry(hashData(CONTINUE), 20),
      x: entry(hashData('x1'), 10)
    })
    expect(seeded.modified).toBe(20)
    expect(
      winningRemote({ [SETTINGS_RECORD_ID]: seeded }, new Map([[SETTINGS_RECORD_ID, phone]]))
    ).toEqual([])
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
    // The leaf's `data:` icon is the bytes: it stays home (`wireFavicon`), the record carries
    // the node without it.
    expect(records.get('bm_leaf')).toEqual({
      type: 'bookmark',
      data: {
        parentId: 'bm_folder',
        index: 0,
        type: 'url',
        title: 'Docs',
        url: 'https://docs.test/',
        dateAdded: 15
      }
    })
    // Device-local usage is not part of the record, so opening a bookmark never re-stamps it.
    expect(records.get('bm_leaf')?.data).not.toHaveProperty('dateLastUsed')
    expect(records.get('bm_folder')?.data).not.toHaveProperty('dateGroupModified')
  })

  describe('what a favicon may carry across the boundary (services pass 11, the wire rule)', () => {
    it('wireFavicon lets an http(s) address through and nothing else', () => {
      expect(wireFavicon('https://docs.test/favicon.ico')).toBe('https://docs.test/favicon.ico')
      expect(wireFavicon('HTTP://Docs.Test/icon.png')).toBe('HTTP://Docs.Test/icon.png')
      // The bytes never travel; the receiver caches its own.
      expect(wireFavicon('data:image/png;base64,AAAA')).toBeUndefined()
      // A host-local address is no use to a peer.
      expect(wireFavicon('zen://favicon/abcdef0123456789')).toBeUndefined()
      expect(wireFavicon('file:///home/me/icon.png')).toBeUndefined()
      expect(wireFavicon('chrome://favicon/https://a.test/')).toBeUndefined()
      expect(wireFavicon('about:blank')).toBeUndefined()
      expect(wireFavicon('blob:https://a.test/0f3e')).toBeUndefined()
      expect(wireFavicon('https:not-an-address')).toBeUndefined()
      expect(wireFavicon('')).toBeUndefined()
      expect(wireFavicon(null)).toBeUndefined()
      expect(wireFavicon(undefined)).toBeUndefined()
    })

    it('a bookmark record carries an http(s) icon address and never a data: or host-local one', () => {
      const src = sources()
      const t = tree()
      const addressed: BookmarkNode = {
        ...t.leaf,
        id: 'bm_addressed',
        index: 1,
        url: 'https://addressed.test/',
        favicon: 'https://addressed.test/favicon.ico'
      }
      const cached: BookmarkNode = {
        ...t.leaf,
        id: 'bm_cached',
        index: 2,
        url: 'https://cached.test/',
        favicon: 'zen://favicon/0123456789abcdef0123456789abcdef01234567'
      }
      src.bookmarks = [...t.nodes, addressed, cached]
      const records = collectLocal(src, defaultScope())
      expect((records.get('bm_addressed')?.data as BookmarkData).favicon).toBe(
        'https://addressed.test/favicon.ico'
      )
      expect(records.get('bm_leaf')?.data).not.toHaveProperty('favicon')
      expect(records.get('bm_cached')?.data).not.toHaveProperty('favicon')
    })

    it("a tab record's favicon is the address or null (the field's shape stands)", () => {
      const src = sources()
      const m = src.model
      const space = m.spaces[0]
      const addressed = createTabRecord({
        id: 'tab_addressed',
        spaceId: space.id,
        containerId: space.containerId,
        url: 'https://addressed.test/',
        favicon: 'https://addressed.test/favicon.ico',
        pinned: true
      })
      const inline = createTabRecord({
        id: 'tab_inline',
        spaceId: space.id,
        containerId: space.containerId,
        url: 'https://inline.test/',
        favicon: 'data:image/png;base64,AAAA',
        pinned: true
      })
      m.tabs[addressed.id] = addressed
      m.tabs[inline.id] = inline
      insertTabIntoSpace(m, space, addressed)
      insertTabIntoSpace(m, space, inline)
      const records = collectLocal(src, defaultScope())
      expect((records.get('tab_addressed')?.data as TabData).favicon).toBe(
        'https://addressed.test/favicon.ico'
      )
      expect((records.get('tab_inline')?.data as TabData).favicon).toBeNull()
    })

    it('the same icon in two forms hashes the same record: the cache keeping an inline icon (data: → zen://favicon/<hash>) is no edit of the bookmark', () => {
      const src = sources()
      const t = tree()
      src.bookmarks = t.nodes
      const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
      t.leaf.favicon = 'zen://favicon/0123456789abcdef0123456789abcdef01234567'
      const second = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
      expect(second.changed).toBe(false)
      expect(second.records.find((r) => r.id === 'bm_leaf')?.modified).toBe(0)
      // The icon gone altogether is the same record still.
      delete t.leaf.favicon
      const third = diffLocal(second.meta, collectLocal(src, defaultScope()), 3000)
      expect(third.changed).toBe(false)
    })

    it("a record from a peer's build that still sends a data: or host-local icon reads without it", () => {
      const inline = readBookmarkData({
        parentId: 'p',
        index: 0,
        type: 'url',
        title: 'A',
        url: 'https://a.test/',
        favicon: 'data:image/png;base64,AAAA',
        dateAdded: 5
      })
      expect(inline).not.toHaveProperty('favicon')
      const cached = readBookmarkData({
        parentId: 'p',
        index: 0,
        type: 'url',
        title: 'A',
        url: 'https://a.test/',
        favicon: 'zen://favicon/0123456789abcdef0123456789abcdef01234567',
        dateAdded: 5
      })
      expect(cached).not.toHaveProperty('favicon')
      const addressed = readBookmarkData({
        parentId: 'p',
        index: 0,
        type: 'url',
        title: 'A',
        url: 'https://a.test/',
        favicon: 'https://a.test/favicon.ico',
        dateAdded: 5
      })
      expect(addressed?.favicon).toBe('https://a.test/favicon.ico')
      // A pre-tree device's flat record, the same.
      expect(
        readBookmarkData({
          url: 'https://a.test/',
          title: 'A',
          favicon: 'data:image/png;base64,AAAA',
          createdAt: 5
        })
      ).not.toHaveProperty('favicon')
    })
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
    // A pre-tree device sent its icon as it held it; the bytes of a `data:` one stay out here
    // as everywhere (`wireFavicon`), an address comes through.
    const legacy = readBookmarkData({
      url: 'https://old.test/',
      title: 'Old',
      favicon: 'https://old.test/favicon.ico',
      createdAt: 42
    })
    expect(legacy).toEqual({
      parentId: OTHER_BOOKMARKS_ID,
      index: Number.MAX_SAFE_INTEGER,
      type: 'url',
      title: 'Old',
      url: 'https://old.test/',
      favicon: 'https://old.test/favicon.ico',
      dateAdded: 42
    })
    expect(
      readBookmarkData({ url: 'https://old.test/', title: 'Old', favicon: 'data:x', createdAt: 42 })
    ).not.toHaveProperty('favicon')
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

/**
 * The vault's addresses and payment cards (services pass 16, ID-45; the lead's ruling on #712):
 * one `address` record per address and one `payment-method` record per card, each under the
 * vault's id with the vault's fields, each type under a scope key of its own – `addresses`,
 * `paymentMethods` – and the logins' rules otherwise: published while the vault is open, held
 * while it is locked, merged by entry, deleted by tombstone. Their own record types, so a peer
 * on a build before them drops the records at `inScope` like every additive type
 * (`compat.test.ts`) instead of tombstoning a `credential` record it could not read; and this
 * build skips a vault record it cannot read the same way (`vaultRecordReadable`).
 */
describe('address and payment-method records (services pass 16, ID-45)', () => {
  const login = {
    id: 'login_1',
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
  const address: AddressEntry = {
    id: 'address_1',
    country: 'GB',
    name: 'Ada Lovelace',
    organization: 'Analytical Engines Ltd',
    streetAddress: '12 St James\u2019s Square\nFlat 3',
    locality: 'London',
    region: '',
    postalCode: 'SW1Y 4JH',
    sortingCode: '',
    phone: '+44 20 7946 0958',
    email: 'ada@example.com',
    createdAt: 300,
    updatedAt: 400,
    lastUsedAt: 450
  }
  const card: PaymentCard = {
    id: 'card_1',
    number: '4111111111111111',
    expMonth: 12,
    expYear: 2031,
    name: 'Ada Lovelace',
    nickname: 'Work Visa',
    createdAt: 500,
    updatedAt: 600,
    lastUsedAt: null
  }
  /** The vault types a scope publishes from `src`, sorted. */
  const vaultTypes = (src: Fixture, scope: SyncScope): RecordType[] =>
    [...collectLocal(src, scope).values()]
      .map((r) => r.type)
      .filter((t) => isVaultRecordType(t))
      .sort()

  it('collectLocal emits one address record per address and one payment-method record per card, the vault\u2019s fields under the vault\u2019s ids', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [], addresses: [address], cards: [card] }
    const out = collectLocal(src, defaultScope())
    expect(out.get('address_1')).toEqual({
      type: 'address',
      data: {
        country: 'GB',
        name: 'Ada Lovelace',
        organization: 'Analytical Engines Ltd',
        streetAddress: '12 St James\u2019s Square\nFlat 3',
        locality: 'London',
        region: '',
        postalCode: 'SW1Y 4JH',
        sortingCode: '',
        phone: '+44 20 7946 0958',
        email: 'ada@example.com',
        createdAt: 300,
        updatedAt: 400,
        lastUsedAt: 450
      }
    })
    // The card's number as the vault keeps it (the full digits): the wire carries exactly what
    // the vault holds, inside the folder's end-to-end envelope, and no security code exists.
    expect(out.get('card_1')).toEqual({
      type: 'payment-method',
      data: {
        number: '4111111111111111',
        expMonth: 12,
        expYear: 2031,
        name: 'Ada Lovelace',
        nickname: 'Work Visa',
        createdAt: 500,
        updatedAt: 600,
        lastUsedAt: null
      }
    })
    expect(Object.keys(out.get('card_1')!.data as object)).not.toContain('cvc')
    // The type says what the record is: neither payload carries a `kind`.
    expect(out.get('address_1')!.data).not.toHaveProperty('kind')
    expect(out.get('card_1')!.data).not.toHaveProperty('kind')
    // The wire's key order is the builders': what a device publishes hashes the same everywhere.
    expect(Object.keys(out.get('address_1')!.data as object)).toEqual(
      Object.keys(addressData(address))
    )
    expect(Object.keys(out.get('card_1')!.data as object)).toEqual(
      Object.keys(paymentMethodData(card))
    )
    // The login beside them is what it always was.
    expect(out.get('login_1')).toMatchObject({ type: 'credential', data: { kind: 'login' } })
  })

  it('each key gates its own type: Addresses on and Payment methods off publishes the addresses alone, the reverse the cards alone, and Passwords gates neither', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [], addresses: [address], cards: [card] }
    expect(vaultTypes(src, defaultScope())).toEqual(['address', 'credential', 'payment-method'])
    expect(vaultTypes(src, { ...defaultScope(), paymentMethods: false })).toEqual([
      'address',
      'credential'
    ])
    expect(vaultTypes(src, { ...defaultScope(), addresses: false })).toEqual([
      'credential',
      'payment-method'
    ])
    expect(vaultTypes(src, { ...defaultScope(), addresses: false, paymentMethods: false })).toEqual(
      ['credential']
    )
    // Passwords off keeps the logins home and nothing else: the two types have keys of their own.
    expect(vaultTypes(src, { ...defaultScope(), passwords: false })).toEqual([
      'address',
      'payment-method'
    ])
    // A locked vault (no sources) publishes none of the three; a caller handing the shape from
    // before the fields (logins and passkeys alone) publishes its logins and neither new type.
    src.credentials = null
    expect(vaultTypes(src, fullScope())).toEqual([])
    src.credentials = { logins: [login], passkeys: [] }
    expect(vaultTypes(src, fullScope())).toEqual(['credential'])
  })

  it('inScope gates each type on its own key both ways, tombstones included, and says nothing for a scope object from before the keys', () => {
    const addressRecord: SyncRecord = {
      id: 'address_1',
      type: 'address',
      modified: 1,
      deleted: false,
      data: addressData(address)
    }
    const cardRecord: SyncRecord = {
      id: 'card_1',
      type: 'payment-method',
      modified: 1,
      deleted: false,
      data: paymentMethodData(card)
    }
    expect(inScope(addressRecord, defaultScope())).toBe(true)
    expect(inScope(cardRecord, defaultScope())).toBe(true)
    expect(inScope(addressRecord, { ...defaultScope(), addresses: false })).toBe(false)
    expect(inScope(cardRecord, { ...defaultScope(), addresses: false })).toBe(true)
    expect(inScope(cardRecord, { ...defaultScope(), paymentMethods: false })).toBe(false)
    expect(inScope(addressRecord, { ...defaultScope(), paymentMethods: false })).toBe(true)
    expect(inScope(addressRecord, { ...defaultScope(), passwords: false })).toBe(true)
    expect(inScope(cardRecord, { ...defaultScope(), passwords: false })).toBe(true)
    expect(
      inScope(
        { ...addressRecord, deleted: true, data: null },
        { ...defaultScope(), addresses: false }
      )
    ).toBe(false)
    expect(
      inScope(
        { ...cardRecord, deleted: true, data: null },
        { ...defaultScope(), paymentMethods: false }
      )
    ).toBe(false)
    // A scope object persisted by a build before the keys says nothing for either type – the
    // older peer drops the records (`compat.test.ts`); this build completes the object with the
    // defaults at load, both on, as it did for `readingList` and `mods` (`engine.ts`).
    const before = { ...defaultScope() } as Partial<SyncScope>
    delete before.addresses
    delete before.paymentMethods
    expect(inScope(addressRecord, before as SyncScope)).toBeFalsy()
    expect(inScope(cardRecord, before as SyncScope)).toBeFalsy()
    expect(defaultScope()).toMatchObject({ addresses: true, paymentMethods: true })
    expect(fullScope()).toMatchObject({ addresses: true, paymentMethods: true })
    expect(isVaultRecordType('address')).toBe(true)
    expect(isVaultRecordType('payment-method')).toBe(true)
    expect(isVaultRecordType('credential')).toBe(true)
    expect(isVaultRecordType('bookmark')).toBe(false)
  })

  it('readAddressData and readPaymentMethodData round-trip the builders\u2019 payloads, repair missing fields, and are null for garbage or a card without a number', () => {
    expect(readAddressData(addressData(address))).toEqual(addressData(address))
    expect(readPaymentMethodData(paymentMethodData(card))).toEqual(paymentMethodData(card))
    // What lands re-collects to the received bytes (the engine re-snapshots right after
    // applying and must find nothing to stamp).
    expect(hashData(readAddressData(addressData(address)))).toBe(hashData(addressData(address)))
    expect(hashData(readPaymentMethodData(paymentMethodData(card)))).toBe(
      hashData(paymentMethodData(card))
    )
    expect(readAddressData({ country: 'FR', name: 'Ada' })).toEqual({
      country: 'FR',
      name: 'Ada',
      organization: '',
      streetAddress: '',
      locality: '',
      region: '',
      postalCode: '',
      sortingCode: '',
      phone: '',
      email: '',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null
    })
    expect(readPaymentMethodData({ number: '4111111111111111', expMonth: '12' })).toEqual({
      number: '4111111111111111',
      expMonth: 0,
      expYear: 0,
      name: '',
      nickname: '',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null
    })
    // A field neither type has (a `kind`, say) is not read: the type says what the record is.
    expect(readAddressData({ kind: 'address', country: 'DE' })).not.toHaveProperty('kind')
    expect(readPaymentMethodData({ kind: 'card', number: '4111' })).not.toHaveProperty('kind')
    // A card without a digit in its number is no card, as a login without a password is no login.
    expect(readPaymentMethodData({ name: 'Ada' })).toBeNull()
    expect(readPaymentMethodData({ number: 'none' })).toBeNull()
    for (const garbage of [null, undefined, 'address', 12, [], [{ country: 'GB' }]]) {
      expect(readAddressData(garbage)).toBeNull()
      expect(readPaymentMethodData(garbage)).toBeNull()
    }
  })

  it('vaultRecordReadable: a tombstone or a payload the reader takes is a winner, a payload the build does not read is not, on each of the three vault types', () => {
    const live = (type: RecordType, data: unknown): SyncRecord => ({
      id: 'x',
      type,
      modified: 1,
      deleted: false,
      data
    })
    expect(vaultRecordReadable(live('address', addressData(address)))).toBe(true)
    expect(vaultRecordReadable(live('address', { country: 'DE' }))).toBe(true)
    expect(vaultRecordReadable(live('address', null))).toBe(false)
    expect(vaultRecordReadable(live('address', 'GB'))).toBe(false)
    expect(vaultRecordReadable({ ...live('address', null), deleted: true })).toBe(true)
    expect(vaultRecordReadable(live('payment-method', paymentMethodData(card)))).toBe(true)
    expect(vaultRecordReadable(live('payment-method', { name: 'Ada' }))).toBe(false)
    expect(vaultRecordReadable(live('payment-method', { iban: 'GB33BUKB20201555555555' }))).toBe(
      false
    )
    expect(vaultRecordReadable({ ...live('payment-method', null), deleted: true })).toBe(true)
    expect(
      vaultRecordReadable(
        live('credential', { kind: 'login', origin: 'https://a.example', password: 'x' })
      )
    ).toBe(true)
    expect(vaultRecordReadable(live('credential', { kind: 'totp', secret: 'x' }))).toBe(false)
    expect(vaultRecordReadable({ ...live('credential', null), deleted: true })).toBe(true)
    // Not a vault type: the reader has nothing to say, the scope filter alone decides.
    expect(vaultRecordReadable(live('bookmark', { anything: true }))).toBe(true)
  })

  it('merges by id, last writer wins per entry, deletions travel as tombstones – the logins\u2019 rules', () => {
    const src = sources()
    src.credentials = { logins: [], passkeys: [], addresses: [address], cards: [card] }
    const local = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(local.meta.address_1).toMatchObject({ type: 'address', modified: 0 })
    expect(local.meta.card_1).toMatchObject({ type: 'payment-method', modified: 0 })
    const remoteNewer: SyncRecord = {
      id: 'card_1',
      type: 'payment-method',
      modified: 2000,
      deleted: false,
      data: { ...paymentMethodData(card), nickname: 'Personal Visa', updatedAt: 2000 }
    }
    const remoteOther: SyncRecord = {
      id: 'address_2',
      type: 'address',
      modified: 5,
      deleted: false,
      data: { country: 'DE', locality: 'Berlin' }
    }
    const remoteGone: SyncRecord = {
      id: 'address_3',
      type: 'address',
      modified: 5,
      deleted: true,
      data: null
    }
    const winners = winningRemote(
      local.meta,
      newestByRecord([[remoteNewer, remoteOther, remoteGone], [{ ...remoteNewer, modified: 1500 }]])
    )
    expect(winners.map((r) => r.id).sort()).toEqual(['address_2', 'card_1'])
    expect((winners.find((r) => r.id === 'card_1')!.data as { nickname: string }).nickname).toBe(
      'Personal Visa'
    )
    // A local edit later than the remote copy wins the tie-break by time, not by device.
    src.credentials = {
      logins: [],
      passkeys: [],
      addresses: [address],
      cards: [{ ...card, nickname: 'Mine', updatedAt: 3000 }]
    }
    const edited = diffLocal(local.meta, collectLocal(src, defaultScope()), 3000)
    expect(edited.meta.card_1.modified).toBe(3000)
    expect(winningRemote(edited.meta, new Map([['card_1', remoteNewer]]))).toEqual([])
    // Deleting locally produces a tombstone that beats the remote copy.
    src.credentials = { logins: [], passkeys: [], addresses: [address], cards: [] }
    const removed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000)
    expect(removed.records.find((r) => r.id === 'card_1')).toMatchObject({
      type: 'payment-method',
      deleted: true,
      modified: 4000
    })
    expect(removed.meta.address_1.deleted).toBe(false)
  })

  it('frozenRecords: turning a key off or locking the vault never tombstones its type, and one key off leaves the other type publishing', () => {
    const src = sources()
    src.credentials = { logins: [login], passkeys: [], addresses: [address], cards: [card] }
    const on = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    // Addresses off: the address held as it was, the card and the login published as before.
    const noAddresses = { ...defaultScope(), addresses: false }
    const heldAddresses = diffLocal(on.meta, collectLocal(src, noAddresses), 2000, {
      stamp: 2000,
      frozen: frozenRecords(src, noAddresses, on.meta)
    })
    expect(heldAddresses.changed).toBe(false)
    expect(heldAddresses.meta.address_1).toEqual(on.meta.address_1)
    expect(heldAddresses.meta.card_1).toEqual(on.meta.card_1)
    expect(heldAddresses.records.some((r) => r.type === 'address')).toBe(false)
    expect(heldAddresses.records.find((r) => r.id === 'card_1')).toMatchObject({
      type: 'payment-method',
      deleted: false
    })
    expect(heldAddresses.records.find((r) => r.id === 'login_1')).toMatchObject({
      type: 'credential',
      deleted: false
    })
    // Payment methods off: the reverse.
    const noCards = { ...defaultScope(), paymentMethods: false }
    const heldCards = diffLocal(on.meta, collectLocal(src, noCards), 2000, {
      stamp: 2000,
      frozen: frozenRecords(src, noCards, on.meta)
    })
    expect(heldCards.changed).toBe(false)
    expect(heldCards.meta.card_1).toEqual(on.meta.card_1)
    expect(heldCards.records.some((r) => r.type === 'payment-method')).toBe(false)
    expect(heldCards.records.find((r) => r.id === 'address_1')).toMatchObject({
      type: 'address',
      deleted: false
    })
    // The vault locked: all three types held.
    src.credentials = null
    const locked = diffLocal(on.meta, collectLocal(src, defaultScope()), 3000, {
      stamp: 3000,
      frozen: frozenRecords(src, defaultScope(), on.meta)
    })
    expect(locked.changed).toBe(false)
    expect(locked.meta.address_1).toEqual(on.meta.address_1)
    expect(locked.meta.card_1).toEqual(on.meta.card_1)
    expect(locked.records.some((r) => isVaultRecordType(r.type))).toBe(false)
    // Without the freeze the same absence would be a deletion – the guard is what keeps it out.
    const naive = diffLocal(on.meta, collectLocal(src, defaultScope()), 3000)
    expect(naive.records.find((r) => r.id === 'address_1')?.deleted).toBe(true)
    expect(naive.records.find((r) => r.id === 'card_1')?.deleted).toBe(true)
  })

  it('the metadata of a peer\u2019s vault record this build cannot read is never written, so the record is never tombstoned', () => {
    // The round as the engine runs it (`SyncEngine.run`): the winners against this device's
    // metadata, the scope filter, then the vault filter. Left out, the record is not applied and
    // not in the metadata, and the re-snapshot after applying has nothing to tombstone – where
    // a `credential` kind the build did not read, taken as a winner, was tombstoned by the same
    // re-snapshot (the reason the entries have types of their own, and the reader's null).
    const src = sources()
    src.credentials = { logins: [login], passkeys: [], addresses: [], cards: [] }
    const mine = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const later: SyncRecord = {
      id: 'iban_1',
      type: 'credential',
      modified: 2000,
      deleted: false,
      data: { kind: 'iban', iban: 'GB33BUKB20201555555555' }
    }
    const unreadable: SyncRecord = {
      id: 'card_9',
      type: 'payment-method',
      modified: 2000,
      deleted: false,
      data: { nickname: 'No number' }
    }
    const theirs: SyncRecord = {
      id: 'address_9',
      type: 'address',
      modified: 2000,
      deleted: false,
      data: addressData({ ...address, id: 'address_9' })
    }
    const scope = defaultScope()
    const winners = winningRemote(mine.meta, newestByRecord([[later, unreadable, theirs]])).filter(
      (r) => inScope(r, scope) && vaultRecordReadable(r)
    )
    expect(winners.map((r) => r.id)).toEqual(['address_9'])
    const merged: MetaMap = { ...mine.meta, ...metaFromRemote(winners, mine.meta) }
    expect(Object.keys(merged)).not.toContain('iban_1')
    expect(Object.keys(merged)).not.toContain('card_9')
    // Landed: the address is in the local set now; the other two are not, and were never known.
    src.credentials.addresses = [{ ...address, id: 'address_9' }]
    const after = diffLocal(merged, collectLocal(src, scope), 2001, { stamp: null })
    expect(after.records.find((r) => r.id === 'iban_1')).toBeUndefined()
    expect(after.records.find((r) => r.id === 'card_9')).toBeUndefined()
    expect(after.records.find((r) => r.id === 'address_9')).toMatchObject({
      type: 'address',
      deleted: false,
      modified: 2000
    })
    // The counter-example, kept as the pin of the fault: the same records taken as winners
    // without the vault filter are tombstoned at the re-snapshot.
    const naive: MetaMap = {
      ...mine.meta,
      ...metaFromRemote([later, unreadable, theirs], mine.meta)
    }
    const tombstoned = diffLocal(naive, collectLocal(src, scope), 2001, { stamp: null })
    expect(tombstoned.records.find((r) => r.id === 'iban_1')).toMatchObject({ deleted: true })
    expect(tombstoned.records.find((r) => r.id === 'card_9')).toMatchObject({ deleted: true })
  })
})

/**
 * The reading list's record (services pass 11, ID-48; the interface doc §3 in the engine's
 * terms): one `reading-list-entry` per entry under the entry's id, the six fields and never the
 * favicon; the `readingList` scope; the engine's stamp the clock and its tombstones the
 * deletions; the apply side's sanitiser idempotent.
 */
describe('reading-list records (services pass 11, ID-48)', () => {
  const unread: ReadingListEntry = {
    id: 'rl_a',
    url: 'https://a.example/article',
    title: 'Article A',
    addedAt: 1000,
    updatedAt: 1000,
    favicon: 'data:image/png;base64,AAAA'
  }
  const read: ReadingListEntry = {
    id: 'rl_b',
    url: 'https://b.example/',
    title: 'B',
    addedAt: 500,
    updatedAt: 800,
    readAt: 800
  }

  it('collectLocal emits one record per entry under its id: the six fields in the normal form’s order, `readAt` only while read, never the favicon', () => {
    const src = { ...sources(), readingList: [unread, read] }
    const out = collectLocal(src, defaultScope())
    expect(out.get('rl_a')).toEqual({
      type: 'reading-list-entry',
      data: {
        id: 'rl_a',
        url: 'https://a.example/article',
        title: 'Article A',
        addedAt: 1000,
        updatedAt: 1000
      }
    })
    expect(Object.keys(out.get('rl_a')!.data as object)).toEqual([
      'id',
      'url',
      'title',
      'addedAt',
      'updatedAt'
    ])
    expect(out.get('rl_a')!.data).not.toHaveProperty('favicon')
    expect(out.get('rl_b')).toEqual({
      type: 'reading-list-entry',
      data: {
        id: 'rl_b',
        url: 'https://b.example/',
        title: 'B',
        addedAt: 500,
        updatedAt: 800,
        readAt: 800
      }
    })
    // `readingListEntryData` is the payload, and `readAt` absent serialises as absence – the
    // hash tells an unread entry from a read one and nothing else.
    expect(readingListEntryData(unread)).toEqual(out.get('rl_a')!.data)
    expect(JSON.stringify(readingListEntryData(unread))).not.toContain('readAt')
    expect(hashData(readingListEntryData(unread))).not.toBe(
      hashData(readingListEntryData({ ...unread, readAt: 1000 }))
    )
    // The favicon is the device's own: two devices holding different icons hash the same record.
    expect(hashData(readingListEntryData({ ...unread, favicon: 'data:,other' }))).toBe(
      hashData(readingListEntryData(unread))
    )
  })

  it('the readingList toggle (default on, as the bookmarks’) gates the type both ways, and a source or a scope from before the type publishes none', () => {
    expect(defaultScope().readingList).toBe(true)
    const src = { ...sources(), readingList: [unread, read] }
    const off = { ...defaultScope(), readingList: false }
    expect([...collectLocal(src, off).values()].some((r) => r.type === 'reading-list-entry')).toBe(
      false
    )
    // A source without the field (a record set from before the type) has nothing to publish.
    const before = collectLocal(sources(), defaultScope())
    expect([...before.values()].some((r) => r.type === 'reading-list-entry')).toBe(false)
    // A scope object persisted by an older build names no `readingList`: it says nothing for
    // the type, and the entries stay home (the golden pins of `compat.test.ts` rest on this).
    const { readingList: _absent, ...olderScope } = defaultScope()
    void _absent
    expect(
      [...collectLocal(src, olderScope as SyncScope).values()].some(
        (r) => r.type === 'reading-list-entry'
      )
    ).toBe(false)
    const record: SyncRecord = {
      id: 'rl_a',
      type: 'reading-list-entry',
      modified: 1,
      deleted: false,
      data: readingListEntryData(unread)
    }
    expect(inScope(record, defaultScope())).toBe(true)
    expect(inScope(record, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, defaultScope())).toBe(true)
  })

  it('diffLocal: first seen at 0; a flip stamps that one record at the commit’s now and no other; a removal is a tombstone at now; a change the round alone notices (stamp null) keeps its modified', () => {
    const src = { ...sources(), readingList: [unread, read] }
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(first.meta.rl_a).toMatchObject({ type: 'reading-list-entry', modified: 0 })
    expect(first.meta.rl_b).toMatchObject({ type: 'reading-list-entry', modified: 0 })

    // The user marks A read on this device: the subscriber's diff stamps A's record `now`.
    const flipped: ReadingListEntry = { ...unread, updatedAt: 2000, readAt: 2000 }
    src.readingList = [flipped, read]
    const edited = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    expect(edited.changed).toBe(true)
    expect(edited.meta.rl_a.modified).toBe(2000)
    expect(edited.meta.rl_b.modified).toBe(0)
    expect(edited.records.find((r) => r.id === 'rl_a')).toMatchObject({
      type: 'reading-list-entry',
      modified: 2000,
      deleted: false,
      data: { id: 'rl_a', readAt: 2000, updatedAt: 2000 }
    })
    // A favicon fetched later changes no record: the bytes the engine sees are the same.
    src.readingList = [
      { ...flipped, favicon: 'data:,fresh' },
      { ...read, favicon: 'data:,b' }
    ]
    const iconed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 2500)
    expect(iconed.changed).toBe(false)
    expect(iconed.meta.rl_a.modified).toBe(2000)

    // The round (`run()`) never stamps: a hash it alone finds changed keeps the record's time.
    src.readingList = [{ ...flipped, title: 'Renamed by a build' }, read]
    const noticed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 3000, {
      stamp: null
    })
    expect(noticed.changed).toBe(true)
    expect(noticed.meta.rl_a.modified).toBe(2000)
    expect(noticed.records.find((r) => r.id === 'rl_a')!.modified).toBe(2000)

    // `remove(id)` drops the entry; the engine writes the tombstone itself, at `now`.
    src.readingList = [flipped]
    const removed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000)
    expect(removed.changed).toBe(true)
    expect(removed.meta.rl_b).toEqual({
      type: 'reading-list-entry',
      hash: '',
      modified: 4000,
      deleted: true
    })
    expect(removed.records.find((r) => r.id === 'rl_b')).toEqual({
      id: 'rl_b',
      type: 'reading-list-entry',
      modified: 4000,
      deleted: true,
      data: null
    })
    // The tombstone is kept for the bookmarks' TTL (30 days) and then forgotten.
    const day = 24 * 60 * 60 * 1000
    expect(
      diffLocal(removed.meta, collectLocal(src, defaultScope()), 4000 + 29 * day).records.some(
        (r) => r.id === 'rl_b'
      )
    ).toBe(true)
    expect(
      diffLocal(removed.meta, collectLocal(src, defaultScope()), 4000 + 31 * day).records.some(
        (r) => r.id === 'rl_b'
      )
    ).toBe(false)
    // A tombstone beats a live copy by `modified` alone; a live record beats it the same way.
    const live: SyncRecord = {
      id: 'rl_b',
      type: 'reading-list-entry',
      modified: 3999,
      deleted: false,
      data: readingListEntryData(read)
    }
    expect(winningRemote(removed.meta, new Map([['rl_b', live]]))).toEqual([])
    expect(
      winningRemote(removed.meta, new Map([['rl_b', { ...live, modified: 4001 }]]))
    ).toHaveLength(1)
    const mine = metaFromRemote([{ ...live, modified: 4001 }])
    expect(mine.rl_b).toEqual({
      type: 'reading-list-entry',
      hash: hashData(live.data),
      modified: 4001,
      deleted: false
    })
  })

  it('readReadingListData – the apply side’s sanitiser – keeps a web address in the model’s normal form under the record’s id, drops the favicon and what it does not know, refuses garbage, and is idempotent', () => {
    const sent = {
      readAt: 800,
      updatedAt: 800,
      favicon: 'data:image/png;base64,PEER',
      title: 'B',
      url: 'https://b.example/',
      id: 'rl_b',
      addedAt: 500,
      device: 'not a field'
    }
    const once = readReadingListData('rl_b', sent)!
    expect(once).toEqual({
      id: 'rl_b',
      url: 'https://b.example/',
      title: 'B',
      addedAt: 500,
      updatedAt: 800,
      readAt: 800
    })
    expect(Object.keys(once)).toEqual(['id', 'url', 'title', 'addedAt', 'updatedAt', 'readAt'])
    expect(once).not.toHaveProperty('favicon')
    expect(once).not.toHaveProperty('device')
    // Idempotent: sanitise(sanitise(x)) = sanitise(x), byte for byte – so a record this device
    // re-publishes after applying it hashes as the entry it holds.
    const twice = readReadingListData('rl_b', once)!
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(hashData(readingListEntryData(twice))).toBe(hashData(readingListEntryData(once)))
    // The record's id is the key; a payload naming another lands under the record's.
    expect(readReadingListData('rl_other', sent)!.id).toBe('rl_other')
    // An unread entry: no `readAt`; a missing title takes the URL; a missing `updatedAt` the
    // latest time the entry has.
    expect(readReadingListData('rl_u', { url: 'https://u.example/', addedAt: 3 })).toEqual({
      id: 'rl_u',
      url: 'https://u.example/',
      title: 'https://u.example/',
      addedAt: 3,
      updatedAt: 3
    })
    // Only a web address: the list never holds the browser's pages, a blank tab or a file.
    for (const url of ['zen://settings', 'about:blank', 'file:///etc/hosts', 'javascript:void 0'])
      expect(readReadingListData('rl_x', { ...sent, url })).toBeNull()
    // Garbage: no URL, no finite time, a negative time, not an object.
    expect(readReadingListData('rl_x', { ...sent, url: undefined })).toBeNull()
    expect(readReadingListData('rl_x', { ...sent, addedAt: 'yesterday' })).toBeNull()
    expect(readReadingListData('rl_x', { ...sent, addedAt: -1 })).toBeNull()
    expect(readReadingListData('rl_x', null)).toBeNull()
    expect(readReadingListData('rl_x', 'nonsense')).toBeNull()
    expect(readReadingListData('rl_x', [sent])).toBeNull()
  })

  it('frozenRecords: turning the reading list off holds its records instead of tombstoning them', () => {
    const src = { ...sources(), readingList: [unread, read] }
    const on = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const off = { ...defaultScope(), readingList: false }
    const held = diffLocal(on.meta, collectLocal(src, off), 2000, {
      stamp: 2000,
      frozen: frozenRecords(src, off, on.meta)
    })
    expect(held.changed).toBe(false)
    expect(held.meta.rl_a).toEqual(on.meta.rl_a)
    expect(held.meta.rl_b).toEqual(on.meta.rl_b)
    expect(held.records.some((r) => r.type === 'reading-list-entry')).toBe(false)
    // Without the freeze the same absence would be a deletion – the guard is what keeps it out.
    const naive = diffLocal(on.meta, collectLocal(src, off), 2000)
    expect(naive.records.find((r) => r.id === 'rl_a')?.deleted).toBe(true)
  })
})

/**
 * The Mods (services pass 15, ID-43): the browser chrome's CSS mods (`Mod`, Settings › Mods),
 * one `mod` record per Mod under its own id, every field but `id`, the `mods` scope's – built as
 * the reading list's type was: the CSS travels whole (an inline `data:` picture within it rides
 * along; a `file:` or host-local address travels as the address alone), the apply side's
 * sanitiser is idempotent, tombstones come from a Mod's absence, and a scope or a source from
 * before the type publishes none.
 */
describe('mod records (services pass 15, ID-43)', () => {
  const compact: Mod = {
    id: 'mod_a',
    name: 'Compact tabs',
    source: null,
    css: '.tab { padding: 2px 6px; }',
    enabled: true,
    updatedAt: 1000
  }
  const rounded: Mod = {
    id: 'mod_b',
    name: 'Rounded',
    source: 'https://mods.example/rounded.css',
    css: '.sidebar { border-radius: 12px; }',
    enabled: false,
    updatedAt: 800
  }

  it('collectLocal emits one record per Mod under its id: the five fields in the normal form’s order, never the id', () => {
    const src = { ...sources(), mods: [compact, rounded] }
    const out = collectLocal(src, defaultScope())
    expect(out.get('mod_a')).toEqual({
      type: 'mod',
      data: {
        name: 'Compact tabs',
        source: null,
        css: '.tab { padding: 2px 6px; }',
        enabled: true,
        updatedAt: 1000
      }
    })
    expect(Object.keys(out.get('mod_a')!.data as object)).toEqual([
      'name',
      'source',
      'css',
      'enabled',
      'updatedAt'
    ])
    expect(out.get('mod_a')!.data).not.toHaveProperty('id')
    expect(out.get('mod_b')).toEqual({
      type: 'mod',
      data: {
        name: 'Rounded',
        source: 'https://mods.example/rounded.css',
        css: '.sidebar { border-radius: 12px; }',
        enabled: false,
        updatedAt: 800
      }
    })
    // `modData` is the payload; the switch is part of it, so a Mod turned off hashes apart from
    // the same Mod on, and a CSS edit changes the hash – the record is the Mod, whole.
    expect(modData(compact)).toEqual(out.get('mod_a')!.data)
    expect(hashData(modData(compact))).not.toBe(hashData(modData({ ...compact, enabled: false })))
    expect(hashData(modData(compact))).not.toBe(hashData(modData({ ...compact, css: '' })))
    // The list's order is each device's own: the records carry no place in it.
    expect(collectLocal({ ...src, mods: [rounded, compact] }, defaultScope()).get('mod_a')).toEqual(
      out.get('mod_a')
    )
  })

  it('the mods toggle (default on, as Chrome’s Themes type is a toggle of its own) gates the type both ways, and a source or a scope from before the type publishes none', () => {
    expect(defaultScope().mods).toBe(true)
    const src = { ...sources(), mods: [compact, rounded] }
    const off = { ...defaultScope(), mods: false }
    expect([...collectLocal(src, off).values()].some((r) => r.type === 'mod')).toBe(false)
    // A source without the field (a record set from before the type) has nothing to publish.
    const before = collectLocal(sources(), defaultScope())
    expect([...before.values()].some((r) => r.type === 'mod')).toBe(false)
    // A scope object persisted by an older build names no `mods`: it says nothing for the
    // type, and the Mods stay home (the fixture pins of `compat.test.ts` rest on this).
    const { mods: _absent, ...olderScope } = defaultScope()
    void _absent
    expect(
      [...collectLocal(src, olderScope as SyncScope).values()].some((r) => r.type === 'mod')
    ).toBe(false)
    const record: SyncRecord = {
      id: 'mod_a',
      type: 'mod',
      modified: 1,
      deleted: false,
      data: modData(compact)
    }
    expect(inScope(record, defaultScope())).toBe(true)
    expect(inScope(record, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, defaultScope())).toBe(true)
    // The older build's scope, as `inScope` reads it: nothing for the type, so an older peer
    // drops the record from every round rather than erring on it.
    expect(inScope(record, olderScope as SyncScope)).toBeFalsy()
    // The look settings travel as they did, with the Mods off or on: the colour scheme and the
    // app icon on the settings record, each space's gradient theme on its space record – and
    // the OS accent switch stays each device's own. The toggle moves the Mod list alone.
    for (const scope of [off, defaultScope()]) {
      const local = collectLocal(src, scope)
      const settings = local.get(SETTINGS_RECORD_ID)!.data as Record<string, unknown>
      expect(settings).toHaveProperty('colorScheme')
      expect(settings).toHaveProperty('appIcon')
      expect(settings).not.toHaveProperty('useSystemAccent')
      expect(local.get(src.ids.space.id)!.data).toHaveProperty('theme')
    }
    expect(DEVICE_LOCAL_SETTINGS).toContain('useSystemAccent')
  })

  it('diffLocal: first seen at 0; an edit stamps that one record at the commit’s now and no other; a removal is a tombstone at now; a change the round alone notices (stamp null) keeps its modified', () => {
    const src = { ...sources(), mods: [compact, rounded] }
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(first.meta.mod_a).toMatchObject({ type: 'mod', modified: 0 })
    expect(first.meta.mod_b).toMatchObject({ type: 'mod', modified: 0 })

    // The user turns B on here: the subscriber's diff stamps B's record `now`.
    const switched: Mod = { ...rounded, enabled: true, updatedAt: 2000 }
    src.mods = [compact, switched]
    const edited = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    expect(edited.changed).toBe(true)
    expect(edited.meta.mod_b.modified).toBe(2000)
    expect(edited.meta.mod_a.modified).toBe(0)
    expect(edited.records.find((r) => r.id === 'mod_b')).toMatchObject({
      type: 'mod',
      modified: 2000,
      deleted: false,
      data: { enabled: true, updatedAt: 2000 }
    })

    // The round (`run()`) never stamps: a hash it alone finds changed keeps the record's time.
    src.mods = [compact, { ...switched, name: 'Renamed by a build' }]
    const noticed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 3000, {
      stamp: null
    })
    expect(noticed.changed).toBe(true)
    expect(noticed.meta.mod_b.modified).toBe(2000)
    expect(noticed.records.find((r) => r.id === 'mod_b')!.modified).toBe(2000)

    // `remove(id)` drops the Mod; the engine writes the tombstone itself, at `now`.
    src.mods = [switched]
    const removed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000)
    expect(removed.changed).toBe(true)
    expect(removed.meta.mod_a).toEqual({ type: 'mod', hash: '', modified: 4000, deleted: true })
    expect(removed.records.find((r) => r.id === 'mod_a')).toEqual({
      id: 'mod_a',
      type: 'mod',
      modified: 4000,
      deleted: true,
      data: null
    })
    // The tombstone is kept for the bookmarks' TTL (30 days) and then forgotten.
    const day = 24 * 60 * 60 * 1000
    expect(
      diffLocal(removed.meta, collectLocal(src, defaultScope()), 4000 + 29 * day).records.some(
        (r) => r.id === 'mod_a'
      )
    ).toBe(true)
    expect(
      diffLocal(removed.meta, collectLocal(src, defaultScope()), 4000 + 31 * day).records.some(
        (r) => r.id === 'mod_a'
      )
    ).toBe(false)
    // A tombstone beats a live copy by `modified` alone; a live record beats it the same way;
    // a tie keeps what this device holds.
    const live: SyncRecord = {
      id: 'mod_a',
      type: 'mod',
      modified: 3999,
      deleted: false,
      data: modData(compact)
    }
    expect(winningRemote(removed.meta, new Map([['mod_a', live]]))).toEqual([])
    expect(winningRemote(removed.meta, new Map([['mod_a', { ...live, modified: 4000 }]]))).toEqual(
      []
    )
    expect(
      winningRemote(removed.meta, new Map([['mod_a', { ...live, modified: 4001 }]]))
    ).toHaveLength(1)
    const mine = metaFromRemote([{ ...live, modified: 4001 }])
    expect(mine.mod_a).toEqual({
      type: 'mod',
      hash: hashData(live.data),
      modified: 4001,
      deleted: false
    })
  })

  it('readModData – the apply side’s sanitiser – lands the Mod under the record’s id in the normal form, cuts the CSS at the cap, names an unnamed one, drops what it does not know, refuses garbage, and is idempotent', () => {
    const sent = {
      updatedAt: 800,
      enabled: false,
      css: '.sidebar { border-radius: 12px; }',
      name: '  Rounded  ',
      source: 'https://mods.example/rounded.css',
      id: 'mod_other',
      device: 'not a field'
    }
    const once = readModData('mod_b', sent)!
    expect(once).toEqual({
      id: 'mod_b',
      name: 'Rounded',
      source: 'https://mods.example/rounded.css',
      css: '.sidebar { border-radius: 12px; }',
      enabled: false,
      updatedAt: 800
    })
    expect(Object.keys(once)).toEqual(['id', 'name', 'source', 'css', 'enabled', 'updatedAt'])
    expect(once).not.toHaveProperty('device')
    // Idempotent: sanitise(sanitise(x)) = sanitise(x), byte for byte – so a record this device
    // re-publishes after applying it hashes as the Mod it holds.
    const twice = readModData('mod_b', once)!
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(hashData(modData(twice))).toBe(hashData(modData(once)))
    expect(readModData('mod_b', modData(once))).toEqual(once)
    // The record's id is the key; a payload naming another lands under the record's.
    expect(readModData('mod_other', sent)!.id).toBe('mod_other')
    // The CSS alone is required: a blank or missing name takes the fallback, a missing source
    // is none, a missing switch is on, a missing or broken time is 0.
    expect(readModData('mod_u', { css: 'a {}' })).toEqual({
      id: 'mod_u',
      name: UNTITLED_MOD,
      source: null,
      css: 'a {}',
      enabled: true,
      updatedAt: 0
    })
    expect(readModData('mod_u', { css: 'a {}', name: '   ', updatedAt: -1 })!.name).toBe(
      UNTITLED_MOD
    )
    expect(readModData('mod_u', { css: 'a {}', updatedAt: Number.NaN })!.updatedAt).toBe(0)
    expect(readModData('mod_u', { css: 'a {}', enabled: 'yes' })!.enabled).toBe(true)
    expect(readModData('mod_u', { css: 'a {}', source: 7 })!.source).toBeNull()
    // The cap: a peer's oversized Mod lands cut at `MAX_MOD_CSS`, the same as this device's own
    // `add`/`update` would cut it, and the cut is idempotent too.
    const huge = readModData('mod_h', { css: 'x'.repeat(MAX_MOD_CSS + 100) })!
    expect(huge.css).toHaveLength(MAX_MOD_CSS)
    expect(readModData('mod_h', modData(huge))).toEqual(huge)
    // The CSS travels whole: an inline picture within it rides along; a `file:` address is the
    // address alone – the picture behind it is that device's own (KNOWN).
    const inline = 'body { background: url("data:image/png;base64,AAAA") }'
    expect(readModData('mod_p', { css: inline })!.css).toBe(inline)
    const local = 'body { background: url("file:///home/me/wall.png") }'
    expect(readModData('mod_p', { css: local })!.css).toBe(local)
    // Garbage: no CSS, a CSS that is not text, not an object, an array.
    expect(readModData('mod_x', { name: 'No CSS' })).toBeNull()
    expect(readModData('mod_x', { css: 42 })).toBeNull()
    expect(readModData('mod_x', null)).toBeNull()
    expect(readModData('mod_x', 'nonsense')).toBeNull()
    expect(readModData('mod_x', [sent])).toBeNull()
  })

  it('frozenRecords: turning the Mods off holds their records instead of tombstoning them', () => {
    const src = { ...sources(), mods: [compact, rounded] }
    const on = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    const off = { ...defaultScope(), mods: false }
    const held = diffLocal(on.meta, collectLocal(src, off), 2000, {
      stamp: 2000,
      frozen: frozenRecords(src, off, on.meta)
    })
    expect(held.changed).toBe(false)
    expect(held.meta.mod_a).toEqual(on.meta.mod_a)
    expect(held.meta.mod_b).toEqual(on.meta.mod_b)
    expect(held.records.some((r) => r.type === 'mod')).toBe(false)
    // Without the freeze the same absence would be a deletion – the guard is what keeps it out.
    const naive = diffLocal(on.meta, collectLocal(src, off), 2000)
    expect(naive.records.find((r) => r.id === 'mod_a')?.deleted).toBe(true)
  })
})

describe('extension records (services pass 16, ID-44)', () => {
  const ID_A = 'abcdefghijklmnopabcdefghijklmnop'
  const ID_B = 'ppppoooonnnnmmmmllllkkkkjjjjiiii'
  const ID_C = 'cccccccccccccccccccccccccccccccc'
  const ID_D = 'dddddddddddddddddddddddddddddddd'
  const ID_E = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const ext = (
    id: string,
    source: ExtensionSyncSource['source'],
    enabled: boolean,
    toolbarPinned: boolean,
    extra: Partial<ExtensionSyncSource> = {}
  ): ExtensionSyncSource => ({ id, source, enabled, toolbarPinned, ...extra })

  it('collectLocal emits one record per store extension under its id – store, enabled, toolbarPinned – and never one for a crx, zip or unpacked install', () => {
    const src = {
      ...sources(),
      extensions: [
        ext(ID_A, 'chrome-web-store', true, true),
        ext(ID_B, 'edge-add-ons', false, false),
        ext(ID_C, 'crx', true, true),
        ext(ID_D, 'zip', true, false),
        ext(ID_E, 'unpacked', true, true)
      ]
    }
    const out = collectLocal(src, defaultScope())
    expect(out.get(ID_A)).toEqual({
      type: 'extension',
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: true }
    })
    expect(Object.keys(out.get(ID_A)!.data as object)).toEqual([
      'store',
      'enabled',
      'toolbarPinned'
    ])
    expect(out.get(ID_B)).toEqual({
      type: 'extension',
      data: { store: 'edge-add-ons', enabled: false, toolbarPinned: false }
    })
    for (const id of [ID_C, ID_D, ID_E]) expect(out.has(id)).toBe(false)
    expect([...out.values()].filter((r) => r.type === 'extension')).toHaveLength(2)
    // The payload carries nothing else of the extension: no id, no version, no time, no grant.
    for (const key of [
      'id',
      'version',
      'name',
      'installedAt',
      'updatedAt',
      'allowFileAccess',
      'allowPrivate',
      'allowUserScripts',
      'pinned'
    ])
      expect(out.get(ID_A)!.data).not.toHaveProperty(key)
    expect(extensionStoreOf('chrome-web-store')).toBe('chrome-web-store')
    expect(extensionStoreOf('edge-add-ons')).toBe('edge-add-ons')
    expect(extensionStoreOf('crx')).toBeNull()
    expect(extensionStoreOf('zip')).toBeNull()
    expect(extensionStoreOf('unpacked')).toBeNull()
  })

  it('the pin is `toolbarPinned` (registry.ts:35, Chrome’s "Pin to toolbar") and never `pinned` (:30, the update-check skip)', () => {
    // `ExtensionInfo` carries both; the record reads the toolbar one alone.
    const info = {
      ...ext(ID_A, 'chrome-web-store', true, false),
      pinned: true
    } as ExtensionSyncSource & {
      pinned: boolean
    }
    const out = collectLocal({ ...sources(), extensions: [info] }, defaultScope())
    expect(out.get(ID_A)!.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: false
    })
    const pinnedToToolbar = { ...ext(ID_A, 'chrome-web-store', true, true), pinned: false }
    expect(
      collectLocal({ ...sources(), extensions: [pinnedToToolbar] }, defaultScope()).get(ID_A)!.data
    ).toEqual({ store: 'chrome-web-store', enabled: true, toolbarPinned: true })
    // Each switch is part of the hash: the pin or the enabled state flipped is an edit.
    const base = extensionRecordData(ext(ID_A, 'chrome-web-store', true, true), 'chrome-web-store')
    expect(hashData(base)).not.toBe(
      hashData(extensionRecordData(ext(ID_A, 'chrome-web-store', true, false), 'chrome-web-store'))
    )
    expect(hashData(base)).not.toBe(
      hashData(extensionRecordData(ext(ID_A, 'chrome-web-store', false, true), 'chrome-web-store'))
    )
  })

  it('a synced landing that waits for the user’s approval here (pendingApproval) is not this device’s state to publish; an id that is no extension id is skipped', () => {
    const src = {
      ...sources(),
      extensions: [
        ext(ID_A, 'chrome-web-store', false, true, { pendingApproval: true }),
        ext('not-an-extension-id', 'chrome-web-store', true, true),
        ext(ID_B, 'edge-add-ons', true, false)
      ]
    }
    const out = collectLocal(src, defaultScope())
    expect(out.has(ID_A)).toBe(false)
    expect(out.has('not-an-extension-id')).toBe(false)
    expect(out.get(ID_B)?.type).toBe('extension')
    // Approved (the flag gone, the switch on): the record is the peer's bytes again.
    const approved = { ...src, extensions: [ext(ID_A, 'chrome-web-store', true, true)] }
    expect(collectLocal(approved, defaultScope()).get(ID_A)!.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: true
    })
  })

  it('the Extensions toggle (default on, Chrome’s Extensions type) gates the type both ways; a source or a scope from before the type publishes none', () => {
    expect(defaultScope().extensions).toBe(true)
    expect(fullScope().extensions).toBe(true)
    const src = { ...sources(), extensions: [ext(ID_A, 'chrome-web-store', true, true)] }
    const off = { ...defaultScope(), extensions: false }
    expect([...collectLocal(src, off).values()].some((r) => r.type === 'extension')).toBe(false)
    expect(
      [...collectLocal(sources(), defaultScope()).values()].some((r) => r.type === 'extension')
    ).toBe(false)
    const { extensions: _absent, ...olderScope } = defaultScope()
    void _absent
    expect(
      [...collectLocal(src, olderScope as SyncScope).values()].some((r) => r.type === 'extension')
    ).toBe(false)
    const record: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 1,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: true }
    }
    expect(inScope(record, defaultScope())).toBe(true)
    expect(inScope(record, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, off)).toBe(false)
    expect(inScope({ ...record, deleted: true, data: null }, defaultScope())).toBe(true)
    expect(inScope(record, olderScope as SyncScope)).toBeFalsy()
  })

  it('readExtensionData – the apply side’s reader – round-trips the payload byte for byte, ignores an unknown store or garbage, and refuses a bad id', () => {
    const sent = extensionRecordData(ext(ID_A, 'edge-add-ons', false, true), 'edge-add-ons')
    const read = readExtensionData(ID_A, sent)!
    expect(read).toEqual({ store: 'edge-add-ons', enabled: false, toolbarPinned: true })
    expect(Object.keys(read)).toEqual(['store', 'enabled', 'toolbarPinned'])
    expect(JSON.stringify(readExtensionData(ID_A, read))).toBe(JSON.stringify(read))
    expect(hashData(read)).toBe(hashData(sent))
    // Extra keys a later build might add ride along in the file but land nowhere here.
    expect(readExtensionData(ID_A, { ...sent, version: '1.2.3', id: ID_B })).toEqual(read)
    // An unknown store id (a store a later build adds): the record is ignored – null, not a guess.
    expect(readExtensionData(ID_A, { ...sent, store: 'firefox-add-ons' })).toBeNull()
    expect(readExtensionData(ID_A, { ...sent, store: 'crx' })).toBeNull()
    expect(readExtensionData(ID_A, { ...sent, store: 'unpacked' })).toBeNull()
    expect(readExtensionData(ID_A, { ...sent, store: 7 })).toBeNull()
    // The switches must be booleans; missing or stringly ones are garbage.
    expect(
      readExtensionData(ID_A, { store: 'chrome-web-store', enabled: 'yes', toolbarPinned: true })
    ).toBeNull()
    expect(readExtensionData(ID_A, { store: 'chrome-web-store', enabled: true })).toBeNull()
    expect(readExtensionData(ID_A, { store: 'chrome-web-store', toolbarPinned: false })).toBeNull()
    expect(readExtensionData(ID_A, null)).toBeNull()
    expect(readExtensionData(ID_A, 'nonsense')).toBeNull()
    expect(readExtensionData(ID_A, [sent])).toBeNull()
    // The record's id is the extension's id at the store: anything else is no install target.
    expect(readExtensionData('not-an-id', sent)).toBeNull()
    expect(readExtensionData(ID_A.toUpperCase(), sent)).toBeNull()
    expect(readExtensionData(ID_A.slice(0, 31), sent)).toBeNull()
    expect(readExtensionData('qrstuvwxyzqrstuvwxyzqrstuvwxyzqr', sent)).toBeNull()
  })

  it('diffLocal: first seen at 0; a switch flipped stamps that record at now; a removal is a tombstone at now; the newest write wins whole', () => {
    const src = {
      ...sources(),
      extensions: [
        ext(ID_A, 'chrome-web-store', true, true),
        ext(ID_B, 'edge-add-ons', true, false)
      ]
    }
    const first = diffLocal({}, collectLocal(src, defaultScope()), 1000)
    expect(first.meta[ID_A]).toMatchObject({ type: 'extension', modified: 0 })
    expect(first.meta[ID_B]).toMatchObject({ type: 'extension', modified: 0 })

    src.extensions = [
      ext(ID_A, 'chrome-web-store', true, true),
      ext(ID_B, 'edge-add-ons', false, false)
    ]
    const edited = diffLocal(first.meta, collectLocal(src, defaultScope()), 2000)
    expect(edited.changed).toBe(true)
    expect(edited.meta[ID_B].modified).toBe(2000)
    expect(edited.meta[ID_A].modified).toBe(0)
    expect(edited.records.find((r) => r.id === ID_B)).toEqual({
      id: ID_B,
      type: 'extension',
      modified: 2000,
      deleted: false,
      data: { store: 'edge-add-ons', enabled: false, toolbarPinned: false }
    })

    // Uninstalled here: the engine names it in `removedExtensions`, and the absence tombstones.
    src.extensions = [ext(ID_B, 'edge-add-ons', false, false)]
    const removed = diffLocal(edited.meta, collectLocal(src, defaultScope()), 4000, {
      stamp: 4000,
      frozen: frozenRecords(
        { ...src, removedExtensions: new Set([ID_A]) },
        defaultScope(),
        edited.meta
      )
    })
    expect(removed.changed).toBe(true)
    expect(removed.meta[ID_A]).toEqual({
      type: 'extension',
      hash: '',
      modified: 4000,
      deleted: true
    })
    expect(removed.records.find((r) => r.id === ID_A)).toEqual({
      id: ID_A,
      type: 'extension',
      modified: 4000,
      deleted: true,
      data: null
    })
    // Last writer per extension, the whole record; a tie keeps this device's copy.
    const live: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 3999,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: true }
    }
    expect(winningRemote(removed.meta, new Map([[ID_A, live]]))).toEqual([])
    expect(winningRemote(removed.meta, new Map([[ID_A, { ...live, modified: 4000 }]]))).toEqual([])
    expect(
      winningRemote(removed.meta, new Map([[ID_A, { ...live, modified: 4001 }]]))
    ).toHaveLength(1)
    expect(metaFromRemote([{ ...live, modified: 4001 }])[ID_A]).toEqual({
      type: 'extension',
      hash: hashData(live.data),
      modified: 4001,
      deleted: false
    })
  })

  it('frozenRecords: an extension entry whose extension this device does not hold is frozen – an install in flight, failed, or landed pending – unless the extension was uninstalled here', () => {
    // Device B has applied A's record (metaFromRemote) but the install has not landed yet.
    const remote: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 5000,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: false }
    }
    const src = { ...sources(), extensions: [] as ExtensionSyncSource[] }
    const meta: MetaMap = {
      ...diffLocal({}, collectLocal(src, defaultScope()), 1000).meta,
      ...metaFromRemote([remote])
    }
    const waiting = diffLocal(meta, collectLocal(src, defaultScope()), 6000, {
      stamp: 6000,
      frozen: frozenRecords(src, defaultScope(), meta)
    })
    expect(waiting.changed).toBe(false)
    expect(waiting.meta[ID_A]).toEqual(meta[ID_A])
    expect(waiting.records.some((r) => r.id === ID_A)).toBe(false)
    // Landed turned off, waiting for approval: `collectLocal` leaves it out, the entry stays.
    const pending = {
      ...src,
      extensions: [ext(ID_A, 'chrome-web-store', false, false, { pendingApproval: true })]
    }
    const held = diffLocal(meta, collectLocal(pending, defaultScope()), 7000, {
      stamp: 7000,
      frozen: frozenRecords(pending, defaultScope(), meta)
    })
    expect(held.changed).toBe(false)
    expect(held.meta[ID_A]).toEqual(meta[ID_A])
    // Approved: the extension stands as the record said, the same bytes – no stamp, no record.
    const approved = { ...src, extensions: [ext(ID_A, 'chrome-web-store', true, false)] }
    const same = diffLocal(meta, collectLocal(approved, defaultScope()), 8000, {
      stamp: 8000,
      frozen: frozenRecords(approved, defaultScope(), meta)
    })
    expect(same.changed).toBe(false)
    expect(same.meta[ID_A]).toEqual(meta[ID_A])
    // Uninstalled here (the pending landing removed, or the installed copy): the tombstone.
    const gone = diffLocal(meta, collectLocal(src, defaultScope()), 9000, {
      stamp: 9000,
      frozen: frozenRecords({ ...src, removedExtensions: new Set([ID_A]) }, defaultScope(), meta)
    })
    expect(gone.changed).toBe(true)
    expect(gone.meta[ID_A]).toEqual({ type: 'extension', hash: '', modified: 9000, deleted: true })
    // Without the rule the absence would be a deletion – and would uninstall the peer's copy.
    const naive = diffLocal(meta, collectLocal(src, defaultScope()), 6000)
    expect(naive.records.find((r) => r.id === ID_A)?.deleted).toBe(true)
    // Turning the type off holds the entries as every toggle does.
    const on = diffLocal({}, collectLocal(approved, defaultScope()), 1000)
    const off = { ...defaultScope(), extensions: false }
    const switched = diffLocal(on.meta, collectLocal(approved, off), 2000, {
      stamp: 2000,
      frozen: frozenRecords(approved, off, on.meta)
    })
    expect(switched.changed).toBe(false)
    expect(switched.meta[ID_A]).toEqual(on.meta[ID_A])
  })

  it('pendingExtensionRequests: a live remote record this device holds as applied but not as installed is handed to the host again every round; a winner, a tombstone, a held id, a closed entry or the type off is not', () => {
    const live: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 5000,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: false }
    }
    const other: SyncRecord = {
      ...live,
      id: ID_B,
      data: { store: 'edge-add-ons', enabled: false, toolbarPinned: true }
    }
    const tomb: SyncRecord = {
      id: ID_C,
      type: 'extension',
      modified: 5000,
      deleted: true,
      data: null
    }
    const mod: SyncRecord = {
      id: 'mod_a',
      type: 'mod',
      modified: 5000,
      deleted: false,
      data: { css: 'a {}' }
    }
    const local = metaFromRemote([live, other, tomb, mod])
    const remote = new Map([live, other, tomb, mod].map((r) => [r.id, r] as const))
    const none = new Map<string, unknown>()
    // Neither installed: both asked for again.
    expect(
      pendingExtensionRequests(local, none, remote, [], defaultScope()).map((r) => r.id)
    ).toEqual([ID_A, ID_B])
    // B installed (held locally): A alone.
    const heldB = new Map<string, unknown>([[ID_B, {}]])
    expect(
      pendingExtensionRequests(local, heldB, remote, [], defaultScope()).map((r) => r.id)
    ).toEqual([ID_A])
    // A among this round's winners: left to them.
    expect(pendingExtensionRequests(local, heldB, remote, [live], defaultScope())).toEqual([])
    // An entry this device tombstoned (uninstalled here) is closed; one it never saw is no request yet.
    const closed = { ...local, [ID_A]: { ...local[ID_A], deleted: true, hash: '' } }
    expect(
      pendingExtensionRequests(closed, none, remote, [], defaultScope()).map((r) => r.id)
    ).toEqual([ID_B])
    const { [ID_A]: _unseen, ...never } = local
    void _unseen
    expect(
      pendingExtensionRequests(never, none, remote, [], defaultScope()).map((r) => r.id)
    ).toEqual([ID_B])
    // The type off asks for nothing.
    expect(
      pendingExtensionRequests(local, none, remote, [], { ...defaultScope(), extensions: false })
    ).toEqual([])
    // The newest remote copy is what is handed over (the map holds it; identity kept).
    expect(pendingExtensionRequests(local, none, remote, [], defaultScope())[0]).toBe(live)
    // A record this build cannot read (the engine rule of #712) is never a request, whatever
    // its entry says – it never had one.
    const foreign: SyncRecord = {
      ...live,
      id: ID_D,
      data: { store: 'firefox-add-ons', enabled: true, toolbarPinned: false }
    }
    const withForeign = { ...local, ...metaFromRemote([foreign]) }
    const remoteWithForeign = new Map([...remote, [ID_D, foreign]])
    expect(
      pendingExtensionRequests(withForeign, none, remoteWithForeign, [], defaultScope()).map(
        (r) => r.id
      )
    ).toEqual([ID_A, ID_B])
  })

  it('extensionDeclineStands / pendingExtensionRequests’ `declined` (the lead’s ruling, round 4): a record the user declined here is no request while the decline stands – any live copy not stamped after it; a copy stamped later (a fresh install on the peer) beats the decline and is offered once more; a tombstone beats nothing; no decline, no bar', () => {
    const live: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 5000,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: false }
    }
    const tomb: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 9000,
      deleted: true,
      data: null
    }
    // The rule: the decline stands against a live record stamped at or before it.
    expect(extensionDeclineStands(undefined, live)).toBe(false)
    expect(extensionDeclineStands(7000, live)).toBe(true)
    expect(extensionDeclineStands(5000, live)).toBe(true)
    expect(extensionDeclineStands(4999, live)).toBe(false)
    expect(extensionDeclineStands(7000, { ...live, modified: 7001 })).toBe(false)
    expect(extensionDeclineStands(7000, tomb)).toBe(false)
    expect(extensionDeclineStands(9000, tomb)).toBe(false)
    // In the requests: the declined id is closed on this device while the decline stands, and
    // asked for again once the peer's copy is stamped after it. Another id is untouched.
    const other: SyncRecord = {
      ...live,
      id: ID_B,
      data: { store: 'edge-add-ons', enabled: false, toolbarPinned: true }
    }
    const local = metaFromRemote([live, other])
    const remote = new Map([live, other].map((r) => [r.id, r] as const))
    const none = new Map<string, unknown>()
    expect(
      pendingExtensionRequests(local, none, remote, [], defaultScope(), { [ID_A]: 7000 }).map(
        (r) => r.id
      )
    ).toEqual([ID_B])
    expect(
      pendingExtensionRequests(local, none, remote, [], defaultScope(), { [ID_A]: 4999 }).map(
        (r) => r.id
      )
    ).toEqual([ID_A, ID_B])
    const fresh: SyncRecord = { ...live, modified: 7001 }
    const remoteFresh = new Map([fresh, other].map((r) => [r.id, r] as const))
    expect(
      pendingExtensionRequests(local, none, remoteFresh, [], defaultScope(), { [ID_A]: 7000 }).map(
        (r) => r.id
      )
    ).toEqual([ID_A, ID_B])
    // Without the argument, nothing is declined (the callers from before).
    expect(
      pendingExtensionRequests(local, none, remote, [], defaultScope()).map((r) => r.id)
    ).toEqual([ID_A, ID_B])
  })

  it('the switches’ clocks (round 2): `enabledAt` and `toolbarPinnedAt` travel when the source holds them, after the three fields, and never otherwise – a source without them writes the bytes of before, hash and all; the reader takes finite positive clocks alone; each clock is part of the hash', () => {
    const before = extensionRecordData(
      ext(ID_A, 'chrome-web-store', true, true),
      'chrome-web-store'
    )
    expect(Object.keys(before)).toEqual(['store', 'enabled', 'toolbarPinned'])
    const stamped = extensionRecordData(
      ext(ID_A, 'chrome-web-store', true, true, { enabledAt: 1500, toolbarPinnedAt: 1200 }),
      'chrome-web-store'
    )
    expect(stamped).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: true,
      enabledAt: 1500,
      toolbarPinnedAt: 1200
    })
    expect(Object.keys(stamped)).toEqual([
      'store',
      'enabled',
      'toolbarPinned',
      'enabledAt',
      'toolbarPinnedAt'
    ])
    // One clock alone travels alone; a clock of 0 (none kept) does not travel.
    expect(
      extensionRecordData(
        ext(ID_A, 'chrome-web-store', true, true, { enabledAt: 1500 }),
        'chrome-web-store'
      )
    ).toEqual({ store: 'chrome-web-store', enabled: true, toolbarPinned: true, enabledAt: 1500 })
    expect(
      extensionRecordData(
        ext(ID_A, 'chrome-web-store', true, true, { enabledAt: 0, toolbarPinnedAt: 0 }),
        'chrome-web-store'
      )
    ).toEqual(before)
    // A clock is part of the hash: a later clock under the same value is an edit (the clock
    // adopted from a peer's record makes this device's copy the peer's bytes).
    expect(hashData(stamped)).not.toBe(hashData(before))
    expect(hashData(stamped)).not.toBe(hashData({ ...stamped, enabledAt: 1501 }))
    // The reader round-trips the clocks and drops what is no clock.
    expect(readExtensionData(ID_A, stamped)).toEqual(stamped)
    expect(hashData(readExtensionData(ID_A, stamped))).toBe(hashData(stamped))
    expect(readExtensionData(ID_A, before)).toEqual(before)
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '1500', null, true]) {
      expect(readExtensionData(ID_A, { ...before, enabledAt: bad, toolbarPinnedAt: bad })).toEqual(
        before
      )
    }
    expect(readExtensionData(ID_A, { ...before, toolbarPinnedAt: 7 })).toEqual({
      ...before,
      toolbarPinnedAt: 7
    })
    // `collectLocal` writes the clocks the source holds and no other field beside them.
    const out = collectLocal(
      {
        ...sources(),
        extensions: [
          ext(ID_A, 'chrome-web-store', false, true, { enabledAt: 1500, toolbarPinnedAt: 1200 })
        ]
      },
      defaultScope()
    )
    expect(out.get(ID_A)!.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: true,
      enabledAt: 1500,
      toolbarPinnedAt: 1200
    })
  })

  it('syncedExtensionData: what the apply hands the host – each switch with its clock, an absent one read as 0 (older than any clocked switch: a switch its host never flipped, or a record from before the clocks, never beats a clocked one – never the record’s `modified`)', () => {
    const data = readExtensionData(ID_A, {
      store: 'edge-add-ons',
      enabled: false,
      toolbarPinned: true
    })!
    expect(syncedExtensionData(data)).toEqual({
      store: 'edge-add-ons',
      enabled: false,
      toolbarPinned: true,
      enabledAt: 0,
      toolbarPinnedAt: 0
    })
    // One clock carried, the other not: the carried one travels, the absent one is 0 – the
    // phone's shape after a flip of one switch.
    expect(syncedExtensionData({ ...data, enabledAt: 1500 })).toEqual({
      store: 'edge-add-ons',
      enabled: false,
      toolbarPinned: true,
      enabledAt: 1500,
      toolbarPinnedAt: 0
    })
    expect(syncedExtensionData({ ...data, enabledAt: 1500, toolbarPinnedAt: 1200 })).toEqual({
      store: 'edge-add-ons',
      enabled: false,
      toolbarPinned: true,
      enabledAt: 1500,
      toolbarPinnedAt: 1200
    })
    // The function has no eye on the record's stamp: the same bytes read the same whatever
    // `modified` the record travelled under.
    expect(syncedExtensionData.length).toBe(1)
  })

  it('extensionRecordReadable (the engine rule of #712): a live record the reader takes or a tombstone under an extension id is a winner; an unknown store, a switch that is no boolean, garbage or a tombstone under no extension id is not – and every other type is', () => {
    const record: SyncRecord = {
      id: ID_A,
      type: 'extension',
      modified: 1,
      deleted: false,
      data: { store: 'chrome-web-store', enabled: true, toolbarPinned: false }
    }
    expect(extensionRecordReadable(record)).toBe(true)
    expect(
      extensionRecordReadable({ ...record, data: { ...(record.data as object), enabledAt: 1500 } })
    ).toBe(true)
    expect(extensionRecordReadable({ ...record, deleted: true, data: null })).toBe(true)
    expect(
      extensionRecordReadable({
        ...record,
        data: { store: 'firefox-add-ons', enabled: true, toolbarPinned: false }
      })
    ).toBe(false)
    expect(
      extensionRecordReadable({
        ...record,
        data: { store: 'chrome-web-store', enabled: 'yes', toolbarPinned: false }
      })
    ).toBe(false)
    expect(extensionRecordReadable({ ...record, data: 'nonsense' })).toBe(false)
    expect(extensionRecordReadable({ ...record, data: null })).toBe(false)
    expect(extensionRecordReadable({ ...record, id: 'not-an-extension-id' })).toBe(false)
    expect(
      extensionRecordReadable({ ...record, id: 'not-an-extension-id', deleted: true, data: null })
    ).toBe(false)
    // Every other type passes untouched – the rule is the extension record's.
    expect(
      extensionRecordReadable({ id: 'mod_a', type: 'mod', modified: 1, deleted: false, data: 7 })
    ).toBe(true)
    expect(
      extensionRecordReadable({
        id: 'not-an-extension-id',
        type: 'bookmark',
        modified: 1,
        deleted: true,
        data: null
      })
    ).toBe(true)
  })
})
