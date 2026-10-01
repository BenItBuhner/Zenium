// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAppBanner } from '@shared/types'

const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import {
  autoOpenInstall,
  closeInstallOffer,
  resetInstallOffers,
  retireInstallOffer
} from '../installOffer'
import { claimBannerSurface, uiStore } from '../ui'

/*
 * The desktop's ambient install offer (lib/installOffer.ts; the Design Lead's ruling on W8-M3's
 * item 3, the cooldown through the core since Services' seed #42): the core's `webapp.banner`
 * opens the pill's Install chip's popover of its own accord, and the popover is the banner's
 * card on the desktop – the word that the card is drawn (`webapp.bannerShown`, the stamp on
 * the app's cooldown) goes in the same tick as the banner, with a surface mounted to draw it,
 * and never under something that already stands over the page, where the core's grace keeps
 * the site's turn. The memory is the core's: nothing per site is kept here. The core's
 * take-down retires the popover with no report; its leave hands the page back.
 */

const OFFER: WebAppBanner = {
  tabId: 't1',
  name: 'Example App',
  origin: 'app.example',
  icon: null,
  tint: null
}

const calls = (): unknown[][] => run.mock.calls.map((c) => [...c])
/** The capture the popover waits on has come back. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let release: (() => void) | null = null

beforeEach(() => {
  resetInstallOffers()
  run.mockReset()
  release = claimBannerSurface()
})

afterEach(() => {
  release?.()
  release = null
  uiStore.set({ install: null, siteInfoOpen: false, snapshot: null, snapshotTabId: null })
  resetInstallOffers()
})

describe('autoOpenInstall', () => {
  it('tells the core the card is drawn in the banner’s own tick, and opens the popover over the page’s picture', async () => {
    autoOpenInstall(OFFER)
    // The word first, before the capture is back: the core's grace is a second.
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
    expect(uiStore.get().installOffer).toBeNull()
    await flush()
    // Up like the prompt (`openInstallSheet`): the page captured, the chrome focused for its keys.
    expect(uiStore.get().installOffer).toEqual({ banner: OFFER, retired: false })
    expect(uiStore.get().snapshotTabId).toBe('t1')
    expect(calls()).toEqual([
      ['webapp.bannerShown', { tabId: 't1' }],
      ['focus.chrome', undefined]
    ])
  })

  it('sends no word and opens nothing where no surface draws the popover', async () => {
    release?.()
    release = null
    autoOpenInstall(OFFER)
    await flush()
    expect(calls()).toEqual([])
    expect(uiStore.get().installOffer).toBeNull()
  })

  it('does not push in under something already standing over the page – no word, so the core keeps the site’s turn – and opens on the next banner once the page is clear', async () => {
    uiStore.set({ siteInfoOpen: true })
    autoOpenInstall(OFFER)
    await flush()
    expect(calls()).toEqual([])
    expect(uiStore.get().installOffer).toBeNull()
    // No memory of its own: the core's next banner for the site is answered on its merits.
    uiStore.set({ siteInfoOpen: false })
    autoOpenInstall(OFFER)
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
    await flush()
    expect(uiStore.get().installOffer?.banner).toEqual(OFFER)
  })

  it('a second banner for the tab whose popover is up changes nothing of the popover and answers the word again', async () => {
    autoOpenInstall(OFFER)
    await flush()
    const up = uiStore.get().installOffer
    run.mockClear()
    autoOpenInstall({ ...OFFER, name: 'Example App (again)' })
    await flush()
    expect(uiStore.get().installOffer).toBe(up)
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
    // One popover at a time: a banner for another tab while this one is up is under it.
    autoOpenInstall({ ...OFFER, tabId: 't2' })
    await flush()
    expect(uiStore.get().installOffer).toBe(up)
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
  })

  it('the core’s take-down retires the popover with no report, and lets go of one still on its way', async () => {
    autoOpenInstall(OFFER)
    await flush()
    run.mockClear()
    retireInstallOffer('t1')
    expect(uiStore.get().installOffer).toEqual({ banner: OFFER, retired: true })
    // Retired once; another tab's take-down is not this popover's.
    retireInstallOffer('t2')
    expect(uiStore.get().installOffer).toEqual({ banner: OFFER, retired: true })
    expect(calls()).toEqual([])
    // The popover has left: the page comes back and the keyboard goes to it.
    closeInstallOffer('t1')
    expect(uiStore.get().installOffer).toBeNull()
    expect(uiStore.get().snapshotTabId).toBeNull()
    expect(calls()).toEqual([['focus.content', undefined]])

    // Taken back while the capture was out: nothing opens, and the capture is let go of.
    run.mockClear()
    autoOpenInstall(OFFER)
    retireInstallOffer('t1')
    await flush()
    expect(uiStore.get().installOffer).toBeNull()
    expect(uiStore.get().snapshotTabId).toBeNull()
    expect(calls()).toEqual([['webapp.bannerShown', { tabId: 't1' }]])
  })
})
