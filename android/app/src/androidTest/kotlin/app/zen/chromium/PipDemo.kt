package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.graphics.Rect
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.LifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URL
import kotlin.math.abs

/**
 * Records the picture-in-picture window's life on the phone (MOT-30, MED-06), Chrome Android's
 * `FullscreenVideoPictureInPictureController` being the bar, in both schemes:
 *
 *  1. the clip playing fullscreen and Home: the window by itself (the auto-enter), the entry's
 *     frames traced (ruling 5: the chrome's long tasks across its hide), the window's bounds and
 *     ratio read, the tab's own view alone filling it over the chrome, the element's own
 *     `controls` off while the window stands (the design gate's change), and the chrome under it
 *     out of a screen reader's tree (the framework's word on the view); the window's menu under a
 *     finger – Pause (read back from the page), Play, Next track (the page's own handler) – then
 *     the expand, traced too: the page back inline in the chrome with the clip playing in its
 *     place, in view, its time run on and its controls back, and the chrome a reader's again. The
 *     WebView engine ends the element's fullscreen as the window shrinks, where Chrome keeps its
 *     tab fullscreen with a persistent video ([PictureInPictureRule]);
 *  2. the window on request (`media.pictureInPicture`, the in-app button's path) and its X: the
 *     clip pauses, the app stands behind the launcher, and comes back inline with the clip paused
 *     at its time; 2b: with another tab's audio holding the OS session, the X pauses the window's
 *     own tab and the audio plays on;
 *  3. the endings by the host's hand (Chrome's dismissals, `moveTaskToBack`): a new document in
 *     the window's tab, another tab shown under the window, the window's tab closed – each takes
 *     the window down with its task, and the tab the user comes back to is the page, the chrome a
 *     reader's again after the close; 3d: the window's skip buttons follow the page's declared
 *     handlers alone – cleared they go, the session ended leaves Close alone, a page without them
 *     never shows them; 3e: an ending fired with the screen off is held (Chrome's
 *     `mDismissPending`) and finished at the unlock – the window gone, not standing – the hold
 *     consumed once by the host's own log, though `KeyguardManager` still calls the keyguard locked
 *     as the activity starts (the platform's unlock order; the review's REQUIRED 1 at `2341ec967`);
 *  4. Home with no fullscreen video – a page without one, and the clip playing inline – does
 *     nothing new: no window (Chrome's auto-enter is the fullscreen video's alone);
 *  5. the site's `auto-picture-in-picture` setting governs the auto-enter (Chrome's rule, the
 *     row's Android support): set to Block through the core's `permissions.set`, the clip
 *     fullscreen and Home opens no window, while the user's own `media.pictureInPicture` still
 *     gets one; the rule forgotten (Allow, the default), the same Home enters the window again.
 *
 * The page is the media demos' (`media-demo-page.html`'s `/video`), read through its title.
 * Every check goes to `android-pip-notes.txt`; one that did not hold fails the run at its end.
 * Every touch injected has an assertion on what it did (the rule in [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class PipDemo : MediaDemoBase("android-pip") {
    override val tag = "PipDemo"
    private var failures = 0

    @Test
    fun record() {
        recordWithServer()
        assertEquals("checks that did not hold (see android-pip-notes.txt)", 0, failures)
    }

    /** The media demos' profile with its tab on the clip's page; the fullscreen exit hint counts as shown (its toast would stand in the fullscreen frames). */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "http://127.0.0.1:$PORT/video")
                tab.put("title", "Zenium picture-in-picture demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        super.warmUp()
        // The system's one-time "Viewing full screen" notice would stand over the clip's first fullscreen.
        shell("settings put secure immersive_mode_confirmations confirmed")
        shell("cmd uimode night no")
        note("night mode off; the system's one-time immersive notice counted as seen; API ${Build.VERSION.SDK_INT}, ${width}x$height")
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        note("clip: ${pageJs("document.getElementById('media').videoWidth")}x${pageJs("document.getElementById('media').videoHeight")}; page ${title()}")
    }

    override fun demo() {
        for (scheme in listOf("light", "dark")) {
            scheme(scheme)
            fullscreenHomeIntoTheWindow(scheme)
            requestedWindowAndItsX(scheme)
        }
        newDocumentEndsIt()
        anotherTabEndsIt()
        closingTheTabEndsIt()
        declaredSkipsOnly()
        theXPausesTheWindowsTabAlone()
        noFullscreenVideoNoWindow()
        theSitesSettingGovernsTheAutoEnter()
        screenOffEndingFinishesAtTheUnlock()
        note("\nend: pip=${inPip()} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId}; ${describeTab(TAB)}")
    }

    // --- 1. fullscreen, Home: the window by itself, its actions, the expand ---------------------

    private fun fullscreenHomeIntoTheWindow(scheme: String) {
        note("\n1 ($scheme). the clip playing fullscreen, Home: the window by itself (MOT-30), its actions (MED-06), the expand")
        frontApp()
        onTheClip()
        tapPageButton("fullscreen", "Play fullscreen", "the clip goes fullscreen", 15_000) {
            field("fs") == "1" || host.fullscreenTab?.tabId == TAB
        }
        SystemClock.sleep(2_500)
        if (field("state") != "playing") ensurePlaying()
        note("  fullscreen: page fs=${field("fs")} state=${field("state")} host fullscreenTab=${host.fullscreenTab?.tabId}")
        check("$scheme: the clip plays fullscreen before Home", field("state") == "playing" && host.fullscreenTab?.tabId == TAB)
        shot("01-fullscreen-$scheme")
        beat()
        val enter = traceFrames("pip-enter-$scheme", JankBudget.Kind.OPEN) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
            poll(10_000) { inPip() }
            poll(8_000) { host.tabs.filling == TAB }
            SystemClock.sleep(SETTLE_MS)
        }
        val win = appWindowBounds()
        val view = tabViewOnScreen(TAB)
        note(
            "  Home -> the window: pip=${inPip()} bounds $win (${ratio(win)}; the clip is ${field("size")}); the tab's view $view, z ${tabViewZ(TAB)}; " +
                "filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab}; page fs=${field("fs")} state=${field("state")}; " +
                "core pictureInPicture=${mediaState(TAB)?.optBoolean("pictureInPicture")} fill attribute=${pageJs("document.getElementById('media').hasAttribute('data-zenium-pip')")}"
        )
        check("$scheme: Home with the clip playing fullscreen enters picture-in-picture by itself", inPip())
        check("$scheme: the tab's view alone fills the small window, over the chrome", host.tabs.filling == TAB && covers(view, win))
        check("$scheme: the engine ended the element's fullscreen with the entry (the fill stands in for Chrome's persistent video)", host.fullscreenTab == null && field("fs") == "0")
        check("$scheme: the window's ratio is the clip's", ratioMatches(win, field("size")))
        check("$scheme: the clip keeps playing in the window", field("state") == "playing")
        val underWindow = readClip()
        note("  the element under the window: $underWindow; controls remembered=${pageJs("document.getElementById('media').hasAttribute('data-zenium-pip-controls')")}")
        check("$scheme: the engine's native controls are off the element while the small window stands (the design gate's change)", underWindow != null && !underWindow.controls)
        val under = chromeReader()
        note("  the chrome under the window: $under")
        check("$scheme: the chrome under the small window is out of a reader's tree (NO_HIDE_DESCENDANTS: TalkBack is handed the page alone)", under.mode == "no-hide-descendants" && !under.exposed)
        shot("02-window-$scheme")
        beat()
        if (win != null) {
            val trackBefore = field("track")
            check("$scheme: the window's Pause pauses the clip (the page reports it)", touchPipMenu(win, "Pause", "the window's Pause pauses the clip", shotAfter = "03-actions-$scheme") { field("state") == "paused" })
            SystemClock.sleep(1_000)
            shot("04-paused-$scheme")
            check("$scheme: the window's Play plays it again", touchPipMenu(win, "Play", "the window's Play plays the clip again") { field("state") == "playing" })
            check("$scheme: the window's Next track reaches the page's own handler", touchPipMenu(win, "Next track", "the page's nexttrack handler runs") { field("last") == "nexttrack" && field("track") != trackBefore })
            note("  after the actions: ${title()}; session ${describeSession()}")
        } else {
            dumpWindows("no app window in picture-in-picture")
        }
        val beforeExpand = readClip()
        val expandAt = SystemClock.uptimeMillis()
        val expand = traceFrames("pip-expand-$scheme", JankBudget.Kind.OPEN) {
            bringToFront()
            poll(8_000) { !inPip() }
            poll(8_000) { host.tabs.filling == null }
            SystemClock.sleep(SETTLE_MS)
        }
        val landed = readClip()
        val elapsed = SystemClock.uptimeMillis() - expandAt
        note("  expanded: pip=${inPip()} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab}; page fs=${field("fs")} state=${field("state")}; ${describeTab(TAB)}")
        note("  the landing: before the expand $beforeExpand; after ($elapsed ms) $landed")
        check("$scheme: the expand brings the page back inline in the chrome, the clip playing in its place", !inPip() && host.tabs.filling == null && host.fullscreenTab == null && field("fs") == "0" && field("state") == "playing")
        check("$scheme: the landing has the clip in view, in the state the window left it (playing on, its time run on, not restarted)", landed != null && beforeExpand != null && landed.inView && !landed.paused && continuous(beforeExpand, landed, elapsed))
        check("$scheme: the element's native controls are back with the expand", landed != null && landed.controls)
        val back = chromeReader()
        note("  expanded, the chrome: $back")
        check("$scheme: expanded, the chrome is a reader's again", back.mode == "auto" && back.exposed)
        note("  ruling 5: enter ${longTasks(enter)}; expand ${longTasks(expand)} (the tables in frames.txt)")
        shot("05-expanded-$scheme")
        beat()
    }

    // --- 2. the window on request and its X ------------------------------------------------------

    private fun requestedWindowAndItsX(scheme: String) {
        note("\n2 ($scheme). the window on request (media.pictureInPicture) and its X: the clip pauses, the app behind the launcher")
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        val enter = traceFrames("pip-request-$scheme", JankBudget.Kind.OPEN) {
            // The command fired and not waited for: the harness's reply poll would be chrome work of its own in the trace.
            chromeJs("window.zen.invoke('media.pictureInPicture',{tabId:${JSONObject.quote(TAB)}})")
            poll(10_000) { inPip() }
            poll(8_000) { host.tabs.filling == TAB }
            SystemClock.sleep(SETTLE_MS)
        }
        val win = appWindowBounds()
        note("  media.pictureInPicture: pip=${inPip()} bounds $win (${ratio(win)}) filling=${host.tabs.filling} pip tab=${host.media.pictureInPictureTab} state=${field("state")}")
        check("$scheme: media.pictureInPicture puts the inline clip into the window", inPip() && host.tabs.filling == TAB)
        shot("06-requested-window-$scheme")
        beat()
        val closed = if (win != null) {
            touchPipMenu(win, "Close", "the window closes and the clip pauses", timeoutMs = 10_000) { !inPip() && field("state") == "paused" }
        } else {
            dumpWindows("no app window in picture-in-picture")
            false
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  after the X: pip=${inPip()} state=${field("state")} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId}; in front: $front")
        check("$scheme: the X closes the window and pauses the clip (Chrome's onStop suspends the session)", closed)
        check("$scheme: the X leaves the app behind the launcher, not expanded", front != app.packageName && !inPip())
        shot("07-after-close-$scheme")
        note("  ruling 5: request ${longTasks(enter)}")
        val afterX = readClip()
        bringToFront()
        awaitPip(false, 5_000)
        frontApp()
        SystemClock.sleep(1_000)
        val back = readClip()
        note("  back in the app: pip=${inPip()} state=${field("state")} fs=${field("fs")} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        note("  the landing: after the X $afterX; back in the app $back")
        check("$scheme: the tab the user comes back to is the page inline, the clip paused", !inPip() && host.tabs.filling == null && field("fs") == "0" && field("state") == "paused")
        check("$scheme: paused stays paused at its time, the clip in view, its controls back", back != null && afterX != null && back.inView && back.paused && back.controls && abs(back.time - afterX.time) < 0.25)
        shot("08-back-after-close-$scheme")
        beat()
    }

    // --- 2b. the X is the window's tab's pause, not the session's -----------------------------------

    /**
     * Another tab's audio holds the OS session (the core resolves the playing one) while the clip's
     * window stands: the X pauses the clip – the window's own tab – and the audio plays on
     * (`83c32ed15`: the ending names the tab the window showed, not the session's).
     */
    private fun theXPausesTheWindowsTabAlone() {
        note("\n2b. the X pauses the window's own tab while another tab's audio holds the session (the per-tab pause)")
        frontApp()
        val audio = createTab("${server.origin}/audio", active = true)
        if (audio == null) {
            check("an audio tab opens beside the clip's", false)
            return
        }
        waitTitle(audio, 20_000) { it.startsWith("MD|kind:audio") }
        SystemClock.sleep(1_000)
        // A finger on its Play (the gesture the engine wants once), then the clip's tab back in front and into the window.
        val audioPlays = tapIn(audio, "play", "Play track", "the audio tab plays") { field("state", audio) == "playing" }
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
        val entered = audioPlays && intoTheWindow()
        val win = appWindowBounds()
        // The audio paused and played again from its own timer (an element once played by a gesture may): its report is the newer, the session its.
        pageJs("(function(){var a=document.getElementById('media');a.pause();setTimeout(function(){a.play()},300);return 'restarted'})()", audio)
        val sessionIsAudios = poll(8_000) { host.media.current?.tabId == audio }
        note("  the window on $TAB (entered=$entered, bounds $win); the audio tab $audio playing=${field("state", audio)}; the session's tab=${host.media.current?.tabId} (the audio's: $sessionIsAudios); pip tab=${host.media.pictureInPictureTab}")
        check("the audio tab's session holds the OS controls while the clip's window stands", entered && sessionIsAudios)
        val closed = if (entered && win != null) {
            touchPipMenu(win, "Close", "the window closes", timeoutMs = 10_000) { !inPip() }
        } else {
            false
        }
        SystemClock.sleep(1_500)
        note("  after the X: pip=${inPip()} clip state=${field("state")} audio state=${field("state", audio)}; the session's tab=${host.media.current?.tabId}; in front: ${ui.rootInActiveWindow?.packageName}")
        check("the X pauses the window's own tab, the clip", closed && field("state") == "paused")
        check("the other tab's audio plays on, untouched by the X", closed && field("state", audio) == "playing")
        shot("14-x-per-tab-pause")
        bringToFront()
        frontApp()
        pageJs("document.getElementById('media').pause()", audio)
        coreInvoke("tab.close", """{"tabId":"$audio"}""")
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
    }

    // --- 3. the endings by the host's hand -------------------------------------------------------

    /** 3a. A new document in the window's tab: the window ends with its task (a navigation away, MED-06). */
    private fun newDocumentEndsIt() {
        note("\n3a. a navigation in the window's tab ends the window (MED-06; the host's ending, Chrome's moveTaskToBack)")
        val entered = intoTheWindow()
        val left = entered && run {
            coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.navigate -> /notify: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; ${describeTab(TAB)}")
        check("a new document in the window's tab ends the window", entered && left)
        check("the ended window's task goes to the back (Chrome's dismissal), the new page not left in the small window", front != app.packageName && host.media.pictureInPictureTab == null)
        shot("09-navigated-ends")
        bringToFront()
        frontApp()
        waitTitle(TAB, 15_000) { it.startsWith("NT|") }
        note("  back: pip=${inPip()} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("back in the app the tab shows the new page inline", !inPip() && host.tabs.filling == null && title().startsWith("NT|"))
    }

    /** 3b. Another tab shown under the window: the window ends (Chrome's NEW_TAB). */
    private fun anotherTabEndsIt() {
        note("\n3b. another tab made active under the window ends it (Chrome's NEW_TAB)")
        frontApp()
        val other = createTab("${server.origin}/notify", active = false)
        note("  a second tab behind: ${other?.let(::describeTab) ?: "none (tab.create answered nothing)"}")
        val entered = intoTheWindow()
        val left = entered && other != null && run {
            coreInvoke("tab.activate", """{"tabId":"$other"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.activate $other: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; clip state=${field("state")}")
        check("another tab made active under the window ends it, the task to the back", entered && left && front != app.packageName)
        shot("10-tab-change-ends")
        bringToFront()
        frontApp()
        note("  back: active=${activeCoreTab()?.optString("id")} pip=${inPip()} filling=${host.tabs.filling}")
        if (other != null) coreInvoke("tab.close", """{"tabId":"$other"}""")
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
    }

    /** 3c. The window's tab closed: the window ends (Chrome's CLOSE). A second clip tab, so the demo tab stays. */
    private fun closingTheTabEndsIt() {
        note("\n3c. the window's tab closed ends it (Chrome's CLOSE)")
        frontApp()
        val clip = createTab("${server.origin}/video", active = true)
        if (clip == null) {
            check("a second clip tab opens for the close", false)
            return
        }
        waitTitle(clip, 20_000) { it.startsWith("MD|kind:video") }
        SystemClock.sleep(1_000)
        // A finger on its Play (the clip's play needs a gesture), then the window on request.
        val played = tapIn(clip, "play", "Play video", "the second tab's clip plays") { field("state", clip) == "playing" }
        val asked = if (played) coreInvoke("media.pictureInPicture", """{"tabId":"$clip"}""") else "not asked"
        val entered = played && awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == clip }
        SystemClock.sleep(SETTLE_MS)
        note("  the second clip tab $clip in the window: $entered (media.pictureInPicture -> $asked); pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}")
        val left = entered && run {
            coreInvoke("tab.close", """{"tabId":"$clip"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.close $clip: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; tabs ${coreState().getJSONObject("tabs").length()}")
        check("closing the window's tab ends the window, the task to the back", entered && left && front != app.packageName)
        shot("11-tab-close-ends")
        bringToFront()
        frontApp()
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
        note("  back: active=${activeCoreTab()?.optString("id")} pip=${inPip()} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("the demo tab is the one the user comes back to, inline", !inPip() && host.tabs.filling == null && activeCoreTab()?.optString("id") == TAB)
        // The fill ended by its view's removal, not by the system's expand: the chrome's reader hold must lift all the same (the review's REQUIRED 1).
        val afterClose = chromeReader()
        note("  the chrome after the CLOSE ending: $afterClose")
        check("the CLOSE ending gives the chrome back to a reader (AUTO, exposed): the fill's record dropped through the same notice as every fill's end", afterClose.mode == "auto" && afterClose.exposed)
    }

    /**
     * 3d. The window's skip buttons are the page's declared handlers alone (the design gate's (a)):
     * the handlers cleared leave them out of the menu on the next params update; the session ended
     * (the element emptied, the metadata gone: the core resolves none) leaves the menu the platform's
     * X and expand alone; a page that never declared them (`/video?tracks=0`) never shows them.
     */
    private fun declaredSkipsOnly() {
        note("\n3d. skip actions only where the page's session declares them: handlers cleared, the session ended, a page without them")
        val entered = intoTheWindow()
        val win = appWindowBounds()
        if (!entered || win == null) {
            check("the window stands for the declared-only check", false)
            return
        }
        val declared = host.media.current?.actions
        note("  declared by the page: $declared; the session's tab=${host.media.current?.tabId}")
        pageJs("(function(){navigator.mediaSession.setActionHandler('nexttrack',null);navigator.mediaSession.setActionHandler('previoustrack',null);return 'cleared'})()")
        val dropped = poll(8_000) { host.media.current?.let { "nexttrack" !in it.actions && "previoustrack" !in it.actions } == true }
        note("  handlers cleared: the session's actions ${host.media.current?.actions} (dropped=$dropped)")
        val menuAfterClear = menuButtons(win)
        note("  the menu: $menuAfterClear")
        check("the handlers cleared, the window's menu drops Next track and Previous track and keeps Pause", dropped && menuAfterClear != null && "Next track" !in menuAfterClear && "Previous track" !in menuAfterClear && "Pause" in menuAfterClear)
        settleMenu()
        pageJs("(function(){var m=document.getElementById('media');m.pause();m.removeAttribute('src');m.load();navigator.mediaSession.metadata=null;navigator.mediaSession.playbackState='none';return 'ended'})()")
        val ended = poll(8_000) { host.media.current == null }
        note("  the session ended by the page: current=${host.media.current?.tabId} (ended=$ended); pip=${inPip()} pip tab=${host.media.pictureInPictureTab}")
        val menuAfterEnd = menuButtons(win)
        note("  the menu: $menuAfterEnd")
        check("the session ended, the window stands with the platform's Close alone: no Pause, no Play, no track buttons", ended && inPip() && menuAfterEnd != null && "Close" in menuAfterEnd && menuAfterEnd.none { it == "Pause" || it == "Play" || it == "Next track" || it == "Previous track" })
        shot("15-ended-session-menu")
        settleMenu()
        bringToFront()
        awaitPip(false, 8_000)
        frontApp()
        // A page that never declared the track handlers: its window shows Pause and no skips.
        val single = createTab("${server.origin}/video?tracks=0", active = true)
        if (single == null) {
            check("a clip tab without track handlers opens", false)
            return
        }
        waitTitle(single, 20_000) { it.startsWith("MD|kind:video") }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth", single) != "0" }
        val played = tapIn(single, "play", "Play video", "the single clip plays") { field("state", single) == "playing" }
        val asked = if (played) coreInvoke("media.pictureInPicture", """{"tabId":"$single"}""") else "not asked"
        val singleEntered = played && awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == single }
        SystemClock.sleep(SETTLE_MS)
        val singleWin = appWindowBounds()
        note("  /video?tracks=0 in the window: $singleEntered (media.pictureInPicture -> $asked); declared ${host.media.current?.actions}; bounds $singleWin")
        val singleMenu = singleWin?.let { menuButtons(it) }
        note("  the menu: $singleMenu")
        check("a page without track handlers gets Pause and no Next track or Previous track", singleEntered && singleMenu != null && "Pause" in singleMenu && "Next track" !in singleMenu && "Previous track" !in singleMenu)
        shot("16-undeclared-skips-menu")
        settleMenu()
        coreInvoke("tab.close", """{"tabId":"$single"}""")
        awaitPip(false, 10_000)
        SystemClock.sleep(1_000)
        bringToFront()
        frontApp()
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        // The demo tab's clip was emptied above: the page again, whole.
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        SystemClock.sleep(1_000)
    }

    /**
     * 3e. An ending fired while the screen is off is held (Chrome's `mDismissPending`) and finished
     * at the unlock – the window GONE, not standing. A second clip tab in the window; the lock
     * screen on (swipe, no credential – the emulator boots with it disabled, a phone has one) and
     * the screen off; the window's tab closed from the core – the ending held, by the host's own
     * line; the screen on (the lock screen up, the window hidden behind it, the hold still held:
     * the pinned task's activity is not started under the keyguard); the keyguard dismissed – the
     * platform starts the activity as the keyguard goes away, BEFORE SystemUI reports it gone, so
     * `KeyguardManager.isKeyguardLocked` still answers true as `onStart` consumes the hold (the
     * review's REQUIRED 1 at `2341ec967`: read there it re-held the ending, and the window stood).
     * The host's log is the record: the hold's line(s) before the wake, ONE ending line after it and
     * no new hold. Runs last: it turns the lock screen on and off again, and a keyguard left standing
     * would take every later scene with it.
     */
    private fun screenOffEndingFinishesAtTheUnlock() {
        note("\n3e. an ending fired with the screen off is held and finished at the unlock: the window gone, not standing (the onStart consumer; REQUIRED 1 at 2341ec967)")
        frontApp()
        val keyguard = app.getSystemService(KeyguardManager::class.java)
        val power = app.getSystemService(PowerManager::class.java)
        val clip = createTab("${server.origin}/video", active = true)
        if (clip == null) {
            check("a second clip tab opens for the screen-off ending", false)
            return
        }
        waitTitle(clip, 20_000) { it.startsWith("MD|kind:video") }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth", clip) != "0" }
        SystemClock.sleep(1_000)
        val played = tapIn(clip, "play", "Play video", "the clip tab's clip plays") { field("state", clip) == "playing" }
        val asked = if (played) coreInvoke("media.pictureInPicture", """{"tabId":"$clip"}""") else "not asked"
        val entered = played && awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == clip }
        SystemClock.sleep(SETTLE_MS)
        note("  the clip tab $clip in the window: $entered (media.pictureInPicture -> $asked); pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; lifecycle ${lifecycleState()}")
        if (!entered) {
            check("the window stands for the screen-off ending", false)
            coreInvoke("tab.close", """{"tabId":"$clip"}""")
            coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
            return
        }
        shot("17-window-before-sleep")
        note("  lock screen enabled for the scene: ${shell("locksettings set-disabled false").trim()}")
        try {
            shell("svc power stayon false")
            shell("input keyevent KEYCODE_SLEEP")
            val dark = poll(6_000) { !power.isInteractive }
            SystemClock.sleep(2_000)
            note("  screen off: interactive=${power.isInteractive} (went dark: $dark) keyguard locked=${keyguard.isKeyguardLocked}; pip=${inPip()} pip tab=${host.media.pictureInPictureTab}; lifecycle ${lifecycleState()}")
            check("the screen goes off with the window up, the task still pinned", dark && inPip() && host.media.pictureInPictureTab == clip)
            // The ending with the screen off: the window's tab closed from the core.
            coreInvoke("tab.close", """{"tabId":"$clip"}""")
            val held = poll(8_000) { hostLog(clip).any { "held for onStart" in it } }
            SystemClock.sleep(1_500)
            val linesHeld = hostLog(clip)
            note("  tab.close $clip with the screen off: held=$held; pip=${inPip()} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; tabs ${coreState().getJSONObject("tabs").length()}; lifecycle ${lifecycleState()}\n  the host's lines so far:\n${linesHeld.joinToString("\n") { "    $it" }}")
            check("the ending fired with the screen off is held for onStart (the host's line), not carried out: the window's record kept", held && inPip() && host.media.pictureInPictureTab == clip && linesHeld.none { "ending picture-in-picture" in it })
            shell("input keyevent KEYCODE_WAKEUP")
            poll(6_000) { power.isInteractive }
            SystemClock.sleep(2_500)
            val lockedOnWake = keyguard.isKeyguardLocked
            note("  awake: interactive=${power.isInteractive} keyguard locked=$lockedOnWake; pip=${inPip()} pip tab=${host.media.pictureInPictureTab}; in front: ${ui.rootInActiveWindow?.packageName}; lifecycle ${lifecycleState()}; new host lines: ${hostLog(clip).size - linesHeld.size}")
            check("the lock screen stands on wake with the hold still held: the pinned task's activity is not started under the keyguard", lockedOnWake && inPip() && host.media.pictureInPictureTab == clip && hostLog(clip).size == linesHeld.size)
            shot("18-lock-screen-hold-held")
            beat()
            shell("wm dismiss-keyguard")
            val gone = awaitPip(false, 10_000)
            val unlocked = poll(8_000) { !keyguard.isKeyguardLocked }
            if (!unlocked) {
                note("  the keyguard stood after wm dismiss-keyguard: a swipe")
                unlock(keyguard)
            }
            SystemClock.sleep(2_000)
            val lines = hostLog(clip)
            val fresh = lines.drop(linesHeld.size)
            val front = ui.rootInActiveWindow?.packageName?.toString()
            note("  the keyguard dismissed: unlocked=$unlocked (locked now=${keyguard.isKeyguardLocked}); the window gone=$gone; pip=${inPip()} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; lifecycle ${lifecycleState()}\n  the host's lines since the wake:\n${fresh.joinToString("\n") { "    $it" }}")
            check("the window is GONE at the unlock, not standing: the held ending finished from onStart whatever the keyguard read", gone && host.media.pictureInPictureTab == null)
            check("the hold consumed once (the host's log): one ending line for the tab since the wake, no new hold", fresh.count { "ending picture-in-picture for $clip" in it } == 1 && fresh.none { "held for onStart" in it })
            check("the ended window's task is behind the launcher (Chrome's dismissal), the unlock landing on the launcher", front != app.packageName)
            shot("19-after-unlock-window-gone")
        } finally {
            shell("locksettings set-disabled true")
            shell("svc power stayon true")
        }
        bringToFront()
        frontApp()
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
        note("  back: active=${activeCoreTab()?.optString("id")} pip=${inPip()} filling=${host.tabs.filling} keyguard locked=${keyguard.isKeyguardLocked}; ${describeTab(TAB)}")
        check("the demo tab is the one the user comes back to, inline, the lock screen off again", !inPip() && host.tabs.filling == null && activeCoreTab()?.optString("id") == TAB && !keyguard.isKeyguardLocked)
    }

    // --- 4. no fullscreen video, no window --------------------------------------------------------

    private fun noFullscreenVideoNoWindow() {
        note("\n4. Home without a fullscreen video does nothing new: a page without one, then the clip playing inline")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify"}""")
        waitTitle(TAB, 15_000) { it.startsWith("NT|") }
        SystemClock.sleep(1_000)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val windowed = awaitPip(true, 4_000)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  a page without a video, Home: pip=$windowed pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front")
        check("Home on a page without a video opens no window", !windowed && host.media.pictureInPictureTab == null && front != app.packageName)
        shot("12-no-video-home")
        bringToFront()
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_000)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val inlineWindowed = awaitPip(true, 4_000)
        note("  the clip playing inline (not fullscreen), Home: pip=$inlineWindowed pip tab=${host.media.pictureInPictureTab} state=${field("state")}; in front: ${ui.rootInActiveWindow?.packageName}")
        check("Home with the clip playing inline opens no window (Chrome's auto-enter is the fullscreen video's alone)", !inlineWindowed && host.media.pictureInPictureTab == null)
        shot("13-inline-home")
        bringToFront()
        frontApp()
        note("  back: pip=${inPip()} state=${field("state")} filling=${host.tabs.filling}; ${describeTab(TAB)}")
    }

    // --- 5. the site's auto-picture-in-picture setting governs the auto-enter ---------------------

    /**
     * 5. The site's `auto-picture-in-picture` content setting (the catalogue's row, Allow by
     * default) governs the automatic entry alone, Chrome's rule. The site set to Block through the
     * core's `permissions.set` (no UI): the answer rides the session to the host
     * (`MediaSessionInfo.autoPictureInPicture`, the core's re-push on the change), and Home with the
     * clip playing fullscreen opens NO window – the activity's `isInPictureInPictureMode` false
     * after the transition (`setAutoEnterEnabled(false)` in its params); the user's own request
     * (`media.pictureInPicture`) still gets the window under Block – not the row's to refuse. The
     * site's rule forgotten (the default, Allow, again), the same Home enters the window as in 1.
     */
    private fun theSitesSettingGovernsTheAutoEnter() {
        note("\n5. the site's auto-picture-in-picture setting governs the auto-enter (Chrome's rule): Block, fullscreen, Home: no window; the request still answered; Allow again: the window")
        frontApp()
        onTheClip()
        val origin = tabOrigin(TAB)
        if (origin == null) {
            check("the clip tab's site is readable for the rule", false)
            return
        }
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        note("  the site: $origin; auto-picture-in-picture resolves ${autoPipResolution(origin)}; the session's autoPictureInPicture=${host.media.current?.autoPictureInPicture} (tab ${host.media.current?.tabId})")
        val set = coreInvoke("permissions.set", """{"origin":${JSONObject.quote(origin)},"permission":"auto-picture-in-picture","decision":"deny"}""")
        val carried = poll(8_000) { host.media.current?.let { it.tabId == TAB && !it.autoPictureInPicture } == true }
        note("  permissions.set deny -> $set; resolves ${autoPipResolution(origin)}; the session's autoPictureInPicture=${host.media.current?.autoPictureInPicture} (carried to the host: $carried)")
        check("the site's Block rides the session to the host (autoPictureInPicture=false: the core's re-push on the change)", carried)
        tapPageButton("fullscreen", "Play fullscreen", "the clip goes fullscreen under the site's Block", 15_000) {
            field("fs") == "1" || host.fullscreenTab?.tabId == TAB
        }
        SystemClock.sleep(2_500)
        if (field("state") != "playing") ensurePlaying()
        note("  fullscreen under Block: page fs=${field("fs")} state=${field("state")} host fullscreenTab=${host.fullscreenTab?.tabId}")
        check("Block: the clip plays fullscreen before Home", field("state") == "playing" && host.fullscreenTab?.tabId == TAB)
        shot("20-blocked-fullscreen")
        beat()
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val windowed = awaitPip(true, 4_000)
        SystemClock.sleep(1_000)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  Home under Block: windowed=$windowed isInPictureInPictureMode=${inPip()} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId}; in front: $front; state=${field("state")}")
        check("Block: Home with the clip playing fullscreen opens NO window – the auto-enter obeys the site's setting (isInPictureInPictureMode false after the transition)", !windowed && !inPip() && host.media.pictureInPictureTab == null && front != app.packageName)
        shot("21-blocked-home-no-window")
        beat()
        bringToFront()
        frontApp()
        leaveFullscreen()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline again", 15_000) { field("state") == "playing" }
        val asked = coreInvoke("media.pictureInPicture", """{"tabId":"$TAB"}""")
        val requested = awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == TAB }
        SystemClock.sleep(SETTLE_MS)
        note("  under Block, media.pictureInPicture -> $asked; in the window: $requested (pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; the session's autoPictureInPicture=${host.media.current?.autoPictureInPicture})")
        check("Block: the user's own request still gets the window (the setting governs the automatic entry alone)", requested && host.media.pictureInPictureTab == TAB)
        shot("22-blocked-requested-window")
        beat()
        bringToFront()
        awaitPip(false, 8_000)
        frontApp()
        val forgot = coreInvoke("permissions.forget", """{"origin":${JSONObject.quote(origin)},"permission":"auto-picture-in-picture"}""")
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline for the Allow half", 15_000) { field("state") == "playing" }
        val restored = poll(8_000) { host.media.current?.let { it.tabId == TAB && it.autoPictureInPicture } == true }
        note("  permissions.forget -> $forgot; resolves ${autoPipResolution(origin)}; the session's autoPictureInPicture=${host.media.current?.autoPictureInPicture} (restored: $restored)")
        check("the site's rule forgotten (Allow, the default, again) rides the session to the host", restored)
        tapPageButton("fullscreen", "Play fullscreen", "the clip goes fullscreen on Allow again", 15_000) {
            field("fs") == "1" || host.fullscreenTab?.tabId == TAB
        }
        SystemClock.sleep(2_500)
        if (field("state") != "playing") ensurePlaying()
        check("Allow again: the clip plays fullscreen before Home", field("state") == "playing" && host.fullscreenTab?.tabId == TAB)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val entered = awaitPip(true, 10_000)
        poll(8_000) { host.tabs.filling == TAB }
        SystemClock.sleep(SETTLE_MS)
        note("  Home on Allow again: pip=$entered pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; state=${field("state")}")
        check("Allow again: the same Home enters the window as before", entered && host.media.pictureInPictureTab == TAB)
        shot("23-allowed-home-window")
        beat()
        bringToFront()
        awaitPip(false, 8_000)
        frontApp()
        SystemClock.sleep(1_000)
        note("  back: pip=${inPip()} state=${field("state")} fs=${field("fs")} filling=${host.tabs.filling}; resolves ${autoPipResolution(origin)}; ${describeTab(TAB)}")
    }

    /** `tabId`'s site as the core's rules name it (`protocol://host:port`, the URL's origin), or null. */
    private fun tabOrigin(tabId: String): String? {
        val url = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("url").orEmpty()
        val parsed = runCatching { URL(url) }.getOrNull() ?: return null
        return "${parsed.protocol}://${parsed.host}${if (parsed.port >= 0) ":${parsed.port}" else ""}"
    }

    /** The site's stored `auto-picture-in-picture` decision as the core lists it (`permissions.listForPermission`), or the default, allow. */
    private fun autoPipResolution(origin: String): String {
        val rules = runCatching { JSONArray(coreInvoke("permissions.listForPermission", """{"permission":"auto-picture-in-picture"}""")) }.getOrNull()
            ?: return "allow (default; no list)"
        for (i in 0 until rules.length()) {
            val rule = rules.getJSONObject(i)
            if (rule.optString("origin") == origin) return rule.optString("decision")
        }
        return "allow (default)"
    }

    /** The element's fullscreen ended from the page (Home without a window leaves the app fullscreen behind the launcher). */
    private fun leaveFullscreen() {
        if (host.fullscreenTab == null && field("fs") != "1") return
        pageJs("(function(){if(document.fullscreenElement)document.exitFullscreen();return 'exit'})()")
        val left = poll(8_000) { host.fullscreenTab == null && field("fs") != "1" }
        if (!left) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            poll(5_000) { host.fullscreenTab == null }
        }
        SystemClock.sleep(1_000)
        note("  the element's fullscreen left (from the page: $left): fullscreenTab=${host.fullscreenTab?.tabId} fs=${field("fs")}")
    }

    // --- helpers ----------------------------------------------------------------------------------

    private fun scheme(scheme: String) {
        shell("cmd uimode night ${if (scheme == "dark") "yes" else "no"}")
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        // The theme blends over 240 ms (v2 §11.6); the launcher and SystemUI follow the night mode.
        SystemClock.sleep(2_500)
        ensureForeground()
        note("\n== the $scheme scheme (night mode ${if (scheme == "dark") "on" else "off"}) ==")
    }

    /** The demo tab on the clip's page (it navigates away in 3a and 4). */
    private fun onTheClip() {
        if (field("kind") == "video") return
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        SystemClock.sleep(1_000)
    }

    /** The clip playing inline and the window asked for it (`media.pictureInPicture`); whether the window came. */
    private fun intoTheWindow(): Boolean {
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        val asked = coreInvoke("media.pictureInPicture", """{"tabId":"$TAB"}""")
        val entered = awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == TAB }
        SystemClock.sleep(SETTLE_MS)
        note("  media.pictureInPicture -> $asked; in the window: $entered (pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} state=${field("state")})")
        return entered
    }

    private fun createTab(url: String, active: Boolean): String? =
        JSONTokener(coreInvoke("tab.create", """{"url":"$url","active":$active}""")).nextValue() as? String

    /** A real finger on the page button `id` of `tabId` (the demo tab's helper reads [TAB] alone). */
    private fun tapIn(tabId: String, id: String, label: String, effect: String, took: () -> Boolean): Boolean {
        val point = pageElementRect(id, tabId)?.let { touchPoint(it) } ?: run {
            note("  no '$label' on $tabId to touch")
            return false
        }
        Finger().tap(point.x, point.y)
        if (poll(15_000, took)) {
            note("  finger on $tabId's '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on $tabId's '$label' did not take: not $effect (page: ${title(tabId)})")
        note("  TOUCH FAULT: $tabId's '$label' did not $effect (page: ${title(tabId)})")
        return false
    }

    /** Where `tabId`'s view is on screen, or null. */
    private fun tabViewOnScreen(tabId: String): Rect? {
        var rect: Rect? = null
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            val at = IntArray(2).also { view.getLocationOnScreen(it) }
            rect = Rect(at[0], at[1], at[0] + view.width, at[1] + view.height)
        }
        return rect
    }

    /** `tabId`'s view's place among its parent's children, `index/count` (the last is on top). */
    private fun tabViewZ(tabId: String): String {
        var z = "no view"
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            val parent = view.parent as? ViewGroup ?: return@runOnMainSync
            z = "${parent.indexOfChild(view) + 1}/${parent.childCount}"
        }
        return z
    }

    /**
     * What a screen reader is handed of the chrome WebView: the importance the host set on the
     * view ([Host.readChrome]) and the framework's own word on it, `View.isImportantForAccessibility`
     * – false for a view in `NO_HIDE_DESCENDANTS`, true for the chrome as `AUTO` leaves it (a
     * WebView is focusable and clickable) – which is what decides whether a service without the
     * not-important flag, TalkBack, gets the view and the document under it. Read on the view
     * itself, on the main thread: the harness's own tree cannot show the hide (its flags ask for
     * every view), its flags are not to be changed for a read (UiAutomation's window list goes
     * stale on a change, and the small window's menu is read through that list – run 36157165808
     * lost the menu three taps running after one), and a WebView's node carries no importance
     * to read (Chromium's `createNodeForHost` copies visibility, enabled, package, class and
     * bounds onto it, not that – run 36159570565 read false in both states, for the page's
     * WebView too). The node's presence in the harness's tree is noted with it: the view is
     * covered for a reader, not gone.
     */
    private fun chromeReader(): ChromeReader {
        var reader = ChromeReader("no chrome", false)
        instrumentation.runOnMainSync {
            val chrome = host.underlay ?: return@runOnMainSync
            val mode = when (chrome.importantForAccessibility) {
                View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS -> "no-hide-descendants"
                View.IMPORTANT_FOR_ACCESSIBILITY_AUTO -> "auto"
                View.IMPORTANT_FOR_ACCESSIBILITY_YES -> "yes"
                View.IMPORTANT_FOR_ACCESSIBILITY_NO -> "no"
                else -> chrome.importantForAccessibility.toString()
            }
            reader = ChromeReader(mode, chrome.isImportantForAccessibility)
        }
        val root = ui.windows.firstNotNullOfOrNull { w -> w.root?.takeIf { it.packageName?.toString() == app.packageName } }
        val node = root?.findAccessibilityNodeInfosByViewId("${app.packageName}:id/zen_chrome")?.firstOrNull()
        return reader.copy(node = if (node == null) "not in the harness's tree" else "in the harness's tree, visible=${node.isVisibleToUser} children=${node.childCount}")
    }

    /** [chromeReader]'s read: the host's mode, whether the framework exposes the view to a reader, the node's presence. */
    private data class ChromeReader(val mode: String, val exposed: Boolean, val node: String = "") {
        override fun toString() = "mode $mode; exposed to a reader (View.isImportantForAccessibility)=$exposed; node $node"
    }

    /**
     * The small window's menu opened by a tap ([MediaDemoBase.openPipMenu], the look for its
     * Close) and every label SystemUI shows in it – the app's actions and the platform's own
     * buttons – or null when the menu never showed. The menu is left up; [MediaDemoBase.settleMenu]
     * before the next tap on the window.
     */
    private fun menuButtons(win: Rect): List<String>? {
        openPipMenu(win, "Close") ?: return null
        val labels = LinkedHashSet<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != SYSTEM_UI) continue
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 2_000) {
                val node = queue.removeFirst()
                visited++
                node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let(labels::add)
                node.text?.toString()?.takeIf { it.isNotBlank() }?.let(labels::add)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return labels.toList()
    }

    /**
     * The clip's element as the page has it: its box against the viewport (in view when its centre
     * is inside), `paused`, `currentTime`, `duration` and whether its `controls` attribute is on.
     */
    private data class ClipRead(
        val top: Double, val bottom: Double, val left: Double, val right: Double,
        val viewportWidth: Double, val viewportHeight: Double,
        val paused: Boolean, val time: Double, val duration: Double, val controls: Boolean
    ) {
        val inView: Boolean
            get() {
                val centreY = (top + bottom) / 2
                val centreX = (left + right) / 2
                return centreY >= 0 && centreY <= viewportHeight && centreX >= 0 && centreX <= viewportWidth
            }

        override fun toString() = "box x %.0f..%.0f y %.0f..%.0f in a %.0fx%.0f viewport (in view: %s); paused=%s currentTime=%.2f duration=%.2f controls=%s".format(
            left, right, top, bottom, viewportWidth, viewportHeight, inView, paused, time, duration, controls
        )
    }

    private fun readClip(tabId: String = TAB): ClipRead? {
        val raw = pageJs(
            "(function(){var e=document.getElementById('media');if(!e)return null;var r=e.getBoundingClientRect();" +
                "return JSON.stringify({t:r.top,b:r.bottom,l:r.left,r:r.right,w:innerWidth,h:innerHeight,p:e.paused,c:e.currentTime,d:e.duration,k:e.hasAttribute('controls')})})()",
            tabId
        )
        if (raw.isEmpty()) return null
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        return ClipRead(
            json.getDouble("t"), json.getDouble("b"), json.getDouble("l"), json.getDouble("r"),
            json.getDouble("w"), json.getDouble("h"),
            json.getBoolean("p"), json.getDouble("c"), json.optDouble("d", Double.NaN), json.getBoolean("k")
        )
    }

    /**
     * Whether the clip's time ran on from `before` to `after` across `elapsedMs` of wall time:
     * forward by about the time that passed (the loop's wrap allowed for; up to three seconds of
     * stall for the window's growth, during which the surface is remade), never back to a start.
     */
    private fun continuous(before: ClipRead, after: ClipRead, elapsedMs: Long): Boolean {
        val expected = elapsedMs / 1000.0
        var ran = after.time - before.time
        if (ran < 0 && before.duration.isFinite() && before.duration > 0) ran += before.duration
        return ran >= 0 && ran >= expected - 3.5 && ran <= expected + 1.0
    }

    /**
     * The host's lines about `tabId` in the logcat (`ZenMedia`, [MediaSessions]): an ending held
     * ("held for onStart"), one carried out ("ending picture-in-picture for"), a record dropped, a
     * `moveTaskToBack` refused. The buffer is read, never cleared (the run's own logcat stream is
     * the job's artifact).
     */
    private fun hostLog(tabId: String): List<String> =
        shell("logcat -d -s ZenMedia:I").lines()
            .filter { tabId in it }
            .map { it.substringAfter("ZenMedia").substringAfter(": ") }

    /** The activity's lifecycle state (CREATED while stopped: the screen off, or under the keyguard; STARTED with the window up). */
    private fun lifecycleState(): String {
        var state = "?"
        instrumentation.runOnMainSync { state = (activity as? LifecycleOwner)?.lifecycle?.currentState?.name ?: "no lifecycle owner" }
        return state
    }

    /** Whether `view` is the size of `win` (within a few px: the window's own rounding). */
    private fun covers(view: Rect?, win: Rect?): Boolean =
        view != null && win != null && abs(view.width() - win.width()) <= 8 && abs(view.height() - win.height()) <= 8

    /** Whether `win`'s ratio is the clip's (`size` as `WxH`), within the window's own rounding. */
    private fun ratioMatches(win: Rect?, size: String?): Boolean {
        if (win == null || win.height() <= 0 || size == null) return false
        val parts = size.split('x')
        val w = parts.getOrNull(0)?.toDoubleOrNull() ?: return false
        val h = parts.getOrNull(1)?.toDoubleOrNull() ?: return false
        if (w <= 0 || h <= 0) return false
        return abs(win.width().toDouble() / win.height() - w / h) < 0.05
    }

    /** Ruling 5's reading of a traced scene: the chrome WebView's renderer main thread across it. */
    private fun longTasks(scene: FrameStats.Scene): String {
        val t = scene.trace ?: return "no trace (${scene.traceMissing}); ${scene.summary?.frames ?: 0} frames in ${scene.durationMs} ms"
        return "%d long task(s) by thread time (%d by wall; the longest %.0f ms), main thread busy %.0f ms, layouts %d (%.0f ms), paints %d, style recalcs %d; %d frames in %d ms".format(
            t.longTasks, t.longTasksWall, t.longestTaskMs, t.busyMs, t.layoutCount, t.layoutMs, t.paintCount, t.styleRecalcCount, scene.summary?.frames ?: 0, scene.durationMs
        )
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    companion object {
        /** The rest after a window's change of state before it is read: the system's animation and the chrome's relayout. */
        private const val SETTLE_MS = 2_500L
    }
}
