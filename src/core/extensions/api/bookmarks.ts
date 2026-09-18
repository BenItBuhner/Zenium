/**
 * `chrome.bookmarks`, the host-neutral part: Chrome's `BookmarkTreeNode` shape over Zenium's
 * bookmark tree (`shared/bookmarks`), the argument checks and error strings of
 * `bookmarks_api.cc`, the `search` matching of `bookmark_utils.cc`, and the tree differ that
 * turns one model commit into `onCreated` / `onRemoved` / `onChanged` / `onMoved` /
 * `onChildrenReordered` deliveries. Hosts own the model (`BookmarkService`) and the fan-out.
 *
 * Ids map one to one: Zenium's tree already uses Chrome's permanent folder ids (`1` bookmarks
 * bar, `2` other bookmarks, `3` mobile bookmarks); Chrome's invisible root `0` is synthesised
 * here as their parent. Other node ids are Zenium's (`bm_<uuid>`), opaque strings as the API
 * declares them.
 */
import type { BookmarkNode } from '../../../shared/types'
import {
  BOOKMARKS_BAR_ID,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  isBookmarkRoot,
  type BookmarkTree
} from '../../../shared/bookmarks'

/** Chrome's root node: the parent of the permanent folders, never shown, never modified. */
export const BOOKMARKS_ROOT_ID = '0'

export type BookmarkFolderType = 'bookmarks-bar' | 'other' | 'mobile' | 'managed'

/** `bookmarks.BookmarkTreeNode` as extensions see it. */
export interface ChromeBookmarkNode {
  id: string
  parentId?: string
  index?: number
  url?: string
  title: string
  dateAdded?: number
  dateGroupModified?: number
  dateLastUsed?: number
  folderType?: BookmarkFolderType
  /** Chrome 114+: whether the node is in the account-synced part of the tree. */
  syncing: boolean
  children?: ChromeBookmarkNode[]
}

export interface BookmarkCreatePlan {
  parentId: string
  index?: number
  title: string
  url?: string
}

export interface BookmarkMovePlan {
  parentId: string
  /** The index as `BookmarkService.move` counts it: among the siblings once the node is out. */
  index: number
}

export interface BookmarkUpdatePlan {
  title?: string
  url?: string
}

export interface BookmarkSearchQuery {
  query?: string
  url?: string
  title?: string
}

export type BookmarkEvent =
  | { event: 'onCreated'; args: [string, ChromeBookmarkNode] }
  | {
      event: 'onRemoved'
      args: [string, { parentId: string; index: number; node: ChromeBookmarkNode }]
    }
  | { event: 'onChanged'; args: [string, { title: string; url?: string }] }
  | {
      event: 'onMoved'
      args: [string, { parentId: string; index: number; oldParentId: string; oldIndex: number }]
    }
  | { event: 'onChildrenReordered'; args: [string, { childIds: string[] }] }
  | { event: 'onImportBegan'; args: [] }
  | { event: 'onImportEnded'; args: [] }

// Chrome's messages, verbatim (`bookmark_api_constants.cc`).
export const ERROR_NO_NODE = "Can't find bookmark for id."
export const ERROR_NO_PARENT = "Can't find parent bookmark for id."
export const ERROR_FOLDER_NOT_EMPTY = "Can't remove non-empty folder (use recursive to force)."
export const ERROR_INVALID_ID = 'Bookmark id is invalid.'
export const ERROR_INVALID_INDEX = 'Index out of bounds.'
export const ERROR_INVALID_PARENT = 'Parent is not a folder.'
export const ERROR_INVALID_URL = 'Invalid URL.'
export const ERROR_MODIFY_SPECIAL = "Can't modify the root bookmark folders."
export const ERROR_INVALID_MOVE_DESTINATION = "Can't move a folder to itself or its descendant."
export const ERROR_CANNOT_SET_URL_OF_FOLDER = "Can't set URL of a bookmark folder."
export const ERROR_INVALID_PARAM = 'Invalid parameter.'
export const ERROR_NO_PERMISSION = "The 'bookmarks' permission is required."

/** A failure `bookmarks.*` reports through `runtime.lastError`. */
export class BookmarkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BookmarkError'
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const FOLDER_TYPES: Readonly<Record<string, BookmarkFolderType>> = {
  [BOOKMARKS_BAR_ID]: 'bookmarks-bar',
  [OTHER_BOOKMARKS_ID]: 'other',
  [MOBILE_BOOKMARKS_ID]: 'mobile'
}

