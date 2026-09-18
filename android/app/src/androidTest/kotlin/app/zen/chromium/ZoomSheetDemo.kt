package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.runner.RunWith

/**
 * Drives the page zoom sheet so the `android-zoom-demo` workflow can record it on an emulator:
 * "Zoom…" in the app menu docks the sheet under a page served from this process, the slider is
 * dragged from 100 to 150 percent with the page laying itself out again at every level it
 * passes, the plus steps once more, Reset goes back to the default, two steps set 125 percent and
 * the back gesture slides the sheet out with the finger; a pull-to-refresh brings the page back
 * at 125 (the zoom is the site's), Settings > Accessibility lists the site under "Sites with
 * their own zoom", and the sheet opened again reads "Remembered for 127.0.0.1" until Reset. Then
 * the page controls sections the first recording never reached ([PageControlsDemo]): the colour
 * scheme flipping the page's `prefers-color-scheme` live, Dark Theme for This Site with its
 * exception, Force enable zoom, the Accessibility default zoom and Include system font size.
 *
 * Navigation is gestural for this demo (the shared driver sets three-button navigation, which
 * has no back gesture) with the predictive animation on, the way the back demo runs. Only
 * asserts that it could run; the recording and the screenshots (`zoom-NN-*.png`) are the
 * evidence, with `probe:` lines in logcat for what the page saw at each step.
 */
@RunWith(AndroidJUnit4::class)
class ZoomSheetDemo : PageControlsDemo("zoom-demo-state.json", "zoom", "zoom-demo") {
    override val tag = "ZoomSheetDemo"

