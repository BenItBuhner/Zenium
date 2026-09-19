package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Passwords in pages on a phone with a device PIN, for the emulator recordings of the
 * `services-password-fill` PRs: a sign-in typed into a demo shop served from the instrumentation
 * is offered for saving (the chrome's prompt sheet; the engine PR showed the host's dialog), the
 * saved login fills the form again from the account picker's strip above the keyboard (a tap on
 * its row, behind the system PIN; the engine PR picked through the command API, which stands in
 * when the row is not in the accessibility tree), a checkout's card and address are offered for
 * saving one after the other and filled back from their strips, Settings > Autofill shows the
 * Passwords rows, the clipboard menu sheet, the managers and the address editor, a password copy
 * reaches the clipboard marked sensitive (the value hidden from the preview), and the Android
 * autofill provider setting moves the page WebViews in and out of the system framework.
 *
 * Asserts what the engine answers (the login round-trips, the fills land in the fields, the card
 * and address round-trip, the password clip is the sensitive one, the vault document holds no
 * plaintext) and what the fingers it puts inside the chrome's sheets and strips did (the rule in
 * DemoHarness, the audit after #194: the prompt sheets' Save puts the entry in the vault, the
 * pickers' rows fill the page's fields, the clipboard picker's option lands in the settings, the
 * item sheets' Edit opens the editor on the entry, the editor's Country menulist stacks the
 * country sheet whose option changes the form's lines; a touch that went in without its effect
 * fails the run once the recording is done). Writes what it observes (system autofill status,
 * WebAuthn support, clipboard descriptions, which path each press took) next to the screenshots.
 * The Settings tour's stills are otherwise photographed, not asserted: the tree of the
 * software-rendered emulator trails the screen.
 */
@RunWith(AndroidJUnit4::class)
class AutofillDemo : DemoHarness("autofill-demo-state.json", "services-password-fill-android", "autofill-demo") {
    override val tag = TAG
    private var shots = 0
    private val notes = StringBuilder()
    private lateinit var server: DemoServer
    private val pinPrompts = ArrayList<String>()

    @Test
    fun record() = runDemo()

    override fun beforeLaunch() {
        // The engine's dialogs and the system's credential prompt are windows of their own.
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        ui.serviceInfo = info
        server = DemoServer(this::readAsset, PORT).also { it.start() }
        note("server: ${server.selfCheck()}")
        // A device credential: the vault key is authentication-bound and BiometricPrompt falls
        // back to it (the emulator has no enrolled biometrics).
        note("set-pin: ${shell("locksettings set-pin $PIN").trim()}")
        shell("wm dismiss-keyguard")
    }

    override fun warmUp() {
        if (!awaitPath("/login", 25_000)) {
            note("seeded tab did not load the login page; opening it")
            openLink("$BASE/login")
            assertTrue("login page", awaitPath("/login", 25_000))
        }
        SystemClock.sleep(2_500)
    }

