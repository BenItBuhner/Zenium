import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_ENGINES,
  EEA_SEARCH_CHOICE,
  SEARCH_CHOICE_ALIASES,
  SEARCH_CHOICE_EXTRA_ENGINES,
  SEARCH_CHOICE_FALLBACK,
  buildSearchUrl,
  buildSuggestUrl,
  engineHost,
  sanitizeSearchEngines,
  searchChoiceCountry,
  searchChoiceEngine,
  searchChoiceEngineIds,
  searchChoiceTagline,
  searchTemplateProblem,
  searchTermsFromUrl
} from '../search'

/*
 * The choice screen's engines and table (W6-2), verified by their documented shapes – Chromium's
 * `prepopulated_engines.json` and `regional_settings.json` at `effde84e` (data version 214),
 * the engines' own OpenSearch descriptions – and never by a request from wherever the tests
 * run: a query renders into each engine's documented results address, the suggest template
 * into its documented endpoint; the table has Chrome's thirty countries, eight engines each,
 * and the seventeen territories that take a member state's list.
 */

const QUERY = 'zen browser & co'
const ENCODED = 'zen%20browser%20%26%20co'

function extra(id: string): (typeof SEARCH_CHOICE_EXTRA_ENGINES)[number] {
  const engine = SEARCH_CHOICE_EXTRA_ENGINES.find((e) => e.id === id)
  if (!engine) throw new Error(`no extra engine ${id}`)
  return engine
}

