package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NTP-35, the second half of #563's mitigation (1): the boot's served new tab page is placed a
 * frame AFTER READY. While the gate is closed the placement ops of a view that serves the page
 * are held in their order and applied, once each and in that order, when the READY frame is
 * drawn (or the deadline passes); the gate then stays open. A view that serves anything else – a
 * restored page's, the phone's every view – is never held.
 */
class BootPlacementHoldTest {
    private val applied = ArrayList<String>()

    private fun op(name: String): () -> Unit = { applied.add(name) }

    @Test
    fun `a view that serves the new tab page is held while the gate is closed – any other view is not`() {
        val hold = BootPlacementHold()
        assertFalse(hold.open)
        assertTrue(hold.holds(serves = true))
        // The phone's views, a tablet's restored page: their placement is what READY waits for.
        assertFalse(hold.holds(serves = false))
    }

    @Test
    fun `held ops apply once, in the order they came, when the READY frame releases the gate`() {
        val hold = BootPlacementHold()
        // The first layout report's batch for the served view, then the ask behind it.
        assertTrue(hold.hold("ntp", op("setBounds ntp")))
        assertFalse(hold.hold("ntp", op("setVisible ntp")))
        assertFalse(hold.hold("ntp", op("shown ntp")))
        assertEquals(3, hold.heldCount)
        assertTrue(hold.heldFor("ntp"))
        assertFalse(hold.heldFor("other"))
        assertEquals(emptyList<String>(), applied)

        assertEquals(3, hold.release())
        assertEquals(listOf("setBounds ntp", "setVisible ntp", "shown ntp"), applied)
        assertTrue(hold.open)
        assertEquals(0, hold.heldCount)
        assertFalse(hold.heldFor("ntp"))
    }

    @Test
    fun `the first hold alone says so – the deadline is armed once`() {
        val hold = BootPlacementHold()
        assertTrue(hold.hold("a", op("a1")))
        assertFalse(hold.hold("a", op("a2")))
        assertFalse(hold.hold("b", op("b1")))
        assertEquals(3, hold.release())
        assertEquals(listOf("a1", "a2", "b1"), applied)
    }

    @Test
    fun `once open, nothing is held – a New Tab from the row is placed at once`() {
        val hold = BootPlacementHold()
        assertEquals(0, hold.release())
        assertTrue(hold.open)
        assertFalse(hold.holds(serves = true))
        // An op offered anyway is applied on the spot and arms no deadline.
        assertFalse(hold.hold("later", op("setVisible later")))
        assertEquals(listOf("setVisible later"), applied)
        assertEquals(0, hold.heldCount)
    }

    @Test
    fun `a second release applies nothing`() {
        val hold = BootPlacementHold()
        hold.hold("ntp", op("setBounds ntp"))
        assertEquals(1, hold.release())
        assertEquals(0, hold.release())
        assertEquals(listOf("setBounds ntp"), applied)
    }

    @Test
    fun `a boot with nothing served opens the gate with nothing to apply`() {
        // The phone's boot, a tablet's restored page: `chrome.ready` opens the gate at once.
        val hold = BootPlacementHold()
        assertEquals(0, hold.heldCount)
        assertEquals(0, hold.release())
        assertTrue(hold.open)
        assertEquals(emptyList<String>(), applied)
    }
}
