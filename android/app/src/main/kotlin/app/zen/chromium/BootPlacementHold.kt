package app.zen.chromium

/**
 * The boot's served new tab page is placed a FRAME AFTER the chrome's READY (NTP-35, the second
 * half of #563's mitigation (1); the first is the core's arm, `startup.ts` `bootNeedsPlacement`,
 * which does not wait for that page's placement), kept free of Android types so it runs under
 * plain JUnit (`BootPlacementHoldTest`); [Host] arms the frame and the deadline.
 *
 * Why. At a tablet's boot the served `zen://newtab` document is a SECOND WebView in the renderer
 * process the chrome shares, created GONE at 0×0 ([TabHost.create]) and shown by the chrome's first
 * layout report (`view.setBounds` + `view.setVisible`, one main-thread task). That view's first
 * synchronous draw is a long main-thread task on a slow GL (1.5 s on the CI emulator's software
 * renderer), and `chrome.ready` is a bridge message queued to the same thread: whether READY was
 * marked before or after that draw was the thread's scheduling, not a rule (#563's side measure of
 * the arm alone: READY +1708 / +3816 ms, two runs of one tree). So while the gate is CLOSED the
 * placement ops of a view that serves the new tab page – `view.setBounds`, `view.setVisible` and
 * the `view.shown` ask behind the batch – are HELD in their order, and applied in that order once
 * the frame after `chrome.ready` has been drawn (the READY frame's visual-state callback), or at
 * [DEADLINE_MS] from the first hold for a chrome that never says READY. The gate then stays OPEN for
 * the host's life: a New Tab from the sidebar's row is placed at once. A view that serves anything
 * else is never held – a restored page's placement is what READY waits for; the phone never boots a
 * served page – and takes the path it had.
 */
class BootPlacementHold {
    /** Open: nothing is held any more (the READY frame drawn, or the wait for it ran out). */
    var open = false
        private set

    private val held = ArrayList<Pair<String, () -> Unit>>()

    /** Whether an op of a view that `serves` the new tab page is to be held rather than applied. */
    fun holds(serves: Boolean): Boolean = !open && serves

    /**
     * Hold `op` for `tabId`. Answers whether it is the first held – the caller arms the deadline
     * on it. An op offered while the gate is open is applied at once (and answers false).
     */
    fun hold(tabId: String, op: () -> Unit): Boolean {
        if (open) {
            op()
            return false
        }
        held.add(tabId to op)
        return held.size == 1
    }

    /** Ops held right now. */
    val heldCount: Int get() = held.size

    /** Whether an op of `tabId` is held. */
    fun heldFor(tabId: String): Boolean = held.any { it.first == tabId }

    /**
     * The READY frame is drawn (or the wait for it ran out): the gate opens for good and what was
     * held is applied in the order it came, each op once. Answers how many ops were applied; 0
     * when the gate was open already.
     */
    fun release(): Int {
        if (open) return 0
        open = true
        val ops = ArrayList(held)
        held.clear()
        for ((_, op) in ops) op()
        return ops.size
    }

    companion object {
        /**
         * A chrome that has not said READY and drawn its frame within this of the first held
         * placement is not going to in time to matter: the page is shown anyway – the race the
         * hold removes, and no worse than before it. Half the splash's own watchdog
         * ([StartupSplash.WATCHDOG_MS]), so the page is on screen before the splash lifts on that
         * path.
         */
        const val DEADLINE_MS = 5_000L
    }
}
