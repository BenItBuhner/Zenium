import { contrastRatio, hslToRgb, luminance, rgbToHex, rgbToHsl, type RGB } from './theme'

/** The order of a pixel's four bytes: a canvas hands out RGBA, Chromium's bitmaps BGRA. */
export type PixelLayout = 'rgba' | 'bgra'

/**
 * The two panels an accent has to read on (`--v2-panel`, light and dark). A space theme is one
 * for both schemes, so the colour a picture suggests is fitted to both at once.
 */
export const LIGHT_PANEL: RGB = [244, 244, 244]
export const DARK_PANEL: RGB = [31, 31, 31]

/** Design language v2 §1's floor for non-text ink – the accent's fill, the focus ring – on a panel. */
export const ACCENT_CONTRAST_FLOOR = 3

/** Whether a colour reaches the floor on both panels. */
export function readsOnPanels(rgb: RGB): boolean {
  return (
    contrastRatio(rgb, LIGHT_PANEL) >= ACCENT_CONTRAST_FLOOR &&
    contrastRatio(rgb, DARK_PANEL) >= ACCENT_CONTRAST_FLOOR
  )
}

/**
 * The colour a picture is mostly of, read from its pixels (a small resample – 48 × 48 is plenty
 * and cheap): a histogram at 4 bits a channel, every pixel weighted by its saturation so a red
 * boat on grey water wins over the water, and pixels that carry no colour – transparent, near
 * black, near white – left out; the busiest bin's mean colour. A picture with no colour in it
 * (a grey photograph) yields its busiest grey; one of nothing but near black and near white
 * (a line drawing) the mean of its opaque pixels; null for no opaque pixels at all.
 */
export function dominantColor(pixels: ArrayLike<number>, layout: PixelLayout): RGB | null {
  const [ri, gi, bi] = layout === 'rgba' ? [0, 1, 2] : [2, 1, 0]
  const bins = new Map<number, { w: number; r: number; g: number; b: number }>()
  let meanR = 0
  let meanG = 0
  let meanB = 0
  let opaque = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3]
    if (a < 128) continue
    const r = pixels[i + ri]
    const g = pixels[i + gi]
    const b = pixels[i + bi]
    meanR += r
    meanG += g
    meanB += b
    opaque += 1
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max < 24 || min > 236) continue
    // A grey still counts a little, so a monochrome picture with one tinted corner is that tint
    // only when the tint is more than a speck.
    const w = 0.15 + (max - min) / max
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bin = bins.get(key)
    if (bin) {
      bin.w += w
      bin.r += r * w
      bin.g += g * w
      bin.b += b * w
    } else bins.set(key, { w, r: r * w, g: g * w, b: b * w })
  }
  if (opaque === 0) return null
  let best: { w: number; r: number; g: number; b: number } | null = null
  for (const bin of bins.values()) if (!best || bin.w > best.w) best = bin
  if (!best)
    return [Math.round(meanR / opaque), Math.round(meanG / opaque), Math.round(meanB / opaque)]
  return [Math.round(best.r / best.w), Math.round(best.g / best.w), Math.round(best.b / best.w)]
}

/**
 * A picture's colour fitted for the accent (v2 §1): hue and saturation kept, lightness moved the
 * least that reaches 3:1 on both panels – a luminance between about .14 and .27, the band the
 * mid-tones hold. A colour inside the band already comes back as it is.
 */
export function accentFromImage(rgb: RGB): RGB {
  if (readsOnPanels(rgb)) return rgb
  const [h, s, l] = rgbToHsl(rgb)
  const tooLight = contrastRatio(rgb, LIGHT_PANEL) < ACCENT_CONTRAST_FLOOR
  // The band's edges as luminance: what 3:1 against each panel comes to.
  const ceiling = (luminance(LIGHT_PANEL) + 0.05) / ACCENT_CONTRAST_FLOOR - 0.05
  const floor = ACCENT_CONTRAST_FLOOR * (luminance(DARK_PANEL) + 0.05) - 0.05
  // Luminance rises with lightness at a fixed hue and saturation, so a bisection between the
  // colour's own lightness and the far end converges on the band's nearer edge from its inside.
  let inside = tooLight ? 0 : 1
  let outside = l
  for (let i = 0; i < 24; i++) {
    const mid = (inside + outside) / 2
    const lum = luminance(hslToRgb([h, s, mid]))
    if (tooLight ? lum <= ceiling : lum >= floor) inside = mid
    else outside = mid
  }
  const fitted = hslToRgb([h, s, inside])
  // Unreachable in practice (the band is far wider than an 8-bit step); the classic AA grey then.
  return readsOnPanels(fitted) ? fitted : [118, 118, 118]
}

/** `dominantColor` fitted by `accentFromImage`, as `#rrggbb`; null for a picture with no pixels. */
export function imageAccentHex(pixels: ArrayLike<number>, layout: PixelLayout): string | null {
  const dominant = dominantColor(pixels, layout)
  return dominant ? rgbToHex(accentFromImage(dominant)) : null
}