    override fun demo() {
        val state = zen("app.getState")
        val passwords = state.getJSONObject("passwords")
        val autofill = state.getJSONObject("autofill")
        note("passwords status: $passwords")
        note("autofill state: $autofill")
        assertTrue("the Android host must offer a keystore", passwords.getBoolean("osKeystore"))
        assertTrue("the Android host must offer re-authentication", passwords.getBoolean("osReauth"))
        note("page WebView importantForAutofill (provider zenium): ${importance()}")
        note("WebAuthn support: ${webAuthnSupport()}")
        note("page PublicKeyCredential: ${page("typeof window.PublicKeyCredential")}")
        snap("login-page")

        // 1. Sign in by hand: the forms script sees the submit, the navigation confirms it and the
        //    chrome offers to save in its prompt sheet (the vault is created first, behind the PIN
        //    when the key asks).
        tapSelector("#email")
        type(EMAIL)
        pressKey(KeyEvent.KEYCODE_TAB)
        type(PASSWORD)
        snap("credentials-typed")
        pressKey(KeyEvent.KEYCODE_ENTER)
        assertTrue("welcome page after sign-in", awaitPath("/welcome", 20_000))
        assertTrue("save prompt", awaitText("Save password for", 30_000, "pin-prompt-create-vault"))
        SystemClock.sleep(1_200)
        snap("save-password-prompt")
        // The prompt sheet's injected touch: Save under a finger, and the login must be in the
        // vault on it (a touch the scrim took dismisses the sheet with nothing saved).
        answerPrompt("Save", "the login is in the vault", "pin-prompt-save-password") {
            zenArray("passwords.list", JSONObject()).length() == 1
        }
        toast("Password saved")
        snap("password-saved")
        val logins = zenArray("passwords.list", JSONObject())
        assertEquals("one saved login: $logins", 1, logins.length())
        val login = logins.getJSONObject(0)
        assertEquals(EMAIL, login.getString("username"))
        note("saved login: $login")

        // 2. Back at the sign-in form the focused field has a match: the account picker's strip
        //    comes up above the keyboard, and a tap on its row fills both fields behind a
        //    re-authentication.
        tapSelector("header a")
        assertTrue("login page again", awaitPath("/login", 20_000))
        SystemClock.sleep(1_500)
        tapSelector("#email")
        val picker = awaitPicker("login")
        note("login picker: $picker")
        assertEquals(1, picker.getJSONArray("items").length())
        assertEquals(EMAIL, picker.getJSONArray("items").getJSONObject(0).getString("title"))
        SystemClock.sleep(900)
        snap("picker-open")
        pickInChrome(picker, EMAIL, "#password", PASSWORD, "pin-prompt-fill-password")
        SystemClock.sleep(600)
        assertEquals(EMAIL, pageString("document.getElementById('email').value"))
        assertEquals(PASSWORD, pageString("document.getElementById('password').value"))
        snap("login-filled")
        pressKey(KeyEvent.KEYCODE_ENTER)
        assertTrue("welcome page after the fill", awaitPath("/welcome", 20_000))
        SystemClock.sleep(2_500)
        assertFalse("no second save prompt for a saved login", textShowing("Save password for"))

        // 3. A checkout typed by hand: the card and the address are offered one after the other.
        tapSelector("button")
        assertTrue("checkout page", awaitPath("/checkout", 20_000))
        SystemClock.sleep(1_500)
        snap("checkout-page")
        tapSelector("#name")
        type(NAME)
        for (value in listOf(STREET, CITY, REGION, ZIP, CARD_NUMBER, CARD_EXPIRY, CARD_CVC, NAME)) {
            pressKey(KeyEvent.KEYCODE_TAB)
            type(value)
        }
        snap("checkout-typed")
        pressKey(KeyEvent.KEYCODE_ENTER)
        assertTrue("thanks page", awaitPath("/thanks", 20_000))
        // The chrome shows the two prompt sheets one after the other (the card's first as the
        // forms script reports it first; either order is accepted here).
        val titles = listOf("Save card?", "Save address?")
        val first = awaitAnyText(titles, 30_000, "pin-prompt-checkout")
            ?: error("neither the card nor the address prompt came up")
        for (title in listOf(first, titles.first { it != first })) {
            val card = title.startsWith("Save card")
            assertTrue("prompt '$title'", awaitText(title, 15_000))
            SystemClock.sleep(1_200)
            snap(if (card) "save-card-prompt" else "save-address-prompt")
            // Each prompt sheet's injected touch: Save, and the entry must be in the vault on it.
            val list = if (card) "autofill.listCards" else "autofill.listAddresses"
            answerPrompt("Save", "the ${if (card) "card" else "address"} is in the vault", "pin-prompt-save-checkout") {
                zenArray(list, JSONObject()).length() == 1
            }
            toast(if (card) "Card saved" else "Address saved")
        }
        snap("checkout-saved")
        val cards = zenArray("autofill.listCards", JSONObject())
        assertEquals("one card: $cards", 1, cards.length())
        assertEquals("4242", cards.getJSONObject(0).getString("last4"))
        assertEquals("visa", cards.getJSONObject(0).getString("network"))
        val addresses = zenArray("autofill.listAddresses", JSONObject())
        assertEquals("one address: $addresses", 1, addresses.length())
        val address = addresses.getJSONObject(0)
        assertEquals("US", address.getString("country"))
        assertEquals(ZIP, address.getString("postalCode"))
        assertEquals(REGION, address.getString("region"))
        note("saved card: ${cards.getJSONObject(0)}")
        note("saved address: $address")

        // 4. Ordering again: the address fills from its strip without a prompt, the card behind
        //    the store's re-authentication (inside the grace period after the PIN, silently).
        tapSelector("header a")
        assertTrue("checkout page again", awaitPath("/checkout", 20_000))
        SystemClock.sleep(1_500)
        tapSelector("#name")
        val addressPicker = awaitPicker("address")
        note("address picker: $addressPicker")
        SystemClock.sleep(900)
        snap("picker-address")
        pickInChrome(addressPicker, NAME, "#street", STREET, "pin-prompt-fill-address")
        SystemClock.sleep(600)
        assertEquals(CITY, pageString("document.getElementById('city').value"))
        assertEquals(ZIP, pageString("document.getElementById('zip').value"))
        snap("address-filled")
        focusSelector("#cardnumber")
        val cardPicker = awaitPicker("card")
        note("card picker: $cardPicker")
        val cardItem = cardPicker.getJSONArray("items").getJSONObject(0)
        assertTrue(cardItem.getString("title").contains("4242"))
        SystemClock.sleep(900)
        snap("picker-card")
        pickInChrome(cardPicker, cardItem.getString("title").substringBefore(' '), "#cardnumber", CARD_NUMBER, "pin-prompt-fill-card")
        SystemClock.sleep(600)
        assertEquals(NAME, pageString("document.getElementById('cardname').value"))
        note("expiry filled as: ${pageString("document.getElementById('expiry').value")}")
        assertEquals("", pageString("document.getElementById('cvc').value"))
        snap("card-filled")

        // 5. Settings > Autofill in the chrome: the Passwords rows (offer to save, sign in
        //    automatically, Zenium as the Android provider, the clipboard clear timeout as a value
        //    row whose sheet picks the time), the address and card managers, the address editor.
        settingsTour()

        // 6. Copies: a username in the clear, a password marked sensitive so the system's
        //    clipboard preview hides it (Android 13+). The preview is SystemUI's own window, which
        //    the screenshot may miss, so the clip's description is what is noted and checked.
        val copyUser = zen("passwords.copy", JSONObject().put("id", login.getString("id")).put("field", "username"))
        assertEquals("copy username: $copyUser", "ok", copyUser.getString("status"))
        SystemClock.sleep(1_800)
        snap("clipboard-username")
        val plainDescription = clipboardDescription()
        note("clipboard after the username: $plainDescription")
        val copyPassword = zen(
            "passwords.copy",
            JSONObject().put("id", login.getString("id")).put("field", "password"),
            promptShot = "pin-prompt-copy"
        )
        assertEquals("copy password: $copyPassword", "ok", copyPassword.getString("status"))
        SystemClock.sleep(1_800)
        snap("clipboard-password-copied")
        val description = clipboardDescription()
        note("clipboard after the password: $description")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            assertTrue("username copy in the clear: $plainDescription", plainDescription.contains("sensitive=false"))
            assertTrue("password copy marked sensitive: $description", description.contains("sensitive=true"))
        }

