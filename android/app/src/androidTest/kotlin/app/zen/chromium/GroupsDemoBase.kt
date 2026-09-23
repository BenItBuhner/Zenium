package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * What the two tab-group drivers share (TAB-16, TAB-15, TABLET-04; the `android-tab-groups-demo`
 * workflow's phone and tablet acts, [TabGroupsDemo] and [TabletGroupsDemo]): the profile
 * `tab-groups-demo-state.json` – the Work space with the group Research [Alpha, Beta] and the
 * loose tabs Home (active), Gamma, Delta, every page served by the driver's own [DemoServer]
 * (Alpha carries the link the link menu is held on) – the findings file (one `OK` or `FAIL` per
 * claim; a claim that does not hold fails the run at the end, the sequence running on so the
 * recording shows the rest), reads of the chrome's DOM and stores and of the core's state, and
 * the real touches: every press in a sheet or menu flow is a finger ([Finger]) on a box read
 * from the chrome's DOM – CSS px scaled by the chrome's device pixel ratio and offset by one
 * calibration against the accessibility tree – never an accessibility click, which bypasses hit
 * testing (the real-touch rule). The accessibility tree itself trails the emulator's software
 * GPU by seconds, so no claim is read off it.
 */
abstract class GroupsDemoBase(shotPrefix: String, handshakeDir: String) :
    DemoHarness("tab-groups-demo-state.json", shotPrefix, handshakeDir) {

    protected lateinit var server: DemoServer
    protected val findings = StringBuilder()
    protected val failures = ArrayList<String>()
    private var shots = 0

    /** CSS px of the chrome to screen px: `screen = offset + css * scale` ([calibrate]). */
    protected var offsetX = 0f
    protected var offsetY = 0f
    protected var scale = 1f
    protected var calibrated = false

    protected abstract val findingsFile: String
    protected abstract val title: String

    /** The concrete driver's `@Test`: the server up, the recorded run, the findings written, a FAIL failing the test. */
    protected fun recordDemo() {
        server = DemoServer(PORT, PAGES).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, findingsFile).writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("claims that did not hold:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    protected fun head() {
        // The chrome's CSS px to screen px before any calibration: the WebView's own ratio.
        val dpr = jsNumber("window.devicePixelRatio")
        if (dpr.isFinite() && dpr > 0) scale = dpr.toFloat()
        finding("$title (API ${Build.VERSION.SDK_INT}, window ${width}x$height, density $density, chrome dpr $scale)")
        finding("demo server: ${server.selfCheck()}")
        finding("start: ${describeSpace()}")
    }

    protected fun tail() {
        finding("")
        finding("end: ${describeSpace()}")
        finding(if (failures.isEmpty()) "ALL CHECKS PASSED" else "${failures.size} CHECK(S) FAILED")
    }

    // --- findings ------------------------------------------------------------------------------

    protected fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    protected fun section(line: String) = finding("\n$line")

    /** A claim of the sequence: written down either way; one that did not hold fails the run at the end. */
    protected fun check(claim: String, held: Boolean, detail: String = "") {
        if (held) {
            finding("  OK   $claim${if (detail.isNotEmpty()) " ($detail)" else ""}")
            return
        }
        finding("  FAIL $claim ($detail)")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    /** Numbered stills: `<prefix>-NN-<state>.png`. */
    protected fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    // --- the chrome's DOM ------------------------------------------------------------------------

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    protected fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    protected fun jsBoolean(code: String): Boolean = chromeJs("!!($code)") == "true"

    protected fun jsNumber(code: String): Double = chromeJs("Number($code)").toDoubleOrNull() ?: Double.NaN

    /** The value `code` evaluates to, as text (a string unquoted; anything else as its JSON). */
    protected fun jsText(code: String): String {
        val raw = chromeJs("(function(){var v=($code);return v===undefined?'undefined':(typeof v==='string'?v:JSON.stringify(v))})()")
        if (raw.isEmpty()) return ""
        return runCatching { (JSONTokener(raw).nextValue() as? String) ?: raw }.getOrDefault(raw)
    }

    protected fun jsArray(code: String): JSONArray {
        val raw = chromeJs("JSON.stringify($code)")
        if (raw.isEmpty() || raw == "null") return JSONArray()
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONArray()
        return runCatching { JSONArray(text) }.getOrDefault(JSONArray())
    }

    protected fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

    private fun rectOf(raw: String): RectF? {
        if (raw.isEmpty() || raw == "null") return null
        val a = runCatching { JSONArray(raw) }.getOrNull() ?: return null
        if (a.length() < 4) return null
        val l = a.getDouble(0).toFloat()
        val t = a.getDouble(1).toFloat()
        return RectF(l, t, l + a.getDouble(2).toFloat(), t + a.getDouble(3).toFloat())
    }

    /** The bounding rect (CSS px) of the first element `selector` matches; null when none. */
    protected fun domRect(selector: String): RectF? =
        rectOf(chromeJs("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()"))

    /** The rect of the first element matching `selector` whose trimmed text starts with `prefix`. */
    protected fun textRect(selector: String, prefix: String): RectF? =
        rectOf(
            chromeJs(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return null;var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()"
            )
        )

    protected fun inDom(selector: String): Boolean = jsNumber("document.querySelectorAll(${JSONObject.quote(selector)}).length") > 0

    protected fun textOf(selector: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.textContent.trim():''})()")

    /** The trimmed texts of every element `selector` matches. */
    protected fun textsOf(selector: String): List<String> =
        jsArray("Array.prototype.map.call(document.querySelectorAll(${JSONObject.quote(selector)}),function(n){return n.textContent.trim()})").strings()

    /** An attribute of the first element `selector` matches; "" when none or unset. */
    protected fun attrOf(selector: String, name: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e&&e.hasAttribute(${JSONObject.quote(name)})?e.getAttribute(${JSONObject.quote(name)}):''})()")

    protected fun awaitJs(code: String, expected: Boolean = true, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsBoolean(code) == expected) return true
            SystemClock.sleep(POLL_MS)
        }
        return jsBoolean(code) == expected
    }

    protected fun awaitDom(selector: String, timeoutMs: Long = 4_000): Boolean =
        awaitUntil(timeoutMs) { inDom(selector) }

    protected fun awaitDomGone(selector: String, timeoutMs: Long = 4_000): Boolean =
        awaitUntil(timeoutMs) { !inDom(selector) }

    protected fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    protected fun awaitRect(timeoutMs: Long = LOOKUP_WAIT, read: () -> RectF?): RectF? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    /** A box once two reads [STEADY_MS] apart agree (a sheet still rising moves); the last read when they never do. */
    protected fun steadyRect(read: () -> RectF?): RectF? {
        var last = awaitRect { read() } ?: return null
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STEADY_MS)
            val again = read() ?: return last
            if (abs(again.left - last.left) < 0.5f && abs(again.top - last.top) < 0.5f) return again
            last = again
        }
        finding("  (still moving after $LOOKUP_WAIT ms: $last)")
        return last
    }

    // --- the chrome's geometry -------------------------------------------------------------------

    /**
     * Where the chrome's CSS px land on the screen: the DOM box of the element `selector` against
     * the accessibility bounds of the node named `label` (the one read of the tree, of a control
     * that stands still; with `prefix`, the node whose name starts with `label`), the scale the
     * chrome's device pixel ratio.
     */
    protected fun calibrate(selector: String, label: String, prefix: Boolean = false) {
        if (calibrated) return
        val dpr = jsNumber("window.devicePixelRatio")
        if (dpr.isFinite() && dpr > 0) scale = dpr.toFloat()
        val dom = domRect(selector)
        val tree = if (prefix) awaitLabelPrefix(label) else waitFor(label, 6_000)
        if (dom == null || tree == null) {
            finding("calibration: '$label' DOM $dom, tree $tree; keeping offsets $offsetX/$offsetY at scale $scale")
            return
        }
        val dx = tree.exactCenterX() - (dom.centerX() * scale)
        val dy = tree.exactCenterY() - (dom.centerY() * scale)
        finding("calibration: '$label' DOM $dom x$scale -> tree $tree; offset ${dx.roundToInt()}/${dy.roundToInt()}")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            offsetX = dx
            offsetY = dy
        }
        calibrated = true
    }

    private fun awaitLabelPrefix(prefix: String, timeoutMs: Long = 6_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            findByLabelPrefix(prefix)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    /** A CSS rect of the chrome as screen px. */
    protected fun screen(r: RectF?): Rect? = r?.let {
        Rect(
            (offsetX + it.left * scale).roundToInt(),
            (offsetY + it.top * scale).roundToInt(),
            (offsetX + it.right * scale).roundToInt(),
            (offsetY + it.bottom * scale).roundToInt()
        )
    }

    /** A screen point as the chrome's CSS px. */
    protected fun css(x: Float, y: Float) = PointF((x - offsetX) / scale, (y - offsetY) / scale)

    // --- fingers -------------------------------------------------------------------------------

    /**
     * A real touch on the middle of the CSS box `box`: the finger's down and up a frame apart, so
     * the two queue together under load and the WebView never reads a long task between them as a
     * long press. Null (and a note) when the box is off the touchable window.
     */
    protected fun touch(box: RectF?, what: String): PointF? {
        val target = screen(box) ?: run {
            finding("  ($what is not there to touch)")
            return null
        }
        val point = touchPoint(target) ?: run {
            finding("  ($what at $target is out of the touchable window $touchable)")
            return null
        }
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
        return point
    }

    /**
     * A touch that has to take: touch `what` where `read` finds it, watch `took` for `waitMs`,
     * and when nothing came of it read the box again (it may have moved) and touch again, up to
     * `attempts` times. Whether it took in the end.
     */
    protected fun touchUntil(
        what: String,
        read: () -> RectF?,
        took: () -> Boolean,
        attempts: Int = TOUCH_ATTEMPTS,
        waitMs: Long = TOUCH_TOOK_WAIT
    ): Boolean {
        for (attempt in 1..attempts) {
            val box = steadyRect(read) ?: run {
                finding("  ($what is not there to touch)")
                return took()
            }
            if (touch(box, what) == null) {
                SystemClock.sleep(STEADY_MS)
                continue
            }
            if (awaitUntil(waitMs, took)) return true
            if (attempt < attempts) finding("  (the touch on $what did not take, attempt $attempt: touching again)")
        }
        return took()
    }

    /**
     * A hold on the middle of `box`: the finger down past the chrome's long press (380 ms) and
     * released; the point it held, as CSS px, or null when the box was not there.
     */
    protected fun hold(box: RectF?, what: String): PointF? {
        val target = screen(box) ?: run {
            finding("  ($what is not there to hold)")
            return null
        }
        val point = touchPoint(target) ?: run {
            finding("  ($what at $target is out of the touchable window)")
            return null
        }
        finding("  hold at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.press(point.x, point.y)
        f.up()
        return css(point.x, point.y)
    }

    /** Type into the focused field, then Enter. */
    protected fun typeAndEnter(text: String) {
        instrumentation.sendStringSync(text)
        SystemClock.sleep(300)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
    }

    // --- the core's state --------------------------------------------------------------------------

    protected fun folder(state: JSONObject = coreState()): JSONObject? =
        state.getJSONObject("folders").optJSONObject(FOLDER)

    protected fun folderName(state: JSONObject = coreState()): String? = folder(state)?.optString("name")

    protected fun folderColor(state: JSONObject = coreState()): String? =
        folder(state)?.let { if (it.isNull("color")) null else it.optString("color") }

    protected fun folderCollapsed(state: JSONObject = coreState()): Boolean = folder(state)?.optBoolean("collapsed") == true

    // --- the group palette (§9.14's pair) ----------------------------------------------------------

    /** The scheme the chrome's root carries (`data-theme`, `useTheme`'s paint): the set its group colours are drawn from. */
    protected fun chromeScheme(): String = jsText("document.documentElement.getAttribute('data-theme')||'light'")

    /** Blue of the set the chrome shows, as a computed `rgb(r, g, b)`. */
    protected fun blueRgb(): String = if (chromeScheme() == "dark") BLUE_RGB_DARK else BLUE_RGB_LIGHT

    /** Green of the set the chrome shows, as a computed `rgb(r, g, b)`. */
    protected fun greenRgb(): String = if (chromeScheme() == "dark") GREEN_RGB_DARK else GREEN_RGB_LIGHT

    /** The kept pages of the (saved) group, in order; empty for an open group. */
    protected fun savedUrls(state: JSONObject = coreState()): List<String> {
        val saved = folder(state)?.optJSONArray("savedTabs") ?: return emptyList()
        return (0 until saved.length()).map { saved.getJSONObject(it).optString("url") }
    }

    protected fun tabExists(tabId: String, state: JSONObject = coreState()): Boolean = state.getJSONObject("tabs").has(tabId)

    protected fun tabUrl(tabId: String, state: JSONObject = coreState()): String? =
        state.getJSONObject("tabs").optJSONObject(tabId)?.optString("url")

    /** The folder a tab is in per the core, null when loose (or gone). */
    protected fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    protected fun activeSpace(state: JSONObject): JSONObject {
        val spaces = state.getJSONArray("spaces")
        val activeId = state.optString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") == activeId) return space
        }
        return spaces.getJSONObject(0)
    }

    /** The Work space's tabs in track order, as (id, folderId) pairs. */
    protected fun trackOrder(state: JSONObject = coreState()): List<Pair<String, String?>> {
        val tabs = state.getJSONObject("tabs")
        val ids = activeSpace(state).getJSONArray("tabIds")
        val order = ArrayList<Pair<String, String?>>()
        for (i in 0 until ids.length()) {
            val id = ids.getString(i)
            val tab = tabs.optJSONObject(id) ?: continue
            if (tab.optBoolean("pinned") || tab.optBoolean("essential")) continue
            order += id to folderOf(id, state)
        }
        return order
    }

    /** The group's tabs in track order: (id, url). */
    protected fun groupTabs(state: JSONObject = coreState()): List<Pair<String, String>> =
        trackOrder(state).filter { it.second == FOLDER }.map { (id, _) -> id to tabUrl(id, state).orEmpty() }

    /**
     * The live tab at `url` in the space's track (the first in order), or null. A page that has
     * been closed and brought back is a new tab (Open Group makes its tabs afresh from the kept
     * pages; Recently closed keeps a tab's id, which after Open Group is the fresh one), so a
     * claim past the reopen finds a member by its page, not by the seeded id.
     */
    protected fun tabIdAt(url: String, state: JSONObject = coreState()): String? =
        trackOrder(state).firstOrNull { (id, _) -> tabUrl(id, state) == url }?.first

    protected fun activeTabId(state: JSONObject = coreState()): String? = activeCoreTab(state)?.optString("id")?.takeIf { it.isNotEmpty() }

    protected fun awaitCore(timeoutMs: Long = 8_000, test: (JSONObject) -> Boolean): Boolean =
        awaitUntil(timeoutMs) { test(coreState()) }

    protected fun describeSpace(): String {
        val state = coreState()
        val tabs = state.getJSONObject("tabs")
        val title = { id: String -> tabs.optJSONObject(id)?.optString("title") ?: id }
        val order = trackOrder(state)
        val f = folder(state)
        val group = if (f == null) "no group" else {
            val members = order.filter { it.second == FOLDER }.joinToString(", ") { title(it.first) }
            val saved = savedUrls(state)
            "group ${f.optString("name")} (${folderColor(state)})${if (f.optBoolean("collapsed")) " collapsed" else ""}" +
                (if (saved.isNotEmpty()) " SAVED [${saved.joinToString(", ") { it.removePrefix(ORIGIN) }}]" else " [$members]")
        }
        val loose = order.filter { it.second == null }.joinToString(", ") { title(it.first) }
        return "$group; loose [$loose]; active ${activeTabId(state)}"
    }

    // --- the pages -------------------------------------------------------------------------------

    /** Evaluate in the tab's own WebView (the page, not the chrome); "" when it never answered. */
    protected fun pageJs(tabId: String, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        val host = (activity as MainActivity).host
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
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

    protected fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000): Boolean {
        val host = (activity as MainActivity).host
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return true
            SystemClock.sleep(250)
        }
        finding("  (gave up waiting for $url in $tabId)")
        return false
    }

    /**
     * Where the demo link of the page in `tabId` is on the screen: the anchor's box in the page's
     * CSS px scaled by the page's device pixel ratio, from the tab WebView's own origin.
     */
    protected fun linkOnScreen(tabId: String): PointF? {
        val host = (activity as MainActivity).host
        val raw = pageJs(
            tabId,
            "(function(){var a=document.getElementById('demo-link');if(!a)return null;var r=a.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return JSON.stringify([(r.left+r.width/2)*d,(r.top+r.height/2)*d])})()"
        )
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
        val a = runCatching { JSONArray(text) }.getOrNull() ?: return null
        val origin = IntArray(2)
        var shown = false
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view != null) {
                view.getLocationOnScreen(origin)
                shown = view.isShown
            }
        }
        if (!shown) return null
        return PointF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat())
    }

    // --- toasts ----------------------------------------------------------------------------------

    /** The toast's text once one starting with `prefix` is up; null when none comes in time. */
    protected fun awaitToast(prefix: String, timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val text = textOf("$TOAST .zen-message-text")
            if (text.startsWith(prefix)) return text
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    protected fun awaitToastGone() {
        if (!awaitDomGone(TOAST, 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    companion object {
        const val PORT = 18168
        const val ORIGIN = "http://127.0.0.1:$PORT"
        const val SPACE = "space_work"
        const val FOLDER = "folder_research"
        const val HOME = "tab_home"
        const val ALPHA = "tab_alpha"
        const val BETA = "tab_beta"
        const val GAMMA = "tab_gamma"
        const val DELTA = "tab_delta"
        const val LINKED_PATH = "/linked.html"
        const val LINKED_URL = "$ORIGIN$LINKED_PATH"
        const val ALPHA_URL = "$ORIGIN/alpha.html"
        const val BETA_URL = "$ORIGIN/beta.html"

        const val POLL_MS = 200L
        const val STEADY_MS = 350L
        const val LOOKUP_WAIT = 8_000L
        const val TAP_HOLD_MS = 16L
        const val TOUCH_ATTEMPTS = 4
        const val TOUCH_TOOK_WAIT = 1_200L
        const val SHEET_WAIT = 5_000L
        const val MAX_OFFSET = 200f

        const val TOAST = ".zen-message-toast"

        /** Reads off the chrome's stores (`lib/store.ts` registers them on `window.__zenStores`). */
        const val MENU_OPEN = "window.__zenStores.ui.get().menu!==null"
        const val RENAMING = "window.__zenStores.ui.get().renamingFolderId!==null"

        /**
         * The seeded group's colour, blue, and green, the swatch the drivers pick, as the §9.14 PAIR in
         * shared/defaults.ts (`FOLDER_COLORS_LIGHT` / `FOLDER_COLORS_DARK`: one set a scheme, every value
         * 3:1 on its scheme's window fill), the way the pane's glyph and the sidebar's dot paint them –
         * `rgb(var(--zen-group-rgb))`, the set the chrome root's `data-theme` picks. The demos run on the
         * scheme the device hands them, so a reading is judged against the set the chrome shows
         * (`blueRgb()` / `greenRgb()`).
         */
        const val BLUE_RGB_LIGHT = "rgb(22, 108, 221)"
        const val BLUE_RGB_DARK = "rgb(138, 180, 248)"
        const val GREEN_RGB_LIGHT = "rgb(24, 128, 56)"
        const val GREEN_RGB_DARK = "rgb(129, 201, 149)"

        /** The pages the seeded tabs point at. Alpha carries the link the link menu is held on. */
        val PAGES: Map<String, Pair<String, ByteArray>> = mapOf(
            "/" to DemoServer.page("Tab groups demo", "<p>The active tab, loose. Research holds Alpha and Beta.</p>"),
            "/alpha.html" to DemoServer.page(
                "Alpha",
                "<p>Alpha, in the group Research.</p>" +
                    "<p><a id=\"demo-link\" href=\"$LINKED_PATH\" style=\"display:inline-block;padding:18px 8px;font-size:24px\">A page to open in the group</a></p>" +
                    "<p>Hold the link for its menu.</p>"
            ),
            "/beta.html" to DemoServer.page("Beta", "<p>Beta, in the group Research.</p>"),
            "/gamma.html" to DemoServer.page("Gamma", "<p>Gamma, loose.</p>"),
            "/delta.html" to DemoServer.page("Delta", "<p>Delta, loose.</p>"),
            LINKED_PATH to DemoServer.page("Linked", "<p>Opened from Alpha's link into the group, behind Alpha.</p>")
        )
    }
}
