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
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL
import kotlin.math.max

/**
 * Records the pop-up blocker (the chip and its sheet), the external-app prompt (tel: and an
 * intent:// with a fallback), the HTTP sign-in dialog with its retry, the client-certificate
 * chooser and Settings › Security in the Settings tab (a remembered answer, its sheet, Forget
 * this answer) on an emulator, for a caller of the reusable `android-emulator-demo` workflow.
 * Asserts that it could run through the sequence and what the fingers it puts inside the sheets
 * did (the rule in DemoHarness: the blocked pop-ups sheet's Open and its allow switch bring the
 * pop-up's page up, the external-app sheet's Open lands on the fallback page, the sign-in
 * dialog's field takes the focus, the answer sheet's Forget this answer empties the section);
 * the recording and the screenshots show the rest of what the chrome did.
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
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
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
        if (touchFaults.isNotEmpty()) {
            throw AssertionError("${touchFaults.size} touch(es) did not take: ${touchFaults.joinToString("; ")}")
        }
    }

    /** The touches inside a sheet that did not take; [record] fails on them once the recording is done. */
    private val touchFaults = ArrayList<String>()

    private fun touchFault(message: String) {
        step("TOUCH FAULT: $message")
        Log.e(TAG, "TOUCH FAULT: $message")
        touchFaults += message
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
            waitFor("Blocked pop-ups", 5_000)
            awaitSettled()
            shot("02-popup-blocked-sheet")
            // The sheet's injected touch (the rule in DemoHarness): Open under a finger, and the
            // pop-up's page must come up in a tab of its own on it – a touch that fell through
            // to the scrim takes the sheet down with nothing opened.
            val pressed = tapLabel(f, "Open")
            if (!waitFor("Opened deliberately", 8_000) && pressed) {
                touchFault("the touch on the blocked pop-ups sheet's Open took the sheet down but opened no pop-up page")
            }
            SystemClock.sleep(1_500)
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
        // The page's tree goes with its view once the sheet covers it: either is the page loaded.
        waitForAny(listOf("Call +1 555 0100", "Not now"), 12_000)
        if (waitFor("Not now", 6_000)) {
            awaitSettled()
            shot("04-app-launch-on-load-asks")
            answerSheet(f, "Not now")
        } else {
            ensureForeground()
            shot("04-app-launch-on-load-no-handler")
        }
        SystemClock.sleep(1_500)
        tapLabel(f, "Call +1 555 0100")
        if (waitFor("Not now", 6_000)) {
            awaitSettled()
            shot("06-tel-launch-prompt")
            answerSheet(f, "Not now")
        } else {
            shot("06-tel-launch-no-handler")
        }
        SystemClock.sleep(1_500)
        tapLabel(f, "Scan a barcode (intent:// with a fallback)")
        var opened = false
        if (waitFor("Not now", 6_000)) {
            awaitSettled()
            shot("07-intent-launch-prompt")
            // The external-app sheet's injected touch (the rule in DemoHarness): Open under a
            // finger, and the intent's fallback page must come up on it – a touch that fell
            // through to the scrim takes the sheet down with nothing opened.
            opened = answerSheet(f, "Open")
        }
        if (!waitFor("No app took the intent", 12_000) && opened) {
            touchFault("the touch on the external-app sheet's Open took the sheet down but brought no fallback page")
        }
        SystemClock.sleep(1_500)
        ensureForeground()
        shot("08-intent-fallback-page")

        // 3. HTTP sign-in: the dialog, a wrong password (asked again, with the validation line
        //    under the password field, which is cleared and focused), then the right one. While
        //    the credentials are tried the form is busy (§9.30): its fields go read-only, which
        //    takes the keyboard down; the refusal's focus brings it back up and the sheet lifts
        //    the form above it again, which the emulator takes a moment over.
        openInApp("http://$SERVER/protected")
        waitFor("Sign in", 12_000)
        awaitSettled()
        shot("09-http-auth-dialog")
        // The dialog's injected touch (the rule in DemoHarness): a finger on the Password field
        // must move the focus to it (the sheet opens with the focus on a control that is not a
        // text field, §9.22, so a touch the scrim took would leave the field without it). The
        // values then land through the accessibility action – a lagging emulator drops
        // keystrokes – and Sign in goes by its accessibility action: the soft keyboard covers
        // the dialog's buttons, where no finger reaches them.
        touchField(f, "Password")
        fill(f, "Username", "zenium")
        fill(f, "Password", "wrong")
        submitSignIn(RETRY_MESSAGE, 10_000)
        awaitAboveKeyboard(RETRY_MESSAGE)
        shot("10-http-auth-retry")
        fill(f, "Password", "secret")
        submitSignIn("Signed in as zenium", 15_000)
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

        // 5. Settings › Security on the phone: the `security` category of the Settings tab (the
        //    rows this program adds to its builder). A remembered answer first – the site allowed
        //    to open pop-ups through the switch row of the blocked pop-ups sheet on a fresh load
        //    of /popups, which opens the blocked page in a tab of its own – then the section by
        //    its deep link, the answer's row, its sheet, and Forget this answer taking it back.
        ensureForeground()
        openInApp("http://$SERVER/popups")
        waitFor("The automatic pop-up was blocked.", 12_000)
        if (waitFor("Pop-up blocked", 3_000, prefix = true)) {
            SystemClock.sleep(800)
            tapLabel(f, "Pop-up blocked", prefix = true)
            waitFor("Blocked pop-ups", 5_000)
            awaitSettled()
            // The sheet's injected touch (the rule in DemoHarness): the allow switch under a
            // finger, and allowing opens what was blocked – the pop-up's page must come up in a
            // tab of its own on it; a touch that fell through to the scrim takes the sheet down
            // and remembers nothing, and Settings › Security would have no answer to show.
            val allowed = tapLabel(f, "Always allow pop-ups on", prefix = true)
            if (!waitFor("Opened deliberately", 8_000) && allowed) {
                touchFault("the touch on the blocked pop-ups sheet's allow switch took the sheet down but opened no pop-up page: the site was not allowed")
            }
            SystemClock.sleep(1_500)
        }
        ensureForeground()
        openInApp("zenium://settings/security")
        waitFor("Site permissions", 12_000)
        SystemClock.sleep(1_500)
        shot("16-settings-security")
        // A row's accessible text runs its label and description together: the answer's row is
        // found by its description, the sheet's action row by its label as a prefix. The row's
        // finger must bring its sheet up (the next level's control), and the sheet's injected
        // touch (the rule in DemoHarness) is Forget this answer, on which the section must read
        // empty – the row was the only answer; a touch that fell through to the scrim takes the
        // sheet down with the row still there.
        if (tapLabel(f, "May open pop-up windows", contains = true)) {
            if (!waitFor("Forget this answer", 5_000, prefix = true)) {
                touchFault("the touch on the answer's row in Settings › Security brought no sheet with Forget this answer")
            }
            SystemClock.sleep(1_200)
            shot("17-settings-security-answer-sheet")
            val forgot = tapLabel(f, "Forget this answer", prefix = true)
            if (!waitFor("No site permissions remembered yet", 8_000) && forgot) {
                touchFault("the touch on the answer sheet's Forget this answer left the answer in Settings › Security")
            }
            SystemClock.sleep(1_200)
            shot("18-settings-security-forgotten")
        } else {
            shot("16-settings-security-no-answer")
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
     * Send the sign-in form and wait for what should follow – `expect`: the refusal's validation
     * line, or the page signed in. The press has to find the sheet at rest. A press on a sheet
     * whose spring is still running catches the sheet instead: the chassis holds a moving sheet
     * for the finger that took it (BottomSheet.tsx) and swallows the click that follows, and the
     * simulated click of an accessibility action comes with a pointer press and release of its
     * own. The keyboard the fields brought up lifts the sheet on that very spring, and late on the
     * emulator (the IME's insets arrive seconds after it shows), so a press right after the fill
     * lands mid-lift and does nothing. So the screen is watched to a standstill first, with a
     * margin for the spring's last, invisible fraction of a pixel; and a press that nothing
     * followed is made once more, on a sheet surely at rest by then – a repeat of a press that did
     * land is nothing, the form having answered already.
     */
    private fun submitSignIn(expect: String, timeoutMs: Long): Boolean {
        for (attempt in 1..2) {
            awaitSettled(timeoutMs = 8_000, stillMs = 1_500)
            SystemClock.sleep(750)
            pressSignIn()
            if (waitFor(expect, timeoutMs)) return true
            step("nothing followed the press (attempt $attempt)")
        }
        return false
    }

    /**
     * Press the dialog's Sign in button through its accessibility action, which lands once and
     * reaches the button under the soft keyboard should it be up. (Enter from the password field
     * with a press as the fallback sent the answer twice: the dialog the refused answer brought
     * back was taken for the one still waiting, and the retry shot caught the change-over.)
     * The button is told by its class: the dialog's title is "Sign in" too (§9.1 sentence case),
     * and the sheet it names is focusable, which Android reports as clickable, so the first
     * clickable node of that name is the sheet, and a click on it only moves the focus. Enter is
     * the fallback for a tree that does not have the button yet.
     */
    private fun pressSignIn() {
        val button = findNodes("Sign in").firstOrNull {
            it.isClickable && it.className == "android.widget.Button"
        }
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
        val field = fieldNamed(label)
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
        val field = fieldNamed(label) ?: return false
        val value = field.text?.toString() ?: return false
        return value == text || (field.isPassword && value.length == text.length)
    }

    /** The dialog's input named `label` (its label's text), told by kind when the tree is mid-update. */
    private fun fieldNamed(label: String): AccessibilityNodeInfo? =
        findNodes(label).firstOrNull { it.isEditable }
            ?: findNodes(label).firstNotNullOfOrNull { editableWithin(it) }
            ?: ui.rootInActiveWindow?.let(::editables)?.firstOrNull { it.isPassword == (label == "Password") }

    /**
     * A real touch on the middle of the field named `label`, which must hold the input focus
     * within four seconds of it; a fault of the run when it does not (the finger did not reach
     * the field). No touch goes in for a field that is not there.
     */
    private fun touchField(f: Finger, label: String) {
        val field = fieldNamed(label) ?: run {
            step("no field labelled '$label' to touch")
            return
        }
        val bounds = Rect().also(field::getBoundsInScreen)
        f.tap(bounds.exactCenterX(), bounds.exactCenterY())
        val deadline = SystemClock.uptimeMillis() + 4_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            if (fieldNamed(label)?.isFocused == true) {
                step("the touch on '$label' at $bounds took: the field holds the focus")
                return
            }
        }
        touchFault("the touch on the sign-in dialog's '$label' field at $bounds did not focus it")
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
     * Answer the external-app sheet with a real touch on its button. A lagging emulator drops a
     * tap now and then; the sheet still being up says so, and the tap is repeated. The tree going
     * away for a moment (the active window changing hands) is not the sheet closing; another
     * window in front is sent back first. True when a touch took the sheet down (the caller
     * asserts what the button did beyond that: the sheet's own scrim takes it down too); false
     * with no touch when the button is not there, and false with a fault noted when three
     * touches left the sheet up – the last resort for a refusal is then the back gesture, which
     * the sheet answers, so the sequence goes on.
     */
    private fun answerSheet(f: Finger, label: String): Boolean {
        for (attempt in 1..3) {
            if (!tapLabel(f, label)) return false
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
            if (gone) return true
            step("the sheet is still up after '$label' (attempt $attempt)")
        }
        touchFault("three touches on the external-app sheet's '$label' left the sheet up")
        if (label == "Not now") {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            step("sent back to close the sheet")
            SystemClock.sleep(1_000)
        }
        return false
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
     * A sheet over a live page is in the accessibility tree as soon as it renders, but the chassis
     * holds it at opacity 0 until the page is covered – a picture of the page painted behind it
     * (up to 2.5 s on the emulator's software GPU, `COVER_WAIT_MS`), the page views hidden, and
     * the host's frame without them drawn, or a second's grace from a host that never says so
     * (`ACK_TIMEOUT_MS`, lib/pageView.ts) – and only then slides it in. A screenshot taken before
     * that shows the page, not the sheet, and the host's own view state flips a frame or a second
     * ahead of the slide. So the screen itself is watched: captures 250 ms apart until the scene
     * has changed from the first (the scrim and the sheet coming) and then three in a row agree
     * (two, and the emulator may have stalled a frame mid-slide), a blinking caret's worth of
     * pixels apart. A scene that never changes is taken as settled after `stillMs`, past the
     * chassis's longest hold (`COVERED_TIMEOUT_MS`): the sheet was up before the first capture.
     * False when the scene kept changing for `timeoutMs`. The same watch, with a shorter
     * `stillMs`, lets a sheet the keyboard lifted come to rest before it is pressed
     * (`submitSignIn`).
     */
    private fun awaitSettled(timeoutMs: Long = 10_000, stillMs: Long = 4_500): Boolean {
        val start = SystemClock.uptimeMillis()
        val reference = capture() ?: return false
        var last = reference
        var moved = false
        var stillRuns = 0
        try {
            while (SystemClock.uptimeMillis() < start + timeoutMs) {
                SystemClock.sleep(250)
                val next = capture() ?: continue
                stillRuns = if (alike(last, next)) stillRuns + 1 else 0
                if (!moved && !alike(reference, next)) moved = true
                if (last !== reference) last.recycle()
                last = next
                if (moved && stillRuns >= 2) {
                    step("the scene moved and settled")
                    return true
                }
                if (!moved && SystemClock.uptimeMillis() - start >= stillMs) {
                    step("the scene held still for ${stillMs}ms")
                    return true
                }
            }
            step("the scene kept changing for ${timeoutMs}ms")
            return false
        } finally {
            if (last !== reference) last.recycle()
            reference.recycle()
        }
    }

    /** The screen as pixels the test can read (the automation's bitmap may be hardware-backed). */
    private fun capture(): Bitmap? {
        val shot = ui.takeScreenshot() ?: return null
        val copy = shot.copy(Bitmap.Config.ARGB_8888, false)
        shot.recycle()
        return copy
    }

    /**
     * Whether two captures agree but for a blinking caret and the status bar's clock: fewer than
     * 0.2 % of the pixels sampled on a 4 px grid differ. A scrim fading or a sheet sliding moves
     * a good tenth of the screen.
     */
    private fun alike(a: Bitmap, b: Bitmap): Boolean {
        if (a.width != b.width || a.height != b.height) return false
        val rowA = IntArray(a.width)
        val rowB = IntArray(b.width)
        var samples = 0
        var differing = 0
        var y = 0
        while (y < a.height) {
            a.getPixels(rowA, 0, a.width, 0, y, a.width, 1)
            b.getPixels(rowB, 0, b.width, 0, y, b.width, 1)
            var x = 0
            while (x < a.width) {
                samples++
                if (rowA[x] != rowB[x]) differing++
                x += 4
            }
            y += 4
        }
        return differing * 500 < samples
    }

    /**
     * The node labelled `label` sits clear of the soft keyboard: the keyboard is up and the
     * sheet has lifted the form so the node's bounds end above it. Polls until it does, then lets
     * the sheet's spring settle; false when the keyboard never came or the node stayed under it.
     */
    private fun awaitAboveKeyboard(label: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val ime = imeInset()
            val bounds = findByLabel(label)
            if (ime > 0 && bounds != null && bounds.bottom <= height - ime) {
                step("'$label' is above the keyboard")
                SystemClock.sleep(800)
                return true
            }
            SystemClock.sleep(200)
        }
        step("'$label' never came above the keyboard within ${timeoutMs}ms")
        return false
    }

    /**
     * The keyboard's height in px, from its window in the accessibility window list
     * (`FLAG_RETRIEVE_INTERACTIVE_WINDOWS`); 0 while it is down. The decor view's `WindowInsets`
     * never reported it up on the emulator.
     */
    private fun imeInset(): Int {
        val ime = ui.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return 0
        val bounds = Rect().also(ime::getBoundsInScreen)
        return max(0, height - bounds.top)
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
        ignoreCase: Boolean = false,
        contains: Boolean = false
    ): Boolean {
        var target = findByLabel(label, prefix, ignoreCase, contains) ?: run {
            step("no node labelled '$label'")
            return false
        }
        val settleBy = SystemClock.uptimeMillis() + 2_000
        while (SystemClock.uptimeMillis() < settleBy) {
            SystemClock.sleep(150)
            val again = findByLabel(label, prefix, ignoreCase, contains) ?: break
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

    private fun findByLabel(
        label: String,
        prefix: Boolean = false,
        ignoreCase: Boolean = false,
        contains: Boolean = false
    ): Rect? = findAllByLabel(label, prefix, ignoreCase, contains).firstOrNull()

    /**
     * Breadth-first search of the active window for nodes labelled `label` (aria-label or text).
     * With `prefix`, a node whose text starts with the label and a space matches as well: a button
     * made of several spans ("Pop-up blocked" and "Show") is one node with their texts joined.
     * With `contains`, a node whose text has the label anywhere in it: a Settings row is one
     * button whose text runs its label and description together. With `ignoreCase`, a system
     * button whose text is shown, and read, in capitals matches too.
     */
    private fun findAllByLabel(
        label: String,
        prefix: Boolean = false,
        ignoreCase: Boolean = false,
        contains: Boolean = false
    ): List<Rect> =
        findNodes(label, prefix, ignoreCase, contains).map { node -> Rect().also(node::getBoundsInScreen) }

    private fun findNodes(
        label: String,
        prefix: Boolean = false,
        ignoreCase: Boolean = false,
        contains: Boolean = false
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
                    (prefix && text.toString().startsWith("$label ", ignoreCase)) ||
                    (contains && text.toString().contains(label, ignoreCase))
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
        /** The sign-in form's validation line after a refused attempt (`lib/security.ts`). */
        private const val RETRY_MESSAGE = "The username or password was not accepted. Please try again."
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
