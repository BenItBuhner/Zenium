package app.zen.chromium

import android.graphics.PointF
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
 * Records the tab overview grid's choreography and its drop-target state, and writes what it
 * measured to `overview-motion-findings.txt` next to the screenshots (one `PASS` or `FAIL` per
 * check; the test itself fails only when the driver could not run):
 *
 *  - the New Tab card's neighbour closed with its X: the New Tab card glides into the gap;
 *  - a card dragged into a group (dropped on a member card): the group grows a row and the
 *    New Tab card glides into the slot the card left;
 *  - the card dragged back OUT of the group to a slot between the loose cards: the gap opens
 *    under the finger, the card leaves the group on release, and nothing of the hover (the
 *    target ring, the ghost in the hand, the dimmed stand-in) outlives the release;
 *  - a card carried over the group (ring), off the grid (ring gone) and the touch cancelled;
 *  - a card flung out of the group, released while still moving;
 *  - the same in the dark scheme, for the design gate's still of a glide in flight.
 *
 * After every release the chrome's DOM is read for what a lift leaves behind (`.zen-overview-ghost`,
 * `.zen-overview-card-target` / `[data-targeted]`, a card at the stand-in's opacity) – the same
 * classes on main and after the fix, so the driver records both. A hover that hangs is recovered
 * from by closing the overview (which drops the card) and opening it again, so the run goes on.
 *
 * Where the cards are is read from the DOM as well (`[data-tab-id]`, the group, the New Tab
 * card), not from the accessibility tree: on the API 34 emulator that tree trails the grid by
 * seconds, and a card re-mounted under another parent (into or out of a group) was missing from
 * it for ten seconds in the first run. DOM boxes are CSS px; they are scaled by the device pixel
 * ratio and checked once against the accessibility bounds of the overview's Spaces button.
 *
 * The pages come from a loopback server in this process ([DemoServer]); the profile
 * (`overview-motion-demo-state.json`) is one space with the group Research [Alpha, Beta] and the
 * loose tabs Home (active), Gamma, Delta. An expanded group of two spans the row with its cards in
 * the grid's columns, so the grid is: Research [Alpha | Beta], then Home | Gamma, Delta | New Tab.
 * Driven by the `android-overview-demo` workflow (`demo: motion`). See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class OverviewMotionDemo : DemoHarness("overview-motion-demo-state.json", "overview-motion", "motion-demo") {
    override val tag = "OverviewMotionDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page("Home", "<p>The active tab, a loose card.</p>"),
                "/alpha.html" to DemoServer.page("Alpha", "<p>In the Research group.</p>"),
                "/beta.html" to DemoServer.page("Beta", "<p>In the Research group.</p>"),
                "/gamma.html" to DemoServer.page("Gamma", "<p>A loose card, next to Home.</p>"),
                "/delta.html" to DemoServer.page("Delta", "<p>A loose card, the New Tab card's neighbour.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** Visit Gamma and come back, so the two front cards have thumbnails. */
    override fun warmUp() {
        findings = File(out, "overview-motion-findings.txt")
        findings.writeText(
            "Zenium Android overview motion checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        finding("start: ${describeGrid()}")
    }

    override fun demo() {
        openOverview()
        still("grid")
        lift("nothing in hand", clear = true)

        closeNeighbour()
        intoGroup()
        outOfGroup()
        cancelOverGroup()
        flingOutOfGroup()
        darkGlide()

        still("end")
        finding("\nend: ${describeGrid()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------
    // The grid is scrolled only when a card is out of its viewport: a shrink past the scroll
    // offset would clamp it and move every card at once (on both builds), hiding the glide.

    /**
     * Delta closed with its X: the New Tab card, its neighbour, glides into Delta's place (up
     * from the third row, whose top shows under the fold).
     */
    private fun closeNeighbour() {
        finding("\n1. Delta, the New Tab card's neighbour, closed with its X")
        show(card(DELTA))
        val x = box(closeButton(DELTA))
        Finger().tap(x.exactCenterX(), x.exactCenterY())
        SystemClock.sleep(GLIDE_PEEK)
        still("close-neighbour-glide")
        SystemClock.sleep(SETTLE)
        expect("Delta is closed", !tabExists(DELTA))
        lift("after the close", clear = true)
    }

    /**
     * Gamma dropped on the middle of Beta: the merge ring on the group, and on release Gamma
     * joins the group right behind Beta. The group grows a row and the New Tab card glides
     * across into the slot Gamma left.
     */
    private fun intoGroup() {
        finding("\n2. Gamma into the group (dropped on Beta)")
        show(GROUP)
        val beta = box(card(BETA))
        val gamma = box(card(GAMMA))
        val f = carry(gamma, PointF(beta.exactCenterX(), beta.exactCenterY()))
        still("into-group-ring")
        lift("Gamma over Beta", ring = true)
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("into-group-glide")
        settleLift("after the drop on Beta")
        expect("Gamma is in the group", folderOf(GAMMA) == RESEARCH)
        expect("the group is Alpha, Beta, Gamma", groupOrder(RESEARCH) == listOf(ALPHA, BETA, GAMMA))
    }

    /**
     * Gamma carried out of the group to the right edge of Home: the gap opens after Home once the
     * finger rests there (no ring: a slot, not a target), the group shrinks a row and the grid
     * reflows up under the finger – which is then over the New Tab card, the end of the loose
     * cards, the same slot – and on release Gamma leaves the group and lands there. The hover must
     * not outlive the release. (Home's top edge would read "before Home" first and, after the
     * reflow, "the end" – the card would hop twice under a still finger.)
     */
    private fun outOfGroup() {
        finding("\n3. Gamma out of the group, to the slot after Home")
        show(GROUP)
        val home = box(card(HOME))
        val gamma = box(card(GAMMA))
        val f = carry(gamma, PointF(home.right - 0.12f * home.width(), home.exactCenterY()))
        still("out-of-group-gap")
        lift("Gamma resting at Home's right edge", held = true, ring = false)
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("out-of-group-glide")
        settleLift("after the drop out of the group")
        expect("Gamma is loose", folderOf(GAMMA) == null)
        expect("the loose cards are Home, Gamma", looseOrder() == listOf(HOME, GAMMA))
        expect("the group is back to Alpha, Beta", groupOrder(RESEARCH) == listOf(ALPHA, BETA))
    }

    /**
     * Home carried over the group's header (the ring), then up off the grid (the ring goes), then
     * the touch is cancelled: the card springs back and nothing changes. The finger goes up the
     * gutter between Alpha and Beta: over a member card on the way it would take a slot in the
     * group instead, and a card's own group is never its target (no ring).
     */
    private fun cancelOverGroup() {
        finding("\n4. Home over the group, off the grid, then the touch is cancelled")
        show(GROUP)
        val header = box(GROUP_HEADER)
        val home = box(card(HOME))
        val gutterX = (box(card(ALPHA)).right + box(card(BETA)).left) / 2f
        val f = Finger()
        f.press(home.exactCenterX(), home.exactCenterY())
        f.moveBy(0f, -NUDGE, 120)
        f.moveBy(gutterX - home.exactCenterX(), 0f, 300)
        f.moveBy(0f, header.exactCenterY() - (home.exactCenterY() - NUDGE), 700)
        f.hold(1_400)
        still("cancel-ring")
        lift("Home over the group's header", ring = true)
        // Off the grid: the overview's own header row (the space's name and the Spaces button), above the cards.
        val offGrid = box(SPACES)
        f.moveBy(0f, offGrid.exactCenterY() - header.exactCenterY(), 400)
        f.hold(900)
        still("cancel-left")
        lift("Home carried off the grid", held = true, ring = false)
        f.cancel()
        settleLift("after the pointer cancel")
        expect("Home is still loose", folderOf(HOME) == null)
        expect("the group is still Alpha, Beta", groupOrder(RESEARCH) == listOf(ALPHA, BETA))
    }

    /**
     * Alpha flung out of the group: a fast move onto the New Tab card (the end of the loose
     * cards) and a release while still moving. The card lands where it was let go, the group
     * shrinks to Beta alone (a single column now), and the New Tab card glides with everything else.
     */
    private fun flingOutOfGroup() {
        finding("\n5. Alpha flung out of the group onto the New Tab card")
        show(GROUP)
        val alpha = box(card(ALPHA))
        val newTab = box(NEW_TAB)
        val f = Finger()
        f.press(alpha.exactCenterX(), alpha.exactCenterY())
        f.moveBy(0f, -NUDGE, 120)
        // Aim at the visible top part of the card: its lower half may be below the fold.
        val toY = minOf(newTab.exactCenterY(), newTab.top + 60 * density)
        f.moveBy(newTab.exactCenterX() - alpha.exactCenterX(), toY - (alpha.exactCenterY() - NUDGE), 220)
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("fling-glide")
        settleLift("after the fling")
        expect("Alpha is loose", folderOf(ALPHA) == null)
        expect("Alpha landed at the end", looseOrder().lastOrNull() == ALPHA)
        expect("the group is Beta alone", groupOrder(RESEARCH) == listOf(BETA))
    }

    /** The dark scheme, and one more glide – Alpha closed, the New Tab card takes its row – caught in flight. */
    private fun darkGlide() {
        finding("\n6. Dark scheme: Alpha closed with its X")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_500)
        show(GROUP)
        still("dark-grid")
        val x = box(closeButton(ALPHA))
        Finger().tap(x.exactCenterX(), x.exactCenterY())
        SystemClock.sleep(GLIDE_PEEK)
        still("dark-close-glide")
        SystemClock.sleep(SETTLE)
        expect("Alpha is closed", !tabExists(ALPHA))
        lift("after the close", clear = true)
    }

    // --- moves -----------------------------------------------------------------------------------

    /** Open the overview from the bar's tabs button (the pill's pull when the bar has none) and let it settle. */
    private fun openOverview() {
        if (overviewOpen()) return
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
        while (!overviewOpen()) {
            if (SystemClock.uptimeMillis() >= deadline) error("the overview never opened")
            SystemClock.sleep(200)
        }
        SystemClock.sleep(2_000)
        calibrate()
    }

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    /**
     * Hold the card at `from` until it lifts, cross the slop, carry it so the finger ends at `to`
     * and rest there (long enough for a slot to take hold); the finger is still down.
     */
    private fun carry(from: Rect, to: PointF, travelMs: Long = 900, restMs: Long = 1_400): Finger {
        val f = Finger()
        f.press(from.exactCenterX(), from.exactCenterY())
        f.moveBy(0f, -NUDGE, 120)
        f.moveBy(to.x - from.exactCenterX(), to.y - (from.exactCenterY() - NUDGE), travelMs)
        f.hold(restMs)
        return f
    }

    // --- where things are: the chrome's DOM ----------------------------------------------------

    /** Screen px the DOM's origin is at: (0, 0) for a chrome that fills the window; see [calibrate]. */
    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"
    private fun closeButton(tabId: String) = "${card(tabId)} [aria-label=\"Close tab\"]"

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    /**
     * The on-screen box of the first element `selector` matches, from `getBoundingClientRect`
     * scaled to device px; null when nothing matches. With `scrollIntoView`, the grid is scrolled
     * the least it has to for the element to be fully in its viewport first (when it is not).
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

    /**
     * Check the DOM's coordinates against the accessibility tree once: the Spaces button in the
     * overview's header never moves, so its accessibility bounds are current. Any offset (a
     * chrome not at the window's origin) is applied to every box from then on.
     */
    private fun calibrate() {
        if (calibrated) return
        val fromDom = domRect(SPACES) ?: return
        val fromTree = waitFor("Spaces", 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding(
            "coordinates: Spaces button at $fromDom from the DOM, $fromTree from the accessibility tree" +
                " (offset ${dx.roundToInt()}, ${dy.roundToInt()})"
        )
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
        calibrated = true
    }

    // --- what the grid shows of a lift -----------------------------------------------------------

    /**
     * What a card in the hand leaves on the grid, read from the chrome: the ghost that follows the
     * finger, target rings (on a card or a group), and cards dimmed as the stand-in of a lifted
     * card. All three are gone once a gesture is over – and all three stay when a hover hangs.
     */
    private class Lift(val ghost: Boolean, val rings: Int, val held: Int) {
        val clear get() = !ghost && rings == 0 && held == 0
        override fun toString() = "ghost=$ghost rings=$rings held=$held"
    }

    private fun readLift(): Lift {
        val raw = chromeJs(
            "(function(){var g=!!document.querySelector('.zen-overview-ghost');" +
                "var r=document.querySelectorAll('.zen-overview-card-target,[data-targeted]').length;var h=0;" +
                "document.querySelectorAll('.zen-overview-card:not(.zen-overview-ghost)').forEach(function(e){if(e.style.opacity==='0.35')h++});" +
                "return JSON.stringify({ghost:g,rings:r,held:h})})()"
        )
        val json = runCatching { JSONObject((JSONTokener(raw).nextValue() as? String) ?: "{}") }.getOrElse { JSONObject() }
        return Lift(json.optBoolean("ghost"), json.optInt("rings", -1), json.optInt("held", -1))
    }

    /**
     * Check the lift's state right now: `clear` wants nothing of it; otherwise a ring (or none)
     * and a card in the hand (the ghost and its stand-in) as asked.
     */
    private fun lift(label: String, clear: Boolean = false, ring: Boolean? = null, held: Boolean? = null) {
        val state = readLift()
        val ok = if (clear) state.clear else
            (ring == null || (state.rings > 0) == ring) && (held == null || (state.ghost && state.held > 0) == held)
        record("  $label: $state", ok)
    }

    /**
     * After a release: wait for the lift to clear (the ghost flies into its slot on a spring) and
     * record whether it did. A hover that hangs is recovered from by closing the overview, which
     * drops whatever is in the hand, and opening it again.
     */
    private fun settleLift(label: String) {
        val deadline = SystemClock.uptimeMillis() + SETTLE
        var state = readLift()
        while (!state.clear && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            state = readLift()
        }
        if (!state.clear) SystemClock.sleep(1_500)
        state = readLift()
        record("  $label: $state${if (state.clear) "" else " – the hover outlived the release"}", state.clear)
        if (!state.clear) {
            still("hung")
            finding("  recovering: closing the overview (drops the card) and opening it again")
            back()
            SystemClock.sleep(2_500)
            openOverview()
            val after = readLift()
            record("  after the recovery: $after", after.clear)
        } else {
            // Let the grid finish its glide before the next move.
            SystemClock.sleep(1_200)
        }
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

    private fun looseOrder(): List<String> = trackOrder().filter { it.second == null }.map { it.first }

    private fun groupOrder(folderId: String): List<String> = trackOrder().filter { it.second == folderId }.map { it.first }

    private fun describeGrid(): String {
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

    private fun expect(label: String, ok: Boolean) {
        record("  $label (${describeGrid()})", ok)
    }

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `overview-motion-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18127
        /** How long after a release or a close the glide is caught in flight for a still. */
        private const val GLIDE_PEEK = 450L
        /** How long a release has to clear the lift and the grid to finish its glide. */
        private const val SETTLE = 4_000L
        /** How long an element may take to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 6_000L
        /** Largest DOM-to-screen offset (px) [calibrate] takes for real rather than for a stale tree. */
        private const val MAX_OFFSET = 200f

        // The seeded profile's ids, and the DOM of the grid.
        private const val ALPHA = "tab_alpha"
        private const val BETA = "tab_beta"
        private const val HOME = "tab_home"
        private const val GAMMA = "tab_gamma"
        private const val DELTA = "tab_delta"
        private const val RESEARCH = "folder_research"
        private const val GROUP = ".zen-group"
        private const val GROUP_HEADER = "[aria-label=\"Group Research\"]"
        private const val NEW_TAB = ".zen-overview-new"
        private const val SPACES = "[aria-label=\"Spaces\"]"
    }
}
