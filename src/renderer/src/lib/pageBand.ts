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
 * Android leaves the seat at 0: its band host moves the WebView by the pull channel, and a
 * report with nothing seated carries no band. For a page the chrome draws itself – a
 * `render: 'chrome'` page, the phone's new tab page – it writes the OFFSET alone
 * (`moveChromePage`): `PageBandLayer` rides on it as on the desktop, and the core is not told,
 * since there is no view under such a page for it to move (`core/pages.ts`) and the band's
 * offset there is a translation of the chrome's own layer, never a layout.
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
 * A page the chrome draws itself is `to` from the frame's top edge now (per frame), on a host
 * that moves its page views another way (Android's band host, over the pull channel): the store
 * carries it to `PageBandLayer` alone; the core, which has no view under such a page, is not
 * told. Returns whether the offset changed.
 */
export function moveChromePage(to: number): boolean {
  if (to === bandOffsetStore.get().offset) return false
  bandOffsetStore.set({ offset: to })
  return true
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
