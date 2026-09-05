import type { SpaceTheme, ThemeAlgorithm, ThemeColor } from './types'

export type RGB = [number, number, number]
export type HSL = [number, number, number] // h 0..360, s 0..1, l 0..1

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v))

export function rgbToHsl([r, g, b]: RGB): HSL {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  else if (max === gn) h = ((bn - rn) / d + 2) * 60
  else h = ((rn - gn) / d + 4) * 60
  return [h, s, l]
}

export function hslToRgb([h, s, l]: HSL): RGB {
  const hue = ((h % 360) + 360) % 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [
    Math.round(f(hue / 360 + 1 / 3) * 255),
    Math.round(f(hue / 360) * 255),
    Math.round(f(hue / 360 - 1 / 3) * 255)
  ]
}

export function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp(t, 0, 1)
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ]
}

/** Relative luminance (WCAG). */
export function luminance([r, g, b]: RGB): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function isDarkColor(rgb: RGB): boolean {
  return luminance(rgb) < 0.45
}

// ---------------------------------------------------------------------------
// Colour wheel <-> colour
// ---------------------------------------------------------------------------

/** Convert a normalised wheel position (0..1, centre = 0.5) to a colour: angle → hue, radius → saturation. */
export function wheelToColor(x: number, y: number): RGB {
  const dx = x - 0.5
  const dy = y - 0.5
  const radius = clamp(Math.sqrt(dx * dx + dy * dy) / 0.5, 0, 1)
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  const hue = (angle + 360 + 90) % 360
  return hslToRgb([hue, radius, 0.5 + (1 - radius) * 0.25])
}

export function colorToWheel(rgb: RGB): { x: number; y: number } {
  const [h, s] = rgbToHsl(rgb)
  const angle = ((h - 90) * Math.PI) / 180
  const r = clamp(s, 0, 1) * 0.5
  return { x: 0.5 + Math.cos(angle) * r, y: 0.5 + Math.sin(angle) * r }
}

function rotateOnWheel(primary: ThemeColor, degrees: number): ThemeColor {
  const dx = primary.x - 0.5
  const dy = primary.y - 0.5
  const rad = (degrees * Math.PI) / 180
  const x = 0.5 + dx * Math.cos(rad) - dy * Math.sin(rad)
  const y = 0.5 + dx * Math.sin(rad) + dy * Math.cos(rad)
  return { c: wheelToColor(x, y), x, y }
}

/**
 * Given the primary colour, produce the derived secondary colours for a harmony algorithm.
 * `floating` keeps whatever positions the user dragged the dots to.
 */
export function deriveColors(colors: ThemeColor[], algorithm: ThemeAlgorithm): ThemeColor[] {
  const primary = colors.find((c) => c.isPrimary) ?? colors[0]
  if (!primary || algorithm === 'floating') return colors
  const count = colors.length
  if (count <= 1) return colors
  const angles: Record<Exclude<ThemeAlgorithm, 'floating'>, number[]> = {
    complementary: [180, 180],
    analogous: [30, -30],
    splitComplementary: [150, -150],
    triadic: [120, -120]
  }
  const offsets = angles[algorithm]
  const secondary = colors.filter((c) => c !== primary)
  return [
    { ...primary, isPrimary: true },
    ...secondary.map((_, i) => rotateOnWheel(primary, offsets[i % offsets.length]))
  ]
}

export function toMonochrome(colors: ThemeColor[]): ThemeColor[] {
  const primary = colors.find((c) => c.isPrimary) ?? colors[0]
  if (!primary) return colors
  const [h, s, l] = rgbToHsl(primary.c)
  return colors.map((c, i) => {
    if (c === primary) return { ...c, isPrimary: true }
    const shift = i % 2 === 0 ? -0.18 : 0.18
    return { ...c, c: hslToRgb([h, s * 0.8, clamp(l + shift * (1 + (i >> 1)), 0.08, 0.92)]) }
  })
}

// ---------------------------------------------------------------------------
// Theme → CSS
// ---------------------------------------------------------------------------

export const BASE_LIGHT: RGB = [242, 241, 245]
export const BASE_DARK: RGB = [28, 28, 32]

