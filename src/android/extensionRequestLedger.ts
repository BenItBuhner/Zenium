import type { ResourceType } from '@core/blocking/rules'

/**
 * What the Android runtime keeps of a request between its request stage and its response stage
 * (`blocking-rule-interface.md` §7, round 15's twin of services' pass 2), so the `webRequest`
 * events of one request come under one `requestId` as Chrome's do:
 *
 * - the REDIRECT CHAIN: the Kotlin relay reports a `3xx` hop as headers with no end and hands
 *   the request back to WebView, which follows the redirect itself, and the target comes
 *   through the intercept again as a NEW request under a NEW `ext.request` id (7.3). Chrome
 *   keeps ONE `requestId` across the hops, so `onBeforeRedirect` marks the target's URL here
 *   ([redirected]) and the next request-stage decision in the same tab on that URL continues
 *   under the hop's id ([noted] answers it; [chainIdOf] maps the target's own id back for its
 *   response reports). The mark is short-lived ([Options.hopTtlMs]) and consumed by its first
 *   match: two loads of one redirect target inside the window pair the first with the hop.
 *   A DOCUMENT's redirect has no relayed response at all: WebView follows it, and the hop is
 *   made of the tab's latest open main-frame request at the URL the navigation hook names as
 *   the one redirected from ([openMainFrame]) and marked the same way. The target's request is
 *   one WebView never offers to `shouldInterceptRequest` (Chromium's
 *   `InterceptedRequest::ShouldNotInterceptRequest`, true once the request was redirected –
 *   113.0.5672.136 and main alike; compat round 26), so the runtime notes it itself
 *   ([NotedRequest.synthesized]) under the hop's id; should an intercept of it come after all,
 *   it takes the note over ([adopt]) rather than making a second request of one load.
 *   URLs pair by their canonical form ([requestUrlKey]): the hook's word is the address the
 *   tab was sent to as the app spelled it, the intercept's is WebView's spelling of the same
 *   request (a bare host's trailing slash, the case of scheme and host, a fragment the request
 *   never carries).
 * - the FACTS of a request the response stage needs and `ext.response` does not carry: its
 *   `initiator` (Chrome puts it on every event of the request).
 * - the PAGE-SCRIPT OBSERVER's pairing (7.10): a `fetch` / XHR the page made is heard twice –
 *   at the intercept (its `ext.request`, an `onBeforeRequest`) and in the page (the observer's
 *   report of the response as the page sees it). The observer's report is paired with the
 *   OLDEST UNCLAIMED request of the same tab, URL and method ([claim]) – by URL and order, the
 *   stated limit: two requests of one URL in flight at once whose responses land in the other
 *   order swap ids – and its later report of the same request (`at: 'complete'`) finds the pair
 *   by the observer's own sequence number ([observed] / [observation]).
 *
 * Everything is bounded: [Options.capPerTab] requests per tab, dropped oldest first and after
 * [Options.ttlMs]; a chain longer than the memory breaks into new ids, which the report states.
 */
export interface NotedRequest {
  /** The id the request's `webRequest` events run under: its `ext.request` id, or the chain's. */
  requestId: string
  /** The request's own `ext.request` id (the one its response reports carry). */
  ownId: string
  /** The tab's key in the ledger. */
  tab: string
  url: string
  method: string
  type: ResourceType
  initiator?: string
  at: number
  /** An observer report took this request as its request stage. */
  claimed: boolean
  /** The runtime's own note of a request the intercept never offered (a document's redirect target). */
  synthesized?: boolean
}

/**
 * The form two spellings of one request's URL pair by: parsed and re-serialized, the fragment
 * dropped (a request never carries one); the string itself when it does not parse.
 */
export function requestUrlKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}

/** What the observer's report of one request pairs with: the id, type and initiator its events carry. */
export interface ObservedPair {
  requestId: string
  type: ResourceType
  initiator?: string
}

export interface Options {
  /** Requests remembered per tab; the oldest goes first. */
  capPerTab?: number
  /** How long a remembered request stays pairable. */
  ttlMs?: number
  /** How long a redirect hop waits for its target's request. */
  hopTtlMs?: number
  /** Observer pairs (a `headers` report waiting for its `complete`) kept at most. */
  capObservations?: number
  /** Where the runtime's own ids start: far above the Kotlin sequence, so the two never meet. */
  idBase?: number
}

