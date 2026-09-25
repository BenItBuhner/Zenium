package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * Records the phone app menu's edit mode – Edge's Change menu (matrix TB-22) and its motion
 * (MOT-23): the sheet's last row, "Change Menu", opens the pose in place with the same items,
 * glyphs and labels made reorderable, a Done control in the header and a Reset row; a finger
 * held on an item lifts it (scale 1.02, the level 2 shadow, 90 %), dragged over two siblings
 * moves it while they glide aside, and dropped lets it settle; Done saves the order as
 * `settings.menuOrder`, which the next opening reads; Reset puts the default back. Every step
 * is a real touch (the REAL TOUCH RULE) but the reader's route, which is the accessibility
 * tree's own: under touch exploration each item carries its place in its name and is followed
 * by Move up / Move down / Move to start controls, and a move is read back through the live
 * region (A11Y-10, §10.3).
 *
 * The motion is read two ways. The icon row's drag runs under a frame-by-frame sampler in the
 * chrome ([SAMPLER]: the item in the hand, its scale, the siblings' FLIP transforms and the
 * order, once per animation frame) and the sequence lift → glide → drop → settle is judged off
 * the samples. The list's drag runs under [traceFrames] instead, with nothing else on the
 * thread, for RULING 5's reading: the reorder's frames within the spring budget and no long
 * task by CPU (the startup sweeps held by `-e holdBackgroundWork true`, as the workflow passes).
 *
 * Driven by the `android-menu-edit-demo` workflow, once per colour scheme (the `theme`
 * instrumentation argument seeds the profile and the device's night mode alike; the nightly
 * runs light). See [DemoHarness] for the plumbing. Findings land in `menu-edit-findings.txt`
 * next to the stills (one PASS or FAIL per claim, ALL CHECKS PASSED at the end); the run fails
 * on any FAIL. Profile `history-bookmarks-demo-state.json` with its tabs pointed at the
 * loopback pages, so nothing depends on the network.
 */
