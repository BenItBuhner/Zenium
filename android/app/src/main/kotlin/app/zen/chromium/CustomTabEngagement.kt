package app.zen.chromium

/**
 * Chrome's engagement signals for a custom tab (CCT-14, `EngagementSignalsCallback`), decided
 * from the two things the page's view reports – its vertical scroll offset and the touches on it
 * – so the rules have JVM tests and the activity only feeds them:
 *
 * - `onVerticalScrollEvent(isDirectionUp)` when a user scroll starts and whenever its direction
 *   turns (Chrome's `onScrollStarted` / `onVerticalScrollDirectionChanged`): `isDirectionUp` is
 *   false for a scroll toward the bottom of the page (the offset growing), true for one back up.
 * - `onGreatestScrollPercentageIncreased(percentage)` when the farthest the user has scrolled
 *   since the document was committed grows past a new 5 % step: the offset over the page's
 *   scrollable distance, rounded down to a multiple of 5 (5..100), Chrome's steps; only
 *   increases, and reset by every navigation.
 * - `onSessionEnded(didUserInteract)` when the tab closes: whether a touch ever reached the page.
 *
 * A scroll the user did not make – a page's own `scrollTo`, the restore of a position, a new
 * document starting at the top – is not a signal. Chrome reads its gesture events; a WebView tells
 * only the offset and the touches, so an offset change counts as the user's while a finger is
 * down, or as the fling of the finger that just lifted: offset changes that keep coming within
 * [FLING_GAP_MS] of one another after the up. A navigation closes the gesture (a tap that turned
 * into a link is not a scroll). Times are the caller's clock (`SystemClock.uptimeMillis`).
 */
class CustomTabEngagement(private val listener: Listener) {
    interface Listener {
        fun onVerticalScroll(isDirectionUp: Boolean)
        fun onGreatestScrollPercentageIncreased(percentage: Int)
    }

    private var touching = false
    /** A user gesture (the finger, or its fling) is moving the page; the next offset change is its continuation. */
    private var gesture = false
    /** The direction reported for the gesture in progress; null before its first movement. */
    private var reportedDirection: Boolean? = null
    private var lastOffset = 0
    private var lastMoveAt = 0L
    private var greatest = 0

    /** A touch reached the page: what `onSessionEnded` says of the session. */
    var didUserInteract = false
        private set

    /** The farthest 5 % step reported since the last navigation (0 before any). */
    val greatestPercentage: Int get() = greatest

    /** A finger is down on the page: a new gesture, whose first movement reports its direction. */
    fun touchDown() {
        touching = true
        gesture = true
        reportedDirection = null
        didUserInteract = true
    }

    /** The finger lifted (or the gesture was cancelled) at `timeMs`: its fling may still move the page. */
    fun touchUp(timeMs: Long) {
        touching = false
        lastMoveAt = timeMs
    }

    /**
     * The page's vertical offset is `offset` of a scrollable `range` (the farthest offset it can
     * reach; 0 for a page that fits) at `timeMs`.
     */
    fun scrolled(offset: Int, range: Int, timeMs: Long) {
        val dy = offset - lastOffset
        lastOffset = offset
        if (dy == 0) return
        if (!touching) {
            if (!gesture || timeMs - lastMoveAt > FLING_GAP_MS) {
                gesture = false
                return
            }
        }
        lastMoveAt = timeMs
        val up = dy < 0
        if (reportedDirection != up) {
            reportedDirection = up
            listener.onVerticalScroll(up)
        }
        val step = percentageStep(offset, range)
        if (step > greatest) {
            greatest = step
            listener.onGreatestScrollPercentageIncreased(step)
        }
    }

    /**
     * A navigation: the farthest percentage starts over for the new document, and whatever
     * gesture was open is closed (the page's move to its new top is no scroll of the user's).
     */
    fun navigated() {
        greatest = 0
        gesture = false
        reportedDirection = null
    }

    companion object {
        /** Offset changes after the finger lifted that lie further apart than this are no longer its fling. */
        const val FLING_GAP_MS = 300L

        /** Chrome's reporting granularity for the greatest scroll percentage. */
        const val STEP = 5

        /** `offset` of `range` as a percentage rounded down to a multiple of [STEP]; 0 for a page that fits. */
        fun percentageStep(offset: Int, range: Int): Int {
            if (range <= 0) return 0
            val percentage = (offset.coerceIn(0, range).toLong() * 100 / range).toInt()
            return percentage / STEP * STEP
        }
    }
}
