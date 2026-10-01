package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.lifecycle.LifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL

/**
 * Page visibility on a tab switch (OS-39): what a page in the tab LEFT BEHIND hears of its own
 * visibility, and what happens to its media and its timers, when the user switches to another tab
 * with the app in front – held to what Chrome does for the tab a switch leaves, and against what
 * the same page hears when the whole app goes to Home (the control; MED-08's fact a).
 *
 * The loopback `/visibility` page comes in kinds (`?kind=`): a `<video>` with sound, the same clip
 * muted, an `<audio>` track, and timers only; every kind runs a 100 ms interval and a
 * requestAnimationFrame loop and counts the `visibilitychange` events it hears. The second tab,
 * `/other`, is a plain page. For every kind: the page in front (playing, where there is media),
 * the switch to the other tab through the core's `tab.activate` – the relayout path every switch
 * takes – two reads three seconds apart while it sits behind (`document.visibilityState`, the
 * events heard, `paused` and `currentTime`, the interval's and the frame loop's cadence), then
 * the switch back and one more read. Chrome's rule for the tab left behind, which the checks
 * hold the page to ([BackgroundTabRule]): the page reads `hidden` and hears one `visibilitychange`;
 * the engine pauses an audible or a muted `<video>` and resumes it on the return; an `<audio>`
 * plays on; frame callbacks stop. The interval's cadence is recorded as a fact for every kind:
 * Chrome's scheduler aligns a hidden page's timers to one-second wake-ups unless the page was
 * audible within the last 30 s (`kRecentAudioDelay`), and the `Page` that keeps that memory
 * outlives a navigation in the same tab, so the two kinds without sound run first, on a tab that
 * has never been audible, and the two with sound are measured inside that window. Then the
 * control, Home with the clip with sound (unchanged by OS-39); then the OS-08 cases, the site
 * allowed `background-video` and switched away: playing – held from the hide as it is held from
 * Home's, the page visible to itself and the clip playing on; silent – hidden like any other site
 * (the allow holds only while the video plays); playing and then paused by the page while behind
 * – hidden the moment the sound stops, and a `play()` while hidden un-hides nothing. Last, the
 * tab overview opened over the page by a real touch and closed again, plain and allowed, as FACT
 * lines of what the page reads under that cover today ([overviewCover]).
 *
 * A `check` that did not hold fails the run at its end; what is measured but not held to goes to
 * the notes as a `FACT`. Every touch injected has an assertion on what it did (the rule in
 * [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class PageVisibilityDemo : MediaDemoBase(PREFIX) {
    override val tag = "PageVisibilityDemo"
    private var failures = 0

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("page-visibility-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/visibility" to page,
                "/other" to page,
                "/tone.wav" to ("audio/wav" to tone()),
                "/clip.webm" to ("video/webm" to readAssetBytes("media-demo-clip.webm")),
                "/art.png" to ("image/png" to art())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        assertEquals("checks that did not hold (see $PREFIX-notes.txt)", 0, failures)
    }

    /** Two tabs in the space: the probe page in `tab_demo` (active) and the plain page in `tab_other`. */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "$PAGE?kind=video")
                tab.put("title", "Zenium page visibility demo")
            }
        }
        tabs.put(
            JSONObject()
                .put("id", OTHER)
                .put("spaceId", "space_main")
                .put("containerId", "default")
                .put("folderId", JSONObject.NULL)
                .put("url", OTHER_PAGE)
                .put("title", "The other tab")
                .put("pinned", false)
                .put("essential", false)
        )
        val spaces = state.getJSONArray("spaces")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.optString("id") == "space_main") {
                space.put("tabIds", JSONArray().put(TAB).put(OTHER))
                space.put("activeTabId", TAB)
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        notes = File(out, "$PREFIX-notes.txt")
        notes.writeText("Zenium Android page visibility demo ($PREFIX)\n\n")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}; sdk ${Build.VERSION.SDK_INT}; device ${Build.MODEL}")
        shell("cmd uimode night no")
        waitTitle(TAB, 20_000) { it.startsWith("PV|") }
        note("seeded tabs: ${describeTab(TAB)}; ${describeTab(OTHER)}")
        note("active tab: ${activeCoreTab()?.optString("id")}; views: $TAB ${viewState(TAB)}; $OTHER ${viewState(OTHER)}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        switched("timers", "1. timers only (no media), on a tab that has never been audible: the tab switched away and back")
        switched("muted", "2. the clip MUTED, playing: the tab switched away and back")
        switched("video", "3. the same clip with sound, playing: the tab switched away and back")
        switched("audio", "4. an <audio> track, playing: the tab switched away and back")
        homeControl()
        allowedSwitched()
        allowedSilentSwitched()
        allowedStopsBehind()
        overviewCover()
        forgetAllow()
        note("\nend: ${describeTab(TAB)}; active ${activeCoreTab()?.optString("id")}; $TAB ${viewState(TAB)}")
    }

    // --- the switch, one kind at a time -----------------------------------------------------------

    private fun switched(kind: String, heading: String) {
        note("\n$heading")
        onPage(kind)
        val hasMedia = kind != "timers"
        if (hasMedia) play()
        val before = read() ?: run { check("$kind: the page answers before the switch", false); return }
        note("  in front: ${before.line()}; view ${viewState(TAB)}")
        check("$kind: in front the page is visible to itself${if (hasMedia) " and playing" else ""}", before.vis == "visible" && before.vc == 0 && (!hasMedia || before.paused == false))
        if (kind == "video") shot("video-in-front-playing-light-phone")
        val away = switchTo(OTHER)
        check("$kind: tab.activate puts the other tab in front and the probe's view out of the layout (GONE)", away)
        resetGaps()
        SystemClock.sleep(1_000)
        val a = read() ?: run { check("$kind: the page behind answers", false); return }
        SystemClock.sleep(3_000)
        val b = read() ?: run { check("$kind: the page behind answers a second time", false); return }
        note("  behind, +1 s: ${a.line()}; view ${viewState(TAB)}")
        note("  behind, +4 s: ${b.line()}")
        note("  behind, cadence ${rates(a, b)}")
        check("$kind: behind another tab the page reads document.visibilityState \"hidden\" and heard one visibilitychange (read \"${b.vis}\", ${b.vc} event(s): ${b.changes})", b.vis == "hidden" && b.vc == 1)
        check("$kind: the host has the tab behind another (backgroundTab) and the hold forwarded the hide to the engine (not holding)", behind() && !holding())
        when (kind) {
            "video", "muted" -> check("$kind: behind another tab the engine paused the clip, as Chrome's does (paused ${b.paused}, pause events ${b.pauses}, currentTime ${a.t} -> ${b.t} ms)", b.paused == true && b.pauses == 1 && !advancing(a, b))
            "audio" -> check("audio: behind another tab the track keeps playing, as Chrome's does (paused ${b.paused}, currentTime ${a.t} -> ${b.t} ms)", b.paused == false && advancing(a, b))
        }
        check("$kind: behind another tab requestAnimationFrame stops (${"%.1f".format(frameHz(a, b))} frames/s)", frameHz(a, b) < 1.0)
        val cadence = "the 100 ms interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms)"
        when (kind) {
            "timers", "muted" -> fact(kind, "behind another tab $cadence – Chrome's scheduler aligns a hidden page's timers to one-second wake-ups when the page has not been audible for 30 s, and this tab never was")
            else -> fact(kind, "behind another tab $cadence – the page was audible up to the switch, and Chrome keeps a recently audible page un-throttled for 30 s")
        }
        if (kind == "video") shot("other-tab-in-front-light-phone")
        val back = switchTo(TAB)
        check("$kind: tab.activate brings the probe's tab back (VISIBLE)", back)
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("$kind: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}")
        check("$kind: back in front the page reads \"visible\" and heard the second visibilitychange (read \"${c.vis}\", ${c.vc} event(s) in all)", c.vis == "visible" && c.vc == 2 && !behind())
        when (kind) {
            "video", "muted" -> check("$kind: back in front the engine resumed the clip it paused (paused ${c.paused}, play events ${c.plays})", c.paused == false && c.plays == 2)
            "audio" -> check("audio: back in front the track is still playing (paused ${c.paused}, plays ${c.plays})", c.paused == false && c.plays == 1)
        }
        shot(
            when (kind) {
                "audio" -> "audio-returned-heard-hidden-then-visible-kept-playing-light-phone"
                else -> "$kind-returned-heard-hidden-then-visible-light-phone"
            }
        )
        if (hasMedia) pause()
    }

    // --- the control: Home with the clip with sound -----------------------------------------------

    private fun homeControl() {
        note("\n5. the control: the <video> with sound playing, the app to Home and back (MED-08's fact a)")
        onPage("video")
        play()
        val before = read() ?: run { check("home: the page answers", false); return }
        note("  before Home: ${before.line()}")
        home()
        resetGaps()
        SystemClock.sleep(1_000)
        val a = read() ?: run { check("home: the page answers from behind the launcher", false); return }
        SystemClock.sleep(3_000)
        val b = read() ?: run { check("home: the page answers a second time", false); return }
        note("  Home, +1 s: ${a.line()}; view ${viewState(TAB)}; lifecycle ${lifecycleState()}")
        note("  Home, +4 s: ${b.line()}")
        note("  Home, cadence ${rates(a, b)}")
        check("home (MED-08 fact a): behind the launcher the page is hidden to itself, one visibilitychange, the clip paused by the engine", b.vis == "hidden" && b.vc == 1 && b.paused == true && b.pauses == 1)
        check("home: the window's hide is the window's, not a switch's (the tab is not behind another)", !behind())
        check("home: behind the launcher requestAnimationFrame stops (${"%.1f".format(frameHz(a, b))} frames/s)", frameHz(a, b) < 1.0)
        fact("home", "behind the launcher the interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms) – the page was audible up to the hide (Chrome's 30 s recently-audible rule)")
        returnToApp()
        SystemClock.sleep(2_500)
        val c = read() ?: run { check("home: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}; lifecycle ${lifecycleState()}")
        check("home: back from the launcher the page is visible, two changes in all, the clip resumed by the engine", c.vis == "visible" && c.vc == 2 && c.paused == false)
        shot("home-returned-heard-hidden-then-visible-light-phone")
        pause()
    }

    // --- OS-08: the site allowed background video, switched away ------------------------------------

    private fun allowedSwitched() {
        note("\n6. OS-08: the site allowed background-video (permissions.set), the <video> with sound playing, the tab switched away and back")
        onPage("video")
        val set = coreInvoke("permissions.set", allow("allow"))
        note("  permissions.set -> $set")
        play()
        SystemClock.sleep(1_500)
        note("  playing, allowed: view ${viewState(TAB)}")
        check("allowed: the session carries the site's allow to the view (keepsVideoInBackground) before the switch", keeps())
        val away = switchTo(OTHER)
        check("allowed: the switch takes", away)
        resetGaps()
        SystemClock.sleep(1_000)
        val a = read() ?: run { check("allowed: the page behind answers", false); return }
        SystemClock.sleep(3_000)
        val b = read() ?: run { check("allowed: the page behind answers a second time", false); return }
        note("  behind, +1 s: ${a.line()}; view ${viewState(TAB)}")
        note("  behind, +4 s: ${b.line()}; cadence ${rates(a, b)}")
        check("allowed: the site allowed and playing, behind another tab the switch's hide is held from the engine as Home's is (behind, holding)", behind() && holding())
        check("allowed: the page stays visible to itself and hears nothing (read \"${b.vis}\", ${b.vc} change(s))", b.vis == "visible" && b.vc == 0)
        check("allowed: the clip plays on behind the other tab (paused ${b.paused}, currentTime ${a.t} -> ${b.t} ms)", b.paused == false && advancing(a, b))
        val back = switchTo(TAB)
        check("allowed: the return takes", back)
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("allowed: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}")
        check("allowed: back in front the page heard nothing of the switch and the clip is playing (read \"${c.vis}\", ${c.vc} change(s), paused ${c.paused})", c.vis == "visible" && c.vc == 0 && c.paused == false && !holding() && !behind())
        shot("allowed-site-returned-heard-nothing-kept-playing-light-phone")
        pause()
        // The site's allow is forgotten, so the tab stands as the others do from here.
        forgetAllow()
    }

    // --- OS-08 refined (the lead's ruling 1): the allow holds only while the video plays ------------

    /** The site allowed, nothing playing: hidden behind another tab like any other site. */
    private fun allowedSilentSwitched() {
        note("\n7. OS-08, ruling 1: the site allowed background-video but SILENT (the clip loaded, not playing), the tab switched away and back")
        onPage("video")
        val set = coreInvoke("permissions.set", allow("allow"))
        note("  permissions.set -> $set")
        SystemClock.sleep(800)
        note("  silent, allowed: view ${viewState(TAB)}")
        check("allowed-silent: nothing plays, so the session keeps nothing for the view (keepsVideoInBackground false)", !keeps())
        val away = switchTo(OTHER)
        check("allowed-silent: the switch takes", away)
        resetGaps()
        SystemClock.sleep(1_000)
        val a = read() ?: run { check("allowed-silent: the page behind answers", false); return }
        SystemClock.sleep(3_000)
        val b = read() ?: run { check("allowed-silent: the page behind answers a second time", false); return }
        note("  behind, +1 s: ${a.line()}; view ${viewState(TAB)}")
        note("  behind, +4 s: ${b.line()}; cadence ${rates(a, b)}")
        check("allowed-silent: a silent allowed site is hidden behind another tab like any other (read \"${b.vis}\", ${b.vc} change(s); behind, nothing held)", b.vis == "hidden" && b.vc == 1 && behind() && !holding())
        check("allowed-silent: behind another tab requestAnimationFrame stops (${"%.1f".format(frameHz(a, b))} frames/s)", frameHz(a, b) < 1.0)
        fact("allowed-silent", "behind another tab the 100 ms interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms) – the throttling the engine allows a hidden page; this tab was audible in scene 6 moments before (Chrome's 30 s recently-audible memory outlives the navigation)")
        val back = switchTo(TAB)
        check("allowed-silent: the return takes", back)
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("allowed-silent: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}")
        check("allowed-silent: back in front the page reads \"visible\" with the second change (read \"${c.vis}\", ${c.vc} change(s) in all)", c.vis == "visible" && c.vc == 2 && !behind())
    }

    /** The allowed site playing behind another tab, then its sound stops there: hidden then; a `play()` while hidden un-hides nothing. */
    private fun allowedStopsBehind() {
        note("\n8. OS-08, ruling 1: the allowed site playing, switched away (the hide held), then the clip PAUSED by the page while behind – the page is hidden then; a play() while hidden un-hides nothing")
        onPage("video")
        coreInvoke("permissions.set", allow("allow"))
        play()
        SystemClock.sleep(1_500)
        check("allowed-stop: the session keeps the video for the view before the switch", keeps())
        val away = switchTo(OTHER)
        check("allowed-stop: the switch takes", away)
        SystemClock.sleep(1_500)
        val a = read() ?: run { check("allowed-stop: the page behind answers", false); return }
        note("  behind, playing: ${a.line()}; view ${viewState(TAB)}")
        check("allowed-stop: playing behind the other tab, the switch's hide is held (visible to itself, no change, holding)", a.vis == "visible" && a.vc == 0 && behind() && holding())
        // The sound stops while the tab is behind: the page's own pause (the notification's or the
        // clip's end is the same word to the session).
        val paused = pageJs("(function(){var m=document.getElementById('media');m.pause();return 'ok'})()")
        val released = poll(10_000) { !holding() && !keeps() }
        SystemClock.sleep(1_500)
        val b = read() ?: run { check("allowed-stop: the page behind answers after the pause", false); return }
        note("  behind, paused by the page: pause -> $paused; released=$released; ${b.line()}; view ${viewState(TAB)}")
        check("allowed-stop: the sound stopping while behind lets the held hide through – the session's word turns, the hold releases, the page reads \"hidden\" and heard one change (read \"${b.vis}\", ${b.vc} change(s))", released && b.vis == "hidden" && b.vc == 1 && b.paused == true)
        // The page starts the clip again while hidden: the page stays hidden whatever the engine does with the playback.
        val played = pageJs("(function(){var m=document.getElementById('media');var p=m.play();if(p&&p.catch)p.catch(function(){});return 'ok'})()")
        SystemClock.sleep(2_500)
        val c = read() ?: run { check("allowed-stop: the page behind answers after the play()", false); return }
        note("  behind, play() while hidden: -> $played; ${c.line()}; view ${viewState(TAB)}")
        check("allowed-stop: a play() while hidden un-hides nothing (read \"${c.vis}\", ${c.vc} change(s); behind, nothing held)", c.vis == "hidden" && c.vc == 1 && behind() && !holding())
        fact("allowed-stop", "after the play() while hidden the engine has the clip ${if (c.paused == true) "PAUSED" else "PLAYING"} (play events ${c.plays}, pause events ${c.pauses}, currentTime ${b.t} -> ${c.t} ms; the session keeps=${keeps()})")
        val back = switchTo(TAB)
        check("allowed-stop: the return takes", back)
        SystemClock.sleep(2_000)
        val d = read() ?: run { check("allowed-stop: the page answers after the return", false); return }
        note("  back: ${d.line()}; view ${viewState(TAB)}")
        check("allowed-stop: back in front the page reads \"visible\" with the second change (read \"${d.vis}\", ${d.vc} change(s) in all)", d.vis == "visible" && d.vc == 2 && !behind() && !holding())
        fact("allowed-stop", "back in front the clip is ${if (d.paused == true) "PAUSED" else "PLAYING"} (play events ${d.plays}, pause events ${d.pauses}, currentTime ${c.t} -> ${d.t} ms)")
        pause()
        forgetAllow()
    }

    // --- the tab overview over the page: what the page reads under that cover today -----------------

    /**
     * The overview opened over the playing page by a real touch on the bar's Tabs button and closed
     * by back; once with the site allowed `background-video` and playing. FACT lines, not checks:
     * the lead's ruling 2 (the overview counts as switching away, as Chrome's Hub does) waits on a
     * word from the core the host does not have today – every cover of the chrome hides the view
     * the same way – so this scene records what the page reads under the cover now.
     */
    private fun overviewCover() {
        note("\n9. the tab overview opened over the page (a real touch on the bar's Tabs button) and closed again by back – FACT lines of what the page reads under that cover today; then the same with the site allowed background-video")
        onPage("video")
        play()
        val before = read() ?: run { check("overview: the page answers before the cover", false); return }
        note("  in front: ${before.line()}")
        if (!openOverview("overview")) { pause(); return }
        resetGaps()
        SystemClock.sleep(1_000)
        val a = read() ?: run { check("overview: the page answers under the cover", false); closeOverview("overview"); return }
        SystemClock.sleep(3_000)
        val b = read() ?: run { check("overview: the page answers under the cover a second time", false); closeOverview("overview"); return }
        note("  under the overview, +1 s: ${a.line()}; view ${viewState(TAB)}; $OTHER ${viewState(OTHER)}")
        note("  under the overview, +4 s: ${b.line()}; cadence ${rates(a, b)}")
        fact("overview", "under the overview the page reads \"${b.vis}\" with ${b.vc} change(s); the clip ${if (b.paused == true) "PAUSED" else "PLAYING"} (currentTime ${a.t} -> ${b.t} ms); the host has the tab ${if (behind()) "BEHIND another tab" else "under a cover, not behind"} (holding=${holding()})")
        fact("overview", "under the overview the 100 ms interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms), requestAnimationFrame at ${"%.1f".format(frameHz(a, b))} frames/s")
        closeOverview("overview")
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("overview: the page answers after the cover", false); return }
        note("  closed: ${c.line()}; view ${viewState(TAB)}")
        fact("overview", "after the overview closed the page reads \"${c.vis}\" with ${c.vc} change(s) in all; the clip ${if (c.paused == true) "PAUSED" else "PLAYING"} (play events ${c.plays}, pause events ${c.pauses})")
        // The allowed site, playing, under the overview.
        coreInvoke("permissions.set", allow("allow"))
        play()
        SystemClock.sleep(1_500)
        check("overview-allowed: the session keeps the video for the view before the cover", keeps())
        if (!openOverview("overview-allowed")) { pause(); forgetAllow(); return }
        SystemClock.sleep(1_000)
        val d = read() ?: run { check("overview-allowed: the page answers under the cover", false); closeOverview("overview-allowed"); forgetAllow(); return }
        SystemClock.sleep(3_000)
        val e = read() ?: run { check("overview-allowed: the page answers under the cover a second time", false); closeOverview("overview-allowed"); forgetAllow(); return }
        note("  allowed, under the overview, +4 s: ${e.line()}; view ${viewState(TAB)}")
        fact("overview-allowed", "the allowed site playing under the overview reads \"${e.vis}\" with ${e.vc} change(s); the clip ${if (e.paused == true) "PAUSED" else "PLAYING"} (currentTime ${d.t} -> ${e.t} ms); behind=${behind()} holding=${holding()} keeps=${keeps()}")
        closeOverview("overview-allowed")
        SystemClock.sleep(1_500)
        val f = read()
        note("  allowed, closed: ${f?.line() ?: "no answer"}; view ${viewState(TAB)}")
        pause()
        forgetAllow()
    }

    /** The overview up: the chrome's `.zen-overview` at its resting scale. */
    private fun overviewUp(): Boolean =
        chromeJsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    /** A real touch on the bar's Tabs button (the count trails its label), asserted: the overview is up. */
    private fun openOverview(scene: String): Boolean {
        val close = closeUrlField()
        if (!close.ok) note("  (${close.describe()})")
        val opened = touchTapLabelExpecting("Tabs (", "the overview is up", prefix = true, timeoutMs = 8_000) { overviewUp() }
        check("$scene: a real touch on the bar's Tabs button opens the overview", opened)
        return opened
    }

    /** Back leaves the overview; the page's view is on screen again. */
    private fun closeOverview(scene: String) {
        back()
        val closed = poll(8_000) { !overviewUp() && viewVisibility(TAB) == View.VISIBLE }
        check("$scene: back closes the overview and the page's view is on screen again", closed)
    }

    private fun allow(decision: String?): String =
        """{"origin":${JSONObject.quote(ORIGIN)},"permission":"background-video","decision":${if (decision == null) "null" else JSONObject.quote(decision)}}"""

    private fun forgetAllow() {
        coreInvoke("permissions.set", allow(null))
    }

    // --- helpers ------------------------------------------------------------------------------------

    private class Reading(json: JSONObject) {
        val now = json.optLong("now")
        val vis: String = json.optString("vis", "?")
        val vc = json.optInt("vc", -1)
        val changes: String = json.optJSONArray("changes")?.toString() ?: "[]"
        val ticks = json.optLong("ticks")
        val frames = json.optLong("frames")
        val maxTickGap = json.optInt("maxTickGap")
        val maxFrameGap = json.optInt("maxFrameGap")
        val paused: Boolean? = if (json.isNull("paused")) null else json.optBoolean("paused")
        val t = json.optLong("t", -1)
        val pauses = json.optInt("pauses", -1)
        val plays = json.optInt("plays", -1)

        fun line(): String =
            "vis $vis vc $vc" + (if (paused != null) " ${if (paused) "paused" else "playing"} t ${t}ms pauses $pauses plays $plays" else "") +
                " ticks $ticks frames $frames now ${now}ms"
    }

    private fun read(tabId: String = TAB): Reading? {
        val raw = pageJs("(window.__pv?__pv():null)", tabId)
        if (raw.isEmpty() || raw == "null") return null
        return runCatching { Reading(JSONObject(raw)) }.getOrNull()
    }

    private fun resetGaps() {
        pageJs("(window.__pvResetGaps?__pvResetGaps():null)")
    }

    private fun seconds(a: Reading, b: Reading): Double = ((b.now - a.now).coerceAtLeast(1)) / 1000.0
    private fun tickHz(a: Reading, b: Reading): Double = (b.ticks - a.ticks) / seconds(a, b)
    private fun frameHz(a: Reading, b: Reading): Double = (b.frames - a.frames) / seconds(a, b)
    private fun advancing(a: Reading, b: Reading): Boolean = b.t > a.t || (b.t < a.t && b.paused == false)

    private fun rates(a: Reading, b: Reading): String =
        "over %.1f s: interval %.1f ticks/s (max gap %d ms), rAF %.1f frames/s (max gap %d ms)".format(
            seconds(a, b), tickHz(a, b), b.maxTickGap, frameHz(a, b), b.maxFrameGap
        )

    /** The tab's view as the host holds it: its own visibility, the window's word, the hold. */
    private fun viewState(tabId: String): String {
        var s = "no view"
        instrumentation.runOnMainSync {
            val v = host.tabs.get(tabId) ?: return@runOnMainSync
            s = "visibility=${name(v.visibility)} windowVisibility=${name(v.windowVisibility)} shown=${v.isShown} attached=${v.isAttachedToWindow} behind=${v.backgroundTab} keeps=${v.keepsVideoInBackground} holding=${v.holdingWindowHide}"
        }
        return s
    }

    private fun name(visibility: Int): String = when (visibility) {
        View.VISIBLE -> "VISIBLE"
        View.INVISIBLE -> "INVISIBLE"
        View.GONE -> "GONE"
        else -> visibility.toString()
    }

    private fun viewVisibility(tabId: String): Int {
        var v = -1
        instrumentation.runOnMainSync { v = host.tabs.get(tabId)?.visibility ?: -1 }
        return v
    }

    /** The core's `tab.activate`; true once the core calls `tabId` active and the views follow (the other's GONE, this one's VISIBLE). */
    private fun switchTo(tabId: String): Boolean {
        val other = if (tabId == TAB) OTHER else TAB
        coreInvoke("tab.activate", """{"tabId":${JSONObject.quote(tabId)}}""")
        val took = poll(10_000) {
            activeCoreTab()?.optString("id") == tabId && viewVisibility(tabId) == View.VISIBLE && viewVisibility(other) == View.GONE
        }
        note("  tab.activate $tabId: took=$took; active ${activeCoreTab()?.optString("id")}; $TAB ${viewState(TAB)}; $OTHER ${viewState(OTHER)}")
        return took
    }

    /** The demo tab on the probe page of `kind`, its media (if any) loaded; the title's fields fresh. */
    private fun onPage(kind: String) {
        frontApp()
        if (activeCoreTab()?.optString("id") != TAB) switchTo(TAB)
        val url = "$PAGE?kind=$kind&n=${SystemClock.uptimeMillis()}"
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(url)}}""")
        waitTitle(TAB, 20_000) { it.startsWith("PV|kind:$kind") && "vc:0" in it }
        if (kind != "timers") poll(10_000) { pageJs("(document.getElementById('media')||{}).readyState") == "4" }
        SystemClock.sleep(800)
        note("  on the $kind page: ${title()}")
    }

    private fun play() {
        if (field("state") == "playing") return
        tapPageButton("play", "Play", "the media plays", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_500)
    }

    private fun pause() {
        if (field("state") != "playing") return
        frontApp()
        tapPageButton("play", "Pause", "the media pauses", 10_000) { field("state") == "paused" }
    }

    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val left = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() != app.packageName && lifecycleState() == "CREATED" }
        note("  Home: left=$left; in front: ${ui.rootInActiveWindow?.packageName}; lifecycle ${lifecycleState()}")
    }

    private fun returnToApp() {
        bringToFront()
        frontApp()
    }

    private fun keeps(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = host.tabs.get(TAB)?.keepsVideoInBackground == true }
        return v
    }

    /** The tab host has the demo tab behind another tab on screen ([TabWebView.backgroundTab]). */
    private fun behind(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = host.tabs.get(TAB)?.backgroundTab == true }
        return v
    }

    /** A hide – the window's or a switch's – is held from the engine for the demo tab's video. */
    private fun holding(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = host.tabs.get(TAB)?.holdingWindowHide == true }
        return v
    }

    private fun lifecycleState(): String {
        var state = "?"
        instrumentation.runOnMainSync { state = (activity as? LifecycleOwner)?.lifecycle?.currentState?.name ?: "no lifecycle owner" }
        return state
    }

    private fun fact(scene: String, what: String) = note("  FACT  $scene: $what")

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    companion object {
        private const val PREFIX = "android-w6-s26-page-visibility"
        private const val OTHER = "tab_other"
        private const val PAGE = "http://127.0.0.1:$PORT/visibility"
        private const val OTHER_PAGE = "http://127.0.0.1:$PORT/other?kind=other"
        private val ORIGIN = URL(PAGE).let { "${it.protocol}://${it.host}:${it.port}" }
    }
}
