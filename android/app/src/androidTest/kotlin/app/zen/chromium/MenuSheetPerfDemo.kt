package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.webkit.TracingConfig
import android.webkit.TracingController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.math.roundToInt

/**
 * The profiling driver of the performance program's PERF-2 item: the three-dot menu sheet,
 * measured rather than guessed. Real touches on the phone chrome (a finger on the bar's Menu
 * button, a press on the scrim, a drag of the grabber between the detents) over two content
 * pages served from this process's loopback server – a copy of github.com's repository page
 * (server HTML and CSS, scripts stripped) and a long article (six chapters of a public-domain
 * novel) – plus one pass over the real github.com when the emulator has a network.
 *
 * Scenes (each `cycles` times, ten by default):
 *  - `<page>-open-close`: tap Menu, the sheet comes up; tap the scrim, it goes.
 *  - `<page>-drag`: with the menu up, the grabber dragged to the expanded detent and back.
 *
 * What is captured, per scene, into the handshake directory (the workflow pulls it):
 *  - `framestats-<scene>.txt`: `dumpsys gfxinfo <app> reset` before the scene, `framestats` after
 *    every settled half-cycle (the profile ring holds 120 frames) and at the end, concatenated:
 *    HWUI's frames, its janky count and percentiles, and the per-frame stage columns.
 *  - `webview-<scene>.json.gz`: the chrome WebView's own Chromium trace for the scene through
 *    `android.webkit.TracingController` (blink, cc, v8, the scheduler, input and the DevTools
 *    timeline categories): the chrome renderer's main thread frame by frame – style recalc,
 *    layout, paint, script – and the compositor.
 *  - `chrome-<scene>.json.txt`: what a probe in the chrome saw (test-only, put in from here):
 *    every pointer down / up, one sample per animation frame of the inline `--zen-recede` while
 *    a sheet is on the way, long tasks, and the Event Timing entries.
 *  - `scenes.txt`: each scene's clocks (CLOCK_BOOTTIME for the Perfetto trace, CLOCK_MONOTONIC
 *    for the WebView trace) so the readers can cut the traces without markers.
 * One Perfetto system trace spans all the scenes (`sched gfx view input wm am binder_driver
 * dalvik` and the SurfaceFlinger frame timeline), started from here when the workflow has left
 * its config at `/data/local/tmp/menu-perf.pbtxt`, with `Trace.beginAsyncSection` marks per
 * scene and per half-cycle from this process (the `app` atrace category).
 *
 * The scenes run in the warm-up, before the recorder rolls: `screenrecord` composes a second
 * copy of every frame on the emulator's software GPU and would be measured too. The recorded
 * sequence is one open, one drag up and down, and a press on the scrim: the media. Driven by
 * the `android-menu-perf` workflow; see [DemoHarness] for the plumbing.
 *
 * Instrumentation arguments: `cycles` (default 10), `live` (`0` skips the real-network pass),
 * `webviewTrace` and `perfetto` (`0` skips that capture).
 */
