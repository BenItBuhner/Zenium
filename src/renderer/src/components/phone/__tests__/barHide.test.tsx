// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import {
  barHideStore,
  dispatchBarNavigation,
  dispatchBarScroll,
  resetBarHide,
  setBarHideContext,
  setBarHideHost,
  showBar,
  type BarHideHostFrame
} from '@renderer/lib/barHide'
import { browserStore, contentAreaStore, uiStore } from '@renderer/lib/ui'

/*
 * What the bar that hides on scroll publishes for every other surface (v2 draft §11; the tab
 * group strip rides it): `--zen-bar-hide` on the document root, 0 shown … 1 hidden per frame,
 * `data-bar-hidden` on the root and `uiStore.barHidden` at rest, and `barHideStore` for the
 * chrome's own code. They are written from one value in `lib/barHide.ts`; this pins down that
 * they agree at every point of a gesture, and that the host hears the frame the page's edge
 * should take, with the gate closing on a sheet and on the omnibox and a TalkBack focus bringing
 * the bar back.
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
const rootVar = (): number => Number(root().style.getPropertyValue('--zen-bar-hide') || 0)

/** The root variable, the store and the boolean read from one value. */
function expectAgreement(): void {
  const s = barHideStore.get()
  expect(rootVar()).toBeCloseTo(s.progress, 3)
  const hidden = s.phase === 'rest' && s.progress >= 1
  expect(uiStore.get().barHidden).toBe(hidden)
  expect(root().dataset.barHidden === 'true').toBe(hidden)
}

describe('the published hide progress', () => {
  let frames: Array<(now: number) => void>
  let now: number
  let hostFrames: Array<BarHideHostFrame | null>

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
  })

  afterEach(() => {
    resetBarHide()
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

  it('the root variable, the store and the boolean agree at every point of a scroll and its snap', () => {
    scroll([12, 12])
    expect(rootVar()).toBeCloseTo(0.5, 3)
    expect(barHideStore.get()).toMatchObject({ progress: 0.5, phase: 'dragging' })
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    // The host is told the offset per frame.
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({ offset: 24, travel: 48 })

    now += 16
    dispatchBarScroll('t1', 'end', { time: now })
    expectAgreement()
    settle()
    expect(rootVar()).toBe(1)
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
    expect(rootVar()).toBeCloseTo(42 / 48, 3)
    expectAgreement()
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
    expect(rootVar()).toBe(0)
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    expect(frames).toHaveLength(0)
    // With the bar at rest and the gate shut, the host is told there is nothing to follow.
    expect(hostFrames[hostFrames.length - 1]).toBeNull()
    // Scrolling under the sheet moves nothing.
    scroll([30])
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBeCloseTo(0.5, 3)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
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
    expect(rootVar()).toBe(0)
    expectAgreement()
  })
})
