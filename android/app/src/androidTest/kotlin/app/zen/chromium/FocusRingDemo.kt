package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Calendar

/**
 * Photographs the shared focus ring on a device (design language v2 §1, §4; the #247 chassis
 * note, the #251 verdict's section 4, the primitives pass 3 in #272), each control reached the
 * way a keyboard user reaches it – the Tab key injected as a hardware keyboard's – and each ring
 * read off the chrome's computed style beside the still, in the light scheme and then the dark
 * (the scheme flipped through the core while the control keeps the focus):
 *
 *  1. the install sheet's primary ("Add", `zen-v2-button[data-primary]`, the accent fill): the
 *     ring at 2 outside, so it stands off the fill by the surface between them (§4);
 *  2. a Settings row (the Look and Feel section's rows, `.zen-settings-row`): the ring 2 inside,
 *     the row running edge to edge in a clipping body (#272's (1b));
 *  3. the Close-all prompt's "Don't ask again" checkbox (`input.zen-v2-checkbox`, #207): the ring
 *     at 2 outside on the unticked box, then Space ticks it and the ring stands off the accent
 *     fill the same way;
 *  4. the History list's multi-select checkbox on the span form (§9.34, #239): a real long press
 *     on a row enters selection, a real touch on a second row ticks its `[role=checkbox]`, read
 *     as `aria-checked` in the DOM and as checked in the accessibility tree; the local
 *     `.zen-list-checkbox` is gone.
 *
 * Each ring is checked for what §1 says: `outline: 2px solid --v2-ring` on the element that has
 * the focus (`:focus-visible`), at the control's offset. The width is read in device pixels:
 * Blink paints an outline a whole number of device pixels thick, the largest that fits the
 * declared width (CSS Backgrounds 3 §4.3 allows the snap; `border-width: 1.5px` is Chrome's
 * well-known `1px`), and reports that in CSS pixels – on a 1.75-density device the 2 px ring is
 * 3 device pixels and the computed style reads `1.71429px` – so the claim is `floor(2 × dpr)`
 * device pixels (at least 1), not the string `2px`. A claim that does not hold is a finding
 * and a failure of the run; the recording goes on to the end. Profile `pwa-demo-state.json`
 * (two tabs, the app page with a manifest made the active one), the pages from a loopback
 * server inside the process ([DemoServer]), yesterday's history seeded by this driver.
 */
@RunWith(AndroidJUnit4::class)
class FocusRingDemo : DemoHarness("pwa-demo-state.json", "android-focus-ring", "focus-ring-demo") {
    override val tag = "FocusRingDemo"
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

    /** The seeded tabs point at this driver's loopback server, and the app page (manifest) is the active tab. */
    override fun patchState(json: String): String =
        json.replace("127.0.0.1:18131", "127.0.0.1:$PORT")
            .replace("\"activeTabId\": \"tab_notes\"", "\"activeTabId\": \"tab_app\"")
            .replace("\"space_main\": \"tab_notes\"", "\"space_main\": \"tab_app\"")

