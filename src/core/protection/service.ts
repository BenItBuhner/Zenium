import type { Browser } from '../browser'
import { BUILTIN_RULE_SETS, RULE_SET_PRIORITY, type Rule, type RuleSet } from '../blocking/rules'
import { hostnameOf } from '../blocking/domain'
import { SafeBrowsingService, sameDocument } from '../safebrowsing/service'
import type { InterstitialAction } from '../../shared/interstitial'
import {
  HTTPS_ONLY_PERMISSION,
  hostInSites,
  secureDnsServers,
  type HttpsOnlyMode,
  type PrivacyFlags,
  type PrivacySettings,
  type PrivacyStatus,
  type ProtectionCheck,
  type SecureDnsMode
} from '../../shared/privacy'
import { RESOLVER_UNREACHABLE, resolverCheckOf, resolverProbeUrl } from './checks'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import { interstitialKindOf, safeBrowsingPageUrl } from '../../shared/url'
import { BLOCKED_BY_CLIENT_CODE } from '../../shared/zenPages'

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
      })
    )
    this.refresh()
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
      }
    }
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
      thirdPartyCookieExceptions: [...s.thirdPartyCookieExceptions],
      gpc: s.gpc,
      dnt: s.dnt,
      secureDnsMode: dns.mode,
      secureDnsServers: dns.servers
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
  // Navigations and the warning pages
  // ---------------------------------------------------------------------------

  /**
   * A document committed in `tabId`. With a Google Safe Browsing key the URL is looked up
   * remotely as well; a hit turns the page into the interstitial (the local tables, which the
   * hosts consult before the request goes out, already stopped what they know).
   */
  onNavigated(tabId: string, url: string): void {
    if (!this.safeBrowsing.remoteLookups || !/^https?:\/\//i.test(url)) return
    void this.safeBrowsing.checkRemote(url).then((hit) => {
      if (!hit) return
      const tab = this.browser.tabs.tab(tabId)
      const view = this.browser.tabs.view(tabId)
      if (!tab || !view || !sameDocument(tab.url, url)) return
      tab.errorCode = BLOCKED_BY_CLIENT_CODE
      tab.loading = false
      view.loadURL(safeBrowsingPageUrl(url, hit.threat))
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
        if (kind !== 'safebrowsing') return
        this.safeBrowsing.bypass(url)
        tabs.navigate(tabId, url, { transition: 'reload' })
        return
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
