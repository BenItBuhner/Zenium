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
 * The pages come from a loopback server in this process ([DemoServer]); the profile
 * (`overview-motion-demo-state.json`) is one space with the group Research [Alpha, Beta] and the
 * loose tabs Home (active), Gamma, Delta, so the grid is: the group, Home | Gamma, Delta | New Tab.
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
    // The grid is scrolled so that nothing a scenario changes shrinks it past its scroll offset:
    // a clamp of the offset would move every card at once (on both builds), hiding the glide.

    /**
     * Delta closed with its X: the New Tab card, its neighbour, glides into Delta's place (up
     * from the third row, whose top shows under the fold; the grid is not scrolled for it, so the
     * row it leaves going away does not clamp the offset).
     */
    private fun closeNeighbour() {
        finding("\n1. Delta, the New Tab card's neighbour, closed with its X")
        show("Delta")
        val delta = find("Delta")
        Finger().tap(delta.right - 20 * density, delta.top + 20 * density)
        SystemClock.sleep(GLIDE_PEEK)
        still("close-neighbour-glide")
        SystemClock.sleep(SETTLE)
        expect("Delta is closed", !tabExists("tab_delta"))
        lift("after the close", clear = true)
    }

    /**
     * Gamma dropped on the middle of Beta: the merge ring on the group, and on release Gamma
     * joins the group right behind Beta. The group grows a row and the New Tab card glides
     * across into the slot Gamma left.
     */
    private fun intoGroup() {
        finding("\n2. Gamma into the group (dropped on Beta)")
        show("Group Research")
        val beta = find("Beta")
        val gamma = find("Gamma")
        val f = carry(gamma, PointF(beta.exactCenterX(), beta.exactCenterY()))
        still("into-group-ring")
        lift("Gamma over Beta", ring = true)
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("into-group-glide")
        settleLift("after the drop on Beta")
        expect("Gamma is in the group", folderOf("tab_gamma") == "folder_research")
        expect("the group is Alpha, Beta, Gamma", groupOrder("folder_research") == listOf("tab_alpha", "tab_beta", "tab_gamma"))
    }

    /**
     * Gamma carried out of the group to the top edge of Home: the gap opens before Home once the
     * finger rests there (no ring: a slot, not a target), and on release Gamma leaves the group
     * and lands in it. The hover must not outlive the release.
     */
    private fun outOfGroup() {
        finding("\n3. Gamma out of the group, to the slot before Home")
        show("Group Research")
        val home = find("Home")
        val gamma = find("Gamma")
        val f = carry(gamma, PointF(home.exactCenterX(), home.top + 25 * density))
        still("out-of-group-gap")
        lift("Gamma resting at Home's top edge", held = true, ring = false)
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("out-of-group-glide")
        settleLift("after the drop out of the group")
        expect("Gamma is loose", folderOf("tab_gamma") == null)
        expect("the loose cards are Gamma, Home", looseOrder() == listOf("tab_gamma", "tab_home"))
        expect("the group is back to Alpha, Beta", groupOrder("folder_research") == listOf("tab_alpha", "tab_beta"))
    }

    /**
     * Home carried over the group's header (the ring), then up off the grid (the ring goes), then
     * the touch is cancelled: the card springs back and nothing changes.
     */
    private fun cancelOverGroup() {
        finding("\n4. Home over the group, off the grid, then the touch is cancelled")
        show("Group Research")
        val header = find("Group Research")
        val home = find("Home")
        val f = carry(home, PointF(header.exactCenterX(), header.exactCenterY()))
        still("cancel-ring")
        lift("Home over the group's header", ring = true)
        // Off the grid: the overview's own header row (the space's name and the Spaces button), above the cards.
        val offGrid = find("Spaces")
        f.moveBy(0f, offGrid.exactCenterY() - header.exactCenterY(), 400)
        f.hold(900)
        still("cancel-left")
        lift("Home carried off the grid", held = true, ring = false)
        f.cancel()
        settleLift("after the pointer cancel")
        expect("Home is still loose", folderOf("tab_home") == null)
        expect("the group is still Alpha, Beta", groupOrder("folder_research") == listOf("tab_alpha", "tab_beta"))
    }

    /**
     * Alpha flung out of the group: a fast move onto the New Tab card (the end of the loose
     * cards) and a release while still moving. The card lands where it was let go, the group
     * shrinks to Beta alone (a single column now), and the New Tab card glides with everything else.
     */
    private fun flingOutOfGroup() {
        finding("\n5. Alpha flung out of the group onto the New Tab card")
        show("Group Research")
        val alpha = find("Alpha")
        val newTab = find("New Tab")
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
        expect("Alpha is loose", folderOf("tab_alpha") == null)
        expect("Alpha landed at the end", looseOrder().lastOrNull() == "tab_alpha")
        expect("the group is Beta alone", groupOrder("folder_research") == listOf("tab_beta"))
    }

    /** The dark scheme, and one more glide – Alpha closed, the New Tab card takes its row – caught in flight. */
    private fun darkGlide() {
        finding("\n6. Dark scheme: Alpha closed with its X")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_500)
        show("Group Research")
        still("dark-grid")
        val alpha = find("Alpha")
        Finger().tap(alpha.right - 20 * density, alpha.top + 20 * density)
        SystemClock.sleep(GLIDE_PEEK)
        still("dark-close-glide")
        SystemClock.sleep(SETTLE)
        expect("Alpha is closed", !tabExists("tab_alpha"))
        lift("after the close", clear = true)
    }

    // --- moves -----------------------------------------------------------------------------------

    /** Open the overview from the bar's tabs button (the pill's pull when the bar has none) and let it settle. */
    private fun openOverview() {
        if (findByLabel("Spaces") != null) return
        val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
        if (tabs != null) {
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
        } else {
            val f = Finger()
            f.down(pillCenterX, pillY)
            f.settleIn(0f, -NUDGE)
            f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
            f.up()
        }
        waitFor("Spaces", 8_000) ?: error("the overview never opened")
        SystemClock.sleep(3_000)
    }

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

    /**
     * The bounds of the first of these labels on screen, waiting for the accessibility tree to
     * catch up with the grid (it trails a glide by a second or two on the emulator); the demo
     * cannot go on without it.
     */
    private fun find(vararg labels: String): Rect {
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (true) {
            findAny(*labels)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) error("none of ${labels.joinToString()} is on screen")
            SystemClock.sleep(250)
        }
    }

    /** Like [find], after scrolling the element fully into the grid's viewport. */
    private fun show(vararg labels: String): Rect {
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (true) {
            reveal(*labels)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) error("none of ${labels.joinToString()} exists")
            SystemClock.sleep(250)
        }
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
        /** How long a card's label may take to show up in the accessibility tree after a change. */
        private const val LOOKUP_WAIT = 6_000L
    }
}
