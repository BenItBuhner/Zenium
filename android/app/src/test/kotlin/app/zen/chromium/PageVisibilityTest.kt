package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageVisibilityTest {
    private val applied = mutableListOf<String>()
    private val visibility = PageVisibility { tabId, visible -> applied += "$tabId:${if (visible) "show" else "hide"}" }

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
}
