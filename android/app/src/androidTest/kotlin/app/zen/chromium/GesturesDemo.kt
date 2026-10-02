package app.zen.chromium

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import androidx.annotation.RequiresApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/**
 * The gesture cluster of the Android parity matrix (GN-04, GN-08, GN-19, GN-10) on the device,
 * every gesture a real touch, Chrome's behaviour the reference:
 *
 * - GN-08: a hold on the bar's Back opens the tab's history popup (the back entries, "Show full
 *   history"); a row is a jump straight to its entry (`NavigationPopup.java`), in both of v2
 *   §9.13's forms as the lead ruled them: the held finger drags to the row – lit under it as it
 *   passes – and releases, or lets go on no row, the list waiting for its tap.
 * - GN-04: in 3-button navigation mode a drag in from the page's left edge pulls Chrome's arrow
 *   bubble out (`SideSlideLayout.java`); the disc rides the finger, arms past the threshold, and
 *   a release past it goes back; a release short of it springs the disc away and navigates nothing.
 *   The disc is the host's view above the pages (`HistoryNavBubbleView`; the chrome's DOM lies
 *   under them) in a layer clipped to the page frame, read off the view; the drag's state is the
 *   chrome root's `data-*`.
 * - GN-19: in the switcher a horizontal drag over the pane carries the segment's line with the
 *   finger and fades the pane in step; a release past a third of the width (or a fling) picks the
 *   neighbouring segment, a short one settles back (`HubPaneSwipeGestureHandler.java`).
 * - GN-10: a hold on the pill let go in place opens the omnibox with the clipboard row and its
 *   Paste beside Paste and search (`UrlBar.java`, `ToolbarLongPressMenuHandler.java`); Paste puts
 *   the text in the field and submits nothing.
 *
 * - GN-23 / A11Y-14: a touchpad's two-finger swipe (Android 14+ hands it to the window as one
 *   classified fake finger, [TouchpadSwipe]) pulls the same bubble out from anywhere on the page
 *   and a release past the threshold goes back; let go faster than Chrome's 1788 px/s short of
 *   the threshold it navigates all the same (`overscroll_refresh.cc`'s FORCE_ACTIVATION); and
 *   Settings › Accessibility's last row, Chrome's "Swipe between pages using a touchpad",
 *   flipped off under a finger, leaves the swipe to the page (no bubble, no navigation), light
 *   and dark stills of the row taken on the way. On the tablet profile (`-e scenes settings`) the
 *   Settings stills alone run.
 *
 * The last scene switches the emulator to gesture navigation and drags the same edge: the system
 * owns the edges there and the bubble must never appear (Chrome's `checkCanInterceptSwipe`); the
 * scene restores 3-button mode whatever happened. The two finger-driven scenes are measured
 * with the chrome WebView's trace (`history-nav-drag`, `pane-swipe-overview`; GESTURE budget,
 * `frames.txt`; the renderer main thread's long tasks by CPU with the wall count beside them,
 * `trace-<scene>.json.gz`); the workflow holds the core's startup sweeps for the run
 * (`holdBackgroundWork`) so no feed refresh lands in them.
 *
 * The pages are the loopback [DemoServer]'s (no network). The findings land in
 * `gestures-findings.txt` as PASS / FAIL lines; a FAIL fails the run after the stills are flushed.
 * Stills: `gestures-<scene>.png`.
 */
