package app.zen.chromium

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the phone app menu's and the toolbar's rows of wave 6 round C (TB-07, TB-16, TB-15,
 * GN-11) on one boot, every press a real touch on a box read from the chrome's DOM or the tree,
 * every outcome read off the core's state:
 *
 *  A. TB-07 the app menu's rows read by name off the sheet, in Zenium's order, then each of
 *     Chrome for Android 152's `main_menu.xml` rows looked up (New tab, New Incognito tab,
 *     History, Delete browsing data, Downloads, Bookmarks, Recent tabs, Share, Find in page,
 *     Translate, Add to Home screen, Desktop site, Zoom, Settings, Help & feedback) – its Zenium
 *     row's position, or why there is none (Delete browsing data is the Settings sheet's,
 *     services' row; Recent tabs is the History page's, where the other devices' open tabs are
 *     listed from sync); the rows the host decides (New Private Tab under
 *     `capabilities.privateTabs`, Translate Page… under the engine, Add to Home Screen under the
 *     install surface) are recorded, not required. Then the HELP row, the row this round built:
 *     right after Settings, where Chrome keeps "Help & feedback"; a real touch opens the one help
 *     page (`HELP_URL`, `src/shared/links.ts`) in a NEW tab in front that is the page's child
 *     (`openerTabId`: the system back returns to the page) in the page's container.
 *  B. TB-16 the bar's optional Bookmark star (as found on main since #266, the menu star's
 *     shape): outlined "Bookmark" on a page not bookmarked; a real touch saves the page and the
 *     star fills and reads "Edit Bookmark"; a second touch opens the bookmark editor and removes
 *     nothing. The full record of the star (its spring, the toast's Edit, both bar edges, both
 *     schemes) is BarStarListenOnDemo's; this act is the round's own short proof on one boot.
 *  C. TB-15 the Home item: a HOLD on the bar's Home item opens Settings › Look and Feel LANDED on
 *     the Home group (the `?row=homepage` deep link; before this round the page opened at its top)
 *     and not the bar editor; a touch on Home loads the homepage URL set in `settings.homepage`
 *     (seeded here; the typed path – the picker, Address, Use current page – is HomepageNtpDemo's).
 *  D. GN-11 a tile's hold menu on the new tab page: a pinned tile held lifts its menu; "Open in
 *     Private Tab" is the SECOND row, right under Open in New Tab, exactly where the host offers
 *     private tabs (`capabilities.privateTabs`: a WebView with profiles, Chrome 111+; the shared
 *     recipe's API 34 image ships WebView 113 without them, so there the menu is as it was and
 *     the row's touch is the API 35 run's); on a host that offers it a real touch on the row opens
 *     the shortcut in a PRIVATE tab in front; Copy Link follows the open rows and Remove closes
 *     the list either way.
 *
 * Findings in `menu-rows-findings.txt` (one `OK` or `FAIL` per claim; a claim that does not hold
 * fails the run at the end). The seeded profile is the tab-group drivers' (`tab-groups-demo-
 * state.json`: Research [Alpha, Beta]; Home, Gamma, Delta loose; the pages the driver's own
 * loopback server's), patched with the bar's optional Home and Bookmark items and a `url`
 * homepage on this server. Light scheme only: the design stills are the preview host's. Driven
 * by `android-menu-rows-demo.yml` (the API 35 image, where the private row is on) and by the
 * nightly sweep's phone-f shard (API 34: the row absent by design, the rest in full). See
 * [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class MenuRowsDemo : GroupsDemoBase("menu-rows", "menu-rows-demo") {
    override val tag = "MenuRowsDemo"
    override val findingsFile = "menu-rows-findings.txt"
    override val title = "Zenium Android app menu + toolbar rows (TB-07 Help, TB-16 the bar star, TB-15 the Home hold, GN-11 the tile menu's private row)"

    @Test
    fun record() = recordDemo(
        mapOf(
            HOMEPAGE_PATH to DemoServer.page("Homepage", "<p>The homepage set in Settings › Look and Feel › Home: the page Home loads.</p>"),
            SHORTCUT_PATH to DemoServer.page("Shortcut", "<p>A pinned shortcut of the new tab page: the page its tile menu opens.</p>")
        )
    )

    /**
     * The bar carries its optional Home and Bookmark items (`phoneBar`, the bar editor's layout)
     * so acts B and C have them to press, and the homepage is a `url` one on this server so act
     * C's Home has a page to load; the rest is the seeded profile as the tab-group drivers have it.
     */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val settings = state.getJSONObject("settings")
        settings.put(
            "phoneBar",
            JSONObject().put("left", JSONArray(listOf("back", "home"))).put("right", JSONArray(listOf("bookmark", "tabs", "menu")))
        )
        settings.put("homepage", JSONObject().put("mode", "url").put("url", HOMEPAGE_URL))
        return state.toString()
    }

    override fun warmUp() {
        head()
        awaitLoaded(HOME, "$ORIGIN/")
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control.
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        finding("warm-up done: ${describeSpace()}; homepage ${homepage()}; bar ${coreState().getJSONObject("settings").optJSONObject("phoneBar")}")
    }

    override fun demo() {
        still("page")
        helpRow()
        barStar()
        homeHold()
        tileMenu()
        still("end")
        tail()
    }

    // --- A. the menu's rows and the Help row --------------------------------------------------------

    private fun helpRow() {
        section("A. TB-07 the app menu's rows against Chrome 152's main_menu.xml, and the Help row")
        ensureForeground()
        val opener = tab(HOME) ?: run {
            check("A: the seeded Home tab is there", false, "no $HOME in the state")
            return
        }
        val container = opener.optString("containerId")
        val before = tabIds()
        val up = tapMenuButton() && waitFor(MENU_HANDLE_LABEL, 6_000) != null
        check("A: the app menu comes up as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return
        SystemClock.sleep(1_000)
        pullMenuUp()
        val rows = textsOf(SHEET_ITEM).filter { it.isNotBlank() }
        finding("  rows as found, in Zenium's order (${rows.size}; the icon row's glyphs are not text rows):")
        rows.forEachIndexed { i, row -> finding("    ${i + 1}. $row") }
        val privateTabs = privateTabsCapability()
        finding("  the host: capabilities.privateTabs $privateTabs (${webViewPackage()})")
        finding("  Chrome 152's main_menu.xml rows in Chrome's order, each looked up (its position in Zenium's list):")
        var missing = 0
        for (row in CHROME_152) {
            val ours = row.ours
            if (ours == null) {
                finding("    ${row.chrome} -> none: ${row.whenNone}")
                continue
            }
            val at = rows.indexOf(ours)
            if (at < 0) {
                if (row.hostDecides != null) {
                    finding("    ${row.chrome} -> $ours: no row on THIS host (${row.hostDecides}); drawn where it is on")
                } else {
                    missing++
                    finding("    ${row.chrome} -> $ours MISSING")
                }
                continue
            }
            finding("    ${row.chrome} -> $ours (${at + 1})")
        }
        val mapped = CHROME_152.mapNotNull { it.ours }
        finding("  Zenium's own rows, not in Chrome's list: ${rows.filter { it !in mapped }}")
        check("A: every Chrome 152 row that is not the host's or services' to offer has its Zenium row", missing == 0, "$missing missing")
        check(
            "A: New Private Tab is on the menu exactly where capabilities.privateTabs is on",
            if (privateTabs) PRIVATE_TAB_ROW in rows else PRIVATE_TAB_ROW !in rows,
            "privateTabs $privateTabs"
        )
        check("A: Help is ONE row of the menu, right after Settings (Chrome's Help & feedback seat)", rows.count { it == HELP_ROW } == 1 && rows.indexOf(HELP_ROW) == rows.indexOf("Settings") + 1, "Settings at ${rows.indexOf("Settings") + 1}, Help at ${rows.indexOf(HELP_ROW) + 1}")
        check("A: the About line follows Help, Change Menu closes the list", rows.indexOfFirst { it.startsWith("About ") } > rows.indexOf(HELP_ROW) && rows.lastOrNull() == "Change Menu", "rows $rows")
        val revealed = reveal(HELP_ROW)
        finding("  Help revealed in the tree at $revealed")
        still("menu-help")
        var touched = touchTapLabel(HELP_ROW)
        if (!touched) {
            finding("  (the tree had no Help to touch; the DOM's box instead)")
            touched = touchUntil(HELP_ROW, { textRect(SHEET_ITEM, HELP_ROW) }, { tabIds().size == before.size + 1 }, waitMs = 6_000)
        }
        val opened = touched && awaitCore(10_000) { st -> newTabIn(st, before)?.let { tabUrl(it, st)?.startsWith(HELP_ORIGIN) == true } == true }
        val helpTab = newTabIn(coreState(), before)
        val help = helpTab?.let { tab(it) }
        finding("  after the touch: touched $touched; new tab ${helpTab ?: "none"} url ${help?.optString("url")} active ${activeTabId() == helpTab} opener ${help?.optString("openerTabId")} container ${help?.optString("containerId")}")
        check("A: a real touch on Help opens the help page ($HELP_URL) in a NEW tab", opened, "new ${help?.optString("url")}")
        if (helpTab == null) return
        check("A: the help tab is in front (Chrome opens Help & feedback in front)", awaitCore { activeTabId(it) == helpTab }, "active ${activeTabId()}")
        check("A: the help tab is the page's child (openerTabId = the tab the menu was over: the system back returns to it)", help?.optString("openerTabId") == HOME, "opener ${help?.optString("openerTabId")}")
        check("A: the help tab is in the page's container", help?.optString("containerId") == container, "container ${help?.optString("containerId")} vs $container")
        check("A: the menu is gone after the touch", awaitJs(MENU_OPEN, false, SHEET_WAIT), "menu ${jsText(MENU_OPEN)}")
        val loaded = awaitLoaded(helpTab, help?.optString("url").orEmpty(), 15_000)
        finding("  the help page ${if (loaded) "loaded" else "did not load within 15 s"} (the network is the runner's; no claim)")
        SystemClock.sleep(800)
        still("help-tab")
    }

    // --- B. the bar's star -----------------------------------------------------------------------------

    private fun barStar() {
        section("B. TB-16 the bar's Bookmark star: the stateful glyph, bookmark.star (as found on main since #266)")
        activate(HOME, "$ORIGIN/")
        val rest = starDom()
        val before = bookmarkCount()
        finding("  at rest: $rest; bookmarks $before; Home bookmarked ${bookmarked(HOME)}")
        check("B: on a page not bookmarked the star reads '$STAR_REST', outlined", !bookmarked(HOME) && rest?.optString("label") == STAR_REST && rest?.optString("filled") != "true", "star $rest")
        still("bar-star-outlined")
        val saved = touchControlExpecting(STAR_REST, "document.querySelector('$BAR_STAR')", "the page is bookmarked", timeoutMs = 8_000) { bookmarked(HOME) }
        val filled = awaitJs("(document.querySelector('$BAR_STAR')||{getAttribute:function(){return null}}).getAttribute('aria-label')===${JSONObject.quote(STAR_FILLED)}", true, 6_000)
        val after = bookmarkCount()
        finding("  after the touch: saved $saved; star ${starDom()}; bookmarks $after")
        check("B: a real touch on the star bookmarks the page (one bookmark more, $before -> $after)", saved && after == before + 1, "bookmarked ${bookmarked(HOME)}")
        check("B: the star fills and reads '$STAR_FILLED' once the page is bookmarked (no aria-pressed toggle)", filled && starDom()?.optString("filled") == "true" && starDom()?.optString("pressed").isNullOrEmpty(), "star ${starDom()}")
        SystemClock.sleep(1_200)
        still("bar-star-filled")
        awaitToastGone()
        val editor = touchControlExpecting(STAR_FILLED, "document.querySelector('$BAR_STAR')", "the bookmark editor opens", timeoutMs = 8_000) { jsBoolean(EDITOR_UP) }
        finding("  the second touch: editor $editor; bookmarks ${bookmarkCount()}; Home bookmarked ${bookmarked(HOME)}")
        check("B: a second touch opens the bookmark editor and removes nothing", editor && bookmarkCount() == after && bookmarked(HOME), "editor ${jsText(EDITOR_UP)}")
        SystemClock.sleep(1_000)
        still("bookmark-editor")
        back()
        if (!awaitJs(EDITOR_UP, false, 6_000)) finding("  (the editor did not leave on back)")
        SystemClock.sleep(800)
    }

    // --- C. the Home item's hold -------------------------------------------------------------------------

    private fun homeHold() {
        section("C. TB-15 a hold on the bar's Home item lands Settings on the Home group; a touch loads the homepage")
        ensureForeground()
        val before = tabIds()
        val held = hold(domRect(BAR_HOME), "the bar's Home item")
        val settingsTab = if (held == null) null else awaitCoreFor(8_000) { st -> newTabIn(st, before)?.takeIf { tabUrl(it, st)?.startsWith(SETTINGS_URL) == true } }
        val editorOpen = jsBoolean(BAR_EDITOR)
        finding("  after the hold: settings tab ${settingsTab ?: "none"} url ${settingsTab?.let { tabUrl(it) }}; bar editor ${editorOpen}")
        check("C: the hold opens Settings in a new tab in front, not the bar editor", settingsTab != null && activeTabId() == settingsTab && !editorOpen, "active ${activeTabId()?.let { tabUrl(it) }}")
        val landed = awaitJs(HOME_GROUP_IN_VIEW, true, 8_000)
        val boxes = jsText(HOME_GROUP_BOXES)
        finding("  the Home group's and the Homepage row's boxes (CSS px; the viewport ${jsText("window.innerWidth+'x'+window.innerHeight")}): $boxes")
        check("C: the page lands on the Home group – Homepage, Address, Use current page in view, the group's top in the upper part of the viewport", landed, "boxes $boxes")
        SystemClock.sleep(800)
        still("home-hold-settings")
        val homed = touchControlExpecting("Home", "document.querySelector('$BAR_HOME')", "the active tab loads the homepage", timeoutMs = 10_000) {
            activeTabId()?.let { tabUrl(it) } == HOMEPAGE_URL
        }
        finding("  after the touch: active ${activeTabId()?.let { tabUrl(it) }}; homepage ${homepage()}")
        check("C: a touch on Home loads the homepage set in Settings ($HOMEPAGE_URL) on the active tab", homed, "active ${activeTabId()?.let { tabUrl(it) }}")
        SystemClock.sleep(1_000)
        still("home-loaded")
    }

    // --- D. the tile menu's private row -----------------------------------------------------------------

    private fun tileMenu() {
        section("D. GN-11 Open in Private Tab on a new tab page tile's hold menu, where the host offers private tabs")
        ensureForeground()
        val privateTabs = privateTabsCapability()
        finding("  the host: capabilities.privateTabs $privateTabs (${webViewPackage()})")
        val id = coreInvoke("newtab.addShortcut", JSONObject().put("title", SHORTCUT_TITLE).put("url", SHORTCUT_URL).toString())
        finding("  pinned $SHORTCUT_TITLE -> $SHORTCUT_URL (id $id)")
        // The phone's new tab page is a blank tab the chrome draws its page over (`lib/newtab.ts`
        // `openNewTabPage`: `tab.create` at zen://blank, active); the core's `tab.new` is the
        // desktop's served page or, without it, the URL bar in new-tab mode – no tab (run 1).
        val created = coreInvoke("tab.create", "{\"url\":${JSONObject.quote(BLANK_URL)},\"active\":true}")
        finding("  a new tab page asked of the core the chrome's way (tab.create $BLANK_URL, active; id $created)")
        val ntp = awaitCore { st -> activeTabId(st)?.let { tabUrl(it, st) } == BLANK_URL }
        val tile = awaitRect { domRect(TILE) }
        check("D: a new tab page opens with the pinned tile on it", ntp && tile != null, "active ${activeTabId()?.let { tabUrl(it) }}, tile $tile")
        if (tile == null) return
        SystemClock.sleep(800)
        still("ntp")
        hold(tile, "the pinned tile") ?: return
        val up = awaitJs(MENU_OPEN, true, SHEET_WAIT) && awaitDom(SHEET_ITEM, SHEET_WAIT)
        check("D: a hold on the tile lifts its menu as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return
        SystemClock.sleep(600)
        val rows = textsOf(SHEET_ITEM).filter { it.isNotBlank() }
        finding("  rows as found (${rows.size}): ${rows.joinToString(" · ")}")
        check("D: Open in New Tab is the first row", rows.firstOrNull() == NEW_TAB_ROW, "rows $rows")
        check(
            "D: Open in Private Tab is the SECOND row, under Open in New Tab, exactly where capabilities.privateTabs is on" +
                if (privateTabs) "" else " – off on this WebView, so no row",
            if (privateTabs) rows.indexOf(PRIVATE_ROW) == 1 else PRIVATE_ROW !in rows,
            "privateTabs $privateTabs, rows $rows"
        )
        check("D: Copy Link follows the open rows", rows.indexOf("Copy Link") == (if (privateTabs) 2 else 1), "rows $rows")
        check("D: Remove closes the list", rows.lastOrNull() == "Remove", "rows $rows")
        still("tile-menu")
        if (!privateTabs) {
            finding("  no private row on this host: the row's touch is the API 35 run's (android-menu-rows-demo.yml)")
            back()
            if (!awaitJs(MENU_OPEN, false, SHEET_WAIT)) finding("  (the sheet did not leave on back)")
            return
        }
        val before = tabIds()
        val opened = touchUntil(PRIVATE_ROW, { textRect(SHEET_ITEM, PRIVATE_ROW) }, { tabIds().size == before.size + 1 }, waitMs = 6_000)
        val newTab = newTabIn(coreState(), before)
        val record = newTab?.let { tab(it) }
        finding("  after the touch: opened $opened; new tab ${newTab ?: "none"} url ${record?.optString("url")} container ${record?.optString("containerId")} active ${activeTabId() == newTab}")
        check("D: the touch opens the shortcut in a PRIVATE tab in front", opened && newTab != null && record?.optString("containerId") == PRIVATE_CONTAINER && awaitCore { tabUrl(newTab, it) == SHORTCUT_URL && activeTabId(it) == newTab }, "new ${record?.optString("url")} in ${record?.optString("containerId")}")
        check("D: the sheet is gone after the touch", awaitJs(MENU_OPEN, false, SHEET_WAIT), "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(1_200)
        still("private-tab")
    }

    // --- reads ---------------------------------------------------------------------------------------------

    private fun tab(id: String, state: JSONObject = coreState()): JSONObject? = state.getJSONObject("tabs").optJSONObject(id)

    private fun tabIds(state: JSONObject = coreState()): Set<String> = state.getJSONObject("tabs").keys().asSequence().toSet()

    /** The one tab in `state` that `before` did not have; null when none or several. */
    private fun newTabIn(state: JSONObject, before: Set<String>): String? = (tabIds(state) - before).singleOrNull()

    /** [awaitCore]'s shape for a value: the first non-null `read` within `timeoutMs`. */
    private fun <T> awaitCoreFor(timeoutMs: Long, read: (JSONObject) -> T?): T? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read(coreState())?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun bookmarked(id: String): Boolean = tab(id)?.optBoolean("bookmarked") == true

    private fun bookmarkCount(): Int = coreState().optJSONArray("bookmarks")?.length() ?: 0

    private fun homepage(): JSONObject = coreState().getJSONObject("settings").optJSONObject("homepage") ?: JSONObject()

    /** The bar's star as the DOM has it: its label, its glyph's `data-filled`, and any `aria-pressed` (there must be none). */
    private fun starDom(): JSONObject? {
        val raw = jsText(
            "(function(){var b=document.querySelector('$BAR_STAR');if(!b)return null;var g=b.querySelector('.zen-star-glyph');" +
                "return {label:b.getAttribute('aria-label')||'',filled:(g&&g.getAttribute('data-filled'))||'',pressed:b.getAttribute('aria-pressed')||''}})()"
        )
        return runCatching { JSONObject(raw) }.getOrNull()
    }

    /** The core activates [tabId] (a touch on its card is the overview drivers' business), its page loaded. */
    private fun activate(tabId: String, url: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val active = awaitCore { activeTabId(it) == tabId }
        awaitLoaded(tabId, url)
        SystemClock.sleep(1_500)
        finding("  $tabId activated: $active; ${describeSpace()}")
    }

    /** The core's word on private tabs: on only where the WebView keeps profiles (`androidCapabilities`). */
    private fun privateTabsCapability(): Boolean =
        runCatching { coreState().getJSONObject("capabilities").optBoolean("privateTabs") }.getOrDefault(false)

    private fun webViewPackage(): String =
        shellCommand("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "WebView package ?"

    companion object {
        private const val HOMEPAGE_PATH = "/homepage.html"
        private const val HOMEPAGE_URL = "$ORIGIN$HOMEPAGE_PATH"
        private const val SHORTCUT_PATH = "/shortcut.html"
        private const val SHORTCUT_URL = "$ORIGIN$SHORTCUT_PATH"
        private const val SHORTCUT_TITLE = "Shortcut"

        /** `HELP_URL` in `src/shared/links.ts`: the one help page, the README. */
        private const val HELP_URL = "https://github.com/BenItBuhner/Zenium#readme"
        private const val HELP_ORIGIN = "https://github.com/BenItBuhner/Zenium"
        private const val SETTINGS_URL = "zen://settings"
        private const val BLANK_URL = "zen://blank"
        private const val PRIVATE_CONTAINER = "private"

        private const val HELP_ROW = "Help"
        private const val PRIVATE_TAB_ROW = "New Private Tab"
        private const val NEW_TAB_ROW = "Open in New Tab"
        private const val PRIVATE_ROW = "Open in Private Tab"
        // The star reads by the page's state (v2 §9.13's words): "Bookmark" outlined, "Edit Bookmark" filled.
        private const val STAR_REST = "Bookmark"
        private const val STAR_FILLED = "Edit Bookmark"

        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val BAR_STAR = ".zen-phone-bar [data-bar-item=\"bookmark\"]"
        private const val BAR_HOME = ".zen-phone-bar [data-bar-item=\"home\"]"
        private const val TILE = "li.zen-ntp-site[data-cell=\"$SHORTCUT_URL\"] button"
        private const val EDITOR_UP = "window.__zenStores.ui.get().bookmarkEdit"
        private const val BAR_EDITOR = "window.__zenStores.ui.get().barEditorOpen"
        private const val HOME_GROUP = ".zen-settings-group[data-group=\"home\"]"
        private const val HOMEPAGE_ROW = "[data-row=\"homepage\"]"

        /** The Home group landed on: its top in the viewport's upper part, the Homepage row wholly in view. */
        private const val HOME_GROUP_IN_VIEW =
            "(function(){var g=document.querySelector('$HOME_GROUP'),r=document.querySelector('$HOMEPAGE_ROW');if(!g||!r)return false;" +
                "var gb=g.getBoundingClientRect(),rb=r.getBoundingClientRect(),h=window.innerHeight;" +
                "return gb.top>=-1&&gb.top<h*0.5&&rb.top>=0&&rb.bottom<=h})()"
        private const val HOME_GROUP_BOXES =
            "(function(){var f=function(s){var e=document.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]};" +
                "return {landing:!!document.querySelector('.zen-settings-page[data-landing]'),group:f('$HOME_GROUP'),homepage:f('$HOMEPAGE_ROW'),address:f('[data-row=\"homepage-address\"]')}})()"

        /** One of Chrome's rows against Zenium's ([ours] null: no row of ours, [whenNone] says why; [hostDecides]: recorded, not required). */
        private data class ChromeRow(val chrome: String, val ours: String?, val whenNone: String = "", val hostDecides: String? = null)

        /**
         * Chrome for Android 152's `chrome/android/java/res/menu/main_menu.xml` text rows, in
         * Chrome's order (the icon row – Forward, Bookmark, Download, Info, Reload – is the
         * phone's icon row here too and not a text row of either list).
         */
        private val CHROME_152: List<ChromeRow> = listOf(
            ChromeRow("New tab", "New Tab"),
            ChromeRow("New Incognito tab", PRIVATE_TAB_ROW, hostDecides = "capabilities.privateTabs off: the WebView keeps no profiles"),
            ChromeRow("History", "History"),
            ChromeRow("Delete browsing data", null, "the Settings › Privacy sheet's row (services'); no menu row on the phone"),
            ChromeRow("Downloads", "Downloads"),
            ChromeRow("Bookmarks", "Bookmarks"),
            ChromeRow("Recent tabs", null, "the History page lists the other devices' open tabs from sync (#316); no separate row – an open question for the lead"),
            ChromeRow("Share", "Share…"),
            ChromeRow("Find in page", "Find in Page…"),
            ChromeRow("Translate", "Translate Page…", hostDecides = "the translation engine is not available on this host"),
            ChromeRow("Add to Home screen", "Add to Home Screen", hostDecides = "the install surface is not up for this page"),
            ChromeRow("Desktop site", "Desktop Site"),
            ChromeRow("Zoom", "Zoom…"),
            ChromeRow("Settings", "Settings"),
            ChromeRow("Help & feedback", HELP_ROW)
        )
    }
}
