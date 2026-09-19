package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
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
 * as the demo page asks nine real ad and tracking hosts again, then the Settings tab's Privacy
 * and Security section (`pages/settings/tracking.tsx`: the master switch, the level as a picker
 * sheet, the counter, the filter lists as item rows with a sheet each, the sites without
 * blocking), a level change the Kotlin engine follows, the current site excepted from its switch
 * row and blocked again from its item's sheet, and the master switch off and on.
 *
 * Every row is found through the chrome's accessibility tree the way a screen reader would (a
 * row is one button whose text runs its label and description together) and tapped at its
 * bounds; the outcome is checked against the core's state through `window.zen` and the engine's
 * snapshot, and written to `<shotPrefix>-notes.txt` next to the screenshots. The page comes from
 * a loopback server in this process, as in [BlockingDemo].
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
            coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
            val tab = waitForTitle("9/9", 15_000).getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab?.optString("title")?.startsWith("9/9") == true) break
            Log.w(tag, "attempt $attempt: page settled at '${tab?.optString("title")}'")
            SystemClock.sleep(3_000)
        }
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, the demo page active).
        val warm = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        val painted = awaitChrome("document.querySelector('[data-row=\"tracking-enabled\"]')", 15_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        ensureDemoTab()
        note("warm-up: the Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
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

        // 3. Settings > Privacy and Security from the app menu: the tab, then the section.
        note("\n3. Settings > Privacy and Security")
        if (!openPrivacySettings(throughMenu = true)) {
            note("  Settings did not open; the rest of the sequence needs it")
            return
        }
        note("  counter row: ${rowText("Blocked since Zenium started") ?: "(not in the accessibility tree)"}")
        shot("04-settings-privacy")
        beat()

        // 4. The level: the picker sheet, Balanced -> Strict adds uBlock Origin's privacy list; the engine follows.
        note("\n4. level Balanced -> Strict through the picker sheet")
        val before = engine.snapshot.setCount
        if (openPicker("Level", "tracking-level", "Strict")) {
            SystemClock.sleep(600)
            shot("05-level-picker")
            beat()
            if (pickOption("Strict") { level() == "strict" }) {
                note("  level=${level()} engine followed in ${waitForEngine { it.setCount > before }} ms (${describeEngine()})")
                awaitNoSheet()
                revealRow("Level")
                SystemClock.sleep(600)
                shot("06-level-strict")
                beat()
            } else {
                note("  the Strict option did not take (level=${level()})")
                closeSheets()
            }
        } else {
            note("  the Level row did not open its picker")
        }
        note("\n   level Strict -> Balanced")
        val strictSets = engine.snapshot.setCount
        if (openPicker("Level", "tracking-level", "Balanced") && pickOption("Balanced") { level() == "balanced" }) {
            note("  level=${level()} engine followed in ${waitForEngine { it.setCount < strictSets }} ms (${describeEngine()})")
            awaitNoSheet()
        } else {
            note("  the Balanced option did not take (level=${level()}); setting it through the command")
            closeSheets()
            setLevel("balanced")
        }

        // 5. The filter lists as item rows, and one list's sheet.
        note("\n5. filter lists")
        if (revealRow("Filter lists") != null) {
            SystemClock.sleep(600)
            note("  lists: ${describeLists(blockingStatus())}")
            shot("07-filter-lists")
            beat()
        }
        if (tapRow("EasyList", "tracking-list:easylist") { rowBounds("Use this list", 0) != null }) {
            SystemClock.sleep(800)
            shot("08-list-sheet")
            beat()
            closeSheets()
        } else {
            note("  the EasyList row did not open its sheet")
        }

        // 6. Sites without blocking: the current site's switch row, off to except it.
        note("\n6. per-site exception from the current site's row")
        if (revealRow("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("09-sites")
            beat()
        }
        if (setSiteRow(excepted = true)) {
            note("  siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
            revealRow("Block on $DEMO_SITE")
            SystemClock.sleep(1_200)
            shot("10-site-excepted")
            beat()
        } else {
            note("  the row did not toggle; excepting through the command")
            coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":true}""")
        }

        // 7. The page again: nothing blocked, the chip says so.
        note("\n7. the excepted page")
        ensureDemoTab()
        coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
        s = waitForTitle("0/9", 25_000)
        note("  ${describeTab(s)}")
        note("  chip: ${chipLabel() ?: "(not in the accessibility tree)"}")
        shot("11-page-excepted")
        beat()

        // 8. Back in Settings the site is an item row; its sheet's action blocks on it again.
        note("\n8. the exception's row and its sheet")
        if (openPrivacySettings(throughMenu = false) && revealRow("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("12-sites-excepted-row")
            beat()
            if (tapRow(DEMO_SITE, "tracking-site:$DEMO_ORIGIN") { rowBounds("Block on this site again", 0) != null }) {
                SystemClock.sleep(800)
                shot("13-site-sheet")
                beat()
                if (tapRow("Block on this site again", "tracking-site:$DEMO_ORIGIN:block") { !siteExcepted() }) {
                    note("  after the sheet's action: siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
                    awaitNoSheet()
                    SystemClock.sleep(1_200)
                    shot("14-sites-blocked-again")
                    beat()
                } else {
                    note("  the sheet's action did not take; resetting through the command")
                    closeSheets()
                    coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":false}""")
                }
            } else {
                note("  the site's row did not open its sheet; resetting through the command")
                coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":false}""")
            }
        }

        // 9. The master switch: off (the dependent rows dim to 40 %), on again.
        note("\n9. master switch")
        if (setMasterSwitch(enabled = false)) {
            note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount == 0 }} ms")
            revealRow("Block ads and trackers")
            SystemClock.sleep(1_200)
            note("  counter row: ${rowText("Blocked since Zenium started")}")
            shot("15-master-off")
            beat()
            if (setMasterSwitch(enabled = true)) {
                note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount > 0 }} ms")
                SystemClock.sleep(1_200)
                note("  counter row: ${rowText("Blocked since Zenium started")}")
                shot("16-master-on")
                beat()
            }
        } else {
            note("  the master switch row did not toggle")
        }

        // 10. The page once more: blocked again, the session total higher than before.
        note("\n10. the page, blocked again")
        ensureDemoTab()
        coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
        s = waitForTitle("9/9", 25_000)
        note("  ${describeTab(s)}")
        shot("17-page-blocked-again")
        note("\ndone")
    }

    // --- the Settings tab through the accessibility tree ------------------------------------------

    private val host: Host get() = (activity as MainActivity).host

    /**
     * The Privacy and Security section of the Settings tab: from the app menu (Settings, then the
     * category row on the landing) the first time, through `page.open` – which reuses the tab and
     * takes it to the section – after. True once the section's first row is in the tree.
     */
    private fun openPrivacySettings(throughMenu: Boolean): Boolean {
        ensureForeground()
        if (throughMenu) {
            if (!openMenuItem("Settings")) {
                Log.w(tag, "no Settings in the app menu")
                closeSheets()
                return false
            }
            if (awaitPage(SETTINGS_URL, 12_000) == null) {
                Log.w(tag, "Settings did not come up")
                return false
            }
            SystemClock.sleep(1_200)
            val category = rowBounds(SECTION, 8_000) ?: run {
                Log.w(tag, "no $SECTION category on the landing")
                return false
            }
            Finger().tap(category.exactCenterX(), category.exactCenterY())
        } else {
            coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        }
        if (awaitPage("$SETTINGS_URL/privacy", 12_000) == null) {
            Log.w(tag, "the tab did not come to the section")
            return false
        }
        awaitSurface(up = true, timeoutMs = 6_000)
        val there = rowBounds("Block ads and trackers", 10_000) != null
        SystemClock.sleep(800)
        return there
    }

    /** Back to the demo page's tab through the core (the Settings tab stays open behind it). */
    private fun ensureDemoTab() {
        if (activeCoreTab()?.optString("id") == DEMO_TAB) return
        coreInvoke("tab.activate", """{"tabId":"$DEMO_TAB"}""")
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && activeCoreTab()?.optString("id") != DEMO_TAB) SystemClock.sleep(250)
        SystemClock.sleep(1_000)
    }

    /** Poll until the active tab shows `url`; that tab, or null when it does not come in time. */
    private fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return null
    }

    /**
     * The bounds of the first node whose accessible text reads `text` – exactly or as a prefix: a
     * Settings row is one button whose text runs its label and description together, and a
     * label's own span answers too. Polls, since the tree trails the screen on the emulator; a
     * node the list holds below the fold is scrolled into view first.
     */
    private fun rowBounds(text: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var revealed = false
        do {
            val node = findNode { it == text || it.startsWith(text) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val onScreen = bounds.width() > 0 && bounds.height() > 0 &&
                    bounds.centerY() in 0 until height && bounds.centerX() in 0 until width
                if (onScreen) return bounds
                if (!revealed) {
                    revealed = true
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_000)
                    continue
                }
            }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    /** Scroll the row reading `text` into view; where it is then, or null when it is not there. */
    private fun revealRow(text: String): Rect? = rowBounds(text, 6_000)

    /** The whole text of the row reading `text` (its label and description as the tree runs them). */
    private fun rowText(text: String): String? =
        findNode { it.startsWith(text) }?.let { it.text ?: it.contentDescription }?.toString()

    /**
     * Tap the row reading `label` and wait for `settled`: at the bounds the tree reports first,
     * then – the tree trailing the screen by seconds on the software-rendered emulator – at the
     * row's own rectangle in the chrome (`data-row` is the row's id). False when the row is not
     * there or the change never came.
     */
    private fun tapRow(label: String, rowId: String, settled: () -> Boolean): Boolean {
        if (settled()) return true
        val bounds = rowBounds(label, 8_000)
        if (bounds == null) Log.w(tag, "no row reading '$label' in the tree") else {
            SystemClock.sleep(400)
            Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
            if (awaitSettled(settled, 5_000)) return true
            Log.w(tag, "'$label' did not take at the tree's bounds; tapping the chrome's own rectangle")
        }
        val point = chromePoint("[data-row=${JSONObject.quote(rowId)}]") ?: run {
            Log.w(tag, "no row $rowId in the chrome")
            return false
        }
        Finger().tap(point.x, point.y)
        return awaitSettled(settled, 5_000)
    }

    /** Open a value row's picker sheet; true once the option reading `option` is in the tree. */
    private fun openPicker(label: String, rowId: String, option: String): Boolean =
        tapRow(label, rowId) { findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(option) == true } != null }

    /** Tap the picker's option reading `option`; true once the core reports the change (`settled`). */
    private fun pickOption(option: String, settled: () -> Boolean): Boolean {
        val node = findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(option) == true }
            ?: run {
                Log.w(tag, "no option reading '$option' in the picker")
                return false
            }
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
        if (awaitSettled(settled, 5_000)) return true
        Log.w(tag, "'$option' did not take at the tree's bounds; clicking it through the tree")
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        return awaitSettled(settled, 5_000)
    }

    private fun awaitSettled(settled: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** How many sheets the chrome has mounted (a closing one counts until its spring has carried it out). */
    private fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    /** Wait for the last sheet to leave (a picker closes on its pick, an item's sheet with its row). */
    private fun awaitNoSheet() {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline && sheetCount() != 0) SystemClock.sleep(200)
    }

    /** Back out of the sheets that are up, a few at most; the section itself stays. */
    private fun closeSheets() {
        repeat(3) {
            if (sheetCount() <= 0) return
            back()
            SystemClock.sleep(900)
        }
        awaitNoSheet()
    }

    /** The master switch through its row; true once the core reports `enabled`. */
    private fun setMasterSwitch(enabled: Boolean): Boolean =
        tapRow("Block ads and trackers", "tracking-enabled") { blockingStatus().getBoolean("enabled") == enabled }

    /** The current site's switch row; true once the core lists (or no longer lists) the site's exception. */
    private fun setSiteRow(excepted: Boolean): Boolean =
        tapRow("Block on $DEMO_SITE", "tracking-site-current") { siteExcepted() == excepted }

    private fun setLevel(level: String) {
        val b = coreState().getJSONObject("settings").getJSONObject("blocking")
        b.put("level", level)
        coreInvoke("settings.update", JSONObject().put("blocking", b).toString())
    }

    private fun siteExcepted(): Boolean {
        val sites = blockingStatus().getJSONArray("siteExceptions")
        return (0 until sites.length()).any { sites.getString(it) == DEMO_ORIGIN }
    }

    /** The chip's accessible label in the pill (`<n> requests blocked on this page · Site information`). */
    private fun chipLabel(): String? =
        findNode { it.contains("Site information") && (it.contains("blocked") || it.contains("Nothing")) }
            ?.let { it.contentDescription ?: it.text }?.toString()

    // --- the chrome's bridge --------------------------------------------------------------------

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String =
        runCatching { org.json.JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /** Where the middle of the first chrome element matching `selector` is on screen, or null. */
    private fun chromePoint(selector: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    private fun blockingStatus(): JSONObject = coreState().getJSONObject("blocking")

    private fun level(): String = coreState().getJSONObject("settings").getJSONObject("blocking").optString("level")

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
        val tab = host.tabs.get(DEMO_TAB) ?: run {
            note("  no WebView for $DEMO_TAB")
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
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab != null && tab.optInt("blockedCount") >= n) {
                SystemClock.sleep(1_000)
                return coreState()
            }
            SystemClock.sleep(400)
            s = coreState()
        }
        Log.w(tag, "blockedCount never reached $n")
        return s
    }

    /** Poll the tab's title (the page writes its tally into it) and hand back the state then. */
    private fun waitForTitle(prefix: String, timeoutMs: Long = 20_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return coreState()
            }
            SystemClock.sleep(500)
            s = coreState()
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
        val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB) ?: return "$DEMO_TAB gone"
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
        private const val DEMO_TAB = "tab_demo"
        /** How Settings names the site (`exceptionHost`: scheme and host for anything but https). */
        private const val DEMO_SITE = DEMO_ORIGIN
        private const val SECTION = "Privacy and Security"
        private const val SETTINGS_URL = "zen://settings"

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
