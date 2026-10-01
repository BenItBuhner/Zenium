import { describe, expect, it } from 'vitest'
import {
  chooserTitleForText,
  chooserTitleForUrl,
  extractUrl,
  routeSharedIntent,
  sharedFields,
  shareTargetAccepts,
  shareTargetLaunch
} from '../shareTarget'
import type { WebAppShareTarget } from '../webApp'

describe('extractUrl', () => {
  it('finds the first URL inside shared text', () => {
    expect(extractUrl('Look at this https://example.com/a?b=1 and https://other.test')).toBe(
      'https://example.com/a?b=1'
    )
  })

  it('normalises a www host and drops the punctuation of the sentence around it', () => {
    expect(extractUrl('see www.example.com/path, then')).toBe('https://www.example.com/path')
    expect(extractUrl('(https://example.com/x).')).toBe('https://example.com/x')
    expect(extractUrl('https://en.wikipedia.org/wiki/Zen_(band)')).toBe(
      'https://en.wikipedia.org/wiki/Zen_(band)'
    )
  })

  it('has nothing for plain text or a bare domain', () => {
    expect(extractUrl('just words here')).toBeNull()
    expect(extractUrl('example.com is a domain')).toBeNull()
    expect(extractUrl('')).toBeNull()
  })
})

describe('routeSharedIntent', () => {
  it('opens the URL a share carries, even with a title around it', () => {
    expect(
      routeSharedIntent({ kind: 'send', text: 'Zen Browser https://zen-browser.app/ via Twitter' })
    ).toEqual({ kind: 'url', url: 'https://zen-browser.app/' })
    expect(routeSharedIntent({ kind: 'send', text: 'https://example.com' })).toEqual({
      kind: 'url',
      url: 'https://example.com/'
    })
  })

  it("searches plain text with the chosen engine (which engine is the core's business)", () => {
    expect(routeSharedIntent({ kind: 'send', text: 'how do springs work' })).toEqual({
      kind: 'search',
      query: 'how do springs work'
    })
  })

  it('falls back to the subject when the text is empty', () => {
    expect(routeSharedIntent({ kind: 'send', text: '', subject: 'Meeting notes' })).toEqual({
      kind: 'search',
      query: 'Meeting notes'
    })
    expect(
      routeSharedIntent({ kind: 'send', text: null, subject: 'https://example.com/notes' })
    ).toEqual({ kind: 'url', url: 'https://example.com/notes' })
  })

  it('routes a web search straight to the engine', () => {
    expect(routeSharedIntent({ kind: 'search', text: ' cats ' })).toEqual({
      kind: 'search',
      query: 'cats'
    })
    expect(routeSharedIntent({ kind: 'search', text: '' })).toEqual({ kind: 'none' })
  })

  it('shows a shared image as a page, and falls back to its text when it could not be read', () => {
    expect(
      routeSharedIntent({
        kind: 'send',
        mimeType: 'image/png',
        imageDataUrl: 'data:image/png;base64,AA=='
      })
    ).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AA==' })
    expect(routeSharedIntent({ kind: 'send', mimeType: 'image/jpeg' })).toEqual({ kind: 'none' })
    expect(
      routeSharedIntent({ kind: 'send', mimeType: 'image/jpeg', text: 'https://example.com/pic' })
    ).toEqual({ kind: 'url', url: 'https://example.com/pic' })
  })

  it('does nothing with an empty share', () => {
    expect(routeSharedIntent({ kind: 'send' })).toEqual({ kind: 'none' })
    expect(routeSharedIntent({ kind: 'send', text: '   ', mimeType: 'text/plain' })).toEqual({
      kind: 'none'
    })
  })
})

// ---------------------------------------------------------------------------
// Web Share Target (MW-63): what an installed app takes and how it is launched with it
// ---------------------------------------------------------------------------

function target(
  params: Partial<WebAppShareTarget['params']>,
  rest: Partial<Omit<WebAppShareTarget, 'params'>> = {}
): WebAppShareTarget {
  return {
    action: 'https://app.example/share?src=manifest&link=old',
    method: 'GET',
    enctype: 'application/x-www-form-urlencoded',
    ...rest,
    params: { title: null, text: null, url: null, files: [], ...params }
  }
}

describe('shareTargetAccepts', () => {
  it('offers a link to a target with a url field and text to one with a text or title field', () => {
    expect(shareTargetAccepts(target({ url: 'link' }), 'url')).toBe(true)
    expect(shareTargetAccepts(target({ text: 'body' }), 'url')).toBe(false)
    expect(shareTargetAccepts(target({ text: 'body' }), 'text')).toBe(true)
    expect(shareTargetAccepts(target({ title: 'subject' }), 'text')).toBe(true)
    expect(shareTargetAccepts(target({ url: 'link' }), 'text')).toBe(false)
  })

  it('takes nothing on a file field alone: no file share is served', () => {
    const files = target(
      { files: [{ name: 'pictures', accept: ['image/*'] }] },
      { method: 'POST', enctype: 'multipart/form-data' }
    )
    expect(shareTargetAccepts(files, 'url')).toBe(false)
    expect(shareTargetAccepts(files, 'text')).toBe(false)
  })
})

