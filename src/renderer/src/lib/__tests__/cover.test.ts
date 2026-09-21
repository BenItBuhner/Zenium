import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '@shared/types'
import {
  chromeUnderPages,
  COVER_WAIT_MS,
  coverPrimed,
  coverStatus,
  coverStore,
  decideHidden,
  trackCover,
  type CoverImageLike
} from '../cover'

/** The frame loop, driven by hand: `frame()` runs every callback queued for the next frame. */
let frames: Array<() => void> = []
const frame = (): void => {
  const batch = frames
  frames = []
  for (const cb of batch) cb()
}
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
  frames.push(cb)
  return frames.length
})
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  frames.splice(id - 1, 1)
})

interface FakeImage extends CoverImageLike {
  fire(type: 'load' | 'error'): void
  decodeResolve: (() => void) | null
}

/** A cover image whose load, error and decode the test fires by hand. */
function image(opts: { cached?: boolean; broken?: boolean; decode?: boolean } = {}): FakeImage {
  const listeners = { load: new Set<() => void>(), error: new Set<() => void>() }
  const img: FakeImage = {
    complete: Boolean(opts.cached || opts.broken),
    naturalWidth: opts.cached ? 400 : 0,
    decode:
      opts.decode === false
        ? undefined
        : (): Promise<void> =>
            new Promise<void>((resolve) => {
              img.decodeResolve = () => resolve()
            }),
    addEventListener(type, listener) {
      listeners[type].add(listener)
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener)
    },
    fire(type) {
      for (const l of listeners[type]) l()
    },
    decodeResolve: null
  }
  return img
}

const status = (tabId: string): ReturnType<typeof coverStatus> =>
  coverStatus(coverStore.get(), tabId)
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('decideHidden: the page goes only once its cover is painted', () => {
  const none = { loading: false, painted: false }
  const loading = { loading: true, painted: false }
  const painted = { loading: false, painted: true }

  it('a show is honoured at once, whatever the cover is doing', () => {
    expect(decideHidden(false, true, loading, false)).toBe(false)
    expect(decideHidden(false, true, painted, false)).toBe(false)
    expect(decideHidden(false, false, none, false)).toBe(false)
  })

  it('a hide waits while the cover is on its way and follows its paint', () => {
    expect(decideHidden(true, false, loading, false)).toBe(false)
    expect(decideHidden(true, false, painted, false)).toBe(true)
  })

  it('with nothing to wait for, it hides at once', () => {
    expect(decideHidden(true, false, none, false)).toBe(true)
  })

  it('a wait that ran out hides anyway', () => {
    expect(decideHidden(true, false, loading, true)).toBe(true)
  })

  it('a hidden page stays hidden while wanted, even under a cover that is decoding again', () => {
    expect(decideHidden(true, true, loading, false)).toBe(true)
    expect(decideHidden(true, true, none, false)).toBe(true)
  })

  it('the chassis consults the table, not the layout: Android at any form factor, no desktop host', () => {
    // Keyed on the platform alone – a phone, an 800 × 1280 tablet and a DeX window with a mouse
    // all run the Android host with its chrome under the pages. Listing every `Platform` keeps a
    // new one from slipping past this table.
    const follows: Record<Platform, boolean> = {
      android: true,
      linux: false,
      win32: false,
      darwin: false
    }
    for (const [platform, expected] of Object.entries(follows))
      expect(chromeUnderPages(platform as Platform)).toBe(expected)
  })
})

describe('trackCover: from mount to the frame that has the pixels', () => {
  beforeEach(() => {
    frames = []
    coverStore.set({ loading: new Map(), painted: new Map() })
  })
  afterEach(() => {
    frames = []
  })

  it('counts a fresh image as loading, then as painted two frames after its decode', async () => {
    const img = image()
    const release = trackCover('a', img)
    expect(status('a')).toEqual({ loading: true, painted: false })

    img.fire('load')
    await flush()
    expect(status('a')).toEqual({ loading: true, painted: false })
    img.decodeResolve!()
    await flush()
    // Decoded: the next frame carries the pixels …
    expect(frames).toHaveLength(1)
    frame()
    expect(status('a')).toEqual({ loading: true, painted: false })
    // … and when the frame after it begins, that frame has been drawn.
    frame()
    expect(status('a')).toEqual({ loading: false, painted: true })

    release()
    expect(status('a')).toEqual({ loading: false, painted: false })
  })

  it('an image the browser had cached needs no load event', async () => {
    const img = image({ cached: true })
    trackCover('a', img)
    expect(status('a').loading).toBe(true)
    await flush()
    img.decodeResolve!()
    await flush()
    frame()
    frame()
    expect(status('a')).toEqual({ loading: false, painted: true })
  })

  it('without decode(), the load itself starts the two frames', async () => {
    const img = image({ decode: false })
    trackCover('a', img)
    img.fire('load')
    await flush()
    frame()
    frame()
    expect(status('a')).toEqual({ loading: false, painted: true })
  })

  it('an image that fails is nothing to wait for', () => {
    const img = image()
    trackCover('a', img)
    img.fire('error')
    expect(status('a')).toEqual({ loading: false, painted: false })
    expect(status('a')).toEqual(coverStatus(coverStore.get(), 'a'))
  })

  it('an image that is already broken when mounted is nothing to wait for either', () => {
    trackCover('a', image({ broken: true }))
    expect(status('a')).toEqual({ loading: false, painted: false })
  })

  it('a release before the paint takes the loading count back and drops the frames', async () => {
    const img = image()
    const release = trackCover('a', img)
    img.fire('load')
    await flush()
    img.decodeResolve!()
    await flush()
    frame()
    release()
    expect(status('a')).toEqual({ loading: false, painted: false })
    frame()
    expect(status('a')).toEqual({ loading: false, painted: false })
  })

  it('covers of different tabs, and several covers of one, are counted apart', async () => {
    const a1 = image()
    const a2 = image()
    const b = image()
    const releaseA1 = trackCover('a', a1)
    trackCover('a', a2)
    trackCover('b', b)
    a1.fire('load')
    await flush()
    a1.decodeResolve!()
    await flush()
    frame()
    frame()
    expect(status('a')).toEqual({ loading: true, painted: true })
    expect(status('b')).toEqual({ loading: true, painted: false })
    releaseA1()
    expect(status('a')).toEqual({ loading: true, painted: false })
  })
})

