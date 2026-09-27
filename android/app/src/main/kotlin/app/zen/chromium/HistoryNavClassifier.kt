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
 * A touchpad's two-finger swipe (GN-23 / A11Y-14; Android 14+ delivers it as one fake finger
 * it classifies, see [isTouchpadSwipe]) is Chrome's `touchpad_swipe_to_navigate` (same
 * `OnOverscrolled`): it needs no edge – it arms from anywhere on the page, in either
 * navigation-bar mode – and its side is the one it pulls the page in from, settled at activation
 * from the overscroll the page reports for that side. The cone, the page's veto and its
 * `overscroll-behavior-x` say are the same. A swipe let go fast enough in its direction
 * navigates whatever its travel (Chrome's `GetActivationStatus`, [FORCE_ACTIVATION_VELOCITY]),
 * and one flung back out of the page at [DISALLOW_VELOCITY] or faster navigates never, whatever
 * its travel: the caller hands [up] the release's horizontal velocity, and the finger's drag
 * neither forces nor is disallowed (its release carries no velocity in Chrome,
 * `overscroll_controller_android.cc:376-378`).
 *
 * Distances are in whatever unit the caller uses for the touches, [touchSlop] and [edgeWidth]
 * (device pixels on Android); the velocity is in the same unit per second.
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

    /** The side of the page the drag pulls in from: the left one goes back, the right one forward. */
    enum class Edge { LEFT, RIGHT }

    /** What the chrome's machine is told (`lib/historyNav.ts`). */
    sealed class Nav {
        data class Start(val edge: Edge) : Nav()
        /** The finger's travel since the drag began, positive into the page (away from its edge). */
        data class Move(val travel: Float, val time: Long) : Nav()
        /**
         * The finger lifted. `force`: a touchpad swipe let go faster than [FORCE_ACTIVATION_VELOCITY]
         * in its direction – the chrome navigates whatever the travel (Chrome's FORCE_ACTIVATION).
         * `disallow`: a touchpad swipe let go flung back out of the page at [DISALLOW_VELOCITY] or
         * faster – the chrome navigates never, whatever the travel (Chrome's DISALLOW_ACTIVATION).
         * Never both: a fling has one direction.
         */
        data class Release(val time: Long, val force: Boolean = false, val disallow: Boolean = false) : Nav()
        data class Cancel(val time: Long) : Nav()
    }

    data class Step(val disposition: Disposition, val nav: Nav? = null) {
        companion object {
            val FORWARD = Step(Disposition.FORWARD)
        }
    }

    var state = State.IDLE
        private set

    /**
     * The side the drag pulls the page in from: where the finger landed (meaningful while
     * [state] is WATCHING or DRAGGING), or for a touchpad swipe the side the page could not
     * scroll towards (meaningful once DRAGGING).
     */
    var edge = Edge.LEFT
        private set

    /** Whether this gesture is a touchpad's two-finger swipe rather than a finger on the screen. */
    var touchpad = false
        private set

    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    /** Where the finger was when the drag took over; travel is measured from here. */
    private var originX = 0f
    /** The sides the WebView reported a clamped overscroll for while the page's answer was on its way. */
    private var overscrolledLeft = false
    private var overscrolledRight = false
    /** Whether the page's root lets the browser act on horizontal overscroll (null: not answered yet). */
    private var pageAllows: Boolean? = null
    /** Whether a drag pulling in from the left / right has anywhere to go (as given at the down). */
    private var canBack = false
    private var canForward = false
    /** The edge window the finger landed in (null: none, or a touchpad swipe), eligible or not. */
    private var landedEdge: Edge? = null
    /** Whether this finger's drag took over at some point (it may since have been handed back). */
    private var started = false

    /**
     * A finger landed at (`x`, `y`) on a page `viewportWidth` wide. `canBack` / `canForward`:
     * whether a drag from the left / right edge has anywhere to go right now – false for both
     * outside 3-button navigation mode, while another transition moves the page, and where the
     * history has no such entry. A `touchpad` swipe arms wherever it lands, towards whichever
     * side has somewhere to go; its side is the one it turns out to pull in from.
     */
    fun down(x: Float, y: Float, viewportWidth: Float, canBack: Boolean, canForward: Boolean, touchpad: Boolean = false): Step {
        downX = x
        downY = y
        lastX = x
        lastY = y
        overscrolledLeft = false
        overscrolledRight = false
        pageAllows = null
        this.canBack = canBack
        this.canForward = canForward
        this.touchpad = touchpad
        landedEdge = null
        started = false
        if (touchpad) {
            state = if (canBack || canForward) State.WATCHING else State.PASSTHROUGH
            return Step.FORWARD
        }
        val side = when {
            x < edgeWidth -> Edge.LEFT
            viewportWidth - x < edgeWidth -> Edge.RIGHT
            else -> null
        }
        landedEdge = side
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
                if ((abs(dx) >= touchSlop || abs(dy) >= touchSlop) && !heading(dx, dy)) {
                    state = State.PASSTHROUGH
                }
                Step.FORWARD
            }
            State.DRAGGING -> Step(Disposition.CONSUME, Nav.Move(inward(x - originX), time))
            else -> Step.FORWARD
        }
    }

    /**
     * The finger lifted, moving at `velocityX` along the page (positive rightwards, the touches'
     * unit per second; the caller's velocity tracker, 0 when it has none). A touchpad swipe
     * released faster than [FORCE_ACTIVATION_VELOCITY] into the page forces the navigation; one
     * released at [DISALLOW_VELOCITY] or faster back out of the page is disallowed it.
     */
    fun up(time: Long, velocityX: Float = 0f): Step {
        val was = state
        state = State.IDLE
        return if (was == State.DRAGGING) {
            Step(Disposition.CONSUME, Nav.Release(time, force = forces(velocityX), disallow = disallows(velocityX)))
        } else {
            Step.FORWARD
        }
    }

    /**
     * Chrome's `OverscrollRefresh::GetActivationStatus` (`overscroll_refresh.cc:265-269`):
     * FORCE_ACTIVATION when the active action is the touchpad's and the fling's velocity in its
     * direction (`GetVelocityInActiveActionDirection`: `velocity.x` pulling in from the left,
     * `-velocity.x` from the right) is over the threshold. A finger's drag is never forced,
     * whatever its speed.
     */
    private fun forces(velocityX: Float): Boolean = touchpad && inward(velocityX) > FORCE_ACTIVATION_VELOCITY

    /**
     * Chrome's `GetActivationStatus` again (`overscroll_refresh.cc:272-276`): ALLOW_ACTIVATION
     * when the fling's velocity in the action's direction is over `kMinFlingVelocityForActivation`
     * (-500), DISALLOW_ACTIVATION otherwise – exactly -500 disallows. The rule is written for
     * both devices, but a finger's release reaches it at zero velocity (`OnScrollEnd(Vector2dF())`,
     * `overscroll_controller_android.cc:376-378`) and is never disallowed; the touchpad's fling
     * alone can be, so the classifier says it for the touchpad alone.
     */
    private fun disallows(velocityX: Float): Boolean = touchpad && inward(velocityX) <= DISALLOW_VELOCITY

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
        if (state != State.WATCHING) return null
        if (!touchpad && side != edge) return null
        if (side == Edge.LEFT) overscrolledLeft = true else overscrolledRight = true
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
        if (pageAllows != true) return null
        val dx = lastX - downX
        val dy = lastY - downY
        if (touchpad) {
            // The swipe's side is the one it pulls the page in from; the page must have reported
            // it cannot scroll that way, and there must be somewhere to go.
            val side = pulledFrom(dx)
            if (!reported(side) || !eligible(side)) return null
            edge = side
        } else if (!reported(edge)) {
            return null
        }
        // A page that cannot scroll sideways reports the same overscroll for a drag either way.
        if (!inCone(dx, dy)) return null
        state = State.DRAGGING
        started = true
        originX = lastX
        return Step(Disposition.CANCEL_WEBVIEW, Nav.Start(edge))
    }

    /**
     * Why a finger that landed in an edge window and dragged inward past the slop – or a touchpad
     * swipe that ran level past the slop – is no history drag: null when it became one, or when
     * it was no such gesture (a tap, a scroll, a touch away from the edges, a two-finger scroll).
     * Read at the lift for the `ZenPull` log, so a refused drag names its cause on a device whose
     * logcat is the only view of it: the eligibility as given at the down (for the swipe, the
     * side it pulled the page in from – `eligible=false` both ways is Settings › Accessibility's
     * switch off), the page's `overscroll-behavior-x` answer (or that none came) and whether the
     * WebView reported the clamped overscroll towards that side.
     */
    fun refusal(): String? {
        if (started) return null
        val dx = lastX - downX
        if (touchpad) {
            if (abs(dx) <= touchSlop || !level(dx, lastY - downY)) return null
            val side = pulledFrom(dx)
            return "touchpad swipe from the $side: eligible=${eligible(side)} page=${pageAnswer()} overscroll=${reported(side)}"
        }
        val side = landedEdge ?: return null
        val inward = if (side == Edge.LEFT) dx else -dx
        if (inward <= touchSlop) return null
        return "$side edge: eligible=${eligible(side)} page=${pageAnswer()} overscroll=${reported(side)}"
    }

    private fun pageAnswer(): String = pageAllows?.toString() ?: "unanswered"

    /** Whether a displacement past the slop may still become this gesture's drag. */
    private fun heading(dx: Float, dy: Float): Boolean =
        if (touchpad) level(dx, dy) && eligible(pulledFrom(dx)) else inCone(dx, dy)

    /** Whether a displacement heads into the page from its edge, within 30° of the horizontal. */
    private fun inCone(dx: Float, dy: Float): Boolean = inward(dx) > 0f && level(dx, dy)

    /** Whether a displacement lies within 30° of the horizontal, either way. */
    private fun level(dx: Float, dy: Float): Boolean = abs(dx) > abs(dy) * WEIGHT_ANGLE_30

    /** A horizontal displacement measured away from the edge the drag began at. */
    private fun inward(dx: Float): Float = if (edge == Edge.LEFT) dx else -dx

    /** The side a displacement pulls the page in from: a finger heading right pulls its left side in. */
    private fun pulledFrom(dx: Float): Edge = if (dx > 0f) Edge.LEFT else Edge.RIGHT

    private fun reported(side: Edge): Boolean = if (side == Edge.LEFT) overscrolledLeft else overscrolledRight

    private fun eligible(side: Edge): Boolean = if (side == Edge.LEFT) canBack else canForward

    companion object {
        /** Chrome's `kWeightAngle30`: `|dx| > 1.73 |dy|` keeps the drag within 30° of the horizontal. */
        const val WEIGHT_ANGLE_30 = 1.73f
        /** Chrome's `kDefaultNavigationEdgeWidth`: how far in from a side a drag may begin (dp). */
        const val EDGE_WIDTH_DP = 24f
        /**
         * Chrome's `kMinFlingVelocityForForceActivation` (`ui/android/overscroll_refresh.cc`): a
         * touchpad swipe let go faster than this in its direction navigates whatever its travel.
         * Physical pixels per second, one fixed number on every device (Chrome derived it once,
         * "1100 dp … about 1788 pixel" at a scale of 1.625, and compares it with the velocity
         * `EventForwarder.java` measures in physical px/s), as [up]'s velocity is here.
         */
        const val FORCE_ACTIVATION_VELOCITY = 1788f
        /**
         * Chrome's `kMinFlingVelocityForActivation` (`ui/android/overscroll_refresh.cc:27`): a
         * touchpad swipe let go flung back out of the page at this speed or faster (its velocity
         * in the action's direction at or under -500) navigates never, whatever its travel
         * (`GetActivationStatus`, `:272-276`: `> -500` allows). Physical pixels per second, as
         * [FORCE_ACTIVATION_VELOCITY] and [up]'s velocity are.
         */
        const val DISALLOW_VELOCITY = -500f
        /**
         * Chrome's `EventForwarder.MAX_FLING_VELOCITY`: the cap the release's velocity is
         * measured under (`VelocityTracker.computeCurrentVelocity(1000, 8000)`), px/s.
         */
        const val MAX_FLING_VELOCITY = 8000f

        /** `MotionEvent.CLASSIFICATION_NONE` (API 29; the value for an event nothing classified). */
        const val CLASSIFICATION_NONE = 0
        /** `MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE` (API 34); spelt out, as lint reads minSdk 26. */
        const val CLASSIFICATION_TWO_FINGER_SWIPE = 3

        /**
         * Whether a touch sequence, by the fields of its down, is a touchpad's two-finger swipe.
         * From Android 14 the platform delivers the swipe as a single fake finger it classifies
         * as one (`GestureConverter.cpp`, `handleScroll`), and Chromium reads exactly that
         * (`EventForwarder.java`, `isTrackpadScrollEventFromAtLeastU`) – after sending any
         * event with a button held to its mouse path (`isTrackpadToMouseConversionEvent`), so
         * a swipe with the touchpad's button down is a click-and-drag, not this. Before Android
         * 14 nothing is classified: the legacy touchpad's one-finger tap-drag and its two-finger
         * scroll arrive alike, Chrome treats both as a finger on the screen (the edge rule), and
         * so does this.
         */
        fun isTouchpadSwipe(buttonState: Int, classification: Int): Boolean =
            classification == CLASSIFICATION_TWO_FINGER_SWIPE && buttonState == 0
    }
}
