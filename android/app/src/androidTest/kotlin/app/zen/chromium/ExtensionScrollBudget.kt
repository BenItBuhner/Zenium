package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The extension runtime's frame budget on a device: the same long fixture page (`scroll.html` on
 * the runtime demo's fixture server) flung and dragged for a fixed distance under
 * [measureFrames] with no extension attached, with three (uBlock Origin Lite, Dark Reader,
 * Vimium) and with six (plus Grammarly, LanguageTool, Bitwarden), every scene traced and read
 * against the empty scroll (`baseline = ext-scroll-0`), so the ratios say what the runtime adds
 * to a scroll's frames – content-script injection, bridge traffic, badge and state pushes – on
 * the recipe the run happens to be on (the emulator's software GPU; the ratios and the trace's
 * main-thread time carry, the raw frame times do not). A fourth scene scrolls the emptied page
 * again at the end (`ext-scroll-0-again`, reported against the first): the recipe's own drift
 * over the run, so a ratio can be told from the emulator warming or tiring.
 *
 * The six are laid out as store installs from what the workflow pushed (see [ExtensionSeed]) and
 * registered DISABLED; each scene turns its set on through `extension.setEnabled`, waits for the
 * runtime to configure the units and start the backgrounds, closes the tabs their first start
 * opened, reloads the fixture so the content scripts meet the document at its start, and reads
 * the debug bootstrap's `__zenExtStats` of every world before the finger lands. Around the block
 * the bridge's counters (`Extensions.bridgeCounts`: frames to host, host to chrome, host to
 * frames) give the messages the runtime moved during the scroll, per second, and the bridge trace
 * says which extension moved them and what they were.
 *
 * Findings: `frames.jsonl` / `frames.txt` and the traces from [measureFrames] (the workflow's
 * jank report renders them), `budget.json` (the bridge numbers, the worlds' stats, the memory and
 * what was attached, per scene) and `findings.txt` (the same for a reader), with a still per
 * scene. Nothing is judged here beyond the budget's own verdicts: the numbers are the baseline
 * the rounds after this one compare against.
 */
@RunWith(AndroidJUnit4::class)
class ExtensionScrollBudget : DemoHarness("ext-scroll-state.json", "ext-scroll", "ext-budget") {
    override val tag = TAG
    private val host: Host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val record = JSONObject()
    private val scenes = JSONArray()
    /** The ids laid out as installs (id to version directory) and the ones the workflow did not push. */
    private val installed = LinkedHashMap<String, File>()
    private val missing = ArrayList<String>()
    /** The ids attached (enabled) right now, as this driver last asked. */
    private val attached = LinkedHashSet<String>()
    private var worlds = false
    private var shots = 0

