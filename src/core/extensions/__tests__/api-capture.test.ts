import { describe, expect, it } from 'vitest'
import {
  CAPTURE_QUOTA_ERROR,
  CaptureQuota,
  captureDenial,
  coversAllUrls,
  normalizeCaptureOptions,
  type CaptureGrants
} from '../api/capture'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

function grants(overrides: Partial<CaptureGrants> = {}): CaptureGrants {
  return { allUrls: false, activeTab: false, fileAccess: false, extensionId: ID, ...overrides }
}

describe('normalizeCaptureOptions', () => {
  it('defaults to JPEG at quality 90', () => {
    expect(normalizeCaptureOptions(undefined)).toEqual({ format: 'jpeg', quality: 90 })
    expect(normalizeCaptureOptions(null)).toEqual({ format: 'jpeg', quality: 90 })
    expect(normalizeCaptureOptions({})).toEqual({ format: 'jpeg', quality: 90 })
  })

  it('takes the format and the quality', () => {
    expect(normalizeCaptureOptions({ format: 'png' })).toEqual({ format: 'png', quality: 90 })
    expect(normalizeCaptureOptions({ format: 'jpeg', quality: 0 })).toEqual({
      format: 'jpeg',
      quality: 0
    })
    expect(normalizeCaptureOptions({ quality: 100 })).toEqual({ format: 'jpeg', quality: 100 })
  })

  it("rejects what Chrome's binding rejects", () => {
    expect(() => normalizeCaptureOptions('png')).toThrow(/No matching signature/)
    expect(() => normalizeCaptureOptions({ format: 'webp' })).toThrow(
      /'format': Value must be one of jpeg, png/
    )
    expect(() => normalizeCaptureOptions({ quality: 50.5 })).toThrow(/expected integer/)
    expect(() => normalizeCaptureOptions({ quality: '50' })).toThrow(/expected integer/)
    expect(() => normalizeCaptureOptions({ quality: -1 })).toThrow(/at least 0/)
    expect(() => normalizeCaptureOptions({ quality: 101 })).toThrow(/not be greater than 100/)
  })
})

describe('captureDenial', () => {
  it('needs some host access at all', () => {
    expect(captureDenial('https://example.com/', grants())).toBe(
      "Either the '<all_urls>' or 'activeTab' permission is required."
    )
  })

  it('lets an activeTab grant capture whatever the tab shows', () => {
    const g = grants({ activeTab: true })
    expect(captureDenial('https://example.com/', g)).toBeNull()
    expect(captureDenial('zen://settings', g)).toBeNull()
    expect(
      captureDenial('chrome-extension://otherotherotherotherotherotherot/x.html', g)
    ).toBeNull()
    expect(captureDenial('file:///home/user/a.html', g)).toBeNull()
  })

  it('stops <all_urls> at the browser pages and other extensions', () => {
    const g = grants({ allUrls: true })
    expect(captureDenial('https://example.com/a?b#c', g)).toBeNull()
    expect(captureDenial('http://localhost:3000/', g)).toBeNull()
    expect(captureDenial('about:blank', g)).toBeNull()
    expect(captureDenial('zen://newtab', g)).toBe('Cannot access a zen:// URL')
    expect(captureDenial('chrome://settings/', g)).toBe('Cannot access a chrome:// URL')
    expect(captureDenial('devtools://devtools/bundled/x.html', g)).toBe(
      'Cannot access a devtools:// URL'
    )
    expect(captureDenial(`chrome-extension://${ID}/options.html`, g)).toBeNull()
    expect(captureDenial('chrome-extension://otherotherotherotherotherotherot/x.html', g)).toBe(
      'Cannot access a chrome-extension:// URL of different extension'
    )
  })

  it('needs file access for file: pages', () => {
    const url = 'file:///home/user/a.html'
    expect(captureDenial(url, grants({ allUrls: true }))).toBe(
      `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`
    )
    expect(captureDenial(url, grants({ allUrls: true, fileAccess: true }))).toBeNull()
  })

  it('allows an unparsable URL once host access exists (an empty page)', () => {
    expect(captureDenial('', grants({ allUrls: true }))).toBeNull()
  })
})

describe('coversAllUrls', () => {
  it('recognises the all-hosts spellings', () => {
    expect(coversAllUrls(['<all_urls>'])).toBe(true)
    expect(coversAllUrls(['*://*/*'])).toBe(true)
    expect(coversAllUrls(['http://*/*', 'https://*/*'])).toBe(true)
    expect(coversAllUrls([' <all_urls> '])).toBe(true)
  })

  it('is false for anything narrower', () => {
    expect(coversAllUrls([])).toBe(false)
    expect(coversAllUrls(['https://*/*'])).toBe(false)
    expect(coversAllUrls(['https://*.example.com/*', 'http://*/*'])).toBe(false)
  })
})

describe('CaptureQuota', () => {
  it('allows two calls per second per extension and refuses the third', () => {
    const quota = new CaptureQuota()
    expect(quota.take('a', 1000)).toBe(true)
    expect(quota.take('a', 1100)).toBe(true)
    expect(quota.take('a', 1200)).toBe(false)
    expect(quota.take('b', 1200)).toBe(true)
  })

  it('slides the window', () => {
    const quota = new CaptureQuota()
    expect(quota.take('a', 1000)).toBe(true)
    expect(quota.take('a', 1500)).toBe(true)
    expect(quota.take('a', 1999)).toBe(false)
    expect(quota.take('a', 2000)).toBe(true)
    expect(quota.take('a', 2400)).toBe(false)
    expect(quota.take('a', 2500)).toBe(true)
  })

  it('forgets an extension', () => {
    const quota = new CaptureQuota()
    quota.take('a', 1000)
    quota.take('a', 1000)
    quota.forget('a')
    expect(quota.take('a', 1000)).toBe(true)
  })

  it("names Chrome's quota error", () => {
    expect(CAPTURE_QUOTA_ERROR).toBe(
      'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'
    )
  })
})
