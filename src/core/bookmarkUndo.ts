/**
 * Undo for the user's bookmark edits (bookmarks-31): a bounded stack of what a delete, a move
 * or a rename put aside, enough to put it back – Chrome's `BookmarkUndoService` behind the
 * manager's Ctrl+Z and the "Undo" of the toast a delete leaves. The stack lives over services'
 * `BookmarkService` and its public verbs alone: a deleted node comes back through `create`, so
 * it returns under a new id (the model mints ids itself); the stack remembers the old id's new
 * name (`aliases`) so an older entry about the same node – a move or a rename made before the
 * delete – still finds it. What `create` cannot carry (`dateLastUsed`, a folder's
 * `dateGroupModified`) is lost with the delete; the seam for a restore that keeps ids is
 * services' to add.
 *
 * A node goes back before the sibling that followed it (its old index when that sibling is
 * gone; the end when it was last), so a delete undone from its toast after other edits still
 * lands beside the rows it stood among.
 */
import type { BookmarkNode } from '../shared/types'
import { topLevelSelection } from '../shared/bookmarks'
import type { BookmarkService } from './bookmarks'

/** Chrome's `UndoManager` keeps a hundred groups; the bookmarks alone need far fewer. */
export const BOOKMARK_UNDO_DEPTH = 50

/** Where a node stood: its folder, its index there, and the sibling that came right after it. */
interface Placement {
  id: string
  parentId: string
  index: number
  /** Null: it was the folder's last child. */
  nextId: string | null
}

/** One undoable edit, as put aside. */
export type BookmarkUndoEntry =
  | {
      kind: 'remove'
      token: number
      /** The removed subtrees, every parent before its children, with their original ids. */
      nodes: BookmarkNode[]
      /** Where each removed top-level node stood. */
      placements: Placement[]
    }
  | { kind: 'move'; token: number; placements: Placement[] }
  | { kind: 'update'; token: number; id: string; title: string; url: string | undefined }

/** What a delete removed, for the toast that offers to undo it. */
export interface BookmarkRemoval {
  /** The entry's token: the toast's Undo names it, so it undoes this delete and no later edit. */
  token: number
  /** How many top-level nodes went. */
  count: number
  kind: 'bookmark' | 'folder' | 'mixed'
}

/**
 * What an undo did, for the surface that asked (the manager selects what came back) and for
 * every window (a delete's toast goes down once its delete is undone from anywhere).
 */
export interface BookmarkUndone {
  kind: BookmarkUndoEntry['kind']
  /** The token of the edit taken back – the one a delete's toast names. */
  token: number
  /** The nodes concerned, under their current ids. */
  ids: string[]
  /** The folder the first of them stands in now. */
  parentId: string | null
}

export class BookmarkUndoStack {
  private readonly entries: BookmarkUndoEntry[] = []
  /** A restored node's old id → its new one (chains when a node was restored more than once). */
  private readonly aliases = new Map<string, string>()
  private seq = 0

  constructor(private readonly bookmarks: BookmarkService) {}

  /** How many edits can be undone. */
  get depth(): number {
    return this.entries.length
  }

  /**
   * Delete `ids` (subtrees and all) so that the delete can be undone; null when nothing went
   * (roots, unknown ids).
   */
  remove(ids: readonly string[]): BookmarkRemoval | null {
    const top = this.topLevel(ids)
    if (top.length === 0) return null
    const placements = top.map((n) => this.placementOf(n))
    const tree = this.bookmarks.tree
    const nodes = top.flatMap((n) => [n, ...tree.descendants(n.id)].map((x) => ({ ...x })))
    if (this.bookmarks.removeMany(top.map((n) => n.id)) === 0) return null
    const token = this.push({ kind: 'remove', token: 0, nodes, placements })
    const folders = top.filter((n) => n.type === 'folder').length
    return {
      token,
      count: top.length,
      kind: folders === 0 ? 'bookmark' : folders === top.length ? 'folder' : 'mixed'
    }
  }

  /** Move `ids` into `parentId` at `index` (the service's contract) so that it can be undone. */
  move(ids: readonly string[], parentId: string, index?: number): boolean {
    const placements = this.topLevel(ids).map((n) => this.placementOf(n))
    if (!this.bookmarks.move(ids, parentId, index)) return false
    // A move that changed nothing (the nodes were already there) leaves nothing to undo.
    if (placements.every((p) => sameSpot(this.bookmarks.get(p.id), p))) return true
    this.push({ kind: 'move', token: 0, placements })
    return true
  }

  /** Rename a node or change a bookmark's address so that it can be undone. */
  update(id: string, patch: { title?: string; url?: string }): BookmarkNode | null {
    const before = this.bookmarks.get(id)
    if (!before) return null
    const next = this.bookmarks.update(id, patch)
    if (!next) return null
    if (next.title === before.title && next.url === before.url) return next
    this.push({ kind: 'update', token: 0, id, title: before.title, url: before.url })
    return next
  }

