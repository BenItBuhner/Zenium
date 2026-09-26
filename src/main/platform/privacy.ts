/**
 * The desktop host of the privacy and security policy (`src/core/protection`, `src/core/safebrowsing`).
 * The core pushes one {@link PrivacyFlags} document here whenever the effective policy changes;
 * this module keeps it and turns it into Electron behaviour:
 *
 * - Safe Browsing: {@link SafeBrowsingHandler}, the first participant of the session's
 *   `webRequest` multiplexer, refuses main-frame and sub-frame navigations the core's tables
 *   list (the core's service does the lookup; the tab is told so `did-fail-load` becomes the
 *   warning page rather than Chromium's error).
 * - HTTPS-only mode: the engine's `upgradeScheme` rule does the upgrading; this module only
 *   watches the decisions for main-frame upgrades and tells the tab, which offers the plaintext
 *   page when https fails.
 * - The cookie policy and the GPC / DNT signals: {@link PrivacyRequestHandler} edits the
 *   headers after the rule engine (Electron exposes no cookie content setting, so the `Cookie`
 *   and `Set-Cookie` headers are dropped where the policy withholds cookies: a never-site's
 *   requests, everything under "block all" but the listed sites, third-party requests under
 *   the third-party rule; `document.cookie` is out of reach this way, which is why the cookie
 *   jar drops a never-site's cookies as they land: `CookiePolicyEnforcer` in `siteData.ts`).
 *   `navigator.globalPrivacyControl` and `navigator.doNotTrack` come from the page preload,
 *   which asks for the signals over sync IPC at document start. Do Not Track has a second
 *   source beside the user's setting: an extension's `chrome.privacy.websites.doNotTrackEnabled`
 *   ({@link DoNotTrackSource}, the extension layer's effective value), whose `DNT: 1` header the
 *   extension layer's own request hook adds; the page's `navigator.doNotTrack` says the same.
 * - Preload pages (PS-43): {@link PreloadHandler} refuses the speculative loads under
 *   "No preloading" – the whole of the level's enforcement; no startup switch.
 * - Secure DNS: `app.configureHostResolver`, whenever the mode or the templates change.
 * - The bundled Safe Browsing snapshot (`resources/safebrowsing/<feed>.json`).
 */
import { app, ipcMain, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { BUILTIN_RULE_SETS, type Decision } from '../../core/blocking/rules'
import type { LookalikeTableName, PrivacyHost } from '../../core/platform'
import { cookiesWithheld, isPreloadRequest, signalHeaders } from '../../core/protection/policy'
import type { LookalikeVerdict, PrivacyFlags, SafeBrowsingHit } from '../../shared/privacy'
import type { SiteDataPolicy } from '../../shared/siteData'
import { PRIVACY_SIGNALS_CHANNEL, type PrivacySignals } from '../../shared/privacySignals'
import type { ElectronBlocking } from './blocking'
import {
  HANDLER_ORDER,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type BeforeSendHeadersResult,
  type HostRequest,
  type RequestHandler,
  type WebRequestBase
} from './webRequest'

/** The tab a request belongs to, as the handlers need it. */
export interface RequestTab {
  noteUpgraded(from: string, to: string): void
  noteUnsafeNavigation(url: string, hit: SafeBrowsingHit): void
  noteLookalikeNavigation(url: string, verdict: LookalikeVerdict): void
}

export interface TabLookup {
  viewForTab(tabId: string): RequestTab | undefined
}

/** The core's Safe Browsing lookup, as the handler needs it. */
export interface SafeBrowsingLookup {
  lookup(url: string): SafeBrowsingHit | null
}

/**
 * The extension layer's Do Not Track value (`chrome.privacy.websites.doNotTrackEnabled`, the
 * effective value across the extensions holding `privacy`), for the documents of normal windows
 * and, separately, of private windows (an extension's value reaches those only when the user
 * allowed it there). The same source the extension layer's request hook sends `DNT: 1` for.
 */
export interface DoNotTrackSource {
  doNotTrack(privateWindow: boolean): boolean
}

/** The core's lookalike check (`ProtectionService.checkLookalike`), as the handler needs it. */
export interface LookalikeLookup {
  check(url: string): LookalikeVerdict | null
}

/** `app.configureHostResolver`, injectable for the tests. */
export type HostResolverConfigurator = (options: Electron.ConfigureHostResolverOptions) => void

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Refuses navigations Safe Browsing lists, ahead of every rule. Documents and frames only: the
 * feeds list attack and phishing pages, and a payload host's script is stopped by the lists.
 */
export class SafeBrowsingHandler implements RequestHandler {
  readonly id = 'safe-browsing'
  readonly order = HANDLER_ORDER.safeBrowsing

  constructor(
    private readonly safeBrowsing: SafeBrowsingLookup,
    private readonly tabs: TabLookup
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (ctx.type !== 'main_frame' && ctx.type !== 'sub_frame') return undefined
    const hit = this.safeBrowsing.lookup(ctx.url)
    if (!hit) return undefined
    if (ctx.type === 'main_frame' && request.tabId)
      this.tabs.viewForTab(request.tabId)?.noteUnsafeNavigation(ctx.url, hit)
    return { cancel: true }
  }
}

/**
 * Holds a tab's main-frame navigation whose address looks like a well-known site's (PS-18), right
 * after Safe Browsing and ahead of every rule: the core's check says so, the tab is told the
 * verdict, and the cancelled request's `did-fail-load` becomes the question page. Documents of
 * tabs only – a frame's address is not the one in the address bar, and a request that is no
 * tab's has no page to ask on.
 */
export class LookalikeHandler implements RequestHandler {
  readonly id = 'lookalike'
  readonly order = HANDLER_ORDER.lookalike

  constructor(
    private readonly lookalikes: LookalikeLookup,
    private readonly tabs: TabLookup
  ) {}

  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (ctx.type !== 'main_frame' || !request.tabId) return undefined
    const tab = this.tabs.viewForTab(request.tabId)
    if (!tab) return undefined
    const verdict = this.lookalikes.check(ctx.url)
    if (!verdict) return undefined
    tab.noteLookalikeNavigation(ctx.url, verdict)
    return { cancel: true }
  }
}

