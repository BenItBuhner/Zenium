package app.zen.chromium.ext

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `chrome.privacy`'s document-start layer as `ext.privacy.apply` carries it (compat round 20, the
 * coordinator's item (2d)): the value per kind of tab and the script that moves an open document.
 */
class ExtensionPrivacyLayerTest {
    @Test
    fun `the core's payload is read, per kind of tab, with the two scripts`() {
        val layer = ExtensionPrivacyLayer.fromJson(
            JSONObject("""{"doNotTrack":true,"doNotTrackPrivate":false,"script":{"on":"ON()","off":"OFF()"}}""")
        )
        assertTrue(layer.doNotTrack)
        assertFalse(layer.doNotTrackPrivate)
        assertFalse(layer.isEmpty)
        assertTrue(layer.holds(privateTab = false))
        assertFalse(layer.holds(privateTab = true))
        // A regular tab's open document takes the on script, a private tab's the off script.
        assertEquals("ON()", layer.scriptFor(privateTab = false))
        assertEquals("OFF()", layer.scriptFor(privateTab = true))
        assertEquals("doNotTrack on (regular tabs)", layer.summary())
    }

    @Test
    fun `a missing field reads as not held and no script, the empty layer runs nothing`() {
        val sparse = ExtensionPrivacyLayer.fromJson(JSONObject("""{"doNotTrackPrivate":true}"""))
        assertFalse(sparse.doNotTrack)
        assertTrue(sparse.doNotTrackPrivate)
        assertNull(sparse.scriptFor(privateTab = true))
        assertNull(sparse.scriptFor(privateTab = false))
        assertEquals("doNotTrack on (private tabs)", sparse.summary())

        val empty = ExtensionPrivacyLayer.fromJson(JSONObject("{}"))
        assertEquals(ExtensionPrivacyLayer.EMPTY, empty)
        assertTrue(empty.isEmpty)
        assertEquals("none", empty.summary())
        assertNull(empty.scriptFor(privateTab = false))

        val both = ExtensionPrivacyLayer(true, true, "ON()", "OFF()")
        assertEquals("doNotTrack on (regular and private tabs)", both.summary())
        assertEquals("ON()", both.scriptFor(privateTab = true))
    }
}
