package app.zen.chromium

import app.zen.chromium.PullGestureClassifier.Disposition
import kotlin.math.abs

/**
 * Tells Chrome's overscroll history navigation (GN-04) apart from everything else a finger does
 * on a page WebView, one touch sample at a time, and says what the WebView should see of each.
 * Pure – no Android types – so `HistoryNavClassifierTest` drives it on the JVM.
 *
 * The recognition is Chrome's (`ui/android/overscroll_refresh.cc`, `OnOverscrolled`;
 * `gesturenav/NavigationHandler.java`): a drag that began within [edgeWidth] of a side of the
 * page (24 dp, `kDefaultNavigationEdgeWidth`), heads into the page inside a 30° cone off the
 * horizontal (`|dx| > 1.73 |dy|`, `kWeightAngle30`), and that the page did not consume – the
 * WebView reports the latter as a clamped horizontal overscroll on that side ([overscrolledX]).
 * The page's own say, `overscroll-behavior-x` on its root, arrives from a script probe
 * ([pageAnswered]); the drag activates only once both agree, as the pull-to-refresh does. Only
 * a side whose navigation exists arms at all (the left edge goes back, the right one forward),
 * and the caller passes both as false outside 3-button navigation mode, where the system owns
 * the edges. Until activation the WebView sees every event; on activation it gets a cancel for
 * the gesture it had, and the drag owns the finger until it lifts.
 *
 * Distances are in whatever unit the caller uses for the touches, [touchSlop] and [edgeWidth]
 * (device pixels on Android).
 */
class HistoryNavClassifier(private val touchSlop: Float, private val edgeWidth: Float) {
    enum class State {
        /** No finger down. */
        IDLE,
        /** A finger that might become a history drag; the WebView gets everything. */
        WATCHING,
        /** The drag owns the finger; the WebView gets nothing. */
        DRAGGING,
        /** This finger is the WebView's until it lifts. */
        PASSTHROUGH
    }

    /** The side of the page the drag began at: the left one goes back, the right one forward. */
    enum class Edge { LEFT, RIGHT }

    /** What the chrome's machine is told (`lib/historyNav.ts`). */
    sealed class Nav {
        data class Start(val edge: Edge) : Nav()
        /** The finger's travel since the drag began, positive into the page (away from its edge). */
        data class Move(val travel: Float, val time: Long) : Nav()
        data class Release(val time: Long) : Nav()
        data class Cancel(val time: Long) : Nav()
    }

    data class Step(val disposition: Disposition, val nav: Nav? = null) {
        companion object {
            val FORWARD = Step(Disposition.FORWARD)
        }
    }

    var state = State.IDLE
        private set

    /** The side the finger landed at (meaningful while [state] is WATCHING or DRAGGING). */
    var edge = Edge.LEFT
        private set

    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    /** Where the finger was when the drag took over; travel is measured from here. */
    private var originX = 0f
    /** The WebView reported a clamped overscroll on the edge's side while the page's answer was on its way. */
    private var overscrollSeen = false
    /** Whether the page's root lets the browser act on horizontal overscroll (null: not answered yet). */
    private var pageAllows: Boolean? = null

    /**
     * A finger landed at (`x`, `y`) on a page `viewportWidth` wide. `canBack` / `canForward`:
     * whether a drag from the left / right edge has anywhere to go right now – false for both
     * outside 3-button navigation mode, while another transition moves the page, and where the
     * history has no such entry.
     */
    fun down(x: Float, y: Float, viewportWidth: Float, canBack: Boolean, canForward: Boolean): Step {
        downX = x
        downY = y
        lastX = x
        lastY = y
        overscrollSeen = false
        pageAllows = null
        val side = when {
            x < edgeWidth -> Edge.LEFT
            viewportWidth - x < edgeWidth -> Edge.RIGHT
            else -> null
        }
        val eligible = (side == Edge.LEFT && canBack) || (side == Edge.RIGHT && canForward)
        if (side == null || !eligible) {
            state = State.PASSTHROUGH
            return Step.FORWARD
        }
        edge = side
        state = State.WATCHING
        return Step.FORWARD
    }