/**
 * "No preloading" (PS-43): refuses every request Chromium marks as speculative –
 * `<link rel=prefetch>`, a speculation-rules prefetch, the prefetch a prerender starts with
 * (`isPreloadRequest`: the `Sec-Purpose` header, which is why this is a header stage; the
 * request phase has no headers, and the resource type alone – `other` for the link prefetch,
 * `mainFrame` for the speculation-rules ones – does not tell them apart from a beacon or a
 * navigation). DNS prefetch and preconnect never reach the request engine (no HTTP request), and
 * Electron has no prediction service to switch off. The refusal is the level's whole
 * enforcement and it is live: a prerender cannot activate without the fetch it starts with, so
 * nothing is switched off at startup and a change of level needs no relaunch (Blink's
 * `Prerender2` feature is left as Electron ships it). Under the other levels nothing is refused.
 * One header scan per request, at the level the core last pushed.
 */
export class PreloadHandler implements RequestHandler {
  readonly id = 'preload'
  readonly order = HANDLER_ORDER.preload

  constructor(private readonly flags: () => PrivacyFlags | null) {}

  onBeforeSendHeaders(
    request: HostRequest,
    headers: Record<string, string>
  ): BeforeSendHeadersResult | undefined {
    const flags = this.flags()
    if (!flags || flags.preloadPages !== 'none') return undefined
    if (!/^https?:/i.test(request.ctx.url)) return undefined
    return isPreloadRequest(headers) ? { cancel: true } : undefined
  }
}

/**
 * The header stage of the cookie policy: withholds `Cookie` and `Set-Cookie` where the policy
 * says so – a never-site's requests, every request under "block all cookies" but the listed
 * sites', third-party requests under the third-party rule (`cookiesWithheld`) – and adds the
 * GPC / DNT request headers.
 */
export class PrivacyRequestHandler implements RequestHandler {
  readonly id = 'privacy'
  readonly order = HANDLER_ORDER.privacy

  constructor(private readonly flags: () => PrivacyFlags | null) {}

  onBeforeSendHeaders(request: HostRequest, headers: Record<string, string>): undefined {
    const flags = this.flags()
    if (!flags || !/^(https?|wss?):/i.test(request.ctx.url)) return undefined
    if (cookiesWithheld(flags, request.ctx))
      applyRequestHeaderOps(headers, [{ header: 'Cookie', operation: 'remove' }])
    for (const [header, value] of Object.entries(signalHeaders(flags)))
      applyRequestHeaderOps(headers, [{ header, operation: 'set', value }])
    return undefined
  }

