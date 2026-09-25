package app.zen.chromium

/**
 * The host's grading of the platform's memory signals into the core's three levels (OS-37):
 * the core sleeps the hidden pages shown longest ago – a quarter of what may sleep at
 * `moderate`, half at `low`, all of it at `critical` (`src/core/memoryPressure.ts`). Free of
 * Android types so it runs under plain JUnit ([MemoryPressureTest]); [MemoryPressureMonitor]
 * reads the platform and [Host.onTrimMemory] acts.
 *
 * Two signals feed it. `ComponentCallbacks2.onTrimMemory` grades by the table in [ofTrim]: in
 * the foreground RUNNING_MODERATE / LOW / CRITICAL are the device beginning to run low, short,
 * and killing background processes (the foreground next once it leaves the screen) – graded a
 * quarter, a half, all, the shares Chrome's `BindingManager.onTrimMemory` un-protects of its
 * background renderers at those three. On the system's cached list MODERATE / COMPLETE were the
 * process in the middle and at the end of it under a short system (the legacy trim, API 33 and
 * before: `AppProfiler.updateLowMemStateLSP`) – a half, all. BACKGROUND is NOT pressure on its
 * own: since API 34 it is the one trim the platform still delivers to a running app besides
 * UI_HIDDEN (the RUNNING_* levels and MODERATE / COMPLETE are deprecated "not notified since
 * API 34"), and it comes at every transition into the cached state (`OomAdjuster`,
 * `USE_MODERN_TRIM`) – an app switch, with no shortage implied. A page slept on it would be a
 * reload for nothing on the return; Chrome discards nothing on BACKGROUND either. UI_HIDDEN is
 * the user leaving, nothing more, and a level the table does not know grades nothing. What
 * either arrival IS is a moment to read the second signal (the coordinator's ruling, round 2).
 *
 * That signal is `ActivityManager.getMemoryInfo()`, the stand-in for the grades the platform no
 * longer sends: `lowMemory` (`availMem` under the system's `threshold`, the point at which it
 * starts killing background processes – RUNNING_CRITICAL's word) grades `critical`; `availMem`
 * under [LOW_FACTOR] times the threshold grades `low`. [MemoryPressureMonitor] reads it beside
 * every trim and every [POLL_MS] while the window is up, and the higher of the two is what the
 * core hears ([ofTrimWith], [higher]): a trim that is not pressure on its own lets the reading
 * stand, so a BACKGROUND on a device that is truly short is the reading's `low` or `critical`,
 * and on one that is not, nothing. Away from the screen the core takes the plan in one pass
 * rather than in batches (`Host.onMemoryPressure`, `background`). What holds at every level
 * holds here too: the recency guard and the exemptions, the never-sleep list until `critical`.
 *
 * `am send-trim-memory` (the proof's tool) delivers any level on any API; what the platform
 * itself delivered on a boot is on the monitor's record ([MemoryPressureMonitor.trims]).
 * Chrome's `MemoryPressureMonitor.java` grades the same trims for its own caches (COMPLETE and
 * RUNNING_CRITICAL critical; BACKGROUND and MODERATE its middle grade – caches purged, nothing
 * the user sees; RUNNING_LOW, RUNNING_MODERATE and UI_HIDDEN nothing) and re-reads
 * `getMyMemoryState().lastTrimLevel` a minute on to see whether the pressure holds; Zenium's
 * renderer is one process shared by every page and the chrome, so the pages themselves are what
 * there is to give back, and the `MemoryInfo` poll is that re-read.
 */
object MemoryPressure {
    /** The core's grades (`HostEventPayloads['memoryPressure'].level`), in rising order. */
    enum class Level(val wire: String) { MODERATE("moderate"), LOW("low"), CRITICAL("critical") }

    /**
     * The grade a trim at `level` carries on its own; null where the trim is not pressure –
     * UI_HIDDEN, BACKGROUND (the app switch) and a level the table does not know.
     */
    fun ofTrim(level: Int): Level? = when (level) {
        HostLifecycle.TRIM_MEMORY_RUNNING_MODERATE -> Level.MODERATE
        HostLifecycle.TRIM_MEMORY_RUNNING_LOW -> Level.LOW
        HostLifecycle.TRIM_MEMORY_RUNNING_CRITICAL -> Level.CRITICAL
        HostLifecycle.TRIM_MEMORY_MODERATE -> Level.LOW
        HostLifecycle.TRIM_MEMORY_COMPLETE -> Level.CRITICAL
        else -> null
    }

    /**
     * What `ActivityManager.MemoryInfo` says on its own: `lowMemory` is the system's word that it
     * is short ([Level.CRITICAL]); free memory under [LOW_FACTOR] thresholds is the approach to it
     * ([Level.LOW]); a threshold the platform did not fill in (0) grades nothing but `lowMemory`.
     */
    fun ofMemoryInfo(availMem: Long, threshold: Long, lowMemory: Boolean): Level? = when {
        lowMemory -> Level.CRITICAL
        threshold > 0 && availMem < threshold * LOW_FACTOR -> Level.LOW
        else -> null
    }

    /** The higher of two readings; null only when both are. */
    fun higher(a: Level?, b: Level?): Level? = when {
        a == null -> b
        b == null -> a
        else -> if (a.ordinal >= b.ordinal) a else b
    }

    /**
     * The grade a trim at `level` carries with the `MemoryInfo` reading beside it: the higher of
     * the two. A trim that is not pressure on its own (BACKGROUND, UI_HIDDEN) lets the reading
     * stand – the arrival is the moment the device was asked, and a device that is short says so
     * through the reading whatever the trim was; one that is not grades nothing.
     */
    fun ofTrimWith(level: Int, memoryInfo: Level?): Level? = higher(ofTrim(level), memoryInfo)

    /** Whether the platform still delivers a trim at `level` to a running app on API 34 and later. */
    fun deliveredSinceApi34(level: Int): Boolean =
        level == HostLifecycle.TRIM_MEMORY_UI_HIDDEN || level == HostLifecycle.TRIM_MEMORY_BACKGROUND

    /** The trim level's name, for the log. */
    fun nameOf(level: Int): String = when (level) {
        HostLifecycle.TRIM_MEMORY_RUNNING_MODERATE -> "RUNNING_MODERATE"
        HostLifecycle.TRIM_MEMORY_RUNNING_LOW -> "RUNNING_LOW"
        HostLifecycle.TRIM_MEMORY_RUNNING_CRITICAL -> "RUNNING_CRITICAL"
        HostLifecycle.TRIM_MEMORY_UI_HIDDEN -> "UI_HIDDEN"
        HostLifecycle.TRIM_MEMORY_BACKGROUND -> "BACKGROUND"
        HostLifecycle.TRIM_MEMORY_MODERATE -> "MODERATE"
        HostLifecycle.TRIM_MEMORY_COMPLETE -> "COMPLETE"
        else -> "level $level"
    }

    /** Free memory under this many thresholds reads as `low`. */
    const val LOW_FACTOR = 2L

    /**
     * The `MemoryInfo` poll's cadence while the window is up: one binder read every half minute,
     * the core's own sleep timer's cadence (`SLEEP_CHECK_MS`). Started at the chrome's READY (off
     * the cold start's path) and at every return to the screen; stopped as the window leaves it
     * – away, the trims are the signal.
     */
    const val POLL_MS = 30_000L
}