describe('sharedFields', () => {
  it('gives a link its subject as the title and the text as shared', () => {
    expect(
      sharedFields(
        { kind: 'send', text: 'Read this https://example.com/a', subject: 'An article' },
        { kind: 'url', url: 'https://example.com/a' }
      )
    ).toEqual({
      title: 'An article',
      text: 'Read this https://example.com/a',
      url: 'https://example.com/a'
    })
    expect(
      sharedFields(
        { kind: 'send', text: 'https://example.com/a' },
        { kind: 'url', url: 'https://example.com/a' }
      )
    ).toEqual({ title: null, text: 'https://example.com/a', url: 'https://example.com/a' })
  })

  it('gives text the query as its text and a subject that says more as its title', () => {
    expect(
      sharedFields(
        { kind: 'send', text: 'how do springs work', subject: 'Physics' },
        { kind: 'search', query: 'how do springs work' }
      )
    ).toEqual({ title: 'Physics', text: 'how do springs work', url: null })
    // A share whose text is only its subject does not repeat it.
    expect(
      sharedFields(
        { kind: 'send', text: '', subject: 'Meeting notes' },
        { kind: 'search', query: 'Meeting notes' }
      )
    ).toEqual({ title: null, text: 'Meeting notes', url: null })
  })

  it('has nothing for an image or an empty share', () => {
    expect(sharedFields({ kind: 'send' }, { kind: 'none' })).toBeNull()
    expect(
      sharedFields({ kind: 'send' }, { kind: 'image', dataUrl: 'data:image/png;base64,AA==' })
    ).toBeNull()
  })
})

describe('shareTargetLaunch', () => {
  const fields = { title: 'An article', text: 'Read this', url: 'https://example.com/a?x=1' }

  it("writes a GET target's fields into its action's query under the app's own names", () => {
    const launch = shareTargetLaunch(
      target({ title: 'subject', text: 'body', url: 'link' }),
      fields
    )
    expect(launch.method).toBe('GET')
    const u = new URL(launch.url)
    expect(u.origin + u.pathname).toBe('https://app.example/share')
    // The action's own query stays; a field it already carried is replaced, not doubled.
    expect(u.searchParams.get('src')).toBe('manifest')
    expect(u.searchParams.getAll('link')).toEqual(['https://example.com/a?x=1'])
    expect(u.searchParams.get('subject')).toBe('An article')
    expect(u.searchParams.get('body')).toBe('Read this')
  })

  it('sends only the fields the target names and the share has', () => {
    const launch = shareTargetLaunch(target({ url: 'link' }), { ...fields, title: null })
    expect(new URL(launch.url).searchParams.has('subject')).toBe(false)
    expect(new URL(launch.url).searchParams.get('link')).toBe(fields.url)
    const none = shareTargetLaunch(target({ title: 'subject' }), {
      title: null,
      text: 'x',
      url: null
    })
    expect(new URL(none.url).searchParams.has('subject')).toBe(false)
  })

  it('carries a POST target as a form body of its enctype', () => {
    const urlencoded = shareTargetLaunch(
      target(
        { text: 'body', url: 'link' },
        { method: 'POST', action: 'https://app.example/receive' }
      ),
      fields
    )
    expect(urlencoded).toEqual({
      method: 'POST',
      url: 'https://app.example/receive',
      post: {
        encoding: 'urlencoded',
        fields: [
          { name: 'body', value: 'Read this' },
          { name: 'link', value: 'https://example.com/a?x=1' }
        ]
      }
    })
    const multipart = shareTargetLaunch(
      target(
        { title: 'subject' },
        { method: 'POST', enctype: 'multipart/form-data', action: 'https://app.example/receive' }
      ),
      fields
    )
    expect(multipart).toMatchObject({
      method: 'POST',
      post: { encoding: 'multipart', fields: [{ name: 'subject', value: 'An article' }] }
    })
  })
})

describe('the chooser header', () => {
  it('titles text by its first line, trimmed and capped', () => {
    expect(chooserTitleForText('\n\n  first line  \nsecond')).toBe('first line')
    expect(chooserTitleForText('x'.repeat(300))).toHaveLength(256)
    expect(chooserTitleForText('   ')).toBe('')
  })

  it("titles a link by the share's subject, else the address's host", () => {
    expect(chooserTitleForUrl('https://example.com/a', 'An article')).toBe('An article')
    expect(chooserTitleForUrl('https://example.com/a', undefined)).toBe('example.com')
    expect(chooserTitleForUrl('https://example.com/a', '  ')).toBe('example.com')
    // A subject that is the link itself is no title.
    expect(chooserTitleForUrl('https://example.com/a', 'https://example.com/a')).toBe('example.com')
    expect(chooserTitleForUrl('not a url', null)).toBe('not a url')
  })
})
