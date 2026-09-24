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

    @Synchronized
    fun get(name: String): Long? = marks[name]

    /** `name=ms` pairs in the order passed, the log line's body. */
    @Synchronized
    fun line(): String = marks.entries.joinToString(" ") { "${it.key}=${it.value}" }
}
