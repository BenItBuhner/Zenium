package app.zen.chromium.ext

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeForwardTest {
    /** The frame scheduler by hand: one tick per [tick]. */
    private class Frames {
        val queued = ArrayDeque<Runnable>()
        fun tick() {
            // A tick may schedule the next one; only the ticks queued before this call run now.
            val now = ArrayList(queued)
            queued.clear()
            now.forEach { it.run() }
        }
    }

    /** What reaches the core, by length only: a sink that kept the texts would hide a guard that did not. */
    private class Sink : BridgeForward.Sink {
        val forwarded = ArrayList<Int>()
        val forwardedTexts = ArrayList<String>()
        var forwardedChars = 0L
        val warnings = ArrayList<String>()
        var rewrites = 0
        var keepTexts = false

        override fun forward(ep: String, tabId: String?, top: Boolean, origin: String, text: CharSequence) {
            forwarded += text.length
            forwardedChars += text.length
            if (keepTexts) forwardedTexts += text.toString()
        }

        override fun rewrite(message: JSONObject, text: String): String? {
            rewrites++
            return ActionCalls.rewriteIcon(message, text) { w, h, _ -> ActionCalls.Scaled(minOf(32, maxOf(w, h)), "data:image/png;base64,QUJD") }
        }

        override fun warn(source: BridgeForward.Source, message: String) {
            warnings += message
        }
    }

    private val frames = Frames()
    private val sink = Sink()
    private val replies = ArrayList<JSONObject>()
    private var ready = true

    private fun guard(limits: BridgeForward.Limits = BridgeForward.Limits()) =
        BridgeForward(limits, { frames.queued.addLast(it) }, { ready }, sink)

    private fun source(ep: String = EP) = BridgeForward.Source(ep, EXT, "content", "https://a.test/") { replies += JSONObject(it) }

    private fun call(id: Int, ns: String, method: String, details: String, ep: String = EP): String =
        """{"t":"call","id":$id,"ns":"$ns","method":"$method","args":[$details],"token":"tok","ep":"$ep"}"""

    /** A `setIcon` as the engine ships one: `serializeIconDetails`'s `{width, height, data}` with a JSON member per byte. */
    private fun setIcon(id: Int, side: Int, tabId: Int? = 1): String {
        val data = StringBuilder(side * side * 4 * 9)
        data.append('{')
        for (i in 0 until side * side * 4) {
            if (i > 0) data.append(',')
            data.append('"').append(i).append("\":").append((i * 7) and 255)
        }
        data.append('}')
        val tab = if (tabId == null) "" else ""","tabId":$tabId"""
        return call(id, "action", "setIcon", """{"imageData":{"width":$side,"height":$side,"data":$data}$tab}""")
    }

    private fun offer(guard: BridgeForward, text: String, ep: String = EP) {
        guard.offer(source(ep), BridgeEnvelope.read(text)!!, text, "t1", true, "https://a.test")
    }

    private fun forwardedIds(): List<Int> = sink.forwardedTexts.map { BridgeEnvelope.read(it)!!.getInt("id") }

    @Test
    fun `a flood of oversized setIcon calls leaves the queue at one message and the core with one small message per frame`() {
        val guard = guard()
        val icon = setIcon(1, 96)
        assertTrue("a 96 px icon is some 0.3 M chars as Clear Cache sent them (${icon.length})", icon.length in 250_000..450_000)
        // Clear Cache's burst: 2480 calls, here 40 to a frame, each its own message text (a fresh
        // 0.3 M-char string, as the WebView hands the main thread one per message).
        val head = icon.substringBefore(",\"ns\"")
        val body = icon.substring(head.length)
        val total = 2480
        var maxPendingChars = 0L
        for (n in 1..total) {
            offer(guard, "{\"t\":\"call\",\"id\":$n" + body)
            maxPendingChars = maxOf(maxPendingChars, guard.pendingChars)
            assertTrue("pending stays at one message (${guard.pendingCount})", guard.pendingCount <= 1)
            if (n % 40 == 0) frames.tick()
        }
        while (guard.pendingCount > 0) frames.tick()
        assertTrue("one pending message at most, never a queue of them ($maxPendingChars chars)", maxPendingChars <= icon.length + 4)
        // One forward a frame for the one key (the first of the run went at once), the rest folded.
        assertTrue("forwarded ${guard.forwarded} of $total", guard.forwarded in 60..64)
        assertEquals(total.toLong(), guard.forwarded + guard.superseded)
        assertEquals(0L, guard.dropped)
        assertEquals(0L, guard.refused)
        assertTrue(sink.warnings.isEmpty())
        // What crossed is the rewritten call: no pixels, a data URL, a few hundred chars each.
        assertEquals(guard.forwarded.toInt(), sink.rewrites)
        assertTrue("the biggest forwarded text is ${sink.forwarded.max()} chars", sink.forwarded.max() < 400)
        assertTrue("forwarded chars ${sink.forwardedChars} against ${total.toLong() * icon.length} arrived", sink.forwardedChars < 30_000)
        // Every folded caller was answered as Chrome answers setIcon: resolved with nothing, once.
        assertEquals(guard.superseded.toInt(), replies.size)
        assertTrue(replies.all { it.getBoolean("ok") && it.isNull("result") && it.getString("ep") == EP })
        assertEquals(replies.size, replies.map { it.getInt("id") }.toSet().size)
    }

    @Test
    fun `action state coalesces to the last value per tab, in order with the source's other messages`() {
        val guard = guard()
        sink.keepTexts = true
        offer(guard, call(1, "action", "setBadgeText", """{"text":"a","tabId":1}"""))
        offer(guard, call(2, "action", "setBadgeText", """{"text":"b","tabId":1}"""))
        offer(guard, call(3, "action", "setBadgeText", """{"text":"c","tabId":1}"""))
        offer(guard, call(4, "action", "setBadgeText", """{"text":"z","tabId":2}"""))
        offer(guard, call(5, "action", "getBadgeText", """{"tabId":1}"""))
        // The first went at once; the second waited, the third took its place; the other tab's and
        // the read wait behind it (order within a source holds).
        assertEquals(1, sink.forwardedTexts.size)
        assertEquals(3, guard.pendingCount)
        assertEquals(1L, guard.superseded)
        assertEquals(listOf(2), replies.map { it.getInt("id") })
        assertTrue(replies[0].getBoolean("ok"))
        frames.tick()
        assertEquals(0, guard.pendingCount)
        assertEquals(listOf(1, 3, 4, 5), forwardedIds())
        assertTrue(sink.forwardedTexts[1].contains("\"text\":\"c\""))
        // Within the frame that forwarded `c`, a newer value for the tab waits again; a frame
        // later it goes at once.
        offer(guard, call(6, "action", "setBadgeText", """{"text":"d","tabId":1}"""))
        assertEquals(1, guard.pendingCount)
        frames.tick()
        frames.tick()
        assertEquals(listOf(1, 3, 4, 5, 6), forwardedIds())
        offer(guard, call(7, "action", "setBadgeText", """{"text":"e","tabId":1}"""))
        assertEquals(listOf(1, 3, 4, 5, 6, 7), forwardedIds())
    }

    @Test
    fun `a global value and a tab's are two states, and other namespaces' calls are not folded`() {
        val guard = guard()
        sink.keepTexts = true
        offer(guard, call(1, "action", "setTitle", """{"title":"one"}"""))
        offer(guard, call(2, "action", "setTitle", """{"title":"two"}"""))
        offer(guard, call(3, "action", "setTitle", """{"title":"three","tabId":9}"""))
        offer(guard, call(4, "action", "setTitle", """{"title":"four","tabId":9}"""))
        offer(guard, call(5, "tabs", "query", """{}"""))
        offer(guard, call(6, "tabs", "query", """{}"""))
        frames.tick()
        // The tab's newer title took the older one's place in the order.
        assertEquals(listOf(1, 2, 4, 5, 6), forwardedIds())
        assertTrue(sink.forwardedTexts[2].contains("\"title\":\"four\""))
        assertEquals(listOf(3), replies.map { it.getInt("id") })
        // For one tab, `setTitle` and `setBadgeText` are two states: the badge goes at once in
        // the frame whose drain forwarded the titles; a second badge and a title wait for the next.
        offer(guard, call(7, "action", "setBadgeText", """{"text":"x"}"""))
        offer(guard, call(8, "action", "setBadgeText", """{"text":"y"}"""))
        offer(guard, call(9, "action", "setTitle", """{"title":"five"}"""))
        assertEquals(listOf(1, 2, 4, 5, 6, 7), forwardedIds())
        assertEquals(2, guard.pendingCount)
        frames.tick()
        assertEquals(listOf(1, 2, 4, 5, 6, 7, 8, 9), forwardedIds())
    }

    @Test
    fun `big messages are paced by the frame budget and bounded per source, the rest refused with an answer and one console line`() {
        val limits = BridgeForward.Limits(frameChars = 64 * 1024, sourceChars = 1024 * 1024)
        val guard = guard(limits)
        val payload = "x".repeat(100_000)
        fun msg(id: Int) = """{"t":"msg","id":$id,"data":"$payload","token":"tok","ep":"$EP"}"""
        for (id in 1..40) offer(guard, msg(id))
        // The first went at once and took the bucket into debt; ten more fit the source's bound
        // (a lone held message is never measured against it); the rest were refused, each with
        // Chrome's kind of answer, and the console heard once.
        assertEquals(1L, guard.forwarded)
        assertEquals(10, guard.pendingCount)
        assertTrue(guard.pendingChars <= limits.sourceChars)
        assertEquals(29L, guard.refused)
        assertEquals(29, replies.size)
        assertTrue(replies.all { !it.getBoolean("ok") && it.getString("error") == BridgeForward.MESSAGE_REFUSED })
        assertEquals((12..40).toList(), replies.map { it.getInt("id") })
        assertEquals(listOf(BridgeForward.WARN_MESSAGE_REFUSED), sink.warnings)
        // Frames: the bucket refills by 64 K a frame, so a 100 K message goes two frames in three.
        sink.keepTexts = true
        var ticks = 0
        while (guard.pendingCount > 0 && ticks < 100) {
            frames.tick()
            ticks++
        }
        assertEquals(0, guard.pendingCount)
        assertEquals("drained over $ticks frames", 15, ticks)
        assertEquals(11L, guard.forwarded)
        assertEquals(0L, guard.pendingChars)
        assertEquals((2..11).toList(), forwardedIds())
    }

    @Test
    fun `a small call waits its turn behind a source's big messages instead of being refused for them`() {
        val limits = BridgeForward.Limits(frameChars = 64 * 1024, sourceChars = 1024 * 1024)
        val guard = guard(limits)
        sink.keepTexts = true
        // Trust Wallet's background (compat round 11b): store broadcasts of about 140 K chars
        // over a port, many a second, and its storage calls of about 100 chars between them.
        val payload = "x".repeat(140_000)
        fun port(id: Int) = """{"t":"portMsg","portId":"p1","id":$id,"data":"$payload","token":"tok","ep":"$EP"}"""
        for (id in 1..20) offer(guard, port(id))
        // The first went at once; seven more fit the source's chars; the rest were dropped silent.
        assertEquals(1L, guard.forwarded)
        assertEquals(7, guard.pendingCount)
        assertEquals(12L, guard.refused)
        assertTrue(replies.isEmpty())
        assertEquals(listOf(BridgeForward.WARN_MESSAGE_REFUSED), sink.warnings)
        // The storage calls arrive in the flood's shadow: none is refused for the broadcasts
        // ahead of it; each waits its turn.
        for (id in 21..30) offer(guard, call(id, "storage", "set", """{"k":"v$id"}"""))
        assertEquals(17, guard.pendingCount)
        assertEquals(12L, guard.refused)
        assertTrue(replies.isEmpty())
        // Another broadcast is still over the source's chars.
        offer(guard, port(31))
        assertEquals(13L, guard.refused)
        assertEquals(17, guard.pendingCount)
        // Drained in arrival order: a 140 K broadcast every two or three frames of a 64 K bucket,
        // the ten small calls together in the frame after the last broadcast.
        var ticks = 0
        while (guard.pendingCount > 0 && ticks < 200) {
            frames.tick()
            ticks++
        }
        assertEquals("drained over $ticks frames", 17, ticks)
        assertEquals(listOf(1) + (2..8) + (21..30), forwardedIds())
        assertEquals(0L, guard.pendingChars)
    }

    @Test
    fun `the count bound is a small message's only bound`() {
        val guard = guard(BridgeForward.Limits(sourceCount = 4))
        ready = false
        for (id in 1..6) offer(guard, call(id, "storage", "set", """{"k":"v$id"}"""))
        assertEquals(4, guard.pendingCount)
        assertEquals(2L, guard.refused)
        assertEquals(listOf(5, 6), replies.map { it.getInt("id") })
        assertTrue(replies.all { !it.getBoolean("ok") && it.getString("error") == BridgeForward.MESSAGE_REFUSED })
        ready = true
        frames.tick()
        assertEquals(0, guard.pendingCount)
        assertEquals(4L, guard.forwarded)
    }

    @Test
    fun `over the bound a coalescable arrival drops the oldest pending action state of its source`() {
        val guard = guard(BridgeForward.Limits(sourceCount = 3))
        sink.keepTexts = true
        // Distinct keys go at once while the source is idle and within the frame's budget: with
        // the chrome not ready, they wait instead, and the bound has something to hold.
        ready = false
        for (tab in 1..5) offer(guard, call(tab, "action", "setBadgeText", """{"text":"t$tab","tabId":$tab}"""))
        // Tabs 1, 2, 3 filled the bound; tab 4 pushed tab 1 out, tab 5 pushed tab 2 out.
        assertEquals(3, guard.pendingCount)
        assertEquals(2L, guard.dropped)
        assertEquals(listOf(1, 2), replies.map { it.getInt("id") })
        assertTrue(replies.all { !it.getBoolean("ok") && it.getString("error") == BridgeForward.STATE_DROPPED })
        // One console line for the run, not one per drop.
        assertEquals(listOf(BridgeForward.WARN_STATE_DROPPED), sink.warnings)
        // A message of another kind over the bound is refused, not made room for; its own line.
        offer(guard, call(6, "tabs", "query", """{}"""))
        assertEquals(1L, guard.refused)
        assertEquals(3, guard.pendingCount)
        assertEquals(6, replies.last().getInt("id"))
        assertEquals(BridgeForward.MESSAGE_REFUSED, replies.last().getString("error"))
        assertEquals(listOf(BridgeForward.WARN_STATE_DROPPED, BridgeForward.WARN_MESSAGE_REFUSED), sink.warnings)
        // A second drop within the same stretch of frames adds no line.
        offer(guard, call(7, "action", "setBadgeText", """{"text":"t7","tabId":7}"""))
        assertEquals(3L, guard.dropped)
        assertEquals(2, sink.warnings.size)
        ready = true
        frames.tick()
        assertEquals(listOf(4, 5, 7), forwardedIds())
        assertEquals(0, guard.pendingCount)
        // The same setters on a fresh frame while idle and within budget: distinct keys cross as
        // they come (the frame that drained tabs 4, 5 and 7 would hold a second value of theirs).
        frames.tick()
        for (tab in 1..5) offer(guard, call(10 + tab, "action", "setBadgeText", """{"text":"t$tab","tabId":$tab}"""))
        assertEquals(0, guard.pendingCount)
        assertEquals(listOf(4, 5, 7, 11, 12, 13, 14, 15), forwardedIds())
    }

    @Test
    fun `nothing crosses while the chrome is not ready, and what waited goes when it is`() {
        val guard = guard()
        sink.keepTexts = true
        ready = false
        offer(guard, call(1, "runtime", "getPlatformInfo", ""))
        offer(guard, call(2, "action", "setBadgeText", """{"text":"a"}"""))
        offer(guard, call(3, "action", "setBadgeText", """{"text":"b"}"""))
        assertEquals(0L, guard.forwarded)
        assertEquals(2, guard.pendingCount)
        frames.tick()
        frames.tick()
        assertEquals(0L, guard.forwarded)
        ready = true
        frames.tick()
        assertEquals(listOf(1, 3), sink.forwardedTexts.map { BridgeEnvelope.read(it)!!.getInt("id") })
        assertEquals(0, guard.pendingCount)
    }

    @Test
    fun `a port message over the bound is dropped without an answer, and a gone endpoint takes its queue with it`() {
        val guard = guard(BridgeForward.Limits(sourceCount = 2))
        ready = false
        fun port(id: Int, ep: String = EP) = """{"t":"portMsg","portId":"p1","id":$id,"data":"x","token":"tok","ep":"$ep"}"""
        for (id in 1..4) offer(guard, port(id))
        assertEquals(2, guard.pendingCount)
        assertEquals(2L, guard.refused)
        assertTrue(replies.isEmpty())
        assertEquals(1, sink.warnings.size)
        offer(guard, port(5, "other.ep"), "other.ep")
        assertEquals(3, guard.pendingCount)
        guard.forget(listOf(EP))
        assertEquals(1, guard.pendingCount)
        assertTrue(replies.isEmpty())
        guard.forgetExtension(EXT)
        assertEquals(0, guard.pendingCount)
        assertEquals(0L, guard.pendingChars)
        ready = true
        frames.tick()
        assertEquals(0L, guard.forwarded)
    }

    @Test
    fun `a call that is not in the engine's shape is nobody's action state`() {
        val guard = guard()
        sink.keepTexts = true
        // `args` without an object first: not a details object to fold on.
        offer(guard, """{"t":"call","id":1,"ns":"action","method":"setBadgeText","args":["a"],"token":"tok","ep":"$EP"}""")
        offer(guard, """{"t":"call","id":2,"ns":"action","method":"setBadgeText","args":["b"],"token":"tok","ep":"$EP"}""")
        // A tab id that is not a number: the core's error, one per call.
        offer(guard, call(3, "action", "setBadgeText", """{"text":"c","tabId":"nine"}"""))
        offer(guard, call(4, "action", "setBadgeText", """{"text":"d","tabId":"nine"}"""))
        frames.tick()
        assertEquals(listOf(1, 2, 3, 4), sink.forwardedTexts.map { BridgeEnvelope.read(it)!!.getInt("id") })
        assertEquals(0L, guard.superseded)
        assertNull(ActionCalls.detailsTabId(BridgeEnvelope.read(call(3, "action", "setBadgeText", """{"text":"c","tabId":"nine"}"""))!!, ""))
    }

    companion object {
        private const val EXT = "cppjkneekbjaeellbfkmgnhonkkjfpdn"
        private const val EP = "doc.nonce.cppjknee"
    }
}
