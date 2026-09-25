package app.zen.chromium

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The host's receipt-to-dispatch measure (services perf pass 4, `BridgeLatency`): off, a string
 * leaves no sample and no time is taken; on, the `call` route stamps a string's arrival before
 * its head is read and its dispatch as the task begins on its thread – main for a call, the
 * storage thread for a storage call – and a drain aggregates per kind and channel inside the
 * scene's window.
 */
class BridgeLatencyTest {
    private val storageThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-storage") }
    private val mainThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main") }
    private val admission = BridgeAdmission(192L * 1024 * 1024)
    private val calls = JsBridge.Calls(
        admission,
        storage = { work -> storageThread.execute(work); true },
        main = { work -> mainThread.execute(work) },
        dispatch = { _, _, _ -> },
        dispatchStorage = { _, _, _ -> },
        reject = { _, _ -> },
        log = { _, _ -> }
    )

    @After
    fun stop() {
        BridgeLatency.enabled = false
        BridgeLatency.reset()
        storageThread.shutdownNow()
        mainThread.shutdownNow()
    }

    private fun drain() {
        for (executor in listOf(storageThread, mainThread)) {
            val done = CountDownLatch(1)
            executor.execute { done.countDown() }
            assertTrue(done.await(5, TimeUnit.SECONDS))
        }
    }

    private fun call(id: Int, method: String, args: String = "{}"): String = "{\"id\":$id,\"method\":\"$method\",\"args\":$args}"

    @Test
    fun `off, a string leaves no sample and the stamp is zero`() {
        BridgeLatency.enabled = false
        assertEquals(0L, BridgeLatency.stamp())
        assertNull(BridgeLatency.arrived(BridgeLatency.CALL, BridgeLatency.HOP, 0L, "tab.activate"))
        calls.call(call(1, "tab.activate"))
        drain()
        val drained = BridgeLatency.drain()
        assertEquals(0, drained.getJSONArray("s").length())
        assertEquals("no samples", BridgeLatency.describe(drained))
    }

    @Test
    fun `on, a call and a storage call are stamped on arrival and as their tasks begin, per kind and channel`() {
        BridgeLatency.enabled = true
        val from = BridgeLatency.now()
        calls.call(call(1, "tab.activate", "{\"tabId\":\"t1\"}"))
        calls.call(call(2, "storage.write", "{\"name\":\"state.json\",\"text\":\"{}\"}"), BridgeLatency.PORT)
        calls.call(call(3, "thumbnail.load", "{\"tabId\":\"t1\"}"), BridgeLatency.PORT)
        drain()
        val to = BridgeLatency.now()

        val drained = BridgeLatency.drain(from, to)
        val raw = drained.getJSONArray("s")
        assertEquals(3, raw.length())
        assertEquals(listOf("call/hop/tab.activate", "storage/port/storage.write", "call/port/thumbnail.load"), (0 until 3).map { i ->
            val s = raw.getJSONArray(i)
            "${s.getString(0)}/${s.getString(1)}/${s.getString(2)}"
        })
        for (i in 0 until 3) {
            val s = raw.getJSONArray(i)
            assertTrue("arrival inside the window: $s", s.getLong(3) in from..to)
            assertTrue("dispatched after arrival: $s", s.getLong(4) >= s.getLong(3))
        }
        val byKind = drained.getJSONObject("byKind")
        assertEquals(listOf("call/hop", "call/port", "storage/port"), byKind.keys().asSequence().toList().sorted())
        assertEquals(1, byKind.getJSONObject("call/hop").getInt("n"))
        assertEquals(0, drained.getInt("pending"))
        assertEquals(0, drained.getInt("outside"))
        assertEquals(0, drained.getInt("overflow"))
        assertTrue(BridgeLatency.describe(drained).startsWith("call/hop n=1 mean "))
        // Drained: the next read starts empty.
        assertEquals(0, BridgeLatency.drain().getJSONArray("s").length())
    }

    @Test
    fun `a refused string is never a sample, a string outside the window is counted and not kept, and the cap counts the overflow`() {
        BridgeLatency.enabled = true
        calls.call(call(1, "tab.activate", "{\"pad\":\"${"x".repeat(admission.messageLimitChars.toInt())}\"}"))
        drain()
        assertEquals(0, BridgeLatency.drain().getJSONArray("s").length())

        val early = BridgeLatency.now()
        calls.call(call(2, "tab.activate"))
        drain()
        val from = BridgeLatency.now() + 1_000_000
        val drained = BridgeLatency.drain(from, Long.MAX_VALUE)
        assertEquals(0, drained.getJSONArray("s").length())
        assertEquals(1, drained.getInt("outside"))
        assertTrue(early <= from)

        for (i in 0 until BridgeLatency.CAP + 5) BridgeLatency.arrived(BridgeLatency.POST, BridgeLatency.HOP, BridgeLatency.now(), "chrome.setBarHide")
        val full: JSONObject = BridgeLatency.drain()
        assertEquals(BridgeLatency.CAP, full.getJSONArray("s").length())
        assertEquals(5, full.getInt("overflow"))
        assertEquals(BridgeLatency.CAP, full.getInt("pending"))
    }
}