const DEFAULTS: Required<Options> = {
  capPerTab: 128,
  ttlMs: 120_000,
  hopTtlMs: 30_000,
  capObservations: 256,
  idBase: 2_000_000_000
}

const NO_TAB = ''

export class RequestLedger {
  private readonly options: Required<Options>
  private readonly byTab = new Map<string, NotedRequest[]>()
  private readonly byId = new Map<string, NotedRequest>()
  private readonly hops = new Map<string, { chainId: string; at: number }>()
  private readonly observations = new Map<string, ObservedPair>()
  private minted = 0

  constructor(options: Options = {}) {
    this.options = { ...DEFAULTS, ...options }
  }

  /**
   * A request-stage decision the runtime is about to report as `onBeforeRequest`: remembered,
   * and the id its events run under is answered – the hop's when the URL is a redirect target
   * marked in this tab, else its own. `synthesized` marks the runtime's own note of a request
   * no intercept reported ([NotedRequest.synthesized]).
   */
  noted(
    tab: string | null,
    requestId: string,
    url: string,
    method: string,
    type: ResourceType,
    initiator: string | undefined,
    now: number,
    synthesized = false
  ): string {
    const key = tab ?? NO_TAB
    const hopKey = `${key}|${requestUrlKey(url)}`
    const hop = this.hops.get(hopKey)
    let chainId = requestId
    if (hop) {
      this.hops.delete(hopKey)
      if (now - hop.at <= this.options.hopTtlMs) chainId = hop.chainId
    }
    const entry: NotedRequest = {
      requestId: chainId,
      ownId: requestId,
      tab: key,
      url,
      method,
      type,
      at: now,
      claimed: false
    }
    if (initiator) entry.initiator = initiator
    if (synthesized) entry.synthesized = true
    let list = this.byTab.get(key)
    if (!list) {
      list = []
      this.byTab.set(key, list)
    }
    this.prune(list, now)
    while (list.length >= this.options.capPerTab) this.forget(list.shift())
    list.push(entry)
    this.byId.set(requestId, entry)
    return chainId
  }

  /** The response stage said the request (running under `chainId`) redirects to `targetUrl`. */
  redirected(tab: string | null, chainId: string, targetUrl: string, now: number): void {
    if (this.hops.size >= 64) {
      const oldest = this.hops.keys().next().value
      if (oldest !== undefined) this.hops.delete(oldest)
    }
    this.hops.set(`${tab ?? NO_TAB}|${requestUrlKey(targetUrl)}`, { chainId, at: now })
  }

