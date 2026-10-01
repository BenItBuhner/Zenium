package app.zen.chromium

import app.zen.chromium.ChromePageSnapshot.Area
import app.zen.chromium.ChromePageSnapshot.Frame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Where a Settings tab's picture is copied from (`chrome.snapshot`): the content area the chrome
 * reported, in the window's pixels, clipped to the chrome view – the phone's 720 × 1600 display
 * at density 2 (a 360 × 800 CSS px chrome), the view at the window's origin unless said.
 */
class ChromePageSnapshotTest {
    private val density = 2f

    private fun frame(area: Area?, viewLeft: Int = 0, viewTop: Int = 0, viewWidth: Int = 720, viewHeight: Int = 1600): Frame? =
        ChromePageSnapshot.frame(area, density, viewLeft, viewTop, viewWidth, viewHeight)

    @Test
    fun theContentAreaInCssPxBecomesTheWindowRectangleAtTheDisplaysDensity() {
        // The phone's frame: below the status bar's 24 CSS px, above a 48 CSS px bar band and the
        // system's 24 – 8 CSS px in from each side.
        val f = frame(Area(8.0, 24.0, 344.0, 704.0))
        assertEquals(Frame(16, 48, 704, 1456, 0.5f), f)
        // The copy is taken at half, a page cover's own scale.
        assertEquals(344, f!!.scaledWidth)
        assertEquals(704, f.scaledHeight)
    }

    @Test
    fun theViewsPlaceInTheWindowOffsetsTheArea() {
        // A chrome view laid out 100 px down the window (a DeX window's title bar): the same area,
        // 100 px further down.
        assertEquals(Frame(16, 148, 704, 1556, 0.5f), frame(Area(8.0, 24.0, 344.0, 704.0), viewTop = 100))
    }

    @Test
    fun fractionsOfACssPxFallAsTheHostLaysAPageOut() {
        // `TabHost.setBounds`: the product's integer part – 8.4 CSS px × 2 = 16.8 → 16, 343.6 × 2 = 687.2 → 687.
        assertEquals(Frame(16, 48, 703, 1456, 0.5f), frame(Area(8.4, 24.0, 343.6, 704.0)))
    }

    @Test
    fun anAreaPastTheViewsEdgesIsClippedToThem() {
        // A stale frame from a taller window: the copy stops at the view's bottom edge.
        assertEquals(Frame(16, 48, 704, 1600, 0.5f), frame(Area(8.0, 24.0, 344.0, 1000.0)))
        // One to the left of the view: nothing left of the view is copied.
        assertEquals(Frame(0, 48, 100, 1456, 0.5f), frame(Area(-20.0, 24.0, 70.0, 704.0)))
    }

    @Test
    fun anAreaWithNothingOfTheViewInItIsNoCopy() {
        assertNull(frame(Area(8.0, 900.0, 344.0, 100.0)))
        assertNull(frame(Area(8.0, 24.0, 0.0, 704.0)))
        assertNull(frame(Area(8.0, 24.0, 344.0, -10.0)))
        // Nor is a view without a size.
        assertNull(frame(Area(8.0, 24.0, 344.0, 704.0), viewWidth = 0))
    }

    @Test
    fun noAreaCopiesTheWholeView() {
        assertEquals(Frame(0, 0, 720, 1600, 0.5f), frame(null))
        assertEquals(Frame(30, 100, 750, 1700, 0.5f), frame(null, viewLeft = 30, viewTop = 100))
    }

    @Test
    fun aWideCopyIsTakenAt1400PxAtMostAsAPageCoverIs() {
        // A tablet's 2560 px wide content frame (density 2, 1280 CSS px): scaled to 1400 px.
        val f = frame(Area(0.0, 0.0, 1280.0, 800.0), viewWidth = 2560, viewHeight = 1600)
        assertEquals(1400f / 2560f, f!!.scale)
        assertEquals(1400, f.scaledWidth)
        assertEquals(875, f.scaledHeight)
        // Narrower than the ceiling: half.
        assertEquals(0.5f, ChromePageSnapshot.coverScale(1400))
        assertEquals(0.5f, ChromePageSnapshot.coverScale(720))
    }
}
