import { describe, expect, test } from 'vitest'
import {
  applyRegexSubstitution,
  applyUrlTransform,
  compareMatches,
  decisionOf,
  domainIs,
  fromEngineRequest,
  hostMatchesDomainLists,
  isSeparator,
  matchRequest,
  matchesUrlFilter,
  redirectTargetFor,
  registrableDomain,
  rulesetRank,
  toEngineRequest,
  type MatcherRuleset,
  type MatchRequest
} from '../matcher'
import type { Rule, RulesetSource } from '../rules'
import type { EngineDecision } from '../sink'
import { EXTENSION_ID, compileAll, rule } from './fixtures'

// ---------------------------------------------------------------------------------------------
// urlFilter (url_pattern.cc)

describe('matchesUrlFilter', () => {
  const cases: [string, string, boolean][] = [
    // Chrome's documentation table.
    ['abc', 'https://abcd.com/', true],
    ['abc', 'https://example.com/abcd', true],
    ['abc', 'https://ab.com/', false],
    ['abc*d', 'https://abcd.com/', true],
    ['abc*d', 'https://example.com/abcxyzd', true],
    ['abc*d', 'https://abc.com/', false],
    ['||a.example.com', 'https://a.example.com/', true],
    ['||a.example.com', 'https://b.a.example.com/xyz', true],
    ['||a.example.com', 'https://example.com/', false],
    ['|https*', 'https://example.com/', true],
    ['|https*', 'http://example.com/', false],
    ['|https*', 'http://https.com/', false],
    ['example*^123|', 'https://example.com/123', true],
    ['example*^123|', 'http://abc.com/example?123', true],
    ['example*^123|', 'https://example.com/1234', false],
    ['example*^123|', 'https://abc.com/example0123', false],
    // Separator placeholder.
    ['^a^', 'http://example.com/a', true],
    ['^a^', 'http://example.com/a/', true],
    ['^a^', 'http://example.com/ab', false],
    ['^', 'http://example.com/', true],
    ['example.com^', 'http://example.com:8080/', true],
    ['||example.com^', 'http://example.com.evil.com/', false],
    ['||example.com^', 'http://www.example.com/x', true],
    ['||example.com^', 'http://notexample.com/', false],
    ['||example.com^', 'http://example.com/', true],
    // Boundary anchors.
    ['|http://ex', 'http://example.com/', true],
    ['|https://ex', 'http://example.com/', false],
    ['example.com/|', 'http://example.com/', true],
    ['example.com|', 'http://example.com/', false],
    ['|http://example.com/|', 'http://example.com/', true],
    ['|http://example.com|', 'http://example.com/', false],
    // Wildcards.
    ['*', 'http://example.com/', true],
    ['ex*com', 'http://example.com/', true],
    ['ex*xyz', 'http://example.com/', false],
    ['*.js', 'http://example.com/a.js', true],
    ['*.js|', 'http://example.com/a.js?x', false],
    ['/a/*/c/', 'http://example.com/a/b/c/', true],
    ['/a/*/c/', 'http://example.com/a/c/', false],
    // Subdomain anchor with wildcards and a path.
    ['||example.com/*.png', 'http://cdn.example.com/img/x.png', true],
    ['||example.com/*.png', 'http://cdn.example.com/img/x.jpg', false],
    // Case: patterns are matched against the lower-cased URL.
    ['EXAMPLE', 'http://example.com/', true],
    ['/Path', 'http://example.com/path', true],
    // Host anchor never matches inside the path.
    ['||example.com', 'http://other.com/example.com', false],
    // Scheme-less host match on a URL with credentials.
    ['||example.com^', 'http://user:pw@example.com/', true]
  ]

  test.each(cases)('%s vs %s -> %s', (filter, url, expected) => {
    expect(matchesUrlFilter(url, filter)).toBe(expected)
  })

  test('case sensitive filters match the raw spec', () => {
    expect(matchesUrlFilter('http://example.com/Path', '/Path', true)).toBe(true)
    expect(matchesUrlFilter('http://example.com/path', '/Path', true)).toBe(false)
  })

  test('isSeparator matches Chrome: anything but letters, digits, _ - . %', () => {
    for (const c of ['/', '?', ':', '=', '&', ';']) expect(isSeparator(c)).toBe(true)
    for (const c of ['a', 'Z', '0', '_', '-', '.', '%']) expect(isSeparator(c)).toBe(false)
  })

  test('invalid URLs never match', () => {
    expect(matchesUrlFilter('not a url', '*')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Domain lists (url_pattern_index.cc)

describe('domain lists', () => {
  test('domainIs is the host or a subdomain of it', () => {
    expect(domainIs('example.com', 'example.com')).toBe(true)
    expect(domainIs('a.example.com', 'example.com')).toBe(true)
    expect(domainIs('notexample.com', 'example.com')).toBe(false)
    expect(domainIs('example.com.', 'example.com')).toBe(true)
    expect(domainIs('', 'example.com')).toBe(false)
  })

  test('the longest matching entry decides between included and excluded', () => {
    expect(hostMatchesDomainLists('a.example.com', ['example.com'], [])).toBe(true)
    expect(hostMatchesDomainLists('other.com', ['example.com'], [])).toBe(false)
    expect(hostMatchesDomainLists('b.a.example.com', ['example.com'], ['a.example.com'])).toBe(
      false
    )
    expect(hostMatchesDomainLists('c.example.com', ['example.com'], ['a.example.com'])).toBe(true)
    expect(hostMatchesDomainLists('x.a.example.com', ['a.example.com'], ['example.com'])).toBe(true)
    expect(hostMatchesDomainLists('example.com', [], ['example.com'])).toBe(false)
    expect(hostMatchesDomainLists('other.com', [], ['example.com'])).toBe(true)
    expect(hostMatchesDomainLists('anything', [], [])).toBe(true)
  })

  test('registrable domain heuristic', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('user.github.io')).toBe('user.github.io')
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableDomain('localhost')).toBe('localhost')
  })
})

// ---------------------------------------------------------------------------------------------
// Request evaluation and precedence

function ruleset(
  id: string,
  source: RulesetSource,
  rules: Rule[],
  extra: Partial<MatcherRuleset> = {}
): MatcherRuleset {
  return { id, source, rules: compileAll(rules, source), ...extra }
}

function matched(rulesets: MatcherRuleset[], request: MatchRequest): string[] {
  const outcome = matchRequest(rulesets, request)
  if (!outcome) throw new Error('invalid request')
  return outcome.matchedRules.map((m) => `${m.rulesetId}:${m.ruleId}`)
}

const SCRIPT: MatchRequest = {
  url: 'https://cdn.example.com/a.js',
  initiator: 'https://example.com',
  type: 'script'
}

describe('precedence inside an extension', () => {
  test('the higher rule priority wins regardless of action type', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'allow' }, { urlFilter: 'a.js' }, 1),
      rule(2, { type: 'block' }, { urlFilter: 'a.js' }, 2)
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:2'])
  })

  test('at equal priority: allow > allowAllRequests > block > upgradeScheme > redirect', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'redirect', redirect: { url: 'https://x.test/' } }, { urlFilter: 'a.js' }),
      rule(2, { type: 'upgradeScheme' }, { urlFilter: 'a.js' }),
      rule(3, { type: 'block' }, { urlFilter: 'a.js' }),
      rule(4, { type: 'allow' }, { urlFilter: 'a.js' })
    ])
    const http = { ...SCRIPT, url: 'http://cdn.example.com/a.js' }
    expect(matched([rs], http)).toEqual(['r:4'])
    expect(
      matched(
        [
          ruleset(
            'r',
            'static',
            rs.rules.slice(0, 3).map((c) => c.rule)
          )
        ],
        http
      )
    ).toEqual(['r:3'])
    expect(
      matched(
        [
          ruleset(
            'r',
            'static',
            rs.rules.slice(0, 2).map((c) => c.rule)
          )
        ],
        http
      )
    ).toEqual(['r:2'])
    expect(
      matched(
        [
          ruleset(
            'r',
            'static',
            rs.rules.slice(0, 1).map((c) => c.rule)
          )
        ],
        http
      )
    ).toEqual(['r:1'])
  })

  test('a full tie goes to the greater rule id within a ruleset', () => {
    const rs = ruleset('r', 'static', [
      rule(7, { type: 'block' }, { urlFilter: 'a.js' }),
      rule(3, { type: 'block' }, { urlFilter: 'a.js' })
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:7'])
  })

  test('a full tie across rulesets follows Chrome ruleset ids: static (manifest order) > dynamic > session', () => {
    const block = (id: number): Rule => rule(id, { type: 'block' }, { urlFilter: 'a.js' })
    const first = ruleset('first', 'static', [block(1)], { manifestIndex: 0 })
    const second = ruleset('second', 'static', [block(1)], { manifestIndex: 1 })
    const dynamic = ruleset('_dynamic', 'dynamic', [block(1)])
    const session = ruleset('_session', 'session', [block(1)])
    expect(matched([session, dynamic, first, second], SCRIPT)).toEqual(['second:1'])
    expect(matched([session, dynamic, first], SCRIPT)).toEqual(['first:1'])
    expect(matched([session, dynamic], SCRIPT)).toEqual(['_dynamic:1'])
    expect(matched([session], SCRIPT)).toEqual(['_session:1'])
    expect(rulesetRank('static', 3)).toBeGreaterThan(rulesetRank('static', 0))
    expect(rulesetRank('static', 0)).toBeGreaterThan(rulesetRank('dynamic'))
    expect(rulesetRank('dynamic')).toBeGreaterThan(rulesetRank('session'))
  })

  test('a session rule with a higher priority still beats static rules', () => {
    const stat = ruleset('r', 'static', [rule(1, { type: 'block' }, { urlFilter: 'a.js' })])
    const session = ruleset('_session', 'session', [
      rule(1, { type: 'allow' }, { urlFilter: 'a.js' }, 5)
    ])
    expect(matched([stat, session], SCRIPT)).toEqual(['_session:1'])
  })

  test('compareMatches orders by index priority, ruleset, rule id', () => {
    const a = ruleset('a', 'static', [rule(1, { type: 'block' }, { urlFilter: 'x' }, 2)], {
      manifestIndex: 0
    })
    const b = ruleset('b', 'static', [rule(9, { type: 'allow' }, { urlFilter: 'x' }, 1)], {
      manifestIndex: 1
    })
    expect(
      compareMatches({ rule: a.rules[0]!, ruleset: a }, { rule: b.rules[0]!, ruleset: b })
    ).toBeGreaterThan(0)
  })

  test('disabled static rules do not match', () => {
    const rs = ruleset('r', 'static', [rule(1, { type: 'block' }, { urlFilter: 'a.js' })], {
      disabledRuleIds: new Set([1])
    })
    expect(matched([rs], SCRIPT)).toEqual([])
  })
})

