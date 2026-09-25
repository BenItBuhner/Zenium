package app.zen.chromium

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.SystemClock
import android.util.Log

/**
 * The platform's memory readings for [MemoryPressure] (OS-37): `ActivityManager.getMemoryInfo()`
 * read beside every trim ([onTrim]) and on its own every [MemoryPressure.POLL_MS] while the
 * window is up ([start] / [stop]) – the stand-in for the foreground trims API 34 no longer
 * delivers. Every grade goes to `onPressure` with a line for the log; the host sends it to the
 * core. One binder call per read; nothing runs until the chrome's READY ([Host] starts it there,
 * off the cold start's path).
 */
class MemoryPressureMonitor(
    context: Context,
    private val main: Handler,
    private val onPressure: (MemoryPressure.Level, String) -> Unit
) {
    private val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    private var polling = false
    private val poll = object : Runnable {
        override fun run() {
            if (!polling) return
            val info = read()
            MemoryPressure.ofMemoryInfo(info.availMem, info.threshold, info.lowMemory)
                ?.let { onPressure(it, "poll: ${describe(info)}") }
            main.postDelayed(this, MemoryPressure.POLL_MS)
        }
    }

    /** The window is up: read every [MemoryPressure.POLL_MS] from now. Idempotent. */
    fun start() {
        if (polling) return
        polling = true
        main.postDelayed(poll, MemoryPressure.POLL_MS)
    }

    /** The window left the screen: the trims are the signal from here. */
    fun stop() {
        polling = false
        main.removeCallbacks(poll)
    }

    /** Whether the poll runs (the harness reads it). */
    val running: Boolean get() = polling

    /** One trim as it arrived: the uptime, the raw level, the grade it carried (null: none). */
    data class Trim(val atUptimeMs: Long, val level: Int, val graded: MemoryPressure.Level?)

    private val record = ArrayDeque<Trim>()

    /**
     * The last [TRIMS_KEPT] trims the platform (or `am send-trim-memory`) delivered, oldest
     * first: what a boot actually hears, for the proof's findings and the log.
     */
    val trims: List<Trim> get() = record.toList()

    /**
     * `onTrimMemory(level)`: the grade the trim carries with the reading beside it
     * ([MemoryPressure.ofTrimWith]), sent to `onPressure`; null when the trim is not pressure.
     * Every trim goes on the record, graded or not.
     */
    fun onTrim(level: Int): MemoryPressure.Level? {
        val info = read()
        val graded = MemoryPressure.ofTrimWith(level, MemoryPressure.ofMemoryInfo(info.availMem, info.threshold, info.lowMemory))
        record.addLast(Trim(SystemClock.uptimeMillis(), level, graded))
        while (record.size > TRIMS_KEPT) record.removeFirst()
        val name = MemoryPressure.nameOf(level)
        val delivered = if (MemoryPressure.deliveredSinceApi34(level)) "" else " (not delivered by the platform since API 34)"
        if (graded != null) onPressure(graded, "trim $name$delivered: ${describe(info)}")
        else Log.i(TAG, "trim $name$delivered: not pressure (${describe(info)})")
        return graded
    }

    /** The reading as it stands now. */
    fun read(): ActivityManager.MemoryInfo = ActivityManager.MemoryInfo().also { activityManager.getMemoryInfo(it) }

    /** The reading in MB, for the log and the harness. */
    fun describe(info: ActivityManager.MemoryInfo): String =
        "avail ${info.availMem shr 20} MB of ${info.totalMem shr 20} MB, threshold ${info.threshold shr 20} MB" +
            if (info.lowMemory) ", low" else ""

    private companion object {
        const val TAG = "ZenHost"
        const val TRIMS_KEPT = 32
    }
}
