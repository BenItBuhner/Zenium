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
 * distance from the frame's top edge, written per frame of the travel straight to the host
 * (`layout.pageOffset`), which moves the placed views' bounds against the seat of the layout
 * they stand in – a move, never a resize (§6). The seat is a store, so the reporter lays out in
 * the same React flush that seats; the offset is a plain number, so a frame re-renders nothing.
 *
 * Android leaves both at 0: its band host moves the WebView by the pull channel, and a report
 * with nothing seated carries no band.
 */
import type { LayoutBand, Rect } from '@shared/types'
import { run } from './api'
import { createStore } from './store'

export const bandSeatStore = createStore<{ seat: number }>({ seat: 0 }, 'bandSeat')

let offset = 0

/** The band's seated height: the page is laid out this far below the frame's top edge. */
export function bandSeat(): number {
  return bandSeatStore.get().seat
}

/** Seat the band at `seat` (0 unseats it): the layout reporter lays the page out under it. */
export function seatBand(seat: number): void {
  if (bandSeatStore.get().seat === seat) return
  bandSeatStore.set({ seat })
}

/** The page is `to` from the frame's top edge now: the host moves its bounds there (per frame). */
export function movePage(to: number): void {
  if (to === offset) return
  offset = to
  run('layout.pageOffset', { offset: to })
}

/** What the layout report says of the band: nothing while nothing is seated and the page is home. */
export function layoutBand(): LayoutBand | undefined {
  const seat = bandSeat()
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
  offset = 0
  bandSeatStore.set({ seat: 0 })
}
