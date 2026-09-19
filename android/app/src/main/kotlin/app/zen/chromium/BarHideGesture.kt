package app.zen.chromium

import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Where the phone bar that hides on scroll is, as the chrome last said (`chrome.setBarHide`, from
 * `lib/barHide.ts`), in device px. Null on a tab host means the bar may not hide right now (the
 * setting is off, the page is internal, a sheet is up) and pages are laid out where the chrome
 * puts them, plain.
 */
class BarHideFrame(
    /** The edge the bar hides off: the phone bar's dock. */
    val edge: Edge,
    /** How far the bar is off its edge, 0 … [travelPx]. */
    val offsetPx: Float,
    /** The band the page gains once the bar is hidden. */
    val travelPx: Int,
    /** Window y of the page's edge on the bar's side with the bar fully shown. */
    val shownEdgePx: Int
) {
    enum class Edge { TOP, BOTTOM }

    /** The bar is off its edge at all (the page is laid out tall, clipped to what the bar has left). */
    val away: Boolean get() = offsetPx > 0f
    /** The bar is fully off. */
    val hidden: Boolean get() = offsetPx >= travelPx

    companion object {
        /** `chrome.setBarHide`'s arguments (CSS px) → device px; null for `{ enabled: false }`. */
        fun parse(args: JSONObject, density: Float): BarHideFrame? {
            if (!args.optBoolean("enabled", true)) return null
            val travel = (args.num("travel") * density).roundToInt()
            if (travel <= 0) return null
            return BarHideFrame(
                if (args.str("edge", "bottom") == "top") Edge.TOP else Edge.BOTTOM,
                (args.num("offset") * density).toFloat().coerceIn(0f, travel.toFloat()),
                travel,
                (args.num("shownEdge") * density).roundToInt()
            )
        }
    }
}

/**
 * The host's half of the bar that hides on scroll (the chrome's is `lib/barHide.ts`), on one
 * tab's WebView. Two jobs.
 *
 * Reporting. The page's scroll goes to the chrome as `start` (a finger down), `move` (how far
 * the page scrolled since the last report, CSS px, positive down the page; at most one report
 * per frame), `end` (the finger lifted, with the time, for the velocity) and `show` (the page
 * pushed against its top, or a fling up under a top-docked bar: the bar comes back). Only a
 * finger's scroll and the fling it leaves count: a page that scrolls itself (an anchor, a
 * script) moves no bar, as in Chrome.
 *
 * Consuming, with the bar docked at the top. Chrome's top controls take a scroll before the page
 * does: the first px of a drag down the page slide the toolbar off while the page holds still
 * under it, the first px of a drag back up bring it back, and only the rest scrolls the page.
 * Here the same is done by shifting the touches the WebView sees by what the bar has taken
 * ([forward]): it sees a finger that holds still while the bar moves and moves on once the bar
 * has reached its end, one gesture throughout, so nothing of its own – the slop it has passed,
 * the scroll it has begun, the fling it will compute – is lost. The bar's offset is mirrored
 * here in device px so the hand-over does not wait on the bridge; the chrome, which clamps the
 * same deltas the same way, stays the truth and the mirror is re-read from it between fingers.
 * With the bar at the bottom nothing is consumed: the page scrolls and the bar follows the
 * scroll, as Chrome's bottom controls do.
 *
 * Touch distances are device pixels here and CSS pixels on the bridge.
 */
