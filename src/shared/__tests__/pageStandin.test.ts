import { describe, expect, it } from 'vitest'
import { standinScale } from '../pageStandin'

/** The device-pixel area a result encodes, in the ceiling's unit. */
const area = (size: { width: number; height: number }, dpr: number): number =>
  size.width * dpr * (size.height * dpr)

/**
 * The stand-in's ceiling (v2 draft §9.5): a device-pixel area, no CSS-pixel width – a frame
 * under it is encoded as captured, one past it is scaled down on both sides to the ceiling.
 */
describe('standinScale', () => {
  it('leaves a capture under the ceiling as it is, at scale 1', () => {
    // A 1920 × 1200 window's page with the sidebar collapsed: 1856 × 1144 = 2.12 Mpx.
    expect(standinScale(1856, 1144, 1, 2_500_000)).toEqual({ width: 1856, height: 1144, scale: 1 })
    // Right at the ceiling counts as under it.
    expect(standinScale(2000, 1250, 1, 2_500_000)).toEqual({ width: 2000, height: 1250, scale: 1 })
    // The old clamp's case: 1536 wide was resized to 1400; the ceiling leaves it alone.
    expect(standinScale(1536, 944, 1, 2_500_000)).toEqual({ width: 1536, height: 944, scale: 1 })
  })

  it('scales a capture past the ceiling down to it on both sides, the aspect kept, never over the ceiling', () => {
    // A 2560 × 1440 monitor's page: 2496 × 1384 = 3.45 Mpx.
    const wide = standinScale(2496, 1384, 1, 2_500_000)
    expect(wide.scale).toBeCloseTo(Math.sqrt(2_500_000 / (2496 * 1384)), 6)
    expect(wide.scale).toBeLessThan(1)
    expect(area(wide, 1)).toBeLessThanOrEqual(2_500_000)
    // Rounding down costs at most a pixel a side: the area lands within a row of the ceiling.
    expect(area(wide, 1)).toBeGreaterThan(2_500_000 - (wide.width + wide.height))
    expect(wide.width / wide.height).toBeCloseTo(2496 / 1384, 3)
    expect(wide).toMatchObject({ width: 2123, height: 1177 })
  })

  it('counts device pixels: a DPR-2 capture measured in CSS pixels is capped by its device pixels', () => {
    // A 1600 × 1000 DIP window at DPR 2, page 1536 × 944 CSS px = 3072 × 1888 device px (5.8 Mpx).
    const retina = standinScale(1536, 944, 2, 2_500_000)
    expect(retina.scale).toBeCloseTo(Math.sqrt(2_500_000 / (3072 * 1888)), 6)
    expect(area(retina, 2)).toBeLessThanOrEqual(2_500_000)
    // Within the pixel the rounding down keeps on each side (1008 × 619 for 1536 × 944).
    expect(retina.width / retina.height).toBeCloseTo(1536 / 944, 2)
    // The same frame handed over as a 1x bitmap of device pixels (what `capturePage` gives)
    // scales to the same device-pixel size, to the pixel the rounding down keeps.
    const bitmap = standinScale(3072, 1888, 1, 2_500_000)
    expect(bitmap.scale).toBeCloseTo(retina.scale, 6)
    expect(Math.abs(bitmap.width - retina.width * 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(bitmap.height - retina.height * 2)).toBeLessThanOrEqual(1)
    expect(area(bitmap, 1)).toBeLessThanOrEqual(2_500_000)
  })

  it('never enlarges: a small capture under a large ceiling stays its size', () => {
    expect(standinScale(800, 600, 1, 50_000_000)).toEqual({ width: 800, height: 600, scale: 1 })
    expect(standinScale(320, 200, 1, Infinity)).toEqual({ width: 320, height: 200, scale: 1 })
  })

  it('treats a ceiling or a scale that is not a positive number as no cap, a size that is not as untouched', () => {
    expect(standinScale(4000, 3000, 1, 0)).toEqual({ width: 4000, height: 3000, scale: 1 })
    expect(standinScale(4000, 3000, 1, Number.NaN)).toEqual({ width: 4000, height: 3000, scale: 1 })
    // A representation scale that is not a number counts as 1.
    expect(standinScale(4000, 3000, Number.NaN, 2_500_000)).toEqual(
      standinScale(4000, 3000, 1, 2_500_000)
    )
    expect(standinScale(0, 0, 1, 2_500_000)).toEqual({ width: 0, height: 0, scale: 1 })
    expect(standinScale(-5, 10, 1, 2_500_000)).toEqual({ width: -5, height: 10, scale: 1 })
  })

  it('keeps at least a pixel a side for a degenerate strip past the ceiling', () => {
    // A 1 × 10,000,000 strip is over a 2.5 Mpx ceiling; the width cannot round to nothing.
    const strip = standinScale(1, 10_000_000, 1, 2_500_000)
    expect(strip.width).toBe(1)
    expect(strip.height).toBe(5_000_000)
  })
})
