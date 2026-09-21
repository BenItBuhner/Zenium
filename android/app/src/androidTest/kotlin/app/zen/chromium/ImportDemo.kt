package app.zen.chromium

import android.content.ContentValues
import android.graphics.Rect
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.runner.RunWith
import java.io.File

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
 * run records them; the harness's instrument since PERF-3, #268): each gesture of the flow is a
 * scene through [scene] over `DemoHarness.traceFrames` – HWUI's counters reset before it, the
 * finger and the wait for what it does inside the measured block with 1.2 s for the motion's
 * last frames to land, the `dumpsys gfxinfo framestats` read after, and the chrome WebView's
 * Blink trace around it (the renderer main thread's layouts, paints and time per frame: the
 * numbers that carry over to a phone; the software GPU's frame times are reported, never gated).
 * The app menu opened under a finger and dismissed with a back comes first, as the before (a
 * sheet main had before this PR, under the Android program's scene names `menu-sheet-open` /
 * `menu-sheet-close` so the numbers read against its table), then the Import page pushed over
 * the Settings landing and popped, each file row's finger up to the picker and the pick's return
 * into the busy row and the result rows, Show imported bookmarks opening the overlay and the
 * overlay's close, Dismiss. The flow opens no sheet of its own: the picker is the system's window
 * (its frames are not this process's), the bookmarks overlay is an overlay. The record is the
 * harness's – `frames.jsonl` (one line per scene), `frames.txt` (the tables), `framestats-<scene>.txt`
 * (the raw dumps), `trace-<scene>.json.gz`, the `FRAMES` logcat lines and the workflow's job
 * summary –; `import-results.json` adds under `frames` whether each scene played. No scene names
 * a baseline: the flow has no same motion with the chrome's part removed, so the ratios stay
 * null and the menu's two scenes are the reading's before, not a gate's; the gate is the shared
 * workflow's `jank-gate` (soft by default: reported, not failed).
 */
@RunWith(AndroidJUnit4::class)
class ImportDemo : PageControlsDemo("import-demo-state.json", MEDIA_PREFIX, "import-demo") {
    override val tag = "ImportDemo"

    private val results = JSONObject()
    private val failures = JSONArray()
    /** Each scene in the order it was measured, with whether its motion happened (`import-results.json`'s `frames`). */
    private val scenesPlayed = JSONArray()

    /** The seeded profile in the colour scheme of the `theme` argument; no locked page here. */
    override fun patchState(json: String): String = patchTheme(json)

    override fun warmUp() {
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
            results.put("frames", scenesPlayed)
            results.put("failures", failures)
            File(out, "import-results.json").writeText(results.toString(2))
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
     * `open` readings under the Android program's names ([scene]; SheetRecedeDemo measures the
     * same two). The menu was opened once already in the warm-up, so this is a warm menu, as the
     * program's baseline is.
     */
    private fun baselineScenes() {
        ensureForeground()
        if (!ensureChromeClear()) {
            fail("the chrome did not clear before the baseline scene")
            return
        }
        SystemClock.sleep(600)
        val opened = scene("menu-sheet-open", JankBudget.Kind.OPEN) {
            tapMenuButton()
            awaitHeld(6_000) { chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) != null }
        }
        claim(opened, "the app menu opened under a finger for the baseline scene")
        if (!opened) {
            ensureChromeClear()
            return
        }
        val closed = scene("menu-sheet-close", JankBudget.Kind.OPEN) {
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
        val pushed = scene("settings-import-push", JankBudget.Kind.OPEN) { pushImportPage() }
        step.put("pagePushed", pushed)
        if (!pushed) {
            fail("a finger on the '$IMPORT_CATEGORY' category did not push its page")
            return
        }
        val popped = scene("settings-import-pop", JankBudget.Kind.OPEN) { popImportPage() }
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
            val shown = scene("imported-bookmarks-overlay-open", JankBudget.Kind.OPEN) {
                touchTapLabelExpecting(SHOW_ROW, "the bookmarks overlay is up on the imported folder", timeoutMs = 10_000) {
                    chromeSurfaceUp() && overlay() == "bookmarks" && overlayFolderId() == folderId
                }
            }
            step.put("showOpenedOverlay", shown).put("overlay", overlay()).put("overlayFolder", overlayFolderId() ?: JSONObject.NULL)
            snap("bookmarks-imported-folder")
            step.put("folderHeadingShown", findNode { it == IMPORTED_FOLDER } != null)
            val overlayClosed = scene("imported-bookmarks-overlay-close", JankBudget.Kind.OPEN) {
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
     * One gesture scene of the flow through the harness's instrument (`DemoHarness.traceFrames`,
     * PERF-3): HWUI's counters reset before it; `body` – the finger and the wait for what it does,
     * nothing else, no still inside – then [SCENE_SETTLE_MS] inside the measured block for the
     * motion's last frames to land; the `framestats` dump read after, and the chrome WebView's
     * Blink trace around the block. `kind` picks the budget: a surface coming up or going is an
     * `open` (the menu, the Import page's push and pop, the overlay), a finger's press with what
     * it brings is a `gesture` (the file rows up to the picker, the pick's return into the result
     * rows, Dismiss). The record is the harness's; this driver keeps whether the scene played
     * (`body` true) beside it in `import-results.json`, since a scene whose motion did not happen
     * – `body` false, or it threw – is read all the same and must not pass as one that did.
     * Answers what `body` answered; rethrows what it threw once the frames are written down.
     */
    private fun scene(name: String, kind: JankBudget.Kind = JankBudget.Kind.GESTURE, body: () -> Boolean): Boolean {
        SystemClock.sleep(RESET_SETTLE_MS)
        var played = false
        var thrown: Throwable? = null
        val measured = traceFrames(name, kind) {
            try {
                played = body()
            } catch (e: Throwable) {
                thrown = e
            }
            SystemClock.sleep(SCENE_SETTLE_MS)
        }
        val summary = measured.summary
        scenesPlayed.put(
            JSONObject()
                .put("scene", name)
                .put("kind", kind.key)
                .put("played", played)
                .put("durationMs", measured.durationMs)
                .put("frames", summary?.frames ?: JSONObject.NULL)
                .put("jankyShare", summary?.jankyShare ?: JSONObject.NULL)
                .put("verdict", if (measured.verdict.within) "within" else "over")
                .put("traced", measured.trace != null)
        )
        if (!played) Log.w(tag, "FRAMES $name: the scene did not play (${thrown?.let { "${it.javaClass.simpleName}: ${it.message}" } ?: "its motion did not happen"}); its frames are read all the same")
        thrown?.let { throw it }
        return played
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
        /** Before a scene: the previous one's last frames land outside the next reading. */
        const val RESET_SETTLE_MS = 400L
        /** After a scene's motion, inside its measured block: its last frames land before the counters are read. */
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
