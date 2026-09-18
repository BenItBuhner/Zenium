/**
 * Omnibox answers: the pure half. A calculator and a unit converter that work offline, the
 * readers of the free question shapes (currency, weather, time, definition) and the parsers of
 * the keyless services that answer them (Frankfurter, Wikipedia REST, Open-Meteo, Wiktionary).
 * No network here: `core/answers.ts` fetches, this file decides and formats.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** `= 4`, `= 3.333333333`: up to `digits` significant digits, no grouping, no exponent. */
export function formatNumber(value: number, digits = 10): string {
  if (!Number.isFinite(value)) return ''
  if (value === 0) return '0'
  const rounded = Number(value.toPrecision(digits))
  if (Math.abs(rounded) >= 1e21 || Math.abs(rounded) < 1e-9) return rounded.toExponential(5)
  return new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: digits,
    useGrouping: false
  }).format(rounded)
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'id'; value: string }
  | { kind: '(' }
  | { kind: ')' }

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }
const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil
}

function tokenizeMath(input: string): Token[] | null {
  const src = input
    // `3x4` and `3 × 4` multiply; an `x` inside a name (`exp`) is left alone.
    .replace(/(?<=[\d)])\s*[xX×]\s*(?=[\d(.])/g, '*')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–]/g, '-')
    .replace(/\*\*/g, '^')
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (/[\d.]/.test(ch)) {
      const m = /^(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(src.slice(i))
      if (!m) return null
      const raw = m[1].replace(/,/g, '')
      if (raw === '.' || !/\d/.test(raw)) return null
      out.push({ kind: 'num', value: Number(raw) })
      i += m[1].length
      continue
    }
    if (/[a-z]/i.test(ch)) {
      const m = /^[a-z]+/i.exec(src.slice(i))
      if (!m) return null
      out.push({ kind: 'id', value: m[0].toLowerCase() })
      i += m[0].length
      continue
    }
    if ('+-*/^%'.includes(ch)) {
      out.push({ kind: 'op', value: ch })
      i += 1
      continue
    }
    if (ch === '(') {
      out.push({ kind: '(' })
      i += 1
      continue
    }
    if (ch === ')') {
      out.push({ kind: ')' })
      i += 1
      continue
    }
    return null
  }
  return out
}

class MathParser {
  private pos = 0
  /** Binary operators or functions seen: a bare number is not a calculation. */
  operations = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): number | null {
    const value = this.expr()
    if (value === null || this.pos !== this.tokens.length) return null
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private takeOp(ops: string): string | null {
    const t = this.peek()
    if (t && t.kind === 'op' && ops.includes(t.value)) {
      this.pos += 1
      return t.value
    }
    return null
  }

  private expr(): number | null {
    let left = this.term()
    if (left === null) return null
    for (;;) {
      const op = this.takeOp('+-')
      if (!op) return left
      const right = this.term()
      if (right === null) return null
      this.operations += 1
      left = op === '+' ? left + right : left - right
    }
  }

  private term(): number | null {
    let left = this.unary()
    if (left === null) return null
    for (;;) {
      const op = this.takeOp('*/%')
      if (!op) return left
      const right = this.unary()
      if (right === null) return null
      this.operations += 1
      left = op === '*' ? left * right : op === '/' ? left / right : left % right
    }
  }

  private unary(): number | null {
    if (this.takeOp('-')) {
      const v = this.unary()
      return v === null ? null : -v
    }
    if (this.takeOp('+')) return this.unary()
    return this.power()
  }

  private power(): number | null {
    const base = this.atom()
    if (base === null) return null
    if (this.takeOp('^')) {
      const exponent = this.unary()
      if (exponent === null) return null
      this.operations += 1
      return Math.pow(base, exponent)
    }
    return base
  }

  private atom(): number | null {
    const t = this.peek()
    if (!t) return null
    if (t.kind === 'num') {
      this.pos += 1
      return t.value
    }
    if (t.kind === '(') {
      this.pos += 1
      const v = this.expr()
      if (v === null) return null
      const close = this.peek()
      if (!close || close.kind !== ')') return null
      this.pos += 1
      return v
    }
    if (t.kind === 'id') {
      this.pos += 1
      if (t.value in CONSTANTS) return CONSTANTS[t.value]
      const fn = FUNCTIONS[t.value]
      if (!fn) return null
      const open = this.peek()
      if (!open || open.kind !== '(') return null
      this.pos += 1
      const arg = this.expr()
      if (arg === null) return null
      const close = this.peek()
      if (!close || close.kind !== ')') return null
      this.pos += 1
      this.operations += 1
      return fn(arg)
    }
    return null
  }
}