    /** The tide tables page and the page that forbids pinching, both on the loopback interface. */
    private val server by lazy {
        DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("zoom-demo-page.html").toByteArray()),
                LOCKED_PATH to ("text/html; charset=utf-8" to LOCKED_PAGE_HTML.toByteArray())
            )
        )
    }

    /** The edge swipe in flight (finger still down), between [edgeSwipe] and [commitSwipe]. */
    private var swipe: Finger? = null

    // The test method is the base class's `record()`; the runner finds it on this class.

    override fun patchState(json: String): String = patchTheme(json)

    override fun beforeLaunch() {
        server.start()
        Log.i(tag, "demo server: ${server.selfCheck()}")
        // Gesture navigation with the predictive animation: the back gesture closing the sheet is
        // part of what is recorded.
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        shell("settings put global enable_back_animation 1")
        SystemClock.sleep(2_500)
    }

    override fun warmUp() {
        warmUpChrome()
        awaitPage(HOST, 20_000, "/")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        zoomSheetSection()
        if (switchToTab(CERN_HOST)) darkThemeSection()
        if (switchToTab(LOCKED_HOST, LOCKED_PATH)) {
            forceZoomSection()
            defaultZoomSection()
            fontSizeSection()
        }
    }

    // --- the zoom sheet --------------------------------------------------------------------------

    private fun zoomSheetSection() {
        // 1. The page at the default zoom.
        probe("tide tables at the default zoom")
        snap("page-default-zoom")
        beat()

        // 2. App menu -> Zoom…: the sheet docks under the page, which shrinks by its height and
        //    stays live.
        if (!openMenuItem(ZOOM_ITEM, "menu-zoom")) return
        if (!awaitSheet()) return
        snap("zoom-sheet-default")
        beat()

        // 3. The slider from 100 to 150: the page lays itself out again at each level it passes.
        dragSlider(from = 1.0, to = 1.5)
        SystemClock.sleep(1_200)
        probe("slid to 150")
        Log.i(tag, "sheet reads ${sheetValue()} after the slide")
        snap("zoom-sheet-150-by-slider")
        beat()

        // 4. Plus steps to 175; Reset goes back to the default and greys itself out.
        tapControl("Zoom in")
        SystemClock.sleep(1_200)
        probe("stepped to 175")
        Log.i(tag, "sheet reads ${sheetValue()} after the step")
        snap("zoom-sheet-175-by-step")
        beat()
        tapControl("Reset")
        SystemClock.sleep(1_500)
        probe("reset to the default")
        Log.i(tag, "sheet reads ${sheetValue()} after Reset")
        snap("zoom-sheet-reset")
        beat()

        // 5. Two steps up to 125, then the back gesture: the sheet follows the finger out.
        tapControl("Zoom in")
        SystemClock.sleep(900)
        tapControl("Zoom in")
        SystemClock.sleep(1_200)
        probe("stepped to 125")
        Log.i(tag, "sheet reads ${sheetValue()} before the back gesture")
        edgeSwipe(0.34f * width, hold = 700) { snap("zoom-sheet-back-gesture") }
        commitSwipe()
        if (!awaitSurface(up = false, timeoutMs = 10_000)) Log.w(tag, "the sheet did not go on the back gesture")
        SystemClock.sleep(1_200)
        probe("sheet closed at 125")
        snap("page-125-sheet-closed")
        beat()

        // 6. Pull to refresh: the zoom is the site's, so the fresh copy comes up at 125.
        pullToRefreshOrReload()
        awaitPage(HOST, 20_000, "/")
        SystemClock.sleep(1_500)
        probe("after the reload")
        snap("page-125-after-reload")
        beat()

        // 7. Settings > Accessibility lists the site with its own zoom.
        if (openSettings("Accessibility")) {
            if (reveal(SITE_ZOOMS_GROUP) != null) {
                SystemClock.sleep(800)
                snap("accessibility-sites-with-their-own-zoom")
            } else {
                Log.w(tag, "no $SITE_ZOOMS_GROUP group in Accessibility")
            }
            ensureChromeClear()
            SystemClock.sleep(1_500)
        }

        // 8. Zoom… again: the sheet reads 125 and "Remembered for 127.0.0.1"; Reset, then Close.
        if (!openMenuItem(ZOOM_ITEM, null)) return
        if (!awaitSheet()) return
        Log.i(tag, "sheet reads ${sheetValue()}, remembered: ${findByLabel(REMEMBERED_NOTE) != null}")
        snap("zoom-sheet-remembered")
        beat()
        tapControl("Reset")
        SystemClock.sleep(1_500)
        probe("reset to the default again")
        snap("zoom-sheet-reset-again")
        beat()
        tapControl("Close")
        if (!awaitSurface(up = false, timeoutMs = 6_000)) Log.w(tag, "the sheet did not close on its button")
        SystemClock.sleep(1_200)
        probe("sheet closed at the default")
        snap("page-default-zoom-again")
        beat()
    }

    /**
     * The sheet is up: the host reports a surface and the tree has the dialog (or its slider's
     * step buttons, should the dialog's own name not reach the tree); the chrome is cleared when
     * it never comes.
     */
    private fun awaitSheet(): Boolean {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeSurfaceUp() && (findByLabel(SHEET_LABEL) != null || findByLabel("Zoom out") != null)) {
                SystemClock.sleep(1_200)
                return true
            }
            SystemClock.sleep(200)
        }
        Log.w(tag, "the zoom sheet did not open")
        ensureChromeClear()
        return false
    }

    /** What the sheet's header reads (`150%`), null when no such text is on screen. */
    private fun sheetValue(): String? = findNode { PERCENT.matches(it) }?.let { it.text ?: it.contentDescription }?.toString()

    /**
     * A finger on the middle of the sheet's control labelled `label` (the tree's bounds are exact
     * for the sheet, which does not scroll), or the tree's click when the tree has no bounds.
     */
    private fun tapControl(label: String) {
        val bounds = waitFor(label, 5_000)
        if (bounds == null) {
            Log.w(tag, "no $label in the sheet")
            return
        }
        if (bounds.isEmpty) {
            if (!clickByLabel(label)) Log.w(tag, "$label could not be clicked")
            return
        }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
    }

    /**
     * Drag the sheet's slider from one of Chrome's zoom levels to another: the finger lands on
     * the thumb's stop and moves to the target's slowly enough that the page lays itself out
     * again at every level in between. The track's span comes from the two step buttons beside
     * it (a 4 CSS px gap each side); the slider maps a pointer over its whole width, its minimum
     * at the left edge and its maximum at the right, rounded to the nearest level.
     */
    private fun dragSlider(from: Double, to: Double) {
        val minus = findByLabel("Zoom out")
        val plus = findByLabel("Zoom in")
        if (minus == null || plus == null) {
            Log.w(tag, "no slider between Zoom out and Zoom in")
            return
        }
        val gap = 4 * density
        val left = minus.right + gap
        val right = plus.left - gap
        val y = minus.exactCenterY()
        fun stop(level: Double): Float = left + (right - left) * ZOOM_LEVELS.indexOf(level) / (ZOOM_LEVELS.size - 1)
        Log.i(tag, "slider track $left..$right at y=$y; ${stop(from)} -> ${stop(to)}")
        Finger().apply {
            down(stop(from), y)
            hold(300)
            moveBy(stop(to) - stop(from), 0f, 2_000)
            hold(500)
            up()
        }
    }

    /**
     * A thumb from the left screen edge: down in the gesture inset, out to `dx`, then held there
     * (with `during` run while holding – a screenshot of the sheet part-way out). The gesture
     * stays down; follow with [commitSwipe]. After the back demo's move of the same name.
     */
    private fun edgeSwipe(dx: Float, hold: Long, during: () -> Unit = {}) {
        ensureForeground()
        val f = Finger()
        // Below the middle of the page, clear of the sheet at the bottom and the bar under it.
        f.down(EDGE_X, height * 0.45f)
        f.moveBy(dx, 0f, 650)
        f.hold(hold)
        during()
        swipe = f
    }

    /** Let go where it is: the system commits the gesture. */
    private fun commitSwipe() {
        val f = swipe ?: return
        swipe = null
        f.up()
    }

    companion object {
        private const val PORT = 18133
        private const val HOST = "127.0.0.1"
        private const val LOCKED_PATH = "/locked.html"
        private const val ZOOM_ITEM = "Zoom…"
        /** The sheet's `role=dialog` label. */
        private const val SHEET_LABEL = "Page zoom"
        private const val SITE_ZOOMS_GROUP = "Sites with their own zoom"
        private const val REMEMBERED_NOTE = "Remembered for $HOST"
        private const val EDGE_X = 2f
        private val PERCENT = Regex("\\d+%")
        /** Chrome's zoom table, the slider's stops (`shared/pageControls.ts` ZOOM_LEVELS). */
        private val ZOOM_LEVELS = listOf(0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0)
    }
}
