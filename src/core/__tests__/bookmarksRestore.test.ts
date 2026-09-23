import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookmarkNode, HostCapabilities, Platform, Tab } from '../../shared/types'
import {
  BOOKMARKS_BAR_ID,
  BOOKMARK_ROOT_IDS,
  BookmarkTree,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  isBookmarkRoot
} from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import { BookmarkService } from '../bookmarks'
import { BrowserState } from '../state'
import { collectLocal, defaultScope, diffLocal, type LocalSources } from '../sync/records'
import { device, published, setup as setupSync, teardown } from '../sync/__tests__/harness'

function fakeIo(): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => null,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function setup(platform: Platform = 'linux'): { state: BrowserState; service: BookmarkService } {
  const state = new BrowserState(fakeIo(), platform, {} as HostCapabilities, '0.0')
  state.load()
  return { state, service: new BookmarkService(state) }
}

/** The invariants every write must leave intact (the same check as bookmarks.test.ts). */
function expectValid(service: BookmarkService): void {
  const nodes = service.all()
  const tree = new BookmarkTree(nodes)
  expect(tree.roots().map((r) => r.id)).toEqual([...BOOKMARK_ROOT_IDS])
  for (const node of nodes) {
    if (isBookmarkRoot(node.id)) {
      expect(node.parentId).toBeNull()
      continue
    }
    const path = tree.path(node.id)
    expect(path.length).toBeGreaterThan(0)
    expect(isBookmarkRoot(path[0].id)).toBe(true)
  }
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    const children = tree.children(node.id)
    expect(children.map((c) => c.index)).toEqual(children.map((_, i) => i))
  }
  expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
}

