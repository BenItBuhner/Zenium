// eslint-disable-next-line no-restricted-imports
import v8 from 'node:v8'
// eslint-disable-next-line no-restricted-imports
import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { RuleEngine } from '../../../blocking/engine'
import { createDnrSink } from '../engineSink'
import { parseRuleset, type Rule } from '../rules'
import { engineSetId, type RuleSink } from '../sink'
import { DnrState, type DnrStateIO } from '../state'
import { DnrTranslator } from '../translate'
import { EXTENSION_BASE_URL, EXTENSION_ID } from './fixtures'

/**
 * What the core retains for one static ruleset of the round-21 extension's shape (`Adblock Ad
 * Blocker Pro`, a uBlock Origin Lite fork: 61 714 rules on the phone; round 21's census of the
 * rules carrying each condition field, with `stevenblack-hosts`'s 108 195 domains in one rule's
 * `requestDomains` and uBO Lite's two hostname folds of 48 868 and 43 095), measured with
 * `process.memoryUsage().heapUsed` after a forced collection: the `Rule[]` tree `JSON.parse`
 * yields, the `ParseRulesetResult` a `StaticRuleset.parsed` holds (the tree and the
 * `CompiledRule[]` over it), and the `CompiledRule[]` alone. Numbers, not assertions: they are
 * printed for the record (the Kotlin engine's are in `RuleMemoryTest`); the assertions pin the
 * set's shape. Generated once and deterministic (a 32-bit PRNG), never read from a file.
 */

