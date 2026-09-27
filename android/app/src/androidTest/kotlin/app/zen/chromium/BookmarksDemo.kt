package app.zen.chromium

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the phone bookmarks panel's Sort and view options (HB-13, W6-E1; PR #612) on the shared
 * recipe's phone AVD, against Chrome 152's `BookmarkUiPrefs` and `ImprovedBookmarkQueryHandler`:
 * every press in the sheet a real touch, every outcome read off the core's state (the settings
 * `bookmarkRowSortOrder` / `bookmarkRowDisplay`, a node's `dateLastUsed`) or the chrome's DOM –
 * never off the accessibility tree, which trails the emulator's software GPU.
 *
 * The seed is made at warm-up through the core's `bookmark.create`, in this order so `dateAdded`
 * climbs: Mango (Gamma's page) · the folder Work · apple (Delta's page) · the folder arts · Zebra
 * (Alpha's page), all under Mobile bookmarks – the panel opens straight inside its only root.
 *
 *  A. THE MENU: the header's "Sort and view options" button raises the sheet – eight radio rows
 *     in Chrome's words (Sort by manual order · newest · oldest · last opened · A to Z · Z to A;
 *     Visual view · Compact view), "Sort by manual order" and "Visual view" checked (Chrome's
 *     defaults, `BookmarkUiPrefs`).
 *  B. THE ORDERS: each row under a finger writes the pref, says Chrome's announcement through the
 *     live region and re-orders the list – folders first, then the key, Chrome's `sortCompare`
 *     (A to Z case-insensitive: apple before Mango before Zebra). The manual → A to Z re-sort is
 *     sampled per animation frame: the rows GLIDE (translate transforms on the cells, §11) rather
 *     than cut.
 *  C. THE VIEW: "Compact view" drops the tiles for the lead glyph on the two-line row; "Visual
 *     view" puts the tiles back (the favicon or the folder glyph on each; a page image where an
 *     open tab shows the page).
 *  D. LAST OPENED: a real touch on apple's row opens its page in the current tab (the core stamps
 *     `dateLastUsed`, the panel leaves); the panel reopened and sorted by last opened puts apple
 *     first among the pages, the folders still first.
 *  E. DARK: the device's night mode on – the Visual list, the menu and Compact view again for
 *     the record; the device left light for the next driver.
 *
 * Stills `bookmarks-sort-view-NN-<state>.png`; findings in `bookmarks-sort-view-findings.txt`
 * (one `OK` or `FAIL` per claim; a claim that does not hold fails the run at the end). The seeded
 * profile is the tab-group drivers' (`tab-groups-demo-state.json`), the pages the driver's own
 * loopback server's. Driven by `android-bookmarks-sort-view-demo.yml` and by the nightly sweep's
 * phone-d shard (`.github/nightly-drivers/bookmarks-sort-view.json`). See [GroupsDemoBase].
 */
