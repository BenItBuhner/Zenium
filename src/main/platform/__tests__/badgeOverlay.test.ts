import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  BADGE_BACKGROUND,
  BADGE_FOREGROUND,
  BADGE_OVERLAY_SIZE,
  badgeOverlayPng,
  encodePng,
  labelLayout,
  renderBadgeBitmap
} from '../badgeOverlay'

/*
 * The Windows taskbar overlay's image (MW-51), drawn without a font: Chrome's filled circle in
 * Windows 10's badge colour with the label in white, fitted inside the margin at the largest
 * whole scale, a flag as a white disc; encoded as a PNG the shell can take.
 */

const pixel = (
  bitmap: { size: number; rgba: Uint8Array },
  x: number,
  y: number
): [number, number, number, number] => {
  const i = (y * bitmap.size + x) * 4
  return [bitmap.rgba[i], bitmap.rgba[i + 1], bitmap.rgba[i + 2], bitmap.rgba[i + 3]]
}

describe('labelLayout', () => {
  it('fits a count at the largest whole scale inside the margin, centred', () => {
    // 32 px: margin 6, inner 20 (+2 slack across); one 3-unit glyph → scale 4 (height caps it).
    expect(labelLayout('1', 32)).toEqual({ scale: 4, x: 10, y: 6, width: 12, height: 20 })
    // Two glyphs (7 units): 22 / 7 → scale 3, a 21 × 15 box.
    expect(labelLayout('42', 32)).toEqual({ scale: 3, x: 5, y: 8, width: 21, height: 15 })
    // "99+" (11 units): scale 2, 22 wide – a pixel past the margin each side, as Chrome's runs.
    expect(labelLayout('99+', 32)).toEqual({ scale: 2, x: 5, y: 11, width: 22, height: 10 })
  })

  it('never goes below two pixels a unit at 32, and has no box for a label without glyphs', () => {
    expect(labelLayout('99+', 16)?.scale).toBe(1)
    expect(labelLayout('•', 32)).toBeNull()
    expect(labelLayout('', 32)).toBeNull()
  })

  it('keeps every label inside the circle', () => {
    for (const label of ['1', '7', '10', '42', '99', '99+']) {
      const box = labelLayout(label, 32)!
      const halfDiagonal = Math.hypot(box.width / 2, box.height / 2)
      expect(halfDiagonal, label).toBeLessThan(16 - 1)
    }
  })
})

describe('renderBadgeBitmap', () => {
  it('draws the circle in the badge colour over a transparent square, with the count in white', () => {
    const bitmap = renderBadgeBitmap('1')
    expect(bitmap.size).toBe(BADGE_OVERLAY_SIZE)
    expect(bitmap.rgba).toHaveLength(32 * 32 * 4)
    // The corners lie outside the circle: fully transparent.
    expect(pixel(bitmap, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(bitmap, 31, 31)).toEqual([0, 0, 0, 0])
    // Just inside the top of the circle: the background, opaque.
    expect(pixel(bitmap, 16, 2)).toEqual([...BADGE_BACKGROUND, 255])
    // The "1"'s stem runs down the middle: white at the centre.
    expect(pixel(bitmap, 16, 16)).toEqual([...BADGE_FOREGROUND, 255])
    // Beside the stem, inside the box, the glyph's unlit column: background.
    expect(pixel(bitmap, 11, 14)).toEqual([...BADGE_BACKGROUND, 255])
    // The circle's edge is anti-aliased: a pixel the rim crosses is part-transparent.
    const rim = pixel(bitmap, 4, 4)
    expect(rim[3]).toBeGreaterThan(0)
    expect(rim[3]).toBeLessThan(255)
    expect(rim.slice(0, 3)).toEqual([...BADGE_BACKGROUND])
  })

  it('draws a flag as a white disc in the middle', () => {
    const bitmap = renderBadgeBitmap('•')
    expect(pixel(bitmap, 16, 16)).toEqual([...BADGE_FOREGROUND, 255])
    expect(pixel(bitmap, 15, 15)).toEqual([...BADGE_FOREGROUND, 255])
    // Off the disc, inside the circle: background.
    expect(pixel(bitmap, 16, 6)).toEqual([...BADGE_BACKGROUND, 255])
    expect(pixel(bitmap, 26, 16)).toEqual([...BADGE_BACKGROUND, 255])
  })

  it('draws 99+ as three glyphs across the middle', () => {
    const bitmap = renderBadgeBitmap('99+')
    const box = labelLayout('99+', 32)!
    // The first 9's top row is lit across its three units.
    for (let x = box.x; x < box.x + 3 * box.scale; x++)
      expect(pixel(bitmap, x, box.y), `x=${x}`).toEqual([...BADGE_FOREGROUND, 255])
    // The gap between the first and second 9 is unlit.
    expect(pixel(bitmap, box.x + 3 * box.scale, box.y + box.scale)).toEqual([
      ...BADGE_BACKGROUND,
      255
    ])
    // The plus: its middle row spans its three units, its top row is empty.
    const plusX = box.x + 2 * 4 * box.scale
    expect(pixel(bitmap, plusX, box.y + 2 * box.scale)).toEqual([...BADGE_FOREGROUND, 255])
    expect(pixel(bitmap, plusX, box.y)).toEqual([...BADGE_BACKGROUND, 255])
  })
})

describe('the PNG', () => {
  it('is a 32 × 32 truecolour-with-alpha PNG whose rows decode to the bitmap', () => {
    const png = badgeOverlayPng({ kind: 'count', value: 7 })
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: length 13, then width, height, depth 8, colour type 6 (RGBA), 0, 0, 0.
    expect(png.readUInt32BE(8)).toBe(13)
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(32)
    expect(png.readUInt32BE(20)).toBe(32)
    expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0])
    // IDAT follows IHDR (length 4 + type 4 + data 13 + crc 4 = 25 bytes from offset 8).
    const idatLength = png.readUInt32BE(33)
    expect(png.subarray(37, 41).toString('latin1')).toBe('IDAT')
    const raw = inflateSync(png.subarray(41, 41 + idatLength))
    expect(raw).toHaveLength((32 * 4 + 1) * 32)
    const bitmap = renderBadgeBitmap('7')
    for (let y = 0; y < 32; y++) {
      expect(raw[y * 129]).toBe(0)
      expect([...raw.subarray(y * 129 + 1, (y + 1) * 129)]).toEqual([
        ...bitmap.rgba.subarray(y * 128, (y + 1) * 128)
      ])
    }
    // IEND closes it.
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND')
  })

  it('carries the standard CRC on each chunk (the IEND chunk’s is fixed)', () => {
    const png = encodePng({ size: 1, rgba: new Uint8Array([1, 2, 3, 4]) })
    expect(png.readUInt32BE(png.length - 4)).toBe(0xae426082)
    expect(png.readUInt32BE(16)).toBe(1)
  })

  it('is the same image for the same badge – a cache by label is sound', () => {
    expect(
      badgeOverlayPng({ kind: 'count', value: 100 }).equals(
        badgeOverlayPng({ kind: 'count', value: 250 })
      )
    ).toBe(true)
    expect(
      badgeOverlayPng({ kind: 'flag' }).equals(badgeOverlayPng({ kind: 'count', value: 1 }))
    ).toBe(false)
  })
})
