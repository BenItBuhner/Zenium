import type { Browser } from '../browser'
import { BUILTIN_RULE_SETS, RULE_SET_PRIORITY, type Rule, type RuleSet } from '../blocking/rules'
import { hostnameOf, registrableDomain } from '../blocking/domain'
import { SafeBrowsingService, sameDocument } from '../safebrowsing/service'
import type { InterstitialAction } from '../../shared/interstitial'
import {
  HTTPS_ONLY_PERMISSION,
  hostInSites,
  isThirdPartyCookiePrivateMode,
  privateThirdPartyCookieStatus,
  secureDnsServers,
  type HttpsOnlyMode,
  type PrivacyFlags,
  type PrivacySettings,
  type PrivacyStatus,
  type ProtectionCheck,
  type SecureDnsMode,
  type ThirdPartyCookiePrivateMode
} from '../../shared/privacy'
import type { ZenWindow } from '../window'
import { RESOLVER_UNREACHABLE, resolverCheckOf, resolverProbeUrl } from './checks'
import { LookalikeChecker, type LookalikeContext } from './lookalikes'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import {
  interstitialKindOf,
  lookalikePageTarget,
  lookalikePageUrl,
  safeBrowsingPageUrl
} from '../../shared/url'
import { LOOKALIKE_PERMISSION, type LookalikeVerdict } from '../../shared/privacy'
import { BLOCKED_BY_CLIENT_CODE } from '../../shared/zenPages'

/**
 * A site is engaged – the user knows it by name – once its pages hold this many typed visits, or
 * this many visits of any kind (Chrome's site engagement, in history's own terms): the lookalike
 * check never warns about such a site and treats it as a target of its own.
 */
export const ENGAGED_TYPED_VISITS = 3
export const ENGAGED_VISITS = 10
/** A held navigation waits this long for its failed load before the verdict is dropped. */
const PENDING_LOOKALIKE_TTL_MS = 60_000

/**
 * The privacy and security policy: HTTPS-only mode, third-party cookie controls, the Global
 * Privacy Control and Do Not Track signals, secure DNS, and Safe Browsing (`../safebrowsing`,
 * owned here). The service reads the settings and the per-site answers, keeps HTTPS-only mode's
 * `upgradeScheme` rule set in the blocking engine, and hands the host one {@link PrivacyFlags}
 * document whenever the effective policy changes (`PrivacyHost.apply`); the hosts' request
 * engines consult it per request and per page. The warning pages' buttons land here too
 * (`handleInterstitial`).
 *
 * Nothing here is persisted by the service itself: the settings live in `Settings.privacy`, the
 * "always allow over plaintext" answers in `permissions.json` under the `https-only` permission
 * (so the site-information sheet lists and resets them), Safe Browsing's tables under
 * `safebrowsing/`. The session-only answers die with the browser.
 *
 * The other privacy tools of Settings, Clear browsing data and Safety check, are
 * `PrivacyService` (`src/core/privacy.ts`).
 */
/** A resolver that takes longer than this to answer one question is not one the browser should wait on. */
const RESOLVER_CHECK_TIMEOUT_MS = 6_000

export class ProtectionService {
  readonly safeBrowsing: SafeBrowsingService
  /** The lookalike-domain check (PS-18); its tables are read once, after start, off the boot path. */
  readonly lookalikes = new LookalikeChecker()
  /** Lookalike verdicts the hosts' engines applied, keyed by tab, until the failed load asks for them. */
  private readonly pendingLookalikes = new Map<
    string,
    { url: string; verdict: LookalikeVerdict; at: number }
  >()
  /** The engaged sites of history, computed on first use after a change and kept until the next. */
  private engagedSites: ReadonlySet<string> | null = null
  /** Hosts allowed over plaintext until the browser closes (the warning page's "Continue"). */
  private readonly sessionPlaintext = new Set<string>()
  /** What the host was last given, so a policy that did not change is not pushed again. */
  private applied: string | null = null
  private httpsOnlySignature: string | null = null
  private subscriptions: Array<() => void> = []
  private started = false

  constructor(private readonly browser: Browser) {
    this.safeBrowsing = new SafeBrowsingService(browser)
  }

  private get settings(): PrivacySettings {
    return this.browser.state.settings.privacy
  }

