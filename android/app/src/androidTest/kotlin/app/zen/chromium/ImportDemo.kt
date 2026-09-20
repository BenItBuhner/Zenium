package app.zen.chromium

import android.content.ContentValues
import android.graphics.Rect
import android.os.Environment
import android.os.Process
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.runner.RunWith
import java.io.File
import java.util.Locale

/**
 * The `android-import-demo` workflow: Settings > Import on a phone (ID-23's Android half) under
 * real fingers. Android has no other browser's profile to read, so the category is two action
 * rows over `dialog.openText`; the demo publishes a Netscape bookmarks HTML and a Chrome-style
 * passwords CSV to the shared Downloads collection, where the system's document picker lists
 * them, and then:
 *
 *  1. Settings > Import: a finger on "Import bookmarks from a file" must bring the system's
 *     open-document picker up; a finger on the HTML file in it hands the file to the core, whose
 *     `UIState.import` must end `done` with the five bookmarks in an "Imported" folder (the bar
 *     already holds one bookmark, so the import lands in a folder as Chrome's does) and the one
 *     repeated URL counted a duplicate. The "Last import" group shows the result; a finger on
 *     "Show imported bookmarks" must open the bookmarks overlay on that folder; a finger on
 *     "Dismiss" must clear the group (`UIState.import` null again).
 *  2. A finger on "Import passwords from a file", the CSV in the picker: four logins added into
 *     a vault the plain Keystore key creates on the way (no device credential on the emulator),
 *     the repeated row a duplicate, the row without a password invalid.
 *  3. The URL field over the page: typing part of an imported bookmark's title must list it,
 *     and the field is closed by the chrome's state ([closeUrlField]) with its outcome asserted.
 *
 * Every control pressed takes a real finger whose result is asserted (the rule in DemoHarness):
 * the app menu's Settings row, the landing's Import category, the two file rows, the result's
 * rows, the overlay's Close. The picker is the system's: its touches are fingers too, on the
 * file's row. What each step found goes to `import-results.json` next to the stills; a claim
 * that failed is listed under `failures` and fails the run after the recording, as a touch that
 * did not take does.
 *
 * Frame stats (Bennett's rule of 2026-09-20: performance is a shipping requirement, every driver
 * run records them): each gesture of the flow is a scene between a `dumpsys gfxinfo <package>
 * reset` and a `framestats` read 1.2 s after its motion settled ([scene]) – the app menu opened
 * under a finger and dismissed with a back first, as the baseline (a sheet main had before this
 * PR, under the Android program's scene names `menu-sheet-open` / `menu-sheet-close` so the
 * numbers read against its table), then the Import page pushed over the Settings landing and
 * popped, each file row's finger up to the picker and the pick's return into the busy row and
 * the result rows, Show imported bookmarks opening the overlay and the overlay's close, Dismiss.
 * The flow opens no sheet of its own: the picker is the system's window (its frames are not
 * this process's), the bookmarks overlay is an overlay. Per scene the total frames, the janky
 * count and share and the 50th / 90th / 99th percentile frame times go to `import-results.json`
 * (`frames`), to a table in `services-import-android-frames.txt` and to the logcat (`FRAMES`
 * lines); the raw dumps to `services-import-android-framestats.txt`. Reported, not gated: the
 * harness's gate on janky frames is the Android program's (PERF-3) and is adopted when it lands.
 */
@RunWith(AndroidJUnit4::class)
class ImportDemo : PageControlsDemo("import-demo-state.json", MEDIA_PREFIX, "import-demo") {
    override val tag = "ImportDemo"

    private val results = JSONObject()
    private val failures = JSONArray()
    private lateinit var frameDumps: File
    /** The gesture scenes in the order they played, for the table and the results. */
    private val frameScenes = ArrayList<FrameScene>()

    /** The seeded profile in the colour scheme of the `theme` argument; no locked page here. */
    override fun patchState(json: String): String = patchTheme(json)

