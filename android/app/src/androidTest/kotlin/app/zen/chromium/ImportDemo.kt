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
 * Every control pressed takes a real finger whose result is asserted (the rule in DemoHarness);
 * the tree's click only opens the Settings tab and its Import section, which are pages. The
 * picker is the system's: its touches are fingers too, on the file's row. What each step found
 * goes to `import-results.json` next to the stills; a claim that failed is listed under
 * `failures` and fails the run after the recording, as a touch that did not take does.
 */
@RunWith(AndroidJUnit4::class)
class ImportDemo : PageControlsDemo("import-demo-state.json", "services-import-android", "import-demo") {
    override val tag = "ImportDemo"

    private val results = JSONObject()
    private val failures = JSONArray()

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
            bookmarksSection()
            passwordsSection()
            omniboxSection()
        } finally {
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

    // --- 1. bookmarks from an HTML file ----------------------------------------------------------

    private fun bookmarksSection() {
        val step = JSONObject()
        results.put("bookmarks", step)
        if (!openSettings("Import")) {
            fail("Settings > Import did not open")
            return
        }
        step.put("rowShown", revealRow(BOOKMARKS_ROW) != null)
        SystemClock.sleep(800)
        snap("settings-import")

        // A finger on the row: the system's document picker must come to the front.
        val pickerUp = touchTapLabelExpecting(BOOKMARKS_ROW, "the document picker is in front", timeoutMs = 12_000, prefix = true) {
            documentPickerShowing()
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
        val picked = pickDocument(HTML_NAME)
        step.put("filePicked", picked)
        if (!picked) {
            touchFault("the bookmarks HTML file could not be picked in the document picker")
            cancelPicker()
        }
        val progress = awaitImportDone(30_000)
        step.put("progress", progress ?: JSONObject.NULL)
        SystemClock.sleep(1_200)
        snap("settings-import-bookmarks-result")
        val outcome = progress?.optJSONObject("results")?.optJSONObject("bookmarks")
        val folderId = progress?.optString("folderId")?.takeIf { it.isNotEmpty() && progress.opt("folderId") != JSONObject.NULL }
        claim(progress?.optString("status") == "done", "the bookmarks import ended done (got ${progress?.optString("status")})")
        claim(outcome?.optInt("imported") == HTML_BOOKMARKS, "$HTML_BOOKMARKS bookmarks imported (got ${outcome?.optInt("imported")})")
        claim(outcome?.optInt("duplicates") == 1, "one duplicate URL skipped (got ${outcome?.optInt("duplicates")})")
        claim(folderId != null, "the bookmarks landed in a folder of their own")
        claim(bookmarkTitled("Lantern Field Notes"), "the imported bookmark is in the core's tree")

        // The result's rows are on screen: a finger on Show imported bookmarks must open the
        // bookmarks overlay on the Imported folder.
        if (folderId != null && revealRow(SHOW_ROW) != null) {
            SystemClock.sleep(600)
            val shown = touchTapLabelExpecting(SHOW_ROW, "the bookmarks overlay is up on the imported folder", timeoutMs = 10_000) {
                chromeSurfaceUp() && overlay() == "bookmarks" && overlayFolderId() == folderId
            }
            step.put("showOpenedOverlay", shown).put("overlay", overlay()).put("overlayFolder", overlayFolderId() ?: JSONObject.NULL)
            SystemClock.sleep(1_500)
            snap("bookmarks-imported-folder")
            step.put("folderHeadingShown", findNode { it == IMPORTED_FOLDER } != null)
            closeOverlay()
            step.put("overlayClosed", !chromeSurfaceUp())
        } else {
            step.put("showRow", false)
        }

        // Dismiss under a finger: the Last import group goes and the core forgets the result.
        if (revealRow(DISMISS_ROW) == null && openSettings("Import")) revealRow(DISMISS_ROW)
        SystemClock.sleep(600)
        val dismissed = touchTapLabelExpecting(DISMISS_ROW, "the last import is dismissed", timeoutMs = 8_000) {
            coreState().isNull("import")
        }
        step.put("dismissed", dismissed)
        if (dismissed && !waitForGone(DISMISS_ROW, 5_000)) step.put("dismissRowLingered", true)
        SystemClock.sleep(1_000)
        snap("settings-import-dismissed")
        Log.i(tag, "bookmarks: $step")
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
        val pickerUp = touchTapLabelExpecting(PASSWORDS_ROW, "the document picker is in front", timeoutMs = 12_000, prefix = true) {
            documentPickerShowing()
        }
        step.put("pickerOpened", pickerUp)
        if (!pickerUp) {
            fail("a finger on '$PASSWORDS_ROW' brought no document picker")
            return
        }
        SystemClock.sleep(1_500)
        snap("picker-passwords-csv")
        val picked = pickDocument(CSV_NAME)
        step.put("filePicked", picked)
        if (!picked) {
            touchFault("the passwords CSV file could not be picked in the document picker")
            cancelPicker()
        }
        val progress = awaitImportDone(45_000)
        step.put("progress", progress ?: JSONObject.NULL)
        SystemClock.sleep(1_200)
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
        val PICKER_PACKAGES = setOf("com.android.documentsui", "com.google.android.documentsui")
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
