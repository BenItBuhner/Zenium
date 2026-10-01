package app.zen.chromium

import android.graphics.RectF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * TABLET-03 (W6-S25-a): the tablet sidebar's tab drag under a real finger – the long-press lift,
 * the drop mark, the edge auto-scroll, the drop – on the seeded Work space (Home active, the group
 * Research [Alpha, Beta], the loose Gamma and Delta). Every act is an injected touch on a box read
 * from the chrome's DOM; the claims are read off the chrome's DOM and stores and the core's state,
 * never the accessibility tree.
 *
 *  1. REORDER (light): a hold on Gamma's row lifts it (the ghost at scale 1.02 under the level-2
 *     shadow at 90 %, the row's own box a hole) – still; the finger drags to Delta's lower half:
 *     the drop store names `tab:tab_delta:after`, the caret stands in the row-tall gap that opens
 *     where Delta stood as Delta slides up a pitch – still; the release puts Gamma after Delta in
 *     the core's track – still.
 *  2. AUTO-SCROLL (light): extra tabs off camera until the list has room under its box; a plain
 *     swipe on the list scrolls it and lifts nothing (the hold never fires under a moving finger).
 *     The TOP band, as today: a row near the foot lifted and held 12 px under the list's top edge
 *     has the list scroll up under it to its top, where the seeded list's first item – the
 *     Research header – comes under the finger: an into-target, the caret down, the release joins
 *     the group. The BOTTOM band, the slot drop: Delta lifted from near the head and held 12 px
 *     over the bottom edge has the list scroll down under it (the speed read on the page's clock
 *     for the findings) to its foot, where the drop store names a slot and the caret stands in the
 *     gap – still; the release lands Delta further down the track. The extra tabs are closed again.
 *  3. GROUPS (as today): Gamma dragged onto the Research header is an into-target (the header's
 *     `data-drop-into`, the ghost thinned) and joins the group on release; dragged from the fold
 *     to Delta's lower half it leaves the group again.
 *  4. REDUCED MOTION: where the WebView reflects `animator_duration_scale 0` as
 *     `prefers-reduced-motion`, a drag with the transitions removed still reorders (the caret
 *     jumps, the drop lands); skipped with a note where it is not reflected.
 *  5. REORDER (dark): the lift and the drop mark once more under the dark scheme – stills.
 *
 * Nightly: the `tablet` shard (`.github/nightly-drivers/tablet-tab-drag.json`). See
 * [GroupsDemoBase] and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabletTabDragDemo : GroupsDemoBase("tablet-tab-drag", "tablet-tab-drag-demo") {
    override val tag = "TabletTabDragDemo"
    override val findingsFile = "tablet-tab-drag-findings.txt"
    override val title = "Zenium Android tablet sidebar: a finger's tab drag – the lift, the drop mark, the edge auto-scroll (TABLET-03)"

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        ensureForeground()
        head()
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}")
        check("the sidebar is docked expanded at 1280 wide", awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000), "data-sidebar ${jsText("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar")}")
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu off camera (the emulator compiles and lays
        // it out slowly the first time): the app menu, opened and closed by the system back.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_200)
        finding("warm-up done: ${describeSpace()}; rows ${rowIds()}")
    }

    override fun demo() {
        try {
            reorder("light", "1", GAMMA, DELTA)
            autoscroll()
            groups()
            reducedMotion()
            dark()
            reorder("dark", "5", GAMMA, DELTA)
        } finally {
            shellCommand("settings put global animator_duration_scale 1")
            shellCommand("cmd uimode night no")
        }
        SystemClock.sleep(1_000)
        still("end")
        tail()
    }

    // --- 1 / 5. the reorder ------------------------------------------------------------------------

    /**
     * Lift `movedId` by a hold, carry it across `targetId`'s row – to the lower half when it
     * stands above the target (the slot after it), to the upper half when below (the slot before
     * it), so the slot is never its own – read the drop mark, release, and read the core's track.
     * Stills of the lifted row and the drop mark for the scheme.
     */
    private fun reorder(scheme: String, act: String, movedId: String, targetId: String) {
        val before = trackOrder().map { it.first }
        val after = before.indexOf(movedId) < before.indexOf(targetId)
        section("$act. REORDER ($scheme): a hold lifts ${titleOf(movedId)}, the finger carries it ${if (after) "below" else "above"} ${titleOf(targetId)}, the release lands it there")
        finding("  track before: ${before.map { titleOf(it) }}")
        val held = lift(movedId) ?: return
        SystemClock.sleep(500)
        readLift(movedId)
        finding("  ${awaitChromePaint()}")
        still("lifted-$scheme")
        val target = domRect(row(targetId))
        if (target == null) {
            check("the target row ${titleOf(targetId)} is there", false, "")
            held.finger.up()
            awaitDomGone(GHOST, 3_000)
            return
        }
        val expectedKey = "tab:$targetId:${if (after) "after" else "before"}"
        carry(held, target.left + target.width() / 2, if (after) target.bottom - target.height() / 4 else target.top + target.height() / 4)
        check("the drop store names the slot ${if (after) "after" else "before"} ${titleOf(targetId)}", awaitJs("window.__zenStores.drop.get().key===${JSONObject.quote(expectedKey)}", true, 3_000), "key ${dropKey()}")
        // The snappy spring lands well within the second: the rows and the caret at rest for the read.
        SystemClock.sleep(600)
        readDropMark(movedId, targetId, target)
        finding("  ${awaitChromePaint()}")
        still("drop-mark-$scheme")
        held.finger.up()
        val moved = awaitCore(6_000) { state ->
            val order = trackOrder(state).map { it.first }
            val i = order.indexOf(movedId)
            val j = order.indexOf(targetId)
            i >= 0 && j >= 0 && (if (after) i == j + 1 else i == j - 1)
        }
        check("the release puts ${titleOf(movedId)} ${if (after) "after" else "before"} ${titleOf(targetId)} in the core's track", moved, "track ${trackOrder().map { titleOf(it.first) }}")
        check("the ghost goes and the row is back in the list", awaitDomGone(GHOST, 3_000) && awaitDomGone("${row(movedId)}[data-lifted]", 3_000), "ghost ${inDom(GHOST)}, lifted ${inDom("${row(movedId)}[data-lifted]")}")
        SystemClock.sleep(700)
        if (scheme == "light") still("dropped-$scheme")
        finding("  track after: ${trackOrder().map { titleOf(it.first) }}")
    }

    // --- 2. the edge auto-scroll -------------------------------------------------------------------

    private fun autoscroll() {
        section("2. AUTO-SCROLL: a plain swipe scrolls the list and lifts nothing; a lifted row held in the finger's 56 px band (the mouse's is 32) at either edge has the list scroll under it")
        // Extra tabs off camera until the list has room enough under its box for a speed reading
        // (they load gamma.html and wear its title).
        val extra = ArrayList<String>()
        var n = 0
        while (n < MAX_EXTRA && scrollRoom() < ROOM_MIN) {
            n++
            val id = "tab_fill_$n"
            coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN/gamma.html")},\"active\":false,\"id\":${JSONObject.quote(id)}}")
            extra += id
            awaitDom(row(id), 3_000)
            SystemClock.sleep(120)
        }
        awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollHeight-s.clientHeight>1})()", true, 3_000)
        SystemClock.sleep(900)
        finding("  ${extra.size} tabs opened off camera; the scroller ${scrollerText()}")
        check("the list overflows its box", overflows(), scrollerText())
        val list = domRect(SCROLLER)
        val target = screen(list)?.let { touchPoint(it) }
        if (list == null || target == null) {
            check("the list is on screen to swipe", false, "list $list")
        } else {
            // The plain drag: a finger that moves before the hold is up is the list's scroll.
            finding("  swipe up from ${target.x.roundToInt()},${(target.y + 120).roundToInt()} on the list")
            val f = Finger()
            f.down(target.x, target.y + 120)
            f.moveBy(0f, -240f, 320)
            val liftedMidSwipe = inDom(GHOST) || inDom("$ROWS[data-lifted]")
            f.up()
            check("the swipe scrolls the list", awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop>1})()", true, 3_000), scrollerText())
            check("a plain drag lifts no row: no ghost, no lifted row, during or after", !liftedMidSwipe && !inDom(GHOST) && !inDom("$ROWS[data-lifted]"), "mid-swipe $liftedMidSwipe, ghost ${inDom(GHOST)}")
            SystemClock.sleep(900)
            autoscrollTop(list)
            autoscrollBottom(list)
        }
        SystemClock.sleep(400)
        coreInvoke("tab.closeMany", "{\"tabIds\":[${extra.joinToString(",") { JSONObject.quote(it) }}]}")
        check("the extra tabs close off camera", awaitCore(12_000) { state -> extra.none { tabExists(it, state) } } && awaitUntil(6_000) { extra.none { inDom(row(it)) } }, "left ${extra.filter { inDom(row(it)) }}")
        awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop<1})()", true, 4_000)
        SystemClock.sleep(800)
        finding("  after the act: ${describeSpace()}")
    }

    /**
     * The TOP band, as today: a row near the foot lifted and held 12 px under the list's top edge
     * scrolls the list up to its top – where the seeded list's first item is the Research header,
     * so the finger comes to stand over an into-target: the caret stands down and the release
     * joins the group (the first run's reading; the slot drop is the bottom band's, below).
     */
    private fun autoscrollTop(list: RectF) {
        val s0 = scrollTop()
        val ids = rowIds()
        val id = ids.lastOrNull { rid ->
            rid != activeTabId() && domRect(row(rid))?.let { it.bottom <= list.bottom - 8 && it.top >= list.top + 8 } == true
        }
        if (id == null) {
            check("a row is in view to lift near the foot", false, "rows ${ids.size}")
            return
        }
        val held = lift(id) ?: return
        SystemClock.sleep(300)
        val start = domRect(row(id))
        val x = (start?.left ?: list.left) + list.width() / 2
        carry(held, x, list.top + 12f, 500)
        val t0 = SystemClock.uptimeMillis()
        val moving = awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop<${s0 - 4}})()", true, 3_000)
        val atTop = awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop<1})()", true, 5_000)
        val t1 = SystemClock.uptimeMillis()
        check("held still in the top band, the list scrolls up under the lifted row to its top", moving && atTop, "scrollTop $s0 -> ${scrollTop()} in ${t1 - t0} ms")
        SystemClock.sleep(STEADY_MS)
        val key = dropKey()
        val caretShown = jsText("(function(){var c=document.querySelector(${JSONObject.quote(CARET)});return c?c.style.opacity:''})()") == "1"
        check("at the top the finger stands over the Research header: the drop store names the group and the caret stands down (the into-target, as today)", key == "folder:$FOLDER" && !caretShown && inDom("$GROUP_ROW[data-drop-into]"), "key $key, caret shown $caretShown, header into ${inDom("$GROUP_ROW[data-drop-into]")}")
        held.finger.up()
        check("the release over the header joins the row to Research (as today)", awaitCore(6_000) { state -> folderOf(id, state) == FOLDER }, "folder ${folderOf(id)}")
        check("the ghost goes and the row is back in the list", awaitDomGone(GHOST, 3_000) && awaitDomGone("${row(id)}[data-lifted]", 3_000), "")
        SystemClock.sleep(600)
    }

    /**
     * The BOTTOM band, the slot drop: Delta lifted from near the head and held 12 px over the
     * list's bottom edge scrolls the list down under it – the speed read on the page's own clock
     * over the first stretch (the ramp at 12 px into the finger's 56 px band: 14 × 44 / 56 = 11 px
     * per 60 Hz frame, 660 px/s at any refresh rate for a finger) – to its foot, where the finger stands over the
     * last rows: the drop store names a slot, the caret stands in the gap – still; the release
     * lands Delta further down the track.
     */
    private fun autoscrollBottom(list: RectF) {
        val orderBefore = trackOrder().map { it.first }
        val held = lift(DELTA) ?: return
        SystemClock.sleep(300)
        val start = domRect(row(DELTA))
        val x = (start?.left ?: list.left) + list.width() / 2
        carry(held, x, list.bottom - 12f, 500, settle = false)
        jsText("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});window.__zenW6S25a={t:performance.now(),s:s?s.scrollTop:0};return 'marked'})()")
        SystemClock.sleep(220)
        val reading = jsText("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});var a=window.__zenW6S25a||{t:0,s:0};return s?(s.scrollTop-a.s)+'|'+(performance.now()-a.t):''})()").split('|')
        val dy = reading.getOrNull(0)?.toDoubleOrNull()
        val dt = reading.getOrNull(1)?.toDoubleOrNull()
        check("held still in the bottom band, the list scrolls down under the lifted row", dy != null && dy > 4, "scrolled $dy px in $dt ms")
        if (dy != null && dt != null && dt > 0) finding("  the band's speed 12 px in, as the emulator ran it: ${(dy * 1000.0 / dt).roundToInt()} px/s over ${dt.roundToInt()} ms (the ramp's target at 12 px into the finger's 56 px band: 660 px/s – 14 px per 60 Hz frame at the edge, 11 at 12 px, scaled to the frame's real length for a finger, a late tick counting for the springs' 64 ms clamp at most)")
        val atFoot = awaitJs("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop>=s.scrollHeight-s.clientHeight-1})()", true, 6_000)
        finding("  the list at its foot: $atFoot (${scrollerText()})")
        SystemClock.sleep(STEADY_MS)
        val key = dropKey()
        val caret = jsText("(function(){var c=document.querySelector(${JSONObject.quote(CARET)});return c?c.style.opacity+' '+c.style.transform:''})()")
        check("at the foot the finger stands over the last rows: the drop store names a slot and the caret stands in the list", key.startsWith("tab:") && caret.startsWith("1 "), "key $key, caret $caret")
        still("autoscroll-light")
        held.finger.up()
        val movedDown = awaitCore(6_000) { state ->
            val order = trackOrder(state).map { it.first }
            order.indexOf(DELTA) > orderBefore.indexOf(DELTA)
        }
        check("the release lands Delta further down the track, where the caret was", movedDown, "index ${orderBefore.indexOf(DELTA)} -> ${trackOrder().map { it.first }.indexOf(DELTA)}")
        check("the ghost goes and the row is back in the list", awaitDomGone(GHOST, 3_000) && awaitDomGone("${row(DELTA)}[data-lifted]", 3_000), "")
    }

    // --- 3. groups -------------------------------------------------------------------------------------

    private fun groups() {
        section("3. GROUPS (as today): Gamma onto the Research header joins the group; out of the fold to Delta's lower half leaves it")
        val header = domRect(GROUP_ROW)
        if (header == null || folderCollapsed()) {
            check("the Research header row is there and the group open", false, "header $header, collapsed ${folderCollapsed()}")
            return
        }
        val held = lift(GAMMA) ?: return
        SystemClock.sleep(300)
        carry(held, header.left + header.width() / 2, header.top + header.height() / 2)
        check("over the header the drop store names the group", awaitJs("window.__zenStores.drop.get().key===${JSONObject.quote("folder:$FOLDER")}", true, 3_000), "key ${dropKey()}")
        check("the header is the into-target and the ghost thins over it", awaitDom("$GROUP_ROW[data-drop-into]", 2_000) && awaitDom(".zen-tab-ghost[data-into]", 2_000), "header into ${inDom("$GROUP_ROW[data-drop-into]")}, ghost into ${inDom(".zen-tab-ghost[data-into]")}")
        SystemClock.sleep(300)
        held.finger.up()
        check("the release puts Gamma in Research", awaitCore(6_000) { state -> folderOf(GAMMA, state) == FOLDER }, "folder ${folderOf(GAMMA)}; ${describeSpace()}")
        check("the ghost goes", awaitDomGone(GHOST, 3_000), "")
        SystemClock.sleep(800)
        val delta = domRect(row(DELTA))
        if (delta == null) {
            check("Delta's row is there to drag beside", false, "")
            return
        }
        val held2 = lift(GAMMA) ?: return
        SystemClock.sleep(300)
        carry(held2, delta.left + delta.width() / 2, delta.bottom - delta.height() / 4)
        check("beside a loose row the drop store names the slot after Delta", awaitJs("window.__zenStores.drop.get().key===${JSONObject.quote("tab:$DELTA:after")}", true, 3_000), "key ${dropKey()}")
        SystemClock.sleep(300)
        held2.finger.up()
        check("the release takes Gamma out of Research, after Delta", awaitCore(6_000) { state -> folderOf(GAMMA, state) == null && trackOrder(state).map { it.first }.let { it.indexOf(GAMMA) == it.indexOf(DELTA) + 1 } }, "folder ${folderOf(GAMMA)}; ${describeSpace()}")
        check("the ghost goes", awaitDomGone(GHOST, 3_000), "")
        SystemClock.sleep(800)
    }

    // --- 4. reduced motion ---------------------------------------------------------------------------

    private fun reducedMotion() {
        section("4. REDUCED MOTION: the transitions removed, the drag still reorders")
        shellCommand("settings put global animator_duration_scale 0")
        val reflected = awaitJs("matchMedia('(prefers-reduced-motion: reduce)').matches", true, 4_000)
        if (!reflected) {
            finding("  (this WebView does not reflect animator_duration_scale 0 as prefers-reduced-motion: the reduced path is pinned by dragAutoscroll.test.ts; scene skipped)")
            shellCommand("settings put global animator_duration_scale 1")
            return
        }
        val held = lift(DELTA) ?: run {
            shellCommand("settings put global animator_duration_scale 1")
            return
        }
        SystemClock.sleep(300)
        val transition = jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).transitionProperty:''})()")
        check("the ghost mounts lifted with its transition removed (the one global rule)", transition == "none", "transition-property '$transition'")
        val gamma = domRect(row(GAMMA))
        if (gamma != null) {
            carry(held, gamma.left + gamma.width() / 2, gamma.bottom - gamma.height() / 4)
            check("the caret is in the gap at once", awaitJs("(function(){var c=document.querySelector(${JSONObject.quote(CARET)});return !!c&&c.style.opacity==='1'})()", true, 2_000), "key ${dropKey()}")
        }
        held.finger.up()
        check("the release reorders under reduced motion: Delta after Gamma", awaitCore(6_000) { state -> trackOrder(state).map { it.first }.let { it.indexOf(DELTA) == it.indexOf(GAMMA) + 1 } }, "track ${trackOrder().map { titleOf(it.first) }}")
        check("the ghost goes", awaitDomGone(GHOST, 3_000), "")
        shellCommand("settings put global animator_duration_scale 1")
        check("the preference goes with the setting", awaitJs("matchMedia('(prefers-reduced-motion: reduce)').matches", false, 4_000), "")
        SystemClock.sleep(600)
    }

    // --- the finger ----------------------------------------------------------------------------------

    /** A finger down on the screen at `x`, `y` (screen px), the row it lifted in its hand. */
    private inner class Held(val finger: Finger, var x: Float, var y: Float)

    /** A hold on `tabId`'s row until the ghost stands; the finger, still down, or null with a FAIL. */
    private fun lift(tabId: String): Held? {
        val box = steadyRect { domRect(row(tabId)) }
        val target = screen(box)?.let { touchPoint(it) }
        if (target == null) {
            check("${titleOf(tabId)}'s row is on screen to hold", false, "row $box")
            return null
        }
        finding("  hold at ${target.x.roundToInt()},${target.y.roundToInt()} on ${titleOf(tabId)}'s row")
        val f = Finger()
        f.press(target.x, target.y)
        val ghost = awaitRect(3_000) { domRect(GHOST) }
        val lifted = ghost != null && inDom("${row(tabId)}[data-lifted]")
        check("the hold lifts the row: its ghost stands off the list, the row a hole", lifted, "ghost $ghost, lifted ${inDom("${row(tabId)}[data-lifted]")}")
        if (!lifted) {
            f.up()
            return null
        }
        return Held(f, target.x, target.y)
    }

    /**
     * Carry the held finger from where it is to the CSS point `x`, `y` over `durationMs`, then
     * let the chrome settle – unless `settle` is off, for a reading taken while the list still
     * moves under the finger.
     */
    private fun carry(held: Held, x: Float, y: Float, durationMs: Long = 400, settle: Boolean = true) {
        val to = screen(RectF(x, y, x, y)) ?: return
        finding("  carry to ${to.left},${to.top} (css ${x.roundToInt()},${y.roundToInt()})")
        held.finger.moveBy(to.left - held.x, to.top - held.y, durationMs)
        held.x = to.left.toFloat()
        held.y = to.top.toFloat()
        if (settle) SystemClock.sleep(STEADY_MS)
    }

    private fun readLift(tabId: String) {
        val transform = jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).transform:''})()")
        val shadow = jsText("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).boxShadow:''})()")
        val opacity = jsNumber("(function(){var g=document.querySelector(${JSONObject.quote(GHOST)});return g?getComputedStyle(g).opacity:NaN})()")
        check("the ghost is at scale 1.02", transform.startsWith("matrix(1.02, 0, 0, 1.02"), "transform '$transform'")
        check("the ghost casts the level-2 shadow at 90 %", shadow.isNotEmpty() && shadow != "none" && abs(opacity - 0.9) < 0.02, "box-shadow '$shadow', opacity $opacity")
        check("the row's own box is a hole (opacity 0) under the ghost", jsNumber("(function(){var r=document.querySelector(${JSONObject.quote(row(tabId))});return r?getComputedStyle(r).opacity:NaN})()") == 0.0, "")
        check("the list does not scroll under the held finger", jsBoolean("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollTop<1})()"), scrollerText())
    }

    /**
     * The drop mark, §9.4: the caret 2 px tall, inset 8 from the row's ends, at the centre of the
     * row-tall gap that opens where `targetId` stood – the target slides a pitch towards the hole
     * the lifted row left (up when the hole is above it, down when below) and its old box is the
     * gap the row will land in.
     */
    private fun readDropMark(movedId: String, targetId: String, target: RectF) {
        val movedBox = domRect(row(movedId))
        val caret = jsText("(function(){var c=document.querySelector(${JSONObject.quote(CARET)});if(!c)return '';var s=c.style;return [s.opacity,s.left,s.width,s.height,s.transform].join('|')})()")
        val parts = caret.split('|')
        val shown = parts.size == 5 && parts[0] == "1"
        check("the caret is shown, 2 px tall", shown && parts[3] == "2px", "caret '$caret'")
        val left = parts.getOrNull(1)?.removeSuffix("px")?.toDoubleOrNull()
        val width = parts.getOrNull(2)?.removeSuffix("px")?.toDoubleOrNull()
        check("the caret is inset 8 from the row's ends", movedBox != null && left != null && width != null && abs(left - (movedBox.left + 8)) <= 1.5 && abs(width - (movedBox.width() - 16)) <= 2, "left $left, width $width, row $movedBox")
        val y = Regex("""translate3d\(0(?:px)?, (-?[0-9.]+)px, 0(?:px)?\)""").find(parts.getOrNull(4).orEmpty())?.groupValues?.get(1)?.toDoubleOrNull()
        val gapCentre = target.centerY().toDouble()
        check("the caret glides to the centre of the gap that opened where ${titleOf(targetId)} stood", y != null && abs((y + 1) - gapCentre) <= 6, "caret y ${y?.plus(1)}, gap centre $gapCentre")
        val slid = translationOf(row(targetId))
        val towardsHole = movedBox != null && slid != null && ((movedBox.top < target.top && slid < 0) || (movedBox.top > target.top && slid > 0))
        check("${titleOf(targetId)}'s row slides a pitch towards the hole to open the gap", slid != null && abs(abs(slid) - PITCH) <= 2 && towardsHole, "translateY $slid, hole at ${movedBox?.top}, target at ${target.top}")
    }

    // --- the scheme ----------------------------------------------------------------------------------

    private fun dark() {
        ensureForeground()
        shellCommand("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        finding("  the chrome's scheme now: ${jsText("document.documentElement.getAttribute('data-theme')||'light'")}")
    }

    // --- reads of the list ---------------------------------------------------------------------------

    private fun rowIds(): List<String> =
        jsArray("Array.prototype.map.call(document.querySelectorAll(${JSONObject.quote(ROWS)}),function(r){return r.dataset.tabId})").strings()

    private fun dropKey(): String = jsText("window.__zenStores.drop.get().key")

    private fun scrollTop(): Double = jsNumber("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?s.scrollTop:NaN})()")

    private fun overflows(): Boolean =
        jsBoolean("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return !!s&&s.scrollHeight-s.clientHeight>1})()")

    /** How far the list can scroll: its content past its box, in px (0 when it fits). */
    private fun scrollRoom(): Double =
        jsNumber("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?Math.max(0,s.scrollHeight-s.clientHeight):0})()")

    private fun scrollerText(): String =
        jsText("(function(){var s=document.querySelector(${JSONObject.quote(SCROLLER)});return s?'scrollTop '+s.scrollTop+', scrollHeight '+s.scrollHeight+', clientHeight '+s.clientHeight:'no scroller'})()")

    /** The element's inline `translateY`, in px; null when it wears none. */
    private fun translationOf(selector: String): Double? {
        val t = jsText("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.style.transform:''})()")
        val m = Regex("""translateY\((-?[0-9.]+)px\)""").find(t) ?: return null
        return m.groupValues[1].toDoubleOrNull()
    }

    private fun titleOf(tabId: String): String =
        coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title")?.takeIf { it.isNotEmpty() } ?: tabId

    companion object {
        /** The rows' pitch: the 44 row and the list's 2 px gap. */
        private const val PITCH = 46.0
        /** The extra tabs the auto-scroll act may open, and the room under the box they must buy. */
        private const val MAX_EXTRA = 18
        private const val ROOM_MIN = 280.0
        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val PANEL = "$SIDEBAR [data-tab-panel][data-active=\"true\"]"
        private const val SCROLLER = "$PANEL > [data-tab-scroller]"
        private const val ROWS = "$SCROLLER .zen-tab[data-tab-id]"
        private const val GROUP_ROW = "$SIDEBAR .zen-group-row[data-tab-folder=\"$FOLDER\"]"
        private const val GHOST = ".zen-tab-ghost .zen-tab-ghost-row"
        private const val CARET = ".zen-tab-caret"

        private fun row(tabId: String) = "$SIDEBAR .zen-tab[data-tab-id=\"$tabId\"]"
    }
}
