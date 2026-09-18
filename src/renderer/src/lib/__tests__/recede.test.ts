// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pageRecede,
  RECEDE_RADIUS_PX,
  RECEDE_SCALE,
  recedeDepth,
  recedeFrame,
  recedeScale,
  registerRecedeLayer,
  type RecedeHandle,
  type RecedeLayerFrame
} from '../motion/recede'

/*
 * The recede as chassis behaviour (design language v2 draft §11.1, §11.2, §9.24): the page
 * recedes by the sheet's own progress, a second sheet recedes the first and pushes the page no
 * further, and the stack shows one scrim. `recedeFrame` is the pure mapping; the registry writes
 * it to the root and tells each layer of its own frame.
 */

const root = (): HTMLElement => document.documentElement
const recedeVar = (): string => root().style.getPropertyValue('--zen-recede')

/** What scrims of alpha `a` at these shares, one over the other, dim the page to. */
const compound = (layers: readonly RecedeLayerFrame[], a: number): number =>
  1 - layers.reduce((clear, l) => clear * (1 - a * l.scrim), 1)

const handles: RecedeHandle[] = []
const layer = (onFrame?: (frame: RecedeLayerFrame) => void): RecedeHandle => {
  const h = registerRecedeLayer(onFrame)
  handles.push(h)
  return h
}

afterEach(() => {
  for (const h of handles.splice(0)) h.release()
})

describe('recedeFrame: progress → recede', () => {
  it('an empty stack recedes nothing', () => {
    expect(recedeFrame([])).toEqual({ page: 0, layers: [] })
  })

  it('one sheet recedes the page by its own presence, and shows its scrim by the same', () => {
    for (const p of [0, 0.25, 0.5, 0.8, 1]) {
      const frame = recedeFrame([p])
      expect(frame.page).toBe(p)
      expect(frame.layers).toEqual([{ recede: 0, scrim: p, inert: false }])
    }
  })

  it('is monotonic in the presence: half a drag is half a recede, in either direction', () => {
    let last = -1
    for (let p = 0; p <= 1; p += 0.05) {
      const page = recedeFrame([p]).page
      expect(page).toBeGreaterThanOrEqual(last)
      last = page
    }
    // The same presence gives the same frame whichever way it was reached: reversible.
    expect(recedeFrame([0.4])).toEqual(recedeFrame([0.4]))
  })

  it('clamps: a sheet expanded past its first detent pushes nothing further, and nothing pulls', () => {
    expect(recedeFrame([1.6]).page).toBe(1)
    expect(recedeFrame([-0.3]).page).toBe(0)
    // A value that is not a number (a collapsed height divided out) moves nothing.
    expect(recedeFrame([Number.NaN]).page).toBe(0)
    expect(recedeFrame([Number.POSITIVE_INFINITY]).page).toBe(0)
  })

  it('the scale and radius at a recede are the chassis constants', () => {
    expect(RECEDE_SCALE).toBe(0.03)
    expect(RECEDE_RADIUS_PX).toBe(6)
    expect(recedeScale(0)).toBe(1)
    expect(recedeScale(1)).toBeCloseTo(0.97)
    expect(recedeScale(0.5)).toBeCloseTo(0.985)
    expect(recedeScale(3)).toBeCloseTo(0.97)
  })
})

