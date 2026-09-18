package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.security.KeyChain
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL
import kotlin.math.max

/**
 * Records the pop-up blocker (the chip and its sheet), the external-app prompt (tel: and an
 * intent:// with a fallback), the HTTP sign-in dialog with its retry and the client-certificate
 * chooser on an emulator, for a caller of the reusable `android-emulator-demo` workflow. Only
 * asserts that it could run through the sequence; the recording and the screenshots show what
 * the chrome did.
 *
 * The caller hosts the server in `assets/services-hardening-demo-server.mjs` on the runner (the
 * emulator reaches it as 10.0.2.2:8787): `/popups` opens a window by itself 1.5 s after loading
 * (reporting "The automatic pop-up was blocked." or "The pop-up opened by itself.") and has a
 * button "Open a pop-up (with a tap)"; `/apps` navigates to a `tel:` URL by itself after 1.5 s
 * and links to "Call +1 555 0100" (`tel:`) and "Scan a barcode (intent:// with a fallback)", an
 * `intent://` for an app that is not installed whose `browser_fallback_url` is a page on the same
 * server headed "No app took the intent"; `/protected` answers 401 with a Basic challenge unless
 * signed in as zenium / secret, then shows "Signed in as zenium"; `/client.p12` is a demo key
 * pair (password "zenium", alias "Zenium demo") the driver puts into the system credential store
 * so the chooser has something to list. The certificate request itself comes from
 * client.badssl.com, a public site with a trusted certificate of its own that asks every visitor
 * for one (the WebView would not reach the request behind a self-signed server certificate, which
 * Zenium never proceeds past); the demo pair's issuer carries that site's acceptable-CA name so
 * the system chooser, which filters by it, lists the pair, and the site refuses the pair it did
 * not issue with a 400 of its own once it is sent.
 *
 * Handshake with the workflow (files under the app's `files/services-hardening-demo/`), as in
 * GestureDemo: `record` once the warm-up is done, wait for `recording`, `done` at the end.
 */
