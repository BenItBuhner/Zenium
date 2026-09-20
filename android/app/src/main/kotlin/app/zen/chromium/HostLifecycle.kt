package app.zen.chromium

import kotlin.math.min

/**
 * The policies behind the activity lifecycle and a lost or wedged WebView renderer, kept free of
 * Android types so they run under plain JUnit (`HostLifecycleTest`); `MainActivity` and `Host`
 * act on them.
 *
 * A word on what is *not* here: the WebViews are never paused (`WebView.onPause` /
 * `pauseTimers`). A page playing audio in the background keeps playing in Chrome, and so it does
 * in Zenium; a paused WebView that is not resumed is also the classic way to a blank one. What a
 * wake needs instead is a fresh frame, a chrome laid out against the window it is coming back
 * to, and a check that the chrome really is painting – which is what [Host.onStart] and the wake
 * probe do.
 */
class HostLifecycle(private val clock: () -> Long = System::currentTimeMillis) {
    private var lastRebuildAt = 0L
    private var rapidRebuilds = 0

    /** What a wake probe of the chrome calls for (see [repairAfterProbe]). */
    enum class Repair {
        /** The chrome document is visible and has its UI: nothing to do. */
        NONE,
        /** Inconclusive; ask once more. */
        RETRY,
        /** Take the WebViews off the window and put them back, so the platform re-announces their visibility. */
        REATTACH,
        /** Replace the chrome WebView; the renderer itself answers, so a fresh document in it will do. */
        REBUILD,
        /** The renderer does not answer: end the renderer process, so the rebuild gets a fresh one. */
        TERMINATE
    }

    /**
     * What to do about the chrome once the window is back on screen, given how its document
     * answered the wake probe on `attempt` (0-based). The probe evaluates [PROBE_SCRIPT] and
     * answers `<visibilityState>:<ok|empty>`; `null` is no answer within the deadline.
     *
     *  - `visible:ok`: the WebView's contents are shown, it paints and the chrome is mounted.
     *  - `visible:empty`: the document is shown but its root has nothing in it – the chrome's UI is
     *    gone (a chrome that unmounted itself). Asked once more, then rebuilt.
     *  - anything else (`hidden`): the platform left the WebView's contents hidden although the
     *    window is resumed, and a hidden page produces no frames – a blank chrome. Taking the view
     *    off the window and putting it back resets that, once; a second hidden answer means the
     *    reset did not take, and the chrome is rebuilt.
     *  - no answer: the renderer's main thread is wedged, or gone without a word. Asked once more,
     *    then the renderer process is ended – a fresh WebView in the same process would hang with
     *    it – and the chrome rebuilt around a new one.
     */
    fun repairAfterProbe(answer: String?, attempt: Int): Repair = when {
        answer == null -> if (attempt == 0) Repair.RETRY else Repair.TERMINATE
        answer.startsWith("visible") -> when {
            answer.endsWith(":empty") -> if (attempt == 0) Repair.RETRY else Repair.REBUILD
            else -> Repair.NONE
        }
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

        /** After the renderer was told to end, how long to wait for its `onRenderProcessGone` before rebuilding anyway. */
        const val TERMINATE_GRACE_MS = 3_000L

        /** What the wake probe asks the chrome document; see [repairAfterProbe] for the answers. */
        const val PROBE_SCRIPT =
            "(function(){var r=document.getElementById('root');" +
                "return document.visibilityState+':'+(r&&r.childElementCount>0?'ok':'empty')})()"

        /** `ComponentCallbacks2.TRIM_MEMORY_*`, without the Android dependency. */
        const val TRIM_MEMORY_RUNNING_MODERATE = 5
        const val TRIM_MEMORY_RUNNING_LOW = 10
        const val TRIM_MEMORY_RUNNING_CRITICAL = 15
        const val TRIM_MEMORY_UI_HIDDEN = 20
        const val TRIM_MEMORY_BACKGROUND = 40
        const val TRIM_MEMORY_MODERATE = 60
        const val TRIM_MEMORY_COMPLETE = 80

        /**
         * Whether a memory trim at `level` should drop the back previews. Only once the app is on
         * the system's LRU list: UI_HIDDEN alone is not pressure, the user may be right back, and
         * the previews are what makes the first back gesture after a wake look right.
         */
        fun trimDropsSnapshots(level: Int): Boolean = level >= TRIM_MEMORY_BACKGROUND

        /**
         * How pressing a memory trim at `level` is for the pages (sleeping tabs, CT-22): the core
         * puts hidden pages to sleep ahead of their timeout on `"low"` and every hidden page on
         * `"critical"`; `null` is no pressure. The two families of levels are not ordered by
         * severity, hence the table: in the foreground, RUNNING_LOW means the device is short and
         * RUNNING_CRITICAL that background processes are being killed (Zenium's could be next once
         * it leaves the screen); on the LRU list, MODERATE is the middle of it and COMPLETE its
         * end. RUNNING_MODERATE, UI_HIDDEN and BACKGROUND alone are not pressure: the user may be
         * right back, and a page put to sleep for nothing is a reload for nothing.
         */
        fun memoryPressure(level: Int): String? = when (level) {
            TRIM_MEMORY_RUNNING_LOW, TRIM_MEMORY_MODERATE -> "low"
            TRIM_MEMORY_RUNNING_CRITICAL, TRIM_MEMORY_COMPLETE -> "critical"
            else -> null
        }
    }
}
