package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The fixed pool of isolated worlds a tab WebView registers at construction. */
class WorldSlotsTest {
    private val a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    @Test
    fun `names map to the lowest free slots and stay mapped across reconfigures`() {
        val slots = WorldSlots(4)
        assertTrue(slots.assign(a, listOf("zenium-ext-$a")))
        assertEquals(0, slots.slot("zenium-ext-$a"))
        assertEquals(a, slots.owner(0))
        assertTrue(slots.assign(a, listOf("zenium-ext-$a", "zenium-ext-$a-user")))
        assertEquals(0, slots.slot("zenium-ext-$a"))
        assertEquals(1, slots.slot("zenium-ext-$a-user"))
        assertEquals(2, slots.free())
        assertEquals("zenium-w1", slots.worldName(1))
    }

    @Test
    fun `a reconfigure that drops a world gives its slot back`() {
        val slots = WorldSlots(2)
        assertTrue(slots.assign(a, listOf("zenium-ext-$a", "zenium-ext-$a-user")))
        assertEquals(0, slots.free())
        assertTrue(slots.assign(a, listOf("zenium-ext-$a")))
        assertNull(slots.slot("zenium-ext-$a-user"))
        assertEquals(1, slots.free())
        // The freed slot goes to the next extension.
        assertTrue(slots.assign(b, listOf("zenium-ext-$b")))
        assertEquals(1, slots.slot("zenium-ext-$b"))
        assertEquals(b, slots.owner(1))
    }

    @Test
    fun `a full pool refuses without changing anything`() {
        val slots = WorldSlots(1)
        assertTrue(slots.assign(a, listOf("zenium-ext-$a")))
        assertFalse(slots.assign(b, listOf("zenium-ext-$b")))
        assertNull(slots.slot("zenium-ext-$b"))
        assertEquals(a, slots.owner(0))
        // Swapping one world for another inside the budget still works.
        assertTrue(slots.assign(a, listOf("zenium-ext-$a-user")))
        assertEquals(0, slots.slot("zenium-ext-$a-user"))
        assertNull(slots.slot("zenium-ext-$a"))
    }

    @Test
    fun `a name another extension holds is not taken over`() {
        val slots = WorldSlots(4)
        assertTrue(slots.assign(a, listOf("shared")))
        assertFalse(slots.assign(b, listOf("shared", "zenium-ext-$b")))
        assertNull(slots.slot("zenium-ext-$b"))
        assertEquals(a, slots.owner(0))
    }

    @Test
    fun `detach releases every slot of the extension and clear empties the pool`() {
        val slots = WorldSlots(3)
        assertTrue(slots.assign(a, listOf("zenium-ext-$a", "zenium-ext-$a-user")))
        assertTrue(slots.assign(b, listOf("zenium-ext-$b")))
        slots.releaseAll(a)
        assertEquals(2, slots.free())
        assertNull(slots.slot("zenium-ext-$a"))
        assertEquals(2, slots.slot("zenium-ext-$b"))
        slots.clear()
        assertEquals(3, slots.free())
        assertNull(slots.owner(2))
    }

    @Test
    fun `slot world names are distinct and stable`() {
        val slots = WorldSlots(16)
        val names = (0 until 16).map(slots::worldName)
        assertEquals(16, names.toSet().size)
        assertNotEquals(names[0], names[15])
        assertEquals(names[3], WorldSlots(16).worldName(3))
    }
}
