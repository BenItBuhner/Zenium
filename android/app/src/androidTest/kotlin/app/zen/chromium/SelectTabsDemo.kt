package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records the phone overview's select-tabs mode (matrix TAB-08, TAB-35, SH-12; v2 §9.6, §9.29,
 * §9.30, §9.33, §11.4), every press a real touch and every outcome read off the chrome's DOM or
 * the core's state, never off the chrome's word alone:
 *
 *  1. entered from the header menu's Select Tabs: the cards are checkboxes, the header row is
 *     REPLACED by the ×, "Select tabs" and Select all (one header row in the DOM), the action
 *     strip stands with every action off; TalkBack sees the cards checkable and the actions named;
 *  2. a touch on a card picks it and again unpicks it, the count following; Select all picks
 *     every card and reads Deselect all, measured with the renderer's trace
 *     (`select-all-overview`), and no card moves for it (§11.4: no reflow on a pick);
 *  3. the × ends the mode: the header row is the overview's again, the cards are buttons;
 *  4. entered from a card's hold sheet: the mode opens with that card picked;
 *  5. Close on two picks: both cards depart, the tabs go, one "2 tabs closed" toast, Undo
 *     brings both back at their indexes;
 *  6. Group on two loose picks: the picker sheet ("New group" first, then Research with its
 *     count), New group makes a group of the two (named on the inline field); then a third
 *     pick into Research through the picker's existing-group row;
 *  7. Bookmark on every card: one folder "Tabs from <date>" under Mobile bookmarks holds the
 *     pages, and the toast offers Open;
 *  8. Share on two picks: the system's share sheet comes up (another package's window);
 *  9. the system back ends the mode.
 *
 * Positions come from the chrome's DOM (`getBoundingClientRect`, checked once against the
 * accessibility bounds of the overview's Spaces button), because the WebView's accessibility
 * tree trails the software-rendered emulator by seconds. Every touch is a down and an up a
 * frame apart and is checked for having taken ([touchUntil]; the emulator reads a tap as a hold
 * now and then under load). Findings go to `select-tabs-findings.txt` next to the stills (one
 * PASS or FAIL per claim, ALL CHECKS PASSED at the end); the run fails on any FAIL. Profile
 * `overview-demo-state.json`: the Work space with the group Research [World Wide Web, Damping]
 * and the loose tabs example.com (active), Hacker News, RFC 2324, Tea, Coffee, plus three
 * Essentials. Driven by `android-select-tabs-demo.yml`. See [DemoHarness] and [TabCloseDemo],
 * whose touch discipline this follows.
 */
@RunWith(AndroidJUnit4::class)
class SelectTabsDemo : DemoHarness("overview-demo-state.json", "select-tabs", "selecttabs-demo") {
    override val tag = "SelectTabsDemo"
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0

    @Test
    fun record() {
        runDemo()
        if (failures > 0) error("$failures check(s) failed; see select-tabs-findings.txt")
    }

