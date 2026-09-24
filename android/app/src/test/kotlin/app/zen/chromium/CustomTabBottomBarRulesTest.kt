package app.zen.chromium

import android.view.MotionEvent
import app.zen.chromium.CustomTabBottomBarRules.InterceptStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabBottomBarRulesTest {
    @Test
    fun theBarTakesItsHeightFromThePageOnlyWhileShown() {
        assertEquals(48 + 98, CustomTabBottomBarRules.pageBottomMargin(48, 98, true))
        assertEquals(48, CustomTabBottomBarRules.pageBottomMargin(48, 98, false))
        assertEquals(98 + 48, CustomTabBottomBarRules.hiddenTranslation(98, 48))
    }

    @Test
    fun theDragFollowsTheFingerThenRubberBands() {
        val bar = 98f
        assertEquals(0f, CustomTabBottomBarRules.dragOffset(-20f, bar), 0f)
        assertEquals(0f, CustomTabBottomBarRules.dragOffset(0f, bar), 0f)
        // Near one-to-one for a small travel.
        val small = CustomTabBottomBarRules.dragOffset(4f, bar)
        assertTrue(small > 3.9f && small <= 4f)
        // Monotonic and capped at half the bar.
        val mid = CustomTabBottomBarRules.dragOffset(40f, bar)
        val far = CustomTabBottomBarRules.dragOffset(400f, bar)
        assertTrue(mid > small && far > mid)
        assertTrue(far <= bar * CustomTabBottomBarRules.DRAG_CAP)
        assertTrue(far > bar * CustomTabBottomBarRules.DRAG_CAP * 0.99f)
    }

    @Test
    fun aBarCaughtMidSettleIsPickedUpWhereItIs() {
        val bar = 98f
        // The inverse of the band: the travel for an offset gives that offset back.
        for (travel in listOf(4f, 20f, 40f, 90f)) {
            val offset = CustomTabBottomBarRules.dragOffset(travel, bar)
            assertEquals(travel, CustomTabBottomBarRules.travelFor(offset, bar), 0.01f)
        }
        assertEquals(0f, CustomTabBottomBarRules.travelFor(0f, bar), 0f)
        assertEquals(0f, CustomTabBottomBarRules.travelFor(-3f, bar), 0f)
        assertEquals(0f, CustomTabBottomBarRules.travelFor(10f, 0f), 0f)
        // At or past the cap (which the band never reaches) the travel is finite, and well past
        // where the band has flattened (49 * atanh(0.999), about 186 px for this bar).
        val cap = bar * CustomTabBottomBarRules.DRAG_CAP
        val atCap = CustomTabBottomBarRules.travelFor(cap, bar)
        assertTrue(atCap.isFinite() && atCap > cap * 3)
        assertEquals(atCap, CustomTabBottomBarRules.travelFor(cap * 2, bar), 0f)
    }

    @Test
    fun theSwipeFiresAtTheThreshold() {
        assertFalse(CustomTabBottomBarRules.swipeFires(31f, 32f))
        assertTrue(CustomTabBottomBarRules.swipeFires(32f, 32f))
        assertFalse(CustomTabBottomBarRules.swipeFires(100f, 0f))
    }

    @Test
    fun theBarClaimsAMostlyVerticalDragPastTheSlop() {
        assertFalse(CustomTabBottomBarRules.claimsDrag(2f, 6f, 8f))
        assertTrue(CustomTabBottomBarRules.claimsDrag(2f, -12f, 8f))
        assertFalse(CustomTabBottomBarRules.claimsDrag(20f, -12f, 8f))
    }

    @Test
    fun aChildsTapDuringTheSettleSendsTheBarHome() {
        val bar = 98f
        val slop = 8f
        // A swipe released at 40 px of travel: the bar settles from its offset towards 0. Some
        // 0.1 s in, a finger lands on the caller's button with the bar still raised by half of it …
        val caught = CustomTabBottomBarRules.dragOffset(40f, bar) / 2
        assertTrue(caught > 0f)
        // … the down grabs the bar where it is (travelFor picks the offset up as travel) …
        assertEquals(InterceptStep.GRAB, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_DOWN, false, 0f, 0f, slop))
        assertEquals(caught, CustomTabBottomBarRules.dragOffset(CustomTabBottomBarRules.travelFor(caught, bar), bar), 0.01f)
        // … a tap's wobble within the slop leaves the stream with the button …
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_MOVE, false, 1f, -2f, slop))
        // … and the stream's end – the release, or the cancel a parent sends – settles the bar the
        // grab stopped: raised by `caught`, it would otherwise stand there until the next drag or scroll.
        assertEquals(InterceptStep.SETTLE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_UP, false, 1f, -2f, slop))
        assertEquals(InterceptStep.SETTLE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_CANCEL, false, 1f, -2f, slop))
        // A move past the slop, mostly vertical, claims the stream for the drag instead …
        assertEquals(InterceptStep.CLAIM, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_MOVE, false, 2f, -12f, slop))
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_MOVE, false, 20f, -12f, slop))
        // … and a bar that claimed it hears the rest, its end included, in its own onTouchEvent.
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_MOVE, true, 2f, -40f, slop))
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_UP, true, 2f, -40f, slop))
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_CANCEL, true, 2f, -40f, slop))
        assertEquals(InterceptStep.NONE, CustomTabBottomBarRules.interceptStep(MotionEvent.ACTION_POINTER_DOWN, false, 0f, 0f, slop))
    }
}
