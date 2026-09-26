import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { cmd, run } from '../api'
import { browserStore } from '../browserStore'
import { viewportStore } from '../formFactor'
import { applyDrawn, applyLayout, pageViewStore } from '../pageView'
import {
  arrived,
  CROSSING_OUT_MS,
  crossingAvailable,
  crossingFrom,
  crossingVerdict,
  crossReaderView,
  LOAD_HOLD_MS,
  nextBoundMs,
  READER_SURFACE,
  readerCrossingHolds,
  readerCrossingOf,
  readerCrossingStore,
  readerSurfaceColor,
  START_TIMEOUT_MS,
  type CrossingObservation
} from '../readerTransition'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => 'data:image/png;base64,PICTURE'),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The reader crossing (MOT-36): the phone's way into Reader View and out over the cover
 * protocol – the page's picture under the reader's surface while the core crosses, the
 * destination's first frame in its place – as a pure verdict over what the crossing sees of
 * its tab, and as the controller that runs the phases on the stores.
 */

const ARTICLE = 'https://news.example.com/story'
const READER = `zen://reader?id=1&url=${encodeURIComponent(ARTICLE)}`

function observation(patch: Partial<CrossingObservation> = {}): CrossingObservation {
  return {
    url: ARTICLE,
    loading: false,
    sawLoading: false,
    sinceStartMs: 0,
    sinceArrivedMs: null,
    ...patch
  }
}

describe('the crossing’s direction and arrival', () => {
  it('enters from a page and exits from the reader', () => {
    expect(crossingFrom(ARTICLE)).toBe('enter')
    expect(crossingFrom(READER)).toBe('exit')
  })

  it('has arrived once the tab’s address is on the destination’s side', () => {
    expect(arrived('enter', ARTICLE)).toBe(false)
    expect(arrived('enter', READER)).toBe(true)
    expect(arrived('exit', READER)).toBe(false)
    expect(arrived('exit', ARTICLE)).toBe(true)
  })
})

describe('the verdict over one observation', () => {
  it('holds before the destination is reached, and gives the page back once the start has timed out', () => {
    expect(crossingVerdict('enter', observation({ sinceStartMs: 0 }))).toBe('hold')
    expect(crossingVerdict('enter', observation({ sinceStartMs: START_TIMEOUT_MS - 1 }))).toBe(
      'hold'
    )
    expect(crossingVerdict('enter', observation({ sinceStartMs: START_TIMEOUT_MS }))).toBe('abort')
  })

  it('lands once the destination’s document has loaded – seen loading, then not', () => {
    const arrivedLoading = observation({
      url: READER,
      loading: true,
      sawLoading: true,
      sinceArrivedMs: 40
    })
    expect(crossingVerdict('enter', arrivedLoading)).toBe('hold')
    expect(crossingVerdict('enter', { ...arrivedLoading, loading: false })).toBe('land')
  })

  it('holds a destination reached but not yet seen loading until the hold’s bound, then shows it live', () => {
    const arrivedQuiet = observation({ url: READER, sinceArrivedMs: 0 })
    expect(crossingVerdict('enter', arrivedQuiet)).toBe('hold')
    expect(crossingVerdict('enter', { ...arrivedQuiet, sinceArrivedMs: LOAD_HOLD_MS.enter })).toBe(
      'land'
    )
    const back = observation({ url: ARTICLE, loading: true, sawLoading: true, sinceArrivedMs: 0 })
    expect(crossingVerdict('exit', back)).toBe('hold')
    expect(crossingVerdict('exit', { ...back, sinceArrivedMs: LOAD_HOLD_MS.exit })).toBe('land')
  })

  it('holds the way out shorter than the way in: the article comes off the network, the reader is the core’s own', () => {
    expect(LOAD_HOLD_MS.exit).toBeLessThan(LOAD_HOLD_MS.enter)
  })

  it('names the next bound the timer waits for', () => {
    expect(nextBoundMs('enter', observation({ sinceStartMs: 100 }))).toBe(START_TIMEOUT_MS - 100)
    expect(nextBoundMs('enter', observation({ url: READER, sinceArrivedMs: 500 }))).toBe(
      LOAD_HOLD_MS.enter - 500
    )
    expect(nextBoundMs('exit', observation({ url: ARTICLE, sinceArrivedMs: 5000 }))).toBe(0)
  })
})

