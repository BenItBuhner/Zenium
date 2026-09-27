package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `chrome.hoverCard`'s frame (from lib/hoverCard.ts, CSS px of the chrome's window) read into
 * device px for the native card: the boxes and the window scaled by the density, the text
 * through as the desktop card renders it, `{ visible: false }` as the card down.
 */
class TabHoverCardFrameTest {
    private val density = 1.75f

    private fun frame(json: String): TabHoverCardFrame? = TabHoverCardFrame.parse(JSONObject(json), density)

    private val shown = """{"visible":true,"tabId":"tab_gamma","title":"Gamma – the third page","host":"127.0.0.1:18168",
        "lines":["Sleeping"],"preview":true,"url":"http://127.0.0.1:18168/gamma.html",
        "anchor":{"x":8,"y":164,"width":224,"height":44},"sidebar":{"x":0,"y":56,"width":240,"height":744},
        "viewport":{"width":1280,"height":800},"by":"pointer"}"""

    @Test
    fun theBoxesAndTheWindowAreScaledByTheDensityTheTextComesThrough() {
        val f = frame(shown)!!
        assertEquals("tab_gamma", f.tabId)
        assertEquals("Gamma – the third page", f.title)
        assertEquals("127.0.0.1:18168", f.host)
        assertEquals(listOf("Sleeping"), f.lines)
        assertTrue(f.preview)
        assertEquals("http://127.0.0.1:18168/gamma.html", f.url)
        assertEquals(8f * density, f.anchor.x, 1e-4f)
        assertEquals(164f * density, f.anchor.y, 1e-4f)
        assertEquals(224f * density, f.anchor.width, 1e-4f)
        assertEquals(44f * density, f.anchor.height, 1e-4f)
        assertEquals(240f * density, f.sidebar.width, 1e-4f)
        assertEquals(1280f * density, f.viewportWidth, 1e-4f)
        assertEquals(800f * density, f.viewportHeight, 1e-4f)
        assertFalse(f.axisX)
        assertFalse(f.byFocus)
    }

    @Test
    fun theStripsAxisAndFocusComeThroughAndAnEmptyHostStaysEmpty() {
        val f = frame("""{"visible":true,"tabId":"t","title":"New Tab","host":"","lines":[],"preview":false,"url":"about:blank",
            "anchor":{"x":300,"y":0,"width":180,"height":36},"sidebar":{"x":0,"y":0,"width":1280,"height":36},
            "viewport":{"width":1280,"height":800},"axis":"x","by":"focus"}""")!!
        assertTrue(f.axisX)
        assertTrue(f.byFocus)
        assertFalse(f.preview)
        assertEquals("", f.host)
        assertTrue(f.lines.isEmpty())
    }

    @Test
    fun theCardDownIsNullAsIsAFrameWithoutItsBoxes() {
        assertNull(frame("""{"visible":false}"""))
        assertNull(frame("""{"visible":true,"tabId":"t","title":"T"}"""))
        assertNull(frame("""{"visible":true,"title":"T","anchor":{"x":0,"y":0,"width":1,"height":1},"sidebar":{"x":0,"y":0,"width":1,"height":1}}"""))
    }
}
