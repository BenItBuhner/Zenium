package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Device px at density 1.75: an 8 dp slop, 1 dp passed through with it, a 48 CSS px bar. */
class BarHideShareTest {
    private val slop = 14f
    private val pass = 1.75f
    private val travel = 84
    private val x = 360f
    private val downY = 700f
    private val local = 650f

    /** Where the finger of the share under test is on the screen. */
    private var lastFinger = downY

    /**
     * A share with a finger down and – unless `rootScrolled` is false – the page's own scroller
     * already confirmed under it, as it is a frame after the slop crossing on the page itself.
     */
    private fun share(offset: Float = 0f, taking: Boolean = true, rootScrolled: Boolean = true) = BarHideShare(slop, pass).also {
        it.mirror = offset
        it.down(x, downY, local, taking)
        if (rootScrolled) it.rootScrolled()
        lastFinger = downY
    }

    /** Moves the finger from where it is to `y` in 1 px steps (one event each); the sum of what the bar took. */
    private fun BarHideShare.moveTo(y: Float, pageBelow: Boolean = true): Float {
        var taken = 0f
        while (lastFinger != y) {
            lastFinger += if (y > lastFinger) 1f else -1f
            taken += move(x, lastFinger, travel, pageBelow)
        }
        return taken
    }

    /** One event carrying the finger straight to `y` (a stretch of the drag batched behind a slow frame). */
    private fun BarHideShare.jumpTo(y: Float, fingerX: Float = x, travelPx: Int = travel): Float {
        lastFinger = y
        return move(fingerX, y, travelPx, pageBelow = true)
    }

    private fun near(expected: Float, actual: Float) = assertEquals(expected, actual, 0.01f)

    @Test
    fun aDragDownThePageSlidesTheBarOffBeforeThePageScrolls() {
        val s = share()
        // Inside the slop the WebView sees the finger as it is and the bar takes nothing.
        near(0f, s.moveTo(downY - 14f))
        near(local - 14f, s.seenY(downY - 14f))
        // The crossing goes through as a crossing, and from there the bar takes every px: the
        // WebView sees a finger that holds still just past the slop.
        near(0f, s.jumpTo(downY - 15f))
        near(local - 15f, s.seenY(downY - 15f))
        near(84f, s.moveTo(downY - 15f - 84f))
        near(84f, s.mirror)
        near(local - 15f, s.seenY(downY - 99f))
        // The bar is off: the rest of the drag is the page's, from where the finger stood still.
        near(0f, s.moveTo(downY - 120f))
        near(local - 120f + 84f, s.seenY(downY - 120f))
    }

    @Test
    fun aCrossingDeliveredLateGivesTheBarWhatLiesPastTheSlop() {
        // The bar hidden, a 40 dp (70 px) drag back up the page, its first 48 px batched into
        // one event behind a slow frame (the emulator's retry): what lies past the slop crossing
        // is the bar's, so the drag brings it back by 70 less the crossing, not by the 22 px
        // that followed the batch.
        val s = share(offset = 84f)
        near(-(48f - slop - pass), s.jumpTo(downY + 48f))
        near(local + slop + pass, s.seenY(downY + 48f))
        near(-22f, s.moveTo(downY + 70f))
        near(84f - 70f + slop + pass, s.mirror)
        near(local + slop + pass, s.seenY(downY + 70f))
        assertTrue("the bar came back past a third of its travel", s.mirror / travel < 0.6f)
    }

    @Test
    fun upThePageBringsTheBarBackFirstThenScrollsThePage() {
        val s = share(offset = 84f)
        near(0f, s.moveTo(downY + 15f))
        near(-84f, s.moveTo(downY + 15f + 84f))
        near(0f, s.mirror)
        near(local + 15f, s.seenY(downY + 99f))
        near(0f, s.moveTo(downY + 130f))
        near(local + 130f - 84f, s.seenY(downY + 130f))
    }

    @Test
    fun aSidewaysStartLeavesTheDragToThePage() {
        val s = share()
        near(0f, s.jumpTo(downY - 5f, fingerX = x + 20f))
        near(0f, s.moveTo(downY - 60f))
        near(0f, s.consumed)
        near(local - 60f, s.seenY(downY - 60f))
    }

    @Test
    fun aPageAtItsBottomKeepsItsBar() {
        val s = share()
        near(0f, s.moveTo(downY - 60f, pageBelow = false))
        near(0f, s.mirror)
        near(local - 60f, s.seenY(downY - 60f))
    }

