import {
  isValidDohTemplate,
  SECURE_DNS_CUSTOM,
  SECURE_DNS_PROVIDERS,
  secureDnsProvider,
  THIRD_PARTY_COOKIE_LABELS,
  type PrivacySettings,
  type PrivacyStatus,
  type SafeBrowsingStatus,
  type ThirdPartyCookieMode
} from '@shared/privacy'

/**
 * The words and checks behind Settings > Privacy and Security's protection groups (Safe Browsing,
 * HTTPS-only mode, secure DNS, third-party cookies, the privacy signals): pure functions over the
 * settings and the status, so the section components stay markup.
 */

/**
 * The words of the protection groups, read by the desktop pane (`overlays/ProtectionSection.tsx`)
 * and the phone Settings builder (`pages/settings/sections.tsx`) alike, so the two say the same
 * thing (§9.1: sentence case, no trailing full stop on a heading).
 */
export const PROTECTION_TEXT = {
  safeBrowsing: {
    heading: 'Safe Browsing',
    description:
      'Sites are checked against open feeds of malware and phishing hosts (URLhaus, Phishing.Database, malware-filter) before they load. The feeds are refreshed while the browser runs.',
    warn: {
      label: 'Warn about dangerous sites',
      description:
        'Deceptive and malware sites are stopped before they load. You can still go on from the warning.'
    },
    /** The phone's level choice (Chrome's Safe Browsing screen) over the desktop's one switch. */
    level: 'Protection level',
    standard: {
      label: 'Standard protection',
      description: 'Deceptive and malware sites are stopped before they load; you can still go on.'
    },
    none: {
      label: 'No protection',
      description: 'Sites are not checked against the feeds and no warning is shown.'
    },
    feeds: {
      heading: 'Feeds',
      description: 'The open lists of malware and phishing hosts the checks run against.'
    },
    update: 'Update feeds now',
    updateFeed: 'Update this feed now',
    homepage: (name: string) => `Open the homepage of ${name}`,
    apiKey: {
      label: 'Google Safe Browsing API key',
      placeholder: 'AIza…',
      description:
        'Optional. With a key, every page you open is also looked up in Google Safe Browsing (v5, hash prefixes only).',
      invalid: 'A key is letters, digits, dashes and underscores, up to 128 of them'
    }
  },
  httpsOnly: {
    heading: 'HTTPS-only mode',
    description:
      'Pages are asked for over https first, so what you send and receive stays encrypted on the way.'
  },
  plaintextSites: {
    heading: 'Sites allowed over http',
    description:
      'Sites you chose to load over plaintext from the warning page. Remove one to be asked again.',
    empty: 'No sites allowed over http yet',
    stored: 'Allowed over http for good',
    session: 'Allowed over http until the browser closes',
    askAgain: (site: string) => `Ask again before loading ${site} over http`
  },
  secureDns: {
    heading: 'Secure DNS',
    description:
      'Encrypt the lookups that turn a site’s name into an address, so the network cannot read or change them.',
    use: 'Use secure DNS',
    resolver: { label: 'Resolver', description: 'Where the encrypted lookups go.' },
    automatic: {
      label: 'With your current service provider',
      description: 'Encrypted when the system resolver offers it, plaintext otherwise.'
    },
    provider: {
      label: 'With a provider of your choice',
      description: 'Every lookup is encrypted and goes to this resolver, never to the system’s.'
    },
    custom: {
      label: 'Custom resolver',
      placeholder: 'https://dns.example/dns-query',
      description:
        'The DNS-over-HTTPS address your resolver publishes; a personal NextDNS or AdGuard profile has one of its own.',
      unset: 'Not set'
    }
  },
  privateDns: {
    description: 'On Android, encrypted DNS is a system setting that applies to every app.',
    open: {
      label: 'Open Private DNS settings',
      description:
        'Choose Automatic, or a private DNS provider by hostname, in Network and internet.'
    }
  },
  cookies: {
    heading: 'Third-party cookies',
    description:
      'Cookies set by a site embedded in another site, which is how most cross-site tracking works.'
  },
  relatedSites: {
    heading: 'Related sites',
    description:
      'Sites that may keep using third-party cookies whatever the setting: a sign-in provider, or a company’s other domains. A site covers its subdomains.',
    empty: 'No related sites yet',
    add: 'Add a site',
    addDescription: 'A sign-in provider, or a company’s other domains',
    siteHint: 'A site such as example.com; its subdomains come with it',
    remove: (site: string) => `Remove ${site}`,
    keeps: 'Keeps third-party cookies whatever the setting',
    duplicate: 'That site is already here',
    invalid: 'Enter a site such as example.com'
  },
  signals: {
    heading: 'Privacy signals',
    description:
      'Preferences sent with every request. Sites decide whether to honour them; the Global Privacy Control signal is binding under some privacy laws.',
    gpc: {
      label: 'Send a Global Privacy Control signal',
      description:
        'Tells sites not to sell or share your data (Sec-GPC: 1 and navigator.globalPrivacyControl).'
    },
    dnt: {
      label: 'Send a Do Not Track request',
      description:
        'Asks sites not to track you (DNT: 1 and navigator.doNotTrack). Many sites ignore it.'
    }
  }
} as const