/**
 * Evaluate arithmetic typed in the omnibox: `2+2`, `2*(3+4)`, `2^10`, `sqrt(16)`, `10/3`,
 * `3x4`. A bare number (`2020`, `-5`, `1.5`) is not a calculation and gives null, as do
 * unfinished expressions and anything that does not come out finite.
 */
export function evaluateMath(input: string): number | null {
  const text = input.trim()
  if (!text || !/\d/.test(text)) return null
  // Something that reads as a date, a version or a phone number is left to the search engine;
  // `10/4` alone is still a division.
  if (/^\d+([.-]\d+)+$/.test(text) || /^\d+(\/\d+){2,}$/.test(text)) return null
  const tokens = tokenizeMath(text)
  if (!tokens || tokens.length < 3) return null
  const parser = new MathParser(tokens)
  const value = parser.parse()
  if (value === null || parser.operations === 0 || !Number.isFinite(value)) return null
  return value
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitCategory =
  'length' | 'mass' | 'temperature' | 'data' | 'speed' | 'area' | 'volume' | 'time'

interface UnitDef {
  category: UnitCategory
  /** Multiplier to the category's base unit (metre, kilogram, byte, m/s, m², litre, second). */
  factor: number
  singular: string
  plural: string
  aliases: string[]
}

function unit(
  category: UnitCategory,
  factor: number,
  singular: string,
  plural: string,
  aliases: string[]
): UnitDef {
  return { category, factor, singular, plural, aliases }
}

const UNITS: UnitDef[] = [
  unit('length', 0.001, 'millimeter', 'millimeters', ['mm', 'millimetre', 'millimetres']),
  unit('length', 0.01, 'centimeter', 'centimeters', ['cm', 'centimetre', 'centimetres']),
  unit('length', 1, 'meter', 'meters', ['m', 'metre', 'metres']),
  unit('length', 1000, 'kilometer', 'kilometers', ['km', 'kilometre', 'kilometres', 'kms']),
  unit('length', 0.0254, 'inch', 'inches', ['in', '"', 'inch']),
  unit('length', 0.3048, 'foot', 'feet', ['ft', "'"]),
  unit('length', 0.9144, 'yard', 'yards', ['yd', 'yds']),
  unit('length', 1609.344, 'mile', 'miles', ['mi']),
  unit('length', 1852, 'nautical mile', 'nautical miles', ['nmi', 'nauticalmile', 'nauticalmiles']),
  unit('mass', 1e-6, 'milligram', 'milligrams', ['mg']),
  unit('mass', 0.001, 'gram', 'grams', ['g', 'gramme', 'grammes']),
  unit('mass', 1, 'kilogram', 'kilograms', ['kg', 'kgs', 'kilo', 'kilos']),
  unit('mass', 1000, 'tonne', 'tonnes', ['t', 'ton', 'tons', 'metricton', 'metrictons']),
  unit('mass', 0.028349523125, 'ounce', 'ounces', ['oz']),
  unit('mass', 0.45359237, 'pound', 'pounds', ['lb', 'lbs']),
  unit('mass', 6.35029318, 'stone', 'stone', ['st', 'stones']),
  unit('temperature', 1, 'degree Celsius', 'degrees Celsius', [
    'c',
    '°c',
    'celsius',
    'centigrade',
    'degreescelsius',
    'degreecelsius',
    'degc'
  ]),
  unit('temperature', 1, 'degree Fahrenheit', 'degrees Fahrenheit', [
    'f',
    '°f',
    'fahrenheit',
    'degreesfahrenheit',
    'degreefahrenheit',
    'degf'
  ]),
  unit('temperature', 1, 'kelvin', 'kelvin', ['k', 'kelvins']),
  unit('data', 0.125, 'bit', 'bits', ['b']),
  unit('data', 1, 'byte', 'bytes', ['byte']),
  unit('data', 1e3, 'kilobyte', 'kilobytes', ['kb']),
  unit('data', 1e6, 'megabyte', 'megabytes', ['mb']),
  unit('data', 1e9, 'gigabyte', 'gigabytes', ['gb']),
  unit('data', 1e12, 'terabyte', 'terabytes', ['tb']),
  unit('data', 1e15, 'petabyte', 'petabytes', ['pb']),
  unit('data', 1024, 'kibibyte', 'kibibytes', ['kib']),
  unit('data', 1024 ** 2, 'mebibyte', 'mebibytes', ['mib']),
  unit('data', 1024 ** 3, 'gibibyte', 'gibibytes', ['gib']),
  unit('data', 1024 ** 4, 'tebibyte', 'tebibytes', ['tib']),
  unit('data', 125, 'kilobit', 'kilobits', ['kbit', 'kbits', 'kbps']),
  unit('data', 125e3, 'megabit', 'megabits', ['mbit', 'mbits', 'mbps']),
  unit('data', 125e6, 'gigabit', 'gigabits', ['gbit', 'gbits', 'gbps']),
  unit('speed', 1, 'meter per second', 'meters per second', [
    'm/s',
    'mps',
    'meterspersecond',
    'metrespersecond'
  ]),
  unit('speed', 1 / 3.6, 'kilometer per hour', 'kilometers per hour', [
    'km/h',
    'kph',
    'kmh',
    'kmph',
    'kilometersperhour',
    'kilometresperhour'
  ]),
  unit('speed', 0.44704, 'mile per hour', 'miles per hour', ['mph', 'milesperhour']),
  unit('speed', 0.514444, 'knot', 'knots', ['kn', 'kt', 'kts']),
  unit('speed', 0.3048, 'foot per second', 'feet per second', ['ft/s', 'fps', 'feetpersecond']),
  unit('area', 1, 'square meter', 'square meters', [
    'm2',
    'm²',
    'sqm',
    'squaremetre',
    'squaremetres'
  ]),
  unit('area', 1e6, 'square kilometer', 'square kilometers', [
    'km2',
    'km²',
    'sqkm',
    'squarekilometre',
    'squarekilometres'
  ]),
  unit('area', 1e4, 'hectare', 'hectares', ['ha']),
  unit('area', 4046.8564224, 'acre', 'acres', ['ac']),
  unit('area', 0.09290304, 'square foot', 'square feet', ['sqft', 'ft2', 'ft²', 'squarefoot']),
  unit('area', 0.00064516, 'square inch', 'square inches', ['sqin', 'in2', 'in²']),
  unit('area', 2589988.110336, 'square mile', 'square miles', ['sqmi', 'mi2', 'mi²']),
  unit('volume', 0.001, 'milliliter', 'milliliters', ['ml', 'millilitre', 'millilitres']),
  unit('volume', 1, 'liter', 'liters', ['l', 'litre', 'litres']),
  unit('volume', 1000, 'cubic meter', 'cubic meters', ['m3', 'm³', 'cubicmetre', 'cubicmetres']),
  unit('volume', 3.785411784, 'gallon', 'gallons', ['gal', 'gals']),
  unit('volume', 0.946352946, 'quart', 'quarts', ['qt']),
  unit('volume', 0.473176473, 'pint', 'pints', ['pt']),
  unit('volume', 0.2365882365, 'cup', 'cups', []),
  unit('volume', 0.0295735295625, 'fluid ounce', 'fluid ounces', ['floz', 'fl.oz', 'fl.oz.']),
  unit('volume', 0.01478676478125, 'tablespoon', 'tablespoons', ['tbsp', 'tbs']),
  unit('volume', 0.00492892159375, 'teaspoon', 'teaspoons', ['tsp']),
  unit('time', 0.001, 'millisecond', 'milliseconds', ['ms']),
  unit('time', 1, 'second', 'seconds', ['s', 'sec', 'secs']),
  unit('time', 60, 'minute', 'minutes', ['min', 'mins']),
  unit('time', 3600, 'hour', 'hours', ['h', 'hr', 'hrs']),
  unit('time', 86400, 'day', 'days', ['d']),
  unit('time', 604800, 'week', 'weeks', ['wk', 'wks']),
  unit('time', 2629746, 'month', 'months', ['mo', 'mos']),
  unit('time', 31556952, 'year', 'years', ['y', 'yr', 'yrs'])
]

const UNIT_INDEX = new Map<string, UnitDef>()
for (const u of UNITS) {
  for (const name of [u.singular, u.plural, ...u.aliases]) UNIT_INDEX.set(normalizeUnit(name), u)
}

function normalizeUnit(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\.$/, '')
    .replace(/^square(metre|meter)s?$/, 'm2')
    .replace(/^degrees?(c|f)$/, '$1')
}

