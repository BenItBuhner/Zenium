import { useMemo } from 'react'
import type { BookmarkNode, UIState } from '@shared/types'
import { BookmarkTree } from '@shared/bookmarks'

/** Index over the mirrored node list; rebuilt when the main process pushes a new list. */
export function useBookmarkTree(state: UIState): BookmarkTree {
  return useMemo(() => new BookmarkTree(state.bookmarks), [state.bookmarks])
}

/** Folders the selection must not be dropped into: the selected folders and their subtrees. */
export function forbiddenTargets(tree: BookmarkTree, ids: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    const node = tree.get(id)
    if (node?.type !== 'folder') continue
    out.add(id)
    for (const n of tree.descendants(id)) if (n.type === 'folder') out.add(n.id)
  }
  return out
}

export function nodeLabel(node: BookmarkNode): string {
  return node.title || node.url || (node.type === 'folder' ? 'Folder' : 'Bookmark')
}