    /** A second finger: a pinch or a two-finger scroll, never a history drag. */
    fun pointerDown(time: Long): Step = when (state) {
        State.DRAGGING -> {
            state = State.PASSTHROUGH
            Step(Disposition.HANDBACK, Nav.Cancel(time))
        }
        State.WATCHING -> {
            state = State.PASSTHROUGH
            Step.FORWARD
        }
        else -> Step.FORWARD
    }

    fun move(x: Float, y: Float, time: Long): Step {
        lastX = x
        lastY = y
        return when (state) {
            State.WATCHING -> {
                val dx = x - downX
                val dy = y - downY
                // Past the slop the drag must head into the page inside the cone; a scroll, a
                // drag out over the edge or a diagonal is the page's for the rest of this finger.
                if ((abs(dx) >= touchSlop || abs(dy) >= touchSlop) && !inCone(dx, dy)) {
                    state = State.PASSTHROUGH
                }
                Step.FORWARD
            }
            State.DRAGGING -> Step(Disposition.CONSUME, Nav.Move(inward(x - originX), time))
            else -> Step.FORWARD
        }
    }

    fun up(time: Long): Step {
        val was = state
        state = State.IDLE
        return if (was == State.DRAGGING) Step(Disposition.CONSUME, Nav.Release(time)) else Step.FORWARD
    }

    /** The system took the touch away (a notification shade, a window change). */
    fun cancel(time: Long): Step {
        val was = state
        state = State.IDLE
        return if (was == State.DRAGGING) Step(Disposition.CONSUME, Nav.Cancel(time)) else Step.FORWARD
    }

    /**
     * The WebView reported that the drag tried to scroll past the page's `side`: it cannot
     * scroll further that way. Returns the step that starts the drag, or null when this finger
     * is not (or not yet) a history drag – a report for the other side says nothing about it.
     */
    fun overscrolledX(side: Edge): Step? {
        if (state != State.WATCHING || side != edge) return null
        overscrollSeen = true
        return activateIfReady()
    }

    /**
     * The page answered the `overscroll-behavior-x` probe sent at the down: `allows` is false
     * when its root says `contain` or `none`, i.e. the page keeps its horizontal overscroll.
     */
    fun pageAnswered(allows: Boolean): Step? {
        if (state != State.WATCHING) return null
        pageAllows = allows
        if (!allows) {
            state = State.PASSTHROUGH
            return null
        }
        return activateIfReady()
    }

    private fun activateIfReady(): Step? {
        if (!overscrollSeen || pageAllows != true) return null
        val dx = lastX - downX
        val dy = lastY - downY
        // A page that cannot scroll sideways reports the same overscroll for a drag either way.
        if (!inCone(dx, dy)) return null
        state = State.DRAGGING
        originX = lastX
        return Step(Disposition.CANCEL_WEBVIEW, Nav.Start(edge))
    }

    /** Whether a displacement heads into the page from its edge, within 30° of the horizontal. */
    private fun inCone(dx: Float, dy: Float): Boolean = inward(dx) > 0f && abs(dx) > abs(dy) * WEIGHT_ANGLE_30

    /** A horizontal displacement measured away from the edge the drag began at. */
    private fun inward(dx: Float): Float = if (edge == Edge.LEFT) dx else -dx

    companion object {
        /** Chrome's `kWeightAngle30`: `|dx| > 1.73 |dy|` keeps the drag within 30° of the horizontal. */
        const val WEIGHT_ANGLE_30 = 1.73f
        /** Chrome's `kDefaultNavigationEdgeWidth`: how far in from a side a drag may begin (dp). */
        const val EDGE_WIDTH_DP = 24f
    }
}
