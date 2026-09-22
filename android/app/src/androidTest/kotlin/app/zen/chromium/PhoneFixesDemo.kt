package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Calendar
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The wave-4 phone fixes (W4-10) on a device, each under the finger or the key that found it:
 *
 *  1. Privacy from the sheet (N3, #260's review): a finger on the site-information sheet's
 *     "Requests blocked" row opens Settings › Privacy and security asked for the site
 *     (`zen://settings/privacy?site=<origin>`), with the site's own group – "Block on <host>",
 *     `tracking-site-current` – on screen rather than one screen down.
 *  2. The theme flip (PC-13's note, #266's review) under a finger in Settings › Look and Feel:
 *     Colour scheme Light -> Dark. The chrome's `data-theme` and the page's
 *     `prefers-color-scheme` are both on record with epoch timestamps (the chrome's through a
 *     MutationObserver, the page's through `matchMedia`'s change event and a poll of `matches`
 *     while the page is off screen behind the Settings tab), beside the host's own log line of
 *     the configuration change it dispatched. The same rows are read in the accessibility tree
 *     for fix 6: the four value rows named once, "label, value" (#237's audit).
 *  3. The flip with the page ON screen, through the core (`settings.update`, the row's own
 *     action): Dark -> Light -> Dark -> Light, the page's change event within a frame's reach of
 *     the chrome's attribute each time (the claim: 100 ms on the emulator's software GPU).
 *  4. `desktopSite: auto` at the 600 dp crossing (seed 28, #273's run): the loaded page scrolled
 *     by a finger, then the window widened past 600 dp through `wm size` (the split-screen
 *     analogue: the density stays), keeps its document, its viewport and its scroll; a fresh load
 *     on the large screen takes the desktop layout (980); back under 600 the loaded desktop page
 *     is kept as it is, and a fresh load is the phone layout again.
 *  5. History's Select all / Deselect all (§9.6): a long press enters selection, a finger on
 *     Select all picks every shown row (the count in the header, the tree's checked boxes), a
 *     finger on Deselect all unpicks them with the mode kept.
 *  6. The pill's keyboard ring (A11Y-09, #272's seed): after a touch-driven focus return rings
 *     nothing, a hardware keyboard's Shift+Tab rings a bar button and then the pill itself
 *     (2 px of `--v2-ring`, read off the computed style), and the next real touch takes the ring
 *     away again (`data-input` on the root).
 *
 * Every claim is a line in `android-phone-fixes-findings.txt` and a failed one fails the run; the
 * recording goes on to the end either way. Profile `pwa-demo-state.json` (two tabs on this
 * driver's loopback server, the tall scheme page the active one), yesterday's history seeded here.
 */
@RunWith(AndroidJUnit4::class)
class PhoneFixesDemo : DemoHarness("pwa-demo-state.json", "android-fixes-w4", "phone-fixes-demo") {
    override val tag = "PhoneFixesDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures.isNotEmpty()) error("${failures.size} claim(s) did not hold: ${failures.joinToString("; ")}")
    }

    /**
     * The seeded tabs point at this driver's loopback server; the scheme page (`tab_notes`) is the
     * active tab. The bar stays put under the scroll of scene 4 (`hideToolbarOnScroll` off): the
     * scenes after it reach the bar's Menu and Tabs buttons where the harness measured them.
     */
    override fun patchState(json: String): String = json
        .replace("127.0.0.1:18131", "127.0.0.1:$PORT")
        .replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"light\", \"hideToolbarOnScroll\": false")

    /** Yesterday's visits, in the history contract's shape, so the History list has rows to pick. */
    override fun seedMore(zen: File) {
        val entries = JSONArray()
        val visits = JSONArray()
        HISTORY.forEachIndexed { i, (url, title) ->
            val time = yesterdayAt(9 + i * 2)
            entries.put(
                JSONObject().put("url", url).put("title", title).put("visitCount", 1).put("lastVisit", time)
                    .put("firstVisit", time).put("typedCount", 0).put("favicon", JSONObject.NULL)
            )
            visits.put(
                JSONObject().put("id", "seed_$i").put("url", url).put("title", title).put("favicon", JSONObject.NULL)
                    .put("visitTime", time).put("transition", "link")
            )
        }
        File(zen, "history.json").writeText(JSONObject().put("version", 2).put("entries", entries).put("visits", visits).toString())
    }

    private fun yesterdayAt(hour: Int): Long {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -1)
        cal.set(Calendar.HOUR_OF_DAY, hour)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    override fun warmUp() {
        findings = File(out, "android-phone-fixes-findings.txt")
        findings.writeText(
            "Zenium Android phone fixes check, wave 4 (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n" +
                "1 Privacy from the sheet; 2 the theme flip under a finger + the four value rows' names; 3 the flip on screen, timestamps; " +
                "4 desktopSite auto at the 600 dp crossing; 5 History Select all; 6 the pill's keyboard ring\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitActiveUrl(NOTES_URL)
        // The Settings page is a chunk of its own that loads on its first open: pay for it off camera.
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(1_200)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_200)
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        chromeJs(PROBE_JS)
        finding(
            "warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; scheme ${colorScheme()}; " +
                "theme attribute '${themeAttribute()}'; the page sees ${pageValue(SCHEME_JS)}; page frame interval ${pageValue("window.__zenFrameMs.toFixed(1)")} ms; " +
                "data-input '${dataInput()}'"
        )
    }

    override fun demo() {
        privacyFromTheSheet()
        themeFlipUnderAFinger()
        themeFlipOnScreen()
        largeScreenCrossing()
        historySelectAll()
        keyboardRing()
        finding("\nend: ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    // --- 1. Privacy from the sheet (N3) --------------------------------------------------------------

    private fun privacyFromTheSheet() {
        step("1. Privacy from the site-information sheet: the site's own group on screen (N3)") {
            val icon = awaitNode(8_000) { it == SITE_ICON_LABEL } ?: error("the pill's site icon is not in the accessibility tree")
            if (!touchTap(icon)) error("no part of the site icon is inside the touchable window")
            val sheet = awaitChrome("!!document.querySelector('[data-testid=\"siteinfo-pill-chips\"]')", 10_000) && awaitSheetAtRest(6_000)
            finding("  a finger on '$SITE_ICON_LABEL' brings the sheet up: ${verdict(sheet)}; rows ${sheetRows()}")
            if (!sheet) {
                touchFault("a finger on '$SITE_ICON_LABEL' did not bring the site-information sheet up")
                error("the site-information sheet never came up")
            }
            still("siteinfo-sheet")
            // The row is found by its name's prefix: the count in it is the page's.
            val took = touchTapLabelExpecting("Requests blocked", "the Settings tab is at Privacy asked for the site", timeoutMs = 10_000, prefix = true) {
                activeCoreTab()?.optString("url")?.startsWith("$SETTINGS_URL/privacy?site=") == true
            }
            val url = activeCoreTab()?.optString("url").orEmpty()
            expect("a finger on the shield row opens Settings › Privacy asked for the site ($url)", took, "privacy-url")
            expect("the address carries the page's origin", url.contains(java.net.URLEncoder.encode(ORIGIN, "UTF-8")) || url.endsWith("site=$ORIGIN"), "privacy-origin")
            val painted = awaitChrome("!!document.querySelector('[data-row=\"$SITE_ROW\"]')", 10_000)
            SystemClock.sleep(1_500)
            expect("the Settings page carries the site's row ($SITE_ROW)", painted, "privacy-row")
            val place = JSONObject(chromeValue("JSON.stringify(window.__zenPlace('[data-row=\"$SITE_ROW\"]'))").ifEmpty { "{}" })
            val rowLabel = place.optString("label")
            val rowOnScreen = place.optBoolean("onScreen")
            finding(
                "  the row '$rowLabel' in the DOM: top ${place.optInt("top")} bottom ${place.optInt("bottom")} of the viewport ${place.optInt("viewport")}, " +
                    "group '${place.optString("group")}' at ${place.optInt("groupTop")}; page scrolled ${place.optInt("scrollTop")}"
            )
            expect("the site's row is on screen as the page opens (not one screen down)", rowOnScreen, "privacy-row-on-screen")
            // The tree's word: the switch's node with bounds inside the window.
            val node = awaitNode(6_000) { it.startsWith("Block on") }
            val bounds = node?.let { Rect().also { r -> it.getBoundsInScreen(r) } }
            finding("  the tree lists '${node?.let { (it.contentDescription ?: it.text)?.toString() }}' at $bounds (window ${width}x$height, touchable $touchable)")
            expect("the per-site switch is inside the window in the accessibility tree", bounds != null && bounds.top >= 0 && bounds.bottom <= height && bounds.height() > 0, "privacy-row-tree")
            still("privacy-from-sheet")
            // The Settings tab leaves through the core; the page is the active tab again.
            activeCoreTab()?.optString("id")?.takeIf { it != NOTES_TAB && it != APP_TAB }?.let {
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(it)}}")
            }
            SystemClock.sleep(1_500)
            awaitActiveUrl(NOTES_URL, 8_000)
        }
    }

    // --- 2. the theme flip under a finger, and the four value rows' names ----------------------------

    private fun themeFlipUnderAFinger() {
        step("2. The theme flip under a finger (Look and Feel › Colour scheme Light -> Dark), the four value rows' names") {
            if (!openMenuItem("Settings")) error("the app menu has no 'Settings'")
            val landing = awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 10_000)
            if (!landing) error("the Settings tab did not open from the menu")
            SystemClock.sleep(1_000)
            val touched = touchTapLabel("Look and Feel", prefix = true)
            val section = touched && awaitChrome("!!document.querySelector('$DRILL_IN $SETTINGS_ROW')", 8_000)
            finding("  Look and Feel touched $touched; its section over the landing: ${verdict(section)}")
            if (!section) error("Look and Feel did not open under a finger")
            SystemClock.sleep(1_500)
            // Fix 6: each value row is one node named "label, value" – the value once, after a comma.
            for ((label, value) in VALUE_ROWS) valueRowName(label, value)
            still("settings-look-light")

            // The flip: a real touch on the row, then on Dark, the clock started at the touch.
            chromeJs("window.__zenThemeFlips=[]")
            pageJs("window.__zenSchemeFlips=[]")
            val schemeBefore = pageValue(SCHEME_JS)
            val rowTouched = touchTapLabel(COLOR_SCHEME_ROW, prefix = true)
            val option = if (rowTouched) awaitNode(8_000) { it == "Dark" } else null
            val rested = option != null && awaitSheetAtRest(6_000)
            finding("  the Colour scheme row touched $rowTouched; the picker with 'Dark' at rest: ${verdict(rested)}")
            if (!rested) error("the Colour scheme picker did not open under a finger")
            still("colour-scheme-picker")
            val touchedAt = System.currentTimeMillis()
            val picked = touchTapLabelExpecting("Dark", "the row reads Colour scheme, Dark", timeoutMs = 8_000) { rowReads(COLOR_SCHEME_ROW, "Dark") }
            expect("a finger on 'Dark' sets the row to 'Colour scheme, Dark' (core colorScheme ${colorScheme()})", picked && colorScheme() == "dark", "flip-picked")
            // The page behind the Settings tab: its `matches` polled until it reads dark.
            val pageDarkAt = awaitPageScheme("dark", 4_000)
            val chromeFlip = lastThemeFlip("dark")
            val hostLine = hostFlipLog("dark")
            finding(
                "  timestamps (epoch ms): finger on Dark ${touchedAt}; chrome data-theme=dark ${chromeFlip?.optLong("at") ?: "not recorded"}" +
                    " (+${chromeFlip?.let { it.optLong("at") - touchedAt } ?: "?"} ms); host dispatched the configuration change ${hostLine ?: "not in logcat"}; " +
                    "the page's matches read dark ${pageDarkAt ?: "not within 4 s"} (+${pageDarkAt?.let { it - touchedAt } ?: "?"} ms after the finger" +
                    "${chromeFlip?.let { c -> pageDarkAt?.let { p -> ", ${p - c.optLong("at")} ms after the chrome" } } ?: ""}); the page was ${pageValue("document.visibilityState")} behind Settings"
            )
            expect("the page behind Settings sees prefers-color-scheme: dark within a second of the chrome's flip", chromeFlip != null && pageDarkAt != null && pageDarkAt - chromeFlip.optLong("at") <= 1_000, "flip-page-behind")
            expect("the row's name follows the value: 'Colour scheme, Dark' once", nodeCount { it.startsWith(COLOR_SCHEME_ROW) } == 1 && findNode { it == "$COLOR_SCHEME_ROW, Dark" } != null, "flip-row-name")
            SystemClock.sleep(1_200)
            still("settings-look-dark")
            // Back to the page through the core: the dark page under the dark chrome.
            activeCoreTab()?.optString("id")?.takeIf { it != NOTES_TAB && it != APP_TAB }?.let {
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(it)}}")
            }
            awaitActiveUrl(NOTES_URL, 8_000)
            SystemClock.sleep(1_500)
            val seen = pageValue(SCHEME_JS)
            val events = pageValue("JSON.stringify(window.__zenSchemeFlips)")
            finding("  the page on screen again sees $seen (before: $schemeBefore); its change events $events")
            expect("the page on screen is dark under the dark chrome", seen == "dark" && themeAttribute() == "dark", "flip-page-dark")
            still("theme-flip-page-dark")
        }
    }

    /** Fix 6: the row labelled `label` is one node in the tree named "label, value" – not "label value", not twice. */
    private fun valueRowName(label: String, value: String) {
        val names = findNodes { it.startsWith(label) }.map { (it.contentDescription ?: it.text)?.toString().orEmpty() }
        val want = "$label, $value"
        finding("  '$label' in the tree: ${names.map { "'$it'" }} (wanted one node '$want')")
        expect("'$label' reads '$want' once", names.size == 1 && names[0] == want, "value-row-${label.lowercase().replace(' ', '-')}")
    }

    // --- 3. the flip with the page on screen: timestamps ---------------------------------------------

    private fun themeFlipOnScreen() {
        step("3. The flip with the page on screen (through the core, the row's own action): Dark -> Light -> Dark -> Light") {
            val frame = pageValue("window.__zenFrameMs").toDoubleOrNull() ?: 0.0
            // A frame's reach: the chrome's `data-theme` is written a frame before it tells the
            // host (boot.ts `syncNativeTheme` waits one rAF for the painted token), and the page
            // reports the change at its own next frame – two frames at 60 Hz is 33 ms; the claim
            // allows 100 ms, or two of the page's measured frames when the software GPU runs slower.
            val bound = Math.max(100L, Math.round(2 * frame))
            finding("  the page's frame interval at rest: ${"%.1f".format(frame)} ms; the claim's bound: $bound ms after the chrome")
            for (scheme in listOf("light", "dark", "light")) {
                measuredFlip(scheme, bound)
                if (scheme == "dark") {
                    SystemClock.sleep(600)
                    still("theme-flip-page-dark-on-screen")
                }
                SystemClock.sleep(900)
            }
        }
    }

    /** Flip to `scheme` through the core and compare the chrome's attribute with the page's change event. */
    private fun measuredFlip(scheme: String, boundMs: Long) {
        chromeJs("window.__zenThemeFlips=[]")
        pageJs("window.__zenSchemeFlips=[]")
        val asked = System.currentTimeMillis()
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val took = awaitChrome("document.documentElement.getAttribute('data-theme')===${JSONObject.quote(scheme)}", 6_000)
        val event = awaitPageEvent(scheme == "dark", 3_000)
        val chromeFlip = lastThemeFlip(scheme)
        val hostLine = hostFlipLog(scheme)
        val delta = if (chromeFlip != null && event != null) event.optLong("at") - chromeFlip.optLong("at") else null
        val frameAfter = event?.optLong("frameAt", 0)?.takeIf { it > 0 }?.let { it - event.optLong("at") }
        finding(
            "  -> $scheme: asked $asked; chrome data-theme ${chromeFlip?.optLong("at") ?: "not recorded"} (+${chromeFlip?.let { it.optLong("at") - asked } ?: "?"} ms); " +
                "host dispatched ${hostLine ?: "not in logcat"}; page change event ${event?.optLong("at") ?: "none within 3 s"} " +
                "(${delta?.let { "$it ms after the chrome" } ?: "no delta"}; the page's next frame ${frameAfter?.let { "$it ms later" } ?: "?"}; visible ${event?.optString("visible")}); " +
                "the page sees ${pageValue(SCHEME_JS)}"
        )
        expect("the chrome flips to $scheme", took, "flip-$scheme-chrome")
        expect("the page's prefers-color-scheme flips with it, within a frame's reach ($boundMs ms) of the chrome", delta != null && delta in -50..boundMs, "flip-$scheme-page")
    }

    // --- 4. desktopSite: auto at the 600 dp crossing -------------------------------------------------

    private fun largeScreenCrossing() {
        step("4. desktopSite auto at the 600 dp crossing: the loaded page keeps its viewport and scroll; a fresh load follows the class") {
            val close = closeUrlField()
            if (!close.ok) finding("  (${close.describe()})")
            awaitActiveUrl(NOTES_URL, 8_000)
            val before = pageState()
            finding("  before: $before; chrome innerWidth ${chromeValue("String(window.innerWidth)")}")
            // A finger scrolls the page: down 400 dp over 700 ms from the lower middle of the
            // screen (the finger stays inside the window), then a pause so nothing flings.
            Finger().apply {
                down(width * 0.5f, height * 0.7f)
                moveBy(0f, -400 * density, 700)
                hold(300)
                up()
            }
            SystemClock.sleep(1_200)
            val scrolled = pageState()
            val scrollY = scrolled.optDouble("scrollY", 0.0)
            finding("  scrolled by a finger: $scrolled")
            expect("the page is scrolled (> 200 CSS px)", scrollY > 200, "cross-scrolled")
            val document = scrolled.optString("document")
            val phoneWidth = scrolled.optInt("innerWidth")
            still("crossing-phone-scrolled")

            resize(LARGE_SIZE)
            val large = awaitChrome("window.innerWidth>=600", 15_000)
            SystemClock.sleep(2_500)
            val crossed = pageState()
            finding("  at $LARGE_SIZE (${LARGE_DP} dp wide, the large-screen class): chrome innerWidth ${chromeValue("String(window.innerWidth)")} (>= 600: $large); page $crossed")
            expect("the window crossed 600 dp", large, "cross-large")
            expect("the loaded page keeps its document (no reload)", crossed.optString("document") == document, "cross-same-document")
            expect("the loaded page keeps its scroll (${scrollY} -> ${crossed.optDouble("scrollY")})", Math.abs(crossed.optDouble("scrollY", -1.0) - scrollY) <= 2, "cross-scroll-kept")
            expect("the loaded page keeps the phone layout, not the 980 desktop viewport (innerWidth ${crossed.optInt("innerWidth")})", crossed.optInt("innerWidth") in (phoneWidth - 1)..900, "cross-viewport-kept")
            still("crossing-large-kept")

            // A fresh load on the large screen: the class at the tab's load says desktop.
            reloadPage()
            val fresh = pageState()
            finding("  reloaded on the large screen: $fresh; UA desktop ${fresh.optString("ua").contains("X11; Linux")}")
            expect("a fresh load on the large screen is the desktop layout (980)", fresh.optString("document") != document && fresh.optInt("innerWidth") == 980, "cross-fresh-desktop")

            // Back under 600 dp: the loaded desktop page is kept as it is; a fresh load is the phone's.
            resize(PHONE_SIZE)
            val phone = awaitChrome("window.innerWidth<600", 15_000)
            SystemClock.sleep(2_500)
            val kept = pageState()
            finding("  back at $PHONE_SIZE (< 600: $phone): page $kept")
            expect("the loaded desktop page keeps its document and viewport under 600 dp", phone && kept.optString("document") == fresh.optString("document") && kept.optInt("innerWidth") == 980, "cross-back-kept")
            reloadPage()
            val freshPhone = pageState()
            finding("  reloaded on the phone: $freshPhone")
            expect("a fresh load under 600 dp is the phone layout again (innerWidth $phoneWidth)", freshPhone.optInt("innerWidth") == phoneWidth, "cross-fresh-phone")
            pageJs("window.scrollTo(0,0)")
            SystemClock.sleep(600)
        }
    }

    /** The page's document, viewport, scroll and user agent as one object (the demo page's `__zenState`). */
    private fun pageState(): JSONObject {
        val raw = pageValue("JSON.stringify(window.__zenState?window.__zenState():{})")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** `wm size` to `size` (`WxH`, px at the run's density), then the window measured again. */
    private fun resize(size: String) {
        finding("  wm size $size")
        shellCommand("wm size $size")
        SystemClock.sleep(3_000)
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        touchable = touchableBand(insets)
        finding("  window now ${width}x$height (${"%.0f".format(width / density)} x ${"%.0f".format(height / density)} dp), insets ${insets.top}/${insets.bottom}")
    }

    /** Reload the page on screen and wait for its fresh document. */
    private fun reloadPage() {
        val web = notesView() ?: error("the scheme page's view is gone")
        val before = pageValue("String(performance.timeOrigin)")
        instrumentation.runOnMainSync { web.reload() }
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val now = pageValue("String(performance.timeOrigin)+'|'+document.readyState")
            if (now.endsWith("|complete") && now.substringBefore('|') != before && now.substringBefore('|').isNotEmpty()) {
                SystemClock.sleep(1_200)
                return
            }
            SystemClock.sleep(300)
        }
        finding("  (the reload did not finish in 15 s)")
    }

    // --- 5. History: Select all / Deselect all --------------------------------------------------------

    private fun historySelectAll() {
        step("5. History multi-select: Select all and Deselect all under a finger (§9.6)") {
            if (!openMenuItem("History")) error("the app menu has no 'History'")
            val panel = awaitChrome("!!document.querySelector('input[placeholder=\"$HISTORY_SEARCH\"]')", 10_000)
            if (!panel) error("the History panel never came up")
            SystemClock.sleep(1_500)
            val first = HISTORY[0].second
            val firstRow = awaitNode(8_000) { it.startsWith("$first,") } ?: error("no row reads '$first, …'")
            val bounds = steadyBounds(firstRow) ?: error("the row '$first' went away")
            val point = touchPoint(bounds) ?: error("no part of the row '$first' is inside the touchable window")
            Finger().apply {
                press(point.x, point.y)
                up()
            }
            val selecting = awaitChrome("document.querySelectorAll('$LIST_CHECKBOX_ROW').length>0", 6_000)
            finding("  long press (a real touch at ${point.x.toInt()},${point.y.toInt()}) enters selection: ${verdict(selecting)}; header '${headerText()}'")
            if (!selecting) {
                touchFault("the long press on '$first' did not enter selection")
                error("the long press did not enter selection")
            }
            val shown = chromeValue("String(document.querySelectorAll('$LIST_CHECKBOX_ROW').length)").toIntOrNull() ?: 0
            expect("the header counts the held row (1 selected of $shown shown)", awaitChrome("/^1 selected/.test((document.querySelector('.zen-phone-panel h2.zen-phone-title')||{}).textContent||'')", 4_000), "history-one")
            val bulk = bulkButton()
            finding("  the header's bulk toggle: $bulk")
            expect("the header offers 'Select all' as a §9.18 secondary zen-v2-button", bulk.optString("text") == "Select all" && bulk.optBoolean("v2") && !bulk.optBoolean("primary"), "history-bulk-button")
            still("history-one-selected")
            val all = touchTapLabelExpecting("Select all", "every shown row is picked", timeoutMs = 6_000) { checkedRows() == shown && shown > 0 }
            expect("a finger on Select all picks every shown row ($shown)", all, "history-select-all")
            expect("the header counts them ('${headerText()}')", awaitChrome("/^$shown selected/.test((document.querySelector('.zen-phone-panel h2.zen-phone-title')||{}).textContent||'')", 4_000), "history-all-count")
            expect("the tree reads $shown checked checkboxes", awaitTreeCount(6_000, shown) { it.isCheckable && it.isChecked }, "history-all-tree")
            finding("  the bulk toggle now: ${bulkButton()}")
            SystemClock.sleep(800)
            still("history-select-all")
            val none = touchTapLabelExpecting("Deselect all", "no row is picked, the mode kept", timeoutMs = 6_000) {
                checkedRows() == 0 && chromeValue("String(document.querySelectorAll('$LIST_CHECKBOX_ROW').length)") == shown.toString()
            }
            expect("a finger on Deselect all unpicks every row and keeps the mode (the X remains the way out)", none, "history-deselect-all")
            expect("the header reads '0 selected' ('${headerText()}')", awaitChrome("/^0 selected/.test((document.querySelector('.zen-phone-panel h2.zen-phone-title')||{}).textContent||'')", 4_000), "history-zero")
            expect("the toggle reads Select all again", bulkButton().optString("text") == "Select all", "history-toggle-back")
            still("history-deselect-all")
            back()
            SystemClock.sleep(1_200)
            finding("  back leaves selection: rows as buttons again ${verdict(awaitChrome("document.querySelectorAll('$LIST_CHECKBOX_ROW').length===0", 6_000))}")
            back()
            SystemClock.sleep(1_500)
        }
    }

    /** The selection header's count ("2 selected", `h2.zen-phone-title`); "" while no selection is on. */
    private fun headerText(): String =
        chromeValue("(function(){var e=document.querySelector('.zen-phone-panel h2.zen-phone-title');return e?e.textContent.trim().replace(/\\s+/g,' ').slice(0,60):''})()")

    /** How many list rows read checked in the DOM. */
    private fun checkedRows(): Int =
        chromeValue("String(document.querySelectorAll('$LIST_CHECKBOX_ROW[aria-checked=\"true\"]').length)").toIntOrNull() ?: -1

    /** The header's bulk toggle as the DOM has it: its words, its class and whether it is the primary. */
    private fun bulkButton(): JSONObject {
        val raw = chromeValue(
            "JSON.stringify((function(){var h=document.querySelector('.zen-phone-panel header');if(!h)return {};" +
                "var b=Array.prototype.find.call(h.querySelectorAll('button'),function(x){return /select all/i.test(x.textContent)});" +
                "if(!b)return {text:'none'};return {text:b.textContent.trim(),v2:b.classList.contains('zen-v2-button'),primary:b.hasAttribute('data-primary')," +
                "icon:b.classList.contains('zen-v2-icon-button'),height:Math.round(b.getBoundingClientRect().height),disabled:b.disabled}})())"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    // --- 6. the pill's keyboard ring -----------------------------------------------------------------

    private fun keyboardRing() {
        step("6. The pill's keyboard ring: a touch-driven focus return rings nothing, a hardware keyboard's Tab rings a bar button and the pill (A11Y-09)") {
            val close = closeUrlField()
            if (!close.ok) finding("  (${close.describe()})")
            // A real touch on the bar's Menu button, then back: the chassis returns the focus to
            // the button under the finger's reading.
            val menu = touchTapLabelExpecting(MENU_LABEL, "the menu sheet is up", timeoutMs = 8_000) { chromeSurfaceUp() }
            if (!menu) error("the menu never opened under a finger")
            SystemClock.sleep(1_200)
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_000)
            chromeJs("window.__zenFocusPath=[]")
            finding("  after the touch and back: data-input '${dataInput()}', focus on ${focusedElement()}, its ring ${ringText(ring())}")
            expect("the last input is the touch", dataInput() == "touch", "ring-touch-first")
            expect("the focus the chassis returned under the finger draws no ring", !ring().optBoolean("rings"), "ring-touch-no-ring")

            // Shift+Tab, as a hardware keyboard sends it, until a bar button holds the focus.
            var onButton = tabUntil("$BAR_BUTTON:focus", 6, shift = true)
            if (!onButton) {
                // The focus was not on the bar when the keys began (the path is on record above):
                // the Menu button is given the focus by script and ONE Shift+Tab moves it to its
                // neighbour – the move that draws the ring is still the keyboard's.
                finding("  (six Shift+Tabs did not reach a bar button; anchoring on the Menu button and pressing Shift+Tab once)")
                chromeJs("(document.querySelector('$BAR_BUTTON[aria-label=\"$MENU_LABEL\"]')||{focus:function(){}}).focus()")
                SystemClock.sleep(300)
                onButton = tabUntil("$BAR_BUTTON:focus", 1, shift = true)
            }
            expect("Shift+Tab reaches a bar button (${focusedElement()})", onButton, "ring-bar-reached")
            expect("the keyboard is the last input", dataInput() == "keyboard", "ring-keyboard")
            val buttonRing = ring()
            finding("  the bar button's ring: ${ringText(buttonRing)}")
            expect("the bar button draws the shared ring (2 px solid --v2-ring, 2 inside)", buttonRing.optBoolean("rings") && buttonRing.optString("outlineOffset") == "-2px", "ring-bar")
            still("bar-button-keyboard-ring")

            // On to the pill: its address and chips sit in it; the ring is the pill's.
            val inPill = tabUntil(".zen-phone-pill button:focus", 6, shift = true)
            expect("Shift+Tab reaches the pill (${focusedElement()})", inPill, "ring-pill-reached")
            val pillRing = JSONObject(chromeValue("JSON.stringify(window.__zenRing(document.activeElement&&document.activeElement.closest('.zen-phone-pill')))").ifEmpty { "{}" })
            val buttonInPill = ring()
            finding("  the pill's ring: ${ringText(pillRing)}; the focused button's own: ${ringText(buttonInPill)}")
            expect("the pill draws the shared ring around itself (2 px solid --v2-ring, 2 inside)", pillRing.optBoolean("rings") && pillRing.optString("outlineOffset") == "-2px", "ring-pill")
            expect("the button inside the pill draws no ring of its own", !buttonInPill.optBoolean("rings"), "ring-pill-button-none")
            still("pill-keyboard-ring")

            // The next real touch: the Tabs button opens the overview, back returns the focus to it – no ring.
            val opened = touchTapLabelExpecting("Tabs (", "the overview is up", prefix = true, timeoutMs = 8_000) {
                chromeValue("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"
            }
            if (!opened) error("the overview never opened under a finger")
            SystemClock.sleep(1_500)
            back()
            SystemClock.sleep(2_000)
            val rings = chromeValue(
                "JSON.stringify(Array.prototype.filter.call(document.querySelectorAll('.zen-phone-pill, .zen-phone-pill button, $BAR_BUTTON')," +
                    "function(e){return window.__zenRing(e).rings}).map(window.__zenDescribe))"
            )
            finding("  after the touch on Tabs and back: data-input '${dataInput()}', focus on ${focusedElement()}, ringed in the bar: $rings")
            expect("the touch is the last input again", dataInput() == "touch", "ring-touch-again")
            expect("nothing in the bar or the pill rings after the touch-driven return", rings == "[]", "ring-touch-none")
        }
    }

    /**
     * Press Tab (Shift+Tab with `shift`) until the chrome's active element matches `selector`, at
     * most `max` times; the path the focus took is a finding. True when it got there.
     */
    private fun tabUntil(selector: String, max: Int, shift: Boolean): Boolean {
        val quoted = JSONObject.quote(selector)
        for (press in 1..max) {
            pressKey(KeyEvent.KEYCODE_TAB, shift)
            SystemClock.sleep(500)
            if (chromeValue("String(!!document.activeElement&&document.activeElement.matches($quoted))") == "true") {
                finding("  ${if (shift) "Shift+Tab" else "Tab"} x$press: ${chromeValue("window.__zenFocusPath.join(' > ')")} -> ${focusedElement()}")
                return true
            }
        }
        finding("  ${if (shift) "Shift+Tab" else "Tab"} x$max: ${chromeValue("window.__zenFocusPath.join(' > ')")} -> ${focusedElement()}")
        return false
    }

    /** A key as a hardware keyboard's, down and up, with the left Shift held around it when `shift`. */
    private fun pressKey(keyCode: Int, shift: Boolean = false) {
        val meta = if (shift) KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON else 0
        if (shift) injectKey(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT, meta)
        injectKey(KeyEvent.ACTION_DOWN, keyCode, meta)
        injectKey(KeyEvent.ACTION_UP, keyCode, meta)
        if (shift) injectKey(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT, 0)
    }

    private fun injectKey(action: Int, keyCode: Int, meta: Int) {
        val now = SystemClock.uptimeMillis()
        val event = KeyEvent(now, now, action, keyCode, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
        if (!ui.injectInputEvent(event, true)) finding("  (the ${KeyEvent.keyCodeToString(keyCode)} ${if (action == KeyEvent.ACTION_DOWN) "down" else "up"} was not injected)")
        SystemClock.sleep(30)
    }

    /** The active element's ring, read off the chrome's computed style (the probe's `__zenRing`). */
    private fun ring(): JSONObject {
        val raw = chromeValue("JSON.stringify(window.__zenRing?window.__zenRing(document.activeElement):{})")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    private fun ringText(ring: JSONObject): String =
        "${ring.optString("desc")}: :focus-visible ${ring.optBoolean("focusVisible")}, outline ${ring.optString("outlineWidth")} " +
            "(${"%.2f".format(ring.optDouble("widthDevicePx", 0.0))} device px, wanted ${"%.0f".format(ring.optDouble("wantDevicePx", 0.0))}) " +
            "${ring.optString("outlineStyle")} ${ring.optString("outlineColor")} (--v2-ring ${ring.optString("ringToken")}) at ${ring.optString("outlineOffset")}" +
            " -> ${if (ring.optBoolean("rings")) "RINGS" else "no ring"}"

    private fun dataInput(): String = chromeValue("document.documentElement.getAttribute('data-input')||''")

    // --- the theme's record ----------------------------------------------------------------------------

    /** The last `data-theme` mutation to `theme` the chrome's observer recorded, or null. */
    private fun lastThemeFlip(theme: String): JSONObject? {
        val raw = chromeValue("JSON.stringify((window.__zenThemeFlips||[]).filter(function(f){return f.theme===${JSONObject.quote(theme)}}).slice(-1)[0]||null)")
        return runCatching { JSONObject(raw) }.getOrNull()
    }

    /** Poll the page's `matches` until it reads `scheme`; the page's own epoch ms at that read, or null. */
    private fun awaitPageScheme(scheme: String, timeoutMs: Long): Long? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val read = pageValue("($SCHEME_JS)+'@'+Date.now()")
            if (read.startsWith("$scheme@")) return read.substringAfter('@').toLongOrNull()
            SystemClock.sleep(40)
        }
        return null
    }

    /** The page's change event to `dark` (its `matches`), with its timestamps, or null when none came. */
    private fun awaitPageEvent(dark: Boolean, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = pageValue("JSON.stringify((window.__zenSchemeFlips||[]).filter(function(f){return f.dark===$dark}).slice(-1)[0]||null)")
            val event = runCatching { JSONObject(raw) }.getOrNull()
            if (event != null) {
                // One more frame for `frameAt`.
                SystemClock.sleep(120)
                return runCatching { JSONObject(pageValue("JSON.stringify((window.__zenSchemeFlips||[]).filter(function(f){return f.dark===$dark}).slice(-1)[0]||null)")) }.getOrNull() ?: event
            }
            SystemClock.sleep(60)
        }
        return null
    }

    /** The host's own log line of the dispatch (`ZenHost: theme flip to <scheme>: …`), the latest, with its epoch ms; null when none. */
    private fun hostFlipLog(scheme: String): String? {
        val lines = runCatching { shellCommand("logcat -d -v epoch ZenHost:I *:S") }.getOrDefault("").lines()
        val line = lines.lastOrNull { it.contains("theme flip to $scheme") } ?: return null
        val seconds = line.trim().substringBefore(' ').toDoubleOrNull()
        val at = seconds?.let { Math.round(it * 1000) }
        return "${at ?: "?"} (${line.substringAfter("ZenHost").trim().trimStart(':').trim()})"
    }

    // --- the page --------------------------------------------------------------------------------------

    /** The scheme page's WebView (the seeded `tab_notes`), on screen or behind another tab. */
    private fun notesView(): TabWebView? {
        var view: TabWebView? = null
        instrumentation.runOnMainSync { view = (activity as MainActivity).host.tabs.get(NOTES_TAB) }
        return view
    }

    /** Evaluate in the scheme page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = (activity as MainActivity).host.tabs.get(NOTES_TAB)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** A value read from the page as text ("" when it did not answer). */
    private fun pageValue(code: String): String =
        runCatching { JSONTokener(pageJs("String($code)")).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    // --- the tree ----------------------------------------------------------------------------------------

    private fun nodeCount(matches: (String) -> Boolean): Int = findNodes(matches).size

    private fun awaitTreeCount(timeoutMs: Long, count: Int, accept: (AccessibilityNodeInfo) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (countNodes(accept) >= count) return true
            SystemClock.sleep(250)
        }
        return countNodes(accept) >= count
    }

    private fun countNodes(accept: (AccessibilityNodeInfo) -> Boolean): Int {
        var n = 0
        val root = ui.rootInActiveWindow ?: return 0
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (accept(node)) n++
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return n
    }

    /** The sheet's rows for the folded chips, by their accessible names ("Requests blocked, 5"). */
    private fun sheetRows(): List<String> {
        val raw = chromeJs(
            "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=\"siteinfo-pill-chips\"] button'))" +
                ".map(function(b){return b.getAttribute('aria-label')||b.textContent.trim()}))"
        )
        val text = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: return emptyList()
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.optString(it) }
    }

    // --- the colour scheme -------------------------------------------------------------------------------

    private fun themeAttribute(): String = chromeValue("document.documentElement.getAttribute('data-theme')||''")

    private fun colorScheme(): String = coreState().getJSONObject("settings").optString("colorScheme")

    // --- stills, steps, findings -------------------------------------------------------------------------

    private fun still(name: String) {
        shotIndex++
        shot("%02d-%s".format(shotIndex, name))
    }

    /** Run one step of the sequence; a failure inside it is a finding and a failure of the run. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
            recover()
        }
    }

    /** A claim of the sequence, on record either way; a failed one fails the run. */
    private fun expect(claim: String, held: Boolean, id: String) {
        finding("  $claim ${verdict(held)}")
        if (!held) failures += "$id: $claim"
    }

    /** After a step threw: the window back to the phone's, the scheme light, whatever is up sent away, the page the active tab. */
    private fun recover() {
        if (width / density >= 600) resize(PHONE_SIZE)
        if (colorScheme() != "light") {
            coreInvoke("settings.update", JSONObject().put("colorScheme", "light").toString())
            SystemClock.sleep(900)
        }
        repeat(3) {
            if (!chromeSurfaceUp()) return@repeat
            back()
            SystemClock.sleep(1_000)
        }
        activeCoreTab()?.optString("id")?.takeIf { it != NOTES_TAB && it != APP_TAB }?.let {
            runCatching { coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(it)}}") }
            SystemClock.sleep(1_000)
        }
        if (activeCoreTab()?.optString("id") != NOTES_TAB) runCatching { coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(NOTES_TAB)}}") }
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a finger landing on a moving sheet catches it instead of tapping.
     */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length>=1&&" +
                "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(800)
        return rested
    }

    private fun awaitActiveUrl(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == url && !tab.optBoolean("loading", true)) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /** The chrome's focused element, described: tag, `data-row`, class, aria-label, id or text; "body" for none. */
    private fun focusedElement(): String = chromeValue("window.__zenDescribe?window.__zenDescribe(document.activeElement):'?'")

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/notes.html" to ("text/html; charset=utf-8" to SCHEME_PAGE.toByteArray()),
        "/app/" to DemoServer.page("Sketch Studio", "<p>The second tab.</p>")
    )

    companion object {
        private const val PORT = 18139
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val NOTES_URL = "$ORIGIN/notes.html"
        private const val NOTES_TAB = "tab_notes"
        private const val APP_TAB = "tab_app"
        private const val SETTINGS_URL = "zen://settings"
        private const val SETTINGS_SEARCH = ".zen-settings-search-field"
        private const val DRILL_IN = ".zen-settings-drill-in"
        private const val SETTINGS_ROW = ".zen-settings-row"
        private const val SITE_ICON_LABEL = "Site information"
        private const val SITE_ROW = "tracking-site-current"
        private const val COLOR_SCHEME_ROW = "Colour scheme"
        private const val LIST_CHECKBOX_ROW = ".zen-phone-row > .zen-list-main[role=\"checkbox\"]"
        private const val HISTORY_SEARCH = "Search history"
        /** The bar's own buttons (`PhoneShell.tsx`'s `nav.zen-phone-bar`, `BarButton.tsx`): the row's controls beside the pill. */
        private const val BAR_BUTTON = ".zen-phone-bar-row .zen-toolbar-button"
        /** The window past 600 dp at the recipe's density 280 (1.75): 1080 px is 617 dp, the large-screen class. */
        private const val LARGE_SIZE = "1080x1600"
        private const val LARGE_DP = 617
        private const val PHONE_SIZE = "720x1600"
        /** The page's reading of `prefers-color-scheme`. */
        private const val SCHEME_JS = "(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')"

        /** Fix 6: the four Look and Feel value rows #237's audit left with the owner, with the seeded profile's values. */
        private val VALUE_ROWS = listOf(
            "Colour scheme" to "Light",
            "Toolbar layout" to "Single toolbar",
            "Floating behaviour" to "Floating only when typing",
            "Position on phones" to "Bottom"
        )

        /** Yesterday's rows for the History list, by url and title. */
        private val HISTORY = listOf(
            "https://example.com/" to "Example Domain",
            "https://en.wikipedia.org/wiki/Tea" to "Tea - Wikipedia",
            "https://www.rfc-editor.org/rfc/rfc1149.html" to "RFC 1149: IP Datagrams on Avian Carriers",
            "https://info.cern.ch/hypertext/WWW/TheProject.html" to "World Wide Web"
        )

        /**
         * The chrome's own account for the findings: the focused element described, the focus
         * path since the last reset (`focusin`), an element's ring as its computed style (the
         * outline's four parts, the width in device pixels beside the `devicePixelRatio`, `--v2-ring`
         * as the same `rgb()` text, whether `:focus-visible` holds, and the one verdict `rings`: a
         * solid outline of `floor(2 × dpr)` device pixels in the ring's ink), the place of an
         * element in the viewport, and the record of every `data-theme` change on the root with
         * its epoch time.
         */
        private val PROBE_JS = """
            (function(){
              window.__zenDescribe=function(el){
                if(!el||el===document.body||el===document.documentElement)return 'body';
                var d=(el.tagName||'').toLowerCase();
                var a=el.getAttribute?el.getAttribute('data-row'):null;if(a)d+='[data-row='+a+']';
                var c=(el.className&&typeof el.className==='string')?el.className.split(/\s+/).filter(function(k){return /^zen-/.test(k)}).slice(0,3).join('.'):'';if(c)d+='.'+c;
                var l=el.getAttribute?el.getAttribute('aria-label'):null;if(l)d+='[aria-label='+l+']';
                if(el.id)d+='#'+el.id;
                var t=(el.textContent||'').trim().replace(/\s+/g,' ');if(!l&&!el.id&&t)d+=' "'+t.slice(0,40)+'"';
                return d};
              window.swatch=function(v){var s=document.createElement('span');s.style.color=v;document.body.appendChild(s);var c=getComputedStyle(s).color;s.remove();return c};
              window.__zenRing=function(el){
                if(!el)return {desc:'none',rings:false};
                var cs=getComputedStyle(el);
                var dpr=window.devicePixelRatio,w=parseFloat(cs.outlineWidth)*dpr,want=Math.max(1,Math.floor(2*dpr));
                var token=window.swatch(cs.getPropertyValue('--v2-ring'));
                var rings=cs.outlineStyle==='solid'&&Math.abs(w-want)<0.02&&cs.outlineColor===token;
                return {desc:window.__zenDescribe(el),focusVisible:el.matches(':focus-visible'),
                  outlineStyle:cs.outlineStyle,outlineWidth:cs.outlineWidth,outlineOffset:cs.outlineOffset,outlineColor:cs.outlineColor,
                  dpr:dpr,widthDevicePx:w,wantDevicePx:want,ringToken:token,background:cs.backgroundColor,rings:rings}};
              window.__zenPlace=function(sel){
                var el=document.querySelector(sel);if(!el)return {label:'absent',onScreen:false};
                var r=el.getBoundingClientRect(),g=el.closest('[data-group]'),gr=g?g.getBoundingClientRect():null;
                var sc=el.closest('.zen-settings-scroll, .zen-settings-drill-in, main')||document.scrollingElement;
                return {label:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,60),top:Math.round(r.top),bottom:Math.round(r.bottom),
                  viewport:window.innerHeight,onScreen:r.top>=0&&r.bottom<=window.innerHeight&&r.height>0,
                  group:g?g.getAttribute('data-group'):'',groupTop:gr?Math.round(gr.top):-1,scrollTop:sc?Math.round(sc.scrollTop):-1}};
              window.__zenFocusPath=[];
              document.addEventListener('focusin',function(e){window.__zenFocusPath.push(window.__zenDescribe(e.target))},true);
              window.__zenThemeFlips=[];
              new MutationObserver(function(ms){ms.forEach(function(m){if(m.attributeName==='data-theme')window.__zenThemeFlips.push({theme:document.documentElement.getAttribute('data-theme'),at:Date.now()})})})
                .observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
              return 'probe'})()
        """.trimIndent()

        /**
         * The scheme page: it styles itself by `prefers-color-scheme` and says which it sees, records
         * every change of it with epoch timestamps (and the next frame's), measures its frame
         * interval, and is tall by fixed blocks – so its height does not follow its width and a
         * scroll position means the same at every viewport.
         */
        private val SCHEME_PAGE = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <meta name=color-scheme content="light dark">
            <title>Scheme and scroll</title>
            <style>
            :root{color-scheme:light dark}
            body{margin:0;font-family:sans-serif;background:#f4f1ea;color:#1b1b1f}
            h1{margin:0;padding:28px 20px 6px;font-size:26px}
            p{margin:0;padding:0 20px 8px;font-size:17px;line-height:1.4}
            .block{height:300px;margin:12px 20px;border-radius:14px;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;font-size:22px}
            #scheme{position:fixed;top:10px;right:12px;padding:8px 12px;border-radius:10px;background:#1b4332;color:#fff;font-size:15px;font-weight:600}
            @media (prefers-color-scheme: dark){body{background:#14161c;color:#e8e6e3}.block{background:rgba(255,255,255,.1)}#scheme{background:#d8f3dc;color:#081c15}}
            </style></head>
            <body><h1>Scheme and scroll</h1><p>This page follows prefers-color-scheme and is 40 blocks tall.</p><div id=scheme></div>
            ${(1..40).joinToString("") { "<div class=block>Block $it</div>" }}
            <script>
            (function(){
              var mq=matchMedia('(prefers-color-scheme: dark)');
              window.__zenSchemeFlips=[];
              function show(){document.getElementById('scheme').textContent=(mq.matches?'dark':'light')+' scheme'}
              mq.addEventListener('change',function(e){var rec={dark:e.matches,at:Date.now(),visible:document.visibilityState,frameAt:0};
                window.__zenSchemeFlips.push(rec);requestAnimationFrame(function(){rec.frameAt=Date.now()});show()});
              show();
              window.__zenFrameMs=0;var last=0,n=0,sum=0;
              (function tick(t){if(last){sum+=t-last;n++;window.__zenFrameMs=sum/n}last=t;if(n<30)requestAnimationFrame(tick)})(0);
              window.__zenState=function(){var m=document.querySelector('meta[name=viewport]');
                return {document:String(performance.timeOrigin),innerWidth:window.innerWidth,innerHeight:window.innerHeight,scrollY:Math.round(window.scrollY),
                  docHeight:document.documentElement.scrollHeight,viewportMeta:m?m.getAttribute('content'):'',scheme:mq.matches?'dark':'light',ua:navigator.userAgent}};
            })();
            </script></body></html>
        """.trimIndent()
    }
}
