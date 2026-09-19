/**
 * Privacy and security features as the chrome sees them: Safe Browsing, HTTPS-only mode, secure
 * DNS, third-party cookie controls and the Global Privacy Control / Do Not Track signals. The
 * settings model, its defaults and sanitiser, the provider tables and the status card live here;
 * the services themselves are `src/core/safebrowsing` and `src/core/protection`.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * HTTPS-only mode:
 * - `off`: only an address typed without a scheme is tried over https first (the old behaviour).
 * - `ask` (default): every http navigation is upgraded; when https fails Zenium asks before
 *   loading the page over plaintext, and remembers the answer per site.
 * - `always`: as `ask`, and every subresource is upgraded too; plaintext subresources that have
 *   no https counterpart fail instead of loading.
 */
export type HttpsOnlyMode = 'off' | 'ask' | 'always'

/**
 * Secure DNS (DNS over HTTPS) on desktop:
 * - `off`: the system resolver, plaintext.
 * - `automatic`: DoH to the system resolver when it offers it, plaintext otherwise (Chromium's default).
 * - `provider`: DoH to the chosen provider (or the custom template), never plaintext.
 */
export type SecureDnsMode = 'off' | 'automatic' | 'provider'

/** Third-party cookies: allow everywhere, block in private windows only (default), block everywhere. */
export type ThirdPartyCookieMode = 'allow' | 'block-private' | 'block'

export interface PrivacySettings {
  /** Safe Browsing: the open malware and phishing feeds, on by default. */
  safeBrowsingEnabled: boolean
  /**
   * Google Safe Browsing v5 API key the user entered (`hashes:search`); empty when none. Nothing
   * ships in the binary. Google's free tier is 10,000 requests per day per project.
   */
  safeBrowsingApiKey: string
  httpsOnly: HttpsOnlyMode
  secureDnsMode: SecureDnsMode
  /** Id of a {@link SECURE_DNS_PROVIDERS} entry, or `custom` for {@link PrivacySettings.secureDnsCustomUrl}. */
  secureDnsProvider: string
  /** DoH template of the user's own resolver (`https://…/dns-query`). */
  secureDnsCustomUrl: string
  thirdPartyCookies: ThirdPartyCookieMode
  /**
   * Sites (hosts, subdomains included) on which third-party cookies stay allowed whatever the
   * mode: the related-sites exceptions.
   */
  thirdPartyCookieExceptions: string[]
  /** Send `Sec-GPC: 1` and expose `navigator.globalPrivacyControl`. */
  gpc: boolean
  /** Send `DNT: 1` and expose `navigator.doNotTrack`. */
  dnt: boolean
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  safeBrowsingEnabled: true,
  safeBrowsingApiKey: '',
  httpsOnly: 'ask',
  secureDnsMode: 'automatic',
  secureDnsProvider: 'cloudflare',
  secureDnsCustomUrl: '',
  thirdPartyCookies: 'block-private',
  thirdPartyCookieExceptions: [],
  gpc: false,
  dnt: false
}

const HTTPS_ONLY_MODES: HttpsOnlyMode[] = ['off', 'ask', 'always']
const SECURE_DNS_MODES: SecureDnsMode[] = ['off', 'automatic', 'provider']
const COOKIE_MODES: ThirdPartyCookieMode[] = ['allow', 'block-private', 'block']

export const HTTPS_ONLY_LABELS: Record<HttpsOnlyMode, { label: string; description: string }> = {
  off: {
    label: 'Off',
    description:
      'Pages load the way sites offer them. Addresses typed without https still try it first.'
  },
  ask: {
    label: 'Ask before loading pages over plaintext',
    description:
      'Pages are upgraded to https. Zenium asks before loading a site it can only reach over http.'
  },
  always: {
    label: 'Always use secure connections',
    description:
      'Pages and what they load are upgraded to https. Content offered only over http does not load.'
  }
}

export const SECURE_DNS_LABELS: Record<SecureDnsMode, { label: string; description: string }> = {
  off: {
    label: 'Off',
    description: 'Look up sites with the plaintext resolver the system provides.'
  },
  automatic: {
    label: 'Automatic',
    description:
      'Use the system resolver over an encrypted connection when it offers one, plaintext otherwise.'
  },
  provider: {
    label: 'Use a provider',
    description: 'Send every lookup, encrypted, to the resolver chosen below.'
  }
}

