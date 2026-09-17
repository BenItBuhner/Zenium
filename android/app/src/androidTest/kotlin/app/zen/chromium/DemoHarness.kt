package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Everything a recorded demo of the phone chrome needs besides its own sequence: seeding a
 * profile from an asset, launching the app, measuring the window and the address pill,
 * synthesising touches through UiAutomation as real pointer events (interpolated in real time,
 * so the chrome measures genuine finger velocities), looking elements up in the accessibility
 * tree, and the handshake with the workflow's screen recorder.
 *
 * Handshake (files under the app's `files/<handshakeDir>/`, the workflow's `DEMO_DIR`):
 *  - the driver writes `record` once its warm-up is done and waits for `recording`, which the
 *    workflow creates after starting `screenrecord`;
 *  - it writes `done` when the sequence is over, so the recording stops before the process does;
 *  - screenshots land next to them as `<shotPrefix>-<name>.png`.
 */
abstract class DemoHarness(
    private val stateAsset: String,
    private val shotPrefix: String,
    handshakeDir: String
) {
    protected val instrumentation = InstrumentationRegistry.getInstrumentation()
    protected val ui: UiAutomation = instrumentation.uiAutomation
    protected val app: Context = instrumentation.targetContext
    protected val out = File(app.filesDir, handshakeDir)
    protected val density = app.resources.displayMetrics.density
    protected lateinit var activity: Activity
    protected var width = 0
    protected var height = 0
    protected lateinit var pill: Rect
    protected var pillY = 0f
    protected var pillCenterX = 0f
    /** Finger travel (px) that opens the overview completely, mirroring `overviewTravel()`. */
    protected var overviewTravel = 0f

    protected abstract val tag: String

    /** Warm the cards up (visit tabs so they have thumbnails); runs before the recorder rolls. */
    protected abstract fun warmUp()

    /** The recorded sequence. */
    protected abstract fun demo()

    /** Seed, launch, warm up, hand over to the recorder, run the sequence. */
    protected fun runDemo() {
        val info = ui.serviceInfo
        info.flags = info.flags or
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        ui.serviceInfo = info

        seedProfile()
        launch()
        measure()
        warmUp()
        handshake()
        demo()
        // Tell the recorder to stop while the app is still on screen: the instrumentation's exit
        // kills the process, and the launcher must not be the last frame.
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
        Log.i(tag, "done")
    }

    // --- setup -----------------------------------------------------------------------------------

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.delete() }
        instrumentation.context.assets.open(stateAsset).use { input ->
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
        // The chrome is a WebView booting the browser core: wait for the address pill to show up.
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    /** A system dialog (an ANR of some other app, say) on top of the browser would take the touches. */
    protected fun ensureForeground() {
        repeat(5) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            Log.w(tag, "window of $top is in front; sending back")
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(1_000)
        }
    }

    private fun measure() {
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        val found = findByLabel(PILL_LABEL)?.takeIf { it.top > height * 0.6 && it.width() > 100 * density }
        pill = found ?: computedPill(insets.bottom)
        pillY = pill.exactCenterY()
        pillCenterX = pill.exactCenterX()
        overviewTravel = max(220 * density, 0.42f * (height - insets.top - insets.bottom - 64 * density))
        Log.i(
            tag,
            "window ${width}x${height} density $density insets ${insets.top}/${insets.bottom} pill $pill " +
                "(${if (found != null) "from accessibility" else "computed"}) overview travel $overviewTravel"
        )
    }

    private class Insets(val windowWidth: Int, val windowHeight: Int, val top: Int, val bottom: Int)

    /** The window and its system bar insets – the same numbers the chrome lays itself out with. */
    private fun windowInsets(): Insets {
        var result = Insets(0, 0, 0, 0)
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bars = ViewCompat.getRootWindowInsets(root)?.getInsets(WindowInsetsCompat.Type.systemBars())
            result = Insets(root.width, root.height, bars?.top ?: 0, bars?.bottom ?: 0)
        }
        if (result.windowWidth == 0 || result.windowHeight == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            result = Insets(probe.width, probe.height, result.top, result.bottom)
            probe.recycle()
        }
        return result
    }

    /** Where the pill is when the accessibility tree does not say: below the page, between the buttons. */
    private fun computedPill(bottomInset: Int): Rect {
        val centerY = height - bottomInset - 28 * density
        return Rect(
            (56 * density).roundToInt(),
            (centerY - 22 * density).roundToInt(),
            (width - 152 * density).roundToInt(),
            (centerY + 22 * density).roundToInt()
        )
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(tag, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(1_500)
    }

    // --- shared moves ----------------------------------------------------------------------------

    protected fun beat() = SystemClock.sleep(1_500)

    /**
     * Cross the slop (so the axis is locked and no long press can start) and wait for the stage.
     * The first touch on the pill snapshots the live page before the cards can replace it; on
     * hardware that takes a frame, on the emulator's software GPU the better part of a second.
     */
    protected fun Finger.settleIn(dx: Float, dy: Float) {
        moveBy(dx, dy, 60)
        hold(STAGE_WAIT)
    }

    /** A quick fling from the right end of the pill: next tab. */
    protected fun flingLeft() {
        val f = Finger()
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.40f * width, 0f, 120)
        f.up()
    }

    /** A quick fling from the left end of the pill: previous tab. */
    protected fun flingRight() {
        val f = Finger()
        f.down(pill.left + 10f, pillY)
        f.moveBy(0.40f * width, 0f, 120)
        f.up()
    }

    /**
     * A touch that captures the page (the chrome snapshots the active tab on pointer down) but
     * neither taps nor swipes: it moves away from the middle of the screen, which the pill ignores.
     */
    protected fun touchWithoutGesture() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.moveBy(0f, 40f, 150)
        f.hold(150)
        f.up()
    }

    /**
     * Snapshot, spring, tab activation and the first paint of a page that was never loaded. Long
     * enough that the next touch starts a fresh gesture (and snapshot) instead of catching this one.
     */
    protected fun settle() = SystemClock.sleep(4_500)

    protected fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "$shotPrefix-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
    protected fun findByLabel(label: String): Rect? =
        findNode(label)?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun findNode(label: String): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    /** The first of several labels that is on screen (a tab's title changes once its page loads). */
    protected fun findAny(vararg labels: String): Rect? = labels.firstNotNullOfOrNull { findByLabel(it) }

    /**
     * Scroll the first of these labels fully into view (the chrome scrolls its grid the least it
     * has to) and return where it is then; null when none exists.
     */
    protected fun reveal(vararg labels: String): Rect? {
        val label = labels.firstOrNull { findNode(it) != null } ?: return null
        findNode(label)?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findByLabel(label)
    }

    /** Poll for a label for up to `timeoutMs`. */
    protected fun waitFor(label: String, timeoutMs: Long = 5_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findByLabel(label)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /**
     * One finger. Moves are interpolated and injected in real time (asynchronously, with their own
     * timestamps), so the velocity the chrome measures is the one asked for even when the WebView
     * is busy painting.
     */
    protected inner class Finger {
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

        /** Press and hold long enough for the chrome's long press (380 ms) to fire, finger still down. */
        fun press(x: Float, y: Float) {
            down(x, y)
            hold(LONG_PRESS_WAIT)
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
        const val PILL_LABEL = "Address"
        private const val STEP_MS = 8L
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        const val NUDGE = 30f
        const val STAGE_WAIT = 2_400L
        /** The chrome lifts a held card after 380 ms; the emulator's main thread may lag behind. */
        const val LONG_PRESS_WAIT = 900L
    }
}
