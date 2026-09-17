import type { Bookmark, BookmarkNode, BookmarkNodeType, Platform } from './types'

/**
 * The bookmark tree, shaped like `chrome.bookmarks`: three permanent roots with the ids Chrome
 * uses, explicit ordering by `index` inside every folder, and one flat list of nodes as the
 * storage format. Everything here is pure so the core, the renderer and the sync engine share
 * one definition of "a valid tree".
 */

export const BOOKMARKS_BAR_ID = '1'
export const OTHER_BOOKMARKS_ID = '2'
export const MOBILE_BOOKMARKS_ID = '3'

export const BOOKMARK_ROOT_IDS: readonly string[] = [
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  MOBILE_BOOKMARKS_ID
]

export const BOOKMARK_ROOT_TITLES: Readonly<Record<string, string>> = {
  [BOOKMARKS_BAR_ID]: 'Bookmarks bar',
  [OTHER_BOOKMARKS_ID]: 'Other bookmarks',
  [MOBILE_BOOKMARKS_ID]: 'Mobile bookmarks'
}

export const BOOKMARK_SCHEMA_VERSION = 1

/** Data-URI favicons above this size are dropped on import (Chrome keeps 16px PNGs, ~1 KB). */
export const MAX_FAVICON_DATA_URI = 8 * 1024

export function isBookmarkRoot(id: string | null | undefined): boolean {
  return id !== null && id !== undefined && BOOKMARK_ROOT_IDS.includes(id)
}

/** Where new bookmarks go when nothing else was chosen: Chrome's per-form-factor default. */
export function defaultBookmarkFolderId(platform: Platform): string {
  return platform === 'android' ? MOBILE_BOOKMARKS_ID : OTHER_BOOKMARKS_ID
}

export function createBookmarkRoots(now: number): BookmarkNode[] {
  return BOOKMARK_ROOT_IDS.map((id, index) => ({
    id,
    parentId: null,
    index,
    type: 'folder' as const,
    title: BOOKMARK_ROOT_TITLES[id],
    dateAdded: now
  }))
}

/** A node with its children attached (the shape `getTree` / `getSubTree` return). */
export interface BookmarkTreeNode extends BookmarkNode {
  children?: BookmarkTreeNode[]
}

export type BookmarkSort = 'manual' | 'name' | 'dateAdded'

// ---------------------------------------------------------------------------
// Indexed view
// ---------------------------------------------------------------------------

/** Read-only index over a node list; cheap to rebuild, so hosts rebuild it after every change. */
export class BookmarkTree {
  readonly byId = new Map<string, BookmarkNode>()
  private readonly byParent = new Map<string | null, BookmarkNode[]>()

  constructor(nodes: Iterable<BookmarkNode>) {
    for (const node of nodes) {
      if (this.byId.has(node.id)) continue
      this.byId.set(node.id, node)
      const list = this.byParent.get(node.parentId)
      if (list) list.push(node)
      else this.byParent.set(node.parentId, [node])
    }
    for (const list of this.byParent.values()) list.sort((a, b) => a.index - b.index)
  }

  get(id: string): BookmarkNode | null {
    return this.byId.get(id) ?? null
  }

  get size(): number {
    return this.byId.size
  }

  all(): BookmarkNode[] {
    return [...this.byId.values()]
  }

  roots(): BookmarkNode[] {
    return BOOKMARK_ROOT_IDS.map((id) => this.byId.get(id)).filter((n): n is BookmarkNode =>
      Boolean(n)
    )
  }

  children(parentId: string): BookmarkNode[] {
    return this.byParent.get(parentId) ?? []
  }

  /** Ancestors from the root down to the node's parent (empty for roots). */
  path(id: string): BookmarkNode[] {
    const out: BookmarkNode[] = []
    let node = this.byId.get(id)
    const seen = new Set<string>()
    while (node && node.parentId !== null && !seen.has(node.id)) {
      seen.add(node.id)
      const parent = this.byId.get(node.parentId)
      if (!parent) break
      out.unshift(parent)
      node = parent
    }
    return out
  }

  pathLabel(id: string, separator = ' / '): string {
    return this.path(id)
      .map((n) => n.title)
      .join(separator)
  }

  /**
   * The folders above a node without the root's name: "Work / Docs" for a bookmark in
   * Other bookmarks > Work > Docs, "" for one directly under a root.
   */
  folderLabel(id: string, separator = ' / '): string {
    return this.path(id)
      .filter((n) => !isBookmarkRoot(n.id))
      .map((n) => n.title)
      .join(separator)
  }

  isAncestor(ancestorId: string, id: string): boolean {
    return this.path(id).some((n) => n.id === ancestorId)
  }

  /** Every node below a folder, depth first in display order. */
  descendants(id: string): BookmarkNode[] {
    const out: BookmarkNode[] = []
    const walk = (parentId: string): void => {
      for (const child of this.children(parentId)) {
        out.push(child)
        if (child.type === 'folder') walk(child.id)
      }
    }
    walk(id)
    return out
  }

