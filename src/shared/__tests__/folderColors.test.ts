import { describe, expect, it } from 'vitest'
import type { FolderColor } from '../types'
import {
  FOLDER_COLOR_NAMES,
  FOLDER_COLOR_ORDER,
  FOLDER_COLORS_DARK,
  FOLDER_COLORS_LIGHT
} from '../defaults'
import {
  BASE_DARK,
  BASE_LIGHT,
  contrastRatio,
  hexToRgb,
  hslToRgb,
  resolveTheme,
  rgbToHsl,
  THEME_PRESETS,
  type RGB
} from '../theme'

/*
 * The tab group palette pair (design language v2 §9.14, amended with #360 / #361): one set a
 * scheme, and every colour of a set reads at least 3:1 against the window fill it sits on in
 * that scheme – the sidebar (`BASE_LIGHT` 242 241 245 / `BASE_DARK` 28 28 32) and the window
 * gradient's band the horizontal strip stands on (the Zenium Purple preset, the theme the
 * stills and the seeds run; #361 read the light band at #dec5f5 above the strip). LIGHT is
 * Chrome's light set with the five that failed deepened; DARK is Chrome's dark set as it is.
 */

const rgb = (hex: string): RGB => {
  const parsed = hexToRgb(hex)
  expect(parsed, hex).not.toBeNull()
  return parsed!
}

/** Chrome's classic light and dark tab-group sets (chrome/browser/ui/color/chrome_color_mixer.cc). */
const CHROME_LIGHT: Record<FolderColor, string> = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e'
}
const CHROME_DARK: Record<FolderColor, string> = {
  grey: '#dadce0',
  blue: '#8ab4f8',
  red: '#f28b82',
  yellow: '#fdd663',
  green: '#81c995',
  pink: '#ff8bcb',
  purple: '#c58af9',
  cyan: '#78d9ec',
  orange: '#fcad70'
}

const ZENIUM_PURPLE = THEME_PRESETS[0].theme
/** The fills a light-scheme group colour sits on: the sidebar, every stop of the window's band, the band as #361 read it. */
const LIGHT_FILLS: Array<[string, RGB]> = [
  ['sidebar', BASE_LIGHT],
  ...resolveTheme(ZENIUM_PURPLE, false).stops.map((stop, i): [string, RGB] => [
    `band stop ${i}`,
    stop
  ]),
  ['band as measured (#361)', rgb('#dec5f5')]
]
/** The dark scheme's: the sidebar and the dark band. */
const DARK_FILLS: Array<[string, RGB]> = [
  ['sidebar', BASE_DARK],
  ...resolveTheme(ZENIUM_PURPLE, true).stops.map((stop, i): [string, RGB] => [
    `band stop ${i}`,
    stop
  ]),
  ['band as measured (#361)', rgb('#3f2f4e')]
]

describe('the tab group palette pair (§9.14)', () => {
  it('pins the eighteen values', () => {
    expect(FOLDER_COLORS_LIGHT).toEqual({
      blue: '#166cdd',
      green: '#188038',
      orange: '#b75305',
      purple: '#9c37f3',
      pink: '#d01884',
      cyan: '#007b83',
      yellow: '#976700',
      red: '#d52f24',
      grey: '#5f6368'
    })
    expect(FOLDER_COLORS_DARK).toEqual({
      blue: '#8ab4f8',
      green: '#81c995',
      orange: '#fcad70',
      purple: '#c58af9',
      pink: '#ff8bcb',
      cyan: '#78d9ec',
      yellow: '#fdd663',
      red: '#f28b82',
      grey: '#dadce0'
    })
  })

  it('names the same nine colours in the same order in both sets, as the order and the names do', () => {
    const keys = Object.keys(FOLDER_COLORS_LIGHT)
    expect(Object.keys(FOLDER_COLORS_DARK)).toEqual(keys)
    expect([...FOLDER_COLOR_ORDER].sort()).toEqual([...keys].sort())
    expect(Object.keys(FOLDER_COLOR_NAMES).sort()).toEqual([...keys].sort())
    expect(FOLDER_COLOR_ORDER).toEqual([
      'grey',
      'blue',
      'red',
      'yellow',
      'green',
      'pink',
      'purple',
      'cyan',
      'orange'
    ])
  })

  it('reads at least 3:1 against the light sidebar and the light band, every colour of the light set', () => {
    for (const color of FOLDER_COLOR_ORDER) {
      const c = rgb(FOLDER_COLORS_LIGHT[color])
      for (const [fill, on] of LIGHT_FILLS) {
        expect(contrastRatio(c, on), `${color} on the light ${fill}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('reads at least 3:1 against the dark sidebar and the dark band, every colour of the dark set', () => {
    for (const color of FOLDER_COLOR_ORDER) {
      const c = rgb(FOLDER_COLORS_DARK[color])
      for (const [fill, on] of DARK_FILLS) {
        expect(contrastRatio(c, on), `${color} on the dark ${fill}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('is Chrome’s dark set as it stands', () => {
    expect(FOLDER_COLORS_DARK).toEqual(CHROME_DARK)
  })

  it('is Chrome’s light set where Chrome’s passes, and Chrome’s hue deepened where it does not', () => {
    const redrawn: FolderColor[] = []
    for (const color of FOLDER_COLOR_ORDER) {
      const chrome = rgb(CHROME_LIGHT[color])
      const passes = LIGHT_FILLS.every(([, on]) => contrastRatio(chrome, on) >= 3)
      if (passes) {
        expect(FOLDER_COLORS_LIGHT[color], color).toBe(CHROME_LIGHT[color])
        continue
      }
      redrawn.push(color)
      // Re-drawn minimally: the hue and the saturation kept (within a degree and a hundredth of
      // the 8-bit rounding), only the lightness lowered.
      const [h0, s0, l0] = rgbToHsl(chrome)
      const [h, s, l] = rgbToHsl(rgb(FOLDER_COLORS_LIGHT[color]))
      expect(Math.abs(h - h0), `${color} hue`).toBeLessThanOrEqual(1.5)
      expect(Math.abs(s - s0), `${color} saturation`).toBeLessThanOrEqual(0.02)
      expect(l, `${color} lightness`).toBeLessThan(l0)
    }
    // The two the lead named for the sidebar, and the three the band's darkest run adds.
    expect(redrawn.sort()).toEqual(['blue', 'orange', 'purple', 'red', 'yellow'])
  })

  it('stops deepening at the first lightness that passes: half a percent lighter fails some fill', () => {
    // Each re-drawn value is the highest lightness (to the 1/1000) at which every fill reads
    // 3:1 – the colour stays as close to Chrome's as the rule allows, no deeper.
    const worst = (c: RGB): number => Math.min(...LIGHT_FILLS.map(([, on]) => contrastRatio(c, on)))
    for (const color of ['blue', 'red', 'yellow', 'purple', 'orange'] as const) {
      const ours = rgb(FOLDER_COLORS_LIGHT[color])
      expect(worst(ours), color).toBeGreaterThanOrEqual(3)
      const [h, s, l] = rgbToHsl(ours)
      expect(worst(hslToRgb([h, s, l + 0.005])), `${color} a touch lighter`).toBeLessThan(3)
    }
  })
})
