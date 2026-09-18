import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorPageUrl } from '../url'
import {
  BLOCKED_BY_CLIENT_CODE,
  ERROR_PAGE_TOKENS,
  describeNetError,
  errorPageContent,
  errorPageHtml,
  overlayForUrl,
  parseZenUrl,
  zenPageHtml
} from '../zenPages'

const DNS = errorPageUrl(-105, 'net::ERR_NAME_NOT_RESOLVED', 'http://nonexistent.invalid/')
const REFUSED = errorPageUrl(-102, 'net::ERR_CONNECTION_REFUSED', 'http://localhost:1/')
const OFFLINE = errorPageUrl(-106, 'net::ERR_INTERNET_DISCONNECTED', 'https://example.com/')

describe('parseZenUrl', () => {
  it('names the page in hostname whatever the engine makes of a non-special scheme', () => {
    expect(parseZenUrl('zen://error?code=-102&url=http%3A%2F%2Fa.test%2F')?.hostname).toBe('error')
    expect(parseZenUrl('zen://blank')?.hostname).toBe('blank')
    expect(parseZenUrl('zen://reader?id=abc')?.searchParams.get('id')).toBe('abc')
  })

  it('keeps the whole query of an error URL', () => {
    const parsed = parseZenUrl(DNS)
    expect(parsed?.searchParams.get('code')).toBe('-105')
    expect(parsed?.searchParams.get('description')).toBe('net::ERR_NAME_NOT_RESOLVED')
    expect(parsed?.searchParams.get('url')).toBe('http://nonexistent.invalid/')
  })

  it('handles a path or fragment and any scheme casing', () => {
    expect(parseZenUrl('ZEN://Reader/x?id=7#top')?.hostname).toBe('reader')
    expect(parseZenUrl('zen://reader/x?id=7#top')?.searchParams.get('id')).toBe('7')
    expect(parseZenUrl('zen://image?id=a#b')?.searchParams.get('id')).toBe('a')
  })

  it('rejects anything that is not a zen:// URL', () => {
    expect(parseZenUrl('https://example.com/')).toBeNull()
    expect(parseZenUrl('https://zen.example/error?code=1')).toBeNull()
    expect(parseZenUrl('zen:error')).toBeNull()
    expect(parseZenUrl('zen://')).toBeNull()
    expect(parseZenUrl('')).toBeNull()
  })
})

describe('overlayForUrl', () => {
  it('names the overlay a zen:// address stands for, without URL.hostname', () => {
    expect(overlayForUrl('zen://history')).toBe('history')
    expect(overlayForUrl('zen://History/?q=x')).toBe('history')
    expect(overlayForUrl('zen://settings#privacy')).toBe('settings')
  })

  it('is null for documents and for other schemes', () => {
    expect(overlayForUrl(DNS)).toBeNull()
    expect(overlayForUrl('zen://blank')).toBeNull()
    expect(overlayForUrl('https://history/')).toBeNull()
    expect(overlayForUrl('')).toBeNull()
  })
})

