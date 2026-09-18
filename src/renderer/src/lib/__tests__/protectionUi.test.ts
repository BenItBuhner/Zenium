import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIVACY_SETTINGS,
  emptySafeBrowsingStatus,
  SECURE_DNS_CUSTOM,
  SECURE_DNS_PROVIDERS,
  type PrivacySettings,
  type SafeBrowsingFeedStatus,
  type SafeBrowsingStatus
} from '@shared/privacy'
import {
  ago,
  count,
  customResolverProblem,
  feedDetail,
  feedFreshness,
  isValidApiKey,
  providerOptions,
  remoteLookupsText,
  RESOLVER_AUTOMATIC,
  resolverOptions,
  resolverPatch,
  resolverValue,
  safeBrowsingCardText,
  secureDnsText,
  updateRowText
} from '../protectionUi'

/** `relativeTime` as the chrome words it, without the clock. */
const relative = (ts: number): string => (ts === 0 ? 'Just now' : '2 min ago')

function feed(over: Partial<SafeBrowsingFeedStatus> = {}): SafeBrowsingFeedStatus {
  return {
    id: 'urlhaus',
    name: 'URLhaus',
    homepage: 'https://urlhaus.abuse.ch/',
    licence: 'CC0',
    entries: 12345,
    updatedAt: 1,
    bundled: false,
    updating: false,
    lastError: null,
    ...over
  }
}

function status(over: Partial<SafeBrowsingStatus> = {}): SafeBrowsingStatus {
  return {
    ...emptySafeBrowsingStatus(),
    ready: true,
    entries: 1234567,
    feeds: [feed(), feed({ id: 'phishing-database', name: 'Phishing.Database', bundled: true })],
    lastUpdatedAt: 1,
    ...over
  }
}

function settings(over: Partial<PrivacySettings> = {}): PrivacySettings {
  return { ...DEFAULT_PRIVACY_SETTINGS, ...over }
}

describe('count and ago', () => {
  it('groups figures and lowers the clock into a sentence', () => {
    expect(count(1234567)).toBe('1,234,567')
    expect(ago(0, relative)).toBe('just now')
    expect(ago(1, relative)).toBe('2 min ago')
  })
})

describe('safeBrowsingCardText', () => {
  it('names the state as its headline and sizes the feeds in the detail', () => {
    expect(safeBrowsingCardText(status(), relative)).toEqual({
      headline: 'Safe Browsing is on',
      detail: '1,234,567 known dangerous sites across 2 feeds · Updated 2 min ago'
    })
  })

  it('says off and loading in their own words', () => {
    expect(safeBrowsingCardText(status({ enabled: false }), relative).headline).toBe(
      'Safe Browsing is off'
    )
    expect(safeBrowsingCardText(status({ ready: false }), relative).headline).toBe(
      'Loading the feeds'
    )
  })

  it('counts one feed in the singular', () => {
    expect(safeBrowsingCardText(status({ feeds: [feed()] }), relative).detail).toContain(
      'across 1 feed ·'
    )
  })
})

describe('feedFreshness', () => {
  it('prefers the update in progress, then the last refresh, then the bundled snapshot', () => {
    expect(feedFreshness(status({ updating: true }), relative)).toBe('Updating…')
    expect(feedFreshness(status({ lastUpdatedAt: 0 }), relative)).toBe('Updated just now')
    expect(feedFreshness(status({ lastUpdatedAt: null }), relative)).toBe(
      'Built into the app; not refreshed yet'
    )
    expect(
      feedFreshness(status({ lastUpdatedAt: null, feeds: [feed({ bundled: false })] }), relative)
    ).toBe('Not refreshed yet')
  })
})

describe('updateRowText', () => {
  it('is one line: the size and freshness, or why there is nothing to update', () => {
    expect(updateRowText(status(), relative)).toBe(
      '1,234,567 sites across 2 feeds · Updated 2 min ago'
    )
    expect(updateRowText(status({ enabled: false }), relative)).toBe(
      'Turn Safe Browsing on to refresh the feeds.'
    )
    expect(updateRowText(status({ ready: false }), relative)).toBe('Loading the feeds…')
  })
})

describe('feedDetail', () => {
  it('reads size, freshness and the last failure, separated by middle dots', () => {
    expect(feedDetail(feed(), relative)).toBe('12,345 sites · 2 min ago')
    expect(feedDetail(feed({ updating: true }), relative)).toBe('12,345 sites · Updating…')
    expect(feedDetail(feed({ updatedAt: null }), relative)).toBe('12,345 sites · Not fetched yet')
    expect(feedDetail(feed({ updatedAt: null, bundled: true }), relative)).toBe(
      '12,345 sites · Built into the app'
    )
    expect(feedDetail(feed({ bundled: true }), relative)).toBe('12,345 sites · Built in, 2 min ago')
    expect(feedDetail(feed({ lastError: 'HTTP 503' }), relative)).toBe(
      '12,345 sites · 2 min ago · Last update failed: HTTP 503'
    )
  })
})