export const THIRD_PARTY_COOKIE_LABELS: Record<
  ThirdPartyCookieMode,
  { label: string; description: string }
> = {
  allow: {
    label: 'Allow third-party cookies',
    description: 'Sites embedded in other sites can read and set their cookies.'
  },
  'block-private': {
    label: 'Block third-party cookies in private windows',
    description: 'In a private window, embedded sites cannot use cookies. Elsewhere they can.'
  },
  block: {
    label: 'Block third-party cookies',
    description:
      'Embedded sites cannot use cookies anywhere. Some sign-in and embedded-content flows may break.'
  }
}

// ---------------------------------------------------------------------------
// Secure DNS providers
// ---------------------------------------------------------------------------

export interface SecureDnsProvider {
  id: string
  name: string
  /** DoH template as Chromium's host resolver takes it. */
  url: string
  /** Pricing and filtering in one line (all of them are free for personal use, no key). */
  notes: string
  homepage: string
}

export const SECURE_DNS_CUSTOM = 'custom'

export const SECURE_DNS_PROVIDERS: SecureDnsProvider[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare (1.1.1.1)',
    url: 'https://cloudflare-dns.com/dns-query',
    notes: 'Free, no account. Does not filter.',
    homepage: 'https://one.one.one.one/'
  },
  {
    id: 'google',
    name: 'Google Public DNS',
    url: 'https://dns.google/dns-query',
    notes: 'Free, no account. Does not filter.',
    homepage: 'https://developers.google.com/speed/public-dns'
  },
  {
    id: 'quad9',
    name: 'Quad9',
    url: 'https://dns.quad9.net/dns-query',
    notes: 'Free (non-profit), no account. Blocks known malware hosts.',
    homepage: 'https://quad9.net/'
  },
  {
    id: 'nextdns',
    name: 'NextDNS',
    url: 'https://dns.nextdns.io/dns-query',
    notes:
      'Public resolver is free, no account. A personal profile (300,000 lookups a month free) uses its own address: enter it as a custom resolver.',
    homepage: 'https://nextdns.io/'
  },
  {
    id: 'adguard',
    name: 'AdGuard DNS',
    url: 'https://dns.adguard-dns.com/dns-query',
    notes: 'Public resolver is free, no account. Blocks ad and tracker hosts.',
    homepage: 'https://adguard-dns.io/'
  },
  {
    id: 'mullvad',
    name: 'Mullvad DNS',
    url: 'https://dns.mullvad.net/dns-query',
    notes: 'Free, no account, no logging. Does not filter.',
    homepage: 'https://mullvad.net/en/help/dns-over-https-and-dns-over-tls'
  }
]

export function secureDnsProvider(id: string): SecureDnsProvider | undefined {
  return SECURE_DNS_PROVIDERS.find((p) => p.id === id)
}

