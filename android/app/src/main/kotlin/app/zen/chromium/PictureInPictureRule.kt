package app.zen.chromium

/**
 * When the picture-in-picture window ends by itself, and what its ending asks of the tab, as
 * Chrome Android decides it (`chrome/android/java/src/org/chromium/chrome/browser/media/
 * FullscreenVideoPictureInPictureController.java`): pure rules over a small record of the
 * window, so [MediaSessions] – which owns the activity, the system's callbacks and the timing –
 * stays a thin shell and the decisions have unit tests.
 *
 * Chrome's controller dismisses its window – `moveTaskToBack(true)`, the task leaves the screen
 * and the system takes the small window down – for a handful of reasons, its
 * `MetricsEndReason`s: the tab closing (`onClosingStateChanged`, CLOSE), the renderer gone
 * (`onCrash`, CRASH), the activity's tab changing under the window (`DismissActivityOnTabChange
 * Observer`, NEW_TAB), the tab leaving fullscreen (`onExitFullscreen`, LEFT_FULLSCREEN) or its
 * video no longer being the effectively-fullscreen one (WEB_CONTENTS_LEFT_FULLSCREEN). A
 * navigation is not a reason of its own there: in Chrome it ends the fullscreen, and the
 * fullscreen's end ends the window. Zenium's window has a second way in – a page's own
 * `media.pip` (`MediaSessionService.enterPictureInPicture`) from an inline video – whose end the
 * fullscreen cannot signal; the document that starts in its place does ([End.NAVIGATED]).
 *
 * A dismissal that comes within [MIN_EXIT_DELAY_MS] of the entry waits it out (Chrome's
 * `MIN_EXIT_DELAY_MILLIS`): the system is still animating the window in, and a
 * `moveTaskToBack` under that animation leaves it in a bad state.
 *
 * How the window ends when the user ends it – expanded back to the app, or closed with its X –
 * is [onLeft]: expanded, the page resumes as it was, a fullscreen video still fullscreen; closed,
 * the video pauses (Chrome's `onStop` suspends the session while pip was open, since stopping
 * while it is open means the window was closed – restoring it resumes instead) and the tab
 * leaves fullscreen (Chrome's `FullscreenHtmlApiHandlerBase` exits persistent fullscreen on the
 * activity's STOPPED), so the tab the user comes back to is the page, not a paused video filling
 * the screen.
 */
object PictureInPictureRule {
    /** How the window came to be: from a video fullscreen (Home, or `media.pip` on it) or from an inline video's `media.pip`. */
    enum class Entry { FULLSCREEN, INLINE }

    /** Why the window ends by itself; [reason] is the word the `media.pip` event carries. */
    enum class End(val reason: String) {
        /** The tab whose page the window shows was closed (Chrome's CLOSE). */
        TAB_CLOSED("tab-closed"),
        /** The tab's renderer went away (Chrome's CRASH). */
        RENDERER_GONE("renderer-gone"),
        /** Another tab became the active one under the window (Chrome's NEW_TAB). */
        TAB_CHANGED("tab-changed"),
        /** The video's element left fullscreen while the window showed it fullscreen (Chrome's LEFT_FULLSCREEN). */
        LEFT_FULLSCREEN("left-fullscreen"),
        /** The tab's main frame started a new document: the video the window shows is gone. */
        NAVIGATED("navigated")
    }

    /** The window as the rules need it: whose tab, and which way it came in. */
    data class Window(val tabId: String, val entry: Entry)

    /** What the window's end – by the user's hand – asks of the tab. */
    data class Exit(val dismissed: Boolean, val pause: Boolean, val exitFullscreen: Boolean)

    /** Chrome's `MIN_EXIT_DELAY_MILLIS`: a dismissal sooner than this after the entry is re-posted. */
    const val MIN_EXIT_DELAY_MS = 50L

    /** The entry for a request on `tabId` while `fullscreenTabId`'s element (if any) is fullscreen. */
    fun entryOf(tabId: String, fullscreenTabId: String?): Entry =
        if (fullscreenTabId == tabId) Entry.FULLSCREEN else Entry.INLINE

    /** A tab was closed ([TabHost.destroy]): the window ends when it was that tab's. */
    fun onTabRemoved(window: Window?, tabId: String): End? =
        window?.takeIf { it.tabId == tabId }?.let { End.TAB_CLOSED }

    /** A tab's renderer is gone ([TabWebView.onRenderProcessGone]): the window ends when it was that tab's. */
    fun onRendererGone(window: Window?, tabId: String): End? =
        window?.takeIf { it.tabId == tabId }?.let { End.RENDERER_GONE }

    /** The active tab changed ([TabHost.show]): the window ends when it shows another tab than the new one. */
    fun onActiveTabChanged(window: Window?, activeTabId: String?): End? =
        window?.takeIf { activeTabId != null && it.tabId != activeTabId }?.let { End.TAB_CHANGED }

    /**
     * A tab's element left fullscreen ([Host.exitFullscreen]): the window ends when it was that
     * tab's and came in from the fullscreen; a window an inline video asked for is not the
     * fullscreen's to end (a page may go fullscreen and back around it).
     */
    fun onFullscreenExited(window: Window?, tabId: String): End? =
        window?.takeIf { it.tabId == tabId && it.entry == Entry.FULLSCREEN }?.let { End.LEFT_FULLSCREEN }

    /** A tab's main frame started a new document ([PageHost.documentStarted]): the window ends when it was that tab's. */
    fun onDocumentStarted(window: Window?, tabId: String): End? =
        window?.takeIf { it.tabId == tabId }?.let { End.NAVIGATED }

    /**
     * How long a dismissal decided at `nowMs` waits before it is carried out, for a window entered
     * at `enteredAtMs` (both on the same monotonic clock): the rest of [MIN_EXIT_DELAY_MS], or
     * nothing once it has passed.
     */
    fun exitDelayMs(nowMs: Long, enteredAtMs: Long): Long =
        (enteredAtMs + MIN_EXIT_DELAY_MS - nowMs).coerceIn(0L, MIN_EXIT_DELAY_MS)

    /**
     * The window left by the user's hand: `resumed` is whether the activity is on its way back to
     * the screen (expanded) rather than stopping (closed with the X), `playing` whether the tab's
     * video plays, `fullscreen` whether its element is fullscreen.
     */
    fun onLeft(resumed: Boolean, playing: Boolean, fullscreen: Boolean): Exit {
        val dismissed = !resumed
        return Exit(dismissed = dismissed, pause = dismissed && playing, exitFullscreen = dismissed && fullscreen)
    }
}