  /** Bookmarks (not folders) below a folder, or the node itself when it is a bookmark. */
  urlsUnder(id: string): BookmarkNode[] {
    const node = this.byId.get(id)
    if (!node) return []
    if (node.type === 'url') return [node]
    return this.descendants(id).filter((n) => n.type === 'url')
  }

  byUrl(url: string): BookmarkNode[] {
    return this.all().filter((n) => n.type === 'url' && n.url === url)
  }

  hasUrl(url: string): boolean {
    for (const node of this.byId.values()) if (node.type === 'url' && node.url === url) return true
    return false
  }

  subTree(id: string): BookmarkTreeNode | null {
    const node = this.byId.get(id)
    if (!node) return null
    if (node.type !== 'folder') return { ...node }
    return { ...node, children: this.children(id).map((c) => this.subTree(c.id)!) }
  }

  tree(): BookmarkTreeNode[] {
    return this.roots().map((r) => this.subTree(r.id)!)
  }

  /** Roots in their fixed order followed by their subtrees, depth first. */
  flat(): BookmarkNode[] {
    const out: BookmarkNode[] = []
    const walk = (parentId: string): void => {
      for (const child of this.children(parentId)) {
        out.push(child)
        if (child.type === 'folder') walk(child.id)
      }
    }
    for (const root of this.roots()) {
      out.push(root)
      walk(root.id)
    }
    return out
  }

  counts(): { bookmarks: number; folders: number } {
    let bookmarks = 0
    let folders = 0
    for (const node of this.byId.values()) {
      if (isBookmarkRoot(node.id)) continue
      if (node.type === 'url') bookmarks += 1
      else folders += 1
    }
    return { bookmarks, folders }
  }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function isType(value: unknown): value is BookmarkNodeType {
  return value === 'url' || value === 'folder'
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Repair a node list so it is a valid tree: the roots exist and stay pinned, every other node
 * has a real folder parent (orphans and cycle members are re-homed to `fallbackParentId`),
 * indices are contiguous per folder, and the result is in display order (see `flat`).
 * Running it again on its own output is a no-op, which is what makes loading idempotent.
 */
export function normalizeBookmarkNodes(
  input: readonly unknown[],
  now: number,
  fallbackParentId: string = OTHER_BOOKMARKS_ID
): BookmarkNode[] {
  const byId = new Map<string, BookmarkNode>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || byId.has(r.id)) continue
    const type: BookmarkNodeType = isType(r.type)
      ? r.type
      : typeof r.url === 'string'
        ? 'url'
        : 'folder'
    const url = typeof r.url === 'string' ? r.url : undefined
    if (type === 'url' && !url) continue
    const node: BookmarkNode = {
      id: r.id,
      parentId: typeof r.parentId === 'string' ? r.parentId : null,
      index: finiteOr(r.index, Number.MAX_SAFE_INTEGER),
      type,
      title: typeof r.title === 'string' ? r.title : (url ?? ''),
      dateAdded: finiteOr(r.dateAdded, now)
    }
    if (type === 'url') {
      node.url = url
      if (typeof r.favicon === 'string' && r.favicon) node.favicon = r.favicon
      const used = finiteOr(r.dateLastUsed, 0)
      if (used > 0) node.dateLastUsed = used
    } else {
      const modified = finiteOr(r.dateGroupModified, 0)
      if (modified > 0) node.dateGroupModified = modified
    }
    byId.set(node.id, node)
  }

  // Roots: always present, always folders, never moved or renamed.
  for (const root of createBookmarkRoots(now)) {
    const existing = byId.get(root.id)
    if (existing) {
      existing.parentId = null
      existing.index = root.index
      existing.type = 'folder'
      existing.title = root.title
      delete existing.url
      delete existing.favicon
      delete existing.dateLastUsed
    } else {
      byId.set(root.id, root)
    }
  }
  const fallback = byId.has(fallbackParentId) ? fallbackParentId : OTHER_BOOKMARKS_ID

  // Every non-root node must reach a root through folder parents; anything else is re-homed.
  const reachable = new Map<string, boolean>()
  const resolve = (id: string, trail: Set<string>): boolean => {
    const known = reachable.get(id)
    if (known !== undefined) return known
    if (isBookmarkRoot(id)) return true
    const node = byId.get(id)!
    if (trail.has(id)) return false
    trail.add(id)
    const parent = node.parentId === null ? null : byId.get(node.parentId)
    const ok = Boolean(parent && parent.type === 'folder' && resolve(parent.id, trail))
    reachable.set(id, ok)
    return ok
  }
  for (const node of byId.values()) {
    if (isBookmarkRoot(node.id)) continue
    if (!resolve(node.id, new Set())) {
      node.parentId = fallback
      reachable.set(node.id, true)
    }
  }

