/**
 * Elevation of the two surfaces a page morphs between on the phone: the content frame the live
 * page sits in (`--zen-frame-shadow`) and the thumbnail card it becomes in the tab overview
 * (`--zen-shadow-1`, level 1 of the design language). Both are described as the same layers –
 * hairline outline, contact shadow, ambient shadow, inner light hairline – so the hero can
 * interpolate every layer continuously instead of swapping one look for another; at either end
 * it renders exactly the stylesheet's value. A test keeps these constants and `main.css` equal.
 */
export interface ShadowLayer {
  inset?: boolean
  x: number
  y: number
  blur: number
  spread: number
  /** The chrome's foreground colour (the outline), plain black (shadows) or white (the inner hairline). */
  tint: 'fg' | 'black' | 'white'
  alpha: number
}

/** The content frame: a hairline outline and a shallow ambient shadow. */
export const FRAME_SHADOW: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0.08 },
  { x: 0, y: 1, blur: 2, spread: 0, tint: 'black', alpha: 0 },
  { x: 0, y: 2, blur: 14, spread: 0, tint: 'black', alpha: 0.08 },
  { inset: true, x: 0, y: 0, blur: 0, spread: 1, tint: 'white', alpha: 0 }
]

/** An overview card, level 1 (`--zen-shadow-1`): no outline, a contact and an ambient shadow. */
export const CARD_SHADOW_LIGHT: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0 },
  { x: 0, y: 1, blur: 2, spread: 0, tint: 'black', alpha: 0.06 },
  { x: 0, y: 8, blur: 24, spread: 0, tint: 'black', alpha: 0.1 },
  { inset: true, x: 0, y: 0, blur: 0, spread: 1, tint: 'white', alpha: 0 }
]

/** Level 1 in the dark: the light opacities times 2.2 plus a one-pixel inner light hairline. */
export const CARD_SHADOW_DARK: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0 },
  { x: 0, y: 1, blur: 2, spread: 0, tint: 'black', alpha: 0.2 },
  { x: 0, y: 8, blur: 24, spread: 0, tint: 'black', alpha: 0.32 },
  { inset: true, x: 0, y: 0, blur: 0, spread: 1, tint: 'white', alpha: 0.06 }
]

export function cardShadow(dark: boolean): ShadowLayer[] {
  return dark ? CARD_SHADOW_DARK : CARD_SHADOW_LIGHT
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function layerCss(layer: ShadowLayer): string {
  const px = (v: number): string => (v === 0 ? '0' : `${round(v)}px`)
  const colour =
    layer.tint === 'fg'
      ? `rgb(var(--zen-fg-rgb) / ${round(layer.alpha)})`
      : layer.tint === 'white'
        ? `rgb(255 255 255 / ${round(layer.alpha)})`
        : `rgb(0 0 0 / ${round(layer.alpha)})`
  const geometry = `${px(layer.x)} ${px(layer.y)} ${px(layer.blur)} ${px(layer.spread)} ${colour}`
  return layer.inset ? `inset ${geometry}` : geometry
}

/** The `box-shadow` value for a set of layers. */
export function shadowCss(layers: ShadowLayer[]): string {
  return layers.map(layerCss).join(', ')
}

/** Layer-wise interpolation between two looks with the same number of layers (`t` = 0…1). */
export function lerpShadow(from: ShadowLayer[], to: ShadowLayer[], t: number): ShadowLayer[] {
  const k = Math.min(1, Math.max(0, t))
  return from.map((a, i) => {
    const b = to[i] ?? a
    return {
      inset: a.inset,
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      blur: a.blur + (b.blur - a.blur) * k,
      spread: a.spread + (b.spread - a.spread) * k,
      tint: k < 0.5 ? a.tint : b.tint,
      alpha: a.alpha + (b.alpha - a.alpha) * k
    }
  })
}
