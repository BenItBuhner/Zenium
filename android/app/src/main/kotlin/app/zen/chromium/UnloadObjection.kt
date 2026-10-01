package app.zen.chromium

/**
 * What a page's `beforeunload` objection comes to (`TabWebView.Chrome.onJsBeforeUnload`,
 * PUI-28 / OS-40): the WebView holds the navigation the page objects to and waits for an
 * answer, and the answer is the user's sheet – "Leave site?", "Reload site?" – for the page in
 * front of them that they drive, and nobody's question otherwise.
 *
 * A page the user is not looking at may object too: the WebView raises the question only after
 * a user gesture, but an agent's input to a hidden tab is trusted input, and the unload check's
 * blank document (`TabWebView.confirmUnload`, ahead of a tab close) is a navigation like any
 * other. Its sheet would come up over whatever the user is looking at. So would the sheet of a
 * page an agent drives (`TabWebView.agentDriven`), shown or not: the agent's own session is in
 * front, and the question is the agent's to answer (part B of OS-40 routes the page's dialogs
 * to it). Such an objection is answered as Chrome answers a page the user is not on – the
 * navigation goes on – and a check in flight settles as leave, its view destroyed.
 *
 * Free of Android types, so the table runs under plain JUnit (`UnloadObjectionTest`).
 */
object UnloadObjection {
    sealed interface Decision

    /** The user's question: "Leave site?", or "Reload site?" when `reload` (the core asked for a reload just before). */
    data class Sheet(val reload: Boolean) : Decision

    /** No sheet, no check: the navigation goes on, with the bookkeeping a Leave runs (`reload` as [Sheet]'s). */
    data class LeaveSilently(val reload: Boolean) : Decision

    /** No sheet, a check in flight: the navigation goes on and the check settles as leave, the view destroyed. */
    data object SettleCheck : Decision

    /**
     * The answer for an objection raised while the view `isShown` (on screen, the user's) or
     * not, driven by an agent or not, under a check or not, and this soon after the core asked
     * for a reload or not. A reload is never asked under a check (the check's navigation is its
     * own blank document), so `reloadAsked` counts only without one, as before.
     */
    fun decide(isShown: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean): Decision {
        val reload = !checkInFlight && reloadAsked
        val usersQuestion = isShown && !agentDriven
        return when {
            usersQuestion -> Sheet(reload)
            checkInFlight -> SettleCheck
            else -> LeaveSilently(reload)
        }
    }
}
