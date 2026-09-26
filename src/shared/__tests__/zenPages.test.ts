import { afterEach, describe, expect, it, vi } from 'vitest'
import chromeCss from '../../renderer/src/assets/main.css?raw'
import { classifyViewport, type ViewportMetrics } from '../formFactor'
import {
  crashPageUrl,
  errorPageSearchOf,
  errorPageUrl,
  httpsOnlyPageUrl,
  interstitialKindOf,
  lookalikePageTarget,
  lookalikePageUrl,
  safeBrowsingPageUrl,
  type CrashPageOptions
} from '../url'
import { INTERSTITIAL_MESSAGE_KEY } from '../interstitial'
import type { CertificateDetails } from '../types'
import {
  BLOCKED_BY_CLIENT_CODE,
  CRASH_ERROR_CODE,
  ERROR_PAGE_ATTRIBUTES_SCRIPT,
  ERROR_PAGE_RULES_START,
  certificateInterstitial,
  crashCodeName,
  describeNetError,
  errorPageAccentStyle,
  errorPageAttributesScript,
  errorPageContent,
  errorPageHtml,
  errorPageSearchAction,
  errorPageStyle,
  inPlaceErrorPageScript,
  parseZenUrl,
  searchTermOf,
  suggestionsFor,
  zenPageHtml,
  type ErrorPageContent
} from '../zenPages'

