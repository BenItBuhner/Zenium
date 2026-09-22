import { describe, expect, it } from 'vitest'
import {
  CLEAR_ON_EXIT_TYPES,
  SITE_DATA_LIST_LIMIT,
  compareSiteDataRows,
  cookieVerdict,
  cookiesBlockedFor,
  emptySiteDataStatus,
  resolveSiteData,
  sanitizeClearOnExit,
  sanitizeSiteDataPolicy,
  siteDataPolicyEquals,
  sortSitePatterns,
  type SiteDataOriginRow,
  type SiteDataPolicy
} from '../siteData'

const policy = (overrides: Partial<SiteDataPolicy> = {}): SiteDataPolicy => ({
  blockAll: false,
  allow: [],
  clearOnExit: [],
  block: [],
  ...overrides
})

describe('sanitizeSiteDataPolicy', () => {
  it('normalises the patterns, drops what does not parse and keeps a pattern on one list', () => {
    const out = sanitizeSiteDataPolicy({
      blockAll: 'yes',
      allow: ['Example.com', 'bad/path', 42, '[*.]news.example', 'example.com'],
      clearOnExit: ['[*.]NEWS.example', 'session.example'],
      block: ['tracker.example', '  tracker.example  ', 'HTTPS://[*.]ads.example']
    })
    // The stricter list is read first: `[*.]news.example` stays on clear-on-exit, not allow.
    expect(out).toEqual({
      blockAll: false,
      allow: ['example.com'],
      clearOnExit: ['[*.]news.example', 'session.example'],
      block: ['tracker.example', 'https://[*.]ads.example']
    })
    // The block list is read first of all, so a pattern found on two lists stays blocked.
    expect(sanitizeSiteDataPolicy({ allow: ['a.example'], block: ['a.example'] })).toEqual(
      policy({ block: ['a.example'] })
    )
    expect(sanitizeSiteDataPolicy(null)).toEqual(policy())
    expect(sanitizeSiteDataPolicy({ blockAll: true })).toEqual(policy({ blockAll: true }))
  })

  it('caps every list at the limit', () => {
    const many = Array.from({ length: SITE_DATA_LIST_LIMIT + 5 }, (_, i) => `s${i}.example`)
    const out = sanitizeSiteDataPolicy({ allow: many })
    expect(out.allow).toHaveLength(SITE_DATA_LIST_LIMIT)
    expect(out.allow[0]).toBe('s0.example')
  })

  it('compares policies list by list, in order', () => {
    expect(
      siteDataPolicyEquals(policy({ allow: ['a.example'] }), policy({ allow: ['a.example'] }))
    ).toBe(true)
    expect(
      siteDataPolicyEquals(
        policy({ allow: ['a.example', 'b.example'] }),
        policy({ allow: ['b.example', 'a.example'] })
      )
    ).toBe(false)
    expect(siteDataPolicyEquals(policy(), policy({ blockAll: true }))).toBe(false)
  })

  it('sorts a list for display with the most specific pattern first', () => {
    expect(
      sortSitePatterns(['[*.]example.com', 'bad/', 'www.example.com', 'https://example.com'])
    ).toEqual(['www.example.com', 'https://example.com', '[*.]example.com'])
  })
})

describe('resolveSiteData', () => {
  it('lets the most specific pattern across the lists decide', () => {
    const p = policy({
      allow: ['[*.]example.com'],
      block: ['ads.example.com'],
      clearOnExit: ['[*.]shop.example.com']
    })
    expect(resolveSiteData(p, 'https://www.example.com/')).toEqual({
      state: 'allow',
      pattern: '[*.]example.com'
    })
    expect(resolveSiteData(p, 'https://ads.example.com/pixel')).toEqual({
      state: 'block',
      pattern: 'ads.example.com'
    })
    expect(resolveSiteData(p, 'https://cart.shop.example.com/')).toEqual({
      state: 'clear-on-exit',
      pattern: '[*.]shop.example.com'
    })
    expect(resolveSiteData(p, 'https://other.example/')).toEqual({
      state: 'default',
      pattern: null
    })
    expect(resolveSiteData(p, 'about:blank')).toEqual({ state: 'default', pattern: null })
  })

  it('breaks a tie between lists towards the stricter word: block, then clear on exit', () => {
    const tie = policy({
      allow: ['a.example'],
      clearOnExit: ['a.example'],
      block: ['a.example']
    })
    expect(resolveSiteData(tie, 'https://a.example/').state).toBe('block')
    expect(
      resolveSiteData(
        policy({ allow: ['a.example'], clearOnExit: ['a.example'] }),
        'https://a.example/'
      ).state
    ).toBe('clear-on-exit')
    // Two different patterns are never a tie: Chrome's order (a named scheme before a named
    // port) decides between them, whatever their lists.
    const ordered = policy({ allow: ['https://a.example'], block: ['a.example:443'] })
    expect(resolveSiteData(ordered, 'https://a.example/')).toEqual({
      state: 'allow',
      pattern: 'https://a.example'
    })
    const wider = policy({ allow: ['a.example'], block: ['[*.]a.example'] })
    expect(resolveSiteData(wider, 'https://a.example/').state).toBe('allow')
    expect(resolveSiteData(wider, 'https://www.a.example/').state).toBe('block')
  })
})

