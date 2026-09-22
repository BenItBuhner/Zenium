// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { gunzipSync } from 'node:zlib'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { describe, expect, it } from 'vitest'
import { RuleEngine, type TextMatch, type TextMatcher } from '../engine'
import { countNetworkFilters } from '../lists'
import {
  RESOURCE_TYPES,
  type Decision,
  type RequestContext,
  type ResourceType,
  type Rule,
  type RuleCondition,
  type RuleSet
} from '../rules'

/**
 * The indexed resolution (`RuleEngine.decide`) against the reference scan (`decideLinear`)
 * over what the desktop carries: the seven bundled filter lists through a Ghostery text matcher
 * shaped like the desktop's, the connectivity-probes golden fixture, two `ext:` sets shaped like
 * uBlock Origin Lite's static and dynamic rules (big `requestDomains`, `||host^`, regexes with
 * optional separators, initiator-only and excluded-only conditions, tab ids, methods, case
 * sensitivity, `|` literals, partitions, `modifyHeaders`, response header conditions), a `user`
 * set and `builtin:site-exceptions`; requests at both stages, the header stage reached directly
 * and through a request stage decision that asked for it. Every decision must be the same rule,
 * target and filter, not just the same effect: `matched` feeds `getMatchedRules` and
 * `onRuleMatchedDebug`, and two equal redirects must name the target the Kotlin engine names.
 * The port of the Kotlin engine's `IndexDifferentialTest`, which parses the header-conditioned
 * rules out instead.
 */

const LIST_DIR = new URL('../../../../resources/blocking/', import.meta.url)
const FIXTURE = new URL(
  '../../../../android/app/src/test/resources/blocking/connectivity-probes.json',
  import.meta.url
)
/** The `modifyHeaders` golden fixture both engines decide alike (the Kotlin `IndexDifferentialTest` reads the same file). */
const HEADERS_FIXTURE = new URL(
  '../../../../android/app/src/test/resources/blocking/modify-headers.json',
  import.meta.url
)

interface HeadersFixture {
  sets: RuleSet[]
  probes: Array<{
    name: string
    request: {
      url: string
      type: ResourceType
      documentUrl?: string
      method: string
      thirdParty?: boolean
      partition?: string
    }
    /** The request stage's decision, when the fixture pins it. */
    expected?: unknown
    /** The response headers the header stage is decided with, and its decision. */
    responseHeaders?: Record<string, string[]>
    expectedWithHeaders?: unknown
  }>
}

/** A decision in the fixture's shape: empty edit lists written for `modifyHeaders`, `needsHeaders` only when true. */
function fixtureShape(d: Decision): unknown {
  const out: Record<string, unknown> = { action: d.action }
  if (d.redirectUrl !== undefined) out.redirectUrl = d.redirectUrl
  if (d.matched) out.matched = d.matched
  if (d.action === 'modifyHeaders') {
    out.requestHeaders = d.requestHeaders ?? []
    out.responseHeaders = d.responseHeaders ?? []
  }
  if (d.needsHeaders) out.needsHeaders = true
  return out
}

function readGz(name: string): string {
  return gunzipSync(readFileSync(new URL(`${name}.txt.gz`, LIST_DIR))).toString('utf8')
}

/** `||host^` filters of a list, the realistic hosts the generated rules and requests draw from. */
function hostsOf(text: string, limit: number): string[] {
  const out = new Set<string>()
  const re = /^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^(\$.*)?$/
  for (const line of text.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    out.add(m[1])
    if (out.size >= limit) break
  }
  return [...out]
}

