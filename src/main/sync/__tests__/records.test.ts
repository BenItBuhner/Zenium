import { describe, expect, it } from 'vitest'
import {
  ORDER_SPACES,
  applyOrder,
  collectLocal,
  defaultScope,
  diffLocal,
  hashData,
  metaFromRemote,
  newestByRecord,
  stableStringify,
  winningRemote,
  type MetaMap,
  type OrderData,
  type SyncRecord
} from '../records'
import { createSpace, createTabRecord, emptyModel, insertTabIntoSpace } from '../../browser/model'
import { DEFAULT_CONTAINERS, DEFAULT_SETTINGS } from '../../../shared/defaults'
import type { Space, Tab } from '../../../shared/types'

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

  it('does not leak onboardingDone through the settings record', () => {
    const src = sources()
    const data = collectLocal(src, defaultScope()).get('settings')?.data as Record<string, unknown>
    expect(data).not.toHaveProperty('onboardingDone')
    expect(data).toHaveProperty('searchEngineId')
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
