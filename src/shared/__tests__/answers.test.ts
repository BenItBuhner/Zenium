import { describe, expect, it } from 'vitest'
import {
  convertUnits,
  evaluateMath,
  findCurrency,
  formatCurrency,
  formatDefinition,
  formatNumber,
  formatTimeIn,
  formatWeather,
  localAnswer,
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
  wikipediaTitle
} from '../answers'

describe('evaluateMath', () => {
  it('evaluates arithmetic with precedence, parentheses and powers', () => {
    expect(evaluateMath('2+2')).toBe(4)
    expect(evaluateMath('2 + 3 * 4')).toBe(14)
    expect(evaluateMath('(2 + 3) * 4')).toBe(20)
    expect(evaluateMath('2^10')).toBe(1024)
    expect(evaluateMath('2**3')).toBe(8)
    expect(evaluateMath('10/4')).toBe(2.5)
    expect(evaluateMath('7 % 3')).toBe(1)
    expect(evaluateMath('-3 + 5')).toBe(2)
    expect(evaluateMath('3x4')).toBe(12)
    expect(evaluateMath('3 × 4 ÷ 2')).toBe(6)
    expect(evaluateMath('1,000 + 1')).toBe(1001)
  })

  it('knows a few functions and constants', () => {
    expect(evaluateMath('sqrt(16)')).toBe(4)
    expect(evaluateMath('abs(-2)')).toBe(2)
    expect(evaluateMath('2*pi')).toBeCloseTo(Math.PI * 2)
    expect(evaluateMath('log(1000)')).toBeCloseTo(3)
  })

  it('does not treat plain numbers, dates, versions or words as calculations', () => {
    expect(evaluateMath('2020')).toBeNull()
    expect(evaluateMath('-5')).toBeNull()
    expect(evaluateMath('1.5')).toBeNull()
    expect(evaluateMath('(5)')).toBeNull()
    expect(evaluateMath('12/03/2024')).toBeNull()
    expect(evaluateMath('1.2.3')).toBeNull()
    expect(evaluateMath('hello')).toBeNull()
    expect(evaluateMath('exp')).toBeNull()
  })

  it('rejects unfinished or non-finite expressions', () => {
    expect(evaluateMath('2+')).toBeNull()
    expect(evaluateMath('2+*3')).toBeNull()
    expect(evaluateMath('(2+3')).toBeNull()
    expect(evaluateMath('1/0')).toBeNull()
    expect(evaluateMath('sqrt(-1)')).toBeNull()
    expect(evaluateMath('foo(2)')).toBeNull()
  })
})

describe('formatNumber', () => {
  it('trims to significant digits without grouping', () => {
    expect(formatNumber(4)).toBe('4')
    expect(formatNumber(10 / 3)).toBe('3.333333333')
    expect(formatNumber(1_000_000)).toBe('1000000')
    expect(formatNumber(6.2137119, 6)).toBe('6.21371')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
  })
})

describe('convertUnits', () => {
  it('converts length, mass, data, speed, area, volume and time', () => {
    expect(convertUnits('10 km in miles')?.text).toBe('= 6.21371 miles')
    expect(convertUnits('5 miles to km')?.text).toBe('= 8.04672 kilometers')
    expect(convertUnits('1 mile in km')?.text).toBe('= 1.60934 kilometers')
    expect(convertUnits('10 pounds in kg')?.text).toBe('= 4.53592 kilograms')
    expect(convertUnits('1 gb in mb')?.text).toBe('= 1000 megabytes')
    expect(convertUnits('1 GiB to MiB')?.text).toBe('= 1024 mebibytes')
    expect(convertUnits('100 km/h in mph')?.text).toBe('= 62.1371 miles per hour')
    expect(convertUnits('1 acre in square meters')?.text).toBe('= 4046.86 square meters')
    expect(convertUnits('2 cups in ml')?.text).toBe('= 473.176 milliliters')
    expect(convertUnits('90 minutes in hours')?.text).toBe('= 1.5 hours')
    expect(convertUnits('1 fl oz in ml')?.text).toBe('= 29.5735 milliliters')
  })

  it('converts temperatures with offsets', () => {
    expect(convertUnits('72 f in c')?.text).toBe('= 22.2222 degrees Celsius')
    expect(convertUnits('100 celsius to fahrenheit')?.text).toBe('= 212 degrees Fahrenheit')
    expect(convertUnits('0 c in k')?.text).toBe('= 273.15 kelvin')
  })

  it('uses the singular for exactly one and accepts a number glued to its unit', () => {
    expect(convertUnits('1.609344 km in miles')?.text).toBe('= 1 mile')
    expect(convertUnits('10km in miles')?.text).toBe('= 6.21371 miles')
  })

  it('refuses mismatched or unknown units and same-unit conversions', () => {
    expect(convertUnits('10 km in kg')).toBeNull()
    expect(convertUnits('10 km in miles per hour')).toBeNull()
    expect(convertUnits('10 furlongs in miles')).toBeNull()
    expect(convertUnits('10 km in km')).toBeNull()
    expect(convertUnits('100 usd to eur')).toBeNull()
    expect(convertUnits('weather in paris')).toBeNull()
  })
})

