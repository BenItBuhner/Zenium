package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.View
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
 * renderer main thread the chrome's React animation runs on. The fix under test is the SPARE page
 * view ([TabHost.warm]): the host builds the next wake's `TabWebView` on a still moment after a
 * page went under the chrome, so [TabHost.create] hands it over instead of constructing one inside
 * the morph's first frames.
 *
 * The pages come from this process ([DemoServer], loopback, repeatable): the perf state's six
 * tabs, a LIGHT page as the heavy tab's first history entry (so a back has a page to go to), and
 * the HEAVY page made here – main-thread heavy and raster light, the way a news page loads:
 * thirty-six small images each served after a delay, a script that builds a long document in
 * animation-frame chunks with a forced layout each, and a chain of fetched row chunks the server
 * answers late. Its title changes to [DONE_TITLE] once everything is built: that is "loaded".
 *
 * THREE STATES of the heavy tab, each the same three real-touch gestures:
 *
 *  - `warm`: the page loaded and kept – the control;
 *  - `sleeping`: unloaded through the core's own path right before, the spare view ON (the fix);
 *  - `cold`: unloaded the same way, the spare view OFF ([TabHost.warmingEnabled] false, so every
 *    wake builds its view inside the morph as before the fix – the before-reading on the same run).
 *
 * The gestures: `wake-tap-<state>`, a tap on the tab's card in the open overview – the `switch`
 * window runs from the tap to the page view's show (the morph landed), `land` from the show to the
 * page's first paint, `load` from the tap to the load; `wake-pull-out-<state>`, the tap, then once
 * the page is up and still loading a pull on the pill back to the overview (the bar's
 * swipe-to-overview, the way out of a tab on the phone) – the `out` window is the gesture's first
 * [OUT_WINDOW_MS]; `wake-back-out-<state>`, the same with the system's predictive back gesture from
 * the left edge (gesture navigation is turned on for the run), which at a page with history is the
 * page's own back – the other swipe that leaves what is on screen.
 *
 * THREE INSTRUMENTS. (1) `Window.addOnFrameMetricsAvailableListener` on the activity's window
 * ([FrameWatch]): every frame of the app's window with its stages (the delay before the frame
 * began, input, animation, measure/layout, draw, sync, the render thread's command issue, the
 * swap) and its vsync time, cut to each scene's windows – the numbers of the complaint (p50/p95/p99,
 * frames over one and over two vsyncs, the longest), in three readings ([WakeFrames]: `own`, `ui`,
 * `total`). (2) The harness's [traceFrames] around each scene: `dumpsys gfxinfo framestats` as the
 * second witness of the same frames (`framestats-<scene>.txt`, `frames.jsonl`) and the WebViews'
 * Chromium trace (`trace-<scene>.json.gz`) read into the renderer main thread's work per frame and
 * its long tasks. (3) A Perfetto trace of the device across the measured sequence when the workflow
 * pushed the config (`DEMO_PERFETTO_CONFIG`, [PerfCapture]), each scene marked (`zenperf <scene>`)
 * and written to `scenes.txt` in the trace's clock, for `android-perf-trace.py` to cut and for
 * `android-tab-wake-spans.py` to find the host's own marks in (`zen:TabHost.create`,
 * `zen:TabHost.warm`).
 *
 * THE CLAIMS, each a `PASS` / `FAIL` line with its numbers in `tab-wake-findings.txt`; under
 * `-e assert true` a failed one fails the run once the record is written:
 *
 *  - `spare`: every sleeping wake took the spare view, and [TabHost.create] held the UI thread
 *    no longer than [CREATE_CAP_MS] (the cold wakes' construction time is written beside it);
 *  - `switch` and `out`, sleeping against warm, on the `own` reading (the UI thread's own work in
 *    the frame): the program's bar – p95 at or under one vsync, no frame over two – where the warm
 *    control holds it, and RELATIVE to the control (the lane's ratios) where the recipe's software
 *    GPU cannot hold 60 fps for anything ([WakeFrames.bar] says which applied). The `ui` and
 *    `total` readings, and every cold reading, are reported beside the claims and not asserted
 *    here: `ui` carries the chrome WebView's wait on the renderer's compositor, which the one
 *    renderer every page shares stretches while the page's first tiles raster, and `total` the
 *    software composite – neither is the host's work (the profile in the PR names both).
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
    private val spareWakes = ArrayList<WakeFrames.Wake>()
    private val coldWakes = ArrayList<WakeFrames.Wake>()
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
        routes[LIGHT_PATH] = "text/html; charset=utf-8" to lightPage().toByteArray()
        routes[HEAVY_PATH] = "text/html; charset=utf-8" to heavyPage().toByteArray()
        val delays = HashMap<String, Long>()
        for (i in 0 until HEAVY_IMAGES) {
            routes["/img/$i.png"] = "image/png" to image(i)
            delays["/img/$i.png"] = IMAGE_DELAY_MS
        }
        for (n in 0 until ROW_CHUNKS) {
            routes["/rows/$n"] = "application/json" to JSONArray((0 until ROWS_PER_CHUNK).map { HEAVY_ROWS + n * ROWS_PER_CHUNK + it }).toString().toByteArray()
            delays["/rows/$n"] = ROW_CHUNK_DELAY_MS
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
                .put("spareWakes", JSONArray().apply { spareWakes.forEach { put(JSONObject().put("tookSpare", it.tookSpare).put("createMs", r1(it.createMs))) } })
                .put("coldWakes", JSONArray().apply { coldWakes.forEach { put(JSONObject().put("tookSpare", it.tookSpare).put("createMs", r1(it.createMs))) } })
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
        makeHeavyTab()
        touchWithoutGesture()
        settle()
        // The start tab visited too (its card has a picture), then back to it: the heavy tab is
        // hidden, its picture captured on the hide.
        activate(START_TAB)
        settle()
        finding("heavy tab $heavyTab: ${tabLine(heavyTab)}")
        spareMemory()
        // Pay for the touch pipeline off the record: the overview opened and picked closed once.
        if (openOverview()) {
            pickCard(START_TAB)
            awaitOverview(open = false)
            SystemClock.sleep(CLOSE_REST_MS)
        }
        perfettoOn = capture.perfettoAvailable() && capture.perfettoStart(PERFETTO_KEY, PERFETTO_FILE)
        finding("perfetto ${if (perfettoOn) "tracing to $PERFETTO_FILE" else "off (no config pushed)"}")
        SystemClock.sleep(1_000)

        // The warm control first, then the fix, then the before-reading with the spare off – the
        // fix's own scenes come before the before-reading's so the emulator's warming over the run
        // (its JIT, its caches) flatters the before, never the after.
        runScenes(State.WARM)
        runScenes(State.SLEEPING)
        setWarming(false)
        runScenes(State.COLD)
        setWarming(true)
        finishCaptures()
        judge()
    }

    private enum class State(val word: String, val sleeping: Boolean) {
        WARM("warm", false), SLEEPING("sleeping", true), COLD("cold", true)
    }

    private fun runScenes(state: State) {
        wakeTap(state)
        wakeOut(state, back = false)
        if (gestural) wakeOut(state, back = true)
    }

    /** The recorded media: one sleeping wake, tapped and pulled back out while it loads. */
    override fun demo() {
        activate(START_TAB)
        settle()
        putToSleep()
        if (!openOverview()) return
        awaitSpare(SPARE_WAIT_MS)
        shot("overview-sleeping")
        val card = cardRect(heavyTab) ?: return
        Finger().tap(card.exactCenterX(), card.exactCenterY())
        awaitShown(heavyTab, SWITCH_CAP_MS)
        SystemClock.sleep(OUT_AFTER_SHOW_MS)
        shot("woken-loading")
        pullOut()
        SystemClock.sleep(CLOSE_SETTLE_MS)
        shot("pulled-out")
        restoreHeavy()
        shot("woken-loaded")
    }

    // --- the scenes ----------------------------------------------------------------------------------

    /**
     * The tap on the heavy tab's card in the open overview. Three windows are summarised:
     * `switch`, the tap to the page view's show (the morph: the overview's spring landing on the
     * card's picture; capped at [SWITCH_CAP_MS]), `land`, the show to the page's first paint (a
     * sleeping tab's blank moment), and `load`, the tap to the load.
     */
    private fun wakeTap(state: State) {
        val name = "wake-tap-${state.word}"
        activate(START_TAB)
        settle()
        if (state.sleeping) putToSleep()
        if (!openOverview()) {
            finding("[$name] the overview did not open; skipped")
            return
        }
        val spareBefore = if (state == State.SLEEPING) awaitSpare(SPARE_WAIT_MS) else hasSpare()
        val card = cardRect(heavyTab)
        if (card == null) {
            finding("[$name] no card for $heavyTab in the grid; skipped")
            backOverOverview()
            return
        }
        var tapNs = 0L
        var marks = WakeMarks()
        var startBoot = 0L
        var endBoot = 0L
        val sparesBefore = sparesBuilt()
        frames.start()
        val result = traceFrames(name, JankBudget.Kind.SPRING) {
            SystemClock.sleep(400)
            val cookie = capture.sceneBegin(name)
            startBoot = capture.nowBoot()
            tapNs = System.nanoTime()
            Finger().tap(card.exactCenterX(), card.exactCenterY())
            marks = awaitWake(heavyTab, if (state.sleeping) LOAD_TIMEOUT_MS else SWITCH_CAP_MS)
            // The warm control is loaded already: its window is the morph, then the spring's rest.
            SystemClock.sleep(if (state.sleeping) 300 else 1_000)
            endBoot = capture.nowBoot()
            capture.sceneEnd(name, cookie)
        }
        val all = frames.stop()
        sceneWindows.append("$name $startBoot $endBoot\n")
        val wake = if (state.sleeping) recordWake(state, name, spareBefore) else null
        val switchEnd = if (marks.shownNs > 0) marks.shownNs else tapNs + SWITCH_CAP_MS * 1_000_000
        val switchWindow = WakeFrames.window(all, tapNs, switchEnd)
        val landWindow = if (marks.shownNs > 0 && marks.paintedNs > marks.shownNs) WakeFrames.window(all, marks.shownNs, marks.paintedNs) else emptyList()
        val loadEnd = if (marks.loadedNs > 0) marks.loadedNs else tapNs + LOAD_TIMEOUT_MS * 1_000_000
        val loadWindow = WakeFrames.window(all, tapNs, loadEnd)
        val json = sceneJson(name, result, all)
            .put("tapNs", tapNs).put("shownNs", marks.shownNs).put("paintedNs", marks.paintedNs).put("loadedNs", marks.loadedNs)
            .put("toShowMs", msOr(marks.shownNs - tapNs, marks.shownNs > 0))
            .put("toFirstPaintMs", msOr(marks.paintedNs - tapNs, marks.paintedNs > 0))
            .put("toLoadMs", msOr(marks.loadedNs - tapNs, marks.loadedNs > 0))
            .put("sparesBuiltInScene", sparesBuilt() - sparesBefore)
            .put("switch", windowJson(switchWindow))
            .put("land", windowJson(landWindow))
            .put("load", windowJson(loadWindow))
        wake?.let { json.put("spare", JSONObject().put("before", spareBefore).put("took", it.tookSpare).put("createMs", r1(it.createMs))) }
        scenes.put(json)
        summarise("$name/switch", switchWindow)
        if (state.sleeping) {
            summarise("$name/land", landWindow)
            summarise("$name/load", loadWindow)
        }
        finding(
            "[$name] tapped at $card; shown ${ms(marks.shownNs - tapNs, marks.shownNs > 0)}, first paint ${ms(marks.paintedNs - tapNs, marks.paintedNs > 0)}, " +
                "load ${ms(marks.loadedNs - tapNs, marks.loadedNs > 0)}; ${all.size} frames recorded; " +
                (wake?.let { "create ${if (it.tookSpare) "took the spare" else "BUILT the view"} in ${r1(it.createMs)} ms (spare stood before the tap: $spareBefore); " } ?: "") +
                "switch: own ${summaries["$name/switch own"]?.line()}; ui ${summaries["$name/switch ui"]?.line()}; total ${summaries["$name/switch total"]?.line()}; " +
                "dominant ${WakeFrames.dominantStage(switchWindow) ?: "none"}; ${describeLong(switchWindow)}; ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}"
        )
        if (state.sleeping) {
            finding("[$name] land window: own ${summaries["$name/land own"]?.line()}; ui ${summaries["$name/land ui"]?.line()}; ${describeLong(landWindow)}")
            finding("[$name] load window: own ${summaries["$name/load own"]?.line()}; ui ${summaries["$name/load ui"]?.line()}; total ${summaries["$name/load total"]?.line()}; ${describeLong(loadWindow)}")
        }
        restoreHeavy()
        SystemClock.sleep(CLOSE_REST_MS)
        finding("[$name] after: ${tabLine(heavyTab)}; active ${activeTabId()}; spares built so far ${sparesBuilt()}")
    }

    /**
     * The tap, then – the page view up and the page still loading – the way out: the pull on the
     * pill back to the overview (`back = false`) or the system's back gesture from the left edge
     * (`back = true`, the page's own back to the light page). The `out` window is the gesture's
     * first [OUT_WINDOW_MS]: the finger, the spring, its settle.
     */
    private fun wakeOut(state: State, back: Boolean) {
        val name = "wake-${if (back) "back" else "pull"}-out-${state.word}"
        activate(START_TAB)
        settle()
        if (state.sleeping) putToSleep()
        if (!openOverview()) {
            finding("[$name] the overview did not open; skipped")
            return
        }
        val spareBefore = if (state == State.SLEEPING) awaitSpare(SPARE_WAIT_MS) else hasSpare()
        val card = cardRect(heavyTab)
        if (card == null) {
            finding("[$name] no card for $heavyTab in the grid; skipped")
            backOverOverview()
            return
        }
        var tapNs = 0L
        var shownNs = 0L
        var outNs = 0L
        var startBoot = 0L
        var endBoot = 0L
        var loadingAtOut = false
        var canGoBackAtOut = false
        val sparesBefore = sparesBuilt()
        frames.start()
        val result = traceFrames(name, JankBudget.Kind.GESTURE) {
            SystemClock.sleep(400)
            val cookie = capture.sceneBegin(name)
            startBoot = capture.nowBoot()
            tapNs = System.nanoTime()
            Finger().tap(card.exactCenterX(), card.exactCenterY())
            shownNs = awaitShown(heavyTab, SWITCH_CAP_MS)
            SystemClock.sleep(OUT_AFTER_SHOW_MS)
            if (back) canGoBackAtOut = awaitCanGoBack(heavyTab, BACK_READY_MS)
            loadingAtOut = !loaded(heavyTab)
            outNs = System.nanoTime()
            if (back) backOut() else pullOut()
            SystemClock.sleep(CLOSE_SETTLE_MS)
            endBoot = capture.nowBoot()
            capture.sceneEnd(name, cookie)
        }
        val all = frames.stop()
        sceneWindows.append("$name $startBoot $endBoot\n")
        val wake = if (state.sleeping) recordWake(state, name, spareBefore) else null
        val outWindow = WakeFrames.window(all, outNs, outNs + OUT_WINDOW_MS * 1_000_000)
        val json = sceneJson(name, result, all)
            .put("tapNs", tapNs).put("shownNs", shownNs).put("outNs", outNs)
            .put("toShowMs", msOr(shownNs - tapNs, shownNs > 0))
            .put("loadingAtOut", loadingAtOut).put("canGoBackAtOut", canGoBackAtOut)
            .put("sparesBuiltInScene", sparesBuilt() - sparesBefore)
            .put("out", windowJson(outWindow))
        wake?.let { json.put("spare", JSONObject().put("before", spareBefore).put("took", it.tookSpare).put("createMs", r1(it.createMs))) }
        scenes.put(json)
        summarise("$name/out", outWindow)
        finding(
            "[$name] shown ${ms(shownNs - tapNs, shownNs > 0)} after the tap; the page was ${if (loadingAtOut) "still loading" else "LOADED already"} at the ${if (back) "back" else "pull"}" +
                (if (back) " (history behind it: $canGoBackAtOut)" else "") + "; " +
                (wake?.let { "create ${if (it.tookSpare) "took the spare" else "BUILT the view"} in ${r1(it.createMs)} ms; " } ?: "") +
                "out (${OUT_WINDOW_MS} ms): own ${summaries["$name/out own"]?.line()}; ui ${summaries["$name/out ui"]?.line()}; total ${summaries["$name/out total"]?.line()}; " +
                "dominant ${WakeFrames.dominantStage(outWindow) ?: "none"}; ${describeLong(outWindow)}; ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}"
        )
        // Back to rest: the overview closed on the heavy tab (the pull), the heavy page back in
        // front and loaded (the back went to the light page; a back at the root would have closed
        // the tab – restoreHeavy makes it again then).
        if (!back && awaitOverview(open = true, timeoutMs = 2_000)) {
            pickCard(heavyTab)
            awaitOverview(open = false)
        }
        SystemClock.sleep(CLOSE_REST_MS)
        restoreHeavy()
        SystemClock.sleep(CLOSE_REST_MS)
        finding("[$name] after: ${tabLine(heavyTab)}; active ${activeTabId()}; spares built so far ${sparesBuilt()}")
    }

    private fun summarise(prefix: String, window: List<WakeFrames.Frame>) {
        summaries["$prefix own"] = WakeFrames.summarize(window.map { it.ownMs })
        summaries["$prefix ui"] = WakeFrames.summarize(window.map { it.uiMs })
        summaries["$prefix total"] = WakeFrames.summarize(window.map { it.totalMs })
    }

    /** What the host saw of the wake that just happened: the spare taken or not, and `create`'s time. */
    private fun recordWake(state: State, name: String, spareBefore: Boolean): WakeFrames.Wake {
        var took = false
        var micros = 0L
        instrumentation.runOnMainSync {
            took = host.tabs.lastCreateTookSpare
            micros = host.tabs.lastCreateMicros
        }
        val wake = WakeFrames.Wake(took, micros / 1000.0)
        if (state == State.SLEEPING) spareWakes += wake else coldWakes += wake
        if (state == State.SLEEPING && !spareBefore) finding("[$name] no spare stood when the card was tapped")
        return wake
    }

    /** The claims: the construction one, then each sleeping window against the warm control's under the bar the control sets. */
    private fun judge() {
        verdicts += WakeFrames.judgeCreate(
            "spare: every sleeping wake took the spare view and TabHost.create held the UI thread <= ${r1(CREATE_CAP_MS)} ms",
            spareWakes, CREATE_CAP_MS
        )
        if (coldWakes.isNotEmpty()) {
            finding(
                "before (warming off): TabHost.create built the view inside the morph in " +
                    coldWakes.joinToString(", ") { r1(it.createMs).toString() } + " ms per wake" +
                    (spareWakes.takeIf { it.isNotEmpty() }?.let { " – with the spare: " + it.joinToString(", ") { w -> r1(w.createMs).toString() } + " ms" } ?: "")
            )
        }
        for ((scene, window) in listOf("wake-tap" to "switch", "wake-pull-out" to "out", "wake-back-out" to "out")) {
            if (scene == "wake-back-out" && !gestural) continue
            claim(scene, window, State.SLEEPING)
            claim(scene, window, State.COLD)
        }
    }

    private fun claim(scene: String, window: String, state: State) {
        for (reading in READINGS) {
            val control = summaries["$scene-warm/$window $reading"] ?: WakeFrames.Summary.EMPTY
            val subject = summaries["$scene-${state.word}/$window $reading"] ?: WakeFrames.Summary.EMPTY
            val bar = WakeFrames.bar(control)
            val verdict = WakeFrames.judge("$scene $window ${state.word} ($reading frame time, bar $bar)", subject, control, bar)
            val why = when {
                state == State.COLD -> "the before-reading, warming off"
                bar is WakeFrames.Bar.Absolute -> null
                reading == "ui" -> "the warm control's whole frames miss 60 fps on this recipe, and `ui` carries the WebView's wait on the renderer"
                reading == "total" -> "the warm control's whole frames miss 60 fps on this recipe (the software composite)"
                else -> null
            }
            if (why == null) verdicts += verdict else findings.append("note ${verdict.line()} – reported, not asserted: $why\n")
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

    /** The heavy tab made: the light page first, the heavy page over it – two entries, the heavy one current. */
    private fun makeHeavyTab() {
        heavyTab = coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN$LIGHT_PATH")},\"active\":true}").trim('"')
        if (!awaitUrl(heavyTab, "$ORIGIN$LIGHT_PATH", LOAD_TIMEOUT_MS)) finding("the light page did not load in time")
        SystemClock.sleep(1_000)
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(heavyTab)},\"input\":${JSONObject.quote("$ORIGIN$HEAVY_PATH")}}")
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
    }

    /**
     * The heavy tab back at rest after a scene: alive (a back at its root would have closed it –
     * made again then), the heavy page current (a back went to the light page: forward again by a
     * navigation, which also keeps the list at two entries) and loaded.
     */
    private fun restoreHeavy() {
        if (tabState(heavyTab) == null) {
            finding("the heavy tab $heavyTab is gone (a back at its root closes the tab); made again")
            makeHeavyTab()
            return
        }
        if (activeTabId() != heavyTab) activate(heavyTab)
        val (_, url) = viewUrl(heavyTab)
        if (url != "$ORIGIN$HEAVY_PATH") {
            coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(heavyTab)},\"input\":${JSONObject.quote("$ORIGIN$HEAVY_PATH")}}")
        }
        awaitLoaded(heavyTab, LOAD_TIMEOUT_MS)
    }

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
        val (exists, url) = viewUrl(tabId)
        return "discarded ${tab?.optBoolean("discarded")}, loading ${tab?.optBoolean("loading")}, progress ${tab?.optInt("progress")}, view ${if (exists) "up at $url" else "none"}"
    }

    private fun viewExists(tabId: String): Boolean = viewUrl(tabId).first

    private fun viewUrl(tabId: String): Pair<Boolean, String> {
        var exists = false
        var url = ""
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            exists = view != null
            url = view?.url ?: ""
        }
        return exists to url
    }

    /** The view's state read on the main thread, one short hop: up, shown, painted, and the heavy page loaded (its done title, at its url). */
    private class ViewState(val exists: Boolean, val shown: Boolean, val painted: Boolean, val loaded: Boolean, val canGoBack: Boolean)

    private fun viewState(tabId: String): ViewState {
        var state = ViewState(false, false, false, false, false)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            state = ViewState(
                exists = view != null,
                shown = view?.visibility == View.VISIBLE,
                painted = view?.hasPaintedDocument == true,
                loaded = view != null && view.progress == 100 && view.url == "$ORIGIN$HEAVY_PATH" && view.title == DONE_TITLE,
                canGoBack = view?.canGoBack() == true
            )
        }
        return state
    }

    private fun loaded(tabId: String): Boolean = viewState(tabId).loaded

    /** The times (`System.nanoTime()`) a wake's moments were first seen at; 0 when not seen. */
    private class WakeMarks(var shownNs: Long = 0L, var paintedNs: Long = 0L, var loadedNs: Long = 0L)

    /**
     * Poll the view (every [POLL_MS], one short main-thread hop each) from the tap until the heavy
     * page is shown and loaded or `timeoutMs` passed, noting when its view was first seen shown
     * (the morph landed), first seen painted, and loaded (the warm control is loaded before the
     * tap: its marks all fall at the show).
     */
    private fun awaitWake(tabId: String, timeoutMs: Long): WakeMarks {
        val marks = WakeMarks()
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val state = viewState(tabId)
            val now = System.nanoTime()
            if (state.shown && marks.shownNs == 0L) marks.shownNs = now
            if (state.shown && state.painted && marks.paintedNs == 0L) marks.paintedNs = now
            if (state.shown && state.loaded) {
                marks.loadedNs = now
                return marks
            }
            SystemClock.sleep(POLL_MS)
        }
        return marks
    }

    /** Poll until the view is shown; the time it was first seen so, else 0 after `timeoutMs`. */
    private fun awaitShown(tabId: String, timeoutMs: Long): Long {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (viewState(tabId).shown) return System.nanoTime()
            SystemClock.sleep(POLL_MS)
        }
        return 0L
    }

    private fun awaitCanGoBack(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (viewState(tabId).canGoBack) return true
            SystemClock.sleep(POLL_MS)
        }
        return false
    }

    private fun awaitLoaded(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (viewState(tabId).loaded) return true
            SystemClock.sleep(POLL_MS)
        }
        finding("$tabId did not load the heavy page in time: ${tabLine(tabId)}")
        return false
    }

    /** Poll until the view shows `url` with `progress` 100. */
    private fun awaitUrl(tabId: String, url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var there = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                there = view != null && view.progress == 100 && view.url == url
            }
            if (there) return true
            SystemClock.sleep(POLL_MS)
        }
        return false
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

    // --- the spare view ------------------------------------------------------------------------------

    private fun hasSpare(): Boolean {
        var up = false
        instrumentation.runOnMainSync { up = host.tabs.hasSpare }
        return up
    }

    private fun sparesBuilt(): Int {
        var n = 0
        instrumentation.runOnMainSync { n = host.tabs.sparesBuilt }
        return n
    }

    private fun setWarming(on: Boolean) {
        instrumentation.runOnMainSync {
            host.tabs.warmingEnabled = on
            if (!on) host.tabs.dropSpare()
        }
        finding("spare warming ${if (on) "on" else "OFF (the before-reading)"}; a spare stands: ${hasSpare()}")
    }

    /** Wait for the host to have built the spare (the overview open and still); whether one stands. */
    private fun awaitSpare(timeoutMs: Long): Boolean {
        val started = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - started < timeoutMs) {
            if (hasSpare()) {
                val waited = SystemClock.uptimeMillis() - started
                if (waited > 0) finding("the spare stood $waited ms after the overview came to rest")
                return true
            }
            SystemClock.sleep(POLL_MS)
        }
        finding("no spare stood $timeoutMs ms after the overview came to rest")
        return false
    }

    /** What one spare view costs this process, read off the record: built, measured, dropped. */
    private fun spareMemory() {
        var line = ""
        instrumentation.runOnMainSync {
            val container = host.tabs.get(START_TAB)?.containerId
            if (container == null) {
                line = "spare memory: no view for $START_TAB to read the container from"
                return@runOnMainSync
            }
            host.tabs.dropSpare()
            System.gc()
            val before = Debug.getPss()
            val started = System.nanoTime()
            val built = host.tabs.warm(container)
            val tookMs = (System.nanoTime() - started) / 1e6
            val after = Debug.getPss()
            host.tabs.dropSpare()
            line = String.format(Locale.ROOT, "spare memory: one spare page view built in %.1f ms (%s), PSS of this process %d -> %d KB (+%d KB; the renderer is another process and untouched until a navigation)", tookMs, if (built) "built" else "NOT built", before, after, after - before)
        }
        finding(line)
    }

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
            .put("own", summaryJson(WakeFrames.summarize(window.map { it.ownMs })))
            .put("ui", summaryJson(WakeFrames.summarize(window.map { it.uiMs })))
            .put("total", summaryJson(WakeFrames.summarize(window.map { it.totalMs })))
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
            String.format(Locale.ROOT, "%s %.1f (ui %.1f, own %.1f at +%d ms)", it.longestStage(), it.stages()[it.longestStage()] ?: 0.0, it.uiMs, it.ownMs, (it.vsyncNs - start) / 1_000_000)
        } + if (long.size > 12) " and ${long.size - 12} more" else ""
    }

    private fun ms(deltaNs: Long, known: Boolean): String = if (known) "${deltaNs / 1_000_000} ms" else "not seen"

    private fun msOr(deltaNs: Long, known: Boolean): Double = if (known) deltaNs / 1e6 else -1.0

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

    /** The light page: the heavy tab's first history entry, a back's destination. */
    private fun lightPage(): String = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Light page</title><style>body{font-family:sans-serif;margin:0;padding:16px;background:#f4f6f8;color:#222}</style></head>
<body><h1>Light page</h1><p>The page before the heavy one: a back from the heavy page lands here.</p></body></html>"""

    /**
     * The heavy page: a title, thirty-six small images the server answers after a delay, a script
     * that builds a long document in animation-frame chunks with a forced layout after each (the
     * long main-thread tasks of a news page's build), and a chain of row chunks fetched one after
     * another, each answered late. Its title becomes [DONE_TITLE] once the rows are all in: a load
     * of seconds on the renderer's one main thread, light on the raster.
     */
    private fun heavyPage(): String {
        val images = (0 until HEAVY_IMAGES).joinToString("\n") { "<img src=\"/img/$it.png\" width=\"64\" height=\"40\" alt=\"\">" }
        return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heavy page (tab wake)</title>
<style>body{font-family:sans-serif;margin:0;padding:16px;background:#fafafa;color:#222}h1{font-size:22px}
.strip{display:flex;flex-wrap:wrap;gap:4px}img{width:64px;height:40px;background:#ddd;border-radius:4px}
.row{padding:6px 0;border-bottom:1px solid #eee;font-size:14px}.row b{color:#06c}.row i{color:#888}</style></head>
<body><h1>Heavy page</h1><p>Thirty-six images, a long document built by script, and rows fetched in chunks.</p>
<div class="strip">$images</div>
<div id="list"></div>
<script>
(function(){var list=document.getElementById('list'),i=0,total=$HEAVY_ROWS,chunks=$ROW_CHUNKS,built=false,fetched=false;
function row(n){var d=document.createElement('div');d.className='row';
d.innerHTML='<b>Row '+n+'</b> lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua <i>'+(n*7919%1000)+'</i>';return d;}
function chunk(){var frag=document.createDocumentFragment();for(var k=0;k<$ROWS_PER_FRAME&&i<total;k++,i++)frag.appendChild(row(i));
list.appendChild(frag);list.offsetHeight;if(i<total)requestAnimationFrame(chunk);else{built=true;done();}}
function next(n){if(n>=chunks){fetched=true;done();return;}
fetch('/rows/'+n).then(function(r){return r.json()}).then(function(rows){var frag=document.createDocumentFragment();
rows.forEach(function(t){frag.appendChild(row(t))});list.appendChild(frag);list.offsetHeight;next(n+1);}).catch(function(){next(n+1);});}
function done(){if(built&&fetched)document.title=${JSONObject.quote(DONE_TITLE)};}
requestAnimationFrame(chunk);next(0);})();
</script></body></html>"""
    }

    /** One small generated PNG (a tint and a number), a kilobyte or so: the load's network, not its raster. */
    private fun image(i: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(64, 40, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.HSVToColor(floatArrayOf((i * 37 % 360).toFloat(), 0.5f, 0.85f)))
        val text = Paint().apply { color = Color.WHITE; textSize = 22f; isAntiAlias = true }
        canvas.drawText("$i", 6f, 28f, text)
        val bytes = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        bitmap.recycle()
        return bytes.toByteArray()
    }

    companion object {
        private const val PORT = 18170
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val LIGHT_PATH = "/light"
        private const val HEAVY_PATH = "/heavy"
        private const val DONE_TITLE = "Heavy page (tab wake) - done"
        private const val HEAVY_IMAGES = 36
        private const val IMAGE_DELAY_MS = 500L
        /** The rows the page builds by script, [ROWS_PER_FRAME] an animation frame. */
        private const val HEAVY_ROWS = 3_600
        private const val ROWS_PER_FRAME = 60
        /** The row chunks fetched one after another, each answered [ROW_CHUNK_DELAY_MS] late. */
        private const val ROW_CHUNKS = 24
        private const val ROWS_PER_CHUNK = 50
        private const val ROW_CHUNK_DELAY_MS = 80L
        private const val START_TAB = "tab_article"
        private const val LOAD_TIMEOUT_MS = 30_000L
        private const val LOADED_SETTLE_MS = 1_500L
        private const val POLL_MS = 100L
        /** The most the `switch` window runs after the tap when the page view's show is not seen. */
        private const val SWITCH_CAP_MS = 2_500L
        /** How long after the page view's show the way out begins: the page is up and still loading. */
        private const val OUT_AFTER_SHOW_MS = 300L
        /** How long the back scene waits for the page's history to be behind it before the gesture. */
        private const val BACK_READY_MS = 3_000L
        /** The way out's window: the gesture and its spring. */
        private const val OUT_WINDOW_MS = 1_500L
        /** How long a sleeping scene waits for the host's spare after the overview came to rest. */
        private const val SPARE_WAIT_MS = 4_000L
        /** The most `TabHost.create` may hold the UI thread with the spare, in ms. */
        private const val CREATE_CAP_MS = 5.0
        private val READINGS = listOf("own", "ui", "total")
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
