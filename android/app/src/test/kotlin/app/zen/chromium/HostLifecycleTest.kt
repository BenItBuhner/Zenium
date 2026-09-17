package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostLifecycleTest {
    private var now = 1_000_000L
    private val lifecycle = HostLifecycle { now }

    @Test
    fun `the first renderer loss is repaired at once`() {
        assertEquals(0L, lifecycle.chromeRebuildDelayMs())
        assertEquals(0, lifecycle.consecutiveRapidRebuilds)
    }

    @Test
    fun `a chrome that keeps dying is retried with a doubling, capped delay`() {
        lifecycle.chromeRebuildDelayMs()
        val delays = (1..6).map {
            now += 2_000
            lifecycle.chromeRebuildDelayMs()
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L), delays)
        assertEquals(6, lifecycle.consecutiveRapidRebuilds)
    }

    @Test
    fun `a chrome that stayed up past the window resets the escalation`() {
        lifecycle.chromeRebuildDelayMs()
        now += 2_000
        assertEquals(1_000L, lifecycle.chromeRebuildDelayMs())
        now += HostLifecycle.RAPID_WINDOW_MS
        assertEquals(0L, lifecycle.chromeRebuildDelayMs())
        assertEquals(0, lifecycle.consecutiveRapidRebuilds)
        now += 2_000
        assertEquals(1_000L, lifecycle.chromeRebuildDelayMs())
    }

    @Test
    fun `a loss exactly at the edge of the window is not rapid`() {
        lifecycle.chromeRebuildDelayMs()
        now += HostLifecycle.RAPID_WINDOW_MS
        assertEquals(0L, lifecycle.chromeRebuildDelayMs())
    }

    @Test
    fun `a visible chrome document needs no repair`() {
        assertEquals(HostLifecycle.Repair.NONE, lifecycle.repairAfterProbe("visible", 0))
        assertEquals(HostLifecycle.Repair.NONE, lifecycle.repairAfterProbe("visible", 1))
    }

    @Test
    fun `a hidden chrome document is re-attached once, then rebuilt`() {
        assertEquals(HostLifecycle.Repair.REATTACH, lifecycle.repairAfterProbe("hidden", 0))
        assertEquals(HostLifecycle.Repair.REBUILD, lifecycle.repairAfterProbe("hidden", 1))
        assertEquals(HostLifecycle.Repair.REATTACH, lifecycle.repairAfterProbe("prerender", 0))
    }

    @Test
    fun `a renderer that does not answer is asked once more, then replaced`() {
        assertEquals(HostLifecycle.Repair.RETRY, lifecycle.repairAfterProbe(null, 0))
        assertEquals(HostLifecycle.Repair.REBUILD, lifecycle.repairAfterProbe(null, 1))
        assertEquals(HostLifecycle.Repair.REBUILD, lifecycle.repairAfterProbe(null, 2))
    }

    @Test
    fun `only trims at background level or beyond drop the back previews`() {
        assertFalse(HostLifecycle.trimDropsSnapshots(HostLifecycle.TRIM_MEMORY_UI_HIDDEN))
        assertFalse(HostLifecycle.trimDropsSnapshots(HostLifecycle.TRIM_MEMORY_BACKGROUND - 1))
        assertTrue(HostLifecycle.trimDropsSnapshots(HostLifecycle.TRIM_MEMORY_BACKGROUND))
        assertTrue(HostLifecycle.trimDropsSnapshots(80))
    }
}