describe('remoteLookupsText', () => {
  it('explains the key while there is none and reports the lookups once there is', () => {
    expect(remoteLookupsText(status(), '')).toMatch(/^Optional\./)
    expect(remoteLookupsText(status({ enabled: false }), 'AIza')).toBe(
      'Remote lookups resume when Safe Browsing is turned back on.'
    )
    expect(remoteLookupsText(status({ remoteLookups: false }), 'AIza')).toBe(
      'Key saved. Remote lookups start with the next page you open.'
    )
    expect(remoteLookupsText(status({ remoteLookups: true }), 'AIza')).toBe(
      'Remote lookups are on. Only hash prefixes leave the device, never the address itself.'
    )
    expect(remoteLookupsText(status({ remoteLookups: true, remoteErrors: 1 }), 'AIza')).toContain(
      '1 lookup failed'
    )
    expect(
      remoteLookupsText(status({ remoteLookups: true, remoteErrors: 1200 }), 'AIza')
    ).toContain('1,200 lookups failed')
  })
})

describe('isValidApiKey', () => {
  it('accepts the shape of a Google key and rejects anything else', () => {
    expect(isValidApiKey('')).toBe(true)
    expect(isValidApiKey(' AIzaSyA-b_c123 ')).toBe(true)
    expect(isValidApiKey('AIza SyA')).toBe(false)
    expect(isValidApiKey('key;drop')).toBe(false)
    expect(isValidApiKey('a'.repeat(129))).toBe(false)
  })
})

describe('the resolver options', () => {
  it('lists the providers in table order with the custom entry last', () => {
    const options = providerOptions()
    expect(options.map((o) => o.value)).toEqual([
      ...SECURE_DNS_PROVIDERS.map((p) => p.id),
      SECURE_DNS_CUSTOM
    ])
    expect(options.at(-1)?.label).toBe('Custom resolver')
  })

  it("puts the system resolver first in the phone's one picker", () => {
    const options = resolverOptions()
    expect(options[0]?.value).toBe(RESOLVER_AUTOMATIC)
    expect(options.slice(1)).toEqual(providerOptions())
  })

  it('maps the settings to an option and back', () => {
    expect(resolverValue(settings({ secureDnsMode: 'automatic' }))).toBe(RESOLVER_AUTOMATIC)
    expect(resolverValue(settings({ secureDnsMode: 'off' }))).toBe(RESOLVER_AUTOMATIC)
    expect(resolverValue(settings({ secureDnsMode: 'provider', secureDnsProvider: 'quad9' }))).toBe(
      'quad9'
    )
    expect(resolverPatch(RESOLVER_AUTOMATIC)).toEqual({ secureDnsMode: 'automatic' })
    expect(resolverPatch('quad9')).toEqual({
      secureDnsMode: 'provider',
      secureDnsProvider: 'quad9'
    })
  })
})

describe('secureDnsText', () => {
  const applied = { supported: true, mode: 'provider' as const, servers: ['x'] }
  const pending = { supported: true, mode: 'provider' as const, servers: [] }

  it('says where lookups go for each mode', () => {
    expect(secureDnsText(settings({ secureDnsMode: 'off' }), pending)).toBe(
      'Lookups go to the system resolver in plaintext.'
    )
    expect(secureDnsText(settings({ secureDnsMode: 'automatic' }), pending)).toMatch(
      /^The system resolver is used over an encrypted connection/
    )
    expect(
      secureDnsText(settings({ secureDnsMode: 'provider', secureDnsProvider: 'quad9' }), applied)
    ).toBe('Every lookup goes, encrypted, to Quad9.')
    expect(
      secureDnsText(settings({ secureDnsMode: 'provider', secureDnsProvider: 'quad9' }), pending)
    ).toBe('Every lookup goes, encrypted, to Quad9 once the resolver is configured.')
  })

  it('names the custom resolver by its host, or asks for one', () => {
    const custom = (url: string): PrivacySettings =>
      settings({
        secureDnsMode: 'provider',
        secureDnsProvider: SECURE_DNS_CUSTOM,
        secureDnsCustomUrl: url
      })
    expect(secureDnsText(custom('https://dns.example/dns-query{?dns}'), applied)).toBe(
      'Every lookup goes, encrypted, to dns.example.'
    )
    expect(secureDnsText(custom(''), applied)).toMatch(
      /^Enter the resolver’s DNS-over-HTTPS address/
    )
  })
})

describe('customResolverProblem', () => {
  it('is quiet while the field is empty or valid and names the fault otherwise', () => {
    expect(customResolverProblem('')).toBeNull()
    expect(customResolverProblem('https://dns.example/dns-query')).toBeNull()
    expect(customResolverProblem('http://dns.example/dns-query')).toBe(
      'The address must start with https://'
    )
    expect(customResolverProblem('https://user:pw@dns.example/dns-query')).toBe(
      'Enter a DNS-over-HTTPS address such as https://dns.example/dns-query'
    )
  })
})
