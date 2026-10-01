/**
 * Desktop ad and tracker blocking on top of the session's `webRequest` multiplexer
 * (`webRequest.ts`): one {@link BlockingHandler} that applies the core engine's decisions, the
 * text matcher for ABP filter lists and the bundled snapshot of the default lists.
 *
 * Matching: structured rules are decided by the core's `RuleEngine`; the ABP filter lists are
 * matched by Ghostery's `FiltersEngine` (MPL-2.0), which parses EasyList syntax natively and
 * answers in microseconds through its token index. It is faster and more complete than a matcher
 * written here would be, and it already handles `$redirect`, `$csp`, `$important` and
 * `$badfilter`. Its serialised form is cached so later starts skip parsing. Top-level documents
 * are the one thing it is not asked about: the core's `DocumentFilters` decides navigations with
 * uBlock Origin's rule (only `$document` / `$all` filters block a page), as the Kotlin engine does.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { app, type Session } from 'electron'
import { existsSync, promises as fs, readFileSync, rmSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Browser } from '../../core/browser'
import { DocumentFilters } from '../../core/blocking/documentFilters'
import { hostnameOf } from '../../core/blocking/domain'
import type { BlockedRequestSource } from '../../core/blocking/report'
import {
  TEXT_MATCH_SET_ID,
  type RuleEngine,
  type TextMatch,
  type TextMatcher
} from '../../core/blocking/engine'
import type { BlockingHost, BundledFilterList } from '../../core/platform'
import type {
  Decision,
  RequestContext,
  RuleSet,
  RuleSetChange,
  RuleSetSummary
} from '../../core/blocking/rules'
import { BLOCKING_DIR, type RuleSetStore } from '../../core/blocking/store'
import {
  GHOSTERY_CACHE_FORMAT,
  GHOSTERY_COMPILE_TASK,
  compileGhosteryEngine,
  matchesCacheDigest,
  writeGhosteryCache,
  type GhosteryCacheMeta,
  type GhosteryCachePaths,
  type GhosteryCompileOutput,
  type GhosteryCompileScope
} from './blockingCompile'
import type { RequestHeaderHandler } from './requestHeaders'
import {
  HANDLER_ORDER,
  WebRequestMultiplexer,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type HeaderRewriteOptions,
  type HeadersReceivedResult,
  type HostRequest,
  type ListenerOptions,
  type RequestHandler,
  type TabResolver,
  type WebRequestBase,
  type WebRequestEvent,
  type WebRequestListener
} from './webRequest'

export type {
  BlockingResponse,
  HeaderRewriteOptions,
  ListenerFilter,
  ListenerOptions,
  WebRequestBase,
  WebRequestDetails,
  WebRequestEvent,
  WebRequestListener
} from './webRequest'
export type { RequestHeaderHandler } from './requestHeaders'
export { BLOCKING_EVENTS, WEB_REQUEST_EVENTS } from './webRequest'

// ---------------------------------------------------------------------------
// The blocking handler
// ---------------------------------------------------------------------------

const DECISION_KEY = 'blocking.decision'

/**
 * Where a decision was taken: `request` at `onBeforeRequest`, `headersReceived` at
 * `onHeadersReceived`, when a header-conditioned rule made the engine decide again with the
 * response headers in hand. Both stages of one request can be reported, in that order.
 */
export type DecisionStage = 'request' | 'headersReceived'

/** What the handler needs from the core: decisions and the counters. */
export interface BlockingDecider {
  decide(ctx: RequestContext): Decision
  /** `source`: the blocked request's host and the set that matched, for the tracker report. */
  recordBlocked(tabId: string | undefined, count?: number, source?: BlockedRequestSource): void
}

/** The tracker report's view of a blocked request: its hostname and the matched set's id. */
function blockedSource(ctx: RequestContext, decision: Decision): BlockedRequestSource | undefined {
  const host = hostnameOf(ctx.url)
  return host ? { host, setId: decision.matched?.setId } : undefined
}

/** The text matcher's extra answer for documents: `$csp` directives the lists inject. */
export interface CspSource {
  cspDirectives(ctx: RequestContext): string | null
}

/** Applies the core engine's decisions: cancel, redirect, header edits and `$csp` directives. */
export class BlockingHandler implements RequestHandler {
  readonly id = 'blocking'
  readonly order = HANDLER_ORDER.ruleEngine

  constructor(
    private readonly decider: BlockingDecider,
    private readonly csp: CspSource | null,
    /**
     * Told about every decision a named rule took, with the request it was about and the stage
     * it was taken at. A request decided by a header-conditioned rule is reported at both stages
     * unless the same rule decided both.
     */
    private readonly observer:
      ((request: HostRequest, decision: Decision, stage: DecisionStage) => void) | null = null
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (!/^(https?|wss?):/i.test(ctx.url)) return undefined
    const decision = this.decider.decide(ctx)
    if (decision.matched && this.observer) this.observer(request, decision, 'request')
    switch (decision.action) {
      case 'block':
        this.decider.recordBlocked(request.tabId, 1, blockedSource(ctx, decision))
        return { cancel: true }
      case 'redirect':
      case 'upgrade':
        if (decision.redirectUrl && decision.redirectUrl !== ctx.url) {
          // A list's `$redirect` to a neutered resource is a blocked request from the user's
          // point of view; a translator's plain redirect or an upgrade is not.
          if (decision.matched?.setId === TEXT_MATCH_SET_ID)
            this.decider.recordBlocked(request.tabId, 1, blockedSource(ctx, decision))
          return { redirectURL: decision.redirectUrl }
        }
        return undefined
      case 'modifyHeaders':
        request.state.set(DECISION_KEY, decision)
        return undefined
      default:
        // An allow that a header-conditioned rule may still overturn once the response headers
        // are in: keep it so onHeadersReceived knows to ask the engine again.
        if (decision.needsHeaders) request.state.set(DECISION_KEY, decision)
        return undefined
    }
  }

