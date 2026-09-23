package app.zen.chromium

/**
 * Whether the system bars are still on their way back after a page's fullscreen (MED-01), for
 * the chrome to hold its return fade until the page's view has landed: v2 §11.5 has the fade
 * run once the platform's shrink has landed, not over it. Kept free of Android types so it runs
 * under plain JUnit ([FullscreenLandingTest]); [Host] feeds it the fullscreen's edges and
 * [MainActivity] carries its word on every `insets` it sends the chrome (`settling`).
 *
 * Leaving fullscreen, the host shows the bars again and gives the orientation back. A screen
 * that turns back while the bars are on their way in is laid out on the bars as they stand at
 * the turn – the navigation bar's frame in the new orientation comes with a later dispatch – so
 * the chrome's first inline layout is one the final insets undo a moment later (run 4's exit:
 * the bar under the navigation bar for five frames, then above it). What the bars come back to
 * is known: the window as it was before the fullscreen, the same screen with the same insets.
 * So the bars are settling from the exit until the window is that one again. On the screen the
 * fullscreen began on they are bound to come back to it, so nothing shorter than
 * [SAME_SCREEN_DEADLINE_MS] gives up on them; on another screen (the moments before the turn
 * back, or a device the user turned meanwhile, which never comes back to the old insets) the
 * bars are taken as settled once nothing has changed for [QUIET_MS].
 */
class FullscreenLanding {
    /**
     * One state of the window: the insets the chrome is told (CSS px) and the screen they are on
     * (its size in dp, which turns with it).
     */
    data class Window(val top: Double, val right: Double, val bottom: Double, val left: Double, val screenWidthDp: Int, val screenHeightDp: Int) {
        fun sameScreenAs(other: Window): Boolean = screenWidthDp == other.screenWidthDp && screenHeightDp == other.screenHeightDp
    }

    /** The window the exit comes back to, kept from the first entry into fullscreen until the exit settles. */
    private var before: Window? = null
    /** When the fullscreen ended, or -1 while none is being left. */
    private var exitAt = -1L
    /** The window as last judged, and when it last changed (or the exit). */
    private var latest: Window? = null
    private var changedAt = -1L

    /** The bars are on their way back from a fullscreen. */
    val settling: Boolean get() = exitAt >= 0

    /**
     * Whether the window the exit comes back to is portrait (taller than wide), while one is
     * kept – from the fullscreen's entry until its exit has settled; null when none is. The
     * frames the chrome lays out for the other orientation meanwhile are held to it
     * ([TabHost.landingOn]).
     */
    fun landsOnPortrait(): Boolean? = before?.let { it.screenHeightDp > it.screenWidthDp }

    /**
     * The host is going fullscreen from `window` (its bars still where they were): the state the
     * exit comes back to. A fullscreen entered again while the last one's exit is still settling
     * (the tab's second video, a switch of tabs) keeps the window from before the first; the
     * settle itself is over, the chrome being fullscreen again.
     */
    fun onEnter(window: Window) {
        if (before == null) before = window
        exitAt = -1
        latest = null
        changedAt = -1
    }

    /** The fullscreen ends now: the bars start their way back. */
    fun onExit(now: Long) {
        if (before == null) return
        exitAt = now
        latest = null
        changedAt = now
    }

    /**
     * The window stands at `window` now: whether the bars are still settling. Once they are not,
     * the settle is over for good; the next word is the next exit's.
     */
    fun settle(window: Window, now: Long): Boolean {
        val target = before
        if (!settling || target == null) return false
        if (window != latest) {
            latest = window
            changedAt = now
        }
        val done = when {
            window == target -> true
            window.sameScreenAs(target) -> now - exitAt >= SAME_SCREEN_DEADLINE_MS
            else -> now - changedAt >= QUIET_MS
        }
        if (done) {
            exitAt = -1
            before = null
            latest = null
        }
        return !done
    }

    /**
     * When to judge again with nothing new (`uptime` ms): the quiet's end on another screen, the
     * deadline on the fullscreen's own; -1 while nothing is settling or before the first judgement.
     */
    fun nextCheckAt(): Long {
        val target = before
        val window = latest
        if (!settling || target == null || window == null) return -1
        return if (window.sameScreenAs(target)) exitAt + SAME_SCREEN_DEADLINE_MS else changedAt + QUIET_MS
    }

    companion object {
        /**
         * On another screen than the fullscreen began on, the bars are settled once nothing has
         * changed for this long: long enough for a turn back that is on its way (the system
         * requests it within a few hundred ms of the orientation's release) to arrive first.
         */
        const val QUIET_MS = 500L
        /**
         * On the fullscreen's own screen the bars come back to where they were; this is the
         * outside wait for a system that never says so (a device state changed under the
         * fullscreen), well past a slow emulator's exit.
         */
        const val SAME_SCREEN_DEADLINE_MS = 5_000L
    }
}
