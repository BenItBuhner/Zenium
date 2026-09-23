package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge's admission by raw length (compat round 11, the Trust Wallet crash class): the
 * string is refused before anything of it is parsed, with Chrome's oversized-message error, and
 * the gate goes on admitting what follows.
 */
class BridgeAdmissionTest {
    private val heap192 = 192L * 1024 * 1024

    /** A `__zenNative.call` of the bridge's shape carrying an `ext.send` of about [chars] chars. */
    private fun extSendCall(id: Int, chars: Int): String {
        val payload = StringBuilder(chars)
        while (payload.length < chars) payload.append("{\"balance\":\"100.5\",\"chains\":[\"eth\",\"bsc\"]},")
        return "{\"id\":$id,\"method\":\"ext.send\",\"args\":{\"ep\":\"doc.7.ext\",\"message\":\"${payload.toString().replace("\"", "\\\"")}\"}}"
    }

    @Test
    fun `the limits follow the heap between a floor and a ceiling`() {
        val phone = BridgeAdmission(heap192)
        assertEquals(6L * 1024 * 1024, phone.messageLimitChars)
        assertEquals(8L * 1024 * 1024, phone.queueLimitChars)

        val tiny = BridgeAdmission(16L * 1024 * 1024)
        assertEquals(BridgeAdmission.MESSAGE_FLOOR_CHARS, tiny.messageLimitChars)
        assertEquals(BridgeAdmission.QUEUE_FLOOR_CHARS, tiny.queueLimitChars)

        val tablet = BridgeAdmission(2048L * 1024 * 1024)
        assertEquals(BridgeAdmission.MESSAGE_CEILING_CHARS, tablet.messageLimitChars)
        assertEquals(BridgeAdmission.QUEUE_CEILING_CHARS, tablet.queueLimitChars)

        // The message limit never exceeds the queue limit: a string that fits alone always fits an empty queue.
        for (heap in listOf(8L, 64L, 192L, 256L, 512L, 1024L, 4096L)) {
            val a = BridgeAdmission(heap * 1024 * 1024)
            assertTrue("heap $heap MB", a.messageLimitChars <= a.queueLimitChars)
        }
    }

    @Test
    fun `an oversized envelope is refused with Chrome's error and the bridge answers the next one`() {
        val admission = BridgeAdmission(heap192)
        val oversized = extSendCall(41, admission.messageLimitChars.toInt() + 1)
        assertTrue(oversized.length > admission.messageLimitChars)

        val verdict = admission.admit(oversized.length)
        assertSame(BridgeAdmission.Verdict.TooLong, verdict)
        assertEquals("Message length exceeded maximum allowed length.", verdict.message)
        assertEquals(BridgeAdmission.MESSAGE_TOO_LONG, verdict.message)
        assertEquals(1, admission.refused.get())
        // Nothing of a refused string is reserved: the queue is as empty as before it came.
        assertEquals(0L, admission.queuedChars)

        // The chrome's promise for the refused call settles: its id and method come off the head,
        // unparsed, in the same shape bridge.ts writes them.
        val head = BridgeAdmission.head(oversized)!!
        assertEquals(41, head.id)
        assertEquals("ext.send", head.method)

        // The runtime still answers: the next, ordinary call is admitted, reserved, then released.
        val ordinary = extSendCall(42, 144 * 1024)
        assertSame(BridgeAdmission.Verdict.Admitted, admission.admit(ordinary.length))
        assertEquals(ordinary.length.toLong(), admission.queuedChars)
        admission.release(ordinary.length)
        assertEquals(0L, admission.queuedChars)
        assertEquals(1, admission.refused.get())
        // And the admitted string parses as the bridge parses it after admission.
        assertEquals("ext.send", JSONObject(ordinary).getString("method"))
    }

    @Test
    fun `a queue the main thread has not drained refuses the call that would overflow it, then admits again`() {
        val admission = BridgeAdmission(heap192)
        val broadcast = extSendCall(1, 144 * 1024)
        var admitted = 0
        while (admission.admit(broadcast.length) === BridgeAdmission.Verdict.Admitted) admitted++
        // 8 M chars of queue at 144 KB a message: the chrome outran the main thread by 56 messages.
        assertEquals((admission.queueLimitChars / broadcast.length).toInt(), admitted)
        assertTrue(admission.queuedChars <= admission.queueLimitChars)
        assertEquals(1, admission.refused.get())
        assertEquals(BridgeAdmission.MESSAGE_TOO_LONG, BridgeAdmission.Verdict.QueueFull.message)

        // The main thread dispatches one: there is room for one again.
        admission.release(broadcast.length)
        assertSame(BridgeAdmission.Verdict.Admitted, admission.admit(broadcast.length))
        assertSame(BridgeAdmission.Verdict.QueueFull, admission.admit(broadcast.length))
        assertEquals(2, admission.refused.get())
    }

    @Test
    fun `the unqueued check refuses on length alone and counts`() {
        val admission = BridgeAdmission(heap192)
        assertTrue(admission.admitUnqueued(144 * 1024))
        assertTrue(admission.admitUnqueued(admission.messageLimitChars.toInt()))
        assertFalse(admission.admitUnqueued(admission.messageLimitChars.toInt() + 1))
        assertEquals(1, admission.refused.get())
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `the head reads a call or a command and nothing else`() {
        assertEquals("tabs.select", BridgeAdmission.head("""{"id":7,"method":"tabs.select","args":{"id":"t1"}}""")!!.method)
        assertEquals(7, BridgeAdmission.head("""{"id":7,"method":"tabs.select","args":{"id":"t1"}}""")!!.id)
        assertEquals("a \"quoted\" name", BridgeAdmission.head("""{"id":-1,"method":"a \"quoted\" name","args":{}}""")!!.method.replace("\\\"", "\""))
        assertNull(BridgeAdmission.head("""{"method":"chrome.setBarHide","args":{}}"""))
        assertNull(BridgeAdmission.head("""[{"method":"a","args":{}}]"""))
        assertNull(BridgeAdmission.head("not json"))
        assertEquals("chrome.setBarHide", BridgeAdmission.commandMethod("""{"method":"chrome.setBarHide","args":{}}"""))
        assertNull(BridgeAdmission.commandMethod("""{"id":7,"method":"tabs.select"}"""))
    }
}
