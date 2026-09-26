import type { BookmarkNode, Platform } from '@shared/types'
import {
  type BookmarkTree,
  defaultBookmarkFolderId,
  isBookmarkRoot,
  topLevelSelection
} from '@shared/bookmarks'

/**
 * What the phone bookmarks list shows and where it starts. Pure over the shared `BookmarkTree`.
 *
 * The list is a stack of folders: the bottom is either the platform's default folder ("Mobile
 * bookmarks" on Android) when it is the only root worth showing, or a top level that lists the
 * roots as folder rows (Chrome's "Bookmarks" screen). `null` in the stack is that top level.
 */
export type FolderId = string | null

/** The roots the top level lists: the default folder always, the others when they have anything in them. */
export function topLevelRoots(tree: BookmarkTree, platform: Platform): BookmarkNode[] {
  const preferred = defaultBookmarkFolderId(platform)
  const roots = tree.roots().filter((r) => r.id === preferred || tree.children(r.id).length > 0)
  return roots.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
}

/**
 * Where the list opens: inside `requested` when that is a folder (the path above it becomes the
 * stack, so back walks up), otherwise the top level – or straight inside the default folder
 * when it would be the top level's only row.
 */
export function initialFolderStack(
  tree: BookmarkTree,
  platform: Platform,
  requested: string | null
): FolderId[] {
  const roots = topLevelRoots(tree, platform)
  const bottom: FolderId = roots.length === 1 ? roots[0].id : null
  if (requested && tree.get(requested)?.type === 'folder') {
    // Root first, the requested folder last.
    const chain = [...tree.path(requested).map((n) => n.id), requested]
    // Inside the only root there is no top level to go back to.
    return bottom !== null && bottom === chain[0] ? chain : [null, ...chain]
  }
  return [bottom]
}

/** Rows of a folder: folders first, then bookmarks, each in the user's own order. */
export function folderRows(
  tree: BookmarkTree,
  folderId: FolderId,
  platform: Platform
): BookmarkNode[] {
  if (folderId === null) return topLevelRoots(tree, platform)
  const children = tree.children(folderId)
  return [
    ...children.filter((n) => n.type === 'folder'),
    ...children.filter((n) => n.type === 'url')
  ]
}

/** The header title for a stack position. */
export function folderTitle(tree: BookmarkTree, folderId: FolderId): string {
  if (folderId === null) return 'Bookmarks'
  return tree.get(folderId)?.title ?? 'Bookmarks'
}

/** "3 items" / "1 item" / "Empty" for a folder row's trailing value. */
export function folderCountLabel(count: number): string {
  if (count === 0) return 'Empty'
  return `${count} ${count === 1 ? 'item' : 'items'}`
}

/** Ids a delete may touch: roots are undeletable, and a folder covers its subtree already. */
export function deletableIds(tree: BookmarkTree, ids: readonly string[]): string[] {
  return ids.filter((id) => tree.get(id) && !isBookmarkRoot(id))
}

/**
 * What Move to… moves (HB-12 / HB-15, Chrome's `BookmarkFolderPickerMediator`): the picked
 * nodes that can move at all – never a root, and never a node whose ancestor is picked too
 * (the ancestor carries it; the core's `bookmark.move` drops such nodes the same way).
 */
export function movableIds(tree: BookmarkTree, ids: readonly string[]): string[] {
  // Roots go first: a picked root stays put and carries nothing out with it.
  return topLevelSelection(
    tree,
    ids.filter((id) => !isBookmarkRoot(id))
  )
}

/**
 * The folder every moved node stands in now, when they all stand in the same one (Chrome's
 * `mOriginalParentId`: the picker checks it and refuses a move back into it); null for nodes
 * from different folders, or nothing to move.
 */
export function sharedParentId(tree: BookmarkTree, ids: readonly string[]): string | null {
  let shared: string | null = null
  for (const id of ids) {
    const parent = tree.get(id)?.parentId ?? null
    if (parent === null) return null
    if (shared === null) shared = parent
    else if (shared !== parent) return null
  }
  return shared
}

/** A folder Move to… can land in, with how deep under its root the picker indents it. */
export interface MoveTarget {
  node: BookmarkNode
  depth: number
}

/**
 * The folders Move to… offers for `ids` (the picker's rows): every folder of the tree in
 * reading order – the roots as the list shows them (`topLevelRoots`: the platform's own first,
 * an empty other root left out, as Chrome's picker leaves out a hidden permanent folder), each
 * followed by its subfolders depth first – except the moved folders and everything under them,
 * since a folder cannot land inside itself (the core refuses it; Chrome's picker leaves the
 * moved rows out of its list).
 */
export function moveTargets(
  tree: BookmarkTree,
  ids: readonly string[],
  platform: Platform
): MoveTarget[] {
  const moving = new Set(movableIds(tree, ids))
  const out: MoveTarget[] = []
  const walk = (node: BookmarkNode, depth: number): void => {
    if (moving.has(node.id)) return
    out.push({ node, depth })
    for (const child of tree.children(node.id)) if (child.type === 'folder') walk(child, depth + 1)
  }
  for (const root of topLevelRoots(tree, platform)) walk(root, 0)
  return out
}

/**
 * A stack that lost its folder (deleted elsewhere, or pruned by sync) unwinds to the nearest
 * ancestor that still exists. Returns the same array when nothing changed.
 */
export function pruneFolderStack(
  tree: BookmarkTree,
  stack: readonly FolderId[]
): readonly FolderId[] {
  const cut = stack.findIndex((id) => id !== null && tree.get(id)?.type !== 'folder')
  if (cut === -1) return stack
  return cut === 0 ? [null] : stack.slice(0, cut)
}