/** The Reload control's label span: the button carries the busy spinner beside it (ERR-06). */
const RELOAD_LABEL = '<span class="zen-interstitial-label">Reload</span>'

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
      suggestions: [
        'Checking the connection',
        'Checking the proxy, firewall and DNS configuration'
      ],
      hint: null,
      search: null,
      code: 'ERR_NAME_NOT_RESOLVED',
      target: 'http://nonexistent.invalid/',
      showTabs: false,
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

  it('tells the user the device is offline, with the checks Chrome lists for the host', () => {
    const content = errorPageContent(-106, 'net::ERR_INTERNET_DISCONNECTED', 'https://example.com/')
    expect(content.title).toBe('No internet')
    expect(content.reason).toBe('Your device is offline.')
    expect(content.code).toBe('ERR_INTERNET_DISCONNECTED')
    // Desktop: Chrome's cables and Wi-Fi lines; Android: the phone's three (`suggestionsFor`).
    expect(content.suggestions).toEqual([
      'Checking the network cables, modem and router',
      'Reconnecting to Wi-Fi'
    ])
    expect(
      errorPageContent(
        -106,
        'net::ERR_INTERNET_DISCONNECTED',
        'https://example.com/',
        null,
        {},
        {
          host: 'android'
        }
      ).suggestions
    ).toEqual([
      // §10.5: British on every surface ("aeroplane", Android's own en-GB setting), and no
      // serial comma anywhere in the list.
      'Turning off aeroplane mode',
      'Turning on mobile data or Wi-Fi',
      'Checking the signal in your area'
    ])
  })

  describe("Chrome's suggestion list and search action (ERR-05)", () => {
    const ENGINE = { engine: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }
    const content = (
      code: number,
      name: string,
      target: string,
      host: 'android' | 'desktop' = 'desktop'
    ): ErrorPageContent => errorPageContent(code, `net::${name}`, target, null, {}, { host })

    it("lists Chrome 152's lines per code on the desktop: the connection, then the proxy / firewall / DNS combination", () => {
      // `net_error_options[]` → `GetSuggestionsSummaryList`, the desktop branch.
      const desktop = (code: number, name: string): string[] =>
        content(code, name, 'http://site.example/').suggestions
      expect(desktop(-105, 'ERR_NAME_NOT_RESOLVED')).toEqual([
        'Checking the connection',
        'Checking the proxy, firewall and DNS configuration'
      ])
      for (const [code, name] of [
        [-102, 'ERR_CONNECTION_REFUSED'],
        [-7, 'ERR_TIMED_OUT'],
        [-118, 'ERR_CONNECTION_TIMED_OUT'],
        [-101, 'ERR_CONNECTION_RESET'],
        [-100, 'ERR_CONNECTION_CLOSED']
      ] as Array<[number, string]>) {
        expect(desktop(code, name), name).toEqual([
          'Checking the connection',
          'Checking the proxy and the firewall'
        ])
      }
      expect(desktop(-138, 'ERR_NETWORK_ACCESS_DENIED')).toEqual([
        'Checking the connection',
        'Checking firewall and antivirus configurations'
      ])
      // Codes Chrome lists nothing for (or only the diagnostics tool Zenium has no counterpart
      // for). -21 is `SUGGEST_NONE` in `net_error_options[]`: the network changed under the
      // request, nothing to check, Reload alone.
      for (const [code, name] of [
        [-21, 'ERR_NETWORK_CHANGED'],
        [-109, 'ERR_ADDRESS_UNREACHABLE'],
        [-324, 'ERR_EMPTY_RESPONSE'],
        [-107, 'ERR_SSL_PROTOCOL_ERROR'],
        [-113, 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH'],
        [-312, 'ERR_UNSAFE_PORT'],
        [-300, 'ERR_INVALID_URL'],
        [-6, 'ERR_FILE_NOT_FOUND'],
        [-2, 'ERR_FAILED']
      ] as Array<[number, string]>) {
        expect(desktop(code, name), name).toEqual([])
      }
    })

    it("lists Chrome Android's lines on the Android host: the connection alone for a connection failure", () => {
      // The proxy / firewall / DNS summaries sit behind `!IS_ANDROID && !IS_IOS` in Chrome.
      for (const [code, name] of [
        [-105, 'ERR_NAME_NOT_RESOLVED'],
        [-102, 'ERR_CONNECTION_REFUSED'],
        [-118, 'ERR_CONNECTION_TIMED_OUT'],
        [-101, 'ERR_CONNECTION_RESET'],
        [-138, 'ERR_NETWORK_ACCESS_DENIED']
      ] as Array<[number, string]>) {
        expect(content(code, name, 'http://site.example/', 'android').suggestions, name).toEqual([
          'Checking the connection'
        ])
      }
      expect(
        content(-324, 'ERR_EMPTY_RESPONSE', 'http://site.example/', 'android').suggestions
      ).toEqual([])
      // -21 lists nothing on either host (`SUGGEST_NONE`).
      expect(
        content(-21, 'ERR_NETWORK_CHANGED', 'http://site.example/', 'android').suggestions
      ).toEqual([])
      expect(suggestionsFor(-21, 'android')).toEqual([])
      expect(suggestionsFor(-105, 'android')).toEqual(['Checking the connection'])
      expect(suggestionsFor(-999, 'android')).toEqual([])
    })

    it("words each code as Chrome 152 does, distinct per code, and Chromium's numbers for -21 and -138", () => {
      const reason = (code: number, name: string): string =>
        content(code, name, 'http://site.example/').reason
      expect(reason(-105, 'ERR_NAME_NOT_RESOLVED')).toBe(
        "site.example's server IP address could not be found."
      )
      expect(reason(-102, 'ERR_CONNECTION_REFUSED')).toBe('site.example refused to connect.')
      expect(reason(-118, 'ERR_CONNECTION_TIMED_OUT')).toBe(
        'site.example took too long to respond.'
      )
      expect(reason(-7, 'ERR_TIMED_OUT')).toBe('site.example took too long to respond.')
      expect(reason(-101, 'ERR_CONNECTION_RESET')).toBe('The connection was reset.')
      expect(reason(-100, 'ERR_CONNECTION_CLOSED')).toBe(
        'site.example unexpectedly closed the connection.'
      )
      expect(reason(-109, 'ERR_ADDRESS_UNREACHABLE')).toBe('site.example is unreachable.')
      // -21: Chrome's `IDS_ERRORPAGES_HEADING_CONNECTION_INTERRUPTED` over the network-changed
      // summary – the connection, not the site, is what failed.
      const changed = content(-21, 'ERR_NETWORK_CHANGED', 'http://site.example/')
      expect(changed.title).toBe('Your connection was interrupted')
      expect(changed.reason).toBe('A network change was detected.')
      expect(changed.code).toBe('ERR_NETWORK_CHANGED')
      const denied = content(-138, 'ERR_NETWORK_ACCESS_DENIED', 'http://site.example/')
      // Chrome's casing: "Your Internet access is blocked" (its offline heading has "No internet").
      expect(denied.title).toBe('Your Internet access is blocked')
      expect(denied.reason).toBe('Firewall or antivirus software may have blocked the connection.')
      expect(denied.code).toBe('ERR_NETWORK_ACCESS_DENIED')
      // The redirect loop carries Chrome's standalone sentence, not a list.
      const loop = content(-310, 'ERR_TOO_MANY_REDIRECTS', 'http://site.example/')
      expect(loop.hint).toBe('Try deleting your cookies.')
      expect(loop.suggestions).toEqual([])
      expect(content(-105, 'ERR_NAME_NOT_RESOLVED', 'http://site.example/').hint).toBeNull()
    })

    it('reads a failed host as a search term only when it is one typed word', () => {
      expect(searchTermOf('zeniumm')).toBe('zeniumm')
      expect(searchTermOf('zenium-browser')).toBe('zenium-browser')
      expect(searchTermOf('xn--mnchen-3ya')).toBe('münchen')
      expect(searchTermOf('nonexistent.invalid')).toBeNull()
      expect(searchTermOf('localhost')).toBeNull()
      expect(searchTermOf('10.0.0.1')).toBeNull()
      expect(searchTermOf('[::1]')).toBeNull()
      expect(searchTermOf('')).toBeNull()
    })

    it('offers Search <engine> for <term> through the engine the core handed over, for a DNS failure of a typed word only', () => {
      const word = errorPageContent(
        -105,
        'net::ERR_NAME_NOT_RESOLVED',
        'http://zeniumm/',
        null,
        {},
        {
          host: 'android',
          search: ENGINE
        }
      )
      expect(word.search).toEqual({
        label: 'Search DuckDuckGo for zeniumm',
        url: 'https://duckduckgo.com/?q=zeniumm'
      })
      // The engine is whichever the profile chose: nothing here names one.
      expect(
        errorPageContent(
          -105,
          'net::ERR_NAME_NOT_RESOLVED',
          'http://zeniumm/',
          null,
          {},
          {
            search: { engine: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' }
          }
        ).search
      ).toEqual({
        label: 'Search Ecosia for zeniumm',
        url: 'https://www.ecosia.org/search?q=zeniumm'
      })
      // A domain, another failure, or no engine: no action.
      expect(
        errorPageContent(
          -105,
          'net::ERR_NAME_NOT_RESOLVED',
          'http://nonexistent.invalid/',
          null,
          {},
          {
            search: ENGINE
          }
        ).search
      ).toBeNull()
      expect(
        errorPageContent(
          -102,
          'net::ERR_CONNECTION_REFUSED',
          'http://zeniumm/',
          null,
          {},
          {
            search: ENGINE
          }
        ).search
      ).toBeNull()
      expect(
        errorPageContent(-105, 'net::ERR_NAME_NOT_RESOLVED', 'http://zeniumm/').search
      ).toBeNull()
      // The term is encoded into the template, whatever it carries.
      expect(errorPageSearchAction(-105, 'caf\u00e9', ENGINE)?.url).toBe(
        'https://duckduckgo.com/?q=caf%C3%A9'
      )
    })

    it('carries the engine in the page URL, the way the accent travels, and reads only a usable one back', () => {
      const url = errorPageUrl(
        -105,
        'net::ERR_NAME_NOT_RESOLVED',
        'http://zeniumm/',
        null,
        undefined,
        ENGINE
      )
      const params = parseZenUrl(url)!.searchParams
      expect(params.get('engine')).toBe('DuckDuckGo')
      expect(params.get('search')).toBe('https://duckduckgo.com/?q=%s')
      expect(errorPageSearchOf(params)).toEqual(ENGINE)
      expect(errorPageSearchOf(new URLSearchParams(DNS.split('?')[1]))).toBeNull()
      expect(
        errorPageSearchOf(new URLSearchParams({ engine: 'X', search: 'javascript:1%s' }))
      ).toBeNull()
      expect(
        errorPageSearchOf(new URLSearchParams({ engine: 'X', search: 'https://x.example/' }))
      ).toBeNull()
      expect(
        errorPageSearchOf(new URLSearchParams({ engine: ' ', search: 'https://x.example/?q=%s' }))
      ).toBeNull()
    })
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

  it("renders a crashed renderer as the sad tab, Chrome's code line under Zenium's words", () => {
    const content = errorPageContent(CRASH_ERROR_CODE, 'RESULT_CODE_KILLED', 'https://a.example/')
    expect(content.title).toBe('This page crashed')
    expect(content.reason).toBe(
      'Something went wrong while displaying this page. Reload to try again.'
    )
    expect(content.code).toBe('Error code: RESULT_CODE_KILLED')
    expect(content.target).toBe('https://a.example/')
    expect(content.interstitial).toBeNull()
    // A host that sent no code leaves the line out rather than writing "Error code: ".
    expect(errorPageContent(CRASH_ERROR_CODE, '', 'https://a.example/').code).toBe('')
  })

  it('lays the crash page out with the shared vocabulary: title, reason, code line, Reload', () => {
    const url = parseZenUrl(
      errorPageUrl(CRASH_ERROR_CODE, 'SIGSEGV', 'https://crashed.example/page')
    )!
    const html = errorPageHtml(url)
    expect(html).toContain('<html class="zen-error-document">')
    expect(html).toContain('<h1>This page crashed</h1>')
    expect(html).toContain('<p class="zen-error-code">Error code: SIGSEGV</p>')
    expect(html).toContain(RELOAD_LABEL)
    expect(html).toContain('location.replace(&quot;https://crashed.example/page&quot;)')
    expect(html).not.toContain('Aw, Snap')
    // A first crash offers Reload alone: no action row, no way to the tab switcher.
    expect(html).not.toContain('<div class="zen-error-actions">')
    expect(html).not.toContain('Show tabs')
  })

  it('words the crash page per the way the renderer went (ERR-15): a crash, a memory kill, a page the user ended', () => {
    const at = (options: CrashPageOptions): ErrorPageContent =>
      errorPageContent(CRASH_ERROR_CODE, 'Out of Memory', 'https://a.example/', null, options)
    expect(at({ variant: 'crash' }).title).toBe('This page crashed')
    const memory = at({ variant: 'memory' })
    expect(memory.title).toBe('This page was closed to free up memory')
    expect(memory.reason).toBe(
      'Android needed the memory this page was using. Reload to open it again.'
    )
    expect(memory.showTabs).toBe(false)
    const hung = at({ variant: 'hung' })
    expect(hung.title).toBe('This page crashed')
    expect(hung.reason).toBe('The page stopped responding and was closed. Reload to try again.')
    // The code line stays Chrome's name for the end, whatever the words above it.
    expect(hung.code).toBe('Error code: Out of Memory')
  })

  it('suggests closing other tabs, with the way to them, when the same page went twice within the minute', () => {
    const again = errorPageContent(CRASH_ERROR_CODE, 'SIGSEGV', 'https://a.example/', null, {
      variant: 'crash',
      repeat: true
    })
    expect(again.title).toBe('This page crashed again')
    expect(again.reason).toBe(
      'Something went wrong while displaying this page, again. Closing other tabs can free up memory.'
    )
    expect(again.showTabs).toBe(true)
    const memory = errorPageContent(CRASH_ERROR_CODE, 'Out of Memory', 'https://a.example/', null, {
      variant: 'memory',
      repeat: true
    })
    // "closed to free up memory again" would read as a second closing of one page: the title holds.
    expect(memory.title).toBe('This page was closed to free up memory')
    expect(memory.reason).toMatch(/again\. Closing other tabs/)
    expect(memory.showTabs).toBe(true)
  })

  it('lays the repeat crash page out as an action row: Show tabs before the primary Reload', () => {
    const url = parseZenUrl(
      crashPageUrl('SIGSEGV', 'https://crashed.example/page', { variant: 'crash', repeat: true })
    )!
    const html = errorPageHtml(url)
    expect(html).toContain('<h1>This page crashed again</h1>')
    const row = html.indexOf('<div class="zen-error-actions">')
    const showTabs = html.indexOf('class="zen-v2-button zen-error-show-tabs"')
    const reload = html.indexOf('id="zen-error-reload"')
    expect(row).toBeGreaterThan(-1)
    expect(showTabs).toBeGreaterThan(row)
    expect(reload).toBeGreaterThan(showTabs)
    // Reload is the row's primary; Show tabs posts the interstitial action to the core.
    expect(html).toContain('zen-interstitial-action" data-primary onclick="zenReloading();')
    expect(html).toContain(`postMessage({${INTERSTITIAL_MESSAGE_KEY}`)
    expect(html).toContain('&quot;show-tabs&quot;')
  })

  it("carries the page's own Reloading state: Reload turns busy on press and when the core reloads it", () => {
    const html = errorPageHtml(parseZenUrl(DNS)!)
    expect(html).toContain('<script>function zenReloading(){')
    expect(html).toContain('onclick="zenReloading();location.replace(')
    expect(html).toContain('<span class="zen-interstitial-spinner">')
    // The core's call (`ERROR_PAGE_RELOADING_SCRIPT`) finds the function under this name.
    expect(html).toContain('function zenReloading()')
  })

  describe("Chrome's suggestions and the search action (ERR-05)", () => {
    const WORD = errorPageUrl(
      -105,
      'net::ERR_NAME_NOT_RESOLVED',
      'http://zeniumm/',
      null,
      undefined,
      {
        engine: 'DuckDuckGo',
        template: 'https://duckduckgo.com/?q=%s'
      }
    )

    it('lists the suggestions under Try: between the reason and the code line, per host', () => {
      const desktop = errorPageHtml(parseZenUrl(DNS)!)
      expect(desktop).toContain(
        '<div class="zen-error-suggestions">\n    <p>Try:</p>\n    <ul>\n      <li>Checking the connection</li>\n      <li>Checking the proxy, firewall and DNS configuration</li>\n    </ul>\n  </div>'
      )
      const reason = desktop.indexOf('server IP address could not be found.</p>')
      const list = desktop.indexOf('<div class="zen-error-suggestions">')
      const code = desktop.indexOf('<p class="zen-error-code">')
      expect(reason).toBeLessThan(list)
      expect(list).toBeLessThan(code)
      const android = errorPageHtml(parseZenUrl(DNS)!, 'system', 'android')
      expect(android).toContain('<ul>\n      <li>Checking the connection</li>\n    </ul>')
      expect(android).not.toContain('DNS configuration')
      // The Android host asks for its own list through `zenPageHtml`.
      expect(zenPageHtml(DNS, undefined, undefined, undefined, 'system', 'android')).toBe(android)
      expect(zenPageHtml(DNS)).toBe(desktop)
    })

    it('leaves the list out where Chrome lists nothing, and writes a standalone hint as a paragraph', () => {
      const empty = errorPageHtml(
        parseZenUrl(errorPageUrl(-324, 'net::ERR_EMPTY_RESPONSE', 'http://site.example/'))!
      )
      expect(empty).not.toContain('class="zen-error-suggestions"')
      expect(empty).not.toContain('Try:')
      const loop = errorPageHtml(
        parseZenUrl(errorPageUrl(-310, 'net::ERR_TOO_MANY_REDIRECTS', 'http://site.example/'))!
      )
      expect(loop).toContain('<p class="zen-error-hint">Try deleting your cookies.</p>')
      expect(loop).not.toContain('class="zen-error-suggestions"')
      // The certificate interstitial keeps its own structure: no list.
      expect(errorPageHtml(parseZenUrl(EXPIRED)!)).not.toContain('class="zen-error-suggestions"')
    })

    it('draws Search <engine> for <term> as the secondary before the primary Reload, a link to the results', () => {
      const html = errorPageHtml(parseZenUrl(WORD)!, 'system', 'android')
      const row = html.indexOf('<div class="zen-error-actions">')
      const search = html.indexOf(
        '<a id="zen-error-search" class="zen-v2-button zen-error-search" href="https://duckduckgo.com/?q=zeniumm">Search DuckDuckGo for zeniumm</a>'
      )
      const reload = html.indexOf('id="zen-error-reload"')
      expect(row).toBeGreaterThan(-1)
      expect(search).toBeGreaterThan(row)
      expect(reload).toBeGreaterThan(search)
      expect(html).toContain('zen-interstitial-action" data-primary onclick="zenReloading();')
      expect(html).not.toContain('class="zen-v2-button zen-error-show-tabs"')
      // Without a word to search for, Reload stands alone and is no primary, as before.
      const plain = errorPageHtml(parseZenUrl(DNS)!)
      expect(plain).not.toContain('id="zen-error-search"')
      expect(plain).not.toContain('<div class="zen-error-actions">')
      expect(plain).toContain(
        'class="zen-v2-button zen-interstitial-action" onclick="zenReloading();'
      )
    })

    it('escapes the engine and the results address like the rest of the page', () => {
      const url = errorPageUrl(
        -105,
        'net::ERR_NAME_NOT_RESOLVED',
        'http://zeniumm/',
        null,
        undefined,
        {
          engine: 'A<b>&"c"',
          template: 'https://x.example/?q=%s&a="1"'
        }
      )
      const html = errorPageHtml(parseZenUrl(url)!)
      expect(html).toContain('>Search A&lt;b&gt;&amp;&quot;c&quot; for zeniumm</a>')
      expect(html).toContain('href="https://x.example/?q=zeniumm&amp;a=&quot;1&quot;"')
      expect(html).not.toContain('<b>')
    })
  })
})

describe('crashCodeName', () => {
  it("names the ends a renderer is put to by Chromium's result codes", () => {
    // Windows / macOS: `forcefullyCrashRenderer` shuts the process down with RESULT_CODE_HUNG.
    expect(crashCodeName('killed', 2, 'win32')).toBe('RESULT_CODE_HUNG')
    expect(crashCodeName('killed', 1, 'win32')).toBe('RESULT_CODE_KILLED')
    expect(crashCodeName('killed', 3, 'win32')).toBe('RESULT_CODE_KILLED_BAD_MESSAGE')
    // A POSIX host kills with a signal: the status names it (Chrome's own line for it too).
    expect(crashCodeName('killed', 15, 'darwin')).toBe('SIGTERM')
    // POSIX: a process that exited reports its code in the second byte of the wait status.
    expect(crashCodeName('abnormal-exit', 2 << 8, 'linux')).toBe('RESULT_CODE_HUNG')
    expect(crashCodeName('abnormal-exit', 7 << 8, 'linux')).toBe('7')
  })

  it('names the signal a POSIX renderer died of, core-dump bit and platform numbering included', () => {
    expect(crashCodeName('crashed', 11, 'linux')).toBe('SIGSEGV')
    expect(crashCodeName('crashed', 11 | 0x80, 'linux')).toBe('SIGSEGV')
    expect(crashCodeName('crashed', 5, 'linux')).toBe('SIGTRAP')
    expect(crashCodeName('crashed', 4, 'darwin')).toBe('SIGILL')
    expect(crashCodeName('crashed', 7, 'linux')).toBe('SIGBUS')
    expect(crashCodeName('crashed', 10, 'darwin')).toBe('SIGBUS')
    expect(crashCodeName('crashed', 31, 'linux')).toBe('SIGSYS')
    expect(crashCodeName('killed', 9, 'linux')).toBe('SIGKILL')
    // A signal with no name of its own is Chrome's bare number.
    expect(crashCodeName('crashed', 27, 'linux')).toBe('27')
  })

  it('names the Windows exception status a renderer died of, or shows the number', () => {
    expect(crashCodeName('crashed', 0xc0000005 | 0, 'win32')).toBe('STATUS_ACCESS_VIOLATION')
    expect(crashCodeName('crashed', 0x80000003 | 0, 'win32')).toBe('STATUS_BREAKPOINT')
    expect(crashCodeName('crashed', 0xc00000fd | 0, 'win32')).toBe('STATUS_STACK_OVERFLOW')
    expect(crashCodeName('crashed', 5, 'win32')).toBe('5')
    // A kill whose code names nothing is still a kill.
    expect(crashCodeName('killed', 77, 'win32')).toBe('RESULT_CODE_KILLED')
  })

  it("spells the host's reason as the code where there is nothing else to go on", () => {
    expect(crashCodeName('oom', 11)).toBe('Out of Memory')
    expect(crashCodeName('memory-eviction')).toBe('Out of Memory')
    expect(crashCodeName('launch-failed', -3)).toBe('LAUNCH_FAILED')
    expect(crashCodeName('integrity-failure', 1)).toBe('INTEGRITY_FAILURE')
    expect(crashCodeName('crashed')).toBe('CRASHED')
    expect(crashCodeName('abnormal-exit', null)).toBe('ABNORMAL_EXIT')
    expect(crashCodeName('killed', Number.NaN)).toBe('KILLED')
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
      `<button type="button" id="zen-error-reload" class="zen-v2-button zen-interstitial-action" onclick="zenReloading();location.replace(&quot;http://nonexistent.invalid/&quot;)">${RELOAD_LABEL}`
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
    expect(html).toContain('<body class="zen-error-page" data-surface="page">')
    expect(html).toContain('<p class="zen-error-code">ERR_CONNECTION_REFUSED</p>')
    expect(html).toContain(
      '<button type="button" id="zen-error-reload" class="zen-v2-button zen-interstitial-action" onclick='
    )
    const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
    expect(style).toBe(`${errorPageStyle()}\n${errorPageAccentStyle(null)}`)
  })

  describe("the theme's accent beside the token block (§9.11)", () => {
    it("sets the window's --zen-accent on the root per scheme, so --v2-accent resolves as in the window", () => {
      const style = errorPageAccentStyle({ light: '#6264dc', dark: '#8284f0' })
      expect(style).toBe(
        ':root {\n  --zen-accent: #6264dc;\n  --zen-accent-rgb: 98 100 220;\n}\n' +
          ":root[data-theme='dark'] {\n  --zen-accent: #8284f0;\n  --zen-accent-rgb: 130 132 240;\n}"
      )
      // The token block derives the primary's fill from it; the page cuts that block in whole.
      expect(errorPageStyle()).toContain(
        '--v2-accent: color-mix(in srgb, var(--zen-accent) 40%, #000);'
      )
      expect(errorPageStyle()).toContain(
        '--v2-accent: color-mix(in srgb, var(--zen-accent) 40%, #fff);'
      )
    })

    it("reads the accent the core wrote into the page's URL, the theme's own", () => {
      const themed = errorPageUrl(-1, 'CRASHED', 'https://a.example/', null, {
        light: '#606eeb',
        dark: '#606eeb'
      })
      const html = errorPageHtml(parseZenUrl(themed)!)
      expect(html).toContain(
        ':root {\n  --zen-accent: #606eeb;\n  --zen-accent-rgb: 96 110 235;\n}'
      )
      expect(html).toContain(":root[data-theme='dark'] {\n  --zen-accent: #606eeb;")
      expect(html).not.toContain('--zen-accent: #6264dc')
    })

    it("falls back to the default theme's accent for a URL without one, never the unresolved variable", () => {
      const html = errorPageHtml(parseZenUrl(REFUSED)!)
      expect(html).toContain(
        ':root {\n  --zen-accent: #6264dc;\n  --zen-accent-rgb: 98 100 220;\n}'
      )
      expect(html).toContain(
        ":root[data-theme='dark'] {\n  --zen-accent: #8284f0;\n  --zen-accent-rgb: 130 132 240;\n}"
      )
      // A value that is not a colour is no accent.
      const bad = errorPageHtml(parseZenUrl(`${REFUSED}&accent=red&accentDark=8284f0`)!)
      expect(bad).toContain('--zen-accent: #6264dc;')
    })

    it('reaches the warning pages too, whose Back to safety is the primary', () => {
      const url = safeBrowsingPageUrl('https://bad.example/', 'malware', {
        light: '#4caf50',
        dark: '#4caf50'
      })
      const html = errorPageHtml(parseZenUrl(url)!)
      expect(html).toContain('--zen-accent: #4caf50;')
      expect(html).toContain('data-primary')
    })
  })

  it('renders the certificate interstitial: Advanced then Back to safety last in the action row, the details and Proceed hidden', () => {
    const html = errorPageHtml(parseZenUrl(EXPIRED)!)
    expect(html).toContain('<title>expired.badssl.com</title>')
    expect(html).toContain('<h1>Your connection is not private</h1>')
    expect(html).toContain('<p class="zen-error-code">ERR_CERT_DATE_INVALID</p>')
    expect(html).not.toContain(RELOAD_LABEL)
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
        expect(html).toContain('<body class="zen-error-page" data-surface="page">')
        expect(html).toContain('<script>' + ERROR_PAGE_ATTRIBUTES_SCRIPT + '</script>')
        expect(html).toContain(
          '<style>' + errorPageStyle() + '\n' + errorPageAccentStyle(null) + '</style>'
        )
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

  describe('the lookalike question (PS-18)', () => {
    const url = lookalikePageUrl('https://gogle.com/login', 'google.com', 'edit-distance', 'top')
    const page = errorPageHtml(parseZenUrl(url)!)
    const render = (lookalike: string, target: string, reason: string, source: string): string =>
      errorPageHtml(parseZenUrl(lookalikePageUrl(lookalike, target, reason, source))!)
    const PUNYCODE = (host: string): string =>
      `<span class="zen-interstitial-punycode">(${host})</span>`

    it('is one of the interstitial family, in warn ink, carrying its URL words', () => {
      expect(interstitialKindOf(url)).toBe('lookalike')
      expect(lookalikePageTarget(url)).toBe('google.com')
      expect(
        lookalikePageTarget(safeBrowsingPageUrl('https://evil.example/', 'malware'))
      ).toBeNull()
      const parsed = new URL(url)
      expect(parsed.searchParams.get('code')).toBe(String(BLOCKED_BY_CLIENT_CODE))
      expect(parsed.searchParams.get('url')).toBe('https://gogle.com/login')
      expect(parsed.searchParams.get('source')).toBe('top')
      expect(page).toContain('<html class="zen-error-document">')
      expect(page).toContain(
        '<main data-interstitial="lookalike" data-reason="edit-distance" data-source="top" data-target="google.com">'
      )
      expect(page).toContain('data-tone="warn"')
      expect(page).toContain('<title>Did you mean google.com?</title>')
      expect(page).toContain('<h1>Did you mean google.com?</h1>')
      expect(page).toContain(
        'The address <strong>gogle.com</strong> looks like <strong>google.com</strong>. Sites imitating well-known names are a common way to steal passwords.'
      )
    })

    it('offers Go to <target> as the one primary, Continue to <lookalike> beside it; no Back row: Details holds the reason and the address', () => {
      expect(page.match(/<button[^>]* data-primary/g)).toHaveLength(1)
      expect(page).toContain(
        'class="zen-v2-button zen-interstitial-action" data-primary autofocus data-action="suggested"><span class="zen-interstitial-label">Go to google.com</span>'
      )
      expect(page).toContain(
        'class="zen-v2-button zen-interstitial-action" data-action="proceed"><span class="zen-interstitial-label">Continue to gogle.com</span>'
      )
      // The order of the row: Details, the way on, the primary trailing.
      expect(page.indexOf('>Details</button>')).toBeLessThan(page.indexOf('data-action="proceed"'))
      expect(page.indexOf('data-action="proceed"')).toBeLessThan(
        page.indexOf('data-action="suggested"')
      )
      // Under Details: the reason, then the address, and no row of actions – the browser's own
      // back is the way back (the family's `back` message stays for the phone's key and the bar).
      expect(page).not.toContain('data-action="back"')
      expect(page.match(/class="zen-interstitial-actions"/g)).toHaveLength(1)
      const details = page.slice(
        page.indexOf('<section id="zen-details"'),
        page.indexOf('</section>')
      )
      expect(details).toContain('<p><strong>gogle.com</strong> is one character off')
      expect(details.indexOf('is one character off')).toBeLessThan(
        details.indexOf('zen-interstitial-address">https://gogle.com/login</p>')
      )
      expect(details).not.toContain('<button')
      // Nothing here is a danger control: the way on is a question, not a Safe Browsing bypass.
      expect(page).not.toMatch(/<button[^>]*zen-interstitial-danger/)
      expect(page.match(/class="zen-interstitial-spinner"/g)).toHaveLength(2)
      expect(page).toContain(
        `window.postMessage({${INTERSTITIAL_MESSAGE_KEY}:{action:b.dataset.action,url:"https://gogle.com/login"}},"*")`
      )
    })

    it('names the test that matched under Details, in each of its three wordings, and the address it will not ask about again', () => {
      expect(page).toContain(
        '<p><strong>gogle.com</strong> is one character off <strong>google.com</strong>, a site many people visit. If you meant to open gogle.com, Continue takes you there and Zenium will not ask about it again.</p>'
      )
      const embedding = render('https://paypal-login.com/', 'paypal.com', 'embedding', 'top')
      expect(embedding).toContain(
        '<p><strong>paypal-login.com</strong> contains the name of <strong>paypal.com</strong>, a site many people visit, but is not part of that site. If you meant to open paypal-login.com, Continue'
      )
      const skeleton = render('https://paypa1.com/', 'paypal.com', 'skeleton', 'top')
      expect(skeleton).toContain(
        '<p><strong>paypa1.com</strong> is spelled with characters that look like those of <strong>paypal.com</strong>, a site many people visit. If you meant to open paypa1.com, Continue'
      )
      expect(skeleton).toContain('<title>Did you mean paypal.com?</title>')
    })

    it("says whose site the target is: the top list's, or one the user visits", () => {
      expect(page).toContain('data-source="top"')
      expect(page).toContain(', a site many people visit.')
      const engaged = render(
        'https://mybamk.example/',
        'mybank.example',
        'edit-distance',
        'engaged'
      )
      expect(engaged).toContain('data-source="engaged"')
      expect(engaged).toContain(
        '<p><strong>mybamk.example</strong> is one character off <strong>mybank.example</strong>, a site you visit. If you meant to open mybamk.example, Continue'
      )
      expect(engaged).not.toContain('many people')
    })

    it('names an IDN address in the form the user saw, its punycode beside it in the deemphasised ink; an ASCII one once', () => {
      // аррӏе.com in Cyrillic: the lookalike the user saw, under the punycode the address bar keeps.
      const idn = render('https://xn--80ak6aa92e.com/login', 'apple.com', 'skeleton', 'top')
      const shown = '\u0430\u0440\u0440\u04cf\u0435.com'
      const both = `${shown} ${PUNYCODE('xn--80ak6aa92e.com')}`
      expect(idn).toContain('<h1>Did you mean apple.com?</h1>')
      expect(idn).toContain(
        `The address <strong>${shown}</strong> ${PUNYCODE('xn--80ak6aa92e.com')} looks like <strong>apple.com</strong>.`
      )
      expect(idn).toContain(
        `data-action="proceed"><span class="zen-interstitial-label">Continue to ${both}</span>`
      )
      expect(idn).toContain(
        `<p><strong>${shown}</strong> ${PUNYCODE('xn--80ak6aa92e.com')} is spelled with characters that look like those of <strong>apple.com</strong>, a site many people visit. If you meant to open ${both}, Continue`
      )
      expect(idn).toContain(
        `<p class="zen-interstitial-address">https://${shown}/login ${PUNYCODE('xn--80ak6aa92e.com')}</p>`
      )
      // The page's URL words and `data-target` keep the punycode: the machine-readable forms.
      expect(idn).toContain('data-target="apple.com"')
      expect(idn).toContain('url:"https://xn--80ak6aa92e.com/login"')
      // The rule the span reads is in the page's stylesheet: the family's deemphasised ink.
      expect(idn).toContain(
        '.zen-interstitial-punycode {\n  color: var(--v2-text-deemphasized);\n}'
      )

      // An IDN target: the title and the primary name it in both forms too.
      const target = render(
        'https://xn--mnchen-3ya.de.evil.example/',
        'xn--mnchen-3ya.de',
        'embedding',
        'engaged'
      )
      expect(target).toContain('<title>Did you mean m\u00fcnchen.de (xn--mnchen-3ya.de)?</title>')
      expect(target).toContain(
        `<h1>Did you mean m\u00fcnchen.de ${PUNYCODE('xn--mnchen-3ya.de')}?</h1>`
      )
      expect(target).toContain(
        `data-action="suggested"><span class="zen-interstitial-label">Go to m\u00fcnchen.de ${PUNYCODE('xn--mnchen-3ya.de')}</span>`
      )
      expect(target).toContain('data-target="xn--mnchen-3ya.de"')

      // An ASCII address is named once, and no span is rendered.
      expect(page).not.toContain('zen-interstitial-punycode"')
      expect(page).toContain('<p class="zen-interstitial-address">https://gogle.com/login</p>')
    })

    it('escapes the target and the address, and falls back for a reason or a source it does not know', () => {
      const hostile = errorPageHtml(
        parseZenUrl(
          lookalikePageUrl(
            'https://gogle.com/',
            '<img src=x onerror=alert(1)>',
            'edit-distance',
            'top'
          )
        )!
      )
      expect(hostile).not.toContain('<img')
      expect(hostile).toContain('&lt;img')
      const odd = render('https://gogle.com/', 'google.com', 'made-up', 'made-up')
      expect(odd).toContain('data-reason="edit-distance"')
      expect(odd).toContain('data-source="top"')
      expect(odd).toContain('is one character off')
      expect(odd).toContain('a site many people visit')
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

  it("stacks the search pair when a label would wrap, Reload on top (§9.11's clause; ERR-05)", () => {
    // The fit is the rule: on the phone each of the pair takes its one-line label as its base
    // size and never less than a half-row, so the two share a line only while both labels fit
    // their halves (two halves and the 8 gap sum to the row – 5 off each half absorbs layout
    // rounding); a longer label breaks the line, and `wrap-reverse` lands the second line –
    // Reload, last in the document – on top, each grown to the full width at the control height.
    const pair = style.slice(style.indexOf('.zen-error-actions:has(> .zen-error-search) {'))
    expect(pair.slice(0, pair.indexOf('}'))).toContain('flex-wrap: wrap-reverse;')
    const items = style.slice(style.indexOf('.zen-error-actions:has(> .zen-error-search) > * {'))
    const itemRule = items.slice(0, items.indexOf('}'))
    expect(itemRule).toContain('height: auto;')
    expect(itemRule).toContain('min-height: var(--v2-control);')
    const phone = style.slice(
      style.indexOf(
        ":root[data-form-factor='phone'] .zen-error-actions:has(> .zen-error-search) > * {"
      )
    )
    const phoneRule = phone.slice(0, phone.indexOf('}'))
    expect(phoneRule).toContain('flex: 1 1 auto;')
    expect(phoneRule).toContain('width: max-content;')
    expect(phoneRule).toContain('min-width: calc(50% - 5px);')
    // The document order the rule relies on: the search action first, Reload last (the row reads
    // secondary then primary; the stack, by the reversed wrap, primary then secondary).
    const word = errorPageUrl(
      -105,
      'net::ERR_NAME_NOT_RESOLVED',
      'http://zeniumm/',
      null,
      undefined,
      {
        engine: 'DuckDuckGo',
        template: 'https://duckduckgo.com/?q=%s'
      }
    )
    const html = errorPageHtml(parseZenUrl(word)!, 'system', 'android')
    expect(html.indexOf('id="zen-error-search"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="zen-error-search"')).toBeLessThan(
      html.indexOf('id="zen-error-reload"')
    )
  })

  it('anchors the block at 30% of the page and right-aligns the warning pages’ action row', () => {
    // §9.17: the top edge at 30% (16 minimum), never centred, so Details grows downward; §9.11:
    // the page's action row hugs and right-aligns on desktop (the phone's buttons fill the row).
    const page = style.slice(
      style.indexOf('.zen-error-page {'),
      style.indexOf('.zen-error-page main {')
    )
    expect(page).toContain('padding: max(16px, 30vh) 24px 24px;')
    expect(page).not.toContain('justify-content')
    const actions = style.slice(style.indexOf('.zen-interstitial-actions {'))
    expect(actions.slice(0, actions.indexOf('}'))).toContain('justify-content: flex-end;')
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
    { dark = false, webViewSaysFine = false, script = ERROR_PAGE_ATTRIBUTES_SCRIPT } = {}
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
      script
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

  /**
   * The app's scheme, not the engine's: on Linux `nativeTheme.themeSource` never reaches a
   * renderer's `prefers-color-scheme`, so an explicit setting is written as the chrome writes
   * its own `data-theme`, whatever the media query says; System alone reads the query.
   */
  it('writes an explicit Light or Dark setting whatever the media query says, and reads the query for System only', () => {
    const desktop = { width: 1440, height: 900, coarse: false, hover: true }
    const dark = errorPageAttributesScript('dark')
    const light = errorPageAttributesScript('light')
    expect(attributes(desktop, { script: dark }).theme).toBe('dark')
    expect(attributes(desktop, { dark: true, script: dark }).theme).toBe('dark')
    expect(attributes(desktop, { script: light }).theme).toBeUndefined()
    expect(attributes(desktop, { dark: true, script: light }).theme).toBeUndefined()
    // The pointer and form factor are still read from the media the tab sees.
    expect(attributes(desktop, { script: dark })).toMatchObject({
      pointer: 'fine',
      formFactor: 'desktop'
    })
    expect(dark).not.toContain('prefers-color-scheme')
    expect(light).not.toContain('prefers-color-scheme')
    expect(errorPageAttributesScript('system')).toBe(ERROR_PAGE_ATTRIBUTES_SCRIPT)
    expect(errorPageAttributesScript()).toBe(ERROR_PAGE_ATTRIBUTES_SCRIPT)
    expect(ERROR_PAGE_ATTRIBUTES_SCRIPT).toContain("q('(prefers-color-scheme: dark)')")
  })

  it('reaches every zen:// document that paints the theme: the error page, the interstitials, the in-place script and the protocol’s entry', () => {
    const dark = `<script>${errorPageAttributesScript('dark')}</script>`
    const system = `<script>${ERROR_PAGE_ATTRIBUTES_SCRIPT}</script>`
    const pages = [
      errorPageHtml(parseZenUrl(REFUSED)!, 'dark'),
      errorPageHtml(parseZenUrl(EXPIRED)!, 'dark'),
      errorPageHtml(parseZenUrl(safeBrowsingPageUrl('https://bad.example/', 'malware'))!, 'dark'),
      errorPageHtml(parseZenUrl(httpsOnlyPageUrl('http://plain.example/', -102))!, 'dark'),
      zenPageHtml(REFUSED, undefined, undefined, undefined, 'dark')
    ]
    for (const html of pages) {
      expect(html).toContain(dark)
      expect(html).not.toContain(system)
    }
    // Without a scheme (Android's WebViews follow the setting already) the page reads the query.
    expect(errorPageHtml(parseZenUrl(REFUSED)!)).toContain(system)
    expect(zenPageHtml(REFUSED)).toContain(system)
    const inPlace = inPlaceErrorPageScript(parseZenUrl(EXPIRED)!, 'dark')
    expect(inPlace).toContain(`${errorPageAttributesScript('dark')};return true`)
    expect(inPlace).not.toContain('prefers-color-scheme')
    expect(
      inPlace.endsWith(`})(${JSON.stringify(errorPageHtml(parseZenUrl(EXPIRED)!, 'dark'))})`)
    ).toBe(true)
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