describe('errorPageContent', () => {
  it("names the site in Chrome's words for a DNS failure", () => {
    const content = errorPageContent(
      -105,
      'net::ERR_NAME_NOT_RESOLVED',
      'http://nonexistent.invalid/'
    )
    expect(content).toEqual({
      title: "This site can't be reached",
      site: 'nonexistent.invalid',
      reason: "nonexistent.invalid's server IP address could not be found.",
      code: 'ERR_NAME_NOT_RESOLVED',
      target: 'http://nonexistent.invalid/'
    })
  })

  it('names the host, not the port, for a refused connection', () => {
    const content = errorPageContent(-102, 'net::ERR_CONNECTION_REFUSED', 'http://localhost:1/')
    expect(content.title).toBe("This site can't be reached")
    expect(content.site).toBe('localhost')
    expect(content.reason).toBe('localhost refused to connect.')
    expect(content.code).toBe('ERR_CONNECTION_REFUSED')
  })

  it('explains a reserved port, which is what localhost:1 is to Chromium', () => {
    // Port 1 is on Chromium's restricted list: the connection is never attempted.
    const content = errorPageContent(-312, 'net::ERR_UNSAFE_PORT', 'http://localhost:1/')
    expect(content.title).toBe("This site can't be reached")
    expect(content.reason).toBe('localhost uses a port Zenium does not connect to.')
    expect(content.code).toBe('ERR_UNSAFE_PORT')
  })

  it('tells the user the device is offline', () => {
    const content = errorPageContent(-106, 'net::ERR_INTERNET_DISCONNECTED', 'https://example.com/')
    expect(content.title).toBe('No internet')
    expect(content.reason).toMatch(/offline/)
    expect(content.reason).toMatch(/reload/i)
    expect(content.code).toBe('ERR_INTERNET_DISCONNECTED')
  })

  it("takes the host's Chromium name over the table and keeps the table's reason", () => {
    // WebView folds several net errors into one WebViewClient code; the description is exact.
    const content = errorPageContent(-105, 'net::ERR_ADDRESS_INVALID', 'http://0.0.0.0/')
    expect(content.code).toBe('ERR_ADDRESS_INVALID')
    expect(content.reason).toBe("0.0.0.0's server IP address could not be found.")
    expect(errorPageContent(-201, 'ERR_CERT_DATE_INVALID', 'https://expired.example/').code).toBe(
      'ERR_CERT_DATE_INVALID'
    )
  })

  it('has copy for every certificate error the Android host refuses with', () => {
    // NetErrors.sslCode: date → -201, name mismatch → -200, untrusted → -202, anything else → -207.
    for (const code of [-200, -201, -202, -207]) {
      const content = errorPageContent(code, '', 'https://bad.example/')
      expect(content.title).toBe('Your connection is not private')
      expect(content.reason).toContain('bad.example')
      expect(content.code).toMatch(/^ERR_CERT_/)
    }
    expect(errorPageContent(-207, '', 'https://bad.example/').code).toBe('ERR_CERT_INVALID')
  })

  it('falls back sensibly for codes it has no copy for', () => {
    const named = errorPageContent(-999, 'net::ERR_MADE_UP', 'https://a.example/')
    expect(named.title).toBe("This site can't be reached")
    expect(named.reason).toBe('The page could not be loaded.')
    expect(named.code).toBe('ERR_MADE_UP')
    const prose = errorPageContent(-999, 'The host said no.', 'https://a.example/')
    expect(prose.reason).toBe('The host said no.')
    expect(prose.code).toBe('')
    const bare = errorPageContent(-999, '', '')
    expect(bare.reason).toBe('The page could not be loaded.')
    expect(bare.site).toBe('')
  })

  it('renders a crashed renderer as Aw, Snap with the reason as the small line', () => {
    const content = errorPageContent(-1, 'The page crashed (killed)', 'https://a.example/')
    expect(content.title).toBe('Aw, Snap!')
    expect(content.code).toBe('The page crashed (killed)')
  })

  it('words the site-less reason for the hosts through describeNetError', () => {
    expect(describeNetError(-105, 'x')).toBe("The server's IP address could not be found.")
    expect(describeNetError(-102, 'x')).toBe('The server refused to connect.')
    expect(describeNetError(-999, 'fallback')).toBe('fallback')
  })
})

