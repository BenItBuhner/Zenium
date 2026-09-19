package app.zen.chromium

import android.content.Intent
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.Collections
import java.util.Random

/**
 * Measures what a boot of the chrome costs on the Kotlin ⇄ chrome seam, for the before / after
 * table of the boot handoff (`BootHandoff.kt`, `src/android/handoff.ts`). Not a recorded demo:
 * a timing probe the workflow runs against two APKs, the one built from `main` and the one from
 * the branch, with this same driver (it touches nothing the older host lacks).
 *
 * Two phases (`-e phase warm|measure`):
 *  - `warm`: a first run on a fresh profile with one blank tab, long enough for the core to
 *    install the bundled filter lists and seed the bundled Safe Browsing snapshots – the
 *    rule index and the list files a real profile has.
 *  - `measure`: the Safe Browsing documents are rewritten fresh (`bundled: false`, dated now, so
 *    no feed is refreshed over the network during the boot), the phishing-domains feed's
 *    document among them, generated at its real size (`FEED_PREFIXES` sorted 8-byte prefixes);
 *    then the app is launched and timed to `window.zen`, the host's storage writes during the
 *    boot are recorded, the request engine's rebuild count and the Safe Browsing load are read,
 *    and `boot-probe.js` replays each transport in the chrome (see there). A loopback server
 *    answers a hosts list the size of the phishing-domains download for the `net.fetch` replay.
 *
 * Results: `files/boot-probe/results.json` (the workflow pulls it and tabulates before / after).
 */
@RunWith(AndroidJUnit4::class)
class BootHandoffProbe : DemoHarness(null, "boot-probe", "boot-probe") {
    override val tag = "BootHandoffProbe"
    override fun warmUp() {}
    override fun demo() {}

    private val zen: File get() = File(app.filesDir, "zen")

    @Test
    fun run() {
        out.mkdirs()
        when (val phase = InstrumentationRegistry.getArguments().getString("phase", "measure")) {
            "warm" -> warm()
            "measure" -> measureBoot()
            else -> error("unknown phase $phase")
        }
    }

    // --- warm: a first run that leaves a real profile behind -------------------------------------

    private fun warm() {
        zen.deleteRecursively()
        zen.mkdirs()
        File(zen, "state.json").writeText(readAsset("appicon-demo-state.json").replace("https://example.com/", "about:blank"))
        launch()
        val index = File(zen, "blocking/index.json")
        val deadline = SystemClock.uptimeMillis() + 120_000
        while (SystemClock.uptimeMillis() < deadline) {
            val installed = index.isFile && index.readText().contains("\"easylist\"") &&
                File(zen, "safebrowsing/phishing-filter.json").isFile
            if (installed) break
            SystemClock.sleep(1_000)
        }
        // The last index write settles (the store debounces), then the process may go.
        SystemClock.sleep(6_000)
        Log.i(tag, "warm profile: ${profileListing()}")
    }

    // --- measure ---------------------------------------------------------------------------------

    private fun measureBoot() {
        seedFeedDocuments()
        val writes = Collections.synchronizedList(ArrayList<JSONObject>())
        val listener: (String) -> Unit = { name ->
            writes.add(
                JSONObject()
                    .put("name", name)
                    .put("bytes", File(zen, name).length())
                    .put("atMs", SystemClock.uptimeMillis())
            )
        }
        val server = DemoServer(PORT, mapOf("/hosts.txt" to ("text/plain" to hostsList()))).also { it.start() }
        Storage.addChangeListener(listener)
        try {
            val result = JSONObject()
            result.put("apk", apkInfo())
            result.put("profile", profileListing())
            val launchedAt = SystemClock.uptimeMillis()
            val boot = launchTimed(launchedAt)
            // The write-backs of the start (the store debounces 200 ms), the request engine's
            // rebuild (300 ms after a write of the index), the Safe Browsing load.
            SystemClock.sleep(10_000)
            result.put("boot", boot)
            result.put("kotlin", kotlinDiagnostics())
            val bootWrites = JSONArray()
            synchronized(writes) {
                for (w in writes) bootWrites.put(w.put("afterLaunchMs", w.getLong("atMs") - launchedAt).apply { remove("atMs") })
            }
            result.put("writesDuringBoot", bootWrites)
            result.put("replay", replay(server))
            File(out, "results.json").writeText(result.toString(2))
            Log.i(tag, "results: $result")
        } finally {
            Storage.removeChangeListener(listener)
            server.close()
        }
    }

