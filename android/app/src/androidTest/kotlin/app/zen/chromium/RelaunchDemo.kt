package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * The relaunch tab-loss race (#344 finding 5; the nightly's `status-bar` late write, `read-aloud`
 * §3.2). A relaunch of the browser's activity over the running one – the harness's own
 * [launch]: `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK`, the kind H-2's log has – tears
 * the old `Host` down while the new chrome boots in the same process. The old core used to read
 * the teardown's `destroyed` per tab as a page closing itself, close every tab and write the
 * tab-less session over the profile the new core was booting from, on a storage thread the
 * teardown did not stop: the seeded tab gone, "This space is empty".
 *
 * The driver seeds one tab on a loopback page and relaunches [relaunches] times in a row. Per
 * relaunch it notes, as findings that fail nothing: whether the seeded tab is in the new core's
 * session and its page live again, whether `state.json` on disk still holds it once the old
 * core's straggle window has passed, when the old host closed its storage and whether the old
 * activity was destroyed, and every `ZenStorage` line the run logged since the launch (the old
 * host's close marker; each write it refused as coming from a destroyed or superseded host – the
 * writes that used to be the late ones). The claims over the set: the tab survived every
 * relaunch, the disk held it after every relaunch, and every relaunch closed the old host's
 * storage. With `-e assert true` the run fails when a claim did not hold; without it, it only
 * reports. `-e relaunches N` sets the count.
 *
 * Stills land as `android-relaunch-race-<scene>.png`; the findings in `android-relaunch-race-notes.txt`.
 */
@RunWith(AndroidJUnit4::class)
class RelaunchDemo : MediaDemoBase("android-relaunch-race") {
    override val tag = "RelaunchDemo"
    private val assertive = InstrumentationRegistry.getArguments().getString("assert") == "true"
    private val relaunches = InstrumentationRegistry.getArguments().getString("relaunches")?.toIntOrNull()?.coerceIn(1, 30) ?: RELAUNCHES
    private var checks = 0
    private var failures = 0
    private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    @Test
    fun record() {
        server = DemoServer(PORT, mapOf("/page" to ("text/html; charset=utf-8" to PAGE.toByteArray()))).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        Log.i(tag, "$checks checks, $failures failed (assert=$assertive)")
        if (assertive) assertEquals("claims that did not hold (see android-relaunch-race-notes.txt)", 0, failures)
    }

