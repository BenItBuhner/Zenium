package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Records the swap from the live page to its snapshot when a chrome surface opens over it – the
 * site-information sheet from the pill's chip, the menu sheet, the tab overview – on a heavy page
 * (a Wikipedia article) and on a light one (example.com), with the bar at the bottom and again
 * with it at the top. Right after each tap it takes screenshots as fast as the emulator gives
 * them (`snapshot-<surface>-<ms>ms.jpg`, with the time since the tap) and measures the part of
 * the page a sheet never reaches; the run fails when any frame shows the window gradient where
 * the page (live or its picture) should be. `marks.txt` lists when each surface was opened,
 * relative to the start of the sequence, so the workflow can cut the recording into frames.
 *
 * Driven by the `android-snapshot-demo` workflow; see [DemoHarness] for the plumbing. The `theme`
 * instrumentation argument (`light`, the default, or `dark`) picks the colour scheme.
 */
@RunWith(AndroidJUnit4::class)
class SnapshotSwapDemo : DemoHarness("snapshot-demo-state.json", "snapshot", "snapshot-demo") {
    override val tag = "SnapshotSwapDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private var barTop = false
    private var demoStart = 0L
    private val marks = StringBuilder()
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        try {
            runDemo()
        } finally {
            // Whatever cut the sequence short, what was measured up to then is worth having.
            File(out, "marks.txt").writeText(marks.toString())
            File(out, "frames.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("frames that showed the gradient where the page was:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    /**
     * Let the article load, then open and close each surface once off camera: the first sheet
     * pays for layout and script compilation, which is not what is being measured.
     */
    override fun warmUp() {
        SystemClock.sleep(12_000)
        val f = Finger()
        tapSiteIcon(f)
        SystemClock.sleep(3_000)
        back()
        SystemClock.sleep(2_500)
        tapLabel(f, MENU_LABEL)
        SystemClock.sleep(3_000)
        back()
        SystemClock.sleep(2_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        demoStart = SystemClock.uptimeMillis()
        val f = Finger()

        // 1. The heavy page, bar at the bottom: chip sheet, menu sheet, overview.
        sequence(f, "heavy-bottom")

        // 2. The light page: swipe the pill to the next tab (slowly: the first touch snapshots the
        //    page before the cards can move), let it settle, and the same three surfaces.
        flingToLight(f)
        sequence(f, "light-bottom")

        // 3. The bar at the top: a fresh session with the setting flipped; chip sheet and overview
        //    on the heavy page.
        if (relaunchWithBarAtTop()) {
            sequence(f, "heavy-top", menu = false)
        } else {
            Log.w(tag, "could not relaunch with the bar at the top; skipping that pass")
        }
    }

    private fun sequence(f: Finger, label: String, menu: Boolean = true) {
        probe(f, "$label-siteinfo", Surface.SHEET) { siteIcon() }
        closeSheet()
        if (menu) {
            probe(f, "$label-menu", Surface.SHEET) { menuButton() }
            closeSheet()
        }
        probe(f, "$label-overview", Surface.OVERVIEW) { tabsButton() }
        closeOverview()
    }

    // --- opening and closing the surfaces ---------------------------------------------------------

    private fun tapSiteIcon(f: Finger) = siteIcon().let { f.tap(it.x, it.y) }

    /**
     * The site icon sits at the start of the pill; the accessibility tree knows it by its label.
     * Looked up before the clock starts: on the emulator the tree can trail the screen by seconds.
     */
    private fun siteIcon(): PointF =
        waitFor(SITE_ICON_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "site icon not in the accessibility tree; tapping the start of the pill")
            PointF(pill.left + 22 * density, pillY)
        }

    private fun menuButton(): PointF =
        waitFor(MENU_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "menu button not in the accessibility tree; tapping the end of the bar")
            PointF(width - 28 * density, pillY)
        }

    private fun tabsButton(): PointF {
        val deadline = SystemClock.uptimeMillis() + 4_000
        while (SystemClock.uptimeMillis() < deadline) {
            findNode { it.startsWith("Tabs (") }
                ?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?.let { return PointF(it.exactCenterX(), it.exactCenterY()) }
            SystemClock.sleep(200)
        }
        Log.w(tag, "tabs button not in the accessibility tree; tapping right of the pill")
        return PointF(pill.right + 30 * density, pillY)
    }

    private fun closeSheet() {
        SystemClock.sleep(800)
        back()
        SystemClock.sleep(2_500)
    }

    private fun closeOverview() {
        SystemClock.sleep(800)
        back()
        SystemClock.sleep(3_000)
    }

    private fun flingToLight(f: Finger) {
        f.down(pill.right - 10f, pillY)
        f.moveBy(-NUDGE, 0f, 60)
        f.hold(STAGE_WAIT)
        f.moveBy(-0.60f * width + NUDGE, 0f, 700)
        f.hold(250)
        f.up()
        SystemClock.sleep(8_000)
    }

    /**
     * End the session, flip the bar to the top in the persisted profile and start the browser
     * again; false when the pill did not come back. The core persists on its way out, so the
     * profile is edited only once the activity is gone.
     */
    private fun relaunchWithBarAtTop(): Boolean {
        instrumentation.runOnMainSync { activity.finishAndRemoveTask() }
        SystemClock.sleep(3_000)
        val state = File(File(app.filesDir, "zen"), "state.json")
        if (!state.exists()) return false
        // The core writes its state compact (`"phoneBarPosition":"bottom"`); the seed is indented.
        val json = state.readText()
        val bottom = Regex("\"phoneBarPosition\"\\s*:\\s*\"bottom\"")
        val flipped = if (bottom.containsMatchIn(json)) bottom.replace(json, "\"phoneBarPosition\":\"top\"")
        else json.replace(Regex("\"settings\"\\s*:\\s*\\{"), "\"settings\":{\"phoneBarPosition\":\"top\",")
        if (flipped == json) return false
        state.writeText(flipped)
        launch()
        // The harness measures the pill at the bottom; up here it has to be found again.
        val found = findByLabelPrefix(PILL_LABEL) ?: return false
        if (found.top > height * 0.5) return false
        pill = found
        pillY = pill.exactCenterY()
        pillCenterX = pill.exactCenterX()
        barTop = true
        // A fresh session loads the article again.
        SystemClock.sleep(12_000)
        Log.i(tag, "bar at the top: pill $pill")
        return true
    }

    // --- frames ----------------------------------------------------------------------------------

    private enum class Surface { SHEET, OVERVIEW }

    private class Metrics(val luminance: Double, val chroma: Double, val edges: Double, val pageLike: Double)

    private class Frame(val at: Long, val band: Metrics, val page: Metrics)

    /**
     * Tap where `target` says, then screenshot for [PROBE_MS] as fast as the emulator allows,
     * measuring every frame, and judge the frames against the live page seen just before the tap.
     * The target is resolved before the clock starts, so the time in a frame's name is the time
     * since the touch.
     */
    private fun probe(f: Finger, name: String, surface: Surface, target: () -> PointF) {
        val at = target()
        val before = ui.takeScreenshot()
        val reference = before?.let { Frame(-1, measure(it, band()), measure(it, pageArea())) }
        before?.let { save(it, "$name-live") }
        before?.recycle()
        val t0 = SystemClock.uptimeMillis()
        marks.append("${t0 - demoStart} $name\n")
        f.tap(at.x, at.y)
        val frames = ArrayList<Frame>()
        while (SystemClock.uptimeMillis() - t0 < PROBE_MS) {
            val shot = ui.takeScreenshot() ?: continue
            val at = SystemClock.uptimeMillis() - t0
            frames += Frame(at, measure(shot, band()), measure(shot, pageArea()))
            save(shot, "$name-${at}ms")
            shot.recycle()
        }
        judge(name, surface, reference, frames)
    }

    /** The whole content frame: below the status bar (or the bar, when it is at the top) and above the bar (or the gesture inset). */
    private fun pageArea(): Rect {
        val insets = windowInsets()
        val pad = (8 * density).roundToInt()
        return if (barTop) Rect(pad, pill.bottom + pad, width - pad, height - insets.bottom - pad)
        else Rect(pad, insets.top + pad, width - pad, pill.top - 2 * pad)
    }

    /** The upper part of the page: a sheet, which comes from the bottom, never reaches it. */
    private fun band(): Rect {
        val page = pageArea()
        val inset = (page.width() * 0.1f).roundToInt()
        return Rect(page.left + inset, page.top + (4 * density).roundToInt(), page.right - inset, page.top + (page.height() * 0.3f).roundToInt())
    }

    /**
     * Mean luminance, mean chroma (max − min channel), edge density (share of sampled pixels
     * whose right neighbour differs by more than 40 in luminance) and the share of page-like
     * pixels (bright and grey) over `rect`, sampled every third pixel.
     */
    private fun measure(bitmap: Bitmap, rect: Rect): Metrics {
        val r = Rect(rect)
        r.intersect(0, 0, bitmap.width, bitmap.height)
        if (r.isEmpty) return Metrics(0.0, 0.0, 0.0, 0.0)
        val row = IntArray(r.width())
        var n = 0L
        var lum = 0.0
        var chroma = 0.0
        var edges = 0L
        var pageLike = 0L
        var y = r.top
        while (y < r.bottom) {
            bitmap.getPixels(row, 0, r.width(), r.left, y, r.width(), 1)
            var x = 0
            while (x < row.size) {
                val p = row[x]
                val red = (p shr 16) and 0xff
                val green = (p shr 8) and 0xff
                val blue = p and 0xff
                val l = 0.299 * red + 0.587 * green + 0.114 * blue
                val c = max(red, max(green, blue)) - min(red, min(green, blue))
                lum += l
                chroma += c
                if (l > 90 && c < 24) pageLike++
                if (x + 3 < row.size) {
                    val q = row[x + 3]
                    val lq = 0.299 * ((q shr 16) and 0xff) + 0.587 * ((q shr 8) and 0xff) + 0.114 * (q and 0xff)
                    if (abs(l - lq) > 40) edges++
                }
                n++
                x += 3
            }
            y += 3
        }
        return Metrics(lum / n, chroma / n, edges.toDouble() / n, pageLike.toDouble() / n)
    }

    /**
     * A sheet's frames: the band above the sheet must keep looking like the page – text edges
     * or grey-white pixels – and never like the smooth, tinted window gradient. The overview's
     * frames: the share of page-like pixels over the whole content frame shrinks smoothly from
     * the live page to the settled grid (the hero card plus the other tab's card); a blank
     * frame between the two has far less than the settled grid.
     */
    private fun judge(name: String, surface: Surface, reference: Frame?, frames: List<Frame>) {
        findings.append("$name (${theme}, bar ${if (barTop) "top" else "bottom"}): ${frames.size} frames in ${PROBE_MS} ms\n")
        reference?.let { findings.append(describe(it)) }
        for (frame in frames) findings.append(describe(frame))
        if (frames.isEmpty()) {
            failures += "$name: no frame could be taken"
            return
        }
        // A sequence whose surface never opened measures nothing; say so next to its frames.
        val last = frames.last().page
        if (reference != null &&
            abs(last.pageLike - reference.page.pageLike) < 0.05 &&
            abs(last.luminance - reference.page.luminance) < 5
        ) {
            findings.append("  (the page looks unchanged at the end: did the surface open?)\n")
        }
        when (surface) {
            Surface.SHEET -> for (frame in frames) {
                val b = frame.band
                val gradient = b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3
                if (gradient) failures += "$name at ${frame.at} ms: band chroma %.1f edges %.4f page-like %.2f".format(b.chroma, b.edges, b.pageLike)
            }
            Surface.OVERVIEW -> {
                val settled = frames.last().page.pageLike
                for (frame in frames) {
                    if (frame.page.pageLike < 0.6 * settled && frame.page.pageLike < 0.15) {
                        failures += "$name at ${frame.at} ms: page-like share %.2f against %.2f once settled".format(frame.page.pageLike, settled)
                    }
                }
            }
        }
    }

    private fun describe(frame: Frame): String =
        "  %5d ms  band lum %5.1f chroma %5.1f edges %.4f page %.2f | page lum %5.1f chroma %5.1f page %.2f\n".format(
            frame.at, frame.band.luminance, frame.band.chroma, frame.band.edges, frame.band.pageLike,
            frame.page.luminance, frame.page.chroma, frame.page.pageLike
        )

    /** JPEG: a PNG of the window takes the emulator longer than the next frame. */
    private fun save(bitmap: Bitmap, name: String) {
        File(out, "snapshot-$name.jpg").outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it) }
    }

    companion object {
        private const val MENU_LABEL = "Menu"
        private const val SITE_ICON_LABEL = "Site information"
        /** Long enough for the slowest swap seen on the emulator (about a second) plus the sheet settling. */
        private const val PROBE_MS = 3_200L
    }
}
