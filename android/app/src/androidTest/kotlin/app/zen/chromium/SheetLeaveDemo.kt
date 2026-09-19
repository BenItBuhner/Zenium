package app.zen.chromium

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Records the phone sheets whose request goes before they do – the leave that outlives the
 * request (design language v2 draft §11.1: the store's `null` means "leave", never "vanish") –
 * over one page, and measures each as it goes: (1) the app menu, then the tab's context menu
 * popped over it by the core, which sends the app menu `menu.hide` (`RendererMenuHost.popup`):
 * its request is gone while it still stands, and it runs its own way down as the context menu
 * rises above it; (2) the icon picker the context menu's row opens, cancelled – a press on its
 * scrim, the picker's cancel on a phone (it has no Cancel button; the back button is the same
 * path): its dialog unmounts the panel in the very commit, and the frame dialog host's slot
 * keeps it for the way down; (3) a stack – the external-protocol confirm (or, with no app for
 * `tel:` on the device, the location prompt) over the open menu – whose LOWER sheet the host
 * closes: the menu's request cleared under the confirm at rest, the way `menu.hide` and a back
 * delivered as one event clear it, while the upper's q and the page's recede hold (§11.2);
 * (4) a prompt the core owns (the location permission, in `state`), withdrawn by the page
 * itself: the page navigates, the core cancels the tab's questions (`permissionPrompts.
 * cancelForTab`), and the prompt leaves `state` – the same leave, from the frame dialog slot.
 *
 * Two judgements are made, neither with a clock in it (the recording emulator paints two to
 * five frames a second). The first is [SheetRecedeDemo]'s: a test-only swatch in the chrome
 * carries `--zen-recede` into every frame, and the page's band must be as dark as the swatch
 * says its sheets are up, never the window gradient. It holds through a leave as it holds
 * through a stack: the page recedes by the stack's summed presence, capped, and the scrims
 * compound to the same number (recede.ts), so one sheet leaving while the next arrives keeps
 * the page and its dim together. The second is this driver's own and reads the chrome, not the
 * screen: while a probe runs, a thread of its own reads a pose of the chrome every [POSE_MS] –
 * the root's `--zen-recede`, the store's menu, every sheet layer (`[data-sheet-layer]`: leaving
 * or not, inert or not, its offset and height) and the frame dialog host's slot (up or not, its
 * offset, its travel, whether a panel is in it and whether that panel is one kept for the way
 * down) – and the poses after the store's write must show the sheet still there, marked leaving
 * and inert, its offset running down monotonically with the page never brought back ahead of
 * it, and gone by the end; a stack's upper sheet must not move while the lower goes; the slot
 * must have a panel in it part-way down, never run back empty. The BEFORE of each is the sheet
 * gone in the commit that cleared its request (no pose of it leaving; the slot's way back empty).
 * The chrome is read on until each leave has landed, past the screenshots: the emulator
 * stretches a leave of two sheets to some seconds, and starves the reader meanwhile.
 *
 * The first judgement does not apply to the location prompt: its panel stands at the top of the
 * page, in the band, so the band reads the panel and not the page under it, at rest and as it
 * slides through. Those events are marked `record` – cut and written up, not judged by the band,
 * here or by the frames script – and the prompt's leave is judged by the poses alone.
 *
 * `marks.txt`, `geometry.txt` and the screenshots are what [SheetRecedeDemo] writes, so the
 * workflow cuts and reads the recording with the same script (android-sheet-recede-frames.mjs);
 * `leave-findings.txt` carries every screenshot's and every pose's numbers.
 *
 * Driven by the `android-sheet-leave-demo` workflow; see [DemoHarness] for the plumbing. The
 * page and the profile are the recede demo's ([DemoServer] serves the page from this process).
 * The `theme` instrumentation argument (`light`, the default, or `dark`) picks the colour scheme.
 */
@RunWith(AndroidJUnit4::class)
class SheetLeaveDemo : DemoHarness("sheet-recede-demo-state.json", "leave", "sheet-leave-demo") {
    override val tag = "SheetLeaveDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private lateinit var server: DemoServer
    private var demoStart = 0L
    private val marks = StringBuilder()
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host
    /** Where the swatch is on the screen, once it has been put in; empty until then. */
    private var swatch = Rect()
    /** The band's brightness with no sheet up (the live page) and under one fully up, from the warm-up. */
    private var bright = Double.NaN
    private var dark = Double.NaN

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("sheet-recede-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            // Whatever cut the sequence short, what was measured up to then is worth having.
            File(out, "marks.txt").writeText(marks.toString())
            File(out, "leave-findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("sheets that vanished with their request, or a page out of step with its sheets:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    /**
     * Let the page load, put the swatch in, then open and close the menu once off camera: the
     * first sheet pays for layout and script compilation, which is not what is being measured.
     * The menu fully up and the page with no sheet give the two brightnesses every frame is
     * read against.
     */
    override fun warmUp() {
        finding("Zenium Android sheet leave (${theme}, ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_500)
        placeSwatch()
        val f = Finger()
        f.tap(menuButton())
        settleUp()
        SystemClock.sleep(1_000)
        ui.takeScreenshot()?.let {
            dark = measureBand(it, band()).luminance
            finding("menu up: --zen-recede ${recedeValue()}, swatch p ${"%.3f".format(progress(it))}, band ${"%.1f".format(dark)}, pose ${poseNow()}")
            save(it, "warmup-menu-up")
            it.recycle()
        }
        back()
        settleDown()
        SystemClock.sleep(1_500)
        ui.takeScreenshot()?.let {
            bright = measureBand(it, band()).luminance
            finding("no sheet: --zen-recede ${recedeValue()}, swatch p ${"%.3f".format(progress(it))}, band ${"%.1f".format(bright)}")
            save(it, "warmup-no-sheet")
            it.recycle()
        }
        val page = pageArea()
        val band = band()
        File(out, "geometry.txt").writeText(
            "size $width $height\npage ${page.left} ${page.top} ${page.right} ${page.bottom}\n" +
                "band ${band.left} ${band.top} ${band.right} ${band.bottom}\n" +
                "swatch ${swatch.left} ${swatch.top} ${swatch.width()} ${swatch.height()} ${swatchColour()}\n"
        )
        finding("page $page, band $band, swatch $swatch (${swatchColour()}), band ${"%.1f".format(bright)} bright / ${"%.1f".format(dark)} dark")
        if (bright.isNaN() || dark.isNaN() || bright - dark < 6 * NOISE) {
            failures += "the band's brightness with the menu up (%.1f) and without a sheet (%.1f) do not tell the page dark from bright".format(dark, bright)
        }
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        demoStart = SystemClock.uptimeMillis()
        val f = Finger()

        // 1. The app menu, then the tab's context menu popped over it by the core. The core sends
        //    the open menu `menu.hide` before it shows the next (RendererMenuHost.popup): the app
        //    menu's request is gone while it stands at its detent, and it leaves – its own way
        //    down, inert, under the context menu rising above it (§11.1). The page holds as dark
        //    as the two together are up.
        probe("menu-open", Kind.TRANSITION) { f.tap(menuButton()) }
        settleUp()
        val appMenu = menuId()
        finding("app menu up: id '$appMenu', --zen-recede ${recedeValue()}, pose ${poseNow()}")
        val hide = probe("menu-hide", Kind.TRANSITION, landed = noLeavingLayer) { coreInvoke("tab.contextMenu", "{\"tabId\":\"$TAB_ID\"}") }
        judgeMenuLeave("menu-hide", hide.poses, appMenu)
        settleUp()
        finding("context menu up: id '${menuId()}', --zen-recede ${recedeValue()}, pose ${poseNow()}")

        // 2. The icon picker from the context menu's "Change Icon…" row (the menu leaves as the
        //    picker rises in the frame dialog host), then its cancel: a press on the scrim, which
        //    unmounts the panel in the very commit. The slot keeps it for the way down.
        var pickerUp = false
        if (findNode { it == CHANGE_ICON } != null) {
            probe("picker-open", Kind.TRANSITION) {
                if (!clickByLabel(CHANGE_ICON)) Log.w(tag, "'$CHANGE_ICON' took no click through the tree")
            }
            settleUp()
            pickerUp = waitFor(PICKER_TITLE, 2_000) != null
            finding(if (pickerUp) "picker: '$PICKER_TITLE' is up, pose ${poseNow()}" else "picker: '$PICKER_TITLE' never came up")
        } else {
            finding("no '$CHANGE_ICON' row in the context menu")
        }
        if (pickerUp) {
            val travel = slotTravel(poseNow())
            val cancel = probe("picker-cancel", Kind.TRANSITION, landed = slotDown) { f.tap(scrimPoint()) }
            judgeKeptSlide("picker-cancel", cancel.poses, travel)
        } else if (awaitSurface(up = true, timeoutMs = 500)) {
            finding("closing the context menu instead")
            probe("context-close", Kind.TRANSITION) { back() }
        }
        settleDown()

        // 3. A stack: the menu, then a second sheet over it, asked for by the page's script; then
        //    the LOWER sheet closed by the host – the menu's request cleared under the confirm at
        //    rest, the write `menu.hide` and a back delivered as one event make (the core sends
        //    `menu.hide` only ahead of another popup, which is step 1; the store is reached here
        //    through its module registry). The menu runs down under the confirm while the
        //    confirm's q, the page's recede and the one scrim hold (§11.2); the confirm is then
        //    taken down by back.
        f.tap(menuButton())
        settleUp()
        val lower = menuId()
        val second = secondSheet()
        finding("stacked sheet: $second")
        // The location prompt stands at the top of the page, in the band: its frames are recorded,
        // the poses judged.
        val stackKind = if (second.inBand) Kind.RECORD else Kind.TRANSITION
        probe("stack-open", stackKind) { runInPage(second.script) }
        settleUp()
        finding("stack: sheet on top titled '${findNode { it.startsWith("Open in") || it.startsWith("Allow") }?.let { it.text ?: it.contentDescription } ?: "?"}', lower menu '$lower', pose ${poseNow()}")
        val lowerGone = probe("stack-close-lower", stackKind, landed = noLeavingLayer) { finding("the host closed the lower sheet: ${hostClosesMenu()}") }
        judgeLowerLeave("stack-close-lower", lowerGone.poses, lower)
        settleUp()
        probe("stack-close-top", stackKind) { back() }
        settleDown()

        // 4. A prompt the core owns, withdrawn by the page: the page asks for its location and the
        //    prompt comes up in the frame dialog host (a sheet on a phone); then the page reloads
        //    itself, the core cancels the tab's questions on the commit, and the prompt leaves
        //    `state` – the same leave from the slot. (A page's alert, confirm or prompt is the
        //    system's dialog on Android, not the chrome's, so the permission prompt stands for the
        //    core-owned dialog dismissed by its page.)
        //    The prompt's panel stands at the top of the page, in the band, so the band reads the
        //    panel and not the page under it: these frames are recorded and their numbers written,
        //    the leave judged by the poses (the slot's kept panel riding down, `p` with it).
        probe("prompt-open", Kind.RECORD) { runInPage(LOCATION_REQUEST) }
        settleUp()
        val promptUp = waitFor(LOCATION_TITLE, 2_000) != null || slotHasPanel(poseNow())
        finding(if (promptUp) "location prompt up: pose ${poseNow()}" else "no prompt came up for the page's location request")
        if (promptUp) {
            val travel = slotTravel(poseNow())
            val gone = probe("prompt-page-navigates", Kind.RECORD, landed = slotDown) { runInPage("location.reload()") }
            judgeKeptSlide("prompt-page-navigates", gone.poses, travel)
            settleDown()
        } else if (awaitSurface(up = true, timeoutMs = 500)) {
            probe("prompt-close", Kind.RECORD) { back() }
            settleDown()
        }
    }

    // --- the chrome, read as it goes -------------------------------------------------------------

    /** One reading of the chrome (see [POSE_JS]), `at` ms after the probe's event. */
    private class Pose(val at: Long, val json: JSONObject) {
        val p: Double get() = json.optDouble("p", 0.0)
        val menu: String? get() = if (json.isNull("menu")) null else json.optString("menu")
        val layers: List<JSONObject>
            get() = json.optJSONArray("layers")?.let { a -> List(a.length()) { a.getJSONObject(it) } } ?: emptyList()
        val slot: JSONObject? get() = json.optJSONObject("slot")

        override fun toString(): String = json.toString()
    }

    /** A pose of the chrome right now, or `null` when it could not be read. */
    private fun poseNow(): Pose? = parsePose(0, chromeJs(POSE_JS))

    /** `raw` is the script's JSON-encoded result – a quoted string of JSON – or empty when the chrome never answered. */
    private fun parsePose(at: Long, raw: String): Pose? = runCatching {
        val text = JSONTokener(raw).nextValue() as? String ?: return null
        Pose(at, JSONObject(text))
    }.getOrNull()

    /** The open menu's id per the chrome's store; empty with none. */
    private fun menuId(): String {
        val raw = chromeJs("(function(){var s=window.__zenStores&&window.__zenStores.ui;var m=s?s.get().menu:null;return m?m.id:'';})()")
        return (JSONTokener(raw).nextValue() as? String).orEmpty()
    }

    /**
     * The host closes the open menu: the store's `menu` cleared and the core told (`menu.close`),
     * the write `closeMenu` makes for `menu.hide` from the core and for a back delivered as one
     * event (`handleSystemBack`). Returns the id of the menu it closed, or what went wrong.
     */
    private fun hostClosesMenu(): String {
        val raw = chromeJs(
            "(function(){var s=window.__zenStores&&window.__zenStores.ui;if(!s)return 'no store';var m=s.get().menu;if(!m)return 'no menu';" +
                "s.set({menu:null});window.zen.invoke('menu.close',{menuId:m.id});return m.id;})()"
        )
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /** The slot's travel (CSS px) per a pose with a panel in it: what the slide runs over. */
    private fun slotTravel(pose: Pose?): Double = pose?.slot?.let { if (it.isNull("travel")) null else it.getDouble("travel") } ?: Double.NaN

    private fun slotHasPanel(pose: Pose?): Boolean = pose?.slot?.optBoolean("panel") ?: false

    /** A sheet layer's presence per a pose: 1 at its detent, 0 off the screen (`1 − ty / height`). */
    private fun presenceOf(layer: JSONObject): Double {
        val ty = layer.optDouble("ty", Double.NaN)
        val h = layer.optDouble("h", Double.NaN)
        if (ty.isNaN() || h.isNaN() || h <= 0) return Double.NaN
        return (1 - ty / h).coerceIn(0.0, 1.0)
    }

    private fun describePoses(name: String, poses: List<Pose>) {
        findings.append("$name poses: ${poses.size}\n")
        for (pose in poses) {
            val layers = pose.layers.joinToString(" ") { l ->
                "[%s%s%s ty %s h %s]".format(
                    if (l.optBoolean("leaving")) "leaving " else "",
                    if (l.optBoolean("inert")) "inert " else "",
                    if (l.optBoolean("hosted")) "hosted" else "sheet",
                    if (l.isNull("ty")) "-" else "%.1f".format(l.getDouble("ty")),
                    if (l.isNull("h")) "-" else "%.0f".format(l.getDouble("h"))
                )
            }
            val slot = pose.slot?.let { s ->
                " slot{%s ty %s travel %s%s%s}".format(
                    if (s.optBoolean("up")) "up" else "down",
                    if (s.isNull("ty")) "-" else "%.1f".format(s.getDouble("ty")),
                    if (s.isNull("travel")) "-" else "%.0f".format(s.getDouble("travel")),
                    if (s.optBoolean("panel")) " panel" else " empty",
                    if (s.optBoolean("kept")) " kept" else ""
                )
            } ?: ""
            findings.append("  %6d ms  p %.3f menu %s  %s%s\n".format(pose.at, pose.p, pose.menu ?: "-", layers, slot))
        }
    }

    /**
     * A menu whose request the core withdrew leaves (step 1): the poses after the store's write
     * still show its layer, marked leaving and inert, its offset running down and never back up,
     * the root's recede never under its own presence (the page is never brought back ahead of
     * the sheet still showing), and by the end it is gone.
     */
    private fun judgeMenuLeave(name: String, poses: List<Pose>, oldMenu: String) {
        describePoses(name, poses)
        val afterWrite = poses.filter { it.menu != oldMenu }
        if (afterWrite.isEmpty()) {
            failures += "$name: no pose saw the store's write (${poses.size} poses; the menu is still '$oldMenu')"
            return
        }
        val leaving = afterWrite.filter { pose -> pose.layers.any { it.optBoolean("leaving") } }
        if (leaving.isEmpty()) {
            failures += "$name: the sheet vanished with its request: no pose after the store's write shows it leaving (${afterWrite.size} poses after the write)"
            return
        }
        var previous = Double.NaN
        var partWay = 0
        for (pose in leaving) {
            val layer = pose.layers.first { it.optBoolean("leaving") }
            if (!layer.optBoolean("inert")) failures += "$name at ${pose.at} ms: the leaving sheet is not inert"
            val presence = presenceOf(layer)
            if (presence.isNaN()) continue
            if (presence > 0.05 && presence < 0.95) partWay++
            if (pose.p < presence - LEAVE_TOLERANCE) {
                failures += "$name at ${pose.at} ms: the page is back to %.2f while the leaving sheet still stands at %.2f".format(pose.p, presence)
            }
            val ty = layer.getDouble("ty")
            if (!previous.isNaN() && ty < previous - 1) failures += "$name at ${pose.at} ms: the leaving sheet turned back up (%.1f → %.1f px)".format(previous, ty)
            previous = ty
        }
        if (partWay == 0) partWayUnseen(name, afterWrite.size, leaving.size)
        val last = poses.last()
        if (last.layers.any { it.optBoolean("leaving") }) failures += "$name: the leaving sheet is still there ${last.at} ms after the write"
        findings.append("  ${afterWrite.size} poses after the store's write, ${leaving.size} of the sheet leaving, $partWay part-way; ${last.layers.size} layer(s) at the end, ${last.at} ms after the write\n")
    }

    /**
     * No pose caught the way down between 5 and 95 percent: a failure when the chrome was read
     * often enough to have caught it ([POSES_TO_CATCH] after the write), a finding otherwise – a
     * poller the emulator starved (a script round trip of seconds while two sheets move) is not
     * evidence of a vanish; that is a leave with no pose of the sheet leaving at all.
     */
    private fun partWayUnseen(name: String, afterWrite: Int, leaving: Int) {
        val line = "$name: the way down was not caught part-way ($afterWrite poses after the store's write, $leaving of the sheet leaving or kept)"
        if (afterWrite >= POSES_TO_CATCH) failures += line else findings.append("  $line: too few poses to tell\n")
    }

    /**
     * The lower sheet of a stack closed by the host (step 3): the poses after the store's write
     * show it leaving and inert, its offset running down, while the upper sheet – the one layer
     * not leaving, or the frame dialog host's slot – does not move and the root's recede holds
     * at 1 (§11.2); the lower is gone by the end and the upper still there.
     */
    private fun judgeLowerLeave(name: String, poses: List<Pose>, oldMenu: String) {
        describePoses(name, poses)
        val afterWrite = poses.filter { it.menu != oldMenu }
        if (afterWrite.isEmpty()) {
            failures += "$name: no pose saw the store's write (${poses.size} poses; the menu is still '$oldMenu')"
            return
        }
        val leaving = afterWrite.filter { pose -> pose.layers.any { it.optBoolean("leaving") } }
        if (leaving.isEmpty()) {
            failures += "$name: the lower sheet vanished with its request: no pose after the store's write shows it leaving (${afterWrite.size} poses after the write)"
        }
        var previous = Double.NaN
        var partWay = 0
        for (pose in leaving) {
            val layer = pose.layers.first { it.optBoolean("leaving") }
            if (!layer.optBoolean("inert")) failures += "$name at ${pose.at} ms: the leaving sheet is not inert"
            val presence = presenceOf(layer)
            if (!presence.isNaN() && presence > 0.05 && presence < 0.95) partWay++
            val ty = layer.optDouble("ty", Double.NaN)
            if (!ty.isNaN() && !previous.isNaN() && ty < previous - 1) failures += "$name at ${pose.at} ms: the leaving sheet turned back up (%.1f → %.1f px)".format(previous, ty)
            previous = ty
        }
        if (leaving.isNotEmpty() && partWay == 0) partWayUnseen(name, afterWrite.size, leaving.size)
        // The upper holds: the same offset in every pose after the write, the recede at 1.
        var upperTy = Double.NaN
        var upperKind = ""
        for (pose in afterWrite) {
            if (pose.p < 0.995) failures += "$name at ${pose.at} ms: the page's recede is %.3f while the upper sheet stands (spec 1: the page holds at the upper's recede)".format(pose.p)
            val upper = pose.layers.lastOrNull { !it.optBoolean("leaving") }
            val slot = pose.slot?.takeIf { it.optBoolean("up") }
            val ty = when {
                upper != null -> { upperKind = "sheet"; upper.optDouble("ty", Double.NaN) }
                slot != null -> { upperKind = "slot"; slot.optDouble("ty", Double.NaN) }
                else -> Double.NaN
            }
            if (ty.isNaN()) continue
            if (upperTy.isNaN()) upperTy = ty
            else if (abs(ty - upperTy) > 1) failures += "$name at ${pose.at} ms: the upper $upperKind moved (%.1f → %.1f px) while the lower left".format(upperTy, ty)
        }
        if (upperTy.isNaN()) failures += "$name: no upper sheet could be read while the lower left"
        val last = poses.last()
        if (last.layers.any { it.optBoolean("leaving") }) failures += "$name: the leaving sheet is still there ${last.at} ms after the write"
        findings.append("  ${afterWrite.size} poses after the store's write, ${leaving.size} of the lower leaving, $partWay part-way; the upper $upperKind at ${if (upperTy.isNaN()) "-" else "%.1f".format(upperTy)} px throughout, ${last.at} ms after the write\n")
    }

    /**
     * The frame dialog host's slot on its way down after its dialog unmounted the panel (steps 2
     * and 4): every pose part-way down (5 to 95 percent of the travel, the host up) has a panel
     * in the slot – the one kept for the way down – never an empty slot; the offsets run one way;
     * and once the host is down the panel is gone. `travel` is the slot's while the dialog stood.
     */
    private fun judgeKeptSlide(name: String, poses: List<Pose>, travelUp: Double) {
        describePoses(name, poses)
        var travel = travelUp
        var previous = Double.NaN
        var partWay = 0
        var kept = 0
        for (pose in poses) {
            val s = pose.slot ?: continue
            if (!s.optBoolean("up")) continue
            val ty = s.optDouble("ty", Double.NaN)
            if (ty.isNaN()) continue
            if (!s.isNull("travel")) travel = s.getDouble("travel")
            if (travel.isNaN() || travel <= 0) continue
            val share = ty / travel
            if (share > 0.05 && share < 0.95) {
                partWay++
                if (s.optBoolean("panel")) {
                    if (s.optBoolean("kept")) kept++
                } else {
                    failures += "$name at ${pose.at} ms: the slot runs back empty at %.0f of %.0f px (%.0f%% of the way), the panel gone with its dialog".format(ty, travel, share * 100)
                }
            }
            if (!previous.isNaN() && ty < previous - 1) failures += "$name at ${pose.at} ms: the slide turned back up (%.1f → %.1f px)".format(previous, ty)
            previous = ty
        }
        if (partWay == 0) partWayUnseen(name, poses.size, poses.count { it.slot?.optBoolean("kept") == true })
        if (!travel.isNaN() && travel < MIN_TRAVEL_CSS_PX) failures += "$name: the slide's travel is %.0f px, not the sheet's height".format(travel)
        val last = poses.lastOrNull()
        val slot = last?.slot
        if (slot != null && slot.optBoolean("up")) failures += "$name: the host is still up ${last.at} ms after the write"
        if (slot != null && slot.optBoolean("panel")) failures += "$name: a panel is still in the slot once the host is down"
        findings.append("  travel %s px, $partWay poses part-way down, $kept of them with the kept panel; the host ${if (slot?.optBoolean("up") == true) "up" else "down"} ${last?.at ?: 0} ms after the write\n".format(if (travel.isNaN()) "-" else "%.0f".format(travel)))
    }

    // --- the surfaces ----------------------------------------------------------------------------

    private fun Finger.tap(at: PointF) = tap(at.x, at.y)

    private fun menuButton(): PointF =
        waitFor(MENU_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "menu button not in the accessibility tree; tapping the end of the bar")
            PointF(width - 28 * density, pillY)
        }

    /** A point on the scrim above any sheet: the middle of the measured band. */
    private fun scrimPoint(): PointF = band().let { PointF(it.exactCenterX(), it.exactCenterY()) }

    /** `inBand`: the sheet's panel stands in the measured band, so its frames are recorded, not band-judged. */
    private class SecondSheet(val description: String, val script: String, val inBand: Boolean) {
        override fun toString() = description
    }

    /**
     * What the page asks for to put a second sheet over the menu: a `tel:` link, which the host
     * holds for the external-protocol confirm when an app on the device answers to it (the
     * dialer), else the location permission, whose prompt is a frame dialog – a sheet on a phone,
     * standing at the top of the page.
     */
    private fun secondSheet(): SecondSheet {
        val tel = Intent(Intent.ACTION_VIEW, Uri.parse("tel:5550100")).addCategory(Intent.CATEGORY_BROWSABLE)
        val dialer = app.packageManager.resolveActivity(tel, PackageManager.MATCH_DEFAULT_ONLY)
        return if (dialer != null) {
            SecondSheet(
                "external-protocol confirm for tel: (${dialer.loadLabel(app.packageManager)})",
                "location.href='tel:5550100'",
                inBand = false
            )
        } else {
            SecondSheet("location permission prompt (no app answers to tel:)", LOCATION_REQUEST, inBand = true)
        }
    }

    /** Run `script` in the demo tab's page (its view may be hidden under a sheet; scripts still run). */
    private fun runInPage(script: String) {
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull()
            if (view == null) Log.w(tag, "no tab view to run the page script in")
            else view.evaluateJavascript(script, null)
        }
    }

    /** The chrome's `--zen-recede` as computed on its root: 0 with no sheet, 1 with one fully up. */
    private fun recedeValue(): String {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-recede').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "(unset)" } ?: "(unset)"
    }

    /** [recedeValue] as a number: 0 when unset. */
    private fun recedeNumber(): Double = recedeValue().toDoubleOrNull() ?: 0.0

    /**
     * Poll `--zen-recede` until `settled` accepts it, or `timeoutMs` has passed; true when it
     * did. The value is what the chassis paints from, so it says when a spring has landed
     * better than any wait would on an emulator whose pace changes from frame to frame.
     */
    private fun awaitRecede(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(recedeNumber())) return true
            SystemClock.sleep(120)
        }
        return false
    }

    /** A surface was asked for: wait for the chrome to have it, then for its spring to land at the top. */
    private fun settleUp() {
        if (!awaitSurface(up = true, timeoutMs = 8_000)) Log.w(tag, "no surface came up")
        if (!awaitRecede(SETTLE_MS) { it >= 0.995 }) Log.w(tag, "the recede did not reach 1: ${recedeValue()}")
        // The value lands a frame before the last paint reaches the screen.
        SystemClock.sleep(400)
    }

    /**
     * A surface was dismissed: wait for the chrome to be rid of it, for the recede to be back at
     * zero, then for the live page to have been drawn again and its picture taken away.
     */
    private fun settleDown() {
        if (!awaitSurface(up = false, timeoutMs = 10_000)) Log.w(tag, "the surface did not go")
        if (!awaitRecede(SETTLE_MS) { it <= 0.005 }) Log.w(tag, "the recede did not return to 0: ${recedeValue()}")
        SystemClock.sleep(1_200)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    // --- the swatch ------------------------------------------------------------------------------

    /**
     * Put the progress swatch into the chrome (as [SheetRecedeDemo] does): a fixed bar in the
     * status-bar area whose width is `--zen-recede` times [SWATCH_LENGTH_SHARE] of the screen,
     * read through `var()` so it moves in the very style pass that moves the page and the
     * sheets. Black on the light scheme, white on the dark, above everything and taking no
     * input. Test-only; the product has no such thing.
     */
    private fun placeSwatch() {
        val insets = windowInsets()
        val left = (width * SWATCH_START_SHARE).roundToInt()
        val length = (width * SWATCH_LENGTH_SHARE).roundToInt()
        val h = (SWATCH_HEIGHT_DP * density).roundToInt()
        // Below the status bar's icon row, above the page's frame: the bar's lower part.
        val top = insets.top - h - (3 * density).roundToInt()
        swatch = Rect(left, top, left + length, top + h)
        val css = "position:fixed;left:${left / density}px;top:${top / density}px;height:${h / density}px;" +
            "width:calc(var(--zen-recede,0)*${length / density}px);background:${if (theme == "dark") "#fff" else "#000"};" +
            "z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;border-radius:0"
        val result = chromeJs(
            "(function(){var el=document.getElementById('zen-demo-recede');" +
                "if(!el){el=document.createElement('div');el.id='zen-demo-recede';document.body.appendChild(el);}" +
                "el.style.cssText=${jsString(css)};return el.getBoundingClientRect().height;})()"
        )
        finding("swatch placed at $swatch (${swatchColour()}); the chrome says its height is $result")
    }

    private fun swatchColour() = if (theme == "dark") "white" else "black"

    private fun jsString(s: String): String = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    /**
     * The sheet's progress a screenshot shows: the swatch's width as a share of its full length,
     * read along its middle rows as the count of columns that are the swatch's colour in at
     * least two of three rows. NaN before the swatch is in place.
     */
    private fun progress(bitmap: Bitmap): Double {
        if (swatch.isEmpty) return Double.NaN
        val r = Rect(swatch)
        r.intersect(0, 0, bitmap.width, bitmap.height)
        if (r.isEmpty || r.height() < 3) return Double.NaN
        val rows = intArrayOf(r.top + r.height() / 2 - 1, r.top + r.height() / 2, r.top + r.height() / 2 + 1)
        val line = IntArray(r.width())
        val hits = IntArray(r.width())
        for (y in rows) {
            bitmap.getPixels(line, 0, r.width(), r.left, y, r.width(), 1)
            for (x in line.indices) if (isSwatch(luminance(line[x]))) hits[x]++
        }
        return hits.count { it >= 2 }.toDouble() / swatch.width()
    }

    private fun isSwatch(l: Double) = if (theme == "dark") l > 175 else l < 90

    private fun luminance(p: Int): Double =
        0.299 * ((p shr 16) and 0xff) + 0.587 * ((p shr 8) and 0xff) + 0.114 * (p and 0xff)

    // --- frames and poses ------------------------------------------------------------------------

    /**
     * How an event's frames are judged by the band: a `TRANSITION` here and in the recording; a
     * `RECORD` is cut and its numbers written, but not judged by the band, here or in the
     * recording (the frames script's `record` kind) – for a sheet whose panel stands in the
     * band, where the band reads the panel and not the page. Its poses are judged all the same.
     */
    private enum class Kind { TRANSITION, RECORD }

    /** [spread] is the standard deviation of the luminance: the texture left in a region. */
    private class Metrics(val luminance: Double, val chroma: Double, val edges: Double, val pageLike: Double, val spread: Double)

    private class Frame(val at: Long, val band: Metrics, val progress: Double)

    /** What a probe took: its screenshots' numbers and the poses read from the chrome meanwhile. */
    private class Probed(val frames: List<Frame>, val poses: List<Pose>)

    /**
     * Reads a pose of the chrome every [POSE_MS] from a thread of its own while a probe runs, so
     * a leave of a few hundred milliseconds is seen several times over between the emulator's
     * slow screenshots. Each reading is one script evaluation, so its numbers are of one moment.
     */
    private inner class Poller(private val t0: Long) : Thread("chrome-poses") {
        private val poses = ArrayList<Pose>()
        @Volatile private var stopped = false

        override fun run() {
            while (!stopped) {
                val started = SystemClock.uptimeMillis()
                val raw = chromeJs(POSE_JS)
                val pose = parsePose((started + SystemClock.uptimeMillis()) / 2 - t0, raw)
                if (pose != null) synchronized(poses) { poses += pose }
                val wait = POSE_MS - (SystemClock.uptimeMillis() - started)
                if (wait > 0) SystemClock.sleep(wait)
            }
        }

        fun finish(): List<Pose> {
            stopped = true
            join(5_000)
            return synchronized(poses) { ArrayList(poses) }
        }
    }

    /**
     * Screenshot the page just before `action`, run it, then screenshot for `probeMs` as fast as
     * the emulator allows, reading every frame's band and progress, while [Poller] reads the
     * chrome; judge the frames by the band (a `TRANSITION`). A frame's time is the middle of the
     * call that took it, since the event; the event is marked for the workflow. With `landed`
     * given, the chrome goes on being read after the screenshots, every [POSE_MS] and with
     * nothing else running, until a pose satisfies it or [SETTLE_MS] more have passed: a leave
     * the emulator stretches past the probe (two sheets moving at once take it to four seconds
     * and more, and a starved poller sees three poses in as many seconds) is still seen to land.
     */
    private fun probe(
        name: String,
        kind: Kind,
        probeMs: Long = PROBE_MS,
        landed: ((Pose) -> Boolean)? = null,
        action: () -> Unit
    ): Probed {
        val before = ui.takeScreenshot()
        val reference = before?.let { shot -> Frame(0, measureBand(shot, band()), progress(shot)) }
        before?.let { save(it, "$name-before") }
        before?.recycle()
        val t0 = SystemClock.uptimeMillis()
        marks.append("${t0 - demoStart} $name ${kind.name.lowercase()}\n")
        val poller = Poller(t0).also { it.start() }
        action()
        val frames = ArrayList<Frame>()
        while (SystemClock.uptimeMillis() - t0 < probeMs) {
            val started = SystemClock.uptimeMillis()
            val shot = ui.takeScreenshot() ?: continue
            val at = (started + SystemClock.uptimeMillis()) / 2 - t0
            frames += Frame(at, measureBand(shot, band()), progress(shot))
            save(shot, "$name-${at}ms")
            shot.recycle()
        }
        val poses = ArrayList(poller.finish())
        if (landed != null && !(poses.lastOrNull()?.let(landed) ?: false)) {
            val until = SystemClock.uptimeMillis() + SETTLE_MS
            while (SystemClock.uptimeMillis() < until) {
                val started = SystemClock.uptimeMillis()
                val raw = chromeJs(POSE_JS)
                val pose = parsePose((started + SystemClock.uptimeMillis()) / 2 - t0, raw)
                if (pose != null) {
                    poses += pose
                    if (landed(pose)) break
                }
                val wait = POSE_MS - (SystemClock.uptimeMillis() - started)
                if (wait > 0) SystemClock.sleep(wait)
            }
        }
        judge(name, kind, reference, frames)
        return Probed(frames, poses)
    }

    /** No sheet layer is left leaving: a menu's leave has landed. */
    private val noLeavingLayer: (Pose) -> Boolean = { pose -> pose.layers.none { it.optBoolean("leaving") } }

    /** The frame dialog host is down (or was never read): a slot's leave has landed. */
    private val slotDown: (Pose) -> Boolean = { pose -> pose.slot?.optBoolean("up") != true }

    /** The content frame: below the status bar and above the bar. */
    private fun pageArea(): Rect {
        val insets = windowInsets()
        val pad = (8 * density).roundToInt()
        return Rect(pad, insets.top + pad, width - pad, pill.top - 2 * pad)
    }

    /**
     * The band measured: the upper part of the page, which a sheet coming from the bottom never
     * reaches, inset enough that the receded frame (97 percent, about its centre) still fills it.
     */
    private fun band(): Rect {
        val page = pageArea()
        val inset = (page.width() * 0.1f).roundToInt()
        return Rect(
            page.left + inset,
            page.top + (page.height() * 0.05f).roundToInt(),
            page.right - inset,
            page.top + (page.height() * 0.30f).roundToInt()
        )
    }

    /**
     * Mean luminance, mean chroma (max − min channel), edge density (share of sampled pixels
     * whose right neighbour differs by more than 40 in luminance), the share of page-like
     * pixels (bright and grey) and the spread of the luminance over `rect`, sampled every
     * third pixel.
     */
    private fun measureBand(bitmap: Bitmap, rect: Rect): Metrics {
        val r = Rect(rect)
        r.intersect(0, 0, bitmap.width, bitmap.height)
        if (r.isEmpty) return Metrics(0.0, 0.0, 0.0, 0.0, 0.0)
        val row = IntArray(r.width())
        var n = 0L
        var lum = 0.0
        var lumSquares = 0.0
        var chroma = 0.0
        var edges = 0L
        var pageLike = 0L
        var y = r.top
        while (y < r.bottom) {
            bitmap.getPixels(row, 0, r.width(), r.left, y, r.width(), 1)
            var x = 0
            while (x < row.size) {
                val p = row[x]
                val red = (p shr 16) and 0xff
                val green = (p shr 8) and 0xff
                val blue = p and 0xff
                val l = 0.299 * red + 0.587 * green + 0.114 * blue
                val c = max(red, max(green, blue)) - min(red, min(green, blue))
                lum += l
                lumSquares += l * l
                chroma += c
                if (l > 90 && c < 24) pageLike++
                if (x + 3 < row.size) {
                    val q = row[x + 3]
                    val lq = 0.299 * ((q shr 16) and 0xff) + 0.587 * ((q shr 8) and 0xff) + 0.114 * (q and 0xff)
                    if (abs(l - lq) > 40) edges++
                }
                n++
                x += 3
            }
            y += 3
        }
        val mean = lum / n
        return Metrics(mean, chroma / n, edges.toDouble() / n, pageLike.toDouble() / n, sqrt(max(0.0, lumSquares / n - mean * mean)))
    }

    /** How far the band has gone dark, 0 (the page with no sheet) to 1 (under a sheet fully up). */
    private fun darkness(luminance: Double): Double =
        if (bright.isNaN() || dark.isNaN() || bright - dark <= 0) Double.NaN else (bright - luminance) / (bright - dark)

    /**
     * The band must look like the page in every frame – text edges or grey-white pixels, never
     * the smooth tinted window gradient – and its darkness must agree with the sheets' progress
     * the swatch shows in the same frame, within [TOLERANCE] of the way (plus the noise's share):
     * they are one value in the chassis, so a frame in which they differ is the page popping,
     * stalling or lagging on its own.
     */
    private fun judge(name: String, kind: Kind, reference: Frame?, frames: List<Frame>) {
        findings.append("$name: ${frames.size} frames${if (kind == Kind.RECORD) " (recorded, not judged by the band: the panel stands in it)" else ""}\n")
        reference?.let { findings.append(describe(it, "before")) }
        for (frame in frames) findings.append(describe(frame))
        if (frames.isEmpty()) {
            failures += "$name: no frame could be taken"
            return
        }
        if (kind == Kind.RECORD) return
        val series = listOfNotNull(reference) + frames
        var worst = 0.0
        for (frame in series) {
            val b = frame.band
            if (b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3) {
                failures += "$name at ${frame.at} ms: the window gradient where the page was (band chroma %.1f edges %.4f page-like %.2f)".format(b.chroma, b.edges, b.pageLike)
                continue
            }
            val d = darkness(b.luminance)
            if (d.isNaN() || frame.progress.isNaN()) continue
            val gap = abs(d - frame.progress)
            worst = max(worst, gap)
            if (gap > TOLERANCE + NOISE / (bright - dark)) {
                failures += "$name at ${frame.at} ms: the page is %.0f%% of the way dark while the sheets' progress is %.0f%%".format(d * 100, frame.progress * 100)
            }
        }
        findings.append(
            "  progress %.2f → %.2f, darkness %.2f → %.2f, largest disagreement %.0f%% of the way\n".format(
                series.first().progress, series.last().progress,
                darkness(series.first().band.luminance), darkness(series.last().band.luminance), worst * 100
            )
        )
    }

    private fun describe(frame: Frame, label: String = "${frame.at} ms"): String =
        "  %10s  p %.3f dark %.3f  lum %5.1f chroma %5.1f edges %.4f page-like %.2f\n".format(
            label, frame.progress, darkness(frame.band.luminance),
            frame.band.luminance, frame.band.chroma, frame.band.edges, frame.band.pageLike
        )

    /** JPEG: a PNG of the window takes the emulator longer than the next frame. */
    private fun save(bitmap: Bitmap, name: String) {
        File(out, "leave-$name.jpg").outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it) }
    }

    private fun finding(line: String) {
        findings.append(line).append('\n')
        Log.i(tag, line)
    }

    companion object {
        private const val PORT = 18134
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB_ID = "tab_article"
        private const val CHANGE_ICON = "Change Icon…"
        /** The icon picker's heading. */
        private const val PICKER_TITLE = "Change icon"
        /** The location prompt's heading starts so. */
        private const val LOCATION_TITLE = "Allow"
        /** What the page runs to ask for its location: the prompt is the core's, in `state`. */
        private const val LOCATION_REQUEST = "navigator.geolocation.getCurrentPosition(function(){},function(){})"
        /** A frame-dialog slide is the sheet's whole height: at least this (CSS px), not a 24 px pop. */
        private const val MIN_TRAVEL_CSS_PX = 120.0
        /**
         * How far the root's recede may stand under a leaving sheet's own presence in one pose:
         * the two are read in one script evaluation, but the sheet's offset is the motion's last
         * write and the root's value the registry's, a frame apart at most.
         */
        private const val LEAVE_TOLERANCE = 0.06
        /** How often the chrome is read while a probe runs (a script round trip costs some of it). */
        private const val POSE_MS = 60L
        /**
         * Poses after the store's write from which a way down of some hundreds of milliseconds
         * must have been caught part-way; fewer means the emulator starved the poller.
         */
        private const val POSES_TO_CATCH = 8
        /**
         * Long enough for the whole of a transition on the recording emulator, whose two to five
         * frames a second stretch a half-second spring to about three, after a wait of up to
         * three for the page's picture before a sheet comes up.
         */
        private const val PROBE_MS = 6_500L
        /** The longest a spring is given to land, on that emulator. */
        private const val SETTLE_MS = 8_000L
        /** Brightness (0…255) two frames of the same picture differ by, JPEG and dithering included. */
        private const val NOISE = 2.0
        /**
         * How far apart, as a share of the whole way, the page's darkness and the sheets' progress
         * may be in one frame: the picture's brightness differs from the live page's by under a
         * hundredth of the way, the receded frame's content shifts by less, and the recorder adds
         * its noise; a sheet vanishing with the page still dark was half the way or more apart.
         */
        private const val TOLERANCE = 0.08
        /** The swatch starts this far across the screen and runs this share of it at full progress. */
        private const val SWATCH_START_SHARE = 0.21f
        private const val SWATCH_LENGTH_SHARE = 0.55f
        private const val SWATCH_HEIGHT_DP = 9f

        /**
         * One reading of the chrome, as JSON: the root's `--zen-recede`; the store's open menu
         * and external-protocol request (through the stores' module registry, `__zenStores`);
         * every sheet layer – leaving (`data-leaving`, the chassis's mark for a sheet whose request
         * is gone) or not, inert or not, its offset (CSS px, from the inline transform) and its
         * height (its travel: it stands at 0 at its detent and at its height off the screen), and
         * whether it sits in the frame dialog host's slot; and that slot – whether the host is up
         * (`data-sheet-up`), the slide's offset, its travel (the slot's height above the highest
         * panel's top edge), whether a panel is in it and whether that panel is one kept for the
         * way down (`data-leaving`). Sheets on their own chassis inside the slot do not count as
         * its panels. Evaluated as one script, so the numbers are of one moment.
         */
        private val POSE_JS = """
            (function(){
              var cs=getComputedStyle(document.documentElement);
              var p=+cs.getPropertyValue('--zen-recede')||0;
              var st=window.__zenStores&&window.__zenStores.ui?window.__zenStores.ui.get():null;
              var layers=[];
              var ls=document.querySelectorAll('[data-sheet-layer]');
              for(var i=0;i<ls.length;i++){
                var l=ls[i];var s=l.querySelector('.zen-sheet');
                var m=s?/translate3d\(0(?:px)?, ?(-?[\d.]+)px/.exec(s.style.transform||''):null;
                var h=s?parseFloat(s.style.height):NaN;
                layers.push({leaving:l.hasAttribute('data-leaving'),inert:!!(s&&s.hasAttribute('inert')),
                  ty:m?+m[1]:null,h:isFinite(h)?h:null,hosted:!!l.closest('.zen-frame-dialogs-slot')});
              }
              var slot=null;var el=document.querySelector('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot');
              if(el){
                var mm=/translate3d\(0(?:px)?, ?(-?[\d.]+)px/.exec(el.style.transform||'');
                var top=Infinity,panel=false,kept=false;
                for(var j=0;j<el.children.length;j++){var c=el.children[j];if(c.hasAttribute('data-sheet-layer'))continue;
                  panel=true;if(c.hasAttribute('data-leaving'))kept=true;top=Math.min(top,c.offsetTop);}
                slot={up:el.parentElement.hasAttribute('data-sheet-up'),ty:mm?+mm[1]:null,
                  travel:top===Infinity?null:el.clientHeight-top,panel:panel,kept:kept};
              }
              return JSON.stringify({p:p,menu:st&&st.menu?st.menu.id:null,
                ext:st&&st.externalProtocol?st.externalProtocol.requestId:null,layers:layers,slot:slot});
            })()
        """.trimIndent()
    }
}
