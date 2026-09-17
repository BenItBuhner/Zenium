import { describe, expect, it } from 'vitest'
import { formatWindowTitle } from '../windowTitle'

describe('formatWindowTitle', () => {
  it('is Zenium when there is no tab', () => {
    expect(formatWindowTitle(null)).toBe('Zenium')
    expect(formatWindowTitle(undefined)).toBe('Zenium')
    expect(formatWindowTitle('')).toBe('Zenium')
    expect(formatWindowTitle('   ')).toBe('Zenium')
    expect(formatWindowTitle(null, true)).toBe('Zenium')
  })

  it('is "<title> - Zenium" for a normal window', () => {
    expect(formatWindowTitle('Example Domain')).toBe('Example Domain - Zenium')
  })

  it('is "<title> - Zenium (Private)" for a private window', () => {
    expect(formatWindowTitle('Example Domain', true)).toBe('Example Domain - Zenium (Private)')
  })

  it('trims the tab title', () => {
    expect(formatWindowTitle('  Example Domain  ')).toBe('Example Domain - Zenium')
  })
})
