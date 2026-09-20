import { describe, expect, it } from 'vitest'
import {
  CAPTION_HEIGHT,
  DARK_INK,
  LIGHT_INK,
  PRIVATE_THEME,
  THEME_PRESETS,
  blendResolvedThemes,
  captionColors,
  colorToWheel,
  contrastRatio,
  cssColorToHex,
  deriveColors,
  hexToRgb,
  hslToRgb,
  isDarkColor,
  makeTheme,
  mix,
  panelBase,
  resolveTheme,
  resolveWallpaper,
  rgbToHex,
  rgbToHsl,
  themeCssVariables,
  themeInk,
  toMonochrome,
  wantsLightInk,
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

  it('the window takes the ink with more contrast on it, so a mid-tone takes dark ink (a11y-30)', () => {
    // #c581a0 (luminance 0.30) reads as dark, yet the light ink sits at 2.6:1 on it, the dark ink at 5.5:1.
    expect(isDarkColor([197, 129, 160])).toBe(true)
    expect(wantsLightInk([[197, 129, 160]])).toBe(false)
    expect(contrastRatio(DARK_INK, [197, 129, 160])).toBeGreaterThan(4.5)
    expect(contrastRatio(LIGHT_INK, [197, 129, 160])).toBeLessThan(3)
    // A colour under the crossover (luminance 0.19) takes light ink.
    expect(wantsLightInk([[100, 100, 110]])).toBe(true)
    // The worst stop decides for a gradient: a mid-tone next to a dark stop takes dark ink.
    expect(
      wantsLightInk([
        [197, 129, 160],
        [139, 97, 216]
      ])
    ).toBe(false)
    expect(
      wantsLightInk([
        [40, 40, 60],
        [90, 60, 140]
      ])
    ).toBe(true)
    expect(wantsLightInk([])).toBe(false)
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

  it('a saturated gradient at full strength takes the ink that reads on its worst stop (a11y-30)', () => {
    // Orange to violet on a light scheme: the window's mid-tones average a luminance of 0.30,
    // which the old 0.45 threshold called dark and painted white ink on at 2.6:1.
    const loud = { ...makeTheme('#ff7828', ['#5a1ec8']), opacity: 1 }
    const light = resolveTheme(loud, false)
    expect(light.isDark).toBe(false)
    expect(themeInk(light)).toEqual(DARK_INK)
    // The dark scheme mutes the same colours towards black, where light ink still reads.
    expect(resolveTheme(loud, true).isDark).toBe(true)
    // The presets at their default strength keep the polarity of the scheme.
    for (const { theme } of THEME_PRESETS) {
      expect(resolveTheme(theme, false).isDark).toBe(false)
      expect(resolveTheme(theme, true).isDark).toBe(true)
    }
  })

  it('produces a linear gradient for multi-colour themes and a solid for one colour', () => {
    const multi = resolveTheme(THEME_PRESETS[0].theme, false)
    expect(multi.background.startsWith('linear-gradient(135deg')).toBe(true)
    expect(multi.stops).toHaveLength(THEME_PRESETS[0].theme.colors.length)
    expect(multi.rotation).toBe(135)
    const single = resolveTheme(makeTheme('#ff0000'), false)
    expect(single.background).toMatch(/^#[0-9a-f]{6}$/)
    expect(single.stops).toEqual([hexToRgb(single.background)])
    expect(resolveTheme(null, true).stops).toEqual([resolveTheme(null, true).averageColor])
  })

  it('the private theme resolves dark whatever the scheme, as Zen paints private windows', () => {
    expect(resolveTheme(PRIVATE_THEME, true).isDark).toBe(true)
    expect(resolveTheme(PRIVATE_THEME, false).isDark).toBe(true)
  })

  it('the wallpaper is the gradient at full strength, or the base colour without a theme', () => {
    const theme = THEME_PRESETS[0].theme
    const wallpaper = resolveWallpaper(theme, false)
    expect(wallpaper).toBe(resolveTheme({ ...theme, opacity: 1 }, false).background)
    expect(wallpaper).not.toBe(resolveTheme(theme, false).background)
    expect(resolveWallpaper(null, true)).toBe(resolveTheme(null, true).background)
    expect(resolveWallpaper({ ...theme, colors: [] }, false)).toBe(
      resolveTheme(null, false).background
    )
  })

  it('emits space-separated rgb channels usable with slash alpha syntax', () => {
    const vars = themeCssVariables(resolveTheme(null, false))
    expect(vars['--zen-fg-rgb']).toMatch(/^\d+ \d+ \d+$/)
    expect(vars['--zen-accent-rgb']).toMatch(/^\d+ \d+ \d+$/)
    expect(vars['--zen-panel-rgb']).toMatch(/^\d+ \d+ \d+$/)
  })

  it('tints panels with the space colour', () => {
    // Light: 30% of the window over white; dark: 55% over #101010.
    const light = resolveTheme(makeTheme('#4080ff'), false)
    expect(panelBase(light)).toEqual(mix(light.averageColor, [255, 255, 255], 0.7))
    const dark = resolveTheme(makeTheme('#4080ff'), true)
    expect(panelBase(dark)).toEqual(mix(dark.averageColor, [16, 16, 16], 0.45))
    // A themed panel is not neutral: it leans towards the space's hue.
    const [r, , b] = panelBase(light)
    expect(b).toBeGreaterThan(r)
    // The base window without a theme stays near paper and near black.
    expect(panelBase(resolveTheme(null, false))).toEqual([251, 251, 252])
    expect(panelBase(resolveTheme(null, true))).toEqual([23, 23, 25])
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

describe('blendResolvedThemes', () => {
  const space = resolveTheme(THEME_PRESETS[1].theme, false)
  const priv = resolveTheme(PRIVATE_THEME, true)

  it('is the endpoints at 0 and 1 and every colour half-way at .5', () => {
    expect(blendResolvedThemes(space, priv, 0)).toBe(space)
    expect(blendResolvedThemes(space, priv, 1)).toBe(priv)
    expect(blendResolvedThemes(space, priv, -1)).toBe(space)
    expect(blendResolvedThemes(space, priv, 2)).toBe(priv)
    const mid = blendResolvedThemes(space, priv, 0.5)
    expect(mid.averageColor).toEqual(mix(space.averageColor, priv.averageColor, 0.5))
    expect(mid.accent).toEqual(mix(space.accent, priv.accent, 0.5))
    expect(mid.rotation).toBe(space.rotation + (priv.rotation - space.rotation) / 2)
  })

  it('re-samples the gradient to the longer of the two so a solid blends into a gradient', () => {
    const solid = resolveTheme(null, false)
    const quarter = blendResolvedThemes(solid, priv, 0.25)
    expect(quarter.stops).toHaveLength(priv.stops.length)
    for (const [i, stop] of quarter.stops.entries())
      expect(stop).toEqual(mix(solid.averageColor, priv.stops[i], 0.25))
    expect(quarter.background.startsWith('linear-gradient(')).toBe(true)
    // Two stops against three: the middle of the short side is the mean of its ends.
    const two = resolveTheme(makeTheme('#000000', ['#ffffff']), false)
    const blend = blendResolvedThemes(two, priv, 0.5)
    expect(blend.stops).toHaveLength(3)
    expect(blend.stops[1]).toEqual(mix(mix(two.stops[0], two.stops[1], 0.5), priv.stops[1], 0.5))
  })

  it('flips the dark flag at the midpoint, so the ink follows the side the surface is closer to', () => {
    expect(blendResolvedThemes(space, priv, 0.49).isDark).toBe(false)
    expect(blendResolvedThemes(space, priv, 0.5).isDark).toBe(true)
    expect(blendResolvedThemes(priv, space, 0.49).isDark).toBe(true)
    expect(blendResolvedThemes(priv, space, 0.51).isDark).toBe(false)
  })

  it('writes CSS variables the chrome can take per frame', () => {
    const vars = themeCssVariables(blendResolvedThemes(space, priv, 0.3))
    expect(vars['--zen-bg']).toMatch(/^linear-gradient\(\d+deg, (#[0-9a-f]{6} \d+%(, )?)+\)$/)
    expect(vars['--zen-bg-solid']).toMatch(/^#[0-9a-f]{6}$/)
  })
})
