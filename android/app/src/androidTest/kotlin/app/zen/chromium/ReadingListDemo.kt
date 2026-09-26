package app.zen.chromium

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.roundToInt

/**
 * Records the phone's reading list on desktop's shared model (HB-20, W6-D1; PR #551) on the
 * shared recipe's phone AVD: every way in and the panel, each press a real touch, every outcome
 * read off the core's state (`UIState.readingList`) or the chrome's DOM – never off the
 * accessibility tree, which trails the emulator's software GPU.
 *
 *  A. THE APP MENU'S VERB on Home (the active tab, loose, unlisted): a touch on "Add to Reading
 *     List" saves the page – one entry at Home's address, unread, titled by the page – and the
 *     toast reads "Added to reading list"; the menu reopened carries "Remove from Reading List"
 *     in the same seat, and a touch on it takes the entry away ("Removed from reading list");
 *     added again for the panel. Gamma (loose, activated by the core) is added the same way.
 *  B. THE LINK MENU on Alpha's page: a real hold on the page's link raises the sheet; its
 *     transfer group reads Copy Link Address · Copy Link Text · Save Link As… · Add Link to
 *     Reading List · Share Link… (the design gate on #551: the reading list's row before the
 *     share, the hand-off out of the app the group's last row); a touch on "Add Link to Reading
 *     List" saves the LINK – an entry at the link's address titled by the link's text, no
 *     favicon (no page of it was ever open), unread.
 *  C. THE PANEL from the app menu's "Reading List" row, on Delta (a page not in the list): the
 *     "Reading list" header, the search field, the "Mark all as read" row while anything is
 *     unread, the three entries under Unread (the heading's aside their count, 3), no Read.
 *     A touch on the link's row opens its page in the current tab (Delta navigates: nothing
 *     showed the page) and marks it read; the panel leaves on the touch. Reopened, the panel
 *     lists it under Read, Home and Gamma under Unread (aside 2).
 *  D. THE ROW'S MENU (the ⋮): Gamma's carries Open in New Tab · Mark as Read · Copy Link ·
 *     Remove; Remove takes Gamma out. "Mark all as read" then marks Home read and leaves with
 *     the last unread entry (no Unread heading, no aside). Home's ⋮ carries "Mark as Unread",
 *     which brings Home back under Unread. A touch on Home's row brings Home's own tab forward
 *     (the model opens an existing tab showing the page rather than navigating; Delta keeps the
 *     link's page) and marks it read.
 *  E. THE STAR SHEET on Beta (unbookmarked, unlisted): the menu's star bookmarks the page, the
 *     toast's Edit opens the editor, whose "Reading list" switch stands off under Address; a
 *     touch on the switch saves Beta (checked, "Added to reading list"), a second takes it away.
 *  F. THE EMPTY STATE: the last two rows removed through their menus, the panel reads "Pages you
 *     save to read later appear here".
 *
 * Stills `reading-list-NN-<state>.png` on the light scheme (the design record is the preview
 * host's pair per surface, gate #551); findings in `reading-list-findings.txt` (one `OK` or `FAIL`
 * per claim; a claim that does not hold fails the run at the end). The class-change seam (a
 * narrowed tablet's `zen://reading-list` tab handed to this panel, #499's `reconcileLayout`) is
 * pinned in `pages.test.ts` and exercised by `PageClassSeamDemo`'s mechanism, not here: a second
 * recipe under a one-run budget. The seeded profile is the tab-group drivers'
 * (`tab-groups-demo-state.json`: Research [Alpha, Beta]; Home, Gamma, Delta loose), the pages the
 * driver's own loopback server's – Alpha's carries the link. Driven by
 * `android-reading-list-demo.yml` and by the nightly sweep's phone-f shard
 * (`.github/nightly-drivers/reading-list.json`). See [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class ReadingListDemo : GroupsDemoBase("reading-list", handshakeDir = "reading-list-demo") {
    override val tag = "ReadingListDemo"
    override val findingsFile = "reading-list-findings.txt"
    override val title = "Zenium Android reading list on the phone (HB-20): the app menu's verb, the link menu's row, the star sheet's switch, the panel"

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        head()
        awaitLoaded(HOME, HOME_URL)
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control.
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        check("start: the list is empty", entries().isEmpty(), "entries ${urls()}")
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        appMenuVerb()
        linkMenuRow()
        panelOpens()
        rowMenus()
        starSheetSwitch()
        emptyState()
        still("end")
        tail()
    }

    // --- A. the app menu's verb --------------------------------------------------------------------

    private fun appMenuVerb() {
        section("A. the app menu's verb on Home (unlisted): Add to Reading List, then Remove from Reading List")
        ensureForeground()
        still("home")
        addFromMenu("A", HOME_URL, "Tab groups demo")
        still("added-toast")
        awaitToastGone()

        val removed = menuTouch("A", REMOVE_ROW, "the entry is gone") { !hasEntry(HOME_URL) }
        check("A: the menu reopened carries Remove from Reading List for the listed page, and its touch takes the entry away", removed, "entries ${urls()}")
        val toast = awaitToast("Removed from reading list", 4_000)
        check("A: the toast reads 'Removed from reading list'", toast != null, "toast ${toast ?: "none"}")
        awaitToastGone()

        addFromMenu("A", HOME_URL, "Tab groups demo")
        awaitToastGone()
        activate(GAMMA, GAMMA_URL)
        addFromMenu("A", GAMMA_URL, "Gamma")
        awaitToastGone()
        finding("  the list after A: ${urls()}")
    }

    /** The app menu's Add to Reading List under a finger: one entry at `url`, unread, titled `title`, the toast. */
    private fun addFromMenu(act: String, url: String, title: String) {
        val before = entries().size
        val added = menuTouch(act, ADD_ROW, "the list holds ${url.removePrefix(ORIGIN)}") { hasEntry(url) }
        val saved = entry(url)
        check("$act: a touch on Add to Reading List saves the page – one entry at its address, unread", added && saved != null && entries().size == before + 1 && !isRead(saved), "entries ${urls()}")
        check("$act: the entry is titled by the page ('$title')", saved?.optString("title") == title, "title '${saved?.optString("title")}'")
        val toast = awaitToast("Added to reading list", 4_000)
        check("$act: the toast reads 'Added to reading list'", toast != null, "toast ${toast ?: "none"}")
    }

    /**
     * The app menu opened, pulled up and the row `label` under a real finger ([openMenuItem]), the
     * claim `took` watched for; a touch that went in and did nothing is a touch fault. False when
     * the row was not there (the menu is closed again) or the touch never took.
     */
    private fun menuTouch(act: String, label: String, effect: String, took: () -> Boolean): Boolean {
        if (!openMenuItem(label)) {
            check("$act: the app menu carries '$label'", false, "no such row in the menu")
            back()
            SystemClock.sleep(800)
            return false
        }
        if (awaitUntil(TOUCH_TOOK_WAIT * 3, took)) return true
        touchFault("a touch on '$label' did not take: not $effect")
        return false
    }

    // --- B. the link menu's row -----------------------------------------------------------------------

    private fun linkMenuRow() {
        section("B. the link menu on Alpha's page: Add Link to Reading List before Share Link…, saving the link")
        activate(ALPHA, ALPHA_URL)
        val link = linkOnScreen(ALPHA) ?: run {
            check("B: the page's link is on the screen", false, "no link in $ALPHA (${describeSpace()})")
            return
        }
        finding("  hold at ${link.x.roundToInt()},${link.y.roundToInt()} on the link")
        val f = Finger()
        f.press(link.x, link.y)
        f.up()
        val up = awaitJs(MENU_OPEN, true, SHEET_WAIT) && awaitDom(SHEET_ITEM, SHEET_WAIT)
        check("B: the link's menu comes up as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return
        SystemClock.sleep(600)
        val items = textsOf(SHEET_ITEM)
        finding("  rows as found (${items.size}): $items")
        val save = items.indexOf("Save Link As…")
        val reading = items.indexOf(LINK_ROW)
        val share = items.indexOf("Share Link…")
        check("B: the transfer group reads Copy Link Address · Copy Link Text · Save Link As… · Add Link to Reading List · Share Link… (the reading list's row before the share, the design gate on #551)", items.indexOf("Copy Link Address") < items.indexOf("Copy Link Text") && items.indexOf("Copy Link Text") < save && reading == save + 1 && share == reading + 1, "rows $items")
        still("link-menu")
        val before = entries().size
        val took = touchUntil(LINK_ROW, { textRect(SHEET_ITEM, LINK_ROW) }, { hasEntry(LINKED_URL) }, waitMs = 3_000)
        if (!took) touchFault("a touch on '$LINK_ROW' did not take: the list does not hold the link")
        val saved = entry(LINKED_URL)
        check("B: a touch on Add Link to Reading List saves the link – one entry at the link's address, unread", took && saved != null && entries().size == before + 1 && !isRead(saved), "entries ${urls()}")
        check("B: the entry is titled by the link's text, with no favicon (no page of it was open)", saved != null && saved.optString("title") == LINK_TEXT && (saved.isNull("favicon") || saved.optString("favicon").isEmpty()), "entry $saved")
        val toast = awaitToast("Added to reading list", 4_000)
        check("B: the toast reads 'Added to reading list' – the same word as the tab's add", toast != null, "toast ${toast ?: "none"}")
        check("B: the sheet is gone after the touch", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        awaitToastGone()
    }

    // --- C. the panel ---------------------------------------------------------------------------------

    private fun panelOpens() {
        section("C. the panel from the app menu's Reading List row, on Delta (not in the list)")
        activate(DELTA, DELTA_URL)
        if (!openPanel("C")) return
        SystemClock.sleep(1_200)
        check("C: the header reads 'Reading list' and the search field 'Search reading list'", waitFor("Reading list", 4_000) != null && inDom(SEARCH), "header ${findByLabel("Reading list")}, field ${inDom(SEARCH)}")
        check("C: 'Mark all as read' heads the list while anything is unread", listTitles().firstOrNull() == MARK_ALL, "titles ${listTitles()}")
        val unread = titlesUnder("Unread")
        check("C: the three entries stand under Unread, newest first – the link's, Gamma, Home", unread == listOf(LINK_TEXT, "Gamma", "Tab groups demo"), "unread $unread")
        check("C: the Unread heading's aside is the count, 3", unreadAside() == "3", "aside '${unreadAside()}'")
        check("C: no Read heading yet", !inDom(READ_SECTION))
        check("C: a row names its page, its host and when it was added, and its state", rowLabel("Gamma")?.let { it.startsWith("Gamma, 127.0.0.1") && it.endsWith(", Unread") } == true, "label '${rowLabel("Gamma")}'")
        still("panel-unread")

        // The link's row under a finger: nothing shows the page, so the current tab (Delta) goes there.
        val opened = touchTapLabelExpecting("$LINK_TEXT, ", "the link's page is up in the current tab", timeoutMs = 10_000, prefix = true) {
            tabUrl(DELTA) == LINKED_URL
        }
        check("C: a touch on the row opens the page in the current tab (Delta navigated: nothing showed it)", opened && awaitCore { activeTabId(it) == DELTA && tabUrl(DELTA, it) == LINKED_URL }, "active ${activeTabId()} at ${activeTabId()?.let { tabUrl(it) }}")
        check("C: the entry is marked read by the open", awaitCore { entry(LINKED_URL, it)?.let(::isRead) == true }, "entry ${entry(LINKED_URL)}")
        check("C: the panel leaves on the touch", awaitDomGone(PANEL_ROOT, 6_000), "panel ${inDom(PANEL_ROOT)}")
        awaitLoaded(DELTA, LINKED_URL)
        SystemClock.sleep(1_000)
        still("opened-from-row")

        if (!openPanel("C")) return
        SystemClock.sleep(1_200)
        val read = titlesUnder("Read")
        val stillUnread = titlesUnder("Unread")
        check("C: reopened, the opened entry stands under Read, Home and Gamma under Unread (aside 2)", read == listOf(LINK_TEXT) && stillUnread == listOf("Gamma", "Tab groups demo") && unreadAside() == "2", "read $read, unread $stillUnread, aside '${unreadAside()}'")
        check("C: the read row says so", rowLabel(LINK_TEXT)?.endsWith(", Read") == true, "label '${rowLabel(LINK_TEXT)}'")
        still("panel-read")
    }

    // --- D. the row's menu, Mark all as read, the open of a page a tab shows ------------------------------

    private fun rowMenus() {
        section("D. the row's ⋮ menu: Remove, Mark all as read, Mark as Unread; a row whose page a tab shows")
        if (!inDom(PANEL_ROOT) && !openPanel("D")) return
        if (!openRowMenu("D", "Gamma")) return
        val items = textsOf(SHEET_ITEM)
        finding("  Gamma's menu: $items")
        check("D: an unread row's menu reads Open in New Tab · Mark as Read · Copy Link · Remove", items == listOf("Open in New Tab", "Mark as Read", "Copy Link", "Remove"), "items $items")
        still("row-menu")
        val removed = touchTapLabelExpecting("Remove", "Gamma is out of the list", timeoutMs = 6_000) { !hasEntry(GAMMA_URL) }
        check("D: a touch on Remove takes the entry away and its row with it", removed && awaitUntil(4_000) { rowLabel("Gamma") == null }, "entries ${urls()}, row '${rowLabel("Gamma")}'")
        check("D: the menu is gone after the touch", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        SystemClock.sleep(800)

        val all = touchTapLabelExpecting(MARK_ALL, "every entry is read", timeoutMs = 6_000) { entries().all(::isRead) }
        check("D: a touch on Mark all as read marks the last unread entry (Home) read", all, "entries ${entries()}")
        check("D: the row leaves with the last unread entry, and the Unread heading with its aside", awaitUntil(4_000) { MARK_ALL !in listTitles() && !inDom(UNREAD_SECTION) }, "titles ${listTitles()}, unread heading ${inDom(UNREAD_SECTION)}")
        val read = titlesUnder("Read")
        check("D: both entries stand under Read", read.toSet() == setOf(LINK_TEXT, "Tab groups demo"), "read $read")
        still("all-read")

        if (!openRowMenu("D", "Tab groups demo")) return
        val readItems = textsOf(SHEET_ITEM)
        check("D: a read row's menu flips the middle row to Mark as Unread", readItems == listOf("Open in New Tab", "Mark as Unread", "Copy Link", "Remove"), "items $readItems")
        val unread = touchTapLabelExpecting("Mark as Unread", "Home is unread again", timeoutMs = 6_000) { entry(HOME_URL)?.let { !isRead(it) } == true }
        check("D: a touch on Mark as Unread brings Home back under Unread, the heading's aside 1, Mark all as read back", unread && awaitUntil(4_000) { titlesUnder("Unread") == listOf("Tab groups demo") && unreadAside() == "1" && listTitles().firstOrNull() == MARK_ALL }, "unread ${titlesUnder("Unread")}, aside '${unreadAside()}', titles ${listTitles()}")
        awaitDomGone(SHEET, SHEET_WAIT)
        SystemClock.sleep(800)
        still("panel-unread-again")

        // Home's row: Home's own tab shows the page, so the model brings it forward instead of
        // navigating the current tab (Delta keeps the link's page).
        val forward = touchTapLabelExpecting("Tab groups demo, ", "Home's tab is the active one", timeoutMs = 10_000, prefix = true) { activeTabId() == HOME }
        check("D: a touch on a row whose page a tab shows brings that tab forward rather than navigating", forward && tabUrl(HOME) == HOME_URL && tabUrl(DELTA) == LINKED_URL, "active ${activeTabId()}, Home ${tabUrl(HOME)}, Delta ${tabUrl(DELTA)}")
        check("D: the entry is marked read by the open", awaitCore { entry(HOME_URL, it)?.let(::isRead) == true }, "entry ${entry(HOME_URL)}")
        check("D: the panel leaves on the touch", awaitDomGone(PANEL_ROOT, 6_000), "panel ${inDom(PANEL_ROOT)}")
        SystemClock.sleep(1_000)
    }

    // --- E. the star sheet's switch ---------------------------------------------------------------------

    private fun starSheetSwitch() {
        section("E. the star sheet's Reading list switch on Beta (unbookmarked, unlisted)")
        activate(BETA, BETA_URL)
        val bookmarksBefore = bookmarkCount()
        val starred = menuTouch("E", STAR, "the page is bookmarked") { bookmarkCount() == bookmarksBefore + 1 }
        check("E: a touch on the menu's star bookmarks the page (the toast 'Saved to Bookmarks' with its Edit)", starred && awaitToast("Saved to Bookmarks", 4_000) != null, "bookmarks ${bookmarkCount()}")
        val editor = touchUntil("the toast's Edit", { domRect(TOAST_BUTTON) }, { editorUp() }, waitMs = 3_000)
        if (!editor) touchFault("a touch on the toast's Edit did not take: no editor came up")
        check("E: a touch on the toast's Edit opens the bookmark editor", editor && waitFor("Edit bookmark", 6_000) != null, "editor ${editorUp()}")
        if (!editor) return
        SystemClock.sleep(1_200)
        check("E: the editor carries the Reading list switch, off, live (the page is open, so it can be added)", inDom(SWITCH) && attrOf(SWITCH, "aria-checked") == "false" && attrOf(SWITCH, "aria-disabled") != "true", "switch checked '${attrOf(SWITCH, "aria-checked")}' disabled '${attrOf(SWITCH, "aria-disabled")}'")
        still("star-sheet")
        val on = touchUntil("the Reading list switch", { domRect(SWITCH) }, { hasEntry(BETA_URL) }, waitMs = 3_000)
        if (!on) touchFault("a touch on the Reading list switch did not take: the list does not hold Beta")
        val saved = entry(BETA_URL)
        check("E: a touch on the switch saves the page by the tab showing it – one entry at Beta's address, unread, the switch on", on && saved != null && !isRead(saved) && awaitJs("document.querySelector('$SWITCH').getAttribute('aria-checked')==='true'", true, 3_000), "entries ${urls()}, checked '${attrOf(SWITCH, "aria-checked")}'")
        check("E: the toast reads 'Added to reading list'", awaitToast("Added to reading list", 4_000) != null)
        still("star-sheet-on")
        val off = touchUntil("the Reading list switch, on", { domRect(SWITCH) }, { !hasEntry(BETA_URL) }, waitMs = 3_000)
        if (!off) touchFault("a second touch on the Reading list switch did not take: the list still holds Beta")
        check("E: a second touch takes the entry away by its id, the switch off", off && awaitJs("document.querySelector('$SWITCH').getAttribute('aria-checked')==='false'", true, 3_000), "entries ${urls()}, checked '${attrOf(SWITCH, "aria-checked")}'")
        back()
        check("E: back closes the editor", awaitUntil(6_000) { !editorUp() }, "editor ${editorUp()}")
        SystemClock.sleep(1_000)
    }

    // --- F. the empty state -----------------------------------------------------------------------------

    private fun emptyState() {
        section("F. the empty state: the last rows removed through their menus")
        if (!openPanel("F")) return
        SystemClock.sleep(1_000)
        for (title in listOf(LINK_TEXT, "Tab groups demo")) {
            if (!openRowMenu("F", title)) continue
            val count = entries().size
            val removed = touchTapLabelExpecting("Remove", "'$title' is out of the list", timeoutMs = 6_000) { entries().size == count - 1 }
            check("F: Remove on '$title' takes its entry away", removed && awaitUntil(4_000) { rowLabel(title) == null }, "entries ${urls()}")
            awaitDomGone(SHEET, SHEET_WAIT)
            SystemClock.sleep(800)
        }
        check("F: the list is empty", entries().isEmpty(), "entries ${urls()}")
        check("F: the panel reads 'Pages you save to read later appear here', no headings, no Mark all as read", awaitUntil(4_000) { textOf("$PANEL_ROOT .zen-phone-empty") == EMPTY_NOTE } && !inDom(UNREAD_SECTION) && !inDom(READ_SECTION) && listTitles().isEmpty(), "note '${textOf("$PANEL_ROOT .zen-phone-empty")}', titles ${listTitles()}")
        still("panel-empty")
        back()
        awaitDomGone(PANEL_ROOT, 6_000)
        SystemClock.sleep(800)
    }

    // --- the panel and its rows -------------------------------------------------------------------------

    /** The app menu's Reading List row under a finger, the panel awaited by its root. */
    private fun openPanel(act: String): Boolean {
        val up = menuTouch(act, PANEL_ROW, "the Reading list panel is up") { inDom(PANEL_ROOT) }
        check("$act: a touch on the menu's Reading List row opens the panel", up, "panel ${inDom(PANEL_ROOT)}")
        return up
    }

    /** A row's ⋮ under a finger, the row menu awaited (its handle). */
    private fun openRowMenu(act: String, title: String): Boolean {
        val label = "More options for $title"
        val up = touchTapLabelExpecting(label, "the row's menu is up", timeoutMs = 6_000) { findByLabel(MENU_HANDLE_LABEL) != null && inDom(SHEET_ITEM) }
        check("$act: a touch on '$label' opens the row's menu", up, "handle ${findByLabel(MENU_HANDLE_LABEL)}")
        if (up) SystemClock.sleep(900)
        return up
    }

    /** Every row title the panel's list shows, in order (the Mark all as read row's among them). */
    private fun listTitles(): List<String> = textsOf("$PANEL_ROOT .zen-list-title")

    /** The titles under the panel's `heading` section (Unread / Read), in the list's order. */
    private fun titlesUnder(heading: String): List<String> =
        textsOf("$PANEL_ROOT section[aria-label=\"$heading\"] .zen-list-title")

    private fun unreadAside(): String = textOf("$UNREAD_SECTION .zen-list-heading-aside")

    /** The accessible name of the row titled `title`, off the DOM (`aria-label`); null when none. */
    private fun rowLabel(title: String): String? =
        jsString(
            "(function(){var t=${JSONObject.quote(title)};var e=Array.prototype.find.call(document.querySelectorAll('$PANEL_ROOT .zen-list-main[aria-label]')," +
                "function(n){return n.getAttribute('aria-label').indexOf(t+', ')===0});return e?e.getAttribute('aria-label'):''})()"
        ).takeIf { it.isNotEmpty() }

    // --- the core's list ----------------------------------------------------------------------------------

    private fun entries(state: JSONObject = coreState()): List<JSONObject> {
        val list = state.optJSONArray("readingList") ?: return emptyList()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun urls(state: JSONObject = coreState()): List<String> = entries(state).map { it.optString("url").removePrefix(ORIGIN) + if (isRead(it)) " (read)" else "" }

    private fun entry(url: String, state: JSONObject = coreState()): JSONObject? = entries(state).firstOrNull { it.optString("url") == url }

    private fun hasEntry(url: String): Boolean = entry(url) != null

    private fun isRead(entry: JSONObject): Boolean = !entry.isNull("readAt") && entry.optLong("readAt") > 0

    private fun bookmarkCount(): Int = coreState().optJSONArray("bookmarks")?.length() ?: 0

    private fun editorUp(): Boolean = jsBoolean("window.__zenStores.ui.get().bookmarkEdit")

    /** The core activates [tabId] (a touch on its card is the overview drivers' business), its page loaded. */
    private fun activate(tabId: String, url: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val active = awaitCore { activeTabId(it) == tabId }
        awaitLoaded(tabId, url)
        SystemClock.sleep(1_500)
        finding("  $tabId activated: $active; ${describeSpace()}")
    }

    companion object {
        private const val HOME_URL = "$ORIGIN/"
        private const val GAMMA_URL = "$ORIGIN/gamma.html"
        private const val DELTA_URL = "$ORIGIN/delta.html"
        private const val LINK_TEXT = "A page to open in the group"

        private const val ADD_ROW = "Add to Reading List"
        private const val REMOVE_ROW = "Remove from Reading List"
        private const val PANEL_ROW = "Reading List"
        private const val LINK_ROW = "Add Link to Reading List"
        private const val MARK_ALL = "Mark all as read"
        private const val STAR = "Bookmark"
        private const val EMPTY_NOTE = "Pages you save to read later appear here"

        private const val SHEET = ".zen-sheet"
        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val PANEL_ROOT = "[data-testid=\"reading-list-panel\"]"
        private const val SEARCH = ".zen-phone-panel input[placeholder=\"Search reading list\"]"
        private const val UNREAD_SECTION = "$PANEL_ROOT section[aria-label=\"Unread\"]"
        private const val READ_SECTION = "$PANEL_ROOT section[aria-label=\"Read\"]"
        private const val SWITCH = "[data-testid=\"bookmark-reading-list\"]"
        private const val TOAST_BUTTON = ".zen-message-toast .zen-message-button"
    }
}