/** What the desktop's undo puts aside: the subtree, every parent before its children. */
function snapshot(service: BookmarkService, id: string): BookmarkNode[] {
  return [service.get(id)!, ...service.tree.descendants(id)].map((n) => ({ ...n }))
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('BookmarkService.restore', () => {
  it('puts a removed bookmark back under its own id with its dates, place and favicon', () => {
    const { service } = setup()
    const before = service.create({
      parentId: BOOKMARKS_BAR_ID,
      title: 'Before',
      url: 'https://before/'
    })!
    const a = service.create({
      parentId: BOOKMARKS_BAR_ID,
      title: 'A',
      url: 'https://a/',
      favicon: 'data:icon',
      dateAdded: 1_000
    })!
    const after = service.create({
      parentId: BOOKMARKS_BAR_ID,
      title: 'After',
      url: 'https://after/'
    })!
    service.touch(a.id)
    const [kept] = snapshot(service, a.id)
    expect(kept.dateLastUsed).toBeGreaterThan(0)

    expect(service.removeTree(a.id)).toBe(true)
    expect(service.get(a.id)).toBeNull()
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([before.id, after.id])

    const [restored] = service.restore([kept])
    expect(restored).toEqual({ ...kept })
    expect(service.get(a.id)).toEqual(kept)
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([
      before.id,
      a.id,
      after.id
    ])
    // The parent that got a child back is modified, as after `create`.
    expect(service.get(BOOKMARKS_BAR_ID)!.dateGroupModified!).toBeGreaterThan(kept.dateLastUsed!)
    expectValid(service)
  })

  it('restores a folder before its children whatever the order handed in, dates intact', () => {
    const { service } = setup()
    const folder = service.createFolder(OTHER_BOOKMARKS_ID, 'Work')!
    const inner = service.createFolder(folder.id, 'Inner')!
    service.create({ parentId: folder.id, title: 'One', url: 'https://one/' })
    service.create({ parentId: inner.id, title: 'Deep', url: 'https://deep/' })
    service.create({ parentId: folder.id, title: 'Two', url: 'https://two/', index: 0 })
    const removed = snapshot(service, folder.id)
    const modified = service.get(folder.id)!.dateGroupModified!
    expect(modified).toBeGreaterThan(0)
    const innerModified = service.get(inner.id)!.dateGroupModified!

    expect(service.removeTree(folder.id)).toBe(true)
    expect(service.all()).toHaveLength(BOOKMARK_ROOT_IDS.length)

    // Children first, the folder last: the batch still lands the folder before its children.
    const handedIn = [...removed].reverse()
    const back = service.restore(handedIn)
    expect(back.map((n) => n?.id)).toEqual(handedIn.map((n) => n.id))
    expect(service.all()).toHaveLength(BOOKMARK_ROOT_IDS.length + removed.length)
    for (const node of removed) expect(service.get(node.id)).toEqual(node)
    expect(service.getChildren(folder.id).map((n) => n.title)).toEqual(['Two', 'Inner', 'One'])
    expect(service.getChildren(inner.id).map((n) => n.title)).toEqual(['Deep'])
    // A restored folder comes back with its own history; only the surviving parent is touched.
    expect(service.get(folder.id)!.dateGroupModified).toBe(modified)
    expect(service.get(inner.id)!.dateGroupModified).toBe(innerModified)
    expect(service.get(OTHER_BOOKMARKS_ID)!.dateGroupModified!).toBeGreaterThan(modified)
    expectValid(service)
  })

  it('keeps sibling order when several siblings come back at once, and clamps indices', () => {
    const { service } = setup()
    const ids = ['a', 'b', 'c', 'd'].map(
      (t) => service.create({ parentId: BOOKMARKS_BAR_ID, title: t, url: `https://${t}/` })!.id
    )
    const removed = [ids[0], ids[2], ids[3]].map((id) => snapshot(service, id)[0])
    service.removeMany(removed.map((n) => n.id))
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['b'])

    // Handed in out of order (d, a, c) and with d's index far past the end.
    const back = service.restore([{ ...removed[2], index: 99 }, removed[0], removed[1]])
    expect(back.map((n) => n?.title)).toEqual(['d', 'a', 'c'])
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['a', 'b', 'c', 'd'])
    expectValid(service)
  })

  it('falls back to a new id when the old one is taken, reports it, and its children follow', () => {
    const { service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'Folder')!
    const child = service.create({ parentId: folder.id, title: 'Child', url: 'https://child/' })!
    const removed = snapshot(service, folder.id)
    service.removeTree(folder.id)

    // A sync brings the folder back under the same id before the undo runs.
    service.applySynced(folder.id, {
      parentId: OTHER_BOOKMARKS_ID,
      index: 0,
      type: 'folder',
      title: 'Synced copy',
      dateAdded: 5
    })
    service.syncTabs()

    const back = service.restore(removed)
    expect(back).toHaveLength(2)
    const [backFolder, backChild] = back as [BookmarkNode, BookmarkNode]
    // The folder's id was taken: it came back under a new id, with its fields and dates.
    expect(backFolder.id).not.toBe(folder.id)
    expect(backFolder).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      title: 'Folder',
      dateAdded: removed[0].dateAdded,
      dateGroupModified: removed[0].dateGroupModified
    })
    // The child's id was free: it keeps it, under the folder it came back with.
    expect(backChild.id).toBe(child.id)
    expect(backChild.parentId).toBe(backFolder.id)
    expect(service.getChildren(backFolder.id).map((n) => n.id)).toEqual([child.id])
    // The synced copy stands where sync put it.
    expect(service.get(folder.id)).toMatchObject({
      title: 'Synced copy',
      parentId: OTHER_BOOKMARKS_ID
    })
    expect(service.getChildren(folder.id)).toEqual([])
    expectValid(service)
  })

  it('homes a node whose parent is gone in the named folder, else the default root', () => {
    const { service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'Gone')!
    const a = service.create({ parentId: folder.id, title: 'A', url: 'https://a/' })!
    const b = service.create({ parentId: folder.id, title: 'B', url: 'https://b/' })!
    const [snapA] = snapshot(service, a.id)
    const [snapB] = snapshot(service, b.id)
    service.removeTree(folder.id)
    const home = service.createFolder(OTHER_BOOKMARKS_ID, 'Home')!

    const [backA] = service.restore([snapA], { parentId: home.id })
    expect(backA).toMatchObject({ id: a.id, parentId: home.id, index: 0 })
    const [backB] = service.restore([snapB])
    expect(backB).toMatchObject({ id: b.id, parentId: OTHER_BOOKMARKS_ID })
    // A named parent that is not a folder counts as none.
    const [again] = service.restore([{ ...snapA, id: 'fresh' }], { parentId: a.id })
    expect(again).toMatchObject({ id: 'fresh', parentId: OTHER_BOOKMARKS_ID })
    expectValid(service)
  })

  it('uses Mobile bookmarks as the default home on Android', () => {
    const { service } = setup('android')
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'Gone')!
    const a = service.create({ parentId: folder.id, title: 'A', url: 'https://a/' })!
    const [snap] = snapshot(service, a.id)
    service.removeTree(folder.id)
    expect(service.restore([snap])[0]?.parentId).toBe(MOBILE_BOOKMARKS_ID)
  })

  it('is one write and one change event for the whole batch', async () => {
    const { state, service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'F')!
    for (const t of ['a', 'b', 'c'])
      service.create({ parentId: folder.id, title: t, url: `https://${t}/` })
    const removed = snapshot(service, folder.id)
    service.removeTree(folder.id)
    await tick()

    const commits = vi.spyOn(state, 'commit')
    let broadcasts = 0
    const unsubscribe = state.subscribe(() => {
      broadcasts += 1
    })
    const back = service.restore(removed)
    expect(back.every(Boolean)).toBe(true)
    expect(commits).toHaveBeenCalledTimes(1)
    await tick()
    expect(broadcasts).toBe(1)
    unsubscribe()
    expectValid(service)
  })

  it("brings the tabs' bookmarked flag back with the bookmark", () => {
    const { state, service } = setup()
    const tab = { id: 't1', url: 'https://a/', bookmarked: false } as unknown as Tab
    state.model.tabs[tab.id] = tab
    const a = service.create({ title: 'A', url: 'https://a/' })!
    expect(tab.bookmarked).toBe(true)
    const [snap] = snapshot(service, a.id)
    service.removeTree(a.id)
    expect(tab.bookmarked).toBe(false)
    service.restore([snap])
    expect(tab.bookmarked).toBe(true)
  })

  it('answers null for a root or a URL-less bookmark and writes nothing for an empty batch', () => {
    const { state, service } = setup()
    const commits = vi.spyOn(state, 'commit')
    const root = service.get(BOOKMARKS_BAR_ID)!
    const bad: BookmarkNode = {
      id: 'bad',
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      type: 'url',
      title: 'No URL',
      dateAdded: 1
    }
    expect(service.restore([root, bad])).toEqual([null, null])
    expect(service.restore([])).toEqual([])
    expect(commits).not.toHaveBeenCalled()
    expect(service.all()).toHaveLength(BOOKMARK_ROOT_IDS.length)
    // Mixed in with a good node, the bad ones are reported in their slots and the rest lands.
    const [nothing, good] = service.restore([root, { ...bad, id: 'good', url: 'https://good/' }])
    expect(nothing).toBeNull()
    expect(good).toMatchObject({ id: 'good', url: 'https://good/' })
    expect(commits).toHaveBeenCalledTimes(1)
    expectValid(service)
  })

  it('a node handed in twice comes back once; the repeat is reported as null', () => {
    const { service } = setup()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    const [snap] = snapshot(service, a.id)
    service.removeTree(a.id)
    const back = service.restore([snap, snap])
    expect(back.map((n) => n?.id ?? null)).toEqual([a.id, null])
    expect(service.findByUrl('https://a/')).toHaveLength(1)
  })
})

