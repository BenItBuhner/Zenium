package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records ad and tracker blocking on the phone: a page that asks nine real ad and tracking hosts
 * for a resource (every row red, the tab's counter at nine), a host a filter list blocks as a
 * whole document (Zenium's blocked page), the per-site exception made through the ads
 * permission and reset from the site-info sheet, the master switch off and on again, and the
 * same page in a private tab.
 *
 * The page comes from a loopback HTTP server inside this process (the instrumentation shares
 * the app's process), so the demo needs nothing from the workflow runner. Counters and the
 * engine's status are read through the chrome's `window.zen` bridge and written to
 * `<shotPrefix>-counters.txt` next to the screenshots. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class BlockingDemo : DemoHarness("blocking-demo-state.json", "services-blocking-android", "blocking-demo") {
    override val tag = "BlockingDemo"
    private lateinit var server: DemoServer
    private lateinit var notes: File

    @Test
    fun record() {
        server = DemoServer(readAsset("blocking-demo-page.html"), PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "services-blocking-android-counters.txt")
        notes.writeText("Zenium Android blocking demo\n\n")
        note("demo server: ${server.selfCheck()}")
        // The bundled snapshot is installed by the core after boot, one list at a time, and the
        // Kotlin engine follows the index; the seeded tab may have loaded before either was
        // ready. Wait for every enabled default list to have its copy and for the engine's
        // snapshot to settle on the same set of lists, then reload.
        val blocking = (activity as MainActivity).host.blocking
        val deadline = SystemClock.uptimeMillis() + 150_000
        var lastReport = 0L
        var status = blockingStatus()
        while (SystemClock.uptimeMillis() < deadline && !(status.getBoolean("ready") && enabledListsHaveFilters(status))) {
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note("waiting: ${describeLists(status)} | kotlin ${describeKotlin(blocking)}")
            }
            SystemClock.sleep(1_000)
            status = blockingStatus()
        }
        // The engine rebuilds its snapshot after each index change; wait for the set count to
        // reach the enabled lists and stay there.
        val enabledCount = enabledListCount(status)
        var stable = 0
        while (SystemClock.uptimeMillis() < deadline && stable < 3) {
            val snap = blocking.snapshot
            if (snap.setCount >= enabledCount && snap.filterCount > 0 && snap.filterCount == lastFilterCount) stable++ else stable = 0
            lastFilterCount = snap.filterCount
            SystemClock.sleep(1_000)
        }
        note("engine ready=${status.getBoolean("ready")} enabled=${status.getBoolean("enabled")}")
        note("lists: ${describeLists(status)}")
        note("kotlin engine: ${describeKotlin(blocking)}")
        for (attempt in 1..3) {
            invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
            val tab = waitForTitle("9/9", 15_000).getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab?.optString("title")?.startsWith("9/9") == true) break
            Log.w(tag, "attempt $attempt: page settled at '${tab?.optString("title")}' url=${tab?.optString("url")}")
            SystemClock.sleep(3_000)
        }
        Log.i(tag, "warm-up done")
    }

    private var lastFilterCount = -1

    override fun demo() {
        // 1. Blocking on: every third-party row red, the page's own resources loaded.
        note("\n1. demo page with blocking on")
        var tab = waitForTitle("9/9")
        note("  ${describeTab(tab)}")
        shot("01-demo-page-blocked")
        beat()

        // 2. A host the uBO badware list blocks as a document: Zenium's blocked page.
        note("\n2. main-frame block (`||buzzadnetwork.com^\$all`)")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"https://buzzadnetwork.com/"}""")
        waitForUrl("zen://error?code=-20", 20_000)
        SystemClock.sleep(2_500)
        note("  ${describeTab(state())}")
        note("  document: ${documentOf("tab_demo")}")
        shot("02-blocked-page")
        beat()

        // 3. Except the demo site through the ads permission; nothing is blocked on it any more.
        note("\n3. per-site exception through the ads permission")
        invoke("blocking.setSiteException", """{"site":"$DEMO_URL","excepted":true}""")
        SystemClock.sleep(500)
        note("  siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL"}""")
        tab = waitForTitle("0/9", 25_000)
        note("  ${describeTab(tab)}")
        shot("03-demo-page-site-excepted")
        beat()

        // 4. The exception is a permission: the site-info sheet lists it and can reset it.
        note("\n4. the exception in the site-info sheet")
        val f = Finger()
        tapSiteIcon(f)
        SystemClock.sleep(3_000)
        shot("04-site-info-ads-exception")
        if (clickByLabel("Reset Ads and trackers permission")) {
            SystemClock.sleep(2_500)
            note("  reset from the sheet: siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
        } else {
            Log.w(tag, "no reset button in the sheet; resetting through the command")
            invoke("blocking.setSiteException", """{"site":"$DEMO_URL","excepted":false}""")
        }
        dismissSheet(f)
        SystemClock.sleep(2_000)
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        tab = waitForTitle("9/9", 25_000)
        note("  after the reset: ${describeTab(tab)}")
        shot("05-demo-page-blocked-again")
        beat()

        // 5. Master switch off: the same page, nothing blocked.
        note("\n5. master switch off")
        invoke("blocking.setEnabled", """{"enabled":false}""")
        note("  engine followed in ${waitForEngine { it.filterCount == 0 }} ms")
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        tab = waitForTitle("0/9", 25_000)
        note("  enabled=${blockingStatus().getBoolean("enabled")} ${describeTab(tab)}")
        shot("06-demo-page-switch-off")
        beat()

        // 6. Switch on again: blocked again, the session total climbs.
        note("\n6. master switch on again")
        invoke("blocking.setEnabled", """{"enabled":true}""")
        note("  engine followed in ${waitForEngine { it.filterCount > 0 }} ms (${describeKotlin(engine)})")
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        tab = waitForTitle("9/9", 25_000)
        note("  enabled=${blockingStatus().getBoolean("enabled")} ${describeTab(tab)}")
        shot("07-demo-page-switch-on")
        beat()

        // 7. A tab in the private container: its WebView profile runs the same engine.
        note("\n7. private-container tab")
        val privateId = runCatching {
            invoke("tab.create", """{"url":"$DEMO_URL","active":true,"containerId":"$PRIVATE_CONTAINER"}""").trim('"')
        }.getOrElse { e ->
            note("  tab.create failed: ${e.message}")
            null
        }
        if (privateId != null) {
            val privateTab = waitForTitle("9/9", 30_000, privateId)
            note("  ${describeTab(privateTab, privateId)}")
            shot("08-private-tab-blocked")
            beat()
        }
        note("\ndone")
    }

    // --- the chrome's bridge --------------------------------------------------------------------

    /** Evaluate in the chrome WebView; the raw JSON-encoded result. */
    private fun js(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.chrome.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Run a core command through `window.zen.invoke` and wait for its promise; the result as JSON. */
    private fun invoke(name: String, args: String = "null"): String {
        js(
            "window.__demo=undefined;window.zen.invoke(${JSONObject.quote(name)},$args)" +
                ".then(r=>{window.__demo=JSON.stringify(r===undefined?null:r)},e=>{window.__demo='ERR:'+(e&&e.message||e)})"
        )
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = js("window.__demo===undefined?'':window.__demo")
            val value = (JSONTokener(raw).nextValue() as? String).orEmpty()
            if (value.startsWith("ERR:")) error("$name failed: ${value.removePrefix("ERR:")}")
            if (value.isNotEmpty()) return value
            SystemClock.sleep(100)
        }
        error("$name timed out")
    }

    private fun state(): JSONObject = JSONObject(invoke("app.getState"))

    private fun blockingStatus(): JSONObject = state().getJSONObject("blocking")

    private val engine: app.zen.chromium.blocking.Blocking get() = (activity as MainActivity).host.blocking

    /**
     * Milliseconds until the Kotlin engine's snapshot satisfies `ready`: the core rewrites the
     * index, the engine rebuilds after its debounce. Gives up after 20 s and says so.
     */
    private fun waitForEngine(ready: (app.zen.chromium.blocking.EngineSnapshot) -> Boolean): Long {
        val started = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - started < 20_000) {
            if (ready(engine.snapshot)) return SystemClock.uptimeMillis() - started
            SystemClock.sleep(50)
        }
        note("  (the engine's snapshot did not follow: ${describeKotlin(engine)})")
        return SystemClock.uptimeMillis() - started
    }

    /** Every list the level enables has its filter text (the bundled copy or a download). */
    private fun enabledListsHaveFilters(status: JSONObject): Boolean {
        val lists = status.getJSONArray("lists")
        var enabled = 0
        for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            if (!l.getBoolean("enabled")) continue
            enabled++
            if (l.getInt("filterCount") == 0) return false
        }
        return enabled > 0
    }

    private fun enabledListCount(status: JSONObject): Int {
        val lists = status.getJSONArray("lists")
        return (0 until lists.length()).count { lists.getJSONObject(it).getBoolean("enabled") }
    }

    private fun describeLists(status: JSONObject): String {
        val lists = status.getJSONArray("lists")
        return (0 until lists.length()).joinToString(", ") {
            val l = lists.getJSONObject(it)
            "${l.getString("id")}(${if (l.getBoolean("enabled")) "on" else "off"}, ${l.getInt("filterCount")} filters)"
        }
    }

    private fun describeKotlin(blocking: app.zen.chromium.blocking.Blocking): String =
        "${blocking.snapshot.filterCount} network filters from ${blocking.snapshot.setCount} sets, " +
            "last build ${blocking.lastBuildMs} ms (${blocking.builds} builds)"

    /** What the tab's WebView shows: its document title, location and size (diagnostics for the blocked page). */
    private fun documentOf(tabId: String): String {
        val tab = (activity as MainActivity).host.tabs.get(tabId) ?: return "no WebView for $tabId"
        var result = "(no answer)"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(
                "JSON.stringify({title:document.title,href:location.href,ready:document.readyState," +
                    "chars:document.documentElement.outerHTML.length,text:(document.body&&document.body.innerText||'').slice(0,80)})"
            ) { value ->
                result = value ?: "(null)"
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    /** The tab's url, title and counter plus the session total. */
    private fun describeTab(s: JSONObject, tabId: String = "tab_demo"): String {
        val tab = s.getJSONObject("tabs").optJSONObject(tabId) ?: return "tab $tabId gone"
        return "tab $tabId url=${tab.optString("url")} title=\"${tab.optString("title")}\" " +
            "blockedCount=${tab.optInt("blockedCount")} sessionBlocked=${s.getJSONObject("blocking").optInt("sessionBlocked")}"
    }

    /** Poll the tab's title (the page writes its tally into it) and hand back the state then. */
    private fun waitForTitle(prefix: String, timeoutMs: Long = 20_000, tabId: String = "tab_demo"): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(tabId)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        Log.w(tag, "title '$prefix' never showed up on $tabId")
        return s
    }

    /** Poll the tab's URL for `prefix` (an internal page that carries no title of its own). */
    private fun waitForUrl(prefix: String, timeoutMs: Long, tabId: String = "tab_demo"): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(tabId)
            if (tab != null && tab.optString("url").startsWith(prefix) && !tab.optBoolean("loading")) return s
            SystemClock.sleep(500)
            s = state()
        }
        Log.w(tag, "url '$prefix' never showed up on $tabId")
        return s
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the sheet ------------------------------------------------------------------------------

    /** The site icon sits at the start of the pill; the accessibility tree knows it by its label. */
    private fun tapSiteIcon(f: Finger) {
        val icon = findByLabel(SITE_ICON_LABEL)?.takeIf { it.top > height * 0.6 }
        if (icon != null) {
            f.tap(icon.exactCenterX(), icon.exactCenterY())
        } else {
            Log.w(tag, "site icon not in the accessibility tree; tapping the start of the pill")
            f.tap(pill.left + 22 * density, pillY)
        }
    }

    /** Drag the sheet away by its grip, or fall back to a tap on the scrim above it. */
    private fun dismissSheet(f: Finger) {
        val grip = findByLabel(GRIP_LABEL)
        if (grip == null) {
            f.tap(width / 2f, 60 * density)
            return
        }
        f.down(width / 2f, grip.exactCenterY())
        f.moveBy(0f, 0.25f * height, 400)
        f.hold(150)
        f.moveBy(0f, 0.30f * height, 140)
        f.up()
    }

    // --- the page's server ----------------------------------------------------------------------

    /**
     * Serves the demo page on the loopback interface: `/` is the page, `/ok.js` and `/ok.png`
     * are the site's own resources (the control rows). Everything the page asks third parties for
     * goes out through the WebView as usual, which is where the engine sees it.
     */
    private class DemoServer(private val page: String, private val port: Int) : Thread("blocking-demo-server") {
        // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses
        // the 127.0.0.1 the page's URL names, so bind the IPv4 loopback explicitly.
        private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        @Volatile private var closed = false

        /** Fetch `/` the way the WebView will and describe the outcome. */
        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET / HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                val status = s.getInputStream().bufferedReader().readLine()
                "listening on ${socket.localSocketAddress}, GET / -> $status"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET / failed: $e" }

        override fun run() {
            while (!closed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    if (closed) return else continue
                }
                Thread { serve(client) }.start()
            }
        }

        private fun serve(client: Socket) {
            client.use {
                val request = it.getInputStream().bufferedReader()
                val line = request.readLine() ?: return
                while (true) {
                    val header = request.readLine()
                    if (header.isNullOrEmpty()) break
                }
                val path = line.split(' ').getOrNull(1) ?: "/"
                val (type, body) = when (path.substringBefore('?')) {
                    "/ok.js" -> "text/javascript" to "window.__ok = true\n".toByteArray()
                    "/ok.png" -> "image/png" to PIXEL
                    else -> "text/html; charset=utf-8" to page.toByteArray()
                }
                val out = it.getOutputStream()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
                        "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                )
                out.write(body)
                out.flush()
            }
        }

        fun close() {
            closed = true
            runCatching { socket.close() }
        }

        companion object {
            /** A 1x1 transparent PNG. */
            private val PIXEL = android.util.Base64.decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
                android.util.Base64.DEFAULT
            )
        }
    }

    companion object {
        private const val PORT = 18123
        private const val DEMO_URL = "http://127.0.0.1:$PORT/"
        private const val PRIVATE_CONTAINER = "private"
        private const val SITE_ICON_LABEL = "Site information"
        private const val GRIP_LABEL = "Drag to dismiss"
    }
}
