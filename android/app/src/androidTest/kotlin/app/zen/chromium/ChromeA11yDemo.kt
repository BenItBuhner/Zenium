package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Calendar
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The phone chrome's accessibility tree as a screen reader gets it (A11Y-01) and the chrome's
 * text at the system's font sizes (A11Y-05), read on the device through UiAutomation: the
 * chrome is a WebView, so what TalkBack reads is the React chrome's tree as this Chromium maps
 * it to `AccessibilityNodeInfo` – class (role), label, states, actions, bounds – and the driver
 * walks that tree depth first (the order TalkBack traverses in) on every surface of the audit:
 * the bar and the pill at rest and on a Not secure, a local and an internal page, the group
 * strip, the omnibox's header row and its suggestions, the overview with its segment, cards,
 * group header and header menu, the app menu, the Settings tab (landing, a section, a picker
 * sheet), History, Bookmarks, the find bar, the docked zoom panel, and a toast. On each it
 * writes every control down (`a11y-chrome-audit.md`, the tree as `a11y-chrome-tree-*.txt`) and
 * asserts the controls the audit table names: their label, role, state, order and touch target
 * (v2 draft §9.3: 44 x 44 for icon buttons and chips; §9.11 / §9.12 / §9.33: `--v2-control` 40 for
 * text buttons and fields; §10.4: the slider thumb's 28). Then the system font scale goes to 1.3
 * and 2.0 (`settings put system font_scale`) with the chrome re-measured at each – the bar's
 * buttons and the pill hold their 44, the rows grow from their line box – and stills of the same
 * surfaces as the design captures, then back to 1.0, and the bold-text setting once.
 *
 * TalkBack itself is not the proof: the emulator has no audio, and the API 34 Google APIs image
 * may or may not carry it. When `com.google.android.marvin.talkback` is installed the last scene
 * switches it on, moves its focus along the bar the way a swipe does (`ACTION_ACCESSIBILITY_FOCUS`)
 * and writes down the focus events and whatever TalkBack logs; when it is not, the driver says so
 * and the tree stands. Driven by the `android-a11y-chrome-demo` workflow. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class ChromeA11yDemo : DemoHarness(
    "a11y-chrome-demo-state.json",
    "a11y-chrome",
    "a11y-chrome-demo",
    UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
) {
    override val tag = "ChromeA11yDemo"

    /** The loopback pages the seeded tabs point at (the group's three and Delta). */
    private val server by lazy { DemoServer(PORT, routes()).also { it.start() } }

    /** What the run cannot do without; the instrumentation fails with these at the end. */
    private val failures = ArrayList<String>()
    /** What this Chromium exposes differently from what the chrome asks for, and the soft reads. */
    private val notes = ArrayList<String>()
    private val findings = StringBuilder()
    /** The audit table, one row per control per scene (markdown). */
    private val table = StringBuilder()
    private var controlsAudited = 0
    private var controlsAt44 = 0
    private var controlsAt40 = 0
    private var shots = 0
    /** The chrome's origin on screen against the DOM's coordinates ([calibrate]). */
    private var domOffsetX = 0f
    private var domOffsetY = 0f
    private val events = StringBuilder()

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) throw AssertionError(failures.joinToString("\n"))
    }

    override fun beforeLaunch() {
        server
        shell("cmd uimode night no")
        shell("settings put system font_scale 1.0")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) shell("settings put secure font_weight_adjustment 0")
        ui.setOnAccessibilityEventListener { event -> noteEvent(event) }
        SystemClock.sleep(1_000)
    }

    /** A few older visits, so History has its day headings and rows before the run's own. */
    override fun seedMore(zen: File) {
        val entries = JSONArray()
        val visits = JSONArray()
        fun seed(url: String, title: String, vararg times: Long) {
            entries.put(
                JSONObject().put("url", url).put("title", title).put("visitCount", times.size)
                    .put("lastVisit", times.max()).put("firstVisit", times.min()).put("typedCount", 0).put("favicon", JSONObject.NULL)
            )
            times.forEachIndexed { i, time ->
                visits.put(
                    JSONObject().put("id", "seed_${entries.length()}_$i").put("url", url).put("title", title)
                        .put("favicon", JSONObject.NULL).put("visitTime", time).put("transition", "link")
                )
            }
        }
        seed("https://en.wikipedia.org/wiki/Tea", "Tea - Wikipedia", at(1, 18, 12))
        seed("https://www.rfc-editor.org/rfc/rfc1149.html", "RFC 1149: IP Datagrams on Avian Carriers", at(1, 9, 3))
        seed("https://info.cern.ch/hypertext/WWW/TheProject.html", "World Wide Web", at(3, 14, 27))
        seed("https://news.ycombinator.com/", "Hacker News", at(12, 10, 20))
        File(zen, "history.json").writeText(JSONObject().put("version", 2).put("entries", entries).put("visits", visits).toString())
    }

    private fun at(daysAgo: Int, hour: Int, minute: Int): Long {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -daysAgo)
        cal.set(Calendar.HOUR_OF_DAY, hour)
        cal.set(Calendar.MINUTE, minute)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    override fun warmUp() {
        ensureForeground()
        finding("demo server: ${server.selfCheck()}")
        awaitNode(10_000) { it.startsWith("$PILL_LABEL,") }
        SystemClock.sleep(2_000)
        calibrate()
        finding(
            "window ${width}x$height density $density (44 dp = ${(44 * density).roundToInt()} px); " +
                "WebView ${webViewPackage()}; TalkBack ${if (talkBackInstalled()) "installed" else "not on this image"}"
        )
    }

    override fun demo() {
        scene("bar") { barScene() }
        scene("pill") { pillStatesScene() }
        scene("strip") { stripScene() }
        scene("omnibox") { omniboxScene() }
        scene("overview") { overviewScene() }
        scene("menu") { menuScene() }
        scene("settings") { settingsScene() }
        scene("history") { historyScene() }
        scene("bookmarks") { bookmarksScene() }
        scene("find") { findScene() }
        scene("zoom") { zoomScene() }
        scene("font scale") { fontScaleScene() }
        scene("talkback") { talkBackScene() }
        writeReport()
    }

    /** One scene: its own failures are recorded, the chrome cleared, and the run goes on. */
    private fun scene(name: String, body: () -> Unit) {
        finding("\n## $name")
        try {
            body()
        } catch (e: Throwable) {
            fail("scene $name threw: $e")
            Log.e(tag, "scene $name threw", e)
        }
        runCatching { clearChrome() }.onFailure { Log.w(tag, "clearing the chrome after $name: $it") }
    }

    // --- the scenes ------------------------------------------------------------------------------

    /** The bar at rest on the https page: dock order, every button named, the pill one stop with the state. */
    private fun barScene() {
        awaitActiveUrl("https://example.com/")
        audit(
            "bar",
            listOf(
                Want("Back", "Button", listOf("disabled")),
                Want("$PILL_LABEL, example.com, $SECURE", "Button"),
                Want(SITE_INFO, "Button", listOf("expanded=false")),
                Want(SECURE, "Button", listOf("expanded=false")),
                Want("New tab", "Button"),
                Want("Tabs (", "ToggleButton", listOf("pressed=false"), prefix = true),
                Want("Menu", "Button")
            )
        )
        // The pill's surface is no stop of its own (#108's follow-up): nothing reads plain "Address".
        val plain = findNode { it == PILL_LABEL }
        expect("no node labelled just '$PILL_LABEL' (the pill group is not a TalkBack stop of its own)", plain == null)
        val field = findNode { it.startsWith("$PILL_LABEL,") }
        expect("the pill's surface around the field carries no name", field?.parent?.let { label(it).isBlank() } ?: false)
    }

    /** The pill's announcement on a Not secure page, a local page and (later, in Settings) an internal page. */
    private fun pillStatesScene() {
        activateTab("tab_cern")
        val insecure = awaitPill { it.contains(", Not secure") }
        expect("the pill on http://info.cern.ch reads the state: '$insecure'", insecure != null)
        snap("pill-not-secure")
        activateTab("tab_delta")
        val local = awaitPill { it.contains(", Local site") }
        expect("the pill on a loopback page reads 'Local site': '$local'", local != null)
        snap("pill-local")
        activateTab("tab_example")
        val secure = awaitPill { it.contains(", $SECURE") }
        expect("the pill on https://example.com reads '$SECURE': '$secure'", secure != null)
    }

    /** The group strip over the bar while a group's tab is active: 44 x 44 chips in the strip's order. */
    private fun stripScene() {
        activateTab("tab_alpha")
        awaitPill { it.contains("127.0.0.1") }
        awaitNode(10_000) { it.startsWith("Show group, Research") } ?: run {
            fail("the group strip did not show for a tab of the Research group")
            return
        }
        SystemClock.sleep(1_000)
        audit(
            "strip",
            listOf(
                Want("Show group, Research", "ToggleButton", listOf("pressed=false")),
                Want("Alpha, current tab", "Button"),
                Want("Beta", "Button"),
                Want("Gamma", "Button"),
                Want("New tab in Research", "Button")
            )
        )
        activateTab("tab_example")
        awaitPill { it.contains("example.com") }
    }

    /** The urlbar: the header row's chips, the field, then the suggestions once something is typed. */
    private fun omniboxScene() {
        tapPill()
        if (!awaitChrome(8_000) { urlbarOpen() }) {
            fail("the pill did not open the urlbar")
            return
        }
        awaitNode(8_000) { it == "Copy link" }
        awaitIme(shown = true, timeoutMs = 6_000)
        SystemClock.sleep(1_200)
        audit(
            "omnibox-header",
            listOf(
                Want("Share", "Button"),
                Want("Copy link", "Button"),
                Want("Edit", "Button"),
                Want("Search or enter address", "EditText", listOf("editable"), prefix = true)
            )
        )
        instrumentation.sendStringSync(QUERY)
        awaitNode(12_000) { it == "Clear" }
        awaitNode(12_000) { it.startsWith(QUERY) }
        SystemClock.sleep(1_500)
        audit(
            "omnibox",
            listOf(
                Want(QUERY, "", prefix = true),
                Want("Refine", "Button", optional = true),
                Want("Search or enter address", "EditText", listOf("editable"), optional = true),
                Want("Clear", "Button")
            )
        )
        val rows = suggestionRows()
        expect("the suggestion rows are at least 44 tall (${rows.map { dp(it.bounds.height()) }})", rows.isNotEmpty() && rows.all { dp(it.bounds.height()) >= 44 - TOLERANCE })
        closeField()
    }

    /** The overview: segment, cards with place and count, their close buttons, the group's header, the header menu; then a card closed for the toast. */
    private fun overviewScene() {
        if (!openOverview()) return
        val count = coreState().getJSONObject("tabs").length()
        audit(
            "overview",
            listOf(
                Want("Spaces", "Button"),
                Want("More", "Button", listOf("expanded=false")),
                // The Tabs / Private segment draws only where the WebView has multi-profile
                // (`capabilities.privateTabs`); WebView 113 on the CI image has not.
                Want("Tabs", "Tab", listOf("selected"), optional = true),
                Want("Private", "Tab", optional = true),
                Want("Research, tab group, 3 tabs", "Button", listOf("expanded=true")),
                Want("Alpha, tab ", "Button", prefix = true),
                Want("Close Alpha", "Button"),
                Want("Example Domain, tab ", "Button", prefix = true),
                Want("Close Example Domain", "Button"),
                Want("New Tab", "Button")
            )
        )
        val cards = walk().filter { it.control && Regex(", tab \\d+ of \\d+").containsMatchIn(it.label) }
        expect("every card says its place over $count tabs: ${cards.map { it.label }}", cards.size == count && cards.all { it.label.contains(" of $count") })
        expect("the current tab's card says so", cards.any { it.label.startsWith("Example Domain, tab ") && it.label.endsWith(", current") })
        // The header menu.
        if (touchTapFresh { it == "More" }) {
            awaitNode(8_000) { it.startsWith("Close All Tabs") }
            SystemClock.sleep(1_200)
            audit(
                "overview-menu",
                listOf(
                    Want("Resize sheet", "Button"),
                    Want("Recently Closed (", "Button", listOf("disabled"), prefix = true),
                    Want("Close All Tabs (", "Button", prefix = true)
                )
            )
            val dialog = walk().firstOrNull { !it.control && it.cls.endsWith("Dialog") }
            expect("the header menu is a dialog named for the space: '${dialog?.label}'", dialog?.label == "Browse")
            back()
            awaitChrome(6_000) { findNode { it.startsWith("Close All Tabs") } == null }
            SystemClock.sleep(800)
        } else {
            fail("no touch landed on the overview's More button")
        }
        toastScene()
        back()
        awaitChrome(8_000) { !overviewOpen() }
    }

    /** A card's close from the overview: the toast is a status region with a 40 action and its text; Undo puts the tab back. */
    private fun toastScene() {
        watchToasts()
        if (!touchTapFresh { it == "Close Delta" }) {
            fail("no touch landed on Close Delta")
            return
        }
        val text = awaitToastText("Closed", 8_000)
        expect("closing Delta's card brings the toast: '$text'", text != null)
        val dom = chromeValue(TOAST_JS)
        finding("  toast in the DOM: $dom")
        val json = runCatching { JSONObject(dom) }.getOrNull()
        if (json != null) {
            expect("the toast is a `role=status` live region (§9.33)", json.optString("role") == "status" && json.optString("live") == "polite")
            val buttons = json.optJSONArray("buttons") ?: JSONArray()
            for (i in 0 until buttons.length()) {
                val b = buttons.getJSONObject(i)
                val label = b.optString("label")
                val h = b.optDouble("h")
                val w = b.optDouble("w")
                val floor = if (label == "Dismiss" || label == "Close") 44.0 else 40.0
                expect("the toast's '$label' is ${w.roundToInt()} x ${h.roundToInt()} (floor $floor: §9.33)", min(w, h) >= floor - 0.5)
                tableRow("toast", if (label.isBlank()) "–" else "${i + 1}", "button (DOM)", label, "", "${w.roundToInt()} x ${h.roundToInt()}")
            }
        }
        val treeToast = awaitNode(2_500) { it.startsWith("Closed ") }
        if (treeToast != null) {
            finding("  toast in the tree: ${describe(treeToast)}")
            expect("the toast's node is a live region", treeToast.liveRegion != View.ACCESSIBILITY_LIVE_REGION_NONE || liveAncestor(treeToast))
        } else {
            note("the toast left the tree before UiAutomation listed it (the tree trails the screen on the software GPU); the DOM read above stands")
        }
        snap("toast")
        val undo = domRect(".zen-message-toast .zen-message-button")
        if (undo != null) {
            Finger().tap(undo.exactCenterX(), undo.exactCenterY())
            expect("Undo on the toast puts Delta back", awaitChrome(8_000) { tabWithUrl("/delta.html") })
        } else {
            fail("the toast's Undo button was not in the DOM to touch")
        }
        SystemClock.sleep(1_000)
    }

    /** The app menu: a named dialog, its handle, its rows in order; ends on the Settings row so the next scene starts in Settings. */
    private fun menuScene() {
        if (!openMenuSheet()) return
        audit(
            "menu",
            listOf(
                Want(MENU_HANDLE_LABEL, "Button"),
                Want("New Tab", "Button"),
                Want("New Private Tab", "Button", optional = true),
                Want("Bookmarks", "Button"),
                Want("History", "Button"),
                Want("Downloads", "Button")
            )
        )
        val dialog = walk().firstOrNull { !it.control && it.cls.endsWith("Dialog") }
        expect("the app menu is a dialog with a name: '${dialog?.label}'", !dialog?.label.isNullOrBlank())
        val checkRow = walk().firstOrNull { it.control && it.label.startsWith("Desktop Site") }
        if (checkRow != null) {
            expect("Desktop Site is a checkable row: ${checkRow.cls} ${checkRow.states}", checkRow.states.any { it.startsWith("checked=") })
        } else {
            note("Desktop Site was below the fold of the menu; its checked state is read on the preview host")
        }
        if (reveal("Settings") == null || !touchTapLabel("Settings")) {
            fail("the menu's Settings row could not be touched")
            return
        }
        expect("Settings opens as a tab", awaitChrome(10_000) { settingsTabActive() })
    }

    /** Settings: the landing, a section, a picker sheet. */
    private fun settingsScene() {
        if (!settingsTabActive() && !openSettingsTab()) return
        awaitNode(10_000) { it == "Look and Feel" }
        SystemClock.sleep(1_200)
        audit(
            "settings",
            listOf(
                Want("Find in Settings", "EditText", listOf("editable"), prefix = true),
                Want("Look and Feel", "Button"),
                Want("Tab Management", "Button"),
                Want("Accessibility", "Button", optional = true),
                Want("$PILL_LABEL, Settings, Zenium page", "Button")
            )
        )
        val heading = walk().firstOrNull { !it.control && it.label == "Settings" && it.states.contains("heading") }
        expect("the landing's title is a heading", heading != null)
        if (!touchTapLabelExpecting("Look and Feel", "the section is up", took = { findNode { it == "Back to Settings" } != null })) return
        SystemClock.sleep(1_200)
        audit(
            "settings-look",
            listOf(
                Want("Back to Settings", "Button"),
                Want("Colour scheme", "Button", listOf("hasPopup"), prefix = true),
                Want("Toolbar layout", "Button", listOf("hasPopup"), prefix = true),
                Want("Tabs on the right", "", listOf("checked=false"), prefix = true),
                Want("Indigo app icon", "RadioButton", listOf("checked=true"), optional = true)
            )
        )
        val switch = walk().firstOrNull { it.control && it.label.startsWith("Tabs on the right") }
        if (switch != null) finding("  a switch row is exposed as ${switch.cls} ${switch.states}")
        if (touchTapLabelExpecting("Toolbar layout", "the picker sheet is up", prefix = true, took = { findNode { it == "Single toolbar" } != null })) {
            SystemClock.sleep(1_200)
            audit(
                "settings-picker",
                listOf(
                    Want("Resize sheet", "Button"),
                    Want("Single toolbar", "RadioButton", listOf("checked=true")),
                    Want("Multiple toolbars", "RadioButton", listOf("checked=false")),
                    Want("Collapsed toolbar", "RadioButton", listOf("checked=false"))
                )
            )
            val dialog = walk().firstOrNull { !it.control && it.cls.endsWith("Dialog") }
            expect("the picker is a dialog named after the row: '${dialog?.label}'", dialog?.label == "Toolbar layout")
            back()
            awaitChrome(6_000) { findNode { it == "Single toolbar" } == null }
        }
    }

    private fun historyScene() {
        if (!openMenuItem("History")) {
            fail("History did not open from the menu")
            return
        }
        awaitNode(10_000) { it.startsWith("Search history") }
        SystemClock.sleep(1_500)
        audit(
            "history",
            listOf(
                Want("Close", "Button"),
                Want("Search history", "EditText", listOf("editable"), prefix = true),
                Want("Clear history", "Button"),
                Want("Remove from history", "Button")
            )
        )
        val heading = walk().firstOrNull { !it.control && it.label == "History" && it.states.contains("heading") }
        expect("the panel's title is a heading", heading != null)
        val rows = walk().filter { it.control && it.cls.endsWith("Button") && it.label.contains(", ") && dp(it.bounds.width()) > 200 }
        expect("the history rows (title, host, time) are at least 44 tall: ${rows.map { it.label.take(40) + " " + dp(it.bounds.height()) }}", rows.isNotEmpty() && rows.all { dp(it.bounds.height()) >= 44 - TOLERANCE })
    }

    private fun bookmarksScene() {
        if (!openMenuItem("Bookmarks", "Show Bookmarks")) {
            fail("Bookmarks did not open from the menu")
            return
        }
        awaitNode(10_000) { it.startsWith("Search bookmarks") }
        SystemClock.sleep(1_500)
        audit(
            "bookmarks",
            listOf(
                Want("More bookmark actions", "Button", optional = true),
                Want("Close", "Button"),
                Want("Search bookmarks", "EditText", listOf("editable"), prefix = true),
                Want("Coffee - Wikipedia", "Button"),
                Want("More options for Coffee - Wikipedia", "Button")
            )
        )
    }

    private fun findScene() {
        if (!openMenuItem("Find in Page…")) {
            fail("Find in Page did not open from the menu")
            return
        }
        awaitNode(10_000) { it == "Close find bar" }
        awaitIme(shown = true, timeoutMs = 5_000)
        SystemClock.sleep(1_200)
        audit(
            "find",
            listOf(
                Want("Find in page", "EditText", listOf("editable"), prefix = true),
                Want("Previous match", "Button"),
                Want("Next match", "Button"),
                Want("Close find bar", "Button")
            )
        )
        expect("a touch on Close find bar closes it", touchTapLabelExpecting("Close find bar", "the find bar is gone") { findNode { it == "Close find bar" } == null })
    }

    private fun zoomScene() {
        if (!openMenuItem("Zoom…")) {
            fail("Zoom… did not open from the menu")
            return
        }
        awaitNode(10_000) { it == "Zoom in" }
        SystemClock.sleep(1_500)
        audit(
            "zoom",
            listOf(
                Want("Close", "Button"),
                Want("Zoom out", "Button"),
                Want("Zoom", "SeekBar", contains = true),
                Want("Zoom in", "Button"),
                Want("Reset", "Button", listOf("disabled"))
            )
        )
        val slider = walk().firstOrNull { it.control && it.cls.endsWith("SeekBar") }
        if (slider != null) {
            finding("  slider: ${describe(slider.node)}")
            expect("the slider's thumb is the 28 target (§10.4): ${dp(slider.bounds.width())} x ${dp(slider.bounds.height())}", min(dp(slider.bounds.width()), dp(slider.bounds.height())) >= 28 - TOLERANCE)
        }
        expect("a touch on Zoom in steps the page zoom (the touched control acts)", touchTapLabelExpecting("Zoom in", "Reset is enabled") { findNodeWhere { label(it) == "Reset" && it.isEnabled } != null })
        expect("a touch on Reset brings the zoom back", touchTapLabelExpecting("Reset", "Reset is disabled again") { findNodeWhere { label(it) == "Reset" && !it.isEnabled } != null })
        expect("a touch on Close docks the panel away", touchTapLabelExpecting("Close", "Zoom in is gone") { findNode { it == "Zoom in" } == null })
    }

    /**
     * The system font scale at 1.3 and 2.0 (A11Y-05): the chrome's text zoom follows, the bar's
     * buttons and the pill hold their 44, a Settings row grows from its line box (20 → 26 → 36
     * plus the row's 24), the surfaces re-measure without clipping; stills of each at each scale.
     * Then the bold-text setting once. Leaves the system as found.
     */
    private fun fontScaleScene() {
        measureScale("100")
        for (scale in listOf("1.3", "2.0")) {
            shell("settings put system font_scale $scale")
            val zoom = awaitTextZoom { it != "100" && it.isNotEmpty() && it != lastZoom }
            finding("  font_scale $scale → data-text-zoom '$zoom' (textZoom ${chromeTextZoom()})")
            expect("the chrome's text zoom followed font_scale $scale: '$zoom'", zoom.toIntOrNull()?.let { it >= (if (scale == "1.3") 128 else 160) } ?: false)
            SystemClock.sleep(2_000)
            measureScale(zoom)
            lastZoom = zoom
        }
        shell("settings put system font_scale 1.0")
        val back = awaitTextZoom { it == "100" || it.isEmpty() }
        expect("font_scale 1.0 brings the chrome back to 100: '$back'", back == "100" || back.isEmpty())
        lastZoom = "100"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            shell("settings put secure font_weight_adjustment 300")
            val bold = awaitChrome(10_000) { chromeValue("document.documentElement.dataset.boldText||''") == "true" }
            val adjustment = chromeValue("getComputedStyle(document.documentElement).getPropertyValue('--zen-font-weight-adjustment').trim()")
            val body = chromeValue("getComputedStyle(document.body).fontWeight")
            val medium = chromeValue("(function(){var e=document.querySelector('.font-medium');return e?getComputedStyle(e).fontWeight:'(none on screen)'})()")
            finding("  font_weight_adjustment 300 → data-bold-text $bold; --zen-font-weight-adjustment '$adjustment'; body weight '$body'; a .font-medium's weight '$medium'")
            expect("the bold-text setting reaches the chrome as --zen-font-weight-adjustment 300 (the body's 400 becomes 700)", bold && adjustment == "300" && body == "700")
            SystemClock.sleep(1_500)
            snap("bold-text-bar")
            if (openSettingsTab()) {
                awaitNode(8_000) { it == "Look and Feel" }
                SystemClock.sleep(1_000)
                snap("bold-text-settings")
                clearChrome()
            }
            shell("settings put secure font_weight_adjustment 0")
            awaitChrome(8_000) { chromeValue("document.documentElement.dataset.boldText||''") == "" }
        } else {
            note("font_weight_adjustment needs API 31; this image is API ${Build.VERSION.SDK_INT}")
        }
    }

    private var lastZoom = "100"

    /** The bar, Settings, the omnibox, the overview and the menu sheet at the current text zoom, measured and photographed. */
    private fun measureScale(zoom: String) {
        val label = "scale-$zoom"
        val factor = (zoom.toIntOrNull() ?: 100) / 100.0
        clearChrome()
        // The bar and pill measured are the https page's, whatever tab the scenes before left
        // current (run 2 measured a New Tab page: its pill is the plain field, no "Address" stop).
        if (awaitPill(2_000) { it.contains("example.com") } == null) {
            activateTab("tab_example")
            awaitPill { it.contains("example.com") }
        }
        SystemClock.sleep(1_000)
        // 1. The bar and the pill: 44 dp controls whatever the text does.
        val menu = bounds("Menu")
        val newTab = bounds("New tab")
        val field = findNode { it.startsWith("$PILL_LABEL,") }?.let { Rect().also { r -> it.getBoundsInScreen(r) } }
        finding("  [$label] Menu ${menu?.let { sz(it) }}, New tab ${newTab?.let { sz(it) }}, pill field ${field?.let { sz(it) }}")
        expect("[$label] the bar's buttons hold 44 x 44", menu != null && newTab != null && near44(menu) && near44(newTab))
        expect("[$label] the pill's field holds 44 tall", field != null && abs(dp(field.height()) - 44) <= TOLERANCE)
        val tokens = chromeValue(TOKENS_JS)
        finding("  [$label] tokens $tokens")
        snap("$label-bar")
        // 2. Settings: the rows grow from their line box (§9.21: line + 24).
        if (openSettingsTab()) {
            awaitNode(10_000) { it == "Look and Feel" }
            SystemClock.sleep(1_500)
            val row = bounds("Look and Feel")
            val search = findNode { it.startsWith("Find in Settings") }?.let { Rect().also { r -> it.getBoundsInScreen(r) } }
            val searchCss = domHeight("input[placeholder=\"Find in Settings\"]")
            val rowCss = domHeight("[data-page] nav button, [data-page] nav a")
            val wantRow = 20 * factor + 24
            finding("  [$label] Settings row ${row?.let { sz(it) }} (CSS $rowCss; line box ${20 * factor} + 24 = $wantRow), search field ${search?.let { sz(it) }} (CSS $searchCss)")
            // The tree's bounds are the box's enclosing device pixels (a 40 CSS px box reads 41 or
            // 42 dp at density 1.75); the CSS height is the design's measure, the tree's the target.
            expect("[$label] a Settings row is its line box plus 24 (${row?.let { dp(it.height()) }} vs $wantRow)", row != null && abs(dp(row.height()) - wantRow) <= 2.5)
            expect("[$label] the search field holds --v2-control 40 (CSS $searchCss; tree ${search?.let { dp(it.height()) }})", search != null && dp(search.height()) >= 40 - TOLERANCE && (searchCss == null || abs(searchCss - 40) <= 0.5))
            overflowCheck(label, "settings")
            snap("$label-settings")
            clearChrome()
        }
        // 3. The omnibox with suggestions.
        tapPill()
        if (awaitChrome(8_000) { urlbarOpen() }) {
            awaitIme(shown = true, timeoutMs = 6_000)
            SystemClock.sleep(800)
            instrumentation.sendStringSync(QUERY)
            awaitNode(10_000) { it.startsWith(QUERY) }
            SystemClock.sleep(1_500)
            val rows = suggestionRows()
            finding("  [$label] suggestion rows ${rows.map { dp(it.bounds.height()) }} (line box ${20 * factor} + 24)")
            expect("[$label] suggestion rows grow from the line box", rows.isNotEmpty() && rows.all { dp(it.bounds.height()) >= 20 * factor + 24 - 2.5 })
            overflowCheck(label, "omnibox")
            snap("$label-omnibox")
            closeField()
        }
        // 4. The overview.
        if (openOverview()) {
            SystemClock.sleep(1_000)
            val close = bounds("Close Alpha")
            val closeCss = domHeight(".zen-overview-card-close")
            val header = findNode { it.startsWith("Research, tab group") }?.let { Rect().also { r -> it.getBoundsInScreen(r) } }
            finding("  [$label] card close ${close?.let { sz(it) }} (CSS $closeCss), group header ${header?.let { sz(it) }}")
            // The box is the design's 44 (CSS); the tree's reading is its enclosing device pixels
            // and grows a pixel or two once the row's growth puts the box on a fractional edge
            // (run 2 read 45 x 46 at 1.3 and 1.8), so the tree answers for the floor alone.
            expect(
                "[$label] a card's close holds 44 x 44 (CSS $closeCss; tree ${close?.let { sz(it) }})",
                close != null && min(dp(close.width()), dp(close.height())) >= 44 - TOLERANCE && dp(close.height()) <= 44 + 2.5 &&
                    (closeCss == null || abs(closeCss - 44) <= 0.5)
            )
            overflowCheck(label, "overview")
            snap("$label-overview")
            back()
            awaitChrome(8_000) { !overviewOpen() }
        }
        // 5. A sheet: the app menu.
        if (openMenuSheet()) {
            val row = bounds("New Tab")
            finding("  [$label] menu row ${row?.let { sz(it) }} (line box ${20 * factor} + 24)")
            expect("[$label] a menu row grows from the line box", row != null && abs(dp(row.height()) - (20 * factor + 24)) <= 2.5)
            overflowCheck(label, "menu")
            snap("$label-sheet")
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
        }
        clearChrome()
    }

    /** Text that spills out of its box in the chrome: a soft read, the stills are the proof. */
    private fun overflowCheck(label: String, surface: String) {
        val spills = chromeValue(OVERFLOW_JS)
        finding("  [$label] $surface overflow candidates: ${spills.ifBlank { "none" }}")
        if (spills.isNotBlank() && spills != "[]") note("[$label] $surface: elements whose content runs past their box: $spills")
    }

    /**
     * TalkBack on for one scene when the image has it: the focus moved along the bar as a swipe
     * does, the focus events and TalkBack's own log lines written down; off again after.
     */
    private fun talkBackScene() {
        if (!talkBackInstalled()) {
            finding("  TalkBack is not on this system image: the accessibility tree above is the device proof")
            File(out, "a11y-chrome-talkback.txt").writeText("TalkBack is not installed on this system image.\n")
            return
        }
        // The bar's stops as the audit table has them are the https page's: run 2's scenes left
        // a New Tab page current (its pill is the plain field, no chips), so the scene starts
        // from example.com whatever came before it.
        activateTab("tab_example")
        awaitPill { it.contains("example.com") }
        shell("logcat -c")
        val version = enableTalkBack()
        bringToFront()
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        ui.serviceInfo = info
        SystemClock.sleep(2_000)
        val manager = app.getSystemService(AccessibilityManager::class.java)
        finding("  TalkBack $version; touch exploration ${manager.isTouchExplorationEnabled}; services ${enabledServices()}")
        synchronized(events) { events.setLength(0) }
        val stops = listOf("Back", "$PILL_LABEL,", SITE_INFO, SECURE, "New tab", "Tabs (", "Menu")
        val spoken = ArrayList<String>()
        for ((i, stop) in stops.withIndex()) {
            val node = findNode { it == stop || it.startsWith(stop) } ?: continue
            val ok = node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
            SystemClock.sleep(2_200)
            val focused = findNode { it == stop || it.startsWith(stop) }?.isAccessibilityFocused == true
            spoken += "${label(node)} → action $ok, focused $focused"
            if (i == 1 || i == 5) snap("talkback-focus-${slug(label(node))}")
        }
        finding("  accessibility focus along the bar: ${spoken.joinToString("; ")}")
        expect("the accessibility focus lands on each of the bar's stops in dock order", spoken.size == stops.size && spoken.all { it.endsWith("focused true") })
        val log = shell("logcat -d -v time | grep -iE 'talkback|speechcontroller|feedbackcontroller|utterance' | tail -n 200")
        val report = buildString {
            appendLine("# TalkBack scene")
            appendLine("TalkBack $version; touch exploration ${manager.isTouchExplorationEnabled}; services ${enabledServices()}")
            appendLine()
            appendLine("## Focus moves (ACTION_ACCESSIBILITY_FOCUS, what a swipe right does)")
            spoken.forEach { appendLine("- $it") }
            appendLine()
            appendLine("## Accessibility events while the focus moved")
            synchronized(events) { append(events) }
            appendLine()
            appendLine("## TalkBack in logcat (release TalkBack logs no speech; whatever it wrote is here)")
            appendLine(log.ifBlank { "(nothing)" })
        }
        File(out, "a11y-chrome-talkback.txt").writeText(report)
        info.flags = info.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE.inv()
        ui.serviceInfo = info
        disableTalkBack()
        bringToFront()
    }

    // --- the audit -------------------------------------------------------------------------------

    /** A control the audit names: its label (exact, or a prefix), the role its class or role description must contain, the states it must report. */
    private class Want(
        val name: String,
        val role: String,
        val states: List<String> = emptyList(),
        val prefix: Boolean = false,
        val optional: Boolean = false,
        val contains: Boolean = false
    ) {
        fun matches(stop: Stop): Boolean = when {
            contains -> stop.label.contains(name)
            prefix -> stop.label.startsWith(name)
            else -> stop.label == name
        }
    }

    /** One node TalkBack would stop at: a control (actionable with a label) or context (a heading, a dialog, a live region). */
    private class Stop(
        val index: Int,
        val depth: Int,
        val label: String,
        val cls: String,
        val role: String?,
        val states: List<String>,
        val bounds: Rect,
        val control: Boolean,
        val node: AccessibilityNodeInfo
    )

    /**
     * Walk the scene, write every stop down, check the targets of every control against its floor
     * and the named controls for label, role, state and order; then a still.
     */
    private fun audit(scene: String, wants: List<Want>) {
        val stops = walk()
        dumpTree(scene, stops)
        var controls = 0
        var at44 = 0
        var at40 = 0
        val under = ArrayList<String>()
        for (stop in stops) {
            if (!stop.control) {
                tableRow(scene, "–", roleOf(stop), stop.label, stop.states.joinToString(" "), sz(stop.bounds))
                continue
            }
            controls++
            val short = min(dp(stop.bounds.width()), dp(stop.bounds.height()))
            val floor = floorFor(stop)
            val ok = short >= floor - TOLERANCE
            if (!ok) under += "${stop.label} ${sz(stop.bounds)} (floor $floor)"
            if (short >= 44 - TOLERANCE) at44++ else if (ok) at40++
            tableRow(scene, "${stop.index}", roleOf(stop), stop.label, stop.states.joinToString(" "), sz(stop.bounds) + if (ok) "" else " **< $floor**")
        }
        controlsAudited += controls
        controlsAt44 += at44
        controlsAt40 += at40
        // A text field's name is said once: this WebView reads a field's label and its placeholder
        // both, so a label repeating the placeholder was heard twice (run 1: "Find in page Find in
        // page"); the placeholder alone names the phone's fields now.
        for (field in stops.filter { it.control && it.cls.endsWith("EditText") }) {
            val words = field.label.trim()
            val doubled = words.length % 2 == 1 && words.substring(0, words.length / 2) == words.substring(words.length / 2 + 1) && words[words.length / 2] == ' '
            expect("[$scene] the field '${words.take(40)}' is named once", !doubled)
        }
        finding("  [$scene] ${stops.size} stops, $controls controls: $at44 at 44 or more, $at40 at their 40 (or 28) floor, ${under.size} under")
        expect("[$scene] every control meets its target floor (${under.joinToString("; ").ifBlank { "all do" }})", under.isEmpty())
        var cursor = -1
        for (want in wants) {
            val after = stops.withIndex().firstOrNull { (i, s) -> i > cursor && s.control && want.matches(s) }
            val anywhere = after ?: stops.withIndex().firstOrNull { (_, s) -> s.control && want.matches(s) }
            if (anywhere == null) {
                if (want.optional) finding("  [$scene] (optional) '${want.name}' not on screen") else fail("[$scene] no control '${want.name}${if (want.prefix) "…" else ""}' in the tree")
                continue
            }
            val stop = anywhere.value
            if (after == null) fail("[$scene] '${stop.label}' comes before the control named ahead of it (traversal order)")
            else cursor = after.index
            val roleOk = want.role.isEmpty() || stop.cls.endsWith(want.role, ignoreCase = true) || (stop.role?.contains(want.role, ignoreCase = true) == true)
            val missingStates = want.states.filter { it !in stop.states }
            finding("  [$scene] #${stop.index} '${stop.label}' ${roleOf(stop)} ${stop.states} ${sz(stop.bounds)} ${verdict(roleOk && missingStates.isEmpty())}")
            if (!roleOk) fail("[$scene] '${stop.label}' is exposed as ${roleOf(stop)}, not a ${want.role}")
            if (missingStates.isNotEmpty()) fail("[$scene] '${stop.label}' lacks ${missingStates.joinToString()} (has ${stop.states})")
        }
        snap(scene)
    }

    /** The floor a control's shorter side must reach: 44 (§9.3) but 40 for fields and `--v2-control` text buttons (§9.11, §9.12, §9.33) and 28 for the slider's thumb (§10.4). */
    private fun floorFor(stop: Stop): Int = when {
        stop.cls.endsWith("EditText") -> 40
        stop.cls.endsWith("SeekBar") -> 28
        stop.label in TEXT_BUTTONS_40 || stop.label.startsWith("Allow") -> 40
        else -> 44
    }

    /**
     * Every stop in the chrome's tree, depth first – the order TalkBack walks them.
     *
     * A page's WebView is a sibling of the chrome's under the host's root (`MainActivity` adds the
     * chrome first, at the bottom of the stack; `TabHost` appends the tabs' views after it; an
     * extension's background page sits before the chrome at one pixel). Its content is the page's,
     * not the chrome's, and TalkBack walks it on its own, so only the chrome's subtree is audited
     * (run 1 counted example.com's "Learn more" link as a chrome control). The chrome's node is
     * chosen by [chromeHost]; a choice that yields no stop at all falls back to the whole window
     * with a note, so a wrong one cannot empty the audit (run 2 audited nothing: it gated on the
     * view id, which this WebView's node never carries).
     */
    private fun walk(): List<Stop> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        if (root.packageName?.toString() != app.packageName) {
            Log.w(tag, "the active window is ${root.packageName}, not the app's")
        }
        val host = chromeHost(root)
        val stops = collect(root, host)
        if (stops.isNotEmpty() || host == null) return stops
        note("[walk] the chrome's node ($hosts) had no stops: the whole window walked instead")
        return collect(root, null)
    }

    /** The WebView nodes the last [chromeHost] saw and which it took as the chrome's, for the findings and the tree dumps. */
    private var hosts = ""

    /**
     * The chrome's node in the tree: the first WebView of a real size in tree order – the stack's
     * bottom, where `MainActivity` puts the chrome; a hidden extension page before it is one pixel
     * (`Host.attachHidden`), the tabs' views come after it (`TabHost`). `R.id.zen_chrome`
     * (`ChromeWebView.kt`) would name it outright and is taken when it is there, but a WebView's
     * node is built by Chromium's own provider (`WebContentsAccessibilityImpl.createNodeForHost`),
     * which copies the view's class, package, bounds, enabled and visible – not its id – so on
     * this WebView every host node reads `id=none` and the place in the stack decides (run 2's
     * gate on the id alone found nothing). The WebViews' own documents are not entered here: the
     * view hierarchy above them is a few dozen nodes, the documents run to thousands.
     */
    private fun chromeHost(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val webViews = ArrayList<AccessibilityNodeInfo>()
        var visited = 0
        fun visit(node: AccessibilityNodeInfo) {
            if (++visited > WALK_LIMIT) return
            if (node.className?.toString() == WEBVIEW_CLASS || isChromeWebView(node)) {
                webViews += node
                return
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it) }
        }
        visit(root)
        val byId = webViews.firstOrNull { isChromeWebView(it) }
        val byPlace = webViews.firstOrNull { node ->
            // Screen px: the hidden page is 1 x 1, the chrome and a tab's view fill the window.
            val b = Rect().also { node.getBoundsInScreen(it) }
            b.width() >= 100 && b.height() >= 100
        }
        val chosen = byId ?: byPlace
        val inventory = webViews.joinToString("; ") { node ->
            val b = Rect().also { node.getBoundsInScreen(it) }
            "${node.className} id=${node.viewIdResourceName ?: "none"} ${b.toShortString()} children=${node.childCount}" +
                if (node == chosen) (if (byId != null) " <- the chrome, by id" else " <- the chrome, by place") else ""
        }
        val described = "${webViews.size} WebView node(s): ${inventory.ifBlank { "none" }}"
        if (described != hosts) {
            hosts = described
            finding("  [walk] $described")
        }
        return chosen
    }

    /** The stops under `host` (the whole window when null), depth first. */
    private fun collect(root: AccessibilityNodeInfo, host: AccessibilityNodeInfo?): List<Stop> {
        val stops = ArrayList<Stop>()
        var visited = 0
        var index = 0
        fun visit(node: AccessibilityNodeInfo, depth: Int, inChrome: Boolean) {
            if (++visited > WALK_LIMIT) return
            var inside = inChrome
            if (host != null && !inside) {
                // Another WebView outside the chrome's is a page's (or a hidden extension page):
                // not walked. The document Chromium puts under the chrome's view carries the same
                // class name and is inside it, as an iframe of the chrome's would be.
                if (node == host) inside = true
                else if (node.className?.toString() == WEBVIEW_CLASS) return
            }
            val label = label(node)
            if (label.isNotBlank() && node.isVisibleToUser) {
                val control = actionable(node)
                val states = statesOf(node)
                val role = roleDescription(node)
                val context = !control && (states.contains("heading") || node.className?.toString()?.endsWith("Dialog") == true || states.any { it.startsWith("live=") } || role != null)
                if (control || context) {
                    val bounds = Rect().also { node.getBoundsInScreen(it) }
                    stops += Stop(if (control) ++index else 0, depth, label, node.className?.toString().orEmpty(), role, states, bounds, control, node)
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1, inside) }
        }
        visit(root, 0, false)
        return stops
    }

    /** The chrome's WebView carries `R.id.zen_chrome` (`ChromeWebView.kt`); the tabs' views carry no id. */
    private fun isChromeWebView(node: AccessibilityNodeInfo): Boolean =
        node.viewIdResourceName?.endsWith(":id/zen_chrome") == true

    private fun actionable(node: AccessibilityNodeInfo): Boolean {
        val cls = node.className?.toString().orEmpty()
        return node.isClickable || node.isLongClickable || node.isCheckable || node.isEditable ||
            cls.endsWith("Button") || cls.endsWith("SeekBar") || cls.endsWith("EditText") || cls.endsWith("Switch")
    }

    private fun statesOf(node: AccessibilityNodeInfo): List<String> {
        val states = ArrayList<String>()
        val cls = node.className?.toString().orEmpty()
        if (!node.isEnabled) states += "disabled"
        // Chromium exposes both a switch (`role="switch"`) and a pressed button (`aria-pressed`)
        // as an android.widget.ToggleButton; the role description tells them apart, and TalkBack
        // says "On / Off" for the switch and "pressed / not pressed" for the button.
        val role = roleDescription(node)
        if (node.isCheckable) states += (if (cls.endsWith("ToggleButton") && role != "switch") "pressed=" else "checked=") + node.isChecked
        if (node.isSelected) states += "selected"
        val actions = node.actionList.map { it.id }
        if (AccessibilityAction.ACTION_COLLAPSE.id in actions) states += "expanded=true"
        if (AccessibilityAction.ACTION_EXPAND.id in actions) states += "expanded=false"
        if (node.canOpenPopup()) states += "hasPopup"
        if (node.isEditable) states += "editable"
        node.rangeInfo?.let { states += "value=${it.current} (${it.min}–${it.max})" }
        when (node.liveRegion) {
            View.ACCESSIBILITY_LIVE_REGION_POLITE -> states += "live=polite"
            View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE -> states += "live=assertive"
        }
        // WebView 113 says "heading 1" in the role description and leaves `isHeading` unset;
        // TalkBack reads either.
        if ((Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading) || role?.startsWith("heading") == true) states += "heading"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) node.stateDescription?.takeIf { it.isNotBlank() }?.let { states += "state=$it" }
        if (node.isAccessibilityFocused) states += "a11yFocused"
        return states
    }

    private fun roleOf(stop: Stop): String {
        val short = stop.cls.substringAfterLast('.').substringAfterLast('$')
        return if (stop.role != null && !short.equals(stop.role, ignoreCase = true)) "$short ($stop.role)".replace("$stop.role", stop.role) else short
    }

    private fun label(node: AccessibilityNodeInfo): String =
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
            ?: node.text?.toString()?.takeIf { it.isNotBlank() }
            ?: node.hintText?.toString()?.takeIf { it.isNotBlank() }
            ?: ""

    private fun roleDescription(node: AccessibilityNodeInfo): String? =
        node.extras.getCharSequence("AccessibilityNodeInfo.roleDescription")?.toString()?.takeIf { it.isNotBlank() }

    private fun liveAncestor(node: AccessibilityNodeInfo): Boolean {
        var parent = node.parent
        var hops = 0
        while (parent != null && hops++ < 6) {
            if (parent.liveRegion != View.ACCESSIBILITY_LIVE_REGION_NONE) return true
            parent = parent.parent
        }
        return false
    }

    private fun describe(node: AccessibilityNodeInfo): String {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return "${node.className} label=${quote(label(node))} states=${statesOf(node)} clickable=${node.isClickable} focusable=${node.isFocusable} " +
            "visible=${node.isVisibleToUser} actions=${node.actionList.map { actionName(it.id) }} bounds=${bounds.toShortString()} (${sz(bounds)})"
    }

    private fun dumpTree(scene: String, stops: List<Stop>) {
        val text = buildString {
            appendLine("# $scene – the stops, depth first (the order TalkBack walks them)")
            appendLine("# window ${width}x$height, density $density; sizes in dp")
            appendLine("# $hosts")
            for (stop in stops) {
                appendLine("  ".repeat(stop.depth) + (if (stop.control) "#${stop.index} " else "· ") + describe(stop.node))
            }
        }
        File(out, "a11y-chrome-tree-$scene.txt").writeText(text)
    }

    private fun tableRow(scene: String, index: String, role: String, label: String, states: String, size: String) {
        table.appendLine("| $scene | $index | $role | ${label.replace("|", "\\|")} | $states | $size |")
    }

    // --- the surfaces ----------------------------------------------------------------------------

    private fun tapPill() {
        ensureForeground()
        val target = findNode { it.startsWith("$PILL_LABEL,") }?.let { Rect().also { r -> it.getBoundsInScreen(r) } } ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    /** The field closes by the chrome's state through the harness ([closeUrlField]); a lost page is a finding, not a derailment. */
    private fun closeField() {
        val outcome = closeUrlField()
        if (!outcome.closed) fail("the URL field did not close: ${outcome.reason}")
        else if (!outcome.pageKept) note("closing the URL field lost the page: ${outcome.reason}")
    }

    /** The omnibox's suggestion rows for [QUERY]: the list's options, not the field that holds the typed text. */
    private fun suggestionRows(): List<Stop> =
        walk().filter { it.control && !it.cls.endsWith("EditText") && it.label.startsWith(QUERY) }

    /** An element's CSS height in the chrome (the design's px), null when it is not on screen. */
    private fun domHeight(selector: String): Double? =
        chromeValue("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.getBoundingClientRect().height:''})()").toDoubleOrNull()

    private fun openOverview(): Boolean {
        clearChrome()
        if (!touchTapFresh { it.startsWith("Tabs (") }) {
            fail("no touch landed on the bar's Tabs button")
            return false
        }
        if (!awaitChrome(8_000) { overviewOpen() }) {
            fail("the Tabs button did not open the overview")
            return false
        }
        awaitNode(8_000) { it == "Spaces" }
        SystemClock.sleep(2_000)
        return true
    }

    /** The app menu up and pulled to its full height (the same pull `openMenuItem` makes), without picking anything. */
    private fun openMenuSheet(): Boolean {
        clearChrome()
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            fail("the menu never opened")
            return false
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        return true
    }

    /** The Settings tab on its landing, through the core (the menu's row is touched in the menu scene). */
    private fun openSettingsTab(): Boolean {
        if (settingsTabActive()) return true
        coreInvoke("page.open", "{\"id\":\"settings\"}")
        return awaitChrome(10_000) { settingsTabActive() }.also { if (!it) fail("the Settings tab did not open") }
    }

    /**
     * Nothing of the chrome's is up: the field, the overview, any sheet, panel or section (each
     * back is sent only while the chrome reports the surface, since a back with none up would
     * navigate the page or leave the app), then the Settings tab left to its opener.
     */
    private fun clearChrome() {
        closeField()
        if (overviewOpen()) {
            back()
            awaitChrome(6_000) { !overviewOpen() }
        }
        for (attempt in 1..4) {
            if (!chromeSurfaceUp()) break
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(500)
        }
        if (chromeSurfaceUp()) Log.w(tag, "a chrome surface stayed up")
        if (settingsTabActive()) {
            for (attempt in 1..2) {
                back()
                if (awaitChrome(6_000) { !settingsTabActive() }) break
            }
        }
        SystemClock.sleep(800)
    }

    private fun activateTab(tabId: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        SystemClock.sleep(2_500)
    }

    private fun awaitActiveUrl(url: String): Boolean =
        awaitChrome(10_000) { activeCoreTab()?.optString("url") == url }

    private fun tabWithUrl(suffix: String): Boolean {
        val tabs = coreState().getJSONObject("tabs")
        for (key in tabs.keys()) if (tabs.getJSONObject(key).optString("url").endsWith(suffix)) return true
        return false
    }

    private fun settingsTabActive(): Boolean =
        runCatching { activeCoreTab()?.optString("url").orEmpty().startsWith("zen://settings") }.getOrDefault(false)

    private fun overviewOpen(): Boolean =
        chromeJs("((((window.__zenStores||{}).stage||{get:function(){return {}}}).get()||{}).overview||{}).phase!=='closed'") == "true"

    /** The pill's label once it satisfies `matches` (its page loaded, its state read), or null in time. */
    private fun awaitPill(timeoutMs: Long = 12_000, matches: (String) -> Boolean): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val node = findNode { it.startsWith("$PILL_LABEL,") }
            val text = node?.let { label(it) }
            if (text != null && matches(text)) return text
            SystemClock.sleep(300)
        }
        return findNode { it.startsWith("$PILL_LABEL,") }?.let { label(it) }?.takeIf(matches)
    }

    private fun bounds(label: String): Rect? = findByLabel(label)

    private fun awaitToastText(prefix: String, timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val text = chromeValue("(function(){var e=document.querySelector('.zen-message-toast .zen-message-text');return e?e.textContent:''})()")
            if (text.startsWith(prefix)) return text
            SystemClock.sleep(150)
        }
        return null
    }

    private fun awaitChrome(timeoutMs: Long, holds: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (holds()) return true
            SystemClock.sleep(200)
        }
        return holds()
    }

    private fun awaitTextZoom(timeoutMs: Long = 12_000, accept: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var value = ""
        while (SystemClock.uptimeMillis() < deadline) {
            value = chromeValue("document.documentElement.dataset.textZoom||''")
            if (accept(value)) return value
            SystemClock.sleep(300)
        }
        return value
    }

    /** The chrome WebView's own text zoom, read on the main thread (the test shares the process). */
    private fun chromeTextZoom(): Int {
        var zoom = -1
        instrumentation.runOnMainSync { zoom = (activity as? MainActivity)?.host?.chrome?.settings?.textZoom ?: -1 }
        return zoom
    }

    // --- the DOM ---------------------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** A DOM box on screen (px), through the density and the chrome's origin ([calibrate]). */
    private fun domRect(selector: String): Rect? {
        val raw = chromeValue(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var r=e.getBoundingClientRect();" +
                "return [r.left,r.top,r.width,r.height].join(',')})()"
        )
        val parts = raw.split(',').mapNotNull { it.toFloatOrNull() }
        if (parts.size != 4 || parts[2] <= 0) return null
        return Rect(
            (parts[0] * density + domOffsetX).roundToInt(),
            (parts[1] * density + domOffsetY).roundToInt(),
            ((parts[0] + parts[2]) * density + domOffsetX).roundToInt(),
            ((parts[1] + parts[3]) * density + domOffsetY).roundToInt()
        )
    }

    /** The Menu button in the tree against the same button in the DOM: the chrome's origin on screen. */
    private fun calibrate() {
        val fromTree = waitFor(MENU_LABEL, 6_000) ?: return
        val fromDom = domRect("[data-bar-item=\"menu\"]") ?: return
        domOffsetX = fromTree.exactCenterX() - fromDom.exactCenterX()
        domOffsetY = fromTree.exactCenterY() - fromDom.exactCenterY()
        Log.i(tag, "DOM offset ${domOffsetX}x$domOffsetY (tree $fromTree, dom $fromDom)")
    }

    // --- TalkBack --------------------------------------------------------------------------------

    private fun talkBackInstalled(): Boolean =
        shell("pm list packages $TALKBACK_PACKAGE").lines().any { it.trim() == "package:$TALKBACK_PACKAGE" }

    private fun enableTalkBack(): String {
        val version = shell("dumpsys package $TALKBACK_PACKAGE").lines()
            .firstOrNull { it.trim().startsWith("versionName=") }?.trim()?.removePrefix("versionName=") ?: "?"
        shell("settings put secure enabled_accessibility_services $TALKBACK_SERVICE")
        shell("settings put secure accessibility_enabled 1")
        val deadline = SystemClock.uptimeMillis() + 20_000
        var running = false
        while (SystemClock.uptimeMillis() < deadline) {
            running = enabledServices().any { it.startsWith(TALKBACK_PACKAGE) }
            if (running) break
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
        return "$version ${if (running) "running" else "enabled but not reported as running"}"
    }

    private fun disableTalkBack() {
        shell("settings put secure enabled_accessibility_services ''")
        shell("settings put secure accessibility_enabled 0")
        SystemClock.sleep(2_000)
    }

    private fun enabledServices(): List<String> =
        app.getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .map { it.id }

    /** TalkBack's first-start window (or anything else) in front: the browser is singleTask, starting it brings it back. */
    private fun bringToFront() {
        repeat(3) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            Log.w(tag, "window of $top is in front; bringing the browser back")
            val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            app.startActivity(intent)
            SystemClock.sleep(3_000)
        }
    }

    private fun noteEvent(event: AccessibilityEvent) {
        val interesting = event.eventType == AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED ||
            event.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT ||
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        if (!interesting) return
        val line = "${SystemClock.uptimeMillis()} ${AccessibilityEvent.eventTypeToString(event.eventType)} " +
            "pkg=${event.packageName} class=${event.className} desc=${quote(event.contentDescription?.toString().orEmpty())} text=${event.text}"
        synchronized(events) { events.appendLine(line) }
    }

    private fun webViewPackage(): String =
        shell("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim() ?: "?"

    // --- the record ------------------------------------------------------------------------------

    private fun writeReport() {
        val header = buildString {
            appendLine("# Android chrome accessibility audit – device (UiAutomation on the chrome WebView's tree)")
            appendLine()
            appendLine("Window ${width}x$height at density $density (44 dp = ${(44 * density).roundToInt()} px); WebView ${webViewPackage()}; API ${Build.VERSION.SDK_INT}.")
            appendLine("Controls audited: $controlsAudited – $controlsAt44 at 44 dp or more on their shorter side, $controlsAt40 at their 40 (fields, `--v2-control` text buttons) or 28 (slider thumb) floor, ${controlsAudited - controlsAt44 - controlsAt40} under their floor.")
            appendLine("`#` is the traversal order among the scene's controls (depth first, the order TalkBack walks); `–` marks context (headings, dialogs, live regions). Sizes are the node's bounds in dp.")
            appendLine()
            appendLine("| Scene | # | Role | Name | States | Target (w x h) |")
            appendLine("|---|---|---|---|---|---|")
        }
        File(out, "a11y-chrome-audit.txt").writeText(header + table.toString())
        File(out, "a11y-chrome-findings.txt").writeText(
            buildString {
                append(findings)
                appendLine()
                appendLine("## Notes")
                if (notes.isEmpty()) appendLine("none")
                notes.forEach { appendLine("note: $it") }
                appendLine()
                appendLine("## Verdict")
                if (failures.isEmpty()) appendLine("OK") else failures.forEach { appendLine("FAIL: $it") }
            }
        )
        Log.i(tag, "audit: $controlsAudited controls, $controlsAt44 at 44, $controlsAt40 at their lower floor; ${failures.size} failures")
    }

    private fun snap(name: String) = shot("%02d-%s".format(++shots, name))

    private fun expect(claim: String, held: Boolean) {
        finding("  ${verdict(held)} $claim")
        if (!held) failures += claim
    }

    private fun fail(message: String) {
        Log.e(tag, "FAIL: $message")
        finding("  FAIL $message")
        failures += message
    }

    private fun note(message: String) {
        Log.w(tag, "note: $message")
        notes += message
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendLine(line)
    }

    private fun verdict(held: Boolean) = if (held) "PASS" else "FAIL"

    private fun dp(px: Int): Double = px / density.toDouble()

    private fun sz(bounds: Rect): String = "${dp(bounds.width()).roundToInt()} x ${dp(bounds.height()).roundToInt()}"

    private fun near44(bounds: Rect): Boolean = abs(dp(bounds.width()) - 44) <= TOLERANCE && abs(dp(bounds.height()) - 44) <= TOLERANCE

    private fun quote(value: String): String = "\"$value\""

    private fun slug(label: String): String = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(24)

    private fun actionName(id: Int): String = when (id) {
        AccessibilityNodeInfo.ACTION_CLICK -> "CLICK"
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> "LONG_CLICK"
        AccessibilityNodeInfo.ACTION_FOCUS -> "FOCUS"
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> "ACCESSIBILITY_FOCUS"
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> "CLEAR_ACCESSIBILITY_FOCUS"
        AccessibilityNodeInfo.ACTION_EXPAND -> "EXPAND"
        AccessibilityNodeInfo.ACTION_COLLAPSE -> "COLLAPSE"
        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "SCROLL_FORWARD"
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "SCROLL_BACKWARD"
        AccessibilityNodeInfo.ACTION_SET_TEXT -> "SET_TEXT"
        AccessibilityNodeInfo.ACTION_SET_SELECTION -> "SET_SELECTION"
        AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY -> "NEXT_GRANULARITY"
        AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY -> "PREVIOUS_GRANULARITY"
        AccessibilityNodeInfo.ACTION_NEXT_HTML_ELEMENT -> "NEXT_HTML"
        AccessibilityNodeInfo.ACTION_PREVIOUS_HTML_ELEMENT -> "PREVIOUS_HTML"
        AccessibilityAction.ACTION_SHOW_ON_SCREEN.id -> "SHOW_ON_SCREEN"
        AccessibilityAction.ACTION_SET_PROGRESS.id -> "SET_PROGRESS"
        else -> "0x${Integer.toHexString(id)}"
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

    private fun routes(): Map<String, Pair<String, ByteArray>> =
        listOf("Alpha", "Beta", "Gamma", "Delta").associate { name ->
            "/${name.lowercase()}.html" to ("text/html; charset=utf-8" to page(name).toByteArray())
        }

    private fun page(title: String): String = """
        <!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1"><title>$title</title>
        <style>body{font:17px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1b1b1f;background:#fff}h1{font-size:28px}</style>
        </head><body><h1>$title</h1><p>A page of the accessibility demo's Research group, served from the device's loopback interface.</p>
        <p>The chrome around it is what the screen reader reads; this page only gives the tab a title.</p></body></html>
    """.trimIndent()

    private companion object {
        const val PORT = 18160
        const val SITE_INFO = "Site information"
        const val SECURE = "Connection is secure"
        const val QUERY = "coffee"
        /** How far a node's bounds may fall short of a floor (rounding of CSS px to device px). */
        const val TOLERANCE = 1.5
        const val WALK_LIMIT = 5_000
        /** A WebView's class name in the tree – the view's, and Chromium's for the document under it. */
        const val WEBVIEW_CLASS = "android.webkit.WebView"
        const val TALKBACK_PACKAGE = "com.google.android.marvin.talkback"
        const val TALKBACK_SERVICE = "$TALKBACK_PACKAGE/$TALKBACK_PACKAGE.TalkBackService"
        /** `--v2-control` text buttons (§9.11 / §9.33) and a prompt's actions: 40 tall by design, not 44. */
        val TEXT_BUTTONS_40 = setOf("Undo", "Reset", "Share", "Copy link", "Edit", "Make default", "Install", "Add", "Cancel", "Block")

        /** The toast card as the DOM has it: role, live region, text, its buttons' labels and boxes (CSS px). */
        val TOAST_JS = """
            (function () {
              var card = document.querySelector('.zen-message-toast');
              if (!card) return '';
              var region = card.getAttribute('role') ? card : card.closest('[role]');
              var buttons = Array.prototype.map.call(card.querySelectorAll('button'), function (b) {
                var r = b.getBoundingClientRect();
                return { label: b.getAttribute('aria-label') || b.textContent.trim(), w: r.width, h: r.height };
              });
              return JSON.stringify({
                role: region ? region.getAttribute('role') : null,
                live: region ? (region.getAttribute('aria-live') || (region.getAttribute('role') === 'status' ? 'polite' : null)) : null,
                text: (card.querySelector('.zen-message-text') || {}).textContent || '',
                buttons: buttons
              });
            })()
        """.trimIndent()

        /** The v2 tokens that follow the text zoom, as computed on the root. */
        val TOKENS_JS = """
            (function () {
              var s = getComputedStyle(document.documentElement);
              return ['--zen-text-zoom', '--v2-line-body', '--v2-line-caption', '--v2-row', '--v2-row-two-line', '--v2-menu-row', '--v2-control', '--v2-icon-button', '--zen-font-weight-adjustment']
                .map(function (n) { return n + ':' + s.getPropertyValue(n).trim(); }).join(' ');
            })()
        """.trimIndent()

        /**
         * Chrome elements whose content runs past their own box with nothing to clip or ellipsize
         * it: laid out, visible, `overflow: visible`, and wider or taller inside than out by more
         * than a pixel. Positioned children (a badge over a corner) count too, so this is a list to
         * look at against the still, not a verdict.
         */
        val OVERFLOW_JS = """
            (function () {
              var out = [];
              var all = document.querySelectorAll('body *');
              for (var i = 0; i < all.length && out.length < 12; i++) {
                var el = all[i];
                if (el.tagName === 'svg' || el.tagName === 'SVG' || el.closest('svg')) continue;
                var cs = getComputedStyle(el);
                if (cs.display === 'inline' || cs.display === 'none' || cs.visibility === 'hidden' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') continue;
                var r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
                if (!el.textContent || !el.textContent.trim()) continue;
                var dw = el.scrollWidth - el.clientWidth, dh = el.scrollHeight - el.clientHeight;
                if (el.clientWidth > 0 && (dw > 1 || dh > 1)) {
                  var id = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
                  out.push(id + ' +' + Math.round(dw) + 'x' + Math.round(dh));
                }
              }
              return out.length ? JSON.stringify(out) : '';
            })()
        """.trimIndent()
    }
}
