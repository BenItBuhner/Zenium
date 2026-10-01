package app.zen.chromium

/**
 * What a page's `beforeunload` objection comes to (`TabWebView.Chrome.onJsBeforeUnload`,
 * PUI-28 / OS-40): the WebView holds the navigation the page objects to and waits for an
 * answer. For a page the user drives the answer is the user's sheet – "Leave site?", "Reload
 * site?" – shown or hidden, under the unload check or not, as it has always been (whether a
 * hidden user tab's sheet should come up over the current screen, bring the tab forward first
 * or not ask at all is the Design Lead's question, not this table's).
 *
 * A page an agent drives (`TabWebView.agentDriven`) is the one exception: the WebView raises the
 * question only after a user gesture, but an agent's input is trusted input, so a page it works
 * on in a hidden tab may object, and its sheet would come up over whatever the user is looking
 * at – or, with the tab in front, over a page the user is not the one driving. The question is
 * the agent's to answer (part B of OS-40 routes the page's dialogs to it), so for now the
 * navigation goes on, and a check in flight settles as leave, its view destroyed.
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
     * not, and this soon after the core asked for a reload or not. Whether the view is shown
     * does not enter: a user's page asks the same way either way. A reload is never asked under
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
