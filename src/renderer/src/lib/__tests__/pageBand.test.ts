import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn() }))

import { run } from '../api'
import {
  bandOffset,
  bandOffsetStore,
  bandSeat,
  bandSeatStore,
  chromePageOffset,
  chromePageOffsetStore,
  chromePageSeat,
  chromePageSeatStore,
  layoutBand,
  moveChromePage,
  movePage,
  pageRectUnderBand,
  resetChromePageBand,
  resetPageBand,
  seatBand,
  seatChromePage
} from '../pageBand'

/*
 * The page-edge band's seam to the desktop's page (motion spec §3.4, §6; lib/pageBand.ts): the
 * seat the page is laid out under – a store, so the reporter lays out in the flush that seats –
 * and the page's present offset – a store too, the one source for everything that moves with
 * the page: written per frame to the host (`layout.pageOffset`), read by the layer a
 * chrome-drawn page rides on (`PageBandLayer`), and named beside the seat in the layout report,
 * so the host places the views by their difference.
 */

const AREA = { x: 260, y: 48, width: 1000, height: 740 }

beforeEach(() => {
  resetPageBand()
  resetChromePageBand()
  vi.mocked(run).mockClear()
})

afterEach(() => {
  resetPageBand()
  resetChromePageBand()
})

describe('the seat', () => {
  it('starts at 0, is a store the reporter can read, and is written once per change', () => {
    expect(bandSeat()).toBe(0)
    const heard: number[] = []
    const off = bandSeatStore.subscribe(() => heard.push(bandSeatStore.get().seat))
    seatBand(56)
    seatBand(56)
    seatBand(76)
    seatBand(0)
    off()
    expect(heard).toEqual([56, 76, 0])
    expect(bandSeat()).toBe(0)
  })

  it('insets the page’s rect at its top by the seat, never past the rect’s height; 0 leaves the rect itself', () => {
    expect(pageRectUnderBand(AREA, 0)).toBe(AREA)
    expect(pageRectUnderBand(AREA, 56)).toEqual({ x: 260, y: 104, width: 1000, height: 684 })
    expect(pageRectUnderBand(AREA, 76)).toEqual({ x: 260, y: 124, width: 1000, height: 664 })
    expect(pageRectUnderBand({ ...AREA, height: 40 }, 56)).toEqual({
      x: 260,
      y: 88,
      width: 1000,
      height: 0
    })
  })
})

describe('the offset', () => {
  it('goes to the host per frame as layout.pageOffset, and a frame that moves nothing says nothing', () => {
    movePage(12.5)
    movePage(12.5)
    movePage(31)
    movePage(56)
    expect(vi.mocked(run).mock.calls).toEqual([
      ['layout.pageOffset', { offset: 12.5 }],
      ['layout.pageOffset', { offset: 31 }],
      ['layout.pageOffset', { offset: 56 }]
    ])
  })

  it('is a store the chrome’s own page layer reads – the one number the host hears, written once per frame that moves', () => {
    expect(bandOffset()).toBe(0)
    const heard: number[] = []
    const off = bandOffsetStore.subscribe(() => heard.push(bandOffsetStore.get().offset))
    movePage(12.5)
    movePage(12.5)
    movePage(31)
    movePage(56)
    movePage(0)
    off()
    expect(heard).toEqual([12.5, 31, 56, 0])
    expect(heard).toEqual(
      vi.mocked(run).mock.calls.map(([, args]) => (args as { offset: number }).offset)
    )
    expect(bandOffset()).toBe(0)
  })

  it('is named beside the seat in the layout report, and nothing is said while nothing is seated and the page is home', () => {
    expect(layoutBand()).toBeUndefined()
    // An open's departure: the page is laid out under the height before it has moved.
    seatBand(56)
    expect(layoutBand()).toEqual({ seat: 56, offset: 0 })
    movePage(30)
    expect(layoutBand()).toEqual({ seat: 56, offset: 30 })
    movePage(56)
    expect(layoutBand()).toEqual({ seat: 56, offset: 56 })
    // A leave's departure: the page is laid out home while it is still down.
    seatBand(0)
    expect(layoutBand()).toEqual({ seat: 0, offset: 56 })
    movePage(0)
    expect(layoutBand()).toBeUndefined()
  })

  it('resets with the seat (tests)', () => {
    seatBand(76)
    movePage(76)
    resetPageBand()
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(0)
    expect(layoutBand()).toBeUndefined()
  })
})

