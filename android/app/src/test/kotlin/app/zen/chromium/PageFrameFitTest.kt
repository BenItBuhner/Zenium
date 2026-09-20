package app.zen.chromium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [TabHost.setBounds]'s guard against a stale frame (BH-32): the container is a portrait phone,
 * 1080 x 2400 device px at density 2.625 (411 x 914 CSS px), unless said otherwise.
 */
class PageFrameFitTest {
    private val density = 2.625f
    private fun fits(width: Int, height: Int, containerWidth: Int = 1080, containerHeight: Int = 2400): Boolean =
        PageFrameFit.fits(width, height, containerWidth, containerHeight, density)

    private fun px(css: Int): Int = (css * density).toInt()

    @Test
    fun theChromesInlineFrameFits() {
        // The phone chrome's page frame: 399 x 756 CSS px inside a 411 x 914 window.
        assertTrue(fits(px(399), px(756)))
        // The fullscreen layout: the whole window.
        assertTrue(fits(px(411), px(914)))
    }

    @Test
    fun aFrameMeasuredForTheLandscapeWindowIsRefusedOnceTheScreenIsPortraitAgain() {
        // Run 3's stale frame after the return from a landscape fullscreen: the chrome, still
        // reading its landscape viewport (914 x 411), laid the page out 806 x 324 in a container
        // that was already portrait – cropped on the right, a third of the height.
        assertFalse(fits(px(806), px(324)))
        // And the other way round: a portrait frame in a container still landscape.
        assertFalse(fits(px(399), px(756), containerWidth = 2400, containerHeight = 1080))
        // The same frames fit their own windows.
        assertTrue(fits(px(806), px(324), containerWidth = 2400, containerHeight = 1080))
    }

    @Test
    fun aCssPixelOfRoundingIsAllowed() {
        // A frame the container's exact width may scale to a device pixel over it.
        assertTrue(fits(1080 + 1, 2400))
        assertTrue(fits(1080, 2400 + 3))
        // Beyond a CSS pixel it is not rounding.
        assertFalse(fits(1080 + 4, 2400))
        assertFalse(fits(1080, 2400 + 4))
    }

    @Test
    fun aContainerNotLaidOutYetRefusesNothing() {
        assertTrue(fits(px(806), px(324), containerWidth = 0, containerHeight = 0))
        assertTrue(fits(px(399), px(756), containerWidth = 1080, containerHeight = 0))
    }

    @Test
    fun anEmptyFrameFitsAnywhere() {
        assertTrue(fits(0, 0))
        assertTrue(fits(0, 0, containerWidth = 1, containerHeight = 1))
    }
}
