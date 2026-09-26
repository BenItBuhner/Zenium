package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ctrl + the wheel over a page zooms it one step per whole notch, away from the user for in
 * (OS-12; Chromium's `WebContentsImpl::HandleWheelEvent`, whose remainder rule this mirrors):
 * a plain wheel and every other motion stay the WebView's, a Ctrl+wheel is taken whole – even
 * the fraction of a notch that zooms nothing yet, so the page does not scroll under a zoom.
 */
class WheelZoomTest {
    @Test
    fun aWholeNotchUnderCtrlZoomsOnceInItsDirectionAndIsTaken() {
        val zoom = WheelZoom()
        assertEquals(WheelZoom.Step.IN, zoom.step(scroll = true, ctrl = true, vscroll = 1f))
        assertEquals(WheelZoom.Step.OUT, zoom.step(scroll = true, ctrl = true, vscroll = -1f))
        assertEquals("in", WheelZoom.Step.IN.direction)
        assertEquals("out", WheelZoom.Step.OUT.direction)
        assertTrue(WheelZoom.Step.IN.consumed)
        assertTrue(WheelZoom.Step.OUT.consumed)
    }

    @Test
    fun aWheelWithoutCtrlAndAMotionThatIsNoScrollAreTheWebViews() {
        val zoom = WheelZoom()
        val plain = zoom.step(scroll = true, ctrl = false, vscroll = 1f)
        assertEquals(WheelZoom.Step.PASS, plain)
        assertFalse(plain.consumed)
        assertNull(plain.direction)
        // A hover move with Ctrl held (the key is down while the mouse moves) is no wheel.
        assertEquals(WheelZoom.Step.PASS, zoom.step(scroll = false, ctrl = true, vscroll = 0f))
    }

    @Test
    fun aTrackpadsFractionsAddUpToOneStepAndAreTakenMeanwhile() {
        val zoom = WheelZoom()
        // 0.3 + 0.3 = 0.6 rounds to a notch (lround, as Chromium's), the -0.4 is carried.
        val first = zoom.step(scroll = true, ctrl = true, vscroll = 0.3f)
        assertEquals(WheelZoom.Step.NONE, first)
        assertTrue("a Ctrl+wheel short of a notch is still the zoom's, not the page's scroll", first.consumed)
        assertNull(first.direction)
        assertEquals(WheelZoom.Step.IN, zoom.step(scroll = true, ctrl = true, vscroll = 0.3f))
        // The carried -0.4 with another 0.3 is -0.1: nothing yet; with 0.6 more it is 0.5, a notch.
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = 0.3f))
        assertEquals(WheelZoom.Step.IN, zoom.step(scroll = true, ctrl = true, vscroll = 0.6f))
    }

    @Test
    fun aBigNotchIsOneStepNotSeveral() {
        val zoom = WheelZoom()
        // A wheel that reports two or three notches in one event (a flick) zooms one step per
        // event, as Chromium's `ContentsZoomChange(bool)` does; the overshoot is not carried.
        assertEquals(WheelZoom.Step.OUT, zoom.step(scroll = true, ctrl = true, vscroll = -3f))
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = 0.2f))
    }

    @Test
    fun aPlainWheelBetweenTwoCtrlWheelsBeginsTheRemainderAgain() {
        val zoom = WheelZoom()
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = 0.4f))
        assertEquals(WheelZoom.Step.PASS, zoom.step(scroll = true, ctrl = false, vscroll = 1f))
        // Without the reset this 0.4 would make 0.8 and a step.
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = 0.4f))
    }

    @Test
    fun aCtrlWheelOfNoTravelIsTakenAndZoomsNothing() {
        val zoom = WheelZoom()
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = 0f))
        assertEquals(WheelZoom.Step.NONE, zoom.step(scroll = true, ctrl = true, vscroll = Float.NaN))
        assertEquals(WheelZoom.Step.IN, zoom.step(scroll = true, ctrl = true, vscroll = 1f))
    }
}
