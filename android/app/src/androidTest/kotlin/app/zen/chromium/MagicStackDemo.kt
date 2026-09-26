package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/**
 * The new tab page's Magic Stack on a device (NTP-16, W6-4), every act a finger's:
 *
 *  1. The stack under a seeded profile: a recently closed tab, a completed download whose file
 *     is on the device, two bookmarks – three cards in the stack's fixed order (Continue where
 *     you left off, Downloads, Bookmarks), and the Default browser reminder as a fourth where the
 *     host says the browser is not the default (the emulator's answer; the driver reads it and
 *     expects the count it implies). The cards are page surfaces named for TalkBack, the strip a
 *     carousel with a dot per page, each card's ⋮ the shared 44 icon button named for its module;
 *     at the bottom dock the stack stands above the shortcut tiles, each card the strip's width
 *     less the 24 the next one peeks by.
 *  2. Paging by a real swipe on the strip (a measured scene, `magic-stack-swipe`): the strip
 *     snaps to the second card and the second dot is selected; a finger on the first dot pages
 *     back.
 *  3. A card's ⋮ opens the shared local menu titled by the module, Hide This and Customise its
 *     rows; Hide This (a measured scene, `magic-stack-hide`) writes the device's hidden set,
 *     fades the card out over 120 ms and glides the cards after it into the gap on the FLIP
 *     spring – a probe on the strip records the fade's start and end, the card's removal and the
 *     siblings' transform frames while the finger's act runs.
 *  4. Customise from the ⋮ opens the stack's sheet of switch rows, the hidden card's switch off;
 *     a finger on it re-enables the card, which is back in its seat behind the sheet.
 *  5. Every switch off: the stack is gone from the page altogether (the page keeps its field and
 *     tiles); the sheet closed, the empty state.
 *  6. The way back with no ⋮ left: the page's gear sheet carries a Magic Stack row; a finger on
 *     it swaps the sheets (one sheet over the page, §9.24) and the stack's sheet comes up; a
 *     switch on brings one card back, alone at the strip's full width and without dots; another
 *     brings the dots back.
 *  7. The Continue card's Reopen restores the closed tab (`session.restoreClosed`): the tab comes
 *     back on its loopback page.
 *
 * The sites are loopback pages served from this process ([DemoServer]); the seeded state names
 * them at this driver's port. Every claim is a line in `magic-stack-findings.txt` next to the
 * recording and a failed one fails the run; the recording goes on to the end either way. The tree
 * on this image trails the screen by seconds after a transition, so a finger that waits on it
 * only waits so long and then lands on the DOM's box for the same control (the harness's
 * `touchControl`); a control whose name another on screen shares (a switch row and the card it
 * names, a menu row) is aimed at through the DOM alone.
 */
@RunWith(AndroidJUnit4::class)
class MagicStackDemo : DemoHarness("magic-stack-demo-state.json", "android-ntp-magic-stack", "magic-stack-demo") {
    override val tag = "MagicStackDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0
    private lateinit var demoTabId: String
    /** Whether the host says the browser is not the default: the fourth card's condition. */
    private var notDefault = false

    /** A loopback page: its path, the page's title and a heading colour. */
    private class Site(val path: String, val title: String, val hex: String) {
        val caption get() = title.substringBefore(" - ")
    }

    private val sites = listOf(
        Site("/", "Orchard - Fresh fruit, delivered", "#2E7D32"),
        Site("/tides", "Tides - Coastal weather", "#0277BD"),
        Site("/atlas", "Atlas - Maps for walkers", "#EF6C00"),
        Site("/ledger", "Ledger - Personal finance", "#5E35B1")
    )

    private val tides get() = sites[1]

