import { describe, expect, it } from 'vitest'
import { extensionUrlOrigin, installUrlOrigin, scopedUrlClass } from '../extensionUrlOrigin'

const ID = 'dmkamcknogkgcdfhhbddcghachkejeap'
const SERVED = `https://${ID}.ext.zenium.invalid`

/**
 * A realm's `URL` as Web IDL shapes it: `origin` and `href` own configurable accessors of the
 * prototype, `origin` opaque for a scheme the realm does not know (Node's parser, like the
 * WebView's, knows no `chrome-extension:`).
 */
function realm(): {
  URL: { prototype: object; new (href: string): { origin: string; href: string } }
} {
  class RealmURL {
    private readonly parsed: URL
    constructor(href: string) {
      this.parsed = new URL(href)
    }
    get href(): string {
      return this.parsed.href
    }
    get origin(): string {
      return this.parsed.origin
    }
  }
  return { URL: RealmURL }
}

describe('extensionUrlOrigin', () => {
  it("answers the served origin for Chrome's spelling of an extension URL, the native answer otherwise", () => {
    expect(new URL(`chrome-extension://${ID}/popup.html`).origin).toBe('null')
    expect(extensionUrlOrigin(`chrome-extension://${ID}/popup.html`, 'null')).toBe(SERVED)
    expect(extensionUrlOrigin(`chrome-extension://${ID.toUpperCase()}`, 'null')).toBe(SERVED)
    // The WebView's own answer, both jobs of compat round 9 (113 parses the URL as a path URL,
    // host empty; 156 finds the host): the bare scheme, no origin of anything.
    expect(extensionUrlOrigin(`chrome-extension://${ID}/popup.html`, 'chrome-extension://')).toBe(
      SERVED
    )
    // A parser that knew the scheme would answer as Chrome does; the served origin still, so
    // the compare with `location.origin` holds.
    expect(
      extensionUrlOrigin(`chrome-extension://${ID}/popup.html`, `chrome-extension://${ID}`)
    ).toBe(SERVED)
    // The served spelling is a real origin already; any other URL keeps what the parser said.
    expect(extensionUrlOrigin(`${SERVED}/popup.html`, SERVED)).toBe(SERVED)
    expect(extensionUrlOrigin('https://example.com/x', 'https://example.com')).toBe(
      'https://example.com'
    )
    expect(extensionUrlOrigin('blob:null/abc', 'null')).toBe('null')
    expect(extensionUrlOrigin('chrome-extension://not-an-id/x', 'null')).toBe('null')
    expect(extensionUrlOrigin('chrome-extension://not-an-id/x', 'chrome-extension://')).toBe(
      'chrome-extension://'
    )
    expect(extensionUrlOrigin('data:text/plain,x', 'null')).toBe('null')
  })

  it("answers the served origin through the patched accessor when the realm's parser says the bare scheme", () => {
    // A realm whose `URL` answers as the WebView does for Chrome's spelling.
    class WebViewURL {
      private readonly parsed: URL
      constructor(href: string) {
        this.parsed = new URL(href)
      }
      get href(): string {
        return this.parsed.href
      }
      get origin(): string {
        return this.parsed.protocol === 'chrome-extension:'
          ? 'chrome-extension://'
          : this.parsed.origin
      }
    }
    expect(new WebViewURL(`chrome-extension://${ID}/popup.html`).origin).toBe('chrome-extension://')
    expect(installUrlOrigin({ URL: WebViewURL })).toBe(true)
    expect(new WebViewURL(`chrome-extension://${ID}/popup.html`).origin).toBe(SERVED)
    expect(new WebViewURL('https://example.com/x').origin).toBe('https://example.com')
  })
})

describe('installUrlOrigin', () => {
  it("patches the realm's URL.prototype.origin once, the accessor's shape kept", () => {
    const r = realm()
    const before = Object.getOwnPropertyDescriptor(r.URL.prototype, 'origin')
    expect(installUrlOrigin(r)).toBe(true)
    const after = Object.getOwnPropertyDescriptor(r.URL.prototype, 'origin')
    expect(after?.configurable).toBe(before?.configurable)
    expect(after?.enumerable).toBe(before?.enumerable)
    expect(after?.set).toBe(before?.set)
    // Keplr's guard: `new URL(sender.url).origin` (sender.url spelled as Chrome's) against its
    // popup's `location.origin` (the served one).
    expect(new r.URL(`chrome-extension://${ID}/popup.html#/`).origin).toBe(SERVED)
    expect(new r.URL(`${SERVED}/popup.html`).origin).toBe(SERVED)
    expect(new r.URL('https://app.keplr.app/path').origin).toBe('https://app.keplr.app')
    expect(new r.URL('blob:null/abc').origin).toBe('null')
  })

  it('leaves a realm without URL, or one already patched by hand, alone', () => {
    expect(installUrlOrigin({})).toBe(false)
    const r = realm()
    Object.defineProperty(r.URL.prototype, 'origin', { value: 'fixed', configurable: false })
    expect(installUrlOrigin(r)).toBe(false)
    expect(new r.URL('https://example.com/').origin).toBe('fixed')
  })
})

describe('scopedUrlClass', () => {
  it("is the page's URL subclassed: instanceof holds, statics come through, origin is patched", () => {
    const Scoped = scopedUrlClass(URL)
    const url = new Scoped(`chrome-extension://${ID}/background.bundle.js`)
    expect(url).toBeInstanceOf(URL)
    expect(url.origin).toBe(SERVED)
    expect(url.pathname).toBe('/background.bundle.js')
    expect(url.href).toBe(`chrome-extension://${ID}/background.bundle.js`)
    expect(new Scoped('https://example.com/a?b').origin).toBe('https://example.com')
    expect(new Scoped('/rel', 'https://example.com/dir/').href).toBe('https://example.com/rel')
    expect(Scoped.canParse('https://example.com/')).toBe(true)
    expect(Scoped.name).toBe('URL')
    // The page's own URL is untouched.
    expect(new URL(`chrome-extension://${ID}/x`).origin).toBe('null')
  })
})
