import { displayUrl } from '../shared/url'
import { JsonStore } from './store/JsonStore'
import type { StoreIO } from './platform'

/**
 * Chromium's ShortcutsProvider (omnibox-03): what the user typed, and the destination they then
 * chose – an address or a search – with a use count and the time of the last use. Typing a
 * prefix of a remembered text next time boosts that destination to the top of the popup, with an
 * inline completion when the destination's text extends what was typed. Unused shortcuts decay
 * (the score halves every week) and are dropped after 90 days. Persisted in the profile as
 * `shortcuts.json`; a private window never writes one, and clearing history clears them.
 */

export interface Shortcut {
  /** What was typed, lower-cased and trimmed – the key a later typing is matched against. */
  text: string
  /** The text the field shows for the destination: the query, or the address without scheme. */
  fill: string
  /** Where the pick went: the page's address, or the engine's search URL. */
  url: string
  /** The row's title: the page's, or the query. */
  title: string
  kind: 'url' | 'search'
  /** The engine a search went to. */
  engineId?: string
  /** How often this text led to this destination. */
  hits: number
  /** ms since the epoch. */
  lastUsed: number
}

export interface ShortcutMatch extends Shortcut {
  /** How well the shortcut fits what was typed now, decay applied; higher is better. */
  score: number
}

interface Persisted {
  version: 1
  shortcuts: Shortcut[]
}

