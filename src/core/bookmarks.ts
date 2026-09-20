import type { BookmarkImportResult, BookmarkNode, BookmarkNodeType, Tab } from '../shared/types'
import { newId } from '../shared/ids'
import {
  BOOKMARKS_BAR_ID,
  BookmarkTree,
  defaultBookmarkFolderId,
  isBookmarkRoot,
  normalizeBookmarkNodes,
  recentBookmarks,
  recentFolders,
  searchBookmarks,
  topLevelSelection,
  type BookmarkTreeNode
} from '../shared/bookmarks'
import {
  parseNetscapeHtml,
  planNetscapeImport,
  serializeNetscapeHtml,
  type NetscapeDocument
} from '../shared/netscape'
import type { BrowserState } from './state'

export interface CreateBookmarkOptions {
  parentId?: string
  /** Position among the parent's children; appended when omitted or out of range. */
  index?: number
  title: string
  url?: string
  type?: BookmarkNodeType
  favicon?: string | null
  dateAdded?: number
}

/** The subset of a node that replicates between devices (see `src/main/sync/records.ts`). */
export interface SyncedBookmarkFields {
  parentId: string
  index: number
  type: BookmarkNodeType
  title: string
  url?: string
  favicon?: string
  dateAdded: number
}

/**
 * The bookmark tree lives in the main state file (`state.bookmarks`, a flat node list in display
 * order). This service is the mutation surface: every write goes through `normalizeBookmarkNodes`
 * so the invariants hold no matter what sync or an import handed us, and tabs' `bookmarked` flag
 * is refreshed alongside.
 */
export class BookmarkService {
  private indexed: BookmarkTree | null = null
  private indexedFor: BookmarkNode[] | null = null
  private clipboard: { mode: 'cut' | 'copy'; ids: string[] } | null = null
  private lastNow = 0

  constructor(private readonly state: BrowserState) {}

  /** Index over the current list; rebuilt whenever the state swapped its node array. */
  get tree(): BookmarkTree {
    if (!this.indexed || this.indexedFor !== this.state.bookmarks) {
      this.indexed = new BookmarkTree(this.state.bookmarks)
      this.indexedFor = this.state.bookmarks
    }
    return this.indexed
  }

  /**
   * Strictly increasing timestamps: two writes in the same millisecond still have a definite
   * "most recent" (the star dialog's recent folders, `recent()`), so recency never depends on
   * array order.
   */
  private now(): number {
    this.lastNow = Math.max(Date.now(), this.lastNow + 1)
    return this.lastNow
  }

  // ---------------------------------------------------------------------------
  // Reads (chrome.bookmarks shaped)
  // ---------------------------------------------------------------------------

  get(id: string): BookmarkNode | null {
    return this.tree.get(id)
  }

  all(): BookmarkNode[] {
    return this.state.bookmarks
  }

  roots(): BookmarkNode[] {
    return this.tree.roots()
  }

  getTree(): BookmarkTreeNode[] {
    return this.tree.tree()
  }

  getChildren(parentId: string): BookmarkNode[] {
    return this.tree.children(parentId)
  }

  getSubTree(id: string): BookmarkTreeNode | null {
    return this.tree.subTree(id)
  }

  /** Ancestors from the root to the parent. */
  path(id: string): BookmarkNode[] {
    return this.tree.path(id)
  }

  pathLabel(id: string): string {
    return this.tree.pathLabel(id)
  }

  has(url: string): boolean {
    return this.tree.hasUrl(url)
  }

  findByUrl(url: string): BookmarkNode[] {
    return this.tree.byUrl(url)
  }

  /** Bookmarks and folders matching every term of the query, best first. */
  search(query: string, limit = Infinity): BookmarkNode[] {
    return searchBookmarks(this.tree, query, limit)
  }

  /** Only bookmarks (for the URL bar); folders never navigate anywhere. */
  searchUrls(query: string, limit = Infinity): BookmarkNode[] {
    return searchBookmarks(this.tree, query, Infinity, 'url').slice(0, limit)
  }

  recent(limit: number): BookmarkNode[] {
    return recentBookmarks(this.tree, limit)
  }

  recentFolders(limit: number): BookmarkNode[] {
    return recentFolders(this.tree, limit)
  }

