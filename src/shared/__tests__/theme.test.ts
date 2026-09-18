import { describe, expect, it } from 'vitest'
import {
  CAPTION_HEIGHT,
  THEME_PRESETS,
  captionColors,
  colorToWheel,
  cssColorToHex,
  deriveColors,
  hexToRgb,
  hslToRgb,
  isDarkColor,
  makeTheme,
  mix,
  panelBase,
  resolveTheme,
  rgbToHex,
  rgbToHsl,
  scrimBase,
  themeCssVariables,
  themeInk,
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

  it('turns a computed CSS colour into #rrggbbaa for the native host', () => {
    // How Chromium serialises a computed colour with and without alpha.
    expect(cssColorToHex('rgba(73, 72, 74, 0.28)')).toBe('#49484a47')
    expect(cssColorToHex('rgb(30, 30, 36)')).toBe('#1e1e24ff')
    // The token as authored, should a host hand it over unserialised.
    expect(cssColorToHex('rgb(8 8 10 / 0.45)')).toBe('#08080a73')
    expect(cssColorToHex('rgb(8 8 10 / 45%)')).toBe('#08080a73')
    expect(cssColorToHex('transparent')).toBeNull()
    expect(cssColorToHex('color(srgb 0.1 0.2 0.3)')).toBeNull()
    expect(cssColorToHex('')).toBeNull()
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
    expect(vars['--zen-panel-rgb']).toMatch(/^\d+ \d+ \d+$/)
    expect(vars['--zen-scrim-rgb']).toMatch(/^\d+ \d+ \d+$/)
  })

  it('tints panels and the scrim with the space colour', () => {
    // Light: 30% of the window over white; dark: 55% over #101010; scrim: 30% over black.
    const light = resolveTheme(makeTheme('#4080ff'), false)
    expect(panelBase(light)).toEqual(mix(light.averageColor, [255, 255, 255], 0.7))
    expect(scrimBase(light)).toEqual(mix(light.averageColor, [0, 0, 0], 0.7))
    const dark = resolveTheme(makeTheme('#4080ff'), true)
    expect(panelBase(dark)).toEqual(mix(dark.averageColor, [16, 16, 16], 0.45))
    // A themed panel is not neutral: it leans towards the space's hue.
    const [r, , b] = panelBase(light)
    expect(b).toBeGreaterThan(r)
    // The base window without a theme stays near paper and near black.
    expect(panelBase(resolveTheme(null, false))).toEqual([251, 251, 252])
    expect(panelBase(resolveTheme(null, true))).toEqual([23, 23, 25])
    expect(scrimBase(resolveTheme(null, false))).toEqual([73, 72, 74])
    expect(scrimBase(resolveTheme(null, true))).toEqual([8, 8, 10])
  })
})

describe('captionColors', () => {
  it('rests the native buttons on the space colour at alpha 0 with the chrome ink as glyphs', () => {
    const light = resolveTheme(makeTheme('#4080ff'), false)
    const colors = captionColors(light)
    expect(colors.color).toBe(`${rgbToHex(light.averageColor)}00`)
    expect(colors.color).toMatch(/^#[0-9a-f]{8}$/)
    expect(colors.symbolColor).toBe(rgbToHex(themeInk(light)))
    expect(colors.symbolColor).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('flips the glyph ink with the scheme so it stays legible on the gradient', () => {
    const light = captionColors(resolveTheme(null, false))
    const dark = captionColors(resolveTheme(null, true))
    expect(isDarkColor(hexToRgb(light.symbolColor)!)).toBe(true)
    expect(isDarkColor(hexToRgb(dark.symbolColor)!)).toBe(false)
    expect(light.symbolColor).toBe(themeCssVariables(resolveTheme(null, false))['--zen-fg'])
    expect(dark.symbolColor).toBe(themeCssVariables(resolveTheme(null, true))['--zen-fg'])
  })

  it('matches the chrome header row', () => {
    expect(CAPTION_HEIGHT).toBe(38)
  })
})