describe('BookmarkService.restore: the sync record', () => {
  const sources = (state: BrowserState): LocalSources => ({
    model: state.model,
    settings: state.settings,
    shortcutOverrides: state.shortcutOverrides,
    bookmarks: state.bookmarks,
    boosts: []
  })

  it("re-publishes the same record id live after its tombstone (the publisher's diff)", () => {
    const { state, service } = setup()
    const scope = defaultScope()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    const synced = diffLocal({}, collectLocal(sources(state), scope), 1_000)
    expect(synced.records.find((r) => r.id === a.id)).toMatchObject({
      type: 'bookmark',
      deleted: false
    })

    const [snap] = snapshot(service, a.id)
    service.removeTree(a.id)
    const removed = diffLocal(synced.meta, collectLocal(sources(state), scope), 2_000)
    expect(removed.records.find((r) => r.id === a.id)).toMatchObject({
      deleted: true,
      modified: 2_000
    })

    service.restore([snap])
    const restored = diffLocal(removed.meta, collectLocal(sources(state), scope), 3_000)
    expect(restored.changed).toBe(true)
    // The same id, live again and newer than its tombstone; no second record for the bookmark.
    expect(restored.records.find((r) => r.id === a.id)).toMatchObject({
      type: 'bookmark',
      deleted: false,
      modified: 3_000,
      data: { title: 'A', url: 'https://a/', parentId: OTHER_BOOKMARKS_ID, index: 0 }
    })
    expect(restored.records.filter((r) => r.type === 'bookmark')).toHaveLength(1)
    expect(restored.meta[a.id]).toMatchObject({ deleted: false, modified: 3_000 })
  })
})

describe('BookmarkService.restore: two devices on one folder', () => {
  afterEach(teardown)

  it('a delete undone on one device brings the same id back on the other', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const folder = a.browser.bookmarks.createFolder(BOOKMARKS_BAR_ID, 'Work')!
    const doc = a.browser.bookmarks.create({
      parentId: folder.id,
      title: 'Docs',
      url: 'https://docs.example/'
    })!
    await setupSync(a)
    await setupSync(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.bookmarks.get(doc.id)?.parentId).toBe(folder.id)

    // A deletes the folder; the tombstones reach B.
    await new Promise((r) => setTimeout(r, 5))
    const removed = snapshot(a.browser.bookmarks, folder.id)
    expect(a.browser.bookmarks.removeTree(folder.id)).toBe(true)
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(b.browser.bookmarks.get(folder.id)).toBeNull()
    expect(b.browser.bookmarks.get(doc.id)).toBeNull()
    expect((await published(a)).filter((r) => r.type === 'bookmark' && r.deleted)).toHaveLength(2)

    // A undoes it: the nodes come back under their ids, and so they do on B – no new records.
    await new Promise((r) => setTimeout(r, 5))
    const back = a.browser.bookmarks.restore(removed)
    expect(back.map((n) => n?.id)).toEqual([folder.id, doc.id])
    await a.engine.syncNow()
    await b.engine.syncNow()
    const live = (await published(a)).filter((r) => r.type === 'bookmark')
    expect(live.map((r) => [r.id, r.deleted]).sort()).toEqual(
      [
        [folder.id, false],
        [doc.id, false]
      ].sort()
    )
    expect(b.browser.bookmarks.get(folder.id)).toMatchObject({
      title: 'Work',
      parentId: BOOKMARKS_BAR_ID
    })
    expect(b.browser.bookmarks.get(doc.id)).toMatchObject({
      title: 'Docs',
      url: 'https://docs.example/',
      parentId: folder.id
    })
    expect(b.browser.bookmarks.all()).toHaveLength(BOOKMARK_ROOT_IDS.length + 2)
  }, 30_000)
})
