package app.zen.chromium

import app.zen.chromium.BarHideScrollFilter.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Device px at density 1.75: a 48 CSS px bar (84 px), a 120 ms fling window, 2 dp of finger tolerance. */
class BarHideScrollFilterTest {
    private val travel = 84
    private val gap = 120L
    private val finger = 900f

    private fun filter() = BarHideScrollFilter(gap, 3.5f)

    /** A page scrolled from `from` to `to` with `remaining` px left below afterwards. */
    private fun BarHideScrollFilter.page(
        from: Int,
        to: Int,
        remaining: Int,
        offset: Float = 0f,
        top: Boolean = false,
        fingerY: Float = finger,
        now: Long = 1_000L
    ) = scrolled(to, from, remaining, offset, travel, top, fingerY, now)

    @Test
    fun aScrollUnderTheFingerIsReportedAndAFlingWithinTheGapToo() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(100, 130, 2_000, fingerY = finger - 30f))
        f.lifted(2_000L)
        assertEquals(Verdict.REPORT, f.page(130, 190, 1_900, offset = 30f, now = 2_100L))
        // Each change of the fling's extends its window; one past the window is the page's own.
        assertEquals(Verdict.REPORT, f.page(190, 230, 1_800, offset = 84f, now = 2_210L))
        assertEquals(Verdict.NONE, f.page(230, 260, 1_700, offset = 84f, now = 2_400L))
        assertFalse(f.touching)
    }

    @Test
    fun noHideStartsWithLessThanTheTravelLeftBelow() {
        // The bar at its edge, a finger landing 60 px from the end: the first scroll down is the
        // finger's (the drag reached the page's own scroller) but moves no bar.
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.HELD, f.page(1_000, 1_020, 40, fingerY = finger - 20f))
        assertFalse(f.hiding)
        // The page reaches its end short: still nothing.
        assertEquals(Verdict.HELD, f.page(1_020, 1_060, 0, fingerY = finger - 60f))
        // With the travel left the hide starts, and the tall layout it brings is counted from then on.
        val g = filter()
        g.down(finger)
        assertEquals(Verdict.REPORT, g.page(900, 920, 84, fingerY = finger - 20f))
        assertTrue(g.hiding)
        // Already under way, the last band is the page's to scroll: the bar keeps following.
        assertEquals(Verdict.REPORT, g.page(920, 960, 44, offset = 20f, fingerY = finger - 60f))
        assertEquals(Verdict.REPORT, g.page(960, 1_004, 0, offset = 60f, fingerY = finger - 104f))
    }

    @Test
    fun aPageShorterThanItsViewportKeepsItsBar() {
        // A page that does not scroll reports no scroll, so nothing arrives here at all; one that
        // scrolls by less than the bar's travel (a short page a few lines over) is held from its
        // first px to its end, whatever the finger does: the bar stays, and all of the page is
        // reachable under it (v2 draft 11.5: the band stays shown on a page shorter than its viewport).
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.HELD, f.page(0, 12, 30, fingerY = finger - 12f))
        assertEquals(Verdict.HELD, f.page(12, 42, 0, fingerY = finger - 42f))
        assertFalse(f.hiding)
        // Back up (the finger's, reported: a bar at its edge has nothing to come back by) and
        // down again within the same finger: still no hide.
        assertEquals(Verdict.REPORT, f.page(42, 10, 32, fingerY = finger - 10f))
        assertEquals(Verdict.HELD, f.page(10, 42, 0, fingerY = finger - 42f))
        assertFalse(f.hiding)
    }

    @Test
    fun aBarAlreadyOffItsEdgeFollowsTheScrollWhateverIsLeft() {
        // A finger landing mid-spring, the bar 30 px off: the page is laid out tall already.
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(1_000, 1_010, 20, offset = 30f, fingerY = finger - 10f))
    }

    @Test
    fun theClampLandingThePageAtItsEndIsNotTheFingers() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(900, 930, 100, fingerY = finger - 30f))
        // The tall layout took a band off the range: Chromium pushes the offset back to the new
        // end. Not a scroll up, and not a root scroll to confirm.
        assertEquals(Verdict.NONE, f.page(930, 916, 0, offset = 30f, fingerY = finger - 30f))
        // The same during the fling.
        f.lifted(2_000L)
        assertEquals(Verdict.NONE, f.page(916, 900, 0, offset = 30f, now = 2_050L))
    }

    @Test
    fun aScrollUpWhileTheFingerGoesDownThePageIsNotTheFingersEither() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(900, 930, 100, fingerY = finger - 30f))
        // The finger went on up the screen; the page came back with room still below: a clamp
        // that left room (the range shrank under a still page), not a drag up.
        assertEquals(Verdict.NONE, f.page(930, 920, 10, offset = 30f, fingerY = finger - 50f))
        // Within the tolerance (a jittering finger, 2 px up from where the page last scrolled)
        // a scroll up is the finger's.
        assertEquals(Verdict.REPORT, f.page(920, 910, 20, offset = 20f, fingerY = finger - 32f))
    }

    @Test
    fun aRealDragBackUpIsReportedAndBringsTheBarBack() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(900, 984, 400, fingerY = finger - 84f))
        assertEquals(Verdict.REPORT, f.page(984, 950, 434, offset = 84f, fingerY = finger - 50f))
        assertEquals(Verdict.REPORT, f.page(950, 900, 484, offset = 50f, fingerY = finger))
    }

    @Test
    fun aFlingReachingTheTopShowsTheBar() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(200, 100, 900, offset = 84f, fingerY = finger + 100f))
        f.lifted(2_000L)
        assertEquals(Verdict.SHOW, f.page(100, 0, 1_000, offset = 20f, now = 2_050L))
        // The window is spent with the show: what scrolls after is the page's own.
        assertEquals(Verdict.NONE, f.page(0, 10, 990, offset = 10f, now = 2_060L))
        // Under a finger the scroll itself brings the bar back: no show, a report.
        val g = filter()
        g.down(finger)
        assertEquals(Verdict.REPORT, g.page(100, 0, 1_000, offset = 84f, fingerY = finger + 100f))
    }

    @Test
    fun aTopDockedBarHearsOnlyItsFlings() {
        val f = filter()
        f.down(finger)
        // The finger's scroll confirms the drag is the page's but moves no top-docked bar itself.
        assertEquals(Verdict.HELD, f.page(100, 130, 2_000, top = true, fingerY = finger - 30f))
        assertEquals(Verdict.HELD, f.page(130, 120, 2_010, offset = 84f, top = true, fingerY = finger - 20f))
        f.lifted(2_000L)
        // A fling down under a hidden bar: nothing; a fling up: the bar comes back.
        assertEquals(Verdict.HELD, f.page(120, 160, 1_970, offset = 84f, top = true, now = 2_050L))
        assertEquals(Verdict.SHOW, f.page(160, 140, 1_990, offset = 84f, top = true, now = 2_100L))
        // A fling up under a shown bar has nothing to show.
        val g = filter()
        g.down(finger)
        g.lifted(2_000L)
        assertEquals(Verdict.HELD, g.page(160, 140, 1_990, offset = 0f, top = true, now = 2_050L))
    }

    @Test
    fun theChromeSayingThePageIsShortAgainGatesTheNextHideAfresh() {
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(900, 920, 200, fingerY = finger - 20f))
        assertTrue(f.hiding)
        // The finger went back up and the bar came home under it: the page is still laid out tall
        // (the chrome's frames say so, at every offset down to 0), so a new hide within the same
        // finger grows nothing and is not gated on the band – 40 px from the end of the tall page
        // there is nothing to clamp.
        assertEquals(Verdict.REPORT, f.page(920, 900, 220, offset = 20f, fingerY = finger))
        f.pageLaidOut(tall = true)
        assertTrue(f.hiding)
        f.pageLaidOut(tall = true)
        assertEquals(Verdict.REPORT, f.page(900, 1_080, 40, fingerY = finger - 180f))
        // The rest: the chrome lays the page out short and says so; the next hide, 40 px from the
        // end of the short page, is refused like a first one.
        f.pageLaidOut(tall = false)
        assertFalse(f.hiding)
        assertEquals(Verdict.HELD, f.page(1_080, 1_260, 40, fingerY = finger - 360f))
    }

    @Test
    fun aFingerLandingOnAPageStillTallStartsWithNothingToGrow() {
        // The bar came home under the last finger, which lifted with the page flinging on: the page
        // keeps its tall layout until the fling ends and the bar rests. A finger landing before
        // that scrolls down 30 px from the end: the bar leaves without a relayout, so no clamp.
        val f = filter()
        f.down(finger, pageTall = true)
        assertTrue(f.hiding)
        assertEquals(Verdict.REPORT, f.page(900, 920, 30, fingerY = finger - 20f))
        // At the rest the page is short: a finger landing then is gated as before.
        val g = filter()
        g.down(finger, pageTall = false)
        assertFalse(g.hiding)
        assertEquals(Verdict.HELD, g.page(900, 920, 30, fingerY = finger - 20f))
    }

    @Test
    fun aSecondFingerEndsTheBarsPartOfTheGestureUntilTheNextDown() {
        // A drag that has begun hiding the bar; a second finger lands and the two pinch: the zoom
        // scrolls the page in physical px, up and down, with room below and none of it the bar's.
        val f = filter()
        f.down(finger)
        assertEquals(Verdict.REPORT, f.page(900, 930, 2_000, fingerY = finger - 30f))
        f.pointerDown()
        assertTrue(f.multiTouch)
        assertEquals(Verdict.NONE, f.page(930, 1_130, 1_800, offset = 30f, fingerY = finger - 30f))
        assertEquals(Verdict.NONE, f.page(1_130, 1_000, 1_930, offset = 30f, fingerY = finger - 10f))
        // The fingers lift: what the page scrolls in the fling window is the pinch's settling, not
        // a fling of the finger's – nothing, and no show at the top either.
        f.lifted(2_000L)
        assertEquals(Verdict.NONE, f.page(1_000, 1_040, 1_890, offset = 30f, now = 2_050L))
        assertEquals(Verdict.NONE, f.page(40, 0, 2_890, offset = 30f, now = 2_100L))
        // The next first finger starts afresh.
        f.down(finger)
        assertFalse(f.multiTouch)
        assertEquals(Verdict.REPORT, f.page(0, 20, 2_870, offset = 30f, fingerY = finger - 20f))
        // A pinch from the bar's edge, at rest: the first scroll it brings starts no hide.
        val g = filter()
        g.down(finger)
        g.pointerDown()
        assertEquals(Verdict.NONE, g.page(0, 300, 2_000, fingerY = finger - 300f))
        assertFalse(g.hiding)
    }

    @Test
    fun aScrollWithNoFingerAndNoFlingIsThePagesOwn() {
        val f = filter()
        assertEquals(Verdict.NONE, f.page(0, 300, 1_000))
        f.down(finger)
        f.lifted(1_000L)
        assertEquals(Verdict.NONE, f.page(0, 300, 1_000, now = 1_121L))
        assertEquals(Verdict.NONE, f.page(300, 300, 1_000, now = 1_010L))
    }
}