  onBeforeSendHeaders(request: HostRequest, headers: Record<string, string>): undefined {
    const decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.requestHeaders?.length) applyRequestHeaderOps(headers, decision.requestHeaders)
    return undefined
  }

  onHeadersReceived(
    request: HostRequest,
    headers: Record<string, string[]>
  ): HeadersReceivedResult | undefined {
    const { ctx } = request
    let decision = request.state.get(DECISION_KEY) as Decision | undefined
    if (decision?.needsHeaders) {
      // The headers-received stage: the engine decides again with the response headers, merging
      // the header-conditioned rules with what it found at the request stage; that decision's
      // header edits replace the request stage's (they contain them). Reported under its stage
      // when a different rule decided it: a header-conditioned modifyHeaders rule stacked behind
      // the request stage's rule stays unreported (Chrome records every header action).
      const late = this.decider.decide({ ...ctx, responseHeaders: headers })
      if (late.matched && this.observer && !sameMatch(late.matched, decision.matched))
        this.observer(request, late, 'headersReceived')
      switch (late.action) {
        case 'block':
          this.decider.recordBlocked(request.tabId, 1, blockedSource(ctx, late))
          return { cancel: true }
        case 'redirect':
        case 'upgrade':
          if (late.redirectUrl && late.redirectUrl !== ctx.url) {
            if (late.matched?.setId === TEXT_MATCH_SET_ID)
              this.decider.recordBlocked(request.tabId, 1, blockedSource(ctx, late))
            return { redirectURL: late.redirectUrl }
          }
          break
        default:
          break
      }
      decision = late
    }
    if (decision?.responseHeaders?.length) applyResponseHeaderOps(headers, decision.responseHeaders)
    if (this.csp && (ctx.type === 'main_frame' || ctx.type === 'sub_frame')) {
      const csp = this.csp.cspDirectives(ctx)
      if (csp)
        applyResponseHeaderOps(headers, [
          { header: 'Content-Security-Policy', operation: 'append', value: csp }
        ])
    }
    return undefined
  }
}

function sameMatch(a: Decision['matched'], b: Decision['matched']): boolean {
  return a?.setId === b?.setId && a?.ruleId === b?.ruleId && a?.filter === b?.filter
}

// ---------------------------------------------------------------------------
// Ghostery text matcher
// ---------------------------------------------------------------------------

/** Ghostery request types the core's resource types map to. */
function ghosteryType(type: RequestContext['type']): string {
  switch (type) {
    case 'webtransport':
    case 'webbundle':
      return 'other'
    default:
      return type
  }
}

/** What the matcher follows: the core engine (which sets are on) and the store (their text). */
export interface TextSource {
  engine: RuleEngine
  store: Pick<RuleSetStore, 'readFilterText'>
}

/**
 * The compile handed off the main process (`ElectronBlocking` gives the core's background queue
 * running `GHOSTERY_COMPILE_TASK`): the scopes of one build in – each one's lists' text and
 * where to cache it – the serialised engines and the document filters' lines out, in one
 * answer. Absent, the matcher parses on the spot (the tests, a host without a queue).
 */
export type GhosteryCompile = (scopes: GhosteryCompileScope[]) => Promise<GhosteryCompileOutput>

/**
 * How long a batch of list arrivals (a set's text downloaded, a bundled snapshot installed) is
 * given to settle before the engine is rebuilt once for all of it: every arrival starts or
 * extends the window. A fresh profile's parallel downloads land in clusters; one window catches
 * a cluster. A user's change (the level, the private switch, a list toggled) never waits on it.
 */
export const LIST_SETTLE_MS = 1000
/** The most a batch of arrivals can wait, from its first arrival: a trickle still adopts. */
export const LIST_SETTLE_CAP_MS = 5000
/**
 * The most the deserialise of a compiled engine waits for an idle moment on the main thread
 * before it runs regardless, while the scope it is for has no list compiled yet: protection
 * is never deferred past this by the idle heuristic.
 */
export const DESERIALISE_IDLE_CAP_MS = 250
/**
 * Once a scope has a list compiled, a later build's bytes protect no one yet, and their
 * deserialise waits for a real gap: the main thread quiet – every probe on time – for this long
 * (W8-P1b). A gap this wide is one no task of the chrome's is in the middle of.
 */
export const IDLE_QUIET_MS = 50
/** The most that wait lasts; past it the deserialise runs at the next probe, quiet or not. */
export const IDLE_WAIT_CAP_MS = 3000

/**
 * Runs `fn` once, when the main thread has looked idle for `quietMs` (0: at the first idle
 * moment) or at `capMs` from now, whichever is first; returns the function that cancels it.
 * {@link mainThreadIdleSlot} is the main process's; the tests hand in one they fire by hand.
 */
export type IdleSlot = (fn: () => void, capMs: number, quietMs?: number) => () => void

/** How long the idle slot's probe timer is set for. */
export const IDLE_PROBE_MS = 4
/** A probe that fires this much later than set says the loop was busy with something else. */
const IDLE_LATE_MS = 4

/**
 * The main process's idle slot. Electron's main process has no `requestIdleCallback`; what it
 * has is the event loop itself, and a short timer's lateness is the loop's own measure of how
 * busy it is (what `monitorEventLoopDelay` reads). The slot sets a {@link IDLE_PROBE_MS} probe
 * – a yield, so whatever already landed (an IPC message, a hook's callback) runs first – and
 * runs `fn` when the probe fires on time with the loop quiet for `quietMs` behind it; a probe
 * that fires late (another task held the loop) starts the quiet count over and sets the next,
 * until `capMs` from the start, when `fn` runs at the next probe regardless.
 */
