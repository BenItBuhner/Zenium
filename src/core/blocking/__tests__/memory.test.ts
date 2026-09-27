// eslint-disable-next-line no-restricted-imports
import v8 from 'node:v8'
// eslint-disable-next-line no-restricted-imports
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import type { StoreIO } from '../../platform'
import { CONNECTIVITY_PROBES, connectivityProbesRuleSet } from '../connectivityProbes'
import { RuleEngine } from '../engine'
import {
  BUILTIN_RULE_SETS,
  RULE_SET_PRIORITY,
  type RequestContext,
  type ResourceType,
  type Rule,
  type RuleSet
} from '../rules'
import { siteExceptionRule } from '../service'
import { RuleSetStore } from '../store'
import {
  CENSUS_RULES,
  HOSTS_RULE_DOMAINS,
  censusDomain,
  censusEngineSet,
  censusSyllable,
  mulberry32
} from './census'

/**
 * What the core's blocking engine retains for its compiled rule table, measured with
 * `process.memoryUsage().heapUsed` after a forced collection, for the realistic desktop shape:
 * the sets the blocking service ships (the seven bundled ABP lists as the summaries the engine
 * keeps of them – their text is matched by the platform's text matcher and never held by the
 * core – plus the builtin structured sets) and one static declarativeNetRequest set of the
 * round-21 extension's census shape (`census.ts`: 61 714 rules through the real translator, as
 * `createDnrSink` feeds them). Three readings, each what one host path keeps:
 *
 * - the `Rule[]` the engine is handed (`rulesOf`, what the set document is written from);
 * - what `setRuleSet` retains beyond it – the phone's path: the Kotlin engine decides there, the
 *   core never calls `decide`, and after the set document is written this is the core's second
 *   copy of the rules (extensions' condition: it must not grow);
 * - what the first `decide` adds – the desktop's path: the table the matcher reads and the
 *   per-set index over it.
 *
 * Plus the build time, the desktop matcher's rate over 100 000 synthetic requests and – the proof
 * that a change of the table's shape changed no decision – an FNV-1a hash over every decision of
 * that corpus, against the service defaults alone and with the census set, from `decide` and
 * (over a sample) `decideLinear`: the same corpus on two heads must print the same hashes.
 * Numbers, not assertions: they are printed for the record and go in the pull request; the
 * assertions pin the set's shape and `decide` = `decideLinear` over the sample. `ZEN_RULES=<n>`
 * scales the census set down for a quick run; `ZEN_REQUESTS=<n>` the corpus.
 */