    /** Yesterday's visits, in the history contract's shape, so the History list has rows to pick. */
    override fun seedMore(zen: File) {
        val entries = JSONArray()
        val visits = JSONArray()
        HISTORY.forEachIndexed { i, (url, title) ->
            val time = yesterdayAt(9 + i * 2)
            entries.put(
                JSONObject().put("url", url).put("title", title).put("visitCount", 1).put("lastVisit", time)
                    .put("firstVisit", time).put("typedCount", 0)
            )
            visits.put(
                JSONObject().put("id", "seed_$i").put("url", url).put("title", title).put("visitTime", time)
                    .put("transition", "link")
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
        findings = File(out, "android-focus-ring-findings.txt")
        findings.writeText(
            "Zenium Android focus ring check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n" +
                "v2 §1 offsets by control, §4 the accent fill's ring; the primitives pass 3 (#272)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitActiveUrl(APP_URL)
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
        finding("warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; scheme ${colorScheme()}; theme attribute '${themeAttribute()}'")
        chromeJs(PROBE_JS)
    }

    override fun demo() {
        installPrimary()
        settingsRow()
        closeAllCheckbox()
        historySelection()
        finding("\nend: ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    // --- 1. the install sheet's primary (the accent fill, §4) ---------------------------------------

    private fun installPrimary() {
        step("1. The install sheet's primary under the Tab key (§4: the accent fill rings 2 outside)") {
            if (!openMenuItem(ADD_ITEM)) error("the app menu has no '$ADD_ITEM'")
            val up = awaitChrome("!!document.querySelector('$INSTALL_SHEET')", 8_000) && awaitSheetAtRest(6_000)
            finding("  the install sheet is up and at rest: ${verdict(up)}")
            if (!up) error("the install sheet never came up")
            chromeJs("window.__zenFocusPath=[]")
            finding("  focus on open: ${focusedElement()}")
            val reached = tabTo("$INSTALL_SHEET .zen-v2-button[data-primary]", 8)
            expect("the Tab key reaches the primary ('Add')", reached, "install-primary")
            ringStills("install-primary", "outside", accentFill = true)
            back()
            expect("back closes the sheet", awaitChrome("!document.querySelector('$INSTALL_SHEET')", 8_000), "install-closed")
            SystemClock.sleep(1_000)
        }
    }

    // --- 2. a Settings row (the inset ring, #272 (1b)) ---------------------------------------------

    private fun settingsRow() {
        step("2. A Settings row under the Tab key (§1 on an edge-to-edge row: the ring 2 inside)") {
            if (!openMenuItem("Settings")) error("the app menu has no 'Settings'")
            val landing = awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 10_000)
            finding("  the Settings landing painted: ${verdict(landing)}")
            if (!landing) error("the Settings tab did not open from the menu")
            SystemClock.sleep(1_000)
            val touched = touchTapLabel("Look and Feel", prefix = true)
            val section = touched && awaitChrome("!!document.querySelector('$DRILL_IN $SETTINGS_ROW')", 8_000)
            finding("  Look and Feel touched ${touched}; its section over the landing: ${verdict(section)}")
            if (!section) error("Look and Feel did not open under a finger")
            SystemClock.sleep(1_200)
            chromeJs("window.__zenFocusPath=[]")
            finding("  focus after the touch: ${focusedElement()}")
            var reached = tabTo("$DRILL_IN $SETTINGS_ROW", 6)
            if (!reached) {
                // The Tab key from wherever the touch left the focus did not land on a row within
                // six presses (the path is on record above): the section's back button is given the
                // focus by script and ONE Tab moves it to the first row – the move that draws the
                // ring is still the keyboard's.
                finding("  (six Tabs did not reach a row; anchoring on the section's back button and pressing Tab once)")
                chromeJs("(document.querySelector('$DRILL_IN .zen-settings-back')||{focus:function(){}}).focus()")
                SystemClock.sleep(300)
                reached = tabTo("$DRILL_IN $SETTINGS_ROW", 2)
            }
            expect("the Tab key reaches a Settings row", reached, "settings-row")
            ringStills("settings-row", "inside", accentFill = false)
            // Leave the Settings tab through the core so the tab count for the prompt is known.
            val settingsTab = activeCoreTab()?.optString("id").orEmpty()
            if (settingsTab.isNotEmpty()) coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(settingsTab)}}")
            SystemClock.sleep(1_500)
        }
    }

    // --- 3. the Close-all prompt's checkbox (an input; unticked, then ticked by Space) --------------

    private fun closeAllCheckbox() {
        step("3. The Close-all prompt's checkbox under the Tab key, then ticked by Space (§4: the accent fill)") {
            openOverview()
            val menu = touchTapLabelExpecting("More", "the overview's menu rows are up", timeoutMs = 6_000) {
                chromeValue("String(!!document.querySelector('.zen-sheet-item'))") == "true"
            }
            if (!menu) error("the overview's More menu never opened")
            SystemClock.sleep(1_200)
            val prompt = touchTapLabelExpecting("Close All Tabs", "the Close-all prompt is up", prefix = true, timeoutMs = 8_000) {
                chromeValue("String(!!document.querySelector('$PROMPT_CHECKBOX'))") == "true"
            }
            if (!prompt) error("the Close-all prompt never came up")
            val rested = awaitSheetAtRest(6_000)
            finding("  the prompt at rest: ${verdict(rested)}; it asks '${chromeValue("(document.querySelector('.zen-frame-dialogs .zen-sheet-title-block h2')||{}).textContent||''")}'")
            chromeJs("window.__zenFocusPath=[]")
            finding("  focus on open: ${focusedElement()}")
            val reached = tabTo(PROMPT_CHECKBOX, 8)
            expect("the Tab key reaches the 'Don't ask again' checkbox", reached, "checkbox")
            expect("the checkbox is unticked before the key", chromeValue("String(document.querySelector('$PROMPT_CHECKBOX').checked)") == "false", "checkbox-unticked")
            ringStills("checkbox", "outside", accentFill = false)
            pressKey(KeyEvent.KEYCODE_SPACE)
            SystemClock.sleep(500)
            expect("Space ticks the checkbox", chromeValue("String(document.querySelector('$PROMPT_CHECKBOX').checked)") == "true", "checkbox-ticked")
            expect("the tree reads the checkbox checked", awaitTree(4_000) { it.isCheckable && it.isChecked }, "checkbox-tree")
            ringStills("checkbox-checked", "outside", accentFill = true)
            // Back keeps the tabs (the prompt's Escape route), then back leaves the overview.
            back()
            expect("back keeps the tabs and closes the prompt", awaitChrome("!document.querySelector('$PROMPT_CHECKBOX')", 8_000), "prompt-closed")
            SystemClock.sleep(800)
            back()
            SystemClock.sleep(1_500)
            expect("the tabs are still open", coreState().getJSONObject("tabs").length() >= 2, "tabs-kept")
        }
    }

    /** Open the overview with a touch on the bar's Tabs button (the count trails its label). */
    private fun openOverview() {
        val close = closeUrlField()
        if (!close.ok) finding("  (${close.describe()})")
        val opened = touchTapLabelExpecting("Tabs (", "the overview is up", prefix = true, timeoutMs = 8_000) {
            chromeValue("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"
        }
        if (!opened) error("the overview never opened")
        SystemClock.sleep(2_000)
    }

    // --- 4. History selection: the span-form checkbox under a real touch (§9.34) -------------------

    private fun historySelection() {
        step("4. History multi-select: the span-form checkbox under a long press and a real touch (§9.34)") {
            if (!openMenuItem("History")) error("the app menu has no 'History'")
            val panel = awaitChrome("!!document.querySelector('input[placeholder=\"$HISTORY_SEARCH\"]')", 10_000)
            finding("  the History panel is up: ${verdict(panel)}")
            if (!panel) error("the History panel never came up")
            SystemClock.sleep(1_500)
            // A history row is labelled "<title>, <host>, <time>" (PhoneHistoryPanel.tsx): by prefix.
            val first = HISTORY[0].second
            val second = HISTORY[1].second
            val firstRow = awaitNode(8_000) { it.startsWith("$first,") } ?: error("no row reads '$first, …'")
            val bounds = steadyBounds(firstRow) ?: error("the row '$first' went away")
            val point = touchPoint(bounds) ?: error("no part of the row '$first' is inside the touchable window")
            Finger().apply {
                press(point.x, point.y)
                up()
            }
            val selecting = awaitChrome("document.querySelectorAll('$LIST_CHECKBOX_ROW').length>0", 6_000)
            finding("  long press (a real touch at ${point.x.toInt()},${point.y.toInt()}) enters selection: ${verdict(selecting)}; header '${headerText()}'")
            if (!selecting) touchFault("the long press on '$first' did not enter selection")
            expect("the held row reads checked in the DOM", rowChecked(first) == "true", "history-first-checked")
            SystemClock.sleep(1_000)
            still("history-selection-light")
            val ticked = touchTapLabelExpecting("$second,", "the row '$second' reads checked", prefix = true) { rowChecked(second) == "true" }
            expect("a real touch on a second row ticks its checkbox", ticked, "history-second-checked")
            expect("the tree reads two checked checkboxes", awaitTreeCount(4_000, 2) { it.isCheckable && it.isChecked }, "history-tree")
            val form = chromeValue(
                "(function(){var r=document.querySelector('$LIST_CHECKBOX_ROW[aria-checked=\"true\"]');if(!r)return 'no row';" +
                    "var b=r.firstElementChild;return (b&&b.classList.contains('zen-v2-checkbox')&&b.tagName==='SPAN'&&b.getAttribute('aria-hidden')==='true'?'span form':'other form: '+(b?b.outerHTML.slice(0,80):'none'))" +
                    "+'; .zen-list-checkbox in DOM: '+!!document.querySelector('.zen-list-checkbox')" +
                    "+'; row fill: '+getComputedStyle(r.parentElement).backgroundColor+' (--v2-selected '+swatch(getComputedStyle(r).getPropertyValue('--v2-selected'))+')'})()"
            )
            finding("  the checked row's box: $form")
            expect("the box is the shared .zen-v2-checkbox span, no .zen-list-checkbox", form.startsWith("span form") && form.contains(".zen-list-checkbox in DOM: false"), "history-span-form")
            finding("  header '${headerText()}'")
            SystemClock.sleep(600)
            still("history-two-checked-light")
            theme("dark")
            still("history-two-checked-dark")
            theme("light")
            val unticked = touchTapLabelExpecting("$second,", "the row '$second' reads unchecked again", prefix = true) { rowChecked(second) == "false" }
            expect("a second touch unticks it", unticked, "history-second-unticked")
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

    /** The `aria-checked` of the history row titled `title` (its label starts with the title and a comma); "" when no such checkbox row. */
    private fun rowChecked(title: String): String =
        chromeValue(
            "(function(){var r=document.querySelector('$LIST_CHECKBOX_ROW[aria-label^=\"' + ${JSONObject.quote("$title,")} + '\"]');" +
                "return r?String(r.getAttribute('aria-checked')):''})()"
        )

    // --- the Tab key and the ring ------------------------------------------------------------------

    /**
     * Press Tab until the chrome's active element matches `selector`, at most `max` times; the
     * path the focus took is a finding. True when it got there.
     */
    private fun tabTo(selector: String, max: Int): Boolean {
        val quoted = JSONObject.quote(selector)
        for (press in 1..max) {
            if (chromeValue("String(!!document.activeElement&&document.activeElement.matches($quoted))") == "true" && press > 1) {
                finding("  Tab x${press - 1}: ${chromeValue("window.__zenFocusPath.join(' > ')")} -> ${focusedElement()}")
                return true
            }
            pressKey(KeyEvent.KEYCODE_TAB)
            SystemClock.sleep(450)
        }
        val there = chromeValue("String(!!document.activeElement&&document.activeElement.matches($quoted))") == "true"
        finding("  Tab x$max: ${chromeValue("window.__zenFocusPath.join(' > ')")} -> ${focusedElement()}")
        return there
    }

    /**
     * The focused control's ring in the light scheme and then the dark, each as a still and a
     * read of the computed style: `outline: 2px solid --v2-ring` on `:focus-visible`, at the
     * control's offset (`outside` 2, `inside` −2), and – for an accent fill – the fill's colour
     * beside the ring's, the two never touching (the surface between them is the offset). The
     * width is judged in device pixels, `floor(2 × dpr)` of them (see the class note): 3 on this
     * recipe's 1.75-density emulator, where the computed style reads `1.71429px`.
     */
    private fun ringStills(name: String, side: String, accentFill: Boolean) {
        for (scheme in listOf("light", "dark")) {
            if (scheme == "dark") theme("dark")
            SystemClock.sleep(if (scheme == "dark") 400 else 700)
            val ring = ring()
            val focused = treeFocused()
            still("$name-$scheme")
            val offset = ring.optString("outlineOffset")
            val wantOffset = if (side == "inside") "-2px" else "2px"
            val dpr = ring.optDouble("dpr", Double.NaN)
            val widthDevicePx = ring.optDouble("widthDevicePx", Double.NaN)
            val wantWidthDevicePx = if (dpr.isNaN()) Double.NaN else Math.max(1.0, Math.floor(2 * dpr))
            val widthOk = !widthDevicePx.isNaN() && Math.abs(widthDevicePx - wantWidthDevicePx) < 0.02
            val width = "${ring.optString("outlineWidth")} = ${"%.2f".format(widthDevicePx)} device px " +
                "(2 px snapped to whole pixels at density $dpr: ${"%.0f".format(wantWidthDevicePx)})"
            val ok = ring.optBoolean("focusVisible") && ring.optString("outlineStyle") == "solid" &&
                widthOk && offset == wantOffset &&
                ring.optString("outlineColor") == ring.optString("ringToken")
            finding(
                "  $scheme (theme '${themeAttribute()}'): ${ring.optString("desc")} :focus-visible ${ring.optBoolean("focusVisible")}; " +
                    "outline $width ${ring.optString("outlineStyle")} ${ring.optString("outlineColor")} " +
                    "(--v2-ring ${ring.optString("ringToken")}) at offset $offset (wanted $wantOffset, ${side}); " +
                    "fill ${ring.optString("background")}${if (accentFill) " (accent fill; the ring never touches it: the ${wantOffset} of surface between)" else ""}; " +
                    "tree focus on '${focused}' ${verdict(ok)}"
            )
            if (!ok) failures += "$name $scheme: ring $width ${ring.optString("outlineStyle")} ${ring.optString("outlineColor")} at $offset (wanted 2px solid ${ring.optString("ringToken")} at $wantOffset), :focus-visible ${ring.optBoolean("focusVisible")}"
            if (accentFill && ring.optString("background") == ring.optString("outlineColor")) {
                // Same ink: only the offset keeps them apart – said, not failed (§4's ruling is the offset).
                finding("    (the ring and the fill are the one accent: the 2 px of surface at the offset is what tells them apart, §4)")
            }
        }
        theme("light")
    }

    /** The active element's ring, read off the chrome's computed style (the probe's `__zenRing`). */
    private fun ring(): JSONObject {
        val raw = chromeValue("JSON.stringify(window.__zenRing?window.__zenRing(document.activeElement):{})")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** The label of the node the accessibility tree reports as having the input focus; "" when none. */
    private fun treeFocused(): String =
        findNodeWhere { it.isFocused }?.let { (it.contentDescription ?: it.text)?.toString() }.orEmpty()

    private fun awaitTree(timeoutMs: Long, accept: (android.view.accessibility.AccessibilityNodeInfo) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findNodeWhere(accept) != null) return true
            SystemClock.sleep(250)
        }
        return findNodeWhere(accept) != null
    }

    private fun awaitTreeCount(timeoutMs: Long, count: Int, accept: (android.view.accessibility.AccessibilityNodeInfo) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findNodesWhereAll(accept) >= count) return true
            SystemClock.sleep(250)
        }
        return findNodesWhereAll(accept) >= count
    }

    private fun findNodesWhereAll(accept: (android.view.accessibility.AccessibilityNodeInfo) -> Boolean): Int {
        var n = 0
        val root = ui.rootInActiveWindow ?: return 0
        val queue = ArrayDeque<android.view.accessibility.AccessibilityNodeInfo>()
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

    /** A key as a hardware keyboard's (the route `adb shell input keyevent` takes), down and up. */
    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                now, SystemClock.uptimeMillis(), action, keyCode, 0, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD
            )
            if (!ui.injectInputEvent(event, true)) finding("  (the ${KeyEvent.keyCodeToString(keyCode)} ${if (action == KeyEvent.ACTION_DOWN) "down" else "up"} was not injected)")
            SystemClock.sleep(30)
        }
    }

