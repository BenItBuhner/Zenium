package app.zen.chromium

import kotlin.math.abs

/**
 * Tells a pull-to-refresh apart from everything else a finger does on a page WebView, one touch
 * sample at a time, and says what the WebView should see of each. Pure – no Android types – so
 * `PullGestureClassifierTest` drives it on the JVM.
 *
 * The recognition follows Chrome's: a pull is a downward drag that began with the page at its
 * top and that the page did not consume. The WebView reports the latter as an overscroll at the
 * top ([overscrolledTop]); relying on it rather than on the finger alone is what leaves nested
 * scrollers, pinch zoom, text selection and pages that take the touches themselves untouched.
 * The page's own say – `overscroll-behavior` on the root – arrives from a script probe
 * ([pageAnswered]); a pull activates only once both agree. Until then the WebView sees every
 * event; on activation it gets a cancel for the gesture it had, and the pull owns the finger.
 * The finger goes back to the WebView (with a fresh down) when the pull is undone: it came back
 * up past where the page sits at home, or a second finger arrived.
 *
 * Distances are in whatever unit the caller uses for both the touches and [touchSlop] (device
 * pixels on Android); [offsetApplied] must be fed in the same unit.
 */
class PullGestureClassifier(private val touchSlop: Float) {
    enum class State {
        /** No finger down. */
        IDLE,
        /** A finger that might become a pull; the WebView gets everything. */
        WATCHING,
        /** The pull owns the finger; the WebView gets nothing. */
        PULLING,
        /** This finger is the WebView's until it lifts. */
        PASSTHROUGH
    }

    /** What the view does with the touch event that was just fed in. */
    enum class Disposition {
        /** Hand the event to the WebView as it is. */
        FORWARD,
        /** Keep the event to the pull. */
        CONSUME,
        /** Give the WebView a cancel for the gesture it thought it had; the event is the pull's. */
        CANCEL_WEBVIEW,
        /** Give the WebView a fresh down at the finger's position, then the event as it is. */
        HANDBACK
    }

    /** What the chrome's pull machine is told (`lib/pull.ts`). */
    sealed class Pull {
        object Start : Pull()
        /** The finger's travel since the pull began, positive downwards. */
        data class Move(val travel: Float, val time: Long) : Pull()
        data class Release(val time: Long) : Pull()
        data class Cancel(val time: Long) : Pull()
    }

    data class Step(val disposition: Disposition, val pull: Pull? = null) {
        companion object {
            val FORWARD = Step(Disposition.FORWARD)
        }
    }

    var state = State.IDLE
        private set

    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    /** Where the finger was when the pull took over; travel is measured from here. */
    private var originY = 0f
    /** The pull began on a page that was already out (retracting, or waiting on a reload). */
    private var caught = false
    /** The WebView reported a top overscroll while the page's answer was still on its way. */
    private var overscrollSeen = false
    /** Whether the page's root lets the browser act on overscroll (null: not answered yet). */
    private var pageAllows: Boolean? = null
    /** How far the page sits below home right now, as the chrome last reported it. */
    private var pageOffset = 0f

    /** The chrome moved the page: it is `offset` below its home position (0 at rest). */
    fun offsetApplied(offset: Float) {
        pageOffset = offset
    }

    /**
     * A finger landed. `atTop`: the page cannot scroll up any further. `eligible`: this page
     * refreshes at all (the setting is on, the URL has something to reload, no other transition
     * is moving the page).
     */
    fun down(x: Float, y: Float, atTop: Boolean, eligible: Boolean): Step {
        downX = x
        downY = y
        lastX = x
        lastY = y
        caught = false
        overscrollSeen = false
        pageAllows = null
        if (!eligible) {
            state = State.PASSTHROUGH
            return Step.FORWARD
        }
        if (pageOffset > OUT_EPSILON) {
            // The page is still out from an earlier pull: the finger catches it where it is.
            state = State.PULLING
            caught = true
            originY = y
            return Step(Disposition.CONSUME, Pull.Start)
        }
        state = if (atTop) State.WATCHING else State.PASSTHROUGH
        return Step.FORWARD
    }

    /** A second finger: a pinch or a two-finger scroll, never a pull. */
    fun pointerDown(time: Long): Step = when (state) {
        State.PULLING -> {
            state = State.PASSTHROUGH
            Step(Disposition.HANDBACK, Pull.Cancel(time))
        }
        State.WATCHING -> {
            state = State.PASSTHROUGH
            Step.FORWARD
        }
        else -> Step.FORWARD
    }

    fun move(x: Float, y: Float, time: Long, atTop: Boolean): Step {
        lastX = x
        lastY = y
        return when (state) {
            State.WATCHING -> {
                val dx = x - downX
                val dy = y - downY
                // The page scrolled (it consumed the drag), the drag is sideways, or it went up
                // first: none of these is a pull, for the rest of this finger.
                if (!atTop || (abs(dx) > touchSlop && abs(dx) > abs(dy)) || dy < -touchSlop) {
                    state = State.PASSTHROUGH
                }
                Step.FORWARD
            }
            State.PULLING -> {
                val travel = y - originY
                if (travel < 0f && (!caught || pageOffset <= OUT_EPSILON)) {
                    // Back above where the page sits at home: the drag is the page's again, and a
                    // new pull may still begin from here.
                    state = State.WATCHING
                    downX = x
                    downY = y
                    caught = false
                    overscrollSeen = false
                    Step(Disposition.HANDBACK, Pull.Cancel(time))
                } else {
                    Step(Disposition.CONSUME, Pull.Move(travel, time))
                }
            }
            else -> Step.FORWARD
        }
    }

    fun up(time: Long): Step {
        val was = state
        state = State.IDLE
        return if (was == State.PULLING) Step(Disposition.CONSUME, Pull.Release(time)) else Step.FORWARD
    }

    /** The system took the touch away (a notification shade, a window change). */
    fun cancel(time: Long): Step {
        val was = state
        state = State.IDLE
        return if (was == State.PULLING) Step(Disposition.CONSUME, Pull.Cancel(time)) else Step.FORWARD
    }

    /**
     * The WebView reported that the drag tried to scroll above the top of the page. Returns the
     * step that starts the pull, or null when this finger is not (or not yet) a pull.
     */
    fun overscrolledTop(): Step? {
        if (state != State.WATCHING) return null
        overscrollSeen = true
        return activateIfReady()
    }

    /**
     * The page answered the `overscroll-behavior` probe sent at the down: `allows` is false when
     * its root says `contain` or `none`, i.e. the page keeps its overscroll to itself.
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
        // A page too short to scroll reports the same overscroll for a drag upwards.
        if (dy <= 0f || abs(dx) > abs(dy)) return null
        state = State.PULLING
        caught = false
        originY = lastY
        return Step(Disposition.CANCEL_WEBVIEW, Pull.Start)
    }

    companion object {
        /** Below this the page counts as home (sub-pixel spring tails, rounding). */
        const val OUT_EPSILON = 0.5f

        /**
         * Whether a reload of `url` would show anything new: web pages and Zenium's error page
         * (whose reload retries the original address); not blank tabs or the other `zen://`
         * pages, which have nothing to fetch.
         */
        fun refreshable(url: String?): Boolean {
            if (url.isNullOrEmpty()) return false
            val lower = url.lowercase()
            return lower.startsWith("http://") || lower.startsWith("https://") ||
                lower.startsWith("file://") || lower.startsWith("zen://error")
        }
    }
}
