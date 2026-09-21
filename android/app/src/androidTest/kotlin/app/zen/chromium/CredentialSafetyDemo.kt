package app.zen.chromium

import android.graphics.Rect
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The credential-safety UI on a phone (`services-credential-safety` UI PR, ID-31 / ID-34): a
 * fixture sign-in on a demo shop served from the instrumentation, judged against a stand-in for
 * the Pwned Passwords range API on the same server (the host's debug-only `netOriginOverride`,
 * the desktop's `ZEN_NET_ORIGIN`; the real service is never asked), and the password manager's
 * note row.
 *
 * Two sign-ins on the one form. The first, with a password the stand-in lists as clean, is
 * offered for saving in the chrome's prompt sheet – main's chassis, the same `BottomSheet` the
 * warning rides – and saved under a finger: the reference the warning's frames are read against
 * (`save-sheet-open`, `save-sheet-dismiss`). The second, with a password the stand-in lists as
 * breached, raises the leak warning sheet ("Change your password", Chrome's sentence, the
 * account row, the manager link, Ignore and Change password); it is dragged and let go (the
 * sheet settles back), then Ignore is pressed under a finger – the warning leaves and the deferred
 * save prompt rises for the new login, which Save puts in the vault carrying the Ignore memory
 * (`leakIgnoredAt`, the engine PR's `onSaved`). Then the manager, opened from the app menu on a
 * seeded login whose note shows as a static row in the detail and as the multi-line field in the
 * edit view.
 *
 * Frames (the PERFORMANCE constraint, DemoHarness.measureFrames): `save-sheet-open` and
 * `leak-sheet-open` from the Enter that submits the form to the sheet's landing (the sign-in's
 * landing page paints in the same window, on both), `leak-sheet-drag` as a finger-driven
 * gesture, `save-sheet-dismiss` and `leak-sheet-dismiss` as the release springs; the warning's
 * scenes name the save sheet's as their baseline. The `leak-sheet-dismiss` window also holds the
 * save sheet's rise behind it (the chrome sequences the two on the phone).
 *
 * Every control pressed inside a sheet is a real injected finger with an assertion on what it
 * did (the rule in DemoHarness): Save puts the login in the vault, Ignore takes the warning out
 * of the core's state, the login row opens its detail, Edit opens the form with the note. The
 * emulator has no screen lock, so the vault key is the plain hardware-backed one and no credential
 * prompt comes up (VaultKeystore's documented fallback).
 */
@RunWith(AndroidJUnit4::class)
class CredentialSafetyDemo : DemoHarness("credential-safety-demo-state.json", "services-credential-safety-android", "credential-safety-demo") {
    override val tag = TAG
    private var shots = 0
    private var startedAt = 0L
    private lateinit var log: File
    private lateinit var server: DemoServer

    @Test
    fun record() {
        startedAt = SystemClock.uptimeMillis()
        runDemo()
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    // --- off camera ------------------------------------------------------------------------------

    override fun beforeLaunch() {
        log = File(out, LOG_NAME)
        log.writeText("Zenium Android credential safety demo\n\n")
        val routes = HashMap<String, Pair<String, ByteArray>>()
        routes["/login"] = "text/html; charset=utf-8" to readAsset("autofill/login.html").toByteArray()
        routes["/welcome"] = "text/html; charset=utf-8" to readAsset("autofill/welcome.html").toByteArray()
        routes["/style.css"] = "text/css; charset=utf-8" to readAsset("autofill/style.css").toByteArray()
        // The stand-in range API: the breached password's suffix with its count among padding
        // lines for its prefix, padding alone for the clean one; any other prefix is a 404 the
        // core treats as "not checked".
        routes["/range/${prefixOf(BREACHED_PASSWORD)}"] = "text/plain" to rangeAnswer(BREACHED_PASSWORD, BREACH_COUNT).toByteArray()
        routes["/range/${prefixOf(CLEAN_PASSWORD)}"] = "text/plain" to rangeAnswer(CLEAN_PASSWORD, 0).toByteArray()
        server = DemoServer(PORT, routes, redirects = mapOf("/session" to "/welcome")).also { it.start() }
        step("server: ${server.selfCheck()}")
        step("range prefixes: breached ${prefixOf(BREACHED_PASSWORD)} (x$BREACH_COUNT), clean ${prefixOf(CLEAN_PASSWORD)}")
    }

    override fun warmUp() {
        // Every core fetch goes to the demo's server from here on (the leak check's range query).
        instrumentation.runOnMainSync { (activity as MainActivity).host.netOriginOverride = server.origin }
        step("net origin override: ${server.origin}")

        val before = zen("app.getState").getJSONObject("passwords")
        step("status before: $before")
        assertTrue("the Android host must offer a keystore", before.getBoolean("osKeystore"))
        // Create the vault (no screen lock on the emulator: the plain hardware-backed key, no
        // prompt) and seed the login whose note the manager shows; the vault stays open.
        val unlock = zen("passwords.unlock", JSONObject())
        assertEquals("unlock: $unlock", "ok", unlock.getString("status"))
        zen("passwords.add", NOTE_LOGIN)
        assertEquals(1, zenArray("passwords.list", JSONObject()).length())
        val state = zen("app.getState")
        val seeded = state.getJSONObject("passwords")
        step("seeded: $seeded")
        assertFalse("the vault should be open", seeded.getBoolean("locked"))
        val leakDetection = state.getJSONObject("settings").getJSONObject("passwords").optBoolean("leakDetection", true)
        step("settings.passwords.leakDetection = $leakDetection")
        assertTrue("leak detection should be on by default", leakDetection)

        if (!awaitPath("/login", 25_000)) {
            step("the seeded tab did not load the login page; opening it")
            openLink("$BASE/login")
            assertTrue("login page", awaitPath("/login", 25_000))
        }
        SystemClock.sleep(1_500)
        val close = closeUrlField()
        step("URL field: ${close.describe()}")
        if (!close.ok) step("warm-up: ${close.describe()}")
    }

    // --- on camera -------------------------------------------------------------------------------

    override fun demo() {
        val f = Finger()
        snap("login-page")

        // 1. The reference: a clean sign-in, its save sheet up and answered on main's chassis.
        signIn(CLEAN_EMAIL, CLEAN_PASSWORD)
        snap("clean-credentials-typed")
        measureFrames("save-sheet-open", JankBudget.Kind.OPEN) {
            pressKey(KeyEvent.KEYCODE_ENTER)
            waitForLabelPrefix("Save password for", 30_000)
            SystemClock.sleep(MOTION_MS)
        }
        assertTrue("welcome page after the clean sign-in", awaitPath("/welcome", 10_000))
        assertNotNull("the save prompt for the clean sign-in", findByLabelPrefix("Save password for"))
        assertTrue("no warning for a clean password", leaks().length() == 0)
        SystemClock.sleep(600)
        snap("save-sheet-clean")
        val saveButton = buttonNode("Save") ?: error("no Save button on the save sheet")
        measureFrames("save-sheet-dismiss", JankBudget.Kind.SPRING) {
            touchTap(saveButton)
            SystemClock.sleep(MOTION_MS)
        }
        assertTrue(
            "Save under a finger: the clean login is in the vault",
            awaitCondition(10_000) { loginFor(CLEAN_EMAIL) != null }
        )
        val clean = loginFor(CLEAN_EMAIL)!!
        step("clean login saved: breached=${clean.opt("breached")} checkedAt=${clean.opt("checkedAt")} leakIgnoredAt=${clean.opt("leakIgnoredAt")}")
        SystemClock.sleep(800)

        // 2. Back to the form, in the same tab, for the breached sign-in.
        page("location.assign('/login')")
        assertTrue("login page again", awaitPath("/login", 20_000))
        SystemClock.sleep(1_200)
        signIn(BREACHED_EMAIL, BREACHED_PASSWORD)
        snap("breached-credentials-typed")

        // 3. The warning rises over the landing page's picture: Chrome's words, the account row,
        //    the manager link, Ignore and Change password.
        measureFrames("leak-sheet-open", JankBudget.Kind.OPEN, baseline = "save-sheet-open") {
            pressKey(KeyEvent.KEYCODE_ENTER)
            waitFor(LEAK_TITLE, 30_000)
            SystemClock.sleep(MOTION_MS)
        }
        assertTrue("welcome page after the breached sign-in", awaitPath("/welcome", 10_000))
        val warning = leaks().optJSONObject(0) ?: error("no leak warning in the core's state")
        step("leak warning: $warning")
        assertEquals(BREACHED_EMAIL, warning.getString("username"))
        assertNotNull("the title", findByLabel(LEAK_TITLE))
        assertNotNull("Ignore", buttonNode("Ignore"))
        assertNotNull("Change password", buttonNode("Change password"))
        // The rest of the composition, as the tree lists it (the WebView may run a paragraph's
        // text together with its link's): on record, not asserted.
        step("sentence in the tree: ${findByLabelPrefix("The password you just used") != null}; account row: ${findByLabel(BREACHED_EMAIL) != null}; manager link: ${findByLabel("password manager") != null}")
        // The save prompt waits behind the warning (the chrome sequences the two on the phone).
        assertTrue("the save prompt waits behind the warning", findByLabelPrefix("Save password for") == null)
        SystemClock.sleep(600)
        snap("leak-sheet")

        // 4. A finger on the sheet: down and back, let go at rest – the sheet settles where it was.
        val grip = findByLabel("Dismiss") ?: findByLabel(LEAK_TITLE) ?: error("nothing to drag the sheet by")
        val gripX = grip.exactCenterX()
        val gripY = grip.exactCenterY()
        measureFrames("leak-sheet-drag", JankBudget.Kind.GESTURE) {
            f.down(gripX, gripY)
            f.moveBy(0f, DRAG_PX * density, 380)
            f.hold(180)
            f.moveBy(0f, -DRAG_PX * density, 380)
            f.hold(120)
            f.up()
            SystemClock.sleep(1_400)
        }
        assertNotNull("the warning stays up after the drag", waitFor("Ignore", 5_000))
        assertEquals("the warning is still the core's", 1, leaks().length())
        snap("leak-sheet-after-drag")

        // 5. Ignore under a finger: the warning leaves the core's state; the save prompt rises
        //    behind it for the new login.
        val ignore = buttonNode("Ignore") ?: error("no Ignore button")
        measureFrames("leak-sheet-dismiss", JankBudget.Kind.SPRING, baseline = "save-sheet-dismiss") {
            touchTap(ignore)
            SystemClock.sleep(MOTION_MS)
        }
        assertTrue("Ignore under a finger: the warning left the core's state", awaitCondition(8_000) { leaks().length() == 0 })
        assertTrue("the deferred save prompt rises", waitForLabelPrefix("Save password for", 15_000) != null)
        SystemClock.sleep(600)
        snap("save-sheet-after-ignore")
        val saveAgain = buttonNode("Save") ?: error("no Save button on the second save sheet")
        touchTap(saveAgain)
        assertTrue(
            "Save under a finger: the breached login is in the vault",
            awaitCondition(10_000) { loginFor(BREACHED_EMAIL) != null }
        )
        val breached = loginFor(BREACHED_EMAIL)!!
        step("breached login saved: breached=${breached.opt("breached")} leakWarnedAt=${breached.opt("leakWarnedAt")} leakIgnoredAt=${breached.opt("leakIgnoredAt")}")
        assertTrue("the saved login carries the breach count", breached.optInt("breached", 0) > 0)
        assertTrue("the saved login remembers the Ignore", !breached.isNull("leakIgnoredAt"))
        assertTrue("the save sheet leaves", waitForGone("Save password for", 8_000))
        SystemClock.sleep(900)
        snap("welcome-after-save")

        // 6. The manager from the app menu: the seeded login's detail shows the note as a static
        //    row, and Edit opens the form with the note field.
        step("opening the app menu")
        ensureForeground()
        if (!tapLabel(f, MENU_LABEL)) error("no menu button")
        if (waitFor(MENU_HANDLE_LABEL, 8_000) == null) error("the menu never opened")
        SystemClock.sleep(1_200)
        expandSheet(f)
        openMenuRow("Passwords")
        assertNotNull("the manager opens on its list (the vault is open)", waitFor("Add login", 10_000))
        SystemClock.sleep(900)
        snap("manager-list")
        openLogin(f, NOTE_USERNAME)
        // The tree may run the row's label and value together ("Notes Work account; …").
        val noteStart = NOTE_TEXT.substring(0, 24)
        assertTrue("the note row shows the note", awaitCondition(6_000) { findNode { it.contains(noteStart) } != null })
        SystemClock.sleep(700)
        snap("login-detail-note")
        assertTrue(
            "Edit under a finger: the form opens with the note",
            touchTapLabelExpecting("Edit", "the edit form with the note field") { formNote() == NOTE_TEXT }
        )
        SystemClock.sleep(900)
        snap("login-edit-note")
        step("the form's note field holds ${formNote()?.length ?: 0} characters")

        // 7. Back pops the pane; the manager closes on the header's control.
        back()
        waitFor("Add login", 6_000)
        SystemClock.sleep(700)
        tapLabel(f, CLOSE_LABEL)
        waitForGone(CLOSE_LABEL, 6_000)
        SystemClock.sleep(900)
        snap("browser-after")

        File(out, "logins.json").writeText(zenArray("passwords.list", JSONObject()).toString(2))
        File(out, "server-hits.txt").writeText(
            listOf("/login", "/session", "/welcome", "/range/${prefixOf(CLEAN_PASSWORD)}", "/range/${prefixOf(BREACHED_PASSWORD)}")
                .joinToString("\n") { "$it ${server.hits(it)}" } + "\n"
        )
        step("range requests: clean ${server.hits("/range/${prefixOf(CLEAN_PASSWORD)}")}, breached ${server.hits("/range/${prefixOf(BREACHED_PASSWORD)}")}")
        assertTrue("the breached password's range was asked for", server.hits("/range/${prefixOf(BREACHED_PASSWORD)}") >= 1)
        server.close()
    }

    // --- the sign-in form ------------------------------------------------------------------------

    /** Type the two fields with real keys; the submit is the caller's (measured). */
    private fun signIn(email: String, password: String) {
        tapSelector("#email")
        type(email)
        pressKey(KeyEvent.KEYCODE_TAB)
        type(password)
    }

    /** The core's leak warnings (`UIState.passwords.leaks`). */
    private fun leaks(): JSONArray =
        zen("app.getState").optJSONObject("passwords")?.optJSONArray("leaks") ?: JSONArray()

    private fun loginFor(username: String): JSONObject? {
        val list = zenArray("passwords.list", JSONObject())
        for (i in 0 until list.length()) {
            val login = list.getJSONObject(i)
            if (login.optString("username") == username) return login
        }
        return null
    }

    /** The Notes textarea's value in the manager's edit form, once it is up. */
    private fun formNote(): String? {
        val raw = chromeJs(
            "(function(){var t=document.querySelector('[data-passwords-form] textarea, form textarea, textarea');" +
                "return t?t.value:null})()"
        )
        if (raw.isEmpty() || raw == "null") return null
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
    }

    private fun awaitCondition(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(250)
        }
        return condition()
    }

    // --- the chrome's controls -------------------------------------------------------------------

    /** The lowest button reading `label` (the sheet on top is the lowest surface). */
    private fun buttonNode(label: String): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        val found = ArrayList<AccessibilityNodeInfo>()
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val text = (node.contentDescription ?: node.text)?.toString()?.trim()
            if (node.className?.toString() == "android.widget.Button" && text.equals(label, ignoreCase = true)) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it) }
        }
        return found.maxByOrNull { Rect().also(it::getBoundsInScreen).centerY() }
    }

    private fun waitForLabelPrefix(prefix: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findByLabelPrefix(prefix)?.let { return it }
            SystemClock.sleep(200)
        }
        return findByLabelPrefix(prefix)
    }

    /** Fling the menu sheet's handle up so the whole menu is on screen. */
    private fun expandSheet(f: Finger) {
        val grip = findByLabel(MENU_HANDLE_LABEL) ?: return
        f.down(width / 2f, grip.exactCenterY())
        f.moveBy(0f, -0.4f * height, 130)
        f.up()
        SystemClock.sleep(1_600)
    }

    /**
     * A finger on a menu row (the menu flow's injected touch), and the manager must come up on
     * it: else a touch fault the run fails on at its end, and the tree's click is the way on so
     * the recording goes on.
     */
    private fun openMenuRow(label: String) {
        if (reveal(label) != null && touchTapLabel(label)) {
            if (waitFor(CLOSE_LABEL, 6_000) != null) return
            touchFault("the touch on the menu's '$label' row did not open the manager")
            step("the tap on the '$label' row did not open the manager; clicking it through accessibility")
        }
        if (!clickByLabel(label)) error("no menu row '$label'")
        if (waitFor(CLOSE_LABEL, 10_000) == null) error("the manager never opened")
    }

    /** A finger on a login's row (named after its username), and the detail pane must open on it. */
    private fun openLogin(f: Finger, username: String) {
        step("opening the login $username")
        val row = waitForLabelPrefix(username, 8_000) ?: error("no row for $username")
        SystemClock.sleep(400)
        f.tap(row.exactCenterX(), row.exactCenterY())
        if (waitFor("Show password", 6_000) != null) return
        touchFault("the touch on the '$username' row did not open its detail")
        step("the tap on the row did not open the detail; clicking it through accessibility")
        clickByLabel(username)
        if (waitFor("Show password", 6_000) == null) error("the detail for $username never opened")
    }

    // --- the page --------------------------------------------------------------------------------

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
            SystemClock.sleep(250)
        }
        step("still not on $path: ${page("location.href")}")
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

    /**
     * Type into the focused page field, read back once its value holds still and typed over
     * again when it is not the text (AutofillDemo's lesson: the emulator drops late keys).
     */
    private fun type(text: String) {
        keys(text)
        var typed = settledValue()
        for (attempt in 1..2) {
            if (typed == text) return
            step("typed '$text' but the field holds '$typed' (attempt $attempt); typing it again")
            page("(function(){var e=document.activeElement;if(e&&e.select)e.select()})()")
            SystemClock.sleep(400)
            keys(text)
            typed = settledValue()
        }
        step(if (typed == text) "the field holds the text after retyping" else "the field holds '$typed' after retyping '$text'")
    }

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

    /** One character's events at a time, so each carries the time it is injected. */
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

    // --- the chrome's bridge ---------------------------------------------------------------------

    private fun zen(command: String, args: JSONObject? = null): JSONObject {
        val raw = coreInvoke(command, args?.toString() ?: "null")
        return when (val value = JSONTokener(raw).nextValue()) {
            is JSONObject -> value
            JSONObject.NULL, null -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun zenArray(command: String, args: JSONObject?): JSONArray =
        JSONTokener(coreInvoke(command, args?.toString() ?: "null")).nextValue() as JSONArray

    // --- the record ------------------------------------------------------------------------------

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
        private const val TAG = "CredentialSafetyDemo"
        private const val LOG_NAME = "services-credential-safety-android-steps.txt"
        private val THEME = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        private const val PORT = 18141
        private const val BASE = "http://127.0.0.1:$PORT"
        private const val CLOSE_LABEL = "Close (Esc)"
        /** Chrome's title (`lib/credentialLeak.ts`). */
        private const val LEAK_TITLE = "Change your password"
        private const val CLEAN_EMAIL = "ada.lovelace@example.com"
        private const val CLEAN_PASSWORD = "Difference-Engine-1843"
        private const val BREACHED_EMAIL = "ada.byron@example.com"
        /** The stand-in lists it as breached this many times (the preview host's sample too). */
        private const val BREACHED_PASSWORD = "correct-horse-battery"
        private const val BREACH_COUNT = 27_314
        private const val NOTE_USERNAME = "grace.hopper"
        private const val NOTE_TEXT = "Work account; the second factor is the authenticator app. Recovery codes are in the office safe."
        private val NOTE_LOGIN: JSONObject = JSONObject()
            .put("url", "https://forum.example.org/")
            .put("username", NOTE_USERNAME)
            .put("password", "qN7#vLp2!xR9wZ4kT1bS")
            .put("notes", NOTE_TEXT)
        /** How far the finger takes the warning's sheet down before bringing it back (dp). */
        private const val DRAG_PX = 72f
        /** A wait past the spring's landing costs the reading nothing (a frame nothing moves in is no frame). */
        private const val MOTION_MS = 1_800L

        private fun sha1Hex(text: String): String =
            MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02X".format(it) }

        /** The five hex characters the core sends (`HIBP_RANGE_URL<prefix>`). */
        fun prefixOf(password: String): String = sha1Hex(password).substring(0, 5)

        /**
         * A range answer: the password's suffix with `count` when it is over zero, among padding
         * lines with a count of 0 (the shape HIBP's `Add-Padding` answers have), sorted as the
         * service sorts them.
         */
        fun rangeAnswer(password: String, count: Int): String {
            val lines = ArrayList<String>()
            if (count > 0) lines += "${sha1Hex(password).substring(5)}:$count"
            for (i in 1..12) lines += i.toString(16).uppercase().padStart(35, 'A') + ":0"
            return lines.sorted().joinToString("\r\n")
        }
    }
}
