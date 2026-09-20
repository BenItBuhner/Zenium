// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import { chromeGutter } from '@renderer/hooks/useTheme'
import {
  barHideStore,
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
    expect(rootVar()).toBe(1)
    expect(uiStore.get().barHidden).toBe(true)
    expectAgreement()
    expect(hostFrames[hostFrames.length - 1]).toMatchObject({
      offset: 48,
      travel: 48,
      shownEdge: 915 - 20 - 56
    })
    // Half way when the strip enters: half way still, of the longer travel.
    scroll([-24])
    expect(rootVar()).toBeCloseTo(0.5, 3)
    setBarHideContext({ band: 106 })
    expect(rootVar()).toBeCloseTo(0.5, 3)
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

  it('the stylesheet slides the bar by the band less the gutter and clips it at the inset line, the strip’s share in the band (#202)', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8').replace(
      /\s+/g,
      ' '
    )
    // The travel is the whole band (`--zen-phone-band`: the row plus the strip's share, #202)
    // less the gutter, the same distance the content column gives the page at the hidden rest
    // (`edgePadding`), so the strip is off the edge with the row and the page gains the band.
    expect(css).toContain(
      '--zen-bar-hide-travel: calc(var(--zen-phone-band) - var(--zen-padding));'
    )
    expect(css).toContain(
      '--zen-bar-hide-shift: calc(var(--zen-bar-hide, 0) * var(--zen-bar-hide-travel));'
    )
    expect(css).toContain(
      "[data-edge='bottom'] { transform: translate3d(0, var(--zen-bar-hide-shift), 0); clip-path: inset(0 0 calc(var(--zen-inset-bottom) + var(--zen-bar-hide-shift)) 0); }"
    )
    expect(css).toContain(
      "[data-edge='top'] { transform: translate3d(0, calc(-1 * var(--zen-bar-hide-shift)), 0); clip-path: inset(calc(var(--zen-inset-top) + var(--zen-bar-hide-shift)) 0 0 0); }"
    )
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
    expect(rootVar()).toBe(0)
    expect(uiStore.get().barHidden).toBe(false)
    expectAgreement()
    // A scroll while the service is on moves nothing.
    scroll([60])
    expect(rootVar()).toBe(0)
    expectAgreement()
    setBarHideTouchExploration(false)
    expect(barHideStore.get().allowed).toBe(true)
    scroll([60])
    expect(rootVar()).toBe(1)
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