describe('localAnswer', () => {
  it('prefers a unit conversion, then a calculation, else nothing', () => {
    expect(localAnswer('10 km in miles')).toEqual({ kind: 'unit', text: '= 6.21371 miles' })
    expect(localAnswer('2+2')).toEqual({ kind: 'calculator', text: '= 4' })
    expect(localAnswer('github')).toBeNull()
    expect(localAnswer('')).toBeNull()
  })
})

describe('currency', () => {
  it('reads amount and codes from the common shapes', () => {
    expect(parseCurrencyQuery('100 usd to eur')).toEqual({ amount: 100, from: 'USD', to: 'EUR' })
    expect(parseCurrencyQuery('$100 in euros')).toEqual({ amount: 100, from: 'USD', to: 'EUR' })
    expect(parseCurrencyQuery('100€ in usd')).toEqual({ amount: 100, from: 'EUR', to: 'USD' })
    expect(parseCurrencyQuery('1,500 dollars in yen')).toEqual({
      amount: 1500,
      from: 'USD',
      to: 'JPY'
    })
    expect(parseCurrencyQuery('usd to gbp')).toEqual({ amount: 1, from: 'USD', to: 'GBP' })
    expect(parseCurrencyQuery('10 pounds in euros')).toEqual({ amount: 10, from: 'GBP', to: 'EUR' })
  })

  it('gives null when a side is not a currency or both are the same', () => {
    expect(parseCurrencyQuery('100 usd to usd')).toBeNull()
    expect(parseCurrencyQuery('10 km in miles')).toBeNull()
    expect(parseCurrencyQuery('weather in paris')).toBeNull()
    expect(parseCurrencyQuery('2+2')).toBeNull()
    expect(findCurrency('dollars')).toBe('USD')
    expect(findCurrency('miles')).toBeNull()
  })

  it('formats amounts with two decimals and the code', () => {
    expect(formatCurrency(92.1357, 'EUR')).toBe('= 92.14 EUR')
    expect(formatCurrency(15000, 'JPY')).toBe('= 15,000.00 JPY')
    expect(formatCurrency(0.0123, 'GBP')).toBe('= 0.0123 GBP')
  })

  it('parses Frankfurter payloads and drops non-numeric rates', () => {
    expect(
      parseFrankfurterRates({ base: 'USD', date: '2026-09-17', rates: { EUR: 0.92, X: 'no' } })
    ).toEqual({ base: 'USD', date: '2026-09-17', rates: { EUR: 0.92 } })
    expect(parseFrankfurterRates({ rates: {} })).toBeNull()
    expect(parseFrankfurterRates(null)).toBeNull()
  })
})

describe('question shapes', () => {
  it('finds the place of a weather question', () => {
    expect(parseWeatherQuery('weather in paris')).toBe('paris')
    expect(parseWeatherQuery("what's the weather in New York today")).toBe('New York')
    expect(parseWeatherQuery('london weather')).toBe('london')
    expect(parseWeatherQuery('weather')).toBeNull()
    expect(parseWeatherQuery('weather forecast api')).toBe('forecast api')
  })

  it('finds the place of a time question', () => {
    expect(parseTimeQuery('time in tokyo')).toBe('tokyo')
    expect(parseTimeQuery('what time is it in Sydney?')).toBe('Sydney')
    expect(parseTimeQuery('tokyo time')).toBe('tokyo')
    expect(parseTimeQuery('time')).toBeNull()
  })

  it('finds the word of a dictionary question', () => {
    expect(parseDefineQuery('define serendipity')).toBe('serendipity')
    expect(parseDefineQuery('Serendipity definition')).toBe('serendipity')
    expect(parseDefineQuery('what does ephemeral mean')).toBe('ephemeral')
    expect(parseDefineQuery('meaning of life')).toBe('life')
    expect(parseDefineQuery('define')).toBeNull()
  })
})

