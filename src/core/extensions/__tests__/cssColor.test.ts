import { describe, expect, it } from 'vitest'
import { parseCssColor } from '../api/cssColor'

describe('parseCssColor (the badge colour strings Chrome accepts)', () => {
  it('reads the named colours, whatever their case', () => {
    expect(parseCssColor('white')).toEqual([255, 255, 255, 255])
    expect(parseCssColor('red')).toEqual([255, 0, 0, 255])
    expect(parseCssColor('RED')).toEqual([255, 0, 0, 255])
    expect(parseCssColor('rebeccapurple')).toEqual([102, 51, 153, 255])
    expect(parseCssColor('lightgoldenrodyellow')).toEqual([250, 250, 210, 255])
    expect(parseCssColor('grey')).toEqual(parseCssColor('gray'))
  })

  it('reads hex in the four lengths', () => {
    expect(parseCssColor('#abc')).toEqual([170, 187, 204, 255])
    expect(parseCssColor('#abcd')).toEqual([170, 187, 204, 221])
    expect(parseCssColor('#AABBCC')).toEqual([170, 187, 204, 255])
    expect(parseCssColor('#aabbccdd')).toEqual([170, 187, 204, 221])
    expect(parseCssColor('#ab')).toBeNull()
    expect(parseCssColor('#abcde')).toBeNull()
    expect(parseCssColor('#ggg')).toBeNull()
  })

  it('reads rgb() and rgba() in the comma form and the space form', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255])
    expect(parseCssColor('rgba(1,2,3,0.5)')).toEqual([1, 2, 3, 128])
    expect(parseCssColor('rgb(1 2 3)')).toEqual([1, 2, 3, 255])
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual([1, 2, 3, 128])
    expect(parseCssColor('rgb(100%, 0%, 50%)')).toEqual([255, 0, 128, 255])
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
    expect(parseCssColor('rgb(a, b, c)')).toBeNull()
  })

  it('reads hsl() and hsla() as Chrome converts them', () => {
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 255])
    expect(parseCssColor('hsl(120, 100%, 50%)')).toEqual([0, 255, 0, 255])
    expect(parseCssColor('hsl(240,100%,50%)')).toEqual([0, 0, 255, 255])
    expect(parseCssColor('hsl(0, 0%, 50%)')).toEqual([128, 128, 128, 255])
    expect(parseCssColor('hsla(120, 50%, 50%, 0.5)')).toEqual([64, 191, 64, 128])
    // Chrome truncates the hue and wraps it into 0..359.
    expect(parseCssColor('hsl(-120, 100%, 50%)')).toEqual(parseCssColor('hsl(240, 100%, 50%)'))
    expect(parseCssColor('hsl(480.7, 100%, 50%)')).toEqual(parseCssColor('hsl(120, 100%, 50%)'))
    expect(parseCssColor('hsl(120deg 100% 50%)')).toEqual([0, 255, 0, 255])
  })

  it('refuses what is not a colour', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('notacolor')).toBeNull()
    expect(parseCssColor('rgb(')).toBeNull()
    expect(parseCssColor('hsl(0, 100, 50)')).toEqual([255, 0, 0, 255])
    expect(parseCssColor('url(#x)')).toBeNull()
  })
})
