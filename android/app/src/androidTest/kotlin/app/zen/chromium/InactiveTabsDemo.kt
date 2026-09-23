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

/**
 * Records the Inactive tabs surface (TAB-20 / SET-34: Chrome's archived tabs) for the
 * `android-inactive-tabs-demo` workflow, and writes what it measured to
 * `inactive-tabs-findings.txt` next to the frames (one `PASS` or `FAIL` per check; the test
 * itself fails only when the driver could not run or a touch it injected did not take):
 *
 *  1. the overview as seeded: nothing archived, so the segment row carries no entry (§9.34:
 *     the entry is the row's trailing control, never a fourth segment; hidden at zero as
 *     Chrome hides its card);
 *  2. the archive pass at +22 days through the drivers' clock (`inactiveTabs.runPasses {now}`,
 *     never a wait): five idle tabs leave the grid, the entry reads "Inactive tabs, 5";
 *  3. the entry under a finger: the Inactive tabs sheet, its §10.3 rows and its footer
 *     (Restore all | Close all, §9.11 peers, the destructive one trailing);
 *  4. one row's Close under a finger: the row leaves for Recently closed;
 *  5. a row under a finger: the tab back to the start of the grid and to the front, the
 *     overview leaving onto it, the restore motion frame by frame;
 *  6. dark: the entry with the badge;
 *  7. dark: the list, Close all's §9.23 prompt stacked over it (the lower sheet recessed and
 *     inert, the title without a glyph, Chrome's words), Cancel;
 *  8. each row's Close in turn: the list empties to its §9.17 sentence (dark, then light),
 *     a back leaves the sheet and the entry is gone from the row;
 *  9. Settings › Tab Management: the Inactive tabs group beside Sleeping tabs (light and dark),
 *     Chrome's values;
 * 10. Move to inactive › Never under a finger: the archived tabs come back into the grid
 *     (Chrome's rescue) and the auto-close row goes to .4; then back to 21 days;
 * 11. Close all confirmed under a finger: both sheets leave, the archive is emptied for good
 *     (History keeps the pages; Recently closed is not flushed), the entry goes.
 *
 * The profile is the overview demo's (`overview-demo-state.json`: Work with the Research group,
 * Example Domain active and four loose tabs; Personal with two). The seeded tabs carry no last
 * use, so they read the boot as theirs; the clock the pass runs on is 22 days on from the
 * device's, past Chrome's 21-day default. Sheet controls are aimed by the chrome's own DOM
 * (`domBox`, calibrated at the warm-up): the accessibility tree trails a sheet's motion by
 * seconds on the emulator. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class InactiveTabsDemo : DemoHarness("overview-demo-state.json", "inactive-tabs", "inactive-tabs-demo") {
    override val tag = "InactiveTabsDemo"
    private lateinit var findings: File
    private var shots = 0
    private var failures = 0

    @Test
    fun record() {
        runDemo()
    }

    override fun warmUp() {
        findings = File(out, "inactive-tabs-findings.txt")
        findings.writeText("Zenium Android Inactive tabs demo (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        calibrateDomBoxes()
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, Example Domain active).
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = awaitDom("!!document.querySelector('.zen-settings-search-field')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(800)
        ensureActive(DEMO_TAB)
        // The overview once off camera: its first layout and the grid's cards.
        val overview = runCatching {
            openOverview()
            SystemClock.sleep(800)
            leaveOverview()
        }
        SystemClock.sleep(1_200)
        finding(
            "warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; the overview " +
                "${if (overview.isSuccess) "opened and left" else "did NOT open (${overview.exceptionOrNull()?.message})"}; ${describeState()}"
        )
    }

    override fun demo() {
        val later = System.currentTimeMillis() + ARCHIVE_CLOCK_DAYS * DAY_MS
        val barBefore = tabsLabel()

        // 1. The grid as seeded: nothing archived, so the segment row carries no entry.
        step("1. The overview before the pass: no entry at zero") {
            openOverview()
            SystemClock.sleep(1_200)
            val count = archivedCount()
            val entry = inDom(ENTRY)
            val segments = domCount(SEGMENTS)
            still("overview-no-entry-light")
            expect(
                "archivedTabCount $count; the entry ${if (entry) "IN" else "not in"} the segment row; $segments segments (never a fourth)",
                count == 0 && !entry && segments == 2
            )
            finding("  the bar read '$barBefore'; grid cards: ${cardIds()}")
        }

        // 2. The pass at the drivers' clock: five idle tabs leave the grid for the archive.
        step("2. The archive pass at +$ARCHIVE_CLOCK_DAYS days (the drivers' clock, never a wait)") {
            val before = cardIds()
            val result = runPasses(later)
            val shown = awaitDom("(function(){var e=document.querySelector('$ENTRY');return !!e&&e.getAttribute('aria-label')==='Inactive tabs, 5'})()", 8_000)
            SystemClock.sleep(1_500)
            still("entry-with-badge-light")
            val label = attr(ENTRY, "aria-label")
            val badge = textOf("$ENTRY .zen-v2-badge")
            val after = cardIds()
            expect(
                "the pass archived ${result.optInt("archived")} (closed ${result.optInt("closed")}); the entry reads '$label', badge '$badge'",
                result.optInt("archived") == 5 && shown && badge == "5"
            )
            expect(
                "the grid: ${before.size} cards -> ${after.size} ($after): the archived cards gone, Example Domain kept",
                !after.contains("tab_hn") && !after.contains("tab_rfc") && !after.contains("tab_tea") && !after.contains("tab_coffee") && after.contains("tab_example")
            )
            val titles = archivedList().map { it.optString("title") }
            expect("the archive, newest first: $titles", titles.size == 5 && titles.contains("Hacker News") && titles.contains("Tea - Wikipedia"))
            val node = awaitFresh(TREE_MS, "the entry in the tree") { it == "Inactive tabs, 5" }
            finding("  the tree ${if (node != null) "lists" else "did not list"} the entry as 'Inactive tabs, 5'; the segment row's controls: ${segmentRowControls()}")
        }

        // 3. The entry under a finger: the sheet, its rows, its footer.
        step("3. The entry under a finger: the Inactive tabs sheet, its rows and its footer") {
            val touched = touchDom("Inactive tabs, 5", q(ENTRY))
            val up = touched && awaitSheet(LIST_TITLE, 8_000)
            val rested = up && awaitSheetAtRest(8_000)
            if (touched && !up) touchFault("a finger on the segment row's Inactive tabs entry did not present the sheet")
            still("list-populated-light")
            val rows = rowLabels()
            val footer = footerButtons()
            expect(
                "the sheet '$LIST_TITLE' presented $up (at rest $rested); ${rows.size} rows: ${rows.map { it.substringBefore(',') }}",
                up && rows.size == 5 && rows.any { it.startsWith("Hacker News,") }
            )
            expect("the footer's peers (a * marks data-danger): $footer", footer == listOf("Restore all", "Close all*"))
            expect("the entry says it is expanded: aria-expanded '${attr(ENTRY, "aria-expanded")}'", attr(ENTRY, "aria-expanded") == "true")
            finding("  a row's name: '${rows.firstOrNull()}'; the row's Close: '${attr("$SHEET .zen-list-trailing button", "aria-label")}'")
        }

        // 4. One row's Close under a finger: the row leaves for Recently closed.
        step("4. One row's Close under a finger: RFC 2324 leaves the list for Recently closed") {
            val closedBefore = recentlyClosedTitles()
            val took = touchDomExpecting("Close RFC 2324", rowClose("RFC 2324"), "the RFC 2324 row leaves the list") {
                rowLabels().none { it.startsWith("RFC 2324") }
            }
            SystemClock.sleep(1_200)
            still("row-closed-light")
            val list = archivedList()
            val closedAfter = recentlyClosedTitles()
            expect(
                "rows now ${rowLabels().size}, the archive ${list.size}; Recently closed ${closedBefore.size} -> ${closedAfter.size} (${closedAfter.firstOrNull()})",
                took && list.size == 4 && rowLabels().size == 4 && closedAfter.size == closedBefore.size + 1 && closedAfter.any { it.startsWith("RFC 2324") }
            )
        }

        // 5. A row under a finger: the tab back into the grid, the overview leaving onto it.
        step("5. A row under a finger: Hacker News back to the start of the grid, the overview leaving onto it") {
            val atRest = topSheetTransform()
            val touched = touchDom("Hacker News", row("Hacker News"))
            // The restore motion frame by frame. The first run's four stills, taken straight after
            // the tap, all showed the sheet still at rest (the click reaches React some hundreds of
            // milliseconds after the finger lifts), so the frames wait for the motion: two while the
            // sheet is under way (its transform off its resting value), then one as it is gone and
            // the overview begins to leave, and one more into the overview's departure.
            val started = SystemClock.uptimeMillis()
            val moving = awaitUntil(4_000, pollMs = 30) { topSheetTransform().let { it.isEmpty() || it != atRest } }
            val movingAfter = SystemClock.uptimeMillis() - started
            still("restore-frame-1")
            SystemClock.sleep(120)
            still("restore-frame-2")
            val gone = awaitUntil(4_000, pollMs = 30) { sheetCount() == 0 }
            val goneAfter = SystemClock.uptimeMillis() - started
            still("restore-frame-3")
            SystemClock.sleep(150)
            still("restore-frame-4")
            finding("  the frames: the sheet under way $moving after $movingAfter ms, gone $gone after $goneAfter ms")
            val left = awaitUntil(12_000) { !inDom(".zen-overview") }
            SystemClock.sleep(1_800)
            still("restored-tab-light")
            val tab = activeCoreTab()
            val work = spaceTabIds("space_work")
            val hn = coreState().getJSONObject("tabs").optJSONObject("tab_hn")
            expect(
                "the overview left $left; active ${tab?.optString("id")} ${tab?.optString("url")}; Work's order $work; the archive ${archivedList().size}",
                touched && left && tab?.optString("id") == "tab_hn" && work.firstOrNull() == "tab_hn" && hn?.optString("url") == HN_URL && archivedList().size == 3
            )
            if (touched && !left) touchFault("a finger on the Hacker News row did not restore it (the overview stayed)")
            finding("  the bar reads '${tabsLabel()}' (was '$barBefore')")
        }

        // 6. Dark: the entry with three archived.
        step("6. Dark: the entry with the badge") {
            setColorScheme("dark")
            openOverview()
            SystemClock.sleep(1_500)
            still("entry-with-badge-dark")
            val label = attr(ENTRY, "aria-label")
            expect("the entry reads '$label' under data-theme '${themeAttribute()}'", label == "Inactive tabs, 3" && themeAttribute() == "dark")
        }

        // 7. Dark: the list, Close all's prompt over it, Cancel.
        step("7. Dark: the list, Close all's prompt stacked over it, Cancel") {
            val touched = touchDom("Inactive tabs, 3", q(ENTRY))
            val up = touched && awaitSheet(LIST_TITLE, 8_000) && awaitSheetAtRest(8_000)
            if (touched && !up) touchFault("a finger on the Inactive tabs entry did not present the sheet (dark)")
            still("list-populated-dark")
            expect("the sheet up $up with ${rowLabels().size} rows: ${rowLabels().map { it.substringBefore(',') }}", up && rowLabels().size == 3)
            val asked = touchDomExpecting("Close all", footerButton("Close all"), "the prompt '$PROMPT_3' is presented") { sheetPresented(PROMPT_3) }
            val stacked = awaitStacked(8_000)
            SystemClock.sleep(800)
            still("close-all-prompt-dark")
            val stack = stackReading()
            expect(
                "the prompt over the list: sheets ${sheetsPresented()}; the lower sheet's --zen-layer-recede '${stack.optString("recede")}', recessed and inert ${stack.optBoolean("recessed")}; scrims lit ${stack.optInt("lit", -1)}",
                asked && stacked && stack.optInt("sheets") == 2 && stack.optBoolean("recessed") && stack.optInt("lit", -1) == 1
            )
            expect(
                "the prompt's title carries no glyph (§9.23) ${promptHasNoIcon()}; its words: '${promptDescription()}'",
                promptHasNoIcon() && promptDescription() == PROMPT_WORDS
            )
            expect("the prompt's peers: ${footerButtons()}", footerButtons() == listOf("Cancel", "Close all*"))
            val cancelled = touchDomExpecting("Cancel", footerButton("Cancel"), "the prompt leaves and the list stays") {
                sheetCount() == 1 && sheetPresented(LIST_TITLE)
            }
            SystemClock.sleep(600)
            expect("Cancel: sheets mounted ${sheetCount()}, rows ${rowLabels().size}", cancelled && rowLabels().size == 3)
        }

        // 8. Each row's Close in turn: the list empties to its sentence.
        step("8. Each row's Close in turn: the list empties to its sentence (dark, then light); a back leaves") {
            var closed = 0
            for (title in listOf("RFC 2549", "Coffee - Wikipedia", "Tea - Wikipedia")) {
                val took = touchDomExpecting("Close $title", rowClose(title), "the $title row leaves the list") {
                    rowLabels().none { it.startsWith(title) }
                }
                if (took) closed++
                SystemClock.sleep(900)
            }
            val sentence = awaitUntil(6_000) { emptySentence().isNotEmpty() }
            SystemClock.sleep(1_000)
            still("list-empty-dark")
            expect(
                "$closed of 3 rows closed under a finger; the sentence '${emptySentence()}' (§9.17, no full stop); footer ${footerButtons()}",
                closed == 3 && sentence && emptySentence() == EMPTY_21 && footerButtons().isEmpty()
            )
            setColorScheme("light")
            SystemClock.sleep(1_500)
            still("list-empty-light")
            back()
            val gone = awaitUntil(8_000) { sheetCount() == 0 }
            SystemClock.sleep(1_000)
            expect(
                "back: the sheet gone $gone; the entry ${if (inDom(ENTRY)) "STILL in" else "out of"} the segment row; archivedTabCount ${archivedCount()}",
                gone && !inDom(ENTRY) && archivedCount() == 0
            )
            still("overview-after-empty-light")
        }

        // 9. Settings: the Inactive tabs group beside Sleeping tabs.
        step("9. Settings › Tab Management: the Inactive tabs group beside Sleeping tabs (light and dark)") {
            leaveOverview()
            // Two of the closed tabs back through the core, in the background (a way to a state,
            // not a claim): the pass then has Example Domain, Coffee and RFC 2549 to file while
            // Hacker News and RFC 1149 stay shown.
            restoreClosedByTitle("Coffee - Wikipedia")
            restoreClosedByTitle("RFC 2549")
            SystemClock.sleep(1_000)
            val result = runPasses(later)
            finding("  the pass at +$ARCHIVE_CLOCK_DAYS days again: archived ${result.optInt("archived")}; the archive ${archivedList().map { it.optString("title") }}")
            if (!openSettingsSection("tabs")) {
                finding("  the Tab Management section never came up")
                return@step
            }
            SystemClock.sleep(1_000)
            val rect = settingsRowRect(MOVE_ROW)
            SystemClock.sleep(1_000)
            still("settings-rows-light")
            val value = settingsRowValue(MOVE_ROW)
            val autoOn = settingsSwitchOn(AUTO_ROW)
            val autoWords = settingsRowValue(AUTO_ROW)
            val heading = settingsRowListed("Inactive tabs")
            val sleeping = settingsRowListed("Sleeping tabs")
            expect(
                "the '$MOVE_ROW' row at $rect reads '$value' (Chrome's 21 days), named '${settingsRowName(MOVE_ROW)}'; '$AUTO_ROW' on $autoOn reading '$autoWords'; the group's heading listed $heading, Sleeping tabs' too $sleeping",
                value == "After 21 days inactive" && autoOn == true && autoWords == "Inactive tabs are closed after 3 months" && heading && sleeping
            )
            setColorScheme("dark")
            SystemClock.sleep(1_800)
            still("settings-rows-dark")
            setColorScheme("light")
            SystemClock.sleep(1_500)
        }

        // 10. Never under a finger: the rescue, the dependent row at .4; then Chrome's default again.
        step("10. Move to inactive › Never under a finger: the archived tabs come back, the auto-close row at .4") {
            val archived = archivedList().map { it.optString("title") }
            val opened = touchSettingsRowExpecting(MOVE_ROW, "the picker sheet is presented") { sheetCount() >= 1 }
            awaitSheetAtRest(8_000)
            still("settings-picker-light")
            finding("  the picker: sheets ${sheetsPresented()}; options ${pickerOptions()}")
            val picked = touchSettingsRowExpecting("Never", "the row reads Never") { settingsRowReads(MOVE_ROW, "Never") }
            awaitUntil(8_000) { sheetCount() == 0 }
            SystemClock.sleep(1_500)
            still("settings-never-light")
            val disabled = rowDisabled(AUTO_ROW_ID)
            val tabs = coreState().getJSONObject("tabs")
            val backIn = listOf("tab_example", "tab_coffee", "tab_avian").filter { tabs.has(it) }
            expect(
                "Never: archivedTabCount ${archivedCount()} (was ${archived.size}: $archived); back in their spaces: $backIn; '$AUTO_ROW' aria-disabled $disabled",
                opened && picked && archivedCount() == 0 && backIn.size == 3 && disabled == true
            )
            val again = touchSettingsRowExpecting(MOVE_ROW, "the picker sheet is presented") { sheetCount() >= 1 }
            awaitSheetAtRest(8_000)
            val restored = touchSettingsRowExpecting("After 21 days inactive", "the row reads After 21 days inactive") {
                settingsRowReads(MOVE_ROW, "After 21 days inactive")
            }
            awaitUntil(8_000) { sheetCount() == 0 }
            SystemClock.sleep(1_000)
            expect("After 21 days inactive again: '$AUTO_ROW' aria-disabled ${rowDisabled(AUTO_ROW_ID)}", again && restored && rowDisabled(AUTO_ROW_ID) == false)
            leaveSettingsTab()
            SystemClock.sleep(1_000)
        }

        // 11. Close all confirmed: the archive emptied for good, the entry gone.
        step("11. Close all confirmed under a finger: the archive emptied for good, the entry gone") {
            val result = runPasses(later)
            finding("  the pass: archived ${result.optInt("archived")}; the archive ${archivedList().map { it.optString("title") }}")
            openOverview()
            SystemClock.sleep(1_200)
            val n = archivedCount()
            val touched = touchDom("Inactive tabs, $n", q(ENTRY))
            val up = touched && awaitSheet(LIST_TITLE, 8_000) && awaitSheetAtRest(8_000)
            if (touched && !up) touchFault("a finger on the Inactive tabs entry did not present the sheet (the last act)")
            val asked = up && touchDomExpecting("Close all", footerButton("Close all"), "the prompt is presented") { sheetPresented("Close ", prefix = true) }
            awaitStacked(8_000)
            SystemClock.sleep(800)
            still("close-all-prompt-light")
            val tabsBefore = coreState().getJSONObject("tabs").length()
            val closedBefore = recentlyClosedTitles().size
            val confirmed = asked && touchDomExpecting("Close all", dangerButton(), "both sheets leave and the archive empties") {
                archivedCount() == 0 && sheetCount() == 0
            }
            SystemClock.sleep(1_500)
            still("overview-after-close-all-light")
            val tabsAfter = coreState().getJSONObject("tabs").length()
            expect(
                "Close all: archivedTabCount ${archivedCount()}; tabs $tabsBefore -> $tabsAfter; Recently closed $closedBefore -> ${recentlyClosedTitles().size} (a Close all discards; History keeps the pages); the entry ${if (inDom(ENTRY)) "STILL in" else "out of"} the row",
                confirmed && n == 3 && tabsAfter == tabsBefore && !inDom(ENTRY) && recentlyClosedTitles().size == closedBefore
            )
            leaveOverview()
        }

        finding("\nend: $failures check(s) failed; ${describeState()}")
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
    }

    // --- the archive through the core ------------------------------------------------------------

    /** The archive pass and the sweep at `now` (ms since the epoch): the drivers' clock. */
    private fun runPasses(now: Long): JSONObject =
        runCatching { JSONObject(coreInvoke("inactiveTabs.runPasses", "{\"now\":$now}")) }.getOrDefault(JSONObject())

    private fun archivedList(): List<JSONObject> {
        val arr = runCatching { JSONArray(coreInvoke("inactiveTabs.list")) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun archivedCount(): Int = coreState().optInt("archivedTabCount", -1)

    private fun recentlyClosedTitles(): List<String> {
        val arr = runCatching { JSONArray(coreInvoke("session.recentlyClosed")) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it).optString("title") }
    }

    /** A closed tab whose title starts with `prefix` back into its space in the background, through the core. */
    private fun restoreClosedByTitle(prefix: String) {
        val arr = runCatching { JSONArray(coreInvoke("session.recentlyClosed")) }.getOrDefault(JSONArray())
        for (i in 0 until arr.length()) {
            val entry = arr.getJSONObject(i)
            if (entry.optString("title").startsWith(prefix)) {
                coreInvoke("session.restoreClosed", "{\"id\":${JSONObject.quote(entry.getString("id"))},\"background\":true}")
                return
            }
        }
        finding("  (no closed tab titled '$prefix…' to restore)")
    }

    private fun spaceTabIds(spaceId: String): List<String> {
        val spaces = coreState().getJSONArray("spaces")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.optString("id") == spaceId) {
                val ids = space.optJSONArray("tabIds") ?: return emptyList()
                return (0 until ids.length()).map { ids.getString(it) }
            }
        }
        return emptyList()
    }

    private fun ensureActive(tabId: String) {
        if (activeCoreTab()?.optString("id") == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        awaitTrue(8_000) { activeCoreTab()?.optString("id") == tabId }
        SystemClock.sleep(1_000)
    }

    private fun setColorScheme(scheme: String) {
        coreInvoke("settings.update", "{\"colorScheme\":${JSONObject.quote(scheme)}}")
        val flipped = awaitTrue(8_000) { themeAttribute() == scheme }
        if (!flipped) finding("  (the chrome's data-theme did not read '$scheme' in time: '${themeAttribute()}')")
        SystemClock.sleep(600)
    }

    private fun themeAttribute(): String = jsString("document.documentElement.getAttribute('data-theme')||''")

    private fun describeState(): String {
        val state = coreState()
        val tab = activeCoreTab(state)
        return "active ${tab?.optString("id")} ${tab?.optString("url")}, ${state.getJSONObject("tabs").length()} tabs, ${state.optInt("archivedTabCount", -1)} archived, scheme ${state.getJSONObject("settings").optString("colorScheme")}"
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

    /** The system back until the overview is gone (a sheet over it goes first). */
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

    private fun tabsLabel(): String =
        attr(".zen-phone-bar [aria-label^=\"Tabs (\"]", "aria-label")

    private fun cardIds(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-overview [data-tab-id]'),function(e){return e.getAttribute('data-tab-id')})")

    /** The segment row's controls by their accessible names: the two segments, then the entry. */
    private fun segmentRowControls(): List<String> =
        jsList(
            "Array.prototype.map.call(document.querySelectorAll('$SEGMENTS, $ENTRY'),function(e){return e.getAttribute('aria-label')||e.textContent.trim()})"
        )

    // --- the sheets ------------------------------------------------------------------------------

    /** How many sheets the chrome has mounted (a closing one counts until its spring has carried it out). */
    private fun sheetCount(): Int = domCount(".zen-sheet")

    /** The top sheet's inline transform (position and recede share it), empty with no sheet up. */
    private fun topSheetTransform(): String =
        jsString("(function(){var e=$TOP_SHEET;return e?e.style.transform:''})()")

    /** The top sheet is mounted and its box has stood still: its spring is done. */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val mounted = awaitDom("document.querySelectorAll('.zen-sheet').length>=1", timeoutMs)
        val box = if (mounted) steadyBox(TOP_SHEET, timeoutMs) else null
        SystemClock.sleep(400)
        return box != null
    }

    /** Two sheets mounted, the lower one carrying the upper's progress (`--zen-layer-recede` past .9). */
    private fun awaitStacked(timeoutMs: Long): Boolean =
        awaitDom("(function(){var s=document.querySelectorAll('.zen-sheet');return s.length===2&&+s[0].style.getPropertyValue('--zen-layer-recede')>0.9})()", timeoutMs)

    /**
     * The chassis stack as SettingsTabDemo reads it: sheets, the lower sheet's recede, its
     * inert/recessed state, the scrims. `data-recessed` is a bare toggle since #168
     * (`toggleAttribute`, its value the empty string), so it is read by presence – a reading of
     * `dataset.recessed === 'true'` (the pre-#168 form SettingsTabDemo still carries) says false
     * over a sheet that stands recessed.
     */
    private fun stackReading(): JSONObject {
        val raw = jsString(
            "(function(){var s=Array.from(document.querySelectorAll('.zen-sheet'));var l=s[0];" +
                "var scrims=Array.from(document.querySelectorAll('.zen-sheet-scrim')).map(function(e){return Math.round(+getComputedStyle(e).opacity*100)/100});" +
                "return JSON.stringify({sheets:s.length,recede:l?l.style.getPropertyValue('--zen-layer-recede').trim():''," +
                "recessed:!!(l&&l.hasAttribute('data-recessed')&&l.inert),scrims:scrims,lit:scrims.filter(function(o){return o>0.05}).length})})()"
        )
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    private fun rowLabels(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$SHEET .zen-phone-row .zen-list-main'),function(e){return e.getAttribute('aria-label')||''})")

    /** The top sheet's footer buttons by their words, a `*` after a destructive one (`data-danger`). */
    private fun footerButtons(): List<String> =
        jsList(
            "Array.prototype.map.call((function(){var t=$TOP_SHEET;return t?t.querySelectorAll('.zen-sheet-footer .zen-v2-button'):[]})()," +
                "function(b){return b.textContent.trim()+(b.hasAttribute('data-danger')?'*':'')})"
        )

    private fun emptySentence(): String = textOf("$SHEET .zen-phone-empty p")

    /** The top sheet's block title carries no glyph (§9.23: a confirmation of the user's own command). */
    private fun promptHasNoIcon(): Boolean =
        jsString("(function(){var t=$TOP_SHEET;var h=t&&t.querySelector('.zen-sheet-title-block h2');return h?String(!h.querySelector('svg')):''})()") == "true"

    private fun promptDescription(): String =
        jsString("(function(){var t=$TOP_SHEET;var p=t&&t.querySelector('.zen-sheet-title-block p');return p?p.textContent.trim():''})()")

    private fun pickerOptions(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$SHEET .zen-settings-row .zen-settings-label'),function(e){return e.textContent.trim()})")

    /** Whether the Settings row `[data-row=id]` is disabled (`aria-disabled`, rows.tsx's PressableRow); null when there is no such row. */
    private fun rowDisabled(id: String): Boolean? =
        jsString("(function(){var r=document.querySelector('[data-row=\"$id\"]');return r?String(r.getAttribute('aria-disabled')==='true'):''})()").toBooleanStrictOrNull()

    /** The row for the archived tab titled `title…` (its `.zen-list-main`, named "TITLE, host · when"). */
    private fun row(title: String): String =
        q("$SHEET .zen-phone-row .zen-list-main[aria-label^=\"$title,\"]")

    /** The row's Close button ("Close TITLE"). */
    private fun rowClose(title: String): String =
        q("$SHEET .zen-list-trailing button[aria-label^=\"Close $title\"]")

    /** The top sheet's footer button reading `text`. */
    private fun footerButton(text: String): String =
        "(function(){var t=$TOP_SHEET;if(!t)return null;var bs=t.querySelectorAll('.zen-sheet-footer .zen-v2-button');" +
            "for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()===${JSONObject.quote(text)})return bs[i]}return null})()"

    /** The top sheet's destructive footer button. */
    private fun dangerButton(): String =
        "(function(){var t=$TOP_SHEET;return t?t.querySelector('.zen-sheet-footer .zen-v2-button[data-danger]'):null})()"

    // --- touches aimed by the chrome's DOM -------------------------------------------------------

    /**
     * A real touch on the chrome element `js` evaluates to, once its box has stood still (a
     * sheet's spring, a list's re-render). The aim is a log line; a claim is read off what
     * follows the touch, never off this. False, nothing injected, when the element is not on
     * screen within the wait or lies outside the touchable window.
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

    private fun domCount(selector: String): Int =
        jsString("String(document.querySelectorAll(${JSONObject.quote(selector)}).length)").toIntOrNull() ?: -1

    private fun awaitUntil(timeoutMs: Long, pollMs: Long = POLL_MS, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(pollMs)
        }
    }

    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `inactive-tabs-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val DEMO_TAB = "tab_example"
        private const val HN_URL = "https://news.ycombinator.com/"
        private const val DAY_MS = 24L * 60 * 60 * 1000
        /** The clock the passes run on: past Chrome's 21-day default, short of nothing else. */
        private const val ARCHIVE_CLOCK_DAYS = 22L
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L
        /** How long the tree gets to list the entry (a note, never a claim). */
        private const val TREE_MS = 6_000L

        /** The segment row's trailing entry (TabOverview.tsx). */
        private const val ENTRY = "[data-testid=\"overview-inactive-tabs\"]"
        /** The segment row's segments: two or three text tabs, never four (§9.34). */
        private const val SEGMENTS = ".zen-overview [role=\"tab\"]"
        private const val SHEET = "[data-sheet-layer] [role=\"dialog\"]"
        /** The top sheet: the last `.zen-sheet` mounted (a prompt over the list). */
        private const val TOP_SHEET = "(function(){var s=document.querySelectorAll('.zen-sheet');return s.length?s[s.length-1]:null})()"
        private const val LIST_TITLE = "Inactive tabs"
        private const val PROMPT_3 = "Close 3 inactive tabs?"
        private const val PROMPT_WORDS = "You can always get them back in History"
        private const val EMPTY_21 = "Tabs you haven't used for 21 days will appear here"
        private const val MOVE_ROW = "Move to inactive"
        private const val AUTO_ROW = "Automatically close inactive tabs"
        private const val AUTO_ROW_ID = "inactive-tabs-auto-close"
    }
}
