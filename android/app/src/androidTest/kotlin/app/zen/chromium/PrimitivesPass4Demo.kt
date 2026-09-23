package app.zen.chromium

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.browser.customtabs.CustomTabsIntent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
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
 * The primitives pass 4 items on a device, each under the finger or the key that reaches it:
 *
 *  1. A LIST sheet (the overview's Recently closed, 20 tabs seeded): it opens on its first row
 *     (§9.22, `focus="first"`), its rows' leading glyphs are full ink (§10.4), dragged up it
 *     stands at 80 % of the frame with the list scrolling under the title (§9.20, `body="list"`),
 *     and scrolled to its end the last row stands 16 + inset over the edge (§9.25).
 *  2. A PROMPT sheet (History's Clear history): the container holds the focus – not Cancel
 *     (§9.22's named failure) – and draws no ring for it; the footer's buttons stand 16 + inset
 *     over the edge (§9.25).
 *  3. A VALUE sheet (Settings › Look and Feel › Colour scheme): it opens on the checked option
 *     (§9.22), and its last option stands 16 + inset over the edge – the Settings sheets on the
 *     chassis's one formula (§9.25).
 *  4. A hardware keyboard's Tab off the page (A11Y-09's remainder): Tab past the page's last
 *     tabbable lands on the chrome's first control, ringed (`:focus-visible` on a keyboard focus,
 *     `data-input` keyboard), Shift+Tab off it lands back on the page's last tabbable, Tab
 *     through the chrome lands on the page's first, and Shift+Tab past that on the chrome's last
 *     (`FocusHandoff.kt`, `Host.onFocusLanding`, `TabWebView.focusEdge`, `@shared/focusEdge`).
 *  5. The custom tab's menu sheet: the native chassis's hairline edge read off the screen – one
 *     dp of the border ink over the panel along the top and the two sides, none along the
 *     bottom (`SheetEdge`, `PromptSheetSpec.hairlinePx`).
 *
 * The footers' gaps are measured in the chrome's CSS px beside the inset the host reported
 * (`--zen-inset-bottom`, `windowInsets()`): the formula's 16 + inset reads 40 over the recipe's
 * 24 dp bar, 64 over a 48 dp three-button bar. The focus landings are the DOM's word; what the
 * accessibility tree (TalkBack's reading) lists as the input-focused node is a finding beside
 * each, waited on as long as the tree takes here (the note in `PhoneFixesDemo`).
 *
 * Every claim is a line in `android-primitives-4-findings.txt` and a failed one fails the run;
 * the recording goes on to the end either way. Profile `pwa-demo-state.json` (two tabs on this
 * driver's loopback server, the links page the active one), the recently closed list and
 * yesterday's history seeded here.
 */
@RunWith(AndroidJUnit4::class)
class PrimitivesPass4Demo : DemoHarness("pwa-demo-state.json", "android-primitives-4", "primitives-4-demo") {
    override val tag = "PrimitivesPass4Demo"
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
     * The seeded tabs point at this driver's loopback server; the links page (`tab_notes`) is
     * the active tab; the bar stays put (`hideToolbarOnScroll` off). The profile is written at
     * v3 with twenty recently closed tabs (before v3 the list lived in memory only, `state.ts`):
     * enough rows for the Recently closed sheet to outgrow 80 % of the frame.
     */
    override fun patchState(json: String): String {
        val state = JSONObject(json.replace("127.0.0.1:18131", "127.0.0.1:$PORT"))
        state.put("version", 3)
        state.getJSONObject("settings").put("hideToolbarOnScroll", false)
        val closed = JSONArray()
        val now = System.currentTimeMillis()
        CLOSED.forEachIndexed { i, (url, title) ->
            closed.put(
                JSONObject()
                    .put("kind", "tab")
                    .put("id", "closed_$i")
                    .put("closedAt", now - (i + 1) * 90_000L)
                    .put(
                        "tab",
                        JSONObject().put("id", "tab_closed_$i").put("url", url).put("title", title)
                            .put("containerId", "default").put("spaceId", "space_main")
                    )
                    .put("spaceId", "space_main")
                    .put("folderId", JSONObject.NULL)
                    .put("index", 0)
                    .put("windowId", JSONObject.NULL)
                    .put("navigation", JSONObject.NULL)
            )
        }
        state.put("recentlyClosed", closed)
        return state.toString()
    }

    /** Yesterday's visits, in the history contract's shape, so the History list has rows and its Clear history row. */
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
        findings = File(out, "android-primitives-4-findings.txt")
        findings.writeText(
            "Zenium Android primitives pass 4 check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n" +
                "1 a list sheet: first-row focus, full-ink glyphs, the 80 % cap, the 16 + inset edge; 2 a prompt sheet: the container's focus with no ring, " +
                "the footer's 16 + inset edge; 3 a value sheet: the checked option's focus, the 16 + inset edge; " +
                "4 a hardware keyboard's Tab off the page into the chrome and back (A11Y-09); 5 the custom tab menu's one-dp hairline\n\n"
        )
        // The events the WebView sends are the tree's only word that it changed (UiAutomation's
        // cache lives on them): on record for the findings that say how far the tree trailed.
        recordA11yEvents()
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
        calibrateDomBoxes()
        val insets = windowInsets()
        finding(
            "warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; the host's insets: bottom ${insets.bottom} px " +
                "(${"%.1f".format(insets.bottom / density)} dp; tappable ${insets.tappableBottom} px), top ${insets.top} px; the chrome's " +
                "--zen-inset-bottom '${chromeInset("bottom")}', --zen-inset-top '${chromeInset("top")}', devicePixelRatio ${chromeValue("String(window.devicePixelRatio)")}; " +
                "data-input '${dataInput()}'; tree cache ${if (Build.VERSION.SDK_INT >= 34) "dropped before every read" else "kept (API < 34)"}"
        )
    }

    override fun demo() {
        listSheet()
        promptSheet()
        valueSheet()
        keyboardTraversal()
        customTabHairline()
        finding("\nend: ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    // --- 1. a list sheet: Recently closed ----------------------------------------------------------------

    private fun listSheet() {
        step("1. A list sheet (Recently closed): opens on its first row, full-ink glyphs, capped at 80 % of the frame, its last row 16 + inset over the edge") {
            val close = closeUrlField()
            if (!close.ok) finding("  (${close.describe()})")
            val opened = touchControlExpecting("Tabs (", barButtonPrefixJs("Tabs ("), "the overview is up", prefix = true, timeoutMs = 8_000) {
                chromeValue(OVERVIEW_SCALE_JS) == "scale(1)"
            }
            if (!opened) error("the overview never opened under a finger")
            SystemClock.sleep(1_500)
            val menu = touchControlExpecting("More", OVERVIEW_MORE_JS, "the overview's menu sheet is up", timeoutMs = 8_000) {
                chromeValue("String(!!document.querySelector('.zen-sheet .zen-sheet-item'))") == "true"
            }
            if (!menu) error("the overview's More never opened its sheet")
            awaitSheetSettled(".zen-sheet .zen-sheet-item", 6_000)
            val rowLabel = chromeValue("(function(){var b=$RECENTLY_CLOSED_ROW_JS;return b?b.textContent.trim():''})()")
            // The core's list: the twenty seeded and, filed on top of them, the Settings tab the
            // warm-up closed (a tab closed in this session goes first, as it should).
            val listed = runCatching { JSONArray(coreInvoke("session.recentlyClosed")).length() }.getOrDefault(-1)
            finding("  the menu's row reads '$rowLabel'; the core's list holds $listed entries (${CLOSED.size} seeded, the warm-up's Settings tab filed on top)")
            expect("the menu counts the list's entries ('Recently Closed ($listed)')", listed > 0 && rowLabel == "Recently Closed ($listed)", "list-menu-count")
            val up = touchControlExpecting("Recently Closed (", RECENTLY_CLOSED_ROW_JS, "the Recently closed sheet is up on its own", timeoutMs = 10_000, prefix = true) {
                chromeValue("String(document.querySelectorAll('.zen-sheet').length===1&&!!document.querySelector('$CLOSED_ROW'))") == "true"
            }
            if (!up) error("the Recently closed sheet never came up under a finger")
            awaitSheetSettled(CLOSED_ROW, 6_000)
            val focus = focusedElement()
            val first = chromeValue("window.__zenDescribe(document.querySelector('$CLOSED_ROW'))")
            val peek = sheetProbe(CLOSED_ROW)
            finding("  the sheet opens with the focus on $focus (its first row: $first); data-input '${dataInput()}'; ${sheetText(peek)}")
            expect("the list sheet opens on its first row (§9.22, focus=\"first\")", focus == first && first != "body" && focus.isNotEmpty(), "list-focus-first")
            expect("the sheet is marked a list (data-body=\"list\", §9.20)", peek.optString("body") == "list", "list-body")
            expect("the rows' leading glyphs are full ink (§10.4: .zen-list-lead at opacity 1, computed '${peek.optString("leadOpacity")}')", peek.optString("leadOpacity") == "1", "list-lead-ink")
            treeFocusFinding(chromeValue("(function(){var e=document.querySelector('$CLOSED_ROW');return e?(e.getAttribute('aria-label')||''):''})()"))
            still("recently-closed-peek")

            // The handle dragged up: the sheet goes to its expanded detent, the cap.
            val handle = awaitFresh(6_000, "the sheet's handle") { it == "Resize sheet" }
            val point = handle?.let { steadyBounds(it)?.let { b -> touchPoint(b) } }
                ?: domBox("document.querySelector('.zen-sheet .zen-sheet-handle-hit')")?.let { touchPoint(it) }?.also { finding("  (the drag starts at the DOM's box for the handle)") }
                ?: error("the sheet's handle is nowhere inside the touchable window")
            Finger().apply {
                down(point.x, point.y)
                moveBy(0f, -0.5f * height, 220)
                hold(120)
                up()
            }
            val grew = awaitChrome("(function(){var p=window.__zenSheet('$CLOSED_ROW');return !!p&&p.height>=p.cap-2})()", 8_000)
            awaitSheetSettled(CLOSED_ROW, 6_000)
            val expanded = sheetProbe(CLOSED_ROW)
            finding(
                "  after the drag: ${sheetText(expanded)}; the cap = round(min(layer − insetTop − 40, 0.8 × layer)) = ${expanded.optInt("cap")}; " +
                    "the list scrolls ${expanded.optInt("scrollHeight")} in ${expanded.optInt("clientHeight")}"
            )
            expect("the expanded list sheet stands at 80 % of the frame (§9.20: the cap ${expanded.optInt("cap")}, measured ${expanded.optInt("height")}, ±2)", grew && Math.abs(expanded.optInt("height") - expanded.optInt("cap")) <= 2, "list-cap")
            expect("the list scrolls under the title at the cap", expanded.optInt("scrollHeight") > expanded.optInt("clientHeight"), "list-scrolls")
            still("recently-closed-capped")

            // Scrolled to the end: the last row's bottom against the sheet's edge.
            chromeJs("(function(){var s=document.querySelector('.zen-sheet .zen-sheet-scroll');if(s)s.scrollTop=s.scrollHeight})()")
            SystemClock.sleep(900)
            val end = sheetProbe(CLOSED_ROW)
            val want = 16 + end.optInt("insetBottom")
            finding("  scrolled to the end: the last row's bottom ${end.optDouble("gapLastRow")} CSS px over the sheet's edge; wanted 16 + inset ${end.optInt("insetBottom")} = $want (the host's bottom inset ${windowInsets().bottom} px)")
            expect("the list's last row stands 16 + inset over the edge (§9.25: $want, measured ${end.optDouble("gapLastRow")})", Math.abs(end.optDouble("gapLastRow", -100.0) - want) <= 1, "list-footer-gap")
            still("recently-closed-end")

            back()
            finding("  back sends the sheet away: ${verdict(awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 6_000))}")
            SystemClock.sleep(800)
            back()
            finding("  back leaves the overview: ${verdict(awaitChrome("(function(){var e=document.querySelector('.zen-overview');return !e||e.style.transform!=='scale(1)'})()", 6_000))}")
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
        }
    }

    // --- 2. a prompt sheet: Clear history -----------------------------------------------------------------

    private fun promptSheet() {
        step("2. A prompt sheet (Clear history): the container holds the focus with no ring; the footer's buttons 16 + inset over the edge") {
            if (!openMenuItem("History")) error("the app menu has no 'History'")
            val panel = awaitChrome("!!document.querySelector('input[placeholder=\"$HISTORY_SEARCH\"]')", 10_000)
            if (!panel) error("the History panel never came up")
            SystemClock.sleep(1_500)
            val up = touchControlExpecting("Clear history", CLEAR_ROW_JS, "the Clear history prompt is up", timeoutMs = 8_000) {
                chromeValue("String(!!document.querySelector('$PROMPT_PRIMARY'))") == "true"
            }
            if (!up) error("the Clear history prompt never came up under a finger")
            awaitSheetSettled(PROMPT_PRIMARY, 6_000)
            val probe = sheetProbe(PROMPT_PRIMARY)
            val r = ring()
            finding(
                "  the prompt: focus on ${focusedElement()} (the container: role '${probe.optString("role")}', tabindex '${probe.optString("tabindex")}'); " +
                    "its outline ${probe.optString("containerOutlineWidth")} ${probe.optString("containerOutline")}; ring ${ringText(r)}; ${sheetText(probe)}"
            )
            expect("the prompt opens with the focus on its container, not on Cancel (§9.22, focus=\"dialog\")", probe.optBoolean("focusOnContainer"), "prompt-focus-dialog")
            expect("the container with tabindex=-1 draws no focus ring (§9.22)", probe.optString("containerOutline") == "none" && !r.optBoolean("rings"), "prompt-no-ring")
            val handle = awaitFresh(8_000, "the prompt's handle") { it == "Resize prompt" }
            expect("the handle is named for a prompt ('Resize prompt')", handle != null, "prompt-handle")
            val want = 16 + probe.optInt("insetBottom")
            expect("the footer's buttons stand 16 + inset over the edge (§9.25: $want, measured ${probe.optDouble("gapFooter")})", Math.abs(probe.optDouble("gapFooter", -100.0) - want) <= 1, "prompt-footer-gap")
            treeFocusFinding("")
            still("clear-history-prompt")
            back()
            finding("  back sends the prompt away: ${verdict(awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 6_000))}")
            SystemClock.sleep(800)
            if (chromeSurfaceUp()) back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
        }
    }

    // --- 3. a value sheet: Settings › Look and Feel › Colour scheme ----------------------------------------

    private fun valueSheet() {
        step("3. A value sheet (Settings › Look and Feel › Colour scheme): opens on the checked option; its last option 16 + inset over the edge") {
            if (!openMenuItem("Settings")) error("the app menu has no 'Settings'")
            if (!awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 10_000)) error("the Settings tab did not open from the menu")
            SystemClock.sleep(1_000)
            val touched = touchControl("Look and Feel", LOOK_AND_FEEL_JS, prefix = true)
            val section = touched && awaitChrome("!!$COLOR_SCHEME_ROW_JS", 8_000)
            if (!section) error("Look and Feel did not open under a finger")
            SystemClock.sleep(1_200)
            val rowTouched = touchControl(COLOR_SCHEME_ROW, COLOR_SCHEME_ROW_JS, prefix = true)
            val pickerUp = rowTouched && awaitChrome("!!document.querySelector('$PICKER_OPTION')", 8_000)
            if (!pickerUp) {
                if (rowTouched) touchFault("a finger on the Colour scheme row did not open its picker")
                error("the Colour scheme picker did not open under a finger")
            }
            awaitSheetSettled(PICKER_OPTION, 6_000)
            val probe = sheetProbe(PICKER_OPTION)
            val focus = focusedElement()
            val checked = chromeValue("window.__zenDescribe(document.querySelector('$PICKER_OPTION[aria-checked=\"true\"]'))")
            finding("  the picker opens with the focus on $focus (the checked option: $checked); ${probe.optInt("rows")} options; ${sheetText(probe)}")
            expect("the value sheet opens on its checked option (§9.22)", focus == checked && checked != "body" && focus.isNotEmpty(), "value-focus-checked")
            expect("the picker is a list sheet (data-body=\"list\")", probe.optString("body") == "list", "value-body")
            val want = 16 + probe.optInt("insetBottom")
            expect("the last option stands 16 + inset over the edge (§9.25: $want, measured ${probe.optDouble("gapLastRow")})", Math.abs(probe.optDouble("gapLastRow", -100.0) - want) <= 1, "value-footer-gap")
            treeFocusFinding(chromeValue("(function(){var e=document.querySelector('$PICKER_OPTION[aria-checked=\"true\"]');return e?e.textContent.trim():''})()"))
            still("colour-scheme-picker")
            back()
            finding("  back sends the picker away: ${verdict(awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 6_000))}")
            SystemClock.sleep(800)
            closeSettingsTab()
            awaitActiveUrl(NOTES_URL, 8_000)
        }
    }

    // --- 4. a hardware keyboard's Tab off the page ----------------------------------------------------------

    private fun keyboardTraversal() {
        step("4. A hardware keyboard's Tab runs off the page into the chrome's first control and back (A11Y-09's remainder)") {
            val close = closeUrlField()
            if (!close.ok) finding("  (${close.describe()})")
            awaitActiveUrl(NOTES_URL, 8_000)
            SystemClock.sleep(600)
            pageJs("window.__zenFocusLog=[]")
            // A finger on the page's last control: the page holds the keyboard, the control the focus.
            val point = pagePoint("last")
            if (point != null) {
                Finger().tap(point.x, point.y)
                SystemClock.sleep(900)
            }
            var active = pageActive()
            if (active.optString("id") != "last" || !active.optBoolean("hasFocus")) {
                finding("  (${if (point == null) "no point in the touchable window for #last" else "the finger at ${point.x.toInt()},${point.y.toInt()} left the page's focus on '${active.optString("id")}' (document focused ${active.optBoolean("hasFocus")})"}; the page focuses it by script)")
                pageJs("document.getElementById('last').focus()")
                SystemClock.sleep(400)
                active = pageActive()
            }
            finding("  the page's focus: $active; Android's focus on ${androidFocus()}; the chrome's data-input '${dataInput()}'")
            if (active.optString("id") != "last") error("the page never held the focus on its last control")
            chromeJs("window.__zenFocusPath=[]")

            // Tab past the page's last tabbable: the chrome's first control, as a keyboard focus.
            pressKey(KeyEvent.KEYCODE_TAB)
            val landed = awaitChrome("window.__zenAtEdge('first')", 5_000)
            SystemClock.sleep(500)
            val landing = focusedElement()
            val landingRing = landingRing()
            val pageAfter = pageActive()
            finding(
                "  Tab: the chrome's focus path ${chromeValue("window.__zenFocusPath.join(' > ')")} -> $landing; the chrome's first tabbable ${chromeValue("window.__zenDescribe(window.__zenTabbables()[0])")}; " +
                    "Android's focus on ${androidFocus()}; data-input '${dataInput()}'; the page's focus $pageAfter; ring ${ringText(landingRing)}"
            )
            expect("Tab past the page's last tabbable lands on the chrome's first control", landed, "kbd-page-to-chrome-first")
            expect("the landing is in the bar (nav.zen-phone-bar)", chromeValue("String(!!(document.activeElement&&document.activeElement.closest('nav.zen-phone-bar')))") == "true", "kbd-landing-in-bar")
            expect("the page's document has let its focus go", pageAfter.optString("id") == "", "kbd-page-cleared")
            expect("the chrome counts the keyboard as the last input (data-input keyboard)", dataInput() == "keyboard", "kbd-data-input")
            expect("the landed control matches :focus-visible and draws the keyboard's ring", landingRing.optBoolean("focusVisible") && landingRing.optBoolean("rings"), "kbd-chrome-ring")
            still("tab-into-chrome-first")

            // Shift+Tab past the chrome's first control: the page's last tabbable, as a keyboard focus.
            pressKey(KeyEvent.KEYCODE_TAB, shift = true)
            val backOnLast = awaitPage("document.activeElement&&document.activeElement.id==='last'", 5_000)
            SystemClock.sleep(500)
            val pageLast = pageActive()
            finding("  Shift+Tab: the page's focus $pageLast; its focus log ${pageValue("JSON.stringify(window.__zenFocusLog)")}; Android's focus on ${androidFocus()}; the chrome's focus on ${focusedElement()}")
            expect("Shift+Tab past the chrome's first control lands on the page's last tabbable", backOnLast, "kbd-chrome-to-page-last")
            expect("the page's landing matches :focus-visible (the keyboard's ring, a page's own)", pageLast.optBoolean("focusVisible"), "kbd-page-last-ring")
            still("shift-tab-into-page-last")

            // Tab forward: the chrome's first again, then on through the chrome into the page's first tabbable.
            pressKey(KeyEvent.KEYCODE_TAB)
            expect("Tab lands on the chrome's first control again", awaitChrome("window.__zenAtEdge('first')", 5_000), "kbd-again-first")
            val path = ArrayList<String>()
            var presses = 0
            var reachedFirst = false
            while (presses < 20 && !reachedFirst) {
                val before = focusedElement()
                pressKey(KeyEvent.KEYCODE_TAB)
                presses++
                awaitMove(before, 3_000)
                path += focusedElement()
                reachedFirst = pageValue("document.activeElement.id") == "first"
            }
            val pageFirst = pageActive()
            finding("  Tab x$presses through the chrome: ${path.joinToString(" > ")}; the page's focus $pageFirst; Android's focus on ${androidFocus()}")
            expect("Tab past the chrome's last control lands on the page's first tabbable", reachedFirst, "kbd-chrome-to-page-first")
            expect("the page's first tabbable matches :focus-visible", pageFirst.optBoolean("focusVisible"), "kbd-page-first-ring")
            still("tab-into-page-first")

            // Shift+Tab past the page's first tabbable: the chrome's last control.
            chromeJs("window.__zenFocusPath=[]")
            pressKey(KeyEvent.KEYCODE_TAB, shift = true)
            val onLast = awaitChrome("window.__zenAtEdge('last')", 5_000)
            SystemClock.sleep(500)
            val lastRing = landingRing()
            finding(
                "  Shift+Tab: the chrome's focus path ${chromeValue("window.__zenFocusPath.join(' > ')")} -> ${focusedElement()} (the chrome's last tabbable " +
                    "${chromeValue("window.__zenDescribe(window.__zenTabbables().slice(-1)[0])")}); ring ${ringText(lastRing)}; the page's focus ${pageActive()}"
            )
            expect("Shift+Tab past the page's first tabbable lands on the chrome's last control", onLast, "kbd-page-to-chrome-last")
            expect("the chrome's last control draws the keyboard's ring", lastRing.optBoolean("focusVisible") && lastRing.optBoolean("rings"), "kbd-chrome-last-ring")
            still("shift-tab-into-chrome-last")
        }
    }

    /** Poll until the chrome's focus has moved off `before` or the page's focus has landed; false when neither in time. */
    private fun awaitMove(before: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (focusedElement() != before || pageValue("document.activeElement.id") == "first") return true
            SystemClock.sleep(120)
        }
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

    /** Which view holds Android's focus in the browser's window: the chrome, a page, something else, nothing. */
    private fun androidFocus(): String {
        var what = "nothing"
        instrumentation.runOnMainSync {
            val focus = activity.window.decorView.findFocus()
            val host = (activity as MainActivity).host
            what = when {
                focus == null -> "nothing"
                focus === host.chrome -> "the chrome"
                focus is TabWebView -> "the page ${focus.tabId}"
                else -> focus.javaClass.simpleName
            }
        }
        return what
    }

    /** The active element's ring – the pill's as a whole when the focus is inside the pill (`.zen-phone-pill button:focus-visible` rings nothing of its own). */
    private fun landingRing(): JSONObject {
        val raw = chromeValue(
            "JSON.stringify(window.__zenRing?(function(){var a=document.activeElement;if(!a)return {desc:'none',rings:false};" +
                "var r=window.__zenRing(a.closest('.zen-phone-pill')||a);r.focusVisible=a.matches(':focus-visible');return r})():{})"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
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

    // --- 5. the custom tab menu's hairline --------------------------------------------------------------------

    private fun customTabHairline() {
        step("5. The custom tab's menu sheet: the native chassis's one-dp hairline along the top and the sides, none along the bottom") {
            val intent = CustomTabsIntent.Builder().build().intent.apply {
                data = Uri.parse(CUSTOM_URL)
                // Clients aim the intent at the provider they bound (CustomTabsClient.getPackageName).
                setPackage(app.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            app.startActivity(intent)
            if (awaitCustomTab(15_000) == null) error("no custom tab came up for the intent")
            if (waitFor(CLOSE_LABEL, 10_000) == null) error("the custom tab's toolbar never listed '$CLOSE_LABEL'")
            SystemClock.sleep(1_500)
            // A finger on the toolbar's menu button (an accessibility click leaves touch mode, and
            // the sheet's first row would then draw its focused fill for the still).
            if (!touchTapLabel(MENU_LABEL) && !clickByLabel(MENU_LABEL)) error("the custom tab's '$MENU_LABEL' button is not in the tree")
            if (waitFor(OPEN_IN_ZENIUM_LABEL, 6_000) == null) error("the menu sheet never listed '$OPEN_IN_ZENIUM_LABEL'")
            SystemClock.sleep(1_500)
            val column = sheetColumn() ?: error("the menu sheet's column is not in the tree")
            val shot = ui.takeScreenshot() ?: error("no screenshot of the sheet")
            val bitmap = if (shot.config == Bitmap.Config.HARDWARE) shot.copy(Bitmap.Config.ARGB_8888, false).also { shot.recycle() } else shot
            try {
                val hairline = PromptSheetSpec.hairlinePx(density)
                val cx = column.centerX()
                // The recipe's navigation bar is drawn over the sheet's foot with its glyphs at the
                // centre and the quarters: the bottom rows read three eighths in, between two of them.
                val bx = column.left + column.width() * 3 / 8
                val panel = grey(bitmap, cx, column.top + hairline + dp(3))
                val dark = panel < 128
                val alpha = (if (dark) 0x1F else 0x26) / 255.0
                // The edge over a surface: the border ink at its alpha over whatever lies inside it.
                val blend = { under: Int -> under * (1 - alpha) + (if (dark) 255 else 0) * alpha }
                finding(
                    "  the column at $column (${column.width()}x${column.height()} px), the hairline $hairline px (one dp at density $density); " +
                        "the panel reads $panel (${if (dark) "dark" else "light"} scheme), the edge over it should read ${"%.1f".format(blend(panel))} (the border ink at alpha ${"%.3f".format(alpha)})"
                )
                val topRows = (0 until hairline).map { grey(bitmap, cx, column.top + it) }
                val underTop = grey(bitmap, cx, column.top + hairline)
                // The sides in the band under the corner arcs (12 dp) and above the first row (20 dp,
                // whose own fill – a focus, a press – is not the panel).
                val ySide = column.top + dp(16)
                val leftCols = (0 until hairline).map { grey(bitmap, column.left + it, ySide) }
                val insideLeft = grey(bitmap, column.left + hairline, ySide)
                val rightCols = (1..hairline).map { grey(bitmap, column.right - it, ySide) }
                val insideRight = grey(bitmap, column.right - hairline - 1, ySide)
                val navBar = windowInsets().bottom
                val bottomVisible = column.bottom <= bitmap.height - navBar
                val bottomRows = (1..hairline).map { grey(bitmap, bx, column.bottom - it) }
                val aboveBottom = grey(bitmap, bx, column.bottom - hairline - 3)
                finding(
                    "  top rows $topRows then $underTop under them; at ${dp(16)} px down the left columns $leftCols then $insideLeft inside, the right columns $rightCols then $insideRight inside; " +
                        "the bottom rows at x $bx $bottomRows with $aboveBottom above them${if (bottomVisible) "" else " (under the $navBar px navigation bar: not the sheet's own pixels)"}"
                )
                val tinted = { v: Int, under: Int -> Math.abs(v - blend(under)) <= 6 }
                val plain = { v: Int, under: Int -> Math.abs(v - under) <= 3 }
                expect("the top edge is one dp of the border ink ($hairline px) over the panel", topRows.all { tinted(it, underTop) } && plain(underTop, panel), "cct-hairline-top")
                expect("the left edge is one dp of the border ink over the surface inside it", leftCols.all { tinted(it, insideLeft) }, "cct-hairline-left")
                expect("the right edge is one dp of the border ink over the surface inside it", rightCols.all { tinted(it, insideRight) }, "cct-hairline-right")
                finding("  the surface inside the side edges is the panel: ${verdict(plain(insideLeft, panel) && plain(insideRight, panel))}")
                if (bottomVisible) {
                    expect(
                        "no run along the bottom: its last rows read as the surface above them, not as the ink over it",
                        bottomRows.all { plain(it, aboveBottom) } && !bottomRows.all { tinted(it, aboveBottom) },
                        "cct-hairline-bottom"
                    )
                } else {
                    finding("  (the sheet runs edge to edge under the navigation bar: the bottom edge is not on screen to read; V2TokensPinTest pins the drawable's path to top and sides)")
                }
                zoomCorner(bitmap, column)
            } finally {
                bitmap.recycle()
            }
            still("custom-tab-menu-hairline")
            back()
            SystemClock.sleep(1_000)
            if (!clickByLabel(CLOSE_LABEL)) finding("  (the custom tab's '$CLOSE_LABEL' was not in the tree to close it)")
            SystemClock.sleep(1_500)
            shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
            SystemClock.sleep(2_500)
            ensureForeground()
        }
    }

    /** The custom tab that is resumed, if one is (the driver shares Zenium's process). */
    private fun customTab(): CustomTabActivity? {
        var found: CustomTabActivity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<CustomTabActivity>()
                .firstOrNull()
        }
        return found
    }

    private fun awaitCustomTab(timeoutMs: Long): CustomTabActivity? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            customTab()?.let { return it }
            SystemClock.sleep(250)
        }
        return customTab()
    }

    /**
     * The menu sheet's column – the view that draws the edge – as the tree has it: the parent of
     * the "Open in Zenium" row, checked against the Material chassis's `design_bottom_sheet`
     * above it; its bounds on screen.
     */
    private fun sheetColumn(): Rect? {
        val row = findInWindows { it == OPEN_IN_ZENIUM_LABEL } ?: return null
        var node: AccessibilityNodeInfo? = row.parent
        var column: AccessibilityNodeInfo? = null
        var hops = 0
        while (node != null && hops < 6) {
            val parent = node.parent
            if (parent?.viewIdResourceName?.endsWith(":id/design_bottom_sheet") == true) {
                column = node
                break
            }
            node = parent
            hops++
        }
        val chosen = column ?: row.parent ?: return null
        val bounds = Rect().also { chosen.getBoundsInScreen(it) }
        finding("  the sheet's column in the tree: ${chosen.className} at $bounds${if (column == null) " (the row's parent; no design_bottom_sheet above it)" else ""}")
        return bounds
    }

    /** The mean of a pixel's three channels, 0–255 (the sheet's inks are greys). */
    private fun grey(bitmap: Bitmap, x: Int, y: Int): Int {
        val c = bitmap.getPixel(x.coerceIn(0, bitmap.width - 1), y.coerceIn(0, bitmap.height - 1))
        return (Color.red(c) + Color.green(c) + Color.blue(c)) / 3
    }

    /** The sheet's top-left corner at 6x, nearest-neighbour, as its own PNG next to the stills. */
    private fun zoomCorner(bitmap: Bitmap, column: Rect) {
        val size = dp(28)
        val x = column.left.coerceIn(0, bitmap.width - size)
        val y = column.top.coerceIn(0, bitmap.height - size)
        val crop = Bitmap.createBitmap(bitmap, x, y, size, size)
        val zoom = Bitmap.createScaledBitmap(crop, size * 6, size * 6, false)
        File(out, "android-primitives-4-cct-corner-x6.png").outputStream().use { zoom.compress(Bitmap.CompressFormat.PNG, 100, it) }
        crop.recycle()
        zoom.recycle()
        finding("  the top-left corner at 6x: android-primitives-4-cct-corner-x6.png ($size px square from $x,$y)")
    }

    private fun dp(value: Int): Int = Math.round(value * density)

    // --- the sheet, measured ---------------------------------------------------------------------------------

    /** The sheet around the element `inner` selects, measured by the probe's `__zenSheet`; empty when there is none. */
    private fun sheetProbe(inner: String): JSONObject {
        val raw = chromeValue("JSON.stringify(window.__zenSheet(${JSONObject.quote(inner)}))")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    private fun sheetText(p: JSONObject): String =
        "the sheet ${p.optInt("height")} tall, its bottom at ${p.optInt("bottom")} of the layer ${p.optInt("layer")} (viewport ${p.optInt("viewport")}), " +
            "insets top ${p.optInt("insetTop")} bottom ${p.optInt("insetBottom")}, padding-bottom ${p.optString("paddingBottom")}, body '${p.optString("body")}', ${p.optInt("rows")} rows"

    /** The sheet at rest: its top the same over two reads 300 ms apart; then a beat for the spring's tail. */
    private fun awaitSheetSettled(inner: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = Int.MIN_VALUE
        while (SystemClock.uptimeMillis() < deadline) {
            val top = sheetProbe(inner).optInt("top", Int.MIN_VALUE)
            if (top != Int.MIN_VALUE && top == last) {
                SystemClock.sleep(600)
                return true
            }
            last = top
            SystemClock.sleep(300)
        }
        return false
    }

    /** The tree's word on the input focus (TalkBack's reading), waited on as long as the tree takes: a finding beside the DOM's claim. */
    private fun treeFocusFinding(wanted: String) {
        val mark = SystemClock.uptimeMillis()
        var node: AccessibilityNodeInfo? = null
        val deadline = mark + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            dropTreeCache()
            node = findNodeWhere { it.isFocused }
            if (node != null && (wanted.isEmpty() || nodeName(node) == wanted)) break
            nudgeFrame()
            SystemClock.sleep(300)
        }
        val name = node?.let { nodeName(it) }
        finding(
            "  the tree's input focus: ${if (node == null) "on nothing" else "'$name' (${node.className})"} ${SystemClock.uptimeMillis() - mark} ms on" +
                "${if (wanted.isNotEmpty()) " (the DOM's: '$wanted')" else ""}; WebView events since the sheet rose: ${eventsSince(mark - 3_000)}"
        )
    }

    /** A node's name as the tree reads it: its text, else its content description. */
    private fun nodeName(node: AccessibilityNodeInfo): String = (node.text ?: node.contentDescription)?.toString().orEmpty()

    /** A line of a shared helper's (how long the tree took, which aim a finger used) is a finding here. */
    override fun noteLine(line: String) = finding(line)

    /** The bar button whose label starts with `prefix` (the Tabs button counts its tabs), as an expression. */
    private fun barButtonPrefixJs(prefix: String): String =
        "Array.prototype.find.call(document.querySelectorAll('$BAR_BUTTON'),function(b){return (b.getAttribute('aria-label')||'').indexOf(${JSONObject.quote(prefix)})===0})"

    private fun chromeInset(side: String): String = chromeValue("document.documentElement.style.getPropertyValue('--zen-inset-$side')")

    // --- the page ----------------------------------------------------------------------------------------------

    /** The links page's WebView (the seeded `tab_notes`), on screen or behind another tab. */
    private fun notesView(): TabWebView? {
        var view: TabWebView? = null
        instrumentation.runOnMainSync { view = (activity as MainActivity).host.tabs.get(NOTES_TAB) }
        return view
    }

    /** Where the page's control `id` is on the screen, for a finger; null when the page has none or it lies outside the touchable window. */
    private fun pagePoint(id: String): PointF? {
        val web = notesView() ?: return null
        val raw = pageValue("JSON.stringify(window.__zenPoint(${JSONObject.quote(id)}))")
        val point = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val origin = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(origin) }
        val p = PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
        return if (touchable.contains(p.x.toInt(), p.y.toInt())) p else null
    }

    /** The page's focus as its own script reads it: `{id, tag, focusVisible, hasFocus}`. */
    private fun pageActive(): JSONObject {
        val raw = pageValue("JSON.stringify(window.__zenActive?window.__zenActive():{})")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** Poll the page until the expression `code` is true; false when it is not in time. */
    private fun awaitPage(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pageValue("String(!!($code))") == "true") return true
            SystemClock.sleep(150)
        }
        return pageValue("String(!!($code))") == "true"
    }

    /** Evaluate in the links page; the raw JSON-encoded result ("" when it never answered). */
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

    /** The Settings tab, whichever it is, closed through the core (the page's tab stays). */
    private fun closeSettingsTab() {
        activeCoreTab()?.optString("id")?.takeIf { it != NOTES_TAB && it != APP_TAB }?.let {
            coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(it)}}")
        }
        SystemClock.sleep(1_500)
    }

    // --- stills, steps, findings ---------------------------------------------------------------------------------

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

    /** After a step threw: a custom tab closed, whatever is up sent away, the page the active tab. */
    private fun recover() {
        if (customTab() != null) {
            back()
            SystemClock.sleep(800)
            clickByLabel(CLOSE_LABEL)
            SystemClock.sleep(1_200)
            shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
            SystemClock.sleep(2_500)
        }
        ensureForeground()
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
        "/notes.html" to ("text/html; charset=utf-8" to LINKS_PAGE.toByteArray()),
        "/app/" to DemoServer.page("Sketch Studio", "<p>The second tab.</p>"),
        "/custom.html" to DemoServer.page("A story in a custom tab", "<p>Opened by another app; its menu is the sheet under test.</p>")
    )

    companion object {
        private const val PORT = 18171
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val NOTES_URL = "$ORIGIN/notes.html"
        private const val NOTES_TAB = "tab_notes"
        private const val APP_TAB = "tab_app"
        private const val CUSTOM_URL = "$ORIGIN/custom.html"
        private const val SETTINGS_SEARCH = ".zen-settings-search-field"
        private const val HISTORY_SEARCH = "Search history"
        private const val COLOR_SCHEME_ROW = "Colour scheme"
        private const val CLOSE_LABEL = "Close"
        private const val MENU_LABEL = "Menu"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        /** The bar's own buttons (`PhoneShell.tsx`'s `nav.zen-phone-bar`, `BarButton.tsx`): the row's controls beside the pill. */
        private const val BAR_BUTTON = ".zen-phone-bar-row .zen-toolbar-button"
        /** A picker's option (`blocks.tsx`): the sheet's radio rows. */
        private const val PICKER_OPTION = ".zen-sheet [role=\"radio\"]"
        /** A Recently closed row's main control (`PhoneListRow` in the sheet's list). */
        private const val CLOSED_ROW = ".zen-sheet .zen-phone-list .zen-list-main[role=\"button\"]"
        /** The Clear history prompt's primary ("Clear all") in its footer. */
        private const val PROMPT_PRIMARY = ".zen-sheet .zen-sheet-footer [data-primary]"
        private const val OVERVIEW_SCALE_JS = "(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()"
        /** The overview header's More button (`aria-label="More"`), the one on screen. */
        private const val OVERVIEW_MORE_JS =
            "Array.prototype.find.call(document.querySelectorAll('button[aria-label=\"More\"]'),function(b){return b.getBoundingClientRect().height>0})"
        /** The overview menu's Recently Closed row (`OverviewSheet`'s `.zen-sheet-item`, its count in the label). */
        private const val RECENTLY_CLOSED_ROW_JS =
            "Array.prototype.find.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(b){return b.textContent.trim().indexOf('Recently Closed (')===0})"
        /** The History panel's Clear history row (`PhoneListRow`, its title the name). */
        private const val CLEAR_ROW_JS = "document.querySelector('.zen-phone-list .zen-list-main[aria-label=\"Clear history\"]')"
        /** The Settings landing's Look and Feel row (`CategoryRow`, by the section's id). */
        private const val LOOK_AND_FEEL_JS = "document.querySelector('.zen-settings-category[data-section=\"look\"]')"
        /** The Colour scheme row in Look and Feel (`sections.tsx`, its `data-row`). */
        private const val COLOR_SCHEME_ROW_JS = "document.querySelector('[data-row=\"color-scheme\"]')"

        /** Twenty recently closed tabs, newest first as the sheet lists them. */
        private val CLOSED = listOf(
            "https://en.wikipedia.org/wiki/Bottom_sheet" to "Bottom sheet - Wikipedia",
            "https://developer.android.com/guide/topics/ui/accessibility" to "Build accessible apps",
            "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/" to "Dialog (Modal) Pattern",
            "https://m3.material.io/components/bottom-sheets/overview" to "Bottom sheets - Material Design 3",
            "https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible" to ":focus-visible - CSS",
            "https://html.spec.whatwg.org/multipage/interaction.html" to "HTML Standard: User interaction",
            "https://www.rfc-editor.org/rfc/rfc1149.html" to "RFC 1149: IP Datagrams on Avian Carriers",
            "https://info.cern.ch/hypertext/WWW/TheProject.html" to "World Wide Web",
            "https://en.wikipedia.org/wiki/Tea" to "Tea - Wikipedia",
            "https://example.com/" to "Example Domain",
            "https://developer.chrome.com/docs/android/custom-tabs" to "Android Custom Tabs",
            "https://www.w3.org/TR/WCAG22/" to "Web Content Accessibility Guidelines 2.2",
            "https://en.wikipedia.org/wiki/Damping" to "Damping - Wikipedia",
            "https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect" to "Element: getBoundingClientRect()",
            "https://source.chromium.org/chromium" to "Chromium Code Search",
            "https://en.wikipedia.org/wiki/Hairline" to "Hairline - Wikipedia",
            "https://developer.android.com/develop/ui/views/layout/insets" to "Handle window insets",
            "https://www.w3.org/TR/css-ui-4/" to "CSS Basic User Interface Module Level 4",
            "https://en.wikipedia.org/wiki/Tab_(interface)" to "Tab (interface) - Wikipedia",
            "https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/tabindex" to "tabindex - HTML"
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
         * solid outline of `floor(2 × dpr)` device pixels in the ring's ink); the document's tabbable
         * order as `@shared/focusEdge` reads it (`__zenTabbables`, the rule copied: what Tab reaches
         * less what it skips, a positive tabindex first) and whether the focus is at its edge
         * (`__zenAtEdge`); and a sheet measured (`__zenSheet`): its height against the layer, the
         * insets the host reported (the root's `--zen-inset-*`), the 80 % cap the chassis computes
         * for a list (`lib/motion/sheet.ts`), the gap from its last row or its footer's primary to
         * its bottom edge, the leading glyph's opacity, and the container's outline and focus.
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
                var near=function(a,b){return Math.abs(a-b)<0.02};
                var rings=cs.outlineStyle==='solid'&&(near(w,want)||near(w,2*dpr)||near(w,Math.round(2*dpr)))&&cs.outlineColor===token;
                return {desc:window.__zenDescribe(el),focusVisible:el.matches(':focus-visible'),
                  outlineStyle:cs.outlineStyle,outlineWidth:cs.outlineWidth,outlineOffset:cs.outlineOffset,outlineColor:cs.outlineColor,
                  dpr:dpr,widthDevicePx:w,wantDevicePx:want,ringToken:token,background:cs.backgroundColor,rings:rings}};
              window.__zenFocusPath=[];
              document.addEventListener('focusin',function(e){window.__zenFocusPath.push(window.__zenDescribe(e.target))},true);
              var SEL='a[href], area[href], button, input, select, textarea, iframe, summary, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
              var tabIndexOf=function(el){var raw=el.getAttribute('tabindex');if(raw===null)return 0;var v=parseInt(raw,10);return isNaN(v)?0:v};
              var disabled=function(el){if(el.disabled===true)return true;var fs=el.closest('fieldset[disabled]');if(!fs)return false;var lg=el.closest('legend');return !(lg&&lg.parentElement===fs)};
              var tabbable=function(el){
                if(tabIndexOf(el)<0)return false;if(disabled(el))return false;
                if(el instanceof HTMLInputElement&&el.type==='hidden')return false;
                if(el.closest('[inert], [aria-hidden="true"]'))return false;
                if(el.getClientRects().length===0)return false;
                return getComputedStyle(el).visibility!=='hidden'};
              window.__zenTabbables=function(){
                var all=Array.prototype.filter.call(document.querySelectorAll(SEL),tabbable);
                var pos=all.filter(function(e){return tabIndexOf(e)>0}).sort(function(a,b){return tabIndexOf(a)-tabIndexOf(b)});
                return pos.concat(all.filter(function(e){return tabIndexOf(e)===0}))};
              window.__zenAtEdge=function(which){var t=window.__zenTabbables();if(!t.length)return false;var a=document.activeElement;
                return !!a&&a!==document.body&&a===(which==='first'?t[0]:t[t.length-1])};
              window.__zenSheet=function(inner){
                var el=document.querySelector(inner);var sheet=el?el.closest('.zen-sheet'):null;if(!sheet)return null;
                var r=sheet.getBoundingClientRect();var layer=sheet.parentElement;
                var rs=document.documentElement.style;var ins=function(n){return parseFloat(rs.getPropertyValue('--zen-inset-'+n))||0};
                var insetTop=ins('top'),insetBottom=ins('bottom');
                var layerH=layer?layer.clientHeight:window.innerHeight;
                var room=layerH-insetTop-40;var list=sheet.getAttribute('data-body')==='list';
                var cap=Math.max(0,Math.round(list?Math.min(room,0.8*layerH):room));
                var scroll=sheet.querySelector('.zen-sheet-scroll');
                var rows=sheet.querySelectorAll('.zen-phone-row, [role="radio"]');var lastRow=rows.length?rows[rows.length-1]:null;
                var footerBtn=sheet.querySelector('.zen-sheet-footer [data-primary]')||sheet.querySelector('.zen-sheet-footer button');
                var lead=sheet.querySelector('.zen-list-lead');var cs=getComputedStyle(sheet);
                var hund=function(v){return Math.round(v*100)/100};
                return {height:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom),viewport:window.innerHeight,layer:layerH,
                  insetTop:insetTop,insetBottom:insetBottom,cap:cap,paddingBottom:cs.paddingBottom,body:sheet.getAttribute('data-body')||'',
                  scrollHeight:scroll?scroll.scrollHeight:0,clientHeight:scroll?scroll.clientHeight:0,rows:rows.length,
                  gapLastRow:lastRow?hund(r.bottom-lastRow.getBoundingClientRect().bottom):-1,
                  gapFooter:footerBtn?hund(r.bottom-footerBtn.getBoundingClientRect().bottom):-1,
                  leadOpacity:lead?getComputedStyle(lead).opacity:'',
                  containerOutline:cs.outlineStyle,containerOutlineWidth:cs.outlineWidth,
                  focusOnContainer:document.activeElement===sheet,tabindex:sheet.getAttribute('tabindex')||'',role:sheet.getAttribute('role')||''}};
              return 'probe'})()
        """.trimIndent()

        /**
         * The links page: four controls in a row – two links, two buttons – so a Tab past the last
         * (a Shift+Tab past the first) has nowhere to go but out of the document; a page's own ring
         * on `:focus-visible` and none on a focus that is not; its focus events on record, its focus
         * described (`__zenActive`) and a control's centre on the WebView in device pixels for a
         * finger (`__zenPoint`).
         */
        private val LINKS_PAGE = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>Focus order</title>
            <style>
            body{margin:0;font-family:sans-serif;background:#f4f1ea;color:#1b1b1f}
            h1{margin:0;padding:28px 20px 6px;font-size:26px;line-height:32px}
            p{margin:0;padding:0 20px 8px;font-size:17px;line-height:24px}
            .control{display:block;box-sizing:border-box;width:calc(100% - 40px);margin:14px 20px;padding:18px 20px;border-radius:14px;background:#fff;color:#1b4332;
              font:600 18px/1.3 sans-serif;text-decoration:none;text-align:left;border:1px solid rgba(0,0,0,.12)}
            .control:focus-visible{outline:3px solid #0a58ca;outline-offset:2px}
            .control:focus:not(:focus-visible){outline:none}
            </style></head>
            <body><h1>Focus order</h1><p>Four controls. Tab past the last one leaves the page for the chrome; Shift+Tab past the first does too.</p>
            <a id=first class=control href="#first">First, a link</a>
            <a id=second class=control href="#second">Second, a link</a>
            <button id=third class=control type=button>Third, a button</button>
            <button id=last class=control type=button>Last, a button</button>
            <script>
            (function(){
              window.__zenFocusLog=[];
              var name=function(t){return t&&t.id?t.id:(t&&t.tagName?t.tagName.toLowerCase():'?')};
              document.addEventListener('focusin',function(e){window.__zenFocusLog.push('in:'+name(e.target))},true);
              document.addEventListener('focusout',function(e){window.__zenFocusLog.push('out:'+name(e.target))},true);
              window.__zenActive=function(){var a=document.activeElement;var el=a&&a!==document.body?a:null;
                return {id:el?el.id:'',tag:el?el.tagName.toLowerCase():'',focusVisible:!!el&&el.matches(':focus-visible'),hasFocus:document.hasFocus()}};
              window.__zenPoint=function(id){var el=document.getElementById(id);if(!el)return null;
                var vv=window.visualViewport;var scale=(vv?vv.scale:1)*(window.devicePixelRatio||1);var r=el.getBoundingClientRect();
                return {x:(r.left+r.width/2-(vv?vv.offsetLeft:0))*scale,y:(r.top+r.height/2-(vv?vv.offsetTop:0))*scale}};
            })();
            </script></body></html>
        """.trimIndent()
    }
}
