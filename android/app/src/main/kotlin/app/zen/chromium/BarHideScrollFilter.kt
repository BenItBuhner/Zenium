package app.zen.chromium

/**
 * What a change of the page's scroll means for the bar that hides on scroll: the pure part of
 * [BarHideGesture]'s reporting, device px throughout. Only a finger's scroll and the fling it
 * leaves count, and of those not everything is the finger's:
 *
 * - The layout's clamp. While the bar is off its edge but not fully, the page is laid out a
 *   band taller ([TabHost.place]); Chromium then has a band less to scroll and, if the page
 *   was within that band of its end, clamps the scroll back – which reaches the view as a
 *   scroll up. Reported, that would bring the bar back, shrink the page, and the next px of the
 *   finger would grow it again: the bar and the content twitching with every frame near the end
 *   of a page, and its last band out of reach. So a hide is not started while the page has less
 *   than the bar's travel left to scroll (the exact condition for no clamp, read when the bar
 *   would leave its edge; a hide already under way keeps going, its layout has grown), and a
 *   scroll up is not the finger's when it lands the page exactly at its end, or when the finger
 *   has been moving the other way – down the page – since the last change.
 * - After the finger lifts, the page's scroll is its fling for [flingGapMs] past the lift and
 *   past every change; later changes (an anchor, a script) move no bar, as in Chrome.
 *
 * A bottom-docked bar follows the reported scroll one to one. A top-docked bar is moved by the
 * finger's travel instead ([BarHideShare]) and hears only the flings from here: one reaching
 * the top, or one up the page under a hidden bar, brings it back.
 */
class BarHideScrollFilter(private val flingGapMs: Long, private val fingerTolerancePx: Float) {
    enum class Verdict {
        /** Not the finger's and not its fling's (nothing on the page, or the layout's clamp): nothing, and no root scroll of the finger's to confirm. */
        NONE,
        /** The finger's (or its fling's), and the bar is not to move for it. */
        HELD,
        /** The chrome is told the change: a bottom-docked bar follows it. */
        REPORT,
        /** The bar comes back on its spring. */
        SHOW
    }

    /** A finger is on the page. */
    var touching = false
        private set
    /** Until when a scroll with no finger on the page is the finger's fling. */
    private var flingUntil = 0L
    /** Where the finger was, on the screen, at the last change that was its own. */
    private var fingerAtChange = 0f
    /** The bar left its edge under this finger or its fling: the page is laid out tall already. */
    var hiding = false
        private set

    fun down(fingerY: Float) {
        touching = true
        flingUntil = 0L
        hiding = false
        fingerAtChange = fingerY
    }

    /** The finger lifted (or the touch was cancelled) at `now`: the fling window opens. */
    fun lifted(now: Long) {
        touching = false
        flingUntil = now + flingGapMs
    }

    /** The chrome's word on the bar: back at its edge, the next hide starts afresh (and is gated afresh). */
    fun barAtRest() {
        hiding = false
    }

    /** A scroll with no finger down is the finger's fling right now. */
    fun flinging(now: Long): Boolean = !touching && now < flingUntil

    /**
     * The page scrolled from `oldScrollY` to `scrollY`, leaving `remaining` px below; the bar is
     * `offset` px off its edge (of `travel`), docked at the `top` or not; the finger is at
     * `fingerY` on the screen; the time is `now`.
     */
    fun scrolled(
        scrollY: Int,
        oldScrollY: Int,
        remaining: Int,
        offset: Float,
        travel: Int,
        top: Boolean,
        fingerY: Float,
        now: Long
    ): Verdict {
        val dt = scrollY - oldScrollY
        if (dt == 0) return Verdict.NONE
        val flinging = flinging(now)
        if (!touching && !flinging) return Verdict.NONE
        if (dt < 0) {
            // A scroll up that lands the page exactly at its end is the layout's clamp: a finger
            // scrolls up from the end, never to it.
            if (remaining <= 0) return Verdict.NONE
            // So is one while the finger has been going the other way.
            if (touching && fingerY < fingerAtChange - fingerTolerancePx) return Verdict.NONE
        }
        if (touching) fingerAtChange = fingerY
        if (flinging) flingUntil = now + flingGapMs
        // The page reached its top without a finger on it (a fling ran out at the top): a bar
        // still off comes back. Under a finger the scroll itself brings it back.
        if (scrollY <= 0 && oldScrollY > 0 && flinging && offset > 0f) {
            flingUntil = 0L
            return Verdict.SHOW
        }
        if (top) {
            // A fling up the page under a hidden bar brings it back, as Chrome's fling shows its controls.
            if (flinging && dt < 0 && offset > 0f) {
                flingUntil = 0L
                return Verdict.SHOW
            }
            return Verdict.HELD
        }
        if (dt > 0 && !hiding && offset <= 0f) {
            // The bar would leave its edge: the page must have the band it is about to be laid out taller by.
            if (remaining < travel) return Verdict.HELD
            hiding = true
        }
        return Verdict.REPORT
    }
}
