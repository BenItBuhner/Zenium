package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Device px at density 1.75: a 50 CSS px travel (88 px). The chrome reports the page's frame in
 * its short layout (`S`, the band left free) or its tall one (`H`, into the band); the frame's
 * `shownEdge` tells them apart.
 */
class BarHidePlacementTest {
    private val travel = 88
    /** The page's frame in the short layout: below a top bar, `S` starts at 200; above a bottom bar, `S` ends at 1500. */
    private val top = 200
    private val bottom = 1500

    private fun frame(edge: BarHideFrame.Edge, offset: Float) =
        BarHideFrame(edge, offset, travel, if (edge == BarHideFrame.Edge.TOP) top else bottom)

    private fun placement(top: Int, bottom: Int, shift: Float = 0f, clip: Int = 0) = BarHidePlacement(top, bottom, shift, clip)

    @Test
    fun withNoBarToHideTheChromesLayoutStands() {
        assertEquals(placement(top, bottom), BarHidePlacement.of(top, bottom, null))
    }

    @Test
    fun aBottomDockedBarGrowsThePageUnderTheClipAndLeavesItGrownWhenHidden() {
        val edge = BarHideFrame.Edge.BOTTOM
        // At the shown rest: the short layout as reported.
        assertEquals(placement(top, bottom), BarHidePlacement.of(top, bottom, frame(edge, 0f)))
        // Mid-way: laid out tall once, the strip the bar has not left clipped off the bottom.
        assertEquals(placement(top, bottom + travel, clip = 66), BarHidePlacement.of(top, bottom, frame(edge, 22f)))
        assertEquals(placement(top, bottom + travel, clip = 44), BarHidePlacement.of(top, bottom, frame(edge, 44f)))
        // Hidden: the tall layout, unclipped.
        assertEquals(placement(top, bottom + travel), BarHidePlacement.of(top, bottom, frame(edge, 88f)))
    }

    @Test
    fun aTopDockedBarSlidesThePageUpWithItAndClipsTheFramesBottom() {
        val edge = BarHideFrame.Edge.TOP
        assertEquals(placement(top, bottom), BarHidePlacement.of(top, bottom, frame(edge, 0f)))
        // Mid-way: the view is laid out a band taller below and slid up by the bar's offset, so the
        // content under the finger holds still; what runs past the frame's bottom is clipped.
        assertEquals(placement(top, bottom + travel, shift = -30f, clip = 58), BarHidePlacement.of(top, bottom, frame(edge, 30f)))
        // Hidden: the tall layout starts a band above, where the bar was.
        assertEquals(placement(top - travel, bottom), BarHidePlacement.of(top, bottom, frame(edge, 88f)))
    }

    @Test
    fun aReportAlreadyInTheTallLayoutIsReadAsSuchAndNotGrownAgain() {
        // The chrome's column took the band at the hidden rest and reported the tall frame; the
        // shown edge tells the placement that this is `H`, so a bar coming back mid-way keeps the
        // same tall frame and clips it, and the shown rest is the short layout, not a band short of it.
        val b = BarHideFrame.Edge.BOTTOM
        assertEquals(placement(top, bottom + travel), BarHidePlacement.of(top, bottom + travel, frame(b, 88f)))
        assertEquals(placement(top, bottom + travel, clip = 44), BarHidePlacement.of(top, bottom + travel, frame(b, 44f)))
        assertEquals(placement(top, bottom), BarHidePlacement.of(top, bottom + travel, frame(b, 0f)))
        val t = BarHideFrame.Edge.TOP
        assertEquals(placement(top - travel, bottom), BarHidePlacement.of(top - travel, bottom, frame(t, 88f)))
        assertEquals(placement(top, bottom + travel, shift = -44f, clip = 44), BarHidePlacement.of(top - travel, bottom, frame(t, 44f)))
        assertEquals(placement(top, bottom), BarHidePlacement.of(top - travel, bottom, frame(t, 0f)))
    }

    @Test
    fun aViewFillingTheWindowIsLeftAloneByARelayoutForTheBarAndLaidOutForItWhenPutBack() {
        // Picture-in-picture: the view fills the window; the bar's frames keep arriving and must
        // write nothing to it (its MATCH_PARENT layout is the window's), whatever the bar does.
        val frame = frame(BarHideFrame.Edge.BOTTOM, 44f)
        assertNull(BarHidePlacement.of(top, bottom, frame, held = true))
        assertNull(BarHidePlacement.of(top, bottom, null, held = true))
        // Put back, the same reported frame under the bar as it stands then gives the bar's layout.
        assertEquals(placement(top, bottom + travel, clip = 44), BarHidePlacement.of(top, bottom, frame, held = false))
        assertEquals(placement(top, bottom), BarHidePlacement.of(top, bottom, null, held = false))
    }
}