  /** Where the star files a new bookmark: the folder used last, else the platform default. */
  defaultFolderId(): string {
    const recent = this.recentFolders(1)[0]
    if (recent && (recent.dateGroupModified ?? 0) > 0) return recent.id
    return defaultBookmarkFolderId(this.state.platform)
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  private fallbackFolder(): string {
    return defaultBookmarkFolderId(this.state.platform)
  }

  /** Replace the node list, repair invariants, refresh tabs' star state and persist. */
  private write(nodes: BookmarkNode[]): void {
    this.state.bookmarks = normalizeBookmarkNodes(nodes, this.now(), this.fallbackFolder())
    this.syncTabs()
    this.state.commit()
  }

  private folderOrDefault(parentId: string | undefined): BookmarkNode {
    const folder = parentId ? this.tree.get(parentId) : null
    if (folder && folder.type === 'folder') return folder
    return this.tree.get(this.defaultFolderId()) ?? this.tree.get(this.fallbackFolder())!
  }

  create(options: CreateBookmarkOptions): BookmarkNode | null {
    const type: BookmarkNodeType = options.type ?? (options.url ? 'url' : 'folder')
    if (type === 'url' && !options.url) return null
    const parent = this.folderOrDefault(options.parentId)
    const siblings = this.tree.children(parent.id)
    const at = clampIndex(options.index, siblings.length)
    const now = this.now()
    const node: BookmarkNode = {
      id: newId('bm'),
      parentId: parent.id,
      index: at,
      type,
      title: options.title || options.url || (type === 'folder' ? 'New folder' : ''),
      dateAdded: options.dateAdded ?? now
    }
    if (type === 'url') {
      node.url = options.url
      if (options.favicon) node.favicon = options.favicon
    }
    const nodes = this.state.bookmarks.map((n) => {
      if (n.parentId === parent.id && n.index >= at) return { ...n, index: n.index + 1 }
      if (n.id === parent.id) return { ...n, dateGroupModified: now }
      return n
    })
    nodes.push(node)
    this.write(nodes)
    return this.tree.get(node.id)
  }

  createFolder(parentId: string | undefined, title: string, index?: number): BookmarkNode | null {
    return this.create({ parentId, index, title, type: 'folder' })
  }

  update(
    id: string,
    patch: Partial<Pick<BookmarkNode, 'title' | 'url' | 'favicon'>>
  ): BookmarkNode | null {
    const node = this.tree.get(id)
    if (!node || isBookmarkRoot(id)) return null
    const next: BookmarkNode = { ...node }
    if (patch.title !== undefined) next.title = patch.title
    if (node.type === 'url') {
      if (patch.url) next.url = patch.url
      if (patch.favicon !== undefined) {
        if (patch.favicon) next.favicon = patch.favicon
        else delete next.favicon
      }
    }
    this.write(this.state.bookmarks.map((n) => (n.id === id ? next : n)))
    return this.tree.get(id)
  }

  /**
   * Move nodes (kept in the given order) into `parentId` so the first lands at `index`, counted
   * among the folder's children after the moved nodes are taken out. Roots never move; a folder
   * cannot be moved into itself or its own subtree.
   */
  move(ids: readonly string[], parentId: string, index?: number): boolean {
    const parent = this.tree.get(parentId)
    if (!parent || parent.type !== 'folder') return false
    const moving = topLevelSelection(this.tree, ids).filter(
      (id) => !isBookmarkRoot(id) && id !== parentId && !this.tree.isAncestor(id, parentId)
    )
    if (moving.length === 0) return false
    const movingSet = new Set(moving)
    const siblings = this.tree.children(parentId).filter((c) => !movingSet.has(c.id))
    const at = clampIndex(index, siblings.length)
    const ordered = [
      ...siblings.slice(0, at),
      ...moving.map((id) => this.tree.get(id)!),
      ...siblings.slice(at)
    ]
    const placement = new Map<string, number>()
    ordered.forEach((n, i) => placement.set(n.id, i))
    const now = this.now()
    const touched = new Set<string>([parentId])
    for (const id of moving) {
      const from = this.tree.get(id)!.parentId
      if (from) touched.add(from)
    }
    const nodes = this.state.bookmarks.map((n) => {
      const slot = placement.get(n.id)
      if (slot !== undefined) return { ...n, parentId, index: slot }
      if (touched.has(n.id)) return { ...n, dateGroupModified: now }
      return n
    })
    this.write(nodes)
    return true
  }

  /** chrome.bookmarks.remove: a bookmark or an empty folder. */
  remove(id: string): boolean {
    const node = this.tree.get(id)
    if (!node || isBookmarkRoot(id)) return false
    if (node.type === 'folder' && this.tree.children(id).length) return false
    return this.removeTree(id)
  }

  /** chrome.bookmarks.removeTree: a node with everything below it. */
  removeTree(id: string): boolean {
    const node = this.tree.get(id)
    if (!node || isBookmarkRoot(id)) return false
    const gone = new Set<string>([id, ...this.tree.descendants(id).map((n) => n.id)])
    const now = this.now()
    this.write(
      this.state.bookmarks
        .filter((n) => !gone.has(n.id))
        .map((n) => (n.id === node.parentId ? { ...n, dateGroupModified: now } : n))
    )
    if (this.clipboard) this.clipboard.ids = this.clipboard.ids.filter((x) => !gone.has(x))
    return true
  }

  removeMany(ids: readonly string[]): number {
    let removed = 0
    for (const id of topLevelSelection(this.tree, ids)) if (this.removeTree(id)) removed += 1
    return removed
  }

  removeByUrl(url: string): void {
    for (const node of this.tree.byUrl(url)) this.removeTree(node.id)
  }

  /** Record that the user opened a bookmark. */
  touch(id: string): void {
    const node = this.tree.get(id)
    if (!node || node.type !== 'url') return
    this.write(
      this.state.bookmarks.map((n) => (n.id === id ? { ...n, dateLastUsed: this.now() } : n))
    )
  }

  /** A page reported its icon: fill in bookmarks of that URL that have none yet. */
  updateFavicon(url: string, favicon: string): void {
    if (!favicon) return
    const missing = this.tree.byUrl(url).filter((n) => !n.favicon)
    if (missing.length === 0) return
    const ids = new Set(missing.map((n) => n.id))
    this.write(this.state.bookmarks.map((n) => (ids.has(n.id) ? { ...n, favicon } : n)))
  }

  // ---------------------------------------------------------------------------
  // Cut / copy / paste (an in-app clipboard; the host clipboard gets the URLs as text)
  // ---------------------------------------------------------------------------

  cut(ids: readonly string[]): void {
    const valid = topLevelSelection(this.tree, ids).filter((id) => !isBookmarkRoot(id))
    this.clipboard = valid.length ? { mode: 'cut', ids: valid } : null
  }

  copy(ids: readonly string[]): void {
    const valid = topLevelSelection(this.tree, ids).filter((id) => !isBookmarkRoot(id))
    this.clipboard = valid.length ? { mode: 'copy', ids: valid } : null
  }

  canPaste(): boolean {
    return Boolean(this.clipboard && this.clipboard.ids.some((id) => this.tree.get(id)))
  }

  paste(folderId: string, index?: number): boolean {
    const clip = this.clipboard
    if (!clip) return false
    const ids = clip.ids.filter((id) => this.tree.get(id))
    if (ids.length === 0) return false
    if (clip.mode === 'cut') {
      this.clipboard = null
      return this.move(ids, folderId, index)
    }
    const parent = this.tree.get(folderId)
    if (!parent || parent.type !== 'folder') return false
    const now = this.now()
    const siblings = this.tree.children(folderId)
    let at = clampIndex(index, siblings.length)
    const copies: BookmarkNode[] = []
    const clone = (node: BookmarkNode, parentId: string, idx: number): void => {
      const copy: BookmarkNode = { ...node, id: newId('bm'), parentId, index: idx, dateAdded: now }
      delete copy.dateLastUsed
      if (copy.type === 'folder') copy.dateGroupModified = now
      copies.push(copy)
      if (node.type === 'folder')
        this.tree.children(node.id).forEach((child, i) => clone(child, copy.id, i))
    }
    for (const id of ids) {
      const node = this.tree.get(id)
      if (!node || this.tree.isAncestor(id, folderId)) continue
      clone(node, folderId, at++)
    }
    const shift = copies.filter((c) => c.parentId === folderId).length
    const start = clampIndex(index, siblings.length)
    const nodes = this.state.bookmarks.map((n) => {
      if (n.parentId === folderId && n.index >= start) return { ...n, index: n.index + shift }
      if (n.id === folderId) return { ...n, dateGroupModified: now }
      return n
    })
    this.write([...nodes, ...copies])
    return copies.length > 0
  }

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  /** "Bookmark all tabs": one new folder holding a bookmark per tab, in tab order. */
  bookmarkTabs(tabs: readonly Tab[], folderTitle: string, parentId?: string): BookmarkNode | null {
    const pages = tabs.filter((t) => t.url && !t.url.startsWith('zen://'))
    if (pages.length === 0) return null
    const folder = this.create({ parentId, title: folderTitle, type: 'folder' })
    if (!folder) return null
    const now = this.now()
    const nodes = pages.map((t, index): BookmarkNode => ({
      id: newId('bm'),
      parentId: folder.id,
      index,
      type: 'url',
      title: t.customTitle ?? t.title ?? t.url,
      url: t.url,
      ...(t.favicon ? { favicon: t.favicon } : {}),
      dateAdded: now
    }))
    this.write([...this.state.bookmarks, ...nodes])
    return this.tree.get(folder.id)
  }

  /** Import a Netscape bookmark file the way Chrome does (see `planNetscapeImport`). */
  importHtml(html: string): BookmarkImportResult | null {
    return this.importDocument(parseNetscapeHtml(html), 'Imported')
  }

  /**
   * File a parsed bookmark tree (a Netscape file, another browser's bookmarks brought into the
   * same shape by `core/import`) the way Chrome does: into the roots while the bar is empty,
   * else into one `folderTitle` folder on the bar ("Imported", "Imported From Firefox"), numbered
   * when that name is taken.
   */
  importDocument(doc: NetscapeDocument, folderTitle: string): BookmarkImportResult | null {
    if (doc.items.length === 0) return null
    const bar = this.tree.children(BOOKMARKS_BAR_ID)
    const titles = new Set(bar.map((n) => n.title))
    let importedTitle = folderTitle
    for (let n = 2; titles.has(importedTitle); n++) importedTitle = `${folderTitle} (${n})`
    const plan = planNetscapeImport(doc, {
      barIsEmpty: bar.length === 0,
      nextIndex: (parentId) => this.tree.children(parentId).length,
      newId: () => newId('bm'),
      now: this.now(),
      importedFolderTitle: importedTitle
    })
    if (plan.nodes.length === 0) return null
    const now = this.now()
    const parents = new Set(plan.nodes.map((n) => n.parentId))
    this.write([
      ...this.state.bookmarks.map((n) =>
        parents.has(n.id) ? { ...n, dateGroupModified: now } : n
      ),
      ...plan.nodes
    ])
    return { bookmarks: plan.bookmarks, folders: plan.folders, folderId: plan.folderId }
  }

  exportHtml(product: string): string {
    return serializeNetscapeHtml(this.tree, { product, now: Date.now() })
  }

  // ---------------------------------------------------------------------------
  // Sync (the engine repairs and commits once per batch)
  // ---------------------------------------------------------------------------

  /** Upsert a node from a remote record. Local-only metadata (last used, group modified) is kept. */
  applySynced(id: string, data: SyncedBookmarkFields): void {
    if (isBookmarkRoot(id)) return
    const existing = this.tree.get(id)
    const node: BookmarkNode = {
      id,
      parentId: data.parentId,
      index: data.index,
      type: data.type,
      title: data.title,
      dateAdded: data.dateAdded
    }
    if (data.type === 'url') {
      node.url = data.url
      if (data.favicon) node.favicon = data.favicon
      if (existing?.dateLastUsed) node.dateLastUsed = existing.dateLastUsed
    } else if (existing?.dateGroupModified) {
      node.dateGroupModified = existing.dateGroupModified
    }
    if (node.type === 'url' && !node.url) return
    this.state.bookmarks = [...this.state.bookmarks.filter((n) => n.id !== id), node]
  }

  removeSynced(id: string): void {
    if (isBookmarkRoot(id)) return
    this.state.bookmarks = this.state.bookmarks.filter((n) => n.id !== id)
  }

  /** Refresh `tab.bookmarked` for every tab (the state repair does the same on load). */
  syncTabs(): void {
    const tree = this.tree
    for (const tab of Object.values(this.state.model.tabs)) tab.bookmarked = tree.hasUrl(tab.url)
  }
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length
  return Math.max(0, Math.min(Math.floor(index), length))
}
