package app.zen.chromium

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.os.Process
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream

/**
 * Drives the TABLET's new tab page (NTP-35: the served `zen://newtab` document – the desktop's,
 * its tiles, each tile's hold menu – in the tablet's tab, where the phone keeps its chrome-drawn
 * page over `zen://blank`) on the `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`), on the engine the private tabs demos run on (a Chromium snapshot
 * WebView on the AOSP image: Open in Private Tab needs multi-profile WebView). The profile is a
 * fresh one past its first run: one space, no tab, the tour done. Every press a real touch, every
 * claim read off the core's state, the chrome's DOM or the served page's own DOM:
 *
 *  0. THE COLD START, for the boot path's BEFORE / AFTER: the activity's marks ([BootMarks]:
 *     `ready` – `chrome.ready` heard, on this head armed on the served page's placement – and
 *     `frame` – the first frame confirmed drawn, `reportFullyDrawn`), each as ms from the
 *     `activity` mark (MainActivity.onCreate), in a process the instrumentation already held; on
 *     a host with the new tab page the window's first tab is the served page, placed and loaded
 *     before READY, and its own `performance.timing` says what the document cost; on main's tree
 *     (`newTabPage` off: `Browser.ensureFirstTab` opens no tab) the window comes up with no tab
 *     and the chrome's own surface, so the same driver on main is the 'before' run. The page's
 *     EMPTY state at a fresh boot ("Sites you visit often will appear here"), light and dark;
 *  1. eight loopback sites visited off camera, a new tab from the sidebar's row under a finger:
 *     the served page with the most visited tiles – the tab's URL `zen://newtab`, the page view
 *     placed and shown, the tiles in the page's DOM AND in the accessibility tree, the pill
 *     reading the empty tab's words;
 *  2. a REAL HOLD on a tile (the finger down past the long press, on the tile's own box read off
 *     the page's DOM): the tablet's anchored menu with the touch template's FIVE rows – Open in
 *     New Tab · Open in Private Tab · Copy Link · a separator · Remove (the desktop's template is
 *     not this one; a most-visited tile has no Edit Shortcut) – and Open in Private Tab under a
 *     finger opening the site in a private tab in front, the private session closed after;
 *  3. the hold again and Copy Link under a finger: the tile's URL on the system clipboard;
 *  4. the dark scheme through the core's setting (the chrome and the served page re-ink in
 *     place: `Host.applyTheme` flips the app's night mode without a relaunch): the page and the
 *     hold menu in dark, and Remove under a finger taking the tile off the page through the
 *     core's command down the same channel (`sendNewTabCommand`); the light scheme back.
 *
 * Findings in `tablet-newtab-findings.txt`, stills `tablet-newtab-NN-<state>.png`. Driven by
 * `android-tablet-newtab-demo.yml`; the nightly's `tablet-webview` shard. See [GroupsDemoBase]
 * (the reads and the fingers) and [DemoHarness]. The hold on a tile reaches the page only because
 * `TabWebView.onLongPress` declines the served new tab page (`LinkHits.holdIsThePages`): Chromium
 * offers a long press to the embedder first, and a handled one never becomes the page's
 * `contextmenu` – so a tile, an `<a>`, would raise the LINK menu instead.
 */
@RunWith(AndroidJUnit4::class)
class TabletNewTabDemo : GroupsDemoBase(shotPrefix = "tablet-newtab", handshakeDir = "tablet-newtab-demo", stateAsset = "tablet-newtab-demo-state.json") {
    override val tag = "TabletNewTabDemo"
    override val findingsFile = "tablet-newtab-findings.txt"
    override val title = "Zenium Android tablet: the new tab as the served zen://newtab page, its tiles, a tile's hold menu"

    private val host get() = (activity as MainActivity).host
    private val servers = ArrayList<DemoServer>()

    /** Whether this host serves the new tab page (the head under test) or not (main's tree: the 'before' run). */
    private var served = false

    /** The tab the recording's served page is in, once the sidebar's row opened it. */
    private var pageTab: String? = null

    /** The sites: a host each, the page's title (the tile's caption) and an icon colour. */
    private class Site(val n: Int, val title: String, val color: Int) {
        val address get() = "127.0.0.$n"
        val url get() = "http://$address:$SITE_PORT/"
    }

