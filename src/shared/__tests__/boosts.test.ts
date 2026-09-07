import { describe, expect, it } from 'vitest'
import { boostCss, emptyBoost, isEmptyBoost } from '../boosts'

describe('boostCss', () => {
  it('compiles every feature into one stylesheet', () => {
    const css = boostCss({
      ...emptyBoost('example.com'),
      tint: '#ff0000',
      tintIntensity: 0.5,
      font: 'serif',
      fontSize: 120,
      darkMode: true,
      zapped: ['#ad', '.promo > div'],
      css: 'body{margin:0}'
    })
    expect(css).toContain('invert(1) hue-rotate(180deg)')
    expect(css).toContain('background:#ff0000')
    expect(css).toContain('opacity:0.50')
    expect(css).toContain('Georgia')
    expect(css).toContain('font-size:120%')
    expect(css).toContain('#ad,\n.promo > div{display:none!important}')
    expect(css.trim().endsWith('body{margin:0}')).toBe(true)
  })

  it('is empty for disabled or blank boosts and rejects selector injection', () => {
    expect(boostCss({ ...emptyBoost('a.test'), enabled: false, darkMode: true })).toBe('')
    expect(boostCss(emptyBoost('a.test'))).toBe('')
    expect(isEmptyBoost(emptyBoost('a.test'))).toBe(true)
    const css = boostCss({ ...emptyBoost('a.test'), zapped: ['div}body{display:none'] })
    expect(css).toBe('')
  })

  it('clamps font size and tint strength', () => {
    const css = boostCss({ ...emptyBoost('a.test'), fontSize: 999, tint: '#000', tintIntensity: 7 })
    expect(css).toContain('font-size:200%')
    expect(css).toContain('opacity:1.00')
  })
})
