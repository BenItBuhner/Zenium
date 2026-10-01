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
 * with the app in front – against what the same page hears when the whole app goes to Home (the
 * control; MED-08's fact a).
 *
 * The loopback `/visibility` page comes in kinds (`?kind=`): a `<video>` with sound, the same clip
 * muted, an `<audio>` track, and timers only; every kind runs a 100 ms interval and a
 * requestAnimationFrame loop and counts the `visibilitychange` events it hears. The second tab,
 * `/other`, is a plain page. For every kind: the page in front (playing, where there is media),
 * the switch to the other tab through the core's `tab.activate` – the relayout path every switch
 * takes – two reads three seconds apart while it sits behind (`document.visibilityState`, the
 * events heard, `paused` and `currentTime`, the interval's and the frame loop's cadence), then
 * the switch back and one more read. Then the control, Home with the clip with sound; then the
 * OS-08 case, the site allowed `background-video`, playing, switched away.
 *
 * What the page saw goes to the notes as `FACT` lines; a `check` that did not hold fails the run
 * at its end. Every touch injected has an assertion on what it did (the rule in [DemoHarness]).
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
        switched("video", "1. a <video> with sound, playing: the tab switched away and back")
        switched("muted", "2. the same clip MUTED, playing: the tab switched away and back")
        switched("audio", "3. an <audio> track, playing: the tab switched away and back")
        switched("timers", "4. timers only (no media): the tab switched away and back")
        homeControl()
        allowedSwitched()
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
        if (kind == "video") shot("video-foreground-light-phone")
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
        fact(kind, "behind another tab the page reads document.visibilityState \"${b.vis}\" and heard ${b.vc} visibilitychange event(s) (${b.changes})")
        if (hasMedia) fact(kind, "behind another tab the ${if (kind == "audio") "track" else "clip"} is ${if (b.paused == true) "PAUSED" else "PLAYING"}: currentTime ${a.t} -> ${b.t} ms (${if (advancing(a, b)) "advancing" else "still"}), pause events ${b.pauses}, play events ${b.plays}")
        fact(kind, "behind another tab the 100 ms interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms) and requestAnimationFrame at ${"%.1f".format(frameHz(a, b))}/s (max gap ${b.maxFrameGap} ms)")
        if (kind == "video") shot("other-tab-in-front-light-phone")
        val back = switchTo(TAB)
        check("$kind: tab.activate brings the probe's tab back (VISIBLE)", back)
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("$kind: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}")
        fact(kind, "back in front the page reads \"${c.vis}\", ${c.vc} visibilitychange event(s) in all${if (hasMedia) "; the media is ${if (c.paused == true) "paused" else "playing"} (pauses ${c.pauses}, plays ${c.plays})" else ""}")
        shot("$kind-returned-light-phone")
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
        fact("home", "behind the launcher the interval ran at ${"%.1f".format(tickHz(a, b))}/s (max gap ${b.maxTickGap} ms), rAF at ${"%.1f".format(frameHz(a, b))}/s")
        returnToApp()
        SystemClock.sleep(2_500)
        val c = read() ?: run { check("home: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}; lifecycle ${lifecycleState()}")
        check("home: back from the launcher the page is visible, two changes in all, the clip resumed by the engine", c.vis == "visible" && c.vc == 2 && c.paused == false)
        shot("home-returned-light-phone")
        pause()
    }

    // --- OS-08: the site allowed background video, switched away ------------------------------------

    private fun allowedSwitched() {
        note("\n6. OS-08: the site allowed background-video (permissions.set), the <video> with sound playing, the tab switched away and back")
        onPage("video")
        val set = coreInvoke("permissions.set", """{"origin":${JSONObject.quote(ORIGIN)},"permission":"background-video","decision":"allow"}""")
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
        fact("allowed", "the site allowed and playing, behind another tab the page reads \"${b.vis}\" (${b.vc} change(s)) and the clip is ${if (b.paused == true) "PAUSED" else "PLAYING"} (currentTime ${a.t} -> ${b.t} ms)")
        val back = switchTo(TAB)
        check("allowed: the return takes", back)
        SystemClock.sleep(2_000)
        val c = read() ?: run { check("allowed: the page answers after the return", false); return }
        note("  back: ${c.line()}; view ${viewState(TAB)}")
        fact("allowed", "back in front: \"${c.vis}\", ${c.vc} change(s), the clip ${if (c.paused == true) "paused" else "playing"}")
        shot("allowed-returned-light-phone")
        pause()
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
            s = "visibility=${name(v.visibility)} windowVisibility=${name(v.windowVisibility)} shown=${v.isShown} attached=${v.isAttachedToWindow} keeps=${v.keepsVideoInBackground} holding=${v.holdingWindowHide}"
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
