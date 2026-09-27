package app.zen.chromium

import app.zen.chromium.TabHoverCardFrame.Box
import app.zen.chromium.TabHoverCardPlacement.Side
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The native card's placement is `placeHoverCard`'s (lib/hoverCard.ts): the chrome's own cases
 * (`hoverCard.test.ts`, `placeHoverCard` and its strip variant) at one px per dp, so the card the
 * host draws lands where the desktop's would – flush against the sidebar's inner edge on the
 * page's side, start-aligned with its row, clamped at the window's margin, flipped above a row
 * near the bottom, and under the band with the axis turned.
 */
class TabHoverCardPlacementTest {
    private val viewportW = 1600f
    private val viewportH = 1000f
    private val cardW = 320f
    private val cardH = 92f
    private val margin = 8f
    private val floor = 160f
    private val sidebarLeft = Box(0f, 0f, 240f, 1000f)
    private val sidebarRight = Box(1360f, 0f, 240f, 1000f)

    private fun row(y: Float, x: Float = 8f) = Box(x, y, 224f, 36f)

    private fun place(anchor: Box, sidebar: Box, w: Float = viewportW, h: Float = viewportH, cw: Float = cardW, ch: Float = cardH, axisX: Boolean = false) =
        TabHoverCardPlacement.place(anchor, sidebar, w, h, cw, ch, axisX, margin, floor)

    @Test
    fun theLeftEdge_flushAgainstALeftSidebarStartAlignedWithTheRow() {
        val p = place(row(120f), sidebarLeft)
        assertEquals(Side.BELOW, p.side)
        assertEquals(240f, p.left, 0f)
        assertEquals(120f, p.top, 0f)
        assertEquals(320f, p.width, 0f)
        assertEquals(92f, p.maxHeight, 0f)
        assertEquals(120f, p.topFor(cardH, viewportH), 0f)
    }

    @Test
    fun theRightEdge_toTheLeftOfASidebarOnTheRight_theRtlSide() {
        val p = place(row(120f, x = 1368f), sidebarRight)
        assertEquals(Side.BELOW, p.side)
        assertEquals(1040f, p.left, 0f)
        assertEquals(120f, p.top, 0f)
    }

    @Test
    fun theBottomEdge_flipsAboveARowNearTheBottomEndAlignedOnTheRowsBottom() {
        // The row at 940–976: 92 below its top would end at 1032, past the 992 margin line, and
        // there is more room above than below.
        val p = place(row(940f), sidebarLeft)
        assertEquals(Side.ABOVE, p.side)
        assertEquals(240f, p.left, 0f)
        assertEquals(1000f - 976f, p.bottom, 0f)
        assertEquals(92f, p.maxHeight, 0f)
        // Resolved for the view: its bottom edge on the row's.
        assertEquals(976f - 92f, p.topFor(cardH, viewportH), 0f)
    }

    @Test
    fun staysStartAlignedUpToTheLastRowThatFitsThenFlips() {
        val last = viewportH - margin - cardH
        assertEquals(Side.BELOW, place(row(last), sidebarLeft).side)
        assertEquals(last, place(row(last), sidebarLeft).top, 0f)
        assertEquals(Side.ABOVE, place(row(last + 1), sidebarLeft).side)
    }

    @Test
    fun flippedItKeepsTheMarginWhenTheRowRunsUnderTheWindowsBottomEdge() {
        val p = place(row(990f), sidebarLeft)
        assertEquals(Side.ABOVE, p.side)
        assertEquals(margin, p.bottom, 0f)
    }

    @Test
    fun theTopEdge_neverStartsAboveTheMargin() {
        val p = place(row(-20f), sidebarLeft)
        assertEquals(Side.BELOW, p.side)
        assertEquals(margin, p.top, 0f)
    }

    @Test
    fun keepsTheCardInsideANarrowWindow() {
        val p = place(row(120f), Box(0f, 0f, 240f, 1000f), w = 500f)
        assertEquals(500f - 320f - margin, p.left, 0f)
    }

    @Test
    fun aCardWiderThanTheWindowMinusTheMarginsShrinksToThat() {
        val p = place(row(120f), sidebarLeft, w = 300f)
        assertEquals(300f - 2 * margin, p.width, 0f)
        assertEquals(margin, p.left, 0f)
    }

    @Test
    fun neverTallerThanTheWindowMinusTheMarginsShrinkingRatherThanFlippingWhenTheRoomBelowIsTheLarger() {
        val p = place(row(120f), sidebarLeft, ch = 2000f)
        assertEquals(Side.BELOW, p.side)
        assertEquals(viewportH - margin - 120f, p.maxHeight, 0f)
        // Under the floor below, it flips above and takes the room there.
        val low = place(row(900f), sidebarLeft, ch = 2000f)
        assertEquals(Side.ABOVE, low.side)
        assertEquals(viewportH - margin - (viewportH - 936f), low.maxHeight, 0f)
    }

    @Test
    fun theStripsBottomAnchor_hangsFlushUnderTheBandLeftEdgesTogetherWithItsTab() {
        val band = Box(0f, 0f, 1600f, 36f)
        val p = place(Box(300f, 0f, 180f, 36f), band, axisX = true)
        assertEquals(Side.BELOW, p.side)
        assertEquals(300f, p.left, 0f)
        assertEquals(36f, p.top, 0f)
        assertEquals(320f, p.width, 0f)
        assertEquals(92f, p.maxHeight, 0f)
    }

    @Test
    fun theStripsBottomAnchor_slidesBackInsideTheWindowsMarginForATabNearTheTrailingEdge() {
        val band = Box(0f, 0f, 1600f, 36f)
        val p = place(Box(1500f, 0f, 100f, 36f), band, axisX = true)
        assertEquals(1600f - 320f - margin, p.left, 0f)
        // And never left of the margin; the room runs down to the bottom margin.
        val first = place(Box(0f, 0f, 100f, 36f), band, axisX = true, ch = 2000f)
        assertEquals(margin, first.left, 0f)
        assertEquals(viewportH - margin - 36f, first.maxHeight, 0f)
    }
}
