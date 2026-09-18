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
 * - Third-party cookies and the GPC / DNT signals: {@link PrivacyRequestHandler} edits the
 *   headers after the rule engine (Electron exposes no third-party cookie setting, so the
 *   `Cookie` and `Set-Cookie` headers of third-party requests are dropped; `document.cookie`
 *   in third-party frames is out of reach this way). `navigator.globalPrivacyControl` and
 *   `navigator.doNotTrack` come from the page preload, which asks for the signals over sync IPC
 *   at document start.
 * - Secure DNS: `app.configureHostResolver`, whenever the mode or the templates change.
 * - The bundled Safe Browsing snapshot (`resources/safebrowsing/<feed>.json`).
 */
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_RULE_SETS, type Decision } from '../../core/blocking/rules'
import type { PrivacyHost } from '../../core/platform'
import { blocksThirdPartyCookies, signalHeaders } from '../../core/protection/policy'
import type { PrivacyFlags, SafeBrowsingHit } from '../../shared/privacy'
import { PRIVACY_SIGNALS_CHANNEL, type PrivacySignals } from '../../shared/privacySignals'
import type { ElectronBlocking } from './blocking'
import {
  HANDLER_ORDER,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type HostRequest,
  type RequestHandler,
  type WebRequestBase
} from './webRequest'

/** The tab a request belongs to, as the handlers need it. */
export interface RequestTab {
  noteUpgraded(from: string, to: string): void
  noteUnsafeNavigation(url: string, hit: SafeBrowsingHit): void
}

export interface TabLookup {
  viewForTab(tabId: string): RequestTab | undefined
}

/** The core's Safe Browsing lookup, as the handler needs it. */
export interface SafeBrowsingLookup {
  lookup(url: string): SafeBrowsingHit | null
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

/** Drops third-party cookies where the policy says so and adds the GPC / DNT request headers. */
export class PrivacyRequestHandler implements RequestHandler {
  readonly id = 'privacy'
  readonly order = HANDLER_ORDER.privacy

  constructor(private readonly flags: () => PrivacyFlags | null) {}

  onBeforeSendHeaders(request: HostRequest, headers: Record<string, string>): undefined {
    const flags = this.flags()
    if (!flags || !/^(https?|wss?):/i.test(request.ctx.url)) return undefined
    if (blocksThirdPartyCookies(flags, request.ctx))
      applyRequestHeaderOps(headers, [{ header: 'Cookie', operation: 'remove' }])
    for (const [header, value] of Object.entries(signalHeaders(flags)))
      applyRequestHeaderOps(headers, [{ header, operation: 'set', value }])
    return undefined
  }

  onHeadersReceived(request: HostRequest, headers: Record<string, string[]>): undefined {
    const flags = this.flags()
    if (!flags || !/^https?:/i.test(request.ctx.url)) return undefined
    if (blocksThirdPartyCookies(flags, request.ctx))
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

export class ElectronPrivacy implements PrivacyHost {
  private flags: PrivacyFlags | null = null
  private dnsApplied: string | null = null

  constructor(
    private readonly tabs: TabLookup,
    private readonly safeBrowsing: SafeBrowsingLookup,
    private readonly bundleDir: string = bundledSafeBrowsingDirectory(),
    private readonly configureResolver: HostResolverConfigurator = (options) =>
      app.configureHostResolver(options)
  ) {}

  /** The policy the core last pushed, null before the first `apply`. */
  get current(): PrivacyFlags | null {
    return this.flags
  }

  apply(flags: PrivacyFlags): void {
    this.flags = flags
    this.configureDns(flags)
  }

  async bundledSafeBrowsingFeed(id: string): Promise<string | null> {
    if (!/^[a-z0-9-]+$/.test(id)) return null
    try {
      return await fs.readFile(join(this.bundleDir, `${id}.json`), 'utf8')
    } catch {
      return null
    }
  }

  /** The signals the page preload exposes on `navigator` (both off before the first `apply`). */
  signals(): PrivacySignals {
    return { gpc: this.flags?.gpc === true, dnt: this.flags?.dnt === true }
  }

  /** The handlers of both request phases, in multiplexer order. */
  handlers(): RequestHandler[] {
    return [
      new SafeBrowsingHandler(this.safeBrowsing, this.tabs),
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
      event.returnValue = this.signals()
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