    /** Visit the next tab and come back so the two front cards have thumbnails. */
    override fun warmUp() {
        findings = File(out, "select-tabs-findings.txt")
        findings.writeText(
            "Zenium Android select-tabs mode checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
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

        enterFromHeader()
        toggleAndSelectAll()
        doneByX()
        enterFromHold()
        closeWithUndo(start)
        groupNewAndExisting()
        bookmarkAll()
        share()
        backEndsTheMode()

        still("end")
        finding("\nend: ${describeSpace()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. The header menu's Select Tabs: the mode at none. */
    private fun enterFromHeader() {
        finding("\n1. Select Tabs from the header menu: the mode at none")
        enterByMenu()
        val mode = modeState()
        expect("the cards are checkboxes, none checked (${mode.cards} cards, ${mode.checked} checked)", mode.cards == CARDS && mode.checked == 0)
        expect("ONE header row, its content replaced: ${mode.header}", mode.headerRows == 1 && mode.header == listOf("Done", "Select all"))
        expect("the count reads 'Select tabs' as a live region: '${mode.title}'", mode.title == "Select tabs" && mode.live)
        expect("the space's name and count have left the header row", !mode.headerText.contains("Work") && !mode.headerText.contains("tabs"))
        expect("the strip stands with Close, Group, Bookmark, Share, every one off: ${mode.actions}", mode.actions == listOf("close" to true, "group" to true, "bookmark" to true, "share" to true))
        expect("no card draws a close while the mode is on", !inDom(".zen-overview-card-close"))
        expect("the New Tab card takes no pick", awaitDom("document.querySelector('[data-testid=\"overview-new-tab\"]').disabled"))
        still("mode-none")
        // TalkBack's view: a card is a checkable node named as the card is; the strip's buttons named.
        val tea = awaitCheckableNode("Tea")
        expect("TalkBack sees Tea's card as a checkable node, not checked", tea != null && !tea.isChecked)
        expect("TalkBack sees the strip's Close named with its count", findByLabel("Close 0 tabs") != null || awaitNode(4_000) { it == "Close 0 tabs" } != null)
    }

    /** 2. A touch picks and unpicks; Select all, traced; nothing moves for it. */
    private fun toggleAndSelectAll() {
        finding("\n2. Toggle by touch, then Select all (traced: select-all-overview)")
        touchCard(TEA, "Tea's card") { isChecked(TEA) }
        touchCard(COFFEE, "Coffee's card") { isChecked(COFFEE) }
        var mode = modeState()
        expect("two picks: '${mode.title}', ${mode.checked} checked", mode.title == "2 selected" && mode.checked == 2)
        expect("the picked cards carry the selected mark", awaitDom("document.querySelectorAll('.zen-overview-card[data-selected]').length===2"))
        expect("the strip's actions are on and counted: ${mode.actions} / ${mode.names}", mode.actions.all { !it.second } && mode.names.contains("Close 2 tabs"))
        val teaNode = awaitCheckableNode("Tea", checked = true)
        expect("TalkBack hears Tea's card checked", teaNode != null && teaNode.isChecked)
        still("two-picked")
        touchCard(TEA, "Tea's card again") { !isChecked(TEA) }
        mode = modeState()
        expect("Tea unpicked: '${mode.title}'", mode.title == "1 selected" && mode.checked == 1)

        // Select all: the one bulk action, traced. The cards' boxes before and after say
        // whether anything moved for the picks (§11.4: nothing reflows on a pick).
        val before = cardBoxes()
        val selectAll = steadyRect({ domRect(SELECT_ALL) }) ?: error("Select all is not in the header")
        expect("Select all reads 'Select all' before the touch", textOf(SELECT_ALL) == "Select all")
        traceFrames("select-all-overview", JankBudget.Kind.GESTURE) {
            touch(selectAll, "Select all")
            SystemClock.sleep(SELECT_ALL_SETTLE)
        }
        val took = awaitUntil(TOUCH_TOOK_WAIT) { modeState().checked == CARDS }
        if (!took) {
            finding("  (the touch on Select all did not take: touching again, unmeasured)")
            touchUntil("Select all", { steadyRect({ domRect(SELECT_ALL) }) }, { modeState().checked == CARDS })
        }
        mode = modeState()
        expect("every card is picked: '${mode.title}', ${mode.checked} of ${mode.cards}", mode.checked == CARDS && mode.title == "$CARDS selected")
        expect("the button reads 'Deselect all'", textOf(SELECT_ALL) == "Deselect all")
        val after = cardBoxes()
        expect("no card moved for the picks (${moved(before, after)} moved)", moved(before, after) == 0)
        still("all-picked")
        touchUntil("Deselect all", { steadyRect({ domRect(SELECT_ALL) }) }, { modeState().checked == 0 })
        mode = modeState()
        expect("Deselect all keeps the mode up at none: '${mode.title}'", mode.on && mode.checked == 0 && mode.title == "Select tabs")
    }

    /** 3. The × (Done): the mode ends, the header row is the overview's. */
    private fun doneByX() {
        finding("\n3. The header's × ends the mode")
        touchUntil("the header's ×", { steadyRect({ domRect(DONE) }) }, { !modeState().on })
        val mode = modeState()
        expect("the mode is off: the cards are buttons again", !mode.on && mode.cards == 0)
        expect("the header row is the overview's: ${mode.header}", mode.header == listOf("Spaces", "More"))
        expect("the strip has left", awaitDom("!document.querySelector('[data-testid=\"overview-actions\"]')", 4_000))
        expect("the cards draw their close again", inDom(".zen-overview-card-close"))
        still("done")
    }

    /** 4. A card's hold sheet leads with Select Tabs: the mode opens with that card picked. */
    private fun enterFromHold() {
        finding("\n4. Select Tabs from a card's hold sheet: the mode with that card picked")
        val coffee = show(card(COFFEE))
        val f = Finger()
        f.down(coffee.exactCenterX(), coffee.exactCenterY())
        f.hold(HOLD_MS)
        f.up()
        val sheet = awaitUntil(SHEET_WAIT) { menuRow("Select Tabs") != null }
        expect("the hold sheet is up with Select Tabs as its first row", sheet && firstSheetRow() == "Select Tabs")
        still("hold-sheet")
        touchUntil("'Select Tabs' on the hold sheet", { steadyRect { menuRow("Select Tabs") } }, { modeState().on }, waitMs = SHEET_WAIT)
        val mode = modeState()
        expect("the mode is on with Coffee picked: '${mode.title}'", mode.on && mode.title == "1 selected" && isChecked(COFFEE))
        still("entered-by-hold")
    }

    /** 5. Close on Coffee and Tea: the two depart, one toast, Undo. */
    private fun closeWithUndo(start: List<Pair<String, String?>>) {
        finding("\n5. Close on two picks, one toast, Undo")
        touchCard(TEA, "Tea's card") { isChecked(TEA) }
        expect("two picks: '${modeState().title}'", modeState().title == "2 selected")
        touchUntil("Close in the strip", { steadyRect({ domRect(action("close")) }) }, { !modeState().on })
        expect("the mode ends with the action", !modeState().on)
        expect("both tabs are closed at once", awaitTab(COFFEE, exists = false) && awaitTab(TEA, exists = false))
        val toast = awaitToast("2 tabs closed")
        expect("one toast reads '2 tabs closed' with Undo: '${toast.orEmpty()}'", toast != null && undoRect() != null)
        expect("both cards have left the grid", awaitDom("!document.querySelector('${card(COFFEE)}') && !document.querySelector('${card(TEA)}')"))
        still("closed-toast")
        undo("Undo")
        expect("Undo brings both back", awaitTab(COFFEE, exists = true, timeoutMs = RESTORE_WAIT) && awaitTab(TEA, exists = true, timeoutMs = RESTORE_WAIT))
        SystemClock.sleep(SETTLE)
        expect("they are back at their indexes", trackOrder() == start)
        still("undo")
        restoreForNextScenario(start)
        awaitToastGone()
    }

    /** 6. Group: New group on two loose picks, then a third into Research. */
    private fun groupNewAndExisting() {
        finding("\n6. Group: New group on Hacker News and RFC 2324, then Coffee into Research")
        enterByMenu()
        touchCard(HN, "Hacker News' card") { isChecked(HN) }
        touchCard(RFC, "RFC 2324's card") { isChecked(RFC) }
        touchUntil("Group in the strip", { steadyRect({ domRect(action("group")) }) }, { menuRow("New group") != null }, waitMs = SHEET_WAIT)
        expect("the picker is titled 'Group 2 tabs': '${sheetTitle()}'", sheetTitle() == "Group 2 tabs")
        expect("its rows are 'New group' (sentence case, §9.1) then Research with its count: ${sheetRows()}", sheetRows() == listOf("New group", "Add to Research (2)"))
        still("picker")
        touchUntil("'New group' in the picker", { steadyRect { menuRow("New group") } }, { folderOf(HN) != null && folderOf(HN) != RESEARCH }, waitMs = SHEET_WAIT)
        val group = folderOf(HN)
        expect("a new group holds Hacker News and RFC 2324 (${group ?: "none"})", group != null && group != RESEARCH && folderOf(RFC) == group)
        expect("the mode ended with the action", !modeState().on)
        // The new group's name is on its inline field (the core's `folder.edit`): name it.
        if (awaitDom("!!document.querySelector('.zen-group input')", 4_000)) {
            instrumentation.sendStringSync("News")
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_ENTER)
            SystemClock.sleep(SETTLE)
            expect("the group is named News", group != null && folderName(group) == "News")
        } else {
            finding("  (no inline rename field showed for the new group)")
        }
        still("grouped-new")

        enterByMenu()
        touchCard(COFFEE, "Coffee's card") { isChecked(COFFEE) }
        touchUntil("Group in the strip", { steadyRect({ domRect(action("group")) }) }, { menuRow("New group") != null }, waitMs = SHEET_WAIT)
        expect("the picker lists Research and the new group: ${sheetRows()}", sheetRows().any { it.startsWith("Add to Research") } && sheetRows().size == 3)
        touchUntil("'Add to Research' in the picker", { steadyRect { menuRow("Add to Research") } }, { folderOf(COFFEE) == RESEARCH }, waitMs = SHEET_WAIT)
        expect("Coffee is in Research", folderOf(COFFEE) == RESEARCH)
        SystemClock.sleep(SETTLE)
        still("grouped-existing")
    }

    /** 7. Bookmark on every card: one dated folder under Mobile bookmarks, the toast with Open. */
    private fun bookmarkAll() {
        finding("\n7. Bookmark on every card: the dated folder, the toast with Open")
        enterByMenu()
        touchUntil("Select all", { steadyRect({ domRect(SELECT_ALL) }) }, { modeState().checked == CARDS })
        val picked = modeState().checked
        touchUntil("Bookmark in the strip", { steadyRect({ domRect(action("bookmark")) }) }, { !modeState().on })
        val toast = awaitToast("Bookmarked ")
        expect("the toast reads 'Bookmarked $picked tabs in “Tabs from <date>”' with Open: '${toast.orEmpty()}'",
            toast != null && toast.startsWith("Bookmarked $picked tabs in “Tabs from ") && textOf(".zen-message-toast .zen-message-button") == "Open")
        val folder = awaitBookmarkFolder()
        expect("the core holds one folder 'Tabs from <date>' under Mobile bookmarks: '${folder?.optString("title")}'", folder != null && folder.optString("parentId") == MOBILE_BOOKMARKS)
        val children = folder?.let { bookmarkChildren(it.getString("id")) } ?: emptyList()
        expect("it holds the $picked pages, in the grid's order: ${children.map { it.optString("title") }}", children.size == picked && children.all { it.optString("type") == "bookmark" })
        still("bookmarked-toast")
        // Open: the overview leaves and the Bookmarks panel opens at the folder.
        val opened = touchUntil("the toast's Open", { undoRect() }, { !inDom(".zen-overview") }, waitMs = SHEET_WAIT)
        expect("Open leaves the overview", opened)
        expect(
            "and shows the folder in the Bookmarks panel",
            awaitDom("(function(){var p=document.querySelector('.zen-panel');return !!p&&p.textContent.indexOf('Tabs from ')>=0&&!document.querySelector('.zen-overview')})()", 8_000)
        )
        SystemClock.sleep(SETTLE)
        still("bookmarks-panel")
        // The panel's back climbs out of the folder first, then closes the panel.
        for (i in 0 until 3) {
            if (!inDom(".zen-panel")) break
            back()
            awaitDom("!document.querySelector('.zen-panel')", 3_000)
        }
        expect("the Bookmarks panel is closed again", !inDom(".zen-panel"))
        SystemClock.sleep(1_500)
        awaitToastGone()
        openOverview()
    }

    /** 8. Share on two picks: the system's share sheet. */
    private fun share() {
        finding("\n8. Share on two picks: the system share sheet")
        enterByMenu()
        touchCard(EXAMPLE, "example.com's card") { isChecked(EXAMPLE) }
        touchCard(HN, "Hacker News' card") { isChecked(HN) }
        touchUntil("Share in the strip", { steadyRect({ domRect(action("share")) }) }, { !modeState().on })
        val shared = awaitSystemWindow(12_000)
        expect("Share brings the system share sheet (another package's window)", shared)
        if (shared) {
            SystemClock.sleep(3_000)
            still("share-sheet")
            back()
            SystemClock.sleep(1_500)
            ensureForeground()
        }
        expect("the mode ended with the action", !modeState().on)
        SystemClock.sleep(SETTLE)
        if (!overviewOpen()) openOverview()
    }

    /** 9. The system back ends the mode and leaves the overview up. */
    private fun backEndsTheMode() {
        finding("\n9. The system back ends the mode")
        enterByMenu()
        touchCard(TEA, "Tea's card") { isChecked(TEA) }
        expect("the mode is on with a pick", modeState().on)
        back()
        expect("back ends the mode", awaitUntil(SHEET_WAIT) { !modeState().on })
        expect("and the overview stays up", overviewOpen() || inDom(".zen-overview"))
        still("back")
    }

    // --- moves -----------------------------------------------------------------------------------

    /** Open the header's menu and touch Select Tabs until the mode is on. */
    private fun enterByMenu() {
        if (modeState().on) return
        openMenu()
        touchUntil("'Select Tabs' in the menu", { steadyRect { menuRow("Select Tabs") } }, { modeState().on }, waitMs = SHEET_WAIT)
        if (!modeState().on) error("the select-tabs mode never came on from the menu")
    }

    /** A touch on the card `tabId` (scrolled into the grid's viewport first) until `took`. */
    private fun touchCard(tabId: String, what: String, took: () -> Boolean) {
        touchUntil(what, { show(card(tabId)); domRect(card(tabId)) }, took)
    }

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up
     * [TAP_HOLD_MS] apart (a frame, so the two queue together under load and the WebView's
     * gesture detector never reads a long task between them as a long press).
     */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /**
     * A touch that has to take: touch `what` where `read` finds it, watch `took` for `waitMs`,
     * and when nothing came of it read the box again (it may have moved) and touch again, up to
     * `attempts` times. Whether it took in the end.
     */
    private fun touchUntil(
        what: String,
        read: () -> Rect?,
        took: () -> Boolean,
        attempts: Int = TOUCH_ATTEMPTS,
        waitMs: Long = TOUCH_TOOK_WAIT
    ): Boolean {
        for (attempt in 1..attempts) {
            val box = read() ?: run {
                finding("  ($what is not there to touch)")
                return took()
            }
            if (touchPoint(box) == null) {
                finding("  ($what is off the screen at $box, attempt $attempt)")
                SystemClock.sleep(STEADY_MS)
                continue
            }
            touch(box, what)
            if (awaitUntil(waitMs, took)) return true
            if (attempt < attempts) finding("  (the touch on $what did not take, attempt $attempt: touching again)")
        }
        return took()
    }

    /** Touch the toast's action once the toast is at rest; a picked action sends the toast off at once. */
    private fun undo(label: String): Boolean {
        if (awaitRect({ undoRect() }, 6_000) == null) {
            record("  the toast's $label button never showed", false)
            return false
        }
        awaitDom("(function(){var e=document.querySelector('.zen-message-toast');return !!e&&!e.hasAttribute('data-moving')})()", 1_500)
        val took = touchUntil("the toast's $label", { undoRect() }, { toastLeavingOrGone() }, waitMs = UNDO_TOOK_WAIT)
        if (!took) record("  the touch on the toast's $label never took", false)
        return took
    }

    /** Touch More in the overview header until the menu sheet's rows are there. */
    private fun openMenu() {
        if (menuRow("") != null) {
            back()
            awaitUntil(SHEET_WAIT) { menuRow("") == null }
            SystemClock.sleep(500)
        }
        val opened = touchUntil("More in the overview header", { domRect("[aria-label=\"More\"]") }, { menuRow("") != null }, waitMs = SHEET_WAIT)
        if (!opened) error("the overview's menu never opened")
    }

    /** A row of the sheet that is up by the start of its label. */
    private fun menuRow(row: String): Rect? = textRect(".zen-sheet-item", row)

    private fun firstSheetRow(): String? = sheetRows().firstOrNull()

    private fun sheetRows(): List<String> {
        val raw = jsString("(function(){return JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(n){return n.textContent.trim()}))})()")
        if (raw.isEmpty()) return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { arr.getString(it) }
    }

    private fun sheetTitle(): String = textOf(".zen-sheet .zen-sheet-title")

    /** A box read from the DOM once two reads [STEADY_MS] apart agree; the last read when they never do. */
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

    /** Open the overview with a touch on the bar's Tabs button; a touch read as a hold is dismissed and tried again. */
    private fun openOverview() {
        for (attempt in 0 until OPEN_ATTEMPTS) {
            val close = closeUrlField()
            if (!close.ok) finding("  (attempt ${attempt + 1}: ${close.describe()})")
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
    private fun action(id: String) = "[data-testid=\"overview-action-$id\"]"

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

    /** The on-screen box of the first element `selector` matches, null when nothing does; scrolled into the grid's viewport first when asked. */
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

    private fun textOf(selector: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.textContent.trim():''})()")

    /** The toast's action button (`Undo`, `Open`), when a toast is up. */
    private fun undoRect(): Rect? = domRect(".zen-message-toast .zen-message-button")

    private fun toastLeavingOrGone(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-message-toast');return !e||e.hasAttribute('data-moving')?'yes':''})()") == "yes"

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    /** Whether the card `tabId` is a checked checkbox right now. */
    private fun isChecked(tabId: String): Boolean =
        jsString("(function(){var e=document.querySelector('${card(tabId)} > [role=\"checkbox\"]');return e&&e.getAttribute('aria-checked')==='true'?'yes':''})()") == "yes"

    /** The box of `selector`, waiting for it to be in the DOM. */
    private fun box(selector: String): Rect =
        awaitRect({ domRect(selector) }, LOOKUP_WAIT) ?: error("nothing matches $selector")

    /** Like [box], after scrolling the element fully into the grid's viewport when it is not. */
    private fun show(selector: String): Rect {
        val before = box(selector)
        val after = domRect(selector, scrollIntoView = true) ?: before
        if (after != before) SystemClock.sleep(1_200)
        return domRect(selector) ?: after
    }

    /** Every card's box by its tab id, for the no-reflow check. */
    private fun cardBoxes(): Map<String, Rect> {
        val raw = jsString(
            "(function(){var d=window.devicePixelRatio;return JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-overview-grid [data-tab-id]')," +
                "function(e){var r=e.getBoundingClientRect();return {id:e.getAttribute('data-tab-id'),l:r.left,t:r.top,r:r.right,b:r.bottom,d:d}}))})()"
        )
        if (raw.isEmpty()) return emptyMap()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { arr.getJSONObject(it) }.associate { it.getString("id") to rectFrom(it.toString())!! }
    }

    /** How many cards of `before` stand elsewhere in `after` (a pixel of tolerance for rounding). */
    private fun moved(before: Map<String, Rect>, after: Map<String, Rect>): Int =
        before.count { (id, b) -> after[id]?.let { a -> abs(a.left - b.left) > 1 || abs(a.top - b.top) > 1 } ?: false }

    /** One read of the mode: on or off, the header's rows and controls, the count, the cards, the strip. */
    private class ModeState(
        val on: Boolean,
        val headerRows: Int,
        val header: List<String>,
        val headerText: String,
        val title: String,
        val live: Boolean,
        val cards: Int,
        val checked: Int,
        /** The strip's actions as (id, disabled). */
        val actions: List<Pair<String, Boolean>>,
        val names: List<String>
    )

    private fun modeState(): ModeState {
        val raw = jsString(
            "(function(){var hs=Array.prototype.filter.call(document.querySelectorAll('.zen-overview header'),function(h){return !h.classList.contains('zen-overview-card-header')});" +
                "var h=hs[0];var bs=h?Array.prototype.map.call(h.querySelectorAll('button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()}):[];" +
                "var t=document.querySelector('[data-testid=\"overview-selected-count\"]');" +
                "var cards=document.querySelectorAll('.zen-overview-grid [data-cell] > [role=\"checkbox\"]');" +
                "var checked=document.querySelectorAll('.zen-overview-grid [data-cell] > [role=\"checkbox\"][aria-checked=\"true\"]');" +
                "var acts=Array.prototype.map.call(document.querySelectorAll('.zen-overview-action'),function(b){return [b.getAttribute('data-testid').replace('overview-action-',''),b.disabled,b.getAttribute('aria-label')]});" +
                "return JSON.stringify({on:!!t,rows:hs.length,header:bs,text:h?h.textContent:'',title:t?t.textContent.trim():'',live:!!t&&t.getAttribute('aria-live')==='polite',cards:cards.length,checked:checked.length,acts:acts})})()"
        )
        if (raw.isEmpty()) return ModeState(false, 0, emptyList(), "", "", false, 0, 0, emptyList(), emptyList())
        val o = JSONObject(raw)
        val header = o.getJSONArray("header").let { a -> (0 until a.length()).map { a.getString(it) } }
        val acts = o.getJSONArray("acts").let { a -> (0 until a.length()).map { a.getJSONArray(it) } }
        return ModeState(
            o.getBoolean("on"),
            o.getInt("rows"),
            header,
            o.optString("text"),
            o.optString("title"),
            o.getBoolean("live"),
            o.getInt("cards"),
            o.getInt("checked"),
            acts.map { it.getString(0) to it.getBoolean(1) },
            acts.map { it.getString(2) }
        )
    }

    /** A checkable node of the accessibility tree whose name starts with `name`, in `checked` state when given. */
    private fun awaitCheckableNode(name: String, checked: Boolean? = null, timeoutMs: Long = 8_000): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val node = findNodeWhere { n ->
                val label = (n.contentDescription ?: n.text)?.toString().orEmpty()
                n.isCheckable && label.startsWith(name) && (checked == null || n.isChecked == checked)
            }
            if (node != null) return node
            SystemClock.sleep(300)
        }
        return null
    }

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

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

    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /** Check the DOM's coordinates against the accessibility tree once (the Spaces button never moves). */
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

    private fun awaitTab(tabId: String, exists: Boolean, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { tabExists(tabId) == exists }

    /** The folder a tab is in per the core, null when loose (or gone). */
    private fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    private fun folderName(folderId: String, state: JSONObject = coreState()): String? =
        state.getJSONObject("folders").optJSONObject(folderId)?.optString("name")

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

    /** When a scenario's Undo did not bring the tabs back, put them back through the core so the next one still runs. */
    private fun restoreForNextScenario(start: List<Pair<String, String?>>) {
        if (trackOrder() == start) return
        val closed = JSONArray(coreInvoke("session.recentlyClosed"))
        val ids = (0 until closed.length()).map { closed.getJSONObject(it) }
            .filter { it.optString("kind") == "tab" }
            .map { it.getString("id") }
        finding("  (the tabs did not come back: ${ids.size} put back through the core for the next scenario)")
        for (id in ids) coreInvoke("session.restoreClosed", JSONObject().put("id", id).toString())
        awaitUntil(RESTORE_WAIT) { trackOrder().size == start.size }
        SystemClock.sleep(SETTLE)
    }

    /** The bookmarks folder Bookmark all made ("Tabs from …" under Mobile bookmarks), once the core has it. */
    private fun awaitBookmarkFolder(timeoutMs: Long = 8_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val nodes = coreState().optJSONArray("bookmarks") ?: JSONArray()
            for (i in 0 until nodes.length()) {
                val node = nodes.getJSONObject(i)
                if (node.optString("type") == "folder" && node.optString("title").startsWith("Tabs from ")) return node
            }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun bookmarkChildren(folderId: String): List<JSONObject> {
        val nodes = coreState().optJSONArray("bookmarks") ?: JSONArray()
        return (0 until nodes.length()).map { nodes.getJSONObject(it) }.filter { it.optString("parentId") == folderId }.sortedBy { it.optInt("index") }
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
        return "${if (groups.isEmpty()) "no groups" else groups}; loose [$loose]"
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

    /** Numbered stills: `select-tabs-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        /** The regular cards of the seeded space's Work pane: two in Research and five loose. */
        private const val CARDS = 7
        private const val SETTLE = 2_500L
        private const val LOOKUP_WAIT = 8_000L
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L
        private const val MAX_OFFSET = 200f
        private const val OPEN_ATTEMPTS = 4
        private const val TOUCH_ATTEMPTS = 4
        private const val TAP_HOLD_MS = 16L
        private const val TOUCH_TOOK_WAIT = 900L
        private const val UNDO_TOOK_WAIT = 650L
        private const val SHEET_WAIT = 5_000L
        /** A card's hold: past the lift's long press (400 ms) with room for the emulator's lag. */
        private const val HOLD_MS = 700L
        /** Select all's picks settle within this (the checks' 120 ms fills, the header's text). */
        private const val SELECT_ALL_SETTLE = 1_200L
        /** Two pages coming back on a software-rendered emulator. */
        private const val RESTORE_WAIT = 20_000L
        private const val SELECT_ALL = "[data-testid=\"overview-select-all\"]"
        private const val DONE = "[data-testid=\"overview-select-done\"]"
        private const val MOBILE_BOOKMARKS = "3"
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        // The seeded profile's ids.
        private const val EXAMPLE = "tab_example"
        private const val HN = "tab_hn"
        private const val RFC = "tab_rfc"
        private const val TEA = "tab_tea"
        private const val COFFEE = "tab_coffee"
        private const val RESEARCH = "folder_research"
    }
}