/** mulberry32: a small seeded generator so the run is reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function show(d: Decision): string {
  return `${d.action} url=${d.redirectUrl} set=${d.matched?.setId} rule=${d.matched?.ruleId} filter=${d.matched?.filter} headers=${JSON.stringify(d.requestHeaders)}/${JSON.stringify(d.responseHeaders)}`
}

function same(a: Decision, b: Decision): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function rule(
  id: number,
  action: string,
  condition: RuleCondition,
  priority = 1,
  redirect?: string
): Rule {
  const r: Rule = {
    id,
    priority,
    action: { type: action as Rule['action']['type'] },
    condition
  }
  if (redirect) r.action.redirect = { url: redirect }
  return r
}

function entry(
  id: string,
  source: RuleSet['source'],
  priority: number,
  rules: Rule[],
  partitions?: string[],
  updatedAt?: number
): RuleSet {
  const set: RuleSet = { id, source, priority, enabled: true, rules }
  if (partitions) set.partitions = partitions
  if (updatedAt) set.updatedAt = updatedAt
  return set
}

/** The desktop's text matcher over Ghostery, minus the document filters it decides itself. */
function ghosteryMatcher(texts: string[]): TextMatcher {
  const engine = FiltersEngine.parse(texts.join('\n'), { loadCosmeticFilters: false, debug: false })
  return {
    match(ctx: RequestContext): TextMatch | null {
      const result = engine.match(
        Request.fromRawDetails({
          url: ctx.url,
          sourceUrl: ctx.initiator ?? ctx.documentUrl ?? '',
          type: (ctx.type === 'webtransport' || ctx.type === 'webbundle'
            ? 'other'
            : ctx.type) as Request['type'],
          tabId: ctx.tabId ? Number(ctx.tabId.replace(/\D+/g, '')) || 0 : 0
        })
      )
      if (result.exception) return { action: 'allow', filter: result.exception.toString() }
      if (result.redirect)
        return {
          action: 'redirect',
          redirectUrl: result.redirect.dataUrl,
          filter: result.filter?.toString()
        }
      if (result.match) return { action: 'block', filter: result.filter?.toString() }
      return null
    }
  }
}

const WORDS = [
  'pixel',
  'track',
  'ad',
  'ads',
  'banner',
  'js',
  'img',
  'api',
  'beacon',
  'lib',
  'main',
  'generate_204',
  'collect',
  'stats'
]
const METHODS = ['get', 'post', 'head', 'put']
const EXT_A = 'ext:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:static:ruleset_1'
const EXT_B = 'ext:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:_dynamic'
/** Response headers a request may be decided with at the headers-received stage. */
const HEADER_SETS: ReadonlyArray<Record<string, string[]>> = [
  {},
  { 'content-type': ['text/html; charset=utf-8'] },
  { 'Content-Type': ['text/css'], 'x-frame-options': ['DENY'] },
  { 'content-type': ['image/png'], 'x-ads': ['1'] },
  { 'X-Ads': ['banner'], 'set-cookie': ['a=1'] },
  { 'x-trust': ['1'], 'content-type': ['text/html'] },
  { 'content-type': ['application/json'] }
]

/**
 * Structured sets shaped like what the runtime persists (`ext:` sets) and the builtins. Set A is
 * larger than the engine indexes inline, so it exercises the deferred build.
 */
