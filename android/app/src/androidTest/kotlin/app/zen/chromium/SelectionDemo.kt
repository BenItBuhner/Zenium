package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the text-selection toolbar with Zenium's items (parity row GN-13, and SH-10's Share)
 * on a device, and writes what it measured to `selection-findings.txt` next to the screenshots
 * (one `PASS` or `FAIL` per check; the test fails at the end when any check did):
 *
 *  - a REAL long press (injected touch) on a word selects it and the system's floating toolbar
 *    shows Copy, then Zenium's `Search DuckDuckGo` (the profile's engine) and `Share` right after
 *    it, one Share in all, each read from the items' content descriptions;
 *  - a real touch on `Search DuckDuckGo` opens a NEW tab with the query in the BACKGROUND (this
 *    tab stays active, the new one is its child) and the toolbar goes;
 *  - a real touch on `Share` brings the system share sheet with the text (Zenium's share; the
 *    WebView's own Share is hidden, so there is one to touch);
 *  - a long press on an address written as plain text (a `user-select: all` span, so the whole
 *    address is taken) lists `Open in Glance` instead of the search, and a real touch on it
 *    opens the address in a glance over the page;
 *  - the items follow the selection while the toolbar is up: a real drag of the end handle from
 *    the address onto the text below flips the bar to `Search DuckDuckGo`, a drag back to
 *    `Open in Glance`, and a real touch on the system's `Select all` over the address flips it
 *    to the search too (the whole page is no address);
 *  - the same toolbar in dark, for the design record.
 *
 * The pages come from a loopback server inside this process ([DemoServer]); the search goes to
 * the profile's engine (DuckDuckGo) and is asserted on the tab's URL, not on the page loading.
 * See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SelectionDemo : DemoHarness("selection-demo-state.json", "selection", "selection-demo") {
    override val tag = "SelectionDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("selection-demo-page.html").toByteArray()),
                "/glance.html" to DemoServer.page("Glance target", "<p>Opened from the address selected on the page.</p>"),
                "/right.html" to DemoServer.page("Right tab")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures selection toolbar check(s) failed; see selection-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "selection-findings.txt")
        findings.writeText("Zenium Android text-selection toolbar checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_000)
        finding("start: ${describeActive()}")
        // The first action mode pays for the floating toolbar's inflation: once, off camera.
        val warm = longPress("#word") { it.zenium() }
        finding("warm-up toolbar: ${warm.describe()}")
        clearSelection()
    }

    override fun demo() {
        shot("00-page")
        wordToolbar()
        searchEngine()
        shareFromToolbar()
        addressToGlance()
        handleDrag()
        selectAll()
        darkToolbar()
        finding("\nend: ${describeActive()}${if (failures == 0) "" else "; $failures FAIL"}")
    }

    // --- GN-13: the items -------------------------------------------------------------------------

    /** A long press on a word: the system's toolbar with Zenium's items after Copy, one Share. */
    private fun wordToolbar() {
        finding("\nGN-13 long press on a word: Zenium's items after Copy")
        val items = longPress("#word") { it.zenium() }
        val selected = jsonString(tabJs("String(getSelection())"))
        SystemClock.sleep(800)
        shot("01-toolbar-light")
        finding("  injected long press on 'quantum': selection '$selected' ${verdict(selected == "quantum")}")
        finding("  toolbar (content descriptions, left to right): ${items.describe()}")
        items.orEmpty().forEach { finding("    ${it.label}: ${it.bounds.toShortString()}") }
        checkZeniumItems(items, first = SEARCH)
        clearSelection()
    }

    /**
     * The checks both selections share: Copy is the system's; Zenium's `first` item follows it at
     * once; Share follows that, in the bar or (when a system assist item took the room) as the one
     * Zenium item behind the overflow, which the overflow is opened once to list; one Share in all.
     */
    private fun checkZeniumItems(items: List<ToolbarItem>?, first: String) {
        val labels = items.orEmpty().map { it.label }
        val copy = labels.indexOf("Copy")
        check("the system's Copy is there", copy >= 0)
        check("$first right after Copy", copy >= 0 && labels.getOrNull(copy + 1) == first)
        val overflow = if ("More options" in labels) openOverflow(items.orEmpty()) else null
        finding(
            "  overflow: ${
                when {
                    "More options" !in labels -> "none, everything fits in the bar"
                    overflow == null -> "present, could not be listed"
                    else -> overflow.joinToString(" | ")
                }
            }"
        )
        val shareInBar = labels.getOrNull(copy + 2) == "Share"
        val shareInOverflow = "Share" !in labels && overflow?.contains("Share") == true
        check(
            "Share follows $first (${if (shareInBar) "in the bar" else if (shareInOverflow) "the one Zenium item behind the overflow" else "MISSING"})",
            shareInBar || shareInOverflow
        )
        check("at most one Zenium item behind the overflow", first in labels)
        check(
            "one Share in all (the WebView's own is hidden)",
            labels.count { it == "Share" } + (overflow?.count { it == "Share" } ?: 0) == 1
        )
    }

    /**
     * A real touch on the toolbar's overflow button; the labels of the list behind it, top to
     * bottom, or null when the list never showed. The arrow closes it again.
     */
    private fun openOverflow(items: List<ToolbarItem>): List<String>? {
        val more = items.find { it.label == "More options" } ?: return null
        touchTapPoint(more.node) ?: return null
        val deadline = SystemClock.uptimeMillis() + 5_000
        var listed: List<String>? = null
        while (SystemClock.uptimeMillis() < deadline && listed == null) {
            SystemClock.sleep(300)
            listed = overflowLabels()
        }
        SystemClock.sleep(700)
        shot("01b-overflow")
        findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
        SystemClock.sleep(800)
        return listed
    }

    /**
     * A real touch on the toolbar's overflow button, then on the item `label` in the list behind
     * it; where the finger landed on the item, or null when the list or the item never showed
     * (the list is closed again then).
     */
    private fun touchInOverflow(items: List<ToolbarItem>, label: String): PointF? {
        val more = items.find { it.label == "More options" } ?: return null
        touchTapPoint(more.node) ?: return null
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            if (overflowLabels() != null) break
        }
        SystemClock.sleep(500)
        val node = findInWindows { it == label } ?: run {
            finding("  '$label' is not behind the overflow: ${overflowLabels()?.joinToString(" | ") ?: "no list"}")
            findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
            return null
        }
        return touchTapPoint(node)
    }

    /** The labels in the toolbar window while its overflow list is open (told by the close arrow), the arrow left out. */
    private fun overflowLabels(): List<String>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<Pair<String, Rect>>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: node.text?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isVisibleToUser) labels += label to Rect().also { node.getBoundsInScreen(it) }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (labels.any { it.first == "Close overflow" }) {
                return labels.filter { it.first != "Close overflow" }.sortedBy { it.second.top }.map { it.first }.distinct()
            }
        }
        return null
    }

    /** A real touch on Search DuckDuckGo: a new tab with the query, in the background, this tab's child. */
    private fun searchEngine() {
        finding("\nGN-13 $SEARCH: the selection as a query in a new background tab")
        ensureForeground()
        val items = longPress("#word") { it.zenium() }
        val known = tabIds()
        val target = items?.find { it.label == SEARCH }
        val point = target?.let { touchTapPoint(it.node) }
        finding("  real touch on $SEARCH ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}" } ?: "NOT POSSIBLE (item missing or off screen)"}")
        val created = awaitNewTab(known)
        SystemClock.sleep(1_500)
        shot("02-search-background-tab")
        val url = created?.optString("url").orEmpty()
        finding("  new tab: ${created?.optString("id") ?: "NONE"} '$url'")
        check("a new tab with the query through the default engine", url.startsWith("https://duckduckgo.com/?q=") && url.contains("quantum"))
        check("opened in the background: this tab stays active", activeTabId() == "tab_demo")
        check("the new tab is this tab's child (openerTabId)", created?.optString("openerTabId") == "tab_demo")
        check("the toolbar is gone after the touch", awaitToolbarGone())
        check("the selection is cleared", jsonString(tabJs("String(getSelection())")).isEmpty())
        // Show the result tab for the record, then come back.
        val id = created?.optString("id").orEmpty()
        if (id.isNotEmpty()) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(id)}}")
            SystemClock.sleep(4_000)
            shot("03-search-tab")
            ensureActive("tab_demo")
        }
    }

    // --- SH-10: Share ----------------------------------------------------------------------------

    /** A real touch on Share: the system share sheet, through Zenium's share (the page's title on it). */
    private fun shareFromToolbar() {
        finding("\nSH-10 Share from the toolbar: the system sheet")
        ensureForeground()
        val items = longPress("#word") { it.zenium() }
        val share = items?.find { it.label == "Share" }
        val point = share?.let { touchTapPoint(it.node) }
        finding("  real touch on Share ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}" } ?: "NOT POSSIBLE (item missing or off screen)"}")
        val sheet = awaitSystemWindow(10_000)
        SystemClock.sleep(3_000)
        shot("04-share-sheet")
        val top = topPackage()
        val preview = findInWindows { it.contains("quantum") } != null
        check("the system share sheet is in front ($top)", sheet)
        finding("  the sheet ${if (preview) "previews" else "does not preview"} the selected text 'quantum'")
        if (sheet) {
            back()
            SystemClock.sleep(2_000)
        }
        ensureForeground()
        clearSelection()
    }

    // --- GN-13: an address -----------------------------------------------------------------------

    /** A long press on an address as plain text: Open in Glance instead of the search; a real touch opens the glance. */
    private fun addressToGlance() {
        finding("\nGN-13 an address selected: Open in Glance")
        val items = longPress("#url") { it.any { item -> item.label == "Open in Glance" } }
        val selected = jsonString(tabJs("String(getSelection())"))
        SystemClock.sleep(800)
        shot("05-toolbar-address")
        finding("  injected long press on the address: selection '$selected' ${verdict(selected == GLANCE_URL)}")
        finding("  toolbar: ${items.describe()}")
        val labels = items.orEmpty().map { it.label }
        val copy = labels.indexOf("Copy")
        check("Open in Glance right after Copy", copy >= 0 && labels.getOrNull(copy + 1) == "Open in Glance")
        check("no $SEARCH for an address", SEARCH !in labels)
        finding("  Share: ${if ("Share" in labels) "in the bar after Open in Glance ${verdict(labels.getOrNull(copy + 2) == "Share")}" else "not in the bar (behind the overflow with the system's items)"}")
        val target = items?.find { it.label == "Open in Glance" }
        val point = target?.let { touchTapPoint(it.node) }
        finding("  real touch on Open in Glance ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}" } ?: "NOT POSSIBLE (item missing or off screen)"}")
        val glance = awaitGlance()
        SystemClock.sleep(4_000)
        shot("06-glance")
        val glanceTab = glance?.optString("tabId")?.let { coreState().getJSONObject("tabs").optJSONObject(it) }
        finding("  glance: ${glance?.let { "tab ${it.optString("tabId")} '${glanceTab?.optString("url")}'" } ?: "NONE"}")
        check("the address opens in a glance over the page", glanceTab?.optString("url") == GLANCE_URL)
        check("this tab stays the active tab under the glance", activeTabId() == "tab_demo")
        if (glance != null) {
            back()
            SystemClock.sleep(2_500)
            if (coreState().optJSONObject("glance") != null) coreInvoke("glance.close")
            SystemClock.sleep(1_500)
        }
        clearSelection()
    }

    // --- GN-13: the items follow the selection ----------------------------------------------------

    /**
     * The toolbar is up over the address; a REAL drag of the selection's end handle onto the text
     * below makes the selection no address, and the bar must say so (`Search DuckDuckGo`, no
     * `Open in Glance`); a drag back onto the address restores `Open in Glance`. The handle is
     * Chromium's own (drawn under the selection's end), so it is found from the selection's last
     * client rect and pressed where the handle's bitmap sits. The log tells how the WebView
     * refreshed the mode each time (created anew, or the same one prepared again).
     */
    private fun handleDrag() {
        finding("\nGN-13 handle drag: the items follow the selection")
        ensureForeground()
        val before = longPress("#url") { it.any { item -> item.label == "Open in Glance" } }
        finding("  toolbar over the address: ${before.describe()}")
        val addressEnd = selectionEnd()
        val tail = textBottom("#tail")
        if (addressEnd == null || tail == null) {
            check("the selection's end and the text below are known", false)
            clearSelection()
            return
        }
        val marks = selectionLog().size
        // Onto the text below.
        val grabbed = dragHandle(from = addressEnd, to = tail)
        val onText = awaitToolbar { it.any { item -> item.label == SEARCH } }
        val selectedOnText = jsonString(tabJs("String(getSelection())"))
        SystemClock.sleep(800)
        shot("08-drag-onto-text")
        finding("  end handle pressed at ${grabbed.x.toInt()},${grabbed.y.toInt()} and dragged to ${tail.x.toInt()},${tail.y.toInt()}")
        finding("  selection now: '${selectedOnText.replace("\n", "\\n")}'")
        finding("  toolbar: ${onText.describe()}")
        val textLabels = onText.orEmpty().map { it.label }
        check("the selection grew past the address", selectedOnText.startsWith(GLANCE_URL) && selectedOnText.length > GLANCE_URL.length)
        check("the bar flips to $SEARCH", SEARCH in textLabels)
        check("Open in Glance is gone from the bar", "Open in Glance" !in textLabels)
        // And back onto the address: dropped a few characters in from its end (the span is
        // `user-select: all`, so the whole address is taken again; a drop past the end could
        // land after the span).
        val textEnd = selectionEnd()
        val addressInside = textRect("#url")?.let { PointF(it.right - 12 * density, it.bottom - 1) }
        if (textEnd == null || addressInside == null) {
            check("the selection's end and the address are known for the drag back", false)
            clearSelection()
            return
        }
        val grabbedBack = dragHandle(from = textEnd, to = addressInside)
        val onAddress = awaitToolbar { it.any { item -> item.label == "Open in Glance" } }
        val selectedBack = jsonString(tabJs("String(getSelection())"))
        SystemClock.sleep(800)
        shot("09-drag-back-onto-address")
        finding("  end handle pressed at ${grabbedBack.x.toInt()},${grabbedBack.y.toInt()} and dragged back to ${addressInside.x.toInt()},${addressInside.y.toInt()}")
        finding("  selection now: '${selectedBack.replace("\n", "\\n")}'")
        finding("  toolbar: ${onAddress.describe()}")
        val addressLabels = onAddress.orEmpty().map { it.label }
        val backText = selectedBack.trim()
        check(
            "the selection is an address again (${if (backText == GLANCE_URL) "the whole one" else "'$backText'"})",
            backText.startsWith("$ORIGIN/glance") && !backText.any { it.isWhitespace() }
        )
        check("the bar flips back to Open in Glance", "Open in Glance" in addressLabels)
        check("$SEARCH is gone from the bar", SEARCH !in addressLabels)
        val log = selectionLog().drop(marks)
        finding("  the WebView's mode across the two drags: ${log.count { "created" in it }} created, ${log.count { "prepared" in it }} prepared, ${log.count { "destroyed" in it }} destroyed")
        log.forEach { finding("    $it") }
        clearSelection()
    }

    /**
     * The toolbar over the address; a REAL touch on the system's Select all (in the bar, or behind
     * the overflow when the system's assist item took its room): the whole page is no address, the
     * bar says so.
     */
    private fun selectAll() {
        finding("\nGN-13 Select all: the items follow the selection")
        ensureForeground()
        val before = longPress("#url") { it.any { item -> item.label == "Open in Glance" } }
        finding("  toolbar over the address: ${before.describe()}")
        val marks = selectionLog().size
        val inBar = before?.find { it.label == "Select all" }
        val point = inBar?.let { touchTapPoint(it.node) } ?: touchInOverflow(before.orEmpty(), "Select all")
        finding("  real touch on Select all ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}${if (inBar == null) " (behind the overflow)" else ""}" } ?: "NOT POSSIBLE (item missing or off screen)"}")
        val after = awaitToolbar { it.any { item -> item.label == SEARCH } }
        val selected = jsonString(tabJs("String(getSelection())"))
        SystemClock.sleep(800)
        shot("10-select-all")
        finding("  selection now: ${selected.length} characters, ${selected.lines().size} lines")
        finding("  toolbar: ${after.describe()}")
        val labels = after.orEmpty().map { it.label }
        check("the whole page is selected", selected.contains("quantum") && selected.contains(GLANCE_URL) && selected.contains("Nothing below"))
        check("the bar flips to $SEARCH", SEARCH in labels)
        check("Open in Glance is gone from the bar", "Open in Glance" !in labels)
        val log = selectionLog().drop(marks)
        finding("  the WebView's mode across Select all: ${log.count { "created" in it }} created, ${log.count { "prepared" in it }} prepared, ${log.count { "destroyed" in it }} destroyed")
        clearSelection()
    }

    /**
     * A REAL drag of the selection's end handle: pressed where Chromium draws it – its bitmap
     * hangs under the selection's end, hotspot a quarter of the way in from its left – moved in
     * steps to `to` and released; the handle's drag end is what shows the menu again. The point pressed.
     */
    private fun dragHandle(from: PointF, to: PointF): PointF {
        val grab = PointF(from.x + HANDLE_GRAB_DP.x * density, from.y + HANDLE_GRAB_DP.y * density)
        Log.i(tag, "drag handle from ${grab.x},${grab.y} to ${to.x},${to.y}")
        Finger().apply {
            down(grab.x, grab.y)
            hold(250)
            moveBy(to.x - from.x, to.y - from.y, 900)
            hold(300)
            up()
        }
        return grab
    }

    /** Where the selection ends on screen: the right-bottom corner of its last client rect. */
    private fun selectionEnd(): PointF? = screenPoint(
        tabJs(
            "(function(){var s=getSelection();if(!s.rangeCount)return null;var rs=s.getRangeAt(0).getClientRects();" +
                "if(!rs.length)return null;var r=rs[rs.length-1];return [r.right,r.bottom]})()"
        )
    )

    /** The middle-bottom of the text inside the first element `selector` names (a drop on its line). */
    private fun textBottom(selector: String): PointF? = textRect(selector)?.let { PointF(it.centerX(), it.bottom - 1) }

    /**
     * The screen rectangle of the text inside the first element `selector` names (a range over its
     * contents: the text's own line box, not the element's padding), or null.
     */
    private fun textRect(selector: String): RectF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=document.createRange();r.selectNodeContents(e);var b=r.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom]})()"
        )
        val box = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return RectF(
            origin[0] + box.getDouble(0).toFloat() * density,
            origin[1] + box.getDouble(1).toFloat() * density,
            origin[0] + box.getDouble(2).toFloat() * density,
            origin[1] + box.getDouble(3).toFloat() * density
        )
    }

    /** A page point `[x, y]` (CSS px, the JSON text of it) as a screen point, or null. */
    private fun screenPoint(raw: String): PointF? {
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    /** The wrapper's log of the selection mode's life so far (`TabWebView.SELECTION_TAG`), oldest first. */
    private fun selectionLog(): List<String> =
        shell("logcat -d -v raw -s ${TabWebView.SELECTION_TAG}:D").lines().map { it.trim() }.filter { it.startsWith("selection mode") }

    // --- the design record -----------------------------------------------------------------------

    /** The same toolbar with the system and the chrome in dark: the still for the design record. */
    private fun darkToolbar() {
        finding("\ndesign record: the toolbar in dark")
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(5_000)
        ensureForeground()
        val items = longPress("#word") { it.zenium() }
        SystemClock.sleep(1_000)
        shot("07-toolbar-dark")
        finding("  toolbar: ${items.describe()}")
        val labels = items.orEmpty().map { it.label }
        val copy = labels.indexOf("Copy")
        check("dark: $SEARCH and Share after Copy", copy >= 0 && labels.getOrNull(copy + 1) == SEARCH && labels.getOrNull(copy + 2) == "Share")
        clearSelection()
        SystemClock.sleep(1_000)
        shell("cmd uimode night no")
    }

    // --- the toolbar -----------------------------------------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    private fun List<ToolbarItem>?.describe(): String = this?.joinToString(" | ") { it.label } ?: "MISSING"

    private fun List<ToolbarItem>.zenium(): Boolean = any { it.label == SEARCH || it.label == "Open in Glance" }

    /**
     * The floating toolbar's buttons, left to right: the clickable nodes with a content
     * description in the window that holds the system's Copy (the toolbar is a popup window of
     * its own; each item is a button described by its title, so TalkBack reads it; the item's
     * own text view is not clickable and is left out). Null while no toolbar is up.
     */
    private fun toolbarItems(): List<ToolbarItem>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val items = ArrayList<ToolbarItem>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isClickable && node.isVisibleToUser) {
                    items += ToolbarItem(label, Rect().also { node.getBoundsInScreen(it) }, node)
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (items.any { it.label == "Copy" }) return items.sortedBy { it.bounds.left }
        }
        return null
    }

    /**
     * Poll for the toolbar until `ready` is content with its items (Zenium's join the system's a
     * moment after the mode starts: the core is asked once the selection is read), for up to
     * `timeoutMs`; then whatever toolbar is up, or null when none came.
     */
    private fun awaitToolbar(timeoutMs: Long = 12_000, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: List<ToolbarItem>? = null
        while (SystemClock.uptimeMillis() < deadline) {
            toolbarItems()?.let { items ->
                last = items
                if (ready(items)) return items
            }
            SystemClock.sleep(250)
        }
        return last
    }

    private fun awaitToolbarGone(timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (toolbarItems() == null) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /**
     * A REAL long press (injected touch) on the middle of the first element `selector` names on
     * the page: Blink selects the word under the finger (the address span selects whole, it is
     * `user-select: all`), the WebView starts its action mode. The toolbar's items once `ready`.
     */
    private fun longPress(selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val p = pagePoint(selector) ?: run {
            finding("  no $selector on the page")
            return null
        }
        Log.i(tag, "long press at ${p.x},${p.y} on $selector")
        Finger().apply {
            down(p.x, p.y)
            hold(1_200)
            up()
        }
        return awaitToolbar(ready = ready)
    }

    /** A tap on the page's last line clears the selection and finishes the mode. */
    private fun clearSelection() {
        pagePoint("#tail")?.let { Finger().tap(it.x, it.y) }
        awaitToolbarGone()
        SystemClock.sleep(1_000)
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? = screenPoint(
        tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
    )

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun tabIds(): Set<String> = coreState().getJSONObject("tabs").keys().asSequence().toSet()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabIds().size} tabs" }

    /** Poll for a tab that was not among `known` (the search opening its tab); that tab, or null. */
    private fun awaitNewTab(known: Set<String>, timeoutMs: Long = 12_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tabs = coreState().getJSONObject("tabs")
            for (id in tabs.keys()) if (id !in known) return tabs.getJSONObject(id)
            SystemClock.sleep(300)
        }
        Log.w(tag, "no new tab appeared")
        return null
    }

    /** Poll for a glance in the window's state; its `{ tabId, ... }`, or null. */
    private fun awaitGlance(timeoutMs: Long = 12_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            coreState().optJSONObject("glance")?.let { return it }
            SystemClock.sleep(300)
        }
        Log.w(tag, "no glance opened")
        return null
    }

    private fun ensureActive(tabId: String) {
        if (activeTabId() == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        settle()
    }

    private fun topPackage(): String = ui.rootInActiveWindow?.packageName?.toString() ?: "?"

    /** A shell command through UiAutomation, as adb would run it (base64 keeps its quoting intact). */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    // --- findings --------------------------------------------------------------------------------

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $what ${verdict(ok)}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18135
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val GLANCE_URL = "$ORIGIN/glance.html"
        /** Zenium's search item names the profile's engine (`selection-demo-state.json`: DuckDuckGo). */
        private const val SEARCH = "Search DuckDuckGo"
        /**
         * Where to press the end handle, from the selection's end (dp): Chromium hangs the right
         * handle's bitmap (the material theme's is 44 x 22 dp, a quarter of it transparent padding)
         * under the selection's end with its left edge a quarter of the width to the left
         * (`HandleViewResources.HANDLE_HORIZONTAL_PADDING_RATIO`), so the bitmap's middle – the
         * teardrop's – is 11 dp right of the end and 11 dp down; a touch must land inside the bitmap.
         */
        private val HANDLE_GRAB_DP = PointF(11f, 11f)
    }
}