describe('modifyHeaders', () => {
  const headers = (id: number, priority: number, header: string): Rule =>
    rule(
      id,
      { type: 'modifyHeaders', requestHeaders: [{ header, operation: 'set', value: 'v' }] },
      { urlFilter: 'a.js' },
      priority
    )

  test('all matching header rules apply, highest priority first', () => {
    const rs = ruleset('r', 'static', [
      headers(1, 1, 'x-a'),
      headers(2, 3, 'x-b'),
      headers(3, 2, 'x-c')
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:2', 'r:3', 'r:1'])
  })

  test('only header rules above the winning allow rule apply; none leaves the allow rule', () => {
    const rs = ruleset('r', 'static', [
      rule(10, { type: 'allow' }, { urlFilter: 'a.js' }, 2),
      headers(1, 1, 'x-a'),
      headers(2, 2, 'x-b'),
      headers(3, 3, 'x-c')
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:3'])
    const onlyLow = ruleset('r', 'static', [
      rule(10, { type: 'allow' }, { urlFilter: 'a.js' }, 2),
      headers(1, 1, 'x-a')
    ])
    expect(matched([onlyLow], SCRIPT)).toEqual(['r:10'])
  })

  test('a block rule wins over header rules', () => {
    const rs = ruleset('r', 'static', [
      rule(10, { type: 'block' }, { urlFilter: 'a.js' }),
      headers(1, 5, 'x-a')
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:10'])
  })

  test('header rules from several rulesets merge in priority order', () => {
    const a = ruleset('a', 'static', [headers(1, 1, 'x-a')], { manifestIndex: 0 })
    const dyn = ruleset('_dynamic', 'dynamic', [headers(1, 1, 'x-b'), headers(2, 4, 'x-c')])
    expect(matched([a, dyn], SCRIPT)).toEqual(['_dynamic:2', 'a:1', '_dynamic:1'])
  })
})

describe('conditions', () => {
  test('resource types, excluded resource types', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { urlFilter: 'a', resourceTypes: ['image'] }),
      rule(2, { type: 'block' }, { urlFilter: 'b', excludedResourceTypes: ['script'] })
    ])
    expect(matched([rs], { url: 'https://x.test/a', type: 'image' })).toEqual(['r:1'])
    expect(matched([rs], { url: 'https://x.test/a', type: 'script' })).toEqual([])
    expect(matched([rs], { url: 'https://x.test/b', type: 'script' })).toEqual([])
    expect(matched([rs], { url: 'https://x.test/b', type: 'font' })).toEqual(['r:2'])
  })

  test('request methods; rules naming methods skip non-HTTP requests', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { urlFilter: 'x.test', requestMethods: ['post'] }),
      rule(2, { type: 'block' }, { urlFilter: 'x.test', excludedRequestMethods: ['get'] }, 2)
    ])
    expect(
      matched([rs], { url: 'https://x.test/', type: 'xmlhttprequest', method: 'post' })
    ).toEqual(['r:2'])
    expect(matched([rs], { url: 'https://x.test/', type: 'xmlhttprequest' })).toEqual([])
    expect(
      matched([rs], { url: 'https://x.test/', type: 'xmlhttprequest', method: 'PUT' })
    ).toEqual(['r:2'])
    expect(matched([rs], { url: 'wss://x.test/', type: 'websocket' })).toEqual(['r:2'])
    const only = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { urlFilter: 'x.test', requestMethods: ['get'] })
    ])
    expect(matched([only], { url: 'wss://x.test/', type: 'websocket' })).toEqual([])
  })

  test('initiator and request domains, with an opaque or missing initiator', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { initiatorDomains: ['example.com'] }),
      rule(
        2,
        { type: 'block' },
        { requestDomains: ['cdn.test'], excludedInitiatorDomains: ['example.com'] }
      )
    ])
    expect(
      matched([rs], {
        url: 'https://cdn.test/',
        type: 'image',
        initiator: 'https://www.example.com'
      })
    ).toEqual(['r:1'])
    expect(
      matched([rs], { url: 'https://cdn.test/', type: 'image', initiator: 'https://other.test' })
    ).toEqual(['r:2'])
    expect(matched([rs], { url: 'https://cdn.test/', type: 'image' })).toEqual(['r:2'])
    expect(matched([rs], { url: 'https://cdn.test/', type: 'image', initiator: 'null' })).toEqual([
      'r:2'
    ])
    expect(
      matched([rs], { url: 'https://cdn.test/', type: 'image', initiator: 'data:text/html,x' })
    ).toEqual(['r:2'])
  })

  test('domainType uses the registrable domain; no initiator is third party', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { domainType: 'thirdParty' }),
      rule(2, { type: 'allow' }, { domainType: 'firstParty' })
    ])
    expect(
      matched([rs], {
        url: 'https://cdn.example.com/',
        type: 'image',
        initiator: 'https://www.example.com'
      })
    ).toEqual(['r:2'])
    expect(
      matched([rs], {
        url: 'https://cdn.example.com/',
        type: 'image',
        initiator: 'https://other.test'
      })
    ).toEqual(['r:1'])
    expect(matched([rs], { url: 'https://cdn.example.com/', type: 'image' })).toEqual(['r:1'])
  })

  test('tabIds on session rules; -1 is the tab of requests without a tab', () => {
    const rs = ruleset('_session', 'session', [
      rule(1, { type: 'block' }, { tabIds: [5] }),
      rule(2, { type: 'block' }, { excludedTabIds: [5, -1] }, 1)
    ])
    expect(matched([rs], { url: 'https://x.test/', type: 'image', tabId: 5 })).toEqual([
      '_session:1'
    ])
    expect(matched([rs], { url: 'https://x.test/', type: 'image', tabId: 6 })).toEqual([
      '_session:2'
    ])
    expect(matched([rs], { url: 'https://x.test/', type: 'image' })).toEqual([])
  })

  test('rules without resourceTypes match every type except main_frame', () => {
    const rs = ruleset('r', 'static', [rule(1, { type: 'block' }, { urlFilter: 'x.test' })])
    expect(matched([rs], { url: 'https://x.test/', type: 'main_frame' })).toEqual([])
    expect(matched([rs], { url: 'https://x.test/', type: 'sub_frame' })).toEqual(['r:1'])
    expect(matched([rs], { url: 'https://x.test/', type: 'image' })).toEqual(['r:1'])
  })

  test('upgradeScheme only matches http and ftp', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'upgradeScheme' }, { urlFilter: 'x.test', resourceTypes: ['main_frame'] })
    ])
    expect(matched([rs], { url: 'http://x.test/', type: 'main_frame' })).toEqual(['r:1'])
    expect(matched([rs], { url: 'ftp://x.test/', type: 'main_frame' })).toEqual(['r:1'])
    expect(matched([rs], { url: 'https://x.test/', type: 'main_frame' })).toEqual([])
  })

  test('allowAllRequests matches the frame request itself', () => {
    const rs = ruleset('r', 'static', [
      rule(
        1,
        { type: 'allowAllRequests' },
        { urlFilter: '||example.com/app', resourceTypes: ['main_frame'] }
      ),
      rule(2, { type: 'block' }, { urlFilter: 'example.com', resourceTypes: ['main_frame'] })
    ])
    expect(matched([rs], { url: 'https://example.com/app', type: 'main_frame' })).toEqual(['r:1'])
    expect(matched([rs], { url: 'https://example.com/other', type: 'main_frame' })).toEqual(['r:2'])
  })

  test('topDomains match the top-level frame, falling back to the initiator', () => {
    const rs = ruleset('r', 'static', [rule(1, { type: 'block' }, { topDomains: ['news.test'] })])
    expect(
      matched([rs], {
        url: 'https://ad.test/',
        type: 'image',
        initiator: 'https://widget.test',
        topUrl: 'https://www.news.test/a'
      })
    ).toEqual(['r:1'])
    expect(
      matched([rs], { url: 'https://ad.test/', type: 'image', initiator: 'https://news.test' })
    ).toEqual(['r:1'])
    expect(
      matched([rs], { url: 'https://ad.test/', type: 'image', initiator: 'https://other.test' })
    ).toEqual([])
  })

  test('regexFilter rules match the whole spec, case-insensitive by default', () => {
    const rs = ruleset('r', 'static', [
      rule(1, { type: 'block' }, { regexFilter: '^https://[a-z]+\\.example\\.com/(ads|track)/' }),
      rule(2, { type: 'block' }, { regexFilter: 'PIXEL', isUrlFilterCaseSensitive: true })
    ])
    expect(matched([rs], { url: 'https://cdn.example.com/ads/x.js', type: 'script' })).toEqual([
      'r:1'
    ])
    expect(matched([rs], { url: 'https://cdn.example.com/ADS/x.js', type: 'script' })).toEqual([
      'r:1'
    ])
    expect(matched([rs], { url: 'https://cdn.example.com/pixel', type: 'script' })).toEqual([])
    expect(matched([rs], { url: 'https://cdn.example.com/PIXEL', type: 'script' })).toEqual(['r:2'])
  })
})

