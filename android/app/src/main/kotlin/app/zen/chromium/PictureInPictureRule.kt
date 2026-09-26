package app.zen.chromium

/**
 * When the picture-in-picture window ends by itself, and what its ending asks of the tab, as
 * Chrome Android decides it (`chrome/android/java/src/org/chromium/chrome/browser/media/
 * FullscreenVideoPictureInPictureController.java`): pure rules over the tab the window shows,
 * so [MediaSessions] – which owns the activity, the system's callbacks and the timing – stays a
 * thin shell and the decisions have unit tests.
 *
 * Chrome's controller dismisses its window – `moveTaskToBack(true)`, the task leaves the screen
 * and the system takes the small window down – for a handful of reasons, its
 * `MetricsEndReason`s: the tab closing (`onClosingStateChanged`, CLOSE), the renderer gone
 * (`onCrash`, CRASH), the activity's tab changing under the window (`DismissActivityOnTabChange
 * Observer`, NEW_TAB), and the tab leaving fullscreen (`onExitFullscreen`, LEFT_FULLSCREEN) or
 * its video no longer being the effectively-fullscreen one (WEB_CONTENTS_LEFT_FULLSCREEN). The
 * last two have no counterpart here: Chrome keeps the tab fullscreen through the small window
 * (`WebContents.setHasPersistentVideo`, the video laid over the viewport by the engine), while
 * the WebView engine ends the element's fullscreen as the window shrinks (`onHideCustomView`
 * right after the entry – #244's run notes), and the host answers with the tab's own view
 * filling the window and the page's fill style over the video ([TabHost.fillWindow],
 * `mediaSessionScript.ts`'s `setFill`): the fullscreen's end IS the window's entry, and there
 * is no fullscreen left to leave while the window is up. A navigation is not a reason of its own
 * in Chrome either – there it ends the fullscreen, and the fullscreen's end ends the window –
 * but is one here, for the same want: the document that starts in the video's place
 * ([End.NAVIGATED]).
 *
 * A dismissal that comes within [MIN_EXIT_DELAY_MS] of the entry waits it out (Chrome's
 * `MIN_EXIT_DELAY_MILLIS`): the system is still animating the window in, and a
 * `moveTaskToBack` under that animation leaves it in a bad state. One decided with the screen
 * off or the keyguard up is held for the activity's next `onStart` instead ([shouldDeferEnding],
 * Chrome's `mDismissPending`).
 *
 * While the window is up its params follow its own tab's session alone ([windowSession]): a
 * session another tab's audio takes meanwhile is none for the window, whose own buttons go with
 * it – Chrome's window sets no actions of its own, and SystemUI's row on it is the package's
 * active media session's.
 *
 * How the window ends when the user ends it – expanded back to the app, or closed with its X –
 * is [onLeft]: expanded, the page resumes as it was; closed, the video pauses (Chrome's `onStop`
 * suspends the session while pip was open, since stopping while it is open means the window was
 * closed – restoring it resumes instead) and a tab whose element is fullscreen still leaves it
 * (Chrome's `FullscreenHtmlApiHandlerBase` exits persistent fullscreen on the activity's
 * STOPPED), so the tab the user comes back to is the page, not a paused video filling the screen.
 */
object PictureInPictureRule {
    /** Why the window ends by itself; [reason] is the word the `media.pip` event carries. */
    enum class End(val reason: String) {
        /** The tab whose page the window shows was closed (Chrome's CLOSE). */
        TAB_CLOSED("tab-closed"),
        /** The tab's renderer went away (Chrome's CRASH). */
        RENDERER_GONE("renderer-gone"),
        /** Another tab became the active one under the window (Chrome's NEW_TAB). */
        TAB_CHANGED("tab-changed"),
        /** The tab's main frame started a new document: the video the window shows is gone. */
        NAVIGATED("navigated")
    }

    /**
     * What the window's end – by the user's hand – asks of the tab: `pauseTabId` is the tab whose
     * video the X pauses (the window's own, never another's), null when nothing is to pause.
     */
    data class Exit(val dismissed: Boolean, val pauseTabId: String?, val exitFullscreen: Boolean)

    /** Chrome's `MIN_EXIT_DELAY_MILLIS`: a dismissal sooner than this after the entry is re-posted. */
    const val MIN_EXIT_DELAY_MS = 50L

    /** A tab was closed ([TabHost.destroy]): the window showing `pipTabId` ends when it was that tab's. */
    fun onTabRemoved(pipTabId: String?, tabId: String): End? =
        if (pipTabId != null && pipTabId == tabId) End.TAB_CLOSED else null

    /** A tab's renderer is gone ([TabWebView.onRenderProcessGone]): the window ends when it was that tab's. */
    fun onRendererGone(pipTabId: String?, tabId: String): End? =
        if (pipTabId != null && pipTabId == tabId) End.RENDERER_GONE else null

    /** The core brings a tab on screen ([Host.setTabVisible]): the window ends when it shows another tab than that one. */
    fun onActiveTabChanged(pipTabId: String?, activeTabId: String?): End? =
        if (pipTabId != null && activeTabId != null && pipTabId != activeTabId) End.TAB_CHANGED else null

