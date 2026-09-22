package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.zip.GZIPInputStream
import kotlin.math.roundToInt

/**
 * The performance program's profile of the phone's whole-app motion (perf-program.md, PERF-5's
 * items after PERF-4's hand-over), one scene per motion, every scene through the harness's
 * [traceFrames] (HWUI's frame statistics, reported; the chrome WebView's own Chromium trace,
 * read into the renderer main thread's frames – its time per frame, its style / layout / paint
 * split, its long tasks – which is where a stutter of the chrome is made). Real touches on the
 * address pill over loopback copies of pages ([DemoServer]: github.com's repository page, a long
 * article, the bar-hide demo's page), the same pages in the same order every run, so a before
 * and an after compare on one recipe.
 *
 * THE TAB SWIPE on the pill (#27 / #84), in the pieces a finger makes of it:
 *
 *  - `tab-swipe-begin`: the touch comes down on the pill and crosses the slop; the chrome
 *    snapshots the live page (`overlay.snapshot`), decodes it into the current tab's card and
 *    the track appears in the page's place. The one long task of a swipe lives here.
 *  - `tab-swipe-hold`: the finger rests on the pill with the track up. What the stage costs
 *    per frame when nothing moves (a control for the drag).
 *  - `tab-swipe-drag`: the finger carries the track most of one card to the left between two
 *    loose tabs (no group ribbon on any card of the track). PERF-4's first hypothesis lives
 *    here: every move re-renders the stage's cards through React before their transforms are
 *    written.
 *  - `tab-swipe-release`: the lift; the snappy spring lands the track on the next tab, the
 *    core activates it, the live page returns.
 *  - `tab-swipe-fling`: a quick flick back, down to rest, in one scene: the way most swipes
 *    are made.
 *  - `tab-swipe-grouped-drag`: the drag again between two tabs of a group, whose cards wear
 *    the group's ribbon (`backdrop-filter` + an opacity that follows the finger: PERF-4's
 *    second hypothesis), read against `tab-swipe-drag`.
 *
 * The scenes are measured BEFORE the recorder rolls (screenrecord composes a second copy of
 * every frame on the emulator's software GPU); the recorded part is the media: the slow swipe,
 * the fling back, the grouped swipe. The scenes start after the app's startup sweep (Safe
 * Browsing's and the blocker's first twenty seconds), which would otherwise land in a window as
 * long tasks of the app's, not the swipe's.
 *
 * Beside the harness's numbers an in-chrome probe (a MutationObserver on the chrome's tree)
 * counts what each scene wrote to the DOM: the cards' style writes (one per card per frame
 * moved), the dim layers', the ribbons', the pill's (and the pill's remounts: its content is
 * keyed by the tab under the finger), the root's, and the nodes added and removed – the
 * attribution the trace's stripped arguments cannot give. Its counts go to `perf-motion.json`
 * and `findings.txt` in the findings, per scene, with the core's active tab before and after.
 */