/** One node in Chrome's shape; `recurse` attaches the subtree (`getTree`, `getSubTree`). */
export function toChromeNode(
  node: BookmarkNode,
  tree: BookmarkTree,
  recurse: boolean
): ChromeBookmarkNode {
  const out: ChromeBookmarkNode = {
    id: node.id,
    parentId: node.parentId ?? BOOKMARKS_ROOT_ID,
    index: node.index,
    title: node.title,
    dateAdded: node.dateAdded,
    syncing: false
  }
  if (node.type === 'url') {
    out.url = node.url ?? ''
    if (node.dateLastUsed) out.dateLastUsed = node.dateLastUsed
    return out
  }
  if (node.dateGroupModified) out.dateGroupModified = node.dateGroupModified
  const folderType = FOLDER_TYPES[node.id]
  if (folderType) out.folderType = folderType
  if (recurse) out.children = tree.children(node.id).map((c) => toChromeNode(c, tree, true))
  return out
}

/** Chrome's root `0`: no parent, no index, an empty title, the permanent folders as children. */
export function rootChromeNode(tree: BookmarkTree, recurse: boolean): ChromeBookmarkNode {
  const out: ChromeBookmarkNode = { id: BOOKMARKS_ROOT_ID, title: '', dateAdded: 0, syncing: false }
  const roots = tree.roots()
  const first = roots[0]
  if (first) out.dateAdded = first.dateAdded
  if (recurse) out.children = roots.map((r) => toChromeNode(r, tree, true))
  return out
}

/** The node an id names, root included; null when there is none. */
export function chromeNodeFor(
  tree: BookmarkTree,
  id: string,
  recurse: boolean
): ChromeBookmarkNode | null {
  if (id === BOOKMARKS_ROOT_ID) return rootChromeNode(tree, recurse)
  const node = tree.get(id)
  return node ? toChromeNode(node, tree, recurse) : null
}

/** `getChildren`: the permanent folders for the root, a folder's children in index order. */
export function chromeChildrenOf(tree: BookmarkTree, id: string): ChromeBookmarkNode[] {
  if (id === BOOKMARKS_ROOT_ID) return tree.roots().map((r) => toChromeNode(r, tree, false))
  return tree.children(id).map((c) => toChromeNode(c, tree, false))
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `get(idOrIdList)`: one id or a non-empty list of ids, all strings. */
export function normalizeIdList(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw) && raw.length > 0 && raw.every((id) => typeof id === 'string')) {
    return raw as string[]
  }
  throw new BookmarkError(ERROR_INVALID_ID)
}

/** `getRecent(numberOfItems)`: a positive count. */
export function normalizeRecentCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new BookmarkError(ERROR_INVALID_PARAM)
  }
  return raw
}

/** GURL validity as `new URL` sees it; the canonical form is what Chrome stores. */
export function canonicalBookmarkUrl(raw: string): string | null {
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BookmarkError(`Invalid value for '${name}'.`)
  return value
}

function optionalIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BookmarkError(ERROR_INVALID_INDEX)
  }
  return value
}

/** The folder a write names: exists, is a folder, is not the invisible root. */
function requireFolder(tree: BookmarkTree, parentId: string): BookmarkNode {
  if (parentId === BOOKMARKS_ROOT_ID) throw new BookmarkError(ERROR_MODIFY_SPECIAL)
  const parent = tree.get(parentId)
  if (!parent) throw new BookmarkError(ERROR_NO_PARENT)
  if (parent.type !== 'folder') throw new BookmarkError(ERROR_INVALID_PARENT)
  return parent
}

/** A node a write names: exists and is neither the root nor a permanent folder. */
function requireModifiable(tree: BookmarkTree, id: string): BookmarkNode {
  if (id === BOOKMARKS_ROOT_ID || isBookmarkRoot(id)) throw new BookmarkError(ERROR_MODIFY_SPECIAL)
  const node = tree.get(id)
  if (!node) throw new BookmarkError(ERROR_NO_NODE)
  return node
}

/**
 * `create(bookmark)`: the parent defaults to Other bookmarks, an omitted or empty URL makes a
 * folder, the index must lie within the parent's children (the end included).
 */
export function planCreate(tree: BookmarkTree, raw: unknown): BookmarkCreatePlan {
  if (!isRecord(raw)) throw new BookmarkError(ERROR_INVALID_PARAM)
  const parentId = optionalString(raw.parentId, 'parentId') ?? OTHER_BOOKMARKS_ID
  const parent = requireFolder(tree, parentId)
  const index = optionalIndex(raw.index)
  if (index !== undefined && index > tree.children(parent.id).length) {
    throw new BookmarkError(ERROR_INVALID_INDEX)
  }
  const title = optionalString(raw.title, 'title') ?? ''
  const rawUrl = optionalString(raw.url, 'url')
  const plan: BookmarkCreatePlan = { parentId: parent.id, title }
  if (index !== undefined) plan.index = index
  if (rawUrl) {
    const url = canonicalBookmarkUrl(rawUrl)
    if (!url) throw new BookmarkError(ERROR_INVALID_URL)
    plan.url = url
  }
  return plan
}

