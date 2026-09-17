package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the bookmark tree on the phone chrome: a profile seeded with the pre-tree flat list
 * (migrated into Mobile bookmarks on first launch), the bookmarks panel from the menu, bookmarking
 * the current page, importing a Chrome export through the system document picker from the panel's
 * overflow menu (the file is pushed to Downloads by the workflow), exporting through the picker,
 * searching across folders, and the URL bar suggestion that carries a bookmark's folder path.
 *
 * Driven by the `android-services-bookmarks-demo` workflow. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class BookmarksDemo : DemoHarness("bookmarks-demo-state.json", "bookmarks", "bookmarks-demo") {
    override val tag = "BookmarksDemo"

    @Test
    fun record() {
        runDemo()
    }

    /** Nothing to visit: example.com is small and long since loaded by the time the pill shows. */
    override fun warmUp() {
        SystemClock.sleep(3_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. Menu > Bookmarks > Show Bookmarks: the three legacy bookmarks, now in Mobile bookmarks.
        tap("Menu")
        SystemClock.sleep(2_000)
        tap("Bookmarks")
        SystemClock.sleep(1_800)
        shot("01-menu-bookmarks")
        tap("Show Bookmarks")
        SystemClock.sleep(2_500)
        shot("02-migrated-panel")

        // 2. Bookmark the current page into the default folder.
        tap("Bookmark current")
        SystemClock.sleep(1_200)
        shot("03-bookmark-current")
        SystemClock.sleep(1_800)

        // 3. Import a Chrome export through the document picker (the panel's overflow menu).
        tap(MORE_LABEL)
        SystemClock.sleep(1_800)
        shot("03b-overflow-menu")
        tap("Import Bookmarks…")
        SystemClock.sleep(3_500)
        openDownloads()
        val file = waitForText(FIXTURE, 8_000) ?: error("$FIXTURE is not in the picker")
        shot("04-document-picker")
        Finger().tap(file.exactCenterX(), file.exactCenterY())
        SystemClock.sleep(4_000)
        ensureForeground()
        shot("05-imported")
        SystemClock.sleep(1_000)

        // 4. Export through the document picker (it reopens in Downloads), then Save.
        tap(MORE_LABEL)
        SystemClock.sleep(1_800)
        tap("Export Bookmarks…")
        SystemClock.sleep(3_500)
        openDownloads()
        val save = waitForText("Save", 8_000) ?: error("no Save button in the picker")
        shot("06-export-picker")
        Finger().tap(save.exactCenterX(), save.exactCenterY())
        SystemClock.sleep(4_000)
        ensureForeground()
        shot("07-exported")
        SystemClock.sleep(1_000)

        // 5. Search across the tree (folder names count); the panel is closed from its header
        // afterwards, which also drops the query.
        val search = searchField()
        Finger().tap(search.exactCenterX(), search.exactCenterY())
        SystemClock.sleep(1_500)
        typeText("docs")
        SystemClock.sleep(2_000)
        shot("08-search")
        closePanel()
        SystemClock.sleep(1_800)

        // 6. A URL bar suggestion carries the bookmark's folder path.
        tap(PILL_LABEL)
        SystemClock.sleep(2_500)
        typeText("mdn")
        SystemClock.sleep(3_000)
        shot("09-suggestions")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(900)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(2_000)
    }

    /** Tap the first node with this label (aria-label or text) once it shows up. */
    private fun tap(label: String) {
        val target = waitFor(label, 8_000) ?: error("no $label to tap")
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    /**
     * Type through UiAutomation like GestureDemo does: Instrumentation.sendStringSync drops keys
     * into the WebView while the soft keyboard is attaching ("docs" arrived as "doc").
     */
    private fun typeText(text: String) {
        val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray()) ?: return
        for (event in events) {
            ui.injectInputEvent(event, true)
            SystemClock.sleep(60)
        }
    }

    /** The panel header's Close button; BACK only as a fallback, since it is what closed it before. */
    private fun closePanel() {
        val close = waitFor(CLOSE_LABEL, 3_000)
        if (close != null) Finger().tap(close.exactCenterX(), close.exactCenterY())
        else ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /**
     * The file lives in Downloads. The picker opens on Recent the first time and remembers the
     * last location afterwards, so the export picker already shows Downloads: then the roots
     * drawer must stay closed, since open it covers the Save button and swallows the tap. Only
     * when Downloads is not the current location open the drawer (hamburger "Show roots") and
     * pick it there.
     */
    private fun openDownloads() {
        if (waitForText("Downloads", 3_000) != null && waitForText("Show roots", 500) != null) {
            // "Downloads" with the hamburger still visible is the toolbar title: already there.
            Log.i(tag, "picker already shows Downloads")
            return
        }
        val roots = waitForText("Show roots", 5_000)
        if (roots != null) {
            Finger().tap(roots.exactCenterX(), roots.exactCenterY())
            SystemClock.sleep(1_800)
        }
        val downloads = waitForText("Downloads", 5_000)
        if (downloads != null) {
            Finger().tap(downloads.exactCenterX(), downloads.exactCenterY())
            SystemClock.sleep(2_500)
        } else {
            Log.w(tag, "no Downloads root in the picker; going with what it shows")
        }
    }

    /** The panel's search box: the input whose hint reads "Search bookmarks". */
    private fun searchField(): Rect =
        waitForNode(6_000) { it.hintText?.toString() == "Search bookmarks" || it.text?.toString() == "Search bookmarks" }
            ?: error("no search field in the bookmarks panel")

    /** Poll for a node whose text or description matches, ignoring case (the picker's buttons are all-caps). */
    private fun waitForText(label: String, timeoutMs: Long): Rect? =
        waitForNode(timeoutMs) { node ->
            node.text?.toString()?.equals(label, ignoreCase = true) == true ||
                node.contentDescription?.toString()?.equals(label, ignoreCase = true) == true
        }

    private fun waitForNode(timeoutMs: Long, predicate: (AccessibilityNodeInfo) -> Boolean): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            nodeWhere(predicate)?.let { node -> return Rect().also { node.getBoundsInScreen(it) } }
            SystemClock.sleep(250)
        }
        return null
    }

    /** Breadth-first search of the active window (the picker's when it is in front). */
    private fun nodeWhere(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (predicate(node)) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    companion object {
        const val FIXTURE = "chrome-bookmarks.html"
        /** aria-label of the panel header's overflow button. */
        const val MORE_LABEL = "More bookmark actions"
        /** title of the overlay header's close button (OverlayShell). */
        const val CLOSE_LABEL = "Close (Esc)"
    }
}
