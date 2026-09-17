package app.zen.chromium

import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Calendar
import kotlin.math.min

/**
 * Records the phone history and bookmarks panels: history grouped by day, a visit swiped away
 * and brought back with Undo, long-press selection with its actions, Clear history undone, the
 * bookmarks list with a row's menu, the edit sheet renaming a bookmark, bookmark selection with
 * an undone delete, a folder entered and left with the system back gesture, and the star saving
 * the page with a toast whose Edit opens the editor.
 *
 * Driven by the `android-history-bookmarks-demo` workflow. See [DemoHarness] for the plumbing.
 * The history is written at seed time because day grouping needs visits relative to now.
 */
@RunWith(AndroidJUnit4::class)
class HistoryBookmarksDemo :
    DemoHarness("history-bookmarks-demo-state.json", "history-bookmarks", "history-bookmarks-demo") {
    override val tag = "HistoryBookmarksDemo"

    @Test
    fun record() {
        runDemo()
    }

    // --- seed ------------------------------------------------------------------------------------

    /** Visits today, yesterday, three days ago (a weekday heading) and twelve days ago (a date). */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val minute = 60_000L
        fun at(daysAgo: Int, hour: Int, minuteOfHour: Int): Long {
            val cal = Calendar.getInstance()
            cal.timeInMillis = now
            cal.add(Calendar.DAY_OF_YEAR, -daysAgo)
            cal.set(Calendar.HOUR_OF_DAY, hour)
            cal.set(Calendar.MINUTE, minuteOfHour)
            cal.set(Calendar.SECOND, 0)
            cal.set(Calendar.MILLISECOND, 0)
            return min(cal.timeInMillis, now - minute)
        }
        fun visit(url: String, title: String, lastVisit: Long, count: Int, favicon: String) =
            JSONObject()
                .put("url", url)
                .put("title", title)
                .put("visitCount", count)
                .put("lastVisit", lastVisit)
                .put("favicon", favicon)
        val entries = JSONArray()
            .put(visit("https://en.wikipedia.org/wiki/Coffee", "Coffee - Wikipedia", now - 12 * minute, 3, icon("W", "#333333")))
            .put(visit("https://news.ycombinator.com/", "Hacker News", now - 48 * minute, 12, icon("Y", "#f26522")))
            .put(
                visit(
                    "https://github.com/BenItBuhner/Zenium/pull/47",
                    "Android history and bookmarks · Pull Request #47",
                    now - 95 * minute,
                    5,
                    icon("Z", "#24292f")
                )
            )
            .put(
                visit(
                    "https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia",
                    "Window: matchMedia() method - Web APIs | MDN",
                    at(0, 8, 5),
                    2,
                    icon("M", "#1b1b1b")
                )
            )
            .put(visit("https://example.com/", "Example Domain", at(1, 21, 40), 7, icon("E", "#5c7cfa")))
            .put(visit("https://en.wikipedia.org/wiki/Tea", "Tea - Wikipedia", at(1, 18, 12), 2, icon("W", "#333333")))
            .put(
                visit(
                    "https://www.rfc-editor.org/rfc/rfc1149.html",
                    "RFC 1149: IP Datagrams on Avian Carriers",
                    at(1, 9, 3),
                    1,
                    icon("R", "#3b5bdb")
                )
            )
            .put(
                visit(
                    "https://info.cern.ch/hypertext/WWW/TheProject.html",
                    "World Wide Web",
                    at(3, 14, 27),
                    1,
                    icon("W", "#0b7285")
                )
            )
            .put(
                visit(
                    "https://developer.mozilla.org/en-US/docs/Web/CSS/corner-shape",
                    "corner-shape - CSS | MDN",
                    at(3, 11, 50),
                    4,
                    icon("M", "#1b1b1b")
                )
            )
            .put(
                visit(
                    "https://www.rfc-editor.org/rfc/rfc2324.html",
                    "RFC 2324: Hyper Text Coffee Pot Control Protocol",
                    at(12, 16, 45),
                    1,
                    icon("R", "#3b5bdb")
                )
            )
            .put(
                visit(
                    "https://example.org/spring-motion",
                    "Spring physics for UI motion",
                    at(12, 10, 20),
                    2,
                    icon("S", "#2f9e44")
                )
            )
        File(zen, "history.json").writeText(JSONObject().put("version", 1).put("entries", entries).toString())
    }

    /** A lettered tile as an inline SVG, so the rows have favicons without a network. */
    private fun icon(letter: String, background: String): String {
        val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
            "<rect width=\"32\" height=\"32\" rx=\"8\" fill=\"$background\"/>" +
            "<text x=\"16\" y=\"21.5\" font-family=\"Roboto,Helvetica,Arial,sans-serif\" font-size=\"16\" " +
            "font-weight=\"700\" fill=\"#fff\" text-anchor=\"middle\">$letter</text></svg>"
        return "data:image/svg+xml;utf8," + Uri.encode(svg)
    }

    // --- sequence --------------------------------------------------------------------------------

    /** The first panel pays for layout and compilation: open both once off camera. */
    override fun warmUp() {
        openMenuItem(MENU_HISTORY)
        if (waitFor(HISTORY_SEARCH, 10_000) != null) {
            SystemClock.sleep(1_500)
            back()
            waitGone(HISTORY_SEARCH)
        }
        SystemClock.sleep(1_500)
        openMenuItem(MENU_BOOKMARKS, MENU_BOOKMARKS_PANEL)
        if (waitFor(BOOKMARKS_SEARCH, 10_000) != null) {
            SystemClock.sleep(1_500)
            back()
            waitGone(BOOKMARKS_SEARCH)
        }
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()

        // 1. History, grouped by day: Today, Yesterday, a weekday, a date.
        openMenuItem(MENU_HISTORY)
        await(HISTORY_SEARCH)
        SystemClock.sleep(2_500)
        shot("01-history-grouped")

        // 2. Swipe a visit away – slowly at first, so the trash behind it shows – and undo it.
        //    From the title, not the trailing button: a touch on a control stays the control's.
        row("Hacker News, ")?.let { hn ->
            f.down(hn.left + 0.7f * hn.width(), hn.exactCenterY())
            f.moveBy(-NUDGE, 0f, 80)
            f.moveBy(-0.28f * width, 0f, 900)
            f.hold(900)
            shot("02-history-swipe")
            f.moveBy(-0.32f * width, 0f, 500)
            f.hold(200)
            f.up()
            SystemClock.sleep(2_000)
            shot("03-history-removed-undo")
            clickWhenShown("Undo")
            SystemClock.sleep(2_000)
        }

        // 3. Hold a row: selection mode. Pick a second one, look at the actions, delete, undo.
        row("Coffee - Wikipedia, ")?.let { coffee ->
            f.press(coffee.exactCenterX(), coffee.exactCenterY())
            f.up()
            SystemClock.sleep(1_500)
            row("Example Domain, ")?.let { f.tap(it.exactCenterX(), it.exactCenterY()) }
            SystemClock.sleep(1_500)
            shot("04-history-selection")
            click("More")
            SystemClock.sleep(2_500)
            shot("05-history-selection-menu")
            // The sheet takes the back gesture; the selection stays.
            back()
            SystemClock.sleep(2_000)
            click("Delete")
            SystemClock.sleep(2_000)
            shot("06-history-deleted")
            clickWhenShown("Undo")
            SystemClock.sleep(2_000)
        }

        // 4. The top row clears everything – undoable as well.
        if (click("Clear history")) {
            SystemClock.sleep(2_000)
            shot("07-history-cleared")
            clickWhenShown("Undo")
            SystemClock.sleep(2_000)
        }
        click("Close")
        waitGone(HISTORY_SEARCH)
        SystemClock.sleep(1_500)

        // 5. Bookmarks: the mobile folder with its subfolders, a row's menu, the edit sheet.
        openMenuItem(MENU_BOOKMARKS, MENU_BOOKMARKS_PANEL)
        await(BOOKMARKS_SEARCH)
        SystemClock.sleep(2_500)
        shot("08-bookmarks-list")
        if (click("More options for Hacker News")) {
            SystemClock.sleep(2_500)
            shot("09-bookmarks-row-menu")
            click("Edit")
            await("Save")
            SystemClock.sleep(2_000)
            shot("10-bookmarks-edit-sheet")
            // Put the caret at the end of the name, type, save.
            nameField("Hacker News")?.let { field ->
                f.tap(field.right - 24 * density, field.exactCenterY())
                SystemClock.sleep(1_500)
                instrumentation.sendStringSync(" daily")
                SystemClock.sleep(1_500)
            }
            click("Save")
            SystemClock.sleep(2_500)
            shot("11-bookmarks-edited")
        }

        // 6. Hold a bookmark, pick another, delete both, undo.
        findByLabel("World Wide Web")?.let { www ->
            f.press(www.exactCenterX(), www.exactCenterY())
            f.up()
            SystemClock.sleep(1_500)
            findByLabel("Zenium on GitHub")?.let { f.tap(it.exactCenterX(), it.exactCenterY()) }
            SystemClock.sleep(1_500)
            shot("12-bookmarks-selection")
            click("Delete")
            SystemClock.sleep(2_000)
            shot("13-bookmarks-deleted")
            clickWhenShown("Undo")
            SystemClock.sleep(2_000)
        }

        // 7. Into a folder; the system back gesture climbs out again before it closes anything.
        row("Reading, folder")?.let { reading ->
            f.tap(reading.exactCenterX(), reading.exactCenterY())
            SystemClock.sleep(2_500)
            shot("14-bookmarks-folder")
            back()
            SystemClock.sleep(2_000)
        }
        click("Close")
        waitGone(BOOKMARKS_SEARCH)
        SystemClock.sleep(1_500)

        // 8. The star saves the page; the toast offers Edit, which opens the editor on it.
        openMenuItem(MENU_BOOKMARKS, MENU_STAR)
        await("Edit")
        SystemClock.sleep(1_200)
        shot("15-saved-toast")
        click("Edit")
        await("Save")
        SystemClock.sleep(2_500)
        shot("16-saved-edit-sheet")
        back()
        SystemClock.sleep(2_000)
    }

    // --- helpers ---------------------------------------------------------------------------------

    /**
     * Tap the bar's menu button, then click each step in turn (a submenu, then its row). A step
     * lists the labels it accepts, the current one first: the engine's menu entries have been
     * renamed under this driver before ("Bookmark Manager" became "Show Bookmarks").
     */
    private fun openMenuItem(vararg steps: List<String>) {
        ensureForeground()
        val menu = findByLabel("Menu") ?: error("no Menu button on the bar")
        Finger().tap(menu.exactCenterX(), menu.exactCenterY())
        if (waitForAny(steps.first(), 6_000) == null) {
            // The tap can land while the bar is still settling; once more.
            Log.w(tag, "the menu did not open; tapping again")
            Finger().tap(menu.exactCenterX(), menu.exactCenterY())
        }
        for (step in steps) {
            val label = waitForAny(step, 8_000) ?: error("no ${step.joinToString(" or ")} in the menu")
            SystemClock.sleep(700)
            clickByLabel(label, enabledOnly = true)
            SystemClock.sleep(1_200)
        }
    }

    /** Poll for the first of several labels to appear; the one found, or null after `timeoutMs`. */
    private fun waitForAny(labels: List<String>, timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            labels.firstOrNull { findByLabel(it) != null }?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /** A list row by the start of its label (a visit's label ends in its time). */
    private fun row(prefix: String): Rect? =
        findByLabelPrefix(prefix).also { if (it == null) Log.w(tag, "no row starting with '$prefix'") }

    /** The editor's name field while it holds `value`. */
    private fun nameField(value: String): Rect? =
        findNodeWhere { it.className == "android.widget.EditText" && it.text?.startsWith(value) == true }
            ?.bounds()
            .also { if (it == null) Log.w(tag, "no name field holding '$value'") }

    private fun click(label: String): Boolean =
        clickByLabel(label, enabledOnly = true).also { if (!it) Log.w(tag, "nothing to click for '$label'") }

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

    private fun waitGone(label: String, timeoutMs: Long = 6_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (findByLabel(label) != null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
    }

    companion object {
        private const val HISTORY_SEARCH = "Search history"
        private const val BOOKMARKS_SEARCH = "Search bookmarks"

        // App-menu steps, each the labels it accepts with the current one first.
        private val MENU_HISTORY = listOf("History")
        private val MENU_BOOKMARKS = listOf("Bookmarks")
        private val MENU_BOOKMARKS_PANEL = listOf("Show Bookmarks", "Bookmark Manager")
        private val MENU_STAR = listOf("Bookmark This Page", "Bookmark This Page…")
    }
}
