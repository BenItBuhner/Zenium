import type { ReadingListEntry } from '../shared/types'
import { newId } from '../shared/ids'
import {
  READING_LIST_CAP,
  isReadingListUrl,
  isUnread,
  sortReadingList,
  trimReadingList,
  unreadReadingCount
} from '../shared/readingList'
import { displayHost } from '../shared/url'
import type { BrowserState } from './state'

/**
 * What a store of the reading list offers whoever draws it (W6-1; the services slice's sync
 * record `reading-list-entry` – every field but `favicon` – is diffed out of the state at each
 * commit by the sync engine's own subscriber, so the store needs no "emit the record" step; see
 * `internal/desktop-parity/reading-list-interface.md` and services' read beside it). The
 * desktop's implementation is the {@link ReadingListService} over the profile's state.
 */
export interface ReadingListStore {
  /** Save a page; a page already in the list is marked unread and brought to the top instead. */
  add(url: string, title: string, favicon?: string | null): ReadingListEntry | null
  remove(id: string): boolean
  setRead(id: string, read: boolean): boolean
  /** Unread first, newest first within each half (`sortReadingList`). */
  list(): ReadingListEntry[]
  /** Called after every write; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  readonly unreadCount: number
}

/**
 * The reading list lives in the main state file (`state.readingList`, at most `READING_LIST_CAP`
 * entries, one per URL). This service is the mutation surface: every write goes through here,
 * keeps the list within its cap (the oldest read entry drops first) and commits the state, so
 * the chrome's `UIState.readingList` and the disk follow in the same tick. Nothing here is
 * synced yet: the list is the profile's, like the bookmarks were before their records. Every
 * write leaves an entry in the sanitiser's normal form (`sanitizeReadingEntry`'s field order),
 * so a load rewrites nothing – the sync slice relies on that (`readingList.test.ts`).
 */
export class ReadingListService implements ReadingListStore {
  private lastNow = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly state: BrowserState) {}

  /**
   * Strictly increasing timestamps: two adds in the same millisecond still have a definite
   * "most recent", so the order never depends on array order.
   */
  private now(): number {
    this.lastNow = Math.max(Date.now(), this.lastNow + 1)
    return this.lastNow
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  list(): ReadingListEntry[] {
    return sortReadingList(this.state.readingList)
  }

  get(id: string): ReadingListEntry | null {
    return this.state.readingList.find((e) => e.id === id) ?? null
  }

  findByUrl(url: string): ReadingListEntry | null {
    return this.state.readingList.find((e) => e.url === url) ?? null
  }

  /** Whether the page is in the list (read or not): the star menu's Add / Remove row. */
  has(url: string): boolean {
    return this.findByUrl(url) !== null
  }

  get unreadCount(): number {
    return unreadReadingCount(this.state.readingList)
  }

  /** Whether the page can be saved: a web address, not one of the browser's own pages. */
  canAdd(url: string): boolean {
    return isReadingListUrl(url)
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Save a page for later. A page already in the list is not duplicated: it is marked unread
   * again, its title and favicon refreshed, and its `addedAt` bumped so it comes to the top –
   * Chrome's `chrome.readingList.addEntry` rejects the duplicate; a second "Add to reading
   * list" here means "I want to read this again". Returns null for an address the list does
   * not hold (`zen://`, `about:blank`, a file).
   */
  add(url: string, title: string, favicon?: string | null): ReadingListEntry | null {
    if (!this.canAdd(url)) return null
    const now = this.now()
    const cleanTitle = title.trim() || displayHost(url) || url
    const existing = this.findByUrl(url)
    if (existing) {
      const refreshed: ReadingListEntry = {
        ...existing,
        title: cleanTitle,
        addedAt: now,
        updatedAt: now
      }
      delete refreshed.readAt
      if (favicon) refreshed.favicon = favicon
      this.write(this.state.readingList.map((e) => (e.id === existing.id ? refreshed : e)))
      return refreshed
    }
    const entry: ReadingListEntry = {
      id: newId('rl'),
      url,
      title: cleanTitle,
      addedAt: now,
      updatedAt: now
    }
    if (favicon) entry.favicon = favicon
    this.write([entry, ...this.state.readingList])
    return entry
  }

  remove(id: string): boolean {
    const next = this.state.readingList.filter((e) => e.id !== id)
    if (next.length === this.state.readingList.length) return false
    this.write(next)
    return true
  }

  /** The URL's entry out of the list, whichever id it has: the star menu's Remove row. */
  removeUrl(url: string): boolean {
    const entry = this.findByUrl(url)
    return entry ? this.remove(entry.id) : false
  }

  /** Mark the entry read or unread; false when there is no such entry or nothing changed. */
  setRead(id: string, read: boolean): boolean {
    const entry = this.get(id)
    if (!entry || isUnread(entry) !== read) return false
    const now = this.now()
    const next: ReadingListEntry = { ...entry, updatedAt: now }
    if (read) next.readAt = now
    else delete next.readAt
    this.write(this.state.readingList.map((e) => (e.id === id ? next : e)))
    return true
  }

  toggleRead(id: string): boolean {
    const entry = this.get(id)
    return entry ? this.setRead(id, isUnread(entry)) : false
  }

  /** Every unread entry read, in one write; how many changed. */
  markAllRead(): number {
    const unread = this.state.readingList.filter(isUnread)
    if (unread.length === 0) return 0
    const now = this.now()
    this.write(
      this.state.readingList.map((e) => (isUnread(e) ? { ...e, readAt: now, updatedAt: now } : e))
    )
    return unread.length
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---------------------------------------------------------------------------

  /** The cap's rule is applied on every write; the state commits and the listeners hear of it. */
  private write(entries: ReadingListEntry[]): void {
    this.state.readingList = trimReadingList(entries, READING_LIST_CAP)
    this.state.commit()
    for (const listener of this.listeners) listener()
  }
}
