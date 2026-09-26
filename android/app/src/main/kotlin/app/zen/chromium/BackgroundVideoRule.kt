package app.zen.chromium

/**
 * Background video (MED-08 / EDGE-32): what keeps a site's video playing when the app leaves the
 * screen, and what stops it today.
 *
 * Two things pause a playing `<video>` when the user goes Home or the screen locks, and neither is
 * the host's: the WebView's window visibility turns GONE, `AwContents` hides the WebContents, and
 * Chromium – background suspend and `kResumeBackgroundVideo` both on for Android – pauses every
 * hidden video that has picture (`WebMediaPlayerImpl::OnFrameHidden` → `ShouldPausePlaybackWhenHidden`,
 * the video "locked when paused when hidden" until a real gesture); the same hide reaches the page
 * as `visibilitychange`, on which most players pause themselves. An audio-only element keeps
 * playing through both. A page script can lie to the page about its visibility but cannot hold
 * the engine's pause, and a `play()` without user activation is paused again at once.
 *
 * So for a site whose `background-video` content setting is allow (block by default; the core
 * resolves the session tab's answer onto [MediaSessionInfo.backgroundVideo]), the host keeps the
 * engine's word VISIBLE instead: [TabWebView.onWindowVisibilityChanged] holds the window's hide
 * from the WebView while [keepsPlaying] says yes of the tab's session, so neither the engine nor
 * the page learns the app went to the background – no pause, no `visibilitychange`, the audio runs
 * on under the media notification and #223's foreground service (the session is still playing).
 * The moment the session stops playing with the window still away – the user paused it from the
 * notification, the clip ended, the site paused – the held hide goes through and the page is
 * hidden as it would have been; the return puts VISIBLE back in one step either way, so a page
 * that never heard it was hidden hears nothing on return, and one that did hears one change.
 *
 * Picture-in-picture is untouched: the window stays on screen in the small window, no hide comes,
 * and its X pauses the tab's video (#481) before the task leaves – [keepsPlaying] is false by then.
 * The rule is pure so the unit tests run it without a WebView.
 */
object BackgroundVideoRule {
    /**
     * Whether the session keeps `info.tabId`'s video playing in the background: a page's `<video>`
     * (a chrome player has no picture and needs no hold – audio plays hidden), playing, on a site
     * the user allowed.
     */
    fun keepsPlaying(info: MediaSessionInfo?): Boolean =
        info != null && info.playing && info.video && !info.chrome && info.backgroundVideo
}

/**
 * One tab's view between the system's word on its window and the engine's: the window visibility
 * the system dispatched last, the one the engine heard last, and whether a hide is being held.
 * [onWindow] and [onKeep] return the visibility to forward to the WebView, or null for nothing.
 */
class BackgroundVideoHold {
    /** The window is on screen by the system's last word. */
    var windowVisible = true
        private set
    /** The window is on screen by the engine's last word. */
    var engineVisible = true
        private set
    /** The session keeps this tab's video playing in the background ([BackgroundVideoRule.keepsPlaying]). */
    var keep = false
        private set

    /** A hide the system dispatched is being held from the engine. */
    val holding: Boolean get() = !windowVisible && engineVisible

    /**
     * The system said the window is `visible` (`onWindowVisibilityChanged`): what to tell the engine –
     * the same, or null to hold a hide while the session keeps the video playing.
     */
    fun onWindow(visible: Boolean): Boolean? {
        windowVisible = visible
        if (!visible && keep) return null
        engineVisible = visible
        return visible
    }

    /**
     * The session's word changed: a held hide goes through the moment the video no longer keeps
     * playing with the window still away (false to forward); nothing otherwise.
     */
    fun onKeep(value: Boolean): Boolean? {
        if (keep == value) return null
        keep = value
        if (!value && holding) {
            engineVisible = false
            return false
        }
        return null
    }
}
