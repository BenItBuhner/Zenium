import { describe, expect, it } from 'vitest'
import {
  compileHeaderConditions,
  compileHeaderGlob,
  indexReceivedHeaders,
  matchesHeaderConditions,
  matchesHeaderStage,
  type ReceivedHeaders
} from '../headerCondition'

const received = (headers: Record<string, string[]>): ReceivedHeaders =>
  indexReceivedHeaders(headers)

describe('compileHeaderGlob', () => {
  it('matches like base::MatchPattern, without regard to case', () => {
    const glob = compileHeaderGlob('text/*')
    expect(glob.test('text/css')).toBe(true)
    expect(glob.test('text/')).toBe(true)
    expect(glob.test('application/json')).toBe(false)
    expect(compileHeaderGlob('TEXT/CSS').test('text/css; charset=utf-8'.toLowerCase())).toBe(false)
    expect(compileHeaderGlob('text/css*').test('text/css; charset=utf-8')).toBe(true)
  })

  it('treats ? as zero or one character and \\ as an escape', () => {
    const one = compileHeaderGlob('a?c')
    expect(one.test('abc')).toBe(true)
    expect(one.test('ac')).toBe(true)
    expect(one.test('abbc')).toBe(false)
    const literal = compileHeaderGlob('100\\*')
    expect(literal.test('100*')).toBe(true)
    expect(literal.test('1000')).toBe(false)
    expect(compileHeaderGlob('a.b').test('axb')).toBe(false)
  })
})

describe('matchesHeaderConditions', () => {
  it('needs the header present, with any value when the condition names none', () => {
    const conditions = compileHeaderConditions([{ header: 'X-Ads' }])!
    expect(matchesHeaderConditions(received({ 'x-ads': ['1'] }), conditions)).toBe(true)
    expect(matchesHeaderConditions(received({ 'X-ADS': ['anything'] }), conditions)).toBe(true)
    expect(matchesHeaderConditions(received({ 'x-other': ['1'] }), conditions)).toBe(false)
  })

  it('matches values against the globs and lets excludedValues veto a header', () => {
    const conditions = compileHeaderConditions([
      { header: 'content-type', values: ['text/*'], excludedValues: ['text/html*'] }
    ])!
    expect(matchesHeaderConditions(received({ 'Content-Type': ['text/css'] }), conditions)).toBe(
      true
    )
    expect(
      matchesHeaderConditions(
        received({ 'content-type': ['text/html; charset=utf-8'] }),
        conditions
      )
    ).toBe(false)
    expect(
      matchesHeaderConditions(received({ 'content-type': ['application/json'] }), conditions)
    ).toBe(false)
    // Several lines: one excluded line vetoes the header, as Chrome does.
    expect(
      matchesHeaderConditions(received({ 'content-type': ['text/css', 'text/html'] }), conditions)
    ).toBe(false)
  })

  it('is satisfied by any one of several conditions', () => {
    const conditions = compileHeaderConditions([
      { header: 'x-a', values: ['1'] },
      { header: 'x-b' }
    ])!
    expect(matchesHeaderConditions(received({ 'x-a': ['2'], 'x-b': ['x'] }), conditions)).toBe(true)
    expect(matchesHeaderConditions(received({ 'x-a': ['2'] }), conditions)).toBe(false)
  })

  it('compiles nothing for an absent or empty list', () => {
    expect(compileHeaderConditions(undefined)).toBeNull()
    expect(compileHeaderConditions([])).toBeNull()
  })
})

describe('matchesHeaderStage', () => {
  it('requires responseHeaders to match and excludedResponseHeaders not to', () => {
    const include = compileHeaderConditions([{ header: 'content-type', values: ['text/*'] }])
    const exclude = compileHeaderConditions([{ header: 'x-no-install' }])
    const css = received({ 'content-type': ['text/css'] })
    expect(matchesHeaderStage(css, include, exclude)).toBe(true)
    expect(matchesHeaderStage(css, include, null)).toBe(true)
    expect(
      matchesHeaderStage(
        received({ 'content-type': ['text/css'], 'x-no-install': ['1'] }),
        include,
        exclude
      )
    ).toBe(false)
    expect(matchesHeaderStage(received({ 'content-type': ['image/png'] }), include, exclude)).toBe(
      false
    )
    expect(matchesHeaderStage(received({}), null, exclude)).toBe(true)
  })
})
