import type { Browser } from '../browser'
import type { StoreIO } from '../platform'
import type {
  SafeBrowsingFeedStatus,
  SafeBrowsingHit,
  SafeBrowsingStatus,
  SafeBrowsingThreat
} from '../../shared/privacy'
import { hostnameOf } from '../blocking/domain'
import {
  makeDanger,
  type DangerVerdictProvider,
  type DangerVerdictRequest
} from '../downloads/danger'
import {
  FEED_DOCUMENT_VERSION,
  feedFile,
  parseFeedDocument,
  SAFE_BROWSING_DIR,
  type FeedDocument
} from './document'
import {
  parseFeed,
  SAFE_BROWSING_FEEDS,
  SAFE_BROWSING_TEST_FEED,
  SAFE_BROWSING_TEST_HOSTS,
  safeBrowsingFeed,
  type SafeBrowsingFeed
} from './feeds'
import { buildSearchRequest, parseSearchResponse, type GsbSearchRequest } from './gsb'
import { hostExpressions, PrefixTable, prefixOf } from './prefixes'

/**
 * Safe Browsing on open feeds. The service owns one hash-prefix table per feed (`prefixes.ts`),
 * refreshes them on a schedule with conditional requests, seeds them from the snapshot the build
 * ships, and answers the hosts' request engines synchronously: `lookup(url)` says whether a
 * navigation (or a download) should be stopped and why. Hosts stop the request themselves (a
 * `RequestHandler` ahead of the rule engine on desktop, a guard in the Kotlin engine on Android,
 * which reads the same table files) and the tab shows the interstitial. With a Google Safe
 * Browsing key, main-frame navigations the feeds let through are also looked up remotely
 * (`gsb.ts`); a late hit turns the page into the interstitial.
 *
 * Files: `safebrowsing/<feed>.json` under the profile, one {@link FeedDocument} each (`document.ts`).
 */

export { FEED_DOCUMENT_VERSION, feedFile, parseFeedDocument, SAFE_BROWSING_DIR }
export type { FeedDocument, SafeBrowsingHit }

/** A block a host applied on the service's word, kept for the tab's error page. */
export interface PendingBlock {
  url: string
  hit: SafeBrowsingHit
  at: number
}

interface FeedRuntime {
  feed: SafeBrowsingFeed
  table: PrefixTable
  doc: FeedDocument | null
  updating: boolean
  lastError: string | null
}

const SWEEP_INTERVAL_MS = 30 * 60 * 1000
const STARTUP_SWEEP_DELAY_MS = 20_000
const FETCH_TIMEOUT_MS = 90_000
const REMOTE_TIMEOUT_MS = 6_000
const PENDING_BLOCK_TTL_MS = 60_000
const REMOTE_CACHE_MAX = 2000
const HOST_CACHE_MAX = 4096

/**
 * The host bypasses are keyed on (lowercase, no scheme or port: the feeds list hosts, and the
 * user's answer is about the site, whichever way HTTPS-only mode or the site's redirects reach
 * it), or null for URLs without one.
 */
export function bypassKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return 'the download timed out'
    return error.message || 'unknown error'
  }
  return String(error)
}

