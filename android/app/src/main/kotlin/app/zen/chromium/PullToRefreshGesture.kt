package app.zen.chromium

import android.view.MotionEvent
import android.view.ViewConfiguration
import app.zen.chromium.PullGestureClassifier.Disposition
import app.zen.chromium.PullGestureClassifier.Pull
import app.zen.chromium.PullGestureClassifier.Step

/**
 * Pull-to-refresh on one tab's WebView: feeds its touches, its top overscrolls and the page's
 * `overscroll-behavior` answer to a [PullGestureClassifier] and carries out what it decides –
 * which events the WebView sees (with synthetic cancels and downs where the pull takes the finger
 * over or gives it back) and which become `pull` events for the chrome, whose `lib/pull.ts` turns
 * them into the page's offset and hands it back through [TabWebView.setPullOffset].
 *
 * Touch distances are device pixels here and CSS pixels on the bridge.
 */
class PullToRefreshGesture(
    private val view: TabWebView,
    /** The WebView's own touch handling (`super.onTouchEvent`). */
    private val forward: (MotionEvent) -> Boolean,
    private val emit: (Pull) -> Unit
) {
    private val classifier = PullGestureClassifier(ViewConfiguration.get(view.context).scaledTouchSlop.toFloat())
    private val density = view.resources.displayMetrics.density
    /** A copy of the latest touch, for the synthetic events built between real ones. */
    private var last: MotionEvent? = null
    /** Tells a stale probe answer (from an earlier touch) from the current one. */
    private var probeSeq = 0

    val pulling: Boolean get() = classifier.state == PullGestureClassifier.State.PULLING

    fun onTouchEvent(event: MotionEvent): Boolean {
        val step = when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                remember(event)
                val step = classifier.down(event.x, event.y, atTop(), view.pullToRefreshEligible())
                if (classifier.state == PullGestureClassifier.State.WATCHING) probe()
                step
            }
            MotionEvent.ACTION_POINTER_DOWN -> classifier.pointerDown(event.eventTime)
            MotionEvent.ACTION_MOVE -> {
                remember(event)
                classifier.move(event.x, event.y, event.eventTime, atTop())
            }
            MotionEvent.ACTION_UP -> classifier.up(event.eventTime)
            MotionEvent.ACTION_CANCEL -> classifier.cancel(event.eventTime)
            else -> Step.FORWARD
        }
        val handled = apply(step, event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) forget()
        return handled
    }

    /** `View.onOverScrolled` on the WebView: the drag tried to go above the top of the page. */
    fun onOverScrolled(scrollY: Int, clampedY: Boolean) {
        if (!clampedY || scrollY > 0) return
        classifier.overscrolledTop()?.let { apply(it, null) }
    }

    /** The chrome moved the page by `offsetCss` (see [TabWebView.setPullOffset]). */
    fun offsetApplied(offsetCss: Float) {
        classifier.offsetApplied(offsetCss * density)
    }

    private fun atTop(): Boolean = view.scrollY <= 0

    /**
     * Ask the page whether its root leaves overscroll to the browser. Answers on the main thread
     * a few milliseconds later – normally before the finger has crossed the touch slop.
     */
    private fun probe() {
        val seq = ++probeSeq
        view.evaluateJavascript(OVERSCROLL_BEHAVIOR_PROBE) { result ->
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
                step.pull?.let(::send)
                return event?.let(forward) ?: true
            }
            Disposition.CONSUME -> {
                step.pull?.let(::send)
                return true
            }
            Disposition.CANCEL_WEBVIEW -> {
                // The WebView had a scroll going; it must end it before the pull takes the finger.
                synthetic(MotionEvent.ACTION_CANCEL)
                step.pull?.let(::send)
                return true
            }
            Disposition.HANDBACK -> {
                step.pull?.let(::send)
                // A fresh gesture for the WebView, from where the finger is now.
                event?.let(::remember)
                synthetic(MotionEvent.ACTION_DOWN)
                return event?.let(forward) ?: true
            }
        }
    }

    private fun send(pull: Pull) {
        emit(
            when (pull) {
                is Pull.Move -> Pull.Move(pull.travel / density, pull.time)
                else -> pull
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
         * `1` when the viewport's `overscroll-behavior-y` is `auto`, `0` when the page keeps its
         * overscroll (`contain` / `none` on the root or, propagated like overflow, on the body).
         */
        private const val OVERSCROLL_BEHAVIOR_PROBE =
            "(function(){try{var g=getComputedStyle,h=document.documentElement,b=document.body;" +
                "var a=(g(h).overscrollBehaviorY||'auto'),c=b?(g(b).overscrollBehaviorY||'auto'):'auto';" +
                "return a==='auto'&&c==='auto'?1:0}catch(e){return 1}})()"
    }
}
