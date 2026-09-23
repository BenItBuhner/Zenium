package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
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
 * page (with and without a snapshot of the previous entry), the URL bar, the three-dot menu, a
 * panel, the site information sheet, the tab overview and the drawer, and finally with nothing
 * left to pop, which hands the gesture to the system's own back-to-home animation.
 *
 * Touches are injected through UiAutomation as real pointer events, so SystemUI's edge gesture
 * detector sees them exactly as it would a finger. It asserts that it could run and that the
 * finger it puts on the menu's History row opened the panel (the rule in DemoHarness); what the
 * app does with the gestures is what the recording is for.
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
        if (touchFaults.isNotEmpty()) {
            throw AssertionError("${touchFaults.size} touch(es) did not take: ${touchFaults.joinToString("; ")}")
        }
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
        // The launcher entry is an icon alias that hands over to MainActivity and finishes at
        // once; the demo needs the browser's own activity, so it starts that directly.
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
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

    /** Run `block` on the main thread with the demo tab's view – the seeded tab, else whichever page is on screen. */
    private fun <T> withTab(block: (TabWebView?) -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync {
            val tabs = activity.host.tabs
            result = block(tabs.get(TAB_ID) ?: tabs.all().firstOrNull { it.isShown })
        }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /**
     * Two link taps inside the seeded example.com tab, as real touches: a navigation the page
     * starts without user activation (a scripted `a.click()`) is marked skippable by Chromium's
     * history-manipulation intervention and `canGoBack()` stays false, exactly as it would in
     * Chrome. A tapped link carries activation, goes through shouldOverrideUrlLoading and leaves
     * its page's snapshot behind for the back preview.
     */
    private fun buildHistory() {
        instrumentation.runOnMainSync {
            val tabs = activity.host.tabs
            Log.i(TAG, "views: ${tabs.all().map { "${it.tabId}${if (it.isShown) "*" else ""}" }} (seeded id present: ${tabs.get(TAB_ID) != null})")
        }
        awaitLoaded("example.com")
        SystemClock.sleep(1_500)
        follow("a[href]", "https://www.iana.org/help/example-domains")
        awaitLoaded("iana.org")
        SystemClock.sleep(2_000)
        follow("a[href=\"/domains\"], a[href^=\"/domains/\"], a[href^=\"/protocols\"]", "https://www.iana.org/domains/reserved")
        awaitLoaded("iana.org/domains")
        SystemClock.sleep(2_500)
        val depth = withTab { it?.copyBackForwardList()?.size ?: 0 }
        Log.i(TAG, "history built: $depth entries")
    }

    /**
     * Tap the first link matching `selector` in the active tab (scrolled into view first; the tap
     * is a trusted touch on the WebView, in CSS coordinates like an agent's click), or load
     * `fallback` when the page has no such link.
     */
    private fun follow(selector: String, fallback: String) {
        val script = "(function(){var a=document.querySelector(${JSONObject.quote(selector)});" +
            "if(!a){return null}a.scrollIntoView({block:'center'});var r=a.getBoundingClientRect();" +
            "return [r.left+r.width/2,r.top+r.height/2]})()"
        withTab { tab ->
            tab ?: error("the demo tab is gone")
            tab.evaluate(script) { result ->
                val point = runCatching { org.json.JSONArray(result ?: "") }.getOrNull()
                if (point == null || point.length() != 2) {
                    Log.w(TAG, "no link for $selector; loading $fallback")
                    tab.loadUrl(fallback)
                    return@evaluate
                }
                // Let the scroll settle before the tap lands.
                tab.postDelayed({
                    tab.sendAgentInput(json("type" to "click", "x" to point.optDouble(0), "y" to point.optDouble(1))) {}
                }, 400)
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

        // 3. The same entry back without its snapshot: the neutral page with the site's favicon
        //    and title stands in, then the commit takes us to where we started.
        instrumentation.runOnMainSync { activity.host.snapshots.clear() }
        edgeSwipe(0.34f * w, hold = 700) { shot("02-page-placeholder") }
        cancelSwipe()
        beat()
        edgeSwipe(0.36f * w, hold = 350)
        commitSwipe()
        SystemClock.sleep(2_800)

        // 4. The URL bar: opened from the pill; its input is blurred first (with the keyboard up,
        //    back belongs to the keyboard), then the bar lifts away with the finger.
        tapLabel("Address")
        SystemClock.sleep(1_200)
        blurChrome()
        dismissWithBack(0.30f * w, "03-urlbar-dragging")

        // 5. The three-dot menu: dragged a third of the way and let go (springs back up), then
        //    dragged and committed (slides out).
        tapLabel("Menu")
        SystemClock.sleep(1_200)
        dismissWithBack(0.30f * w, "04-menu-dragging")

        // 6. A panel: History, from the menu (its search field takes the keyboard; blur it too).
        //    The menu flow's injected touch (the rule in DemoHarness): the History row under a
        //    finger, and the panel must come up on it with its Clear history row – a touch that
        //    fell through to the scrim would only close the menu.
        tapLabel("Menu")
        SystemClock.sleep(1_200)
        touchLabelExpecting("History", "the History panel is up") { findByLabel("Clear history") != null }
        SystemClock.sleep(1_200)
        blurChrome()
        dismissWithBack(0.30f * w, "05-panel-dragging")

        // 7. The site information sheet, from the pill's site icon.
        tapSiteIcon()
        SystemClock.sleep(1_800)
        dismissWithBack(0.30f * w, "06-siteinfo-dragging")

        // 8. The tab overview: the page grows back out of its card with the finger, springs back
        //    into the grid on cancel, and morphs home on commit.
        tapLabelPrefix("Tabs (")
        SystemClock.sleep(1_800)
        dismissWithBack(0.32f * w, "07-overview-dragging", commitTravel = 0.36f * w, settle = 2_200)

        // 9. The sidebar drawer, from the overview's header. Clicked through accessibility: a touch
        //    on that header starts the overview's own drag, which takes the tap away from the button.
        tapLabelPrefix("Tabs (")
        SystemClock.sleep(1_800)
        clickLabel("Open sidebar")
        SystemClock.sleep(1_400)
        dismissWithBack(0.30f * w, "08-drawer-dragging")

        // 10. Nothing left to pop: the app has no callback registered, so this swipe is the
        //     system's own predictive back-to-home.
        edgeSwipe(0.36f * w, hold = 400)
        commitSwipe()
        SystemClock.sleep(2_500)

        File(out, "done").writeText("done\n")
        SystemClock.sleep(3_000)
    }

    /**
     * Drag the open surface a third of the way and let go (it springs back), then drag and
     * commit. Waits on the app's own word that a surface is up before swiping – a swipe with
     * nothing to pop would hand the app to the launcher – and that it is gone afterwards: on the
     * emulator's software GPU a dismissal spring can take well over a second.
     */
    private fun dismissWithBack(travel: Float, shotName: String, commitTravel: Float = travel + 0.04f * width, settle: Long = 800) {
        if (!awaitSurface(up = true, timeoutMs = 5_000)) {
            Log.w(TAG, "no chrome surface up for $shotName; skipping its gestures")
            return
        }
        edgeSwipe(travel, hold = 700) { shot(shotName) }
        cancelSwipe()
        beat()
        edgeSwipe(commitTravel, hold = 300)
        commitSwipe()
        if (!awaitSurface(up = false, timeoutMs = 10_000)) Log.w(TAG, "the surface behind $shotName did not close")
        SystemClock.sleep(settle)
    }

    /** Poll the host for whether the chrome reports a dismissable surface. */
    private fun awaitSurface(up: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var state = false
            instrumentation.runOnMainSync { state = activity.host.back.chromeSurfaceUp }
            if (state == up) return true
            SystemClock.sleep(150)
        }
        return false
    }

    /**
     * Take focus off the chrome's input: the keyboard goes away with it, and so does the
     * keyboard's own back callback, which otherwise takes the next swipe (as it should).
     */
    private fun blurChrome() {
        instrumentation.runOnMainSync {
            activity.host.chrome.evaluateJavascript("document.activeElement&&document.activeElement.blur()", null)
            activity.getSystemService(InputMethodManager::class.java)
                ?.hideSoftInputFromWindow(activity.host.chrome.windowToken, 0)
        }
        SystemClock.sleep(1_800)
    }

    /** The site icon at the start of the address pill (by label, else by where it sits in the pill). */
    private fun tapSiteIcon() {
        val icon = findByLabel("Site information")
        if (icon != null) {
            Finger().tap(icon.exactCenterX(), icon.exactCenterY())
            return
        }
        val pill = findByLabel(PILL_LABEL)
        if (pill == null) {
            Log.w(TAG, "no pill to tap the site icon in")
            return
        }
        val density = app.resources.displayMetrics.density
        Finger().tap(pill.left + 24f * density, pill.exactCenterY())
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
        // Below the middle, so the system's arrow does not sit on the preview's centred identity.
        f.down(EDGE_X, height * 0.6f)
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

    /**
     * [tapLabel], then up to `timeoutMs` for `took` to hold – the step's claim, named by `effect`
     * (DemoHarness's `touchTapLabelExpecting`, for this driver of its own). The finger goes in
     * once the row is inside the window ([touchPoint]) and two reads of its bounds 350 ms apart
     * agree, within [ROW_SETTLE_MS]: the menu is still coming up, and the tree lags it on the
     * emulator – the repairs' fourth proof run's tree had the History row at
     * `Rect(0, 2199 - 721, 1602)` for two reads, the sheet's first frame below the screen with the
     * window's edge clipping the row's bottom, and a finger at that centre touched nothing. A row
     * that never comes inside the window is a fault too. A touch that went in without `took`
     * holding is a fault of the run, reported once the recording is done ([record]).
     */
    private fun touchLabelExpecting(label: String, effect: String, timeoutMs: Long = 5_000, took: () -> Boolean) {
        var bounds: Rect? = null
        var landing: PointF? = null
        val settle = SystemClock.uptimeMillis() + ROW_SETTLE_MS
        while (SystemClock.uptimeMillis() < settle) {
            val again = findByLabel(label)
            val at = again?.let { touchPoint(it) }
            if (again != null && at != null && again == bounds) {
                landing = at
                break
            }
            bounds = again
            SystemClock.sleep(350)
        }
        if (bounds == null) {
            Log.w(TAG, "no node labelled $label to touch")
            return
        }
        val point = landing ?: touchPoint(bounds) ?: run {
            val fault = "the '$label' row never came inside the window ${width}x$height within $ROW_SETTLE_MS ms (last at $bounds); no touch went in"
            Log.e(TAG, "TOUCH FAULT: $fault")
            touchFaults += fault
            return
        }
        Finger().tap(point.x, point.y)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                Log.i(TAG, "the touch on '$label' at $bounds took: $effect")
                return
            }
            SystemClock.sleep(150)
        }
        val fault = "a touch on '$label' at $bounds did not take: not $effect within $timeoutMs ms"
        Log.e(TAG, "TOUCH FAULT: $fault")
        touchFaults += fault
    }

    /**
     * Where a finger touches `bounds`: the middle of their part inside the window; null when no
     * part is (a row the tree still has below the screen while the sheet slides in – the bounds
     * the window's edge clipped read inverted, top below bottom, and are empty to [Rect]).
     */
    private fun touchPoint(bounds: Rect): PointF? {
        val reach = Rect(bounds)
        if (bounds.isEmpty || !reach.intersect(Rect(0, 0, width, height))) return null
        return PointF(reach.exactCenterX(), reach.exactCenterY())
    }

    /** The touches that did not take; [record] fails on them once the recording is done. */
    private val touchFaults = ArrayList<String>()

    private fun tapLabelPrefix(prefix: String) {
        val bounds = findByLabel(prefix, prefix = true)
        if (bounds == null) {
            Log.w(TAG, "no node labelled $prefix…")
            return
        }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
    }

    /** Activate a node by label through accessibility (a DOM click, no pointer events). */
    private fun clickLabel(label: String) {
        val node = findNodeByLabel(label)
        if (node == null) {
            Log.w(TAG, "no node labelled $label to click")
            return
        }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) Log.w(TAG, "click on $label was refused")
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "back-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
    private fun findByLabel(label: String, prefix: Boolean = false): Rect? =
        findNodeByLabel(label, prefix)?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun findNodeByLabel(label: String, prefix: Boolean = false): AccessibilityNodeInfo? {
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
            if (matches(node.contentDescription) || matches(node.text)) return node
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
        /** [touchLabelExpecting]: how long a menu row gets to come inside the touchable band and hold still. */
        private const val ROW_SETTLE_MS = 8_000L
        /** Inside the system's back-gesture inset on any density. */
        private const val EDGE_X = 2f
    }
}
