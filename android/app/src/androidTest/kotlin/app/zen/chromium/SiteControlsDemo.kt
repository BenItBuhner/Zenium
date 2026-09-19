package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
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
 * Records the site controls engine on the phone: a page asking for the location and the
 * in-chrome permission prompt that answers it (Allow remembered for the site, Allow once kept for
 * the tab), a private tab on its own WebView profile (the normal profile's cookie is not there,
 * its own cookie is gone once the last private tab closes), Clear browsing data with its count
 * preview, Safety check and the site-information snapshot; then the chrome on those: Settings >
 * Site settings, the Clear browsing data sheet, Settings > Safety check and the menu sheet.
 *
 * The page comes from a loopback HTTP server inside this process and reports what it sees
 * through its title, which the driver reads from the core's state. Command results are written
 * to `<shotPrefix>-notes.txt` next to the screenshots. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SiteControlsDemo : DemoHarness("site-controls-demo-state.json", "services-site-controls-android", "site-controls-demo") {
    override val tag = "SiteControlsDemo"
    private lateinit var server: DemoServer
    private lateinit var notes: File

    @Test
    fun record() {
        server = DemoServer(readAsset("site-controls-demo-page.html"), PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "services-site-controls-android-notes.txt")
        notes.writeText("Zenium Android site controls demo\n\n")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}")
        val s = state()
        note("capabilities.privateTabs=${s.getJSONObject("capabilities").optBoolean("privateTabs")}")
        // The seeded tab stores a cookie and a storage key on the default profile as it loads.
        val tab = waitForTitle("SC|cookie:yes|storage:yes", 20_000)
        note("seeded tab: ${describeTab(tab)}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The normal tab with its data.
        note("\n1. normal tab, data stored on the default profile")
        shot("01-normal-tab-with-data")
        beat()

        // 2. The page asks for the location: the in-chrome prompt, answered with Allow.
        note("\n2. location prompt, Allow")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL?set=1&ask=1"}""")
        var prompt = waitForPrompt()
        note("  prompt: ${prompt?.toString() ?: "none"}")
        if (prompt != null) {
            waitFor("Allow", 8_000)
            SystemClock.sleep(1_200)
            shot("02-prompt-location")
            beat()
            answer("Allow")
            val tab = waitForTitle("granted", 15_000, contains = true)
            note("  after Allow: ${describeTab(tab)}")
            note("  rules for geolocation: ${invoke("permissions.listForPermission", """{"permission":"geolocation"}""")}")
            SystemClock.sleep(800)
            shot("03-location-granted")
            beat()
        }

        // 3. Forget the decision; the page asks again and gets Allow once: nothing is stored.
        note("\n3. decision forgotten, prompt again, Allow once")
        invoke("permissions.resetOrigin", """{"origin":"$ORIGIN"}""")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL?ask=1"}""")
        prompt = waitForPrompt()
        note("  prompt: ${prompt?.toString() ?: "none"}")
        if (prompt != null) {
            waitFor("Allow once", 8_000)
            SystemClock.sleep(1_000)
            shot("04-prompt-location-again")
            answer("Allow once")
            val tab = waitForTitle("granted", 15_000, contains = true)
            note("  after Allow once: ${describeTab(tab)}")
            note("  rules for geolocation: ${invoke("permissions.listForPermission", """{"permission":"geolocation"}""")}")
            // The same tab asks once more: the once-grant holds, no prompt.
            invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
            SystemClock.sleep(2_500)
            note("  reload of the tab: prompts=${state().getJSONArray("permissionPrompts").length()} ${describeTab(waitForTitle("granted", 15_000, contains = true))}")
            beat()
        }

        // 4. A private tab: the default profile's cookie is not there; its own cookie is, until
        //    the last private tab closes and the profile is wiped.
        note("\n4. private tab on its own profile")
        val privateId = newPrivateTab("$DEMO_URL?peek=1&private=1")
        if (privateId == null) {
            note("  tab.newPrivate returned null (capabilities.privateTabs=${state().getJSONObject("capabilities").optBoolean("privateTabs")})")
        } else {
            var tab = waitForTitle("SC|cookie:no|storage:no", 20_000, tabId = privateId)
            note("  fresh private tab: ${describeTab(tab, privateId)}")
            SystemClock.sleep(800)
            shot("05-private-tab-isolated")
            beat()
            invoke("tab.navigate", """{"tabId":"$privateId","input":"$DEMO_URL?set=1&private=1"}""")
            tab = waitForTitle("SC|cookie:yes|storage:yes", 20_000, tabId = privateId)
            note("  private tab after storing: ${describeTab(tab, privateId)}")
            SystemClock.sleep(800)
            shot("06-private-tab-own-data")
            beat()
            invoke("tab.close", """{"tabId":"$privateId"}""")
            SystemClock.sleep(3_500)
            note("  closed; tabs left: ${state().getJSONObject("tabs").length()}")
            val again = newPrivateTab("$DEMO_URL?peek=1&private=1")
            if (again != null) {
                tab = waitForTitle("SC|cookie:", 20_000, tabId = again)
                note("  new private tab after the wipe: ${describeTab(tab, again)}")
                SystemClock.sleep(800)
                shot("07-private-tab-after-wipe")
                beat()
                invoke("tab.close", """{"tabId":"$again"}""")
                SystemClock.sleep(2_500)
            }
            // The normal tab kept its data all along.
            invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL?peek=1"}""")
            note("  normal tab meanwhile: ${describeTab(waitForTitle("SC|cookie:", 15_000))}")
        }

        // 5. Clear browsing data: the preview counts, the clearing, the page without its data.
        note("\n5. clear browsing data")
        note("  counts (all time): ${invoke("privacy.clearBrowsingDataCounts", """{"range":"all"}""")}")
        note("  cleared: ${invoke("privacy.clearBrowsingData", """{"range":"all","types":["cookies","cache"]}""")}")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL?peek=1&cleared=1"}""")
        val cleared = waitForTitle("SC|cookie:no|storage:no", 20_000)
        note("  normal tab after clearing: ${describeTab(cleared)}")
        note("  counts after: ${invoke("privacy.clearBrowsingDataCounts", """{"range":"all"}""")}")
        SystemClock.sleep(800)
        shot("08-normal-tab-after-clear")
        beat()

        // 6. Safety check and the site-information snapshot: engine results for the UI PR.
        note("\n6. safety check and site-info snapshot")
        note("  safetyCheck: ${invoke("privacy.safetyCheck")}")
        note("  siteInfo.snapshot: ${invoke("siteInfo.snapshot", """{"tabId":"tab_demo"}""")}")
        note("  permissions.defaults: ${invoke("permissions.defaults")}")

        // 7. The chrome on those results: Settings > Site settings (the catalogue and a site with
        //    its own rule), Clear browsing data as a sheet (Basic, then Advanced), Safety check
        //    with its rows, and the menu sheet with New Private Tab.
        //
        //    The panel is opened by the action behind the menu's Settings row, not through the
        //    sheet, and the three sections are visited inside the one panel: on the emulator the
        //    sheet closing and the panel opening back to back – the page shown again, its stand-in
        //    read once more, the page hidden – is where the host's software renderer died in four
        //    boots of five (a page fault on its RenderThread; runs 35355397692, 35356823798 and
        //    35359268332), while a surface opening over the page and closing back to it never did.
        //    The sheets slide in slowly there and the tree's bounds trail them, so every press
        //    waits for the sheet to settle and goes through the tree.
        note("\n7. the chrome: Settings sections, the clear-data sheet, the menu sheet")
        invoke("permissions.set", """{"origin":"$ORIGIN","permission":"camera","decision":"deny"}""")
        if (openSettings("Site Settings")) {
            waitFor("Camera", 8_000)
            SystemClock.sleep(1_200)
            shot("09-site-settings-catalogue")
            beat()
            if (reveal("Sites with their own settings") != null) {
                SystemClock.sleep(800)
                shot("10-site-settings-sites")
                beat()
            }
            note("  site rules: ${invoke("permissions.listForPermission", """{"permission":"camera"}""")}")
        }

        if (openSettings("Clear Browsing Data") && press(f, "Clear browsing data")) {
            waitFor("Clear data", 8_000)
            SystemClock.sleep(SHEET_SETTLE)
            shot("11-clear-data-basic")
            beat()
            if (press(f, "Advanced")) {
                SystemClock.sleep(SHEET_SETTLE)
                shot("12-clear-data-advanced")
                beat()
            }
            if (!press(f, "Cancel")) back()
            SystemClock.sleep(1_500)
        }

        if (openSettings("Safety Check") && press(f, "Check now")) {
            waitFor("Passwords", 15_000)
            SystemClock.sleep(1_500)
            shot("13-safety-check-results")
            beat()
        }
        closeSettings()

        tapMenuButton()
        SystemClock.sleep(SHEET_SETTLE)
        val privateItem = reveal("New Private Tab") != null
        note("  menu sheet: 'New Private Tab' ${if (privateItem) "shown" else "absent (capabilities.privateTabs=false)"}")
        shot("14-menu-sheet")
        beat()
        back()
        SystemClock.sleep(1_500)
        note("\ndone")
    }

    // --- settings ------------------------------------------------------------------------------

    /**
     * The Settings panel is up. On the phone the panel leaves the bar and its pill on screen, so
     * the pill says nothing about it; the panel's own close button is in the tree only while it
     * is open (run 35356823798 took the pill for "closed", pressed Settings in the menu once more
     * and toggled the panel away).
     */
    private fun settingsOpen(): Boolean = findByLabel(PANEL_CLOSE_LABEL) != null

    /**
     * The Settings panel through the action the menu's Settings row runs (`settings.open`, which
     * toggles the panel, so only when it is not up), then the section's chip in the row across
     * the top (the new sections sit past the right edge). False when the panel or the chip never
     * shows.
     */
    private fun openSettings(section: String): Boolean {
        if (!settingsOpen()) {
            invoke("urlbar.runCommand", """{"action":"settings.open"}""")
            if (waitFor(PANEL_CLOSE_LABEL, 10_000) == null) {
                note("  settings: the panel never opened")
                return false
            }
            SystemClock.sleep(2_000)
        }
        if (reveal(section) == null || !clickByLabel(section)) {
            note("  settings: no '$section' chip")
            return false
        }
        SystemClock.sleep(2_000)
        return true
    }

    /** Back closes what is open (a sheet, then the panel); the close button gone says it is done. */
    private fun closeSettings() {
        repeat(4) {
            if (!settingsOpen()) return
            back()
            SystemClock.sleep(1_500)
        }
        note("  settings: the panel stayed up through four backs")
    }

    /**
     * A press on the labelled control once it shows. The control itself when a node carrying the
     * label is clickable (a row button under a group heading of the same words: the heading
     * comes first in the tree and its nearest clickable ancestor is not the row, which is how run
     * 35361605577 pressed beside Clear browsing data), the nearest clickable ancestor of the
     * label otherwise, and a touch at the label's bounds when there is none. False when the
     * label never comes.
     */
    private fun press(f: Finger, label: String, timeoutMs: Long = 8_000): Boolean {
        val seen = waitFor(label, timeoutMs) ?: run {
            note("  no '$label' to press")
            return false
        }
        val shown = reveal(label) ?: seen
        val control = findNodeWhere { node ->
            node.isClickable &&
                (node.contentDescription?.toString() == label || node.text?.toString() == label)
        }
        when {
            control != null -> control.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            !clickByLabel(label) -> f.tap(shown.exactCenterX(), shown.exactCenterY())
        }
        SystemClock.sleep(600)
        return true
    }

    // --- the prompt -----------------------------------------------------------------------------

    /** The core's pending prompt for the demo tab, once it is there (null when none comes). */
    private fun waitForPrompt(timeoutMs: Long = 15_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val prompts = state().getJSONArray("permissionPrompts")
            for (i in 0 until prompts.length()) {
                val p = prompts.getJSONObject(i)
                if (p.optString("tabId") == "tab_demo") return p
            }
            SystemClock.sleep(300)
        }
        Log.w(tag, "no permission prompt showed up")
        return null
    }

    /**
     * A real touch on the prompt's button – the prompt sheet's injected touch (the rule in
     * DemoHarness), the page's title reporting the grant on it asserted – or the accessibility
     * click when the tree carries no bounds for it.
     */
    private fun answer(label: String) {
        val granted = { pageTitle().contains("granted") }
        if (!touchTapLabelExpecting(label, "the page reports the grant", timeoutMs = 15_000, took = granted) && !granted()) {
            Log.w(tag, "'$label' did not grant under a finger; clicking through the tree so the demo goes on")
            clickByLabel(label)
        }
        SystemClock.sleep(600)
    }

    /** The demo tab's title as the core has it right now ("" when the tab is gone). */
    private fun pageTitle(): String = state().getJSONObject("tabs").optJSONObject("tab_demo")?.optString("title").orEmpty()

    // --- private tabs ---------------------------------------------------------------------------

    private fun newPrivateTab(url: String): String? {
        val result = invoke("tab.newPrivate", """{"url":"$url"}""")
        if (result == "null") return null
        val id = (JSONTokener(result).nextValue() as? String) ?: return null
        val tab = state().getJSONObject("tabs").optJSONObject(id)
        note("  tab.newPrivate -> $id containerId=${tab?.optString("containerId")}")
        return id
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

    /** The tab's url and title (the page writes what it sees into its title). */
    private fun describeTab(s: JSONObject, tabId: String = "tab_demo"): String {
        val tab = s.getJSONObject("tabs").optJSONObject(tabId) ?: return "tab $tabId gone"
        return "tab $tabId containerId=${tab.optString("containerId")} url=${tab.optString("url")} title=\"${tab.optString("title")}\""
    }

    /** Poll the tab's title for `needle` (a prefix, or anywhere with `contains`) and hand back the state then. */
    private fun waitForTitle(
        needle: String,
        timeoutMs: Long = 20_000,
        tabId: String = "tab_demo",
        contains: Boolean = false
    ): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(tabId)
            val title = tab?.optString("title").orEmpty()
            val hit = if (contains) title.contains(needle) else title.startsWith(needle)
            if (tab != null && hit && !tab.optBoolean("loading")) {
                SystemClock.sleep(600)
                return state()
            }
            SystemClock.sleep(400)
            s = state()
        }
        Log.w(tag, "title '$needle' never showed up on $tabId")
        return s
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the page's server ----------------------------------------------------------------------

    /** Serves the demo page on the loopback interface, whatever the path. */
    private class DemoServer(private val page: String, private val port: Int) : Thread("site-controls-demo-server") {
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
                request.readLine() ?: return
                while (true) {
                    val header = request.readLine()
                    if (header.isNullOrEmpty()) break
                }
                val body = page.toByteArray()
                val out = it.getOutputStream()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
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
    }

    companion object {
        private const val PORT = 18124
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val DEMO_URL = "$ORIGIN/"
        /** A sheet's slide, with the margin the software-rendered emulator needs. */
        private const val SHEET_SETTLE = 2_500L
        /** The overlay panel's close button (`OverlayShell`, its `title`), in the tree only while a panel is up. */
        private const val PANEL_CLOSE_LABEL = "Close (Esc)"
    }
}
