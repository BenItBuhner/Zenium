// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import { chromeGutter } from '@renderer/hooks/useTheme'
import {
  barHideStore,
  bindBarHide,
  dispatchBarNavigation,
  dispatchBarScroll,
  resetBarHide,
  setBarHideContext,
  setBarHideHost,
  setBarHideTouchExploration,
  showBar,
  type BarHideHostFrame
} from '@renderer/lib/barHide'
import { browserStore, contentAreaStore, uiStore } from '@renderer/lib/ui'

/*
 * What the bar that hides on scroll publishes for every other surface (v2 draft §11.5; the tab
 * group strip rides it): `--zen-bar-hide` on the elements bound to it (`bindBarHide`: the bar,
 * the message cards on its edge), 0 shown … 1 hidden per frame; `data-bar-away` on the root
 * while the bar is off its shown rest at all; `data-bar-hidden` on the root and
 * `uiStore.barHidden` at the hidden rest; and `barHideStore` for the chrome's own code. They
 * are written from one value in `lib/barHide.ts`; this pins down that they agree at every point
 * of a gesture, that the boolean the content column lays out by flips at the two rests and
 * never on a touch or a fling that leaves the bar where it is (the bar hide profile, #270), and
 * that the host hears the frame the page's edge should take, with the gate closing on a sheet
 * and on the omnibox and a TalkBack focus bringing the bar back.
 */

const tab = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: 'https://example.com/long',
  title: 'Example',
  loading: false
} as unknown as Tab

const space = {
  id: 'space',
  name: 'Work',
  containerId: 'default',
  tabIds: ['t1'],
  activeTabId: 't1'
} as unknown as Space

