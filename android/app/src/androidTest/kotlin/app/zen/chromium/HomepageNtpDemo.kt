package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The homepage and the new tab page's edits on a device (W4-8), each under a finger:
 *
 *  1. SET-36 / NTP-30 in Settings › Look and Feel › Home: the Homepage value row reads
 *     "Homepage, New tab page"; a finger on it opens the §9.13 picker (Off, New tab page,
 *     Specific page); a finger on Specific page sets the row and reveals the Address row and
 *     Use current page; a finger on Use current page writes the page Settings was opened from
 *     (the site the demo starts on); a finger on the Address row opens the §9.12 URL sheet,
 *     the address typed on the keyboard and a finger on Save writes it (`settings.homepage`).
 *  2. NTP-30's Home actions: the app menu's Home row and the bar's optional Home item each load
 *     the homepage on the active tab (`tab.home`); with the homepage Off the row and the item
 *     leave the menu and the bar, and come back with it.
 *  3. NTP-29 the new tab page for the bottom bar: with `phoneBarPosition` bottom (the default)
 *     the page from the bar's plus has its field low, within thumb reach, the shortcuts above it
 *     and the gear in the top corner; a finger on the field morphs it into the omnibox above the
 *     keyboard (#243's morph, its origin the relocated field); the dock flipped to top through
 *     the core lays the page out as it was (the field high, the gear low), and back.
 *  4. NTP-06 a tile's hold menu: a hold on a pinned tile lifts its menu with Edit Shortcut…, Unpin
 *     Shortcut and Remove; Edit opens the shortcut's form sheet (Name, URL, Save | Cancel), the
 *     name retyped and a finger on Save renames the tile; Remove on another pinned tile takes it
 *     off the page and the pinned list.
 *  5. NTP-06 reorder by hold-and-drag: a pinned tile held (the lift), carried two slots along
 *     (the others gliding on one spring), and let go writes the order to the shared device list
 *     (`newtab.reorderShortcuts`); the drag is a measured scene (the jank budget, soft).
 *
 * The sites are five loopback hosts served from this process ([DemoServer], one per 127.0.0.n);
 * four of them are pinned in the warm-up through the core (`newtab.addShortcut`) and the fifth
 * is visited so the grid has a most visited tile beside the pins. Every claim is a line in
 * `homepage-ntp-findings.txt` next to the recording and a failed one fails the run; the
 * recording goes on to the end either way. Profile `newtab-demo-state.json` (one tab on the
 * first site, HTTPS-only off for the plain loopback servers), the bar given its optional Home
 * item so the item's claim has something to press. The tree on this image trails the screen by
 * seconds after a transition, so a finger that waits on it only waits so long and then lands on
 * the DOM's box for the same control (the harness's `touchControl`); which aim was used is a
 * finding, and every claim is read off what followed the touch.
 */
@RunWith(AndroidJUnit4::class)
class HomepageNtpDemo : DemoHarness("newtab-demo-state.json", "android-homepage-ntp", "homepage-ntp-demo") {
    override val tag = "HomepageNtpDemo"
    private val servers = ArrayList<DemoServer>()
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0
    private lateinit var demoTabId: String

    /** A site: a loopback host, the page's title (the tile's caption is its first word) and an icon colour. */
    private class Site(val n: Int, val title: String, val color: Int) {
        val address get() = "127.0.0.$n"
        val url get() = "http://$address:$PORT/"
        val caption get() = title.substringBefore(" - ")
    }

    private val sites = listOf(
        Site(1, "Orchard - Fresh fruit, delivered", 0xFF2E7D32.toInt()),
        Site(2, "Tides - Coastal weather", 0xFF0277BD.toInt()),
        Site(3, "Atlas - Maps for walkers", 0xFFEF6C00.toInt()),
        Site(4, "Ledger - Personal finance", 0xFF5E35B1.toInt()),
        Site(5, "Foundry - Type design", 0xFFC62828.toInt())
    )

    /** The pinned four (the fifth is the most visited tile beside them). */
    private val pinned get() = sites.take(4)
    private val visited get() = sites[4]
    /** The homepage the sequence sets: the second site, so the first can be "the current page". */
    private val homepageSite get() = sites[1]

    @Test
    fun record() {
        for (site in sites) {
            servers += DemoServer(
                PORT,
                mapOf(
                    "/" to ("text/html; charset=utf-8" to pageHtml(site).toByteArray()),
                    "/icon.png" to ("image/png" to iconPng(site))
                ),
                site.address
            ).also { it.start() }
        }
        try {
            runDemo()
        } finally {
            servers.forEach { it.close() }
        }
        if (failures.isNotEmpty()) error("${failures.size} claim(s) did not hold: ${failures.joinToString("; ")}")
    }

    /**
     * The seeded tab points at this driver's servers, and the bar carries its optional Home item
     * (`phoneBar`, the bar editor's layout) so scene 2 has the item to press. The homepage
     * setting itself is left to its default – the new tab page – which scene 1 changes on camera.
     */
    override fun patchState(json: String): String {
        val state = JSONObject(json.replace("127.0.0.1:18131", "127.0.0.1:$PORT"))
        val settings = state.getJSONObject("settings")
        settings.put(
            "phoneBar",
            JSONObject().put("left", JSONArray(listOf("back", "home"))).put("right", JSONArray(listOf("new-tab", "tabs", "menu")))
        )
        return state.toString()
    }

