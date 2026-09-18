import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIVACY_SETTINGS,
  SECURE_DNS_PROVIDERS,
  hostInSites,
  isValidDohTemplate,
  normalizePrivacySite,
  sanitizePrivacySettings,
  secureDnsServers,
  siteMatchesHost
} from '../privacy'

describe('sanitizePrivacySettings', () => {
  it('returns the defaults for nothing and for junk', () => {
    expect(sanitizePrivacySettings(undefined)).toEqual(DEFAULT_PRIVACY_SETTINGS)
    expect(
      sanitizePrivacySettings({
        safeBrowsingEnabled: 'yes',
        httpsOnly: 'sometimes',
        secureDnsMode: 'dns',
        secureDnsProvider: 'nobody',
        thirdPartyCookies: 'maybe',
        thirdPartyCookieExceptions: 'example.com',
        gpc: 1,
        dnt: null
      } as never)
    ).toEqual(DEFAULT_PRIVACY_SETTINGS)
  })

  it('keeps valid values, normalises the exception sites and drops a malformed key', () => {
    const s = sanitizePrivacySettings({
      safeBrowsingEnabled: false,
      safeBrowsingApiKey: '  AIzaSy-Key_123  ',
      httpsOnly: 'always',
      secureDnsMode: 'provider',
      secureDnsProvider: 'quad9',
      secureDnsCustomUrl: ' https://dns.example/dns-query ',
      thirdPartyCookies: 'block',
      thirdPartyCookieExceptions: [
        'https://Login.Example.com/path',
        'example.com',
        'login.example.com',
        'not a host',
        42 as never
      ],
      gpc: true,
      dnt: true
    })
    expect(s).toMatchObject({
      safeBrowsingEnabled: false,
      safeBrowsingApiKey: 'AIzaSy-Key_123',
      httpsOnly: 'always',
      secureDnsMode: 'provider',
      secureDnsProvider: 'quad9',
      secureDnsCustomUrl: 'https://dns.example/dns-query',
      thirdPartyCookies: 'block',
      thirdPartyCookieExceptions: ['login.example.com', 'example.com'],
      gpc: true,
      dnt: true
    })
    expect(sanitizePrivacySettings({ safeBrowsingApiKey: 'has spaces' }).safeBrowsingApiKey).toBe(
      ''
    )
    expect(sanitizePrivacySettings({ secureDnsProvider: 'custom' }).secureDnsProvider).toBe(
      'custom'
    )
  })
})

describe('sites', () => {
  it('normalises URLs, origins and bare hosts to a lowercase host', () => {
    expect(normalizePrivacySite('www.Example.com/x')).toBe('www.example.com')
    expect(normalizePrivacySite('https://Example.com:8443/')).toBe('example.com')
    expect(normalizePrivacySite('  example.com.  ')).toBe('example.com')
    expect(normalizePrivacySite('192.0.2.1')).toBe('192.0.2.1')
    expect(normalizePrivacySite('[::1]')).toBe('[::1]')
    expect(normalizePrivacySite('')).toBeNull()
    expect(normalizePrivacySite('not a host')).toBeNull()
    expect(normalizePrivacySite('-bad.example')).toBeNull()
  })

  it('matches a site and its subdomains, not lookalikes', () => {
    expect(siteMatchesHost('example.com', 'example.com')).toBe(true)
    expect(siteMatchesHost('example.com', 'a.b.example.com')).toBe(true)
    expect(siteMatchesHost('example.com', 'notexample.com')).toBe(false)
    expect(siteMatchesHost('example.com', 'example.com.evil')).toBe(false)
    expect(hostInSites('cdn.example.com', ['other.test', 'example.com'])).toBe(true)
    expect(hostInSites('example.org', ['example.com'])).toBe(false)
  })
})

describe('secure DNS', () => {
  it('validates DoH templates', () => {
    expect(isValidDohTemplate('https://cloudflare-dns.com/dns-query')).toBe(true)
    expect(isValidDohTemplate('https://dns.example/dns-query{?dns}')).toBe(true)
    expect(isValidDohTemplate('http://dns.example/dns-query')).toBe(false)
    expect(isValidDohTemplate('https://user:pw@dns.example/dns-query')).toBe(false)
    expect(isValidDohTemplate('dns.example')).toBe(false)
    expect(isValidDohTemplate('')).toBe(false)
  })

  it('yields the provider template only in provider mode, or a valid custom one', () => {
    const base = { ...DEFAULT_PRIVACY_SETTINGS }
    expect(secureDnsServers(base)).toEqual([])
    expect(
      secureDnsServers({ ...base, secureDnsMode: 'provider', secureDnsProvider: 'google' })
    ).toEqual([SECURE_DNS_PROVIDERS.find((p) => p.id === 'google')!.url])
    expect(
      secureDnsServers({
        ...base,
        secureDnsMode: 'provider',
        secureDnsProvider: 'custom',
        secureDnsCustomUrl: 'https://dns.example/dns-query'
      })
    ).toEqual(['https://dns.example/dns-query'])
    expect(
      secureDnsServers({
        ...base,
        secureDnsMode: 'provider',
        secureDnsProvider: 'custom',
        secureDnsCustomUrl: 'nope'
      })
    ).toEqual([])
    for (const provider of SECURE_DNS_PROVIDERS) expect(isValidDohTemplate(provider.url)).toBe(true)
  })
})
