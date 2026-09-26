package app.zen.chromium

import android.graphics.RectF
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
import kotlin.math.roundToInt

/**
 * Drives the CLASS-CHANGE SEAM of the page tabs (W6-S1, #499) on a `pixel_tablet` AVD laid out
 * at 1280 x 800 dp, one px per dp (`DEMO_DISPLAY=1280x800@160`, the tablet layout demo's
 * display): the tablet holds `zen://history` as a tab; `wm size 1280x590` narrows the window
 * under the 600 dp line into the PHONE class, and the page follows the window's class – the tab
 * is handed to the phone's surface (`PageService.reconcileLayout`: the History panel up, no tab
 * holding the page, the tab it was opened over active again, nothing in Recently closed), and
 * widened back with the panel up, the panel gives way to the tab again (the reverse seam,
 * `useStageContinuity`). Once in each colour scheme – light, then dark by the core's setting and
 * the system's night mode – so the recording shows both.
 *
 * The sequence, per scheme, in one Browse space of three loose tabs served by the driver's own
 * [DemoServer] (nothing from the network), the History page's rows a seeded history:
 *  1. the app menu's History row (a real touch) opens `zen://history` as a tab beside the sites –
 *     the tablet's route (v2 §10.1); the sidebar carries its row, no panel is up;
 *  2. `wm size 1280x590`: the phone chrome; the History panel stands over the page
 *     (`uiStore.overlay === 'history'`, `.zen-phone-panel` drawn), no tab of the core holds
 *     `zen://history`, the active tab is the site the page was opened over, Recently closed
 *     lists nothing (the hand-over is no close of the user's);
 *  3. `wm size 1280x800` with the panel up: the tablet again, the panel gone and `zen://history`
 *     a tab, active (the reverse);
 *  4. `wm size 1280x590` once more: the panel again (the loop holds); the system back takes it
 *     down the phone's way, the site under it;
 *  5. `wm size 1280x800`: the tablet with no History tab (nothing was up to hand back) – the
 *     seeded three alone.
 *
 * Every claim is read off the core's state (`app.getState`, `session.recentlyClosed`) or the
 * chrome's own stores and DOM (`window.__zenStores`, the root's `data-form-factor`), never off
 * the accessibility tree; a claim that does not hold fails the run at the end, the sequence
 * running on so the recording shows the rest. Same handshake as the other demos, under
 * `files/page-class-seam-demo/`; stills land there as `page-class-seam-<scheme>-<step>.png`, the
 * claims as `findings.txt`.
 */
@RunWith(AndroidJUnit4::class)
class PageClassSeamDemo : DemoHarness("page-class-seam-demo-state.json", "page-class-seam", "page-class-seam-demo") {
    override val tag = "PageClassSeamDemo"

    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    /** CSS px of the chrome to screen px: `screen = offset + css * density`, read off the pill ([calibrate]). */
    private var offsetX = 0f
    private var offsetY = 0f

    /** The scheme the stills are named for. */
    private var scheme = "light"

    @Test
    fun record() {
        server = DemoServer(PORT, PAGES.mapValues { (_, page) -> DemoServer.page(page.first, page.second) }).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("claims that did not hold:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    /** The History page's rows: a seeded history, its stamps relative to now. */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = STAMP.replace(readAsset("fakebox-morph-demo-history.json")) { m ->
            val hours = m.groupValues[1].toLongOrNull() ?: 0L
            (now - hours * 3_600_000L).toString()
        }
        File(zen, "history.json").writeText(history)
    }

