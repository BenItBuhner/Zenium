package app.zen.chromium.ext

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionCallsTest {
    /** A scaler that records what it was handed and answers a fixed data URL. */
    private class Scaler(private val answer: ActionCalls.Scaled? = ActionCalls.Scaled(32, "data:image/png;base64,QUJD")) : ActionCalls.IconScaler {
        val seen = ArrayList<ActionCalls.Pixels>()
        override fun scale(width: Int, height: Int, argb: IntArray): ActionCalls.Scaled? {
            seen += ActionCalls.Pixels(width, height, argb)
            return answer
        }
    }

    private fun call(details: String, id: Any = 9, method: String = "setIcon"): String =
        """{"t":"call","id":$id,"ns":"action","method":"$method","args":[$details],"token":"tok","ep":"$EP"}"""

    /** `serializeIconDetails`'s image: `{width, height, data}` with `data` as `Uint8ClampedArray` stringifies. */
    private fun image(side: Int, byte: (Int) -> Int = { (it * 7) and 255 }, asArray: Boolean = false): String {
        val data = StringBuilder()
        data.append(if (asArray) '[' else '{')
        for (i in 0 until side * side * 4) {
            if (i > 0) data.append(',')
            if (!asArray) data.append('"').append(i).append("\":")
            data.append(byte(i))
        }
        data.append(if (asArray) ']' else '}')
        return """{"width":$side,"height":$side,"data":$data}"""
    }

    private fun envelope(text: String): JSONObject = BridgeEnvelope.read(text)!!

    @Test
    fun `the tab key comes from the details through the small envelope and through the big text alike`() {
        val small = call("""{"text":"a","tabId":5}""", method = "setBadgeText")
        assertTrue(small.length < BridgeEnvelope.BIG_MESSAGE)
        assertEquals("5", ActionCalls.detailsTabId(envelope(small), small))
        assertEquals("", ActionCalls.detailsTabId(envelope(call("""{"text":"a"}""", method = "setBadgeText")), ""))
        assertEquals("", ActionCalls.detailsTabId(envelope(call("""{"text":"a","tabId":null}""", method = "setBadgeText")), ""))
        // Big: the envelope has no `args`; the text is walked, the pixel blob skipped, the tab id after it read.
        val big = call("""{"imageData":${image(48)},"tabId":7}""")
        assertTrue(big.length >= BridgeEnvelope.BIG_MESSAGE)
        assertFalse(envelope(big).has("args"))
        assertEquals("7", ActionCalls.detailsTabId(envelope(big), big))
        assertEquals("", ActionCalls.detailsTabId(envelope(call("""{"imageData":${image(48)}}""")), call("""{"imageData":${image(48)}}""")))
        val first = call("""{"tabId":3,"imageData":${image(48)}}""")
        assertEquals("3", ActionCalls.detailsTabId(envelope(first), first))
    }

    @Test
    fun `no tab key for what is not a call in the engine's shape`() {
        // A tab id that is not a number (the core's error), details that are not an object, a
        // message without `args`, a hand-built object with `args` far down.
        assertNull(ActionCalls.detailsTabId(envelope(call("""{"tabId":"x"}""", method = "setBadgeText")), ""))
        assertNull(ActionCalls.detailsTabId(envelope(call(""""a"""", method = "setBadgeText")), ""))
        val port = """{"t":"portMsg","portId":"p","data":{"x":"${"y".repeat(9000)}"},"token":"tok","ep":"$EP"}"""
        assertNull(ActionCalls.detailsTabId(envelope(port), port))
        val late = StringBuilder("{")
        for (i in 0 until 12) late.append("\"k$i\":\"${"v".repeat(1000)}\",")
        late.append("\"args\":[{\"tabId\":1}]}")
        assertNull(ActionCalls.detailsTabId(envelope(late.toString()), late.toString()))
    }

    @Test
    fun `a setIcon's pixels are read once into ARGB and cross as a path of one data URL, the tab id kept`() {
        val scaler = Scaler()
        val text = call("""{"imageData":${image(4, byte = { i -> listOf(10, 20, 30, 255)[i % 4] })},"tabId":7}""")
        val out = ActionCalls.rewriteIcon(envelope(text), text, scaler)!!
        assertEquals(1, scaler.seen.size)
        val pixels = scaler.seen[0]
        assertEquals(4, pixels.width)
        assertEquals(4, pixels.height)
        assertEquals(16, pixels.argb.size)
        // RGBA bytes (10, 20, 30, 255) as an ARGB int.
        assertEquals((255 shl 24) or (10 shl 16) or (20 shl 8) or 30, pixels.argb[0])
        assertEquals(pixels.argb[0], pixels.argb[15])
        val rebuilt = JSONObject(out)
        assertEquals("call", rebuilt.getString("t"))
        assertEquals(9, rebuilt.getInt("id"))
        assertEquals("action", rebuilt.getString("ns"))
        assertEquals("setIcon", rebuilt.getString("method"))
        assertEquals(EP, rebuilt.getString("ep"))
        assertFalse("the token stays on this side", rebuilt.has("token"))
        val details = rebuilt.getJSONArray("args").getJSONObject(0)
        assertEquals(7, details.getInt("tabId"))
        assertFalse(details.has("imageData"))
        assertEquals("data:image/png;base64,QUJD", details.getJSONObject("path").getString("32"))
        assertTrue("the rewritten call is small (${out.length})", out.length < 300)
    }

    @Test
    fun `of a dictionary of images the smallest at least the slot is scaled, else the largest`() {
        val scaler = Scaler()
        val text = call("""{"imageData":{"16":${image(16)},"48":${image(48)},"128":${image(128)}}}""")
        ActionCalls.rewriteIcon(envelope(text), text, scaler)!!
        assertEquals(listOf(48), scaler.seen.map { it.width })
        val small = Scaler()
        val text2 = call("""{"imageData":{"16":${image(16)},"24":${image(24)}}}""")
        ActionCalls.rewriteIcon(envelope(text2), text2, small)!!
        assertEquals(listOf(24), small.seen.map { it.width })
    }

    @Test
    fun `pixels as a plain array read the same`() {
        val scaler = Scaler()
        val text = call("""{"imageData":${image(2, { 200 }, asArray = true)}}""")
        ActionCalls.rewriteIcon(envelope(text), text, scaler)!!
        assertEquals(1, scaler.seen.size)
        assertEquals((200 shl 24) or (200 shl 16) or (200 shl 8) or 200, scaler.seen[0].argb[3])
    }

    @Test
    fun `a setIcon by path goes as it came, and one whose pixels cannot be drawn crosses without them`() {
        val scaler = Scaler()
        val byPath = call("""{"path":{"16":"icons/16.png"},"tabId":2}""")
        assertNull(ActionCalls.rewriteIcon(envelope(byPath), byPath, scaler))
        assertTrue(scaler.seen.isEmpty())
        // The scaler has nothing to draw: the pixels are left out, the other details cross.
        val refusing = Scaler(answer = null)
        val text = call("""{"imageData":${image(8)},"tabId":2,"path":{"16":"icons/16.png"}}""")
        val out = ActionCalls.rewriteIcon(envelope(text), text, refusing)!!
        val details = JSONObject(out).getJSONArray("args").getJSONObject(0)
        assertFalse(details.has("imageData"))
        assertEquals(2, details.getInt("tabId"))
        assertEquals("icons/16.png", details.getJSONObject("path").getString("16"))
        // Malformed pixels (a member that is not a byte): left out as well.
        val broken = call("""{"imageData":{"width":2,"height":2,"data":{"0":"x"}},"tabId":4}""")
        val out2 = ActionCalls.rewriteIcon(envelope(broken), broken, Scaler())!!
        val details2 = JSONObject(out2).getJSONArray("args").getJSONObject(0)
        assertFalse(details2.has("imageData"))
        assertEquals(4, details2.getInt("tabId"))
        // Not a call in the engine's shape: nothing to rewrite.
        val port = """{"t":"portMsg","portId":"p","data":{"imageData":1},"token":"tok","ep":"$EP"}"""
        assertNull(ActionCalls.rewriteIcon(envelope(port), port, scaler))
    }

    companion object {
        private const val EP = "doc.nonce.cppjknee"
    }
}
