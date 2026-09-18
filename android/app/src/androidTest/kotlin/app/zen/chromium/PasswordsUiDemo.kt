package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the password manager's phone surfaces on an emulator with a device PIN: the manager
 * opened from the app menu, the vault gate with the system credential prompt behind the
 * Keystore-bound vault key, the list, a login's detail with its password revealed after the PIN,
 * the generator, the checkup, the settings (the re-authentication menulist), and the passphrase
 * prompt sheet – the device prompt dismissed, the vault passphrase asked for in its place. Back
 * is shown popping a pane before it would close the overlay.
 *
 * The vault is seeded off camera through the chrome's command API (the calls the manager makes)
 * and locked; the recording opens it the way a user does. The Keystore counts the PIN the
 * workflow set moments earlier as a fresh authentication for five minutes, so the warm-up waits
 * until the key wants one again and the recorded unlock shows the prompt. That prompt is a
 * secure system window: screenshots and the recording show it black, and the step log
 * (`services-passwords-android-ui-steps.txt`) says when it was up and answered.
 */
@RunWith(AndroidJUnit4::class)
class PasswordsUiDemo : DemoHarness("passwords-demo-state.json", "services-passwords-android-ui", "passwords-ui-demo") {
    override val tag = TAG
    private var shots = 0
    private var startedAt = 0L
    private lateinit var log: File

    @Test
    fun record() {
        startedAt = SystemClock.uptimeMillis()
        runDemo()
    }

    // --- off camera: seed the vault, then wait for the key to want an authentication -------------

    override fun warmUp() {
        log = File(out, LOG_NAME)
        log.writeText("Zenium Android passwords UI demo\n\n")
        val before = zen("app.getState").getJSONObject("passwords")
        step("status before: $before")
        assertTrue("the Android host must offer a keystore", before.getBoolean("osKeystore"))
        assertTrue("the Android host must offer re-authentication", before.getBoolean("osReauth"))

        // Create the vault (the Keystore mints its authentication-bound key), save the logins,
        // add the passphrase the prompt sheet will ask for, and lock.
        val unlock = zen("passwords.unlock", JSONObject())
        assertEquals("unlock: $unlock", "ok", unlock.getString("status"))
        for (login in LOGINS) zen("passwords.add", login)
        val set = zen("passwords.setPassphrase", JSONObject().put("passphrase", PASSPHRASE))
        assertEquals("setPassphrase: $set", "ok", set.getString("status"))
        assertEquals(LOGINS.size, zenArray("passwords.list", JSONObject()).length())
        zen("passwords.lock")
        val seeded = zen("app.getState").getJSONObject("passwords")
        step("seeded and locked: $seeded")
        assertTrue("the vault should be locked", seeded.getBoolean("locked"))
        assertTrue("the vault should be OS-protected", seeded.getJSONObject("protection").getBoolean("os"))
        assertTrue("the vault should have a passphrase", seeded.getJSONObject("protection").getBoolean("passphrase"))

        awaitKeyWantsAuthentication()
    }

