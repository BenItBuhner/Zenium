package app.zen.chromium

import kotlin.math.min

/**
 * The policies behind the activity lifecycle and a lost WebView renderer, kept free of Android
 * types so they run under plain JUnit (`HostLifecycleTest`); `MainActivity` and `Host` act on
 * them.
 *
 * A word on what is *not* here: the WebViews are never paused (`WebView.onPause` /
 * `pauseTimers`). A page playing audio in the background keeps playing in Chrome, and so it does
 * in Zenium; a paused WebView that is not resumed is also the classic way to a blank one. What a
 * wake needs instead is a fresh frame and a chrome laid out against the window it is coming back
 * to, which is what [Host.onStart] does.
 */
class HostLifecycle(private val clock: () -> Long = System::currentTimeMillis) {
    private var lastRebuildAt = 0L
    private var rapidRebuilds = 0

    /** What a wake probe of the chrome calls for (see [repairAfterProbe]). */
    enum class Repair { NONE, RETRY, REATTACH, REBUILD }

    /**
     * What to do about the chrome once the window is back on screen, given how its document
     * answered a `document.visibilityState` probe on `attempt` (0-based; `null` is no answer
     * within the deadline).
     *
     *  - `visible`: the WebView's contents are shown and it paints; nothing to do.
     *  - anything else (`hidden`): the platform left the WebView's contents hidden although the
     *    window is resumed, and a hidden page produces no frames – a blank chrome. Taking the view
     *    off the window and putting it back resets that, once; a second hidden answer means the
     *    reset did not take, and the chrome is rebuilt.
     *  - no answer: the renderer is wedged (frozen with the app and never thawed, say) or gone
     *    without a word. Asked once more, then the chrome is rebuilt around a fresh renderer.
     */
    fun repairAfterProbe(answer: String?, attempt: Int): Repair = when {
        answer == null -> if (attempt == 0) Repair.RETRY else Repair.REBUILD
        answer == "visible" -> Repair.NONE
        else -> if (attempt == 0) Repair.REATTACH else Repair.REBUILD
    }

    /**
     * How long to wait before loading a rebuilt chrome after its renderer died. The first loss is
     * repaired at once; a fresh chrome that dies again within [RAPID_WINDOW_MS] is retried with a
     * doubling delay (capped at [MAX_REBUILD_DELAY_MS]), so a renderer that cannot stay up does not
     * turn into a tight loop of WebView creation. A chrome that lived longer than the window
     * resets the escalation.
     */
    fun chromeRebuildDelayMs(): Long {
        val now = clock()
        rapidRebuilds = if (lastRebuildAt != 0L && now - lastRebuildAt < RAPID_WINDOW_MS) rapidRebuilds + 1 else 0
        lastRebuildAt = now
        return if (rapidRebuilds == 0) 0L else min(MAX_REBUILD_DELAY_MS, FIRST_REBUILD_DELAY_MS shl (rapidRebuilds - 1))
    }

    /** How many times in a row the rebuilt chrome died within the window (for the log). */
    val consecutiveRapidRebuilds: Int get() = rapidRebuilds

    companion object {
        const val RAPID_WINDOW_MS = 15_000L
        const val FIRST_REBUILD_DELAY_MS = 1_000L
        const val MAX_REBUILD_DELAY_MS = 8_000L

        /**
         * The wake probe waits this long after `onResume` before asking – the window becomes
         * visible at the next traversal and the WebView posts its visibility to the renderer,
         * which on a slow device takes a few hundred milliseconds – and gives the renderer this
         * long to answer. A page that keeps the shared renderer busy for two deadlines in a row
         * right after a wake is a browser nobody can use either way.
         */
        const val PROBE_DELAY_MS = 1_500L
        const val PROBE_TIMEOUT_MS = 5_000L

        /** `ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN` and `TRIM_MEMORY_BACKGROUND`, without the Android dependency. */
        const val TRIM_MEMORY_UI_HIDDEN = 20
        const val TRIM_MEMORY_BACKGROUND = 40

        /**
         * Whether a memory trim at `level` should drop the back previews. Only once the app is on
         * the system's LRU list: UI_HIDDEN alone is not pressure, the user may be right back, and
         * the previews are what makes the first back gesture after a wake look right.
         */
        fun trimDropsSnapshots(level: Int): Boolean = level >= TRIM_MEMORY_BACKGROUND
    }
}