describe('response header stage', () => {
  const rs = ruleset('r', 'static', [
    rule(1, { type: 'block' }, { urlFilter: 'x.test', responseHeaders: [{ header: 'x-ads' }] }),
    rule(
      2,
      { type: 'block' },
      {
        urlFilter: 'x.test',
        responseHeaders: [
          { header: 'content-type', values: ['text/*'], excludedValues: ['text/plain'] }
        ]
      },
      2
    ),
    rule(
      3,
      { type: 'allow' },
      { urlFilter: 'x.test', excludedResponseHeaders: [{ header: 'x-keep' }] },
      3
    ),
    rule(4, { type: 'block' }, { urlFilter: 'x.test/before' })
  ])
  const req = (headers?: Record<string, string[]>, path = ''): MatchRequest => ({
    url: `https://x.test/${path}`,
    type: 'image',
    responseHeaders: headers
  })

  test('header rules are skipped without response headers', () => {
    expect(matched([rs], req())).toEqual([])
    expect(matched([rs], req(undefined, 'before'))).toEqual(['r:4'])
  })

  test('header presence and value patterns', () => {
    // `x-keep` is present so the priority-3 allow rule stays out of the way.
    const keep = { 'x-keep': ['1'] }
    expect(matched([rs], req({ ...keep, 'X-Ads': ['1'] }))).toEqual(['r:1'])
    expect(matched([rs], req({ ...keep, 'content-type': ['text/html'] }))).toEqual(['r:2'])
    expect(matched([rs], req({ ...keep, 'content-type': ['text/plain'] }))).toEqual([])
    expect(matched([rs], req({ ...keep, 'content-type': ['image/png'] }))).toEqual([])
    expect(matched([rs], req({ ...keep }))).toEqual([])
  })

  test('excluded headers: the allow rule matches when the header is absent', () => {
    expect(matched([rs], req({ 'x-ads': ['1'], 'x-other': ['1'] }))).toEqual(['r:3'])
    expect(matched([rs], req({ 'x-ads': ['1'], 'x-keep': ['1'] }))).toEqual(['r:1'])
  })

  test('a before-request block short-circuits the header stage', () => {
    expect(matched([rs], req({ 'x-ads': ['1'] }, 'before'))).toEqual(['r:4'])
  })
})