  /** After `blocking.start()`: the rule set must land in an attached store for Android to see it. */
  start(): void {
    this.started = true
    this.safeBrowsing.start()
    this.subscriptions.push(
      // Tables, bypasses or schedule: the status card, and the bypasses ride in the flags.
      this.safeBrowsing.onChange(() => {
        this.refresh()
        this.browser.state.commitVolatile()
      }),
      this.browser.downloads.addVerdictProvider(this.safeBrowsing.verdictProvider()),
      this.browser.permissions.subscribe((change) => {
        if (change.permission !== HTTPS_ONLY_PERMISSION) return
        this.refresh()
        this.browser.state.commitVolatile()
      }),
      // The engaged set follows history: visits arrive synchronously through `onVisits` (the
      // throttled `onChange('visit')` would leave a just-typed site unknown for half a second),
      // deletions and clears through `onChange`.
      this.browser.history.onVisits(() => {
        this.engagedSites = null
      }),
      this.browser.history.onChange(() => {
        this.engagedSites = null
      })
    )
    this.refresh()
    void this.loadLookalikeTables()
  }

  /**
   * The lookalike check's bundled tables, read once through the host (`bundledLookalikeTable`)
   * after start – a few kilobytes off the boot path; the check answers nothing until they are in.
   */
  private async loadLookalikeTables(): Promise<void> {
    const host = this.browser.platform.privacy
    if (!host?.bundledLookalikeTable) return
    try {
      const [topDomains, confusables] = await Promise.all([
        host.bundledLookalikeTable('tranco-top'),
        host.bundledLookalikeTable('confusables')
      ])
      if (topDomains === null || confusables === null) return
      this.lookalikes.load({ topDomains, confusables })
    } catch (error) {
      console.warn('[zenium] lookalike tables not loaded:', (error as Error).message)
    }
  }

  stop(): void {
    this.safeBrowsing.stop()
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions = []
  }

  onSettingsChanged(): void {
    this.safeBrowsing.onSettingsChanged()
    if (this.started) this.refresh()
  }

  /** The per-site cookie policy (`SiteDataService`) changed: the hosts' flags carry it. */
  onSiteDataChanged(): void {
    if (this.started) this.refresh()
  }

  /** The effective policy changed (or may have): the rule set first, then the hosts' flags. */
  private refresh(): void {
    this.syncHttpsOnlyRules()
    this.apply()
  }

  status(): PrivacyStatus {
    const dns = this.secureDns()
    return {
      safeBrowsing: this.safeBrowsing.status(),
      httpsOnlyExceptions: this.storedPlaintextSites(),
      httpsOnlySessionExceptions: [...this.sessionPlaintext].sort(),
      secureDns: {
        supported: this.browser.state.capabilities.secureDns,
        mode: dns.mode,
        servers: dns.servers
      },
      privateThirdPartyCookies: privateThirdPartyCookieStatus(this.settings)
    }
  }

  // ---------------------------------------------------------------------------
  // Third-party cookies in private windows and private tabs
  // ---------------------------------------------------------------------------

  /**
   * The private contexts' switch (`privacy.setThirdPartyCookiesPrivate`): `block` when it is
   * turned on, `allow` when off, `default` to follow the global mode again. Regular browsing is
   * untouched; the global `block` keeps winning (the switch is locked then, see `status`). Goes
   * through the settings like the Settings page does, so the sanitiser, the flags push to the
   * hosts and the commit all happen there.
   */
  setThirdPartyCookiesPrivate(mode: ThirdPartyCookiePrivateMode, win: ZenWindow): void {
    if (!isThirdPartyCookiePrivateMode(mode))
      throw new Error(`Unknown private third-party cookie mode: ${String(mode)}`)
    if (mode === this.settings.thirdPartyCookiesPrivate) return
    this.browser.updateSettings(
      { privacy: { ...this.settings, thirdPartyCookiesPrivate: mode } },
      win
    )
  }

  // ---------------------------------------------------------------------------
  // The policy the hosts apply
  // ---------------------------------------------------------------------------

