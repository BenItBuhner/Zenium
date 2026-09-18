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
 * plaintext) and writes what it observes (system autofill status, WebAuthn support, clipboard
 * descriptions, which surfaces the tree exposed) next to the screenshots. The Settings tour is
 * photographed, not asserted: the tree of the software-rendered emulator trails the screen.
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
        tapButton("Save")
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
            tapButton("Save")
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

    /**
     * Pick the first row of `picker` the way a user does – a tap on the strip's row in the chrome –
     * and wait for the fill to land in the page's `selector`, answering the credential prompt the
     * fill may raise on the way. The command API stands in when the tree does not expose the row
     * (noted, so the recording says which path it shows).
     */
    private fun pickInChrome(picker: JSONObject, rowPrefix: String, selector: String, expected: String, promptShot: String) {
        val item = picker.getJSONArray("items").getJSONObject(0)
        val tapped = tapText(rowPrefix)
        if (!tapped) {
            val pick = zen(
                "autofill.pick",
                JSONObject().put("id", picker.getString("id")).put("itemId", item.getString("id")),
                promptShot = promptShot
            )
            assertEquals("pick: $pick", "ok", pick.getString("status"))
        }
        assertTrue("$selector filled after the pick of '$rowPrefix'", awaitValue(selector, expected, promptShot))
        note("pick of '$rowPrefix': ${if (tapped) "the strip's row, tapped" else "the command API (the row was not in the tree)"}")
    }

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
     * A real touch on the lowest visible node whose text or description starts with `prefix` (a
     * row of the picker's strip, a Settings row, a sheet's button – a sheet in front of the
     * Settings repeats text the tree still lists behind it), or the accessibility click on its
     * clickable ancestor when the tree reports no usable bounds; false when nothing shows within
     * the time.
     */
    private fun tapText(prefix: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            // The app's own windows only: the keyboard's suggestion strip may echo what was typed.
            val matches = nodes { node ->
                node.isVisibleToUser && node.packageName?.toString() == app.packageName &&
                    listOf(node.text, node.contentDescription).any {
                        it?.toString()?.trim()?.startsWith(prefix) == true
                    }
            }
            // The lowest match on screen: the chrome's sheets and strips rise from the bottom
            // over what they cover, and the tree does not know one hides the other.
            val rect = matches.map { Rect().also(it::getBoundsInScreen) }
                .filter { it.width() > 0 && it.height() > 0 }
                .maxByOrNull { it.centerY() }
            if (rect != null) {
                Finger().tap(rect.exactCenterX(), rect.exactCenterY())
                SystemClock.sleep(900)
                return true
            }
            for (match in matches) {
                var node: AccessibilityNodeInfo? = match
                while (node != null && !node.isClickable) node = node.parent
                if (node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    SystemClock.sleep(900)
                    return true
                }
            }
            if (SystemClock.uptimeMillis() >= deadline) {
                note("nothing on screen starts with '$prefix'")
                return false
            }
            SystemClock.sleep(300)
        }
    }

    /**
     * Settings > Autofill through `autofill.manage`: the Passwords rows, the clipboard menu sheet
     * (its pick lands in the settings), the Addresses group, the address editor sheet, the Payment
     * methods group; then the panel closes. Photographed and noted, never fatal: the tree of the
     * software-rendered emulator trails the screen by seconds after each transition.
     */
    private fun settingsTour() {
        zen("autofill.manage")
        if (!awaitText("Offer to save passwords", 15_000)) {
            note("Settings > Autofill did not show its rows; skipping the tour")
            closeSettings()
            return
        }
        SystemClock.sleep(1_500)
        snap("settings-passwords")
        if (tapText("Clear copied passwords") && awaitText("After 30 seconds", 6_000)) {
            SystemClock.sleep(1_200)
            snap("settings-clipboard-menu")
            tapText("After 30 seconds")
            SystemClock.sleep(800)
            val seconds = zen("app.getState").getJSONObject("settings").getJSONObject("passwords").opt("clipboardClearSeconds")
            note("clipboard clear timeout after the pick of 30 seconds: $seconds")
        } else {
            note("the clipboard menu sheet was not reached")
        }
        if (reveal("Addresses") != null) {
            SystemClock.sleep(1_200)
            snap("settings-addresses")
        } else {
            note("the Addresses heading was not in the tree")
        }
        if (tapText("Add address") && awaitText("Country", 6_000)) {
            SystemClock.sleep(1_200)
            snap("editor-address")
            tapText("Cancel")
            SystemClock.sleep(800)
        } else {
            note("the address editor was not reached")
        }
        if (reveal("Payment methods") != null) {
            SystemClock.sleep(1_200)
            snap("settings-payment-methods")
        } else {
            note("the Payment methods heading was not in the tree")
        }
        closeSettings()
    }

    /** Close the Settings panel: its close button, then the system back for anything left over it. */
    private fun closeSettings() {
        val open = { chrome("!!document.querySelector('.zen-settings')") == "true" }
        if (open()) tapText("Close (Esc)", 3_000)
        for (i in 0 until 3) {
            SystemClock.sleep(1_000)
            if (!open()) return
            back()
        }
        note("Settings still open after the close button and back")
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

    private fun type(text: String) {
        val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())
            ?: error("no key events for '$text'")
        for (event in events) {
            ui.injectInputEvent(event, true)
            SystemClock.sleep(25)
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
        type(PIN)
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

    /** Tap a dialog button by its text (a Material button may report it in capitals). */
    private fun tapButton(label: String) {
        val rect = waitForNode(label, 5_000, role = "android.widget.Button") ?: error("no button '$label'")
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(900)
    }

    private fun waitForNode(label: String, timeoutMs: Long, role: String? = null): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            findLabelled(label, role)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** Bounds of the innermost visible node whose text, description or hint is `label`, case ignored. */
    private fun findLabelled(label: String, role: String? = null): Rect? = nodes { node ->
        if (role != null && node.className?.toString() != role) return@nodes false
        if (!node.isVisibleToUser) return@nodes false
        listOf(node.text, node.contentDescription, node.hintText).any {
            it?.toString()?.trim().equals(label, ignoreCase = true)
        }
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .filter { it.width() > 0 && it.height() > 0 }
        .minByOrNull { it.width() * it.height() }

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