@RunWith(AndroidJUnit4::class)
class BookmarksDemo : GroupsDemoBase("bookmarks-sort-view", handshakeDir = "bookmarks-sort-view-demo") {
    override val tag = "BookmarksDemo"
    override val findingsFile = "bookmarks-sort-view-findings.txt"
    override val title = "Zenium Android bookmarks sort and view on the phone (HB-13): the Sort and view options menu, Chrome's six orders, Visual and Compact, the re-sort glide"

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        head()
        awaitLoaded(HOME, HOME_URL)
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control.
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        seed()
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        try {
            theMenu()
            theOrders()
            theView()
            lastOpened()
            dark()
            still("end")
        } finally {
            light()
        }
        tail()
    }

    // --- the seed ------------------------------------------------------------------------------------------

    /** Five nodes under Mobile bookmarks through the core, 150 ms apart so `dateAdded` orders them. */
    private fun seed() {
        section("seed: Mango · Work (folder) · apple · arts (folder) · Zebra under Mobile bookmarks, in that order")
        check("seed: the tree starts without bookmarks under Mobile bookmarks", mobileRows().isEmpty(), "rows ${mobileRows()}")
        create("Mango", GAMMA_URL)
        create("Work", null)
        create("apple", DELTA_URL)
        create("arts", null)
        create("Zebra", ALPHA_URL)
        val rows = mobileRows()
        check("seed: the five stand in manual order as made", rows == MANUAL, "rows $rows")
        check("seed: the prefs start at Chrome's defaults – manual order, Visual view", sortPref() == "manual" && displayPref() == "visual", "sort '${sortPref()}' display '${displayPref()}'")
    }

    private fun create(title: String, url: String?) {
        val args = JSONObject().put("parentId", MOBILE).put("title", title)
        if (url != null) args.put("url", url) else args.put("type", "folder")
        coreInvoke("bookmark.create", args.toString())
        awaitCore { state -> nodes(state).any { it.optString("title") == title } }
        SystemClock.sleep(150)
    }

    // --- A. the menu ----------------------------------------------------------------------------------------

    private fun theMenu() {
        section("A. the header's Sort and view options button and its sheet")
        ensureForeground()
        if (!openPanel("A")) return
        still("visual")
        check("A: the list stands in manual order, every row a Visual tile", listTitles() == MANUAL && tiles() == MANUAL.size && leads() == 0, "titles ${listTitles()}, tiles ${tiles()}, leads ${leads()}")
        if (!openSortView("A")) return
        val rows = textsOf(SHEET_ITEM)
        finding("  rows as found (${rows.size}): $rows")
        check("A: the sheet is titled 'Sort and view options' (Chrome's `sort_and_view_options`)", textOf(SHEET_TITLE) == MENU_TITLE, "title '${textOf(SHEET_TITLE)}'")
        check("A: eight radio rows in Chrome's words – the six orders, then Visual view · Compact view", rows == ORDER_ROWS + VIEW_ROWS, "rows $rows")
        check("A: every row is a menuitemradio", jsNumber("document.querySelectorAll('$SHEET_ITEM[role=\"menuitemradio\"]').length").toInt() == rows.size, "radios ${jsNumber("document.querySelectorAll('$SHEET_ITEM[role=\"menuitemradio\"]').length")}")
        val checked = checkedRows()
        check("A: 'Sort by manual order' and 'Visual view' are checked – Chrome's defaults", checked == listOf("Sort by manual order", "Visual view"), "checked $checked")
        still("sort-menu")
    }

    // --- B. the orders ----------------------------------------------------------------------------------------

    private fun theOrders() {
        section("B. each order under a finger: the pref, the announcement, the list; the manual → A to Z glide")
        pick("B", "Sort by newest", "newest", "Sorting by newest", NEWEST)
        pick("B", "Sort by oldest", "oldest", "Sorting by oldest", OLDEST)
        pick("B", "Sort by Z to A", "z-a", "Sorting from Z to A", Z_A)
        pick("B", "Sort by manual order", "manual", "Sorting by manual order", MANUAL)
        // The big re-sort, sampled per animation frame while it runs.
        pick("B", "Sort by A to Z", "a-z", "Sorting from A to Z", A_Z, sampleGlide = true)
        check("B: the checked row follows the pref", openSortView("B") && checkedRows() == listOf("Sort by A to Z", "Visual view"), "checked ${checkedRows()}")
        back()
        awaitDomGone(SHEET, SHEET_WAIT)
        SystemClock.sleep(600)
    }

    /**
     * The sheet opened (unless it is), the row `label` under a finger, the pref `key` awaited; then
     * the announcement and the list's order. With `sampleGlide`, a per-frame sampler is planted
     * before the touch and read after the list settled: how many frames carried a moving row.
     */
    private fun pick(act: String, label: String, key: String, announcement: String, expected: List<String>, sampleGlide: Boolean = false) {
        if (!inDom(SHEET_ITEM) && !openSortView(act)) return
        if (sampleGlide) plantSampler()
        val took = touchUntil(label, { textRect(SHEET_ITEM, label) }, { sortPref() == key }, waitMs = 3_000)
        if (!took) touchFault("a touch on '$label' did not take: the pref is '${sortPref()}', not '$key'")
        check("$act: a touch on '$label' writes bookmarkRowSortOrder '$key'", took, "pref '${sortPref()}'")
        check("$act: the sheet leaves on the pick", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        val ordered = awaitUntil(4_000) { listTitles() == expected }
        check("$act: the list re-orders to $expected (folders first, then the key, Chrome's sortCompare)", ordered, "titles ${listTitles()}")
        if (sampleGlide) glideFrames()
        check("$act: the live region says '$announcement'", awaitUntil(2_000) { announced() == announcement }, "announced '${announced()}'")
        SystemClock.sleep(900)
        still("sorted-$key")
    }

    /** A rAF sampler on the page: per frame, how many `[data-cell]` rows carry a translate and the largest |dy|. */
    private fun plantSampler() {
        chromeJs(
            "(function(){var frames=[];var start=performance.now();function tick(now){var cells=document.querySelectorAll('[data-cell]');var moving=0,peak=0;" +
                "for(var i=0;i<cells.length;i++){var t=cells[i].style.transform;if(t&&t!=='none'){moving++;var m=/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(t);" +
                "if(m){var dy=Math.abs(parseFloat(m[2]));if(dy>peak)peak=dy}}}frames.push([Math.round(now-start),moving,Math.round(peak)]);" +
                "if(now-start<$SAMPLE_MS)requestAnimationFrame(tick)}requestAnimationFrame(tick);window.__w6e1Frames=frames;return true})()"
        )
    }

    /** The sampler read: the frames on which rows were mid-move – the glide's length and reach. */
    private fun glideFrames() {
        awaitUntil(SAMPLE_MS + 1_000) { jsBoolean("window.__w6e1Frames&&window.__w6e1Frames.length>0&&window.__w6e1Frames[window.__w6e1Frames.length-1][0]>=$SAMPLE_MS") }
        val frames = jsArray("window.__w6e1Frames||[]")
        var moving = 0
        var first = -1
        var last = -1
        var peak = 0
        for (i in 0 until frames.length()) {
            val f = frames.getJSONArray(i)
            if (f.getInt(1) > 0) {
                moving++
                if (first < 0) first = f.getInt(0)
                last = f.getInt(0)
                if (f.getInt(2) > peak) peak = f.getInt(2)
            }
        }
        val reduced = jsBoolean("matchMedia('(prefers-reduced-motion: reduce)').matches")
        finding("  frames sampled ${frames.length()} over $SAMPLE_MS ms; rows mid-move on $moving of them, from $first ms to $last ms, peak |dy| $peak px; reduced motion $reduced")
        check("B: the manual → A to Z re-sort GLIDES – rows carry translate transforms across frames (the FLIP on the house spring), not a cut", moving >= 3 && peak > 0, "moving frames $moving, peak $peak px, reduced $reduced")
    }

    // --- C. the view -----------------------------------------------------------------------------------------

    private fun theView() {
        section("C. Compact view, then Visual view again")
        if (!openSortView("C")) return
        val compact = touchUntil("Compact view", { textRect(SHEET_ITEM, "Compact view") }, { displayPref() == "compact" }, waitMs = 3_000)
        if (!compact) touchFault("a touch on 'Compact view' did not take: the display is '${displayPref()}'")
        check("C: a touch on 'Compact view' writes bookmarkRowDisplay 'compact'", compact, "display '${displayPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        val compactRows = awaitUntil(4_000) { attrOf(LIST, "data-display") == "compact" && tiles() == 0 && leads() == A_Z.size }
        check("C: the rows drop their tiles for the lead glyph – a folder or favicon at the row's lead, no picture", compactRows, "display '${attrOf(LIST, "data-display")}', tiles ${tiles()}, leads ${leads()}")
        check("C: the order is kept across the view switch", listTitles() == A_Z, "titles ${listTitles()}")
        check("C: the live region says 'Showing compact view'", awaitUntil(2_000) { announced() == "Showing compact view" }, "announced '${announced()}'")
        SystemClock.sleep(900)
        still("compact")

        if (!openSortView("C")) return
        check("C: the sheet's checked rows read the state – A to Z, Compact view", checkedRows() == listOf("Sort by A to Z", "Compact view"), "checked ${checkedRows()}")
        val visual = touchUntil("Visual view", { textRect(SHEET_ITEM, "Visual view") }, { displayPref() == "visual" }, waitMs = 3_000)
        if (!visual) touchFault("a touch on 'Visual view' did not take: the display is '${displayPref()}'")
        check("C: a touch on 'Visual view' writes bookmarkRowDisplay 'visual'", visual, "display '${displayPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        val visualRows = awaitUntil(4_000) { attrOf(LIST, "data-display") == "visual" && tiles() == A_Z.size && leads() == 0 }
        check("C: every row carries its tile again", visualRows, "display '${attrOf(LIST, "data-display")}', tiles ${tiles()}, leads ${leads()}")
        val pictures = jsNumber("document.querySelectorAll('$LIST .zen-list-picture > .zen-list-page').length").toInt()
        val marks = jsNumber("document.querySelectorAll('$LIST .zen-list-picture > .zen-list-mark').length").toInt()
        finding("  tiles carrying a page image: $pictures (an open tab showing the page); carrying the favicon or folder glyph: $marks")
        check("C: each tile carries either the page image or the favicon / folder glyph", pictures + marks == A_Z.size, "pictures $pictures, marks $marks")
        check("C: the live region says 'Showing visual view'", awaitUntil(2_000) { announced() == "Showing visual view" }, "announced '${announced()}'")
        SystemClock.sleep(600)
    }

    // --- D. last opened --------------------------------------------------------------------------------------

    private fun lastOpened() {
        section("D. a real touch on apple's row opens its page; sorted by last opened, apple leads the pages")
        check("D: no row has been opened yet (dateLastUsed unset on every page)", nodes().none { it.optLong("dateLastUsed", 0L) > 0L }, "nodes ${nodes().map { "${it.optString("title")}:${it.optLong("dateLastUsed", 0L)}" }}")
        val opened = touchUntil("apple's row", { textRect("$LIST .zen-list-title", "apple") }, { lastUsed("apple") > 0L }, waitMs = 4_000)
        if (!opened) touchFault("a touch on apple's row did not take: dateLastUsed is ${lastUsed("apple")}")
        check("D: a touch on the row opens the page in the current tab and stamps the node's dateLastUsed", opened && awaitCore { tabUrl(HOME, it) == DELTA_URL }, "dateLastUsed ${lastUsed("apple")}, Home at ${tabUrl(HOME)}")
        check("D: the panel leaves on the open", awaitDomGone(PANEL_SEARCH, 6_000), "panel ${inDom(PANEL_SEARCH)}")
        awaitLoaded(HOME, DELTA_URL)
        SystemClock.sleep(1_000)
        still("opened-from-row")

        if (!openPanel("D")) return
        check("D: reopened, the panel keeps the A to Z order and the Visual view (the prefs persist)", listTitles() == A_Z && attrOf(LIST, "data-display") == "visual", "titles ${listTitles()}, display '${attrOf(LIST, "data-display")}'")
        if (!openSortView("D")) return
        val took = touchUntil("Sort by last opened", { textRect(SHEET_ITEM, "Sort by last opened") }, { sortPref() == "last-opened" }, waitMs = 3_000)
        if (!took) touchFault("a touch on 'Sort by last opened' did not take: the pref is '${sortPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        val ordered = awaitUntil(4_000) { listTitles().let { it.size == 5 && it.take(2).toSet() == FOLDERS && it[2] == "apple" } }
        check("D: sorted by last opened, the folders still lead and apple heads the pages (the two never opened trail, by id)", ordered, "titles ${listTitles()}")
        check("D: the live region says 'Sorting by last opened'", awaitUntil(2_000) { announced() == "Sorting by last opened" }, "announced '${announced()}'")
        SystemClock.sleep(900)
        still("sorted-last-opened")
    }

    // --- E. the dark scheme -----------------------------------------------------------------------------------

    private fun dark() {
        section("E. dark scheme for the design record")
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        val dark = awaitUntil(8_000) { chromeScheme() == "dark" }
        SystemClock.sleep(2_500)
        ensureForeground()
        check("E: the chrome's root carries the dark scheme", dark, "data-theme '${chromeScheme()}'")
        if (!inDom(PANEL_SEARCH) && !openPanel("E")) return
        SystemClock.sleep(800)
        still("visual-dark")
        if (!openSortView("E")) return
        still("sort-menu-dark")
        val compact = touchUntil("Compact view", { textRect(SHEET_ITEM, "Compact view") }, { displayPref() == "compact" }, waitMs = 3_000)
        if (!compact) touchFault("a touch on 'Compact view' did not take on the dark scheme")
        awaitDomGone(SHEET, SHEET_WAIT)
        check("E: Compact view on the dark scheme", compact && awaitUntil(4_000) { tiles() == 0 && leads() == 5 }, "tiles ${tiles()}, leads ${leads()}")
        SystemClock.sleep(900)
        still("compact-dark")
        back()
        awaitDomGone(PANEL_SEARCH, 6_000)
    }

    /** The device as it was found: the nightly sweep's reset puts the app's data back, not the night mode. */
    private fun light() {
        shell("cmd uimode night no")
        coreInvoke("settings.update", "{\"colorScheme\":\"system\"}")
        finding("  the device's night mode put back off for the next driver")
    }

    // --- the panel and the sheet -------------------------------------------------------------------------------

    /** The app menu's Bookmarks › Show Bookmarks under a finger, the panel awaited by its search field. */
    private fun openPanel(act: String): Boolean {
        if (!openMenuItem(MENU_BOOKMARKS, MENU_SHOW)) {
            check("$act: the app menu carries Bookmarks › Show Bookmarks", false, "no such rows in the menu")
            back()
            SystemClock.sleep(800)
            return false
        }
        val up = awaitDom(PANEL_SEARCH, 8_000)
        check("$act: a touch on Show Bookmarks opens the panel, inside Mobile bookmarks (the only root with rows)", up && awaitUntil(4_000) { findByLabel("Mobile bookmarks") != null || textOf(HEADER_TITLE) == "Mobile bookmarks" }, "panel ${inDom(PANEL_SEARCH)}, header '${textOf(HEADER_TITLE)}'")
        SystemClock.sleep(1_200)
        return up
    }

    /** The header's Sort and view options button under a finger, the sheet awaited. */
    private fun openSortView(act: String): Boolean {
        val up = touchUntil("the Sort and view options button", { domRect(SORT_VIEW_BUTTON) }, { jsBoolean(MENU_OPEN) && inDom(SHEET_ITEM) }, waitMs = 3_000)
        check("$act: a touch on 'Sort and view options' raises the sheet", up, "menu ${jsText(MENU_OPEN)}, items ${inDom(SHEET_ITEM)}")
        if (up) SystemClock.sleep(900)
        return up
    }

    private fun checkedRows(): List<String> = textsOf("$SHEET_ITEM[aria-checked=\"true\"]")

    private fun listTitles(): List<String> = textsOf("$LIST .zen-list-title")

    private fun tiles(): Int = jsNumber("document.querySelectorAll('$LIST .zen-list-picture').length").toInt()

    private fun leads(): Int = jsNumber("document.querySelectorAll('$LIST .zen-list-lead').length").toInt()

    private fun announced(): String = jsString("(window.__zenStores.announcer&&window.__zenStores.announcer.get().text)||''")

    // --- the core's state ----------------------------------------------------------------------------------

    private fun nodes(state: JSONObject = coreState()): List<JSONObject> {
        val list: JSONArray = state.optJSONArray("bookmarks") ?: return emptyList()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    /** The titles under Mobile bookmarks in the model's own (manual) order. */
    private fun mobileRows(state: JSONObject = coreState()): List<String> =
        nodes(state).filter { it.optString("parentId") == MOBILE }.sortedBy { it.optInt("index") }.map { it.optString("title") }

    private fun lastUsed(title: String): Long = nodes().firstOrNull { it.optString("title") == title }?.optLong("dateLastUsed", 0L) ?: 0L

    private fun sortPref(state: JSONObject = coreState()): String = state.optJSONObject("settings")?.optString("bookmarkRowSortOrder").orEmpty()

    private fun displayPref(state: JSONObject = coreState()): String = state.optJSONObject("settings")?.optString("bookmarkRowDisplay").orEmpty()

    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    companion object {
        private const val HOME_URL = "$ORIGIN/"
        private const val GAMMA_URL = "$ORIGIN/gamma.html"
        private const val DELTA_URL = "$ORIGIN/delta.html"
        private const val MOBILE = "3"

        private const val MENU_BOOKMARKS = "Bookmarks"
        private const val MENU_SHOW = "Show Bookmarks"
        private const val MENU_TITLE = "Sort and view options"
        private const val SAMPLE_MS = 2_000L

        private val ORDER_ROWS = listOf("Sort by manual order", "Sort by newest", "Sort by oldest", "Sort by last opened", "Sort by A to Z", "Sort by Z to A")
        private val VIEW_ROWS = listOf("Visual view", "Compact view")

        // Chrome's sortCompare over the seed: folders first, then the key; ties by id (none here).
        private val MANUAL = listOf("Mango", "Work", "apple", "arts", "Zebra")
        private val NEWEST = listOf("arts", "Work", "Zebra", "apple", "Mango")
        private val OLDEST = listOf("Work", "arts", "Mango", "apple", "Zebra")
        private val A_Z = listOf("arts", "Work", "apple", "Mango", "Zebra")
        private val Z_A = listOf("Work", "arts", "Zebra", "Mango", "apple")
        private val FOLDERS = setOf("Work", "arts")

        private const val SHEET = ".zen-sheet"
        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val SHEET_TITLE = ".zen-sheet .zen-sheet-title"
        private const val PANEL_SEARCH = ".zen-phone-panel input[placeholder=\"Search bookmarks\"]"
        private const val HEADER_TITLE = ".zen-phone-panel .zen-phone-title"
        private const val SORT_VIEW_BUTTON = ".zen-phone-panel [aria-label=\"Sort and view options\"]"
        private const val LIST = ".zen-phone-list[data-display]"
    }
}
