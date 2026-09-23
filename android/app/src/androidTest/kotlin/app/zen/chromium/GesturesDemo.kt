package app.zen.chromium

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/**
 * The gesture cluster of the Android parity matrix (GN-04, GN-08, GN-19, GN-10) on the device,
 * every gesture a real touch, Chrome's behaviour the reference:
 *
 * - GN-08: a hold on the bar's Back opens the tab's history popup (the back entries, "Show full
 *   history"); a row is a jump straight to its entry (`NavigationPopup.java`).
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
        backHistoryPopup()
        returnToThird()
        edgeDragArmed()
        edgeDragShort()
        paneSwipes()
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
            back()
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
        // opaque, its leading edge past the threshold, and grown by the armed 15 %.
        claim("the native disc is up above the pages, riding its translation, grown as armed", disc.up && disc.leadingEdgeDp > NAV_THRESHOLD_DP && disc.scale > 1.1f)
        // The disc's layer clips it to the page frame (the DOM disc's `overflow: hidden`): the
        // frame sits in from the window's edge, and the disc must come out from the frame's side,
        // not show over the gutter. The DOM's box, unshifted: the layer is in window px.
        val frameBox = domBox("(function(){var r=document.querySelector('[data-testid=\"history-nav\"]');return r?r.parentElement:null})()")
            ?.also { it.offset(-domShiftX, -domShiftY) }
        claim("the disc's layer clips to the page frame's box (clip ${disc.clip}; frame $frameBox)", disc.clip != null && frameBox != null && disc.clip.within(frameBox, 2))
        noteScene(scene)
        shot("03-edge-drag-armed")
        f.up()
        val navigated = awaitTrue(8_000) { activeUrl() == url("second") }
        claim("the release past the threshold went back to the second stop (now at ${activeUrl()})", navigated)
        claim("the bubble left after the navigation", awaitTrue(4_000) { bubblePhase() == "" })
        awaitLoaded(url("second"))
        settle()
        shot("04-after-edge-drag")
    }

    /**
     * A drag of 60 dp in two halves, a still at each with the finger held: the disc rides the
     * finger out from the frame's side, never arms, and the release springs it away with nothing
     * navigated. Unmeasured, so the stills cost the frames nothing.
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
        claim("the native disc rides the finger out from the frame's side, un-armed (disc: $riding)", riding.up && riding.leadingEdgeDp in 1f..NAV_THRESHOLD_DP && riding.scale < 1.01f)
        shot("05-edge-drag-riding")
        f.moveBy(SHORT_DRAG_DP / 2 * density, 0f, 250)
        f.hold(350)
        val phase = bubblePhase()
        val armed = bubbleArmed()
        val disc = nativeDisc()
        claim("the short drag has the bubble dragging (phase '$phase')", phase == "dragging")
        claim("the short drag is not armed", !armed)
        claim("the native disc is up short of the threshold at its own size (disc: $disc)", disc.up && disc.leadingEdgeDp in 1f..NAV_THRESHOLD_DP && disc.scale < 1.01f)
        claim("the disc went further with the finger (${"%.1f".format(riding.leadingEdgeDp)} -> ${"%.1f".format(disc.leadingEdgeDp)} dp)", disc.leadingEdgeDp > riding.leadingEdgeDp)
        shot("05-edge-drag-short")
        f.up()
        SystemClock.sleep(1_500)
        claim("the short release navigated nothing (still at ${activeUrl()})", activeUrl() == before)
        claim("the bubble sprang away after the short release", awaitTrue(4_000) { bubblePhase() == "" })
        claim("the native disc went with it (disc: ${nativeDisc()})", !nativeDisc().up)
    }

    // --- GN-19: the switcher's pane swipe -------------------------------------------------------

    /**
     * In the overview a drag left over the pane's background carries the segment's line and fades
     * the pane; past a third of the width the release picks Groups. Back the same way; a short
     * drag settles back on Tabs.
     */
    private fun paneSwipes() {
        section("GN-19: the switcher's pane swipe")
        if (!openOverview()) {
            touchFault("the overview never opened for the pane swipe")
            return
        }
        claim("the overview opened on Tabs (selected '${selectedPane()}')", selectedPane() == "tabs")
        val pane = domBox("document.querySelector('.zen-overview-pane')") ?: run {
            touchFault("the overview's pane was not found")
            closeOverview()
            return
        }
        // The lower part of the pane: below the two cards, off the 32 dp gutters at either side.
        val y = pane.top + pane.height() * 0.78f
        val startX = width * 0.82f
        val travel = width * 0.5f
        val f = Finger()
        val scene = traceFrames("pane-swipe-overview", JankBudget.Kind.GESTURE) {
            f.down(startX, y)
            f.moveBy(-travel, 0f, 900)
            f.hold(200)
        }
        val live = js("(function(){var e=document.querySelector('.zen-overview-segment');return e&&e.hasAttribute('data-swipe')?'live':''})()") == "live"
        val line = js("(function(){var e=document.querySelector('[data-testid=\"overview-segment-line\"]');return e?e.style.transform:''})()")
        val opacity = js("(function(){var e=document.querySelector('.zen-overview-pane');return e?e.style.opacity:''})()")
        claim("the segment is live under the finger (data-swipe)", live)
        claim("the segment's line rides the finger (transform '$line')", line.startsWith("translate3d("))
        claim("the pane fades in step (opacity '$opacity')", opacity.toFloatOrNull()?.let { it > 0f && it < 1f } == true)
        noteScene(scene)
        shot("06-pane-swipe-mid")
        f.up()
        claim("the release past a third picked Groups", awaitTrue(4_000) { selectedPane() == "groups" })
        settle()
        shot("07-pane-groups")

        // Back to Tabs the same way.
        val g = Finger()
        g.down(width * 0.18f, y)
        g.moveBy(travel, 0f, 900)
        g.hold(200)
        g.up()
        claim("the swipe back picked Tabs again", awaitTrue(4_000) { selectedPane() == "tabs" })
        SystemClock.sleep(1_200)

        // A short drag, released still: under a third and no fling, so the segment settles back.
        val h = Finger()
        h.down(startX, y)
        h.moveBy(-width * 0.15f, 0f, 700)
        h.hold(700)
        h.up()
        SystemClock.sleep(1_500)
        claim("a short swipe released still settles back on Tabs (selected '${selectedPane()}')", selectedPane() == "tabs")
        claim("the segment is at rest after the settle (no data-swipe)", awaitTrue(3_000) { js("(function(){var e=document.querySelector('.zen-overview-segment');return e&&e.hasAttribute('data-swipe')?'live':''})()") == "" })
        shot("08-pane-settled")
        closeOverview()
    }

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

    private fun selectedPane(): String =
        js("(function(){var e=document.querySelector('.zen-overview-segment [role=\"tab\"][aria-selected=\"true\"]');return e?e.getAttribute('data-pane')||'':''})()")

    // --- the chrome's word -----------------------------------------------------------------------

    private fun js(code: String): String = chromeJsString(code) ?: ""

    private fun bubblePhase(): String =
        js("(function(){var e=document.querySelector('[data-testid=\"history-nav\"]');return e?e.getAttribute('data-phase')||'':''})()")

    /** The root carries the drag's state (`data-armed`); the disc itself is the host's view on Android. */
    private fun bubbleArmed(): Boolean =
        js("(function(){var e=document.querySelector('[data-testid=\"history-nav\"]');return e&&e.hasAttribute('data-armed')?'armed':''})()") == "armed"

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

    /** Every side of this box within `tolerance` px of the other's. */
    private fun Rect.within(other: Rect, tolerance: Int): Boolean =
        abs(left - other.left) <= tolerance && abs(top - other.top) <= tolerance &&
            abs(right - other.right) <= tolerance && abs(bottom - other.bottom) <= tolerance

    private fun popupRows(): Int =
        js("(function(){return String(document.querySelectorAll('[data-testid=\"back-history-entry\"]').length)})()").toIntOrNull() ?: 0

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
        const val THREE_BUTTON = "threebutton"
        const val GESTURAL = "gestural"
        const val THREE_BUTTON_OVERLAY = "com.android.internal.systemui.navbar.threebutton"
        const val GESTURAL_OVERLAY = "com.android.internal.systemui.navbar.gestural"
        /** The clipboard row's Paste (the §6 fill control; the row's own tap is Paste and search). */
        const val PASTE_BUTTON_JS = "document.querySelector('li.zen-suggestion[data-kind=\"clipboard\"] button[aria-label=\"Paste\"]')"
    }
}