describe('the reader’s surface', () => {
  it('is the ground the reader document paints per theme, `auto` following the chrome’s scheme', () => {
    expect(readerSurfaceColor('light', true)).toBe(READER_SURFACE.light)
    expect(readerSurfaceColor('dark', false)).toBe(READER_SURFACE.dark)
    expect(readerSurfaceColor('sepia', true)).toBe(READER_SURFACE.sepia)
    expect(readerSurfaceColor('auto', false)).toBe(READER_SURFACE.light)
    expect(readerSurfaceColor('auto', true)).toBe(READER_SURFACE.dark)
  })

  it('is pinned to the reader page’s own stylesheet (`core/readerPage.ts`, services’ document)', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../../../core/readerPage.ts', import.meta.url)),
      'utf8'
    )
    for (const colour of Object.values(READER_SURFACE)) {
      expect(page, `${colour} is a --bg the reader paints`).toMatch(
        new RegExp(`--bg:\\s*${colour}\\b`, 'i')
      )
    }
  })

  it('fades out at §11’s state-change length, as the stylesheet declares it', () => {
    expect(CROSSING_OUT_MS).toBe(120)
    const css = readFileSync(
      fileURLToPath(new URL('../../components/content/readerCrossing.css', import.meta.url)),
      'utf8'
    )
    expect(css).toMatch(
      /\.zen-reader-crossing-surface\s*\{[^}]*transition:\s*opacity 120ms var\(--zen-ease\)/
    )
  })
})

describe('the store’s reads', () => {
  const crossing = {
    tabId: 't1',
    crossing: 'enter' as const,
    phase: 'loading' as const,
    picture: null,
    surface: READER_SURFACE.light
  }

  it('answers for the crossing’s tab alone', () => {
    expect(readerCrossingOf({ crossing }, 't1')).toBe(crossing)
    expect(readerCrossingOf({ crossing }, 't2')).toBeNull()
    expect(readerCrossingOf({ crossing: null }, 't1')).toBeNull()
  })

  it('holds the page off the screen until the landing', () => {
    expect(readerCrossingHolds({ crossing }, 't1')).toBe(true)
    expect(readerCrossingHolds({ crossing: { ...crossing, phase: 'covering' } }, 't1')).toBe(true)
    expect(readerCrossingHolds({ crossing: { ...crossing, phase: 'landing' } }, 't1')).toBe(false)
    expect(readerCrossingHolds({ crossing }, 't2')).toBe(false)
  })
})

// --- the controller over the stores ------------------------------------------------------

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return { id: 't1', url, loading: false, readerable: false, spaceId: 's1', ...patch } as Tab
}

