package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeEnvelopeTest {
    /** A port message as the engine writes it: `t` first, the payload in the middle, `token` and `ep` stamped last. */
    private fun portMessage(payloadEntries: Int): String {
        val data = JSONObject()
        for (i in 0 until payloadEntries) {
            data.put("account$i", JSONObject().put("balance", "1${i}00.5").put("chains", JSONArray(listOf("eth", "bsc", "sol"))).put("meta", JSONObject.NULL))
        }
        return JSONObject()
            .put("t", "portMsg")
            .put("portId", "p-7")
            .put("data", JSONObject().put("type", "STATE").put("state", data))
            .put("token", "tok-1")
            .put("ep", "doc.nonce.egjidjbp")
            .toString()
    }

    @Test
    fun `the envelope has the scalars and not the nested values`() {
        val text = portMessage(1)
        val envelope = BridgeEnvelope.parse(text)!!
        assertEquals("portMsg", envelope.getString("t"))
        assertEquals("p-7", envelope.getString("portId"))
        assertEquals("tok-1", envelope.getString("token"))
        assertEquals("doc.nonce.egjidjbp", envelope.getString("ep"))
        assertFalse(envelope.has("data"))
        assertEquals(setOf("t", "portId", "token", "ep"), envelope.keys().asSequence().toSet())
    }

    @Test
    fun `a big message is read as its envelope, a small one whole`() {
        val big = portMessage(400)
        assertTrue(big.length >= BridgeEnvelope.BIG_MESSAGE)
        val envelope = BridgeEnvelope.read(big)!!
        assertEquals("portMsg", envelope.getString("t"))
        assertFalse(envelope.has("data"))

        val small = portMessage(1)
        assertTrue(small.length < BridgeEnvelope.BIG_MESSAGE)
        val whole = BridgeEnvelope.read(small)!!
        assertEquals("STATE", whole.getJSONObject("data").getString("type"))
    }

    @Test
    fun `every scalar kind decodes as the library decodes it`() {
        val text = """{"t":"call","id":42,"ratio":0.25,"big":12345678901,"on":true,"off":false,"none":null,"name":"a \"quoted\" \\ back\u0073lash \ud83d\ude00 \n line","args":[1,{"x":[]}],"nested":{"a":{"b":[{"c":"}"}]}},"last":"end"}"""
        val envelope = BridgeEnvelope.parse(text)!!
        val whole = JSONObject(text)
        for (key in listOf("t", "id", "ratio", "big", "on", "off", "name", "last")) {
            assertEquals(key, whole.get(key), envelope.get(key))
        }
        assertTrue(envelope.isNull("none"))
        assertTrue(envelope.has("none"))
        assertFalse(envelope.has("args"))
        assertFalse(envelope.has("nested"))
    }

    @Test
    fun `whitespace and an empty object are fine`() {
        val envelope = BridgeEnvelope.parse(" \n{ \"t\" : \"hello\" ,\t\"top\" : true , \"world\" : { } , \"n\" : 3 }\r\n")!!
        assertEquals("hello", envelope.getString("t"))
        assertTrue(envelope.getBoolean("top"))
        assertEquals(3, envelope.getInt("n"))
        assertFalse(envelope.has("world"))
        assertEquals(0, BridgeEnvelope.parse("{}")!!.length())
    }

    @Test
    fun `text that is not a JSON object is refused`() {
        for (bad in listOf(
            "",
            "[]",
            "\"str\"",
            "{\"t\":\"x\"",
            "{\"t\":\"x\"} trailing",
            "{t:1}",
            "{\"t\":\"unterminated}",
            "{\"t\":abc}",
            "{\"a\":[1,2}}",
            "{\"a\":{\"b\":1]}",
            "{\"a\":[}",
            "{\"a\":1,}",
            "{\"a\" 1}",
            "{\"a\":\"x\" \"b\":1}"
        )) {
            assertNull(bad, BridgeEnvelope.parse(bad))
        }
    }

    @Test
    fun `brackets and quotes inside strings do not count`() {
        val text = """{"t":"msg","data":{"s":"}{][\"\\","arr":["]","}"]},"ep":"e"}"""
        val envelope = BridgeEnvelope.parse(text)!!
        assertEquals("msg", envelope.getString("t"))
        assertEquals("e", envelope.getString("ep"))
        assertFalse(envelope.has("data"))
    }
}
