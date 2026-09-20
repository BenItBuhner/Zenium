package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import kotlin.math.abs

/**
 * Profiles the phone bar hiding on scroll (`lib/barHide.ts`, `BarHideGesture.kt`, PR #200) the
 * way a finger meets it – the performance program's PERF-1, measured, not guessed. Four scenes
 * of injected real touches on each of four pages, each scene framed by `dumpsys gfxinfo reset` /
 * `framestats`, cut out of one Perfetto trace of the device and one Chromium trace per page of
 * the WebViews themselves ([PerfCapture]), and counted in process ([ViewCounters], plus counters
 * planted in the chrome and the page):
 *
 *  1. `hide-drag`: a slow drag down the page that takes the bar off one to one under the finger
 *     and goes on scrolling with it hidden;
 *  2. `fling-hidden`: a fling down the page with the bar hidden;
 *  3. `return-drag`: a slow drag back up the page that brings the bar back one to one and goes
 *     on scrolling with it shown;
 *  4. `scroll-3s-hidden`: three seconds of continuous finger scroll with the bar hidden – the
 *     complaint itself ("micro stutters and lag scrolling with the toolbar hidden");
 *  5. `control-3s-off` (the loopback pages only): the same three seconds with Hide toolbar when
 *     scrolling turned off, so the cost of the feature reads against a scroll without it on the
 *     same emulator.
 *
 * The pages: the github.com repository page and a long article (Wikipedia's Web browser, the
 * mobile skin), each as a loopback copy served from this process for repeatability – taken with
 * `.github/scripts/android-perf-page-snapshot.mjs` on 2026-09-20, scripts stripped, stylesheets
 * inlined, nothing fetched – and each live from the network once, for the real thing. A page
 * that does not load in time is skipped and said so.
 *
 * Every number goes to `perf-scenes.json` (the scenes' windows in the traces' clocks, the
 * counters, the file names) and `findings.txt`; `gfx-<page>-<scene>.txt` is each scene's
 * `dumpsys gfxinfo` verbatim; `blink-<page>.json.gz` the page's Chromium trace; the workflow
 * script pulls the Perfetto trace. `.github/scripts/android-perf-analyze.py` turns them into the
 * table (frames, janky share, percentiles, the long stage, the chrome main thread's slices per
 * scene). Nothing is judged here: a profile is evidence, the driver of PR #200 (BarHideDemo)
 * keeps the claims. The chrome is read only outside the scenes' windows: a read is a script
 * evaluation in its renderer and would be a frame's worth of work of its own. Screenshots are
 * one per page, at its end, for the same reason.
 */
@RunWith(AndroidJUnit4::class)
class BarHidePerfDemo : DemoHarness("bar-hide-demo-state.json", "perf-bar-hide", "perf-bar-hide") {
    override val tag = "BarHidePerfDemo"

    private lateinit var server: DemoServer
    private lateinit var capture: PerfCapture
    private lateinit var counters: ViewCounters
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val record = JSONObject()
    private val pages = JSONArray()
    private var perfettoOn = false

