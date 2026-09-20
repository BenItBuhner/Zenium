package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records the phone bar hiding on scroll (Chrome / Edge parity, `lib/barHide.ts` and
 * `BarHideGesture.kt`) on a device and judges it as it goes: a long page served from this
 * process is scrolled with INJECTED touch drags (real pointer events through UiAutomation, the
 * path a finger takes), and after each the chrome's own value – `--zen-bar-hide` on its root, 0
 * shown … 1 hidden, what the bar and the host paint from – is read and held against the claim:
 *
 *  1. a long drag down the page takes the bar off, and once it rests off the page has grown by
 *     the bar's band (the page's `innerHeight` and the WebView's frame, both read directly);
 *  2. a short drag back up the page brings the bar part of the way back one to one while the
 *     finger is down, and a slow release from under half way snaps it home;
 *  3. a release from part way snaps to the nearer end, both ways;
 *  4. a sheet opened over the page with the bar hidden brings the bar back, and a finger on a
 *     row inside the sheet does what the row says (the audit rule after #194);
 *  5. Settings › Look and Feel › URL bar › Hide toolbar when scrolling (a finger on the row's
 *     switch) turns it off – the same drag moves no bar – and back on, and the bar's position
 *     row carries the bar to the top, where 1 to 4 run again against the top edge;
 *  6. a drag inside the page's own inner scroller – a dozen sections down, brought on screen by
 *     script for its step – scrolls the box and moves no bar (Chrome's controls take a scroll
 *     only once it has reached the viewport; a top-docked bar here takes a drag's travel only
 *     once the page's own scroller has moved under the finger);
 *  7. the page's end: a finger landing within the bar's travel of it starts no hide and nothing
 *     twitches (the value is sampled through the gesture, a frame log), the last line is reached
 *     with the bar shown; a drag from higher up to the very end takes the bar off on the way,
 *     the value climbs without a reversal, and the last line is reached with the bar hidden;
 *     a short drag back up from the end brings the bar part of the way back under the finger
 *     and a release from under half way snaps it home (a fourth run read a bar snapped all the
 *     way back here at the top dock, with no finger's travel to account for it);
 *  8. accessibility, from the bar hidden: accessibility focus on the pill (TalkBack's swipe)
 *     brings the bar back; a click on the focused pill (the double-tap) puts the focus in the URL
 *     field, which shuts the gate with the bar shown, and a long drag meanwhile moves no bar;
 *     then the negative – the focus left on the pill, a long drag down the page takes the bar
 *     off under the finger all the same (the host answers a focus event only while no finger is
 *     on the page: a fourth run's return drag found the bar snapped home by Chromium re-raising
 *     the event for the node it held);
 *  9. the overview, from the bar's Tabs button: while it is up the gate is shut with the bar shown,
 *     and back closes it;
 * 10. a pinch zooms the page and moves no bar (the zoom scrolls the view under a changing scale;
 *     a second finger takes the host's filter out of the gesture);
 * 11. short pages, each a document of its own: a page shorter than its viewport and one a few px
 *     over it (less than the bar's travel) keep their bar under a long drag, and the latter's
 *     last line is on screen at its end.
 *
 * Each dock's sequence starts with the page at its top, put there by script (a script's scroll
 * moves no bar): the drags land on the page's own text, not on the box, and a drag from the top
 * has the whole page below it. A fling's outcome is read and written down, not judged: on the
 * software-GPU emulator the fling's scroll arrives in lumps. So is where the bar rests after the
 * negative of step 8: a focus event Chromium re-raises once the finger has lifted is a service's
 * and brings the bar back, by the rule. A bar found off its edge where it should be home, and
 * every claim that did not hold, is written down with both sides' state (the chrome's store, the
 * host's gesture), so a bar stuck hidden can be told from the emulator's jank; the host and the
 * chrome each log every move of the bar that was not the finger's, and the chrome its phases
 * (`BarHide`, `ZenHost`, `ZenChrome` in the logcat). Step 8 leaves no focus behind: a node left
 * focused is Chromium's to re-announce as the bar moves under the drags that follow.
 *
 * `findings.txt` carries every number read; a claim that did not hold fails the run once the
 * recording is done (like [touchFault]). The `theme` instrumentation argument (`light`, the
 * default, or `dark`) picks the colour scheme; screenshots land as `bar-hide-<theme>-*.png`.
 * See [DemoHarness] for the plumbing and [PullToRefreshDemo] for the Settings moves this one
 * shares.
 */
@RunWith(AndroidJUnit4::class)
class BarHideDemo : DemoHarness("bar-hide-demo-state.json", "bar-hide-$THEME", "bar-hide-demo") {
    override val tag = "BarHideDemo"

    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("bar-hide-demo-page.html").toByteArray()),
                SHORT_PATH to ("text/html; charset=utf-8" to readAsset("bar-hide-demo-short.html").toByteArray())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("claims that did not hold:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** Somewhere on the page, clear of both bar positions and of the page's fixed band at its bottom. */
    private val pageX get() = width * 0.5f
    private val pageY get() = height * 0.45f

    override fun warmUp() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        finding("Zenium Android bar hide on scroll ($THEME, ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_000)
        // Pay for the touch pipeline off camera: a scroll down and back up (the page is off its top
        // when the second finger lands, so no pull), then the bar home.
        drag(-160f * density, 400)
        SystemClock.sleep(600)
        drag(220f * density, 400)
        SystemClock.sleep(600)
        settleBar(0.0, "warm-up")
        finding("warm-up done: hide ${hideValue()}, page ${pageInnerHeight()} px tall")
    }

    override fun demo() {
        dockSequence("bottom")
        innerScrollerSequence("bottom")
        pageEndSequence("bottom")
        sheetSequence("bottom")
        overviewSequence("bottom")
        pinchSequence("bottom")
        shortPageSequence("bottom")
        settingsSequence()
        dockSequence("top")
        innerScrollerSequence("top")
        pageEndSequence("top")
        sheetSequence("top")
        overviewSequence("top")
        pinchSequence("top")
        shortPageSequence("top")
    }

    // --- the sequence at one dock ------------------------------------------------------------------

    /**
     * Steps 1 to 3 against the bar at `edge`, with step 8 (accessibility) between 1 and 2 and the
     * fling read at the end. Starts with the bar shown and the page at its top (a fourth run began
     * the top dock's half in the page's last third, where the re-hide after the focus read ran
     * into the page's end); ends with the bar shown.
     */
    private fun dockSequence(edge: String) {
        settleBar(0.0, "$edge start")
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(800)
        finding("[$edge] start: page scrollTop ${pageScrollTop()}, hide ${hideValue()}")
        shot("$edge-01-shown")
        val shownPage = pageInnerHeight()
        val shownFrame = frameHeight()
        finding("[$edge] shown: hide ${hideValue()}, page $shownPage px, frame $shownFrame px")

        // 1. A long drag down the page: the bar goes with the scroll and is off before the finger
        //    lifts; at rest the page has its band.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -LONG * density, 700)
            hold(700)
            val held = hideNumber()
            check("$edge: the bar is off under the finger after a ${LONG.roundToInt()} dp drag down the page", held >= 0.98, "hide $held")
            shot("$edge-02-dragged-off")
            up()
        }
        check("$edge: the bar rests hidden after the release", awaitHide(SETTLE_MS) { it >= 0.995 }, "hide ${hideValue()}")
        check("$edge: the root carries data-bar-hidden at the hidden rest", awaitRest(true), "barHidden ${barHiddenAtRest()}")
        SystemClock.sleep(1_200)
        shot("$edge-03-hidden")
        val hiddenPage = pageInnerHeight()
        val hiddenFrame = frameHeight()
        finding("[$edge] hidden: hide ${hideValue()}, page $hiddenPage px, frame $hiddenFrame px")
        val travel = barTravel()
        check(
            "$edge: the page's innerHeight grew by the bar's travel ($travel CSS px) once the bar rests hidden",
            hiddenPage - shownPage in (travel * 0.75).roundToInt()..(travel * 1.25).roundToInt(),
            "innerHeight $shownPage -> $hiddenPage"
        )
        check(
            "$edge: the page WebView's frame grew by the bar's travel (${(travel * density).roundToInt()} px)",
            hiddenFrame - shownFrame in (travel * density * 0.75).roundToInt()..(travel * density * 1.25).roundToInt(),
            "frame $shownFrame -> $hiddenFrame"
        )

        // The bar's return under accessibility focus on the pill (TalkBack's swipe), the URL
        // field's focus from there, and the negative (focus left on the pill, a re-hide): counted.
        a11ySequence(edge)
        if (hideNumber() < 0.995) {
            drag(-LONG * density, 600)
            awaitHide(SETTLE_MS) { it >= 0.995 }
        }

        // 2. A short drag back up the page: the bar comes back one to one under the finger, and a
        //    slow release from under half way snaps it home.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, SHORT_BACK * density, 500)
            hold(700)
            val held = hideNumber()
            check("$edge: a ${SHORT_BACK.roundToInt()} dp drag up the page brings the bar part of the way back under the finger", held in 0.02..0.6, "hide $held")
            shot("$edge-04-coming-back")
            up()
        }
        check("$edge: the bar rests shown after the release from under half way", awaitHide(SETTLE_MS) { it <= 0.005 }, "hide ${hideValue()}")
        check("$edge: the root drops data-bar-hidden at the shown rest", awaitRest(false), "barHidden ${barHiddenAtRest()}")
        SystemClock.sleep(1_000)
        shot("$edge-05-back")
        finding("[$edge] back: hide ${hideValue()}, page ${pageInnerHeight()} px, frame ${frameHeight()} px")

        // 3. Part way and let go, both sides of half way: the nearer end.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -MID_LOW * density, 450)
            hold(700)
            val held = hideNumber()
            check("$edge: a ${MID_LOW.roundToInt()} dp drag holds the bar part way off", held in 0.05..0.5, "hide $held")
            shot("$edge-06-midway-low")
            up()
        }
        check("$edge: a release from under half way snaps the bar home", awaitHide(SETTLE_MS) { it <= 0.005 }, "hide ${hideValue()}")
        SystemClock.sleep(800)
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -MID_HIGH * density, 450)
            hold(700)
            val held = hideNumber()
            check("$edge: a ${MID_HIGH.roundToInt()} dp drag holds the bar past half way", held in 0.5..0.97, "hide $held")
            shot("$edge-07-midway-high")
            up()
        }
        check("$edge: a release from past half way snaps the bar off", awaitHide(SETTLE_MS) { it >= 0.995 }, "hide ${hideValue()}")
        SystemClock.sleep(800)
        shot("$edge-08-snapped-off")

        // A fling up the page (read, not judged): Chrome's controls come back on a fling towards the top.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, 240 * density, 110)
            up()
        }
        val flungBack = awaitHide(SETTLE_MS) { it <= 0.005 }
        finding("[$edge] fling up the page from hidden: bar back ${if (flungBack) "yes" else "no"} (hide ${hideValue()})")
        settleBar(0.0, "$edge after the fling")
        SystemClock.sleep(600)
    }

    /**
     * Step 4 at `edge`: with the bar hidden a sheet comes up (the tab's context menu, asked of
     * the core: no bar to reach a button on) and the bar comes back for it; a finger on the
     * sheet's Mute Tab row mutes the tab (the row's own result, per the audit rule); the sheet
     * goes with the row and the bar stays.
     */
    private fun sheetSequence(edge: String) {
        // Room below for the hide (the page's end, where the sequence before this one leaves the page, has none).
        settleBar(0.0, "$edge before the sheet")
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(800)
        drag(-LONG * density, 600)
        if (!awaitHide(SETTLE_MS) { it >= 0.995 }) finding("[$edge] sheet step: the bar did not hide first (hide ${hideValue()})")
        SystemClock.sleep(600)
        coreInvoke("tab.contextMenu", "{\"tabId\":\"$TAB_ID\"}")
        val surface = awaitSurface(up = true, timeoutMs = 8_000)
        check("$edge: a sheet over the page brings the hidden bar back", awaitHide(SETTLE_MS) { it <= 0.005 }, "surface $surface, hide ${hideValue()}")
        SystemClock.sleep(1_200)
        shot("$edge-09-sheet-bar-back")
        // Rows below the sheet's peek are out of a finger's reach: pull it up by its handle first
        // (the context menu is a `MenuSheet`, with the app menu's grabber label).
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        val wasMuted = activeCoreTab()?.optBoolean("muted") == true
        val row = if (wasMuted) UNMUTE_ROW else MUTE_ROW
        val muted = { activeCoreTab()?.optBoolean("muted") == !wasMuted }
        var took = touchTapLabelExpecting(row, "the tab reads muted=${!wasMuted}", took = muted)
        if (!took && !muted() && reveal(row) != null) {
            // The row sat below the fold: scrolled into view through the tree, the finger tries again.
            took = touchTapLabelExpecting(row, "the tab reads muted=${!wasMuted}", took = muted)
        }
        if (!took) finding("[$edge] the touch on '$row' did not take or the row was out of reach")
        if (!awaitSurface(up = false, timeoutMs = 8_000)) {
            finding("[$edge] the sheet stayed up after the row; closing it with back")
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
        }
        check("$edge: the bar stays shown once the sheet has gone", awaitHide(SETTLE_MS) { it <= 0.005 }, "hide ${hideValue()}")
        SystemClock.sleep(1_200)
        shot("$edge-10-sheet-gone-bar-shown")
    }

    /**
     * Step 6 at `edge`: a finger inside the page's inner scroller (its `overflow: auto` box, a
     * dozen sections down) scrolls the box and moves no bar. The page's own `onScrollChanged`
     * never fires for an inner scroller, so a bottom-docked bar has nothing to follow, and a
     * top-docked bar takes nothing from a drag the page has not scrolled under ([BarHideShare]).
     * Starts with the bar shown, brings the box to the middle of the viewport by script (no
     * finger: the bar stays), and leaves the page scrolled past the box with the bar shown, so
     * the drags after it are the page's own.
     */
    private fun innerScrollerSequence(edge: String) {
        settleBar(0.0, "$edge before the inner scroller")
        pageJs("(function(){var b=document.getElementById('inner');window.scrollTo(0,b.getBoundingClientRect().top+document.scrollingElement.scrollTop-(window.innerHeight-b.offsetHeight)/2)})()")
        SystemClock.sleep(900)
        val box = pageRect("inner")
        val onScreen = box != null && box.top > height * 0.2 && box.bottom < height * 0.8
        check("$edge: the page's inner scroller is in the middle of the screen for its finger", onScreen, "box $box in a ${width}x$height window")
        if (box == null || !onScreen) return
        val before = pageNumber("document.getElementById('inner').scrollTop")
        finding("[$edge] inner scroller at $box on screen, scrollTop $before, page at ${pageScrollTop()}, hide ${hideValue()}")
        val log = frameLog {
            Finger().apply {
                down(box.exactCenterX(), box.exactCenterY())
                moveBy(0f, -INNER_DRAG * density, 600)
                hold(700)
                shot("$edge-11-inner-scroller")
                up()
            }
        }
        SystemClock.sleep(800)
        val after = pageNumber("document.getElementById('inner').scrollTop")
        val pageTop = pageNumber("document.scrollingElement.scrollTop")
        check("$edge: a ${INNER_DRAG.roundToInt()} dp drag inside the page's inner scroller scrolls the box", after - before >= INNER_DRAG * 0.4, "scrollTop $before -> $after")
        check(
            "$edge: the same drag moves no bar (the box's scroll never reaches the page)",
            log.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${log.maxOrNull() ?: 0.0} over ${log.size} frames, now ${hideValue()}, page scrollTop $pageTop"
        )
        // Past the box: a drag from mid-screen after this must scroll the page itself.
        pageJs("window.scrollTo(0, document.getElementById('inner').getBoundingClientRect().bottom + document.scrollingElement.scrollTop + 40)")
        SystemClock.sleep(900)
    }

    /**
     * Step 7 at `edge`: the page's end. A finger landing with less than the bar's travel left to
     * scroll starts no hide – the page laid out a band taller would have that band less to
     * scroll, and Chromium would clamp the scroll back, which a run before this one never drove
     * ([BarHideScrollFilter]) – and nothing twitches: the value is sampled through the gesture,
     * and the page's last line is reached with the bar shown. Then, from higher up, a drag to
     * the very end takes the bar off on the way, the value climbs without a reversal, and the
     * last line is reached with the bar hidden. Then a short drag back up from the end brings
     * the bar part of the way back under the finger (the page keeps its tall layout until the
     * bar rests, so nothing is clamped on the way) and a release from under half way snaps it
     * home. Starts with the bar shown; leaves the page at its end with the bar shown.
     */
    private fun pageEndSequence(edge: String) {
        settleBar(0.0, "$edge before the page's end")
        val travel = barTravel()
        pageJs("window.scrollTo(0, document.scrollingElement.scrollHeight - window.innerHeight - ${(travel / 2).roundToInt()})")
        SystemClock.sleep(900)
        finding("[$edge] near the end: ${pageRemaining()} CSS px left to scroll (travel $travel), hide ${hideValue()}")
        val nearLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, -NEAR_END_DRAG * density, 900)
                hold(700)
                shot("$edge-12-near-end-held")
                up()
            }
        }
        SystemClock.sleep(900)
        check(
            "$edge: a slow ${NEAR_END_DRAG.roundToInt()} dp drag from within the bar's travel of the page's end starts no hide",
            nearLog.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${nearLog.maxOrNull() ?: 0.0} over ${nearLog.size} frames, now ${hideValue()}"
        )
        check("$edge: nothing twitches near the end (the frame log holds one direction)", reversals(nearLog) == 0, "reversals ${reversals(nearLog)} in ${nearLog.size} frames")
        check(
            "$edge: the page's last line is reached with the bar shown",
            lastLineReached(),
            "remaining ${pageRemaining()} CSS px, last line's bottom ${lastLineBottom()} in a page ${pageInnerHeight()} tall"
        )
        shot("$edge-13-end-bar-shown")

        pageJs("window.scrollTo(0, document.scrollingElement.scrollHeight - window.innerHeight - ${FROM_ABOVE_END.roundToInt()})")
        SystemClock.sleep(900)
        finding("[$edge] above the end: ${pageRemaining()} CSS px left to scroll, hide ${hideValue()}")
        var held = 0.0
        val endLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, -LONG * density, 900)
                hold(700)
                held = hideNumber()
                shot("$edge-14-end-dragged-off")
                up()
            }
        }
        check("$edge: a drag to the very end of the page takes the bar off on the way", held >= 0.98, "hide $held")
        check("$edge: the bar rests hidden at the page's end", awaitHide(SETTLE_MS) { it >= 0.995 }, "hide ${hideValue()}")
        check(
            "$edge: the value climbed to the end without a reversal (the frame log)",
            reversals(endLog) == 0,
            "reversals ${reversals(endLog)} in ${endLog.size} frames: ${endLog.joinToString(" ") { "%.2f".format(it) }}"
        )
        SystemClock.sleep(900)
        check(
            "$edge: the page's last line is reached with the bar hidden",
            lastLineReached(),
            "remaining ${pageRemaining()} CSS px, last line's bottom ${lastLineBottom()} in a page ${pageInnerHeight()} tall"
        )
        shot("$edge-15-end-hidden")

        // Back up from the end: the bar comes back one to one under the finger and snaps home from under half way.
        val returnLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, SHORT_BACK * density, 500)
                hold(700)
                val held = hideNumber()
                check(
                    "$edge: a ${SHORT_BACK.roundToInt()} dp drag up the page from its end brings the bar part of the way back under the finger",
                    held in 0.02..0.6,
                    "hide $held"
                )
                shot("$edge-16-end-coming-back")
                up()
            }
        }
        check("$edge: the bar rests shown after the release from under half way at the page's end", awaitHide(SETTLE_MS) { it <= 0.005 }, "hide ${hideValue()}")
        check(
            "$edge: the return from the end held one direction (the frame log)",
            reversals(returnLog) == 0,
            "reversals ${reversals(returnLog)} in ${returnLog.size} frames: ${returnLog.joinToString(" ") { "%.2f".format(it) }}"
        )
        SystemClock.sleep(800)
    }

    /**
     * Step 5: Settings › Look and Feel › URL bar. A finger on the Hide toolbar when scrolling
     * switch turns it off (the core's settings say so), the same drag then moves no bar, a
     * finger turns it back on, and the bar's position row's picker (a finger on Top) carries the
     * bar to the top edge for the second half.
     */
    private fun settingsSequence() {
        openLookAndFeel()
        val row = revealRow(HIDE_ROW) ?: error("no $HIDE_ROW row in Look and Feel")
        shot("settings-01-row")
        finding("settings: hideToolbarOnScroll ${hideSetting()} before the touch")
        check("settings: a finger on the switch turns Hide toolbar when scrolling off", toggleHideRow(row, expected = false), "hideToolbarOnScroll ${hideSetting()}")
        SystemClock.sleep(800)
        shot("settings-02-row-off")
        leaveSettings()
        SystemClock.sleep(1_000)
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -LONG * density, 700)
            hold(700)
            val held = hideNumber()
            check("setting off: a ${LONG.roundToInt()} dp drag down the page moves no bar", held <= 0.005, "hide $held")
            shot("settings-03-off-no-hide")
            up()
        }
        SystemClock.sleep(1_000)
        drag(LONG * density, 500)
        SystemClock.sleep(800)

        openLookAndFeel()
        val again = revealRow(HIDE_ROW) ?: error("no $HIDE_ROW row in Look and Feel")
        check("settings: a finger on the switch turns Hide toolbar when scrolling back on", toggleHideRow(again, expected = true), "hideToolbarOnScroll ${hideSetting()}")
        SystemClock.sleep(600)
        // The bar position's picker (a hosted sheet): a finger on the row opens it (a Settings-page
        // row, so the tree's click stands in when it is off screen), a finger on its Top option is
        // the flow's injected touch, and the picker must close with the row reading Top.
        revealRow(BAR_ROW) ?: error("no $BAR_ROW row in Look and Feel")
        if (!touchTapLabel(BAR_ROW, prefix = true)) clickRow(BAR_ROW)
        if (waitFor("Top", 8_000) == null) error("no Top option for the bar position")
        if (!touchTapLabelExpecting("Top", "the picker closed with the row reading Top") { rowReads(BAR_ROW, "Top") } &&
            !rowReads(BAR_ROW, "Top") && !clickByLabel("Top")
        ) error("no Top option for the bar position")
        SystemClock.sleep(1_200)
        shot("settings-04-position-top")
        leaveSettings()
        SystemClock.sleep(1_500)
        finding("bar carried to the top: hide ${hideValue()}, page ${pageInnerHeight()} px, frame ${frameHeight()} px")
        // Back near the page's top for the second half, with the bar home (the page may already be
        // at its top: a plain drag down from there would be a pull-to-refresh).
        toTop()
        settleBar(0.0, "top dock start")
    }

    // --- moves -------------------------------------------------------------------------------------

    /** One vertical drag from mid-page: `dy` px (negative up the screen, i.e. down the page), released at once. */
    private fun drag(dy: Float, durationMs: Long) {
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, dy, durationMs)
            up()
        }
    }

    /**
     * Scroll the page up towards its top without pulling it: a short drag down the page first (a
     * drag that begins that way is never a pull, and it leaves the page off its top), then a long
     * drag back up – it began with the page off the top, so it is the page's alone. The bar goes
     * off with the first drag and comes back with the second.
     */
    private fun toTop() {
        drag(-80f * density, 250)
        SystemClock.sleep(900)
        drag(LONG * density, 400)
        SystemClock.sleep(1_000)
    }

    /**
     * Wait for the bar to rest at `target` (0 or 1); a bar left elsewhere is dragged home and
     * noted with both sides' state – the chrome's store (phase, allowed, progress) and the host's
     * gesture (its frame, the finger, the mirror, the last three moves) – so a bar stuck off its
     * edge in the field reads differently from a drag the emulator's frames swallowed.
     */
    private fun settleBar(target: Double, where: String) {
        val near = { v: Double -> abs(v - target) <= 0.005 }
        if (awaitHide(SETTLE_MS, near)) return
        finding("$where: the bar rests at ${hideValue()}, not $target; chrome ${chromeBarHide()}; host ${hostBarHide()}; dragging it ${if (target == 0.0) "back" else "off"}")
        if (target == 0.0) toTop() else drag(-LONG * density, 500)
        if (!awaitHide(SETTLE_MS, near)) finding("$where: the bar still rests at ${hideValue()}; chrome ${chromeBarHide()}; host ${hostBarHide()}")
    }

    /**
     * `--zen-bar-hide` sampled about every 40 ms on a thread of its own while `during` runs (the
     * finger's moves are injected from this one): the frame log of a gesture, oldest first.
     */
    private fun frameLog(during: () -> Unit): List<Double> {
        val samples = CopyOnWriteArrayList<Double>()
        val on = AtomicBoolean(true)
        val sampler = Thread {
            while (on.get()) {
                samples += hideNumber()
                SystemClock.sleep(40)
            }
        }
        sampler.start()
        try {
            during()
        } finally {
            on.set(false)
            sampler.join(3_000)
        }
        return samples.toList()
    }

    /** How often a sampled value turned around by more than a hair: 0 for one that only ever climbed, or only ever fell. */
    private fun reversals(log: List<Double>): Int {
        var count = 0
        var direction = 0
        var last = log.firstOrNull() ?: return 0
        for (v in log.drop(1)) {
            val d = v - last
            if (abs(d) < 0.02) continue
            val dir = if (d > 0) 1 else -1
            if (direction != 0 && dir != direction) count++
            direction = dir
            last = v
        }
        return count
    }

    /**
     * Accessibility at `edge`, from the bar hidden. Accessibility focus on the address pill (what
     * TalkBack's swipe does) brings the bar back – counted since the fifth run, read only before.
     * A click on the focused pill (TalkBack's double-tap) puts the focus in the URL field: the gate
     * shuts with the bar shown and a long drag on the screen meanwhile moves no bar (v2 draft 11.5:
     * the band stays shown while the URL field has focus). Then the field is left, and the
     * negative runs: the focus is put back on the pill and LEFT there, and a long drag down the
     * page must take the bar off under the finger all the same – Chromium re-raises the focus
     * event for the node it holds as the bar moves under the drag, and the host answers it only
     * while no finger is on the page (a fourth run's return drag found the bar snapped home by
     * that very event). Where the bar rests once the finger has lifted is read, not judged: an
     * event re-raised then is a service's, and brings the bar back. Ends with the focus cleared.
     */
    private fun a11ySequence(edge: String) {
        val pill = pillNode()
        val focused = pill?.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS) == true
        check(
            "$edge: accessibility focus on the hidden pill brings the bar back",
            awaitHide(3_000) { it <= 0.005 },
            "pill ${if (pill == null) "not in the tree" else if (focused) "focused" else "refused the focus"}, hide ${hideValue()}"
        )
        SystemClock.sleep(800)
        shot("$edge-03b-a11y-focus-bar-back")

        // The URL field: a click on the focused pill (TalkBack's double-tap) opens the omnibox on
        // it; a finger on the pill stands in when the tree's click is refused.
        var clicked = pillNode()?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
        var fieldOpen = awaitChrome(4_000) { urlbarOpen() }
        if (!fieldOpen) {
            clicked = touchTapLabel(PILL_LABEL, prefix = true)
            fieldOpen = awaitChrome(6_000) { urlbarOpen() }
        }
        check(
            "$edge: the URL field's focus shuts the gate with the bar shown",
            fieldOpen && !barAllowed() && hideNumber() <= 0.005,
            "click ${if (clicked) "taken" else "refused"}, URL field open $fieldOpen, gate open ${barAllowed()}, hide ${hideValue()}"
        )
        SystemClock.sleep(600)
        shot("$edge-03c-url-field-bar-shown")
        val fieldLog = frameLog { drag(-LONG * density, 600) }
        check(
            "$edge: a ${LONG.roundToInt()} dp drag with the URL field focused moves no bar",
            fieldLog.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${fieldLog.maxOrNull() ?: 0.0} over ${fieldLog.size} frames, now ${hideValue()}, URL field open ${urlbarOpen()}"
        )
        closeUrlbar()
        awaitIme(false)
        val fieldClosed = awaitChrome(6_000) { !urlbarOpen() }
        finding("[$edge] the URL field ${if (fieldClosed) "closed" else "stayed open"} after back: gate open ${barAllowed()}, hide ${hideValue()}")
        settleBar(0.0, "$edge after the URL field")
        SystemClock.sleep(800)

        // The negative: the focus left on the pill, and a drag that hides the bar under it.
        val again = pillNode()
        val left = again?.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS) == true
        SystemClock.sleep(800)
        var held = 0.0
        val hideLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, -LONG * density, 700)
                hold(700)
                held = hideNumber()
                shot("$edge-03d-focus-left-re-hide")
                up()
            }
        }
        check(
            "$edge: with accessibility focus left on the pill a ${LONG.roundToInt()} dp drag down the page takes the bar off under the finger all the same",
            held >= 0.98,
            "focus ${if (again == null) "found no pill" else if (left) "on the pill" else "refused"}, hide $held, frames ${hideLog.joinToString(" ") { "%.2f".format(it) }}"
        )
        val restHidden = awaitHide(SETTLE_MS) { it >= 0.995 }
        finding("[$edge] after the re-hide with the focus left on the pill the bar ${if (restHidden) "rests hidden" else "rests at ${hideValue()} (a focus event re-raised once the finger had lifted brings it back: a service's)"}")
        // The focus is taken off again: TalkBack's would move on with the next swipe, and a node
        // left focused is Chromium's to re-announce as its bounds change under the drags that follow.
        pillNode()?.performAction(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS)
        SystemClock.sleep(600)
    }

    /** The address pill's node in the tree (its label carries the address after a comma); null when it is not listed. */
    private fun pillNode(): AccessibilityNodeInfo? = findNode { it == PILL_LABEL || it.startsWith("$PILL_LABEL,") }

    /**
     * The overview at `edge`: a finger on the bar's Tabs button opens it over the page, and while
     * it is up the gate is shut with the bar shown (v2 draft 11.5: the band stays shown while the
     * overview is open; the stage over the page is a cover, like a sheet). Back closes it and the
     * gate opens again. Starts and ends with the bar shown – with the bar hidden its Tabs button
     * is out of reach, as Chrome's is, so the overview is opened from the bar shown.
     */
    private fun overviewSequence(edge: String) {
        settleBar(0.0, "$edge before the overview")
        val tabs = findByLabelPrefix(TABS_LABEL)
        var open = false
        if (tabs != null) {
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            open = waitFor(OVERVIEW_LABEL, 8_000) != null && awaitChrome(4_000) { overviewOpen() }
            SystemClock.sleep(1_500)
        }
        check(
            "$edge: the overview over the page (a finger on the bar's Tabs button) shuts the gate with the bar shown",
            open && !barAllowed() && hideNumber() <= 0.005,
            "Tabs button ${tabs ?: "not in the tree"}, overview open ${overviewOpen()}, gate open ${barAllowed()}, hide ${hideValue()}"
        )
        if (open) shot("$edge-17-overview-bar-shown")
        if (!overviewOpen()) return
        back()
        val closed = awaitChrome(8_000) { !overviewOpen() }
        SystemClock.sleep(1_500)
        finding("[$edge] the overview ${if (closed) "closed" else "stayed open"} after back: gate open ${barAllowed()}, hide ${hideValue()}")
        if (!closed) {
            back()
            awaitChrome(6_000) { !overviewOpen() }
        }
    }

    /**
     * A pinch at `edge`: two fingers moving apart zoom the page, which scrolls the view under a
     * changing scale – `onScrollChanged` fires with two fingers down – and the bar must not move
     * for it (Chrome's controls hold still through a pinch; a second finger takes the host's
     * filter to NONE for the rest of the gesture, `BarHideScrollFilter.pointerDown`). The page is
     * left zoomed; the sequence after this one loads another document, which puts the scale back.
     */
    private fun pinchSequence(edge: String) {
        settleBar(0.0, "$edge before the pinch")
        pageJs("window.scrollTo(0, 600)")
        SystemClock.sleep(900)
        val scaleBefore = pageScale()
        finding("[$edge] before the pinch: scale $scaleBefore, page scrollTop ${pageScrollTop()}, hide ${hideValue()}")
        val log = frameLog {
            pinch(width * 0.5f, height * 0.4f, 80 * density, 320 * density, 700)
            SystemClock.sleep(700)
            shot("$edge-18-pinched")
        }
        SystemClock.sleep(800)
        val scaleAfter = pageScale()
        check("$edge: the pinch zoomed the page", scaleAfter >= scaleBefore * 1.2, "scale $scaleBefore -> $scaleAfter, page scrollTop ${pageScrollTop()}")
        check(
            "$edge: the pinch moved no bar",
            log.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${log.maxOrNull() ?: 0.0} over ${log.size} frames, now ${hideValue()}"
        )
    }

    /**
     * Short pages at `edge` (v2 draft 11.5: the band stays shown on a page shorter than its
     * viewport). A page shorter than its viewport scrolls not at all, and a long drag down it
     * moves no bar; a page a few px over its viewport – less than the bar's travel – scrolls to
     * its end under the same drag with the bar still in place, and its last line is on screen.
     * Each is a document of its own, so the bar is shown as it comes up; ends back on the long
     * page, at its top, with the bar shown.
     */
    private fun shortPageSequence(edge: String) {
        settleBar(0.0, "$edge before the short pages")
        loadPage("$ORIGIN$SHORT_PATH?over=-80")
        finding("[$edge] a page shorter than its viewport: ${pageRemaining()} CSS px to scroll, hide ${hideValue()}")
        val shortLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, -LONG * density, 700)
                hold(500)
                shot("$edge-19-short-page")
                up()
            }
        }
        SystemClock.sleep(800)
        check(
            "$edge: a ${LONG.roundToInt()} dp drag down a page shorter than its viewport moves no bar",
            shortLog.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${shortLog.maxOrNull() ?: 0.0} over ${shortLog.size} frames, now ${hideValue()}, page scrollTop ${pageScrollTop()}"
        )

        loadPage("$ORIGIN$SHORT_PATH?over=$OVER_PX")
        finding("[$edge] a page $OVER_PX px over its viewport: ${pageRemaining()} CSS px to scroll (travel ${barTravel()}), hide ${hideValue()}")
        val overLog = frameLog {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, -LONG * density, 700)
                hold(500)
                shot("$edge-20-page-over-by-less-than-the-travel")
                up()
            }
        }
        SystemClock.sleep(800)
        check(
            "$edge: a ${LONG.roundToInt()} dp drag down a page $OVER_PX px over its viewport (less than the bar's travel) moves no bar",
            overLog.all { it <= 0.005 } && hideNumber() <= 0.005,
            "hide max ${overLog.maxOrNull() ?: 0.0} over ${overLog.size} frames, now ${hideValue()}"
        )
        val bottom = lastLineBottom()
        check(
            "$edge: the short page's end is reached with the bar shown, its last line on screen",
            pageRemaining() == 0 && bottom > 0 && bottom <= pageInnerHeight(),
            "remaining ${pageRemaining()} CSS px, last line's bottom $bottom in a page ${pageInnerHeight()} tall"
        )

        loadPage("$ORIGIN/")
        pageJs("window.scrollTo(0, 0)")
        SystemClock.sleep(800)
        settleBar(0.0, "$edge back on the long page")
    }

    /** Navigate the tab's page to `url` by script (a new document: the bar shows for it) and wait for it to load. */
    private fun loadPage(url: String) {
        pageJs("location.href = ${JSONObject.quote(url)}")
        awaitLoaded(url)
        SystemClock.sleep(1_500)
    }

    /**
     * Settings from the menu sheet, then Look and Feel over the tab's landing (since #134 the
     * Settings tab opens on its categories; the rows are in the section). The bar must be shown
     * for the Menu button to be in reach; a bar off its edge is brought back first.
     */
    private fun openLookAndFeel() {
        settleBar(0.0, "before Settings")
        ensureForeground()
        val menu = findByLabel(MENU_LABEL) ?: error("no menu button")
        Finger().tap(menu.exactCenterX(), menu.exactCenterY())
        SystemClock.sleep(2_500)
        reveal("Settings")
        val landing = { findNode { it.startsWith(LOOK_AND_FEEL) } != null }
        if (!touchTapLabelExpecting("Settings", "the Settings tab is up on its landing", took = landing) &&
            !landing() && !clickByLabel("Settings")
        ) error("no Settings row in the menu")
        SystemClock.sleep(1_500)
        val section = { findByLabel(APPEARANCE) != null }
        if (!section() && !touchTapLabelExpecting(LOOK_AND_FEEL, "the Look and Feel section is up", prefix = true, took = section) &&
            !section() && !clickRow(LOOK_AND_FEEL)
        ) error("no $LOOK_AND_FEEL row on the Settings landing")
        SystemClock.sleep(3_000)
    }

    /** Leave the Settings tab for the page: back pops the section, and a back at the landing closes the tab to its opener. */
    private fun leaveSettings() {
        back()
        SystemClock.sleep(2_000)
        if (findNode { it.startsWith(LOOK_AND_FEEL) } != null && findByLabel(APPEARANCE) == null) {
            back()
            SystemClock.sleep(2_500)
        }
    }

    /** Scroll the Settings row whose text starts with `label` into view and return where it is; null when there is none. */
    private fun revealRow(label: String): Rect? {
        val node = findNode { it.startsWith(label) } ?: return null
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findNode { it.startsWith(label) }?.let { row -> Rect().also { row.getBoundsInScreen(it) } }
    }

    /** Click the Settings row whose text starts with `label` through the tree (the nearest clickable ancestor). */
    private fun clickRow(label: String): Boolean {
        var node = findNode { it.startsWith(label) }
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    /**
     * A finger on the Hide toolbar when scrolling row's switch (at the row's right end, inside
     * the touchable window), then up to five seconds for the core's setting to read `expected`.
     */
    private fun toggleHideRow(row: Rect, expected: Boolean): Boolean {
        val point = touchPoint(Rect((width - 84 * density).roundToInt(), row.top, (width - 40 * density).roundToInt(), row.bottom))
        if (point == null) {
            finding("settings: the switch of '$HIDE_ROW' is outside the touchable window ($row)")
            return false
        }
        Finger().tap(point.x, point.y)
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (hideSetting() == expected) return true
            SystemClock.sleep(200)
        }
        return hideSetting() == expected
    }

    // --- reads -------------------------------------------------------------------------------------

    /** The chrome's `--zen-bar-hide` as computed on its root: 0 with the bar shown, 1 with it off. */
    private fun hideValue(): String {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-bar-hide').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "(unset)" } ?: "(unset)"
    }

    private fun hideNumber(): Double = hideValue().toDoubleOrNull() ?: 0.0

    /** Poll `--zen-bar-hide` until `settled` accepts it or `timeoutMs` has passed; true when it did. */
    private fun awaitHide(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(hideNumber())) return true
            SystemClock.sleep(120)
        }
        return settled(hideNumber())
    }

    /** `data-bar-hidden` on the chrome's root: the boolean at rest (`uiStore.barHidden`). */
    private fun barHiddenAtRest(): Boolean = chromeJs("document.documentElement.dataset.barHidden==='true'") == "true"

    private fun awaitRest(hidden: Boolean, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (barHiddenAtRest() == hidden) return true
            SystemClock.sleep(150)
        }
        return barHiddenAtRest() == hidden
    }

    /**
     * The band the page gains once the bar is hidden, CSS px: the chrome's store (`barHideStore.travel`,
     * what the machine and the host's frame carry). Not `--zen-bar-hide-travel` off the root: an
     * unregistered property's computed value keeps its `calc()`, which parses to nothing – run 3
     * printed this fallback while the page grew by 50. 50 (a 56 band less the phone's 6 gutter)
     * when the store cannot be read.
     */
    private fun barTravel(): Double {
        val raw = chromeJs("(((window.__zenStores||{})['bar-hide']||{get:function(){return {}}}).get()||{}).travel")
        return raw.toDoubleOrNull()?.takeIf { it > 0 } ?: 50.0
    }

    /** The chrome's gate for the bar (`barHideStore.allowed`): false while something holds the bar shown. */
    private fun barAllowed(): Boolean =
        chromeJs("(((window.__zenStores||{})['bar-hide']||{get:function(){return {}}}).get()||{}).allowed===true") == "true"

    /** The URL field is open in the chrome (`uiStore.urlbar.open`). */
    private fun urlbarOpen(): Boolean =
        chromeJs("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true") == "true"

    /** The tab overview is up in the chrome (`stageStore.overview.phase`, anything but closed). */
    private fun overviewOpen(): Boolean =
        chromeJs("((((window.__zenStores||{}).stage||{get:function(){return {}}}).get()||{}).overview||{}).phase!=='closed'") == "true"

    /** Poll a read of the chrome until it holds or `timeoutMs` has passed; true when it did. */
    private fun awaitChrome(timeoutMs: Long, holds: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (holds()) return true
            SystemClock.sleep(150)
        }
        return holds()
    }

    private fun hideSetting(): Boolean? =
        coreState().optJSONObject("settings")?.let { if (it.has("hideToolbarOnScroll")) it.getBoolean("hideToolbarOnScroll") else null }

    /** Evaluate in the demo page's WebView; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    /** A number read from the page (`pageJs`); -1 when it did not answer with one. */
    private fun pageNumber(code: String): Double = pageJs(code).toDoubleOrNull() ?: -1.0

    /** The page's own viewport height, CSS px, as its script sees it (`innerHeight`); -1 when it did not answer. */
    private fun pageInnerHeight(): Int = pageNumber("window.innerHeight").toInt()

    /** The page's own scroll position, CSS px (0 at its top). */
    private fun pageScrollTop(): Int = pageNumber("Math.round(document.scrollingElement.scrollTop)").toInt()

    /** The page's pinch-zoom scale as its script sees it (`visualViewport.scale`, 1 at rest); -1 when it did not answer. */
    private fun pageScale(): Double = pageNumber("window.visualViewport ? window.visualViewport.scale : 1")

    /** How much further the page can scroll, CSS px (0 at its end). */
    private fun pageRemaining(): Int =
        pageNumber("Math.round(document.scrollingElement.scrollHeight - window.innerHeight - document.scrollingElement.scrollTop)").toInt()

    /** The bottom of the page's last line in its viewport, CSS px. */
    private fun lastLineBottom(): Int = pageNumber("Math.round(document.getElementById('last').getBoundingClientRect().bottom)").toInt()

    /** The page's last line is on screen, above the 40 px badge fixed to the viewport's bottom edge. */
    private fun lastLineReached(): Boolean {
        val bottom = lastLineBottom()
        return bottom > 0 && bottom <= pageInnerHeight() - 40
    }

    /**
     * Where the page element `id` is on the screen (device px): its rect in the page's viewport,
     * scaled by the density (the page is at scale 1), from the WebView's place on the screen.
     * Null when the page did not answer.
     */
    private fun pageRect(id: String): Rect? {
        val raw = pageJs("JSON.stringify((r=>({x:r.left,y:r.top,w:r.width,h:r.height}))(document.getElementById('$id').getBoundingClientRect()))")
        val text = JSONTokener(raw).nextValue() as? String ?: return null
        val rect = runCatching { JSONObject(text) }.getOrNull() ?: return null
        var left = 0
        var top = 0
        var found = false
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID) ?: return@runOnMainSync
            val at = IntArray(2)
            view.getLocationOnScreen(at)
            left = at[0]
            top = at[1]
            found = true
        }
        if (!found) return null
        val x = left + rect.getDouble("x") * density
        val y = top + rect.getDouble("y") * density
        return Rect(x.roundToInt(), y.roundToInt(), (x + rect.getDouble("w") * density).roundToInt(), (y + rect.getDouble("h") * density).roundToInt())
    }

    /** The chrome's bar-hide store (`barHideStore`: progress, phase, edge, travel, allowed), for the record. */
    private fun chromeBarHide(): String {
        val raw = chromeJs("JSON.stringify(((window.__zenStores||{})['bar-hide']||{get:function(){return null}}).get())")
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /** The host's side of the bar on the page (`BarHideGesture.describe`) and the tab host's frame, for the record. */
    private fun hostBarHide(): String {
        var line = "(no page view)"
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID) ?: return@runOnMainSync
            line = view.barHide.describe() + " tabHost=" + (host.tabs.barHide?.let { "${it.edge} ${it.offsetPx}/${it.travelPx}px" } ?: "null")
        }
        return line
    }

    /** The page WebView's laid-out height in device px, less what it is translated by (its frame on screen at rest). */
    private fun frameHeight(): Int {
        var result = -1
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID) ?: return@runOnMainSync
            result = view.height
        }
        return result
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
        finding("gave up waiting for $url")
    }

    // --- the record --------------------------------------------------------------------------------

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    /**
     * A claim of the sequence: written down either way, and a claim that did not hold fails the
     * run at the end – with both sides' state as it stood when the claim was read, so the record
     * says where the bar was and why (a finger still down, a gate, the host's mirror).
     */
    private fun check(claim: String, held: Boolean, detail: String) {
        if (held) {
            finding("OK   $claim ($detail)")
            return
        }
        finding("FAIL $claim ($detail); chrome ${chromeBarHide()}; host ${hostBarHide()}")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val PORT = 18142
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** The short pages (`bar-hide-demo-short.html`): the body is the viewport plus the `over` query, CSS px. */
        private const val SHORT_PATH = "/short"
        /** How far over its viewport the second short page runs: under the bar's travel (50 CSS px) with room. */
        private const val OVER_PX = 30
        private const val TAB_ID = "tab_long"
        /** The bar's tab-count button (`Tabs (1)`), and the overview's header button that says it is up. */
        private const val TABS_LABEL = "Tabs ("
        private const val OVERVIEW_LABEL = "Spaces"
        private const val MUTE_ROW = "Mute Tab"
        private const val UNMUTE_ROW = "Unmute Tab"
        private const val HIDE_ROW = "Hide toolbar when scrolling"
        private const val BAR_ROW = "Position on phones"
        private const val LOOK_AND_FEEL = "Look and Feel"
        private const val APPEARANCE = "Appearance"
        /** A spring on the emulator's software GPU takes a while; the value lands well within this. */
        private const val SETTLE_MS = 5_000L
        /**
         * Finger travel in dp. The bar's travel is 50 CSS px (the 56 band less the phone's 6
         * gutter); the WebView eats the touch slop (8 dp) before the first scroll, so a drag moves
         * the bar by about its length less 8. 320 is off many times over; 40 brings the bar about
         * two thirds of the way back; 26 and 44 hold it about a third and three quarters of the
         * way off.
         */
        private const val LONG = 320f
        private const val SHORT_BACK = 40f
        private const val MID_LOW = 26f
        private const val MID_HIGH = 44f
        /** Inside the inner scroller: well past the slop, well short of the box's own end. */
        private const val INNER_DRAG = 120f
        /** Near the page's end: more than the half travel left, so the page reaches its end under the finger and the rest overscrolls. */
        private const val NEAR_END_DRAG = 60f
        /** Where the drag to the very end starts from, CSS px above it: room for the hide (travel plus slop) and the rest of the page. */
        private const val FROM_ABOVE_END = 240f
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
    }
}
