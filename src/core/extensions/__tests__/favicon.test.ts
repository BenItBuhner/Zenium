import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FAVICON_SIZE,
  allowImageSource,
  DEFAULT_FAVICON_SVG,
  MAX_FAVICON_SIZE,
  decodeDataUrl,
  faviconQuery,
  parseFaviconRequest
} from '../favicon'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('parseFaviconRequest', () => {
  it("reads Chrome's shape: pageUrl decoded, size an integer with 16 the default", () => {
    const page = 'https://example.com/a?b=1&c=2'
    expect(
      parseFaviconRequest(
        `chrome-extension://${ID}/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`
      )
    ).toEqual({ extensionId: ID, pageUrl: page, size: 32 })
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon/?pageUrl=https://a.test`)
    ).toEqual({
      extensionId: ID,
      pageUrl: 'https://a.test',
      size: DEFAULT_FAVICON_SIZE
    })
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon/?size=big&pageUrl=https://a.test`)
        ?.size
    ).toBe(DEFAULT_FAVICON_SIZE)
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon/?size=0&pageUrl=https://a.test`)?.size
    ).toBe(DEFAULT_FAVICON_SIZE)
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon/?size=9999&pageUrl=https://a.test`)
        ?.size
    ).toBe(MAX_FAVICON_SIZE)
    // `scaleFactor` is Chrome's; read and ignored.
    expect(
      parseFaviconRequest(
        `chrome-extension://${ID}/_favicon/?pageUrl=https://a.test&size=16&scaleFactor=2x`
      )
    ).toEqual({ extensionId: ID, pageUrl: 'https://a.test', size: 16 })
  })

  it('is exact about the path and the scheme, and needs a pageUrl', () => {
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon?pageUrl=https://a.test`)
    ).toBeUndefined()
    expect(
      parseFaviconRequest(`chrome-extension://${ID}/_favicon/icon.png?pageUrl=https://a.test`)
    ).toBeUndefined()
    expect(parseFaviconRequest(`chrome-extension://${ID}/_favicon/`)).toBeUndefined()
    expect(parseFaviconRequest(`chrome-extension://${ID}/_favicon/?pageUrl=`)).toBeUndefined()
    expect(parseFaviconRequest(`https://${ID}/_favicon/?pageUrl=https://a.test`)).toBeUndefined()
    expect(parseFaviconRequest('chrome-extension://not-an-id/_favicon/?pageUrl=x')).toBeUndefined()
    expect(parseFaviconRequest('not a url')).toBeUndefined()
  })

  it('carries the request on as a query', () => {
    const query = faviconQuery({ extensionId: ID, pageUrl: 'https://a.test/?x=1&y=2', size: 24 })
    expect(new URLSearchParams(query).get('pageUrl')).toBe('https://a.test/?x=1&y=2')
    expect(new URLSearchParams(query).get('size')).toBe('24')
  })
})

describe('decodeDataUrl', () => {
  it('decodes base64 and percent-encoded data URLs with their type', () => {
    const png = decodeDataUrl('data:image/png;base64,iVBORw0KGgo=')
    expect(png?.type).toBe('image/png')
    expect(Array.from(png?.body ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const svg = decodeDataUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E')
    expect(svg?.type).toBe('image/svg+xml')
    expect(new TextDecoder().decode(svg?.body)).toBe('<svg></svg>')
    expect(decodeDataUrl('data:,hi')?.type).toBe('text/plain')
  })

  it('gives nothing for a malformed or empty one', () => {
    expect(decodeDataUrl('data:image/png;base64,')).toBeUndefined()
    expect(decodeDataUrl('data:image/png;base64,%%%')).toBeUndefined()
    expect(decodeDataUrl('https://a.test/favicon.ico')).toBeUndefined()
  })
})

describe('allowImageSource', () => {
  const ORIGIN = `zen-extension://${ID}.0123456789abcdef0123456789abcdef`

  it('appends the origin to an img-src, once, and replaces a lone none', () => {
    // OneTab's policy, trailing semicolon included.
    expect(
      allowImageSource(
        "script-src 'self'; object-src 'self'; img-src 'self' data: https://t2.gstatic.com;",
        ORIGIN
      )
    ).toBe(
      `script-src 'self'; object-src 'self'; img-src 'self' data: https://t2.gstatic.com ${ORIGIN}`
    )
    // A wildcard matches web schemes only: the origin is still needed.
    expect(allowImageSource("default-src 'none'; img-src * data:; connect-src *", ORIGIN)).toBe(
      `default-src 'none'; img-src * data: ${ORIGIN}; connect-src *`
    )
    expect(allowImageSource(`img-src ${ORIGIN} data:`, ORIGIN)).toBe(`img-src ${ORIGIN} data:`)
    expect(allowImageSource("IMG-SRC 'none'", ORIGIN)).toBe(`IMG-SRC ${ORIGIN}`)
  })

  it('derives an img-src from default-src when only that restricts images', () => {
    expect(allowImageSource("default-src 'self'; frame-src 'self' https://a.test", ORIGIN)).toBe(
      `default-src 'self'; frame-src 'self' https://a.test; img-src 'self' ${ORIGIN}`
    )
    expect(allowImageSource("default-src 'none'; script-src 'self'", ORIGIN)).toBe(
      `default-src 'none'; script-src 'self'; img-src ${ORIGIN}`
    )
  })

  it('leaves a policy that does not restrict images alone', () => {
    const chromeDefault = "script-src 'self'; object-src 'self'"
    expect(allowImageSource(chromeDefault, ORIGIN)).toBe(chromeDefault)
    expect(allowImageSource('', ORIGIN)).toBe('')
  })
})

describe('DEFAULT_FAVICON_SVG', () => {
  it('is a small self-contained SVG', () => {
    expect(DEFAULT_FAVICON_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(DEFAULT_FAVICON_SVG.endsWith('</svg>')).toBe(true)
    expect(DEFAULT_FAVICON_SVG).not.toMatch(/href|url\(|<script/)
    expect(DEFAULT_FAVICON_SVG.length).toBeLessThan(400)
  })
})