    /**
     * A silent unwrap of the vault's key blob says whether the Keystore would open the key without
     * a prompt. Wait until it would not (the five minutes since the PIN was set have passed), so
     * the recorded unlock shows the credential prompt – but never past the recorder's handshake
     * budget, which the shared demo script counts from the driver's start.
     */
    private fun awaitKeyWantsAuthentication() {
        val blob = osKeyBlob() ?: run {
            step("no OS key blob in the vault document; not waiting for the key")
            return
        }
        val deadline = startedAt + HANDSHAKE_BUDGET_MS
        val from = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() < deadline) {
            when (val probe = silentUnwrap(blob)) {
                "unavailable" -> {
                    step("the vault key wants an authentication again after ${(SystemClock.uptimeMillis() - from) / 1000} s")
                    return
                }
                "ok" -> SystemClock.sleep(5_000)
                else -> {
                    step("a silent unwrap answered '$probe'; not waiting for the key")
                    return
                }
            }
        }
        step("the vault key still opens silently at the handshake budget; going ahead")
    }

    /** `keyWrap.os` of the vault document, once the core has written it. */
    private fun osKeyBlob(): String? {
        val doc = File(app.filesDir, "zen/passwords.json")
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline) {
            runCatching { JSONObject(doc.readText()).getJSONObject("keyWrap").optString("os") }
                .getOrNull()?.takeIf { it.isNotEmpty() }?.let { return it }
            SystemClock.sleep(500)
        }
        return null
    }

    /** "ok" when the Keystore opened the blob without UI, else the failure code it reported. */
    private fun silentUnwrap(blob: String): String {
        val latch = CountDownLatch(1)
        var answer: Any? = null
        (activity as MainActivity).host.vault.unwrap(blob, interactive = false) {
            answer = it
            latch.countDown()
        }
        if (!latch.await(20, TimeUnit.SECONDS)) return "timeout"
        return when (val a = answer) {
            is JSONObject -> a.optString("failure", "unknown")
            is String -> "ok"
            else -> "unexpected ${a?.javaClass?.simpleName}"
        }
    }

    // --- on camera -------------------------------------------------------------------------------

    override fun demo() {
        val f = Finger()
        snap("browser-idle")

        // 1. The app menu, expanded so its library block is on screen, and its Passwords row.
        step("opening the app menu")
        ensureForeground()
        if (!tapLabel(f, MENU_LABEL)) error("no menu button")
        if (waitFor(HANDLE_LABEL, 8_000) == null) error("the menu never opened")
        SystemClock.sleep(1_200)
        expandSheet(f)
        snap("app-menu")
        openMenuRow(f, "Passwords")

        // 2. The gate tries the device key at once; the Keystore asks for the PIN when the key
        //    wants an authentication, and the list follows.
        step("manager open")
        if (!credentialPromptShowing()) snap("gate")
        unlockThroughGate()
        SystemClock.sleep(1_000)
        snap("list")

        // 3. A login: the pushed pane, the PIN behind the reveal, the password shown.
        openLogin(f, DETAIL_USERNAME)
        snap("detail")
        step("revealing the password")
        tapLabel(f, "Show password")
        if (awaitCredentialPrompt(10_000)) {
            snap("reveal-pin-prompt-secure")
            enterPin()
        } else {
            step("no credential prompt for the reveal")
        }
        if (waitFor("Hide password", 10_000) == null) step("the password did not reveal")
        SystemClock.sleep(900)
        snap("detail-revealed")

        // 4. Back pops the pane; the overlay stays.
        popPane()
        SystemClock.sleep(700)

        // 5. The generator: a password, then a passphrase.
        pickCategory(f, "Passwords", "Generator", "Generate another", snapMenu = "category-menu")
        SystemClock.sleep(800)
        snap("generator")
        tapLabel(f, "Generate another")
        SystemClock.sleep(900)
        chooseRadio(f, "Passphrase", "Words")
        SystemClock.sleep(1_200)
        snap("generator-passphrase")

        // 6. The checkup: HIBP range queries, strength and reuse over the seeded logins.
        pickCategory(f, "Generator", "Checkup", "Check now")
        SystemClock.sleep(700)
        snap("checkup")
        step("running the checkup")
        tapLabel(f, "Check now")
        SystemClock.sleep(700)
        snap("checkup-running")
        val checkup = awaitCheckup(45_000)
        step("checkup: $checkup")
        File(out, "checkup.json").writeText(checkup.toString(2))
        SystemClock.sleep(900)
        snap("checkup-results")

        // 7. The settings; the re-authentication menulist set to Every time, so the copy below
        //    asks again although the reveal just verified the user.
        pickCategory(f, "Checkup", "Settings", "Lock now")
        SystemClock.sleep(700)
        snap("settings")
        setGraceToEveryTime(f)
        SystemClock.sleep(900)
        snap("settings-every-time")

        // 8. The prompt sheet: the device prompt behind a copy dismissed, the passphrase asked for.
        pickCategory(f, "Settings", "Passwords", "Add login")
        openLogin(f, DETAIL_USERNAME)
        step("copying the password")
        tapLabel(f, "Copy password")
        if (awaitCredentialPrompt(10_000)) {
            SystemClock.sleep(900)
            step("dismissing the device prompt with back")
            if (!dismissCredentialPrompt()) error("the device prompt did not close")
        } else {
            step("no credential prompt for the copy")
        }
        if (waitFor("Continue", 10_000) == null) {
            dumpNames("the detail after the copy")
            error("the passphrase prompt never showed")
        }
        step("the passphrase prompt is up")
        SystemClock.sleep(1_300)
        snap("prompt-sheet")
        answerPassphraseSheet()
        if (waitFor("Password copied", 8_000) != null) step("password copied with the passphrase") else step("no 'Password copied' toast")
        SystemClock.sleep(700)
        snap("detail-copied")

        // 9. Back to the list, then the header's close control; the browser is the last frame.
        SystemClock.sleep(1_200)
        popPane()
        SystemClock.sleep(500)
        tapLabel(f, CLOSE_LABEL)
        if (!waitGone(CLOSE_LABEL, 6_000)) step("the manager did not close")
        SystemClock.sleep(1_200)
        snap("browser-after")
        step("done")
    }

    /**
     * The system back: the pushed pane goes (a keyboard first, when one is up), the overlay
     * stays. Back is only sent again while the pane is still there, since with no pane it would
     * close the overlay.
     */
    private fun popPane() {
        for (attempt in 1..3) {
            back()
            if (waitFor("Add login", 5_000) != null) {
                step("back popped the pane")
                return
            }
            if (findByLabel("Copy password") == null) {
                step("neither the pane nor the list is in the tree after back (attempt $attempt); waiting")
                if (waitFor("Add login", 5_000) != null) {
                    step("back popped the pane")
                    return
                }
                continue
            }
            step("back did not pop the pane yet (attempt $attempt)")
        }
        dumpNames("the manager after back")
        error("back did not pop the detail pane")
    }

    // --- the app menu ----------------------------------------------------------------------------

    /** Fling the sheet's handle up so the whole menu is on screen. */
    private fun expandSheet(f: Finger) {
        val grip = findByLabel(HANDLE_LABEL) ?: return
        f.down(width / 2f, grip.exactCenterY())
        f.moveBy(0f, -0.4f * height, 130)
        f.up()
        SystemClock.sleep(1_600)
    }

    /** Tap a menu row (scrolled into view first); the accessibility click is the fallback. */
    private fun openMenuRow(f: Finger, label: String) {
        val row = reveal(label)
        if (row != null && row.top >= 0 && row.bottom <= height) {
            f.tap(row.exactCenterX(), row.exactCenterY())
            if (awaitManager(6_000)) return
            step("the tap on the '$label' row did not open the manager; clicking it through accessibility")
        }
        if (!clickByLabel(label)) {
            dumpNames("the app menu")
            error("no menu row '$label'")
        }
        if (!awaitManager(10_000)) error("the manager never opened")
    }

    /**
     * The manager's header is in the tree – or the device credential prompt is already in front
     * of it: the gate asks for the key as soon as it mounts, and while the system window is up
     * the active window is not the app's.
     */
    private fun awaitManager(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(CLOSE_LABEL) != null || credentialPromptShowing()) return true
            SystemClock.sleep(200)
        }
        return false
    }

    // --- the gate --------------------------------------------------------------------------------

    /**
     * The gate attempts the device key as it mounts. Answer the credential prompt when it comes;
     * a refused attempt leaves the gate's Unlock button, which is tried again.
     */
    private fun unlockThroughGate() {
        val deadline = SystemClock.uptimeMillis() + 60_000
        var retryAt = SystemClock.uptimeMillis() + 6_000
        var prompts = 0
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel("Add login") != null) {
                step(if (prompts > 0) "vault open after the PIN" else "vault open without a prompt (the key was still within its authentication validity)")
                return
            }
            if (credentialPromptShowing()) {
                prompts++
                step("credential prompt up for the unlock")
                SystemClock.sleep(1_200)
                snap("unlock-pin-prompt-secure")
                enterPin()
                retryAt = SystemClock.uptimeMillis() + 6_000
                continue
            }
            if (SystemClock.uptimeMillis() > retryAt && buttonEnabled("Unlock")) {
                step("the gate is waiting; tapping Unlock")
                clickByLabel("Unlock")
                retryAt = SystemClock.uptimeMillis() + 6_000
            }
            SystemClock.sleep(300)
        }
        dumpNames("the gate")
        error("the vault did not open")
    }

    // --- the manager -----------------------------------------------------------------------------

    /** Tap a login's row (named after its username, then the site) and wait for the detail pane. */
    private fun openLogin(f: Finger, username: String) {
        step("opening the login $username")
        val row = waitForRow(username, 8_000) ?: run {
            dumpNames("the list")
            error("no row for $username")
        }
        SystemClock.sleep(400)
        f.tap(row.exactCenterX(), row.exactCenterY())
        if (waitFor("Show password", 6_000) != null) return
        step("the tap on the row did not open the detail; clicking it through accessibility")
        clickRow(username)
        if (waitFor("Show password", 6_000) == null) error("the detail for $username never opened")
    }

    /**
     * Pick a category from the phone header's menulist, and wait for something only that view
     * shows. Accessibility names the combobox after its value – the current view's label, `from`
     * – not after its aria-label, and the page's own container is labelled "Passwords", so the
     * option is told from it by being clickable. `snapMenu` takes a still of the open menu.
     */
    private fun pickCategory(f: Finger, from: String, label: String, expect: String, snapMenu: String? = null) {
        step("category: $from -> $label")
        if (pickOption(f, from, label, snapMenu) { waitFor(expect, 6_000) != null }) return
        dumpNames("the manager after picking $label")
        error("could not switch to $label")
    }

    /**
     * Open the menulist reading `reading` and choose `label`; `applied` says whether the choice
     * took. Two attempts, each ending with the menu closed again if it stayed open. On a phone
     * the list is a picker sheet that springs up from the bottom edge: its rows are in the tree
     * before they are at rest, so the option is tapped where it has stopped, not where it was
     * first seen (a touch on a moving sheet catches the sheet instead of picking).
     */
    private fun pickOption(
        f: Finger,
        reading: String,
        label: String,
        snapMenu: String? = null,
        applied: () -> Boolean
    ): Boolean {
        for (attempt in 1..2) {
            if (!tapControl(f, reading)) {
                step("no menulist reading '$reading' (attempt $attempt)")
                dumpNames("the view")
                continue
            }
            if (waitForOption(label, 4_000) == null) {
                step("the menu did not open (attempt $attempt)")
                continue
            }
            val option = awaitOptionAtRest(label)
            if (option == null) {
                step("the option '$label' left the tree before it came to rest (attempt $attempt)")
                continue
            }
            if (snapMenu != null && attempt == 1) snap(snapMenu)
            f.tap(option.exactCenterX(), option.exactCenterY())
            if (applied()) return true
            step("the tap on '$label' did not apply; clicking it through accessibility")
            if (clickOption(label) && applied()) return true
            if (optionNode(label) != null) {
                // The menu is still open: back closes it and nothing else.
                back()
                SystemClock.sleep(800)
            }
        }
        return false
    }

    /** A menu option: a clickable node of the app named `label` with a place on screen. */
    private fun optionNode(label: String): AccessibilityNodeInfo? = nodes { node ->
        node.packageName?.toString() == app.packageName && node.isVisibleToUser && node.isClickable && node.isNamed(label)
    }.firstOrNull { node -> Rect().also(node::getBoundsInScreen).let { it.width() > 0 && it.height() > 0 } }

    private fun waitForOption(label: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            optionNode(label)?.let { return Rect().also(it::getBoundsInScreen) }
            SystemClock.sleep(200)
        }
        return null
    }

    /**
     * The option's bounds once they have stopped moving – three readings 150 ms apart agreeing –
     * or the last reading when the sheet is still in motion after 3 s; null once the option has
     * gone from the tree.
     */
    private fun awaitOptionAtRest(label: String): Rect? {
        val deadline = SystemClock.uptimeMillis() + 3_000
        var last: Rect? = null
        var agreed = 0
        while (SystemClock.uptimeMillis() < deadline) {
            val now = optionNode(label)?.let { Rect().also(it::getBoundsInScreen) } ?: return null
            agreed = if (now == last) agreed + 1 else 0
            last = now
            if (agreed >= 2) return now
            SystemClock.sleep(150)
        }
        step("the option '$label' was still moving after 3 s; tapping it where it is")
        return last
    }

    private fun clickOption(label: String): Boolean =
        optionNode(label)?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: false

    /** Select a radio row (named after its label, then its description) and wait for the view to follow. */
    private fun chooseRadio(f: Finger, label: String, expect: String) {
        step("radio: $label")
        val row = waitForRow(label, 5_000)
        if (row != null) {
            f.tap(row.exactCenterX(), row.exactCenterY())
            if (waitFor(expect, 4_000) != null) return
            step("the tap on the '$label' radio did not apply; clicking it through accessibility")
        } else {
            step("no radio named '$label'")
        }
        clickRow(label)
        if (waitFor(expect, 4_000) == null) {
            dumpNames("the generator")
            step("the '$label' radio never applied")
        }
    }

    /** Poll the checkup until it has finished (or failed); the state then. */
    private fun awaitCheckup(timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var checkup = JSONObject()
        while (SystemClock.uptimeMillis() < deadline) {
            checkup = zen("app.getState").getJSONObject("passwords").getJSONObject("checkup")
            if (!checkup.getBoolean("running") && (!checkup.isNull("finishedAt") || !checkup.isNull("error"))) return checkup
            SystemClock.sleep(1_000)
        }
        step("the checkup did not finish within ${timeoutMs / 1000} s")
        return checkup
    }

    /**
     * The settings' "Ask again before showing or copying" menulist to Every time, through its
     * menu (the combobox is named after the value it reads, so that is looked up first); the
     * settings command is the fallback so the copy below is sure to ask.
     */
    private fun setGraceToEveryTime(f: Finger) {
        step("re-authentication grace: Every time")
        val current = zen("app.getState").getJSONObject("settings").getJSONObject("passwords")
        val reading = GRACE_LABELS[current.getInt("reauthGraceSeconds")]
        if (reading == null) {
            step("the grace menulist reads a value the driver does not know (${current.getInt("reauthGraceSeconds")} s)")
        } else if (pickOption(f, reading, "Every time", "settings-grace-menu") { awaitGrace(0, 5_000) }) {
            return
        }
        step("setting the grace period through the settings command instead")
        zen("settings.update", JSONObject().put("passwords", current.put("reauthGraceSeconds", 0)))
    }

    private fun awaitGrace(seconds: Int, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val grace = zen("app.getState").getJSONObject("settings").getJSONObject("passwords").getInt("reauthGraceSeconds")
            if (grace == seconds) return true
            SystemClock.sleep(400)
        }
        return false
    }

    /**
     * Type the vault passphrase into the sheet's field (focused as the sheet opens; tapped first
     * when the keys did not land) and submit with Enter, the Continue button as the fallback.
     */
    private fun answerPassphraseSheet() {
        typeText(PASSPHRASE)
        SystemClock.sleep(700)
        if (!buttonEnabled("Continue")) {
            step("the passphrase field was not focused; tapping it")
            val field = editableInApp() ?: error("no passphrase field in the sheet")
            Finger().tap(field.exactCenterX(), field.exactCenterY())
            SystemClock.sleep(900)
            typeText(PASSPHRASE)
            SystemClock.sleep(700)
        }
        snap("prompt-sheet-filled")
        pressKey(KeyEvent.KEYCODE_ENTER)
        if (waitGone("Continue", 5_000)) return
        step("Enter did not submit the sheet; clicking Continue")
        clickByLabel("Continue")
        if (!waitGone("Continue", 5_000)) step("the passphrase sheet stayed up")
    }

    // --- the chrome's command API ----------------------------------------------------------------

    private fun zen(command: String): JSONObject = zen(command, null)

    /**
     * `window.zen.invoke(command, args)` in the chrome WebView, awaited from here. While the call
     * is pending a system credential prompt is answered with the PIN.
     */
    private fun zen(command: String, args: JSONObject?): JSONObject {
        val raw = zenRaw(command, args)
        return when (val value = JSONTokener(raw).nextValue()) {
            is JSONObject -> value
            JSONObject.NULL, null -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun zenArray(command: String, args: JSONObject?): JSONArray =
        JSONTokener(zenRaw(command, args)).nextValue() as JSONArray

    private fun zenRaw(command: String, args: JSONObject?): String {
        val argsJs = args?.toString() ?: "undefined"
        eval(
            """
            window.__pwUiDemo = undefined;
            window.zen.invoke(${JSONObject.quote(command)}, $argsJs).then(
              (v) => { window.__pwUiDemo = JSON.stringify({ ok: v === undefined ? null : v }); },
              (e) => { window.__pwUiDemo = JSON.stringify({ err: String((e && e.message) || e) }); }
            );
            """.trimIndent()
        )
        val deadline = SystemClock.uptimeMillis() + 120_000
        while (SystemClock.uptimeMillis() < deadline) {
            val result = eval("window.__pwUiDemo === undefined ? null : window.__pwUiDemo")
            if (result != "null") {
                val envelope = JSONObject(JSONTokener(result).nextValue() as String)
                if (envelope.has("err")) error("$command rejected: ${envelope.getString("err")}")
                return envelope.get("ok").toString()
            }
            if (credentialPromptShowing()) {
                step("credential prompt up during $command")
                SystemClock.sleep(1_200)
                enterPin()
            }
            SystemClock.sleep(250)
        }
        error("$command did not answer within 120 s")
    }

    /** Evaluate JavaScript in the chrome WebView (main thread) and wait for its JSON result. */
    private fun eval(script: String): String {
        val latch = CountDownLatch(1)
        var result = "null"
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.chrome.evaluateJavascript(script) {
                result = it ?: "null"
                latch.countDown()
            }
        }
        assertTrue("the chrome did not answer", latch.await(20, TimeUnit.SECONDS))
        return result
    }

    // --- the system credential prompt ------------------------------------------------------------

    /**
     * BiometricPrompt falling back to the device credential is a system window (SystemUI, or the
     * Settings app on older builds) with a text field for the PIN.
     */
    private fun credentialPromptShowing(): Boolean = nodes { node ->
        node.packageName?.toString() in CREDENTIAL_PACKAGES && node.className?.toString() == "android.widget.EditText"
    }.isNotEmpty()

    private fun awaitCredentialPrompt(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (credentialPromptShowing()) {
                step("credential prompt up")
                SystemClock.sleep(1_000)
                return true
            }
            SystemClock.sleep(200)
        }
        return false
    }

    private fun enterPin() {
        typeText(PIN)
        SystemClock.sleep(300)
        pressKey(KeyEvent.KEYCODE_ENTER)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (credentialPromptShowing() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        step(if (credentialPromptShowing()) "credential prompt still up" else "credential accepted")
        SystemClock.sleep(800)
    }

    /**
     * Leave the credential prompt unanswered: back closes the PIN field's keyboard first and the
     * prompt itself next, so it is pressed until the prompt is gone (the core counts that as a
     * refusal and asks for the passphrase instead). A Cancel control of the prompt is the fallback.
     */
    private fun dismissCredentialPrompt(): Boolean {
        for (attempt in 1..4) {
            if (attempt == 3) {
                dumpNames("the credential prompt", CREDENTIAL_PACKAGES)
                val cancel = nodes { node ->
                    node.packageName?.toString() in CREDENTIAL_PACKAGES && node.isClickable &&
                        (node.isNamed("Cancel") || node.isNamed("Back"))
                }.firstOrNull()
                if (cancel != null) {
                    step("clicking the prompt's ${cancel.contentDescription ?: cancel.text}")
                    cancel.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                } else {
                    back()
                }
            } else {
                back()
            }
            val deadline = SystemClock.uptimeMillis() + 2_500
            while (SystemClock.uptimeMillis() < deadline) {
                if (!credentialPromptShowing()) {
                    step("the device prompt went after $attempt press${if (attempt > 1) "es" else ""}")
                    return true
                }
                SystemClock.sleep(200)
            }
            step("the device prompt is still up (attempt $attempt)")
        }
        return false
    }

    // --- finding, tapping, typing ----------------------------------------------------------------

    /**
     * Bounds of the app's control named `label` (its text or aria-label). A clickable match wins
     * over a plain one: the page's container is labelled "Passwords", as the header's menulist
     * reads while the list is the view.
     */
    private fun findControl(label: String): Rect? {
        val matches = nodes { node ->
            node.packageName?.toString() == app.packageName && node.isVisibleToUser && node.isNamed(label)
        }
        return matches.filter { it.isClickable }.ifEmpty { matches }
            .map { Rect().also(it::getBoundsInScreen) }
            .filter { it.width() > 0 && it.height() > 0 }
            .minByOrNull { it.width() * it.height() }
    }

    private fun tapControl(f: Finger, label: String, timeoutMs: Long = 5_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var target = findControl(label)
        while (target == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            target = findControl(label)
        }
        if (target == null) {
            step("no control named '$label'")
            return false
        }
        f.tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    private fun AccessibilityNodeInfo.isNamed(label: String): Boolean =
        text?.toString()?.trim() == label || contentDescription?.toString()?.trim() == label

    /**
     * A list row, a radio or a checkbox is one node to accessibility, named after everything in
     * it – the username then the site, the label then the description – so its label alone is
     * only the start of its name. An exact match wins when there is one.
     */
    private fun rowNode(label: String): AccessibilityNodeInfo? =
        findNode { it == label } ?: findNode { it.startsWith(label) }

    private fun findRow(label: String): Rect? = rowNode(label)?.let { Rect().also(it::getBoundsInScreen) }

    private fun waitForRow(label: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findRow(label)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /** Click a row through accessibility: the node itself or its nearest clickable ancestor. */
    private fun clickRow(label: String): Boolean {
        var node = rowNode(label)
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: false
    }

    /** The names of the visible nodes of `packages` (the app's), into the step log, when a lookup has failed. */
    private fun dumpNames(where: String, packages: Set<String> = setOf(app.packageName)) {
        val names = nodes { node ->
            node.packageName?.toString() in packages && node.isVisibleToUser &&
                (!node.text.isNullOrBlank() || !node.contentDescription.isNullOrBlank())
        }.map { node ->
            val name = (node.contentDescription?.takeIf { it.isNotBlank() } ?: node.text).toString().trim()
            name.take(70) + if (node.isClickable) " [clickable]" else ""
        }
        step("names in $where (${names.size}): ${names.take(80).joinToString(" | ")}")
    }

    /** The button labelled `label` is on screen and enabled (a disabled submit reports otherwise). */
    private fun buttonEnabled(label: String): Boolean = nodes { node ->
        node.packageName?.toString() == app.packageName && node.isEnabled && node.isNamed(label)
    }.isNotEmpty()

    /** The app's editable field (the sheet's passphrase input), if one is on screen. */
    private fun editableInApp(): Rect? = nodes { node ->
        node.packageName?.toString() == app.packageName && node.isEditable && node.isVisibleToUser
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .firstOrNull { it.width() > 0 && it.height() > 0 }

    private fun waitGone(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) == null) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** Breadth-first search of every window on screen (the app, SystemUI's prompt). */
    private fun nodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        for (window in ui.windows) window.root?.let(roots::add)
        if (roots.isEmpty()) ui.rootInActiveWindow?.let(roots::add)
        val found = ArrayList<AccessibilityNodeInfo>()
        val queue = ArrayDeque(roots)
        var visited = 0
        while (queue.isNotEmpty() && visited < 12_000) {
            val node = queue.removeFirst()
            visited++
            if (predicate(node)) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    private fun typeText(text: String) {
        val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray()) ?: return
        for (event in events) {
            ui.injectInputEvent(event, true)
            SystemClock.sleep(40)
        }
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0), true)
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0), true)
    }

    /** Numbered so the artifact lists the sequence in order. */
    private fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
        step("shot $name")
    }

    private fun step(message: String) {
        Log.i(TAG, message)
        if (::log.isInitialized) log.appendText("${SystemClock.uptimeMillis() - startedAt} $message\n")
    }

    companion object {
        private const val TAG = "PasswordsUiDemo"
        private const val LOG_NAME = "services-passwords-android-ui-steps.txt"
        private val CREDENTIAL_PACKAGES = setOf("com.android.systemui", "com.android.settings")
        /** Set by the workflow with `locksettings set-pin` before the driver starts. */
        private const val PIN = "1234"
        private const val PASSPHRASE = "orbit-lantern-quiet-42"
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"
        private const val CLOSE_LABEL = "Close (Esc)"
        /** What the settings' re-authentication menulist reads for each grace period it offers. */
        private val GRACE_LABELS = mapOf(
            0 to "Every time",
            30 to "After 30 seconds",
            60 to "After 1 minute",
            300 to "After 5 minutes",
            900 to "After 15 minutes",
            3600 to "After 1 hour"
        )
        /** The login the detail steps open: the one username that appears once. */
        private const val DETAIL_USERNAME = "grace.hopper"
        /**
         * The shared demo script gives up on the recording handshake 300 s (1200 polls) after it
         * starts the driver; the warm-up's wait for the key stops before that.
         */
        private const val HANDSHAKE_BUDGET_MS = 280_000L

        private fun login(url: String, username: String, password: String, notes: String? = null): JSONObject =
            JSONObject().put("url", url).put("username", username).put("password", password).also {
                if (notes != null) it.put("notes", notes)
            }

        /** Five logins: a reused password, a weak one the breach corpus knows, two strong ones. */
        private val LOGINS = listOf(
            login("https://accounts.example.com/login", "ada.lovelace@example.com", "Tr0ub4dor&3-demo"),
            login("https://bank.example/login", "ada.lovelace", "correct horse battery staple"),
            login("https://mail.example.com/", "ada@example.com", "correct horse battery staple"),
            login("https://shop.example.net/account", "ada_shops", "password123"),
            login(
                "https://forum.example.org/",
                "grace.hopper",
                "qN7#vLp2!xR9wZ4kT1bS",
                "Work account; the second factor is the authenticator app."
            )
        )
    }
}
