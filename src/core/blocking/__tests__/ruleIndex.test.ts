import { describe, expect, it } from 'vitest'
import {
  EVERY_URL,
  RuleIndex,
  RuleIndexBuilder,
  hasDomainOf,
  hashToken,
  hostSuffixes,
  regexRequiredTokens,
  regexSelector,
  tokenize,
  urlFilterSelector,
  type IndexLookup,
  type IndexedRule,
  type UrlSelector
} from '../ruleIndex'
import type { ResourceType } from '../rules'

/** Token hashes of the words of `text`, the way the Kotlin tests spell expectations. */
function tokensOf(text: string): number[] {
  return tokenize(text.toLowerCase())
}

function selectorTokens(selector: UrlSelector): number[] | null {
  return selector.kind === 'tokens' ? [...selector.tokens] : null
}

describe('tokenize', () => {
  it('splits lowercased text into [a-z0-9] runs and hashes each with djb2', () => {
    expect(tokenize('https://a.b-c_d.example/x1/y')).toEqual(
      ['https', 'a', 'b', 'c', 'd', 'example', 'x1', 'y'].map((t) => hashToken(t, 0, t.length))
    )
    expect(tokenize('')).toEqual([])
    expect(tokenize('/-_.')).toEqual([])
  })

  it('hashes as the Kotlin Tokens.hash does: 32-bit djb2', () => {
    // djb2("a") = 5381 * 33 + 97
    expect(hashToken('a', 0, 1)).toBe(5381 * 33 + 97)
    // Wraps to a 32-bit integer instead of growing.
    const h = hashToken('averyveryverylongtokenthatoverflows', 0, 35)
    expect(Number.isInteger(h)).toBe(true)
    expect(Math.abs(h)).toBeLessThan(2 ** 31)
    // Substring hashing agrees with hashing the substring.
    expect(hashToken('xx/pixel/yy', 3, 8)).toBe(hashToken('pixel', 0, 5))
  })
})

