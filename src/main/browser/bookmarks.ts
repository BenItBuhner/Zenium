import type { Bookmark } from '../../shared/types'
import { newId } from '../../shared/ids'
import type { BrowserState } from './state'

/** Bookmarks live inside the main state file; this is a thin, indexed façade over that list. */
export class BookmarkService {
  private urls = new Set<string>()

  constructor(private readonly state: BrowserState) {
    this.reindex()
  }

  private reindex(): void {
    this.urls = new Set(this.state.bookmarks.map((b) => b.url))
  }

  has(url: string): boolean {
    return this.urls.has(url)
  }

  all(): Bookmark[] {
    return this.state.bookmarks
  }

  add(url: string, title: string, favicon: string | null = null): Bookmark | null {
    if (!url || this.urls.has(url)) return null
    const bookmark: Bookmark = {
      id: newId('bm'),
      url,
      title: title || url,
      favicon,
      createdAt: Date.now()
    }
    this.state.bookmarks.unshift(bookmark)
    this.urls.add(url)
    this.syncTabs()
    this.state.commit()
    return bookmark
  }

  /** Insert or update a bookmark keeping its id (used by sync). */
  upsert(bookmark: Bookmark): void {
    const existing = this.state.bookmarks.find((b) => b.id === bookmark.id)
    if (existing) Object.assign(existing, bookmark)
    else this.state.bookmarks.push(bookmark)
    // One bookmark per URL: drop older duplicates that sync may have produced.
    const seen = new Set<string>()
    this.state.bookmarks = this.state.bookmarks.filter((b) => {
      if (seen.has(b.url) && b.id !== bookmark.id) return false
      seen.add(b.url)
      return true
    })
    this.reindex()
    this.syncTabs()
  }

  removeByUrl(url: string): void {
    this.state.bookmarks = this.state.bookmarks.filter((b) => b.url !== url)
    this.reindex()
    this.syncTabs()
    this.state.commit()
  }

  remove(id: string): void {
    this.state.bookmarks = this.state.bookmarks.filter((b) => b.id !== id)
    this.reindex()
    this.syncTabs()
    this.state.commit()
  }

  /** Toggle bookmark for a URL; returns the new state. */
  toggle(url: string, title: string, favicon: string | null): boolean {
    if (this.urls.has(url)) {
      this.removeByUrl(url)
      return false
    }
    this.add(url, title, favicon)
    return true
  }

  search(query: string, limit: number): Bookmark[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.state.bookmarks.slice(0, limit)
    return this.state.bookmarks
      .filter((b) => `${b.title} ${b.url}`.toLowerCase().includes(q))
      .slice(0, limit)
  }

  private syncTabs(): void {
    for (const tab of Object.values(this.state.model.tabs)) tab.bookmarked = this.urls.has(tab.url)
  }
}
