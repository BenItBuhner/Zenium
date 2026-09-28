package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

/** The count of an extension's configures between their request and their landing, read by the heap instrumentation. */
class ConfiguresInFlightTest {
    private val a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    @Test
    fun `nothing requested is nothing pending`() {
        val inFlight = ConfiguresInFlight()
        assertEquals(0, inFlight.pending(a))
    }

    @Test
    fun `a configure is pending from its request until its post lands`() {
        val inFlight = ConfiguresInFlight()
        inFlight.begun(a)
        assertEquals(1, inFlight.pending(a))
        inFlight.landed(a)
        assertEquals(0, inFlight.pending(a))
    }

    @Test
    fun `a re-plan requested while the first compile runs is a second pending configure until both land`() {
        val inFlight = ConfiguresInFlight()
        inFlight.begun(a)
        inFlight.begun(a)
        assertEquals(2, inFlight.pending(a))
        inFlight.landed(a)
        assertEquals(1, inFlight.pending(a))
        inFlight.landed(a)
        assertEquals(0, inFlight.pending(a))
    }

    @Test
    fun `extensions are counted apart`() {
        val inFlight = ConfiguresInFlight()
        inFlight.begun(a)
        assertEquals(1, inFlight.pending(a))
        assertEquals(0, inFlight.pending(b))
        inFlight.begun(b)
        inFlight.landed(a)
        assertEquals(0, inFlight.pending(a))
        assertEquals(1, inFlight.pending(b))
    }

    @Test
    fun `a reset lands everything in flight, and the posts that land after it count for nothing`() {
        val inFlight = ConfiguresInFlight()
        inFlight.begun(a)
        inFlight.begun(b)
        inFlight.reset()
        assertEquals(0, inFlight.pending(a))
        assertEquals(0, inFlight.pending(b))
        // The compiles the reset overtook still post (and drop as stale): no count below zero.
        inFlight.landed(a)
        assertEquals(0, inFlight.pending(a))
        inFlight.begun(a)
        assertEquals(1, inFlight.pending(a))
    }
}