    private class Page(val key: String, val url: String, val live: Boolean)

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("bar-hide-demo-page.html").toByteArray()),
                GITHUB_PATH to ("text/html; charset=utf-8" to pageFixture("github-repo")),
                ARTICLE_PATH to ("text/html; charset=utf-8" to pageFixture("article"))
            )
        ).also { it.start() }
        capture = PerfCapture(ui, app.packageName, tag)
        try {
            runDemo()
        } finally {
            finishCaptures()
            server.close()
            record.put("pages", pages)
            File(out, "perf-scenes.json").writeText(record.toString(2))
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    /** Somewhere on the page, clear of both bar positions. */
    private val pageX get() = width * 0.5f

    override fun warmUp() {
        capture.shell("cmd uimode night no")
        SystemClock.sleep(2_000)
        ensureForeground()
        finding("Zenium Android bar hide profile (${width}x$height, density $density, ${capture.webViewVersion()})")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_000)
        counters = ViewCounters(activity) { host.tabs.get(TAB_ID) }.also { it.attach() }
        // Pay for the touch pipeline off the record: a scroll down and back up, then the bar home.
        drag(-160f * density, 400)
        SystemClock.sleep(600)
        drag(220f * density, 400)
        SystemClock.sleep(600)
        settleBar(0.0, "warm-up")
        finding("chrome counters: ${installChromeCounters()}")
        record.put("package", app.packageName)
            .put("webview", capture.webViewVersion())
            .put("window", JSONObject().put("width", width).put("height", height).put("density", density.toDouble()))
            .put("barTravelCss", barTravel())
    }

    override fun demo() {
        perfettoOn = capture.perfettoAvailable() && capture.perfettoStart(PERFETTO_KEY, PERFETTO_FILE)
        record.put("perfetto", JSONObject().put("file", PERFETTO_FILE.substringAfterLast('/')).put("started", perfettoOn))
        finding("perfetto ${if (perfettoOn) "tracing to $PERFETTO_FILE" else "off"}")
        SystemClock.sleep(1_000)
        for (page in PAGES) runPage(page)
        finishCaptures()
    }

    private fun finishCaptures() {
        if (perfettoOn) {
            capture.perfettoStop(PERFETTO_KEY)
            perfettoOn = false
        }
        // A page's Chromium trace still on (the sequence threw inside a page) is landed all the same.
        val leftover = File(out, "blink-unfinished.json.gz")
        if (!capture.blinkStop(leftover, timeoutSeconds = 60)) leftover.delete()
    }

    // --- one page ----------------------------------------------------------------------------------

    private fun runPage(page: Page) {
        val json = JSONObject().put("key", page.key).put("url", page.url).put("live", page.live)
        pages.put(json)
        val loaded = loadPage(page.url, if (page.live) 45_000 else 20_000)
        json.put("loaded", loaded)
        if (!loaded) {
            finding("[${page.key}] ${page.url} did not load in time; its scenes are skipped")
            return
        }
        // A live page settles its own script and images first; a copy has nothing to wait for.
        SystemClock.sleep(if (page.live) 5_000 else 1_500)
        finding("[${page.key}] page counters: ${installPageCounters()}")
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(600)
        settleBar(0.0, "${page.key} start")
        json.put("scrollHeightCss", pageNumber("document.scrollingElement.scrollHeight"))
            .put("innerHeightCss", pageInnerHeight())
        finding("[${page.key}] loaded ${json.optInt("scrollHeightCss")} CSS px tall, viewport ${json.optInt("innerHeightCss")}, hide ${hideValue()}")

        val blinkFile = File(out, "blink-${page.key}.json.gz")
        val blink = capture.blinkStart(PerfCapture.BLINK_CATEGORIES)
        json.put("blink", if (blink) blinkFile.name else JSONObject.NULL)
        val scenes = JSONArray()
        json.put("scenes", scenes)
        try {
            scenes.put(scene(page, "hide-drag", before = { atTopWithBarShown() }) { slowHide() })
            scenes.put(scene(page, "fling-hidden", before = { ensureHidden(); ensureRoom() }) { fling() })
            scenes.put(scene(page, "return-drag", before = { ensureHidden(); ensureRoom() }) { returnDrag() })
            scenes.put(scene(page, "scroll-3s-hidden", before = { ensureHidden(); ensureRoom() }) { longScroll() })
            if (!page.live) {
                setHideOnScroll(false)
                settleBar(0.0, "${page.key} control")
                scenes.put(scene(page, "control-3s-off", before = { ensureRoom() }) { longScroll() })
                setHideOnScroll(true)
            }
        } finally {
            if (blink) capture.blinkStop(blinkFile)
        }
        shot("${page.key}-end")
    }

    /**
     * One scene: `before` puts the page and the bar where the scene starts (outside the window),
     * then the counters are zeroed and the frame stats reset, the window opens, `gesture` runs
     * with its own tail (the spring after the finger lifts is part of the scene), the window
     * closes, and everything is read. Nothing reads the chrome or the page inside the window.
     */
    private fun scene(page: Page, name: String, before: () -> Unit, gesture: () -> Unit): JSONObject {
        before()
        awaitShots()
        SystemClock.sleep(1_200)
        val hideBefore = hideNumber()
        val innerBefore = pageInnerHeight()
        val scrollBefore = pageScrollTop()
        resetChromeCounters()
        resetPageCounters()
        counters.reset()
        capture.gfxReset()
        SystemClock.sleep(400)

        val label = "${page.key}/$name"
        val cookie = capture.sceneBegin(label)
        val startBoot = capture.nowBoot()
        val startMono = capture.nowMono()
        gesture()
        val endBoot = capture.nowBoot()
        val endMono = capture.nowMono()
        capture.sceneEnd(label, cookie)

        val gfx = capture.gfxFrameStats()
        val gfxFile = File(out, "gfx-${page.key}-$name.txt")
        gfxFile.writeText(gfx)
        val views = counters.snapshot()
        val chrome = readChromeCounters()
        val pageCounts = readPageCounters()
        val hideAfter = hideNumber()
        val innerAfter = pageInnerHeight()
        val scrollAfter = pageScrollTop()
        val summary = gfxSummary(gfx)
        finding(
            "[$label] ${summary.optInt("frames")} frames, ${summary.optInt("janky")} janky (${summary.optString("jankyPercent")}%), " +
                "50/90/95/99th ${summary.optInt("p50")}/${summary.optInt("p90")}/${summary.optInt("p95")}/${summary.optInt("p99")} ms; " +
                "window ${(endBoot - startBoot) / 1_000_000} ms; ui layouts ${views["layouts"]}, draws ${views["draws"]}, page bounds changes ${views["pageBounds"]}; " +
                "chrome barScroll ${chrome.optInt("barScroll")}, root style writes ${chrome.optInt("styleWrites")}, data-bar-hidden flips ${chrome.optInt("hiddenFlips")}, " +
                "host frames ${chrome.opt("hostFrames") ?: "?"}; page resizes ${pageCounts.optInt("resizes")}, scroll events ${pageCounts.optInt("scrolls")}, " +
                "innerHeight $innerBefore -> $innerAfter, scrollTop $scrollBefore -> $scrollAfter, hide $hideBefore -> $hideAfter"
        )
        return JSONObject()
            .put("name", name)
            .put("startBootNs", startBoot).put("endBootNs", endBoot)
            .put("startMonoUs", startMono).put("endMonoUs", endMono)
            .put("gfx", gfxFile.name)
            .put("gfxSummary", summary)
            .put("views", JSONObject(views))
            .put("chrome", chrome)
            .put("page", pageCounts)
            .put("hideBefore", hideBefore).put("hideAfter", hideAfter)
            .put("innerHeightBefore", innerBefore).put("innerHeightAfter", innerAfter)
            .put("scrollTopBefore", scrollBefore).put("scrollTopAfter", scrollAfter)
    }

    // --- the gestures --------------------------------------------------------------------------------

    /** A slow drag down the page: the bar goes off one to one under the finger, then the page scrolls with it hidden. */
    private fun slowHide() {
        Finger().apply {
            down(pageX, height * 0.72f)
            moveBy(0f, -HIDE_DRAG_DP * density, HIDE_MS)
            hold(150)
            up()
        }
        SystemClock.sleep(TAIL_MS)
    }

    /** A fling down the page with the bar hidden; the tail lets the fling run out. */
    private fun fling() {
        Finger().apply {
            down(pageX, height * 0.70f)
            moveBy(0f, -FLING_DP * density, 90)
            up()
        }
        SystemClock.sleep(FLING_TAIL_MS)
    }

    /** A slow drag back up the page: the bar comes back one to one, then the page scrolls with it shown. */
    private fun returnDrag() {
        Finger().apply {
            down(pageX, height * 0.45f)
            moveBy(0f, RETURN_DRAG_DP * density, RETURN_MS)
            hold(150)
            up()
        }
        SystemClock.sleep(TAIL_MS)
    }

    /** Three seconds of continuous finger scroll down the page, most of the screen's height. */
    private fun longScroll() {
        Finger().apply {
            down(pageX, height * 0.84f)
            hold(60)
            moveBy(0f, -LONG_SCROLL_FRACTION * height, LONG_SCROLL_MS)
            up()
        }
        SystemClock.sleep(TAIL_MS)
    }

    // --- preconditions ---------------------------------------------------------------------------------

    private fun atTopWithBarShown() {
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(700)
        settleBar(0.0, "before the hide")
    }

    /** The bar off its edge; a short drag takes it there when it is not. */
    private fun ensureHidden() {
        if (hideNumber() >= 0.995) return
        drag(-200f * density, 350)
        if (!awaitHide(4_000) { it >= 0.995 }) finding("the bar did not hide for the next scene (hide ${hideValue()}); chrome ${chromeBarHide()}")
        SystemClock.sleep(600)
    }

    /** Enough page left below for the longest scroll; a script's scroll back up moves no bar. */
    private fun ensureRoom() {
        val needed = (LONG_SCROLL_FRACTION * height / density * 1.3f).toInt() + 200
        if (pageRemaining() >= needed) return
        pageJs("window.scrollTo(0, Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight - $needed - 400))")
        SystemClock.sleep(700)
        finding("scrolled back up by script for room: ${pageRemaining()} CSS px left")
    }

    private fun setHideOnScroll(on: Boolean) {
        coreInvoke("settings.update", "{\"hideToolbarOnScroll\":$on}")
        SystemClock.sleep(1_000)
        finding("hideToolbarOnScroll set to $on: chrome ${chromeBarHide()}")
    }

    // --- moves (as in BarHideDemo) -----------------------------------------------------------------------

    private fun drag(dy: Float, durationMs: Long) {
        Finger().apply {
            down(pageX, height * 0.45f)
            moveBy(0f, dy, durationMs)
            up()
        }
    }

    private fun toTop() {
        drag(-80f * density, 250)
        SystemClock.sleep(900)
        drag(320f * density, 400)
        SystemClock.sleep(1_000)
    }

    private fun settleBar(target: Double, where: String) {
        val near = { v: Double -> abs(v - target) <= 0.005 }
        if (awaitHide(SETTLE_MS, near)) return
        finding("$where: the bar rests at ${hideValue()}, not $target; chrome ${chromeBarHide()}; dragging it ${if (target == 0.0) "back" else "off"}")
        if (target == 0.0) toTop() else drag(-320f * density, 500)
        if (!awaitHide(SETTLE_MS, near)) finding("$where: the bar still rests at ${hideValue()}; chrome ${chromeBarHide()}")
    }

    // --- counters planted in the chrome and the page ----------------------------------------------------

    /**
     * Counters in the chrome for what the hypotheses ask: how many `barScroll` reports the host
     * streamed in (a wrapper on `__zenHost.barScroll`), how many times the root's `style`
     * attribute was written (`--zen-bar-hide` per frame: a MutationObserver), how often
     * `data-bar-hidden` flipped, and – where the injected bridge object lets its `call` be
     * wrapped – how many `chrome.setBarHide` frames went back to the host.
     */
    private fun installChromeCounters(): String = chromeJs(
        "(function(){if(window.__perf)return 'kept';" +
            "var p=window.__perf={barScroll:0,styleWrites:0,hiddenFlips:0,hostFrames:0,wrapped:false};" +
            "var h=window.__zenHost;if(h&&typeof h.barScroll==='function'){var o=h.barScroll;h.barScroll=function(){p.barScroll++;return o.apply(this,arguments)}}" +
            "var n=window.__zenNative;if(n){try{var oc=n.call;var w=function(json){if(typeof json==='string'&&json.indexOf('chrome.setBarHide')>=0)p.hostFrames++;return oc.call(n,json)};" +
            "n.call=w;p.wrapped=(n.call===w)}catch(e){p.wrapError=String(e)}}" +
            "new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var a=rs[i].attributeName;if(a==='style')p.styleWrites++;else if(a==='data-bar-hidden')p.hiddenFlips++}})" +
            ".observe(document.documentElement,{attributes:true,attributeFilter:['style','data-bar-hidden']});" +
            "return 'installed, native call wrapped: '+p.wrapped})()"
    )

    private fun resetChromeCounters() {
        chromeJs("window.__perf&&Object.assign(window.__perf,{barScroll:0,styleWrites:0,hiddenFlips:0,hostFrames:0})")
    }

    private fun readChromeCounters(): JSONObject {
        val raw = chromeJs("JSON.stringify(window.__perf||{})")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONObject()
        val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        // Without a working wrapper the count says nothing: leave it out rather than report 0.
        if (!json.optBoolean("wrapped")) json.remove("hostFrames")
        return json
    }

    /** In the page: its `resize` events with the `innerHeight` each left, and its scroll events. */
    private fun installPageCounters(): String = pageJs(
        "(function(){if(window.__perf)return 'kept';var p=window.__perf={resizes:0,heights:[window.innerHeight],scrolls:0};" +
            "addEventListener('resize',function(){p.resizes++;if(p.heights.length<64)p.heights.push(window.innerHeight)});" +
            "addEventListener('scroll',function(){p.scrolls++},{passive:true});return 'installed'})()"
    )

    private fun resetPageCounters() {
        pageJs("window.__perf&&Object.assign(window.__perf,{resizes:0,heights:[window.innerHeight],scrolls:0})")
    }

    private fun readPageCounters(): JSONObject {
        val raw = pageJs("JSON.stringify(window.__perf||{})")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    // --- reads (outside the windows only) -------------------------------------------------------------------

    private fun hideValue(): String {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-bar-hide').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "(unset)" } ?: "(unset)"
    }

    private fun hideNumber(): Double = hideValue().toDoubleOrNull() ?: 0.0

    private fun awaitHide(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(hideNumber())) return true
            SystemClock.sleep(120)
        }
        return settled(hideNumber())
    }

    private fun barTravel(): Double {
        val raw = chromeJs("(((window.__zenStores||{})['bar-hide']||{get:function(){return {}}}).get()||{}).travel")
        return raw.toDoubleOrNull()?.takeIf { it > 0 } ?: 50.0
    }

    private fun chromeBarHide(): String {
        val raw = chromeJs("JSON.stringify(((window.__zenStores||{})['bar-hide']||{get:function(){return null}}).get())")
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    private fun pageNumber(code: String): Double = pageJs(code).toDoubleOrNull() ?: -1.0

    private fun pageInnerHeight(): Int = pageNumber("window.innerHeight").toInt()

    private fun pageScrollTop(): Int = pageNumber("Math.round(document.scrollingElement.scrollTop)").toInt()

    private fun pageRemaining(): Int =
        pageNumber("Math.round(document.scrollingElement.scrollHeight - window.innerHeight - document.scrollingElement.scrollTop)").toInt()

    /** Navigate the tab to `url` by script and wait for it; false when it did not finish in time. */
    private fun loadPage(url: String, timeoutMs: Long): Boolean {
        pageJs("location.href = ${JSONObject.quote(url)}")
        SystemClock.sleep(1_000)
        return awaitLoaded(url, timeoutMs)
    }

    /** The tab's view reports `url` (or a redirect on the same host) fully loaded. */
    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000): Boolean {
        val wanted = url.trimEnd('/')
        val hostName = runCatching { java.net.URI(url).host }.getOrNull() ?: ""
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID)
                val current = view?.url ?: ""
                last = "$current @ ${view?.progress}"
                loaded = view != null && view.progress == 100 &&
                    (current.trimEnd('/') == wanted || (hostName.isNotEmpty() && current.contains("://$hostName")))
            }
            if (loaded) return true
            SystemClock.sleep(250)
        }
        finding("gave up waiting for $url (view at $last)")
        return false
    }

    // --- gfxinfo's summary, for the findings ----------------------------------------------------------------

    /** The headline numbers of a `dumpsys gfxinfo` dump (the analysis script reads the rest). */
    private fun gfxSummary(dump: String): JSONObject {
        val json = JSONObject()
        fun int(label: String): Int? = Regex("$label: (\\d+)").find(dump)?.groupValues?.get(1)?.toIntOrNull()
        int("Total frames rendered")?.let { json.put("frames", it) }
        Regex("Janky frames: (\\d+) \\(([\\d.]+)%\\)").find(dump)?.let {
            json.put("janky", it.groupValues[1].toInt()).put("jankyPercent", it.groupValues[2])
        }
        for (p in listOf(50, 90, 95, 99)) {
            Regex("${p}th percentile: (\\d+)ms").find(dump)?.let { json.put("p$p", it.groupValues[1].toInt()) }
        }
        return json
    }

    /**
     * A page fixture kept gzipped in the tree (`perf/<name>.html.gz`). AAPT2 gunzips a `.gz`
     * asset as it packages it and drops the suffix, so the APK carries `perf/<name>.html` plain;
     * a packaging that left the file as it was is read through a gunzip instead.
     */
    private fun pageFixture(name: String): ByteArray {
        val assets = instrumentation.context.assets
        val plain = runCatching { assets.open("perf/$name.html") }.getOrNull()
        if (plain != null) return plain.use { it.readBytes() }
        return GZIPInputStream(assets.open("perf/$name.html.gz")).use { it.readBytes() }
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    companion object {
        private const val PORT = 18142
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB_ID = "tab_long"
        private const val GITHUB_PATH = "/github"
        private const val ARTICLE_PATH = "/article"
        private const val GITHUB_LIVE = "https://github.com/BenItBuhner/Zenium"
        private const val ARTICLE_LIVE = "https://en.m.wikipedia.org/wiki/Web_browser"
        private val PAGES = listOf(
            Page("github-loop", "$ORIGIN$GITHUB_PATH", live = false),
            Page("article-loop", "$ORIGIN$ARTICLE_PATH", live = false),
            Page("github-live", GITHUB_LIVE, live = true),
            Page("article-live", ARTICLE_LIVE, live = true)
        )
        private const val PERFETTO_KEY = "zenperf"
        private const val PERFETTO_FILE = "${PerfCapture.PERFETTO_DIR}/zen-perf-bar-hide.pftrace"
        private const val SETTLE_MS = 5_000L
        /**
         * The gestures, in dp and ms. The bar's travel is 50 CSS px past the 8 dp slop, so the
         * slow drags spend their first third moving the bar one to one and the rest scrolling
         * the page with it at rest; the fling is short and fast; the long scroll covers most of
         * the screen at a finger's reading pace.
         */
        private const val HIDE_DRAG_DP = 140f
        private const val HIDE_MS = 1_800L
        private const val FLING_DP = 200f
        private const val RETURN_DRAG_DP = 140f
        private const val RETURN_MS = 1_400L
        private const val LONG_SCROLL_FRACTION = 0.72f
        private const val LONG_SCROLL_MS = 3_000L
        /** After the finger lifts: the spring to the rest and whatever frames follow. */
        private const val TAIL_MS = 1_000L
        private const val FLING_TAIL_MS = 2_200L
    }
}
