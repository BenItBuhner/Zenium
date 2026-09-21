package app.zen.chromium

import android.os.SystemClock
import android.util.Log
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
    val shownEdgePx: Int,
    /**
     * The page holds its tall layout, into the bar's band ([BarHidePlacement]): from the hide's
     * first frame to the shown REST, as the chrome says (`BarHideHostFrame.tall`) – not read off
     * [offsetPx] here, since a bar that has come home under a finger still down, or under a
     * fling not yet ended, is at 0 with the page still tall, so that its one short relayout (the
     * gesture's biggest task on a heavy page, 105 ms on github.com in #270) lands at the rest,
     * after the gesture's frames (§11.5). Implied by an offset above 0.
     */
    val tall: Boolean = offsetPx > 0f
) {
    enum class Edge { TOP, BOTTOM }

    /** The bar is off its edge at all. */
    val away: Boolean get() = offsetPx > 0f
    /** The bar is fully off. */
    val hidden: Boolean get() = offsetPx >= travelPx

    companion object {
        /** `chrome.setBarHide`'s arguments (CSS px) → device px; null for `{ enabled: false }`. */
        fun parse(args: JSONObject, density: Float): BarHideFrame? {
            if (!args.optBoolean("enabled", true)) return null
            val travel = (args.num("travel") * density).roundToInt()
            if (travel <= 0) return null
            val offset = (args.num("offset") * density).toFloat().coerceIn(0f, travel.toFloat())
            return BarHideFrame(
                if (args.str("edge", "bottom") == "top") Edge.TOP else Edge.BOTTOM,
                offset,
                travel,
                (args.num("shownEdge") * density).roundToInt(),
                tall = args.optBoolean("tall", offset > 0f) || offset > 0f
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
 * script) moves no bar, as in Chrome, and neither does the clamp Chromium applies when the page
 * is laid out taller near its end ([BarHideScrollFilter]).
 *
 * Consuming, with the bar docked at the top. Chrome's top controls take a scroll before the page
 * does; here a drag's vertical travel goes to the bar first and the WebView sees the rest, as a
 * finger that holds still while the bar moves ([BarHideShare], applied in [forward] by shifting
 * the touches the WebView sees) – once the page's own scroller has moved under the finger, so a
 * finger on an inner scroller moves no bar. The bar's offset is mirrored here in device px so
 * the hand-over does not wait on the bridge; the chrome, which clamps the same deltas the same
 * way, stays the truth and the mirror is re-read from it between fingers. With the bar at the
 * bottom nothing is consumed: the page scrolls and the bar follows the scroll, as Chrome's
 * bottom controls do.
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
    /** What the page's scroll changes mean for the bar (see [BarHideScrollFilter]). */
    private val filter = BarHideScrollFilter(FLING_GAP_MS, FINGER_TOLERANCE_DP * density)

    /** The chrome's latest word on the bar (see [BarHideFrame]); null: the bar may not hide. */
    var frame: BarHideFrame? = null
        set(value) {
            field = value
            // The chrome's offset is the mirror's, except under a finger a top-docked bar is
            // taking travel from: there the mirror leads and the chrome follows a frame behind.
            if (!filter.touching || value?.edge != BarHideFrame.Edge.TOP) share.mirror = value?.offsetPx ?: 0f
            // The page's layout as the chrome has it: laid out short, the next hide is gated on
            // the band it would grow by; still tall (a bar home under the finger), it is not.
            filter.pageLaidOut(tall = value?.tall == true)
        }

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

    /** The last three `move` deltas sent to the chrome (CSS px), oldest first: what a record of a bar that stayed off reads (the demo's warm-up). */
    val recentMoves = ArrayDeque<Double>(3)

    /** A finger is on the page (the down seen, no lift yet). */
    val touching: Boolean get() = filter.touching

    private val flush = Runnable {
        flushPosted = false
        if (pending == 0.0) return@Runnable
        val delta = (pending * 100).roundToInt() / 100.0
        pending = 0.0
        if (delta == 0.0) return@Runnable
        if (recentMoves.size == 3) recentMoves.removeFirst()
        recentMoves.addLast(delta)
        emit("move", json("delta" to delta, "time" to SystemClock.uptimeMillis()))
    }

    /** One line on where this side stands, for a run's record. */
    fun describe(): String =
        "frame=${frame?.let { "${it.edge} ${it.offsetPx}/${it.travelPx}px" } ?: "null"} touching=${filter.touching} multiTouch=${filter.multiTouch} hiding=${filter.hiding} mirror=${share.mirror} taking=${share.taking} rootScrolled=${share.rootScrolled} remaining=${view.scrollRemaining()} moves=$recentMoves"

    /** Every touch on the page as it arrives, before anything else has had it. */
    fun onTouch(event: MotionEvent) {
        fingerX = event.rawX
        fingerY = event.rawY
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                filter.down(fingerY, pageTall = frame?.tall == true)
                share.mirror = frame?.offsetPx ?: 0f
                if (frame != null) emit("start", null)
            }
            // A second finger (a pinch): neither the bar's take nor the page's scroll is the bar's
            // from here to the next down, at either dock.
            MotionEvent.ACTION_POINTER_DOWN -> {
                share.pointerDown()
                filter.pointerDown()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                // From now, not from the event's own time: a lift delivered late (batched behind
                // a slow frame) still leaves the scroll it started its gap to arrive in.
                filter.lifted(maxOf(event.eventTime, SystemClock.uptimeMillis()))
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
                // A hide starts only with the band the page is about to be laid out taller by
                // still below (else Chromium clamps the scroll back, see [BarHideScrollFilter]);
                // one under way, or one from a page still laid out tall (the bar home under this
                // finger), needs only something left to scroll to.
                val pageBelow = view.scrollRemaining() >= if (share.mirror <= 0f && frame?.tall != true) travel else 1
                val taken = share.move(fingerX, fingerY, travel, pageBelow)
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

    /** `View.onScrollChanged` on the WebView: the page's own scroller moved (inner scrollers never reach here). */
    fun onScrollChanged(scrollY: Int, oldScrollY: Int) {
        val frame = frame ?: return
        val verdict = filter.scrolled(
            scrollY,
            oldScrollY,
            view.scrollRemaining(),
            share.mirror,
            frame.travelPx,
            frame.edge == BarHideFrame.Edge.TOP,
            fingerY,
            SystemClock.uptimeMillis()
        )
        when (verdict) {
            BarHideScrollFilter.Verdict.NONE -> return
            BarHideScrollFilter.Verdict.HELD -> {}
            BarHideScrollFilter.Verdict.REPORT -> report((scrollY - oldScrollY).toFloat())
            BarHideScrollFilter.Verdict.SHOW -> {
                // Rare (a fling's end), and the one word from here that moves the bar by itself: on the record.
                Log.d(TAG, "show on ${view.tabId}: scroll $oldScrollY -> $scrollY, ${describe()}")
                emit("show", null)
            }
        }
        if (filter.touching) share.rootScrolled()
    }

    /** `View.onOverScrolled` on the WebView: a drag pushing the page against its top has reached the page's own scroller too. */
    fun onOverScrolled(scrollY: Int, clampedY: Boolean) {
        if (clampedY && scrollY <= 0 && filter.touching) share.rootScrolled()
    }

    private fun report(px: Float) {
        pending += px / density
        if (!flushPosted) {
            flushPosted = true
            view.postOnAnimation(flush)
        }
    }

    companion object {
        private const val TAG = "BarHide"
        /**
         * A page that has not scrolled for this long after the finger lifted is done flinging.
         * The chrome waits longer than this for a fling's scroll to end (`BAR_HIDE_FLING_GAP_MS`,
         * `lib/barHide.ts`), so a fling's last report never finds it settled already.
         */
        const val FLING_GAP_MS = 120L
        /** What of a slop crossing goes through past the slop itself, so the WebView is sure to see the crossing (dp). */
        private const val SLOP_PASS_DP = 1f
        /** A finger that has moved this far (dp) the other way since the page last scrolled did not scroll it this way. */
        private const val FINGER_TOLERANCE_DP = 2f
    }
}
