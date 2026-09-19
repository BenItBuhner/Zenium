package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
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
 * Records the request blocking UI on the phone: the address pill's blocked-count chip climbing
 * as the demo page asks nine real ad and tracking hosts again, Settings > Privacy and Security
 * (the status card, the master switch, the level as radios, the filter lists, the sites without
 * blocking), a level change the Kotlin engine follows, the current site excepted from the row
 * in Settings and blocked again from its trash button, and the master switch off and on.
 *
 * Every control is driven through the chrome's accessibility tree the way a screen reader
 * would (the checkbox or radio inside a row is the checkable node named after the row); the
 * outcome is checked against the core's state through `window.zen` and the engine's snapshot,
 * and written to `<shotPrefix>-notes.txt` next to the screenshots. The page comes from a
 * loopback server in this process, as in [BlockingDemo].
 */
@RunWith(AndroidJUnit4::class)
class BlockingUiDemo : DemoHarness("blocking-demo-state.json", "services-blocking-android-ui", "blocking-ui-demo") {
    override val tag = "BlockingUiDemo"
    private lateinit var server: LoopbackPage
    private lateinit var notes: File

    @Test
    fun record() {
        server = LoopbackPage(readAsset("blocking-demo-page.html"), PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "services-blocking-android-ui-notes.txt")
        notes.writeText("Zenium Android blocking UI demo\n\n")
        note("demo server: ${server.selfCheck()}")
        // The bundled snapshot is installed by the core after boot and the Kotlin engine follows
        // the index; wait for every enabled list to have its filters and the snapshot to settle.
        val deadline = SystemClock.uptimeMillis() + 150_000
        var status = blockingStatus()
        var lastReport = 0L
        while (SystemClock.uptimeMillis() < deadline && !(status.getBoolean("ready") && enabledListsHaveFilters(status))) {
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note("waiting: ${describeLists(status)} | kotlin ${describeEngine()}")
            }
            SystemClock.sleep(1_000)
            status = blockingStatus()
        }
        val enabledCount = enabledListCount(status)
        var stable = 0
        var lastFilterCount = -1
        while (SystemClock.uptimeMillis() < deadline && stable < 3) {
            val snap = engine.snapshot
            if (snap.setCount >= enabledCount && snap.filterCount > 0 && snap.filterCount == lastFilterCount) stable++ else stable = 0
            lastFilterCount = snap.filterCount
            SystemClock.sleep(1_000)
        }
        note("engine ready=${status.getBoolean("ready")} enabled=${status.getBoolean("enabled")} level=${level()}")
        note("lists: ${describeLists(status)}")
        note("kotlin engine: ${describeEngine()}")
        for (attempt in 1..3) {
            invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
            val tab = waitForTitle("9/9", 15_000).getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab?.optString("title")?.startsWith("9/9") == true) break
            Log.w(tag, "attempt $attempt: page settled at '${tab?.optString("title")}'")
            SystemClock.sleep(3_000)
        }
        closeUrlbar()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The chip: nine requests blocked on the page, the count in the pill.
        note("\n1. the blocked-count chip")
        var s = waitForBlocked(9)
        note("  ${describeTab(s)}")
        note("  chip: ${chipLabel() ?: "(not in the accessibility tree)"}")
        shot("01-page-chip-9")
        beat()

        // 2. The counter rises: the page asks the same hosts again, twice.
        note("\n2. the counter rising")
        askAgain()
        s = waitForBlocked(18)
        note("  ${describeTab(s)}")
        note("  chip: ${chipLabel() ?: "(not in the accessibility tree)"}")
        shot("02-page-chip-18")
        askAgain()
        s = waitForBlocked(27)
        note("  ${describeTab(s)}")
        shot("03-page-chip-27")
        beat()

        // 3. Settings > Privacy and Security: the status card and the master switch.
        note("\n3. Settings > Privacy and Security")
        if (!openPrivacySettings()) {
            note("  Settings did not open; the rest of the sequence needs it")
            return
        }
        note("  status card: ${statusCard()}")
        shot("04-settings-privacy")
        beat()

        // 4. The level: Balanced -> Strict adds uBlock Origin's privacy list; the engine follows.
        note("\n4. level Balanced -> Strict")
        val before = engine.snapshot.setCount
        if (pickLevel("Strict", "strict")) {
            note("  level=${level()} engine followed in ${waitForEngine { it.setCount > before }} ms (${describeEngine()})")
            reveal("Strict")
            SystemClock.sleep(600)
            shot("05-level-strict")
            beat()
        } else {
            note("  the Strict radio did not take (level=${level()})")
        }
        note("\n   level Strict -> Balanced")
        val strictSets = engine.snapshot.setCount
        if (pickLevel("Balanced", "balanced")) {
            note("  level=${level()} engine followed in ${waitForEngine { it.setCount < strictSets }} ms (${describeEngine()})")
        }

        // 5. The filter lists with their counts and freshness.
        note("\n5. filter lists")
        if (reveal("Filter lists") != null) {
            SystemClock.sleep(600)
            note("  lists: ${describeLists(blockingStatus())}")
            shot("06-filter-lists")
            beat()
        }

        // 6. Sites without blocking: the current site's row, unchecked to except it.
        note("\n6. per-site exception from the current site's row")
        if (reveal("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("07-sites")
            beat()
        }
        if (setSiteRow(excepted = true)) {
            note("  siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
            reveal("Block on $DEMO_SITE")
            SystemClock.sleep(1_200)
            shot("08-site-excepted")
            beat()
        } else {
            note("  the row did not toggle; excepting through the command")
            invoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":true}""")
        }

        // 7. The page again: nothing blocked, the chip is a ghost.
        note("\n7. the excepted page")
        closeSettings()
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        s = waitForTitle("0/9", 25_000)
        note("  ${describeTab(s)}")
        note("  chip: ${chipLabel() ?: "(not in the accessibility tree)"}")
        shot("09-page-excepted")
        beat()

        // 8. Back in Settings the site is listed; its trash button blocks on it again.
        note("\n8. the exception's row and its trash button")
        if (openPrivacySettings() && reveal("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("10-sites-excepted-row")
            beat()
            if (clickByLabel("Block on $DEMO_SITE again") && awaitSettled({ !siteExcepted() }, 4_000)) {
                note("  after the trash button: siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
                SystemClock.sleep(1_200)
                shot("11-sites-blocked-again")
                beat()
            } else {
                note("  the trash button did not take; resetting through the command")
                invoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":false}""")
            }
        }

        // 9. The master switch: off (the card says so, the level and the lists grey out), on again.
        note("\n9. master switch")
        if (setMasterSwitch(enabled = false)) {
            note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount == 0 }} ms")
            reveal("Block ads and trackers")
            SystemClock.sleep(1_200)
            note("  status card: ${statusCard()}")
            shot("12-master-off")
            beat()
            if (setMasterSwitch(enabled = true)) {
                note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount > 0 }} ms")
                SystemClock.sleep(1_200)
                note("  status card: ${statusCard()}")
                shot("13-master-on")
                beat()
            }
        } else {
            note("  the master switch row did not toggle")
        }

        // 10. The page once more: blocked again, the session total higher than before.
        note("\n10. the page, blocked again")
        closeSettings()
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        s = waitForTitle("9/9", 25_000)
        note("  ${describeTab(s)}")
        shot("14-page-blocked-again")
        note("\ndone")
    }

    // --- Settings through the accessibility tree ----------------------------------------------

    private val host: Host get() = (activity as MainActivity).host

    private fun chromeSurfaceUp(): Boolean {
        var up = false
        instrumentation.runOnMainSync { up = host.back.chromeSurfaceUp }
        return up
    }

    /**
     * The app menu from a clear chrome, then Settings, then the Privacy and Security section.
     * The sheet slides away before the panel comes up and the tree trails the screen by seconds
     * on the software-rendered emulator, so each step is polled for rather than slept through.
     */
    private fun openPrivacySettings(): Boolean {
        ensureForeground()
        closeSettings()
        val button = findByLabel(MENU_LABEL) ?: Rect(
            (width - 52 * density).toInt(), (pill.centerY() - 22 * density).toInt(),
            (width - 8 * density).toInt(), (pill.centerY() + 22 * density).toInt()
        )
        Finger().tap(button.exactCenterX(), button.exactCenterY())
        if (waitFor(HANDLE_LABEL, 6_000) == null) {
            Log.w(tag, "the app menu did not open")
            return false
        }
        SystemClock.sleep(1_200)
        if (reveal("Settings") == null || !clickByLabel("Settings")) {
            Log.w(tag, "no Settings in the app menu")
            closeSettings()
            return false
        }
        if (waitFor(FIRST_SECTION, 12_000) == null) {
            Log.w(tag, "Settings did not come up")
            return false
        }
        SystemClock.sleep(800)
        // The section chips run in a strip; the one wanted sits past its right edge. Ask the tree
        // to bring it on screen, and drag the strip when the tree does not know it yet.
        for (attempt in 1..3) {
            if (findByLabel(SECTION) == null) findByLabel(FIRST_SECTION)?.let { strip ->
                val f = Finger()
                f.down(width * 0.9f, strip.exactCenterY())
                f.moveBy(-width * 0.7f, 0f, 350)
                f.up()
                SystemClock.sleep(900)
            }
            if (reveal(SECTION) != null && clickByLabel(SECTION)) break
            if (attempt == 3) {
                Log.w(tag, "no $SECTION section in Settings")
                return false
            }
        }
        return waitFor("Tracking prevention", 8_000) != null
    }

    /** Back while the host reports a chrome surface (the menu, Settings); nothing when none is up. */
    private fun closeSettings() {
        for (attempt in 1..4) {
            if (!chromeSurfaceUp()) return
            back()
            val deadline = SystemClock.uptimeMillis() + 6_000
            while (SystemClock.uptimeMillis() < deadline && chromeSurfaceUp()) SystemClock.sleep(150)
            SystemClock.sleep(600)
        }
        if (chromeSurfaceUp()) Log.w(tag, "a chrome surface stayed up")
    }

    /**
     * The checkable node of a row: the checkbox or radio inside the row's label, which the tree
     * names after the label's whole text (the row's name, then its description).
     */
    private fun findCheckable(rowLabel: String): AccessibilityNodeInfo? = findNodeWhere { node ->
        node.isCheckable && (node.contentDescription?.toString()?.startsWith(rowLabel) == true ||
            node.text?.toString()?.startsWith(rowLabel) == true)
    }

    /**
     * Scroll the row into view and click its checkbox or radio: through the tree first, then
     * with a finger at its bounds should the core not report the change (`settled`) in time.
     * The core is asked rather than the tree, which trails the screen and would otherwise earn
     * a checkbox a second tap that flips it back. False when the row is not there or the
     * change never came.
     */
    private fun toggleRow(rowLabel: String, settled: () -> Boolean): Boolean {
        if (settled()) return true
        if (reveal(rowLabel) == null) {
            Log.w(tag, "no $rowLabel row in Settings")
            return false
        }
        SystemClock.sleep(500)
        val box = findCheckable(rowLabel)
        if (box == null) {
            Log.w(tag, "no checkbox for $rowLabel")
            return false
        }
        box.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (!awaitSettled(settled, 4_000)) {
            Log.w(tag, "$rowLabel did not flip through the tree; tapping it")
            val rect = Rect().also { box.getBoundsInScreen(it) }
            Finger().tap(rect.exactCenterX(), rect.exactCenterY())
            if (!awaitSettled(settled, 4_000)) {
                Log.w(tag, "$rowLabel did not flip")
                return false
            }
        }
        Log.i(tag, "$rowLabel flipped")
        return true
    }

    private fun awaitSettled(settled: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** Pick a level radio by its name; true once the core's level is `level`. */
    private fun pickLevel(levelLabel: String, level: String): Boolean = toggleRow(levelLabel) { level() == level }

    /** The master switch through its row; true once the core reports `enabled`. */
    private fun setMasterSwitch(enabled: Boolean): Boolean =
        toggleRow("Block ads and trackers") { blockingStatus().getBoolean("enabled") == enabled }

    /** The current site's row; true once the core lists (or no longer lists) the site's exception. */
    private fun setSiteRow(excepted: Boolean): Boolean = toggleRow("Block on $DEMO_SITE") { siteExcepted() == excepted }

    private fun siteExcepted(): Boolean {
        val sites = blockingStatus().getJSONArray("siteExceptions")
        return (0 until sites.length()).any { sites.getString(it) == DEMO_ORIGIN }
    }

    /** The status card's headline and detail (the first two texts after the section title). */
    private fun statusCard(): String {
        val headline = findNode { it.contains("blocked since Zenium started") || it.startsWith("Ad and tracker blocking is off") || it.startsWith("Loading the filter lists") }
        return headline?.let { it.text ?: it.contentDescription }?.toString() ?: "(not in the accessibility tree)"
    }

    /** The chip's accessible label in the pill (`<n> requests blocked on this page · Site information`). */
    private fun chipLabel(): String? =
        findNode { it.contains("Site information") && (it.contains("blocked") || it.contains("Nothing")) }
            ?.let { it.contentDescription ?: it.text }?.toString()

    // --- the chrome's bridge --------------------------------------------------------------------

    /** Evaluate in the chrome WebView; the raw JSON-encoded result. */
    private fun js(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            host.chrome.evaluateJavascript(code) { value ->
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

    private fun level(): String = state().getJSONObject("settings").getJSONObject("blocking").optString("level")

    private val engine: app.zen.chromium.blocking.Blocking get() = host.blocking

    /** Milliseconds until the Kotlin engine's snapshot satisfies `ready`; gives up after 20 s and says so. */
    private fun waitForEngine(ready: (app.zen.chromium.blocking.EngineSnapshot) -> Boolean): Long {
        val started = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - started < 20_000) {
            if (ready(engine.snapshot)) return SystemClock.uptimeMillis() - started
            SystemClock.sleep(50)
        }
        note("  (the engine's snapshot did not follow: ${describeEngine()})")
        return SystemClock.uptimeMillis() - started
    }

    /** The demo page asks its nine third-party hosts again (cache-busted), the way it did on load. */
    private fun askAgain() {
        val tab = host.tabs.get("tab_demo") ?: run {
            note("  no WebView for tab_demo")
            return
        }
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(ASK_AGAIN_JS) { latch.countDown() }
        }
        latch.await(5, TimeUnit.SECONDS)
    }

    /** Poll the tab's blocked count up to `n` and hand back the state then. */
    private fun waitForBlocked(n: Int, timeoutMs: Long = 20_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab != null && tab.optInt("blockedCount") >= n) {
                SystemClock.sleep(1_000)
                return state()
            }
            SystemClock.sleep(400)
            s = state()
        }
        Log.w(tag, "blockedCount never reached $n")
        return s
    }

    /** Poll the tab's title (the page writes its tally into it) and hand back the state then. */
    private fun waitForTitle(prefix: String, timeoutMs: Long = 20_000): JSONObject {
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
        Log.w(tag, "title '$prefix' never showed up")
        return s
    }

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

    private fun describeEngine(): String =
        "${engine.snapshot.filterCount} network filters from ${engine.snapshot.setCount} sets, " +
            "last build ${engine.lastBuildMs} ms (${engine.builds} builds)"

    /** The tab's url, title and counter plus the session total. */
    private fun describeTab(s: JSONObject): String {
        val tab = s.getJSONObject("tabs").optJSONObject("tab_demo") ?: return "tab_demo gone"
        return "url=${tab.optString("url")} title=\"${tab.optString("title")}\" " +
            "blockedCount=${tab.optInt("blockedCount")} sessionBlocked=${s.getJSONObject("blocking").optInt("sessionBlocked")}"
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the page's server ----------------------------------------------------------------------

    /** Serves the demo page on the IPv4 loopback: `/` is the page, `/ok.js` and `/ok.png` its own resources. */
    private class LoopbackPage(private val page: String, port: Int) : Thread("blocking-ui-demo-server") {
        private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        @Volatile private var closed = false

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", socket.localPort).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET / HTTP/1.1\r\nHost: 127.0.0.1:${socket.localPort}\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                "listening on ${socket.localSocketAddress}, GET / -> ${s.getInputStream().bufferedReader().readLine()}"
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
        /** The port the seeded tab's URL names (`blocking-demo-state.json`). */
        private const val PORT = 18123
        private const val DEMO_ORIGIN = "http://127.0.0.1:$PORT"
        /** How Settings names the site (`exceptionHost`: scheme and host for anything but https). */
        private const val DEMO_SITE = DEMO_ORIGIN
        private const val SECTION = "Privacy and Security"
        /** The first chip of the section strip: on screen as soon as Settings is. */
        private const val FIRST_SECTION = "Look and Feel"
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"

        /** The page's nine third-party resources once more, as the page itself asks for them. */
        private val ASK_AGAIN_JS = """
            (function () {
              var again = Date.now()
              var r = [
                ['s', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'],
                ['s', 'https://static.doubleclick.net/instream/ad_status.js'],
                ['s', 'https://cdn.taboola.com/libtrc/unip/1/tfa.js'],
                ['s', 'https://c.amazon-adsystem.com/aax2/apstag.js'],
                ['s', 'https://www.googletagmanager.com/gtag/js?id=G-DEMO'],
                ['s', 'https://www.google-analytics.com/analytics.js'],
                ['s', 'https://connect.facebook.net/en_US/fbevents.js'],
                ['s', 'https://static.hotjar.com/c/hotjar-1.js?sv=6'],
                ['i', 'https://sb.scorecardresearch.com/p?c1=2&c2=1']
              ]
              r.forEach(function (x) {
                var url = x[1] + (x[1].indexOf('?') < 0 ? '?' : '&') + 'again=' + again
                if (x[0] === 's') { var el = document.createElement('script'); el.async = true; el.src = url; document.body.appendChild(el) }
                else { new Image().src = url }
              })
              return r.length
            })()
        """.trimIndent()
    }
}
