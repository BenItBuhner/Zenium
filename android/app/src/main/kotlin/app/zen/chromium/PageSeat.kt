package app.zen.chromium

/**
 * How a tab's view carries the page-edge band's displacement, device px: the pure part of
 * [TabWebView.setBandSeat] and [TabHost.setBandSeat] (motion spec §3.4 Android, the Design
 * Lead's rule on #758 extended to documents).
 *
 * The band's spring writes the page's OFFSET down the pull channel – `lib/pull.ts` →
 * `view.setPullOffset` → [TabWebView.setPullOffset] – and the band's host writes, beside it,
 * how much of that offset the LAYOUT carries: the SEAT (`view.setBandSeat`). The view is placed
 * a seat lower and a seat shorter ([BarHidePlacement.of]'s `seatPx`) and translated by the
 * rest, so its top on screen is always the offset: at rest the seat is the band's height and
 * the translation 0 – the view's bottom at its frame's bottom, a long page scrolling to its
 * last line above the edge instead of leaving it under the band – and through a travel the
 * seat is the lesser of the band's seat and the destination, the frames moving the translation
 * alone. A seat that changes under a standing offset changes the layout and the translation in
 * the one message, so no frame between the two can show the page anywhere but where it was.
 * A pull that takes the page over has the whole displacement (the seat is written 0 before its
 * first frame): the hang the pull opens below the frame is clipped as before ([hangPx]).
 */
object PageSeat {
    /** The view's `translationY`: the offset the seat does not carry, plus the hiding bar's slide. */
    fun translation(pullOffsetPx: Float, seatPx: Int, barShiftPx: Float): Float = pullOffsetPx - seatPx + barShiftPx

    /**
     * How far the view's laid-out bottom hangs below its frame's bottom edge for the offset the
     * layout does not carry (0 seated at rest; the pull's whole offset with no seat): what the
     * outline clips off its bottom and what makes the strip there the chrome's ([StripTouchRule]).
     */
    fun hangPx(pullOffsetPx: Float, seatPx: Int): Float = (pullOffsetPx - seatPx).coerceAtLeast(0f)
}
