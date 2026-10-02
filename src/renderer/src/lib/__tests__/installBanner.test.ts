import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAppBanner } from '@shared/types'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'

vi.stubGlobal('window', { zen: { invoke: async () => null, on: () => () => undefined } })
vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
/** The form factor's word on the touch layouts (the band is the door only there). */
const touch = { value: false }
vi.mock('@renderer/lib/formFactor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/formFactor')>()
  return { ...actual, isTouchLayout: () => touch.value }
})

const { run } = await import('@renderer/lib/api')
const { bannerSurfaceMounted, claimBannerSurface, claimMessageCards, dismissBanner, uiStore } =
  await import('../ui')
const { bandStore, dismissBand, resetBands, setBandFrame } = await import('@renderer/lib/band')
const { createModelDoor } = await import('@renderer/lib/band/door')
const { setBandDoor } = await import('@renderer/lib/band/post')
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

describe('the install banner at the band’s door: the cooldown counts from a shown offer (seed #43, the Lead’s S3)', () => {
  const SHOWN = ['webapp.bannerShown', { tabId: 't1' }]
  const ACCEPTED = ['webapp.bannerShown', { tabId: 't1', visible: false }]
  const TIMED_OUT = ['webapp.dismissBanner', { tabId: 't1', reason: 'timeout' }]

  beforeEach(() => {
    touch.value = true
    resetBands()
    setBandDoor(createModelDoor())
  })
  afterEach(() => {
    setBandDoor(null)
    resetBands()
    touch.value = false
  })

  it('posted under a cover, the word says the card is accepted but not seen; the plain word follows at the band’s first drawn frame, when the cover lifts – two words, in order', () => {
    setBandFrame({ front: 't1', ok: true, covered: true })
    presentInstallBanner(BANNER)
    // Posted and standing (the preview host's check reads it as up) – not drawn.
    expect(installBannerShown('t1')).toBe(true)
    expect(bandStore.get().shown).toBeNull()
    expect(calls()).toEqual([ACCEPTED])
    // The cover stands a while: no clock runs on a card nobody sees, no further word.
    vi.advanceTimersByTime(60_000)
    expect(calls()).toEqual([ACCEPTED])
    // The cover lifts: the band draws the card, and the one offer clock starts with the word.
    setBandFrame({ front: 't1', ok: true, covered: false })
    expect(bandStore.get().shown).not.toBeNull()
    expect(calls()).toEqual([ACCEPTED, SHOWN])
    // Covered again and uncovered again: the card was seen once; no word repeats.
    setBandFrame({ front: 't1', ok: true, covered: true })
    setBandFrame({ front: 't1', ok: true, covered: false })
    expect(calls()).toEqual([ACCEPTED, SHOWN])
    vi.advanceTimersByTime(BAND_CLOCK_MS)
    expect(calls()).toEqual([ACCEPTED, SHOWN, TIMED_OUT])
    expect(installBannerShown('t1')).toBe(false)
  })

  it('in the open the one word goes as the card is posted, today’s bytes – no second word when a cover comes and goes over the standing card', () => {
    setBandFrame({ front: 't1', ok: true })
    presentInstallBanner(BANNER)
    expect(bandStore.get().shown).not.toBeNull()
    expect(calls()).toEqual([SHOWN])
    setBandFrame({ front: 't1', ok: true, covered: true })
    setBandFrame({ front: 't1', ok: true, covered: false })
    vi.advanceTimersByTime(BAND_CLOCK_MS - 1)
    expect(calls()).toEqual([SHOWN])
    vi.advanceTimersByTime(1)
    expect(calls()).toEqual([SHOWN, TIMED_OUT])
  })

  it('put away unanswered under the cover (the Back): the core hears the band is gone, and the cover lifting brings no word of a show', () => {
    setBandFrame({ front: 't1', ok: true, covered: true })
    presentInstallBanner(BANNER)
    expect(calls()).toEqual([ACCEPTED])
    const entry = bandStore.get().entries[0]
    dismissBand(entry.id, 'back')
    expect(calls()).toEqual([ACCEPTED, TIMED_OUT])
    setBandFrame({ front: 't1', ok: true, covered: false })
    vi.advanceTimersByTime(60_000)
    expect(calls()).toEqual([ACCEPTED, TIMED_OUT])
    expect(installBannerShown('t1')).toBe(false)
  })

  it('retired by the core under the cover (the page left the app, another tab in front, the tab closed): no report back, and no word when the cover lifts', () => {
    setBandFrame({ front: 't1', ok: true, covered: true })
    presentInstallBanner(BANNER)
    retireInstallBanner('t1')
    expect(installBannerShown('t1')).toBe(false)
    expect(bandStore.get().entries).toEqual([])
    setBandFrame({ front: 't1', ok: true, covered: false })
    vi.advanceTimersByTime(60_000)
    expect(calls()).toEqual([ACCEPTED])
  })

  it('a newer card for another tab replaces the one held back: its own word goes, the replaced one never speaks of a show', () => {
    setBandFrame({ front: 't1', ok: true, covered: true })
    presentInstallBanner(BANNER)
    presentInstallBanner({ ...BANNER, tabId: 't2' })
    expect(installBannerShown('t1')).toBe(false)
    expect(installBannerShown('t2')).toBe(true)
    expect(calls()).toEqual([ACCEPTED, ['webapp.bannerShown', { tabId: 't2', visible: false }]])
    setBandFrame({ front: 't2', ok: true, covered: false })
    expect(calls()).toEqual([
      ACCEPTED,
      ['webapp.bannerShown', { tabId: 't2', visible: false }],
      ['webapp.bannerShown', { tabId: 't2' }]
    ])
  })
})