class BarHideGesture(
    private val view: TabWebView,
    private val emit: (phase: String, payload: JSONObject?) -> Unit
) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop.toFloat()
    private val density = view.resources.displayMetrics.density

    /** The chrome's latest word on the bar (see [BarHideFrame]); null: the bar may not hide. */
    var frame: BarHideFrame? = null
        set(value) {
            field = value
            // The chrome's offset is the mirror's, except under a finger a top-docked bar is
            // taking travel from: there the mirror leads and the chrome follows a frame behind.
            if (!touching || value?.edge != BarHideFrame.Edge.TOP) mirror = value?.offsetPx ?: 0f
        }

    private var touching = false
    private var multiTouch = false
    /**
     * The finger on the screen (raw coordinates), from the latest real touch. The WebView's own
     * coordinates will not do here: `TabHost.place` slides the view with a top-docked bar, so
     * in them a finger that holds still reads as moving by the bar's travel, and the pull's
     * synthetic touches carry the view's coordinates as their raw ones.
     */
    private var fingerX = 0f
    private var fingerY = 0f
    private var downX = 0f
    private var downY = 0f
    private var lastY = 0f
    /** Where the finger landed, in the WebView's coordinates: the still finger it sees is built from here. */
    private var downLocalY = 0f
    /** The WebView has seen the finger cross the slop: it has a scroll going, and no long press. */
    private var passedSlop = false
    /** The gesture began sideways: the bar leaves it to the page. */
    private var horizontal = false
    /** The bar may take travel from this gesture: it was docked at the top and free to hide when the finger landed. */
    private var taking = false
    /** How much of the finger's travel the bar has taken this gesture (added to the y the WebView sees). */
    private var consumedY = 0f
    /** The bar's offset as this side counts it (device px). */
    private var mirror = 0f
    /** Scroll waiting for the next frame's report, CSS px. */
    private var pending = 0.0
    private var flushPosted = false
    /** Until when a scroll with no finger on the page is the finger's fling. */
    private var flingUntil = 0L

    private val flush = Runnable {
        flushPosted = false
        if (pending == 0.0) return@Runnable
        val delta = (pending * 100).roundToInt() / 100.0
        pending = 0.0
        if (delta != 0.0) emit("move", json("delta" to delta, "time" to SystemClock.uptimeMillis()))
    }

    /** Every touch on the page as it arrives, before anything else has had it. */
    fun onTouch(event: MotionEvent) {
        fingerX = event.rawX
        fingerY = event.rawY
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touching = true
                multiTouch = false
                flingUntil = 0L
                mirror = frame?.offsetPx ?: 0f
                if (frame != null) emit("start", null)
            }
            MotionEvent.ACTION_POINTER_DOWN -> multiTouch = true
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                touching = false
                flingUntil = event.eventTime + FLING_GAP_MS
                flush.run()
                if (frame != null) emit("end", json("time" to event.eventTime))
            }
        }
    }

    /**
     * The WebView's own touch handling, through the bar: with the bar docked at the top, a drag's
     * vertical travel goes to the bar first and the WebView sees the rest. `event` is what the
     * pull decided the WebView gets (a real touch, or a synthetic down or cancel of its making).
     *
     * Everything is measured on the screen ([fingerY]): the finger's travel, the slop, and the
     * finger the WebView is shown – the one that landed, moved by the finger's travel on the
     * screen plus what the bar took of it. The view's own coordinates would carry its slide
     * ([TabHost.place] moves it with the bar, a frame or two after the finger) back into the
     * finger, and Chromium would scroll on it.
     */
    fun forward(event: MotionEvent, webView: (MotionEvent) -> Boolean): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                consumedY = 0f
                downX = fingerX
                downY = fingerY
                lastY = fingerY
                downLocalY = event.y
                passedSlop = false
                horizontal = false
                taking = frame?.edge == BarHideFrame.Edge.TOP
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = fingerY - lastY
                lastY = fingerY
                val frame = frame
                if (taking && frame != null && frame.edge == BarHideFrame.Edge.TOP && !multiTouch && !horizontal) {
                    if (passedSlop) {
                        consume(dy, frame)
                    } else if (hypot(fingerX - downX, fingerY - downY) > slop) {
                        // The crossing itself goes through: the WebView begins its scroll on it
                        // (and drops its long press), and the bar takes over from the next move.
                        passedSlop = true
                        horizontal = abs(fingerX - downX) > abs(fingerY - downY)
                    }
                }
            }
        }
        if (!taking) return webView(event)
        val shift = downLocalY + (fingerY - downY) + consumedY - event.y
        if (abs(shift) < 0.5f) return webView(event)
        val shifted = MotionEvent.obtain(event)
        shifted.offsetLocation(0f, shift)
        return try {
            webView(shifted)
        } finally {
            shifted.recycle()
        }
    }

    /** The finger moved `dy` (device px, negative up the screen, i.e. down the page): what of it the bar takes. */
    private fun consume(dy: Float, frame: BarHideFrame) {
        if (dy < 0f) {
            // Down the page: the bar hides, as long as there is page below to scroll to.
            if (mirror >= frame.travelPx || !view.canScrollVertically(1)) return
            val take = min(-dy, frame.travelPx - mirror)
            mirror += take
            consumedY += take
            report(take)
        } else if (dy > 0f && mirror > 0f) {
            // Up the page: the bar comes back first.
            val take = min(dy, mirror)
            mirror -= take
            consumedY -= take
            report(-take)
        }
    }

    /** `View.onScrollChanged` on the WebView. */
    fun onScrollChanged(scrollY: Int, oldScrollY: Int) {
        val frame = frame ?: return
        val dt = scrollY - oldScrollY
        if (dt == 0) return
        val now = SystemClock.uptimeMillis()
        val flinging = !touching && now < flingUntil
        if (!touching && !flinging) return
        // The page reached its top without a finger on it (a fling ran out at the top): a bar
        // still off comes back. Under a finger the scroll itself brings it back.
        if (scrollY <= 0 && oldScrollY > 0 && !touching && mirror > 0f) {
            emit("show", null)
            return
        }
        when (frame.edge) {
            BarHideFrame.Edge.BOTTOM -> {
                if (flinging) flingUntil = now + FLING_GAP_MS
                report(dt.toFloat())
            }
            BarHideFrame.Edge.TOP -> {
                // The finger's travel, not the page's scroll, moves a top-docked bar (see
                // [consume]); a fling up under a hidden bar brings it back on its spring, as
                // Chrome's fling shows its controls.
                if (flinging && dt < 0 && mirror > 0f) {
                    flingUntil = 0L
                    emit("show", null)
                }
            }
        }
    }

    private fun report(px: Float) {
        pending += px / density
        if (!flushPosted) {
            flushPosted = true
            view.postOnAnimation(flush)
        }
    }

    companion object {
        /** A page that has not scrolled for this long after the finger lifted is done flinging. */
        private const val FLING_GAP_MS = 120L
    }
}
