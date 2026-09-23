package app.zen.chromium

import android.app.UiAutomation
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileInputStream
import kotlin.math.roundToInt

/**
 * The new tab page's field becoming the omnibox (NTP-02 / MOT-08, design language v2 §11.8) on
 * the emulator, under real fingers, judged frame by frame. The chrome samples itself once per
 * animation frame while a scene runs ([SAMPLER]: the machine's phase, the two values on the
 * root, the scroll, and the box and opacity of every incarnation of the field – the page's own,
 * the double, the omnibox's field, the pill's slot) and hands the frames to [FakeboxMorph], the
 * judge shared with the JVM tests (`FakeboxMorphJudgeTest`), whose verdicts are the lines of the
 * findings file. A verdict that fails fails the run (`AssertionError` at the end, the recording
 * and the stills kept); the frames of every scene are written next to the findings.
 *
 * The scenes, by driver (the two flags):
 *  - [FakeboxMorphDemo] (`scrub = false, reduced = false`), the space page in portrait: a tap on
 *    the field at rest with the bar docked below – the field flies to the omnibox above the
 *    keyboard, whose rise moves the target under the segment – and its dismissal from open by a
 *    finger on the scrim; a second tap on the double mid-flight (nothing: the flight goes on to
 *    land); with the keyboard out of the way (the
 *    IME disabled for the scene, since a back with it up goes to it), the predictive back gesture
 *    committing while the field is still flying (a dismissal mid-flight), a tap on the double on
 *    its way back (the closing turning round into an opening), and the gesture on the landed
 *    omnibox: pulled and held, let go at the edge (cancelled, the field springs back), pulled and
 *    committed (the field is already home: the bar closes at once), and the morph's frame cost
 *    for the perf program's table – the opening and the closing spring measured unsampled by the
 *    harness's one instrument ([morphCost]: `measureFrames` with the chrome WebView's trace); then
 *    the bar docked above, the tap and the dismissal again and the cost again; last the
 *    coordinator's question – how often does the
 *    scrub engage on the space page? – measured: the page's overflow in portrait with the most
 *    visited row full (eight tiles, the cap), again under the system font size at 1.3 (the
 *    chrome's text does not follow it today, so the answer is expected to be the same), and
 *    turned to landscape; wherever the page overflows past the travel the scrub runs once more
 *    as a cheap second scene, and where it does not the findings say so.
 *  - [FakeboxMorphScrubDemo] (`scrub = true`), the private page in landscape, where the page
 *    overflows by the explainer's height: a steady finger scrolling the page carries the field –
 *    with the bar below, the page's own field rides up one to one and hands over to the pill by a
 *    cross-fade at the frame's top edge (§11.8 as amended); with the bar above, the double is
 *    carried along the line to the pill's slot, rounding as it goes, and hands over over the last
 *    three tenths – a tap on the docked pill (the plain open: nothing left to morph), then the
 *    scroll back, and a tap on the field part way (from a scrubbed pose) with its dismissal back
 *    to that pose; and the scrub's frame cost at each dock ([scrubCost], the same finger
 *    unsampled and traced). It needs the Chromium snapshot WebView (private tabs
 *    need `MULTI_PROFILE`, which the API 34 image's WebView 113 lacks), the private demo's recipe.
 *  - [FakeboxMorphReducedDemo] and [FakeboxMorphScrubReducedDemo] (`reduced = true`) run the
 *    tap and the dismissal (and, on the private page, from a scrubbed pose) in a FRESH process
 *    under `animator_duration_scale 0`: Chromium reads the scale into `prefers-reduced-motion`
 *    once per process (the loading demo saw a live change ignored), so the wrapper script sets
 *    it between drivers, and the driver refuses to run when the WebView does not report it
 *    ([REDUCED_MOTION_NOT_REPORTED]: the script then forces the query through the WebView's
 *    command-line file and runs the driver again). Under it the spring's part is a 120 ms fade
 *    in place, nothing travels, and the scrub still follows the finger (§11.3). Reduced motion
 *    is NO transition, not a shortened one (§11.3 as ruled; a shortened transition draws its
 *    start value until the compositor starts it – a frame of stale geometry, the page hidden
 *    1.0–1.3 s after the commit in #243's runs): the space page's driver also opens and closes
 *    the menu sheet ([sheetOpenClose]) and every reduced scene is judged for the page visible on
 *    the commit's first frame, no frame of stale geometry, and what the stylesheet resolves to
 *    (nothing shortened; the kept fades opacity-only at 120 ms). `android-reduced-motion-demo.yml`
 *    runs this driver alone, light and dark, on the branch's stylesheet and on main's.
 *
 * The bar's hide-on-scroll stays gated off on the page throughout (the two scroll-driven motions
 * never meet, #200): every sample carries the gate and the value. Gesture navigation is turned
 * on for the run (the predictive back is an edge swipe). See [DemoHarness] for the plumbing.
 */
