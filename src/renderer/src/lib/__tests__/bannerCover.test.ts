import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Banner } from '../ui'

vi.stubGlobal('window', { zen: { invoke: async () => null, on: () => () => undefined } })

const {
  bannersCoveredNow,
  claimMessageCards,
  coverBanners,
  dismissBanner,
  forgetBanner,
  holdBanner,
  showBanner,
  uiStore
} = await import('../ui')

const banners = (): Banner[] => uiStore.get().banners
const live = (): Banner[] => banners().filter((b) => !b.leaving)

let releaseCards: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  releaseCards = claimMessageCards()
})
afterEach(() => {
  coverBanners(false)
  releaseCards?.()
  releaseCards = null
  vi.useRealTimers()
})

/**
 * The banner stack under the open tab overview (§9.33, matrix row A4): the model's half of the
 * cover – clocks – in `lib/ui.ts`. The surface's half (which cards fold away, and when the
 * overview counts as a cover at all) is `components/messages/cover.ts` and its own suite.
 */
describe('the banner stack under a cover', () => {
  it('starts uncovered, and the cover is idempotent', () => {
    expect(bannersCoveredNow()).toBe(false)
    coverBanners(true)
    coverBanners(true)
    expect(bannersCoveredNow()).toBe(true)
    coverBanners(false)
    expect(bannersCoveredNow()).toBe(false)
  })

  it('a banner arriving under the cover waits with its clock unarmed; the cover lifting starts its full time', () => {
    const reasons: string[] = []
    coverBanners(true)
    const id = showBanner({
      title: 'Show Reader View?',
      duration: 4000,
      onDismiss: (r) => reasons.push(r)
    })
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(60_000)
    expect(live().map((b) => b.id)).toEqual([id])
    expect(reasons).toEqual([])
    coverBanners(false)
    vi.advanceTimersByTime(3999)
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(1)
    expect(live()).toEqual([])
    expect(reasons).toEqual(['timeout'])
  })

  it('a standing banner keeps its place with its clock paused; the cover lifting resumes what was left', () => {
    const id = showBanner({ title: 'Translate this page?', duration: 4000 })
    vi.advanceTimersByTime(1500)
    coverBanners(true)
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(60_000)
    expect(live().map((b) => b.id)).toEqual([id])
    coverBanners(false)
    vi.advanceTimersByTime(2499)
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(1)
    expect(live()).toEqual([])
  })

  it('a clock resumed by the cover lifting gets at least the moment a let-go one gets', () => {
    const id = showBanner({ title: 'Nearly gone', duration: 4000 })
    vi.advanceTimersByTime(3900)
    coverBanners(true)
    coverBanners(false)
    vi.advanceTimersByTime(999)
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(1)
    expect(live()).toEqual([])
  })

  it('a banner with no clock is held and released with nothing armed', () => {
    const id = showBanner({ title: 'Install Zenium?' })
    coverBanners(true)
    coverBanners(false)
    vi.advanceTimersByTime(60_000)
    expect(live().map((b) => b.id)).toEqual([id])
  })

  it('the cover and a finger compose: whichever lets go last starts the clock', () => {
    const id = showBanner({ title: 'Held', duration: 4000 })
    vi.advanceTimersByTime(1000)
    holdBanner(id, true)
    coverBanners(true)
    holdBanner(id, false)
    vi.advanceTimersByTime(60_000)
    expect(live().map((b) => b.id)).toEqual([id])
    coverBanners(false)
    vi.advanceTimersByTime(3000)
    expect(live()).toEqual([])

    const again = showBanner({ title: 'Held again', duration: 4000 })
    vi.advanceTimersByTime(1000)
    coverBanners(true)
    holdBanner(again, true)
    coverBanners(false)
    vi.advanceTimersByTime(60_000)
    expect(live().map((b) => b.id)).toEqual([again])
    holdBanner(again, false)
    vi.advanceTimersByTime(2999)
    expect(live().map((b) => b.id)).toEqual([again])
    vi.advanceTimersByTime(1)
    expect(live()).toEqual([])
  })

  it('a banner dismissed under the cover is gone for good; the cover lifting does not revive it', () => {
    const reasons: string[] = []
    coverBanners(true)
    const id = showBanner({
      title: 'Replaced',
      key: 'k',
      duration: 4000,
      onDismiss: (r) => reasons.push(r)
    })
    const next = showBanner({
      title: 'Replacement',
      key: 'k',
      duration: 4000,
      onDismiss: (r) => reasons.push(r)
    })
    expect(reasons).toEqual(['replaced'])
    dismissBanner(next, 'close')
    forgetBanner(id)
    forgetBanner(next)
    coverBanners(false)
    vi.advanceTimersByTime(60_000)
    expect(banners()).toEqual([])
    expect(reasons).toEqual(['replaced', 'close'])
  })

  it('the stack without a cover is what it was: the clock runs from arrival', () => {
    const id = showBanner({ title: 'Plain', duration: 4000 })
    vi.advanceTimersByTime(3999)
    expect(live().map((b) => b.id)).toEqual([id])
    vi.advanceTimersByTime(1)
    expect(live()).toEqual([])
  })
})
