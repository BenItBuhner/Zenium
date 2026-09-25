package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The attach epochs a configure's off-thread compile is checked against when it lands. */
class AttachEpochsTest {
    private val a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    @Test
    fun `a configure with nothing in between is current when it lands`() {
        val epochs = AttachEpochs()
        val noted = epochs.current(a)
        assertTrue(epochs.isCurrent(a, noted))
        // A reconfigure of the same attach (a re-plan) does not move the epoch either.
        assertEquals(noted, epochs.current(a))
    }

    @Test
    fun `a detach between the request and the post makes the configure stale`() {
        val epochs = AttachEpochs()
        val noted = epochs.current(a)
        epochs.detached(a)
        assertFalse(epochs.isCurrent(a, noted))
        assertNotEquals(noted, epochs.current(a))
    }

    @Test
    fun `a detach of another extension leaves the configure current`() {
        val epochs = AttachEpochs()
        val noted = epochs.current(a)
        epochs.detached(b)
        assertTrue(epochs.isCurrent(a, noted))
    }

    @Test
    fun `the epoch noted after a re-attach is fresh and a second detach moves it again`() {
        val epochs = AttachEpochs()
        val first = epochs.current(a)
        epochs.detached(a)
        val second = epochs.current(a)
        assertNotEquals(first, second)
        assertTrue(epochs.isCurrent(a, second))
        epochs.detached(a)
        assertFalse(epochs.isCurrent(a, second))
        assertFalse(epochs.isCurrent(a, first))
    }

    @Test
    fun `a reset makes every extension's outstanding configure stale`() {
        val epochs = AttachEpochs()
        val notedA = epochs.current(a)
        val notedB = epochs.current(b)
        epochs.reset()
        assertFalse(epochs.isCurrent(a, notedA))
        assertFalse(epochs.isCurrent(b, notedB))
        // The runtime that follows the reset notes fresh epochs, and they hold until the next move.
        val afterA = epochs.current(a)
        assertTrue(epochs.isCurrent(a, afterA))
        assertEquals(afterA, epochs.current(b))
    }

    @Test
    fun `a detach before a reset never comes back as current after it`() {
        val epochs = AttachEpochs()
        epochs.detached(a)
        val beforeReset = epochs.current(a)
        epochs.reset()
        assertFalse(epochs.isCurrent(a, beforeReset))
        epochs.detached(a)
        assertFalse(epochs.isCurrent(a, beforeReset))
    }
}
