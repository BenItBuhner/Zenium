import { describe, expect, it } from 'vitest'
import {
  READER_MUTE_CAP,
  ReaderMuteRecord,
  readerArticleTab,
  readerOfferEndEffect,
  readerOfferFor,
  readerSiteOf
} from '../readerEntry'

const article = (
  url = 'https://example.com/story'
): { url: string; readerable: boolean; discarded: boolean } => ({
  url,
  readerable: true,
  discarded: false
})

describe('readerSiteOf', () => {
  it("keys a page by its host, lower-cased, as Chrome's muted-sites set does", () => {
    expect(readerSiteOf('https://News.Example.com/a/b?c')).toBe('news.example.com')
    expect(readerSiteOf('http://example.com')).toBe('example.com')
  })
  it('has no site for a URL without a host', () => {
    expect(readerSiteOf('zen://reader?id=1&url=https%3A%2F%2Fexample.com')).toBe('reader')
    expect(readerSiteOf('not a url')).toBeNull()
    expect(readerSiteOf('about:blank')).toBeNull()
  })
})

describe('readerArticleTab', () => {
  it('is a web page the probe read as an article', () => {
    expect(readerArticleTab(article())).toBe(true)
    expect(readerArticleTab(article('http://example.com/x'))).toBe(true)
  })
  it('is never the reader page, a discarded tab, a page the probe refused, or no tab', () => {
    expect(readerArticleTab(null)).toBe(false)
    expect(readerArticleTab({ ...article(), readerable: false })).toBe(false)
    expect(readerArticleTab({ ...article(), discarded: true })).toBe(false)
    expect(readerArticleTab(article('zen://reader?id=a&url=https%3A%2F%2Fexample.com'))).toBe(false)
    expect(readerArticleTab(article('zen://newtab'))).toBe(false)
    expect(readerArticleTab(article('file:///tmp/a.html'))).toBe(false)
  })
})

describe('ReaderMuteRecord', () => {
  it('remembers a muted site for the session and forgets it on the action', () => {
    const muted = new ReaderMuteRecord()
    expect(muted.has('example.com')).toBe(false)
    muted.mute('example.com')
    expect(muted.has('example.com')).toBe(true)
    muted.unmute('example.com')
    expect(muted.has('example.com')).toBe(false)
  })
  it('ignores a page without a site', () => {
    const muted = new ReaderMuteRecord()
    muted.mute(null)
    muted.unmute(null)
    expect(muted.size).toBe(0)
    expect(muted.has(null)).toBe(false)
  })
  it("drops the oldest site past Chrome's cap of a hundred", () => {
    const muted = new ReaderMuteRecord()
    for (let i = 0; i < READER_MUTE_CAP + 5; i++) muted.mute(`site${i}.example`)
    expect(muted.size).toBe(READER_MUTE_CAP)
    expect(muted.has('site0.example')).toBe(false)
    expect(muted.has('site4.example')).toBe(false)
    expect(muted.has('site5.example')).toBe(true)
    expect(muted.has(`site${READER_MUTE_CAP + 4}.example`)).toBe(true)
  })
  it('muting a site again is a no-op on the order (a set, as Chrome keeps one)', () => {
    const muted = new ReaderMuteRecord(2)
    muted.mute('a.example')
    muted.mute('b.example')
    muted.mute('a.example')
    muted.mute('c.example')
    expect(muted.has('a.example')).toBe(false)
    expect(muted.has('b.example')).toBe(true)
    expect(muted.has('c.example')).toBe(true)
  })
})

describe('readerOfferFor', () => {
  it('offers Reader View for an article on a site the session has not muted', () => {
    expect(readerOfferFor(article(), new ReaderMuteRecord())).toEqual({ site: 'example.com' })
  })
  it('offers nothing on a muted site, however many pages of it load', () => {
    const muted = new ReaderMuteRecord()
    muted.mute('example.com')
    expect(readerOfferFor(article(), muted)).toBeNull()
    expect(readerOfferFor(article('https://example.com/another'), muted)).toBeNull()
    expect(readerOfferFor(article('https://other.example/story'), muted)).toEqual({
      site: 'other.example'
    })
  })
  it('offers nothing where there is no article', () => {
    const muted = new ReaderMuteRecord()
    expect(readerOfferFor(null, muted)).toBeNull()
    expect(readerOfferFor({ ...article(), readerable: false }, muted)).toBeNull()
    expect(readerOfferFor(article('zen://reader?id=a&url=x'), muted)).toBeNull()
  })
})

describe("readerOfferEndEffect (Chrome's onMessageDismissed)", () => {
  it('mutes on every end but the action: the swipe, the X, a clock, the page left', () => {
    expect(readerOfferEndEffect({ reason: 'swipe' })).toBe('mute')
    expect(readerOfferEndEffect({ reason: 'close' })).toBe('mute')
    expect(readerOfferEndEffect({ reason: 'timeout' })).toBe('mute')
    expect(readerOfferEndEffect({ reason: 'program', movedOn: true })).toBe('mute')
  })
  it('un-mutes on the action', () => {
    expect(readerOfferEndEffect({ reason: 'action' })).toBe('unmute')
  })
  it("changes nothing for the chrome's own ends: a gate over the page, a banner pushed off", () => {
    expect(readerOfferEndEffect({ reason: 'program', movedOn: false })).toBe('none')
    expect(readerOfferEndEffect({ reason: 'program' })).toBe('none')
    expect(readerOfferEndEffect({ reason: 'replaced' })).toBe('none')
  })
})
