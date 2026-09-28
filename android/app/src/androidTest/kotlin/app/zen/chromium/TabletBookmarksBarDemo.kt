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
 * Drives the TABLET'S BOOKMARKS BAR (NTP-34, W6-E16: the desktop shell's bar mounted under the
 * tablet toolbar beside the sidebar, `TabletShell.tsx`) on a `pixel_tablet` AVD laid out at
 * 1280 x 800 dp, one px per dp (`DEMO_DISPLAY=1280x800@160`, the tablet layout demo's display),
 * once in each colour scheme – light, then dark by the core's setting and the system's night
 * mode – so the stills show both. Every touch is a finger's ([Finger]); a touch that does not
 * take is a [touchFault].
 *
 * The sequence, per scheme, in one Browse space of three loose tabs served by the driver's own
 * [DemoServer] (nothing from the network), the bookmarks bar seeded with sixteen children – two
 * of them folders – so the strip overflows at the tablet's width:
 *  1. the shared default, Only on new tab page: no bar over a site tab;
 *  2. the app menu's Settings row (a real touch) opens `zen://settings` as a tab, the Look and
 *     Feel category under a finger; the Show bookmarks bar row's menulist reads the default;
 *  3. the menulist under a finger opens its picker – the tablet's sheet of three radio rows
 *     (`MenulistSheet`, a coarse pointer's popup) – and Always under a finger closes it: the
 *     setting reads `always` and the bar stands at the head of the content column, under the
 *     toolbar row, beside the sidebar, over the Settings page, with a » for the chips that do
 *     not fit;
 *  4. the sidebar's row for a site tab (a touch): the bar stays over the page;
 *  5. the Work folder chip under a finger: its panel – the tablet's 332 popover with 44 rows,
 *     not a sheet – lists Board, Tracker and Team wiki; the same chip again closes it;
 *  6. the » under a finger: the overflow panel lists exactly the chips the strip hid; the same
 *     button again closes it;
 *  7. back at Settings, Never under a finger: no bar over the Settings page;
 *  8. Only on new tab page under a finger (the default again): still no bar over Settings; the
 *     sidebar's New Tab row under a finger opens `zen://newtab`, where the bar stands – the new
 *     tab page alone shows it; the new tab and the Settings tab are then closed by the core
 *     (a way back to the start, not a claim) so the dark run begins where the light one did.
 *
 * Every claim is read off the core's state (`app.getState`) or the chrome's own DOM and stores
 * (`window.__zenStores`), never off the accessibility tree; a claim that does not hold fails
 * the run at the end, the sequence running on so the recording shows the rest. Same handshake
 * as the other demos, under `files/tablet-bookmarks-bar-demo/`; stills land there as
 * `tablet-bookmarks-bar-<scheme>-<step>.png`, the claims as `findings.txt`.
 */
@RunWith(AndroidJUnit4::class)
class TabletBookmarksBarDemo : DemoHarness("tablet-bookmarks-bar-demo-state.json", "tablet-bookmarks-bar", "tablet-bookmarks-bar-demo") {
    override val tag = "TabletBookmarksBarDemo"

    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

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

    override fun warmUp() {
        shellCommand("cmd uimode night no")
        SystemClock.sleep(2_000)
        ensureForeground()
        finding("Zenium Android tablet bookmarks bar (window ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        check("the chrome laid the window out as the tablet", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        awaitLoaded(HOME_TAB, "$ORIGIN/")
        calibrate()
        // Pay for the first layout of the app menu off camera (the emulator lays it out slowly
        // the first time).
        tapDom(MENU_BUTTON, last = true, reveal = false)
        if (awaitJs(MENU_OPEN, true)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_000)
        finding("warm-up done: form factor ${formFactor()}, active ${activeTabId()}, tabs ${tabUrls()}, bookmarksBar ${barMode()}")
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
        check("the chrome is still the tablet after the scheme change", awaitFormFactor("tablet", 10_000), "form factor ${formFactor()}")
        calibrate()
        scheme = "dark"
        sequence()
        shellCommand("cmd uimode night no")
    }

    private fun sequence() {
        finding("--- $scheme ---")
        val tabsBefore = tabUrls()
        val siteTab = activeTabId()

        // --- 1. the shared default: no bar over a site ------------------------------------------
        check("[$scheme] the setting starts at Only on new tab page (the shared default)", barMode() == "newtab", "bookmarksBar ${barMode()}")
        check("[$scheme] no bookmarks bar over a site tab under Only on new tab page", siteTab != null && tabUrl(siteTab)?.startsWith(ORIGIN) == true && domRect(BAR) == null, "active $siteTab at ${activeUrl()}, bar ${domRect(BAR)}")

        // --- 2. Settings › Look and Feel under a finger -----------------------------------------
        val settingsTab = openLookAndFeel()
        check("[$scheme] Settings opens as a tab on the tablet, at Look and Feel", settingsTab != null && twoPaneSection() == LOOK_SECTION, "active ${activeTabId()} at ${activeUrl()}, section '${twoPaneSection()}'")
        check("[$scheme] the Show bookmarks bar row is listed, its menulist reading Only on new tab page", awaitDom(ROW_MENULIST, 8_000) && awaitTrue(3_000) { menulistReads() == "Only on new tab page" }, "menulist '${menulistReads()}'")
        check("[$scheme] and no bar over the Settings page (not the new tab page)", domRect(BAR) == null, "bar ${domRect(BAR)}")
        domRect(ROW_MENULIST, reveal = true)
        SystemClock.sleep(1_200)
        shot("$scheme-01-settings-row")

        // --- 3. Always: the bar under the toolbar row -------------------------------------------
        pickMode("Always", "always", still = "$scheme-02-setting-sheet")
        check("[$scheme] the bar stands once the setting reads Always: under the toolbar row, beside the sidebar, at the head of the content column", awaitDom(BAR, 8_000) && barSeated(), "bar ${domRect(BAR)}, toolbar ${domRect(TOOLBAR)}, sidebar ${domRect(SIDEBAR)}, content ${domRect(CONTENT)}")
        check("[$scheme] the strip holds the bar's sixteen children, the ones that do not fit behind a »", chipCount() == BAR_CHILDREN && hiddenCount() > 0 && domRect(OVERFLOW) != null, "chips ${chipCount()}, hidden ${hiddenCount()}, » ${domRect(OVERFLOW)}")
        check("[$scheme] the chips and the » in the coarse pointer's sizes (40 chips, the 40 toolbar button)", chipHeight() == 40 && overflowSize() == "40x40", "chip ${chipHeight()}, » ${overflowSize()}")
        check("[$scheme] no chip is draggable under a finger", chromeJs("document.querySelectorAll('$CHIP[draggable]').length") == "0", "draggable chips ${chromeJs("document.querySelectorAll('$CHIP[draggable]').length")}")

        // --- 4. the bar over a page ---------------------------------------------------------------
        tapDom(row(WEB_TAB))
        check("[$scheme] the sidebar's row under a finger: the World Wide Web tab, the bar still up over the page", awaitTrue(8_000) { activeTabId() == WEB_TAB } && domRect(BAR) != null, "active ${activeTabId()}, bar ${domRect(BAR)}")
        if (activeTabId() != WEB_TAB) touchFault("a touch on the sidebar row of $WEB_TAB did not take (active ${activeTabId()})")
        SystemClock.sleep(1_500)
        shot("$scheme-03-bar")

        // --- 5. a folder under a finger -----------------------------------------------------------
        val work = screen(domRect(chip(WORK_FOLDER)))  // no reveal: the strip clips its overflow
        if (work != null) Finger().tap(work.centerX(), work.centerY()) else finding("no Work chip on the strip to tap")
        val folderOpen = awaitDom(PANEL, 8_000) && awaitTrue(3_000) { panelRows() == WORK_ROWS }
        check("[$scheme] the Work folder chip under a finger opens its panel: Board, Tracker, Team wiki", folderOpen, "panel ${domRect(PANEL)}, rows ${panelRows()}")
        if (work != null && !folderOpen) touchFault("a touch on the Work chip did not open its panel (rows ${panelRows()})")
        check("[$scheme] the panel is the tablet's popover menu, no sheet (§9.36)", jsBoolean("!!document.querySelector('$PANEL.zen-v2-menu')") && sheetsPresented().isEmpty() && panelRowHeight() == 44, "menu ${jsBoolean("!!document.querySelector('$PANEL.zen-v2-menu')")}, sheets ${sheetsPresented()}, row ${panelRowHeight()}")
        check("[$scheme] the chip reads expanded and the chrome holds the bar-menu flag", jsText("document.querySelector('${chip(WORK_FOLDER)}').getAttribute('aria-expanded')") == "true" && jsBoolean(BAR_MENU_OPEN), "expanded ${jsText("document.querySelector('${chip(WORK_FOLDER)}').getAttribute('aria-expanded')")}, flag ${jsBoolean(BAR_MENU_OPEN)}")
        SystemClock.sleep(1_500)
        shot("$scheme-04-folder")
        if (work != null) Finger().tap(work.centerX(), work.centerY())
        check("[$scheme] the same chip again closes the panel, and the tap's own click does not bring it back", staysGone(PANEL) && awaitJs(BAR_MENU_OPEN, false, 3_000), "panel ${domRect(PANEL)}, flag ${jsBoolean(BAR_MENU_OPEN)}")
        if (work != null && domRect(PANEL) != null) touchFault("a second touch on the Work chip did not close its panel")

        // --- 6. the » under a finger ------------------------------------------------------------
        val hiddenLabels = hiddenLabels()
        val more = screen(domRect(OVERFLOW))
        if (more != null) Finger().tap(more.centerX(), more.centerY()) else finding("no » on the strip to tap")
        val overflowOpen = awaitDom(PANEL, 8_000) && awaitTrue(3_000) { panelRows() == hiddenLabels }
        check("[$scheme] the » under a finger opens the overflow panel with exactly the chips the strip hid (${hiddenLabels.size})", overflowOpen, "rows ${panelRows()}, hidden $hiddenLabels")
        check("[$scheme] the » is named for what it hides", jsText("document.querySelector('$OVERFLOW').getAttribute('aria-label')") == "${hiddenLabels.size} more bookmarks", "label '${jsText("document.querySelector('$OVERFLOW').getAttribute('aria-label')")}'")
        if (more != null && !overflowOpen) touchFault("a touch on the » did not open the overflow panel (rows ${panelRows()})")
        SystemClock.sleep(1_500)
        shot("$scheme-05-overflow")
        if (more != null) Finger().tap(more.centerX(), more.centerY())
        check("[$scheme] the » again closes the overflow panel, and the tap's own click does not bring it back", staysGone(PANEL) && awaitJs(BAR_MENU_OPEN, false, 3_000), "panel ${domRect(PANEL)}, flag ${jsBoolean(BAR_MENU_OPEN)}")
        if (more != null && domRect(PANEL) != null) touchFault("a second touch on the » did not close the overflow panel")

        // --- 7. Never ----------------------------------------------------------------------------
        if (settingsTab != null) tapDom(row(settingsTab))
        check("[$scheme] the Settings tab's row under a finger brings the page back, the bar over it", settingsTab != null && awaitTrue(8_000) { activeTabId() == settingsTab } && domRect(BAR) != null, "active ${activeTabId()}, bar ${domRect(BAR)}")
        if (settingsTab != null && activeTabId() != settingsTab) touchFault("a touch on the sidebar row of $settingsTab did not take (active ${activeTabId()})")
        pickMode("Never", "never")
        check("[$scheme] Never: no bar over the Settings page", awaitDomGone(BAR, 8_000), "bar ${domRect(BAR)}")

        // --- 8. Only on new tab page: the new tab page alone -------------------------------------
        pickMode("Only on new tab page", "newtab")
        check("[$scheme] Only on new tab page: still no bar over the Settings page", domRect(BAR) == null, "bar ${domRect(BAR)}")
        tapDom(NEW_TAB_ROW)
        val ntp = awaitTrue(8_000) { activeUrl() == NEW_TAB_URL }
        check("[$scheme] the sidebar's New Tab row under a finger opens the new tab page", ntp, "active ${activeTabId()} at ${activeUrl()}")
        if (!ntp) touchFault("a touch on the sidebar's New Tab row did not open a new tab (active ${activeUrl()})")
        check("[$scheme] and the bar stands over the new tab page under Only on new tab page", awaitDom(BAR, 8_000) && chipCount() == BAR_CHILDREN, "bar ${domRect(BAR)}, chips ${chipCount()}")
        SystemClock.sleep(1_500)
        shot("$scheme-06-newtab-only")

        // Back to the start for the next scheme: the two tabs this sequence opened closed by the
        // core (a way to a state, not a claim), the site tab active again.
        val ntpTab = activeTabId()
        if (ntpTab != null && ntpTab != siteTab) coreInvoke("tab.close", JSONObject().put("tabId", ntpTab).put("force", true).toString())
        if (settingsTab != null) coreInvoke("tab.close", JSONObject().put("tabId", settingsTab).put("force", true).toString())
        if (siteTab != null) coreInvoke("tab.activate", JSONObject().put("tabId", siteTab).toString())
        check("[$scheme] the sequence ends where it began: the seeded tabs alone, a site active, no bar", awaitTrue(8_000) { tabUrls() == tabsBefore && activeTabId() == siteTab } && awaitDomGone(BAR, 5_000), "tabs ${tabUrls()} (were $tabsBefore), active ${activeTabId()}, bar ${domRect(BAR)}")
        SystemClock.sleep(1_000)
    }

    // --- the steps' touches -----------------------------------------------------------------------

    /**
     * Settings › Look and Feel under a finger: the toolbar's ⋯, the app menu's Settings row (the
     * tablet's route: the page as a tab, v2 §10.1), then the Look and Feel category in the
     * page's own navigation column. The core's route (`page.open`) when a menu row is not found
     * under the finger, so the bar's own claims still run. The Settings tab's id, or null.
     */
    private fun openLookAndFeel(): String? {
        tapDom(MENU_BUTTON, last = true, reveal = false)
        check("[$scheme] the toolbar's ⋯ opens the app menu", awaitJs(MENU_OPEN, true, 5_000), "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(800)
        val settings = screen(domRectWhere(menuRow("Settings"), reveal = true))
        var touched = false
        if (settings != null) {
            Finger().tap(settings.centerX(), settings.centerY())
            touched = awaitTrue(8_000) { activeUrl()?.startsWith(SETTINGS_URL) == true }
            if (!touched) touchFault("a touch on the app menu's Settings row did not open Settings (active ${activeUrl()})")
        }
        if (!touched) {
            finding("the app menu's Settings row was not found under the finger (row ${settings != null}); the core's route instead (page.open)")
            back()
            awaitJs(MENU_OPEN, false)
            coreInvoke("page.open", "{\"id\":\"settings\"}")
            if (!awaitTrue(8_000) { activeUrl()?.startsWith(SETTINGS_URL) == true }) return null
        }
        awaitJs(MENU_OPEN, false, 3_000)
        val tabId = activeTabId() ?: return null
        check("[$scheme] the Settings page is the two-pane page (a 1280 window)", awaitDom(TWO_PANE, 8_000), "page ${domRect(TWO_PANE)}")
        SystemClock.sleep(800)
        val look = screen(domRect(NAV_LOOK, reveal = true))
        if (look != null) {
            Finger().tap(look.centerX(), look.centerY())
            if (!awaitTrue(8_000) { twoPaneSection() == LOOK_SECTION }) touchFault("a touch on the Look and Feel category did not take (section '${twoPaneSection()}')")
        } else {
            finding("no Look and Feel category in the navigation column to tap; the core's route instead (page.navigate)")
            coreInvoke("page.navigate", JSONObject().put("tabId", tabId).put("section", LOOK_SECTION).toString())
            awaitTrue(8_000) { twoPaneSection() == LOOK_SECTION }
        }
        SystemClock.sleep(600)
        return tabId
    }

    /**
     * The Show bookmarks bar row's menulist under a finger, the option `option` under a finger
     * in the sheet it opens, and the setting read back as `value` off the core. With `still`,
     * a still of the open sheet before the pick.
     */
    private fun pickMode(option: String, value: String, still: String? = null) {
        val control = screen(domRect(ROW_MENULIST, reveal = true))
        if (control == null) {
            finding("no Show bookmarks bar menulist to tap")
            check("[$scheme] the Show bookmarks bar picker opens under a finger", false, "no menulist in the document")
            return
        }
        Finger().tap(control.centerX(), control.centerY())
        val up = awaitSheet(SHEET_TITLE, 8_000)
        check("[$scheme] the menulist under a finger opens the picker as the tablet's sheet, titled Show bookmarks bar", up && jsText("document.querySelector('$ROW_MENULIST').getAttribute('aria-haspopup')") == "dialog", "sheets ${sheetsPresented()}, haspopup '${jsText("document.querySelector('$ROW_MENULIST').getAttribute('aria-haspopup')")}'")
        if (!up) {
            touchFault("a touch on the Show bookmarks bar menulist did not open its sheet (sheets ${sheetsPresented()})")
            coreInvoke("settings.update", JSONObject().put("bookmarksBar", value).toString())
            awaitTrue(5_000) { barMode() == value }
            return
        }
        SystemClock.sleep(900)
        check("[$scheme] the sheet lists the three options as radio rows", radioLabels() == MODES, "rows ${radioLabels()}")
        if (still != null) shot(still)
        val row = screen(domRectWhere(radioRow(option), reveal = true))
        if (row == null) {
            touchFault("no '$option' radio row in the sheet under the finger (rows ${radioLabels()})")
            back()
            awaitSheetGone(SHEET_TITLE)
            coreInvoke("settings.update", JSONObject().put("bookmarksBar", value).toString())
            awaitTrue(5_000) { barMode() == value }
            return
        }
        Finger().tap(row.centerX(), row.centerY())
        val took = awaitSheetGone(SHEET_TITLE, 8_000) && awaitTrue(5_000) { barMode() == value }
        check("[$scheme] '$option' under a finger closes the sheet and the setting reads '$value'; the row's menulist reads it back", took && awaitTrue(3_000) { menulistReads() == option }, "bookmarksBar ${barMode()}, sheets ${sheetsPresented()}, menulist '${menulistReads()}'")
        if (!took) touchFault("a touch on the '$option' row did not take (bookmarksBar ${barMode()}, sheets ${sheetsPresented()})")
        SystemClock.sleep(800)
    }

    // --- the bar --------------------------------------------------------------------------------

    /** `settings.bookmarksBar` off the core. */
    private fun barMode(): String = coreState().optJSONObject("settings")?.optString("bookmarksBar") ?: ""

    /**
     * The bar's seat: its top at the toolbar row's bottom, its left at the sidebar's right (the
     * head of the content column), the content frame under it.
     */
    private fun barSeated(): Boolean {
        val bar = domRect(BAR) ?: return false
        val toolbar = domRect(TOOLBAR) ?: return false
        val sidebar = domRect(SIDEBAR) ?: return false
        val content = domRect(CONTENT) ?: return false
        return kotlin.math.abs(bar.top - toolbar.bottom) <= 1f &&
            kotlin.math.abs(bar.left - sidebar.right) <= 1f &&
            content.top >= bar.bottom - 1f &&
            bar.height().roundToInt() == 44
    }

    private fun chipCount(): Int = chromeJs("document.querySelectorAll('$CHIP').length").toIntOrNull() ?: -1
    private fun hiddenCount(): Int = chromeJs("document.querySelectorAll('$CHIP[data-overflow=\"true\"]').length").toIntOrNull() ?: -1
    private fun chipHeight(): Int = chromeJs("(function(){var c=document.querySelector('$CHIP');return c?Math.round(c.getBoundingClientRect().height):-1})()").toIntOrNull() ?: -1
    private fun overflowSize(): String = jsText("(function(){var b=document.querySelector('$OVERFLOW');if(!b)return 'none';var r=b.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)})()")

    /** The labels of the chips the strip hid, in the strip's order (the overflow panel's rows). */
    private fun hiddenLabels(): List<String> = jsList(
        "[...document.querySelectorAll('$CHIP[data-overflow=\"true\"]')].map(function(c){var l=c.querySelector('.zen-bm-chip-label');return (l?l.textContent:c.textContent).trim()})"
    )

    /** The open panel's rows' labels. */
    private fun panelRows(): List<String> = jsList(
        "[...document.querySelectorAll('$PANEL [role=\"menuitem\"]')].map(function(r){return r.textContent.trim()})"
    )

    private fun panelRowHeight(): Int = chromeJs("(function(){var r=document.querySelector('$PANEL [role=\"menuitem\"]');return r?Math.round(r.getBoundingClientRect().height):-1})()").toIntOrNull() ?: -1

    // --- the Settings page ----------------------------------------------------------------------

    /** `.zen-settings-two-pane[data-section]` (the tablet's page): the section shown, "" with none up. */
    private fun twoPaneSection(): String = jsText("(function(){var p=document.querySelector('$TWO_PANE');return p?String(p.dataset.section||''):''})()")

    /** What the Show bookmarks bar row's menulist reads. */
    private fun menulistReads(): String = jsText("(function(){var b=document.querySelector('$ROW_MENULIST');return b?b.textContent.trim():''})()")

    /** The picker sheet's radio rows' labels. */
    private fun radioLabels(): List<String> = jsList(
        "[...document.querySelectorAll('$SHEET_RADIOS')].map(function(r){return r.textContent.trim()})"
    )

    // --- the chrome's geometry --------------------------------------------------------------------

    /** CSS px of the chrome to screen px: `screen = origin + css * density`, the chrome view's place on screen. */
    private var originX = 0f
    private var originY = 0f

    /**
     * Where the chrome's CSS px land on the screen: the chrome view's location (the harness's
     * `settingsRowRect` reading), noted against the toolbar's address pill in the accessibility
     * tree (the tablet layout demo's reading) when both are there.
     */
    private fun calibrate() {
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        originX = origin[0].toFloat()
        originY = origin[1].toFloat()
        val dom = domRect(ADDRESS_PILL)
        val tree = findByLabelPrefix(PILL_LABEL)
        val note = if (dom != null && tree != null) "; pill DOM $dom x$density -> tree $tree (offsets ${(tree.left - dom.left * density).roundToInt()}/${(tree.top - dom.top * density).roundToInt()})" else ""
        finding("calibration: chrome view at ${originX.roundToInt()}/${originY.roundToInt()}$note")
    }

    /** A CSS rect of the chrome as screen px. */
    private fun screen(r: RectF?): RectF? = r?.let {
        RectF(originX + it.left * density, originY + it.top * density, originX + it.right * density, originY + it.bottom * density)
    }

    /**
     * The bounding rect (CSS px) of the first – or with `last`, the last – element `selector`
     * matches; null when none. With `reveal`, the element is scrolled into the middle of its
     * scroller first (a row below the fold of the app menu's twenty rows on an 800 window, or of
     * the Look and Feel page) and read once the scroll has landed – where a finger is to go.
     */
    private fun domRect(selector: String, last: Boolean = false, reveal: Boolean = false): RectF? = domRectWhere(
        "(function(){var a=document.querySelectorAll(${JSONObject.quote(selector)});return a.length?a[${if (last) "a.length-1" else "0"}]:null})()",
        reveal
    )

    /** The bounding rect (CSS px) of the element the JS expression `element` evaluates to; null when none. See [domRect] for `reveal`. */
    private fun domRectWhere(element: String, reveal: Boolean = false): RectF? {
        val read = "(function(){var e=($element);if(!e)return null;" +
            (if (reveal) "e.scrollIntoView({block:'center',behavior:'instant'});" else "") +
            "var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()"
        if (reveal) {
            if (chromeJs(read) == "null") return null
            SystemClock.sleep(500)
        }
        val raw = chromeJs(read)
        if (raw.isEmpty() || raw == "null") return null
        val a = JSONArray(raw)
        val l = a.getDouble(0).toFloat()
        val t = a.getDouble(1).toFloat()
        return RectF(l, t, l + a.getDouble(2).toFloat(), t + a.getDouble(3).toFloat())
    }

    /** A real touch on the middle of the element `selector` matches (revealed first, [domRect]); false (and a note) when there is none. */
    private fun tapDom(selector: String, last: Boolean = false, reveal: Boolean = true): Boolean {
        val target = screen(domRect(selector, last, reveal)) ?: run {
            finding("no element for $selector to tap")
            return false
        }
        Finger().tap(target.centerX(), target.centerY())
        return true
    }

    private fun awaitDom(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) != null }

    private fun awaitDomGone(selector: String, timeoutMs: Long = 4_000): Boolean = awaitTrue(timeoutMs) { domRect(selector) == null }

    /**
     * The element goes within `timeoutMs` and is still gone `holdMs` later: a panel a finger's tap
     * closed must not come back from that tap's own click (the first run's fault: the » closed
     * under the finger and stood again a second and a half later, its late click reopening it).
     */
    private fun staysGone(selector: String, timeoutMs: Long = 8_000, holdMs: Long = 3_000): Boolean {
        if (!awaitDomGone(selector, timeoutMs)) return false
        val until = SystemClock.uptimeMillis() + holdMs
        while (SystemClock.uptimeMillis() < until) {
            if (domRect(selector) != null) return false
            SystemClock.sleep(250)
        }
        return domRect(selector) == null
    }

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

    /** The strings the JS array expression `code` evaluates to. */
    private fun jsList(code: String): List<String> {
        val raw = chromeJs("JSON.stringify($code)")
        val json = runCatching { JSONArray(JSONTokener(raw).nextValue().toString()) }.getOrNull() ?: return listOf("unreadable: $raw")
        return (0 until json.length()).map { json.optString(it) }
    }

    // --- the core's state -------------------------------------------------------------------------

    private fun activeTabId(): String? = activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() }
    private fun activeUrl(): String? = activeCoreTab()?.optString("url")?.takeIf { it.isNotEmpty() }
    private fun tabUrl(tabId: String): String? = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("url")

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
        private const val PORT = 18169
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val SPACE = "space_browse"
        private const val HOME_TAB = "tab_home"
        private const val WEB_TAB = "tab_web"
        private const val SETTINGS_URL = "zen://settings"
        private const val NEW_TAB_URL = "zen://newtab"
        private const val LOOK_SECTION = "look"

        /** The seeded bar: sixteen children of the Bookmarks bar root, the Work folder's three pages. */
        private const val BAR_CHILDREN = 16
        private const val WORK_FOLDER = "bm_work"
        private val WORK_ROWS = listOf("Board", "Tracker", "Team wiki")
        private val MODES = listOf("Always", "Only on new tab page", "Never")

        /** The chrome's roots and controls, by the attributes the components carry (the tablet layout demo's). */
        private const val TOOLBAR = ".zen-tablet-toolbar"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val CONTENT = ".zen-content-frame"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        /** The ⋯: the nav row's last own button with a menu (the pill's chips are inside the pill). */
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        /** The sidebar's New Tab row (`SpacePanel`'s `NewTabButton`, `data-new-tab`). */
        private const val NEW_TAB_ROW = ".zen-tablet-sidebar [data-new-tab]"

        /** The bookmarks bar (`BookmarksBar.tsx`): the toolbar root, its chips, the » and the panels (`BarMenu.tsx`). */
        private const val BAR = ".zen-bm-bar"
        private const val CHIP = ".zen-bm-strip .zen-bm-chip[data-bm-chip]"
        private const val OVERFLOW = ".zen-bm-bar .zen-bm-overflow"
        private const val PANEL = "[data-bar-panel][role=\"menu\"]"
        private fun chip(id: String) = ".zen-bm-strip .zen-bm-chip[data-bm-id=\"$id\"]"

        /** The Settings page on the tablet (`desktop.tsx`): the two-pane root, its navigation, the row's menulist, the picker sheet. */
        private const val TWO_PANE = ".zen-settings-two-pane"
        private const val NAV_LOOK = ".zen-settings-nav-item[data-section=\"look\"]"
        private const val ROW_MENULIST = "[data-row=\"bookmarks-bar\"] .zen-v2-menulist"
        private const val SHEET_TITLE = "Show bookmarks bar"
        private const val SHEET_RADIOS = "[data-sheet-layer] [role=\"dialog\"] [role=\"radio\"]"
        private fun radioRow(label: String) =
            "[...document.querySelectorAll('$SHEET_RADIOS')].find(function(r){return r.textContent.trim()===${JSONObject.quote(label)}})"

        /**
         * The app menu's row labelled `label`: the popover's `menuitem`s at every cascade level
         * share `.zen-v2-menu-item`, the label its own span (`MenuSheet`'s row), so a hint never
         * joins the match.
         */
        private fun menuRow(label: String) =
            "[...document.querySelectorAll('.zen-v2-menu .zen-v2-menu-item')].find(function(e){" +
                "var l=e.querySelector('span.flex-1');return (l?l.textContent:e.textContent).trim()===${JSONObject.quote(label)}})"

        /** Reads off the chrome's stores (`lib/store.ts` registers them on `window.__zenStores`). */
        private const val MENU_OPEN = "window.__zenStores.ui.get().menu!==null"
        private const val BAR_MENU_OPEN = "window.__zenStores.ui.get().barMenuOpen===true"

        private fun row(tabId: String) = ".zen-tablet-sidebar [data-tab-id=\"$tabId\"]"

        /** The pages the seeded tabs and bookmarks point at, path to title and body. */
        private val PAGES: Map<String, Pair<String, String>> = mapOf(
            "/" to ("Bookmarks bar demo" to prose("The tablet bookmarks bar demo's home page.", 12)),
            "/web.html" to ("World Wide Web" to prose("The World Wide Web is an information system of interlinked documents.", 20)),
            "/tablets.html" to ("Tablet computer" to prose("A tablet is a mobile device with a touchscreen display.", 20)),
            "/docs.html" to ("Documentation" to prose("The documentation.", 6)),
            "/news.html" to ("Morning news" to prose("The morning's news.", 6)),
            "/zenium.html" to ("Zenium" to prose("Zenium, a browser.", 6)),
            "/coffee.html" to ("Coffee" to prose("A cup of coffee.", 6)),
            "/design.html" to ("Design language" to prose("The design language.", 6)),
            "/release.html" to ("Release notes" to prose("The release notes.", 6)),
            "/standards.html" to ("Web standards" to prose("The web's standards.", 6)),
            "/mail.html" to ("Mail" to prose("The mail.", 6)),
            "/calendar.html" to ("Calendar" to prose("The calendar.", 6)),
            "/weather.html" to ("Weather" to prose("The weather.", 6)),
            "/maps.html" to ("Maps" to prose("The maps.", 6)),
            "/music.html" to ("Music" to prose("The music.", 6)),
            "/board.html" to ("Board" to prose("The board.", 6)),
            "/tracker.html" to ("Tracker" to prose("The tracker.", 6)),
            "/wiki.html" to ("Team wiki" to prose("The team's wiki.", 6)),
            "/rfc2324.html" to ("RFC 2324: HTCPCP/1.0" to prose("The Hyper Text Coffee Pot Control Protocol.", 6)),
            "/tea.html" to ("RFC 7168: HTCPCP-TEA" to prose("The Hyper Text Coffee Pot Control Protocol for Tea Efflux Appliances.", 6))
        )

        private fun prose(lead: String, paragraphs: Int): String =
            (1..paragraphs).joinToString("") { "<p>$lead Paragraph $it of $paragraphs.</p>" }
    }
}
