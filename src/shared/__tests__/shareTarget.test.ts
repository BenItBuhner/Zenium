import { describe, expect, it } from 'vitest'
import { extractUrl, routeSharedIntent } from '../shareTarget'

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