function generatedSets(hosts: string[], random: () => number): RuleSet[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
  const int = (n: number): number => Math.floor(random() * n)
  const host = (): string => pick(hosts)
  const rx = (h: string): string => h.replace(/\./g, '\\.')
  const types = RESOURCE_TYPES

  // Set A: a uBOL-like static set: big requestDomains rule, ||host^ rules, regexes, wildcards.
  const a: Rule[] = []
  let id = 1
  a.push(
    rule(id++, 'block', {
      requestDomains: hosts.slice(0, 300),
      resourceTypes: ['script', 'image', 'xmlhttprequest', 'sub_frame', 'ping', 'other']
    })
  )
  a.push(
    rule(id++, 'block', {
      requestDomains: hosts.slice(3000, 3300),
      excludedRequestDomains: hosts.slice(3000, 3050),
      excludedInitiatorDomains: hosts.slice(0, 20)
    })
  )
  // excluded-only
  a.push(
    rule(id++, 'block', { excludedRequestDomains: hosts.slice(0, 40), resourceTypes: ['ping'] })
  )
  a.push(
    rule(id++, 'block', {
      excludedInitiatorDomains: hosts.slice(0, 40),
      resourceTypes: ['websocket', 'media']
    })
  )
  // unscoped by type; type-only
  a.push(rule(id++, 'block', { urlFilter: '*', resourceTypes: ['ping'] }))
  a.push(rule(id++, 'block', { resourceTypes: ['csp_report', 'webtransport'] }))
  a.push(
    rule(id++, 'block', {
      excludedResourceTypes: [
        'main_frame',
        'sub_frame',
        'script',
        'image',
        'stylesheet',
        'font',
        'media',
        'xmlhttprequest'
      ],
      domainType: 'thirdParty'
    })
  )
  // urlFilter with a literal `?`; regex with an optional separator
  a.push(rule(id++, 'block', { urlFilter: '/ads/?', resourceTypes: ['script'] }))
  a.push(rule(id++, 'block', { regexFilter: '/ads/?', resourceTypes: ['script'] }))
  a.push(
    rule(id++, 'block', {
      regexFilter: '\\/(track|pixel)\\/[a-z]+\\.js',
      resourceTypes: ['script']
    })
  )
  a.push(
    rule(id++, 'block', {
      regexFilter: '^https?://[^/]+/collect\\?',
      resourceTypes: ['xmlhttprequest', 'ping', 'other']
    })
  )
  a.push(rule(id++, 'block', { regexFilter: '/beacon-?[0-9]*\\.gif', resourceTypes: ['image'] }))
  a.push(
    rule(id++, 'block', {
      regexFilter: '/stats/{0,1}[a-z]+',
      excludedResourceTypes: ['main_frame']
    })
  )
  a.push(
    rule(id++, 'block', { regexFilter: '^http://[^/?#]*\\.[^/?#]*', resourceTypes: ['main_frame'] })
  )
  a.push(
    rule(id++, 'upgradeScheme', {
      regexFilter: '^http://[^/?#]*\\.[^/?#]*',
      excludedRequestDomains: ['localhost']
    })
  )
  a.push(rule(id++, 'block', { urlFilter: '||ADS.example/Banner', isUrlFilterCaseSensitive: true }))
  a.push(
    rule(id++, 'block', {
      urlFilter: '|https://',
      requestMethods: ['post'],
      resourceTypes: ['xmlhttprequest']
    })
  )
  // `|` literal inside a filter; wildcards with excludedNonUniqueHosts
  a.push(rule(id++, 'block', { urlFilter: '^track|pixel^' }))
  a.push(rule(id++, 'block', { urlFilter: '*/img/*banner*', excludedNonUniqueHosts: true }))
  // header rules, which stack in scan order; on a host the lists and the generated rules leave alone
  a.push({
    id: id++,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'x-a', operation: 'set', value: '1' }]
    },
    condition: { urlFilter: '||hdr.example^' }
  })
  a.push({
    id: id++,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'x-b', operation: 'remove' }]
    },
    condition: {
      requestDomains: ['hdr.example', 'hdr2.example'],
      resourceTypes: ['script', 'image', 'main_frame']
    }
  })
  a.push({
    id: id++,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'x-c', operation: 'append', value: 'c' }]
    },
    condition: { regexFilter: '\\.(png|gif)$' }
  })
  a.push(rule(id++, 'allow', { urlFilter: '||hdr2.example/assets/quiet^' }))
  // Header-conditioned rules, decided at the headers-received stage on the same quiet hosts: a
  // block on a marker header, Stylus's content-type redirect, an allow on everything but HTML
  // that outranks the block, response header edits stacked behind the request stage's.
  a.push(
    rule(
      id++,
      'block',
      {
        requestDomains: ['hdr.example', 'cdn.hdr.example'],
        responseHeaders: [{ header: 'x-ads' }]
      },
      2
    )
  )
  a.push(
    rule(
      id++,
      'redirect',
      {
        regexFilter: '\\.css$',
        resourceTypes: ['main_frame', 'stylesheet'],
        responseHeaders: [{ header: 'content-type', values: ['text/css*'] }]
      },
      2,
      'https://safe.example/install-usercss'
    )
  )
  a.push(
    rule(
      id++,
      'allow',
      {
        urlFilter: '||hdr2.example^',
        excludedResponseHeaders: [{ header: 'content-type', values: ['text/html*'] }]
      },
      3
    )
  )
  a.push({
    id: id++,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }]
    },
    condition: {
      requestDomains: ['hdr.example', 'hdr2.example'],
      responseHeaders: [{ header: 'x-frame-options' }]
    }
  })
  for (let i = 0; i < 2600; i++) {
    const h = host()
    const cond: RuleCondition = {}
    switch (int(12)) {
      case 0:
        cond.urlFilter = `||${h}^`
        break
      case 1:
        cond.urlFilter = `||${h}/${pick(WORDS)}`
        break
      case 2:
        cond.urlFilter = `||${h}^*${pick(WORDS)}=`
        break
      case 3:
        cond.urlFilter = `/${pick(WORDS)}/${pick(WORDS)}^`
        break
      case 4:
        cond.urlFilter = `${pick(WORDS)}.${pick(WORDS)}|`
        break
      case 5:
        cond.regexFilter = `^https?://([^/]+\\.)?${rx(h)}/`
        break
      case 6:
        // optional separator
        cond.regexFilter = `/${pick(WORDS)}/?[a-z]*\\.${pick(WORDS)}`
        break
      case 7:
        cond.initiatorDomains = [h, host()]
        break
      case 8:
        cond.requestDomains = [h, host(), host()]
        break
      case 9:
        cond.urlFilter = `|http://${h}`
        break
      case 10:
        cond.urlFilter = `||${h}^`
        cond.initiatorDomains = [host()]
        break
      default:
        cond.urlFilter = `*${pick(WORDS)}*`
    }
    if (int(3) === 0) cond.resourceTypes = [pick(types), pick(types)]
    if (int(7) === 0) cond.excludedResourceTypes = [pick(types)]
    if (int(6) === 0) cond.domainType = random() < 0.5 ? 'thirdParty' : 'firstParty'
    if (int(8) === 0) cond.requestMethods = [pick(METHODS)]
    if (int(10) === 0) cond.excludedRequestMethods = [pick(METHODS)]
    if (int(10) === 0) cond.excludedInitiatorDomains = [host()]
    if (int(10) === 0) cond.excludedRequestDomains = [host()]
    if (int(12) === 0) cond.tabIds = [7]
    if (int(12) === 0) cond.excludedNonUniqueHosts = true
    // One rule in twenty is header-conditioned, over the hosts the request stage's rules cover.
    if (i % 40 === 3) cond.responseHeaders = [{ header: 'x-ads' }]
    if (i % 40 === 23)
      cond.excludedResponseHeaders = [
        { header: 'content-type', values: ['text/html*', 'application/json'] }
      ]
    const action = pick(['block', 'block', 'block', 'allow', 'redirect', 'upgradeScheme'])
    a.push(
      rule(
        id++,
        action,
        cond,
        1 + int(3),
        action === 'redirect' ? `https://safe.example/${pick(WORDS)}/${i}` : undefined
      )
    )
  }
  // Set B: a dynamic set scoped to partitions, with allowAllRequests.
  const b: Rule[] = []
  id = 1
  for (let i = 0; i < 300; i++) {
    const h = host()
    const cond: RuleCondition = {}
    switch (int(4)) {
      case 0:
        cond.urlFilter = `||${h}^`
        break
      case 1:
        cond.urlFilter = `|https://${h}/`
        cond.resourceTypes = ['main_frame', 'sub_frame']
        break
      case 2:
        cond.requestDomains = [h]
        break
      default:
        cond.regexFilter = `^https://${rx(h)}/(ads|track)/?`
    }
    const action = pick(['allow', 'allowAllRequests', 'block', 'redirect'])
    if (action === 'allowAllRequests') cond.resourceTypes = ['main_frame', 'sub_frame']
    b.push(
      rule(
        id++,
        action,
        cond,
        1 + int(3),
        action === 'redirect' ? `https://safe.example/b/${i}` : undefined
      )
    )
  }
  // Stylus's `.user.css` install redirect, and an allowAllRequests a response header conditions
  // (which allows the frame request itself and nothing after it).
  b.push(
    rule(
      id++,
      'redirect',
      {
        regexFilter: '\\.user\\.css$',
        resourceTypes: ['main_frame'],
        responseHeaders: [{ header: 'content-type', values: ['text/css*'] }]
      },
      1,
      'https://safe.example/install-usercss'
    )
  )
  b.push(
    rule(
      id++,
      'allowAllRequests',
      {
        urlFilter: `|https://${hosts[12]}/`,
        resourceTypes: ['main_frame', 'sub_frame'],
        responseHeaders: [{ header: 'x-trust' }]
      },
      2
    )
  )
  const probes = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RuleSet
  return [
    probes,
    entry(EXT_A, 'dnr', 2999, a, ['default', 'work'], 1789633817801),
    entry(EXT_B, 'dnr', 2999, b, ['default', 'work', 'private'], 1789633817802),
    entry('user', 'user', 10, [
      rule(1, 'block', { urlFilter: `||${hosts[7]}^` }),
      rule(2, 'allow', { urlFilter: `||${hosts[0]}^` })
    ]),
    entry('builtin:site-exceptions', 'builtin', 900, [
      rule(1, 'allowAllRequests', {
        urlFilter: `|https://${hosts[11]}/`,
        resourceTypes: ['main_frame', 'sub_frame']
      })
    ])
  ]
}

