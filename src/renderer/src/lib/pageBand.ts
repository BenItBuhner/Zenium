/**
 * The page-edge band's seam to the page on a host that lays the page out by rects – the desktop
 * (motion spec §3.4): the page views are placed where the chrome reports them, so the band moves
 * the page by telling the host where it is.
 *
 * Two numbers. The SEAT is the band's height the page is laid out under: the layout reporter
 * (`content/useLayoutReporter.ts`) insets the page's rect by it at the top and names it in the
 * report, so the page is laid out ONCE per travel – at the open's rest, when the band seats its
 * height, and at a leave's start, when it seats 0 (`BandSeam.depart`): the page's bottom rides
 * past the frame's edge while it travels (clipped by the window, as Android's WebView is by its
 * container) and never leaves the frame bare. The OFFSET is where the page is right now, its
 * distance from the frame's top edge, written per frame of the travel to the host
 * (`layout.pageOffset`), which moves the placed views' bounds against the seat of the layout
 * they stand in – a move, never a resize (§6). The seat is a store, so the reporter lays out in
 * the same React flush that seats. The offset is a store too – the one source for everything
 * that moves with the page: the core hears each write as `layout.pageOffset` and moves the
 * views; a page the chrome draws itself (Settings, History – no view under it) rides on the
 * same number through `content/PageBandLayer.tsx`, which reads the store without React, so a
 * frame of the travel re-renders nothing.
 *
 * Android's band host (`lib/band/androidHost.ts`) never writes these two: it moves the WebView
 * by the pull channel – a document is translated at rest, never laid out under the band – and
 * a report with nothing seated carries no band. For a page the chrome draws itself – a
 * `render: 'chrome'` page, the phone's new tab page – it writes the CHROME PAGE'S pair below
 * (`seatChromePage`, `moveChromePage`) under the same contract (the seat the lesser of itself
 * and the destination as a travel departs, the band's height at its rest; the offset per
 * frame), so `PageBandLayer` rides on it there as on the desktop's pair here – translated
 * through a travel, seated at rest with its box inset by the band's height, so a long chrome
 * page scrolls to its last row. That pair is the layer's alone: no view stands under such a
 * page for the core to inset or move (`core/pages.ts`), so the layout report never carries it –
 * `layoutBand()` reads the desktop's pair, unchanged.
 */
import type { LayoutBand, Rect } from '@shared/types'
import { run } from './api'
import { createStore } from './store'

export const bandSeatStore = createStore<{ seat: number }>({ seat: 0 }, 'bandSeat')
/** Where the page is right now – its distance from the frame's top edge – as the last frame put it. */
export const bandOffsetStore = createStore<{ offset: number }>({ offset: 0 }, 'bandOffset')

/** The band's seated height: the page is laid out this far below the frame's top edge. */
export function bandSeat(): number {
  return bandSeatStore.get().seat
}

/** The page's present offset from the frame's top edge (0 at home). */
export function bandOffset(): number {
  return bandOffsetStore.get().offset
}

/** Seat the band at `seat` (0 unseats it): the layout reporter lays the page out under it. */
export function seatBand(seat: number): void {
  if (bandSeatStore.get().seat === seat) return
  bandSeatStore.set({ seat })
}

/**
 * The page is `to` from the frame's top edge now (per frame): the store carries it to whatever
 * the chrome draws for the page, the host moves the placed views' bounds there.
 */
export function movePage(to: number): void {
  if (to === bandOffsetStore.get().offset) return
  bandOffsetStore.set({ offset: to })
  run('layout.pageOffset', { offset: to })
}

/**
 * The CHROME PAGE'S pair: the band's seat and offset for a page the chrome draws itself on a
 * host that moves its page views another way – Android's band host, over the pull channel –
 * and lays nothing out by rects. Written by that host alone, read by `PageBandLayer` alone
 * (mounted with `source="chrome-page"` where that host is), under the pair above's contract;
 * never part of the layout report, which is the desktop's pair's (`layoutBand`), since there
 * is no view under such a page for the core to inset or move.
 */
export const chromePageSeatStore = createStore<{ seat: number }>({ seat: 0 }, 'chromePageSeat')
export const chromePageOffsetStore = createStore<{ offset: number }>(
  { offset: 0 },
  'chromePageOffset'
)

/** The chrome page's seated height: its layer's box is inset this far at the top. */
export function chromePageSeat(): number {
  return chromePageSeatStore.get().seat
}

/** The chrome page's present offset from the frame's top edge (0 at home). */
export function chromePageOffset(): number {
  return chromePageOffsetStore.get().offset
}

/** Seat the chrome page's layer at `seat` (0 unseats it): its box is laid out under the band, the layout report untouched. */
export function seatChromePage(seat: number): void {
  if (chromePageSeatStore.get().seat === seat) return
  chromePageSeatStore.set({ seat })
}

/**
 * A page the chrome draws itself is `to` from the frame's top edge now (per frame): the store
 * carries it to `PageBandLayer` alone; the core, which has no view under such a page, is not
 * told. Returns whether the offset changed.
 */
export function moveChromePage(to: number): boolean {
  if (to === chromePageOffsetStore.get().offset) return false
  chromePageOffsetStore.set({ offset: to })
  return true
}

/** Forget the chrome page's seat and offset (tests). */
export function resetChromePageBand(): void {
  chromePageOffsetStore.set({ offset: 0 })
  chromePageSeatStore.set({ seat: 0 })
}

/** What the layout report says of the band: nothing while nothing is seated and the page is home. */
export function layoutBand(): LayoutBand | undefined {
  const seat = bandSeat()
  const offset = bandOffset()
  return seat === 0 && offset === 0 ? undefined : { seat, offset }
}

/** The page's rect under the band's seat: `area` less the seat at its top. */
export function pageRectUnderBand(area: Rect, seat: number): Rect {
  if (seat <= 0) return area
  const inset = Math.min(seat, area.height)
  return { x: area.x, y: area.y + inset, width: area.width, height: area.height - inset }
}

/** Forget the seat and the offset (tests). */
export function resetPageBand(): void {
  bandOffsetStore.set({ offset: 0 })
  bandSeatStore.set({ seat: 0 })
}
