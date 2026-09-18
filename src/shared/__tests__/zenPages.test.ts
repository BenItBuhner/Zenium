import { afterEach, describe, expect, it, vi } from 'vitest'
import chromeCss from '../../renderer/src/assets/main.css?raw'
import { classifyViewport, type ViewportMetrics } from '../formFactor'
import { errorPageUrl, httpsOnlyPageUrl, safeBrowsingPageUrl } from '../url'
import { INTERSTITIAL_MESSAGE_KEY } from '../interstitial'
import type { CertificateDetails } from '../types'
import {
  BLOCKED_BY_CLIENT_CODE,
  ERROR_PAGE_ATTRIBUTES_SCRIPT,
  ERROR_PAGE_RULES_START,
  certificateInterstitial,
  describeNetError,
  errorPageContent,
  errorPageHtml,
  errorPageStyle,
  inPlaceErrorPageScript,
  overlayForUrl,
  parseZenUrl,
  zenPageHtml
} from '../zenPages'

const DNS = errorPageUrl(-105, 'net::ERR_NAME_NOT_RESOLVED', 'http://nonexistent.invalid/')
const REFUSED = errorPageUrl(-102, 'net::ERR_CONNECTION_REFUSED', 'http://localhost:1/')
const OFFLINE = errorPageUrl(-106, 'net::ERR_INTERNET_DISCONNECTED', 'https://example.com/')