/** V8's collector, exposed at run time (vitest does not start node with `--expose-gc`). */
function collector(): (() => void) | null {
  try {
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as unknown
    return typeof gc === 'function' ? (gc as () => void) : null
  } catch {
    return null
  }
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`
const perRule = (bytes: number, rules: number): string =>
  `${Math.round(bytes / Math.max(1, rules))} B/rule`
const ms = (value: number): string => `${value.toFixed(1)} ms`

/** The bundled lists as `manifest.json` names them, as the service registers them at start. */
const BUNDLED: readonly { id: string; filterCount: number }[] = [
  { id: 'urlhaus', filterCount: 9_318 },
  { id: 'ubo-badware', filterCount: 4_140 },
  { id: 'easylist', filterCount: 56_828 },
  { id: 'easyprivacy', filterCount: 56_064 },
  { id: 'ubo-filters', filterCount: 1_765 },
  { id: 'peter-lowe', filterCount: 3_560 },
  { id: 'ubo-privacy', filterCount: 1_435 }
]

/** A store IO that lands every write at once and keeps nothing but what was written where. */
function discardingIo(): StoreIO & { written: Map<string, number> } {
  const written = new Map<string, number>()
  return {
    written,
    readSync: () => null,
    write: async (name, text) => {
      written.set(name, text.length)
    },
    writeSync: (name, text) => {
      written.set(name, text.length)
    },
    exists: (name) => written.has(name),
    remove: async (name) => {
      written.delete(name)
    }
  }
}

/** The engine as the blocking service leaves it after start, before any extension. */
function serviceDefaults(engine: RuleEngine): number {
  let structured = 0
  for (const list of BUNDLED) {
    engine.setRuleSet(
      { id: list.id, source: 'filter-list', priority: RULE_SET_PRIORITY.filterList, enabled: true },
      { persisted: true, hasFilterText: true, filterCount: list.filterCount }
    )
  }
  const probes = connectivityProbesRuleSet()
  engine.setRuleSet(probes)
  structured += probes.rules.length
  const exceptions: Rule[] = [
    'https://news.example',
    'https://shop.example',
    'http://intranet.example:8080'
  ].map(siteExceptionRule)
  engine.setRuleSet({
    id: BUILTIN_RULE_SETS.siteExceptions,
    source: 'builtin',
    priority: RULE_SET_PRIORITY.siteExceptions,
    enabled: true,
    rules: exceptions
  })
  structured += exceptions.length
  engine.setRuleSet({
    id: BUILTIN_RULE_SETS.httpsOnly,
    source: 'builtin',
    priority: RULE_SET_PRIORITY.httpsOnly,
    enabled: true,
    rules: [
      {
        id: 1,
        action: { type: 'upgradeScheme' },
        condition: {
          urlFilter: '|http://',
          excludedNonUniqueHosts: true,
          excludedRequestDomains: ['plain.example'],
          resourceTypes: ['main_frame']
        }
      }
    ]
  })
  structured += 1
  engine.setRuleSet({
    id: BUILTIN_RULE_SETS.globalOff,
    source: 'builtin',
    priority: RULE_SET_PRIORITY.globalOff,
    enabled: false,
    rules: [{ id: 1, action: { type: 'allow' }, condition: {} }]
  })
  structured += 1
  return structured
}

const REQUEST_TYPES: readonly ResourceType[] = [
  'script',
  'script',
  'image',
  'image',
  'xmlhttprequest',
  'sub_frame',
  'stylesheet',
  'font',
  'media',
  'ping',
  'other',
  'main_frame'
]

/** The documents the site exceptions of `serviceDefaults` except. */
const EXCEPTED_SITES = [
  'https://news.example',
  'https://shop.example',
  'http://intranet.example:8080'
]

/**
 * `count` requests a page load mix produces: to the hosts the census set's urlFilters name, to
 * the hosts rule's domains, to other census domains, to unrelated sites, plus what the service
 * defaults decide on – `http://` navigations (the https-only upgrade), requests under an
 * excepted document (`allowAllRequests`) and the connectivity probes; documents from the site
 * pool the initiator lists draw on. Seeded: the same corpus on every run.
 */
function syntheticRequests(count: number, census: number): RequestContext[] {
  const random = mulberry32(7)
  const int = (n: number): number => Math.floor(random() * n)
  const sitePool = Math.max(64, Math.floor((20_000 * census) / CENSUS_RULES))
  const hostsRule = Math.max(1, Math.round((HOSTS_RULE_DOMAINS * census) / CENSUS_RULES))
  const out: RequestContext[] = []
  for (let i = 0; i < count; i++) {
    const u = int(100)
    const syllable = censusSyllable(random)
    let url: string
    let type = REQUEST_TYPES[int(REQUEST_TYPES.length)]!
    let document: string | undefined
    if (u < 45)
      url = `https://${censusDomain(int(24_000))}/${syllable}/${censusSyllable(random)}${int(census)}.js`
    else if (u < 60) url = `https://${censusDomain(1_000_000 + int(hostsRule))}/${syllable}.png`
    else if (u < 78)
      url = `https://${censusDomain(int(540_000))}/${syllable}/${censusSyllable(random)}`
    else if (u < 88)
      url = `https://www.site${int(1_000)}.example/${syllable}/${censusSyllable(random)}.css`
    else if (u < 92) {
      url = `http://www.site${int(1_000)}.example/${syllable}`
      type = 'main_frame'
    } else if (u < 97) {
      url = `https://${censusDomain(int(24_000))}/${syllable}.js`
      document = `${EXCEPTED_SITES[int(EXCEPTED_SITES.length)]!}/${syllable}`
    } else {
      const probe = CONNECTIVITY_PROBES[int(CONNECTIVITY_PROBES.length)]!
      url = `https://${probe}${int(2) === 0 ? '' : '?x=1'}`
      type = int(2) === 0 ? 'xmlhttprequest' : 'main_frame'
    }
    const ctx: RequestContext = { url, type, method: int(20) === 0 ? 'POST' : 'GET' }
    if (type !== 'main_frame') {
      document ??= `https://${censusDomain(int(sitePool))}/`
      ctx.initiator = document
      ctx.documentUrl = document
    }
    out.push(ctx)
  }
  return out
}

/** FNV-1a (32 bits) over `text`, continued from `hash`. */
function fnv1a(hash: number, text: string): number {
  let h = hash
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const hex = (hash: number): string => `0x${hash.toString(16).padStart(8, '0')}`

/** Decide every request; the hash of every decision and how many were not plain allows. */
function decideAll(
  engine: RuleEngine,
  requests: readonly RequestContext[],
  linear = false
): { hash: number; notAllowed: number; ms: number } {
  let hash = 2166136261
  let notAllowed = 0
  const start = performance.now()
  for (const ctx of requests) {
    const decision = linear ? engine.decideLinear(ctx) : engine.decide(ctx)
    if (decision.action !== 'allow' || decision.matched || decision.needsHeaders) notAllowed++
    hash = fnv1a(hash, JSON.stringify(decision))
  }
  return { hash, notAllowed, ms: performance.now() - start }
}

interface Readings {
  compiled: number
  rulesBytes: number
  setBytes: number
  phoneBytes: number
  indexBytes: number
  setMs: number
  indexMs: number
  documentChars: number
  biggest: number
}

/** One pass in its own frame, so nothing of it outlives the return but the numbers. */
async function measure(count: number, settled: () => number, base: number): Promise<Readings> {
  const census = censusEngineSet(count)
  const set: RuleSet | null = census.set
  const compiled = set.rules?.length ?? 0
  let biggest = 0
  for (const rule of set.rules ?? [])
    biggest = Math.max(biggest, rule.condition.requestDomains?.length ?? 0)
  const rulesBytes = settled() - base

  // The phone's path: a store attached, the set document written on `setRuleSet`, no `decide`.
  const io = discardingIo()
  let store: RuleSetStore | null = new RuleSetStore(io)
  let engine: RuleEngine | null = new RuleEngine()
  store.attach(engine)
  serviceDefaults(engine)
  await store.whenSettled()
  const defaultsBytes = settled() - base - rulesBytes
  const setStart = performance.now()
  engine.setRuleSet(set)
  const setMs = performance.now() - setStart
  // The document's write lands (a microtask here; the host's disk on the phone) and the store
  // lets its text go: what is left is the engine's copy.
  await store.whenSettled()
  const afterSet = settled() - base
  const documentChars = io.written.get(store.documentPathFor(set.id)) ?? 0
  const phoneBytes = afterSet - rulesBytes - defaultsBytes
  store.detach()
  store = null
  io.written.clear()

  // The desktop's path: the same engine decides, so every set gets its table and index.
  const indexStart = performance.now()
  engine.buildIndexes()
  const indexMs = performance.now() - indexStart
  const afterIndex = settled() - base
  const indexBytes = afterIndex - afterSet
  engine = null
  return {
    compiled,
    rulesBytes,
    setBytes: phoneBytes,
    phoneBytes,
    indexBytes,
    setMs,
    indexMs,
    documentChars,
    biggest
  }
}

describe("the core's compiled rule table", () => {
  test('bytes retained per rule on the phone path and the desktop path, the build time and the matcher rate', async () => {
    const count = Number(process.env['ZEN_RULES']) || CENSUS_RULES
    const gc = collector()
    const settled = (): number => {
      if (gc) for (let i = 0; i < 3; i++) gc()
      return process.memoryUsage().heapUsed
    }
    const base = settled()
    const m = await measure(count, settled, base)
    const after = settled() - base
    expect(m.compiled).toBeGreaterThan((count * 9) / 10)
    expect(m.biggest).toBe(Math.max(1, Math.round((HOSTS_RULE_DOMAINS * count) / CENSUS_RULES)))

    // The desktop matcher's rate and the decisions' hash: the service defaults alone, then with
    // the census set, indexed, over the synthetic corpus; the linear scan over a sample for
    // reference (and as the oracle `decide` must agree with).
    const requests = syntheticRequests(Number(process.env['ZEN_REQUESTS']) || 100_000, count)
    const engine = new RuleEngine()
    const structured = serviceDefaults(engine)
    engine.buildIndexes()
    for (let i = 0; i < 2_000; i++) engine.decide(requests[i]!)
    const defaults = decideAll(engine, requests)
    const census = censusEngineSet(count)
    engine.setRuleSet(census.set)
    engine.buildIndexes()
    for (let i = 0; i < 2_000; i++) engine.decide(requests[i]!)
    const all = decideAll(engine, requests)
    const linearSample = requests.slice(0, 200)
    const linear = decideAll(engine, linearSample, true)
    for (const ctx of linearSample) expect(engine.decide(ctx)).toEqual(engine.decideLinear(ctx))
    const rate = (r: { ms: number }, n: number): string =>
      `${Math.round((n / r.ms) * 1000)} requests/s`

    const lines = [
      `=== the core's compiled rule table: ${m.compiled} census rules (of ${count} generated) through the translator + the service defaults (${BUNDLED.length} bundled text lists, ${structured} builtin rules); node ${process.version}${gc ? '' : ', no collector exposed: the numbers include garbage'} ===`,
      `set document written on the phone path: ${m.documentChars} chars; ${census.shape.lists} domain lists with ${census.shape.domainRefs} domain references, the biggest ${m.biggest}`,
      `Rule[] as the engine is handed it (rulesOf, the set document's source): ${mb(m.rulesBytes)} = ${perRule(m.rulesBytes, m.compiled)}`,
      `PHONE PATH – retained by setRuleSet beyond the Rule[] after the set document is written (the core's second copy): ${mb(m.phoneBytes)} = ${perRule(m.phoneBytes, m.compiled)}; setRuleSet ${ms(m.setMs)}`,
      `DESKTOP PATH – added by the first decide (buildIndexes: the table the matcher reads + the index): ${mb(m.indexBytes)} = ${perRule(m.indexBytes, m.compiled)}; build ${ms(m.indexMs)}`,
      `DESKTOP PATH – total beyond the Rule[]: ${mb(m.phoneBytes + m.indexBytes)} = ${perRule(m.phoneBytes + m.indexBytes, m.compiled)}`,
      `everything let go: ${mb(after)}`,
      `decide over ${requests.length} requests, service defaults alone: ${rate(defaults, requests.length)} (${ms(defaults.ms)}; ${defaults.notAllowed} decided by a rule), decisions ${hex(defaults.hash)}`,
      `decide over ${requests.length} requests, defaults + census set: ${rate(all, requests.length)} (${ms(all.ms)}; ${all.notAllowed} decided by a rule), decisions ${hex(all.hash)}; decideLinear over ${linearSample.length}: ${rate(linear, linearSample.length)}, decisions ${hex(linear.hash)}`
    ]
    console.info(lines.join('\n'))
  }, 900_000)
})