const WEEK_MS = 7 * 86_400_000
/** A shortcut not used for this long is forgotten (Chromium's ShortcutsBackend expiry). */
export const SHORTCUT_RETENTION_MS = 90 * 86_400_000
/** Shortcuts kept at most; the least recently used go first. */
export const MAX_SHORTCUTS = 500

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The key a typing is remembered under: trimmed, lower-cased, inner whitespace collapsed. */
export function shortcutKey(typed: string): string {
  return typed.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The score a shortcut has now for a prefix of its text (Chromium's `CalculateScore`): how much
 * of the remembered text was typed, times how often it was used, halved for every week since
 * the last use – a shortcut used often decays more slowly, up to five times as slowly.
 */
export function scoreShortcut(shortcut: Shortcut, typed: string, nowMs: number): number {
  const key = shortcutKey(typed)
  if (!key || !shortcut.text.startsWith(key)) return 0
  const typedPart = key.length / shortcut.text.length
  const weeks = Math.max(0, nowMs - shortcut.lastUsed) / WEEK_MS
  // Chromium: decaying by half takes n times as long, n growing by one per five uses, up to 5.
  const divisor = Math.min(5, (shortcut.hits + 4) / 5)
  const decay = Math.pow(0.5, weeks / divisor)
  return typedPart * shortcut.hits * decay
}

/** Drop what the retention window has passed (90 days unused) and, past the cap, the least recently used. */
export function pruneShortcuts(shortcuts: Shortcut[], nowMs: number): Shortcut[] {
  const cutoff = nowMs - SHORTCUT_RETENTION_MS
  return shortcuts
    .filter((s) => s.lastUsed > cutoff)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_SHORTCUTS)
}

function isShortcut(s: unknown): s is Shortcut {
  if (!s || typeof s !== 'object') return false
  const x = s as Partial<Shortcut>
  return (
    typeof x.text === 'string' &&
    typeof x.fill === 'string' &&
    typeof x.url === 'string' &&
    typeof x.title === 'string' &&
    (x.kind === 'url' || x.kind === 'search') &&
    typeof x.hits === 'number' &&
    typeof x.lastUsed === 'number'
  )
}

/** A stored document (possibly corrupt) as a list of shortcuts. */
export function migrateShortcuts(data: unknown): Shortcut[] {
  if (!data || typeof data !== 'object') return []
  const doc = data as { version?: unknown; shortcuts?: unknown }
  if (doc.version !== 1 || !Array.isArray(doc.shortcuts)) return []
  return doc.shortcuts.filter(isShortcut)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface LearnedDestination {
  url: string
  title: string
  kind: 'url' | 'search'
  engineId?: string
  /** The field's text for the destination; the query for a search, the address otherwise. */
  fill?: string
}

export class OmniboxShortcutsService {
  private shortcuts: Shortcut[] = []
  private readonly store: JsonStore<Persisted>

  constructor(
    io: StoreIO,
    private readonly now: () => number = () => Date.now()
  ) {
    this.store = new JsonStore<Persisted>(io, 'shortcuts.json', 1000)
    const raw = this.store.readSync()
    const loaded = migrateShortcuts(raw)
    this.shortcuts = pruneShortcuts(loaded, this.now())
    if (raw && this.shortcuts.length !== loaded.length) this.persist()
  }

  /** Every shortcut, most recently used first. */
  all(): Shortcut[] {
    return [...this.shortcuts].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /**
   * Remember that `typed` led to `destination`: the same text to the same place counts one more
   * use; the same text to another place is a shortcut of its own (Chromium keeps one per
   * text and destination, the most used winning at match time).
   */
  learn(typed: string, destination: LearnedDestination): void {
    const text = shortcutKey(typed)
    if (!text || !destination.url) return
    const now = this.now()
    const fill =
      destination.fill ??
      (destination.kind === 'search'
        ? destination.title
        : displayUrl(destination.url) || destination.url)
    const existing = this.shortcuts.find((s) => s.text === text && s.url === destination.url)
    if (existing) {
      existing.hits += 1
      existing.lastUsed = now
      existing.title = destination.title || existing.title
      existing.fill = fill || existing.fill
      existing.engineId = destination.engineId
    } else {
      this.shortcuts.push({
        text,
        fill,
        url: destination.url,
        title: destination.title || fill,
        kind: destination.kind,
        ...(destination.engineId ? { engineId: destination.engineId } : {}),
        hits: 1,
        lastUsed: now
      })
    }
    this.shortcuts = pruneShortcuts(this.shortcuts, now)
    this.persist()
  }

  /**
   * The destinations a typing recalls, best first: one row per destination (its best-scoring
   * shortcut), for shortcuts whose text starts with what was typed. Empty for an empty typing.
   */
  match(typed: string, limit = 3): ShortcutMatch[] {
    const now = this.now()
    const best = new Map<string, ShortcutMatch>()
    for (const s of this.shortcuts) {
      const score = scoreShortcut(s, typed, now)
      if (score <= 0) continue
      const hit = best.get(s.url)
      if (!hit || score > hit.score) best.set(s.url, { ...s, score })
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit))
  }

  /** Remembered searches, most recent first, one per query (zero-suggest's "Recent searches"). */
  recentSearches(limit: number): Shortcut[] {
    const seen = new Set<string>()
    const out: Shortcut[] = []
    for (const s of this.all()) {
      if (s.kind !== 'search') continue
      const key = s.fill.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(s)
      if (out.length >= limit) break
    }
    return out
  }

  /** Forget every shortcut to `url` (the X on a remembered row; a history entry deleted). */
  forgetUrl(url: string): void {
    const before = this.shortcuts.length
    this.shortcuts = this.shortcuts.filter((s) => s.url !== url)
    if (this.shortcuts.length !== before) this.persist()
  }

  /** Forget the shortcuts last used in `[fromMs, toMs)` (Clear browsing data for a range). */
  forgetRange(fromMs: number, toMs: number): void {
    const before = this.shortcuts.length
    this.shortcuts = this.shortcuts.filter((s) => s.lastUsed < fromMs || s.lastUsed >= toMs)
    if (this.shortcuts.length !== before) this.persist()
  }

  /** Forget everything (history cleared). */
  clear(): void {
    if (this.shortcuts.length === 0) return
    this.shortcuts = []
    this.persist()
  }

  private persist(): void {
    this.store.write({ version: 1, shortcuts: this.shortcuts })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
