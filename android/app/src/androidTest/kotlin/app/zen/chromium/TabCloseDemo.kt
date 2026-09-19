package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records closing tabs from the phone's tab overview and taking it back (matrix TAB-05, TAB-06,
 * TAB-07, TAB-22, TAB-23, GN-16, BH-26; v2 draft 9.23, 9.33, 11.4), with every press a real
 * touch and the outcome of each read off the core's state, never off the chrome's word:
 *
 *  1. a card closed with its X: the toast `Closed <title>` with Undo; Undo puts the tab back
 *     at its index;
 *  2. a card of the Research group swiped off the grid: the same toast; Undo puts it back into
 *     the group at its index;
 *  3. the header menu's Close all tabs: the `Close 7 tabs?` prompt; a touch on Close all closes
 *     every unpinned tab of the space (Essentials stay), one `7 tabs closed` toast; Undo brings
 *     the seven back in their order, group included;
 *  4. the prompt's Don't ask again: touched, then Close all; `settings.confirmCloseAll` is off
 *     in the core; Undo; the next Close all closes without a prompt; Undo;
 *  5. Recently closed: a card closed with its X, the menu's row opens the sheet, a touch on the
 *     entry restores the tab and the overview leaves on it.
 *
 * Positions come from the chrome's DOM (`getBoundingClientRect`, checked once against the
 * accessibility bounds of the overview's Spaces button), because the WebView's accessibility
 * tree trails the software-rendered emulator by seconds. Findings go to
 * `tab-close-findings.txt` next to the stills (one PASS or FAIL per claim, ALL CHECKS PASSED at
 * the end); the run fails on any FAIL. Profile `overview-demo-state.json`: the Work space with the
 * group Research [World Wide Web, Damping] and the loose tabs example.com (active), Hacker News,
 * RFC 2324, Tea, Coffee, plus three Essentials. Driven by `android-tab-close-demo.yml`. See
 * [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabCloseDemo : DemoHarness("overview-demo-state.json", "tab-close", "tabclose-demo") {
    override val tag = "TabCloseDemo"
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0

    @Test
    fun record() {
        runDemo()
        if (failures > 0) error("$failures check(s) failed; see tab-close-findings.txt")
    }

    /** Visit the next tab and come back so the two front cards have thumbnails. */
    override fun warmUp() {
        findings = File(out, "tab-close-findings.txt")
        findings.writeText(
            "Zenium Android tab closing checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        finding("start: ${describeSpace()}")
    }

    override fun demo() {
        openOverview()
        still("grid")
        val start = trackOrder()

        closeByX(start)
        swipeOff(start)
        closeAllWithPrompt(start)
        dontAskAgain(start)
        recentlyClosed()

        still("end")
        finding("\nend: ${describeSpace()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. Tea closed with its X, then Undo on the toast. */
    private fun closeByX(start: List<Pair<String, String?>>) {
        finding("\n1. Tea closed with its X, Undo on the toast")
        val x = show("${card(TEA)} [aria-label=\"Close tab\"]")
        touch(x, "the X of Tea")
        val gone = awaitTab(TEA, exists = false)
        expect("the tab is closed at once", gone)
        val toast = awaitToast("Closed ")
        expect("a toast reads 'Closed <title>' with Undo: '${toast.orEmpty()}'", toast != null && undoRect() != null)
        expect("the card has left the grid", awaitDom("!document.querySelector('${card(TEA)}')"))
        still("closed-x-toast")
        undo("Undo")
        expect("Undo brings Tea back", awaitTab(TEA, exists = true))
        SystemClock.sleep(SETTLE)
        expect("Tea is back at its index, loose", trackOrder() == start)
        still("undo-x")
        awaitToastGone()
    }

    /** 2. Damping, in the Research group, swiped off the grid, then Undo. */
    private fun swipeOff(start: List<Pair<String, String?>>) {
        finding("\n2. Damping (group Research) swiped off the grid, Undo on the toast")
        val damping = show(card(DAMPING))
        val f = Finger()
        f.down(damping.exactCenterX(), damping.exactCenterY())
        f.moveBy(1.1f * damping.width(), 0f, 220)
        f.up()
        finding("  swipe from ${damping.exactCenterX().roundToInt()},${damping.exactCenterY().roundToInt()} by ${(1.1f * damping.width()).roundToInt()} px")
        expect("the tab is closed once the card has flown off", awaitTab(DAMPING, exists = false, timeoutMs = 10_000))
        val toast = awaitToast("Closed ")
        expect("the toast reads 'Closed <title>': '${toast.orEmpty()}'", toast != null)
        still("closed-swipe-toast")
        undo("Undo")
        expect("Undo brings Damping back", awaitTab(DAMPING, exists = true))
        SystemClock.sleep(SETTLE)
        expect("Damping is back in Research at its index", trackOrder() == start && folderOf(DAMPING) == RESEARCH)
        still("undo-swipe")
        awaitToastGone()
    }

    /** 3. Close all tabs from the header menu, the prompt, Close all touched, one toast, Undo. */
    private fun closeAllWithPrompt(start: List<Pair<String, String?>>) {
        finding("\n3. Close all tabs: the prompt, Close all, one toast, Undo restores the seven")
        openMenuRow("Close all tabs")
        expect("the prompt asks 'Close 7 tabs?'", awaitText(".zen-frame-dialogs", "Close 7 tabs?"))
        expect("the prompt carries Don't ask again, unticked", awaitDom("document.querySelector('$CHECKBOX') && !document.querySelector('$CHECKBOX').checked"))
        still("closeall-prompt")
        touch(footerButton("Close all"), "Close all on the prompt")
        // The toast lives 5 s: the checks between the close and the Undo are the quick ones.
        expect("every unpinned tab of the space is closed", awaitUnpinned(0, 15_000))
        val toast = awaitToast("7 tabs closed")
        expect("one toast reads '7 tabs closed': '${toast.orEmpty()}'", toast != null)
        still("closeall-toast")
        undo("Undo")
        expect("Undo brings the seven back", awaitUnpinned(7, 20_000))
        SystemClock.sleep(SETTLE)
        expect("they are back in their order, Research whole", trackOrder() == start)
        expect("the Essentials were never touched", coreState().getJSONObject("tabs").let { it.has(MAIL) && it.has(CAL) && it.has(GH) })
        still("undo-all")
        awaitToastGone()
    }

    /** A footer button of the prompt sheet by its label, once the sheet has come to rest. */
    private fun footerButton(label: String): Rect =
        steadyRect({ textRect(".zen-frame-dialogs .zen-sheet-footer button", label) }) ?: error("no $label button on the prompt")

    /** 4. Don't ask again touched: the setting turns off with the close; the next Close all has no prompt. */
    private fun dontAskAgain(start: List<Pair<String, String?>>) {
        finding("\n4. Don't ask again, then Close all twice: the second time without the prompt")
        openMenuRow("Close all tabs")
        expect("the prompt is up", awaitText(".zen-frame-dialogs", "Close 7 tabs?"))
        val check = steadyRect({ domRect(CHECKBOX) }) ?: error("no Don't ask again checkbox")
        touch(check, "the Don't ask again checkbox")
        expect("the checkbox is ticked by the touch", awaitDom("!!document.querySelector('$CHECKBOX') && document.querySelector('$CHECKBOX').checked"))
        still("dont-ask-checked")
        touch(footerButton("Close all"), "Close all on the prompt")
        expect("the tabs close", awaitUnpinned(0, 15_000))
        expect("settings.confirmCloseAll is off in the core", awaitSetting("confirmCloseAll", false))
        undo("Undo")
        expect("Undo brings the seven back", awaitUnpinned(7, 20_000))
        SystemClock.sleep(SETTLE)
        awaitToastGone()

        openMenuRow("Close all tabs")
        expect("the tabs close at once", awaitUnpinned(0, 15_000))
        expect("with no prompt", !awaitText(".zen-frame-dialogs", "Close 7 tabs?", timeoutMs = 300))
        val toast = awaitToast("7 tabs closed")
        expect("the toast reads '7 tabs closed': '${toast.orEmpty()}'", toast != null)
        undo("Undo")
        expect("Undo brings the seven back", awaitUnpinned(7, 20_000))
        SystemClock.sleep(SETTLE)
        expect("in their order", trackOrder() == start)
        still("closeall-noprompt-undone")
        awaitToastGone()
    }

    /** 5. Hacker News closed with its X; Recently closed lists it; a touch on the row restores it. */
    private fun recentlyClosed() {
        finding("\n5. Recently closed: Hacker News closed, listed, restored from the sheet")
        val x = show("${card(HN)} [aria-label=\"Close tab\"]")
        touch(x, "the X of Hacker News")
        expect("the tab is closed", awaitTab(HN, exists = false))
        awaitToastGone()
        openMenuRow("Recently closed")
        expect("the sheet lists the entry", awaitText(".zen-frame-dialogs .zen-list-row", "Hacker News", timeoutMs = 8_000) ||
            awaitText(".zen-frame-dialogs .zen-list-row", "news.ycombinator.com", timeoutMs = 1_000))
        still("recent-list")
        val row = steadyRect({ textRect(".zen-frame-dialogs .zen-list-row .zen-list-main", "") }) ?: error("no row in the sheet")
        touch(row, "the first Recently closed row")
        expect("the tab is restored", awaitTab(HN, exists = true))
        expect("the overview leaves on it", awaitDom("!document.querySelector('.zen-overview')", 10_000))
        SystemClock.sleep(SETTLE)
        expect("Hacker News is the active tab", activeSpace(coreState()).optString("activeTabId") == HN)
        still("recent-restored")
    }

    // --- moves -----------------------------------------------------------------------------------

    /** A real touch on the middle of `box` (screen px), logged. */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        Finger().tap(point.x, point.y)
    }

    /** Touch the toast's action once it is there (the toast lives 5 s: no waiting about). */
    private fun undo(label: String) {
        val button = awaitRect({ undoRect() }, 6_000) ?: run {
            record("  the toast's $label button never showed", false)
            return
        }
        // The toast rises into place; a moment for it to rest before the touch.
        SystemClock.sleep(300)
        touch(undoRect() ?: button, "the toast's $label")
    }

    /**
     * Open the overview header's menu with a touch on More, then touch the row whose label
     * starts with `row` (`Close all tabs (7)`, `Recently closed (1)`) once the sheet has risen.
     */
    private fun openMenuRow(row: String) {
        val more = box("[aria-label=\"More\"]")
        touch(more, "More in the overview header")
        val item = steadyRect({ textRect(".zen-sheet-item", row) }) ?: error("no '$row' row in the menu")
        touch(item, "'$row' in the menu")
    }

    /**
     * A box read from the DOM once two reads [STEADY_MS] apart agree (a sheet's rows while it
     * rises report where they are on each frame); the last read when they never do within
     * [LOOKUP_WAIT], null when the element never shows.
     */
    private fun steadyRect(read: () -> Rect?): Rect? {
        var last = awaitRect(read, LOOKUP_WAIT) ?: return null
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STEADY_MS)
            val again = read() ?: return last
            if (again == last) return again
            last = again
        }
        finding("  (still moving after $LOOKUP_WAIT ms: $last)")
        return last
    }

    /**
     * Open the overview with a touch on the bar's Tabs button (the count trails its label);
     * a touch the emulator's lag turns into a hold is dismissed and tried again.
     */
    private fun openOverview() {
        for (attempt in 0 until OPEN_ATTEMPTS) {
            closeUrlbar()
            val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: domRect("[aria-label^=\"Tabs (\"]")
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (!overviewOpen() && SystemClock.uptimeMillis() < deadline) {
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt ${attempt + 1}: dismissed, trying again)")
                    back()
                    val gone = SystemClock.uptimeMillis() + 4_000
                    while (heldInstead() && SystemClock.uptimeMillis() < gone) SystemClock.sleep(200)
                    SystemClock.sleep(1_000)
                    break
                }
                SystemClock.sleep(200)
            }
            if (overviewOpen()) {
                SystemClock.sleep(2_000)
                calibrate()
                return
            }
        }
        error("the overview never opened")
    }

    private fun heldInstead(): Boolean =
        jsString("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet') ? 'held' : ''})()") == "held"

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    // --- where things are: the chrome's DOM ----------------------------------------------------

    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    private fun rectFrom(text: String): Rect? {
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        return Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    /**
     * The on-screen box of the first element `selector` matches, null when nothing does. With
     * `scrollIntoView`, the overview grid is scrolled the least it has to for the element to be
     * fully in its viewport first.
     */
    private fun domRect(selector: String, scrollIntoView: Boolean = false): Rect? {
        val scroll = if (!scrollIntoView) "" else
            "var g=document.querySelector('.zen-overview-grid');" +
                "if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
                "if(er.top<gr.top||er.bottom>gr.bottom)e.scrollIntoView({block:'nearest'});}"
        return rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$scroll$RECT_JS})()"))
    }

    /** The box of the first element matching `selector` whose text starts with `prefix` (any, when `prefix` is empty). */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';$RECT_JS})()"
            )
        )

    /** The toast's action button (`Undo`), when a toast is up. */
    private fun undoRect(): Rect? = domRect(".zen-message-toast .zen-message-button")

    /** The box of `selector`, waiting for it to be in the DOM; the demo cannot go on without it. */
    private fun box(selector: String): Rect =
        awaitRect({ domRect(selector) }, LOOKUP_WAIT) ?: error("nothing matches $selector")

    /** Like [box], after scrolling the element fully into the grid's viewport when it is not. */
    private fun show(selector: String): Rect {
        val before = box(selector)
        val after = domRect(selector, scrollIntoView = true) ?: before
        if (after != before) SystemClock.sleep(1_200)
        return domRect(selector) ?: after
    }

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(200)
        }
    }

    /** Poll a JS boolean expression against the chrome's document. */
    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (jsString("(function(){return ($expression)?'yes':''})()") == "yes") return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(200)
        }
    }

    /** Whether an element matching `selector` whose text contains `text` shows up in time. */
    private fun awaitText(selector: String, text: String, timeoutMs: Long = 8_000): Boolean =
        awaitDom(
            "Array.prototype.some.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                "function(n){return n.textContent.indexOf(${JSONObject.quote(text)})>=0})",
            timeoutMs
        )

    /** The toast's text once one starting with `prefix` is up; null when none comes in time. */
    private fun awaitToast(prefix: String, timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val text = jsString("(function(){var e=document.querySelector('.zen-message-toast .zen-message-text');return e?e.textContent:''})()")
            if (text.startsWith(prefix)) return text
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    /** Wait for the toast to leave (its clock, plus its exit), so the next step starts with none up. */
    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /**
     * Check the DOM's coordinates against the accessibility tree once: the Spaces button in the
     * overview's header never moves, so its accessibility bounds are current. Any offset (a
     * chrome not at the window's origin) is applied to every box from then on.
     */
    private fun calibrate() {
        if (calibrated) return
        val fromDom = domRect("[aria-label=\"Spaces\"]") ?: return
        val fromTree = waitFor("Spaces", 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding("coordinates: Spaces button at $fromDom from the DOM, $fromTree from the accessibility tree (offset ${dx.roundToInt()}, ${dy.roundToInt()})")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
        calibrated = true
    }

    // --- the core's state ------------------------------------------------------------------------

    private fun tabExists(tabId: String, state: JSONObject = coreState()): Boolean = state.getJSONObject("tabs").has(tabId)

    private fun awaitTab(tabId: String, exists: Boolean, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (tabExists(tabId) == exists) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(200)
        }
    }

    /** Wait for the active space to hold `count` unpinned, non-Essential tabs. */
    private fun awaitUnpinned(count: Int, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (trackOrder().size == count) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(250)
        }
    }

    private fun awaitSetting(name: String, value: Boolean, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val settings = coreState().optJSONObject("settings")
            if (settings != null && settings.optBoolean(name, !value) == value) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(250)
        }
    }

    /** The folder a tab is in per the core, null when loose (or gone). */
    private fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    private fun activeSpace(state: JSONObject): JSONObject {
        val spaces = state.getJSONArray("spaces")
        val activeId = state.optString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") == activeId) return space
        }
        return spaces.getJSONObject(0)
    }

    /** The active space's regular tabs in track order, as (id, folderId) pairs. */
    private fun trackOrder(state: JSONObject = coreState()): List<Pair<String, String?>> {
        val tabs = state.getJSONObject("tabs")
        val ids = activeSpace(state).getJSONArray("tabIds")
        val order = ArrayList<Pair<String, String?>>()
        for (i in 0 until ids.length()) {
            val id = ids.getString(i)
            val tab = tabs.optJSONObject(id) ?: continue
            if (tab.optBoolean("pinned") || tab.optBoolean("essential")) continue
            order += id to folderOf(id, state)
        }
        return order
    }

    private fun describeSpace(): String {
        val state = coreState()
        val tabs = state.getJSONObject("tabs")
        val folders = state.getJSONObject("folders")
        val title = { id: String -> tabs.optJSONObject(id)?.optString("title") ?: id }
        val order = trackOrder(state)
        val groups = order.mapNotNull { it.second }.distinct().joinToString("; ") { folderId ->
            val name = folders.optJSONObject(folderId)?.optString("name") ?: folderId
            "group $name [${order.filter { it.second == folderId }.joinToString(", ") { title(it.first) }}]"
        }
        val loose = order.filter { it.second == null }.joinToString(", ") { title(it.first) }
        return "${if (groups.isEmpty()) "no groups" else groups}; loose [$loose]; confirmCloseAll ${state.optJSONObject("settings")?.opt("confirmCloseAll")}"
    }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) = record("  $label", ok)

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `tab-close-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        /** How long a release, a close or a restore has to finish its motion before the state is read. */
        private const val SETTLE = 2_500L
        /** How long an element may take to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 8_000L
        /** Two reads of a box this far apart agreeing count as at rest ([steadyRect]). */
        private const val STEADY_MS = 350L
        /** Largest DOM-to-screen offset (px) [calibrate] takes for real rather than for a stale tree. */
        private const val MAX_OFFSET = 200f
        /** Taps on the Tabs button [openOverview] tries before giving up (each may be read as a hold). */
        private const val OPEN_ATTEMPTS = 4
        private const val CHECKBOX = ".zen-frame-dialogs input.zen-v2-checkbox"
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        // The seeded profile's ids.
        private const val TEA = "tab_tea"
        private const val DAMPING = "tab_damping"
        private const val HN = "tab_hn"
        private const val MAIL = "tab_mail"
        private const val CAL = "tab_cal"
        private const val GH = "tab_gh"
        private const val RESEARCH = "folder_research"
    }
}