@RunWith(AndroidJUnit4::class)
class MenuSheetPerfDemo : DemoHarness("menu-perf-demo-state.json", "menu-perf", "menu-perf-demo") {
    override val tag = "MenuSheetPerfDemo"
    private val args = InstrumentationRegistry.getArguments()
    private val cycles = args.getString("cycles")?.toIntOrNull()?.coerceIn(1, 50) ?: 10
    private val livePass = args.getString("live") != "0"
    private val webviewTrace = args.getString("webviewTrace") != "0"
    private val perfetto = args.getString("perfetto") != "0"
    private lateinit var server: DemoServer
    private val findings = StringBuilder()
    private val scenes = StringBuilder()
    private val host get() = (activity as MainActivity).host
    private val pkg: String get() = app.packageName
    private var perfettoPid: String? = null
    private var cookie = 1
    /** Where the grabber was at the collapsed detent, for the drag back down. */
    private var restHandle: PointF? = null

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "menu-perf-findings.txt").writeText(findings.toString())
            File(out, "scenes.txt").writeText(scenes.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    /** The github.com copy at `/` (its assets under their own paths) and the article at `/article.html`. */
    private fun routes(): Map<String, Pair<String, ByteArray>> {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        for (line in readAsset("menu-perf/github/manifest.tsv").lines()) {
            val parts = line.split('\t')
            if (parts.size < 3) continue
            routes[parts[0]] = parts[1] to pageAsset("menu-perf/github/${parts[2]}")
        }
        routes["/article.html"] = "text/html; charset=utf-8" to pageAsset("menu-perf/article.html.gz")
        return routes
    }

    /**
     * The repository keeps the page copies gzipped (`.gz`); AAPT unpacks a `.gz` asset when it
     * packages the APK and drops the suffix, so the installed APK carries them plain (run
     * 35539898644 found `article.html`, never `article.html.gz`). Read the plain name, and the
     * gzipped one should the packaging ever leave them as they are.
     */
    private fun pageAsset(name: String): ByteArray {
        val assets = instrumentation.context.assets
        return try {
            assets.open(name.removeSuffix(".gz")).use { it.readBytes() }
        } catch (_: java.io.FileNotFoundException) {
            GZIPInputStream(assets.open(name)).use { it.readBytes() }
        }
    }

    // --- the scenes, before the camera ---------------------------------------------------------------

    override fun warmUp() {
        finding("Zenium Android menu sheet profile (${width}x$height, density $density, $cycles cycles, api ${Build.VERSION.SDK_INT})")
        finding("demo server: ${server.selfCheck()}")
        finding("webview: ${webViewVersion()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_500)
        installProbe()
        // The first sheet pays for layout and script compilation once, off the record.
        openMenu()
        closeMenu()
        SystemClock.sleep(1_000)

        perfettoStart()
        try {
            scene("github-open-close") { openCloseCycles("github-open-close") }
            scene("github-drag") { dragCycles("github-drag") }

            navigate("$ORIGIN/article.html")
            openMenu()
            closeMenu()
            scene("article-open-close") { openCloseCycles("article-open-close") }
            scene("article-drag") { dragCycles("article-drag") }

            if (livePass) {
                val live = navigate(LIVE_URL, timeoutMs = 60_000)
                if (live) {
                    SystemClock.sleep(4_000)
                    openMenu()
                    closeMenu()
                    scene("live-github-open-close") { openCloseCycles("live-github-open-close") }
                } else {
                    finding("live pass skipped: $LIVE_URL did not load (no network on this emulator?)")
                }
            }
        } finally {
            perfettoStop()
        }
        // Back to the loopback copy for the camera.
        navigate("$ORIGIN/")
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up (the scenes) done")
    }

    /** On camera: one open, the grabber up to the expanded detent and back, a press on the scrim. */
    override fun demo() {
        openMenu()
        SystemClock.sleep(1_200)
        shot("menu-up")
        dragUp()
        SystemClock.sleep(1_200)
        shot("menu-expanded")
        dragDown()
        SystemClock.sleep(1_200)
        closeMenu()
        SystemClock.sleep(1_500)
        shot("menu-closed")
    }

    private fun openCloseCycles(scene: String) {
        for (i in 1..cycles) {
            mark("open", i)
            val opened = openMenu()
            unmark("open", i)
            dumpFramestats(scene, "$i-open")
            if (!opened) {
                finding("$scene cycle $i: the menu did not come up; skipping the close")
                back()
                SystemClock.sleep(1_500)
                continue
            }
            SystemClock.sleep(500)
            mark("close", i)
            val closed = closeMenu()
            unmark("close", i)
            dumpFramestats(scene, "$i-close")
            if (!closed) finding("$scene cycle $i: the menu did not go on the scrim press")
            SystemClock.sleep(600)
        }
    }

    private fun dragCycles(scene: String) {
        if (!openMenu()) {
            finding("$scene: the menu did not come up; no drags")
            return
        }
        SystemClock.sleep(600)
        val pairs = (cycles / 2).coerceAtLeast(2)
        for (i in 1..pairs) {
            mark("drag-up", i)
            val up = dragUp()
            unmark("drag-up", i)
            dumpFramestats(scene, "$i-up")
            if (!up) {
                finding("$scene pair $i: the sheet did not reach the expanded detent (${recedeValue()})")
            }
            SystemClock.sleep(500)
            mark("drag-down", i)
            val down = dragDown()
            unmark("drag-down", i)
            dumpFramestats(scene, "$i-down")
            if (!down) {
                finding("$scene pair $i: the drag down did not land at the collapsed detent")
                if (!awaitSurface(up = true, timeoutMs = 500)) {
                    finding("$scene pair $i: the sheet went; opening it again")
                    SystemClock.sleep(1_000)
                    if (!openMenu()) return
                }
            }
            SystemClock.sleep(500)
        }
        closeMenu()
        dumpFramestats(scene, "close")
    }

    // --- the moves -----------------------------------------------------------------------------------

    /** A finger on the Menu button; true once the sheet is up and the recede has landed at 1. */
    private fun openMenu(): Boolean {
        val button = findByLabel(MENU_LABEL) ?: Rect((width - 52 * density).roundToInt(), (pillY - 22 * density).roundToInt(), (width - 8 * density).roundToInt(), (pillY + 22 * density).roundToInt())
        Finger().tap(button.exactCenterX(), button.exactCenterY())
        if (!awaitSurface(up = true, timeoutMs = 8_000)) return false
        return awaitRecede(SETTLE_MS) { it >= 0.995 }
    }

    /** A finger on the scrim above the sheet; true once the sheet has gone and the recede is back at 0. */
    private fun closeMenu(): Boolean {
        val insets = windowInsets()
        // Well above any detent of the menu and below the status bar: the page's upper third.
        Finger().tap(width * 0.5f, insets.top + (height - insets.top) * 0.22f)
        if (!awaitSurface(up = false, timeoutMs = 8_000)) return false
        val landed = awaitRecede(SETTLE_MS) { it <= 0.005 }
        // The live page comes back and its picture goes once the host has drawn it: part of the close.
        SystemClock.sleep(900)
        return landed
    }

    /** The grabber pulled up to the expanded detent (a real finger, released with some speed). */
    private fun dragUp(): Boolean {
        val handle = handle() ?: return false
        restHandle = handle
        val travel = 0.42f * height
        Finger().apply {
            down(handle.x, handle.y)
            moveBy(0f, -travel * 0.75f, 150)
            moveBy(0f, -travel * 0.25f, 120)
            up()
        }
        return awaitDetent(expanded = true)
    }

    /** The grabber pulled back down to the collapsed detent, decelerating so the release does not dismiss. */
    private fun dragDown(): Boolean {
        val from = handle() ?: return false
        val to = restHandle ?: PointF(from.x, from.y + 0.42f * height)
        val dy = to.y - from.y
        Finger().apply {
            down(from.x, from.y)
            moveBy(0f, dy * 0.8f, 160)
            moveBy(0f, dy * 0.2f, 220)
            hold(80)
            up()
        }
        return awaitDetent(expanded = false)
    }

    private fun handle(): PointF? =
        waitFor(MENU_HANDLE_LABEL, 3_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            // The tree lags the emulator; read the sheet's own box from the chrome.
            val raw = chromeJs("(function(){var s=document.querySelector('.zen-sheet');if(!s)return '';var r=s.getBoundingClientRect();return r.left+','+r.top+','+r.width})()")
            val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
            val parts = text.split(',').mapNotNull { it.toFloatOrNull() }
            if (parts.size == 3) PointF((parts[0] + parts[2] / 2) * density, (parts[1] + 14) * density) else null
        }

    /** Wait for the sheet's spring to land at the detent asked for: the chrome's word on its resting detent. */
    private fun awaitDetent(expanded: Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + SETTLE_MS
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            if (!chromeSurfaceUp()) return false
            val pose = sheetPose()
            if (pose != null && pose.second && pose.first == expanded) return true
        }
        return false
    }

    /**
     * (expanded, at rest) from the chrome: at rest when two frames' inline transforms agree; expanded
     * when the sheet's top is in the upper half of the layer.
     */
    private fun sheetPose(): Pair<Boolean, Boolean>? {
        val raw = chromeJs(
            "(function(){var s=document.querySelector('.zen-sheet');if(!s)return '';" +
                "var r=s.getBoundingClientRect();" +
                "return (r.top<window.innerHeight*0.5?1:0)+','+(window.__zenPerf&&window.__zenPerf.still()?1:0)})()"
        )
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        val parts = text.split(',')
        if (parts.size != 2) return null
        return (parts[0] == "1") to (parts[1] == "1")
    }

    // --- the chrome's word ---------------------------------------------------------------------------

    /** The inline `--zen-recede` on the chrome's root (what the chassis writes each frame): 0 when unset. */
    private fun recedeValue(): String {
        val raw = chromeJs("document.documentElement.style.getPropertyValue('--zen-recede')")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "0" } ?: "0"
    }

    private fun awaitRecede(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(recedeValue().toDoubleOrNull() ?: 0.0)) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /**
     * The probe in the chrome (test-only): pointer taps, one sample of the inline `--zen-recede` and
     * the sheet's inline transform per animation frame while a sheet is on the way (from the tap
     * until the value rests, so the frame intervals of the spring are on record), long tasks and
     * Event Timing entries. Reads inline styles only – nothing here forces a style pass.
     */
    private fun installProbe() {
        chromeJs(
            """(function(){if(window.__zenPerf)return;
var P=window.__zenPerf={scene:null,taps:[],motion:[],long:[],events:[],marks:[]};
var root=document.documentElement;var running=false;var quiet=0;var last='';
document.addEventListener('pointerdown',function(e){P.taps.push({t:performance.now(),k:'down',x:e.clientX,y:e.clientY});arm()},{capture:true,passive:true});
document.addEventListener('pointerup',function(e){P.taps.push({t:performance.now(),k:'up',x:e.clientX,y:e.clientY});arm()},{capture:true,passive:true});
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.long.push({t:e.startTime,d:e.duration})})}).observe({type:'longtask'})}catch(_){}
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.events.push({t:e.startTime,d:e.duration,n:e.name,p:e.processingStart-e.startTime,q:e.processingEnd-e.processingStart})})}).observe({type:'event',durationThreshold:16})}catch(_){}
function sample(t){var s=document.querySelector('.zen-sheet');var p=root.style.getPropertyValue('--zen-recede');var tr=s?s.style.transform:'';
var key=p+'|'+tr+'|'+(s?1:0);if(key===last)quiet++;else quiet=0;last=key;
P.motion.push({t:t,p:p===''?-1:+p,tr:tr,s:s?1:0});
if((s||quiet<24)&&P.motion.length<6000)requestAnimationFrame(sample);else running=false}
function arm(){if(running)return;running=true;quiet=0;requestAnimationFrame(sample)}
P.arm=arm;P.still=function(){return !running||quiet>=6};
P.begin=function(name){P.scene=name;P.taps=[];P.motion=[];P.long=[];P.events=[];P.marks=[];try{performance.mark('menu-perf:'+name+':start')}catch(_){}P.marks.push({t:performance.now(),n:name+':start'})};
P.mark=function(n){try{performance.mark('menu-perf:'+n)}catch(_){}P.marks.push({t:performance.now(),n:n})};
P.end=function(){try{performance.mark('menu-perf:'+P.scene+':end')}catch(_){}P.marks.push({t:performance.now(),n:P.scene+':end'});
return JSON.stringify({scene:P.scene,origin:performance.timeOrigin,taps:P.taps,motion:P.motion,long:P.long,events:P.events,marks:P.marks})};
})()"""
        )
    }

    private fun webViewVersion(): String {
        val raw = chromeJs("navigator.userAgent")
        return (JSONTokener(raw).nextValue() as? String).orEmpty().substringAfter("Chrome/").substringBefore(' ').ifEmpty { "?" }
    }

    // --- the captures --------------------------------------------------------------------------------

    private fun scene(name: String, body: () -> Unit) {
        finding("== scene $name")
        shell("dumpsys gfxinfo $pkg reset")
        File(out, "framestats-$name.txt").writeText("")
        chromeJs("window.__zenPerf&&window.__zenPerf.begin(${JSONObject.quote(name)})")
        val started = webviewTraceStart()
        val startBoot = SystemClock.elapsedRealtimeNanos()
        val startMono = System.nanoTime()
        val startUptime = SystemClock.uptimeMillis()
        traceAsync("menu-perf:$name", begin = true, cookie = cookie)
        try {
            body()
        } finally {
            traceAsync("menu-perf:$name", begin = false, cookie = cookie)
            cookie++
            val endBoot = SystemClock.elapsedRealtimeNanos()
            val endMono = System.nanoTime()
            scenes.append("$name $startBoot $endBoot $startMono $endMono\n")
            dumpFramestats(name, "end")
            val probe = chromeJs("window.__zenPerf?window.__zenPerf.end():''")
            val json = (JSONTokener(probe).nextValue() as? String).orEmpty()
            File(out, "chrome-$name.json.txt").writeText(json)
            if (started) webviewTraceStop("webview-$name.json.gz")
            finding("$name: ${(SystemClock.uptimeMillis() - startUptime) / 1000.0} s; probe ${json.length} chars")
        }
    }

    private fun dumpFramestats(scene: String, step: String) {
        val text = shell("dumpsys gfxinfo $pkg framestats")
        File(out, "framestats-$scene.txt").appendText("=== $scene $step ===\n$text\n")
    }

    private fun mark(kind: String, n: Int) {
        traceAsync("menu-perf:$kind", begin = true, cookie = 1000 + n)
        chromeJs("window.__zenPerf&&window.__zenPerf.mark(${JSONObject.quote("$kind:$n:start")})")
    }

    private fun unmark(kind: String, n: Int) {
        traceAsync("menu-perf:$kind", begin = false, cookie = 1000 + n)
        chromeJs("window.__zenPerf&&window.__zenPerf.mark(${JSONObject.quote("$kind:$n:end")})")
    }

    private fun traceAsync(name: String, begin: Boolean, cookie: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (begin) Trace.beginAsyncSection(name, cookie) else Trace.endAsyncSection(name, cookie)
    }

    private fun webviewTraceStart(): Boolean {
        if (!webviewTrace) return false
        var ok = false
        instrumentation.runOnMainSync {
            val controller = TracingController.getInstance()
            if (controller.isTracing) {
                finding("webview trace: a session was already running")
                ok = true
                return@runOnMainSync
            }
            val config = TracingConfig.Builder()
                .addCategories(WEBVIEW_CATEGORIES)
                .setTracingMode(TracingConfig.RECORD_CONTINUOUSLY)
                .build()
            try {
                controller.start(config)
                ok = true
            } catch (e: Exception) {
                finding("webview trace: start failed: $e")
            }
        }
        // The renderers take a moment to learn the categories.
        if (ok) SystemClock.sleep(600)
        return ok
    }

    private fun webviewTraceStop(name: String) {
        val file = File(out, name)
        val closed = CountDownLatch(1)
        val stream = object : GZIPOutputStream(FileOutputStream(file), 64 * 1024) {
            override fun close() {
                super.close()
                closed.countDown()
            }
        }
        var stopped = false
        instrumentation.runOnMainSync {
            stopped = TracingController.getInstance().stop(stream, Executors.newSingleThreadExecutor())
        }
        if (!stopped) {
            stream.close()
            finding("webview trace: nothing to stop for $name")
            return
        }
        if (!closed.await(90, TimeUnit.SECONDS)) finding("webview trace: $name did not finish writing in 90 s")
        finding("webview trace: $name ${file.length() / 1024} KB")
    }

    private fun perfettoStart() {
        if (!perfetto) return
        val config = "/data/local/tmp/menu-perf.pbtxt"
        val present = !shell("ls $config").contains("No such file")
        val command = if (present) {
            "perfetto --background --txt -c $config -o $TRACE_PATH"
        } else {
            // No config from the workflow: the lightweight atrace form, without the frame timeline.
            "perfetto --background -t 900s -o $TRACE_PATH --app $pkg sched gfx view input wm am binder_driver dalvik"
        }
        val output = shell(command).trim()
        perfettoPid = output.lines().lastOrNull { it.trim().toIntOrNull() != null }?.trim()
            ?: shell("pidof perfetto").trim().split(' ').firstOrNull { it.toIntOrNull() != null }
        finding("perfetto: ${if (present) "workflow config" else "lightweight atrace config"}, pid ${perfettoPid ?: "?"}: ${output.take(200)}")
    }

    private fun perfettoStop() {
        val pid = perfettoPid ?: return
        shell("kill -TERM $pid")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (SystemClock.uptimeMillis() < deadline && shell("pidof perfetto").trim().isNotEmpty()) SystemClock.sleep(300)
        SystemClock.sleep(500)
        finding("perfetto: ${shell("ls -l $TRACE_PATH").trim()}")
        perfettoPid = null
    }

    // --- pages ---------------------------------------------------------------------------------------

    /** Load `url` in the demo tab and wait for it; false when it did not finish in time. */
    private fun navigate(url: String, timeoutMs: Long = 25_000): Boolean {
        instrumentation.runOnMainSync {
            (host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull())?.loadUrl(url)
        }
        val loaded = awaitLoaded(url, timeoutMs)
        SystemClock.sleep(2_000)
        finding("page $url: ${if (loaded) "loaded" else "NOT loaded in time"}")
        return loaded
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 25_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull()
                val current = view?.url.orEmpty()
                loaded = view != null && view.progress == 100 &&
                    (current == url || current.removeSuffix("/") == url.removeSuffix("/"))
            }
            if (loaded) return true
            SystemClock.sleep(250)
        }
        return false
    }

    private fun finding(line: String) {
        findings.append(line).append('\n')
        Log.i(tag, line)
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val PORT = 18135
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB_ID = "tab_perf"
        private const val LIVE_URL = "https://github.com/BenItBuhner/Zenium"
        private const val TRACE_PATH = "/data/misc/perfetto-traces/menu-perf.perfetto-trace"
        /** The longest a spring is given to land on the emulator. */
        private const val SETTLE_MS = 8_000L
        private val WEBVIEW_CATEGORIES = listOf(
            "blink", "blink.user_timing", "cc", "v8", "renderer.scheduler", "input", "viz", "gpu",
            "devtools.timeline", "disabled-by-default-devtools.timeline",
            "disabled-by-default-devtools.timeline.frame",
            "disabled-by-default-devtools.timeline.invalidationTracking"
        )
    }
}
