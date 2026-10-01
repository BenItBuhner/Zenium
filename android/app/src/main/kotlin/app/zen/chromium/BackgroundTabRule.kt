package app.zen.chromium

/**
 * Page visibility on a tab switch (OS-39): which tabs are BEHIND another tab on screen, so that
 * their pages are hidden to the engine the way Chrome's switched-away tab is.
 *
 * Chrome hides the tab a switch leaves (`TabModelSelectorImpl.requestToShowTab` →
 * `Tab.hide(CHANGED_TABS)` → `WebContents` HIDDEN): its page reads `document.visibilityState`
 * `hidden` and hears `visibilitychange`, so players pause by their own rule, its timers align to
 * one-second wake-ups, its frame callbacks stop, and the engine itself pauses an audible or a
 * muted `<video>` (`WebMediaPlayerImpl::OnPageHidden` → `ShouldPausePlaybackWhenHidden`, background
 * suspend and `kResumeBackgroundVideo` on; audio-only elements play on) and resumes it when the
 * tab is shown again. A WebView learns none of that from its own visibility: `AwContents` shows or
 * hides the WebContents by the WINDOW's visibility alone (`BrowserViewRenderer::IsClientVisible`),
 * so a page view set GONE for a switch stayed visible to its page, playing and un-throttled.
 *
 * The tab host cannot be told why a view leaves the screen – the core's relayout hides a view the
 * same way for a switch and for the chrome's covers (the overview, a sheet's recede, the private
 * lock) – so it reads the switch off what is on screen: a view that has been on screen before,
 * is off it now, while some tab's view IS on it, is behind that tab. Off the screen with no tab on
 * it is a cover, not a switch, and changes nothing: the page under the overview stays visible to
 * itself and keeps playing, as before; picking another card from there hides it then. A tab once
 * behind stays behind until its own view is on screen again – the cover going up over the tab in
 * front (the overview opened after a switch) does not bring the one behind back, where its paused
 * video would resume under the cover. A view that was never on screen (a tab opened in the
 * background, a tab restored at boot and not yet visited) is left as it is, so nothing of the boot
 * or the new-tab path changes here. The hold that answers for the engine's word,
 * [BackgroundVideoHold], applies the session's background-video allow to this hide as it does to
 * the window's. Pure, so the unit tests run it without a view.
 */
object BackgroundTabRule {
    /**
     * One tab's view as the tab host has it: on screen now, whether it has ever been, and whether
     * the last pass had it behind another tab.
     */
    class View(val tabId: String, val onScreen: Boolean, val shownBefore: Boolean, val behind: Boolean)

    /**
     * The tabs behind another tab on screen after this pass: every view off the screen that was
     * behind already, and – while some tab's view is on the screen – every view off it that has
     * been on it before. A view on screen is behind nothing.
     */
    fun behind(views: Collection<View>): Set<String> {
        val someOnScreen = views.any { it.onScreen }
        return views
            .filter { !it.onScreen && (it.behind || (someOnScreen && it.shownBefore)) }
            .mapTo(LinkedHashSet()) { it.tabId }
    }
}
