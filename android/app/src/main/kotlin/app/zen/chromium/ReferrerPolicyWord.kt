package app.zen.chromium

/**
 * The page's own referrer policy, as its document-start script reads it and tells the view
 * (`referrerPolicy.ts` over the page bridge), for the navigation the view holds for the core's
 * content-settings answer (`TabWebView.holdForContentRules`): the load the view re-issues with
 * the answer in hand carries the `Referer` the view computes (`ContentRules.resumeReferer`),
 * and without the page's word it would carry Chrome's default policy over a page's stricter
 * one (the #507 delta read's item C).
 *
 * Two words, the policy tokens of the Referrer Policy spec (an empty one is the default):
 *
 * - The NEXT navigation's ([nextNavigation]): sent from a capture-phase click / Enter on an
 *   anchor, before the navigation it starts – the anchor's `rel=noreferrer`, else
 *   its `referrerpolicy`, else the document's policy. It is for the one navigation that
 *   follows it in the same input task: the first main-frame navigation through the hook takes
 *   it ([forNavigation]), whether held or not, a document starting drops it ([documentStarted]),
 *   and one older than [windowMs] – a click whose navigation never came – is not read. The
 *   page's `beforeunload` objection to that navigation stands between the click and the hook
 *   for as long as the user reads the sheet; a Leave restarts the word's clock ([leaveChosen]),
 *   so the sheet's time is not counted against the word.
 * - The DOCUMENT's ([document]): the last valid `<meta name=referrer>`, sent at document start
 *   and at every change, tagged with the document's origin. It stands for a navigation without
 *   an anchor ahead of it (`location.assign` under a meta policy) and is read only while the
 *   view's current document is of that origin – a stale word of another document's cannot
 *   reach a page that sent none, and a document starting on another origin drops it
 *   ([documentStarted]); one of the same origin is left to the new document's own word, whose
 *   arrival the view cannot order against the document's start.
 *
 * Time is passed in (`SystemClock.uptimeMillis()` on the device), so the shape is pinned on the
 * JVM (`ReferrerPolicyWordTest`).
 */
class ReferrerPolicyWord(private val windowMs: Long = DEFAULT_WINDOW_MS) {
    private var next: String? = null
    private var nextAt = 0L
    private var documentPolicy = ""
    private var documentOrigin: String? = null

    /** The script read `policy` for the navigation the input it saw is about to start. */
    fun nextNavigation(policy: String, now: Long) {
        next = policy
        nextAt = now
    }

    /** The script read the document's policy (`origin` is `location.origin`'s spelling: `scheme://host[:port]`). */
    fun document(policy: String, origin: String) {
        documentPolicy = policy
        documentOrigin = origin
    }

    /**
     * A main-frame navigation reached the hook while `from` (the view's current document, as
     * [ContentRules.siteOf] reads it) is the page: the policy it runs under, the next word
     * within its window first (spent here, whatever it said), else the document's where it is
     * `from`'s origin's, else the default.
     */
    fun forNavigation(fromSite: String?, now: Long): String {
        val pending = next
        next = null
        if (pending != null && now - nextAt in 0 until windowMs) return pending
        return documentPolicyFor(fromSite)
    }

    /** The document's word, where it is `fromSite`'s. */
    fun documentPolicyFor(fromSite: String?): String =
        if (fromSite != null && fromSite == documentOrigin) documentPolicy else ""

    /**
     * The page objected to the navigation the next word is for (`beforeunload`, its sheet asked
     * at `askedAt`) and the user chose Leave at `now`: the navigation goes on to the hook from
     * here, so a word live when the question was asked is live for it – its window runs again
     * from the Leave, the sheet's time not counted. A word already past its window when the page
     * asked stays past it (the question was not its navigation's); without a word, nothing.
     */
    fun leaveChosen(askedAt: Long, now: Long) {
        if (next != null && askedAt - nextAt in 0 until windowMs) nextAt = now
    }

    /** A document started on `site`: the next word is the old page's; the document word too unless the origin is the same. */
    fun documentStarted(site: String?) {
        next = null
        if (site != documentOrigin) {
            documentPolicy = ""
            documentOrigin = null
        }
    }

    companion object {
        /**
         * From the click to the navigation it starts reaching the hook: the renderer starts it
         * as the click's default action and the hook hears it a hop later – the breadth
         * `LeaveCarry.DEFAULT_WINDOW_MS` gives the hop from a Leave to the same hook. A
         * `beforeunload` sheet in between stands as long as the user reads it, outside any
         * window: its Leave restarts the clock ([leaveChosen]).
         */
        const val DEFAULT_WINDOW_MS = 2_000L
    }
}
