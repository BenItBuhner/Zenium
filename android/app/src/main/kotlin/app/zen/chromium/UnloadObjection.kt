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
 * – the chrome's close paths run with Undo on the toast ("Closed <title>", `lib/closeUndo.ts`),
 * and that Undo is the protection; the app's exit keeps the tab with its stack, and the one
 * close that comes to the core past the chrome (a hardware keyboard's shortcut) is named in
 * [TabWebView.confirmUnload]. A page an agent drives
 * (`TabWebView.agentDriven`) leaves silently: the WebView raises the question only after a user
 * gesture, but an agent's input is trusted input, so a page it works on may object, and the
 * core's own answer for an agent's page is to leave (`PageDialogService.confirmLeave`); while
 * such a page is hidden its objection is the agent's dialog policy's before this table is
 * read ([DialogPolicyAnswer]: leave by default, or the agent's stay, reported to it), so
 * [LeaveSilently] is what is left of it – the agent's page drawn on the screen. A user
 * page that is not in front – behind another tab, or under the tab overview – objecting to a
 * navigation it started itself, or to a reload the chrome asked of it, stays: the objection is
 * upheld at once, no sheet. Only the tab the user is on asks – "Leave site?", "Reload site?" –
 * as it always has. The desktop is untouched: its own `PageDialogService` brings the tab in
 * front and asks.
 *
 * "In front" is the tab's word, not the view's ([inFront]): the shown tab's view is GONE under
 * the URL field and the app menu too (the core hides the page under `contentHidden`), and the
 * typed address's load runs before the field closes, so a view-drawn-this-instant predicate
 * would cancel the shown tab's commonest leave – a typed URL, a menu Reload – with no sheet and
 * no word. The tab host already tells a cover's hide from a switch's (`BackgroundTabRule`,
 * OS-39: another tab on the screen in its place, or the overview over it by the core's
 * `switchedAway`), and that is the line §9.23 draws.
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

    /** A user page not in front, no check: the navigation is cancelled and the page stays, as a Stay would leave it. */
    data object StayHidden : Decision

    /**
     * Whether the tab is the one in front of the user: its view drawn (`View.isShown`), or off
     * the screen for a chrome surface over it – the URL field, a menu, a sheet – rather than for
     * a switch away from it. `behind` is the host's word on the switch
     * (`TabWebView.backgroundTab`, set by the `BackgroundTabRule` pass: another tab's view on
     * the screen in this one's place, or the overview over it; it holds until this view is on
     * the screen again). A drawn view is in front whatever the pass last said: the pass is
     * posted, and runs a frame after the show; a view just hidden for a switch counts as in
     * front for that one frame too, and a page's objection crosses from the renderer later than
     * the pass runs.
     */
    fun inFront(shown: Boolean, behind: Boolean): Boolean = shown || !behind

    /**
     * The answer for an objection raised by a page in front of the user or not ([inFront]),
     * driven by an agent or not, under a check or not, and this soon after the core asked for a
     * reload or not. A reload is never asked under a check (the check's navigation is its own
     * blank document), so `reloadAsked` counts only without one, as before.
     */
    fun decide(inFront: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean): Decision {
        val reload = !checkInFlight && reloadAsked
        return when {
            checkInFlight -> SettleCheck
            agentDriven -> LeaveSilently(reload)
            !inFront -> StayHidden
            else -> Sheet(reload)
        }
    }
}
