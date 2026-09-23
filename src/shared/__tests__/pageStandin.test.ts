import { describe, expect, it } from 'vitest'
import { standinScale } from '../pageStandin'

/** The device-pixel area a result encodes, in the ceiling's unit. */
const area = (size: { width: number; height: number }, dpr: number): number =>
  size.width * dpr * (size.height * dpr)

/** The Electron host's two numbers (`views.ts`): 1:1 through 6.2 Mpx, past it down to 3.7 Mpx. */
const ceiling = { trigger: 6_200_000, target: 3_700_000 }

/**
 * The stand-in's ceiling (v2 draft §9.5): a device-pixel TRIGGER area, no CSS-pixel width – a
 * frame at or under it is encoded as captured, one past it is scaled down on both sides to a
 * smaller TARGET area, not to the trigger.
 */
describe('standinScale', () => {
  it('leaves a capture at or under the trigger as it is, at scale 1', () => {
    // A 1920 × 1200 window's page with the sidebar collapsed: 1856 × 1184 = 2.20 Mpx.
    expect(standinScale(1856, 1184, 1, ceiling)).toEqual({ width: 1856, height: 1184, scale: 1 })
    // The old clamp's case: 1536 wide was resized to 1400; the trigger leaves it alone.
    expect(standinScale(1536, 944, 1, ceiling)).toEqual({ width: 1536, height: 944, scale: 1 })
    // A 2560 × 1440 monitor's page (3.55 Mpx) and a 3440 × 1440 ultrawide's (4.95 Mpx): 1:1.
    expect(standinScale(2496, 1424, 1, ceiling)).toEqual({ width: 2496, height: 1424, scale: 1 })
    expect(standinScale(3440, 1440, 1, ceiling)).toEqual({ width: 3440, height: 1440, scale: 1 })
    // The documented edge: a 1600 × 1000 DIP window at DPR 2, 3072 × 1968 = 6.05 Mpx, stays crisp.
    expect(standinScale(3072, 1968, 1, ceiling)).toEqual({ width: 3072, height: 1968, scale: 1 })
  })

  it('counts an area exactly at the trigger as under it', () => {
    // 3100 × 2000 = 6,200,000 device pixels, the trigger to the pixel.
    expect(3100 * 2000).toBe(ceiling.trigger)
    expect(standinScale(3100, 2000, 1, ceiling)).toEqual({ width: 3100, height: 2000, scale: 1 })
    // Measured in CSS pixels at DPR 2: 1550 × 1000 → the same 6.2 Mpx.
    expect(standinScale(1550, 1000, 2, ceiling)).toEqual({ width: 1550, height: 1000, scale: 1 })
    // One row more is past it.
    expect(standinScale(3100, 2001, 1, ceiling).scale).toBeLessThan(1)
  })

  it('scales a capture past the trigger down to the target on both sides, the aspect kept, never over the target', () => {
    // A 4K monitor at 200 %: 3840 × 2160 = 8.29 Mpx → sqrt(3.7 / 8.29) = .668 → 2564 × 1442.
    const monitor = standinScale(3840, 2160, 1, ceiling)
    expect(monitor.scale).toBeCloseTo(Math.sqrt(3_700_000 / (3840 * 2160)), 6)
    expect(monitor.scale).toBeLessThan(1)
    expect(area(monitor, 1)).toBeLessThanOrEqual(ceiling.target)
    // Rounding down costs at most a pixel a side: the area lands within a row of the target.
    expect(area(monitor, 1)).toBeGreaterThan(ceiling.target - (monitor.width + monitor.height))
    expect(monitor.width / monitor.height).toBeCloseTo(3840 / 2160, 3)
    expect(monitor).toMatchObject({ width: 2564, height: 1442 })
    // A frame just past the trigger drops to the target too, not to the trigger: 3104 × 2000
    // (6.21 Mpx) scales by .77 to 2396 × 1544, never by the .998 a single ceiling would give.
    const justPast = standinScale(3104, 2000, 1, ceiling)
    expect(justPast.scale).toBeCloseTo(Math.sqrt(3_700_000 / (3104 * 2000)), 6)
    expect(justPast).toMatchObject({ width: 2396, height: 1544 })
    expect(area(justPast, 1)).toBeLessThanOrEqual(ceiling.target)
    // A 5K frame (14.7 Mpx) lands on the same target area as the 4K one.
    const retina5k = standinScale(5120, 2880, 1, ceiling)
    expect(retina5k).toMatchObject({ width: 2564, height: 1442 })
  })

  it('counts device pixels: a DPR-2 capture measured in CSS pixels is judged by its device pixels', () => {
    // A 1920 × 1080 DIP screen at DPR 2 measured in CSS pixels: 3840 × 2160 device px (8.29 Mpx).
    const css = standinScale(1920, 1080, 2, ceiling)
    expect(css.scale).toBeCloseTo(Math.sqrt(3_700_000 / (3840 * 2160)), 6)
    expect(area(css, 2)).toBeLessThanOrEqual(ceiling.target)
    expect(css.width / css.height).toBeCloseTo(1920 / 1080, 2)
    // The same frame handed over as a 1x bitmap of device pixels (what `capturePage` gives)
    // scales to the same device-pixel size, to the pixel the rounding down keeps.
    const bitmap = standinScale(3840, 2160, 1, ceiling)
    expect(bitmap.scale).toBeCloseTo(css.scale, 6)
    expect(Math.abs(bitmap.width - css.width * 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(bitmap.height - css.height * 2)).toBeLessThanOrEqual(1)
    // And a DPR-2 frame under the trigger in device pixels stays 1:1 however it is measured.
    expect(standinScale(1536, 944, 2, ceiling)).toEqual({ width: 1536, height: 944, scale: 1 })
  })

  it('never enlarges: a small capture stays its size, and a target above the trigger is the trigger', () => {
    expect(standinScale(800, 600, 1, ceiling)).toEqual({ width: 800, height: 600, scale: 1 })
    expect(standinScale(320, 200, 1, { trigger: Infinity, target: 1 })).toEqual({
      width: 320,
      height: 200,
      scale: 1
    })
    // A target past the trigger cannot lift a frame over the trigger: it is capped at it.
    const capped = standinScale(4000, 3000, 1, { trigger: 6_200_000, target: 50_000_000 })
    expect(capped.scale).toBeCloseTo(Math.sqrt(6_200_000 / (4000 * 3000)), 6)
    expect(area(capped, 1)).toBeLessThanOrEqual(6_200_000)
    // A target that is not a positive number takes the trigger's value.
    expect(standinScale(4000, 3000, 1, { trigger: 6_200_000, target: 0 })).toEqual(capped)
    expect(standinScale(4000, 3000, 1, { trigger: 6_200_000, target: Number.NaN })).toEqual(capped)
  })

  it('treats a trigger or a scale that is not a positive number as no cap, a size that is not as untouched', () => {
    expect(standinScale(4000, 3000, 1, { trigger: 0, target: 3_700_000 })).toEqual({
      width: 4000,
      height: 3000,
      scale: 1
    })
    expect(standinScale(4000, 3000, 1, { trigger: Number.NaN, target: 3_700_000 })).toEqual({
      width: 4000,
      height: 3000,
      scale: 1
    })
    // A representation scale that is not a number counts as 1.
    expect(standinScale(4000, 3000, Number.NaN, ceiling)).toEqual(
      standinScale(4000, 3000, 1, ceiling)
    )
    expect(standinScale(0, 0, 1, ceiling)).toEqual({ width: 0, height: 0, scale: 1 })
    expect(standinScale(-5, 10, 1, ceiling)).toEqual({ width: -5, height: 10, scale: 1 })
  })

  it('keeps at least a pixel a side for a degenerate strip past the trigger', () => {
    // A 1 × 10,000,000 strip is past the trigger; the width cannot round to nothing.
    const strip = standinScale(1, 10_000_000, 1, ceiling)
    expect(strip.width).toBe(1)
    expect(strip.height).toBe(6_082_762)
  })
})
