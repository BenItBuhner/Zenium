import { describe, expect, it } from 'vitest'
import { SAFE_BROWSING_FEEDS, parseFeed, parseFeedLine, safeBrowsingFeed } from '../feeds'

describe('the feed table', () => {
  it('names distinct ids, https URLs, licences and a bundled subset', () => {
    const ids = SAFE_BROWSING_FEEDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const feed of SAFE_BROWSING_FEEDS) {
      expect(feed.url).toMatch(/^https:\/\//)
      expect(feed.homepage).toMatch(/^https:\/\//)
      expect(feed.licence).not.toBe('')
      expect(feed.maxAgeMs).toBeGreaterThan(0)
      expect(safeBrowsingFeed(feed.id)).toBe(feed)
    }
    expect(SAFE_BROWSING_FEEDS.some((f) => f.bundled)).toBe(true)
    expect(SAFE_BROWSING_FEEDS.find((f) => f.id === 'phishing-database')?.bundled).toBe(false)
    expect(safeBrowsingFeed('nope')).toBeUndefined()
  })
})

describe('parseFeedLine', () => {
  it('reads hosts-file lines and ignores comments, blanks and the loopback names', () => {
    expect(parseFeedLine('0.0.0.0 evil.example', 'hosts')).toBe('evil.example')
    expect(parseFeedLine('127.0.0.1\tPhish.Example.NET. # note', 'hosts')).toBe('phish.example.net')
    expect(parseFeedLine('::1 v6.example', 'hosts')).toBe('v6.example')
    expect(parseFeedLine('# comment', 'hosts')).toBeNull()
    expect(parseFeedLine('', 'hosts')).toBeNull()
    expect(parseFeedLine('0.0.0.0 localhost', 'hosts')).toBeNull()
    expect(parseFeedLine('127.0.0.1 localhost.localdomain', 'hosts')).toBeNull()
    expect(parseFeedLine('evil.example', 'hosts')).toBeNull()
    expect(parseFeedLine('example.com evil.example', 'hosts')).toBeNull()
  })

  it('reads domain lists and ABP host filters', () => {
    expect(parseFeedLine('Evil.Example', 'domains')).toBe('evil.example')
    expect(parseFeedLine('192.0.2.9', 'domains')).toBe('192.0.2.9')
    expect(parseFeedLine('two words', 'domains')).toBeNull()
    expect(parseFeedLine('! header', 'abp')).toBeNull()
    expect(parseFeedLine('[Adblock Plus 2.0]', 'abp')).toBeNull()
    expect(parseFeedLine('||evil.example^', 'abp')).toBe('evil.example')
    expect(parseFeedLine('||evil.example^$all', 'abp')).toBe('evil.example')
    expect(parseFeedLine('||evil.example/path^', 'abp')).toBeNull()
    expect(parseFeedLine('|http://evil.example', 'abp')).toBeNull()
  })

  it('rejects junk that is not a hostname', () => {
    expect(parseFeedLine('0.0.0.0 -bad.example', 'hosts')).toBeNull()
    expect(parseFeedLine('0.0.0.0 bad..example', 'hosts')).toBeNull()
    expect(parseFeedLine('0.0.0.0 nodots', 'hosts')).toBeNull()
    expect(parseFeedLine('0.0.0.0 http://x.example/', 'hosts')).toBeNull()
  })
})

describe('parseFeed', () => {
  it('collects distinct hosts in order of first appearance across line endings', () => {
    const text = [
      '# URLhaus hostfile',
      '0.0.0.0 a.example\r',
      '0.0.0.0 b.example',
      '',
      '0.0.0.0 A.EXAMPLE',
      '0.0.0.0 c.example # trailing'
    ].join('\n')
    expect(parseFeed(text, 'hosts')).toEqual(['a.example', 'b.example', 'c.example'])
    expect(parseFeed('', 'hosts')).toEqual([])
  })
})
