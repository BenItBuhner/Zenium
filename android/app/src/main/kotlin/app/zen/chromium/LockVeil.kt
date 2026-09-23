package app.zen.chromium

/**
 * The opaque veil the host draws over the chrome from the private lock's arming until the
 * chrome's first masked frame is on the display (the `09-locked` finding of #346; §9.19's "never
 * shown sharp" applied to the chrome itself). Kept free of Android types so it runs under plain
 * JUnit (`LockVeilTest`); [Host] owns the view and the frame timing.
 *
 * The leak it closes: after a return the app's own window presents the chrome WebView's last
 * compositor frame – the departure's private titles and address over the blanked page area –
 * from the window's first frame until the renderer's first frame back (≈ 2.4 s under
 * swiftshader, a few frames on hardware). `FLAG_SECURE` blanks captures and Recents, not the
 * window's own presentation, and the chrome's cover ([PrivateLock], `PrivateLockCover`) is in
 * that renderer frame, so it cannot be earlier than the leak. The host can: as the lock goes on
 * with a private surface in view ([arm]; a lock armed with nothing private on the chrome has no
 * identity in the stale frame and raises none) it lays an opaque view over the chrome in the
 * window's tone – the colour `chrome.setTheme` last painted on the root, the private theme's
 * near-black while a private surface is up – and lets it fall only once the chrome's frame that
 * carries the mask is on the display: the renderer reports its masked tree committed
 * (`private.masked`, [masked]); once the window is on screen ([windowStarted]) the host posts
 * the chrome's visual-state callback and counts the frame that draws it ([awaitFrame],
 * [frameDrawn]). The lock's release lowers it at once ([lower]: what is under is the chrome as
 * it may be seen). A deadline from the window's start ([DEADLINE_MS], the host's) lowers a veil
 * no frame ever answered for, so it can never stick; that is logged, never silent.
 *
 * Nothing here delays the chrome's own cover – the renderer draws it beneath the veil as before –
 * and nothing runs on the boot path: the view exists from the first raise.
 */
class LockVeil {
    /** The veil is over the chrome. */
    var raised = false
        private set

    /** The window is on screen (`onStart` … `onStop`); a veil raised while it is not waits for the start. */
    var windowVisible = true
        private set

    /** The renderer reported the lock's masked tree committed while the veil is raised; its frame is what the veil waits for. */
    var maskedReported = false
        private set

    /** A frame wait is in flight: the visual-state callback posted, the frame not yet counted. */
    var awaitingFrame = false
        private set

    /** The serial of the wait in flight; a callback from an earlier wait is not this one's ([frameDrawn]). */
    var waitSerial = 0L
        private set

    /**
     * The lock went on. With `privateSurface` – a private tab in view or the overview's private
     * pane, the chrome's last word (`window.setSecure`) – the veil goes up. Answers whether it
     * went up now (an armed veil stays as it is).
     */
    fun arm(privateSurface: Boolean): Boolean {
        if (raised || !privateSurface) return false
        raised = true
        maskedReported = false
        awaitingFrame = false
        return true
    }

    /**
     * `private.masked`: the renderer's masked tree is committed. Answers whether the frame wait
     * starts now – the veil raised, the window on screen, no wait in flight; a report while the
     * window is away is kept for [windowStarted]. Nothing without a veil.
     */
    fun masked(): Boolean {
        if (!raised) return false
        maskedReported = true
        return awaitFrame()
    }

    /**
     * The window is on screen again (`Host.onStart`). Answers whether the frame wait starts now:
     * a report that came while the window was away is waited for from here.
     */
    fun windowStarted(): Boolean {
        windowVisible = true
        return raised && maskedReported && awaitFrame()
    }

    /**
     * The window left the screen (`Host.onStop`). A wait in flight is void: the chrome draws no
     * frame for a window that is away, and the next start posts a new one (its callback, should
     * it still fire, is not the new wait's – [waitSerial]).
     */
    fun windowStopped() {
        windowVisible = false
        awaitingFrame = false
    }

    private fun awaitFrame(): Boolean {
        if (!windowVisible || awaitingFrame) return false
        awaitingFrame = true
        waitSerial++
        return true
    }

    /**
     * The frame the wait `serial` was posted for is on the display. Answers whether the veil
     * falls now: only for the wait in flight, on a veil still raised. The state is down on a true
     * answer: the host takes its view down on that answer, not on a second [lower].
     */
    fun frameDrawn(serial: Long): Boolean {
        if (!raised || !awaitingFrame || serial != waitSerial) return false
        return lower()
    }

    /** The veil falls (the masked frame, the lock's release, the deadline). Answers whether it was up. */
    fun lower(): Boolean {
        if (!raised) return false
        raised = false
        maskedReported = false
        awaitingFrame = false
        return true
    }

    companion object {
        /**
         * The longest the veil stays after the window's start with no masked frame answered for
         * (the renderer gone, a chrome mid-rebuild, a callback the window never drew): the span
         * the paint probe gives the chrome for an answer (`HostLifecycle.PROBE_TIMEOUT_MS`),
         * beyond the slowest renderer's first frame back the harness has seen (≈ 2.4 s under
         * swiftshader). A veil lowered by it is a finding, logged by the host.
         */
        const val DEADLINE_MS = 5_000L
    }
}
