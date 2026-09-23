import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import { BookmarkService } from '../bookmarks'
import { BOOKMARK_UNDO_DEPTH, BookmarkUndoStack } from '../bookmarkUndo'
import { BrowserState } from '../state'

/*
 * The undo stack over services' BookmarkService (bookmarks-31): a delete, a move or a rename
 * put aside and taken back, in the manager's order (the newest first) or by a delete's own
 * token (its toast), the nodes back where they stood – under new ids, which the stack keeps
 * track of for the edits made before the delete.
 */

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => {},
    writeSync: () => {}
  }
}

function setup(): { service: BookmarkService; undo: BookmarkUndoStack } {
  const state = new BrowserState(fakeIo(), 'linux', {} as HostCapabilities, '0.0')
  state.load()
  const service = new BookmarkService(state)
  return { service, undo: new BookmarkUndoStack(service) }
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
  it('puts a deleted bookmark back where it stood, with its title, address, icon and date', () => {
    const { service, undo } = setup()
    const ids = seed(service)
    service.update(ids.b, { favicon: 'https://b.example/icon.png' })
    const before = service.get(ids.b)!

    const removal = undo.remove([ids.b])
    expect(removal).toEqual({ token: 1, count: 1, kind: 'bookmark' })
    expect(bar(service)).toEqual(['a', 'c', 'd'])

    const undone = undo.undo()
    expect(undone?.kind).toBe('remove')
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    const restored = service.get(undone!.ids[0])!
    expect(undone?.parentId).toBe(BOOKMARKS_BAR_ID)
    expect(restored).toMatchObject({
      title: 'b',
      url: 'https://b.example/',
      favicon: 'https://b.example/icon.png',
      dateAdded: before.dateAdded,
      index: 1
    })
    // The model mints ids: the node is back under a new one (the seam services could close).
    expect(restored.id).not.toBe(ids.b)
    expect(undo.depth).toBe(0)
  })

  it('restores a deleted folder with everything below it, in order', () => {
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
    service.create({ parentId: sub.id, title: 'z', url: 'https://z.test/' })
    expect(bar(service)).toEqual(['a', 'f/', 'b', 'c', 'd'])

    expect(undo.remove([folder.id])).toMatchObject({ count: 1, kind: 'folder' })
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])

    const undone = undo.undo()!
    expect(bar(service)).toEqual(['a', 'f/', 'b', 'c', 'd'])
    const back = service.get(undone.ids[0])!
    expect(back.type).toBe('folder')
    expect(bar(service, back.id)).toEqual(['x', 'y', 'g/'])
    const g = service.getChildren(back.id).find((n) => n.title === 'g')!
    expect(bar(service, g.id)).toEqual(['z'])
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
    expect(undo.undo()).toMatchObject({ kind: 'remove', token: removal?.token })
    expect(bar(service)).toEqual(['a', 'c', 'd', 'B'])
    // The move and the rename were made on the old id; the stack follows it to the new one.
    expect(undo.undo()?.kind).toBe('move')
    expect(bar(service)).toEqual(['a', 'B', 'c', 'd'])
    expect(undo.undo()?.kind).toBe('update')
    expect(bar(service)).toEqual(['a', 'b', 'c', 'd'])
    expect(undo.undo()).toBeNull()
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
