package app.zen.chromium

import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_BACKGROUND
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_COMPLETE
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_MODERATE
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_RUNNING_CRITICAL
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_RUNNING_LOW
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_RUNNING_MODERATE
import app.zen.chromium.HostLifecycle.Companion.TRIM_MEMORY_UI_HIDDEN
import app.zen.chromium.MemoryPressure.Level
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryPressureTest {
    private val mb = 1L shl 20

    @Test
    fun `the levels are the core's, in rising order`() {
        assertEquals(listOf("moderate", "low", "critical"), Level.values().map { it.wire })
        assertTrue(Level.MODERATE < Level.LOW && Level.LOW < Level.CRITICAL)
    }

    @Test
    fun `the foreground trims grade by step`() {
        assertEquals(Level.MODERATE, MemoryPressure.ofTrim(TRIM_MEMORY_RUNNING_MODERATE))
        assertEquals(Level.LOW, MemoryPressure.ofTrim(TRIM_MEMORY_RUNNING_LOW))
        assertEquals(Level.CRITICAL, MemoryPressure.ofTrim(TRIM_MEMORY_RUNNING_CRITICAL))
    }

    @Test
    fun `the cached trims grade as Chrome's MemoryPressureMonitor grades them, stronger than the foreground's first rung`() {
        // BACKGROUND and MODERATE its middle grade (half), COMPLETE critical: the window is off
        // the screen and the process is the next one killed.
        assertEquals(Level.LOW, MemoryPressure.ofTrim(TRIM_MEMORY_BACKGROUND))
        assertEquals(Level.LOW, MemoryPressure.ofTrim(TRIM_MEMORY_MODERATE))
        assertEquals(Level.CRITICAL, MemoryPressure.ofTrim(TRIM_MEMORY_COMPLETE))
        assertTrue(
            "the cached family's first rung outranks the foreground's",
            MemoryPressure.ofTrim(TRIM_MEMORY_BACKGROUND)!!.ordinal > MemoryPressure.ofTrim(TRIM_MEMORY_RUNNING_MODERATE)!!.ordinal
        )
    }

    @Test
    fun `UI_HIDDEN and unknown levels are not pressure`() {
        assertNull(MemoryPressure.ofTrim(TRIM_MEMORY_UI_HIDDEN))
        assertNull(MemoryPressure.ofTrim(0))
        assertNull(MemoryPressure.ofTrim(99))
    }

    @Test
    fun `MemoryInfo grades low under two thresholds and critical on the system's word`() {
        val threshold = 200 * mb
        assertNull(MemoryPressure.ofMemoryInfo(availMem = 1_000 * mb, threshold = threshold, lowMemory = false))
        assertNull(MemoryPressure.ofMemoryInfo(availMem = 400 * mb, threshold = threshold, lowMemory = false))
        assertEquals(Level.LOW, MemoryPressure.ofMemoryInfo(availMem = 399 * mb, threshold = threshold, lowMemory = false))
        assertEquals(Level.LOW, MemoryPressure.ofMemoryInfo(availMem = 201 * mb, threshold = threshold, lowMemory = false))
        assertEquals(Level.CRITICAL, MemoryPressure.ofMemoryInfo(availMem = 150 * mb, threshold = threshold, lowMemory = true))
        // The system's word stands whatever the numbers say.
        assertEquals(Level.CRITICAL, MemoryPressure.ofMemoryInfo(availMem = 1_000 * mb, threshold = threshold, lowMemory = true))
        assertEquals(2L, MemoryPressure.LOW_FACTOR)
    }

    @Test
    fun `a threshold the platform did not fill in grades nothing but lowMemory`() {
        assertNull(MemoryPressure.ofMemoryInfo(availMem = 10 * mb, threshold = 0L, lowMemory = false))
        assertEquals(Level.CRITICAL, MemoryPressure.ofMemoryInfo(availMem = 10 * mb, threshold = 0L, lowMemory = true))
    }

    @Test
    fun `the higher of two readings, null only when both are`() {
        assertNull(MemoryPressure.higher(null, null))
        assertEquals(Level.LOW, MemoryPressure.higher(null, Level.LOW))
        assertEquals(Level.LOW, MemoryPressure.higher(Level.LOW, null))
        assertEquals(Level.CRITICAL, MemoryPressure.higher(Level.MODERATE, Level.CRITICAL))
        assertEquals(Level.CRITICAL, MemoryPressure.higher(Level.CRITICAL, Level.MODERATE))
        assertEquals(Level.LOW, MemoryPressure.higher(Level.LOW, Level.LOW))
    }

    @Test
    fun `a trim with the reading beside it takes the higher, a trim that is not pressure stays none`() {
        // A BACKGROUND trim on a device that is truly short is a critical, not a low.
        assertEquals(Level.CRITICAL, MemoryPressure.ofTrimWith(TRIM_MEMORY_BACKGROUND, Level.CRITICAL))
        assertEquals(Level.LOW, MemoryPressure.ofTrimWith(TRIM_MEMORY_BACKGROUND, null))
        assertEquals(Level.MODERATE, MemoryPressure.ofTrimWith(TRIM_MEMORY_RUNNING_MODERATE, null))
        assertEquals(Level.CRITICAL, MemoryPressure.ofTrimWith(TRIM_MEMORY_RUNNING_CRITICAL, Level.LOW))
        assertEquals(Level.LOW, MemoryPressure.ofTrimWith(TRIM_MEMORY_MODERATE, Level.MODERATE))
        // UI_HIDDEN on a busy device is still only the user leaving.
        assertNull(MemoryPressure.ofTrimWith(TRIM_MEMORY_UI_HIDDEN, Level.CRITICAL))
        assertNull(MemoryPressure.ofTrimWith(0, Level.LOW))
    }

    @Test
    fun `since API 34 the platform delivers UI_HIDDEN and BACKGROUND, nothing else`() {
        assertTrue(MemoryPressure.deliveredSinceApi34(TRIM_MEMORY_UI_HIDDEN))
        assertTrue(MemoryPressure.deliveredSinceApi34(TRIM_MEMORY_BACKGROUND))
        for (level in listOf(TRIM_MEMORY_RUNNING_MODERATE, TRIM_MEMORY_RUNNING_LOW, TRIM_MEMORY_RUNNING_CRITICAL, TRIM_MEMORY_MODERATE, TRIM_MEMORY_COMPLETE)) {
            assertFalse("level $level", MemoryPressure.deliveredSinceApi34(level))
        }
    }

    @Test
    fun `the trim levels are named for the log`() {
        assertEquals("RUNNING_CRITICAL", MemoryPressure.nameOf(TRIM_MEMORY_RUNNING_CRITICAL))
        assertEquals("BACKGROUND", MemoryPressure.nameOf(TRIM_MEMORY_BACKGROUND))
        assertEquals("level 7", MemoryPressure.nameOf(7))
    }

    @Test
    fun `the poll's cadence is the core's own sleep timer's`() {
        assertEquals(30_000L, MemoryPressure.POLL_MS)
    }
}
