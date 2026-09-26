package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabEngagementTest {
    private val signals = ArrayList<String>()
    private val tracker = CustomTabEngagement(object : CustomTabEngagement.Listener {
        override fun onVerticalScroll(isDirectionUp: Boolean) {
            signals += if (isDirectionUp) "up" else "down"
        }

        override fun onGreatestScrollPercentageIncreased(percentage: Int) {
            signals += "$percentage%"
        }
    })

    @Test
    fun thePercentageIsTheOffsetOverTheRangeRoundedDownToFives() {
        assertEquals(0, CustomTabEngagement.percentageStep(0, 1000))
        assertEquals(0, CustomTabEngagement.percentageStep(49, 1000))
        assertEquals(5, CustomTabEngagement.percentageStep(50, 1000))
        assertEquals(5, CustomTabEngagement.percentageStep(99, 1000))
        assertEquals(10, CustomTabEngagement.percentageStep(100, 1000))
        assertEquals(95, CustomTabEngagement.percentageStep(999, 1000))
        assertEquals(100, CustomTabEngagement.percentageStep(1000, 1000))
        // Past the end (an overscroll's report) and before the start clamp; a page that fits has no percentage.
        assertEquals(100, CustomTabEngagement.percentageStep(1200, 1000))
        assertEquals(0, CustomTabEngagement.percentageStep(-5, 1000))
        assertEquals(0, CustomTabEngagement.percentageStep(300, 0))
        // No overflow on a long page's large offsets.
        assertEquals(100, CustomTabEngagement.percentageStep(Int.MAX_VALUE, Int.MAX_VALUE))
        assertEquals(45, CustomTabEngagement.percentageStep(Int.MAX_VALUE / 2, Int.MAX_VALUE))
    }

    @Test
    fun aScrollReportsItsDirectionOnceAndAgainWhenItTurns() {
        tracker.touchDown()
        tracker.scrolled(20, 1000, 10)
        tracker.scrolled(40, 1000, 20)
        tracker.scrolled(60, 1000, 30)
        // Toward the bottom: the offset grows, `isDirectionUp` is false, said once.
        assertEquals(listOf("down", "5%"), signals)
        tracker.scrolled(30, 1000, 40)
        tracker.scrolled(10, 1000, 50)
        assertEquals(listOf("down", "5%", "up"), signals)
        tracker.scrolled(45, 1000, 60)
        assertEquals(listOf("down", "5%", "up", "down"), signals)
    }

    @Test
    fun aNewGestureReportsItsDirectionAgainEvenWhenItIsTheSame() {
        tracker.touchDown()
        tracker.scrolled(100, 1000, 10)
        tracker.touchUp(20)
        tracker.touchDown()
        tracker.scrolled(200, 1000, 500)
        assertEquals(listOf("down", "10%", "down", "20%"), signals)
    }

    @Test
    fun theGreatestPercentageOnlyGrowsAndStepsByFive() {
        tracker.touchDown()
        tracker.scrolled(30, 1000, 10)
        assertEquals(listOf("down"), signals)
        tracker.scrolled(50, 1000, 20)
        tracker.scrolled(70, 1000, 30)
        assertEquals(listOf("down", "5%"), signals)
        tracker.scrolled(500, 1000, 40)
        assertEquals(listOf("down", "5%", "50%"), signals)
        // Back up: no percentage; down again short of the farthest point: none either.
        tracker.scrolled(100, 1000, 50)
        tracker.scrolled(400, 1000, 60)
        assertEquals(listOf("down", "5%", "50%", "up", "down"), signals)
        tracker.scrolled(1000, 1000, 70)
        assertEquals(listOf("down", "5%", "50%", "up", "down", "100%"), signals)
        assertEquals(100, tracker.greatestPercentage)
    }

    @Test
    fun aFlingAfterTheFingerLiftsIsStillTheUsersScroll() {
        tracker.touchDown()
        tracker.scrolled(100, 1000, 10)
        tracker.touchUp(20)
        // Offset changes that keep coming within the gap are the fling.
        tracker.scrolled(200, 1000, 20 + CustomTabEngagement.FLING_GAP_MS)
        tracker.scrolled(300, 1000, 20 + 2 * CustomTabEngagement.FLING_GAP_MS)
        assertEquals(listOf("down", "10%", "20%", "30%"), signals)
        // One that comes later is the page's own: not a signal, and the gesture is over.
        tracker.scrolled(600, 1000, 20 + 3 * CustomTabEngagement.FLING_GAP_MS + 1)
        tracker.scrolled(900, 1000, 20 + 3 * CustomTabEngagement.FLING_GAP_MS + 2)
        assertEquals(listOf("down", "10%", "20%", "30%"), signals)
    }

    @Test
    fun aScrollTheUserDidNotMakeIsNoSignal() {
        // A page's own `scrollTo`, the restore of a position: no finger was down.
        tracker.scrolled(500, 1000, 10)
        tracker.scrolled(600, 1000, 20)
        assertTrue(signals.isEmpty())
        assertEquals(0, tracker.greatestPercentage)
        assertFalse(tracker.didUserInteract)
        // The user's scroll after it counts from where the page is.
        tracker.touchDown()
        tracker.scrolled(650, 1000, 30)
        assertEquals(listOf("down", "65%"), signals)
        assertTrue(tracker.didUserInteract)
    }

    @Test
    fun aNavigationResetsTheGreatestPercentageAndClosesTheGesture() {
        tracker.touchDown()
        tracker.scrolled(800, 1000, 10)
        tracker.touchUp(20)
        assertEquals(listOf("down", "80%"), signals)
        tracker.navigated()
        assertEquals(0, tracker.greatestPercentage)
        // The new document's move to its top, within the fling window, is not the user's scroll.
        tracker.scrolled(0, 2000, 30)
        assertEquals(listOf("down", "80%"), signals)
        // The user's first scroll of the new document reports from zero again.
        tracker.touchDown()
        tracker.scrolled(100, 2000, 40)
        assertEquals(listOf("down", "80%", "down", "5%"), signals)
        // A touch that reached the page before is still an interaction of the session's.
        assertTrue(tracker.didUserInteract)
    }

    @Test
    fun anOffsetThatDidNotChangeIsNothing() {
        tracker.touchDown()
        tracker.scrolled(0, 1000, 10)
        tracker.scrolled(0, 1000, 20)
        assertTrue(signals.isEmpty())
    }
}
