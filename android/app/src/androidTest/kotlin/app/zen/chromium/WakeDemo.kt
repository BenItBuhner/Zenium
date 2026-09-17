package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Puts the browser through the ways a phone stops showing it and shows it again, and checks that
 * the chrome is still painted and answering afterwards (`android-wake-demo` workflow): the screen
 * turned off and on through the lock screen (dismissed by command and by a swipe), the app sent
 * home and squeezed with `am send-trim-memory`, Doze, the WebView renderer killed while the
 * screen is off (and once while it is on) – what the system does to a backgrounded browser under
 * memory pressure – and the renderer hung across a screen off and on.
 *
 * After every scenario it takes a screenshot and measures it: the share of the bottom bar's
 * pixels that are not its background (the address pill, its text and the buttons – "ink"), the
 * same for the content area, the difference from the baseline taken before the first scenario,
 * whether the accessibility tree still carries the address pill, whether the chrome WebView was
 * rebuilt, and what the chrome document itself reports (`document.visibilityState`, its size,
 * whether it answers at all). Everything goes to `files/wake-demo/report.txt`, next to the
 * screenshots; the phases also announce themselves in logcat so the recording, the logs and the
 * numbers line up. The renderer kills are asked of the workflow script (see `killRenderer`).
 *
 * With `-e assert true` a chrome that is not painted, or does not answer, after any scenario
 * fails the run (the regression check); without it the run only reports.
 */
