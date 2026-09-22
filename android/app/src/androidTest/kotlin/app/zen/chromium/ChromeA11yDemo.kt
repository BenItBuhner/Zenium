package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.InputDevice
import android.view.InputEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.lang.reflect.Method
import java.util.Calendar
import kotlin.math.abs
import kotlin.math.max
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
 * switches it on and drives its linear navigation – swipes right injected into the accessibility
 * input filter, what a finger does – along the bar (the pill one stop, then its chips), over a
 * card and its Close, and past the app menu's last row (the modality probe), reading where its
 * focus lands after each; where the injected swipe does not reach it, the focus is moved with
 * `ACTION_ACCESSIBILITY_FOCUS` node by node as run 2 did, and the report says which. When TalkBack
 * is not on the image the driver says so and the tree stands.
 *
 * The `scenes` instrumentation argument (`DEMO_SCENES` in the workflow) picks the run: `all` (the
 * default) is the audit above on the Google APIs image, whose WebView 113 has no multi-profile
 * and so no private tabs; `private` is the one scene the audit could not walk there – a private
 * tab opened, the pill's private mark, the overview's Tabs / Private segment (#203) and the
 * menu's private rows – for the workflow's second job on an AOSP image with a Chromium snapshot
 * WebView swapped in (as the private tabs demo runs). Driven by the `android-a11y-chrome-demo`
 * workflow. See [DemoHarness].
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

    /** The texts of the `TYPE_ANNOUNCEMENT` events since the last [clearAnnouncements]: what a live region had spoken. */
    private val announcements = ArrayList<String>()

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

    /** Which scenes run (`scenes` argument): `all`, or `private` for the multi-profile WebView job. */
    private val scenes: String by lazy { InstrumentationRegistry.getArguments().getString("scenes", "all") ?: "all" }

    override fun warmUp() {
        ensureForeground()
        finding("demo server: ${server.selfCheck()}")
        awaitNode(10_000) { it.startsWith("$PILL_LABEL,") }
        SystemClock.sleep(2_000)
        calibrate()
        seedClipboard()
        finding(
            "window ${width}x$height density $density (44 dp = ${(44 * density).roundToInt()} px); " +
                "WebView ${webViewPackage()}; TalkBack ${if (talkBackInstalled()) "installed" else "not on this image"}; " +
                "capabilities.privateTabs ${privateTabsCapability()}; scenes $scenes"
        )
    }

    override fun demo() {
        if (scenes == "private") {
            scene("private") { privateScene() }
            writeReport()
            return
        }
        scene("bar") { barScene() }
        scene("pill") { pillStatesScene() }
        scene("strip") { stripScene() }
        scene("omnibox") { omniboxScene() }
        scene("overview") { overviewScene() }
        scene("menu") { menuScene() }
        scene("settings") { settingsScene() }
        scene("history") { historyScene() }
        scene("inert") { inertScene() }
        scene("bookmarks") { bookmarksScene() }
        scene("find") { findScene() }
        scene("zoom") { zoomScene() }
        scene("font scale") { fontScaleScene() }
        scene("talkback") { talkBackScene() }
        writeReport()
    }

    /**
     * A link on the clipboard, put there from the app's own process while it is in front (Android
     * 10+ lets the foreground app alone read the clipboard, and the peek reads the description),
     * so the URL bar's clipboard row (#208) is on the empty field's list for the omnibox scene.
     */
    private fun seedClipboard() {
        instrumentation.runOnMainSync {
            app.getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("Zenium accessibility demo", CLIP_URL))
        }
        SystemClock.sleep(500)
        finding("clipboard: $CLIP_URL (peek says '${coreInvoke("clipboard.peek")}')")
    }

    private fun privateTabsCapability(): Boolean =
        runCatching { coreState().getJSONObject("capabilities").optBoolean("privateTabs") }.getOrDefault(false)

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
        // The bottom dock's order, top to bottom as the screen has it: the header row's chips,
        // the suggestions list, then the field on the bar's line (the DOM lays the field last at
        // this dock; run 3 named it ahead of the list and read the list as out of order).
        audit(
            "omnibox-header",
            listOf(
                Want("Share", "Button"),
                Want("Copy link", "Button"),
                Want("Edit", "Button"),
                // #208's clipboard row on the empty field: the kind from the clip's description
                // ("Link you copied" once the system has classified the text, "Text you copied"
                // before), and its Show, a `--v2-control` text button, as the option's sibling.
                Want("you copied", "", contains = true),
                Want("Show", "Button"),
                Want("Search or enter address", "EditText", listOf("editable"), prefix = true)
            )
        )
        clipboardRowScene()
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

    /** The clipboard row's Show under a finger: the option then reads the link it held, its Show gone (#208). */
    private fun clipboardRowScene() {
        val row = walk().firstOrNull { it.control && it.label.contains("you copied") }
        if (row == null) {
            fail("[omnibox-header] the clipboard row is not on the empty field's list (the peek said '${coreInvoke("clipboard.peek")}')")
            return
        }
        finding("  [omnibox-header] clipboard row: ${describe(row.node)}")
        if (!touchTapLabel("Show")) {
            fail("[omnibox-header] no touch landed on the clipboard row's Show")
            return
        }
        val revealed = awaitNode(6_000) { it.startsWith(CLIP_URL) }
        expect("[omnibox-header] Show reveals the link on the clipboard in the row: '${revealed?.let { label(it) }}'", revealed != null)
        expect("[omnibox-header] the revealed row's Show is gone", awaitChrome(3_000) { findNode { it == "Show" } == null })
        snap("omnibox-clipboard")
    }

    /**
     * The content frame under a panel (A11Y-01, second pass): with the Settings tab up and the
     * History panel over it, the tab's rows are `inert` and leave the tree; the panel closed, they
     * are back.
     */
    private fun inertScene() {
        if (!openSettingsTab()) return
        awaitNode(10_000) { it == "Look and Feel" } ?: run {
            fail("[inert] the Settings tab's rows never showed")
            return
        }
        val before = walk().count { it.control && (it.label == "Look and Feel" || it.label.startsWith("Find in Settings")) }
        if (!openMenuItem("History")) {
            fail("[inert] History did not open over the Settings tab")
            return
        }
        awaitNode(10_000) { it.startsWith("Search history") }
        SystemClock.sleep(1_200)
        val under = walk().filter { it.control && (it.label == "Look and Feel" || it.label.startsWith("Find in Settings") || it.label == "Tab Management") }
        finding("  [inert] Settings rows in the tree before the panel: $before; with History up: ${under.map { it.label }}")
        expect("[inert] the Settings tab's rows leave the tree under the History panel (inert)", before > 0 && under.isEmpty())
        expect("[inert] the panel's own rows are in the tree", walk().any { it.control && it.label.startsWith("Search history") })
        snap("inert-history-over-settings")
        dismiss()
        awaitSurface(up = false, timeoutMs = 6_000)
        val back = awaitNode(8_000) { it == "Look and Feel" }
        expect("[inert] the Settings tab's rows are back once the panel is closed", back != null)
    }

    /**
     * A private tab's chrome (#203, the reviewer's nit 6), on a WebView with multi-profile – the
     * `private` job's snapshot WebView; WebView 113 has none and the audit's Google APIs run says
     * so: New Private Tab from the app menu under a finger; the bar on the private new tab page;
     * a private page's pill saying address and state with the mask in its leading slot (the
     * site-information chip, no "Private" badge, §9.19); the overview on its Private pane with
     * the Tabs / Private segment (`role=tablist`, `role=tab`, `aria-selected`, 44 targets), the
     * card saying title, place and count and its Close, the segment switched by a finger each
     * way; the menu's private rows; Close Private Tabs ending the session.
     */
    private fun privateScene() {
        if (!privateTabsCapability()) {
            fail("[private] capabilities.privateTabs is false on this WebView (${webViewPackage()}): no private tab to walk")
            return
        }
        if (!openMenuSheet()) return
        audit("private-menu", listOf(Want("New Tab", "Button"), Want(MENU_NEW_PRIVATE, "Button")))
        if (reveal(MENU_NEW_PRIVATE) == null || !touchTapLabel(MENU_NEW_PRIVATE)) {
            fail("[private] the menu's $MENU_NEW_PRIVATE could not be touched")
            return
        }
        expect("[private] $MENU_NEW_PRIVATE opens a private tab", awaitChrome(10_000) { privateActive() })
        expect("[private] the private new tab page explains itself", waitFor(PRIVATE_TITLE, 8_000) != null)
        SystemClock.sleep(1_500)
        audit(
            "private-ntp",
            listOf(
                Want("Search or enter address", "", prefix = true),
                Want("New tab", "Button"),
                tabsWant("private-ntp"),
                Want("Menu", "Button")
            )
        )
        // A private page: the pill reads address and state as on any page; the mask sits in the
        // leading slot, which stays the site-information chip.
        val tabId = activeCoreTab()?.optString("id").orEmpty()
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"input\":\"https://example.com/\"}")
        val pill = awaitPill(15_000) { it.contains("example.com") }
        SystemClock.sleep(1_000)
        expect("[private] the pill on a private page reads the address and the state: '$pill'", pill?.contains(SECURE) == true)
        expect("[private] the pill carries no 'Private' badge (§9.19: the mask in the site-information chip says it)", findNode { it == "Private" } == null)
        audit(
            "private-bar",
            listOf(
                Want("$PILL_LABEL, example.com, $SECURE", "Button"),
                Want(SITE_INFO, "Button"),
                Want(SECURE, "Button"),
                Want("New tab", "Button"),
                tabsWant("private-bar", pressed = false),
                Want("Menu", "Button")
            )
        )
        if (openOverview()) {
            audit(
                "private-overview",
                listOf(
                    Want("Spaces", "Button"),
                    Want("More", "Button"),
                    Want("Tabs", "Tab"),
                    Want("Private", "Tab", listOf("selected")),
                    Want("Example Domain, tab 1 of 1", "Button", prefix = true),
                    Want("Close Example Domain", "Button")
                )
            )
            val card = walk().firstOrNull { it.control && it.label.startsWith("Example Domain, tab 1 of 1") }
            expect("[private] the private card is the current one: '${card?.label}'", card?.label?.endsWith(", current") == true)
            // The pane's slot fades over 120 ms, but the snapshot WebView on the software GPU took
            // up to four seconds to draw and list the other pane (run 4: 81 frames skipped, the
            // header switched at 1.4 s, the grid between 2.3 and 3.7 s, the driver's read at 2.8 s
            // saw the private pane still up): the tree is waited for, and how long it took is written.
            if (touchTapLabel("Tabs")) {
                val switched = awaitPane("Tabs") { it.startsWith("Alpha, tab ") }
                val tabs = walk().firstOrNull { it.control && it.label == "Tabs" }
                expect(
                    "[private] a finger on the segment's Tabs shows the regular pane (${switched}): Tabs ${tabs?.states}, Alpha's card ${findNode { it.startsWith("Alpha, tab ") } != null}",
                    tabs?.states?.contains("selected") == true && findNode { it.startsWith("Alpha, tab ") } != null
                )
                snap("private-overview-tabs-pane")
                if (touchTapLabel("Private")) {
                    val back = awaitPane("Private") { it.startsWith("Example Domain, tab 1 of 1") }
                    val private = walk().firstOrNull { it.control && it.label == "Private" }
                    expect(
                        "[private] and its Private brings the private pane back (${back}): Private ${private?.states}",
                        private?.states?.contains("selected") == true && findNode { it.startsWith("Example Domain, tab 1 of 1") } != null
                    )
                } else {
                    fail("[private] no touch landed on the segment's Private")
                }
            } else {
                fail("[private] no touch landed on the segment's Tabs")
            }
            dismiss()
            awaitChrome(8_000) { !overviewOpen() }
        }
        if (openMenuSheet()) {
            audit("private-menu-session", listOf(Want(MENU_NEW_PRIVATE, "Button"), Want(MENU_CLOSE_PRIVATE, "Button")))
            if (reveal(MENU_CLOSE_PRIVATE) != null && touchTapLabel(MENU_CLOSE_PRIVATE)) {
                expect("[private] $MENU_CLOSE_PRIVATE ends the session", awaitChrome(10_000) { !anyPrivateTab() })
            } else {
                fail("[private] the menu's $MENU_CLOSE_PRIVATE could not be touched")
            }
        }
    }

    /**
     * Waits (up to 12 s) for the overview's segment to have switched to `pane`: its tab reads
     * `selected` and a card of that pane (`card` on the label) is in the tree; then a moment for
     * the fade. Returns what it saw and how long it took, for the finding.
     */
    private fun awaitPane(pane: String, card: (String) -> Boolean): String {
        val start = SystemClock.uptimeMillis()
        val settled = awaitChrome(12_000) {
            findNode(card) != null && walk().any { it.control && it.label == pane && "selected" in it.states }
        }
        val took = SystemClock.uptimeMillis() - start
        if (settled) SystemClock.sleep(600)
        return if (settled) "the $pane pane's tree up after $took ms" else "no $pane pane in the tree within $took ms"
    }

    private fun privateActive(): Boolean =
        runCatching { activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER }.getOrDefault(false)

    private fun anyPrivateTab(): Boolean {
        val tabs = coreState().getJSONObject("tabs")
        for (key in tabs.keys()) if (tabs.optJSONObject(key)?.optString("containerId") == Profiles.PRIVATE_CONTAINER) return true
        return false
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
                // (`capabilities.privateTabs`); WebView 113 on the Google APIs image has not, so
                // the `private` run on the snapshot WebView walks it ([privateScene]).
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
            dismiss()
            awaitChrome(6_000) { findNode { it.startsWith("Close All Tabs") } == null }
            SystemClock.sleep(800)
        } else {
            fail("no touch landed on the overview's More button")
        }
        toastScene()
        dismiss()
        awaitChrome(8_000) { !overviewOpen() }
    }

    /**
     * A card's close from the overview: the toast is a status region with a 40 action and its
     * text; Undo puts the tab back. Delta's card is the grid's last row, and the overview opens
     * scrolled to the current card with that row under the bar: runs 2 and 3 touched the middle
     * of its Close's bounds there, the finger landed on the pill instead, the overview closed and
     * no toast came. The card is scrolled to the grid's middle first ([revealCardClose]) and the
     * touch is checked by the tab going, not by the toast alone.
     */
    private fun toastScene() {
        watchToasts()
        val tabsBefore = coreState().getJSONObject("tabs").length()
        val close = revealCardClose("Close Delta", "tab_delta")
        finding("  Delta's Close for the touch: ${close?.toShortString() ?: "not in the tree"} (the bar's top at ${bounds(MENU_LABEL)?.top})")
        clearAnnouncements()
        if (close == null || !touchTapFresh { it == "Close Delta" }) {
            fail("no touch landed on Close Delta")
            return
        }
        val closed = awaitChrome(8_000) { !tabWithUrl("/delta.html") }
        expect("a touch on Close Delta closes Delta's tab ($tabsBefore tabs before, ${coreState().getJSONObject("tabs").length()} after)", closed)
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
        // The device's proof of the live region is the announcement, not a flag on a node:
        // Chromium's Android bridge never sets a node's live region ("Deliberately don't call
        // setLiveRegion because TalkBack speaks the entire region anytime it changes",
        // AccessibilityNodeInfoBuilder) and instead, when a named node appears inside a live
        // region, sends a TYPE_ANNOUNCEMENT with that node's text (announceLiveRegionText, off
        // the LIVE_REGION_NODE_CHANGED event) – which is what TalkBack speaks. Run 3's retry
        // asserted the flag on the toast's text node and failed on the mechanism, not the toast.
        val spoken = awaitAnnouncement(6_000) { text != null && it.contains(text) }
        finding("  announcements since the touch on Close: ${announcementsSeen()}")
        expect(
            "the toast's text is announced as the toast appears (TYPE_ANNOUNCEMENT ${quote(spoken.orEmpty())}): Chromium's live region on Android",
            spoken != null
        )
        val treeToast = awaitNode(2_500) { it.startsWith("Closed ") }
        if (treeToast != null) {
            val region = liveRegionAncestor(treeToast)
            finding("  toast in the tree: ${describe(treeToast)} (chromeRole ${chromeRole(treeToast)}); its region: ${region?.let { "${describe(it)} chromeRole ${chromeRole(it)}" } ?: "no ancestor within six hops carries a live region's chromeRole"}")
            expect("the toast's text sits under a node Chromium roles `status` (chromeRole ${chromeRole(region ?: treeToast)})", chromeRole(region ?: treeToast) == "status")
            if (treeToast.liveRegion != View.ACCESSIBILITY_LIVE_REGION_NONE || liveAncestor(treeToast)) {
                note("this WebView sets the Android live-region flag on the toast as well (WebView 113 does not: it announces instead)")
            }
        } else {
            note("the toast left the tree before UiAutomation listed it (the tree trails the screen on the software GPU); the announcement and the DOM read above stand")
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
                // #236's icon row, the sheet's first group: five §9.3 icon buttons named by their
                // labels, ahead of the rows of text (Page Info only where the page has one).
                Want("Forward", "Button"),
                Want("Bookmark", "Button"),
                Want("Download Page", "Button"),
                Want("Page Info", "Button", optional = true),
                Want("Reload", "Button"),
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
            dismiss()
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

    /** The zoom panel over a page (the menu's Zoom… is disabled on a New Tab page: run 3 read it there once example.com's tab had gone). */
    private fun zoomScene() {
        if (!ensureExample()) return
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
        // A mark on the chrome's document before the first change: a configuration change re-zooms
        // the WebView's text in place (`fontScale` in `configChanges`, `applyTextScale` writes
        // `textZoom`), so the same document – with its mark – is there after each.
        val marker = "run3-${SystemClock.uptimeMillis()}"
        chromeJs("document.documentElement.dataset.a11yMarker=${JSONObject.quote(marker)}")
        for (scale in listOf("1.3", "2.0")) {
            shell("settings put system font_scale $scale")
            val zoom = awaitTextZoom { it != "100" && it.isNotEmpty() && it != lastZoom }
            finding("  font_scale $scale → data-text-zoom '$zoom' (textZoom ${chromeTextZoom()})")
            expect("the chrome's text zoom followed font_scale $scale: '$zoom'", zoom.toIntOrNull()?.let { it >= (if (scale == "1.3") 128 else 160) } ?: false)
            val kept = chromeValue("document.documentElement.dataset.a11yMarker||''")
            expect("font_scale $scale re-zoomed the chrome in place, no reload (the mark '$marker' is still on the document: '$kept')", kept == marker)
            SystemClock.sleep(2_000)
            measureScale(zoom)
            // Bold text with the large scale (both settings at once): the weights read 700 / 900.
            if (scale == "2.0") boldText(zoom)
            lastZoom = zoom
        }
        shell("settings put system font_scale 1.0")
        val back = awaitTextZoom { it == "100" || it.isEmpty() }
        expect("font_scale 1.0 brings the chrome back to 100: '$back'", back == "100" || back.isEmpty())
        val kept = chromeValue("document.documentElement.dataset.a11yMarker||''")
        expect("font_scale 1.0 re-zoomed the chrome in place too (mark '$kept')", kept == marker)
        lastZoom = "100"
        boldText("100")
    }

    /**
     * The bold-text setting on at the text zoom in force (A11Y-05): `--zen-font-weight-adjustment`
     * 300 on the root, the body's 400 read as 700 and a heading's 600 as 900 (the lead's +300
     * clamped at 900, v2 §4), the bar and Settings photographed; then off again.
     */
    private fun boldText(zoom: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            note("font_weight_adjustment needs API 31; this image is API ${Build.VERSION.SDK_INT}")
            return
        }
        val label = if (zoom == "100") "bold-text" else "scale-$zoom-bold-text"
        ensureExample()
        shell("settings put secure font_weight_adjustment 300")
        val bold = awaitChrome(10_000) { chromeValue("document.documentElement.dataset.boldText||''") == "true" }
        val adjustment = chromeValue("getComputedStyle(document.documentElement).getPropertyValue('--zen-font-weight-adjustment').trim()")
        val body = chromeValue("getComputedStyle(document.body).fontWeight")
        val medium = chromeValue("(function(){var e=document.querySelector('.font-medium');return e?getComputedStyle(e).fontWeight:'(none on screen)'})()")
        finding("  [$label] font_weight_adjustment 300 → data-bold-text $bold; --zen-font-weight-adjustment '$adjustment'; body weight '$body'; a .font-medium's weight '$medium'")
        expect("[$label] the bold-text setting reaches the chrome as --zen-font-weight-adjustment 300 (the body's 400 becomes 700)", bold && adjustment == "300" && body == "700")
        SystemClock.sleep(1_500)
        snap("$label-bar")
        if (openSettingsTab()) {
            awaitNode(8_000) { it == "Look and Feel" }
            SystemClock.sleep(1_000)
            val heading = chromeValue("(function(){var e=document.querySelector('h1, [role=\"heading\"]');return e?getComputedStyle(e).fontWeight:''})()")
            val row = chromeValue("(function(){var e=document.querySelector('[data-page] nav button, [data-page] nav a');return e?getComputedStyle(e).fontWeight:''})()")
            finding("  [$label] Settings heading weight '$heading', a row's weight '$row'")
            expect("[$label] a heading's 600 reads 900 under bold text (clamped), a row's 400 reads 700", heading == "900" && row == "700")
            overflowCheck(label, "settings")
            snap("$label-settings")
            clearChrome()
        }
        shell("settings put secure font_weight_adjustment 0")
        awaitChrome(8_000) { chromeValue("document.documentElement.dataset.boldText||''") == "" }
    }

    private var lastZoom = "100"
    /** The group badge's horizontal spill (scrollWidth - clientWidth) read at zoom 100, the later zooms' measure. */
    private var badgeSpillAt100: Double? = null

    /** The bar, Settings, the omnibox, the overview and the menu sheet at the current text zoom, measured and photographed. */
    private fun measureScale(zoom: String) {
        val label = "scale-$zoom"
        val factor = (zoom.toIntOrNull() ?: 100) / 100.0
        clearChrome()
        // The bar and pill measured are the https page's, whatever tab the scenes before left
        // current (run 2 measured a New Tab page: its pill is the plain field, no "Address" stop;
        // run 3 had lost the tab itself).
        ensureExample()
        SystemClock.sleep(1_000)
        // 1. The bar and the pill: 44 dp controls whatever the text does. The box is the design's
        // 44 (CSS); the tree's reading is the box's enclosing device pixels after Blink's own
        // rounding of the CSS rect, a dp or two over (runs 2 and 3 read 46 x 45 for the 44 boxes
        // at every zoom), so the tree answers for the floor and the CSS box for the size.
        val menu = bounds("Menu")
        val newTab = bounds("New tab")
        val menuCss = domSize("[data-bar-item=\"menu\"]")
        val newTabCss = domSize("[data-bar-item=\"new-tab\"]")
        val field = findNode { it.startsWith("$PILL_LABEL,") }?.let { Rect().also { r -> it.getBoundsInScreen(r) } }
        val fieldCss = domHeight("[aria-label^=\"$PILL_LABEL, \"]")
        finding("  [$label] Menu ${menu?.let { sz(it) }} (CSS $menuCss), New tab ${newTab?.let { sz(it) }} (CSS $newTabCss), pill field ${field?.let { sz(it) }} (CSS $fieldCss tall)")
        expect(
            "[$label] the bar's buttons hold 44 x 44 (CSS Menu $menuCss, New tab $newTabCss; tree ${menu?.let { sz(it) }}, ${newTab?.let { sz(it) }})",
            menu != null && newTab != null && holds44(menu) && holds44(newTab) && is44(menuCss) && is44(newTabCss)
        )
        expect(
            "[$label] the pill's field holds 44 tall (CSS $fieldCss; tree ${field?.let { dp(it.height()) }})",
            field != null && dp(field.height()) >= 44 - TOLERANCE && dp(field.height()) <= 44 + 2.5 && (fieldCss == null || abs(fieldCss - 44) <= 0.5)
        )
        val tokens = chromeValue(TOKENS_JS)
        finding("  [$label] tokens $tokens")
        // The pill's host text sits centred in the 44 control and is not clipped (the lead's nit 3).
        val pillText = chromeValue(PILL_TEXT_JS).split(',').mapNotNull { it.toDoubleOrNull() }
        if (pillText.size == 4) {
            val (controlH, textH, offset, spill) = pillText
            finding("  [$label] pill text: control ${controlH.roundToInt()} tall, text box ${"%.1f".format(textH)}, centre offset ${"%.1f".format(offset)}, vertical spill ${spill.roundToInt()}")
            expect("[$label] the pill's host text is centred in its control and not clipped (offset ${"%.1f".format(offset)}, spill ${spill.roundToInt()})", abs(offset) <= 1.5 && spill <= 1 && textH <= controlH + 0.5)
        } else {
            note("[$label] the pill's text box could not be read: '$pillText'")
        }
        snap("$label-bar")
        // 2. Settings: the rows grow from their line box (§9.21: line + 24).
        if (openSettingsTab()) {
            awaitNode(10_000) { it == "Look and Feel" }
            SystemClock.sleep(1_500)
            val row = bounds("Look and Feel")
            // The field's name is its placeholder, the node's hint (no text, no description), so
            // the audit's own walk finds it where the harness's label search does not (run 3
            // read null for the field the settings scene had just audited).
            val search = walk().firstOrNull { it.control && it.cls.endsWith("EditText") && it.label.startsWith("Find in Settings") }?.bounds
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
            ensureExample()
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
            // The rows' CSS boxes: the tree clips a row at the list's edge (run 3's last row read
            // 44 at 1.8 where the list's viewport cut it), so the DOM answers for the height and
            // the tree's readings are written beside it.
            val rowsCss = chromeValue(SUGGESTION_ROWS_JS).split(',').mapNotNull { it.toDoubleOrNull() }
            finding("  [$label] suggestion rows CSS $rowsCss (line box ${20 * factor} + 24 = ${20 * factor + 24}); tree ${rows.map { dp(it.bounds.height()) }}")
            // One line at every scale (the lead's rule: suggestion rows stay one line), so exactly
            // the line box plus 24, not more.
            expect("[$label] suggestion rows grow from the line box and stay one line ($rowsCss vs ${20 * factor + 24})", rowsCss.isNotEmpty() && rowsCss.all { abs(it - (20 * factor + 24)) <= 0.5 })
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
            // The card's title row: one line to 1.3, two from 1.5 (the lead's call), the header
            // `--zen-overview-card-header` = lines x small-box + 24: 44 / 50 / 96 at 100 / 130 / 180.
            val lines = if (factor >= 1.5) 2 else 1
            val wantCardHeader = 24 + lines * 20 * factor
            val cardHeader = domHeight("header.zen-overview-card-header")
            val cardHeaderToken = chromeValue("getComputedStyle(document.documentElement).getPropertyValue('--zen-overview-card-header').trim()")
            finding("  [$label] card header CSS $cardHeader (--zen-overview-card-header '$cardHeaderToken'; $lines line(s): 24 + $lines x ${20 * factor} = $wantCardHeader)")
            expect("[$label] the card header is its title lines' boxes plus 24 ($cardHeader vs $wantCardHeader)", cardHeader != null && abs(cardHeader - wantCardHeader) <= 0.5)
            // The group card's title row grows from its one line like every row (nit 2):
            // `--zen-overview-group-header` = small-box + 24: 44 / 50 / 60.
            val groupHeader = domHeight(".zen-group-header")
            finding("  [$label] group header CSS $groupHeader (tree ${header?.let { sz(it) }}; 20 x $factor + 24 = ${20 * factor + 24})")
            expect("[$label] the group header is its line box plus 24 ($groupHeader vs ${20 * factor + 24})", groupHeader != null && abs(groupHeader - (20 * factor + 24)) <= 0.5)
            // The group's emoji badge holds as a glyph in its 16 box (nit 1): 14 at every zoom.
            val badge = chromeValue(BADGE_JS).split(',').mapNotNull { it.toDoubleOrNull() }
            if (badge.size == 4) {
                val (fontSize, boxW, spillW, spillH) = badge
                finding("  [$label] group badge: font-size ${"%.2f".format(fontSize)} px in a ${boxW.roundToInt()} box, spill ${spillW.roundToInt()} x ${spillH.roundToInt()} (at 100: ${badgeSpillAt100 ?: "this"})")
                // The glyph reads 14 whatever the zoom, and its box holds what it held at the
                // default size (an emoji's advance runs a pixel or two past 16 at every size; the
                // nit is the zoom adding to it: run 2 read +7 at 1.3 and +15 at 1.8).
                val at100 = badgeSpillAt100 ?: spillW.also { badgeSpillAt100 = it }
                expect("[$label] the group badge's emoji holds as a 14 glyph in its 16 box (font-size ${"%.2f".format(fontSize)}, spill ${spillW.roundToInt()} vs ${at100.roundToInt()} at 100)", abs(fontSize - 14) <= 0.6 && abs(spillW - at100) <= 1 && spillH <= 1)
            } else {
                note("[$label] no group badge on screen to measure ('$badge')")
            }
            overflowCheck(label, "overview")
            snap("$label-overview")
            dismiss()
            awaitChrome(8_000) { !overviewOpen() }
        }
        // 5. A sheet: the app menu.
        if (openMenuSheet()) {
            val row = bounds("New Tab")
            finding("  [$label] menu row ${row?.let { sz(it) }} (line box ${20 * factor} + 24)")
            expect("[$label] a menu row grows from the line box", row != null && abs(dp(row.height()) - (20 * factor + 24)) <= 2.5)
            overflowCheck(label, "menu")
            snap("$label-sheet")
            dismiss()
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
     * TalkBack on for one scene when the image has it, its linear navigation driven the way a
     * finger drives it – a swipe right per stop, the finger's events handed to the accessibility
     * input filter ([filterSwipe]), where the touch explorer reads the gesture and TalkBack moves
     * its focus – along the bar from Back at both docks (the pill one stop that says address and
     * state, its chips their own, in dock order), over a card and its Close in the overview (two
     * stops, then the next card), and past the app menu's last row (the modality probe: where
     * the focus lands when the sheet's rows run out – the page WebView is a sibling view the
     * chrome's `inert` cannot reach, the host follow-up F1). Where the filter cannot be reached
     * (API < 33, or the test API hidden from the run) the focus is moved node by node with
     * `ACTION_ACCESSIBILITY_FOCUS`, as run 2 did, and the report says which. The focus events
     * and TalkBack's own log lines are written down; TalkBack is off again after.
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
        if (!ensureExample()) return
        shell("logcat -c")
        val version = enableTalkBack()
        bringToFront()
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
        ui.serviceInfo = info
        SystemClock.sleep(2_000)
        val manager = app.getSystemService(AccessibilityManager::class.java)
        val bySwipe = filterInjector != null
        val how = if (bySwipe) "swipes right into the accessibility input filter" else "ACTION_ACCESSIBILITY_FOCUS node by node ($filterUnavailable)"
        finding("  TalkBack $version; touch exploration ${manager.isTouchExplorationEnabled}; services ${enabledServices()}; linear navigation by $how")
        synchronized(events) { events.setLength(0) }
        val report = StringBuilder()
        report.appendLine("# TalkBack scene")
        report.appendLine("TalkBack $version; touch exploration ${manager.isTouchExplorationEnabled}; services ${enabledServices()}")
        report.appendLine("Linear navigation by $how.")
        try {
            // 1. The bar at the bottom dock, then at the top.
            barWalk("bottom", report)
            setDock("top")
            barWalk("top", report)
            setDock("bottom")
            // 2. A card and its Close in the overview.
            cardWalk(report)
            // 3. Past the menu's last row.
            modalityProbe(report)
        } finally {
            val log = shell("logcat -d -v time | grep -iE 'talkback|speechcontroller|feedbackcontroller|utterance' | tail -n 200")
            report.appendLine()
            report.appendLine("## Accessibility events while the focus moved")
            synchronized(events) { report.append(events) }
            report.appendLine()
            report.appendLine("## TalkBack in logcat (release TalkBack logs no speech; whatever it wrote is here)")
            report.appendLine(log.ifBlank { "(nothing)" })
            File(out, "a11y-chrome-talkback.txt").writeText(report.toString())
            info.flags = info.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE.inv()
            ui.serviceInfo = info
            disableTalkBack()
            bringToFront()
        }
    }

    /**
     * The bar docked at `dock` through the core, then the tree caught up with it before
     * anything reads or touches the bar: after the switch the tree kept the Menu at the old
     * dock for seconds (run 3 and its retry), so a calibration read the dock's travel as the
     * chrome's origin and the retry's touches on Tabs and Menu went where the bar had been.
     * The wait is written down; the origin is re-read once the tree is on the bar.
     */
    private fun setDock(dock: String) {
        val start = SystemClock.uptimeMillis()
        coreInvoke("settings.update", """{"phoneBarPosition":"$dock"}""")
        val onBar = awaitTreeOnBar(15_000)
        calibrate()
        finding("  [talkback] the bar docked at the $dock; the tree ${if (onBar) "caught up with it" else "still trailed it"} after ${SystemClock.uptimeMillis() - start} ms (Menu in the tree ${freshBounds(MENU_LABEL)?.toShortString()}, in the DOM ${domRect("[data-bar-item=\"menu\"]")?.toShortString()})")
        if (!onBar) note("[talkback] after the bar's move to the $dock the tree still had the Menu elsewhere 15 s on: the scene's touches went by the DOM's boxes")
    }

    /**
     * From Back, one move per control of the bar after it and one more: the stops TalkBack lands
     * on, in order, against the tree's own order of the bar's controls (the dock order the bar
     * scene audited); the pill is one of them, saying address and state, and nothing reads plain
     * "Address". The last move is a probe past the bar's last control, where the focus may stay
     * (the end of the chrome's tree; TalkBack does not wrap) or cross to the page's WebView; run
     * 3 counted that stay as the gesture failing and walked the rest node by node.
     */
    private fun barWalk(dock: String, report: StringBuilder) {
        clearChrome()
        ensureExample()
        SystemClock.sleep(1_000)
        val tree = walk().filter { it.control }.map { it.label }
        val landed = linearWalk("bar-$dock", from = { it == "Back" }, moves = tree.size, report, certain = tree.size - 1)
        finding("  [talkback $dock dock] the tree's controls: $tree")
        finding("  [talkback $dock dock] the focus landed on: $landed")
        val pillStops = landed.take(tree.size).filter { it.startsWith("$PILL_LABEL,") || it == PILL_LABEL }
        expect("[talkback $dock dock] the pill is one stop, saying address and state: $pillStops", pillStops.size == 1 && pillStops[0].startsWith("$PILL_LABEL, example.com, $SECURE"))
        expect("[talkback $dock dock] no stop reads plain '$PILL_LABEL' (no container stop)", landed.none { it == PILL_LABEL })
        val chrome = landed.take(tree.size)
        expect(
            "[talkback $dock dock] the swipes land on the bar's controls in the tree's dock order (${chrome.size} of ${tree.size}): ${verdictOf(chrome, tree)}",
            chrome == tree
        )
        val past = landed.getOrNull(tree.size)
        val where = when {
            past == null -> "(no probe move)"
            past == tree.lastOrNull() -> "stayed on '$past' (the end of the chrome's tree)"
            past.isBlank() -> "nothing in the window held the focus"
            else -> "'$past' (outside the chrome's tree: the page's WebView, a sibling view, F1)"
        }
        finding("  [talkback $dock dock] past the bar's last control the focus $where")
        snap("talkback-$dock-dock")
    }

    private fun verdictOf(landed: List<String>, tree: List<String>): String =
        if (landed == tree) "the same" else "landed $landed, tree $tree"

    /** In the overview: from the Alpha card, the next stop is its Close, the one after the next card. */
    private fun cardWalk(report: StringBuilder) {
        if (!openOverview()) return
        awaitNode(8_000) { it.startsWith("Alpha, tab ") }
        val landed = linearWalk("card", from = { it.startsWith("Alpha, tab ") }, moves = 2, report)
        finding("  [talkback card] the focus landed on: $landed")
        expect("[talkback card] the card is a stop saying title, place and count: '${landed.getOrNull(0)}'", landed.getOrNull(0)?.let { Regex("^Alpha, tab \\d+ of \\d+").containsMatchIn(it) } == true)
        expect("[talkback card] its Close is the next stop, naming the tab: '${landed.getOrNull(1)}'", landed.getOrNull(1) == "Close Alpha")
        expect("[talkback card] then the next card: '${landed.getOrNull(2)}'", landed.getOrNull(2)?.let { Regex(", tab \\d+ of \\d+").containsMatchIn(it) } == true)
        snap("talkback-card-close")
        dismiss()
        awaitChrome(8_000) { !overviewOpen() }
    }

    /**
     * The modality probe (F1): the app menu up, the focus on its last row, one swipe right more.
     * The chrome behind a sheet is `inert` (the chassis holds it), so the next stop can only be a
     * page's WebView – a sibling Android view outside the chrome's DOM – or nothing. Recorded, not
     * asserted: the host's follow-up.
     */
    private fun modalityProbe(report: StringBuilder) {
        if (!openMenuSheet()) return
        val rows = walk().filter { it.control }
        val last = rows.lastOrNull() ?: run {
            fail("[talkback menu] the menu's rows are not in the tree")
            return
        }
        reveal(last.label)
        val landed = linearWalk("menu", from = { it == last.label }, moves = 2, report, stallIsAnswer = true)
        finding("  [talkback menu] from the menu's last row '${last.label}' the focus went to: ${landed.drop(1)}")
        val outside = landed.drop(1).filter { it.isNotBlank() && rows.none { row -> row.label == it } }
        val where = when {
            landed.drop(1).all { it.isBlank() } -> "nowhere (the focus stayed, or cleared)"
            outside.isNotEmpty() -> "stops outside the menu: $outside – the page's content when these are its words (the page WebView is a sibling view the chrome's inert cannot reach: F1, the host's follow-up)"
            else -> "the menu's own rows again: ${landed.drop(1)}"
        }
        finding("  [talkback menu] past the last row the focus lands on $where")
        note("[talkback menu] modality probe (F1): past the menu's last row the focus lands on $where")
        report.appendLine("- modality probe: past '${last.label}' the focus went to $where")
        snap("talkback-menu-past-last")
        dismiss()
        awaitSurface(up = false, timeoutMs = 6_000)
    }

    /**
     * The focus put on the `from` node, then `moves` moves forward (a swipe right through the
     * input filter, or the next control in the tree given the focus when the filter is out of
     * reach), the label of the node TalkBack's focus rests on after each written down. An empty
     * label is a move after which nothing in the window held the accessibility focus. A swipe
     * that moves the focus nowhere on a move whose next stop is certain (the first `certain`
     * moves of a walk that is not the modality probe: the bar's controls after Back, a card's
     * Close) means the gesture did not reach TalkBack, and the walk goes on node by node from
     * there, the report saying so; a stall past the tree's last control (the bar walk's probe
     * move) or on the modality probe (`stallIsAnswer`) is the answer itself.
     */
    private fun linearWalk(
        scene: String,
        from: (String) -> Boolean,
        moves: Int,
        report: StringBuilder,
        stallIsAnswer: Boolean = false,
        certain: Int = moves
    ): List<String> {
        val landed = ArrayList<String>()
        val start = findNode(from) ?: run {
            fail("[talkback $scene] the starting node is not in the tree")
            return landed
        }
        start.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        SystemClock.sleep(1_800)
        landed += focusedLabel()
        report.appendLine()
        report.appendLine("## $scene: from '${landed[0]}'")
        for (i in 1..moves) {
            var label = ""
            var how = "by swipe"
            if (filterInjector != null && !swipeStalled) {
                filterSwipe(right = true)
                SystemClock.sleep(1_600)
                label = focusedLabel()
                if (label == landed.last() && !stallIsAnswer && i <= certain) {
                    swipeStalled = true
                    note("[talkback $scene] the injected swipe moved the focus nowhere (from '${landed.last()}', move $i of $certain certain): the walk goes on node by node with ACTION_ACCESSIBILITY_FOCUS")
                    report.appendLine("- move $i by swipe → the focus stayed on '${landed.last()}'; node by node from here")
                }
            }
            if (filterInjector == null || swipeStalled) {
                how = "node by node"
                // The next control after the one holding the focus – the node that has it, not
                // the first of its label (a New Tab page's field and the bar's read alike, and
                // run 3's walk from the bar's went on through the page's shortcuts).
                val controls = walk().filter { it.control }
                val at = controls.indexOfFirst { it.states.contains("a11yFocused") }.takeIf { it >= 0 }
                    ?: controls.indexOfLast { it.label == landed.last() }
                controls.getOrNull(at + 1)?.node?.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
                SystemClock.sleep(1_600)
                label = focusedLabel()
            }
            landed += label
            report.appendLine("- move $i $how → '${label.ifBlank { "(no accessibility focus in the window)" }}'")
        }
        return landed
    }

    /** Set once an injected swipe has moved TalkBack's focus nowhere: the walks go on node by node. */
    private var swipeStalled = false

    /** The label of the node holding the accessibility focus in the active window, or "". */
    private fun focusedLabel(): String =
        runCatching { ui.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY) }.getOrNull()?.let { label(it) } ?: ""

    /**
     * `UiAutomation.injectInputEventToInputFilter` (API 33), the one way an injected touch
     * reaches TalkBack: the standard injection skips the accessibility input filter by design (a
     * feedback-loop guard), so a swipe sent that way is a page scroll, never a gesture. It is a
     * `@TestApi`, out of the SDK stubs and hidden from reflection unless the run's `am instrument`
     * carries `--no-hidden-api-checks` (the workflow's `DEMO_INSTRUMENT_FLAGS`); null with the
     * reason in [filterUnavailable] when it cannot be had.
     */
    private val filterInjector: Method? by lazy {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            filterUnavailable = "API ${Build.VERSION.SDK_INT} has no input-filter injection"
            return@lazy null
        }
        runCatching { UiAutomation::class.java.getMethod("injectInputEventToInputFilter", InputEvent::class.java) }
            .onFailure { filterUnavailable = "injectInputEventToInputFilter is hidden from this run: $it" }
            .getOrNull()
    }
    private var filterUnavailable = ""

    /**
     * One finger's swipe across the middle of the screen, handed to the accessibility input
     * filter event by event in real time: 4 cm in 140 ms (the touch explorer wants the first
     * centimetre inside 150 ms and each next one inside 350, else it is touch exploration).
     * TalkBack's default for a swipe right is the next item, for a swipe left the previous.
     */
    private fun filterSwipe(right: Boolean) {
        val inject = filterInjector ?: return
        val distance = min(width * 0.45f, 250 * density)
        val fromX = if (right) (width - distance) / 2 else (width + distance) / 2
        val y = height * 0.5f
        val downTime = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float) {
            val properties = MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
            val coords = MotionEvent.PointerCoords().apply {
                this.x = x
                this.y = y
                pressure = 1f
                size = 1f
            }
            val event = MotionEvent.obtain(
                downTime, SystemClock.uptimeMillis(), action, 1, arrayOf(properties), arrayOf(coords),
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0
            )
            try {
                inject.invoke(ui, event)
            } finally {
                event.recycle()
            }
        }
        send(MotionEvent.ACTION_DOWN, fromX)
        val steps = 14
        for (i in 1..steps) {
            SystemClock.sleep(10)
            send(MotionEvent.ACTION_MOVE, fromX + (if (right) distance else -distance) * i / steps)
        }
        SystemClock.sleep(10)
        send(MotionEvent.ACTION_UP, fromX + if (right) distance else -distance)
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
        // A name TalkBack speaks after the text (the snapshot WebView's aria-label on a toggle or popup button, [supplemental]).
        supplemental(node)?.takeIf { it != label(node) }?.let { states += "supplemental=${quote(it)}" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) node.stateDescription?.takeIf { it.isNotBlank() }?.let { states += "state=$it" }
        if (node.isAccessibilityFocused) states += "a11yFocused"
        return states
    }

    private fun roleOf(stop: Stop): String {
        val short = stop.cls.substringAfterLast('.').substringAfterLast('$')
        return if (stop.role != null && !short.equals(stop.role, ignoreCase = true)) "$short ($stop.role)".replace("$stop.role", stop.role) else short
    }

    /**
     * What TalkBack reads first for a node: its content description, else its text, else its
     * hint; else its supplemental description ([supplemental]) – the Chromium snapshot WebView
     * (156) puts an `aria-label` there on a toggle button or a popup button, the text carrying
     * the visible content (run 4's private job: the bar's Tabs read "1", its glyph's count, and
     * the overview's More, an icon alone, read nothing and was no stop at all).
     */
    private fun label(node: AccessibilityNodeInfo): String =
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
            ?: node.text?.toString()?.takeIf { it.isNotBlank() }
            ?: node.hintText?.toString()?.takeIf { it.isNotBlank() }
            ?: supplemental(node)
            ?: ""

    /**
     * The node's supplemental description, which TalkBack speaks after the text: Android 16's
     * `AccessibilityNodeInfo.getSupplementalDescription` (read reflectively – the app compiles
     * against 35), below it androidx's compat key in the extras, where
     * `AccessibilityNodeInfoCompat.setSupplementalDescription` puts it. Chromium's Android bridge
     * (`BrowserAccessibilityAndroid::ComputeAndroidNameTo`, `kAccessibilityPopulateSupplementalDescriptionApi`
     * on by default since 15x) hands a name from an attribute (`aria-label`) to this API on
     * every role outside `ui::SupportsNamingWithChildContent` – a toggle button (`aria-pressed`)
     * and a popup button (`aria-haspopup="menu"`) among them, a plain button, a tab or a switch
     * not – and leaves the text to the visible content; WebView 113 puts the name in the text.
     */
    private fun supplemental(node: AccessibilityNodeInfo): String? {
        node.extras.getCharSequence(SUPPLEMENTAL_KEY)?.toString()?.takeIf { it.isNotBlank() }?.let { return it }
        if (Build.VERSION.SDK_INT < 36) return null
        return runCatching {
            AccessibilityNodeInfo::class.java.getMethod("getSupplementalDescription").invoke(node) as? CharSequence
        }.getOrNull()?.toString()?.takeIf { it.isNotBlank() }
    }

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

    /** An element's CSS box in the chrome as "w x h" (the design's px), null when it is not on screen. */
    private fun domSize(selector: String): String? {
        val raw = chromeValue("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var r=e.getBoundingClientRect();return r.width+','+r.height})()")
        val parts = raw.split(',').mapNotNull { it.toDoubleOrNull() }
        return if (parts.size == 2) "${"%.1f".format(parts[0])} x ${"%.1f".format(parts[1])}" else null
    }

    /** A CSS box read by [domSize] is the design's 44 x 44 (within half a px). */
    private fun is44(size: String?): Boolean {
        val parts = size?.split(" x ")?.mapNotNull { it.toDoubleOrNull() } ?: return false
        return parts.size == 2 && parts.all { abs(it - 44) <= 0.5 }
    }

    /** The tree's bounds for a 44 box: at the floor, and no more than the enclosing pixels' 2 dp over it. */
    private fun holds44(bounds: Rect): Boolean =
        min(dp(bounds.width()), dp(bounds.height())) >= 44 - TOLERANCE && max(dp(bounds.width()), dp(bounds.height())) <= 44 + 2.5

    /**
     * The bar's Tabs button for an audit: `Tabs (n)`, a toggle button pressed while the overview
     * is up, as WebView 113 and the preview host read its `aria-label` and `aria-pressed`. The
     * Chromium snapshot WebView of the `private` job (156) reads the same button as a
     * ToggleButton whose text is its glyph's count alone ("1") with no pressed state, the
     * `aria-label` riding in the supplemental description ([supplemental]: Chromium's bridge
     * hands a name from an attribute on a toggle button to that API), the DOM carrying
     * `aria-label="Tabs (1)"` and `aria-pressed="false"` all the same (checked on the preview
     * host): the want takes what that WebView says, the name is looked for where it went, and the
     * findings say so.
     */
    private fun tabsWant(scene: String, pressed: Boolean? = null): Want {
        val states = if (pressed == null) emptyList() else listOf("pressed=$pressed")
        val asCounted = walk().firstOrNull { it.control && it.cls.endsWith("ToggleButton") && it.label.isNotBlank() && it.label.all { c -> c.isDigit() } }
        if (asCounted != null && walk().none { it.control && it.label.startsWith("Tabs (") }) {
            val name = supplemental(asCounted.node)
            note(
                "[$scene] the bar's Tabs button reads '${asCounted.label}' ${asCounted.states} on this WebView (${webViewPackage()}), " +
                    "its aria-label ${if (name != null) "'$name' in the supplemental description (TalkBack speaks it after the text)" else "in neither the text, the content description nor the supplemental description"}: " +
                    "Chromium's Android bridge hands a name from an attribute on a toggle button to the supplemental-description API " +
                    "(ComputeAndroidNameTo, the role outside SupportsNamingWithChildContent) and leaves the text to the visible content; " +
                    "WebView 113 and the preview host read 'Tabs (n)' outright, and the DOM carries aria-label and aria-pressed either way"
            )
            expect("[$scene] the Tabs button's aria-label 'Tabs (n)' is in its node all the same (supplemental description ${quote(name.orEmpty())})", name?.startsWith("Tabs (") == true)
            return Want(asCounted.label, "ToggleButton")
        }
        return Want("Tabs (", "ToggleButton", states, prefix = true)
    }

    private fun openOverview(): Boolean {
        clearChrome()
        // The bar's Tabs button by its label once the tree is on the bar, else by its DOM box
        // (the snapshot WebView names it by its count alone, see [tabsWant]).
        if (!touchBarItem("tabs") { it.startsWith("Tabs (") }) {
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

    /**
     * A tab card's Close clear of the bar for a finger: the card scrolled to the grid's middle
     * through the DOM (`ACTION_SHOW_ON_SCREEN` leaves a card the bar covers where it is: the
     * grid's own viewport reaches under the bar, so Blink holds the card visible), then the
     * tree's node for the Close waited for with its bounds above the bar's top (the tree trails
     * the screen). The bounds found, or the tree's last reading when they never clear the bar.
     */
    private fun revealCardClose(label: String, tabId: String): Rect? {
        val cell = JSONObject.quote("[data-tab-id=\"$tabId\"]")
        chromeJs("(function(){var c=document.querySelector($cell);if(c)c.scrollIntoView({block:'center',behavior:'instant'});return !!c})()")
        val barTop = bounds(MENU_LABEL)?.top ?: (height - (60 * density).roundToInt())
        val deadline = SystemClock.uptimeMillis() + 6_000
        var last: Rect? = null
        while (SystemClock.uptimeMillis() < deadline) {
            last = bounds(label)
            if (last != null && last.bottom <= barTop - 4 && last.top >= touchable.top) return last
            SystemClock.sleep(300)
        }
        Log.w(tag, "'$label' did not clear the bar (top $barTop): $last")
        return last
    }

    /**
     * A back only while the chrome has something a back dismisses (a surface, the overview): a
     * back with nothing up is the tab's own, and at a tab's first page the chrome closes the tab
     * (run 3: the toast scene's touch missed and left nothing up, the scene's back then closed
     * example.com's tab, and every scene after measured the New Tab page that took its place).
     */
    private fun dismiss(): Boolean {
        if (!overviewOpen() && !chromeSurfaceUp()) {
            Log.i(tag, "nothing of the chrome's is up: no back sent")
            return false
        }
        back()
        return true
    }

    /**
     * example.com current, with its pill read: the seeded tab where it survives, else the first
     * tab on the URL, else a fresh one (a lost tab is a note, so the scenes after still measure
     * the https page the audit table describes). False, with a failure, when no pill reads it.
     */
    private fun ensureExample(): Boolean {
        if (activeCoreTab()?.optString("url") == EXAMPLE_URL && awaitPill(2_000) { it.contains("example.com") } != null) return true
        val tabs = coreState().getJSONObject("tabs")
        fun onExample(id: String): Boolean {
            val tab = tabs.optJSONObject(id) ?: return false
            return tab.optString("url") == EXAMPLE_URL && tab.optString("containerId") != Profiles.PRIVATE_CONTAINER
        }
        val id = if (onExample("tab_example")) "tab_example" else tabs.keys().asSequence().firstOrNull { onExample(it) }
        if (id != null) {
            activateTab(id)
        } else {
            note("example.com's tab is gone (the tabs are ${tabs.keys().asSequence().map { "${it}=${tabs.optJSONObject(it)?.optString("url")}" }.toList()}): a fresh one opened for the scenes after")
            coreInvoke("tab.create", "{\"url\":${JSONObject.quote(EXAMPLE_URL)},\"active\":true}")
            SystemClock.sleep(3_000)
        }
        val pill = awaitPill { it.contains("example.com") }
        if (pill == null) fail("example.com never came current (the pill reads '${findNode { it.startsWith("$PILL_LABEL,") }?.let { label(it) }}'; the active tab is ${activeCoreTab()?.optString("url")})")
        return pill != null
    }

    /** The app menu up and pulled to its full height (the same pull `openMenuItem` makes), without picking anything. */
    private fun openMenuSheet(): Boolean {
        clearChrome()
        ensureForeground()
        // The bar's Menu button once the tree is on the bar, else by its DOM box (the harness's
        // `tapMenuButton` touches the tree's bounds as they are, and the retry's touch after the
        // dock switch went to the bar's old dock).
        if (!touchBarItem("menu") { it == MENU_LABEL }) {
            fail("no touch landed on the bar's Menu button")
            return false
        }
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
     * back is sent only while the chrome reports the surface, since a back with none up is the
     * tab's own and closes it at its first page), then the Settings tab closed through the core
     * (a back there is that same root back; the scenes that need a tab current say which,
     * [ensureExample]).
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
            val id = activeCoreTab()?.optString("id").orEmpty()
            if (id.isNotBlank()) coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(id)},\"force\":true}")
            if (!awaitChrome(6_000) { !settingsTabActive() }) Log.w(tag, "the Settings tab stayed current after tab.close")
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
    private fun domRect(selector: String): Rect? =
        domRawRect(selector)?.also { it.offset(domOffsetX.roundToInt(), domOffsetY.roundToInt()) }

    /** A DOM box in the chrome WebView's own pixels (CSS px through the density), before the chrome's origin is added. */
    private fun domRawRect(selector: String): Rect? {
        val raw = chromeValue(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var r=e.getBoundingClientRect();" +
                "return [r.left,r.top,r.width,r.height].join(',')})()"
        )
        val parts = raw.split(',').mapNotNull { it.toFloatOrNull() }
        if (parts.size != 4 || parts[2] <= 0) return null
        return Rect(
            (parts[0] * density).roundToInt(),
            (parts[1] * density).roundToInt(),
            ((parts[0] + parts[2]) * density).roundToInt(),
            ((parts[1] + parts[3]) * density).roundToInt()
        )
    }

    /** How far apart the tree's and the DOM's middles of one button may be for the tree to count as caught up with the screen. */
    private val treeAgreesPx: Float get() = 24 * density

    /**
     * The Menu button in the tree against the same button in the DOM: the chrome's origin on
     * screen. Read from the DOM's own pixels (run 3's re-reads went through [domRect], which
     * already carried the offset before, so each compounded on the last), and taken only once
     * the two are within [treeAgreesPx] of each other: the tree trails the screen after the bar
     * moves dock (run 3 and its retry: 2.5 s after the switch the tree still had the Menu at the
     * old dock, and the origin came out as the dock's whole travel, 1420 px). The last offset
     * stands when they never meet within `timeoutMs`.
     */
    private fun calibrate(timeoutMs: Long = 8_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = "no read"
        while (true) {
            val fromTree = freshBounds(MENU_LABEL)
            val fromDom = domRawRect("[data-bar-item=\"menu\"]")
            if (fromTree != null && fromDom != null) {
                val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
                val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
                last = "tree $fromTree, dom $fromDom"
                if (abs(dx) <= treeAgreesPx && abs(dy) <= treeAgreesPx) {
                    domOffsetX = dx
                    domOffsetY = dy
                    Log.i(tag, "DOM offset ${dx}x$dy ($last)")
                    return
                }
            }
            if (SystemClock.uptimeMillis() >= deadline) break
            nudgeFrame()
            SystemClock.sleep(300)
        }
        Log.w(tag, "the tree's Menu and the DOM's never met within $timeoutMs ms ($last): the DOM offset stays ${domOffsetX}x$domOffsetY")
    }

    /** A node's bounds read past UiAutomation's cache (`refresh`), by its exact label; null when it is not in the tree. */
    private fun freshBounds(label: String): Rect? {
        val node = findNode { it == label } ?: return null
        if (!node.refresh()) return null
        return Rect().also { node.getBoundsInScreen(it) }
    }

    /**
     * Whether the chrome WebView's tree has caught up with the screen on the bar: its Menu
     * within [treeAgreesPx] of the DOM's, polled for up to `timeoutMs` with a frame asked of
     * the document each time. Blink sends its location changes from the lifecycle's
     * accessibility step, which runs with a frame, and the browser side batches them behind a
     * delayed content-changed event; on the software GPU under TalkBack the tree had the bar at
     * its old dock 4 s after the switch (the retry: the TalkBack scene's touches on Tabs and
     * Menu went where the bar had been). How long it took is logged.
     */
    private fun awaitTreeOnBar(timeoutMs: Long): Boolean {
        val start = SystemClock.uptimeMillis()
        val deadline = start + timeoutMs
        var last = "no read"
        while (true) {
            val fromTree = freshBounds(MENU_LABEL)
            val fromDom = domRect("[data-bar-item=\"menu\"]")
            if (fromTree != null && fromDom != null) {
                last = "tree $fromTree, dom $fromDom"
                if (abs(fromTree.exactCenterX() - fromDom.exactCenterX()) <= treeAgreesPx &&
                    abs(fromTree.exactCenterY() - fromDom.exactCenterY()) <= treeAgreesPx
                ) {
                    Log.i(tag, "the tree is on the bar after ${SystemClock.uptimeMillis() - start} ms ($last)")
                    return true
                }
            }
            if (SystemClock.uptimeMillis() >= deadline) break
            nudgeFrame()
            SystemClock.sleep(300)
        }
        Log.w(tag, "the tree still trails the bar after $timeoutMs ms ($last)")
        return false
    }

    // `nudgeFrame` (a frame asked of the chrome document while the scene waits on the tree) is the
    // harness's now, shared with the other drivers.

    /**
     * A real touch on one of the bar's buttons (`item` is its `data-bar-item`): at the tree's
     * node once the tree has caught up with the screen ([awaitTreeOnBar]), else at the button's
     * DOM box – the tree trails the screen after the bar moves dock, and run 3's retry touched
     * Tabs and Menu at the bar's old dock; the snapshot WebView also names Tabs by its count
     * alone ([tabsWant]), so its node is not found by the label. False when neither is there.
     */
    private fun touchBarItem(item: String, matches: (String) -> Boolean): Boolean {
        val settled = awaitTreeOnBar(8_000)
        if (settled && touchTapFresh(4_000, matches)) return true
        val box = domRect("[data-bar-item=\"$item\"]") ?: return false
        val point = touchPoint(box) ?: return false
        Log.i(tag, "touch at ${point.x},${point.y} on the bar's $item by its DOM box $box (${if (settled) "no node of the tree reads its label" else "the tree trails the screen"})")
        Finger().tap(point.x, point.y)
        return true
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
        if (event.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT) {
            val spoken = (event.text.joinToString(" ") { it?.toString().orEmpty() } + " " + event.contentDescription?.toString().orEmpty()).trim()
            synchronized(announcements) { announcements += spoken }
        }
    }

    private fun clearAnnouncements() = synchronized(announcements) { announcements.clear() }

    private fun announcementsSeen(): List<String> = synchronized(announcements) { ArrayList(announcements) }

    /** The first announcement since [clearAnnouncements] that `matches`, waited for up to `timeoutMs`; null when none came. */
    private fun awaitAnnouncement(timeoutMs: Long, matches: (String) -> Boolean): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            announcementsSeen().firstOrNull(matches)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    /** Chromium's own role for a node (`AccessibilityNodeInfo.chromeRole` in the extras: `status`, `button`, `staticText`), or null. */
    private fun chromeRole(node: AccessibilityNodeInfo): String? =
        node.extras.getCharSequence("AccessibilityNodeInfo.chromeRole")?.toString()?.takeIf { it.isNotBlank() }

    /** The nearest ancestor (within six hops) whose Chromium role is a live region's (`status`, `alert`, `log`, `marquee`, `timer`), or null. */
    private fun liveRegionAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var parent = node.parent
        var hops = 0
        while (parent != null && hops++ < 6) {
            if (chromeRole(parent) in LIVE_ROLES) return parent
            parent = parent.parent
        }
        return null
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
        /** Chromium's roles that are live regions (`ui::ToString` of the role: `role=status` reads `status`). */
        val LIVE_ROLES = setOf("status", "alert", "log", "marquee", "timer")
        /** androidx's extras key for a supplemental description below Android 16 (`AccessibilityNodeInfoCompat.SUPPLEMENTAL_DESCRIPTION_KEY`). */
        const val SUPPLEMENTAL_KEY = "androidx.view.accessibility.AccessibilityNodeInfoCompat.SUPPLEMENTAL_DESCRIPTION_KEY"
        const val WALK_LIMIT = 5_000
        /** A WebView's class name in the tree – the view's, and Chromium's for the document under it. */
        const val WEBVIEW_CLASS = "android.webkit.WebView"
        const val TALKBACK_PACKAGE = "com.google.android.marvin.talkback"
        const val TALKBACK_SERVICE = "$TALKBACK_PACKAGE/$TALKBACK_PACKAGE.TalkBackService"
        /** The link put on the clipboard for #208's row (`seedClipboard`). */
        const val CLIP_URL = "https://example.com/clipboard"
        /** The https page the audit table describes the bar on (the seed's `tab_example`). */
        const val EXAMPLE_URL = "https://example.com/"
        const val MENU_NEW_PRIVATE = "New Private Tab"
        const val MENU_CLOSE_PRIVATE = "Close Private Tabs"
        const val PRIVATE_TITLE = "You're browsing privately"
        /** `--v2-control` text buttons (§9.11 / §9.33) and a prompt's actions: 40 tall by design, not 44. */
        val TEXT_BUTTONS_40 = setOf("Undo", "Reset", "Share", "Copy link", "Edit", "Make default", "Install", "Add", "Cancel", "Block", "Show")

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

        /**
         * The pill's host text against its control: the control's height, the text box's height,
         * the text's centre offset from the control's (CSS px, + is lower) and the text box's
         * vertical spill (scrollHeight - clientHeight) – "" when no address pill is up.
         */
        val PILL_TEXT_JS = """
            (function () {
              var c = document.querySelector('[aria-label^="Address, "]');
              if (!c) return '';
              var s = c.querySelector('span');
              if (!s) return '';
              var a = c.getBoundingClientRect(), b = s.getBoundingClientRect();
              return [a.height, b.height, (b.top + b.bottom) / 2 - (a.top + a.bottom) / 2, s.scrollHeight - s.clientHeight].join(',');
            })()
        """.trimIndent()

        /** The phone omnibox's suggestion rows (the sheet's `li`s, option and control together): their CSS heights, comma-separated. */
        val SUGGESTION_ROWS_JS = """
            (function () {
              var rows = document.querySelectorAll('li.zen-suggestion-sheet');
              return Array.prototype.map.call(rows, function (r) { return r.getBoundingClientRect().height; }).join(',');
            })()
        """.trimIndent()

        /** A group card's emoji badge: its computed font-size (px, after the text zoom), its box width, its spill (scroll - client) in width and height. */
        val BADGE_JS = """
            (function () {
              var e = document.querySelector('.zen-group-badge');
              if (!e) return '';
              return [parseFloat(getComputedStyle(e).fontSize), e.getBoundingClientRect().width, e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight].join(',');
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
