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

/**
 * Drives the site-information sheet of the phone chrome so the `android-siteinfo-demo` workflow
 * can record it on an emulator: seeds a profile with two real sites (Google active, Bing next)
 * and a couple of remembered permission decisions, launches the app, lets the page settle, then
 * opens the sheet from the site icon in the address pill, clears the site's cookies (the count
 * drops), revokes a permission, drags the sheet away by its grip, and does it once more on the
 * second site. Only asserts that it could run; what the chrome does is what the recording shows.
 *
 * Handshake with the workflow (files under the app's `files/siteinfo-demo/`), as in GestureDemo:
 * `record` once the warm-up is done, wait for `recording`, `done` when the sequence is over.
 * Screenshots land next to them as `siteinfo-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class SiteInfoDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "siteinfo-demo")
    private val density = app.resources.displayMetrics.density
    private lateinit var activity: Activity
    private var width = 0
    private var height = 0
    private var bottomInset = 0
    private lateinit var pill: Rect

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
        // Let Google finish loading (and setting its cookies) before anything is recorded.
        SystemClock.sleep(9_000)
        handshake()
        demo()
        Log.i(TAG, "done")
    }

    // --- setup -----------------------------------------------------------------------------------

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.delete() }
        for ((asset, name) in listOf("siteinfo-demo-state.json" to "state.json", "siteinfo-demo-permissions.json" to "permissions.json")) {
            instrumentation.context.assets.open(asset).use { input ->
                File(zen, name).outputStream().use { input.copyTo(it) }
            }
        }
        out.deleteRecursively()
        out.mkdirs()
    }

    private fun launch() {
        // The launcher entry is an icon alias that hands over to MainActivity and finishes at
        // once; the demo needs the browser's own activity, so it starts that directly.
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent)
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabel(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(3_000)
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
        var top = 0
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bars = ViewCompat.getRootWindowInsets(root)?.getInsets(WindowInsetsCompat.Type.systemBars())
            width = root.width
            height = root.height
            top = bars?.top ?: 0
            bottomInset = bars?.bottom ?: 0
        }
        if (width == 0 || height == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            width = probe.width
            height = probe.height
            probe.recycle()
        }
        pill = findByLabel(PILL_LABEL)?.takeIf { it.top > height * 0.6 && it.width() > 100 * density } ?: computedPill()
        Log.i(TAG, "window ${width}x${height} density $density insets $top/$bottomInset pill $pill")
    }

    /** Where the pill is when the accessibility tree does not say: below the page, between the buttons. */
    private fun computedPill(): Rect {
        val centerY = height - bottomInset - 28 * density
        return Rect((56 * density).toInt(), (centerY - 22 * density).toInt(), (width - 152 * density).toInt(), (centerY + 22 * density).toInt())
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

    // --- sequence --------------------------------------------------------------------------------

    private fun demo() {
        val f = Finger()

        // 1. Open the sheet from the site icon at the start of the pill.
        tapSiteIcon(f)
        SystemClock.sleep(3_500)
        shot("01-sheet-google")

        // 2. Clear the site's cookies: the action asks once, inline, then the count drops.
        if (tapLabel(f, "Clear cookies")) {
            SystemClock.sleep(1_800)
            shot("02-clear-cookies-confirm")
            tapLabel(f, "Confirm clear cookies")
            SystemClock.sleep(3_000)
            shot("03-cookies-cleared")
        } else {
            Log.w(TAG, "no cookies to clear on the first site")
        }

        // 3. Revoke the remembered Location permission (the page reloads without it).
        if (tapLabel(f, "Reset Location permission")) {
            SystemClock.sleep(4_500)
            shot("04-permission-revoked")
        }

        // 4. Drag the sheet away by its grip: peek it down, hold, then let it go.
        dragSheetAway(f)
        SystemClock.sleep(4_000)

        // 5. Swipe the pill to the next tab (slowly, the way GestureDemo does: the first touch
        //    snapshots the page before the cards can move), then the same sheet on the second site.
        f.down(pill.right - 10f, pill.exactCenterY())
        f.moveBy(-NUDGE, 0f, 60)
        f.hold(STAGE_WAIT)
        f.moveBy(-0.60f * width + NUDGE, 0f, 700)
        f.hold(250)
        f.up()
        SystemClock.sleep(10_000)
        tapSiteIcon(f)
        SystemClock.sleep(3_500)
        shot("05-sheet-bing")
        scrollSheet(f)
        SystemClock.sleep(1_500)
        shot("06-sheet-bing-scrolled")
        dragSheetAway(f)
        SystemClock.sleep(2_500)

        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
    }

    /** The site icon sits at the start of the pill; the accessibility tree knows it by its label. */
    private fun tapSiteIcon(f: Finger) {
        val icon = findAllByLabel(SITE_ICON_LABEL).filter { it.top > height * 0.6 }.minByOrNull { it.width() * it.height() }
        if (icon != null) {
            f.tap(icon.exactCenterX(), icon.exactCenterY())
        } else {
            Log.w(TAG, "site icon not in the accessibility tree; tapping the start of the pill")
            f.tap(pill.left + 22 * density, pill.exactCenterY())
        }
    }

    /** The open sheet is the dialog labelled like the icon; the grip is its top edge. */
    private fun sheetBounds(): Rect? =
        findAllByLabel(SITE_ICON_LABEL).filter { it.width() > width * 0.8 }.maxByOrNull { it.height() }

    private fun dragSheetAway(f: Finger) {
        val sheet = sheetBounds()
        val grip = findByLabel(GRIP_LABEL)
        Log.i(TAG, "sheet $sheet grip $grip")
        val x = width / 2f
        val y = grip?.exactCenterY() ?: ((sheet?.top ?: (height * 0.35f).toInt()) + 24 * density)
        val travel = (sheet?.height() ?: (height * 0.6f).toInt()).toFloat()
        f.down(x, y)
        f.moveBy(0f, 0.18f * travel, 500)
        f.hold(500)
        f.moveBy(0f, 0.12f * travel, 300)
        f.hold(250)
        // Let go with a downward fling: the spring carries it out.
        f.moveBy(0f, 0.25f * travel, 140)
        f.up()
    }

    /** Scroll the sheet's body up a little so the lower sections show. */
    private fun scrollSheet(f: Finger) {
        val sheet = sheetBounds() ?: return
        val x = width / 2f
        val from = sheet.bottom - 0.25f * sheet.height()
        f.down(x, from)
        f.moveBy(0f, -0.35f * sheet.height(), 500)
        f.hold(200)
        f.up()
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "siteinfo-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
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
        private const val TAG = "SiteInfoDemo"
        private const val PILL_LABEL = "Address"
        private const val SITE_ICON_LABEL = "Site information"
        private const val GRIP_LABEL = "Drag to dismiss"
        private const val STEP_MS = 8L
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        private const val NUDGE = 30f
        /** Long enough for the emulator's software GPU to snapshot the page before the swipe. */
        private const val STAGE_WAIT = 2_400L
    }
}
