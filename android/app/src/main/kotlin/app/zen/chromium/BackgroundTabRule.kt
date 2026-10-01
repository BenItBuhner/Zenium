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
 * The core's relayout hides a view the same way for a switch and for the chrome's covers (a
 * sheet's recede, the URL field, a prompt, the private lock), so the host reads the switch off
 * what is on screen: a view that has been on screen before, is off it now, while some tab's view
 * IS on it, is behind that tab. Off the screen with no tab on it is a cover, not a switch, and
 * changes nothing: the page under a sheet stays visible to itself and keeps playing, as before.
 * The one cover that is a switch has the core's word: the tab overview, open or on its way open,
 * is a switch away from the pages under it (`LayoutReport.switchedAway`, the hide's `switched`;
 * the lead's ruling on #728), so the page under the overview is behind it as Chrome's is behind
 * the tab switcher – hidden to itself, its video paused – and comes back when the overview closes
 * on it; picking another card leaves it behind. A tab once behind stays behind until its own
 * view is on screen again – the cover going up over the tab in front (the overview opened after a
 * switch) does not bring the one behind back, where its paused video would resume under the
 * cover. A view that was never on screen (a tab opened in the
 * background, a tab restored at boot and not yet visited) is left as it is: the boot's restored
 * tabs and a new tab's first show cost one trivial O(N) pass over the views that finds nobody
 * behind and writes no change, and nothing else of those paths changes here. The hold that
 * answers for the engine's word, [BackgroundVideoHold], applies the session's background-video
 * allow to this hide as it does to the window's – held only while the allowed site's video is
 * playing ([BackgroundVideoRule.keepsPlaying]); a silent allowed site is hidden like any other.
 * Pure, so the unit tests run it without a view.
 */
object BackgroundTabRule {
    /**
     * One tab's view as the tab host has it: on screen now, whether it has ever been, whether
     * the last pass had it behind another tab, and whether the core named its last hide a switch
     * (the tab overview over it, `switched`; false for a cover and for a view on screen).
     */
    class Tab(
        val tabId: String,
        val onScreen: Boolean,
        val shownBefore: Boolean,
        val behind: Boolean,
        val switched: Boolean = false
    )

    /**
     * The tabs behind another tab on screen after this pass: every view off the screen that was
     * behind already or whose hide the core named a switch, and – while some tab's view is on
     * the screen – every view off it that has been on it before. A view on screen is behind
     * nothing.
     */
    fun behind(tabs: Collection<Tab>): Set<String> {
        val someOnScreen = tabs.any { it.onScreen }
        return tabs
            .filter { !it.onScreen && (it.behind || it.switched || (someOnScreen && it.shownBefore)) }
            .mapTo(LinkedHashSet()) { it.tabId }
    }
}
