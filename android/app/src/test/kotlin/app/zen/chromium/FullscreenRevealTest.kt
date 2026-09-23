package app.zen.chromium

import app.zen.chromium.FullscreenReveal.Box
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The fullscreen layer's reveal (MOT-32): the clip grows from the page's inline frame to the
 * window on the chrome's spring, each edge on its own line. The portrait phone of the demos:
 * 1080 x 2400 device px, the page's frame inside the chrome's gutters, under the status bar and
 * over the bar band.
 */
class FullscreenRevealTest {
    private val window = Box(0, 0, 1080, 2400)
    private val page = Box(16, 126, 1064, 2110)

    @Test
    fun theClipIsThePageAtTheStartAndTheWindowAtTheEnd() {
        assertEquals(page, FullscreenReveal.clipAt(page, window, 0f))
        assertEquals(window, FullscreenReveal.clipAt(page, window, 1f))
        // Nothing past either end: a spring's overshoot reveals no more than the window.
        assertEquals(page, FullscreenReveal.clipAt(page, window, -0.2f))
        assertEquals(window, FullscreenReveal.clipAt(page, window, 1.3f))
    }

    @Test
    fun everyEdgeMovesOnItsOwnLine() {
        // Halfway: the gutters half gone, the top and the bar's band half covered.
        assertEquals(Box(8, 63, 1072, 2255), FullscreenReveal.clipAt(page, window, 0.5f))
        // A quarter of the way, rounded to the device pixel.
        assertEquals(Box(12, 95, 1068, 2183), FullscreenReveal.clipAt(page, window, 0.25f))
    }

    @Test
    fun theTravelIsTheFarthestEdge() {
        // The bar's band at the bottom is the longest way: 290 px.
        assertEquals(290f, FullscreenReveal.travelOf(page, window))
        // A page already the window: nothing to reveal.
        assertEquals(0f, FullscreenReveal.travelOf(window, window))
        // A frame laid out past the window (a stale one) counts no negative distance.
        assertEquals(0f, FullscreenReveal.travelOf(Box(-10, -10, 1090, 2410), window))
    }

    @Test
    fun theSpringIsTheChromesSnappyOne() {
        // `SPRING_SNAPPY` in shared/spring.ts: the bar leaves on it, the layer must keep pace.
        assertEquals(420f, FullscreenReveal.STIFFNESS)
        assertEquals(40f, FullscreenReveal.DAMPING)
    }
}