abstract class FakeboxMorphDemoBase(
    private val scrub: Boolean,
    private val reduced: Boolean,
    private val shotPrefix: String,
    handshakeDir: String
) : DemoHarness("fakebox-morph-demo-state.json", shotPrefix, handshakeDir) {
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var imeIds: List<String> = emptyList()
    private var fontScaled = false
    private var scenes = 0

    /** The whole run: the harness's sequence, the device put back, the verdicts' failures thrown at the end. */
    protected fun runMorphDemo() {
        var fault: Throwable? = null
        try {
            runDemo()
        } catch (e: Throwable) {
            fault = e
        } finally {
            restoreDevice()
            PrivateBrowsing.captureForRecording = false
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.message}" } ?: "")
            )
        }
    }

    /** The seeded profile's colour scheme, from the `theme` argument (`DEMO_THEME`): the reduced-motion act records light and dark. */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The most visited tiles the page shows (letter tiles: no favicons are fetched for the hosts). */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = STAMP.replace(readAsset("fakebox-morph-demo-history.json")) { m ->
            val hours = m.groupValues[1].toLongOrNull() ?: 0L
            (now - hours * 3_600_000L).toString()
        }
        File(zen, "history.json").writeText(history)
    }

    /** The predictive back is an edge swipe: gesture navigation (the shared script sets three buttons). */
    override fun beforeLaunch() {
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        // The recording must show the private surface (its window carries FLAG_SECURE otherwise).
        if (scrub) PrivateBrowsing.captureForRecording = true
        SystemClock.sleep(1_500)
    }

    private fun restoreDevice() {
        if (imeIds.isNotEmpty()) enableIme()
        if (fontScaled) fontScale(null)
        ui.setRotation(UiAutomation.ROTATION_UNFREEZE)
    }

    // --- warm-up ---------------------------------------------------------------------------------

    override fun warmUp() {
        findings = File(out, "$shotPrefix-findings.txt")
        findings.writeText(
            "Zenium Android new tab page field morph (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "${if (scrub) "the private page in landscape" else "the space page in portrait"}${if (reduced) ", reduced motion" else ""}, $THEME)\n" +
                "Judged frame by frame by FakeboxMorphJudge (design language v2 §11.8); one line per check, PASS or FAIL.\n\n"
        )
        finding("start: ${describeActive()}; WebView ${webViewVersion()}")
        val installed = jsString(SAMPLER)
        finding("sampler: $installed")
        if (activeCoreTab()?.optString("url") != BLANK_URL) {
            coreInvoke("tab.new")
            SystemClock.sleep(2_500)
        }
        if (scrub) openPrivatePage()
        awaitChrome("!!document.querySelector('.zen-ntp-field')", 10_000)
        SystemClock.sleep(1_500)
        val g = readGeometry()
        finding("page: ${describeGeometry(g)}")
        val reducedNow = g.optBoolean("reduced")
        finding("prefers-reduced-motion: $reducedNow (expected $reduced); animator_duration_scale ${shell("settings get global animator_duration_scale").trim()}")
        // Before the recording handshake, so the wrapper script reads the marker in instrument.txt
        // and takes the fallback (or stops) instead of recording scenes under the wrong form.
        if (reduced && !reducedNow) error("$REDUCED_MOTION_NOT_REPORTED: the WebView reports prefers-reduced-motion false in a fresh process under animator_duration_scale 0")
        if (!reduced && reducedNow) error("$REDUCED_MOTION_LEFT_ON: the WebView reports prefers-reduced-motion true; the animator scale or the command-line file was left over from a reduced run")
        // The first morph pays for the layer's first layout and the omnibox's first open: off camera.
        tapField()
        awaitPhase("open", 8_000)
        SystemClock.sleep(1_200)
        val close = closeUrlField()
        finding("warm-up morph: ${close.describe()}")
        awaitPhase("rest", 6_000)
        SystemClock.sleep(1_500)
        finding("warm-up done: ${describeActive()}\n")
    }

    /**
     * The private new tab page, turned to landscape (`UiAutomation.setRotation`, as LayoutDemo
     * does: the activity keeps its instance and the chrome re-lays itself out): the explainer
     * makes the page overflow, so the scroll can carry the field all the way to the pill's slot.
     */
    private fun openPrivatePage() {
        val id = coreInvoke("tab.newPrivate", "{}")
        finding("private tab: $id")
        if (id == "null" || id.isEmpty()) error("the core offers no private tabs on this WebView (MULTI_PROFILE missing)")
        SystemClock.sleep(2_500)
        rotate(UiAutomation.ROTATION_FREEZE_90)
    }

    private fun rotate(rotation: Int) {
        ui.setRotation(rotation)
        SystemClock.sleep(5_000)
        ensureForeground()
        remeasureWindow()
    }

    /** The window's size after a rotation (the harness measured it in portrait). */
    private fun remeasureWindow() {
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        touchable = touchableBand(insets)
        Log.i(tag, "window now ${width}x$height, touchable $touchable")
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        shot("00-rest")
        when {
            scrub && reduced -> scrubReducedScenes()
            scrub -> scrubScenes()
            reduced -> reducedScenes()
            else -> morphScenes()
        }
        finding("\nend: ${describeActive()}; ${failures.size} check(s) failed")
    }

    /**
     * The space page in portrait: both docks, the keyboard, the back gesture, the turn, the morph's
     * frame cost (with the keyboard disabled, among the back gesture scenes), the overflow question.
     */
    private fun morphScenes() {
        tapAndDismiss("bottom-rest", edge = "bottom", keyboard = true, dismiss = "scrim")
        retapMidFlight("bottom-retap")
        disableIme()
        midFlightBack("bottom-midflight-back")
        turnRound("bottom-turn")
        pulled("bottom-pulled")
        morphCost("bottom")
        enableIme()
        dock("top")
        tapAndDismiss("top-rest", edge = "top", keyboard = true, dismiss = "scrim")
        disableIme()
        morphCost("top")
        enableIme()
        dock("bottom")
        portraitOverflow()
        landscapeOverflow()
    }

    /** The private page in landscape: the scrub at both docks, to the slot and back, a tap part way, and the scrub's frame cost. */
    private fun scrubScenes() {
        scrubToDock("bottom-scrub", edge = "bottom")
        tapPartWay("bottom-partway", edge = "bottom")
        scrubCost("bottom")
        dock("top")
        scrubToDock("top-scrub", edge = "top")
        tapPartWay("top-partway", edge = "top")
        scrubCost("top")
        dock("bottom")
    }

    /**
     * Reduced motion on the space page: the tap and the dismissal are fades in place, at both
     * docks, and the menu sheet's open and close at the bottom dock are the same fade – the sheet
     * where the spring jumped it, the page under it neither receding nor moving.
     */
    private fun reducedScenes() {
        tapAndDismiss("reduced-bottom", edge = "bottom", keyboard = true)
        sheetOpenClose("reduced-sheet")
        dock("top")
        tapAndDismiss("reduced-top", edge = "top", keyboard = true)
        dock("bottom")
    }

    /** Reduced motion on the private page: the scrub still follows the finger; a tap part way fades the double in place. */
    private fun scrubReducedScenes() {
        scrubToDock("reduced-bottom-scrub", edge = "bottom")
        dock("top")
        scrubToDock("reduced-top-scrub", edge = "top")
        tapPartWay("reduced-top-partway", edge = "top")
        dock("bottom")
    }

    // --- scenes ----------------------------------------------------------------------------------

    /**
     * A finger on the field at rest: the field flies to the omnibox (over the keyboard, whose rise
     * moves the target under the segment at a bottom dock), lands, and the dismissal runs it
     * home – a real finger on the omnibox's scrim (`dismiss = "scrim"`: the largest free band of
     * the frame beside the sheet, the field and the keyboard, [scrimPoint]; with the keyboard up
     * in portrait there is none, so one back puts the keyboard away first – the back the shared
     * close would spend on it – and the finger goes to the band it frees; the shared close when
     * none is 48 px tall even then) or the shared close by the chrome's state (a back for the
     * keyboard, one for the field). Both reach the same held close (`interceptUrlbarClose`).
     */
    private fun tapAndDismiss(scene: String, edge: String, keyboard: Boolean, dismiss: String = "back") {
        section(
            "$scene: a tap on the field at rest, the bar docked $edge${if (keyboard) ", the keyboard rising" else ""}, " +
                "dismissed by ${if (dismiss == "scrim") "a tap on the scrim" else "the shared close"}"
        )
        settleAtRest()
        val g = geometry()
        startSampling()
        val touched = tapField()
        val opened = awaitPhase("open", 8_000)
        if (keyboard) awaitIme(shown = true, timeoutMs = 6_000)
        SystemClock.sleep(900)
        shot("$scene-open")
        val opening = stopSampling(scene + "-opening")
        finding("  touch at $touched; phase ${phaseNow()}; ${FakeboxMorph.describe(opening)}; keyboard inset ${imeInset()} px")
        if (!opened) touchFault("the touch on the field did not open the omnibox ($scene)")
        judge(scene, opening, reducedRun = reduced, g = g, opening = true)

        startSampling()
        var keyboardPutAway = false
        var scrim = if (dismiss == "scrim") tapScrim() else null
        if (dismiss == "scrim" && scrim == null && imeShown()) {
            back()
            keyboardPutAway = awaitIme(shown = false, timeoutMs = 4_000)
            SystemClock.sleep(600)
            scrim = tapScrim()
        }
        val close = if (scrim == null) closeUrlField() else null
        val rested = awaitPhase("rest", 6_000)
        SystemClock.sleep(700)
        shot("$scene-closed")
        val closing = stopSampling(scene + "-closing")
        val keyboard = if (keyboardPutAway) "the keyboard put away by one back first; " else ""
        val how = when {
            scrim != null -> "${keyboard}scrim tapped at $scrim"
            dismiss == "scrim" -> "${keyboard}no scrim to tap (the sheet and the field fill the frame): the shared close instead, ${close?.describe()}"
            else -> close?.describe()
        }
        finding("  $how; phase ${phaseNow()}; ${FakeboxMorph.describe(closing)}")
        check(scene, "the dismissal brought the field home", (close?.ok ?: true) && rested && !urlbarOpen(), "at rest $rested, bar open ${urlbarOpen()}")
        judge(scene, closing, reducedRun = reduced, g = g, opening = false)
    }

    /**
     * The menu sheet under reduced motion (§11.3, no transition): a real finger on the bar's Menu
     * button – the sheet spring jumps the sheet to its detent and the chassis fades it and its
     * scrim in over 120 ms where it stands (`BottomSheet`, main.css's `.zen-sheet-detents` rule),
     * the page under it neither receding (the recede's gain is 0) nor moving – and a finger on
     * the scrim above it takes it down the same way: the fade out, then the jump off and the
     * unmount. Judged for its place (no frame at a pose before the jump: the stale geometry a
     * shortened transition on the written transform drew), its fade (120 ms, over more than one
     * frame), the page's geometry (steady, visible, unscaled) and what the stylesheet declares
     * on the frame's elements (no shortened duration left; opacity alone at 120 ms).
     */
    private fun sheetOpenClose(scene: String) {
        section("$scene: the menu sheet opened by a finger on Menu and closed by a finger on its scrim, under reduced motion")
        settleAtRest()
        startSampling()
        tapMenuButton()
        val up = awaitSheet(up = true, timeoutMs = 6_000)
        SystemClock.sleep(900)
        shot("$scene-open")
        val opening = stopSampling("$scene-opening")
        val stood = snapshot()
        finding("  Menu tapped; sheet up $up at ${stood.optJSONObject("sl")?.let { box(it) }} (opacity ${"%.2f".format(stood.optDouble("so"))}); ${FakeboxMorph.describe(opening)}")
        if (!up) touchFault("the touch on Menu did not bring the sheet up ($scene)")
        judgeSheet(scene, opening, opening = true)

        startSampling()
        val scrim = tapSheetScrim(stood)
        if (scrim == null) back()
        val down = awaitSheet(up = false, timeoutMs = 6_000)
        SystemClock.sleep(700)
        shot("$scene-closed")
        val closing = stopSampling("$scene-closing")
        finding("  ${scrim?.let { "scrim tapped at $it" } ?: "no sheet box to aim beside: a back instead"}; sheet gone $down; ${FakeboxMorph.describe(closing)}")
        check(scene, "the sheet went down and left the DOM", down, "a sheet layer in the DOM: ${!down}")
        judgeSheet(scene, closing, opening = false)
    }

    /** A real finger on the sheet's scrim, midway between the frame's top and the sheet's top edge; null with no sheet box. */
    private fun tapSheetScrim(stood: JSONObject): PointF? {
        val sheet = stood.optJSONObject("sl")?.let { box(it) } ?: return null
        val frameTop = readGeometry().optDouble("frameTop", 0.0).toFloat()
        if (sheet.y - frameTop < 48f) return null
        val p = PointF(sheet.cx * density, (frameTop + sheet.y) / 2 * density)
        Finger().tap(p.x, p.y)
        return p
    }

    private fun awaitSheet(up: Boolean, timeoutMs: Long): Boolean = awaitChrome(
        if (up) "(function(){var s=document.querySelector('[data-sheet-layer] .zen-sheet-detents');return !!s&&parseFloat(getComputedStyle(s).opacity)>0.97})()"
        else "!document.querySelector('[data-sheet-layer]')",
        timeoutMs
    )

    /** The checks a sheet scene's frames are held to under reduced motion: the sheet's place and fade, the geometry, the page, the declarations, the bar's gate. */
    private fun judgeSheet(scene: String, frames: List<FakeboxMorph.Frame>, opening: Boolean) {
        if (frames.isEmpty()) {
            fail(scene, "no frames were sampled")
            return
        }
        report(scene, FakeboxMorph.sheetInPlace(frames))
        report(scene, FakeboxMorph.sheetFade(frames, opening))
        report(scene, FakeboxMorph.steadyGeometry(frames))
        report(scene, FakeboxMorph.pageShows(frames))
        report(scene, FakeboxMorph.declaredFades(frames))
        report(scene, FakeboxMorph.barStays(frames))
    }

    /**
     * A second tap on the double mid-flight is nothing (the machine: a tap on a field opening or
     * open changes nothing), and the field goes on to land as if untouched – a real finger on the
     * double's `pointer-events-auto` over the omnibox's scrim, the layer's own guard. The double
     * is caught anywhere on its way ([RETAP_FROM] to [RETAP_TO] of the value: the omnibox opening
     * under it and the keyboard rising put the emulator's chrome at a frame or two a second, and
     * a reading of the machine comes back about once a frame, so a narrow window is never seen),
     * and the tap is aimed a little ahead of the box toward the omnibox's field, where the box
     * will be over the tap's 60 ms ([RETAP_LEAD]: less than the turn's, since the box is caught
     * at any pace of the spring's, the fastest included).
     */
    private fun retapMidFlight(scene: String) {
        section("$scene: a second tap on the double mid-flight changes nothing")
        settleAtRest()
        val g = geometry()
        startSampling()
        tapField()
        var retapped: PointF? = null
        var at = ""
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            val s = snapshot()
            val ph = s.optString("ph")
            val m = s.optDouble("m", 0.0)
            if (ph == "opening" && m > RETAP_FROM && m < RETAP_TO) {
                val box = s.optJSONObject("d") ?: break
                val target = s.optJSONObject("of")
                val cy = (box.getDouble("y") + box.getDouble("h") / 2).toFloat()
                val ty = target?.let { (it.getDouble("y") + it.getDouble("h") / 2).toFloat() } ?: cy
                val p = PointF(((box.getDouble("x") + box.getDouble("w") / 2) * density).toFloat(), FakeboxMorph.lerp(cy, ty, RETAP_LEAD) * density)
                Finger().tap(p.x, p.y)
                retapped = p
                at = "m ${"%.2f".format(m)}"
                break
            }
            if (ph == "open") break
            SystemClock.sleep(6)
        }
        val opened = awaitPhase("open", 8_000)
        awaitIme(shown = true, timeoutMs = 4_000)
        SystemClock.sleep(900)
        val frames = stopSampling(scene)
        finding("  second tap ${retapped?.let { "at $it ($at)" } ?: "NOWHERE (the flight was over before the double was caught between $RETAP_FROM and $RETAP_TO)"}; open $opened; ${FakeboxMorph.describe(frames)}")
        check(scene, "the double was caught mid-flight for the second tap", retapped != null, at.ifEmpty { "not caught" })
        check(scene, "the flight went on to the landing unturned", opened && frames.none { it.phase == "closing" }, "open $opened, phases ${frames.map { it.phase }.distinct()}")
        judge(scene, frames, reducedRun = false, g = g, opening = true)
        closeUrlField()
        awaitPhase("rest", 6_000)
    }

    /**
     * The morph's frame cost, for the perf program's table (PERF-3): two `spring` scenes per dock
     * through [measureFrames], the harness's one instrument – `ntp-morph-open-<edge>`, a real
     * finger on the field at rest, the flight, the landing; `ntp-morph-close-<edge>`, a back from
     * open, the flight home – each with the chrome WebView's trace around it. HWUI's frame times
     * are the emulator's software GPU's and are reported, never judged (the harness floor); the
     * trace's renderer main-thread columns are the ones that carry over to a phone – layouts and
     * paints per frame, main-thread ms per frame, long tasks – and the double is laid out per frame
     * by design (§11.8's exception): this is its measured price. The scenes run with the keyboard
     * disabled, so the frames are the morph's and not the keyboard's inset animation's (the judged
     * `-rest` scenes carry the keyboard), and unsampled: the sampler's reads per frame, or a poll of
     * the machine, are renderer work the trace would count as the chrome's (the harness's rule:
     * the finger and the wait alone inside the window; the bar-hide and sheet drivers wait a fixed
     * time the same way). The window is [COST_WINDOW_MS] from the touch, sized from the emulator's
     * flights in runs 1 and 2 (the opening 4.0 to 5.4 s after the tap on the API 34 image's WebView,
     * the closing 3.6 s; the Chromium 156 WebView about half that), the tail of it idle: the per-frame
     * columns dilute a little toward idle, never up. The machine is read after the window: the field
     * must have landed inside it, or the record covers part of the motion and the check says so.
     */
    private fun morphCost(edge: String) {
        val open = "ntp-morph-open-$edge"
        val close = "ntp-morph-close-$edge"
        section("$open, $close: the morph's frame cost for the perf table (measureFrames, unsampled, traced, the keyboard disabled)")
        awaitShots()
        settleAtRest()
        val p = fieldPoint() ?: run {
            finding("  no field to tap: the cost scenes skipped")
            return
        }
        val opening = measureFrames(open, JankBudget.Kind.SPRING, trace = true) {
            Finger().tap(p.x, p.y)
            SystemClock.sleep(COST_WINDOW_MS)
        }
        var phase = phaseNow()
        finding("  $open: ${costLines(opening)}")
        check(open, "the field had landed when the ${COST_WINDOW_MS} ms window closed", phase.startsWith("open"), "phase $phase")
        if (!awaitPhase("open", 6_000)) {
            finding("  the field never landed: the closing not measured")
            closeUrlField()
            awaitPhase("rest", 6_000)
            return
        }
        SystemClock.sleep(600)
        val closing = measureFrames(close, JankBudget.Kind.SPRING, trace = true) {
            back()
            SystemClock.sleep(COST_WINDOW_MS)
        }
        phase = phaseNow()
        finding("  $close: ${costLines(closing)}")
        check(close, "the field was home when the ${COST_WINDOW_MS} ms window closed", phase.startsWith("rest"), "phase $phase")
        if (!awaitPhase("rest", 6_000)) closeUrlField()
    }

    /**
     * The scrub's frame cost (`gesture`), the same instrument: the steady finger of [scrubToDock]
     * carrying the field the whole travel to the pill's slot in one stroke, unsampled and traced –
     * at a bottom dock the field is content riding one to one with the pill's words fading in, at
     * a top dock the double laid out per frame along the line (§11.8), which is what the scene
     * prices. The finger holds still before it lifts (no fling: the window ends with the finger's
     * motion); the page goes back to the top by the store afterwards, no claim riding on it.
     */
    private fun scrubCost(edge: String) {
        val scene = "ntp-scrub-$edge"
        section("$scene: the scrub's frame cost for the perf table (measureFrames, unsampled, traced)")
        awaitShots()
        settleAtRest()
        val g = geometry()
        val overflow = readGeometry().optDouble("overflow")
        if (overflow < g.travel + 8) {
            finding("  the page overflows by ${"%.1f".format(overflow)} CSS px, short of the travel ${"%.1f".format(g.travel)}: not measured")
            return
        }
        val x = width * 0.5f
        val startY = touchable.exactCenterY() + touchable.height() * 0.2f
        val total = (g.travel + 40f) * density
        val measured = measureFrames(scene, JankBudget.Kind.GESTURE, trace = true) {
            val f = Finger()
            f.down(x, startY)
            f.moveBy(0f, -total, 1_800)
            f.hold(400)
            f.up()
        }
        SystemClock.sleep(600)
        val docked = snapshot()
        finding("  scrolled to ${"%.1f".format(docked.optDouble("sc"))} CSS px, look '${docked.optString("lk")}'; $scene: ${costLines(measured)}")
        check(scene, "the finger carried the field to the slot", docked.optString("lk") == "docked", "look '${docked.optString("lk")}' at ${"%.1f".format(docked.optDouble("sc"))} CSS px")
        settleAtRest()
    }

    /** A measured scene's summary line and its trace line (the table's first two), for the findings. */
    private fun costLines(scene: FrameStats.Scene): String = scene.table().lines().take(2).joinToString(" | ") { it.trim() }

    /**
     * The predictive back gesture committing while the field is still flying: a tap, and the
     * edge swipe the moment the chrome owns the back (the omnibox is up under the field: the
     * host polled every 10 ms, since the system routes the gesture to the app only once its
     * callback stands), a fast flick lifted at once – the pull does not move a flying field
     * (only an open one follows), the commit dismisses it from where it is: a closing segment
     * from a point of the line. The flight is some 300 ms (`SPRING_SNAPPY` over the poses'
     * distance), so the commit is a race with the spring: up to [ATTEMPTS] tries, the first that
     * caught the field in flight (an opening -> closing frame pair) is the one judged.
     */
    private fun midFlightBack(scene: String) {
        section("$scene: the back gesture committed mid-flight (the keyboard disabled for the scene)")
        var caught: List<FakeboxMorph.Frame>? = null
        var g: FakeboxMorph.Geometry? = null
        for (attempt in 1..ATTEMPTS) {
            settleAtRest()
            g = geometry()
            startSampling()
            val tapped = SystemClock.uptimeMillis()
            tapField()
            val owned = awaitSurfaceFast(2_000)
            val ownedAfter = SystemClock.uptimeMillis() - tapped
            val edge = Finger()
            edge.down(EDGE_X, height * 0.5f)
            edge.moveBy(0.3f * width, 0f, 60)
            edge.up()
            val committedAfter = SystemClock.uptimeMillis() - tapped
            val rested = awaitPhase("rest", 8_000)
            SystemClock.sleep(700)
            val frames = stopSampling("$scene-$attempt")
            val turn = (1 until frames.size).firstOrNull { frames[it - 1].phase == "opening" && frames[it].phase == "closing" }
            finding(
                "  attempt $attempt: the chrome owned the back $owned after $ownedAfter ms, the flick was up after $committedAfter ms; " +
                    "the flight turned ${if (turn == null) "NOWHERE (no opening -> closing frame pair: the field had landed)" else "at m ${"%.2f".format(frames[turn - 1].morph)} (${frames[turn].t} ms into the sampling)"}; " +
                    "at rest $rested; ${FakeboxMorph.describe(frames)}"
            )
            if (turn != null && rested) {
                shot("$scene-closed")
                caught = frames
                break
            }
            if (!rested) closeUrlField()
        }
        check(scene, "the commit caught the field in flight (within $ATTEMPTS attempts)", caught != null, if (caught == null) "every commit landed after the field had" else "caught")
        val frames = caught ?: return
        check(scene, "the gesture dismissed the omnibox from mid-flight", frames.last().phase == "rest" && !frames.last().urlbarOpen, "phase ${frames.last().phase}, urlbar open ${frames.last().urlbarOpen}")
        judge(scene, frames, reducedRun = false, g = g!!, opening = null)
    }

    /**
     * A tap on the double on its way back: the omnibox dismissed by a back, and once the field is
     * on its way (the value under [TURN_AT]: the spring past its first frames, the box moving) a
     * finger on the double – the closing turns into an opening with the velocity carried, and
     * lands open. The double turns on a click, which wants the finger down and up on it: the tap
     * is aimed ahead of the box, toward the page's field, where the box will be when the click
     * lands – a lead per try ([TAP_LEADS]), since that lag is the machine's; up to [ATTEMPTS]
     * tries, the first the judge sees turn round (`turnedRound`) is the one kept.
     */
    private fun turnRound(scene: String) {
        section("$scene: a tap on the double on its way back turns it round")
        var kept: List<FakeboxMorph.Frame>? = null
        var g: FakeboxMorph.Geometry? = null
        for (attempt in 1..ATTEMPTS) {
            val lead = TAP_LEADS[(attempt - 1).coerceAtMost(TAP_LEADS.lastIndex)]
            settleAtRest()
            g = geometry()
            tapField()
            awaitPhase("open", 8_000)
            SystemClock.sleep(600)
            startSampling()
            if (!awaitSurfaceFast(2_000)) finding("  the chrome does not own the back; the dismissal may not run")
            back()
            var turned: PointF? = null
            var seen = ""
            val deadline = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < deadline) {
                val s = snapshot()
                val ph = s.optString("ph")
                val m = s.optDouble("m", 1.0)
                if (ph == "closing" && m < TURN_AT) {
                    val box = s.optJSONObject("d") ?: break
                    val rest = g.rest
                    // Ahead of the box: the fraction of the way to the field's rest box it covers before the click lands.
                    val cy = FakeboxMorph.lerp((box.getDouble("y") + box.getDouble("h") / 2).toFloat(), rest.cy, lead)
                    turned = PointF((rest.cx * density), cy * density)
                    seen = "m ${"%.2f".format(m)}, lead $lead"
                    Finger().tap(turned.x, turned.y)
                    break
                }
                if (ph == "rest") break
                SystemClock.sleep(6)
            }
            val opened = awaitPhase("open", 8_000)
            SystemClock.sleep(700)
            val frames = stopSampling("$scene-$attempt")
            val verdict = FakeboxMorph.turnedRound(frames)
            finding("  attempt $attempt: tapped ${if (turned == null) "nowhere (the field was never caught closing under $TURN_AT)" else "at $turned ($seen)"}; open $opened; ${verdict.check}: ${verdict.detail}; ${FakeboxMorph.describe(frames)}")
            if (verdict.ok && opened) {
                shot("$scene-open")
                kept = frames
                break
            }
            if (opened) {
                closeUrlField()
                awaitPhase("rest", 6_000)
            }
        }
        check(scene, "the field was caught on its way back and turned round (within $ATTEMPTS attempts)", kept != null, if (kept == null) "no attempt turned it" else "turned")
        val frames = kept ?: return
        report(scene, FakeboxMorph.turnedRound(frames))
        report(scene, FakeboxMorph.oneSurface(frames))
        report(scene, FakeboxMorph.noJump(frames))
        report(scene, FakeboxMorph.onTheLine(frames, g!!))
        report(scene, FakeboxMorph.landing(frames))
        report(scene, FakeboxMorph.barStays(frames))
        report(scene, FakeboxMorph.resolved(frames.last(), "open", true))
        // Home again for the next scene.
        closeUrlField()
        awaitPhase("rest", 6_000)
    }

    /** [awaitSurface] at 10 ms: the flight is short, and the gesture must begin the moment the chrome owns the back. */
    private fun awaitSurfaceFast(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeSurfaceUp()) return true
            SystemClock.sleep(10)
        }
        return chromeSurfaceUp()
    }

    /**
     * The back gesture on the landed omnibox: pulled part way and held, the field follows the
     * finger back toward the page (a still); let go at the edge, cancelled, it springs back to the
     * omnibox; pulled again and committed, the value runs to 1 first (the field is home) and the
     * bar closes at once – no scrim holding taps after the commit (the first-line's nit 2).
     */
    private fun pulled(scene: String) {
        section("$scene: the back gesture on the landed omnibox – pulled and held, cancelled, then committed")
        settleAtRest()
        val g = geometry()
        tapField()
        awaitPhase("open", 8_000)
        SystemClock.sleep(600)
        startSampling()
        if (!awaitSurface(true, 2_000)) finding("  the chrome does not own the back")
        val f = Finger()
        f.down(EDGE_X, height * 0.5f)
        f.moveBy(0.28f * width, 0f, 520)
        f.hold(900)
        // The chrome's word on the pull, read while the finger holds: the hold has no clock in
        // the system's back, and on the emulator the pull reached the field after the 900 ms
        // (the repairs' third proof run read 'open' at 1.00 with the finger down while the
        // scene's own frames held a pulled pair), so the read waits [PULL_READ_MS] for it.
        var held = snapshot()
        val heldBy = SystemClock.uptimeMillis() + PULL_READ_MS
        while (held.optString("lk") != "pulled" && SystemClock.uptimeMillis() < heldBy) {
            f.hold(100)
            held = snapshot()
        }
        shot("$scene-held")
        // Back to the edge and off: the system cancels a gesture let go where it began.
        f.moveBy(-(0.28f * width) + 4f, 0f, 320)
        f.up()
        SystemClock.sleep(1_200)
        // The spring back to the omnibox at 14 fps takes longer than the 1.2 s (the first two
        // proof runs read it at 0.80 and 0.72, still 'pulled'): the read waits for its rest.
        var cancelled = snapshot()
        val cancelledBy = SystemClock.uptimeMillis() + PULL_READ_MS
        while (!(cancelled.optString("ph") == "open" && cancelled.optString("lk") == "open" && cancelled.optDouble("m") > 0.99) &&
            SystemClock.uptimeMillis() < cancelledBy
        ) {
            SystemClock.sleep(100)
            cancelled = snapshot()
        }
        val frames1 = stopSampling(scene + "-cancel")
        finding(
            "  held: look '${held.optString("lk")}', value ${"%.2f".format(held.optDouble("m"))}; " +
                "cancelled: phase ${cancelled.optString("ph")}, look '${cancelled.optString("lk")}', value ${"%.2f".format(cancelled.optDouble("m"))}; ${FakeboxMorph.describe(frames1)}"
        )
        check(scene, "held, the field followed the finger back", held.optString("lk") == "pulled" && held.optDouble("m") < 0.97, "look '${held.optString("lk")}', value ${"%.2f".format(held.optDouble("m"))}")
        check(scene, "cancelled, the field sprang back to the omnibox", cancelled.optString("ph") == "open" && cancelled.optDouble("m") > 0.99 && cancelled.optString("lk") == "open", "phase ${cancelled.optString("ph")}, look '${cancelled.optString("lk")}', value ${"%.2f".format(cancelled.optDouble("m"))}")
        report(scene, FakeboxMorph.oneSurface(frames1))
        report(scene, FakeboxMorph.noJump(frames1))
        report(scene, FakeboxMorph.onTheLine(frames1, g))
        report(scene, FakeboxMorph.barStays(frames1))

        startSampling()
        val c = Finger()
        c.down(EDGE_X, height * 0.5f)
        c.moveBy(0.3f * width, 0f, 420)
        c.hold(300)
        c.up()
        val committed = SystemClock.uptimeMillis()
        val rested = awaitPhase("rest", 8_000)
        val latency = SystemClock.uptimeMillis() - committed
        SystemClock.sleep(600)
        shot("$scene-committed")
        val frames2 = stopSampling(scene + "-commit")
        // The bar's spring runs the field home over the emulator's frames (a 300 ms spring takes
        // seconds at four frames a second, the step clamped per frame), so the claim is by frames:
        // the first rest frame follows the one the field came home on, no frame between holding
        // the bar (and its scrim) over a field at rest. The wall-clock latency is the emulator's.
        val home = frames2.indexOfFirst { it.pulled && it.morph <= 0.01f }
        val rest = frames2.indexOfFirst { it.phase == "rest" }
        val between = if (home >= 0 && rest > home) rest - home - 1 else -1
        finding("  committed: at rest $rested after $latency ms (poll resolution ${POLL_MS} ms); ${FakeboxMorph.describe(frames2)}")
        check(
            scene, "the commit closed the bar at once (no scrim held after it)",
            rested && home >= 0 && rest > home && between <= 1,
            when {
                !rested -> "never at rest"
                home < 0 -> "no pulled frame had the field home (m 0)"
                rest <= home -> "no rest frame after the field came home"
                else -> "the field home on frame $home (${frames2[home].t} ms), at rest on frame $rest (${frames2[rest].t} ms), $between frame(s) between; $latency ms by the clock"
            }
        )
        report(scene, FakeboxMorph.oneSurface(frames2))
        report(scene, FakeboxMorph.noJump(frames2))
        report(scene, FakeboxMorph.barStays(frames2))
        frames2.lastOrNull()?.let { report(scene, FakeboxMorph.resolved(it, "", false)) }
    }

    /**
     * A steady finger scrolling the page: from the top past the travel, holding part way for a
     * still, released without a fling; then the same back to the top. With the bar below the
     * page's field rides up one to one and hands over to the pill by a fade at the frame's top
     * edge; with it above the double is carried along the line to the slot.
     */
    private fun scrubToDock(scene: String, edge: String) {
        section("$scene: a steady finger scrolls the page, the field carried to the pill's slot, the bar docked $edge")
        settleAtRest()
        val g = geometry()
        val travel = g.travel
        val overflow = readGeometry().optDouble("overflow")
        finding("  travel ${"%.1f".format(travel)} CSS px, the page overflows by ${"%.1f".format(overflow)} CSS px")
        check(scene, "the page overflows past the travel", overflow >= travel + 8, "overflow ${"%.1f".format(overflow)}, travel ${"%.1f".format(travel)}")
        val x = width * 0.5f
        val startY = touchable.exactCenterY() + touchable.height() * 0.2f
        val total = (travel + 40f) * density
        startSampling()
        val f = Finger()
        f.down(x, startY)
        f.moveBy(0f, -total * 0.5f, 900)
        f.hold(700)
        shot("$scene-half")
        f.moveBy(0f, -total * 0.5f, 900)
        f.hold(700)
        shot("$scene-docked")
        f.up()
        SystemClock.sleep(900)
        val up = stopSampling(scene + "-up")
        val docked = snapshot()
        finding("  scrolled to ${"%.1f".format(docked.optDouble("sc"))} CSS px: look '${docked.optString("lk")}', pill ${"%.2f".format(docked.optDouble("p"))}; ${FakeboxMorph.describe(up)}")
        report(scene, FakeboxMorph.steadyFinger(up, g))
        report(scene, if (g.dockBelow) FakeboxMorph.ridesWithPage(up, g) else FakeboxMorph.scrubOnTheLine(up, g))
        report(scene, FakeboxMorph.docked(up, g))
        report(scene, FakeboxMorph.oneSurface(up))
        report(scene, FakeboxMorph.noJump(up, g))
        report(scene, FakeboxMorph.barStays(up))
        dockedPillTap(scene, g, docked)

        startSampling()
        // The same finger back to the top: a steady swipe the whole scroll long (and a little over),
        // and where the page is still scrolled when it lifts – the touch slop and the first frames
        // of a swipe move the finger, not the page – another for what is left, up to three.
        var strokes = 0
        var left = snapshot().optDouble("sc").toFloat()
        while (left > 0.5f && strokes < 3) {
            val b = Finger()
            val distance = (left + 20f) * density
            b.down(x, (startY - distance).coerceAtLeast(touchable.top + 24f * density))
            b.moveBy(0f, distance, (900 + 200 * strokes).toLong())
            b.hold(600)
            b.up()
            SystemClock.sleep(900)
            strokes++
            left = snapshot().optDouble("sc").toFloat()
        }
        shot("$scene-back")
        val down = stopSampling(scene + "-down")
        val home = snapshot()
        finding("  scrolled back to ${"%.1f".format(home.optDouble("sc"))} CSS px in $strokes stroke(s): look '${home.optString("lk").ifEmpty { "rest" }}'; ${FakeboxMorph.describe(down)}")
        report(scene, if (g.dockBelow) FakeboxMorph.ridesWithPage(down, g) else FakeboxMorph.scrubOnTheLine(down, g))
        report(scene, FakeboxMorph.oneSurface(down))
        report(scene, FakeboxMorph.noJump(down, g))
        down.lastOrNull()?.let { report(scene, FakeboxMorph.resolved(it, "", false)) }
    }

    /**
     * The pill with the field docked in it, under a real finger: there is nothing left to morph,
     * so the bar opens as a tap on the pill opens it (`tapFakebox` from a scrub of 1: the plain
     * open, no double drawn, the machine at rest), and the shared close puts it away again.
     */
    private fun dockedPillTap(scene: String, g: FakeboxMorph.Geometry, docked: JSONObject) {
        val slot = docked.optJSONObject("pl")
        val s = g.scrubOf(docked.optDouble("sc").toFloat())
        if (slot == null || s < 0.99f) {
            finding("  the field is not docked (s ${"%.2f".format(s)}${if (slot == null) ", no pill" else ""}): the docked pill's tap skipped")
            return
        }
        startSampling()
        val p = PointF(((slot.getDouble("x") + slot.getDouble("w") / 2) * density).toFloat(), ((slot.getDouble("y") + slot.getDouble("h") / 2) * density).toFloat())
        Finger().tap(p.x, p.y)
        val plain = awaitUrlbar(open = true, timeoutMs = 3_000)
        SystemClock.sleep(600)
        shot("$scene-docked-open")
        val frames = stopSampling("$scene-docked-tap")
        val after = snapshot()
        finding("  the docked pill tapped at $p: bar open $plain, phase '${after.optString("ph")}', look '${after.optString("lk")}'; ${FakeboxMorph.describe(frames)}")
        check(
            scene, "a tap on the docked pill opens the bar plainly (nothing left to morph, no double)",
            plain && after.optString("ph") == "rest" && frames.none { it.doubleDrawn },
            "open $plain, phase '${after.optString("ph")}', the double drawn in ${frames.count { it.doubleDrawn }} frame(s)"
        )
        val close = closeUrlField()
        awaitPhase("rest", 4_000)
        SystemClock.sleep(600)
        check(scene, "the bar closed again from the docked pill", close.ok && !urlbarOpen(), close.describe())
    }

    private fun awaitUrlbar(open: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (urlbarOpen() == open) return true
            SystemClock.sleep(POLL_MS)
        }
        return urlbarOpen() == open
    }

    /**
     * A tap on the field part way through the scrub: the page scrolled to [PART_WAY] of the
     * travel and left there (no fling), a finger on the field – the page's own, riding, at a
     * bottom dock; the double at a top dock – and the segment sets out from the scrubbed pose
     * along the line to the omnibox; the dismissal runs it back to that pose.
     */
    private fun tapPartWay(scene: String, edge: String) {
        section("$scene: a tap on the field part way through the scrub, the bar docked $edge")
        settleAtRest()
        val g = geometry()
        val x = width * 0.5f
        val startY = touchable.exactCenterY() + touchable.height() * 0.2f
        val f = Finger()
        f.down(x, startY)
        f.moveBy(0f, -PART_WAY * g.travel * density, 700)
        f.hold(500)
        f.up()
        SystemClock.sleep(1_000)
        val part = snapshot()
        val s = g.scrubOf(part.optDouble("sc").toFloat())
        finding("  scrolled to ${"%.1f".format(part.optDouble("sc"))} CSS px (s ${"%.2f".format(s)}), look '${part.optString("lk")}'")
        check(scene, "the page is held part way", s > 0.15f && s < 0.95f && part.optString("ph") == "rest", "s ${"%.2f".format(s)}, phase ${part.optString("ph")}")
        shot("$scene-partway")
        startSampling()
        val touched = tapField()
        val opened = awaitPhase("open", 8_000)
        awaitIme(shown = true, timeoutMs = 4_000)
        SystemClock.sleep(900)
        shot("$scene-open")
        val opening = stopSampling(scene + "-opening")
        finding("  touch at $touched; phase ${phaseNow()}; ${FakeboxMorph.describe(opening)}")
        if (!opened) touchFault("the touch on the field part way did not open the omnibox ($scene)")
        judge(scene, opening, reducedRun = reduced, g = g, opening = true)

        startSampling()
        val close = closeUrlField()
        val rested = awaitPhase("rest", 6_000)
        SystemClock.sleep(700)
        shot("$scene-closed")
        val closing = stopSampling(scene + "-closing")
        val after = snapshot()
        finding("  ${close.describe()}; phase ${after.optString("ph")}, look '${after.optString("lk")}', scroll ${"%.1f".format(after.optDouble("sc"))}; ${FakeboxMorph.describe(closing)}")
        check(scene, "the dismissal returned the field to the scrubbed pose", close.ok && rested && after.optString("lk") == "scrub", "look '${after.optString("lk")}', scroll ${"%.1f".format(after.optDouble("sc"))}")
        judge(scene, closing, reducedRun = reduced, g = g, opening = false)
        // Back to the top for the next scene.
        val b = Finger()
        b.down(x, startY - PART_WAY * g.travel * density)
        b.moveBy(0f, PART_WAY * g.travel * density + 30f * density, 700)
        b.hold(400)
        b.up()
        SystemClock.sleep(1_000)
    }

    /**
     * The coordinator's question, first half: does the space page overflow in PORTRAIT under any
     * seed? The profile seeds the most visited row full (eight hosts, `MAX_NEW_TAB_SHORTCUTS`),
     * measured as it stands; then under the system font size at 1.3 (`settings put system
     * font_scale`; the activity takes the configuration change in place). The chrome pins the
     * WebView's text zoom at 100 and reads `fontScale` only into the page zoom (A11Y-05 is
     * another worker's), so the second measurement is expected to equal the first: measured
     * rather than assumed, since the answer bears on how often the scrub engages. Where the page
     * does overflow the scrub runs as a cheap second scene.
     */
    private fun portraitOverflow() {
        section("portrait: does the space page overflow under any seed?")
        settleAtRest()
        val seeded = readGeometry()
        val tiles = chromeJs("document.querySelectorAll('.zen-ntp-site').length")
        finding("  eight most visited seeded ($tiles site tile(s) in the tree): ${describeGeometry(seeded)}")
        fontScale("1.3")
        val large = readGeometry()
        finding("  system font size 1.3: ${describeGeometry(large)}")
        shot("portrait-font-1.3")
        val g = toGeometry(large)
        val overflow = large.optDouble("overflow")
        when {
            g != null && overflow >= g.travel + 8 -> {
                finding("  the page overflows past the travel in portrait under the large font: one scrub scene")
                scrubToDock("portrait-scrub", edge = "bottom")
            }
            g != null && overflow > 4 -> {
                finding("  the page overflows by ${"%.1f".format(overflow)} CSS px in portrait, short of the travel (${"%.1f".format(g.travel)}): the scrub engages part way only")
                partialScrub("portrait-partial", g)
            }
            else -> finding("  the page does not overflow in portrait under either seed: the scrub never engages on the portrait space page")
        }
        fontScale(null)
        val back = readGeometry()
        finding("  font size back to 1.0: overflow ${"%.1f".format(back.optDouble("overflow"))} CSS px")
    }

    /**
     * The coordinator's question, second half: turned to landscape the page is measured again
     * (and, where it overflows past the travel, scrubbed once as a cheap second scene).
     */
    private fun landscapeOverflow() {
        section("landscape: does the space page overflow?")
        settleAtRest()
        rotate(UiAutomation.ROTATION_FREEZE_90)
        SystemClock.sleep(1_500)
        val landscape = readGeometry()
        finding("  landscape: ${describeGeometry(landscape)}")
        shot("landscape-rest")
        val g = toGeometry(landscape)
        val overflow = landscape.optDouble("overflow")
        if (g != null && overflow >= g.travel + 8) {
            finding("  the page overflows past the travel in landscape: one scrub scene")
            scrubToDock("landscape-scrub", edge = "bottom")
        } else if (g != null && overflow > 4) {
            finding("  the page overflows by ${"%.1f".format(overflow)} CSS px, short of the travel (${"%.1f".format(g.travel)}): the scrub engages part way only")
            partialScrub("landscape-partial", g)
        } else {
            finding("  the page does not overflow in landscape either: the scrub never engages on the space page")
        }
        rotate(UiAutomation.ROTATION_FREEZE_0)
    }

    /** The system font size (`font_scale`), `null` for the default; the activity re-reads its configuration in place. */
    private fun fontScale(scale: String?) {
        if (scale == null) shell("settings delete system font_scale") else shell("settings put system font_scale $scale")
        fontScaled = scale != null
        SystemClock.sleep(3_000)
        ensureForeground()
        remeasureWindow()
    }

    /** A scrub that cannot reach the travel: the finger takes what overflow there is, and the field is judged part way. */
    private fun partialScrub(scene: String, g: FakeboxMorph.Geometry) {
        val x = width * 0.5f
        val startY = touchable.exactCenterY() + touchable.height() * 0.2f
        startSampling()
        val f = Finger()
        f.down(x, startY)
        f.moveBy(0f, -(g.travel + 40f) * density, 900)
        f.hold(700)
        shot("$scene-held")
        f.up()
        SystemClock.sleep(900)
        val frames = stopSampling(scene)
        val at = snapshot()
        finding("  scrolled to ${"%.1f".format(at.optDouble("sc"))} of ${"%.1f".format(g.travel)} CSS px: look '${at.optString("lk").ifEmpty { "rest" }}'; ${FakeboxMorph.describe(frames)}")
        report(scene, FakeboxMorph.steadyFinger(frames, g))
        report(scene, if (g.dockBelow) FakeboxMorph.ridesWithPage(frames, g) else FakeboxMorph.scrubOnTheLine(frames, g))
        report(scene, FakeboxMorph.oneSurface(frames))
        report(scene, FakeboxMorph.barStays(frames))
        val b = Finger()
        b.down(x, startY - g.travel * density)
        b.moveBy(0f, (g.travel + 60f) * density, 900)
        b.hold(400)
        b.up()
        SystemClock.sleep(900)
    }

    // --- the judge -------------------------------------------------------------------------------

    /**
     * The checks a segment's frames are held to: one surface, no pop, the line, monotone, the
     * words' handover, the bar's gate on every segment; the landing (opening) or the return
     * (closing); under reduced motion the fade in place instead of the line and the words, and
     * §11.3's no-transition checks: the page visible from the commit's first frame, no frame of
     * stale geometry, nothing shortened in the stylesheet and the kept fades opacity-only at
     * 120 ms. `opening` null: a sequence with both directions (the mid-flight turn).
     */
    private fun judge(scene: String, frames: List<FakeboxMorph.Frame>, reducedRun: Boolean, g: FakeboxMorph.Geometry, opening: Boolean?) {
        if (frames.isEmpty()) {
            fail(scene, "no frames were sampled")
            return
        }
        report(scene, FakeboxMorph.oneSurface(frames, reducedRun))
        report(scene, FakeboxMorph.barStays(frames))
        if (reducedRun) {
            report(scene, FakeboxMorph.reducedFade(frames))
            report(scene, FakeboxMorph.pageShows(frames))
            report(scene, FakeboxMorph.steadyGeometry(frames))
            report(scene, FakeboxMorph.declaredFades(frames))
        } else {
            report(scene, FakeboxMorph.noJump(frames))
            report(scene, FakeboxMorph.onTheLine(frames, g))
            report(scene, FakeboxMorph.monotoneSpring(frames))
            // A flight cut short before the half (the mid-flight commit) has no handover to judge.
            if (opening != null || frames.any { it.morph >= 0.5f }) report(scene, FakeboxMorph.wordsHandover(frames))
            else finding("  [$scene] the words at the half: the flight turned before the half (peak m ${"%.2f".format(frames.maxOf { it.morph })}); nothing to judge")
        }
        when (opening) {
            true -> {
                if (!reducedRun) report(scene, FakeboxMorph.landing(frames))
                report(scene, FakeboxMorph.resolved(frames.last(), "open", true))
            }
            false -> {
                if (!reducedRun) report(scene, FakeboxMorph.returned(frames))
                val last = frames.last()
                report(scene, FakeboxMorph.resolved(last, if (last.scroll > 0.5f) last.look else "", false))
            }
            null -> {
                report(scene, FakeboxMorph.returned(frames))
                report(scene, FakeboxMorph.resolved(frames.last(), "", false))
            }
        }
    }

    private fun report(scene: String, v: FakeboxMorph.Verdict) {
        finding("  [$scene] $v")
        if (!v.ok) failures += "$scene: ${v.check} – ${v.detail}"
    }

    private fun check(scene: String, claim: String, ok: Boolean, detail: String) {
        finding("  [$scene] $claim: $detail ${if (ok) "PASS" else "FAIL"}")
        if (!ok) failures += "$scene: $claim ($detail)"
    }

    private fun fail(scene: String, detail: String) {
        finding("  [$scene] $detail FAIL")
        failures += "$scene: $detail"
    }

    // --- the chrome ------------------------------------------------------------------------------

    private fun startSampling() {
        jsString("window.__ntp.start()")
        SystemClock.sleep(120)
    }

    /** Stop the sampler and parse its frames; the raw rows go next to the findings as `<prefix>-frames-<name>.txt`. */
    private fun stopSampling(name: String): List<FakeboxMorph.Frame> {
        val raw = jsString("window.__ntp.stop()")
        scenes++
        File(out, "$shotPrefix-frames-$name.txt").writeText(raw)
        val rows = runCatching { JSONArray(raw) }.getOrElse {
            Log.e(tag, "the sampler's frames did not parse: ${raw.take(200)}")
            return emptyList()
        }
        return (0 until rows.length()).map { FakeboxMorph.parse(rows.getJSONObject(it)) }
    }

    private fun snapshot(): JSONObject = runCatching { JSONObject(jsString("window.__ntp.state()")) }.getOrElse { JSONObject() }

    private fun phaseNow(): String = snapshot().let { "${it.optString("ph")}${it.optString("lk").takeIf { l -> l.isNotEmpty() }?.let { l -> " ($l)" } ?: ""}" }

    private fun awaitPhase(phase: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (snapshot().optString("ph") == phase) return true
            SystemClock.sleep(POLL_MS)
        }
        return snapshot().optString("ph") == phase
    }

    private fun readGeometry(): JSONObject = runCatching { JSONObject(jsString("window.__ntp.geometry()")) }.getOrElse { JSONObject() }

    private fun geometry(): FakeboxMorph.Geometry = toGeometry(readGeometry()) ?: error("the page's geometry could not be read")

    private fun toGeometry(o: JSONObject): FakeboxMorph.Geometry? {
        val rest = o.optJSONObject("rest") ?: return null
        val slot = o.optJSONObject("slot") ?: return null
        return FakeboxMorph.Geometry(box(rest), box(slot), o.optDouble("frameTop", 0.0).toFloat())
    }

    private fun box(o: JSONObject) = FakeboxMorph.Box(o.optDouble("x").toFloat(), o.optDouble("y").toFloat(), o.optDouble("w").toFloat(), o.optDouble("h").toFloat())

    private fun describeGeometry(o: JSONObject): String {
        val g = toGeometry(o)
        return "viewport ${o.optInt("vw")}x${o.optInt("vh")} CSS px, field ${g?.rest}, slot ${g?.slot}, frame top ${"%.1f".format(o.optDouble("frameTop"))}, " +
            "overflow ${"%.1f".format(o.optDouble("overflow"))} CSS px, travel ${g?.travel?.let { "%.1f".format(it) }}, dock ${if (g?.dockBelow == true) "below" else "above"}"
    }

    /** A real finger on the middle of the page's field (its DOM box: the tree trails the page on the emulator). */
    private fun tapField(): PointF? {
        val p = fieldPoint() ?: return null
        Finger().tap(p.x, p.y)
        return p
    }

    /** The middle of the field as it stands (the double's when a scrubbed double is drawn), in window px; null with no field. */
    private fun fieldPoint(): PointF? {
        val s = snapshot()
        val target = s.optJSONObject("pf")?.takeIf { s.optString("lk") != "scrub" || s.optJSONObject("d") == null } ?: s.optJSONObject("d") ?: s.optJSONObject("pf") ?: run {
            Log.w(tag, "no field to tap")
            return null
        }
        val p = PointF(((target.getDouble("x") + target.getDouble("w") / 2) * density).toFloat(), ((target.getDouble("y") + target.getDouble("h") * 0.5) * density).toFloat())
        if (!touchable.contains(p.x.roundToInt(), p.y.roundToInt())) Log.w(tag, "the field's middle $p is outside the touchable window $touchable")
        return p
    }

    /**
     * A point on the omnibox's scrim (the sheet's backdrop, `PhoneSheet`: a press outside the
     * sheet and the field's band dismisses): inside the content frame above the keyboard, clear
     * of the sheet, the omnibox's field, the double over it and the pill's slot – the middle of
     * the tallest free band, on the frame's centre line; null when no band is 48 CSS px tall.
     */
    private fun scrimPoint(): PointF? {
        val g = readGeometry()
        val frame = g.optJSONObject("frame") ?: return null
        val s = snapshot()
        val top = frame.getDouble("y")
        val bottom = minOf(frame.getDouble("y") + frame.getDouble("h"), g.optDouble("vh", Double.MAX_VALUE) - s.optDouble("ib", 0.0))
        val taken = listOf("sh", "of", "d", "pl").mapNotNull { s.optJSONObject(it) }
            .map { it.getDouble("y") to it.getDouble("y") + it.getDouble("h") }
            .sortedBy { it.first }
        var free = top
        var best: Pair<Double, Double>? = null
        for ((y0, y1) in taken + (bottom to bottom)) {
            if (y0 - free >= 48 && (best == null || y0 - free > best.second - best.first)) best = free to y0
            free = maxOf(free, y1)
        }
        val band = best ?: return null
        return PointF(((frame.getDouble("x") + frame.getDouble("w") / 2) * density).toFloat(), ((band.first + band.second) / 2 * density).toFloat())
    }

    /** A real finger on the scrim ([scrimPoint]); null, and nothing tapped, when the frame has no free band. */
    private fun tapScrim(): PointF? {
        val p = scrimPoint() ?: return null
        Finger().tap(p.x, p.y)
        return p
    }

    /** The page unscrolled, the bar closed, the machine at rest, before a scene. */
    private fun settleAtRest() {
        if (urlbarOpen()) closeUrlField()
        awaitPhase("rest", 6_000)
        val s = snapshot()
        if (s.optDouble("sc") > 0.5) {
            jsString("(function(){var s=document.querySelector('.zen-ntp-scroll');if(s)s.scrollTop=0;return ''})()")
            SystemClock.sleep(600)
        }
        SystemClock.sleep(900)
    }

    /** The bar's dock, through the core's settings (the Settings UI is another driver's claim). */
    private fun dock(edge: String) {
        settleAtRest()
        coreInvoke("settings.update", "{\"phoneBarPosition\":${JSONObject.quote(edge)}}")
        SystemClock.sleep(2_500)
        val g = readGeometry()
        finding("\nbar docked $edge: ${describeGeometry(g)}")
        shot("dock-$edge")
    }

    private fun jsString(code: String): String {
        val raw = chromeJs(code)
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
    }

    private fun awaitChrome(condition: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeJs("!!($condition)") == "true") return true
            SystemClock.sleep(200)
        }
        return false
    }

    // --- the device ------------------------------------------------------------------------------

    /**
     * The keyboard out of the way for the back gesture scenes: with the IME up a system back –
     * gesture or key – goes to it and hides the keyboard, never reaching the chrome; a mid-flight
     * commit needs the gesture to reach the chrome while the field flies. `ime disable` for every
     * input method on the device; `ime enable` puts them back ([enableIme]).
     */
    private fun disableIme() {
        imeIds = shell("ime list -s").lines().map { it.trim() }.filter { it.isNotEmpty() }
        for (id in imeIds) shell("ime disable $id")
        SystemClock.sleep(800)
        finding("\nkeyboard disabled for the back gesture scenes: ${imeIds.joinToString()}")
    }

    private fun enableIme() {
        for (id in imeIds) shell("ime enable $id")
        imeIds = emptyList()
        SystemClock.sleep(800)
        finding("\nkeyboard enabled again")
    }

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    private fun webViewVersion(): String =
        runCatching { app.packageManager.getPackageInfo(android.webkit.WebView.getCurrentWebViewPackage()!!.packageName, 0).versionName ?: "?" }.getOrDefault("?")

    // --- the core --------------------------------------------------------------------------------

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${coreState().getJSONObject("tabs").length()} tabs" }

    private fun section(title: String) = finding("\n$title")

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val BLANK_URL = "zen://blank"
        /**
         * The markers a failed precondition puts in `instrument.txt` before the recording handshake;
         * `android-ntp-morph-demo.sh` reads them: on the first it forces the media query through the
         * WebView's command-line file and runs the driver once more, on the second it stops.
         */
        const val REDUCED_MOTION_NOT_REPORTED = "REDUCED_MOTION_NOT_REPORTED"
        const val REDUCED_MOTION_LEFT_ON = "REDUCED_MOTION_LEFT_ON"
        /** Inside the system's gesture inset at the left edge. */
        private const val EDGE_X = 2f
        private const val POLL_MS = 40L
        /** The interruption scenes race the spring (some 300 ms of flight): tries before the scene counts as failed. */
        private const val ATTEMPTS = 3
        /**
         * The closing's value under which the double is caught for the turn. The reading that
         * catches it lags the machine – a snapshot is a round trip through the chrome's main
         * thread and the page's, and the tap's click another – and the emulator stretches both:
         * its closing (`SPRING_SNAPPY` 420 / 40, stepped at most 64 ms a frame on frames 350–500
         * ms apart) is home in 2.1–2.25 s of wall, a reading comes back about once a second and
         * the click lands 0.6–0.95 s after it, so a window opening only in the spring's tail is
         * read late and the click meets the field at rest.
         * The value is under .6 from the spring's third frame (about 80 ms of wall; 67 ms of
         * spring time at a phone's rate), so the first reading past the spring's start
         * qualifies and the click lands with the field still on its way – at .01–.2 on the
         * emulator, in the tail at a phone's rate.
         */
        private const val TURN_AT = 0.6
        /**
         * How far from the box's centre toward the field's rest box the turn's tap is aimed on
         * each try: where the box will be when the click lands. That lag differs by an order of
         * magnitude between the emulator (0.6–0.95 s: from a reading at .3–.6 the box is at .01–.2
         * when the click lands, four fifths of its remaining way home) and a phone (tens of ms:
         * a little way further along), so the tries walk the lead from the emulator's to a
         * phone's; a box some 50 px tall on 260 px of travel forgives about .1 of the value.
         */
        private val TAP_LEADS = floatArrayOf(0.8f, 0.6f, 0.4f)
        /** The opening's values between which the double is caught for the second tap: any pace of the flight but its two ends. */
        private const val RETAP_FROM = 0.1
        private const val RETAP_TO = 0.95
        /** The second tap's lead toward the omnibox's field: a little, since the box may be caught at the spring's fastest. */
        private const val RETAP_LEAD = 0.15f
        /** How far through the travel the page is scrolled for a tap part way. */
        private const val PART_WAY = 0.45f
        /**
         * How long the pulled scene's two reads wait past their sleeps for the state they read –
         * the pull under the held finger, the spring's rest after the cancel – on a chrome
         * drawing at 14 fps with gaps of half a second.
         */
        private const val PULL_READ_MS = 3_000L
        /**
         * The measured window of a cost scene ([morphCost]) from the touch: the flight and its
         * landing with nothing read from the chrome meanwhile. The emulator's flights in runs 1
         * and 2: the opening landed 4.0 to 5.4 s after the tap on the API 34 image's WebView and
         * 2.0 to 2.8 s on the Chromium 156 one, the closing came home in 3.6 s and 2.2 s.
         */
        private const val COST_WINDOW_MS = 7_000L
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)h)?\\}\\}\"")
        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        /**
         * The chrome-side sampler: one row per animation frame while it runs, as [FakeboxMorph.parse]
         * reads it. Opacities are what a pixel of the element is drawn at – its own times every
         * ancestor's, 0 under `visibility: hidden` – but the double's two looks and two contents,
         * which are relative to the double's box; boxes are `getBoundingClientRect` in CSS px.
         * `geometry()` reads the page's rest geometry (the field's natural box with the scroll
         * folded out, the pill's slot, the frame's top edge) and the page's overflow; `state()` one
         * reading of the machine for the driver's own steps. Every row also carries, for the
         * reduced-motion checks (§11.3, no transition): `pv`, the page not `visibility: hidden`;
         * `cf`, the content frame's transform scale (the recede); `dc`, what the stylesheet
         * resolves to on the page's fades, the omnibox sheet, the page, the content column, the
         * bar, the content frame and a sheet's scrim (transition properties and durations,
         * animation names and durations); and `sl` while a sheet is on the chassis
         * (`[data-sheet-layer]`): the detents' box, opacity, translate-y, scale and declarations,
         * the scrim's opacity, and the layer's pending animations.
         */
        private val SAMPLER = """
            (function(){
              if (window.__ntp) return 'ready';
              var S = function(name){ var s = (window.__zenStores || {})[name]; return s && s.get ? s.get() : null; };
              var num = function(v){ var n = parseFloat(v); return isNaN(n) ? 0 : n; };
              var r2 = function(v){ return Math.round(v * 100) / 100; };
              var box = function(el){ var r = el.getBoundingClientRect(); return { x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) }; };
              var own = function(el){ return el ? num(getComputedStyle(el).opacity) : 0; };
              var eff = function(el, pseudo){
                if (!el) return 0;
                var cs = getComputedStyle(el, pseudo || null);
                if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
                var o = num(cs.opacity);
                var p = pseudo ? el : el.parentElement;
                while (p && p !== document.documentElement) {
                  var c = getComputedStyle(p);
                  if (c.visibility === 'hidden' || c.display === 'none') return 0;
                  o *= num(c.opacity);
                  p = p.parentElement;
                }
                return r2(o);
              };
              var q = function(sel, root){ return (root || document).querySelector(sel); };
              var BAR = '.zen-phone-bar:not([aria-hidden])';
              // The elements whose fades the morph runs (or that ride its value): an animation or
              // transition of theirs still pending – no start time yet, the compositor's next frame
              // owed – is the emulator's lag, and the judge excuses the frame under reduced motion.
              var FADED = '.zen-ntp-scroll, .zen-ntp-field, .zen-ntp-fades, .zen-fakebox-layer, .zen-omnibox-sheet, .zen-omnibox-field, .zen-phone-bar';
              var pendingWhere = function(hit){
                if (!document.getAnimations) return 0;
                var n = 0, all = document.getAnimations();
                for (var k = 0; k < all.length; k++) {
                  var a = all[k], tg = a.pending && a.effect && a.effect.target;
                  if (tg && hit(tg)) n++;
                }
                return n;
              };
              var pending = function(){ return pendingWhere(function(tg){ return tg.closest && tg.closest(FADED); }); };
              // The transform's scale (x) and translate-y off the computed matrix: 1 and 0 with none.
              var mat = function(el){
                var t = getComputedStyle(el).transform;
                var m = t && t !== 'none' ? t.match(/matrix(3d)?\((.+)\)/) : null;
                if (!m) return { s: 1, y: 0 };
                var v = m[2].split(',').map(parseFloat);
                return m[1] ? { s: r2(v[0]), y: r2(v[13]) } : { s: r2(v[0]), y: r2(v[5]) };
              };
              // What the stylesheet resolves to on an element: the transition's properties and
              // durations, the animation's names and durations (the judge's Declared; reduced
              // motion must leave no shortened duration and only the 120 ms opacity fades).
              var decl = function(el){ var c = getComputedStyle(el); return { tp: c.transitionProperty, td: c.transitionDuration, an: c.animationName, ad: c.animationDuration }; };
              var DECLARED = { fades: '.zen-ntp-fades', omnibox: '.zen-omnibox-sheet', page: '.zen-ntp', column: '.zen-content-column', bar: BAR, frame: '.zen-content-frame', scrim: '.zen-sheet-scrim' };
              var frames = [], start = 0, raf = 0;
              var sample = function(now){
                var root = document.documentElement, rs = getComputedStyle(root);
                var fm = S('fakebox-morph') || {}, ui = S('ui') || {}, bh = S('bar-hide') || {};
                var scroller = q('.zen-ntp-scroll'), dbl = q('.zen-fakebox'), pf = q('.zen-ntp-field'), of = q('.zen-omnibox-field');
                var bar = q(BAR), pl = q(BAR + ' .zen-phone-pill'), sheet = q('.zen-omnibox-sheet');
                var ntp = q('.zen-ntp'), cf = q('.zen-content-frame'), sl = q('[data-sheet-layer]');
                var row = {
                  t: Math.round(now - start), ph: fm.phase || '', lk: root.dataset.fakebox || '',
                  m: num(rs.getPropertyValue('--zen-ntp-morph')), p: num(rs.getPropertyValue('--zen-ntp-pill')),
                  sc: scroller ? r2(scroller.scrollTop) : 0, uo: !!(ui.urlbar && ui.urlbar.open),
                  ib: num(rs.getPropertyValue('--zen-inset-bottom')),
                  bar: bar ? eff(bar) : -1, sh: sheet ? eff(sheet) : -1, pg: scroller ? eff(scroller) : -1,
                  ba: !!bh.allowed, bh: num(bh.progress), pa: pending(),
                  // The page not `visibility: hidden` (null with no page), the content frame's scale (the recede).
                  pv: ntp ? getComputedStyle(ntp).visibility !== 'hidden' : null, cf: cf ? mat(cf).s : 1
                };
                var dc = {};
                for (var key in DECLARED) { var de = q(DECLARED[key]); if (de) dc[key] = decl(de); }
                row.dc = dc;
                if (sl) {
                  // The sheet chassis (BottomSheet): the detents' box, opacity, transform and declarations, the scrim's opacity.
                  var det = q('.zen-sheet-detents', sl), scr = q('.zen-sheet-scrim', sl);
                  if (det) {
                    var tm = mat(det);
                    row.sl = { b: box(det), o: eff(det), y: tm.y, s: tm.s, so: scr ? own(scr) : 0, dc: decl(det),
                      pa: pendingWhere(function(tg){ return sl.contains(tg); }) };
                  }
                }
                if (dbl) {
                  var fc = q('.zen-fakebox-field .zen-fakebox-content', dbl), fld = q('.zen-fakebox-field', dbl), om = q('.zen-fakebox-omni', dbl);
                  row.d = { b: box(dbl), r: num(getComputedStyle(dbl).borderTopLeftRadius), l: eff(dbl),
                    lf: own(q('.zen-fakebox-look-field', dbl)), lo: own(q('.zen-fakebox-look-omni', dbl)),
                    fw: r2(own(fc) * own(fld)), ow: own(om), mv: dbl.hasAttribute('data-moving') };
                }
                if (pf) row.pf = { b: box(pf), o: eff(pf) };
                if (of) {
                  var ct = 0; for (var i = 0; i < of.children.length; i++) ct = Math.max(ct, eff(of.children[i]));
                  row.of = { b: box(of), bd: eff(of, '::before'), ct: r2(ct) };
                }
                if (pl) {
                  var w = 0; for (var j = 0; j < pl.children.length; j++) w = Math.max(w, eff(pl.children[j]));
                  row.pl = { b: box(pl), aw: pl.classList.contains('zen-pill-away'), w: r2(w) };
                }
                frames.push(row);
                raf = requestAnimationFrame(sample);
              };
              var pill = function(){ var e = q(BAR + ' .zen-phone-pill'); return e ? box(e) : null; };
              window.__ntp = {
                start: function(){ if (raf) cancelAnimationFrame(raf); frames = []; start = performance.now(); raf = requestAnimationFrame(sample); return 'started'; },
                stop: function(){ if (raf) cancelAnimationFrame(raf); raf = 0; var out = JSON.stringify(frames); frames = []; return out; },
                geometry: function(){
                  var pf = q('.zen-ntp-field'), sc = q('.zen-ntp-scroll'), of = q('.zen-omnibox-field') || q(BAR + ' .zen-phone-bar-row');
                  var ca = S('content-area') || {}; var area = ca.area || null;
                  var rest = pf ? box(pf) : null; if (rest && sc) rest.y = r2(rest.y + sc.scrollTop);
                  return JSON.stringify({ rest: rest, slot: pill(), omnibox: of ? box(of) : null, frameTop: area ? r2(area.y) : 0,
                    overflow: sc ? r2(sc.scrollHeight - sc.clientHeight) : 0,
                    frame: area ? { x: r2(area.x), y: r2(area.y), w: r2(area.width), h: r2(area.height) } : null,
                    vw: window.innerWidth, vh: window.innerHeight,
                    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
                },
                state: function(){
                  var fm = S('fakebox-morph') || {}, ui = S('ui') || {}, rs = getComputedStyle(document.documentElement);
                  var sc = q('.zen-ntp-scroll'), dbl = q('.zen-fakebox'), pf = q('.zen-ntp-field'), of = q('.zen-omnibox-field'), sh = q('.zen-omnibox-sheet');
                  var det = q('[data-sheet-layer] .zen-sheet-detents');
                  return JSON.stringify({ ph: fm.phase || '', lk: document.documentElement.dataset.fakebox || '',
                    m: num(rs.getPropertyValue('--zen-ntp-morph')), p: num(rs.getPropertyValue('--zen-ntp-pill')),
                    sc: sc ? r2(sc.scrollTop) : 0, uo: !!(ui.urlbar && ui.urlbar.open), ib: num(rs.getPropertyValue('--zen-inset-bottom')),
                    d: dbl ? box(dbl) : null, pf: pf ? box(pf) : null, pl: pill(), of: of ? box(of) : null, sh: sh ? box(sh) : null,
                    sl: det ? box(det) : null, so: det ? eff(det) : -1 });
                }
              };
              return 'installed';
            })()
        """.trimIndent()
    }
}
