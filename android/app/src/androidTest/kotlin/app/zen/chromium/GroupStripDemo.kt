package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.widget.FrameLayout
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
 * Records the tab group strip (TAB-14, the strip half of MOT-13) and writes what it measured to
 * `group-strip-findings.txt` next to the screenshots (one `PASS` or `FAIL` per check; a real touch
 * on a chip whose claim does not hold is a touch fault, and the run fails on it at the end):
 *
 *  1. no group: the bar band is the row alone (`--zen-group-strip` 0, the page's box read from
 *     the host);
 *  2. a group made in the overview by dropping Alpha on Beta (a finger, as in the motion demo);
 *  3. Alpha's card tapped: the overview closes into Alpha and the strip slides out of the bar's
 *     row on its spring (frames), the band opens in one step, the chips carry their labels in
 *     the accessibility tree, the page's box shrinks by the strip's height;
 *  4. a finger on Beta's chip: Beta is the active tab and wears the mark;
 *  5. a finger on the plus chip: a new tab in the group after its last member, its chip scaling
 *     in at the end, the chips before it and the plus chip (pinned at the tray's end) still
 *     (frames); then a tab made after Beta off camera (the core's `tab.create`): its chip scales
 *     in at its slot while the chips after it glide over by the slot pitch (frames);
 *  6. a finger on the show-group chip: the overview opens with the group's card in view and the
 *     chip pressed;
 *  7. Beta's card closed with its X, the strip in view under the grid: Beta's chip shrinks out
 *     where it stood while the chips after it glide back (frames);
 *  8. Alpha's card tapped: the overview closes into Alpha, the strip keeps its members;
 *  9. the pill's swipe, untouched by the strip: next tab twice – the mark moves to the new tab,
 *     then Home, loose, is active and the strip slides back behind the row (frames), the band
 *     closes once it is out and the page's box is back;
 * 10. the bar docked at the top: previous tab brings the new tab back and the strip slides out
 *     below the row (frames), a finger on Alpha's chip there, and Alpha's page's box has moved
 *     down by the strip's height;
 * 11. seven more tabs in the group: the members overflow and scroll, the active chip kept in view
 *     as the active tab moves along the group, and a finger on a chip of the scrolled strip;
 * 12. the dark scheme.
 *
 * The frames come from a `requestAnimationFrame` loop in the chrome logging where the tray, every
 * member chip's cell and face, every exit chip and the plus chip are drawn (`getBoundingClientRect`,
 * transforms included) and the band's custom property; the driver reads the log back and checks
 * the order of events. Where the chips are is read from the DOM too, not the accessibility tree
 * (which trails the grid by seconds on the API 34 emulator); DOM boxes are CSS px, scaled by the
 * device pixel ratio and checked once against the accessibility bounds of the overview's Spaces
 * button. The pages come from a loopback server in this process ([DemoServer]); the profile
 * (`group-strip-demo-state.json`) is one space of five loose tabs, Home active. Driven by the
 * `android-group-strip-demo` workflow. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class GroupStripDemo : DemoHarness("group-strip-demo-state.json", "group-strip", "group-strip-demo") {
    override val tag = "GroupStripDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    /** The group made in step 2, and the tab the plus chip opened in step 5. */
    private var groupId: String? = null
    private var newTab: String? = null
    /** The active page's box (host px) with no strip, at the bottom dock and at the top. */
    private var pageWithoutStrip: Rect? = null
    private var pageTopWithoutStrip: Rect? = null

    @Test
    fun record() {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        routes["/"] = DemoServer.page("Home", "<p>The active tab, loose.</p>")
        routes["/alpha.html"] = DemoServer.page("Alpha", "<p>Alpha, to be grouped with Beta.</p>")
        routes["/beta.html"] = DemoServer.page("Beta", "<p>Beta, to be grouped with Alpha.</p>")
        routes["/gamma.html"] = DemoServer.page("Gamma", "<p>Gamma, loose.</p>")
        routes["/delta.html"] = DemoServer.page("Delta", "<p>Delta, loose.</p>")
        routes["/middle.html"] = DemoServer.page("Middle", "<p>Made after Beta: a chip joining in the middle.</p>")
        for (i in 1..MORE_TABS) routes["/more$i.html"] = DemoServer.page("More $i", "<p>Member $i of the long group.</p>")
        server = DemoServer(PORT, routes).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** Visit Alpha and come back, so the two cards the group is made of have thumbnails. */
    override fun warmUp() {
        findings = File(out, "group-strip-findings.txt")
        findings.writeText(
            "Zenium Android tab group strip checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        finding("start: ${describeTabs()}")
    }

    override fun demo() {
        noStrip()
        makeGroupInOverview()
        enterFromOverview()
        tapMember()
        addWithPlus()
        showGroup()
        removeInOverview()
        closeIntoAlpha()
        swipeAlong()
        topDock()
        overflow()
        dark()

        still("end")
        finding("\nend: ${describeTabs()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** Home, loose, is active: no strip, the band is the row, the page's box is the reference. */
    private fun noStrip() {
        finding("\n1. No group: no strip")
        still("no-strip")
        val row = snapshot()
        record("  no strip in the DOM, the band's share `${row.band}`", row.strip == null && row.band == "0px")
        pageWithoutStrip = pageBox(HOME)
        finding("  the page's box without a strip: $pageWithoutStrip (host px)")
        record("  the strip's chips are not in the accessibility tree", findNode { it.startsWith("Show group") } == null)
    }

    /** Alpha dropped on Beta in the overview: the group [Beta, Alpha], the dropped card behind its target. */
    private fun makeGroupInOverview() {
        finding("\n2. A group made in the overview: Alpha dropped on Beta")
        openOverview()
        still("overview")
        show(card(BETA))
        val beta = box(card(BETA))
        val alpha = box(card(ALPHA))
        val f = carry(alpha, PointF(beta.exactCenterX(), beta.exactCenterY()))
        f.hold(REST)
        still("drop-ring")
        f.up()
        SystemClock.sleep(SETTLE)
        still("group-made")
        groupId = folderOf(BETA)
        expect("Alpha and Beta are a group", groupId != null && folderOf(ALPHA) == groupId)
        expect("the group is Beta, Alpha", groupId?.let { groupOrder(it) } == listOf(BETA, ALPHA))
        record("  the strip is not in the DOM while Home, loose, is active", snapshot().strip == null)
    }

    /**
     * Alpha's card tapped: the overview closes into Alpha, and the active tab being grouped the
     * strip slides out of the bar's row (v2 §11: the spring; the band opens in one step as it
     * sets off). Its chips are §9.22 buttons: each labelled in the accessibility tree, the active
     * one marked. The page's box shrinks by the strip's height through the layout report.
     */
    private fun enterFromOverview() {
        finding("\n3. Alpha's card tapped: the overview closes into Alpha and the strip slides out")
        show(card(ALPHA))
        val alpha = box(card(ALPHA))
        sample()
        Finger().tap(alpha.exactCenterX(), alpha.exactCenterY())
        stillWhen("appear-mid") { midSlide(it, "entering") }
        awaitStrip("shown")
        still("strip-bottom")
        judgeSlide(frames(), entering = true, edge = "bottom")
        val row = snapshot()
        expect("Alpha is the active tab", activeCoreTab()?.optString("id") == ALPHA)
        record("  the strip is at the bottom edge, shown: ${row.describe()}", row.strip?.edge == "bottom" && row.strip?.phase == "shown")
        record("  the members are Beta, Alpha and Alpha wears the mark", row.memberIds() == listOf(BETA, ALPHA) && row.currentId() == ALPHA)
        record("  the band's share is 50px", row.band == "50px")
        val tray = domRect(TRAY)
        val bar = domRect(BAR_ROW)
        record("  the tray sits above the bar's row: tray $tray, row $bar", tray != null && bar != null && tray.bottom <= bar.top + 2)
        labels("Show group, Group", "Beta", "Alpha, current tab", "New tab in Group")
        val page = pageBox(ALPHA)
        val shrink = (GROUP_STRIP_HEIGHT * density).roundToInt()
        record(
            "  the page's box followed: $page, bottom up by ${(pageWithoutStrip?.bottom ?: 0) - (page?.bottom ?: 0)} px against $shrink",
            page != null && pageWithoutStrip != null && abs((pageWithoutStrip!!.bottom - page.bottom) - shrink) <= 3 && page.top == pageWithoutStrip!!.top
        )
    }

    /** A finger on Beta's chip: `tab.activate`, and the mark moves. */
    private fun tapMember() {
        finding("\n4. A finger on Beta's chip")
        touchChip(member(BETA), "Beta's chip", "Beta is the active tab and wears the mark") {
            activeCoreTab()?.optString("id") == BETA && snapshot().currentId() == BETA
        }
        settle()
        still("member-tapped")
        record("  Alpha's chip lost the mark", snapshot().currentId() == BETA)
    }

    /**
     * A finger on the plus chip: `tab.create` after the group's last member, so the new tab is
     * in the group and its chip appears at the end. MOT-13: the chip scales in at its slot from
     * its first frame; the chips before it and the plus chip (pinned at the tray's end) stand
     * still. Then a tab made after Beta off camera, so a chip joins in the middle: the chips
     * after it glide over by the slot pitch on the same spring.
     */
    private fun addWithPlus() {
        finding("\n5. A finger on the plus chip: a new tab in the group")
        val before = snapshot().memberIds()
        sample()
        val landed = touchChip(PLUS, "the plus chip", "a new tab in the group is active") {
            activeCoreTab()?.let { it.optString("id") !in before && folderOf(it.optString("id")) == groupId } == true
        }
        stillWhen("add-mid") { row -> midEntrance(row, before) }
        SystemClock.sleep(SETTLE)
        still("added")
        val fresh = activeCoreTab()?.optString("id")?.takeIf { it !in before && landed }
        newTab = fresh
        val row = snapshot()
        expect("the new tab is in the group after Alpha, the last member", fresh != null && groupId?.let { groupOrder(it) } == before + fresh)
        record("  the strip reads Beta, Alpha, the new tab, with the mark on the new tab", fresh != null && row.memberIds() == before + fresh && row.currentId() == fresh)
        if (fresh != null) judgeAdd(frames(), fresh, before = before, after = emptyList())

        finding("\n5b. A tab made after Beta off camera: a chip joins in the middle")
        val members = snapshot().memberIds()
        sample()
        val made = JSONTokener(coreInvoke("tab.create", "{\"url\":\"${server.origin}/middle.html\",\"active\":false,\"afterTabId\":\"$BETA\"}")).nextValue() as? String
        stillWhen("add-middle-mid") { r -> midEntrance(r, members) }
        SystemClock.sleep(SETTLE)
        still("added-middle")
        val now = snapshot()
        expect("the tab is in the group right after Beta", made != null && groupId?.let { groupOrder(it) } == listOf(BETA, made) + members.drop(1))
        record("  the strip reads the group in order, the mark still on the new tab", made != null && now.memberIds() == listOf(BETA, made) + members.drop(1) && now.currentId() == fresh)
        if (made != null) judgeAdd(frames(), made, before = listOf(BETA), after = members.drop(1))
    }

    /**
     * A chip that is not among `before` is on its way in: its face between 0.45 and 0.97 of a
     * full one (it sets off at 0.6; the moment is a handful of frames long and each poll of the
     * DOM is a round trip, so the window takes in nearly all of the growth).
     */
    private fun midEntrance(row: Row, before: List<String>): Boolean {
        val fresh = row.members.firstOrNull { it.id !in before } ?: return false
        val full = row.members.firstOrNull { it.id in before }?.faceWidth ?: GROUP_CHIP
        return fresh.faceWidth in (0.45f * full)..(0.97f * full)
    }

    /** The tray on its way in or out: in `phase`, and drawn clear of both its ends. */
    private fun midSlide(row: Row, phase: String): Boolean =
        row.strip?.let { s -> s.phase == phase && abs(s.y) in 3f..47f } == true

    /** A finger on the show-group chip: the overview opens with the group's card in view, the chip pressed. */
    private fun showGroup() {
        finding("\n6. A finger on the show-group chip")
        touchChip(SHOW, "the show-group chip", "the overview is open") { overviewOpen() }
        SystemClock.sleep(2_000)
        still("show-group")
        val grid = domRect(GRID)
        val group = domRect(GROUP)
        record(
            "  the group's card is in the grid's viewport: group $group, grid $grid",
            grid != null && group != null && group.top >= grid.top - 2 && group.bottom <= grid.bottom + 2
        )
        record("  the show-group chip is pressed", jsString("(function(){var e=document.querySelector('[data-strip-show]');return e?e.getAttribute('aria-pressed')||'':''})()") == "true")
        record("  the strip is still in the band under the grid", snapshot().strip?.phase == "shown")
    }

    /**
     * Beta's card closed with its X while the strip is in view under the grid: Beta's chip
     * shrinks out where it stood (an exit chip at its slot) while Alpha's, the new tab's and the
     * plus chip glide back by the slot pitch; the chips before it (none here) stand still.
     */
    private fun removeInOverview() {
        finding("\n7. Beta's card closed with its X: Beta's chip leaves the strip")
        show(card(BETA))
        val x = box(closeButton(BETA))
        val members = snapshot().memberIds()
        val after = members.dropWhile { it != BETA }.drop(1)
        sample()
        Finger().tap(x.exactCenterX(), x.exactCenterY())
        stillWhen("remove-mid") { r ->
            val exit = r.exits.firstOrNull { it.id == BETA } ?: return@stillWhen false
            exit.faceWidth in (0.4f * GROUP_CHIP)..(0.9f * GROUP_CHIP)
        }
        SystemClock.sleep(SETTLE)
        still("removed")
        expect("Beta is closed", !tabExists(BETA))
        val now = snapshot()
        record("  the strip reads the rest in order, the mark still on the new tab", now.memberIds() == members - BETA && now.currentId() == newTab)
        judgeRemove(frames(), BETA, after)
    }

    /** Alpha's card tapped: the overview closes into Alpha. */
    private fun closeIntoAlpha() {
        finding("\n8. Alpha's card tapped: the overview closes into Alpha")
        val members = snapshot().memberIds()
        show(card(ALPHA))
        val alpha = box(card(ALPHA))
        Finger().tap(alpha.exactCenterX(), alpha.exactCenterY())
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (overviewOpen() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        settle()
        still("after-remove")
        val row = snapshot()
        expect("Alpha is the active tab and the overview is closed", activeCoreTab()?.optString("id") == ALPHA && !overviewOpen())
        record("  the strip stayed (Alpha is in the group) with its members, the mark on Alpha", row.strip?.phase == "shown" && row.memberIds() == members && row.currentId() == ALPHA)
    }

    /**
     * The pill's swipe is the pill's still: next tab from Alpha is the new tab (grouped: the mark
     * moves), next again is Home, loose – the strip slides back behind the row on its spring and
     * the band closes once it is out; the page's box is back to what it was.
     */
    private fun swipeAlong() {
        finding("\n9. The pill's swipe: next tab twice, out of the group")
        flingLeft()
        settle()
        touchWithoutGesture(); settle()
        val row = snapshot()
        expect("the new tab is active after the swipe", activeCoreTab()?.optString("id") == newTab)
        record("  the strip stayed and the mark moved to the new tab", row.strip?.phase == "shown" && row.currentId() == newTab)
        still("swiped-within")
        sample()
        flingLeft()
        stillWhen("leave-mid") { midSlide(it, "leaving") }
        awaitStrip(null)
        settle()
        touchWithoutGesture(); settle()
        still("strip-gone")
        judgeSlide(frames(), entering = false, edge = "bottom")
        val now = snapshot()
        expect("Home, loose, is active", activeCoreTab()?.optString("id") == HOME)
        record("  the strip is gone and the band's share is `${now.band}`", now.strip == null && now.band == "0px")
        val page = pageBox(HOME)
        record("  the page's box is back: $page against $pageWithoutStrip", page != null && page == pageWithoutStrip)
    }

    /**
     * The bar docked at the top (Settings): previous tab from Home is the new tab, grouped, and
     * the strip slides out below the row. A finger on Alpha's chip there; then Alpha's page's box
     * has moved down by the strip's height (Alpha's, not the new tab's: a new tab's page is
     * drawn by the chrome and has no box of its own in the host).
     */
    private fun topDock() {
        finding("\n10. The bar docked at the top")
        coreInvoke("settings.update", "{\"phoneBarPosition\":\"top\"}")
        SystemClock.sleep(3_000)
        touchWithoutGesture(); settle()
        pageTopWithoutStrip = pageBox(HOME)
        finding("  the page's box at the top dock without a strip: $pageTopWithoutStrip")
        still("top-no-strip")
        sample()
        flingRightAt(pillBox())
        stillWhen("appear-mid-top") { midSlide(it, "entering") }
        awaitStrip("shown")
        settle()
        touchWithoutGestureAt(pillBox()); settle()
        still("strip-top")
        judgeSlide(frames(), entering = true, edge = "top")
        val row = snapshot()
        expect("the new tab is active", activeCoreTab()?.optString("id") == newTab)
        record("  the strip is at the top edge, shown: ${row.describe()}", row.strip?.edge == "top" && row.strip?.phase == "shown")
        val tray = domRect(TRAY)
        val bar = domRect(BAR_ROW)
        record("  the tray sits below the bar's row: tray $tray, row $bar", tray != null && bar != null && tray.top >= bar.bottom - 2)
        touchChip(member(ALPHA), "Alpha's chip at the top dock", "Alpha is the active tab and wears the mark") {
            activeCoreTab()?.optString("id") == ALPHA && snapshot().currentId() == ALPHA
        }
        settle()
        still("member-tapped-top")
        val page = pageBox(ALPHA)
        val shift = (GROUP_STRIP_HEIGHT * density).roundToInt()
        record(
            "  Alpha's page's box followed: $page, top down by ${(page?.top ?: 0) - (pageTopWithoutStrip?.top ?: 0)} px against $shift",
            page != null && pageTopWithoutStrip != null && abs((page.top - pageTopWithoutStrip!!.top) - shift) <= 3 && page.bottom == pageTopWithoutStrip!!.bottom
        )
    }

    /**
     * Seven more tabs in the group (off camera, the core's `tab.create` after the last member):
     * the members overflow the scroller, the active chip is kept in view as the active tab moves
     * along the group, and a finger on a chip of the scrolled strip activates its tab.
     */
    private fun overflow() {
        finding("\n11. Seven more tabs in the group: the members overflow and scroll")
        val base = groupId?.let { groupOrder(it).size } ?: 0
        var last = newTab ?: ALPHA
        val more = ArrayList<String>()
        for (i in 1..MORE_TABS) {
            val id = JSONTokener(coreInvoke("tab.create", "{\"url\":\"${server.origin}/more$i.html\",\"active\":false,\"afterTabId\":\"$last\"}")).nextValue() as? String
            if (id == null) {
                record("  tab $i could not be made", false)
                break
            }
            more += id
            last = id
            SystemClock.sleep(700)
        }
        SystemClock.sleep(SETTLE)
        still("overflow")
        var row = snapshot()
        expect("the group has ${base + MORE_TABS} members", groupId?.let { groupOrder(it).size } == base + MORE_TABS)
        record("  the members overflow the scroller: ${row.scroll?.describe()}", row.scroll?.let { it.width > it.client + 20 } == true)
        record("  Alpha, active, is in view: ${row.member(ALPHA)?.x} in ${row.scroll?.describe()}", inView(row, ALPHA))
        val end = more.lastOrNull()
        if (end != null) {
            coreInvoke("tab.activate", "{\"tabId\":\"$end\"}")
            SystemClock.sleep(SETTLE)
            still("overflow-scrolled")
            row = snapshot()
            record("  the last member active: the scroller followed, its chip in view (scrollLeft ${row.scroll?.left})", row.currentId() == end && inView(row, end) && (row.scroll?.left ?: 0) > 0)
            val visible = row.members.filter { it.id in more && it.id != end && inView(row, it.id) }
            val pick = visible.getOrNull(visible.size / 2)
            if (pick != null) {
                touchChip(member(pick.id), "a chip of the scrolled strip", "its tab is active and wears the mark") {
                    activeCoreTab()?.optString("id") == pick.id && snapshot().currentId() == pick.id
                }
                settle()
                still("overflow-tapped")
            } else {
                record("  no chip of the scrolled strip was in view to touch", false)
            }
        }
    }

    /** The dark scheme, for the record. */
    private fun dark() {
        finding("\n12. Dark scheme")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_500)
        still("dark-top")
        record("  the strip is still shown", snapshot().strip?.phase == "shown")
    }

    // --- touches on chips ------------------------------------------------------------------------

    /**
     * A real touch on the chip `selector` matches, where the DOM draws it, then up to `timeoutMs`
     * for `took` to hold – the claim of the step, named by `effect`. A touch that went in and
     * whose claim never held is a touch fault: the run fails on it at the end.
     */
    private fun touchChip(selector: String, what: String, effect: String, timeoutMs: Long = 6_000, took: () -> Boolean): Boolean {
        val chip = domRect(selector) ?: run {
            record("  nothing matches $selector to touch ($what)", false)
            return false
        }
        val point = touchPoint(chip) ?: run {
            record("  $what at $chip is outside the touchable window $touchable", false)
            return false
        }
        finding("  a finger on $what at ${point.x.roundToInt()},${point.y.roundToInt()} (chip $chip)")
        Finger().tap(point.x, point.y)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                record("  the touch took: $effect", true)
                return true
            }
            SystemClock.sleep(150)
        }
        record("  the touch on $what did not take: not $effect within $timeoutMs ms", false)
        touchFault("a touch on $what did not take: not $effect")
        return false
    }

    /** Each label is in the accessibility tree (the chips are §9.22 buttons with labels). */
    private fun labels(vararg expected: String) {
        for (label in expected) {
            record("  '$label' is in the accessibility tree", waitFor(label, 10_000) != null)
        }
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * Open the overview from the bar's tabs button and let it settle. The emulator's input pipeline
     * can hand a tap's release to the WebView late; then the bar's hold fires first and the Tabs
     * button's quick menu opens in the overview's place: dismissed and tried again, a few times.
     */
    private fun openOverview() {
        if (overviewOpen()) return
        repeat(OPEN_ATTEMPTS) { attempt ->
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

    /**
     * Hold the card at `from` until it lifts, cross the slop, pause, and bring the finger to `to`
     * in one move (see the motion demo's carry for why one). The finger is still down on return.
     */
    private fun carry(from: Rect, to: PointF): Finger {
        val f = Finger()
        f.press(from.exactCenterX(), from.exactCenterY())
        f.moveBy(0f, -NUDGE, 120)
        f.hold(EDGE_PAUSE)
        f.moveBy(to.x - from.exactCenterX(), to.y - (from.exactCenterY() - NUDGE), 0)
        return f
    }

    /** The live bar's pill, where the DOM draws it (the bar may have moved to the other edge). */
    private fun pillBox(): Rect = box(".zen-phone-bar:not([aria-hidden]) .zen-phone-pill")

    /** A quick fling from the left end of `pill`: previous tab. */
    private fun flingRightAt(pill: Rect) {
        val f = Finger()
        f.down(pill.left + 10f, pill.exactCenterY())
        f.moveBy(0.40f * width, 0f, 120)
        f.up()
    }

    /** [touchWithoutGesture] on `pill`. */
    private fun touchWithoutGestureAt(pill: Rect) {
        val f = Finger()
        f.down(pill.exactCenterX(), pill.exactCenterY())
        f.moveBy(0f, if (pill.centerY() < height / 2) 40f else -40f, 150)
        f.hold(150)
        f.up()
    }

    /** Poll until the strip's phase is `phase` (null: no strip), for up to `timeoutMs`. */
    private fun awaitStrip(phase: String?, timeoutMs: Long = 8_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (snapshot().strip?.phase == phase) return
            SystemClock.sleep(100)
        }
        finding("  (the strip never reached ${phase ?: "absence"} within $timeoutMs ms: ${snapshot().describe()})")
    }

    // --- where things are: the chrome's DOM ----------------------------------------------------

    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"
    private fun closeButton(tabId: String) = "${card(tabId)} [aria-label=\"Close tab\"]"
    private fun member(tabId: String) = "$STRIP [data-strip-member=\"$tabId\"]"

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    /**
     * The on-screen box of the first element `selector` matches, from `getBoundingClientRect`
     * scaled to device px; null when nothing matches. With `scrollIntoView`, the grid is scrolled
     * the least it has to for the element to be fully in its viewport first.
     */
    private fun domRect(selector: String, scrollIntoView: Boolean = false): Rect? {
        val scroll = if (!scrollIntoView) "" else
            "var g=document.querySelector('.zen-overview-grid');" +
                "if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
                "if(er.top<gr.top||er.bottom>gr.bottom)e.scrollIntoView({block:'nearest'});}"
        val js = "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" + scroll +
            "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})})()"
        val text = jsString(js)
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

    /** The box of `selector`, waiting for it to be in the DOM; the demo cannot go on without it. */
    private fun box(selector: String): Rect {
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (true) {
            domRect(selector)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) error("nothing matches $selector")
            SystemClock.sleep(250)
        }
    }

    /** Like [box], after scrolling the element fully into the grid's viewport when it is not. */
    private fun show(selector: String): Rect {
        val before = box(selector)
        val after = domRect(selector, scrollIntoView = true) ?: before
        if (after != before) SystemClock.sleep(1_200)
        return domRect(selector) ?: after
    }

    /** Check the DOM's coordinates against the accessibility tree once, on the overview's Spaces button. */
    private fun calibrate() {
        if (calibrated) return
        val fromDom = domRect(SPACES) ?: return
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

    /** The active page's box as the host laid it out from the chrome's layout report (host px). */
    private fun pageBox(tabId: String): Rect? {
        var result: Rect? = null
        instrumentation.runOnMainSync {
            val view = (activity as? MainActivity)?.host?.tabs?.get(tabId) ?: return@runOnMainSync
            val lp = view.layoutParams as? FrameLayout.LayoutParams ?: return@runOnMainSync
            result = Rect(lp.leftMargin, lp.topMargin, lp.leftMargin + lp.width, lp.topMargin + lp.height)
        }
        return result
    }

    // --- the strip, frame by frame ---------------------------------------------------------------

    /** A chip's cell on one frame (CSS px): where it is drawn, its width, its face's width (the entrance and exit scale), the mark. */
    private class Cell(val id: String, val x: Float, val width: Float, val faceWidth: Float, val current: Boolean)

    private class StripState(val phase: String?, val edge: String?, val y: Float)

    private class Scroll(val left: Int, val client: Int, val width: Int) {
        fun describe() = "scrollLeft $left, client $client, content $width"
    }

    /** What the strip showed on one animation frame, `t` ms after sampling began. */
    private class Row(
        val t: Int,
        val band: String,
        val strip: StripState?,
        val members: List<Cell>,
        val exits: List<Cell>,
        val plus: Float?,
        val scroll: Scroll?
    ) {
        fun member(id: String) = members.firstOrNull { it.id == id }
        fun exit(id: String) = exits.firstOrNull { it.id == id }
        fun memberIds() = members.map { it.id }
        fun currentId() = members.firstOrNull { it.current }?.id
        fun describe() = if (strip == null) "no strip, band $band" else
            "strip ${strip.phase} at ${strip.edge}, y ${strip.y}, band $band, members ${memberIds()}, current ${currentId()}, exits ${exits.map { it.id }}"
    }

    /** The JS of one row: the strip's state, the cells and faces, the exits, the plus chip, the scroller. */
    private val rowJs: String =
        "var row={t:0,v:document.documentElement.style.getPropertyValue('--zen-group-strip')||'',s:null,m:[],x:[],p:null,sc:null};" +
            "var strip=document.querySelector('$STRIP');" +
            "if(strip){var tray=strip.querySelector('.zen-group-tray');var tf=tray?tray.style.transform:'';" +
            // The CSSOM hands the written `translate3d(0, 12.34px, 0)` back as `translate3d(0px, 12.34px, 0px)`.
            "var mt=/translate3d\\([^,]+,\\s*(-?[\\d.]+)px/.exec(tf);" +
            "row.s={p:strip.getAttribute('data-phase'),e:strip.getAttribute('data-edge'),y:mt?parseFloat(mt[1]):0};" +
            "var cell=function(c,attr){var b=c.getBoundingClientRect();var f=c.querySelector('.zen-group-chip-face');var fb=f?f.getBoundingClientRect():b;" +
            "return {id:c.getAttribute(attr),x:Math.round(b.left*10)/10,w:Math.round(b.width*10)/10,fw:Math.round(fb.width*10)/10,c:c.getAttribute('aria-current')==='true'};};" +
            "strip.querySelectorAll('[data-strip-member]').forEach(function(c){row.m.push(cell(c,'data-strip-member'));});" +
            "strip.querySelectorAll('[data-strip-exit]').forEach(function(c){row.x.push(cell(c,'data-strip-exit'));});" +
            "var plus=strip.querySelector('[data-strip-plus]');row.p=plus?Math.round(plus.getBoundingClientRect().left*10)/10:null;" +
            "var sc=strip.querySelector('[data-strip-members]');row.sc=sc?{l:Math.round(sc.scrollLeft),c:sc.clientWidth,w:sc.scrollWidth}:null;}"

    /**
     * Log the strip on every animation frame of the chrome for `ms`, into `window.__strip`; read
     * back with [frames]. The first row is taken at once, before any frame: the driver acts after
     * this returns, so frame 0 is always the strip as it stood before the action, whichever side
     * of the first animation frame the change lands on.
     */
    private fun sample(ms: Long = SAMPLE_MS) {
        chromeJs(
            "(function(){var m={log:[],done:false};window.__strip=m;var t0=performance.now();var end=t0+$ms;" +
                "function s(){var now=performance.now();" + rowJs + "row.t=Math.round(now-t0);m.log.push(row);" +
                "if(now<end)requestAnimationFrame(s);else m.done=true;}" +
                "(function(){" + rowJs + "m.log.push(row);})();" +
                "requestAnimationFrame(s);})()"
        )
    }

    private fun parseCell(o: JSONObject) = Cell(
        o.optString("id"), o.getDouble("x").toFloat(), o.getDouble("w").toFloat(), o.getDouble("fw").toFloat(), o.optBoolean("c")
    )

    private fun parseRow(o: JSONObject): Row {
        val s = o.optJSONObject("s")
        val cells = { key: String ->
            val arr = o.optJSONArray(key) ?: JSONArray()
            (0 until arr.length()).map { parseCell(arr.getJSONObject(it)) }
        }
        val sc = o.optJSONObject("sc")
        return Row(
            o.optInt("t"),
            o.optString("v"),
            s?.let {
                StripState(
                    if (it.isNull("p")) null else it.optString("p"),
                    if (it.isNull("e")) null else it.optString("e"),
                    it.optDouble("y", 0.0).toFloat()
                )
            },
            cells("m"),
            cells("x"),
            if (o.isNull("p")) null else o.getDouble("p").toFloat(),
            sc?.let { Scroll(it.optInt("l"), it.optInt("c"), it.optInt("w")) }
        )
    }

    /** The frames logged so far by the last [sample]. */
    private fun frames(): List<Row> {
        val raw = jsString("window.__strip?JSON.stringify(window.__strip.log):''")
        if (raw.isEmpty()) return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { parseRow(arr.getJSONObject(it)) }
    }

    /** The strip as the DOM has it right now. */
    private fun snapshot(): Row {
        val raw = jsString("(function(){" + rowJs + "return JSON.stringify(row)})()")
        return if (raw.isEmpty()) Row(0, "", null, emptyList(), emptyList(), null, null) else parseRow(JSONObject(raw))
    }

    /** Take the still `state` the moment `moment` holds of the strip (polling the DOM), or at the deadline. */
    private fun stillWhen(state: String, timeoutMs: Long = MOMENT_WAIT, moment: (Row) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var caught = false
        while (SystemClock.uptimeMillis() < deadline) {
            if (moment(snapshot())) {
                caught = true
                break
            }
            SystemClock.sleep(30)
        }
        still(state)
        if (!caught) finding("  (the still $state was taken at the deadline: the moment asked for never showed)")
    }

    /** Whether the chip of `id` is drawn within the scroller's box (kept in view). */
    private fun inView(row: Row, id: String): Boolean {
        val cell = row.member(id) ?: return false
        val scroller = domRect("$STRIP [data-strip-members]") ?: return false
        val d = density
        val left = cell.x * d + originX
        return left >= scroller.left - 2 && left + cell.width * d <= scroller.right + 2
    }

    /** Frames on which `value` differs from the frame before by more than `by` (both frames having it). */
    private fun changes(frames: List<Row>, by: Float, value: (Row) -> Float?): List<Int> =
        frames.indices.filter { i ->
            i > 0 && value(frames[i])?.let { a -> value(frames[i - 1])?.let { b -> abs(a - b) > by } } == true
        }

    private fun fps(frames: List<Row>): String {
        val span = frames.last().t - frames.first().t
        return "${frames.size} frames over $span ms (${if (span > 0) (frames.size - 1) * 1000 / span else 0} fps)"
    }

    /**
     * The strip's slide (v2 §11): entering, the tray is drawn at its start – the strip's height
     * behind the row – on the first frame the strip exists and comes to rest at 0 over several
     * frames, the band's share 50px from that first frame (opened in one step, as the strip set
     * off); leaving, it goes from 0 to its height over several frames with the band still open,
     * and the frames after it are without a strip and with the band at 0px (closed once it is out).
     */
    private fun judgeSlide(frames: List<Row>, entering: Boolean, edge: String) {
        if (frames.size < 3) {
            record("  sampled ${frames.size} frame(s): the slide could not be checked", false)
            return
        }
        finding("  sampled ${fps(frames)}")
        val present = frames.indices.filter { frames[it].strip != null }
        if (present.isEmpty()) {
            record("  the strip was never on a frame", false)
            return
        }
        val ys = present.map { abs(frames[it].strip!!.y) }
        val moving = changes(present.map { frames[it] }, 0.5f) { abs(it.strip?.y ?: 0f) }
        val edges = present.all { frames[it].strip!!.edge == edge }
        record("  the strip is at the $edge edge on every frame", edges)
        if (entering) {
            record(
                "  the tray set off from behind the row (${ys.first().roundToInt()} px on its first frame) and came to rest at ${ys.last().roundToInt()} over ${moving.size} moving frames",
                ys.first() >= 20f && ys.last() <= 0.5f && moving.size >= 2
            )
            record("  the strip's phase on its last frame is shown", frames[present.last()].strip!!.phase == "shown")
            record("  the band's share was 50px from the strip's first frame on (one step)", present.all { frames[it].band == "50px" })
        } else {
            val leaving = present.filter { frames[it].strip!!.phase == "leaving" }
            val gone = frames.indices.filter { it > present.last() }
            val leaveYs = leaving.map { abs(frames[it].strip!!.y) }
            record(
                "  the tray slid behind the row: ${leaveYs.firstOrNull()?.roundToInt() ?: "-"} to ${leaveYs.lastOrNull()?.roundToInt() ?: "-"} px over ${moving.size} moving frames",
                leaving.size >= 2 && leaveYs.first() <= 15f && leaveYs.last() >= 20f && moving.size >= 2
            )
            record("  the band stayed open (50px) while the strip slid out", present.all { frames[it].band == "50px" })
            record("  the strip was gone from the frames after, the band closed (0px)", gone.isNotEmpty() && gone.all { frames[it].strip == null && frames[it].band == "0px" })
        }
    }

    /**
     * A chip joining (MOT-13): from its first frame it is small (its face at most 0.8 of a full
     * one) and grows to full over several frames; the chips `after` its slot glide over by the
     * slot pitch on several frames, setting off with it; the chips `before` it and the plus chip
     * (pinned at the tray's end) stand still.
     */
    private fun judgeAdd(frames: List<Row>, id: String, before: List<String>, after: List<String>) {
        if (frames.size < 3) {
            record("  sampled ${frames.size} frame(s): the entrance could not be checked", false)
            return
        }
        finding("  sampled ${fps(frames)}")
        val first = frames.indexOfFirst { it.member(id) != null }
        if (first < 0) {
            record("  the new chip never appeared on a frame", false)
            return
        }
        val full = frames[first].members.firstOrNull { it.id != id }?.faceWidth ?: GROUP_CHIP
        val faces = (first until frames.size).mapNotNull { frames[it].member(id)?.faceWidth }
        val growing = changes(frames.drop(first), 0.3f) { it.member(id)?.faceWidth }
        record(
            "  the new chip was small on its first frame (face ${faces.first()} of $full) and grew to ${faces.last()} over ${growing.size} frames",
            faces.first() <= 0.8f * full && abs(faces.last() - full) <= 1.5f && growing.size >= 2
        )
        for (other in after) {
            val from = frames[maxOf(0, first - 1)].member(other)?.x
            val to = frames.last().member(other)?.x
            val moves = changes(frames, 0.3f) { it.member(other)?.x }
            // Setting off with the chip: the glide's first visible step (over 0.3 px) is within
            // SET_OFF_MS of the chip's first frame – the spring's opening steps are under a pixel,
            // so at the emulator's uneven frame times it can be a few frames in – and never
            // before the chip (the frame before its first is the last one laid out without it).
            val setOff = moves.firstOrNull()?.let { frames[it].t - frames[first].t }
            record(
                "  $other's chip glided over by ${if (from != null && to != null) (to - from).roundToInt() else "-"} px (slot pitch ${SLOT_PITCH.roundToInt()}) on ${moves.size} frames, setting off ${setOff ?: "-"} ms after the chip's first frame",
                from != null && to != null && abs((to - from) - SLOT_PITCH) <= 4f && moves.size >= 2 &&
                    moves.firstOrNull()?.let { it >= first - 1 } == true && setOff != null && setOff <= SET_OFF_MS
            )
        }
        for (other in before) {
            val xs = frames.mapNotNull { it.member(other)?.x }
            record("  $other's chip stood still", xs.isNotEmpty() && xs.all { abs(it - xs.first()) <= 1.5f })
        }
        val plus = frames.mapNotNull { it.plus }
        record("  the plus chip stood still at the tray's end", plus.isNotEmpty() && plus.all { abs(it - plus.first()) <= 1.5f })
    }

    /**
     * A chip leaving (MOT-13): an exit chip appears where the member's cell stood and its face
     * shrinks over several frames until it is gone; the chips after it glide back by the slot
     * pitch on several frames; the plus chip stands still.
     */
    private fun judgeRemove(frames: List<Row>, id: String, after: List<String>) {
        if (frames.size < 3) {
            record("  sampled ${frames.size} frame(s): the exit could not be checked", false)
            return
        }
        finding("  sampled ${fps(frames)}")
        val last = frames.indexOfLast { it.member(id) != null }
        val exits = frames.indices.filter { frames[it].exit(id) != null }
        if (last < 0 || exits.isEmpty()) {
            record("  the leaving chip's exit never showed on a frame (member last on ${if (last < 0) "none" else last}, exits ${exits.size})", false)
            return
        }
        val stood = frames[last].member(id)!!.x
        val exitX = frames[exits.first()].exit(id)!!.x
        val faces = exits.map { frames[it].exit(id)!!.faceWidth }
        val shrinking = changes(exits.map { frames[it] }, 0.3f) { it.exit(id)?.faceWidth }
        record(
            "  the exit chip appeared where the member stood (${exitX.roundToInt()} against ${stood.roundToInt()}) and shrank from ${faces.first()} to ${faces.last()} over ${shrinking.size} frames",
            abs(exitX - stood) <= 2f && faces.first() >= 0.7f * GROUP_CHIP && faces.last() < faces.first() && shrinking.size >= 2
        )
        record("  the exit chip was gone at the end", frames.last().exit(id) == null)
        for (other in after) {
            val from = frames[last].member(other)?.x
            val to = frames.last().member(other)?.x
            val moves = changes(frames.drop(last), 0.3f) { it.member(other)?.x }
            record(
                "  $other's chip glided back by ${if (from != null && to != null) (from - to).roundToInt() else "-"} px on ${moves.size} frames",
                from != null && to != null && abs((from - to) - SLOT_PITCH) <= 4f && moves.size >= 2
            )
        }
        val plus = frames.mapNotNull { it.plus }
        record("  the plus chip stood still at the tray's end", plus.isNotEmpty() && plus.all { abs(it - plus.first()) <= 1.5f })
    }

    // --- the core's state ------------------------------------------------------------------------

    private fun tabExists(tabId: String): Boolean = coreState().getJSONObject("tabs").has(tabId)

    /** The folder a tab is in per the core, null when loose (or gone). */
    private fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    /** The space's regular tabs in track order, as (id, folderId) pairs. */
    private fun trackOrder(state: JSONObject = coreState()): List<Pair<String, String?>> {
        val tabs = state.getJSONObject("tabs")
        val space = state.getJSONArray("spaces").getJSONObject(0)
        val ids = space.getJSONArray("tabIds")
        val order = ArrayList<Pair<String, String?>>()
        for (i in 0 until ids.length()) {
            val id = ids.getString(i)
            val tab = tabs.optJSONObject(id) ?: continue
            if (tab.optBoolean("pinned") || tab.optBoolean("essential")) continue
            order += id to folderOf(id, state)
        }
        return order
    }

    private fun groupOrder(folderId: String): List<String> = trackOrder().filter { it.second == folderId }.map { it.first }

    private fun describeTabs(): String {
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
        return "${if (groups.isEmpty()) "no groups" else groups}; loose [$loose]; active ${activeCoreTab(state)?.optString("title")}"
    }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        record("  $label (${describeTabs()})", ok)
    }

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `group-strip-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18135
        private const val MORE_TABS = 7
        /** How long the finger rests for a ring to take hold and be drawn. */
        private const val REST = 1_400L
        /** How long a release, a close or an activation has to settle the grid and the strip. */
        private const val SETTLE = 4_000L
        /** How long an element may take to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 6_000L
        /** How long a frame-by-frame sample runs. */
        private const val SAMPLE_MS = 9_000L
        /** How long [stillWhen] waits for the moment it wants to catch. */
        private const val MOMENT_WAIT = 6_000L
        /**
         * How long after a joining chip's first frame the glide of the chips after it may take
         * its first visible step (see [judgeAdd]): the spring's first tick is all but still (the
         * frame's timestamp trails the start), and the emulator's frames are uneven.
         */
        private const val SET_OFF_MS = 400
        /** Largest DOM-to-screen offset (px) [calibrate] takes for real rather than for a stale tree. */
        private const val MAX_OFFSET = 200f
        /** Taps on the Tabs button [openOverview] tries before giving up. */
        private const val OPEN_ATTEMPTS = 4
        /** The finger's pause after the lift before its one step to the target (see [carry]). */
        private const val EDGE_PAUSE = 400L
        /** The strip's share of the band (`lib/groupStrip.ts`), a chip's face, and the slot pitch (chip and gap), CSS px. */
        private const val GROUP_STRIP_HEIGHT = 50
        private const val GROUP_CHIP = 36f
        private const val SLOT_PITCH = 40f

        // The seeded profile's ids, and the DOM of the chrome.
        private const val HOME = "tab_home"
        private const val ALPHA = "tab_alpha"
        private const val BETA = "tab_beta"
        private const val STRIP = ".zen-group-strip:not([aria-hidden])"
        private const val TRAY = "$STRIP .zen-group-tray"
        private const val SHOW = "$STRIP [data-strip-show]"
        private const val PLUS = "$STRIP [data-strip-plus]"
        private const val BAR_ROW = ".zen-phone-bar:not([aria-hidden]) .zen-phone-bar-row"
        private const val GRID = ".zen-overview-grid"
        private const val GROUP = ".zen-group"
        private const val SPACES = "[aria-label=\"Spaces\"]"
    }
}
