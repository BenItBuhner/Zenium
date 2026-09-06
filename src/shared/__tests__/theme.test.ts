import { describe, expect, it } from 'vitest'
import {
  THEME_PRESETS,
  colorToWheel,
  deriveColors,
  hexToRgb,
  hslToRgb,
  isDarkColor,
  makeTheme,
  resolveTheme,
  rgbToHex,
  rgbToHsl,
  themeCssVariables,
  toMonochrome,
  wheelToColor
} from '../theme'

describe('colour utilities', () => {
  it('round-trips rgb <-> hsl and hex', () => {
    const rgb = hexToRgb('#9d7cff')!
    const back = hslToRgb(rgbToHsl(rgb))
    expect(back.map((c, i) => Math.abs(c - rgb[i]) <= 1).every(Boolean)).toBe(true)
    expect(rgbToHex(rgb)).toBe('#9d7cff')
    expect(hexToRgb('nope')).toBeNull()
  })

  it('maps wheel positions to colours and back', () => {
    const [r, g, b] = wheelToColor(0.5, 0.05) // top of the wheel = hue 0 (red-ish)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    const pos = colorToWheel([255, 0, 0])
    expect(pos.x).toBeCloseTo(0.5, 1)
    expect(pos.y).toBeLessThan(0.5)
    expect(isDarkColor([20, 20, 20])).toBe(true)
    expect(isDarkColor([240, 240, 240])).toBe(false)
  })
})

describe('harmony algorithms', () => {
  const theme = makeTheme('#4fa3ff', ['#5af0d6'])

  it('keeps user positions for the floating algorithm', () => {
    expect(deriveColors(theme.colors, 'floating')).toEqual(theme.colors)
  })

  it('places the complementary colour opposite the primary', () => {
    const [primary, secondary] = deriveColors(theme.colors, 'complementary')
    const dx = primary.x - 0.5
    const dy = primary.y - 0.5
    expect(secondary.x).toBeCloseTo(0.5 - dx, 5)
    expect(secondary.y).toBeCloseTo(0.5 - dy, 5)
  })

  it('monochrome keeps the primary hue for every colour', () => {
    const mono = toMonochrome(deriveColors(theme.colors, 'triadic'))
    const hue = rgbToHsl(mono[0].c)[0]
    for (const c of mono.slice(1)) expect(Math.abs(rgbToHsl(c.c)[0] - hue)).toBeLessThan(2)
  })
})

describe('resolveTheme', () => {
  it('falls back to the base colours without a theme', () => {
    expect(resolveTheme(null, false).isDark).toBe(false)
    expect(resolveTheme(null, true).isDark).toBe(true)
  })

  it('produces a linear gradient for multi-colour themes and a solid for one colour', () => {
    const multi = resolveTheme(THEME_PRESETS[0].theme, false)
    expect(multi.background.startsWith('linear-gradient(135deg')).toBe(true)
    const single = resolveTheme(makeTheme('#ff0000'), false)
    expect(single.background).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('emits space-separated rgb channels usable with slash alpha syntax', () => {
    const vars = themeCssVariables(resolveTheme(null, false))
    expect(vars['--zen-fg-rgb']).toMatch(/^\d+ \d+ \d+$/)
    expect(vars['--zen-accent-rgb']).toMatch(/^\d+ \d+ \d+$/)
  })
})
