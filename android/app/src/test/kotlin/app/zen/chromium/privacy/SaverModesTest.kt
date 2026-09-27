package app.zen.chromium.privacy

import android.net.ConnectivityManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The system's saver modes as Chrome Android maps them for its preloading (OS-21):
 * `DataSaverOSSetting.isDataSaverEnabled` (metered AND restrict-background ENABLED),
 * `BatterySaverOSSetting.isBatterySaverEnabled` (`isPowerSaveMode`), folded in
 * `IsSomePreloadingEnabled`'s order (`preloading_prefs.cc:60-77`), and read once a second.
 */
class SaverModesTest {
    private val enabled = ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    private val whitelisted = ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED
    private val disabled = ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED

    private fun state(metered: Boolean, status: Int, powerSave: Boolean) =
        SaverRules.stateOf({ metered }, { status }, { powerSave })

    @Test
    fun `data saver is the restriction on a metered network alone`() {
        assertEquals(SaverState.DATA_SAVER, state(metered = true, status = enabled, powerSave = false))
        // An unmetered network under the same setting: Chrome reads no Data Saver.
        assertEquals(SaverState.NONE, state(metered = false, status = enabled, powerSave = false))
        // The user allowlisted this app for unrestricted data: not restricted, so not Data Saver.
        assertEquals(SaverState.NONE, state(metered = true, status = whitelisted, powerSave = false))
        assertEquals(SaverState.NONE, state(metered = true, status = disabled, powerSave = false))
    }

    @Test
    fun `battery saver is the power manager's word`() {
        assertEquals(SaverState.BATTERY_SAVER, state(metered = false, status = disabled, powerSave = true))
        assertEquals(SaverState.BATTERY_SAVER, state(metered = true, status = whitelisted, powerSave = true))
        assertEquals(SaverState.NONE, state(metered = true, status = disabled, powerSave = false))
    }

    @Test
    fun `data saver is named first when both are on`() {
        assertEquals(SaverState.DATA_SAVER, state(metered = true, status = enabled, powerSave = true))
    }

    @Test
    fun `only the saver states refuse preloading`() {
        assertFalse(SaverState.NONE.refusesPreloading)
        assertTrue(SaverState.DATA_SAVER.refusesPreloading)
        assertTrue(SaverState.BATTERY_SAVER.refusesPreloading)
    }

    @Test
    fun `the readers are asked in Chrome's order and no further than needed`() {
        val asked = mutableListOf<String>()
        // Unmetered: the restrict-background status is never asked (DataSaverOSSetting.java:25-29).
        assertEquals(
            SaverState.NONE,
            SaverRules.stateOf(
                { asked += "metered"; false },
                { asked += "status"; enabled },
                { asked += "power"; false }
            )
        )
        assertEquals(listOf("metered", "power"), asked)

        asked.clear()
        // Data Saver on: the power manager is never asked (preloading_prefs.cc:68-73).
        assertEquals(
            SaverState.DATA_SAVER,
            SaverRules.stateOf(
                { asked += "metered"; true },
                { asked += "status"; enabled },
                { asked += "power"; true }
            )
        )
        assertEquals(listOf("metered", "status"), asked)
    }

    @Test
    fun `a reading stands for a second, then the system is asked again`() {
        var now = 10_000L
        var powerSave = false
        var reads = 0
        val modes = SaverModes(
            metered = { false },
            restrictBackgroundStatus = { disabled },
            powerSaveMode = { reads++; powerSave },
            now = { now }
        )

        assertEquals(SaverState.NONE, modes.state())
        assertEquals(1, reads)

        // The mode turns on: within the second the reading stands, as Chrome's cached one does.
        powerSave = true
        now += SaverModes.TTL_MS - 1
        assertEquals(SaverState.NONE, modes.state())
        assertEquals(SaverState.NONE, modes.state())
        assertEquals(1, reads)

        // The second is over: read again, and the new reading stands for the next one.
        now += 1
        assertEquals(SaverState.BATTERY_SAVER, modes.state())
        assertEquals(2, reads)
        powerSave = false
        now += SaverModes.TTL_MS / 2
        assertEquals(SaverState.BATTERY_SAVER, modes.state())
        assertEquals(2, reads)
        now += SaverModes.TTL_MS
        assertEquals(SaverState.NONE, modes.state())
        assertEquals(3, reads)
    }

    @Test
    fun `the first request reads the system, whatever the clock says`() {
        var reads = 0
        val modes = SaverModes({ reads++; true }, { enabled }, { false }, { 0L })
        assertEquals(SaverState.DATA_SAVER, modes.state())
        assertEquals(1, reads)
        // The same instant again: cached.
        assertEquals(SaverState.DATA_SAVER, modes.state())
        assertEquals(1, reads)
    }

    @Test
    fun `a system service that fails to answer reads as NONE, warned not thrown, and the answer stands for the second`() {
        var now = 0L
        var reads = 0
        val failure = IllegalStateException("the connectivity service did not answer")
        val warned = mutableListOf<Throwable>()
        val modes = SaverModes(
            metered = { reads++; throw failure },
            restrictBackgroundStatus = { enabled },
            // The power manager would say Battery Saver: a failed reading is NONE, not the other reader's word.
            powerSaveMode = { true },
            now = { now },
            warn = { warned += it },
        )

        assertEquals(SaverState.NONE, modes.state())
        assertEquals(listOf<Throwable>(failure), warned)
        assertEquals(1, reads)

        // The failed reading is cached like any other; the next second asks again.
        now += SaverModes.TTL_MS - 1
        assertEquals(SaverState.NONE, modes.state())
        assertEquals(1, reads)
        now += 1
        assertEquals(SaverState.NONE, modes.state())
        assertEquals(2, reads)
        assertEquals(2, warned.size)
    }
}
