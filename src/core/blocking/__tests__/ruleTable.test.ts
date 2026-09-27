import { describe, expect, it } from 'vitest'
import { hostSuffixes } from '../ruleIndex'
import {
  ACTION,
  BlobDomainList,
  DEFAULT_DOMAIN_LIST_FORM,
  DomainBlob,
  RuleTable,
  SetDomainList,
  SortedDomainList,
  URL_KIND,
  compilableCount,
  type DomainList,
  type DomainListForm,
  type UrlFacts
} from '../ruleTable'
import type { Rule } from '../rules'

const FORMS: readonly DomainListForm[] = ['set', 'sorted', 'blob']

/**
 * Lists with what trips a byte-wise or a code-unit-wise order up: duplicates, one entry a prefix
 * of another, entries that sort on either side of a probe, a non-ASCII label (UTF-8 is two bytes
 * per character there, one code unit) and a label past it in code unit order.
 */
const LISTS: readonly (readonly string[])[] = [
  ['example.com', 'example.co', 'example.com.au', 'a.example.com', 'example.com', 'z.example'],
  ['bücher.example', 'xn--bcher-kva.example', 'zz.example', 'b.example', 'bücher.example'],
  ['only.example'],
  ['0.example', '9.example', 'a.example', 'a-b.example', 'a.b.example', 'ab.example']
]

const PROBES: readonly string[] = [
  'example.com',
  'example.co',
  'example.c',
  'example.com.au',
  'example.com.a',
  'example.com.aus',
  'a.example.com',
  'b.example.com',
  'z.example',
  'zzz.example',
  '',
  'bücher.example',
  'bücher.examplf',
  'bücher.exampl',
  'xn--bcher-kva.example',
  'b.example',
  'c.example',
  'only.example',
  'only.exampl',
  'only.example.',
  'a.example',
  'a-b.example',
  'a.b.example',
  'ab.example',
  'aa.example',
  '0.example',
  '9.example',
  '00.example'
]

function lowered(list: readonly string[]): string[] {
  return list.map((d) => d.toLowerCase())
}

function listsIn(form: DomainListForm): DomainList[] {
  const lists = LISTS.map(lowered)
  switch (form) {
    case 'set':
      return lists.map((list) => new SetDomainList(new Set(list)))
    case 'sorted':
      return lists.map((list) => new SortedDomainList([...new Set(list)].sort()))
    case 'blob': {
      const { blob, ranges } = DomainBlob.build(lists)
      return ranges.map(([first, count]) => new BlobDomainList(blob, first, count))
    }
  }
}

describe('domain list forms', () => {
  for (const form of FORMS) {
    it(`${form}: has, hasAny and domains agree with a Set over every list and probe`, () => {
      const lists = listsIn(form)
      LISTS.forEach((list, i) => {
        const reference = new Set(lowered(list))
        const under = lists[i]!
        expect(under.size).toBe(reference.size)
        for (const probe of PROBES)
          expect(under.has(probe), `${probe} in list ${i}`).toBe(reference.has(probe))
        expect(new Set(under.domains())).toEqual(reference)
        for (const probe of PROBES) {
          const suffixes = hostSuffixes(probe)
          expect(under.hasAny(suffixes), `suffixes of ${probe} in list ${i}`).toBe(
            suffixes.some((s) => reference.has(s))
          )
        }
      })
    })
  }
})

describe('DomainBlob', () => {
  it('lays every list out as one byte blob, each list a sorted run', () => {
    const { blob, ranges } = DomainBlob.build(LISTS.map(lowered))
    const distinct = LISTS.map((list) => new Set(lowered(list)).size)
    expect(blob.size).toBe(distinct.reduce((a, b) => a + b, 0))
    expect(ranges.map(([, count]) => count)).toEqual(distinct)
    let next = 0
    for (const [first, count] of ranges) {
      expect(first).toBe(next)
      next += count
      for (let k = first + 1; k < first + count; k++) {
        // Entries of a run are in byte order (so a later one compares greater to an earlier one's text).
        expect(blob.compare(k, blob.entry(k - 1))).toBeGreaterThan(0)
      }
    }
    expect(blob.offsets[0]).toBe(0)
    expect(blob.offsets[blob.size]).toBe(blob.bytes.length)
    for (let k = 1; k <= blob.size; k++)
      expect(blob.offsets[k]!).toBeGreaterThan(blob.offsets[k - 1]!)
  })

  it('round-trips entries through UTF-8 and compares a key both ways', () => {
    const { blob } = DomainBlob.build([lowered(LISTS[1]!)])
    const entries = Array.from({ length: blob.size }, (_, k) => blob.entry(k))
    expect(new Set(entries)).toEqual(new Set(lowered(LISTS[1]!)))
    const at = entries.indexOf('bücher.example')
    expect(at).toBeGreaterThanOrEqual(0)
    // 'ü' is two bytes of UTF-8 and one code unit: the key is encoded before it is compared.
    expect(blob.compare(at, 'bücher.example')).toBe(0)
    expect(blob.compare(at, 'bücher.exampl')).toBeGreaterThan(0)
    expect(blob.compare(at, 'bücher.examplf')).toBeLessThan(0)
    expect(blob.contains(0, blob.size, 'bücher.example')).toBe(true)
    expect(blob.contains(0, blob.size, 'bucher.example')).toBe(false)
  })
})