/** The unit a word names, or null (`km`, `miles`, `square feet`, `°F`). */
export function findUnit(text: string): UnitDef | null {
  return UNIT_INDEX.get(normalizeUnit(text)) ?? null
}

function convertTemperature(value: number, from: UnitDef, to: UnitDef): number {
  const kelvin =
    from.singular === 'kelvin'
      ? value
      : from.singular === 'degree Celsius'
        ? value + 273.15
        : ((value - 32) * 5) / 9 + 273.15
  if (to.singular === 'kelvin') return kelvin
  if (to.singular === 'degree Celsius') return kelvin - 273.15
  return ((kelvin - 273.15) * 9) / 5 + 32
}

export interface UnitConversion {
  value: number
  from: UnitDef
  to: UnitDef
  result: number
  /** `= 6.21371 miles` */
  text: string
}

const UNIT_QUERY_RE =
  /^(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)\s*([a-z°µ"'./²³]+(?:\s+[a-z./²³]+)*?)\s+(?:in|to|as|into|=)\s+([a-z°µ"'./²³]+(?:\s+[a-z./²³]+)*)$/i

/**
 * `10 km in miles`, `5 miles to km`, `72 f in c`, `1 gb in mb`: a conversion between two units
 * of the same category, or null. The label uses the target's name, plural when the result is
 * not exactly one; six significant digits like Chrome's calculator row.
 */
export function convertUnits(query: string): UnitConversion | null {
  const m = UNIT_QUERY_RE.exec(query.trim().replace(/\s+/g, ' '))
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  const from = findUnit(m[2])
  const to = findUnit(m[3])
  if (!Number.isFinite(value) || !from || !to || from.category !== to.category) return null
  if (from === to) return null
  const result =
    from.category === 'temperature'
      ? convertTemperature(value, from, to)
      : (value * from.factor) / to.factor
  if (!Number.isFinite(result)) return null
  const label = Math.abs(result) === 1 ? to.singular : to.plural
  return { value, from, to, result, text: `= ${formatNumber(result, 6)} ${label}` }
}

// ---------------------------------------------------------------------------
// Local answers (no network)
// ---------------------------------------------------------------------------

export interface LocalAnswer {
  kind: 'calculator' | 'unit'
  /** The row's title: `= 4`, `= 6.21371 miles`. */
  text: string
}

/** The answer Zenium can give without asking anyone: a calculation or a unit conversion. */
export function localAnswer(query: string): LocalAnswer | null {
  const q = query.trim()
  if (!q) return null
  const conversion = convertUnits(q)
  if (conversion) return { kind: 'unit', text: conversion.text }
  const value = evaluateMath(q)
  if (value !== null) return { kind: 'calculator', text: `= ${formatNumber(value)}` }
  return null
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const CURRENCIES: Array<{ code: string; aliases: string[] }> = [
  { code: 'USD', aliases: ['$', 'us$', 'dollar', 'dollars', 'usdollar', 'usdollars', 'bucks'] },
  { code: 'EUR', aliases: ['€', 'euro', 'euros'] },
  // `pound(s)` is also a mass; the unit converter runs first, so `10 pounds in kg` stays mass.
  {
    code: 'GBP',
    aliases: ['£', 'pound', 'pounds', 'poundsterling', 'poundssterling', 'quid', 'sterling']
  },
  { code: 'JPY', aliases: ['¥', 'yen'] },
  { code: 'CHF', aliases: ['franc', 'francs', 'swissfranc', 'swissfrancs'] },
  { code: 'CAD', aliases: ['c$', 'ca$', 'canadiandollar', 'canadiandollars'] },
  { code: 'AUD', aliases: ['a$', 'au$', 'australiandollar', 'australiandollars'] },
  { code: 'NZD', aliases: ['nz$', 'newzealanddollar', 'newzealanddollars'] },
  { code: 'CNY', aliases: ['yuan', 'rmb', 'renminbi'] },
  { code: 'INR', aliases: ['₹', 'rupee', 'rupees'] },
  { code: 'KRW', aliases: ['₩', 'won'] },
  { code: 'SEK', aliases: ['krona', 'kronor', 'swedishkrona'] },
  { code: 'NOK', aliases: ['norwegiankrone', 'norwegiankroner'] },
  { code: 'DKK', aliases: ['danishkrone', 'danishkroner'] },
  { code: 'PLN', aliases: ['zloty', 'zlotys', 'złoty'] },
  { code: 'CZK', aliases: ['koruna', 'czechkoruna'] },
  { code: 'HUF', aliases: ['forint', 'forints'] },
  { code: 'BRL', aliases: ['r$', 'real', 'reais'] },
  { code: 'MXN', aliases: ['mexicanpeso', 'mexicanpesos'] },
  { code: 'ZAR', aliases: ['rand'] },
  { code: 'TRY', aliases: ['₺', 'lira', 'turkishlira'] },
  { code: 'HKD', aliases: ['hk$', 'hongkongdollar', 'hongkongdollars'] },
  { code: 'SGD', aliases: ['s$', 'singaporedollar', 'singaporedollars'] },
  { code: 'ILS', aliases: ['₪', 'shekel', 'shekels'] },
  { code: 'THB', aliases: ['฿', 'baht'] },
  { code: 'IDR', aliases: ['rupiah'] },
  { code: 'PHP', aliases: ['₱', 'philippinepeso', 'philippinepesos'] },
  { code: 'MYR', aliases: ['ringgit'] },
  { code: 'RON', aliases: ['leu', 'lei'] },
  { code: 'BGN', aliases: ['lev', 'leva'] },
  { code: 'ISK', aliases: ['icelandickrona'] }
]

const CURRENCY_INDEX = new Map<string, string>()
for (const c of CURRENCIES) {
  CURRENCY_INDEX.set(c.code.toLowerCase(), c.code)
  for (const a of c.aliases) CURRENCY_INDEX.set(a.toLowerCase(), c.code)
}

/** ISO code of a currency word or symbol (`usd`, `dollars`, `€`), or null. */
export function findCurrency(text: string): string | null {
  const key = text.toLowerCase().replace(/\s+/g, '').replace(/\.$/, '')
  return CURRENCY_INDEX.get(key) ?? null
}

export interface CurrencyQuery {
  amount: number
  from: string
  to: string
}

const CURRENCY_QUERY_RE =
  /^([^\d\s]{1,3})?\s*(\d[\d,]*(?:\.\d+)?)?\s*([^\d\s][^\d]*?)?\s+(?:in|to|into|as|=)\s+([^\d\s][^\d]*)$/i

/**
 * `100 usd to eur`, `$100 in euros`, `100 dollars in yen`, `usd to gbp` (one unit): the amount
 * and the two ISO codes, or null when either side is not a currency.
 */
export function parseCurrencyQuery(query: string): CurrencyQuery | null {
  const q = query.trim().replace(/\s+/g, ' ')
  const m = CURRENCY_QUERY_RE.exec(q)
  if (!m) return null
  const [, symbol, number, fromWord, toWord] = m
  const fromText = (fromWord ?? '').trim() || (symbol ?? '').trim()
  if (!fromText) return null
  if (symbol && fromWord && fromWord.trim()) {
    // `$100 usd` names the currency twice; accept only when both agree.
    if (findCurrency(symbol) !== findCurrency(fromWord)) return null
  }
  const from = findCurrency(fromText)
  const to = findCurrency(toWord.trim())
  if (!from || !to || from === to) return null
  const amount = number ? Number(number.replace(/,/g, '')) : 1
  if (!Number.isFinite(amount)) return null
  return { amount, from, to }
}

/** `= 92.14 EUR`: two decimals, grouped, the code after the amount. */
export function formatCurrency(amount: number, code: string): string {
  const digits = Math.abs(amount) >= 1 ? 2 : 4
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(amount)
  return `= ${text} ${code}`
}

export interface FrankfurterRates {
  /** ECB fixing date, `YYYY-MM-DD`. */
  date: string
  base: string
  rates: Record<string, number>
}

/** `api.frankfurter.dev/v1/latest?base=USD`: `{ base, date, rates: { EUR: 0.92, ... } }`. */
export function parseFrankfurterRates(body: unknown): FrankfurterRates | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { base?: unknown; date?: unknown; rates?: unknown }
  if (typeof b.base !== 'string' || typeof b.date !== 'string') return null
  if (!b.rates || typeof b.rates !== 'object') return null
  const rates: Record<string, number> = {}
  for (const [code, rate] of Object.entries(b.rates as Record<string, unknown>)) {
    if (typeof rate === 'number' && Number.isFinite(rate)) rates[code] = rate
  }
  return { date: b.date, base: b.base, rates }
}

// ---------------------------------------------------------------------------
// Question shapes: weather, time, definitions
// ---------------------------------------------------------------------------

const PLACE = "([a-z][a-z .'-]{1,60}?)"

const WEATHER_RES = [
  new RegExp(`^(?:what(?:'s| is) the )?weather (?:in|for|at) ${PLACE}(?: today| now)?\\??$`, 'i'),
  new RegExp(`^weather ${PLACE}$`, 'i'),
  new RegExp(`^${PLACE} weather(?: today| now| forecast)?$`, 'i'),
  new RegExp(`^(?:temperature|forecast) (?:in|for) ${PLACE}$`, 'i')
]

const TIME_RES = [
  new RegExp(
    `^(?:what(?:'s| is) the )?(?:current |local )?time (?:in|at) ${PLACE}(?: now)?\\??$`,
    'i'
  ),
  new RegExp(`^what time is it (?:in|at) ${PLACE}\\??$`, 'i'),
  new RegExp(`^${PLACE} (?:local )?time(?: now)?$`, 'i')
]

const WORD = "([a-z][a-z'-]{1,40})"
const DEFINE_RES = [
  new RegExp(`^(?:define|definition|definition of|meaning of|dictionary) ${WORD}\\??$`, 'i'),
  new RegExp(`^${WORD} (?:definition|meaning|defined)$`, 'i'),
  new RegExp(`^what does ${WORD} mean\\??$`, 'i'),
  new RegExp(`^what is the (?:definition|meaning) of ${WORD}\\??$`, 'i')
]

function firstGroup(res: RegExp[], query: string): string | null {
  const q = query.trim().replace(/\s+/g, ' ')
  for (const re of res) {
    const m = re.exec(q)
    if (m && m[1]) return m[1].trim()
  }
  return null
}

/** The place a weather question names (`weather in paris` → `paris`), or null. */
export function parseWeatherQuery(query: string): string | null {
  return firstGroup(WEATHER_RES, query)
}

/** The place a time question names (`time in tokyo`, `tokyo time`), or null. */
export function parseTimeQuery(query: string): string | null {
  return firstGroup(TIME_RES, query)
}

/** The word a dictionary question names (`define serendipity`), or null. */
export function parseDefineQuery(query: string): string | null {
  return firstGroup(DEFINE_RES, query)?.toLowerCase() ?? null
}

// ---------------------------------------------------------------------------
// Open-Meteo (geocoding + forecast)
// ---------------------------------------------------------------------------

export interface GeoPlace {
  name: string
  /** Region and country for the row (`Paris, Île-de-France, France`). */
  label: string
  latitude: number
  longitude: number
  /** IANA zone, `Europe/Paris`. */
  timezone: string
}

/** `geocoding-api.open-meteo.com/v1/search?name=<place>&count=1`: the first result. */
export function parseGeocoding(body: unknown): GeoPlace | null {
  if (!body || typeof body !== 'object') return null
  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results) || results.length === 0) return null
  const r = results[0] as Record<string, unknown>
  if (
    typeof r.name !== 'string' ||
    typeof r.latitude !== 'number' ||
    typeof r.longitude !== 'number' ||
    typeof r.timezone !== 'string'
  )
    return null
  const parts = [r.name, r.admin1, r.country].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  return {
    name: r.name,
    label: [...new Set(parts)].join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone
  }
}