    // --- the colour scheme -------------------------------------------------------------------------

    /** Switch the chrome's colour scheme through the core and wait for the root to carry it. */
    private fun theme(scheme: String): Boolean {
        if (themeAttribute() == scheme) return true
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val took = awaitChrome("document.documentElement.getAttribute('data-theme')===${JSONObject.quote(scheme)}", 6_000)
        // The 240 ms theme blend (§11), then a frame.
        SystemClock.sleep(700)
        if (!took) finding("  (the scheme did not flip to $scheme: theme attribute '${themeAttribute()}')")
        return took
    }

    private fun themeAttribute(): String = chromeValue("document.documentElement.getAttribute('data-theme')||''")

    private fun colorScheme(): String = coreState().getJSONObject("settings").optString("colorScheme")

    // --- stills, steps, findings -------------------------------------------------------------------

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

    /** After a step threw: send whatever is up away so the next step starts from the page. */
    private fun recover() {
        theme("light")
        repeat(3) {
            if (!chromeSurfaceUp()) return
            back()
            SystemClock.sleep(1_000)
        }
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a still of a moving sheet blurs its ring.
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

    private fun asset(name: String): ByteArray = instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/notes.html" to DemoServer.page("Notes on damping", "<p>A page with no web app manifest.</p>"),
        "/app/" to ("text/html; charset=utf-8" to APP_PAGE.toByteArray()),
        "/app/manifest.webmanifest" to ("application/manifest+json" to MANIFEST.toByteArray()),
        "/webapp/icon.svg" to ("image/svg+xml" to asset("webapp/icon.svg")),
        "/webapp/icon-192.png" to ("image/png" to asset("webapp/icon-192.png")),
        "/webapp/shot-canvas.svg" to ("image/svg+xml" to asset("webapp/shot-canvas.svg")),
        "/webapp/shot-colours.svg" to ("image/svg+xml" to asset("webapp/shot-colours.svg")),
        "/webapp/shot-gallery.svg" to ("image/svg+xml" to asset("webapp/shot-gallery.svg"))
    )

