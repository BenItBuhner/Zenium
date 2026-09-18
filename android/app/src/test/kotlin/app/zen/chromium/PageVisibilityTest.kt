package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageVisibilityTest {
    private val applied = mutableListOf<String>()
    private val changes = mutableListOf<Long>()
    private val visibility = PageVisibility { tabId, visible, change ->
        applied += "$tabId:${if (visible) "show" else "hide"}"
        changes += change
    }

    @Test
    fun `a show is applied at once and nothing is left to arm`() {
        assertNull(visibility.request("a", true))
        assertEquals(listOf("a:show"), applied)
        assertEquals(0, visibility.pendingCount)
    }

    @Test
    fun `a hide waits for the chrome's frame`() {
        val ticket = visibility.request("a", false)
        assertNotNull(ticket)
        assertEquals(emptyList<String>(), applied)
        assertEquals(1, visibility.pendingCount)

        assertTrue(visibility.complete(ticket!!))
        assertEquals(listOf("a:hide"), applied)
        assertEquals(0, visibility.pendingCount)
    }

    @Test
    fun `the frame or the deadline, whichever comes first, hides once`() {
        val ticket = visibility.request("a", false)!!
        assertTrue(visibility.complete(ticket))
        assertFalse(visibility.complete(ticket))
        assertEquals(listOf("a:hide"), applied)
    }

    @Test
    fun `a show before the frame cancels the hide, so the page does not blink off`() {
        val ticket = visibility.request("a", false)!!
        assertNull(visibility.request("a", true))
        assertEquals(listOf("a:show"), applied)
        assertFalse(visibility.complete(ticket))
        assertEquals(listOf("a:show"), applied)
        assertEquals(0, visibility.pendingCount)
    }

    @Test
    fun `a stale ticket cannot hide a page a newer hide is waiting on`() {
        val first = visibility.request("a", false)!!
        visibility.request("a", true)
        val second = visibility.request("a", false)!!
        assertFalse(visibility.complete(first))
        assertEquals(listOf("a:show"), applied)
        assertTrue(visibility.complete(second))
        assertEquals(listOf("a:show", "a:hide"), applied)
    }

    @Test
    fun `a second hide while one is pending has nothing new to arm`() {
        val ticket = visibility.request("a", false)!!
        assertNull(visibility.request("a", false))
        assertEquals(1, visibility.pendingCount)
        assertTrue(visibility.complete(ticket))
        assertEquals(listOf("a:hide"), applied)
    }

    @Test
    fun `tabs wait independently of each other`() {
        val a = visibility.request("a", false)!!
        val b = visibility.request("b", false)!!
        assertEquals(2, visibility.pendingCount)
        assertTrue(visibility.complete(b))
        assertEquals(listOf("b:hide"), applied)
        assertTrue(visibility.complete(a))
        assertEquals(listOf("b:hide", "a:hide"), applied)
    }

    // --- the frame report: the chrome hears of each applied change once, and of a stale one never ---

    @Test
    fun `an applied change is reported once, for its frame or its deadline`() {
        visibility.request("a", true)
        assertEquals(1, visibility.unreportedCount)
        val change = changes.single()
        assertTrue(visibility.drawn("a", change))
        assertFalse(visibility.drawn("a", change))
        assertEquals(0, visibility.unreportedCount)
    }

    @Test
    fun `a hide's change is the one its frame reports`() {
        val ticket = visibility.request("a", false)!!
        assertEquals(0, visibility.unreportedCount)
        assertTrue(visibility.complete(ticket))
        assertTrue(visibility.drawn("a", changes.single()))
    }

    @Test
    fun `a change overtaken by a newer one to the same tab is not reported, the newer one is`() {
        visibility.request("a", true)
        val ticket = visibility.request("a", false)!!
        assertTrue(visibility.complete(ticket))
        assertEquals(listOf("a:show", "a:hide"), applied)
        assertEquals(1, visibility.unreportedCount)
        val (show, hide) = changes
        assertFalse(visibility.drawn("a", show))
        assertTrue(visibility.drawn("a", hide))
    }

    @Test
    fun `changes to different tabs are reported independently`() {
        visibility.request("a", true)
        visibility.request("b", true)
        val (a, b) = changes
        assertTrue(visibility.drawn("b", b))
        assertFalse(visibility.drawn("a", b))
        assertTrue(visibility.drawn("a", a))
        assertEquals(0, visibility.unreportedCount)
    }

    @Test
    fun `every applied change carries its own serial`() {
        visibility.request("a", true)
        visibility.request("a", true)
        assertEquals(2, changes.size)
        assertTrue(changes[1] > changes[0])
    }
}
