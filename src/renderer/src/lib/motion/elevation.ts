/**
 * Elevation of the surfaces a page can turn into on the phone: the content frame the live page
 * sits in, and the thumbnail card it becomes in the tab overview. Both are described as the same
 * three shadow layers (hairline outline, contact shadow, ambient shadow) so a morph between them
 * can interpolate every layer continuously instead of swapping one look for another.
 *
 * `main.css` repeats these values as `--zen-frame-shadow` / `--zen-card-shadow`; a test keeps
 * the two in step.
 */
export interface ShadowLayer {
  x: number
  y: number
  blur: number
  spread: number
  /** The chrome's foreground colour (the hairline) or plain black (the shadows). */
  tint: 'fg' | 'black'
  alpha: number
}

/** The content frame: a hairline outline and a shallow ambient shadow. */
export const FRAME_SHADOW: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0.08 },
  { x: 0, y: 1, blur: 2, spread: 0, tint: 'black', alpha: 0 },
  { x: 0, y: 2, blur: 14, spread: 0, tint: 'black', alpha: 0.08 }
]

/** An overview card: no outline, depth from a contact and an ambient shadow. */
export const CARD_SHADOW: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0 },
  { x: 0, y: 1, blur: 2, spread: 0, tint: 'black', alpha: 0.06 },
  { x: 0, y: 8, blur: 24, spread: 0, tint: 'black', alpha: 0.1 }
]

/** A card picked up by a finger. */
export const LIFTED_SHADOW: ShadowLayer[] = [
  { x: 0, y: 0, blur: 0, spread: 1, tint: 'fg', alpha: 0 },
  { x: 0, y: 2, blur: 4, spread: 0, tint: 'black', alpha: 0.08 },
  { x: 0, y: 18, blur: 44, spread: 0, tint: 'black', alpha: 0.18 }
]

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function layerCss(layer: ShadowLayer): string {
  const px = (v: number): string => (v === 0 ? '0' : `${round(v)}px`)
  const colour =
    layer.tint === 'fg'
      ? `rgb(var(--zen-fg-rgb) / ${round(layer.alpha)})`
      : `rgb(0 0 0 / ${round(layer.alpha)})`
  return `${px(layer.x)} ${px(layer.y)} ${px(layer.blur)} ${px(layer.spread)} ${colour}`
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
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      blur: a.blur + (b.blur - a.blur) * k,
      spread: a.spread + (b.spread - a.spread) * k,
      tint: k < 0.5 ? a.tint : b.tint,
      alpha: a.alpha + (b.alpha - a.alpha) * k
    }
  })
}
