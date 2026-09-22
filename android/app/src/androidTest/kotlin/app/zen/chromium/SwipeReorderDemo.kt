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
        tap(RESEARCH)
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
        //    group of the two. The finger crosses to Example's middle in ONE move from a pause
        //    over its own stand-in, where nothing is pending (as OverviewMotionDemo.carry does,
        //    since #147's drop-target machine): under the emulator's batched input a slow
        //    approach crosses Example's edge band – a slot – and a stall there lets the slot's
        //    dwell run out with the next moves undelivered, so the gap opens, Example glides
        //    off, and the moves then delivered find the stand-in's own slot where Example was: a
        //    reorder and no group (the audit's first run: three loose cards after the drop).
        val exampleAgain = show("Example Domain", "example.com")
        val hn = find("Hacker News", "news.ycombinator.com")
        f.press(hn.exactCenterX(), hn.exactCenterY())
        f.moveBy(0f, -n, 120)
        f.hold(EDGE_PAUSE)
        f.moveBy(exampleAgain.exactCenterX() - hn.exactCenterX(), exampleAgain.exactCenterY() + n - hn.exactCenterY(), 0)
        f.hold(1_200)
        shot("04-merge-target")
        f.up()
        SystemClock.sleep(3_500)
        shot("05-after-merge")

        // 7. Hold the new group's header for its sheet and close the group: the whole card
        //    collapses out.
        val header = show(NEW_GROUP)
        f.press(header.exactCenterX(), header.exactCenterY())
        f.hold(300)
        f.up()
        SystemClock.sleep(2_000)
        // The group sheet's injected touch (the rule in DemoHarness): its row under a finger, and
        // the group's card must leave the grid on it. The grid is inert under the sheet and so
        // out of the tree: the sheet leaves first (a fall through to the scrim closes it too),
        // then the grid is back with its other cards, and only then does the card's absence
        // mean the group closed.
        if (!touchTapLabel("Close Group (2 Tabs)")) error("no Close Group row in the group sheet")
        waitForGone("Close Group (2 Tabs)", 8_000)
        if (!gridBack(6_000)) {
            touchFault("the grid did not come back into the tree after the group sheet")
        } else if (waitForGone(NEW_GROUP, 6_000)) {
            Log.i(tag, "the group closed under the finger")
        } else {
            touchFault("the touch on the group sheet's Close group left the group's card in the grid")
        }
        SystemClock.sleep(1_500)
        shot("06-end")
    }

    /** The bounds of the first of these labels on screen; the demo cannot go on without it. */
    private fun find(vararg labels: String): Rect =
        findAny(*labels) ?: error("none of ${labels.joinToString()} is on screen")

    /** Like [find], after scrolling the element fully into the grid's viewport. */
    private fun show(vararg labels: String): Rect =
        reveal(*labels) ?: error("none of ${labels.joinToString()} exists")

    /** [show] for a group's card ([groupCard]: its name carries the group's count, so it is matched, not read). */
    private fun show(card: GroupCard): Rect = reveal(card) ?: error("no $card exists")

    /** Whether the grid's other cards (the folded Research group, the RFC card) are back in the tree within `timeoutMs`. */
    private fun gridBack(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(RESEARCH) != null || findByLabel(RFC_TITLE) != null) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** Tap the group's card once it exists, scrolled into view: its header, which folds and unfolds the group. */
    private fun tap(card: GroupCard) {
        waitFor(card) ?: error("no $card to tap")
        val target = show(card)
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private companion object {
        const val RFC_TITLE = "RFC 2324: Hyper Text Coffee Pot Control Protocol (HTCPCP/1.0)"
        /** The seeded Research group's card, and the card of the group step 6 makes (named "Group", the chrome's default). */
        val RESEARCH = groupCard("Research")
        val NEW_GROUP = groupCard("Group")
        /** The lifted finger's pause where nothing is pending before its one move onto the merge target (step 6). */
        const val EDGE_PAUSE = 400L
    }
}
