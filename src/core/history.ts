import type { HistoryEntry } from '../shared/types'
import { JsonStore } from './store/JsonStore'
import { isInternalUrl } from '../shared/url'
import type { StoreIO } from './platform'

const MAX_ENTRIES = 10_000

interface Persisted {
  version: 1
  entries: HistoryEntry[]
}

export class HistoryService {
  private entries = new Map<string, HistoryEntry>()
  private readonly store: JsonStore<Persisted>

  constructor(io: StoreIO) {
    this.store = new JsonStore<Persisted>(io, 'history.json', 2000)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.entries)) {
      for (const e of data.entries) {
        if (e && typeof e.url === 'string') this.entries.set(e.url, e)
      }
    }
  }

  visit(url: string, title: string, favicon: string | null): void {
    if (!url || isInternalUrl(url) || url.startsWith('view-source:') || url.startsWith('data:'))
      return
    const existing = this.entries.get(url)
    if (existing) {
      existing.visitCount += 1
      existing.lastVisit = Date.now()
      if (title) existing.title = title
      if (favicon) existing.favicon = favicon
      // Re-insert to keep the map in recency order.
      this.entries.delete(url)
      this.entries.set(url, existing)
    } else {
      this.entries.set(url, {
        url,
        title: title || url,
        visitCount: 1,
        lastVisit: Date.now(),
        favicon
      })
      if (this.entries.size > MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value
        if (oldest) this.entries.delete(oldest)
      }
    }
    this.persist()
  }

  updateTitle(url: string, title: string): void {
    const e = this.entries.get(url)
    if (e && title && e.title !== title) {
      e.title = title
      this.persist()
    }
  }

  updateFavicon(url: string, favicon: string): void {
    const e = this.entries.get(url)
    if (e && favicon && e.favicon !== favicon) {
      e.favicon = favicon
      this.persist()
    }
  }

  recent(limit: number): HistoryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, limit)
  }

  /** Simple frecency-style ranking: substring matches weighted by visits and recency. */
  search(query: string, limit: number): HistoryEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.recent(limit)
    const terms = q.split(/\s+/)
    const now = Date.now()
    const scored: Array<{ e: HistoryEntry; score: number }> = []
    for (const e of this.entries.values()) {
      const hay = `${e.title} ${e.url}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      const ageDays = (now - e.lastVisit) / 86_400_000
      const recency = 1 / (1 + ageDays)
      const hostMatch = e.url
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?/, '')
        .startsWith(q)
        ? 2
        : 0
      scored.push({ e, score: Math.log1p(e.visitCount) + recency * 2 + hostMatch })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.e)
  }

  /** Inline autofill candidate: a visited host that starts with the typed text. */
  autofill(query: string): string | null {
    const q = query.trim().toLowerCase()
    if (!q || /\s/.test(q) || q.includes(':')) return null
    let best: { host: string; score: number } | null = null
    for (const e of this.entries.values()) {
      let host: string
      try {
        host = new URL(e.url).host.toLowerCase()
      } catch {
        continue
      }
      const bare = host.replace(/^www\./, '')
      if (!(host.startsWith(q) || bare.startsWith(q))) continue
      const score = e.visitCount
      if (!best || score > best.score) best = { host: bare.startsWith(q) ? bare : host, score }
    }
    return best ? `${best.host}/` : null
  }

  delete(url: string): void {
    if (this.entries.delete(url)) this.persist()
  }

  clear(): void {
    this.entries.clear()
    this.persist()
  }

  private persist(): void {
    this.store.write({ version: 1, entries: [...this.entries.values()] })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
