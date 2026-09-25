package app.zen.chromium

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Q1, the observable landing (the §11 stand-in rule), the host's half: `view.shown` is answered
 * `true` from the view's drawn frame after the placement batch has been applied, `false` at once
 * for a view the host does not have or does not show, and `false` at the bound when no frame
 * comes – each ask answered once.
 */
class PlacementAnswerTest {
    /** The views the fake host has, with whether each is shown (`View.VISIBLE`). */
    private val visible = HashMap<String, Boolean>()
    /** The frame callbacks armed and not yet fired, by tab. */
    private val frames = ArrayList<Pair<String, () -> Unit>>()
    /** The deadlines armed and not yet fired or disarmed. */
    private val deadlines = ArrayList<() -> Unit>()
    private val disarmed = ArrayList<() -> Unit>()

    private val answer = PlacementAnswer(
        showing = { tabId -> visible[tabId] == true },
        armFrame = { tabId, onFrame -> frames += tabId to onFrame },
        armDeadline = { onDeadline ->
            deadlines += onDeadline
            val disarm: () -> Unit = { deadlines.remove(onDeadline); disarmed += onDeadline }
            disarm
        }
    )

    private fun frame(tabId: String) {
        val due = frames.filter { it.first == tabId }
        frames.removeAll(due)
        for ((_, onFrame) in due) onFrame()
    }

    private fun deadline() {
        val due = ArrayList(deadlines)
        deadlines.clear()
        for (onDeadline in due) onDeadline()
    }

    @Test
    fun `a view the host does not have is answered false at once, with nothing armed`() {
        val replies = ArrayList<Boolean>()
        answer.answer("ghost") { replies += it }
        assertEquals(listOf(false), replies)
        assertEquals(0, frames.size)
        assertEquals(0, deadlines.size)
        assertEquals(1L, answer.refused)
        assertEquals(0L, answer.armed)
    }

    @Test
    fun `a view the host has but does not show is answered false at once too`() {
        visible["a"] = false
        val replies = ArrayList<Boolean>()
        answer.answer("a") { replies += it }
        assertEquals(listOf(false), replies)
        assertEquals(0, frames.size)
        assertEquals(1L, answer.refused)
    }

    @Test
    fun `a shown view is answered true from its drawn frame, and the deadline is disarmed`() {
        visible["a"] = true
        val replies = ArrayList<Boolean>()
        answer.answer("a") { replies += it }
        assertEquals(emptyList<Boolean>(), replies)
        assertEquals(1, frames.size)
        assertEquals(1, deadlines.size)

        frame("a")
        assertEquals(listOf(true), replies)
        assertEquals(0, deadlines.size)
        assertEquals(1, disarmed.size)
        assertEquals(1L, answer.armed)

        // The disarmed deadline never speaks.
        for (late in disarmed) late()
        assertEquals(listOf(true), replies)
    }

    @Test
    fun `no frame within the bound is answered false, once, and a late frame says nothing more`() {
        visible["a"] = true
        val replies = ArrayList<Boolean>()
        answer.answer("a") { replies += it }
        deadline()
        assertEquals(listOf(false), replies)
        frame("a")
        assertEquals(listOf(false), replies)
    }

    @Test
    fun `asks for two views are answered apart`() {
        visible["a"] = true
        visible["b"] = true
        val replies = ArrayList<String>()
        answer.answer("a") { replies += "a:$it" }
        answer.answer("b") { replies += "b:$it" }
        frame("b")
        assertEquals(listOf("b:true"), replies)
        deadline()
        assertEquals(listOf("b:true", "a:false"), replies)
    }

    /**
     * The order the chrome relies on (`views.ts` `askShown`): the placement batch and the ask
     * come off one port and are dispatched on the main thread one task each, in the order they
     * arrived, so the ask reads the visibility the batch set. The fake below is the real route
     * (`JsBridge.Calls.route`) over a one-thread main executor, as `BridgePort` feeds it.
     */
    @Test
    fun `routed after the batch that shows the view, the ask reads the visibility the batch set and answers from the frame`() {
        val mainThread = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main") }
        try {
            val dispatched = CopyOnWriteArrayList<String>()
            val replies = CopyOnWriteArrayList<String>()
            val calls = JsBridge.Calls(
                BridgeAdmission(192L * 1024 * 1024),
                storage = { false },
                main = { work -> mainThread.execute(work) },
                dispatch = { id, method, args ->
                    dispatched += "call $method"
                    if (method == "view.shown") answer.answer(args.getString("tabId")) { shown -> replies += "#$id $shown" }
                },
                dispatchStorage = { _, _, _ -> },
                dispatchOneWay = { method, args ->
                    dispatched += "batch $method"
                    if (method == "view.setVisible") visible[args.getString("tabId")] = args.getBoolean("visible")
                },
                reject = { id, message -> replies += "#$id rejected $message" },
                log = { _, _ -> }
            )
            visible["a"] = false
            // The page's order off the port: the placement batch, then the ask.
            calls.route(
                "[{\"method\":\"view.setBounds\",\"args\":{\"tabId\":\"a\",\"rect\":{\"x\":0,\"y\":56,\"width\":412,\"height\":800}}}," +
                    "{\"method\":\"view.setRadius\",\"args\":{\"tabId\":\"a\",\"radius\":12}}," +
                    "{\"method\":\"view.setVisible\",\"args\":{\"tabId\":\"a\",\"visible\":true}}]"
            )
            calls.route("{\"id\":9,\"method\":\"view.shown\",\"args\":{\"tabId\":\"a\"}}")
            val drained = CountDownLatch(1)
            mainThread.execute { drained.countDown() }
            assertTrue(drained.await(5, TimeUnit.SECONDS))

            assertEquals(
                listOf("batch view.setBounds", "batch view.setRadius", "batch view.setVisible", "call view.shown"),
                dispatched
            )
            // The ask found the view shown: a frame is armed, nothing answered yet.
            assertEquals(emptyList<String>(), replies)
            assertEquals(1, frames.size)
            frame("a")
            assertEquals(listOf("#9 true"), replies)
        } finally {
            mainThread.shutdownNow()
        }
    }

    @After
    fun clear() {
        frames.clear()
        deadlines.clear()
    }
}