/** `1234567` as `1,234,567`; the figures are set tabular where they are shown. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** `relativeTime`'s "Just now" embedded mid-sentence: "Updated just now" (sentence case, §9.1). */
export function ago(ts: number, relativeTime: (ts: number) => string): string {
  const text = relativeTime(ts)
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** `1 feed` / `3 feeds`. */
function feedsCount(n: number): string {
  return n === 1 ? '1 feed' : `${n} feeds`
}

/**
 * The Safe Browsing card's title block (design-language-v2-draft §9.27): what Safe Browsing is
 * doing, the size of what it checks against and when that was last refreshed.
 */
export function safeBrowsingCardText(
  status: SafeBrowsingStatus,
  relativeTime: (ts: number) => string
): {
  headline: string
  detail: string
} {
  if (!status.enabled) {
    return {
      headline: 'Safe Browsing is off',
      detail: 'Sites are not checked against the malware and phishing feeds.'
    }
  }
  if (!status.ready) {
    return {
      headline: 'Loading the feeds',
      detail: 'Navigations are checked as soon as the tables are in memory.'
    }
  }
  return {
    headline: 'Safe Browsing is on',
    detail: `${count(status.entries)} known dangerous sites across ${feedsCount(status.feeds.length)} · ${feedFreshness(status, relativeTime)}`
  }
}

/** When the feeds were last refreshed, as the update row says it. */
export function feedFreshness(
  status: SafeBrowsingStatus,
  relativeTime: (ts: number) => string
): string {
  if (status.updating) return 'Updating…'
  if (status.lastUpdatedAt !== null) return `Updated ${ago(status.lastUpdatedAt, relativeTime)}`
  if (status.feeds.some((f) => f.bundled)) return 'Built into the app; not refreshed yet'
  return 'Not refreshed yet'
}

/**
 * The phone's "Update feeds now" action row, in one line (§10.4): size, feeds and freshness,
 * or why there is nothing to update.
 */
export function updateRowText(
  status: SafeBrowsingStatus,
  relativeTime: (ts: number) => string
): string {
  if (!status.enabled) return 'Turn Safe Browsing on to refresh the feeds.'
  if (!status.ready) return 'Loading the feeds…'
  return `${count(status.entries)} sites across ${feedsCount(status.feeds.length)} · ${feedFreshness(status, relativeTime)}`
}

/** The second line of one feed's row: its size, its freshness and the last failure. */
export function feedDetail(
  feed: SafeBrowsingStatus['feeds'][number],
  relativeTime: (ts: number) => string
): string {
  const parts = [`${count(feed.entries)} sites`]
  if (feed.updating) parts.push('Updating…')
  else if (feed.updatedAt === null)
    parts.push(feed.bundled ? 'Built into the app' : 'Not fetched yet')
  else parts.push(`${feed.bundled ? 'Built in, ' : ''}${ago(feed.updatedAt, relativeTime)}`)
  if (feed.lastError) parts.push(`Last update failed: ${feed.lastError}`)
  return parts.join(' · ')
}

/**
 * The Google Safe Browsing key field's description: what a key does, and – once one is set –
 * whether the remote lookups run and how many have failed since the browser started.
 */
export function remoteLookupsText(status: SafeBrowsingStatus, key: string): string {
  if (!key) {
    return 'Optional. With a key, every page you open is also looked up in Google Safe Browsing (v5, hash prefixes only); Google’s free tier allows 10,000 lookups a day.'
  }
  if (!status.enabled) return 'Remote lookups resume when Safe Browsing is turned back on.'
  if (!status.remoteLookups) return 'Key saved. Remote lookups start with the next page you open.'
  if (status.remoteErrors > 0) {
    const n = status.remoteErrors
    return `Remote lookups are on · ${n === 1 ? '1 lookup' : `${count(n)} lookups`} failed since the browser started (quota, key or network).`
  }
  return 'Remote lookups are on. Only hash prefixes leave the device, never the address itself.'
}

/**
 * The phone's key row in one line (§10.4; the row never shows the key itself): whether one is
 * set and what the lookups are doing.
 */
export function apiKeyRowText(status: SafeBrowsingStatus, key: string): string {
  if (!key) return 'Not set · optional, adds Google Safe Browsing lookups'
  if (!status.enabled) return 'Set · lookups resume when Safe Browsing is on'
  if (!status.remoteLookups) return 'Set · lookups start with the next page you open'
  if (status.remoteErrors > 0) {
    const n = status.remoteErrors
    return `Set · ${n === 1 ? '1 lookup' : `${count(n)} lookups`} failed since the browser started`
  }
  return 'Set · remote lookups on'
}

/**
 * The third-party cookie modes as a picker's options. The middle mode is about private
 * windows on a windowed host and private tabs on one without windows (Android, §10.4), so the
 * words follow `capabilities.windows` as the desktop pane follows the shared labels.
 */
export function cookieModeOptions(
  windows: boolean
): Array<{ value: ThirdPartyCookieMode; label: string; description: string }> {
  return (Object.keys(THIRD_PARTY_COOKIE_LABELS) as ThirdPartyCookieMode[]).map((value) => {
    const { label, description } = THIRD_PARTY_COOKIE_LABELS[value]
    return windows
      ? { value, label, description }
      : {
          value,
          label: label.replace('private windows', 'private tabs'),
          description: description.replace('In a private window', 'In a private tab')
        }
  })
}

/** A Google API key as typed: letters, digits, `_` and `-`, at most 128 of them (or empty). */
export function isValidApiKey(key: string): boolean {
  const text = key.trim()
  return text.length <= 128 && /^[A-Za-z0-9_-]*$/.test(text)
}

export interface ProviderOption {
  value: string
  label: string
  description: string
}

/** The secure DNS menulist's options: the providers in their table order, then the custom entry. */
export function providerOptions(): ProviderOption[] {
  return [
    ...SECURE_DNS_PROVIDERS.map((p) => ({ value: p.id, label: p.name, description: p.notes })),
    {
      value: SECURE_DNS_CUSTOM,
      label: 'Custom resolver',
      description: 'A DNS-over-HTTPS template of your own, entered below.'
    }
  ]
}

/** The phone resolver picker's first option: the system resolver, encrypted when it offers it. */
export const RESOLVER_AUTOMATIC = 'automatic'

/**
 * The phone's one resolver picker (§10.4 folds the desktop's two radios and the menulist into a
 * value row): the system resolver first, then the providers, then the custom entry.
 */
export function resolverOptions(): ProviderOption[] {
  return [
    {
      value: RESOLVER_AUTOMATIC,
      label: 'Your current service provider',
      description: 'Encrypted when the system resolver offers it, plaintext otherwise.'
    },
    ...providerOptions()
  ]
}

/** Which resolver option the settings stand for. */
export function resolverValue(settings: PrivacySettings): string {
  return settings.secureDnsMode === 'provider' ? settings.secureDnsProvider : RESOLVER_AUTOMATIC
}

/** The settings a resolver option picks. */
export function resolverPatch(value: string): Partial<PrivacySettings> {
  return value === RESOLVER_AUTOMATIC
    ? { secureDnsMode: 'automatic' }
    : { secureDnsMode: 'provider', secureDnsProvider: value }
}

/** The secure DNS row's description: what the resolver is doing with the settings as they stand. */
export function secureDnsText(
  settings: PrivacySettings,
  status: PrivacyStatus['secureDns']
): string {
  if (settings.secureDnsMode === 'off') return 'Lookups go to the system resolver in plaintext.'
  if (settings.secureDnsMode === 'automatic')
    return 'The system resolver is used over an encrypted connection when it offers one, plaintext otherwise.'
  if (settings.secureDnsProvider === SECURE_DNS_CUSTOM) {
    return isValidDohTemplate(settings.secureDnsCustomUrl)
      ? `Every lookup goes, encrypted, to ${hostOfTemplate(settings.secureDnsCustomUrl)}.`
      : 'Enter the resolver’s DNS-over-HTTPS address below; until then lookups fall back to automatic.'
  }
  const provider = secureDnsProvider(settings.secureDnsProvider)
  const applied = status.servers.length > 0
  return `Every lookup goes, encrypted, to ${provider?.name ?? settings.secureDnsProvider}${applied ? '' : ' once the resolver is configured'}.`
}

function hostOfTemplate(template: string): string {
  try {
    return new URL(template.trim().replace('{?dns}', '')).hostname
  } catch {
    return template.trim()
  }
}

/** The custom-resolver field's validation text, or null while it is empty or valid. */
export function customResolverProblem(url: string): string | null {
  const text = url.trim()
  if (!text) return null
  if (!/^https:\/\//i.test(text)) return 'The address must start with https://'
  if (!isValidDohTemplate(text))
    return 'Enter a DNS-over-HTTPS address such as https://dns.example/dns-query'
  return null
}