export interface CurrentWeather {
  temperature: number
  /** `°C` or `°F` as the API reported it. */
  unit: string
  weatherCode: number
  windSpeed: number | null
}

/** `api.open-meteo.com/v1/forecast?...&current=temperature_2m,weather_code,wind_speed_10m`. */
export function parseForecast(body: unknown): CurrentWeather | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { current?: unknown; current_units?: unknown }
  if (!b.current || typeof b.current !== 'object') return null
  const c = b.current as Record<string, unknown>
  if (typeof c.temperature_2m !== 'number' || typeof c.weather_code !== 'number') return null
  const units = (b.current_units ?? {}) as Record<string, unknown>
  return {
    temperature: c.temperature_2m,
    unit: typeof units.temperature_2m === 'string' ? units.temperature_2m : '°C',
    weatherCode: c.weather_code,
    windSpeed: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : null
  }
}

/** WMO weather interpretation codes as Open-Meteo documents them. */
export function weatherDescription(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code === 1) return 'Mainly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Rain showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Unknown'
}

/** `12°C · Partly cloudy` for the row's title. */
export function formatWeather(w: CurrentWeather): string {
  const temperature = `${Math.round(w.temperature)}${w.unit.replace(/\s+/g, '')}`
  return `${temperature} · ${weatherDescription(w.weatherCode)}`
}

