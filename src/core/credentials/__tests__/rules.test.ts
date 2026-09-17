import { describe, expect, it } from 'vitest'
import { PASSWORD_RULES } from '../data/passwordRules'
import {
  SPECIAL,
  charactersOf,
  describeRules,
  emptyRules,
  parsePasswordRules,
  rulesForHost
} from '../rules'

describe('password rules parser', () => {
  it('parses the documented example', () => {
    const rules = parsePasswordRules(
      'minlength: 8; maxlength: 64; max-consecutive: 2; required: upper; required: digit; required: [-!?]; allowed: lower, [_.];'
    )
    expect(rules).toEqual({
      minLength: 8,
      maxLength: 64,
      maxConsecutive: 2,
      required: [
        [{ kind: 'named', name: 'upper' }],
        [{ kind: 'named', name: 'digit' }],
        [{ kind: 'custom', chars: '-!?' }]
      ],
      allowed: [
        { kind: 'named', name: 'lower' },
        { kind: 'custom', chars: '_.' }
      ]
    })
  })

  it('takes a required line as the union of its classes', () => {
    const rules = parsePasswordRules('required: upper, lower, digit, [#@];')
    expect(rules.required).toEqual([
      [
        { kind: 'named', name: 'upper' },
        { kind: 'named', name: 'lower' },
        { kind: 'named', name: 'digit' },
        { kind: 'custom', chars: '#@' }
      ]
    ])
  })

  it('handles the custom class quirks: a leading dash, a doubled closing bracket, duplicates', () => {
    expect(parsePasswordRules('allowed: [-];').allowed).toEqual([{ kind: 'custom', chars: '-' }])
    expect(parsePasswordRules('allowed: [a-c];').allowed).toEqual([{ kind: 'custom', chars: 'ac' }])
    expect(parsePasswordRules('allowed: [!]];').allowed).toEqual([{ kind: 'custom', chars: '!]' }])
    expect(parsePasswordRules('allowed: [aabbaa];').allowed).toEqual([
      { kind: 'custom', chars: 'ab' }
    ])
    expect(parsePasswordRules('allowed: [];')).toEqual(emptyRules())
  })

  it('is case-insensitive, whitespace-tolerant and skips what it does not know', () => {
    const rules = parsePasswordRules(
      '  MinLength : 12 ;;; Required: Digit ; colour: blue; required: unicorn; maxlength: abc; allowed: ascii-printable'
    )
    expect(rules.minLength).toBe(12)
    expect(rules.maxLength).toBeNull()
    expect(rules.required).toEqual([[{ kind: 'named', name: 'digit' }]])
    expect(rules.allowed).toEqual([{ kind: 'named', name: 'ascii-printable' }])
  })

  it('ignores non-positive lengths and garbage', () => {
    expect(parsePasswordRules('minlength: 0; maxlength: -5;')).toEqual(emptyRules())
    expect(parsePasswordRules('')).toEqual(emptyRules())
    expect(parsePasswordRules('%%% :: ;; [[[')).toEqual(emptyRules())
  })

  it('expands named classes the way Apple defines them', () => {
    expect(charactersOf({ kind: 'named', name: 'upper' })).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    expect(charactersOf({ kind: 'named', name: 'digit' })).toBe('0123456789')
    expect(SPECIAL).toContain(' ')
    expect(SPECIAL).toContain('"')
    expect(SPECIAL).not.toMatch(/[A-Za-z0-9]/)
    expect(charactersOf({ kind: 'named', name: 'ascii-printable' })).toHaveLength(95)
    expect(charactersOf({ kind: 'custom', chars: 'xyz' })).toBe('xyz')
  })

  it('parses every bundled rule set into something usable', () => {
    const hosts = Object.keys(PASSWORD_RULES)
    expect(hosts.length).toBeGreaterThan(300)
    for (const host of hosts) {
      const rules = parsePasswordRules(PASSWORD_RULES[host])
      const meaningful =
        rules.minLength !== null ||
        rules.maxLength !== null ||
        rules.maxConsecutive !== null ||
        rules.required.length > 0 ||
        rules.allowed.length > 0
      expect(meaningful, `${host}: ${PASSWORD_RULES[host]}`).toBe(true)
      if (rules.minLength !== null && rules.maxLength !== null)
        expect(rules.minLength, host).toBeLessThanOrEqual(rules.maxLength)
    }
  })
})

describe('rules lookup', () => {
  it('finds a host, walks up to a parent domain and strips www', () => {
    const host = Object.keys(PASSWORD_RULES).find((h) => h.split('.').length === 2)!
    expect(rulesForHost(host)).toEqual({ host, text: PASSWORD_RULES[host] })
    expect(rulesForHost(`login.${host}`)?.host).toBe(host)
    expect(rulesForHost(`WWW.${host.toUpperCase()}`)?.host).toBe(host)
    expect(rulesForHost('nobody.invalid')).toBeNull()
    expect(rulesForHost('')).toBeNull()
  })
})

describe('rules description', () => {
  it('reads like a sentence', () => {
    expect(
      describeRules(
        parsePasswordRules(
          'minlength: 8; maxlength: 16; required: digit; required: upper, [!#]; max-consecutive: 3;'
        )
      )
    ).toBe(
      '8 to 16 characters; needs a digit, an uppercase letter or one of !#; no more than 3 identical characters in a row'
    )
    expect(describeRules(parsePasswordRules('minlength: 12;'))).toBe('at least 12 characters')
    expect(describeRules(parsePasswordRules('maxlength: 20; required: special;'))).toBe(
      'at most 20 characters; needs a symbol'
    )
    expect(describeRules(emptyRules())).toBe('')
  })
})
