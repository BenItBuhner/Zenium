package app.zen.chromium

import app.zen.chromium.PageFrameFit.Screen
import app.zen.chromium.PageFrameFit.Verdict
import org.junit.Assert.assertEquals
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

    private fun judge(width: Int, height: Int, containerWidth: Int, containerHeight: Int, landing: Screen?): Verdict =
        PageFrameFit.judge(width, height, containerWidth, containerHeight, landing, density)

    @Test
    fun outsideALandingTheContainerAloneJudges() {
        assertEquals(Verdict.APPLY, judge(px(399), px(756), 1080, 2400, landing = null))
        assertEquals(Verdict.REFUSE, judge(px(806), px(324), 1080, 2400, landing = null))
    }

    @Test
    fun aLandscapeFrameCaughtBeforeTheTurnBackIsHeldToThePortraitLanding() {
        // The retry run's exit from a landscape video: back pressed, the orientation released,
        // and the chrome's report from under the layer (854 x 349 CSS px, the landscape screen's)
        // reached the host 125 ms before the system turned the screen. The container still
        // landscape, the frame fit it – and laid the page out landscape on the portrait screen
        // the exit lands on. Held back instead.
        val portrait = Screen(1080, 2400)
        assertEquals(Verdict.HOLD, judge(px(854), px(349), 2400, 1080, landing = portrait))
        assertEquals(Verdict.HOLD, judge(px(806), px(324), 2400, 1080, landing = portrait))
        // A frame of the landing's own screen is applied, whichever way the container stands.
        assertEquals(Verdict.APPLY, judge(px(399), px(756), 1080, 2400, landing = portrait))
        assertEquals(Verdict.APPLY, judge(px(411), px(914), 1080, 2400, landing = portrait))
        // One that fits neither is refused as before: the hold is for the frames the turn back undoes.
        assertEquals(Verdict.REFUSE, judge(px(806), px(324), 1080, 2400, landing = portrait))
    }

    @Test
    fun aLandscapeLandingHoldsThePortraitFrames() {
        val landscape = Screen(2400, 1080)
        assertEquals(Verdict.HOLD, judge(px(399), px(756), 1080, 2400, landing = landscape))
        assertEquals(Verdict.APPLY, judge(px(806), px(324), 2400, 1080, landing = landscape))
    }
}
