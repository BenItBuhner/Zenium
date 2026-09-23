import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import { BookmarkService } from '../bookmarks'
import { BOOKMARK_UNDO_DEPTH, BookmarkUndoStack } from '../bookmarkUndo'
import { BrowserState } from '../state'

/*
 * The undo stack over services' BookmarkService (bookmarks-31): a delete, a move or a rename
 * put aside and taken back, in the manager's order (the newest first) or by a delete's own
 * token (its toast), the nodes back where they stood – as themselves, through services'
 * `restore` (#370): under their own ids, with their dates. Only a node whose id was taken
 * meanwhile comes back under a new one, which the stack keeps track of for the edits made
 * before the delete.
 */

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => {},
    writeSync: () => {}
  }
}

function setup(): { state: BrowserState; service: BookmarkService; undo: BookmarkUndoStack } {
  const state = new BrowserState(fakeIo(), 'linux', {} as HostCapabilities, '0.0')
  state.load()
  const service = new BookmarkService(state)
  return { state, service, undo: new BookmarkUndoStack(service) }
}

/** The bar's children as `title` (or `title/…` for a folder), in order. */
function bar(service: BookmarkService, folderId = BOOKMARKS_BAR_ID): string[] {
  return service.getChildren(folderId).map((n) => (n.type === 'folder' ? `${n.title}/` : n.title))
}

function seed(service: BookmarkService): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const title of ['a', 'b', 'c', 'd']) {
    ids[title] = service.create({
      parentId: BOOKMARKS_BAR_ID,
      title,
      url: `https://${title}.example/`
    })!.id
  }
  return ids
}

