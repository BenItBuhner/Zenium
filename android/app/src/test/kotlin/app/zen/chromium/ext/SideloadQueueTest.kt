package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SideloadQueueTest {
    private fun handle(token: String) = JSONObject().put("token", token).put("name", "$token.crx").put("size", 12)

    private fun tokens(array: JSONArray): List<String> = (0 until array.length()).map { array.getJSONObject(it).getString("token") }

    @Test
    fun `the normal handover queues the handle, announces it, and a take drains at once`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = false)
        // The chrome hears extension.sideload for a landed package of the normal handover alone.
        assertTrue(queue.endImport(quiet = false, handle = handle("a")))
        assertEquals(1, queue.size)

        var taken: JSONArray? = null
        queue.take { taken = it }
        assertEquals(listOf("a"), tokens(taken!!))
        assertEquals(0, queue.size)

        // A second take finds the queue drained.
        var again: JSONArray? = null
        queue.take { again = it }
        assertEquals(0, again!!.length())
    }

    @Test
    fun `a failed copy queues nothing and is not announced`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = false)
        assertFalse(queue.endImport(quiet = false, handle = null))
        assertEquals(0, queue.size)
        var taken: JSONArray? = null
        queue.take { taken = it }
        assertEquals(0, taken!!.length())
    }

    @Test
    fun `a take asked while a quiet import is in flight waits for it and is answered with the handle`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = true)

        // The chrome's start() got to its take before the io thread's copy landed.
        var taken: JSONArray? = null
        queue.take { taken = it }
        assertNull("the take waits for the quiet import", taken)

        // The quiet handover is never announced: the chrome collects through start() alone.
        assertFalse(queue.endImport(quiet = true, handle = handle("q")))
        assertEquals(listOf("q"), tokens(taken!!))
        assertEquals(0, queue.size)
    }

    @Test
    fun `a quiet import that landed before the take is drained at once, without an announcement`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = true)
        assertFalse(queue.endImport(quiet = true, handle = handle("q")))
        var taken: JSONArray? = null
        queue.take { taken = it }
        assertEquals(listOf("q"), tokens(taken!!))
    }

    @Test
    fun `two takes waiting on one quiet import - the first drains, the second finds the queue empty`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = true)
        var first: JSONArray? = null
        var second: JSONArray? = null
        queue.take { first = it }
        queue.take { second = it }
        queue.endImport(quiet = true, handle = handle("q"))
        assertEquals(listOf("q"), tokens(first!!))
        assertEquals(0, second!!.length())
    }

    @Test
    fun `a waiting take is answered once every quiet import in flight has landed, with all of them`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = true)
        queue.beginImport(quiet = true)
        var taken: JSONArray? = null
        queue.take { taken = it }
        queue.endImport(quiet = true, handle = handle("one"))
        assertNull("one quiet import is still copying", taken)
        queue.endImport(quiet = true, handle = null)
        assertEquals(listOf("one"), tokens(taken!!))
    }

    @Test
    fun `a normal handover landing beside a quiet one is announced and rides along in the drained take`() {
        val queue = SideloadQueue()
        queue.beginImport(quiet = true)
        queue.beginImport(quiet = false)
        var taken: JSONArray? = null
        queue.take { taken = it }
        assertTrue(queue.endImport(quiet = false, handle = handle("n")))
        assertNull("the quiet import still holds the take", taken)
        assertEquals(1, queue.size)
        assertFalse(queue.endImport(quiet = true, handle = handle("q")))
        assertEquals(listOf("n", "q"), tokens(taken!!))
    }

    @Test
    fun `the extra's name is namespaced like the other driver flags`() {
        assertEquals("app.zen.chromium.extra.QUIET_HANDOVER", ExtensionStore.EXTRA_QUIET_HANDOVER)
    }
}
