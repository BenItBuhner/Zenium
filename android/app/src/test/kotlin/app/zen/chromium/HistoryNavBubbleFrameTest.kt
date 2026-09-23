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
}