    /** The media demos' profile with its one tab on this demo's page, the hints shown, the scheme from the run. */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "http://127.0.0.1:$PORT/page")
                tab.put("title", "Zenium relaunch demo")
            }
        }
        state.getJSONObject("settings")
            .put("colorScheme", THEME)
            .put("gestureHintDone", true)
            .put("fullscreenHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        notes = File(out, "android-relaunch-race-notes.txt")
        val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"
        notes.writeText(
            "Zenium Android relaunch race (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, app $version)\n\n"
        )
        note("demo server: ${server.selfCheck()}")
        waitTitle(TAB, 20_000) { it.startsWith("RL|") }
        note("seeded tab: ${describeTab(TAB)}")
        note(
            "relaunches: $relaunches, each the harness's launch over the running activity " +
                "(FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK: the old host torn down while the new chrome boots)"
        )
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("seeded")
        var survived = 0
        var onDisk = 0
        var closed = 0
        var refusals = 0
        for (i in 1..relaunches) {
            val outcome = relaunchOnce(i)
            if (outcome.survived) survived++
            if (outcome.onDisk) onDisk++
            if (outcome.storageClosed) closed++
            refusals += outcome.refusals
            shot("relaunch-$i")
        }
        note("")
        check("the seeded tab survived every relaunch ($survived of $relaunches)", survived == relaunches)
        check("state.json on disk held the seeded tab after every relaunch ($onDisk of $relaunches)", onDisk == relaunches)
        check("every relaunch closed the old host's storage with it ($closed of $relaunches)", closed == relaunches)
        note(
            "  writes refused as a destroyed or superseded host's over the run: $refusals " +
                "(each one a write that would have been the late one; with the teardown signal the old core normally asks for none)"
        )
        note("\nend: $checks checks, $failures failed")
    }

    private class Outcome(val survived: Boolean, val onDisk: Boolean, val storageClosed: Boolean, val refusals: Int)

    /**
     * One relaunch over the running activity, then the findings: the old activity's destroy
     * timed by its storage's close marker in the log (logged from `Host.destroy`, 2 ms before
     * the activity's DESTROYED in the record run), the new core's session and page, the profile
     * on disk once the old core's straggle window (a write 1.4 s after DESTROYED in H-2's log)
     * has passed, and the storage log since the launch.
     */
    private fun relaunchOnce(i: Int): Outcome {
        note("\n[relaunch $i]")
        val old = activity as MainActivity
        val oldHost = old.host
        val launchedWall = System.currentTimeMillis()
        launch()
        val destroyed = poll(15_000) { old.isDestroyed }
        ensureForeground()
        val chromeUp = poll(20_000) { chromeJs("typeof window.zen") == "\"object\"" }
        // The old core's last word came 1.4 s after DESTROYED in H-2's log; give it twice that,
        // and the new core its first writes, before the disk is read.
        SystemClock.sleep(3_000)
        val tab = coreState().getJSONObject("tabs").optJSONObject(TAB)
        val live = tab != null && poll(15_000) { title().startsWith("RL|") }
        val state = File(app.filesDir, "zen/state.json")
        val diskHasTab = tabOnDisk(state)
        val storageClosed = oldHost.storage.isClosed
        val lines = storageLogSince(launchedWall)
        // A refusal reads `refused <name>: <why>`; the close marker says "are refused from here" and is not one.
        val refusals = lines.count { REFUSAL.containsMatchIn(it) }
        val closedAt = lines.firstOrNull { CLOSE_MARKER.containsMatchIn(it) }?.let(::logTime)
        note(
            "  old activity destroyed: $destroyed; its storage closed: $storageClosed" +
                (if (closedAt != null) " at ${clock.format(Date(closedAt))}, ${closedAt - launchedWall} ms after the launch" else " (no close marker in the log since the launch)") +
                "; new chrome up: $chromeUp"
        )
        note("  finding: seeded tab survived relaunch $i: ${if (tab != null) "yes" else "no"} (${describeTab(TAB)}; page ${if (live) "live" else "not live"})")
        note(
            "  finding: state.json on disk holds the seeded tab: ${if (diskHasTab) "yes" else "no"} " +
                "(${state.length()} B, modified at ${clock.format(Date(state.lastModified()))}" +
                (if (closedAt != null) ", ${state.lastModified() - closedAt} ms after the old host closed its storage" else "") +
                "; a write landing after the close is the new host's by the lease)"
        )
        note(
            "  storage log since the launch: ${lines.size} line(s), $refusals write(s) refused" +
                (if (lines.isEmpty()) "" else "\n" + lines.joinToString("\n") { "    $it" })
        )
        return Outcome(tab != null, diskHasTab, storageClosed, refusals)
    }

    /** Whether the profile's `state.json` names the seeded tab among its tabs. */
    private fun tabOnDisk(state: File): Boolean = runCatching {
        val tabs = JSONObject(state.readText()).getJSONArray("tabs")
        (0 until tabs.length()).any { tabs.getJSONObject(it).optString("id") == TAB }
    }.getOrDefault(false)

    /**
     * Every `ZenStorage` line (the storage's close marker and its refusals) logged since `wall`
     * (epoch ms, a second's slack for the log's clock), oldest first. Chosen by the line's own
     * time rather than by a count of lines, so a log buffer that turned over under the run
     * loses nothing but old lines.
     */
    private fun storageLogSince(wall: Long): List<String> =
        shellCommand("logcat -d -v time -s ZenStorage:*").lines().map { it.trim() }
            .filter { it.contains("ZenStorage") && (logTime(it) ?: Long.MAX_VALUE) >= wall - 1_000 }

    /** The epoch ms of a `logcat -v time` line's stamp (`MM-dd HH:mm:ss.SSS`, the device's zone, this year), or null. */
    private fun logTime(line: String): Long? {
        if (line.length < 18) return null
        val year = Calendar.getInstance().get(Calendar.YEAR)
        return runCatching { logStamp.parse("$year-${line.substring(0, 18)}")?.time }.getOrNull()
    }

    private val logStamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    private fun check(claim: String, holds: Boolean) {
        checks++
        if (!holds) failures++
        note("  ${if (holds) "PASS" else "FAIL"}: $claim")
    }

    companion object {
        /** Relaunches per run: enough for a race that used to take one boot in ten (the status-bar nightly) to show. */
        const val RELAUNCHES = 8
        /** A `ZenStorage` refusal: `W/ZenStorage( pid): refused <name>: <why>` (`Storage.refused`). */
        private val REFUSAL = Regex("""ZenStorage\(\s*\d+\): refused \S+: """)
        /** A `ZenStorage` close marker: `W/ZenStorage( pid): closed: writes from this host are refused from here` (`Storage.close`). */
        private val CLOSE_MARKER = Regex("""ZenStorage\(\s*\d+\): closed: """)
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /** The seeded tab's page: a title the driver can tell (`RL|`) and a line saying when it loaded. */
        private val PAGE = """
            <!doctype html><html><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1"><title>RL|ready</title>
            <style>body{font:20px system-ui,sans-serif;margin:0;padding:48px 24px;background:#f4f7f5;color:#1b2b26}
            h1{font-size:28px;margin:0 0 12px}p{margin:0 0 8px}</style></head>
            <body><h1>Zenium relaunch demo</h1>
            <p>The seeded tab. It is meant to be here after every relaunch.</p><p id="n"></p>
            <script>document.getElementById('n').textContent='loaded at '+new Date().toISOString()</script>
            </body></html>
        """.trimIndent()
    }
}