  flags(): PrivacyFlags {
    const s = this.settings
    const dns = this.secureDns()
    return {
      safeBrowsing: s.safeBrowsingEnabled,
      safeBrowsingBypassed: this.safeBrowsing.bypasses(),
      httpsOnly: s.httpsOnly,
      httpsOnlyAllowed: this.plaintextSites(),
      thirdPartyCookies: s.thirdPartyCookies,
      thirdPartyCookiesPrivate: s.thirdPartyCookiesPrivate,
      thirdPartyCookieExceptions: [...s.thirdPartyCookieExceptions],
      gpc: s.gpc,
      dnt: s.dnt,
      secureDnsMode: dns.mode,
      secureDnsServers: dns.servers,
      siteData: this.browser.siteData.policy()
    }
  }

  /** A provider mode without a usable template falls back to automatic rather than to nothing. */
  private secureDns(): { mode: SecureDnsMode; servers: string[] } {
    const s = this.settings
    const servers = secureDnsServers(s)
    if (s.secureDnsMode === 'provider' && servers.length === 0)
      return { mode: 'automatic', servers: [] }
    return { mode: s.secureDnsMode, servers }
  }

  private apply(): void {
    const flags = this.flags()
    const signature = JSON.stringify(flags)
    if (signature === this.applied) return
    this.applied = signature
    this.browser.platform.privacy?.apply(flags)
  }

  // ---------------------------------------------------------------------------
  // HTTPS-only mode
  // ---------------------------------------------------------------------------

  get httpsOnly(): HttpsOnlyMode {
    return this.settings.httpsOnly
  }

  /** Sites the user allowed over plaintext for good (`https-only` allows), as hosts, sorted. */
  storedPlaintextSites(): string[] {
    const out = new Set<string>()
    for (const { origin, decision } of this.browser.permissions.listForPermission(
      HTTPS_ONLY_PERMISSION
    )) {
      if (decision !== 'allow') continue
      const host = hostnameOf(origin)
      if (host) out.add(host)
    }
    return [...out].sort()
  }

  /**
   * Every site that may load over plaintext right now (the session's answers and the stored
   * ones), as hosts, sorted. A site covers its subdomains, as the cookie exceptions do.
   */
  plaintextSites(): string[] {
    return [...new Set([...this.sessionPlaintext, ...this.storedPlaintextSites()])].sort()
  }

  /**
   * Whether HTTPS-only mode lets `url` load without the upgrade: its host is non-unique (the
   * rule never upgrades those, and should a stale rule set have, the fallback is silent) or an
   * allowed site.
   */
  allowsPlaintext(url: string): boolean {
    const host = hostnameOf(url)
    return host !== null && (isNonUniqueHost(host) || hostInSites(host, this.plaintextSites()))
  }

  /**
   * The warning page's answer: `url`'s site may load over plaintext, until the browser closes
   * or (`remember`) for good. The rule set and the hosts' flags are updated before this returns,
   * so the very next request of that site is left alone.
   */
  allowPlaintext(url: string, remember: boolean): void {
    const host = hostnameOf(url)
    if (!host) return
    if (remember) {
      this.sessionPlaintext.delete(host)
      // The permission listener refreshes and commits.
      this.browser.permissions.set(HTTPS_ONLY_PERMISSION, `http://${host}`, 'allow')
    } else {
      this.sessionPlaintext.add(host)
    }
    this.refresh()
    this.browser.state.commitVolatile()
  }

  /** Forget a site's plaintext allowance, session and stored alike. */
  forgetPlaintext(host: string): void {
    this.sessionPlaintext.delete(host)
    this.browser.permissions.set(HTTPS_ONLY_PERMISSION, `http://${host}`, null)
    this.refresh()
    this.browser.state.commitVolatile()
  }

  /**
   * Ask the resolver at `template` one question before Settings keeps it (the §9.30 busy form
   * behind the Custom resolver field): a GET for a name every resolver answers. Any answer is
   * a resolver; an error status or nothing reachable at the address is the refusal.
   */
  async checkResolver(template: string): Promise<ProtectionCheck> {
    const url = resolverProbeUrl(template)
    if (!url) {
      return {
        ok: false,
        problem: 'Enter a DNS-over-HTTPS address such as https://dns.example/dns-query'
      }
    }
    try {
      const response = await this.browser.platform.net.fetchText(url, {
        headers: { Accept: 'application/dns-message' },
        timeoutMs: RESOLVER_CHECK_TIMEOUT_MS
      })
      return resolverCheckOf(response.status)
    } catch {
      return RESOLVER_UNREACHABLE
    }
  }

