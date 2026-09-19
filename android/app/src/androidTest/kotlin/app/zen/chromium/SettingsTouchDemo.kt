package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

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
 *
 * After the touch check, the sheet chassis under the same finger ([chassisChecks]): a hosted
 * sheet's focus goes back to the control that opened it (§9.22), the keyboard comes back to a
 * field the vault refused (§9.30), and the keyboard's lift under a sheet with a focused field
 * logs no `ResizeObserver loop` line. Each is a finding and, when it does not hold, a failure of
 * the run.
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
        seedVault()
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

        // 4. THE touch: on the option that is not the current one, where the tree says it is –
        // once the tree has caught up with the risen sheet (it reports the rows where they were
        // a few frames ago, as the DOM shows), and inside the window a finger reaches.
        var landedOn = ""
        var after = ""
        var scheme = ""
        var closed = false
        step("A real touch on '$OTHER_OPTION'") {
            val dom = domRect(OTHER_OPTION) ?: error("the option is not in the DOM")
            val started = SystemClock.uptimeMillis()
            var option: AccessibilityNodeInfo? = null
            val tree = Rect()
            var agreed = false
            while (SystemClock.uptimeMillis() < started + 6_000) {
                option = findNode { it == OTHER_OPTION }
                if (option != null) {
                    option.getBoundsInScreen(tree)
                    agreed = abs(tree.top - dom.rect.top) <= TREE_TOLERANCE && abs(tree.bottom - dom.rect.bottom) <= TREE_TOLERANCE
                    if (agreed) break
                }
                SystemClock.sleep(250)
            }
            val node = option ?: error("the option went away")
            finding(
                "  option bounds: tree $tree, DOM ${dom.rect} (checked=${dom.checked}); " +
                    "agree within $TREE_TOLERANCE px: $agreed after ${SystemClock.uptimeMillis() - started} ms; touchable window $touchable"
            )
            // The chrome's own word on where the finger landed: the target of the next pointerdown.
            chromeJs(
                "window.__touch=null;document.addEventListener('pointerdown',function(e){" +
                    "var t=e.target,c=(t.getAttribute&&t.getAttribute('class'))||'',r=(t.getAttribute&&t.getAttribute('role'))||'';" +
                    "var radio=t.closest&&t.closest('[role=radio]');" +
                    "window.__touch=(t.tagName||'').toLowerCase()+(c?'.'+c.trim().split(/\\s+/).join('.'):'')+(r?'[role='+r+']':'')" +
                    "+(radio?' in the option '+radio.textContent.trim():'')},{capture:true,once:true})"
            )
            val point = touchTapPoint(node) ?: error("no part of the option is inside the touchable window")
            finding("  finger at ${point.x},${point.y}")
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
        if (failures.isEmpty()) chassisChecks()
        finding("\nend: ${failures.size} failure(s)")
    }

    // --- the sheet chassis under the same finger -------------------------------------------------

    /**
     * Three findings of the services program's phone pass on the sheet chassis, on this Settings
     * tab. (1) §9.22: a hosted sheet's focus goes back to the control that opened it, whichever
     * way it closes – the Colour scheme picker, on screen from the touch check, by a press on its
     * scrim and by the system back; the passphrase prompt by its Cancel. (2) §9.30: a field the
     * vault refused, made read-only while the passphrase was verified, gets the keyboard back with
     * the focus. (3) The keyboard's lift under a sheet with a focused field logs no
     * `ResizeObserver loop` line. The prompt comes up over the passwords manager, opened over this
     * very tab, since the loop needs the tab's page laid out under the lift.
     */
    private fun chassisChecks() {
        finding("\nThe sheet chassis: focus return (9.22), the keyboard after a refusal (9.30), the keyboard lift")
        chromeJs(CHASSIS_PROBE_JS)
        pickerFocusReturn("a press on its scrim", "04-picker-scrim-closed") { pressAboveSheet() }
        pickerFocusReturn("the system back", "05-picker-back-closed") { back() }
        passphrasePromptChecks()
    }

    /** The picker opened from its row by a finger, closed by `close`; the focus is read once it has gone. */
    private fun pickerFocusReturn(way: String, shotName: String, close: () -> Unit) {
        step("The Colour scheme picker closed by $way: focus back on its row (9.22)") {
            chromeJs("window.__zenFocusPath=[]")
            if (!touchTapLabel(ROW_LABEL, prefix = true)) error("the row is not on screen")
            if (!awaitSheetAtRest(8_000)) error("the picker did not come up")
            val inSheet = focusedElement()
            close()
            val gone = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
            SystemClock.sleep(900)
            val after = focusedElement()
            shot(shotName)
            val ok = gone && after.contains("data-row=$ROW_ID")
            finding(
                "  focus in the sheet: $inSheet; focus path: ${chromeValue("window.__zenFocusPath.join(' > ')")}\n" +
                    "  picker gone $gone; focus after the close: $after ${verdict(ok)}"
            )
            if (!ok) failures += "the picker closed by $way left the focus on '$after'"
        }
    }

    /**
     * A real touch on the sheet's scrim: the middle of the room above the sheet, inside the
     * touchable window. The chrome's own word on where it landed goes into the findings.
     */
    private fun pressAboveSheet() {
        val top = chromeValue(
            "(function(){var s=document.querySelector('.zen-sheet');" +
                "return s?String(Math.round(s.getBoundingClientRect().top*$density)):''})()"
        ).toIntOrNull() ?: error("no sheet to press beside")
        if (top - touchable.top < 120) error("no room above the sheet (top $top, touchable from ${touchable.top}) for a finger")
        chromeJs(
            "window.__zenScrimTouch=null;document.addEventListener('pointerdown',function(e){var t=e.target;" +
                "window.__zenScrimTouch=(t.tagName||'').toLowerCase()+'.'+((t.getAttribute&&t.getAttribute('class'))||'')" +
                ".trim().split(/\\s+/).slice(0,2).join('.')},{capture:true,once:true})"
        )
        val x = width / 2f
        val y = (touchable.top + top) / 2f
        Finger().tap(x, y)
        SystemClock.sleep(400)
        finding("  finger on the scrim at $x,$y (sheet top $top): landed on ${chromeValue("String(window.__zenScrimTouch)")}")
    }

    /**
     * The passphrase prompt over the passwords manager: the keyboard's lift under it (finding 3),
     * a refused passphrase (finding 2), and its Cancel (finding 1's third close).
     */
    private fun passphrasePromptChecks() {
        val before = failures.size
        step("The passphrase prompt over the passwords manager, over this Settings tab") {
            // Getting to the state, not the claim: the manager opens on a core command.
            coreInvoke("urlbar.runCommand", "{\"action\":\"passwords.open\"}")
            if (!awaitChrome("!!document.querySelector('.zen-v2-pw')", 10_000)) error("the passwords manager did not open")
            SystemClock.sleep(1_200)
            if (!touchTapLabel(LOGIN_USERNAME, timeoutMs = 10_000)) error("the saved login is not on screen")
            if (!touchTapLabel(COPY_PASSWORD, timeoutMs = 10_000)) error("no '$COPY_PASSWORD' control on screen")
            if (!awaitChrome("!!document.querySelector('.zen-sheet #$FIELD_ID')", 10_000)) error("the passphrase prompt did not come up")
            if (!awaitSheetAtRest(8_000)) error("the prompt did not settle")
            shot("06-prompt")
            finding("  prompt up; focus: ${focusedElement()} (a phone form opens on its Cancel, not its field, §9.22)")
        }
        if (failures.size > before) return

        // Each finding below is recorded on its own: one that does not hold is a failure of the
        // run, not the end of the checks (a BEFORE run shows all three).
        var keyboardUp = false
        step("The keyboard's lift under the prompt: no ResizeObserver loop (finding 3)") {
            chromeJs("window.__zenRoLoops=0")
            val field = findNodeWhere { it.isEditable && it.isVisibleToUser && it.packageName?.toString() == app.packageName }
                ?: error("no editable field in the prompt")
            if (!touchTap(field)) error("the field is out of a finger's reach")
            keyboardUp = awaitIme(shown = true, timeoutMs = 8_000)
            val lifted = imeInset()
            // The lift's frames and the sheet's follow: the detents re-run on every inset frame.
            SystemClock.sleep(2_500)
            shot("07-keyboard-up")
            val loops = chromeValue("String(window.__zenRoLoops)").toIntOrNull() ?: -1
            val ok = keyboardUp && loops == 0
            finding(
                "  keyboard up $keyboardUp (inset $lifted px); focus: ${focusedElement()}; " +
                    "ResizeObserver loop errors during the lift: $loops ${verdict(ok)}"
            )
            if (!keyboardUp) failures += "the keyboard did not come up for the prompt's field"
            else if (loops != 0) failures += "$loops ResizeObserver loop error(s) during the keyboard's lift"
        }
        if (!keyboardUp) return

        step("A refused passphrase (9.30): the field keeps the focus and the keyboard comes back (finding 2)") {
            chromeJs(
                "window.__zenReadOnlySeen=false;(function(){var f=document.getElementById('$FIELD_ID');if(!f)return;" +
                    "new MutationObserver(function(){if(f.readOnly)window.__zenReadOnlySeen=true})" +
                    ".observe(f,{attributes:true,attributeFilter:['readonly']})})()"
            )
            keyIn(WRONG_PASSPHRASE)
            SystemClock.sleep(600)
            val typed = chromeValue("String((document.getElementById('$FIELD_ID')||{}).value||'')")
            keyPress(KeyEvent.KEYCODE_ENTER)
            // The keyboard's lowest point while the passphrase is verified and refused.
            var lowest = imeInset()
            var refused = false
            val started = SystemClock.uptimeMillis()
            while (SystemClock.uptimeMillis() < started + 8_000) {
                lowest = minOf(lowest, imeInset())
                if (!refused) refused = chromeValue("String(!!document.querySelector('.zen-sheet [role=alert]'))") == "true"
                if (refused && SystemClock.uptimeMillis() > started + 1_500) break
                SystemClock.sleep(100)
            }
            if (!refused && touchTapLabel("Continue", timeoutMs = 2_000)) {
                finding("  Enter did not submit; Continue touched instead")
                refused = awaitChrome("!!document.querySelector('.zen-sheet [role=alert]')", 8_000)
                SystemClock.sleep(1_500)
            }
            val wentReadOnly = chromeValue("String(window.__zenReadOnlySeen)") == "true"
            val back = awaitIme(shown = true, timeoutMs = 6_000)
            val inset = imeInset()
            val focus = focusedElement()
            shot("08-refused")
            val ok = refused && back && focus.contains(FIELD_ID)
            finding(
                "  typed ${typed.length} of ${WRONG_PASSPHRASE.length} characters; refused $refused; " +
                    "the field went read-only meanwhile $wentReadOnly; keyboard inset at its lowest $lowest px\n" +
                    "  after the refusal: focus $focus, keyboard inset $inset px ${verdict(ok)}"
            )
            if (!refused) failures += "the vault did not refuse the passphrase"
            else if (!ok) failures += "after the refusal the focus is on '$focus' and the keyboard inset is $inset px"
        }

        step("The prompt closed by its Cancel: focus back on the control that asked (9.22)") {
            // The keyboard is a window of its own and takes a touch inside it: when Cancel sits
            // under it (or it is not on the tree yet, behind the keyboard), one back lowers the
            // keyboard first – the IME consumes that back, the sheet stays.
            val inset = imeInset()
            val cancel = if (inset > 0) waitFor("Cancel", 3_000) else null
            if (inset > 0 && (cancel == null || cancel.bottom > height - inset)) {
                back()
                val down = awaitIme(shown = false, timeoutMs = 6_000)
                finding("  keyboard lowered before Cancel (was $inset px, Cancel at ${cancel ?: "?"}): $down")
                SystemClock.sleep(700)
            }
            chromeJs("window.__zenFocusPath=[]")
            if (!touchTapLabel("Cancel")) error("no Cancel on screen")
            val gone = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
            SystemClock.sleep(900)
            val after = focusedElement()
            shot("09-prompt-cancelled")
            val ok = gone && after.contains(COPY_PASSWORD)
            finding(
                "  focus path: ${chromeValue("window.__zenFocusPath.join(' > ')")}\n" +
                    "  prompt gone $gone; focus after Cancel: $after ${verdict(ok)}"
            )
            if (!ok) failures += "the prompt closed by Cancel left the focus on '$after'"
        }
    }

    /**
     * The vault the chassis checks need, off camera: created on the device key, one login, a
     * passphrase, and no grace period – so copying a password asks for the passphrase in the
     * chrome (the emulator has no lock screen, so no system credential prompt comes first).
     */
    private fun seedVault() {
        var unlocked = JSONObject(coreInvoke("passwords.unlock", "{}"))
        if (unlocked.optString("status") == "setup-passphrase") {
            unlocked = JSONObject(coreInvoke("passwords.unlock", JSONObject().put("passphrase", PASSPHRASE).toString()))
        }
        coreInvoke(
            "passwords.add",
            JSONObject().put("url", LOGIN_URL).put("username", LOGIN_USERNAME).put("password", "cobol-1959").toString()
        )
        val protection = coreState().getJSONObject("passwords").getJSONObject("protection")
        val set = if (protection.optBoolean("passphrase")) {
            "already set"
        } else {
            coreInvoke("passwords.setPassphrase", JSONObject().put("passphrase", PASSPHRASE).toString())
        }
        val passwords = coreState().getJSONObject("settings").getJSONObject("passwords")
        passwords.put("reauthGraceSeconds", 0)
        coreInvoke("settings.update", JSONObject().put("passwords", passwords).toString())
        SystemClock.sleep(400)
        finding("vault: unlock $unlocked; passphrase $set; status ${coreState().getJSONObject("passwords")}")
    }

    /** The chrome's focused element, described: tag and `data-row`, aria-label, id or text; "body" for none. */
    private fun focusedElement(): String = chromeValue("window.__zenDescribe?window.__zenDescribe(document.activeElement):'?'")

    /** Type `text` as key events (the virtual keyboard's map), one character at a time. */
    private fun keyIn(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (ch in text) {
            val events = map.getEvents(charArrayOf(ch)) ?: continue
            for (event in events) {
                val now = SystemClock.uptimeMillis()
                if (!ui.injectInputEvent(KeyEvent.changeTimeRepeat(event, now, 0), true)) finding("  a key was not injected")
                SystemClock.sleep(40)
            }
        }
    }

    private fun keyPress(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0), true)
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0), true)
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

    private class DomRect(val rect: Rect, val checked: String)

    /**
     * The picker option reading `label`, as the DOM lays it out, in screen px: the chrome fills
     * the window from its top-left corner, so its CSS px times the density are screen px. Null
     * when no such option is in the DOM.
     */
    private fun domRect(label: String): DomRect? {
        val text = chromeValue(
            "(function(){var b=[...document.querySelectorAll('.zen-sheet [role=radio]')]" +
                ".find(function(e){return e.textContent.trim()===${JSONObject.quote(label)}});" +
                "if(!b)return '';var r=b.getBoundingClientRect();" +
                "return [r.left,r.top,r.right,r.bottom].map(function(v){return Math.round(v*$density)}).join(',')" +
                "+','+b.getAttribute('aria-checked')})()"
        )
        val parts = text.split(',')
        if (parts.size != 5) return null
        val px = parts.take(4).map { it.toIntOrNull() ?: return null }
        return DomRect(Rect(px[0], px[1], px[2], px[3]), parts[4])
    }

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
        /** The same row in the DOM: the button's `data-row` (rows.tsx), where the focus must land again. */
        private const val ROW_ID = "color-scheme"
        /** The option that is not the seeded `light`, and the setting it writes. */
        private const val OTHER_OPTION = "Dark"
        private const val OTHER_SCHEME = "dark"
        /** How far (px) the tree's rect may sit from the DOM's before the touch: a rounding, not a trailing frame. */
        private const val TREE_TOLERANCE = 6
        /** The vault seeded off camera: one login, and the passphrase its prompt asks for. */
        private const val LOGIN_URL = "https://example.com/login"
        private const val LOGIN_USERNAME = "grace.hopper"
        private const val PASSPHRASE = "correct horse battery"
        private const val WRONG_PASSPHRASE = "wrong horse"
        /** The detail's control that asks for the passphrase (LoginDetail.tsx `IconBtn label`), the focus's home after Cancel. */
        private const val COPY_PASSWORD = "Copy password"
        /** The prompt's field (PassphrasePrompt.tsx `Field id`). */
        private const val FIELD_ID = "vault-passphrase"
        /**
         * The chrome's own account of the chassis checks: the focused element described, the
         * focus path since the last reset (`focusin`, and a `focusout` to nothing as "body"), and
         * a count of the `ResizeObserver loop` errors the page reports (an `error` event on the
         * window, the very line the WebView writes to the console and the run's logcat).
         */
        private val CHASSIS_PROBE_JS = """
            (function(){
              window.__zenDescribe=function(el){
                if(!el||el===document.body||el===document.documentElement)return 'body';
                var d=(el.tagName||'').toLowerCase();
                var a=el.getAttribute?el.getAttribute('data-row'):null;if(a)d+='[data-row='+a+']';
                var l=el.getAttribute?el.getAttribute('aria-label'):null;if(l)d+='[aria-label='+l+']';
                if(el.id)d+='#'+el.id;
                var t=(el.textContent||'').trim().replace(/\s+/g,' ');if(!l&&!el.id&&t)d+=' "'+t.slice(0,40)+'"';
                return d};
              window.__zenFocusPath=[];
              document.addEventListener('focusin',function(e){window.__zenFocusPath.push(window.__zenDescribe(e.target))},true);
              document.addEventListener('focusout',function(e){if(!e.relatedTarget)window.__zenFocusPath.push('body')},true);
              window.__zenRoLoops=0;
              window.addEventListener('error',function(e){if(String(e.message).indexOf('ResizeObserver loop')!==-1)window.__zenRoLoops++});
              return 'probe'})()
        """.trimIndent()
    }
}
