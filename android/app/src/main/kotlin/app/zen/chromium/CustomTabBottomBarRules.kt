package app.zen.chromium

import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.tanh

/**
 * The numbers behind the caller's bottom toolbar (CustomTabBottomBar.kt): how much page it takes,
 * where it sits when hidden with the top bar, how far it follows an upward drag and when that
 * drag counts as the swipe-up gesture the caller asked to hear about
 * (`EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE`). Pure, so each has a JVM test.
 */
object CustomTabBottomBarRules {
    /** The row of the caller's buttons: the top toolbar's 56 (its 44 boxes with the bar's own air). */
    const val BUTTON_ROW_DP = 56

    /** Upward travel that counts as the swipe: twice the 16 gutter, well past the touch slop. */
    const val SWIPE_UP_DP = 32

    /** The bar follows the finger no further than this share of its own height. */
    const val DRAG_CAP = 0.5f

    /**
     * The page's bottom margin: the system inset, plus the bar while it is shown. Hidden with the
     * top bar on scroll, the bar gives its height back to the page (§11.5: the page grows at the
     * hide's first frame).
     */
    fun pageBottomMargin(inset: Int, barHeight: Int, shown: Boolean): Int = inset + if (shown) barHeight else 0

    /** How far down the bar slides when hidden: its full extent, inset padding included. */
    fun hiddenTranslation(barHeight: Int, inset: Int): Int = barHeight + inset

    /**
     * The bar's upward offset while a finger drags it: one-to-one at first, then a rubber band
     * that never passes [DRAG_CAP] of the bar's height. `travelUp` is how far the finger has moved
     * up from where it landed (negative means down: the bar stays put). Returns a value >= 0, the
     * bar's `-translationY`.
     */
    fun dragOffset(travelUp: Float, barHeight: Float): Float {
        if (travelUp <= 0f || barHeight <= 0f) return 0f
        val cap = barHeight * DRAG_CAP
        return cap * tanh(travelUp / cap)
    }

    /**
     * [dragOffset] inverted: the upward travel that would have put the bar at `offset`, so a
     * finger landing on a bar still settling from the last drag picks it up where it is rather
     * than snapping it home. An offset at or past the cap (which the band never reaches) reads as
     * the travel that brings the band to within a thousandth of it.
     */
    fun travelFor(offset: Float, barHeight: Float): Float {
        if (offset <= 0f || barHeight <= 0f) return 0f
        val cap = barHeight * DRAG_CAP
        val ratio = (offset / cap).coerceAtMost(0.999f)
        return cap * 0.5f * ln((1f + ratio) / (1f - ratio))
    }

    /** Whether an upward travel of `travelUp` pixels has become the swipe (fires once, at the crossing). */
    fun swipeFires(travelUp: Float, thresholdPx: Float): Boolean = travelUp >= thresholdPx && thresholdPx > 0f

    /** A drag that started on the bar is the bar's once it moves past the slop, up or down. */
    fun claimsDrag(dx: Float, dy: Float, slop: Float): Boolean = abs(dy) > slop && abs(dy) > abs(dx)
}
