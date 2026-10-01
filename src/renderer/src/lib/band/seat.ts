/**
 * The WebView's seat under a standing page-edge band (motion spec §3.4 Android): the registry
 * through which the Android band host (`androidHost.ts`) tells the Kotlin side how much of a
 * DOCUMENT's displacement the layout carries. The touch shell's boot registers the bridge's
 * `view.setBandSeat {tabId, seat}` (CSS px) here, which lands in `TabHost.setBandSeat`: the
 * tab's view placed at top = seat, height = frame − seat, and translated by the pull channel's
 * offset less the seat (`PageSeat.kt`) – 0 at rest, so a long page scrolls to its last line
 * above the frame's bottom edge instead of leaving it under the band, as #758's `PageBandLayer`
 * seats the chrome-drawn pages (the Design Lead's rule, extended to documents).
 *
 * The band's host is the one writer; the pull channel (`lib/pull.ts`) is not touched – the
 * offset still travels there whole, and a pull that takes the page over owns the whole
 * displacement (the host writes the seat 0 first). With no host registered (the desktop, tests
 * that register none) a seat goes nowhere.
 */
export interface BandSeatHost {
  /** The document `tabId`'s view sits `seat` CSS px into its frame at rest (0: placed as reported). */
  setSeat(tabId: string, seat: number): void
}

let seatHost: BandSeatHost | null = null

/** The platform's seat channel; null unregisters it (the desktop has none). */
export function setBandSeatHost(host: BandSeatHost | null): void {
  seatHost = host
}

/** Seat `tabId`'s document `seat` CSS px into its frame (0 unseats). */
export function seatDocument(tabId: string, seat: number): void {
  seatHost?.setSeat(tabId, Math.max(0, seat))
}
