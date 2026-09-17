package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The first tap on the tab overview, with OS-level touch input (UiAutomation injects real
 * `MotionEvent`s through the same `InputManager` path `adb shell input tap` uses, so the WebView
 * sees a finger: gesture recognition, fling handling, hover emulation and all).
 *
 * A phone opens the overview in a frame; on the emulator's software GPU it takes over a second to
 * appear, by which time its spring has settled – so besides the literal sequences (open, tap the
 * moment the grid shows) the trials recreate the two states a phone puts a quick tap into while
 * the grid is already on screen: the overview still settling (a pull towards closed, let go with
 * the finger stopped, springs back open) and the ~300 ms after a fast pill release (a flick up on
 * the pill, then a tap). Every first tap must pick the card; the run fails otherwise.
 *
 * Driven by the `android-overview-demo` workflow's `first-tap` sequence. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class FirstTapDemo : DemoHarness("firsttap-demo-state.json", "firsttap", "firsttap-demo") {
    override val tag = "FirstTapDemo"

    private lateinit var tabsButton: Rect
    private lateinit var cardA: Rect
    private lateinit var cardB: Rect
    /** Which of the two first-row cards is the active tab (the one the page morphs from). */
    private var activeIsA = true
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) error("first tap lost in: ${failures.joinToString()}")
    }

    /**
     * The seeded space is [a (active), b, c, d], all loose. Visit every tab once so the cards have
     * thumbnails (the grid at its heaviest), then learn where the first-row cards and the tabs
     * button are from a fully settled overview.
     */
    override fun warmUp() {
        repeat(3) { flingLeft(); settle() }
        touchWithoutGesture(); settle()
        repeat(3) { flingRight(); settle() }
        touchWithoutGesture(); settle()
        tabsButton = findByLabel("Tabs (4)") ?: error("no tabs button")
        Finger().tap(tabsButton.exactCenterX(), tabsButton.exactCenterY())
        SystemClock.sleep(6_000)
        cardA = findAny("Example Domain", "example.com") ?: error("card A is not on screen")
        cardB = findAny("Tea - Wikipedia") ?: error("card B is not on screen")
        Log.i(tag, "cards a=$cardA b=$cardB tabs=$tabsButton")
        closeOverviewIfOpen()
        SystemClock.sleep(3_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The literal sequences: open, tap the moment the grid shows.
        trial("button, tap as the grid appears") { openByButton(); waitFor("Spaces", 8_000); 0 }
        trial("pill swipe, tap as the grid appears") { openByPill(); waitFor("Spaces", 8_000); 0 }
        // 2. The grid on screen and still settling: pull it a third of the way towards closed with
        //    the pill, stop, let go – it springs back open – and tap right away.
        trial("re-settle after a stopped release, tap at 150 ms") { openByButton(); waitForOverview(); pullAndStop(); 150 }
        trial("re-settle after a stopped release, tap at 400 ms") { openByButton(); waitForOverview(); pullAndStop(); 400 }
        // 3. Right after a fast release: a flick up on the pill with the grid open, then a tap.
        trial("flick on the pill, tap at 150 ms") { openByButton(); waitForOverview(); flickPill(); 150 }
        trial("flick on the pill, tap at 300 ms") { openByButton(); waitForOverview(); flickPill(); 300 }
        // 4. And the plain case for reference.
        trial("settled overview, tap") { openByButton(); waitForOverview(); 0 }
    }

    /**
     * One trial: `setup` gets the overview into its state and answers how long to wait before the
     * tap; then the first-row card that is not the active tab is tapped and the overview must be
     * gone. A lost first tap is followed by a second one, for the record.
     */
    private fun trial(name: String, setup: () -> Long) {
        val target = if (activeIsA) cardB else cardA
        val delay = setup()
        if (delay > 0) SystemClock.sleep(delay)
        val t0 = SystemClock.uptimeMillis()
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        val firstWorked = waitGone("Spaces", 4_000)
        var secondWorked = false
        if (!firstWorked) {
            Finger().tap(target.exactCenterX(), target.exactCenterY())
            secondWorked = waitGone("Spaces", 4_000)
        }
        Log.i(
            tag,
            "trial \"$name\" delay=${delay}ms firstTapWorked=$firstWorked secondTapWorked=$secondWorked " +
                "(${SystemClock.uptimeMillis() - t0}ms)"
        )
        if (!firstWorked) failures.add(name)
        if (firstWorked || secondWorked) activeIsA = !activeIsA
        closeOverviewIfOpen()
        SystemClock.sleep(2_500)
    }

    private fun openByButton() {
        Finger().tap(tabsButton.exactCenterX(), tabsButton.exactCenterY())
    }

    /** Pull the overview in from the pill and let go fast. */
    private fun openByPill() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -NUDGE)
        f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
        f.up()
    }

    /** The overview on screen and at rest (the emulator needs a while for both). */
    private fun waitForOverview() {
        waitFor("Spaces", 8_000) ?: error("the overview never showed")
        SystemClock.sleep(3_000)
    }

    /** With the overview open: drag the pill a third of the travel towards closed, stop, let go. */
    private fun pullAndStop() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.moveBy(0f, NUDGE, 60)
        f.moveBy(0f, 0.3f * overviewTravel, 350)
        f.hold(400)
        f.up()
    }

    /** With the overview open: a quick flick up on the pill (past the open end; it springs back). */
    private fun flickPill() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.moveBy(0f, -NUDGE, 40)
        f.moveBy(0f, -0.4f * overviewTravel, 120)
        f.up()
    }

    /** Poll until `label` has left the accessibility tree; false when it is still there after `timeoutMs`. */
    private fun waitGone(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) == null) return true
            SystemClock.sleep(150)
        }
        return false
    }

    private fun closeOverviewIfOpen() {
        if (findByLabel("Spaces") == null) return
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(2_500)
    }
}