describe('errorPageHtml', () => {
  it('shows the title, the emphasised site, the error name and a Reload control', () => {
    const html = errorPageHtml(parseZenUrl(DNS)!)
    expect(html).toContain('<title>nonexistent.invalid</title>')
    expect(html).toContain('<h1>This site can&#39;t be reached</h1>')
    expect(html).toContain(
      '<p><strong>nonexistent.invalid</strong>&#39;s server IP address could not be found.</p>'
    )
    expect(html).toContain('<p class="code">ERR_NAME_NOT_RESOLVED</p>')
    expect(html).toContain(
      '<button type="button" onclick="location.replace(&quot;http://nonexistent.invalid/&quot;)">Reload</button>'
    )
    expect(html).not.toContain('New Tab')
  })

  it('escapes the failed URL so it cannot break out of the page', () => {
    const html = errorPageHtml(
      parseZenUrl(errorPageUrl(-102, '', 'http://x.example/?q="><script>alert(1)</script>'))!
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('leaves out what it does not have: no site, no code, no target', () => {
    const html = errorPageHtml(parseZenUrl('zen://error?code=-999')!)
    expect(html).toContain('<title>Problem loading page</title>')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('class="code"')
    expect(html).toContain('The page could not be loaded.')
  })

  it('carries no light-dark() and no per-component hex: colours come from the token block', () => {
    const html = errorPageHtml(parseZenUrl(REFUSED)!)
    expect(html).not.toContain('light-dark(')
    const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
    expect(style.startsWith(ERROR_PAGE_TOKENS)).toBe(true)
    const rules = style.slice(ERROR_PAGE_TOKENS.length)
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rules).not.toMatch(/rgba?\(/)
    expect(rules).toMatch(/var\(--v2-page\)/)
  })

  it('hands a request the engine blocked to the Zenium blocked page', () => {
    const html = errorPageHtml(
      parseZenUrl(
        errorPageUrl(BLOCKED_BY_CLIENT_CODE, 'ERR_BLOCKED_BY_CLIENT', 'https://ads.example/')
      )!
    )
    expect(html).toContain('<title>Page blocked</title>')
    expect(html).toContain('Zenium blocked this page')
    expect(html).toContain('<strong>ads.example</strong>')
  })
})

describe('zenPageHtml', () => {
  it('routes zen://error to the error page and unknown pages to the blank page', () => {
    expect(zenPageHtml(REFUSED)).toContain('<strong>localhost</strong> refused to connect.')
    expect(zenPageHtml(OFFLINE)).toContain('<h1>No internet</h1>')
    expect(zenPageHtml('zen://blank')).toContain('<title>New Tab</title>')
    expect(zenPageHtml('zen://nonsense')).toContain('<title>New Tab</title>')
    expect(zenPageHtml('zen://settings')).toContain('<title>New Tab</title>')
    expect(zenPageHtml('not a url')).toContain('<title>New Tab</title>')
  })

  it('renders the Zenium blocked page when the request engine stopped the navigation', () => {
    const html = zenPageHtml(
      errorPageUrl(BLOCKED_BY_CLIENT_CODE, 'ERR_BLOCKED_BY_CLIENT', 'https://ads.example/')
    )
    expect(html).toContain('<title>Page blocked</title>')
    expect(html).toContain('Zenium blocked this page')
    expect(html).toContain('<strong>ads.example</strong>')
  })

  it('resolves reader and image pages through the lookups', () => {
    expect(zenPageHtml('zen://reader?id=r1', (id) => `<p>${id}</p>`)).toBe('<p>r1</p>')
    expect(zenPageHtml('zen://reader?id=r1&url=https%3A%2F%2Fa.example%2F', () => null)).toContain(
      'location.replace("https://a.example/")'
    )
    expect(
      zenPageHtml('zen://image?id=i1', undefined, () => 'data:image/png;base64,AAAA')
    ).toContain('<img src="data:image/png;base64,AAAA"')
    expect(zenPageHtml('zen://image?id=i1', undefined, () => null)).toContain('no longer available')
  })

  describe('on a Chromium whose URL parses zen:// as an opaque path (before 130)', () => {
    const RealURL = globalThis.URL
    class OpaqueUrl extends RealURL {
      private get opaque(): boolean {
        return this.protocol === 'zen:'
      }
      override get hostname(): string {
        return this.opaque ? '' : super.hostname
      }
      override get host(): string {
        return this.opaque ? '' : super.host
      }
      override get pathname(): string {
        return this.opaque ? `//${super.hostname}${super.pathname}` : super.pathname
      }
    }
    afterEach(() => vi.unstubAllGlobals())

    it('still renders the error page instead of the blank page', () => {
      vi.stubGlobal('URL', OpaqueUrl)
      expect(new URL(DNS).hostname).toBe('')
      const html = zenPageHtml(DNS)
      expect(html).toContain('<h1>This site can&#39;t be reached</h1>')
      expect(html).toContain('<strong>nonexistent.invalid</strong>')
      expect(html).not.toContain('New Tab')
    })
  })
})