/**
 * `move(id, destination)`: Chrome's index counts the destination's children before the node
 * leaves its slot ("insert before the child now at `index`"); the model counts them after, so a
 * move down inside the same folder is one less.
 */
export function planMove(tree: BookmarkTree, id: string, raw: unknown): BookmarkMovePlan {
  const node = requireModifiable(tree, id)
  const destination = isRecord(raw) ? raw : {}
  const parentId = optionalString(destination.parentId, 'parentId') ?? node.parentId ?? ''
  const parent = requireFolder(tree, parentId)
  if (parent.id === id || tree.isAncestor(id, parent.id)) {
    throw new BookmarkError(ERROR_INVALID_MOVE_DESTINATION)
  }
  const siblings = tree.children(parent.id)
  const index = optionalIndex(destination.index)
  if (index !== undefined && index > siblings.length) throw new BookmarkError(ERROR_INVALID_INDEX)
  const sameParent = node.parentId === parent.id
  if (index === undefined) return { parentId: parent.id, index: siblings.length }
  return { parentId: parent.id, index: sameParent && index > node.index ? index - 1 : index }
}

/** `update(id, changes)`: a title for any node, a valid URL for bookmarks only. */
export function planUpdate(tree: BookmarkTree, id: string, raw: unknown): BookmarkUpdatePlan {
  const node = requireModifiable(tree, id)
  if (!isRecord(raw)) throw new BookmarkError(ERROR_INVALID_PARAM)
  const plan: BookmarkUpdatePlan = {}
  const title = optionalString(raw.title, 'title')
  if (title !== undefined) plan.title = title
  const rawUrl = optionalString(raw.url, 'url')
  if (rawUrl !== undefined) {
    if (node.type !== 'url') throw new BookmarkError(ERROR_CANNOT_SET_URL_OF_FOLDER)
    const url = canonicalBookmarkUrl(rawUrl)
    if (!url) throw new BookmarkError(ERROR_INVALID_URL)
    plan.url = url
  }
  return plan
}

/** `remove` / `removeTree`: the node to take out, once Chrome's refusals are checked. */
export function planRemove(tree: BookmarkTree, id: string, recursive: boolean): BookmarkNode {
  const node = requireModifiable(tree, id)
  if (!recursive && node.type === 'folder' && tree.children(id).length > 0) {
    throw new BookmarkError(ERROR_FOLDER_NOT_EMPTY)
  }
  return node
}

/** `search(query)`: a word query string, or an object with any of `query`, `url`, `title`. */
export function normalizeSearchQuery(raw: unknown): BookmarkSearchQuery {
  if (typeof raw === 'string') return { query: raw }
  if (!isRecord(raw)) throw new BookmarkError(ERROR_INVALID_PARAM)
  const out: BookmarkSearchQuery = {}
  const query = optionalString(raw.query, 'query')
  const url = optionalString(raw.url, 'url')
  const title = optionalString(raw.title, 'title')
  if (query !== undefined) out.query = query
  if (url !== undefined) out.url = url
  if (title !== undefined) out.title = title
  return out
}

/**
 * `GetBookmarksMatchingProperties`: the word query narrows first (the model's ranked search
 * stands in for Chrome's title / URL word match), then `title` must equal and `url` must equal
 * after canonicalisation; folders never match a URL; the permanent folders never match at all.
 * A word query with nothing to match returns nothing, an empty object query returns everything.
 */
