package app.zen.chromium

/**
 * What a page's `beforeunload` objection comes to (`TabWebView.Chrome.onJsBeforeUnload`,
 * PUI-28 / OS-40): the WebView holds the navigation the page objects to and waits for an
 * answer. For a page the user drives the answer is the user's sheet – "Leave site?", "Reload
 * site?" – under the unload check or not, as it has always been.
 *
 * A page an agent drives (`TabWebView.agentDriven`) is the one exception: the WebView raises the
 * question only after a user gesture, but an agent's input is trusted input, so a page it works
 * on may object, and the question is the agent's to answer, not the user's (part B of OS-40
 * routes the page's dialogs to it). For now the navigation goes on, and a check in flight
 * settles as leave, its view destroyed.
 *
 * Free of Android types, so the table runs under plain JUnit (`UnloadObjectionTest`).
 */
object UnloadObjection {
    sealed interface Decision

    /** The user's question: "Leave site?", or "Reload site?" when `reload` (the core asked for a reload just before). */
    data class Sheet(val reload: Boolean) : Decision

    /** An agent-driven page, no check: the navigation goes on, with the bookkeeping a Leave runs (`reload` as [Sheet]'s). */
    data class LeaveSilently(val reload: Boolean) : Decision

    /** An agent-driven page under a check: the navigation goes on and the check settles as leave, the view destroyed. */
    data object SettleCheck : Decision

    /**
     * The answer for an objection raised by a page an agent drives or not, under a check or
     * not, and this soon after the core asked for a reload or not. A reload is never asked under
     * a check (the check's navigation is its own blank document), so `reloadAsked` counts only
     * without one, as before.
     */
    fun decide(agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean): Decision {
        val reload = !checkInFlight && reloadAsked
        return when {
            !agentDriven -> Sheet(reload)
            checkInFlight -> SettleCheck
            else -> LeaveSilently(reload)
        }
    }
}
