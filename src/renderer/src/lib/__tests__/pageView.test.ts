import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COVER_WAIT_MS } from '../cover'
import {
  ACK_TIMEOUT_MS,
  applyDrawn,
  applyLayout,
  COVERED_TIMEOUT_MS,
  coveredNow,
  onLayoutApplied,
  onViewDrawn,
  pageCovered,
  pageOffScreen,
  pageViewPhase,
  pageViewStore,
  settlePhase,
  type PageViewState
} from '../pageView'

/*
 * How the swap between a live page and its picture is sequenced where the chrome lies under
 * the pages (lib/pageView.ts). Open: the sheet holds until the host has drawn the frame without
 * the page view, so the recede starts on the picture at the page's own transform and never on a
 * page about to be swapped. Close: the picture stays until the host has drawn the page back, so
 * no frame shows the window behind it. The core's `layout.applied` says which views a layout
 * moved; the host's `view.drawn` says the frame carrying the change is on screen.
 */

const empty: PageViewState = { phases: new Map(), lastApplied: null }
const hidPages = (...hid: string[]): PageViewState =>
  applyLayout(empty, { contentHidden: true, hid, shown: [] })

/** Whether a promise has resolved by the time the microtasks have run. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
  pageViewStore.set({ phases: new Map(), lastApplied: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the phases (pure)', () => {
  it('a tab never asked to move is shown', () => {
    expect(pageViewPhase(empty, 'a')).toBe('shown')
    expect(pageViewPhase(empty, null)).toBe('shown')
    expect(pageOffScreen(empty, 'a')).toBe(false)
  })

  it('a layout that takes views down or brings them back puts them on their way', () => {
    const state = applyLayout(empty, { contentHidden: true, hid: ['a', 'b'], shown: ['c'] })
    expect(pageViewPhase(state, 'a')).toBe('hiding')
    expect(pageViewPhase(state, 'b')).toBe('hiding')
    expect(pageViewPhase(state, 'c')).toBe('showing')
    expect(pageViewPhase(state, 'd')).toBe('shown')
    expect(state.lastApplied).toEqual({ contentHidden: true, hid: ['a', 'b'], shown: ['c'] })
  })

  it("the host's frame settles a view down or back", () => {
    const hiding = hidPages('a')
    const hidden = applyDrawn(hiding, 'a', false)
    expect(pageViewPhase(hidden, 'a')).toBe('hidden')
    const showing = applyLayout(hidden, { contentHidden: false, hid: [], shown: ['a'] })
    expect(pageViewPhase(showing, 'a')).toBe('showing')
    const shown = applyDrawn(showing, 'a', true)
    expect(pageViewPhase(shown, 'a')).toBe('shown')
    expect(shown.phases.has('a')).toBe(false)
  })

  it('a flip the host never confirmed settles where it was heading', () => {
    expect(pageViewPhase(settlePhase(hidPages('a'), 'a'), 'a')).toBe('hidden')
    const showing = applyLayout(empty, { contentHidden: false, hid: [], shown: ['a'] })
    expect(pageViewPhase(settlePhase(showing, 'a'), 'a')).toBe('shown')
    // Settled phases and unknown tabs are left alone.
    const hidden = applyDrawn(hidPages('a'), 'a', false)
    expect(settlePhase(hidden, 'a')).toBe(hidden)
    expect(settlePhase(empty, 'zzz')).toBe(empty)
  })
})

describe('open: when the picture may start to recede (coveredNow)', () => {
  it('not while the view is still on its way down', () => {
    expect(coveredNow(hidPages('a'), 'a')).toBe(false)
  })

  it('once the host has drawn the frame without it', () => {
    expect(coveredNow(applyDrawn(hidPages('a'), 'a', false), 'a')).toBe(true)
  })

  it('at once for a page the layout had no view to take down (a chrome-drawn tab, one already hidden)', () => {
    // The layout hid the pages and moved no view of `s`: nothing of `s` is on screen to swap.
    expect(coveredNow(hidPages('a'), 's')).toBe(true)
    // With nothing hidden yet, or with the pages shown, the live page may still be there.
    expect(coveredNow(empty, 's')).toBe(false)
    const shownPages = applyLayout(empty, { contentHidden: false, hid: [], shown: [] })
    expect(coveredNow(shownPages, 's')).toBe(false)
  })

  it('never for a view on its way back', () => {
    const showing = applyLayout(applyDrawn(hidPages('a'), 'a', false), {
      contentHidden: false,
      hid: [],
      shown: ['a']
    })
    expect(coveredNow(showing, 'a')).toBe(false)
  })
})

describe('close: how long the picture stays (pageOffScreen)', () => {
  it('while the view is hiding, hidden, or showing but not yet drawn', () => {
    const hiding = hidPages('a')
    expect(pageOffScreen(hiding, 'a')).toBe(true)
    const hidden = applyDrawn(hiding, 'a', false)
    expect(pageOffScreen(hidden, 'a')).toBe(true)
    const showing = applyLayout(hidden, { contentHidden: false, hid: [], shown: ['a'] })
    expect(pageOffScreen(showing, 'a')).toBe(true)
    expect(pageOffScreen(applyDrawn(showing, 'a', true), 'a')).toBe(false)
  })

  it('not for another tab, nor without a tab', () => {
    expect(pageOffScreen(hidPages('a'), 'b')).toBe(false)
    expect(pageOffScreen(hidPages('a'), null)).toBe(false)
    expect(pageOffScreen(hidPages('a'), undefined)).toBe(false)
  })
})

describe('the events, in order', () => {
  it('layout.applied then view.drawn: hiding → hidden, showing → shown', () => {
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('hiding')
    onViewDrawn('a', false)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('hidden')
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['a'] })
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('showing')
    onViewDrawn('a', true)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('shown')
  })

  it('a host that never reports the frame is not waited on past ACK_TIMEOUT_MS', () => {
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('hiding')
    vi.advanceTimersByTime(1)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('hidden')
  })

  it("the host's word disarms the deadline, and a newer layout re-arms it", () => {
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    onViewDrawn('a', false)
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['a'] })
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    // Settled towards the newer layout's direction: shown.
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('shown')
  })

  it('the host reporting a frame no layout asked for still counts', () => {
    onViewDrawn('a', false)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('hidden')
    onViewDrawn('a', true)
    expect(pageViewPhase(pageViewStore.get(), 'a')).toBe('shown')
  })
})

describe('pageCovered: the hold a sheet takes before it comes up', () => {
  it('resolves at once where the chrome does not lie under the pages, or with no page', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(await settled(pageCovered('a', platform).promise)).toBe(true)
    }
    expect(await settled(pageCovered(null, 'android').promise)).toBe(true)
  })

  it('resolves at once when the view is down already (a second sheet over the first)', async () => {
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    onViewDrawn('a', false)
    expect(await settled(pageCovered('a', 'android').promise)).toBe(true)
  })

  it('otherwise waits for the frame without the view: not the layout alone', async () => {
    const hold = pageCovered('a', 'android')
    expect(await settled(hold.promise)).toBe(false)
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    expect(await settled(hold.promise)).toBe(false)
    onViewDrawn('a', false)
    expect(await settled(hold.promise)).toBe(true)
  })

  it('resolves on the layout alone for a page without a view to take down', async () => {
    const hold = pageCovered('s', 'android')
    expect(await settled(hold.promise)).toBe(false)
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    expect(await settled(hold.promise)).toBe(true)
  })

  it('gives up after COVERED_TIMEOUT_MS, which outlasts the cover wait and the host deadline', async () => {
    expect(COVERED_TIMEOUT_MS).toBeGreaterThan(COVER_WAIT_MS + ACK_TIMEOUT_MS)
    const hold = pageCovered('a', 'android')
    vi.advanceTimersByTime(COVERED_TIMEOUT_MS - 1)
    expect(await settled(hold.promise)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await settled(hold.promise)).toBe(true)
  })

  it('a cancelled hold never resolves, and no longer listens', async () => {
    const hold = pageCovered('a', 'android')
    hold.cancel()
    onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
    onViewDrawn('a', false)
    vi.advanceTimersByTime(COVERED_TIMEOUT_MS + 1)
    expect(await settled(hold.promise)).toBe(false)
  })

  it('the frame of another tab does not release it', async () => {
    const hold = pageCovered('a', 'android')
    onLayoutApplied({ contentHidden: true, hid: ['a', 'b'], shown: [] })
    onViewDrawn('b', false)
    expect(await settled(hold.promise)).toBe(false)
    onViewDrawn('a', false)
    expect(await settled(hold.promise)).toBe(true)
  })
})