/** What the desktop host records of expired.badssl.com's certificate. */
const EXPIRED_CERT: CertificateDetails = {
  subjectName: '*.badssl.com',
  issuerName: 'COMODO RSA Domain Validation Secure Server CA',
  validStart: Date.UTC(2015, 3, 9),
  validExpiry: Date.UTC(2015, 3, 12),
  fingerprint: 'sha256/abc123+/='
}
const EXPIRED = errorPageUrl(
  -201,
  'net::ERR_CERT_DATE_INVALID',
  'https://expired.badssl.com/',
  EXPIRED_CERT
)

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
    expect(overlayForUrl('zen://downloads')).toBe('downloads')
    expect(overlayForUrl('zen://bookmarks')).toBe('bookmarks')
    // Settings is an internal page in a tab of its own (shared/internalPages.ts), not an overlay.
    expect(overlayForUrl('zen://settings#privacy')).toBeNull()
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
      target: 'http://nonexistent.invalid/',
      interstitial: null
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

  it("is the certificate interstitial for an ERR_CERT_* failure of an https address, in Chrome's structure", () => {
    const content = errorPageContent(
      -201,
      'net::ERR_CERT_DATE_INVALID',
      'https://expired.badssl.com/',
      EXPIRED_CERT
    )
    expect(content.title).toBe('Your connection is not private')
    expect(content.code).toBe('ERR_CERT_DATE_INVALID')
    const interstitial = content.interstitial!
    expect(interstitial.explanation).toContain('expired.badssl.com')
    expect(interstitial.explanation).toMatch(/expired or is not yet valid/)
    expect(interstitial.details.map((d) => d.label)).toEqual([
      'Issued to',
      'Issued by',
      'Valid from',
      'Valid until',
      'Fingerprint'
    ])
    expect(interstitial.details[0].value).toBe('*.badssl.com')
    expect(interstitial.details[4].value).toBe('sha256/abc123+/=')
    expect(interstitial.proceed).toBe('Proceed to expired.badssl.com (unsafe)')
  })

  it('explains each certificate error in its own words and the rest of the family generically', () => {
    const explain = (code: number): string =>
      certificateInterstitial(code, 'https://bad.example/', null)!.explanation
    expect(explain(-200)).toMatch(/for another site/)
    expect(explain(-201)).toMatch(/expired or is not yet valid/)
    expect(explain(-202)).toMatch(/not trusted by this device/)
    expect(explain(-207)).toMatch(/is not valid/)
    expect(explain(-213)).toMatch(/is not valid/)
    // A name mismatch names the site the certificate is for when the host could describe it.
    expect(
      certificateInterstitial(-200, 'https://wrong.host.badssl.com/', EXPIRED_CERT)!.explanation
    ).toContain('from *.badssl.com')
  })

  it('offers no proceed control without a fingerprint to remember the exception by', () => {
    const anonymous = certificateInterstitial(-202, 'https://self-signed.badssl.com/', null)!
    expect(anonymous.details).toEqual([])
    expect(anonymous.proceed).toBeNull()
    expect(anonymous.explanation).toContain('self-signed.badssl.com')
    const unnamed = certificateInterstitial(-202, 'https://self-signed.badssl.com/', {
      ...EXPIRED_CERT,
      fingerprint: ''
    })!
    expect(unnamed.proceed).toBeNull()
    expect(unnamed.details.map((d) => d.label)).not.toContain('Fingerprint')
  })

  it('is never an interstitial for another failure, or a certificate code off https', () => {
    expect(errorPageContent(-105, '', 'https://a.example/', EXPIRED_CERT).interstitial).toBeNull()
    expect(certificateInterstitial(-201, 'http://a.example/', EXPIRED_CERT)).toBeNull()
    expect(certificateInterstitial(-201, 'file:///etc/hosts', EXPIRED_CERT)).toBeNull()
    expect(certificateInterstitial(-201, '', EXPIRED_CERT)).toBeNull()
    expect(
      errorPageContent(-1, 'crashed', 'https://a.example/', EXPIRED_CERT).interstitial
    ).toBeNull()
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
    expect(html).toContain('<p class="zen-error-code">ERR_NAME_NOT_RESOLVED</p>')
    expect(html).toContain(
      '<button type="button" class="zen-v2-button" onclick="location.replace(&quot;http://nonexistent.invalid/&quot;)">Reload</button>'
    )
    expect(html).not.toContain('New Tab')
  })

  it('escapes the failed URL so it cannot break out of the page', () => {
    const html = errorPageHtml(
      parseZenUrl(errorPageUrl(-102, '', 'http://x.example/?q="><script>alert(1)</script>'))!
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('location.replace("')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('leaves out what it does not have: no site, no code, no target', () => {
    const html = errorPageHtml(parseZenUrl('zen://error?code=-999')!)
    expect(html).toContain('<title>Problem loading page</title>')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('class="zen-error-code"')
    expect(html).toContain('The page could not be loaded.')
  })

  it('is a v2 surface: the root attributes, the classes and the shared button', () => {
    const html = errorPageHtml(parseZenUrl(REFUSED)!)
    expect(html).toContain('<html class="zen-error-document">')
    expect(html).toContain(`<script>${ERROR_PAGE_ATTRIBUTES_SCRIPT}</script><style>`)
    expect(html).toContain('<body class="zen-error-page">')
    expect(html).toContain('<p class="zen-error-code">ERR_CONNECTION_REFUSED</p>')
    expect(html).toContain('<button type="button" class="zen-v2-button" onclick=')
    const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
    expect(style).toBe(errorPageStyle())
  })

  it('renders the certificate interstitial: Advanced then Back to safety last in the action row, the details and Proceed hidden', () => {
    const html = errorPageHtml(parseZenUrl(EXPIRED)!)
    expect(html).toContain('<title>expired.badssl.com</title>')
    expect(html).toContain('<h1>Your connection is not private</h1>')
    expect(html).toContain('<p class="zen-error-code">ERR_CERT_DATE_INVALID</p>')
    expect(html).not.toContain('>Reload</button>')
    // §9.11: the page's action row has its primary last, so it trails on both platforms.
    const actions = html.indexOf('<div class="zen-error-actions">')
    const advanced = html.indexOf('>Advanced</button>')
    const back = html.indexOf('>Back to safety</button>')
    const proceed = html.indexOf('>Proceed to expired.badssl.com (unsafe)</button>')
    expect(actions).toBeGreaterThan(0)
    expect(advanced).toBeGreaterThan(actions)
    expect(back).toBeGreaterThan(advanced)
    expect(back).toBeLessThan(html.indexOf('</div>', actions))
    expect(proceed).toBeGreaterThan(back)
    // Back is the one primary button; Proceed reads as text inside the hidden Advanced block.
    expect(html).toContain('class="zen-v2-button" data-primary onclick=')
    expect(html).toContain('<section id="zen-error-advanced" class="zen-error-advanced" hidden>')
    expect(html).toContain('aria-expanded="false" aria-controls="zen-error-advanced"')
    expect(html).toContain('<button type="button" class="zen-error-proceed" onclick=')
    expect(html).toContain('<dt>Issued to</dt><dd>*.badssl.com</dd>')
    expect(html).toContain('<dt>Fingerprint</dt><dd>sha256/abc123+/=</dd>')
  })

  it("posts the interstitial message the other warning pages post, with the page's URL", () => {
    const html = errorPageHtml(parseZenUrl(EXPIRED)!)
    const message = (action: string): string =>
      `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:&quot;${action}&quot;,url:&quot;https://expired.badssl.com/&quot;}},&#39;*&#39;)`
    expect(html).toContain(`onclick="${message('back')}">Back to safety</button>`)
    expect(html).toContain(`onclick="${message('proceed')}">Proceed to expired.badssl.com (unsafe)`)
  })

  it('shows the interstitial without a certificate too, with no way to proceed', () => {
    const html = errorPageHtml(
      parseZenUrl(
        errorPageUrl(-202, 'net::ERR_CERT_AUTHORITY_INVALID', 'https://self-signed.badssl.com/')
      )!
    )
    expect(html).toContain('<h1>Your connection is not private</h1>')
    expect(html).toContain('>Back to safety</button>')
    expect(html).toContain('>Advanced</button>')
    expect(html).not.toContain('Proceed to')
    expect(html).not.toContain('<dl')
  })

  it('escapes the certificate fields like the rest of the page', () => {
    const html = errorPageHtml(
      parseZenUrl(
        errorPageUrl(-200, '', 'https://a.example/', {
          ...EXPIRED_CERT,
          subjectName: '<img src=x onerror=alert(1)>'
        })
      )!
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
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

  describe('the warning pages (Safe Browsing, HTTPS-only mode)', () => {
    const safeBrowsing = errorPageHtml(
      parseZenUrl(safeBrowsingPageUrl('https://evil.example/login', 'phishing'))!
    )
    const httpsOnly = errorPageHtml(parseZenUrl(httpsOnlyPageUrl('http://plain.example/', -102))!)

    it('is the v2 error surface with a title block in status ink and the actions under it', () => {
      for (const html of [safeBrowsing, httpsOnly]) {
        expect(html).toContain('<html class="zen-error-document">')
        expect(html).toContain('<body class="zen-error-page">')
        expect(html).toContain('<script>' + ERROR_PAGE_ATTRIBUTES_SCRIPT + '</script>')
        expect(html).toContain('<style>' + errorPageStyle() + '</style>')
        expect(html).toContain('class="zen-interstitial-title"')
        expect(html).toContain('class="zen-interstitial-actions"')
      }
      expect(safeBrowsing).toContain(
        '<main data-interstitial="safebrowsing" data-threat="phishing">'
      )
      expect(safeBrowsing).toContain('data-tone="danger"')
      expect(httpsOnly).toContain('<main data-interstitial="https-only">')
      expect(httpsOnly).toContain('data-tone="warn"')
    })

    it('makes Back to safety the one primary, trailing, with Details and the way on as secondaries', () => {
      for (const html of [safeBrowsing, httpsOnly]) {
        expect(html.match(/<button[^>]* data-primary/g)).toHaveLength(1)
        expect(html).toContain(
          'class="zen-v2-button zen-interstitial-action" data-primary autofocus data-action="back"><span class="zen-interstitial-label">Back to safety</span>'
        )
        expect(html).toContain(
          'id="zen-details-toggle" class="zen-v2-button zen-interstitial-action" aria-expanded="false" aria-controls="zen-details">Details</button>'
        )
        expect(html.indexOf('>Details</button>')).toBeLessThan(html.indexOf('data-action="back"'))
        expect(html).toContain('<section id="zen-details" class="zen-interstitial-details" hidden>')
      }
      // Safe Browsing's way on is under Details, in danger ink; HTTPS-only's Continue stands
      // beside Back to safety and Always allow is under Details.
      expect(safeBrowsing).toContain(
        'zen-interstitial-action zen-interstitial-danger" data-action="proceed"><span class="zen-interstitial-label">Proceed anyway (unsafe)</span>'
      )
      expect(safeBrowsing.indexOf('id="zen-details"')).toBeLessThan(
        safeBrowsing.indexOf('data-action="proceed"')
      )
      expect(httpsOnly).toContain(
        'data-action="continue"><span class="zen-interstitial-label">Continue to HTTP site</span>'
      )
      expect(httpsOnly.indexOf('data-action="continue"')).toBeLessThan(
        httpsOnly.indexOf('data-action="back"')
      )
      expect(httpsOnly).toContain(
        'data-action="continue-always"><span class="zen-interstitial-label">Always allow for this site</span>'
      )
      expect(httpsOnly.indexOf('id="zen-details"')).toBeLessThan(
        httpsOnly.indexOf('data-action="continue-always"')
      )
    })

    it('every action carries the spinner it shows while busy and posts the page message for its URL', () => {
      expect(safeBrowsing.match(/class="zen-interstitial-spinner"/g)).toHaveLength(2)
      expect(httpsOnly.match(/class="zen-interstitial-spinner"/g)).toHaveLength(3)
      expect(safeBrowsing).toContain(
        `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:b.dataset.action,url:"https://evil.example/login"}},"*")`
      )
      expect(httpsOnly).toContain(
        `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:b.dataset.action,url:"http://plain.example/"}},"*")`
      )
      expect(safeBrowsing).toContain('b.setAttribute("aria-busy","true")')
      expect(safeBrowsing).toContain('if(o!==b)o.disabled=true')
    })

    it('names the site and the reason, escaped, and says where the setting lives', () => {
      expect(safeBrowsing).toContain(
        '<strong>evil.example</strong> is on one of the open malware and phishing feeds'
      )
      expect(safeBrowsing).toContain(
        'class="zen-interstitial-address">https://evil.example/login</p>'
      )
      expect(httpsOnly).toContain(
        'Zenium tried to reach <strong>plain.example</strong> over https and could not.'
      )
      expect(httpsOnly).toContain('(-102)')
      expect(httpsOnly).toContain('Settings &rsaquo; Privacy and Security')
      const hostile = errorPageHtml(
        parseZenUrl(httpsOnlyPageUrl('http://<img src=x onerror=alert(1)>/', -102))!
      )
      expect(hostile).not.toContain('<img')
    })
  })
})

describe('inPlaceErrorPageScript', () => {
  it("writes the page into the engine's error document only, root attributes included", () => {
    const script = inPlaceErrorPageScript(parseZenUrl(EXPIRED)!)
    expect(script).toContain("if(location.protocol!=='chrome-error:')return false;")
    expect(script).toContain('root.innerHTML=doc.documentElement.innerHTML')
    expect(script).toContain(ERROR_PAGE_ATTRIBUTES_SCRIPT)
    // The page travels as one JSON string argument, so nothing of it is parsed as script.
    expect(script.endsWith(`})(${JSON.stringify(errorPageHtml(parseZenUrl(EXPIRED)!))})`)).toBe(
      true
    )
  })
})

describe('errorPageStyle', () => {
  const style = errorPageStyle(chromeCss)

  it("is cut from the chrome's stylesheet: the v2 token block, the v2 button and the page's rules", () => {
    // The token block, light and dark, and the pointer and form-factor overrides.
    expect(style).toMatch(/^:root \{\n\s+--v2-page: #fbfbfe;/)
    expect(style).toContain(":root[data-theme='dark'] {")
    expect(style).toContain(":root[data-pointer='coarse'] {")
    expect(style).toContain(":root[data-form-factor='phone'] {")
    expect(style).toContain("[class^='zen-v2-']:focus-visible")
    // The button the Reload control is, with its variants.
    expect(style).toContain('.zen-v2-button {')
    expect(style).toContain('.zen-v2-button:active:not(:disabled) {')
    // The page's own rules, up to the layers.
    expect(style).toContain(ERROR_PAGE_RULES_START)
    expect(style).toContain('.zen-error-page {')
    expect(style).toContain('.zen-error-code {')
    expect(style).not.toContain('@layer')
    expect(style).not.toContain('/*')
    expect(style).not.toContain('light-dark(')
  })

  it('reads every colour and size of its own rules from a token', () => {
    const own = style.slice(style.indexOf(ERROR_PAGE_RULES_START))
    expect(own).toMatch(/var\(--v2-page\)/)
    expect(own).toMatch(/var\(--v2-text\)/)
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(own).not.toMatch(/rgba?\(/)
    expect(own).not.toMatch(/color-mix\(/)
  })

  it("right-aligns the certificate interstitial's action row on desktop and splits it on the phone", () => {
    // §9.11: a page's action row hugs and right-aligns in the content column with the primary
    // last on desktop; on the phone its two peers split the column at 8, the primary trailing.
    const actions = style.slice(style.indexOf('.zen-error-actions {'))
    const rule = actions.slice(0, actions.indexOf('}'))
    expect(rule).toContain('justify-content: flex-end;')
    expect(rule).toContain('gap: 8px;')
    const phone = style.slice(
      style.indexOf(":root[data-form-factor='phone'] .zen-error-actions > * {")
    )
    expect(phone.slice(0, phone.indexOf('}'))).toContain('flex: 1;')
  })

  it('is what the built page carries, and degrades to nothing when a marker is gone', () => {
    expect(errorPageStyle()).toBe(style)
    expect(errorPageStyle('')).toBe('')
    const withoutOwnRules = chromeCss.replace(ERROR_PAGE_RULES_START, '.gone {')
    const parts = errorPageStyle(withoutOwnRules)
    expect(parts).toContain('.zen-v2-button {')
    expect(parts).not.toContain('.zen-error-page {')
  })
})

describe('ERROR_PAGE_ATTRIBUTES_SCRIPT', () => {
  /**
   * Runs the page's inline script against a fake window and returns the root's data attributes.
   * `webViewSaysFine` is the Android WebView reporting `pointer: fine` on a plain touch screen,
   * which the script (like the chrome) sees through by the touch points.
   */
  function attributes(
    metrics: ViewportMetrics,
    { dark = false, webViewSaysFine = false } = {}
  ): Record<string, string> {
    const dataset: Record<string, string> = {}
    const queries: Record<string, boolean> = {
      '(prefers-color-scheme: dark)': dark,
      '(hover: hover)': metrics.hover,
      '(pointer: coarse)': metrics.coarse && !webViewSaysFine
    }
    const maxTouchPoints = metrics.coarse ? 5 : 0
    const run = new Function(
      'document',
      'matchMedia',
      'navigator',
      'innerWidth',
      'innerHeight',
      ERROR_PAGE_ATTRIBUTES_SCRIPT
    )
    run(
      { documentElement: { dataset } },
      (m: string) => ({ matches: queries[m] ?? false }),
      { maxTouchPoints },
      metrics.width,
      metrics.height
    )
    return dataset
  }

  it("classifies the viewport the way the chrome does, with the chrome's attribute names", () => {
    const cases: ViewportMetrics[] = [
      { width: 412, height: 915, coarse: true, hover: false },
      { width: 915, height: 412, coarse: true, hover: false },
      { width: 800, height: 1280, coarse: true, hover: false },
      { width: 1280, height: 800, coarse: true, hover: true },
      { width: 1440, height: 900, coarse: false, hover: true },
      { width: 500, height: 900, coarse: false, hover: true }
    ]
    for (const metrics of cases) {
      const attrs = attributes(metrics)
      expect(attrs.formFactor, JSON.stringify(metrics)).toBe(classifyViewport(metrics))
      expect(attrs.pointer).toBe(metrics.coarse ? 'coarse' : 'fine')
    }
  })

  it('sets the theme only for dark, and reads a touch screen with or without pointer: coarse', () => {
    const phone = { width: 412, height: 915, coarse: true, hover: false }
    expect(attributes(phone).theme).toBeUndefined()
    expect(attributes(phone, { dark: true }).theme).toBe('dark')
    const seenAsFine = attributes(phone, { webViewSaysFine: true })
    expect(seenAsFine.pointer).toBe('coarse')
    expect(seenAsFine.formFactor).toBe('phone')
    expect(attributes({ ...phone, coarse: false, hover: true }).pointer).toBe('fine')
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
