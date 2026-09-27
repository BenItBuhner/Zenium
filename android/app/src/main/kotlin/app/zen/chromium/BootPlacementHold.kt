package app.zen.chromium

/**
 * The boot's served new tab page is MADE, LOADED and placed after the chrome's FULLY DRAWN frame
 * (NTP-35: #563's mitigation (1), its second and third halves; the first is the core's arm,
 * `startup.ts` `bootNeedsPlacement`, which does not wait for that page's placement), kept free of
 * Android types so it runs under plain JUnit (`BootPlacementHoldTest`); [Host] admits the tab,
 * arms the frame and the deadline, and re-dispatches what was held.
 *
 * Why. At a tablet's boot the served `zen://newtab` document is a SECOND WebView in the renderer
 * process the chrome shares. Its creation ([TabHost.create]) and its document's load
 * (`view.loadHtml`: the HTML, the page script) are main-thread and renderer work before READY,
 * and its first synchronous draw is a long main-thread task on a slow GL (1.5 s on the CI
 * emulator's software renderer); `chrome.ready` is a bridge message queued to the same thread.
 * Holding the PLACEMENT alone (the second half) settled the order of the page's first draw against
 * the READY frame and not the frame's length: the seeded pixel_tablet pair on that head read
 * `boot → ready` +217 ms and the READY frame +371 ms at the median with the view GONE throughout
 * (Fully drawn +623 / +802.5 ms paired, the P0 gate failed) – the document's work in the shared
 * renderer, not the placement, was the cost. So while the gate is CLOSED, EVERY `view.*` message
 * of the tab the core makes for the served page (`view.create` carrying `newTabPage`, on the
 * tablet's chassis) is HELD in its order – the creation, the load, the first layout report's
 * placement, the `view.shown` ask behind it – and re-dispatched in that order once the frame after
 * `chrome.ready` has been drawn (the READY frame's visual-state callback, the frame
 * `MainActivity.onChromeReady` marks and reports fully drawn from), or at [DEADLINE_MS] from the
 * first hold for a chrome that never draws that frame: the page arrives before the splash's own
 * watchdog either way. The gate then stays OPEN for the host's life: a New Tab from the sidebar's
 * row is made and placed at once. A tab the core makes for anything else – a restored page's, the
 * phone's every tab – is never admitted and takes the path it had; a held tab that the core loads
 * another document into ([Way.LEAVE]) is made on the spot with what was held, since its placement
 * is then what READY waits for, and one the core destroys before the frame ([Way.DROP]) is never
 * made. A tab that left is not admitted again: its re-dispatched creation is a creation.
 *
 * What the slot shows meanwhile is the chrome's, under the pages: the content frame's ground in
 * the space's solid colour (`--zen-bg-solid`) – no cover, no card, no throbber: a cover is mounted
 * only for a snapshot the chrome holds, and the phone's own page only on the phone
 * (`ContentArea.tsx`). The page then arrives WHOLE and FADES in – the document's own rule
 * (`newTabPage.ts` `data-await-state`, `newTabPageScript.ts`): filled from the state push, its
 * tile icons in hand, before its first paint at opacity.
 */
class BootPlacementHold {
    /** Open: nothing is held any more (the FULLY DRAWN frame drawn, or the wait for it ran out). */
    var open = false
        private set

    /** The tabs whose messages are held while the gate is closed. */
    private val admitted = LinkedHashSet<String>()
    /** The tabs that left the hold before the gate opened ([leave], [drop]): never admitted again. */
    private val gone = HashSet<String>()
    private val held = ArrayList<Held>()

    private class Held(val tabId: String, val op: () -> Unit, val onDrop: () -> Unit)

    /** What a `view.*` message of a held tab does to the hold. */
    enum class Way {
        /** Held in its order, re-dispatched at the release: the creation, the served document's load, the placement, everything else. */
        HOLD,
        /** The tab leaves the hold with its held messages applied now: the core loads another document into it (`view.load`; a `view.loadHtml` of anything but the served page) – a page READY waits for. */
        LEAVE,
        /** The tab leaves the hold with its held messages dropped: the core destroys it before it was ever made. */
        DROP
    }

    /**
     * Admit `tabId` – the tab the core makes for the served page – while the gate is closed: its
     * messages are held from here. Answers false with the gate open, and for a tab that left the
     * hold (nothing is held then).
     */
    fun admit(tabId: String): Boolean {
        if (open || tabId in gone) return false
        admitted.add(tabId)
        return true
    }

    /** Whether `tabId`'s messages are to be held rather than applied. */
    fun holds(tabId: String): Boolean = !open && tabId in admitted

    /** The way of `method` (a `view.*` message of a held tab) carrying `url` – the load's destination, or null. */
    fun way(method: String, url: String?): Way = when (method) {
        "view.destroy" -> Way.DROP
        "view.load" -> Way.LEAVE
        "view.loadHtml" -> if (NewTabPage.isDocument(url)) Way.HOLD else Way.LEAVE
        else -> Way.HOLD
    }

    /**
     * Hold `op` for `tabId`; `onDrop` answers the message instead if the tab is dropped (a call's
     * reply, so nothing waits on it). Answers whether it is the first held – the caller arms the
     * deadline on it. An op offered while the gate is open is applied at once (and answers false).
     */
    fun hold(tabId: String, onDrop: () -> Unit = {}, op: () -> Unit): Boolean {
        if (open) {
            op()
            return false
        }
        held.add(Held(tabId, op, onDrop))
        return held.size == 1
    }

    /** Ops held right now. */
    val heldCount: Int get() = held.size

    /** Whether an op of `tabId` is held. */
    fun heldFor(tabId: String): Boolean = held.any { it.tabId == tabId }

    /**
     * `tabId` leaves the hold with its ops applied now, in the order they came, the gate as it
     * was ([Way.LEAVE]). Answers how many were applied.
     */
    fun leave(tabId: String): Int {
        admitted.remove(tabId)
        gone.add(tabId)
        val ops = held.filter { it.tabId == tabId }
        held.removeAll(ops)
        for (it in ops) it.op()
        return ops.size
    }

    /** `tabId` leaves the hold with its ops dropped, each answered by its `onDrop` ([Way.DROP]). Answers how many were dropped. */
    fun drop(tabId: String): Int {
        admitted.remove(tabId)
        gone.add(tabId)
        val ops = held.filter { it.tabId == tabId }
        held.removeAll(ops)
        for (it in ops) it.onDrop()
        return ops.size
    }

    /**
     * The FULLY DRAWN frame is drawn (or the wait for it ran out): the gate opens for good and
     * what was held is applied in the order it came, each op once. Answers how many ops were
     * applied; 0 when the gate was open already.
     */
    fun release(): Int {
        if (open) return 0
        open = true
        admitted.clear()
        val ops = ArrayList(held)
        held.clear()
        for (it in ops) it.op()
        return ops.size
    }

    /** The host is going away: the gate opens with nothing applied (the views would be made on a dead host). */
    fun abandon() {
        open = true
        admitted.clear()
        held.clear()
    }

    companion object {
        /**
         * A chrome that has not said READY and drawn its frame within this of the first held
         * message – the served view's creation – is not going to in time to matter: the page is
         * made, loaded and shown anyway, and no worse than before the hold. Half the splash's own
         * watchdog ([StartupSplash.WATCHDOG_MS]), so the page is on screen before the splash lifts
         * on that path.
         */
        const val DEADLINE_MS = 5_000L
    }
}