@RunWith(AndroidJUnit4::class)
class GesturesDemo : DemoHarness("gestures-demo-state.json", "gestures", "gestures-demo") {
    override val tag = "GesturesDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme") ?: "light"
    /** `all`, or `settings` for the Accessibility page's stills alone (the tablet profile's run). */
    private val scenes = InstrumentationRegistry.getArguments().getString("scenes") ?: "all"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var checks = 0
    private var failures = 0
    private var clipboardSeededAt = 0L
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/first.html" to DemoServer.page("First stop", "<p>The first page of the history: the drag's last stop.</p>"),
                "/second.html" to DemoServer.page("Second stop", "<p>The middle of the history: a drag in from the left edge goes here from the third.</p>"),
                "/third.html" to DemoServer.page("Third stop", "<p>The end of the history: hold Back for the popup, drag in from the left edge to go back.</p>"),
                "/side.html" to DemoServer.page("Side reading", "<p>The other tab of the switcher.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        Log.i(tag, "$checks claims, $failures failed")
        if (failures > 0) error("$failures of $checks claims did not hold (see gestures-findings.txt)")
    }

    override fun patchState(json: String): String {
        val state = JSONObject(json)
        state.getJSONObject("settings").put("colorScheme", theme)
        return state.toString()
    }

    /** The bubble and the history popup are 3-button mode's: make sure the recipe's mode is on before the app measures its insets. */
    override fun beforeLaunch() {
        if (navMode() != THREE_BUTTON) {
            Log.w(tag, "3-button navigation was not on (${navMode()}): enabling it exclusively")
            shellCommand("cmd overlay enable-exclusive --category $THREE_BUTTON_OVERLAY")
            SystemClock.sleep(3_000)
        }
    }

    override fun warmUp() {
        findings = File(out, "gestures-findings.txt")
        val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"
        findings.writeText(
            "Zenium Android gestures (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, app $version, theme $theme)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("navigation mode at launch: ${navMode()}")
        awaitLoaded(url("first"))
        // The clipboard first: Android's copy chip sits over the bar's corner for a few seconds and
        // the pill scene must find the bar bare.
        seedClipboard()
        calibrateDomBoxes()
        // The history the drags and the popup work on: first -> second -> third, the tab at third.
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${url("second")}"}""")
        awaitLoaded(url("second"))
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${url("third")}"}""")
        awaitLoaded(url("third"))
        SystemClock.sleep(1_000)
        finding("history built: ${describeHistory()}")
        finding("clipboard chip gone: ${awaitClipboardOverlayGone(clipboardSeededAt)}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("00-third-stop")
        if (scenes == "settings") {
            // The tablet profile's run: the Accessibility page's stills, the switch flipped and restored.
            touchpadSwitchStills()
            finding("\nend: $checks claims, $failures failed")
            return
        }
        backHistoryPopup()
        returnToThird()
        backHistoryDragRelease()
        returnToThird()
        backHistoryReleaseNoRow()
        returnToThird()
        edgeDragArmed()
        edgeDragShort()
        edgeDragCloseTab()
        returnToThird()
        touchpadSwipeBack()
        returnToThird()
        touchpadSwipeFling()
        returnToThird()
        touchpadSwitchStills()
        touchpadSwipeRefused()
        spaceSwipes()
        pillHoldPaste()
        gesturalEdgeUntouched()
        finding("\nend: $checks claims, $failures failed")
    }

    // --- GN-08: a hold on Back -------------------------------------------------------------------

    /**
     * At `third` a hold on the bar's Back opens the popup with the two back entries (Chrome's
     * `NavigationPopup`: the entries before the current one, nearest first) and "Show full
     * history"; the row for `first` is a jump of two entries.
     */
    private fun backHistoryPopup() {
        section("GN-08: hold Back for the history popup")
        val target = backButtonPoint() ?: run {
            touchFault("the bar's Back button was not found")
            return
        }
        val f = Finger()
        f.press(target.x, target.y)
        val opened = awaitTrue(3_000) { popupRows() > 0 }
        val rows = popupRows()
        val indexes = js("(function(){return Array.prototype.map.call(document.querySelectorAll('[data-testid=\"back-history-entry\"]'),function(e){return e.getAttribute('data-index')}).join(',')})()")
        val fullRow = js("(function(){return document.querySelector('[data-testid=\"back-history-full\"]')?'yes':''})()") == "yes"
        claim("the popup opened with the finger still down", opened)
        claim("the popup lists the two back entries (indexes $indexes)", rows == 2 && indexes == "1,0")
        claim("the popup ends with Show full history", fullRow)
        f.up()
        SystemClock.sleep(600)
        claim("the popup stayed open after the release (the hold's release is not a click)", popupRows() > 0)
        settle()
        shot("01-back-history-popup")
        val row = domBox("document.querySelector('[data-testid=\"back-history-entry\"][data-index=\"0\"]')")?.let { touchPoint(it) }
        if (row == null) {
            touchFault("the popup's row for the first stop was not touchable")
            shedPopup()
            return
        }
        Finger().tap(row.x, row.y)
        val jumped = awaitTrue(8_000) { activeUrl() == url("first") }
        claim("the row for the first stop jumped two entries back to it (now at ${activeUrl()})", jumped)
        claim("the popup closed on the pick", awaitTrue(3_000) { popupRows() == 0 })
        awaitLoaded(url("first"))
        settle()
        shot("02-after-popup-jump")
    }

    /**
     * At `third` again, the first of v2 §9.13's two forms as the lead ruled them for GN-08 ("the
     * finger never lifts – it drags to a row and releases"): the finger that opened the popup
     * drags through it – the row under it lit as it passes (`useBarHold` sets `data-hold-lit`
     * on the `data-hold-pick` row it stands over; the rows' pressed tone), the light following
     * the finger from the row for `first` to the row for `second` – and lets go there, and the
     * release is the pick (the hold hit-tests its pointerup for the row) – a jump of one entry,
     * the popup gone with it.
     */
    private fun backHistoryDragRelease() {
        section("GN-08: the held finger drags through the popup, the row under it lit, and releases on a row")
        shedPopup()
        val target = backButtonPoint() ?: run {
            touchFault("the bar's Back button was not found")
            return
        }
        val f = Finger()
        f.press(target.x, target.y)
        claim("the popup opened with the finger still down", awaitTrue(3_000) { popupRows() > 0 })
        val first = domBox(entryRow(0))?.let { touchPoint(it) }
        val second = domBox(entryRow(1))?.let { touchPoint(it) }
        if (first == null || second == null) {
            touchFault("the popup's rows for the first and second stops were not both touchable")
            f.up()
            shedPopup()
            return
        }
        // The finger travels from the button over the bar's edge to the row for the first stop ...
        f.moveBy(first.x - target.x, first.y - target.y, 400)
        f.hold(200)
        claim("the row under the finger lit as it passed (data-hold-lit on the row for the first stop; lit: '${litRows()}')", litRows() == "0")
        // ... and on to the row for the second: the light follows it, and the first row's goes out.
        f.moveBy(second.x - first.x, second.y - first.y, 300)
        f.hold(200)
        val tones = rowTones()
        claim("the light followed the finger to the row for the second stop (lit: '${litRows()}')", litRows() == "1")
        claim("the lit row shows the pressed tone (lit ${tones.first}, unlit ${tones.second})", tones.first.isNotEmpty() && tones.first != tones.second)
        shot("02a-hold-drag-lit-row")
        f.up()
        val jumped = awaitTrue(8_000) { activeUrl() == url("second") }
        claim("the held finger released over the row for the second stop jumped one entry back to it (now at ${activeUrl()})", jumped)
        claim("the popup closed on the release's pick", awaitTrue(3_000) { popupRows() == 0 })
        awaitLoaded(url("second"))
        settle()
        shot("02b-after-drag-release-jump")
    }

    /**
     * At `third` once more, §9.13's second form: the held finger wanders off the popup – to the
     * page beside or above it, wherever the screen has the room – and lets go on no row. The list
     * stays up (the chrome layer dismisses a popover on a press outside, never on a release, and
     * the hold eats the release's click), and a tap on the row for `second` then jumps as any
     * tap does.
     */
    private fun backHistoryReleaseNoRow() {
        section("GN-08: the held finger releases on no row, and the list waits for a tap")
        shedPopup()
        val target = backButtonPoint() ?: run {
            touchFault("the bar's Back button was not found")
            return
        }
        val f = Finger()
        f.press(target.x, target.y)
        claim("the popup opened with the finger still down", awaitTrue(3_000) { popupRows() > 0 })
        val popup = domBox("document.querySelector('[data-testid=\"back-history-popup\"]')")
        val row = domBox(entryRow(1))?.let { touchPoint(it) }
        if (popup == null || row == null) {
            touchFault("the popup and its row for the second stop were not both found")
            f.up()
            shedPopup()
            return
        }
        // Off the popup onto the page: beside it when the screen leaves 64 dp there, else above it.
        val roomRight = touchable.right - popup.right
        val aside = if (roomRight >= 64 * density) PointF(popup.right + roomRight / 2f, popup.exactCenterY())
        else PointF(popup.exactCenterX(), popup.top - 48 * density)
        finding("  (the finger lets go ${if (roomRight >= 64 * density) "beside" else "above"} the popup, at ${aside.x.toInt()},${aside.y.toInt()} px)")
        f.moveBy(aside.x - target.x, aside.y - target.y, 400)
        f.hold(200)
        claim("no row is lit with the finger off the popup (lit: '${litRows()}')", litRows().isEmpty())
        f.up()
        SystemClock.sleep(600)
        claim("the popup stayed up after a release on no row", popupRows() > 0)
        settle()
        shot("02c-hold-release-no-row")
        Finger().tap(row.x, row.y)
        val jumped = awaitTrue(8_000) { activeUrl() == url("second") }
        claim("a following tap on the row for the second stop jumped to it (now at ${activeUrl()})", jumped)
        claim("the popup closed on the tap's pick", awaitTrue(3_000) { popupRows() == 0 })
        awaitLoaded(url("second"))
        settle()
        shot("02d-after-no-row-release-tap")
    }

    /** Back to the end of the history for the drags, by the core (no gesture of the matrix). */
    private fun returnToThird() {
        coreInvoke("tab.goToIndex", """{"tabId":"$TAB","index":2}""")
        awaitLoaded(url("third"))
        SystemClock.sleep(1_000)
        finding("(the core put the tab back at the third stop: ${describeHistory()})")
    }

    // --- GN-04: the edge drag --------------------------------------------------------------------

    /**
     * A drag in from the left edge, 200 dp over a second, measured: the bubble is up and
     * `dragging` with the finger held, armed past the 96 dp threshold; the release goes back.
     */
    private fun edgeDragArmed() {
        section("GN-04: the edge drag past the threshold (3-button mode: ${navMode()})")
        claim("3-button navigation is on for the edge drags", navMode() == THREE_BUTTON)
        val y = pageMidY()
        val f = Finger()
        val scene = traceFrames("history-nav-drag", JankBudget.Kind.GESTURE) {
            f.down(EDGE_X_DP * density, y)
            f.moveBy(LONG_DRAG_DP * density, 0f, 1_000)
            f.hold(450)
        }
        val phase = bubblePhase()
        val armed = bubbleArmed()
        val disc = nativeDisc()
        claim("the bubble is up and dragging with the finger held (phase '$phase')", phase == "dragging")
        claim("the bubble is armed past the threshold (root data-armed; disc: $disc)", armed)
        // The chrome's DOM lies under the pages, so the disc is the host's view above them
        // (HistoryNavBubbleView), moved on translation, scale and alpha alone: it is visible,
        // opaque, its leading edge past the threshold, and full – the growth's spring at 1 with
        // the finger held past the threshold (v2 §11.9's .6 → 1).
        claim("the native disc is up above the pages, riding its translation, full past the threshold", disc.up && disc.leadingEdgeDp > NAV_THRESHOLD_DP && disc.scale > FULL_SCALE_FLOOR)
        // The disc's layer clips it to the page frame (the DOM disc's `overflow: hidden`): the
        // frame sits in from the window's edge, and the disc must come out from the frame's side,
        // not show over the gutter. The DOM's box, unshifted: the layer is in window px.
        val frameBox = domBox("(function(){var r=document.querySelector('[data-testid=\"history-nav\"]');return r?r.parentElement:null})()")
            ?.also { it.offset(-domShiftX, -domShiftY) }
        claim("the disc's layer clips to the page frame's box (clip ${disc.clip}; frame $frameBox)", disc.clip != null && frameBox != null && disc.clip.within(frameBox, 2))
        // G3, the arrow's tint (the lead's 04:34 ruling): armed and held well past Chrome's 250 ms,
        // the arrow's paint stands at the accent – the chrome's computed `--v2-accent`, the number
        // `Host.applyTheme` handed the disc – and the pixel at the arrow's shaft says so. A page
        // turn: the plain arrow in the accent, no caption.
        val tint = nativeTint()
        finding("(the tint at the hold: $tint; the chrome's --v2-accent computes to '${chromeAccent()}')")
        claim("the arrow's tint stands at the accent with the finger held past the threshold (tint ${"%.2f".format(tint.value)})", tint.value > 0.97f)
        claim("the arrow's paint is the chrome's accent (arrow ${hex(tint.arrow)}, accent ${hex(tint.accent)})", near(tint.arrow, tint.accent, TINT_TOLERANCE))
        claim("the pixel at the arrow's shaft is the accent (${hex(tint.shaftPixel)})", near(tint.shaftPixel, tint.accent, TINT_TOLERANCE))
        claim("a page turn shows the plain arrow, no caption (${tint.caption})", tint.caption.text == null)
        noteScene(scene)
        shot("03-edge-drag-armed")
        f.up()
        val navigated = awaitTrue(8_000) { activeUrl() == url("second") }
        claim("the release past the threshold went back to the second stop (now at ${activeUrl()})", navigated)
        // A refused drag names its cause at the lift (`history not started: …`), the drag's only trace.
        if (!navigated) finding("(the drag's ZenPull lines: ${pullLog()})")
        claim("the bubble left after the navigation", awaitTrue(4_000) { bubblePhase() == "" })
        awaitLoaded(url("second"))
        settle()
        shot("04-after-edge-drag")
    }

    /**
     * A drag of 60 dp in two halves, a still at each with the finger held: the disc rides the
     * finger out from the frame's side, growing with the approach but short of full, never arms,
     * and the release springs it away with nothing navigated. Unmeasured, so the stills cost the
     * frames nothing.
     */
    private fun edgeDragShort() {
        section("GN-04: a short edge drag springs back")
        val before = activeUrl()
        val y = pageMidY()
        val f = Finger()
        f.down(EDGE_X_DP * density, y)
        f.moveBy(SHORT_DRAG_DP / 2 * density, 0f, 250)
        f.hold(300)
        val riding = nativeDisc()
        finding("(half way, ${SHORT_DRAG_DP / 2} dp of travel with the finger held: disc $riding; phase '${bubblePhase()}')")
        claim("the native disc rides the finger out from the frame's side, un-armed and short of full (disc: $riding)", riding.up && riding.leadingEdgeDp in 1f..NAV_THRESHOLD_DP && riding.scale in MIN_SCALE..FULL_SCALE_FLOOR)
        shot("05-edge-drag-riding")
        f.moveBy(SHORT_DRAG_DP / 2 * density, 0f, 250)
        f.hold(350)
        val phase = bubblePhase()
        val armed = bubbleArmed()
        val disc = nativeDisc()
        claim("the short drag has the bubble dragging (phase '$phase')", phase == "dragging")
        claim("the short drag is not armed", !armed)
        claim("the native disc is up short of the threshold, short of full (disc: $disc)", disc.up && disc.leadingEdgeDp in 1f..NAV_THRESHOLD_DP && disc.scale in MIN_SCALE..FULL_SCALE_FLOOR)
        claim("the disc went further with the finger (${"%.1f".format(riding.leadingEdgeDp)} -> ${"%.1f".format(disc.leadingEdgeDp)} dp)", disc.leadingEdgeDp > riding.leadingEdgeDp)
        claim("and grew with the approach (scale ${"%.3f".format(riding.scale)} -> ${"%.3f".format(disc.scale)})", disc.scale > riding.scale)
        // Short of the threshold the arrow is the text ink: no tint before the drag arms.
        val tint = nativeTint()
        claim("the un-armed arrow is the text ink, not the accent ($tint)", tint.value == 0f && !near(tint.arrow, tint.accent, TINT_TOLERANCE) && tint.captionInk == tint.arrow)
        shot("05-edge-drag-short")
        f.up()
        SystemClock.sleep(1_500)
        claim("the short release navigated nothing (still at ${activeUrl()})", activeUrl() == before)
        claim("the bubble sprang away after the short release", awaitTrue(4_000) { bubblePhase() == "" })
        claim("the native disc went with it (disc: ${nativeDisc()})", !nativeDisc().up)
    }

    /**
     * MOT-27: the back drag at the history's first page. A tab opened from `TAB` (its opener) has
     * nothing behind it; Chrome still takes the drag (`NavigationHandler.canNavigate`: back is
     * always possible) and, armed, widens the bubble into 'Close tab' – the release closes the
     * tab back to its opener. The threshold taps the finger once with Chrome's `KEYBOARD_TAP`
     * (`HistoryNavBubbleLayer`; its `ZenPull` line in the logcat), and not again while the finger
     * is held past it.
     */
    private fun edgeDragCloseTab() {
        section("MOT-27: the back drag at the first page captions 'Close tab' and closes the tab")
        val opener = activeUrl()
        val childId = coreInvoke("tab.create", """{"url":"${url("side")}","active":true,"openerTabId":"$TAB"}""").trim('"')
        awaitLoaded(url("side"))
        SystemClock.sleep(1_000)
        finding("child tab $childId of $TAB: ${describeHistory()}")
        claim("the child tab has no back entry of its own", activeCoreTab()?.optBoolean("canGoBack") == false)
        val tapsBefore = thresholdTaps()
        val y = pageMidY()
        val f = Finger()
        f.down(EDGE_X_DP * density, y)
        f.moveBy(LONG_DRAG_DP * density, 0f, 1_000)
        f.hold(450)
        val phase = bubblePhase()
        val armed = bubbleArmed()
        val disc = nativeDisc()
        val caption = onMain { host.historyNavBubble.shownCaption }
        val target = bubbleCloseTarget()
        claim("the drag at the first page is a drag (phase '$phase')", phase == "dragging")
        claim("and arms past the threshold (root data-armed; disc: $disc)", armed)
        claim("the root names the tab as what the release closes (data-close-target '$target')", target == "tab")
        claim("the native pill carries Chrome's caption for it ($caption)", caption.text == "Close tab" && caption.extent > 0.97f)
        claim("the pill runs out beyond the disc (${"%.0f".format(caption.pillWidthPx)} px against the ${"%.0f".format(BUBBLE_SIZE_DP * density)} px disc)", caption.pillWidthPx > BUBBLE_SIZE_DP * density * 1.5f)
        val tapsHeld = thresholdTaps()
        claim("the threshold tapped once (KEYBOARD_TAP lines in the logcat: $tapsBefore -> $tapsHeld)", tapsHeld - tapsBefore == 1)
        finding("(the tap as the layer logged it, the platform's answer with it: ${lastThresholdTap()})")
        // G3 on the pill: one ink per pill – the caption's text is the arrow's colour, both at the
        // accent with the finger held past the threshold; the pill's fill and hairline are not.
        val tint = nativeTint()
        finding("(the tint on the pill: $tint)")
        claim("the arrow's tint stands at the accent on the armed pill (tint ${"%.2f".format(tint.value)}, arrow ${hex(tint.arrow)}, accent ${hex(tint.accent)})", tint.value > 0.97f && near(tint.arrow, tint.accent, TINT_TOLERANCE))
        claim("the caption wears the arrow's ink (caption ${hex(tint.captionInk)}, arrow ${hex(tint.arrow)})", tint.captionInk == tint.arrow)
        claim("the pill's fill and hairline are untinted (fill ${hex(tint.fill)}, hairline ${hex(tint.border)})", !near(tint.fill, tint.arrow, TINT_TOLERANCE) && !near(tint.border, tint.arrow, TINT_TOLERANCE))
        claim("the pixel at the arrow's shaft is the accent (${hex(tint.shaftPixel)})", near(tint.shaftPixel, tint.accent, TINT_TOLERANCE))
        shot("05b-close-tab-caption")
        f.up()
        val closed = awaitTrue(8_000) { activeCoreTab()?.optString("id") == TAB }
        claim("the release closed the tab back to its opener (active ${activeCoreTab()?.optString("id")}, at ${activeUrl()})", closed && activeUrl() == opener)
        if (!closed) finding("(the drag's ZenPull lines: ${pullLog()})")
        claim("the child tab is gone", coreState().getJSONObject("tabs").optJSONObject(childId) == null)
        claim("the bubble left with the tab", awaitTrue(4_000) { bubblePhase() == "" })
        claim("no further tap came with the release (taps ${thresholdTaps()})", thresholdTaps() - tapsBefore == 1)
        settle()
    }

    // --- GN-23 / A11Y-14: the touchpad's two-finger swipe ---------------------------------------

    /** Whether the device hands a touchpad swipe to the window as a classified finger (Android 14+). */
    private fun touchpadSwipesClassified(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    /**
     * A two-finger swipe rightwards from the middle of the page, 200 dp over a second: the swipe
     * needs no edge, the bubble is up and armed with the fingers held, and the release goes back.
     *
     * What the swipe does once it is dragging is WATCHED, not claimed (see [watch]): on the
     * software-GPU emulator the WebView's long-press timer races the swipe's first moves, which
     * Android batches behind the next frame, and a frame 500 ms late lets the long press win – a
     * text selection comes up under the swipe (the paragraph's last "." from the blank body,
     * `ZenSelection … created` ~0.6 s after the down) and the drag never takes over. One run in
     * two went the swipe's way (armed at 121.8 dp, the release went back); the classifier's
     * side of the swipe is pinned by `HistoryNavClassifierTest`. What is claimed is the part the
     * emulator cannot spoil: the switch on by default and the dispatcher taking every classified
     * event (the thing `adb shell input` cannot do).
     */
    private fun touchpadSwipeBack() {
        section("GN-23: a touchpad's two-finger swipe from the middle of the page goes back")
        if (!touchpadSwipesClassified()) {
            finding("(API ${Build.VERSION.SDK_INT} classifies no touchpad swipe; the scene is skipped)")
            return
        }
        claim("the switch is on by default (host.touchpadSwipeToNavigate)", onMain { host.touchpadSwipeToNavigate })
        shellCommand("logcat -c")
        val y = pageMidY()
        val swipe = TouchpadSwipe()
        swipe.down(width * 0.5f, y)
        swipe.moveBy(LONG_DRAG_DP * density, 0f, 1_000)
        swipe.hold(450)
        val phase = bubblePhase()
        val armed = bubbleArmed()
        val disc = nativeDisc()
        finding("(the swipe's events: ${swipe.injected} injected, ${swipe.refused} refused)")
        claim("the swipe's events were all taken by the dispatcher", swipe.refused == 0)
        watch("the bubble is up and dragging with the fingers held, from the middle of the page (phase '$phase')", phase == "dragging")
        watch("the swipe is armed past the threshold (disc: $disc)", armed)
        noteSelectionRace()
        shot("06-touchpad-swipe-armed")
        swipe.up()
        val navigated = awaitTrue(8_000) { activeUrl() == url("second") }
        watch("the release past the threshold went back to the second stop (now at ${activeUrl()})", navigated)
        if (!navigated) finding("(the host's diagnosis at the lift: ${awaitLogLine(1_500) { it.contains("history not started") } ?: "none in logcat"})")
        claim("the bubble left after the release", awaitTrue(4_000) { bubblePhase() == "" })
        if (navigated) awaitLoaded(url("second"))
        settle()
    }

    /**
     * The fling: a slow lead in 10 dp steps until the drag takes over (the page's
     * `overscroll-behavior-x` answer and the WebView's overscroll report arrive some 90 dp in on
     * this recipe; the bubble's travel counts from where the drag took over, not from the down),
     * a pause with the fingers held (un-armed, short of the threshold), then 60 dp in ≤48 ms and
     * the release – over Chrome's 1788 px/s in the swipe's direction, so the host says `force`
     * and the release navigates with the motion still short of the threshold.
     *
     * WATCHED, not claimed, for the same long-press race as [touchpadSwipeBack] (the drag took
     * over in neither run; the force itself is pinned by `HistoryNavClassifierTest` and
     * `historyNav.test.ts`). The dispatcher taking every event is the claim.
     */
    private fun touchpadSwipeFling() {
        section("GN-23: a touchpad swipe let go fast forces the navigation short of the threshold")
        if (!touchpadSwipesClassified()) {
            finding("(API ${Build.VERSION.SDK_INT} classifies no touchpad swipe; the scene is skipped)")
            return
        }
        shellCommand("logcat -c")
        val y = pageMidY()
        val swipe = TouchpadSwipe()
        swipe.down(width * 0.5f, y)
        var lead = 0f
        while (lead < FLING_LEAD_MAX_DP && bubblePhase() != "dragging") {
            swipe.moveBy(FLING_LEAD_STEP_DP * density, 0f, FLING_LEAD_STEP_MS)
            lead += FLING_LEAD_STEP_DP
        }
        swipe.hold(350)
        val riding = nativeDisc()
        val phaseBefore = bubblePhase()
        val armedBefore = bubbleArmed()
        finding("(the lead: ${lead.toInt()} dp until the drag took over; before the fling: phase '$phaseBefore', armed $armedBefore, disc $riding)")
        watch("the swipe has the bubble dragging, un-armed, short of the threshold before the fling (disc: $riding)", phaseBefore == "dragging" && !armedBefore && riding.leadingEdgeDp < NAV_THRESHOLD_DP)
        noteSelectionRace()
        val flingMs = minOf(FLING_MS, (FLING_DP * density * 1_000f / FLING_PX_PER_S).toLong())
        finding("(the flick: ${FLING_DP.toInt()} dp in $flingMs ms, ${(FLING_DP * density * 1_000f / flingMs).toInt()} px/s)")
        swipe.moveBy(FLING_DP * density, 0f, flingMs)
        swipe.up()
        claim("the fling's events were all taken by the dispatcher (${swipe.injected} injected, ${swipe.refused} refused)", swipe.refused == 0)
        val navigated = awaitTrue(8_000) { activeUrl() == url("second") }
        watch("the fling's release went back short of the threshold (now at ${activeUrl()})", navigated)
        val release = awaitLogLine(4_000) { it.contains("history release on") }
        finding("(the host's release line: ${release ?: "none in logcat"})")
        if (release == null) finding("(the host's diagnosis at the lift: ${awaitLogLine(1_500) { it.contains("history not started") } ?: "none in logcat"})")
        watch("the host forced the release by the fling (the release line says so)", release?.contains("(forced by the fling)") == true)
        claim("the bubble left after the release", awaitTrue(4_000) { bubblePhase() == "" })
        if (navigated) awaitLoaded(url("second"))
        settle()
        shot("07-after-touchpad-fling")
    }

    /**
     * Settings › Accessibility ends with Chrome's row, on by default: a still light and dark
     * with the row on screen, then the switch flipped off under a finger – the host's mirror
     * follows – and a still of it off. The row is left off for [touchpadSwipeRefused] (the
     * phone run); the tablet run puts it back itself.
     */
    private fun touchpadSwitchStills() {
        section("A11Y-14: Settings › Accessibility's \"Swipe between pages using a touchpad\"")
        if (!openAccessibilitySettings()) {
            touchFault("the Accessibility section never came up")
            return
        }
        val rect = revealSettingsRow(TOUCHPAD_ROW_LABEL)
        claim("the Accessibility page has the row \"$TOUCHPAD_ROW_LABEL\"", rect != null)
        val description = settingsRowValue(TOUCHPAD_ROW_LABEL)
        claim("the row's description is Chrome's (\"$description\")", description == TOUCHPAD_ROW_DESCRIPTION)
        val last = js("(function(){var p=document.querySelector('.zen-settings-pane')||document.querySelector('.zen-settings-phone');var r=p?p.querySelectorAll('.zen-settings-row'):[];var l=r[r.length-1];return l?(l.textContent||''):''})()")
        claim("the row is the page's last, where Chrome's Accessibility page ends with it", last.contains(TOUCHPAD_ROW_LABEL))
        claim("the switch reads on (host.touchpadSwipeToNavigate)", onMain { host.touchpadSwipeToNavigate })
        SystemClock.sleep(800)
        shot("08-accessibility-touchpad-row-$theme")
        val other = if (theme == "dark") "light" else "dark"
        coreInvoke("settings.update", "{\"colorScheme\":\"$other\"}")
        SystemClock.sleep(2_500)
        shot("08-accessibility-touchpad-row-$other")
        coreInvoke("settings.update", "{\"colorScheme\":\"$theme\"}")
        SystemClock.sleep(2_500)
        // Off, under a finger: the row's switch, and the host's mirror a bridge message later.
        val point = revealSettingsRow(TOUCHPAD_ROW_LABEL)?.let { touchPoint(it) }
        if (point == null) {
            touchFault("the row \"$TOUCHPAD_ROW_LABEL\" was not touchable")
        } else {
            Finger().tap(point.x, point.y)
            val off = awaitTrue(5_000) { !onMain { host.touchpadSwipeToNavigate } }
            claim("a tap on the row turned the switch off and the host's mirror followed (host.touchpadSwipeToNavigate false)", off)
            SystemClock.sleep(800)
            shot("09-accessibility-touchpad-row-off")
        }
        // The tablet run has no swipe to refuse: it puts the switch back before it ends.
        if (scenes == "settings") restoreTouchpadSwitch()
        leaveSettingsTab()
    }

    /**
     * With the switch off the same 200 dp swipe is the page's: no bubble at any point, nothing
     * navigated, and the host's refusal at the down. The switch is put back after.
     */
    private fun touchpadSwipeRefused() {
        section("A11Y-14: with the switch off the touchpad swipe is the page's")
        try {
            if (!touchpadSwipesClassified()) {
                finding("(API ${Build.VERSION.SDK_INT} classifies no touchpad swipe; the scene is skipped)")
                return
            }
            if (onMain { host.touchpadSwipeToNavigate }) {
                coreInvoke("settings.update", "{\"touchpadSwipeToNavigate\":false}")
                awaitTrue(5_000) { !onMain { host.touchpadSwipeToNavigate } }
                finding("(the switch was on; the core turned it off for the scene)")
            }
            claim("the switch is off for the swipe (host.touchpadSwipeToNavigate)", !onMain { host.touchpadSwipeToNavigate })
            ensureForeground()
            if (activeUrl() != url("third")) returnToThird()
            claim("the tab has a back entry the swipe could take", activeCoreTab()?.optBoolean("canGoBack") == true)
            shellCommand("logcat -c")
            val before = activeUrl()
            val y = pageMidY()
            val swipe = TouchpadSwipe()
            swipe.down(width * 0.5f, y)
            swipe.moveBy(LONG_DRAG_DP * density, 0f, 1_000)
            var seen = false
            for (i in 0 until 3) {
                if (bubblePhase().isNotEmpty() || nativeDisc().up) seen = true
                SystemClock.sleep(120)
            }
            shot("10-touchpad-swipe-refused")
            swipe.up()
            SystemClock.sleep(2_000)
            claim("with the switch off the bubble never appeared for the swipe", !seen)
            claim("and nothing navigated (still at ${activeUrl()})", activeUrl() == before)
            val started = awaitLogLine(1_500) { it.contains("history start on") }
            claim("the host started no history drag for the swipe", started == null)
            // The classifier's diagnosis at the lift (`HistoryNavClassifier.refusal`, under `ZenPull`
            // with the drag's own lines): the swipe's side had nowhere to go as given at the down –
            // the switch's refusal, whatever the WebView made of the swipe meanwhile.
            val refusal = awaitLogLine(1_500) { it.contains("history not started") && it.contains("touchpad swipe") }
            finding("(the host's refusal line: ${refusal ?: "none in logcat"})")
            claim("the host's refusal line names the switch (eligible=false for the swipe's side)", refusal?.contains("eligible=false") == true)
            noteSelectionRace()
        } finally {
            restoreTouchpadSwitch()
        }
    }

    /**
     * Settings › Accessibility up, by either chrome: the phone's through the menu under a finger
     * (the harness's way, proven by `.zen-settings-phone`), and the core's `page.open` where
     * that is not the layout (the tablet's two-pane Settings, `.zen-settings-two-pane`) or the
     * finger's way did not take. True once a section marked `accessibility` is in the document.
     */
    private fun openAccessibilitySettings(): Boolean {
        val up = { js("(function(){return document.querySelector('.zen-settings-phone[data-section=\"accessibility\"],.zen-settings-two-pane[data-section=\"accessibility\"]')?'yes':''})()") == "yes" }
        if (up()) return true
        val phone = js("(function(){return document.querySelector('.zen-phone-bar')?'yes':''})()") == "yes"
        if (phone && scenes != "settings" && openSettingsSection("accessibility") && awaitTrue(4_000, up)) return true
        finding("(Settings › Accessibility opened through the core: ${if (phone) "the menu's way did not take" else "no phone bar in this chrome"})")
        coreInvoke("page.open", """{"id":"settings","section":"accessibility"}""")
        val shown = awaitTrue(8_000, up)
        SystemClock.sleep(1_500)
        return shown
    }

    private fun restoreTouchpadSwitch() {
        if (onMain { host.touchpadSwipeToNavigate }) return
        coreInvoke("settings.update", "{\"touchpadSwipeToNavigate\":true}")
        val on = awaitTrue(5_000) { onMain { host.touchpadSwipeToNavigate } }
        finding("(the switch put back on: ${if (on) "yes" else "the host's mirror did not follow within 5 s"})")
    }

    /** The first line of `tag` since the last `logcat -c` that `matches`, within `timeoutMs`. */
    private fun awaitLogLine(timeoutMs: Long, tag: String = "ZenPull", matches: (String) -> Boolean): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val line = runCatching { shellCommand("logcat -d -s $tag:D") }.getOrDefault("").lines().firstOrNull(matches)
            if (line != null) return line.trim()
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(250)
        }
    }

    /**
     * Whether a text selection came up under the touchpad swipe since the last `logcat -c` – the
     * WebView's long press winning the race against the swipe's batched first moves on a stalled
     * frame (the emulator's software GPU; see [touchpadSwipeBack]). Written as a finding so a
     * `NOT SEEN` line beneath reads as the race, not as the gesture.
     */
    private fun noteSelectionRace() {
        val selection = awaitLogLine(0, tag = "ZenSelection") { it.contains("selection mode of") && it.contains("created") }
        finding(
            if (selection == null) "(no text selection came up under the swipe)"
            else "(a text selection came up under the swipe – the long press won the race against the batched moves: $selection)"
        )
    }

    /**
     * A finding with a claim's shape but no weight: `SEEN` / `NOT SEEN` instead of `PASS` / `FAIL`,
     * for what the emulator's stalled frames can spoil (the touchpad swipe's drag) – it is read
     * from the nightly's findings, it fails no run. `claim` is for what the run can vouch for.
     */
    private fun watch(what: String, held: Boolean) {
        val line = "${if (held) "SEEN" else "NOT SEEN"}: $what"
        finding(line)
        if (held) Log.i(tag, line) else Log.w(tag, line)
    }

    /**
     * A touchpad's two-finger swipe as Android 14+ hands it to the window (`GestureConverter.cpp`,
     * `handleScroll`): one fake finger from the mouse source, `TOOL_TYPE_FINGER`, no button,
     * classified `CLASSIFICATION_TWO_FINGER_SWIPE` – built with API 34's `MotionEvent.obtain` that
     * carries a classification and injected through the dispatcher, which keeps it (`adb shell
     * input` can set none, which is why #580 had no device scene). Moves are interpolated and
     * injected in real time as [Finger.moveBy]'s are, so the velocity the host measures is the
     * one asked for.
     */
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private inner class TouchpadSwipe {
        private var downTime = 0L
        private var x = 0f
        private var y = 0f
        var injected = 0
        var refused = 0

        fun down(x: Float, y: Float) {
            this.x = x
            this.y = y
            downTime = SystemClock.uptimeMillis()
            inject(MotionEvent.ACTION_DOWN, downTime)
        }

        fun moveBy(dx: Float, dy: Float, durationMs: Long) {
            val fromX = x
            val fromY = y
            val toX = x + dx
            val toY = y + dy
            val steps = maxOf(1L, durationMs / SWIPE_STEP_MS)
            val start = SystemClock.uptimeMillis()
            for (i in 1..steps) {
                val due = start + (durationMs * i) / steps
                val now = SystemClock.uptimeMillis()
                if (due > now) SystemClock.sleep(due - now)
                val t = i.toFloat() / steps
                x = fromX + (toX - fromX) * t
                y = fromY + (toY - fromY) * t
                inject(MotionEvent.ACTION_MOVE, SystemClock.uptimeMillis())
            }
        }

        fun hold(ms: Long) = SystemClock.sleep(ms)

        fun up() = inject(MotionEvent.ACTION_UP, SystemClock.uptimeMillis())

        private fun inject(action: Int, eventTime: Long) {
            val properties = MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
            val coords = MotionEvent.PointerCoords().apply {
                x = this@TouchpadSwipe.x
                y = this@TouchpadSwipe.y
                pressure = 1f
                size = 1f
            }
            val event = MotionEvent.obtain(
                downTime, eventTime, action, 1, arrayOf(properties), arrayOf(coords),
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, Display.DEFAULT_DISPLAY, 0,
                HistoryNavClassifier.CLASSIFICATION_TWO_FINGER_SWIPE
            )
            if (event == null) {
                refused++
                return
            }
            injected++
            try {
                if (!injectInput(event, false)) refused++
            } finally {
                event.recycle()
            }
        }
    }

    // --- GN-19: the overview's space swipe ------------------------------------------------------

    /**
     * In the overview a horizontal drag over the grid's background moves between the Spaces, the
     * header following (tab overview cleanup spec §1, §6 – GN-19 turned to the Spaces now that
     * the overview has no panes to move between): the Space's slot rides the finger 1:1, past a
     * third of the width the release picks the neighbour and the title cross-fades to its name;
     * back the same way; a short drag released still springs back. The seeded state has one Space
     * – a swipe with nowhere to go is the scroller's – so the section makes a second one
     * (`space.create`, a tab in it) and takes it away again at its end (`space.delete`).
     */
    private fun spaceSwipes() {
        section("GN-19: the overview's space swipe")
        val personal = runCatching {
            JSONTokener(coreInvoke("space.create", """{"name":"$SECOND_SPACE","icon":"🏠","containerId":"default","theme":null}""")).nextValue() as? String
        }.getOrNull()
        if (personal.isNullOrEmpty()) {
            touchFault("no second Space for the space swipe (space.create answered nothing)")
            return
        }
        // The new Space takes the window with it: a tab for it, then back to Work for the swipe.
        runCatching { coreInvoke("tab.create", """{"url":${JSONObject.quote("${server.origin}/side.html")},"active":true,"spaceId":${JSONObject.quote(personal)}}""") }
        runCatching { coreInvoke("space.activate", """{"spaceId":"$WORK_SPACE_ID"}""") }
        SystemClock.sleep(1_500)
        try {
            if (!openOverview()) {
                touchFault("the overview never opened for the space swipe")
                return
            }
            val onWork = awaitTrue(4_000) { overviewTitleLabel()?.startsWith("$WORK_SPACE, ") == true }
            claim("the overview opened on Work (title '${overviewTitleLabel()}')", onWork)
            val slot = domBox("document.querySelector('$SPACE_SLOT')") ?: run {
                touchFault("the overview's Space slot was not found")
                closeOverview()
                return
            }
            // The lower part of the slot: below the two cards, off the 32 dp gutters at either side.
            val y = slot.top + slot.height() * 0.78f
            val startX = width * 0.82f
            val travel = width * 0.5f
            val f = Finger()
            val scene = traceFrames("space-swipe-overview", JankBudget.Kind.GESTURE) {
                f.down(startX, y)
                f.moveBy(-travel, 0f, 900)
                f.hold(200)
            }
            val live = slotLive()
            val transform = js("(function(){var e=document.querySelector('$SPACE_SLOT');return e?e.style.transform:''})()")
            claim("the Space's slot is live under the finger (data-swipe)", live)
            claim("the slot rides the finger towards the next Space (transform '$transform')", transform.startsWith("translate3d(-"))
            claim("the title still reads Work under the finger (the cross-fade waits for the pick)", overviewTitleLabel()?.startsWith("$WORK_SPACE, ") == true)
            noteScene(scene)
            shot("06-space-swipe-mid")
            f.up()
            claim("the release past a third picked $SECOND_SPACE: the title follows", awaitTrue(4_000) { overviewTitleLabel()?.startsWith("$SECOND_SPACE, ") == true })
            claim("and the core switched the Space with it", awaitTrue(4_000) { activeSpaceId() == personal })
            settle()
            shot("07-space-personal")

            // Back to Work the same way.
            val g = Finger()
            g.down(width * 0.18f, y)
            g.moveBy(travel, 0f, 900)
            g.hold(200)
            g.up()
            claim("the swipe back picked Work again", awaitTrue(4_000) { overviewTitleLabel()?.startsWith("$WORK_SPACE, ") == true && activeSpaceId() == WORK_SPACE_ID })
            SystemClock.sleep(1_200)

            // A short drag, released still: under a third and no fling, so the slot springs back.
            val h = Finger()
            h.down(startX, y)
            h.moveBy(-width * 0.15f, 0f, 700)
            h.hold(700)
            h.up()
            SystemClock.sleep(1_500)
            claim("a short swipe released still stays on Work (title '${overviewTitleLabel()}')", overviewTitleLabel()?.startsWith("$WORK_SPACE, ") == true && activeSpaceId() == WORK_SPACE_ID)
            claim("the slot is at rest after the settle (no data-swipe, no transform)", awaitTrue(3_000) { !slotLive() && js("(function(){var e=document.querySelector('$SPACE_SLOT');return e?e.style.transform:''})()") == "" })
            shot("08-space-settled")
            closeOverview()
        } finally {
            runCatching { coreInvoke("space.delete", """{"spaceId":${JSONObject.quote(personal)}}""") }
            SystemClock.sleep(1_000)
        }
    }

    /** The Space's slot carries `data-swipe` while a finger has it (`useSpaceSwipe`'s `paint`). */
    private fun slotLive(): Boolean =
        js("(function(){var e=document.querySelector('$SPACE_SLOT');return e&&e.hasAttribute('data-swipe')?'live':''})()") == "live"

    private fun activeSpaceId(): String = coreState().optString("activeSpaceId")

    // --- GN-10: a hold on the pill --------------------------------------------------------------

    /** A hold on the pill let go in place: the omnibox with the clipboard row; Paste fills the field and submits nothing. */
    private fun pillHoldPaste() {
        section("GN-10: a hold on the pill, then Paste")
        val before = activeUrl()
        val at = pillBounds() ?: pill
        val f = Finger()
        f.press(at.exactCenterX(), at.exactCenterY())
        f.up()
        val open = awaitOmniboxOpen()
        claim("the hold let go in place opened the omnibox (${open.describe()})", open.open)
        val row = awaitTrue(6_000) { clipboardRowText().isNotEmpty() }
        val text = clipboardRowText()
        claim("the clipboard row is up under the field, titled for text ('${text.take(40)}')", row && text.contains("Text you copied"))
        claim("the row carries Paste beside its Paste and search", domBox(PASTE_BUTTON_JS) != null)
        // The keyboard rises after the open and carries the surface up with it (run 1's tap,
        // aimed before it rose, landed on the keyboard's p): the button's place is read again
        // once the keyboard is up and the surface has settled, right before the finger goes in.
        finding(if (awaitIme(true)) "  (the keyboard is up)" else "  (the keyboard did not rise within 6 s)")
        settle()
        shot("09-pill-hold-clipboard-row")
        val paste = domBox(PASTE_BUTTON_JS)?.let { touchPoint(it) }
        if (paste == null) {
            touchFault("the clipboard row's Paste was not touchable")
            leaveOmnibox()
            return
        }
        Finger().tap(paste.x, paste.y)
        val filled = awaitTrue(4_000) { fieldValue() == CLIP_TEXT }
        claim("Paste put the copied text in the field ('${fieldValue().take(40)}')", filled)
        SystemClock.sleep(1_200)
        claim("Paste submitted nothing (still at ${activeUrl()})", activeUrl() == before)
        shot("10-pasted-in-field")
        leaveOmnibox()
    }

    /** Close the URL field by the chrome's state (the harness's shared close), the page it kept named in the findings. */
    private fun leaveOmnibox() {
        val close = closeUrlField()
        if (!close.ok) finding("  (closing the omnibox: ${close.describe()})")
        SystemClock.sleep(800)
    }

    // --- the edges under gesture navigation -----------------------------------------------------

    /**
     * Gesture navigation on: the system owns the edges (Chrome's `checkCanInterceptSwipe`), so the
     * same drag never brings the bubble up. The system's own back may take the edge and navigate:
     * noted, not a claim. 3-button mode comes back whatever happened.
     *
     * The overlay switch is a configuration change (the assets' paths) an activity cannot take in
     * place: the system recreates it (run 1's `app.getState` timed out on the destroyed one's
     * chrome). The resumed MainActivity is taken over as the harness's, its chrome awaited, and
     * the tab given a back entry again before the drag – without one the drag is the page's from
     * the down and its absent bubble would say nothing.
     */
    private fun gesturalEdgeUntouched() {
        section("GN-04: the edge under gesture navigation")
        try {
            val launched = activity
            shellCommand("cmd overlay disable $THREE_BUTTON_OVERLAY")
            shellCommand("cmd overlay enable $GESTURAL_OVERLAY")
            SystemClock.sleep(3_000)
            val mode = navMode()
            finding("navigation mode switched: $mode")
            if (mode != GESTURAL) {
                finding("(the emulator did not take gesture navigation; the scene is skipped)")
                return
            }
            if (!reacquireActivity(launched)) {
                finding("(no MainActivity resumed with a chrome within 30 s of the switch; the scene is skipped)")
                return
            }
            ensureForeground()
            val target = if (activeUrl() == url("third")) url("second") else url("third")
            coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"$target"}""")
            awaitLoaded(target)
            finding("history rebuilt: ${describeHistory()}")
            claim("the tab has a back entry for the drag to take", activeCoreTab()?.optBoolean("canGoBack") == true)
            val before = activeUrl()
            val y = pageMidY()
            val f = Finger()
            f.down(EDGE_X_DP * density, y)
            f.moveBy(LONG_DRAG_DP * density, 0f, 1_000)
            var seen = false
            for (i in 0 until 3) {
                if (bubblePhase().isNotEmpty() || nativeDisc().up) seen = true
                SystemClock.sleep(120)
            }
            shot("11-gestural-edge")
            f.up()
            SystemClock.sleep(2_000)
            claim("under gesture navigation the bubble never appeared", !seen)
            val after = activeUrl()
            finding(
                if (after == before) "(the system left the page where it was: $after)"
                else "(the system's own back gesture took the edge: $before -> $after)"
            )
        } finally {
            shellCommand("cmd overlay disable $GESTURAL_OVERLAY")
            shellCommand("cmd overlay enable-exclusive --category $THREE_BUTTON_OVERLAY")
            SystemClock.sleep(3_000)
            finding("navigation mode restored: ${navMode()}")
            // The restore recreates the activity once more; the harness's tail wants the live one.
            if (!reacquireActivity(activity, 20_000)) finding("  (no MainActivity resumed with a chrome after the restore)")
        }
    }

    // --- the overview ----------------------------------------------------------------------------

    /** Open the overview with a touch on the bar's Tabs button; a touch read as a hold is dismissed and tried again. */
    private fun openOverview(): Boolean {
        for (attempt in 0 until 3) {
            val tabs = findNode { it.startsWith(TABS_LABEL_PREFIX) }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: domBox("document.querySelector('[aria-label^=\"Tabs (\"]')")
                ?: return false
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (overviewOpen()) {
                    SystemClock.sleep(1_500)
                    return true
                }
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt ${attempt + 1}: dismissed, trying again)")
                    back()
                    SystemClock.sleep(1_500)
                    break
                }
                SystemClock.sleep(200)
            }
        }
        return overviewOpen()
    }

    private fun closeOverview() {
        back()
        if (!awaitTrue(5_000) { !overviewOpen() }) finding("  (the overview did not close on back)")
        SystemClock.sleep(1_000)
    }

    private fun overviewOpen(): Boolean =
        js("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun heldInstead(): Boolean =
        js("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet')?'held':''})()") == "held"

    // --- the chrome's word -----------------------------------------------------------------------

    private fun js(code: String): String = chromeJsString(code) ?: ""

    private fun bubblePhase(): String =
        js("(function(){var e=document.querySelector('[data-testid=\"history-nav\"]');return e?e.getAttribute('data-phase')||'':''})()")

    /** The root carries the drag's state (`data-armed`); the disc itself is the host's view on Android. */
    private fun bubbleArmed(): Boolean =
        js("(function(){var e=document.querySelector('[data-testid=\"history-nav\"]');return e&&e.hasAttribute('data-armed')?'armed':''})()") == "armed"

    /** What the release closes at the history's first page (`data-close-target`: 'tab' or 'app'; "" for a page turn). */
    private fun bubbleCloseTarget(): String =
        js("(function(){var e=document.querySelector('[data-testid=\"history-nav\"]');return e?e.getAttribute('data-close-target')||'':''})()")

    /**
     * How many times the host's bubble layer tapped the finger at the threshold since boot: its
     * `ZenPull` line goes out with each `KEYBOARD_TAP` (`HistoryNavBubbleLayer.apply`), and the
     * instrumentation's shell reads the app's log.
     */
    private fun thresholdTaps(): Int =
        shellCommand("logcat -d -s ZenPull:D").lineSequence().count { it.contains("history threshold: KEYBOARD_TAP") }

    /** The layer's last tap line, the platform's answer to the pin in it (`performed=false`: detached, or view-level haptics off). */
    private fun lastThresholdTap(): String =
        shellCommand("logcat -d -s ZenPull:D").lineSequence()
            .lastOrNull { it.contains("history threshold: KEYBOARD_TAP") }
            ?.substringAfter("): ")?.trim() ?: "none"

    /** The last few `ZenPull` history lines (`history start / release / not started …`), for a failed drag's finding. */
    private fun pullLog(): String =
        shellCommand("logcat -d -s ZenPull:D").lineSequence()
            .filter { it.contains("history ") }
            .map { it.substringAfter("): ").trim() }
            .toList().takeLast(4).joinToString(" | ").ifEmpty { "none" }

    /**
     * What the host's disc (HistoryNavBubbleView) shows: up at all (its layer up with it), how far
     * its leading edge stands in, its scale, and the layer's clip (the page frame's box).
     */
    private class NativeDisc(val up: Boolean, val leadingEdgeDp: Float, val scale: Float, val alpha: Float, val clip: Rect?) {
        override fun toString(): String =
            "up=$up leadingEdge=${"%.1f".format(leadingEdgeDp)}dp scale=${"%.3f".format(scale)} alpha=${"%.2f".format(alpha)} clip=${clip?.toShortString() ?: "none"}"
    }

    private fun nativeDisc(): NativeDisc = onMain {
        val layer = host.historyNavBubbleLayer
        val view = host.historyNavBubble
        NativeDisc(
            layer.visibility == View.VISIBLE && view.visibility == View.VISIBLE && view.alpha > 0.01f,
            // A left-edge drag: the disc's right side, from the window's left, in dp.
            (view.translationX + view.width) / density,
            view.scaleX,
            view.alpha,
            layer.clipBounds
        )
    }

    /**
     * What the host's disc paints its arrow and caption in (`HistoryNavBubbleView.shownTint`:
     * the tint 0..1 and the four paints), the pixel at the arrow's shaft as the view draws itself,
     * the caption as shown, and the accent the chrome handed the host with the theme
     * (`Host.themeAccent`, its computed `--v2-accent`) – what the armed arrow must stand at.
     */
    private class NativeTint(
        val value: Float,
        val arrow: Int,
        val captionInk: Int,
        val fill: Int,
        val border: Int,
        val shaftPixel: Int,
        val caption: HistoryNavBubbleView.ShownCaption,
        val accent: Int
    ) {
        override fun toString(): String =
            "tint=${"%.2f".format(value)} arrow=${hex(arrow)} caption=${hex(captionInk)} fill=${hex(fill)} border=${hex(border)} shaft=${hex(shaftPixel)} accent=${hex(accent)} $caption"
    }

    private fun nativeTint(): NativeTint = onMain {
        val view = host.historyNavBubble
        val shown = view.shownTint
        // The view drawn as it stands into a bitmap of its own box (its translation and scale are
        // the parent's to apply): the disc's centre is the arrow's shaft, inside the stroke.
        val shaft = if (view.width > 0 && view.height > 0) {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            bitmap.getPixel(view.height / 2, view.height / 2).also { bitmap.recycle() }
        } else 0
        NativeTint(shown.value, shown.arrow, shown.caption, shown.fill, shown.border, shaft, view.shownCaption, host.themeAccent)
    }

    /** What the chrome's `--v2-accent` computes to right now, as the chrome document says it (the record beside the host's number). */
    private fun chromeAccent(): String =
        js("(function(){var e=document.createElement('span');e.style.display='none';e.style.backgroundColor='var(--v2-accent)';document.documentElement.appendChild(e);var c=getComputedStyle(e).backgroundColor;e.remove();return c})()")

    /** Every side of this box within `tolerance` px of the other's. */
    private fun Rect.within(other: Rect, tolerance: Int): Boolean =
        abs(left - other.left) <= tolerance && abs(top - other.top) <= tolerance &&
            abs(right - other.right) <= tolerance && abs(bottom - other.bottom) <= tolerance

    private fun popupRows(): Int =
        js("(function(){return String(document.querySelectorAll('[data-testid=\"back-history-entry\"]').length)})()").toIntOrNull() ?: 0

    /**
     * A popup an earlier scene left up would take the next scene's press as its light dismiss
     * (the chrome layer closes a popover on a press outside, and that press reaches no hold), and
     * one scene's failure would read as the next one's: the system Back closes it first, so each
     * scene's claims are its own. Nothing is pressed when no popup is up (a Back with none would
     * move the tab).
     */
    private fun shedPopup() {
        if (popupRows() == 0) return
        finding("  (a popup was still up from an earlier scene: the system Back closed it before this one)")
        back()
        awaitTrue(3_000) { popupRows() == 0 }
        SystemClock.sleep(600)
    }

    /** The popup's row for the history entry at `index`, as a DOM expression. */
    private fun entryRow(index: Int): String =
        "document.querySelector('[data-testid=\"back-history-entry\"][data-index=\"$index\"]')"

    /** The `data-index` of every popup row lit under the held finger (`data-hold-lit`, `useBarHold`), joined by commas. */
    private fun litRows(): String =
        js("(function(){return Array.prototype.map.call(document.querySelectorAll('[data-testid=\"back-history-entry\"][data-hold-lit]'),function(e){return e.getAttribute('data-index')}).join(',')})()")

    /** The lit row's computed background against an unlit row's: the pressed tone (`--v2-fill`) over the panel's. */
    private fun rowTones(): Pair<String, String> {
        val text = js(
            "(function(){var l=document.querySelector('[data-testid=\"back-history-entry\"][data-hold-lit]');" +
                "var u=document.querySelector('[data-testid=\"back-history-entry\"]:not([data-hold-lit])');" +
                "return (l?getComputedStyle(l).backgroundColor:'')+'|'+(u?getComputedStyle(u).backgroundColor:'')})()"
        )
        val parts = text.split('|')
        return (parts.getOrNull(0) ?: "") to (parts.getOrNull(1) ?: "")
    }

    private fun clipboardRowText(): String =
        js("(function(){var e=document.querySelector('li.zen-suggestion[data-kind=\"clipboard\"]');return e?e.textContent||'':''})()")

    private fun fieldValue(): String =
        js("(function(){var e=document.querySelector('[data-testid=\"urlbar-input\"]');return e?e.value:''})()")

    /** The bar's Back button, from the tree first (its label is a harness contract), the DOM's box otherwise. */
    private fun backButtonPoint(): PointF? {
        val node = awaitFresh(5_000, "the bar's Back button") { it == BACK_LABEL }
        val bounds = node?.let { steadyBounds(it) } ?: domBox("document.querySelector('[data-bar-item=\"back\"]')") ?: return null
        return touchPoint(bounds)
    }

    /** Vertically the middle of the page: between the status bar and the bar the pill sits in. */
    private fun pageMidY(): Float = (touchable.top + pill.top) / 2f

    // --- the core's word -------------------------------------------------------------------------

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun describeHistory(): String {
        val tab = activeCoreTab() ?: return "no active tab"
        return "at ${tab.optString("url")} (canGoBack ${tab.optBoolean("canGoBack")}, canGoForward ${tab.optBoolean("canGoForward")})"
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        finding("  (gave up waiting for $url to load)")
    }

    // --- the device ------------------------------------------------------------------------------

    /** Which navigation overlay is enabled: [THREE_BUTTON], [GESTURAL] or `unknown`. */
    private fun navMode(): String {
        val list = runCatching { shellCommand("cmd overlay list") }.getOrDefault("")
        return when {
            list.contains("[x] $THREE_BUTTON_OVERLAY") -> THREE_BUTTON
            list.contains("[x] $GESTURAL_OVERLAY") -> GESTURAL
            else -> "unknown"
        }
    }

    /**
     * Take over the MainActivity the system has resumed – the one it recreated for a configuration
     * change, or [launched] itself when it kept it – and wait for its chrome to be up (`window.zen`
     * bound). False when neither came within [timeoutMs].
     */
    private fun reacquireActivity(launched: Activity, timeoutMs: Long = 30_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val resumed = onMain {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull()
            }
            if (resumed != null) {
                activity = resumed
                if (chromeJs("typeof window.zen") == "\"object\"") {
                    finding("  (the activity was ${if (resumed === launched) "kept" else "recreated"} by the switch; its chrome is up)")
                    return true
                }
            }
            SystemClock.sleep(250)
        }
        return false
    }

    private fun seedClipboard() {
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText("Zenium gestures demo", CLIP_TEXT))
        }
        clipboardSeededAt = SystemClock.uptimeMillis()
    }

    // --- the findings ----------------------------------------------------------------------------

    private fun section(title: String) {
        finding("\n[$title]")
        Log.i(tag, title)
    }

    private fun finding(line: String) {
        findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) {
        super.noteLine(line)
        if (::findings.isInitialized) finding("  $line")
    }

    private fun claim(what: String, held: Boolean) {
        checks++
        if (!held) failures++
        val line = "${if (held) "PASS" else "FAIL"}: $what"
        finding(line)
        if (held) Log.i(tag, line) else Log.e(tag, line)
    }

    private fun noteScene(scene: FrameStats.Scene) {
        val summary = scene.summary
        finding(
            "  frames ${scene.name}: " +
                (summary?.let { "${it.frames} frames, ${it.janky} janky, p50 ${it.p50Ms} ms, p90 ${it.p90Ms} ms, p99 ${it.p99Ms} ms" } ?: "no summary") +
                " (${scene.durationMs} ms; verdict ${scene.verdict})"
        )
        // The renderer main thread's reading (the long tasks by CPU, the wall count beside them),
        // or why the scene has none: the GESTURE budget's half the software GPU does not dominate.
        val trace = scene.trace
        finding("  ${scene.name} " + (trace?.describe() ?: "trace: none read (${scene.traceMissing ?: "no trace asked"})"))
    }

    private fun url(page: String): String = "http://127.0.0.1:$PORT/$page.html"

    companion object {
        const val PORT = 18175
        const val TAB = "tab_first"
        /** The seeded Space (its id and its name), and the name of the one GN-19 makes beside it for the swipe. */
        const val WORK_SPACE_ID = "space_work"
        const val WORK_SPACE = "Work"
        const val SECOND_SPACE = "Personal"
        /** The Space's slot the swipe moves (`useSpaceSwipe`'s `SLOT`, `TabOverview`'s `PaneSlot` keyed by the Space). */
        const val SPACE_SLOT = ".zen-overview-space"
        const val BACK_LABEL = "Back"
        const val CLIP_TEXT = "quiet mornings and long walks"
        /** Where a history drag begins: inside Chrome's 24 dp edge window. */
        const val EDGE_X_DP = 8f
        /** Chrome's threshold: three drag distances of 32 dp (`lib/historyNav.ts` `NAV_THRESHOLD`). */
        const val NAV_THRESHOLD_DP = 96f
        /** Well past the 96 dp threshold (the excess rubber-bands). */
        const val LONG_DRAG_DP = 200f
        /** Short of the threshold: the disc follows and springs back. */
        const val SHORT_DRAG_DP = 60f
        /** The disc's scale as the drag begins (`lib/historyNav.ts` `BUBBLE_MIN_SCALE`, v2 §11.9's .6). */
        const val MIN_SCALE = 0.6f
        /**
         * Full is 1 at the threshold; the growth's spring rests a hair short of it, and a finger held
         * short of the threshold (60 dp of 96) leaves the disc well under it.
         */
        const val FULL_SCALE_FLOOR = 0.97f
        /** The disc's diameter (v2 §11.9's 44, `HistoryNavBubbleFrame.sizePx` at density); the caption's pill runs out past it. */
        const val BUBBLE_SIZE_DP = 44f
        /** How far a channel of the armed arrow's colour may stand from the accent: the tint's mix rounds per channel, the drawn pixel dithers a hair. */
        const val TINT_TOLERANCE = 8
        /**
         * The fling's lead: slow 10 dp steps (about 75 dp/s with the bubble read between them)
         * until the drag takes over, at most 160 dp – the travel the bubble measures starts where
         * the drag took over, so the lead's length is not the drag's, and the release alone (not
         * the distance) can arm the navigation.
         */
        const val FLING_LEAD_MAX_DP = 160f
        const val FLING_LEAD_STEP_DP = 10f
        const val FLING_LEAD_STEP_MS = 80L
        /**
         * The flick: 60 dp, so the drag from where it took over stays short of the 96 dp
         * threshold; its duration is 48 ms at most and shorter where the density is low, so the
         * release runs at [FLING_PX_PER_S] physical px/s on any recipe (35 ms on the phone
         * recipe's 1.75 density, 20 ms at one px per dp) – past Chrome's fixed 1788
         * (`overscroll_refresh.cc:29-33`).
         */
        const val FLING_DP = 60f
        const val FLING_MS = 48L
        const val FLING_PX_PER_S = 3_000f
        /** The injected swipe's sample spacing (about the touchpad's 125 Hz report rate). */
        const val SWIPE_STEP_MS = 8L
        /** Chrome's row (`browser_ui_strings.grd:1039-1044`): its title and its summary, verbatim. */
        const val TOUCHPAD_ROW_LABEL = "Swipe between pages using a touchpad"
        const val TOUCHPAD_ROW_DESCRIPTION = "Navigate back and forth by swiping with two fingers on the touchpad."
        const val THREE_BUTTON = "threebutton"
        const val GESTURAL = "gestural"
        const val THREE_BUTTON_OVERLAY = "com.android.internal.systemui.navbar.threebutton"
        const val GESTURAL_OVERLAY = "com.android.internal.systemui.navbar.gestural"
        /** The clipboard row's Paste (the §6 fill control; the row's own tap is Paste and search). */
        const val PASTE_BUTTON_JS = "document.querySelector('li.zen-suggestion[data-kind=\"clipboard\"] button[aria-label=\"Paste\"]')"

        /** An ARGB colour as `#AARRGGBB`. */
        fun hex(color: Int): String = "#%08X".format(color)

        /** Every channel of [a] (the alpha too) within [tolerance] of [b]'s. */
        fun near(a: Int, b: Int, tolerance: Int): Boolean =
            (0..3).all { shift -> abs(((a ushr (shift * 8)) and 0xFF) - ((b ushr (shift * 8)) and 0xFF)) <= tolerance }
    }
}
