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
 * never off the accessibility tree, which trails the emulator's software GPU. The live region is
 * read off a record the page keeps of its own announcer store ([plantSaid]): the region clears
 * itself 7 s after a message, sooner than a crawling emulator answers the bridge.
 *
 * The seed is made at warm-up through the core's `bookmark.create`, in this order so `dateAdded`
 * climbs: Mango (Gamma's page) · the folder Work · apple (Delta's page) · the folder arts · Zebra
 * (Alpha's page), all under Mobile bookmarks – the panel opens straight inside its only root.
 *
 *  A. THE MENU: the list opens in Compact view (the default – a stated deviation from Chrome's
 *     VISUAL, design language v2 §9.29); the header's "Sort and view options" button raises the
 *     sheet – eight radio rows, Chrome's words in the phone menus' Title Case (Sort by Manual
 *     Order · Newest · Oldest · Last Opened · A to Z · Z to A; Visual View · Compact View),
 *     "Sort by Manual Order" and "Compact View" checked.
 *  B. THE ORDERS: each row under a finger writes the pref, says Chrome's announcement through the
 *     live region and re-orders the list – manual order the model's own, folders and pages as
 *     stored (Chrome's `sortByStoredPref` returns it untouched); every other order folders first,
 *     then the key, Chrome's `sortCompare` (A to Z case-insensitive: apple before Mango before
 *     Zebra). The manual → A to Z re-sort is sampled per animation frame until it has rendered
 *     and settled: the rows GLIDE (translate transforms on the cells, §11) rather than cut.
 *  C. THE VIEW: "Visual View" stands every row on a tile (the favicon or the folder glyph at the
 *     tile's 32 on each; a page image where an open tab shows the page) in place of the compact
 *     row's lead.
 *  D. LAST OPENED: a real touch on apple's row opens its page in the current tab (the core stamps
 *     `dateLastUsed`, the panel leaves); the panel reopened keeps the picked order and view (the
 *     prefs persist) and, sorted by last opened, puts apple first among the pages, the folders
 *     still first.
 *  E. DARK: the device's night mode on – the Visual list and the menu for the record, then
 *     "Compact View" drops the tiles for the lead glyph again; the device left light for the
 *     next driver.
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
        check("seed: the prefs start at the defaults – manual order, Compact view (the stated deviation from Chrome's VISUAL, v2 §9.29)", sortPref() == "manual" && displayPref() == "compact", "sort '${sortPref()}' display '${displayPref()}'")
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
        still("compact")
        check("A: the list stands in manual order, every row the compact lead – no tile (Compact the default)", listTitles() == MANUAL && tiles() == 0 && leads() == MANUAL.size, "titles ${listTitles()}, tiles ${tiles()}, leads ${leads()}")
        if (!openSortView("A")) return
        val rows = textsOf(SHEET_ITEM)
        finding("  rows as found (${rows.size}): $rows")
        check("A: the sheet is titled 'Sort and view options' (Chrome's `sort_and_view_options`)", textOf(SHEET_TITLE) == MENU_TITLE, "title '${textOf(SHEET_TITLE)}'")
        check("A: eight radio rows in Title Case – the six orders, then Visual View · Compact View", rows == ORDER_ROWS + VIEW_ROWS, "rows $rows")
        check("A: every row is a menuitemradio", jsNumber("document.querySelectorAll('$SHEET_ITEM[role=\"menuitemradio\"]').length").toInt() == rows.size, "radios ${jsNumber("document.querySelectorAll('$SHEET_ITEM[role=\"menuitemradio\"]').length")}")
        val checked = checkedRows()
        check("A: 'Sort by Manual Order' and 'Compact View' are checked – the defaults", checked == listOf("Sort by Manual Order", "Compact View"), "checked $checked")
        still("sort-menu")
    }

    // --- B. the orders ----------------------------------------------------------------------------------------

    private fun theOrders() {
        section("B. each order under a finger: the pref, the announcement, the list; the manual → A to Z glide")
        pick("B", "Sort by Newest", "newest", "Sorting by newest", NEWEST)
        pick("B", "Sort by Oldest", "oldest", "Sorting by oldest", OLDEST)
        pick("B", "Sort by Z to A", "z-a", "Sorting from Z to A", Z_A)
        pick("B", "Sort by Manual Order", "manual", "Sorting by manual order", MANUAL)
        // The big re-sort, sampled per animation frame while it runs.
        pick("B", "Sort by A to Z", "a-z", "Sorting from A to Z", A_Z, sampleGlide = true)
        check("B: the checked row follows the pref", openSortView("B") && checkedRows() == listOf("Sort by A to Z", "Compact View"), "checked ${checkedRows()}")
        back()
        awaitDomGone(SHEET, SHEET_WAIT)
        SystemClock.sleep(600)
    }

    /**
     * The sheet opened (unless it is), the row `label` under a finger, the pref `key` awaited; then
     * the announcement (off the page's own record of the live region, [saidSince]) and the list's
     * order. With `sampleGlide`, a per-frame sampler is planted before the touch and read once the
     * list has re-ordered and the glide has settled: how many frames carried a moving row.
     *
     * The touch has taken once the sheet leaves OR the pref reads back – on a crawling emulator
     * (frames of 200–400 ms in the first run) the core's state trails the touch by seconds, and a
     * retry against a sheet already gone would wait `LOOKUP_WAIT` for nothing.
     */
    private fun pick(act: String, label: String, key: String, announcement: String, expected: List<String>, sampleGlide: Boolean = false) {
        if (!inDom(SHEET_ITEM) && !openSortView(act)) return
        val mark = saidMark()
        if (sampleGlide) plantSampler(expected)
        touchUntil(label, { textRect(SHEET_ITEM, label) }, { !inDom(SHEET_ITEM) || sortPref() == key }, waitMs = PICK_WAIT)
        val wrote = awaitUntil(PICK_WAIT) { sortPref() == key }
        if (!wrote) touchFault("a touch on '$label' did not take: the pref is '${sortPref()}', not '$key'")
        check("$act: a touch on '$label' writes bookmarkRowSortOrder '$key'", wrote, "pref '${sortPref()}'")
        check("$act: the sheet leaves on the pick", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        check("$act: the live region says '$announcement'", awaitUntil(SAID_WAIT) { saidSince(mark, announcement) }, "said ${saidList(mark)}")
        val ordered = awaitUntil(PICK_WAIT) { listTitles() == expected }
        check("$act: the list re-orders to $expected (${if (key == "manual") "the model's order untouched" else "folders first, then the key, Chrome's sortCompare"})", ordered, "titles ${listTitles()}")
        if (sampleGlide) glideFrames()
        SystemClock.sleep(900)
        still("sorted-$key")
    }

    /**
     * A rAF sampler on the page: per frame, how many `[data-cell]` rows carry a translate and the
     * largest |dy|. It runs until the list reads `expected` and the rows have stood still for three
     * frames after moving (the glide over), or 2.5 s past the re-order with no row ever moving (a
     * cut), or [SAMPLE_CAP_MS] – never a fixed window, which a slow emulator's re-render outlasts.
     */
    private fun plantSampler(expected: List<String>) {
        val want = JSONArray(expected).toString()
        chromeJs(
            "(function(){var frames=[];var start=performance.now();var want=${JSONObject.quote(want)};var matchedAt=-1,saw=false,quiet=0;" +
                "function titles(){return JSON.stringify(Array.prototype.map.call(document.querySelectorAll('$LIST .zen-list-title'),function(e){return e.textContent.trim()}))}" +
                "function tick(now){var cells=document.querySelectorAll('[data-cell]');var moving=0,peak=0;" +
                "for(var i=0;i<cells.length;i++){var t=cells[i].style.transform;if(t&&t!=='none'){moving++;var m=/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(t);" +
                "if(m){var dy=Math.abs(parseFloat(m[2]));if(dy>peak)peak=dy}}}var at=Math.round(now-start);frames.push([at,moving,Math.round(peak)]);" +
                "if(matchedAt<0&&titles()===want)matchedAt=at;if(moving>0){saw=true;quiet=0}else if(saw)quiet++;" +
                "var done=(matchedAt>=0&&saw&&quiet>=3)||(matchedAt>=0&&at-matchedAt>2500)||at>$SAMPLE_CAP_MS;" +
                "if(done){window.__w6e1SamplerDone=true;window.__w6e1MatchedAt=matchedAt}else requestAnimationFrame(tick)}" +
                "window.__w6e1Frames=frames;window.__w6e1SamplerDone=false;window.__w6e1MatchedAt=-1;requestAnimationFrame(tick);return true})()"
        )
    }

    /** The sampler read: the frames on which rows were mid-move – the glide's length and reach. */
    private fun glideFrames() {
        awaitUntil(SAMPLE_CAP_MS + 2_000) { jsBoolean("window.__w6e1SamplerDone===true") }
        val frames = jsArray("window.__w6e1Frames||[]")
        val matchedAt = jsNumber("window.__w6e1MatchedAt||-1").toInt()
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
        val span = if (frames.length() > 0) frames.getJSONArray(frames.length() - 1).getInt(0) else 0
        val reduced = jsBoolean("matchMedia('(prefers-reduced-motion: reduce)').matches")
        finding("  frames sampled ${frames.length()} over $span ms (the list re-ordered at $matchedAt ms); rows mid-move on $moving of them, from $first ms to $last ms, peak |dy| $peak px; reduced motion $reduced")
        check("B: the manual → A to Z re-sort GLIDES – rows carry translate transforms across frames (the FLIP on the house spring), not a cut", moving >= 3 && peak > 0, "moving frames $moving, peak $peak px, reduced $reduced")
    }

    // --- the live region's record --------------------------------------------------------------------------------

    /**
     * A record of the live region on the page itself: every text the announcer store carries, with
     * the page's own clock. Read through the bridge, the region can be empty again (it clears 7 s
     * after a message) before a slow emulator has answered; the record is not. Planted once.
     */
    private fun plantSaid() {
        val planted = jsBoolean(
            "(function(){if(window.__w6e1Said)return true;var s=window.__zenStores&&window.__zenStores.announcer;if(!s)return false;" +
                "var said=[];window.__w6e1Said=said;var last='';s.subscribe(function(){var t=s.get().text||'';if(t&&t!==last)said.push([Math.round(performance.now()),t]);last=t});return true})()"
        )
        if (!planted) finding("  (the announcer store is not on the page: announcements cannot be recorded)")
    }

    /** How many announcements the record holds now – the mark a later [saidSince] reads from. */
    private fun saidMark(): Int = jsNumber("(window.__w6e1Said||[]).length").toInt()

    /** Whether `text` was announced since `mark`. */
    private fun saidSince(mark: Int, text: String): Boolean =
        jsBoolean("(window.__w6e1Said||[]).slice($mark).some(function(e){return e[1]===${JSONObject.quote(text)}})")

    /** What was announced since `mark`, for a failed claim's detail. */
    private fun saidList(mark: Int): String = jsText("(window.__w6e1Said||[]).slice($mark).map(function(e){return e[1]})")

    // --- C. the view -----------------------------------------------------------------------------------------

    private fun theView() {
        section("C. Visual View: the tiles in place of the compact leads")
        if (!openSortView("C")) return
        val mark = saidMark()
        val visual = pickView("Visual View", "visual")
        check("C: a touch on 'Visual View' writes bookmarkRowDisplay 'visual'", visual, "display '${displayPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        val visualRows = awaitUntil(PICK_WAIT) { attrOf(LIST, "data-display") == "visual" && tiles() == A_Z.size && leads() == 0 }
        check("C: every row stands on a tile – the compact leads gone", visualRows, "display '${attrOf(LIST, "data-display")}', tiles ${tiles()}, leads ${leads()}")
        check("C: the order is kept across the view switch", listTitles() == A_Z, "titles ${listTitles()}")
        val pictures = jsNumber("document.querySelectorAll('$LIST .zen-list-picture > .zen-list-page').length").toInt()
        val marks = jsNumber("document.querySelectorAll('$LIST .zen-list-picture > .zen-list-mark').length").toInt()
        val markPx = jsNumber("(function(){var m=document.querySelector('$LIST .zen-list-picture > .zen-list-mark');return m?Math.round(m.getBoundingClientRect().width):0})()").toInt()
        finding("  tiles carrying a page image: $pictures (an open tab showing the page); carrying the favicon or folder glyph: $marks, the glyph box $markPx CSS px wide")
        check("C: each tile carries either the page image or the favicon / folder glyph", pictures + marks == A_Z.size, "pictures $pictures, marks $marks")
        check("C: the tile's glyph box is the tile's 32, not the row's 20 (v2 §9.29)", marks == 0 || markPx == 32, "glyph box $markPx px")
        check("C: the live region says 'Showing visual view'", awaitUntil(SAID_WAIT) { saidSince(mark, "Showing visual view") }, "said ${saidList(mark)}")
        SystemClock.sleep(900)
        still("visual")
        check("C: the sheet's checked rows read the state – A to Z, Visual View", openSortView("C") && checkedRows() == listOf("Sort by A to Z", "Visual View"), "checked ${checkedRows()}")
        back()
        awaitDomGone(SHEET, SHEET_WAIT)
        SystemClock.sleep(600)
    }

    /** A view row under a finger: taken once the sheet leaves or the display pref reads back; the pref awaited. */
    private fun pickView(label: String, display: String): Boolean {
        touchUntil(label, { textRect(SHEET_ITEM, label) }, { !inDom(SHEET_ITEM) || displayPref() == display }, waitMs = PICK_WAIT)
        val wrote = awaitUntil(PICK_WAIT) { displayPref() == display }
        if (!wrote) touchFault("a touch on '$label' did not take: the display is '${displayPref()}', not '$display'")
        return wrote
    }

    // --- D. last opened --------------------------------------------------------------------------------------

    private fun lastOpened() {
        section("D. a real touch on apple's row opens its page; sorted by last opened, apple leads the pages")
        check("D: no row has been opened yet (dateLastUsed unset on every page)", nodes().none { it.optLong("dateLastUsed", 0L) > 0L }, "nodes ${nodes().map { "${it.optString("title")}:${it.optLong("dateLastUsed", 0L)}" }}")
        val opened = touchUntil("apple's row", { textRect("$LIST .zen-list-title", "apple") }, { lastUsed("apple") > 0L }, waitMs = PICK_WAIT)
        if (!opened) touchFault("a touch on apple's row did not take: dateLastUsed is ${lastUsed("apple")}")
        check("D: a touch on the row opens the page in the current tab and stamps the node's dateLastUsed", opened && awaitCore { tabUrl(HOME, it) == DELTA_URL }, "dateLastUsed ${lastUsed("apple")}, Home at ${tabUrl(HOME)}")
        check("D: the panel leaves on the open", awaitDomGone(PANEL_SEARCH, 6_000), "panel ${inDom(PANEL_SEARCH)}")
        awaitLoaded(HOME, DELTA_URL)
        SystemClock.sleep(1_000)
        still("opened-from-row")

        if (!openPanel("D")) return
        check("D: reopened, the panel keeps the A to Z order and the Visual view (the prefs persist; neither is the default)", listTitles() == A_Z && attrOf(LIST, "data-display") == "visual", "titles ${listTitles()}, display '${attrOf(LIST, "data-display")}'")
        if (!openSortView("D")) return
        val mark = saidMark()
        touchUntil("Sort by Last Opened", { textRect(SHEET_ITEM, "Sort by Last Opened") }, { !inDom(SHEET_ITEM) || sortPref() == "last-opened" }, waitMs = PICK_WAIT)
        val wrote = awaitUntil(PICK_WAIT) { sortPref() == "last-opened" }
        if (!wrote) touchFault("a touch on 'Sort by Last Opened' did not take: the pref is '${sortPref()}'")
        check("D: a touch on 'Sort by Last Opened' writes bookmarkRowSortOrder 'last-opened'", wrote, "pref '${sortPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        val ordered = awaitUntil(PICK_WAIT) { listTitles().let { it.size == 5 && it.take(2).toSet() == FOLDERS && it[2] == "apple" } }
        check("D: sorted by last opened, the folders still lead and apple heads the pages (the two never opened trail, by id)", ordered, "titles ${listTitles()}")
        check("D: the live region says 'Sorting by last opened'", awaitUntil(SAID_WAIT) { saidSince(mark, "Sorting by last opened") }, "said ${saidList(mark)}")
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
        val mark = saidMark()
        val compact = pickView("Compact View", "compact")
        check("E: a touch on 'Compact View' writes bookmarkRowDisplay 'compact'", compact, "display '${displayPref()}'")
        awaitDomGone(SHEET, SHEET_WAIT)
        check("E: the rows drop their tiles for the lead glyph – a folder or favicon at the row's lead, no picture (Compact on the dark scheme)", awaitUntil(PICK_WAIT) { attrOf(LIST, "data-display") == "compact" && tiles() == 0 && leads() == 5 }, "display '${attrOf(LIST, "data-display")}', tiles ${tiles()}, leads ${leads()}")
        check("E: the live region says 'Showing compact view'", awaitUntil(SAID_WAIT) { saidSince(mark, "Showing compact view") }, "said ${saidList(mark)}")
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
        check("$act: a touch on Show Bookmarks opens the panel, inside Mobile bookmarks (the only root with rows)", up && awaitUntil(PICK_WAIT) { findByLabel("Mobile bookmarks") != null || textOf(HEADER_TITLE) == "Mobile bookmarks" }, "panel ${inDom(PANEL_SEARCH)}, header '${textOf(HEADER_TITLE)}'")
        if (up) plantSaid()
        SystemClock.sleep(1_200)
        return up
    }

    /** The header's Sort and view options button under a finger, the sheet awaited. */
    private fun openSortView(act: String): Boolean {
        val up = touchUntil("the Sort and view options button", { domRect(SORT_VIEW_BUTTON) }, { jsBoolean(MENU_OPEN) && inDom(SHEET_ITEM) }, waitMs = SHEET_WAIT)
        check("$act: a touch on 'Sort and view options' raises the sheet", up, "menu ${jsText(MENU_OPEN)}, items ${inDom(SHEET_ITEM)}")
        if (up) SystemClock.sleep(900)
        return up
    }

    private fun checkedRows(): List<String> = textsOf("$SHEET_ITEM[aria-checked=\"true\"]")

    private fun listTitles(): List<String> = textsOf("$LIST .zen-list-title")

    private fun tiles(): Int = jsNumber("document.querySelectorAll('$LIST .zen-list-picture').length").toInt()

    private fun leads(): Int = jsNumber("document.querySelectorAll('$LIST .zen-list-lead').length").toInt()

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
        /** A pick's outcome awaited this long: the core's state trails a touch by seconds on a crawling emulator. */
        private const val PICK_WAIT = 8_000L
        /** An announcement awaited this long in the page's own record. */
        private const val SAID_WAIT = 6_000L
        /** The glide sampler's ceiling; it ends earlier once the re-order has rendered and the rows stand still. */
        private const val SAMPLE_CAP_MS = 15_000L

        private val ORDER_ROWS = listOf("Sort by Manual Order", "Sort by Newest", "Sort by Oldest", "Sort by Last Opened", "Sort by A to Z", "Sort by Z to A")
        private val VIEW_ROWS = listOf("Visual View", "Compact View")

        // MANUAL as made (the model's order untouched); the rest Chrome's sortCompare over the seed:
        // folders first, then the key; ties by id (none here).
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
