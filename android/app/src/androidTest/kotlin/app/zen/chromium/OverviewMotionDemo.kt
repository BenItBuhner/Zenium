package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
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
 * Records the tab overview grid's choreography (v2 draft §11.4) and its drop-target state, and
 * writes what it measured to `overview-motion-findings.txt` next to the screenshots (one `PASS`
 * or `FAIL` per check; the test itself fails only when the driver could not run):
 *
 *  1. the New Tab card's neighbour closed with its X: the New Tab card glides into the gap;
 *  2. a card dragged into a group (dropped on a member card): the card glides into its inner
 *     slot while the group grows a row on its spring; the cards below stand still until the
 *     height has settled and glide then, the New Tab card among them;
 *  3. the card dragged back OUT of the group, the finger resting at the left edge of the first
 *     loose card: the stand-in glides to the slot before it while the group shrinks a row; the
 *     cards below wait for the height and glide after. The grid reflows up under the still
 *     finger, which then rests over the New Tab card – another slot – but the slot belongs to the
 *     finger: the stand-in stays put and the release lands the card in the held slot, and
 *     nothing of the hover (the ring, the ghost in the hand, the dimmed stand-in) outlives it;
 *  4. a card carried over the group (ring), off the grid (ring gone) and the touch cancelled;
 *  5. a card flung out of the group, released while still moving;
 *  6. the last card dragged out of a group: the group shrinks to nothing on its spring with its
 *     header and colour kept until the end, the card gliding out, the cards below waiting;
 *  7. a card dropped on a loose card: the group made grows out of their row with its header and
 *     tint off until the glide's end;
 *  8. the same close as 1 in the dark scheme, for the design gate's still of a glide in flight.
 *
 * The sequences of 2, 3, 6 and 7 are measured frame by frame: a `requestAnimationFrame` loop in
 * the chrome logs where every card of interest is drawn (`getBoundingClientRect`, transforms
 * included) and the group card's height and chrome, and the driver reads the log back and checks
 * the order of events (see [sequence]). The stills of a sequence in flight are taken when the DOM
 * shows the moment asked for (the height mid-way, the row below setting off), not on a timer.
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
        dissolveGroup()
        makeGroup()
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
     * joins the group right behind Beta. The group grows a row on its spring while Gamma glides
     * from its loose slot into its inner one; Home and the New Tab card, below the group, stand
     * still until the height has settled and glide then – Home down a row, the New Tab card
     * across into the slot Gamma left (v2 §11.4: entering mirrors leaving).
     */
    private fun intoGroup() {
        finding("\n2. Gamma into the group (dropped on Beta)")
        show(GROUP)
        val beta = box(card(BETA))
        val gamma = box(card(GAMMA))
        val f = carry(gamma, PointF(beta.exactCenterX(), beta.exactCenterY()))
        f.hold(REST)
        still("into-group-ring")
        lift("Gamma over Beta", ring = true)
        sample(mapOf(GROUP_KEY to GROUP, "Gamma" to card(GAMMA), "Home" to card(HOME), NEW_TAB_KEY to NEW_TAB))
        val base = snapshot()
        f.up()
        stillWhen("into-group-glide") { it.heightChanged(base, 12f) && !it.moved("Home", base, 2f) }
        stillWhen("into-group-below-glide") { it.moved("Home", base, 6f) }
        settleLift("after the drop on Beta")
        sequence(frames(), mover = "Gamma", below = listOf("Home", NEW_TAB_KEY), after = listOf("Home", NEW_TAB_KEY), chrome = Chrome.KEPT)
        expect("Gamma is in the group", folderOf(GAMMA) == RESEARCH)
        expect("the group is Alpha, Beta, Gamma", groupOrder(RESEARCH) == listOf(ALPHA, BETA, GAMMA))
    }

    /**
     * Gamma carried out of the group to the left edge of Home, the first loose card, and the
     * finger rests there: the slot before Home takes hold (no ring: a slot, not a target). The
     * stand-in glides from its inner slot to the loose one while the group shrinks a row; Home and
     * the New Tab card wait for the height to settle and glide then. The reflow puts the New Tab
     * card – "the end", another slot – under the still finger; the slot belongs to the finger
     * (v2 §11.4), so the stand-in stays before Home and the release lands Gamma there: the loose
     * cards are Gamma, Home. The hover must not outlive the release.
     */
    private fun outOfGroup() {
        finding("\n3. Gamma out of the group, the finger resting at Home's left edge (the slot before Home)")
        show(GROUP)
        val home = box(card(HOME))
        val gamma = box(card(GAMMA))
        sample(mapOf(GROUP_KEY to GROUP, "Gamma" to card(GAMMA), "Home" to card(HOME), NEW_TAB_KEY to NEW_TAB))
        val base = snapshot()
        val f = carry(gamma, PointF(home.left + 0.12f * home.width(), home.exactCenterY()))
        // The slot takes hold once the finger has rested for the dwell; the sequence runs under
        // the still finger.
        stillWhen("out-of-group-glide") { it.heightChanged(base, 12f) && !it.moved(NEW_TAB_KEY, base, 2f) }
        stillWhen("out-of-group-below-glide") { it.moved(NEW_TAB_KEY, base, 6f) }
        f.hold(REST)
        still("out-of-group-gap")
        lift("Gamma resting at Home's left edge", held = true, ring = false)
        val log = frames()
        sequence(log, mover = "Gamma", below = listOf("Home", NEW_TAB_KEY), after = listOf("Home", NEW_TAB_KEY), chrome = Chrome.KEPT)
        val end = log.lastOrNull()
        val standIn = end?.boxes?.get("Gamma")
        val homeNow = end?.boxes?.get("Home")
        val beforeHome = standIn != null && homeNow != null && standIn.x < homeNow.x && abs(standIn.y - homeNow.y) < 2f
        val glided = glides(log, "Gamma")
        record(
            "  the stand-in stayed in the slot the finger chose while the grid reflowed under the still finger:" +
                " glided $glided time(s), rests before Home",
            glided == 1 && beforeHome
        )
        f.up()
        SystemClock.sleep(GLIDE_PEEK)
        still("out-of-group-release")
        settleLift("after the drop out of the group")
        expect("Gamma is loose", folderOf(GAMMA) == null)
        expect("the loose cards are Gamma, Home: the held slot, not the one the reflow put under the finger", looseOrder() == listOf(GAMMA, HOME))
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
        f.hold(REST)
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

    /**
     * Beta, the group's last card, carried out to the right edge of Alpha – the end of the loose
     * cards – and the finger rests there. The group has nothing left: it shrinks to nothing on
     * its spring where it stood, header and colour kept until the end (v2 §11.4: they go at the
     * end of the glide, not per frame), while Beta glides out to its loose slot; Gamma and Alpha,
     * below the group, wait for the height and glide up then. Home, beside the group, glides at
     * once. On release Beta is loose at the end and the group card is gone.
     */
    private fun dissolveGroup() {
        finding("\n6. Beta, the group's last card, out of the group to the end: the group dissolves")
        show(GROUP)
        val alpha = box(card(ALPHA))
        val beta = box(card(BETA))
        sample(mapOf(GROUP_KEY to GROUP, "Beta" to card(BETA), "Gamma" to card(GAMMA), "Alpha" to card(ALPHA), NEW_TAB_KEY to NEW_TAB))
        val base = snapshot()
        val f = carry(beta, PointF(alpha.right - 0.12f * alpha.width(), alpha.exactCenterY()))
        stillWhen("dissolve-shrinking") { it.heightChanged(base, 12f) && !it.moved("Gamma", base, 2f) }
        stillWhen("dissolve-below-glide") { it.moved("Gamma", base, 6f) }
        f.hold(REST)
        lift("Beta resting at Alpha's right edge", held = true, ring = false)
        sequence(frames(), mover = "Beta", below = listOf("Gamma", "Alpha", NEW_TAB_KEY), after = listOf("Gamma", "Alpha"), chrome = Chrome.GONE_AT_END)
        f.up()
        settleLift("after the drop out of the group")
        expect("Beta is loose, at the end", folderOf(BETA) == null && looseOrder().lastOrNull() == BETA)
        expect("the group holds nothing", groupOrder(RESEARCH).isEmpty())
        record("  the group's card is gone from the grid", domRect(GROUP) == null)
    }

    /**
     * Gamma dropped on the middle of Home, both loose: the merge ring on Home, and on release the
     * two are a new group across their row. The group card grows out of the bare row on its
     * spring with its header and tint off; Home and Gamma glide into their inner slots; Alpha,
     * Beta and the New Tab card below wait for the height and glide down then; the header and
     * tint come on at the glide's end (v2 §11.4).
     */
    private fun makeGroup() {
        finding("\n7. Gamma dropped on Home: a new group is made")
        show(card(HOME))
        val home = box(card(HOME))
        val gamma = box(card(GAMMA))
        val f = carry(gamma, PointF(home.exactCenterX(), home.exactCenterY()))
        f.hold(REST)
        lift("Gamma over Home", ring = true)
        sample(mapOf(GROUP_KEY to GROUP, "Gamma" to card(GAMMA), "Alpha" to card(ALPHA), "Beta" to card(BETA), NEW_TAB_KEY to NEW_TAB))
        val base = snapshot()
        f.up()
        stillWhen("new-group-forming") { it.boxes[GROUP_KEY]?.chromeOff == true && !it.moved("Alpha", base, 2f) }
        stillWhen("new-group-below-glide") { it.moved("Alpha", base, 6f) }
        settleLift("after the drop on Home")
        sequence(frames(), mover = "Gamma", below = listOf("Alpha", "Beta", NEW_TAB_KEY), after = listOf("Alpha", "Beta", NEW_TAB_KEY), chrome = Chrome.OFF_UNTIL_END)
        still("new-group-formed")
        val made = folderOf(HOME)
        expect("Home and Gamma are a group", made != null && folderOf(GAMMA) == made)
        expect("the group is Home, Gamma", made != null && groupOrder(made) == listOf(HOME, GAMMA))
        expect("the loose cards are Alpha, Beta", looseOrder() == listOf(ALPHA, BETA))
    }

    /** The dark scheme, and one more glide – Alpha closed, Beta and the New Tab card take up the room – caught in flight. */
    private fun darkGlide() {
        finding("\n8. Dark scheme: Alpha closed with its X")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_500)
        show(card(ALPHA))
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
     * Hold the card at `from` until it lifts, cross the slop and carry it so the finger ends at
     * `to`; the finger is still down, and has just arrived (a slot takes hold once it has rested
     * there for the dwell).
     */
    private fun carry(from: Rect, to: PointF, travelMs: Long = 900): Finger {
        val f = Finger()
        f.press(from.exactCenterX(), from.exactCenterY())
        f.moveBy(0f, -NUDGE, 120)
        f.moveBy(to.x - from.exactCenterX(), to.y - (from.exactCenterY() - NUDGE), travelMs)
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

    // --- the sequence a group's height runs (v2 §11.4), frame by frame ---------------------------

    /** Where an element is drawn on one frame (CSS px, transforms included) and, for a group card, its state. */
    private class Box(val x: Float, val y: Float, val w: Float, val h: Float, val chromeOff: Boolean, val dissolving: Boolean) {
        /** On screen with a height: a group shrunk to nothing (`display: none`) measures all zeros. */
        val alive get() = h > 0.5f
        fun near(o: Box, tolerance: Float) = abs(x - o.x) <= tolerance && abs(y - o.y) <= tolerance
    }

    /** What the grid showed on one animation frame, `t` ms after sampling began. */
    private class Frame(val t: Int, val boxes: Map<String, Box?>, val ghost: Boolean) {
        /** Whether the group's height differs from `base`'s by more than `by` (the group on both). */
        fun heightChanged(base: Frame, by: Float): Boolean {
            val a = boxes[GROUP_KEY] ?: return false
            val b = base.boxes[GROUP_KEY] ?: return false
            return abs(a.h - b.h) > by
        }

        /** Whether `name` is drawn more than `by` px from where `base` had it (or has gone). */
        fun moved(name: String, base: Frame, by: Float): Boolean {
            val b = base.boxes[name] ?: return false
            val a = boxes[name] ?: return true
            return !a.near(b, by)
        }
    }

    /** What the group card's header, tint and radius do through a sequence. */
    private enum class Chrome {
        /** An existing group changing height: on throughout. */
        KEPT,
        /** A group being made: off while the height runs, on at the glide's end. */
        OFF_UNTIL_END,
        /** A group dissolving: kept while it shrinks, gone with the card at the end. */
        GONE_AT_END
    }

    private var sampled: Map<String, String> = emptyMap()

    /** The JS of one sample of `named` (name to selector): the boxes as [Box] fields, `g` the ghost. */
    private fun sampleJs(named: Map<String, String>): String =
        "var keys=${JSONObject(named)};var row={t:0,b:{}};" +
            "for(var k in keys){var e=document.querySelector(keys[k]);if(!e){row.b[k]=null;continue;}" +
            "var r=e.getBoundingClientRect();row.b[k]={x:Math.round(r.left*10)/10,y:Math.round(r.top*10)/10," +
            "w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10," +
            "c:e.getAttribute('data-chrome')==='off',d:e.hasAttribute('data-dissolving')};}" +
            "row.g=!!document.querySelector('.zen-overview-ghost');"

    /**
     * Log the elements `named` on every animation frame of the chrome for `ms`, into
     * `window.__motion`, where they are drawn (`getBoundingClientRect`, the FLIP transform
     * included) and the group card's height and chrome. Read back with [frames].
     */
    private fun sample(named: Map<String, String>, ms: Long = SAMPLE_MS) {
        sampled = named
        chromeJs(
            "(function(){var m={log:[],done:false};window.__motion=m;var t0=performance.now();var end=t0+$ms;" +
                "function s(){var now=performance.now();" + sampleJs(named) + "row.t=Math.round(now-t0);m.log.push(row);" +
                "if(now<end)requestAnimationFrame(s);else m.done=true;}" +
                "requestAnimationFrame(s);})()"
        )
    }

    private fun parseFrame(row: JSONObject): Frame {
        val b = row.getJSONObject("b")
        val boxes = HashMap<String, Box?>()
        for (k in sampled.keys) {
            val o = b.optJSONObject(k)
            boxes[k] = o?.let {
                Box(
                    it.getDouble("x").toFloat(), it.getDouble("y").toFloat(),
                    it.getDouble("w").toFloat(), it.getDouble("h").toFloat(),
                    it.optBoolean("c"), it.optBoolean("d")
                )
            }
        }
        return Frame(row.optInt("t"), boxes, row.optBoolean("g"))
    }

    /** The frames logged so far by the last [sample]. */
    private fun frames(): List<Frame> {
        val raw = jsString("window.__motion?JSON.stringify(window.__motion.log):''")
        if (raw.isEmpty()) return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { parseFrame(arr.getJSONObject(it)) }
    }

    /** The sampled elements as the DOM has them right now. */
    private fun snapshot(): Frame {
        val raw = jsString("(function(){" + sampleJs(sampled) + "return JSON.stringify(row)})()")
        return if (raw.isEmpty()) Frame(0, emptyMap(), false) else parseFrame(JSONObject(raw))
    }

    /**
     * Take the still `state` the moment `moment` holds of the grid (polling the DOM), or at the
     * deadline when it never does – the still is numbered either way.
     */
    private fun stillWhen(state: String, timeoutMs: Long = MOMENT_WAIT, moment: (Frame) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var caught = false
        while (SystemClock.uptimeMillis() < deadline) {
            if (moment(snapshot())) {
                caught = true
                break
            }
            SystemClock.sleep(40)
        }
        still(state)
        if (!caught) finding("  (the still $state was taken at the deadline: the moment asked for never showed)")
    }

    /** The frames on which `name` is drawn somewhere else than the frame before (both frames having it). */
    private fun movesOf(frames: List<Frame>, name: String): List<Int> =
        frames.indices.filter { i ->
            i > 0 && frames[i].boxes[name]?.let { a -> frames[i - 1].boxes[name]?.let { b -> !a.near(b, 1f) } } == true
        }

    /** How many separate glides `name` made: runs of moving frames, two or more still frames apart. */
    private fun glides(frames: List<Frame>, name: String): Int {
        var count = 0
        var last: Int? = null
        for (i in movesOf(frames, name)) {
            if (last == null || i - last > 2) count++
            last = i
        }
        return count
    }

    /**
     * Check the sequence v2 §11.4 asks of a group changing height, from the frames [sample]
     * logged: the height ran on its spring; `mover` (the card leaving or entering) set off with
     * it; each of `below` stood still until the height had settled and, those in `after`, glided
     * then; and the group's chrome did what `chrome` says.
     */
    private fun sequence(frames: List<Frame>, mover: String, below: List<String>, after: List<String>, chrome: Chrome) {
        if (frames.size < 3) {
            record("  sampled ${frames.size} frame(s): the sequence could not be checked", false)
            return
        }
        val span = frames.last().t - frames.first().t
        finding("  sampled ${frames.size} frames over $span ms (${if (span > 0) (frames.size - 1) * 1000 / span else 0} fps)")
        val heights = frames.indices.filter { i ->
            i > 0 && frames[i].boxes[GROUP_KEY]?.let { a -> frames[i - 1].boxes[GROUP_KEY]?.let { b -> a.alive && b.alive && abs(a.h - b.h) > 0.5f } } == true
        }
        val first = heights.firstOrNull()
        val last = heights.lastOrNull()
        if (first == null || last == null) {
            record("  the group's height ran on its spring: it never changed", false)
            return
        }
        val h0 = frames[first - 1].boxes[GROUP_KEY]!!.h
        val h1 = frames[last].boxes[GROUP_KEY]!!.h
        record(
            "  the group's height ran on its spring: ${heights.size} frames, ${h0.roundToInt()} -> ${h1.roundToInt()} px" +
                " over ${frames[last].t - frames[first - 1].t} ms (frames $first-$last)",
            heights.size >= 2
        )
        val setOff = movesOf(frames, mover).firstOrNull()
        record(
            "  $mover glided while the height ran: set off on frame ${setOff ?: "none"}, the height on $first",
            setOff != null && setOff in (first - 2)..(first + 2)
        )
        for (name in below) {
            val start = frames.indexOfFirst { it.boxes[name] != null }
            if (start < 0) {
                record("  $name was never on screen", false)
                continue
            }
            val base = frames[start].boxes[name]!!
            val stillThrough = (start..last).all { i -> frames[i].boxes[name]?.near(base, 2f) ?: true }
            val movedAt = (last + 1 until frames.size).firstOrNull { i -> frames[i].boxes[name]?.let { !it.near(base, 2f) } ?: false }
            if (name in after) {
                record(
                    "  $name stood still until the height had settled (frame $last), then glided (from frame ${movedAt ?: "never"})",
                    stillThrough && movedAt != null
                )
            } else {
                record("  $name stood still while the height ran", stillThrough)
            }
        }
        val alive = frames.indices.filter { frames[it].boxes[GROUP_KEY]?.alive == true }
        val end = frames.last().boxes[GROUP_KEY]
        when (chrome) {
            Chrome.KEPT -> record(
                "  the group kept its header and tint throughout",
                alive.none { frames[it].boxes[GROUP_KEY]!!.chromeOff } && end?.alive == true
            )
            Chrome.OFF_UNTIL_END -> {
                val onAt = alive.firstOrNull { !frames[it].boxes[GROUP_KEY]!!.chromeOff }
                record(
                    "  header and tint off while the height ran, on at the glide's end (on from frame ${onAt ?: "never"}, the height settled on $last)",
                    onAt != null && onAt >= last
                )
            }
            Chrome.GONE_AT_END -> {
                val kept = (first - 1..last).all { i -> frames[i].boxes[GROUP_KEY]?.let { it.alive && it.dissolving && !it.chromeOff } == true }
                record(
                    "  the group kept its header and colour until its height had settled, then left the grid",
                    kept && (end == null || !end.alive)
                )
            }
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
        /** How long the finger rests for a slot or a ring to take hold and be drawn. */
        private const val REST = 1_400L
        /** How long a release has to clear the lift and the grid to finish its glide. */
        private const val SETTLE = 4_000L
        /** How long an element may take to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 6_000L
        /** How long a frame-by-frame sample of a sequence runs. */
        private const val SAMPLE_MS = 9_000L
        /** How long [stillWhen] waits for the moment it wants to catch. */
        private const val MOMENT_WAIT = 5_000L
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
        /** The names the sampler logs the group card and the New Tab card under. */
        private const val GROUP_KEY = "the group"
        private const val NEW_TAB_KEY = "the New Tab card"
    }
}