  private syncHttpsOnlyRules(): void {
    const mode = this.httpsOnly
    const set: RuleSet & { rules: Rule[] } = {
      id: BUILTIN_RULE_SETS.httpsOnly,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.httpsOnly,
      enabled: mode !== 'off',
      rules: [httpsOnlyRule(mode === 'always' ? 'always' : 'ask', this.plaintextSites())]
    }
    const signature = JSON.stringify(set)
    const engine = this.browser.blocking.engine
    if (this.httpsOnlySignature === signature && engine.has(set.id)) return
    this.httpsOnlySignature = signature
    engine.setRuleSet(set)
  }

  // ---------------------------------------------------------------------------
  // Lookalike domains (PS-18)
  // ---------------------------------------------------------------------------

  /**
   * The lookalike verdict on a main-frame navigation to `url` (`LookalikeChecker.check` with
   * the browser's context: history's engaged sites, the `lookalike` allows), or null. Under the
   * Safe Browsing switch: a user who turned the warnings off turned this one off too, as in Chrome.
   */
  checkLookalike(url: string): LookalikeVerdict | null {
    if (!this.settings.safeBrowsingEnabled) return null
    return this.lookalikes.check(url, this.lookalikeContext())
  }

  private lookalikeContext(): LookalikeContext {
    return {
      engaged: this.engaged(),
      allowed: (host) =>
        this.browser.permissions.get(LOOKALIKE_PERMISSION, `https://${host}`) === 'allow'
    }
  }