    // --- warm-up ---------------------------------------------------------------------------------

    /**
     * Off camera: pin the four sites through the core, visit the fifth (and the first, so the
     * demo ends its warm-up where it starts), pay for the Settings chunk, the menu and the first
     * new tab page's layout, and calibrate the DOM's boxes against the tree.
     */
    override fun warmUp() {
        findings = File(out, "homepage-ntp-findings.txt")
        findings.writeText("Zenium Android homepage + new tab page checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        for (server in servers) finding("demo server: ${server.selfCheck()}")
        demoTabId = activeCoreTab()?.optString("id").orEmpty()
        finding("start: ${describeActive()}; homepage ${homepage()}; bar position ${barPosition()}; bar ${coreState().getJSONObject("settings").optJSONObject("phoneBar")}")

        for (site in pinned) {
            val id = coreInvoke("newtab.addShortcut", JSONObject().put("title", site.caption).put("url", site.url).toString())
            finding("  pinned ${site.caption} -> ${site.url} (id $id)")
        }
        visit(visited)
        visit(sites[0])
        finding("pins ${pinTitles()}; history.topSites ${summarise(coreInvoke("history.topSites", "{\"n\":8}"))}")

        // The Settings page is a chunk of its own that loads on its first open: pay for it off camera.
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(1_200)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_000)
        // The first new tab page pays for its layout: open and close one off camera.
        if (tapLabel(Finger(), NEW_TAB_LABEL)) {
            SystemClock.sleep(2_500)
            val fresh = activeCoreTab()
            if (fresh != null && fresh.optString("url") == BLANK_URL) {
                awaitTile(sites[0].caption, 6_000)
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(fresh.optString("id"))}}")
                SystemClock.sleep(1_500)
            }
        }
        ensureActive(demoTabId)
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        calibrateDomBoxes()
        finding("warm-up done: ${describeActive()}; Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
    }

    /** A loopback page loads in well under a second; a visit that does not is noted, not waited out. */
    private fun visit(site: Site) {
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(demoTabId)},\"input\":${JSONObject.quote(site.url)}}")
        if (!awaitLoaded(site.url, 8_000)) finding("  visit of ${site.url} never finished: ${describeActive()}")
        SystemClock.sleep(600)
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        still("page")
        homepageInSettings()
        homeFromTheMenuAndTheBar()
        newTabPageForTheBottomBar()
        editAndRemoveAShortcut()
        reorderByDrag()
        finding("\nend: ${describeActive()}; ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    // --- 1. the homepage in Settings (SET-36 / NTP-30) -------------------------------------------

    private fun homepageInSettings() {
        step("1. The homepage in Settings › Look and Feel › Home: the value row, the picker, Use current page, the URL sheet") {
            if (!openMenuItem("Settings")) error("the app menu has no 'Settings'")
            if (!awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 10_000)) error("the Settings tab did not open from the menu")
            SystemClock.sleep(1_000)
            val touched = touchControl("Look and Feel", LOOK_AND_FEEL_JS, prefix = true)
            val section = touched && awaitChrome("!!document.querySelector('$DRILL_IN [data-row=\"$HOMEPAGE_ROW\"]')", 8_000)
            finding("  Look and Feel touched $touched; its section with the Homepage row: ${verdict(section)}")
            if (!section) error("Look and Feel did not open under a finger")
            // The Home group is the section's last: bring the row up into the touchable window.
            scrollRowIntoView(HOMEPAGE_ROW)
            val named = awaitFresh(12_000, "the Homepage row") { it == "Homepage, New tab page" }
            expect("the Homepage row reads 'Homepage, New tab page' (DOM '${rowLabel(HOMEPAGE_ROW)}')", named != null || rowLabel(HOMEPAGE_ROW) == "Homepage, New tab page", "homepage-row-name")
            still("homepage-row")

            // A finger on the row: the §9.13 picker, its three options.
            val rowTouched = touchControl("Homepage", HOMEPAGE_ROW_JS, prefix = true)
            val pickerUp = rowTouched && awaitChrome("document.querySelectorAll('$PICKER_OPTION').length===3", 8_000)
            val rested = pickerUp && awaitSheetAtRest(6_000)
            finding("  the Homepage row touched $rowTouched; the picker up ${verdict(pickerUp)} (${pickerOptions()}), at rest ${verdict(rested)}")
            if (!rested) {
                if (rowTouched) touchFault("a finger on the Homepage row did not open its picker")
                error("the Homepage picker did not open under a finger")
            }
            still("homepage-picker")
            val picked = touchControlExpecting("Specific page", SPECIFIC_PAGE_JS, "the row reads 'Homepage, Specific page' with the picker closed", timeoutMs = 8_000, prefix = true) {
                rowLabel(HOMEPAGE_ROW) == "Homepage, Specific page" && chromeValue("String(!!document.querySelector('$PICKER_OPTION'))") == "false"
            }
            expect("a finger on 'Specific page' sets the row (core homepage ${homepage()})", picked && homepageMode() == "url", "homepage-picked")
            val revealed = awaitChrome("!!document.querySelector('$ADDRESS_ROW_SELECTOR')&&!!document.querySelector('[data-row=\"$USE_CURRENT_ROW\"]')", 6_000)
            expect("Specific page reveals the Address row and Use current page", revealed, "homepage-url-rows")
            scrollRowIntoView(USE_CURRENT_ROW)
            expect("the Address row reads 'Not set' before an address is ('${rowDescription(ADDRESS_ROW)}')", rowDescription(ADDRESS_ROW) == "Not set", "address-row-not-set")
            still("homepage-url-rows")

            // Use current page: the page Settings was opened from, the demo's site.
            val used = touchControlExpecting("Use current page", USE_CURRENT_JS, "the homepage is the site Settings was opened from", timeoutMs = 6_000, prefix = true) {
                homepageUrl() == sites[0].url
            }
            expect("a finger on 'Use current page' writes ${sites[0].url} (core homepage ${homepage()})", used, "homepage-use-current")
            val current = awaitRowDescription(ADDRESS_ROW, "${sites[0].address}:$PORT", 5_000)
            expect("the Address row reads the page without its scheme ('${rowDescription(ADDRESS_ROW)}')", current, "address-row-current")

            // The §9.12 URL sheet: the Address row, the address typed, Save. The row is aimed at
            // through the DOM: its name shares its first word with the bar's pill ("Address, …").
            val addressTouched = touchDom("the Address row", ADDRESS_ROW_JS)
            val sheetUp = addressTouched && awaitChrome("!!document.querySelector('$ADDRESS_INPUT')", 8_000) && awaitSheetAtRest(6_000)
            finding("  the Address row touched $addressTouched; the URL sheet up ${verdict(sheetUp)}; the field's inputmode '${chromeValue("(document.querySelector('$ADDRESS_INPUT')||{}).inputMode||''")}'")
            if (!sheetUp) {
                if (addressTouched) touchFault("a finger on the Address row did not open its URL sheet")
                error("the Address sheet did not open under a finger")
            }
            still("homepage-url-sheet")
            val input = domBox("document.querySelector('$ADDRESS_INPUT')") ?: error("the URL sheet's field has no box")
            val at = touchPoint(input) ?: error("the URL sheet's field lies outside the touchable window ($input)")
            Finger().tap(at.x, at.y)
            val keyboard = awaitIme(shown = true, timeoutMs = 8_000)
            SystemClock.sleep(600)
            val typed = retype(ADDRESS_INPUT, homepageSite.url)
            finding("  keyboard ${if (keyboard) "up (inset ${imeInset()} px)" else "DOWN"}; the field reads '$typed' after the typing")
            expect("the address typed reads ${homepageSite.url}", typed == homepageSite.url, "address-typed")
            still("homepage-url-typed")
            // The keyboard goes first (its back is the IME's own), so Save is in the finger's reach.
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 5_000)
                SystemClock.sleep(800)
            }
            val saved = touchControlExpecting("Save", SAVE_JS, "the homepage is ${homepageSite.url} with the sheet closed", timeoutMs = 8_000) {
                homepageUrl() == homepageSite.url && chromeValue("String(!!document.querySelector('$ADDRESS_INPUT'))") == "false"
            }
            expect("a finger on Save writes the typed address (core homepage ${homepage()})", saved, "address-saved")
            val set = awaitRowDescription(ADDRESS_ROW, "${homepageSite.address}:$PORT", 5_000)
            expect("the Address row reads the new page ('${rowDescription(ADDRESS_ROW)}')", set, "address-row-set")
            SystemClock.sleep(600)
            still("homepage-url-set")
            closeSettingsTab()
            awaitLoaded(sites[0].url, 8_000)
        }
    }

    // --- 2. Home from the menu and the bar (NTP-30) ----------------------------------------------

    private fun homeFromTheMenuAndTheBar() {
        step("2. Home: the app menu's row and the bar's item load the homepage; both leave while the homepage is Off") {
            ensureActive(demoTabId)
            expect("the demo tab is on the first site before Home (${describeActive()})", activeUrl() == sites[0].url, "home-start")
            // The menu's Home row, under a finger. The row is aimed at through the DOM: the bar's
            // Home item under the sheet carries the same name.
            tapMenuButton()
            if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) error("the menu never opened")
            SystemClock.sleep(1_200)
            val row = awaitChrome("!!(${menuItemJs("Home")})", 6_000)
            expect("the app menu lists a Home row with a homepage set (menu rows: ${menuRows()})", row, "menu-home-row")
            still("menu-home")
            val homed = touchDom("the menu's Home row", menuItemJs("Home")) && awaitLoaded(homepageSite.url, 10_000)
            if (!homed && activeUrl() != homepageSite.url) touchFault("a finger on the menu's Home row did not load the homepage")
            expect("a finger on the menu's Home loads the homepage (${describeActive()})", homed && activeUrl() == homepageSite.url, "menu-home")
            SystemClock.sleep(1_000)
            still("menu-home-loaded")

            // The bar's Home item: from another page, back to the homepage.
            visit(sites[2])
            val item = awaitChrome("!!document.querySelector('$BAR_HOME')", 6_000)
            expect("the bar carries its Home item (the layout's optional item) with a homepage set", item, "bar-home-item")
            val barHomed = touchControlExpecting("Home", "document.querySelector('$BAR_HOME')", "the tab loads the homepage from the bar", timeoutMs = 10_000) {
                activeUrl() == homepageSite.url
            }
            awaitLoaded(homepageSite.url, 8_000)
            expect("a finger on the bar's Home loads the homepage (${describeActive()})", barHomed && activeUrl() == homepageSite.url, "bar-home")
            SystemClock.sleep(800)
            still("bar-home-loaded")

            // Off: the row and the item leave; the setting back, they return.
            setHomepage("off", homepageSite.url)
            SystemClock.sleep(1_200)
            val itemGone = awaitChrome("!document.querySelector('$BAR_HOME')", 6_000)
            tapMenuButton()
            val menuUp = waitFor(MENU_HANDLE_LABEL, 6_000) != null
            SystemClock.sleep(1_200)
            val rowGone = menuUp && chromeValue("String(!!(${menuItemJs("Home")}))") == "false"
            finding("  homepage Off: the bar's Home item gone ${verdict(itemGone)}; the menu up $menuUp, its Home row gone ${verdict(rowGone)} (menu rows: ${menuRows()})")
            expect("with the homepage Off the bar's Home item and the menu's Home row are gone", itemGone && rowGone, "home-off")
            if (menuUp) {
                back()
                awaitSurface(up = false, timeoutMs = 5_000)
            }
            setHomepage("url", homepageSite.url)
            SystemClock.sleep(1_000)
            expect("the homepage back on, the bar's Home item is back", awaitChrome("!!document.querySelector('$BAR_HOME')", 6_000), "home-back")
            visit(sites[0])
        }
    }

    // --- 3. the new tab page for the bottom bar (NTP-29) -----------------------------------------

    private fun newTabPageForTheBottomBar() {
        step("3. The new tab page for the bottom bar: the field low, the tiles above it, the gear high; the field the morph's origin; the top dock as it was") {
            expect("the bar is at the bottom (the phone's default): '${barPosition()}'", barPosition() == "bottom", "dock-bottom-default")
            val before = tabCount()
            if (!tapLabel(Finger(), NEW_TAB_LABEL)) error("no '$NEW_TAB_LABEL' button on the bar")
            SystemClock.sleep(2_500)
            val tiles = awaitTile(sites[0].caption, 8_000) != null
            SystemClock.sleep(800)
            val dock = chromeValue("(document.querySelector('.zen-ntp')||{dataset:{}}).dataset.dock||''")
            val field = domBox(FIELD_JS)
            val grid = domBox(GRID_JS)
            val gear = domBox(GEAR_JS)
            finding("  ${describeActive()} (tabs were $before); tiles ${if (tiles) "up" else "MISSING"}; data-dock '$dock'; field $field, grid $grid, gear $gear, window ${width}x$height")
            expect("the plus opens a new tab page with the tiles (tabs ${tabCount()})", tiles && tabCount() == before + 1 && activeUrl() == BLANK_URL, "ntp-open")
            expect("the page is laid out for the bottom dock (data-dock bottom)", dock == "bottom", "ntp-dock-attribute")
            expect("the field rests low, within thumb reach (its top past 55% of the window: ${field?.top} of $height)", field != null && field.top > height * 0.55, "ntp-field-low")
            expect("the shortcuts stand above the field (grid bottom ${grid?.bottom} <= field top ${field?.top})", field != null && grid != null && grid.bottom <= field.top, "ntp-tiles-above-field")
            expect("the gear sits in the top corner (its centre ${gear?.exactCenterY()?.toInt()} in the top fifth)", gear != null && gear.exactCenterY() < height * 0.2, "ntp-gear-high")
            still("ntp-bottom-rest")

            // The field into the omnibox: #243's morph from where the field rests.
            val at = field?.let { touchPoint(it) } ?: error("the field lies outside the touchable window ($field)")
            var midMorph: Rect? = null
            measureFrames("ntp-field-morph-bottom", JankBudget.Kind.OPEN, trace = true) {
                Finger().tap(at.x, at.y)
                SystemClock.sleep(90)
                still("ntp-bottom-morph")
                midMorph = domBox(MORPH_JS)
                awaitIme(shown = true, timeoutMs = 8_000)
                SystemClock.sleep(600)
            }
            val keyboard = imeShown()
            val input = omniboxInput()
            finding("  keyboard ${if (keyboard) "up (inset ${imeInset()} px)" else "DOWN"}; omnibox input ${input ?: "MISSING"}; the morph's surface mid-way $midMorph")
            expect("a finger on the low field opens the omnibox above the keyboard", keyboard && input != null, "ntp-field-omnibox")
            still("ntp-bottom-omnibox")
            val close = closeUrlField()
            finding("  ${close.describe()}")
            expect("the omnibox closes back to the page (${describeActive()})", close.ok && activeUrl() == BLANK_URL, "ntp-omnibox-close")
            SystemClock.sleep(800)

            // The top dock: the layout it was. Through the core (the row's own action).
            setBarPosition("top")
            val top = awaitChrome("(document.querySelector('.zen-ntp')||{dataset:{}}).dataset.dock==='top'", 6_000)
            SystemClock.sleep(1_200)
            val fieldTop = domBox(FIELD_JS)
            val gridTop = domBox(GRID_JS)
            val gearTop = domBox(GEAR_JS)
            finding("  dock top: data-dock ${verdict(top)}; field $fieldTop, grid $gridTop, gear $gearTop")
            expect("at the top dock the field is high (its top before 45%: ${fieldTop?.top}) with the tiles under it (grid top ${gridTop?.top} >= field bottom ${fieldTop?.bottom})", fieldTop != null && gridTop != null && fieldTop.top < height * 0.45 && gridTop.top >= fieldTop.bottom, "ntp-top-layout")
            expect("at the top dock the gear sits low (its centre ${gearTop?.exactCenterY()?.toInt()} past 70%)", gearTop != null && gearTop.exactCenterY() > height * 0.7, "ntp-top-gear")
            still("ntp-top-rest")
            setBarPosition("bottom")
            awaitChrome("(document.querySelector('.zen-ntp')||{dataset:{}}).dataset.dock==='bottom'", 6_000)
            SystemClock.sleep(1_200)
        }
    }

    // --- 4. Edit and Remove on a tile's hold menu (NTP-06) ---------------------------------------

    private fun editAndRemoveAShortcut() {
        step("4. A pinned tile's hold menu: Edit Shortcut… opens the form sheet and Save renames the tile; Remove takes another off the page") {
            ensureNewTabPage()
            val tides = awaitTile(homepageSite.caption, 6_000) ?: error("no tile for ${homepageSite.caption}")
            Finger().apply {
                press(tides.exactCenterX(), tides.exactCenterY())
                up()
            }
            val menu = waitFor(EDIT_LABEL, 8_000) != null
            SystemClock.sleep(1_000)
            val items = listOf("Open in New Tab", "Copy Link", EDIT_LABEL, "Unpin Shortcut", "Remove").filter { findByLabel(it) != null }
            finding("  the hold menu ${if (menu) "opened" else "MISSING"}: ${items.joinToString(", ")}")
            expect("a hold on a pinned tile opens its menu with Edit Shortcut…, Unpin Shortcut and Remove", menu && items.size == 5, "tile-menu")
            still("tile-menu")
            val edit = touchTapLabelExpecting(EDIT_LABEL, "the shortcut's form sheet is up", timeoutMs = 8_000) {
                chromeValue("String(!!document.querySelector('$EDIT_DIALOG'))") == "true"
            }
            SystemClock.sleep(1_200)
            val heading = awaitFresh(6_000, "the sheet's heading") { it == "Edit shortcut" } != null
            val fields = chromeValue("String(document.querySelectorAll('$EDIT_DIALOG input').length)")
            finding("  Edit Shortcut… touched: sheet ${verdict(edit)}; heading 'Edit shortcut' in the tree $heading; $fields fields; name '${chromeValue("(document.querySelector('$EDIT_NAME')||{}).value||''")}', url '${chromeValue("(document.querySelector('$EDIT_URL')||{}).value||''")}'")
            expect("a finger on Edit Shortcut… opens the form sheet (Name, URL) for the tile", edit && fields == "2", "tile-edit-sheet")
            still("tile-edit-sheet")
            // The name retyped on the keyboard; the keyboard down so Save is in the finger's reach.
            val name = domBox("document.querySelector('$EDIT_NAME')") ?: error("the sheet's Name field has no box")
            val at = touchPoint(name) ?: error("the Name field lies outside the touchable window ($name)")
            Finger().tap(at.x, at.y)
            awaitIme(shown = true, timeoutMs = 8_000)
            SystemClock.sleep(600)
            val typed = retype(EDIT_NAME, RENAMED)
            expect("the name typed reads '$RENAMED' ('$typed')", typed == RENAMED, "tile-name-typed")
            still("tile-edit-typed")
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 5_000)
                SystemClock.sleep(800)
            }
            val saved = touchTapLabelExpecting("Save", "the pin is renamed '$RENAMED' with the sheet closed", timeoutMs = 8_000) {
                pinTitles().contains(RENAMED) && chromeValue("String(!!document.querySelector('$EDIT_DIALOG'))") == "false"
            }
            val renamedTile = awaitTile(RENAMED, 6_000) != null
            expect("a finger on Save renames the shortcut (pins ${pinTitles()}); the tile reads '$RENAMED' $renamedTile", saved && renamedTile, "tile-renamed")
            SystemClock.sleep(600)
            still("tile-renamed")

            // Remove on another pin: off the page and the pinned list.
            val ledger = sites[3]
            val tile = awaitTile(ledger.caption, 6_000) ?: error("no tile for ${ledger.caption}")
            Finger().apply {
                press(tile.exactCenterX(), tile.exactCenterY())
                up()
            }
            if (waitFor("Remove", 8_000) == null) error("no hold menu on the ${ledger.caption} tile")
            SystemClock.sleep(800)
            val removed = touchTapLabelExpecting("Remove", "the pin is gone from the list", timeoutMs = 8_000) {
                pinTitles().none { it == ledger.caption }
            }
            val gone = waitForGone(ledger.caption, 6_000)
            expect("a finger on Remove takes the ${ledger.caption} tile off the page ($gone) and the pinned list (${pinTitles()})", removed && gone, "tile-removed")
            SystemClock.sleep(800)
            still("tile-removed")
        }
    }

    // --- 5. reorder by hold-and-drag (NTP-06) ----------------------------------------------------

    private fun reorderByDrag() {
        step("5. Reorder by hold-and-drag: the first pin held, carried two slots along, let go – the order written to the device list") {
            ensureNewTabPage()
            val before = pinTitles()
            val orchard = awaitTile(sites[0].caption, 6_000) ?: error("no tile for ${sites[0].caption}")
            val atlas = awaitTile(sites[2].caption, 6_000) ?: error("no tile for ${sites[2].caption}")
            finding("  pins before: $before; ${sites[0].caption} at ${orchard.exactCenterX().toInt()},${orchard.exactCenterY().toInt()}, ${sites[2].caption} at ${atlas.exactCenterX().toInt()},${atlas.exactCenterY().toInt()}")
            var lifted = false
            var draft = ""
            measureFrames("ntp-tile-drag", JankBudget.Kind.GESTURE, trace = true) {
                Finger().apply {
                    press(orchard.exactCenterX(), orchard.exactCenterY())
                    lifted = chromeValue("String(!!document.querySelector('$HELD_TILE'))") == "true"
                    moveBy(atlas.exactCenterX() - orchard.exactCenterX(), atlas.exactCenterY() - orchard.exactCenterY(), 700)
                    hold(500)
                    draft = chromeValue(TILE_ORDER_JS)
                    still("tile-drag")
                    up()
                }
                SystemClock.sleep(1_500)
            }
            val after = pinTitles()
            val drawn = chromeValue(TILE_ORDER_JS)
            finding("  held: the tile lifted ${verdict(lifted)}; the draft mid-drag [$draft]; pins after: $after; drawn [$drawn]")
            expect("the hold lifts the tile (li[data-held])", lifted, "drag-lift")
            expect("the drag carries ${sites[0].caption} to the third slot and the drop writes the order", after == listOf(RENAMED, sites[2].caption, sites[0].caption), "drag-order")
            SystemClock.sleep(600)
            still("tile-dropped")
        }
    }

    // --- the page and the tiles ------------------------------------------------------------------

    /** The new tab page is the active tab (the sequence's pages open on it); a fresh one from the plus otherwise. */
    private fun ensureNewTabPage() {
        if (activeUrl() == BLANK_URL && awaitTile(sites[0].caption, 2_000) != null) return
        tapLabel(Finger(), NEW_TAB_LABEL)
        SystemClock.sleep(2_500)
        awaitTile(sites[0].caption, 8_000)
        SystemClock.sleep(600)
    }

    /**
     * A tile on the page: the button named after the site (not a page heading of the same
     * word, which is not clickable). The WebView reports a button's name as its description or
     * as its text depending on the version, so both are checked.
     */
    private fun tile(caption: String): Rect? =
        findNodeWhere {
            it.isClickable && (it.contentDescription?.toString() == caption || it.text?.toString() == caption)
        }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun awaitTile(caption: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            tile(caption)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /** The omnibox's text field (editable, as the pill's button of the same name is not); its bounds. */
    private fun omniboxInput(): Rect? =
        findNodeWhere { it.isEditable && (it.contentDescription?.toString() == FIELD_LABEL || it.isFocused) }
            ?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    // --- Settings --------------------------------------------------------------------------------

    /** A Settings row's own name in the DOM (`aria-label`), "" when the row is not there. */
    private fun rowLabel(id: String): String =
        chromeValue("(function(){var e=document.querySelector('[data-row=\"$id\"]');return e?(e.getAttribute('aria-label')||''):''})()")

    /**
     * A row's description line (`RowText`: a field row's value as it displays, an action row's
     * sentence), "" when the row is not there or has none. A field row has no `aria-label` of
     * its own – its name is its contents – so the value is read from the line that shows it.
     */
    private fun rowDescription(id: String): String =
        chromeValue("(function(){var e=document.querySelector('[data-row=\"$id\"] .zen-settings-description');return e?e.textContent.trim():''})()")

    private fun awaitRowDescription(id: String, text: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (rowDescription(id) == text) return true
            SystemClock.sleep(200)
        }
        return rowDescription(id) == text
    }

    private fun scrollRowIntoView(id: String) {
        chromeJs("(function(){var e=document.querySelector('[data-row=\"$id\"]');if(e)e.scrollIntoView({block:'center'})})()")
        SystemClock.sleep(900)
    }

    private fun pickerOptions(): String =
        chromeValue("Array.prototype.map.call(document.querySelectorAll('$PICKER_OPTION'),function(e){return (e.getAttribute('aria-label')||e.textContent||'').trim()}).join(' | ')")

    /** The Settings tab, whichever it is, closed through the core (the demo tab stays). */
    private fun closeSettingsTab() {
        activeCoreTab()?.optString("id")?.takeIf { it != demoTabId }?.let {
            coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(it)}}")
        }
        SystemClock.sleep(1_500)
    }

    // --- the keyboard ----------------------------------------------------------------------------

    /**
     * Replace the text of the field `selector` (focused, the keyboard up) with `text`: the field's
     * text selected through the chrome and typed over, one character's key events at a time so
     * each carries the time it is injected (the credential demo's lesson: the emulator drops late
     * keys), then read back once it holds still; a field that does not read `text` is cleared
     * key by key – the caret to the end, a delete per character – and typed over again, twice at
     * most. What the field reads at the end is returned.
     */
    private fun retype(selector: String, text: String): String {
        val read = { chromeValue("(document.querySelector('$selector')||{}).value||''") }
        for (attempt in 1..3) {
            if (attempt == 1) {
                chromeJs("(function(){var e=document.querySelector('$selector');if(e){e.focus();e.select()}})()")
                SystemClock.sleep(300)
            } else {
                key(KeyEvent.KEYCODE_MOVE_END)
                repeat(read().length + 2) { key(KeyEvent.KEYCODE_DEL) }
            }
            keys(text)
            val typed = settledValue(read)
            if (typed == text) return typed
            finding("  typed '$text' but the field reads '$typed' (attempt $attempt)")
        }
        return read()
    }

    /** One character's events at a time, so each carries the time it is injected. */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
        }
        SystemClock.sleep(200)
    }

    /** The field's value once two reads 500 ms apart agree (the keys land late on the emulator). */
    private fun settledValue(read: () -> String): String {
        var last = read()
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
            val now = read()
            if (now == last) return now
            last = now
        }
        return last
    }

    private fun key(code: Int) {
        val down = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(down, SystemClock.uptimeMillis(), action, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
            ui.injectInputEvent(event, true)
        }
        SystemClock.sleep(30)
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    private fun ensureActive(tabId: String) {
        if (activeCoreTab()?.optString("id") == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        SystemClock.sleep(1_500)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == url && !tab.optBoolean("loading", true)) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
        return false
    }

    private fun homepage(): JSONObject = coreState().getJSONObject("settings").optJSONObject("homepage") ?: JSONObject()

    private fun homepageMode(): String = homepage().optString("mode")

    private fun homepageUrl(): String = homepage().optString("url")

    private fun setHomepage(mode: String, url: String) {
        coreInvoke("settings.update", JSONObject().put("homepage", JSONObject().put("mode", mode).put("url", url)).toString())
    }

    private fun barPosition(): String = coreState().getJSONObject("settings").optString("phoneBarPosition")

    private fun setBarPosition(position: String) {
        coreInvoke("settings.update", JSONObject().put("phoneBarPosition", position).toString())
    }

    private fun pins(): JSONArray = coreState().optJSONArray("newTabShortcuts") ?: JSONArray()

    private fun pinTitles(): List<String> = pins().let { list -> (0 until list.length()).map { list.getJSONObject(it).optString("title") } }

    private fun summarise(topSites: String): String = runCatching {
        val list = JSONArray(topSites)
        (0 until list.length()).joinToString(", ") { i -> list.getJSONObject(i).optString("title").substringBefore(" - ") }
    }.getOrElse { topSites.take(120) }

    // --- the menu --------------------------------------------------------------------------------

    /**
     * The app menu's row reading `label` (`MenuSheet`: a `.zen-sheet-item` whose text is the
     * label), as a JS expression for the element. The row is aimed at through the DOM because
     * the bar's Home item under the sheet carries the same accessible name.
     */
    private fun menuItemJs(label: String): String =
        "Array.prototype.find.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()===${JSONObject.quote(label)}})"

    /** The menu's text rows in order, for a finding. */
    private fun menuRows(): String =
        chromeValue("Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()}).join(' | ')")

    // --- the chrome ------------------------------------------------------------------------------

    /**
     * A real touch on the control the DOM gives for `domJs`, without the tree – for a control
     * whose accessible name another on screen shares (the Settings Address row and the bar's
     * Address pill; the menu's Home row and the bar's Home item), where the tree's node of that
     * name may be the other one. The aim is a [noteLine]; false, nothing injected, when the DOM
     * has no such element inside the touchable window.
     */
    private fun touchDom(what: String, domJs: String): Boolean {
        val box = domBox(domJs) ?: run {
            noteLine("  $what is not in the DOM")
            return false
        }
        val point = touchPoint(box) ?: run {
            noteLine("  the DOM's box for $what ($box) lies outside the touchable window $touchable")
            return false
        }
        noteLine("  touch at ${point.x.toInt()},${point.y.toInt()} on $what at the DOM's box $box")
        Finger().tap(point.x, point.y)
        return true
    }

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a finger landing on a moving sheet catches it instead of tapping.
     */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length>=1&&" +
                "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(800)
        return rested
    }

    // --- stills, steps, findings -----------------------------------------------------------------

    private fun still(name: String) {
        shotIndex++
        shot("%02d-%s".format(shotIndex, name))
    }

    /** Run one step of the sequence; a failure inside it is a finding and a failure of the run. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
            recover()
        }
    }

    /** A claim of the sequence, on record either way; a failed one fails the run. */
    private fun expect(claim: String, held: Boolean, id: String) {
        finding("  $claim ${verdict(held)}")
        if (!held) failures += "$id: $claim"
    }

    /** After a step threw: whatever is up sent away, the keyboard down, the bar at the bottom, the homepage as scene 1 left it. */
    private fun recover() {
        if (imeShown()) {
            back()
            awaitIme(shown = false, timeoutMs = 4_000)
        }
        repeat(3) {
            if (!chromeSurfaceUp()) return@repeat
            back()
            SystemClock.sleep(1_000)
        }
        if (barPosition() != "bottom") setBarPosition("bottom")
        if (homepageMode() == "off") setHomepage("url", homepageSite.url)
        if (activeCoreTab()?.optString("url")?.startsWith("zen://settings") == true) closeSettingsTab()
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the sites -------------------------------------------------------------------------------

    private fun pageHtml(site: Site): String {
        val hex = String.format("#%06X", site.color and 0xFFFFFF)
        return "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<link rel=icon type=image/png href=/icon.png>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:$hex;color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.caption}</h1></header>" +
            "<p>${site.title.substringAfter(" - ")}. One of the five sites the demo pins or visits, so the new tab page has tiles to edit, remove and reorder.</p>" +
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
        canvas.drawText(site.caption.substring(0, 1), size / 2f, baseline, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    companion object {
        private const val PORT = 18143
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        private const val FIELD_LABEL = "Search or enter address"
        private const val EDIT_LABEL = "Edit Shortcut…"
        /** The name the Tides pin is given in scene 4 (the tile's caption, under its 18-character cap). */
        private const val RENAMED = "Tide tables"

        private const val SETTINGS_SEARCH = ".zen-settings-search-field"
        private const val DRILL_IN = ".zen-settings-drill-in"
        /** The Home group's rows (`sections.tsx`), their `data-row` on the page. */
        private const val HOMEPAGE_ROW = "homepage"
        private const val ADDRESS_ROW = "homepage-address"
        private const val USE_CURRENT_ROW = "homepage-use-current"
        private const val ADDRESS_ROW_SELECTOR = "[data-row=\"$ADDRESS_ROW\"]"
        /** A picker's option (`blocks.tsx`): the sheet's radio rows. */
        private const val PICKER_OPTION = ".zen-sheet [role=\"radio\"]"
        /** The URL sheet's field (`FieldSheet`: `settings-field-<row id>`) and its Save (`SheetActions`' primary button). */
        private const val ADDRESS_INPUT = "#settings-field-$ADDRESS_ROW"
        private const val SAVE_JS = "document.querySelector('.zen-sheet .zen-settings-sheet-actions button[data-primary]')"

        // The DOM's word on where a control is, for a finger the tree keeps waiting (`touchControl`).
        /** The Settings landing's Look and Feel row (`CategoryRow`, by the section's id). */
        private const val LOOK_AND_FEEL_JS = "document.querySelector('.zen-settings-category[data-section=\"look\"]')"
        private const val HOMEPAGE_ROW_JS = "document.querySelector('[data-row=\"$HOMEPAGE_ROW\"]')"
        private const val ADDRESS_ROW_JS = "document.querySelector('$ADDRESS_ROW_SELECTOR')"
        private const val USE_CURRENT_JS = "document.querySelector('[data-row=\"$USE_CURRENT_ROW\"]')"
        /** The picker's Specific page option (its text runs the label and the description together). */
        private const val SPECIFIC_PAGE_JS =
            "Array.prototype.find.call(document.querySelectorAll('$PICKER_OPTION'),function(e){return e.textContent.trim().indexOf('Specific page')===0})"

        /** The new tab page's parts (`NewTabPage.tsx`). */
        private const val FIELD_JS = "document.querySelector('.zen-ntp .zen-ntp-field')"
        private const val GRID_JS = "document.querySelector('.zen-ntp [aria-label=\"Most visited\"]')"
        private const val GEAR_JS = "document.querySelector('.zen-ntp [aria-label=\"Customise the new tab page\"]')"
        /** The morph's own surface while it runs (`FakeboxMorphLayer`'s `.zen-fakebox`), the field's box otherwise. */
        private const val MORPH_JS = "document.querySelector('.zen-fakebox-layer .zen-fakebox')||document.querySelector('.zen-ntp .zen-ntp-field')"
        /** The bar's Home item (`BarButton`'s `data-bar-item`; the menu's row is found by its text, [menuItemJs]). */
        private const val BAR_HOME = ".zen-phone-bar-row [data-bar-item=\"home\"]"
        /** The shortcut's form sheet (`NewTabShortcutDialog`), its two fields: the URL's carries `inputmode`. */
        private const val EDIT_DIALOG = "[data-newtab-dialog=\"edit\"]"
        private const val EDIT_NAME = "$EDIT_DIALOG input:not([inputmode=\"url\"])"
        private const val EDIT_URL = "$EDIT_DIALOG input[inputmode=\"url\"]"
        /** A held tile's cell (`tileReorder.ts`: `data-held` while the finger has it). */
        private const val HELD_TILE = "li.zen-ntp-site[data-held]"
        /** The tiles' captions in drawing order. */
        private const val TILE_ORDER_JS =
            "Array.prototype.map.call(document.querySelectorAll('li.zen-ntp-site .zen-ntp-caption'),function(e){return e.textContent}).join(',')"
    }
}