describe('recedeFrame: the stack rule (§11.2, §9.24)', () => {
  it('a second sheet does not push the page further', () => {
    expect(recedeFrame([1, 1]).page).toBe(1)
    expect(recedeFrame([1, 0.5]).page).toBe(1)
    // The page recedes by the most present sheet, whichever it is.
    expect(recedeFrame([0.3, 1]).page).toBe(1)
    expect(recedeFrame([0.3, 0.6]).page).toBe(0.6)
  })

  it('the lower sheet recedes by the presence of the sheet above it, inert from its registering', () => {
    const [lower, upper] = recedeFrame([1, 0.5]).layers
    expect(lower.recede).toBe(0.5)
    expect(lower.inert).toBe(true)
    expect(upper.recede).toBe(0)
    expect(upper.inert).toBe(false)
    // Registered above, not yet up: the lower content is inert already, receded not at all.
    const [under, over] = recedeFrame([1, 0]).layers
    expect(under).toEqual({ recede: 0, scrim: 1, inert: true })
    expect(over).toEqual({ recede: 0, scrim: 0, inert: false })
  })

  it('the stack shows one scrim: the lower share gives way as the upper comes in, summing to the top presence', () => {
    for (let lo = 0; lo <= 1; lo += 0.25) {
      for (let hi = 0; hi <= 1; hi += 0.25) {
        const { layers } = recedeFrame([lo, hi])
        const total = layers[0].scrim + layers[1].scrim
        // Never past the token: the sum of the shares is at most 1 …
        expect(total).toBeLessThanOrEqual(1 + 1e-9)
        // … and with the lower sheet at its detent it is exactly one scrim's worth.
        if (lo === 1) expect(total).toBeCloseTo(1)
      }
    }
    const [lower, upper] = recedeFrame([1, 0.5]).layers
    expect(lower.scrim).toBeCloseTo(0.5)
    expect(upper.scrim).toBeCloseTo(0.5)
  })

  it('given the token alpha, the handover is exact: the compound dim over the page never breathes', () => {
    for (const a of [0.4, 0.55]) {
      // A second sheet stacking over one at its detent, and one sheet leaving as the next
      // arrives (the menu's row opening a picker): the page stays at the token throughout.
      for (let hi = 0; hi <= 1; hi += 0.05) {
        for (const lo of [1, 1 - hi]) {
          const { layers } = recedeFrame([lo, hi], a)
          expect(layers[1].scrim).toBeCloseTo(hi)
          expect(compound(layers, a)).toBeCloseTo(a, 9)
          // The linear rule would have let it lighten by up to a quarter of the alpha squared.
          const linear = 1 - (1 - a * hi) * (1 - a * lo * (1 - hi))
          if (hi > 0 && hi < 1 && lo === 1) expect(linear).toBeLessThan(a - 1e-6)
        }
      }
      // In general: the token times the summed presence, capped at one full scrim.
      for (let lo = 0; lo <= 1; lo += 0.25) {
        for (let hi = 0; hi <= 1; hi += 0.25) {
          const { layers } = recedeFrame([lo, hi], a)
          expect(compound(layers, a)).toBeCloseTo(a * Math.min(1, lo + hi), 9)
          for (const l of layers) {
            expect(l.scrim).toBeGreaterThanOrEqual(0)
            expect(l.scrim).toBeLessThanOrEqual(1 + 1e-9)
          }
        }
      }
      // Three deep too.
      expect(compound(recedeFrame([1, 0.4, 0.9], a).layers, a)).toBeCloseTo(a, 9)
    }
    // Without an alpha the rule is the plain difference: the linear handover for a lower sheet
    // at its detent, and nothing to hand over for a sheet a taller one already dims past.
    expect(recedeFrame([1, 0.3]).layers[0].scrim).toBeCloseTo(0.7)
    expect(recedeFrame([0.5, 0.5]).layers[0].scrim).toBeCloseTo(0.5)
    expect(recedeFrame([0.5, 0.8]).layers[0].scrim).toBeCloseTo(0.2)
  })

  it('as the upper sheet leaves, the lower one comes back and the page stays', () => {
    for (const hi of [1, 0.7, 0.3, 0]) {
      const frame = recedeFrame([1, hi])
      expect(frame.page).toBe(1)
      expect(frame.layers[0].recede).toBe(hi)
    }
  })

  it('three deep, the middle sheet recedes by the top one and the bottom by the most present above it', () => {
    const { page, layers } = recedeFrame([1, 0.4, 0.9])
    expect(page).toBe(1)
    expect(layers[0].recede).toBe(0.9)
    expect(layers[1].recede).toBe(0.9)
    expect(layers[2].recede).toBe(0)
    expect(layers.map((l) => l.inert)).toEqual([true, true, false])
  })
})