/** Requests over the hosts of the lists and a few extra ones, in every shape the conditions read. */
function generatedRequests(hosts: string[], random: () => number, count: number): RequestContext[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
  const int = (n: number): number => Math.floor(random() * n)
  const words = [
    ...WORDS,
    'adsx',
    'beacon-12',
    'statsx',
    'Banner',
    'trackXpixel',
    'track|pixel',
    'libjs'
  ]
  const exts = ['js', 'png', 'gif', 'css', 'html', 'json', 'woff2', 'mp4', '', 'php']
  const partitions = ['default', 'default', 'work', 'private', undefined]
  const tabs = ['tab-7', 'tab-9', 'tab-12', undefined]
  const methods = ['GET', 'GET', 'POST', 'HEAD', 'PUT']
  const extraHosts = [
    'ads.example',
    'www.ads.example',
    'localhost',
    '127.0.0.1',
    'intranet',
    'accounts.google.com',
    'www.gstatic.com',
    'x.example',
    'cdn.x.example',
    hosts[5],
    hosts[6],
    hosts[7],
    hosts[11],
    hosts[12]
  ]
  const allHosts = [...hosts, ...extraHosts]
  const out: RequestContext[] = []
  for (let i = 0; i < count; i++) {
    // One request in ten goes to a host the lists and the generated rules leave alone, on a
    // path without their words: what the header rules and the plain allow decide.
    const quiet = int(10) === 0
    const h = quiet
      ? pick(['hdr.example', 'hdr2.example', 'cdn.hdr.example'])
      : int(4) === 0
        ? pick(extraHosts)
        : pick(allHosts)
    const scheme = int(5) === 0 ? 'http' : 'https'
    const ext = pick(exts)
    const path = quiet
      ? `/assets/${pick(['static', 'quiet', 'style'])}${ext ? `.${ext}` : ''}`
      : `/${pick(words)}/${pick(words)}` +
        (random() < 0.5 ? `/${pick(words)}` : '') +
        (ext ? `.${ext}` : '') +
        (int(3) === 0 ? `?x=${int(9)}&id=${int(99)}` : '')
    const navigation = int(7) === 0
    const type: ResourceType = navigation ? 'main_frame' : pick(RESOURCE_TYPES)
    let doc: string | undefined
    if (!navigation && int(5) !== 0) {
      doc =
        int(3) === 0 ? `https://${h}/${pick(words)}` : `https://${pick(allHosts)}/${pick(words)}`
    }
    const ctx: RequestContext = { url: `${scheme}://${h}${path}`, type, method: pick(methods) }
    if (doc) {
      ctx.initiator = doc
      ctx.documentUrl = doc
    }
    const tab = pick(tabs)
    if (tab) {
      ctx.tabId = tab
      ctx.chromeTabId = Number(tab.slice(4))
    }
    const partition = pick(partitions)
    if (partition) ctx.partition = partition
    // One request in four arrives at the headers-received stage directly.
    if (int(4) === 0) ctx.responseHeaders = pick(HEADER_SETS)
    out.push(ctx)
  }
  return out
}

