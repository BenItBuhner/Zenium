import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAppBanner } from '@shared/types'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'

vi.stubGlobal('window', { zen: { invoke: async () => null, on: () => () => undefined } })
vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { bannerSurfaceMounted, claimBannerSurface, claimMessageCards, dismissBanner, uiStore } =
  await import('../ui')
const { installBannerShown, presentInstallBanner, retireInstallBanner } =
  await import('../installBanner')

const BANNER: WebAppBanner = {
  tabId: 't1',
  name: 'Sketch',
  origin: 'app.example',
  icon: 'https://app.example/icon-192.png',
  tint: '#0080ff'
}

const calls = (): unknown[][] => vi.mocked(run).mock.calls.map((c) => [...c])
const liveBanners = (): number => uiStore.get().banners.filter((b) => !b.leaving).length

/** The phone shell is up: the message layer draws banners and the messages are on the cards. */
let releaseSurface: (() => void) | null = null
let releaseCards: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(run).mockClear()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  releaseCards = claimMessageCards()
  releaseSurface = claimBannerSurface()
})
afterEach(() => {
  releaseSurface?.()
  releaseCards?.()
  releaseSurface = releaseCards = null
  vi.useRealTimers()
})

describe('the install banner’s word to the core (#740, seed #42)', () => {
  it('reports the card drawn the moment it is in the store, with a banner surface mounted', () => {
    presentInstallBanner(BANNER)
    expect(installBannerShown('t1')).toBe(true)
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
    // The card runs the one offer clock (`BAND_CLOCK_MS`; the core runs none): its running out
    // is the chrome's word back, `timeout`, which starts no cooldown.
    vi.advanceTimersByTime(BAND_CLOCK_MS - 1)
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
    vi.advanceTimersByTime(1)
    expect(calls()).toEqual([
      ['webapp.bannerShown', { tabId: 't1' }],
      ['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }]
    ])
  })

  it('sends no word where no surface draws banners (the desktop’s sidebar): the core’s grace then counts the prompt as undrawn', () => {
    releaseSurface?.()
    releaseSurface = null
    expect(bannerSurfaceMounted()).toBe(false)
    presentInstallBanner(BANNER)
    // The card sits in the store undrawn; the preview host's check reads it as up all the same.
    expect(liveBanners()).toBe(1)
    expect(installBannerShown('t1')).toBe(true)
    expect(calls()).toEqual([])
    // The core's take-down (`webapp.bannerHide`) retires it with no report back.
    retireInstallBanner('t1')
    expect(installBannerShown('t1')).toBe(false)
    expect(calls()).toEqual([])
  })

  it('a surface mounting makes the word go for the next card, and its unmount stops it again', () => {
    releaseSurface?.()
    releaseSurface = null
    presentInstallBanner(BANNER)
    expect(calls()).toEqual([])
    releaseSurface = claimBannerSurface()
    presentInstallBanner({ ...BANNER, tabId: 't2' })
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't2' }]])
    // One banner at a time under the `install` key: the first was replaced, not dismissed by
    // the user, so no dismissal reaches the core for it.
    expect(liveBanners()).toBe(1)
    expect(installBannerShown('t1')).toBe(false)
    releaseSurface()
    releaseSurface = null
    presentInstallBanner({ ...BANNER, tabId: 't3' })
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't2' }]])
  })

  it('the user’s swipe or close reports the dismissal as before; the core’s own take-down reports nothing', () => {
    presentInstallBanner(BANNER)
    const id = uiStore.get().banners[0].id
    dismissBanner(id, 'close')
    expect(calls()).toEqual([
      ['webapp.bannerShown', { tabId: 't1' }],
      ['webapp.dismissBanner', { tabId: 't1', reason: 'swipe' }]
    ])
    vi.mocked(run).mockClear()
    presentInstallBanner(BANNER)
    retireInstallBanner('t1')
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
  })
})
