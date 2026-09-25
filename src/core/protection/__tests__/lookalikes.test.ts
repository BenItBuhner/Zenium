// The bundled tables are read from disk the way a host reads them: a test's fixture, not core code.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line no-restricted-imports
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  LookalikeChecker,
  MAX_TOP_DOMAINS,
  MIN_EDIT_TARGET_LENGTH,
  decodePunycodeLabel,
  describeLookalikeReason,
  isEditDistanceOne,
  parseConfusables,
  skeletonOf,
  unicodeHost,
  type LookalikeContext,
  type LookalikeTables
} from '../lookalikes'

/** The tables the build ships (`resources/lookalikes`), as the hosts hand them to the core. */
function bundled(name: string): string {
  const path = fileURLToPath(
    new URL(`../../../../resources/lookalikes/${name}.txt.gz`, import.meta.url)
  )
  return gunzipSync(readFileSync(path)).toString('utf8')
}

const TABLES: LookalikeTables = {
  topDomains: bundled('tranco-top'),
  confusables: bundled('confusables')
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../resources/lookalikes/manifest.json', import.meta.url)),
    'utf8'
  )
) as {
  tables: Array<{ id: string; entries: number; licence: string; listId?: string; date?: string }>
}

function context(
  engaged: string[] = [],
  allowed: string[] = []
): LookalikeContext & { asked: string[] } {
  const asked: string[] = []
  return {
    engaged: new Set(engaged),
    allowed: (host) => {
      asked.push(host)
      return allowed.includes(host)
    },
    asked
  }
}

function loaded(): LookalikeChecker {
  const checker = new LookalikeChecker()
  checker.load(TABLES)
  return checker
}