describe('urlFilterSelector', () => {
  it('puts ||host^ (and ||host|) under the hostname', () => {
    expect(urlFilterSelector('||tracker.net^', false)).toEqual({
      kind: 'hostname',
      hostname: 'tracker.net'
    })
    expect(urlFilterSelector('||Tracker.NET^', false)).toEqual({
      kind: 'hostname',
      hostname: 'tracker.net'
    })
    expect(urlFilterSelector('||tracker.net|', false)).toEqual({
      kind: 'hostname',
      hostname: 'tracker.net'
    })
    expect(urlFilterSelector('||tracker.net^*', false)).toEqual({
      kind: 'hostname',
      hostname: 'tracker.net'
    })
  })

  it('does not take a bare ||host for the hostname: the desktop matcher reads it as a prefix', () => {
    // `||host` matches `hostile.example`, so `host` is not a complete token either.
    expect(urlFilterSelector('||host', false)).toEqual(EVERY_URL)
    expect(selectorTokens(urlFilterSelector('||tracker.net', false))).toEqual(tokensOf('tracker'))
    // Malformed hosts are not hostnames.
    expect(urlFilterSelector('||.tracker.net^', false).kind).not.toBe('hostname')
    expect(urlFilterSelector('||tracker..net^', false).kind).not.toBe('hostname')
    // A case-sensitive filter with upper case is not a hostname (hosts are lower case).
    expect(urlFilterSelector('||Tracker.net^', true).kind).not.toBe('hostname')
  })

  it('takes the runs bounded inside the pattern as tokens, never a run next to * or an open end', () => {
    // `js` sits after the wildcard's neighbourhood and is not bounded on the right.
    expect(selectorTokens(urlFilterSelector('||example.com/ad-server/*.js', false))).toEqual(
      tokensOf('example.com/ad-server/')
    )
    // An unanchored plain pattern: the first and last runs may be partial.
    expect(selectorTokens(urlFilterSelector('ad/pixel/tr', false))).toEqual(tokensOf('pixel'))
    // Anchors bound the ends.
    expect(selectorTokens(urlFilterSelector('|http://ads.example/', false))).toEqual(
      tokensOf('http ads example')
    )
    // `pixel.gif|` matches `xpixel.gif`: only `gif` is complete.
    expect(selectorTokens(urlFilterSelector('pixel.gif|', false))).toEqual(tokensOf('gif'))
    // `^` and every literal non-token character are boundaries; `?` is a literal here.
    expect(selectorTokens(urlFilterSelector('/ads?/', false))).toEqual(tokensOf('ads'))
    expect(selectorTokens(urlFilterSelector('^track|pixel^', false))).toEqual(
      tokensOf('track pixel')
    )
    expect(selectorTokens(urlFilterSelector('?v=2&tid=g-', false))).toEqual(tokensOf('v 2 tid g'))
    // Lower case for the index over the lowercased URL, case-sensitive or not.
    expect(selectorTokens(urlFilterSelector('||ADS.example/Banner^', true))).toEqual(
      tokensOf('ads example banner')
    )
  })

  it('yields nothing usable for wildcards, empty filters and patterns of partial runs', () => {
    expect(urlFilterSelector('*', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('*ads*', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('adsbygoogle', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('||', false)).toEqual(EVERY_URL)
  })

  it('a wildcard at an anchored end takes the anchor with it', () => {
    // `|*foo` matches `xfoo`: `foo` is not the start of a token.
    expect(urlFilterSelector('|*foo^', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('^foo*|', false)).toEqual(EVERY_URL)
    expect(urlFilterSelector('|foo*|', false)).toEqual(EVERY_URL)
    expect(selectorTokens(urlFilterSelector('|foo^*|', false))).toEqual(tokensOf('foo'))
  })
})

describe('regexRequiredTokens', () => {
  it('are the runs bounded by anchors or literal separators (the Kotlin cases)', () => {
    // `https` is followed by an optional character: not a complete token. `chatgpt`, `com`, `ces` are.
    expect(regexRequiredTokens('^https?:\\/\\/chatgpt\\.com\\/ces\\/v1\\/[a-z]$')).toEqual([
      'chatgpt',
      'com',
      'ces'
    ])
    expect(regexRequiredTokens('^https://[a-z]+\\.tracker\\.example/')).toEqual([
      'https',
      'tracker',
      'example'
    ])
    // Anchors bound a run; the end of the expression without one does not.
    expect(regexRequiredTokens('^pixel$')).toEqual(['pixel'])
    expect(regexRequiredTokens('pixel')).toBeNull()
    expect(regexRequiredTokens('^pixel')).toBeNull()
    expect(regexRequiredTokens('/pixel/tr')).toEqual(['pixel'])
    // A group or class next to a run may put more letters against it; a `.` matches anything.
    expect(regexRequiredTokens('^[^:]+://([^:/]+\\.)?scam\\..*')).toBeNull()
    expect(regexRequiredTokens('/beac.n\\?')).toBeNull()
    expect(regexRequiredTokens('\\d+abc\\.')).toBeNull()
    expect(regexRequiredTokens('/abc[a-z]/')).toBeNull()
    // Escaped metacharacters are literal separators; `-` and `_` count as separators like the tokenizer says.
    expect(regexRequiredTokens('\\.abc-def\\?')).toEqual(['abc', 'def'])
    expect(regexRequiredTokens('\\(abc\\)')).toEqual(['abc'])
    // A class may end in a separator but is not looked into.
    expect(regexRequiredTokens('[x\\-]def\\.')).toBeNull()
    // Lowercased for the index over the lowercased URL, and nothing from a top-level alternation.
    expect(regexRequiredTokens('/Track/')).toEqual(['track'])
    expect(regexRequiredTokens('/track/|/pixel/')).toBeNull()
    // A separator the expression may leave out (`/?`, `\.?`, `/*`, `/{0,1}`) bounds nothing:
    // `/ads/?` matches `/adsx`, whose token is longer. `+` keeps at least one.
    expect(regexRequiredTokens('/ads/?')).toBeNull()
    expect(regexRequiredTokens('\\/ads\\/?')).toBeNull()
    expect(regexRequiredTokens('/ads/*')).toBeNull()
    expect(regexRequiredTokens('/ads/{0,1}')).toBeNull()
    expect(regexRequiredTokens('/beacon-?[0-9]*\\.gif')).toBeNull()
    expect(regexRequiredTokens('^https://cdn\\.example/lib\\.?js')).toEqual([
      'https',
      'cdn',
      'example'
    ])
    expect(regexRequiredTokens('/ads/+')).toEqual(['ads'])
    expect(regexRequiredTokens('/ads\\.+x')).toEqual(['ads'])
    // The digits of a `{n,m}` count are not text of the URL.
    expect(regexRequiredTokens('^[a-z]{100,200}/')).toBeNull()
    expect(regexRequiredTokens('/tracker[a-z]{100,200}\\.js')).toBeNull()
    expect(regexRequiredTokens('/[0-9a-f]{12}\\.js$')).toBeNull()
  })

  it('leaves escapes that stand for characters alone (\\u, \\x, \\d, \\w, \\b)', () => {
    expect(regexRequiredTokens('/\\u0061ds/')).toBeNull()
    expect(regexRequiredTokens('/ads\\u002F')).toBeNull()
    expect(regexRequiredTokens('/\\x61ds/')).toBeNull()
    expect(regexRequiredTokens('\\bads\\b')).toBeNull()
    expect(regexRequiredTokens('/\\w+/track/')).toEqual(['track'])
  })

  it('reaches the selector as hashes over the lowercased runs', () => {
    expect(selectorTokens(regexSelector('^https://[a-z]+\\.Tracker\\.example/'))).toEqual(
      tokensOf('https tracker example')
    )
    expect(regexSelector('/[0-9a-f]{12}\\.js$')).toEqual(EVERY_URL)
    expect(regexSelector('banner\\.js$')).toEqual(EVERY_URL)
  })
})

describe('hostSuffixes', () => {
  it('lists the host and every parent domain, which is what hostMatchesDomain accepts', () => {
    expect(hostSuffixes('a.b.example')).toEqual(['a.b.example', 'b.example', 'example'])
    expect(hostSuffixes('example')).toEqual(['example'])
    expect(hostSuffixes('')).toEqual([''])
    expect(hasDomainOf(hostSuffixes('cdn.ads.example'), new Set(['ads.example']))).toBe(true)
    expect(hasDomainOf(hostSuffixes('notads.example'), new Set(['ads.example']))).toBe(false)
    expect(hasDomainOf(hostSuffixes('ads.example.evil'), new Set(['ads.example']))).toBe(false)
  })
})

// -------------------------------------------------------------------------------------------
// The index
// -------------------------------------------------------------------------------------------

interface TestRule extends IndexedRule {
  readonly id: number
}

function rule(
  id: number,
  spec: {
    urlFilter?: string
    regexFilter?: string
    requestDomains?: string[]
    initiatorDomains?: string[]
    resourceTypes?: ResourceType[]
    allowAll?: boolean
  }
): TestRule {
  let selector: UrlSelector = EVERY_URL
  if (spec.regexFilter !== undefined) selector = regexSelector(spec.regexFilter)
  else if (spec.urlFilter !== undefined) selector = urlFilterSelector(spec.urlFilter, false)
  return {
    id,
    allowAll: spec.allowAll === true,
    requestDomains: spec.requestDomains ? new Set(spec.requestDomains) : null,
    initiatorDomains: spec.initiatorDomains ? new Set(spec.initiatorDomains) : null,
    resourceTypes: spec.resourceTypes ? new Set(spec.resourceTypes) : null,
    selector
  }
}

function lookup(url: string, type: ResourceType, initiator?: string): IndexLookup {
  const host = new URL(url).hostname
  const initiatorHost = initiator ? new URL(initiator).hostname : ''
  const lower = url.toLowerCase()
  return {
    type,
    hostSuffixes: hostSuffixes(host),
    initiatorSuffixes: initiatorHost ? hostSuffixes(initiatorHost) : [],
    tokens: () => tokenize(lower)
  }
}

function candidates(index: RuleIndex<TestRule>, look: IndexLookup): number[] {
  const out = new Set<number>()
  index.forEachCandidate(look, (r) => out.add(r.id))
  return [...out].sort((a, b) => a - b)
}

const RULES: TestRule[] = [
  rule(1, { urlFilter: '||ads.example^' }),
  rule(2, { requestDomains: ['tracker.example', 'pixel.example'] }),
  rule(3, { initiatorDomains: ['news.example'] }),
  rule(4, { urlFilter: '/banner/*.js' }),
  rule(5, { regexFilter: '^[a-z]+://cdn\\.example/lib\\.?js' }),
  rule(6, { urlFilter: '*', resourceTypes: ['ping'] }),
  rule(7, { regexFilter: 'banner\\.js$', resourceTypes: ['script', 'image'] }),
  rule(8, { resourceTypes: ['csp_report'] }),
  rule(9, { urlFilter: '|https://news.example/', allowAll: true, resourceTypes: ['main_frame'] }),
  rule(10, { urlFilter: '||ads.example^', initiatorDomains: ['shop.example'] }),
  rule(11, { urlFilter: '/banner/', requestDomains: ['static.example'] })
]

describe('RuleIndex', () => {
  const index = RuleIndex.build(RULES)

  it('files each rule under its hostname, domains, rarest token or the wildcard list', () => {
    // 1 and 10 under `ads.example`; 2 under its two domains: four hostnames.
    expect(index.hostCount).toBe(3)
    expect(index.initiatorCount).toBe(1)
    // 4 (`banner`), 5 (`cdn`, `example`), 11 (`banner`) are token-indexed; 5 sits under `cdn`, its
    // rarest token here (`https` would be no better than `cdn` in this set, so it names none).
    expect(index.tokenIndexedCount).toBe(3)
    // 6 (`*`), 7 (a regex with no complete token) and 8 (type only) have nothing to index them by.
    expect(index.wildcardCount).toBe(3)
    expect(index.allowAll.map((r) => r.id)).toEqual([9])
  })

  it('visits the ||host^ and requestDomains rules of the host and its parent domains', () => {
    // 5 comes along through the `cdn` token: the index says "may match", the condition decides.
    expect(candidates(index, lookup('https://cdn.ads.example/x.png', 'image'))).toEqual([
      1, 5, 7, 10
    ])
    expect(candidates(index, lookup('https://www.ads.example/x.png', 'image'))).toEqual([1, 7, 10])
    expect(candidates(index, lookup('https://a.pixel.example/x.png', 'image'))).toEqual([2, 7])
    expect(candidates(index, lookup('https://notads.example/x.png', 'image'))).toEqual([7])
  })

  it('visits initiator-only rules for the document host, and wildcard groups only for their types', () => {
    expect(
      candidates(index, lookup('https://x.example/a.css', 'stylesheet', 'https://m.news.example/'))
    ).toEqual([3])
    expect(candidates(index, lookup('https://x.example/a.css', 'stylesheet'))).toEqual([])
    expect(candidates(index, lookup('https://x.example/p', 'ping'))).toEqual([6])
    expect(candidates(index, lookup('https://x.example/r', 'csp_report'))).toEqual([8])
    expect(candidates(index, lookup('https://x.example/a.js', 'script'))).toEqual([7])
  })

  it('visits token-indexed rules through the tokens of the lowercased URL', () => {
    expect(candidates(index, lookup('https://x.example/Banner/ad.js', 'script'))).toEqual([
      4, 7, 11
    ])
    expect(candidates(index, lookup('https://cdn.example/libjs', 'script'))).toEqual([5, 7])
    expect(candidates(index, lookup('https://cdn.example/other.js', 'script'))).toEqual([5, 7])
    expect(candidates(index, lookup('https://static.example/other.js', 'script'))).toEqual([7])
  })

  it('is the same index whether built at once or a rule at a time', () => {
    const builder = new RuleIndexBuilder(RULES)
    let steps = 0
    while (!builder.step(1)) steps++
    const sliced = builder.result
    expect(sliced).not.toBeNull()
    // One rule per classify step and one per bucket step, plus the phase changes.
    expect(steps).toBeGreaterThanOrEqual(RULES.length)
    expect(sliced!.hostCount).toBe(index.hostCount)
    expect(sliced!.tokenIndexedCount).toBe(index.tokenIndexedCount)
    expect(sliced!.wildcardCount).toBe(index.wildcardCount)
    for (const look of [
      lookup('https://cdn.ads.example/x.png', 'image'),
      lookup('https://x.example/Banner/ad.js', 'script', 'https://news.example/'),
      lookup('https://x.example/p', 'ping')
    ]) {
      expect(candidates(sliced!, look)).toEqual(candidates(index, look))
    }
    // Stepping a finished builder stays finished.
    expect(builder.step(1)).toBe(true)
    expect(builder.result).toBe(sliced)
  })

  it('an empty set indexes to nothing', () => {
    const empty = RuleIndex.build([])
    expect(
      empty.hostCount + empty.initiatorCount + empty.tokenIndexedCount + empty.wildcardCount
    ).toBe(0)
    expect(candidates(empty, lookup('https://x.example/', 'main_frame'))).toEqual([])
  })
})
