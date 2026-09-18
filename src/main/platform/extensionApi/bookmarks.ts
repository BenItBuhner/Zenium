import type { BookmarkNode } from '../../../shared/types'
import { BookmarkTree } from '../../../shared/bookmarks'
import type { BookmarkService } from '../../../core/bookmarks'
import {
  BookmarkError,
  ERROR_NO_NODE,
  ERROR_NO_PERMISSION,
  chromeChildrenOf,
  chromeNodeFor,
  diffBookmarkTrees,
  normalizeIdList,
  normalizeRecentCount,
  normalizeSearchQuery,
  planCreate,
  planMove,
  planRemove,
  planUpdate,
  rootChromeNode,
  searchBookmarkNodes,
  toChromeNode,
  type ChromeBookmarkNode
} from '../../../core/extensions/api/bookmarks'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/**
 * `chrome.bookmarks` over Zenium's bookmark tree (`core/bookmarks`, owned by the services
 * program): reads straight from the indexed tree in Chrome's node shape, writes through the
 * service after Chrome's own refusals (`core/extensions/api/bookmarks`), and events from a
 * diff of the node list the model swaps on every write, run from the router's tick.
 */
export class BookmarksApi {
  /** The node list the last diff ran against; the model replaces the array on every write. */
  private seen: BookmarkNode[] | null = null

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, idOrIdList) => this.get(ctx, idOrIdList),
    getChildren: (ctx, id) => this.getChildren(ctx, id),
    getRecent: (ctx, numberOfItems) => this.getRecent(ctx, numberOfItems),
    getTree: (ctx) => this.getTree(ctx),
    getSubTree: (ctx, id) => this.getSubTree(ctx, id),
    search: (ctx, query) => this.search(ctx, query),
    create: (ctx, bookmark) => this.create(ctx, bookmark),
    move: (ctx, id, destination) => this.move(ctx, id, destination),
    update: (ctx, id, changes) => this.update(ctx, id, changes),
    remove: (ctx, id) => this.remove(ctx, id),
    removeTree: (ctx, id) => this.removeTree(ctx, id)
  }

  private get service(): BookmarkService {
    return this.host.browser.bookmarks
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!hasBookmarks(this.host, ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  private requireId(id: unknown): string {
    if (typeof id !== 'string') throw new ApiError(ERROR_NO_NODE)
    return id
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private get(ctx: ApiContext, raw: unknown): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    const tree = this.service.tree
    return checked(() => normalizeIdList(raw)).map((id) => {
      const node = chromeNodeFor(tree, id, false)
      if (!node) throw new ApiError(ERROR_NO_NODE)
      return node
    })
  }

  private getChildren(ctx: ApiContext, raw: unknown): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    const id = this.requireId(raw)
    const tree = this.service.tree
    if (!chromeNodeFor(tree, id, false)) throw new ApiError(ERROR_NO_NODE)
    return chromeChildrenOf(tree, id)
  }

  private getRecent(ctx: ApiContext, raw: unknown): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    const count = checked(() => normalizeRecentCount(raw))
    const tree = this.service.tree
    return this.service.recent(count).map((node) => toChromeNode(node, tree, false))
  }

  private getTree(ctx: ApiContext): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    return [rootChromeNode(this.service.tree, true)]
  }

  private getSubTree(ctx: ApiContext, raw: unknown): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    const node = chromeNodeFor(this.service.tree, this.requireId(raw), true)
    if (!node) throw new ApiError(ERROR_NO_NODE)
    return [node]
  }

  private search(ctx: ApiContext, raw: unknown): ChromeBookmarkNode[] {
    this.requirePermission(ctx.extension)
    const query = checked(() => normalizeSearchQuery(raw))
    const tree = this.service.tree
    const nodes = searchBookmarkNodes(tree, query, (words) => this.service.search(words))
    return nodes.map((node) => toChromeNode(node, tree, false))
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  private create(ctx: ApiContext, raw: unknown): ChromeBookmarkNode {
    this.requirePermission(ctx.extension)
    const plan = checked(() => planCreate(this.service.tree, raw))
    const node = this.service.create({
      parentId: plan.parentId,
      index: plan.index,
      title: plan.title,
      url: plan.url,
      type: plan.url ? 'url' : 'folder'
    })
    if (!node) throw new ApiError(ERROR_NO_NODE)
    this.host.scheduleTick()
    return toChromeNode(node, this.service.tree, false)
  }

  private move(ctx: ApiContext, rawId: unknown, raw: unknown): ChromeBookmarkNode {
    this.requirePermission(ctx.extension)
    const id = this.requireId(rawId)
    const plan = checked(() => planMove(this.service.tree, id, raw))
    this.service.move([id], plan.parentId, plan.index)
    this.host.scheduleTick()
    return this.nodeAfterWrite(id)
  }

  private update(ctx: ApiContext, rawId: unknown, raw: unknown): ChromeBookmarkNode {
    this.requirePermission(ctx.extension)
    const id = this.requireId(rawId)
    const plan = checked(() => planUpdate(this.service.tree, id, raw))
    this.service.update(id, plan)
    this.host.scheduleTick()
    return this.nodeAfterWrite(id)
  }

  private remove(ctx: ApiContext, rawId: unknown): void {
    this.requirePermission(ctx.extension)
    const id = this.requireId(rawId)
    checked(() => planRemove(this.service.tree, id, false))
    this.service.remove(id)
    this.host.scheduleTick()
  }

  private removeTree(ctx: ApiContext, rawId: unknown): void {
    this.requirePermission(ctx.extension)
    const id = this.requireId(rawId)
    checked(() => planRemove(this.service.tree, id, true))
    this.service.removeTree(id)
    this.host.scheduleTick()
  }

  private nodeAfterWrite(id: string): ChromeBookmarkNode {
    const node = chromeNodeFor(this.service.tree, id, false)
    if (!node) throw new ApiError(ERROR_NO_NODE)
    return node
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Called from the router's tick: when the model swapped its node list since the last look,
   * fan the difference out to the extensions holding `bookmarks`. The first look after the
   * first extension loads is the baseline, not a burst of `onCreated`.
   */
  tick(): void {
    const nodes = this.service.all()
    const prev = this.seen
    if (prev === nodes) return
    this.seen = nodes
    if (!prev) return
    if (!this.host.allLoaded().some((ext) => hasBookmarks(this.host, ext))) return
    const events = diffBookmarkTrees(new BookmarkTree(prev), new BookmarkTree(nodes))
    for (const { event, args } of events) {
      this.host.broadcast('bookmarks', event, (ext) =>
        hasBookmarks(this.host, ext) ? [...args] : null
      )
    }
  }

  /** No extension loaded: the next load starts from a fresh baseline. */
  reset(): void {
    this.seen = null
  }
}

function hasBookmarks(host: ApiHost, ext: LoadedExtension): boolean {
  return host.grants(ext.id).permissions.includes('bookmarks')
}

/** Chrome's argument errors become `runtime.lastError` messages, verbatim. */
function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof BookmarkError) throw new ApiError(error.message)
    throw error
  }
}
