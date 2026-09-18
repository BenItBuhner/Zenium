import {
  formatCurrency,
  formatDefinition,
  formatTimeIn,
  formatWeather,
  looksLikeEntity,
  parseCurrencyQuery,
  parseDefineQuery,
  parseForecast,
  parseFrankfurterRates,
  parseGeocoding,
  parseTimeQuery,
  parseWeatherQuery,
  parseWikipediaSummary,
  parseWiktionaryDefinitions,
  wikipediaTitle,
  type FrankfurterRates,
  type GeoPlace
} from '../shared/answers'
import type { NetHost } from './platform'

/** A row the omnibox shows for a question it could answer, or a Wikipedia entity. */
export interface AnswerRow {
  kind: 'answer' | 'entity'
  /** `currency`, `weather`, `time`, `define`, `entity`: stable across keystrokes. */
  id: string
  /** The answer (`= 92.14 EUR`, `12°C · Partly cloudy`) or the entity's name. */
  title: string
  /** The question restated, with the source; the entity's description. */
  subtitle: string
  url: string
  favicon: string | null
}

/** The keyless services behind the rows; a test replaces them (`ZEN_NET_ORIGIN` in the host). */
export const ANSWER_ENDPOINTS = {
  rates: 'https://api.frankfurter.dev/v1/latest',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  summary: 'https://en.wikipedia.org/api/rest_v1/page/summary/',
  definition: 'https://en.wiktionary.org/api/rest_v1/page/definition/'
}

/** Network time an answer may take before the popup goes on without it. */
export const ANSWER_BUDGET_MS = 700
const CACHE_CAP = 200
const DAY_MS = 86_400_000

class Cache<T> {
  private readonly map = new Map<string, T>()

  get(key: string): T | undefined {
    return this.map.get(key)
  }

  set(key: string, value: T): T {
    this.map.set(key, value)
    if (this.map.size > CACHE_CAP) this.map.delete(this.map.keys().next().value as string)
    return value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }
}

/**
 * Answers that need the network: currency (Frankfurter, ECB fixings), weather and local time
 * (Open-Meteo geocoding and forecast), definitions (Wiktionary) and Wikipedia entity rows.
 * Every lookup runs under the caller's signal and its own budget, caches what it learned
 * (misses too, so a keystroke never asks the same question twice) and never throws: the omnibox
 * shows the row when it arrives in time and nothing otherwise.
 */
export class AnswerService {
  private readonly rates = new Cache<FrankfurterRates | null>()
  private readonly places = new Cache<GeoPlace | null>()
  private readonly weather = new Cache<{ title: string; at: number } | null>()
  private readonly definitions = new Cache<string | null>()
  private readonly entities = new Cache<AnswerRow | null>()
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor(
    private readonly net: NetHost,
    private readonly now: () => number = () => Date.now(),
    private readonly endpoints = ANSWER_ENDPOINTS
  ) {}

  /**
   * A currency, weather, time or dictionary answer for `query`, or null. `searchUrl` is what
   * Enter opens on an answer row (the search for the question, like Chrome).
   */
  async answer(query: string, searchUrl: string, signal: AbortSignal): Promise<AnswerRow | null> {
    const q = query.trim()
    if (!q) return null
    const currency = parseCurrencyQuery(q)
    if (currency) return this.currency(currency, searchUrl, signal)
    const weatherPlace = parseWeatherQuery(q)
    if (weatherPlace) return this.weatherIn(weatherPlace, searchUrl, signal)
    const timePlace = parseTimeQuery(q)
    if (timePlace) return this.timeIn(timePlace, searchUrl, signal)
    const word = parseDefineQuery(q)
    if (word) return this.define(word, signal)
    return null
  }

  /** The Wikipedia entity `query` names (`wikipedia` → the encyclopedia's own article), or null. */
  async entity(query: string, signal: AbortSignal): Promise<AnswerRow | null> {
    const q = query.trim()
    if (!looksLikeEntity(q)) return null
    const title = wikipediaTitle(q)
    if (!title) return null
    const key = title.toLowerCase()
    if (this.entities.has(key)) return this.entities.get(key) ?? null
    const body = await this.json(`${this.endpoints.summary}${encodeURIComponent(title)}`, signal)
    if (body === undefined) return null
    const summary = parseWikipediaSummary(body)
    const row: AnswerRow | null = summary
      ? {
          kind: 'entity',
          id: 'entity',
          title: summary.title,
          subtitle: summary.description,
          url: summary.url,
          favicon: summary.thumbnail
        }
      : null
    return this.entities.set(key, row)
  }

