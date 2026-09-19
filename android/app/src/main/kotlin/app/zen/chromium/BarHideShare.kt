package app.zen.chromium

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/**
 * Shares a drag's vertical travel between a top-docked bar that hides on scroll and the page
 * under it: the pure part of [BarHideGesture], device px throughout. Chrome's top controls take
 * a scroll before the page does – the first px of a drag down the page slide the toolbar off
 * while the page holds still under it, the first px of a drag back up bring it back, and only
 * the rest scrolls the page. Here the same is done by showing the page's WebView a finger that
 * holds still while the bar moves and moves on once the bar has reached its end ([seenY]): one
 * gesture throughout, so nothing of its own – the slop it has passed, the scroll it has begun,
 * the fling it will compute – is lost.
 *
 * The finger is measured on the screen (raw coordinates): the WebView slides with the bar, so in
 * its own coordinates a finger that holds still reads as moving by the bar's travel.
 *
 * The slop crossing goes through to the WebView as a crossing – the slop and [slopPass] past it
 * – so it begins its scroll (and drops its long press); what the finger has travelled beyond
 * that in the same event is the bar's, like the moves after it. A slow frame delivers a stretch
 * of the drag batched into that one event, and passed whole it would scroll the page by the
 * bar's share.
 */
class BarHideShare(private val slop: Float, private val slopPass: Float) {
    /** The bar's offset as this side counts it, what the next take is measured against; re-read from the chrome between fingers. */
    var mirror = 0f
    /** How much of the finger's travel the bar has taken this gesture (added to the y the WebView sees). */
    var consumed = 0f
        private set
    /** The bar may take travel from this gesture: it was docked at the top and free to hide when the finger landed. */
    var taking = false
        private set
    private var downX = 0f
    private var downY = 0f
    private var lastY = 0f
    private var downLocalY = 0f
    private var passedSlop = false
    private var horizontal = false
    private var multiTouch = false

    /** A finger lands at (`x`, `y`) on the screen and `localY` in the WebView; `taking`: the bar is docked at the top and may hide. */
    fun down(x: Float, y: Float, localY: Float, taking: Boolean) {
        this.taking = taking
        downX = x
        downY = y
        lastY = y
        downLocalY = localY
        consumed = 0f
        passedSlop = false
        horizontal = false
        multiTouch = false
    }

    /** A second finger: the bar takes no more of this gesture. */
    fun pointerDown() {
        multiTouch = true
    }

    /**
     * The finger is at (`x`, `y`) on the screen: what the bar takes of the move – positive when
     * it hides further, negative when it comes back, 0 when nothing. `travel` is the bar's full
     * travel (0 when there is no top-docked bar to take any right now) and `pageBelow` whether
     * the page has anything left to scroll to (a page at its bottom keeps its bar).
     */
    fun move(x: Float, y: Float, travel: Int, pageBelow: Boolean): Float {
        val dy = y - lastY
        lastY = y
        if (!taking || multiTouch || horizontal || travel <= 0) return 0f
        if (passedSlop) return take(dy, travel, pageBelow)
        val dx = x - downX
        val travelled = y - downY
        if (hypot(dx, travelled) <= slop) return 0f
        passedSlop = true
        horizontal = abs(dx) > abs(travelled)
        if (horizontal) return 0f
        val beyond = abs(travelled) - slop - slopPass
        return if (beyond > 0f) take(if (travelled < 0f) -beyond else beyond, travel, pageBelow) else 0f
    }

    /** The y the WebView is shown for a finger at `y` on the screen: the one that landed, moved by the finger's travel less the bar's take. */
    fun seenY(y: Float): Float = downLocalY + (y - downY) + consumed

    /** The finger moved `dy` (negative up the screen, i.e. down the page): what of it the bar takes. */
    private fun take(dy: Float, travel: Int, pageBelow: Boolean): Float {
        if (dy < 0f) {
            if (mirror >= travel || !pageBelow) return 0f
            val take = min(-dy, travel - mirror)
            mirror += take
            consumed += take
            return take
        }
        if (dy > 0f && mirror > 0f) {
            val take = min(dy, mirror)
            mirror -= take
            consumed -= take
            return -take
        }
        return 0f
    }
}
