// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The banner stack under the open tab overview (§9.33, matrix row A4; the Design Lead's ruling
 * (f) on #731: "any banner still posting to the stack on a touch host must count the overview
 * as a cover"). The surface's half of the rule: on a touch layout the message layer reads the
 * stage the way the band does (`cover.ts`, `overviewIsOpen()`: first dragging frame to close),
 * holds the clocks through `lib/ui.ts` (`coverBanners`) and folds the cards away by their edge
 * (`useMessageMotion` `hidden`): a card standing as the overview opens goes back up under the
 * toolbar, inert, and comes down when it closes with its clock resumed; one arriving while the
 * overview is open waits at the edge and comes in on close with its full time. The desktop
 * never covers. The model's half (clocks alone) is lib/__tests__/bannerCover.test.ts.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { MessageLayer } = await import('../MessageLayer')
const { bannerStackCovered } = await import('../cover')
const { MESSAGE_INSET } = await import('../stack')
const { bannersCoveredNow, coverBandStore, showBanner, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { viewportStore } = await import('@renderer/lib/formFactor')

const HEIGHT = 44
const DURATION = 4000
const CLOSED: OverviewState = { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
const OPEN: OverviewState = { phase: 'open', progress: 1, heroTabId: 't1', target: 1 }
const DRAGGING: OverviewState = { phase: 'dragging', progress: 0.1, heroTabId: 't1', target: 1 }

let root: Root | null = null
let host: HTMLDivElement | null = null
let frames: Array<(t: number) => void> = []
let reduced = false
let clock = 0
const viewport = viewportStore.get()

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  reduced = false
  clock = performance.now()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  window.matchMedia = (() => ({
    get matches() {
      return reduced
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => HEIGHT
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 360
  })
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  coverBandStore.set({ top: 0, bottom: 0 })
  stageStore.set({ overview: CLOSED })
  viewportStore.set({ ...viewport, formFactor: 'phone' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  stageStore.set({ overview: CLOSED })
  viewportStore.set(viewport)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  vi.useRealTimers()
})

const mount = (): void => {
  act(() => root!.render(createElement(MessageLayer)))
}

/** Let the springs run: `n` frames of 16 ms on the chrome's animation clock. */
const run = (n = 150): void => {
  act(() => {
    for (let i = 0; i < n; i++) {
      const batch = frames.splice(0)
      if (batch.length === 0) break
      clock = Math.max(clock, performance.now()) + 16
      for (const cb of batch) cb(clock)
      vi.advanceTimersByTime(16)
    }
  })
}

const overview = (state: OverviewState): void => {
  act(() => stageStore.set({ overview: state }))
}

const card = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>('.zen-banner')
  if (!el) throw new Error('no banner card')
  return el
}
const stack = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>('.zen-message-stack')
  if (!el) throw new Error('no banner stack')
  return el
}
const live = (): number[] =>
  uiStore
    .get()
    .banners.filter((b) => !b.leaving)
    .map((b) => b.id)
/** The transform's y, in px. */
const y = (el: HTMLElement): number => {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform)
  if (!m) throw new Error(`no transform: ${el.style.transform}`)
  return Number(m[2])
}
/** A banner's edge: a card's length above its slot, plus the inset (`useMessageMotion` `reach`). */
const EDGE = -(HEIGHT + MESSAGE_INSET)

describe('the reading', () => {
  it('is the band’s: a touch layout with the overview anywhere but closed, from its first dragging frame', () => {
    expect(bannerStackCovered()).toBe(false)
    for (const phase of ['dragging', 'settling', 'open'] as const) {
      stageStore.set({ overview: { ...OPEN, phase } })
      expect(bannerStackCovered()).toBe(true)
    }
    stageStore.set({ overview: CLOSED })
    expect(bannerStackCovered()).toBe(false)
    viewportStore.set({ ...viewport, formFactor: 'tablet' })
    stageStore.set({ overview: OPEN })
    expect(bannerStackCovered()).toBe(true)
  })

  it('never reads true on the desktop, whatever the stage says', () => {
    viewportStore.set({ ...viewport, formFactor: 'desktop' })
    stageStore.set({ overview: OPEN })
    expect(bannerStackCovered()).toBe(false)
  })
})

describe('a banner standing as the overview opens', () => {
  it('folds back up under the toolbar, inert, with its clock paused, and comes down on close with the clock resumed', () => {
    mount()
    let id = 0
    act(() => {
      id = showBanner({ title: 'Show Reader View?', duration: DURATION })
    })
    const shownAt = Date.now()
    run()
    expect(y(card())).toBe(0)
    expect(card().dataset.covered).toBeUndefined()
    expect(card().hasAttribute('inert')).toBe(false)
    const strip = coverBandStore.get().top
    expect(strip).toBeGreaterThan(0)
    act(() => vi.advanceTimersByTime(1500))

    overview(DRAGGING)
    // What the clock ran before the cover: the arrival's frames and the 1.5 s after them.
    const spent = Date.now() - shownAt
    expect(spent).toBeLessThan(DURATION - 1000)
    expect(bannersCoveredNow()).toBe(true)
    expect(card().dataset.covered).toBe('')
    expect(card().hasAttribute('inert')).toBe(true)
    run()
    expect(y(card())).toBeCloseTo(EDGE, 0)
    expect(card().style.opacity).toBe('0.000')
    expect(stack().style.getPropertyValue('--zen-uncover')).toBe('1.000')
    // The strip the stack reports stays: the page under the overview is not laid out again.
    expect(coverBandStore.get().top).toBe(strip)
    // The clock is paused for as long as the overview stands.
    act(() => vi.advanceTimersByTime(60_000))
    expect(live()).toEqual([id])

    overview({ ...OPEN, phase: 'settling', target: 0 })
    expect(bannersCoveredNow()).toBe(true)
    overview(CLOSED)
    const closedAt = Date.now()
    expect(bannersCoveredNow()).toBe(false)
    expect(card().dataset.covered).toBeUndefined()
    expect(card().hasAttribute('inert')).toBe(false)
    run()
    expect(y(card())).toBeCloseTo(0, 0)
    expect(card().style.opacity).toBe('')
    expect(stack().style.getPropertyValue('--zen-uncover')).toBe('0.000')
    // What was left of the clock runs on from the close (the spring's frames count).
    act(() => vi.advanceTimersByTime(DURATION - spent - (Date.now() - closedAt) - 1))
    expect(live()).toEqual([id])
    act(() => vi.advanceTimersByTime(1))
    expect(live()).toEqual([])
  })

  it('with motion reduced fades in place and back, in its slot', () => {
    reduced = true
    mount()
    act(() => {
      showBanner({ title: 'Translate this page?', duration: DURATION })
    })
    run()
    expect(y(card())).toBe(0)
    overview(OPEN)
    expect(card().dataset.covered).toBe('')
    run()
    expect(y(card())).toBe(0)
    expect(card().style.opacity).toBe('0.000')
    overview(CLOSED)
    run()
    expect(y(card())).toBe(0)
    expect(card().style.opacity).toBe('')
  })
})

describe('a banner arriving while the overview is open', () => {
  it('waits at its edge, inert and unseen, and comes in on close with its full time', () => {
    mount()
    overview(OPEN)
    let id = 0
    act(() => {
      id = showBanner({ title: 'Show Reader View?', duration: DURATION })
    })
    expect(card().dataset.covered).toBe('')
    expect(card().hasAttribute('inert')).toBe(true)
    expect(y(card())).toBe(EDGE)
    expect(card().style.opacity).toBe('0.000')
    expect(stack().style.getPropertyValue('--zen-uncover')).toBe('1.000')
    run()
    expect(y(card())).toBe(EDGE)
    // Its strip is reported at once: the page comes out from under the overview laid out for it.
    expect(coverBandStore.get().top).toBeGreaterThan(0)
    act(() => vi.advanceTimersByTime(60_000))
    expect(live()).toEqual([id])

    overview(CLOSED)
    const closedAt = Date.now()
    expect(card().dataset.covered).toBeUndefined()
    expect(card().hasAttribute('inert')).toBe(false)
    run()
    expect(y(card())).toBeCloseTo(0, 0)
    expect(card().style.opacity).toBe('')
    expect(stack().style.getPropertyValue('--zen-uncover')).toBe('0.000')
    act(() => vi.advanceTimersByTime(DURATION - (Date.now() - closedAt) - 1))
    expect(live()).toEqual([id])
    act(() => vi.advanceTimersByTime(1))
    expect(live()).toEqual([])
  })

  it('is dismissed under the cover like any other: it goes from its edge and is forgotten', () => {
    mount()
    overview(OPEN)
    act(() => {
      showBanner({ title: 'One', key: 'k' })
    })
    act(() => {
      showBanner({ title: 'Two', key: 'k' })
    })
    run()
    expect(uiStore.get().banners.map((b) => b.title)).toEqual(['Two'])
    expect(host!.querySelectorAll('.zen-banner')).toHaveLength(1)
    expect(card().textContent).toContain('Two')
  })

  it('the layer leaving (a layout flip) lifts the cover it set', () => {
    mount()
    overview(OPEN)
    act(() => {
      showBanner({ title: 'Held', duration: DURATION })
    })
    expect(bannersCoveredNow()).toBe(true)
    act(() => root!.unmount())
    expect(bannersCoveredNow()).toBe(false)
  })
})

describe('the desktop', () => {
  it('is what it was: no cover, whatever the stage store says', () => {
    viewportStore.set({ ...viewport, formFactor: 'desktop' })
    mount()
    overview(OPEN)
    let id = 0
    act(() => {
      id = showBanner({ title: 'Install Zenium?', duration: DURATION })
    })
    const shownAt = Date.now()
    expect(bannersCoveredNow()).toBe(false)
    expect(card().dataset.covered).toBeUndefined()
    expect(card().hasAttribute('inert')).toBe(false)
    run()
    expect(y(card())).toBeCloseTo(0, 0)
    act(() => vi.advanceTimersByTime(DURATION - (Date.now() - shownAt) - 1))
    expect(live()).toEqual([id])
    act(() => vi.advanceTimersByTime(1))
    expect(live()).toEqual([])
  })
})

describe('the harness door', () => {
  it('is showBanner itself (src/android/main.tsx), so a driver’s banner meets the same cover', () => {
    const main = readFileSync(resolve('src/android/main.tsx'), 'utf8')
    expect(main).toMatch(/__zenMessages:\s*\{\s*pushToast,\s*showBanner,\s*dismissBanner,/)
  })
})
