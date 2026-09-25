import { faviconUrl, faviconHashOf } from '../shared/favicons'
import { base64Decode, base64Encode } from './extensions/bytes'
import type { StoreIO } from './platform'
import { sha256, toHex } from './safebrowsing/sha256'
import { JsonStore } from './store/JsonStore'

/**
 * The favicon cache (HB-47, Chrome's Favicons DB). History rows, bookmarks and tab rows used to
 * draw their icon from the icon's live address – one request per row, to every site the user
 * ever visited, each time the history page opened, and nothing offline. The core now keeps a
 * copy of every icon a page reports, named by its content:
 *
 *  - keyed by the icon's address (what `HistoryEntry.favicon`, `Bookmark.favicon` and
 *    `Tab.favicon` hold, so the records and their sync are untouched), deduplicated by a content
 *    hash – history and bookmarks pointing at the same bytes under two addresses share one copy;
 *  - the bytes as one document per icon, `favicons/<hash>`, a `data:` URL's text through the
 *    host's document I/O (`StoreIO`: Electron's profile directory, Android's `Storage.kt`),
 *    the index as `favicons.json`; an icon over `MAX_ICON_BYTES` is not kept;
 *  - bounded to `MAX_CACHE_BYTES` / `MAX_CACHE_ENTRIES`, the least recently used icon going
 *    first – a use is a page reporting the icon again or a host serving its bytes;
 *  - served as `zen://favicon/<hash>` (`main/platform/protocol.ts` on Electron; the app origin's
 *    `/zen-favicon/<hash>` on Android, `shared/favicons.ts` `hostFaviconUrl`).
 *
 * An icon that arrives as a `data:` URL (the Android WebView's `onReceivedIcon` hands a 32 px PNG
 * over that way) is stored once and its record holds the content address instead of the bytes;
 * an `http(s)` icon is fetched once through the page's own session (`TabView.fetchFavicon`) and
 * its record keeps the address as the key.
 */

/** Icons over this many bytes are not kept (Chrome's favicons are 16–32 px; a 16 KB icon is large). */
export const MAX_ICON_BYTES = 16 * 1024
/** The cache holds at most this many bytes of icons… */
export const MAX_CACHE_BYTES = 4 * 1024 * 1024
/** …and at most this many icons. */
export const MAX_CACHE_ENTRIES = 2000
/** The icons' documents live under this folder of the profile. */
export const FAVICONS_DIR = 'favicons'
/** The index document. */
export const FAVICONS_INDEX = 'favicons.json'

export interface FaviconBytes {
  bytes: Uint8Array
  mime: string
}

/**
 * Fetches an icon's bytes for `receive`: the page's own view on Electron (the site's cookies go
 * with the request, as Chrome's favicon fetch sends them). Null when the icon cannot be had.
 */
export type FaviconFetcher = (
  url: string,
  maxBytes: number
) => Promise<FaviconBytes | null | undefined> | FaviconBytes | null | undefined

/** What changed in the index: addresses now cached (with their hash) and addresses dropped. */
export interface FaviconsChange {
  added: Array<[url: string, hash: string]>
  removed: string[]
}

interface Entry {
  mime: string
  bytes: number
  /** When the icon was last used (ms since the epoch): put, reported again, or served. */
  used: number
}

interface PersistedFavicons {
  version: 1
  entries: Record<string, Entry>
  urls: Record<string, string>
}

export interface FaviconServiceOptions {
  now?: () => number
  maxBytes?: number
  maxEntries?: number
  maxIconBytes?: number
}

/** The types an icon may be: what the sniffer names, plus SVG when the server says so. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
  'image/avif'
])

/**
 * The image type the bytes themselves say (servers hand `favicon.ico` out as `text/plain` or
 * `application/octet-stream` often enough), or null when they are no image the sniffer knows.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length < 4) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp'
  return null
}

/**
 * The type an icon is stored under: what its bytes say, else the declared type when it is one
 * the sniffer cannot name (SVG, AVIF); null for anything that is no image.
 */
export function imageTypeOf(bytes: Uint8Array, declared: string | null | undefined): string | null {
  const sniffed = sniffImageType(bytes)
  if (sniffed) return sniffed
  const type = (declared ?? '').split(';')[0].trim().toLowerCase()
  return type === 'image/svg+xml' || type === 'image/avif' ? type : null
}

/** A `data:` URL's type and bytes, or null when it is not one the cache keeps (base64 images only). */
export function decodeDataUrl(url: string): FaviconBytes | null {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(url)
  if (!match) return null
  const declared = match[1].trim().toLowerCase()
  if (!match[2]?.split(';').includes('base64')) return null
  try {
    const bytes = base64Decode(decodeURIComponent(match[3]))
    const mime = imageTypeOf(bytes, declared)
    return mime ? { bytes, mime } : null
  } catch {
    return null
  }
}

/** The document text of an icon: a `data:` URL with its type and bytes. */
export function encodeDataUrl(icon: FaviconBytes): string {
  return `data:${icon.mime};base64,${base64Encode(icon.bytes)}`
}

