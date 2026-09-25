package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The bridge's asynchronous channel apart from the WebView (`BridgePort.Receiver` into
 * `JsBridge.Calls.route`; services perf pass 2 – #455's finding – and pass 4, the port as the
 * bridge): a string off the port is dispatched BY ITS SHAPE into the route its hop would have
 * taken – a JSON array is a batch (one main-thread task, its commands in order), an envelope
 * with an id a call, one without a post – with admission first per kind as the hops apply it, a
 * storage call parsed and dispatched on the storage thread as the raw string, one FIFO with the
 * hops before it, every other parse on the port's thread and every dispatch on the main thread in
 * the order received across the kinds; a string of no shape the bridge knows is logged, dropped
 * and counted, and what is not a string, or arrives after the channel closed, is dropped and
 * logged, never routed.
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
    /** Main-thread tasks posted by the routes (a batch is one of them, whatever its length). */
    private val mainTasks = AtomicInteger()
    /** The view ops the host knows a view for; a one-way command on another view is the host's silent no-op (`TabHost`). */
    private val knownViews = setOf("t1", "t2")

    private val admission = BridgeAdmission(heap192)
    private val calls = JsBridge.Calls(
        admission,
        storage = { work -> storageThread.execute(work); true },
        main = { work -> mainTasks.incrementAndGet(); mainThread.execute(work) },
        dispatch = { id, method, _ -> dispatched.add("main $method #$id on ${Thread.currentThread().name}") },
        dispatchStorage = { id, method, args -> dispatched.add("storage $method #$id on ${Thread.currentThread().name} (${args.optString("name")})") },
        dispatchOneWay = { method, args ->
            val tabId = args.optString("tabId")
            if (method.startsWith("view.") && method != "view.create" && tabId.isNotEmpty() && tabId !in knownViews) {
                // `Host.dispatch` → `TabHost`: `views[tabId] ?: return` – nothing happens, nothing is said.
                dispatched.add("one-way $method on ${Thread.currentThread().name} (no view $tabId: no-op)")
            } else {
                dispatched.add("one-way $method on ${Thread.currentThread().name}")
            }
        },
        reject = { id, message -> rejected.add("#$id $message") },
        log = { message, _ -> logged.add(message) },
        parse = { json -> parsed.add(json.take(40) to Thread.currentThread().name); JSONObject(json) },
        parseArray = { json -> parsed.add(json.take(40) to Thread.currentThread().name); JSONArray(json) }
    )
    /** The receiver routes into the same three routes the JNI entries are (`JsBridge.route` = `Calls.route`): nothing is duplicated for the port. */
    private val receiver = BridgePort.Receiver(calls::route) { portLog.add(it) }

    @After
    fun stop() {
        storageThread.shutdownNow()
        mainThread.shutdownNow()
        portThread.shutdownNow()
    }

    private fun call(id: Int, method: String, args: String): String = "{\"id\":$id,\"method\":\"$method\",\"args\":$args}"
    private fun post(method: String, args: String): String = "{\"method\":\"$method\",\"args\":$args}"
    private fun batch(vararg commands: String): String = "[${commands.joinToString(",")}]"

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

    /** Hold the main thread until the latch is counted down: what arrives meanwhile queues behind the hold, in order. */
    private fun holdMain(): CountDownLatch {
        val hold = CountDownLatch(1)
        mainThread.execute { hold.await(5, TimeUnit.SECONDS) }
        return hold
    }

    // --- the storage class (services perf pass 2) --------------------------------------------------

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
    fun `a thumbnail read between two storage writes on the port does not wait behind the storage queue, and the writes keep their order`() {
        // Another subject on another thread: the storage FIFO's hold is not the read's – it is
        // dispatched on the main thread while the writes wait (services perf pass 3).
        val hold = CountDownLatch(1)
        storageThread.execute { hold.await(5, TimeUnit.SECONDS) }
        arrives(storageWrite(1, "state.json", 2_000))
        arrives(call(2, "thumbnail.load", "{\"tabId\":\"t1\",\"url\":\"https://a/\"}"))
        arrives(storageWrite(3, "state.json", 2_000))
        val mainDone = CountDownLatch(1)
        mainThread.execute { mainDone.countDown() }
        assertTrue(mainDone.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("main thumbnail.load #2 on test-main"), dispatched)

        hold.countDown()
        drain()
        assertEquals(
            listOf(
                "main thumbnail.load #2 on test-main",
                "storage storage.write #1 on test-storage (state.json)",
                "storage storage.write #3 on test-storage (state.json)"
            ),
            dispatched
        )
        assertEquals(3, receiver.received.get())
        assertEquals(0L, admission.queuedChars)
    }

    // --- the port as the bridge: dispatch by shape (services perf pass 4) ----------------------------

    @Test
    fun `a string off the port is dispatched by its shape - an array is a batch, an envelope with an id a call, one without a post - each parsed on the port's thread`() {
        arrives(call(21, "tab.activate", "{\"tabId\":\"t1\"}"))
        arrives(post("chrome.setBarHide", "{\"enabled\":false}"))
        arrives(batch(post("view.setBounds", "{\"tabId\":\"t1\"}"), post("view.setVisible", "{\"tabId\":\"t1\",\"visible\":true}")))
        // The shape is read past leading whitespace, as the hops' heads are.
        arrives("  \n" + batch(post("view.setRadius", "{\"tabId\":\"t2\",\"radius\":0}")))
        arrives(" " + post("chrome.setBarHide", "{\"enabled\":true}"))
        arrives(" " + call(22, "view.focus", "{\"tabId\":\"t1\"}"))
        drain()

        assertEquals(
            listOf(
                "main tab.activate #21 on test-main",
                "one-way chrome.setBarHide on test-main",
                "one-way view.setBounds on test-main",
                "one-way view.setVisible on test-main",
                "one-way view.setRadius on test-main",
                "one-way chrome.setBarHide on test-main",
                "main view.focus #22 on test-main"
            ),
            dispatched
        )
        assertEquals(6, parsed.size)
        assertTrue("every parse on the port's thread: $parsed", parsed.all { it.second == "test-port" })
        assertEquals(6, receiver.received.get())
        assertEquals(0, calls.unknown.get())
        assertTrue(rejected.isEmpty())
        assertTrue(logged.isEmpty())
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `a batch off the port is ONE main-thread task, its commands in order, as through the hop`() {
        val hold = holdMain()
        val before = mainTasks.get()
        arrives(
            batch(
                post("view.setBounds", "{\"tabId\":\"t1\"}"),
                post("view.setRadius", "{\"tabId\":\"t1\",\"radius\":12}"),
                post("view.setCover", "{\"tabId\":\"t1\"}"),
                post("view.setVisible", "{\"tabId\":\"t1\",\"visible\":true}"),
                post("view.bringToFront", "{\"tabId\":\"t1\"}")
            )
        )
        assertEquals("one task for the array", 1, mainTasks.get() - before)
        assertTrue(dispatched.isEmpty())
        hold.countDown()
        drain()

        assertEquals(
            listOf("view.setBounds", "view.setRadius", "view.setCover", "view.setVisible", "view.bringToFront").map { "one-way $it on test-main" },
            dispatched
        )
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `the main thread's dispatch order is the receipt order across the kinds - a hop's call, then the port's calls, posts and batches`() {
        val hold = holdMain()
        // The last call through the hop – posted to the main thread before the page went on – then
        // the port's, of every kind, in the order the page posted them.
        calls.call(call(1, "tab.activate", "{\"tabId\":\"t1\"}"))
        arrives(post("chrome.setBarHide", "{\"offset\":1}"))
        arrives(batch(post("view.setBounds", "{\"tabId\":\"t1\"}"), post("view.setVisible", "{\"tabId\":\"t1\",\"visible\":true}")))
        arrives(call(2, "view.focus", "{\"tabId\":\"t1\"}"))
        arrives(post("chrome.setBarHide", "{\"offset\":2}"))
        arrives(batch(post("view.setRadius", "{\"tabId\":\"t1\",\"radius\":0}")))
        arrives(call(3, "thumbnail.load", "{\"tabId\":\"t1\"}"))
        assertTrue(dispatched.isEmpty())
        hold.countDown()
        drain()

        assertEquals(
            listOf(
                "main tab.activate #1 on test-main",
                "one-way chrome.setBarHide on test-main",
                "one-way view.setBounds on test-main",
                "one-way view.setVisible on test-main",
                "main view.focus #2 on test-main",
                "one-way chrome.setBarHide on test-main",
                "one-way view.setRadius on test-main",
                "main thumbnail.load #3 on test-main"
            ),
            dispatched
        )
        assertEquals(6, receiver.received.get())
        assertEquals(0L, admission.queuedChars)
    }

    @Test
    fun `admission comes first on the port for every kind - a refused call is answered, a refused post or batch is dropped and logged, nothing is parsed`() {
        val over = admission.messageLimitChars.toInt() + 1
        arrives(storageWrite(41, "state.json", over))
        arrives(post("chrome.setBarHide", "{\"pad\":\"${"x".repeat(over)}\"}"))
        arrives(batch(post("view.setBounds", "{\"pad\":\"${"x".repeat(over)}\"}")))
        drain()

        assertTrue("parsed: $parsed", parsed.isEmpty())
        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("#41 ${BridgeAdmission.MESSAGE_TOO_LONG}"), rejected)
        assertEquals(3, admission.refused.get())
        // Logged the first time (then every hundredth): the call's refusal is the first.
        assertEquals(1, logged.size)
        assertTrue(logged[0], logged[0].startsWith("storage.write (") && logged[0].contains("refused, over the message limit"))
        assertEquals(0L, admission.queuedChars)
        // Received, all the same: the receiver counts what it handed to the route.
        assertEquals(3, receiver.received.get())
        assertEquals(0, calls.unknown.get())
    }

    @Test
    fun `a string of no shape the bridge knows is logged, dropped and counted - never parsed, never admitted`() {
        val strangers = listOf("\"hello\"", "42", "{\"foo\":1}", "", "   ", "{\"args\":{},\"method\":\"tab.activate\"}", "null")
        for (i in 1..200) arrives(strangers[i % strangers.size])
        drain()

        assertEquals(200, calls.unknown.get())
        assertEquals(200, receiver.received.get())
        assertTrue(parsed.isEmpty())
        assertTrue(dispatched.isEmpty())
        assertTrue(rejected.isEmpty())
        assertEquals(0, admission.refused.get())
        assertEquals(0L, admission.queuedChars)
        assertEquals(listOf(1, 100, 200), logged.map { it.substringAfterLast('(').substringBefore(' ').toInt() })
        assertTrue(logged[0], logged[0].startsWith("a port message of no shape the bridge knows"))
    }

    @Test
    fun `a malformed string of a known shape is logged and its reservation returned, per kind`() {
        arrives("{\"id\":5,\"method\":\"tab.activate\",\"args\":{")
        arrives("{\"method\":\"chrome.setBarHide\",\"args\":")
        arrives("[{\"method\":\"view.setBounds\"},")
        drain()

        assertTrue(dispatched.isEmpty())
        assertEquals(listOf("bad call payload", "bad post payload", "bad batch payload"), logged)
        assertEquals(0L, admission.queuedChars)
        assertEquals(0, calls.unknown.get())
    }

    @Test
    fun `a view op for a view the host never heard of - a lost view create's siblings - is the host's no-op, and a command that throws takes neither its siblings nor the task down`() {
        // THE HAZARD of the port (bridge.ts): a string posted into a channel whose host end is
        // closed is dropped by the platform, not reordered. The host closes its end only with the
        // document, so what can be lost is a dying document's traffic – but the host must not mind
        // a `view.setBounds` for a view whose `view.create` never came. `Host.dispatch` answers a
        // view op with `tab?.…` and `TabHost` with `views[tabId] ?: return`: a silent no-op,
        // modelled by the test's one-way dispatch. Should a host throw instead, the route logs it
        // and the siblings run.
        arrives(batch(post("view.setBounds", "{\"tabId\":\"t9\"}"), post("view.setVisible", "{\"tabId\":\"t9\",\"visible\":true}"), post("view.setBounds", "{\"tabId\":\"t1\"}")))
        drain()
        assertEquals(
            listOf(
                "one-way view.setBounds on test-main (no view t9: no-op)",
                "one-way view.setVisible on test-main (no view t9: no-op)",
                "one-way view.setBounds on test-main"
            ),
            dispatched
        )
        assertTrue(logged.isEmpty())

        val throwing = JsBridge.Calls(
            admission,
            storage = { work -> storageThread.execute(work); true },
            main = { work -> mainThread.execute(work) },
            dispatch = { _, _, _ -> },
            dispatchStorage = { _, _, _ -> },
            dispatchOneWay = { method, args -> if (args.optString("tabId") == "t9") throw IllegalStateException("no view t9") else dispatched.add("one-way $method") },
            reject = { _, _ -> },
            log = { message, _ -> logged.add(message) }
        )
        dispatched.clear()
        throwing.route(batch(post("view.setBounds", "{\"tabId\":\"t9\"}"), post("view.setVisible", "{\"tabId\":\"t1\",\"visible\":true}")))
        throwing.route(post("view.setRadius", "{\"tabId\":\"t9\"}"))
        throwing.route(post("view.setRadius", "{\"tabId\":\"t1\"}"))
        drain()
        assertEquals(listOf("one-way view.setVisible", "one-way view.setRadius"), dispatched)
        assertEquals(listOf("native view.setBounds failed", "native view.setRadius failed"), logged)
        assertEquals(0L, admission.queuedChars)
    }

    // --- the platform's part -------------------------------------------------------------------------

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
        arrives(post("chrome.setBarHide", "{}"))
        arrives(batch(post("view.setBounds", "{\"tabId\":\"t1\"}")))
        arrives(null)
        drain()

        assertEquals(1, receiver.received.get())
        assertEquals(4, receiver.dropped.get())
        assertEquals(listOf("storage storage.write #1 on test-storage (state.json)"), dispatched)
        assertEquals(listOf("a port message after the channel closed was dropped (1 so far)"), portLog)
        assertEquals(0L, admission.queuedChars)
    }
}
