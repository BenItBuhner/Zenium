package app.zen.chromium

import android.view.MotionEvent
import android.view.ViewConfiguration
import app.zen.chromium.HistoryNavClassifier.Edge
import app.zen.chromium.HistoryNavClassifier.Nav
import app.zen.chromium.HistoryNavClassifier.Step
import app.zen.chromium.PullGestureClassifier.Disposition

/**
 * Overscroll history navigation on one tab's WebView (GN-04, 3-button navigation mode): feeds
 * its touches, its clamped horizontal overscrolls and the page's `overscroll-behavior-x` answer
 * to a [HistoryNavClassifier] and carries out what it decides – which events the WebView sees
 * (with synthetic cancels and downs where the drag takes the finger over or gives it back) and
 * which become `historyNav` events for the chrome, whose `lib/historyNav.ts` draws the arrow
 * bubble and navigates on the release.
 *
 * Touch distances are device pixels here and CSS pixels on the bridge. The wrapper sits ahead
 * of the pull-to-refresh in the view's touch chain: [forward] is the pull's `onTouchEvent`, so
 * a finger this gesture does not take flows on unchanged, and the cancel it sends on activation
 * ends whatever the pull and the WebView had of the same finger.
 */
class HistoryNavGesture(
    private val view: TabWebView,
    /** The rest of the view's touch handling (the pull-to-refresh, then `super.onTouchEvent`). */
    private val forward: (MotionEvent) -> Boolean,
    private val emit: (Nav) -> Unit
) {
    private val density = view.resources.displayMetrics.density
    private val classifier = HistoryNavClassifier(
        ViewConfiguration.get(view.context).scaledTouchSlop.toFloat(),
        HistoryNavClassifier.EDGE_WIDTH_DP * density
    )
    /** A copy of the latest touch, for the synthetic events built between real ones. */
    private var last: MotionEvent? = null
    /** Tells a stale probe answer (from an earlier touch) from the current one. */
    private var probeSeq = 0

    val dragging: Boolean get() = classifier.state == HistoryNavClassifier.State.DRAGGING

    fun onTouchEvent(event: MotionEvent): Boolean {
        val step = when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                remember(event)
                val step = classifier.down(
                    event.x, event.y, view.width.toFloat(),
                    canBack = view.historyNavEligible(Edge.LEFT),
                    canForward = view.historyNavEligible(Edge.RIGHT)
                )
                if (classifier.state == HistoryNavClassifier.State.WATCHING) probe()
                step
            }
            MotionEvent.ACTION_POINTER_DOWN -> classifier.pointerDown(event.eventTime)
            MotionEvent.ACTION_MOVE -> {
                remember(event)
                classifier.move(event.x, event.y, event.eventTime)
            }
            MotionEvent.ACTION_UP -> classifier.up(event.eventTime)
            MotionEvent.ACTION_CANCEL -> classifier.cancel(event.eventTime)
            else -> Step.FORWARD
        }
        val handled = apply(step, event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) forget()
        return handled
    }

    /**
     * `View.onOverScrolled` on the WebView with `clampedX`: the drag tried to scroll the page
     * past a side it cannot scroll further towards – its left when `scrollX` is 0, its right
     * when `scrollX` is at `maxScrollX` (both for a page with no sideways scroll at all).
     */
    fun onOverScrolled(scrollX: Int, clampedX: Boolean, maxScrollX: Int) {
        if (!clampedX) return
        if (scrollX <= 0) classifier.overscrolledX(Edge.LEFT)?.let { apply(it, null) }
        if (scrollX >= maxScrollX) classifier.overscrolledX(Edge.RIGHT)?.let { apply(it, null) }
    }

    /**
     * Ask the page whether its root leaves horizontal overscroll to the browser. Answers on the
     * main thread a few milliseconds later – normally before the finger has crossed the slop.
     */
    private fun probe() {
        val seq = ++probeSeq
        view.evaluateJavascript(OVERSCROLL_BEHAVIOR_X_PROBE) { result ->
            if (seq != probeSeq) return@evaluateJavascript
            classifier.pageAnswered(result != "0")?.let { apply(it, null) }
        }
    }

    /**
     * Carry a step out. `event` is the real touch it was decided for (null for steps decided
     * between touches, from an overscroll report or the probe's answer).
     */
    private fun apply(step: Step, event: MotionEvent?): Boolean {
        when (step.disposition) {
            Disposition.FORWARD -> {
                step.nav?.let(::send)
                return event?.let(forward) ?: true
            }
            Disposition.CONSUME -> {
                step.nav?.let(::send)
                return true
            }
            Disposition.CANCEL_WEBVIEW -> {
                // The WebView had a scroll going; it must end it before the drag takes the finger.
                synthetic(MotionEvent.ACTION_CANCEL)
                step.nav?.let(::send)
                return true
            }
            Disposition.HANDBACK -> {
                step.nav?.let(::send)
                // A fresh gesture for the WebView, from where the finger is now.
                event?.let(::remember)
                synthetic(MotionEvent.ACTION_DOWN)
                return event?.let(forward) ?: true
            }
        }
    }

    private fun send(nav: Nav) {
        emit(
            when (nav) {
                is Nav.Move -> Nav.Move(nav.travel / density, nav.time)
                else -> nav
            }
        )
    }

    /** A single-pointer event for the first finger, at its latest position, with the given action. */
    private fun synthetic(action: Int) {
        val source = last ?: return
        val properties = MotionEvent.PointerProperties()
        source.getPointerProperties(0, properties)
        val coords = MotionEvent.PointerCoords()
        source.getPointerCoords(0, coords)
        // The original down time throughout, as a ViewGroup does when it splits a gesture.
        val event = MotionEvent.obtain(
            source.downTime, source.eventTime, action, 1, arrayOf(properties), arrayOf(coords),
            source.metaState, source.buttonState, source.xPrecision, source.yPrecision,
            source.deviceId, source.edgeFlags, source.source, source.flags
        )
        forward(event)
        event.recycle()
    }

    private fun remember(event: MotionEvent) {
        last?.recycle()
        last = MotionEvent.obtain(event)
    }

    private fun forget() {
        last?.recycle()
        last = null
    }

    companion object {
        /**
         * `1` when the viewport's `overscroll-behavior-x` is `auto`, `0` when the page keeps its
         * sideways overscroll (`contain` / `none` on the root or, propagated like overflow, on
         * the body) – Chrome's `behavior.PropagatesXScroll()` check.
         */
        private const val OVERSCROLL_BEHAVIOR_X_PROBE =
            "(function(){try{var g=getComputedStyle,h=document.documentElement,b=document.body;" +
                "var a=(g(h).overscrollBehaviorX||'auto'),c=b?(g(b).overscrollBehaviorX||'auto'):'auto';" +
                "return a==='auto'&&c==='auto'?1:0}catch(e){return 1}})()"
    }
}
