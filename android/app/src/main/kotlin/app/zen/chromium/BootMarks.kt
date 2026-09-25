package app.zen.chromium

import android.os.Process
import android.os.SystemClock

/**
 * The cold start's marks (OS-27): where the boot path's time goes, each as ms since the process
 * started (`Process.getStartUptimeMillis`), read as one `boot marks:` line in logcat at the
 * chrome's first real frame (MainActivity.onChromeReady) beside `am start -W`'s TotalTime and
 * the `Fully drawn` mark – the cold start pair tool tabulates their medians per build. A mark
 * is a long in a map: the first of a name stands (a recreated activity's boot does not overwrite
 * the process's), and the map is locked because the core's `boot` arrives on the bridge thread.
 *
 * The names, in the order a boot passes them: `app` (ZenApplication.onCreate done), `activity`
 * (MainActivity.onCreate begins), `host` (the Host built: its subsystems, the chrome's WebView),
 * `content` (setContentView done), `load` (the chrome's document asked for), `created` (onCreate
 * done), `boot` (the core's sync `boot` call answered), `ready` (`chrome.ready` heard), `frame`
 * (that frame confirmed drawn; the splash lifts, `reportFullyDrawn`).
 */
object BootMarks {
    private val processStart = Process.getStartUptimeMillis()
    private val marks = LinkedHashMap<String, Long>()

    /** The moment `name` was passed, if it has not been passed before. */
    @Synchronized
    fun mark(name: String) {
        if (!marks.containsKey(name)) marks[name] = SystemClock.uptimeMillis() - processStart
    }

    /** A number that is not a moment (WebView's own start-up timings), on the same line. */
    @Synchronized
    fun note(name: String, value: Long) {
        if (!marks.containsKey(name)) marks[name] = value
    }

    @Synchronized
    fun get(name: String): Long? = marks[name]

    /** `name=ms` pairs in the order passed, the log line's body. */
    @Synchronized
    fun line(): String = marks.entries.joinToString(" ") { "${it.key}=${it.value}" }

    private var logged = false

    /**
     * The line for the log, once per process: the marks are the process's first boot's (first
     * of a name), so a later activity's READY in the same process – the status bar driver's nine
     * boots, a relaunch – would print the same line again and read as a boot of its own. Null
     * after the first call.
     */
    @Synchronized
    fun lineOnce(): String? {
        if (logged) return null
        logged = true
        return line()
    }
}