@RunWith(AndroidJUnit4::class)
class MotionPerfDemo : DemoHarness("perf-motion-demo-state.json", "perf-motion", "perf-motion") {
    override val tag = "MotionPerfDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val scenes = JSONArray()
    private var launchedAt = 0L

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("bar-hide-demo-page.html").toByteArray()),
                "/github" to ("text/html; charset=utf-8" to pageFixture("github-repo")),
                "/article" to ("text/html; charset=utf-8" to pageFixture("article"))
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "perf-motion.json").writeText(
                JSONObject().put("package", app.packageName).put("theme", theme)
                    .put("window", JSONObject().put("width", width).put("height", height).put("density", density.toDouble()))
                    .put("scenes", scenes).toString(2)
            )
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    override fun beforeLaunch() {
        launchedAt = SystemClock.uptimeMillis()
    }

    // --- warm-up: the pictures, then the measured scenes ------------------------------------------

    override fun warmUp() {
        ensureForeground()
        finding("Zenium Android motion profile ($theme; ${width}x$height, density $density; ${webViewVersion()})")
        finding("demo server: ${server.selfCheck()}")
        // Every tab of the track visited and captured, so each card has its picture: a touch on
        // the pill that does not swipe snapshots the active page the way a swipe's first touch does.
        for (tabId in TRACK) {
            activate(tabId)
            touchWithoutGesture()
            settle()
        }
        activate(START_TAB)
        settle()
        finding("chrome probe: ${installProbe()}")
        // Pay for the touch pipeline off the record: one swipe there and back.
        flingLeft()
        settle()
        flingRight()
        settle()
        // The app's startup sweep (Safe Browsing's lists, the blocker's) is the app's long
        // tasks, not the swipe's: the scenes wait it out.
        val sinceLaunch = SystemClock.uptimeMillis() - launchedAt
        if (sinceLaunch < SWEEP_MS) {
            finding("waiting ${SWEEP_MS - sinceLaunch} ms for the startup sweep to pass")
            SystemClock.sleep(SWEEP_MS - sinceLaunch)
        }
        finding("active tab before the scenes: ${activeTabId()}")
        measureTabSwipe()
    }

    /** The recorded media: the slow swipe, the fling back, the grouped swipe. */
    override fun demo() {
        activate(START_TAB)
        settle()
        shot("swipe-rest")
        slowSwipe()
        SystemClock.sleep(RELEASE_MS)
        shot("swipe-landed")
        flingRight()
        settle()
        activate(GROUP_TAB)
        settle()
        shot("grouped-rest")
        slowSwipe()
        SystemClock.sleep(RELEASE_MS)
        shot("grouped-landed")
        settle()
    }

    // --- the tab swipe -----------------------------------------------------------------------------

    private fun measureTabSwipe() {
        val f = Finger()
        val before = activeTabId()
        // The begin: the touch, the slop, the capture, the track.
        scene("tab-swipe-begin", JankBudget.Kind.OPEN) {
            f.down(pill.right - 10f, pillY)
            f.settleIn(-NUDGE, 0f)
        }
        scene("tab-swipe-hold", JankBudget.Kind.GESTURE) { f.hold(HOLD_MS) }
        scene("tab-swipe-drag", JankBudget.Kind.GESTURE) {
            f.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
            f.hold(DRAG_TAIL_MS)
        }
        scene("tab-swipe-release", JankBudget.Kind.SPRING) {
            f.up()
            SystemClock.sleep(RELEASE_MS)
        }
        val after = activeTabId()
        val next = TRACK.getOrNull(TRACK.indexOf(before) + 1)
        finding("tab-swipe: $before -> $after (${if (after == next) "the next tab" else "NOT the next tab"})")

        // The fling back, whole.
        scene("tab-swipe-fling", JankBudget.Kind.SPRING) {
            flingRight()
            SystemClock.sleep(RELEASE_MS)
        }
        finding("tab-swipe-fling: $after -> ${activeTabId()} (${if (activeTabId() == before) "back" else "NOT back"})")

        // The grouped drag: the same drag between the two tabs of the group, their ribbons on.
        activate(GROUP_TAB)
        settle()
        val g = Finger()
        g.down(pill.right - 10f, pillY)
        g.settleIn(-NUDGE, 0f)
        scene("tab-swipe-grouped-drag", JankBudget.Kind.GESTURE, baseline = "tab-swipe-drag") {
            g.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
            g.hold(DRAG_TAIL_MS)
        }
        g.up()
        SystemClock.sleep(RELEASE_MS)
        finding("tab-swipe-grouped: $GROUP_TAB -> ${activeTabId()}")
    }

    /** The recorded slow swipe: down at the pill's right end, the slop, one card left, lift. */
    private fun slowSwipe() {
        val f = Finger()
        f.down(pill.right - 10f, pillY)
        f.settleIn(-NUDGE, 0f)
        f.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
        f.hold(DRAG_TAIL_MS)
        f.up()
    }

    /** One card's advance on the track in device px: the page's width plus the 16 CSS px gap (`CARD_GAP`). */
    private fun advance(): Float = width + 16f * density

    // --- one scene ---------------------------------------------------------------------------------

    /**
     * One traced scene: the probe's counters zeroed, the block under [traceFrames], the counters
     * read after it (never inside: a read of the chrome is work the app did not do for the user)
     * and written down with the scene's trace line.
     */
    private fun scene(name: String, kind: JankBudget.Kind, baseline: String? = null, block: () -> Unit): FrameStats.Scene {
        resetProbe()
        val activeBefore = activeTabId()
        val result = traceFrames(name, kind, baseline, block)
        val probe = readProbe()
        val json = JSONObject().put("scene", name).put("kind", kind.key).put("activeBefore", activeBefore).put("activeAfter", activeTabId())
            .put("probe", probe)
        result.trace?.let { json.put("trace", JSONObject(it.toJson())) }
        result.traceMissing?.let { json.put("traceMissing", it) }
        scenes.put(json)
        val frames = result.trace?.frames ?: 0
        val per = { key: String -> if (frames > 0) String.format(java.util.Locale.ROOT, "%.2f", probe.optInt(key) / frames.toDouble()) else "-" }
        finding(
            "[$name] ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}; probe: cards ${probe.optInt("card")} (${per("card")}/frame), " +
                "dims ${probe.optInt("dim")}, ribbons ${probe.optInt("ribbon")}, pill ${probe.optInt("pill")} (remounts ${probe.optInt("pillRemounts")}), " +
                "root ${probe.optInt("root")}, other ${probe.optInt("other")}, nodes +${probe.optInt("added")}/-${probe.optInt("removed")}, stage mounts ${probe.optInt("stageMounts")}"
        )
        return result
    }

    // --- the chrome's probe ---------------------------------------------------------------------

    /**
     * A MutationObserver over the chrome's tree, counting the inline style writes by their target
     * – the stage's cards, its dim layers, the group ribbons, the pill, the root – and the nodes
     * added and removed (the stage's mount, the pill's remount when the tab under the finger
     * changes). Style writes alone (`attributeFilter`): a class change is not a per-frame thing
     * here. Installed once; reset per scene.
     */
    private fun installProbe(): String = chromeJs(
        "(function(){if(window.__motion)return 'kept';" +
            "var p=window.__motion={card:0,dim:0,ribbon:0,pill:0,root:0,other:0,added:0,removed:0,stageMounts:0,pillRemounts:0};" +
            "var inPill=function(n){return !!(n&&n.closest&&n.closest('.zen-phone-pill'))};" +
            "var isStage=function(n){return n.nodeType===1&&(n.classList.contains('zen-stage-card')||(n.querySelector&&!!n.querySelector('.zen-stage-card')))};" +
            "new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var r=rs[i],t=r.target;" +
            "if(r.type==='attributes'){var c=t.classList;" +
            "if(c&&c.contains('zen-stage-card'))p.card++;else if(c&&c.contains('zen-stage-dim'))p.dim++;else if(c&&c.contains('zen-group-ribbon'))p.ribbon++;" +
            "else if(t===document.documentElement)p.root++;else if(inPill(t))p.pill++;else p.other++}" +
            "else{p.added+=r.addedNodes.length;p.removed+=r.removedNodes.length;" +
            "for(var j=0;j<r.addedNodes.length;j++){if(isStage(r.addedNodes[j]))p.stageMounts++}" +
            "if(inPill(t)&&r.addedNodes.length)p.pillRemounts++}}})" +
            ".observe(document.documentElement,{attributes:true,attributeFilter:['style'],childList:true,subtree:true});" +
            "return 'installed'})()"
    )

    private fun resetProbe() {
        chromeJs("window.__motion&&Object.assign(window.__motion,{card:0,dim:0,ribbon:0,pill:0,root:0,other:0,added:0,removed:0,stageMounts:0,pillRemounts:0})")
    }

    private fun readProbe(): JSONObject {
        val raw = chromeJs("JSON.stringify(window.__motion||{})")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    // --- the core and the pages ------------------------------------------------------------------

    /** Make `tabId` the active tab through the core and wait for its page to be loaded and shown. */
    private fun activate(tabId: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val deadline = SystemClock.uptimeMillis() + LOAD_TIMEOUT_MS
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                last = "${view?.url} @ ${view?.progress}"
                loaded = view != null && view.progress == 100 && (view.url ?: "").startsWith(ORIGIN)
            }
            if (loaded && activeTabId() == tabId) {
                SystemClock.sleep(LOADED_SETTLE_MS)
                return
            }
            SystemClock.sleep(250)
        }
        finding("$tabId did not load in time (view at $last)")
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id", "") ?: ""

    /** A page fixture kept gzipped in the tree (`perf/<name>.html.gz`); AAPT2 may have unpacked it (see BarHidePerfDemo). */
    private fun pageFixture(name: String): ByteArray {
        val assets = instrumentation.context.assets
        val plain = runCatching { assets.open("perf/$name.html") }.getOrNull()
        if (plain != null) return plain.use { it.readBytes() }
        return GZIPInputStream(assets.open("perf/$name.html.gz")).use { it.readBytes() }
    }

    private fun webViewVersion(): String =
        runCatching { android.webkit.WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "WebView ?"

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    companion object {
        private const val PORT = 18170
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** The track in the pill's order (`tabOrderOf`: the group's tabs first, then the loose ones). */
        private val TRACK = listOf("tab_doc_a", "tab_doc_b", "tab_github", "tab_article", "tab_long", "tab_extra")
        /** The plain scenes start here: the cards on the track around it are all loose tabs. */
        private const val START_TAB = "tab_article"
        /** The grouped scene starts on the group's first tab and drags to its second. */
        private const val GROUP_TAB = "tab_doc_a"
        /** The startup sweep's window, from the app's launch. */
        private const val SWEEP_MS = 30_000L
        private const val LOAD_TIMEOUT_MS = 30_000L
        private const val LOADED_SETTLE_MS = 1_500L
        private const val HOLD_MS = 1_200L
        private const val DRAG_MS = 1_200L
        private const val DRAG_TAIL_MS = 300L
        /** How much of one card the drag carries the track; the release's spring does the rest. */
        private const val DRAG_FRACTION = 0.9f
        /** The spring, the core's activation and the live page's return after a lift. */
        private const val RELEASE_MS = 3_000L
    }
}
