import type { Boost } from './types'

/** A boost with nothing configured yet. */
export function emptyBoost(domain: string): Boost {
  return {
    domain,
    enabled: true,
    tint: null,
    tintIntensity: 0.35,
    font: null,
    fontSize: 100,
    darkMode: false,
    zapped: [],
    css: '',
    updatedAt: Date.now()
  }
}

/** True when the boost would not change the page at all (safe to drop). */
export function isEmptyBoost(b: Boost): boolean {
  return (
    !b.tint &&
    !b.font &&
    b.fontSize === 100 &&
    !b.darkMode &&
    b.zapped.length === 0 &&
    !b.css.trim()
  )
}

/** Fonts offered by the Boost editor (Zen ships system + a few generic stacks). */
export const BOOST_FONTS: Array<{ id: string; label: string; stack: string }> = [
  {
    id: 'system',
    label: 'System',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  {
    id: 'mono',
    label: 'Monospace',
    stack: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace'
  },
  {
    id: 'rounded',
    label: 'Rounded',
    stack: '"SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif'
  },
  { id: 'humanist', label: 'Humanist', stack: '"Inter", "Helvetica Neue", Arial, sans-serif' },
  { id: 'dyslexic', label: 'OpenDyslexic', stack: '"OpenDyslexic", "Comic Sans MS", sans-serif' }
]

const ICON_EXCLUSIONS =
  ':not(i):not([class*="icon"]):not([class*="fa-"]):not([class*="material"]):not([class*="glyph"]):not([class*="symbol"])'

function cssEscapeSelectorList(selectors: string[]): string {
  return selectors
    .map((s) => s.trim())
    .filter((s) => s && !/[{}]/.test(s))
    .join(',\n')
}

/** Compile a boost into the stylesheet injected into every page of its domain. */
export function boostCss(b: Boost): string {
  if (!b.enabled) return ''
  const parts: string[] = []
  if (b.darkMode) {
    parts.push(
      'html{filter:invert(1) hue-rotate(180deg)!important;background:#101012!important;color-scheme:light}',
      'img,video,picture,canvas,iframe,embed,object,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}'
    )
  }
  if (b.tint) {
    const opacity = Math.max(0, Math.min(1, b.tintIntensity))
    parts.push(
      `html::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;background:${b.tint};mix-blend-mode:color;opacity:${opacity.toFixed(2)}}`
    )
  }
  if (b.font) {
    const stack = BOOST_FONTS.find((f) => f.id === b.font)?.stack ?? b.font
    parts.push(`html,body,body *${ICON_EXCLUSIONS}{font-family:${stack}!important}`)
  }
  if (b.fontSize !== 100 && Number.isFinite(b.fontSize)) {
    const pct = Math.max(50, Math.min(200, Math.round(b.fontSize)))
    parts.push(`html{font-size:${pct}%!important}`)
  }
  if (b.zapped.length) {
    const list = cssEscapeSelectorList(b.zapped)
    if (list) parts.push(`${list}{display:none!important}`)
  }
  if (b.css.trim()) parts.push(b.css.trim())
  return parts.join('\n')
}
