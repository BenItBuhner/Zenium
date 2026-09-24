package app.zen.chromium

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The bridge's `call` route (`JsBridge.Calls`, services perf pass 1 – PERF-5's seed 1, #349's
 * reading 4): a storage call's payload is parsed on the storage thread, never on the thread the
 * chrome's JS waits on; the storage calls land in the order they were sent; the admission's
 * refusal parses nothing, as before; and every other call keeps its route – parsed where it
 * came in, dispatched on the main thread.
 */
class JsBridgeCallsTest {
    private val heap192 = 192L * 1024 * 1024

    /** The storage thread of the test: one thread, a FIFO queue, as `Storage`'s executor is. */
    private val storageThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-storage") }
    private val mainThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main") }
    private val storageClosed = AtomicBoolean(false)

    /** What was parsed, with the thread it was parsed on. */
    private val parsed = CopyOnWriteArrayList<Pair<String, String>>()
    /** What reached the host, in order: `main <method> #<id>` or `storage <method> #<id> on <thread>`. */
    private val dispatched = CopyOnWriteArrayList<String>()
    private val rejected = CopyOnWriteArrayList<String>()
    private val logged = CopyOnWriteArrayList<String>()

    private val admission = BridgeAdmission(heap192)
    private val calls = JsBridge.Calls(
        admission,
        storage = { work -> if (storageClosed.get()) false else { storageThread.execute(work); true } },
        main = { work -> mainThread.execute(work) },
        dispatch = { id, method, _ -> dispatched.add("main $method #$id on ${Thread.currentThread().name}") },
        dispatchStorage = { id, method, args -> dispatched.add("storage $method #$id on ${Thread.currentThread().name} (${args.optString("name")})") },
        reject = { id, message -> rejected.add("#$id $message") },
        log = { message, _ -> logged.add(message) },
        parse = { json -> parsed.add(json.take(40) to Thread.currentThread().name); JSONObject(json) }
    )

    @After
    fun stop() {
        storageThread.shutdownNow()
        mainThread.shutdownNow()
    }

    /** A `__zenNative.call` of the bridge's shape (`bridge.ts`'s `NativeCall`). */
    private fun call(id: Int, method: String, args: String): String = "{\"id\":$id,\"method\":\"$method\",\"args\":$args}"

    private fun storageWrite(id: Int, name: String, chars: Int): String {
        val text = StringBuilder(chars)
        while (text.length < chars) text.append("{\\\"tab\\\":\\\"t${text.length}\\\"},")
        return call(id, "storage.write", "{\"name\":\"$name\",\"text\":\"$text\",\"backup\":true}")
    }