    override fun warmUp() {
        shellCommand("cmd uimode night no")
        SystemClock.sleep(2_000)
        ensureForeground()
        finding("Zenium Android page-class seam (window ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        check("the chrome laid the window out as the tablet", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        awaitLoaded(HOME_TAB, "$ORIGIN/")
        calibrate()
        // Pay for the first layout of the menu off camera (the emulator lays it out slowly the
        // first time), and let the History page's chunk come in once.
        tapDom(MENU_BUTTON, last = true)
        if (awaitJs(MENU_OPEN, true)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_000)
        finding("warm-up done: form factor ${formFactor()}, active ${activeTabId()}, tabs ${tabUrls()}")
    }

    override fun demo() {
        scheme = "light"
        sequence()
        // The dark scheme: the core's setting (the chrome re-inks) and the system's night mode
        // (the pages' `prefers-color-scheme`), then the same five steps.
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(2_500)
        ensureForeground()
        check("the chrome is still the tablet after the scheme change", awaitFormFactor("tablet", 10_000), "form factor ${formFactor()}")
        calibrate()
        scheme = "dark"
        sequence()
        shellCommand("cmd uimode night no")
    }

    private fun sequence() {
        finding("--- $scheme ---")
        val tabsBefore = tabUrls()
        val openedOver = activeTabId()
        check("[$scheme] the sequence starts on a site tab with no History tab in the space", openedOver != null && tabUrl(openedOver)?.startsWith(ORIGIN) == true && HISTORY_URL !in tabsBefore, "active $openedOver, tabs $tabsBefore")

        // --- 1. the History tab on the tablet ---------------------------------------------------
        // The tablet's route, under a finger: the ⋯, the History row (a submenu on the sidebar
        // layouts – its cascade level opens), then Show Full History, whose click is the core's
        // `pages.open('history')`. The same route by the core's command when a row is not found,
        // so the seam's own claims still run.
        tapDom(MENU_BUTTON, last = true)
        check("[$scheme] the toolbar's ⋯ opens the app menu", awaitJs(MENU_OPEN, true, 5_000), "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(800)
        var touched = false
        val history = screen(domRectWhere(menuRow("History")))
        if (history != null) {
            Finger().tap(history.centerX(), history.centerY())
            if (awaitTrue(3_000) { domRectWhere(menuRow("Show Full History")) != null }) {
                SystemClock.sleep(600)
                val full = screen(domRectWhere(menuRow("Show Full History")))
                if (full != null) {
                    Finger().tap(full.centerX(), full.centerY())
                    touched = true
                }
            }
        }
        if (!touched) {
            finding("the app menu's History rows were not found under the finger (History ${history != null}); the core's route instead (page.open)")
            back()
            awaitJs(MENU_OPEN, false)
            coreInvoke("page.open", "{\"id\":\"history\"}")
        }
        check("[$scheme] History opens as a tab on the tablet (the page is one of the tablet's tabs, v2 §10.1)${if (touched) ", from the app menu under a finger" else ""}", awaitActiveUrl(HISTORY_URL, 8_000), "active ${activeTabId()} at ${activeUrl()}")
        awaitJs(MENU_OPEN, false, 3_000)
        val historyTab = activeTabId()
        check("[$scheme] the page is drawn as the tablet's History page, no panel over it", awaitDom(HISTORY_PAGE, 8_000) && jsText(OVERLAY) == "none" && domRect(PHONE_PANEL) == null, "page ${domRect(HISTORY_PAGE)}, overlay ${jsText(OVERLAY)}")
        check("[$scheme] the sidebar carries the History tab's row", historyTab != null && awaitDom(row(historyTab), 4_000), "row ${historyTab?.let { domRect(row(it)) }}")
        val closedBefore = recentlyClosed()
        SystemClock.sleep(1_500)
        shot("$scheme-01-tablet-history-tab")

        // --- 2. narrowed into the phone class: the hand-over ------------------------------------
        resize("1280x590")
        check("[$scheme] at 1280 x 590 the chrome swaps to the phone layout", awaitFormFactor("phone", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        check("[$scheme] the History tab is handed to the phone's surface: the History panel is up", awaitJs("$OVERLAY==='history'", true, 8_000) && awaitDom(PHONE_PANEL, 8_000), "overlay ${jsText(OVERLAY)}, panel ${domRect(PHONE_PANEL)}")
        check("[$scheme] no tab of the core holds zen://history any more", awaitTrue(5_000) { HISTORY_URL !in tabUrls() }, "tabs ${tabUrls()}")
        check("[$scheme] the tab the page was opened over is active again", activeTabId() == openedOver, "active ${activeTabId()} (opened over $openedOver)")
        check("[$scheme] the hand-over left nothing in Recently closed (it is no close of the user's)", recentlyClosed() == closedBefore, "recently closed ${recentlyClosed()} (were $closedBefore)")
        check("[$scheme] the History page's DOM is gone with its tab", domRect(HISTORY_PAGE) == null, "page ${domRect(HISTORY_PAGE)}")
        SystemClock.sleep(2_000)
        shot("$scheme-02-phone-history-panel")

        // --- 3. widened back with the panel up: the reverse -------------------------------------
        resize("1280x800")
        check("[$scheme] at 1280 x 800 the chrome is the tablet again", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        check("[$scheme] the panel gives way to the page's tab: zen://history is a tab again, active", awaitActiveUrl(HISTORY_URL, 8_000), "active ${activeTabId()} at ${activeUrl()}, tabs ${tabUrls()}")
        check("[$scheme] and no panel stands over the tablet chrome", awaitJs("$OVERLAY==='none'", true, 5_000) && awaitDomGone(PHONE_PANEL, 5_000), "overlay ${jsText(OVERLAY)}, panel ${domRect(PHONE_PANEL)}")
        check("[$scheme] the tablet's History page is drawn", awaitDom(HISTORY_PAGE, 8_000), "page ${domRect(HISTORY_PAGE)}")
        SystemClock.sleep(2_000)
        calibrate()
        shot("$scheme-03-tablet-history-tab-again")

        // --- 4. narrowed again, and the panel taken down the phone's way ------------------------
        resize("1280x590")
        check("[$scheme] narrowed again, the panel is up once more (the loop holds)", awaitFormFactor("phone", 15_000) && awaitJs("$OVERLAY==='history'", true, 8_000) && awaitTrue(5_000) { HISTORY_URL !in tabUrls() }, "form factor ${formFactor()}, overlay ${jsText(OVERLAY)}, tabs ${tabUrls()}")
        SystemClock.sleep(1_500)
        back()
        check("[$scheme] the system back takes the panel down, the site under it", awaitJs("$OVERLAY==='none'", true, 5_000) && awaitDomGone(PHONE_PANEL, 5_000) && activeTabId() == openedOver, "overlay ${jsText(OVERLAY)}, active ${activeTabId()}")
        SystemClock.sleep(1_500)
        shot("$scheme-04-phone-panel-closed")

        // --- 5. widened with nothing up: nothing comes back --------------------------------------
        resize("1280x800")
        check("[$scheme] widened with no panel up, the tablet has no History tab: the seeded tabs alone", awaitFormFactor("tablet", 15_000) && awaitTrue(3_000) { tabUrls() == tabsBefore }, "tabs ${tabUrls()} (were $tabsBefore)")
        check("[$scheme] and the same site tab active", activeTabId() == openedOver, "active ${activeTabId()}")
        SystemClock.sleep(2_000)
        calibrate()
        shot("$scheme-05-tablet-no-history-tab")
    }

    // --- the display ------------------------------------------------------------------------------

    /** `wm size` to `size` (`WxH`, px at the run's density) and a moment for the window to re-lay out. */
    private fun resize(size: String) {
        finding("wm size $size")
        shellCommand("wm size $size")
        SystemClock.sleep(3_000)
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        finding("window now ${width}x$height, insets ${insets.top}/${insets.bottom}, form factor ${formFactor()}, viewport ${viewportText()}")
    }

    // --- the chrome's geometry --------------------------------------------------------------------

    /**
     * Where the chrome's CSS px land on the screen: the toolbar's address pill read from the DOM
     * and from the accessibility tree, the difference the offset (the tablet layout demo's
     * reading; the scale is the display's density, one at `wm density 160`).
     */
    private fun calibrate() {
        val dom = domRect(ADDRESS_PILL)
        val tree = findByLabelPrefix(PILL_LABEL)
        if (dom == null || tree == null) {
            finding("calibration: pill DOM $dom, tree $tree; keeping offsets $offsetX/$offsetY")
            return
        }
        offsetX = tree.left - dom.left * density
        offsetY = tree.top - dom.top * density
        finding("calibration: pill DOM $dom x$density -> tree $tree; offsets ${offsetX.roundToInt()}/${offsetY.roundToInt()}")
    }

    /** A CSS rect of the chrome as screen px. */
    private fun screen(r: RectF?): RectF? = r?.let {
        RectF(offsetX + it.left * density, offsetY + it.top * density, offsetX + it.right * density, offsetY + it.bottom * density)
    }

    /** The bounding rect (CSS px) of the first – or with `last`, the last – element `selector` matches; null when none. */
    private fun domRect(selector: String, last: Boolean = false): RectF? = domRectWhere(
        "(function(){var a=document.querySelectorAll(${JSONObject.quote(selector)});return a.length?a[${if (last) "a.length-1" else "0"}]:null})()"
    )

    /** The bounding rect (CSS px) of the element the JS expression `element` evaluates to; null when none. */
    private fun domRectWhere(element: String): RectF? {
        val raw = chromeJs("(function(){var e=($element);if(!e)return null;var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()")
        if (raw.isEmpty() || raw == "null") return null
        val a = JSONArray(raw)
        val l = a.getDouble(0).toFloat()
        val t = a.getDouble(1).toFloat()
        return RectF(l, t, l + a.getDouble(2).toFloat(), t + a.getDouble(3).toFloat())
    }

    /** A real touch on the middle of the element `selector` matches; false (and a note) when there is none. */
    private fun tapDom(selector: String, last: Boolean = false): Boolean {
        val target = screen(domRect(selector, last)) ?: run {
            finding("no element for $selector to tap")
            return false
        }
        Finger().tap(target.centerX(), target.centerY())
        return true
    }

    private fun awaitDom(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) != null }

    private fun awaitDomGone(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) == null }

    // --- the chrome's state -----------------------------------------------------------------------

    private fun formFactor(): String = jsText("document.documentElement.dataset.formFactor")
    private fun viewportText(): String = jsText("(function(){var v=window.__zenStores.viewport.get();return v.width+'x'+v.height+' '+v.formFactor+(v.coarse?' coarse':'')})()")

    private fun awaitFormFactor(expected: String, timeoutMs: Long = 10_000): Boolean = awaitTrue(timeoutMs) { formFactor() == expected }

    /** Poll the boolean `code` evaluates to in the chrome until it is `expected`. */
    private fun awaitJs(code: String, expected: Boolean, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { jsBoolean(code) == expected }

    private fun jsBoolean(code: String): Boolean = chromeJs("!!($code)") == "true"

    /** The value `code` evaluates to, as text (a string unquoted; anything else as its JSON). */
    private fun jsText(code: String): String {
        val raw = chromeJs("(function(){var v=($code);return v===undefined?'undefined':(typeof v==='string'?v:JSON.stringify(v))})()")
        if (raw.isEmpty()) return ""
        return runCatching { (JSONTokener(raw).nextValue() as? String) ?: raw }.getOrDefault(raw)
    }

    // --- the core's state -------------------------------------------------------------------------

    private fun activeTabId(): String? = activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() }
    private fun activeUrl(): String? = activeCoreTab()?.optString("url")?.takeIf { it.isNotEmpty() }
    private fun tabUrl(tabId: String): String? = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("url")

    private fun awaitActiveUrl(url: String, timeoutMs: Long = 5_000): Boolean = awaitTrue(timeoutMs) { activeUrl() == url }

    /** The Browse space's tabs' URLs in the core's order. */
    private fun tabUrls(): List<String> {
        val state = coreState()
        val spaces = state.getJSONArray("spaces")
        val tabs = state.getJSONObject("tabs")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") != SPACE) continue
            val ids = space.getJSONArray("tabIds")
            return (0 until ids.length()).map { tabs.optJSONObject(ids.getString(it))?.optString("url") ?: "?" }
        }
        return emptyList()
    }

    /** The Recently closed entries the core lists (`session.recentlyClosed`), by their URLs. */
    private fun recentlyClosed(): List<String> {
        val raw = coreInvoke("session.recentlyClosed")
        val json = runCatching { JSONArray(raw) }.getOrNull() ?: return listOf("unreadable: $raw")
        return (0 until json.length()).map { i ->
            val entry = json.optJSONObject(i) ?: return@map json.opt(i).toString()
            entry.optString("url").takeIf { it.isNotEmpty() } ?: entry.optString("title", entry.toString())
        }
    }

    // --- the pages --------------------------------------------------------------------------------

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return
            SystemClock.sleep(250)
        }
        finding("gave up waiting for $url in $tabId")
    }

