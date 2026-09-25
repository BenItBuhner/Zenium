package app.zen.chromium

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.roundToInt

/**
 * Records the phone's link menu on a tab in NO group (PUI-17, Chrome for Android 152's link
 * context menu) on the shared recipe's phone AVD: the rows read by name off the sheet's DOM,
 * against Chrome's list, and "Open Link in New Tab in Group" – Chrome's first row, kept on a
 * loose tab – MAKING the group: the opener and the link's tab a group of two. Every press a real
 * touch on a box read from the chrome's DOM, every outcome read off the core's state.
 *
 *  A. LIGHT, on Home (the active tab, loose): a hold on the page's link raises the sheet with
 *     the link's header (the link's text over its address); the rows are read by name and
 *     written down in Zenium's order, then each of Chrome 152's rows is looked up – Open in new
 *     tab in group, Open in new tab, Open in Incognito tab (Open Link in Private Tab), Copy link
 *     address, Copy link text, Download link (Save Link As…), Share link (Share Link…), Preview
 *     page (Open Link in Glance); Read later has no row, a stated limit (no reading list). The
 *     private row is the host's to offer: the core draws it under `capabilities.privateTabs`,
 *     which Android sets only on a WebView with profiles (Chrome 111+); the shared recipe's
 *     Google APIs image ships WebView 113 without them, so there the row is absent, by design –
 *     the driver reads the capability and expects the row exactly where it is on. The
 *     still `link-menu-design-rows-light.png` is the sheet. Then the touch on Open Link in New
 *     Tab in Group: a NEW folder (not the seeded Research) holds Home and the new tab, the new tab
 *     right behind Home in the background, Home still active, Research's two untouched, the
 *     folder named as the tab menu's Add Tab to New Folder names its own with a colour of the
 *     set, no rename editor over it; the strip's chips as found.
 *  B. DARK, on Gamma (loose, activated by the core): the same rows, byte for byte the light
 *     list; `link-menu-design-rows-dark.png`; the touch makes a second group around Gamma.
 *
 * Findings in `link-menu-findings.txt` (one `OK` or `FAIL` per claim; a claim that does not hold
 * fails the run at the end). The seeded profile is the tab-group drivers' (`tab-groups-demo-
 * state.json`: Research [Alpha, Beta]; Home, Gamma, Delta loose), the pages the driver's own
 * loopback server's – Home's and Gamma's pages carry the link here. Driven by
 * `android-link-menu-demo.yml`. See [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class LinkMenuDemo : GroupsDemoBase("link-menu", "link-menu-demo") {
    override val tag = "LinkMenuDemo"
    override val findingsFile = "link-menu-findings.txt"
    override val title = "Zenium Android link menu on a tab in no group (PUI-17): the rows against Chrome 152, Open Link in New Tab in Group makes the group"

    /** The rows act A read, for act B's byte-for-byte comparison. */
    private var lightRows: List<String> = emptyList()

    @Test
    fun record() = recordDemo(
        mapOf(
            "/" to linkPage("Link menu demo", "The active tab, loose: in no group. Research holds Alpha and Beta."),
            "/gamma.html" to linkPage("Gamma", "Gamma, loose: in no group."),
            OPENED_PATH to DemoServer.page("Opened", "<p>Opened from a loose tab's link: the two are a group now.</p>")
        )
    )

    override fun warmUp() {
        head()
        awaitLoaded(HOME, "$ORIGIN/")
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control (the
        // overview drivers read the overview's Spaces control; this driver never opens it).
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        still("page-light")
        val rowsA = rows("A", HOME, "light")
        lightRows = rowsA
        if (rowsA.isNotEmpty()) makesGroup("A", HOME, "light")
        dark()
        activate(GAMMA, "$ORIGIN/gamma.html")
        still("page-dark")
        val rowsB = rows("B", GAMMA, "dark")
        if (rowsB.isNotEmpty()) {
            check("B: the dark sheet's rows are the light sheet's, byte for byte", rowsB == rowsA, "dark $rowsB, light $rowsA")
            makesGroup("B", GAMMA, "dark")
        }
        still("end")
        tail()
    }

    // --- the rows -----------------------------------------------------------------------------------

    /**
     * A real hold on the link of the page in [tabId] (loose), the sheet up, its header and rows
     * read by name; the rows in the sheet's order (empty when no sheet came). The sheet is left
     * up for [makesGroup].
     */
    private fun rows(act: String, tabId: String, scheme: String): List<String> {
        section("$act. PUI-17 the link menu on a tab in no group ($scheme): the rows by name")
        ensureForeground()
        check("$act: the tab held on is in no group", folderOf(tabId) == null, "folder ${folderOf(tabId)}")
        val link = linkOnScreen(tabId) ?: run {
            check("$act: the page's link is on the screen", false, "no link in $tabId (${describeSpace()})")
            return emptyList()
        }
        finding("  hold at ${link.x.roundToInt()},${link.y.roundToInt()} on the link")
        val f = Finger()
        f.press(link.x, link.y)
        f.up()
        val up = awaitJs(MENU_OPEN, true, SHEET_WAIT) && awaitDom(SHEET_ITEM, SHEET_WAIT)
        check("$act: the link's menu comes up as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return emptyList()
        SystemClock.sleep(600)
        val header = textOf(HEADER_TITLE) to textOf(HEADER_URL)
        finding("  header: title '${header.first}' address '${header.second}'")
        check("$act: the header is the link's text over its address (PUI-18)", header.first == LINK_TEXT && header.second == OPENED_URL, "header $header")
        val items = textsOf(SHEET_ITEM)
        finding("  rows as found, in Zenium's order (${items.size}):")
        items.forEachIndexed { i, row -> finding("    ${i + 1}. $row") }
        val privateTabs = privateTabsCapability()
        finding("  the host: capabilities.privateTabs $privateTabs (${webViewPackage()})")
        finding("  Chrome 152's rows, each looked up (its position in Zenium's list):")
        var missing = 0
        for ((chrome, ours) in CHROME_152) {
            if (ours == null) {
                finding("    $chrome -> none: a STATED LIMIT (no reading list)")
                continue
            }
            if (ours == PRIVATE_ROW && !privateTabs) {
                finding("    $chrome -> $ours: no row on THIS host, by design (capabilities.privateTabs off: the WebView keeps no profiles); drawn where it is on")
                continue
            }
            val at = items.indexOf(ours)
            if (at < 0) missing++
            finding("    $chrome -> $ours ${if (at < 0) "MISSING" else "(${at + 1})"}")
        }
        val mapped = CHROME_152.mapNotNull { it.second }
        val own = items.filter { it !in mapped }
        finding("  Zenium's own rows, not in Chrome's list: $own")
        check("$act: Open Link in New Tab in Group is the first row on a tab in no group (Chrome's first)", items.indexOf(GROUP_ROW) == 0, "rows $items")
        check("$act: Open Link in New Tab is second (Chrome's second)", items.indexOf(PLAIN_ROW) == 1, "rows $items")
        check(
            "$act: Open Link in Private Tab (Chrome's Incognito) is on the sheet exactly where capabilities.privateTabs is on" +
                if (privateTabs) ", third" else " – off on this WebView, so no row",
            if (privateTabs) items.indexOf(PRIVATE_ROW) == 2 else PRIVATE_ROW !in items,
            "privateTabs $privateTabs, rows $items"
        )
        check("$act: every Chrome 152 row the host offers has its Zenium row (Read later the stated limit)", missing == 0, "$missing missing")
        check("$act: Open Link in Glance (Chrome's Preview page) is on the sheet", "Open Link in Glance" in items)
        check("$act: no Read later row (the stated limit)", items.none { it.contains("Read later", ignoreCase = true) || it.contains("Reading list", ignoreCase = true) })
        finding("  the rows' order against Chrome 152's is the design lead's (b): recorded, not judged here")
        shot("design-rows-$scheme")
        return items
    }

    // --- the group made -----------------------------------------------------------------------------

    /**
     * The touch on Open Link in New Tab in Group with the sheet up: a new folder around the
     * opener [tabId] and the link's tab, behind it, in the background.
     */
    private fun makesGroup(act: String, tabId: String, scheme: String) {
        section("$act. Open Link in New Tab in Group on a tab in no group makes the group ($scheme)")
        val before = trackOrder()
        val foldersBefore = folderIds()
        val researchBefore = groupTabs().map { it.first }
        val opened = touchUntil(GROUP_ROW, { textRect(SHEET_ITEM, GROUP_ROW) }, { trackOrder().size == before.size + 1 }, waitMs = 6_000)
        val order = trackOrder()
        val newTab = order.map { it.first }.firstOrNull { id -> id !in before.map { it.first } }
        check("$act: the page opens as a new tab", opened && newTab != null && awaitCore { tabUrl(newTab, it) == OPENED_URL }, "new ${newTab?.let { tabUrl(it) }}")
        if (newTab == null) return
        val made = folderIds().filter { it !in foldersBefore }
        val group = folderOf(tabId)
        finding("  folders made by the touch: $made; the opener's folder now $group; the new tab's ${folderOf(newTab)}")
        check("$act: ONE new folder is made, and it is not the seeded Research", made.size == 1 && made.first() != FOLDER, "made $made")
        check("$act: the opener is moved into the new folder", group != null && group == made.firstOrNull(), "opener's folder $group")
        check("$act: the new tab is in the same folder: the two are a group of two", folderOf(newTab) == group && order.count { it.second == group } == 2, "members ${order.filter { it.second == group }.map { it.first }}")
        val at = order.indexOfFirst { it.first == newTab }
        val openerAt = order.indexOfFirst { it.first == tabId }
        check("$act: the new tab sits right behind the opener", at == openerAt + 1, "order ${order.map { "${it.first}${it.second?.let { g -> "(${g.take(12)})" } ?: ""}" }}")
        check("$act: the opener stays the active tab (the link opened in the background)", activeTabId() == tabId, "active ${activeTabId()}")
        check("$act: Research keeps Alpha and Beta, untouched", groupTabs().map { it.first } == researchBefore, "research ${groupTabs()}")
        val record = group?.let { coreState().getJSONObject("folders").optJSONObject(it) }
        val colour = record?.let { if (it.isNull("color")) null else it.optString("color") }
        finding("  the folder's record: name '${record?.optString("name")}' icon '${record?.optString("icon")}' colour $colour collapsed ${record?.optBoolean("collapsed")}")
        check("$act: the folder is named as the tab menu's Add Tab to New Folder names its own, with a colour of the set, open", record != null && record.optString("name") == "New Folder" && !colour.isNullOrEmpty() && !record.optBoolean("collapsed"), "record $record")
        check("$act: no rename editor is opened over it (the row is the gesture)", !jsBoolean(RENAMING), "renaming ${jsText(RENAMING)}")
        check("$act: the sheet is gone after the touch", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        val strip = awaitDom(STRIP, 6_000)
        val chips = if (strip) textsOf("$STRIP .zen-group-chip") else emptyList()
        finding("  the group strip under the bar: ${if (strip) "up, chips ${chips.size} as found: $chips" else "not up (as found)"}")
        SystemClock.sleep(1_000)
        still("group-made-$scheme")
    }

    // --- the scheme and the tab -------------------------------------------------------------------

    private fun dark() {
        section("dark scheme for the design record")
        ensureForeground()
        shellCommand("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        finding("  the chrome's scheme now: ${chromeScheme()}")
    }

    /** The core activates [tabId] (a touch on its card is the overview drivers' business), its page loaded. */
    private fun activate(tabId: String, url: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val active = awaitCore { activeTabId(it) == tabId }
        awaitLoaded(tabId, url)
        SystemClock.sleep(1_500)
        finding("  $tabId activated: $active; ${describeSpace()}")
    }

    private fun folderIds(state: JSONObject = coreState()): List<String> {
        val folders = state.getJSONObject("folders")
        return folders.keys().asSequence().toList()
    }

    /** The core's word on private tabs: on only where the WebView keeps profiles (`androidCapabilities`). */
    private fun privateTabsCapability(): Boolean =
        runCatching { coreState().getJSONObject("capabilities").optBoolean("privateTabs") }.getOrDefault(false)

    private fun webViewPackage(): String =
        shellCommand("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "WebView package ?"

    companion object {
        private const val OPENED_PATH = "/opened.html"
        private const val OPENED_URL = "$ORIGIN$OPENED_PATH"
        private const val LINK_TEXT = "A page to open in a new group"
        private const val GROUP_ROW = "Open Link in New Tab in Group"
        private const val PLAIN_ROW = "Open Link in New Tab"
        private const val PRIVATE_ROW = "Open Link in Private Tab"

        private const val SHEET = ".zen-sheet"
        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val HEADER_TITLE = ".zen-sheet .zen-menu-link-title"
        private const val HEADER_URL = ".zen-sheet .zen-menu-link-url"
        private const val STRIP = ".zen-group-strip:not([aria-hidden])"

        /**
         * Chrome for Android 152's link context menu, in Chrome's order, each row against
         * Zenium's (null: no row of ours – Read later, a stated limit: Zenium has no reading list).
         */
        private val CHROME_152: List<Pair<String, String?>> = listOf(
            "Open in new tab in group" to GROUP_ROW,
            "Open in new tab" to PLAIN_ROW,
            "Open in Incognito tab" to PRIVATE_ROW,
            "Copy link address" to "Copy Link Address",
            "Copy link text" to "Copy Link Text",
            "Download link" to "Save Link As…",
            "Share link" to "Share Link…",
            "Read later" to null,
            "Preview page" to "Open Link in Glance"
        )

        /** A page with the link the menu is held on, its colours following the device's scheme. */
        private fun linkPage(title: String, lead: String): Pair<String, ByteArray> = DemoServer.page(
            title,
            "<style>:root{color-scheme:light dark}@media(prefers-color-scheme:dark){body{background:#121212;color:#e8eaed}a{color:#8ab4f8}}</style>" +
                "<p>$lead</p>" +
                "<p><a id=\"demo-link\" href=\"$OPENED_PATH\" style=\"display:inline-block;padding:18px 8px;font-size:24px\">$LINK_TEXT</a></p>" +
                "<p>Hold the link for its menu.</p>"
        )
    }
}
