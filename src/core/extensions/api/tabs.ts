/**
 * The `chrome.tabs` data model: Chrome's `Tab` shape, `tabs.query` filter matching and the
 * `changeInfo` diff behind `tabs.onUpdated`. Pure functions – hosts build `ChromeTab` records
 * from their own tab model and feed them through here.
 */
import { globToRegExp, matchesAnyPattern } from './matchPattern'

export const TAB_ID_NONE = -1
export const WINDOW_ID_NONE = -1
export const WINDOW_ID_CURRENT = -2
export const TAB_GROUP_NONE = -1

export type TabStatus = 'unloaded' | 'loading' | 'complete'

export interface MutedInfo {
  muted: boolean
  reason?: 'user' | 'capture' | 'extension'
  extensionId?: string
}

export interface ChromeTab {
  id: number
  index: number
  windowId: number
  active: boolean
  highlighted: boolean
  selected: boolean
  pinned: boolean
  url?: string
  pendingUrl?: string
  title?: string
  favIconUrl?: string
  status: TabStatus
  audible: boolean
  mutedInfo: MutedInfo
  discarded: boolean
  frozen: boolean
  autoDiscardable: boolean
  incognito: boolean
  groupId: number
  openerTabId?: number
  width?: number
  height?: number
  lastAccessed?: number
}

export interface TabQueryInfo {
  active?: boolean
  audible?: boolean
  autoDiscardable?: boolean
  currentWindow?: boolean
  discarded?: boolean
  frozen?: boolean
  groupId?: number
  highlighted?: boolean
  index?: number
  lastFocusedWindow?: boolean
  muted?: boolean
  pinned?: boolean
  status?: TabStatus
  title?: string
  url?: string | string[]
  windowId?: number
  windowType?: 'normal' | 'popup' | 'panel' | 'app' | 'devtools'
}

export interface TabQueryContext {
  /** Window of the calling context (`WINDOW_ID_NONE` when it has none, e.g. a service worker). */
  currentWindowId: number
  lastFocusedWindowId: number
  windowTypeOf(windowId: number): 'normal' | 'popup'
}

/** Chrome's `tabs.query` filter semantics, applied to one tab. */
export function tabMatchesQuery(tab: ChromeTab, q: TabQueryInfo, ctx: TabQueryContext): boolean {
  if (q.active !== undefined && tab.active !== q.active) return false
  if (q.audible !== undefined && tab.audible !== q.audible) return false
  if (q.autoDiscardable !== undefined && tab.autoDiscardable !== q.autoDiscardable) return false
  if (q.discarded !== undefined && tab.discarded !== q.discarded) return false
  if (q.frozen !== undefined && tab.frozen !== q.frozen) return false
  if (q.groupId !== undefined && tab.groupId !== q.groupId) return false
  if (q.highlighted !== undefined && tab.highlighted !== q.highlighted) return false
  if (q.index !== undefined && tab.index !== q.index) return false
  if (q.muted !== undefined && tab.mutedInfo.muted !== q.muted) return false
  if (q.pinned !== undefined && tab.pinned !== q.pinned) return false
  if (q.status !== undefined && tab.status !== q.status) return false
  if (q.windowId !== undefined) {
    const wanted = q.windowId === WINDOW_ID_CURRENT ? ctx.currentWindowId : q.windowId
    if (tab.windowId !== wanted) return false
  }
  if (q.currentWindow === true && tab.windowId !== ctx.currentWindowId) return false
  if (q.currentWindow === false && tab.windowId === ctx.currentWindowId) return false
  if (q.lastFocusedWindow === true && tab.windowId !== ctx.lastFocusedWindowId) return false
  if (q.lastFocusedWindow === false && tab.windowId === ctx.lastFocusedWindowId) return false
  if (q.windowType !== undefined && ctx.windowTypeOf(tab.windowId) !== q.windowType) return false
  if (q.title !== undefined && !globToRegExp(q.title).test(tab.title ?? '')) return false
  if (q.url !== undefined && !matchesAnyPattern(tab.url ?? '', q.url)) return false
  return true
}

export interface TabChangeInfo {
  audible?: boolean
  autoDiscardable?: boolean
  discarded?: boolean
  favIconUrl?: string
  frozen?: boolean
  groupId?: number
  mutedInfo?: MutedInfo
  pinned?: boolean
  status?: TabStatus
  title?: string
  url?: string
}

/** The `changeInfo` Chrome passes to `tabs.onUpdated`; `null` when nothing it reports changed. */
export function tabChangeInfo(before: ChromeTab, after: ChromeTab): TabChangeInfo | null {
  const info: TabChangeInfo = {}
  let changed = false
  if (before.status !== after.status) {
    info.status = after.status
    changed = true
  }
  if (before.url !== after.url) {
    info.url = after.url
    changed = true
  }
  if (before.title !== after.title && after.title !== undefined) {
    info.title = after.title
    changed = true
  }
  if (before.favIconUrl !== after.favIconUrl && after.favIconUrl !== undefined) {
    info.favIconUrl = after.favIconUrl
    changed = true
  }
  if (before.pinned !== after.pinned) {
    info.pinned = after.pinned
    changed = true
  }
  if (before.audible !== after.audible) {
    info.audible = after.audible
    changed = true
  }
  if (before.mutedInfo.muted !== after.mutedInfo.muted) {
    info.mutedInfo = after.mutedInfo
    changed = true
  }
  if (before.discarded !== after.discarded) {
    info.discarded = after.discarded
    changed = true
  }
  if (before.frozen !== after.frozen) {
    info.frozen = after.frozen
    changed = true
  }
  if (before.autoDiscardable !== after.autoDiscardable) {
    info.autoDiscardable = after.autoDiscardable
    changed = true
  }
  if (before.groupId !== after.groupId) {
    info.groupId = after.groupId
    changed = true
  }
  return changed ? info : null
}

export interface TabMove<Id = number> {
  tabId: Id
  fromIndex: number
  toIndex: number
}

/**
 * Which tabs of a window moved between two orderings of the same tab set. A single drag shifts
 * every tab in between by one; like Chrome, only the tab that was actually moved is reported
 * when one move explains the whole change, otherwise every displaced tab is.
 */
export function detectTabMoves<Id>(before: readonly Id[], after: readonly Id[]): TabMove<Id>[] {
  if (before.length !== after.length) return []
  const beforeIndex = new Map<Id, number>()
  before.forEach((id, i) => beforeIndex.set(id, i))
  // A different tab set is a creation or removal, which shifts indices without a move event.
  if (after.some((id) => !beforeIndex.has(id))) return []
  const displaced: TabMove<Id>[] = []
  after.forEach((id, toIndex) => {
    const fromIndex = beforeIndex.get(id)
    if (fromIndex !== undefined && fromIndex !== toIndex)
      displaced.push({ tabId: id, fromIndex, toIndex })
  })
  if (displaced.length === 0) return []
  let best = displaced[0]
  for (const move of displaced) {
    if (Math.abs(move.toIndex - move.fromIndex) > Math.abs(best.toIndex - best.fromIndex))
      best = move
  }
  const withoutBefore = before.filter((id) => id !== best.tabId)
  const withoutAfter = after.filter((id) => id !== best.tabId)
  const singleMove = withoutBefore.every((id, i) => withoutAfter[i] === id)
  return singleMove ? [best] : displaced
}
