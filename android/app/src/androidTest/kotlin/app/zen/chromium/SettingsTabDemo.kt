package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records Settings as a tab of the phone chrome (PR #134, v2 §10.1 to §10.5) for the
 * `android-settings-tab-demo` workflow, and writes what it measured to
 * `android-settings-tab-findings.txt` next to the frames (one `PASS` or `FAIL` per check; the
 * test itself only fails when the driver could not run):
 *
 *  1. Settings from the app menu opens a tab of its own next to the tab that asked, with its
 *     card in the tab overview;
 *  2. Look and Feel drills in over the landing; Colour scheme through the picker sheet flips the
 *     theme live;
 *  3. the predictive back gesture slides the drill-in out with the finger;
 *  4. away and back, the menu's Settings reuses the one tab (§10.1: one per window);
 *  5. back at the landing returns to the tab that opened it and closes the page tab
 *     (`rootBackAction`'s opener rule);
 *  6. `am start -a android.intent.action.VIEW -d zenium://settings/privacy`, as adb or another
 *     app sends it, opens the section with the landing beneath it;
 *  7. a web page's own link to `zenium://settings/privacy` is refused (only the user opens the
 *     browser's pages, never a document);
 *  8. Find in Settings "site" lists rows across categories;
 *  9. a container's editor sheet and its delete confirmation stack, the lower sheet receding;
 * 10. the pill edits `zenium://settings/look`, the user-facing alias of the page's address.
 *
 * The pages come from a loopback server inside this process ([DemoServer]); the profile
 * (`settings-tab-demo-state.json`) holds the demo page (active) and a second tab. Gesture
 * navigation is switched on before the app starts, since the back gesture is part of what is
 * recorded. Settings rows are whole buttons whose accessible text runs label and value together
 * ("Colour scheme Light"), so rows are found by the label as a prefix. See [DemoHarness] for the
 * plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SettingsTabDemo : DemoHarness("settings-tab-demo-state.json", "android-settings-tab", "settings-tab-demo") {
    override val tag = "SettingsTabDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(
                    DEMO_TITLE,
                    "<p>A page of the demo's own. Its link below names one of the browser's pages, " +
                        "which a web page may not open.</p>" +
                        "<p id=\"link\"><a href=\"zenium://settings/privacy\" " +
                        "onclick=\"document.getElementById('note').textContent='Link tapped: zenium://settings/privacy'\">" +
                        "Open Privacy and Security in Settings</a></p>" +
                        "<p id=\"note\" style=\"color:#7a2e2e\"></p>"
                ),
                "/other.html" to DemoServer.page("Second tab", "<p>The tab the demo does not visit.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** Gesture navigation and the predictive animations: the back gesture is what the recording is for. */
    override fun beforeLaunch() {
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        shell("settings put global enable_back_animation 1")
        // SystemUI re-inflates its bar; the insets the chrome measures at launch are the new ones.
        SystemClock.sleep(3_500)
    }

    override fun warmUp() {
        findings = File(out, "android-settings-tab-findings.txt")
        findings.writeText("Zenium Android Settings tab demo (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, the demo page active).
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = waitForText("Find in Settings", 12_000) != null
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(800)
        ensureActive(DEMO_TAB)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_500)
        finding("warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; ${describeActive()}")
    }

    override fun demo() {
        val before = tabCount()
        val demoTab = activeTabId()

        // 1. Settings from the app menu: a page tab of its own, next to the tab that asked.
        step("Settings from the app menu") {
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            val tab = awaitPage(SETTINGS_URL, 10_000)
            SystemClock.sleep(1_500)
            shot("01-landing")
            val opener = tab?.optString("openerTabId").orEmpty()
            finding(
                "  active ${tab?.optString("id")} ${tab?.optString("url")}, opener '$opener', tabs ${tabCount()} (were $before) " +
                    verdict(tab?.optString("url") == SETTINGS_URL && opener == demoTab && tabCount() == before + 1)
            )
        }

        // 2. Its card in the tab overview, with the page's glyph and title.
        step("The Settings tab's card in the overview") {
            val button = waitForText("Tabs (", 5_000) ?: run {
                finding("  no tab-count button on the bar")
                return@step
            }
            Finger().tap(button.exactCenterX(), button.exactCenterY())
            SystemClock.sleep(2_500)
            val cards = chromeValue(
                "(function(){var c=document.querySelectorAll('.zen-overview-card');var s=document.querySelectorAll" +
                    "('.zen-overview-card[aria-label=\"Settings\"]');return c.length+'/'+s.length})()"
            )
            val overview = chromeSurfaceUp()
            shot("02-overview-card")
            finding("  overview up: $overview; cards (all/Settings): $cards ${verdict(overview && cards.endsWith("/1"))}")
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_000)
        }

        // 3. Look and Feel: a section over the landing, and the chrome holds the back for it.
        step("Look and Feel drills in") {
            if (!tapText("Look and Feel")) return@step
            val up = awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_500)
            shot("03-look-and-feel")
            val tab = activeCoreTab()
            finding(
                "  url ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")}, chrome surface $up " +
                    verdict(tab?.optString("url") == "$SETTINGS_URL/look" && tab?.optBoolean("canGoBack") == true && up)
            )
        }

        // 4. Colour scheme through the picker sheet: the theme flips live, no reload.
        step("Colour scheme through the picker sheet") {
            val was = colorScheme()
            if (!tapText("Colour scheme")) return@step
            if (waitForText("Dark", 6_000, exact = true) == null) {
                finding("  the picker sheet never showed its Dark option")
                return@step
            }
            SystemClock.sleep(1_000)
            shot("04-picker-sheet")
            tapText("Dark", exact = true)
            SystemClock.sleep(1_800)
            val now = colorScheme()
            shot("05-dark-scheme")
            finding("  colorScheme $was -> $now ${verdict(was == "light" && now == "dark")}")
        }

        // 5. The predictive back gesture slides the drill-in out with the finger.
        step("Predictive back on the drill-in") {
            if (!chromeSurfaceUp()) {
                finding("  no section over the landing to slide out")
                return@step
            }
            edgeSwipe(0.34f * width, hold = 700) { shot("06-predictive-back") }
            commitSwipe()
            val gone = awaitSurface(up = false, timeoutMs = 8_000)
            SystemClock.sleep(1_200)
            val tab = activeCoreTab()
            finding(
                "  drill-in gone: surface down $gone, url ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")} " +
                    verdict(gone && tab?.optString("url") == SETTINGS_URL && tab?.optBoolean("canGoBack") == false)
            )
        }

        // 6. Away to the tab next door and back through the menu: the one Settings tab is reused.
        step("Reopening Settings from the menu reuses the tab") {
            val settingsId = activeTabId()
            flingRight()
            val away = awaitActive(demoTab, 8_000)
            SystemClock.sleep(1_200)
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            val reused = awaitActive(settingsId, 8_000)
            SystemClock.sleep(1_500)
            shot("07-reused-tab")
            finding(
                "  fling to $demoTab: ${if (away) "yes" else "NO"}; menu > Settings: active ${activeTabId()} (was $settingsId), tabs ${tabCount()} " +
                    verdict(away && reused && tabCount() == before + 1)
            )
        }

        // 7. Back at the landing: rootBackAction's opener rule closes the page tab to the tab that opened it.
        step("Back at the landing returns to the opener") {
            val settingsId = activeTabId()
            edgeSwipe(0.36f * width, hold = 300)
            commitSwipe()
            val returned = awaitActive(demoTab, 8_000)
            SystemClock.sleep(1_500)
            shot("08-back-to-opener")
            val closed = coreState().getJSONObject("tabs").optJSONObject(settingsId) == null
            finding(
                "  active ${activeTabId()}, Settings tab $settingsId ${if (closed) "closed" else "STILL OPEN"}, tabs ${tabCount()} (were $before) " +
                    verdict(returned && closed && tabCount() == before)
            )
        }

        // 8. A deep link as adb or another app sends it: the section, the landing beneath it.
        step("Deep link zenium://settings/privacy") {
            shell("am start -a android.intent.action.VIEW -d zenium://settings/privacy")
            val tab = awaitPage("$SETTINGS_URL/privacy", 12_000)
            val up = awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_500)
            shot("09-deep-link-privacy")
            finding(
                "  active ${tab?.optString("id")} ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")} (the landing beneath), " +
                    "fromIntent ${tab?.optBoolean("fromIntent")}, chrome surface $up, tabs ${tabCount()} " +
                    verdict(tab?.optString("url") == "$SETTINGS_URL/privacy" && tab?.optBoolean("canGoBack") == true && tab?.optBoolean("fromIntent") == true)
            )
            // Back to the landing, so the tab is found there when the menu reuses it.
            edgeSwipe(0.36f * width, hold = 300)
            commitSwipe()
            awaitSurface(up = false, timeoutMs = 8_000)
            SystemClock.sleep(800)
        }

        // 9. A web page's link to the page is refused: nothing opens, the tab stays where it is.
        step("A web page's link to zenium://settings/privacy is refused") {
            if (!switchTo(demoTab, DEMO_TITLE)) {
                finding("  could not return to the demo page")
                return@step
            }
            val tabsBefore = tabCount()
            val settingsBefore = pageTabIds()
            tapPage("#link a")
            SystemClock.sleep(3_000)
            shot("10-refused-link")
            val note = jsonString(tabJs("document.getElementById('note').textContent"))
            finding(
                "  page says '$note'; active ${activeTabId()} ${activeUrl()}, tabs ${tabCount()} (were $tabsBefore), Settings tabs $settingsBefore -> ${pageTabIds()} " +
                    verdict(activeTabId() == demoTab && activeUrl() == "$ORIGIN/" && tabCount() == tabsBefore && pageTabIds() == settingsBefore)
            )
        }

        // 10. Find in Settings: rows from more than one category, each under its caption.
        step("Find in Settings") {
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            awaitPage(SETTINGS_URL, 10_000, anySection = true)
            // The reused tab comes up where it was; a section over the landing goes first.
            if (chromeSurfaceUp()) {
                back()
                awaitSurface(up = false, timeoutMs = 6_000)
            }
            SystemClock.sleep(800)
            val field = waitForText("Find in Settings", 6_000) ?: run {
                finding("  no Find in Settings field on the landing")
                return@step
            }
            Finger().tap(field.exactCenterX(), field.exactCenterY())
            val keyboard = awaitIme(shown = true, timeoutMs = 6_000)
            shell("input text site")
            SystemClock.sleep(1_500)
            var query = chromeValue("(document.querySelector('.zen-settings-search-field')||{}).value||''")
            if (query != "site") {
                Log.w(tag, "input text left the field at '$query'; typing through the chrome")
                chromeJs(
                    "(function(){var i=document.querySelector('.zen-settings-search-field');if(!i)return;" +
                        "var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;" +
                        "s.call(i,'site');i.dispatchEvent(new Event('input',{bubbles:true}))})()"
                )
                SystemClock.sleep(1_200)
                query = chromeValue("(document.querySelector('.zen-settings-search-field')||{}).value||''")
            }
            val hits = chromeValue(
                "(function(){var c=Array.from(document.querySelectorAll('.zen-settings-results .zen-settings-caption'))" +
                    ".map(function(e){return e.textContent.split('\\u203a')[0].trim()});" +
                    "var u=c.filter(function(x,i){return c.indexOf(x)===i});return c.length+' rows in '+u.length+' categories: '+u.join(', ')})()"
            )
            // The keyboard down, so the frame shows the rows it covered.
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 4_000)
            }
            SystemClock.sleep(1_000)
            shot("11-search-hits")
            val categories = Regex("in (\\d+) categories").find(hits)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            finding("  keyboard ${if (keyboard) "up" else "NOT UP"} on tap; query '$query'; $hits ${verdict(query == "site" && categories >= 2)}")
            if (tapText("Clear search", exact = true, timeoutMs = 4_000)) SystemClock.sleep(1_000)
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 4_000)
            }
        }

        // 11. A container's editor sheet and, over it, its delete confirmation: depth two, the lower sheet receding.
        step("Container editor and its confirmation, stacked") {
            if (!tapText("Containers", exact = true)) return@step
            awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            if (!tapText("Work", exact = true)) return@step
            if (waitForText("Delete container", 6_000) == null) {
                finding("  the container sheet never showed Delete container")
                return@step
            }
            SystemClock.sleep(1_000)
            shot("12-container-sheet")
            tapText("Delete container")
            if (waitForText("Cancel", 6_000, exact = true) == null) {
                finding("  the confirmation never came up")
                return@step
            }
            SystemClock.sleep(1_500)
            val sheets = chromeValue("String(document.querySelectorAll('.zen-sheet').length)")
            val recede = chromeValue("getComputedStyle(document.documentElement).getPropertyValue('--zen-stack-recede').trim()")
            shot("13-stacked-sheet")
            finding("  sheets up: $sheets; --zen-stack-recede on the root: '$recede' ${verdict(sheets == "2" && recede.toDoubleOrNull()?.let { it > 0.9 } == true)}")
            tapText("Cancel", exact = true)
            SystemClock.sleep(1_200)
            val after = chromeValue("String(document.querySelectorAll('.zen-sheet').length)")
            finding("  Cancel: sheets up $after ${verdict(after == "1")}")
            // The item sheet, then the section: two backs to the landing.
            back()
            SystemClock.sleep(1_200)
            edgeSwipe(0.36f * width, hold = 300)
            commitSwipe()
            awaitSurface(up = false, timeoutMs = 8_000)
            SystemClock.sleep(800)
        }

        // 12. The pill, editing: the page's user-facing alias, section and all.
        step("The pill edits zenium://settings/look") {
            if (!tapText("Look and Feel")) return@step
            awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            val pillNow = findByLabelPrefix(PILL_LABEL) ?: pill
            Finger().tap(pillNow.exactCenterX(), pillNow.exactCenterY())
            SystemClock.sleep(2_000)
            val text = chromeValue("(document.querySelector('input[aria-label=\"Search or enter address\"]')||{}).value||''")
            shot("14-pill-editing")
            finding("  pill text '$text' ${verdict(text == "zenium://settings/look")}")
            closeUrlbar()
            SystemClock.sleep(1_000)
        }

        finding("\nend: ${describeActive()}")
    }

    // --- steps -----------------------------------------------------------------------------------

    /** Run one step of the sequence; a failure inside it is a finding, not the end of the recording. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // --- rows and labels -------------------------------------------------------------------------

    /**
     * The bounds of the first node whose accessible text reads `text` – exactly, or (`exact`
     * false) as a prefix: a Settings row is one button whose text runs its label, value and
     * description together. Polls, since the tree trails the screen on the emulator.
     */
    private fun waitForText(text: String, timeoutMs: Long, exact: Boolean = false): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val node = findNode { it == text || (!exact && it.startsWith(text)) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                if (bounds.width() > 0 && bounds.height() > 0) return bounds
            }
            SystemClock.sleep(200)
        }
        return null
    }

    /** A finger on the middle of the node reading `text`; false (and a finding) when none shows. */
    private fun tapText(text: String, exact: Boolean = false, timeoutMs: Long = 8_000): Boolean {
        val target = waitForText(text, timeoutMs, exact) ?: run {
            finding("  nothing on screen reads '$text'")
            return false
        }
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    // --- the back gesture ------------------------------------------------------------------------

    private var finger: Finger? = null

    /**
     * A thumb from the left screen edge: down in the gesture inset, out to `dx`, then held there
     * (with `during` run while holding – a frame). The gesture stays down; follow with
     * [commitSwipe].
     */
    private fun edgeSwipe(dx: Float, hold: Long, during: () -> Unit = {}) {
        ensureForeground()
        val f = Finger()
        f.down(EDGE_X, height * 0.6f)
        f.moveBy(dx, 0f, 650)
        f.hold(hold)
        during()
        finger = f
    }

    /** Let go where it is: the system commits the gesture. */
    private fun commitSwipe() {
        val f = finger ?: return
        finger = null
        f.up()
    }

    /** Back out of whatever chrome surface is up, a few at most. */
    private fun closeSurfaces() {
        repeat(3) {
            if (!chromeSurfaceUp()) return
            back()
            SystemClock.sleep(1_500)
        }
    }

    // --- tabs ------------------------------------------------------------------------------------

    /** To `tabId` through the overview's card labelled `title`; the core's own activate when the card is not found. */
    private fun switchTo(tabId: String, title: String): Boolean {
        if (activeTabId() == tabId) return true
        val button = waitForText("Tabs (", 5_000)
        if (button != null) {
            Finger().tap(button.exactCenterX(), button.exactCenterY())
            SystemClock.sleep(2_000)
            val card = waitForText(title, 5_000, exact = true)
            if (card != null) {
                Finger().tap(card.exactCenterX(), card.exactCenterY())
                if (awaitActive(tabId, 8_000)) {
                    awaitSurface(up = false, timeoutMs = 6_000)
                    SystemClock.sleep(1_500)
                    return true
                }
            }
            Log.w(tag, "no card for $title in the overview; activating through the core")
            closeSurfaces()
        }
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val ok = awaitActive(tabId, 8_000)
        SystemClock.sleep(1_500)
        return ok
    }

    private fun ensureActive(tabId: String) {
        if (activeTabId() == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        awaitActive(tabId, 8_000)
        SystemClock.sleep(1_000)
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun colorScheme(): String = coreState().getJSONObject("settings").optString("colorScheme")

    /** The ids of the tabs showing the Settings page, in the core's order. */
    private fun pageTabIds(): List<String> {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("url").startsWith(SETTINGS_URL) }.sorted().toList()
    }

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    /** Poll until `tabId` is the active tab; false when it does not become so in time. */
    private fun awaitActive(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeTabId() == tabId) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "$tabId did not become the active tab")
        return activeTabId() == tabId
    }

    /**
     * Poll until the active tab shows `url` (or, with `anySection`, that page at any section);
     * that tab, or the active tab then when it does not come in time.
     */
    private fun awaitPage(url: String, timeoutMs: Long, anySection: Boolean = false): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            val at = tab?.optString("url").orEmpty()
            if (tab != null && (at == url || (anySection && at.startsWith(url)))) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return activeCoreTab()
    }

    // --- the chrome and the page -----------------------------------------------------------------

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String = jsonString(chromeJs(code))

    private fun jsonString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            finding("  nothing matches $selector on the page")
            return
        }
        Finger().tap(p.x, p.y)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18134
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val DEMO_TAB = "tab_demo"
        private const val DEMO_TITLE = "Settings tab demo"
        /** The address the core stores the page under; the pill and the deep link carry `zenium://`. */
        private const val SETTINGS_URL = "zen://settings"
        /** Inside the system's back-gesture inset on any density. */
        private const val EDGE_X = 2f
    }
}
