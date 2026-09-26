package app.zen.chromium

/**
 * The user's "Leave" at a page's `beforeunload` objection, carried to the re-issued load of the
 * very navigation it was given for.
 *
 * A navigation the page starts (a tap) runs the page's `beforeunload` in the renderer before it
 * reaches `shouldOverrideUrlLoading`: an objecting page (an unsaved form) has the user asked
 * "Leave site?" first, and the navigation reaches the hook only past a Leave. When the hook then
 * holds it for the core's content-settings answer (`TabWebView.holdForContentRules`) the WebView
 * drops it, and the load the view re-issues with the answer in hand (`resumeHeld`) is a
 * browser-initiated one, for which the browser dispatches `beforeunload` once more – the same
 * page, still objecting, its activation still sticky – so without this the user would be asked
 * twice on the first tap into every site the tab has no answer for. Chrome asks once; so does
 * this: the Leave is remembered, the hold that follows it within [windowMs] is marked as the
 * navigation it was given for, and the re-issued load's objection arriving within [windowMs] of
 * the resume is answered with that Leave instead of a second sheet.
 *
 * Every step consumes what it read, and any other load, history step or document start drops it
 * ([reset]): a Leave carries to exactly one hold, and a hold's Leave answers exactly one
 * objection. Outside the windows – a slow renderer, a redirect hop arriving late – the sheet is
 * shown again, the safe side. A `beforeunload` check of the core's own (`confirmUnload`, ahead
 * of a tab close) never consults this: its objection is the check's to settle.
 *
 * Time is passed in (`SystemClock.uptimeMillis()` on the device), so the shape is pinned on the
 * JVM (`LeaveCarryTest`).
 */
class LeaveCarry(private val windowMs: Long = DEFAULT_WINDOW_MS) {
    /** When the user last chose Leave at a page-started navigation's objection; null when spent. */
    private var leaveChosenAt: Long? = null
    /** When a held navigation the Leave was given for was re-issued as the view's load; null when spent. */
    private var carriedAt: Long? = null

    /** The user chose to leave at a "Leave site?" the page raised for a navigation it started. */
    fun leaveChosen(now: Long) {
        leaveChosenAt = now
        carriedAt = null
    }

    /**
     * A navigation is being held: whether the Leave just chosen was for it (a Leave within the
     * window, spent here). The hold keeps the answer for its resume ([resumed]).
     */
    fun holds(now: Long): Boolean {
        val letGo = within(leaveChosenAt, now)
        leaveChosenAt = null
        return letGo
    }

    /** The held navigation was re-issued as the view's own load; `letGo` is what [holds] said for it. */
    fun resumed(now: Long, letGo: Boolean) {
        carriedAt = if (letGo) now else null
    }

    /**
     * The page objected again, outside a check: whether this is the re-issued load's second
     * asking – within the window of the resume – to be answered with the Leave (spent here).
     */
    fun answers(now: Long): Boolean {
        val carried = within(carriedAt, now)
        carriedAt = null
        return carried
    }

    /** Another load, a history step, the user staying, the document starting: nothing carries over. */
    fun reset() {
        leaveChosenAt = null
        carriedAt = null
    }

    private fun within(since: Long?, now: Long): Boolean = since != null && now - since in 0 until windowMs

    companion object {
        /**
         * Both windows: from the Leave to the hold (the renderer starts the navigation the
         * moment the sheet answers) and from the resume to the second objection (the browser
         * dispatches it as the load is asked for; the renderer runs the handler). The same
         * breadth `TabWebView.RELOAD_ASK_WINDOW_MS` gives a reload's objection.
         */
        const val DEFAULT_WINDOW_MS = 2_000L
    }
}
