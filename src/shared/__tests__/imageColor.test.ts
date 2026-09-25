import { describe, expect, it } from 'vitest'
import {
  ACCENT_CONTRAST_FLOOR,
  DARK_PANEL,
  LIGHT_PANEL,
  accentFromImage,
  dominantColor,
  imageAccentHex,
  readsOnPanels
} from '../imageColor'
import { contrastRatio, hexToRgb, rgbToHsl, type RGB } from '../theme'

/** A picture as pixels: each `[colour, share]` fills that share of the frame, in order. */
function picture(
  parts: Array<[RGB, number, number?]>,
  layout: 'rgba' | 'bgra' = 'rgba',
  side = 48
): Uint8Array {
  const total = side * side
  const out = new Uint8Array(total * 4)
  let at = 0
  for (const [[r, g, b], share, alpha = 255] of parts) {
    const count = Math.round(total * share)
    for (let i = 0; i < count && at < total; i++, at++) {
      const o = at * 4
      if (layout === 'rgba') {
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
      } else {
        out[o] = b
        out[o + 1] = g
        out[o + 2] = r
      }
      out[o + 3] = alpha
    }
  }
  return out
}

function near(actual: RGB | null, expected: RGB, tolerance = 8): void {
  expect(actual).not.toBeNull()
  for (let i = 0; i < 3; i++)
    expect(Math.abs(actual![i] - expected[i])).toBeLessThanOrEqual(tolerance)
}

describe('dominantColor', () => {
  it('a red boat on grey water is red: saturation outweighs area', () => {
    const grey: RGB = [128, 128, 128]
    const red: RGB = [200, 30, 30]
    near(
      dominantColor(
        picture([
          [grey, 0.7],
          [red, 0.3]
        ]),
        'rgba'
      ),
      red
    )
  })

  it('reads BGRA the same as RGBA', () => {
    const teal: RGB = [20, 150, 140]
    near(
      dominantColor(
        picture(
          [
            [[128, 128, 128], 0.6],
            [teal, 0.4]
          ],
          'bgra'
        ),
        'bgra'
      ),
      teal
    )
    expect(dominantColor(picture([[teal, 1]], 'bgra'), 'bgra')).toEqual(
      dominantColor(picture([[teal, 1]], 'rgba'), 'rgba')
    )
  })

  it('leaves out what carries no colour: transparent, near white and near black pixels', () => {
    const blue: RGB = [40, 80, 220]
    // Mostly transparent red, a little opaque blue: the blue.
    near(
      dominantColor(
        picture([
          [[220, 20, 20], 0.9, 40],
          [blue, 0.1]
        ]),
        'rgba'
      ),
      blue
    )
    // A photo of a white wall with a blue door, or a night sky with a blue neon sign.
    near(
      dominantColor(
        picture([
          [[250, 250, 250], 0.9],
          [blue, 0.1]
        ]),
        'rgba'
      ),
      blue
    )
    near(
      dominantColor(
        picture([
          [[8, 8, 10], 0.9],
          [blue, 0.1]
        ]),
        'rgba'
      ),
      blue
    )
  })

  it('a grey picture yields its busiest grey, a line drawing its mean; no opaque pixels yield null', () => {
    expect(dominantColor(picture([[[100, 100, 100], 1]]), 'rgba')).toEqual([100, 100, 100])
    // Two greys, no colour in either: the one there is more of.
    expect(
      dominantColor(
        picture([
          [[60, 60, 60], 0.6],
          [[140, 140, 140], 0.4]
        ]),
        'rgba'
      )
    ).toEqual([60, 60, 60])
    // Nothing but near white and near black – every pixel left out: the mean of them all.
    near(
      dominantColor(
        picture([
          [[250, 250, 250], 0.5],
          [[8, 8, 10], 0.5]
        ]),
        'rgba'
      ),
      [129, 129, 130],
      1
    )
    expect(dominantColor(picture([[[200, 30, 30], 1, 0]]), 'rgba')).toBeNull()
    expect(dominantColor(new Uint8Array(0), 'rgba')).toBeNull()
  })

  it('the busiest bin answers with its own mean, not the bin corner', () => {
    // Pixels spread inside one 4-bit bin: the answer is their centre, not a multiple of 16.
    const pixels = picture([
      [[200, 32, 32], 0.25],
      [[204, 36, 36], 0.25],
      [[208, 40, 40], 0.25],
      [[206, 38, 38], 0.25]
    ])
    near(dominantColor(pixels, 'rgba'), [204, 36, 36], 2)
  })
})

describe('accentFromImage (v2 §1: 3:1 on both panels)', () => {
  const hueOf = (c: RGB): number => rgbToHsl(c)[0]

  it('a mid-tone that reads already comes back untouched', () => {
    const blue: RGB = [59, 111, 214]
    expect(readsOnPanels(blue)).toBe(true)
    expect(accentFromImage(blue)).toEqual(blue)
  })

  it('a pastel is darkened along its own hue until it reads on the light panel', () => {
    const pastel: RGB = [230, 200, 250]
    expect(contrastRatio(pastel, LIGHT_PANEL)).toBeLessThan(ACCENT_CONTRAST_FLOOR)
    const fitted = accentFromImage(pastel)
    expect(readsOnPanels(fitted)).toBe(true)
    expect(Math.abs(hueOf(fitted) - hueOf(pastel))).toBeLessThan(4)
    // The least move: the fitted colour sits at the band's light edge, not deep in it.
    expect(contrastRatio(fitted, LIGHT_PANEL)).toBeLessThan(ACCENT_CONTRAST_FLOOR + 0.15)
  })

  it('a deep colour is lightened along its own hue until it reads on the dark panel', () => {
    const navy: RGB = [10, 10, 60]
    expect(contrastRatio(navy, DARK_PANEL)).toBeLessThan(ACCENT_CONTRAST_FLOOR)
    const fitted = accentFromImage(navy)
    expect(readsOnPanels(fitted)).toBe(true)
    expect(Math.abs(hueOf(fitted) - hueOf(navy))).toBeLessThan(4)
    expect(contrastRatio(fitted, DARK_PANEL)).toBeLessThan(ACCENT_CONTRAST_FLOOR + 0.15)
  })

  it('white, black and any colour at all land in the band', () => {
    expect(readsOnPanels(accentFromImage([255, 255, 255]))).toBe(true)
    expect(readsOnPanels(accentFromImage([0, 0, 0]))).toBe(true)
    // A sweep of the cube's corners, edges and a coarse lattice inside it.
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51) {
          const fitted = accentFromImage([r, g, b])
          expect(readsOnPanels(fitted)).toBe(true)
          if (r !== g || g !== b) expect(Math.abs(hueOf(fitted) - hueOf([r, g, b]))).toBeLessThan(4)
        }
  })
})

describe('imageAccentHex', () => {
  it('the dominant colour, fitted, as #rrggbb; null for no pixels', () => {
    // A light pink on more grey: the pink (it has the colour), darkened to read.
    const pink: RGB = [240, 160, 200]
    const hex = imageAccentHex(
      picture([
        [[128, 128, 128], 0.7],
        [pink, 0.3]
      ]),
      'rgba'
    )
    expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    const rgb = hexToRgb(hex!)!
    expect(readsOnPanels(rgb)).toBe(true)
    expect(contrastRatio(pink, LIGHT_PANEL)).toBeLessThan(ACCENT_CONTRAST_FLOOR)
    expect(Math.abs(rgbToHsl(rgb)[0] - rgbToHsl(pink)[0])).toBeLessThan(4)
    expect(imageAccentHex(new Uint8Array(0), 'rgba')).toBeNull()
  })
})
