package app.zen.chromium

import android.graphics.PointF
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * OMN-15, the tab group suggestion (W6-E14), under a REAL finger, for the
 * `android-omnibox-group-suggestion-demo` workflow – three scenes, each with its claim read off
 * the chrome's DOM or the core's state, never off the still alone:
 *
 *  1. Typing the start of a group's name ("res" for the seeded group Research) puts the group's
 *     row on the card among the other rows: the `folder` kind, the one group glyph in the group's
 *     colour (§9.36 / §9.37: the 10 dot), the name, the members' sites comma-separated, the →
 *     that says it goes somewhere; on the phone the row stands in the section that reads Chrome's
 *     "Tabs and tab groups" (`IDS_OMNIBOX_HUB_TYPED_MATCH_HEADER`) beside the open tab whose title
 *     starts the same way, under Pages and Searches; on the tablet the list's row carries the
 *     "Open tab group" hint where a tab row says "Switch to tab". The row's spoken sentence is
 *     Chrome's: "Open Research tab group, colour Blue, with sites <sites>."
 *  2. A REAL touch on the row is the pick: the core's `folder.open` – the group unfolded, its
 *     first page the active tab – and the field closes onto the page, as every pick does.
 *  3. The group closed (`folder.close`: its tabs gone, its pages kept), a word from a member
 *     page's address ("cit", the citations page) offers the SAVED group – the glyph the 10 ring
 *     at a 2 stroke, the matching site first – and the touch brings its pages back as its tabs
 *     with the first of them up.
 *
 * The provider runs per keystroke over the model's folders and their members, never at boot:
 * `SuggestionService.folderRows` (core/suggestions.ts) is called from `rows()`, which the chrome
 * asks on each change of the field; the boot path (P0) is untouched.
 *
 * Two sites of the driver's own on the loopback ([DemoServer]): 127.0.0.1 is the seeded default
 * engine's (its suggest endpoint answers the Searches rows) and the group's first page's,
 * 127.0.0.2 the second member's, the loose tab's and the seeded history's. Findings in
 * `android-omnibox-group-suggestion-findings.txt` next to the frames; the run FAILS when a claim
 * does not hold, and a touch that does not take is a fault ([DemoHarness.touchTapLabelExpecting]).
 * See [DemoHarness] for the plumbing and its rule on real touches versus accessibility clicks.
 */
@RunWith(AndroidJUnit4::class)
class OmniboxGroupSuggestionDemo : DemoHarness("omnibox-group-suggestion-demo-state.json", "android-omnibox-group-suggestion", "omnibox-group-suggestion-demo") {
    override val tag = "OmniboxGroupSuggestionDemo"
    private lateinit var notes: DemoServer
    private lateinit var refs: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var formFactor = "phone"

    @Test
    fun record() {
        notes = DemoServer(PORT, notesRoutes()).also { it.start() }
        refs = DemoServer(PORT, refsRoutes(), address = REFS_HOST).also { it.start() }
        try {
            runDemo()
        } finally {
            if (THEME == "dark") shell("cmd uimode night no")
            notes.close()
            refs.close()
        }
        if (failures.isNotEmpty()) error("the tab group suggestion did not hold up under a finger: ${failures.joinToString("; ")}")
    }

