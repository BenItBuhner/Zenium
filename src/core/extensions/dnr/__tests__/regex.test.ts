/**
 * The RE2 model behind `regexFilter` and `isRegexSupported`. The instruction counts and the
 * accept/reject verdicts below were taken from RE2 itself (Chromium `main` options: Latin-1,
 * never_capture unless a substitution needs groups, 2 KB max_mem) with the `ninst` probe
 * described in the dnr-translator report.
 */
import { describe, expect, test } from 'vitest'
import {
  RE2_MAX_INSTRUCTIONS,
  checkRegex,
  checkRegexSubstitution,
  toJavaScriptRegExp
} from '../regex'

function instructions(pattern: string, isCaseSensitive = false): number {
  const result = checkRegex(pattern, { isCaseSensitive })
  if (!result.isSupported) throw new Error(`${pattern}: ${result.message}`)
  return result.instructions
}

describe('checkRegex', () => {
  test('the 2 KB budget is 116 instructions', () => {
    expect(RE2_MAX_INSTRUCTIONS).toBe(116)
  })

  test('instruction counts match RE2 for representative patterns', () => {
    expect(instructions('^https://[a-z]+\\.example\\.com/(ads|track)/')).toBe(29)
    expect(instructions('a{100}')).toBe(104)
    expect(instructions('a{110}')).toBe(114)
    expect(instructions('(abc){30}')).toBe(94)
    expect(instructions('[a-z]{50}')).toBe(54)
    expect(
      instructions(
        '^https://([a-z0-9-]+\\.)+example\\.com/.*(utm_source|utm_medium|utm_campaign|fbclid|gclid)='
      )
    ).toBe(68)
    expect(instructions('(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z){10}')).toBe(14)
    expect(instructions('(?i)abc')).toBe(7)
    expect(instructions('\\bads\\b')).toBe(9)
    expect(instructions('[[:digit:]]+')).toBe(6)
    expect(instructions('\\pL+')).toBe(18)
    expect(instructions('\\Qa.b\\E')).toBe(7)
    expect(instructions('a{110}', true)).toBe(114)
  })

  test('patterns over the budget are rejected with memoryLimitExceeded', () => {
    for (const pattern of [
      'a{120}',
      '(abc){40}',
      'a{1000}',
      '^https?://(www\\.)?(youtube|google)\\.com/(watch|embed)\\?v=[A-Za-z0-9_-]{11}'
    ]) {
      expect(checkRegex(pattern)).toMatchObject({
        isSupported: false,
        reason: 'memoryLimitExceeded'
      })
    }
  })

  test('capture groups count only when a substitution needs them', () => {
    const plain = checkRegex('^https://www\\.(abc|def)\\.xyz\\.com/', { isCaseSensitive: true })
    const capturing = checkRegex('^https://www\\.(abc|def)\\.xyz\\.com/', {
      isCaseSensitive: true,
      requireCapturing: true
    })
    // `never_capture` turns groups non-capturing, and RE2 then reports none.
    expect(plain).toMatchObject({ isSupported: true, captureCount: 0 })
    expect(capturing).toMatchObject({ isSupported: true, captureCount: 1, instructions: 22 })
    if (plain.isSupported && capturing.isSupported) {
      expect(plain.instructions).toBeLessThan(capturing.instructions)
    }
  })

  test('constructs RE2 rejects are syntax errors', () => {
    for (const pattern of [
      '(?=a)',
      '(?!a)',
      '(?<=a)',
      '(?<!a)',
      '(a)\\1',
      'a*+',
      'a**',
      '\\q',
      '[z-a]',
      'a{1001}',
      'a{2,1}',
      '(?z)a',
      '(',
      'a)',
      '[a',
      '*a',
      '\\',
      'a{1000,1001}'
    ]) {
      expect(checkRegex(pattern), pattern).toMatchObject({
        isSupported: false,
        reason: 'syntaxError'
      })
    }
  })

  test('constructs RE2 accepts are supported', () => {
    for (const pattern of [
      '',
      'a{,5}',
      '(?:a|b)+?',
      '(?P<name>x)',
      '(?<name>x)',
      '(?i:a)(?-i:B)',
      '(?s).',
      '\\x41\\x{41}\\101',
      '[\\d\\D\\s\\S\\w\\W]',
      '[^\\]a-]',
      '\\pN\\p{Greek}\\P{Lu}',
      '[[:^alpha:]]',
      '\\A\\z\\b\\B',
      '\\C',
      '\\Q(unterminated',
      '\\*\\.\\?\\+',
      'a|',
      '|',
      '()',
      '(?:)',
      'x{0}',
      '[a-z&&[^b]]'
    ]) {
      expect(checkRegex(pattern), pattern).toMatchObject({ isSupported: true })
    }
  })
})

describe('checkRegexSubstitution', () => {
  test('group references must exist and escapes are limited to digits and backslash', () => {
    expect(checkRegexSubstitution('https://\\1.xyz.com/', 1)).toBe(true)
    expect(checkRegexSubstitution('\\0', 0)).toBe(true)
    expect(checkRegexSubstitution('\\2', 1)).toBe(false)
    expect(checkRegexSubstitution('a\\\\b', 0)).toBe(true)
    expect(checkRegexSubstitution('\\n', 0)).toBe(false)
    expect(checkRegexSubstitution('trailing\\', 0)).toBe(false)
    expect(checkRegexSubstitution('no references', 0)).toBe(true)
  })
})

describe('toJavaScriptRegExp', () => {
  test('case folding follows the rule flag', () => {
    expect(toJavaScriptRegExp('abc', false).test('xABCx')).toBe(true)
    expect(toJavaScriptRegExp('abc', true).test('xABCx')).toBe(false)
    expect(toJavaScriptRegExp('abc', true).test('xabcx')).toBe(true)
  })

  test('RE2-only syntax is translated', () => {
    expect(toJavaScriptRegExp('\\Ahttp', true).test('http://x')).toBe(true)
    expect(toJavaScriptRegExp('\\Ahttp', true).test('xhttp')).toBe(false)
    expect(toJavaScriptRegExp('com\\z', true).test('example.com')).toBe(true)
    expect(toJavaScriptRegExp('com\\z', true).test('example.com/')).toBe(false)
    expect(toJavaScriptRegExp('\\Qa.b\\E', true).test('a.b')).toBe(true)
    expect(toJavaScriptRegExp('\\Qa.b\\E', true).test('axb')).toBe(false)
    expect(toJavaScriptRegExp('[[:digit:]]+', true).test('id=42')).toBe(true)
    expect(toJavaScriptRegExp('[[:digit:]]+', true).test('none')).toBe(false)
    expect(toJavaScriptRegExp('^\\pL+$', true).test('abc')).toBe(true)
    expect(toJavaScriptRegExp('^\\pL+$', true).test('ab1')).toBe(false)
    expect(toJavaScriptRegExp('\\101', true).test('A')).toBe(true)
    expect(toJavaScriptRegExp('a\\Cb', true).test('a\nb')).toBe(true)
  })

  test('the dot matches newlines the way RE2 configures it for extensions', () => {
    // RE2::Options defaults to dot_nl = false, but urls carry no newlines; what matters is that
    // `.` never matches less than RE2 would.
    expect(toJavaScriptRegExp('a.b', true).test('a/b')).toBe(true)
  })
})