    companion object {
        private const val PORT = 18137
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val APP_URL = "$ORIGIN/app/"
        private const val ADD_ITEM = "Add to Home Screen"
        private const val INSTALL_SHEET = ".zen-sheet.zen-install-sheet"
        private const val SETTINGS_SEARCH = ".zen-settings-search-field"
        private const val DRILL_IN = ".zen-settings-drill-in"
        private const val SETTINGS_ROW = ".zen-settings-row"
        private const val PROMPT_CHECKBOX = ".zen-frame-dialogs input.zen-v2-checkbox"
        private const val LIST_CHECKBOX_ROW = ".zen-phone-row > .zen-list-main[role=\"checkbox\"]"
        private const val HISTORY_SEARCH = "Search history"

        /** Yesterday's rows for the History list, by url and title. */
        private val HISTORY = listOf(
            "https://example.com/" to "Example Domain",
            "https://en.wikipedia.org/wiki/Tea" to "Tea - Wikipedia",
            "https://www.rfc-editor.org/rfc/rfc1149.html" to "RFC 1149: IP Datagrams on Avian Carriers",
            "https://info.cern.ch/hypertext/WWW/TheProject.html" to "World Wide Web"
        )

        /**
         * The chrome's own account for the findings: the focused element described, the focus
         * path since the last reset (`focusin`), and the ring of an element as its computed
         * style – the outline's four parts, the width again in device pixels beside the
         * `devicePixelRatio` it was multiplied by, `--v2-ring` as the same `rgb()` text (painted
         * onto a swatch so the two compare), the background, and whether `:focus-visible` holds.
         */
        private val PROBE_JS = """
            (function(){
              window.__zenDescribe=function(el){
                if(!el||el===document.body||el===document.documentElement)return 'body';
                var d=(el.tagName||'').toLowerCase();
                var a=el.getAttribute?el.getAttribute('data-row'):null;if(a)d+='[data-row='+a+']';
                if(el.hasAttribute&&el.hasAttribute('data-primary'))d+='[data-primary]';
                var c=(el.className&&typeof el.className==='string')?el.className.split(/\s+/).filter(function(k){return /^zen-/.test(k)}).slice(0,3).join('.'):'';if(c)d+='.'+c;
                var l=el.getAttribute?el.getAttribute('aria-label'):null;if(l)d+='[aria-label='+l+']';
                if(el.id)d+='#'+el.id;
                var t=(el.textContent||'').trim().replace(/\s+/g,' ');if(!l&&!el.id&&t)d+=' "'+t.slice(0,40)+'"';
                return d};
              window.swatch=function(v){var s=document.createElement('span');s.style.color=v;document.body.appendChild(s);var c=getComputedStyle(s).color;s.remove();return c};
              window.__zenRing=function(el){
                if(!el)return {desc:'none'};
                var cs=getComputedStyle(el);
                return {desc:window.__zenDescribe(el),focusVisible:el.matches(':focus-visible'),
                  outlineStyle:cs.outlineStyle,outlineWidth:cs.outlineWidth,outlineOffset:cs.outlineOffset,outlineColor:cs.outlineColor,
                  dpr:window.devicePixelRatio,widthDevicePx:parseFloat(cs.outlineWidth)*window.devicePixelRatio,
                  ringToken:window.swatch(cs.getPropertyValue('--v2-ring')),background:cs.backgroundColor}};
              window.__zenFocusPath=[];
              document.addEventListener('focusin',function(e){window.__zenFocusPath.push(window.__zenDescribe(e.target))},true);
              return 'probe'})()
        """.trimIndent()

        private val APP_PAGE = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>Sketch Studio</title>
            <link rel=manifest href="/app/manifest.webmanifest">
            <meta name=theme-color content="#2f6f8f">
            <style>body{margin:0;font-family:sans-serif;color:#15141a;background:#e8f1f5}
            h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px;line-height:1.4}
            .canvas{margin:24px;height:38vh;border-radius:16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12)}</style></head>
            <body><h1>Sketch Studio</h1><p>Draw, ink and colour on an endless canvas. This page declares a web app manifest.</p>
            <div class=canvas></div></body></html>
        """.trimIndent()

        private val MANIFEST = """
            {
              "id": "/app/",
              "name": "Sketch Studio",
              "short_name": "Sketch",
              "description": "Draw, ink and colour on an endless canvas. Sketches sync between your devices and open offline.",
              "start_url": "/app/",
              "scope": "/app/",
              "display": "standalone",
              "theme_color": "#2f6f8f",
              "background_color": "#e8f1f5",
              "icons": [
                { "src": "/webapp/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
                { "src": "/webapp/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" }
              ],
              "screenshots": [
                { "src": "/webapp/shot-canvas.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "An ink sketch on the canvas" },
                { "src": "/webapp/shot-colours.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The colour palette" },
                { "src": "/webapp/shot-gallery.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The sketch gallery" }
              ]
            }
        """.trimIndent()
    }
}
