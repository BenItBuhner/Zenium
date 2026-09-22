package app.zen.chromium

/**
 * What the end of the WebView renderer means for the pages that were in front (ERR-15, ERR-16),
 * kept on the host because the host outlives the core. Every WebView of the app shares the one
 * renderer process, so its death takes the chrome – and the core running in it – down with every
 * page: the host rebuilds the chrome, the core boots again and recreates each tab from the
 * persisted state, and would load the page that was in front as if nothing had happened. This
 * remembers, across that rebuild, which pages were on screen and how the renderer went – a crash
 * in front of the user, the system taking its memory back, a page the user ended for not
 * responding – and whether the same tab went within the minute before, and hands each page's
 * word to the core as it loads the page again ([take]), which shows the crash page's variant
 * (`crashPageUrl` in `src/shared/url.ts`) instead of the page. A renderer that went while the
 * app was away (the system reclaiming a background process) leaves nothing: the pages come back
 * on their own, as Chrome's do.
 *
 * Free of Android types (`RENDERER_PRIORITY_WAIVED` copied) so it runs under plain JUnit
 * (`RendererExitsTest`); [Host], [ChromeWebView] and [TabWebView] act on it.
 */
class RendererExits(private val clock: () -> Long) {
    enum class Exit(
        /** The `crashed` view event's reason, the core's `CrashReason`; null for an exit no page is told of. */
        val reason: String?
    ) {
        /** The user ended a page that stopped responding (the unresponsive prompt's Exit page). */
        HUNG("hung"),
        /** The renderer crashed with the page in front of the user. */
        CRASH("crashed"),
        /** The system took the renderer's memory back with the page in front of the user. */
        MEMORY("oom-kill"),
        /** The renderer went while the app was away, or the host ended a wedged one itself: the pages reload quietly. */
        BACKGROUND(null)
    }

    /** One page's word for the core: `{ reason, repeat }` on the `crashed` view event. */
    class Report(val reason: String, val repeat: Boolean)

    private class Pending(val exit: Exit, val reports: HashMap<String, Report>, val at: Long) {
        /** Set once the chrome is being rebuilt: only then does the rebooted core's load of a page take its report. */
        var armed = false
    }

    private var pending: Pending? = null
    /** When the renderer last went, or null before it ever has (a sentinel like `Long.MIN_VALUE` overflows the subtraction). */
    private var lastGoneAt: Long? = null
    /** The host ended the renderer itself and has recorded the exit; the callbacks that follow are that exit. */
    private var expected = false
    /** When each tab's page last went, for the repeat rule. */
    private val lastCrashAt = HashMap<String, Long>()

    /**
     * A WebView reported its renderer gone (`onRenderProcessGone`). The first report of an exit
     * classifies it and records the word for every page on screen (`visibleTabIds`); the other
     * WebViews' reports of the same exit, within [BATCH_MS], and the reports that follow an exit
     * the host began itself ([ending]) answer null. Answers the exit for the first report.
     */
    fun gone(didCrash: Boolean, priorityAtExit: Int, visibleTabIds: Collection<String>): Exit? {
        val now = clock()
        if (expected) {
            expected = false
            lastGoneAt = now
            return null
        }
        val last = lastGoneAt
        // An echo of the exit already recorded (the other WebViews sharing the renderer report
        // it in turn); the window slides with each, so a slow chain of reports stays one exit.
        lastGoneAt = now
        if (last != null && now - last < BATCH_MS) return null
        val exit = classify(didCrash, priorityAtExit)
        record(exit, visibleTabIds, now)
        return exit
    }

    /**
     * The host is about to end the renderer itself: for a page the user gave up on ([Exit.HUNG])
     * or a wedged process after a wake ([Exit.BACKGROUND], nothing told). The exit is recorded
     * now, so the word stands whether or not the platform's `onRenderProcessGone` follows.
     */
    fun ending(exit: Exit, visibleTabIds: Collection<String>) {
        val now = clock()
        expected = true
        lastGoneAt = now
        record(exit, visibleTabIds, now)
    }

    /** The renderer the host ended gave no `onRenderProcessGone` within the grace: nothing to expect any more. */
    fun expectationOver() {
        expected = false
    }

    /**
     * The chrome is being rebuilt around a fresh renderer: the recorded exit's reports are for
     * the core that boots in it. (A chrome that stood – the theoretical view swap in place –
     * heard its page's word through [peek] and the record expires unused.)
     */
    fun chromeRebuilt() {
        val p = pending ?: return
        if (clock() - p.at > PENDING_TTL_MS) pending = null else p.armed = true
    }

    /**
     * The word for `tabId` as the rebooted core loads its page: the report, consumed, or null
     * when the page comes back as itself (nothing recorded, the record for another page, an old
     * record, or one the chrome never rebuilt for).
     */
    fun take(tabId: String): Report? {
        val p = pending ?: return null
        if (clock() - p.at > PENDING_TTL_MS) {
            pending = null
            return null
        }
        if (!p.armed) return null
        val report = p.reports.remove(tabId)
        if (p.reports.isEmpty()) pending = null
        return report
    }

    /** The word for `tabId` from the exit just recorded, not consumed (a chrome that stood tells its page now). */
    fun peek(tabId: String): Report? = pending?.reports?.get(tabId)

    /** The exit being handled right now, for the log. */
    val current: Exit? get() = pending?.exit

    private fun record(exit: Exit, visibleTabIds: Collection<String>, now: Long) {
        val reason = exit.reason
        if (reason == null) {
            pending = null
            return
        }
        val reports = HashMap<String, Report>()
        for (tabId in visibleTabIds) {
            val last = lastCrashAt.put(tabId, now)
            reports[tabId] = Report(reason, last != null && now - last < REPEAT_WINDOW_MS)
        }
        pending = if (reports.isEmpty()) null else Pending(exit, reports, now)
    }

    companion object {
        /** `WebView.RENDERER_PRIORITY_WAIVED`: the renderer's priority while no WebView of it is visible. */
        const val RENDERER_PRIORITY_WAIVED = 0

        /** Reports of one exit by the WebViews sharing the renderer arrive within this of each other. */
        const val BATCH_MS = 1_000L
        /** A recorded exit the rebooted core has not asked about by then is stale. */
        const val PENDING_TTL_MS = 30_000L
        /** A page that goes again within this of its last going suggests closing other tabs. */
        const val REPEAT_WINDOW_MS = 60_000L

        /**
         * How the renderer went, from `RenderProcessGoneDetail`. `didCrash()` is a crash; a kill
         * is the system taking the memory back – with the page in front of the user (the
         * renderer at a priority it would only hold while a WebView is visible) that is the
         * memory page; a renderer at the waived priority went while the app was away, whatever
         * the way, and the pages reload quietly on the way back.
         */
        fun classify(didCrash: Boolean, priorityAtExit: Int): Exit = when {
            priorityAtExit == RENDERER_PRIORITY_WAIVED -> Exit.BACKGROUND
            didCrash -> Exit.CRASH
            else -> Exit.MEMORY
        }
    }
}
