import { describe, expect, it } from 'vitest'
import {
  getPath,
  githubSearchQuery,
  githubSearchUrl,
  isLocalEndpoint,
  parseFeed,
  parseGithubSearch,
  parseRestItems
} from '../livefolders'

describe('github live folders', () => {
  it('builds Zen-style queries from a username', () => {
    expect(
      githubSearchQuery({ provider: 'github-pulls', source: 'octocat', includeDrafts: false })
    ).toBe('author:octocat is:open is:pr draft:false archived:false')
    expect(
      githubSearchQuery({ provider: 'github-issues', source: '@octocat', includeDrafts: true })
    ).toBe('involves:octocat is:open is:issue archived:false')
  })

  it('passes raw search queries through without clobbering qualifiers', () => {
    const q = githubSearchQuery({
      provider: 'github-pulls',
      source: 'repo:zen-browser/desktop is:closed',
      includeDrafts: true
    })
    expect(q).toBe('repo:zen-browser/desktop is:closed is:pr archived:false')
    expect(
      githubSearchUrl({
        provider: 'github-pulls',
        source: 'me',
        includeDrafts: true,
        maxItems: 500
      })
    ).toContain('per_page=100')
  })

  it('parses search results and drops drafts when asked', () => {
    const body = {
      items: [
        {
          id: 1,
          number: 7,
          title: 'Fix',
          html_url: 'https://github.com/o/r/pull/7',
          repository_url: 'https://api.github.com/repos/o/r',
          draft: true
        },
        {
          id: 2,
          number: 8,
          title: 'Feat',
          html_url: 'https://github.com/o/r/pull/8',
          repository_url: 'https://api.github.com/repos/o/r'
        }
      ]
    }
    expect(parseGithubSearch(body, false)).toEqual([
      { id: '2', title: 'Feat · o/r#8', url: 'https://github.com/o/r/pull/8' }
    ])
    expect(parseGithubSearch(body, true)).toHaveLength(2)
    expect(parseGithubSearch({}, true)).toEqual([])
  })
})

describe('feeds', () => {
  it('parses RSS 2.0 items', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Blog</title>
      <item><title>First &amp; foremost</title><link>https://blog.test/1</link><guid>post-1</guid></item>
      <item><title><![CDATA[Second <b>post</b>]]></title><link>https://blog.test/2</link></item>
      <item><title>No link</title></item>
    </channel></rss>`
    expect(parseFeed(xml)).toEqual([
      { id: 'post-1', title: 'First & foremost', url: 'https://blog.test/1' },
      { id: 'https://blog.test/2', title: 'Second post', url: 'https://blog.test/2' }
    ])
  })

  it('parses Atom entries preferring the alternate link', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Entry</title><id>urn:1</id><link rel="self" href="https://a.test/self"/><link rel="alternate" href="https://a.test/1"/></entry>
      <entry><title>Only self</title><id>urn:2</id><link rel="self" href="https://a.test/2"/></entry>
    </feed>`
    expect(parseFeed(xml)).toEqual([
      { id: 'urn:1', title: 'Entry', url: 'https://a.test/1' },
      { id: 'urn:2', title: 'Only self', url: 'https://a.test/2' }
    ])
  })
})

describe('rest live folders', () => {
  it('reads dot paths and maps items', () => {
    const body = {
      data: {
        posts: [
          { id: 1, headline: 'A', link: '/a' },
          { id: 2, headline: '', link: 'https://x.test/b' },
          { id: 3 }
        ]
      }
    }
    expect(getPath(body, 'data.posts.0.headline')).toBe('A')
    expect(getPath(body, '')).toBe(body)
    expect(
      parseRestItems(
        body,
        { items: 'data.posts', id: 'id', title: 'headline', url: 'link' },
        'https://api.example.com/x'
      )
    ).toEqual([
      { id: '1', title: 'A', url: 'https://api.example.com/a' },
      { id: '2', title: 'https://x.test/b', url: 'https://x.test/b' }
    ])
  })

  it('recognises localhost endpoints (strict schema)', () => {
    expect(isLocalEndpoint('http://localhost:3000/items')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1/items')).toBe(true)
    expect(isLocalEndpoint('https://example.com/items')).toBe(false)
  })
})