    @Test
    fun record() {
        try {
            runDemo()
        } finally {
            record.put("scenes", scenes)
            record.put("missing", JSONArray(missing))
            record.put("frameScenes", JSONArray(frameScenes.map { JSONObject(it.toJson()) }))
            File(out, "budget.json").writeText(record.toString(2))
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    // --- setup -------------------------------------------------------------------------------------

    /**
     * The six as store installs with a registry that has them all DISABLED: the runtime attaches
     * nothing on start, and the scenes turn their sets on. What the workflow did not push (a fetch
     * that failed) is written down and the scene runs with the rest.
     */
    override fun seedMore(zen: File) {
        val root = File(zen, "extensions").apply { mkdirs() }
        val records = JSONArray()
        for (id in ALL) {
            val dir = File(root, id)
            val versionDir = if (dir.isDirectory) ExtensionSeed.layOutInstall(dir) else null
            val manifest = versionDir?.let { runCatching { JSONObject(File(it, "manifest.json").readText()) }.getOrNull() }
            if (versionDir == null || manifest == null) {
                missing += id
                continue
            }
            records.put(ExtensionSeed.record(id, versionDir, manifest, enabled = false))
            installed[id] = versionDir
        }
        File(zen, "extensions.json").writeText(ExtensionSeed.registry(records).toString())
    }

    override fun warmUp() {
        ensureForeground()
        instrumentation.runOnMainSync { worlds = host.extensions.isolatedWorlds }
        val webView = WebViewCompat.getCurrentWebViewPackage(app)?.let { "${it.packageName} ${it.versionName}" } ?: "unknown"
        record.put("webView", webView)
        record.put("isolatedWorlds", worlds)
        record.put("jankGate", jankGate.key)
        record.put("installed", JSONObject().also { o -> installed.forEach { (id, dir) -> o.put(id, dir.name) } })
        record.put("window", JSONObject().put("width", width).put("height", height).put("density", density.toDouble()))
        finding("Zenium extension runtime frame budget: WebView $webView, isolated worlds $worlds, ${width}x$height at density $density, gate ${jankGate.key}")
        if (missing.isNotEmpty()) finding("not pushed by the workflow (the scenes run without them): ${missing.joinToString()}")
        val state = coreState()
        check(state.getJSONObject("capabilities").getBoolean("extensions")) { "the Android host must turn the extension capability on" }
        awaitLoaded(FIXTURE)
        SystemClock.sleep(2_000)
        // The touch pipeline paid for off the record: a drag down the page and back up (the page
        // is off its top when the second finger lands, so no pull-to-refresh), then the top again.
        drag(height * 0.62f, -160f * density, 400)
        SystemClock.sleep(700)
        drag(height * 0.45f, 220f * density, 400)
        SystemClock.sleep(700)
        pageTop()
        finding("warm-up done: page ${pageNumber("document.scrollingElement.scrollHeight")} CSS px tall, viewport ${pageNumber("window.innerHeight")} CSS px, bar hide ${hideValue()}")
    }

    override fun demo() {
        scene(SCENE_0, emptySet(), baseline = null)
        scene(SCENE_3, THREE, baseline = SCENE_0)
        scene(SCENE_6, SIX, baseline = SCENE_0)
        scene(SCENE_0_AGAIN, emptySet(), baseline = SCENE_0)
    }

    // --- one scene ---------------------------------------------------------------------------------

    /**
     * Attach exactly `wanted`, reload the fixture, then the fixed motion under [traceFrames] with
     * the bridge's counters read at the block's edges, and everything about it written down.
     */
    private fun scene(name: String, wanted: Set<String>, baseline: String?) {
        val entry = JSONObject().put("scene", name).put("wanted", JSONArray(wanted.toList()))
        scenes.put(entry)
        finding("")
        finding("== $name: ${if (wanted.isEmpty()) "no extension" else wanted.joinToString { NAMES[it] ?: it }}")
        val attachMs = attach(wanted, entry)
        finding("[$name] attached ${attached.joinToString { NAMES[it] ?: it }.ifEmpty { "nothing" }} in $attachMs ms; backgrounds up: ${backgroundsUp().joinToString { NAMES[it] ?: it }.ifEmpty { "none" }}")
        closeStrayTabs(entry)
        reloadFixture(entry)
        entry.put("worldsBefore", worldStats())
        pageTop()
        settleBar()
        SystemClock.sleep(1_200)
        awaitShots()
        val before = LongArray(3)
        val after = LongArray(3)
        var t0 = 0L
        var t1 = 0L
        val scrollBefore = pageNumber("Math.round(document.scrollingElement.scrollTop)")
        val result = traceFrames(name, JankBudget.Kind.GESTURE, baseline = baseline) {
            // Two reads of three longs on the main thread, at the block's edges: not frames' work.
            instrumentation.runOnMainSync { host.extensions.bridgeCounts().copyInto(before) }
            t0 = SystemClock.uptimeMillis()
            motion()
            instrumentation.runOnMainSync { host.extensions.bridgeCounts().copyInto(after) }
            t1 = SystemClock.uptimeMillis()
        }
        val scrollAfter = pageNumber("Math.round(document.scrollingElement.scrollTop)")
        shot("${++shots}".padStart(2, '0') + "-$name")
        val seconds = (t1 - t0).coerceAtLeast(1) / 1000.0
        val fromFrames = after[0] - before[0]
        val toChrome = after[1] - before[1]
        val toFrames = after[2] - before[2]
        val total = fromFrames + toFrames
        val bridge = JSONObject()
            .put("windowMs", t1 - t0)
            .put("fromFrames", fromFrames)
            .put("toChrome", toChrome)
            .put("toFrames", toFrames)
            .put("total", total)
            .put("perSecond", round1(total / seconds))
            .put("toChromePerSecond", round1(toChrome / seconds))
        entry.put("bridge", bridge)
        entry.put("perExtension", bridgeByExtension(t0, t1))
        entry.put("worldsAfter", worldStats())
        entry.put("scrollTop", JSONObject().put("before", scrollBefore).put("after", scrollAfter))
        entry.put("frames", JSONObject(result.toJson()))
        entry.put("memoryKb", meminfo())
        val s = result.summary
        finding(
            "[$name] frames ${s?.frames ?: 0}, janky ${s?.janky ?: 0} (${percent(s?.jankyShare ?: 0.0)}), p50/p95/p99 ${s?.p50Ms ?: 0}/${s?.p95Ms ?: 0}/${s?.p99Ms ?: 0} ms, " +
                "long stage ${result.analysis.dominant ?: "-"}, ${result.durationMs} ms; scrolled $scrollBefore -> $scrollAfter CSS px"
        )
        finding(
            "[$name] bridge over ${t1 - t0} ms: $fromFrames frames->host, $toChrome host->chrome, $toFrames host->frames; " +
                "${round1(total / seconds)} msgs/s (frames and host both ways), ${round1(toChrome / seconds)} chrome events/s"
        )
        result.trace?.let { t ->
            val perFrame = t.frameMs?.let { "p95 ${round1(it.p95Ms)} ms (mean ${round1(it.meanMs)}, max ${round1(it.maxMs)})" } ?: "no per-frame time"
            finding("[$name] trace: ${t.frames} main-thread frames, $perFrame, busy ${round1(t.busyMs)} of ${round1(t.windowMs)} ms, script ${round1(t.scriptMs)} ms, layouts ${t.layoutCount}, paints ${t.paintCount}, style recalcs ${t.styleRecalcCount}, long tasks ${t.longTasks} (longest ${round1(t.longestTaskMs)} ms)")
        } ?: finding("[$name] trace: none (${result.traceMissing})")
        finding("[$name] verdict ${if (result.verdict.within) "within" else "over"}${result.ratio?.let { " (${it.describe()})" } ?: ""}${result.verdict.breaches.takeIf { it.isNotEmpty() }?.let { ": " + it.joinToString("; ") } ?: ""}")
        val perExt = entry.getJSONObject("perExtension")
        for (id in perExt.keys()) {
            val e = perExt.getJSONObject(id)
            finding("[$name]   ${NAMES[id] ?: id}: ${e.optInt("fromFrames")} up, ${e.optInt("toFrames")} down; ${e.optJSONObject("kinds")}")
        }
    }

    /**
     * The fixed motion of every scene, about six and a half seconds: a fling down the page and
     * its decay, a slow drag down, a second fling, a slow drag part of the way back up. The
     * fingers land below the sticky header and above the bar, on the page's text.
     */
    private fun motion() {
        val x = width * 0.5f
        Finger().apply {
            down(x, height * 0.62f)
            moveBy(0f, -FLING_DP * density, FLING_MS)
            up()
        }
        SystemClock.sleep(FLING_SETTLE_MS)
        Finger().apply {
            down(x, height * 0.62f)
            moveBy(0f, -DRAG_DP * density, DRAG_MS)
            up()
        }
        SystemClock.sleep(DRAG_SETTLE_MS)
        Finger().apply {
            down(x, height * 0.62f)
            moveBy(0f, -FLING_DP * density, FLING_MS)
            up()
        }
        SystemClock.sleep(FLING_SETTLE_MS)
        Finger().apply {
            down(x, height * 0.35f)
            moveBy(0f, BACK_DP * density, DRAG_MS)
            up()
        }
        SystemClock.sleep(DRAG_SETTLE_MS)
    }

    // --- attaching ---------------------------------------------------------------------------------

    /**
     * Turn the six on or off so that exactly `wanted` (of what was pushed) is attached, and wait
     * for the runtime to have configured every one turned on (its units compiled: `configureStats`)
     * and dropped every one turned off, then for their backgrounds to be up (an MV3 worker
     * starts on attach). Returns the milliseconds it took.
     */
    private fun attach(wanted: Set<String>, entry: JSONObject): Long {
        val started = SystemClock.uptimeMillis()
        val on = wanted.filter { it in installed }
        val changes = JSONArray()
        for (id in installed.keys) {
            val enable = id in on
            if ((id in attached) == enable) continue
            val outcome = runCatching { coreInvoke("extension.setEnabled", """{"id":${JSONObject.quote(id)},"enabled":$enable}""") }
            changes.put(JSONObject().put("id", id).put("enabled", enable).put("result", outcome.getOrElse { "error: $it" }))
            if (enable) attached += id else attached -= id
        }
        entry.put("changes", changes)
        val configured = waitFor(CONFIGURE_MS) {
            var stats: Set<String> = emptySet()
            instrumentation.runOnMainSync { stats = host.extensions.configureStats.keys.toSet() }
            if (on.all { it in stats } && installed.keys.none { it !in on && it in stats }) true else null
        }
        entry.put("configured", configured == true)
        if (configured != true) finding("the runtime had not configured exactly ${on.joinToString()} after $CONFIGURE_MS ms")
        for (id in on) {
            val up = waitFor(BACKGROUND_MS) { if (backgroundView(id)) true else null }
            if (up != true) finding("${NAMES[id] ?: id}: no background view after $BACKGROUND_MS ms (an MV3 worker may have idled out already, or never started)")
        }
        // Their first start acts on install (`onInstalled`: onboarding tabs, storage); let it land.
        SystemClock.sleep(if (changes.length() > 0) 4_000 else 500)
        val ms = SystemClock.uptimeMillis() - started
        entry.put("attachMs", ms)
        entry.put("backgroundsUp", JSONArray(backgroundsUp()))
        return ms
    }

    private fun backgroundView(id: String): Boolean {
        var up = false
        instrumentation.runOnMainSync { up = host.extensions.backgroundView(id) != null }
        return up
    }

    private fun backgroundsUp(): List<String> = installed.keys.filter { backgroundView(it) }

    /**
     * Every tab but the fixture's goes (an extension's onboarding page loading from the network
     * would compete with the scroll for the emulator's CPU), once the tab list has held still
     * for two seconds, and the fixture is made the active tab again.
     */
    private fun closeStrayTabs(entry: JSONObject) {
        var last = -1
        var since = SystemClock.uptimeMillis()
        val deadline = since + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val count = coreState().optJSONObject("tabs")?.length() ?: 0
            if (count != last) {
                last = count
                since = SystemClock.uptimeMillis()
            } else if (SystemClock.uptimeMillis() - since >= 2_000) break
            SystemClock.sleep(500)
        }
        val tabs = coreState().optJSONObject("tabs") ?: JSONObject()
        val closed = JSONArray()
        for (tabId in tabs.keys().asSequence().toList()) {
            if (tabId == TAB_ID) continue
            val url = tabs.optJSONObject(tabId)?.optString("url") ?: ""
            runCatching { coreInvoke("tab.close", """{"tabId":${JSONObject.quote(tabId)},"force":true}""") }
            closed.put(url)
        }
        entry.put("closedTabs", closed)
        if (closed.length() > 0) finding("closed ${closed.length()} tab(s) the extensions opened: $closed")
        runCatching { coreInvoke("tab.activate", """{"tabId":${JSONObject.quote(TAB_ID)}}""") }
        SystemClock.sleep(800)
    }

    /** Reload the fixture so the content scripts of the attached set meet the document at its start; wait for it. */
    private fun reloadFixture(entry: JSONObject) {
        val started = SystemClock.uptimeMillis()
        coreInvoke("tab.reload", """{"tabId":${JSONObject.quote(TAB_ID)}}""")
        SystemClock.sleep(600)
        awaitLoaded(FIXTURE)
        val complete = waitFor(30_000) { if (pageJs("document.readyState") == "\"complete\"") true else null }
        val images = pageNumber("Array.prototype.filter.call(document.images,function(i){return i.complete}).length")
        entry.put("reloadMs", SystemClock.uptimeMillis() - started)
        entry.put("readyStateComplete", complete == true)
        entry.put("imagesComplete", images)
        // Content scripts at idle and the extensions' first pass over the document (a dark mode's
        // image analysis, a form scan) land after the load; a moment for them.
        SystemClock.sleep(3_000)
    }

    // --- reads -------------------------------------------------------------------------------------

    /**
     * The debug bootstrap's `__zenExtStats` of every attached extension's world on the fixture:
     * with real isolated worlds through each world's reply proxy, in the `with` fallback the main
     * world's one object (the first unit's copy, which every unit of the world shares).
     */
    private fun worldStats(): JSONObject {
        val result = JSONObject()
        val read = "JSON.stringify(typeof __zenExtStats==='object'&&__zenExtStats?{applied:__zenExtStats.applied,groups:__zenExtStats.groups.length,bootMs:Math.round(__zenExtStats.bootMs*10)/10,bridge:__zenExtStats.bridge||null,errors:(__zenExtStats.errors||[]).length}:null)"
        if (worlds) {
            for (id in attached) {
                val raw = worldEval(id, read)
                result.put(id, raw?.let { runCatching { JSONObject(unquote(it)) }.getOrNull() } ?: JSONObject.NULL)
            }
        } else if (attached.isNotEmpty()) {
            val raw = pageJs(read)
            result.put("main", runCatching { JSONObject(unquote(raw)) }.getOrNull() ?: JSONObject.NULL)
        }
        return result
    }

    /**
     * The bridge trace's lines within `[t0, t1]` (uptime ms) per attached extension: how many
     * went up and down, and what they were (`t detail`, counted).
     */
    private fun bridgeByExtension(t0: Long, t1: Long): JSONObject {
        val result = JSONObject()
        for (id in attached) {
            var lines: List<String> = emptyList()
            instrumentation.runOnMainSync { lines = host.extensions.traceSnapshot(id) }
            val inWindow = lines.filter { line ->
                val at = line.substringBefore(' ').toLongOrNull() ?: return@filter false
                at in t0..t1
            }
            if (inWindow.isEmpty()) continue
            val kinds = HashMap<String, Int>()
            var up = 0
            var down = 0
            for (line in inWindow) {
                val fields = line.split(' ', limit = 4)
                if (fields.getOrNull(1) == ">") up++ else down++
                val kind = (fields.getOrNull(3) ?: "").let { rest -> rest.split(' ').take(2).joinToString(" ") }
                kinds[kind] = (kinds[kind] ?: 0) + 1
            }
            val top = JSONObject()
            kinds.entries.sortedByDescending { it.value }.take(8).forEach { top.put(it.key, it.value) }
            result.put(id, JSONObject().put("fromFrames", up).put("toFrames", down).put("kinds", top))
        }
        return result
    }

    /** PSS of the app's processes (the app itself and its WebView renderer) from a system-wide dump, KB. */
    private fun meminfo(): JSONObject {
        val text = shellCommand("dumpsys meminfo")
        val section = text.substringAfter("Total PSS by process:", "").substringBefore("Total PSS by OOM adjustment:")
        val result = JSONObject()
        var total = 0L
        for (line in section.lines()) {
            val m = Regex("""^\s*([\d,]+)K:\s+(\S+)\s+\(pid\s+(\d+)""").find(line) ?: continue
            val name = m.groupValues[2]
            if (!name.startsWith(app.packageName) && !name.contains("webview")) continue
            val kb = m.groupValues[1].replace(",", "").toLong()
            result.put(name, kb)
            total += kb
        }
        return result.put("total", total)
    }

    // --- the page ----------------------------------------------------------------------------------

    private fun drag(fromY: Float, dy: Float, durationMs: Long) {
        Finger().apply {
            down(width * 0.5f, fromY)
            moveBy(0f, dy, durationMs)
            up()
        }
    }

    /** The page at its top by script (a script's scroll moves no bar). */
    private fun pageTop() {
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(800)
    }

    /**
     * The bar shown before a scene: a bar left off its edge by a drag (the chrome hides it on a
     * scroll down the page and brings it back on a scroll up) is brought home by a short drag
     * down the page then a long one back up, and the page put back at its top.
     */
    private fun settleBar() {
        if (awaitHide(3_000) { it <= 0.005 }) return
        drag(height * 0.62f, -80f * density, 250)
        SystemClock.sleep(900)
        drag(height * 0.4f, 320f * density, 400)
        SystemClock.sleep(1_000)
        pageTop()
        if (!awaitHide(3_000) { it <= 0.005 }) finding("the bar rests at ${hideValue()}, not shown, before the scene")
    }

    private fun hideValue(): String {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-bar-hide').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "0" } ?: "0"
    }

    private fun awaitHide(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(hideValue().toDoubleOrNull() ?: 0.0)) return true
            SystemClock.sleep(120)
        }
        return settled(hideValue().toDoubleOrNull() ?: 0.0)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 60_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return
            SystemClock.sleep(250)
        }
        finding("gave up waiting for $url to load")
    }

    /** Evaluate in the fixture's WebView (its main world); the raw JSON-encoded result ("" when it never answered). */
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
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun pageNumber(code: String): Double = pageJs(code).toDoubleOrNull() ?: -1.0

    /** `script` in `ext`'s isolated world on the fixture (`Extensions.evalInWorld`); null without a world endpoint. */
    private fun worldEval(ext: String, script: String): String? {
        val latch = CountDownLatch(1)
        var value: String? = null
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID)
            if (view == null) {
                latch.countDown()
            } else {
                host.extensions.evalInWorld(view, ext, script) { raw ->
                    value = raw
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return value
    }

    /** A JSON-encoded string's text, or the input when it is not one. */
    private fun unquote(raw: String): String =
        if (raw.startsWith("\"")) runCatching { JSONTokener(raw).nextValue() as String }.getOrDefault(raw) else raw

    private fun <T> waitFor(timeoutMs: Long, stepMs: Long = 500, read: () -> T?): T? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(stepMs)
        }
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    private fun round1(v: Double): Double = Math.round(v * 10) / 10.0
    private fun percent(share: Double): String = "${Math.round(share * 1000) / 10.0}%"

    companion object {
        private const val TAG = "ExtScrollBudget"
        private const val BASE = "http://10.0.2.2:8765"
        private const val FIXTURE = "$BASE/scroll.html"
        private const val TAB_ID = "tab_scroll"
        const val SCENE_0 = "ext-scroll-0"
        const val SCENE_3 = "ext-scroll-3"
        const val SCENE_6 = "ext-scroll-6"
        const val SCENE_0_AGAIN = "ext-scroll-0-again"
        const val UBOL = "ddkjiahejlhfcafbddmgiahcphecmpfh"
        const val DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
        const val VIMIUM = "dbepggeogbaibhgnhhndojpepiihcmeb"
        const val GRAMMARLY = "kbfnbcaeplbcioakkpcpgfkobkghlhen"
        const val LANGUAGETOOL = "oldceeleldhonbafppcapldpdifcinji"
        const val BITWARDEN = "nngceckbapebfimnlniiiahkandclblb"
        val THREE = linkedSetOf(UBOL, DARK_READER, VIMIUM)
        val SIX = linkedSetOf(UBOL, DARK_READER, VIMIUM, GRAMMARLY, LANGUAGETOOL, BITWARDEN)
        val ALL = SIX
        val NAMES = mapOf(
            UBOL to "uBlock Origin Lite", DARK_READER to "Dark Reader", VIMIUM to "Vimium",
            GRAMMARLY to "Grammarly", LANGUAGETOOL to "LanguageTool", BITWARDEN to "Bitwarden"
        )
        /** The fixed motion, dp and ms: a fling's travel and speed, the slow drags' travel and time, the settles. */
        private const val FLING_DP = 300f
        private const val FLING_MS = 110L
        private const val FLING_SETTLE_MS = 1_600L
        private const val DRAG_DP = 320f
        private const val BACK_DP = 200f
        private const val DRAG_MS = 900L
        private const val DRAG_SETTLE_MS = 700L
        /** How long the runtime gets to configure a set (six extensions' units compile on the io thread) and to start a background. */
        private const val CONFIGURE_MS = 90_000L
        private const val BACKGROUND_MS = 30_000L
    }
}