// ---------------------------------------------------------------------------------------------
// Redirect targets and the engine decision

describe('redirect targets', () => {
  test('applyRegexSubstitution follows RE2 rewrite syntax', () => {
    const re = /^https:\/\/www\.(abc|def)\.xyz\.com\/(.*)$/i
    expect(
      applyRegexSubstitution(re, 'https://www.abc.xyz.com/p?q', 'https://\\1.xyz.com/\\2')
    ).toBe('https://abc.xyz.com/p?q')
    expect(applyRegexSubstitution(re, 'https://www.abc.xyz.com/', '\\0#\\\\')).toBe(
      'https://www.abc.xyz.com/#\\'
    )
    expect(applyRegexSubstitution(re, 'https://other/', 'x')).toBeUndefined()
  })

  test('applyUrlTransform replaces and clears components', () => {
    const url = 'http://user:pw@www.example.com:8080/a/b?x=1&y=2#frag'
    expect(applyUrlTransform(url, { scheme: 'https', port: '' })).toBe(
      'https://user:pw@www.example.com/a/b?x=1&y=2#frag'
    )
    expect(applyUrlTransform(url, { host: 'new.test', path: '/', query: '', fragment: '' })).toBe(
      'http://user:pw@new.test:8080/'
    )
    expect(applyUrlTransform(url, { username: '', password: '' })).toBe(
      'http://www.example.com:8080/a/b?x=1&y=2#frag'
    )
    expect(applyUrlTransform(url, { query: '?only=1', fragment: '#top' })).toBe(
      'http://user:pw@www.example.com:8080/a/b?only=1#top'
    )
    expect(
      applyUrlTransform(url, {
        scheme: 'chrome-extension',
        host: EXTENSION_ID,
        port: '',
        username: '',
        password: ''
      })
    ).toBe(`chrome-extension://${EXTENSION_ID}/a/b?x=1&y=2#frag`)
  })

  test('queryTransform removes, replaces and adds parameters', () => {
    const url = 'https://example.com/?utm_source=a&keep=1&ref=old&utm_source=b'
    expect(
      applyUrlTransform(url, {
        queryTransform: {
          removeParams: ['utm_source'],
          addOrReplaceParams: [
            { key: 'ref', value: 'new value' },
            { key: 'added', value: '1' },
            { key: 'missing', value: 'x', replaceOnly: true }
          ]
        }
      })
    ).toBe('https://example.com/?keep=1&ref=new+value&added=1')
    expect(
      applyUrlTransform('https://example.com/?a=1', { queryTransform: { removeParams: ['a'] } })
    ).toBe('https://example.com/')
  })

  test('redirectTargetFor: fixed url, substitution, transform, and no self-redirects', () => {
    const [fixed, subst, transform, self] = compileAll([
      rule(1, { type: 'redirect', redirect: { url: 'https://target.test/' } }, { urlFilter: 'a' }),
      rule(
        2,
        { type: 'redirect', redirect: { regexSubstitution: 'https://\\1.test/' } },
        { regexFilter: '^https://(\\w+)\\.example\\.com/' }
      ),
      rule(
        3,
        { type: 'redirect', redirect: { transform: { scheme: 'https' } } },
        { urlFilter: 'a' }
      ),
      rule(
        4,
        { type: 'redirect', redirect: { url: 'https://cdn.example.com/a' } },
        { urlFilter: 'a' }
      )
    ])
    expect(redirectTargetFor(fixed!, 'http://cdn.example.com/a')).toBe('https://target.test/')
    expect(redirectTargetFor(subst!, 'https://cdn.example.com/a')).toBe('https://cdn.test/')
    expect(redirectTargetFor(subst!, 'https://other.test/')).toBeUndefined()
    expect(redirectTargetFor(transform!, 'http://cdn.example.com/a')).toBe(
      'https://cdn.example.com/a'
    )
    expect(redirectTargetFor(transform!, 'https://cdn.example.com/a')).toBeUndefined()
    expect(redirectTargetFor(self!, 'https://cdn.example.com/a')).toBeUndefined()
  })

  test('a redirect that cannot redirect the request does not match, so lower rules apply', () => {
    const rs = ruleset('r', 'static', [
      rule(
        1,
        { type: 'redirect', redirect: { url: 'https://cdn.example.com/a.js' } },
        { urlFilter: 'a.js' },
        5
      ),
      rule(2, { type: 'block' }, { urlFilter: 'a.js' })
    ])
    expect(matched([rs], SCRIPT)).toEqual(['r:2'])
  })
})

