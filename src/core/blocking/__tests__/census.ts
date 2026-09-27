/**
 * The round-21 extension's static ruleset (`Adblock Ad Blocker Pro`, a uBlock Origin Lite fork:
 * 61 714 rules; the census of the rules carrying each condition field, `stevenblack-hosts`'s
 * 108 195 domains in one rule's `requestDomains`, uBO Lite's two hostname folds of 48 868 and
 * 43 095) generated the way `src/core/extensions/dnr/__tests__/memory.test.ts` generates it –
 * the same 32-bit PRNG, the same shapes, so the two measurements describe one set – and then put
 * through the real path into the engine: `parseRuleset` and `translateRuleset`, which is what
 * `createDnrSink` feeds `RuleEngine.setRuleSet`. Deterministic; never read from a file.
 */
import { parseRuleset, type Rule as DnrRule } from '../../extensions/dnr/rules'
import { translateRuleset } from '../../extensions/dnr/translate'
import type { RuleSet } from '../rules'

export const CENSUS_RULES = 61_714
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
export const HOSTS_RULE_DOMAINS = 108_195
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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The `index`th name of the generator's domain space (the urlFilters' hosts are the first 24 000). */
export function censusDomain(index: number): string {
  let name =
    SYLLABLES[index % SYLLABLES.length]! +
    SYLLABLES[Math.floor(index / SYLLABLES.length) % SYLLABLES.length]!
  if (index % 3 === 0) name += SYLLABLES[Math.floor(index / 400) % SYLLABLES.length]!
  return `${name}${index}.${TLDS[Math.floor(index / 7) % TLDS.length]!}`
}

export function censusSyllable(random: () => number): string {
  return SYLLABLES[Math.floor(random() * SYLLABLES.length)]!
}

export interface CensusShape {
  domainRefs: number
  lists: number
}

/** The census set as the rules file holds it (`chrome.declarativeNetRequest.Rule[]`). */
export function generateCensus(count: number): { rules: DnrRule[]; shape: CensusShape } {
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
  const shape: CensusShape = { domainRefs: 0, lists: 0 }
  const list = (size: number): string[] => {
    const pool = size > 64 ? 540_000 : sitePool
    const picked = new Set<string>()
    while (picked.size < size) picked.add(censusDomain(int(pool)))
    shape.domainRefs += picked.size
    shape.lists++
    return [...picked]
  }
  const folded = (from: number, size: number): string[] => {
    const out: string[] = []
    for (let i = 0; i < size; i++) out.push(censusDomain(from + i))
    shape.domainRefs += size
    shape.lists++
    return out
  }
  const scaled = (n: number): number => Math.max(1, Math.round((n * count) / CENSUS_RULES))
  const syllable = (): string => censusSyllable(random)
  const urlFilter = (id: number): string => {
    const host = censusDomain(int(24_000))
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
  const action = (): DnrRule['action'] => {
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
  // the mark taken from a rule that has a urlFilter so the census count holds; without it such a
  // rule matches every URL.
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
  const rules: DnrRule[] = []
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
    rules.push({
      id,
      priority: int(10) === 0 ? 2 + int(4) : 1,
      action: action(),
      condition
    } as unknown as DnrRule)
  }
  return { rules, shape }
}

export const CENSUS_EXTENSION_ID = 'censuscensuscensuscensuscensusab'

/**
 * The census set as the engine receives it from the declarativeNetRequest layer: the rules file
 * parsed (`parseRuleset`) and translated (`translateRuleset`), the newest-installed slot of the
 * DNR band. Built from the JSON text of the rules, as an extension's file is.
 */
export function censusEngineSet(count = CENSUS_RULES): { set: RuleSet; shape: CensusShape } {
  const generated = generateCensus(count)
  const text = JSON.stringify(generated.rules)
  generated.rules.length = 0
  const parsed = parseRuleset(text, {
    source: 'static',
    rulesetId: 'census',
    extensionBaseUrl: `chrome-extension://${CENSUS_EXTENSION_ID}/`
  })
  if (parsed.rejected) throw new Error('the census ruleset was rejected')
  const translation = translateRuleset(
    {
      extensionId: CENSUS_EXTENSION_ID,
      name: 'Census',
      version: '1.0',
      installRank: 0,
      rulesets: []
    },
    {
      source: 'static',
      rulesetId: 'census',
      path: 'rules/census.json',
      manifestIndex: 0,
      rules: parsed.compiled
    }
  )
  return { set: translation.set, shape: generated.shape }
}
