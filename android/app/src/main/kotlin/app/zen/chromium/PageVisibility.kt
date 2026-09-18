package app.zen.chromium

/**
 * The order in which a page view is taken down behind the chrome, kept free of Android types so
 * it runs under plain JUnit (`PageVisibilityTest`); [Host] arms the callbacks.
 *
 * The chrome WebView lies under the page WebViews: whatever the chrome has drawn by the time a
 * page view goes is what shows in its place. The chrome asks for a page to be hidden only once
 * its stand-in picture is painted on its side (the renderer's `lib/cover.ts`); this is the host's
 * half of the guarantee. A hide is deferred until the chrome has drawn the frame that carries
 * the state it reported the layout from (`WebView.postVisualStateCallback`), so the view goes
 * with that frame and not before it, and in any case by [DEADLINE_MS] – a chrome that stops
 * drawing (a window on its way to the background) must not keep a page over a sheet for good.
 * A show is applied at once; the close direction's ordering (the picture kept until the page view
 * has drawn again) is a filed follow-up, not this class's.
 */
class PageVisibility(private val apply: (tabId: String, visible: Boolean) -> Unit) {
    /** A deferred hide; the chrome's visual-state callback and the deadline hand it back. */
    class Ticket internal constructor(val tabId: String, val id: Long)

    private val pending = HashMap<String, Ticket>()
    private var seq = 0L

    /**
     * The core wants `tabId` `visible`. Returns the ticket of a hide that now waits for the
     * chrome's frame – the caller arms the visual-state callback and the deadline for it – or
     * null when nothing is left to arm: a show was applied, or a hide for this tab is pending
     * already.
     */
    fun request(tabId: String, visible: Boolean): Ticket? {
        if (visible) {
            pending.remove(tabId)
            apply(tabId, true)
            return null
        }
        if (pending.containsKey(tabId)) return null
        val ticket = Ticket(tabId, ++seq)
        pending[tabId] = ticket
        return ticket
    }

    /**
     * The chrome has drawn the frame `ticket` waited for, or the deadline passed: hide the view,
     * unless a show or a newer hide overtook the ticket meanwhile. Answers whether it did.
     */
    fun complete(ticket: Ticket): Boolean {
        if (pending[ticket.tabId] !== ticket) return false
        pending.remove(ticket.tabId)
        apply(ticket.tabId, false)
        return true
    }

    /** Hides still waiting for the chrome's frame. */
    val pendingCount: Int get() = pending.size

    companion object {
        /** A chrome that does not draw within this is not going to; hide anyway. */
        const val DEADLINE_MS = 500L
    }
}
