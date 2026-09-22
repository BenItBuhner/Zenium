// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  barFade,
  pageRecede,
  RECEDE_RADIUS_PX,
  RECEDE_SCALE,
  recedeDepth,
  recedeFade,
  recedeFrame,
  recedeScale,
  registerRecedeLayer,
  registerRecedeSurface,
  subscribePageRecede,
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

/*
 * The phone bar docked at the bottom edge – where the sheet arrives – fades with the sheet
 * (§11.1): its opacity is `1 − p` from the root's `--zen-recede`, by the stylesheet at rest and
 * by `recedeFade` wherever a component writes the bar's opacity itself (the pill carry between
 * the edges), so nothing inline ever holds the bar at 1 over a receded page – the review of
 * #168 measured the bar at 1 at p = 1 for exactly that. A bar docked at the top is not in the
 * sheet's path and does not fade: it stays at 1, inert and dimmed by the scrim like the page
 * (ruled 23:50) – the stylesheet's rule names the edge, and `barFade` composes the recede into a
 * carry's fade at the bottom edge only.
 */
describe('the bar fade (§11.1): the bottom-docked bar, and only that one', () => {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
  /** The stylesheet's declarations for a selector, whitespace folded (main.css is not loaded here). */
  const cssRule = (selector: string): string => {
    const folded = css.replace(/\s+/g, ' ')
    const at = folded.indexOf(`${selector} {`)
    expect(at, `a rule for ${selector}`).toBeGreaterThan(-1)
    return folded.slice(at, folded.indexOf('}', at))
  }

  it('the stylesheet fades the bar by the root value at the bottom edge, and writes no opacity for the bar at the top', () => {
    const rule = cssRule(":root[data-form-factor='phone'] .zen-phone-bar[data-edge='bottom']")
    expect(rule).toContain('opacity: calc(1 - var(--zen-recede, 0) * var(--zen-recede-gain, 1))')
    // No other rule of the bar's writes an opacity: not one for the top edge, not one without
    // an edge that a top-docked bar would take. The hide on scroll (lib/barHide.ts) slides the
    // bar at either edge – its transform alone, the clip being its parent box's (#270) – and
    // fades nothing: the fade is the sheet's vocabulary. The one other fade is the new tab page's
    // field landing in the bar's band (NTP-02, `data-fakebox` on the root, lib/fakeboxMorph.ts):
    // the omnibox takes the band at either edge, so the bar's buttons go under the arriving
    // field – not a sheet's recede – and those rules apply only while the morph owns the bar; at
    // the bottom edge they compose the recede in. The pill's own focus motion (MOT-07,
    // `data-omnibox-focus` on the root, lib/omniboxFocus.ts) fades the bar's BUTTONS as the
    // field pushes them off – rules on the items inside the bar, never on the bar, so the bar's
    // own recede still multiplies in at the bottom edge and none of them names an edge.
    const barRules = [...css.matchAll(/[^{}]*\.zen-phone-bar[^{}]*\{[^}]*\}/g)].map((m) => m[0])
    expect(barRules.length).toBeGreaterThan(1)
    const fading = barRules.filter((r) => /opacity\s*:/.test(r))
    const morph = fading.filter((r) => r.includes('data-fakebox'))
    expect(morph.length).toBeGreaterThan(0)
    for (const r of morph) {
      expect(r).toContain('--zen-ntp-morph')
      if (r.includes("[data-edge='bottom']")) expect(r).toContain('--zen-recede')
      else expect(r).not.toContain("[data-edge='top']")
    }
    const focus = fading.filter((r) => r.includes('data-omnibox-focus'))
    expect(focus.length).toBeGreaterThan(0)
    for (const r of focus) {
      expect(r).toContain('--zen-omnibox-focus')
      expect(r).not.toContain('data-edge')
      const head = r.slice(0, r.indexOf('{'))
      const selectors = head.slice(head.lastIndexOf('*/') + 2)
      for (const selector of selectors.split(',')) {
        expect(selector.trim()).toMatch(/\.zen-phone-bar-row > \[data-bar-item\]/)
      }
    }
    const recedes = fading.filter(
      (r) => !r.includes('data-fakebox') && !r.includes('data-omnibox-focus')
    )
    expect(recedes).toHaveLength(1)
    expect(recedes[0]).toContain("[data-edge='bottom']")
    expect(recedes[0]).not.toContain('--zen-bar-hide')
    const hiding = barRules.filter((r) => /var\(--zen-bar-hide\)/.test(r))
    expect(hiding).toHaveLength(2)
    for (const r of hiding) {
      expect(r).toMatch(/transform\s*:/)
      expect(r).not.toMatch(/clip-path\s*:/)
      expect(r).not.toMatch(/opacity\s*:/)
    }
  })

  it('barFade composes the recede into a fade of the bar’s own at the bottom edge, and at the top edge writes the share alone', () => {
    expect(barFade('bottom', 0.25)).toBe(recedeFade(0.25))
    expect(barFade('bottom', 1)).toBe(recedeFade(1))
    expect(barFade('top', 0.25)).toBe('0.2500')
    expect(barFade('top', 1)).toBe('1.0000')
    expect(barFade('top', 1.7)).toBe('1.0000')
    expect(barFade('top', -1)).toBe('0.0000')
    expect(barFade('top', 0.5)).not.toContain('--zen-recede')
  })

  it('recedeFade composes a fade of the element’s own into the same product, clamped, and is 1 − recede alone by default', () => {
    expect(recedeFade()).toBe(
      'calc((1 - var(--zen-recede, 0) * var(--zen-recede-gain, 1)) * 1.0000)'
    )
    expect(recedeFade(0.25)).toBe(
      'calc((1 - var(--zen-recede, 0) * var(--zen-recede-gain, 1)) * 0.2500)'
    )
    expect(recedeFade(0)).toContain('* 0.0000)')
    expect(recedeFade(1.7)).toContain('* 1.0000)')
    expect(recedeFade(-2)).toContain('* 0.0000)')
    // Never a bare number: a number written inline would beat the stylesheet's rule.
    for (const share of [0, 0.5, 1]) expect(Number.isNaN(Number(recedeFade(share)))).toBe(true)
  })
})

