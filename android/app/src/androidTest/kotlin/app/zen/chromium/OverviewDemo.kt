package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the tab overview's presentation and its tab groups: the page morphing into its card
 * at a slow drag, the Spaces drawer, a group made by holding a card and one made by dropping a
 * card on another (with the merge preview), collapsing a group, moving a tab between groups,
 * and the group ribbon while swiping between grouped tabs on the pill.
 *
 * Driven by the `android-overview-demo` workflow. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class OverviewDemo : DemoHarness("overview-demo-state.json", "overview", "overview-demo") {
    override val tag = "OverviewDemo"

    @Test
    fun record() {
        runDemo()
    }

    /**
     * The seeded Work space, in track order: [www, damping | Research] [example (active), hn,
     * rfc, tea, coffee]. Visit the first five so their cards have thumbnails (a card gets its
     * thumbnail when a finger next touches the pill while that tab is on screen).
     */
    override fun warmUp() {
        flingLeft(); settle()
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        repeat(4) { flingRight(); settle() }
        touchWithoutGesture(); settle()
        repeat(2) { flingLeft(); settle() }
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()
        val n = NUDGE

        // 1. Pull the overview in slowly: the page becomes its card, radius, outline and shadow
        //    morphing continuously, then commit.
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -n)
        f.moveBy(0f, -0.20f * overviewTravel, 1_200)
        f.hold(500)
        f.moveBy(0f, -0.18f * overviewTravel, 900)
        f.hold(800)
        shot("01-morph-mid")
        f.moveBy(0f, -0.40f * overviewTravel, 900)
        f.hold(300)
        f.up()
        SystemClock.sleep(2_500)

        // 2. The Spaces drawer, then a swipe pushes it back out. (Springs advance at most 64 ms
        //    per frame, so on the emulator's handful of frames per second they take a while.)
        tap("Spaces")
        SystemClock.sleep(3_000)
        shot("02-spaces-drawer")
        f.down(width * 0.45f, height * 0.5f)
        f.moveBy(-n, 0f, 60)
        f.moveBy(-0.4f * width, 0f, 350)
        f.up()
        SystemClock.sleep(2_500)

        // 3. Collapse the Research group (it also keeps the loose cards in reach below).
        tap(groupCard("Research"))
        SystemClock.sleep(2_000)

        // 4. Hold a card and let go: its actions. Make a group and name it. Tabs that were never
        //    visited keep their seeded titles, which is what the labels below rely on.
        val hn = find(HN)
        f.press(hn.exactCenterX(), hn.exactCenterY())
        f.hold(600)
        shot("03-card-held")
        f.up()
        SystemClock.sleep(1_500)
        tap("New group")
        SystemClock.sleep(2_000)
        instrumentation.sendStringSync("News")
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        SystemClock.sleep(2_000)

        // 5. Drag a card onto another: the merge preview, then a group of the two. The loose
        //    cards sit below the fold now: bring the target (the lower row) into view first, the
        //    source is the row above it.
        val tea = show(TEA)
        val example = show(EXAMPLE)
        f.press(example.exactCenterX(), example.exactCenterY())
        f.moveBy(0f, -n, 120)
        f.moveBy(tea.exactCenterX() - example.exactCenterX(), tea.exactCenterY() - example.exactCenterY() + n, 1_000)
        f.hold(1_200)
        shot("04-merge-preview")
        f.up()
        SystemClock.sleep(3_000)

        // 6. Move a tab between groups: Tea out of the new group onto the News group above it.
        val news = show(groupCard("News"))
        val teaAgain = show(TEA)
        f.press(teaAgain.exactCenterX(), teaAgain.exactCenterY())
        f.moveBy(0f, -n, 120)
        f.moveBy(news.exactCenterX() - teaAgain.exactCenterX(), news.exactCenterY() - teaAgain.exactCenterY() + n, 1_000)
        f.hold(800)
        f.up()
        SystemClock.sleep(3_000)

        // 7. Expand Research again: three groups on screen.
        tap(groupCard("Research"))
        SystemClock.sleep(2_500)
        shot("05-groups")

        // 8. Pick a grouped tab: the card grows back into the page.
        val pick = find(HN)
        f.tap(pick.exactCenterX(), pick.exactCenterY())
        SystemClock.sleep(3_500)

        // 9. Swipe slowly to the next tab of the same group: the ribbon rides along the top.
        f.down(pill.right - 10f, pillY)
        f.settleIn(-n, 0f)
        f.moveBy(-0.30f * width + n, 0f, 800)
        f.hold(900)
        shot("06-swipe-ribbon")
        f.moveBy(-0.30f * width, 0f, 500)
        f.hold(250)
        f.up()
        SystemClock.sleep(3_000)
    }

    /**
     * The bounds of a card on screen ([tabCard], [groupCard]: the chrome's names for the cards
     * carry their place, count and state, so a card is matched on its title or name, not read
     * whole); the demo cannot go on without it.
     */
    private fun find(card: Card): Rect = findByLabel(card) ?: error("no $card is on screen")

    /** Like [find], after scrolling the card fully into the grid's viewport. */
    private fun show(card: Card): Rect = reveal(card) ?: error("no $card exists")

    /** Tap the element with this label once it exists, scrolled into view if it is in the grid. */
    private fun tap(label: String) {
        waitFor(label) ?: error("no $label to tap")
        val target = reveal(label) ?: error("no $label exists")
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    /** [tap] for a group's card: its header, which folds and unfolds the group. */
    private fun tap(card: Card) {
        waitFor(card) ?: error("no $card to tap")
        val target = show(card)
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private companion object {
        /** The seeded cards the sequence handles, by the titles they carry before and after their pages load. */
        val HN = tabCard("Hacker News", "news.ycombinator.com")
        val TEA = tabCard("Tea - Wikipedia")
        val EXAMPLE = tabCard("Example Domain", "example.com")
    }
}
