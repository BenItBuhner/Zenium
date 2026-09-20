import { describe, expect, it } from 'vitest'
import { QR_QUIET_ZONE, qrLayout, qrSymbol } from '../qr'

/*
 * The share popover's QR code (lib/qr.ts): Nayuki's encoder as an SVG path on a four-module
 * quiet zone – a version-1 symbol (21 modules) for a short link, larger for a longer one, the
 * three finder patterns in their corners – and no symbol for nothing or for text past what a
 * QR code holds.
 */

/** Whether the module at (x, y) of the symbol – quiet zone excluded – is dark. */
function dark(path: string, x: number, y: number): boolean {
  return path.includes(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`)
}

describe('qrSymbol', () => {
  it('encodes a short link as a version-1 symbol with the quiet zone around it', () => {
    // 13 bytes: within version 1's 14 at medium error correction.
    const qr = qrSymbol('https://z.app')!
    expect(qr.size).toBe(21 + 2 * QR_QUIET_ZONE)
    // The finder patterns: a dark 7×7 ring in three corners, with a dark 3×3 centre.
    for (const [ox, oy] of [
      [0, 0],
      [14, 0],
      [0, 14]
    ]) {
      expect(dark(qr.path, ox, oy)).toBe(true)
      expect(dark(qr.path, ox + 6, oy + 6)).toBe(true)
      expect(dark(qr.path, ox + 3, oy + 3)).toBe(true)
      expect(dark(qr.path, ox + 1, oy + 1)).toBe(false)
    }
    // Nothing is drawn in the quiet zone.
    expect(qr.path.includes('M0 ')).toBe(false)
  })

  it('grows with the text and gives up past what a QR code can hold', () => {
    const small = qrSymbol('https://z.app')!
    const large = qrSymbol(`https://zen.app/?q=${'x'.repeat(400)}`)!
    expect(large.size).toBeGreaterThan(small.size)
    expect(qrSymbol('')).toBeNull()
    expect(qrSymbol('x'.repeat(3000))).toBeNull()
  })
})

describe('qrLayout', () => {
  it('draws whole pixels a module, centred at a whole offset, the tile taking the remainder', () => {
    // 33 modules in 158: 4 a module (132), 26 over, 13 each side.
    expect(qrLayout(33, 158)).toEqual({ scale: 4, offset: 13 })
    // 29 modules: 5 a module (145), 13 over – 6 here and 7 on the far side, never 6.5.
    expect(qrLayout(29, 158)).toEqual({ scale: 5, offset: 6 })
    // 37 modules: 4 a module (148), 5 each side.
    expect(qrLayout(37, 158)).toEqual({ scale: 4, offset: 5 })
    // Exactly filling: no padding.
    expect(qrLayout(79, 158)).toEqual({ scale: 2, offset: 0 })
  })

  it('fills the tile fractionally only for a symbol denser than a pixel a module', () => {
    expect(qrLayout(158, 158)).toEqual({ scale: 1, offset: 0 })
    expect(qrLayout(185, 158)).toEqual({ scale: 158 / 185, offset: 0 })
  })
})