export function idleSlot(
  options: { busy?: (lateMs: number) => boolean; now?: () => number } = {}
): IdleSlot {
  const now = options.now ?? (() => performance.now())
  const busy = options.busy ?? ((lateMs: number): boolean => lateMs > IDLE_LATE_MS)
  return (fn, capMs, quietMs = 0) => {
    const started = now()
    let quietSince = started
    let timer: ReturnType<typeof setTimeout> | null = null
    const probe = (): void => {
      const expected = now() + IDLE_PROBE_MS
      timer = setTimeout(() => {
        timer = null
        const at = now()
        if (busy(at - expected)) quietSince = at
        const quiet = quietSince !== at && at - quietSince >= quietMs
        if (!quiet && at - started < capMs) {
          probe()
          return
        }
        fn()
      }, IDLE_PROBE_MS)
    }
    probe()
    return () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

/** The main process's idle slot, as `ElectronBlocking` wires it. */
export const mainThreadIdleSlot: IdleSlot = idleSlot()

/** One compiled matcher: Ghostery's engine over some sets' text and the lists' document filters. */
interface Compiled {
  engine: FiltersEngine
  /** The lists' document-level filters, decided here rather than by Ghostery. */
  documents: DocumentFilters
  /** The sets it was built from (`id:updatedAt:filterCount|…`; empty for no sets at all). */
  fingerprint: string
}

/** The sets one matcher is built from: the partition it answers for (null: every unscoped one). */
interface Scope {
  partition: string | null
  sets: RuleSetSummary[]
}

/** What one build of every scope read and handed off, for its end to settle. */
interface Build {
  /** The unpersisted text the build read, by set id. */
  used: Map<string, string>
  /** True once a scope parsed text (on the spot or in the worker) rather than adopting a cache. */
  parsed: boolean
  /** The scopes the worker compiles; the build ends when their bytes are in. */
  work: Array<{ scope: GhosteryCompileScope; fingerprint: string }>
}

/** A scope's compiled bytes back from the worker, waiting for the idle slot to deserialise them. */
interface Waiting {
  partition: string | null
  fingerprint: string
  engine: Uint8Array
  /** The document filters' lines: the fallback, parsed only if `documentsBin` does not read. */
  documents: string
  /** The document filters' serialised form: what the slot deserialises. */
  documentsBin: Uint8Array
}

/** Why the matcher is asked to rebuild: a list's text arrived, or the user changed something. */
export type RebuildCause = 'arrival' | 'user'

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/** The key one scope's bytes wait under. */
function scopeKey(partition: string | null): string {
  return partition === null ? '' : `.${partition}`
}

/** Cache paths whose damage was already logged this session: the warning is not repeated. */
const warnedDamagedCaches = new Set<string>()

/**
 * A cache that is there but cannot be trusted (`readCache` names the reason): a miss, logged
 * once per path – the files are not removed, since the build that follows overwrites them.
 */
function damagedCache(bin: string, reason: string, error?: unknown): null {
  if (!warnedDamagedCaches.has(bin)) {
    warnedDamagedCaches.add(bin)
    if (error === undefined) console.warn('[zenium] filter engine cache not read', bin, reason)
    else console.warn('[zenium] filter engine cache not read', bin, reason, error)
  }
  return null
}

/**
 * Matches the enabled `filterText` sets with Ghostery's `FiltersEngine`. The engine is rebuilt
 * (off the current tick) whenever one of those sets changes – compiled in the background worker
 * when a {@link GhosteryCompile} is given, so the main process only deserialises the bytes, and
 * changes that land while a build is out are folded into the one build after it – and its
 * serialised form is cached under `blocking/engine.bin` so later starts deserialise in
 * milliseconds instead of parsing.
 *
 * One matcher per partition the sets name (`RuleEngine.textPartitions`): the unscoped sets make
 * the matcher every partition uses; a partition an enabled text set is scoped to or excluded
 * from gets a matcher of its own over the sets that apply there (`RuleEngine.textSetsFor`) – the
 * filter lists private windows alone turn on under "Always use Strict in private windows" name
 * `private`, so a private window's request meets the Strict lists and no other window's does.
 * Each is built, cached (`engine.<partition>.bin`) and adopted by the same rules.
 *
 * When a build runs (W8-P1). A user's change – a list toggled, the level, the private switch
 * (a set's `enabled` or partitions moved, a set removed, the user's own filters) – rebuilds on
 * the short timer (`rebuildDelayMs`), so the UI is followed at once. A list's arrival – its text
 * downloaded or installed, its `updatedAt` / `filterCount` moved – starts or extends a settle
 * window ({@link LIST_SETTLE_MS}, capped at {@link LIST_SETTLE_CAP_MS} from the batch's first
 * arrival), so a sweep's downloads adopt once when they have settled; except that a scope with
 * no engine built from any list yet adopts its first arrival on the short timer, since the user
 * is unprotected meanwhile. A user's change while a window is pending cancels the window and
 * runs the one build, which reads every arrival so far. A change during a build marks it dirty
 * and exactly one build follows, reading the sets as they stand then.
 *
 * Where the work runs. The worker compiles every scope of a build in one message and writes
 * the cache files itself, after it has answered; the main thread deserialises the bytes – the
 * engine's, and the document filters' serialised form, which it no longer parses from their
 * lines (seed #45) – in an idle slot ({@link IdleSlot}) and adopts each scope by one reference
 * assignment – a request in flight answers from the old engine or the new one, never from
 * nothing. One scope per slot (W8-P1b): each scope's engine is its own blob, so a build of
 * several scopes costs the main thread several short stalls rather than one long one; a scope
 * with no list compiled yet takes the first idle moment, capped at
 * {@link DESERIALISE_IDLE_CAP_MS}, and any other waits for the loop to be quiet
 * {@link IDLE_QUIET_MS}, capped at {@link IDLE_WAIT_CAP_MS} – unless a scope with no list
 * compiled yet arrives during that wait, which cuts it short (W8-P1c). Bytes a newer build
 * replaces before their slot fires are dropped unread.
 */
export class GhosteryTextMatcher implements TextMatcher, CspSource {
  /** The matcher of the unscoped sets: every partition no scoped text set names. */
  private general: Compiled | null = null
  /** The matchers of the partitions a scoped text set names, by partition. */
  private readonly scoped = new Map<string, Compiled>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** When the armed timer fires, so an unchanged deadline leaves it be. */
  private timerDue: number | null = null
  /** A user's change is due at this time (the short timer). */
  private promptDue: number | null = null
  /** The arrivals' settle window ends at this time. */
  private settleDue: number | null = null
  /** When the current batch of arrivals began (the cap counts from here). */
  private batchStart: number | null = null
  private building = false
  private dirty = false
  /** Filter text of sets changed since the last build (persisted sets are read from disk). */
  private readonly pendingText = new Map<string, string>()
  /** Each set's summary as last seen, to tell an arrival from a toggle. */
  private readonly seen = new Map<string, RuleSetSummary>()
  /** Compiled bytes back from the worker, by scope, until the idle slot deserialises them. */
  private readonly waiting = new Map<string, Waiting>()
  private cancelIdle: (() => void) | null = null
  /** Whether the slot on its way was asked for as the urgent one (the first idle moment). */
  private slotUrgent = false
  /** Builds so far, for tests and diagnostics. */
  builds = 0
  /** Whether the current unscoped matcher came out of the cache. */
  fromCache = false
  /** Scopes compiled off the main process and adopted so far (diagnostics and the tests). */
  compiledInBackground = 0
  /** Scopes' bytes a newer build replaced before they were deserialised (diagnostics and the tests). */
  superseded = 0

  constructor(
    private readonly source: TextSource,
    private readonly cacheDir: string,
    private readonly cacheVersion: string = app.getVersion(),
    private readonly rebuildDelayMs = 50,
    private readonly compile: GhosteryCompile | null = null,
    private readonly idle: IdleSlot = mainThreadIdleSlot,
    private readonly now: () => number = Date.now
  ) {}

  /** Follow the core engine; returns the unsubscribe function. */
  start(): () => void {
    const unsubscribe = this.source.engine.subscribe((change) => {
      const cause = this.classify(change)
      if (cause) this.scheduleRebuild(cause)
    })
    this.scheduleRebuild('user')
    return () => {
      unsubscribe()
      this.disarm()
      this.cancelIdle?.()
      this.cancelIdle = null
    }
  }

  /** True once a build reflects the current sets. */
  get ready(): boolean {
    return this.general !== null && !this.dirty && !this.building && this.waiting.size === 0
  }

  /** The partitions with a matcher of their own right now (diagnostics and the tests). */
  get scopedPartitions(): string[] {
    return [...this.scoped.keys()]
  }

  /** Sets whose unpersisted text waits for a build to read it (diagnostics and the tests). */
  get pendingSets(): number {
    return this.pendingText.size
  }

  /** Scopes whose compiled bytes wait for the idle slot (diagnostics and the tests). */
  get waitingScopes(): number {
    return this.waiting.size
  }

  /**
   * The matcher a request from `partition` is answered by: the partition's own while it has
   * one, else the unscoped sets'. A partition whose own matcher is still being built answers
   * from the unscoped one meanwhile, as every partition did before it was named.
   */
  private compiledFor(partition: string | undefined): Compiled | null {
    return (partition !== undefined ? this.scoped.get(partition) : undefined) ?? this.general
  }

  match(ctx: RequestContext): TextMatch | null {
    const compiled = this.compiledFor(ctx.partition)
    if (!compiled) return null
    if (ctx.type === 'main_frame') {
      const document = compiled.documents.decide(ctx.url)
      return document ? { action: document.action, filter: document.filter } : null
    }
    // An `@@…$document` exception on the page switches the lists off for everything it loads.
    const page = ctx.documentUrl ?? ctx.initiator
    if (page) {
      const exception = compiled.documents.exception(page)
      if (exception) return { action: 'allow', filter: exception }
    }
    const result = compiled.engine.match(this.requestFor(ctx))
    if (result.exception) return { action: 'allow', filter: result.exception.toString() }
    if (result.redirect)
      return {
        action: 'redirect',
        redirectUrl: result.redirect.dataUrl,
        filter: result.filter?.toString()
      }
    if (result.match) return { action: 'block', filter: result.filter?.toString() }
    return null
  }

  /** `$csp` directives the lists want injected into a document, or null. */
  cspDirectives(ctx: RequestContext): string | null {
    const compiled = this.compiledFor(ctx.partition)
    if (!compiled) return null
    return compiled.engine.getCSPDirectives(this.requestFor(ctx)) ?? null
  }

  private requestFor(ctx: RequestContext): Request {
    return Request.fromRawDetails({
      url: ctx.url,
      sourceUrl: ctx.initiator ?? ctx.documentUrl ?? '',
      type: ghosteryType(ctx.type) as Request['type'],
      tabId: ctx.tabId ? Number(ctx.tabId.replace(/\D+/g, '')) || 0 : 0
    })
  }

  /**
   * What a change to a set means for the matcher: nothing (a structured-only set), a user's
   * change, or a list's arrival. The engine's change events do not say which of its setters
   * fired, so the change is classified by what moved against the set's summary as last seen:
   * `enabled` or the partitions – a toggle, the level, the private switch – is the user's, as
   * is a removal and the user's own filters; a set first seen with text, or whose `updatedAt`
   * / `filterCount` moved, is an arrival (a download, a bundled snapshot, a sweep's refresh).
   * An arrival for a scope with no list compiled yet counts as the user's: it lands at once.
   */
  private classify(change: RuleSetChange): RebuildCause | null {
    const previous = this.seen.get(change.id)
    if (change.kind === 'remove') {
      this.seen.delete(change.id)
      this.pendingText.delete(change.id)
      return 'user'
    }
    if (change.set?.filterText !== undefined && !change.persisted)
      this.pendingText.set(change.id, change.set.filterText)
    const summary = change.summary
    if (summary) this.seen.set(change.id, summary)
    const textual = (summary?.hasFilterText ?? false) || (change.set?.filterText ?? '').length > 0
    if (!textual) return null
    if (change.set?.source === 'user') return 'user'
    if (
      previous &&
      summary &&
      (previous.enabled !== summary.enabled ||
        !sameList(previous.partitions, summary.partitions) ||
        !sameList(previous.excludedPartitions, summary.excludedPartitions))
    )
      return 'user'
    return summary && this.unprotected(summary) ? 'user' : 'arrival'
  }

  /** Whether a scope the set applies to has no engine built from any list yet. */
  private unprotected(summary: RuleSetSummary): boolean {
    const scopes = summary.partitions?.length ? summary.partitions : [null]
    return scopes.some((partition) => this.unprotectedScope(partition))
  }

  /**
   * Whether `partition`'s requests meet no list yet: no matcher answers for it (its own, or
   * the unscoped one it falls back to), or the one that does was built from no sets.
   */
  private unprotectedScope(partition: string | null): boolean {
    const compiled =
      partition === null ? this.general : (this.scoped.get(partition) ?? this.general)
    return !compiled || compiled.fingerprint === ''
  }

  /**
   * Ask for a build: a user's change on the short timer, an arrival at the end of the settle
   * window it starts or extends (never past the cap from the batch's first arrival). A user's
   * change cancels a pending window – its build reads the arrivals too. During a build only the
   * deadline is noted; the build's end arms it.
   */
  private scheduleRebuild(cause: RebuildCause = 'user'): void {
    const now = this.now()
    this.dirty = true
    if (cause === 'user') {
      const due = now + this.rebuildDelayMs
      this.promptDue = this.promptDue === null ? due : Math.min(this.promptDue, due)
      this.settleDue = null
      this.batchStart = null
    } else {
      if (this.batchStart === null) this.batchStart = now
      this.settleDue = Math.min(now + LIST_SETTLE_MS, this.batchStart + LIST_SETTLE_CAP_MS)
    }
    if (!this.building) this.arm()
  }

  /** Arm the timer for the nearest deadline (a user's or the window's), if it is not already. */
  private arm(): void {
    const dues = [this.promptDue, this.settleDue].filter((due): due is number => due !== null)
    if (dues.length === 0) return
    const due = Math.min(...dues)
    if (this.timer && this.timerDue === due) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.timerDue = null
        if (!this.building) this.rebuild()
      },
      Math.max(0, due - this.now())
    )
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.timerDue = null
  }

  /**
   * Parse (or deserialise) the enabled text sets – the unscoped sets' matcher and one per
   * partition a scoped set names. Synchronous without a {@link GhosteryCompile} (~100 ms for the
   * default lists on the spot); with one, the parses run in the background and the old matchers
   * answer until the new ones are adopted (`ready` is false meanwhile). Called during a build,
   * it asks for one more once this one is over.
   */
  rebuild(): void {
    if (this.building) {
      this.scheduleRebuild('user')
      return
    }
    this.building = true
    this.dirty = false
    this.promptDue = null
    this.settleDue = null
    this.batchStart = null
    this.disarm()
    const engine = this.source.engine
    const scopes: Scope[] = [
      { partition: null, sets: engine.textSetsFor(undefined) },
      ...engine.textPartitions().map((partition) => ({
        partition,
        sets: engine.textSetsFor(partition)
      }))
    ]
    // A partition no scoped set names any more answers from the unscoped matcher again, and
    // its cache files go with it.
    const named = new Set(scopes.map((scope) => scope.partition))
    for (const partition of [...this.scoped.keys()])
      if (!named.has(partition)) {
        this.scoped.delete(partition)
        this.waiting.delete(scopeKey(partition))
        this.removeCache(partition)
      }
    const build: Build = { used: new Map(), parsed: false, work: [] }
    let handedOff = false
    try {
      for (const scope of scopes) this.buildScope(scope, build)
      if (build.work.length > 0 && this.compile) {
        handedOff = true
        void this.compile(build.work.map((item) => item.scope))
          .then((output) => this.received(output, build))
          .catch((error: unknown) => console.error('[zenium] filter engine build failed', error))
          .finally(() => this.finishBuild(build))
      }
    } catch (error) {
      console.error('[zenium] filter engine build failed', error)
    } finally {
      if (!handedOff) this.finishBuild(build)
    }
  }

  /**
   * One scope's matcher: nothing for no sets (the master switch off disables every list – an
   * empty engine is not worth caching, and writing it would evict the lists' serialised form
   * that the next switch on, and the next start, deserialise instead of parsing); nothing to do
   * when the scope's current matcher, or the bytes waiting for it, already carry the sets'
   * fingerprint; the cache when its fingerprint matches; else a parse – on the spot, or queued
   * for the worker, whose one answer for the build carries every queued scope.
   */
  private buildScope(scope: Scope, build: Build): void {
    const fingerprint = scope.sets
      .map((s) => `${s.id}:${s.updatedAt ?? 0}:${s.filterCount}`)
      .join('|')
    const key = scopeKey(scope.partition)
    const current = scope.partition === null ? this.general : this.scoped.get(scope.partition)
    if (scope.sets.length === 0) {
      this.waiting.delete(key)
      if (current?.fingerprint === '') return
      this.adopt(scope.partition, {
        engine: FiltersEngine.parse('', { loadCosmeticFilters: false, debug: false }),
        documents: DocumentFilters.parse([]),
        fingerprint
      })
      if (scope.partition === null) this.fromCache = false
      return
    }
    if (current?.fingerprint === fingerprint) {
      this.waiting.delete(key)
      return
    }
    if (this.waiting.get(key)?.fingerprint === fingerprint) return
    const cached = this.readCache(scope.partition, fingerprint)
    if (cached) {
      this.waiting.delete(key)
      this.adopt(scope.partition, cached)
      if (scope.partition === null) this.fromCache = true
      return
    }
    build.parsed = true
    const parts: string[] = []
    for (const summary of scope.sets) {
      const pending = this.pendingText.get(summary.id)
      if (pending !== undefined) build.used.set(summary.id, pending)
      const text = pending ?? this.source.store.readFilterText(summary.id)
      if (text) parts.push(text)
    }
    if (this.compile) {
      build.work.push({
        fingerprint,
        scope: {
          partition: scope.partition,
          parts,
          cache: { ...this.cachePaths(scope.partition), fingerprint, version: this.cacheVersion }
        }
      })
      return
    }
    const { engine, documents } = compileGhosteryEngine(parts)
    this.waiting.delete(key)
    this.adopt(scope.partition, { engine, documents, fingerprint })
    if (scope.partition === null) this.fromCache = false
    writeGhosteryCache(
      { ...this.cachePaths(scope.partition), fingerprint, version: this.cacheVersion },
      engine.serialize(),
      documents.lines.join('\n'),
      documents.serialize()
    )
  }

  /**
   * The worker's answer for a build: every scope's bytes are set waiting under its key – a
   * scope's older bytes still waiting are replaced, unread – and the idle slot is asked for,
   * unless one is already on its way.
   */
  private received(output: GhosteryCompileOutput, build: Build): void {
    for (const item of build.work) {
      const compiled = output.scopes.find((scope) => scope.partition === item.scope.partition)
      if (!compiled) continue
      const key = scopeKey(item.scope.partition)
      if (this.waiting.has(key)) this.superseded++
      this.waiting.set(key, {
        partition: item.scope.partition,
        fingerprint: item.fingerprint,
        engine: compiled.engine,
        documents: compiled.documents,
        documentsBin: compiled.documentsBin
      })
    }
    this.requestSlot()
  }

  /**
   * The scope whose bytes the next slot is for: one with no list compiled yet before any other
   * (its requests meet nothing meanwhile), else the longest waiting.
   */
  private nextWaiting(): Waiting | undefined {
    let first: Waiting | undefined
    for (const item of this.waiting.values()) {
      if (this.unprotectedScope(item.partition)) return item
      first ??= item
    }
    return first
  }

  /**
   * Ask for the idle slot for the next waiting scope, unless one is already on its way or
   * nothing waits. A scope with no list compiled yet gets the first idle moment, capped at
   * {@link DESERIALISE_IDLE_CAP_MS}; any other's bytes wait for {@link IDLE_QUIET_MS} of quiet,
   * capped at {@link IDLE_WAIT_CAP_MS}, since the scope's requests are answered meanwhile. A
   * slot on its way keeps what it was asked for, with one exception (W8-P1c): when the bytes
   * that just arrived make the next scope one with no list compiled yet, a slot waiting for
   * quiet is cancelled and asked for again as the urgent one, so that scope is not left
   * unprotected for up to the quiet wait's cap.
   */
  private requestSlot(): void {
    const next = this.nextWaiting()
    if (!next) return
    const urgent = this.unprotectedScope(next.partition)
    if (this.cancelIdle) {
      if (this.slotUrgent || !urgent) return
      this.cancelIdle()
      this.cancelIdle = null
    }
    this.slotUrgent = urgent
    this.cancelIdle = this.idle(
      () => {
        this.cancelIdle = null
        this.adoptNext()
      },
      urgent ? DESERIALISE_IDLE_CAP_MS : IDLE_WAIT_CAP_MS,
      urgent ? 0 : IDLE_QUIET_MS
    )
  }

  /**
   * The idle slot: deserialise one scope's waiting bytes – the newest for that scope, whatever
   * waited when the slot was asked for – and adopt it by one assignment; the next scope, if
   * any waits, gets a slot of its own.
   */
  private adoptNext(): void {
    const item = this.nextWaiting()
    if (!item) return
    this.waiting.delete(scopeKey(item.partition))
    try {
      const compiled: Compiled = {
        engine: FiltersEngine.deserialize(item.engine),
        documents: this.documentsOf(item.partition, item.documentsBin, item.documents),
        fingerprint: item.fingerprint
      }
      this.adopt(item.partition, compiled)
      if (item.partition === null) this.fromCache = false
      this.compiledInBackground++
    } catch (error) {
      console.error('[zenium] filter engine could not be adopted', error)
    }
    this.requestSlot()
  }

  /**
   * The document filters from their serialised form – milliseconds, no line parsed – or, when
   * the bytes do not deserialise (a blob of another `DOCUMENT_FILTERS_FORMAT`; this build's
   * own worker never hands one over), from the lines kept beside them, parsed as every adopt
   * did before seed #45, the damage logged once per cache path.
   */
  private documentsOf(partition: string | null, bytes: Uint8Array, lines: string): DocumentFilters {
    try {
      return DocumentFilters.deserialize(bytes)
    } catch (error) {
      damagedCache(this.cachePaths(partition).bin, 'document filters not deserialised', error)
      return DocumentFilters.parse([lines])
    }
  }

  private adopt(partition: string | null, compiled: Compiled): void {
    if (partition === null) this.general = compiled
    else this.scoped.set(partition, compiled)
  }

  private forgetUsed(used: Map<string, string>): void {
    for (const [id, text] of used)
      if (this.pendingText.get(id) === text) this.pendingText.delete(id)
  }

  /**
   * A build that parsed nothing – every scope empty or from the cache – has no use for the
   * text a list update left behind (the master switch off would otherwise hold every list's
   * text until it turns on); one that parsed forgets only the text it read, so a set that
   * changed again while a background build was out keeps its newer text for the next. A change
   * that landed during the build arms the one build that follows.
   */
  private finishBuild(build: Build): void {
    if (build.parsed) this.forgetUsed(build.used)
    else this.pendingText.clear()
    this.builds++
    this.building = false
    if (this.dirty) this.arm()
  }

  /**
   * The cache files of one scope: the unscoped matcher's are the names every build before the
   * scoped ones wrote (`engine.bin`, `engine.json`, `documents.txt`; `documents.bin` since
   * format 3), a partition's carry the partition in the name.
   */
  private cachePaths(partition: string | null): GhosteryCachePaths {
    const tag = partition === null ? '' : `.${partition.replace(/[^a-z0-9_-]/gi, '_')}`
    return {
      bin: join(this.cacheDir, `engine${tag}.bin`),
      meta: join(this.cacheDir, `engine${tag}.json`),
      documents: join(this.cacheDir, `documents${tag}.txt`),
      documentsBin: join(this.cacheDir, `documents${tag}.bin`)
    }
  }

  /**
   * One scope's cached matcher for `fingerprint`, or null – a miss, and the build compiles the
   * lists' text instead. Every path to null: a file of the four missing; metadata that is not
   * JSON or not an object; metadata of another {@link GHOSTERY_CACHE_FORMAT} (a cache an older
   * build wrote: one recompile); another fingerprint or app version (the lists moved); metadata
   * without a well-formed digest for a file that is read; `engine.bin` or `documents.bin` of
   * another length or SHA-1 than the metadata names (a file left short or stale under a
   * completed rename, never adopted); the engine's bytes not deserialising. The files are
   * checked against their digests before any of them is deserialised or parsed. The document
   * filters are deserialised from `documents.bin`; `documents.txt` – the lines, which parse as
   * a smaller set when cut short – is read, checked against its digest and parsed only when
   * the bytes do not deserialise (a blob of another `DOCUMENT_FILTERS_FORMAT`), so the start
   * pays for the file it adopts and not for the fallback. A miss that means damage – anything
   * past the fingerprint and version – is logged once per cache path, like a failed write.
   */
  private readCache(partition: string | null, fingerprint: string): Compiled | null {
    const { bin, meta, documents, documentsBin } = this.cachePaths(partition)
    if (
      !existsSync(bin) ||
      !existsSync(meta) ||
      !existsSync(documents) ||
      !existsSync(documentsBin)
    )
      return null
    let info: Partial<GhosteryCacheMeta> | null
    try {
      info = JSON.parse(readFileSync(meta, 'utf8')) as Partial<GhosteryCacheMeta> | null
    } catch (error) {
      return damagedCache(bin, 'metadata unreadable', error)
    }
    if (!info || typeof info !== 'object') return damagedCache(bin, 'metadata malformed')
    if (info.format !== GHOSTERY_CACHE_FORMAT) return null
    if (info.fingerprint !== fingerprint || info.version !== this.cacheVersion) return null
    let engineBytes: Uint8Array
    let documentBytes: Buffer
    try {
      engineBytes = new Uint8Array(readFileSync(bin))
      documentBytes = readFileSync(documentsBin)
    } catch (error) {
      return damagedCache(bin, 'files unreadable', error)
    }
    if (!matchesCacheDigest(engineBytes, info.engine))
      return damagedCache(bin, 'engine bytes do not match the metadata')
    if (!matchesCacheDigest(documentBytes, info.documentsBin))
      return damagedCache(bin, 'document filters do not match the metadata')
    let engine: FiltersEngine
    try {
      engine = FiltersEngine.deserialize(engineBytes)
    } catch (error) {
      return damagedCache(bin, 'engine not deserialised', error)
    }
    let filters: DocumentFilters
    try {
      filters = DocumentFilters.deserialize(documentBytes)
    } catch (error) {
      damagedCache(bin, 'document filters not deserialised', error)
      let text: Buffer
      try {
        text = readFileSync(documents)
      } catch (readError) {
        return damagedCache(bin, 'files unreadable', readError)
      }
      if (!matchesCacheDigest(text, info.documents))
        return damagedCache(bin, 'document filter lines do not match the metadata')
      filters = DocumentFilters.parse([text.toString('utf8')])
    }
    return { engine, documents: filters, fingerprint }
  }

  /** A dropped scope's cache files go with it (a missing file is nothing to remove). */
  private removeCache(partition: string): void {
    for (const path of Object.values(this.cachePaths(partition))) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        console.warn('[zenium] filter engine cache not removed', path, error)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled snapshot
// ---------------------------------------------------------------------------

export interface BundleManifest {
  builtAt: number
  lists: Array<{ id: string; file: string; version: string | null; filterCount: number }>
}

/**
 * The default lists' snapshot shipped in `resources/blocking/` (gzipped network filters) – and
 * the desktop's word that the core's engine decides its requests (`BlockingHandler` above asks
 * it for every one), so the service builds the engine's tables as soon as the sets are loaded.
 */
export class ElectronBundledLists implements BlockingHost {
  readonly requestEngine = 'core' as const

  constructor(
    private readonly bundleDir: string,
    private readonly profileDir: string
  ) {}

  async bundledLists(): Promise<BundledFilterList[]> {
    const manifest = this.manifest()
    if (!manifest) return []
    return manifest.lists.map((l) => ({
      id: l.id,
      version: l.version,
      builtAt: manifest.builtAt,
      filterCount: l.filterCount
    }))
  }

  async installBundled(set: RuleSet, file: string): Promise<BundledFilterList | null> {
    const manifest = this.manifest()
    const entry = manifest?.lists.find((l) => l.id === set.id)
    if (!manifest || !entry) return null
    const text = gunzipSync(await fs.readFile(join(this.bundleDir, entry.file))).toString('utf8')
    const document: RuleSet = { ...set, filterText: text }
    const target = join(this.profileDir, file)
    await fs.mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(document), 'utf8')
    await fs.rename(tmp, target)
    return {
      id: entry.id,
      version: entry.version,
      builtAt: manifest.builtAt,
      filterCount: entry.filterCount
    }
  }

  private manifest(): BundleManifest | null {
    try {
      const raw = readFileSync(join(this.bundleDir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<BundleManifest>
      if (typeof parsed.builtAt !== 'number' || !Array.isArray(parsed.lists)) return null
      return { builtAt: parsed.builtAt, lists: parsed.lists }
    } catch {
      return null
    }
  }
}

/**
 * `resources/blocking` of this build. Packaged, `resources/**` is unpacked next to the asar
 * (electron-builder.yml `asarUnpack`) and Electron's fs resolves the asar path to it.
 */
export function bundledListsDirectory(): string {
  return join(app.getAppPath(), 'resources', 'blocking')
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * A decision that named a rule, with the request (in `chrome.webRequest` shape) it was about and
 * the {@link DecisionStage} it was taken at. Listeners that do not tell the stages apart may
 * ignore the third argument; those that do see one request twice when a header-conditioned rule
 * overturned or extended the request stage's decision.
 */
export type DecisionListener = (
  request: WebRequestBase,
  decision: Decision,
  stage: DecisionStage
) => void

/** Everything desktop blocking needs, created once per app and attached to every session. */
export class ElectronBlocking {
  readonly multiplexer: WebRequestMultiplexer
  readonly matcher: GhosteryTextMatcher
  private stopMatcher: (() => void) | null = null
  private readonly decisionListeners = new Set<DecisionListener>()

  constructor(
    private readonly browser: Browser,
    views: TabResolver,
    profileDir: string
  ) {
    this.multiplexer = new WebRequestMultiplexer(views)
    this.matcher = new GhosteryTextMatcher(
      browser.blocking,
      join(profileDir, BLOCKING_DIR),
      undefined,
      undefined,
      // The compile in the core's background worker (inline on its fallback, as before).
      (scopes) => browser.background.run(GHOSTERY_COMPILE_TASK, { scopes })
    )
  }

  /** Register the blocking handler and start following the core engine. */
  start(): void {
    const { blocking } = this.browser
    this.multiplexer.register(
      new BlockingHandler(
        {
          decide: (ctx) => blocking.engine.decide(ctx),
          recordBlocked: (tabId, count, source) =>
            blocking.recordBlocked(tabId, count, source && [source])
        },
        this.matcher,
        (request, decision, stage) => {
          for (const listener of this.decisionListeners) listener(request.base, decision, stage)
        }
      )
    )
    blocking.engine.setTextMatcher(this.matcher)
    this.stopMatcher = this.matcher.start()
  }

  /**
   * Follow the decisions the engine took by a named rule (the default allow is not reported),
   * each with the stage it was taken at; the extensions' declarativeNetRequest layer keeps its
   * matched-rule log from them. Returns the function that stops following.
   */
  onDecision(listener: DecisionListener): () => void {
    this.decisionListeners.add(listener)
    return () => this.decisionListeners.delete(listener)
  }

  /** Every session – default, containers and the private one – gets the listeners. */
  attach(ses: Session, containerId: string): void {
    this.multiplexer.attach(ses, containerId)
  }

  /**
   * The listener host for the `chrome.webRequest` emulation: register a listener for one event
   * (blocking or not) and get back the function that removes it. The rule engine decides first;
   * listeners then run in a stable per-registrant order and their results compose as Chromium
   * composes extension results. See `webRequest.ts` for the details and result shapes.
   */
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void {
    return this.multiplexer.addListener(event, listener, options)
  }

  /** Remove every listener a registrant (an extension) added. */
  removeListenersOf(registrant: string): void {
    this.multiplexer.removeListenersOf(registrant)
  }

  /**
   * Register one of the browser's own header rewrites (the store's client hints, …). It runs
   * inside the session's one `onBeforeSendHeaders` hook, right after the rule engine; returns
   * the function that removes it.
   */
  registerHeaderRewrite(handler: RequestHeaderHandler, options?: HeaderRewriteOptions): () => void {
    return this.multiplexer.registerHeaderRewrite(handler, options)
  }

  stop(): void {
    this.stopMatcher?.()
    this.stopMatcher = null
  }
}