    // --- the record -------------------------------------------------------------------------------

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    /** A claim of the sequence: written down either way; one that did not hold fails the run at the end. */
    private fun check(claim: String, held: Boolean, detail: String) {
        if (held) {
            finding("OK   $claim${if (detail.isNotEmpty()) " ($detail)" else ""}")
            return
        }
        finding("FAIL $claim ($detail)")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    companion object {
        private const val PORT = 18166
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val SPACE = "space_browse"
        private const val HOME_TAB = "tab_home"
        private const val HISTORY_URL = "zen://history"

        /** The chrome's roots and controls, by the attributes the components carry (the tablet layout demo's). */
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        /** The ⋯: the nav row's last own button with a menu (the pill's chips are inside the pill). */
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        /**
         * The app menu's row labelled `label`: the popover's `menuitem`s at every cascade level
         * share `.zen-v2-menu-item`, the label its own span (`MenuSheet`'s row: glyph, label, an
         * optional hint, a submenu's chevron), so a hint never joins the match.
         */
        private fun menuRow(label: String) =
            "[...document.querySelectorAll('.zen-v2-menu .zen-v2-menu-item')].find(function(e){" +
                "var l=e.querySelector('span.flex-1');return (l?l.textContent:e.textContent).trim()===${JSONObject.quote(label)}})"
        /** The tablet's History page (`InternalPageHost` → `HistoryPage`) and the phone's panel (`OverlayShell` with `PhoneHistoryPanel`). */
        private const val HISTORY_PAGE = ".zen-history-page"
        private const val PHONE_PANEL = ".zen-phone-panel"

        /** Reads off the chrome's stores (`lib/store.ts` registers them on `window.__zenStores`). */
        private const val MENU_OPEN = "window.__zenStores.ui.get().menu!==null"
        private const val OVERLAY = "window.__zenStores.ui.get().overlay"

        private fun row(tabId: String) = ".zen-tablet-sidebar [data-tab-id=\"$tabId\"]"

        /** The seeded history's stamps, `"{{now-Nh}}"`, to epoch ms (the fakebox morph demo's seed). */
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)h)?\\}\\}\"")

        /** The pages the seeded tabs point at, path to title and body. */
        private val PAGES: Map<String, Pair<String, String>> = mapOf(
            "/" to ("Seam demo" to prose("The page-class seam demo's home page.", 12)),
            "/web.html" to ("World Wide Web" to prose("The World Wide Web is an information system of interlinked documents.", 20)),
            "/tablets.html" to ("Tablet computer" to prose("A tablet is a mobile device with a touchscreen display.", 20))
        )

        private fun prose(lead: String, paragraphs: Int): String =
            (1..paragraphs).joinToString("") { "<p>$lead Paragraph $it of $paragraphs.</p>" }
    }
}
