import { describe, expect, it } from 'vitest'
import {
  badgeInk,
  badgeLabel,
  badgeStyle,
  contrastRatio,
  parseCssColor,
  relativeLuminance
} from '../badge'

describe('parseCssColor', () => {
  it('reads hex in every length', () => {
    expect(parseCssColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 136 / 255 })
    expect(parseCssColor('#4688F1')).toEqual({ r: 70, g: 136, b: 241, a: 1 })
    expect(parseCssColor('#4688f180')).toEqual({ r: 70, g: 136, b: 241, a: 128 / 255 })
  })

  it('reads rgb() and rgba() with commas, spaces and a slash', () => {
    expect(parseCssColor('rgb(70, 136, 241)')).toEqual({ r: 70, g: 136, b: 241, a: 1 })
    expect(parseCssColor('rgba(70,136,241,0.5)')).toEqual({ r: 70, g: 136, b: 241, a: 0.5 })
    expect(parseCssColor('rgb(70 136 241 / 50%)')).toEqual({ r: 70, g: 136, b: 241, a: 0.5 })
    expect(parseCssColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('reads a serialised ColorArray and the common names', () => {
    expect(parseCssColor('[70, 136, 241, 255]')).toEqual({ r: 70, g: 136, b: 241, a: 1 })
    expect(parseCssColor('[255,0,0]')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('transparent')?.a).toBe(0)
  })

  it('rejects garbage', () => {
    expect(parseCssColor(null)).toBeNull()
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('#12')).toBeNull()
    expect(parseCssColor('#gggggg')).toBeNull()
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
    expect(parseCssColor('hsl(10 50% 50%)')).toBeNull()
  })
})

describe('contrast', () => {
  it('white on black is 21:1, white is luminance 1', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 }
    const black = { r: 0, g: 0, b: 0, a: 1 }
    expect(relativeLuminance(white)).toBeCloseTo(1)
    expect(relativeLuminance(black)).toBe(0)
    expect(contrastRatio(white, black)).toBeCloseTo(21)
  })

  it('picks light ink on dark and saturated colours, dark ink on pale ones', () => {
    expect(badgeInk(parseCssColor('#1a73e8')!)).toBe('light')
    expect(badgeInk(parseCssColor('#c43434')!)).toBe('light')
    expect(badgeInk(parseCssColor('#000')!)).toBe('light')
    expect(badgeInk(parseCssColor('#ffeb3b')!)).toBe('dark')
    expect(badgeInk(parseCssColor('#fff')!)).toBe('dark')
    expect(badgeInk(parseCssColor('#b2f2bb')!)).toBe('dark')
  })
})

describe('badgeLabel', () => {
  it('trims and cuts to four characters like Chrome', () => {
    expect(badgeLabel('12')).toBe('12')
    expect(badgeLabel(' 1234 ')).toBe('1234')
    expect(badgeLabel('12345')).toBe('1234')
    expect(badgeLabel('')).toBe('')
    expect(badgeLabel('   ')).toBe('')
    expect(badgeLabel(null)).toBe('')
  })
})

describe('badgeStyle', () => {
  it('falls back to the accent tokens without a colour', () => {
    expect(badgeStyle({ badgeBackgroundColor: null, badgeTextColor: null })).toEqual({
      background: 'var(--zen-accent-fill)',
      color: 'var(--zen-on-accent)'
    })
    expect(badgeStyle({ badgeBackgroundColor: 'transparent', badgeTextColor: null })).toEqual({
      background: 'var(--zen-accent-fill)',
      color: 'var(--zen-on-accent)'
    })
  })

  it('uses the extension colour and a readable ink', () => {
    expect(badgeStyle({ badgeBackgroundColor: '#1a73e8', badgeTextColor: null })).toEqual({
      background: 'rgb(26 115 232)',
      color: 'rgb(255 255 255)'
    })
    expect(badgeStyle({ badgeBackgroundColor: '#ffeb3b', badgeTextColor: null })).toEqual({
      background: 'rgb(255 235 59)',
      color: 'rgb(16 16 16)'
    })
  })

  it('honours the extension text colour when it set one', () => {
    expect(badgeStyle({ badgeBackgroundColor: '#1a73e8', badgeTextColor: '#ff0' }).color).toBe(
      'rgb(255 255 0)'
    )
  })

  it('carries the extension alpha', () => {
    expect(
      badgeStyle({ badgeBackgroundColor: 'rgba(0,0,0,0.5)', badgeTextColor: null }).background
    ).toBe('rgb(0 0 0 / 0.50)')
  })
})