/** `14:32 · Thursday, 18 September` in `timeZone`; the locale is the system's unless given. */
export function formatTimeIn(timeZone: string, nowMs: number, locale?: string): string | null {
  try {
    const time = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone
    }).format(nowMs)
    const day = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone
    }).format(nowMs)
    return `${time} · ${day}`
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Wikipedia REST summary (entity rows)
// ---------------------------------------------------------------------------

export interface EntitySummary {
  title: string
  /** Wikidata's short description (`American singer-songwriter`). */
  description: string
  /** Square thumbnail URL or null. */
  thumbnail: string | null
  url: string
}

/**
 * `en.wikipedia.org/api/rest_v1/page/summary/<Title>`: title, description, thumbnail and the
 * canonical page URL. Disambiguation pages and pages without a description give null: the row
 * has nothing to say about them.
 */
export function parseWikipediaSummary(body: unknown): EntitySummary | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.type === 'disambiguation' || typeof b.title !== 'string') return null
  const description = typeof b.description === 'string' ? b.description.trim() : ''
  if (!description) return null
  const thumb = b.thumbnail as { source?: unknown } | undefined
  const thumbnail = thumb && typeof thumb.source === 'string' ? thumb.source : null
  const pages = (b.content_urls as { desktop?: { page?: unknown } } | undefined)?.desktop?.page
  const url =
    typeof pages === 'string'
      ? pages
      : `https://en.wikipedia.org/wiki/${encodeURIComponent(b.title.replace(/ /g, '_'))}`
  return { title: b.title, description, thumbnail, url }
}