describe('Open-Meteo', () => {
  it('reads the first geocoding hit with its zone and a readable label', () => {
    const place = parseGeocoding({
      results: [
        {
          name: 'Paris',
          latitude: 48.85,
          longitude: 2.35,
          timezone: 'Europe/Paris',
          admin1: 'Île-de-France',
          country: 'France'
        }
      ]
    })
    expect(place).toEqual({
      name: 'Paris',
      label: 'Paris, Île-de-France, France',
      latitude: 48.85,
      longitude: 2.35,
      timezone: 'Europe/Paris'
    })
    expect(parseGeocoding({ results: [] })).toBeNull()
    expect(parseGeocoding({})).toBeNull()
  })

  it('reads the current conditions and formats them', () => {
    const w = parseForecast({
      current_units: { temperature_2m: '°C' },
      current: { temperature_2m: 12.4, weather_code: 2, wind_speed_10m: 8.1 }
    })
    expect(w).toEqual({ temperature: 12.4, unit: '°C', weatherCode: 2, windSpeed: 8.1 })
    expect(formatWeather(w!)).toBe('12°C · Partly cloudy')
    expect(parseForecast({ current: { temperature_2m: 'x' } })).toBeNull()
  })

  it('formats a time in a zone', () => {
    const noon = Date.UTC(2026, 8, 17, 12, 0)
    expect(formatTimeIn('Asia/Tokyo', noon, 'en-GB')).toBe('21:00 · Thursday 17 September')
    expect(formatTimeIn('Not/AZone', noon, 'en-GB')).toBeNull()
  })
})

describe('Wikipedia', () => {
  it('reads a summary and skips disambiguation pages', () => {
    const summary = parseWikipediaSummary({
      type: 'standard',
      title: 'Wikipedia',
      description: 'Free online crowdsourced encyclopedia',
      thumbnail: { source: 'https://upload.wikimedia.org/w.png' },
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Wikipedia' } }
    })
    expect(summary).toEqual({
      title: 'Wikipedia',
      description: 'Free online crowdsourced encyclopedia',
      thumbnail: 'https://upload.wikimedia.org/w.png',
      url: 'https://en.wikipedia.org/wiki/Wikipedia'
    })
    expect(parseWikipediaSummary({ type: 'disambiguation', title: 'Mercury' })).toBeNull()
    expect(parseWikipediaSummary({ type: 'standard', title: 'X', description: '' })).toBeNull()
  })

  it('builds titles and tells entity-like queries apart', () => {
    expect(wikipediaTitle('taylor swift')).toBe('Taylor_swift')
    expect(wikipediaTitle('wikipedia')).toBe('Wikipedia')
    expect(looksLikeEntity('wikipedia')).toBe(true)
    expect(looksLikeEntity('Taylor Swift')).toBe(true)
    expect(looksLikeEntity('example.com')).toBe(false)
    expect(looksLikeEntity('2+2')).toBe(false)
    expect(looksLikeEntity('how to tie a tie quickly')).toBe(false)
    expect(looksLikeEntity('ab')).toBe(false)
  })
})

describe('Wiktionary', () => {
  it('strips the HTML from English senses and formats one', () => {
    const defs = parseWiktionaryDefinitions({
      en: [
        {
          partOfSpeech: 'Noun',
          definitions: [
            { definition: 'A <a href="/x">fortunate</a> discovery by accident.' },
            { definition: '' }
          ]
        }
      ],
      fr: [{ partOfSpeech: 'Nom', definitions: [{ definition: 'ignored' }] }]
    })
    expect(defs).toEqual([
      { partOfSpeech: 'Noun', definition: 'A fortunate discovery by accident.' }
    ])
    expect(formatDefinition(defs[0])).toBe('noun · A fortunate discovery by accident.')
    expect(formatDefinition({ partOfSpeech: '', definition: 'x'.repeat(200) }, 20)).toHaveLength(20)
    expect(parseWiktionaryDefinitions({})).toEqual([])
  })
})
