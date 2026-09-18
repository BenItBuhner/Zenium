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
 * opens the sheet from the site icon in the address pill, pushes each level – the connection, the
 * cookies (expanded and scrolled, then cleared through the confirmation sheet stacked on top) and
 * the permissions, where the Location grant is reset – pops back with the system back gesture,
 * drags the sheet away by its grabber, and finishes on the tab overview and Settings so the sheet
 * can be compared with its neighbours in the same colour scheme (`-e theme light|dark`). Only
 * asserts that it could run; what the chrome does is what the recording shows.
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

    /** `-e theme dark` records the same sequence in the dark colour scheme. */
    private val theme: String = InstrumentationRegistry.getArguments().getString("theme") ?: "light"

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.delete() }
        for ((asset, name) in listOf("siteinfo-demo-state.json" to "state.json", "siteinfo-demo-permissions.json" to "permissions.json")) {
            val text = instrumentation.context.assets.open(asset).use { it.readBytes().toString(Charsets.UTF_8) }
            val seeded = if (name == "state.json") text.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"") else text
            File(zen, name).writeText(seeded)
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

        // 1. Open the sheet from the site icon at the start of the pill: four rows at content height.
        tapSiteIcon(f)
        awaitSheet()
        SystemClock.sleep(2_000)
        shot("01-sheet")

        // 2. The connection level pushes in; the header's back control pops it.
        if (tapLabel(f, "Connection")) {
            SystemClock.sleep(1_800)
            shot("02-connection")
            tapLabel(f, BACK_LABEL)
            SystemClock.sleep(1_200)
        }

        // 3. Cookies and site data: expand the sheet, scroll the list, then clear the cookies
        //    through the confirmation sheet that stacks on top.
        if (tapLabel(f, "Cookies and site data")) {
            SystemClock.sleep(1_800)
            shot("03-cookies")
            expandSheet(f)
            SystemClock.sleep(1_200)
            scrollSheet(f)
            SystemClock.sleep(1_200)
            shot("04-cookies-scrolled")
            if (tapUntil(f, "Clear cookies", "Confirm clear cookies")) {
                SystemClock.sleep(1_200)
                shot("05-clear-cookies-confirm")
                tapLabel(f, "Confirm clear cookies")
                // The jar is cleared and read again through Kotlin: the emulator takes its time.
                SystemClock.sleep(6_000)
                shot("06-cookies-cleared")
            }
            tapLabel(f, BACK_LABEL)
            SystemClock.sleep(1_200)
        }

        // 4. Permissions: reset the remembered Location grant with the row's control.
        if (tapLabel(f, "Permissions")) {
            SystemClock.sleep(1_800)
            shot("07-permissions")
            if (tapLabel(f, "Reset Location permission")) {
                SystemClock.sleep(3_500)
                shot("08-permission-reset")
            }
            // The system back gesture pops the level before it dismisses the sheet.
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(1_500)
        }

        // 5. Drag the sheet away by its grabber: peek it down, hold, then let it go.
        dragSheetAway(f)
        SystemClock.sleep(3_000)

        // 6. The neighbours, for comparison: the tab overview, then Settings.
        if (tapLabel(f, "Tabs (2)")) {
            SystemClock.sleep(2_500)
            shot("09-overview")
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(2_000)
        }
        if (tapLabel(f, "Menu")) {
            SystemClock.sleep(1_800)
            // Settings sits low in the menu: pull the sheet up to its full detent, then scroll.
            repeat(2) {
                f.down(width / 2f, height * 0.8f)
                f.moveBy(0f, -0.45f * height, 500)
                f.hold(150)
                f.up()
                SystemClock.sleep(1_200)
            }
            if (tapLabel(f, "Settings")) {
                SystemClock.sleep(2_500)
                shot("10-settings")
                ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                SystemClock.sleep(1_500)
            }
        }

        File(out, "done").writeText("done\n")
        SystemClock.sleep(3_000)
    }

    /** The sheet reads the site before it shows; give a slow page time before the first shot. */
    private fun awaitSheet() {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (findByLabel(GRIP_LABEL) == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        Log.i(TAG, if (findByLabel(GRIP_LABEL) != null) "sheet is up" else "sheet never appeared")
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

    /**
     * Tap `label` and wait for `expected` to appear; a tap the WebView let pass as a scroll or a
     * settling sheet swallowed is tried again, a little higher in the row, up to three times.
     */
    private fun tapUntil(f: Finger, label: String, expected: String): Boolean {
        repeat(3) { attempt ->
            val target = findByLabel(label) ?: run {
                Log.w(TAG, "no node labelled '$label'")
                return false
            }
            val y = target.top + target.height() * (0.5f - 0.15f * attempt)
            Log.i(TAG, "tap '$label' (attempt ${attempt + 1}) at ${target.exactCenterX()},$y")
            f.tap(target.exactCenterX(), y)
            val deadline = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (findByLabel(expected) != null) return true
                SystemClock.sleep(250)
            }
        }
        Log.w(TAG, "'$expected' never appeared after tapping '$label'")
        return false
    }

    private fun tapLabel(f: Finger, label: String): Boolean {
        val candidates = findAllByLabel(label)
        val target = candidates.firstOrNull() ?: run {
            Log.w(TAG, "no node labelled '$label'")
            return false
        }
        Log.i(TAG, "tap '$label' at $target of ${candidates.size} candidates $candidates; names ${namesFor(label)}")
        f.tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    /**
     * The sheet's top edge and its grabber: the chassis names the handle `Dismiss`, 8 px inside
     * the sheet's top; the sheet runs from there to the bottom edge of the screen.
     */
    private fun grabber(): Rect? = findByLabel(GRIP_LABEL)

    private fun sheetTop(): Float = grabber()?.let { it.top - 8 * density } ?: (height * 0.45f)

    /** Pull the sheet up to its expanded detent so its body scrolls (the chassis locks it at the peek). */
    private fun expandSheet(f: Finger) {
        val from = sheetTop() + 120 * density
        f.down(width / 2f, from)
        f.moveBy(0f, -0.4f * height, 600)
        f.hold(200)
        f.up()
    }

    private fun dragSheetAway(f: Finger) {
        val grip = grabber()
        Log.i(TAG, "grabber $grip")
        val x = width / 2f
        val y = grip?.exactCenterY() ?: (sheetTop() + 24 * density)
        val travel = height - bottomInset - sheetTop()
        f.down(x, y)
        f.moveBy(0f, 0.18f * travel, 500)
        f.hold(500)
        f.moveBy(0f, 0.12f * travel, 300)
        f.hold(250)
        // Let go with a downward fling: the spring carries it out.
        f.moveBy(0f, 0.25f * travel, 140)
        f.up()
    }

    /** Scroll the open level's list up so its lower groups show. */
    private fun scrollSheet(f: Finger) {
        val top = sheetTop()
        val span = height - bottomInset - top
        val x = width / 2f
        f.down(x, top + 0.7f * span)
        f.moveBy(0f, -0.4f * span, 600)
        f.hold(200)
        f.up()
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "siteinfo-$theme-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    private fun findByLabel(label: String): Rect? = findAllByLabel(label).firstOrNull()

    /** The names of every node that begins with `label`, for the log. */
    private fun namesFor(label: String): List<String> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<String>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            for (name in listOfNotNull(node.contentDescription?.toString(), node.text?.toString())) {
                if (name.trim().startsWith(label)) found += "${node.className}:'${name.trim()}'"
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /**
     * Breadth-first search of the active window for nodes labelled `label` (aria-label or text).
     * A row's name is its label and value together ("Connection Secure"), so a node that merely
     * starts with the label counts when nothing matches it exactly – the smallest such node, so a
     * container whose text happens to begin with a row's label never stands in for the row.
     */
    private fun findAllByLabel(label: String): List<Rect> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val exact = ArrayList<Rect>()
        val prefixed = ArrayList<Pair<Rect, Boolean>>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            val names = listOfNotNull(node.contentDescription?.toString(), node.text?.toString())
                .map { it.replace(Regex("\\s+"), " ").trim() }
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            // A row's own name is its label, a comma, its value ("Connection, Secure"); the WebView
            // hands a button's name over as its text, so both fields are read.
            if (names.any { it == label || it.startsWith("$label,") }) {
                exact += bounds
            } else if (names.any { it.startsWith(label) }) {
                // Only when nothing is named exactly: the pill's "Connection is secure" chip also
                // begins with "Connection", and it is smaller than the row it must not stand in for.
                val button = node.className?.toString()?.endsWith("Button") == true
                prefixed += bounds to button
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        if (exact.isNotEmpty()) return exact.sortedBy { it.width() * it.height() }
        return prefixed
            .sortedWith(compareByDescending<Pair<Rect, Boolean>> { it.second }.thenBy { it.first.width() * it.first.height() })
            .map { it.first }
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
        private const val GRIP_LABEL = "Dismiss"
        private const val BACK_LABEL = "Back to site information"
        private const val STEP_MS = 8L
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        private const val NUDGE = 30f
        /** Long enough for the emulator's software GPU to snapshot the page before the swipe. */
        private const val STAGE_WAIT = 2_400L
    }
}
