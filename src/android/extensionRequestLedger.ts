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
   * marked in this tab, else its own.
   */
  noted(
    tab: string | null,
    requestId: string,
    url: string,
    method: string,
    type: ResourceType,
    initiator: string | undefined,
    now: number
  ): string {
    const key = tab ?? NO_TAB
    const hopKey = `${key}|${url}`
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
    this.hops.set(`${tab ?? NO_TAB}|${targetUrl}`, { chainId, at: now })
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