describe('cookieVerdict', () => {
  it('blocks a never-site, allows a listed site whatever the context, defaults the rest', () => {
    const p = policy({
      allow: ['[*.]ok.example'],
      block: ['[*.]never.example'],
      clearOnExit: ['s.example']
    })
    expect(cookieVerdict(p, 'https://cdn.never.example/x')).toBe('blocked')
    expect(cookieVerdict(p, 'https://ok.example/')).toBe('allowed')
    // A clear-on-exit site keeps its cookies for the session, as Chrome's "session only" does.
    expect(cookieVerdict(p, 'https://s.example/')).toBe('allowed')
    expect(cookieVerdict(p, 'https://other.example/')).toBe('default')
    expect(cookiesBlockedFor(p, 'https://never.example/')).toBe(true)
    expect(cookiesBlockedFor(p, 'https://other.example/')).toBe(false)
  })

  it('under "block all cookies" blocks every site the allow and clear-on-exit lists leave out', () => {
    const p = policy({ blockAll: true, allow: ['ok.example'], clearOnExit: ['s.example'] })
    expect(cookieVerdict(p, 'https://other.example/')).toBe('blocked')
    expect(cookieVerdict(p, 'https://ok.example/')).toBe('allowed')
    expect(cookieVerdict(p, 'https://s.example/')).toBe('allowed')
    // The allow list names the host alone: a subdomain is not on it.
    expect(cookieVerdict(p, 'https://www.ok.example/')).toBe('blocked')
    // A URL without a host is nobody's: the default, which blocks.
    expect(cookieVerdict(p, 'about:blank')).toBe('blocked')
    expect(cookieVerdict(policy(), 'about:blank')).toBe('default')
  })
})

describe('sanitizeClearOnExit', () => {
  it("keeps the known types once each, in the dialog's order, and never passwords", () => {
    expect(
      sanitizeClearOnExit({
        types: ['cache', 'passwords', 'history', 'cache', 'bogus', 'cookies', 'recentlyClosed']
      })
    ).toEqual({ types: ['history', 'cookies', 'cache', 'recentlyClosed'] })
    expect(sanitizeClearOnExit(undefined)).toEqual({ types: [] })
    expect(sanitizeClearOnExit({ types: 'history' })).toEqual({ types: [] })
    expect(CLEAR_ON_EXIT_TYPES).not.toContain('passwords')
  })
})

describe('compareSiteDataRows', () => {
  const row = (origin: string, usageBytes: number | null, cookies = 0): SiteDataOriginRow => ({
    origin,
    site: new URL(origin).hostname.split('.').slice(-2).join('.'),
    cookies,
    usageBytes,
    permissions: [],
    state: 'default'
  })

  it('puts the most data first, unsized rows below sized ones, then cookies, then names', () => {
    const rows = [
      row('https://z.example', null, 1),
      row('https://a.example', 10),
      row('https://b.example', 10),
      row('https://c.example', null, 5),
      row('https://big.example', 1000)
    ]
    expect([...rows].sort(compareSiteDataRows).map((r) => r.origin)).toEqual([
      'https://big.example',
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://z.example'
    ])
  })

  it('the empty status says the default policy and no pending clear', () => {
    expect(emptySiteDataStatus()).toEqual({
      default: 'block-third-party',
      allow: [],
      clearOnExit: [],
      block: [],
      clearOnExitTypes: [],
      clearsAtNextLaunch: false,
      pendingClear: false
    })
  })
})
