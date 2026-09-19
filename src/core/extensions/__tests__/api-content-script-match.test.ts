import { describe, expect, it } from 'vitest'
import {
  contentScriptAppliesTo,
  effectiveMatchUrl,
  globToRegExp,
  matchesAnyPattern,
  parseMatchPattern,
  type ContentScriptMatch
} from '../api/matchPattern'

const matches = (pattern: string, url: string): boolean => matchesAnyPattern(url, pattern)

describe('match patterns as content scripts use them', () => {
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

  it('takes patterns apart for origin planning and rejects invalid ones', () => {
    expect(parseMatchPattern('*://*.youtube.com/watch*')).toEqual({
      schemes: ['http', 'https'],
      host: '*.youtube.com',
      port: null,
      path: '/watch*',
      matchesAllUrls: false
    })
    expect(parseMatchPattern('https://example.org:8443/*')).toMatchObject({
      host: 'example.org',
      port: '8443'
    })
    expect(parseMatchPattern('<all_urls>')).toMatchObject({ matchesAllUrls: true, host: '*' })
    expect(parseMatchPattern('file:///*')).toMatchObject({ schemes: ['file'], host: '' })
    expect(parseMatchPattern('https://www.google.com')).toBeNull()
    expect(parseMatchPattern('https://*foo/bar')).toBeNull()
    expect(parseMatchPattern('https://foo.*.bar/baz')).toBeNull()
    expect(parseMatchPattern('http:/bar')).toBeNull()
    expect(parseMatchPattern('foo://*')).toBeNull()
  })

  it("follows Chromium's file grammar: no host, the rest is the path glob", () => {
    // Violentmonkey's install listener and the common `file://*/*` host permission.
    expect(matches('file://*/*.user.js', 'file:///home/me/hello.user.js')).toBe(true)
    expect(matches('file://*/*.user.js', 'file:///hello.user.js')).toBe(true)
    expect(matches('file://*/*.user.js', 'file:///home/me/hello.js')).toBe(false)
    expect(matches('file://*/*.user.js', 'https://example.org/hello.user.js')).toBe(false)
    expect(matches('file://*/*', 'file:///etc/hosts')).toBe(true)
    expect(matches('file:///*', 'file:///etc/hosts')).toBe(true)
    expect(matches('file:///etc/*', 'file:///etc/hosts')).toBe(true)
    expect(matches('file:///etc/*', 'file:///var/log')).toBe(false)
    // The URL's host is ignored, as Chromium does for file URLs.
    expect(matches('file:///share/*', 'file://server/share/x')).toBe(true)
    expect(matches('file://', 'file:///x')).toBe(false)
    expect(parseMatchPattern('file://*/*.user.js')).toEqual({
      schemes: ['file'],
      host: '',
      port: null,
      path: '*/*.user.js',
      matchesAllUrls: false
    })
    expect(parseMatchPattern('file://')).toBeNull()
  })

  it('ignores ports without one in the pattern and the fragment, but not the query', () => {
    expect(matches('https://example.org/*', 'https://example.org:8443/x')).toBe(true)
    expect(matches('https://example.org/a', 'https://example.org/a#frag')).toBe(true)
    expect(matches('https://example.org/a', 'https://example.org/a?q')).toBe(false)
    // `?` in the path part of a match pattern is literal (the query separator), not a wildcard.
    expect(matches('https://example.org/a?q=1', 'https://example.org/a?q=1')).toBe(true)
    expect(matches('https://example.org/a?q=1', 'https://example.org/aXq=1')).toBe(false)
  })

  it('skips unparsable entries in a list', () => {
    expect(matchesAnyPattern('https://example.org/', ['garbage', 'https://example.org/*'])).toBe(
      true
    )
  })
})

describe('globs', () => {
  const globMatches = (glob: string, url: string): boolean => globToRegExp(glob).test(url)
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

const declaration = (overrides: Partial<ContentScriptMatch>): ContentScriptMatch => ({
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: false,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
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
    expect(effectiveMatchUrl(declaration({}), blank)).toBeNull()
    expect(effectiveMatchUrl(declaration({ matchAboutBlank: true }), blank)).toBe(
      'https://www.youtube.com/'
    )
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

  it('never matches chrome pages through <all_urls>', () => {
    expect(
      contentScriptAppliesTo(declaration({}), {
        url: 'chrome://newtab/',
        isTopFrame: true,
        precursorUrl: null
      })
    ).toBe(false)
  })
})

describe('host permissions', () => {
  it('checks MV3 host_permissions against a URL', () => {
    expect(matchesAnyPattern('https://a.example/', ['<all_urls>'])).toBe(true)
    expect(matchesAnyPattern('https://m.youtube.com/x', ['https://*.youtube.com/*'])).toBe(true)
    expect(matchesAnyPattern('https://vimeo.com/x', ['https://*.youtube.com/*'])).toBe(false)
    expect(matchesAnyPattern('https://vimeo.com/x', [])).toBe(false)
  })
})