  onHeadersReceived(request: HostRequest, headers: Record<string, string[]>): undefined {
    const flags = this.flags()
    if (!flags || !/^https?:/i.test(request.ctx.url)) return undefined
    if (cookiesWithheld(flags, request.ctx))
      applyResponseHeaderOps(headers, [{ header: 'Set-Cookie', operation: 'remove' }])
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * `resources/safebrowsing` of this build (the compiled snapshot of the bundled feeds). Packaged,
 * `resources/**` is unpacked next to the asar (electron-builder.yml `asarUnpack`).
 */
export function bundledSafeBrowsingDirectory(): string {
  return join(app.getAppPath(), 'resources', 'safebrowsing')
}

/** `resources/lookalikes` of this build (the lookalike check's two tables, gzipped). */
export function bundledLookalikesDirectory(): string {
  return join(app.getAppPath(), 'resources', 'lookalikes')
}

/** The cookie jar's enforcement of the per-site policy (`CookiePolicyEnforcer` in `siteData.ts`). */
export interface CookieJarPolicy {
  apply(policy: SiteDataPolicy): void
}

export class ElectronPrivacy implements PrivacyHost {
  private flags: PrivacyFlags | null = null
  private dnsApplied: string | null = null
  private extensionSignals: DoNotTrackSource | null = null
  private isPrivateSender: (sender: WebContents) => boolean = () => false

  constructor(
    private readonly tabs: TabLookup,
    private readonly safeBrowsing: SafeBrowsingLookup,
    private readonly bundleDir: string = bundledSafeBrowsingDirectory(),
    private readonly configureResolver: HostResolverConfigurator = (options) =>
      app.configureHostResolver(options),
    private readonly cookieJar: CookieJarPolicy | null = null,
    private readonly lookalikes: LookalikeLookup | null = null,
    private readonly lookalikesDir: string = bundledLookalikesDirectory()
  ) {}

  /** The policy the core last pushed, null before the first `apply`. */
  get current(): PrivacyFlags | null {
    return this.flags
  }

  apply(flags: PrivacyFlags): void {
    this.flags = flags
    this.configureDns(flags)
    this.cookieJar?.apply(flags.siteData)
  }

  async bundledSafeBrowsingFeed(id: string): Promise<string | null> {
    if (!/^[a-z0-9-]+$/.test(id)) return null
    try {
      return await fs.readFile(join(this.bundleDir, `${id}.json`), 'utf8')
    } catch {
      return null
    }
  }

  /** One of the lookalike tables, gunzipped to text; null when the build has no copy. */
  async bundledLookalikeTable(name: LookalikeTableName): Promise<string | null> {
    if (!/^[a-z-]+$/.test(name)) return null
    try {
      return gunzipSync(await fs.readFile(join(this.lookalikesDir, `${name}.txt.gz`))).toString(
        'utf8'
      )
    } catch {
      return null
    }
  }

  /**
   * The signals the page preload exposes on `navigator` (both off before the first `apply`).
   * Do Not Track is on when the user's setting is, or when the extensions' effective value for
   * this kind of window is — the same two sources the wire's `DNT: 1` header has, so the page
   * and its requests never disagree.
   */
  signals(privateWindow = false): PrivacySignals {
    return {
      gpc: this.flags?.gpc === true,
      dnt: this.flags?.dnt === true || this.extensionSignals?.doNotTrack(privateWindow) === true
    }
  }

  /**
   * The extension layer's Do Not Track value joins the user's setting in {@link signals}, and the
   * preload's IPC asks for the signals of the sender's kind of window (private or not). Wired by
   * the platform once the extension API host exists; before that the answers are the user's alone.
   */
  attachExtensionSignals(
    source: DoNotTrackSource,
    isPrivateSender: (sender: WebContents) => boolean
  ): void {
    this.extensionSignals = source
    this.isPrivateSender = isPrivateSender
  }

  /** The handlers of both request phases, in multiplexer order. */
  handlers(): RequestHandler[] {
    return [
      new SafeBrowsingHandler(this.safeBrowsing, this.tabs),
      ...(this.lookalikes ? [new LookalikeHandler(this.lookalikes, this.tabs)] : []),
      new PreloadHandler(() => this.flags),
      new PrivacyRequestHandler(() => this.flags)
    ]
  }

  /**
   * Register with the request pipeline: the handlers, the decision observer that reports
   * main-frame upgrades to their tabs, and the preload's IPC. Once, before any page loads.
   */
  attach(blocking: ElectronBlocking): void {
    for (const handler of this.handlers()) blocking.multiplexer.register(handler)
    blocking.onDecision((request, decision) => this.observeDecision(request, decision))
    ipcMain.on(PRIVACY_SIGNALS_CHANNEL, (event) => {
      event.returnValue = this.signals(this.privateSender(event.sender))
    })
  }

  /**
   * A main-frame navigation HTTPS-only mode's rule upgraded: the tab remembers the plaintext URL
   * so it can offer it (or ask about it) when https fails. Other rule sets' upgrades are their
   * own business.
   */
  observeDecision(request: WebRequestBase, decision: Decision): void {
    if (decision.action !== 'upgrade' || !decision.redirectUrl) return
    if (decision.matched?.setId !== BUILTIN_RULE_SETS.httpsOnly) return
    if (request.resourceType !== 'main_frame' || !request.tabId) return
    this.tabs.viewForTab(request.tabId)?.noteUpgraded(request.url, decision.redirectUrl)
  }

  /** A sender the lookup cannot place (a page window's, a destroyed one) reads as a normal window's. */
  private privateSender(sender: WebContents): boolean {
    try {
      return this.isPrivateSender(sender) === true
    } catch {
      return false
    }
  }

  private configureDns(flags: PrivacyFlags): void {
    const options: Electron.ConfigureHostResolverOptions = {
      secureDnsMode: flags.secureDnsMode === 'provider' ? 'secure' : flags.secureDnsMode,
      secureDnsServers: [...flags.secureDnsServers]
    }
    const signature = JSON.stringify(options)
    if (signature === this.dnsApplied) return
    this.dnsApplied = signature
    try {
      this.configureResolver(options)
    } catch (error) {
      console.warn('[zenium] secure DNS not configured:', (error as Error).message)
    }
  }
}
