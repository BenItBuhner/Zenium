import { describe, expect, it } from 'vitest'
import { editDistance, looksLikeAsk, suggestHostFix, typedHost } from '../typoFix'

describe('typo fixes in typed addresses', () => {
  it('counts a swap, a slip, a missing and an extra letter as one edit', () => {
    expect(editDistance('gihtub.com', 'github.com')).toBe(1)
    expect(editDistance('githib.com', 'github.com')).toBe(1)
    expect(editDistance('githb.com', 'github.com')).toBe(1)
    expect(editDistance('githuub.com', 'github.com')).toBe(1)
    expect(editDistance('example.org', 'github.com')).toBe(3)
  })

  it('reads the host out of what was typed, and nothing out of a search', () => {
    expect(typedHost('https://www.Gogle.com/maps')).toBe('gogle.com')
    expect(typedHost('best pizza near me')).toBeNull()
    expect(typedHost('10.0.0.1')).toBeNull()
  })

  it('offers the closest known or popular host, and nothing for one that exists', () => {
    expect(suggestHostFix('githb.com', [])).toBe('github.com')
    expect(suggestHostFix('gogle.com/search?q=x', [])).toBe('google.com')
    expect(suggestHostFix('mycompnay.io', ['mycompany.io'])).toBe('mycompany.io')
    expect(suggestHostFix('github.com', [])).toBeNull()
    expect(suggestHostFix('mycompany.io', ['mycompany.io'])).toBeNull()
    expect(suggestHostFix('example.org', [])).toBeNull()
    // Too short to tell a slip from another site.
    expect(suggestHostFix('x.co', [])).toBeNull()
  })
})

describe('looksLikeAsk', () => {
  it('takes a question or a task, not a few search words or an address', () => {
    expect(looksLikeAsk('what is the tallest building in oslo')).toBe(true)
    expect(looksLikeAsk('cheap flights to rome?')).toBe(true)
    expect(looksLikeAsk('compare the m4 and m5 macbook air')).toBe(true)
    expect(looksLikeAsk('whats a good laptop for coding')).toBe(true)
    expect(looksLikeAsk("what's a good laptop for coding")).toBe(true)
    expect(looksLikeAsk('hows the weather in oslo today')).toBe(true)
    expect(looksLikeAsk('recommend a quiet cafe near bryggen')).toBe(true)
    expect(looksLikeAsk('whatsapp web login page')).toBe(false)
    expect(looksLikeAsk('pizza oslo')).toBe(false)
    expect(looksLikeAsk('github.com')).toBe(false)
  })
})