function state(active: Tab, platform: UIState['platform'] = 'android'): UIState {
  return {
    platform,
    tabs: { [active.id]: active },
    spaces: [{ id: 's1', activeTabId: active.id }],
    activeSpaceId: 's1',
    settings: { reader: { theme: 'light' } }
  } as unknown as UIState
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('crossReaderView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(run).mockClear()
    vi.mocked(cmd).mockClear()
    readerCrossingStore.set({ crossing: null })
    pageViewStore.set({ phases: new Map(), lastApplied: null })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    browserStore.set({ state: state(tab(ARTICLE)) })
  })
  afterEach(() => {
    vi.useRealTimers()
    readerCrossingStore.set({ crossing: null })
    browserStore.set({ state: null })
  })

  it('is the core’s plain toggle off the phone, on a desktop chassis, or while another crossing runs', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
    await crossReaderView('t1')
    expect(run).toHaveBeenCalledWith('reader.toggle', { tabId: 't1' })
    expect(readerCrossingStore.get().crossing).toBeNull()

    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    browserStore.set({ state: state(tab(ARTICLE), 'linux') })
    await crossReaderView('t1')
    expect(run).toHaveBeenCalledTimes(2)
    expect(crossingAvailable(browserStore.get().state!)).toBe(false)

    browserStore.set({ state: state(tab(ARTICLE)) })
    readerCrossingStore.set({
      crossing: { tabId: 't9', crossing: 'enter', phase: 'loading', picture: null, surface: '#fff' }
    })
    const cross = vi.fn()
    await crossReaderView('t1', { cross })
    expect(cross).toHaveBeenCalledTimes(1)
  })

  it('takes the page’s picture, covers, asks the core to cross once the page is off the screen, and lands when the reader has loaded', async () => {
    const cross = vi.fn()
    const done = crossReaderView('t1', { cross })
    await flush()
    // The picture is the hosts' capture; the crossing begins covering on it, the fade at 0.
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    let now = readerCrossingStore.get().crossing
    expect(now).toMatchObject({
      tabId: 't1',
      crossing: 'enter',
      phase: 'covering',
      picture: 'data:image/png;base64,PICTURE',
      surface: READER_SURFACE.light
    })
    expect(readerCrossingHolds(readerCrossingStore.get(), 't1')).toBe(true)
    expect(cross).not.toHaveBeenCalled()
    // The layout reporter took the view down and the host drew the frame without it.
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', false))
    await flush()
    now = readerCrossingStore.get().crossing
    expect(now?.phase).toBe('loading')
    expect(cross).toHaveBeenCalledTimes(1)
    // The core crossed: the reader document loads, then finishes.
    browserStore.set({ state: state(tab(READER, { loading: true })) })
    await flush()
    expect(readerCrossingStore.get().crossing?.phase).toBe('loading')
    browserStore.set({ state: state(tab(READER, { loading: false })) })
    await flush()
    expect(readerCrossingStore.get().crossing?.phase).toBe('landing')
    expect(readerCrossingHolds(readerCrossingStore.get(), 't1')).toBe(false)
    // The view is asked back and the host draws it: the crossing ends.
    await vi.advanceTimersByTimeAsync(0)
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: false, hid: [], shown: ['t1'] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', true))
    await flush()
    await done
    expect(readerCrossingStore.get().crossing).toBeNull()
  })

  it('begins on a picture in hand in the same turn (the menu row’s pick under the sheet)', () => {
    void crossReaderView('t1', { cross: vi.fn(), picture: 'data:held' })
    expect(readerCrossingStore.get().crossing).toMatchObject({
      phase: 'covering',
      picture: 'data:held'
    })
    expect(cmd).not.toHaveBeenCalled()
  })

  it('gives the page back when the core never crosses (an extraction that failed)', async () => {
    const cross = vi.fn()
    const done = crossReaderView('t1', { cross })
    await flush()
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', false))
    await flush()
    expect(cross).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 5)
    expect(readerCrossingStore.get().crossing?.phase).toBe('landing')
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: false, hid: [], shown: ['t1'] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', true))
    await flush()
    await done
    expect(readerCrossingStore.get().crossing).toBeNull()
  })

  it('shows a destination slow to load live after the hold, and exits the same way it enters', async () => {
    browserStore.set({ state: state(tab(READER)) })
    const cross = vi.fn()
    const done = crossReaderView('t1', { cross })
    await flush()
    expect(readerCrossingStore.get().crossing?.crossing).toBe('exit')
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', false))
    await flush()
    // Back on the article, loading and loading…
    browserStore.set({ state: state(tab(ARTICLE, { loading: true })) })
    await flush()
    expect(readerCrossingStore.get().crossing?.phase).toBe('loading')
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS.exit + 5)
    expect(readerCrossingStore.get().crossing?.phase).toBe('landing')
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: false, hid: [], shown: ['t1'] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', true))
    await flush()
    await done
    expect(readerCrossingStore.get().crossing).toBeNull()
  })

  it('lets go when another tab comes in front', async () => {
    const cross = vi.fn()
    const done = crossReaderView('t1', { cross })
    await flush()
    pageViewStore.set(
      applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] })
    )
    pageViewStore.set(applyDrawn(pageViewStore.get(), 't1', false))
    await flush()
    const other = tab('https://other.example/', { id: 't2' })
    browserStore.set({
      state: {
        ...state(other),
        tabs: { t1: tab(ARTICLE), t2: other }
      } as unknown as UIState
    })
    await flush()
    expect(readerCrossingStore.get().crossing?.phase).toBe('landing')
    await vi.advanceTimersByTimeAsync(1100)
    await done
    expect(readerCrossingStore.get().crossing).toBeNull()
  })
})
