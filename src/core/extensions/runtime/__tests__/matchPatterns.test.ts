import { describe, expect, it } from 'vitest'
import type { ContentScriptDeclaration } from '../manifest'
import {
  anyPatternMatches,
  contentScriptAppliesTo,
  globMatches,
  hasHostPermission,
  matchPatternTest,
  parseMatchPattern,
  splitUrl
} from '../matchPatterns'

const matches = (pattern: string, url: string): boolean => {
  const parsed = parseMatchPattern(pattern)
  const parts = splitUrl(url)
  if (!parsed || !parts) return false
  return matchPatternTest(parsed, parts)
}

describe('match patterns', () => {
  it('handles the documented Chrome examples', () => {
    expect(matches('https://*/*', 'https://www.google.com/')).toBe(true)
    expect(matches('https://*/foo*', 'https://example.com/foo/bar.html')).toBe(true)
    expect(matches('https://*/foo*', 'https://example.com/bar/foo')).toBe(false)
    expect(matches('https://*.google.com/foo*bar', 'https://docs.google.com/foobar')).toBe(true)
    expect(matches('https://*.google.com/foo*bar', 'https://www.google.com/foo/baz/bar')).toBe(true)
    expect(matches('https://example.org/foo/bar.html', 'https://example.org/foo/bar.html')).toBe(
      true
    )
    expect(matches('https://example.org/foo/bar.html', 'https://example.org/foo/bar.htm')).toBe(
      false
    )
    expect(matches('http://127.0.0.1/*', 'http://127.0.0.1/foo/bar.html')).toBe(true)
    expect(matches('*://mail.google.com/*', 'http://mail.google.com/foo')).toBe(true)
    expect(matches('*://mail.google.com/*', 'https://mail.google.com/foo')).toBe(true)
    expect(matches('*://mail.google.com/*', 'ftp://mail.google.com/foo')).toBe(false)
    expect(matches('<all_urls>', 'https://example.org/')).toBe(true)
    expect(matches('<all_urls>', 'file:///a/b')).toBe(true)
    expect(matches('<all_urls>', 'chrome://settings/')).toBe(false)
  })

  it('treats a bare host as the host plus subdomain wildcard rules', () => {
    expect(matches('https://*.google.com/*', 'https://google.com/')).toBe(true)
    expect(matches('https://google.com/*', 'https://www.google.com/')).toBe(false)
    expect(matches('https://*google.com/*', 'https://www.google.com/')).toBe(false)
  })

  it('rejects invalid patterns', () => {
    expect(parseMatchPattern('https://www.google.com')).toBeNull()
    expect(parseMatchPattern('https://*foo/bar')).toBeNull()
    expect(parseMatchPattern('https://foo.*.bar/baz')).toBeNull()
    expect(parseMatchPattern('http:/bar')).toBeNull()
    expect(parseMatchPattern('foo://*')).toBeNull()
  })

  it('ignores ports and the fragment the way Chrome does', () => {
    expect(matches('https://example.org/*', 'https://example.org:8443/x')).toBe(true)
    expect(matches('https://example.org/a', 'https://example.org/a#frag')).toBe(true)
    expect(matches('https://example.org/a', 'https://example.org/a?q')).toBe(false)
  })

  it('anyPatternMatches skips unparsable entries', () => {
    const parts = splitUrl('https://example.org/')
    expect(parts && anyPatternMatches(['garbage', 'https://example.org/*'], parts)).toBe(true)
  })
})

describe('globs', () => {
  it('supports * and ? and is case sensitive', () => {
    expect(globMatches('https://???.example.com/foo*bar', 'https://www.example.com/foo/bar')).toBe(
      true
    )
    expect(globMatches('*nytimes.com/???s/*', 'https://www.nytimes.com/arts/index.html')).toBe(true)
    expect(globMatches('*nytimes.com/???s/*', 'https://www.nytimes.com/jobs/index.html')).toBe(true)
    expect(globMatches('*nytimes.com/???s/*', 'https://www.nytimes.com/sports/x')).toBe(false)
    expect(globMatches('*Foo*', 'https://x/foo')).toBe(false)
  })
})

const declaration = (overrides: Partial<ContentScriptDeclaration>): ContentScriptDeclaration => ({
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  js: ['a.js'],
  css: [],
  runAt: 'document_idle',
  allFrames: false,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  world: 'ISOLATED',
  ...overrides
})

describe('contentScriptAppliesTo', () => {
  const top = { url: 'https://www.youtube.com/watch?v=1', isTopFrame: true, precursorUrl: null }
  it('applies matches/exclude_matches/globs in order', () => {
    expect(contentScriptAppliesTo(declaration({ matches: ['*://*.youtube.com/*'] }), top)).toBe(
      true
    )
    expect(
      contentScriptAppliesTo(
        declaration({
          matches: ['*://*.youtube.com/*'],
          excludeMatches: ['*://*.youtube.com/watch*']
        }),
        top
      )
    ).toBe(false)
    expect(contentScriptAppliesTo(declaration({ includeGlobs: ['*watch*'] }), top)).toBe(true)
    expect(contentScriptAppliesTo(declaration({ includeGlobs: ['*embed*'] }), top)).toBe(false)
    expect(contentScriptAppliesTo(declaration({ excludeGlobs: ['*?v=*'] }), top)).toBe(false)
  })

  it('needs all_frames for subframes and match_about_blank for blank frames', () => {
    const sub = { url: 'https://ads.example/x', isTopFrame: false, precursorUrl: null }
    expect(contentScriptAppliesTo(declaration({}), sub)).toBe(false)
    expect(contentScriptAppliesTo(declaration({ allFrames: true }), sub)).toBe(true)
    const blank = {
      url: 'about:blank',
      isTopFrame: false,
      precursorUrl: 'https://www.youtube.com/'
    }
    expect(
      contentScriptAppliesTo(
        declaration({ allFrames: true, matches: ['*://*.youtube.com/*'] }),
        blank
      )
    ).toBe(false)
    expect(
      contentScriptAppliesTo(
        declaration({ allFrames: true, matches: ['*://*.youtube.com/*'], matchAboutBlank: true }),
        blank
      )
    ).toBe(true)
    const data = {
      url: 'data:text/html,hi',
      isTopFrame: false,
      precursorUrl: 'https://www.youtube.com/'
    }
    expect(
      contentScriptAppliesTo(declaration({ allFrames: true, matchAboutBlank: true }), data)
    ).toBe(false)
    expect(
      contentScriptAppliesTo(declaration({ allFrames: true, matchOriginAsFallback: true }), data)
    ).toBe(true)
  })

  it('never matches the extension origin or chrome pages through <all_urls>', () => {
    expect(
      contentScriptAppliesTo(declaration({}), {
        url: 'chrome://newtab/',
        isTopFrame: true,
        precursorUrl: null
      })
    ).toBe(false)
  })
})

describe('hasHostPermission', () => {
  it('checks MV3 host_permissions against a URL', () => {
    expect(hasHostPermission(['<all_urls>'], 'https://a.example/')).toBe(true)
    expect(hasHostPermission(['https://*.youtube.com/*'], 'https://m.youtube.com/x')).toBe(true)
    expect(hasHostPermission(['https://*.youtube.com/*'], 'https://vimeo.com/x')).toBe(false)
    expect(hasHostPermission([], 'https://vimeo.com/x')).toBe(false)
  })
})
