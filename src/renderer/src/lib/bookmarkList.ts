import type { BookmarkNode, Platform } from '@shared/types'
import { type BookmarkTree, defaultBookmarkFolderId, isBookmarkRoot } from '@shared/bookmarks'

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
