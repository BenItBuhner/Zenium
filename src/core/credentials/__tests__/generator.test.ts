import { describe, expect, it } from 'vitest'
import type { GeneratorOptions } from '../../../shared/types'
import { PASSWORD_RULES } from '../data/passwordRules'
import {
  DEFAULT_GENERATOR_OPTIONS,
  DEFAULT_SYMBOLS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassphrase,
  generatePassword,
  satisfiesRules
} from '../generator'
import { DIGITS, LOWER, UPPER, parsePasswordRules } from '../rules'

const options = (patch: Partial<GeneratorOptions> = {}): GeneratorOptions => ({
  ...DEFAULT_GENERATOR_OPTIONS,
  ...patch
})

const has = (text: string, alphabet: string): boolean => [...text].some((c) => alphabet.includes(c))
const only = (text: string, alphabet: string): boolean =>
  [...text].every((c) => alphabet.includes(c))

describe('password generator', () => {
  it('uses the requested length and every enabled class', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(options({ length: 20 }))
      expect(pw).toHaveLength(20)
      expect(has(pw, UPPER)).toBe(true)
      expect(has(pw, LOWER)).toBe(true)
      expect(has(pw, DIGITS)).toBe(true)
      expect(has(pw, DEFAULT_SYMBOLS)).toBe(true)
      expect(only(pw, UPPER + LOWER + DIGITS + DEFAULT_SYMBOLS)).toBe(true)
    }
  })

  it('honours the class toggles', () => {
    for (let i = 0; i < 30; i++) {
      expect(only(generatePassword(options({ symbols: false })), UPPER + LOWER + DIGITS)).toBe(true)
      expect(
        only(generatePassword(options({ symbols: false, digits: false })), UPPER + LOWER)
      ).toBe(true)
      expect(
        only(generatePassword(options({ upper: false, symbols: false })), LOWER + DIGITS)
      ).toBe(true)
      expect(
        only(generatePassword(options({ upper: false, lower: false, symbols: false })), DIGITS)
      ).toBe(true)
    }
    // Nothing enabled still produces something.
    const pw = generatePassword(
      options({ upper: false, lower: false, digits: false, symbols: false })
    )
    expect(only(pw, LOWER)).toBe(true)
  })

  it('never returns two different passwords from the same call sequence', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(generatePassword(options()))
    expect(seen.size).toBe(200)
  })

  it('clamps the length and coerces nonsense', () => {
    expect(generatePassword(options({ length: 1 }))).toHaveLength(MIN_LENGTH)
    expect(generatePassword(options({ length: 10_000 }))).toHaveLength(MAX_LENGTH)
    expect(generatePassword(options({ length: Number.NaN }))).toHaveLength(
      DEFAULT_GENERATOR_OPTIONS.length
    )
    expect(generatePassword(options({ length: 12.4 }))).toHaveLength(12)
  })

  it('never repeats a character more than twice in a row without site rules', () => {
    for (let i = 0; i < 100; i++)
      expect(generatePassword(options({ length: 64 }))).not.toMatch(/(.)\1\1/)
  })

  it('applies a site rule set: bounds, required groups and the allowed alphabet', () => {
    const rules = parsePasswordRules(
      'minlength: 8; maxlength: 12; required: digit; required: [!#]; allowed: lower; max-consecutive: 1;'
    )
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword(options({ length: 30 }), rules)
      expect(pw).toHaveLength(12)
      expect(has(pw, DIGITS)).toBe(true)
      expect(has(pw, '!#')).toBe(true)
      expect(only(pw, LOWER + DIGITS + '!#')).toBe(true)
      expect(pw).not.toMatch(/(.)\1/)
      expect(satisfiesRules(pw, rules)).toBe(true)
    }
    // The site's minimum wins over a shorter request.
    expect(generatePassword(options({ length: 6 }), rules)).toHaveLength(8)
  })

  it('prefers friendly symbols when a site requires "special"', () => {
    const rules = parsePasswordRules(
      'required: special; required: upper; required: lower; required: digit;'
    )
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(options(), rules)
      expect(pw).not.toMatch(/[\s"'`\\]/)
      expect(satisfiesRules(pw, rules)).toBe(true)
    }
  })

  it('adds a required class the user turned off', () => {
    const rules = parsePasswordRules('required: digit;')
    for (let i = 0; i < 30; i++) {
      const pw = generatePassword(options({ digits: false, symbols: false }), rules)
      expect(has(pw, DIGITS)).toBe(true)
      expect(satisfiesRules(pw, rules)).toBe(true)
    }
  })

  it('satisfies every bundled rule set, with any toggle combination', () => {
    const toggles: Array<Partial<GeneratorOptions>> = [
      {},
      { symbols: false },
      { upper: false, symbols: false },
      { digits: false },
      { lower: false, digits: false, symbols: false },
      { length: 6 },
      { length: 128 }
    ]
    for (const [host, text] of Object.entries(PASSWORD_RULES)) {
      const rules = parsePasswordRules(text)
      for (const toggle of toggles) {
        const pw = generatePassword(options(toggle), rules)
        expect(
          satisfiesRules(pw, rules),
          `${host} (${JSON.stringify(toggle)}): ${pw} against ${text}`
        ).toBe(true)
      }
    }
  })
})

