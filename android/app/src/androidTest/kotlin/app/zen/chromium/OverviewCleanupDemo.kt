package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The tab overview after the cleanup (`docs/tab-overview-cleanup-spec.md` §1–§6, the device
 * record the design gate reads), on the overview demo's profile (`overview-demo-state.json`:
 * Work with the Research group open – World Wide Web, Damping – Example Domain active, four
 * loose tabs and three Essentials; Personal with two). Stills in both colour schemes where the
 * gate asked for them; findings to `overview-cleanup-findings.txt` next to the stills (one
 * `PASS` or `FAIL` per check; the test fails only when the driver could not run or a touch it
 * injected did not take):
 *
 *  1. the header at rest (§1): one row, 56 tall, the title alone in it – "Work · 10 tabs", a
 *     popup button named "Work, 10 tabs" – nothing trailing it; no segment row, no Spaces
 *     button, no search toggle, no ⋯ of the overview's own (light, dark); the overview leaves
 *     on a card's tap;
 *  2. the title is the space switcher (§1): a touch on it presents the Spaces sheet – the
 *     spaces as rows with their counts, the current one marked, "New Space…" last – the title
 *     reading expanded; back puts the sheet away unanswered (the motion spec's §9 item 6); a
 *     row's touch switches the space, the title and the grid following; a drag across the
 *     grid's background moves between the spaces (GN-19), the slot live under the finger,
 *     the title following on the release;
 *  3. a group is one card in its place (§2): the open Research card folds on its header's touch
 *     to the card with the 2×2 mosaic and its count, unfolds in place on the next; the open
 *     header's ⋯ presents the group's sheet – Rename, New Tab in Group, Ungroup, Close Group
 *     (2 Tabs), Delete Group, the colour palette in its header (light, dark);
 *  4. the one ⋯ is the bar's (§4): while the overview stands it opens the overview's menu –
 *     New Tab, New Private Tab, Select Tabs, Search Tabs, a hairline, Close All Tabs (7) in
 *     danger ink, Switch Space – no Private Tabs row while none is open, no Inactive Tabs row
 *     while none is archived (light, dark); back puts it away, the overview standing. New
 *     Private Tab is on the menu exactly where `capabilities.privateTabs` is on (a WebView with
 *     profiles: the Chromium snapshot swapped in on the webview shard and in the private
 *     security demo's environment; the google_apis image's own keeps none);
 *  5. Search Tabs is a row of that menu (§4, §9): the field pinned under the header, focused,
 *     the keyboard up; "tea" leaves Tea's card alone in the grid; the X clears, then closes,
 *     the header row back;
 *  6. the private view (§3): New Private Tab from the menu opens a private tab and the overview
 *     leaves onto it; the overview opened from it is the private view – the mask and "Private ·
 *     1 tab", a heading and no control, the private card – its menu "Tabs (10)", Close Private
 *     Tabs (1), no Switch Space (light, dark); back leaves the overview; "Tabs (10)" switches
 *     to the regular view and "Private Tabs (1)" back, the system back from the PICKED private
 *     view returning to the regular one; Close Private Tabs asks – back is Cancel – and
 *     confirmed closes the session, the regular view back. Skipped, as a line in the findings
 *     and no failure, on a WebView without profiles (`capabilities.privateTabs` false), where
 *     the host hides private browsing;
 *  7. selection mode (§5): Select Tabs from the menu – Done, "Select tabs", Select all in the
 *     header; a card's touch picks it ("1 selected", the card a checked checkbox); the foot's
 *     action row Close, Group, Bookmark, Share; the menu while selecting Select All, Deselect
 *     All, Close Selected (1) (light, dark); Select all picks every card; Done ends the mode.
 *
 * Positions come from the chrome's DOM (`domBox`, calibrated at the warm-up): the WebView's
 * accessibility tree trails the software-rendered emulator by seconds. See [DemoHarness] for
 * the plumbing.
 *
 * The recorder and the stills see the private view only because
 * `PrivateBrowsing.captureForRecording` is on for the run (the debug-build override the private
 * drivers use): the window's screenshot guard (`FLAG_SECURE`) stands while the surface is
 * private and would black the private view's captures out, as it did the retry's at
 * `372e5246e` (its four private stills blank, every §3 check PASS by the DOM).
 */
@RunWith(AndroidJUnit4::class)
class OverviewCleanupDemo : DemoHarness("overview-demo-state.json", "overview-cleanup", "overview-cleanup-demo") {
    override val tag = "OverviewCleanupDemo"
    private lateinit var findings: File
    private var shots = 0
    private var failures = 0

    /** The private view must show in the stills and the recording; see the class comment. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
    }

    @Test
    fun record() {
        runDemo()
    }

    override fun warmUp() {
        findings = File(out, "overview-cleanup-findings.txt")
        findings.writeText("Zenium Android tab overview cleanup demo (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        calibrateDomBoxes()
        // The overview once off camera: its first layout, the grid's cards, the group card.
        val overview = runCatching {
            openOverview()
            SystemClock.sleep(800)
            leaveOverview()
        }
        // The menu once off camera: its first layout and compilation.
        val menu = runCatching {
            tapMenuButton()
            awaitUntil(6_000) { overviewMenuRows().isNotEmpty() || findByLabel(MENU_HANDLE_LABEL) != null }
            SystemClock.sleep(600)
            back()
            awaitUntil(4_000) { findByLabel(MENU_HANDLE_LABEL) == null }
        }
        SystemClock.sleep(1_200)
        finding(
            "warm-up: the overview ${if (overview.isSuccess) "opened and left" else "did NOT open (${overview.exceptionOrNull()?.message})"}; " +
                "the menu ${if (menu.isSuccess) "opened and left" else "did NOT open"}; ${describeState()}; " +
                "the host: capabilities.privateTabs ${privateTabsCapability()} (${webViewPackage()})"
        )
    }

    override fun demo() {
        header()
        spaces()
        groupCard()
        menu()
        search()
        privateView()
        selection()
        finding("\nend: $failures check(s) failed; ${describeState()}")
    }

    // --- 1. the header at rest ---------------------------------------------------------------

    private fun header() {
        step("1. The header at rest (§1): one row, the title alone, nothing of the old controls") {
            openOverview()
            val title = overviewTitleLabel().orEmpty()
            val height = headerHeight()
            val controls = headerControls()
            val stale = staleControls()
            still("header-light")
            expect("the title reads '$title' (the space's name with the count, a comma between for the reader)", title == WORK_TITLE)
            expect("the title is a popup button (aria-haspopup=dialog) on the regular view (data-view=tabs)", attr(TITLE, "aria-haspopup") == "dialog" && overviewView() == "tabs")
            expect("the header row stands 56 tall: $height", height == 56)
            expect("the title is the header's one control: $controls", controls == listOf(title))
            expect("nothing of the old header remains – no Spaces button, no search toggle, no ⋯ of the overview's, no segment row: $stale", stale.isEmpty())
            expect("the overview is one landmark named '${OVERVIEW_LABEL}' for the reader", attr(".zen-overview", "role") == "region" && attr(".zen-overview", "aria-label") == OVERVIEW_LABEL)
            finding("  the title's words: '${textOf(TITLE)}'; the count span '${textOf(COUNT)}'; cells ${cellKeys()}")
            setColorScheme("dark")
            still("header-dark")
            setColorScheme("light")
            // The close: the current card's tap, the card growing back into its page (§6).
            val closed = touchDomExpecting("Example Domain's card", q(cell(DEMO_TAB)), "the overview leaves onto the page") { !inDom(".zen-overview") }
            expect("a card's touch leaves the overview onto its page (the active tab stays Example Domain)", closed && activeCoreTab()?.optString("id") == DEMO_TAB)
            SystemClock.sleep(1_000)
        }
    }

    // --- 2. the title is the space switcher; the swipe between spaces -----------------------------

    private fun spaces() {
        step("2. The title is the space switcher (§1): the Spaces sheet, a pick, the swipe (GN-19)") {
            openOverview()
            val up = touchDomExpecting("the title", q(TITLE), "the Spaces sheet is presented") { sheetRows().isNotEmpty() }
            SystemClock.sleep(1_200)
            val rows = sheetRows()
            val current = currentSpaceRows()
            still("spaces-sheet-light")
            expect("the Spaces sheet lists the spaces with their counts and New Space… last: $rows", up && rows == SPACES_ROWS)
            expect("the current space is marked (aria-current): $current", current == listOf(SPACES_ROWS[0]))
            expect("the title reads expanded while the sheet stands", attr(TITLE, "aria-expanded") == "true")
            back()
            val away = awaitUntil(6_000) { sheetRows().isEmpty() }
            SystemClock.sleep(600)
            expect("back puts the sheet away unanswered, the overview standing, the title collapsed again", away && inDom(".zen-overview") && attr(TITLE, "aria-expanded") == "false" && activeSpaceId() == WORK_SPACE_ID)

            // A pick: Personal's row.
            val again = touchDomExpecting("the title", q(TITLE), "the Spaces sheet is presented again") { sheetRows().isNotEmpty() }
            SystemClock.sleep(1_200)
            val picked = again && touchDomExpecting("Personal's row", spaceRow("Personal"), "the overview stands on Personal") {
                overviewTitleLabel() == PERSONAL_TITLE && activeSpaceId() == PERSONAL_SPACE_ID
            }
            SystemClock.sleep(1_500)
            expect("a row's touch switches the space: the title '${overviewTitleLabel()}', the grid Personal's cards ${cellKeys()}", picked && cellKeys().contains("tab_htcpcp") && !cellKeys().contains(DEMO_TAB))
            still("space-personal")

            // The swipe back to Work: a drag across the grid's background, the slot live under
            // the finger, the title following on the release.
            val slot = domBox("document.querySelector('$SPACE_SLOT')") ?: error("no space slot in the overview")
            val y = slot.top + slot.height() * 0.78f
            val startX = width * 0.18f
            val travel = width * 0.5f
            val f = Finger()
            f.down(startX, y)
            f.moveBy(travel, 0f, 900)
            f.hold(200)
            val live = slotLive()
            val transform = slotTransform()
            val midTitle = overviewTitleLabel()
            still("space-swipe-mid")
            f.up()
            val landed = awaitUntil(5_000) { overviewTitleLabel() == WORK_TITLE && activeSpaceId() == WORK_SPACE_ID }
            SystemClock.sleep(1_500)
            expect("under the finger the slot is live (data-swipe) and carried right: '$transform'; the title still '$midTitle'", live && transform.startsWith("translate3d(") && !transform.startsWith("translate3d(-") && midTitle == PERSONAL_TITLE)
            expect("the release past a third picks Work: the title '${overviewTitleLabel()}', the space ${activeSpaceId()}", landed)
            expect("the slot is at rest after the pick (no data-swipe, no transform)", awaitUntil(4_000) { !slotLive() && slotTransform().isEmpty() })
            still("space-swipe-settled")
            leaveOverview()
        }
    }

    // --- 3. a group is one card in its place ------------------------------------------------------

    private fun groupCard() {
        step("3. A group is one card in its place (§2): the fold, the unfold, the header's ⋯") {
            openOverview()
            val open = attr(GROUP_HEADER, "aria-expanded") == "true"
            val label = attr(GROUP_HEADER, "aria-label")
            expect("the Research card stands open in the grid, its header '$label'", open && label.startsWith("Research, ") && inDom("$GROUP .zen-group-members [data-cell=\"tab_www\"]"))
            // The fold: the header's touch.
            val folded = touchDomExpecting("the group's header", q(GROUP_HEADER), "the card folds") {
                attr(GROUP_HEADER, "aria-expanded") == "false" && inDom("$GROUP[data-collapsed]") && inDom(MOSAIC)
            }
            awaitUntil(6_000) { !inDom("$GROUP[data-clip]") }
            SystemClock.sleep(1_000)
            still("group-card-light")
            expect("folded: the card with the 2×2 mosaic, its count '${textOf(CARD_COUNT)}', its name '${cardName()}', the members off the grid (hidden from the eye and the reader, kept for the FLIP): ${membersHidden()}", folded && textOf(CARD_COUNT) == "2" && cardName() == "Research" && membersHidden() && !inDom(OPTIONS))
            setColorScheme("dark")
            still("group-card-dark")
            setColorScheme("light")
            // The unfold in place: the next touch.
            val unfolded = touchDomExpecting("the folded card's header", q(GROUP_HEADER), "the card unfolds in place") {
                attr(GROUP_HEADER, "aria-expanded") == "true" && !membersHidden() && inDom("$GROUP .zen-group-members [data-cell=\"tab_www\"]")
            }
            awaitUntil(6_000) { !inDom("$GROUP[data-clip]") }
            SystemClock.sleep(1_000)
            still("group-unfolded")
            expect("unfolded: the members' cards under the header row (shown again), the header's ⋯ back", unfolded && !inDom("$GROUP[data-collapsed]") && !membersHidden() && inDom(OPTIONS) && cellKeys().indexOf("group:$GROUP_ID") >= 0)
            // The header's ⋯: the group's sheet.
            val sheet = touchDomExpecting("the group's ⋯", q(OPTIONS), "the group's sheet is presented") { sheetRows().isNotEmpty() }
            SystemClock.sleep(1_200)
            val rows = sheetRows()
            val palette = jsString("String(document.querySelectorAll('.zen-sheet [role=\"radiogroup\"][aria-label=\"Colour\"] [role=\"radio\"]').length)")
            still("group-sheet-light")
            expect("the group's sheet: $rows; the palette's $palette swatches", sheet && rows == GROUP_ROWS && palette == "9")
            setColorScheme("dark")
            still("group-sheet-dark")
            setColorScheme("light")
            back()
            expect("back puts the group's sheet away, the card standing open", awaitUntil(6_000) { sheetRows().isEmpty() } && attr(GROUP_HEADER, "aria-expanded") == "true")
            SystemClock.sleep(600)
            leaveOverview()
        }
    }

    // --- 4. the one ⋯ is the bar's --------------------------------------------------------------

    private fun menu() {
        step("4. The one ⋯ is the bar's (§4): the overview's menu, its rows in order") {
            openOverview()
            val opened = openMenu()
            val rows = overviewMenuRows()
            val danger = dangerRows()
            val want = menuRows(privateTabsCapability())
            still("menu-light")
            expect("the bar's ⋯ opens the overview's menu, its rows in §4's order (New Private Tab where capabilities.privateTabs is on: ${privateTabsCapability()}): $rows", opened && rows.size == want.size && rows.dropLast(1) == want.dropLast(1) && rows.last().startsWith(want.last()))
            expect("Close All Tabs is the one row in danger ink: $danger", danger == listOf("Close All Tabs (7)"))
            expect("no Private Tabs row while none is open, no Inactive Tabs row while none is archived, no Recently Closed row while the list is empty", rows.none { it.startsWith("Private Tabs (") || it.startsWith("Inactive Tabs (") || it.startsWith("Recently Closed (") })
            setColorScheme("dark")
            still("menu-dark")
            setColorScheme("light")
            back()
            val away = awaitUntil(6_000) { overviewMenuRows().isEmpty() }
            SystemClock.sleep(600)
            expect("back puts the menu away unanswered, the overview standing", away && inDom(".zen-overview") && overviewView() == "tabs")
            leaveOverview()
        }
    }

    // --- 5. Search Tabs is a row of the menu --------------------------------------------------------

    private fun search() {
        step("5. Search Tabs is a row of the menu (§4, §9): the field under the header, the X clears then closes") {
            openOverview()
            val opened = openOverviewMenuRow("Search Tabs")
            val up = opened && awaitUntil(8_000) { inDom(SEARCH_INPUT) }
            val focused = up && awaitUntil(6_000) { activeElementId() == "overview-search" }
            val ime = awaitIme(true, 6_000)
            SystemClock.sleep(800)
            still("search-field")
            expect("the field is pinned under the header, focused, the keyboard up: focused $focused, ime $ime; the X reads '${attr(SEARCH_CLEAR, "aria-label")}'", up && focused && ime && attr(SEARCH_CLEAR, "aria-label") == "Close search" && inDom(TITLE))
            keys("tea")
            val filtered = awaitUntil(6_000) { cellKeys().contains("tab_tea") && !cellKeys().contains("tab_coffee") }
            SystemClock.sleep(800)
            still("search-tea")
            expect("'tea' leaves Tea's card alone among the tabs: ${cellKeys()}; the X reads '${attr(SEARCH_CLEAR, "aria-label")}'", filtered && attr(SEARCH_CLEAR, "aria-label") == "Clear search")
            val cleared = touchDomExpecting("the field's X (Clear search)", q(SEARCH_CLEAR), "the query is cleared") { searchValue().isEmpty() }
            SystemClock.sleep(800)
            expect("the X clears the query, the field standing: the grid whole again ${cellKeys().size} cells, the X '${attr(SEARCH_CLEAR, "aria-label")}'", cleared && inDom(SEARCH_INPUT) && cellKeys().contains("tab_coffee") && attr(SEARCH_CLEAR, "aria-label") == "Close search")
            val closed = touchDomExpecting("the field's X (Close search)", q(SEARCH_CLEAR), "the field leaves") { !inDom(SEARCH_INPUT) }
            awaitIme(false, 6_000)
            SystemClock.sleep(800)
            expect("the second X closes the search: the header row the title alone again", closed && headerControls() == listOf(WORK_TITLE) && !inDom("[data-testid=\"overview-search\"]"))
            leaveOverview()
        }
    }

    // --- 6. the private view -------------------------------------------------------------------------

    private fun privateView() {
        step("6. The private view (§3): New Private Tab, the view, its menu, the way back, Close Private Tabs") {
            if (!privateTabsCapability()) {
                // The google_apis image's own WebView keeps no profiles: the host hides private
                // browsing (no New Private Tab row – step 4 pinned that), so §3 has nothing to show
                // here. The claims run where the Chromium snapshot WebView is swapped in (the
                // webview shard; the private security demo's environment).
                finding("  SKIPPED: capabilities.privateTabs is false on this WebView (${webViewPackage()}); the §3 claims need the snapshot WebView")
                return@step
            }
            openOverview()
            val tabsBefore = coreState().getJSONObject("tabs").length()
            val opened = openOverviewMenuRow("New Private Tab")
            val privateUp = opened && awaitUntil(10_000) { privateActive() && !inDom(".zen-overview") }
            SystemClock.sleep(2_000)
            expect("New Private Tab opens a private tab and the overview leaves onto it (tabs $tabsBefore -> ${coreState().getJSONObject("tabs").length()})", privateUp && privateCount() == 1)
            // The overview from the private tab: the private view.
            openOverview()
            val view = awaitUntil(6_000) { overviewView() == "private" }
            val title = overviewTitleLabel().orEmpty()
            SystemClock.sleep(800)
            still("private-view-light")
            expect("the overview opened from a private tab is the private view: '$title', a heading and no control", view && title == PRIVATE_TITLE && attr(TITLE, "role") == "heading")
            expect("the private card alone in the grid (the regular tabs never mix in): ${cellKeys()}", cellKeys().none { it == DEMO_TAB || it.startsWith("group:") } && privateCells().size == 1)
            setColorScheme("dark")
            still("private-view-dark")
            val menuUp = openMenu()
            val rows = overviewMenuRows()
            still("private-menu-dark")
            setColorScheme("light")
            expect("the private view's menu: Tabs (10) the way back, Close Private Tabs (1) in danger ink, no Switch Space: $rows", menuUp && rows == PRIVATE_MENU_ROWS && dangerRows() == listOf("Close Private Tabs (1)"))
            back()
            awaitUntil(6_000) { overviewMenuRows().isEmpty() }
            SystemClock.sleep(500)
            back()
            expect("back from the private view the overview opened on leaves the overview (its own state, as from the regular view)", awaitUntil(6_000) { !inDom(".zen-overview") })
            SystemClock.sleep(1_000)
            // The rows switch the views; the PICKED private view's back returns to the regular view.
            openOverview()
            awaitUntil(6_000) { overviewView() == "private" }
            val toTabs = openOverviewMenuRow("Tabs (") && awaitUntil(6_000) { overviewView() == "tabs" && overviewTitleLabel() == WORK_TITLE }
            SystemClock.sleep(1_000)
            expect("'Tabs (10)' switches to the regular view: '${overviewTitleLabel()}' – ${cellKeys().size} cells", toTabs && cellKeys().contains(DEMO_TAB))
            val toPrivate = openOverviewMenuRow("Private Tabs (") && awaitUntil(6_000) { overviewView() == "private" }
            SystemClock.sleep(1_000)
            expect("'Private Tabs (1)' switches to the private view: '${overviewTitleLabel()}'", toPrivate && overviewTitleLabel() == PRIVATE_TITLE)
            back()
            val backToTabs = awaitUntil(6_000) { overviewView() == "tabs" }
            SystemClock.sleep(800)
            expect("the system back from the PICKED private view returns to the regular view, the overview standing", backToTabs && inDom(".zen-overview") && overviewTitleLabel() == WORK_TITLE)
            // Close Private Tabs: the question, back as Cancel, then the confirm.
            val again = openOverviewMenuRow("Private Tabs (") && awaitUntil(6_000) { overviewView() == "private" }
            SystemClock.sleep(800)
            val asked = again && openOverviewMenuRow("Close Private Tabs (") && awaitUntil(8_000) { promptUp() }
            SystemClock.sleep(1_000)
            still("close-private-prompt")
            expect("Close Private Tabs asks first: '${promptTitle()}' (§9.23; no undo for the session)", asked && promptTitle() == "Close 1 private tab?")
            back()
            val cancelled = awaitUntil(6_000) { !promptUp() }
            SystemClock.sleep(800)
            expect("back is Cancel: the prompt away, the private tab still open, the view still private", cancelled && privateCount() == 1 && overviewView() == "private")
            val askedAgain = openOverviewMenuRow("Close Private Tabs (") && awaitUntil(8_000) { promptUp() }
            SystemClock.sleep(1_000)
            val confirmed = askedAgain && touchDomExpecting("the prompt's Close all", promptButton("Close all"), "the private session closes") { privateCount() == 0 }
            val regular = awaitUntil(8_000) { overviewView() == "tabs" }
            SystemClock.sleep(1_200)
            expect("confirmed, the private tabs close and the regular view comes back: '${overviewTitleLabel()}', ${coreState().getJSONObject("tabs").length()} tabs", confirmed && regular && overviewTitleLabel() == WORK_TITLE && coreState().getJSONObject("tabs").length() == tabsBefore)
            still("after-close-private")
            leaveOverview()
        }
    }

    // --- 7. selection mode -------------------------------------------------------------------------

    private fun selection() {
        step("7. Selection mode (§5): Select Tabs, a card's pick, the action row, the menu while selecting, Select all, Done") {
            openOverview()
            val entered = openOverviewMenuRow("Select Tabs") && awaitUntil(6_000) { inDom(SELECT_DONE) }
            SystemClock.sleep(1_200)
            expect("Select Tabs enters the mode: Done, '${textOf(SELECTED_COUNT)}', '${textOf(SELECT_ALL)}' in the header; the action row ${actionNames()}", entered && textOf(SELECTED_COUNT) == "Select tabs" && textOf(SELECT_ALL) == "Select all" && actionNames().size == 4)
            val picked = touchDomExpecting("Hacker News' card", q(cell("tab_hn")), "the card is picked") { attr(card("tab_hn"), "aria-checked") == "true" }
            SystemClock.sleep(800)
            still("selection-one-light")
            expect("a card's touch picks it: '${textOf(SELECTED_COUNT)}', the card a checked checkbox (role '${attr(card("tab_hn"), "role")}')", picked && textOf(SELECTED_COUNT) == "1 selected" && attr(card("tab_hn"), "role") == "checkbox")
            expect("the action row names its count: ${actionNames()}", actionNames().firstOrNull() == "Close 1 tab")
            val menuUp = openMenu()
            val rows = overviewMenuRows()
            still("selection-menu-light")
            expect("the menu while selecting: $rows", menuUp && rows == SELECTION_MENU_ROWS)
            setColorScheme("dark")
            still("selection-menu-dark")
            back()
            awaitUntil(6_000) { overviewMenuRows().isEmpty() }
            SystemClock.sleep(600)
            still("selection-one-dark")
            setColorScheme("light")
            val all = touchDomExpecting("Select all", q(SELECT_ALL), "every card is picked") { textOf(SELECTED_COUNT) == "7 selected" }
            SystemClock.sleep(800)
            expect("Select all picks every card the grid offers: '${textOf(SELECTED_COUNT)}', the button '${textOf(SELECT_ALL)}'", all && textOf(SELECT_ALL) == "Deselect all")
            val done = touchDomExpecting("Done", q(SELECT_DONE), "the mode ends") { !inDom(SELECT_DONE) && inDom(TITLE) }
            SystemClock.sleep(800)
            expect("Done ends the mode: the header the title again '${overviewTitleLabel()}', the tabs all open (${coreState().getJSONObject("tabs").length()})", done && overviewTitleLabel() == WORK_TITLE && coreState().getJSONObject("tabs").length() == 12)
            leaveOverview()
        }
    }

    // --- steps -----------------------------------------------------------------------------------

    /** Run one step of the sequence; a failure inside it is a finding, not the end of the recording. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            failures++
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
        }
        // Whatever a step left standing goes before the next (a sheet, the menu, the overview).
        runCatching {
            for (attempt in 1..4) {
                if (overviewMenuRows().isEmpty() && sheetRows().isEmpty() && !promptUp() && !inDom(".zen-overview")) break
                back()
                SystemClock.sleep(900)
            }
            setColorScheme("light")
        }
    }

    // --- the core ----------------------------------------------------------------------------------

    private fun activeSpaceId(): String = coreState().optString("activeSpaceId")

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == PRIVATE_CONTAINER

    /** The core's word on private tabs: on only where the WebView keeps profiles (`androidCapabilities`). */
    private fun privateTabsCapability(): Boolean =
        runCatching { coreState().getJSONObject("capabilities").optBoolean("privateTabs") }.getOrDefault(false)

    private fun webViewPackage(): String =
        shellCommand("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "WebView package ?"

    private fun privateCount(): Int {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().count { tabs.optJSONObject(it)?.optString("containerId") == PRIVATE_CONTAINER }
    }

    private fun setColorScheme(scheme: String) {
        if (themeAttribute() == scheme) return
        coreInvoke("settings.update", "{\"colorScheme\":${JSONObject.quote(scheme)}}")
        val flipped = awaitTrue(8_000) { themeAttribute() == scheme }
        if (!flipped) finding("  (the chrome's data-theme did not read '$scheme' in time: '${themeAttribute()}')")
        SystemClock.sleep(700)
    }

    private fun themeAttribute(): String = jsString("document.documentElement.getAttribute('data-theme')||''")

    private fun describeState(): String {
        val state = coreState()
        val tab = activeCoreTab(state)
        return "active ${tab?.optString("id")} ${tab?.optString("url")}, ${state.getJSONObject("tabs").length()} tabs, space ${state.optString("activeSpaceId")}, scheme ${state.getJSONObject("settings").optString("colorScheme")}"
    }

    // --- the overview ----------------------------------------------------------------------------

    /** The bar's Tabs button under a finger until the overview is up (its root at scale 1). */
    private fun openOverview() {
        ensureForeground()
        for (attempt in 1..3) {
            val close = closeUrlField()
            if (!close.ok) finding("  (attempt $attempt: ${close.describe()})")
            val tabs = tabsButton() ?: error("no Tabs button on the bar")
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (!overviewOpen() && SystemClock.uptimeMillis() < deadline) {
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt $attempt: dismissed, trying again)")
                    back()
                    awaitUntil(4_000) { !heldInstead() }
                    SystemClock.sleep(1_000)
                    break
                }
                SystemClock.sleep(200)
            }
            if (overviewOpen()) {
                awaitOverview(4_000)
                SystemClock.sleep(1_500)
                return
            }
        }
        error("the overview never opened")
    }

    private fun heldInstead(): Boolean = inDom(".zen-quick-menu") || (inDom(".zen-sheet") && !inDom(".zen-overview"))

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    /** The system back until the overview is gone (a sheet or the menu over it goes first). */
    private fun leaveOverview() {
        for (attempt in 1..6) {
            if (!inDom(".zen-overview")) break
            back()
            awaitUntil(4_000) { !inDom(".zen-overview") }
            SystemClock.sleep(700)
        }
        if (inDom(".zen-overview")) error("the overview never left")
        awaitIme(false, 6_000)
        SystemClock.sleep(600)
    }

    /** The header row's height in CSS px (§1: 56). */
    private fun headerHeight(): Int =
        jsString("(function(){var h=document.querySelector('.zen-overview > header');return h?String(Math.round(h.getBoundingClientRect().height)):''})()").toIntOrNull() ?: -1

    /** The header row's controls by their names (the title alone at rest; Done and Select all while selecting). */
    private fun headerControls(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-overview > header button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()})")

    /** Whatever remains of the controls §1 took away: the Spaces button, the search toggle, the overview's ⋯, a segment. */
    private fun staleControls(): List<String> =
        jsList(
            "Array.prototype.map.call(document.querySelectorAll('.zen-overview [aria-label=\"Spaces\"], .zen-overview [aria-label=\"More\"], " +
                ".zen-overview button[aria-label=\"Search tabs\"], .zen-overview [role=\"tab\"], .zen-overview [role=\"tablist\"]'),function(e){return e.getAttribute('aria-label')||e.getAttribute('role')||e.tagName})"
        )

    /** The grid's cells in order by their keys (`data-cell`: a tab's id, `group:<id>`, `saved:<id>`, `new-tab` last). */
    private fun cellKeys(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-overview-grid [data-cell]'),function(e){return e.getAttribute('data-cell')})")

    /** The private view's tab cells (the private grid's cards less the New Tab card). */
    private fun privateCells(): List<String> = cellKeys().filter { it != "new-tab" && !it.startsWith("group:") && !it.startsWith("saved:") }

    /** A tab's cell in the grid (`data-cell` is the tab's id). */
    private fun cell(tabId: String): String = ".zen-overview-grid [data-cell=\"$tabId\"]"

    /** The card inside the cell: the control (a button; a checkbox in the select-tabs mode). */
    private fun card(tabId: String): String = "${cell(tabId)} .zen-overview-card"

    private fun cardName(): String = textOf("$GROUP_HEADER > span.truncate")

    private fun slotLive(): Boolean = jsString("(function(){var e=document.querySelector('$SPACE_SLOT');return e&&e.hasAttribute('data-swipe')?'live':''})()") == "live"

    private fun slotTransform(): String = jsString("(function(){var e=document.querySelector('$SPACE_SLOT');return e?e.style.transform:''})()")

    private fun activeElementId(): String = jsString("(document.activeElement&&document.activeElement.id)||''")

    private fun searchValue(): String = jsString("(function(){var e=${q(SEARCH_INPUT)};return e?e.value:''})()")

    /** The select-tabs mode's action row, its buttons' accessible names in order ("Close 1 tab", …). */
    private fun actionNames(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('[data-testid=\"overview-actions\"] button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()})")

    // --- the overview's menu (the bar's ⋯ while the overview stands) -----------------------------

    /** Open the overview's menu from the bar's ⋯ and pull it to its full height; false when it never came up. */
    private fun openMenu(): Boolean {
        if (overviewMenuRows().isNotEmpty()) return true
        tapMenuButton()
        if (!awaitUntil(8_000) { overviewMenuRows().isNotEmpty() }) {
            finding("  the overview's menu never opened from the bar's ⋯")
            return false
        }
        SystemClock.sleep(1_200)
        pullMenuUp()
        SystemClock.sleep(600)
        return true
    }

    /** The open menu's rows in danger ink (`MenuSheet`: the destructive rows' class). */
    private fun dangerRows(): List<String> =
        jsList("(function(){var rows=$MENU_ROWS_JS;return rows.filter(function(e){return e.className.indexOf('--zen-danger')>=0}).map(function(e){return e.textContent.trim()})})()")

    // --- the sheets ------------------------------------------------------------------------------

    /**
     * The rows of any overview sheet up (the Spaces sheet's, a group's), by their words – what
     * the reader says: the text nodes outside `aria-hidden` (a space's emoji glyph is drawn as
     * text, hidden from the tree), the row's spans a space apart ("Work 10 tabs"); empty with none.
     */
    private fun sheetRows(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return ($WORDS_JS)(e)}).filter(function(t){return t.length>0})")

    private fun spaceRow(name: String): String =
        "(function(){return Array.prototype.find.call(document.querySelectorAll('$SPACE_ROW'),function(e){return ($WORDS_JS)(e).indexOf(${JSONObject.quote(name)})===0})||null})()"

    /** The rows marked current (`aria-current`), by their words. */
    private fun currentSpaceRows(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$SPACE_ROW[aria-current=\"true\"]'),function(e){return ($WORDS_JS)(e)})")

    /**
     * The group card's members hidden under the fold: the member grid stays in the DOM for the
     * FLIP (the unfold grows it back from its box) with `aria-hidden` and opacity 0 – off the
     * grid for the eye and the reader both.
     */
    private fun membersHidden(): Boolean =
        jsString("(function(){var m=document.querySelector('$GROUP > .zen-group-members');return m&&m.getAttribute('aria-hidden')==='true'&&getComputedStyle(m).opacity==='0'?'hidden':''})()") == "hidden"

    /** The Close-all prompt (`CloseAllSheet`) is up: its title block's heading. */
    private fun promptUp(): Boolean = inDom(PROMPT_TITLE)

    private fun promptTitle(): String = textOf(PROMPT_TITLE)

    /** The prompt's footer button reading `text`. */
    private fun promptButton(text: String): String =
        "(function(){var bs=document.querySelectorAll('.zen-sheet-footer .zen-v2-button');" +
            "for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()===${JSONObject.quote(text)})return bs[i]}return null})()"

    // --- touches aimed by the chrome's DOM -------------------------------------------------------

    /**
     * A real touch on the chrome element `js` evaluates to, once its box has stood still. The
     * aim is a log line; a claim is read off what follows the touch, never off this. False,
     * nothing injected, when the element is not on screen within the wait or lies outside the
     * touchable window.
     */
    private fun touchDom(label: String, js: String): Boolean {
        val box = steadyBox(js, 8_000) ?: run {
            finding("  nothing on screen for '$label'")
            return false
        }
        val point = touchPoint(box) ?: run {
            finding("  '$label' at $box lies outside the touchable window $touchable")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on '$label' (DOM box $box)")
        Finger().tap(point.x, point.y)
        return true
    }

    /**
     * [touchDom], then up to `timeoutMs` for `took` to hold – the claim of the step, named by
     * `effect`. True when it held; a touch that went in and did not take is a [touchFault] (the
     * run fails at its end) and false.
     */
    private fun touchDomExpecting(label: String, js: String, effect: String, timeoutMs: Long = 8_000, took: () -> Boolean): Boolean {
        if (!touchDom(label, js)) return false
        if (awaitTrue(timeoutMs, took)) {
            Log.i(tag, "the touch on '$label' took: $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * The element's box on screen once two reads [STEADY_MS] apart agree, or the last read when
     * they never do within `timeoutMs`; null when it is not in the DOM within the wait.
     */
    private fun steadyBox(js: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: Rect? = null
        while (SystemClock.uptimeMillis() < deadline) {
            val box = domBox(js)
            if (box != null && !box.isEmpty) {
                if (box == last) return box
                last = box
            }
            SystemClock.sleep(STEADY_MS)
        }
        return last
    }

    /**
     * Type into the focused field, one character's events at a time so each carries the time it
     * is injected (on the software-rendered emulator the tail of a string can land past the
     * dispatcher's window).
     */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
            SystemClock.sleep(80)
        }
        finding("  typed '$text'")
    }

    // --- the chrome's DOM ------------------------------------------------------------------------

    private fun q(selector: String): String = "document.querySelector(${JSONObject.quote(selector)})"

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String =
        (runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull() as? String).orEmpty()

    /** A JS expression's array of strings (empty when it never answered). */
    private fun jsList(expression: String): List<String> {
        val raw = jsString("(function(){return JSON.stringify($expression)})()")
        if (raw.isEmpty()) return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).map { arr.optString(it) }
    }

    private fun textOf(selector: String): String =
        jsString("(function(){var e=${q(selector)};return e?e.textContent.trim():''})()")

    private fun attr(selector: String, name: String): String =
        jsString("(function(){var e=${q(selector)};return e?(e.getAttribute(${JSONObject.quote(name)})||''):''})()")

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return ${q(selector)}?'yes':''})()") == "yes"

    private fun awaitUntil(timeoutMs: Long, pollMs: Long = POLL_MS, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(pollMs)
        }
    }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `overview-cleanup-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val DEMO_TAB = "tab_example"
        private const val WORK_SPACE_ID = "space_work"
        private const val PERSONAL_SPACE_ID = "space_personal"
        private const val GROUP_ID = "folder_research"
        private const val PRIVATE_CONTAINER = "private"
        /** The title's accessible name (`overviewTitleLabel`): the space's name, the view's count – 7 tabs and 3 Essentials. */
        private const val WORK_TITLE = "Work, 10 tabs"
        private const val PERSONAL_TITLE = "Personal, 5 tabs"
        private const val PRIVATE_TITLE = "Private, 1 tab"
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L

        private const val TITLE = ".zen-overview [data-testid=\"overview-title\"]"
        private const val COUNT = ".zen-overview [data-testid=\"overview-count\"]"
        private const val SPACE_SLOT = ".zen-overview-space"
        private const val SPACE_ROW = ".zen-sheet [data-testid=\"spaces-sheet-space\"]"
        /** The Spaces sheet's rows by their words (`sheetRows`): the seeded profile's two spaces with the overview's counts, New Space… last. */
        private val SPACES_ROWS = listOf("Work 10 tabs", "Personal 5 tabs", "New Space…")
        /**
         * A JS function of an element: its words as the reader says them – the text nodes outside
         * any `aria-hidden` subtree (the space glyph, the check), each text node a word apart.
         */
        private const val WORDS_JS =
            "function(root){var parts=[];(function walk(n){if(n.nodeType===3){var t=n.nodeValue.trim();if(t)parts.push(t);return}if(n.nodeType!==1||n.hasAttribute('aria-hidden'))return;for(var c=n.firstChild;c;c=c.nextSibling)walk(c)})(root);return parts.join(' ')}"
        private const val GROUP = ".zen-overview-grid .zen-group[data-cell=\"group:$GROUP_ID\"]"
        private const val GROUP_HEADER = "$GROUP .zen-group-header"
        private const val CARD_COUNT = "$GROUP [data-testid=\"group-card-count\"]"
        private const val OPTIONS = "$GROUP [data-testid=\"group-card-options\"]"
        private const val MOSAIC = "$GROUP [data-testid=\"group-card-mosaic\"]"
        private const val SEARCH_INPUT = "#overview-search"
        private const val SEARCH_CLEAR = "[data-testid=\"overview-search-clear\"]"
        private const val SELECT_DONE = "[data-testid=\"overview-select-done\"]"
        private const val SELECTED_COUNT = "[data-testid=\"overview-selected-count\"]"
        private const val SELECT_ALL = "[data-testid=\"overview-select-all\"]"
        /** The Close-all prompt's title block heading (`PhoneSheet` on the frame's dialog host). */
        private const val PROMPT_TITLE = ".zen-sheet-title-block h2"

        /**
         * The overview's menu on the seeded profile (§4): no Private / Inactive / Recently Closed
         * row while none; New Private Tab only where the host keeps private browsing in tabs
         * (`capabilities.privateTabs` – a WebView with profiles, the shared template's one gate).
         */
        private fun menuRows(privateTabs: Boolean): List<String> =
            listOfNotNull("New Tab", "New Private Tab".takeIf { privateTabs }, "Select Tabs", "Search Tabs", "Close All Tabs (7)", "Switch Space")
        /** The private view's menu: "Tabs (10)" the way back, the session's close, no Switch Space (§3). */
        private val PRIVATE_MENU_ROWS = listOf("New Tab", "New Private Tab", "Tabs (10)", "Select Tabs", "Search Tabs", "Close Private Tabs (1)")
        /** The menu while selecting (§5). */
        private val SELECTION_MENU_ROWS = listOf("Select All", "Deselect All", "Close Selected (1)")
        /** The open group's sheet (§2). */
        private val GROUP_ROWS = listOf("Rename", "New Tab in Group", "Ungroup", "Close Group (2 Tabs)", "Delete Group")
    }
}