const CENSUS_RULES = 61_714
const CENSUS: Record<string, number> = {
  urlFilter: 60_665,
  resourceTypes: 14_416,
  initiatorDomains: 7_553,
  domainType: 7_021,
  excludedInitiatorDomains: 571,
  excludedRequestDomains: 429,
  requestDomains: 400,
  excludedResourceTypes: 214,
  requestMethods: 17,
  responseHeaders: 4
}
const HOSTS_RULE_DOMAINS = 108_195
const MEGA_LISTS = [48_868, 43_095]
const SYLLABLES = [
  'ad',
  'trk',
  'pix',
  'stat',
  'cdn',
  'media',
  'serve',
  'click',
  'banner',
  'metric',
  'tag',
  'sync',
  'beacon',
  'promo',
  'yield',
  'bid',
  'count',
  'log',
  'track',
  'img'
]
const TLDS = ['com', 'com', 'com', 'com', 'net', 'org', 'io', 'co', 'de', 'fr', 'ru', 'info']
const TYPES = [
  'script',
  'image',
  'xmlhttprequest',
  'sub_frame',
  'media',
  'font',
  'stylesheet',
  'other',
  'websocket',
  'ping'
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function domain(index: number): string {
  let name =
    SYLLABLES[index % SYLLABLES.length]! +
    SYLLABLES[Math.floor(index / SYLLABLES.length) % SYLLABLES.length]!
  if (index % 3 === 0) name += SYLLABLES[Math.floor(index / 400) % SYLLABLES.length]!
  return `${name}${index}.${TLDS[Math.floor(index / 7) % TLDS.length]!}`
}

/** The census set as `parseRuleset` receives it: the rules file's value. */
function generate(count: number): { rules: Rule[]; domainRefs: number; lists: number } {
  const random = mulberry32(1)
  const int = (n: number): number => Math.floor(random() * n)
  const marks = (n: number): Uint8Array => {
    const out = new Uint8Array(count)
    const indices = Array.from({ length: count }, (_, i) => i)
    const m = n === 0 ? 0 : Math.max(1, Math.round((n * count) / CENSUS_RULES))
    for (let j = 0; j < Math.min(m, count); j++) {
      const k = j + int(count - j)
      const t = indices[j]!
      indices[j] = indices[k]!
      indices[k] = t
      out[indices[j]!] = 1
    }
    return out
  }
  const has: Record<string, Uint8Array> = {}
  for (const [field, n] of Object.entries(CENSUS)) has[field] = marks(n)
  const sitePool = Math.max(64, Math.floor((20_000 * count) / CENSUS_RULES))
  const listSize = (): number => {
    const u = random()
    if (u < 116 / 13_698) return 65 + Math.floor(-Math.log(1 - random()) * 400)
    if (u < 0.03) return 8 + int(57)
    return 1 + Math.floor(-Math.log(1 - random()) * 1.3)
  }
  let domainRefs = 0
  let lists = 0
  const list = (size: number): string[] => {
    const pool = size > 64 ? 540_000 : sitePool
    const picked = new Set<string>()
    while (picked.size < size) picked.add(domain(int(pool)))
    domainRefs += picked.size
    lists++
    return [...picked]
  }
  const folded = (from: number, size: number): string[] => {
    const out: string[] = []
    for (let i = 0; i < size; i++) out.push(domain(from + i))
    domainRefs += size
    lists++
    return out
  }
  const scaled = (n: number): number => Math.max(1, Math.round((n * count) / CENSUS_RULES))
  const syllable = (): string => SYLLABLES[int(SYLLABLES.length)]!
  const urlFilter = (id: number): string => {
    const host = domain(int(24_000))
    const u = int(100)
    if (u < 51) return `||${host}/${syllable()}/${syllable()}${id}.`
    if (u < 69) return `/${syllable()}/${syllable()}${id}.`
    if (u < 84) return `||${host}*/${syllable()}${id}`
    if (u < 89) return `${syllable()}-${syllable()}${id}`
    if (u < 93) return `||${host}`
    if (u < 96) return `||${host}^`
    if (u < 98) return `*/${syllable()}${id}/*`
    return `|https://${host}/${syllable()}${id}|`
  }
  const types = (): string[] => {
    const r = int(10)
    const n = r < 7 ? 1 : r < 9 ? 2 : 3
    const picked = new Set<string>()
    while (picked.size < n) picked.add(TYPES[int(TYPES.length)]!)
    return [...picked]
  }
  const action = (): Rule['action'] => {
    const r = int(1000)
    if (r < 835) return { type: 'block' }
    if (r < 943) return { type: 'allow' }
    if (r < 998) return { type: 'redirect', redirect: { url: 'https://ext.example/noop.js' } }
    if (r === 998) {
      return {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'cookie', operation: 'remove' },
          { header: 'referer', operation: 'remove' }
        ]
      }
    }
    return {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
    }
  }
  const requestDomains = has['requestDomains']!
  let hostsAt = requestDomains.indexOf(1)
  if (hostsAt < 0) {
    hostsAt = 0
    requestDomains[0] = 1
  }
  // A rule with neither a urlFilter nor requestDomains keeps a positive scope (initiatorDomains),
  // the mark taken from a rule that has a urlFilter so the census count holds – as the Kotlin
  // generator does; without it such a rule matches every URL.
  const urlFilterMarks = has['urlFilter']!
  const initiatorMarks = has['initiatorDomains']!
  let donor = 0
  for (let k = 0; k < count; k++) {
    if (urlFilterMarks[k] || requestDomains[k] || initiatorMarks[k]) continue
    while (donor < count && !(initiatorMarks[donor] && urlFilterMarks[donor])) donor++
    if (donor >= count) break
    initiatorMarks[donor] = 0
    initiatorMarks[k] = 1
  }
  let megaLeft = MEGA_LISTS.length
  let nextFolded = 1_000_000
  const rules: Rule[] = []
  for (let k = 0; k < count; k++) {
    const id = k + 1
    const condition: Record<string, unknown> = {}
    const foldedRule = requestDomains[k] === 1 && (k === hostsAt || (megaLeft > 0 && k > hostsAt))
    if (foldedRule) {
      const size =
        k === hostsAt
          ? scaled(HOSTS_RULE_DOMAINS)
          : scaled(MEGA_LISTS[MEGA_LISTS.length - megaLeft--]!)
      condition['requestDomains'] = folded(nextFolded, size)
      nextFolded += size
    } else {
      if (has['urlFilter']![k]) condition['urlFilter'] = urlFilter(id)
      if (requestDomains[k]) condition['requestDomains'] = list(listSize())
    }
    if (has['initiatorDomains']![k]) condition['initiatorDomains'] = list(listSize())
    if (has['excludedInitiatorDomains']![k])
      condition['excludedInitiatorDomains'] = list(listSize())
    if (has['excludedRequestDomains']![k]) condition['excludedRequestDomains'] = list(listSize())
    if (has['resourceTypes']![k]) condition['resourceTypes'] = types()
    if (has['excludedResourceTypes']![k]) condition['excludedResourceTypes'] = ['main_frame']
    if (has['domainType']![k]) condition['domainType'] = int(10) === 0 ? 'firstParty' : 'thirdParty'
    if (has['requestMethods']![k]) condition['requestMethods'] = [random() < 0.5 ? 'get' : 'post']
    if (has['responseHeaders']![k])
      condition['responseHeaders'] = [{ header: 'content-type', values: ['text/html*'] }]
    const rule = {
      id,
      priority: int(10) === 0 ? 2 + int(4) : 1,
      action: action(),
      condition
    } as unknown as Rule
    rules.push(rule)
  }
  return { rules, domainRefs, lists }
}

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

interface Measured {
  textLength: number
  lists: number
  domainRefs: number
  compiledCount: number
  errors: number
  biggest: number
  treeBytes: number
  parsedBytes: number
  compiledBytes: number
}