    /** The theme the profile is born in. */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The history the query's Pages rows come from: two pages whose titles start with "Res", one that never matches. */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = STAMP.replace(readAsset("omnibox-group-suggestion-demo-history.json")) { m ->
            val hours = m.groupValues[1].toLongOrNull() ?: 0L
            (now - hours * 3_600_000L).toString()
        }
        File(zen, "history.json").writeText(history)
    }

    /** The system's colour scheme before the app starts, so the app is born in it (the omnibox polish demo's lesson). */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-omnibox-group-suggestion-findings.txt")
        findings.writeText(
            "Zenium Android omnibox tab group suggestion check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n" +
                "sites: ${notes.selfCheck()}; ${refs.selfCheck()}\n\n"
        )
        val loaded = awaitChrome("true", 1_000) && awaitPageUrl(HOME_URL, 20_000)
        formFactor = chromeValue("document.documentElement.dataset.formFactor||''").ifEmpty { "phone" }
        finding("warm-up: the seeded page ${if (loaded) "is up" else "did NOT report complete"}; form factor $formFactor")
        // The first open pays for the editor's layout and the suggestions' first fetch: off camera.
        tapPill()
        val field = awaitField(8_000)
        SystemClock.sleep(1_000)
        closeField()
        settle(6_000)
        finding("warm-up: the editor opened once off camera (field ${if (field) "seen" else "NOT seen"})")
    }

    override fun demo() {
        // 1. The row, typed.
        step("OMN-15 typing a group's name offers the group among the other rows") {
            if (!showHomePage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 4_000)
            SystemClock.sleep(600)
            instrumentation.sendStringSync(QUERY)
            val offered = awaitChrome(
                "document.querySelector('$GROUP_ROW')&&(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(QUERY)}&&!document.querySelector('$ROWS_LEAVING')",
                15_000
            )
            // The emulator's software GPU trails the DOM by a second or two: the still after it has caught up.
            SystemClock.sleep(2_500)
            shot("01-group-row-typed")
            val card = readCard()
            val row = card.groupRow()
            finding("  typed '$QUERY'; rows from the field outward: ${card.rows.joinToString(" | ") { "${it.kind} '${it.title}'" + (if (it.section.isNotEmpty()) " [${it.section}]" else "") }}")
            if (card.headings.isNotEmpty()) finding("  headings: ${card.headings.joinToString(" | ")}")
            if (row == null) {
                failures += "typing '$QUERY' offered no tab group row (rows ${card.rows.joinToString { it.kind }})"
                return@step
            }
            finding("  the group row: title '${row.title}', sites '${row.subtitle}', glyph ${row.glyph} (saved ${row.saved}, rgb '${row.rgb}'), hint '${row.hint}', section '${row.section}', ${"%.0f".format(row.height)} CSS px tall")
            finding("  spoken: '${row.label}'")
            val tabRow = card.rows.firstOrNull { it.kind == "tab" }
            val named = row.title == GROUP_NAME
            val sites = row.subtitle == "$NOTES_SITE, $REFS_SITE"
            val glyph = row.glyph && !row.saved && row.rgb.isNotEmpty()
            val label = row.label == "Open $GROUP_NAME tab group, colour Blue, with sites $NOTES_SITE, $REFS_SITE."
            val amongOthers = card.rows.any { it.kind == "search" } && card.rows.any { it.kind == "history" } && tabRow != null
            // §4: a suggestion row stays one line – the group row as tall as the open tab's row beside it, and never under the 44 touch floor.
            val oneLine = row.height >= 44.0 && tabRow != null && Math.abs(row.height - tabRow.height) < 1.0
            val placed = if (formFactor == "tablet") {
                row.hint == "Open tab group" && tabRow?.hint == "Switch to tab"
            } else {
                row.section == TABS_AND_GROUPS && card.headings.contains(TABS_AND_GROUPS) && !card.headings.contains("Open tabs") &&
                    tabRow?.section == TABS_AND_GROUPS
            }
            val under = tabRow != null && card.rows.indexOf(tabRow) < card.rows.indexOf(row)
            finding("  the group's name $named; the members' sites $sites; the group glyph (the dot, coloured) $glyph; one line as the tab row's ${"%.0f".format(tabRow?.height ?: 0.0)} $oneLine ${verdict(named && sites && glyph && oneLine)}")
            finding("  Chrome's spoken sentence $label ${verdict(label)}")
            finding("  among search, history and open tab rows $amongOthers; ${if (formFactor == "tablet") "the list's hints Open tab group / Switch to tab" else "sectioned under '$TABS_AND_GROUPS' with the open tab"} $placed; under the open tab $under ${verdict(offered && amongOthers && placed && under)}")
            if (!named || !sites || !glyph || !oneLine) failures += "the group row is not composed as designed (title '${row.title}', sites '${row.subtitle}', glyph ${row.glyph}/${row.saved}/'${row.rgb}', ${row.height} tall)"
            if (!label) failures += "the group row's spoken sentence is not Chrome's ('${row.label}')"
            if (!offered || !amongOthers || !placed || !under) failures += "the group row does not stand where Chrome's does (headings ${card.headings}, section '${row.section}', hint '${row.hint}')"
        }

        // 2. The pick.
        step("OMN-15 the touch on the row opens the group") {
            if (!fieldUp() || fieldValue() != QUERY) {
                if (!fieldUp()) {
                    showHomePage()
                    if (!openField()) error("the pill's tap opened no field")
                    awaitIme(shown = true, timeoutMs = 4_000)
                } else if (fieldValue().isNotEmpty()) {
                    touchTapLabel(CLEAR_LABEL, timeoutMs = 4_000)
                }
                SystemClock.sleep(600)
                instrumentation.sendStringSync(QUERY)
                awaitChrome("document.querySelector('$GROUP_ROW')&&!document.querySelector('$ROWS_LEAVING')", 12_000)
                SystemClock.sleep(1_000)
            }
            val before = coreState()
            finding("  before the touch: active tab '${activeCoreTab(before)?.optString("id")}', the group collapsed ${folder(before)?.optBoolean("collapsed")}")
            // THE touch: the row, found by its spoken sentence; it took once the group's first page is up.
            val took = touchTapLabelExpecting("Open $GROUP_NAME tab group", "the group's first page is the active tab and the group is unfolded", timeoutMs = 8_000, prefix = true) { groupOpened() }
            val closed = awaitChrome("!document.querySelector('$FIELD')", 8_000)
            val landed = awaitPageUrl(PAPERS_URL, 10_000)
            SystemClock.sleep(2_000)
            shot("02-group-opened")
            val after = coreState()
            val active = activeCoreTab(after)
            finding("  the touch ${if (took) "took" else "did NOT take"}; field closed $closed; active tab '${active?.optString("id")}' at '${active?.optString("url")}' (loaded $landed); the group collapsed ${folder(after)?.optBoolean("collapsed")}, lastUsedAt set ${folder(after)?.has("lastUsedAt")} ${verdict(took && closed && landed)}")
            if (!took || !closed || !landed) failures += "the touch on the group row did not open the group (took $took, field closed $closed, first page up $landed)"
        }

        // 3. The saved group, offered by a member page's address.
        step("OMN-15 a saved group is offered by a member page's address, and the touch brings its pages back") {
            if (!showHomePage()) error("the demo page is not the active tab")
            coreInvoke("folder.close", "{\"folderId\":${JSONObject.quote(FOLDER_ID)}}")
            val saved = awaitTrue(8_000) {
                val s = coreState()
                folder(s)?.optJSONArray("savedTabs")?.length() == 2 && memberTabs(s).isEmpty()
            }
            SystemClock.sleep(800)
            ensureForeground()
            finding("  folder.close: the group's tabs gone and its two pages kept $saved")
            if (!saved) error("folder.close left the group live (members ${memberTabs(coreState())})")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 4_000)
            SystemClock.sleep(600)
            instrumentation.sendStringSync(SAVED_QUERY)
            val offered = awaitChrome(
                "document.querySelector('$SAVED_GLYPH')&&(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(SAVED_QUERY)}&&!document.querySelector('$ROWS_LEAVING')",
                15_000
            )
            SystemClock.sleep(2_500)
            shot("03-saved-group-row")
            val card = readCard()
            val row = card.groupRow()
            finding("  typed '$SAVED_QUERY'; rows: ${card.rows.joinToString(" | ") { "${it.kind} '${it.title}'" }}")
            if (row == null) {
                failures += "typing '$SAVED_QUERY' offered no saved group row (rows ${card.rows.joinToString { it.kind }})"
                return@step
            }
            finding("  the saved group's row: title '${row.title}', sites '${row.subtitle}', glyph ${row.glyph} (saved ${row.saved}); spoken '${row.label}'")
            val ring = row.glyph && row.saved
            val first = row.subtitle == "$REFS_SITE, $NOTES_SITE"
            finding("  offered by the citations page's address $offered; the ring (a saved group) $ring; the matching site first $first ${verdict(offered && ring && first)}")
            if (!offered || !ring || !first) failures += "the saved group's row is not composed as designed (glyph ${row.glyph}/${row.saved}, sites '${row.subtitle}')"
            val took = touchTapLabelExpecting("Open $GROUP_NAME tab group", "the group's pages are back as its tabs and the first is up", timeoutMs = 10_000, prefix = true) { groupOpened() && memberTabs(coreState()).size == 2 }
            val closed = awaitChrome("!document.querySelector('$FIELD')", 8_000)
            val landed = awaitPageUrl(PAPERS_URL, 12_000)
            SystemClock.sleep(2_000)
            shot("04-saved-group-opened")
            val after = coreState()
            finding("  the touch ${if (took) "took" else "did NOT take"}; field closed $closed; members back ${memberTabs(after)}; active '${activeCoreTab(after)?.optString("url")}' (loaded $landed); kept pages now ${folder(after)?.optJSONArray("savedTabs")?.length() ?: 0} ${verdict(took && closed && landed)}")
            if (!took || !closed || !landed) failures += "the touch on the saved group's row did not bring its pages back (took $took, field closed $closed, first page up $landed)"
        }

        finding("\nend: ${failures.size} failure(s)")
    }

    // --- the card ---------------------------------------------------------------------------------

    private class Row(val kind: String, val title: String, val subtitle: String, val section: String, val glyph: Boolean, val saved: Boolean, val rgb: String, val label: String, val hint: String, val height: Double)

    private class Card(val headings: List<String>, val rows: List<Row>) {
        fun groupRow(): Row? = rows.firstOrNull { it.kind == "folder" }
    }

    /** The card as it stands, from the field outward: the headings' labels and every row that is not on its way out. */
    private fun readCard(): Card {
        val json = runCatching { JSONObject(chromeValue(CARD_JS).ifEmpty { "{}" }) }.getOrElse { JSONObject() }
        val headings = json.optJSONArray("headings") ?: JSONArray()
        val rows = json.optJSONArray("rows") ?: JSONArray()
        return Card(
            (0 until headings.length()).map { headings.getString(it) },
            (0 until rows.length()).map { i ->
                val r = rows.getJSONObject(i)
                Row(
                    r.optString("kind"), r.optString("title"), r.optString("subtitle"), r.optString("section"),
                    r.optBoolean("glyph"), r.optBoolean("saved"), r.optString("rgb"), r.optString("label"), r.optString("hint"), r.optDouble("h", 0.0)
                )
            }
        )
    }

    // --- the core ---------------------------------------------------------------------------------

    /** The seeded group as the core's snapshot has it (`folders` is a record by id), or null once deleted. */
    private fun folder(state: JSONObject): JSONObject? = state.optJSONObject("folders")?.optJSONObject(FOLDER_ID)

    /** The ids of the tabs the core has in the group (`tabs` is a record by id), in the space's order. */
    private fun memberTabs(state: JSONObject): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        val ids = ArrayList<String>()
        val spaces = state.optJSONArray("spaces") ?: JSONArray()
        for (i in 0 until spaces.length()) {
            val tabIds = spaces.getJSONObject(i).optJSONArray("tabIds") ?: continue
            for (j in 0 until tabIds.length()) {
                val id = tabIds.getString(j)
                if (tabs.optJSONObject(id)?.optString("folderId") == FOLDER_ID) ids += id
            }
        }
        return ids
    }

    /** `folder.open` has run: the group unfolded and one of its pages the active tab. */
    private fun groupOpened(): Boolean {
        val s = runCatching { coreState() }.getOrNull() ?: return false
        val f = folder(s) ?: return false
        val active = activeCoreTab(s) ?: return false
        return !f.optBoolean("collapsed", false) && active.optString("folderId") == FOLDER_ID
    }

    // --- the pill, the field, the page --------------------------------------------------------------

    /**
     * A finger on the address pill: on the phone where the harness's [pillPoint] says (the tree's
     * `Address, <site>` button, the measured pill when the tree is stale); on the tablet the
     * toolbar's pill by its own name – a group labelled `Address` alone (SidebarTop), at the top
     * of the window, which [pillPoint] does not know: it looks for the phone's comma-suffixed
     * button and falls back to the phone's measured bottom pill, and the first tablet run's every
     * tap landed on the page under it. The LayoutDemo's `findByLabelPrefix(PILL_LABEL)`, guarded
     * by the touchable band as [pillPoint] is.
     */
    private fun tapPill() {
        val p = if (formFactor == "tablet") tabletPillPoint() else pillPoint()
        Finger().tap(p.x, p.y)
    }

    private fun tabletPillPoint(): PointF {
        ensureForeground()
        val found = findByLabelPrefix(PILL_LABEL)
        if (found != null && touchable.contains(found.centerX(), found.centerY())) return PointF(found.exactCenterX(), found.exactCenterY())
        Log.w(tag, "the tablet toolbar's pill is not in the tree where a finger can reach it ($found, touchable $touchable); the harness's pill point")
        return pillPoint()
    }

    private fun openField(): Boolean {
        settle(8_000)
        tapPill()
        if (awaitField(8_000)) return true
        finding("  the pill's tap opened no field in 8 s (bar open ${urlbarOpen()}); the pill again")
        settle(6_000)
        tapPill()
        return awaitField(8_000)
    }

    private fun awaitField(timeoutMs: Long): Boolean = awaitChrome("!!document.querySelector('$FIELD')", timeoutMs)

    private fun fieldUp(): Boolean = chromeValue("String(!!document.querySelector('$FIELD'))") == "true"

    private fun fieldValue(): String = chromeValue("(document.querySelector('$FIELD')||{}).value||''")

    /** The chrome at rest between scenes: the store's word on the field agreeing with the DOM's, no sheet up. */
    private fun settle(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(150)
        }
        val ok = settled()
        if (!ok) Log.w(tag, "the chrome did not settle in $timeoutMs ms: bar open ${urlbarOpen()}, field up ${fieldUp()}")
        return ok
    }

    private fun settled(): Boolean {
        val storeOpen = "((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true)"
        return chromeValue("String(($storeOpen===!!document.querySelector('$FIELD'))&&document.querySelectorAll('.zen-sheet').length===0)") == "true"
    }

    /** The shared close of the field (DemoHarness.closeUrlField, by the chrome's state); a field left open fails the run by name. */
    private fun closeField() {
        val close = closeUrlField()
        if (!close.ok) {
            finding("  the field's close: ${close.describe()} ${verdict(false)}")
            failures += "the field's close: ${close.describe()}"
        }
    }

    /** The seeded demo page (`tab_home`) as the active tab, the field closed. */
    private fun showHomePage(): Boolean {
        settle(8_000)
        closeField()
        settle(8_000)
        if (activeCoreTab()?.optString("id") != HOME_TAB_ID) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(HOME_TAB_ID)}}")
            SystemClock.sleep(800)
        }
        val there = awaitPageUrl(HOME_URL, 10_000)
        SystemClock.sleep(600)
        ensureForeground()
        return there
    }

    private fun awaitPageUrl(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val at = runCatching { activeCoreTab()?.optString("url") }.getOrNull().orEmpty()
            if (at == url) return true
            SystemClock.sleep(300)
        }
        return false
    }

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    // --- the chrome -------------------------------------------------------------------------------

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

    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
            // Whatever the step left up (the editor, a sheet) goes before the next one.
            ensureForeground()
            for (i in 1..4) {
                settle(6_000)
                if (!chromeSurfaceUp() && !urlbarOpen() && !fieldUp() && findByLabelPrefix(PILL_LABEL) != null) break
                back()
                SystemClock.sleep(1_000)
            }
            settle(8_000)
        }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the two sites ----------------------------------------------------------------------------

    /** The seeded default engine's site: the demo page, the group's first page, the engine's endpoints. */
    private fun notesRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Group suggestion demo", "<p>Type the start of a tab group's name in the address bar to be offered the group.</p>"),
        "/papers.html" to html("Papers to read", "<p>The Research group's first page.</p>"),
        "/guide.html" to html("Getting started guide", "<p>A page in the history that never matches.</p>"),
        "/search" to results("Notes"),
        "/suggest" to suggestions("research methods", "restaurant near me", "reset password")
    )

    /** The second site: the group's second page, the loose tab's page and the history's pages. */
    private fun refsRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Refs", "<p>An index.</p>"),
        "/citations.html" to html("Citation graph", "<p>The Research group's second page.</p>"),
        "/reviews.html" to html("Restaurant reviews", "<p>The loose tab whose title starts the same way.</p>"),
        "/reservoir.html" to html("Reservoir levels this week", "<p>A page in the history.</p>"),
        "/rescue.html" to html("Rescue dog adoption", "<p>Another page in the history.</p>")
    )

    private fun html(title: String, body: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}</style></head><body><h1>$title</h1>$body</body></html>"
            ).toByteArray()

    /** A results page that names the query it was asked (from `?q=`). */
    private fun results(site: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$site</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}</style></head><body><h1>$site</h1><p id=q></p>" +
                "<script>var q=new URLSearchParams(location.search).get('q')||'';document.title='$site: '+q;" +
                "document.getElementById('q').textContent='Results for \"'+q+'\"';</script></body></html>"
            ).toByteArray()

    /** The engine's suggest endpoint: the same rows whatever the query (the shape the core parses). */
    private fun suggestions(vararg rows: String): Pair<String, ByteArray> =
        "application/json; charset=utf-8" to
            ("[\"\",[" + rows.joinToString(",") { JSONObject.quote(it) } + "]]").toByteArray()

    companion object {
        private const val PORT = 18191
        private const val REFS_HOST = "127.0.0.2"
        private const val NOTES_SITE = "127.0.0.1:$PORT"
        private const val REFS_SITE = "127.0.0.2:$PORT"
        private const val HOME_URL = "http://$NOTES_SITE/"
        private const val PAPERS_URL = "http://$NOTES_SITE/papers.html"
        /** The seeded tabs and group (omnibox-group-suggestion-demo-state.json). */
        private const val HOME_TAB_ID = "tab_home"
        private const val FOLDER_ID = "folder_research"
        private const val GROUP_NAME = "Research"
        /** The typed starts: the group's name, then a word of its second page's address. */
        private const val QUERY = "res"
        private const val SAVED_QUERY = "cit"
        /** Chrome's heading for the section the open tabs and the tab groups share (`IDS_OMNIBOX_HUB_TYPED_MATCH_HEADER`; `TABS_AND_GROUPS_GROUP` in core/suggestions.ts). */
        private const val TABS_AND_GROUPS = "Tabs and tab groups"
        /** The field's clear button, there once something is typed. */
        private const val CLEAR_LABEL = "Clear"
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)h)?\\}\\}\"")
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /**
         * The chrome's DOM: the field; the group row; a row on its way out; the saved group's ring
         * in the group row – each on the phone's sheet or the tablet's list. Each is a selector
         * LIST with the condition spelled on every alternative: appended once to a list it binds to
         * the last alternative only (`ROWS[data-leaving]` read as "any sheet row, or a leaving list
         * row" – the first run's two false failures, the card itself composed as designed).
         */
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val GROUP_ROW = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-kind=\"folder\"]:not([data-leaving]), #zen-omnibox-results > li[data-kind=\"folder\"]"
        private const val ROWS_LEAVING = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-leaving], #zen-omnibox-results > li[data-leaving]"
        private const val SAVED_GLYPH = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-kind=\"folder\"]:not([data-leaving]) [data-testid=\"group-row-glyph\"][data-saved], " +
            "#zen-omnibox-results > li[data-kind=\"folder\"] [data-testid=\"group-row-glyph\"][data-saved]"

        /**
         * The card as it stands, from the field outward on either chassis: the headings (the
         * phone's sections) and every row not on its way out – its kind, title, subtitle (the
         * sheet's second span, or the list's ` — host` with the dash off), section, whether it
         * wears the group glyph (and the ring of a saved group, and its colour pair), the option's
         * spoken label, the list row's trailing hint and its height in CSS px.
         */
        private val CARD_JS = """
            (function () {
              var list = document.querySelector('.zen-omnibox-sheet [role="listbox"]') || document.getElementById('zen-omnibox-results');
              if (!list) return '{}';
              var items = Array.prototype.slice.call(list.children).filter(function (el) { return !el.hasAttribute('data-leaving'); });
              var headings = items.filter(function (el) { return el.getAttribute('data-testid') === 'urlbar-group-heading'; });
              var rows = items.filter(function (el) { return el.getAttribute('data-testid') !== 'urlbar-group-heading'; });
              function text(el) { return el ? el.textContent.trim() : ''; }
              return JSON.stringify({
                headings: headings.map(function (h) { return h.textContent.trim(); }),
                rows: rows.map(function (r) {
                  var glyph = r.querySelector('[data-testid="group-row-glyph"]');
                  var option = r.querySelector('[role="option"]');
                  var host = text(r.querySelector('.zen-omnibox-row-host')).replace(/^\u2014\s*/, '');
                  return {
                    kind: r.getAttribute('data-kind') || '?',
                    title: text(r.querySelector('[data-testid="urlbar-row-title"], .zen-omnibox-row-title')),
                    subtitle: r.querySelector('[data-testid="urlbar-row-subtitle"]') ? text(r.querySelector('[data-testid="urlbar-row-subtitle"]')) : host,
                    section: r.getAttribute('data-section') || '',
                    glyph: !!glyph,
                    saved: !!(glyph && glyph.hasAttribute('data-saved')),
                    rgb: glyph ? glyph.style.getPropertyValue('--zen-group-rgb-light').trim() : '',
                    label: option ? (option.getAttribute('aria-label') || '') : '',
                    hint: text(r.querySelector('.zen-omnibox-row-hint')),
                    h: r.getBoundingClientRect().height
                  };
                })
              });
            })()
        """.trimIndent()
    }
}