describe('recedeFrame: the stack rule (§11.2, §9.24)', () => {
  it('a second sheet does not push the page further', () => {
    expect(recedeFrame([1, 1]).page).toBe(1)
    expect(recedeFrame([1, 0.5]).page).toBe(1)
    expect(recedeFrame([0.3, 1]).page).toBe(1)
    // The page recedes by the stack's summed presence, capped at one sheet's worth – the
    // number the compound dim keeps (below), so the page and its dim never part: two sheets
    // showing part of themselves recede it by both, never past 1.
    expect(recedeFrame([0.3, 0.6]).page).toBeCloseTo(0.9)
    expect(recedeFrame([0.6, 0.6]).page).toBe(1)
  })

  it('a lower sheet leaving as the next arrives (a menu popping over an open one) holds the page and the dim together (§11.1, §11.2)', () => {
    // The leaving sheet runs p 1 → 0 while the new one runs q 0 → 1: with the two together at a
    // sheet's worth the page holds receded, and where they fall short the page comes back by
    // exactly what the dim lightens – the same capped sum – never by the larger of the two alone
    // (which would let the page breathe half-way while the dim stayed).
    for (let q = 0; q <= 1; q += 0.1) {
      const p = 1 - q
      const { page, layers } = recedeFrame([p, q], 0.4)
      expect(page).toBeCloseTo(1)
      expect(compound(layers, 0.4)).toBeCloseTo(0.4, 9)
      // The leaving sheet is receded by the one above it and inert from its first frame.
      expect(layers[0].recede).toBeCloseTo(q)
      expect(layers[0].inert).toBe(q > 0)
    }
    // The leave outrunning the arrival (the dismissal spring is the snappier one): page and dim
    // fall back by the same share.
    const { page, layers } = recedeFrame([0.2, 0.5], 0.4)
    expect(page).toBeCloseTo(0.7)
    expect(compound(layers, 0.4)).toBeCloseTo(0.4 * 0.7, 9)
  })

  it('the lower sheet recedes by the presence of the sheet above it, inert from q > 0 (§11.2)', () => {
    const [lower, upper] = recedeFrame([1, 0.5]).layers
    expect(lower.recede).toBe(0.5)
    expect(lower.inert).toBe(true)
    expect(upper.recede).toBe(0)
    expect(upper.inert).toBe(false)
    // Registered above but showing nothing yet (held for the page's cover): the lower content
    // stays live, receded not at all – it goes inert with the upper sheet's first frame.
    const [under, over] = recedeFrame([1, 0]).layers
    expect(under).toEqual({ recede: 0, scrim: 1, inert: false })
    expect(over).toEqual({ recede: 0, scrim: 0, inert: false })
    expect(recedeFrame([1, 0.001]).layers[0].inert).toBe(true)
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

  it('three deep, the middle sheet recedes by the top one and the bottom by the summed presence above it, capped', () => {
    const { page, layers } = recedeFrame([1, 0.4, 0.9])
    expect(page).toBe(1)
    // The two above the bottom sheet stand at more than a sheet's worth together: it is receded
    // in full (the number their scrims compound to over it); the middle by the top one alone.
    expect(layers[0].recede).toBe(1)
    expect(layers[1].recede).toBe(0.9)
    expect(layers[2].recede).toBe(0)
    expect(recedeFrame([1, 0.4, 0.3]).layers[0].recede).toBeCloseTo(0.7)
    expect(layers.map((l) => l.inert)).toEqual([true, true, false])
    // The top one still held at 0: the middle sheet is live, the bottom inert under the middle.
    expect(recedeFrame([1, 0.4, 0]).layers.map((l) => l.inert)).toEqual([true, false, false])
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

  it('a second layer registers above the first: the first is told it is under one once that shows, and recedes with it', () => {
    const lowerFrames: RecedeLayerFrame[] = []
    const lower = layer((f) => lowerFrames.push(f))
    lower.progress(1)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: false })
    expect(lower.onTop()).toBe(true)

    const upper = layer()
    // Registered above, nothing of it showing yet: the lower is no longer on top (the focus and
    // the keyboard are the upper one's), its content still live (§11.2: inert from q > 0).
    expect(lower.onTop()).toBe(false)
    expect(upper.onTop()).toBe(true)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: false })
    upper.progress(0.01)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0.01, scrim: 0.99, inert: true })
    upper.progress(0.5)
    expect(lowerFrames.at(-1)).toEqual({ recede: 0.5, scrim: 0.5, inert: true })
    expect(recedeVar()).toBe('1.0000')
    upper.progress(1)
    expect(lowerFrames.at(-1)).toEqual({ recede: 1, scrim: 0, inert: true })

    upper.release()
    expect(lowerFrames.at(-1)).toEqual({ recede: 0, scrim: 1, inert: false })
    expect(lower.onTop()).toBe(true)
    expect(upper.onTop()).toBe(false)
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

  it('sets the root attribute once, not per frame: a frame that changes only the value touches only the value', async () => {
    const h = layer()
    const attributes: string[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.attributeName) attributes.push(r.attributeName)
    })
    observer.observe(root(), { attributes: true })
    h.progress(0.25)
    h.progress(0.5)
    h.progress(0.75)
    // Flush the observer (records are delivered as microtasks).
    await Promise.resolve()
    observer.disconnect()
    // Setting an attribute to what it already is still counts as a change to the style
    // invalidator and the accessibility tree: `data-receding` is touched on the first and the
    // last frame only.
    expect(attributes.filter((a) => a === 'data-receding')).toEqual([])
  })

  it('tells a subscriber the page recede as it changes, 0 once more at the rest, after the surfaces carry it (the layout reporter’s re-measure)', () => {
    const surface = document.createElement('div')
    const release = registerRecedeSurface(surface)
    const heard: Array<{ page: number; surface: string }> = []
    const unsubscribe = subscribePageRecede((page) =>
      heard.push({ page, surface: surface.style.getPropertyValue('--zen-recede') })
    )
    const h = layer()
    // Registering at presence 0 changes nothing the subscriber cares about.
    expect(heard).toEqual([])
    h.progress(0.5)
    h.progress(0.5)
    h.progress(1)
    // The frame's landing away, then the layer's release: 0 is heard once, when the value lands.
    h.progress(0)
    h.release()
    expect(heard).toEqual([
      { page: 0.5, surface: '0.5000' },
      { page: 1, surface: '1.0000' },
      { page: 0, surface: '0.0000' }
    ])
    // A stack that empties from a receded frame: 0 heard at the release.
    const g = layer()
    g.progress(1)
    g.release()
    expect(heard.slice(3)).toEqual([
      { page: 1, surface: '1.0000' },
      { page: 0, surface: '' }
    ])
    unsubscribe()
    const k = layer()
    k.progress(1)
    k.release()
    expect(heard).toHaveLength(5)
    release()
  })
})

