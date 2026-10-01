import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
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
import { createAndroidBandHost, pageBusy, type BandHost } from '../androidHost'
import type { BandSignals } from '../signals'

function tab(id: string): Record<string, unknown> {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    containerId: 'default',
    pinned: false,
    essential: false,
    folderId: null,
    splitGroupId: null,
    discarded: false,
    loading: false
  }
}

/** Two web tabs in one space, `activeTabId` in front – what the stores' listeners read. */
function stateWith(activeTabId: string): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [
      {
        id: 's1',
        name: 'Work',
        containerId: 'default',
        tabIds: ['t1', 't2'],
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    tabs: { t1: tab('t1'), t2: tab('t2') },
    essentialTabIds: [],
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

describe('createAndroidBandHost – the seam over the pull channel', () => {
  let written: Array<[string, number]>
  let host: BandHost | null

  beforeEach(() => {
    written = []
    host = null
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    setPullHost({ setOffset: (tabId, offset) => written.push([tabId, offset]) })
    browserStore.set({ state: stateWith('t1') })
    uiStore.set({ frameDialogsOpen: 0, frameDialogCover: 0 })
  })
  afterEach(() => {
    host?.release()
    holdPage('t1', 0)
    holdPage('t2', 0)
    abortPull()
    setPageHold(null)
    setPullHost(null)
    browserStore.set({ state: null })
    vi.unstubAllGlobals()
  })

  it("writes the band's offset through the one host channel and reads it back", () => {
    host = createAndroidBandHost()
    expect(host.setOffset('t1', 24)).toBe(true)
    expect(host.setOffset('t1', 56)).toBe(true)
    expect(host.offset('t1')).toBe(56)
    expect(host.offset('t2')).toBe(0)
    expect(host.setOffset('t1', 0)).toBe(true)
    expect(host.offset('t1')).toBe(0)
    expect(written).toEqual([
      ['t1', 24],
      ['t1', 56],
      ['t1', 0]
    ])
  })

  it('a pull that begins on the held page displaces the band where the page sits', () => {
    host = createAndroidBandHost()
    const heard: Array<[string, number]> = []
    const off = host.onDisplaced((tabId, offset) => heard.push([tabId, offset]))
    host.setOffset('t1', 56)
    dispatchPullEvent('t1', 'start')
    expect(heard).toEqual([['t1', 56]])
    expect(host.offset('t1')).toBe(0)
    expect(pageBusy()).toBe(true)
    // The page did not move, and the band's last frames cannot move it either.
    expect(written).toEqual([['t1', 56]])
    expect(host.setOffset('t1', 40)).toBe(false)
    expect(host.setOffset('t1', 0)).toBe(false)
    expect(written).toEqual([['t1', 56]])
    off()
    dispatchPullEvent('t1', 'cancel', { travel: 0, time: 0 })
  })

  it('a hold is refused while a pull has the page, and the signals say so', () => {
    host = createAndroidBandHost()
    dispatchPullEvent('t1', 'start')
    expect(pageBusy()).toBe(true)
    expect(host.signals().pulling).toBe(true)
    expect(host.setOffset('t1', 56)).toBe(false)
    dispatchPullEvent('t1', 'cancel', { travel: 0, time: 0 })
  })

  it('a tab leaving the front with its page held has the page put home at once', () => {
    host = createAndroidBandHost()
    host.setOffset('t1', 56)
    browserStore.set({ state: stateWith('t2') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0]
    ])
    expect(host.offset('t1')).toBe(0)
    expect(heldPageOffset('t1')).toBe(0)
    // The new front page is free for the band; another switch writes nothing for it unheld.
    expect(host.setOffset('t2', 56)).toBe(true)
    host.setOffset('t2', 0)
    browserStore.set({ state: stateWith('t1') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t2', 56],
      ['t2', 0]
    ])
  })

  it("subscribe hands the current reading at once and every change of the chrome's signals", () => {
    host = createAndroidBandHost()
    const readings: BandSignals[] = []
    const off = host.subscribe((signals) => readings.push(signals))
    expect(readings).toHaveLength(1)
    expect(readings[0]).toMatchObject({ tabId: 't1', webPage: true, covered: false })
    uiStore.set({ frameDialogsOpen: 1 })
    expect(readings).toHaveLength(2)
    expect(readings[1].covered).toBe(true)
    uiStore.set({ frameDialogsOpen: 0 })
    expect(readings).toHaveLength(3)
    expect(readings[2].covered).toBe(false)
    off()
    browserStore.set({ state: stateWith('t2') })
    expect(readings).toHaveLength(3)
  })

  it('release puts the held page home and stops listening', () => {
    host = createAndroidBandHost()
    const readings: BandSignals[] = []
    host.subscribe((signals) => readings.push(signals))
    host.setOffset('t1', 56)
    host.release()
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0]
    ])
    expect(heldPageOffset('t1')).toBe(0)
    const before = readings.length
    browserStore.set({ state: stateWith('t2') })
    expect(readings).toHaveLength(before)
    expect(written).toHaveLength(2)
    host = null
  })
})
