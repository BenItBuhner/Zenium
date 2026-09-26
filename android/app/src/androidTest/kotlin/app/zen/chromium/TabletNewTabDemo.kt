package app.zen.chromium

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import kotlin.math.abs

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
 *     and the chrome's own surface, so the same driver on main is the 'before' run. The fresh
 *     tab COMES UP BARE on the tablet: the served page in view, its own field at rest – no URL
 *     bar in new-tab mode over a cover, no keyboard rising unasked – where the desktop's rule
 *     (`Browser.revealFreshTab` → `newtab.opened` → the bar) still holds on the desktop: the
 *     renderer's `newTabRevealOpensUrlbar` lets the arrival's announcement (no `text`) open no
 *     bar on a touch layout. A REAL TAP on the page's field HANDS OFF to the pill's omnibox
 *     popup (the page's `search` action, `text` ''): on this chassis the pages composite above
 *     the chrome, so the popup stands over the tab's cover picture while the live view is hidden
 *     under it (`overlayCoversContent`); a back puts the popup away and the view comes back.
 *     Then the page's EMPTY state at a fresh boot ("Sites you visit often will appear here"),
 *     light and dark;
 *  1. eight loopback sites visited off camera, a new tab from the sidebar's row under a finger:
 *     the served page with the most visited tiles, bare as at boot (`NewTabService.open` →
 *     `newtab.opened`), the tab's URL `zen://newtab`, the page view placed and shown, the tiles
 *     in the page's DOM AND in the accessibility tree, the pill reading the empty tab's words;
 *     the tiles' ICONS REAL: every tile's `<img>` loaded from `zen://favicon/<hash>`, answered
 *     at the head of the view's intercept chain on the served view alone from the chrome's
 *     favicon store (`TabWebView.newTabFavicon` → `BootHandoff.favicon`), not the letter it
 *     falls back to; the coarse pointer's numbers: the field 56, Customise 40, a tile 64 in the
 *     page's CSS px; the tap on the field → the omnibox popup, and a back. On main's tree the
 *     same row opens the bar bound to no tab and makes no tab at all (`urlbar.toggle`);
 *  2. a REAL HOLD on a tile (the finger down past the long press, on the tile's own box read off
 *     the page's DOM): the tablet's anchored menu with the touch template's FIVE rows – Open in
 *     New Tab · Open in Private Tab · Copy Link · a separator · Remove (the desktop's template is
 *     not this one; a most-visited tile has no Edit Shortcut) – HUNG FROM THE TILE's BOX: the
 *     `tile-menu` action carries the tile's rect up the bridge (`MenuAnchor.rect`), the menu's
 *     start edge level with the tile's and its top flush at the box's bottom (above the box when
 *     the room below runs out), not at the finger's point – and Open in Private Tab under a
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

    /** Where the last hold's finger was on the screen ([holdTile]): the point the menu must NOT hang from. */
    private var lastHold: PointF? = null

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
                check("the served page is loaded before the recording, by the document's own word (readyState complete at zen://newtab)", awaitServedPage(id), "document ${pageJson(id, "[document.readyState,location.href]")}")
                // The fresh tab's reveal on the tablet (Browser.revealFreshTab → newtab.opened
                // with no text): the page comes up BARE – in view, its own field at rest, no URL
                // bar over a cover, no keyboard – where the desktop's rule opens the bar in
                // new-tab mode (newTabRevealOpensUrlbar: the announcement opens none on a touch
                // layout). Then the tap on the page's field: the hand-off to the omnibox popup.
                bareComeUp(id, "the fresh tab")
                SystemClock.sleep(800)
                still("boot-opened-light")
                handOff(id, "the fresh tab's field", frame = null)
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

    /**
     * On main's tree the sidebar's row asks the core for a new tab (`tab.new`) and, the page off,
     * `NewTabService.open` toggles the URL bar in new-tab mode bound to no tab instead: no tab is
     * made until a submit. Recorded as it is; nothing of the served page claimed.
     */
    private fun mainsNewTab() {
        section("1. Main's tree: the sidebar's New Tab row opens the URL bar bound to no tab (no served page on this host)")
        val before = activeTabId()
        val opened = touchUntil("New Tab", { domRect(NEW_TAB_ROW) }, { urlbarOpen() }, waitMs = 8_000)
        check(
            "a touch on the sidebar's New Tab row opens the URL bar in new-tab mode bound to no tab, and no tab is made (NewTabService.open without the page: urlbar.toggle)",
            opened && activeTabId() == before,
            "urlbar.open ${urlbarOpen()}, active ${activeTabId()} (was $before)"
        )
        val url = activeCoreTab()?.optString("url").orEmpty()
        finding("  the active tab stays at '$url'; the served page's scenes need newTabPage on and are skipped here")
        SystemClock.sleep(1_200)
        still("new-tab-main")
        val close = closeUrlField()
        check("a back puts the bar away, the page kept", close.ok, close.describe())
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
        // NewTabService.open: the tab made and activated, then `newtab.opened` with no text – on
        // the tablet no bar comes of it: the page is up bare, its field at rest (as at boot).
        check("the page's state came down the bridge: the tiles are in the page's DOM (the sites visited)", awaitUntil(15_000) { tileCount(id) >= 4 }, "tiles ${tileCaptions(id)}")
        bareComeUp(id, "the new tab")
        check("the page view is placed, shown and loaded: the document's own location is zen://newtab", awaitServedPage(id) && pageShown(id), "document ${pageJson(id, "[document.readyState,location.href]")}, shown ${pageShown(id)}")
        val captions = tileCaptions(id)
        finding("  tiles in the page's order: $captions")
        check("the tiles are the visited sites, every caption a site's title", captions.isNotEmpty() && captions.all { c -> sites.any { it.title == c } }, "captions $captions")
        icons(id)
        coarseNumbers(id)
        SystemClock.sleep(1_200)
        still("opened-light")
        handOff(id, "the new tab's field", frame = "handoff-light")
        val first = captions.firstOrNull()
        check("the tiles stand in the accessibility tree once the view is shown (the first tile, by its caption, inside the page view's box)", first != null && awaitUntil(15_000) { tileInTree(id, first) }, "first '$first': ${first?.let { describeTileNode(id, it) }}")
        if (first != null) finding("  the first tile's node: ${describeTileNode(id, first)}")
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
        menuHangsFromTile(id, TILE, lastHold)
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
            // The live view comes back a beat after a menu or the bar goes (the chrome's layout
            // report, then the host's placement): the tile is waited for on the screen.
            if (!awaitUntil(6_000) { tileOnScreen(tabId, index) != null }) {
                finding("  (the tile '$caption' is not on the screen to hold: page shown ${pageShown(tabId)}, urlbar ${urlbarOpen()}, menu ${jsText(MENU_OPEN)})")
                return emptyList()
            }
            val point = tileOnScreen(tabId, index) ?: return emptyList()
            lastHold = point
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

    // --- the bare come-up, the hand-off, the icons, the numbers, the anchor --------------------------

    /**
     * The bare come-up: `what` (the fresh tab at boot, the new tab from the row) arrives with the
     * served page IN VIEW – the view placed and shown, no URL bar in new-tab mode over a cover –
     * its own field AT REST (not focused) and NO KEYBOARD rising unasked. The arrival's
     * `newtab.opened` carries no `text`, and the renderer's `newTabRevealOpensUrlbar` opens no bar
     * for it on a touch layout (the desktop's reveal – the bar – unchanged). Watched for two
     * seconds past the view's placement, the window in which the desktop's rule brought the bar.
     */
    private fun bareComeUp(tabId: String, what: String) {
        val shown = awaitUntil(8_000) { pageShown(tabId) && !urlbarOpen() }
        var barCame = false
        var covered = false
        val until = SystemClock.uptimeMillis() + 2_000
        while (SystemClock.uptimeMillis() < until) {
            if (urlbarOpen()) barCame = true
            if (!pageShown(tabId)) covered = true
            SystemClock.sleep(150)
        }
        val rest = pageJson(
            tabId,
            "(function(){var i=document.getElementById('zen-search-input');return [document.activeElement===i,document.hasFocus(),i?i.inputMode:'?',window.matchMedia('(pointer: coarse)').matches]})()"
        )
        finding(
            "  $what's come-up: view shown ${pageShown(tabId)}, urlbar.open ${urlbarOpen()} (a bar within 2 s: $barCame; the view covered: $covered), " +
                "the field focused ${rest?.opt(0)} (document focused ${rest?.opt(1)}, inputmode '${rest?.opt(2)}', pointer coarse ${rest?.opt(3)}), keyboard inset ${imeInset()}"
        )
        check(
            "$what comes up BARE: the served page in view – placed and shown, no URL bar in new-tab mode over a cover, none within two seconds (the arrival's newtab.opened opens no bar on the tablet)",
            shown && !barCame && !covered && pageShown(tabId) && !urlbarOpen(),
            "shown ${pageShown(tabId)}, urlbar.open ${urlbarOpen()}, a bar came $barCame, covered $covered"
        )
        check(
            "the page's own field is at rest on arrival – not focused, inputmode none under the coarse pointer – and no keyboard rose unasked",
            rest != null && !rest.optBoolean(0) && rest.optString(2) == "none" && !imeShown(),
            "focused ${rest?.opt(0)}, inputmode '${rest?.opt(2)}', keyboard inset ${imeInset()}"
        )
    }

    /**
     * The served page's field is a hand-off control on the tablet: a REAL TAP on it sends the
     * page's `search` action (`text` '') and the chrome opens the pill's omnibox popup in new-tab
     * mode bound to the tab (`openNewTabPageUrlbar` – on the user's tap now, not on the arrival).
     * On this chassis the pages composite above the chrome, so the popup stands over the tab's
     * cover picture and the live view is hidden under it (`overlayCoversContent`); the chrome's
     * field takes the keyboard. Then a back puts the popup away and the view comes back
     * ([dismissBar]). `frame` names the still of the popup over the cover, when one is wanted.
     */
    private fun handOff(tabId: String, what: String, frame: String?) {
        val point = pagePointOnScreen(tabId, "document.getElementById('zen-search')") ?: run {
            check("$what is on the screen to tap", false, "page shown ${pageShown(tabId)}")
            return
        }
        finding("  tap at ${point.x.toInt()},${point.y.toInt()} on $what")
        Finger().tap(point.x, point.y)
        val opened = awaitUntil(8_000) { urlbarOpen() }
        check(
            "a tap on $what hands off to the pill's omnibox popup: the URL bar opens in new-tab mode bound to the tab (the page's search action → openNewTabPageUrlbar)",
            opened && urlbarMode() == "new-tab" && urlbarTab() == tabId,
            "urlbar.open ${urlbarOpen()}, mode '${urlbarMode()}', tab ${urlbarTab()} (the page's $tabId)"
        )
        check("the popup stands over the tab's cover picture on this chassis, the live view hidden under it (overlayCoversContent)", awaitUntil(4_000) { !pageShown(tabId) }, "shown ${pageShown(tabId)}")
        finding("  the keyboard after the hand-off: ${if (awaitIme(true, 4_000)) "up (the chrome's field took it), inset ${imeInset()}" else "not up within 4 s (inset ${imeInset()})"}")
        if (frame != null) {
            SystemClock.sleep(1_000)
            still(frame)
        }
        dismissBar(tabId, "the omnibox popup")
    }

    /**
     * The tiles' icons are real: every tile's `<img class="zen-ntp-icon">` – its `src` the core's
     * `zen://favicon/<hash>`, answered on the served view alone by `TabWebView.newTabFavicon` from
     * the chrome's favicon store – decoded (`complete`, a `naturalWidth`), and no tile fallen back
     * to its letter (`.zen-ntp-letter`, what an errored `<img>` is replaced with). Every loopback
     * site serves a 64 px PNG at `/icon.png`, so every tile has one to show.
     */
    private fun icons(tabId: String) {
        val loaded = awaitUntil(15_000) { iconRead(tabId)?.let { it.optInt(0) > 0 && it.optInt(1) == it.optInt(0) && it.optInt(2) == 0 } == true }
        val read = iconRead(tabId)
        finding("  the tiles' icons: ${read?.opt(1)} of ${read?.opt(0)} <img> decoded (naturalWidth > 0), ${read?.opt(2)} letter fallbacks; sources ${read?.optJSONArray(3)}; naturalWidths ${read?.optJSONArray(4)}")
        check(
            "every tile's icon is the real one – the <img> loaded from zen://favicon/<hash> through the served view's intercept (complete, naturalWidth > 0) – and no tile fell back to its letter",
            loaded,
            "tiles ${read?.opt(0)}, decoded ${read?.opt(1)}, letters ${read?.opt(2)}, widths ${read?.optJSONArray(4)}"
        )
        check("the icons' sources are the core's zen://favicon/<hash> (the desktop's protocol, answered on this view)", read != null && read.optInt(0) > 0 && read.optBoolean(5), "sources ${read?.optJSONArray(3)}")
    }

    /** `[tiles, decoded, letters, sources (the scheme and path head), naturalWidths, every source zen://favicon/]` off the page. */
    private fun iconRead(tabId: String): JSONArray? = pageJson(
        tabId,
        "(function(){var t=document.querySelectorAll('.zen-tile:not(.zen-tile-add)');var n=t.length,ok=0,letters=0,src=[],w=[],all=n>0;" +
            "for(var i=0;i<n;i++){var img=t[i].querySelector('img.zen-ntp-icon');if(t[i].querySelector('.zen-ntp-letter'))letters++;" +
            "if(img){src.push(img.src.slice(0,14));w.push(img.naturalWidth);if(img.complete&&img.naturalWidth>0)ok++;if(img.src.indexOf('zen://favicon/')!==0)all=false}" +
            "else{src.push('');w.push(-1);all=false}}return [n,ok,letters,src,w,all]})()"
    )

    /**
     * The served page under a coarse pointer takes the touch layouts' numbers: the field 56, the
     * Customise button 40, a tile 64 – read as the page's own CSS px (`getBoundingClientRect`;
     * the boxes are `border-box`), the `(pointer: coarse)` query true on the tablet.
     */
    private fun coarseNumbers(tabId: String) {
        val a = pageJson(
            tabId,
            "(function(){var f=document.getElementById('zen-search'),c=document.getElementById('zen-customize'),t=document.querySelector('.zen-tile:not(.zen-tile-add) .zen-ntp-tile');" +
                "var h=function(e){return e?Math.round(e.getBoundingClientRect().height*100)/100:-1},w=function(e){return e?Math.round(e.getBoundingClientRect().width*100)/100:-1};" +
                "var tops={};Array.prototype.forEach.call(document.querySelectorAll('.zen-tile'),function(e){tops[Math.round(e.getBoundingClientRect().top)]=1});" +
                "return [window.matchMedia('(pointer: coarse)').matches,h(f),h(c),w(t),h(t),window.devicePixelRatio,Object.keys(tops).length,document.querySelectorAll('.zen-tile').length]})()"
        )
        finding("  the page's measures (CSS px, ratio ${a?.opt(5)}): (pointer: coarse) ${a?.opt(0)}, the field ${a?.opt(1)}, Customise ${a?.opt(2)}, a tile ${a?.opt(3)} x ${a?.opt(4)}; ${a?.opt(7)} tiles (the add tile counted) in ${a?.opt(6)} rows")
        check(
            "the tablet's page is under a coarse pointer and takes its numbers: the field 56, Customise 40, a tile 64 x 64",
            a != null && a.optBoolean(0) && a.optDouble(1) == 56.0 && a.optDouble(2) == 40.0 && a.optDouble(3) == 64.0 && a.optDouble(4) == 64.0,
            "coarse ${a?.opt(0)}, field ${a?.opt(1)}, Customise ${a?.opt(2)}, tile ${a?.opt(3)} x ${a?.opt(4)}"
        )
    }

    /**
     * The hold menu hangs from the TILE's BOX, not from the finger: the `tile-menu` action carries
     * the tile's rect (`.zen-tile`: the square and its caption) up the bridge, the core puts it on
     * the anchor's `rect` on a touch layout and the tablet's `placeRootMenu` sets the popover
     * flush under it, start-aligned, above it when the room below runs out (§9.20). Read as
     * screen px on both sides once they hold still: the tile's box off the page (its CSS px by
     * the page's ratio, from the view's origin), the menu's off the chrome ([screen]). `hold` is
     * where the finger was: the tile's middle, which no edge of the menu may sit at.
     */
    private fun menuHangsFromTile(tabId: String, index: Int, hold: PointF?) {
        val tile = steady { tileBoxOnScreen(tabId, index) }
        val menu = steady { screen(domRect(MENU))?.let { RectF(it) } }
        if (tile == null || menu == null) {
            check("the tile's box and the menu are both on the screen to compare", false, "tile $tile, menu $menu")
            return
        }
        val startAligned = abs(menu.left - tile.left) <= SLACK
        val below = abs(menu.top - tile.bottom) <= SLACK
        val above = abs(menu.bottom - tile.top) <= SLACK
        finding(
            "  the tile's box on the screen ${tile.toShortString()}, the menu's ${menu.toShortString()} (${menu.width().toInt()} wide), the finger at ${hold?.x?.toInt()},${hold?.y?.toInt()}: " +
                "start edges ${menu.left} / ${tile.left}, the menu's top ${menu.top} at the box's bottom ${tile.bottom}${if (above) " (flipped above: its bottom ${menu.bottom} at the box's top ${tile.top})" else ""}"
        )
        check(
            "the menu hangs from the tile's box: its start edge level with the tile's (start-aligned) and its top flush at the box's bottom – or its bottom at the box's top when the room below ran out",
            startAligned && (below || above),
            "start ${menu.left} vs ${tile.left}; top ${menu.top} vs the box's bottom ${tile.bottom}; bottom ${menu.bottom} vs the box's top ${tile.top}"
        )
        check(
            "the menu is not at the finger's point: no edge of it sits at the hold (the tile's middle)",
            hold != null && abs(menu.left - hold.x) > SLACK && abs(menu.right - hold.x) > SLACK && abs(menu.top - hold.y) > SLACK && abs(menu.bottom - hold.y) > SLACK,
            "menu ${menu.toShortString()}, finger ${hold?.x},${hold?.y}"
        )
        check("the menu carries the page as its source (`data-source=\"page\"`: the tile's menu, the one the box anchor is for)", inDom("$MENU[data-source=\"page\"]"), "")
    }

    /** A box read twice 300 ms apart that agrees (a popover popping in moves on each frame); the last read when three seconds pass without one. */
    private fun steady(read: () -> RectF?): RectF? {
        var last = read()
        val deadline = SystemClock.uptimeMillis() + 3_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            val next = read()
            if (last != null && next != null && abs(next.left - last.left) < 0.5f && abs(next.top - last.top) < 0.5f && abs(next.right - last.right) < 0.5f && abs(next.bottom - last.bottom) < 0.5f) return next
            last = next
        }
        return last
    }

    private fun urlbarMode(): String = jsText("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).mode||''")

    private fun urlbarTab(): String = jsText("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).tabId||''")

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

    /** Where the tile at `index` is on the screen: the middle of its link's box in the page's CSS px scaled by the page's ratio, from the view's origin. */
    private fun tileOnScreen(tabId: String, index: Int): PointF? = pagePointOnScreen(tabId, "document.querySelectorAll('$TILE_SELECTOR')[$index]")

    /** Where the middle of the element the JS expression `element` names is on the screen; null when there is none or the view is not shown. */
    private fun pagePointOnScreen(tabId: String, element: String): PointF? {
        val a = pageJson(
            tabId,
            "(function(){var t=$element;if(!t)return null;var r=t.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return [(r.left+r.width/2)*d,(r.top+r.height/2)*d]})()"
        ) ?: return null
        if (a.length() < 2) return null
        val origin = viewOrigin(tabId) ?: return null
        return PointF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat())
    }

    /** The box of the tile at `index` – `.zen-tile`, the square and its caption: the rect the page sends with `tile-menu` – on the screen. */
    private fun tileBoxOnScreen(tabId: String, index: Int): RectF? {
        val a = pageJson(
            tabId,
            "(function(){var t=document.querySelectorAll('$TILE_SELECTOR')[$index];var b=t&&t.closest('.zen-tile');if(!b)return null;var r=b.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return [r.left*d,r.top*d,r.right*d,r.bottom*d]})()"
        ) ?: return null
        if (a.length() < 4) return null
        val origin = viewOrigin(tabId) ?: return null
        return RectF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat(), origin[0] + a.getDouble(2).toFloat(), origin[1] + a.getDouble(3).toFloat())
    }

    /** The page view's origin on the screen; null while the view is not placed and shown (a hidden view is not there to touch). */
    private fun viewOrigin(tabId: String): IntArray? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) null else IntArray(2).also(view::getLocationOnScreen)
    }

    /**
     * The tile with `caption` in the accessibility tree: a node named by the caption (the link's
     * text – Chromium names the link node itself or its text child, so the click is read off the
     * node or one above it, not asked of the named one) whose centre lies inside the page view's
     * box on the screen (the sidebar names a tab after its page, so the box is what tells a tile
     * from a tab row). Null while the view is hidden: a hidden view has no nodes.
     */
    private fun tileNode(tabId: String, caption: String): AccessibilityNodeInfo? {
        val box = pageBox(tabId) ?: return null
        val bounds = Rect()
        return findNodeWhere { node ->
            val named = node.text?.toString()?.trim() == caption || node.contentDescription?.toString()?.trim() == caption
            named && run {
                node.getBoundsInScreen(bounds)
                box.contains(bounds.centerX(), bounds.centerY())
            }
        }
    }

    private fun tileInTree(tabId: String, caption: String): Boolean = tileNode(tabId, caption) != null

    /** The named node for the finding: its class, its name, and where the click is (itself, a node above it, or nowhere within four). */
    private fun describeTileNode(tabId: String, caption: String): String {
        val node = tileNode(tabId, caption) ?: return "no node named '$caption' inside the page view (shown ${pageShown(tabId)})"
        var clickable = if (node.isClickable) "itself" else "no"
        var up = node.parent
        var hops = 0
        while (clickable == "no" && up != null && hops < 4) {
            hops++
            if (up.isClickable) clickable = "$hops up"
            up = up.parent
        }
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return "${node.className} '${node.text ?: node.contentDescription}' at $bounds, clickable $clickable"
    }

    /** The page view's box on the screen; null while it is not shown. */
    private fun pageBox(tabId: String): Rect? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) {
            null
        } else {
            val origin = IntArray(2)
            view.getLocationOnScreen(origin)
            Rect(origin[0], origin[1], origin[0] + view.width, origin[1] + view.height)
        }
    }

    // --- the chrome and the core ---------------------------------------------------------------------

    /**
     * Whether the tab's page view is placed and shown (VISIBLE up its tree): the host hides every
     * page view while a chrome surface covers the content (`overlayCoversContent` – the URL bar
     * in new-tab mode, a menu), and shows the tab's cover picture in its place.
     */
    private fun pageShown(tabId: String): Boolean = onMain { host.tabs.get(tabId)?.isShown == true }

    /**
     * The omnibox popup away with a back ([closeUrlField]: the keyboard first when it is up, never
     * a second back blind, the page read before and after) and the tab's live view back on the
     * screen once the popup's cover is gone – the claim each hand-off ends on, before the scene
     * reads the page's tree or holds a tile.
     */
    private fun dismissBar(tabId: String, what: String) {
        val close = closeUrlField()
        val shown = close.ok && awaitUntil(8_000) { pageShown(tabId) }
        check("a back dismisses $what and the live page view comes back, placed and shown", shown, "${close.describe()}; shown ${pageShown(tabId)}")
        awaitIme(false)
        SystemClock.sleep(600)
    }

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
        /** The touch template's rows (`Menus.showNewTabTileMenu`: Open in Private Tab on `privateTabs && !windows`, Copy Link on `!windows`), the separator between them not a row. */
        private val TOUCH_ROWS = listOf("Open in New Tab", "Open in Private Tab", "Copy Link", "Remove")
        /** How far (screen px) a menu's edge may sit from the tile box's it is read against: a rounding each side. */
        private const val SLACK = 3f

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