  /**
   * The registrable domains of the sites with engagement ({@link ENGAGED_TYPED_VISITS} typed
   * visits or {@link ENGAGED_VISITS} visits across a site's pages), from history's aggregates;
   * computed once after a change of history, not per navigation.
   */
  engaged(): ReadonlySet<string> {
    if (this.engagedSites) return this.engagedSites
    const typed = new Map<string, number>()
    const visits = new Map<string, number>()
    for (const entry of this.browser.history.aggregates()) {
      const host = hostnameOf(entry.url)
      if (!host || !/^https?:\/\//i.test(entry.url)) continue
      const domain = registrableDomain(host)
      typed.set(domain, (typed.get(domain) ?? 0) + (entry.typedCount ?? 0))
      visits.set(domain, (visits.get(domain) ?? 0) + entry.visitCount)
    }
    const out = new Set<string>()
    for (const [domain, count] of visits)
      if (count >= ENGAGED_VISITS || (typed.get(domain) ?? 0) >= ENGAGED_TYPED_VISITS)
        out.add(domain)
    this.engagedSites = out
    return out
  }

  /** The user continued past the question for `url`'s host: never asked about it again (the `lookalike` permission). */
  allowLookalike(url: string): void {
    const host = hostnameOf(url)
    if (!host) return
    this.browser.permissions.set(LOOKALIKE_PERMISSION, `https://${host}`, 'allow')
    this.browser.state.commitVolatile()
  }

  isLookalikeAllowed(url: string): boolean {
    const host = hostnameOf(url)
    return host !== null && this.lookalikeContext().allowed(host)
  }

  /** A host's engine held `url` in `tabId` on the core's verdict; the tab's failed load will ask for it. */
  notePendingLookalike(tabId: string, url: string, verdict: LookalikeVerdict): void {
    this.pendingLookalikes.set(tabId, { url, verdict, at: Date.now() })
  }

  /** The verdict behind a failed load of `url` in `tabId`, if the lookalike hold was its cause; consumed. */
  takePendingLookalike(tabId: string, url: string): LookalikeVerdict | null {
    const block = this.pendingLookalikes.get(tabId)
    if (!block) return null
    this.pendingLookalikes.delete(tabId)
    if (Date.now() - block.at > PENDING_LOOKALIKE_TTL_MS) return null
    return sameDocument(block.url, url) ? block.verdict : null
  }

  /** The lookalike page for `url` in `tabId`, with the page's accent. */
  lookalikePage(tabId: string, url: string, verdict: LookalikeVerdict): string {
    return lookalikePageUrl(
      url,
      verdict.target,
      verdict.reason,
      this.browser.tabs.errorPageAccent(tabId)
    )
  }

  // ---------------------------------------------------------------------------
  // Navigations and the warning pages
  // ---------------------------------------------------------------------------

  /**
   * A document committed in `tabId`. With a Google Safe Browsing key the URL is looked up
   * remotely as well; a hit turns the page into the interstitial (the local tables, which the
   * hosts consult before the request goes out, already stopped what they know). On a host whose
   * engine cannot ask the core before the request (Android), the lookalike check runs here for
   * the navigations `Tabs.navigate` did not see – a link, a redirect – and turns the page into
   * the question the same way.
   */
  onNavigated(tabId: string, url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    if (!this.browser.state.capabilities.lookalikeHolds) {
      const verdict = this.checkLookalike(url)
      if (verdict) {
        const tab = this.browser.tabs.tab(tabId)
        const view = this.browser.tabs.view(tabId)
        if (tab && view && sameDocument(tab.url, url)) {
          tab.errorCode = BLOCKED_BY_CLIENT_CODE
          tab.loading = false
          view.loadURL(this.lookalikePage(tabId, url, verdict))
          this.browser.state.commit()
          return
        }
      }
    }
    if (!this.safeBrowsing.remoteLookups) return
    void this.safeBrowsing.checkRemote(url).then((hit) => {
      if (!hit) return
      const tab = this.browser.tabs.tab(tabId)
      const view = this.browser.tabs.view(tabId)
      if (!tab || !view || !sameDocument(tab.url, url)) return
      tab.errorCode = BLOCKED_BY_CLIENT_CODE
      tab.loading = false
      view.loadURL(safeBrowsingPageUrl(url, hit.threat, this.browser.tabs.errorPageAccent(tabId)))
      this.browser.state.commit()
    })
  }

  /**
   * A button on one of the warning pages of `tabId`. The message is trusted only when the tab is
   * showing an interstitial for exactly `url`: the page script relays it from Zenium's own
   * documents alone, and this keeps a stale or forged message from excepting anything.
   */
  handleInterstitial(tabId: string, action: InterstitialAction, url: string): void {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab || !tabs.view(tabId) || !/^https?:\/\//i.test(url)) return
    const kind = interstitialKindOf(tab.url)
    if (!kind || tabs.errorPageTarget(tabId) !== url) return
    switch (action) {
      case 'back':
        tabs.leaveErrorPage(tabId)
        return
      case 'proceed':
        if (kind === 'lookalike') {
          // "Continue to <lookalike>": the host is the user's from now on, then the address
          // loads – the allow is written before the request so the engine lets it through.
          this.allowLookalike(url)
          tabs.navigate(tabId, url, { transition: 'reload' })
          return
        }
        if (kind !== 'safebrowsing') return
        this.safeBrowsing.bypass(url)
        tabs.navigate(tabId, url, { transition: 'reload' })
        return
      case 'suggested': {
        // "Go to <target>": the site the address looks like, over https, as a typed visit.
        if (kind !== 'lookalike') return
        const target = lookalikePageTarget(tab.url)
        if (!target || !/^[a-z0-9.-]+$/i.test(target)) return
        tabs.navigate(tabId, `https://${target}/`, { transition: 'typed' })
        return
      }
      case 'continue':
      case 'continue-always':
        if (kind !== 'https-only' || !/^http:\/\//i.test(url)) return
        this.allowPlaintext(url, action === 'continue-always')
        tabs.navigate(tabId, url, { transition: 'reload' })
        return
    }
  }
}

/**
 * HTTPS-only mode's rule: `http://` requests are upgraded, except on the sites the user allowed
 * over plaintext (`allowed`, subdomains included) and to non-unique hosts (`isNonUniqueHost`:
 * loopback, private and other non-routable IP literals, single-label and other names without a
 * registrable suffix), which no public certificate can name, so Chrome's HTTPS-First mode leaves
 * them alone too. The exemption is the condition's `excludedNonUniqueHosts` flag: a domain list
 * cannot name an IP range and a `regexFilter` (RE2, no lookaround) cannot say "every host but
 * these", so both engines evaluate the predicate instead. `ask` upgrades documents only;
 * `always` everything a page loads.
 */
export function httpsOnlyRule(mode: 'ask' | 'always', allowed: readonly string[] = []): Rule {
  const rule: Rule = {
    id: 1,
    action: { type: 'upgradeScheme' },
    condition: {
      urlFilter: '|http://',
      excludedRequestDomains: [...allowed],
      excludedNonUniqueHosts: true
    }
  }
  if (mode === 'ask') rule.condition.resourceTypes = ['main_frame']
  return rule
}
