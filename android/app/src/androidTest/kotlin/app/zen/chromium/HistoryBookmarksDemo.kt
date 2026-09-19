package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Records the phone history and bookmarks panels: history grouped by day, a visit swiped away
 * and brought back with Undo, long-press selection with its menu and a delete undone, the
 * Clear history question and the empty state after it, the bookmarks list with a row's menu,
 * the edit sheet renaming a bookmark, bookmark selection with an undone delete, a folder entered
 * and left with the system back gesture, back closing a row menu and then an editor without
 * taking the panel with them, and the star saving the page with a toast whose Edit opens the
 * editor on the new bookmark.
 *
 * Driven by the `android-history-bookmarks-demo` workflow. See [DemoHarness] for the plumbing.
 * Today's visits are real: the warm-up navigates the active tab through pages of a loopback
 * [DemoServer] (each with its own favicon), so the day groups, titles and icons come out of the
 * history contract as they would from browsing. The older days are seeded (`history.json`
 * version 2, an aggregate and its visits per page) because a demo cannot browse yesterday.
 * Findings land in `history-bookmarks-findings.txt` next to the screenshots.
 */
@RunWith(AndroidJUnit4::class)
class HistoryBookmarksDemo :
    DemoHarness("history-bookmarks-demo-state.json", "history-bookmarks", "history-bookmarks-demo") {
    override val tag = "HistoryBookmarksDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    // --- seed ------------------------------------------------------------------------------------

    /** The seeded tabs point at the loopback pages, so nothing in the run depends on the network. */
    override fun patchState(json: String): String =
        json
            .replace("https://example.com/", "$ORIGIN/")
            .replace("\"Example Domain\"", "\"${PAGES[0].title}\"")
            .replace("https://en.wikipedia.org/wiki/Coffee", "$ORIGIN${PAGES[1].path}")
            .replace("\"Coffee - Wikipedia\"", "\"${PAGES[1].title}\"")

    /**
     * Yesterday, three days ago (a weekday heading) and twelve days ago (a date heading), in the
     * history contract's own shape: one aggregate per page and a visit for each time it was seen.
     * Today is left to the warm-up's real visits.
     */
    override fun seedMore(zen: File) {
        val entries = JSONArray()
        val visits = JSONArray()
        fun seed(url: String, title: String, favicon: String, vararg times: Long) {
            entries.put(
                JSONObject()
                    .put("url", url)
                    .put("title", title)
                    .put("visitCount", times.size)
                    .put("lastVisit", times.maxOrNull() ?: 0L)
                    .put("firstVisit", times.minOrNull() ?: 0L)
                    .put("typedCount", 0)
                    .put("favicon", favicon)
            )
            times.forEachIndexed { i, time ->
                visits.put(
                    JSONObject()
                        .put("id", "seed_${entries.length()}_$i")
                        .put("url", url)
                        .put("title", title)
                        .put("favicon", favicon)
                        .put("visitTime", time)
                        .put("transition", "link")
                )
            }
        }
        seed("https://example.com/", "Example Domain", svgIcon("E", "#5c7cfa"), at(1, 21, 40))
        seed("https://en.wikipedia.org/wiki/Tea", "Tea - Wikipedia", svgIcon("W", "#333333"), at(1, 18, 12))
        seed(
            "https://www.rfc-editor.org/rfc/rfc1149.html",
            "RFC 1149: IP Datagrams on Avian Carriers",
            svgIcon("R", "#3b5bdb"),
            at(1, 9, 3)
        )
        seed("https://info.cern.ch/hypertext/WWW/TheProject.html", "World Wide Web", svgIcon("W", "#0b7285"), at(3, 14, 27))
        seed(
            "https://developer.mozilla.org/en-US/docs/Web/CSS/corner-shape",
            "corner-shape - CSS | MDN",
            svgIcon("M", "#1b1b1b"),
            at(3, 11, 50)
        )
        seed(
            "https://www.rfc-editor.org/rfc/rfc2324.html",
            "RFC 2324: Hyper Text Coffee Pot Control Protocol",
            svgIcon("R", "#3b5bdb"),
            at(12, 16, 45)
        )
        seed("https://news.ycombinator.com/", "Hacker News", svgIcon("Y", "#f26522"), at(12, 10, 20))
        File(zen, "history.json").writeText(
            JSONObject().put("version", 2).put("entries", entries).put("visits", visits).toString()
        )
    }

    /** A local time of day `daysAgo` days back. */
    private fun at(daysAgo: Int, hour: Int, minuteOfHour: Int): Long {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -daysAgo)
        cal.set(Calendar.HOUR_OF_DAY, hour)
        cal.set(Calendar.MINUTE, minuteOfHour)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    /** A lettered tile as an inline SVG for the seeded rows, so they have favicons without a network. */
    private fun svgIcon(letter: String, background: String): String {
        val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
            "<rect width=\"32\" height=\"32\" rx=\"8\" fill=\"$background\"/>" +
            "<text x=\"16\" y=\"21.5\" font-family=\"Roboto,Helvetica,Arial,sans-serif\" font-size=\"16\" " +
            "font-weight=\"700\" fill=\"#fff\" text-anchor=\"middle\">$letter</text></svg>"
        return "data:image/svg+xml;utf8," + Uri.encode(svg)
    }

    // --- the pages -------------------------------------------------------------------------------

    private class Page(val path: String, val title: String, val letter: String, val color: String, val body: String)

    /** Each page links a PNG favicon of its own: the WebView hands those to the chrome, SVGs it does not. */
    private fun routes(): Map<String, Pair<String, ByteArray>> {
        val routes = LinkedHashMap<String, Pair<String, ByteArray>>()
        for (page in PAGES) {
            val icon = "/icons/${page.letter.lowercase()}.png"
            routes[page.path] = "text/html; charset=utf-8" to (
                "<!doctype html><html><head><meta charset=utf-8>" +
                    "<meta name=viewport content=\"width=device-width,initial-scale=1\">" +
                    "<title>${page.title}</title><link rel=\"icon\" type=\"image/png\" href=\"$icon\">" +
                    "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px}" +
                    "p{padding:0 24px;font-size:20px;line-height:1.5}</style></head>" +
                    "<body><h1>${page.title}</h1><p>${page.body}</p></body></html>"
                ).toByteArray()
            routes[icon] = "image/png" to pngIcon(page.letter, Color.parseColor(page.color))
        }
        return routes
    }

    /** A 64 px lettered tile as a PNG. */
    private fun pngIcon(letter: String, background: Int): ByteArray {
        val size = 64
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = background
        canvas.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 16f, 16f, paint)
        paint.color = Color.WHITE
        paint.textSize = 36f
        paint.typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        paint.textAlign = Paint.Align.CENTER
        val baseline = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(letter, size / 2f, baseline, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    // --- sequence --------------------------------------------------------------------------------

    /**
     * Browse the loopback pages in the active tab (today's real visits, newest last), then open
     * both panels once off camera: the first one pays for layout and compilation.
     */
    override fun warmUp() {
        findings = File(out, "history-bookmarks-findings.txt")
        findings.writeText(
            "Zenium Android history and bookmarks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitActive("$ORIGIN/", PAGES[0].title)
        for (page in PAGES.drop(1)) {
            val tabId = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.navigate", JSONObject().put("tabId", tabId).put("input", "$ORIGIN${page.path}").toString())
            awaitActive("$ORIGIN${page.path}", page.title)
            SystemClock.sleep(800)
        }
        val today = coreInvoke("history.count", JSONObject().put("fromMs", at(0, 0, 0)).put("toMs", System.currentTimeMillis() + 60_000).toString())
        finding("visits recorded today after browsing ${PAGES.size} pages: $today")

        openMenuItem(MENU_HISTORY)
        if (awaitPanel(HISTORY_SEARCH)) {
            SystemClock.sleep(1_500)
            back()
            awaitPanelGone(HISTORY_SEARCH)
        }
        SystemClock.sleep(1_200)
        openMenuItem(MENU_BOOKMARKS, MENU_BOOKMARKS_PANEL)
        if (awaitPanel(BOOKMARKS_SEARCH)) {
            SystemClock.sleep(1_500)
            back()
            awaitPanelGone(BOOKMARKS_SEARCH)
        }
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()

        // 1. History, grouped by day: Today (the real visits), Yesterday, a weekday, a date.
        openMenuItem(MENU_HISTORY)
        awaitPanel(HISTORY_SEARCH)
        SystemClock.sleep(2_000)
        shot("01-history-grouped")
        val weekday = SimpleDateFormat("EEEE", Locale.US).format(at(3, 12, 0))
        val date = SimpleDateFormat("EEEE, MMMM d", Locale.US).format(at(12, 12, 0))
        finding(
            "\nhistory day groups: Today ${verdict(present("Today"))}, Yesterday ${verdict(present("Yesterday"))}, " +
                "$weekday ${seen(weekday)}, $date ${seen(date)} (the last two may sit below the fold)"
        )
        finding("today's real rows: " + PAGES.map { "'${it.title}' ${verdict(row(it.title) != null)}" }.joinToString(", "))

        // 2. Swipe a visit away – slowly at first, so the trash behind it shows – and undo it.
        //    From the title, not the trailing button: a touch on a control stays the control's.
        val swiped = PAGES[1].title
        row(swiped)?.let { target ->
            f.down(target.left + 0.7f * target.width(), target.exactCenterY())
            f.moveBy(-NUDGE, 0f, 80)
            f.moveBy(-0.28f * width, 0f, 900)
            f.hold(900)
            shot("02-history-swipe")
            f.moveBy(-0.32f * width, 0f, 500)
            f.hold(200)
            f.up()
            SystemClock.sleep(1_800)
            shot("03-history-removed-undo")
            val gone = row(swiped) == null
            val undo = clickWhenShown("Undo")
            SystemClock.sleep(1_800)
            finding(
                "swipe-delete: row gone ${verdict(gone)}, toast with Undo ${verdict(undo)}, " +
                    "row back after Undo ${verdict(row(swiped) != null)}"
            )
        }

        // 3. Hold a row: selection mode. Pick a second one, look at the menu, let back close it
        //    (the selection stays), delete from the header, undo.
        row(PAGES[3].title)?.let { first ->
            f.press(first.exactCenterX(), first.exactCenterY())
            f.up()
            SystemClock.sleep(1_200)
            row(PAGES[4].title)?.let { f.tap(it.exactCenterX(), it.exactCenterY()) }
            SystemClock.sleep(1_200)
            shot("04-history-selection")
            finding("\nlong press: selection header '2 selected' ${verdict(present("2 selected"))}")
            click("More")
            await(MENU_HANDLE_LABEL)
            SystemClock.sleep(1_200)
            shot("05-history-selection-menu")
            finding(
                "selection menu: Open All (2) ${verdict(present("Open All (2)"))}, Copy Links ${verdict(present("Copy Links"))}, " +
                    "Remove from History ${verdict(present("Remove from History"))}"
            )
            back()
            SystemClock.sleep(1_500)
            finding(
                "back on the selection menu: menu gone ${verdict(!present(MENU_HANDLE_LABEL))}, " +
                    "selection kept ${verdict(present("2 selected"))}"
            )
            val deleted = clickTopmost("Remove from history")
            SystemClock.sleep(1_800)
            shot("06-history-deleted")
            val bothGone = row(PAGES[3].title) == null && row(PAGES[4].title) == null
            val undo = clickWhenShown("Undo")
            SystemClock.sleep(1_800)
            finding(
                "multi-delete from the header: tapped ${verdict(deleted)}, both rows gone ${verdict(bothGone)}, " +
                    "'2 pages removed' with Undo ${verdict(undo)}, rows back ${verdict(row(PAGES[3].title) != null && row(PAGES[4].title) != null)}"
            )
        }

        // 4. The top row asks before it clears everything (#129's question as a prompt sheet).
        if (click("Clear history")) {
            await("Clear all")
            SystemClock.sleep(1_500)
            shot("07-history-clear-prompt")
            finding(
                "\nClear history: prompt 'Clear all history?' ${verdict(present("Clear all history?"))}, " +
                    "Cancel ${verdict(present("Cancel"))}, Clear all ${verdict(present("Clear all"))}"
            )
            // The prompt sheet's injected touch (the rule in DemoHarness): Clear all under a
            // finger, and the panel must show its empty note on it.
            touch("Clear all", "the history is empty") { present("Pages you visit will show up here") }
            SystemClock.sleep(2_000)
            shot("08-history-empty")
            finding(
                "after Clear all: empty note ${verdict(present("Pages you visit will show up here"))}, " +
                    "Clear history row gone ${verdict(!present("Clear history"))}"
            )
        } else {
            finding("\nClear history: row not found ${verdict(false)}")
        }
        click("Close")
        awaitPanelGone(HISTORY_SEARCH)
        SystemClock.sleep(1_200)

        // 5. Bookmarks: the mobile folder with its subfolders, a row's menu, the edit sheet.
        openMenuItem(MENU_BOOKMARKS, MENU_BOOKMARKS_PANEL)
        awaitPanel(BOOKMARKS_SEARCH)
        SystemClock.sleep(2_000)
        shot("09-bookmarks-list")
        val rowMenuExposed = present("More options for Hacker News")
        if (!rowMenuExposed) dumpTree("a11y-bookmarks-list")
        finding(
            "\nbookmarks: header 'Mobile bookmarks' ${verdict(present("Mobile bookmarks"))}, " +
                "folder rows ${verdict(row("Reading, folder") != null && row("Work, folder") != null)}, " +
                "a row's 3-dot button in the accessibility tree (TalkBack reaches it) ${verdict(rowMenuExposed)}"
        )
        if (openRowMenu("Hacker News")) {
            await(MENU_HANDLE_LABEL)
            SystemClock.sleep(1_200)
            shot("10-bookmarks-row-menu")
            finding(
                "row menu: Edit… ${verdict(present("Edit…"))}, Open in New Tab ${verdict(present("Open in New Tab"))}, " +
                    "Copy Link ${verdict(present("Copy Link"))}, Share… ${seen("Share…")}, Delete ${verdict(present("Delete"))}"
            )
            // The row menu's injected touch: Edit… under a finger opens the editor (its Save).
            touch("Edit…", "the editor is up with its Save", timeoutMs = 10_000) { present("Save") }
            SystemClock.sleep(1_800)
            shot("11-bookmarks-edit-sheet")
            finding("editor: title 'Edit Bookmark' ${verdict(present("Edit Bookmark"))}, name field ${verdict(nameField("Hacker News") != null)}")
            // Put the caret at the end of the name, type, save.
            nameField("Hacker News")?.let { field ->
                f.tap(field.right - 24 * density, field.exactCenterY())
                SystemClock.sleep(1_500)
                instrumentation.sendStringSync(" daily")
                SystemClock.sleep(1_200)
            }
            // The editor's injected touch: Save under a finger, and the core must hold the new name.
            // The keyboard the field raised goes first (back takes the keys down, not the sheet):
            // a finger cannot reach a button under it.
            if (imeInset() > 0) {
                back()
                awaitIme(shown = false)
                SystemClock.sleep(800)
            }
            touch("Save", "the core holds the renamed bookmark") { bookmarkTitle("b_hn") == "Hacker News daily" }
            SystemClock.sleep(2_000)
            shot("12-bookmarks-edited")
            val title = bookmarkTitle("b_hn")
            finding("rename saved: core holds '$title' ${verdict(title == "Hacker News daily")}, row shows it ${verdict(present("Hacker News daily"))}")
        }

        // 6. Hold a bookmark, pick another, delete both, undo.
        findByLabel("World Wide Web")?.let { www ->
            f.press(www.exactCenterX(), www.exactCenterY())
            f.up()
            SystemClock.sleep(1_200)
            findByLabel("Zenium on GitHub")?.let { f.tap(it.exactCenterX(), it.exactCenterY()) }
            SystemClock.sleep(1_200)
            shot("13-bookmarks-selection")
            val selecting = present("2 selected")
            click("Delete")
            SystemClock.sleep(1_800)
            shot("14-bookmarks-deleted")
            val gone = !present("World Wide Web") && !present("Zenium on GitHub")
            val undo = clickWhenShown("Undo")
            SystemClock.sleep(1_800)
            finding(
                "\nbookmark selection: '2 selected' ${verdict(selecting)}, both gone ${verdict(gone)}, Undo ${verdict(undo)}, " +
                    "both back ${verdict(present("World Wide Web") && present("Zenium on GitHub"))}, " +
                    "core still has them ${verdict(bookmarkTitle("b_www") == "World Wide Web" && bookmarkTitle("b_zen") == "Zenium on GitHub")}"
            )
        }

        // 7. Into a folder; the system back gesture climbs out again before it closes anything.
        row("Reading, folder")?.let { reading ->
            f.tap(reading.exactCenterX(), reading.exactCenterY())
            SystemClock.sleep(2_000)
            shot("15-bookmarks-folder")
            val inside = present("Damping - Wikipedia") && present("Back")
            back()
            SystemClock.sleep(1_800)
            finding(
                "\nfolder: pushed into Reading ${verdict(inside)}, back climbs out to Mobile bookmarks " +
                    "${verdict(present("Mobile bookmarks") && panelOpen(BOOKMARKS_SEARCH))}"
            )
        }

        // 8. Back closes what is on top and nothing more: the row menu, then an editor, then the panel.
        //    On the row as it is named now (the rename above, if it went through).
        val hn = bookmarkTitle("b_hn") ?: "Hacker News"
        if (openRowMenu(hn)) {
            await(MENU_HANDLE_LABEL)
            SystemClock.sleep(1_200)
            back()
            SystemClock.sleep(1_500)
            shot("16-back-closed-menu")
            finding(
                "\nback on a row menu: menu gone ${verdict(!present(MENU_HANDLE_LABEL))}, panel stays ${verdict(panelOpen(BOOKMARKS_SEARCH))}"
            )
        }
        if (openRowMenu(hn)) {
            await(MENU_HANDLE_LABEL)
            SystemClock.sleep(1_000)
            click("Edit…")
            await("Save")
            SystemClock.sleep(1_500)
            back()
            SystemClock.sleep(1_500)
            shot("17-back-closed-editor")
            finding("back on the editor: editor gone ${verdict(!present("Save"))}, panel stays ${verdict(panelOpen(BOOKMARKS_SEARCH))}")
        }
        back()
        awaitPanelGone(BOOKMARKS_SEARCH)
        SystemClock.sleep(1_500)
        shot("18-back-closed-panel")
        finding("back on the panel: panel gone ${verdict(!panelOpen(BOOKMARKS_SEARCH))}, the page's bar is back ${verdict(findByLabelPrefix(PILL_LABEL) != null)}")

        // 9. The star saves the page; the toast offers Edit, which opens the editor on the new node.
        val before = bookmarkCount()
        openMenuItem(MENU_BOOKMARKS, MENU_STAR)
        await("Edit")
        SystemClock.sleep(1_000)
        shot("19-saved-toast")
        val after = bookmarkCount()
        finding(
            "\nstar: toast 'Saved to Bookmarks' ${verdict(present("Saved to Bookmarks"))} with Edit ${verdict(present("Edit"))}, " +
                "bookmark nodes $before -> $after ${verdict(after == before + 1)}"
        )
        click("Edit")
        await("Save")
        SystemClock.sleep(2_000)
        shot("20-saved-edit-sheet")
        finding("star editor: name holds the page's title ${verdict(nameField(PAGES.last().title) != null)}")
        back()
        SystemClock.sleep(1_500)
        finding("back on the star editor: gone ${verdict(!present("Save"))}")
    }

    // --- helpers ---------------------------------------------------------------------------------

    /** Poll until the active tab per the core is `url` with `title` (its page loaded and named). */
    private fun awaitActive(url: String, title: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url && tab.optString("title") == title) return
            SystemClock.sleep(400)
        }
        Log.w(tag, "the active tab never became $url '$title': ${activeCoreTab()}")
    }

    private fun bookmarkNodes(): JSONArray = coreState().optJSONArray("bookmarks") ?: JSONArray()

    private fun bookmarkCount(): Int = bookmarkNodes().length()

    private fun bookmarkTitle(id: String): String? {
        val nodes = bookmarkNodes()
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            if (node.optString("id") == id) return node.optString("title")
        }
        return null
    }

    /** A list row by the start of its label (a visit's label ends in its host and time). */
    private fun row(prefix: String): Rect? =
        findByLabelPrefix(prefix).also { if (it == null) Log.w(tag, "no row starting with '$prefix'") }

    /**
     * A panel's search field. The WebView reports an input's label as the EditText's hint (its
     * text is the value), so the label lookups above never see it.
     */
    private fun searchField(label: String): Rect? =
        findNodeWhere { node ->
            node.className == "android.widget.EditText" &&
                listOfNotNull(node.hintText, node.text, node.contentDescription).any { it.toString().contains(label) }
        }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /** The panel whose search field says `search` is on screen. */
    private fun panelOpen(search: String): Boolean = searchField(search) != null

    private fun awaitPanel(search: String, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (panelOpen(search)) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "the panel with '$search' never showed up")
        return false
    }

    private fun awaitPanelGone(search: String, timeoutMs: Long = 6_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (panelOpen(search) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
    }

    /**
     * Open a bookmark row's 3-dot menu: through its button's label, or – should the tree not
     * expose the button – with a finger on it (the 44 box 12 past the row's text, 9.18).
     */
    private fun openRowMenu(title: String): Boolean {
        if (click("More options for $title")) return true
        val main = row(title) ?: return false
        Finger().tap(main.right + 34 * density, main.exactCenterY())
        finding("row menu for '$title': no button in the accessibility tree, tapped where it is drawn")
        return true
    }

    /** The active window's accessibility tree, for a look at what a lookup could not find. */
    private fun dumpTree(name: String) {
        val lines = ArrayList<String>()
        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || lines.size > 600) return
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            val flags = listOfNotNull(
                "clickable".takeIf { node.isClickable },
                "focusable".takeIf { node.isFocusable },
                "checkable".takeIf { node.isCheckable },
                "disabled".takeIf { !node.isEnabled }
            )
            lines += "  ".repeat(depth) + (node.className?.toString()?.substringAfterLast('.') ?: "?") +
                (node.text?.let { " text='$it'" } ?: "") +
                (node.contentDescription?.let { " desc='$it'" } ?: "") +
                (node.hintText?.let { " hint='$it'" } ?: "") +
                (if (flags.isEmpty()) "" else " [${flags.joinToString(" ")}]") +
                " ${bounds.toShortString()}"
            for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
        }
        walk(ui.rootInActiveWindow, 0)
        File(out, "history-bookmarks-$name.txt").writeText(lines.joinToString("\n") + "\n")
    }

    /** The editor's name field while it holds `value`. */
    private fun nameField(value: String): Rect? =
        findNodeWhere { it.className == "android.widget.EditText" && it.text?.startsWith(value) == true }
            ?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            .also { if (it == null) Log.w(tag, "no name field holding '$value'") }

    private fun click(label: String): Boolean =
        clickByLabel(label, enabledOnly = true).also { if (!it) Log.w(tag, "nothing to click for '$label'") }

    /**
     * A sheet's control under a finger, its `effect` asserted (the rule in DemoHarness): the
     * findings record the miss too, and [click] then gets the demo to the state so the rest of
     * the sequence is recorded – the run has failed by then.
     */
    private fun touch(label: String, effect: String, timeoutMs: Long = 5_000, took: () -> Boolean) {
        if (touchTapLabelExpecting(label, effect, timeoutMs, took = took)) return
        finding("a finger on '$label': $effect ${verdict(false)} (clicked through the tree to go on)")
        if (!took()) click(label)
    }

    /**
     * Click the highest node labelled `label`: the selection header's button carries the same
     * label as every row's trailing button under it.
     */
    private fun clickTopmost(label: String): Boolean {
        val limit = (height * 0.2f).toInt()
        val match = findNodeWhere { node ->
            val text = node.contentDescription?.toString() ?: node.text?.toString()
            text == label && Rect().also { node.getBoundsInScreen(it) }.top < limit
        } ?: run {
            Log.w(tag, "no '$label' in the top of the screen")
            return false
        }
        var node: AccessibilityNodeInfo? = match
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: false
    }

    /** Click `label` once it is on screen (a toast's action that follows an animation). */
    private fun clickWhenShown(label: String, timeoutMs: Long = 4_000): Boolean {
        if (waitFor(label, timeoutMs) == null) {
            Log.w(tag, "'$label' never showed up")
            return false
        }
        return click(label)
    }

    private fun await(label: String) {
        waitFor(label, 10_000) ?: Log.w(tag, "'$label' never showed up")
    }

    private fun present(label: String): Boolean = findByLabel(label) != null

    private fun seen(label: String): String = if (present(label)) "on screen" else "not on screen"

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18132
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val HISTORY_SEARCH = "Search history"
        private const val BOOKMARKS_SEARCH = "Search bookmarks"

        // The app menu's entries (the engine's labels; the phone gets "Bookmark This Page").
        private const val MENU_HISTORY = "History"
        private const val MENU_BOOKMARKS = "Bookmarks"
        private const val MENU_BOOKMARKS_PANEL = "Show Bookmarks"
        private const val MENU_STAR = "Bookmark This Page"

        /** The loopback pages, in the order the warm-up visits them (the first is the seeded tab's). */
        private val PAGES = listOf(
            Page("/", "Spring physics for UI motion", "S", "#2f9e44", "Why a damped spring feels better than an ease-out curve."),
            Page("/coffee.html", "Coffee – a short history", "C", "#6f4e37", "From Ethiopian highlands to the espresso bar."),
            Page("/news.html", "Front page – Loopback News", "N", "#f26522", "Thirty links, none of them about JavaScript frameworks."),
            Page("/matchmedia.html", "matchMedia() – Web APIs", "M", "#1b1b1b", "Ask the viewport a question and listen for the answer."),
            Page("/carriers.html", "IP datagrams on avian carriers", "R", "#3b5bdb", "RFC 1149, with field notes on latency.")
        )
    }
}