  /**
   * The tab's LATEST open main-frame request, when its URL is `url` (by [requestUrlKey]) – the
   * request a document's server redirect is made of (the navigation hook names the URL the
   * navigation was redirected from; the runtime makes `onBeforeRedirect` of the pair). Null when
   * the tab's newest main-frame request is another URL (a second navigation in flight since the
   * hop's request: no pair, no event), or when none is remembered (the tab's first load, or a
   * request noted before the response stage was observed).
   */
  openMainFrame(tab: string | null, url: string, now: number): NotedRequest | null {
    const list = this.byTab.get(tab ?? NO_TAB)
    if (!list) return null
    this.prune(list, now)
    const wanted = requestUrlKey(url)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i]
      if (entry.type !== 'main_frame') continue
      return requestUrlKey(entry.url) === wanted ? entry : null
    }
    return null
  }

  /**
   * Whether the tab has ANY open main-frame request at `url` (by [requestUrlKey]), latest or
   * not – the question a document's hop asks before [openMainFrame] (compat round 27, R27-6):
   * none at all means the hop's request-stage decision has not reached the runtime (the
   * navigation hook's notice and the intercept's decision cross the bridge on different legs,
   * and the notice can land first), where one that is not the latest is the pinned case of a
   * newer navigation in flight.
   */
  knowsMainFrame(tab: string | null, url: string, now: number): boolean {
    const list = this.byTab.get(tab ?? NO_TAB)
    if (!list) return false
    this.prune(list, now)
    const wanted = requestUrlKey(url)
    return list.some((entry) => entry.type === 'main_frame' && requestUrlKey(entry.url) === wanted)
  }

  /**
   * An intercept's decision on a request the runtime already noted itself (the tab's latest
   * main-frame note, [NotedRequest.synthesized], at `url`): the note becomes that decision's,
   * `requestId` its own id for the response reports to pair by, and the entry is returned – its
   * `onBeforeRequest` went out already. Null when the tab's latest main-frame note is another
   * request or no synthesized one: the decision is a request of its own.
   */
  adopt(tab: string | null, requestId: string, url: string, now: number): NotedRequest | null {
    const list = this.byTab.get(tab ?? NO_TAB)
    if (!list) return null
    this.prune(list, now)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i]
      if (entry.type !== 'main_frame') continue
      if (!entry.synthesized || requestUrlKey(entry.url) !== requestUrlKey(url)) return null
      this.byId.delete(entry.ownId)
      entry.ownId = requestId
      delete entry.synthesized
      this.byId.set(requestId, entry)
      return entry
    }
    return null
  }

  /**
   * The URL of the tab's latest main-frame request still remembered, for the runtime's trace of
   * a redirect pair [openMainFrame] found no match for; null when none is.
   */
  latestMainFrameUrl(tab: string | null): string | null {
    const list = this.byTab.get(tab ?? NO_TAB)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i]
      if (entry.type === 'main_frame') return entry.url
    }
    return null
  }

  /** The id a response report of the request with `ext.request` id `requestId` runs under. */
  chainIdOf(requestId: string): string {
    return this.byId.get(requestId)?.requestId ?? requestId
  }

  /** The remembered initiator of the request with `ext.request` id `requestId`, if still known. */
  initiatorOf(requestId: string): string | undefined {
    return this.byId.get(requestId)?.initiator
  }

  /** A terminal report (`onCompleted`, `onErrorOccurred`): the request is history. */
  ended(requestId: string): void {
    const entry = this.byId.get(requestId)
    if (!entry) return
    this.byId.delete(requestId)
    const list = this.byTab.get(entry.tab)
    if (!list) return
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
  }

  /**
   * The observer's pairing: the oldest unclaimed request of the tab with this URL and method,
   * claimed; null when none was heard (the observer then mints an id, [mint]).
   */
  claim(tab: string | null, url: string, method: string, now: number): NotedRequest | null {
    const list = this.byTab.get(tab ?? NO_TAB)
    if (!list) return null
    this.prune(list, now)
    for (const entry of list) {
      if (entry.claimed || entry.url !== url || entry.method !== method) continue
      entry.claimed = true
      return entry
    }
    return null
  }

  /** The observer's `headers` report of request `seq` in the tab paired with `pair`. */
  observed(tab: string, seq: string, pair: ObservedPair): void {
    if (this.observations.size >= this.options.capObservations) {
      const oldest = this.observations.keys().next().value
      if (oldest !== undefined) this.observations.delete(oldest)
    }
    this.observations.set(`${tab}|${seq}`, pair)
  }

  /** What the observer's request `seq` in the tab was paired with at its `headers` report. */
  observation(tab: string, seq: string): ObservedPair | null {
    return this.observations.get(`${tab}|${seq}`) ?? null
  }

  /** The observer's `complete` report: the pair is done. */
  observationEnded(tab: string, seq: string): void {
    this.observations.delete(`${tab}|${seq}`)
  }

  /** A new document in the tab: the observer's pending pairs were the old document's. */
  documentChanged(tab: string): void {
    for (const key of [...this.observations.keys()]) {
      if (key.startsWith(`${tab}|`)) this.observations.delete(key)
    }
  }

  /** The tab is gone with everything remembered of it. */
  tabRemoved(tab: string): void {
    const list = this.byTab.get(tab)
    if (list) {
      for (const entry of list) this.byId.delete(entry.ownId)
      this.byTab.delete(tab)
    }
    this.documentChanged(tab)
    for (const key of [...this.hops.keys()]) {
      if (key.startsWith(`${tab}|`)) this.hops.delete(key)
    }
  }

  /** An id of the runtime's own for a response the intercept never reported the request of. */
  mint(): string {
    this.minted += 1
    return String(this.options.idBase + this.minted)
  }

  private prune(list: NotedRequest[], now: number): void {
    while (list.length > 0 && now - list[0].at > this.options.ttlMs) this.forget(list.shift())
  }

  private forget(entry: NotedRequest | undefined): void {
    if (entry) this.byId.delete(entry.ownId)
  }
}