interface Tally {
  total: number
  decidedByRule: number
  redirected: number
  headers: number
  byText: number
  /** Request stage decisions a header-conditioned rule may still overturn. */
  needsHeaders: number
  /** Header stage decisions by a named rule. */
  headerStage: number
  mismatches: string[]
}

function compare(engine: RuleEngine, requests: readonly RequestContext[]): Tally {
  const tally: Tally = {
    total: 0,
    decidedByRule: 0,
    redirected: 0,
    headers: 0,
    byText: 0,
    needsHeaders: 0,
    headerStage: 0,
    mismatches: []
  }
  const check = (ctx: RequestContext, indexed: Decision, linear: Decision): void => {
    tally.total++
    if (linear.matched?.ruleId !== undefined) tally.decidedByRule++
    if (linear.matched?.setId === 'filter-text') tally.byText++
    if (linear.redirectUrl !== undefined) tally.redirected++
    if (linear.action === 'modifyHeaders') tally.headers++
    if (ctx.responseHeaders && linear.matched?.ruleId !== undefined) tally.headerStage++
    if (!same(indexed, linear) && tally.mismatches.length < 40) {
      tally.mismatches.push(
        `${ctx.url} type=${ctx.type} doc=${ctx.documentUrl} method=${ctx.method} tab=${ctx.tabId} partition=${ctx.partition} headers=${JSON.stringify(ctx.responseHeaders)}\n    index : ${show(indexed)}\n    linear: ${show(linear)}`
      )
    }
  }
  for (const ctx of requests) {
    const linear = engine.decideLinear(ctx)
    check(ctx, engine.decide(ctx), linear)
    if (!linear.needsHeaders) continue
    // The host's second decision for a request the first one only noted a header rule for.
    tally.needsHeaders++
    const late = { ...ctx, responseHeaders: HEADER_SETS[tally.total % HEADER_SETS.length] }
    check(late, engine.decide(late), engine.decideLinear(late))
  }
  return tally
}

