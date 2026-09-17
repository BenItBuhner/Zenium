import { describe, expect, it } from 'vitest'
import {
  applyRegexSubstitution,
  compileRegexFilter,
  compileUrlFilter,
  urlFilterToRegExpSource
} from '../urlFilter'

describe('urlFilter anchors', () => {
  it('|| anchors to the start of a domain or subdomain', () => {
    const m = compileUrlFilter('||ads.example^')
    expect(m('https://ads.example/pixel.gif')).toBe(true)
    expect(m('https://cdn.ads.example/x')).toBe(true)
    expect(m('http://ads.example')).toBe(true)
    expect(m('https://notads.example/')).toBe(false)
    expect(m('https://good.example/?ref=ads.example')).toBe(false)
    expect(m('https://ads.example.evil/')).toBe(false)
  })

  it('| anchors to the start and the end of the URL', () => {
    expect(compileUrlFilter('|https://a.example/')('https://a.example/')).toBe(true)
    expect(compileUrlFilter('|https://a.example/')('http://x/https://a.example/')).toBe(false)
    expect(compileUrlFilter('.swf|')('https://a.example/movie.swf')).toBe(true)
    expect(compileUrlFilter('.swf|')('https://a.example/movie.swf?x')).toBe(false)
  })

  it('^ matches separators and the end of the URL, but not letters, digits or _-.%', () => {
    const m = compileUrlFilter('/ads^')
    expect(m('https://a.example/ads?x=1')).toBe(true)
    expect(m('https://a.example/ads/')).toBe(true)
    expect(m('https://a.example/ads')).toBe(true)
    expect(m('https://a.example/adsense')).toBe(false)
    expect(m('https://a.example/ads_x')).toBe(false)
    expect(m('https://a.example/ads-x')).toBe(false)
    expect(m('https://a.example/ads.js')).toBe(false)
    expect(m('https://a.example/ads%20')).toBe(false)
  })

  it('* matches any run of characters', () => {
    const m = compileUrlFilter('||a.example/*/track/*.gif')
    expect(m('https://a.example/v2/track/p.gif')).toBe(true)
    expect(m('https://a.example/track/p.gif')).toBe(false)
  })

  it('is case-insensitive by default and case-sensitive on request', () => {
    expect(compileUrlFilter('/AdServer/')('https://a.example/adserver/x')).toBe(true)
    expect(compileUrlFilter('/AdServer/', true)('https://a.example/adserver/x')).toBe(false)
    expect(compileUrlFilter('||A.Example^', true)('https://a.example/')).toBe(false)
    expect(compileUrlFilter('||A.Example^')('https://a.example/')).toBe(true)
  })

  it('plain substrings match anywhere and an empty filter matches everything', () => {
    expect(compileUrlFilter('tracker')('https://a.example/tracker.js')).toBe(true)
    expect(compileUrlFilter('tracker')('https://tracker.example/')).toBe(true)
    expect(compileUrlFilter('')('https://anything/')).toBe(true)
  })

  it('escapes regular-expression characters in the pattern', () => {
    expect(compileUrlFilter('/ad.php?id=')('https://a.example/ad.php?id=1')).toBe(true)
    expect(compileUrlFilter('/ad.php?id=')('https://a.example/adXphp?id=1')).toBe(false)
    expect(urlFilterToRegExpSource('a(b)c')).toContain('\\(b\\)')
  })

  it('a | inside the pattern is a literal character, not an alternation', () => {
    // EasyList ships `/adiframe|*|adtech;` (via uBlock Origin Lite); read as a regex alternation
    // its middle branch `.*` matched every URL, main frames included.
    const m = compileUrlFilter('/adiframe|*|adtech;')
    expect(m('http://127.0.0.1/ads.html')).toBe(false)
    expect(m('https://a.example/page?x=1')).toBe(false)
    expect(m('https://a.example/adiframe|foo|adtech;')).toBe(true)
    expect(urlFilterToRegExpSource('a|b')).toBe('a\\|b')
    expect(urlFilterToRegExpSource('|a|b|')).toBe('^a\\|b$')
  })
})

describe('regexFilter', () => {
  it('compiles valid expressions and rejects invalid ones', () => {
    expect(compileRegexFilter('^https?://(\\w+)\\.ads\\.')).toBeInstanceOf(RegExp)
    expect(compileRegexFilter('(')).toBeNull()
  })

  it('applies \\1-style substitutions', () => {
    const re = compileRegexFilter('^https://(\\w+)\\.tracker\\.example/(.*)$')!
    expect(
      applyRegexSubstitution(
        re,
        'https://cdn.tracker.example/p.js',
        'https://\\1.clean.example/\\2'
      )
    ).toBe('https://cdn.clean.example/p.js')
    expect(applyRegexSubstitution(re, 'https://other/', 'x')).toBeNull()
  })
})
