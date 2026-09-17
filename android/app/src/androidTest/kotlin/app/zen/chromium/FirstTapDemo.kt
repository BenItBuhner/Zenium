package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The first tap on a freshly opened tab overview. Opens the overview – by the tabs button and by
 * the pill swipe – and taps a card a fixed time after the open began, with OS-level touch input
 * (UiAutomation injects real `MotionEvent`s through the same `InputManager` path `adb shell
 * input tap` uses, so the WebView sees a finger: gesture recognition, hover emulation and all).
 * Each trial reports whether that first tap picked the card (the overview closed) and, if not,
 * whether a second tap did. The recording shows the same.
 *
 * Driven by the `android-overview-demo` workflow's `first-tap` sequence. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class FirstTapDemo : DemoHarness("firsttap-demo-state.json", "firsttap", "firsttap-demo") {
    override val tag = "FirstTapDemo"

    private lateinit var tabsButton: Rect
    private lateinit var cardA: Rect
    private lateinit var cardB: Rect
    /** Which of the two first-row cards is the active tab (its card is the one the page morphs from). */
    private var activeIsA = true

    @Test
    fun record() {
        runDemo()
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
        // Opened by the tabs button: taps at increasing delays from the button tap.
        for (delay in longArrayOf(700, 1_200, 2_000, 3_500)) trial("button", delay)
        // Opened by the pill swipe: delays from the release.
        for (delay in longArrayOf(700, 1_500, 3_000)) trial("pill", delay)
    }

    /**
     * One trial: open, wait `delayMs` from the moment the open began, tap the first-row card that
     * is not the active tab, and see whether the overview closed. A first tap that did nothing is
     * followed by a second one, to show whether that is what makes it work.
     */
    private fun trial(how: String, delayMs: Long) {
        val target = if (activeIsA) cardB else cardA
        val t0 = when (how) {
            "pill" -> swipeOverviewOpen()
            else -> {
                Finger().tap(tabsButton.exactCenterX(), tabsButton.exactCenterY())
                SystemClock.uptimeMillis()
            }
        }
        // When the accessibility tree first shows the overview's header: a bound on its appearance.
        val seenAt = waitFor("Spaces", delayMs)?.let { SystemClock.uptimeMillis() - t0 }
        val remaining = t0 + delayMs - SystemClock.uptimeMillis()
        if (remaining > 0) SystemClock.sleep(remaining)
        val tapAt = SystemClock.uptimeMillis() - t0
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        SystemClock.sleep(2_000)
        val firstWorked = findByLabel("Spaces") == null
        var secondWorked = false
        if (!firstWorked) {
            Finger().tap(target.exactCenterX(), target.exactCenterY())
            SystemClock.sleep(2_000)
            secondWorked = findByLabel("Spaces") == null
        }
        Log.i(
            tag,
            "trial how=$how delay=$delayMs tapAt=${tapAt}ms headerSeenAt=${seenAt ?: "never"}ms " +
                "firstTapWorked=$firstWorked secondTapWorked=$secondWorked"
        )
        if (firstWorked || secondWorked) activeIsA = !activeIsA
        closeOverviewIfOpen()
        SystemClock.sleep(2_500)
    }

    /** Pull the overview in from the pill and let go; returns the moment of the release. */
    private fun swipeOverviewOpen(): Long {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -NUDGE)
        f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 500)
        f.up()
        return SystemClock.uptimeMillis()
    }

    private fun closeOverviewIfOpen() {
        if (findByLabel("Spaces") == null) return
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(2_500)
    }
}