describe('rule check', () => {
  it('judges passwords against every constraint', () => {
    const rules = parsePasswordRules(
      'minlength: 6; maxlength: 8; required: digit; allowed: lower; max-consecutive: 2;'
    )
    expect(satisfiesRules('abcde1', rules)).toBe(true)
    expect(satisfiesRules('abc1', rules)).toBe(false)
    expect(satisfiesRules('abcdefgh1', rules)).toBe(false)
    expect(satisfiesRules('abcdef', rules)).toBe(false)
    expect(satisfiesRules('abcdE1', rules)).toBe(false)
    expect(satisfiesRules('aaab12', rules)).toBe(false)
  })
})

describe('passphrase generator', () => {
  const words = ['apple', 'brick', 'candle', 'dune', 'ember', 'fjord', 'gust', 'harbor']

  it('joins random words with the separator and capitalises on request', () => {
    const pw = generatePassphrase(
      options({ mode: 'passphrase', words: 4, separator: '-', capitalize: true }),
      words
    )
    const parts = pw.split('-')
    expect(parts).toHaveLength(4)
    for (const part of parts) expect(words).toContain(part.toLowerCase())
    for (const part of parts) expect(part[0]).toBe(part[0].toUpperCase())
    const lower = generatePassphrase(
      options({ mode: 'passphrase', words: 3, separator: ' ', capitalize: false }),
      words
    )
    expect(lower.split(' ')).toHaveLength(3)
    expect(lower).toBe(lower.toLowerCase())
  })

  it('appends exactly one digit when asked', () => {
    for (let i = 0; i < 30; i++) {
      const pw = generatePassphrase(
        options({
          mode: 'passphrase',
          words: 5,
          separator: '.',
          includeDigit: true,
          capitalize: false
        }),
        words
      )
      expect(pw.replace(/[^0-9]/g, '')).toHaveLength(1)
      expect(pw.split('.').filter((p) => /\d$/.test(p))).toHaveLength(1)
    }
  })

  it('clamps the word count and needs a wordlist', () => {
    expect(
      generatePassphrase(options({ mode: 'passphrase', words: 1, separator: '-' }), words).split(
        '-'
      )
    ).toHaveLength(3)
    expect(
      generatePassphrase(options({ mode: 'passphrase', words: 50, separator: '-' }), words).split(
        '-'
      )
    ).toHaveLength(12)
    expect(() => generatePassphrase(options({ mode: 'passphrase' }), ['one'])).toThrow()
  })
})
