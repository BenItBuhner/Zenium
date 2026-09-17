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
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.max

/**
 * Drives the predictive back gesture for the `android-back-demo` workflow: it seeds the demo
 * profile, launches the app, walks the active tab through two link navigations (so the history
 * has real snapshots), then hands over to the host recorder and swipes back from the screen edge
 * the way a thumb would – held and let go early (cancel), held and released (commit) – over the
 * page, the three-dot menu and the tab overview, and finally with nothing left to pop, which
 * hands the gesture to the system's own back-to-home animation.
 *
 * Touches are injected through UiAutomation as real pointer events, so SystemUI's edge gesture
 * detector sees them exactly as it would a finger. It only ever asserts that it could run; what
 * the app does with the gestures is what the recording is for.
 *
 * Handshake with the workflow (files under the app's `files/back-demo/`):
 *  - the driver writes `record` once the pages are loaded and waits for `recording`;
 *  - it writes `done` when the sequence is over, so the recording stops before the process does;
 *  - screenshots land next to them as `back-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class BackDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "back-demo")
    private lateinit var activity: MainActivity
    private var width = 0
    private var height = 0

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
        buildHistory()
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
        activity = instrumentation.startActivitySync(intent) as MainActivity
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
        Log.i(TAG, "window ${width}x$height")
    }

    // --- history ---------------------------------------------------------------------------------

    /** Run `block` on the main thread with the demo tab's view (null when it is gone). */
    private fun <T> withTab(block: (TabWebView?) -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block(activity.host.tabs.get(TAB_ID)) }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /**
     * Two link clicks inside the seeded example.com tab: a script-driven `a.click()` is a real
     * navigation as far as the WebView is concerned (it goes through shouldOverrideUrlLoading),
     * so each page leaves its snapshot behind for the back preview.
     */
    private fun buildHistory() {
        awaitLoaded("example.com")
        SystemClock.sleep(1_500)
        follow("a[href]", "https://www.iana.org/help/example-domains")
        awaitLoaded("iana.org")
        SystemClock.sleep(2_000)
        follow("a[href=\"/domains\"], a[href^=\"/domains/\"], nav a[href^=\"/\"]", "https://www.iana.org/domains/reserved")
        awaitLoaded("iana.org/domains")
        SystemClock.sleep(2_500)
        val depth = withTab { it?.copyBackForwardList()?.size ?: 0 }
        Log.i(TAG, "history built: $depth entries")
    }

    /** Click the first link matching `selector` in the active tab, or load `fallback`. */
    private fun follow(selector: String, fallback: String) {
        val script = "(function(){var a=document.querySelector(${JSONObject.quote(selector)});" +
            "if(!a){return false}a.click();return true})()"
        withTab { tab ->
            tab ?: error("the demo tab is gone")
            tab.evaluate(script) { result ->
                if (result != "true") {
                    Log.w(TAG, "no link for $selector; loading $fallback")
                    tab.loadUrl(fallback)
                }
            }
        }
    }

    private fun awaitLoaded(urlPart: String) {
        val deadline = SystemClock.uptimeMillis() + 25_000
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, progress) = withTab { tab -> (tab?.url ?: "") to (tab?.progress ?: 0) }
            if (url.contains(urlPart) && progress == 100) {
                Log.i(TAG, "loaded $url")
                return
            }
            SystemClock.sleep(250)
        }
        Log.w(TAG, "gave up waiting for $urlPart")
    }

    // --- recording -------------------------------------------------------------------------------

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
        val w = width.toFloat()

        // 1. In-page back, changed our mind: the previous page slides in under the current one,
        //    the finger returns to the edge, everything springs back.
        edgeSwipe(0.34f * w, hold = 700) { shot("01-page-preview") }
        cancelSwipe()
        beat()

        // 2. In-page back, committed: the page slides out, the previous entry is revealed and the
        //    real page takes its place once painted.
        edgeSwipe(0.36f * w, hold = 350)
        commitSwipe()
        SystemClock.sleep(2_800)

        // 3. Again, one more entry back to where we started.
        edgeSwipe(0.36f * w, hold = 350) { shot("02-page-preview-second") }
        commitSwipe()
        SystemClock.sleep(2_800)

        // 4. The three-dot menu: dragged a third of the way and let go (springs back up), then
        //    dragged and committed (slides out).
        tapLabel("Menu")
        SystemClock.sleep(1_200)
        edgeSwipe(0.30f * w, hold = 700) { shot("03-menu-dragging") }
        cancelSwipe()
        beat()
        edgeSwipe(0.34f * w, hold = 300)
        commitSwipe()
        SystemClock.sleep(1_500)

        // 5. The tab overview: the page grows back out of its card with the finger, springs back
        //    into the grid on cancel, and morphs home on commit.
        tapLabelPrefix("Tabs (")
        SystemClock.sleep(1_800)
        edgeSwipe(0.32f * w, hold = 700) { shot("04-overview-dragging") }
        cancelSwipe()
        beat()
        edgeSwipe(0.36f * w, hold = 300)
        commitSwipe()
        SystemClock.sleep(2_200)

        // 6. Nothing left to pop: the app has no callback registered, so this swipe is the
        //    system's own predictive back-to-home.
        edgeSwipe(0.36f * w, hold = 400)
        commitSwipe()
        SystemClock.sleep(2_500)

        File(out, "done").writeText("done\n")
        SystemClock.sleep(3_000)
    }

    private fun beat() = SystemClock.sleep(1_400)

    // --- gestures --------------------------------------------------------------------------------

    private var finger: Finger? = null

    /**
     * A thumb from the left screen edge: down in the gesture inset, out to `dx`, then held there
     * (with `during` run while holding – screenshots). The gesture stays down; follow with
     * `cancelSwipe()` or `commitSwipe()`.
     */
    private fun edgeSwipe(dx: Float, hold: Long, during: () -> Unit = {}) {
        ensureForeground()
        val f = Finger()
        f.down(EDGE_X, height * 0.5f)
        f.moveBy(dx, 0f, 650)
        f.hold(hold)
        during()
        finger = f
    }

    /** Back to the edge and let go: the system cancels the gesture. */
    private fun cancelSwipe() {
        val f = finger ?: return
        finger = null
        f.moveBy(EDGE_X + 4f - f.x, 0f, 450)
        f.hold(250)
        f.up()
    }

    /** Let go where it is: the system commits the gesture. */
    private fun commitSwipe() {
        val f = finger ?: return
        finger = null
        f.up()
    }

    private fun tapLabel(label: String) {
        val bounds = findByLabel(label)
        if (bounds == null) {
            Log.w(TAG, "no node labelled $label")
            return
        }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
    }

    private fun tapLabelPrefix(prefix: String) {
        val bounds = findByLabel(prefix, prefix = true)
        if (bounds == null) {
            Log.w(TAG, "no node labelled $prefix…")
            return
        }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "back-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
    private fun findByLabel(label: String, prefix: Boolean = false): Rect? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        val matches = { text: CharSequence? ->
            text != null && if (prefix) text.startsWith(label) else text.toString() == label
        }
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (matches(node.contentDescription) || matches(node.text)) {
                return Rect().also { node.getBoundsInScreen(it) }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    /** One finger, injected in real time so SystemUI measures genuine motion. */
    private inner class Finger {
        private var downTime = 0L
        var x = 0f
            private set
        var y = 0f
            private set

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
        private const val TAG = "BackDemo"
        private const val TAB_ID = "tab_example"
        private const val PILL_LABEL = "Address"
        private const val STEP_MS = 8L
        /** Inside the system's back-gesture inset on any density. */
        private const val EDGE_X = 2f
    }
}
