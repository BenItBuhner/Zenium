import { describe, expect, it } from 'vitest'
import {
  APP_ICON_DEFAULT,
  APP_ICON_DESKTOP,
  APP_ICON_FILL_LIGHTNESS,
  APP_ICON_VARIANTS,
  accentFill,
  appIconVariant,
  contrastWithInk,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  sanitizeAppIcon,
  squirclePath
} from '../appIcon'

describe('app icon palette', () => {
  it('offers eight colours, the shipped one first and unchanged', () => {
    expect(APP_ICON_VARIANTS).toHaveLength(8)
    expect(APP_ICON_VARIANTS[0].id).toBe(APP_ICON_DEFAULT)
    expect(APP_ICON_VARIANTS[0].id).toBe('indigo')
    // The colour Zenium has always shipped with stays available as it was.
    expect(APP_ICON_VARIANTS[0].fill).toBe('#6264dc')
    expect(new Set(APP_ICON_VARIANTS.map((v) => v.id)).size).toBe(8)
    expect(new Set(APP_ICON_VARIANTS.map((v) => v.fill)).size).toBe(8)
    expect(APP_ICON_VARIANTS.map((v) => v.id)).toContain('graphite')
  })

  it('derives every ground with the accent-fill rule: lightness clamped, hue kept', () => {
    const [min, max] = APP_ICON_FILL_LIGHTNESS
    for (const v of APP_ICON_VARIANTS) {
      const [l, c, h] = rgbToOklch(parseHex(v.fill))
      const [, c0, h0] = rgbToOklch(parseHex(v.accent))
      expect(l).toBeGreaterThanOrEqual(min - 0.005)
      expect(l).toBeLessThanOrEqual(max + 0.005)
      // Hue is meaningless for the near-neutral greys.
      if (c0 > 0.03) expect(Math.abs(((h - h0 + 540) % 360) - 180)).toBeLessThan(2.5)
      expect(c).toBeLessThanOrEqual(c0 + 0.005)
      expect(v.fill).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('keeps the white mark legible on every ground', () => {
    for (const v of APP_ICON_VARIANTS) expect(contrastWithInk(v.fill)).toBeGreaterThanOrEqual(3)
  })

  it('clamps out-of-band accents and passes in-band ones through', () => {
    expect(accentFill('#6264dc')).toBe('#6264dc')
    expect(rgbToOklch(parseHex(accentFill('#ffffff')))[0]).toBeCloseTo(0.6, 2)
    expect(rgbToOklch(parseHex(accentFill('#000000')))[0]).toBeCloseTo(0.35, 2)
    expect(() => accentFill('blue')).toThrow()
  })

  it('round-trips colours through OKLCH', () => {
    for (const hex of ['#6264dc', '#ff7a59', '#3b3c44', '#4caf50']) {
      const rgb = parseHex(hex)
      const back = oklchToRgb(rgbToOklch(rgb))
      back.forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThan(1))
    }
  })
})

describe('sanitizeAppIcon / appIconVariant', () => {
  it('accepts known ids and falls back to the default for anything else', () => {
    expect(sanitizeAppIcon('rose')).toBe('rose')
    expect(sanitizeAppIcon('magenta')).toBe(APP_ICON_DEFAULT)
    expect(sanitizeAppIcon(undefined)).toBe(APP_ICON_DEFAULT)
    expect(sanitizeAppIcon(3)).toBe(APP_ICON_DEFAULT)
    expect(appIconVariant('ocean').name).toBe('Ocean')
    expect(appIconVariant(null).id).toBe(APP_ICON_DEFAULT)
  })
})

describe('squirclePath', () => {
  const points = (d: string): Array<[number, number]> =>
    [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])

  it('is a closed path that stays inside its box and touches every edge', () => {
    const d = squirclePath(100)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    const pts = points(d)
    expect(pts.length).toBeGreaterThan(60)
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-0.001)
      expect(x).toBeLessThanOrEqual(100.001)
      expect(y).toBeGreaterThanOrEqual(-0.001)
      expect(y).toBeLessThanOrEqual(100.001)
    }
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(0, 3)
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(100, 3)
    // The corner is cut: no point sits at the box corner itself.
    expect(pts.some(([x, y]) => x < 1 && y < 1)).toBe(false)
  })

  it('honours the inset and the corner radius', () => {
    const inset = 100 * APP_ICON_DESKTOP.macInset
    const pts = points(squirclePath(100, undefined, undefined, inset))
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(inset, 3)
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(100 - inset, 3)
    const straight = points(squirclePath(100, 0.1))
    // A smaller radius leaves a longer straight edge: the first line runs from r to 100 − r.
    expect(straight[1]).toEqual([90, 0])
  })
})