  /**
   * Take back the newest edit – or, given a `token`, that one edit wherever it stands (the toast
   * of a delete undoes that delete after a later move as well). Null when there is nothing to
   * undo, or the nodes concerned are gone for good.
   */
  undo(token?: number): BookmarkUndone | null {
    const at =
      token === undefined
        ? this.entries.length - 1
        : this.entries.findIndex((e) => e.token === token)
    if (at < 0) return null
    const [entry] = this.entries.splice(at, 1)
    const undone = this.takeBack(entry)
    return undone ? { ...undone, token: entry.token } : null
  }

  private takeBack(entry: BookmarkUndoEntry): Omit<BookmarkUndone, 'token'> | null {
    switch (entry.kind) {
      case 'remove':
        return this.restore(entry.nodes, entry.placements)
      case 'move':
        return this.replace(entry.placements)
      case 'update': {
        const id = this.resolve(entry.id)
        const node = this.bookmarks.update(id, { title: entry.title, url: entry.url })
        return node ? { kind: 'update', ids: [id], parentId: node.parentId } : null
      }
    }
  }

  /** Forget every edit (a profile switch, the tests). */
  clear(): void {
    this.entries.length = 0
    this.aliases.clear()
  }

  private push(entry: BookmarkUndoEntry): number {
    entry.token = ++this.seq
    this.entries.push(entry)
    if (this.entries.length > BOOKMARK_UNDO_DEPTH) this.entries.shift()
    return entry.token
  }

  /** The nodes of `ids` that are not inside another of them, roots aside, lowest index first. */
  private topLevel(ids: readonly string[]): BookmarkNode[] {
    const tree = this.bookmarks.tree
    return topLevelSelection(tree, ids)
      .map((id) => tree.get(id))
      .filter((n): n is BookmarkNode => Boolean(n && n.parentId))
      .sort((a, b) => a.index - b.index)
  }

  private placementOf(node: BookmarkNode): Placement {
    const parentId = node.parentId as string
    const siblings = this.bookmarks.tree.children(parentId)
    return {
      id: node.id,
      parentId,
      index: node.index,
      nextId: siblings[node.index + 1]?.id ?? null
    }
  }

  /** A node's id today: the one it was restored under, however many times. */
  private resolve(id: string): string {
    let current = id
    for (let hops = 0; hops < 64; hops++) {
      const next = this.aliases.get(current)
      if (!next) break
      current = next
    }
    return current
  }

  /**
   * The index a node goes back to in `parentId` today: before the sibling that followed it when
   * that sibling is still there (`movingId` names the node itself when it is in the folder
   * already, since the service counts the index with the moved node taken out), else its old
   * index, or the end for a node that was last.
   */
  private slot(p: Placement, parentId: string, movingId?: string): number | undefined {
    if (p.nextId === null) return undefined
    const anchor = this.bookmarks.get(this.resolve(p.nextId))
    if (!anchor || anchor.parentId !== parentId) return p.index
    const moving = movingId ? this.bookmarks.get(movingId) : null
    const before = moving && moving.parentId === parentId && moving.index < anchor.index ? 1 : 0
    return anchor.index - before
  }

  /**
   * Put removed subtrees back where they stood: every parent before its children, siblings by
   * their old index, so each `create` lands on its old place among the survivors.
   */
  private restore(
    nodes: readonly BookmarkNode[],
    placements: readonly Placement[]
  ): Omit<BookmarkUndone, 'token'> | null {
    const placement = new Map(placements.map((p) => [p.id, p]))
    const restored: string[] = []
    for (const node of nodes) {
      const parentId = this.resolve(node.parentId ?? '')
      const top = placement.get(node.id)
      const created = this.bookmarks.create({
        parentId,
        index: top ? this.slot(top, parentId) : node.index,
        title: node.title,
        url: node.url,
        type: node.type,
        favicon: node.favicon ?? null,
        dateAdded: node.dateAdded
      })
      if (!created) continue
      this.aliases.set(node.id, created.id)
      if (top) restored.push(created.id)
    }
    return restored.length ? this.undone('remove', restored) : null
  }

  /** Move nodes back to where they stood, the lowest old index first, so each lands on its place. */
  private replace(placements: readonly Placement[]): Omit<BookmarkUndone, 'token'> | null {
    const moved: string[] = []
    for (const p of [...placements].sort((a, b) => a.index - b.index)) {
      const id = this.resolve(p.id)
      const parentId = this.resolve(p.parentId)
      if (this.bookmarks.move([id], parentId, this.slot(p, parentId, id))) moved.push(id)
    }
    return moved.length ? this.undone('move', moved) : null
  }

  private undone(kind: BookmarkUndoEntry['kind'], ids: string[]): Omit<BookmarkUndone, 'token'> {
    return { kind, ids, parentId: this.bookmarks.get(ids[0])?.parentId ?? null }
  }
}

function sameSpot(node: BookmarkNode | null | undefined, p: Placement): boolean {
  return Boolean(node && node.parentId === p.parentId && node.index === p.index)
}
