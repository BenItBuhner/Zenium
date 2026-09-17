/**
 * The app icon: Zenium's mark (a ring with a dot) on a coloured ground, in a handful of colours
 * the user can pick from. This module is the single source of the palette and the geometry:
 * `scripts/app-icons.ts` renders every launcher and desktop asset from it, the Settings page
 * draws its swatches from it, and both hosts key their runtime icon on the variant id.
 *
 * Keep it free of imports: Node runs it directly (type-stripped) when the assets are generated.
 */

/** Stable ids; they name the Android launcher aliases and the asset folders, so never rename. */
export type AppIconId =
  'indigo' | 'purple' | 'ocean' | 'forest' | 'sunset' | 'rose' | 'slate' | 'graphite'

export interface AppIconVariant {
  id: AppIconId
  /** Sentence-case label shown under the swatch. */
  name: string
  /** The space accent the colour comes from (design language §1.3 / theme presets). */
  accent: string
  /** The icon's ground: the accent as a light-mode accent fill (§1.1), `#rrggbb` lower case. */
  fill: string
}

/** The mark itself, white on every ground; the monochrome layer uses the same shape. */
export const APP_ICON_INK = '#ffffff'

/** The colour Zenium has shipped with so far (the default space accent). */
export const APP_ICON_DEFAULT: AppIconId = 'indigo'

/**
 * Design language §1.1: a surface that carries white ink is the accent clamped to an OKLCH
 * lightness of 0.35–0.6, chroma and hue kept. The current colour sits inside that band and
 * comes through untouched; the brighter preset accents deepen just enough for the mark to hold.
 */
export const APP_ICON_FILL_LIGHTNESS: readonly [min: number, max: number] = [0.35, 0.6]

const SOURCES: ReadonlyArray<{ id: AppIconId; name: string; accent: string }> = [
  { id: 'indigo', name: 'Indigo', accent: '#6264dc' },
  { id: 'purple', name: 'Purple', accent: '#9d7cff' },
  { id: 'ocean', name: 'Ocean', accent: '#4fa3ff' },
  { id: 'forest', name: 'Forest', accent: '#4caf50' },
  { id: 'sunset', name: 'Sunset', accent: '#ff7a59' },
  { id: 'rose', name: 'Rose', accent: '#ff6b9d' },
  { id: 'slate', name: 'Slate', accent: '#7d8ba1' },
  { id: 'graphite', name: 'Graphite', accent: '#3b3c44' }
]

/** Every variant, in the order the swatch grid shows them (the default first). */
export const APP_ICON_VARIANTS: readonly AppIconVariant[] = SOURCES.map((s) => ({
  ...s,
  fill: accentFill(s.accent)
}))

export function appIconVariant(id: string | null | undefined): AppIconVariant {
  return APP_ICON_VARIANTS.find((v) => v.id === id) ?? APP_ICON_VARIANTS[0]
}