/** `Taylor_Swift` for `taylor swift`: Wikipedia titles start upper-case, spaces are underscores. */
export function wikipediaTitle(query: string): string {
  const words = query.trim().replace(/\s+/g, ' ')
  if (!words) return ''
  const title = words.charAt(0).toUpperCase() + words.slice(1)
  return title.replace(/ /g, '_')
}

/**
 * Whether a query is worth an entity lookup: one to four words of letters (digits allowed after
 * the first), no operators or punctuation that reads as a URL, a search or a calculation.
 */
export function looksLikeEntity(query: string): boolean {
  const q = query.trim()
  if (q.length < 3 || q.length > 60) return false
  if (!/^[\p{L}][\p{L}\p{N}' .-]*$/u.test(q)) return false
  if (/[./]/.test(q) && !/ /.test(q)) return false
  const words = q.split(/\s+/)
  return words.length <= 4 && words.every((w) => w.length >= 2 || /^[A-Z]$/.test(w))
}

// ---------------------------------------------------------------------------
// Wiktionary REST definitions
// ---------------------------------------------------------------------------

export interface WordDefinition {
  partOfSpeech: string
  definition: string
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * `en.wiktionary.org/api/rest_v1/page/definition/<word>`: `{ en: [{ partOfSpeech,
 * definitions: [{ definition: '<html>' }] }] }`. English senses only, HTML stripped, empty
 * senses (labels without a gloss) skipped.
 */
export function parseWiktionaryDefinitions(body: unknown): WordDefinition[] {
  if (!body || typeof body !== 'object') return []
  const en = (body as { en?: unknown }).en
  if (!Array.isArray(en)) return []
  const out: WordDefinition[] = []
  for (const entry of en) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { partOfSpeech?: unknown; definitions?: unknown }
    const pos = typeof e.partOfSpeech === 'string' ? e.partOfSpeech : ''
    if (!Array.isArray(e.definitions)) continue
    for (const d of e.definitions) {
      const text = (d as { definition?: unknown })?.definition
      if (typeof text !== 'string') continue
      const plain = stripHtml(text)
      if (plain.length < 3) continue
      out.push({ partOfSpeech: pos, definition: plain })
    }
  }
  return out
}

/** `noun · A fortunate discovery by accident.` for the row's title, clipped to one line. */
export function formatDefinition(d: WordDefinition, maxLength = 120): string {
  let text = d.definition
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`
  return d.partOfSpeech ? `${d.partOfSpeech.toLowerCase()} · ${text}` : text
}