describe('the ordering a sheet opens in', () => {
  beforeEach(() => {
    frames = []
    coverStore.set({ loading: new Map(), painted: new Map() })
  })

  it('snapshot painted, then hide; show at once when the sheet goes', async () => {
    // The chrome's report for the host, re-decided whenever the cover store changes.
    let wantsHidden = false
    let reported = false
    const waitedSince: { at: number | null } = { at: null }
    const now = { t: 10_000 }
    const evaluate = (): boolean => {
      const waitedOut = waitedSince.at !== null && now.t - waitedSince.at >= COVER_WAIT_MS
      reported = decideHidden(wantsHidden, reported, status('a'), waitedOut)
      if (wantsHidden && !reported) waitedSince.at ??= now.t
      else waitedSince.at = null
      return reported
    }
    const reports: boolean[] = []
    coverStore.subscribe(() => reports.push(evaluate()))

    // The tap: the sheet's flag flips and the snapshot image mounts in the same commit.
    wantsHidden = true
    const img = image()
    trackCover('a', img)
    expect(evaluate()).toBe(false)

    // The picture decodes and gets its frame: only now is the page hidden.
    img.fire('load')
    await flush()
    img.decodeResolve!()
    await flush()
    frame()
    expect(reported).toBe(false)
    frame()
    expect(reported).toBe(true)
    expect(reports.at(-1)).toBe(true)

    // The sheet closes: the page comes back without waiting for anything.
    wantsHidden = false
    expect(evaluate()).toBe(false)
  })

  it('a cover primed before the tap (the press on the menu button) lets the hide follow the tap at once', async () => {
    // The press: the capture lands and its picture mounts under the live page, wanted by nothing
    // yet (`coverPrimed`, ContentArea). Nothing is reported hidden meanwhile.
    let wantsHidden = false
    let reported = false
    const evaluate = (): boolean => {
      reported = decideHidden(wantsHidden, reported, status('a'), false)
      return reported
    }
    expect(coverPrimed('android', 'a', 'a')).toBe(true)
    const img = image()
    trackCover('a', img)
    expect(evaluate()).toBe(false)
    img.fire('load')
    await flush()
    img.decodeResolve!()
    await flush()
    frame()
    frame()
    expect(status('a')).toEqual({ loading: false, painted: true })
    expect(evaluate()).toBe(false)

    // The tap: the sheet's flag flips; the picture is on screen already, so the page goes now.
    wantsHidden = true
    expect(evaluate()).toBe(true)
  })

  it('coverPrimed: the active tab’s capture, on the chassis whose chrome lies under the pages', () => {
    expect(coverPrimed('android', 'a', 'a')).toBe(true)
    // Another tab's capture (a card of the overview) primes nothing for this one.
    expect(coverPrimed('android', 'b', 'a')).toBe(false)
    expect(coverPrimed('android', null, 'a')).toBe(false)
    expect(coverPrimed('android', 'a', null)).toBe(false)
    expect(coverPrimed('android', 'a', undefined)).toBe(false)
    // The desktop hosts have the overlay painted before a view goes: they show the capture as
    // they always have, once something covers the page.
    expect(coverPrimed('linux', 'a', 'a')).toBe(false)
    expect(coverPrimed('darwin', 'a', 'a')).toBe(false)
    expect(coverPrimed('win32', 'a', 'a')).toBe(false)
  })

  it('a cover that never paints holds the page only for the wait, not for good', () => {
    let reported = false
    const startedAt = 10_000
    trackCover('a', image())
    reported = decideHidden(true, reported, status('a'), false)
    expect(reported).toBe(false)
    const later = startedAt + COVER_WAIT_MS
    reported = decideHidden(true, reported, status('a'), later - startedAt >= COVER_WAIT_MS)
    expect(reported).toBe(true)
  })

  it('a desktop host reports the hide the moment it is wanted, whatever the cover is doing', () => {
    // The reporter's gate: the table is consulted only where the chrome lies under the pages;
    // elsewhere the report is the wish itself, as it was before covers existed.
    trackCover('a', image())
    const report = (platform: Platform, wantsHidden: boolean): boolean =>
      chromeUnderPages(platform)
        ? decideHidden(wantsHidden, false, status('a'), false)
        : wantsHidden
    expect(status('a')).toEqual({ loading: true, painted: false })
    expect(report('android', true)).toBe(false)
    expect(report('linux', true)).toBe(true)
    expect(report('darwin', true)).toBe(true)
    expect(report('win32', false)).toBe(false)
  })
})