describe('the registry', () => {
  it('writes the page recede to the root while a layer is registered, and clears it after', () => {
    expect(root().dataset.receding).toBeUndefined()
    expect(recedeVar()).toBe('')
    const h = layer()
    expect(root().dataset.receding).toBe('true')
    expect(recedeVar()).toBe('0.0000')
    expect(recedeDepth()).toBe(1)
    h.progress(0.5)
    expect(recedeVar()).toBe('0.5000')
    expect(pageRecede()).toBe(0.5)
    h.progress(1)
    expect(recedeVar()).toBe('1.0000')
    h.release()
    expect(root().dataset.receding).toBeUndefined()
    expect(recedeVar()).toBe('')
    expect(recedeDepth()).toBe(0)
    expect(pageRecede()).toBe(0)
  })

  it('a second layer registers above the first: the first is told it is under one, and recedes with it', () => {
    const lowerFrames: RecedeLayerFrame[] = []
    const lower = layer((f) => lowerFrames.push(f))
    lower.progress(1)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: false })

    const upper = layer()
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: true })
    upper.progress(0.5)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0.5, scrim: 0.5, inert: true })
    expect(recedeVar()).toBe('1.0000')
    upper.progress(1)
    expect(lowerFrames.at(-1)).toEqual({ recede: 1, scrim: 0, inert: true })

    upper.release()
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: false })
    expect(recedeVar()).toBe('1.0000')
  })

  it('reads the scrim token alpha off the root when a layer registers, for the exact handover', () => {
    root().style.setProperty('--zen-scrim-alpha', '0.4')
    try {
      const lowerFrames: RecedeLayerFrame[] = []
      const lower = layer((f) => lowerFrames.push(f))
      lower.progress(1)
      const upper = layer()
      upper.progress(0.5)
      // (1 − .4 s)(1 − .4 · .5) = 1 − .4  →  s = .5 / .8
      expect(lowerFrames.at(-1)!.scrim).toBeCloseTo(0.625)
      upper.progress(1)
      expect(lowerFrames.at(-1)!.scrim).toBe(0)
      upper.release()
      expect(lowerFrames.at(-1)!.scrim).toBe(1)
    } finally {
      root().style.removeProperty('--zen-scrim-alpha')
    }
  })

  it('tells a layer of its own frame only when it changes, and never of a sheet below it', () => {
    const lower = layer()
    lower.progress(1)
    const upperFrames = vi.fn()
    const upper = layer(upperFrames)
    expect(upperFrames).toHaveBeenCalledTimes(1)
    upper.progress(0.5)
    expect(upperFrames).toHaveBeenCalledTimes(2)
    upper.progress(0.5)
    expect(upperFrames).toHaveBeenCalledTimes(2)
    // The lower sheet moving changes nothing about the upper one.
    lower.progress(0.2)
    lower.progress(0.9)
    expect(upperFrames).toHaveBeenCalledTimes(2)
  })

  it('a released handle is inert: no progress, no second release', () => {
    const a = layer()
    const b = layer()
    a.release()
    a.release()
    a.progress(1)
    expect(recedeDepth()).toBe(1)
    expect(recedeVar()).toBe('0.0000')
    b.progress(0.3)
    expect(recedeVar()).toBe('0.3000')
  })

  it('the root value is the stack rule, clamped', () => {
    const a = layer()
    const b = layer()
    a.progress(1)
    b.progress(1)
    expect(recedeVar()).toBe('1.0000')
    a.progress(2)
    expect(recedeVar()).toBe('1.0000')
    b.release()
    a.release()
    expect(recedeVar()).toBe('')
  })
})
