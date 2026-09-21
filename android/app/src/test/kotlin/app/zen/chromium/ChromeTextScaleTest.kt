package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The chrome's text zoom from the body size as the system scales it (`TypedValue.applyDimension`
 * on 15 sp): linear below Android 14, and on 14 what `FontScaleConverter`'s tables give 15 sp.
 */
class ChromeTextScaleTest {
    @Test
    fun theDefaultSizeIsNoZoom() {
        assertEquals(100, ChromeTextScale.textZoomPercent(15f))
        assertEquals(1.0, ChromeTextScale.zoomFactor(100), 0.0)
    }

    @Test
    fun linearScalesBelowAndroid14() {
        // Small (0.85), Large (1.15), Larger (1.3) and Largest (2.0) at `fontScale` × 15 sp.
        assertEquals(85, ChromeTextScale.textZoomPercent(12.75f))
        assertEquals(115, ChromeTextScale.textZoomPercent(17.25f))
        assertEquals(130, ChromeTextScale.textZoomPercent(19.5f))
        assertEquals(200, ChromeTextScale.textZoomPercent(30f))
    }

    @Test
    fun android14sNonLinearTablesGiveTheBodySizeLessThanTheSetting() {
        // The 2.0 table maps 14 sp → 26 dp and 18 sp → 30 dp: 15 sp lands at 27 dp, a 1.8 zoom.
        assertEquals(180, ChromeTextScale.textZoomPercent(27f))
        // The 1.3 table maps 14 → 18.8 and 18 → 21.6: 15 sp at 19.5 dp, still 1.3.
        assertEquals(130, ChromeTextScale.textZoomPercent(19.5f))
    }

    @Test
    fun theFactorTheChromeHearsIsThePercentInForce() {
        assertEquals(1.8, ChromeTextScale.zoomFactor(180), 1e-9)
        assertEquals(1.3, ChromeTextScale.zoomFactor(130), 1e-9)
    }

    @Test
    fun theZoomStaysWithinWhatTheWebViewTakes() {
        assertEquals(ChromeTextScale.MIN_PERCENT, ChromeTextScale.textZoomPercent(1f))
        assertEquals(ChromeTextScale.MAX_PERCENT, ChromeTextScale.textZoomPercent(90f))
    }
}