  private async currency(
    ask: { amount: number; from: string; to: string },
    searchUrl: string,
    signal: AbortSignal
  ): Promise<AnswerRow | null> {
    const key = ask.from
    let rates = this.rates.get(key)
    // ECB fixings change once a day; yesterday's table is refreshed on the first ask of the day.
    const stale = rates && this.now() - Date.parse(rates.date) > 2 * DAY_MS
    if (rates === undefined || stale) {
      const body = await this.json(`${this.endpoints.rates}?base=${ask.from}`, signal)
      if (body === undefined) return null
      rates = this.rates.set(key, parseFrankfurterRates(body))
    }
    const rate = rates?.rates[ask.to]
    if (!rates || rate === undefined) return null
    return {
      kind: 'answer',
      id: 'currency',
      title: formatCurrency(ask.amount * rate, ask.to),
      subtitle: `${formatAmount(ask.amount)} ${ask.from} · ECB rate of ${rates.date} · Frankfurter`,
      url: searchUrl,
      favicon: null
    }
  }

  private async geocode(place: string, signal: AbortSignal): Promise<GeoPlace | null> {
    const key = place.toLowerCase()
    if (this.places.has(key)) return this.places.get(key) ?? null
    const url = `${this.endpoints.geocoding}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`
    const body = await this.json(url, signal)
    if (body === undefined) return null
    return this.places.set(key, parseGeocoding(body))
  }

  private async weatherIn(
    place: string,
    searchUrl: string,
    signal: AbortSignal
  ): Promise<AnswerRow | null> {
    const geo = await this.geocode(place, signal)
    if (!geo) return null
    const key = `${geo.latitude},${geo.longitude}`
    let current = this.weather.get(key)
    if (current === undefined || (current && this.now() - current.at > 15 * 60_000)) {
      const url =
        `${this.endpoints.forecast}?latitude=${geo.latitude}&longitude=${geo.longitude}` +
        '&current=temperature_2m,weather_code,wind_speed_10m'
      const body = await this.json(url, signal)
      if (body === undefined) return null
      const parsed = parseForecast(body)
      current = this.weather.set(
        key,
        parsed ? { title: formatWeather(parsed), at: this.now() } : null
      )
    }
    if (!current) return null
    return {
      kind: 'answer',
      id: 'weather',
      title: current.title,
      subtitle: `Weather in ${geo.label} · Open-Meteo`,
      url: searchUrl,
      favicon: null
    }
  }

  private async timeIn(
    place: string,
    searchUrl: string,
    signal: AbortSignal
  ): Promise<AnswerRow | null> {
    const geo = await this.geocode(place, signal)
    if (!geo) return null
    const text = formatTimeIn(geo.timezone, this.now())
    if (!text) return null
    return {
      kind: 'answer',
      id: 'time',
      title: text,
      subtitle: `Time in ${geo.label} (${geo.timezone})`,
      url: searchUrl,
      favicon: null
    }
  }

  private async define(word: string, signal: AbortSignal): Promise<AnswerRow | null> {
    const key = word.toLowerCase()
    const url = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`
    let text = this.definitions.get(key)
    if (text === undefined) {
      const body = await this.json(
        `${this.endpoints.definition}${encodeURIComponent(word)}`,
        signal
      )
      if (body === undefined) return null
      const senses = parseWiktionaryDefinitions(body)
      text = this.definitions.set(key, senses.length ? formatDefinition(senses[0]) : null)
    }
    if (!text) return null
    return {
      kind: 'answer',
      id: 'define',
      title: text,
      subtitle: `Definition of “${word}” · Wiktionary`,
      url,
      favicon: null
    }
  }

  /**
   * GET `url` as JSON within the budget. `undefined` means the network did not answer (aborted,
   * timed out, failed) and nothing should be cached; `null` a response that was not JSON.
   * Identical URLs in flight share one request.
   */
  private json(url: string, signal: AbortSignal): Promise<unknown> {
    const pending = this.inFlight.get(url)
    if (pending) return pending
    const request = (async (): Promise<unknown> => {
      try {
        const res = await this.net.fetchText(url, {
          signal,
          timeoutMs: ANSWER_BUDGET_MS,
          headers: { accept: 'application/json' }
        })
        if (!res.ok) return res.status === 404 ? null : undefined
        try {
          return JSON.parse(res.text) as unknown
        } catch {
          return null
        }
      } catch {
        return undefined
      } finally {
        this.inFlight.delete(url)
      }
    })()
    this.inFlight.set(url, request)
    return request
  }
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)
}