/** The cache's name for `bytes`: the first 128 bits of their SHA-256, as hex. */
export function faviconHash(bytes: Uint8Array): string {
  return toHex(sha256(bytes).subarray(0, 16))
}

function isPersisted(data: unknown): data is PersistedFavicons {
  if (!data || typeof data !== 'object') return false
  const doc = data as Partial<PersistedFavicons>
  return (
    doc.version === 1 &&
    !!doc.entries &&
    typeof doc.entries === 'object' &&
    !!doc.urls &&
    typeof doc.urls === 'object'
  )
}

export class FaviconService {
  private readonly entries = new Map<string, Entry>()
  private readonly urls = new Map<string, string>()
  private readonly store: JsonStore<PersistedFavicons>
  private readonly listeners = new Set<(change: FaviconsChange) => void>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  /** Addresses whose fetch failed this session: not asked for again until the next start. */
  private readonly failed = new Set<string>()
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly maxIconBytes: number
  private totalBytes = 0

  constructor(
    private readonly io: StoreIO,
    options: FaviconServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now())
    this.maxBytes = options.maxBytes ?? MAX_CACHE_BYTES
    this.maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES
    this.maxIconBytes = options.maxIconBytes ?? MAX_ICON_BYTES
    this.store = new JsonStore<PersistedFavicons>(io, FAVICONS_INDEX, 2000)
    const raw = this.store.readSync()
    if (isPersisted(raw)) {
      for (const [hash, entry] of Object.entries(raw.entries)) {
        if (!faviconHashOf(faviconUrl(hash))) continue
        if (typeof entry?.bytes !== 'number' || typeof entry.mime !== 'string') continue
        this.entries.set(hash, {
          mime: entry.mime,
          bytes: entry.bytes,
          used: typeof entry.used === 'number' ? entry.used : 0
        })
        this.totalBytes += entry.bytes
      }
      for (const [url, hash] of Object.entries(raw.urls)) {
        if (typeof hash === 'string' && this.entries.has(hash)) this.urls.set(url, hash)
      }
    }
  }

  /** How much the cache holds. */
  size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes }
  }

  /** Whether the cache holds the icon at `iconUrl`. */
  has(iconUrl: string): boolean {
    return this.resolve(iconUrl) !== null
  }

  /**
   * The cached copy's address for `iconUrl` – `zen://favicon/<hash>` – or null when the cache
   * has nothing for it. A content address that names a kept icon resolves to itself.
   */
  resolve(iconUrl: string | null | undefined): string | null {
    if (!iconUrl) return null
    const own = faviconHashOf(iconUrl)
    if (own) return this.entries.has(own) ? faviconUrl(own) : null
    const hash = this.urls.get(iconUrl)
    return hash ? faviconUrl(hash) : null
  }

  /** The index as the chrome takes it at start: every cached address with its hash. */
  index(): Array<[url: string, hash: string]> {
    return [...this.urls.entries()]
  }

  onChange(listener: (change: FaviconsChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * An icon a page reported, as the tab's `favicon` event carries it: a `data:` URL is decoded
   * and kept; an `http(s)` address the cache holds is a use of it; one it lacks is fetched
   * through `fetch` (the page's own view) and kept. Resolves with the cached copy's address, or
   * null when the icon is not kept (no fetcher, a refusal, too big, not an image).
   */
  receive(iconUrl: string, fetch: FaviconFetcher | null = null): Promise<string | null> {
    if (iconUrl.startsWith('data:')) {
      const icon = decodeDataUrl(iconUrl)
      return icon ? this.put(iconUrl, icon) : Promise.resolve(null)
    }
    if (!/^https?:/i.test(iconUrl)) return Promise.resolve(this.resolve(iconUrl))
    const hash = this.urls.get(iconUrl)
    if (hash) {
      this.touch(hash)
      return Promise.resolve(faviconUrl(hash))
    }
    if (!fetch || this.failed.has(iconUrl)) return Promise.resolve(null)
    const running = this.inflight.get(iconUrl)
    if (running) return running
    const job = this.fetchInto(iconUrl, fetch).finally(() => this.inflight.delete(iconUrl))
    this.inflight.set(iconUrl, job)
    return job
  }

  private async fetchInto(iconUrl: string, fetch: FaviconFetcher): Promise<string | null> {
    let icon: FaviconBytes | null | undefined
    try {
      icon = await fetch(iconUrl, this.maxIconBytes)
    } catch {
      icon = null
    }
    if (!icon) {
      this.noteFailed(iconUrl)
      return null
    }
    const kept = await this.put(iconUrl, icon)
    if (!kept) this.noteFailed(iconUrl)
    return kept
  }

  private noteFailed(iconUrl: string): void {
    if (this.failed.size >= 5000) this.failed.clear()
    this.failed.add(iconUrl)
  }

  /**
   * Keep `icon` under `iconUrl`. The bytes are hashed; an icon already kept under the hash is
   * shared (the address is added to it); a new one is written as `favicons/<hash>` before the
   * index lists it. Resolves with `zen://favicon/<hash>`, or null when the icon is over the cap
   * or no image. For a `data:` address the content address is the only key kept – the data URL
   * itself is the bytes, and its record is meant to hold the address instead.
   */
  async put(iconUrl: string, icon: FaviconBytes): Promise<string | null> {
    if (icon.bytes.length === 0 || icon.bytes.length > this.maxIconBytes) return null
    const mime = imageTypeOf(icon.bytes, icon.mime)
    if (!mime || !IMAGE_TYPES.has(mime)) return null
    const hash = faviconHash(icon.bytes)
    const address = faviconUrl(hash)
    const keyed = !iconUrl.startsWith('data:') && iconUrl !== address
    const added: Array<[string, string]> = []
    const existing = this.entries.get(hash)
    if (existing) {
      existing.used = this.now()
    } else {
      try {
        await this.io.write(`${FAVICONS_DIR}/${hash}`, encodeDataUrl({ bytes: icon.bytes, mime }))
      } catch (error) {
        console.warn(`[zen] could not keep the icon ${iconUrl}:`, error)
        return null
      }
      this.entries.set(hash, { mime, bytes: icon.bytes.length, used: this.now() })
      this.totalBytes += icon.bytes.length
    }
    if (keyed && this.urls.get(iconUrl) !== hash) {
      this.urls.set(iconUrl, hash)
      added.push([iconUrl, hash])
    }
    const removed = this.evict()
    this.persist()
    if (added.length > 0 || removed.length > 0) this.notify({ added, removed })
    return address
  }

  /**
   * The bytes of the icon named `hash`, for the host serving `zen://favicon/<hash>`; null when
   * the cache has no such icon (evicted, or never kept). Serving is a use.
   */
  async document(hash: string): Promise<FaviconBytes | null> {
    const entry = this.entries.get(hash)
    if (!entry) return null
    const name = `${FAVICONS_DIR}/${hash}`
    let text: string | null
    try {
      text = this.io.read ? await this.io.read(name) : this.io.readSync(name)
    } catch {
      text = null
    }
    const icon = text ? decodeDataUrl(text) : null
    if (!icon) {
      // The index names a document that is gone: the entry goes with it.
      this.drop(hash)
      this.persist()
      return null
    }
    this.touch(hash)
    return icon
  }

  /**
   * History was cleared: the icons of pages nobody keeps go with it, as Chrome expires the
   * favicons no URL references any more; `keep` names the icon addresses still referenced (the
   * bookmarks', the open tabs').
   */
  forget(keep: ReadonlySet<string>): void {
    const kept = new Set<string>()
    for (const url of keep) {
      const own = faviconHashOf(url)
      const hash = own ?? this.urls.get(url)
      if (hash) kept.add(hash)
    }
    const removed: string[] = []
    for (const hash of [...this.entries.keys()]) {
      if (kept.has(hash)) continue
      removed.push(...this.drop(hash))
    }
    // An address whose icon is kept for another's sake but that history no longer names.
    for (const [url, hash] of [...this.urls.entries()]) {
      if (!keep.has(url) && kept.has(hash)) {
        this.urls.delete(url)
        removed.push(url)
      }
    }
    this.persist()
    if (removed.length > 0) this.notify({ added: [], removed })
  }

  /** Write the index now (quit). */
  flush(): Promise<void> {
    return this.store.flush()
  }

  /** Write the index now, synchronously (the process is about to go away). */
  flushSync(): void {
    this.store.flushSync()
  }

  private touch(hash: string): void {
    const entry = this.entries.get(hash)
    if (!entry) return
    entry.used = this.now()
    this.persist()
  }

  /** Least recently used first, until the cache is within its bounds; the addresses dropped. */
  private evict(): string[] {
    const removed: string[] = []
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      let oldest: string | null = null
      let oldestUsed = Infinity
      for (const [hash, entry] of this.entries) {
        if (entry.used < oldestUsed) {
          oldestUsed = entry.used
          oldest = hash
        }
      }
      if (!oldest) break
      removed.push(...this.drop(oldest))
    }
    return removed
  }

  /** Remove one icon: its entry, its document and every address that named it (returned). */
  private drop(hash: string): string[] {
    const entry = this.entries.get(hash)
    if (!entry) return []
    this.entries.delete(hash)
    this.totalBytes -= entry.bytes
    const removed: string[] = []
    for (const [url, h] of [...this.urls.entries()]) {
      if (h === hash) {
        this.urls.delete(url)
        removed.push(url)
      }
    }
    void this.io.remove?.(`${FAVICONS_DIR}/${hash}`).catch(() => undefined)
    return removed
  }

  private persist(): void {
    const entries: Record<string, Entry> = {}
    for (const [hash, entry] of this.entries) entries[hash] = { ...entry }
    const urls: Record<string, string> = {}
    for (const [url, hash] of this.urls) urls[url] = hash
    this.store.write({ version: 1, entries, urls })
  }

  private notify(change: FaviconsChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