@RunWith(AndroidJUnit4::class)
class WakeDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "wake-demo")
    private val density = app.resources.displayMetrics.density
    private val assertive = InstrumentationRegistry.getArguments().getString("assert") == "true"
    private lateinit var activity: MainActivity
    private var width = 0
    private var height = 0
    private var topInset = 0
    private var bottomInset = 0
    private var baseline: Bitmap? = null
    private var baselineBarInk = 0.0
    private var currentPhase = "baseline"
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        configureAccessibility()
        seedProfile()
        launch()
        measure()
        awaitPage()
        handshake()
        note("window ${width}x$height density $density insets $topInset/$bottomInset")
        val first = capture("00-baseline")
        baseline = first
        baselineBarInk = barInk(first)
        check("baseline", first)

        // A real lock screen from here on (the emulator ships with it disabled).
        note("keyguard: ${shell("locksettings set-disabled false").trim()}")
        phase("sleep-wake") { sleepWake(dismiss = Dismiss.COMMAND) }
        phase("sleep-wake-keyguard-swipe") { sleepWake(dismiss = Dismiss.SWIPE) }
        phase("background-trim") { backgroundAndTrim() }
        phase("sleep-doze") { sleepDoze() }
        phase("sleep-renderer-killed") { sleepKillRenderer() }
        phase("renderer-killed-awake") { killRendererAwake() }
        phase("sleep-renderer-hung") { sleepHangRenderer() }
        shell("locksettings set-disabled true")

        File(out, "done").writeText("done\n")
        SystemClock.sleep(3_000)
        note(if (failures.isEmpty()) "verdict=OK" else "verdict=FAIL ${failures.joinToString()}")
        Log.i(TAG, "done: ${if (failures.isEmpty()) "chrome painted after every scenario" else "chrome missing after ${failures.joinToString()}"}")
        if (assertive && failures.isNotEmpty()) {
            throw AssertionError("the chrome was not painted after: ${failures.joinToString()}")
        }
    }

    // --- scenarios -------------------------------------------------------------------------------

    private enum class Dismiss { COMMAND, SWIPE }

    /** Screen off for a few seconds, then on; the lock screen goes away by command or by a swipe. */
    private fun sleepWake(dismiss: Dismiss) {
        goToSleep()
        SystemClock.sleep(3_000)
        wakeUp()
        SystemClock.sleep(1_500)
        capture("$currentPhase-keyguard").recycle()
        dismissKeyguard(dismiss)
        SystemClock.sleep(3_500)
    }

    /** Home, then the memory trims a backgrounded app gets, then back through the launcher intent. */
    private fun backgroundAndTrim() {
        shell("input keyevent KEYCODE_HOME")
        SystemClock.sleep(2_500)
        note("trim: ${shell("am send-trim-memory ${app.packageName} BACKGROUND").trim()}")
        SystemClock.sleep(1_000)
        note("trim: ${shell("am send-trim-memory ${app.packageName} COMPLETE").trim()}")
        SystemClock.sleep(3_000)
        relaunch()
        SystemClock.sleep(3_500)
    }

    /** Screen off, the device forced into deep Doze for a while, then woken. */
    private fun sleepDoze() {
        shell("dumpsys battery unplug")
        goToSleep()
        SystemClock.sleep(1_500)
        note("doze: ${shell("dumpsys deviceidle force-idle").trim()}")
        SystemClock.sleep(8_000)
        note("doze: ${shell("dumpsys deviceidle unforce").trim()}")
        shell("dumpsys battery reset")
        wakeUp()
        SystemClock.sleep(1_500)
        dismissKeyguard(Dismiss.COMMAND)
        SystemClock.sleep(3_500)
    }

    /** Screen off, the WebView renderer killed the way the low-memory killer does it, then on. */
    private fun sleepKillRenderer() {
        goToSleep()
        SystemClock.sleep(2_000)
        note("renderer: ${killRenderer()}")
        SystemClock.sleep(3_000)
        wakeUp()
        SystemClock.sleep(1_500)
        dismissKeyguard(Dismiss.COMMAND)
        SystemClock.sleep(7_000)
    }

    /** The renderer killed while the browser is on screen: the recovery in plain sight. */
    private fun killRendererAwake() {
        note("renderer: ${killRenderer()}")
        SystemClock.sleep(8_000)
    }

    /**
     * The renderer alive but not answering – its main thread, which every WebView shares, spun
     * in a busy loop – across a screen off and on. The last frame stays on screen, so only the
     * chrome's silence gives it away; the host's wake probe is what has to notice and rebuild.
     */
    private fun sleepHangRenderer() {
        instrumentation.runOnMainSync {
            activity.host.chrome.evaluateJavascript(
                "setTimeout(function(){var end=Date.now()+${HANG_MS};while(Date.now()<end){}},0)",
                null
            )
        }
        SystemClock.sleep(800)
        goToSleep()
        SystemClock.sleep(2_000)
        wakeUp()
        SystemClock.sleep(1_500)
        dismissKeyguard(Dismiss.COMMAND)
        // The probe's delay, two deadlines and a chrome boot; the loop itself outlasts all of it.
        SystemClock.sleep(20_000)
    }

    // --- power, keyguard, processes --------------------------------------------------------------

    private fun goToSleep() {
        shell("svc power stayon false")
        shell("input keyevent KEYCODE_SLEEP")
        awaitWakefulness("Asleep", 4_000)
    }

    private fun wakeUp() {
        shell("input keyevent KEYCODE_WAKEUP")
        awaitWakefulness("Awake", 4_000)
        shell("svc power stayon true")
    }

    private fun awaitWakefulness(expected: String, timeoutMs: Long) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var state = wakefulness()
        while (state != expected && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            state = wakefulness()
        }
        note("power: wakefulness=$state (wanted $expected)")
    }

    private fun wakefulness(): String =
        shell("dumpsys power").lineSequence().map { it.trim() }
            .firstOrNull { it.startsWith("mWakefulness=") || it.startsWith("mWakefulnessRaw=") }
            ?.substringAfter("=")?.trim() ?: "?"

    private fun keyguardShowing(): Boolean {
        val top = ui.rootInActiveWindow?.packageName?.toString()
        val policy = shell("dumpsys window policy")
        val flagged = policy.lineSequence().any { line ->
            val t = line.trim()
            t.startsWith("showing=true") || t.contains("mKeyguardShowing=true") || t.contains("isKeyguardShowing=true") ||
                t.contains("keyguardShowing=true")
        }
        return flagged || top == "com.android.systemui"
    }

    /**
     * Take the lock screen down and wait for the browser to be the window in front again. Nothing
     * here presses back: with nothing to pop the app registers no back callback, so a system back
     * that lands after the lock screen is gone finishes the activity – the launcher would then be
     * the "blank browser" and every later scenario would run against a destroyed activity.
     */
    private fun dismissKeyguard(how: Dismiss) {
        val showing = keyguardShowing()
        note("keyguard: showing=$showing dismiss=$how top=${ui.rootInActiveWindow?.packageName}")
        when (how) {
            Dismiss.COMMAND -> shell("wm dismiss-keyguard")
            Dismiss.SWIPE -> {
                // A thumb swiping the lock screen up; twice if the first was eaten by an animation.
                Finger().swipe(width / 2f, height * 0.82f, width / 2f, height * 0.22f, 320)
                SystemClock.sleep(1_500)
                if (keyguardShowing()) {
                    Finger().swipe(width / 2f, height * 0.82f, width / 2f, height * 0.22f, 320)
                    SystemClock.sleep(1_200)
                    if (keyguardShowing()) {
                        note("keyguard: swipe did not dismiss it; falling back to the command")
                        shell("wm dismiss-keyguard")
                    }
                }
            }
        }
        if (!awaitInFront(6_000) && keyguardShowing()) {
            note("keyguard: still up after ${how.name.lowercase()}; dismissing again by command")
            shell("wm dismiss-keyguard")
            awaitInFront(4_000)
        }
        ensureForeground()
    }

    /** Follow the activity the system shows now: a recreated one must not be reported through the old instance. */
    private fun refreshActivity() {
        var resumed: MainActivity? = null
        instrumentation.runOnMainSync {
            resumed = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<MainActivity>().firstOrNull()
        }
        val next = resumed ?: return
        if (next !== activity) {
            note("activity: recreated (${activity.lifecycle.currentState} -> new instance)")
            activity = next
        }
    }

    /** Poll until the browser's window is the active one (true) or `timeoutMs` passed (false). */
    private fun awaitInFront(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** Through the shell: a backgrounded process (this one) may not start activities itself. */
    private fun relaunch() {
        val component = activity.componentName.flattenToString()
        note("relaunch: ${shell("am start -W -n $component").lineSequence().firstOrNull { it.contains("Status") || it.contains("Warning") }?.trim()}")
        awaitInFront(8_000)
    }

    private var killSeq = 0

    /**
     * Kill the WebView renderer. It is an isolated process of the WebView provider (its own uid),
     * out of this process's reach, so the workflow script does it from the host as root – asked
     * through `kill-renderer-N`, answered through `renderer-killed-N` – exactly the SIGKILL the
     * low-memory killer delivers. Without a host answer (no root), the renderer's own debug URL
     * `chrome://kill` is loaded into the page WebView instead, which ends the process from within.
     */
    private fun killRenderer(): String {
        val n = ++killSeq
        File(out, "kill-renderer-$n").writeText("please\n")
        val ack = File(out, "renderer-killed-$n")
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (!ack.exists() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        val answer = if (ack.exists()) ack.readText().trim() else "no answer from the host"
        Log.i(TAG, "renderer kill $n: $answer")
        if (answer.startsWith("killed")) return "host $answer"
        instrumentation.runOnMainSync {
            val tab = activity.host.tabs.all().firstOrNull { it.isShown }
            (tab ?: activity.host.chrome).loadUrl("chrome://kill")
        }
        return "chrome://kill through the page WebView (host: $answer)"
    }

    // --- measurement -----------------------------------------------------------------------------

    private fun phase(name: String, body: () -> Unit) {
        currentPhase = name
        Log.i(TAG, "phase $name: begin")
        note("---- $name")
        body()
        ensureForeground()
        refreshActivity()
        val shot = capture(name)
        check(name, shot)
        shot.recycle()
        Log.i(TAG, "phase $name: end")
    }

    private var lastChrome: ChromeWebView? = null

    /**
     * Screenshot metrics plus what the WebViews say about themselves. `ok` when the bottom bar has
     * a fair share of its baseline ink, the accessibility tree still has the address pill, and
     * the chrome document answers (a hung renderer leaves its last frame on screen).
     */
    private fun check(name: String, shot: Bitmap) {
        val pill = findByLabel(PILL_LABEL)
        val bar = barInk(shot)
        val page = pageInk(shot)
        val diff = baseline?.let { b -> difference(shot, b) } ?: -1.0
        val views = describeViews()
        val chrome = askChrome()
        var current: ChromeWebView? = null
        instrumentation.runOnMainSync { current = activity.host.chrome }
        val rebuilt = lastChrome != null && current !== lastChrome
        lastChrome = current
        val painted = bar >= 0.004 && (baselineBarInk <= 0 || bar >= 0.35 * baselineBarInk)
        val answers = chrome != null
        val ok = painted && pill != null && pill.width() > 100 * density && answers
        note(
            "check=$name ok=$ok pill=${pill?.flattenToString() ?: "none"} barInk=${"%.4f".format(bar)} " +
                "(baseline ${"%.4f".format(baselineBarInk)}) pageInk=${"%.4f".format(page)} diff=${"%.1f".format(diff)} " +
                "chromeRebuilt=$rebuilt top=${ui.rootInActiveWindow?.packageName} wakefulness=${wakefulness()}"
        )
        note("views=$views")
        note("chrome=${chrome ?: "no answer within ${ASK_TIMEOUT_MS} ms"}")
        if (!ok && name != "baseline") failures.add(name)
    }

    /** The chrome WebView's own account: visibility state, viewport, DOM – or null from a renderer that does not answer. */
    private fun askChrome(): String? {
        val latch = CountDownLatch(1)
        var answer: String? = null
        instrumentation.runOnMainSync {
            val chrome = activity.host.chrome
            chrome.evaluateJavascript(
                "(function(){return document.visibilityState+' '+innerWidth+'x'+innerHeight+' nodes='+document.querySelectorAll('*').length" +
                    "+' hasFocus='+document.hasFocus()+' bodyChildren='+(document.body?document.body.children.length:-1)})()"
            ) { result ->
                answer = result ?: "null"
                latch.countDown()
            }
        }
        latch.await(ASK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return answer
    }

    private fun describeViews(): String {
        var text = ""
        instrumentation.runOnMainSync {
            val host = activity.host
            val chrome = host.chrome
            text = "chrome ${chrome.width}x${chrome.height} vis=${visibilityName(chrome.visibility)} shown=${chrome.isShown} " +
                "attached=${chrome.isAttachedToWindow} ready=${chrome.ready} alpha=${chrome.alpha}; tabs=" +
                host.tabs.all().joinToString(prefix = "[", postfix = "]") { tab ->
                    "${tab.tabId} ${tab.width}x${tab.height}@${tab.left},${tab.top} ${visibilityName(tab.visibility)}" +
                        (if (tab.isShown) "*" else "") + " progress=${tab.progress}"
                } + " resumed=${activity.lifecycle.currentState}"
        }
        return text
    }

    private fun visibilityName(v: Int): String = when (v) {
        View.VISIBLE -> "VISIBLE"
        View.INVISIBLE -> "INVISIBLE"
        else -> "GONE"
    }

    /** Ink share of the bottom bar: the 56 dp above the navigation bar inset. */
    private fun barInk(shot: Bitmap): Double {
        val bottom = shot.height - bottomInset - (2 * density).roundToInt()
        val top = bottom - (56 * density).roundToInt()
        return ink(shot, Rect(0, top, shot.width, bottom))
    }

    /** Ink share of the middle of the content area (the page's text, or nothing). */
    private fun pageInk(shot: Bitmap): Double {
        val top = topInset + (72 * density).roundToInt()
        val bottom = shot.height - bottomInset - (72 * density).roundToInt()
        return ink(shot, Rect(0, top, shot.width, bottom))
    }

    /**
     * Share of the pixels in `rect` that differ from the region's dominant colour by a visible
     * margin. Sampled on a grid; the dominant colour is the most common quantised sample.
     */
    private fun ink(shot: Bitmap, rect: Rect): Double {
        val r = Rect(rect)
        if (!r.intersect(0, 0, shot.width, shot.height) || r.isEmpty) return 0.0
        val step = 3
        val counts = HashMap<Int, Int>()
        val samples = ArrayList<Int>()
        var y = r.top
        while (y < r.bottom) {
            var x = r.left
            while (x < r.right) {
                val c = shot.getPixel(x, y)
                samples.add(c)
                val q = Color.rgb(Color.red(c) shr 3, Color.green(c) shr 3, Color.blue(c) shr 3)
                counts[q] = (counts[q] ?: 0) + 1
                x += step
            }
            y += step
        }
        if (samples.isEmpty()) return 0.0
        val dominant = counts.maxByOrNull { it.value }!!.key
        val dr = Color.red(dominant) shl 3
        val dg = Color.green(dominant) shl 3
        val db = Color.blue(dominant) shl 3
        var inked = 0
        for (c in samples) {
            val d = abs(Color.red(c) - dr) + abs(Color.green(c) - dg) + abs(Color.blue(c) - db)
            if (d > 48) inked++
        }
        return inked.toDouble() / samples.size
    }

    /** Mean absolute channel difference between two screenshots of the same size (0…255). */
    private fun difference(a: Bitmap, b: Bitmap): Double {
        if (a.width != b.width || a.height != b.height) return -1.0
        var sum = 0L
        var n = 0
        var y = 0
        while (y < a.height) {
            var x = 0
            while (x < a.width) {
                val p = a.getPixel(x, y)
                val q = b.getPixel(x, y)
                sum += abs(Color.red(p) - Color.red(q)) + abs(Color.green(p) - Color.green(q)) + abs(Color.blue(p) - Color.blue(q))
                n += 3
                x += 4
            }
            y += 4
        }
        return if (n == 0) 0.0 else sum.toDouble() / n
    }

    private fun capture(name: String): Bitmap {
        val bitmap = ui.takeScreenshot() ?: error("no screenshot for $name")
        File(out, "wake-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    private fun note(line: String) {
        Log.i(TAG, line)
        File(out, "report.txt").appendText(line + "\n")
    }

    // --- setup -----------------------------------------------------------------------------------

    private fun configureAccessibility() {
        val info = ui.serviceInfo
        info.flags = info.flags or
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        ui.serviceInfo = info
    }

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.delete() }
        instrumentation.context.assets.open("gesture-demo-state.json").use { input ->
            File(zen, "state.json").outputStream().use { input.copyTo(it) }
        }
        out.deleteRecursively()
        out.mkdirs()
    }

    private fun launch() {
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)
            ?: error("no launcher activity for ${app.packageName}")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent) as MainActivity
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(3_000)
    }

    /**
     * The browser must be the window in front for a check to mean anything. If it is not (the
     * launcher, say – the app left the foreground or was finished), its task is brought forward
     * through the shell and the report says so: a browser that has to be brought back is itself a
     * finding. Never a back press: see [dismissKeyguard].
     */
    private fun ensureForeground() {
        if (awaitInFront(2_000)) return
        val top = ui.rootInActiveWindow?.packageName?.toString()
        var state = ""
        instrumentation.runOnMainSync { state = activity.lifecycle.currentState.toString() }
        note("foreground: window of $top is in front (activity $state); bringing the browser back")
        Log.w(TAG, "window of $top is in front; bringing the browser back")
        relaunch()
        SystemClock.sleep(1_500)
    }

    private fun measure() {
        ensureForeground()
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            width = root.width
            height = root.height
            val bars = ViewCompat.getRootWindowInsets(root)?.getInsets(WindowInsetsCompat.Type.systemBars())
            topInset = bars?.top ?: 0
            bottomInset = bars?.bottom ?: 0
        }
        if (width == 0 || height == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            width = probe.width
            height = probe.height
            probe.recycle()
        }
    }

    /** The seeded active tab (example.com) finished loading, or 20 s passed. */
    private fun awaitPage() {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val tab = activity.host.tabs.all().firstOrNull { it.isShown }
                loaded = tab != null && tab.progress == 100 && !tab.url.isNullOrEmpty()
            }
            if (loaded) return
            SystemClock.sleep(300)
        }
        Log.w(TAG, "gave up waiting for the active page")
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(TAG, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(1_500)
    }

    // --- helpers ---------------------------------------------------------------------------------

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }

    private fun findByLabel(label: String): Rect? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.contentDescription?.toString() == label || node.text?.toString() == label) {
                return Rect().also { node.getBoundsInScreen(it) }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    /** One finger, injected in real time. */
    private inner class Finger {
        private var downTime = 0L
        private var x = 0f
        private var y = 0f

        fun swipe(fromX: Float, fromY: Float, toX: Float, toY: Float, durationMs: Long) {
            x = fromX
            y = fromY
            downTime = SystemClock.uptimeMillis()
            inject(MotionEvent.ACTION_DOWN, downTime)
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
            inject(MotionEvent.ACTION_UP, SystemClock.uptimeMillis())
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
        private const val TAG = "WakeDemo"
        private const val PILL_LABEL = "Address"
        private const val STEP_MS = 8L
        /** A hung renderer answers nothing; how long a check waits before saying so. */
        private const val ASK_TIMEOUT_MS = 3_000L
        /** How long the hung-renderer scenario spins the renderer's main thread. */
        private const val HANG_MS = 40_000L
    }
}
