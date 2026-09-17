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
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Drives the phone chrome's menu sheet with synthesized touches so the `android-menu-sheet-demo`
 * workflow can record it on an emulator: the sheet springing up to its peek, the handle dragged
 * up to expand and down to collapse, a mid-drag reversal, the body scrolled with its edges
 * fading, a pull on the body collapsing the sheet again, a fling that dismisses it – caught on the
 * way out once, let go the second time – and the Settings panel scrolled for its own fading edges.
 *
 * Same handshake as `GestureDemo`, through files under the app's `files/menu-demo/`: `record`
 * once the warm-up is done, `recording` from the workflow once screenrecord is rolling, `done`
 * when the sequence is over. Screenshots land next to them as `menu-sheet-<theme>-*.png`; the
 * `theme` instrumentation argument (`light`, the default, or `dark`) picks the colour scheme the
 * profile is seeded with. It only asserts that it could run; what the chrome does with the
 * touches is what the recording is for.
 */
@RunWith(AndroidJUnit4::class)
class MenuSheetDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "menu-demo")
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private val density = app.resources.displayMetrics.density
    private lateinit var activity: Activity
    private var width = 0
    private var height = 0
    private var insetTop = 0
    private var insetBottom = 0
    private lateinit var menuButton: Rect
    /** Visible height (px) of the sheet at its peek detent, mirroring `computeDetents`. */
    private var peek = 0f

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
        val state = instrumentation.context.assets.open("gesture-demo-state.json").use { input ->
            input.bufferedReader().readText()
        }
        File(zen, "state.json").writeText(state.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\""))
        out.deleteRecursively()
        out.mkdirs()
    }

    private fun launch() {
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)
            ?: error("no launcher activity for ${app.packageName}")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent)
        // The chrome is a WebView booting the browser core: wait for the bottom bar to show up.
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(MENU_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    /** A system dialog (an ANR of some other app, say) on top of the browser would take the touches. */
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
        var w = 0
        var h = 0
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bars = ViewCompat.getRootWindowInsets(root)?.getInsets(WindowInsetsCompat.Type.systemBars())
            w = root.width
            h = root.height
            insetTop = bars?.top ?: 0
            insetBottom = bars?.bottom ?: 0
        }
        if (w == 0 || h == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            w = probe.width
            h = probe.height
            probe.recycle()
        }
        width = w
        height = h
        // The sheet layer is the whole window; the peek is 52 % of it (SHEET_PEEK_FRACTION).
        peek = (height * 0.52f).roundToInt().toFloat()
        menuButton = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Log.i(TAG, "window ${width}x${height} density $density insets $insetTop/$insetBottom menu $menuButton peek $peek")
    }

    /** Where the menu button is when the accessibility tree does not say: rightmost in the bar. */
    private fun computedMenuButton(): Rect {
        val centerY = height - insetBottom - 28 * density
        val centerX = width - 30 * density
        val half = 22 * density
        return Rect(
            (centerX - half).roundToInt(), (centerY - half).roundToInt(),
            (centerX + half).roundToInt(), (centerY + half).roundToInt()
        )
    }

    // --- sequence --------------------------------------------------------------------------------

    /** The first sheet pays for layout and compilation; open it once off camera. */
    private fun warmUp() {
        openMenu()
        // Back with no menu up would fall through to the page (and, without history, background
        // the app): only send it once the sheet is there to take it.
        if (awaitHandle()) {
            SystemClock.sleep(1_000)
            back()
        }
        SystemClock.sleep(2_000)
        Log.i(TAG, "warm-up done")
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

    private fun demo() {
        val f = Finger()
        val x = width / 2f

        // 1. The menu springs up to its peek; the list fades out at the bottom edge.
        openMenu()
        SystemClock.sleep(1_800)
        shot("collapsed")

        // 2. Drag the handle up: the sheet grows under the finger, then settles expanded.
        var grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, -0.35f * (expanded() - peek), 700)
        f.hold(600)
        shot("dragging")
        f.moveBy(0f, -0.45f * (expanded() - peek), 500)
        f.hold(250)
        f.up()
        beat()
        shot("expanded")

        // 3. Drag it down again slowly: collapses back to the peek.
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, 0.7f * (expanded() - peek), 800)
        f.hold(250)
        f.up()
        beat()

        // 4. Reversal: head up, change your mind, drift below where you started and let go.
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, -0.45f * (expanded() - peek), 600)
        f.hold(400)
        f.moveBy(0f, 0.55f * (expanded() - peek), 650)
        f.hold(300)
        f.up()
        beat()

        // 5. Fling the handle up: expanded, and the list scrolls on its own from here on.
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, -0.4f * height, 130)
        f.up()
        beat()

        // 6. Scroll the list: the top edge fades in as content passes under it, the bottom fade
        //    goes away at the end. Then back to the top.
        val bodyY = height - insetBottom - 0.35f * height
        f.down(x, bodyY)
        f.moveBy(0f, -0.2f * height, 700)
        f.hold(700)
        shot("expanded-scrolled")
        f.moveBy(0f, -0.35f * height, 600)
        f.hold(500)
        f.up()
        beat()
        f.down(x, bodyY - 0.1f * height)
        f.moveBy(0f, 0.6f * height, 700)
        f.up()
        beat()

        // 7. Pull down on the body while it sits at its top: the sheet comes down with it.
        f.down(x, bodyY - 0.1f * height)
        f.moveBy(0f, 0.65f * (expanded() - peek), 700)
        f.hold(300)
        f.up()
        beat()

        // 8. A submenu: the sheet shrinks to fit it, the title row grows a back chevron.
        if (clickByLabel("Zoom")) {
            SystemClock.sleep(1_500)
            shot("submenu")
            clickByLabel("Back", enabledOnly = true)
            beat()
        }

        // 9. Fling it away – and catch it on the way out: a finger landing on the layer while the
        //    sheet moves freezes it where it is, then carries it back up to the peek.
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, 0.3f * height, 110)
        f.up()
        SystemClock.sleep(80)
        f.down(x, height - insetBottom - 0.12f * height)
        f.hold(250)
        shot("caught")
        f.hold(450)
        f.moveBy(0f, -0.35f * height, 700)
        f.hold(300)
        f.up()
        beat()

        // 10. This time let it go.
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, 0.3f * height, 110)
        f.up()
        beat()

        // 11. Into Settings: open, expand, scroll to the end, pick the row; the sheet slides away
        //     before the panel comes up.
        if (!ensureMenuOpen()) return
        grip = handleY()
        f.down(x, grip)
        f.moveBy(0f, -0.4f * height, 130)
        f.up()
        beat()
        f.down(x, bodyY)
        f.moveBy(0f, -0.6f * height, 500)
        f.up()
        beat()
        // Rows are picked through the accessibility tree: the bounds it reports for content
        // inside a scrolled list lag behind on the emulator, a touch at them would miss.
        if (!clickByLabel("Settings") && findByLabel(HANDLE_LABEL) != null) back()
        SystemClock.sleep(2_500)

        // 12. Settings on a phone: section chips above the content. Scroll a long section so the
        //     content fades at the top and bottom, and the chip row at its ends.
        clickByLabel("Tab Management")
        SystemClock.sleep(1_200)
        val contentY = height / 2f
        f.down(x, contentY + 0.15f * height)
        f.moveBy(0f, -0.3f * height, 700)
        f.hold(700)
        shot("settings")
        f.moveBy(0f, -0.2f * height, 500)
        f.hold(300)
        f.up()
        beat()
        f.down(x, contentY)
        f.moveBy(0f, 0.4f * height, 700)
        f.up()
        SystemClock.sleep(2_000)
        // Tell the recorder to stop while the app is still on screen: the instrumentation's exit
        // kills the process, and the launcher must not be the last frame.
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
    }

    private fun beat() = SystemClock.sleep(1_800)

    private fun openMenu() {
        ensureForeground()
        Finger().tap(menuButton.exactCenterX(), menuButton.exactCenterY())
    }

    private fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /** The menu is up (opening it if a step left it closed); false when it never appeared. */
    private fun ensureMenuOpen(): Boolean {
        if (findByLabel(HANDLE_LABEL) != null) return true
        openMenu()
        SystemClock.sleep(2_500)
        return findByLabel(HANDLE_LABEL) != null
    }

    /** Height (px) of the expanded sheet, mirroring `sheetMaxHeight`. */
    private fun expanded(): Float = height - insetTop - 32 * density

    /** Screen y of the handle when the sheet rests at its peek. */
    private fun peekHandleY(): Float = height - peek + 11 * density

    /** Screen y of the handle wherever the sheet is now (the peek when the tree does not say). */
    private fun handleY(): Float = findByLabel(HANDLE_LABEL)?.exactCenterY() ?: peekHandleY()

    /** Wait for the sheet to enter the accessibility tree. False when it never showed up. */
    private fun awaitHandle(): Boolean {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(HANDLE_LABEL) != null) return true
            SystemClock.sleep(30)
        }
        return false
    }

    /**
     * Click the nearest clickable node labelled `label` through accessibility. False when there
     * is none. `enabledOnly` skips disabled matches (the bar's own Back button under the sheet).
     */
    private fun clickByLabel(label: String, enabledOnly: Boolean = false): Boolean {
        var node = findNodeByLabel(label, enabledOnly) ?: return false
        while (!node.isClickable) node = node.parent ?: return false
        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "menu-sheet-$theme-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    /** Screen bounds of the node labelled `label` (aria-label or text), if there is one. */
    private fun findByLabel(label: String): Rect? =
        findNodeByLabel(label)?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
    private fun findNodeByLabel(label: String, enabledOnly: Boolean = false): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (
                (node.contentDescription?.toString() == label || node.text?.toString() == label) &&
                (!enabledOnly || node.isEnabled)
            ) {
                return node
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
        private const val TAG = "MenuSheetDemo"
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"
        private const val STEP_MS = 8L
    }
}