export interface ResolvedTheme {
  /** CSS `background` value for the browser window. */
  background: string
  /** Solid colour approximating the gradient (used for the content edge / fallbacks). */
  averageColor: RGB
  isDark: boolean
  /** Accent colour used for the active tab, focus rings etc. */
  accent: RGB
  texture: number
}

export function resolveTheme(theme: SpaceTheme | null, darkScheme: boolean): ResolvedTheme {
  const base = darkScheme ? BASE_DARK : BASE_LIGHT
  if (!theme || theme.colors.length === 0) {
    return {
      background: rgbToHex(base),
      averageColor: base,
      isDark: darkScheme,
      accent: darkScheme ? [130, 132, 240] : [98, 100, 220],
      texture: 0
    }
  }
  let colors = deriveColors(theme.colors, theme.algorithm)
  if (theme.monochrome) colors = toMonochrome(colors)
  const tinted = colors.map((c) => {
    // Zen mutes the raw colour so that the gradient stays readable behind the UI.
    const muted = darkScheme ? mix(c.c, [0, 0, 0], 0.55) : mix(c.c, [255, 255, 255], 0.3)
    return mix(base, muted, clamp(theme.opacity, 0, 1))
  })
  const avg: RGB = tinted.reduce<RGB>(
    (acc, c) => [
      acc[0] + c[0] / tinted.length,
      acc[1] + c[1] / tinted.length,
      acc[2] + c[2] / tinted.length
    ],
    [0, 0, 0]
  )
  const average: RGB = [Math.round(avg[0]), Math.round(avg[1]), Math.round(avg[2])]
  const primary = colors.find((c) => c.isPrimary) ?? colors[0]
  const background =
    tinted.length === 1
      ? rgbToHex(tinted[0])
      : `linear-gradient(${Math.round(theme.rotation)}deg, ${tinted
          .map((c, i) => `${rgbToHex(c)} ${Math.round((i / (tinted.length - 1)) * 100)}%`)
          .join(', ')})`
  return {
    background,
    averageColor: average,
    isDark: isDarkColor(average),
    accent: primary.c,
    texture: clamp(theme.texture, 0, 1)
  }
}

export function makeTheme(primaryHex: string, extra: string[] = []): SpaceTheme {
  const rgb = hexToRgb(primaryHex) ?? [120, 120, 220]
  const pos = colorToWheel(rgb)
  const colors: ThemeColor[] = [{ c: rgb, x: pos.x, y: pos.y, isPrimary: true }]
  for (const hex of extra) {
    const c = hexToRgb(hex)
    if (!c) continue
    const p = colorToWheel(c)
    colors.push({ c, x: p.x, y: p.y })
  }
  return {
    type: 'gradient',
    colors,
    opacity: 0.6,
    texture: 0,
    algorithm: 'floating',
    monochrome: false,
    rotation: 135
  }
}

/** Preset gradients offered in the theme picker / onboarding. */
export const THEME_PRESETS: Array<{ name: string; theme: SpaceTheme }> = [
  { name: 'Zen Purple', theme: makeTheme('#9d7cff', ['#ff8bd1']) },
  { name: 'Ocean', theme: makeTheme('#4fa3ff', ['#5af0d6']) },
  { name: 'Forest', theme: makeTheme('#4caf50', ['#c8e06e']) },
  { name: 'Sunset', theme: makeTheme('#ff7a59', ['#ffc857', '#ff4f9a']) },
  { name: 'Rose', theme: makeTheme('#ff6b9d', ['#ffb3c6']) },
  { name: 'Slate', theme: makeTheme('#7d8ba1', ['#a9b8cf']) }
]

export function themeCssVariables(resolved: ResolvedTheme): Record<string, string> {
  const fg: RGB = resolved.isDark ? [240, 240, 245] : [30, 30, 36]
  const fgRgb = fg.join(', ')
  return {
    '--zen-bg': resolved.background,
    '--zen-bg-solid': rgbToHex(resolved.averageColor),
    '--zen-fg': rgbToHex(fg),
    '--zen-fg-rgb': fgRgb,
    '--zen-accent': rgbToHex(resolved.accent),
    '--zen-accent-rgb': resolved.accent.join(', '),
    '--zen-texture': String(resolved.texture)
  }
}