@RunWith(AndroidJUnit4::class)
class ServicesHardeningDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "services-hardening-demo")
    private lateinit var activity: Activity
    private var width = 0
    private var height = 0
    private val log = StringBuilder()

    @Test
    fun record() {
        val info = ui.serviceInfo
        info.flags = info.flags or
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        ui.serviceInfo = info

        seedProfile()
        launch()
        measure()
        handshake()
        try {
            demo()
        } finally {
            File(out, "steps.txt").writeText(log.toString())
            File(out, "done").writeText("done\n")
        }
        SystemClock.sleep(3_000)
        Log.i(TAG, "done")
    }

    // --- setup -----------------------------------------------------------------------------------

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.deleteRecursively() }
        instrumentation.context.assets.open("services-hardening-demo-state.json").use { input ->
            File(zen, "state.json").outputStream().use { input.copyTo(it) }
        }
        out.deleteRecursively()
        out.mkdirs()
    }

    private fun launch() {
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)
            ?: error("no launcher activity for ${app.packageName}")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent)
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    /** Opens `url` in the running app the way a link from another app would (a new active tab). */
    private fun openInApp(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .setPackage(app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        step("opened $url")
    }

    private fun ensureForeground() {
        repeat(5) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            Log.w(TAG, "window of $top is in front; sending back")
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(1_000)
        }
    }

    private fun measure() {
        ensureForeground()
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            width = root.width
            height = root.height
        }
        if (width == 0 || height == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            width = probe.width
            height = probe.height
            probe.recycle()
        }
        step("window ${width}x$height")
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(TAG, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(1_000)
    }

    // --- sequence --------------------------------------------------------------------------------

    private fun demo() {
        val f = Finger()

        // 1. The page opened a pop-up on its own: blocked. With the chrome's chip (the UI branch)
        //    the chip says so and its sheet offers Open; without it (the engine branch) the page's
        //    own text says so and a tap on the page's button opens one, as a gesture allows.
        waitFor("The automatic pop-up was blocked.", 12_000)
        if (waitFor("Pop-up blocked", 3_000, prefix = true)) {
            SystemClock.sleep(800)
            shot("01-popup-blocked-chip")
            tapLabel(f, "Pop-up blocked", prefix = true)
            waitFor("Blocked Pop-ups", 5_000)
            SystemClock.sleep(1_200)
            shot("02-popup-blocked-sheet")
            tapLabel(f, "Open")
            SystemClock.sleep(4_000)
            shot("03-popup-opened-deliberately")
        } else {
            shot("01-popup-blocked-page")
            tapLabel(f, "Open a pop-up (with a tap)")
            SystemClock.sleep(4_000)
            shot("03-popup-opened-with-a-tap")
        }

        // 2. Links to other apps (the external-protocol sheet): the page's own tel: launch on
        //    load never dials, it asks; a tapped tel: link asks and names the app; an intent://
        //    link whose app is not installed asks (the scheme is not one the manifest can see)
        //    and, opened, lands on its fallback page.
        openInApp("http://$SERVER/apps")
        waitFor("Call +1 555 0100", 12_000)
        if (waitFor("Not now", 6_000)) {
            SystemClock.sleep(800)
            shot("04-app-launch-on-load-asks")
            answerSheet(f, "Not now")
        } else {
            ensureForeground()
            shot("04-app-launch-on-load-no-handler")
        }
        SystemClock.sleep(1_500)
        tapLabel(f, "Call +1 555 0100")
        if (waitFor("Not now", 6_000)) {
            SystemClock.sleep(800)
            shot("06-tel-launch-prompt")
            answerSheet(f, "Not now")
        } else {
            shot("06-tel-launch-no-handler")
        }
        SystemClock.sleep(1_500)
        tapLabel(f, "Scan a barcode (intent:// with a fallback)")
        if (waitFor("Not now", 6_000)) {
            SystemClock.sleep(800)
            shot("07-intent-launch-prompt")
            answerSheet(f, "Open")
        }
        waitFor("No app took the intent", 12_000)
        SystemClock.sleep(1_500)
        ensureForeground()
        shot("08-intent-fallback-page")

        // 3. HTTP sign-in: the dialog, a wrong password (asked again, with the notice), then the
        //    right one. The form is submitted from the password field with Enter, the way a user
        //    would with the soft keyboard up (it covers the dialog's buttons).
        openInApp("http://$SERVER/protected")
        waitFor("Sign in", 12_000)
        SystemClock.sleep(1_200)
        shot("09-http-auth-dialog")
        fill(f, "Username", "zenium")
        fill(f, "Password", "wrong")
        submitSignIn()
        waitFor("The username or password was not accepted. Please try again.", 10_000)
        SystemClock.sleep(1_200)
        shot("10-http-auth-retry")
        fill(f, "Password", "secret")
        submitSignIn()
        waitFor("Signed in as zenium", 15_000)
        SystemClock.sleep(1_500)
        shot("11-http-auth-signed-in")

        // 4. Client certificate: a demo key pair goes into the system credential store first
        //    (the system installer's own dialogs), then a site that asks for a certificate brings
        //    up the system KeyChain chooser through Zenium, which never sends one unasked. Picking
        //    the pair sends it and the site, which did not issue it, refuses it with a page of its
        //    own; with nothing to pick, Deny sends nothing and the site says so.
        val installed = installDemoCertificate(f)
        openInApp(CERT_SITE)
        if (waitForAny(listOf("Choose certificate", "No certificates found", CERT_NAME), 30_000)) {
            SystemClock.sleep(1_200)
            shot("13-certificate-chooser")
            // The system dialog's buttons read in capitals (SELECT, DENY), and so does their
            // accessible text.
            if (installed && tapLabel(f, CERT_NAME)) {
                SystemClock.sleep(1_000)
                shot("14-certificate-chooser-picked")
                tapLabel(f, "Select", ignoreCase = true)
                waitFor("The SSL certificate error", 20_000)
            } else {
                val refusal = if (findByLabel("Deny", ignoreCase = true) != null) "Deny" else "Cancel"
                val refused = tapLabel(f, refusal, ignoreCase = true)
                if (!refused) ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                waitFor("No required SSL certificate was sent", 20_000)
            }
            SystemClock.sleep(1_500)
            shot("15-certificate-site-answer")
        } else {
            shot("13-certificate-chooser-missing")
        }
    }

    /** Send the system installer away should one of its dialogs still be up. */
    private fun leaveInstaller() {
        repeat(2) {
            if (ui.rootInActiveWindow?.packageName?.toString() != INSTALLER) return
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(800)
        }
    }

    /**
     * Put the demo key pair into the system credential store through the system installer's
     * dialogs, so the chooser has a certificate to list. Best effort: the chooser comes up either
     * way, with nothing to choose when this did not go through.
     */
    private fun installDemoCertificate(f: Finger): Boolean {
        val pkcs12 = runCatching { URL("http://$SERVER/client.p12").readBytes() }.getOrElse {
            step("no demo key pair to install: $it")
            return false
        }
        val intent = KeyChain.createInstallIntent()
            .putExtra(KeyChain.EXTRA_PKCS12, pkcs12)
            .putExtra(KeyChain.EXTRA_NAME, CERT_NAME)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        step("asked the system to install the demo key pair")
        // The installer's dialogs in turn, each answered by its OK: the extraction password (a
        // password field), the certificate type (radios, "VPN & app user certificate" preselected,
        // no field) and the name (a plain field, filled in from the intent). Which come, and in
        // what order, differs between Android versions; the loop answers whichever is up until
        // Zenium's own window has been back in front for a moment. A tap the emulator dropped
        // leaves the same dialog up, and it is answered again.
        var passwordGiven = false
        var passwordTaps = 0
        var lastAnswer = 0L
        var homeFor = 0
        val deadline = SystemClock.uptimeMillis() + 45_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(400)
            val root = ui.rootInActiveWindow ?: continue
            when (root.packageName?.toString()) {
                app.packageName -> {
                    if (passwordGiven && ++homeFor >= 5) {
                        step("the demo key pair is installed")
                        return true
                    }
                    continue
                }
                INSTALLER -> homeFor = 0
                else -> continue
            }
            if (SystemClock.uptimeMillis() - lastAnswer < 1_500) continue
            val fields = editables(root)
            val password = fields.firstOrNull { it.isPassword }
            val name = fields.firstOrNull { !it.isPassword }
            when {
                password != null && passwordTaps >= 3 -> {
                    step("the installer refused the password")
                    leaveInstaller()
                    return false
                }
                password != null -> {
                    if (!passwordGiven) {
                        step("the installer asks for the extraction password")
                        SystemClock.sleep(600)
                        setEditable(password, CERT_PASSWORD)
                        SystemClock.sleep(400)
                        shot("12-certificate-install")
                        passwordGiven = true
                    } else {
                        step("the password dialog is still up; pressing OK again")
                        if ((password.text?.length ?: 0) != CERT_PASSWORD.length) setEditable(password, CERT_PASSWORD)
                    }
                    tapLabel(f, "OK")
                    passwordTaps++
                }
                name != null -> {
                    step("the installer asks for the name")
                    if (name.text?.toString() != CERT_NAME) setEditable(name, CERT_NAME)
                    SystemClock.sleep(300)
                    tapLabel(f, "OK")
                }
                findByLabel("OK") != null -> {
                    step("the installer asks for the certificate type; taking its default")
                    tapLabel(f, "OK")
                }
                else -> continue
            }
            lastAnswer = SystemClock.uptimeMillis()
        }
        step("the certificate installer is still up")
        leaveInstaller()
        return false
    }

    private fun setEditable(field: AccessibilityNodeInfo, text: String) {
        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        SystemClock.sleep(200)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun waitForAny(labels: List<String>, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val seen = labels.firstOrNull { findByLabel(it) != null }
            if (seen != null) {
                step("saw '$seen'")
                return true
            }
            SystemClock.sleep(250)
        }
        step("never saw any of $labels within ${timeoutMs}ms")
        return false
    }

    /**
     * Press the dialog's Sign in button through its accessibility action, which lands once and
     * reaches the button under the soft keyboard should it be up. (Enter from the password field
     * with a press as the fallback sent the answer twice: the dialog the refused answer brought
     * back was taken for the one still waiting, and the retry shot caught the change-over.)
     * Enter is the fallback for a tree that does not have the button yet.
     */
    private fun submitSignIn() {
        SystemClock.sleep(600)
        val button = findNodes("Sign in").firstOrNull { it.isClickable }
        if (button != null && button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            step("pressed Sign in")
            return
        }
        pressKey(KeyEvent.KEYCODE_ENTER)
        step("no Sign in button to press; submitted with Enter")
    }

    /**
     * Put `text` into the field named `label` (the input's accessible name is its label's text).
     * The value is set through the accessibility action, which lands whole; a lagging emulator
     * drops injected keystrokes, so typing is only the fallback, and either way the field is read
     * back before moving on.
     */
    private fun fill(f: Finger, label: String, text: String) {
        // The dialog has one password field and one plain field; with the labels not exposed
        // (the tree is mid-update), the field is told by kind.
        val field = findNodes(label).firstOrNull { it.isEditable }
            ?: findNodes(label).firstNotNullOfOrNull { editableWithin(it) }
            ?: ui.rootInActiveWindow?.let(::editables)?.firstOrNull { it.isPassword == (label == "Password") }
        if (field == null) {
            step("no field labelled '$label'")
            return
        }
        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        SystemClock.sleep(300)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val set = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        SystemClock.sleep(500)
        if (set && holds(label, text)) {
            step("filled '$label'")
            return
        }
        step("setText on '$label' ${if (set) "did not land" else "was refused"}; typing instead")
        val bounds = Rect().also(field::getBoundsInScreen)
        for (attempt in 1..3) {
            f.tap(bounds.exactCenterX(), bounds.exactCenterY())
            SystemClock.sleep(700)
            pressKey(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)
            SystemClock.sleep(150)
            type(text)
            SystemClock.sleep(600)
            if (holds(label, text)) break
            step("typing into '$label' lost characters (attempt $attempt)")
        }
        step("filled '$label'")
    }

    /** Whether the field named `label` holds `text` (a password field reports it masked). */
    private fun holds(label: String, text: String): Boolean {
        val field = findNodes(label).firstOrNull { it.isEditable }
            ?: ui.rootInActiveWindow?.let(::editables)?.firstOrNull { it.isPassword == (label == "Password") }
            ?: return false
        val value = field.text?.toString() ?: return false
        return value == text || (field.isPassword && value.length == text.length)
    }

    private fun editableWithin(node: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        editables(node).firstOrNull()

    private fun editables(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<AccessibilityNodeInfo>()
        queue.add(node)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val n = queue.removeFirst()
            visited++
            if (n.isEditable) found += n
            for (i in 0 until n.childCount) n.getChild(i)?.let(queue::add)
        }
        return found
    }

    /**
     * Answer the external-app sheet. A lagging emulator drops a tap now and then; the sheet
     * still being up says so, and the tap is repeated. The tree going away for a moment (the
     * active window changing hands) is not the sheet closing; another window in front is sent
     * back first. The last resort for a refusal is the back gesture, which the sheet answers.
     */
    private fun answerSheet(f: Finger, label: String) {
        for (attempt in 1..3) {
            if (!tapLabel(f, label)) return
            val deadline = SystemClock.uptimeMillis() + 3_000
            var gone = false
            while (SystemClock.uptimeMillis() < deadline) {
                SystemClock.sleep(250)
                val root = ui.rootInActiveWindow ?: continue
                if (root.packageName?.toString() != app.packageName) {
                    step("the window of ${root.packageName} came in front; sending it back")
                    ensureForeground()
                    continue
                }
                if (findByLabel("Not now") == null) {
                    gone = true
                    break
                }
            }
            if (gone) return
            step("the sheet is still up after '$label' (attempt $attempt)")
        }
        if (label == "Not now") {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            step("sent back to close the sheet")
            SystemClock.sleep(1_000)
        }
    }

    private fun type(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        val events = map.getEvents(text.toCharArray()) ?: run {
            step("no key events for '$text'")
            return
        }
        for (event in events) {
            ui.injectInputEvent(event, true)
            SystemClock.sleep(25)
        }
    }

    private fun pressKey(keyCode: Int, metaState: Int = 0) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                now, SystemClock.uptimeMillis(), action, keyCode, 0, metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
    }

    private fun waitFor(label: String, timeoutMs: Long, prefix: Boolean = false): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label, prefix) != null) {
                step("saw '$label'")
                return true
            }
            SystemClock.sleep(250)
        }
        step("never saw '$label' within ${timeoutMs}ms")
        return false
    }

    /**
     * Tap the node labelled `label` once it has come to rest (a sheet still sliding in reports
     * bounds a frame behind), inside its bounds but clear of the system navigation bar along
     * the bottom edge, which would take the tap instead.
     */
    private fun tapLabel(
        f: Finger,
        label: String,
        prefix: Boolean = false,
        ignoreCase: Boolean = false
    ): Boolean {
        var target = findByLabel(label, prefix, ignoreCase) ?: run {
            step("no node labelled '$label'")
            return false
        }
        val settleBy = SystemClock.uptimeMillis() + 2_000
        while (SystemClock.uptimeMillis() < settleBy) {
            SystemClock.sleep(150)
            val again = findByLabel(label, prefix, ignoreCase) ?: break
            if (again == target) break
            target = again
        }
        val x = target.exactCenterX()
        val lowest = height - NAV_BAR_MARGIN
        val y = if (target.exactCenterY() > lowest) {
            max(target.top + 8f, lowest.toFloat())
        } else {
            target.exactCenterY()
        }
        f.tap(x, y)
        step("tapped '$label' at $target (${x.toInt()},${y.toInt()})")
        return true
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "services-hardening-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
        step("shot $name")
    }

    private fun step(message: String) {
        Log.i(TAG, message)
        log.append(SystemClock.uptimeMillis()).append(' ').append(message).append('\n')
    }

    private fun findByLabel(label: String, prefix: Boolean = false, ignoreCase: Boolean = false): Rect? =
        findAllByLabel(label, prefix, ignoreCase).firstOrNull()

    /**
     * Breadth-first search of the active window for nodes labelled `label` (aria-label or text).
     * With `prefix`, a node whose text starts with the label and a space matches as well: a button
     * made of several spans ("Pop-up blocked" and "Show") is one node with their texts joined.
     * With `ignoreCase`, a system button whose text is shown, and read, in capitals matches too.
     */
    private fun findAllByLabel(label: String, prefix: Boolean = false, ignoreCase: Boolean = false): List<Rect> =
        findNodes(label, prefix, ignoreCase).map { node -> Rect().also(node::getBoundsInScreen) }

    private fun findNodes(
        label: String,
        prefix: Boolean = false,
        ignoreCase: Boolean = false
    ): List<AccessibilityNodeInfo> {
        // The root is briefly unavailable while the active window changes; that is not "gone".
        var root = ui.rootInActiveWindow
        var tries = 0
        while (root == null && tries++ < 4) {
            SystemClock.sleep(100)
            root = ui.rootInActiveWindow
        }
        if (root == null) return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        val matches = { text: CharSequence? ->
            text != null && (
                text.toString().equals(label, ignoreCase) ||
                    (prefix && text.toString().startsWith("$label ", ignoreCase))
                )
        }
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            if (matches(node.contentDescription) || matches(node.text)) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /** One finger; moves are interpolated and injected in real time (see GestureDemo). */
    private inner class Finger {
        private var downTime = 0L
        private var x = 0f
        private var y = 0f

        fun down(x: Float, y: Float) {
            this.x = x
            this.y = y
            downTime = SystemClock.uptimeMillis()
            inject(MotionEvent.ACTION_DOWN, downTime)
        }

        fun moveBy(dx: Float, dy: Float, durationMs: Long) {
            val fromX = x
            val fromY = y
            val toX = x + dx
            val toY = y + dy
            val steps = max(1L, durationMs / STEP_MS)
            val start = SystemClock.uptimeMillis()
            for (i in 1..steps) {
                val due = start + (durationMs * i) / steps
                val now = SystemClock.uptimeMillis()
                if (due > now) SystemClock.sleep(due - now)
                val t = i.toFloat() / steps
                x = fromX + (toX - fromX) * t
                y = fromY + (toY - fromY) * t
                inject(MotionEvent.ACTION_MOVE, SystemClock.uptimeMillis())
            }
        }

        fun hold(ms: Long) = SystemClock.sleep(ms)

        fun up() = inject(MotionEvent.ACTION_UP, SystemClock.uptimeMillis())

        fun tap(x: Float, y: Float) {
            down(x, y)
            hold(60)
            up()
        }

        private fun inject(action: Int, eventTime: Long) {
            val properties = MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
            val coords = MotionEvent.PointerCoords().apply {
                x = this@Finger.x
                y = this@Finger.y
                pressure = 1f
                size = 1f
            }
            val event = MotionEvent.obtain(
                downTime, eventTime, action, 1, arrayOf(properties), arrayOf(coords),
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0
            )
            try {
                ui.injectInputEvent(event, false)
            } finally {
                event.recycle()
            }
        }
    }

    companion object {
        private const val TAG = "ServicesHardeningDemo"
        private const val PILL_LABEL = "Address"
        private const val SERVER = "10.0.2.2:8787"
        /** Asks every visitor for a client certificate; answers 400 to none and to one it did not issue. */
        private const val CERT_SITE = "https://client.badssl.com/"
        private const val CERT_NAME = "Zenium demo"
        private const val CERT_PASSWORD = "zenium"
        private const val INSTALLER = "com.android.certinstaller"
        private const val STEP_MS = 8L
        /** The 3-button navigation bar's height on the runner's emulator, with room to spare. */
        private const val NAV_BAR_MARGIN = 100
    }
}