describe('RuleEngine.decide against decideLinear', () => {
  it('agrees over the bundled lists, the golden fixture and generated sets, before and after the deferred index', () => {
    const texts = [
      'easylist',
      'easyprivacy',
      'peter-lowe',
      'ubo-filters',
      'ubo-privacy',
      'ubo-badware',
      'urlhaus'
    ].map(readGz)
    const listHosts = [
      ...new Set([
        ...hostsOf(texts[1], 4000),
        ...hostsOf(texts[0], 2000),
        ...hostsOf(texts[2], 1500)
      ])
    ]
    expect(listHosts.length, 'hosts from the lists').toBeGreaterThan(5000)
    expect(
      texts.reduce((n, t) => n + countNetworkFilters(t), 0),
      'filters loaded'
    ).toBeGreaterThan(50_000)
    const random = seeded(164)
    const sets = generatedSets(listHosts, random)
    const declared = sets.reduce((n, s) => n + (s.rules?.length ?? 0), 0)

    const engine = new RuleEngine()
    engine.setTextMatcher(ghosteryMatcher(texts))
    for (const set of sets) engine.setRuleSet(set)
    const compiled = engine.listRuleSets().reduce((n, s) => n + s.ruleCount, 0)
    expect(compiled, 'every declared rule compiled').toBe(declared)

    const requests = generatedRequests(listHosts, random, 8_000)

    // Nothing is indexed until the engine decides; then the small sets are indexed on the spot
    // and set A, over the inline limit, is queued for the sliced build and scanned meanwhile.
    expect(engine.indexOf(EXT_A)).toBeNull()
    const beforeBuild = compare(engine, requests.slice(0, 2_000))
    expect(engine.indexOf(EXT_A), 'set A still awaits its build').toBeNull()
    expect(engine.indexOf(EXT_B), 'set B indexed inline').not.toBeNull()
    expect(
      beforeBuild.mismatches,
      'mismatches before the build:\n' + beforeBuild.mismatches.join('\n')
    ).toEqual([])

    engine.buildIndexes()
    const indexA = engine.indexOf(EXT_A)
    expect(indexA).not.toBeNull()
    expect(indexA!.hostCount, 'hosts indexed in set A').toBeGreaterThan(500)
    expect(indexA!.tokenIndexedCount, 'token-indexed rules in set A').toBeGreaterThan(500)
    expect(indexA!.wildcardCount, 'wildcard rules in set A').toBeGreaterThan(100)
    expect(indexA!.wildcardCount, 'most of set A is indexed').toBeLessThan(600)

    const after = compare(engine, requests)
    expect(
      after.decidedByRule,
      `decided something: ${after.decidedByRule} of ${after.total}`
    ).toBeGreaterThan(400)
    expect(after.byText, `decided by the lists: ${after.byText}`).toBeGreaterThan(100)
    expect(after.redirected, `redirected something: ${after.redirected}`).toBeGreaterThan(20)
    expect(after.headers, `header rules applied: ${after.headers}`).toBeGreaterThan(10)
    expect(after.needsHeaders, `decided twice: ${after.needsHeaders}`).toBeGreaterThan(20)
    expect(after.headerStage, `decided at the header stage: ${after.headerStage}`).toBeGreaterThan(
      20
    )
    expect(after.mismatches, 'mismatches:\n' + after.mismatches.join('\n')).toEqual([])
  }, 60_000)

  /**
   * A literal separator the expression may leave out (a slash followed by `?`, `*` or `{0,1}`,
   * an escaped dot followed by `?`) is no token boundary: the URL's token runs on (`/adsx`), and
   * a rule indexed under the shorter token would never be visited for it.
   */
  it('finds a regex whose separator is optional for the longer token', () => {
    const cases: [string[], string][] = [
      [['/ads/?'], 'https://x.example/adsx'],
      [['\\/ads\\/?'], 'https://x.example/adsx.js'],
      [['/ads/*'], 'https://x.example/adsfoo'],
      [['/ads/{0,1}'], 'https://x.example/adsfoo'],
      [['/beacon-?[0-9]*\\.gif'], 'https://x.example/beacon12.gif'],
      [
        ['^https://cdn\\.example/lib\\.?js', '^https://cdn\\.example/other'],
        'https://cdn.example/libjs'
      ]
    ]
    const failures: string[] = []
    for (const [regexes, url] of cases) {
      const engine = new RuleEngine()
      engine.setRuleSet(
        entry(
          'ext:x:_session',
          'dnr',
          2999,
          regexes.map((r, i) => rule(i + 1, 'block', { regexFilter: r }))
        )
      )
      const ctx: RequestContext = {
        url,
        type: 'script',
        method: 'GET',
        initiator: 'https://news.example/',
        partition: 'default'
      }
      const linear = engine.decideLinear(ctx)
      const indexed = engine.decide(ctx)
      expect(linear.action, `the scan blocks ${url} by ${regexes[0]}`).toBe('block')
      if (!same(indexed, linear))
        failures.push(
          `regexFilter ${regexes[0]} vs ${url}: index=${show(indexed)} linear=${show(linear)}`
        )
    }
    expect(failures).toEqual([])
  })

  /**
   * On equal effective priority and action the first rule in the set's order wins, however the
   * index reaches it: the linear scan meets it first, so `matched` and a redirect's target agree
   * with the scan and with the Kotlin engine.
   */
  it('gives a full tie to the rule the scan meets first', () => {
    // Reached through the wildcard list (a regex with no complete token), the host map and a
    // token bucket respectively – the index visits them in the reverse of their positions.
    const rules: Rule[] = [
      rule(10, 'redirect', { regexFilter: 'banner\\.js$' }, 1, 'https://safe.example/wildcard'),
      rule(11, 'redirect', { urlFilter: '||ads.example^' }, 1, 'https://safe.example/host'),
      rule(12, 'redirect', { urlFilter: '/banner.js' }, 1, 'https://safe.example/token'),
      rule(13, 'block', { urlFilter: '||ads.example^' })
    ]
    const req: RequestContext = {
      url: 'https://ads.example/banner.js',
      type: 'script',
      method: 'GET',
      initiator: 'https://news.example/',
      partition: 'default'
    }
    const engine = new RuleEngine()
    engine.setRuleSet(entry('ext:x:_session', 'dnr', 2999, rules))
    const linear = engine.decideLinear(req)
    const indexed = engine.decide(req)
    const index = engine.indexOf('ext:x:_session')
    expect(index?.wildcardCount).toBe(1)
    expect(index?.tokenIndexedCount).toBe(1)
    expect(index?.hostCount).toBe(1)
    // `block` outranks `redirect` at the same priority; among equals the lowest position wins.
    expect(linear.action).toBe('block')
    expect(linear.matched?.ruleId).toBe(13)
    expect(indexed).toEqual(linear)

    const onlyRedirects = new RuleEngine()
    onlyRedirects.setRuleSet(entry('ext:x:_session', 'dnr', 2999, rules.slice(0, 3)))
    const linear2 = onlyRedirects.decideLinear(req)
    expect(linear2.redirectUrl).toBe('https://safe.example/wildcard')
    expect(linear2.matched?.ruleId).toBe(10)
    expect(onlyRedirects.decide(req)).toEqual(linear2)

    // Across sets of one priority the ids order them, as the Kotlin engine orders its sets.
    onlyRedirects.setRuleSet(
      entry('ext:w:_session', 'dnr', 2999, [
        rule(1, 'redirect', { urlFilter: '||ads.example^' }, 1, 'https://safe.example/w')
      ])
    )
    const linear3 = onlyRedirects.decideLinear(req)
    expect(linear3.matched?.setId).toBe('ext:w:_session')
    expect(linear3.redirectUrl).toBe('https://safe.example/w')
    expect(onlyRedirects.decide(req)).toEqual(linear3)
  })

  /**
   * The `modifyHeaders` golden fixture: User-Agent Switcher's session rule, two more extensions'
   * header edits (stacked across sets, capped by allows of both stages, a header-conditioned
   * edit joining at the header stage, its request edit dropped), the user's set and the site
   * exceptions below the band. Every probe must decide as the fixture says – action, match, the
   * edits in order, `needsHeaders` – at the request stage and, where the fixture gives response
   * headers, at the header stage; the Kotlin engine asserts the same file
   * (`IndexDifferentialTest.bothEnginesProduceTheSameEditsForTheModifyHeadersFixture`), so the
   * two engines produce the same edits for the same rules.
   */
  it('produces the edits the modifyHeaders golden fixture pins, as the Kotlin engine does', () => {
    const fixture = JSON.parse(readFileSync(HEADERS_FIXTURE, 'utf8')) as HeadersFixture
    const engine = new RuleEngine()
    for (const set of fixture.sets) engine.setRuleSet(set)
    expect(fixture.probes.length).toBeGreaterThanOrEqual(15)
    const failures: string[] = []
    let stages = 0
    const stage = (name: string, ctx: RequestContext, expected: unknown): void => {
      stages++
      const linear = engine.decideLinear(ctx)
      const indexed = engine.decide(ctx)
      if (!same(indexed, linear))
        failures.push(`${name}: index ${show(indexed)} / linear ${show(linear)}`)
      const actual = fixtureShape(linear)
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        failures.push(
          `${name}:\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`
        )
    }
    // Before the deferred index (the small sets are indexed inline) and after it.
    for (const pass of ['inline', 'built'] as const) {
      if (pass === 'built') engine.buildIndexes()
      for (const probe of fixture.probes) {
        const r = probe.request
        const ctx: RequestContext = { url: r.url, type: r.type, method: r.method }
        if (r.documentUrl) {
          ctx.documentUrl = r.documentUrl
          ctx.initiator = r.documentUrl
        }
        if (r.thirdParty !== undefined) ctx.isThirdParty = r.thirdParty
        if (r.partition) ctx.partition = r.partition
        if (probe.expected !== undefined) stage(`${probe.name} (${pass})`, ctx, probe.expected)
        if (probe.responseHeaders) {
          stage(
            `${probe.name} (${pass}, with headers)`,
            { ...ctx, responseHeaders: probe.responseHeaders },
            probe.expectedWithHeaders
          )
        }
      }
    }
    expect(stages).toBeGreaterThanOrEqual(40)
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('stacks the header operations of tied modifyHeaders rules in scan order however the index meets them', () => {
    const engine = new RuleEngine()
    engine.setRuleSet(
      entry('ext:x:_session', 'dnr', 2999, [
        {
          id: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-1', operation: 'set', value: 'a' }]
          },
          condition: { regexFilter: 'banner\\.js$' }
        },
        {
          id: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-2', operation: 'set', value: 'b' }]
          },
          condition: { urlFilter: '||ads.example^' }
        },
        {
          id: 3,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-3', operation: 'remove' }]
          },
          condition: { urlFilter: '/banner.js' }
        },
        {
          id: 4,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-4', operation: 'set', value: 'd' }]
          },
          condition: { requestDomains: ['ads.example'] }
        }
      ])
    )
    const req: RequestContext = {
      url: 'https://cdn.ads.example/banner.js',
      type: 'script',
      method: 'GET',
      initiator: 'https://news.example/',
      partition: 'default'
    }
    const linear = engine.decideLinear(req)
    expect(linear).toEqual({
      action: 'modifyHeaders',
      requestHeaders: [
        { header: 'x-4', operation: 'set', value: 'd' },
        { header: 'x-1', operation: 'set', value: 'a' },
        { header: 'x-2', operation: 'set', value: 'b' }
      ],
      responseHeaders: [{ header: 'x-3', operation: 'remove' }],
      matched: { setId: 'ext:x:_session', ruleId: 4 }
    })
    expect(engine.decide(req)).toEqual(linear)
  })
})
