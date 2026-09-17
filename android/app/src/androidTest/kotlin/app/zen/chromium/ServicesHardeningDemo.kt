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
import android.os.SystemClock
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
import kotlin.math.max

/**
 * Temporary driver for the `android-services-hardening-demo` workflow: records the pop-up blocker,
 * the external-app prompt (tel: and an intent:// with a fallback) and the HTTP sign-in dialog
 * against the demo server the runner hosts (10.0.2.2:8787). Only asserts that it could run through
 * the sequence; the recording and the screenshots show what the chrome did.
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

        // 1. The page opened a pop-up on its own: blocked, the chip says so, the list offers Open.
        waitFor("Pop-up blocked", 12_000)
        shot("01-popup-blocked-chip")
        tapLabel(f, "Pop-up blocked")
        waitFor("Pop-ups blocked", 5_000)
        shot("02-popup-blocked-list")
        tapLabel(f, "Open")
        SystemClock.sleep(4_000)
        shot("03-popup-opened-deliberately")

        // 2. Links to other apps: the automatic tel: launch is refused and listed; a tapped tel:
        //    link asks; an intent:// link with no app to take it lands on its fallback page.
        openInApp("http://$SERVER/apps")
        waitFor("Pop-up blocked", 12_000)
        shot("04-app-launch-blocked-chip")
        tapLabel(f, "Pop-up blocked")
        waitFor("Pop-ups blocked", 5_000)
        shot("05-app-launch-blocked-list")
        tapLabel(f, "Dismiss")
        SystemClock.sleep(1_500)
        tapLabel(f, "Call +1 555 0100")
        waitFor("Open", 6_000)
        SystemClock.sleep(800)
        shot("06-tel-launch-prompt")
        tapLabel(f, "Cancel")
        SystemClock.sleep(1_500)
        tapLabel(f, "Scan a barcode (intent:// with a fallback)")
        waitFor("Open", 6_000)
        SystemClock.sleep(800)
        shot("07-intent-launch-prompt")
        tapLabel(f, "Open")
        SystemClock.sleep(4_000)
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
        SystemClock.sleep(600)
        pressKey(KeyEvent.KEYCODE_ENTER)
        step("submitted with Enter")
        waitFor("The username or password was not accepted. Please try again.", 10_000)
        SystemClock.sleep(1_200)
        shot("10-http-auth-retry")
        fill(f, "Password", "secret")
        SystemClock.sleep(600)
        pressKey(KeyEvent.KEYCODE_ENTER)
        step("submitted with Enter")
        waitFor("Signed in as zenium", 10_000)
        SystemClock.sleep(1_500)
        shot("11-http-auth-signed-in")
    }

    /**
     * Focus the field under `label` and type into it (the field is the label's own child),
     * replacing whatever it holds.
     */
    private fun fill(f: Finger, label: String, text: String) {
        val field = findAllByLabel(label).filter { it.width() > 0 }.maxByOrNull { it.height() }
        if (field == null) {
            step("no field labelled '$label'")
            return
        }
        // The input sits below the caption inside the label; aim at its lower half.
        f.tap(field.exactCenterX(), field.bottom - field.height() * 0.28f)
        SystemClock.sleep(700)
        pressKey(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)
        SystemClock.sleep(150)
        type(text)
        SystemClock.sleep(400)
        step("filled '$label'")
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

    private fun waitFor(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) != null) {
                step("saw '$label'")
                return true
            }
            SystemClock.sleep(250)
        }
        step("never saw '$label' within ${timeoutMs}ms")
        return false
    }

    private fun tapLabel(f: Finger, label: String): Boolean {
        val target = findByLabel(label) ?: run {
            step("no node labelled '$label'")
            return false
        }
        f.tap(target.exactCenterX(), target.exactCenterY())
        step("tapped '$label' at $target")
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

    private fun findByLabel(label: String): Rect? = findAllByLabel(label).firstOrNull()

    /** Breadth-first search of the active window for nodes labelled `label` (aria-label or text). */
    private fun findAllByLabel(label: String): List<Rect> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<Rect>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            if (node.contentDescription?.toString() == label || node.text?.toString() == label) {
                found += Rect().also { node.getBoundsInScreen(it) }
            }
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
        private const val STEP_MS = 8L
    }
}