function state(edge: 'top' | 'bottom', url = tab.url): UIState {
  return {
    platform: 'android',
    tabs: { t1: { ...tab, url } },
    spaces: [space],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: [],
    settings: { ...DEFAULT_SETTINGS, phoneBarPosition: edge },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

const root = (): HTMLElement => document.documentElement
/** The bar element of the test, bound to the progress as the shell's bar is. */
let bar: HTMLElement
const barVar = (el: HTMLElement = bar): number =>
  Number(el.style.getPropertyValue('--zen-bar-hide') || 0)
/** What #200 wrote per frame on the root: never, now (the whole chrome's style recalculated). */
const rootVar = (): string => root().style.getPropertyValue('--zen-bar-hide')

/**
 * The bound element's variable, the root's attributes, the store and the boolean read from one
 * value. The boolean is a position, not a phase: hidden only with the bar at its full travel,
 * and always hidden once it rests there – a finger landing on the hidden bar (dragging at the
 * full travel) leaves it hidden, and a bar dragged to the far end but not yet released is not.
 */
function expectAgreement(): void {
  const s = barHideStore.get()
  expect(barVar()).toBeCloseTo(s.progress, 3)
  expect(rootVar()).toBe('')
  expect(root().dataset.barAway === 'true').toBe(s.progress > 0)
  const hidden = uiStore.get().barHidden
  expect(root().dataset.barHidden === 'true').toBe(hidden)
  if (hidden) expect(s.progress).toBe(1)
  if (s.phase === 'rest' && s.progress >= 1) expect(hidden).toBe(true)
  if (s.progress < 1) expect(hidden).toBe(false)
}

describe('the published hide progress', () => {
  let frames: Array<(now: number) => void>
  let now: number
  let hostFrames: Array<BarHideHostFrame | null>
  let unbind: () => void

  const settle = (max = 600): void => {
    for (let i = 0; i < max && frames.length; i++) {
      now += 16
      const batch = frames
      frames = []
      for (const frame of batch) frame(now)
    }
  }

  const scroll = (deltas: number[], edge = 'bottom' as 'top' | 'bottom'): void => {
    void edge
    dispatchBarScroll('t1', 'start', null)
    for (const delta of deltas) {
      now += 100
      dispatchBarScroll('t1', 'move', { delta, time: now })
    }
  }

  beforeEach(() => {
    frames = []
    now = 1000
    hostFrames = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    Object.defineProperty(window, 'innerHeight', { value: 915, configurable: true })
    browserStore.set({ state: state('bottom') })
    uiStore.set({ insets: { top: 24, right: 0, bottom: 20, left: 0 } })
    setBarHideHost({ apply: (frame) => hostFrames.push(frame) })
    setBarHideContext({ edge: 'bottom', present: true, band: 56, gutter: 8 })
    bar = document.createElement('nav')
    unbind = bindBarHide(bar)
  })

  afterEach(() => {
    unbind()
    resetBarHide()
    setBarHideTouchExploration(false)
    setBarHideContext({ present: false })
    setBarHideHost(null)
    contentAreaStore.set({ area: null })
    browserStore.set({ state: null })
    uiStore.set({
      urlbar: {
        open: false,
        mode: 'new-tab',
        tabId: null,
        initialText: undefined,
        attached: false
      },
      menu: null,
      insets: { top: 0, right: 0, bottom: 0, left: 0 }
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('the gate is open on a web page with the setting on, and the travel is the band less the gutter', () => {
    const s = barHideStore.get()
    expect(s.allowed).toBe(true)
    expect(s.travel).toBe(48)
    expect(s.edge).toBe('bottom')
    // The host hears where the page's edge is with the bar shown: the window less the inset and the band.
    expect(hostFrames[hostFrames.length - 1]).toEqual({
      edge: 'bottom',
      offset: 0,
      travel: 48,
      shownEdge: 915 - 20 - 56
    })
  })

  it('the tab group strip adds its share to the band and so to the travel; a bar off its edge keeps its ratio across the change (#202)', () => {
    // The strip enters with the bar shown: the travel is the whole band less the gutter.
    setBarHideContext({ band: 56 + 50 })
    expect(barHideStore.get().travel).toBe(98)
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({
      offset: 0,
      travel: 98,
      shownEdge: 915 - 20 - 106
    })
    // Hidden with the strip in the band: the strip is off the edge with the row.
    scroll([98])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(barHideStore.get()).toMatchObject({ progress: 1, phase: 'rest', travel: 98 })
    expect(uiStore.get().barHidden).toBe(true)
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 98, travel: 98 })
    // The strip leaves while the bar rests hidden (the active tab left its group): the bar keeps
    // its ratio – hidden stays hidden, the root value stays 1 – and the host hears the new travel
    // and the row-only edge; nothing springs.
    setBarHideContext({ band: 56 })
    expect(barHideStore.get()).toMatchObject({ progress: 1, phase: 'rest', travel: 48 })
    expect(barVar()).toBe(1)
    expect(uiStore.get().barHidden).toBe(true)
    expectAgreement()
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({
      offset: 48,
      travel: 48,
      shownEdge: 915 - 20 - 56
    })
    // Half way when the strip enters: half way still, of the longer travel.
    scroll([-24])
    expect(barVar()).toBeCloseTo(0.5, 3)
    setBarHideContext({ band: 106 })
    expect(barVar()).toBeCloseTo(0.5, 3)
    expect(barHideStore.get()).toMatchObject({ progress: 0.5, phase: 'dragging', travel: 98 })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 49, travel: 98 })
    expectAgreement()
  })

  it('the gutter the shell hands the machine is the theme’s rule for --zen-padding, not a read of the root', () => {
    // The theme writes `--zen-padding` from the app's effect, after the shell's own has run on
    // the first mount: a shell reading the root there would get the stylesheet's 8 and a travel
    // 2 px short of what the stylesheet and the content column move by (6 on a phone).
    expect(chromeGutter('phone', false)).toBe(6)
    expect(chromeGutter('phone', true)).toBe(0)
    expect(chromeGutter('desktop', false)).toBe(8)
  })

  it('the stylesheet slides the bar by the band less the gutter on a promoted layer, its transform alone, inside a clip box that does not move; the strip’s share in the band (#202)', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8').replace(
      /\s+/g,
      ' '
    )
    // The variable is the bar's own (`inherits: false`): a frame's write recalculates the bar's
    // style and nothing else's. The travel is the whole band (`--zen-phone-band`: the row plus
    // the strip's share, #202) less the gutter, the same distance the content column gives the
    // page at the hidden rest (`edgePadding`), so the strip is off the edge with the row and
    // the page gains the band.
    expect(css).toContain(
      "@property --zen-bar-hide { syntax: '<number>'; inherits: false; initial-value: 0; }"
    )
    expect(css).toContain(
      '--zen-bar-hide-travel: calc(var(--zen-phone-band) - var(--zen-padding));'
    )
    expect(css).not.toContain('--zen-bar-hide-shift')
    // The bar's frame: transform on a promoted layer, no clip of its own (a `clip-path` that grows
    // with the travel is a mask painted anew every frame it changes).
    expect(css).toContain(
      ":root[data-form-factor='phone'] .zen-phone-bar { pointer-events: auto; will-change: transform; }"
    )
    expect(css).toContain(
      ".zen-phone-bar[data-edge='bottom'] { transform: translate3d(0, calc(var(--zen-bar-hide) * var(--zen-bar-hide-travel)), 0); }"
    )
    expect(css).toContain(
      ".zen-phone-bar[data-edge='top'] { transform: translate3d(0, calc(-1 * var(--zen-bar-hide) * var(--zen-bar-hide-travel)), 0); }"
    )
    expect(css).not.toMatch(/\.zen-phone-bar\[data-edge='(bottom|top)'\] \{[^}]*clip-path/)
    // The clip is the parent box's: from the inset line to the window's far edge, static.
    expect(css).toContain(
      ".zen-phone-bar-clip[data-edge='bottom'] { top: 0; bottom: var(--zen-inset-bottom); }"
    )
    expect(css).toContain(
      ".zen-phone-bar-clip[data-edge='top'] { top: var(--zen-inset-top); bottom: 0; }"
    )
    expect(css).toMatch(/\.zen-phone-bar-clip \{[^}]*overflow: clip;/)
    // The message frame's two boxes, and the cards on the bar's edge riding by transform.
    expect(css).toContain(
      ".zen-message-frame[data-edge='bottom'] { top: calc(var(--zen-inset-top) + var(--zen-padding)); bottom: calc(var(--zen-inset-bottom) + var(--zen-phone-band)); }"
    )
    expect(css).toContain(
      "[data-bar-away] .zen-message-frame[data-edge='bottom'] { bottom: calc(var(--zen-inset-bottom) + var(--zen-padding)); }"
    )
    expect(css).toContain(
      "[data-bar-away] .zen-message-frame[data-edge='bottom'] .zen-message-toasts { transform: translate3d(0, calc((var(--zen-bar-hide) - 1) * var(--zen-bar-hide-travel)), 0); }"
    )
    expect(css).toContain(
      "[data-bar-away] .zen-message-frame[data-edge='top'] .zen-message-stack { transform: translate3d(0, calc((1 - var(--zen-bar-hide)) * var(--zen-bar-hide-travel)), 0); }"
    )
  })

  it('the bound element’s variable, the root’s attributes, the store and the boolean agree at every point of a scroll and its snap', () => {
    scroll([12, 12])
    expect(barVar()).toBeCloseTo(0.5, 3)
    expect(barHideStore.get()).toMatchObject({ progress: 0.5, phase: 'dragging' })
    expect(uiStore.get().barHidden).toBe(false)
    // Off the shown rest: the message frame has the page's tall box for the gesture.
    expect(root().dataset.barAway).toBe('true')
    expectAgreement()
    // The host is told the offset per frame.
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 24, travel: 48 })

    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    expectAgreement()
    settle()
    expect(barVar()).toBe(1)
    expect(barHideStore.get()).toMatchObject({ progress: 1, phase: 'rest' })
    expect(uiStore.get().barHidden).toBe(true)
    expect(root().dataset.barHidden).toBe('true')
    expectAgreement()
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 48 })

    // The first scroll back flips the boolean at once: the content column takes its shown layout
    // before the bar has come back, so the page returns under a frame already there for it.
    scroll([-6])
    expect(uiStore.get().barHidden).toBe(false)
    expect(root().dataset.barHidden).toBeUndefined()
    expect(barVar()).toBeCloseTo(42 / 48, 3)
    expectAgreement()
    // On past the commit line, slowly, and released: the bar snaps home, and at the shown rest
    // the frame's tall box goes with the attribute, the variable with it.
    for (let i = 0; i < 3; i++) {
      now += 100
      dispatchBarScroll('t1', 'move', { delta: -10, time: now })
    }
    expect(root().dataset.barAway).toBe('true')
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(barHideStore.get()).toMatchObject({ progress: 0, phase: 'rest' })
    expect(root().dataset.barAway).toBeUndefined()
    expect(bar.style.getPropertyValue('--zen-bar-hide')).toBe('')
    expectAgreement()
  })

  it('a finger landing on the hidden bar, and a fling passing under it, leave the boolean hidden: the column and the page are not laid out for a bar that has not moved (#270)', () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    const flips: boolean[] = []
    const unsubscribe = uiStore.subscribe(() => {
      const hidden = uiStore.get().barHidden
      if (flips[flips.length - 1] !== hidden) flips.push(hidden)
    })
    const columns = hostFrames.length
    // The attribute itself: a write of the value already there is a mutation all the same (the
    // stylesheet's `[data-bar-hidden]` rules are re-matched for it), so none may happen either.
    const attributeWrites = new MutationObserver(() => {})
    attributeWrites.observe(root(), { attributes: true, attributeFilter: ['data-bar-hidden'] })

    // A finger down on the page with the bar hidden (rest → dragging at the full travel).
    dispatchBarScroll('t1', 'start', null)
    expect(barHideStore.get().phase).toBe('dragging')
    expect(uiStore.get().barHidden).toBe(true)
    expect(root().dataset.barHidden).toBe('true')
    expectAgreement()
    // Scrolling on down the page: the bar is clamped at its travel, nothing changes.
    now += 100
    dispatchBarScroll('t1', 'move', { delta: 30, time: now })
    now += 100
    dispatchBarScroll('t1', 'move', { delta: 30, time: now })
    expect(barVar()).toBe(1)
    expect(uiStore.get().barHidden).toBe(true)
    // The lift, fast: the page flings on, the bar rides it (still at its travel) and settles
    // when the scroll has stopped for the gap (a timer: faked, so the gap can be run down).
    vi.useFakeTimers()
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    expect(barHideStore.get().phase).toBe('flinging')
    expect(uiStore.get().barHidden).toBe(true)
    for (let i = 0; i < 5; i++) {
      now += 16
      dispatchBarScroll('t1', 'move', { delta: 20, time: now })
    }
    expect(uiStore.get().barHidden).toBe(true)
    vi.advanceTimersByTime(200)
    vi.useRealTimers()
    expect(barHideStore.get().phase).toBe('rest')
    expect(uiStore.get().barHidden).toBe(true)
    expectAgreement()
    // Not one flip of the boolean, not one write of the attribute (the fling's landing at the
    // hidden rest is the second arrival there), and not one new frame for the host: the bar
    // never moved.
    expect(flips).toEqual([])
    expect(attributeWrites.takeRecords()).toEqual([])
    attributeWrites.disconnect()
    expect(hostFrames.length).toBe(columns)
    unsubscribe()

    // A bar dragged to the far end but not released is not hidden yet: the column waits for the rest.
    scroll([-10])
    expect(uiStore.get().barHidden).toBe(false)
    now += 100
    dispatchBarScroll('t1', 'move', { delta: 10, time: now })
    expect(barVar()).toBe(1)
    expect(barHideStore.get().phase).toBe('dragging')
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    expectAgreement()
  })

  it('an element bound mid-gesture carries the progress at once, every frame after, and nothing once unbound', () => {
    scroll([12])
    const toasts = document.createElement('div')
    const release = bindBarHide(toasts)
    expect(barVar(toasts)).toBeCloseTo(0.25, 3)
    now += 100
    dispatchBarScroll('t1', 'move', { delta: 12, time: now })
    expect(barVar(toasts)).toBeCloseTo(0.5, 3)
    expect(barVar()).toBeCloseTo(0.5, 3)
    release()
    expect(toasts.style.getPropertyValue('--zen-bar-hide')).toBe('')
    now += 100
    dispatchBarScroll('t1', 'move', { delta: 12, time: now })
    expect(toasts.style.getPropertyValue('--zen-bar-hide')).toBe('')
    expect(barVar()).toBeCloseTo(0.75, 3)
  })

  it('a cover over the page (a sheet, the omnibox) brings a hidden bottom bar back at once, under the recede, and closes the gate; a docked panel closes it on the spring', () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)

    // The recede fades the bottom bar as the sheet arrives (§11.1): the bar is back in place at
    // once, so no half-faded bar slides in under it.
    uiStore.set({ menu: { items: [] } as never })
    expect(barHideStore.get().allowed).toBe(false)
    expect(barHideStore.get().phase).toBe('rest')
    expect(barVar()).toBe(0)
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    expect(frames).toHaveLength(0)
    // With the bar at rest and the gate shut, the host is told there is nothing to follow.
    expect(hostFrames[hostFrames.length - 1]).toBeNull()
    // Scrolling under the sheet moves nothing.
    scroll([30])
    expect(barVar()).toBe(0)
    uiStore.set({ menu: null })
    expect(barHideStore.get().allowed).toBe(true)

    // The omnibox covers the page too (and attaches to the pill): the bar is in place at once.
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    uiStore.set({
      urlbar: { open: true, mode: 'edit', tabId: 't1', initialText: undefined, attached: false }
    })
    expect(barHideStore.get().allowed).toBe(false)
    expect(barHideStore.get().phase).toBe('rest')
    expect(barVar()).toBe(0)
    expectAgreement()
    uiStore.set({
      urlbar: { open: false, mode: 'new-tab', tabId: null, initialText: undefined, attached: false }
    })
    expect(barHideStore.get().allowed).toBe(true)

    // Find docking (§9.32) covers nothing: the bar is seen coming back, on the spring.
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    uiStore.set({ findOpen: true })
    expect(barHideStore.get().allowed).toBe(false)
    expect(barHideStore.get().phase).toBe('settling')
    expectAgreement()
    settle()
    expect(barVar()).toBe(0)
    expectAgreement()
    uiStore.set({ findOpen: false })
  })

  it('a sheet over a top-docked bar, which the recede does not fade, brings it back on the spring', () => {
    browserStore.set({ state: state('top') })
    setBarHideContext({ edge: 'top' })
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    uiStore.set({ menu: { items: [] } as never })
    expect(barHideStore.get().allowed).toBe(false)
    expect(barHideStore.get().phase).toBe('settling')
    expectAgreement()
    settle()
    expect(barVar()).toBe(0)
    expectAgreement()
  })

  it('the overview (the gesture stage over the page) brings a hidden bar back and keeps it while it is open (§11.5)', () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    // The stage stands in for the live page (the tab overview, the tab-switch cards): a cover
    // over a bottom-docked bar, so the bar is in place at once under the stage's arrival.
    uiStore.set({ stageActive: true })
    expect(barHideStore.get().allowed).toBe(false)
    expect(barVar()).toBe(0)
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    scroll([30])
    expect(barVar()).toBe(0)
    uiStore.set({ stageActive: false })
    expect(barHideStore.get().allowed).toBe(true)
    expectAgreement()
  })

  it('under reduced motion the finger still moves the bar one to one, and the snap is a cut (§11.3)', () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
    vi.stubGlobal('matchMedia', matchMedia)
    // Down the page 24, back up 6, one to one at each step.
    dispatchBarScroll('t1', 'start', null)
    for (const delta of [12, 12, -6]) {
      now += 100
      dispatchBarScroll('t1', 'move', { delta, time: now })
    }
    expect(barVar()).toBeCloseTo(18 / 48, 3)
    expect(barHideStore.get().phase).toBe('dragging')
    expectAgreement()
    // The release, short of the commit line and drifting back: no frames are queued for a
    // spring; the bar is at its shown rest at once.
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    expect(frames).toHaveLength(0)
    expect(barHideStore.get()).toMatchObject({ progress: 0, phase: 'rest' })
    expect(barVar()).toBe(0)
    expectAgreement()
    // Out past the commit line and released: the cut lands hidden, and the boolean flips with it.
    scroll([12, 12])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    expect(frames).toHaveLength(0)
    expect(barHideStore.get()).toMatchObject({ progress: 1, phase: 'rest' })
    expect(uiStore.get().barHidden).toBe(true)
    expectAgreement()
  })

  it('stays put on the new tab page and with the setting off', () => {
    browserStore.set({ state: state('bottom', 'zen://newtab') })
    expect(barHideStore.get().allowed).toBe(false)
    browserStore.set({ state: state('bottom') })
    expect(barHideStore.get().allowed).toBe(true)
    const off = state('bottom')
    off.settings = { ...off.settings, hideToolbarOnScroll: false }
    browserStore.set({ state: off })
    expect(barHideStore.get().allowed).toBe(false)
  })

  it('the keyboard closes the gate through the bottom inset', () => {
    uiStore.set({ insets: { top: 24, right: 0, bottom: 320, left: 0 } })
    expect(barHideStore.get().allowed).toBe(false)
    uiStore.set({ insets: { top: 24, right: 0, bottom: 20, left: 0 } })
    expect(barHideStore.get().allowed).toBe(true)
  })

  it('a focus landing on the hidden pill (TalkBack) brings the bar back', () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    showBar()
    expect(barHideStore.get().phase).toBe('settling')
    settle()
    expect(barVar()).toBe(0)
    expectAgreement()
  })

  it('touch exploration (TalkBack) on: the bar does not hide and comes back if it was off; off again, it may hide', () => {
    // Chrome never hides its controls while an accessibility service is on; the host says when
    // touch exploration turns on or off (the boot payload at start, `barTouchExploration` after).
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    setBarHideTouchExploration(true)
    expect(barHideStore.get().allowed).toBe(false)
    expect(barHideStore.get().phase).toBe('settling')
    settle()
    expect(barVar()).toBe(0)
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    // A scroll while the service is on moves nothing.
    scroll([60])
    expect(barVar()).toBe(0)
    expectAgreement()
    setBarHideTouchExploration(false)
    expect(barHideStore.get().allowed).toBe(true)
    scroll([60])
    expect(barVar()).toBe(1)
    expectAgreement()
  })

  it("the host's record has every return that was not the finger's, and none while the bar is home", () => {
    const notes: string[] = []
    setBarHideHost({ apply: (frame) => hostFrames.push(frame), note: (r) => notes.push(r) })
    // Home and at rest: a tab switch, a focus, a document have nothing to move and say nothing of a show.
    browserStore.set({ state: state('bottom', 'https://example.com/other') })
    showBar()
    dispatchBarNavigation('t1', false)
    expect(notes.filter((n) => n.startsWith('show'))).toEqual([])
    // A drag off and its release: the phases, with the offset, are the record of the finger's own motion.
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(notes.filter((n) => n.startsWith('show'))).toEqual([])
    expect(notes).toEqual(['dragging at 0 of 48', 'rest at 48 of 48'])
    // Hidden: the focus, the document, the host's fling and the gate each leave their word before the bar moves.
    notes.length = 0
    showBar()
    settle()
    expect(notes[0]).toBe('show: asked by the host (focus on the hidden pill)')
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    notes.length = 0
    dispatchBarNavigation('t1', false)
    settle()
    expect(notes[0]).toBe('show: a document committed on the page')
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    notes.length = 0
    dispatchBarScroll('t1', 'show', null)
    settle()
    expect(notes[0]).toBe('show: the host (a fling reached the top)')
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    notes.length = 0
    uiStore.set({ findOpen: true })
    expect(notes[0]).toBe('show: the gate closed (panelDocked)')
    uiStore.set({ findOpen: false })
    expectAgreement()
  })

  it('docked at the top the same value moves the bar off the top edge, and the host hears that edge', () => {
    browserStore.set({ state: state('top') })
    setBarHideContext({ edge: 'top' })
    expect(barHideStore.get().edge).toBe('top')
    expect(hostFrames[hostFrames.length - 1]).toEqual({
      edge: 'top',
      offset: 0,
      travel: 48,
      shownEdge: 24 + 56
    })
    scroll([24])
    expect(barVar()).toBeCloseTo(0.5, 3)
    expectAgreement()
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ edge: 'top', offset: 24 })
  })

  it("the host hears the page's measured edge, so a strip between the bar and the page counts, at either dock and through the hidden rest", () => {
    // Bottom dock: the blocked pop-ups chip (44) sits between the page and the bar, so the page
    // ends 44 above the bar's edge (915 − 20 − 56 = 839).
    contentAreaStore.set({ area: { x: 8, y: 80, width: 396, height: 839 - 44 - 80 } })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ edge: 'bottom', shownEdge: 839 - 44 })

    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    // The column has taken the band: the reporter measures the page 48 taller, in the layout
    // the boolean names, and the edge the host is told stays the shown one.
    contentAreaStore.set({ area: { x: 8, y: 80, width: 396, height: 839 - 44 - 80 + 48 } })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 48, shownEdge: 839 - 44 })

    // Top dock: a translate bar (48) between the bar and the page; the page starts at
    // 24 + 56 + 48 with the bar shown.
    resetBarHide()
    browserStore.set({ state: state('top') })
    setBarHideContext({ edge: 'top' })
    contentAreaStore.set({ area: { x: 8, y: 24 + 56 + 48, width: 396, height: 700 } })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ edge: 'top', shownEdge: 128 })
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    contentAreaStore.set({ area: { x: 8, y: 24 + 56 + 48 - 48, width: 396, height: 748 } })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 48, shownEdge: 128 })

    // No measurement yet: the insets and the band stand in.
    contentAreaStore.set({ area: null })
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ shownEdge: 24 + 56 })
  })

  it('only the page on screen moves the bar', () => {
    dispatchBarScroll('other', 'start', null)
    now += 16
    dispatchBarScroll('other', 'move', { delta: 30, time: now })
    expect(barVar()).toBe(0)
    expect(barHideStore.get().phase).toBe('rest')
  })

  it("a same-document navigation keeps a hidden bar where it is: the page's URL is not the key", () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)

    // pushState / replaceState / a fragment: the URL changes, the document stays, the bar stays.
    browserStore.set({ state: state('bottom', 'https://example.com/long?page=2') })
    dispatchBarNavigation('t1', true)
    expect(barHideStore.get().phase).toBe('rest')
    expect(uiStore.get().barHidden).toBe(true)
    browserStore.set({ state: state('bottom', 'https://example.com/long?page=2#section-3') })
    dispatchBarNavigation('t1', true)
    expect(uiStore.get().barHidden).toBe(true)

    // Another tab's document committing moves nothing on screen either.
    dispatchBarNavigation('other', false)
    expect(uiStore.get().barHidden).toBe(true)

    // A new document on this tab: the bar starts in place, on the spring.
    dispatchBarNavigation('t1', false)
    expect(barHideStore.get().phase).toBe('settling')
    settle()
    expect(barVar()).toBe(0)
    expectAgreement()
  })

  it('a load starting on the tab, or another tab coming to the front, puts the bar back', () => {
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)

    // The `loading` edge (a link followed, a reload), whatever the URL reads.
    const loadingState = state('bottom')
    loadingState.tabs.t1 = { ...loadingState.tabs.t1, loading: true } as Tab
    browserStore.set({ state: loadingState })
    expect(barHideStore.get().phase).toBe('settling')
    settle()
    expect(barVar()).toBe(0)
    // Loading going on is not a second edge.
    scroll([60])
    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    settle()
    expect(uiStore.get().barHidden).toBe(true)
    browserStore.set({ state: loadingState })
    expect(barHideStore.get().phase).toBe('rest')

    // A tab switch.
    const switched = state('bottom')
    switched.tabs = { ...switched.tabs, t2: { ...tab, id: 't2', url: 'https://other.example' } }
    switched.spaces = [{ ...space, tabIds: ['t1', 't2'], activeTabId: 't2' }]
    browserStore.set({ state: switched })
    expect(barHideStore.get().phase).toBe('settling')
    settle()
    expect(barVar()).toBe(0)
    expectAgreement()
  })
})
