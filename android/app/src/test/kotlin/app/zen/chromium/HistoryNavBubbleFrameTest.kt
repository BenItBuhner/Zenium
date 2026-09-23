package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `chrome.historyNavBubble`'s frame (from `HistoryNavBubble.tsx`, CSS px of the chrome's window)
 * read into device px for the native disc: the box scaled by the density, the flags through,
 * `{ visible: false }` as the bubble down.
 */
class HistoryNavBubbleFrameTest {
    private val density = 1.75f

    private fun frame(json: String): HistoryNavBubbleFrame? = HistoryNavBubbleFrame.parse(JSONObject(json), density)

    @Test
    fun theBoxIsScaledByTheDensity() {
        val f = frame("""{"edge":"left","left":52,"top":378,"size":44,"scale":1.15,"opacity":1,"armed":true,"reduced":false}""")!!
        assertEquals(HistoryNavClassifier.Edge.LEFT, f.edge)
        assertEquals(52f * density, f.leftPx, 1e-4f)
        assertEquals(378f * density, f.topPx, 1e-4f)
        assertEquals(77, f.sizePx)
        assertEquals(1.15f, f.scale, 1e-6f)
        assertEquals(1f, f.alpha, 1e-6f)
        assertTrue(f.armed)
        assertFalse(f.reduced)
    }

    @Test
    fun theRightEdgeAndTheReducedFlagComeThrough() {
        val f = frame("""{"edge":"right","left":264,"top":378,"size":44,"scale":1,"opacity":0.5,"armed":false,"reduced":true}""")!!
        assertEquals(HistoryNavClassifier.Edge.RIGHT, f.edge)
        assertEquals(0.5f, f.alpha, 1e-6f)
        assertFalse(f.armed)
        assertTrue(f.reduced)
    }

    @Test
    fun visibleFalseTakesTheBubbleDown() {
        assertNull(frame("""{"visible":false}"""))
    }

    @Test
    fun aFrameWithoutASizeIsNoFrame() {
        assertNull(frame("""{"edge":"left","left":0,"top":0}"""))
        assertNull(frame("""{"edge":"left","left":0,"top":0,"size":0}"""))
    }

    @Test
    fun theVisualsAreClampedToWhatAViewTakes() {
        val f = frame("""{"edge":"left","left":-44,"top":0,"size":44,"scale":-0.2,"opacity":1.6}""")!!
        assertEquals(0f, f.scale, 0f)
        assertEquals(1f, f.alpha, 0f)
        // The rest: a whole disc out beyond the side, negative in window px.
        assertEquals(-44f * density, f.leftPx, 1e-4f)
        // Unnamed flags read as off.
        assertFalse(f.armed)
        assertFalse(f.reduced)
    }

    @Test
    fun theClipIsThePageFramesBoxInDevicePx() {
        // The phone's frame: 6 CSS px in from the window's left, 360 wide; 10.5 px rounds to 11.
        val f = frame(
            """{"edge":"left","left":-38,"top":378,"size":44,"clip":{"left":6,"top":100.4,"right":366,"bottom":700}}"""
        )!!
        assertEquals(HistoryNavBubbleFrame.Clip(11, 176, 641, 1225), f.clip)
    }

    @Test
    fun noClipOrAnEmptyOneLeavesTheDiscUnclipped() {
        assertNull(frame("""{"edge":"left","left":-44,"top":378,"size":44}""")!!.clip)
        assertNull(frame("""{"edge":"left","left":-44,"top":378,"size":44,"clip":{"left":6,"top":100,"right":6,"bottom":700}}""")!!.clip)
    }

    // The disc's opacity per frame (`HistoryNavBubbleView.setShown` through `bubbleAlphaStep`).

    @Test
    fun withMotionOnEveryFrameSetsTheAlphaOutright() {
        // The chrome's spring is the animation: the leave's frames arrive already faded.
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0.5f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0f, alpha = 1f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = false, target = 0f, alpha = 0.3f, fading = true))
    }

    @Test
    fun underReducedMotionTheDragsFramesSetTheAlphaOutright() {
        // The fade-in over the first 16 px, and the disc held at 1 while the finger moves: no
        // animator per touch sample.
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 0.5f, alpha = 0f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 0.5f, fading = false))
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 1f, fading = false))
    }

    @Test
    fun underReducedMotionTheLeaveIsTheOneFade() {
        // The release: the machine's hide arrives whole, a showing disc taken to nothing.
        assertEquals(BubbleAlphaStep.FADE, bubbleAlphaStep(reduced = true, target = 0f, alpha = 1f, fading = false))
        assertEquals(BubbleAlphaStep.FADE, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0.4f, fading = false))
        // The machine's rest frame 120 ms on, still at nothing: the fade that runs is left to finish.
        assertEquals(BubbleAlphaStep.KEEP, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0.2f, fading = true))
        assertEquals(BubbleAlphaStep.KEEP, bubbleAlphaStep(reduced = true, target = 0f, alpha = 0f, fading = true))
    }

    @Test
    fun aFrameThatShowsTheDiscAgainCutsARunningFade() {
        assertEquals(BubbleAlphaStep.SET, bubbleAlphaStep(reduced = true, target = 1f, alpha = 0.2f, fading = true))
    }
}
