package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * W6-L1: the TABLET'S OMNIBOX POPUP STOPS ABOVE THE KEYBOARD, for the
 * `android-tablet-omnibox-keyboard-demo` workflow – on the `pixel_tablet` profile at 1280 x 800,
 * once in each colour scheme, every claim read off the chrome's DOM, the window's insets or the
 * core's state, never off a still:
 *
 *  1. THE BOUND. Over a new tab a REAL finger on the toolbar's address pill opens the field; the
 *     keyboard comes up; zero-suggest lists TWELVE rows (four remembered searches, eight recent
 *     pages – seeded). The popup's box ends 8 CSS px above the keyboard's top edge (the
 *     `--zen-inset-bottom` the host publishes, agreeing with the window's IME inset), its
 *     computed `max-height` is `window − top − 8 − inset` (`omniboxPopup.ts`), the list scrolls
 *     inside it (`scrollHeight > clientHeight`) with the last row below the fold, and the
 *     popup's top and width are the pill's still (TB-21). Before this change the same popup ran
 *     to y 659 of 800 against a keyboard edge at 374 (W6-E14's measure).
 *  2. THE LAST ROW BY A FINGER. Real swipes inside the list bring the twelfth row into the
 *     list's box; a real touch on it is the pick – the core's active tab lands on that row's
 *     page and the field closes. (The new tab is that page from then on; the later scenes take
 *     a fresh new tab, since a field opened over a page edits its address instead.)
 *  3. THE KEYBOARD DOWN. One back puts the keyboard away and the field survives; the popup is
 *     then at its natural height (the field's row, the list's 520 px cap and the borders: 584),
 *     as before this change, and still above the system bar's inset.
 *  4. TYPED. Over a page the field is opened and "re" typed: the engine's rows and the recent
 *     pages fill the core's ceiling of ten rows; the popup is bounded the same way.
 *
 * The change is a style value the Urlbar computes when the popup opens on the tablet (P0: nothing
 * at start). The site is the driver's own on the loopback ([DemoServer]): the demo page, the
 * eight recent pages and the seeded engine's endpoints. Findings in
 * `android-w6-l1-omnibox-keyboard-findings.txt` next to the stills; the run FAILS when a claim
 * does not hold. Each still is taken behind a frame fence ([steadyShot], W6-E14's): the
 * emulator's frames trail the DOM by seconds. See [DemoHarness] for the plumbing and its rule on
 * real touches versus accessibility clicks.
 */
@RunWith(AndroidJUnit4::class)
class TabletOmniboxKeyboardDemo : DemoHarness("tablet-omnibox-keyboard-demo-state.json", "android-w6-l1-omnibox-keyboard", "tablet-omnibox-keyboard-demo") {
    override val tag = "TabletOmniboxKeyboardDemo"

    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host
    private var originX = 0f
    private var originY = 0f
    /** The scheme the stills are named for. */
    private var scheme = "light"
    /** The new tab the scenes open the field over: the seeded one, then a fresh one after each pick. */
    private var newTab = NEW_TAB

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            shellCommand("cmd uimode night no")
            server.close()
        }
        assertTrue("the tablet popup did not hold above the keyboard:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    /** Zero-suggest's twelve rows: four remembered searches (`shortcuts.json`) over eight recent pages (`history.json`). */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = JSONArray()
        for (i in 1..PAGES) {
            history.put(
                JSONObject()
                    .put("url", pageUrl(i))
                    .put("title", pageTitle(i))
                    .put("visitCount", 2)
                    .put("lastVisit", now - i * 3_600_000L)
                    .put("favicon", JSONObject.NULL)
            )
        }
        File(zen, "history.json").writeText(JSONObject().put("version", 1).put("entries", history).toString())
        val shortcuts = JSONArray()
        SEARCHES.forEachIndexed { i, query ->
            shortcuts.put(
                JSONObject()
                    .put("text", query)
                    .put("fill", query)
                    .put("url", "$ORIGIN/search?q=${query.replace(' ', '+')}")
                    .put("title", query)
                    .put("kind", "search")
                    .put("engineId", ENGINE_ID)
                    .put("hits", 3)
                    .put("lastUsed", now - (i + 1) * 600_000L)
            )
        }
        File(zen, "shortcuts.json").writeText(JSONObject().put("version", 1).put("shortcuts", shortcuts).toString())
    }

    /** The system's scheme before the app starts, so the app is born in the light one. */
    override fun beforeLaunch() {
        shellCommand("cmd uimode night no")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-w6-l1-omnibox-keyboard-findings.txt")
        findings.writeText(
            "Zenium Android tablet omnibox popup above the keyboard (W6-L1; API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n" +
                "site: ${server.selfCheck()}\n\n"
        )
        ensureForeground()
        check("the chrome laid the window out as the tablet", awaitTrue(15_000) { formFactor() == "tablet" }, "form factor '${formFactor()}', window ${jsText("window.innerWidth+'x'+window.innerHeight")} CSS px")
        awaitPageUrl(HOME_URL, 20_000)
        calibrate()
        // The first open pays for the editor's layout and the first suggestions: off camera.
        if (openField()) {
            awaitIme(shown = true, timeoutMs = 6_000)
            awaitRows(1, 8_000)
            SystemClock.sleep(800)
        } else {
            finding("warm-up: the pill's tap opened no field")
        }
        closeField()
        settle(6_000)
        finding("warm-up done: active ${activeTabId()} at ${activeUrl()}, keyboard inset ${imeInset()} px")
    }

    override fun demo() {
        scheme = "light"
        sequence()
        // The dark scheme: the core's setting (the chrome re-inks) and the system's night mode
        // (the pages' `prefers-color-scheme`), then the same steps.
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(2_500)
        ensureForeground()
        check("the chrome is still the tablet after the scheme change", awaitTrue(10_000) { formFactor() == "tablet" }, "form factor '${formFactor()}'")
        calibrate()
        scheme = "dark"
        sequence()
        shellCommand("cmd uimode night no")
        finding("\nend: ${failures.size} failure(s)")
    }

    private fun sequence() {
        finding("\n--- $scheme ---")

        // 1. The bound, with the keyboard up over a new tab's zero-suggest.
        step("[$scheme] the popup stops above the keyboard") {
            showNewTab()
            if (!openField()) error("the pill's tap opened no field")
            val imeUp = awaitIme(shown = true, timeoutMs = 6_000)
            val twelve = awaitRows(ZERO_SUGGEST_ROWS, 12_000)
            SystemClock.sleep(900)
            val m = measure()
            finding("  keyboard ${if (imeUp) "up" else "NOT up"} (window inset ${imeInset()} px = ${"%.1f".format(imeInset() / density)} CSS px; the root's --zen-inset-bottom '${m.inset}'); rows ${m.rows} (${m.headings} heading); popup ${m.describe()}")
            check("[$scheme] the keyboard is up and the chrome publishes its inset", imeUp && m.insetPx > 100 && abs(m.insetPx - imeInset() / density) <= 2.0, "inset ${m.insetPx} vs the window's ${"%.1f".format(imeInset() / density)}")
            check("[$scheme] zero-suggest lists twelve rows", twelve && m.rows == ZERO_SUGGEST_ROWS, "rows ${m.rows}")
            claimBounded(m)
            check("[$scheme] the list scrolls inside the popup, the last row below the fold", m.scrollHeight > m.clientHeight + 1 && m.lastBottom > m.listBottom + 1, "scrollHeight ${m.scrollHeight} > clientHeight ${m.clientHeight}; last row ${m.lastTop}–${m.lastBottom} against the list's bottom ${m.listBottom}")
            check("[$scheme] the popup hangs from the pill as before (TB-21)", abs(m.top - (m.pillBottom + POPUP_GAP)) <= 1.0 && abs(m.left - m.pillLeft) <= 1.0 && abs(m.width - m.pillWidth) <= 1.0, "popup top ${m.top} / left ${m.left} / width ${m.width}; pill bottom ${m.pillBottom} / left ${m.pillLeft} / width ${m.pillWidth}")
            steadyShot("01-keyboard-up-twelve-rows-$scheme-tablet")
        }

        // 2. The last row reached by a finger, and picked.
        step("[$scheme] a finger scrolls the list and picks the last row") {
            if (!fieldUp()) {
                showNewTab()
                if (!openField()) error("the pill's tap opened no field")
                awaitIme(shown = true, timeoutMs = 6_000)
                awaitRows(ZERO_SUGGEST_ROWS, 12_000)
                SystemClock.sleep(900)
            }
            var m = measure()
            var swipes = 0
            while (swipes < 6 && !(m.lastBottom <= m.listBottom + 0.5 && m.lastTop >= m.listTop - 0.5)) {
                swipeListUp(m)
                swipes += 1
                SystemClock.sleep(700)
                m = measure()
            }
            finding("  after $swipes swipe(s): list scrollTop ${m.scrollTop}; last row '${m.lastTitle}' at ${m.lastTop}–${m.lastBottom} within the list ${m.listTop}–${m.listBottom}")
            val inReach = swipes >= 1 && m.lastBottom <= m.listBottom + 0.5 && m.lastTop >= m.listTop - 0.5 && m.lastBottom <= m.keyboardTop - OMNIBOX_POPUP_MARGIN + 0.5
            check("[$scheme] the last row is in a finger's reach above the keyboard after real swipes", inReach, "swipes $swipes; last row bottom ${m.lastBottom} vs the keyboard's top ${m.keyboardTop}")
            steadyShot("02-last-row-in-reach-$scheme-tablet")
            val page = pageUrlFor(m.lastTitle)
            val target = screen(RectF((m.left + 40.0).toFloat(), m.lastTop.toFloat(), (m.left + m.width - 40.0).toFloat(), m.lastBottom.toFloat()))
            Finger().tap(target.centerX(), target.centerY())
            val landed = page != null && awaitPageUrl(page, 10_000)
            val closed = awaitChrome("!document.querySelector('$FIELD')", 8_000)
            SystemClock.sleep(600)
            finding("  the touch on '${m.lastTitle}': the active tab at ${activeUrl()} (expected $page) ${if (landed) "landed" else "did NOT land"}; the field ${if (closed) "closed" else "still up"}")
            check("[$scheme] the touch on the last row is the pick", landed && closed, "active ${activeUrl()}, expected $page, field closed $closed")
        }

        // 3. The keyboard down: the popup as before this change.
        step("[$scheme] with the keyboard down the popup is at its natural height") {
            closeField()
            showNewTab()
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 6_000)
            awaitRows(ZERO_SUGGEST_ROWS, 12_000)
            SystemClock.sleep(600)
            back()
            val down = awaitIme(shown = false, timeoutMs = 6_000)
            val stayed = awaitChrome("!!document.querySelector('$FIELD')", 4_000)
            SystemClock.sleep(900)
            val m = measure()
            finding("  the keyboard ${if (down) "down" else "still up"}; the field ${if (stayed) "stayed" else "did NOT stay"}; the root's --zen-inset-bottom '${m.inset}'; popup ${m.describe()}")
            check("[$scheme] one back puts the keyboard away and the field survives it", down && stayed, "down $down, field $stayed")
            val natural = NATURAL_HEIGHT
            check("[$scheme] the popup is at its natural height, not the viewport's bound", abs(m.height - natural) <= 3.0 && m.height < m.maxHeight - 1, "height ${m.height} (natural $natural), computed max-height ${m.maxHeight}")
            check("[$scheme] and still ends above the system bar's inset with the margin", m.bottom <= m.window - m.insetPx - OMNIBOX_POPUP_MARGIN + 0.5, "bottom ${m.bottom}, window ${m.window}, inset ${m.insetPx}")
            steadyShot("03-keyboard-down-$scheme-tablet")
            closeField()
        }

        // 4. Typed: the core's ten-row ceiling, bounded the same way.
        step("[$scheme] a typed query's ten rows are bounded the same way") {
            showTab(HOME_TAB, HOME_URL)
            if (!openField()) error("the pill's tap opened no field")
            val imeUp = awaitIme(shown = true, timeoutMs = 6_000)
            SystemClock.sleep(600)
            instrumentation.sendStringSync(QUERY)
            // The field's value starts with the typing; an inline autocompletion may follow it.
            val typed = awaitChrome("(((document.querySelector('$FIELD')||{}).value||'').toLowerCase().indexOf(${JSONObject.quote(QUERY)})===0)", 8_000)
            val filled = awaitRows(TYPED_ROWS, 12_000)
            awaitChrome("document.querySelectorAll('$SEARCH_ROWS').length>=2&&!document.querySelector('$ROWS_LEAVING')", 6_000)
            SystemClock.sleep(900)
            val m = measure()
            finding("  typed '$QUERY' ($typed; the field's value '${jsText("(document.querySelector('$FIELD')||{}).value||''")}'); keyboard ${if (imeUp) "up" else "NOT up"}; rows ${m.rows}; popup ${m.describe()}")
            check("[$scheme] the typed list holds the core's ten rows", typed && filled && m.rows == TYPED_ROWS, "rows ${m.rows}")
            if (imeUp && m.insetPx > 100) claimBounded(m) else check("[$scheme] the keyboard is up for the typed scene", false, "inset ${m.insetPx}")
            steadyShot("04-typed-ten-rows-$scheme-tablet")
            closeField()
        }
    }

    /** The claims on a popup with the keyboard up: bounded by the visible viewport, filling it. */
    private fun claimBounded(m: Measure) {
        val room = m.window - m.top - OMNIBOX_POPUP_MARGIN - m.insetPx
        val expected = if (room > OMNIBOX_POPUP_MIN_HEIGHT) room else OMNIBOX_POPUP_MIN_HEIGHT.toDouble()
        check("[$scheme] the popup's computed max-height is window − top − 8 − inset", abs(m.maxHeight - expected) <= 1.0, "computed ${m.maxHeight}, expected ${"%.1f".format(expected)} (window ${m.window}, top ${m.top}, inset ${m.insetPx})")
        check("[$scheme] the popup's box ends 8 CSS px above the keyboard's top edge", abs(m.bottom - (m.keyboardTop - OMNIBOX_POPUP_MARGIN)) <= 1.5, "bottom ${m.bottom}, keyboard top ${m.keyboardTop}")
    }

    // --- the measure -------------------------------------------------------------------------------

    private class Measure(val json: JSONObject) {
        val top = json.optDouble("top", -1.0)
        val bottom = json.optDouble("bottom", -1.0)
        val left = json.optDouble("left", -1.0)
        val width = json.optDouble("width", -1.0)
        val height = json.optDouble("height", -1.0)
        val maxHeightRaw = json.optString("maxHeight")
        val maxHeight = maxHeightRaw.removeSuffix("px").toDoubleOrNull() ?: -1.0
        val listTop = json.optDouble("listTop", -1.0)
        val listBottom = json.optDouble("listBottom", -1.0)
        val scrollHeight = json.optDouble("scrollHeight", -1.0)
        val clientHeight = json.optDouble("clientHeight", -1.0)
        val scrollTop = json.optDouble("scrollTop", -1.0)
        val rows = json.optInt("rows", -1)
        val headings = json.optInt("headings", -1)
        val lastTop = json.optDouble("lastTop", -1.0)
        val lastBottom = json.optDouble("lastBottom", -1.0)
        val lastTitle = json.optString("lastTitle")
        val inset = json.optString("inset")
        val insetPx = inset.removeSuffix("px").toDoubleOrNull() ?: 0.0
        val pillBottom = json.optDouble("pillBottom", -1.0)
        val pillLeft = json.optDouble("pillLeft", -1.0)
        val pillWidth = json.optDouble("pillWidth", -1.0)
        val window = json.optDouble("window", -1.0)
        /** The keyboard's top edge in CSS px (the window's bottom less the host's inset). */
        val keyboardTop get() = window - insetPx

        fun describe(): String =
            "top ${top} bottom ${bottom} (height ${height}, computed max-height '${maxHeightRaw}'); list ${listTop}–${listBottom}, scroll ${scrollHeight}/${clientHeight}; last row '${lastTitle}' ${lastTop}–${lastBottom}; keyboard top ${keyboardTop}"
    }

    /** The popup, the list, the last row and the pill as the chrome's DOM has them, in CSS px. */
    private fun measure(): Measure {
        val raw = chromeValue(MEASURE_JS)
        return Measure(runCatching { JSONObject(raw.ifEmpty { "{}" }) }.getOrElse { JSONObject() })
    }

    /** A real swipe up inside the list: from near its bottom to near its top, slow, a hold before the lift so nothing flings. */
    private fun swipeListUp(m: Measure) {
        val x = m.left.toFloat() + m.width.toFloat() / 2f
        val from = screen(RectF(x, m.listBottom.toFloat() - 24f, x, m.listBottom.toFloat() - 24f))
        val travel = (m.listBottom - m.listTop - 48.0).toFloat() * density
        val finger = Finger()
        finger.down(from.centerX(), from.centerY())
        finger.moveBy(0f, -travel, 450)
        finger.hold(300)
        finger.up()
    }

    // --- the pill, the field, the tabs --------------------------------------------------------------

    /** Where the chrome's CSS px land on the screen: the chrome view's location. */
    private fun calibrate() {
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        originX = origin[0].toFloat()
        originY = origin[1].toFloat()
        finding("calibration: chrome view at ${originX.roundToInt()}/${originY.roundToInt()}, density $density")
    }

    /** A CSS rect of the chrome as screen px. */
    private fun screen(r: RectF): RectF =
        RectF(originX + r.left * density, originY + r.top * density, originX + r.right * density, originY + r.bottom * density)

    /**
     * A finger on the toolbar's address pill: the DOM's pill mapped to the screen, else the tree's
     * `Address` group (W6-E14's tablet lesson: the harness's `pillPoint` knows the phone's pill
     * alone).
     */
    private fun tapPill(): Boolean {
        val dom = domRect(ADDRESS_PILL)
        val p: PointF = if (dom != null) {
            val s = screen(dom)
            PointF(s.centerX(), s.centerY())
        } else {
            val found = findByLabelPrefix(PILL_LABEL) ?: findByLabelPrefix(NTP_PILL_LABEL)
            if (found == null || !touchable.contains(found.centerX(), found.centerY())) {
                finding("  no pill to tap (DOM none; tree $found; touchable $touchable)")
                return false
            }
            PointF(found.exactCenterX(), found.exactCenterY())
        }
        Finger().tap(p.x, p.y)
        return true
    }

    private fun openField(): Boolean {
        settle(8_000)
        SystemClock.sleep(500)
        if (!tapPill()) return false
        if (awaitField(8_000)) return true
        finding("  the pill's tap opened no field in 8 s (bar open ${urlbarOpen()}); the pill again")
        settle(6_000)
        SystemClock.sleep(500)
        if (!tapPill()) return false
        return awaitField(8_000)
    }

    private fun awaitField(timeoutMs: Long): Boolean = awaitChrome("!!document.querySelector('$FIELD')", timeoutMs)

    private fun fieldUp(): Boolean = chromeValue("String(!!document.querySelector('$FIELD'))") == "true"

    /** `count` rows in the list and none on its way out. */
    private fun awaitRows(count: Int, timeoutMs: Long): Boolean =
        awaitChrome("document.querySelectorAll('$ROWS').length>=$count&&!document.querySelector('$ROWS_LEAVING')", timeoutMs)

    /** The shared close of the field (DemoHarness.closeUrlField, by the chrome's state); a field left open fails the run by name. */
    private fun closeField() {
        val close = closeUrlField()
        if (!close.ok) {
            finding("  the field's close: ${close.describe()}")
            failures += "the field's close: ${close.describe()}"
        }
    }

    /**
     * A new tab as the active tab, the field closed: the seeded one while it is still at
     * `zen://newtab`, else a fresh one – the pick of scene 2 lands the new tab on the row's page,
     * and a field opened over a page edits its address (one row) rather than showing zero-suggest.
     */
    private fun showNewTab(): Boolean {
        settle(8_000)
        closeField()
        settle(8_000)
        if (activeTabId() != newTab) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(newTab)}}")
            SystemClock.sleep(800)
        }
        if (!awaitPageUrl(NEW_TAB_URL, 3_000)) {
            val was = activeUrl()
            val id = coreInvoke("tab.create", "{\"url\":${JSONObject.quote(NEW_TAB_URL)},\"active\":true}").trim().trim('"')
            finding("  the new tab $newTab is at $was (the pick's page): a fresh new tab ${id.ifEmpty { "(no id came back)" }}")
            if (id.isNotEmpty()) newTab = id
            SystemClock.sleep(800)
            if (!awaitPageUrl(NEW_TAB_URL, 10_000)) return false
            settle(6_000)
            if (fieldUp()) closeField()
        }
        SystemClock.sleep(600)
        ensureForeground()
        return true
    }

    /** The seeded tab as the active tab, the field closed. */
    private fun showTab(tabId: String, url: String): Boolean {
        settle(8_000)
        closeField()
        settle(8_000)
        if (activeTabId() != tabId) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
            SystemClock.sleep(800)
        }
        val there = awaitPageUrl(url, 10_000)
        SystemClock.sleep(600)
        ensureForeground()
        return there
    }

    private fun awaitPageUrl(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeUrl() == url) return true
            SystemClock.sleep(300)
        }
        return activeUrl() == url
    }

    private fun activeTabId(): String? = runCatching { activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() } }.getOrNull()
    private fun activeUrl(): String? = runCatching { activeCoreTab()?.optString("url")?.takeIf { it.isNotEmpty() } }.getOrNull()

    /** The chrome at rest between scenes: the store's word on the field agreeing with the DOM's, no sheet up. */
    private fun settle(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(150)
        }
        val ok = settled()
        if (!ok) Log.w(tag, "the chrome did not settle in $timeoutMs ms: bar open ${urlbarOpen()}, field up ${fieldUp()}")
        return ok
    }

    private fun settled(): Boolean {
        val storeOpen = "(((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true)"
        return chromeValue("String(($storeOpen===!!document.querySelector('$FIELD'))&&document.querySelectorAll('.zen-sheet').length===0)") == "true"
    }

    // --- the chrome -------------------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun jsText(code: String): String = chromeValue("String($code)")

    private fun formFactor(): String = chromeValue("document.documentElement.dataset.formFactor||''")

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /** The bounding rect (CSS px) of the first element `selector` matches; null when none. */
    private fun domRect(selector: String): RectF? {
        val raw = chromeValue("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var b=e.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom].join(',')})()")
        val edges = raw.split(',').mapNotNull { it.toFloatOrNull() }
        if (edges.size != 4) return null
        return RectF(edges[0], edges[1], edges[2], edges[3])
    }

    /** An element's place on screen (the fence's marker), or null when `elementJs` finds nothing. */
    private fun rectOnScreen(elementJs: String): Rect? {
        val edges = chromeValue("(function(){var r=$elementJs;if(!r)return '';var b=r.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom].join(',')})()")
            .split(',').mapNotNull { it.toDoubleOrNull() }
        if (edges.size != 4) return null
        return Rect(
            (originX + edges[0] * density).roundToInt(), (originY + edges[1] * density).roundToInt(),
            (originX + edges[2] * density).roundToInt(), (originY + edges[3] * density).roundToInt()
        )
    }

    // --- the stills -------------------------------------------------------------------------------

    /**
     * The still once the pixels have caught up with the DOM, by W6-E14's FRAME FENCE: two frames
     * of the document first; then a magenta marker the document draws over the field's leading
     * edge (else the pill's) is awaited on the screen, removed, and awaited gone – the first frame
     * without it was composed after the removal, so all else in it is at least as current as the
     * document at the fence. Each wait bounded by [FENCE_MS] and logged when it runs out.
     */
    private fun steadyShot(name: String) {
        chromeJs("(function(){window.__zenPainted=false;requestAnimationFrame(function(){requestAnimationFrame(function(){window.__zenPainted=true})});return 1})()")
        awaitChrome("window.__zenPainted===true", 8_000)
        val started = SystemClock.uptimeMillis()
        chromeJs(
            "(function(){var m=document.getElementById('$FENCE_ID');if(!m){m=document.createElement('div');m.id='$FENCE_ID';document.body.appendChild(m)}" +
                "var a=$FENCE_ANCHOR_JS;var b=a?a.getBoundingClientRect():{left:0,top:0,height:20};" +
                "m.style.cssText='position:fixed;left:'+(b.left+2)+'px;top:'+(b.top+(b.height-10)/2)+'px;width:10px;height:10px;background:#ff00ff;z-index:2147483647;pointer-events:none';return 1})()"
        )
        val at = rectOnScreen("document.getElementById('$FENCE_ID')")
        val seen = at?.let { awaitFence(it, present = true) }
        seen?.recycle()
        if (seen == null) Log.w(tag, "still $name: the fence's marker never showed on the screen in $FENCE_MS ms (at $at)")
        chromeJs("(function(){var m=document.getElementById('$FENCE_ID');if(m)m.parentNode.removeChild(m);return 1})()")
        val still = at?.let { awaitFence(it, present = false) }
        if (still == null) {
            Log.w(tag, "still $name: the fence's marker never left the screen in $FENCE_MS ms (at $at); the next read")
            shot(name, softBitmap(ui.takeScreenshot() ?: return))
            return
        }
        Log.i(tag, "still $name: the fence passed in ${SystemClock.uptimeMillis() - started} ms (the marker ${if (seen != null) "seen" else "NOT seen"} at $at)")
        shot(name, still)
    }

    private fun awaitFence(at: Rect, present: Boolean): Bitmap? {
        val deadline = SystemClock.uptimeMillis() + FENCE_MS
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(FENCE_STEP_MS)
            val read = softBitmap(ui.takeScreenshot() ?: continue)
            if (markerAt(read, at) == present) return read
            read.recycle()
        }
        return null
    }

    private fun markerAt(read: Bitmap, at: Rect): Boolean {
        val sx = if (width > 0) read.width.toDouble() / width else 1.0
        val sy = if (height > 0) read.height.toDouble() / height else 1.0
        val x = (at.centerX() * sx).roundToInt().coerceIn(0, read.width - 1)
        val y = (at.centerY() * sy).roundToInt().coerceIn(0, read.height - 1)
        val p = read.getPixel(x, y)
        return Color.red(p) > 180 && Color.green(p) < 90 && Color.blue(p) > 180
    }

    private fun softBitmap(shot: Bitmap): Bitmap =
        if (shot.config == Bitmap.Config.HARDWARE) shot.copy(Bitmap.Config.ARGB_8888, false).also { shot.recycle() } else shot

    // --- the record -------------------------------------------------------------------------------

    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
            ensureForeground()
            for (i in 1..4) {
                settle(6_000)
                if (!chromeSurfaceUp() && !urlbarOpen() && !fieldUp()) break
                back()
                SystemClock.sleep(1_000)
            }
            settle(8_000)
        }
    }

    /** A claim of the sequence: written down either way; one that did not hold fails the run at the end. */
    private fun check(claim: String, held: Boolean, detail: String) {
        if (held) {
            finding("  OK   $claim ($detail)")
            return
        }
        finding("  FAIL $claim ($detail)")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the site ---------------------------------------------------------------------------------

    /** The demo page, the eight recent pages, the seeded engine's results and suggest endpoints. */
    private fun routes(): Map<String, Pair<String, ByteArray>> {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        routes["/"] = html("Tablet omnibox keyboard demo", "<p>Tap the address pill: the suggestions end above the keyboard.</p>")
        for (i in 1..PAGES) routes[pagePath(i)] = html(pageTitle(i), "<p>Recent page $i of $PAGES, a row of zero-suggest.</p>")
        routes["/search"] = results()
        routes["/suggest"] = suggestions("reading list ideas", "recipes for dinner", "recent earthquakes")
        return routes
    }

    private fun html(title: String, body: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}@media (prefers-color-scheme:dark){body{color:#f3f3f5;background:#1c1b22}}</style></head><body><h1>$title</h1>$body</body></html>"
            ).toByteArray()

    private fun results(): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Notes</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px}</style>" +
                "</head><body><h1>Notes</h1><p id=q></p><script>var q=new URLSearchParams(location.search).get('q')||'';" +
                "document.title='Notes: '+q;document.getElementById('q').textContent='Results for \"'+q+'\"';</script></body></html>"
            ).toByteArray()

    private fun suggestions(vararg rows: String): Pair<String, ByteArray> =
        "application/json; charset=utf-8" to ("[\"\",[" + rows.joinToString(",") { JSONObject.quote(it) } + "]]").toByteArray()

    private fun pageUrlFor(title: String): String? = (1..PAGES).firstOrNull { pageTitle(it) == title }?.let { pageUrl(it) }

    companion object {
        private const val PORT = 18193
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val HOME_URL = "$ORIGIN/"
        private const val NEW_TAB_URL = "zen://newtab"
        private const val HOME_TAB = "tab_home"
        private const val NEW_TAB = "tab_new"
        private const val ENGINE_ID = "custom:notes"
        /**
         * The eight recent pages, most recent first in zero-suggest under the four searches. The
         * demo page's own visit (the warm-up's) is the most recent, so the section holds it and
         * pages 1–7 – the twelfth row is 'Recent page 7' (the core's eight-page ceiling).
         */
        private const val PAGES = 8
        private fun pagePath(i: Int) = "/recent-$i.html"
        private fun pageUrl(i: Int) = "$ORIGIN${pagePath(i)}"
        private fun pageTitle(i: Int) = "Recent page $i"
        /** The four remembered searches, the "Recent searches" section over the pages. */
        private val SEARCHES = listOf("reading list ideas", "recipes for dinner", "recent earthquakes", "red panda facts")
        private const val ZERO_SUGGEST_ROWS = 12
        /** The core's ceiling on a typed list (`MAX_ROWS` in core/suggestions.ts). */
        private const val TYPED_ROWS = 10
        /** A typed start every seeded page's title and the engine's three rows answer to. */
        private const val QUERY = "re"

        /** `omniboxPopup.ts`'s numbers and `Urlbar.tsx`'s `POPUP_GAP`. */
        private const val OMNIBOX_POPUP_MIN_HEIGHT = 120
        private const val OMNIBOX_POPUP_MARGIN = 8
        private const val POPUP_GAP = 4
        /** The popup's natural height with a full list: the field's row under the top border (63) + the list's cap (520) + the bottom border (1). */
        private const val NATURAL_HEIGHT = 584.0

        private const val FENCE_ID = "__zenFence"
        private const val FENCE_ANCHOR_JS = "(document.querySelector('[data-testid=\"urlbar-input\"]')||document.querySelector('.zen-tablet-toolbar [data-address-pill]'))"
        private const val FENCE_STEP_MS = 200L
        private const val FENCE_MS = 15_000L

        /** The chrome's DOM: the tablet toolbar's pill, the field, the popup, the list's rows. */
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val POPUP = ".zen-omnibox[data-attached=\"true\"]"
        private const val LIST = "#zen-omnibox-results"
        private const val ROWS = "#zen-omnibox-results > li[data-kind]:not([data-leaving])"
        private const val ROWS_LEAVING = "#zen-omnibox-results > li[data-leaving]"
        private const val SEARCH_ROWS = "#zen-omnibox-results > li[data-kind=\"search\"]:not([data-leaving])"

        /**
         * The popup, the list, the rows, the pill and the root's inset as the DOM has them (CSS
         * px): the popup's box and its computed `max-height` (CSS resolves the `max()`/`calc()`
         * to a length), the list's box and scroll extents, the rows not on their way out and the
         * last one's box and title, the heading count, the pill's box, the window's height.
         */
        private val MEASURE_JS = """
            (function () {
              var p = document.querySelector('$POPUP');
              var l = document.querySelector('$LIST');
              var pill = document.querySelector('$ADDRESS_PILL');
              var out = { window: window.innerHeight, inset: getComputedStyle(document.documentElement).getPropertyValue('--zen-inset-bottom').trim() };
              if (pill) { var pb = pill.getBoundingClientRect(); out.pillBottom = pb.bottom; out.pillLeft = pb.left; out.pillWidth = pb.width; }
              if (!p || !l) return JSON.stringify(out);
              var pr = p.getBoundingClientRect();
              var lr = l.getBoundingClientRect();
              var items = Array.prototype.slice.call(l.children).filter(function (e) { return !e.hasAttribute('data-leaving'); });
              var rows = items.filter(function (e) { return e.hasAttribute('data-kind'); });
              var last = rows.length ? rows[rows.length - 1] : null;
              var lb = last ? last.getBoundingClientRect() : null;
              var title = last ? last.querySelector('.zen-omnibox-row-title') : null;
              out.top = pr.top; out.bottom = pr.bottom; out.left = pr.left; out.width = pr.width; out.height = pr.height;
              out.maxHeight = getComputedStyle(p).maxHeight;
              out.listTop = lr.top; out.listBottom = lr.bottom;
              out.scrollHeight = l.scrollHeight; out.clientHeight = l.clientHeight; out.scrollTop = l.scrollTop;
              out.rows = rows.length; out.headings = items.length - rows.length;
              out.lastTop = lb ? lb.top : -1; out.lastBottom = lb ? lb.bottom : -1;
              out.lastTitle = title ? title.textContent.trim() : '';
              return JSON.stringify(out);
            })()
        """.trimIndent()
    }
}