describe('RuleTable', () => {
  const rules: Rule[] = [
    {
      id: 1,
      action: { type: 'block' },
      condition: { urlFilter: 'ads', requestDomains: ['A.example', 'b.example'] }
    },
    { id: 2, priority: 3, action: { type: 'allow' }, condition: { urlFilter: '||cdn.example^' } },
    {
      id: 3,
      priority: 3,
      action: { type: 'block' },
      condition: { regexFilter: '^https?://t\\.example/' }
    },
    { id: 4, action: { type: 'block' }, condition: { regexFilter: '(' } },
    {
      id: 5,
      action: { type: 'block' },
      condition: {
        urlFilter: 'Ads',
        isUrlFilterCaseSensitive: true,
        requestDomains: ['a.example', 'B.EXAMPLE']
      }
    },
    {
      id: 6,
      priority: 3,
      action: { type: 'allow' },
      condition: { excludedRequestDomains: ['b.example'] }
    }
  ]

  function facts(url: string): UrlFacts {
    return { url, lowerUrl: () => url.toLowerCase() }
  }

  it('counts the rules that compile and gives each a row in resolution order', () => {
    expect(compilableCount(rules)).toBe(5)
    const table = RuleTable.build('s', 2, rules)
    expect(table.size).toBe(5)
    // Priority 3 first, allow before block inside it (the lower row on a full tie is the rule the
    // set lists first), then the priority-1 rules in the set's order.
    expect(Array.from(table.source, (i) => rules[i]!.id)).toEqual([2, 6, 3, 1, 5])
    expect(table.effectiveOf(0)).toBe(2 * 2 ** 20 + 3)
    expect(table.effectiveOf(3)).toBe(2 * 2 ** 20 + 1)
    expect(table.rankOf(0)).toBeGreaterThan(table.rankOf(2))
    expect(table.action[0]).toBe(ACTION.allow)
    expect(table.ruleOf(4)).toBe(rules[4])
  })

  it('tests the URL by kind: plain substrings without regard to case, patterns compiled on first use, regexFilter compiled at build', () => {
    const table = RuleTable.build('s', 1, rules)
    const row = (id: number): number =>
      Array.from(table.source).findIndex((i) => rules[i]!.id === id)
    expect(table.urlKind[row(1)]).toBe(URL_KIND.plain)
    expect(table.urlMatches(row(1), facts('https://x.example/ADS/1'))).toBe(true)
    expect(table.urlKind[row(5)]).toBe(URL_KIND.plainCaseSensitive)
    expect(table.urlMatches(row(5), facts('https://x.example/ADS/1'))).toBe(false)
    expect(table.urlMatches(row(5), facts('https://x.example/Ads/1'))).toBe(true)
    expect(table.urlKind[row(2)]).toBe(URL_KIND.pattern)
    expect(table.regexFilterOf(row(2))).toBeNull()
    expect(table.urlMatches(row(2), facts('https://cdn.example/lib.js'))).toBe(true)
    expect(table.urlMatches(row(2), facts('https://cdn.example.net/lib.js'))).toBe(false)
    expect(table.urlKind[row(3)]).toBe(URL_KIND.regex)
    expect(table.regexFilterOf(row(3))).toBeInstanceOf(RegExp)
    expect(table.urlMatches(row(3), facts('http://t.example/x'))).toBe(true)
    expect(table.urlKind[row(6)]).toBe(URL_KIND.none)
    expect(table.urlMatches(row(6), facts('anything'))).toBe(true)
  })

  for (const form of FORMS) {
    it(`${form}: domain lists are lowercased, shared between rules with the same list and answered over a host's suffixes`, () => {
      const table = RuleTable.build('s', 1, rules, { domainLists: form })
      const row = (id: number): number =>
        Array.from(table.source).findIndex((i) => rules[i]!.id === id)
      // Rules 1 and 5 name the same two domains (in different case): one list between them.
      expect(table.requestDomains[row(1)]).toBe(table.requestDomains[row(5)])
      expect(table.requestDomainCount(row(1))).toBe(2)
      expect(new Set(table.requestDomainsOf(row(1))!)).toEqual(new Set(['a.example', 'b.example']))
      expect(table.requestDomains[row(2)]).toBe(-1)
      expect(table.requestDomainsOf(row(2))).toBeNull()
      const include = table.requestDomains[row(1)]!
      expect(table.matchesDomains(hostSuffixes('sub.a.example'), include, -1)).toBe(true)
      expect(table.matchesDomains(hostSuffixes('a.example.net'), include, -1)).toBe(false)
      expect(table.requestDomainsHasAny(row(1), hostSuffixes('b.example'))).toBe(true)
      const exclude = table.excludedRequestDomains[row(6)]!
      expect(exclude).toBeGreaterThanOrEqual(0)
      expect(table.matchesDomains(hostSuffixes('x.b.example'), -1, exclude)).toBe(false)
      expect(table.matchesDomains(hostSuffixes('x.c.example'), -1, exclude)).toBe(true)
    })
  }

  it('builds with sorted arrays unless told otherwise', () => {
    expect(DEFAULT_DOMAIN_LIST_FORM).toBe('sorted')
    const table = RuleTable.build('s', 1, rules)
    expect(table.domainLists[0]).toBeInstanceOf(SortedDomainList)
    expect(RuleTable.build('s', 1, rules, { domainLists: 'blob' }).domainLists[0]).toBeInstanceOf(
      BlobDomainList
    )
    expect(RuleTable.build('s', 1, rules, { domainLists: 'set' }).domainLists[0]).toBeInstanceOf(
      SetDomainList
    )
  })
})