  // Contiguous indices per folder, keeping the stored order. Index collisions (two devices filed
  // into the same slot before syncing) resolve by creation date, then id, so every device settles
  // on the same order without another round trip.
  const children = new Map<string, BookmarkNode[]>()
  for (const node of byId.values()) {
    if (node.parentId === null) continue
    const list = children.get(node.parentId)
    if (list) list.push(node)
    else children.set(node.parentId, [node])
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        a.index - b.index || a.dateAdded - b.dateAdded || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    list.forEach((node, i) => (node.index = i))
  }

  const out: BookmarkNode[] = []
  const walk = (parentId: string): void => {
    for (const child of children.get(parentId) ?? []) {
      out.push(child)
      if (child.type === 'folder') walk(child.id)
    }
  }
  for (const id of BOOKMARK_ROOT_IDS) {
    out.push(byId.get(id)!)
    walk(id)
  }
  return out
}

/**
 * v1/v2 profiles kept a flat list (newest first). Every entry becomes a bookmark under the
 * platform's default folder in the same order, keeping its id and creation date.
 */
export function migrateLegacyBookmarks(
  list: readonly Bookmark[],
  targetRootId: string,
  now: number
): BookmarkNode[] {
  const nodes: BookmarkNode[] = createBookmarkRoots(now)
  let index = 0
  for (const b of list) {
    if (!b || typeof b.url !== 'string' || !b.url) continue
    const node: BookmarkNode = {
      id: typeof b.id === 'string' && b.id ? b.id : `bm_${index}`,
      parentId: targetRootId,
      index: index++,
      type: 'url',
      title: b.title || b.url,
      url: b.url,
      dateAdded: finiteOr(b.createdAt, now)
    }
    if (b.favicon) node.favicon = b.favicon
    nodes.push(node)
  }
  return normalizeBookmarkNodes(nodes, now, targetRootId)
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Folders first, then by the chosen key; `manual` keeps the stored index order. */
export function sortBookmarkNodes(
  nodes: readonly BookmarkNode[],
  sort: BookmarkSort,
  descending = false
): BookmarkNode[] {
  const list = [...nodes]
  if (sort === 'manual') return list.sort((a, b) => a.index - b.index)
  const dir = descending ? -1 : 1
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    if (sort === 'name')
      return dir * a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
    return dir * (a.dateAdded - b.dateAdded)
  })
}

/**
 * Search titles, URLs and folder paths: every whitespace-separated term must match. Bookmarks
 * whose title starts with the query rank first, then title matches, then URL / path matches.
 */
export function searchBookmarks(
  tree: BookmarkTree,
  query: string,
  limit = Infinity,
  type?: BookmarkNodeType
): BookmarkNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const scored: Array<{ node: BookmarkNode; score: number }> = []
  for (const node of tree.byId.values()) {
    if (isBookmarkRoot(node.id) || (type && node.type !== type)) continue
    const title = node.title.toLowerCase()
    const url = (node.url ?? '').toLowerCase()
    // Folder names count, root titles do not ("bookmarks" must not match everything).
    const path = tree
      .path(node.id)
      .filter((p) => !isBookmarkRoot(p.id))
      .map((p) => p.title.toLowerCase())
      .join(' ')
    const hay = `${title} ${url} ${path}`
    if (!terms.every((t) => hay.includes(t))) continue
    let score = 0
    if (title.startsWith(q)) score += 4
    else if (title.includes(q)) score += 3
    else if (terms.every((t) => title.includes(t))) score += 2
    if (url.includes(q)) score += 1
    if (node.type === 'folder') score -= 0.5
    scored.push({ node, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || b.node.dateAdded - a.node.dateAdded)
    .slice(0, limit)
    .map((s) => s.node)
}

/** Most recently added bookmarks (not folders). */
export function recentBookmarks(tree: BookmarkTree, limit: number): BookmarkNode[] {
  return tree
    .all()
    .filter((n) => n.type === 'url')
    .sort((a, b) => b.dateAdded - a.dateAdded)
    .slice(0, limit)
}

/**
 * Folders the user filed into most recently (Chrome's star dialog shows these first). Roots
 * count too, so a fresh profile still offers "Other bookmarks" and "Bookmarks bar".
 */
export function recentFolders(tree: BookmarkTree, limit: number): BookmarkNode[] {
  return tree
    .all()
    .filter((n) => n.type === 'folder')
    .sort(
      (a, b) =>
        (b.dateGroupModified ?? 0) - (a.dateGroupModified ?? 0) ||
        Number(isBookmarkRoot(b.id)) - Number(isBookmarkRoot(a.id)) ||
        a.index - b.index
    )
    .slice(0, limit)
}

export function bookmarkUrlCount(tree: BookmarkTree, ids: readonly string[]): number {
  const seen = new Set<string>()
  for (const id of ids) for (const n of tree.urlsUnder(id)) seen.add(n.id)
  return seen.size
}

/** Drop selected nodes whose ancestor is also selected (moving/copying them twice is wrong). */
export function topLevelSelection(tree: BookmarkTree, ids: readonly string[]): string[] {
  const set = new Set(ids)
  return ids.filter((id) => tree.get(id) && !tree.path(id).some((p) => set.has(p.id)))
}
