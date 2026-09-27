package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SweepOrderProbeTest {
    private val full = SweepOrderProbe.Legs(touched = 6, touchAttempts = 6, evaluated = 6, orderStarted = true, orderDone = true, burstStarted = true, burstDone = true)

    @Test
    fun `four legs in full and no fault - P`() {
        val word = SweepOrderProbe.word(full, runtimeFaults = 0)
        assertEquals("P", word.verdict)
        assertEquals("touched 6/6 (attempts 6), evaluated 6/6, order done, burst done", word.legs)
        assertNull(word.fingerNote)
    }

    @Test
    fun `a runtime-attributed fault is F whatever the legs did`() {
        assertEquals("F", SweepOrderProbe.word(full, runtimeFaults = 1).verdict)
        val short = full.copy(touched = 5, touchAttempts = 7)
        assertEquals("F", SweepOrderProbe.word(short, runtimeFaults = 2).verdict)
        assertNull(SweepOrderProbe.word(short, runtimeFaults = 2).fingerNote)
    }

    @Test
    fun `one finger lost with the script's six and the two legs done - P with the loss named`() {
        val legs = full.copy(touched = 5, touchAttempts = 7)
        assertTrue(SweepOrderProbe.oneFingerShortButWhole(legs))
        val word = SweepOrderProbe.word(legs, runtimeFaults = 0)
        assertEquals("P", word.verdict)
        assertEquals("touched 5/6 (attempts 7), evaluated 6/6, order done, burst done", word.legs)
        assertTrue(word.fingerNote!!.startsWith("one of the 6 fingers was lost to the harness (7 attempts;"))
        assertTrue(word.fingerNote!!.contains("landed 6/6"))
    }

    @Test
    fun `two fingers lost is PARTIAL`() {
        val legs = full.copy(touched = 4, touchAttempts = 8)
        assertFalse(SweepOrderProbe.oneFingerShortButWhole(legs))
        val word = SweepOrderProbe.word(legs, runtimeFaults = 0)
        assertEquals("PARTIAL", word.verdict)
        assertNull(word.fingerNote)
    }

    @Test
    fun `one finger lost with a script tap missing or a leg short is PARTIAL`() {
        assertEquals("PARTIAL", SweepOrderProbe.word(full.copy(touched = 5, touchAttempts = 7, evaluated = 5), 0).verdict)
        assertEquals("PARTIAL", SweepOrderProbe.word(full.copy(touched = 5, touchAttempts = 7, orderDone = false), 0).verdict)
        assertEquals("PARTIAL", SweepOrderProbe.word(full.copy(touched = 5, touchAttempts = 7, burstDone = false), 0).verdict)
    }

    @Test
    fun `the legs wording names a leg started but not done and one not started`() {
        val legs = full.copy(orderStarted = true, orderDone = false, burstStarted = false, burstDone = false)
        val word = SweepOrderProbe.word(legs, runtimeFaults = 0)
        assertEquals("PARTIAL", word.verdict)
        assertEquals("touched 6/6 (attempts 6), evaluated 6/6, order NOT done, burst not started", word.legs)
    }
}