/** A DoH template the resolver can use: https, a host, no credentials, at most one `{?dns}`. */
export function isValidDohTemplate(url: string): boolean {
  const text = url.trim()
  if (!/^https:\/\//i.test(text)) return false
  try {
    const parsed = new URL(text.replace('{?dns}', ''))
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/**
 * The answer of a check the Settings form waits for (design-language-v2-draft §9.30's busy
 * form): a Google Safe Browsing key tried against the API (`protection.checkApiKey`), a custom
 * resolver asked one question (`protection.checkResolver`). Refused with `problem` as the
 * field's validation text.
 */
export type ProtectionCheck = { ok: true } | { ok: false; problem: string }

/** The DoH templates the settings ask for, or none when secure DNS is off or automatic. */
export function secureDnsServers(settings: PrivacySettings): string[] {
  if (settings.secureDnsMode !== 'provider') return []
  if (settings.secureDnsProvider === SECURE_DNS_CUSTOM) {
    const custom = settings.secureDnsCustomUrl.trim()
    return isValidDohTemplate(custom) ? [custom] : []
  }
  const provider = secureDnsProvider(settings.secureDnsProvider)
  return provider ? [provider.url] : []
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i

/**
 * A site as the exception lists store it: the lowercase host of a URL, origin or bare host
 * (`www.Example.com/x` → `www.example.com`), or null when the input has no host.
 */
export function normalizePrivacySite(input: string): string | null {
  const text = input.trim().toLowerCase()
  if (!text) return null
  let host = text
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname
  } catch {
    return null
  }
  host = host.replace(/\.$/, '')
  if (!host) return null
  if (host.startsWith('[') && host.endsWith(']')) return host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || HOST_RE.test(host)) return host
  return null
}

/** `host` is `site` or one of its subdomains. */
export function siteMatchesHost(site: string, host: string): boolean {
  if (host === site) return true
  return (
    host.length > site.length && host.endsWith(site) && host[host.length - site.length - 1] === '.'
  )
}

/** Whether any site of `sites` covers `host`. */
export function hostInSites(host: string, sites: readonly string[]): boolean {
  return sites.some((site) => siteMatchesHost(site, host))
}

/**
 * The permission the HTTPS-only exceptions are stored under (`origin|https-only` in
 * `permissions.json`, `allow` = may load over plaintext), so the site-information sheet lists
 * and resets them like any other per-site decision.
 */
export const HTTPS_ONLY_PERMISSION = 'https-only'

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

const MAX_API_KEY_LENGTH = 128
const MAX_EXCEPTIONS = 500

export function sanitizePrivacySettings(
  input: Partial<PrivacySettings> | undefined
): PrivacySettings {
  const d = DEFAULT_PRIVACY_SETTINGS
  const s = input ?? {}
  const exceptions: string[] = []
  if (Array.isArray(s.thirdPartyCookieExceptions))
    for (const item of s.thirdPartyCookieExceptions) {
      if (typeof item !== 'string') continue
      const site = normalizePrivacySite(item)
      if (site && !exceptions.includes(site)) exceptions.push(site)
      if (exceptions.length >= MAX_EXCEPTIONS) break
    }
  const apiKey =
    typeof s.safeBrowsingApiKey === 'string'
      ? s.safeBrowsingApiKey.trim().slice(0, MAX_API_KEY_LENGTH)
      : ''
  return {
    safeBrowsingEnabled:
      typeof s.safeBrowsingEnabled === 'boolean' ? s.safeBrowsingEnabled : d.safeBrowsingEnabled,
    safeBrowsingApiKey: /^[A-Za-z0-9_-]*$/.test(apiKey) ? apiKey : '',
    httpsOnly: HTTPS_ONLY_MODES.includes(s.httpsOnly as HttpsOnlyMode)
      ? (s.httpsOnly as HttpsOnlyMode)
      : d.httpsOnly,
    secureDnsMode: SECURE_DNS_MODES.includes(s.secureDnsMode as SecureDnsMode)
      ? (s.secureDnsMode as SecureDnsMode)
      : d.secureDnsMode,
    secureDnsProvider:
      s.secureDnsProvider === SECURE_DNS_CUSTOM ||
      (typeof s.secureDnsProvider === 'string' && secureDnsProvider(s.secureDnsProvider))
        ? s.secureDnsProvider
        : d.secureDnsProvider,
    secureDnsCustomUrl:
      typeof s.secureDnsCustomUrl === 'string' ? s.secureDnsCustomUrl.trim().slice(0, 512) : '',
    thirdPartyCookies: COOKIE_MODES.includes(s.thirdPartyCookies as ThirdPartyCookieMode)
      ? (s.thirdPartyCookies as ThirdPartyCookieMode)
      : d.thirdPartyCookies,
    thirdPartyCookieExceptions: exceptions,
    gpc: typeof s.gpc === 'boolean' ? s.gpc : d.gpc,
    dnt: typeof s.dnt === 'boolean' ? s.dnt : d.dnt
  }
}

// ---------------------------------------------------------------------------
// What the hosts apply
// ---------------------------------------------------------------------------

/**
 * The effective privacy policy, pushed to the host whenever the settings or the exception lists
 * change (`PrivacyHost.apply`). Hosts keep the latest copy and consult it per request and per
 * WebView; nothing here is persisted by them.
 */
export interface PrivacyFlags {
  safeBrowsing: boolean
  /**
   * Hosts (lowercase, no scheme or port) the user chose to proceed to past a Safe Browsing
   * warning, until the browser closes. The desktop host asks the core's service, which knows
   * them; the Android guard, which answers requests on its own, reads them from here.
   */
  safeBrowsingBypassed: string[]
  httpsOnly: HttpsOnlyMode
  /**
   * Sites (hosts, subdomains included) allowed to load over plaintext: the session's answers and
   * the stored `https-only` allows. Also the `excludedRequestDomains` of the mode's rule.
   */
  httpsOnlyAllowed: string[]
  thirdPartyCookies: ThirdPartyCookieMode
  thirdPartyCookieExceptions: string[]
  gpc: boolean
  dnt: boolean
  secureDnsMode: SecureDnsMode
  secureDnsServers: string[]
}

// ---------------------------------------------------------------------------
// Status (BrowserState.privacy)
// ---------------------------------------------------------------------------

export interface SafeBrowsingFeedStatus {
  id: string
  name: string
  homepage: string
  licence: string
  /** Hosts in the current copy of the feed. */
  entries: number
  /** When the current copy was fetched (or built into the app for the bundled snapshot). */
  updatedAt: number | null
  bundled: boolean
  updating: boolean
  lastError: string | null
}

export interface SafeBrowsingStatus {
  /** The tables are loaded and navigations are checked. */
  ready: boolean
  enabled: boolean
  /** Distinct hosts across every feed. */
  entries: number
  feeds: SafeBrowsingFeedStatus[]
  updating: boolean
  /** Most recent successful feed refresh. */
  lastUpdatedAt: number | null
  /** A Google Safe Browsing key is set: main-frame navigations are also looked up remotely. */
  remoteLookups: boolean
  /** Remote lookups that failed since the browser started (quota, key, network). */
  remoteErrors: number
}

export interface PrivacyStatus {
  safeBrowsing: SafeBrowsingStatus
  /** Sites the user may load over plaintext for good (`https-only` allows), sorted. */
  httpsOnlyExceptions: string[]
  /** Sites allowed over plaintext until the browser closes, sorted. */
  httpsOnlySessionExceptions: string[]
  /** What the host resolver was last configured with; `supported` is false where the host has none (Android). */
  secureDns: { supported: boolean; mode: SecureDnsMode; servers: string[] }
}

export function emptySafeBrowsingStatus(): SafeBrowsingStatus {
  return {
    ready: false,
    enabled: true,
    entries: 0,
    feeds: [],
    updating: false,
    lastUpdatedAt: null,
    remoteLookups: false,
    remoteErrors: 0
  }
}

export function emptyPrivacyStatus(): PrivacyStatus {
  return {
    safeBrowsing: emptySafeBrowsingStatus(),
    httpsOnlyExceptions: [],
    httpsOnlySessionExceptions: [],
    secureDns: { supported: false, mode: 'off', servers: [] }
  }
}

/** Threats a Safe Browsing hit is classified as (the feeds' focus, plus GSB's own types). */
export type SafeBrowsingThreat = 'malware' | 'phishing' | 'unwanted' | 'unknown'

/** Why Safe Browsing stopped a URL: which feed lists it, as what, under which expression. */
export interface SafeBrowsingHit {
  feedId: string
  threat: SafeBrowsingThreat
  /** The host (or host suffix) the feed lists. */
  expression: string
  /** A remote (Google Safe Browsing) answer rather than a local table. */
  remote: boolean
}

export const SAFE_BROWSING_THREAT_LABELS: Record<
  SafeBrowsingThreat,
  { title: string; description: string }
> = {
  malware: {
    title: 'The site ahead contains malware',
    description:
      'Attackers currently on this site might try to install dangerous programs on your device that steal or delete your information.'
  },
  phishing: {
    title: 'Deceptive site ahead',
    description:
      'Attackers on this site may trick you into doing something dangerous like installing software or revealing your personal information (for example, passwords, phone numbers or credit cards).'
  },
  unwanted: {
    title: 'The site ahead contains harmful programs',
    description:
      'Attackers on this site might try to trick you into installing programs that harm your browsing experience.'
  },
  unknown: {
    title: 'Dangerous site ahead',
    description: 'This site is on a list of sites known to attack the people who visit them.'
  }
}
