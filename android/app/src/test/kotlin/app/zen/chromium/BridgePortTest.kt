package app.zen.chromium

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The bridge's asynchronous channel apart from the WebView (`BridgePort.Receiver`, services perf
 * pass 2 – #455's finding): a string off the port goes into the bridge's `call` route exactly as
 * a hop's string does – admission first, a storage call parsed and dispatched on the storage
 * thread, one FIFO with the hops before it – and what is not a string, or arrives after the
 * channel closed, is dropped and logged, never routed.
 */
class BridgePortTest {
    private val heap192 = 192L * 1024 * 1024

    /** The storage thread of the test: one thread, a FIFO queue, as `Storage`'s executor is. */
    private val storageThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-storage") }
    private val mainThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main") }
    /** The thread the port's callback runs on (`Host`'s `zen-bridge-port`): the receiver is called from it. */
    private val portThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-port") }

    private val parsed = CopyOnWriteArrayList<Pair<String, String>>()
    private val dispatched = CopyOnWriteArrayList<String>()
    private val rejected = CopyOnWriteArrayList<String>()
    private val logged = CopyOnWriteArrayList<String>()
    private val portLog = CopyOnWriteArrayList<String>()

    private val admission = BridgeAdmission(heap192)
    private val calls = JsBridge.Calls(
        admission,
        storage = { work -> storageThread.execute(work); true },
        main = { work -> mainThread.execute(work) },
        dispatch = { id, method, _ -> dispatched.add("main $method #$id on ${Thread.currentThread().name}") },
        dispatchStorage = { id, method, args -> dispatched.add("storage $method #$id on ${Thread.currentThread().name} (${args.optString("name")})") },
        reject = { id, message -> rejected.add("#$id $message") },
        log = { message, _ -> logged.add(message) },
        parse = { json -> parsed.add(json.take(40) to Thread.currentThread().name); JSONObject(json) }
    )
    private val receiver = BridgePort.Receiver(calls::call) { portLog.add(it) }

    @After
    fun stop() {
        storageThread.shutdownNow()
        mainThread.shutdownNow()
        portThread.shutdownNow()
    }

    private fun call(id: Int, method: String, args: String): String = "{\"id\":$id,\"method\":\"$method\",\"args\":$args}"

    private fun storageWrite(id: Int, name: String, chars: Int): String {
        val text = StringBuilder(chars)
        while (text.length < chars) text.append("{\\\"tab\\\":\\\"t${text.length}\\\"},")
        return call(id, "storage.write", "{\"name\":\"$name\",\"text\":\"$text\",\"backup\":true}")
    }

    /** A message off the port: delivered on the port's thread, as the WebView delivers it on the handler's. */
    private fun arrives(data: String?) {
        val done = CountDownLatch(1)
        portThread.execute {
            receiver.onMessage(data)
            done.countDown()
        }
        assertTrue(done.await(5, TimeUnit.SECONDS))
    }

    private fun drain() {
        for (executor in listOf(portThread, storageThread, mainThread, storageThread, mainThread)) {
            val done = CountDownLatch(1)
            executor.execute { done.countDown() }
            assertTrue(done.await(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `a storage write off the port is parsed and dispatched on the storage thread, nothing of it on the port's`() {
        arrives(storageWrite(7, "state.json", 200_000))
        drain()

        assertEquals(1, receiver.received.get())
        assertEquals(0, receiver.dropped.get())
        assertEquals(1, parsed.size)
        assertEquals("test-storage", parsed[0].second)
        assertTrue("parsed on the port's thread: $parsed", parsed.none { it.second == "test-port" })
        assertEquals(listOf("storage storage.write #7 on test-storage (state.json)"), dispatched)
        assertTrue(rejected.isEmpty())
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `the hop before the port and the port's messages after it are one FIFO`() {
        // The storage thread is held while the calls come in, so all of them queue behind the hold.
        val hold = CountDownLatch(1)
        storageThread.execute { hold.await(5, TimeUnit.SECONDS) }
        // The last call through the hop – handed to the storage thread before the page went on –
        // then the port's, in the order the page posted them.
        calls.call(storageWrite(1, "state.json", 2_000))
        for (i in 2..12) arrives(storageWrite(i, if (i % 2 == 0) "state.json" else "history.json", 2_000 * i))
        arrives(call(13, "storage.remove", "{\"name\":\"history.json\"}"))
        assertTrue(dispatched.isEmpty())
        hold.countDown()
        drain()

        val ids = dispatched.map { it.substringAfter('#').substringBefore(' ').toInt() }
        assertEquals((1..13).toList(), ids)
        assertTrue(dispatched.all { it.contains("on test-storage") })
        assertEquals(12, receiver.received.get())
    }

    @Test
    fun `a call of another kind off the port keeps its route, parsed where it came in and dispatched on the main thread`() {
        // The page sends only the storage class through the port (`PORTED`); a host still routes whatever arrives.
        arrives(call(21, "tab.activate", "{\"tabId\":\"t1\"}"))
        drain()

        assertEquals(listOf("main tab.activate #21 on test-main"), dispatched)
        assertEquals(listOf("test-port"), parsed.map { it.second })
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `admission comes first on the port too - a refused message parses nothing and the promise settles`() {
        arrives(storageWrite(41, "state.json", admission.messageLimitChars.toInt() + 1))
        drain()

        assertTrue("parsed: $parsed", parsed.isEmpty())
        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("#41 ${BridgeAdmission.MESSAGE_TOO_LONG}"), rejected)
        assertEquals(1, admission.refused.get())
        assertEquals(0L, admission.queuedChars)
        // Received, all the same: the receiver counts what it handed to the route.
        assertEquals(1, receiver.received.get())
    }

    @Test
    fun `a message without a string is dropped and logged, the first and every hundredth`() {
        for (i in 1..200) arrives(null)
        drain()

        assertEquals(200, receiver.dropped.get())
        assertEquals(0, receiver.received.get())
        assertTrue(dispatched.isEmpty())
        assertEquals(
            listOf(1, 100, 200).map { "a port message without a string was dropped ($it so far)" },
            portLog
        )
    }

    @Test
    fun `after close nothing is routed - a message the platform still delivers is dropped and logged`() {
        arrives(storageWrite(1, "state.json", 1_000))
        receiver.close()
        assertTrue(receiver.closed)
        arrives(storageWrite(2, "state.json", 1_000))
        arrives(null)
        drain()

        assertEquals(1, receiver.received.get())
        assertEquals(2, receiver.dropped.get())
        assertEquals(listOf("storage storage.write #1 on test-storage (state.json)"), dispatched)
        assertEquals(listOf("a port message after the channel closed was dropped (1 so far)"), portLog)
        assertEquals(0L, admission.queuedChars)
    }
}
