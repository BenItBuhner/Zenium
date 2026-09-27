import { describe, expect, it, vi } from 'vitest'
import {
  DEFINE_CACHE_TTL_MS,
  DEFINE_MAX_DEFINITIONS,
  DEFINE_MAX_EXAMPLES,
  DEFINE_MAX_TEXT_CHARS,
  DefineService,
  WIKTIONARY_DEFINITION_ENDPOINT,
  definitionLanguageOf,
  isDefinableTerm,
  parseDefinitionResponse,
  stripHtml,
  wiktionaryPageUrl
} from '../define'
import { FOAM_RESPONSE, NOT_FOUND_RESPONSE } from './wiktionaryFixture'
import type { Browser } from '../browser'

/*
 * Define (CT-39, `core/define.ts`): Wiktionary's REST definitions parsed on a real answer
 * captured once (`wiktionaryFixture.ts`), the typed refusals, the day-long cache. No test
 * touches the network: the host's `fetchText` is a fake.
 */

type FetchText = Browser['platform']['net']['fetchText']
type FetchAnswer = Awaited<ReturnType<FetchText>>

function service(
  answer: (url: string, options: Parameters<FetchText>[1]) => Promise<FetchAnswer>,
  opts: { languages?: string[]; now?: () => number } = {}
): { define: DefineService; fetchText: ReturnType<typeof vi.fn> } {
  const fetchText = vi.fn(answer)
  const languages = opts.languages ?? ['en-GB', 'fr']
  const browser = {
    languages: { list: languages, acceptLanguage: () => languages.join(',') },
    platform: { net: { fetchText } }
  } as unknown as Browser
  return { define: new DefineService(browser, { now: opts.now }), fetchText }
}

const ok = (text: string): Promise<FetchAnswer> => Promise.resolve({ ok: true, status: 200, text })
const status = (code: number, text = ''): Promise<FetchAnswer> =>
  Promise.resolve({ ok: false, status: code, text })

describe('isDefinableTerm', () => {
  it('takes one to three words with a letter, folded and trimmed', () => {
    expect(isDefinableTerm('foam')).toBe(true)
    expect(isDefinableTerm('  quantum   foam ')).toBe(true)
    expect(isDefinableTerm('ice cream cone')).toBe(true)
    expect(isDefinableTerm('Straße')).toBe(true)
    expect(isDefinableTerm('日本語')).toBe(true)
  })

  it('refuses longer phrases, numbers alone, addresses and paths', () => {
    expect(isDefinableTerm('')).toBe(false)
    expect(isDefinableTerm('one two three four')).toBe(false)
    expect(isDefinableTerm('2026')).toBe(false)
    expect(isDefinableTerm('example.org/docs')).toBe(false)
    expect(isDefinableTerm('https://example.org')).toBe(false)
    expect(isDefinableTerm('@someone')).toBe(false)
    expect(isDefinableTerm('a'.repeat(81))).toBe(false)
  })
})

describe('stripHtml', () => {
  it('drops tags, decodes entities, folds whitespace and cuts at the cap', () => {
    expect(
      stripHtml(
        'To <a rel="mw:WikiLink" href="/wiki/x">form</a> or &amp; emit <i>foam</i>&nbsp;&#8230;<span></span>  end'
      )
    ).toBe('To form or & emit foam \u2026 end')
    expect(stripHtml('&#x41;&#66; &unknown; &lt;b&gt;')).toBe('AB &unknown; <b>')
    const long = stripHtml('x'.repeat(DEFINE_MAX_TEXT_CHARS + 50))
    expect(long).toHaveLength(DEFINE_MAX_TEXT_CHARS)
    expect(long.endsWith('\u2026')).toBe(true)
  })
})

describe('definitionLanguageOf / wiktionaryPageUrl', () => {
  it('takes the tag\u2019s language and links the term\u2019s page with underscores', () => {
    expect(definitionLanguageOf('en-US')).toBe('en')
    expect(definitionLanguageOf('pt-BR')).toBe('pt')
    expect(definitionLanguageOf(undefined)).toBe('en')
    expect(definitionLanguageOf('')).toBe('en')
    expect(wiktionaryPageUrl(' ice  cream ')).toBe('https://en.wiktionary.org/wiki/ice_cream')
    expect(wiktionaryPageUrl('Straße')).toBe('https://en.wiktionary.org/wiki/Stra%C3%9Fe')
  })
})

