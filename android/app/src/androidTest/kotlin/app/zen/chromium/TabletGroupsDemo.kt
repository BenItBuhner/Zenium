package app.zen.chromium

import android.graphics.PointF
import android.graphics.RectF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the TABLET side of tab groups (TABLET-04 the sidebar's group rows with their fold and
 * their hold menu, TAB-16's saved group on the sidebar; design language v2 §9.36 as amended,
 * §11.4) on the `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`, the tablet layout demo's recipe), every press a real touch and
 * every outcome read off the chrome's DOM or the core's state:
 *
 *  1. the row's anatomy in the docked sidebar: a full-width 44 row like Zen's folder – the 10
 *     px dot of the group's colour in the glyph slot, the name at 14, the count "2" as the 13
 *     aside, the chevron on the close column – its two tabs indented 24 beneath it, in order,
 *     the loose tabs after;
 *  2. a touch on the row folds the group (the block's height on `SPRING_GENTLE`, traced:
 *     `tablet-group-fold`): the rows go, the chevron turns, the count stays, the loose rows
 *     below glide up;
 *  3. a second touch unfolds it (traced: `tablet-group-unfold`): the rows come back, the loose
 *     rows return to where they were;
 *  4. a hold on the row: the group's menu as a §9.36 popover at the finger – Rename Group…,
 *     Colour, New Tab in Group, Collapse Group, then Ungroup, Close Group (2 Tabs) in the plain
 *     ink and Delete Group in the danger ink – 332 wide with 44 rows;
 *  5. Colour cascades into the nine radio rows, Blue checked; a touch on Green recolours the
 *     group at once and closes the menu, the dot following;
 *  6. Rename Group… puts the field in the name's slot; typing and Enter rename the group;
 *  7. Close Group (2 Tabs): the tabs close (no toast: the sidebar's closes carry none), the row
 *     stays as the SAVED group – the ring in the glyph slot, the count of the pages it keeps, no
 *     chevron – the core keeping the two pages in order;
 *  8. a touch on the saved row opens it: the pages come back as the group's tabs, in order, and
 *     the row is the open group's again;
 *  9. Ungroup: the group's record goes, its tabs stay where they were, loose.
 *
 * Findings in `tablet-groups-findings.txt`, stills `tablet-groups-NN-<state>.png`, the traced
 * scenes in `frames.jsonl`. Driven by `android-tab-groups-demo.yml`'s tablet act. See
 * [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabletGroupsDemo : GroupsDemoBase("tablet-groups", "tablet-groups-demo") {
    override val tag = "TabletGroupsDemo"
    override val findingsFile = "tablet-groups-findings.txt"
    override val title = "Zenium Android tablet sidebar: the tab group's row, its fold and its menu"

    /** The group's members: the seeded tabs until Open Group makes new tabs of the kept pages (act 8). */
    private var alphaId = ALPHA
    private var betaId = BETA

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        ensureForeground()
        head()
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}, viewport ${viewportText()}")
        check("the sidebar is docked expanded at 1280 wide", awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000), "data-sidebar ${sidebarMode()}")
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu off camera (the emulator compiles and lays
        // it out slowly the first time): the app menu, opened and closed by the system back.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_500)
        finding("warm-up done: ${describeSpace()}, sidebar ${sidebarMode()}")
    }

    override fun demo() {
        anatomy()
        fold()
        unfold()
        holdMenu()
        colour()
        rename()
        closeToSaved()
        openSaved()
        ungroup()
        still("end")
        tail()
    }

    // --- 1. the row --------------------------------------------------------------------------------

    private fun anatomy() {
        section("1. The group's row in the docked sidebar (§9.36 as amended)")
        val row = steadyRect { domRect(GROUP_ROW) }
        val home = domRect(row(HOME))
        check("the group is a row of the sidebar", row != null, "row $row")
        check("the row is 44 tall", row?.let { abs(it.height() - 44) <= 1 } == true, "height ${row?.height()}")
        check("the row runs the sidebar's full width, on the tab rows' edges", row != null && home != null && abs(row.left - home.left) <= 1 && abs(row.width() - home.width()) <= 1, "row $row, Home's row $home")
        check("the glyph slot holds a dot of the group's colour (the ${chromeScheme()} set)", inDom("$GLYPH:not([data-saved]) .zen-group-row-dot") && dotColour() == blueRgb(), "dot ${dotColour()}, expected ${blueRgb()}")
        check("the name reads Research at 14", textOf(NAME) == "Research" && abs(fontSize(NAME) - 14.0) < 0.5, "name '${textOf(NAME)}' at ${fontSize(NAME)}")
        check("the count reads 2 as the 13 aside", textOf(COUNT) == "2" && abs(fontSize(COUNT) - 13.0) < 0.5, "count '${textOf(COUNT)}' at ${fontSize(COUNT)}")
        check("the chevron points down on the open group", inDom("$GROUP_ROW svg.zen-group-row-chevron") && attrOf(GROUP_ROW, "aria-expanded") == "true", "expanded '${attrOf(GROUP_ROW, "aria-expanded")}'")
        check("the row is described as a tab group of two tabs", attrOf(GROUP_ROW, "aria-description") == "Tab group, 2 tabs", "'${attrOf(GROUP_ROW, "aria-description")}'")
        val alpha = domRect(row(ALPHA))
        val beta = domRect(row(BETA))
        val gamma = domRect(row(GAMMA))
        check(
            "Alpha and Beta stand under the row in order, Gamma after them",
            row != null && alpha != null && beta != null && gamma != null && row.bottom <= alpha.top + 1 && alpha.bottom <= beta.top + 1 && beta.bottom <= gamma.top + 1,
            "row ${row?.bottom}, alpha ${alpha?.top}, beta ${beta?.top}, gamma ${gamma?.top}"
        )
        check("the group's rows are indented 24 under the row", alpha != null && home != null && abs(alpha.left - (home.left + 24)) <= 1 && beta != null && abs(beta.left - (home.left + 24)) <= 1, "alpha ${alpha?.left}, Home ${home?.left}")
        SystemClock.sleep(800)
        still("row")
    }

    // --- 2 and 3. the fold and the unfold -----------------------------------------------------------

    private fun fold() {
        section("2. A touch on the row folds the group (the block's height spring, traced)")
        val gammaBefore = domRect(row(GAMMA))
        foldByTouch("tablet-group-fold")
        check("the touch folds the group in the core", awaitCore { folderCollapsed(it) }, "collapsed ${folderCollapsed()}")
        check("the spring rests and the clip lifts", awaitJs("!document.querySelector('$SIDEBAR .zen-group-fold[data-folding]')", true, 4_000), "folding ${inDom("$SIDEBAR .zen-group-fold[data-folding]")}")
        check("the group's rows are gone once it rests", awaitDomGone(row(ALPHA), 3_000) && !inDom(row(BETA)), "alpha ${inDom(row(ALPHA))}, beta ${inDom(row(BETA))}")
        check("the chevron turns and the row reads collapsed", attrOf(GROUP_ROW, "aria-expanded") == "false" && inDom("$GROUP_ROW svg.zen-group-row-chevron"), "expanded '${attrOf(GROUP_ROW, "aria-expanded")}'")
        check("the count stays on the folded row", textOf(COUNT) == "2", "count '${textOf(COUNT)}'")
        val gammaAfter = domRect(row(GAMMA))
        check("the loose rows below glide up by the two rows", gammaBefore != null && gammaAfter != null && gammaBefore.top - gammaAfter.top >= 2 * 44 - 2, "Gamma ${gammaBefore?.top} -> ${gammaAfter?.top}")
        SystemClock.sleep(800)
        still("folded")
    }

    private fun unfold() {
        section("3. A second touch unfolds it (traced)")
        val gammaFolded = domRect(row(GAMMA))
        foldByTouch("tablet-group-unfold")
        check("the touch unfolds the group in the core", awaitCore { !folderCollapsed(it) }, "collapsed ${folderCollapsed()}")
        check("the rows come back under the row", awaitDom(row(ALPHA), 3_000) && awaitDom(row(BETA), 1_000), "alpha ${inDom(row(ALPHA))}, beta ${inDom(row(BETA))}")
        awaitJs("!document.querySelector('$SIDEBAR .zen-group-fold[data-folding]')", true, 4_000)
        val gammaOpen = domRect(row(GAMMA))
        check("the loose rows return to where they were", gammaFolded != null && gammaOpen != null && gammaOpen.top - gammaFolded.top >= 2 * 44 - 2, "Gamma ${gammaFolded?.top} -> ${gammaOpen?.top}")
        check("the chevron points down again", attrOf(GROUP_ROW, "aria-expanded") == "true", "expanded '${attrOf(GROUP_ROW, "aria-expanded")}'")
        SystemClock.sleep(800)
        still("unfolded")
    }

    /** One touch on the row inside a traced block that holds the spring's flight, nothing else. */
    private fun foldByTouch(scene: String) {
        val box = steadyRect { domRect(GROUP_ROW) }
        val target = screen(box)?.let { touchPoint(it) }
        if (target == null) {
            check("the group's row is on screen to touch", false, "row $box")
            return
        }
        finding("  touch at ${target.x.roundToInt()},${target.y.roundToInt()} on the group's row (traced: $scene)")
        traceFrames(scene, JankBudget.Kind.SPRING) {
            val f = Finger()
            f.down(target.x, target.y)
            f.hold(TAP_HOLD_MS)
            f.up()
            SystemClock.sleep(FOLD_MS)
        }
    }

    // --- 4. the hold's menu ------------------------------------------------------------------------

    private fun holdMenu() {
        section("4. A hold on the row: the group's menu as a popover at the finger")
        val at = openGroupMenu() ?: return
        val items = menuItems()
        check(
            "the menu lists Rename Group…, Colour, New Tab in Group, Collapse Group, Ungroup, Close Group (2 Tabs), Delete Group",
            items == listOf("Rename Group…", "Colour", "New Tab in Group", "Collapse Group", "Ungroup", "Close Group (2 Tabs)", "Delete Group"),
            "items $items"
        )
        val menu = domRect(MENU)
        check("the menu is 332 wide with 44 rows", menu != null && abs(menu.width() - 332) <= 1 && jsBoolean("[...document.querySelectorAll('$MENU_ITEM')].every(function(r){return Math.abs(r.getBoundingClientRect().height-44)<=1})"), "menu $menu")
        check("the menu hangs from the finger", menu != null && abs(menu.left - at.x) <= 40 && menu.top >= at.y - 4 && menu.top - at.y <= 40, "menu $menu, hold $at")
        check("Close Group takes the plain ink, Delete Group the danger ink", !hasDanger("Close Group") && hasDanger("Delete Group"), "close ${hasDanger("Close Group")}, delete ${hasDanger("Delete Group")}")
        check("Colour is a submenu row", jsBoolean("(function(){var e=${itemJs("Colour")};return !!e&&e.getAttribute('aria-haspopup')==='menu'})()"), "")
        SystemClock.sleep(1_000)
        still("group-menu")
    }

    // --- 5. the colour -----------------------------------------------------------------------------

    private fun colour() {
        section("5. Colour cascades into the swatches; Green recolours the group")
        val cascaded = touchUntil("Colour", { menuRow("Colour") }, { inDom(RADIO) }, waitMs = 3_000)
        check("Colour opens its cascade beside the menu", cascaded && jsNumber("document.querySelectorAll('$MENU').length") >= 2.0, "panels ${jsText("document.querySelectorAll('$MENU').length")}")
        val radios = jsArray("Array.prototype.map.call(document.querySelectorAll('$RADIO'),function(b){return b.textContent.trim()+(b.getAttribute('aria-checked')==='true'?'*':'')})").strings()
        check("nine colours as radio rows, Blue checked", radios.size == 9 && radios.count { it.endsWith("*") } == 1 && "Blue*" in radios, "radios $radios")
        SystemClock.sleep(1_000)
        still("colour-cascade")
        val recoloured = touchUntil("Green", { textRect(RADIO, "Green") }, { folderColor() == "green" }, waitMs = 3_000)
        check("a touch on Green recolours the group at once", recoloured, "colour ${folderColor()}")
        check("picking a colour closes the menu", awaitJs(MENU_OPEN, false, 3_000), "menu ${jsText(MENU_OPEN)}")
        check("the row's dot follows the colour", awaitJs("(function(){var d=document.querySelector('$GLYPH .zen-group-row-dot');return !!d&&getComputedStyle(d).backgroundColor==='${greenRgb()}'})()", true, 3_000), "dot ${dotColour()}, expected ${greenRgb()}")
        SystemClock.sleep(800)
        still("recoloured")
    }

    // --- 6. rename ---------------------------------------------------------------------------------

    private fun rename() {
        section("6. Rename Group…: the field in the name's slot, typed into")
        openGroupMenu() ?: return
        val editing = touchUntil("Rename Group…", { menuRow("Rename Group") }, { inDom(RENAME_FIELD) }, waitMs = 3_000)
        check("Rename Group… puts the field in the name's slot", editing, "field ${inDom(RENAME_FIELD)}")
        check("the field has the focus", awaitJs("(function(){var i=document.querySelector('$RENAME_FIELD');return !!i&&document.activeElement===i})()"), "active ${jsText("document.activeElement&&document.activeElement.tagName")}")
        check("the field is at the name's 14", abs(fontSize(RENAME_FIELD) - 14.0) < 0.5, "at ${fontSize(RENAME_FIELD)}")
        SystemClock.sleep(800)
        still("rename-field")
        typeAndEnter("Reading")
        check("Enter saves the new name in the core", awaitCore { folderName(it) == "Reading" }, "name ${folderName()}")
        check("the field leaves and the row reads the new name", awaitDomGone(RENAME_FIELD) && awaitJs("(document.querySelector('$NAME')||{}).textContent==='Reading'"), "name '${textOf(NAME)}'")
        if (imeShown()) {
            back()
            awaitIme(false)
        }
        SystemClock.sleep(600)
        still("renamed")
    }

    // --- 7. Close Group -> saved -----------------------------------------------------------------

    private fun closeToSaved() {
        section("7. Close Group (2 Tabs): the tabs close, the row stays as the saved group")
        openGroupMenu() ?: return
        check("the menu's Close Group counts two", menuRow("Close Group (2 Tabs)") != null, "items ${menuItems()}")
        val closed = touchUntil("Close Group (2 Tabs)", { menuRow("Close Group (2 Tabs)") }, { !tabExists(ALPHA) && !tabExists(BETA) }, waitMs = 8_000)
        check("the group's tabs close", closed, "alpha ${tabExists(ALPHA)}, beta ${tabExists(BETA)}")
        // The sidebar's closes run through the core with no Undo toast (the tab row's close and
        // the tab menu's Close Tab are the same): the tabs are on the recently closed list, the
        // group keeps their pages. The phone's overview is where the toast lives.
        check("no toast: the sidebar's closes carry none, as the tab row's", !inDom(TOAST), "toast '${textOf("$TOAST .zen-message-text")}'")
        check("the core keeps the group SAVED with its two pages in order", awaitCore { savedUrls(it) == listOf(ALPHA_URL, BETA_URL) }, "saved ${savedUrls().map { it.removePrefix(ORIGIN) }}")
        check("the row stays, as the saved group", awaitJs("!!document.querySelector('$GROUP_ROW[data-saved]')", true, 4_000), "saved '${attrOf(GROUP_ROW, "data-saved")}'")
        check("the glyph slot holds the ring", inDom("$GLYPH[data-saved] .zen-group-row-dot") && jsBoolean("(function(){var d=document.querySelector('$GLYPH .zen-group-row-dot');return !!d&&getComputedStyle(d).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(d).boxShadow.indexOf('inset')>=0})()"), "dot ${dotColour()}")
        check("the count reads the two pages it keeps", textOf(COUNT) == "2", "count '${textOf(COUNT)}'")
        check("nothing to fold: no chevron, no expanded state", !inDom("$GROUP_ROW svg.zen-group-row-chevron") && inDom("$GROUP_ROW span.zen-group-row-chevron") && attrOf(GROUP_ROW, "aria-expanded") == "", "expanded '${attrOf(GROUP_ROW, "aria-expanded")}'")
        check("the row is described as a saved tab group", attrOf(GROUP_ROW, "aria-description") == "Tab group, saved, 2 tabs", "'${attrOf(GROUP_ROW, "aria-description")}'")
        check("no member rows under it", !inDom(row(ALPHA)) && !inDom(row(BETA)), "")
        SystemClock.sleep(1_000)
        still("saved-row")
    }

    // --- 8. open the saved group -------------------------------------------------------------------

    private fun openSaved() {
        section("8. A touch on the saved row opens the group: its pages come back as its tabs")
        val opened = touchUntil("the saved group's row", { domRect(GROUP_ROW) }, { groupTabs().size == 2 }, waitMs = 12_000)
        check("the touch brings two tabs back into the group", opened, "group ${groupTabs()}")
        check("in their order: Alpha, Beta", groupTabs().map { it.second } == listOf(ALPHA_URL, BETA_URL), "urls ${groupTabs().map { it.second.removePrefix(ORIGIN) }}")
        check("the kept pages are gone from the record (the group is open again)", awaitCore { savedUrls(it).isEmpty() }, "saved ${savedUrls()}")
        check("the row is the open group's again", awaitJs("(function(){var r=document.querySelector('$GROUP_ROW');return !!r&&!r.hasAttribute('data-saved')&&r.getAttribute('aria-expanded')==='true'})()", true, 4_000), "saved '${attrOf(GROUP_ROW, "data-saved")}', expanded '${attrOf(GROUP_ROW, "aria-expanded")}'")
        // The pages came back as new tabs: the rows and the claims from here on go by them.
        alphaId = tabIdAt(ALPHA_URL) ?: alphaId
        betaId = tabIdAt(BETA_URL) ?: betaId
        finding("  (the kept pages are tabs again: Alpha $alphaId, Beta $betaId)")
        check("the rows stand under it again", awaitDom(row(alphaId), 4_000) && awaitDom(row(betaId), 1_000), "alpha ${inDom(row(alphaId))}, beta ${inDom(row(betaId))}")
        check("the dot is back, in the group's colour", dotColour() == greenRgb(), "dot ${dotColour()}, expected ${greenRgb()}")
        SystemClock.sleep(1_500)
        still("reopened")
    }

    // --- 9. Ungroup --------------------------------------------------------------------------------

    private fun ungroup() {
        section("9. Ungroup: the record goes, the tabs stay, loose")
        openGroupMenu() ?: return
        val before = trackOrder().map { it.first }
        val ungrouped = touchUntil("Ungroup", { menuRow("Ungroup") }, { folder() == null }, waitMs = 6_000)
        check("Ungroup removes the group's record", ungrouped, "folder ${folder()}")
        check("its tabs stay, loose, where they were", tabExists(alphaId) && tabExists(betaId) && folderOf(alphaId) == null && folderOf(betaId) == null && trackOrder().map { it.first } == before, "order ${trackOrder()}")
        check("the row leaves the sidebar, the tabs' rows staying", awaitDomGone(GROUP_ROW, 4_000) && inDom(row(alphaId)) && inDom(row(betaId)), "row ${inDom(GROUP_ROW)}, alpha ${inDom(row(alphaId))}, beta ${inDom(row(betaId))}")
        val alpha = domRect(row(alphaId))
        val home = domRect(row(HOME))
        check("the tabs' rows lose the indent", alpha != null && home != null && abs(alpha.left - home.left) <= 1, "alpha ${alpha?.left}, Home ${home?.left}")
        SystemClock.sleep(1_000)
        still("ungrouped")
    }

    // --- the menu ----------------------------------------------------------------------------------

    /** Hold the group's row until its menu is up; where the finger was, as CSS px, or null (and a failed claim). */
    private fun openGroupMenu(): PointF? {
        for (attempt in 1..3) {
            val box = steadyRect { domRect(GROUP_ROW) } ?: break
            val at = hold(box, "the group's row") ?: break
            if (awaitJs(MENU_OPEN, true, 3_000) && awaitDom(MENU_ITEM, 3_000)) {
                SystemClock.sleep(600)
                return at
            }
            finding("  (the hold did not bring the menu, attempt $attempt)")
            if (inDom(MENU)) back()
            SystemClock.sleep(600)
        }
        check("a hold on the group's row brings its menu", false, "menu ${jsText(MENU_OPEN)}")
        return null
    }

    private fun menuItems(): List<String> = textsOf(MENU_ITEM)

    private fun menuRow(prefix: String): RectF? = textRect(MENU_ITEM, prefix)

    private fun itemJs(prefix: String): String =
        "Array.prototype.find.call(document.querySelectorAll('$MENU_ITEM'),function(n){return n.textContent.trim().indexOf(${JSONObject.quote(prefix)})===0})"

    private fun hasDanger(prefix: String): Boolean = jsBoolean("(function(){var e=${itemJs(prefix)};return !!e&&e.hasAttribute('data-danger')})()")

    // --- the chrome's state -------------------------------------------------------------------------

    private fun sidebarMode(): String = jsText("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar")

    private fun viewportText(): String = jsText("(function(){var v=window.__zenStores.viewport.get();return v.width+'x'+v.height+' '+v.formFactor+(v.coarse?' coarse':'')})()")

    private fun dotColour(): String = jsText("(function(){var d=document.querySelector('$GLYPH .zen-group-row-dot');return d?getComputedStyle(d).backgroundColor:''})()")

    private fun fontSize(selector: String): Double = jsNumber("parseFloat(getComputedStyle(document.querySelector(${JSONObject.quote(selector)})||document.body).fontSize)")

    private companion object {
        /** How long the gentle spring is given inside its traced block (it lands well within). */
        private const val FOLD_MS = 1_400L
        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val GROUP_ROW = "$SIDEBAR .zen-group-row[data-tab-folder=\"$FOLDER\"]"
        private const val GLYPH = "$GROUP_ROW [data-testid=\"group-row-glyph\"]"
        private const val NAME = "$GROUP_ROW [data-testid=\"group-row-name\"]"
        private const val COUNT = "$GROUP_ROW [data-testid=\"group-row-count\"]"
        private const val RENAME_FIELD = "$GROUP_ROW input"
        private const val MENU = ".zen-v2-menu"
        private const val MENU_ITEM = ".zen-v2-menu-item"
        private const val RADIO = ".zen-v2-menu [role=\"menuitemradio\"]"

        private fun row(tabId: String) = "$SIDEBAR [data-tab-id=\"$tabId\"]"
    }
}
