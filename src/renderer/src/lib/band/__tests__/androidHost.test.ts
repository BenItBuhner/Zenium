import { Info } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  bandStore,
  resetBands,
  showBand,
  shownBand,
  type BandDismissReason,
  type BandOptions
} from '@renderer/lib/band'
import { browserStore } from '@renderer/lib/browserStore'
import { viewportStore } from '@renderer/lib/formFactor'
import {
  bandOffset,
  bandOffsetStore,
  bandSeat,
  bandSeatStore,
  resetPageBand
} from '@renderer/lib/pageBand'
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

vi.mock('@renderer/lib/api', () => ({ cmd: vi.fn(), run: vi.fn() }))

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

/**
 * Two web tabs, the phone's new tab page (drawn by the chrome over `zen://blank` – no view under
 * it) and a private tab in one space, `activeTabId` in front – what the stores' listeners read.
 */
function stateWith(activeTabId: string): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [
      {
        id: 's1',
        name: 'Work',
        containerId: 'default',
        tabIds: ['t1', 't2', 'ntp', 'settings', 'p1'],
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    tabs: {
      t1: tab('t1'),
      t2: tab('t2'),
      ntp: tab('ntp', 'zen://blank'),
      settings: tab('settings', 'zen://settings'),
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
    viewportStore.set({ formFactor: 'phone' })
    browserStore.set({ state: stateWith('t1') })
    uiStore.set({ frameDialogsOpen: 0, frameDialogCover: 0 })
    resetBands()
    resetPageBand()
  })
  afterEach(() => {
    host?.release()
    holdPage('t1', 0)
    holdPage('t2', 0)
    abortPull()
    setPageHold(null)
    setPullHost(null)
    browserStore.set({ state: null })
    viewportStore.set({ formFactor: 'desktop' })
    resetBands()
    resetPageBand()
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
    // The phone's new tab page is drawn by the chrome over `zen://blank`: a state stands on it
    // through the chrome's own layer (`PageBandLayer`, the Lead's (B) follow-up), an offer never.
    browserStore.set({ state: stateWith('ntp') })
    expect(bandStore.get()).toMatchObject({ front: 'ntp', ok: true, offers: false })
    browserStore.set({ state: stateWith('settings') })
    expect(bandStore.get()).toMatchObject({ front: 'settings', ok: true, offers: false })
    browserStore.set({ state: stateWith('t2') })
    expect(bandStore.get()).toMatchObject({ front: 't2', ok: true, offers: true })
  })

  it("a chrome-drawn page in front (Settings, the phone's new tab page): the band's frames go to the layer's offset store, not the pull channel, and the core is not told; the travel translates (seat 0), the rest SEATS the layer at the band's height", () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state())
    // The entrance: depart toward 56 from shut seats nothing; the frames translate.
    host.depart(56)
    host.translate(24)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(24)
    host.translate(56)
    expect(bandSeat()).toBe(0)
    // At rest the band is seated: seat 56, offset 56 – the layer's transform is '' and its box
    // is inset by the band's height (`PageBandLayer`: `top: seat`, `translateY(offset − seat)`).
    host.rest(56)
    expect(written).toEqual([])
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    expect(vi.mocked(run)).not.toHaveBeenCalled()
    // The leave: depart toward 0 unseats before the first frame (the layer's box full-frame,
    // translated by 56 – the same place), the frames translate home, the rest at 0 is home.
    host.depart(0)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(56)
    host.translate(30)
    host.translate(0)
    host.rest(0)
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([])
    // The phone's new tab page the same.
    browserStore.set({ state: stateWith('ntp') })
    host.depart(56)
    host.translate(56)
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(0)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    expect(written).toEqual([])
  })

  it('a two-line state seats at 76; a re-target on the open band seats at the lesser height for the travel and at the new height at rest (the desktop’s depart/rest)', () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state({ detail: 'Some pages may not load' }))
    host.depart(76)
    host.translate(76)
    host.rest(76)
    expect(bandSeat()).toBe(76)
    expect(bandOffset()).toBe(76)
    // 76 → 56: the seat drops to 56 as the travel departs (the layer's box inset by 56,
    // translated by the 20 still to travel), the frames bring the offset down, the rest holds.
    host.depart(56)
    expect(bandSeat()).toBe(56)
    expect(bandOffset()).toBe(76)
    host.translate(66)
    host.translate(56)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    expect(bandOffset()).toBe(56)
    // 56 → 76: the seat stays at 56 through the travel (the layer rides down past the frame's
    // edge), and seats at 76 at rest.
    host.depart(76)
    expect(bandSeat()).toBe(56)
    host.translate(70)
    host.translate(76)
    expect(bandSeat()).toBe(56)
    host.rest(76)
    expect(bandSeat()).toBe(76)
    expect(written).toEqual([])
  })

  it("a finger's drag on the seated layer (no depart) unseats it at its first frame below the seat, so the page keeps covering the frame; a release short of half returns and re-seats at rest", () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    // The finger takes hold: the first frame at the height moves nothing; the first below it
    // unseats the layer – translated from here (offset 50, seat 0), never a bare strip.
    host.translate(56)
    expect(bandSeat()).toBe(56)
    host.translate(50)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(50)
    host.translate(40)
    expect(bandSeat()).toBe(0)
    // Released short of half: the return is a travel toward 56 (depart keeps 0), and the rest
    // seats again.
    host.depart(56)
    expect(bandSeat()).toBe(0)
    host.translate(48)
    host.translate(56)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    expect(bandOffset()).toBe(56)
    expect(written).toEqual([])
  })

  it('the seat store is written once at the rest and once at the departure – never per frame – and the offset store once per frame that moves', () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state())
    const seats: number[] = []
    const offsets: number[] = []
    const offSeat = bandSeatStore.subscribe(() => seats.push(bandSeat()))
    const offOffset = bandOffsetStore.subscribe(() => offsets.push(bandOffset()))
    host.depart(56)
    host.translate(10)
    host.translate(30)
    host.translate(56)
    host.rest(56)
    host.depart(0)
    host.translate(30)
    host.translate(0)
    host.rest(0)
    offSeat()
    offOffset()
    expect(seats).toEqual([56, 0])
    expect(offsets).toEqual([10, 30, 56, 30, 0])
  })

  it('on a web page the seat is never written: the WebView is translated at rest through the pull channel (its placed rect never laid out under the band)', () => {
    host = createAndroidBandHost()
    showBand(state())
    const seats: number[] = []
    const offSeat = bandSeatStore.subscribe(() => seats.push(bandSeat()))
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(heldPageOffset('t1')).toBe(56)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(0)
    host.depart(0)
    host.translate(0)
    host.rest(0)
    offSeat()
    expect(seats).toEqual([])
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0]
    ])
  })

  it("the band standing as the front page changes kind: the new tab page's layer comes home (seat 0, offset 0) and the web page's WebView takes the offset (a navigation in the same tab), and back – seated again on Settings", () => {
    browserStore.set({ state: stateWith('ntp') })
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    expect(written).toEqual([])
    // The same tab now shows a web page.
    const navigated = stateWith('ntp')
    ;(navigated.tabs as Record<string, { url: string }>).ntp.url = 'https://example.com/landed'
    browserStore.set({ state: navigated })
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([['ntp', 56]])
    expect(heldPageOffset('ntp')).toBe(56)
    // And a Settings page typed into it: the WebView comes home, the layer takes the band –
    // seated at once, the band being at rest.
    const settings = stateWith('ntp')
    ;(settings.tabs as Record<string, { url: string }>).ntp.url = 'zen://settings/privacy'
    browserStore.set({ state: settings })
    expect(written).toEqual([
      ['ntp', 56],
      ['ntp', 0]
    ])
    expect(heldPageOffset('ntp')).toBe(0)
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    // The band leaves there: the layer comes home, nothing is written to the channel.
    host.depart(0)
    expect(bandSeat()).toBe(0)
    host.translate(20)
    host.translate(0)
    host.rest(0)
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(written).toHaveLength(2)
  })

  it('a tab switch between a web page and a chrome-drawn page under a standing band moves each surface once; the layer is seated on arrival where the band rests', () => {
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(written).toEqual([['t1', 56]])
    expect(bandSeat()).toBe(0)
    browserStore.set({ state: stateWith('settings') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0]
    ])
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    browserStore.set({ state: stateWith('ntp') })
    // Two chrome-drawn pages share the one layer: home and back at the same offset and seat.
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    expect(written).toHaveLength(2)
    browserStore.set({ state: stateWith('t2') })
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t2', 56]
    ])
  })

  it('leaving a seated chrome page for a web page, the layer is put home – seat 0, offset 0 – BEFORE the WebView is written to (the layout reporter never sees a seat with a WebView in front)', () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    const order: string[] = []
    const offSeat = bandSeatStore.subscribe(() => order.push(`seat ${bandSeat()}`))
    const offOffset = bandOffsetStore.subscribe(() => order.push(`offset ${bandOffset()}`))
    setPullHost({
      setOffset: (tabId, offset) => {
        written.push([tabId, offset])
        order.push(`pull ${tabId} ${offset}`)
      }
    })
    browserStore.set({ state: stateWith('t2') })
    offSeat()
    offOffset()
    expect(order).toEqual(['offset 0', 'seat 0', 'pull t2 56'])
    expect(bandSeat()).toBe(0)
    expect(heldPageOffset('t2')).toBe(56)
  })

  it('a chrome page arriving under a band mid-travel takes the offset translated (seat 0); the rest then seats it', () => {
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(30)
    browserStore.set({ state: stateWith('settings') })
    expect(written).toEqual([
      ['t1', 30],
      ['t1', 0]
    ])
    expect(bandOffset()).toBe(30)
    expect(bandSeat()).toBe(0)
    host.translate(56)
    expect(bandSeat()).toBe(0)
    host.rest(56)
    expect(bandSeat()).toBe(56)
    expect(bandOffset()).toBe(56)
  })

  it("a tab-scoped band's seat does not follow the switch onto a chrome page it does not stand on", () => {
    host = createAndroidBandHost()
    showBand(offer({ tabId: 't1' }))
    host.depart(76)
    host.translate(76)
    host.rest(76)
    browserStore.set({ state: stateWith('settings') })
    expect(shownBand()).toBeNull()
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(0)
    // The cut the band component makes for it (`jump(0)`): nothing moves, the seat stays 0.
    host.depart(0)
    host.translate(0)
    host.rest(0)
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([
      ['t1', 76],
      ['t1', 0]
    ])
  })

  it("the layer's offset is published once per frame and only when it changes (PageBandLayer reads it without React)", () => {
    browserStore.set({ state: stateWith('settings') })
    host = createAndroidBandHost()
    showBand(state())
    const frames: number[] = []
    const off = bandOffsetStore.subscribe(() => frames.push(bandOffset()))
    host.translate(10)
    host.translate(10)
    host.translate(56)
    host.rest(56)
    off()
    expect(frames).toEqual([10, 56])
  })

  it('release puts the layer home too – its seat with it', () => {
    browserStore.set({ state: stateWith('ntp') })
    host = createAndroidBandHost()
    showBand(state())
    host.depart(56)
    host.translate(56)
    host.rest(56)
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    host.release()
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([])
    host = null
  })

  it("the tablet's new tab page is a served zen://newtab document in the tab's own view: a state stands on it, an offer never (§10)", () => {
    viewportStore.set({ formFactor: 'tablet' })
    const tabletState = stateWith('ntp')
    ;(tabletState.tabs as Record<string, { url: string }>).ntp.url = 'zen://newtab'
    browserStore.set({ state: tabletState })
    host = createAndroidBandHost()
    expect(bandStore.get()).toMatchObject({ front: 'ntp', ok: true, offers: false })
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
    // The phone's new tab page has no view under it to move: the old page comes home through the
    // channel and the chrome's own layer takes the band's offset (`PageBandLayer`), seated – the
    // band rests – and nothing is written to the channel for it.
    browserStore.set({ state: stateWith('ntp') })
    expect(written).toEqual([
      ['t1', 56],
      ['t1', 0],
      ['t2', 56],
      ['t2', 0]
    ])
    expect(bandOffset()).toBe(56)
    expect(bandSeat()).toBe(56)
    // A frame there moves the layer, never the channel (a finger's: the layer unseated for it).
    host.translate(40)
    expect(bandOffset()).toBe(40)
    expect(bandSeat()).toBe(0)
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