    override fun warmUp() {
        frameDumps = File(out, "$MEDIA_PREFIX-framestats.txt")
        frameDumps.writeText(
            "dumpsys gfxinfo ${app.packageName} framestats, read $SCENE_SETTLE_MS ms after each gesture scene settled (the counters reset before it)\n\n"
        )
        publish(HTML_NAME, "text/html", SAMPLE_HTML)
        publish(CSV_NAME, "text/csv", SAMPLE_CSV)
        warmUpChrome()
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera on the Import section, then close that tab again.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"import"}""")
        val painted = awaitChrome("!!document.querySelector('[data-row=\"$BOOKMARKS_ROW_ID\"]')", 15_000)
        results.put("warmUpSettingsPainted", painted)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        ensureChromeClear()
        SystemClock.sleep(1_000)
    }

    override fun demo() {
        try {
            snap("page")
            baselineScenes()
            bookmarksSection()
            passwordsSection()
            omniboxSection()
        } finally {
            results.put("frames", framesJson())
            results.put("failures", failures)
            File(out, "import-results.json").writeText(results.toString(2))
            File(out, "$MEDIA_PREFIX-frames.txt").writeText(frameTable())
            Log.i(tag, "results: $results")
        }
        // A claim that failed fails the run the way a touch fault does: after the recording, with
        // the app still on screen (the harness's own ending, since `record` is the base class's).
        if (failures.length() > 0) {
            awaitShots()
            File(out, "done").writeText("done\n")
            SystemClock.sleep(4_000)
            throw AssertionError("${failures.length()} claim(s) failed: $failures")
        }
    }

    // --- 0. the baseline scene: the app menu ------------------------------------------------------

    /**
     * The app menu – the sheet main had before this PR – under a finger on the bar's Menu button,
     * settled, then dismissed with a back: the before the PR's scenes read against, as two
     * readings under the Android program's names ([scene]). The menu was opened once already in
     * the warm-up, so this is a warm menu, as the program's baseline is.
     */
    private fun baselineScenes() {
        ensureForeground()
        if (!ensureChromeClear()) {
            fail("the chrome did not clear before the baseline scene")
            return
        }
        SystemClock.sleep(600)
        val opened = scene("menu-sheet-open") {
            tapMenuButton()
            awaitHeld(6_000) { chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) != null }
        }
        claim(opened, "the app menu opened under a finger for the baseline scene")
        if (!opened) {
            ensureChromeClear()
            return
        }
        val closed = scene("menu-sheet-close") {
            back()
            awaitSurface(up = false, timeoutMs = 8_000) && waitForGone(MENU_HANDLE_LABEL, 8_000)
        }
        claim(closed, "the app menu went on a back for the baseline scene")
        ensureChromeClear()
        SystemClock.sleep(600)
    }

    // --- 1. bookmarks from an HTML file ----------------------------------------------------------

    private fun bookmarksSection() {
        val step = JSONObject()
        results.put("bookmarks", step)
        // Settings from the app menu (the flow's finger on the menu's Settings row), on its landing.
        if (!pickMenuItem("Settings", null) { findByLabel(IMPORT_CATEGORY) != null }) {
            fail("Settings did not open from the app menu")
            return
        }
        // The Import page pushed over the landing under a finger on its category and popped with
        // a back, a scene each; then pushed again for the flow (the category scrolled into view
        // first, outside the scene: the landing's list can run past the fold).
        reveal(IMPORT_CATEGORY)
        SystemClock.sleep(600)
        val pushed = scene("settings-import-push") { pushImportPage() }
        step.put("pagePushed", pushed)
        if (!pushed) {
            fail("a finger on the '$IMPORT_CATEGORY' category did not push its page")
            return
        }
        val popped = scene("settings-import-pop") { popImportPage() }
        step.put("pagePopped", popped)
        claim(popped, "a back at the Import page popped it to the Settings landing")
        if (popped) {
            reveal(IMPORT_CATEGORY)
            SystemClock.sleep(600)
            if (!pushImportPage() && !openSettings("Import")) {
                fail("Settings > Import did not open again after the pop")
                return
            }
        }
        step.put("rowShown", revealRow(BOOKMARKS_ROW) != null)
        SystemClock.sleep(800)
        snap("settings-import")

        // A finger on the row: the system's document picker must come to the front. The row's
        // press, its busy state and the app going behind the picker are one scene.
        val pickerUp = scene("import-bookmarks-row-tap") {
            touchTapLabelExpecting(BOOKMARKS_ROW, "the document picker is in front", timeoutMs = 12_000, prefix = true) {
                documentPickerShowing()
            }
        }
        step.put("pickerOpened", pickerUp)
        if (!pickerUp) {
            fail("a finger on '$BOOKMARKS_ROW' brought no document picker")
            return
        }
        // The row is busy while the picker is up (the import runs from the finger on the row).
        step.put("rowBusyUnderPicker", coreState().optJSONObject("import")?.optString("status") == "running")
        SystemClock.sleep(1_500)
        snap("picker-bookmarks-html")
        // The file under a finger in the picker, the app back in front on its busy row, the
        // result rows landing: the return scene, read once the import has ended.
        var picked = false
        var finished: JSONObject? = null
        scene("import-bookmarks-pick-return") {
            picked = pickDocument(HTML_NAME)
            if (!picked) {
                touchFault("the bookmarks HTML file could not be picked in the document picker")
                cancelPicker()
            }
            finished = awaitImportDone(30_000)
            picked && finished != null
        }
        val progress = finished
        step.put("filePicked", picked)
        step.put("progress", progress ?: JSONObject.NULL)
        snap("settings-import-bookmarks-result")
        val outcome = progress?.optJSONObject("results")?.optJSONObject("bookmarks")
        val folderId = progress?.optString("folderId")?.takeIf { it.isNotEmpty() && progress.opt("folderId") != JSONObject.NULL }
        claim(progress?.optString("status") == "done", "the bookmarks import ended done (got ${progress?.optString("status")})")
        claim(outcome?.optInt("imported") == HTML_BOOKMARKS, "$HTML_BOOKMARKS bookmarks imported (got ${outcome?.optInt("imported")})")
        claim(outcome?.optInt("duplicates") == 1, "one duplicate URL skipped (got ${outcome?.optInt("duplicates")})")
        claim(folderId != null, "the bookmarks landed in a folder of their own")
        claim(bookmarkTitled("Lantern Field Notes"), "the imported bookmark is in the core's tree")

        // The result's rows are on screen: a finger on Show imported bookmarks must open the
        // bookmarks overlay on the Imported folder – the overlay's open and its close a scene each.
        if (folderId != null && awaitRow(SHOW_ROW, 8_000) != null) {
            SystemClock.sleep(600)
            val shown = scene("imported-bookmarks-overlay-open") {
                touchTapLabelExpecting(SHOW_ROW, "the bookmarks overlay is up on the imported folder", timeoutMs = 10_000) {
                    chromeSurfaceUp() && overlay() == "bookmarks" && overlayFolderId() == folderId
                }
            }
            step.put("showOpenedOverlay", shown).put("overlay", overlay()).put("overlayFolder", overlayFolderId() ?: JSONObject.NULL)
            snap("bookmarks-imported-folder")
            step.put("folderHeadingShown", findNode { it == IMPORTED_FOLDER } != null)
            val overlayClosed = scene("imported-bookmarks-overlay-close") {
                closeOverlay()
                !chromeSurfaceUp()
            }
            step.put("overlayClosed", overlayClosed)
        } else {
            step.put("showRow", false)
        }

        // Dismiss under a finger: the Last import group goes and the core forgets the result.
        if (awaitRow(DISMISS_ROW, 5_000) == null && openSettings("Import")) revealRow(DISMISS_ROW)
        SystemClock.sleep(600)
        var lingered = false
        val dismissed = scene("last-import-dismiss") {
            val took = touchTapLabelExpecting(DISMISS_ROW, "the last import is dismissed", timeoutMs = 8_000) {
                coreState().isNull("import")
            }
            if (took && !waitForGone(DISMISS_ROW, 5_000)) lingered = true
            took
        }
        step.put("dismissed", dismissed)
        if (lingered) step.put("dismissRowLingered", true)
        snap("settings-import-dismissed")
        Log.i(tag, "bookmarks: $step")
    }

    /**
     * A finger on the landing's Import category: true once the host has the page over the landing
     * (a chrome page's section is a back of the chrome's, `chromeHandlesBack`) and its first row
     * is in the tree.
     */
    private fun pushImportPage(): Boolean =
        touchTapLabelExpecting(IMPORT_CATEGORY, "the Import page is up over the landing", timeoutMs = 10_000) {
            chromeSurfaceUp() && findNode { it.startsWith(BOOKMARKS_ROW) } != null
        }

    /** A back at the Import page: true once the host has no surface and the page's rows have left the tree. */
    private fun popImportPage(): Boolean {
        back()
        return awaitHeld(8_000) { !chromeSurfaceUp() && findNode { it.startsWith(BOOKMARKS_ROW) } == null }
    }

    // --- 2. passwords from a CSV file -------------------------------------------------------------

    private fun passwordsSection() {
        val step = JSONObject()
        results.put("passwords", step)
        if (revealRow(PASSWORDS_ROW) == null && !(openSettings("Import") && revealRow(PASSWORDS_ROW) != null)) {
            fail("no '$PASSWORDS_ROW' row in Settings > Import")
            return
        }
        SystemClock.sleep(600)
        val vaultBefore = coreState().optJSONObject("passwords")
        step.put("vaultBefore", vaultBefore ?: JSONObject.NULL)
        val pickerUp = scene("import-passwords-row-tap") {
            touchTapLabelExpecting(PASSWORDS_ROW, "the document picker is in front", timeoutMs = 12_000, prefix = true) {
                documentPickerShowing()
            }
        }
        step.put("pickerOpened", pickerUp)
        if (!pickerUp) {
            fail("a finger on '$PASSWORDS_ROW' brought no document picker")
            return
        }
        SystemClock.sleep(1_500)
        snap("picker-passwords-csv")
        // The return scene holds the vault's unlock and the CSV's import under the busy row.
        var picked = false
        var finished: JSONObject? = null
        scene("import-passwords-pick-return") {
            picked = pickDocument(CSV_NAME)
            if (!picked) {
                touchFault("the passwords CSV file could not be picked in the document picker")
                cancelPicker()
            }
            finished = awaitImportDone(45_000)
            picked && finished != null
        }
        val progress = finished
        step.put("filePicked", picked)
        step.put("progress", progress ?: JSONObject.NULL)
        snap("settings-import-passwords-result")
        val outcome = progress?.optJSONObject("results")?.optJSONObject("passwords")
        claim(progress?.optString("status") == "done", "the passwords import ended done (got ${progress?.optString("status")}: ${outcome?.optString("error")})")
        claim(outcome?.optInt("imported") == CSV_LOGINS, "$CSV_LOGINS logins imported (got ${outcome?.optInt("imported")})")
        claim(outcome?.optInt("duplicates") == 1, "the repeated CSV row skipped as a duplicate (got ${outcome?.optInt("duplicates")})")
        claim(outcome?.optInt("invalid") == 1, "the row without a password counted invalid (got ${outcome?.optInt("invalid")})")
        val vault = coreState().optJSONObject("passwords")
        step.put("vaultAfter", vault ?: JSONObject.NULL)
        claim(vault?.optInt("count", -1) == CSV_LOGINS, "the vault holds the $CSV_LOGINS logins (count ${vault?.opt("count")})")
        Log.i(tag, "passwords: $step")
        ensureChromeClear()
    }

    // --- 3. the URL field lists an imported bookmark ---------------------------------------------

    private fun omniboxSection() {
        val step = JSONObject()
        results.put("omnibox", step)
        ensureForeground()
        if (!awaitPageActive("example.com", 10_000)) step.put("pageBack", false)
        SystemClock.sleep(800)
        val target = findByLabelPrefix(PILL_LABEL) ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        val opened = awaitUrlbar(open = true, timeoutMs = 8_000)
        step.put("fieldOpened", opened)
        if (!opened) {
            fail("a finger on the address pill did not open the URL field")
            return
        }
        awaitIme(shown = true, timeoutMs = 6_000)
        SystemClock.sleep(600)
        instrumentation.sendStringSync(QUERY)
        val listed = awaitNode(8_000) { it.contains(QUERY_TITLE) && !it.startsWith(QUERY) } != null
        step.put("suggestionListed", listed)
        SystemClock.sleep(1_200)
        snap("urlbar-imported-bookmark")
        claim(listed, "the URL field lists the imported bookmark '$QUERY_TITLE' for '$QUERY'")
        val close = closeUrlField()
        step.put("close", close.describe())
        claim(close.ok, "the URL field's close: ${close.describe()}")
        SystemClock.sleep(1_200)
        snap("page-after")
        Log.i(tag, "omnibox: $step")
    }

    // --- claims -----------------------------------------------------------------------------------

    private fun claim(held: Boolean, what: String) {
        if (held) Log.i(tag, "claim held: $what") else fail(what)
    }

    private fun fail(what: String) {
        Log.e(tag, "CLAIM FAILED: $what")
        failures.put(what)
    }

    // --- frame stats ------------------------------------------------------------------------------

    /**
     * One gesture scene's frames as HWUI counts them for the app's process: the `dumpsys gfxinfo`
     * summary since the reset before the scene – every frame the window drew; the chrome WebView
     * and the page draw through the activity's render thread, so their frames are these – and the
     * times of the frames its `framestats` ring still held at the read, a cross-check on the
     * summary's percentiles (its histogram is 50 ms wide above 100 ms).
     */
    private class FrameStats(
        val total: Int,
        val janky: Int,
        val jankyPercent: Double,
        /** Android 12+'s second count, the pre-12 rule (a frame longer than the vsync period). */
        val jankyLegacy: Int?,
        val p50: Int,
        val p90: Int,
        val p99: Int,
        /** HWUI's `Number …` counters (missed vsync, slow UI thread, slow draw commands, …), the reasons behind the janky count. */
        val reasons: Map<String, Int>,
        /** FrameCompleted − IntendedVsync in ms for the ring's `Flags == 0` frames (the others are first frames or window resizes, out of the count by Android's own rule). */
        val ringMs: List<Double>
    )

    /** A scene as it played: `stats` null when the dump held no summary for this process. */
    private class FrameScene(val name: String, val played: Boolean, val gestureMs: Long, val stats: FrameStats?)

    /**
     * Frame stats around one gesture scene: the process's HWUI counters reset before it
     * (`dumpsys gfxinfo <package> reset`), `body` played – the finger and the wait for what it
     * does, nothing else; no still inside – then [SCENE_SETTLE_MS] for its last frames to land,
     * and the counters read (`… framestats`). The summary's total frames, janky count and share
     * and 50th / 90th / 99th percentile frame times are kept for the results and the table
     * ([framesJson], [frameTable]) and logged as a `FRAMES` line; the raw dump goes to the
     * framestats file. A scene whose motion did not happen (`body` false, or it threw) is read
     * all the same and listed as not played. Answers what `body` answered.
     */
    private fun scene(name: String, body: () -> Boolean): Boolean {
        val pkg = app.packageName
        shell("dumpsys gfxinfo $pkg reset")
        SystemClock.sleep(RESET_SETTLE_MS)
        val started = SystemClock.uptimeMillis()
        var played = false
        try {
            played = body()
        } finally {
            val gestureMs = SystemClock.uptimeMillis() - started
            SystemClock.sleep(SCENE_SETTLE_MS)
            val dump = shell("dumpsys gfxinfo $pkg framestats")
            val stats = parseGfxInfo(dump)
            frameScenes += FrameScene(name, played, gestureMs, stats)
            frameDumps.appendText(
                "=== $name (${if (played) "played" else "NOT played"}, gesture $gestureMs ms, read $SCENE_SETTLE_MS ms after) ===\n$dump\n\n"
            )
            val line = if (stats == null) "no HWUI summary for $pkg in the dump (${dump.length} chars)" else describe(stats, gestureMs)
            Log.i(tag, "FRAMES $name: $line${if (played) "" else " – the scene did not play; not counted"}")
        }
        return played
    }

    /**
     * The HWUI summary for this process out of a `dumpsys gfxinfo <package> framestats` dump
     * (the block headed `Graphics info for pid <ours>` – the WebView's sandboxed renderers carry
     * the package name too and draw no frames of their own) and the frame times out of its
     * PROFILEDATA rings; null without a summary.
     */
    private fun parseGfxInfo(dump: String): FrameStats? {
        val blocks = dump.split("** Graphics info for pid ")
        val mine = blocks.drop(1).firstOrNull { it.startsWith("${Process.myPid()} ") }
            ?: blocks.drop(1).firstOrNull { "Total frames rendered:" in it }
            ?: return null
        fun int(pattern: String): Int? =
            Regex(pattern, RegexOption.MULTILINE).find(mine)?.groupValues?.get(1)?.toIntOrNull()
        val total = int("""^Total frames rendered: (\d+)""") ?: return null
        val janky = Regex("""^Janky frames: (\d+) \((\d+(?:\.\d+)?)%\)""", RegexOption.MULTILINE).find(mine)
        val reasons = LinkedHashMap<String, Int>()
        for (match in Regex("""^Number (.+?): (\d+)""", RegexOption.MULTILINE).findAll(mine)) {
            reasons[match.groupValues[1]] = match.groupValues[2].toInt()
        }
        return FrameStats(
            total = total,
            janky = janky?.groupValues?.get(1)?.toIntOrNull() ?: 0,
            jankyPercent = janky?.groupValues?.get(2)?.toDoubleOrNull() ?: 0.0,
            jankyLegacy = int("""^Janky frames \(legacy\): (\d+) \("""),
            p50 = int("""^50th percentile: (\d+)ms""") ?: -1,
            p90 = int("""^90th percentile: (\d+)ms""") ?: -1,
            p99 = int("""^99th percentile: (\d+)ms""") ?: -1,
            reasons = reasons,
            ringMs = ringFrameTimes(mine)
        )
    }

    /** FrameCompleted − IntendedVsync, in ms, for every `Flags == 0` row of every PROFILEDATA block (the columns found by name: they differ by release). */
    private fun ringFrameTimes(block: String): List<Double> {
        val times = ArrayList<Double>()
        val lines = block.lines()
        var i = 0
        while (i < lines.size) {
            if (lines[i].trim() != "---PROFILEDATA---") {
                i++
                continue
            }
            val header = lines.getOrNull(i + 1)?.split(',')?.map { it.trim() } ?: break
            val flags = header.indexOf("Flags")
            val vsync = header.indexOf("IntendedVsync")
            val done = header.indexOf("FrameCompleted")
            i += 2
            while (i < lines.size && lines[i].trim() != "---PROFILEDATA---") {
                val cells = lines[i].split(',')
                if (flags >= 0 && vsync >= 0 && done >= 0 && cells.size > maxOf(flags, vsync, done)) {
                    val flag = cells[flags].trim().toLongOrNull()
                    val from = cells[vsync].trim().toLongOrNull()
                    val to = cells[done].trim().toLongOrNull()
                    if (flag == 0L && from != null && to != null && to > from) times.add((to - from) / 1_000_000.0)
                }
                i++
            }
            i++
        }
        return times
    }

    /** The ring's frame count and 50th / 90th / 99th percentile times in ms, with how many ran past 16.7 ms; null for an empty ring. */
    private fun ringSummary(ringMs: List<Double>): JSONObject? {
        if (ringMs.isEmpty()) return null
        val sorted = ringMs.sorted()
        fun at(p: Double): Double = sorted[((sorted.size - 1) * p).toInt()]
        return JSONObject()
            .put("frames", sorted.size)
            .put("p50", at(0.5))
            .put("p90", at(0.9))
            .put("p99", at(0.99))
            .put("over16_7", sorted.count { it > 16.7 })
    }

    private fun percent(value: Double): String = "%.1f".format(Locale.US, value)

    private fun describe(s: FrameStats, gestureMs: Long): String {
        val ring = ringSummary(s.ringMs)?.let {
            "; ring ${it.getInt("frames")} frames p50 ${"%.1f".format(Locale.US, it.getDouble("p50"))} " +
                "p90 ${"%.1f".format(Locale.US, it.getDouble("p90"))} p99 ${"%.1f".format(Locale.US, it.getDouble("p99"))} ms, " +
                "${it.getInt("over16_7")} over 16.7"
        } ?: ""
        return "${s.total} frames, ${s.janky} janky (${percent(s.jankyPercent)} %)" +
            (s.jankyLegacy?.let { ", $it by the pre-12 rule" } ?: "") +
            ", p50 ${s.p50} ms, p90 ${s.p90} ms, p99 ${s.p99} ms, gesture $gestureMs ms$ring"
    }

    /** The scenes for `import-results.json`: one object each, in the order they played. */
    private fun framesJson(): JSONArray {
        val list = JSONArray()
        for (scene in frameScenes) {
            val entry = JSONObject().put("scene", scene.name).put("played", scene.played).put("gestureMs", scene.gestureMs)
            val s = scene.stats
            if (s == null) {
                entry.put("summary", JSONObject.NULL)
            } else {
                entry.put("frames", s.total)
                    .put("janky", s.janky)
                    .put("jankyPercent", s.jankyPercent)
                    .put("jankyLegacy", s.jankyLegacy ?: JSONObject.NULL)
                    .put("p50", s.p50)
                    .put("p90", s.p90)
                    .put("p99", s.p99)
                    .put("reasons", JSONObject(s.reasons))
                    .put("ring", ringSummary(s.ringMs) ?: JSONObject.NULL)
            }
            list.put(entry)
        }
        return list
    }

    /**
     * The scenes as one table for `services-import-android-frames.txt`: a fixed-width block, and
     * the same as Markdown for the PR body. The app menu's two scenes are the before (main's
     * sheet), the PR's scenes the after.
     */
    private fun frameTable(): String {
        val sb = StringBuilder()
        sb.append("Frame stats – dumpsys gfxinfo ${app.packageName}: the counters reset before each gesture scene and read $SCENE_SETTLE_MS ms after its motion settled.\n")
        sb.append("frames is every frame the window drew in the scene; janky is HWUI's count of them past their deadline (and its share of the total); p50 / p90 / p99 are its histogram's percentiles in ms (50 ms buckets above 100 ms); gesture is the finger and the wait for what it did, in ms; ring is the framestats ring's own frame times at the read (FrameCompleted - IntendedVsync, Flags == 0), a cross-check.\n")
        sb.append("menu-sheet-open / menu-sheet-close are the baseline: the app menu, a sheet main had before this PR, under a finger and a back, under the Android program's scene names. The flow opens no sheet of its own: the picker is the system's window (its frames are not this process's), the bookmarks overlay is an overlay.\n")
        sb.append("Reported, not gated: the harness's gate on janky frames is the Android program's (PERF-3) and is adopted when it lands. The emulator's software GPU inflates every frame time; the before / after on one recipe is the reading.\n\n")
        sb.append(String.format(Locale.US, "%-34s %7s %16s %8s %8s %8s %9s  %s%n", "scene", "frames", "janky", "p50", "p90", "p99", "gesture", "ring (frames, p50 / p90 / p99 ms, over 16.7)"))
        for (scene in frameScenes) {
            val s = scene.stats
            if (s == null) {
                sb.append(String.format(Locale.US, "%-34s %s%n", scene.name, "no HWUI summary in the dump"))
                continue
            }
            val ring = ringSummary(s.ringMs)?.let {
                "${it.getInt("frames")}, ${"%.1f".format(Locale.US, it.getDouble("p50"))} / ${"%.1f".format(Locale.US, it.getDouble("p90"))} / ${"%.1f".format(Locale.US, it.getDouble("p99"))}, ${it.getInt("over16_7")}"
            } ?: "empty"
            sb.append(
                String.format(
                    Locale.US, "%-34s %7d %16s %5d ms %5d ms %5d ms %6d ms  %s%s%n",
                    scene.name, s.total, "${s.janky} (${percent(s.jankyPercent)} %)", s.p50, s.p90, s.p99, scene.gestureMs, ring,
                    if (scene.played) "" else "  [not played]"
                )
            )
        }
        sb.append("\n| scene | frames | janky | p50 | p90 | p99 | gesture |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n")
        for (scene in frameScenes) {
            val s = scene.stats
            val name = if (scene.played) "`${scene.name}`" else "`${scene.name}` (not played)"
            if (s == null) {
                sb.append("| $name | – | – | – | – | – | ${scene.gestureMs} ms |\n")
                continue
            }
            sb.append("| $name | ${s.total} | ${s.janky} (${percent(s.jankyPercent)} %) | ${s.p50} ms | ${s.p90} ms | ${s.p99} ms | ${scene.gestureMs} ms |\n")
        }
        return sb.toString()
    }

    /** True once `held` answers true, polled every 150 ms for up to `timeoutMs`. */
    private fun awaitHeld(timeoutMs: Long, held: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (held()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(150)
        }
    }

    // --- readings ---------------------------------------------------------------------------------

    /** Poll the core until its import is no longer running; the progress then, or null without one. */
    private fun awaitImportDone(timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var progress: JSONObject? = null
        while (SystemClock.uptimeMillis() < deadline) {
            progress = coreState().optJSONObject("import")
            if (progress != null && progress.optString("status") != "running") return progress
            SystemClock.sleep(300)
        }
        Log.w(tag, "the import did not finish within $timeoutMs ms: $progress")
        return progress
    }

    /**
     * Poll the app's tree for the Settings row starting with `label`, then scroll it into view
     * ([revealRow]); null when none appears within `timeoutMs`. One read is not a verdict here:
     * after the system's document picker has gone, the accessibility service's active window
     * trails the app by a moment (the first recording read the result's rows 30 ms after the
     * picker and found nothing that its still shows).
     */
    private fun awaitRow(label: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (findNode { it.startsWith(label) } != null) return revealRow(label)
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** Whether the core's bookmark tree (`UIState.bookmarks`, every node) holds a bookmark titled `title`. */
    private fun bookmarkTitled(title: String): Boolean {
        val nodes = coreState().optJSONArray("bookmarks") ?: return false
        for (i in 0 until nodes.length()) {
            if (nodes.optJSONObject(i)?.optString("title") == title) return true
        }
        return false
    }

    private fun overlay(): String = chromeJs("(((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).overlay||''").trim('"')

    private fun overlayFolderId(): String? =
        chromeJs("(((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).overlayFolderId||''").trim('"').takeIf { it.isNotEmpty() }

    private fun awaitUrlbar(open: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (urlbarOpen() == open) return true
            SystemClock.sleep(150)
        }
        return urlbarOpen() == open
    }

    private fun awaitPageActive(host: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optString("url").orEmpty().contains(host)) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** True once the chrome's document answers `expression` truthy, within `timeoutMs`. */
    private fun awaitChrome(expression: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeJs("!!($expression)") == "true") return true
            SystemClock.sleep(300)
        }
        return false
    }

    /**
     * Close the bookmarks overlay: its Close control under a finger, whose result is the host
     * dropping the surface; a back while the surface is still up should the tree not show it.
     */
    private fun closeOverlay() {
        if (!chromeSurfaceUp()) return
        if (findNode { it == CLOSE_LABEL } != null) {
            touchTapLabelExpecting(CLOSE_LABEL, "the bookmarks overlay closed", timeoutMs = 6_000) { !chromeSurfaceUp() }
        }
        for (attempt in 1..3) {
            if (!chromeSurfaceUp()) break
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
        }
        SystemClock.sleep(800)
    }

    // --- the system's document picker -----------------------------------------------------------

    private fun documentPickerShowing(): Boolean = pickerRoot() != null

    private fun pickerRoot(): AccessibilityNodeInfo? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() in PICKER_PACKAGES) return root
        }
        return null
    }

    /**
     * In the open-document picker, a finger on the file named `name` (moving to the Downloads
     * root first when Recents does not list it); true once the picker has gone on the touch.
     */
    private fun pickDocument(name: String): Boolean {
        var file = awaitPickerNode(name, 8_000)
        if (file == null) {
            val roots = awaitPickerNode("Show roots", 4_000) ?: return false
            tapRect(roots)
            val downloads = awaitPickerNode("Downloads", 5_000) ?: return false
            tapRect(downloads)
            file = awaitPickerNode(name, 8_000) ?: return false
        }
        SystemClock.sleep(600)
        Log.i(tag, "picker: touching '$name' at $file")
        tapRect(file)
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (!documentPickerShowing()) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "the picker stayed up after the touch on '$name'")
        return false
    }

    /** A picker left up (a file not found): back out of it so the run can go on. */
    private fun cancelPicker() {
        for (attempt in 1..3) {
            if (!documentPickerShowing()) return
            back()
            SystemClock.sleep(1_000)
        }
    }

    private fun tapRect(rect: Rect) {
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(700)
    }

    private fun awaitPickerNode(label: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            pickerNode(label)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** Bounds of the smallest visible picker node whose text or description is `label` (case ignored). */
    private fun pickerNode(label: String): Rect? {
        val root = pickerRoot() ?: return null
        val found = ArrayList<Rect>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            val reads = node.isVisibleToUser && listOf(node.text, node.contentDescription).any {
                it?.toString()?.trim().equals(label, ignoreCase = true)
            }
            if (reads) found += Rect().also(node::getBoundsInScreen)
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found.filter { it.width() > 0 && it.height() > 0 }.minByOrNull { it.width() * it.height() }
    }

    // --- the sample files, published where the picker lists them --------------------------------

    private fun publish(name: String, mime: String, text: String) {
        val resolver = instrumentation.context.contentResolver
        resolver.delete(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            "${MediaStore.Downloads.DISPLAY_NAME} = ?",
            arrayOf(name)
        )
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            Log.w(tag, "could not publish $name")
            return
        }
        resolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
        Log.i(tag, "$name at $uri")
    }

    private companion object {
        /** The stills' and the findings' prefix (`media/services-import-android-*`). */
        const val MEDIA_PREFIX = "services-import-android"
        /** After the counters' reset, before the finger goes in. */
        const val RESET_SETTLE_MS = 400L
        /** After a scene's motion, before the counters are read: its last frames land first. */
        const val SCENE_SETTLE_MS = 1_200L
        val PICKER_PACKAGES = setOf("com.android.documentsui", "com.google.android.documentsui")
        /** The Settings landing's Import category row. */
        const val IMPORT_CATEGORY = "Import"
        const val BOOKMARKS_ROW = "Import bookmarks from a file"
        const val BOOKMARKS_ROW_ID = "import-bookmarks-file"
        const val PASSWORDS_ROW = "Import passwords from a file"
        const val SHOW_ROW = "Show imported bookmarks"
        const val DISMISS_ROW = "Dismiss"
        /** The phone overlay's close control (`aria-label`). */
        const val CLOSE_LABEL = "Close"
        /** `IMPORTED_FOLDER_TITLES.file`: the folder a file import makes when the bar is not empty. */
        const val IMPORTED_FOLDER = "Imported"
        const val HTML_NAME = "zenium-demo-bookmarks.html"
        const val CSV_NAME = "zenium-demo-passwords.csv"
        /** Six links in the HTML, one URL twice: five bookmarks, one duplicate. */
        const val HTML_BOOKMARKS = 5
        /** Six CSV rows: four logins, one repeated (a duplicate), one without a password (invalid). */
        const val CSV_LOGINS = 4
        const val QUERY = "lantern"
        const val QUERY_TITLE = "Lantern Field Notes"
        val SAMPLE_HTML = """
            <!DOCTYPE NETSCAPE-Bookmark-file-1>
            <META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
            <TITLE>Bookmarks</TITLE>
            <H1>Bookmarks</H1>
            <DL><p>
                <DT><H3 ADD_DATE="1788438400" LAST_MODIFIED="1788992800" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
                <DL><p>
                    <DT><A HREF="https://lantern.example/notes" ADD_DATE="1788438400">Lantern Field Notes</A>
                    <DT><H3 ADD_DATE="1788438400">Reading</H3>
                    <DL><p>
                        <DT><A HREF="https://en.wikipedia.org/wiki/Coffee" ADD_DATE="1788438400">Coffee - Wikipedia</A>
                        <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1788438400">MDN Web Docs</A>
                    </DL><p>
                </DL><p>
                <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1788438400">Hacker News</A>
                <DT><A HREF="https://home.cern/" ADD_DATE="1788438400">CERN</A>
                <DT><A HREF="https://home.cern/" ADD_DATE="1788438400">CERN again</A>
            </DL><p>
        """.trimIndent() + "\n"
        val SAMPLE_CSV = """
            name,url,username,password,note
            Example Bank,https://bank.example/login,ada.lovelace@example.com,correct horse battery staple,Sample data for the demo
            Shop,https://shop.example.net/account,ada.lovelace@example.com,password123,
            Mail,https://mail.example.com/,ada.lovelace@example.com,Tr0ub4dor&3-demo,Reused on purpose
            News,https://news.example.org/,ada,letmein2024,
            Shop,https://shop.example.net/account,ada.lovelace@example.com,password123,
            Broken,https://broken.example/,ada,,
        """.trimIndent() + "\n"
    }
}
