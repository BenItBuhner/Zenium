package app.zen.chromium

import android.graphics.Rect
import android.graphics.RectF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.roundToInt

/**
 * Drives the PHONE side of tab groups (TAB-16 groups and saved groups in the overview's grid –
 * the Groups pane is gone, `docs/tab-overview-cleanup-spec.md` §2, §9 – TAB-15 the link menu's
 * "Open Link in New Tab in Group"; design language v2 §9.13, §9.23, §9.27, §9.29, §11.4) on
 * the shared recipe's phone AVD, every press in a sheet flow a real touch and every outcome
 * read off the chrome's DOM or the core's state:
 *
 *  1. the group's card in the grid, in its place: Research's header with the dot of the group's
 *     colour, its name and the count "2" as the aside, unfolded; no Groups pane, no segment row;
 *  2. the header's hold: the group's sheet – the colour swatches (blue checked) and Rename, New
 *     Tab in Group, Ungroup, Close Group (2 Tabs) in the plain ink, Delete Group in the danger
 *     ink (§2's ⋯ rows); a touch on the green swatch recolours the group at once, the sheet
 *     staying up;
 *  3. Rename from the sheet: the header's name slot becomes the field; typing and Enter rename
 *     the group in the core and on the card;
 *  4. the card folded by a touch on its header (the card's height spring, traced:
 *     `overview-group-fold`), then the folded card's touch: it unfolds in place, in view;
 *  5. the link menu (TAB-15): Alpha's card picked, its link held – "Open Link in New Tab in
 *     Group" stands right under "Open Link in New Tab" (Chrome 152's pair, the phone's order
 *     since #492's ruling); the touch on it opens the page in the group right behind Alpha,
 *     Alpha staying active, Beta behind the new tab;
 *  6. Close Group (3 Tabs) from the card's sheet: the tabs go (one toast, "Reading tab group
 *     closed and saved", with Undo – TAB-16's words on both touch hosts), the group stays as a
 *     SAVED card at the grid's end before the New Tab card, the ring glyph and the count "3",
 *     the core keeping the three pages in order;
 *  7. the saved card's sheet (its hold): Open (3 Tabs), Rename, Delete Group, no Close; Open
 *     brings the three pages back as the group's tabs in their order, the card open in the grid;
 *  8. Delete Group: the §9.23 prompt – "Its 3 tabs close with it; Recently Closed keeps their
 *     pages." (Cancel keeps the group; Delete in the danger ink deletes it) – the group's record
 *     goes, its tabs close with it to Recently Closed, and NO toast follows: the ask was the
 *     guard (TAB-13 / TAB-16, the Design Lead's option C: Undo for Close, a confirmation for
 *     Delete, never both); the grid at no group holds the loose cards and the New Tab card
 *     alone, no group card and no saved card, the title's count the tabs that are left.
 *
 * Findings in `tab-groups-findings.txt`, stills `tab-groups-NN-<state>.png`, the traced scene
 * in `frames.jsonl`. Driven by `android-tab-groups-demo.yml`'s phone act. See [GroupsDemoBase]
 * and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabGroupsDemo : GroupsDemoBase("tab-groups", "tab-groups-demo") {
    override val tag = "TabGroupsDemo"
    override val findingsFile = "tab-groups-findings.txt"
    override val title = "Zenium Android tab groups: the group card, saved groups, the link menu"

    /** The tab the link menu opened, once it has. */
    private var linked: String? = null

    @Test
    fun record() = recordDemo()

    /** Visit Alpha and come back, so the group's cards have thumbnails and Alpha's page is loaded. */
    override fun warmUp() {
        head()
        awaitLoaded(HOME, "$ORIGIN/")
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        groupCard()
        rowSheetAndColour()
        rename()
        foldAndReveal()
        linkMenu()
        closeToSaved()
        openSaved()
        deleteGroup()
        still("end")
        tail()
    }

    // --- 1. the group's card ---------------------------------------------------------------------

    private fun groupCard() {
        section("1. The group's card in the grid (tab overview cleanup spec §2)")
        openOverview()
        check("the group's card stands in the grid, in its place, unfolded", awaitDom(GROUP_CARD, SHEET_WAIT) && !inDom("$GROUP_CARD[data-collapsed]") && attrOf(GROUP_HEADER, "aria-expanded") == "true", "card ${domRect(GROUP_CARD)}, expanded '${attrOf(GROUP_HEADER, "aria-expanded")}'")
        check("its header reads Research with the count 2 as the aside", cardName() == "Research" && textOf(CARD_COUNT) == "2", "name '${cardName()}', count '${textOf(CARD_COUNT)}'")
        check("the Groups pane and the segment row are gone (§2, §9)", !inDom(GROUPS_PANE) && !inDom(SEGMENT), "pane ${inDom(GROUPS_PANE)}, segment ${inDom(SEGMENT)}")
        val glyph = glyphColour() + (if (inDom("$GROUP_HEADER .zen-group-row-glyph[data-saved]")) " ring" else " dot")
        check("the header's glyph is a dot of the group's colour (the ${chromeScheme()} set)", glyph.endsWith(" dot") && glyph.startsWith(blueRgb()), "glyph '$glyph', expected ${blueRgb()}")
        check("the title counts the space's tabs", titleCount() == coreTabCount(), "title '${textOf(COUNT)}', core ${coreTabCount()}")
        SystemClock.sleep(800)
        still("group-card")
    }

    // --- 2. the row's sheet and the colour ---------------------------------------------------------

    private fun rowSheetAndColour() {
        section("2. The header's hold: the group's sheet; a swatch recolours")
        openRowSheet()
        val items = sheetItems()
        check(
            "the sheet lists Rename, New Tab in Group, Ungroup, Close Group (2 Tabs), Delete Group (§2's ⋯ rows; Colour is the palette)",
            items == listOf("Rename", "New Tab in Group", "Ungroup", "Close Group (2 Tabs)", "Delete Group"),
            "items $items"
        )
        check("the sheet is titled with the group's name", textOf(SHEET_TITLE) == "Research", "title '${textOf(SHEET_TITLE)}'")
        val swatches = jsArray("Array.prototype.map.call(document.querySelectorAll('$SWATCH'),function(b){return b.getAttribute('aria-label')+(b.getAttribute('aria-checked')==='true'?'*':'')})").strings()
        check("nine colour swatches, Blue checked", swatches.size == 9 && swatches.count { it.endsWith("*") } == 1 && "Blue*" in swatches, "swatches $swatches")
        check("Close Group takes the plain ink, Delete Group the danger ink", inkOf("Close Group") == "plain" && inkOf("Delete Group") == "danger", "close ${inkOf("Close Group")}, delete ${inkOf("Delete Group")}")
        SystemClock.sleep(600)
        still("group-sheet")
        val recoloured = touchUntil("the Green swatch", { domRect("$SWATCH[aria-label=\"Green\"]") }, { folderColor() == "green" })
        check("a touch on the Green swatch recolours the group at once", recoloured, "colour ${folderColor()}")
        check("the sheet stays up with Green checked", inDom(SHEET) && awaitJs("(document.querySelector('$SWATCH[aria-label=\"Green\"]')||{getAttribute:function(){}}).getAttribute('aria-checked')==='true'"), "checked ${attrOf("$SWATCH[aria-checked=\"true\"]", "aria-label")}")
        SystemClock.sleep(600)
        still("group-sheet-green")
        dismissSheet()
        val glyph = glyphColour()
        check("the header's glyph follows the colour", glyph == greenRgb(), "glyph '$glyph', expected ${greenRgb()}")
    }

    // --- 3. rename ---------------------------------------------------------------------------------

    private fun rename() {
        section("3. Rename from the sheet: the header's field, typed into")
        openRowSheet()
        val editing = touchUntil("Rename in the sheet", { sheetRow("Rename") }, { inDom(RENAME_FIELD) }, waitMs = SHEET_WAIT)
        check("Rename turns the header's name slot into the field", editing && inDom(RENAME_FIELD), "field ${inDom(RENAME_FIELD)}")
        check("the field has the focus", awaitJs("document.activeElement&&document.activeElement.getAttribute('aria-label')==='Group name'"), "active ${jsText("document.activeElement&&document.activeElement.tagName")}")
        SystemClock.sleep(800)
        still("rename-field")
        typeAndEnter("Reading")
        check("Enter saves the new name in the core", awaitCore { folderName(it) == "Reading" }, "name ${folderName()}")
        check("the field leaves and the header reads the new name", awaitDomGone(RENAME_FIELD) && awaitUntil(4_000) { cardName() == "Reading" } && textOf(CARD_COUNT) == "2", "name '${cardName()}', count '${textOf(CARD_COUNT)}'")
        if (imeShown()) {
            back()
            awaitIme(false)
        }
        SystemClock.sleep(600)
        still("renamed")
    }

    // --- 4. the fold and the reveal ----------------------------------------------------------------

    private fun foldAndReveal() {
        section("4. The card folded (the height spring, traced); the folded card's touch unfolds it in place")
        check("the group's card stands in the grid, unfolded", awaitDom(GROUP_CARD, SHEET_WAIT) && !inDom("$GROUP_CARD[data-collapsed]"), "card ${domRect(GROUP_CARD)}")
        val header = steadyRect { domRect(GROUP_HEADER) }
        val before = domRect(GROUP_CARD)
        val point = screen(header)?.let { touchPoint(it) }
        if (point == null) {
            check("the group card's header is on screen to fold", false, "header $header")
        } else {
            finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on the group card's header (traced)")
            // The fold under a touch: the card's height spring and the cards below gliding after
            // it (v2 §11.4); the block holds the touch and the spring's flight, nothing else.
            traceFrames("overview-group-fold", JankBudget.Kind.SPRING) {
                val f = Finger()
                f.down(point.x, point.y)
                f.hold(TAP_HOLD_MS)
                f.up()
                SystemClock.sleep(FOLD_MS)
            }
        }
        check("the touch folds the group in the core", awaitCore { folderCollapsed(it) }, "collapsed ${folderCollapsed()}")
        check("the card stands folded to its header, the clip gone at rest", awaitJs("(function(){var c=document.querySelector('$GROUP_CARD');return !!c&&c.hasAttribute('data-collapsed')&&!c.hasAttribute('data-clip')})()", true, 4_000), "card ${domRect(GROUP_CARD)}, was $before")
        SystemClock.sleep(800)
        still("card-folded")

        // Folded, the card is the affordance: its touch unfolds it in place (§2, the FLIP spring).
        val shown = touchUntil("the folded card", { steadyRect { domRect(GROUP_HEADER) } }, { !folderCollapsed() }, waitMs = SHEET_WAIT)
        check("the folded card's touch unfolds the group in the core", shown, "collapsed ${folderCollapsed()}")
        check("the card stands unfolded and in view, in its place", awaitJs(CARD_IN_VIEW, true, 6_000), "card ${domRect(GROUP_CARD)}, grid ${domRect(GRID)}")
        SystemClock.sleep(1_000)
        still("revealed")
    }

    // --- 5. the link menu ------------------------------------------------------------------------

    private fun linkMenu() {
        section("5. TAB-15: the link menu in a grouped tab")
        val picked = touchUntil("Alpha's card", { domRect(card(ALPHA)) }, { !overviewOpen() && activeTabId() == ALPHA }, waitMs = 6_000)
        check("a touch on Alpha's card closes the overview into Alpha", picked, "active ${activeTabId()}, overview ${overviewOpen()}")
        awaitLoaded(ALPHA, ALPHA_URL)
        SystemClock.sleep(1_500)
        val link = linkOnScreen(ALPHA)
        if (link == null) {
            check("Alpha's link is on the screen", false, "no link")
            return
        }
        finding("  hold at ${link.x.roundToInt()},${link.y.roundToInt()} on Alpha's link")
        val f = Finger()
        f.press(link.x, link.y)
        f.up()
        check("the link's menu comes up as a sheet", awaitJs(MENU_OPEN, true, SHEET_WAIT) && awaitDom(SHEET_ITEM, SHEET_WAIT), "menu ${jsText(MENU_OPEN)}")
        val items = sheetItems()
        val inGroup = items.indexOf("Open Link in New Tab in Group")
        val plain = items.indexOf("Open Link in New Tab")
        // The phone's pair in Chrome for Android 152's order (the design lead's ruling on #492):
        // the plain row, then the group row right under it.
        check("the menu offers Open Link in New Tab in Group right under Open Link in New Tab (Chrome 152's pair)", plain >= 0 && inGroup == plain + 1, "items $items")
        SystemClock.sleep(800)
        still("link-menu")
        val before = trackOrder()
        val opened = touchUntil("Open Link in New Tab in Group", { sheetRow("Open Link in New Tab in Group") }, { trackOrder().size == before.size + 1 }, waitMs = 6_000)
        val order = trackOrder()
        linked = order.map { it.first }.firstOrNull { id -> id !in before.map { it.first } }
        val after = linked?.let { order.indexOfFirst { p -> p.first == it } } ?: -1
        val alphaAt = order.indexOfFirst { it.first == ALPHA }
        check("the page opens as a new tab", opened && linked != null && awaitCore { tabUrl(linked!!, it) == LINKED_URL }, "new ${linked?.let { tabUrl(it) }}")
        check("the new tab is in the group, right behind Alpha", linked != null && folderOf(linked!!) == FOLDER && after == alphaAt + 1, "order ${order.map { "${it.first}${if (it.second != null) "(g)" else ""}" }}")
        check("Alpha stays the active tab", activeTabId() == ALPHA, "active ${activeTabId()}")
        check("Beta stays behind the new tab in the group", groupTabs().map { it.first } == listOf(ALPHA, linked, BETA), "group ${groupTabs()}")
        SystemClock.sleep(1_000)
        still("link-opened")
    }

    // --- 6. Close Group -> saved -----------------------------------------------------------------

    private fun closeToSaved() {
        section("6. Close Group (3 Tabs) from the card's sheet: the group stays, saved")
        openOverview()
        check("the card now counts three tabs", awaitDom(GROUP_CARD, SHEET_WAIT) && awaitUntil(SHEET_WAIT) { textOf(CARD_COUNT) == "3" } && cardName() == "Reading", "name '${cardName()}', count '${textOf(CARD_COUNT)}'")
        openRowSheet()
        check("the sheet's Close Group counts three", sheetRow("Close Group (3 Tabs)") != null, "items ${sheetItems()}")
        val closed = touchUntil("Close Group (3 Tabs)", { sheetRow("Close Group (3 Tabs)") }, { !tabExists(ALPHA) && !tabExists(BETA) }, waitMs = 8_000)
        check("the group's tabs close", closed, "alpha ${tabExists(ALPHA)}, beta ${tabExists(BETA)}")
        // The one toast in the group's words (TAB-16: the same on the tablet's Close Group), not
        // the tab count's "3 tabs closed", with the one Undo; left to its clock here.
        val toast = awaitToast("Reading tab group closed and saved")
        check("one toast, \"Reading tab group closed and saved\", with Undo", toast == "Reading tab group closed and saved" && inDom("$TOAST .zen-message-button"), "toast '${textOf("$TOAST .zen-message-text")}'")
        check(
            "the core keeps the group SAVED with its three pages in order",
            awaitCore { savedUrls(it) == listOf(ALPHA_URL, LINKED_URL, BETA_URL) },
            "saved ${savedUrls().map { it.removePrefix(ORIGIN) }}"
        )
        check("the group stands as a saved card with the ring glyph and the count 3 (TAB-16, §2)", awaitDom(SAVED_CARD, 6_000) && inDom("$SAVED_CARD .zen-group-row-glyph[data-saved]") && awaitUntil(4_000) { savedName() == "Reading" && textOf(SAVED_COUNT) == "3" }, "saved '${savedName()}', count '${textOf(SAVED_COUNT)}'")
        check("at the grid's end, before the New Tab card", savedCardBeforeNewTab(), "cells ${cellKeys()}")
        check("no open card of it is left", awaitDomGone(GROUP_CARD, 4_000), "card ${domRect(GROUP_CARD)}")
        check("the title's count dropped to the tabs that are left", awaitUntil(4_000) { titleCount() == coreTabCount() }, "title '${textOf(COUNT)}', core ${coreTabCount()}")
        SystemClock.sleep(800)
        still("saved")
        awaitToastGone()
    }

    // --- 7. Open the saved group -----------------------------------------------------------------

    private fun openSaved() {
        section("7. The saved card's sheet; Open brings the pages back as the group")
        openRowSheet(saved = true)
        val items = sheetItems()
        check("the saved group's sheet lists Open (3 Tabs), Rename, Delete Group and no Close", items == listOf("Open (3 Tabs)", "Rename", "Delete Group"), "items $items")
        SystemClock.sleep(600)
        still("saved-sheet")
        val opened = touchUntil("Open (3 Tabs)", { sheetRow("Open (3 Tabs)") }, { groupTabs().size == 3 }, waitMs = 12_000)
        check("Open brings three tabs back into the group", opened, "group ${groupTabs()}")
        check("in their order: Alpha, the linked page, Beta", groupTabs().map { it.second } == listOf(ALPHA_URL, LINKED_URL, BETA_URL), "urls ${groupTabs().map { it.second.removePrefix(ORIGIN) }}")
        check("the kept pages are gone from the record (the group is open again)", awaitCore { savedUrls(it).isEmpty() }, "saved ${savedUrls()}")
        check("the grid shows the group's card again, unfolded and in view, the saved card gone", awaitJs(CARD_IN_VIEW, true, 8_000) && awaitDomGone(SAVED_CARD, 4_000), "card ${domRect(GROUP_CARD)}, saved ${domRect(SAVED_CARD)}")
        SystemClock.sleep(1_500)
        still("reopened")
    }

    // --- 8. Delete Group ---------------------------------------------------------------------------

    private fun deleteGroup() {
        section("8. Delete Group: the prompt, Cancel, then Delete – no toast after the ask")
        awaitDom(GROUP_CARD, SHEET_WAIT)
        openRowSheet()
        val asked = touchUntil("Delete Group in the sheet", { sheetRow("Delete Group") }, { inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        check("Delete Group asks first (the group holds tabs)", asked, "prompt ${inDom(DELETE_PROMPT)}")
        // The prompt's words are the three hosts' one source (`folderDeleteWords`, lib/folderDelete.ts):
        // the consequence, and no promise of an Undo.
        check(
            "the prompt is titled Delete Reading? with the consequence, \"Its 3 tabs close with it; Recently Closed keeps their pages.\"",
            jsBoolean("(function(){var s=document.querySelector('$DELETE_PROMPT');return !!s&&s.textContent.indexOf('Delete Reading?')>=0&&s.textContent.indexOf('Its 3 tabs close with it; Recently Closed keeps their pages.')>=0&&s.textContent.indexOf('Undo')<0})()"),
            "text '${textOf(DELETE_PROMPT).take(200)}'"
        )
        check("Delete takes the danger ink, Cancel the plain", inDom("$DELETE_CONFIRM[data-danger]") && jsBoolean("(function(){var b=Array.prototype.find.call(document.querySelectorAll('$DELETE_PROMPT .zen-sheet-footer button'),function(n){return n.textContent.trim()==='Cancel'});return !!b&&!b.hasAttribute('data-danger')})()"), "confirm ${inDom(DELETE_CONFIRM)}")
        SystemClock.sleep(800)
        still("delete-prompt")
        val kept = touchUntil("Cancel", { textRect("$DELETE_PROMPT .zen-sheet-footer button", "Cancel") }, { !inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        check("Cancel keeps the group", kept && folder() != null && groupTabs().size == 3, "folder ${folder() != null}, group ${groupTabs().size}")
        SystemClock.sleep(600)

        openRowSheet()
        touchUntil("Delete Group in the sheet", { sheetRow("Delete Group") }, { inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        // Open (act 7) made the group's tabs afresh from the kept pages: the members by their live ids.
        val members = groupTabs().map { it.first }
        val deleted = touchUntil("Delete", { domRect(DELETE_CONFIRM) }, { folder() == null }, waitMs = 8_000)
        check("Delete removes the group's record", deleted, "folder ${folder()}")
        check("its tabs close with it", members.size == 3 && awaitCore { s -> members.none { tabExists(it, s) } }, "members $members, live ${members.filter { tabExists(it) }}")
        // The ask was the guard: no toast, so no Undo, after it (option C – never both). The
        // window is longer than a close's settle wait (`CLOSE_SETTLE_MS`, 1.5 s) and the filing.
        val toastAfter = toastWithin(3_000)
        check("no toast follows the Delete", toastAfter == null, "toast '${toastAfter ?: ""}'")
        // The grid at no group: the group's card and the saved card are gone with the group,
        // the loose cards and the New Tab card alone are left (the Groups pane's §9.17 note went
        // with the pane, §2, §9), and the title counts what is left.
        check("the grid holds no group card and no saved card", awaitDomGone(GROUP_CARD, 6_000) && !inDom(SAVED_CARD) && cellKeys().none { it.startsWith("group:") || it.startsWith("saved:") }, "cells ${cellKeys()}")
        check("the New Tab card ends the grid", cellKeys().lastOrNull() == "new-tab", "cells ${cellKeys()}")
        check("the title counts the tabs that are left", awaitUntil(4_000) { titleCount() == coreTabCount() }, "title '${textOf(COUNT)}', core ${coreTabCount()}")
        finding("  (the grid at no group: cells ${cellKeys()}, grid ${domRect(GRID)})")
        SystemClock.sleep(600)
        still("deleted-empty")
        // The three pages are Recently Closed's to bring back – each an entry of its own on the
        // core's list – and none is back in the track: nothing restored them loose.
        val pages = listOf(ALPHA_URL, LINKED_URL, BETA_URL)
        val recent = recentlyClosedUrls()
        check("the three pages are on the recently closed list", pages.all { it in recent }, "recent ${recent.map { it.removePrefix(ORIGIN) }}")
        check("none is restored: the track holds none of the three", pages.none { tabIdAt(it) != null }, "track ${trackOrder().map { (id, _) -> tabUrl(id)?.removePrefix(ORIGIN) ?: id }}")
        check("the group's record stays gone", folder() == null, "folder ${folder()}")
        check("still no toast", !inDom(TOAST), "toast '${textOf("$TOAST .zen-message-text")}'")
        SystemClock.sleep(1_000)
    }

    // --- the overview ------------------------------------------------------------------------------

    /** Open the overview with a touch on the bar's Tabs button; a touch read as a hold is dismissed and tried again. */
    private fun openOverview() {
        if (overviewOpen()) return
        for (attempt in 0 until OPEN_ATTEMPTS) {
            val close = closeUrlField()
            if (!close.ok) finding("  (attempt ${attempt + 1}: ${close.describe()})")
            val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: screen(domRect("[aria-label^=\"Tabs (\"]"))
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (!overviewOpen() && SystemClock.uptimeMillis() < deadline) {
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt ${attempt + 1}: dismissed, trying again)")
                    back()
                    val gone = SystemClock.uptimeMillis() + 4_000
                    while (heldInstead() && SystemClock.uptimeMillis() < gone) SystemClock.sleep(200)
                    SystemClock.sleep(1_000)
                    break
                }
                SystemClock.sleep(200)
            }
            if (overviewOpen()) {
                SystemClock.sleep(2_000)
                overviewTitleLabel()?.let { calibrate(OVERVIEW_TITLE_SELECTOR, it) }
                return
            }
        }
        error("the overview never opened")
    }

    private fun heldInstead(): Boolean = inDom(".zen-quick-menu, .zen-sheet")

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    /** The grid's cells in their order (`data-cell`): the tabs', the groups' (`group:<id>`, `saved:<id>`), the New Tab card's last. */
    private fun cellKeys(): List<String> = jsArray("Array.prototype.map.call(document.querySelectorAll('$GRID [data-cell]'),function(c){return c.getAttribute('data-cell')})").strings()

    /** The saved group's card stands before the New Tab card, with no tab card after it (§2). */
    private fun savedCardBeforeNewTab(): Boolean {
        val keys = cellKeys()
        val saved = keys.indexOfFirst { it.startsWith("saved:") }
        val newTab = keys.indexOf("new-tab")
        return saved >= 0 && newTab > saved && keys.subList(saved + 1, newTab).all { it.startsWith("saved:") }
    }

    private fun cardName(): String = textOf("$GROUP_HEADER > span.truncate")
    private fun savedName(): String = textOf("$SAVED_CARD .zen-group-header > span.truncate")

    /** The title's count ("N tabs", `[data-testid=overview-count]`) as its number; -1 while none. */
    private fun titleCount(): Int = Regex("\\d+").find(textOf(COUNT))?.value?.toIntOrNull() ?: -1

    /** The space's tabs as the core counts them. */
    private fun coreTabCount(): Int = trackOrder().size

    /** Hold the group's card header (the open card's, or the saved card's) until its sheet is up. */
    private fun openRowSheet(saved: Boolean = false) {
        val header = if (saved) "$SAVED_CARD .zen-group-header" else GROUP_HEADER
        for (attempt in 1..3) {
            val box = steadyRect { domRect(header) } ?: error("no group card header to hold")
            hold(box, "the group card's header")
            if (awaitDom(SHEET_ITEM, SHEET_WAIT)) {
                SystemClock.sleep(600)
                return
            }
            finding("  (the hold did not bring the sheet, attempt $attempt)")
        }
        error("the row's sheet never came up")
    }

    private fun dismissSheet() {
        if (!inDom(SHEET)) return
        back()
        if (!awaitDomGone(SHEET, SHEET_WAIT)) finding("  (the sheet is still up)")
        SystemClock.sleep(500)
    }

    private fun sheetItems(): List<String> = textsOf(SHEET_ITEM)

    private fun sheetRow(prefix: String): RectF? = textRect(SHEET_ITEM, prefix)

    /** `danger` when the sheet row `prefix` is drawn in the danger ink (`--zen-danger`), `plain` otherwise. */
    private fun inkOf(prefix: String): String = jsText(
        "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll('$SHEET_ITEM'),function(n){return n.textContent.trim().indexOf(p)===0});" +
            "if(!e)return 'none';var probe=document.createElement('span');probe.style.color='var(--zen-danger)';document.body.appendChild(probe);" +
            "var dc=getComputedStyle(probe).color;probe.remove();return getComputedStyle(e).color===dc?'danger':'plain'})()"
    )

    /**
     * The group card header's glyph colour: the theme's pick of the §9.14 pair, `--zen-group-rgb`'s
     * channels as the glyph computes them, read back as `rgb(r, g, b)` – the form a computed
     * background takes, so it compares to `blueRgb()` / `greenRgb()`.
     */
    private fun glyphColour(): String =
        jsText("(function(){var g=document.querySelector('$GROUP_HEADER .zen-group-row-glyph');if(!g)return '';var c=getComputedStyle(g).getPropertyValue('--zen-group-rgb').trim();return c?'rgb('+c.split(/\\s+/).join(', ')+')':''})()")

    private fun card(tabId: String) = ".zen-overview-grid [data-tab-id=\"$tabId\"]"

    private companion object {
        private const val OPEN_ATTEMPTS = 4
        private const val FOLD_MS = 1_400L
        /** The Groups pane and the segment row of before the tab overview cleanup spec (§2, §9) – pinned gone. */
        private const val GROUPS_PANE = "[data-testid=\"overview-groups\"]"
        private const val SEGMENT = ".zen-overview [role=\"tab\"]"
        /** The rename field in the card's header (`GroupRename`, named Group name). */
        private const val RENAME_FIELD = ".zen-overview-grid .zen-group-header input[aria-label=\"Group name\"]"
        /** The title's count span ("N tabs"; the title is the space switcher, §1). */
        private const val COUNT = "[data-testid=\"overview-count\"]"
        private const val SHEET = ".zen-sheet"
        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val SHEET_TITLE = ".zen-sheet .zen-sheet-title"
        private const val SWATCH = ".zen-sheet [role=\"radiogroup\"] [role=\"radio\"]"
        private const val DELETE_CONFIRM = "[data-testid=\"overview-delete-group-confirm\"]"
        /** The §9.23 prompt: the sheet that holds the Delete button. */
        private const val DELETE_PROMPT = ".zen-sheet:has($DELETE_CONFIRM)"
        private const val GRID = ".zen-overview-grid"
        private const val GROUP_CARD = ".zen-overview-grid [data-cell=\"group:$FOLDER\"]"
        private const val GROUP_HEADER = "$GROUP_CARD > .zen-group-header"
        private const val CARD_COUNT = "$GROUP_HEADER [data-testid=\"group-card-count\"]"
        /** The saved group's card at the grid's end (`SavedGroupCard`, the cell `saved:<id>`) and its count. */
        private const val SAVED_CARD = ".zen-overview-grid .zen-group-saved[data-saved]"
        private const val SAVED_COUNT = "$SAVED_CARD [data-testid=\"group-card-count\"]"
        /** The group's card stands within the grid's viewport, its header row whole. */
        private const val CARD_IN_VIEW = "(function(){var c=document.querySelector('$GROUP_CARD'),g=document.querySelector('$GRID');if(!c||!g)return false;" +
            "var cr=c.getBoundingClientRect(),gr=g.getBoundingClientRect();return !c.hasAttribute('data-collapsed')&&cr.top>=gr.top-1&&cr.top+44<=gr.bottom+1})()"
    }
}