    /** Wait for both threads to drain what was queued so far. */
    private fun drain() {
        for (executor in listOf(storageThread, mainThread, storageThread, mainThread)) {
            val done = CountDownLatch(1)
            executor.execute { done.countDown() }
            assertTrue(done.await(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `a storage write is parsed on the storage thread, not on the thread it came in on`() {
        val caller = Thread.currentThread().name
        val json = storageWrite(7, "state.json", 200_000)

        calls.call(json)
        // Nothing of the payload was parsed on this thread: the call has left it.
        assertTrue("parsed on the caller's thread: $parsed", parsed.none { it.second == caller })
        drain()

        assertEquals(1, parsed.size)
        assertEquals("test-storage", parsed[0].second)
        assertEquals(listOf("storage storage.write #7 on test-storage (state.json)"), dispatched)
        assertTrue(rejected.isEmpty())
        // The reservation ended as the storage thread took the string.
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `every storage call takes the storage route and the others keep theirs`() {
        for ((id, method) in JsBridge.STORAGE_CALLS.withIndex()) calls.call(call(id + 1, method, "{\"name\":\"a.json\",\"token\":3,\"text\":\"x\"}"))
        calls.call(call(100, "view.setBounds", "{\"tabId\":\"t1\"}"))
        calls.call(call(101, "tab.activate", "{}"))
        drain()

        val onStorage = dispatched.filter { it.startsWith("storage ") }
        assertEquals(JsBridge.STORAGE_CALLS.size, onStorage.size)
        assertTrue(onStorage.all { it.contains("on test-storage") })
        assertEquals(
            listOf("main view.setBounds #100 on test-main", "main tab.activate #101 on test-main"),
            dispatched.filter { it.startsWith("main ") }
        )
        // The other calls were parsed where they came in, on this thread.
        val caller = Thread.currentThread().name
        assertEquals(2, parsed.count { it.second == caller })
        assertEquals(JsBridge.STORAGE_CALLS.size, parsed.count { it.second == "test-storage" })
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `storage writes land in the order they were sent`() {
        // The storage thread is held while the writes come in, so all of them queue behind the hold.
        val hold = CountDownLatch(1)
        storageThread.execute { hold.await(5, TimeUnit.SECONDS) }
        for (i in 1..12) calls.call(storageWrite(i, if (i % 2 == 0) "state.json" else "history.json", 2_000 * i))
        calls.call(call(13, "storage.remove", "{\"name\":\"state.json\"}"))
        assertTrue(dispatched.isEmpty())
        hold.countDown()
        drain()

        val ids = dispatched.map { it.substringAfter('#').substringBefore(' ').toInt() }
        assertEquals((1..13).toList(), ids)
        assertTrue(dispatched.all { it.contains("on test-storage") })
    }

    @Test
    fun `a refused call is answered off its head and parses nothing, on either route`() {
        val oversized = storageWrite(41, "state.json", admission.messageLimitChars.toInt() + 1)
        calls.call(oversized)
        val oversizedView = call(42, "view.setBounds", "{\"pad\":\"${"x".repeat(admission.messageLimitChars.toInt())}\"}")
        calls.call(oversizedView)
        drain()

        assertTrue("parsed: $parsed", parsed.isEmpty())
        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("#41 ${BridgeAdmission.MESSAGE_TOO_LONG}", "#42 ${BridgeAdmission.MESSAGE_TOO_LONG}"), rejected)
        assertEquals(2, admission.refused.get())
        assertEquals(0L, admission.queuedChars)
        // A refusal is logged (the first, then every hundredth) with the method off the head.
        assertTrue(logged.toString(), logged.any { it.startsWith("storage.write (") })
    }

    @Test
    fun `a storage call on a closed storage is rejected, not parsed, its reservation returned`() {
        storageClosed.set(true)
        calls.call(storageWrite(9, "state.json", 1_000))
        drain()

        assertTrue(parsed.isEmpty())
        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("#9 storage.write refused: ${Storage.CLOSED}"), rejected)
        assertEquals(0L, admission.queuedChars)
        assertEquals(0, admission.refused.get())
    }

    @Test
    fun `a malformed storage payload is logged on the storage thread and dispatched nowhere`() {
        val broken = "{\"id\":5,\"method\":\"storage.write\",\"args\":{\"name\":\"state.json\",\"text\":"
        calls.call(broken)
        drain()

        assertEquals(1, parsed.size)
        assertEquals("test-storage", parsed[0].second)
        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("bad call payload"), logged)
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `a host failure on the storage thread rejects the call through the main thread`() {
        val failing = JsBridge.Calls(
            admission,
            storage = { work -> storageThread.execute(work); true },
            main = { work -> mainThread.execute(work) },
            dispatch = { _, _, _ -> },
            dispatchStorage = { _, _, _ -> throw IllegalStateException("no write 3") },
            reject = { id, message -> rejected.add("#$id $message on ${Thread.currentThread().name}") },
            log = { message, _ -> logged.add(message) }
        )
        failing.call(call(3, "storage.writeEnd", "{\"token\":3}"))
        drain()

        assertEquals(listOf("#3 no write 3 on test-main"), rejected)
        assertEquals(listOf("native storage.writeEnd failed"), logged)
        assertNull(dispatched.firstOrNull())
        assertNotEquals("test-storage", rejected[0].substringAfter(" on "))
    }
}
