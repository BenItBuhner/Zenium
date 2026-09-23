package app.zen.chromium

/**
 * When the chrome is told a page went fullscreen, and what it is told (`fullscreen.entered`,
 * the exit hint's cue: the first time for a video, GN-20; every time for an element without one,
 * MED-03). The engine's view goes up first ([Host.enterFullscreen]) and the page's own report –
 * whether the fullscreen element shows a video ([Host.fullscreenVideo]) – follows in the next
 * frames, sometimes ahead. The cue waits [DELAY_MS] after the view: the layer's reveal has
 * settled by then (MOT-32), so the toast rises into a page that stands still, and the page has
 * spoken. A page still silent then is given up to [CAP_MS], and cued without a word (the chrome
 * keeps to GN-20's once). The exit before the cue cancels it.
 *
 * A word that trails the cap is not lost: a `false` after a wordless cue – an element without a
 * video, whose hint is owed every time (MED-03) – is cued again, marked `late`, while the tab's
 * fullscreen stands; the chrome raises the toast the cap withheld unless the wordless cue's
 * already stands for this fullscreen (the once, the first time ever). A late `true` confirms the
 * wordless cue's treatment and asks nothing more; a word after a cue that had one is at most the
 * next fullscreen's.
 *
 * A `video: true` from any frame stands for the tab (an embed's player: the main document sees
 * the `<iframe>` alone and says none); a main document's `false` never unsays a frame's `true`.
 * Pure: the delays run on an injected scheduler, the cue goes out through [cue]; the JVM tests
 * run the whole of it.
 */
class FullscreenHintCue(
    /** Run the block after the delay; returns what cancels it. */
    private val schedule: (delayMs: Long, block: () -> Unit) -> (() -> Unit),
    /**
     * Tell the chrome: the tab, the page's word – a video, none, or null for nothing said – and
     * whether this is the late word after a wordless cue for the same fullscreen.
     */
    private val cue: (tabId: String, video: Boolean?, late: Boolean) -> Unit
) {
    private var tab: String? = null
    private var waitingForWord = false
    private var cancel: (() -> Unit)? = null
    private var reportTab: String? = null
    private var reportVideo: Boolean? = null
    /** The tab whose cue went out without a word and whose fullscreen still stands: its late word is owed a cue. */
    private var cuedWithout: String? = null

    /** The engine's fullscreen view went up for the tab. */
    fun entered(tabId: String) {
        drop()
        cuedWithout = null
        tab = tabId
        cancel = schedule(DELAY_MS) {
            cancel = null
            val word = wordFor(tabId)
            if (word != null) {
                fire(word)
                return@schedule
            }
            waitingForWord = true
            cancel = schedule(CAP_MS - DELAY_MS) {
                cancel = null
                fire(null)
            }
        }
    }

    /**
     * The page's `fullscreenchange` report for the tab: a fullscreen element with or without a
     * video, or none (`active` false, from the main document). A cue waiting on the word goes
     * out at once; the word trailing a wordless cue goes out late when it is `false`.
     */
    fun reported(tabId: String, active: Boolean, video: Boolean, mainFrame: Boolean) {
        if (!active) {
            if (mainFrame && reportTab == tabId) forgetReport()
            return
        }
        val word = (reportTab == tabId && reportVideo == true) || video
        reportVideo = word
        reportTab = tabId
        if (waitingForWord && tab == tabId) {
            fire(word)
        } else if (cuedWithout == tabId) {
            cuedWithout = null
            if (!word) cue(tabId, false, true)
        }
    }

    /** The tab's fullscreen ended: a cue still owed is dropped, and the report was this fullscreen's. */
    fun exited(tabId: String) {
        if (tab == tabId) drop()
        if (cuedWithout == tabId) cuedWithout = null
        if (reportTab == tabId) forgetReport()
    }

    private fun wordFor(tabId: String): Boolean? = if (reportTab == tabId) reportVideo else null

    private fun fire(video: Boolean?) {
        val tabId = tab ?: return
        drop()
        cuedWithout = if (video == null) tabId else null
        cue(tabId, video, false)
    }

    private fun drop() {
        cancel?.invoke()
        cancel = null
        waitingForWord = false
        tab = null
    }

    private fun forgetReport() {
        reportTab = null
        reportVideo = null
    }

    companion object {
        /**
         * From the view going up to the cue: the reveal's spring (MOT-32, `Spring(420, 40)`) is at
         * rest well within it, and Chrome's own exit bubble waits the same (`kShowExitBubbleTime`,
         * the chrome's `HINT_DELAY_MS`).
         */
        const val DELAY_MS = 500L
        /** The most the cue waits on a page's word before it goes out without one. */
        const val CAP_MS = 1500L
    }
}
