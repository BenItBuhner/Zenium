package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A finger on a phone Settings sheet, for the `android-settings-touch-demo` workflow: the
 * Settings tab from the app menu, Look and Feel, the Colour scheme picker, and a REAL touch –
 * injected through UiAutomation, hit-tested by the WebView as a finger's is – on the option that
 * is not the current one. The run FAILS unless the picker closes on that touch with the new value
 * on the row and in the core's settings.
 *
 * Why a real touch: from v0.3.42 (#168's pointer cut for the frame dialog host's slot children
 * that are not sheet layers) to v0.3.45 the Settings sheets' wrapper carried no
 * `data-sheet-layer`, so `pointer-events: none` was inherited by the whole sheet and every tap
 * fell through it to the host's scrim – the dismissal – while accessibility clicks and the
 * keyboard, which meet no hit test, kept working; the drivers that pressed the sheets' rows
 * through the accessibility tree passed. #192 put the mark on the wrapper; this driver is the
 * test that would have caught it: the touch lands where a finger's does, and the assertion reads
 * the row's value and the core's state after it, never the tap's own return.
 *
 * Findings in `android-settings-touch-findings.txt` next to the frames: where the finger landed
 * (the chrome's own `pointerdown` target), the option's bounds as the tree and the DOM gave them,
 * the row's text before and after, the core's `colorScheme`. See [DemoHarness] for the plumbing
 * and its rule on real touches versus accessibility clicks.
 */
@RunWith(AndroidJUnit4::class)
class SettingsTouchDemo : DemoHarness("settings-tab-demo-state.json", "android-settings-touch", "settings-touch-demo") {
    override val tag = "SettingsTouchDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(DEMO_TITLE, "<p>The page the Settings tab opens next to.</p>"),
                "/other.html" to DemoServer.page("Second tab", "<p>The tab the demo does not visit.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures.isNotEmpty()) error("a finger did not work the Settings sheet: ${failures.joinToString("; ")}")
    }

    override fun warmUp() {
        findings = File(out, "android-settings-touch-findings.txt")
        findings.writeText(
            "Zenium Android Settings sheet touch check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then close that tab so the demo opens Settings itself.
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = awaitChrome("!!document.querySelector('$SEARCH_FIELD')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(1_500)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_500)
        finding("warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
    }

    override fun demo() {
        // 1. The Settings tab from the app menu: the menu button and its item under a finger.
        step("Settings from the app menu") {
            val opened = openMenuItem("Settings")
            val landing = opened && awaitChrome("!!document.querySelector('$SEARCH_FIELD')", 10_000)
            SystemClock.sleep(1_200)
            shot("01-landing")
            finding("  menu item ${if (opened) "touched" else "not found"}; landing painted $landing ${verdict(landing)}")
            if (!landing) failures += "the Settings tab did not open from the menu"
        }

        // 2. Look and Feel: a real touch on the landing's row drills in.
        step("Look and Feel under a finger") {
            val touched = touchTapLabel("Look and Feel", prefix = true)
            val up = touched && awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            finding("  row ${if (touched) "touched" else "not found"}; section over the landing $up ${verdict(up)}")
            if (!up) failures += "Look and Feel did not open under a finger"
        }

        // 3. The picker: a real touch on the Colour scheme row; the row's value read first.
        val before = rowText(ROW_LABEL)
        val current = colorScheme()
        step("The Colour scheme picker under a finger") {
            val touched = touchTapLabel(ROW_LABEL, prefix = true)
            val option = if (touched) awaitNode(8_000) { it == OTHER_OPTION } else null
            val rested = option != null && awaitSheetAtRest(6_000)
            shot("02-picker-open")
            finding(
                "  row '$before' (core colorScheme $current) ${if (touched) "touched" else "not found"}; " +
                    "option '$OTHER_OPTION' on screen ${option != null}; sheet at rest $rested ${verdict(rested)}"
            )
            if (!rested) failures += "the Colour scheme picker did not open under a finger"
        }
        if (failures.isNotEmpty()) return

        // 4. THE touch: on the option that is not the current one, where the tree says it is.
        var landedOn = ""
        var after = ""
        var scheme = ""
        var closed = false
        step("A real touch on '$OTHER_OPTION'") {
            val option = awaitNode(4_000) { it == OTHER_OPTION } ?: error("the option went away")
            val bounds = Rect().also { option.getBoundsInScreen(it) }
            val dom = chromeValue(
                "(function(){var b=[...document.querySelectorAll('.zen-sheet [role=radio]')]" +
                    ".find(function(e){return e.textContent.trim()===${JSONObject.quote(OTHER_OPTION)}});" +
                    "if(!b)return 'none';var r=b.getBoundingClientRect();" +
                    "return Math.round(r.left*$density)+','+Math.round(r.top*$density)+'-'+Math.round(r.right*$density)+','+Math.round(r.bottom*$density)" +
                    "+' checked='+b.getAttribute('aria-checked')})()"
            )
            // The chrome's own word on where the finger landed: the target of the next pointerdown.
            chromeJs(
                "window.__touch=null;document.addEventListener('pointerdown',function(e){" +
                    "var t=e.target,c=(t.getAttribute&&t.getAttribute('class'))||'',r=(t.getAttribute&&t.getAttribute('role'))||'';" +
                    "var radio=t.closest&&t.closest('[role=radio]');" +
                    "window.__touch=(t.tagName||'').toLowerCase()+(c?'.'+c.trim().split(/\\s+/).join('.'):'')+(r?'[role='+r+']':'')" +
                    "+(radio?' in the option '+radio.textContent.trim():'')},{capture:true,once:true})"
            )
            finding("  option bounds (tree) $bounds, (DOM, px) $dom; touching ${bounds.exactCenterX()},${bounds.exactCenterY()}")
            if (!touchTap(option)) error("the option had no bounds on screen")
            SystemClock.sleep(600)
            landedOn = chromeValue("String(window.__touch)")
            // 5. The picker closes with the new value on the row and in the core.
            closed = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
            after = awaitRowText(ROW_LABEL, OTHER_OPTION, 8_000)
            scheme = colorScheme()
            SystemClock.sleep(1_200)
            shot("03-after-touch")
            val ok = closed && after.endsWith(OTHER_OPTION) && scheme == OTHER_SCHEME
            finding(
                "  finger landed on: $landedOn\n" +
                    "  picker closed $closed; row '$before' -> '$after'; core colorScheme $current -> $scheme ${verdict(ok)}"
            )
            if (!ok) {
                failures += "the touch on '$OTHER_OPTION' landed on '$landedOn'; the row reads '$after', colorScheme '$scheme'"
            }
        }
        finding("\nend: ${failures.size} failure(s)")
    }

    // --- steps -----------------------------------------------------------------------------------

    /** Run one step of the sequence; a failure inside it is a finding and a failure of the run. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
        }
    }

    // --- rows and sheets -------------------------------------------------------------------------

    /** The accessible text of the first node reading `prefix`… (a Settings row runs label and value together); "" when none. */
    private fun rowText(prefix: String): String =
        findNode { it.startsWith(prefix) }?.let { (it.text ?: it.contentDescription)?.toString() }.orEmpty()

    /** Poll until the row reading `prefix`… ends with `value` (the tree trails the screen); the text it reads then. */
    private fun awaitRowText(prefix: String, value: String, timeoutMs: Long): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var text = rowText(prefix)
        while (SystemClock.uptimeMillis() < deadline) {
            if (text.endsWith(value)) return text
            SystemClock.sleep(250)
            text = rowText(prefix)
        }
        return text
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a finger landing on a moving sheet catches it instead of tapping.
     */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length===1&&" +
                "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(800)
        return rested
    }

    private fun colorScheme(): String = coreState().getJSONObject("settings").optString("colorScheme")

    // --- the chrome ------------------------------------------------------------------------------

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

    companion object {
        private const val PORT = 18134
        private const val DEMO_TITLE = "Settings touch check"
        /** The landing's Find in Settings field, in the chrome's DOM: the page is up. */
        private const val SEARCH_FIELD = ".zen-settings-search-field"
        /** The picker row (sections.tsx `color-scheme`): reads "Colour scheme <value>" in the tree. */
        private const val ROW_LABEL = "Colour scheme"
        /** The option that is not the seeded `light`, and the setting it writes. */
        private const val OTHER_OPTION = "Dark"
        private const val OTHER_SCHEME = "dark"
    }
}
