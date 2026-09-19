package app.zen.chromium

import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import org.json.JSONObject
import kotlin.math.abs
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
 * does; here a drag's vertical travel goes to the bar first and the WebView sees the rest, as a
 * finger that holds still while the bar moves ([BarHideShare], applied in [forward] by shifting
 * the touches the WebView sees). The bar's offset is mirrored here in device px so the hand-over
 * does not wait on the bridge; the chrome, which clamps the same deltas the same way, stays the
 * truth and the mirror is re-read from it between fingers. With the bar at the bottom nothing is
 * consumed: the page scrolls and the bar follows the scroll, as Chrome's bottom controls do.
 *
 * Touch distances are device pixels here and CSS pixels on the bridge.
 */
class BarHideGesture(
    private val view: TabWebView,
    private val emit: (phase: String, payload: JSONObject?) -> Unit
) {
    private val density = view.resources.displayMetrics.density
    /** The share of a drag's travel between a top-docked bar and the page (see [BarHideShare]). */
    private val share = BarHideShare(ViewConfiguration.get(view.context).scaledTouchSlop.toFloat(), SLOP_PASS_DP * density)

    /** The chrome's latest word on the bar (see [BarHideFrame]); null: the bar may not hide. */
    var frame: BarHideFrame? = null
        set(value) {
            field = value
            // The chrome's offset is the mirror's, except under a finger a top-docked bar is
            // taking travel from: there the mirror leads and the chrome follows a frame behind.
            if (!touching || value?.edge != BarHideFrame.Edge.TOP) share.mirror = value?.offsetPx ?: 0f
        }

    private var touching = false
    /**
     * The finger on the screen (raw coordinates), from the latest real touch. The WebView's own
     * coordinates will not do here: `TabHost.place` slides the view with a top-docked bar, so
     * in them a finger that holds still reads as moving by the bar's travel, and the pull's
     * synthetic touches carry the view's coordinates as their raw ones.
     */
    private var fingerX = 0f
    private var fingerY = 0f
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
                flingUntil = 0L
                share.mirror = frame?.offsetPx ?: 0f
                if (frame != null) emit("start", null)
            }
            MotionEvent.ACTION_POINTER_DOWN -> share.pointerDown()
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                touching = false
                // From now, not from the event's own time: a lift delivered late (batched behind
                // a slow frame) still leaves the scroll it started its gap to arrive in.
                flingUntil = maxOf(event.eventTime, SystemClock.uptimeMillis()) + FLING_GAP_MS
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
     * screen less what the bar took of it. The view's own coordinates would carry its slide
     * ([TabHost.place] moves it with the bar, a frame or two after the finger) back into the
     * finger, and Chromium would scroll on it.
     */
    fun forward(event: MotionEvent, webView: (MotionEvent) -> Boolean): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> share.down(fingerX, fingerY, event.y, taking = frame?.edge == BarHideFrame.Edge.TOP)
            MotionEvent.ACTION_MOVE -> {
                val travel = frame?.takeIf { it.edge == BarHideFrame.Edge.TOP }?.travelPx ?: 0
                val taken = share.move(fingerX, fingerY, travel, view.canScrollVertically(1))
                if (taken != 0f) report(taken)
            }
        }
        if (!share.taking) return webView(event)
        val shift = share.seenY(fingerY) - event.y
        if (abs(shift) < 0.5f) return webView(event)
        val shifted = MotionEvent.obtain(event)
        shifted.offsetLocation(0f, shift)
        return try {
            webView(shifted)
        } finally {
            shifted.recycle()
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
        if (scrollY <= 0 && oldScrollY > 0 && !touching && share.mirror > 0f) {
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
                // [BarHideShare]); a fling up under a hidden bar brings it back on its spring, as
                // Chrome's fling shows its controls.
                if (flinging && dt < 0 && share.mirror > 0f) {
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
        /** What of a slop crossing goes through past the slop itself, so the WebView is sure to see the crossing (dp). */
        private const val SLOP_PASS_DP = 1f
    }
}