export class SafeBrowsingService {
  private readonly feeds = new Map<string, FeedRuntime>()
  private readonly bypassed = new Set<string>()
  private readonly pending = new Map<string, PendingBlock>()
  /** The local tables' answer per host, cleared whenever a table changes. */
  private readonly hostCache = new Map<string, SafeBrowsingHit | null>()
  /** Remote answers by URL: the threat (or null), the listed expression, when the answer expires. */
  private readonly remoteCache = new Map<
    string,
    { threat: SafeBrowsingThreat | null; expression: string; until: number }
  >()
  private remoteErrors = 0
  private ready = false
  private stopped = false
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly browser: Browser,
    private readonly io: StoreIO = browser.platform.io
  ) {
    for (const feed of SAFE_BROWSING_FEEDS)
      this.feeds.set(feed.id, {
        feed,
        table: PrefixTable.empty(),
        doc: null,
        updating: false,
        lastError: null
      })
  }

  get enabled(): boolean {
    return this.browser.state.settings.privacy.safeBrowsingEnabled
  }

  private get apiKey(): string {
    return this.browser.state.settings.privacy.safeBrowsingApiKey
  }

  /** A Google Safe Browsing key is set: committed navigations are also looked up remotely. */
  get remoteLookups(): boolean {
    return this.enabled && this.apiKey.length > 0
  }

  /** Load the persisted tables, seed the snapshot where a feed has none, start the schedule. */
  start(): void {
    for (const rt of this.feeds.values()) {
      const doc = parseFeedDocument(this.io.readSync(feedFile(rt.feed.id)), rt.feed.id)
      if (doc) this.adopt(rt, doc)
    }
    this.ready = true
    void this.seedBundled().then(() => {
      if (this.stopped) return
      this.startupTimer = setTimeout(() => void this.sweep(), STARTUP_SWEEP_DELAY_MS)
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    })
    this.changed()
  }

  stop(): void {
    this.stopped = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.startupTimer = this.sweepTimer = null
  }

  /** Called after the tables, the bypasses or the schedule state changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  onSettingsChanged(): void {
    if (!this.apiKey) this.remoteCache.clear()
    this.changed()
  }

  status(): SafeBrowsingStatus {
    const feeds: SafeBrowsingFeedStatus[] = []
    let entries = 0
    let lastUpdatedAt: number | null = null
    let updating = false
    for (const rt of this.feeds.values()) {
      entries += rt.table.size
      updating ||= rt.updating
      const updatedAt = rt.doc?.updatedAt ?? null
      if (updatedAt && !rt.doc?.bundled && (lastUpdatedAt === null || updatedAt > lastUpdatedAt))
        lastUpdatedAt = updatedAt
      feeds.push({
        id: rt.feed.id,
        name: rt.feed.name,
        homepage: rt.feed.homepage,
        licence: rt.feed.licence,
        entries: rt.table.size,
        updatedAt,
        bundled: rt.doc?.bundled ?? false,
        updating: rt.updating,
        lastError: rt.lastError
      })
    }
    return {
      ready: this.ready,
      enabled: this.enabled,
      entries,
      feeds,
      updating,
      lastUpdatedAt,
      remoteLookups: this.apiKey.length > 0,
      remoteErrors: this.remoteErrors
    }
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /**
   * Whether `url` is on a feed (and not bypassed): the hit to stop it with, or null. Synchronous
   * and cheap (a few hashes and binary searches, the host's answer cached): hosts call it for
   * every request while Safe Browsing is on.
   */
  lookup(url: string): SafeBrowsingHit | null {
    if (!this.enabled || !/^https?:\/\//i.test(url)) return null
    const host = hostnameOf(url)
    if (!host) return null
    const key = bypassKey(url)
    if (key && this.bypassed.has(key)) return null
    const local = this.lookupHost(host)
    if (local) return local
    const cached = this.remoteCache.get(url)
    if (cached && cached.threat && cached.until > Date.now())
      return { feedId: 'gsb', threat: cached.threat, expression: cached.expression, remote: true }
    return null
  }

  /** The local tables' word on `host` (bypasses aside), remembered until a table changes. */
  lookupHost(host: string): SafeBrowsingHit | null {
    const cached = this.hostCache.get(host)
    if (cached !== undefined) return cached
    const hit = this.searchTables(host)
    if (this.hostCache.size >= HOST_CACHE_MAX) this.hostCache.clear()
    this.hostCache.set(host, hit)
    return hit
  }

  private searchTables(host: string): SafeBrowsingHit | null {
    const test = SAFE_BROWSING_TEST_HOSTS[host]
    if (test)
      return { feedId: SAFE_BROWSING_TEST_FEED, threat: test, expression: host, remote: false }
    for (const expression of hostExpressions(host)) {
      const prefix = prefixOf(expression)
      for (const rt of this.feeds.values()) {
        if (!rt.table.has(prefix)) continue
        return { feedId: rt.feed.id, threat: rt.feed.threat, expression, remote: false }
      }
    }
    return null
  }

  /** The user chose to proceed: nothing on `url`'s host is stopped until the browser closes. */
  bypass(url: string): boolean {
    const key = bypassKey(url)
    if (!key) return false
    this.bypassed.add(key)
    this.changed()
    return true
  }

  isBypassed(url: string): boolean {
    const key = bypassKey(url)
    return key !== null && this.bypassed.has(key)
  }

  /** Hosts bypassed this session, for the status card and the Android guard. */
  bypasses(): string[] {
    return [...this.bypassed].sort()
  }

  // ---------------------------------------------------------------------------
  // Blocks the hosts applied
  // ---------------------------------------------------------------------------

  /** A host refused `url` in `tabId` on the service's word; the tab's error page will ask why. */
  notePendingBlock(tabId: string, url: string, hit: SafeBrowsingHit): void {
    this.pending.set(tabId, { url, hit, at: Date.now() })
  }

  /** The block behind a failed load of `url` in `tabId`, if it was Safe Browsing's; consumed. */
  takePendingBlock(tabId: string, url: string): SafeBrowsingHit | null {
    const block = this.pending.get(tabId)
    if (!block) return null
    this.pending.delete(tabId)
    if (Date.now() - block.at > PENDING_BLOCK_TTL_MS) return null
    return sameDocument(block.url, url) ? block.hit : null
  }

  forgetTab(tabId: string): void {
    this.pending.delete(tabId)
  }

  // ---------------------------------------------------------------------------
  // Google Safe Browsing (user-supplied key)
  // ---------------------------------------------------------------------------

  /**
   * Look `url` up remotely if a key is set; resolves with the hit when the API lists it. The
   * caller (the tab) decides what to do with a late answer.
   */
  async checkRemote(url: string): Promise<SafeBrowsingHit | null> {
    const key = this.apiKey
    if (!key || !this.enabled || !/^https?:\/\//i.test(url)) return null
    if (this.isBypassed(url)) return null
    const now = Date.now()
    const cached = this.remoteCache.get(url)
    if (cached && cached.until > now)
      return cached.threat
        ? { feedId: 'gsb', threat: cached.threat, expression: cached.expression, remote: true }
        : null
    const request = buildSearchRequest(key, url)
    if (!request) return null
    const result = await this.search(request)
    if (!result) return null
    const expression = result.expression ?? hostnameOf(url) ?? url
    this.remember(url, result.threat, expression, result.cacheMs)
    return result.threat ? { feedId: 'gsb', threat: result.threat, expression, remote: true } : null
  }

  private async search(request: GsbSearchRequest): Promise<{
    threat: SafeBrowsingThreat | null
    expression: string | null
    cacheMs: number
  } | null> {
    try {
      const response = await this.browser.platform.net.fetchText(request.url, {
        headers: { Accept: 'application/json' },
        timeoutMs: REMOTE_TIMEOUT_MS
      })
      if (!response.ok) {
        this.remoteErrors++
        this.changed()
        console.warn(`[zenium] Safe Browsing lookup failed: HTTP ${response.status}`)
        return null
      }
      return parseSearchResponse(JSON.parse(response.text || '{}'), request)
    } catch (error) {
      this.remoteErrors++
      this.changed()
      console.warn('[zenium] Safe Browsing lookup failed:', describeError(error))
      return null
    }
  }

  private remember(
    url: string,
    threat: SafeBrowsingThreat | null,
    expression: string,
    cacheMs: number
  ): void {
    if (this.remoteCache.size >= REMOTE_CACHE_MAX) {
      const oldest = this.remoteCache.keys().next().value
      if (oldest !== undefined) this.remoteCache.delete(oldest)
    }
    this.remoteCache.set(url, { threat, expression, until: Date.now() + cacheMs })
  }

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------

  /** The `DangerVerdictProvider` the download service asks: a listed URL is a dangerous file. */
  verdictProvider(): DangerVerdictProvider {
    return {
      verdict: async (request: DangerVerdictRequest) => {
        const hit = this.lookup(request.url) ?? (await this.checkRemote(request.url))
        if (!hit) return null
        return makeDanger('dangerous', 'url-verdict', dangerSentence(hit.threat))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Feeds
  // ---------------------------------------------------------------------------

  /** Refresh one feed (or every feed) now, whatever its age; resolves when done. */
  async refresh(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.feeds.keys()]
    await Promise.all(ids.map((feedId) => this.enqueue(feedId)))
  }

  private async seedBundled(): Promise<void> {
    const host = this.browser.platform.privacy
    if (!host?.bundledSafeBrowsingFeed) return
    for (const rt of this.feeds.values()) {
      if (this.stopped || rt.doc || !rt.feed.bundled) continue
      try {
        const text = await host.bundledSafeBrowsingFeed(rt.feed.id)
        const doc = parseFeedDocument(text, rt.feed.id)
        if (!doc || rt.doc) continue
        doc.bundled = true
        this.adopt(rt, doc)
        await this.io.write(feedFile(rt.feed.id), JSON.stringify(doc))
        this.changed()
      } catch (error) {
        console.warn(
          `[zenium] Safe Browsing snapshot ${rt.feed.id} not installed:`,
          describeError(error)
        )
      }
    }
  }

  private adopt(rt: FeedRuntime, doc: FeedDocument): void {
    rt.table = PrefixTable.fromBase64(doc.prefixes)
    this.hostCache.clear()
    rt.doc = { ...doc, entries: rt.table.size }
  }

  private async sweep(): Promise<void> {
    if (this.stopped || !this.enabled) return
    const now = Date.now()
    for (const rt of this.feeds.values()) {
      if (rt.updating) continue
      const stale = !rt.doc || rt.doc.bundled || rt.doc.updatedAt + rt.feed.maxAgeMs < now
      if (stale) await this.enqueue(rt.feed.id)
    }
  }

  private enqueue(id: string): Promise<void> {
    const rt = this.feeds.get(id)
    if (!rt || rt.updating) return Promise.resolve()
    rt.updating = true
    this.changed()
    const run = this.queue.then(() => this.fetchFeed(rt))
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async fetchFeed(rt: FeedRuntime): Promise<void> {
    if (this.stopped) {
      rt.updating = false
      return
    }
    try {
      const headers: Record<string, string> = { Accept: 'text/plain, */*;q=0.5' }
      if (rt.doc && !rt.doc.bundled) {
        if (rt.doc.etag) headers['If-None-Match'] = rt.doc.etag
        if (rt.doc.lastModified) headers['If-Modified-Since'] = rt.doc.lastModified
      }
      const response = await this.browser.platform.net.fetchText(rt.feed.url, {
        headers,
        timeoutMs: FETCH_TIMEOUT_MS
      })
      if (response.status === 304 && rt.doc) {
        rt.doc = { ...rt.doc, updatedAt: Date.now() }
        await this.io.write(feedFile(rt.feed.id), JSON.stringify(rt.doc))
        rt.lastError = null
        return
      }
      if (!response.ok)
        throw new Error(
          response.status ? `the server answered ${response.status}` : 'you appear to be offline'
        )
      if (/^\s*</.test(response.text)) throw new Error('the download is not a host list')
      const hosts = parseFeed(response.text, rt.feed.format)
      if (hosts.length === 0) throw new Error('the download holds no hosts')
      const table = await PrefixTable.fromHostsChunked(hosts)
      if (this.stopped) return
      const doc: FeedDocument = {
        version: FEED_DOCUMENT_VERSION,
        id: rt.feed.id,
        threat: rt.feed.threat,
        entries: table.size,
        updatedAt: Date.now(),
        etag: response.headers?.etag ?? null,
        lastModified: response.headers?.['last-modified'] ?? null,
        bundled: false,
        prefixes: table.toBase64()
      }
      rt.table = table
      rt.doc = doc
      this.hostCache.clear()
      rt.lastError = null
      await this.io.write(feedFile(rt.feed.id), JSON.stringify(doc))
    } catch (error) {
      rt.lastError = describeError(error)
      console.warn(`[zenium] Safe Browsing feed ${rt.feed.id} not updated:`, rt.lastError)
    } finally {
      rt.updating = false
      this.changed()
    }
  }

  /** The feeds the service knows (the status card and the tests). */
  feedIds(): string[] {
    return [...this.feeds.keys()]
  }

  /** Replace a feed's table directly (tests, and hosts that build tables themselves). */
  setTable(id: string, table: PrefixTable, updatedAt = Date.now()): void {
    const rt = this.feeds.get(id)
    const feed = safeBrowsingFeed(id)
    if (!rt || !feed) return
    rt.table = table
    this.hostCache.clear()
    rt.doc = {
      version: FEED_DOCUMENT_VERSION,
      id,
      threat: feed.threat,
      entries: table.size,
      updatedAt,
      etag: null,
      lastModified: null,
      bundled: false,
      prefixes: table.toBase64()
    }
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Two URLs name the same document (fragment aside). */
export function sameDocument(a: string, b: string): boolean {
  if (a === b) return true
  const strip = (u: string): string => u.split('#')[0]
  return strip(a) === strip(b)
}

function dangerSentence(threat: SafeBrowsingThreat): string {
  switch (threat) {
    case 'malware':
      return 'This file comes from a site known to spread malware.'
    case 'phishing':
      return 'This file comes from a deceptive site.'
    case 'unwanted':
      return 'This file comes from a site known to spread harmful programs.'
    default:
      return 'This file comes from a site known to attack its visitors.'
  }
}
