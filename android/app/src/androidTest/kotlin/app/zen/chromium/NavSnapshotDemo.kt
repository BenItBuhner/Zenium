package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
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
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records the navigation snapshot on the phone (the ask of #207: a tab brought back by Undo lost
 * its back/forward stack), every press a real touch and every outcome read off the host's
 * WebView, the core's state or the page server, never off the chrome's word:
 *
 *  1. a three-page stack built with two touches on the pages' links: the host's list holds the
 *     three entries with the third current, the core reads the same list synchronously, the
 *     `hostState` for it is there and under the 64 KB cap, each page was fetched once;
 *  2. the tab closed from the Tabs button's quick menu (a hold, then a touch on Close Tab): the
 *     tab is gone at once and the toast reads `Closed Page three` with Undo;
 *  3. Undo touched: the tab is back and active on page three, the host answered
 *     `restored: true` (the list was rebuilt from `hostState`, not loaded), the list has its
 *     three entries again, and page three came back without a request to the server;
 *  4. Back touched twice on the bar: page two, then page one, each without a request (the
 *     WebView's history navigation serves them from its cache), the list standing at its first
 *     entry with two forward entries;
 *  5. the design gate: a hold on the bar's Back button opens the bar editor – the phone has no
 *     long-press history list (that is the desktop's) – so the full stack is read from the core
 *     (`tab.navigationEntries`, what such a list would draw) and nothing new is built here.
 *
 * The pages come from a loopback server inside this process ([DemoServer]) with `max-age`
 * caching, so a page coming back without a request can be told from one fetched again
 * ([DemoServer.hits]). Findings go to `nav-snapshot-findings.txt` next to the stills (one PASS
 * or FAIL per claim, ALL CHECKS PASSED at the end); the run fails on any FAIL. Profile
 * `nav-snapshot-demo-state.json`: the Work space with `tab_other` and `tab_demo` (active, on
 * page one). Driven by `android-nav-snapshot-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class NavSnapshotDemo : DemoHarness("nav-snapshot-demo-state.json", "nav-snapshot", "nav-snapshot-demo") {
    override val tag = "NavSnapshotDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/one.html" to DemoServer.page("Page one", "<p id=\"next\"><a href=\"/two.html\">On to page two</a></p>${tint("#e3f2fd")}"),
                "/two.html" to DemoServer.page("Page two", "<p id=\"next\"><a href=\"/three.html\">On to page three</a></p>${tint("#e8f5e9")}"),
                "/three.html" to DemoServer.page("Page three", "<p>The top of a three-page stack.</p>${tint("#fff3e0")}"),
                "/other.html" to DemoServer.page("Another tab", "<p>Stays open while the demo's tab is closed.</p>")
            ),
            cacheable = setOf("/one.html", "/two.html", "/three.html")
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) error("$failures check(s) failed; see nav-snapshot-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "nav-snapshot-findings.txt")
        findings.writeText(
            "Zenium Android navigation snapshot checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded(ONE)
        SystemClock.sleep(2_000)
        calibrate()
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        still("page-one")
        buildStack()
        closeFromQuickMenu()
        undoRestores()
        backTwice()
        holdOnBack()
        still("end")
        finding("\nend: ${describeActive()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. Two touches on the pages' links: a three-page stack, known to the host and the core. */
    private fun buildStack() {
        finding("\n1. A three-page stack from two touches on the pages' links")
        tapPage("#next a")
        expect("page two loads", awaitLoaded(TWO))
        SystemClock.sleep(1_500)
        tapPage("#next a")
        expect("page three loads", awaitLoaded(THREE))
        settle()
        val list = hostList()
        expect("the host's list holds one, two, three with the third current: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 2)
        val core = coreList()
        expect("the core reads the same list synchronously: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 2)
        val hostState = onMain { host.tabs.get(TAB)?.hostState() }
        expect("the hostState for it is there and under the cap (${hostState?.length ?: 0} chars of ${NavigationState.HOST_STATE_MAX})", hostState != null && hostState.length <= NavigationState.HOST_STATE_MAX)
        expect("each page was fetched once (${hitsLine()})", hits() == listOf(1, 1, 1))
        still("stack-of-three")
    }

    /** 2. A hold on the Tabs button, a touch on Close Tab: the tab goes, the toast offers Undo. */
    private fun closeFromQuickMenu() {
        finding("\n2. Close Tab from the Tabs button's quick menu")
        val tabs = tabsButton() ?: error("no Tabs button on the bar")
        val opened = holdUntil(tabs, "the Tabs button") { inDom(QUICK_MENU) }
        expect("a hold on Tabs opens its quick menu", opened)
        still("quick-menu")
        val closed = touchUntil("Close Tab in the quick menu", { steadyRect { textRect("$QUICK_MENU-item", "Close Tab") } }, { !tabExists(TAB) })
        expect("the touch on Close Tab closes the tab at once", closed)
        val toast = awaitToast("Closed ")
        expect("the toast reads 'Closed Page three' with Undo: '${toast.orEmpty()}'", toast == "Closed Page three" && awaitRect({ undoRect() }, 3_000) != null)
        expect("another tab is on screen meanwhile: ${activeTabId()}", activeTabId() == OTHER)
        still("closed-toast")
    }

    /** 3. Undo: the tab comes back with its list rebuilt from the host's state, page three from the cache. */
    private fun undoRestores() {
        finding("\n3. Undo on the toast")
        val before = hits()
        expect("the touch on Undo takes", undo())
        expect("the tab is back", awaitTab(TAB, exists = true))
        expect("and active", awaitUntil(8_000) { activeTabId() == TAB })
        expect("on page three", awaitLoaded(THREE))
        settle()
        val restored = onMain { host.tabs.get(TAB)?.lastRestore }
        expect("the host answered restored: true (the list rebuilt from hostState, nothing loaded by the core)", restored == true)
        val list = hostList()
        expect("the host's list holds the three entries again, the third current: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 2)
        val core = coreList()
        expect("so does the core's: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 2)
        expect("page three came back without a request (${hitsLine()})", hits() == before)
        still("undone")
        awaitToastGone()
    }

    /** 4. Back twice, real touches on the bar: pages two and one come back without a request. */
    private fun backTwice() {
        finding("\n4. Back twice on the bar")
        val before = hits()
        expect("the first Back brings page two", pressBack(TWO))
        SystemClock.sleep(1_500)
        still("back-to-two")
        expect("the second Back brings page one", pressBack(ONE))
        SystemClock.sleep(1_500)
        still("back-to-one")
        expect("neither page was fetched again (${hitsLine()})", hits() == before)
        val list = hostList()
        expect("the list stands at its first entry with two forward entries: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 0)
        val forward = onMain { host.tabs.get(TAB)?.canGoForward() }
        expect("the WebView can go forward", forward == true)
    }

    /** 5. The design gate: a hold on Back opens the bar editor; the phone has no long-press history list. */
    private fun holdOnBack() {
        finding("\n5. Design gate: a hold on the bar's Back button")
        val back = backButton() ?: error("no Back button on the bar")
        val editor = holdUntil(back, "the Back button") { inDom(BAR_EDITOR) }
        finding(
            if (editor) "  a hold on Back opens the bar editor ('In the bar'), as a hold on any bar button does: the phone has no long-press history list (the desktop's); none is built here (separate row)"
            else "  a hold on Back opened nothing the driver knows (no bar editor, no list): the phone has no long-press history list; none is built here (separate row)"
        )
        still("hold-on-back")
        val core = coreList()
        expect("the full stack such a list would draw is in the core: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 0)
        if (editor) {
            back()
            expect("the system back closes the editor", awaitDom("!document.querySelector('$BAR_EDITOR')", 8_000))
            SystemClock.sleep(1_000)
        }
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * A real touch on Back that has to bring `url`: the touch is made again when the page did not
     * change, and a touch read as a hold (the bar editor coming up instead) is taken back first.
     */
    private fun pressBack(url: String): Boolean {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            val back = backButton() ?: run {
                finding("  (no Back button to touch)")
                return false
            }
            touch(back, "Back on the bar")
            if (awaitLoaded(url, 12_000)) return true
            if (inDom(BAR_EDITOR)) {
                finding("  (the touch on Back was read as a hold: the bar editor is up; dismissed)")
                back()
                awaitDom("!document.querySelector('$BAR_EDITOR')", 6_000)
                SystemClock.sleep(800)
            }
            if (attempt < TOUCH_ATTEMPTS) finding("  (the touch on Back did not take, attempt $attempt: touching again)")
        }
        return false
    }

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up a frame
     * apart, so a long task on the main thread between them cannot turn the tap into a hold.
     */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /** A touch that has to take: touched where `read` finds it, `took` watched, again when nothing came of it. */
    private fun touchUntil(what: String, read: () -> Rect?, took: () -> Boolean, attempts: Int = TOUCH_ATTEMPTS, waitMs: Long = TOUCH_TOOK_WAIT): Boolean {
        for (attempt in 1..attempts) {
            val box = read() ?: run {
                finding("  ($what is not there to touch)")
                return took()
            }
            if (touchPoint(box) == null) {
                finding("  ($what is off the screen at $box, attempt $attempt)")
                SystemClock.sleep(STEADY_MS)
                continue
            }
            touch(box, what)
            if (awaitUntil(waitMs, took)) return true
            if (attempt < attempts) finding("  (the touch on $what did not take, attempt $attempt: touching again)")
        }
        return took()
    }

    /**
     * A real hold on the middle of `box`: the finger down until `took` holds (the chrome's hold
     * fires at 400 ms; the emulator's main thread may lag) or [HOLD_MAX] has passed, then up.
     * The release's click is the chrome's to swallow.
     */
    private fun holdUntil(box: Rect, what: String, took: () -> Boolean): Boolean {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  hold at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        val held = awaitUntil(HOLD_MAX, took)
        f.hold(200)
        f.up()
        if (!held) return awaitUntil(1_500, took)
        return true
    }

    /** Touch the toast's Undo once the toast is at rest; the toast leaving or the tab back is the touch taking. */
    private fun undo(): Boolean {
        if (awaitRect({ undoRect() }, 6_000) == null) {
            finding("  the toast's Undo never showed")
            return false
        }
        awaitDom("(function(){var e=document.querySelector('.zen-message-toast');return !!e&&!e.hasAttribute('data-moving')})()", 1_500)
        return touchUntil("the toast's Undo", { undoRect() }, { toastLeavingOrGone() || tabExists(TAB) }, waitMs = UNDO_TOOK_WAIT)
    }

    private fun tabsButton(): Rect? =
        findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            ?: domRect("[aria-label^=\"Tabs (\"]")

    private fun backButton(): Rect? = domRect("[data-bar-item=\"back\"]") ?: findByLabel("Back")

    // --- where things are: the chrome's DOM ----------------------------------------------------

    private var originX = 0f
    private var originY = 0f

    /** A JS expression's string result in the chrome ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    private fun rectFrom(text: String): Rect? {
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        return Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    /** The on-screen box of the first element `selector` matches, null when nothing does. */
    private fun domRect(selector: String): Rect? =
        rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$RECT_JS})()"))

    /** The box of the first element matching `selector` whose text starts with `prefix`. */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';$RECT_JS})()"
            )
        )

    /** A box read from the DOM once two reads [STEADY_MS] apart agree (a menu popping in moves on each frame). */
    private fun steadyRect(read: () -> Rect?): Rect? {
        var last = awaitRect(read, LOOKUP_WAIT) ?: return null
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STEADY_MS)
            val again = read() ?: return last
            if (again == last) return again
            last = again
        }
        return last
    }

    private fun undoRect(): Rect? = domRect(".zen-message-toast .zen-message-button")

    private fun toastLeavingOrGone(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-message-toast');return !e||e.hasAttribute('data-moving')?'yes':''})()") == "yes"

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    /** The toast's text once one starting with `prefix` is up; null when none comes in time. */
    private fun awaitToast(prefix: String, timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val text = jsString("(function(){var e=document.querySelector('.zen-message-toast .zen-message-text');return e?e.textContent:''})()")
            if (text.startsWith(prefix)) return text
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /**
     * Check the DOM's coordinates against the accessibility tree once, on the bar's Back button,
     * which does not move; an offset (a chrome not at the window's origin) applies to every box
     * read from the DOM from then on.
     */
    private fun calibrate() {
        val fromDom = domRect("[data-bar-item=\"back\"]") ?: return
        val fromTree = waitFor("Back", 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding("coordinates: Back button at $fromDom from the DOM, $fromTree from the accessibility tree (offset ${dx.roundToInt()}, ${dy.roundToInt()})")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    /** A real touch on the page element `selector` (a link). */
    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            finding("  (nothing matches $selector on the page)")
            return
        }
        finding("  touch at ${p.x.roundToInt()},${p.y.roundToInt()} on the page's $selector")
        Finger().tap(p.x, p.y)
    }

    /** Whether the demo tab's WebView comes to show `url`, loaded, in time. */
    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { host.tabs.get(TAB).let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
        return false
    }

    /** The host's list for the demo tab (`navigationEntries()` on its WebView), null without a WebView. */
    private fun hostList(): JSONObject? = onMain { host.tabs.get(TAB)?.navigationEntries() }

    /** The core's list for the demo tab (`tab.navigationEntries`: the host's, read synchronously). */
    private fun coreList(): JSONObject = JSONObject(coreInvoke("tab.navigationEntries", JSONObject().put("tabId", TAB).toString()))

    private fun urlsOf(list: JSONObject?): List<String> {
        val entries = list?.optJSONArray("entries") ?: return emptyList()
        return (0 until entries.length()).map { entries.getJSONObject(it).optString("url") }
    }

    private fun describe(list: JSONObject?): String =
        if (list == null) "no list" else "${urlsOf(list).map { it.substringAfterLast('/') }} at ${list.optInt("index", -1)}"

    /** The server's requests so far for pages one, two and three. */
    private fun hits(): List<Int> = listOf(server.hits("/one.html"), server.hits("/two.html"), server.hits("/three.html"))

    private fun hitsLine(): String = hits().let { "one ${it[0]}, two ${it[1]}, three ${it[2]}" }

    // --- the core's state ------------------------------------------------------------------------

    private fun tabExists(tabId: String): Boolean = coreState().getJSONObject("tabs").has(tabId)

    private fun awaitTab(tabId: String, exists: Boolean, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { tabExists(tabId) == exists }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${coreState().getJSONObject("tabs").length()} tabs; ${hitsLine()}" }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `nav-snapshot-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val ONE = "$ORIGIN/one.html"
        private const val TWO = "$ORIGIN/two.html"
        private const val THREE = "$ORIGIN/three.html"
        private const val TAB = "tab_demo"
        private const val OTHER = "tab_other"
        private const val QUICK_MENU = ".zen-quick-menu"
        /** The bar editor's heading: what a hold on any bar button but Tabs opens. */
        private const val BAR_EDITOR = ".zen-bar-heading"
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L
        private const val LOOKUP_WAIT = 8_000L
        private const val MAX_OFFSET = 200f
        private const val TOUCH_ATTEMPTS = 4
        private const val TAP_HOLD_MS = 16L
        private const val TOUCH_TOOK_WAIT = 1_500L
        private const val UNDO_TOOK_WAIT = 650L
        /** The chrome's hold fires at 400 ms; the finger stays down this long at most for it to. */
        private const val HOLD_MAX = 4_000L
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        /** A page's own background, so the recording tells the three apart. */
        private fun tint(color: String) = "<style>body{background:$color}</style>"
    }
}
