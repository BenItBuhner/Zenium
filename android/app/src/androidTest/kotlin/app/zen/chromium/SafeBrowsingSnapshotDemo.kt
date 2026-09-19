package app.zen.chromium

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.zen.chromium.blocking.SafeBrowsingHit
import app.zen.chromium.privacy.Privacy
import app.zen.chromium.privacy.SafeBrowsing
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.Random

/**
 * Measures and records the Safe Browsing guard's first check after process start on a warm
 * profile – one whose feed documents are the size of the real feeds after a refresh (about
 * 690 000 prefixes, 7.4 MB of JSON), which the debug build's interpreter takes seconds to parse –
 * with and without the snapshot of the tables (`safebrowsing/tables.bin`, [SafeBrowsing]).
 *
 * Before the app starts, a guard of this test's own is started over the documents with no
 * snapshot on disk (every start on main): a navigation issued at once meets empty tables, the
 * hold runs out, the host passes; the parse time is noted, and that load leaves the snapshot
 * behind. Then the app starts on the same profile. The moment its activity is created (the host,
 * and with it the process's guard, are up) a check of the listed host is issued from another
 * thread, the way a document's request asks on a network thread: it is answered from the
 * snapshot's tables within the first fraction of a second. The restored tab's own load of the
 * listed host is what the recording shows: the warning page, as the app comes up. Notes with the
 * numbers go to `<shotPrefix>-notes.txt` next to the screenshots; the guard's own lines are in
 * logcat under `zen-safebrowsing`. Dispatch-only, like [SafeBrowsingDemo], whose loopback server
 * serves the sites here on a port of its own. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SafeBrowsingSnapshotDemo : DemoHarness("safebrowsing-snapshot-demo-state.json", "services-safebrowsing-snapshot", "safebrowsing-snapshot-demo") {
    override val tag = "SafeBrowsingSnapshotDemo"
    private lateinit var server: SafeBrowsingDemo.PrivacyDemoServer
    private lateinit var notes: File

    /** Lines noted before the handshake directory (and the notes file) exists; written out in [warmUp]. */
    private val early = ArrayList<String>()

    /** `SystemClock.uptimeMillis()` when the browser's activity was created (the process's guard started), 0 before. */
    @Volatile private var activityCreatedAt = 0L

    @Volatile private var firstCheck: FirstCheck? = null

    /** The check issued as the activity came up: when (ms after its creation), what it took, what it found. */
    private class FirstCheck(val issuedMs: Long, val answeredMs: Long, val hit: SafeBrowsingHit?, val navigation: SafeBrowsing.FirstNavigation?)

    @Test
    fun record() {
        server = SafeBrowsingDemo.PrivacyDemoServer(PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    // --- the warm profile, and the guard without a snapshot -------------------------------------

    override fun seedMore(zen: File) {
        val dir = File(zen, "safebrowsing").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        // The documents of a profile after a refresh, at the real feeds' size, under ids the core
        // does not know (it leaves them alone; the guard loads every document under safebrowsing/).
        File(dir, "demo-malware.json").writeText(SafeBrowsingDemo.feedDocument("demo-malware", "malware", listOf(MALWARE_HOST)))
        val started = SystemClock.uptimeMillis()
        var bytes = 0L
        bytes += writeBulkDocument(dir, "demo-bulk-phishing", "phishing", 600_000, seed = 1)
        bytes += writeBulkDocument(dir, "demo-bulk-malware", "malware", 90_000, seed = 2)
        noteEarly("profile: ${dir.listFiles()!!.size} feed documents seeded, ${bytes / 1024} KB of JSON in ${SystemClock.uptimeMillis() - started} ms " +
            "(690 001 prefixes: the real feeds' size after a refresh); $MALWARE_HOST is listed by demo-malware")
        measureWithoutSnapshot()
    }

    /** A feed document of `count` random prefixes, the shape and size of a real feed's; the bytes written. */
    private fun writeBulkDocument(dir: File, id: String, threat: String, count: Int, seed: Long): Long {
        val random = Random(seed)
        val prefixes = ByteBuffer.allocate(count * 8)
        repeat(count) { prefixes.putLong(random.nextLong()) }
        val base64 = Base64.encodeToString(prefixes.array(), Base64.NO_WRAP)
        val json = StringBuilder(base64.length + 256)
            .append("{\"version\":1,\"id\":\"").append(id).append("\",\"threat\":\"").append(threat)
            .append("\",\"entries\":").append(count).append(",\"updatedAt\":").append(System.currentTimeMillis())
            .append(",\"etag\":null,\"lastModified\":null,\"bundled\":false,\"prefixes\":\"").append(base64).append("\"}")
            .toString()
        val file = File(dir, "$id.json")
        file.writeText(json)
        return file.length()
    }

    /**
     * Every start on main: the documents and no snapshot. A guard of this test's own over the
     * same files, a navigation's check issued the moment it starts, then the load's time. The
     * load writes the snapshot the app's own guard finds at its start.
     */
    private fun measureWithoutSnapshot() {
        val storage = Storage(app)
        storage.deleteBytes(SafeBrowsing.SNAPSHOT)
        val guard = SafeBrowsing(storage)
        guard.log = { noteEarly("  guard (no snapshot): $it") }
        val started = SystemClock.uptimeMillis()
        guard.start()
        val tables = guard.tablesForNavigation()
        val first = guard.firstNavigation!!
        val hit = tables.lookup(MALWARE_HOST)
        noteEarly(
            "before (documents only, no snapshot: every start on main): a navigation to $MALWARE_HOST issued at start " +
                "saw ${tables.entries} prefixes after a wait of ${first.waitedMs} ms -> " +
                if (hit == null) "UNCHECKED, the listed host passes (on main the wait is 0 ms; here the ${SafeBrowsing.FIRST_NAVIGATION_HOLD_MS} ms hold ran out)"
                else "stopped by ${hit.feedId} (${hit.threat})"
        )
        val deadline = SystemClock.uptimeMillis() + 180_000
        while (guard.lastSnapshot == SafeBrowsing.SnapshotOutcome.NONE && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        val emptyFor = SystemClock.uptimeMillis() - started
        noteEarly(
            "before: the documents parsed in ${guard.lastLoadMs} ms (${guard.tables.entries} prefixes from ${guard.tables.feeds.size} feeds); " +
                "the tables were empty for the first $emptyFor ms after start; snapshot ${guard.lastSnapshot.name.lowercase()}, " +
                "${(storage.fileFor(SafeBrowsing.SNAPSHOT)?.length() ?: 0) / 1024} KB"
        )
        guard.stop()
    }

    // --- the app's start, with the snapshot ------------------------------------------------------

    override fun beforeLaunch() {
        val application = app.applicationContext as Application
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
                if (activity !is MainActivity || activityCreatedAt != 0L) return
                activityCreatedAt = SystemClock.uptimeMillis()
                application.unregisterActivityLifecycleCallbacks(this)
                // The host is up, and with it the process's guard: a document's check, as
                // Blocking.evaluate makes it for a navigation on a network thread, at once.
                Thread({
                    val privacy = Privacy.shared(app)
                    val issued = SystemClock.uptimeMillis()
                    val hit = privacy.unsafe(MALWARE_URL, navigation = true)
                    val answered = SystemClock.uptimeMillis()
                    firstCheck = FirstCheck(issued - activityCreatedAt, answered - activityCreatedAt, hit, privacy.safeBrowsing.firstNavigation)
                }, "demo-first-navigation").start()
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    override fun warmUp() {
        notes = File(out, "services-safebrowsing-snapshot-notes.txt")
        notes.writeText("Zenium Android Safe Browsing demo: the tables' snapshot and the first navigation's hold\n\n")
        for (line in early) note(line)
        note("demo server: ${server.selfCheck()}")

        val guard = Privacy.shared(app).safeBrowsing
        var deadline = SystemClock.uptimeMillis() + 30_000
        while (firstCheck == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        val check = firstCheck
        note("\nafter (the same documents, the snapshot present): snapshot of ${guard.tables.entries} prefixes from ${guard.tables.feeds.size} feeds " +
            "loaded in ${guard.snapshotLoadMs} ms" + (guard.snapshotRejected?.let { " (REJECTED: $it)" } ?: ""))
        if (check == null) {
            note("after: the check issued at the activity's creation never answered")
        } else {
            val nav = check.navigation
            note(
                "after: a navigation to $MALWARE_HOST issued ${check.issuedMs} ms after the activity's creation saw " +
                    "${nav?.entries} prefixes after a wait of ${nav?.waitedMs} ms (load ${if (nav?.loaded == true) "published" else "pending"}) -> " +
                    (check.hit?.let { "stopped by ${it.feedId} (${it.threat}, ${it.expression})" } ?: "UNCHECKED") +
                    ", answered ${check.answeredMs} ms after the creation"
            )
        }

        // The restored tab's own load of the listed host: the warning page, as the app comes up.
        deadline = SystemClock.uptimeMillis() + 90_000
        var tab: JSONObject? = null
        while (SystemClock.uptimeMillis() < deadline) {
            tab = runCatching { state().getJSONObject("tabs").optJSONObject("tab_demo") }.getOrNull()
            if (tab != null && tab.optString("url").startsWith("zen://error") && !tab.optBoolean("loading")) break
            SystemClock.sleep(500)
        }
        note("after: the restored tab ${describeTab(tab)} ${SystemClock.uptimeMillis() - activityCreatedAt} ms after the activity's creation")

        // The documents' load behind the snapshot, in the app's process.
        deadline = SystemClock.uptimeMillis() + 180_000
        while (guard.lastSnapshot == SafeBrowsing.SnapshotOutcome.NONE && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        note("after: the documents parsed in ${guard.lastLoadMs} ms behind the snapshot (${guard.tables.entries} prefixes); snapshot ${guard.lastSnapshot.name.lowercase()}")
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()
        val guard = Privacy.shared(app).safeBrowsing

        note("\n1. The restored tab as the app came up: the listed host, stopped from the snapshot's tables")
        note("  ${describeTab(state().getJSONObject("tabs").optJSONObject("tab_demo"))}")
        shot("01-restored-tab-stopped")
        beat()
        if (tapLabel(f, "Details", 6_000)) SystemClock.sleep(1_500) else note("  (no Details node)")
        shot("02-details")
        beat()

        note("\n2. A site the feeds do not list")
        navigate(SAFE_URL)
        var tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab.getJSONObject("tabs").optJSONObject("tab_demo"))}")
        shot("03-unlisted-site")
        beat()

        note("\n3. The listed host again: a later navigation, no wait, the same tables")
        val started = SystemClock.uptimeMillis()
        navigate(MALWARE_URL)
        tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab.getJSONObject("tabs").optJSONObject("tab_demo"))} within ${SystemClock.uptimeMillis() - started} ms")
        shot("04-listed-host-stopped-again")
        beat()

        note(
            "\nguard at the end: ${guard.tables.entries} prefixes from ${guard.tables.feeds.size} feeds " +
                "[${guard.tables.feeds.joinToString(", ") { "${it.id}(${it.threat}, ${it.table.size})" }}]; " +
                "last load ${guard.lastLoadMs} ms, snapshot ${guard.lastSnapshot.name.lowercase()}"
        )
        note("done")
    }

    // --- the chrome's bridge ---------------------------------------------------------------------

    private fun state(): JSONObject = coreState()

    private fun navigate(url: String) {
        coreInvoke("tab.navigate", """{"tabId":"tab_demo","input":${JSONObject.quote(url)}}""")
    }

    private fun describeTab(tab: JSONObject?): String {
        if (tab == null) return "tab tab_demo gone"
        return "tab tab_demo url=${tab.optString("url")} title=\"${tab.optString("title")}\" errorCode=${tab.opt("errorCode")}"
    }

    private fun waitForTitle(prefix: String, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        note("  (title '$prefix' never showed up; ${describeTab(s.getJSONObject("tabs").optJSONObject("tab_demo"))})")
        return s
    }

    private fun waitForUrl(prefix: String, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab != null && tab.optString("url").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_500)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        note("  (url '$prefix' never showed up; ${describeTab(s.getJSONObject("tabs").optJSONObject("tab_demo"))})")
        return s
    }

    private fun noteEarly(line: String) {
        Log.i(tag, line)
        early.add(line)
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18125
        /** Listed by the malware feed the demo seeds; the restored tab's address. */
        private const val MALWARE_HOST = "127.0.0.7"
        private const val MALWARE_URL = "http://$MALWARE_HOST:$PORT/"
        /** A site of the demo server no feed lists. */
        private const val SAFE_URL = "http://127.0.0.2:$PORT/"
    }
}