@RunWith(AndroidJUnit4::class)
class MenuEditDemo : DemoHarness(
    "history-bookmarks-demo-state.json",
    "menu-edit",
    "menu-edit-demo",
    UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
) {
    override val tag = "MenuEditDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    /** The build's default order as the fresh profile shows it, read in the first scene: the row's labels and the list's. */
    private var defaultRow: List<String> = emptyList()
    private var defaultList: List<String> = emptyList()

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(FIRST_TITLE, "<p>The first page: the menu opens on it.</p>"),
                "/second.html" to DemoServer.page(SECOND_TITLE, "<p>The other tab's page.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            shell("cmd uimode night no")
        }
        if (failures > 0) error("$failures check(s) failed; see menu-edit-findings.txt")
    }

    // --- seed ------------------------------------------------------------------------------------

    /** The seeded tabs point at the loopback pages; the colour scheme is the run's theme. */
    override fun patchState(json: String): String =
        json
            .replace("https://example.com/", "$ORIGIN/")
            .replace("\"Example Domain\"", "\"$FIRST_TITLE\"")
            .replace("https://en.wikipedia.org/wiki/Coffee", "$ORIGIN/second.html")
            .replace("\"Coffee - Wikipedia\"", "\"$SECOND_TITLE\"")
            .replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    /** The device's night mode follows the theme, so the system bars and the chrome agree. */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (theme == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    // --- sequence --------------------------------------------------------------------------------

    /** Let the page come up, install the sampler, then open and close the menu once off camera. */
    override fun warmUp() {
        findings = File(out, "menu-edit-findings.txt")
        findings.writeText(
            "Zenium Android app menu edit mode checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, theme $theme; " +
                "jank gate ${jankGate.key}; startup sweeps held=$holdBackgroundWork)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitActive("$ORIGIN/")
        chromeJs(SAMPLER)
        if (openMenu()) {
            SystemClock.sleep(1_000)
            closeMenu()
        }
        SystemClock.sleep(1_500)
        finding("start: active ${activeCoreTab()?.optString("url")}, menuOrder ${menuOrderSetting()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        enter()
        dragRow()
        dragList()
        reader()
        reset()
        finding("")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // 1. Change Menu is the sheet's last row; a touch opens the edit pose in place with the same
    // items in the same order, each named with its place; Done with nothing moved writes nothing.
    private fun enter() {
        finding("\n1. Change Menu opens the edit pose in place")
        record("the menu opened", openMenu())
        defaultRow = iconRowLabels()
        defaultList = listLabels()
        finding("the normal pose: row ${defaultRow.joinToString(" | ")}; list ${defaultList.joinToString(" | ")}")
        record("the icon row is Chrome's six (${defaultRow.size})", defaultRow.size == 6)
        record("'$LABEL_CHANGE' is the sheet's last row, in a group of its own", defaultList.lastOrNull() == LABEL_CHANGE && listGroupSizes().lastOrNull() == 1)
        val url = activeCoreTab()?.optString("url")
        record("the pose opened on a real touch", enterEdit())
        record("the sheet stayed up and no pick reached the core (surface ${chromeSurfaceUp()}, page ${activeCoreTab()?.optString("url")})", chromeSurfaceUp() && activeCoreTab()?.optString("url") == url)
        record("the title reads '$TITLE_EDIT' ('${title()}')", title() == TITLE_EDIT)
        val done = doneBox()
        record(
            "Done stands in the header's trailing slot, at least 44 tall (CSS px ${done?.optDouble("w")}x${done?.optDouble("h")}, right edge at ${done?.optDouble("right")} of ${done?.optDouble("sheetRight")})",
            done != null && done.optDouble("h") >= 44 - 0.5 && done.optDouble("w") >= 44 - 0.5 && done.optDouble("sheetRight") - done.optDouble("right") <= 16
        )
        record("Done is a button in the tree", findNode { it == LABEL_DONE }?.isClickable == true)
        val items = editItems()
        val row = items.filter { it.optString("section") == SECTION_ROW }.map { it.optString("label") }
        val list = items.filter { it.optString("section") == SECTION_LIST }.map { it.optString("label") }
        finding("the edit pose: row ${row.joinToString(" | ")}; list ${list.joinToString(" | ")}")
        record("the row's items are the icon row's, in order", row == defaultRow)
        record("the list's items are the sheet's rows less Change Menu, in order (the pose changes no membership)", list == defaultList.dropLast(1))
        record(
            "every item is named with its place among its section's rows ('${items.firstOrNull()?.optString("name")}' … '${items.lastOrNull()?.optString("name")}')",
            items.isNotEmpty() && items.all { PLACE.matches(it.optString("name")) } && placesRun(items.filter { it.optString("section") == SECTION_ROW }) && placesRun(items.filter { it.optString("section") == SECTION_LIST })
        )
        record("the row's items keep the 44 x 44 box (§9.3)", items.filter { it.optString("section") == SECTION_ROW }.all { near(it.optDouble("w"), 44.0) && near(it.optDouble("h"), 44.0) })
        record("the list's rows are at least 44 tall (§10.3)", items.filter { it.optString("section") == SECTION_LIST }.all { it.optDouble("h") >= 44 - 0.5 })
        val resetNode = findNode { it == LABEL_RESET }
        record("Reset to Default is disabled at the default order (§9.30)", resetNode != null && !resetNode.isEnabled)
        reveal(items.first().optString("name"))
        SystemClock.sleep(800)
        still("edit")
        record("Done with nothing moved returns the normal pose", touchTapLabelExpecting(LABEL_DONE, "the normal pose is back", 6_000) { !editUp() && menuOpen() })
        SystemClock.sleep(800)
        record("nothing was written (menuOrder ${menuOrderSetting()})", menuOrderSetting() == null)
        record("the normal pose's names are as they were", iconRowLabels() == defaultRow && listLabels() == defaultList)
        closeMenu()
    }

    // 2. The icon row: a hold lifts the star, a drag over two siblings moves it while they glide
    // aside, the drop settles; Done saves the order and the next opening shows it (MOT-23, TB-22).
    private fun dragRow() {
        finding("\n2. The icon row: hold, drag over two siblings, drop, Done")
        record("the menu opened", openMenu())
        record("the pose opened", enterEdit())
        val items = editItems()
        val star = items.firstOrNull { it.optString("key") == KEY_STAR }
        val first = items.firstOrNull { it.optString("section") == SECTION_ROW }
        val starIndex = items.filter { it.optString("section") == SECTION_ROW }.indexOfFirst { it.optString("key") == KEY_STAR }
        if (star == null || first == null || starIndex < 2) {
            record("the star stands third or later in the row to drag over two siblings (at ${starIndex + 1})", false)
            leaveEdit()
            return
        }
        reveal(first.optString("name"))
        val from = stableBounds(star.optString("name"))
        val to = stableBounds(first.optString("name"))
        if (from == null || to == null) {
            record("the star and the row's first item on screen to drag between", false)
            leaveEdit()
            return
        }
        val rowBefore = items.filter { it.optString("section") == SECTION_ROW }.map { it.optString("key") }
        chromeJs("window.__menuEditStart(${JSONObject.quote(SECTION_ROW)})")
        val f = Finger()
        f.down(from.exactCenterX(), from.exactCenterY())
        f.hold(HOLD_MS)
        val held = awaitLift()
        finding("held after $HOLD_MS ms and the lift's ease: $held")
        record("the hold lifted the star: its cell carries data-held", held?.optString("key") == KEY_STAR)
        record(
            "the lifted item is at scale 1.02 (${held?.optDouble("scale")}), with the level 2 shadow and 90 % opacity (${held?.optString("opacity")}) on the panel colour (§9.4)",
            held != null && near(held.optDouble("scale"), 1.02, 0.006) && held.optString("shadow") != "none" && near(held.optString("opacity").toDoubleOrNull() ?: 0.0, 0.9, 0.02)
        )
        still("lifted")
        // Two slots left, along the row's axis; the finger rests a moment on the slot, then lets go.
        travel(f, to.exactCenterX() - from.exactCenterX(), 0f)
        f.hold(REST_MS)
        f.up()
        val landed = awaitTrue(5_000) { heldState() == null }
        SystemClock.sleep(400)
        still("dropped")
        val samples = samples()
        val rowAfter = editItems().filter { it.optString("section") == SECTION_ROW }.map { it.optString("key") }
        val expected = moved(rowBefore, KEY_STAR, 0)
        finding("the row: ${rowBefore.joinToString(" ")} -> ${rowAfter.joinToString(" ")}")
        record("the drop landed: the hand is empty and nothing is left transformed (landed $landed; ${transformedCount()} transformed)", landed && transformedCount() == 0)
        record("the star took the first slot, past two siblings", rowAfter == expected)
        judgeSequence(samples, KEY_STAR, expected)
        record("Done returns the normal pose", touchTapLabelExpecting(LABEL_DONE, "the normal pose is back", 6_000) { !editUp() && menuOpen() })
        SystemClock.sleep(800)
        val rowLabels = iconRowLabels()
        val order = menuOrderSetting()
        finding("after Done: row ${rowLabels.joinToString(" | ")}; menuOrder $order")
        record("the normal pose draws the row in the new order (the star first)", rowLabels == moved(defaultRow, LABEL_STAR, 0))
        record("settings.menuOrder was saved, the star's key first", order != null && order.length() > 0 && order.optString(0) == KEY_STAR)
        still("after-done")
        closeMenu()
        record("the menu opened again", openMenu())
        record("the next opening reads the saved order (descriptor read): ${iconRowLabels().joinToString(" | ")}", iconRowLabels() == moved(defaultRow, LABEL_STAR, 0))
        still("reopened")
        closeMenu()
    }

    // 3. The list: History dragged two rows up, across the hairline into the group above; the
    // scene under the trace for RULING 5 (within the spring budget, no long task by CPU).
    private fun dragList() {
        finding("\n3. The list: History over two rows and a hairline, under the trace (RULING 5)")
        record("the menu opened", openMenu())
        record("the pose opened", enterEdit())
        val rows = editItems().filter { it.optString("section") == SECTION_LIST }
        val history = rows.indexOfFirst { it.optString("key") == KEY_HISTORY }
        if (history < 2) {
            record("History stands third or later in the list to drag over two rows (at ${history + 1})", false)
            leaveEdit()
            return
        }
        val target = rows[history - 2]
        val groupsBefore = groupOf(KEY_HISTORY)
        reveal(target.optString("name"))
        val from = stableBounds(rows[history].optString("name"))
        val to = stableBounds(target.optString("name"))
        if (from == null || to == null) {
            record("History and the row two above it on screen to drag between", false)
            leaveEdit()
            return
        }
        val before = rows.map { it.optString("key") }
        val scene = traceFrames(SCENE_LIST, JankBudget.Kind.SPRING) {
            val f = Finger()
            f.down(from.exactCenterX(), from.exactCenterY())
            // Nothing read inside the measured block: the hold is given the lift's time outright.
            f.hold(TRACED_HOLD_MS)
            travel(f, 0f, to.exactCenterY() - from.exactCenterY())
            f.hold(REST_MS)
            f.up()
            SystemClock.sleep(LANDING_MS)
        }
        val landed = awaitTrue(5_000) { heldState() == null }
        SystemClock.sleep(400)
        still("list-dropped")
        val after = editItems().filter { it.optString("section") == SECTION_LIST }.map { it.optString("key") }
        val groupsAfter = groupOf(KEY_HISTORY)
        finding("the list: ${before.joinToString(" ")} -> ${after.joinToString(" ")}; History's group $groupsBefore -> $groupsAfter")
        record("the drop landed (landed $landed; ${transformedCount()} transformed)", landed && transformedCount() == 0)
        record("History moved two rows up, into the slot of the row it was dragged onto", after == moved(before, KEY_HISTORY, history - 2))
        record("History crossed a hairline into the group above", groupsAfter < groupsBefore)
        val trace = scene.trace
        val longTasks = when {
            trace == null -> "no trace (${scene.traceMissing})"
            trace.longestTaskCpuMs != null -> "${trace.longTasks} by CPU (tdur over 50 ms), ${trace.longTasksWall} by wall; the longest ${"%.1f".format(trace.longestTaskCpuMs)} ms on the CPU, ${"%.0f".format(trace.longestTaskMs)} ms of wall time"
            else -> "${trace.longTasks} (no thread times in the trace: the wall count; the longest ${"%.0f".format(trace.longestTaskMs)} ms)"
        }
        val summary = scene.summary
        finding(
            "frames ($SCENE_LIST, spring, ${scene.durationMs} ms): " +
                (summary?.let { "${it.frames} frames, ${it.janky} janky, p50 ${it.p50Ms} p90 ${it.p90Ms} p95 ${it.p95Ms} ms (the software GPU's numbers, reported)" } ?: "no HWUI summary") +
                "; ${trace?.describe() ?: "trace: none read (${scene.traceMissing})"}; ${scene.verdict.describe()}"
        )
        record("RULING 5: the reorder's frames are within the spring budget (${scene.verdict.describe()})", scene.verdict.within)
        record("RULING 5: no long task by CPU during the hold, the drag and the settle ($longTasks)", trace != null && trace.longTasks == 0)
        record("Done returns the normal pose", touchTapLabelExpecting(LABEL_DONE, "the normal pose is back", 6_000) { !editUp() && menuOpen() })
        SystemClock.sleep(800)
        val list = listLabels()
        val expectedLabels = moved(defaultList, LABEL_HISTORY, defaultList.indexOf(LABEL_HISTORY) - 2)
        finding("after Done: list ${list.joinToString(" | ")}; menuOrder ${menuOrderSetting()}")
        record("the normal pose draws the list in the new order, Change Menu still last", list == expectedLabels && list.lastOrNull() == LABEL_CHANGE)
        record("settings.menuOrder names History before the row it passed", menuOrderSetting()?.let { o -> indexIn(o, KEY_HISTORY) in 0 until indexIn(o, before[history - 2]) } == true)
        still("list-after-done")
        closeMenu()
    }

    // 4. The reader's route: under touch exploration each item is followed by Move up / Move down
    // / Move to start, a move is read back through the live region, and Done saves it (A11Y-10).
    private fun reader() {
        finding("\n4. Without the gesture: the Move controls under touch exploration")
        val manager = app.getSystemService(AccessibilityManager::class.java)
        setTouchExploration(true)
        try {
            val on = awaitTrue(8_000) { manager.isTouchExplorationEnabled }
            val heard = awaitTrue(8_000) { chromeAccessibilityState().optBoolean("touchExploration") }
            finding("touch exploration by UiAutomation's FLAG_REQUEST_TOUCH_EXPLORATION_MODE: manager $on; the chrome hears it $heard (${chromeAccessibilityState()})")
            record("touch exploration is on for the scene and the chrome hears it", on && heard)
            if (!(on && heard)) {
                finding("the reader's scene cannot run without the mode; the rest of it is skipped")
                return
            }
            record("the menu opened", openMenu())
            val withoutControls = findNodes { MOVE_UP.matches(it) }.size
            record("the pose opened", enterEdit())
            val items = editItems()
            record("under touch exploration the icon row's items are §10.3 rows in the pose too (list pose)", chromeJsString("(function(){var u=document.querySelector('[data-menu-edit] ul[aria-label=\"Page actions\"]');return u?u.className:''})()") == "zen-menu-icon-list")
            record("every item announces its name and place ('${items.firstOrNull()?.optString("name")}')", items.isNotEmpty() && items.all { PLACE.matches(it.optString("name")) })
            val listed = awaitTrue(10_000) { findNode { it == "Move $LABEL_HISTORY up" } != null && findNode { it == "Move $LABEL_HISTORY down" } != null && findNode { it == "Move $LABEL_HISTORY to start" } != null }
            record("each item is followed by Move up / Move down / Move to start controls in the tree (none before the mode: $withoutControls; History's three: $listed)", listed && withoutControls == 0)
            val firstRow = items.firstOrNull { it.optString("section") == SECTION_ROW }?.optString("label")
            val upOfFirst = firstRow?.let { findNode { n -> n == "Move $it up" } }
            record("the first item's Move up is disabled at the row's start ('Move $firstRow up' enabled ${upOfFirst?.isEnabled})", upOfFirst != null && !upOfFirst.isEnabled)
            val history = items.firstOrNull { it.optString("key") == KEY_HISTORY }
            val place = history?.let { PLACE.matchEntire(it.optString("name")) }
            val position = place?.groupValues?.get(2)?.toInt() ?: 0
            val count = place?.groupValues?.get(3)?.toInt() ?: 0
            // The slot above History – a row, or a hairline (then the move joins the group above
            // and its place among the rows stays) – is what the move passes and the save orders.
            val slots = listOrder()
            val above = slots.getOrNull(slots.indexOf(KEY_HISTORY) - 1)
            val aboveIsHairline = isHairline(above)
            val newPosition = if (aboveIsHairline) position else position - 1
            val expectedSentence =
                if (aboveIsHairline) "$LABEL_HISTORY moved to the group above, $newPosition of $count."
                else "$LABEL_HISTORY moved to $newPosition of $count."
            record("History has a slot above it to move into ('$above', at $position of $count)", above != null && position > 1)
            val control = findNode { it == "Move $LABEL_HISTORY up" }
            val clicked = control?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
            val movedUp = awaitTrue(6_000) { nameOf(KEY_HISTORY) == "$LABEL_HISTORY, $newPosition of $count" }
            val spoken = awaitTrue(4_000) { announcement() == expectedSentence }
            finding("Move History up: performed $clicked; History reads '${nameOf(KEY_HISTORY)}'; the live region says '${announcement()}'")
            record("ACTION_CLICK on 'Move History up' moved History one slot up (from '$position of $count')", clicked && movedUp)
            record("the live region read the move back ('$expectedSentence')", spoken)
            SystemClock.sleep(600)
            still("reader-moved")
            record("Done returns the normal pose", touchTapLabelExpecting(LABEL_DONE, "the normal pose is back", 6_000) { !editUp() && menuOpen() })
            SystemClock.sleep(800)
            val order = menuOrderSetting()
            val passed = above?.let { slotKey(it) }
            val at = order?.let { indexIn(it, KEY_HISTORY) } ?: -1
            val passedAt = if (order != null && passed != null) indexIn(order, passed) else -1
            record("Done saved the reader's move: History before the slot it passed ('$passed') in menuOrder $order", at >= 0 && passedAt >= 0 && at < passedAt)
            closeMenu()
        } finally {
            setTouchExploration(false)
            awaitTrue(6_000) { !manager.isTouchExplorationEnabled }
            SystemClock.sleep(800)
        }
    }

    // 5. Reset to Default puts the build's order back into the draft; Done saves it as the
    // setting's absence, and the normal pose is the default again.
    private fun reset() {
        finding("\n5. Reset to Default")
        record("the menu opened", openMenu())
        record("the pose opened", enterEdit())
        val resetNode = findNode { it == LABEL_RESET }
        record("Reset to Default is enabled while the order is not the default", resetNode?.isEnabled == true)
        reveal(LABEL_RESET)
        SystemClock.sleep(600)
        still("reset-row")
        val expectedList = defaultList.dropLast(1)
        record(
            "a touch on Reset put the default order back into the draft",
            touchTapLabelExpecting(LABEL_RESET, "the draft is the default order", 6_000) {
                val items = editItems()
                items.filter { it.optString("section") == SECTION_ROW }.map { it.optString("label") } == defaultRow &&
                    items.filter { it.optString("section") == SECTION_LIST }.map { it.optString("label") } == expectedList
            }
        )
        record("the live region says so ('${announcement()}')", awaitTrue(3_000) { announcement() == RESET_SENTENCE })
        record("Reset to Default is disabled again", awaitTrue(4_000) { findNode { it == LABEL_RESET }?.isEnabled == false })
        SystemClock.sleep(600)
        still("after-reset")
        record("Done returns the normal pose", touchTapLabelExpecting(LABEL_DONE, "the normal pose is back", 6_000) { !editUp() && menuOpen() })
        SystemClock.sleep(800)
        record("the setting is absent again (menuOrder ${menuOrderSetting()})", awaitTrue(4_000) { menuOrderSetting() == null })
        record("the normal pose is the default order: ${iconRowLabels().joinToString(" | ")}", iconRowLabels() == defaultRow && listLabels() == defaultList)
        still("after-reset-done")
        closeMenu()
    }

    // --- the sequence's frames -------------------------------------------------------------------

    /**
     * The sampler's frames judged for the sequence: the lift (the held scale reaching 1.02),
     * the glide (siblings translated while the item is in the hand, over more than one distinct
     * value: the spring, not a cut), the crossings (the order changing under the finger) and the
     * settle (the last frame with the hand empty, nothing translated, the order the drop made).
     */
    private fun judgeSequence(samples: JSONArray, key: String, expected: List<String>) {
        val frames = (0 until samples.length()).map { samples.getJSONArray(it) }
        val held = frames.filter { !it.isNull(1) && it.getString(1) == key }
        val lifted = held.filter { !it.isNull(2) && it.getDouble(2) >= 1.015 }
        val gliding = held.filter { it.getInt(4) > 0 }
        val glideValues = held.flatMap { it.getString(5).split(' ').filter { v -> v.isNotEmpty() } }.map { it.substringAfter(':') }.toSet()
        val orders = frames.map { it.getString(6) }.fold(ArrayList<String>()) { acc, o -> if (acc.lastOrNull() != o) acc.add(o); acc }
        val last = frames.lastOrNull()
        val settled = last != null && last.isNull(1) && last.getInt(4) == 0 && last.getString(6) == expected.joinToString(">")
        finding(
            "frames sampled: ${frames.size} over ${last?.getInt(0) ?: 0} ms; ${held.size} with the star in the hand, ${lifted.size} at the lifted scale, ${gliding.size} with siblings gliding (${glideValues.size} distinct translations); " +
                "the order changed ${orders.size - 1} time(s): ${orders.joinToString(" -> ")}"
        )
        finding("  path: ${frames.joinToString(" ") { f -> "${f.getInt(0)}:${if (f.isNull(1)) "-" else "held"}${if (f.isNull(2)) "" else "@%.3f".format(f.getDouble(2))}${if (f.getInt(4) > 0) "/g${f.getInt(4)}" else ""}" }}")
        record("the sequence began with the lift: the star in the hand at scale 1.02 over the hold (${lifted.size} frame(s))", lifted.isNotEmpty())
        record("the siblings glided aside while the star was in the hand (${gliding.size} frame(s), ${glideValues.size} distinct translations: a spring, not a cut)", gliding.isNotEmpty() && glideValues.size >= 2)
        record("the order changed under the finger and ended past two siblings (${orders.size - 1} change(s))", orders.size >= 2 && orders.last() == expected.joinToString(">"))
        record("the drop settled: the hand empty, nothing translated, the order the drop made", settled)
    }

    private fun samples(): JSONArray = jsonArray("window.__menuEditStop()")

    // --- readers ---------------------------------------------------------------------------------

    /** The normal pose's icon row (or its list pose under touch exploration): the buttons' names in order. */
    private fun iconRowLabels(): List<String> = strings(jsonArray(ICON_ROW_JS))

    /** The normal pose's list: every row's label in order, Change Menu among them. */
    private fun listLabels(): List<String> = strings(jsonArray(LIST_JS))

    /** The normal pose's groups below the row, by size. */
    private fun listGroupSizes(): List<Int> = jsonArray(GROUPS_JS).let { a -> (0 until a.length()).map { a.getInt(it) } }

    /** The edit pose's items in DOM order: key, name (with the place), label, section, box. */
    private fun editItems(): List<JSONObject> = jsonArray(EDIT_ITEMS_JS).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    /** The edit pose's list section slot by slot: an item's key, or `sep:<key>` for a hairline (`:collapsed` when drawn as none). */
    private fun listOrder(): List<String> = strings(jsonArray(LIST_ORDER_JS))

    private fun isHairline(slot: String?): Boolean = slot?.startsWith("sep:") == true

    /** The key a slot holds: the item's, or the hairline's. */
    private fun slotKey(slot: String): String = if (isHairline(slot)) slot.split(':')[1] else slot

    /** How many drawn hairlines stand before `key` in the list section: its group's index. */
    private fun groupOf(key: String): Int =
        listOrder().let { o -> o.take(o.indexOf(key).coerceAtLeast(0)).count { isHairline(it) && !it.endsWith(":collapsed") } }

    private fun nameOf(key: String): String? = editItems().firstOrNull { it.optString("key") == key }?.optString("name")

    private fun heldState(): JSONObject? = chromeJs(HELD_JS).let { raw ->
        val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrDefault("null")
        if (text == "null") null else runCatching { JSONObject(text) }.getOrNull()
    }

    private fun transformedCount(): Int = chromeJs(TRANSFORMED_JS).trim().toIntOrNull() ?: -1

    private fun title(): String? = chromeJsString("(document.querySelector('.zen-sheet-title')||{textContent:null}).textContent")

    private fun announcement(): String? = chromeJsString("(document.querySelector('[data-menu-edit-announcement]')||{textContent:null}).textContent")

    private fun doneBox(): JSONObject? = chromeJs(DONE_JS).let { raw ->
        val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrDefault("null")
        if (text == "null") null else runCatching { JSONObject(text) }.getOrNull()
    }

    private fun editUp(): Boolean = chromeJs("!!document.querySelector('[data-menu-edit]')") == "true"

    private fun menuOpen(): Boolean = chromeJs("!!document.querySelector('.zen-menu-icon-row, .zen-menu-icon-list')") == "true"

    /** `settings.menuOrder` as the core holds it: the keys, or null while absent (the default). */
    private fun menuOrderSetting(): JSONArray? = coreState().optJSONObject("settings")?.optJSONArray("menuOrder")

    private fun indexIn(order: JSONArray, key: String): Int = (0 until order.length()).firstOrNull { order.optString(it) == key } ?: -1

    private fun chromeAccessibilityState(): JSONObject =
        runCatching { JSONObject(chromeJsString("JSON.stringify(((window.__zenStores||{})['accessibility-state']||{get:function(){return {}}}).get())") ?: "{}") }.getOrDefault(JSONObject())

    private fun jsonArray(code: String): JSONArray {
        val raw = chromeJs(code)
        val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrDefault("[]")
        return runCatching { JSONArray(text) }.getOrDefault(JSONArray())
    }

    private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.optString(it) }

    /** Every item of a section is named with its place, and the places run 1..N in order. */
    private fun placesRun(items: List<JSONObject>): Boolean =
        items.withIndex().all { (i, item) ->
            val m = PLACE.matchEntire(item.optString("name"))
            m != null && m.groupValues[2].toInt() == i + 1 && m.groupValues[3].toInt() == items.size
        }

    /** `items` with `key` moved to index `to`. */
    private fun <T> moved(items: List<T>, key: T, to: Int): List<T> {
        val from = items.indexOf(key)
        if (from < 0 || to < 0 || to >= items.size) return items
        val rest = items.toMutableList().also { it.removeAt(from) }
        rest.add(to, key)
        return rest
    }

    // --- steps -----------------------------------------------------------------------------------

    /** A finger on the bar's Menu button, then the sheet on screen. */
    private fun openMenu(): Boolean {
        ensureForeground()
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            Log.w(tag, "the menu never opened")
            return false
        }
        awaitTrue(6_000) { menuOpen() }
        SystemClock.sleep(1_500)
        return menuOpen()
    }

    /** The open sheet pulled up, Change Menu revealed and touched; true once the edit pose is up. */
    private fun enterEdit(): Boolean {
        pullMenuUp()
        if (reveal(LABEL_CHANGE) == null) {
            Log.w(tag, "no $LABEL_CHANGE row in the menu")
            return false
        }
        val opened = touchTapLabelExpecting(LABEL_CHANGE, "the edit pose is up", 8_000) { editUp() }
        SystemClock.sleep(1_200)
        return opened && editUp()
    }

    /**
     * The item in the hand at its lifted scale: the chrome's long press fires 380 ms into the
     * hold and the lift eases over 120 ms, but the software GPU draws a frame every few hundred
     * milliseconds, so the ease lands when it lands; the finger stays down while this waits.
     */
    private fun awaitLift(): JSONObject? {
        var held: JSONObject? = null
        awaitTrue(LIFT_MS) {
            held = heldState()
            held?.let { near(it.optDouble("scale"), 1.02, 0.006) } == true
        }
        return held ?: heldState()
    }

    /**
     * The finger's travel over the slots: a nudge first, then the distance whole. The drag
     * begins at the first move past the 8 px slop and the item follows the finger from there
     * (`menuReorder.ts`: the target belongs to the finger); on the emulator the moves of a
     * whole frame coalesce into one, so a travel that set out at speed would begin the drag a
     * slot's worth along and land the item that much short. The nudge is that first move, small,
     * with a frame to take it; the item then lands within the nudge of the slot's centre.
     */
    private fun travel(f: Finger, dx: Float, dy: Float) {
        val nudge = NUDGE_CSS_PX * density
        f.moveBy(nudge * Math.signum(dx), nudge * Math.signum(dy), NUDGE_MS)
        f.hold(NUDGE_SETTLE_MS)
        f.moveBy(dx, dy, DRAG_MS)
    }

    /** Done, then the sheet away: the way out of a scene that could not run. */
    private fun leaveEdit() {
        touchTapLabel(LABEL_DONE)
        SystemClock.sleep(800)
        closeMenu()
    }

    private fun closeMenu() {
        back()
        awaitSurface(false)
        SystemClock.sleep(1_000)
    }

    /**
     * Where a labelled node is once its bounds hold still: the tree lags the sheet's pull and
     * scroll on the emulator, so two reads a moment apart must agree before a finger goes in.
     */
    private fun stableBounds(label: String): Rect? {
        val deadline = SystemClock.uptimeMillis() + 8_000
        var last: Rect? = null
        while (SystemClock.uptimeMillis() < deadline) {
            val now = findByLabel(label)
            if (now != null && now == last && now.top >= touchable.top && now.bottom <= touchable.bottom) return now
            last = now
            SystemClock.sleep(300)
        }
        Log.w(tag, "the bounds of '$label' never held still inside the touchable window: $last")
        return last
    }

    /** Touch exploration requested (or not) by UiAutomation's service, as TalkBack would: the manager's flag system-wide. */
    private fun setTouchExploration(on: Boolean) {
        val info = ui.serviceInfo
        info.flags = if (on) info.flags or AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        else info.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE.inv()
        ui.serviceInfo = info
    }

    /** Poll until the active tab per the core is `url` and has finished loading. */
    private fun awaitActive(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) return
            SystemClock.sleep(300)
        }
        Log.w(tag, "the active tab never settled on $url: ${activeCoreTab()}")
    }

    private fun near(value: Double, target: Double, tolerance: Double = 0.6): Boolean = Math.abs(value - target) <= tolerance

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `menu-edit-<theme>-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%s-%02d-%s".format(theme, shots, state))
    }

    companion object {
        private const val PORT = 18177
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val FIRST_TITLE = "The first page"
        private const val SECOND_TITLE = "The other page"

        /** The sheet's words (v2 §9.1 Title Case for menu items and the pose's title). */
        private const val LABEL_CHANGE = "Change Menu"
        private const val TITLE_EDIT = "Change Menu"
        private const val LABEL_DONE = "Done"
        private const val LABEL_RESET = "Reset to Default"
        private const val RESET_SENTENCE = "Menu order reset to the default."
        private const val LABEL_STAR = "Bookmark"
        private const val LABEL_HISTORY = "History"
        /** The items' keys (`menus.ts`' phone branch; `shared/menuOrder.ts`). */
        private const val KEY_STAR = "icon.bookmark"
        private const val KEY_HISTORY = "row.history"
        /** The two sections' lists, by their names (`MenuEditor.tsx`). */
        private const val SECTION_ROW = "Page actions"
        private const val SECTION_LIST = "Menu"
        private const val SCENE_LIST = "menu-edit-drag-list"

        /** An item's name in the pose: its label, then its place among its section's rows. */
        private val PLACE = Regex("^(.+), (\\d+) of (\\d+)$")
        private val MOVE_UP = Regex("^Move .+ up$")

        /** Past the chrome's 380 ms long press. */
        private const val HOLD_MS = 600L
        /**
         * The most the lift is given to land on the software GPU's frames after that: the
         * injected down reaches the page a frame late (a few hundred milliseconds here), the
         * long press counts from then, and the 120 ms ease draws when a frame comes.
         */
        private const val LIFT_MS = 3_000L
        /** The hold inside the traced scene, where nothing is read: the long press, its latency and the lift's ease, outright. */
        private const val TRACED_HOLD_MS = 1_600L
        /** The first move of a travel, in CSS px: past the chrome's 8 px slop and no further than a quarter of a row. */
        private const val NUDGE_CSS_PX = 12f
        private const val NUDGE_MS = 150L
        /** A frame or two for the nudge to begin the drag before the travel proper. */
        private const val NUDGE_SETTLE_MS = 450L
        /** The finger's travel over two slots. */
        private const val DRAG_MS = 700L
        /** The finger resting on the slot before it lets go, so the last re-targeting has drawn. */
        private const val REST_MS = 350L
        /** The release glide on SPRING_SNAPPY rests well inside this; measured with the drag. */
        private const val LANDING_MS = 900L

        private const val ICON_ROW_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-menu-icon-row button, .zen-menu-icon-list button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()}))"
        private const val LIST_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-sheet ul:not([aria-label=\"Page actions\"]) > li > button.zen-sheet-item:not(.zen-menu-edit-item)'),function(b){var s=b.querySelector('span');return (s?s.textContent:b.textContent).trim()}))"
        private const val GROUPS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-scroll ul:not([aria-label=\"Page actions\"])'),function(u){return u.querySelectorAll('button.zen-sheet-item').length}))"
        private const val EDIT_ITEMS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('[data-menu-edit] [data-menu-key]'),function(b){" +
                "var ul=b.closest('ul');var li=b.closest('li');var r=b.getBoundingClientRect();var name=b.getAttribute('aria-label')||'';" +
                "return {key:b.getAttribute('data-menu-key'),name:name,label:name.replace(/, \\d+ of \\d+$/,''),section:ul?ul.getAttribute('aria-label'):null," +
                "held:li?li.hasAttribute('data-held'):false,w:r.width,h:r.height}}))"
        private const val LIST_ORDER_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('[data-menu-edit] ul[aria-label=\"Menu\"] > li'),function(li){" +
                "var b=li.querySelector('[data-menu-key]');if(b)return b.getAttribute('data-menu-key');" +
                "return 'sep:'+(li.getAttribute('data-cell')||'')+(li.hasAttribute('data-collapsed')?':collapsed':'')}))"
        private const val HELD_JS =
            "(function(){var li=document.querySelector('[data-menu-edit] li[data-held]');if(!li)return JSON.stringify(null);var b=li.querySelector('[data-menu-key]');" +
                "var cs=getComputedStyle(b);var m=/matrix\\(([^)]+)\\)/.exec(cs.transform);" +
                "return JSON.stringify({key:b.getAttribute('data-menu-key'),scale:m?parseFloat(m[1].split(',')[0]):1,shadow:cs.boxShadow,opacity:cs.opacity,background:cs.backgroundColor,radius:cs.borderTopLeftRadius})})()"
        /** Cells and items of the pose still carrying a transform: none once every glide has landed. */
        private const val TRANSFORMED_JS =
            "Array.prototype.filter.call(document.querySelectorAll('[data-menu-edit] li, [data-menu-edit] [data-menu-key]'),function(e){var t=e.style.transform;return t&&t!=='none'}).length"
        private const val DONE_JS =
            "(function(){var d=document.querySelector('[data-menu-done]');if(!d)return JSON.stringify(null);var r=d.getBoundingClientRect();var s=d.closest('.zen-sheet');var sr=s?s.getBoundingClientRect():r;" +
                "return JSON.stringify({w:r.width,h:r.height,right:r.right,sheetRight:sr.right})})()"

        /**
         * Installed in the chrome once: a frame-by-frame sampler of the edit pose between
         * `__menuEditStart(section)` and `__menuEditStop()` (which answers with the samples as
         * JSON text), each sample `[ms since start, the key in the hand or null, its scale, its
         * translate x, how many of the section's other cells carry a translate (the FLIP glide),
         * those translates as key:px, the section's order as keys joined by >]`.
         */
        private const val SAMPLER =
            "(function(){window.__menuEdit=[];window.__menuEditOn=false;" +
                "window.__menuEditStart=function(section){window.__menuEdit=[];window.__menuEditOn=true;var t0=performance.now();" +
                "var tick=function(){if(!window.__menuEditOn)return;var root=document.querySelector('[data-menu-edit]');" +
                "var ul=root?root.querySelector('ul[aria-label=\"'+section+'\"]'):null;" +
                "var heldLi=root?root.querySelector('li[data-held]'):null;var held=heldLi?heldLi.querySelector('[data-menu-key]'):null;" +
                "var scale=null,tx=null;if(held){var m=/matrix\\(([^)]+)\\)/.exec(getComputedStyle(held).transform);if(m){var p=m[1].split(',');scale=parseFloat(p[0]);tx=parseFloat(p[4])}}" +
                "var glide=0,moving=[],order=[];if(ul){Array.prototype.forEach.call(ul.children,function(li){var b=li.querySelector('[data-menu-key]');if(!b)return;var k=b.getAttribute('data-menu-key');order.push(k);" +
                "if(li===heldLi)return;var m2=/matrix\\(([^)]+)\\)/.exec(getComputedStyle(li).transform);if(m2){var q=m2[1].split(',');var x=parseFloat(q[4]),y=parseFloat(q[5]);" +
                "if(Math.abs(x)>0.5||Math.abs(y)>0.5){glide++;moving.push(k+':'+(Math.abs(x)>Math.abs(y)?x:y).toFixed(1))}}})}" +
                "window.__menuEdit.push([Math.round(performance.now()-t0),held?held.getAttribute('data-menu-key'):null,scale,tx,glide,moving.join(' '),order.join('>')]);" +
                "requestAnimationFrame(tick)};requestAnimationFrame(tick)};" +
                "window.__menuEditStop=function(){window.__menuEditOn=false;return JSON.stringify(window.__menuEdit)}})()"
    }
}