/*
 * Where the value goes (PERF-2, PR #269). Written every frame on the root as an inherited
 * custom property, `--zen-recede` had the whole chrome document's style recalculated every
 * frame of a sheet's motion: 5 ms of style per frame of the menu's open and 9 to 11 ms of its
 * close on the emulator, 1 ms with that write muted. So main.css registers it non-inheriting,
 * the root keeps the one readable number, and each surface a rule reads it on takes the same
 * value on its own inline style: registered by its component (`registerRecedeSurface`), or
 * tagged `data-recede-surface` and found when a sheet registers.
 */
describe('the surfaces', () => {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

  it('a registered surface carries the value from registration, every frame, and drops it on release', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    try {
      const release = registerRecedeSurface(el)
      // No sheet: nothing written (the property's initial 0 stands).
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      const h = layer()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.0000')
      h.progress(0.5)
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.5000')
      expect(recedeVar()).toBe('0.5000')
      release()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      h.progress(0.75)
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      // A release is idempotent.
      release()
    } finally {
      el.remove()
    }
  })

  it('a surface registering under a sheet already up takes the current value at once, and loses it when the stack empties', () => {
    const h = layer()
    h.progress(0.8)
    const el = document.createElement('div')
    document.body.appendChild(el)
    try {
      const release = registerRecedeSurface(el)
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.8000')
      h.release()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      release()
    } finally {
      el.remove()
    }
  })

  it('an element tagged data-recede-surface is found when a sheet registers and written like a registered one', () => {
    const el = document.createElement('div')
    el.setAttribute('data-recede-surface', '')
    document.body.appendChild(el)
    try {
      const h = layer()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.0000')
      h.progress(0.3)
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.3000')
      h.release()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      // Tagged and registered both: written once per frame, dropped once.
      const release = registerRecedeSurface(el)
      const again = layer()
      again.progress(0.6)
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.6000')
      release()
      expect(el.style.getPropertyValue('--zen-recede')).toBe('')
      again.progress(0.7)
      // Still tagged: the tag keeps it on the stack's list until the stack empties.
      expect(el.style.getPropertyValue('--zen-recede')).toBe('0.7000')
    } finally {
      el.remove()
    }
  })

  it('the stylesheet registers the per-frame values non-inheriting, the recede with an initial 0', () => {
    const folded = css.replace(/\s+/g, ' ')
    expect(folded).toContain(
      "@property --zen-recede { syntax: '<number>'; inherits: false; initial-value: 0; }"
    )
    expect(folded).toContain(
      "@property --zen-layer-recede { syntax: '<number>'; inherits: false; initial-value: 0; }"
    )
    expect(folded).toMatch(/@property --zen-layer-scale \{ syntax: '\*'; inherits: false; \}/)
    expect(folded).toMatch(/@property --zen-layer-radius \{ syntax: '\*'; inherits: false; \}/)
  })

  // Which elements the stylesheets read the value on, and that each is registered by its
  // component (or tagged), is `recedeSurfaces.test.ts`'s: derived from the stylesheets and paired
  // over the components' source, so a new reader without its `useRecedeSurface`, or a component
  // dropping its hook, fails there. The hook's runtime is `hooks/__tests__/useRecedeSurface.test.tsx`'s.
})
