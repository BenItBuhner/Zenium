package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the tab overview grid's card gestures: a card swiped part of the way and let go (it
 * follows the finger with a tilt and springs back), a card swiped off the grid (the tab closes,
 * the neighbours glide into the gap), a card closed with its X (it collapses out where it
 * stood), a card held and dragged to a new slot (the gap opens live and the order persists), a
 * card dropped on another (the two become a group), and the group closed from its sheet.
 *
 * Driven by the `android-overview-demo` workflow (`demo: swipe-reorder`). See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class SwipeReorderDemo : DemoHarness("overview-demo-state.json", "overview-swipe", "swipe-demo") {
    override val tag = "SwipeReorderDemo"

    @Test
    fun record() {
        runDemo()
    }

    /**
     * The seeded Work space, in track order: [www, damping | Research] [example (active), hn,
     * rfc, tea, coffee]. Visit Hacker News and come back so the two front cards have thumbnails;
     * the others keep their seeded titles, which the labels below rely on.
     */
    override fun warmUp() {
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()
        val n = NUDGE

        // 1. Pull the overview in from the pill, then fold the Research group away so every
        //    loose card is on screen.
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -n)
        f.moveBy(0f, -0.75f * overviewTravel + n, 400)
        f.up()
        SystemClock.sleep(3_000)
        tap("Group Research")
        SystemClock.sleep(2_500)

        // 2. Swipe Coffee a third of the way and hold: it follows the finger, tilted and a little
        //    faded. Let go: it springs back into its slot.
        var coffee = show("Coffee - Wikipedia")
        f.down(coffee.exactCenterX(), coffee.exactCenterY())
        f.moveBy(0.32f * coffee.width(), 0f, 320)
        f.hold(900)
        shot("01-swipe-hold")
        f.moveBy(-0.08f * coffee.width(), 0f, 160)
        f.up()
        SystemClock.sleep(2_000)

        // 3. Swipe it off for real: the card flies out and the tab closes.
        coffee = show("Coffee - Wikipedia")
        f.down(coffee.exactCenterX(), coffee.exactCenterY())
        f.moveBy(1.1f * coffee.width(), 0f, 220)
        f.up()
        SystemClock.sleep(3_000)
        shot("02-after-swipe")

        // 4. Close Tea with its X: the card collapses out where it stood, the rest glide up.
        val tea = show("Tea - Wikipedia")
        f.tap(tea.right - 20 * density, tea.top + 20 * density)
        SystemClock.sleep(3_000)

        // 5. Hold the RFC card and carry it to the left edge of Example, the first loose card: the
        //    gap opens there while the finger rests; drop, and the order is kept.
        val example = show("Example Domain", "example.com")
        val rfc = find(RFC_TITLE)
        f.press(rfc.exactCenterX(), rfc.exactCenterY())
        f.moveBy(0f, -n, 120)
        f.moveBy(example.left + 0.12f * example.width() - rfc.exactCenterX(), example.exactCenterY() + n - rfc.exactCenterY(), 900)
        f.hold(1_400)
        shot("03-reorder-gap")
        f.up()
        SystemClock.sleep(3_500)

        // 6. Hold Hacker News and drop it on the middle of Example: the merge preview, then a
        //    group of the two.
        val exampleAgain = show("Example Domain", "example.com")
        val hn = find("Hacker News", "news.ycombinator.com")
        f.press(hn.exactCenterX(), hn.exactCenterY())
        f.moveBy(0f, -n, 120)
        f.moveBy(exampleAgain.exactCenterX() - hn.exactCenterX(), exampleAgain.exactCenterY() + n - hn.exactCenterY(), 800)
        f.hold(1_200)
        shot("04-merge-target")
        f.up()
        SystemClock.sleep(3_500)
        shot("05-after-merge")

        // 7. Hold the new group's header for its sheet and close the group: the whole card
        //    collapses out.
        val header = show("Group Group")
        f.press(header.exactCenterX(), header.exactCenterY())
        f.hold(300)
        f.up()
        SystemClock.sleep(2_000)
        // The group sheet's injected touch (the rule in DemoHarness): its row under a finger, and
        // the group's card must leave the grid on it.
        tap("Close group (2 tabs)")
        if (waitForGone("Group Group", 8_000)) Log.i(tag, "the group closed under the finger")
        else touchFault("the touch on the group sheet's Close group left the group's card in the grid")
        SystemClock.sleep(1_500)
        shot("06-end")
    }

    /** The bounds of the first of these labels on screen; the demo cannot go on without it. */
    private fun find(vararg labels: String): Rect =
        findAny(*labels) ?: error("none of ${labels.joinToString()} is on screen")

    /** Like [find], after scrolling the element fully into the grid's viewport. */
    private fun show(vararg labels: String): Rect =
        reveal(*labels) ?: error("none of ${labels.joinToString()} exists")

    /** Tap the element with this label once it exists, scrolled into view if it is in the grid. */
    private fun tap(label: String) {
        waitFor(label) ?: error("no $label to tap")
        val target = show(label)
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private companion object {
        const val RFC_TITLE = "RFC 2324: Hyper Text Coffee Pot Control Protocol (HTCPCP/1.0)"
    }
}
