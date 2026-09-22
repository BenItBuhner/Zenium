package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one hairline every native sheet draws ([SheetEdge]): an open path up the left side, round
 * the two top radii and down the right side – `.zen-sheet`'s `border: 1px` with
 * `border-bottom: 0` – at [PromptSheetSpec.hairlinePx], the stroke inside the bounds with its
 * outer edge on the sheet's radius.
 */
class SheetEdgeTest {
    /** The CI emulator's 420 dpi: 2.625x, a 3 px hairline, a 32 px radius (12 dp). */
    private val hairline = PromptSheetSpec.hairlinePx(2.625f)
    private val radius = Math.round(PromptSheetSpec.SHEET_RADIUS_DP * 2.625f)
    private val outline = SheetEdge.outline(0f, 0f, 1080f, 1500f, hairline, radius)

    @Test
    fun theStrokeLiesInsideTheBoundsWithItsOuterEdgeOnTheSheetsRadius() {
        assertEquals(3, hairline)
        // The centre line half a stroke in from the top and the sides; the arcs' radius the sheet's less that half.
        assertEquals(1.5f, outline.left, 0f)
        assertEquals(1.5f, outline.top, 0f)
        assertEquals(1078.5f, outline.right, 0f)
        assertEquals(radius - 1.5f, outline.radius, 0f)
        // The sides run to the bounds' bottom edge itself: the stroke's end is flush with the screen's edge.
        assertEquals(1500f, outline.bottom, 0f)
    }

    @Test
    fun thePathIsOpenAlongTheBottom() {
        val corners = outline.corners()
        // Bottom-left up, round the top, down to bottom-right: six corners, the first and the last on the bottom edge.
        assertEquals(6, corners.size)
        assertEquals(outline.left to outline.bottom, corners.first())
        assertEquals(outline.right to outline.bottom, corners.last())
        // No segment joins two points on the bottom edge: the path's consecutive corners never both sit at the bottom.
        for ((a, b) in corners.zipWithNext()) {
            assertTrue("no run along the bottom between $a and $b", !(a.second == outline.bottom && b.second == outline.bottom))
        }
        // The top run sits between the two arcs, a radius in from each side.
        assertEquals(outline.left + outline.radius to outline.top, corners[2])
        assertEquals(outline.right - outline.radius to outline.top, corners[3])
    }

    @Test
    fun aOneXScreenDrawsOnePixelAndASheetNarrowerThanItsRadiiKeepsARadiusOfZero() {
        val mdpi = SheetEdge.outline(0f, 0f, 360f, 640f, PromptSheetSpec.hairlinePx(1f), PromptSheetSpec.SHEET_RADIUS_DP)
        assertEquals(0.5f, mdpi.left, 0f)
        assertEquals(359.5f, mdpi.right, 0f)
        assertEquals(11.5f, mdpi.radius, 0f)
        val tiny = SheetEdge.outline(0f, 0f, 10f, 10f, 4, 1)
        assertEquals("the radius never goes under zero", 0f, tiny.radius, 0f)
    }
}
