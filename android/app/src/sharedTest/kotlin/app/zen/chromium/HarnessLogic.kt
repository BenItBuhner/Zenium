package app.zen.chromium

/**
 * The decisions behind the demo harness's `closeUrlField` (DemoHarness.kt), kept free of Android
 * so they run on the JVM (`UrlFieldCloseTest`): when a back may go in, when one has taken, when
 * the close is done, and whether the page the driver was on is still there afterwards. Compiled
 * into the unit tests and the instrumentation alike (`src/sharedTest`), never into the app.
 *
 * The rule the fifth bar-hide run's retry taught (#200): a back goes in only against a reading
 * that says the field is open – the chrome's own store, never the accessibility tree, which
 * trails the screen by up to a second on the emulator's software GPU – and only while the host
 * would hand that back to the chrome. A back with the field already closed goes to the page: to
 * its history, or at the tab's first page to the root rule (`rootBackAction` in `back.ts`),
 * which put a new tab page in the demo tab's place and left the rest of the top dock's claims
 * with no page view. So: no back is ever pressed blind, at most one per confirmed-open reading,
 * each given its time to take before the next reading, and a page that moved all the same is
 * reported by name rather than found out by the claims that follow.
 */
object UrlFieldClose {
    /** The field and the back's route, read together: the chrome's store and the host's mirror of it. */
    data class Field(
        /** The field is up: `uiStore.urlbar.open`, through the bridge. */
        val open: Boolean,
        /** The host would hand a back to the chrome: `PredictiveBack.chromeSurfaceUp`, what `back.update` last said. */
        val chromeHandlesBack: Boolean,
        /** The soft keyboard is up (the window's IME inset); it takes the first back, the field the next. */
        val imeUp: Boolean
    )

    /** The page the driver is on: the active tab per the core, and the view the host holds for it. */
    data class Page(
        /** The active tab per the core, null when there is none. */
        val tabId: String?,
        /** The active tab's URL per the core, for the record. */
        val url: String?,
        /** The host has a page view for the active tab (a new tab page or a chrome page has none). */
        val viewUp: Boolean,
        /** Where the view stands in its history (`copyBackForwardList().currentIndex`); -1 with no view. */
        val historyIndex: Int
    )

    /** The next move of the close loop, from the latest reading of the field. */
    sealed class Move {
        /** The field is closed. */
        object Done : Move()

        /** The field is open and the host hands the back to the chrome: press back once. `keyboard` says the keyboard will take it. */
        data class PressBack(val keyboard: Boolean) : Move()

        /** The field is open but the host has not been told yet (`back.update` in flight): read again shortly. */
        object AwaitHost : Move()

        /** No back may go in any more; the field is left as it is, for the reason given. */
        data class GiveUp(val reason: String) : Move()
    }

    /** Backs at most: one for the keyboard, one for the field, one for a back the chrome missed. */
    const val MAX_BACKS = 3

    /** How long the host is given to learn that the field is open before the close gives up rather than send a back to the page. */
    const val HOST_WAIT_MS = 3_000L

    /** How long a back is given to take (the field closed, or the keyboard it was going to take down) before another is considered. */
    const val BACK_WAIT_MS = 6_000L

    /**
     * What to do next: `backs` have gone in so far, and the host has been waited for `hostWaitedMs`
     * (counted only while the field is open and the host does not yet hand the back to the chrome).
     */
    fun nextMove(field: Field, backs: Int, hostWaitedMs: Long): Move {
        if (!field.open) return Move.Done
        if (backs >= MAX_BACKS) return Move.GiveUp("the field is still open after $backs backs")
        if (!field.chromeHandlesBack) {
            return if (hostWaitedMs < HOST_WAIT_MS) {
                Move.AwaitHost
            } else {
                Move.GiveUp("the field is open but the host would send a back to the page (no back.update for the field within $HOST_WAIT_MS ms)")
            }
        }
        return Move.PressBack(keyboard = field.imeUp)
    }

    /** Whether a back pressed against `before` has taken by `now`: the field closed, or the keyboard it was going to take is down. */
    fun backTook(before: Field, now: Field): Boolean = !now.open || (before.imeUp && !now.imeUp)

    /** The close as a whole, for the driver's record and its claim. */
    data class Outcome(
        /** The field is closed now (or never was open). */
        val closed: Boolean,
        /** Backs pressed; 0 when the field was not open. */
        val backs: Int,
        /** The page the driver was on is still there: the same tab, its view still up, no step back in its history. */
        val pageKept: Boolean,
        /** Why the page is not kept, or the field still open; null when all is well. */
        val reason: String?
    ) {
        /** The field is closed and the page is where it was: what a driver's claim reads. */
        val ok: Boolean get() = closed && pageKept

        fun describe(): String {
            val presses = "$backs back${if (backs == 1) "" else "s"}"
            val field = when {
                !closed -> "the URL field stayed open after $presses"
                backs == 0 -> "the URL field was not open"
                else -> "the URL field closed after $presses"
            }
            val page = if (pageKept) "the page kept" else "the page LOST"
            return if (reason == null) "$field, $page" else "$field, $page: $reason"
        }
    }

    /** The outcome of a close that found the field shut: nothing pressed, nothing moved. */
    val NOT_OPEN = Outcome(closed = true, backs = 0, pageKept = true, reason = null)

    /**
     * The verdict once the loop has ended: `gaveUp` is the [Move.GiveUp] reason when it ended that
     * way. With no back pressed nothing here could have moved the page, so it counts as kept
     * whatever the two readings say.
     */
    fun outcome(before: Page, after: Page, field: Field, backs: Int, gaveUp: String?): Outcome {
        val closed = !field.open
        val lost = if (backs == 0) null else pageLost(before, after)
        val reason = lost ?: if (closed) null else (gaveUp ?: "the field is still open")
        return Outcome(closed, backs, pageKept = lost == null, reason)
    }

    /**
     * Why the page the driver was on is not there any more, null when it is. A back that reached
     * the page shows in one of three ways: at the tab's first page the root rule closed the tab
     * or gave it to a new tab page (another tab active, or the same tab with its view gone); with
     * history behind it the view stepped back in it. The URL alone says nothing: a page that
     * navigates on its own while the field closes is the driver's business, not a lost page.
     */
    fun pageLost(before: Page, after: Page): String? = when {
        before.tabId != after.tabId ->
            "the active tab changed from ${before.tabId} to ${after.tabId}: a back went to the tab's root"
        before.viewUp && !after.viewUp ->
            "the active tab's page view is gone (${before.url} gave way to ${after.url}): a back went to the tab's root"
        before.viewUp && after.historyIndex < before.historyIndex ->
            "the page stepped back in its history from ${before.url} to ${after.url}: a back went to the page"
        else -> null
    }
}