/** A persisted or incoming value narrowed to a known id (anything else is the default). */
export function sanitizeAppIcon(value: unknown): AppIconId {
  return APP_ICON_VARIANTS.some((v) => v.id === value) ? (value as AppIconId) : APP_ICON_DEFAULT
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The mark in units of the ring's outer radius. These are the proportions of the launcher
 * vector Zenium has always shipped (ring radius 24, stroke 7, dot 8 in a 108 viewport).
 */
export const APP_ICON_MARK = {
  /** Radius of the ring's centreline. */
  ring: 24 / 27.5,
  /** Stroke width of the ring. */
  stroke: 7 / 27.5,
  /** Radius of the dot in the middle. */
  dot: 8 / 27.5
} as const

/** Android adaptive icon: 108 dp canvas, 72 dp of it visible, the mark's outer radius in dp. */
export const APP_ICON_ANDROID = { canvas: 108, ringOuter: 27.5 } as const

/**
 * Desktop icon and swatch: a squircle filling the canvas, the mark's outer radius as a fraction
 * of the side. Corners are the chrome's `superellipse(1.3)` (design language §2) at 22.5 %.
 */
export const APP_ICON_DESKTOP = {
  ringOuter: 0.3,
  cornerRadius: 0.225,
  /** CSS `superellipse(k)` exponent 2^k; 1.3 is the chrome's squircle. */
  cornerExponent: Math.pow(2, 1.3),
  /**
   * macOS draws icons on a grid that leaves a margin around the shape (824 of 1024 points);
   * the Dock and Finder assets are inset by this fraction of the side on every edge.
   */
  macInset: (1024 - 824) / 2 / 1024
} as const

/**
 * SVG path of the squircle: a rounded rectangle whose corners follow the L^n norm of the
 * superellipse, sampled finely enough to read as a curve at any swatch size.
 */
export function squirclePath(
  size: number,
  radiusFraction: number = APP_ICON_DESKTOP.cornerRadius,
  exponent: number = APP_ICON_DESKTOP.cornerExponent,
  inset = 0
): string {
  const r = size * radiusFraction
  const n = exponent
  const min = inset
  const max = size - inset
  const steps = 16
  // Corner arc from angle `from` to `to` (radians) around centre (cx, cy).
  const arc = (cx: number, cy: number, from: number, to: number): string => {
    let d = ''
    for (let i = 1; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps
      const c = Math.cos(t)
      const s = Math.sin(t)
      const x = cx + Math.sign(c) * r * Math.pow(Math.abs(c), 2 / n)
      const y = cy + Math.sign(s) * r * Math.pow(Math.abs(s), 2 / n)
      d += ` L${fmt(x)} ${fmt(y)}`
    }
    return d
  }
  const half = Math.PI / 2
  return (
    `M${fmt(min + r)} ${fmt(min)}` +
    ` L${fmt(max - r)} ${fmt(min)}` +
    arc(max - r, min + r, -half, 0) +
    ` L${fmt(max)} ${fmt(max - r)}` +
    arc(max - r, max - r, 0, half) +
    ` L${fmt(min + r)} ${fmt(max)}` +
    arc(min + r, max - r, half, Math.PI) +
    ` L${fmt(min)} ${fmt(min + r)}` +
    arc(min + r, min + r, Math.PI, 3 * half) +
    ' Z'
  )
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

// ---------------------------------------------------------------------------
// OKLCH (sRGB ↔ OKLab, Björn Ottosson's matrices) – enough to apply the fill rule
// ---------------------------------------------------------------------------

type RGB = [number, number, number]

/** The §1.1 light-mode accent fill of `accentHex`, as `#rrggbb`. */
export function accentFill(accentHex: string): string {
  const rgb = parseHex(accentHex)
  const [l, c, h] = rgbToOklch(rgb)
  const [min, max] = APP_ICON_FILL_LIGHTNESS
  const target = Math.min(max, Math.max(min, l))
  // Inside the band the accent is the fill; avoid a round trip changing a channel by one.
  if (target === l) return toHex(rgb)
  return toHex(oklchToRgb([target, c, h]))
}

export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.min(255, Math.max(0, Math.round(v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return c * 255
}

/** OKLab of an sRGB colour: [L, a, b]. */
export function rgbToOklab([r8, g8, b8]: RGB): [number, number, number] {
  const r = srgbToLinear(r8)
  const g = srgbToLinear(g8)
  const b = srgbToLinear(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function oklabToLinear([L, a, b]: [number, number, number]): RGB {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export function rgbToOklch(rgb: RGB): [number, number, number] {
  const [L, a, b] = rgbToOklab(rgb)
  const c = Math.hypot(a, b)
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  return [L, c, h]
}

/** sRGB of an OKLCH colour, chroma reduced until it fits the gamut (CSS-style mapping). */
export function oklchToRgb([L, c, h]: [number, number, number]): RGB {
  const rad = (h * Math.PI) / 180
  const attempt = (chroma: number): RGB =>
    oklabToLinear([L, chroma * Math.cos(rad), chroma * Math.sin(rad)])
  const inGamut = (lin: RGB): boolean => lin.every((v) => v >= -1e-6 && v <= 1 + 1e-6)
  let lin = attempt(c)
  if (!inGamut(lin)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(attempt(mid))) lo = mid
      else hi = mid
    }
    lin = attempt(lo)
  }
  return lin.map((v) => linearToSrgb(Math.min(1, Math.max(0, v)))) as RGB
}

/** WCAG contrast of the mark over a ground, for the palette test. */
export function contrastWithInk(fillHex: string): number {
  const lum = (rgb: RGB): number => {
    const [r, g, b] = rgb.map(srgbToLinear)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ink = lum(parseHex(APP_ICON_INK))
  const ground = lum(parseHex(fillHex))
  return (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05)
}