    private val sites = listOf(
        Site(1, "Orchard", 0xFF2E7D32.toInt()),
        Site(2, "Tides", 0xFF0277BD.toInt()),
        Site(3, "Atlas", 0xFFEF6C00.toInt()),
        Site(4, "Ledger", 0xFF5E35B1.toInt()),
        Site(5, "Foundry", 0xFFC62828.toInt()),
        Site(6, "Meadow", 0xFF00897B.toInt()),
        Site(7, "Lantern", 0xFFF9A825.toInt()),
        Site(8, "Quarry", 0xFF546E7A.toInt())
    )

    @Test
    fun record() {
        for (site in sites) {
            servers += DemoServer(
                SITE_PORT,
                mapOf(
                    "/" to ("text/html; charset=utf-8" to siteHtml(site).toByteArray()),
                    "/icon.png" to ("image/png" to iconPng(site))
                ),
                site.address
            ).also { it.start() }
        }
        try {
            recordDemo()
        } finally {
            servers.forEach { it.close() }
        }
    }

    // --- off camera --------------------------------------------------------------------------------

    override fun warmUp() {
        ensureForeground()
        head()
        for (server in servers) finding("demo server: ${server.selfCheck()}")
        served = coreState().getJSONObject("capabilities").optBoolean("newTabPage")
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }} (${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"}); " +
                "the host's new tab page: ${if (served) "ON (the served zen://newtab page: the head under test)" else "OFF (the chrome's own surface: main's tree, the 'before' run)"}"
        )
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}")
        coldStart()

        // The visits, typed through the core so they weigh in the ranking: every site once, the
        // first three twice, so the tiles' order is not the visiting order alone.
        // A host without the new tab page boots with no tab: one is made for the visits.
        if (activeTabId() == null) {
            coreInvoke("tab.create", JSONObject().put("url", sites[0].url).put("active", true).toString())
            awaitUntil(8_000) { activeTabId() != null }
        }
        val warm = activeTabId()
        if (warm == null) {
            check("a tab to visit the sites in", false, "no active tab after tab.create")
            return
        }
        for (site in sites) visit(warm, site)
        for (site in sites.take(3)) visit(warm, site)
        finding("history.topSites after the visits: ${summarise(coreInvoke("history.topSites", "{\"n\":8}"))}")
        // The pill reads the site's address now: the one read of the tree the fingers are calibrated on.
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu off camera (the emulator compiles and lays
        // one out slowly the first time): the app menu, opened and closed.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_000)
        finding("warm-up done: ${describeSpace()}")
    }

    /**
     * Section 0: the cold start's marks, read off the process right after the launch – the
     * numbers the boot path's BEFORE / AFTER are stated from – and the fresh boot's page.
     */
    private fun coldStart() {
        section("0. The cold start: the activity's marks, the window's first tab")
        awaitUntil(10_000) { BootMarks.get("frame") != null }
        val marks = BootMarks.line()
        finding("  boot marks (ms since the process started, BootMarks): $marks")
        val activityMark = BootMarks.get("activity")
        val since = { name: String -> BootMarks.get(name)?.let { m -> activityMark?.let { m - it } } }
        val launchGap = activityMark?.let { it - (appLaunchedAt - Process.getStartUptimeMillis()) }
        finding(
            "  COLD START from MainActivity.onCreate (the activity mark; the process held by the instrumentation, launch→onCreate $launchGap ms): " +
                "host +${since("host")} ms, content +${since("content")} ms, load +${since("load")} ms, boot +${since("boot")} ms, " +
                "READY +${since("ready")} ms, FULLY DRAWN (frame, reportFullyDrawn) +${since("frame")} ms"
        )
        check("the boot reached its first frame (the marks ready and frame are set)", since("ready") != null && since("frame") != null, marks)
        val active = activeCoreTab()
        val url = active?.optString("url").orEmpty()
        if (served) {
            check("the fresh profile's window boots into the served new tab page as its first tab (Browser.ensureFirstTab on newTabPage)", url == NEW_TAB_URL, "active url '$url'")
            val id = active?.optString("id")
            if (id != null) {
                check("the served page is placed as a page view and loaded before the recording", awaitServedPage(id) && onMain { host.tabs.get(id)?.isShown == true }, "document ${pageJson(id, "[document.readyState,location.href]")}, shown ${onMain { host.tabs.get(id)?.isShown }}")
                val timing = pageJson(id, "(function(){var t=performance.timing;return [t.domContentLoadedEventEnd-t.navigationStart,t.loadEventEnd-t.navigationStart,document.querySelectorAll('.zen-tile:not(.zen-tile-add)').length,!document.getElementById('zen-empty').hidden]})()")
                finding("  the served page's own clock (performance.timing): navigationStart→DOMContentLoaded ${timing?.opt(0)} ms, →load ${timing?.opt(1)} ms; tiles ${timing?.opt(2)}, the empty line shown ${timing?.opt(3)}")
                check("a fresh profile's page shows the empty state – no tile, the line 'Sites you visit often will appear here'", timing?.optInt(2) == 0 && timing?.optBoolean(3) == true, "tiles ${timing?.opt(2)}, empty ${timing?.opt(3)}")
                check("the pill reads the empty tab's words on the served page", pillText().startsWith("Search"), "pill '${pillText()}'")
                SystemClock.sleep(800)
                still("boot-empty-light")
                if (setScheme("dark", id)) {
                    SystemClock.sleep(800)
                    still("boot-empty-dark")
                    setScheme("light", id)
                }
            }
        } else {
            check("main's tree: the window boots with no tab (Browser.ensureFirstTab opens none without the new tab page), the chrome's own surface", active == null, "active url '$url'")
            SystemClock.sleep(800)
            still("boot-main")
        }
    }

    /** A loopback page loads in well under a second; a visit that does not is noted, not waited out. */
    private fun visit(tabId: String, site: Site) {
        coreInvoke("tab.navigate", JSONObject().put("tabId", tabId).put("input", site.url).toString())
        if (!awaitLoaded(tabId, site.url, 8_000)) finding("  visit of ${site.url} never finished: ${tabUrl(tabId)}")
        SystemClock.sleep(500)
    }

    // --- the sequence ------------------------------------------------------------------------------

    override fun demo() {
        if (!served) {
            mainsNewTab()
            tail()
            return
        }
        servedPage()
        holdMenuAndPrivateTab()
        copyLink()
        darkAndRemove()
        SystemClock.sleep(800)
        still("end")
        tail()
    }

    // --- main's tree: the 'before' run --------------------------------------------------------------

    /** On main's tree the new tab is the blank page in a bare view: recorded, nothing of the served page claimed. */
    private fun mainsNewTab() {
        section("1. Main's tree: the new tab from the sidebar's row is zen://blank (no served page on this host)")
        val before = activeTabId()
        val opened = touchUntil("New Tab", { domRect(NEW_TAB_ROW) }, { activeTabId() != null && activeTabId() != before }, waitMs = 8_000)
        check("a touch on the sidebar's New Tab row opens a tab", opened, "active ${activeTabId()}")
        val url = activeCoreTab()?.optString("url").orEmpty()
        finding("  the new tab's URL on this host: '$url' (the served page's scenes need newTabPage on; skipped here)")
        SystemClock.sleep(1_200)
        still("new-tab-main")
    }

    // --- 1. the served page with its tiles --------------------------------------------------------

    private fun servedPage() {
        section("1. A new tab from the sidebar's row: the served zen://newtab page with the most visited tiles")
        val before = activeTabId()
        val opened = touchUntil("New Tab", { domRect(NEW_TAB_ROW) }, { activeTabId() != null && activeTabId() != before }, waitMs = 8_000)
        check("a touch on the sidebar's New Tab row opens a new tab in front", opened, "active ${activeTabId()}")
        val id = activeTabId() ?: return
        pageTab = id
        check("the new tab is the served page: its URL is zen://newtab", awaitCore { it.getJSONObject("tabs").optJSONObject(id)?.optString("url") == NEW_TAB_URL }, "url ${tabUrl(id)}")
        check("the page view is placed, shown and loaded: the document's own location is zen://newtab", awaitServedPage(id) && onMain { host.tabs.get(id)?.isShown == true }, "document ${pageJson(id, "[document.readyState,location.href]")}, shown ${onMain { host.tabs.get(id)?.isShown }}")
        check("the page's state came down the bridge: the tiles are in the page's DOM (the sites visited)", awaitUntil(15_000) { tileCount(id) >= 4 }, "tiles ${tileCaptions(id)}")
        val captions = tileCaptions(id)
        finding("  tiles in the page's order: $captions")
        check("the tiles are the visited sites, every caption a site's title", captions.isNotEmpty() && captions.all { c -> sites.any { it.title == c } }, "captions $captions")
        val first = captions.firstOrNull()
        check("the tiles stand in the accessibility tree (the first tile, by its caption)", first != null && awaitUntil(15_000) { tileInTree(first) }, "first '$first'")
        check("the empty line is hidden once there are tiles", pageJson(id, "[!!document.getElementById('zen-empty').hidden]")?.optBoolean(0) == true, "")
        check("the pill reads the empty tab's words, not an address", pillText().startsWith("Search"), "pill '${pillText()}'")
        check("the page is on the light scheme", pageTheme(id) == "light", "theme '${pageTheme(id)}'")
        SystemClock.sleep(1_200)
        still("tiles-light")
    }

    // --- 2. a tile's hold: the five rows, Open in Private Tab -----------------------------------------

    private fun holdMenuAndPrivateTab() {
        section("2. A REAL HOLD on a tile: the tablet's anchored menu with the five rows; Open in Private Tab")
        val id = pageTab ?: return
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            return
        }
        val rows = holdTile(id, TILE, tile.title)
        check("the hold on '${tile.title}' raised the menu with the touch template's rows", rows == TOUCH_ROWS, "rows $rows")
        check("one separator stands between the open rows and Remove: five rows in all", rows.size == 4 && jsNumber("document.querySelectorAll('$MENU_SEPARATOR').length") == 1.0, "separators ${jsNumber("document.querySelectorAll('$MENU_SEPARATOR').length")}")
        check("no Edit Shortcut on a most-visited tile; the desktop's window rows are not here", rows.none { it.startsWith("Edit") || it.contains("Window") }, "rows $rows")
        check("the menu is the tablet's anchored popover (`.zen-v2-menu`), not a sheet", inDom(MENU) && !inDom(SHEET), "")
        SystemClock.sleep(1_200)
        still("tile-menu-light")
        val before = privateTabIds().toSet()
        val opened = touchUntil("Open in Private Tab", { menuRow("Open in Private Tab") }, { privateActive() }, waitMs = 10_000)
        check("a touch on Open in Private Tab opens the site in a private tab in front", opened, "active ${activeCoreTab()?.optString("containerId")}")
        val privateId = privateTabIds().firstOrNull { it !in before }
        check("the private tab is the tile's site", privateId != null && awaitLoaded(privateId, tile.url, 15_000), "url ${privateId?.let { tabUrl(it) }}")
        check("the window re-inks private with the private tab in front (§9.19)", awaitJs("document.documentElement.dataset.theme==='dark'", true, 6_000) && privateInk(), "theme '${jsText("document.documentElement.dataset.theme")}'")
        SystemClock.sleep(1_200)
        still("private-tab")
        coreInvoke("tab.closePrivate")
        check("Close Private Tabs ends the session; the served page stands", awaitUntil(10_000) { privateTabIds().isEmpty() } && tabExists(id), "private ${privateTabIds()}")
        coreInvoke("tab.activate", JSONObject().put("tabId", id).toString())
        check("the served page is back in front", awaitUntil(8_000) { activeTabId() == id } && awaitJs("document.documentElement.dataset.theme==='light'", true, 6_000), "active ${activeTabId()}")
        SystemClock.sleep(800)
    }

    // --- 3. Copy Link --------------------------------------------------------------------------------

    private fun copyLink() {
        section("3. The hold again, Copy Link under a finger: the tile's URL on the clipboard")
        val id = pageTab ?: return
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            return
        }
        onMain { clipboard().setPrimaryClip(ClipData.newPlainText("demo", SENTINEL)) }
        check("the clipboard holds the sentinel before the copy", clipText() == SENTINEL, "clip '${clipText()}'")
        val rows = holdTile(id, TILE, tile.title)
        check("the menu is up again with the same rows", rows == TOUCH_ROWS, "rows $rows")
        val copied = touchUntil("Copy Link", { menuRow("Copy Link") }, { clipText() == tile.url }, waitMs = 6_000)
        check("a touch on Copy Link puts the tile's URL on the system clipboard", copied, "clip '${clipText()}', tile ${tile.url}")
        check("the menu closed on the pick, the page still in front", awaitJs(MENU_OPEN, false, 4_000) && activeTabId() == id, "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(1_500)
        still("copied")
    }

    // --- 4. dark, and Remove ----------------------------------------------------------------------------

    private fun darkAndRemove() {
        section("4. The dark scheme in place: the page and the menu in dark; Remove under a finger")
        val id = pageTab ?: return
        check("the dark scheme through the core re-inks the chrome and the served page without a relaunch", setScheme("dark", id) && activeTabId() == id, "chrome '${jsText("document.documentElement.dataset.theme")}', page '${pageTheme(id)}'")
        SystemClock.sleep(1_200)
        still("tiles-dark")
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            setScheme("light", id)
            return
        }
        val count = tileCount(id)
        val rows = holdTile(id, TILE, tile.title)
        check("the hold raises the menu in dark with the same rows", rows == TOUCH_ROWS, "rows $rows")
        SystemClock.sleep(1_200)
        still("tile-menu-dark")
        // The grid may fill the gap with the next site (the count holds); the claim is the caption gone.
        val removed = touchUntil("Remove", { menuRow("Remove") }, { !tileCaptions(id).contains(tile.title) }, waitMs = 8_000)
        check("a touch on Remove takes '${tile.title}' off the page (the core's command down the bridge)", removed, "tiles ${tileCaptions(id)} (were $count)")
        SystemClock.sleep(1_200)
        still("removed-dark")
        check("the light scheme back", setScheme("light", id), "chrome '${jsText("document.documentElement.dataset.theme")}'")
    }

    // --- the hold ----------------------------------------------------------------------------------

    /**
     * A real hold on the middle of the tile at `index` (its box read off the served page's DOM,
     * scaled by the page's device pixel ratio, from the page view's own origin) and the menu's
     * rows once it is up; empty when no menu came.
     */
    private fun holdTile(tabId: String, index: Int, caption: String): List<String> {
        for (attempt in 1..3) {
            val point = tileOnScreen(tabId, index) ?: run {
                finding("  (the tile '$caption' is not on the screen to hold)")
                return emptyList()
            }
            finding("  hold at ${point.x.toInt()},${point.y.toInt()} on the tile '$caption'")
            Finger().apply {
                press(point.x, point.y)
                up()
            }
            if (awaitJs(MENU_OPEN, true, 6_000) && awaitDom(MENU_ITEM, 4_000)) {
                SystemClock.sleep(600)
                return textsOf(MENU_ITEM)
            }
            finding("  (the hold did not bring the menu, attempt $attempt)")
            if (inDom(MENU)) back()
            SystemClock.sleep(800)
        }
        return emptyList()
    }

    private fun menuRow(prefix: String) = textRect(MENU_ITEM, prefix)

    // --- the served page's DOM -------------------------------------------------------------------

    private class TileRead(val title: String, val url: String)

    /** The JSON value `code` evaluates to in the tab's own page, as an array; null when it never answered. */
    private fun pageJson(tabId: String, code: String): JSONArray? {
        val raw = pageJs(tabId, "JSON.stringify($code)")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
        return runCatching { JSONArray(text) }.getOrNull()
    }

    private fun tileCount(tabId: String): Int = pageJson(tabId, "[document.querySelectorAll('$TILE_SELECTOR').length]")?.optInt(0) ?: -1

    private fun tileCaptions(tabId: String): List<String> =
        pageJson(tabId, "Array.prototype.map.call(document.querySelectorAll('$TILE_SELECTOR .zen-ntp-caption'),function(e){return e.textContent.trim()})")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()

    private fun tileAt(tabId: String, index: Int): TileRead? {
        val a = pageJson(tabId, "(function(){var t=document.querySelectorAll('$TILE_SELECTOR')[$index];if(!t)return null;var c=t.querySelector('.zen-ntp-caption');return [c?c.textContent.trim():'',t.href]})()") ?: return null
        if (a.length() < 2) return null
        return TileRead(a.getString(0), a.getString(1))
    }

    /**
     * The served document complete in the tab's view, by its own word (`document.readyState`,
     * `location.href`): WebView may report a `loadDataWithBaseURL` document's URL as its `data:`
     * header, so the view's `url` is not read for it.
     */
    private fun awaitServedPage(tabId: String, timeoutMs: Long = 15_000): Boolean = awaitUntil(timeoutMs) {
        val a = pageJson(tabId, "[document.readyState,location.href]")
        a != null && a.optString(0) == "complete" && a.optString(1).removeSuffix("/") == NEW_TAB_URL
    }

    private fun pageTheme(tabId: String): String = pageJson(tabId, "[document.documentElement.dataset.theme||'']")?.optString(0).orEmpty()

    /** Where the tile at `index` is on the screen: its box in the page's CSS px scaled by the page's ratio, from the view's origin. */
    private fun tileOnScreen(tabId: String, index: Int): PointF? {
        val a = pageJson(
            tabId,
            "(function(){var t=document.querySelectorAll('$TILE_SELECTOR')[$index];if(!t)return null;var r=t.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return [(r.left+r.width/2)*d,(r.top+r.height/2)*d]})()"
        ) ?: return null
        if (a.length() < 2) return null
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

    /** The tile with `caption` in the accessibility tree: a clickable node named by the caption (the link's text). */
    private fun tileInTree(caption: String): Boolean = findNodeWhere { node ->
        node.isClickable && (node.text?.toString()?.trim() == caption || node.contentDescription?.toString()?.trim() == caption)
    } != null

    // --- the chrome and the core ---------------------------------------------------------------------

    /**
     * The colour scheme through the core's setting, as Settings would set it; true once the
     * chrome's root and the served page both carry it (the page's own `data-theme`, set from the
     * state pushed down the bridge).
     */
    private fun setScheme(scheme: String, tabId: String): Boolean {
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val chrome = awaitJs("document.documentElement.dataset.theme==='$scheme'", true, 8_000)
        val page = awaitUntil(8_000) { pageTheme(tabId) == scheme }
        if (!chrome || !page) finding("  (scheme '$scheme': chrome ${jsText("document.documentElement.dataset.theme")}, page '${pageTheme(tabId)}')")
        return chrome && page
    }

    private fun pillText(): String = jsString("(function(){var p=document.querySelector('$ADDRESS_PILL');return p?p.textContent.trim():''})()")

    private fun privateInk(): Boolean = jsBoolean("(function(){var r=document.querySelector('$CHROME_ROOT');return !!r&&r.hasAttribute('data-private')})()")

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence().filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }.toList()
    }

    private fun clipboard(): ClipboardManager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun clipText(): String? = onMain {
        clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
    }

    private fun summarise(topSites: String): String = runCatching {
        val list = JSONArray(topSites)
        (0 until list.length()).joinToString(", ") { i ->
            val s = list.getJSONObject(i)
            "${s.optString("title")} (${"%.2f".format(s.optDouble("score"))}${if (s.isNull("favicon")) ", no icon" else ""})"
        }
    }.getOrElse { topSites.take(200) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    // --- the sites ---------------------------------------------------------------------------------

    private fun siteHtml(site: Site): String {
        val hex = String.format("#%06X", site.color and 0xFFFFFF)
        return "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<link rel=icon type=image/png href=/icon.png>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:$hex;color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.title}</h1></header>" +
            "<p>One of the eight sites the demo visits so the tablet's new tab page has most visited tiles to show.</p>" +
            "</body></html>"
    }

    /** A 64 px icon: the site's colour with its initial in white. */
    private fun iconPng(site: Site): ByteArray {
        val size = 64
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = site.color
        canvas.drawRoundRect(0f, 0f, size.toFloat(), size.toFloat(), 14f, 14f, paint)
        paint.color = Color.WHITE
        paint.textSize = 40f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        val baseline = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(site.title.substring(0, 1), size / 2f, baseline, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private companion object {
        /** Beside the base's server (127.0.0.1:18168): the eight sites, one loopback host each. */
        private const val SITE_PORT = 18173
        private const val NEW_TAB_URL = "zen://newtab"
        private const val SENTINEL = "nothing copied yet"
        /** The tile the holds land on: the third, as the phone's demo holds its third. */
        private const val TILE = 2
        private const val TILE_SELECTOR = ".zen-tile:not(.zen-tile-add) a.zen-v2-shortcut"
        /** The touch template's rows (`Menus.showNewTabTileMenu` on `privateTabs && !windows`), the separator between them not a row. */
        private val TOUCH_ROWS = listOf("Open in New Tab", "Open in Private Tab", "Copy Link", "Remove")

        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val NEW_TAB_ROW = "$SIDEBAR [data-new-tab]"
        private const val MENU = ".zen-v2-menu"
        private const val MENU_ITEM = ".zen-v2-menu-item"
        private const val MENU_SEPARATOR = ".zen-v2-menu-separator"
        /** A row of the phone's menu sheet (`MenuSheet`), which the tablet never draws (§9.36). */
        private const val SHEET = ".zen-sheet-item"
    }
}