    /** Start the activity and poll the chrome for `window.zen`, its own clock and the wall clock. */
    private fun launchTimed(launchedAt: Long): JSONObject {
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent)
        val deadline = launchedAt + 120_000
        var chromeReadyMs = -1
        var readyAt = -1L
        while (SystemClock.uptimeMillis() < deadline) {
            // During a synchronous boot the answer waits for the JS thread: the first one after
            // the boot carries the chrome's clock at that moment.
            val value = chromeJs("window.zen?Math.round(performance.now()):-1").trim().toIntOrNull() ?: -1
            if (value >= 0) {
                chromeReadyMs = value
                readyAt = SystemClock.uptimeMillis()
                break
            }
            SystemClock.sleep(50)
        }
        return JSONObject()
            .put("launchToReadyMs", if (readyAt < 0) -1 else readyAt - launchedAt)
            .put("chromeReadyMs", chromeReadyMs)
    }

    private fun kotlinDiagnostics(): JSONObject {
        val host = (activity as MainActivity).host
        val safeBrowsing = host.privacy.safeBrowsing
        return JSONObject()
            .put("blockingBuilds", host.blocking.builds)
            .put("blockingLastBuildMs", host.blocking.lastBuildMs)
            .put("safeBrowsingLoadMs", safeBrowsing.lastLoadMs)
            .put("safeBrowsingFeeds", safeBrowsing.tables.feeds.size)
            .put("safeBrowsingEntries", safeBrowsing.tables.entries)
    }

    /** Run `boot-probe.js` in the chrome and wait for its result. */
    private fun replay(server: DemoServer): JSONObject {
        chromeJs("window.__probeArgs=${JSONObject().put("hostsUrl", "${server.origin}/hosts.txt")}")
        chromeJs(readAsset("boot-probe.js"))
        val deadline = SystemClock.uptimeMillis() + 240_000
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chromeJs("window.__probeResult===undefined?'':window.__probeResult")
            val value = (JSONTokener(raw).nextValue() as? String).orEmpty()
            if (value.isNotEmpty()) return JSONObject(value)
            SystemClock.sleep(500)
        }
        return JSONObject().put("error", "the replay timed out")
    }

    // --- the profile -----------------------------------------------------------------------------

    /**
     * Every Safe Browsing document as a profile has them once the feeds were refreshed: the
     * bundled snapshots dated now and no longer marked bundled (else the core would refresh
     * them during the boot, over the network), and the phishing-domains feed's document at its
     * production size, the same bytes on every run.
     */
    private fun seedFeedDocuments() {
        val dir = File(zen, "safebrowsing").apply { mkdirs() }
        val now = System.currentTimeMillis()
        for (id in BUNDLED_FEEDS) {
            val text = runCatching { app.assets.open("safebrowsing/$id.json").bufferedReader().use { it.readText() } }.getOrNull()
            if (text == null) {
                Log.w(tag, "no bundled snapshot for $id")
                continue
            }
            val doc = JSONObject(text).put("bundled", false).put("updatedAt", now)
            File(dir, "$id.json").writeText(doc.toString())
        }
        File(dir, "phishing-database.json").writeText(phishingDatabaseDocument(now))
    }

    private fun phishingDatabaseDocument(updatedAt: Long): String {
        val random = Random(7)
        val values = LongArray(FEED_PREFIXES) { random.nextLong() }
        values.sort()
        val bytes = ByteBuffer.allocate(FEED_PREFIXES * 8)
        for (v in values) bytes.putLong(v)
        return JSONObject()
            .put("version", 1)
            .put("id", "phishing-database")
            .put("threat", "phishing")
            .put("entries", FEED_PREFIXES)
            .put("updatedAt", updatedAt)
            .put("etag", "\"boot-probe\"")
            .put("lastModified", "Fri, 18 Sep 2026 00:00:00 GMT")
            .put("bundled", false)
            .put("prefixes", Base64.encodeToString(bytes.array(), Base64.NO_WRAP))
            .toString()
    }

    /** A domains list the size of the phishing-domains download, one host per line. */
    private fun hostsList(): ByteArray {
        val sb = StringBuilder(HOSTS_LINES * 18)
        for (i in 0 until HOSTS_LINES) sb.append('a').append(i.toString().padStart(6, '0')).append(".zen.test\n")
        return sb.toString().toByteArray(Charsets.UTF_8)
    }

    private fun profileListing(): JSONObject {
        val out = JSONObject()
        zen.walkTopDown().filter { it.isFile }.sortedBy { it.path }.forEach { f ->
            out.put(f.relativeTo(zen).path, f.length())
        }
        return out
    }

    private fun apkInfo(): JSONObject {
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        return JSONObject().put("versionName", info.versionName ?: "").put("lastUpdateTime", info.lastUpdateTime)
    }

    companion object {
        private const val PORT = 8779
        private val BUNDLED_FEEDS = listOf("urlhaus", "urlhaus-filter", "phishing-filter")
        /** 690 000 prefixes of 8 bytes: 5.5 MB, 7.4 MB as base64 – the phishing-domains document. */
        private const val FEED_PREFIXES = 690_000
        /** 650 000 lines of 17 bytes: 11 MB, the phishing-domains download. */
        private const val HOSTS_LINES = 650_000
    }
}
