package app.zen.chromium

/**
 * What a page's `beforeunload` objection comes to (`TabWebView.Chrome.onJsBeforeUnload`,
 * PUI-28 / OS-40; v2 draft §9.23 for touch hosts): the WebView holds the navigation the page
 * objects to and waits for an answer, and a page the user is not looking at never puts a sheet
 * in front of them.
 *
 * Under an unload check ([TabWebView.confirmUnload]: a tab's close from the overview, a strip's
 * ×, Back closing a tab, Close Others / All, the app's exit) the question is not asked on a
 * touch host: the leave is confirmed at once and the check settles as leave, the view destroyed
 * – the close is undoable ("Closed <title>"), and Undo is the protection. A page an agent drives
 * (`TabWebView.agentDriven`) leaves silently: the WebView raises the question only after a user
 * gesture, but an agent's input is trusted input, so a page it works on may object, and the
 * core's own answer for an agent's page is to leave (`PageDialogService.confirmLeave`). A hidden
 * user page objecting to a navigation it started itself, or to a reload the chrome asked of it,
 * stays: the objection is upheld at once, no sheet. Only the page the user is looking at asks –
 * "Leave site?", "Reload site?" – as it always has. The desktop is untouched: its own
 * `PageDialogService` brings the tab in front and asks.
 *
 * Free of Android types, so the table runs under plain JUnit (`UnloadObjectionTest`).
 */
object UnloadObjection {
    sealed interface Decision

    /** The user's question: "Leave site?", or "Reload site?" when `reload` (the core asked for a reload just before). */
    data class Sheet(val reload: Boolean) : Decision

    /** An agent-driven page, no check: the navigation goes on, with the bookkeeping a Leave runs (`reload` as [Sheet]'s). */
    data class LeaveSilently(val reload: Boolean) : Decision

    /** A check in flight: the navigation goes on and the check settles as leave, the view destroyed. */
    data object SettleCheck : Decision

    /** A hidden user page, no check: the navigation is cancelled and the page stays, as a Stay would leave it. */
    data object StayHidden : Decision

    /**
     * The answer for an objection raised by a page shown to the user or not, driven by an agent
     * or not, under a check or not, and this soon after the core asked for a reload or not. A
     * reload is never asked under a check (the check's navigation is its own blank document), so
     * `reloadAsked` counts only without one, as before. `isShown` is the view's own word
     * (`View.isShown`: a hidden tab's view is GONE, and so is the shown tab's under the overview),
     * the predicate the page's other dialogs use.
     */
    fun decide(isShown: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean): Decision {
        val reload = !checkInFlight && reloadAsked
        return when {
            checkInFlight -> SettleCheck
            agentDriven -> LeaveSilently(reload)
            !isShown -> StayHidden
            else -> Sheet(reload)
        }
    }
}