    /** A tab's main frame started a new document ([PageHost.documentStarted]): the window ends when it was that tab's. */
    fun onDocumentStarted(pipTabId: String?, tabId: String): End? =
        if (pipTabId != null && pipTabId == tabId) End.NAVIGATED else null

    /**
     * How long a dismissal decided at `nowMs` waits before it is carried out, for a window entered
     * at `enteredAtMs` (both on the same monotonic clock): the rest of [MIN_EXIT_DELAY_MS], or
     * nothing once it has passed.
     */
    fun exitDelayMs(nowMs: Long, enteredAtMs: Long): Long =
        (enteredAtMs + MIN_EXIT_DELAY_MS - nowMs).coerceIn(0L, MIN_EXIT_DELAY_MS)

    /**
     * Whether an ending decided now is held for the activity's next `onStart` (Chrome's
     * `mDismissPending`, consumed in its `onStart`) rather than carried out: with the screen off
     * (`PowerManager.isInteractive` false) or the keyguard up (`KeyguardManager.isKeyguardLocked`)
     * a `moveTaskToBack` "gets Android into a bad state" (Chrome's `dismissActivityIfNeeded`,
     * whose comment names both states while its predicate reads `isInteractive` alone; the
     * keyguard is read here as the comment says). Held, the window's tab's media pauses at once –
     * what the end would have done – and the task goes to the back after the unlock.
     *
     * At the start itself (`atStart`: the held ending consumed from `onStart`) the keyguard's word
     * is not read. The platform's unlock starts the activity before it reports the keyguard gone:
     * `keyguardGoingAway` makes the pinned task's activity visible and schedules its `onStart`,
     * while SystemUI clears the showing state `KeyguardManager.isKeyguardLocked` reads only in
     * `onKeyguardExitFinished`, after the exit animation – so the reading is still true as
     * `onStart` runs (on swipe-to-unlock from the swipe's start). Read there it would hold the
     * ending it was meant to finish, and the window of a closed tab would come back with the
     * unlock and stand. Chrome's `onStart` re-check is `isInteractive` alone, and so is this one:
     * a start with the screen off is not a start to end from.
     */
    fun shouldDeferEnding(interactive: Boolean, keyguardLocked: Boolean, atStart: Boolean = false): Boolean =
        !interactive || (keyguardLocked && !atStart)

    /**
     * The window left by the user's hand: `pipTabId` is the tab the window was pinned to,
     * `pipPlaying` whether THAT tab's media plays by its own last report (Chrome's `mIsPlaying`, a
     * `WebContentsObserver` on the PiP'd tab – not the session the OS controls show, which a
     * background tab's audio may have taken since the window went up), `resumed` whether the
     * activity is on its way back to the screen (expanded) rather than stopping (closed with the
     * X), `fullscreen` whether its element is fullscreen. The X pauses the window's tab, as Chrome's
     * `onStop` suspends the PiP'd WebContents' own session.
     */
    fun onLeft(pipTabId: String, pipPlaying: Boolean, resumed: Boolean, fullscreen: Boolean): Exit {
        val dismissed = !resumed
        return Exit(dismissed = dismissed, pauseTabId = pipTabId.takeIf { dismissed && pipPlaying }, exitFullscreen = dismissed && fullscreen)
    }

    /**
     * The window's tab's media by its own last word – Chrome's `mIsPlaying`, moved by a
     * `WebContentsObserver` on the PiP'd tab alone (`mediaStartedPlaying` / `mediaStoppedPlaying`):
     * a `media.update` for the window's tab is its word; one for another tab (a background tab's
     * audio took the session – the core resolves the tab whose media started last) or for no
     * session at all (a short video keeps no session of its own) leaves the last word standing.
     */
    fun pipPlaying(pipTabId: String, lastKnown: Boolean, sessionTabId: String?, sessionPlaying: Boolean): Boolean =
        if (sessionTabId == pipTabId) sessionPlaying else lastKnown

    /**
     * The tab a control from the system acts on: the tab the button was shown for when it carries
     * one (the picture-in-picture window's own actions name the window's tab, [windowSession]),
     * else the session's tab (the notification's and the lock screen's buttons are the session's
     * own, as is SystemUI's row on a window with no actions of its own). Null: nothing to act on.
     */
    fun controlTab(shownFor: String?, sessionTabId: String?): String? = shownFor ?: sessionTabId

    /**
     * The session the picture-in-picture window's params follow: without the window, the session
     * as the core resolved it (the auto-enter rule, the shape and buttons the window would open
     * with); with the window up, its own tab's session alone. Another tab's session holding the
     * OS controls (a background tab's audio – the core resolves the tab whose media started last)
     * is none for the window: its params become those of no session – the shape kept, the actions
     * emptied ([MediaSessions.paramsOf] with null) – since the window's own tab's session may have
     * ended behind the other's (the host hears the resolved session alone, and buttons kept for a
     * session that is gone act on nothing). Chrome's window sets no actions of its own; SystemUI's
     * row on it is the package's active media session's – the other tab's play / pause, acting on
     * that tab – or the X and expand alone with no session active: the row this leaves, in either
     * state. The window's own tab's session taking the controls back brings its buttons back.
     */
    fun windowSession(pipTabId: String?, session: MediaSessionInfo?): MediaSessionInfo? =
        if (pipTabId == null || session?.tabId == pipTabId) session else null
}