describe('engine decision', () => {
  test('decisionOf maps every action and reports the engine set id', () => {
    const rs = (rules: Rule[]): MatcherRuleset[] => [ruleset('r', 'static', rules)]
    const decide = (rules: Rule[], request: MatchRequest = SCRIPT): EngineDecision =>
      decisionOf(matchRequest(rs(rules), request)!, EXTENSION_ID)
    const setId = `ext:${EXTENSION_ID}:static:r`
    expect(decide([rule(1, { type: 'block' }, { urlFilter: 'a.js' })])).toEqual({
      action: 'block',
      matched: { setId, ruleId: 1 }
    })
    expect(decide([rule(1, { type: 'allow' }, { urlFilter: 'a.js' })])).toEqual({
      action: 'allow',
      matched: { setId, ruleId: 1 }
    })
    expect(decide([rule(1, { type: 'block' }, { urlFilter: 'nomatch' })])).toEqual({
      action: 'allow'
    })
    expect(
      decide([rule(1, { type: 'upgradeScheme' }, { urlFilter: 'a.js' })], {
        ...SCRIPT,
        url: 'http://cdn.example.com/a.js'
      })
    ).toEqual({
      action: 'upgrade',
      redirectUrl: 'https://cdn.example.com/a.js',
      matched: { setId, ruleId: 1 }
    })
    expect(
      decide([
        rule(1, { type: 'redirect', redirect: { url: 'https://t.test/' } }, { urlFilter: 'a.js' })
      ])
    ).toEqual({
      action: 'redirect',
      redirectUrl: 'https://t.test/',
      matched: { setId, ruleId: 1 }
    })
    expect(
      decide([
        rule(
          1,
          {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-a', operation: 'set', value: '1' }]
          },
          { urlFilter: 'a.js' }
        ),
        rule(
          2,
          { type: 'modifyHeaders', responseHeaders: [{ header: 'x-b', operation: 'remove' }] },
          { urlFilter: 'a.js' },
          2
        )
      ])
    ).toEqual({
      action: 'modifyHeaders',
      requestHeaders: [{ header: 'x-a', operation: 'set', value: '1' }],
      responseHeaders: [{ header: 'x-b', operation: 'remove' }],
      matched: { setId, ruleId: 2 }
    })
  })

  test('without an extension id the public ruleset id is reported', () => {
    const outcome = matchRequest(
      [ruleset('_dynamic', 'dynamic', [rule(1, { type: 'block' }, { urlFilter: 'a.js' })])],
      SCRIPT
    )!
    expect(decisionOf(outcome).matched).toEqual({ setId: '_dynamic', ruleId: 1 })
  })

  test('toEngineRequest / fromEngineRequest round trip', () => {
    const request: MatchRequest = {
      url: 'https://x.test/',
      type: 'sub_frame',
      initiator: 'https://a.test',
      method: 'post',
      tabId: 7,
      topUrl: 'https://top.test/'
    }
    const ctx = toEngineRequest(request)
    expect(ctx).toEqual({
      url: 'https://x.test/',
      type: 'sub_frame',
      initiator: 'https://a.test',
      method: 'POST',
      tabId: '7',
      documentUrl: 'https://top.test/'
    })
    expect(fromEngineRequest(ctx)).toEqual(request)
    expect(toEngineRequest({ url: 'https://x.test/', type: 'image' })).toEqual({
      url: 'https://x.test/',
      type: 'image',
      method: 'GET'
    })
    expect(
      fromEngineRequest({ url: 'https://x.test/', type: 'image', method: 'GET', tabId: 'tab-12' })
        .tabId
    ).toBe(12)
    expect(
      fromEngineRequest({ url: 'https://x.test/', type: 'image', method: 'GET', tabId: 'none' })
        .tabId
    ).toBe(-1)
  })
})
