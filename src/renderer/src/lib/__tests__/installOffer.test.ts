// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAppBanner } from '@shared/types'

const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { autoOpenInstall, resetInstallOffers, takeOfferedInstall } from '../installOffer'
import { uiStore } from '../ui'

/*
 * The desktop's ambient install offer (lib/installOffer.ts; the Design Lead's ruling on W8-M3's
 * item 3): the core's `webapp.banner` opens the pill's Install chip's popover of its own accord
 * through the tab's `webapp.openInstall`, once per site for the session and never under
 * something that already stands over the page; the prompt that comes back is marked the offer's
 * once, for the popover to take no focus, and the next prompt for the tab is the user's.
 */

const OFFER: WebAppBanner = {
  tabId: 't1',
  name: 'Example App',
  origin: 'https://app.example',
  icon: null,
  tint: null
}

beforeEach(() => {
  resetInstallOffers()
  run.mockReset()
})

afterEach(() => {
  uiStore.set({ install: null, siteInfoOpen: false })
  resetInstallOffers()
})

describe('autoOpenInstall', () => {
  it('opens the tab’s install through the core and marks the prompt the offer’s, once', () => {
    autoOpenInstall(OFFER)
    expect(run).toHaveBeenCalledWith('webapp.openInstall', { tabId: 't1' })
    expect(run).toHaveBeenCalledTimes(1)
    // The popover asks once as it mounts; the answer is spent on the asking.
    expect(takeOfferedInstall('t1')).toBe(true)
    expect(takeOfferedInstall('t1')).toBe(false)
  })

  it('offers each site once for the session, whatever tab it is in', () => {
    autoOpenInstall(OFFER)
    autoOpenInstall({ ...OFFER, tabId: 't2' })
    expect(run).toHaveBeenCalledTimes(1)
    // Another site is another offer.
    autoOpenInstall({ ...OFFER, tabId: 't3', origin: 'https://other.example', name: 'Other' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith('webapp.openInstall', { tabId: 't3' })
    // Forgotten with the session's memory (tests).
    resetInstallOffers()
    autoOpenInstall(OFFER)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does not push in under something already standing over the page, and keeps the site for later', () => {
    uiStore.set({ siteInfoOpen: true })
    autoOpenInstall(OFFER)
    expect(run).not.toHaveBeenCalled()
    expect(takeOfferedInstall('t1')).toBe(false)
    // The page clear again: the site has not had its one yet.
    uiStore.set({ siteInfoOpen: false })
    autoOpenInstall(OFFER)
    expect(run).toHaveBeenCalledWith('webapp.openInstall', { tabId: 't1' })
  })

  it('marks the offer’s tab alone: a prompt for another tab is the user’s', () => {
    autoOpenInstall(OFFER)
    expect(takeOfferedInstall('t2')).toBe(false)
    // Asked for the wrong tab, the marker is spent all the same: one prompt follows one offer.
    expect(takeOfferedInstall('t1')).toBe(false)
  })
})