describe('the bundled tables', () => {
  it('are the Tranco top list and the Latin-target confusables the manifest describes', () => {
    const top = manifest.tables.find((t) => t.id === 'tranco-top')!
    const confusables = manifest.tables.find((t) => t.id === 'confusables')!
    expect(top.listId).toMatch(/^[A-Z0-9]{5}$/)
    expect(top.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(confusables.licence).toMatch(/Unicode/)
    const checker = loaded()
    expect(checker.ready).toBe(true)
    expect(checker.topCount).toBe(top.entries)
    expect(checker.topCount).toBeLessThanOrEqual(MAX_TOP_DOMAINS)
    for (const domain of ['google.com', 'paypal.com', 'apple.com', 'microsoft.com', 'bing.com'])
      expect(checker.isTopDomain(domain), domain).toBe(true)
    const map = parseConfusables(TABLES.confusables)
    expect(map.size).toBe(confusables.entries)
    // Every prototype spells hostname characters; no row maps a character to itself.
    for (const [source, target] of map) {
      expect(target).toMatch(/^[a-z0-9-]+$/)
      expect(source).not.toBe(target)
      expect([...source].length).toBeLessThanOrEqual(2)
    }
    expect(map.get('\u0430')).toBe('a') // Cyrillic а
    expect(map.get('0')).toBe('o')
    expect(map.get('1')).toBe('l')
    expect(map.get('m')).toBe('rn') // UTS #39: m's prototype is rn
  })

  it('reads a ranked CSV or a bare list, lowercases, skips comments and stops at the cap', () => {
    const checker = new LookalikeChecker()
    expect(checker.ready).toBe(false)
    expect(checker.check('https://gogle.com/', context())).toBeNull()
    checker.load({
      topDomains: '# a comment\n1,Google.com\n2,paypal.com\nexample.org\nnot-a-domain\n',
      confusables: ''
    })
    expect(checker.topCount).toBe(3)
    expect(checker.isTopDomain('google.com')).toBe(true)
    expect(checker.isTopDomain('example.org')).toBe(true)
    expect(checker.isTopDomain('not-a-domain')).toBe(false)
    const many = Array.from({ length: MAX_TOP_DOMAINS + 50 }, (_, i) => `site${i}.com`).join('\n')
    checker.load({ topDomains: many, confusables: '' })
    expect(checker.topCount).toBe(MAX_TOP_DOMAINS)
  })
})

describe('the three tests', () => {
  it('finds a Damerau distance of exactly one and nothing else', () => {
    expect(isEditDistanceOne('gogle.com', 'google.com')).toBe(true) // dropped
    expect(isEditDistanceOne('googlee.com', 'google.com')).toBe(true) // inserted
    expect(isEditDistanceOne('gooogle.com', 'google.com')).toBe(true)
    expect(isEditDistanceOne('amazom.com', 'amazon.com')).toBe(true) // substituted
    expect(isEditDistanceOne('googel.com', 'google.com')).toBe(true) // swapped
    expect(isEditDistanceOne('google.com', 'google.com')).toBe(false)
    expect(isEditDistanceOne('g00gle.com', 'google.com')).toBe(false) // two
    expect(isEditDistanceOne('goggle.co', 'google.com')).toBe(false)
    expect(isEditDistanceOne('gogle.com', 'google.co.uk')).toBe(false)
    expect(isEditDistanceOne('ab', 'ba')).toBe(true)
    expect(isEditDistanceOne('abc', 'cba')).toBe(false)
  })

  it('skeletonises through the confusables, two-character runs first', () => {
    const map = parseConfusables(TABLES.confusables)
    expect(skeletonOf('g00gle.com', map)).toBe(skeletonOf('google.com', map))
    expect(skeletonOf('paypa1.com', map)).toBe(skeletonOf('paypal.com', map))
    expect(skeletonOf('\u0430pple.com', map)).toBe(skeletonOf('apple.com', map))
    expect(skeletonOf('rnicrosoft.com', map)).toBe(skeletonOf('microsoft.com', map))
    expect(skeletonOf('microsoft.com', map)).toBe('rnicrosoft.corn')
    expect(skeletonOf('google.com', map)).not.toBe(skeletonOf('yahoo.com', map))
  })

  it('decodes Punycode labels to the characters the user saw', () => {
    const cyrillic = new URL('https://\u0430pple.com/').hostname
    expect(cyrillic).toMatch(/^xn--/)
    expect(decodePunycodeLabel(cyrillic.split('.')[0])).toBe('\u0430pple')
    expect(decodePunycodeLabel('xn--mnchen-3ya')).toBe('m\u00fcnchen')
    expect(decodePunycodeLabel('xn--80ak6aa92e')).toBe('\u0430\u0440\u0440\u04cf\u0435')
    expect(decodePunycodeLabel('plain')).toBe('plain')
    expect(decodePunycodeLabel('xn--')).toBe('xn--')
    expect(decodePunycodeLabel('xn--\u00e9')).toBe('xn--\u00e9')
    expect(unicodeHost('www.xn--mnchen-3ya.de')).toBe('www.m\u00fcnchen.de')
    expect(unicodeHost('www.google.com')).toBe('www.google.com')
  })
})

describe('LookalikeChecker.check: the table', () => {
  const checker = loaded()
  const cases: Array<
    [url: string, verdict: { target: string; reason: string } | null, why: string]
  > = [
    ['https://google.com/', null, 'the target itself'],
    ['https://www.google.com/search?q=x', null, 'a subdomain of the target'],
    [
      'https://gogle.com/',
      { target: 'google.com', reason: 'edit-distance' },
      'a dropped character'
    ],
    ['https://googlee.com/', { target: 'google.com', reason: 'edit-distance' }, 'an inserted one'],
    ['https://g00gle.com/', { target: 'google.com', reason: 'skeleton' }, 'digits for letters'],
    ['https://paypa1.com/', { target: 'paypal.com', reason: 'skeleton' }, 'a one for an l'],
    ['https://rnicrosoft.com/', { target: 'microsoft.com', reason: 'skeleton' }, 'rn for m'],
    [
      'https://paypal.com.evil.example/login',
      { target: 'paypal.com', reason: 'embedding' },
      'the target as a run of labels'
    ],
    [
      'https://paypal-login.com/',
      { target: 'paypal.com', reason: 'embedding' },
      'the target as the hyphen-joined start of a label'
    ],
    ['https://google.co/', null, 'a difference in the suffix alone'],
    ['https://bimg.com/', null, 'a neighbour of a four-character name (bing.com)'],
    ['http://localhost:3000/gogle.com', null, 'a non-unique host'],
    ['http://127.0.0.1/', null, 'an IP literal'],
    ['zen://error?kind=lookalike&url=https://gogle.com/', null, 'not http(s)'],
    ['https://gogle/', null, 'a single label']
  ]
  for (const [url, verdict, why] of cases)
    it(`${verdict ? 'warns' : 'is quiet'} for ${url} (${why})`, () => {
      expect(checker.check(url, context())).toEqual(verdict)
    })

  it('warns for an IDN spelled in look-alike characters, naming the Latin target', () => {
    const url = new URL('https://\u0430pple.com/').href // Cyrillic а
    expect(url).toContain('xn--')
    expect(checker.check(url, context())).toEqual({ target: 'apple.com', reason: 'skeleton' })
  })

  it('never warns about an engaged site, and takes engaged sites as targets in their own right', () => {
    // The user typed gogle.com often enough: it is their site, not a lookalike.
    expect(checker.check('https://gogle.com/', context(['gogle.com']))).toBeNull()
    // A site with engagement is a target: its one-off neighbour is a lookalike of it.
    expect(checker.check('https://mybamk.example/', context(['mybank.example']))).toEqual({
      target: 'mybank.example',
      reason: 'edit-distance'
    })
    expect(
      checker.check('https://mybank.example.evil.example/', context(['mybank.example']))
    ).toEqual({ target: 'mybank.example', reason: 'embedding' })
    expect(checker.check('https://myb\u0430nk.example/', context(['mybank.example']))).toEqual({
      target: 'mybank.example',
      reason: 'skeleton'
    })
    // Below the length floor an engaged name is nobody's target either.
    expect('bank'.length).toBeLessThan(MIN_EDIT_TARGET_LENGTH)
    expect(checker.check('https://bamk.example/', context(['bank.example']))).toBeNull()
  })

  it('never warns about a host the user continued to, asking by host and by domain', () => {
    const ctx = context([], ['gogle.com'])
    expect(checker.check('https://gogle.com/again', ctx)).toBeNull()
    expect(ctx.asked).toContain('gogle.com')
    const sub = context([], ['www.gogle.com'])
    expect(checker.check('https://www.gogle.com/', sub)).toBeNull()
    // Another host of the same lookalike domain that was not allowed still asks.
    expect(checker.check('https://mail.gogle.com/', context([], ['www.gogle.com']))).toEqual({
      target: 'google.com',
      reason: 'edit-distance'
    })
  })

  it('keeps the top list quiet about itself, whatever the neighbours in it', () => {
    let warned = 0
    for (const raw of TABLES.topDomains.split('\n')) {
      const domain = raw.trim()
      if (!domain || domain.startsWith('#')) continue
      if (checker.check(`https://${domain}/`, context())) warned++
    }
    expect(warned).toBe(0)
  })

  it('words each reason for the page', () => {
    expect(describeLookalikeReason('edit-distance', 'gogle.com', 'google.com')).toBe(
      'gogle.com is one character off google.com.'
    )
    expect(describeLookalikeReason('embedding', 'paypal-login.com', 'paypal.com')).toContain(
      'contains the name paypal.com'
    )
    expect(describeLookalikeReason('skeleton', 'g00gle.com', 'google.com')).toContain(
      'characters that look like'
    )
  })
})
