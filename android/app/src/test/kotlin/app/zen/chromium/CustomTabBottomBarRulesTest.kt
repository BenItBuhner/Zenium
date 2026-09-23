package app.zen.chromium

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
}