/** One pass in its own frame, so nothing of it outlives the return but the numbers. */
function measure(count: number, settled: () => number, base: number): Measured {
  const generated = generate(count)
  // The rules file's text and the tree `JSON.parse` yields from it: what `parseRuleset(json)` starts from.
  let text: string | null = JSON.stringify(generated.rules)
  const textLength = text.length
  let tree: unknown = JSON.parse(text)
  text = null
  generated.rules.length = 0
  const treeBytes = settled() - base
  let result: ReturnType<typeof parseRuleset> | null = parseRuleset(tree, {
    source: 'static',
    rulesetId: 'census',
    extensionBaseUrl: EXTENSION_BASE_URL
  })
  tree = null
  const parsedBytes = settled() - base
  expect(result.rejected).toBe(false)
  const compiledCount = result.compiled.length
  const errors = result.errors.length
  const biggest = Math.max(...result.compiled.map((c) => c.requestDomains.length))
  // The compiled rules without the tree: `CompiledRule.rule` points back into it, `rules` is it.
  result.rules = []
  for (const compiled of result.compiled) (compiled as { rule: Rule | undefined }).rule = undefined
  const compiledBytes = settled() - base
  result = null
  return {
    textLength,
    lists: generated.lists,
    domainRefs: generated.domainRefs,
    compiledCount,
    errors,
    biggest,
    treeBytes,
    parsedBytes,
    compiledBytes
  }
}

describe("the core's copy of a static ruleset", () => {
  test('the Rule[] tree, the ParseRulesetResult and the CompiledRule[] alone, for the census set', () => {
    const count = Number(process.env['ZEN_DNR_RULES']) || CENSUS_RULES
    const gc = collector()
    const settled = (): number => {
      if (gc) for (let i = 0; i < 3; i++) gc()
      return process.memoryUsage().heapUsed
    }
    const base = settled()
    const m = measure(count, settled, base)
    const after = settled() - base
    expect(m.compiledCount).toBeGreaterThan((count * 9) / 10)
    expect(m.biggest).toBe(Math.max(1, Math.round((HOSTS_RULE_DOMAINS * count) / CENSUS_RULES)))
    const lines = [
      `=== the core's copy of a static ruleset: ${count} rules of the round-21 extension's census (node ${process.version}${gc ? '' : ', no collector exposed: the numbers include garbage'}) ===`,
      `rules file: ${m.textLength} chars; ${m.lists} domain lists with ${m.domainRefs} domain references; the biggest list ${m.biggest}`,
      `Rule[] tree (JSON.parse): ${mb(m.treeBytes)} = ${perRule(m.treeBytes, m.compiledCount)}`,
      `ParseRulesetResult as StaticRuleset.parsed holds it (tree + CompiledRule[]): ${mb(m.parsedBytes)} = ${perRule(m.parsedBytes, m.compiledCount)}`,
      `CompiledRule[] alone, the tree let go: ${mb(m.compiledBytes)} = ${perRule(m.compiledBytes, m.compiledCount)}`,
      `everything let go: ${mb(after)}; ${m.errors} rules skipped with a warning`
    ]
    console.info(lines.join('\n'))
  })
})

// ---------------------------------------------------------------------------------------------

/**
 * What the phone's DNR layer holds of the same set once it is in the blocking engine, before
 * and after compat round 22's R22-3: without `DnrStateIO.rereadsStaticRulesets` the state keeps
 * `StaticRuleset.parsed` and the translator its references to the same `CompiledRule[]` (the
 * desktop's shape, whose matcher wants them); with it the state keeps a `ParsedSummary` and the
 * translator an identity, the rules read again from the file only for `testMatchOutcome` /
 * `getMatchedRules` or a set the translator must emit again. Measured through the real
 * `DnrState` + `DnrTranslator` twice over: into a sink that drops every set (the DNR layer's own
 * share) and into the real `RuleEngine` through `createDnrSink` (the phone's wiring – the engine
 * keeps the translated `EngineRule[]` and its own compiled form of every set, on the phone too,
 * although Kotlin decides there; `src/core/blocking/`, the platform's, measured here and not
 * changed). Numbers printed for the record; the assertions pin the reads and the residents, and
 * that the after is a fraction of the before at the census size.
 */

interface Passed {
  heapBytes: number
  reads: number
  rereads: number
  resident: string[]
  enabledRules: number
  engineRules: number | undefined
}

