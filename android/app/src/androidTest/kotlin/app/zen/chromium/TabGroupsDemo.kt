package app.zen.chromium

import android.graphics.Rect
import android.graphics.RectF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the PHONE side of tab groups (TAB-16 the Groups pane and saved groups, TAB-15 the link
 * menu's "Open Link in New Tab in Group"; design language v2 §9.13, §9.23, §9.27, §9.29, §11.4)
 * on the shared recipe's phone AVD, every press in a sheet flow a real touch and every outcome
 * read off the chrome's DOM or the core's state:
 *
 *  1. the overview's Groups segment: the pane lists Research under OPEN with "2 tabs", the
 *     header counts "1 group", the row's glyph is a dot of the group's colour, the row 64 tall;
 *  2. the row's hold: the group's sheet – the colour swatches (blue checked) and Show in Tabs,
 *     Rename, Close Group (2 Tabs) in the plain ink, Delete Group in the danger ink; a touch on
 *     the green swatch recolours the group at once, the sheet staying up;
 *  3. Rename from the sheet: the row's title slot becomes the field; typing and Enter rename the
 *     group in the core and on the row;
 *  4. the Tabs pane's group card folded by a touch on its header (the card's height spring,
 *     traced: `overview-group-fold`), then the Groups row's touch: the Tabs pane comes back with
 *     the group's card unfolded and in view;
 *  5. the link menu (TAB-15): Alpha's card picked, its link held – "Open Link in New Tab in
 *     Group" stands above "Open Link in New Tab"; the touch on it opens the page in the group
 *     right behind Alpha, Alpha staying active, Beta behind the new tab;
 *  6. Close Group (3 Tabs) from the row's sheet: the tabs go (one toast with Undo), the group
 *     stays listed under SAVED with the ring glyph and "3 tabs", the core keeping the three
 *     pages in order;
 *  7. the saved row's sheet: Open (3 Tabs), Rename, Delete Group, no Close; Open brings the
 *     three pages back as the group's tabs in their order, and the Tabs pane shows the card;
 *  8. Delete Group: the §9.23 prompt (Cancel keeps the group; Delete in the danger ink deletes
 *     it) – the group's record goes, its tabs close with one toast whose Undo brings them back
 *     loose; the pane at none reads "No tab groups".
 *
 * Findings in `tab-groups-findings.txt`, stills `tab-groups-NN-<state>.png`, the traced scene
 * in `frames.jsonl`. Driven by `android-tab-groups-demo.yml`'s phone act. See [GroupsDemoBase]
 * and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabGroupsDemo : GroupsDemoBase("tab-groups", "tab-groups-demo") {
    override val tag = "TabGroupsDemo"
    override val findingsFile = "tab-groups-findings.txt"
    override val title = "Zenium Android tab groups: the Groups pane, saved groups, the link menu"

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
        groupsPane()
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

    // --- 1. the Groups pane ------------------------------------------------------------------------

    private fun groupsPane() {
        section("1. The overview's Groups segment: the pane")
        openOverview()
        still("tabs-pane")
        pickPane("groups")
        check("the Groups pane comes up", awaitDom(GROUPS_PANE, SHEET_WAIT), "pane ${inDom(GROUPS_PANE)}")
        check("the header counts one group", awaitJs("(document.querySelector('$COUNT')||{}).textContent==='1 group'"), "count '${textOf(COUNT)}'")
        check("Research is listed under Open with two tabs", awaitJs(rowUnder("open", "Research", "2 tabs")), "rows ${textsOf("$GROUPS_PANE .zen-list-title")} / ${textsOf("$GROUPS_PANE .zen-list-subtitle")}")
        check("no Saved section yet", !inDom(SAVED_SECTION))
        val glyph = glyphColour() + (if (inDom("$GROUPS_PANE .zen-overview-group-glyph[data-saved]")) " ring" else " dot")
        check("the row's glyph is a dot of the group's colour", glyph.endsWith(" dot") && glyph.startsWith(BLUE_HEX, ignoreCase = true), "glyph '$glyph'")
        check("the row is 64 tall (a two-line row)", domRect(ROW)?.let { abs(it.height() - 64) <= 1 } == true, "row ${domRect(ROW)}")
        SystemClock.sleep(800)
        still("groups-pane")
    }

    // --- 2. the row's sheet and the colour ---------------------------------------------------------

    private fun rowSheetAndColour() {
        section("2. The row's hold: the group's sheet; a swatch recolours")
        openRowSheet()
        val items = sheetItems()
        check(
            "the sheet lists Show in Tabs, Rename, Close Group (2 Tabs), Delete Group",
            items == listOf("Show in Tabs", "Rename", "Close Group (2 Tabs)", "Delete Group"),
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
        check("the row's glyph follows the colour", glyph.isNotBlank() && !glyph.equals(BLUE_HEX, ignoreCase = true), "glyph '$glyph'")
    }

    // --- 3. rename ---------------------------------------------------------------------------------

    private fun rename() {
        section("3. Rename from the sheet: the row's field, typed into")
        openRowSheet()
        val editing = touchUntil("Rename in the sheet", { sheetRow("Rename") }, { inDom(RENAME_ROW) }, waitMs = SHEET_WAIT)
        check("Rename turns the row's title slot into the field", editing && inDom("$RENAME_ROW input"), "field ${inDom("$RENAME_ROW input")}")
        check("the field has the focus", awaitJs("document.activeElement&&document.activeElement.getAttribute('aria-label')==='Group name'"), "active ${jsText("document.activeElement&&document.activeElement.tagName")}")
        SystemClock.sleep(800)
        still("rename-field")
        typeAndEnter("Reading")
        check("Enter saves the new name in the core", awaitCore { folderName(it) == "Reading" }, "name ${folderName()}")
        check("the field leaves and the row reads the new name", awaitDomGone(RENAME_ROW) && awaitJs(rowUnder("open", "Reading", "2 tabs")), "titles ${textsOf("$GROUPS_PANE .zen-list-title")}")
        if (imeShown()) {
            back()
            awaitIme(false)
        }
        SystemClock.sleep(600)
        still("renamed")
    }

    // --- 4. the fold and the reveal ----------------------------------------------------------------

    private fun foldAndReveal() {
        section("4. The Tabs pane's card folded (the height spring, traced); the row's touch shows it unfolded")
        pickPane("tabs")
        check("the group's card is on the Tabs pane, unfolded", awaitDom(GROUP_CARD, SHEET_WAIT) && !inDom("$GROUP_CARD[data-collapsed]"), "card ${domRect(GROUP_CARD)}")
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

        pickPane("groups")
        awaitDom(GROUPS_PANE, SHEET_WAIT)
        val shown = touchUntil("the group's row", { domRect("$ROW .zen-list-main") }, { paneIs("tabs") }, waitMs = SHEET_WAIT)
        check("the row's touch brings the Tabs pane", shown, "pane ${selectedPane()}")
        check("the group is unfolded", awaitCore { !folderCollapsed(it) }, "collapsed ${folderCollapsed()}")
        check("the card stands unfolded and in view", awaitJs(CARD_IN_VIEW, true, 6_000), "card ${domRect(GROUP_CARD)}, grid ${domRect(GRID)}")
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
        check("the menu offers Open Link in New Tab in Group above Open Link in New Tab", inGroup >= 0 && plain > inGroup, "items $items")
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
        section("6. Close Group (3 Tabs) from the row's sheet: the group stays, saved")
        openOverview()
        pickPane("groups")
        check("the row now counts three tabs", awaitJs(rowUnder("open", "Reading", "3 tabs"), true, SHEET_WAIT), "subtitles ${textsOf("$GROUPS_PANE .zen-list-subtitle")}")
        openRowSheet()
        check("the sheet's Close Group counts three", sheetRow("Close Group (3 Tabs)") != null, "items ${sheetItems()}")
        val closed = touchUntil("Close Group (3 Tabs)", { sheetRow("Close Group (3 Tabs)") }, { !tabExists(ALPHA) && !tabExists(BETA) }, waitMs = 8_000)
        check("the group's tabs close", closed, "alpha ${tabExists(ALPHA)}, beta ${tabExists(BETA)}")
        val toast = awaitToast("3 tabs closed")
        check("one toast, \"3 tabs closed\", with Undo", toast != null && inDom("$TOAST .zen-message-button"), "toast '$toast'")
        check(
            "the core keeps the group SAVED with its three pages in order",
            awaitCore { savedUrls(it) == listOf(ALPHA_URL, LINKED_URL, BETA_URL) },
            "saved ${savedUrls().map { it.removePrefix(ORIGIN) }}"
        )
        check("the row moves under Saved with the ring glyph and three tabs", awaitJs(rowUnder("saved", "Reading", "3 tabs"), true, 6_000) && inDom("$SAVED_SECTION .zen-overview-group-glyph[data-saved]"), "saved rows ${textsOf("$SAVED_SECTION .zen-list-title")}")
        check("no Open section is left", !inDom(OPEN_SECTION), "open ${textsOf("$OPEN_SECTION .zen-list-title")}")
        check("the header still counts one group", textOf(COUNT) == "1 group", "count '${textOf(COUNT)}'")
        SystemClock.sleep(800)
        still("saved")
        awaitToastGone()
    }

    // --- 7. Open the saved group -----------------------------------------------------------------

    private fun openSaved() {
        section("7. The saved row's sheet; Open brings the pages back as the group")
        openRowSheet(saved = true)
        val items = sheetItems()
        check("the saved group's sheet lists Open (3 Tabs), Rename, Delete Group and no Close", items == listOf("Open (3 Tabs)", "Rename", "Delete Group"), "items $items")
        SystemClock.sleep(600)
        still("saved-sheet")
        val opened = touchUntil("Open (3 Tabs)", { sheetRow("Open (3 Tabs)") }, { groupTabs().size == 3 }, waitMs = 12_000)
        check("Open brings three tabs back into the group", opened, "group ${groupTabs()}")
        check("in their order: Alpha, the linked page, Beta", groupTabs().map { it.second } == listOf(ALPHA_URL, LINKED_URL, BETA_URL), "urls ${groupTabs().map { it.second.removePrefix(ORIGIN) }}")
        check("the kept pages are gone from the record (the group is open again)", awaitCore { savedUrls(it).isEmpty() }, "saved ${savedUrls()}")
        check("the Tabs pane shows the card, unfolded and in view", awaitUntil(8_000) { paneIs("tabs") } && awaitJs(CARD_IN_VIEW, true, 8_000), "pane ${selectedPane()}, card ${domRect(GROUP_CARD)}")
        SystemClock.sleep(1_500)
        still("reopened")
    }

    // --- 8. Delete Group ---------------------------------------------------------------------------

    private fun deleteGroup() {
        section("8. Delete Group: the prompt, Cancel, then Delete with its Undo")
        pickPane("groups")
        awaitDom(GROUPS_PANE, SHEET_WAIT)
        openRowSheet()
        val asked = touchUntil("Delete Group in the sheet", { sheetRow("Delete Group") }, { inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        check("Delete Group asks first (the group holds tabs)", asked, "prompt ${inDom(DELETE_PROMPT)}")
        check("the prompt is titled Delete Reading? with the consequence", jsBoolean("(function(){var s=document.querySelector('$DELETE_PROMPT');return !!s&&s.textContent.indexOf('Delete Reading?')>=0&&s.textContent.indexOf('Undo on the toast')>=0})()"), "text '${textOf(DELETE_PROMPT).take(160)}'")
        check("Delete takes the danger ink, Cancel the plain", inDom("$DELETE_CONFIRM[data-danger]") && jsBoolean("(function(){var b=Array.prototype.find.call(document.querySelectorAll('$DELETE_PROMPT .zen-sheet-footer button'),function(n){return n.textContent.trim()==='Cancel'});return !!b&&!b.hasAttribute('data-danger')})()"), "confirm ${inDom(DELETE_CONFIRM)}")
        SystemClock.sleep(800)
        still("delete-prompt")
        val kept = touchUntil("Cancel", { textRect("$DELETE_PROMPT .zen-sheet-footer button", "Cancel") }, { !inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        check("Cancel keeps the group", kept && folder() != null && groupTabs().size == 3, "folder ${folder() != null}, group ${groupTabs().size}")
        SystemClock.sleep(600)

        openRowSheet()
        touchUntil("Delete Group in the sheet", { sheetRow("Delete Group") }, { inDom(DELETE_PROMPT) }, waitMs = SHEET_WAIT)
        val deleted = touchUntil("Delete", { domRect(DELETE_CONFIRM) }, { folder() == null }, waitMs = 8_000)
        check("Delete removes the group's record", deleted, "folder ${folder()}")
        check("its tabs close with it", awaitCore { !tabExists(ALPHA, it) && !tabExists(BETA, it) }, "alpha ${tabExists(ALPHA)}")
        val toast = awaitToast("3 tabs closed")
        check("one toast, \"3 tabs closed\"", toast != null, "toast '$toast'")
        check("the pane at none reads No tab groups", awaitDom(GROUPS_EMPTY, 6_000) && textOf("$GROUPS_EMPTY h2") == "No tab groups", "empty ${textOf("$GROUPS_EMPTY h2")}")
        check("the header counts no group", textOf(COUNT) == "0 groups", "count '${textOf(COUNT)}'")
        SystemClock.sleep(600)
        still("deleted-empty")
        val undone = undo()
        check("Undo brings the tabs back, loose", undone && awaitCore { tabExists(ALPHA, it) && tabExists(BETA, it) && folderOf(ALPHA, it) == null && folderOf(BETA, it) == null }, "alpha in ${folderOf(ALPHA)}, exists ${tabExists(ALPHA)}")
        check("the group's record stays gone", folder() == null, "folder ${folder()}")
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
                calibrate("[aria-label=\"Spaces\"]", "Spaces")
                return
            }
        }
        error("the overview never opened")
    }

    private fun heldInstead(): Boolean = inDom(".zen-quick-menu, .zen-sheet")

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun selectedPane(): String = attrOf("[data-testid^=\"overview-pane-\"][aria-selected=\"true\"]", "data-pane")

    private fun paneIs(pane: String): Boolean = selectedPane() == pane

    /** A touch on the segment's `pane` button until the pane is the one picked. */
    private fun pickPane(pane: String) {
        if (paneIs(pane)) return
        val picked = touchUntil("the $pane segment", { domRect("[data-testid=\"overview-pane-$pane\"]") }, { paneIs(pane) }, waitMs = SHEET_WAIT)
        if (!picked) error("the $pane pane never came up")
        SystemClock.sleep(600)
    }

    /** Hold the group's row (under Open, or under Saved) until its sheet is up. */
    private fun openRowSheet(saved: Boolean = false) {
        val row = if (saved) "$SAVED_SECTION .zen-phone-row" else "$OPEN_SECTION .zen-phone-row"
        for (attempt in 1..3) {
            val box = steadyRect { domRect("$row .zen-list-main") } ?: error("no group row to hold")
            hold(box, "the group's row")
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

    /** The first Groups row's glyph colour (`--zen-group-color`, the group's hex). */
    private fun glyphColour(): String =
        jsText("(function(){var g=document.querySelector('$GROUPS_PANE .zen-overview-group-glyph');return g?getComputedStyle(g).getPropertyValue('--zen-group-color').trim():''})()")

    private fun card(tabId: String) = ".zen-overview-grid [data-tab-id=\"$tabId\"]"

    /** Touch the toast's action once the toast is at rest; a picked action sends the toast off at once. */
    private fun undo(): Boolean {
        if (awaitRect(6_000) { domRect("$TOAST .zen-message-button") } == null) {
            finding("  (the toast's Undo never showed)")
            return false
        }
        awaitJs("(function(){var e=document.querySelector('$TOAST');return !!e&&!e.hasAttribute('data-moving')})()", true, 1_500)
        return touchUntil("the toast's Undo", { domRect("$TOAST .zen-message-button") }, { !inDom(TOAST) || jsBoolean("document.querySelector('$TOAST').hasAttribute('data-moving')") }, waitMs = 800)
    }

    /** The pane section `kind` (open / saved) holds a row titled `title` whose subtitle starts with `subtitle`. */
    private fun rowUnder(kind: String, title: String, subtitle: String): String =
        "(function(){var rows=document.querySelectorAll('[data-testid=\"overview-groups-$kind\"] .zen-phone-row');" +
            "return Array.prototype.some.call(rows,function(r){var t=r.querySelector('.zen-list-title'),s=r.querySelector('.zen-list-subtitle');" +
            "return !!t&&t.textContent.trim()===${JSONObject.quote(title)}&&!!s&&s.textContent.trim().indexOf(${JSONObject.quote(subtitle)})===0})})()"

    private companion object {
        private const val OPEN_ATTEMPTS = 4
        private const val FOLD_MS = 1_400L
        private const val GROUPS_PANE = "[data-testid=\"overview-groups\"]"
        private const val OPEN_SECTION = "[data-testid=\"overview-groups-open\"]"
        private const val SAVED_SECTION = "[data-testid=\"overview-groups-saved\"]"
        private const val GROUPS_EMPTY = "[data-testid=\"overview-groups-empty\"]"
        private const val ROW = "$GROUPS_PANE .zen-phone-row"
        private const val RENAME_ROW = "[data-testid=\"overview-group-rename\"]"
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
        /** The group's card stands within the grid's viewport, its header row whole. */
        private const val CARD_IN_VIEW = "(function(){var c=document.querySelector('$GROUP_CARD'),g=document.querySelector('$GRID');if(!c||!g)return false;" +
            "var cr=c.getBoundingClientRect(),gr=g.getBoundingClientRect();return !c.hasAttribute('data-collapsed')&&cr.top>=gr.top-1&&cr.top+44<=gr.bottom+1})()"
    }
}
