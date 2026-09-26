import type { ReadingListEntry } from './types'

/**
 * The reading list's pure rules (W6-1, bookmarks-33; Chrome's `chrome.readingList`), shared by
 * the desktop's `ReadingListService` (`core/readingList.ts`), the chrome that draws the list and
 * the phone once it has a surface for it: the cap, the order, the sanitiser a loaded profile
 * goes through and the unread count. Nothing here touches the state or the clock.
 */

/**
 * How many entries the list holds (Chrome's is unbounded; a thousand pages "for later" is more
 * than anyone reads back). Past it the oldest READ entry goes first – a page already read is
 * the one the list can spare – and only when every entry is unread does the oldest unread one.
 */
export const READING_LIST_CAP = 1000

export function emptyReadingList(): ReadingListEntry[] {
  return []
}

/** `true` while the entry waits to be read. */
export function isUnread(entry: ReadingListEntry): boolean {
  return entry.readAt === undefined
}

/** How many entries wait to be read: the bar control's badge, the page's Unread heading. */
export function unreadReadingCount(entries: readonly ReadingListEntry[]): number {
  let n = 0
  for (const entry of entries) if (isUnread(entry)) n++
  return n
}

/**
 * The list's one order: the unread entries first, then the read ones, each half newest first
 * by `addedAt`; ties (a clock that stood still) fall back to the id so the order is total and
 * two renders never disagree.
 */
export function sortReadingList(entries: readonly ReadingListEntry[]): ReadingListEntry[] {
  return [...entries].sort(compareReadingEntries)
}

export function compareReadingEntries(a: ReadingListEntry, b: ReadingListEntry): number {
  const ua = isUnread(a) ? 0 : 1
  const ub = isUnread(b) ? 0 : 1
  if (ua !== ub) return ua - ub
  if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The list within its cap: while it runs over, the oldest read entry drops, then – with no
 * read entry left – the oldest unread one. Returns the entries handed in (same array) when
 * nothing had to go, so a caller can tell a no-op from a write.
 */
export function trimReadingList(
  entries: ReadingListEntry[],
  cap: number = READING_LIST_CAP
): ReadingListEntry[] {
  if (entries.length <= cap) return entries
  // Oldest read first, then oldest unread: the reverse of the display order, so dropping from
  // the back of a sorted copy is the cap's rule.
  const kept = sortReadingList(entries).slice(0, Math.max(0, cap))
  const keep = new Set(kept.map((e) => e.id))
  return entries.filter((e) => keep.has(e.id))
}

/**
 * `raw` as a reading list: an array of well-formed entries, anything else – a missing key, a
 * malformed entry, a duplicate id or URL (the later one wins, as a sync would have it) – dropped
 * rather than loaded, and the whole cut to the cap. A profile from before the list existed
 * loads it empty.
 */
export function sanitizeReadingList(raw: unknown): ReadingListEntry[] {
  if (!Array.isArray(raw)) return []
  const byUrl = new Map<string, ReadingListEntry>()
  const ids = new Set<string>()
  for (const item of raw) {
    const entry = sanitizeReadingEntry(item)
    if (!entry || ids.has(entry.id)) continue
    const previous = byUrl.get(entry.url)
    if (previous) ids.delete(previous.id)
    ids.add(entry.id)
    byUrl.set(entry.url, entry)
  }
  return trimReadingList([...byUrl.values()])
}

function sanitizeReadingEntry(raw: unknown): ReadingListEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.url !== 'string' || !r.url) return null
  const addedAt = finiteTime(r.addedAt)
  if (addedAt === null) return null
  const readAt = finiteTime(r.readAt)
  const updatedAt = finiteTime(r.updatedAt) ?? Math.max(addedAt, readAt ?? 0)
  const entry: ReadingListEntry = {
    id: r.id,
    url: r.url,
    title: typeof r.title === 'string' && r.title ? r.title : r.url,
    addedAt,
    updatedAt
  }
  if (typeof r.favicon === 'string' && r.favicon) entry.favicon = r.favicon
  if (readAt !== null) entry.readAt = readAt
  return entry
}

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** A page the list can hold: a web address; the browser's own pages and blank tabs are not saved. */
export function isReadingListUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