/*
 * The chrome page's pair (Android's band host, `lib/band/androidHost.ts`): the seat and the
 * offset of a page the chrome draws itself on the host that moves its page views another way
 * (the pull channel) and lays nothing out by rects. The layer's alone (`PageBandLayer` with
 * `source="chrome-page"`): the core is never told, the layout report never carries it, and the
 * desktop's pair above is untouched by it – in effect, and in what the report says.
 */
describe("the chrome page's pair", () => {
  it('is seated and moved on its own stores under the same contract, the core never told', () => {
    expect(chromePageSeat()).toBe(0)
    expect(chromePageOffset()).toBe(0)
    const seats: number[] = []
    const offsets: number[] = []
    const offSeat = chromePageSeatStore.subscribe(() => seats.push(chromePageSeat()))
    const offOffset = chromePageOffsetStore.subscribe(() => offsets.push(chromePageOffset()))
    expect(moveChromePage(12.5)).toBe(true)
    expect(moveChromePage(12.5)).toBe(false)
    expect(moveChromePage(56)).toBe(true)
    seatChromePage(56)
    seatChromePage(56)
    seatChromePage(0)
    expect(moveChromePage(0)).toBe(true)
    offSeat()
    offOffset()
    expect(offsets).toEqual([12.5, 56, 0])
    expect(seats).toEqual([56, 0])
    expect(vi.mocked(run)).not.toHaveBeenCalled()
  })

  it("reports NOTHING to the layout: a chrome page's travel and rest leave the desktop's pair at 0 and layoutBand() silent", () => {
    moveChromePage(30)
    expect(layoutBand()).toBeUndefined()
    moveChromePage(56)
    seatChromePage(56)
    expect(chromePageSeat()).toBe(56)
    expect(chromePageOffset()).toBe(56)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(0)
    expect(layoutBand()).toBeUndefined()
    seatChromePage(0)
    moveChromePage(0)
    expect(layoutBand()).toBeUndefined()
  })

  it("leaves the desktop's travel and rest reported exactly as before, with the chrome page's pair written beside them", () => {
    // The desktop's open: seated at the departure, the frames to the host, the rest at the
    // height – `{seat, offset}` named in the report throughout, as the test above pins.
    seatBand(56)
    movePage(30)
    expect(layoutBand()).toEqual({ seat: 56, offset: 30 })
    // A chrome page's pair written (as if Android's host ran beside – it never does on one
    // platform): the report does not hear it, before or after.
    seatChromePage(76)
    moveChromePage(76)
    expect(layoutBand()).toEqual({ seat: 56, offset: 30 })
    movePage(56)
    expect(layoutBand()).toEqual({ seat: 56, offset: 56 })
    expect(vi.mocked(run).mock.calls).toEqual([
      ['layout.pageOffset', { offset: 30 }],
      ['layout.pageOffset', { offset: 56 }]
    ])
    // At rest under the seated band the report holds `{56, 56}`; the leave's departure lays the
    // page out home while it is still down; home says nothing.
    seatBand(0)
    expect(layoutBand()).toEqual({ seat: 0, offset: 56 })
    movePage(0)
    expect(layoutBand()).toBeUndefined()
    expect(chromePageSeat()).toBe(76)
    expect(chromePageOffset()).toBe(76)
  })

  it('resets on its own (tests), the desktop’s pair untouched by it', () => {
    seatBand(56)
    movePage(56)
    seatChromePage(76)
    moveChromePage(76)
    resetChromePageBand()
    expect(chromePageSeat()).toBe(0)
    expect(chromePageOffset()).toBe(0)
    expect(layoutBand()).toEqual({ seat: 56, offset: 56 })
  })
})
