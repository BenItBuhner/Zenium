import { Info } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import {
  bandStore,
  resetBands,
  showBand,
  shownBand,
  type BandDismissReason,
  type BandOptions
} from '@renderer/lib/band'
import { browserStore } from '@renderer/lib/browserStore'
import {
  abortPull,
  dispatchPullEvent,
  heldPageOffset,
  holdPage,
  setPageHold,
  setPullHost
} from '@renderer/lib/pull'
import { uiStore } from '@renderer/lib/ui'
import { createAndroidBandHost, type AndroidBandHost } from '../androidHost'

function tab(
  id: string,
  url = `https://example.com/${id}`,
  containerId = 'default'
): Record<string, unknown> {
  return {
    id,
    url,
    title: id,
    containerId,
    pinned: false,
    essential: false,
    folderId: null,
    splitGroupId: null,
    discarded: false,
    loading: false
  }
}

/** Two web tabs and the new tab page in one space, `activeTabId` in front – what the stores' listeners read. */
function stateWith(activeTabId: string): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [
      {
        id: 's1',
        name: 'Work',
        containerId: 'default',
        tabIds: ['t1', 't2', 'ntp', 'p1'],
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    tabs: {
      t1: tab('t1'),
      t2: tab('t2'),
      ntp: tab('ntp', 'zen://newtab'),
      p1: tab('p1', 'https://example.com/p1', 'private')
    },
    essentialTabIds: [],
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

function offer(extra: Partial<BandOptions> = {}): BandOptions {
  return { key: 'install', form: 'offer', icon: Info, title: 'Install?', ...extra }
}

function state(extra: Partial<BandOptions> = {}): BandOptions {
  return { key: 'offline', form: 'state', icon: Info, title: 'No internet connection', ...extra }
}

describe('createAndroidBandHost – the BandSeam over the pull channel, and the model’s front', () => {
  let written: Array<[string, number]>
  let host: AndroidBandHost | null

  beforeEach(() => {
    written = []
    host = null
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    setPullHost({ setOffset: (tabId, offset) => written.push([tabId, offset]) })
    browserStore.set({ state: stateWith('t1') })
    uiStore.set({ frameDialogsOpen: 0, frameDialogCover: 0 })
    resetBands()
  })
  afterEach(() => {
    host?.release()
    holdPage('t1', 0)
    holdPage('t2', 0)
    abortPull()
    setPageHold(null)
    setPullHost(null)
    browserStore.set({ state: null })
    resetBands()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('tells the model which tab is in front, whether a band may stand there and what covers it', () => {
    host = createAndroidBandHost()
    expect(bandStore.get()).toMatchObject({ front: 't1', ok: true, covered: false })
    uiStore.set({ frameDialogsOpen: 1 })
    expect(bandStore.get()).toMatchObject({ front: 't1', ok: true, covered: true })
    uiStore.set({ frameDialogsOpen: 0 })
    expect(bandStore.get().covered).toBe(false)
    browserStore.set({ state: stateWith('ntp') })
    expect(bandStore.get()).toMatchObject({ front: 'ntp', ok: false })
    browserStore.set({ state: stateWith('t2') })
    expect(bandStore.get()).toMatchObject({ front: 't2', ok: true, offers: true })
  })

  it("a private tab in front withholds offers, not states – the model hears it as the host's word", () => {
    host = createAndroidBandHost()
    showBand(offer())
    showBand(state())
    browserStore.set({ state: stateWith('p1') })
    expect(bandStore.get()).toMatchObject({ front: 'p1', ok: true, offers: false })
    expect(shownBand()?.key).toBe('offline')
    expect(bandStore.get().entries).toHaveLength(2)
    browserStore.set({ state: stateWith('t1') })
    expect(bandStore.get().offers).toBe(true)
  })

  it("writes the band's frames for the page a band stands on through the one host channel", () => {
    host = createAndroidBandHost()
    showBand(offer())
    host.translate(24)
    host.translate(56)
    expect(host.offset).toBe(56)
    expect(heldPageOffset('t1')).toBe(56)
    host.rest(56)
    // At rest at its height nothing more is written: the page stays where the hold has it.
    expect(written).toEqual([
      ['t1', 24],
      ['t1', 56]
    ])
    host.translate(30)
    host.translate(0)
    host.rest(0)
    expect(heldPageOffset('t1')).toBe(0)
    expect(written).toEqual([
      ['t1', 24],
      ['t1', 56],
      ['t1', 30],
      ['t1', 0]
    ])
    host.paint(0.5)
    expect(written).toHaveLength(4)
  })

  it('a frame with no band standing on the front page moves nothing', () => {
    host = createAndroidBandHost()
    host.translate(56)
    expect(written).toEqual([])
    expect(host.offset).toBe(56)
    // ...until a band stands there.
    showBand(state())
    host.translate(56)
    expect(written).toEqual([['t1', 56]])
  })

  it('a pull on the held page displaces the band: the shown offer goes as the chrome’s doing, the page stays put', () => {
    host = createAndroidBandHost()
    const ends: BandDismissReason[] = []
    showBand(offer({ onDismiss: (reason) => ends.push(reason) }))
    host.translate(76)
    expect(written).toEqual([['t1', 76]])
    dispatchPullEvent('t1', 'start')
    expect(ends).toEqual(['program'])
    expect(bandStore.get().entries).toEqual([])
    expect(bandStore.get().ok).toBe(false)
    // The page did not move, and the band's last frames cannot move it either.
    expect(written).toEqual([['t1', 76]])
    host.translate(40)
    host.translate(0)
    host.rest(0)
    expect(written).toEqual([['t1', 76]])
    abortPull()
    expect(bandStore.get().ok).toBe(true)
  })

  it('a pull on the held page leaves a state standing: it waits, and returns when the pull ends', () => {
    host = createAndroidBandHost()
    const ends: BandDismissReason[] = []
    showBand(state({ onDismiss: (reason) => ends.push(reason) }))
    host.translate(56)
    dispatchPullEvent('t1', 'start')
    expect(ends).toEqual([])
    expect(bandStore.get().entries).toHaveLength(1)
    expect(shownBand()).toBeNull()
    abortPull()
    expect(shownBand()?.key).toBe('offline')
    // The pull put the page home as it ended (its own write); the band's entrance after it
    // moves the page again.
    host.translate(28)
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t1', 28]
    ])
  })

  it('a tab leaving the front has its page put home at once; the page coming to the front takes the window-wide band’s offset', () => {
    host = createAndroidBandHost()
    showBand(state())
    host.translate(56)
    host.rest(56)
    browserStore.set({ state: stateWith('t2') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t2', 56]
    ])
    expect(heldPageOffset('t1')).toBe(0)
    expect(heldPageOffset('t2')).toBe(56)
    // The new tab page is no place for a band: the old page comes home and the new one is not moved.
    browserStore.set({ state: stateWith('ntp') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t2', 56],
      ['t2', 0]
    ])
    // The model's leave for it (no band shown) moves nothing either.
    host.translate(40)
    host.translate(0)
    host.rest(0)
    expect(written).toHaveLength(4)
  })

  it("a tab-scoped band's leave after the switch moves no page it does not hold", () => {
    host = createAndroidBandHost()
    showBand(offer({ tabId: 't1' }))
    host.translate(76)
    host.rest(76)
    browserStore.set({ state: stateWith('t2') })
    expect(shownBand()).toBeNull()
    expect(written).toEqual([
      ['t1', 76],
      ['t1', 0]
    ])
    host.translate(50)
    host.translate(0)
    host.rest(0)
    expect(written).toHaveLength(2)
    // Back on its tab the band returns on its own entrance.
    browserStore.set({ state: stateWith('t1') })
    expect(shownBand()?.key).toBe('install')
    host.translate(30)
    expect(written[2]).toEqual(['t1', 30])
  })

  it('release puts the held page home, tells the model there is no front, and stops listening', () => {
    host = createAndroidBandHost()
    showBand(state())
    host.translate(56)
    host.release()
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0]
    ])
    expect(heldPageOffset('t1')).toBe(0)
    expect(bandStore.get()).toMatchObject({ front: null, ok: false })
    browserStore.set({ state: stateWith('t2') })
    expect(bandStore.get()).toMatchObject({ front: null, ok: false })
    expect(written).toHaveLength(2)
    host = null
  })
})