describe('BookmarkUndoStack', () => {
  it('puts a deleted bookmark back as itself: its id, title, address, icon and dates, where it stood', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    service.update(ids.b, { favicon: 'https://b.example/icon.png' })
    service.touch(ids.b)
    const before = service.get(ids.b)!
    expect(before.dateLastUsed).toBeGreaterThan(0)

    const removal = undo.remove([ids.b])
    expect(removal).toEqual({ token: 1, count: 1, kind: 'bookmark' })
    expect(bar(service)).toEqual(['a', 'c', 'd'])
    expect(service.get(ids.b)).toBeNull()

    const undone = undo.undo()
    expect(undone?.kind).toBe('remove')
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    // Services' `restore` (#370): the node is back under its own id, its history with it – and
    // the undo names that id, so the manager selects the row the user knew.
    expect(undone?.ids).toEqual([ids.b])
    expect(undone?.parentId).toBe(BOOKMARKS_BAR_ID)
    expect(service.get(ids.b)).toEqual(before)
    expect(service.get(ids.b)).toMatchObject({
      title: 'b',
      url: 'https://b.example/',
      favicon: 'https://b.example/icon.png',
      dateAdded: before.dateAdded,
      dateLastUsed: before.dateLastUsed,
      index: 1
    })
    expect(undo.depth).toBe(0)
  })

  it('restores a deleted folder with everything below it, in order, every node under its id', () => {
    const { service, undo } = setup()
    seed(service)
    const folder = service.create({
      parentId: BOOKMARKS_BAR_ID,
      index: 1,
      title: 'f',
      type: 'folder'
    })!
    for (const t of ['x', 'y'])
      service.create({ parentId: folder.id, title: t, url: `https://${t}.test/` })
    const sub = service.create({ parentId: folder.id, title: 'g', type: 'folder' })!
    const z = service.create({ parentId: sub.id, title: 'z', url: 'https://z.test/' })!
    service.touch(z.id)
    expect(bar(service)).toEqual(['a', 'f/', 'b', 'c', 'd'])
    const before = [folder.id, ...service.tree.descendants(folder.id).map((n) => n.id)].map((id) =>
      service.get(id)!
    )
    expect(before.map((n) => n.title)).toEqual(['f', 'x', 'y', 'g', 'z'])
    expect(before[0].dateGroupModified).toBeGreaterThan(0)
    expect(before[3].dateGroupModified).toBeGreaterThan(0)

    expect(undo.remove([folder.id])).toMatchObject({ count: 1, kind: 'folder' })
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    for (const node of before) expect(service.get(node.id)).toBeNull()

    const undone = undo.undo()!
    expect(undone.ids).toEqual([folder.id])
    expect(bar(service)).toEqual(['a', 'f/', 'b', 'c', 'd'])
    expect(bar(service, folder.id)).toEqual(['x', 'y', 'g/'])
    expect(bar(service, sub.id)).toEqual(['z'])
    // The folders keep the `dateGroupModified` they had, the bookmark its `dateLastUsed`: the
    // subtree is back exactly as it was put aside.
    for (const node of before) expect(service.get(node.id)).toEqual(node)
  })

  it('puts several deleted siblings back in their order, each before the sibling that followed it', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    // a's anchor is b, c's is d: with a back before b, c goes before d – not on the bare index
    // d stood on before a returned (that would put c before b).
    expect(undo.remove([ids.a, ids.c])).toMatchObject({ count: 2, kind: 'bookmark' })
    expect(bar(service)).toEqual(['b', 'd'])
    const undone = undo.undo()!
    expect(undone.ids).toEqual([ids.a, ids.c])
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([
      ids.a,
      ids.b,
      ids.c,
      ids.d
    ])
  })

  it('lands a row by its sibling anchor: before its old next sibling, else on its old index, or at the end', () => {
    // A neighbour before it went meanwhile: the row still lands before the sibling that followed.
    {
      const { service, undo } = setup()
      const ids = seed(service)
      undo.remove([ids.b])
      service.removeTree(ids.a)
      expect(bar(service)).toEqual(['c', 'd'])
      expect(undo.undo()?.ids).toEqual([ids.b])
      expect(bar(service)).toEqual(['b', 'c', 'd'])
    }
    // The sibling that followed is gone: the row takes its old index.
    {
      const { service, undo } = setup()
      const ids = seed(service)
      undo.remove([ids.b])
      service.removeTree(ids.c)
      expect(bar(service)).toEqual(['a', 'd'])
      expect(undo.undo()?.ids).toEqual([ids.b])
      expect(bar(service)).toEqual(['a', 'b', 'd'])
    }
    // It was the last: it goes to the end, after a row added there since.
    {
      const { service, undo } = setup()
      const ids = seed(service)
      undo.remove([ids.d])
      service.create({ parentId: BOOKMARKS_BAR_ID, title: 'e', url: 'https://e.example/' })
      expect(bar(service)).toEqual(['a', 'b', 'c', 'e'])
      expect(undo.undo()?.ids).toEqual([ids.d])
      expect(bar(service)).toEqual(['a', 'b', 'c', 'e', 'd'])
    }
  })

  it('is one write for the whole delete, however many rows and folders it holds', () => {
    const { state, service, undo } = setup()
    const ids = seed(service)
    const folder = service.create({ parentId: BOOKMARKS_BAR_ID, title: 'f', type: 'folder' })!
    service.create({ parentId: folder.id, title: 'x', url: 'https://x.test/' })
    undo.remove([ids.a, ids.c, folder.id])
    const commits = vi.spyOn(state, 'commit')
    expect(undo.undo()?.ids).toEqual([ids.a, ids.c, folder.id])
    expect(commits).toHaveBeenCalledTimes(1)
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd', 'f/'])
  })

  it('restores several deleted rows to their own places and names the mix', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    const folder = service.create({ parentId: BOOKMARKS_BAR_ID, title: 'f', type: 'folder' })!
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd', 'f/'])

    // Given in any order, with a child of the folder that goes with it anyway.
    const child = service.create({ parentId: folder.id, title: 'x', url: 'https://x.test/' })!
    const removal = undo.remove([ids.d, ids.a, folder.id, child.id])
    expect(removal).toMatchObject({ count: 3, kind: 'mixed' })
    expect(bar(service)).toEqual(['b', 'c'])

    const undone = undo.undo()!
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd', 'f/'])
    expect(undone.ids).toHaveLength(3)
    expect(service.getChildren(undone.ids[2]).map((n) => n.title)).toEqual(['x'])
  })

  it('moves the moved rows back, a move within the folder and one across folders alike', () => {
    const { service, undo } = setup()
    const ids = seed(service)

    // A reorder: d to the front.
    expect(undo.move([ids.d], BOOKMARKS_BAR_ID, 0)).toBe(true)
    expect(bar(service)).toEqual(['d', 'a', 'b', 'c'])
    expect(undo.undo()?.kind).toBe('move')
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])

    // Two rows into another folder.
    expect(undo.move([ids.a, ids.c], OTHER_BOOKMARKS_ID)).toBe(true)
    expect(bar(service)).toEqual(['b', 'd'])
    expect(bar(service, OTHER_BOOKMARKS_ID)).toEqual(['a', 'c'])
    const undone = undo.undo()!
    expect(undone.ids.sort()).toEqual([ids.a, ids.c].sort())
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(bar(service, OTHER_BOOKMARKS_ID)).toEqual([])
  })

  it('leaves nothing to undo for a move that changed nothing', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    expect(undo.move([ids.a], BOOKMARKS_BAR_ID, 0)).toBe(true)
    expect(undo.depth).toBe(0)
    expect(undo.undo()).toBeNull()
  })

  it('takes a rename and an address change back', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    undo.update(ids.a, { title: 'A!' })
    undo.update(ids.a, { url: 'https://elsewhere.example/' })
    expect(service.get(ids.a)).toMatchObject({ title: 'A!', url: 'https://elsewhere.example/' })
    expect(undo.undo()?.kind).toBe('update')
    expect(service.get(ids.a)).toMatchObject({ title: 'A!', url: 'https://a.example/' })
    expect(undo.undo()?.kind).toBe('update')
    expect(service.get(ids.a)).toMatchObject({ title: 'a', url: 'https://a.example/' })
    // A rename to the same name is no edit.
    undo.update(ids.a, { title: 'a' })
    expect(undo.depth).toBe(0)
  })

  it('undoes in the manager order, newest first, and finds a node renamed before it was deleted', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    undo.update(ids.b, { title: 'B' })
    undo.move([ids.b], BOOKMARKS_BAR_ID, 3)
    expect(bar(service)).toEqual(['a', 'c', 'd', 'B'])
    const removal = undo.remove([ids.b])
    expect(bar(service)).toEqual(['a', 'c', 'd'])

    // Ctrl+Z (no token) takes the newest edit back and says which: the delete the toast holds.
    expect(undo.undo()).toMatchObject({ kind: 'remove', token: removal?.token, ids: [ids.b] })
    expect(bar(service)).toEqual(['a', 'c', 'd', 'B'])
    // The move and the rename were made on the same id the node is back under.
    expect(undo.undo()).toMatchObject({ kind: 'move', ids: [ids.b] })
    expect(bar(service)).toEqual(['a', 'B', 'c', 'd'])
    expect(undo.undo()).toMatchObject({ kind: 'update', ids: [ids.b] })
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(undo.undo()).toBeNull()
  })

  it('a node whose id was taken meanwhile comes back under a new one, which the older edits about it follow', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    undo.update(ids.b, { title: 'B' })
    undo.move([ids.b], BOOKMARKS_BAR_ID, 3)
    const before = service.get(ids.b)!
    undo.remove([ids.b])
    expect(bar(service)).toEqual(['a', 'c', 'd'])

    // A sync brings a stranger in under b's id before the undo runs (ids being minted, a race
    // with a new node is the other way there).
    service.applySynced(ids.b, {
      parentId: OTHER_BOOKMARKS_ID,
      index: 0,
      type: 'url',
      title: 'Stranger',
      url: 'https://stranger.example/',
      dateAdded: 1
    })
    service.syncTabs()

    // The delete undone: b is back at the end, where it stood, as itself but for the id – the
    // service's fallback, reported positionally, which the stack takes down as an alias.
    const undone = undo.undo()!
    expect(undone.kind).toBe('remove')
    expect(bar(service)).toEqual(['a', 'c', 'd', 'B'])
    const [newId] = undone.ids
    expect(newId).not.toBe(ids.b)
    expect(service.get(newId)).toEqual({ ...before, id: newId })
    expect(service.get(ids.b)).toMatchObject({ title: 'Stranger', parentId: OTHER_BOOKMARKS_ID })

    // The move and the rename were made on the old id: the stack follows it to the new one, and
    // the stranger holding the old id is left alone.
    expect(undo.undo()).toMatchObject({ kind: 'move', ids: [newId] })
    expect(bar(service)).toEqual(['a', 'B', 'c', 'd'])
    expect(undo.undo()).toMatchObject({ kind: 'update', ids: [newId] })
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(service.get(ids.b)).toMatchObject({ title: 'Stranger', parentId: OTHER_BOOKMARKS_ID })
    expect(bar(service, OTHER_BOOKMARKS_ID)).toEqual(['Stranger'])
  })

  it('follows a node through two fallbacks in a row (the aliases chain)', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    undo.update(ids.b, { title: 'B' })
    const stranger = (id: string, title: string): void => {
      service.applySynced(id, {
        parentId: OTHER_BOOKMARKS_ID,
        index: 0,
        type: 'url',
        title,
        url: `https://${title.toLowerCase()}.example/`,
        dateAdded: 1
      })
      service.syncTabs()
    }

    undo.remove([ids.b])
    stranger(ids.b, 'One')
    const [second] = undo.undo()!.ids
    expect(second).not.toBe(ids.b)
    undo.remove([second])
    stranger(second, 'Two')
    const [third] = undo.undo()!.ids
    expect(third).not.toBe(second)
    expect(bar(service)).toEqual(['a', 'B', 'c', 'd'])

    // The rename was made on the first id; two hops on, the stack still finds the node.
    expect(undo.undo()).toMatchObject({ kind: 'update', ids: [third] })
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(bar(service, OTHER_BOOKMARKS_ID).sort()).toEqual(['One', 'Two'])
  })

  it("undoes the one delete its token names, leaving a later move in place (the toast's Undo)", () => {
    const { service, undo } = setup()
    const ids = seed(service)
    const removal = undo.remove([ids.a])!
    undo.move([ids.d], BOOKMARKS_BAR_ID, 0)
    expect(bar(service)).toEqual(['d', 'b', 'c'])

    const undone = undo.undo(removal.token)
    expect(undone?.kind).toBe('remove')
    // The result names the edit taken back, so the toast offering that token can go down.
    expect(undone?.token).toBe(removal.token)
    // Back before b, the row that followed it – not at its bare old index, which d took since.
    expect(bar(service)).toEqual(['d', 'a', 'b', 'c'])
    expect(undo.depth).toBe(1)
    // A token already used, or never given out, undoes nothing.
    expect(undo.undo(removal.token)).toBeNull()
    expect(undo.undo(999)).toBeNull()
    expect(undo.undo()?.kind).toBe('move')
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('refuses roots and unknown ids, and forgets the oldest edits past its depth', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    expect(undo.remove([BOOKMARKS_BAR_ID, 'bm_nope'])).toBeNull()
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    for (let i = 0; i < BOOKMARK_UNDO_DEPTH + 5; i++) undo.update(ids.a, { title: `a${i}` })
    expect(undo.depth).toBe(BOOKMARK_UNDO_DEPTH)
  })
})