        // 7. The provider setting: under `system` the page WebViews rejoin the autofill framework.
        zen("settings.update", JSONObject().put("passwords", JSONObject().put("androidProvider", "system")))
        SystemClock.sleep(800)
        val systemImportance = importance()
        note("page WebView importantForAutofill (provider system): $systemImportance")
        note("autofill state under the system provider: ${zen("app.getState").getJSONObject("autofill")}")
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_AUTO, systemImportance)
        zen("settings.update", JSONObject().put("passwords", JSONObject().put("androidProvider", "zenium")))
        SystemClock.sleep(800)
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, importance())

        // 8. The vault document on disk carries the entries as ciphertext only.
        zen("passwords.lock")
        val vault = File(app.filesDir, "zen/passwords.json").takeIf { it.exists() }?.readText() ?: ""
        note("vault document: ${vault.length} characters")
        for (secret in listOf(PASSWORD, CARD_NUMBER, STREET, EMAIL)) {
            assertFalse("plaintext '$secret' in the vault document", vault.contains(secret))
        }
        note("pin prompts answered: $pinPrompts")
        snap("done")
        server.close()
    }

    // --- the chrome's command API ----------------------------------------------------------------

    private fun zen(command: String): JSONObject = zen(command, null)

    /**
     * `window.zen.invoke(command, args)` in the chrome WebView, awaited from here; a system
     * credential prompt that comes up meanwhile is answered with the PIN (photographed as
     * `promptShot` first).
     */
    private fun zen(command: String, args: JSONObject?, promptShot: String? = null): JSONObject {
        val raw = zenRaw(command, args, promptShot)
        return when (val value = JSONTokener(raw).nextValue()) {
            is JSONObject -> value
            JSONObject.NULL, null -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun zenArray(command: String, args: JSONObject?): JSONArray =
        JSONTokener(zenRaw(command, args, null)).nextValue() as JSONArray

    private fun zenRaw(command: String, args: JSONObject?, promptShot: String?): String {
        val argsJs = args?.toString() ?: "undefined"
        chrome(
            """
            window.__afDemo = undefined;
            window.zen.invoke(${JSONObject.quote(command)}, $argsJs).then(
              (v) => { window.__afDemo = JSON.stringify({ ok: v === undefined ? null : v }); },
              (e) => { window.__afDemo = JSON.stringify({ err: String((e && e.message) || e) }); }
            );
            """.trimIndent()
        )
        val deadline = SystemClock.uptimeMillis() + 90_000
        while (SystemClock.uptimeMillis() < deadline) {
            val result = chrome("window.__afDemo === undefined ? null : window.__afDemo")
            if (result != "null") {
                val envelope = JSONObject(JSONTokener(result).nextValue() as String)
                if (envelope.has("err")) error("$command rejected: ${envelope.getString("err")}")
                return envelope.get("ok").toString()
            }
            answerPin(promptShot ?: "pin-prompt-$command")
            SystemClock.sleep(250)
        }
        error("$command did not answer within 90 s")
    }

    /** Evaluate JavaScript in the chrome WebView (main thread) and wait for its JSON result. */
    private fun chrome(script: String): String {
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

    /** The account / address / card picker for `group` in the UI state, once the focus reaches the core. */
    private fun awaitPicker(group: String): JSONObject {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline) {
            val picker = zen("app.getState").getJSONObject("autofill").optJSONObject("picker")
            if (picker != null && picker.getString("group") == group) return picker
            SystemClock.sleep(300)
        }
        error("no $group picker opened")
    }

    // --- the chrome's surfaces: the picker strip, the prompt sheets, Settings ---------------------
    //
    // The rule for the steps below (DemoHarness, the audit after #194): every sequence that
    // presses a control inside one of the chrome's sheets or strips – a prompt sheet's Save, a
    // picker's row, the clipboard picker's option, an item sheet's Edit, the editor's Country
    // menulist and the country sheet's option, an editor's Cancel – puts a REAL finger on it
    // (the harness's [touchTap]: the injected touch waits for the node's bounds to hold still and
    // lands inside the touchable window) and asserts what the control did: the entry in the
    // vault, the fill in the page's field, the setting's new value, the editor holding the entry,
    // the form's lines changed with the country. A touch that went in without its effect is a
    // [touchFault] the run fails on once the recording is done; the step then reaches the state
    // another way where one exists (the command API) so the recording goes on. No fallback stands
    // in silently for a finger inside a sheet. The tree's click stays for one thing only, the
    // Settings tab's own rows – a page's list, not a sheet's – when the WebView reports a row of
    // the scrolled list where it was before the scroll ([pressRow] says so in the notes).

    /**
     * Pick the first row of `picker` the way a user does – a finger on the strip's row in the
     * chrome (the picker's injected touch) – and wait for the fill to land in the page's
     * `selector`, answering the credential prompt the fill may raise on the way. A touch that went
     * in without the fill is a touch fault; the command API then stands in, as it does when the
     * tree exposes no row to touch (noted either way, so the recording says which path it shows).
     */
    private fun pickInChrome(picker: JSONObject, rowPrefix: String, selector: String, expected: String, promptShot: String) {
        val item = picker.getJSONArray("items").getJSONObject(0)
        val group = picker.getString("group")
        val touched = touchText(rowPrefix)
        var filled = touched && awaitValue(selector, expected, promptShot)
        if (touched && !filled) {
            touchFault("the touch on the $group picker's '$rowPrefix' row did not fill $selector")
        }
        if (!filled) {
            val pick = zen(
                "autofill.pick",
                JSONObject().put("id", picker.getString("id")).put("itemId", item.getString("id")),
                promptShot = promptShot
            )
            assertEquals("pick: $pick", "ok", pick.getString("status"))
            filled = awaitValue(selector, expected, promptShot)
        }
        assertTrue("$selector filled after the pick of '$rowPrefix'", filled)
        note(
            "pick of '$rowPrefix': " + when {
                touched && filled -> "the strip's row, touched"
                touched -> "the command API (the touch on the strip's row did not fill: a touch fault)"
                else -> "the command API (the row was not on screen to touch)"
            }
        )
    }

    /**
     * Answer a prompt sheet with a finger on its `label` button (the sheet's injected touch),
     * which must do `effect` within 15 s – `took` holding, the credential prompt on the way
     * answered (`promptShot`). A touch that went in without it is a touch fault; a prompt the core
     * still lists is then answered through the command API so the recording goes on (a touch the
     * scrim took dismissed it already: the assertions after this fail on the missing entry).
     */
    private fun answerPrompt(label: String, effect: String, promptShot: String, took: () -> Boolean) {
        val prompt = zen("app.getState").getJSONObject("autofill").optJSONArray("prompts")?.optJSONObject(0)
        val button = lowestNode(5_000) { node ->
            node.className?.toString() == "android.widget.Button" && node.reads { it.equals(label, ignoreCase = true) }
        } ?: error("no button '$label'")
        if (touchExpecting(button, "the prompt sheet's '$label'", effect, timeoutMs = 15_000, promptShot = promptShot, took = took)) return
        if (prompt == null) return
        val listed = zen("app.getState").getJSONObject("autofill").optJSONArray("prompts")
        val stillUp = (0 until (listed?.length() ?: 0)).any { listed!!.getJSONObject(it).getString("id") == prompt.getString("id") }
        if (!stillUp) return
        note("answering the prompt through the command API so the recording goes on")
        zen(
            "autofill.respond",
            JSONObject().put("id", prompt.getString("id")).put("response", JSONObject().put("action", "save")),
            promptShot = promptShot
        )
        awaitTook(10_000, promptShot, took)
    }

    // --- a finger on the chrome's controls (the rule in DemoHarness) -----------------------------

    /** Whether the node's text or description, trimmed, satisfies `matches`. */
    private fun AccessibilityNodeInfo.reads(matches: (String) -> Boolean): Boolean =
        listOf(text, contentDescription).any { it != null && matches(it.toString().trim()) }

    /**
     * The lowest visible node of the app's own windows that `accept`s and has bounds on screen,
     * polled for up to `timeoutMs`; null when none shows. The lowest, because the chrome's sheets
     * and strips rise from the bottom over what they cover and the tree lists both (a sheet in
     * front of the Settings repeats text the tree still holds behind it); the app's own windows,
     * because the keyboard's suggestion strip may echo what was typed.
     */
    private fun lowestNode(timeoutMs: Long, accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val lowest = nodes { node ->
                node.isVisibleToUser && node.packageName?.toString() == app.packageName && accept(node)
            }
                .map { it to Rect().also(it::getBoundsInScreen) }
                .filter { (_, rect) -> rect.width() > 0 && rect.height() > 0 }
                .maxByOrNull { (_, rect) -> rect.centerY() }
            if (lowest != null) return lowest.first
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /**
     * A real touch (the harness's [touchTap]: once the bounds hold still, inside the touchable
     * window) on the lowest node whose text or description starts with `prefix` – a strip's row,
     * a Settings row, an item sheet's row. False, and nothing injected, when none shows with
     * bounds a finger reaches within the time (noted).
     */
    private fun touchText(prefix: String, timeoutMs: Long = 8_000): Boolean =
        touchNode("'$prefix'", lowestNode(timeoutMs) { it.reads { s -> s.startsWith(prefix) } })

    /** A real touch on `node` (named `what` in the notes); false, and nothing injected, when it is null or out of a finger's reach. */
    private fun touchNode(what: String, node: AccessibilityNodeInfo?): Boolean {
        if (node == null) {
            note("nothing on screen reads $what to touch")
            return false
        }
        if (!touchTap(node)) {
            note("$what has no bounds on screen a finger reaches")
            return false
        }
        SystemClock.sleep(900)
        return true
    }

    /**
     * The shape of a sheet flow's step (the rule in DemoHarness): a real touch on the control
     * reading `label` (its whole label, or with `prefix` the start of its text), then up to
     * `timeoutMs` for `took` to hold – the claim of the step, named by `effect` ("the editor opens
     * on the saved address") – the credential prompt the control may raise on the way answered
     * (`promptShot`). True when it held. False with no touch when nothing reads `label` (noted;
     * the caller may reach the state another way). False with a [touchFault] the run fails on at
     * its end when the touch went in and `took` never held: the surface did not take the finger.
     */
    private fun touchExpecting(
        label: String,
        effect: String,
        timeoutMs: Long = 6_000,
        prefix: Boolean = false,
        promptShot: String = "pin-prompt",
        took: () -> Boolean
    ): Boolean {
        val node = lowestNode(8_000) { node ->
            node.reads { s -> if (prefix) s.startsWith(label) else s.equals(label, ignoreCase = true) }
        }
        return touchExpecting(node, "'$label'", effect, timeoutMs, promptShot, took)
    }

    /** [touchExpecting] on a node found by the caller, named `what` in the notes and the fault. */
    private fun touchExpecting(
        node: AccessibilityNodeInfo?,
        what: String,
        effect: String,
        timeoutMs: Long,
        promptShot: String,
        took: () -> Boolean
    ): Boolean {
        if (!touchNode(what, node)) return false
        if (awaitTook(timeoutMs, promptShot, took)) {
            note("the touch on $what took: $effect")
            return true
        }
        touchFault("the touch on $what did not take: not $effect within $timeoutMs ms")
        return false
    }

    /** Poll `took` for up to `timeoutMs`, answering a credential prompt on the way; its last word. */
    private fun awaitTook(timeoutMs: Long, promptShot: String, took: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) return true
            answerPin(promptShot)
            SystemClock.sleep(300)
        }
        return took()
    }

    /**
     * Press a row of the Settings tab's list – the page's own row, not a sheet's – so that
     * `took` holds (`effect` names it: "the clipboard sheet is up"). Scrolled on screen first
     * (the tree's show-on-screen on the first node reading `prefix`), then the tree's click on
     * its clickable ancestor, and a real touch at its bounds when the click did not take. The
     * click first is the stated exception of the rule in DemoHarness, for the page's list alone:
     * on the emulator the WebView reports a row of the scrolled list where it was before the
     * scroll, and a finger at those bounds lands on the row's neighbour (a switch, here). What
     * the row opens is a sheet, whose controls then take the flow's real finger. The note says
     * which path the press took. False when nothing reads `prefix` or neither press took.
     */
    private fun pressRow(prefix: String, effect: String, took: () -> Boolean): Boolean =
        pressRow("'$prefix'", effect, took) { s -> s.startsWith(prefix) }

    /** [pressRow] for a row whose text `matches` (named `what` in the notes). */
    private fun pressRow(what: String, effect: String, took: () -> Boolean, matches: (String) -> Boolean): Boolean {
        val inApp = { node: AccessibilityNodeInfo ->
            node.packageName?.toString() == app.packageName && node.reads(matches)
        }
        val first = awaitInTree(8_000, inApp)
        if (first == null) {
            note("no Settings row reads $what")
            return false
        }
        first.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        for (match in nodes(inApp)) {
            var node: AccessibilityNodeInfo? = match
            while (node != null && !node.isClickable) node = node.parent
            if (node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                if (awaitTook(6_000, "pin-prompt", took)) {
                    note("the Settings row $what: the tree's click; $effect")
                    return true
                }
                break
            }
        }
        if (touchNode(what, lowestNode(4_000) { it.reads(matches) }) && awaitTook(6_000, "pin-prompt", took)) {
            note("the Settings row $what: touched at its bounds after the tree's click took nothing; $effect")
            return true
        }
        note("the Settings row $what took neither the tree's click nor a touch: not $effect")
        return false
    }

    /**
     * The first node of the app's windows that `accept`s, on screen or not (a heading or a row
     * below the fold is in the tree without bounds a finger reaches), polled for up to
     * `timeoutMs`; null when none arrives. The tree trails a sheet's leaving by a moment, so a
     * heading is waited for this way before [reveal], which looks once.
     */
    private fun awaitInTree(timeoutMs: Long, accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            nodes(accept).firstOrNull()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** [awaitInTree] for a node of the app's reading exactly `label` (a group's heading). */
    private fun awaitInTree(label: String, timeoutMs: Long = 8_000): Boolean =
        awaitInTree(timeoutMs) { node ->
            node.packageName?.toString() == app.packageName && node.reads { it == label }
        } != null

    /** The clipboard clear timeout in the core's settings (`passwords.clipboardClearSeconds`). */
    private fun clipboardClearSeconds(): Int =
        zen("app.getState").getJSONObject("settings").getJSONObject("passwords").optInt("clipboardClearSeconds", -1)

    /**
     * The value of the editor's line labelled `label` (its `<label>`, exactly; the fields' ids
     * are React's, so the field is reached through the label), or null when no such line is up.
     * The editor is the chrome document's, so this is what the tree's lag cannot hide.
     */
    private fun editorLine(label: String): String? {
        val raw = chrome(
            "(() => { const l = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === ${JSONObject.quote(label)}); " +
                "if (!l) return null; const f = document.getElementById(l.htmlFor); return f && 'value' in f ? f.value : null })()"
        )
        if (raw == "null") return null
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
    }

    /** Whether the editor shows a line whose label starts with `label` ("Post town", with or without "(optional)"). */
    private fun editorHas(label: String): Boolean =
        chrome("[...document.querySelectorAll('label')].some(l => l.textContent.trim().startsWith(${JSONObject.quote(label)}))") == "true"

    /**
     * Whether the chrome document has a button reading exactly `label` – a sheet's row ("Edit
     * address", "After 30 seconds") that is not in the document until its sheet is: what says a
     * sheet is up without the tree's lag (a finger sent after a late tree would land on the sheet).
     */
    private fun chromeHasButton(label: String): Boolean =
        chrome("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSONObject.quote(label)})") == "true"

    /** The saved address's country in the vault (the one address of the run). */
    private fun savedAddressCountry(): String? =
        zenArray("autofill.listAddresses", JSONObject()).optJSONObject(0)?.optString("country")

    /** Poll for the page's `selector` to hold `expected`, answering a credential prompt on the way. */
    private fun awaitValue(selector: String, expected: String, promptShot: String, timeoutMs: Long = 40_000): Boolean {
        val script = "document.querySelector(${JSONObject.quote(selector)}).value"
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pageString(script) == expected) return true
            answerPin(promptShot)
            SystemClock.sleep(250)
        }
        note("$selector never held '$expected'; it holds '${pageString(script)}'")
        return false
    }

    /**
     * Settings > Autofill through `autofill.manage`, which opens the Settings tab on its Autofill
     * section (the category's rows are the builder's, `pages/settings/sections.tsx`): the Passwords
     * switch rows; the clipboard choice sheet, whose option under a finger must land in the
     * settings; the Addresses group with its item row, whose sheet's "Edit address" under a
     * finger must open the editor on the saved address (the item sheet leaves first: two sheets
     * deep at most), the editor's Country menulist under a finger must stack the country sheet,
     * whose "United Kingdom" under a finger must re-label the form's lines, and Cancel must leave
     * the vault's address as it was; "Add address" into the empty editor and its Cancel; the
     * Payment methods group with the saved card's row, whose sheet's "Edit card" under a finger
     * must open the editor on the card. Then the tab closes. Each of those touches is the rule in
     * DemoHarness: a touch that went in without its effect is a touch fault the run fails on
     * once the recording is done. The tour's stills are photographed either way; a step whose
     * surface never came up (the tree of the software-rendered emulator trails the screen) is
     * noted and skipped, not fatal.
     */
    private fun settingsTour() {
        // The checkout's field still holds the keyboard: put it away first, or the tab opens
        // squeezed above it and the rows below the fold are tapped through the keys (the run at
        // 69f15f10 landed in the URL bar that way).
        page("document.activeElement && document.activeElement.blur()")
        if (imeShown()) {
            back()
            note("keyboard put away before Settings: ${if (awaitIme(false)) "down" else "still up"}")
        }
        zen("autofill.manage")
        if (!awaitText("Offer to save passwords", 15_000)) {
            note("Settings > Autofill did not show its rows; skipping the tour")
            closeSettings()
            return
        }
        SystemClock.sleep(1_500)
        snap("settings-passwords")

        // The clipboard choice sheet: the row opens it (the page's row), the option under a
        // finger sets the timeout (the sheet's injected touch: 60 s seeded, 30 s picked).
        val before = clipboardClearSeconds()
        note("clipboard clear timeout before the sheet: $before s")
        if (pressRow("Clear copied passwords", "the clipboard sheet is up") { chromeHasButton("After 30 seconds") }) {
            SystemClock.sleep(1_200)
            snap("settings-clipboard-menu")
            val picked = { clipboardClearSeconds() == 30 }
            if (!touchExpecting("After 30 seconds", "the clipboard clear timeout is 30 s in the settings", timeoutMs = 6_000, took = picked) && !picked()) {
                // The fault is on record; the value is set through the tree so the recording goes on.
                if (clickByLabel("After 30 seconds")) note("the option set through the tree's click after the touch fault")
                awaitTook(4_000, "pin-prompt", picked)
            }
            SystemClock.sleep(800)
            note("clipboard clear timeout after the pick: ${clipboardClearSeconds()} s; the row reads 'After 30 seconds': ${rowReads("Clear copied passwords", "After 30 seconds")}")
        } else {
            note("the clipboard sheet was not reached")
        }

        if (awaitInTree("Addresses") && reveal("Addresses") != null) {
            SystemClock.sleep(1_200)
            snap("settings-addresses")
        } else {
            note("the Addresses heading was not in the tree")
        }
        // The saved address's item row opens the sheet about it (the page's row: one node whose
        // text starts with its title, the name; the street is its description further along
        // the same text – run 35428085237 looked for the street and found no such node; the
        // card's row says the same name in its own description, "…, expires 12/29"). Its
        // "Edit address" under a finger closes that sheet for the editor sheet, which must hold
        // the saved address: the item sheet's injected touch.
        var countryToured = false
        val addressRow = { s: String -> s.startsWith(NAME) && !s.contains("expires") }
        if (pressRow("the address '$NAME'", "the saved address's sheet is up", { chromeHasButton("Edit address") }, addressRow)) {
            SystemClock.sleep(1_200)
            snap("settings-address-sheet")
            val editing = { editorLine("Street address") == STREET }
            if (!touchExpecting("Edit address", "the editor opens on the saved address", timeoutMs = 10_000, took = editing) && !editing()) {
                // The fault is on record; the editor is reached through the tree where the sheet
                // is still up (a touch the scrim took dismissed it: nothing to press then).
                if (textShowing("Edit address") && clickByLabel("Edit address")) {
                    note("Edit address pressed through the tree's click after the touch fault")
                    awaitTook(8_000, "pin-prompt", editing)
                }
            }
            if (editing()) {
                SystemClock.sleep(1_200)
                snap("editor-address-saved")
                note("the editor from the item sheet holds the street line '${editorLine("Street address")}', the ${editorLine("City")?.let { "city '$it'" } ?: "no City line"}")
                countryToured = countryTour()
                // Cancel: the editor leaves and the vault keeps the address as it was – still the
                // United States after the form went to the United Kingdom's lines (Save would
                // have written GB).
                val left = { editorLine("Street address") == null && savedAddressCountry() == "US" }
                if (!touchExpecting("Cancel", "the editor is gone and the vault's address is still US", timeoutMs = 8_000, took = left) && !left()) {
                    back()
                    SystemClock.sleep(800)
                }
                note("after Cancel: the vault's address is in ${savedAddressCountry()}, editor up: ${editorLine("Street address") != null}")
            } else {
                note("the editor was not reached from the address sheet")
                if (textShowing("Edit address")) back()
                SystemClock.sleep(800)
            }
        } else {
            note("the saved address's sheet was not reached")
        }

        // "Add address" (the page's row) opens the editor empty; the country flow runs here when
        // the saved address's editor was not reached; Cancel adds nothing to the vault.
        if (pressRow("Add address", "the empty editor is up") { editorLine("Street address") == "" }) {
            SystemClock.sleep(1_200)
            snap("editor-address")
            if (!countryToured) countryToured = countryTour()
            val left = { editorLine("Street address") == null && zenArray("autofill.listAddresses", JSONObject()).length() == 1 }
            if (!touchExpecting("Cancel", "the editor is gone with no address added", timeoutMs = 8_000, took = left) && !left()) {
                back()
                SystemClock.sleep(800)
            }
        } else {
            note("the address editor was not reached from Add address")
        }
        if (!countryToured) note("the Country menulist's flow ran in neither editor")

        // The Payment methods group: the tree trails the editor sheet's leaving by a moment, so
        // the heading is waited for in the tree – below the fold, not on screen yet – before it
        // is revealed (`reveal` looks once; run 35428085237 looked once and found it missing).
        // The saved card's row opens its sheet (the page's row), whose "Edit card" under a
        // finger must open the editor on the card: the card sheet's injected touch.
        if (awaitInTree("Payment methods", 10_000) && reveal("Payment methods") != null) {
            SystemClock.sleep(1_200)
            snap("settings-payment-methods")
            if (pressRow("Visa", "the saved card's sheet is up") { chromeHasButton("Edit card") }) {
                SystemClock.sleep(1_200)
                snap("settings-card-sheet")
                val editing = { editorLine("Name on card") == NAME }
                if (!touchExpecting("Edit card", "the editor opens on the saved card", timeoutMs = 10_000, took = editing) && !editing()) {
                    if (textShowing("Edit card") && clickByLabel("Edit card")) {
                        note("Edit card pressed through the tree's click after the touch fault")
                        awaitTook(8_000, "pin-prompt", editing)
                    }
                }
                if (editing()) {
                    SystemClock.sleep(1_200)
                    snap("editor-card-saved")
                    note("the card editor holds the name '${editorLine("Name on card")}'; the number line is empty for the saved number: '${editorLine("Card number")}'")
                    val left = { editorLine("Name on card") == null }
                    if (!touchExpecting("Cancel", "the card editor is gone", timeoutMs = 8_000, took = left) && !left()) {
                        back()
                        SystemClock.sleep(800)
                    }
                } else {
                    note("the editor was not reached from the card sheet")
                    if (textShowing("Edit card")) back()
                    SystemClock.sleep(800)
                }
            } else {
                note("the saved card's sheet was not reached")
            }
        } else {
            note("the Payment methods heading was not in the tree")
        }
        closeSettings()
    }

    /**
     * The editor's Country menulist under a finger (the editor sheet's injected touch: the
     * button labelled Country, not the line's label above it) must stack the country sheet,
     * which opens scrolled to the current country; "United Kingdom", the row above "United
     * States", under a finger (the country sheet's injected touch) must give the form the
     * United Kingdom's lines – a Post town, a Postal code, no State – with the values kept.
     * True when both took (or the tree stood in after a fault, so the recording goes on); false
     * when the menulist was not there to touch.
     */
    private fun countryTour(): Boolean {
        // The button named Country (its `aria-label`; the tree may run its value after the name),
        // not the line's label above it, which reads the same word.
        val menulist = lowestNode(8_000) { node ->
            node.className?.toString() == "android.widget.Button" && node.reads { it.startsWith("Country") }
        }
        if (menulist == null) {
            note("no Country menulist to touch in the editor")
            return false
        }
        // The sheet is up once its rows are in the chrome document (not the tree, which trails it).
        val sheetUp = { chromeHasButton("United Kingdom") }
        if (!touchExpecting(menulist, "the editor's Country menulist", "the country sheet is up", timeoutMs = 8_000, promptShot = "pin-prompt", took = sheetUp) && !sheetUp()) {
            var node: AccessibilityNodeInfo? = menulist
            while (node != null && !node.isClickable) node = node.parent
            if (node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) note("the Country menulist opened through the tree's click after the touch fault")
            if (!awaitTook(6_000, "pin-prompt", sheetUp)) {
                note("the country sheet never came up")
                return false
            }
        }
        SystemClock.sleep(1_200)
        snap("editor-country-sheet")
        val relabelled = { editorHas("Post town") && editorHas("Postal code") && !editorHas("State") }
        if (!touchExpecting("United Kingdom", "the form has the United Kingdom's lines (Post town, Postal code, no State)", timeoutMs = 8_000, took = relabelled) && !relabelled()) {
            if (clickByLabel("United Kingdom")) note("United Kingdom picked through the tree's click after the touch fault")
            awaitTook(6_000, "pin-prompt", relabelled)
        }
        SystemClock.sleep(1_200)
        snap("editor-address-uk")
        note("the form's lines after the pick: Post town ${editorHas("Post town")}, Postal code ${editorHas("Postal code")}, State ${editorHas("State")}; post town holds '${editorLine("Post town")}'")
        return true
    }

    /**
     * The Settings tab's id while it is the active tab (`zen://settings…`, the internal page the
     * chrome draws in the shown tab's place); null when a site's tab is active.
     */
    private fun settingsTabId(): String? {
        val state = zen("app.getState")
        val spaces = state.optJSONArray("spaces") ?: return null
        val spaceId = state.optString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.optString("id") != spaceId || space.isNull("activeTabId")) continue
            val tabId = space.optString("activeTabId")
            val url = state.optJSONObject("tabs")?.optJSONObject(tabId)?.optString("url") ?: return null
            return if (url.startsWith("zen://settings") || url.startsWith("zenium://settings")) tabId else null
        }
        return null
    }

    /** Close the Settings tab: the system back for a sheet left over it, then the tab itself. */
    private fun closeSettings() {
        for (i in 0 until 3) {
            val tabId = settingsTabId() ?: return
            if (i > 0) back()
            SystemClock.sleep(1_000)
            zen("tab.close", JSONObject().put("tabId", tabId).put("force", true))
            SystemClock.sleep(1_000)
        }
        if (settingsTabId() != null) note("the Settings tab is still the active tab after tab.close and back")
    }

    // --- the page in the shown tab ---------------------------------------------------------------

    private fun shownTab(): TabWebView? =
        (activity as MainActivity).host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page of the shown tab (main thread); the answer is the JSON text of the value. */
    private fun page(script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            val tab = shownTab()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(script) { value ->
                    result = value
                    latch.countDown()
                }
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    private fun pageString(script: String): String? {
        val raw = page(script) ?: return null
        if (raw == "null") return null
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
    }

    private fun currentPath(): String {
        var url = ""
        var progress = 0
        instrumentation.runOnMainSync {
            val tab = shownTab()
            url = tab?.url ?: ""
            progress = tab?.progress ?: 0
        }
        return if (progress == 100) runCatching { java.net.URI(url).path ?: "" }.getOrDefault("") else ""
    }

    private fun awaitPath(path: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (currentPath() == path) {
                SystemClock.sleep(600)
                return true
            }
            answerPin("pin-prompt")
            SystemClock.sleep(250)
        }
        note("still not on $path: ${page("location.href")}")
        return false
    }

    /** Where the first element matching `selector` is on screen (CSS px scaled by the WebView's zoom). */
    @Suppress("DEPRECATION")
    private fun selectorRect(selector: String): Rect? {
        val raw = pageString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();" +
                "return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()"
        ) ?: return null
        val r = JSONObject(raw)
        var scale = density
        val location = IntArray(2)
        instrumentation.runOnMainSync {
            val tab = shownTab() ?: return@runOnMainSync
            scale = tab.scale
            tab.getLocationOnScreen(location)
        }
        return Rect(
            (location[0] + r.getDouble("x") * scale).toInt(),
            (location[1] + r.getDouble("y") * scale).toInt(),
            (location[0] + (r.getDouble("x") + r.getDouble("w")) * scale).toInt(),
            (location[1] + (r.getDouble("y") + r.getDouble("h")) * scale).toInt()
        )
    }

    /** A real touch on the middle of the element (the page scrolls it into the middle first). */
    private fun tapSelector(selector: String) {
        val rect = selectorRect(selector) ?: error("no element for $selector")
        SystemClock.sleep(400)
        val settled = selectorRect(selector) ?: rect
        Finger().tap(settled.exactCenterX(), settled.exactCenterY())
        SystemClock.sleep(900)
    }

    /** Move the page's focus with a script when the element sits under the keyboard. */
    private fun focusSelector(selector: String) {
        page("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(e){e.scrollIntoView({block:'center'});e.focus()}})()")
        SystemClock.sleep(900)
    }

    /**
     * Type into the focused field. A page field is read back once its value has stopped changing
     * and, when that is not the text, selected and typed over again (the f6b2b10a run signed in
     * as "ada.lovelac": the events of one `getEvents` call all carry the time it was made, and
     * on the software-rendered emulator the tail of a long string was injected more than the
     * dispatcher's 10 s after that and dropped as stale – `keys` now stamps each character as it
     * goes). The system's PIN field (`intoPage = false`) cannot be read and is typed once.
     */
    private fun type(text: String, intoPage: Boolean = true) {
        keys(text)
        if (!intoPage) return
        var typed = settledValue()
        for (attempt in 1..2) {
            if (typed == text) return
            note("typed '$text' but the field holds '$typed' (attempt $attempt); typing it again")
            page("(function(){var e=document.activeElement;if(e&&e.select)e.select()})()")
            SystemClock.sleep(400)
            keys(text)
            typed = settledValue()
        }
        note(if (typed == text) "the field holds the text after retyping" else "the field holds '$typed' after retyping '$text'")
    }

    /** The focused page field's value once it has held still for a moment (the keys land late). */
    private fun settledValue(): String? {
        val read = { pageString("(function(){var e=document.activeElement;return e && 'value' in e ? e.value : null})()") }
        var last = read()
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(700)
            val now = read()
            if (now == last) return now
            last = now
        }
        return last
    }

    /** One character's events at a time, so each carries the time it is injected (see [type]). */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
        }
        SystemClock.sleep(200)
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                now, SystemClock.uptimeMillis(), action, keyCode, 0, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
        SystemClock.sleep(300)
    }

    // --- system UI: the credential prompt, the engine's dialogs, the clipboard --------------------

    /**
     * BiometricPrompt falling back to the device credential is a system window (SystemUI, or the
     * Settings app on older builds) with a text field for the PIN.
     */
    private fun credentialPromptShowing(): Boolean = nodes { node ->
        node.packageName?.toString() in CREDENTIAL_PACKAGES && node.className?.toString() == "android.widget.EditText"
    }.isNotEmpty()

    /** Answer a credential prompt that is up right now (photographed as `shotName`); false when none is. */
    private fun answerPin(shotName: String): Boolean {
        if (!credentialPromptShowing()) return false
        SystemClock.sleep(1_200)
        snap(shotName)
        pinPrompts += shotName
        type(PIN, intoPage = false)
        pressKey(KeyEvent.KEYCODE_ENTER)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (credentialPromptShowing() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        note(if (credentialPromptShowing()) "credential prompt still up after the PIN" else "credential accepted ($shotName)")
        SystemClock.sleep(800)
        return true
    }

    private fun textShowing(prefix: String): Boolean = nodes { node ->
        node.isVisibleToUser && listOf(node.text, node.contentDescription).any {
            it?.toString()?.trim()?.startsWith(prefix) == true
        }
    }.isNotEmpty()

    /** Poll for a visible text starting with `prefix`, answering credential prompts on the way. */
    private fun awaitText(prefix: String, timeoutMs: Long, promptShot: String = "pin-prompt"): Boolean =
        awaitAnyText(listOf(prefix), timeoutMs, promptShot) != null

    /** The first of `prefixes` to show (null when none does within the time). */
    private fun awaitAnyText(prefixes: List<String>, timeoutMs: Long, promptShot: String): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            prefixes.firstOrNull { textShowing(it) }?.let { return it }
            answerPin(promptShot)
            SystemClock.sleep(250)
        }
        note("never saw ${prefixes.joinToString(" / ") { "'$it'" }}")
        return null
    }

    /**
     * The chrome's toast is a WebView node the emulator's accessibility tree may only expose after
     * it is gone again, so it is looked for and noted, not asserted.
     */
    private fun toast(text: String) {
        note(if (awaitText(text, 6_000)) "toast '$text' seen" else "toast '$text' not seen in the tree")
    }

    /** Breadth-first search of every window on screen (the app, its dialogs, SystemUI prompts). */
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

    /**
     * The primary clip as the app itself sees it (the instrumentation shares the foreground app's
     * process, so the read is allowed): whether it holds text and whether its description carries
     * the flag that makes the system's clipboard preview hide the value.
     */
    private fun clipboardDescription(): String {
        var description = ""
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(ClipboardManager::class.java)
            val clip = manager?.primaryClipDescription
            description = if (clip == null) "no primary clip" else {
                val sensitive = clip.extras?.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false) ?: false
                "hasText=${manager.hasPrimaryClip()} mime=${clip.getMimeType(0)} sensitive=$sensitive"
            }
        }
        return description
    }

    // --- the host's autofill wiring --------------------------------------------------------------

    private fun importance(): Int {
        var value = -1
        instrumentation.runOnMainSync { value = shownTab()?.importantForAutofill ?: -1 }
        return value
    }

    private fun webAuthnSupport(): String {
        var value = "feature unsupported by this WebView"
        instrumentation.runOnMainSync {
            val tab = shownTab() ?: return@runOnMainSync
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                value = when (WebSettingsCompat.getWebAuthenticationSupport(tab.settings)) {
                    WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP -> "FOR_APP"
                    WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER -> "FOR_BROWSER"
                    else -> "NONE"
                }
            }
        }
        return value
    }

    // --- misc ------------------------------------------------------------------------------------

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }

    /** Logged and kept in `notes.txt` next to the screenshots, rewritten as it grows so a failure keeps it. */
    private fun note(message: String) {
        Log.i(TAG, message)
        notes.append(message).append('\n')
        runCatching { File(out, "notes.txt").writeText(notes.toString()) }
    }

    /** Numbered so the artifact lists the sequence in order. */
    private fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
    }

    /**
     * The demo shop on the loopback interface: four pages and a stylesheet from the instrumentation's
     * assets, a sign-in that redirects to the account page and an order that redirects to its receipt.
     */
    private class DemoServer(private val asset: (String) -> String, port: Int) : Thread("autofill-demo-server") {
        // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses
        // the 127.0.0.1 the page's URL names, so bind the IPv4 loopback explicitly.
        private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        private val pages = mapOf(
            "/login" to asset("autofill/login.html"),
            "/welcome" to asset("autofill/welcome.html"),
            "/checkout" to asset("autofill/checkout.html"),
            "/thanks" to asset("autofill/thanks.html"),
            "/style.css" to asset("autofill/style.css")
        )
        @Volatile private var closed = false

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", socket.localPort).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET /login HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                val status = s.getInputStream().bufferedReader().readLine()
                "listening on ${socket.localSocketAddress}, GET /login -> $status"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET /login failed: $e" }

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
                val input = it.getInputStream().bufferedReader()
                val line = input.readLine() ?: return
                var contentLength = 0
                while (true) {
                    val header = input.readLine()
                    if (header.isNullOrEmpty()) break
                    if (header.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = header.substringAfter(':').trim().toIntOrNull() ?: 0
                    }
                }
                val body = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = input.read(body, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                val parts = line.split(' ')
                val method = parts.getOrNull(0) ?: "GET"
                val path = (parts.getOrNull(1) ?: "/").substringBefore('?')
                val out = it.getOutputStream()
                val redirect = when {
                    method == "POST" && path == "/session" -> "/welcome"
                    method == "POST" && path == "/order" -> "/thanks"
                    path == "/" -> "/login"
                    else -> null
                }
                if (redirect != null) {
                    out.write(
                        ("HTTP/1.1 303 See Other\r\nLocation: $redirect\r\nContent-Length: 0\r\n" +
                            "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                    )
                } else {
                    val content = pages[path]
                    val type = if (path.endsWith(".css")) "text/css; charset=utf-8" else "text/html; charset=utf-8"
                    val bytes = (content ?: "Not found").toByteArray()
                    out.write(
                        ("HTTP/1.1 ${if (content != null) "200 OK" else "404 Not Found"}\r\nContent-Type: $type\r\n" +
                            "Content-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                    )
                    out.write(bytes)
                }
                out.flush()
            }
        }

        fun close() {
            closed = true
            runCatching { socket.close() }
        }
    }

    companion object {
        private const val TAG = "AutofillDemo"
        private const val PORT = 18131
        private const val BASE = "http://127.0.0.1:$PORT"
        private val CREDENTIAL_PACKAGES = setOf("com.android.systemui", "com.android.settings")
        /** Set with `locksettings set-pin` before the app starts. */
        private const val PIN = "1234"
        private const val EMAIL = "ada.lovelace@example.com"
        private const val PASSWORD = "Difference-Engine-1843"
        private const val NAME = "Ada Lovelace"
        private const val STREET = "1600 Amphitheatre Parkway"
        private const val CITY = "Mountain View"
        private const val REGION = "CA"
        private const val ZIP = "94043"
        private const val CARD_NUMBER = "4242424242424242"
        private const val CARD_EXPIRY = "12/29"
        private const val CARD_CVC = "123"
    }
}
