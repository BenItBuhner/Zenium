import { describe, expect, it } from 'vitest'
import {
  ORDER_SPACES,
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
  stableStringify,
  winningRemote,
  type BookmarkData,
  type MetaMap,
  type OrderData,
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
import type { BookmarkNode, Space, Tab } from '../../../shared/types'
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
    const held = diffLocal(
      on.meta,
      collectLocal(src, off),
      2000,
      undefined,
      frozenRecords(src, off, on.meta)
    )
    expect(held.changed).toBe(false)
    expect(held.meta.cred_login1).toEqual(on.meta.cred_login1)
    expect(held.meta.passkey_1).toEqual(on.meta.passkey_1)
    expect(held.records.some((r) => r.type === 'credential')).toBe(false)

    src.credentials = null
    const locked = diffLocal(
      on.meta,
      collectLocal(src, defaultScope()),
      3000,
      undefined,
      frozenRecords(src, defaultScope(), on.meta)
    )
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