    private fun url(site: Site) = "http://127.0.0.1:$PORT${site.path}"

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            sites.associate { site -> site.path to ("text/html; charset=utf-8" to pageHtml(site).toByteArray()) }
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures.isNotEmpty()) error("${failures.size} claim(s) did not hold: ${failures.joinToString("; ")}")
    }

    // --- seed ------------------------------------------------------------------------------------

    /** The seeded tab, the closed tab and the bookmarks point at this driver's server; the stamps become times. */
    override fun patchState(json: String): String = stamp(json.replace("127.0.0.1:18131", "127.0.0.1:$PORT"))

    /**
     * The completed download: a real file under the app's files (the core asks the host whether a
     * completed row's file is still there when the list loads – `download.exists`, a `FileSink`
     * for an absolute path – and only a row whose file is qualifies for the card), and the
     * downloads list naming it, three hours old.
     */
    override fun seedMore(zen: File) {
        val dir = File(app.filesDir, DOWNLOAD_DIR).apply { mkdirs() }
        val file = File(dir, DOWNLOAD_NAME)
        file.writeBytes(pdfBytes())
        val item = JSONObject()
            .put("id", "dl_field_guide")
            .put("url", "http://127.0.0.1:$PORT/$DOWNLOAD_NAME")
            .put("filename", DOWNLOAD_NAME)
            .put("savePath", file.absolutePath)
            .put("totalBytes", file.length())
            .put("receivedBytes", file.length())
            .put("state", "completed")
            .put("startedAt", System.currentTimeMillis() - 3 * 3_600_000L)
            .put("mimeType", "application/pdf")
        File(zen, "downloads.json").writeText(JSONObject().put("version", 1).put("items", JSONArray().put(item)).toString())
    }

    /** `"{{now-3h}}"` / `"{{now-2d}}"` (quotes included) become the epoch millisecond that long before now. */
    private fun stamp(text: String): String {
        val now = System.currentTimeMillis()
        return STAMP.replace(text) { m ->
            val amount = m.groupValues[1].toLongOrNull() ?: 0L
            val unit = if (m.groupValues[2] == "d") 86_400_000L else 3_600_000L
            (now - amount * unit).toString()
        }
    }

    /**
     * A one-page PDF, padded to about 1.2 MB with a comment stream so the card's size reads as a
     * document's would (the padding lies after `%%EOF`, where a reader ignores it).
     */
    private fun pdfBytes(): ByteArray {
        val head = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
            "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
        val pad = ByteArray(1_228_800 - head.length) { '%'.code.toByte() }
        return head.toByteArray() + pad
    }

    // --- warm-up ---------------------------------------------------------------------------------

    /**
     * Off camera: read what the host says of the default browser (the fourth card's condition),
     * pay for the menu and the first new tab page's layout, and calibrate the DOM's boxes against
     * the tree.
     */
    override fun warmUp() {
        findings = File(out, "magic-stack-findings.txt")
        findings.writeText("Zenium Android Magic Stack checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        demoTabId = activeCoreTab()?.optString("id").orEmpty()
        val state = coreState()
        val defaultBrowser = state.optJSONObject("defaultBrowser") ?: JSONObject()
        notDefault = defaultBrowser.has("isDefault") && !defaultBrowser.isNull("isDefault") && !defaultBrowser.optBoolean("isDefault", true)
        finding(
            "start: ${describeActive()}; defaultBrowser $defaultBrowser (the Default browser card ${if (notDefault) "expected" else "not expected"}); " +
                "recentlyClosed ${state.optJSONArray("recentlyClosed")?.length()}; downloads ${summariseDownloads(state)}; " +
                "bookmarks ${state.optJSONArray("bookmarks")?.length()}; hidden ${hiddenModules()}"
        )

        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_000)
        // The first new tab page pays for its layout (and the stack's): open and close one off camera.
        if (tapLabel(Finger(), NEW_TAB_LABEL)) {
            SystemClock.sleep(2_500)
            val fresh = activeCoreTab()
            if (fresh != null && fresh.optString("url") == BLANK_URL) {
                val stack = awaitChrome("!!$STACK_JS", 8_000)
                finding("warm-up: the stack ${if (stack) "painted" else "did NOT paint"} on the first page; cards ${cardIds()}")
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(fresh.optString("id"))}}")
                SystemClock.sleep(1_500)
            }
        }
        ensureActive(demoTabId)
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        calibrateDomBoxes()
        finding("warm-up done: ${describeActive()}")
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        still("page")
        theStackOnThePage()
        pageBySwipe()
        hideACard()
        customiseBringsItBack()
        theEmptyState()
        theWayBack()
        reopenFromContinue()
        finding("\nend: ${describeActive()}; ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    /** The stack's cards on a fresh page: the three the seed gives, and the reminder where the host is not the default. */
    private fun expectedCards(): List<String> = if (notDefault) MODULES else MODULES.filter { it != "default-browser" }

    // --- 1. the stack on the page ----------------------------------------------------------------

    private fun theStackOnThePage() {
        step("1. The stack on the page: one card per module with content, in the stack's order, named for TalkBack, the strip a carousel with its dots, above the tiles at the bottom dock") {
            val before = tabCount()
            if (!tapLabel(Finger(), NEW_TAB_LABEL)) error("no '$NEW_TAB_LABEL' button on the bar")
            SystemClock.sleep(2_000)
            val expected = expectedCards()
            val up = awaitChrome("document.querySelectorAll('.zen-mstack-card').length===${expected.size}", 10_000)
            SystemClock.sleep(1_000)
            val geometry = geometry()
            val ids = cardIds()
            finding("  ${describeActive()} (tabs were $before); stack ${if (up) "up" else "NOT at the expected count"}; cards $ids; $geometry")
            expect("the plus opens a new tab page (tabs ${tabCount()})", tabCount() == before + 1 && activeUrl() == BLANK_URL, "ntp-open")
            expect("the stack draws ${expected.size} cards in the stack's order: $ids", ids == expected, "stack-cards")
            val labels = chromeValue(CARD_LABELS_JS)
            finding("  card names: $labels")
            expect(
                "the cards are named for TalkBack, the module first then what it holds",
                labels.contains("Continue where you left off: ${tides.title}") &&
                    labels.contains("Downloads: $DOWNLOAD_NAME") &&
                    labels.contains("Bookmarks: ${sites[2].title}, ${sites[3].title}"),
                "stack-card-names"
            )
            expect("every card is a page surface (data-surface page)", chromeValue("String(${ALL_PAGE_SURFACES_JS})") == "true", "stack-card-surface")
            expect(
                "the strip is a list with the carousel role description, the stack named 'Magic Stack'",
                chromeValue("(($STRIP_JS)||{getAttribute:function(){return ''}}).getAttribute('role')") == "list" &&
                    chromeValue("(($STRIP_JS)||{getAttribute:function(){return ''}}).getAttribute('aria-roledescription')") == "carousel" &&
                    chromeValue("(($STACK_JS)||{getAttribute:function(){return ''}}).getAttribute('aria-label')") == "Magic Stack",
                "stack-carousel-roles"
            )
            val dots = geometry.optInt("dots")
            expect("a dot per page (${dots} of ${expected.size}), the first selected, named 'Page 1 of ${expected.size}: Continue where you left off'", dots == expected.size && geometry.optInt("selected") == 0 && geometry.optString("firstDot") == "Page 1 of ${expected.size}: Continue where you left off", "stack-dots")
            val mores = chromeValue(MORE_LABELS_JS)
            finding("  the ⋮ buttons: $mores")
            expect("each ⋮ is the shared 44 icon button named for its module", mores == JSONArray(expected.map { "More options for ${moduleTitle(it)}" }).toString() && chromeValue("String(${ALL_MORE_ICON_BUTTONS_JS})") == "true", "stack-more-buttons")
            // The tree: the ⋮ buttons by name (the WebView's tree carries buttons reliably; the
            // cards' own names are read from the DOM above and noted from the tree here).
            val treeMore = awaitFresh(8_000, "the Downloads card's ⋮") { it == "More options for Downloads" } != null
            val treeCard = findNode { it.startsWith("Continue where you left off") } != null
            finding("  tree: the Downloads ⋮ ${if (treeMore) "named" else "NOT found"}; a node starting 'Continue where you left off' ${if (treeCard) "present" else "absent"}")
            expect("TalkBack has the ⋮ by its module's name", treeMore, "stack-more-tree")
            // Geometry at the bottom dock (the phone's default): the stack above the tiles, the
            // card the strip's width less the 24 the next card peeks by.
            val dock = chromeValue("(document.querySelector('.zen-ntp')||{dataset:{}}).dataset.dock||''")
            val stack = domBox(STACK_JS)
            val grid = domBox(GRID_JS)
            expect("at the bottom dock (data-dock '$dock') the stack stands above the tiles (stack bottom ${stack?.bottom} <= grid top ${grid?.top})", dock == "bottom" && stack != null && grid != null && stack.bottom <= grid.top, "stack-above-tiles")
            val cardWidth = geometry.optInt("cardWidth")
            val stripInner = geometry.optInt("stripInner")
            expect("a card is the strip's width less the 24 the next one peeks by (card $cardWidth, strip $stripInner)", cardWidth > 0 && abs(stripInner - 24 - cardWidth) <= 2, "stack-card-peek")
            still("stack-first-card")
        }
    }

    // --- 2. paging by a swipe ---------------------------------------------------------------------

    private fun pageBySwipe() {
        step("2. Paging: a real swipe on the strip snaps to the second card and selects its dot; a finger on the first dot pages back") {
            val strip = domBox(STRIP_JS) ?: error("no strip on the page")
            val pitch = geometry().optInt("cardWidth") + 8
            // The finger starts three quarters of the way across the strip, on the first card's
            // body (not its ⋮ or an action), and carries it a little over half the width left.
            val start = Rect(strip.left + strip.width() * 3 / 4, strip.top + strip.height() / 2, strip.left + strip.width() * 3 / 4 + 2, strip.top + strip.height() / 2 + 2)
            val from = touchPoint(start) ?: error("the strip lies outside the touchable window ($strip)")
            val travel = -(strip.width() * 0.55f)
            noteLine("  swipe from ${from.x.toInt()},${from.y.toInt()} by ${travel.toInt()} px over 240 ms (pitch $pitch)")
            measureFrames("magic-stack-swipe", JankBudget.Kind.GESTURE, trace = true) {
                Finger().apply {
                    down(from.x, from.y)
                    moveBy(travel, 0f, 240)
                    up()
                }
                SystemClock.sleep(900)
            }
            val paged = awaitChrome("(document.querySelectorAll('.zen-mstack-dot')[1]||{getAttribute:function(){return ''}}).getAttribute('aria-selected')==='true'", 4_000)
            SystemClock.sleep(400)
            val after = geometry()
            finding("  after the swipe: $after")
            expect("the strip snapped to the second card (scrollLeft ${after.optInt("scrollLeft")} within 12 of the pitch $pitch)", abs(after.optInt("scrollLeft") - pitch) <= 12, "stack-swipe-snap")
            expect("the second dot is selected (index ${after.optInt("selected")})", paged && after.optInt("selected") == 1, "stack-swipe-dot")
            still("stack-second-card")
            // Back by the dots: the first page's dot under a finger.
            val back = touchDomExpecting("the first page's dot", "document.querySelectorAll('.zen-mstack-dot')[0]", "the strip is back at the first card", 5_000) {
                geometry().let { it.optInt("selected") == 0 && it.optInt("scrollLeft") <= 4 }
            }
            expect("a finger on the first dot pages back to the first card", back, "stack-dot-tap")
            SystemClock.sleep(600)
        }
    }

    // --- 3. Hide This -----------------------------------------------------------------------------

    private fun hideACard() {
        step("3. A card's ⋮ opens the module's menu (Hide This, Customise); Hide This writes the hidden set, fades the card over 120 ms and glides the rest into the gap") {
            val id = "continue"
            val title = moduleTitle(id)
            if (!touchControl("More options for $title", moreJs(id))) error("no ⋮ on the $title card")
            val sheet = awaitSheet(title, 8_000)
            val rested = sheet && awaitSheetAtRest(6_000)
            val rows = chromeValue(MENU_ROWS_JS)
            finding("  the menu: sheets ${sheetsPresented()}, rows $rows, rested ${verdict(rested)}")
            expect("the ⋮ opens the shared local menu titled '$title'", sheet, "menu-title")
            expect("its rows are Hide This and Customise", rows == JSONArray(listOf("Hide This", "Customise")).toString(), "menu-rows")
            still("card-menu")

            val row = domBox(menuItemJs("Hide This")) ?: error("the menu has no 'Hide This' row in the DOM")
            val at = touchPoint(row) ?: error("the 'Hide This' row lies outside the touchable window ($row)")
            val cardsBefore = cardIds()
            val armed = chromeValue(PROBE_ARM_JS)
            noteLine("  probe $armed; touch at ${at.x.toInt()},${at.y.toInt()} on 'Hide This' at the DOM's box $row")
            measureFrames("magic-stack-hide", JankBudget.Kind.SPRING, trace = true) {
                Finger().tap(at.x, at.y)
                SystemClock.sleep(1_400)
            }
            val probe = runCatching { JSONObject(chromeValue(PROBE_READ_JS)) }.getOrElse { JSONObject() }
            val hidden = hiddenModules()
            val cardsAfter = cardIds()
            finding("  probe: $probe")
            finding("  hidden set $hidden; cards $cardsBefore -> $cardsAfter; sheets ${sheetsPresented()}")
            expect("Hide This writes the device's hidden set (continue in $hidden)", hidden.contains("\"continue\""), "hide-writes")
            expect("the card leaves on its fade (data-leaving set at ${probe.opt("leavingAt")} ms, animationend at ${probe.opt("animationEndAt")} ms, the card out of the strip at ${probe.opt("removedAt")} ms)", !probe.isNull("leavingAt") && !probe.isNull("removedAt") && (!probe.isNull("animationEndAt") || probe.optInt("removedAt") - probe.optInt("leavingAt") in 100..400), "hide-fade")
            val transforms = probe.optJSONObject("transforms") ?: JSONObject()
            val glided = transforms.keys().asSequence().toList()
            expect("the cards after it glide into the gap on the FLIP spring (transform frames on $glided: $transforms)", cardsAfter.isNotEmpty() && glided.containsAll(cardsAfter.take(1)) && transforms.optInt(cardsAfter.first()) >= 2, "hide-gap-close")
            expect("the stack is the remaining ${cardsBefore.size - 1} cards", cardsAfter == cardsBefore.drop(1), "hide-cards")
            expect("the menu has left", awaitSheetGone(title, 4_000), "hide-menu-gone")
            SystemClock.sleep(400)
            still("card-hidden")
        }
    }

    // --- 4. Customise -----------------------------------------------------------------------------

    private fun customiseBringsItBack() {
        step("4. Customise from the ⋮ opens the stack's sheet of switch rows, the hidden card's off; a finger on it brings the card back behind the sheet") {
            val first = cardIds().firstOrNull() ?: error("no card left on the page")
            val title = moduleTitle(first)
            if (!touchControl("More options for $title", moreJs(first))) error("no ⋮ on the $title card")
            if (!awaitSheet(title, 8_000)) error("the $title menu did not open")
            awaitSheetAtRest(6_000)
            val swapped = touchDomExpecting("the menu's Customise row", menuItemJs("Customise"), "the stack's sheet 'Magic Stack' is up and the menu gone", 8_000) {
                sheetPresented(SHEET_TITLE) && !sheetPresented(title)
            }
            expect("Customise swaps the menu for the stack's sheet '$SHEET_TITLE'", swapped, "customise-opens")
            awaitSheetAtRest(6_000)
            val switches = switchStates()
            finding("  the sheet's switches: $switches; sheets ${sheetsPresented()}")
            val expected = JSONObject().also { for (id in MODULES) it.put(moduleTitle(id), id != "continue") }
            expect("one switch per module the host has (the four: Android can ask to be the default), the hidden card's off: $switches", sameStates(switches, expected), "customise-switches")
            val note = chromeValue("((document.querySelector('.zen-sheet .zen-v2-description')||{}).textContent||'').trim()")
            expect("the sheet says a card appears only when it has something to show ('$note')", note == "A card appears only when it has something to show.", "customise-note")
            still("customise-sheet")
            val on = touchDomExpecting("the '${moduleTitle("continue")}' switch", switchJs("continue"), "the hidden set drops the id and the card is back", 6_000, reveal = true) {
                !hiddenModules().contains("\"continue\"") && cardIds().firstOrNull() == "continue"
            }
            expect("the switch on re-enables the card at once, back in its seat behind the sheet (cards ${cardIds()}, hidden ${hiddenModules()})", on, "customise-reenable")
            SystemClock.sleep(600)
            still("customise-reenabled")
        }
    }

    // --- 5. the empty state -----------------------------------------------------------------------

    private fun theEmptyState() {
        step("5. Every switch off: the stack is gone from the page, the page keeps its field and tiles") {
            if (!sheetPresented(SHEET_TITLE)) error("the '$SHEET_TITLE' sheet is not up")
            for (id in MODULES) {
                val title = moduleTitle(id)
                val off = touchDomExpecting("the '$title' switch", switchJs(id), "the hidden set carries $id", 6_000, reveal = true) { hiddenModules().contains("\"$id\"") }
                if (!off) finding("  the '$title' switch did not take")
                SystemClock.sleep(500)
            }
            val gone = awaitChrome("!$STACK_JS", 6_000)
            val hidden = hiddenModules()
            finding("  hidden set $hidden; stack ${if (gone) "gone" else "STILL on the page"}; field ${domBox(FIELD_JS)}, grid ${domBox(GRID_JS)}")
            expect("with every module hidden ($hidden) the stack is not drawn at all", gone && MODULES.all { hidden.contains("\"$it\"") }, "empty-stack-gone")
            expect("the page keeps its field and its tiles", domBox(FIELD_JS) != null && domBox(GRID_JS) != null, "empty-page-intact")
            still("customise-all-off")
            back()
            val closed = awaitSheetGone(SHEET_TITLE, 6_000)
            expect("the system back closes the sheet", closed, "empty-sheet-closed")
            SystemClock.sleep(1_000)
            still("empty")
        }
    }

    // --- 6. the way back through the gear ---------------------------------------------------------

    private fun theWayBack() {
        step("6. With no ⋮ left, the page's gear sheet carries a Magic Stack row; it swaps the sheets, a switch brings one card back alone at full width, another brings the dots back") {
            if (!touchControl(GEAR_LABEL, GEAR_JS)) error("no gear on the page")
            val gear = awaitSheet(GEAR_TITLE, 8_000)
            awaitSheetAtRest(6_000)
            val row = chromeValue("((${GEAR_ROW_JS})||{}).textContent||''")
            finding("  the gear sheet ${verdict(gear)}; its Magic Stack row: '$row'")
            expect("the gear opens the page's sheet '$GEAR_TITLE' with a 'Magic Stack' row", gear && row.startsWith("Magic Stack") && row.contains("Choose which cards show under the shortcuts"), "gear-row")
            still("gear-sheet-row")
            val swapped = touchDomExpecting("the gear sheet's Magic Stack row", GEAR_ROW_JS, "the gear sheet has left and the stack's is up", 8_000, reveal = true) {
                sheetPresented(SHEET_TITLE) && !sheetPresented(GEAR_TITLE)
            }
            expect("the row swaps the sheets: the gear's leaves first, the stack's comes up (sheets ${sheetsPresented()})", swapped, "gear-swap")
            awaitSheetAtRest(6_000)
            val states = switchStates()
            expect("every switch is off on the stack's sheet: $states", states.length() == MODULES.size && states.keys().asSequence().all { !states.optBoolean(it) }, "gear-switches-off")
            still("magic-stack-from-gear")
            val lone = touchDomExpecting("the 'Bookmarks' switch", switchJs("bookmarks"), "the Bookmarks card is back alone", 6_000, reveal = true) {
                cardIds() == listOf("bookmarks")
            }
            SystemClock.sleep(700)
            val geometry = geometry()
            finding("  one card: $geometry")
            expect("one card back, alone: the strip's full width (card ${geometry.optInt("cardWidth")}, strip ${geometry.optInt("stripInner")}) and no dots (${geometry.optInt("dots")})", lone && geometry.optInt("dots") == 0 && abs(geometry.optInt("stripInner") - geometry.optInt("cardWidth")) <= 2, "lone-card")
            still("lone-card")
            val two = touchDomExpecting("the '${moduleTitle("continue")}' switch", switchJs("continue"), "two cards with their dots", 6_000, reveal = true) {
                cardIds() == listOf("continue", "bookmarks") && geometry().optInt("dots") == 2
            }
            expect("a second card brings the dots back (cards ${cardIds()})", two, "two-cards")
            back()
            val closed = awaitSheetGone(SHEET_TITLE, 6_000)
            expect("the system back closes the sheet", closed, "gear-sheet-closed")
            SystemClock.sleep(1_000)
            still("two-cards")
        }
    }

    // --- 7. Reopen --------------------------------------------------------------------------------

    private fun reopenFromContinue() {
        step("7. The Continue card's Reopen restores the closed tab on its page") {
            val before = tabCount()
            val reopened = touchDomExpecting("the Continue card's Reopen", actionJs("continue", "Reopen"), "the closed tab is back as the active tab", 10_000) {
                activeUrl() == url(tides) && tabCount() == before + 1
            }
            finding("  ${describeActive()} (tabs were $before); recentlyClosed ${coreState().optJSONArray("recentlyClosed")?.length()}")
            expect("Reopen restores the closed tab (${url(tides)}) as the active tab", reopened, "reopen")
            awaitLoaded(url(tides), 8_000)
            SystemClock.sleep(1_200)
            still("reopened")
        }
    }

    // --- the stack, read --------------------------------------------------------------------------

    private fun cardIds(): List<String> = runCatching {
        val list = JSONArray(chromeValue(CARD_IDS_JS))
        (0 until list.length()).map { list.getString(it) }
    }.getOrElse { emptyList() }

    /** The strip's geometry as JSON: card count, the first card's width, the strip's inner width, scrollLeft, the dots and the selected one. */
    private fun geometry(): JSONObject = runCatching { JSONObject(chromeValue(GEOMETRY_JS)) }.getOrElse { JSONObject() }

    /** The Customise sheet's switches: label -> checked. */
    private fun switchStates(): JSONObject = runCatching { JSONObject(chromeValue(SWITCHES_JS)) }.getOrElse { JSONObject() }

    private fun sameStates(a: JSONObject, b: JSONObject): Boolean =
        a.length() == b.length() && a.keys().asSequence().all { b.has(it) && a.optBoolean(it) == b.optBoolean(it) }

    private fun hiddenModules(): String = coreState().optJSONArray("newTabHiddenModules")?.toString() ?: "[]"

    private fun moduleTitle(id: String): String = when (id) {
        "continue" -> "Continue where you left off"
        "downloads" -> "Downloads"
        "bookmarks" -> "Bookmarks"
        "default-browser" -> "Default browser"
        else -> id
    }

    private fun summariseDownloads(state: JSONObject): String {
        val list = state.optJSONArray("downloads") ?: return "none"
        return (0 until list.length()).joinToString(", ") { i ->
            val d = list.getJSONObject(i)
            "${d.optString("filename")} ${d.optString("state")}${if (d.optBoolean("fileMissing")) " (file missing)" else ""}"
        }
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

    // --- the chrome ------------------------------------------------------------------------------

    /**
     * A real touch on the control the DOM gives for `domJs`, without the tree – for a control
     * whose accessible name another on screen shares (a switch row and the card it names, a menu
     * row and the card's ⋮). The aim is a [noteLine]; false, nothing injected, when the DOM has
     * no such element inside the touchable window.
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

    /**
     * A sheet's row brought into its body's view before a finger lands on it: a row under the
     * sheet's fold is reached the way a thumb reaches it – the sheet expanded by a drag on its
     * grabber, then its body scrolled by a drag – until the row's box lies inside the body and the
     * touchable window (four tries). The box then, or null.
     */
    private fun revealSheetRow(what: String, domJs: String): Rect? {
        repeat(4) { attempt ->
            val box = domBox(domJs)
            if (box != null && touchPoint(box) != null && chromeValue("String(${visibleInSheetJs(domJs)})") == "true") return box
            if (attempt == 0) {
                val handle = domBox(SHEET_HANDLE_JS) ?: findByLabel(SHEET_HANDLE_LABEL) ?: return null.also { noteLine("  no grabber to expand the sheet for $what") }
                noteLine("  $what is under the sheet's fold ($box): the sheet expanded by a drag on its grabber")
                Finger().apply {
                    down(handle.exactCenterX(), handle.exactCenterY())
                    moveBy(0f, -0.35f * height, 220)
                    up()
                }
            } else {
                val scroll = domBox(SHEET_SCROLL_JS) ?: return null.also { noteLine("  no sheet body to scroll for $what") }
                val at = touchPoint(scroll) ?: return null
                noteLine("  $what is still under the fold ($box): the sheet's body scrolled by a drag")
                Finger().apply {
                    down(at.x, at.y + scroll.height() * 0.25f)
                    moveBy(0f, -scroll.height() * 0.5f, 280)
                    up()
                }
            }
            SystemClock.sleep(1_200)
        }
        return null
    }

    /** [touchDom], then up to `timeoutMs` for `took` to hold; a touch that went in and did not take is a [touchFault]. */
    private fun touchDomExpecting(what: String, domJs: String, effect: String, timeoutMs: Long, reveal: Boolean = false, took: () -> Boolean): Boolean {
        if (reveal && revealSheetRow(what, domJs) == null) noteLine("  $what could not be brought into the sheet's view")
        if (!touchDom(what, domJs)) return false
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                Log.i(tag, "the touch on $what took: $effect")
                return true
            }
            SystemClock.sleep(150)
        }
        touchFault("a touch on $what did not take: not $effect within $timeoutMs ms")
        return false
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

    /** After a step threw: whatever is up sent away, the keyboard down, the page a new tab page with every module shown. */
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
        for (id in MODULES) coreInvoke("newtab.setModuleHidden", "{\"id\":${JSONObject.quote(id)},\"hidden\":false}")
        if (activeUrl() != BLANK_URL) {
            tapLabel(Finger(), NEW_TAB_LABEL)
            SystemClock.sleep(2_500)
        }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the sites -------------------------------------------------------------------------------

    private fun pageHtml(site: Site): String =
        "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:${site.hex};color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.caption}</h1></header>" +
            "<p>${site.title.substringAfter(" - ")}. One of the loopback pages the Magic Stack demo's closed tab and bookmarks point at.</p>" +
            "</body></html>"

    companion object {
        private const val PORT = 18178
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        private const val GEAR_LABEL = "Customise the new tab page"
        private const val SHEET_TITLE = "Magic Stack"
        private const val GEAR_TITLE = "New tab page"
        /** The modules in the stack's fixed order (`magicStackPlan.ts`); the sheet lists all four on Android, which can ask to be the default. */
        private val MODULES = listOf("continue", "downloads", "bookmarks", "default-browser")
        private const val DOWNLOAD_DIR = "magic-stack-demo-files"
        private const val DOWNLOAD_NAME = "field-guide.pdf"
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)([hd]))?\\}\\}\"")

        private const val SHEET_HANDLE_LABEL = "Resize sheet"
        private const val SHEET_HANDLE_JS = "document.querySelector('.zen-sheet [aria-label=\"$SHEET_HANDLE_LABEL\"]')"
        private const val SHEET_SCROLL_JS = "document.querySelector('.zen-sheet .zen-sheet-scroll')"

        /** Whether the element `domJs` gives lies wholly inside its sheet's scroll body and the window. */
        private fun visibleInSheetJs(domJs: String) =
            "(function(){var e=$domJs;if(!e)return false;var r=e.getBoundingClientRect();var s=e.closest('.zen-sheet-scroll');" +
                "var b=s?s.getBoundingClientRect():{top:0,bottom:window.innerHeight};return r.height>0&&r.top>=b.top-1&&r.bottom<=b.bottom+1&&r.bottom<=window.innerHeight})()"

        private const val STACK_JS = "document.querySelector('.zen-ntp .zen-mstack')"
        private const val STRIP_JS = "document.querySelector('.zen-ntp .zen-mstack-strip')"
        private const val FIELD_JS = "document.querySelector('.zen-ntp .zen-ntp-field')"
        private const val GRID_JS = "document.querySelector('.zen-ntp [aria-label=\"Most visited\"]')"
        private const val GEAR_JS = "document.querySelector('.zen-ntp [aria-label=\"$GEAR_LABEL\"]')"
        private const val CARD_IDS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.dataset.cell}))"
        private const val CARD_LABELS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.getAttribute('aria-label')}))"
        private const val MORE_LABELS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-more'),function(e){return e.getAttribute('aria-label')}))"
        private const val ALL_PAGE_SURFACES_JS = "Array.prototype.every.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.dataset.surface==='page'})"
        private const val ALL_MORE_ICON_BUTTONS_JS = "Array.prototype.every.call(document.querySelectorAll('.zen-mstack-more'),function(e){return e.classList.contains('zen-v2-icon-button')})"
        private const val MENU_ROWS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()}))"
        /** The open sheet's switch rows, label -> checked (`RowView`: the row is the `role="switch"` button, its label a `.zen-settings-label`). */
        private const val SWITCHES_JS = "(function(){var o={};var s=document.querySelectorAll('.zen-sheet [role=\"switch\"]');for(var i=0;i<s.length;i++){var l=s[i].querySelector('.zen-settings-label');o[l?l.textContent.trim():s[i].textContent.trim()]=s[i].getAttribute('aria-checked')==='true'}return JSON.stringify(o)})()"
        /** The gear sheet's Magic Stack action row (`CustomizeSheet`, `data-row="magic-stack"`). */
        private const val GEAR_ROW_JS = "document.querySelector('.zen-sheet [role=\"dialog\"] [data-row=\"magic-stack\"]')"
        private const val GEOMETRY_JS = "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip');if(!s)return JSON.stringify({cards:0});" +
            "var c=s.firstElementChild;var cs=getComputedStyle(s);var inner=s.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);" +
            "var dots=document.querySelectorAll('.zen-mstack-dot');var sel=-1;for(var i=0;i<dots.length;i++){if(dots[i].getAttribute('aria-selected')==='true')sel=i}" +
            "return JSON.stringify({cards:s.children.length,cardWidth:c?c.offsetWidth:0,stripInner:Math.round(inner),scrollLeft:Math.round(s.scrollLeft),dots:dots.length,selected:sel,firstDot:dots.length?dots[0].getAttribute('aria-label'):''})})()"

        private fun moreJs(id: String) = "document.querySelector('.zen-mstack-card[data-cell=\"$id\"] .zen-mstack-more')"

        private fun actionJs(id: String, label: String) =
            "Array.prototype.find.call(document.querySelectorAll('.zen-mstack-card[data-cell=\"$id\"] .zen-mstack-action'),function(e){return e.textContent.trim()===${JSONObject.quote(label)}})"

        /** The open menu sheet's row reading `label` (`MenuSheet`: a `.zen-sheet-item` whose text is the label). */
        private fun menuItemJs(label: String) =
            "Array.prototype.find.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()===${JSONObject.quote(label)}})"

        /** The stack's sheet's switch row for the module `id` (`RowView` marks the row `data-row` with the row's id). */
        private fun switchJs(id: String) = "document.querySelector('.zen-sheet [role=\"switch\"][data-row=\"$id\"]')"

        /**
         * A probe on the strip for the hide: when the card was marked leaving, when its fade
         * ended (`animationend`), when it left the strip, and how many transform frames each
         * remaining card was given by the FLIP tracker (its inline `transform`, a frame at a time).
         * Armed before the finger's act, read after it (nothing of it runs in the measured block
         * but the observer's own callbacks).
         */
        private const val PROBE_ARM_JS = "(function(){var s=document.querySelector('.zen-mstack-strip');if(!s)return 'no strip';var t0=performance.now();" +
            "var p=window.__mstackProbe={leavingAt:null,animationEndAt:null,removedAt:null,transforms:{},firstTransformAt:null,lastTransformAt:null,cardsAtStart:s.children.length};" +
            "s.addEventListener('animationend',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('zen-mstack-card')&&p.animationEndAt===null)p.animationEndAt=Math.round(performance.now()-t0)},true);" +
            "var mo=new MutationObserver(function(list){var now=Math.round(performance.now()-t0);for(var i=0;i<list.length;i++){var m=list[i];" +
            "if(m.type==='attributes'&&m.attributeName==='data-leaving'&&m.target.hasAttribute('data-leaving')&&p.leavingAt===null)p.leavingAt=now;" +
            "if(m.type==='attributes'&&m.attributeName==='style'&&m.target.classList&&m.target.classList.contains('zen-mstack-card')){var tf=m.target.style.transform;if(tf){var id=m.target.dataset.cell;p.transforms[id]=(p.transforms[id]||0)+1;if(p.firstTransformAt===null)p.firstTransformAt=now;p.lastTransformAt=now}}" +
            "if(m.type==='childList'&&m.removedNodes.length&&p.removedAt===null)p.removedAt=now}});" +
            "mo.observe(s,{attributes:true,attributeFilter:['data-leaving','style'],childList:true,subtree:true});" +
            "p.stop=function(){mo.disconnect();var c={};for(var k in p){if(k!=='stop')c[k]=p[k]}return JSON.stringify(c)};return 'armed'})()"
        private const val PROBE_READ_JS = "window.__mstackProbe?window.__mstackProbe.stop():'{}'"
    }
}
