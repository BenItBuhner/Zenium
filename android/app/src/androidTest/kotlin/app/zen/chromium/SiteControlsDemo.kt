package app.zen.chromium

import android.graphics.Rect
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
 * preview, Safety check and the site-information snapshot; then the chrome on those: the
 * Settings tab's Privacy and Security rows (Safety check, the Clear browsing data form sheet,
 * Site settings with a type's sheet and picker) and the menu sheet.
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

        // 2. The page asks for the location: the in-chrome prompt, answered with Allow. The chrome
        //    has painted first: on the runner's software renderer its first frames take seconds
        //    each while the feeds load alongside, and in run 35385072693 the first request went
        //    by unprompted in that window (the second, 15 s later, prompted at once).
        note("\n2. location prompt, Allow")
        note("  first paint: ${waitForFirstPaint()}")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$DEMO_URL?set=1&ask=1"}""")
        var prompt = waitForPrompt(30_000)
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

        // 7. The chrome on those results: the Settings tab's Privacy and Security category (#134:
        //    Settings is a tab of the phone chrome, its rows from the builder), where this PR's
        //    groups sit in Chrome's order – Safety check (the standing, Check now, a row per
        //    area), Clear browsing data (one row whose sheet is the form: Basic, then Advanced,
        //    the range picker over it), Site settings (the catalogue, a type's sheet with its
        //    default and the sites that answered, the §9.13 picker over that, the sites with
        //    their own settings) – and the menu sheet with New Private Tab. The tab is opened by
        //    the core's `page.open` (what the menu's Settings row and a `zenium://settings/privacy`
        //    deep link both run; the menu sheet is recorded on its own at the end). Every sheet is
        //    opened and worked by a real finger and what the finger did is asserted, never that a
        //    sheet went away (the rule in DemoHarness): Check now by the check's new time, a row by
        //    the control its sheet shows, Advanced by the rows it reveals.
        note("\n7. the chrome: the Settings tab's privacy rows, the clear-data sheet, the menu sheet")
        invoke("permissions.set", """{"origin":"$ORIGIN","permission":"camera","decision":"deny"}""")
        val settingsTab = openPrivacySettings()
        if (settingsTab != null) {
            // Safety check: the standing at the top, Check now under a finger, the rows after it.
            val checkedBefore = state().optJSONObject("lastSafetyCheck")?.optLong("checkedAt") ?: 0L
            if (touchRowExpecting("Check now", "the check ran again (lastSafetyCheck.checkedAt moved)", 20_000) {
                    (state().optJSONObject("lastSafetyCheck")?.optLong("checkedAt") ?: 0L) > checkedBefore
                }
            ) {
                // The results group is rebuilt by the run; its rows come back into the tree one by
                // one (the run at 8adeb628 read Updates and Site permissions while Passwords, on
                // screen, was not in the tree yet): the last row of the group is the one waited for.
                awaitRow("Extensions", 10_000)
                SystemClock.sleep(1_500)
                note("  safety check rows: ${rowText("Updates")} | ${rowText("Passwords")} | ${rowText("Site permissions")}")
                shot("13-safety-check-results")
                beat()
            }

            // Clear browsing data: the row's form sheet, Basic; Advanced reveals its rows; the range
            // picker stacks over the form (§9.24); Cancel closes it.
            if (touchRowExpecting("Clear browsing data", "the form sheet shows Clear data", 10_000) { findByLabel("Clear data") != null }) {
                SystemClock.sleep(SHEET_SETTLE)
                shot("11-clear-data-basic")
                beat()
                if (touchRowExpecting("Advanced", "the Advanced rows show (Download history)", 8_000) { rowNode("Download history") != null }) {
                    SystemClock.sleep(SHEET_SETTLE)
                    shot("12-clear-data-advanced")
                    beat()
                }
                if (touchRowExpecting("Time range", "the range picker shows All time", 8_000) { findByLabel("All time") != null }) {
                    SystemClock.sleep(SHEET_SETTLE)
                    shot("12b-clear-data-range")
                    beat()
                    backUntil("the range picker is gone and the form's Time range row is back") {
                        findByLabel("All time") == null && rowNode("Time range")?.isClickable == true
                    }
                }
                if (!touchRowExpecting("Cancel", "the form sheet closes", 8_000) { findByLabel("Clear data") == null }) {
                    backUntil("the form sheet is gone") { findByLabel("Clear data") == null }
                }
                awaitRow("Clear browsing data", 8_000)
                SystemClock.sleep(600)
            }

            // Site settings: the catalogue (Camera among it), Camera's sheet with the default as a
            // value row and the demo host's answer under it (rows read the origin's host with its
            // port, `127.0.0.1:18124`), the default's picker over the sheet, then the sites with
            // settings of their own.
            if (awaitRow("Camera", 8_000, show = true) != null) {
                SystemClock.sleep(1_200)
                shot("09-site-settings-catalogue")
                beat()
                if (touchRowExpecting("Camera", "the Camera sheet shows its Default behaviour row", 10_000) { rowNode("Default behaviour") != null }) {
                    SystemClock.sleep(SHEET_SETTLE)
                    note("  Camera sheet: ${rowText("Default behaviour")}; $HOST ${if (rowNode(HOST) != null) "listed" else "NOT listed"} under Sites with their own answer")
                    shot("10b-site-settings-camera-sheet")
                    beat()
                    if (touchRowExpecting("Default behaviour", "the picker shows the Block option", 8_000) { findByLabel("Block") != null }) {
                        SystemClock.sleep(SHEET_SETTLE)
                        shot("10c-site-settings-picker")
                        beat()
                        // The Camera sheet's value row (clickable) is back in the tree once the
                        // picker over it has gone; the picker's own header reads the same words
                        // but is no control.
                        backUntil("the picker is gone and the Camera sheet's Default behaviour row is back") {
                            findByLabel("Block") == null && rowNode("Default behaviour")?.isClickable == true
                        }
                    }
                    // The catalogue's Camera row (clickable) is back once the sheet has gone; the
                    // sheet's title reads Camera too, as a plain node.
                    backUntil("the Camera sheet is gone and the catalogue is back") {
                        rowNode("Default behaviour") == null && rowNode("Camera")?.isClickable == true
                    }
                }
            }
            if (reveal("Sites with their own settings") != null && awaitRow(HOST, 8_000, show = true) != null) {
                SystemClock.sleep(1_200)
                shot("10-site-settings-sites")
                beat()
            }
            note("  site rules: ${invoke("permissions.listForPermission", """{"permission":"camera"}""")}")
            closeSettingsTab(settingsTab)
        }

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

    // --- the Settings tab -----------------------------------------------------------------------

    /**
     * The Settings tab at Privacy and Security through the core's `page.open` (the menu's
     * Settings row and a `zenium://settings/privacy` deep link run the same), the section over
     * its landing; the new tab's id as the core's JSON once its first group's heading is in the
     * tree, null when it never came. The Settings page is a chunk of its own that loads on its
     * first open, so the wait is generous.
     */
    private fun openPrivacySettings(): String? {
        val id = invoke("page.open", """{"id":"settings","section":"privacy"}""")
        note("  page.open settings/privacy -> $id")
        if (waitFor("Safety check", 20_000) == null) {
            note("  settings: the Privacy and Security category never showed")
            return null
        }
        SystemClock.sleep(2_000)
        return id
    }

    /**
     * Back closes the section over the landing (the chrome holds the back for it, on camera);
     * the tab itself goes through the core, the way the Settings tab demo leaves it, and the
     * demo page's tab is active again for the menu sheet. The section's first heading is in the
     * tree only while no sheet stands over it (a surface under a sheet is inert and out of the
     * tree): it is waited for, and a sheet still up after that is backed out of first.
     */
    private fun closeSettingsTab(id: String) {
        if (waitFor("Safety check", 6_000) == null) {
            backUntil("the sheet left over is gone and the section is back in the tree") { findByLabel("Safety check") != null }
        }
        if (findByLabel("Safety check") != null) {
            back()
            SystemClock.sleep(1_500)
        }
        if (activeCoreTab()?.optString("id") != "tab_demo") {
            invoke("tab.close", """{"tabId":$id}""")
            SystemClock.sleep(1_500)
        }
        if (activeCoreTab()?.optString("id") != "tab_demo") {
            invoke("tab.activate", """{"tabId":"tab_demo"}""")
            SystemClock.sleep(1_500)
        }
        note("  settings closed; active ${activeCoreTab()?.optString("id")}, tabs ${state().getJSONObject("tabs").length()}")
    }

    /**
     * The row (or control) reading `label`: a Settings row is one button whose text runs its
     * label and description together ("Camera Sites can ask to use your camera"), a group
     * heading of the same words is a plain node before it in the tree, so the clickable node
     * reading the label alone or the label and a space wins; any node reading it otherwise.
     */
    private fun rowNode(label: String): AccessibilityNodeInfo? {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label "))
        }
        return findNodeWhere { node -> node.isClickable && reads(node) } ?: findNodeWhere(reads)
    }

    /** What the row reading `label` says in full ("" when there is none). */
    private fun rowText(label: String): String =
        rowNode(label)?.let { (it.text ?: it.contentDescription)?.toString() }.orEmpty()

    /**
     * Poll up to `timeoutMs` for the row reading `label`, with `show` scrolled onto the screen
     * (the chrome scrolls its list the least it has to); its bounds then, null when it never came.
     */
    private fun awaitRow(label: String, timeoutMs: Long, show: Boolean = false): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val node = rowNode(label)
            if (node != null) {
                if (show) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_500)
                }
                return (rowNode(label) ?: node).let { n -> Rect().also { n.getBoundsInScreen(it) } }
            }
            SystemClock.sleep(200)
        }
        note("  no row reads '$label'")
        return null
    }

    /**
     * One system back on a sheet, then up to `timeoutMs` for `took` – what the tree shows once
     * the sheet has gone and the surface under it is back in it, named by `effect` – to hold.
     * Never a fixed sleep: the emulator's software renderer paints a dismissal seconds late, and
     * a second back sent on a sleep lands on the sheet still standing there and is absorbed (the
     * run at 8adeb628: the Camera sheet stayed and the sites with their own settings went
     * unrecorded). False and a note when the tree never showed it; the recording goes on.
     */
    private fun backUntil(effect: String, timeoutMs: Long = 12_000, took: () -> Boolean): Boolean {
        back()
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                SystemClock.sleep(600)
                return true
            }
            SystemClock.sleep(200)
        }
        note("  after back: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * A real touch on the row reading `label` (scrolled onto the screen first), then up to
     * `timeoutMs` for `took` – the claim of the step, named by `effect` – to hold. The shape of a
     * sheet step under the rule in DemoHarness: false and a touch fault when the touch went in
     * and nothing came of it; false and a note when there was no such row to touch.
     */
    private fun touchRowExpecting(label: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        awaitRow(label, 8_000, show = true) ?: return false
        val node = rowNode(label) ?: return false
        if (!touchTap(node)) {
            note("  the row '$label' is not inside the touchable window")
            return false
        }
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                note("  touch on '$label': $effect")
                return true
            }
            SystemClock.sleep(150)
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        note("  TOUCH FAULT: '$label' did not $effect")
        return false
    }

    // --- the chrome's first frames --------------------------------------------------------------

    /**
     * Two animation frames of the chrome WebView, which the compositor grants only once it
     * presents frames, up to 30 s: the chrome has painted and the emulator's renderer is
     * keeping up before the page is asked to prompt. What it took, for the notes.
     */
    private fun waitForFirstPaint(timeoutMs: Long = 30_000): String {
        val started = SystemClock.uptimeMillis()
        js("window.__painted=0;requestAnimationFrame(function(){requestAnimationFrame(function(){window.__painted=1})})")
        val deadline = started + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (js("window.__painted") == "1") return "two frames after ${SystemClock.uptimeMillis() - started} ms"
            SystemClock.sleep(250)
        }
        return "no second frame within $timeoutMs ms"
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
        /** What the Settings rows call the origin (`hostOf`: the URL's host, port included). */
        private const val HOST = "127.0.0.1:$PORT"
        private const val ORIGIN = "http://$HOST"
        private const val DEMO_URL = "$ORIGIN/"
        /** A sheet's slide, with the margin the software-rendered emulator needs. */
        private const val SHEET_SETTLE = 2_500L
    }
}
