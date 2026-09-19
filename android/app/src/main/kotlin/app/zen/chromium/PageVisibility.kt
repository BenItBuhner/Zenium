package app.zen.chromium

/**
 * The order in which a page view is taken down behind the chrome and brought back, kept free of
 * Android types so it runs under plain JUnit (`PageVisibilityTest`); [Host] arms the callbacks.
 *
 * The chrome WebView lies under the page WebViews: whatever the chrome has drawn by the time a
 * page view goes is what shows in its place. The chrome asks for a page to be hidden only once
 * its stand-in picture is painted on its side (the renderer's `lib/cover.ts`); this is the host's
 * half of the guarantee. A hide is deferred until the chrome has drawn the frame that carries
 * the state it reported the layout from (`WebView.postVisualStateCallback`), so the view goes
 * with that frame and not before it, and in any case by [DEADLINE_MS] – a chrome that stops
 * drawing (a window on its way to the background) must not keep a page over a sheet for good.
 * A show is applied at once.
 *
 * Both directions end in the chrome being told when the change is on screen (`view.drawn`, the
 * renderer's `lib/pageView.ts` – the close direction's ordering: the picture stays until the
 * page view has drawn again). Every applied change carries a serial; [Host] reports the frame
 * that carries it, and [drawn] says whether that report is still the tab's current one – a
 * newer change to the same tab has its own frame to report, and a change is reported once.
 */
class PageVisibility(private val apply: (tabId: String, visible: Boolean, change: Long) -> Unit) {
    /** A deferred hide; the chrome's visual-state callback and the deadline hand it back. */
    class Ticket internal constructor(val tabId: String, val id: Long)

    private val pending = HashMap<String, Ticket>()
    /** Per tab: the last change applied whose frame the chrome has not been told of yet. */
    private val unreported = HashMap<String, Long>()
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
            applyNow(tabId, true)
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
        applyNow(ticket.tabId, false)
        return true
    }

    /**
     * The frame carrying `change` to `tabId` is on screen (or the wait for it ran out): whether
     * the chrome is to be told. Not when a newer change to the tab was applied meanwhile – its
     * own frame will be reported – nor a second time for the same change.
     */
    fun drawn(tabId: String, change: Long): Boolean {
        if (unreported[tabId] != change) return false
        unreported.remove(tabId)
        return true
    }

    private fun applyNow(tabId: String, visible: Boolean) {
        val change = ++seq
        unreported[tabId] = change
        apply(tabId, visible, change)
    }

    /** Hides still waiting for the chrome's frame. */
    val pendingCount: Int get() = pending.size

    /** Applied changes whose frame the chrome has not been told of. */
    val unreportedCount: Int get() = unreported.size

    companion object {
        /** A chrome that does not draw within this is not going to; hide anyway. */
        const val DEADLINE_MS = 500L
        /**
         * A page view that has not drawn its frame within this after a change is not going to
         * (its renderer gone, the window on its way out): tell the chrome anyway. Under the
         * chrome's own patience for the word (`ACK_TIMEOUT_MS`, 1000 ms) so it hears it first.
         */
        const val DRAWN_DEADLINE_MS = 600L
    }
}