    @Test
    fun aFingerLandingNearThePagesEndStartsNoHideButStillBringsABarBack() {
        // Less than the bar's travel left below (the gesture answers `pageBelow` false while
        // the bar is at its edge): the drag is the page's to its end, nothing grows.
        val s = share()
        near(0f, s.moveTo(downY - 120f, pageBelow = false))
        near(0f, s.consumed)
        near(local - 120f, s.seenY(downY - 120f))
        // A hidden bar in the same place comes back under the finger all the same: only a
        // start is refused there.
        val hidden = share(offset = 84f)
        near(0f, hidden.moveTo(downY + 15f, pageBelow = false))
        near(-84f, hidden.moveTo(downY + 99f, pageBelow = false))
        near(0f, hidden.mirror)
        near(local + 15f, hidden.seenY(downY + 99f))
    }

    @Test
    fun aDragThatScrollsNoRootTakesNothing() {
        // A finger on an inner scroller (a list, a map, a text-selection handle): the page's
        // own scroller never moves, so the bar takes nothing and the WebView sees the finger
        // as it is, all the way through.
        val s = share(rootScrolled = false)
        near(0f, s.moveTo(downY - 200f))
        near(0f, s.consumed)
        near(0f, s.mirror)
        near(local - 200f, s.seenY(downY - 200f))
        assertFalse(s.rootScrolled)
        // Nor does a hidden bar come back for an inner scroller dragged the other way.
        val hidden = share(offset = 84f, rootScrolled = false)
        near(0f, hidden.moveTo(downY + 200f))
        near(84f, hidden.mirror)
        near(local + 200f, hidden.seenY(downY + 200f))
    }

    @Test
    fun theBarTakesFromTheMoveAfterThePageHasScrolled() {
        // The crossing and the frame after it go through whole – the page scrolls by that frame,
        // confirming the drag is its own – and from the next move the bar takes.
        val s = share(rootScrolled = false)
        near(0f, s.moveTo(downY - 20f))
        near(local - 20f, s.seenY(downY - 20f))
        s.rootScrolled()
        near(30f, s.moveTo(downY - 50f))
        near(30f, s.mirror)
        // The WebView's finger holds where it was when the page had scrolled.
        near(local - 20f, s.seenY(downY - 50f))
        near(54f, s.moveTo(downY - 104f))
        near(84f, s.mirror)
        near(0f, s.moveTo(downY - 130f))
        near(local - 130f + 84f, s.seenY(downY - 130f))
        // An inner scroller that ran out and chained to the page confirms it late in the drag:
        // the bar takes from there, as Chrome's controls do once the chain reaches the viewport.
        val chained = share(rootScrolled = false)
        near(0f, chained.moveTo(downY - 300f))
        chained.rootScrolled()
        near(84f, chained.moveTo(downY - 400f))
        near(local - 400f + 84f, chained.seenY(downY - 400f))
    }

    @Test
    fun aCrossingAfterThePageScrolledStillHandsTheBarWhatLiesPastTheSlop() {
        // The page's scroller moved before the finger's crossing was delivered (a script scroll
        // under a finger, or the crossing batched behind the frame that carried the confirmation):
        // the crossing goes through and the bar takes what lies past it, as before.
        val s = share(rootScrolled = false)
        s.rootScrolled()
        near(48f - slop - pass, s.jumpTo(downY - 48f))
        near(local - slop - pass, s.seenY(downY - 48f))
    }

    @Test
    fun aSecondFingerEndsTheBarsTake() {
        val s = share()
        near(20f, s.moveTo(downY - 35f))
        s.pointerDown()
        near(0f, s.moveTo(downY - 80f))
        near(20f, s.mirror)
        // What was taken stays taken: the WebView's finger keeps its shift.
        near(local - 80f + 20f, s.seenY(downY - 80f))
    }

    @Test
    fun withNoTopDockedBarTheFingerIsThePagesOwn() {
        val s = share(taking = false)
        assertFalse(s.taking)
        near(0f, s.moveTo(downY - 60f))
        near(local - 60f, s.seenY(downY - 60f))
        // A bar that may not hide right now (no frame, or one at the bottom) has no travel to take.
        val bottom = share()
        near(0f, bottom.jumpTo(downY - 40f, travelPx = 0))
        near(0f, bottom.consumed)
    }
}