/** One pass in its own frame: the state, the translator and the engine die with the return. */
async function through(
  text: string,
  rereads: boolean,
  wired: boolean,
  settled: () => number
): Promise<Passed> {
  // Each pass against its own settled base: the previous pass's garbage is collected here.
  const base = settled()
  const engine = wired ? new RuleEngine() : null
  const sink: RuleSink = engine
    ? createDnrSink(engine)
    : { setRuleSet: () => {}, removeRuleSet: () => {} }
  let reads = 0
  const io: DnrStateIO = {
    readFile: async () => {
      reads++
      return text
    },
    loadState: async () => undefined,
    saveState: async () => {}
  }
  if (rereads) io.rereadsStaticRulesets = true
  const state = new DnrState(
    { id: EXTENSION_ID, ruleResources: [{ id: 'census', enabled: true, path: 'census.json' }] },
    io
  )
  await state.load()
  const translator = new DnrTranslator(sink)
  const report = await translator.sync(state.translateInput(0))
  expect(report.updated).toEqual([
    engineSetId(EXTENSION_ID, { kind: 'static', rulesetId: 'census' })
  ])
  // The state and the translator alive here, as they are on the phone after the first sync.
  const heapBytes = settled() - base
  const out: Passed = {
    heapBytes,
    reads,
    rereads: state.rereads(),
    resident: state.residentStaticRules(),
    enabledRules: state.enabledStaticRuleCount(),
    engineRules: engine?.summary(engineSetId(EXTENSION_ID, { kind: 'static', rulesetId: 'census' }))
      ?.ruleCount
  }
  if (rereads) {
    // The matcher's rare call: the file read again and let go again.
    const rulesets = await state.matcherRulesets()
    expect(rulesets[0]!.rules.length).toBe(out.enabledRules)
    expect(state.rereads()).toBe(1)
    expect(state.residentStaticRules()).toEqual([])
    // A second sync of the unchanged input reads nothing and sends nothing.
    const again = await translator.sync(state.translateInput(0))
    expect(again.updated).toEqual([])
    expect(reads).toBe(2)
  }
  state.dispose()
  return out
}

describe("the core's copy let go on the phone (compat round 22, R22-3): before and after", () => {
  test('the census set through DnrState and DnrTranslator, into a dropping sink and into the blocking engine', async () => {
    const count = Number(process.env['ZEN_DNR_RULES']) || CENSUS_RULES
    const gc = collector()
    const settled = (): number => {
      if (gc) for (let i = 0; i < 3; i++) gc()
      return process.memoryUsage().heapUsed
    }
    // The rules file's text lives for the whole test, as the package file lives on disk: it is
    // in every pass's base and in no pass.
    const text = JSON.stringify(generate(count).rules)

    const before = await through(text, false, false, settled)
    const after = await through(text, true, false, settled)
    const beforeWired = await through(text, false, true, settled)
    const afterWired = await through(text, true, true, settled)

    for (const pass of [before, after, beforeWired, afterWired]) {
      expect(pass.reads).toBe(1)
      expect(pass.enabledRules).toBeGreaterThan((count * 9) / 10)
      expect(pass.enabledRules).toBe(before.enabledRules)
    }
    expect(before.resident).toEqual(['census'])
    expect(before.rereads).toBe(0)
    expect(after.resident).toEqual([])
    expect(after.rereads).toBe(0)
    expect(beforeWired.engineRules).toBe(before.enabledRules)
    expect(afterWired.engineRules).toBe(before.enabledRules)
    if (count >= 10_000) {
      // The summaries and an identity against the parsed tree and its compiled rules.
      expect(after.heapBytes).toBeLessThan(before.heapBytes / 4)
      expect(afterWired.heapBytes).toBeLessThan(beforeWired.heapBytes)
    }

    const engineShare = afterWired.heapBytes - after.heapBytes
    const lines = [
      `=== the core's copy on the phone, ${count} rules of the census set through DnrState + DnrTranslator (compat round 22, R22-3; node ${process.version}${gc ? '' : ', no collector exposed: the numbers include garbage'}) ===`,
      `BEFORE (the rules resident in the state and referenced by the translator, the desktop's shape): the DNR layer ${mb(before.heapBytes)} = ${perRule(before.heapBytes, before.enabledRules)}; wired into the blocking engine ${mb(beforeWired.heapBytes)} = ${perRule(beforeWired.heapBytes, before.enabledRules)}`,
      `AFTER (rereadsStaticRulesets: a ParsedSummary and an identity; the file read again on a matcher call – ${after.rereads + 1} re-read in the pass, resident ${JSON.stringify(after.resident)}): the DNR layer ${mb(after.heapBytes)} = ${perRule(after.heapBytes, after.enabledRules)}; wired into the blocking engine ${mb(afterWired.heapBytes)} = ${perRule(afterWired.heapBytes, after.enabledRules)}`,
      `the blocking engine's own copy of the set (its StoredSet: the translated EngineRule[] and its compiled form, src/core/blocking/engine.ts – kept on the phone too, where Kotlin decides): about ${mb(engineShare)} = ${perRule(engineShare, after.enabledRules)}`,
      `reads of the rules file per pass: 1 at load (the counts and the hand-over from one read); the enabled rules ${before.enabledRules} in every pass; the engine's set ${beforeWired.engineRules} rules`
    ]
    console.info(lines.join('\n'))
  }, 180_000)
})
