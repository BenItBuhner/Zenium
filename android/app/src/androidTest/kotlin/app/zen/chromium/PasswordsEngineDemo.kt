package app.zen.chromium

import android.content.ContentValues
import android.graphics.Rect
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
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
 * Exercises the password engine on a phone with a device PIN, so the temporary
 * `android-services-passwords-engine` workflow can record it on an emulator. The engine PR has no
 * manager surface, so the vault is driven through the chrome's command API (`window.zen.invoke`,
 * the same calls the manager UI makes) from the chrome WebView, and the recording shows what the
 * engine puts on screen itself: the system credential prompt behind the Keystore-bound vault key
 * and behind a reveal, and the document picker for the CSV export and import.
 *
 * Asserts the engine's answers (a login round-trips, the reveal returns the stored secret after
 * the PIN, the export names a file, the import counts its rows, lock and unlock keep the data);
 * the workflow then checks the exported file and that the vault document holds no plaintext.
 */
@RunWith(AndroidJUnit4::class)
class PasswordsEngineDemo : DemoHarness("passwords-demo-state.json", "services-passwords-android", "passwords-demo") {
    override val tag = TAG
    private var shots = 0
    private val added = ArrayList<JSONObject>()

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        publishSampleCsv()
        SystemClock.sleep(2_000)
    }

    override fun demo() {
        val before = zen("app.getState").getJSONObject("passwords")
        Log.i(TAG, "status before: $before")
        assertTrue("the Android host must offer a keystore", before.getBoolean("osKeystore"))
        assertTrue("the Android host must offer re-authentication", before.getBoolean("osReauth"))
        snap("browser-idle")

        // 1. Create the vault. The Keystore key is authentication-bound; whether the PIN set by the
        //    workflow still counts as a fresh authentication decides if the prompt shows here.
        val unlock = zen("passwords.unlock", JSONObject(), onPrompt = { snap("pin-prompt-create-vault") })
        assertEquals("unlock: $unlock", "ok", unlock.getString("status"))
        val created = zen("app.getState").getJSONObject("passwords")
        Log.i(TAG, "status after create: $created")
        assertTrue("vault should be unlocked", !created.getBoolean("locked"))
        assertTrue("vault should be OS-protected", created.getJSONObject("protection").getBoolean("os"))

        // 2. Save three logins through the command API and read them back.
        for ((url, username, password) in LOGINS) {
            added += zen(
                "passwords.add",
                JSONObject().put("url", url).put("username", username).put("password", password)
            )
        }
        var list = zenArray("passwords.list", JSONObject())
        Log.i(TAG, "list: $list")
        assertEquals(LOGINS.size, list.length())
        val bank = added.first { it.getString("domain") == "bank.example" }

        // 3. Lock and open again: the wrapped data key comes back from the Keystore (still within
        //    its authentication validity, so silently).
        zen("passwords.lock")
        assertTrue(zen("app.getState").getJSONObject("passwords").getBoolean("locked"))
        val reopen = zen("passwords.unlock", JSONObject(), onPrompt = { snap("pin-prompt-reopen") })
        assertEquals("reopen: $reopen", "ok", reopen.getString("status"))
        list = zenArray("passwords.list", JSONObject())
        assertEquals(LOGINS.size, list.length())

        // 4. Reveal a password: re-authentication through BiometricPrompt, which falls back to the
        //    device PIN on an emulator without biometrics.
        val reveal = zen(
            "passwords.reveal",
            JSONObject().put("id", bank.getString("id")),
            onPrompt = { snap("pin-prompt-reveal") }
        )
        Log.i(TAG, "reveal: ${reveal.getString("status")}")
        assertEquals("reveal: $reveal", "ok", reveal.getString("status"))
        assertEquals(LOGINS.first { it.first.contains("bank.example") }.third, reveal.getString("value"))

        // 5. Inside the grace period a copy needs no second prompt.
        val copy = zen("passwords.copy", JSONObject().put("id", bank.getString("id")).put("field", "password"))
        assertEquals("copy: $copy", "ok", copy.getString("status"))

        // 6. A generated password follows the site's published rules when it has some.
        val generated = zen(
            "passwords.generate",
            JSONObject()
                .put(
                    "options",
                    JSONObject()
                        .put("mode", "password").put("length", 20)
                        .put("upper", true).put("lower", true).put("digits", true).put("symbols", true)
                        .put("words", 4).put("separator", "-").put("capitalize", false).put("includeDigit", false)
                )
                .put("domain", "example.com")
        )
        Log.i(TAG, "generated ${generated.getString("password").length} characters, rules ${generated.opt("rules")}")
        assertTrue(generated.getString("password").length >= 16)

        // 7. Export through the system create-document picker (still inside the grace period).
        val export = zen("passwords.export", JSONObject(), onPicker = { saveDocument() })
        Log.i(TAG, "export: $export")
        assertEquals("export: $export", "ok", export.getString("status"))
        val exported = export.getJSONObject("value")
        assertEquals(LOGINS.size, exported.getInt("count"))
        assertTrue("the picker should have produced a file: $exported", !exported.isNull("path"))
        File(out, "exported-name.txt").writeText(exported.getString("path"))

        // 8. Import the sample CSV through the open-document picker; one row duplicates a saved login.
        val import = zen("passwords.import", JSONObject().put("conflict", "skip"), onPicker = { pickDocument(CSV_NAME) })
        Log.i(TAG, "import: $import")
        assertEquals("chrome", import.getString("format"))
        assertEquals(4, import.getInt("added"))
        assertEquals(1, import.getInt("skipped"))
        list = zenArray("passwords.list", JSONObject())
        assertEquals(LOGINS.size + 4, list.length())

        // 9. Delete and restore.
        zen("passwords.remove", JSONObject().put("id", bank.getString("id")))
        assertEquals(LOGINS.size + 3, zenArray("passwords.list", JSONObject()).length())
        val restored = zenRaw("passwords.restore", JSONObject().put("id", bank.getString("id")))
        assertEquals("true", restored)
        assertEquals(LOGINS.size + 4, zenArray("passwords.list", JSONObject()).length())

        // 10. The checkup (HIBP range queries, strength, reuse); the network on the runner decides
        //     whether the compromised count is real, so it is logged, not asserted.
        zen("passwords.checkupRun")
        val deadline = SystemClock.uptimeMillis() + 90_000
        var checkup = JSONObject()
        while (SystemClock.uptimeMillis() < deadline) {
            checkup = zen("app.getState").getJSONObject("passwords").getJSONObject("checkup")
            if (!checkup.getBoolean("running") && (!checkup.isNull("finishedAt") || !checkup.isNull("error"))) break
            SystemClock.sleep(1_000)
        }
        Log.i(TAG, "checkup: $checkup")
        File(out, "checkup.json").writeText(checkup.toString(2))

        zen("passwords.lock")
        snap("browser-after")
    }

    // --- the chrome's command API ----------------------------------------------------------------

    private fun zen(command: String): JSONObject = zen(command, null)

    /**
     * `window.zen.invoke(command, args)` in the chrome WebView, awaited from here. While the call is
     * pending the system credential prompt is answered with the PIN (and `onPrompt` runs once it is
     * up), and a document picker is handed to `onPicker`.
     */
    private fun zen(
        command: String,
        args: JSONObject?,
        onPrompt: () -> Unit = {},
        onPicker: () -> Boolean = { false }
    ): JSONObject {
        val raw = zenRaw(command, args, onPrompt, onPicker)
        return when (val value = JSONTokener(raw).nextValue()) {
            is JSONObject -> value
            JSONObject.NULL, null -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun zenArray(command: String, args: JSONObject?): JSONArray =
        JSONTokener(zenRaw(command, args)).nextValue() as JSONArray

    private fun zenRaw(
        command: String,
        args: JSONObject?,
        onPrompt: () -> Unit = {},
        onPicker: () -> Boolean = { false }
    ): String {
        val argsJs = args?.toString() ?: "undefined"
        eval(
            """
            window.__pwDemo = undefined;
            window.zen.invoke(${JSONObject.quote(command)}, $argsJs).then(
              (v) => { window.__pwDemo = JSON.stringify({ ok: v === undefined ? null : v }); },
              (e) => { window.__pwDemo = JSON.stringify({ err: String((e && e.message) || e) }); }
            );
            """.trimIndent()
        )
        var prompted = false
        var picked = false
        val deadline = SystemClock.uptimeMillis() + 120_000
        while (SystemClock.uptimeMillis() < deadline) {
            val result = eval("window.__pwDemo === undefined ? null : window.__pwDemo")
            if (result != "null") {
                val envelope = JSONObject(JSONTokener(result).nextValue() as String)
                if (envelope.has("err")) error("$command rejected: ${envelope.getString("err")}")
                return envelope.get("ok").toString()
            }
            if (!prompted && credentialPromptShowing()) {
                prompted = true
                SystemClock.sleep(1_200)
                onPrompt()
                enterPin()
            } else if (!picked && documentPickerShowing()) {
                picked = true
                SystemClock.sleep(1_500)
                if (!onPicker()) Log.w(TAG, "a document picker is up that $command did not expect")
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

    // --- system UI: credential prompt and document picker ----------------------------------------

    /**
     * BiometricPrompt falling back to the device credential is a system window (SystemUI, or the
     * Settings app on older builds) with a text field for the PIN.
     */
    private fun credentialPromptShowing(): Boolean = nodes { node ->
        node.packageName?.toString() in CREDENTIAL_PACKAGES && node.className?.toString() == "android.widget.EditText"
    }.isNotEmpty()

    private fun enterPin() {
        typeText(PIN)
        SystemClock.sleep(300)
        pressKey(KeyEvent.KEYCODE_ENTER)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (credentialPromptShowing() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        Log.i(TAG, if (credentialPromptShowing()) "credential prompt still up" else "credential accepted")
        SystemClock.sleep(800)
    }

    private fun documentPickerShowing(): Boolean = nodes { node ->
        node.packageName?.toString() in PICKER_PACKAGES
    }.isNotEmpty()

    /**
     * In the create-document picker, accept the suggested name in the current folder (moving to
     * the Downloads root first when the picker opened somewhere nothing can be saved).
     */
    private fun saveDocument(): Boolean {
        var save = waitForNode("Save", 10_000, role = "android.widget.Button") ?: return false
        if (!saveEnabled()) {
            val roots = findLabelled("Show roots") ?: return false
            tapRect(roots)
            if (waitForNode("Downloads", 5_000) == null) return false
            tapRect(waitForNode("Downloads", 5_000) ?: return false)
            save = waitForNode("Save", 5_000, role = "android.widget.Button") ?: return false
        }
        SystemClock.sleep(900)
        snap("export-save-picker")
        tapRect(save)
        return true
    }

    private fun saveEnabled(): Boolean = nodes { node ->
        node.className?.toString() == "android.widget.Button" && node.text?.toString()?.trim() == "Save" && node.isEnabled
    }.isNotEmpty()

    /** In the open-document picker, tap `name` (opening the Downloads root if Recents lacks it). */
    private fun pickDocument(name: String): Boolean {
        if (waitForNode(name, 8_000) == null) {
            val roots = findLabelled("Show roots") ?: return false
            tapRect(roots)
            if (waitForNode("Downloads", 5_000) == null) return false
            tapRect(waitForNode("Downloads", 5_000) ?: return false)
            if (waitForNode(name, 8_000) == null) return false
        }
        SystemClock.sleep(900)
        snap("import-open-picker")
        tapRect(waitForNode(name, 3_000) ?: return false)
        return true
    }

    /** A Chrome-style CSV in the shared Downloads collection, where the picker lists it. */
    private fun publishSampleCsv() {
        val resolver = instrumentation.context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, CSV_NAME)
            put(MediaStore.Downloads.MIME_TYPE, "text/csv")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            Log.w(TAG, "could not publish the sample CSV")
            return
        }
        resolver.openOutputStream(uri)?.use { it.write(SAMPLE_CSV.toByteArray()) }
        Log.i(TAG, "sample CSV at $uri")
    }

    // --- finding, tapping, typing (across every window on screen) --------------------------------

    private fun tapRect(rect: Rect) {
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(700)
    }

    private fun waitForNode(label: String, timeoutMs: Long, role: String? = null): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            findLabelled(label, role)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** Bounds of the innermost visible node whose text, description or hint is `label`. */
    private fun findLabelled(label: String, role: String? = null): Rect? = nodes { node ->
        if (role != null && node.className?.toString() != role) return@nodes false
        if (!node.isVisibleToUser) return@nodes false
        listOf(node.text, node.contentDescription, node.hintText).any { it?.toString()?.trim() == label }
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .filter { it.width() > 0 && it.height() > 0 }
        .minByOrNull { it.width() * it.height() }

    /** Breadth-first search of every window on screen (the app, the picker, SystemUI prompts). */
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
    }

    companion object {
        private const val TAG = "PasswordsEngineDemo"
        private val CREDENTIAL_PACKAGES = setOf("com.android.systemui", "com.android.settings")
        private val PICKER_PACKAGES = setOf("com.android.documentsui", "com.google.android.documentsui")
        /** Set by the workflow with `locksettings set-pin` before the driver starts. */
        private const val PIN = "1234"
        private const val CSV_NAME = "zenium-sample-passwords.csv"
        private val LOGINS = listOf(
            Triple("https://accounts.example.com/login", "ada.lovelace@example.com", "Tr0ub4dor&3-demo"),
            Triple("https://bank.example/login", "ada.lovelace@example.com", "correct horse battery staple"),
            Triple("https://forum.example.org/", "ada", "qN7#vLp2!xR9wZ4kT1bS")
        )
        /** Five rows; the bank row repeats a saved login so the `skip` conflict mode has something to skip. */
        private val SAMPLE_CSV = """
            name,url,username,password,note
            Example Bank,https://bank.example/login,ada.lovelace@example.com,correct horse battery staple,Sample data for the demo
            Example Bank,https://bank.example/login,grace.hopper@example.com,123456,
            Shop,https://shop.example.net/account,ada.lovelace@example.com,password123,
            Mail,https://mail.example.com/,ada.lovelace@example.com,Tr0ub4dor&3-demo,Reused on purpose
            News,https://news.example.org/,ada,letmein2024,
        """.trimIndent() + "\n"
    }
}
