import { describe, expect, it } from 'vitest'
import { shortcutFormError } from '../shortcutForm'

const existing = [
  { id: 'a', url: 'https://a.example/' },
  { id: 'b', url: 'https://b.example/path' }
]

describe('shortcutFormError', () => {
  it('accepts web addresses, bare hosts included, and nothing else', () => {
    expect(shortcutFormError('c.example', existing, null)).toBeNull()
    expect(shortcutFormError('  https://c.example/x?y=1  ', existing, null)).toBeNull()
    expect(shortcutFormError('http://intranet:8080/', existing, null)).toBeNull()
    expect(shortcutFormError('', existing, null)).toBe('Enter a web address, like example.com')
    expect(shortcutFormError('not a url', existing, null)).toBe(
      'Enter a web address, like example.com'
    )
    expect(shortcutFormError('javascript:alert(1)', existing, null)).toBe(
      'Enter a web address, like example.com'
    )
    expect(shortcutFormError('zen://newtab', existing, null)).toBe(
      'Enter a web address, like example.com'
    )
  })

  it('refuses an address another tile already has, except the tile being edited', () => {
    expect(shortcutFormError('a.example', existing, null)).toBe('This shortcut already exists')
    expect(shortcutFormError('https://b.example/path', existing, 'a')).toBe(
      'This shortcut already exists'
    )
    expect(shortcutFormError('https://a.example/', existing, 'a')).toBeNull()
  })

  it('refuses an add on a full grid, never an edit', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      url: `https://s${i}.example/`
    }))
    expect(shortcutFormError('new.example', full, null)).toBe('The grid holds 10 shortcuts')
    expect(shortcutFormError('new.example', full, 's3')).toBeNull()
  })
})
