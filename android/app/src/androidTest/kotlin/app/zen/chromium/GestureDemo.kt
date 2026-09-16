package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
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
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Drives the URL-pill gestures of the phone chrome with synthesized touches so the
 * `android-gesture-demo` workflow can record them on an emulator. It seeds a profile (two spaces,
 * a folder, a handful of tabs), launches the app, visits every tab once so the cards have real
 * thumbnails, then hands over to the host recorder and performs the demo sequence: a slow swipe
 * with the neighbour peeking, the way back, a mid-drag reversal, a fling caught mid-flight, and
 * the overview pulled in by the finger – once cancelled, once committed.
 *
 * Touch input is injected through UiAutomation as real pointer events, interpolated in real time,
 * so the chrome measures genuine finger velocities. It only ever asserts that it could run; what
 * the chrome does with the gestures is what the recording is for.
 *
 * Handshake with the workflow (files under the app's `files/gesture-demo/`):
 *  - the driver writes `record` once the warm-up is done and waits for `recording`, which the
 *    workflow creates after starting `screenrecord`;
 *  - it writes `done` when the sequence is over, so the recording stops before the process does;
 *  - screenshots land next to them as `android-gestures-device-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class GestureDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "gesture-demo")
    private val density = app.resources.displayMetrics.density
    private var width = 0
    private var height = 0
    private lateinit var pill: Rect
    private var pillY = 0f
    private var pillCenterX = 0f
    /** Finger travel (px) that opens the overview completely, mirroring `overviewTravel()`. */
    private var overviewTravel = 0f

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
        warmUp()
        handshake()
        demo()
        Log.i(TAG, "done")
    }

    // --- setup -----------------------------------------------------------------------------------

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
        instrumentation.startActivitySync(intent)
        // The chrome is a WebView booting the browser core: wait for the address pill to show up.
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    private fun measure() {
        val probe = ui.takeScreenshot() ?: error("could not take a screenshot")
        width = probe.width
        height = probe.height
        probe.recycle()
        val found = findByLabel(PILL_LABEL)?.takeIf { it.top > height * 0.6 && it.width() > 100 * density }
        pill = found ?: computedPill()
        pillY = pill.exactCenterY()
        pillCenterX = pill.exactCenterX()
        val statusBar = systemDimension("status_bar_height")
        val navBar = systemDimension("navigation_bar_height")
        overviewTravel = max(220 * density, 0.42f * (height - statusBar - navBar - 64 * density))
        Log.i(
            TAG,
            "screen ${width}x${height} density $density pill $pill " +
                "(${if (found != null) "from accessibility" else "computed"}) overview travel $overviewTravel"
        )
    }

    /** Where the pill is when the accessibility tree does not say: below the page, between the buttons. */
    private fun computedPill(): Rect {
        val navBar = systemDimension("navigation_bar_height")
        val centerY = height - navBar - 28 * density
        return Rect(
            (56 * density).roundToInt(),
            (centerY - 22 * density).roundToInt(),
            (width - 152 * density).roundToInt(),
            (centerY + 22 * density).roundToInt()
        )
    }

    private fun systemDimension(name: String): Int {
        val id = app.resources.getIdentifier(name, "dimen", "android")
        return if (id != 0) app.resources.getDimensionPixelSize(id) else 0
    }

    // --- sequence --------------------------------------------------------------------------------

    /**
     * The seeded space is [mdn, damping, example (active), hn, rfc]. Visit every tab once: a card
     * gets its thumbnail when a finger next touches the pill while that tab is on screen.
     */
    private fun warmUp() {
        flingLeft(); settle()
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        repeat(4) { flingRight(); settle() }
        touchWithoutGesture(); settle()
        repeat(2) { flingLeft(); settle() }
        Log.i(TAG, "warm-up done")
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(TAG, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(2_500)
    }

    private fun demo() {
        val w = width.toFloat()
        val f = Finger()

        // 1. Slow swipe to the next tab: the neighbour peeks in and tracks the finger.
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.30f * w, 0f, 700)
        f.hold(600)
        shot("01-swipe-peek")
        f.moveBy(-0.28f * w, 0f, 500)
        f.hold(250)
        f.up()
        beat()

        // 2. And back to the previous tab.
        f.down(pill.left + 10f, pillY)
        f.moveBy(0.55f * w, 0f, 800)
        f.hold(250)
        f.up()
        beat()

        // 3. Reversal: head for the next tab, change your mind, drift past the start and let go.
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.38f * w, 0f, 600)
        f.hold(400)
        f.moveBy(0.53f * w, 0f, 650)
        f.hold(300)
        f.up()
        beat()

        // 4. Interrupt: fling to the next tab, catch the track while it is still moving, pull it back.
        //    (The finger drifts while it holds the track – a touch that sits still on the pill would
        //    be a long press.)
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.40f * w, 0f, 120)
        f.up()
        SystemClock.sleep(110)
        f.down(pillCenterX, pillY)
        f.moveBy(0.04f * w, 0f, 450)
        shot("02-caught-mid-flight")
        f.moveBy(0.46f * w, 0f, 600)
        f.hold(250)
        f.up()
        beat()

        // 5. Pull the overview a third of the way in, look at it, let go: it springs back closed.
        f.down(pillCenterX, pillY)
        f.moveBy(0f, -0.28f * overviewTravel, 600)
        f.hold(600)
        shot("03-overview-drag")
        f.moveBy(0f, -0.05f * overviewTravel, 200)
        f.hold(300)
        f.up()
        beat()

        // 6. Pull it most of the way and commit; pick a tab from the grid to leave.
        f.down(pillCenterX, pillY)
        f.moveBy(0f, -0.75f * overviewTravel, 800)
        f.hold(300)
        f.up()
        SystemClock.sleep(1_800)
        shot("04-overview-open")
        SystemClock.sleep(700)
        val card = findByLabel("Damping - Wikipedia")
        if (card != null) {
            f.tap(card.exactCenterX(), card.exactCenterY())
        } else {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        }
        SystemClock.sleep(2_500)
        // Tell the recorder to stop while the app is still on screen: the instrumentation's exit
        // kills the process, and the launcher must not be the last frame.
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
    }

    private fun beat() = SystemClock.sleep(1_500)

    /** A quick fling from the right end of the pill: next tab. */
    private fun flingLeft() {
        val f = Finger()
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.40f * width, 0f, 120)
        f.up()
    }

    /** A quick fling from the left end of the pill: previous tab. */
    private fun flingRight() {
        val f = Finger()
        f.down(pill.left + 10f, pillY)
        f.moveBy(0.40f * width, 0f, 120)
        f.up()
    }

    /**
     * A touch that captures the page (the chrome snapshots the active tab on pointer down) but
     * neither taps nor swipes: it moves away from the middle of the screen, which the pill ignores.
     */
    private fun touchWithoutGesture() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.moveBy(0f, 40f, 150)
        f.hold(150)
        f.up()
    }

    /** Spring, tab activation and the first paint of a page that was never loaded. */
    private fun settle() = SystemClock.sleep(2_500)

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "android-gestures-device-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
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

    /**
     * One finger. Moves are interpolated and injected in real time (asynchronously, with their own
     * timestamps), so the velocity the chrome measures is the one asked for even when the WebView
     * is busy painting.
     */
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
        private const val TAG = "GestureDemo"
        private const val PILL_LABEL = "Address"
        private const val STEP_MS = 8L
    }
}