describe('parseDefinitionResponse on the captured answer for "foam"', () => {
  it('reads the English section: the noun and the verb, senses as plain text with their examples', () => {
    const result = parseDefinitionResponse(FOAM_RESPONSE, 'foam', 'en')!
    expect(result.term).toBe('foam')
    expect(result.lang).toBe('en')
    expect(result.entries.map((e) => [e.partOfSpeech, e.language, e.definitions.length])).toEqual([
      ['Noun', 'English', DEFINE_MAX_DEFINITIONS],
      ['Verb', 'English', 3]
    ])
    const [first] = result.entries[0].definitions
    expect(first.text).toBe(
      'A substance composed of a large collection of bubbles or their solidified remains, especially:'
    )
    expect(first.examples).toEqual(['His specialty is a mango foam.'])
    expect(result.entries[0].definitions[1].examples).toEqual([])
    for (const entry of result.entries)
      for (const sense of entry.definitions) {
        expect(sense.text).not.toMatch(/<|&[a-z#]+;/)
        expect(sense.examples.length).toBeLessThanOrEqual(DEFINE_MAX_EXAMPLES)
      }
    // The verb's senses open with an empty label span in the HTML; nothing of it survives.
    expect(result.entries[1].definitions[0].text).toMatch(/^To form or/)
    expect(result.attribution).toEqual({
      source: 'Wiktionary',
      licence: 'CC BY-SA 4.0',
      url: 'https://en.wiktionary.org/wiki/foam'
    })
  })

  it('shows the reader\u2019s language section when the page has one, and English else', () => {
    const spanish = parseDefinitionResponse(FOAM_RESPONSE, 'foam', 'es')!
    expect(spanish.lang).toBe('es')
    expect(spanish.entries.map((e) => [e.partOfSpeech, e.language])).toEqual([['Noun', 'Spanish']])
    expect(parseDefinitionResponse(FOAM_RESPONSE, 'foam', 'de')!.lang).toBe('en')
  })

  it('is null for text that is not the definition JSON, or holds no sense with text', () => {
    expect(parseDefinitionResponse('<!doctype html><p>Wikimedia Error</p>', 'foam', 'en')).toBeNull()
    expect(parseDefinitionResponse('[]', 'foam', 'en')).toBeNull()
    expect(parseDefinitionResponse('null', 'foam', 'en')).toBeNull()
    expect(parseDefinitionResponse(NOT_FOUND_RESPONSE, 'foam', 'en')).toBeNull()
    expect(
      parseDefinitionResponse(
        JSON.stringify({ en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: '<span></span>' }] }] }),
        'foam',
        'en'
      )
    ).toBeNull()
  })
})

describe('DefineService.lookup', () => {
  it('asks English Wiktionary with Accept-Language and an Api-User-Agent, and answers the reader\u2019s section', async () => {
    const { define, fetchText } = service(() => ok(FOAM_RESPONSE), { languages: ['es-MX', 'en'] })
    const answer = await define.lookup(' foam ')
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.result.lang).toBe('es')
    expect(fetchText).toHaveBeenCalledTimes(1)
    const [url, options] = fetchText.mock.calls[0] as Parameters<FetchText>
    expect(url).toBe(`${WIKTIONARY_DEFINITION_ENDPOINT}foam`)
    expect(options.headers).toEqual({
      Accept: 'application/json',
      'Accept-Language': 'es-MX,en',
      'Api-User-Agent': 'Zenium (https://github.com/BenItBuhner/Zenium)'
    })
    expect(options.timeoutMs).toBeGreaterThan(0)
    expect(options.maxBytes).toBeGreaterThan(0)
  })

  it('encodes a two-word term and takes an explicit language over the reader\u2019s', async () => {
    const { define, fetchText } = service(() => ok(FOAM_RESPONSE))
    const answer = await define.lookup('sea foam', 'es')
    expect(fetchText.mock.calls[0][0]).toBe(`${WIKTIONARY_DEFINITION_ENDPOINT}sea%20foam`)
    expect(answer.ok && answer.result.lang).toBe('es')
    expect(answer.ok && answer.result.term).toBe('sea foam')
  })

  it('refuses a term that is not one to define without asking the network', async () => {
    const { define, fetchText } = service(() => ok(FOAM_RESPONSE))
    expect(await define.lookup('one two three four')).toEqual({ ok: false, reason: 'invalid-term' })
    expect(await define.lookup('https://example.org')).toEqual({ ok: false, reason: 'invalid-term' })
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('types the refusals: 404, the network down, an error status, a body that is not the JSON', async () => {
    expect(await service(() => status(404, NOT_FOUND_RESPONSE)).define.lookup('xqzvtplk')).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(await service(() => Promise.reject(new Error('ENETDOWN'))).define.lookup('foam')).toEqual({
      ok: false,
      reason: 'offline'
    })
    expect(await service(() => status(0)).define.lookup('foam')).toEqual({ ok: false, reason: 'offline' })
    expect(await service(() => status(501, NOT_FOUND_RESPONSE)).define.lookup('foam')).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(await service(() => ok('<!doctype html>')).define.lookup('foam')).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('keeps an answer and a not-found for a day per term and language, never a failure', async () => {
    let clock = 1_000_000
    let mode: 'ok' | 'missing' | 'down' = 'ok'
    const { define, fetchText } = service(
      () => (mode === 'ok' ? ok(FOAM_RESPONSE) : mode === 'missing' ? status(404) : status(0)),
      { now: () => clock }
    )
    await define.lookup('foam')
    await define.lookup('foam')
    await define.lookup('FOAM')
    expect(fetchText).toHaveBeenCalledTimes(2)
    await define.lookup('foam', 'es')
    expect(fetchText).toHaveBeenCalledTimes(3)
    mode = 'missing'
    await define.lookup('nonce')
    await define.lookup('nonce')
    expect(fetchText).toHaveBeenCalledTimes(4)
    mode = 'down'
    expect(await define.lookup('other')).toEqual({ ok: false, reason: 'offline' })
    await define.lookup('other')
    expect(fetchText).toHaveBeenCalledTimes(6)
    clock += DEFINE_CACHE_TTL_MS
    mode = 'ok'
    await define.lookup('foam')
    expect(fetchText).toHaveBeenCalledTimes(7)
  })
})