describe('the extra engines', () => {
  it('render a query into each documented results address', () => {
    // `prepopulated_engines.json` `search_url`, `{searchTerms}` the query; Chrome's own
    // attribution parameters (`regulatory_extensions`) are not carried.
    expect(buildSearchUrl(extra('brave'), QUERY)).toBe(
      `https://search.brave.com/search?q=${ENCODED}`
    )
    expect(buildSearchUrl(extra('privacywall'), QUERY)).toBe(
      `https://www.privacywall.org/search/secure/?q=${ENCODED}`
    )
    expect(buildSearchUrl(extra('qwant'), QUERY)).toBe(`https://www.qwant.com/?q=${ENCODED}`)
    expect(buildSearchUrl(extra('seznam'), QUERY)).toBe(`https://search.seznam.cz/?q=${ENCODED}`)
    expect(buildSearchUrl(extra('startpage'), QUERY)).toBe(
      `https://www.startpage.com/sp/search?q=${ENCODED}`
    )
    expect(buildSearchUrl(extra('yep'), QUERY)).toBe(`https://yep.com/web?q=${ENCODED}`)
    // Yahoo's `search{google:pathWildcard}?ei={inputEncoding}&p={searchTerms}` per edition.
    expect(buildSearchUrl(extra('yahoo_de'), QUERY)).toBe(
      `https://de.search.yahoo.com/search?ei=UTF-8&p=${ENCODED}`
    )
    expect(buildSearchUrl(extra('yahoo_fr'), QUERY)).toBe(
      `https://fr.search.yahoo.com/search?ei=UTF-8&p=${ENCODED}`
    )
    expect(buildSearchUrl(extra('yahoo_emea'), QUERY)).toBe(
      `https://emea.search.yahoo.com/search?ei=UTF-8&p=${ENCODED}`
    )
    expect(buildSearchUrl(extra('yahoo_uk'), QUERY)).toBe(
      `https://uk.search.yahoo.com/search?ei=UTF-8&p=${ENCODED}`
    )
  })

  it('render a query into each documented suggest endpoint', () => {
    // `prepopulated_engines.json` `suggest_url`; Bing's and Ecosia's shipped templates stand.
    expect(buildSuggestUrl(extra('brave'), QUERY)).toBe(
      `https://search.brave.com/api/suggest?q=${ENCODED}&rich=true&rich_verticals=true`
    )
    expect(buildSuggestUrl(extra('privacywall'), QUERY)).toBe(
      `https://search.privacywall.org/suggest.php?q=${ENCODED}`
    )
    expect(buildSuggestUrl(extra('qwant'), QUERY)).toBe(
      `https://api.qwant.com/api/suggest/?q=${ENCODED}`
    )
    expect(buildSuggestUrl(extra('seznam'), QUERY)).toBe(
      `https://suggest.seznam.cz/fulltext_ff?phrase=${ENCODED}`
    )
    expect(buildSuggestUrl(extra('startpage'), QUERY)).toBe(
      `https://www.startpage.com/osuggestions?q=${ENCODED}`
    )
    expect(buildSuggestUrl(extra('yep'), QUERY)).toBe(
      `https://api.yep.com/ac/?query=${ENCODED}&os=true`
    )
    expect(buildSuggestUrl(extra('yahoo_it'), QUERY)).toBe(
      `https://it.search.yahoo.com/sugg/chrome?output=fxjson&command=${ENCODED}`
    )
  })

  it('are complete engines: https templates the form would accept, a shortcut, a glyph, an icon address', () => {
    expect(SEARCH_CHOICE_EXTRA_ENGINES).toHaveLength(17)
    const shipped = new Set(DEFAULT_SEARCH_ENGINES.map((e) => e.id))
    const ids = new Set<string>()
    for (const engine of SEARCH_CHOICE_EXTRA_ENGINES) {
      expect(shipped.has(engine.id), engine.id).toBe(false)
      expect(ids.has(engine.id), engine.id).toBe(false)
      ids.add(engine.id)
      expect(engine.name.trim().length, engine.id).toBeGreaterThan(0)
      expect(searchTemplateProblem(engine.searchUrl), engine.id).toBeNull()
      expect(engine.searchUrl, engine.id).toMatch(/^https:\/\//)
      expect(engine.suggestUrl, engine.id).toMatch(/^https:\/\/.*%s/)
      expect(searchTemplateProblem(engine.suggestUrl!), engine.id).toBeNull()
      expect(engine.keyword, engine.id).toMatch(/^@\S{1,64}$/)
      expect(engine.glyph, engine.id).toMatch(/^[A-Z]$/)
      expect(engine.favicon, engine.id).toMatch(/^https:\/\/.*\.ico$/)
      // The engine reads its own results page back: the template's `%s` names one parameter.
      expect(searchTermsFromUrl(engine, buildSearchUrl(engine, 'a b')), engine.id).toBe('a b')
      expect(engineHost(engine), engine.id).not.toBeNull()
    }
  })

  it("carry Yahoo's editions as one shape on the edition's host, the country's name where Yahoo has one", () => {
    const yahoos = SEARCH_CHOICE_EXTRA_ENGINES.filter((e) => e.id.startsWith('yahoo_'))
    expect(yahoos.map((e) => e.id)).toEqual([
      'yahoo_at',
      'yahoo_de',
      'yahoo_dk',
      'yahoo_emea',
      'yahoo_es',
      'yahoo_fi',
      'yahoo_fr',
      'yahoo_it',
      'yahoo_nl',
      'yahoo_se',
      'yahoo_uk'
    ])
    for (const y of yahoos) {
      const cc = y.id.slice('yahoo_'.length)
      expect(y.searchUrl).toBe(`https://${cc}.search.yahoo.com/search?ei=UTF-8&p=%s`)
      expect(y.suggestUrl).toBe(
        `https://${cc}.search.yahoo.com/sugg/chrome?output=fxjson&command=%s`
      )
      expect(y.favicon).toBe(`https://${cc}.search.yahoo.com/favicon.ico`)
      expect(y.keyword).toBe('@yahoo')
    }
    expect(extra('yahoo_es').name).toBe('Yahoo Búsquedas')
    expect(extra('yahoo_fr').name).toBe('Yahoo Recherche')
    expect(extra('yahoo_it').name).toBe('Ricerca di Yahoo')
    expect(extra('yahoo_de').name).toBe('Yahoo Search')
    expect(extra('yahoo_emea').name).toBe('Yahoo Search')
  })

  it("survive the settings' read as a user's engine, the icon address kept", () => {
    // What `choose` writes into `settings.searchEngines` is read back whole on every device.
    const stored = SEARCH_CHOICE_EXTRA_ENGINES.map((e) => ({ ...e, source: 'custom' as const }))
    const read = sanitizeSearchEngines(stored, 'brave')
    expect(read).toEqual(stored)
    expect(JSON.stringify(read)).not.toMatch(/data:/)
  })
})

describe('the table', () => {
  it("is Chrome's: thirty countries, eight engines each, every id resolving, Google first as the table has it", () => {
    const countries = Object.keys(EEA_SEARCH_CHOICE)
    expect(countries).toHaveLength(30)
    expect([...countries].sort()).toEqual([
      'AT',
      'BE',
      'BG',
      'CY',
      'CZ',
      'DE',
      'DK',
      'EE',
      'ES',
      'FI',
      'FR',
      'GR',
      'HR',
      'HU',
      'IE',
      'IS',
      'IT',
      'LI',
      'LT',
      'LU',
      'LV',
      'MT',
      'NL',
      'NO',
      'PL',
      'PT',
      'RO',
      'SE',
      'SI',
      'SK'
    ])
    for (const [country, ids] of Object.entries(EEA_SEARCH_CHOICE)) {
      expect(ids, country).toHaveLength(8)
      expect(new Set(ids).size, country).toBe(8)
      expect(ids[0], country).toBe('google')
      for (const id of ids) expect(searchChoiceEngine(id), `${country}: ${id}`).not.toBeNull()
      // Google, Bing, DuckDuckGo, Brave and Ecosia are on every country's list in this version.
      for (const id of ['google', 'bing', 'duckduckgo', 'brave', 'ecosia'])
        expect(ids, country).toContain(id)
      // At most one Yahoo edition per country (Liechtenstein's list has none).
      expect(
        ids.filter((id) => id.startsWith('yahoo_')),
        country
      ).toHaveLength(country === 'LI' ? 0 : 1)
    }
    expect(new Set(Object.values(EEA_SEARCH_CHOICE).flat()).size).toBe(21)
  })

  it("names the seventeen territories and each one's state", () => {
    expect(Object.keys(SEARCH_CHOICE_ALIASES)).toHaveLength(17)
    for (const [territory, state] of Object.entries(SEARCH_CHOICE_ALIASES)) {
      expect(territory, territory).toMatch(/^[A-Z]{2}$/)
      expect(EEA_SEARCH_CHOICE[state], territory).toBeDefined()
      expect(EEA_SEARCH_CHOICE[territory], territory).toBeUndefined()
    }
    expect(SEARCH_CHOICE_ALIASES).toMatchObject({
      AX: 'FI',
      EA: 'ES',
      IC: 'ES',
      SJ: 'NO',
      VA: 'IT'
    })
    const french = Object.entries(SEARCH_CHOICE_ALIASES)
      .filter(([, state]) => state === 'FR')
      .map(([t]) => t)
    expect(french.sort()).toEqual(
      ['BL', 'GF', 'GP', 'MF', 'MQ', 'NC', 'PF', 'PM', 'RE', 'TF', 'WF', 'YT'].sort()
    )
    // In Chromium's `map_aliases` but not on Chrome's EEA list: not here either.
    for (const code of ['SM', 'AD', 'FO', 'GL', 'GB', 'CH']) {
      expect(SEARCH_CHOICE_ALIASES[code]).toBeUndefined()
      expect(searchChoiceCountry(code)).toBeNull()
    }
  })

  it('resolves a region to its list: the state’s own, a territory’s through the alias, else the fallback', () => {
    expect(searchChoiceCountry('DE')).toBe('DE')
    expect(searchChoiceCountry('AX')).toBe('FI')
    expect(searchChoiceCountry('US')).toBeNull()
    expect(searchChoiceCountry('')).toBeNull()
    expect(searchChoiceCountry(null)).toBeNull()
    expect(searchChoiceCountry(undefined)).toBeNull()
    expect(searchChoiceEngineIds('DE')).toBe(EEA_SEARCH_CHOICE.DE)
    expect(searchChoiceEngineIds('YT')).toBe(EEA_SEARCH_CHOICE.FR)
    expect(searchChoiceEngineIds('US')).toBe(SEARCH_CHOICE_FALLBACK)
    expect(searchChoiceEngineIds(null)).toBe(SEARCH_CHOICE_FALLBACK)
    expect(SEARCH_CHOICE_FALLBACK).toEqual(['google', 'duckduckgo', 'ecosia', 'bing'])
    for (const id of SEARCH_CHOICE_FALLBACK)
      expect(
        DEFAULT_SEARCH_ENGINES.some((e) => e.id === id),
        id
      ).toBe(true)
  })

  it("gives each engine its line, in its own words or Chrome's neutral one", () => {
    for (const id of new Set(Object.values(EEA_SEARCH_CHOICE).flat())) {
      const engine = searchChoiceEngine(id)!
      const line = searchChoiceTagline(engine)
      expect(line.length, id).toBeGreaterThan(0)
      expect(line, id).not.toMatch(/Zen(ium)?/)
    }
    for (const id of ['seznam', 'startpage', 'yep'])
      expect(searchChoiceTagline(searchChoiceEngine(id)!)).toBe(
        `You can use ${searchChoiceEngine(id)!.name} to search the web.`
      )
    expect(searchChoiceTagline(extra('yahoo_se'))).toBe(searchChoiceTagline(extra('yahoo_es')))
  })
})