export function searchBookmarkNodes(
  tree: BookmarkTree,
  query: BookmarkSearchQuery,
  wordSearch: (words: string) => BookmarkNode[]
): BookmarkNode[] {
  let candidates: BookmarkNode[]
  if (query.query !== undefined) {
    if (!query.query.trim()) return []
    candidates = wordSearch(query.query)
  } else {
    candidates = tree.flat()
  }
  let url: string | null | undefined
  if (query.url !== undefined) {
    url = canonicalBookmarkUrl(query.url)
    if (url === null) return []
  }
  return candidates.filter((node) => {
    if (isBookmarkRoot(node.id)) return false
    if (query.title !== undefined && node.title !== query.title) return false
    if (url !== undefined) {
      if (node.type !== 'url') return false
      const own = canonicalBookmarkUrl(node.url ?? '') ?? node.url
      if (own !== url) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/** Positions (into `order`) of one longest run that kept its previous relative order. */
function stableRun(order: readonly number[]): Set<number> {
  const tails: number[] = []
  const tailIndex: number[] = []
  const prevIndex = new Array<number>(order.length).fill(-1)
  for (let i = 0; i < order.length; i += 1) {
    const value = order[i]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < value) lo = mid + 1
      else hi = mid
    }
    tails[lo] = value
    tailIndex[lo] = i
    prevIndex[i] = lo > 0 ? tailIndex[lo - 1] : -1
  }
  const kept = new Set<number>()
  let at = tailIndex.length > 0 ? tailIndex[tailIndex.length - 1] : -1
  while (at >= 0) {
    kept.add(at)
    at = prevIndex[at]
  }
  return kept
}

/**
 * The `bookmarks.on*` deliveries one model commit amounts to, from the tree before and after.
 * The model exposes no change feed; it replaces the node list on every write, so the host
 * diffs. Chrome fires one `onRemoved` per removed subtree (the top node, with its children),
 * one `onCreated` per node (parents first), `onChanged` for title / URL edits, `onMoved` for a
 * node that changed folder or slot, and `onChildrenReordered` where a folder's children were
 * rearranged wholesale. Siblings whose index shifted because a neighbour came or went are not
 * moves. Several nodes arriving in one commit (an import, "bookmark all tabs", a sync batch)
 * are bracketed by `onImportBegan` / `onImportEnded`, which is how Chrome tells extensions to
 * hold their tree updates and re-read once.
 */
export function diffBookmarkTrees(prev: BookmarkTree, next: BookmarkTree): BookmarkEvent[] {
  const events: BookmarkEvent[] = []

  for (const before of prev.flat()) {
    if (next.get(before.id) || isBookmarkRoot(before.id)) continue
    // Below a removed folder: reported once, as part of that folder's subtree.
    if (before.parentId !== null && !next.get(before.parentId)) continue
    events.push({
      event: 'onRemoved',
      args: [
        before.id,
        {
          parentId: before.parentId ?? BOOKMARKS_ROOT_ID,
          index: before.index,
          node: toChromeNode(before, prev, true)
        }
      ]
    })
  }

  const created: BookmarkEvent[] = []
  for (const after of next.flat()) {
    if (prev.get(after.id) || isBookmarkRoot(after.id)) continue
    created.push({ event: 'onCreated', args: [after.id, toChromeNode(after, next, false)] })
  }
  if (created.length > 1) events.push({ event: 'onImportBegan', args: [] })
  events.push(...created)
  if (created.length > 1) events.push({ event: 'onImportEnded', args: [] })

  // Nodes that changed folder are moves outright; the rest are judged folder by folder.
  const persistent = new Map<string, BookmarkNode[]>()
  for (const after of next.flat()) {
    const before = prev.get(after.id)
    if (!before || isBookmarkRoot(after.id)) continue
    if (before.parentId !== after.parentId) {
      events.push({
        event: 'onMoved',
        args: [
          after.id,
          {
            parentId: after.parentId ?? BOOKMARKS_ROOT_ID,
            index: after.index,
            oldParentId: before.parentId ?? BOOKMARKS_ROOT_ID,
            oldIndex: before.index
          }
        ]
      })
      continue
    }
    const key = after.parentId ?? BOOKMARKS_ROOT_ID
    const list = persistent.get(key)
    if (list) list.push(after)
    else persistent.set(key, [after])
  }
  for (const [parentId, children] of persistent) {
    const previousOrder = children.map((child) => prev.get(child.id)!.index)
    const kept = stableRun(previousOrder)
    const moved = children.filter((_, i) => !kept.has(i))
    if (moved.length === 0) continue
    if (moved.length === 1) {
      const after = moved[0]
      const before = prev.get(after.id)!
      events.push({
        event: 'onMoved',
        args: [
          after.id,
          { parentId, index: after.index, oldParentId: parentId, oldIndex: before.index }
        ]
      })
      continue
    }
    events.push({
      event: 'onChildrenReordered',
      args: [parentId, { childIds: next.children(parentId).map((c) => c.id) }]
    })
  }

  for (const after of next.flat()) {
    const before = prev.get(after.id)
    if (!before || isBookmarkRoot(after.id)) continue
    if (before.title === after.title && before.url === after.url) continue
    const change: { title: string; url?: string } = { title: after.title }
    if (after.type === 'url') change.url = after.url ?? ''
    events.push({ event: 'onChanged', args: [after.id, change] })
  }

  return events
}
