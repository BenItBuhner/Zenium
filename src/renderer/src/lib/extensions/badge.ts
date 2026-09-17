import type { ExtensionAction } from '@shared/types'

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Chrome shows at most four characters of badge text. */
export const BADGE_MAX_CHARS = 4

const NAMED: Record<string, string> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  yellow: '#ffff00',
  purple: '#800080',
  transparent: '#00000000'
}

/**
 * Parses the colour forms `chrome.action.setBadgeBackgroundColor` produces: `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` with commas or spaces, a `[r, g, b, a]` array
 * serialised as JSON, and the handful of CSS names extensions actually use. Null for anything else.
 */
export function parseCssColor(input: string | null | undefined): Rgba | null {
  if (!input) return null
  const text = input.trim().toLowerCase()
  if (text in NAMED) return parseCssColor(NAMED[text])
  if (text.startsWith('#')) return parseHex(text.slice(1))
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(text)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p.length > 0)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map(parseChannel)
    if (channels.some((c) => c === null)) return null
    const [r, g, b] = channels as number[]
    return { r, g, b, a: alphaOf(parts) }
  }
  const arr = /^\[\s*([^\]]*)\]$/.exec(text)
  if (arr) {
    const parts = arr[1].split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
    const [r, g, b, a = 255] = parts
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a / 255) }
  }
  return null
}

function parseHex(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
  if (hex.length !== 6 && hex.length !== 8) return null
  const n = parseInt(hex, 16)
  const alpha = hex.length === 8 ? (n & 0xff) / 255 : 1
  const rgb = hex.length === 8 ? n >>> 8 : n
  return { r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff, a: alpha }
}

function parseChannel(part: string): number | null {
  if (part.endsWith('%')) {
    const v = Number(part.slice(0, -1))
    return Number.isFinite(v) ? clamp255((v / 100) * 255) : null
  }
  const v = Number(part)
  return Number.isFinite(v) ? clamp255(v) : null
}

/** The alpha component of an `rgb()` argument list, in 0–1 (percent or number); 1 when absent. */
function alphaOf(parts: string[]): number {
  if (parts.length < 4) return 1
  const raw = parts[3]
  const v = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw)
  return Number.isFinite(v) ? clamp01(v) : 1
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const INK_LIGHT: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const INK_DARK: Rgba = { r: 16, g: 16, b: 16, a: 1 }

/**
 * Which ink reads on an extension-chosen badge colour: white unless near-black text has the
 * better contrast (Chrome picks the same way). These two are the only literal colours in the
 * extensions UI, and they are not chrome surfaces: they answer a colour the extension chose.
 */
export function badgeInk(background: Rgba): 'light' | 'dark' {
  return contrastRatio(background, INK_LIGHT) >= contrastRatio(background, INK_DARK)
    ? 'light'
    : 'dark'
}

/** Chrome truncates badge text to four characters; whitespace-only text hides the badge. */
export function badgeLabel(text: string | null | undefined): string {
  const t = (text ?? '').trim()
  return t.length > BADGE_MAX_CHARS ? t.slice(0, BADGE_MAX_CHARS) : t
}

export interface BadgeStyle {
  /** CSS colour for the pill. */
  background: string
  /** CSS colour for the label. */
  color: string
}

/**
 * The badge's colours as CSS values. Without a colour from the extension the badge is the accent
 * fill with `--zen-on-accent` ink; with one, the extension's colour and whichever ink reads on it
 * (or the extension's own text colour when it set one).
 */
export function badgeStyle(action: Pick<ExtensionAction, 'badgeBackgroundColor' | 'badgeTextColor'>): BadgeStyle {
  const bg = parseCssColor(action.badgeBackgroundColor)
  if (!bg || bg.a === 0) return { background: 'var(--zen-accent-fill)', color: 'var(--zen-on-accent)' }
  const background = `rgb(${bg.r} ${bg.g} ${bg.b}${bg.a < 1 ? ` / ${bg.a.toFixed(2)}` : ''})`
  const text = parseCssColor(action.badgeTextColor)
  if (text && text.a > 0) return { background, color: `rgb(${text.r} ${text.g} ${text.b})` }
  const ink = badgeInk(bg) === 'light' ? INK_LIGHT : INK_DARK
  return { background, color: `rgb(${ink.r} ${ink.g} ${ink.b})` }
}
