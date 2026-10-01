package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.Window
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Collections
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Profiles waking a SLEEPING tab from the phone's overview and asserts that the switch and the
 * swipe back out stay smooth while the page loads – the complaint, in the user's words: "Waking a
 * sleeping or inactive tab is laggy. Tapping it lags and delays before it loads. While it loads,
 * swiping back out also lags, and the jank continues until the page has mostly loaded."
 *
 * A sleeping tab is one the core unloaded (`tab.unload` → `tabs.discard`: its `TabWebView`
 * destroyed, its navigation and picture kept). Tapping its card in the overview recreates the
 * WebView, restores its history and loads the page while the overview's close morph runs –
 * everything on the one UI thread the chrome's frames need, and the page's Blink work on the one
 * renderer main thread the chrome's React animation runs on.
 *
 * The pages come from this process ([DemoServer], loopback, repeatable): the perf state's six
 * tabs and one HEAVY page made here – thirty-six images each served after a delay and a script
 * that builds a long document in chunks – so a load lasts seconds, long enough to swipe out of.
 *
 * The scenes, each the same real-touch gesture on the heavy tab WARM (its page loaded and kept:
 * the control) and ASLEEP (unloaded through the core's own path right before):
 *
 *  - `wake-tap-<state>`: a tap on the tab's card in the open overview; the frames from the tap
 *    through the close morph (the first [SWITCH_WINDOW_MS]) and, for the sleeping tab, on until
 *    the page's load (`progress` 100), with the time to its first paint and to its load;
 *  - `wake-pull-out-<state>`: the tap, [OUT_AFTER_MS] later a pull on the pill back to the
 *    overview (the bar's swipe-to-overview, the way out of a tab on the phone) while the page is
 *    still loading, and the spring's settle;
 *  - `wake-back-out-<state>`: the tap, then the system's predictive back gesture from the left
 *    edge while the page loads (gesture navigation is turned on for the run), and its settle –
 *    the other swipe that leaves what is on screen.
 *
 * THREE INSTRUMENTS, one asserted. (1) `Window.addOnFrameMetricsAvailableListener` on the
 * activity's window ([FrameWatch]): every frame of the app's window with its stages (the delay
 * before the frame began, input, animation, measure/layout, draw, sync, the render thread's
 * command issue, the swap) and its vsync time, cut to each scene's window – the numbers of the
 * complaint (p50/p95/p99, frames over one and over two vsyncs, the longest). (2) The harness's
 * [traceFrames] around each scene: `dumpsys gfxinfo framestats` as the second witness of the
 * same frames (`framestats-<scene>.txt`, `frames.jsonl`) and the WebViews' Chromium trace
 * (`trace-<scene>.json.gz`) read into the renderer main thread's work per frame. (3) A Perfetto
 * trace of the device across the measured sequence when the workflow pushed the config
 * (`DEMO_PERFETTO_CONFIG`, [PerfCapture]), each scene marked (`zenperf <scene>`) and written to
 * `scenes.txt` in the trace's clock, for `android-perf-trace.py` to cut.
 *
 * THE BAR ([WakeFrames]): p95 at or under one vsync and no frame over two, during the switch and
 * the swipe-out windows. On the recipe's software GPU every whole frame is 100 ms and more for
 * the warm control too, so the bar there is read on the UI thread's part of the frame (the delay
 * plus input, animation, layout and draw – what a main-thread stall moves) and RELATIVE to the
 * warm control of the same run ([WakeFrames.bar] says which applied). Every claim is a `PASS` /
 * `FAIL` line with its numbers in `tab-wake-findings.txt`; under `-e assert true` (the
 * `WAKE_ASSERT` environment) a failed claim fails the run once the record is written.
 */
@RunWith(AndroidJUnit4::class)
class TabWakePerfDemo : DemoHarness("perf-motion-demo-state.json", "tab-wake", "tab-wake-perf") {
    override val tag = "TabWakePerfDemo"

    private lateinit var server: DemoServer
    private lateinit var capture: PerfCapture
    private lateinit var frames: FrameWatch
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val scenes = JSONArray()
    private val sceneWindows = StringBuilder()
    private val verdicts = ArrayList<WakeFrames.Verdict>()
    private val summaries = LinkedHashMap<String, WakeFrames.Summary>()
    private var perfettoOn = false
    private var heavyTab = ""
    private var gestural = false
    private var navigationChanged = false
    private var backAnimationBefore = ""
    private val assertBar = InstrumentationRegistry.getArguments().getString("assert") == "true"

    @Test
    fun record() {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        routes["/"] = "text/html; charset=utf-8" to readAsset("bar-hide-demo-page.html").toByteArray()
        routes["/github"] = "text/html; charset=utf-8" to pageFixture("github-repo")
        routes["/article"] = "text/html; charset=utf-8" to pageFixture("article")
        routes[HEAVY_PATH] = "text/html; charset=utf-8" to heavyPage().toByteArray()
        val delays = HashMap<String, Long>()
        for (i in 0 until HEAVY_IMAGES) {
            routes["/img/$i.png"] = "image/png" to image(i)
            delays["/img/$i.png"] = IMAGE_DELAY_MS
        }
        server = DemoServer(PORT, routes, delays = delays).also { it.start() }
        capture = PerfCapture(ui, app.packageName, tag)
        try {
            runPerfDemo() // a perf reading: no events hold (the rule at DemoHarness.runDemo)
        } finally {
            finishCaptures()
            server.close()
            restoreNavigation()
            writeRecord()
        }
        if (assertBar) {
            val failed = verdicts.filter { !it.pass }
            if (failed.isNotEmpty()) throw AssertionError("${failed.size} wake claim(s) failed:\n" + failed.joinToString("\n") { it.line() })
        }
    }

    private fun writeRecord() {
        File(out, "tab-wake-perf.json").writeText(
            JSONObject().put("package", app.packageName)
                .put("webview", capture.webViewVersion())
                .put("window", JSONObject().put("width", width).put("height", height).put("density", density.toDouble()))
                .put("heavyTab", heavyTab)
                .put("gestural", gestural)
                .put("scenes", scenes)
                .put("verdicts", JSONArray().apply { verdicts.forEach { put(JSONObject().put("scene", it.scene).put("pass", it.pass).put("reasons", JSONArray(it.reasons))) } })
                .toString(2)
        )
        File(out, "scenes.txt").writeText(sceneWindows.toString())
        val table = WakeFrames.table(summaries.entries.map { it.key to it.value })
        findings.append("\n").append(table)
        for (v in verdicts) findings.append(v.line()).append('\n')
        File(out, "tab-wake-findings.txt").writeText(findings.toString())
        Log.i(tag, "findings:\n$findings")
    }

    override fun beforeLaunch() {
        // The back-out scenes are the system's back gesture: gesture navigation and its animation
        // before the app starts (the recipe sets three-button navigation; the window's insets –
        // the pill's place – change with the mode, so this comes before the harness measures).
        backAnimationBefore = shellCommand("settings get global enable_back_animation").trim()
        shellCommand("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shellCommand("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        shellCommand("settings put global enable_back_animation 1")
        SystemClock.sleep(3_000)
        gestural = shellCommand("cmd overlay list").lines().any { it.contains("[x] com.android.internal.systemui.navbar.gestural") }
        navigationChanged = true
        Log.i(tag, "navigation: ${if (gestural) "gestural" else "NOT gestural (the back-out scenes are skipped)"}")
    }

    private fun restoreNavigation() {
        if (!navigationChanged) return
        shellCommand("cmd overlay disable com.android.internal.systemui.navbar.gestural")
        shellCommand("cmd overlay enable com.android.internal.systemui.navbar.threebutton")
        if (backAnimationBefore.isEmpty() || backAnimationBefore == "null") {
            shellCommand("settings delete global enable_back_animation")
        } else {
            shellCommand("settings put global enable_back_animation $backAnimationBefore")
        }
    }

    // --- warm-up: the pages, the pictures, then the measured scenes ---------------------------------

    override fun warmUp() {
        ensureForeground()
        finding("Zenium Android tab wake profile (${width}x$height, density $density; ${capture.webViewVersion()}; navigation ${if (gestural) "gestural" else "three-button"})")
        finding("demo server: ${server.selfCheck()}")
        frames = FrameWatch(activity.window)
        // The heavy page as a tab of its own, loaded once (so it has a picture and a history), and
        // a second entry in its history so the system's back has a page to go back to.
        heavyTab = coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN$HEAVY_PATH?first")},\"active\":true}").trim('"')
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
        SystemClock.sleep(1_000)
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(heavyTab)},\"input\":${JSONObject.quote("$ORIGIN$HEAVY_PATH")}}")
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
        touchWithoutGesture()
        settle()
        // The start tab visited too (its card has a picture), then back to it: the heavy tab is
        // hidden, its picture captured on the hide.
        activate(START_TAB)
        settle()
        finding("heavy tab $heavyTab: ${tabLine(heavyTab)}")
        // Pay for the touch pipeline off the record: the overview opened and picked closed once.
        if (openOverview()) {
            pickCard(START_TAB)
            awaitOverview(open = false)
            SystemClock.sleep(CLOSE_REST_MS)
        }
        perfettoOn = capture.perfettoAvailable() && capture.perfettoStart(PERFETTO_KEY, PERFETTO_FILE)
        finding("perfetto ${if (perfettoOn) "tracing to $PERFETTO_FILE" else "off (no config pushed)"}")
        SystemClock.sleep(1_000)

        for (pass in 1..PASSES) {
            val suffix = if (PASSES > 1) "-$pass" else ""
            // The warm control first: the heavy tab loaded and kept.
            wakeTap("warm$suffix", sleeping = false)
            wakeOut("warm$suffix", sleeping = false, back = false)
            if (gestural) wakeOut("warm$suffix", sleeping = false, back = true)
            // Then asleep, through the core's own path, before each scene.
            wakeTap("sleeping$suffix", sleeping = true)
            wakeOut("sleeping$suffix", sleeping = true, back = false)
            if (gestural) wakeOut("sleeping$suffix", sleeping = true, back = true)
        }
        finishCaptures()
        judge()
    }

    /** The recorded media: one sleeping wake, tapped and pulled back out while it loads. */
    override fun demo() {
        activate(START_TAB)
        settle()
        putToSleep()
        if (!openOverview()) return
        shot("overview-sleeping")
        val card = cardRect(heavyTab) ?: return
        Finger().tap(card.exactCenterX(), card.exactCenterY())
        SystemClock.sleep(OUT_AFTER_MS)
        shot("woken-loading")
        pullOut()
        SystemClock.sleep(CLOSE_SETTLE_MS)
        shot("pulled-out")
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
        pickCard(heavyTab)
        awaitOverview(open = false)
        SystemClock.sleep(CLOSE_REST_MS)
        shot("woken-loaded")
    }

    // --- the scenes ----------------------------------------------------------------------------------

    /**
     * The tap on the heavy tab's card in the open overview, the frames from the tap through the
     * close morph and (asleep) on to the page's load. Two windows are summarised: `switch`, the
     * first [SWITCH_WINDOW_MS] after the tap (the morph), and `load`, the tap to the load event.
     */
    private fun wakeTap(state: String, sleeping: Boolean) {
        val name = "wake-tap-$state"
        activate(START_TAB)
        settle()
        if (sleeping) putToSleep()
        if (!openOverview()) {
            finding("[$name] the overview did not open; skipped")
            return
        }
        val card = cardRect(heavyTab)
        if (card == null) {
            finding("[$name] no card for $heavyTab in the grid; skipped")
            backOverOverview()
            return
        }
        var tapNs = 0L
        var paintedNs = 0L
        var loadedNs = 0L
        var startBoot = 0L
        var endBoot = 0L
        frames.start()
        val result = traceFrames(name, JankBudget.Kind.SPRING) {
            SystemClock.sleep(400)
            val cookie = capture.sceneBegin(name)
            startBoot = capture.nowBoot()
            tapNs = System.nanoTime()
            Finger().tap(card.exactCenterX(), card.exactCenterY())
            val outcome = awaitLoad(heavyTab, if (sleeping) LOAD_TIMEOUT_MS else SWITCH_WINDOW_MS + 500)
            paintedNs = outcome.first
            loadedNs = outcome.second
            if (!sleeping) SystemClock.sleep(CLOSE_SETTLE_MS - SWITCH_WINDOW_MS - 500)
            SystemClock.sleep(300)
            endBoot = capture.nowBoot()
            capture.sceneEnd(name, cookie)
        }
        val all = frames.stop()
        sceneWindows.append("$name $startBoot $endBoot\n")
        val switchWindow = WakeFrames.window(all, tapNs, tapNs + SWITCH_WINDOW_MS * 1_000_000)
        val loadEnd = if (loadedNs > 0) loadedNs else tapNs + LOAD_TIMEOUT_MS * 1_000_000
        val loadWindow = WakeFrames.window(all, tapNs, loadEnd)
        val json = sceneJson(name, result, all)
            .put("tapNs", tapNs).put("paintedNs", paintedNs).put("loadedNs", loadedNs)
            .put("toFirstPaintMs", if (paintedNs > 0) (paintedNs - tapNs) / 1e6 else -1.0)
            .put("toLoadMs", if (loadedNs > 0) (loadedNs - tapNs) / 1e6 else -1.0)
            .put("switch", windowJson(switchWindow))
            .put("load", windowJson(loadWindow))
        scenes.put(json)
        summaries["$name/switch ui"] = WakeFrames.summarize(switchWindow.map { it.uiMs })
        summaries["$name/switch total"] = WakeFrames.summarize(switchWindow.map { it.totalMs })
        if (sleeping) {
            summaries["$name/load ui"] = WakeFrames.summarize(loadWindow.map { it.uiMs })
            summaries["$name/load total"] = WakeFrames.summarize(loadWindow.map { it.totalMs })
        }
        finding(
            "[$name] tapped at $card; first paint ${ms(paintedNs - tapNs, paintedNs > 0)}, load ${ms(loadedNs - tapNs, loadedNs > 0)}; " +
                "${all.size} frames recorded; switch (${SWITCH_WINDOW_MS} ms): ui ${summaries["$name/switch ui"]?.line()}; " +
                "total ${summaries["$name/switch total"]?.line()}; dominant ${WakeFrames.dominantStage(switchWindow) ?: "none"}; " +
                "${describeLong(switchWindow)}; ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}"
        )
        if (sleeping) {
            finding("[$name] load window: ui ${summaries["$name/load ui"]?.line()}; total ${summaries["$name/load total"]?.line()}; ${describeLong(loadWindow)}")
        }
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
        SystemClock.sleep(CLOSE_REST_MS)
        finding("[$name] after: ${tabLine(heavyTab)}; active ${activeTabId()}")
    }

    /**
     * The tap, then [OUT_AFTER_MS] later the way out while the page still loads: the pull on the
     * pill back to the overview (`back = false`) or the system's back gesture from the left edge
     * (`back = true`). The window is the gesture's: from the finger's touch to its settle.
     */
    private fun wakeOut(state: String, sleeping: Boolean, back: Boolean) {
        val name = "wake-${if (back) "back" else "pull"}-out-$state"
        activate(START_TAB)
        settle()
        if (sleeping) putToSleep()
        if (!openOverview()) {
            finding("[$name] the overview did not open; skipped")
            return
        }
        val card = cardRect(heavyTab)
        if (card == null) {
            finding("[$name] no card for $heavyTab in the grid; skipped")
            backOverOverview()
            return
        }
        var outNs = 0L
        var startBoot = 0L
        var endBoot = 0L
        var loadingAtOut = false
        frames.start()
        val result = traceFrames(name, JankBudget.Kind.GESTURE) {
            SystemClock.sleep(400)
            val cookie = capture.sceneBegin(name)
            startBoot = capture.nowBoot()
            Finger().tap(card.exactCenterX(), card.exactCenterY())
            SystemClock.sleep(OUT_AFTER_MS)
            loadingAtOut = !loaded(heavyTab)
            outNs = System.nanoTime()
            if (back) backOut() else pullOut()
            SystemClock.sleep(CLOSE_SETTLE_MS)
            endBoot = capture.nowBoot()
            capture.sceneEnd(name, cookie)
        }
        val all = frames.stop()
        sceneWindows.append("$name $startBoot $endBoot\n")
        val outWindow = WakeFrames.window(all, outNs, outNs + OUT_WINDOW_MS * 1_000_000)
        val json = sceneJson(name, result, all)
            .put("outNs", outNs).put("loadingAtOut", loadingAtOut)
            .put("out", windowJson(outWindow))
        scenes.put(json)
        summaries["$name/out ui"] = WakeFrames.summarize(outWindow.map { it.uiMs })
        summaries["$name/out total"] = WakeFrames.summarize(outWindow.map { it.totalMs })
        finding(
            "[$name] the page was ${if (loadingAtOut) "still loading" else "LOADED already"} at the ${if (back) "back" else "pull"}; " +
                "out window (${OUT_WINDOW_MS} ms): ui ${summaries["$name/out ui"]?.line()}; total ${summaries["$name/out total"]?.line()}; " +
                "dominant ${WakeFrames.dominantStage(outWindow) ?: "none"}; ${describeLong(outWindow)}; ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}"
        )
        // Back to rest: the page loaded, the overview closed on the heavy tab.
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
        if (awaitOverview(open = true, timeoutMs = 2_000)) {
            pickCard(heavyTab)
            awaitOverview(open = false)
        }
        SystemClock.sleep(CLOSE_REST_MS)
        finding("[$name] after: ${tabLine(heavyTab)}; active ${activeTabId()}")
    }

    /** The claims: each sleeping window against the warm control's, under the bar the control sets. */
    private fun judge() {
        for (pass in 1..PASSES) {
            val suffix = if (PASSES > 1) "-$pass" else ""
            claim("wake-tap", "switch", suffix)
            claim("wake-pull-out", "out", suffix)
            if (gestural) claim("wake-back-out", "out", suffix)
        }
    }

    private fun claim(scene: String, window: String, suffix: String) {
        for (reading in listOf("ui", "total")) {
            val control = summaries["$scene-warm$suffix/$window $reading"] ?: WakeFrames.Summary.EMPTY
            val sleeping = summaries["$scene-sleeping$suffix/$window $reading"] ?: WakeFrames.Summary.EMPTY
            val bar = WakeFrames.bar(control)
            val verdict = WakeFrames.judge("$scene$suffix $window ($reading frame time, bar $bar)", sleeping, control, bar)
            // The whole-frame reading is the recipe's (the software GPU's swap in every frame): it
            // is written down beside the UI reading, and asserted only where the control holds it.
            if (reading == "total" && bar !is WakeFrames.Bar.Absolute) {
                findings.append("note ${verdict.line()} – reported, not asserted: the warm control's whole frames miss 60 fps on this recipe\n")
            } else {
                verdicts += verdict
            }
        }
    }

    // --- the gestures ----------------------------------------------------------------------------------

    /** The pull on the pill that opens the overview (the bar's swipe-to-overview), finger lifted. */
    private fun pullOut() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -NUDGE)
        f.moveBy(0f, -PULL_FRACTION * overviewTravel, PULL_MS)
        f.up()
    }

    /** The system's predictive back from the left edge, committed. */
    private fun backOut() {
        val b = Finger()
        b.down(EDGE_X, height * 0.6f)
        b.moveBy(BACK_FRACTION * width, 0f, BACK_MS)
        b.hold(120)
        b.up()
    }

    /** The overview opened off the record by a fling on the pill, at rest; false when it did not open in time. */
    private fun openOverview(): Boolean {
        if (overviewState() == "closed") {
            val g = Finger()
            g.down(pillCenterX, pillY)
            g.moveBy(0f, -NUDGE, 60)
            g.moveBy(0f, -FLING_FRACTION * overviewTravel, FLING_MS)
            g.up()
        }
        val opened = awaitOverview(open = true)
        SystemClock.sleep(OPEN_REST_MS)
        return opened
    }

    private fun pickCard(tabId: String) {
        val card = cardRect(tabId)
        if (card != null) Finger().tap(card.exactCenterX(), card.exactCenterY()) else backOverOverview()
    }

    private fun backOverOverview() {
        if (overviewState() == "closed") return
        back()
    }

    // --- the tab -------------------------------------------------------------------------------------

    /** The heavy tab put to sleep through the core (`tab.unload` → `tabs.discard`), checked. */
    private fun putToSleep() {
        coreInvoke("tab.unload", "{\"tabId\":${JSONObject.quote(heavyTab)}}")
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (tabState(heavyTab)?.optBoolean("discarded") == true && !viewExists(heavyTab)) break
            SystemClock.sleep(150)
        }
        SystemClock.sleep(800)
        finding("asleep: ${tabLine(heavyTab)}")
    }

    private fun tabState(tabId: String): JSONObject? = coreState().optJSONObject("tabs")?.optJSONObject(tabId)

    private fun tabLine(tabId: String): String {
        val tab = tabState(tabId)
        return "discarded ${tab?.optBoolean("discarded")}, loading ${tab?.optBoolean("loading")}, progress ${tab?.optInt("progress")}, view ${if (viewExists(tabId)) "up" else "none"}"
    }

    private fun viewExists(tabId: String): Boolean {
        var up = false
        instrumentation.runOnMainSync { up = host.tabs.get(tabId) != null }
        return up
    }

    /** The view's load state read on the main thread: painted (its first document shown) and loaded (`progress` 100 on the heavy page). */
    private fun loadState(tabId: String): Pair<Boolean, Boolean> {
        var painted = false
        var loaded = false
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            painted = view?.hasPaintedDocument == true
            loaded = view != null && view.progress == 100 && (view.url ?: "").startsWith("$ORIGIN$HEAVY_PATH")
        }
        return painted to loaded
    }

    private fun loaded(tabId: String): Boolean = loadState(tabId).second

    /**
     * Poll the view (every [POLL_MS], one short main-thread hop each) until the heavy page is
     * loaded or `timeoutMs` passed; the times (`System.nanoTime()`) of the first paint seen and of
     * the load, 0 when not seen.
     */
    private fun awaitLoad(tabId: String, timeoutMs: Long): Pair<Long, Long> {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var paintedNs = 0L
        while (SystemClock.uptimeMillis() < deadline) {
            val (painted, loaded) = loadState(tabId)
            val now = System.nanoTime()
            if (painted && paintedNs == 0L) paintedNs = now
            if (loaded) return paintedNs to now
            SystemClock.sleep(POLL_MS)
        }
        return paintedNs to 0L
    }

    private fun awaitLoaded(tabId: String, timeoutMs: Long): Boolean {
        val (_, loadedNs) = awaitLoad(tabId, timeoutMs)
        if (loadedNs == 0L) finding("$tabId did not load in time")
        return loadedNs > 0
    }

    private fun activate(tabId: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val deadline = SystemClock.uptimeMillis() + LOAD_TIMEOUT_MS
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeTabId() == tabId) {
                SystemClock.sleep(LOADED_SETTLE_MS)
                return
            }
            SystemClock.sleep(250)
        }
        finding("$tabId did not become active in time")
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id", "") ?: ""

    // --- the chrome ----------------------------------------------------------------------------------

    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    private fun overviewState(): String =
        jsString("(function(){var e=document.querySelector('.zen-overview');if(!e)return 'closed';return e.style.transform==='scale(1)'?'open':'at '+e.style.transform+' opacity '+e.style.opacity})()")

    private fun awaitOverview(open: Boolean, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val state = overviewState()
            if ((open && state == "open") || (!open && state == "closed")) return true
            SystemClock.sleep(200)
        }
        finding("the overview is ${overviewState()} after $timeoutMs ms, ${if (open) "not open" else "not closed"}")
        return false
    }

    /** The on-screen box of the tab's card in the open overview, scrolled into view; null when it has none. */
    private fun cardRect(tabId: String): Rect? {
        val selector = ".zen-overview [data-tab-id=${JSONObject.quote(tabId)}]"
        chromeJs("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(e)e.scrollIntoView({block:'nearest'})})()")
        SystemClock.sleep(400)
        val text = jsString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var r=e.getBoundingClientRect();" +
                "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})})()"
        )
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        calibrate()
        return Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    /** The DOM's origin against the screen, once, off the overview's Spaces button (as MotionPerfDemo). */
    private fun calibrate() {
        if (calibrated) return
        val text = jsString(
            "(function(){var e=document.querySelector('.zen-overview [aria-label=\"Spaces\"]');if(!e)return '';var r=e.getBoundingClientRect();" +
                "return JSON.stringify({x:(r.left+r.right)/2*window.devicePixelRatio,y:(r.top+r.bottom)/2*window.devicePixelRatio})})()"
        )
        if (text.isEmpty()) return
        val fromTree = findByLabel("Spaces") ?: return
        val o = JSONObject(text)
        val dx = fromTree.exactCenterX() - o.getDouble("x").toFloat()
        val dy = fromTree.exactCenterY() - o.getDouble("y").toFloat()
        calibrated = true
        if (abs(dx) <= MAX_ORIGIN_OFFSET && abs(dy) <= MAX_ORIGIN_OFFSET) {
            originX = dx
            originY = dy
        }
    }

    // --- the record ----------------------------------------------------------------------------------

    private fun sceneJson(name: String, result: FrameStats.Scene, all: List<WakeFrames.Frame>): JSONObject {
        val json = JSONObject().put("scene", name).put("framesRecorded", all.size).put("dropped", frames.dropped)
        result.trace?.let { json.put("trace", JSONObject(it.toJson())) }
        result.traceMissing?.let { json.put("traceMissing", it) }
        result.summary?.let { json.put("gfx", JSONObject().put("frames", it.frames).put("janky", it.janky).put("p50", it.p50Ms).put("p95", it.p95Ms).put("p99", it.p99Ms)) }
        return json
    }

    private fun windowJson(window: List<WakeFrames.Frame>): JSONObject {
        val ui = WakeFrames.summarize(window.map { it.uiMs })
        val total = WakeFrames.summarize(window.map { it.totalMs })
        val stages = JSONObject()
        for ((stage, meanMax) in WakeFrames.stageTotals(window)) stages.put(stage, JSONObject().put("mean", r1(meanMax.first)).put("max", r1(meanMax.second)))
        val list = JSONArray()
        for (f in window) {
            list.put(
                JSONArray().put(f.vsyncNs).put(r1(f.totalMs)).put(r1(f.delayMs)).put(r1(f.inputMs)).put(r1(f.animationMs))
                    .put(r1(f.layoutMs)).put(r1(f.drawMs)).put(r1(f.syncMs)).put(r1(f.commandsMs)).put(r1(f.swapMs)).put(r1(f.gpuMs))
            )
        }
        return JSONObject()
            .put("ui", summaryJson(ui)).put("total", summaryJson(total))
            .put("dominant", WakeFrames.dominantStage(window) ?: JSONObject.NULL)
            .put("stages", stages)
            .put("frames", list)
            .put("columns", JSONArray(listOf("vsyncNs", "total", "delay", "input", "animation", "layout", "draw", "sync", "commands", "swap", "gpu")))
    }

    private fun summaryJson(s: WakeFrames.Summary): JSONObject = JSONObject()
        .put("frames", s.frames).put("p50", r1(s.p50)).put("p95", r1(s.p95)).put("p99", r1(s.p99))
        .put("longest", r1(s.longest)).put("mean", r1(s.mean)).put("over16", s.over16).put("over32", s.over32)

    /** The long frames of a window by their longest stage, for the findings: `delay 212.4 (at +38 ms)`. */
    private fun describeLong(window: List<WakeFrames.Frame>): String {
        val start = window.firstOrNull()?.vsyncNs ?: return "no frames"
        val long = window.filter { it.uiMs > WakeFrames.HITCH_MS }
        if (long.isEmpty()) return "no UI frame over 32 ms"
        return "UI frames over 32 ms: " + long.take(12).joinToString(", ") {
            String.format(Locale.ROOT, "%s %.1f (ui %.1f at +%d ms)", it.longestStage(), it.stages()[it.longestStage()] ?: 0.0, it.uiMs, (it.vsyncNs - start) / 1_000_000)
        } + if (long.size > 12) " and ${long.size - 12} more" else ""
    }

    private fun ms(deltaNs: Long, known: Boolean): String = if (known) "${deltaNs / 1_000_000} ms" else "not seen"

    private fun r1(v: Double): Double = Math.round(v * 10) / 10.0

    private fun finishCaptures() {
        if (perfettoOn) {
            capture.perfettoStop(PERFETTO_KEY)
            perfettoOn = false
        }
    }

    private fun finding(line: String) {
        findings.append(line).append('\n')
        Log.i(tag, line)
    }

    // --- the pages -----------------------------------------------------------------------------------

    /**
     * A page fixture kept gzipped in the tree (`perf/<name>.html.gz`). AAPT2 gunzips a `.gz` asset
     * as it packages it and drops the suffix, so the APK carries `perf/<name>.html` plain; a build
     * that kept the file as it is answers under the tree's name (see BarHidePerfDemo).
     */
    private fun pageFixture(name: String): ByteArray {
        val assets = instrumentation.context.assets
        val plain = runCatching { assets.open("perf/$name.html") }.getOrNull()
        if (plain != null) return plain.use { it.readBytes() }
        val bytes = assets.open("perf/$name.html.gz").use { it.readBytes() }
        val gzip = bytes.size >= 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte()
        return if (gzip) GZIPInputStream(bytes.inputStream()).use { it.readBytes() } else bytes
    }

    /**
     * The heavy page: a title, thirty-six images the server answers after a delay, and a script
     * that builds a long document in animation-frame chunks – a load of seconds on the renderer's
     * one main thread and the network, the way a news page loads.
     */
    private fun heavyPage(): String {
        val images = (0 until HEAVY_IMAGES).joinToString("\n") { "<img src=\"/img/$it.png\" width=\"320\" height=\"200\" alt=\"\">" }
        return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heavy page (tab wake)</title>
<style>body{font-family:sans-serif;margin:0;padding:16px;background:#fafafa;color:#222}h1{font-size:22px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}img{width:100%;height:auto;background:#ddd;border-radius:8px}
.row{padding:8px 0;border-bottom:1px solid #eee;font-size:14px}.row b{color:#06c}</style></head>
<body><h1>Heavy page</h1><p>Thirty-six images and a long document built by script.</p>
<div class="grid">$images</div>
<div id="list"></div>
<script>
(function(){var list=document.getElementById('list'),i=0,total=$HEAVY_ROWS;
function chunk(){var frag=document.createDocumentFragment();for(var k=0;k<60&&i<total;k++,i++){var d=document.createElement('div');d.className='row';
d.innerHTML='<b>Row '+i+'</b> lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore '+(i*7919%1000);frag.appendChild(d);}
list.appendChild(frag);list.offsetHeight;if(i<total)requestAnimationFrame(chunk);}
requestAnimationFrame(chunk);})();
</script></body></html>"""
    }

    /** One generated PNG (a gradient and a number), a few tens of KB. */
    private fun image(i: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(640, 400, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint().apply {
            shader = LinearGradient(0f, 0f, 640f, 400f, Color.HSVToColor(floatArrayOf((i * 37 % 360).toFloat(), 0.6f, 0.9f)), Color.HSVToColor(floatArrayOf(((i * 37 + 120) % 360).toFloat(), 0.5f, 0.6f)), Shader.TileMode.CLAMP)
        }
        canvas.drawRect(0f, 0f, 640f, 400f, paint)
        val text = Paint().apply { color = Color.WHITE; textSize = 96f; isAntiAlias = true }
        canvas.drawText("$i", 40f, 240f, text)
        // Noise so the PNG does not compress to nothing.
        val dots = Paint().apply { color = Color.argb(60, 0, 0, 0) }
        var seed = i * 1_103_515_245L + 12_345
        for (n in 0 until 3_000) {
            seed = (seed * 6_364_136_223_846_793_005L + 1_442_695_040_888_963_407L)
            val x = ((seed ushr 33) % 640).toFloat()
            val y = ((seed ushr 13) % 400).toFloat()
            canvas.drawCircle(x, y, 2f, dots)
        }
        val bytes = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        bitmap.recycle()
        return bytes.toByteArray()
    }

    companion object {
        private const val PORT = 18170
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val HEAVY_PATH = "/heavy"
        private const val HEAVY_IMAGES = 36
        private const val HEAVY_ROWS = 2_400
        private const val IMAGE_DELAY_MS = 500L
        private const val START_TAB = "tab_article"
        /** How many times the warm / sleeping pair runs. */
        private const val PASSES = 1
        private const val LOAD_TIMEOUT_MS = 30_000L
        private const val LOADED_SETTLE_MS = 1_500L
        private const val POLL_MS = 100L
        /** The close morph's window after the tap: the overview's spring lands inside it. */
        private const val SWITCH_WINDOW_MS = 1_000L
        /** How long after the tap the way out begins: the morph has landed, the page still loads. */
        private const val OUT_AFTER_MS = 900L
        /** The way out's window: the gesture and its spring. */
        private const val OUT_WINDOW_MS = 2_000L
        private const val PULL_FRACTION = 0.75f
        private const val PULL_MS = 600L
        private const val FLING_FRACTION = 0.5f
        private const val FLING_MS = 220L
        private const val OPEN_REST_MS = 1_500L
        private const val CLOSE_SETTLE_MS = 2_500L
        private const val CLOSE_REST_MS = 1_500L
        private const val EDGE_X = 2f
        private const val BACK_FRACTION = 0.33f
        private const val BACK_MS = 500L
        private const val MAX_ORIGIN_OFFSET = 64f
        private const val PERFETTO_KEY = "zenperf"
        private const val PERFETTO_FILE = "${PerfCapture.PERFETTO_DIR}/zen-tab-wake.pftrace"
    }
}

/**
 * Every frame of a window as HWUI reports it (`Window.OnFrameMetricsAvailableListener`, on a
 * thread of its own so the UI thread does no bookkeeping), kept as [WakeFrames.Frame]s with their
 * vsync time, so a scene's window can be cut out afterwards. [start] clears and listens, [stop]
 * stops listening and returns what came; `dropped` counts the frames the listener missed.
 */
class FrameWatch(private val window: Window) {
    private val thread = HandlerThread("frame-watch").apply { start() }
    private val handler = Handler(thread.looper)
    private val frames = Collections.synchronizedList(ArrayList<WakeFrames.Frame>())
    @Volatile var dropped = 0
        private set
    private var listening = false

    private val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropCount ->
        dropped += dropCount
        val m = FrameMetrics(metrics)
        fun ms(id: Int): Double = m.getMetric(id) / 1e6
        frames += WakeFrames.Frame(
            vsyncNs = m.getMetric(FrameMetrics.VSYNC_TIMESTAMP),
            totalMs = ms(FrameMetrics.TOTAL_DURATION),
            delayMs = ms(FrameMetrics.UNKNOWN_DELAY_DURATION),
            inputMs = ms(FrameMetrics.INPUT_HANDLING_DURATION),
            animationMs = ms(FrameMetrics.ANIMATION_DURATION),
            layoutMs = ms(FrameMetrics.LAYOUT_MEASURE_DURATION),
            drawMs = ms(FrameMetrics.DRAW_DURATION),
            syncMs = ms(FrameMetrics.SYNC_DURATION),
            commandsMs = ms(FrameMetrics.COMMAND_ISSUE_DURATION),
            swapMs = ms(FrameMetrics.SWAP_BUFFERS_DURATION),
            gpuMs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) ms(FrameMetrics.GPU_DURATION) else -1.0,
            firstDraw = m.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L
        )
    }

    fun start() {
        frames.clear()
        dropped = 0
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            if (!listening) {
                window.addOnFrameMetricsAvailableListener(listener, handler)
                listening = true
            }
        }
    }

    fun stop(): List<WakeFrames.Frame> {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            if (listening) {
                window.removeOnFrameMetricsAvailableListener(listener)
                listening = false
            }
        }
        // The listener's handler may still hold the last frame's callback.
        val flushed = CountDownLatch(1)
        handler.post { flushed.countDown() }
        flushed.await(2, TimeUnit.SECONDS)
        return synchronized(frames) { ArrayList(frames) }
    }
}
