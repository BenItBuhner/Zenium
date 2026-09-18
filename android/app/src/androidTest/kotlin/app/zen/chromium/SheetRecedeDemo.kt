package app.zen.chromium

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Records the phone sheets on the recede chassis over one page and measures the page while each
 * comes and goes: the app menu (open, closed by system back), the site-information sheet (open,
 * closed by a press on its scrim), a picker (the tab's context menu, then the icon picker it
 * opens), a stack of two (the external-protocol confirm – or, with no app for `tel:` on the
 * device, the location prompt – over the open menu, taken down one at a time), the menu dragged
 * a third of the way down by its handle, held and let go, and the predictive back gesture over
 * the site-information sheet: peeked and cancelled, then committed.
 *
 * Around every one of those the driver screenshots as fast as the emulator gives frames
 * (`sheets-<event>-<ms>ms.jpg`, with the time since the event) and measures a band across the
 * upper part of the page, which no sheet reaches. Two things fail the run: a frame in which that
 * band is the window gradient rather than the page or its picture (the swap was seen), and a
 * jump in the band's brightness that no spring could have made – larger than the sheet spring's
 * fastest rate over the time since the previous distinct frame, or any movement at all after
 * the page had stood still for a while following its transition (the old close: the scrim faded
 * with the sheet, then the page popped to full brightness when its picture went). A finger's
 * hold (the half drag, the peek) is exempt from the second rule's plateau clause, since letting
 * go is a second transition by design.
 *
 * `marks.txt` lists when each event happened, relative to the start of the sequence (`<ms>
 * <name> <transition|held>`), and `geometry.txt` the band in display pixels, so the workflow
 * can cut and measure the recording at its own, finer frame rate. `sheets-findings.txt`
 * carries every frame's numbers.
 *
 * Driven by the `android-sheet-recede-demo` workflow; see [DemoHarness] for the plumbing. The
 * page comes from a loopback server in this process ([DemoServer]). The `theme` instrumentation
 * argument (`light`, the default, or `dark`) picks the colour scheme.
 */
@RunWith(AndroidJUnit4::class)
class SheetRecedeDemo : DemoHarness("sheet-recede-demo-state.json", "sheets", "sheet-recede-demo") {
    override val tag = "SheetRecedeDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    private lateinit var server: DemoServer
    private var demoStart = 0L
    private val marks = StringBuilder()
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("sheet-recede-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            // Whatever cut the sequence short, what was measured up to then is worth having.
            File(out, "marks.txt").writeText(marks.toString())
            File(out, "sheets-findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("frames that showed the swap or a pop:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    /**
     * Gesture navigation and predictive back animations, before the app starts: the shared
     * recipe sets three-button navigation (no gesture zone under the bar), and the back gesture
     * is one of the things being recorded here. The window's insets change with it, which is
     * why it happens before the harness measures the window.
     */
    override fun beforeLaunch() {
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        shell("settings put global enable_back_animation 1")
        SystemClock.sleep(3_000)
        Log.i(tag, "navigation: ${shell("cmd overlay list").lines().filter { it.contains("navbar") }}")
    }

    /**
     * Let the page load, then open and close the menu and the site-information sheet once off
     * camera: the first sheet pays for layout and script compilation, which is not what is
     * being measured.
     */
    override fun warmUp() {
        finding("Zenium Android sheet recede (${theme}, ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_500)
        val f = Finger()
        f.tap(menuButton())
        awaitSurface(up = true, timeoutMs = 8_000)
        SystemClock.sleep(2_000)
        back()
        awaitSurface(up = false, timeoutMs = 8_000)
        SystemClock.sleep(2_000)
        f.tap(siteIcon())
        awaitSurface(up = true, timeoutMs = 8_000)
        SystemClock.sleep(2_000)
        back()
        awaitSurface(up = false, timeoutMs = 8_000)
        SystemClock.sleep(2_500)
        val page = pageArea()
        val band = band()
        File(out, "geometry.txt").writeText(
            "size $width $height\npage ${page.left} ${page.top} ${page.right} ${page.bottom}\n" +
                "band ${band.left} ${band.top} ${band.right} ${band.bottom}\n"
        )
        finding("page $page, band $band")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        demoStart = SystemClock.uptimeMillis()
        val f = Finger()

        // 1. The app menu, closed by system back.
        probe("menu-open", Kind.TRANSITION) { f.tap(menuButton()) }
        settleUp()
        probe("menu-close", Kind.TRANSITION) { back() }
        settleDown()

        // 2. Site information, closed by a press on its scrim.
        probe("siteinfo-open", Kind.TRANSITION) { f.tap(siteIcon()) }
        settleUp()
        probe("siteinfo-close", Kind.TRANSITION) { f.tap(scrimPoint()) }
        settleDown()

        // 3. A picker: the tab's context menu, then the icon picker its "Change Icon…" row opens
        //    (the menu slides away as the picker rises in the frame dialog host). The row sits
        //    below the menu's peek and is clicked through the accessibility tree, so the menu
        //    stays at its peek, under the band: pulled to its full height it would cover it.
        probe("context-open", Kind.TRANSITION) { coreInvoke("tab.contextMenu", "{\"tabId\":\"$TAB_ID\"}") }
        settleUp()
        var pickerUp = false
        if (findNode { it == CHANGE_ICON } != null) {
            probe("picker-open", Kind.TRANSITION) {
                if (!clickByLabel(CHANGE_ICON)) Log.w(tag, "'$CHANGE_ICON' took no click through the tree")
            }
            SystemClock.sleep(1_500)
            pickerUp = waitFor(PICKER_TITLE, 2_000) != null
            finding(
                if (pickerUp) "picker: '$PICKER_TITLE' is up, --zen-recede ${recedeValue()}"
                else "picker: '$PICKER_TITLE' never came up"
            )
        } else {
            finding("no '$CHANGE_ICON' row in the context menu")
        }
        if (pickerUp) {
            // System back when the chrome holds a surface for it (the chassis registers one for
            // the picker); a press on the scrim when it does not, as a back would leave the app.
            if (awaitSurface(up = true, timeoutMs = 1_000)) {
                finding("picker: closed by system back")
                probe("picker-close", Kind.TRANSITION) { back() }
            } else {
                finding("picker: no back surface for it; closed by a press on the scrim")
                probe("picker-close", Kind.TRANSITION) { f.tap(scrimPoint()) }
            }
        } else if (awaitSurface(up = true, timeoutMs = 500)) {
            finding("closing the context menu instead")
            probe("context-close", Kind.TRANSITION) { back() }
        }
        settleDown()

        // 4. A stack: the menu, then a second sheet over it, taken down one at a time. The
        //    second sheet is asked for by the page's script while the menu is up.
        f.tap(menuButton())
        settleUp()
        val second = secondSheet()
        finding("stacked sheet: $second")
        probe("stack-open", Kind.TRANSITION) { runInPage(second.script) }
        SystemClock.sleep(1_500)
        finding("stack: sheet on top titled '${findNode { it.startsWith("Open in") || it.startsWith("Allow") }?.let { it.text ?: it.contentDescription } ?: "?"}', --zen-recede ${recedeValue()}")
        probe("stack-close-top", Kind.TRANSITION) { back() }
        SystemClock.sleep(1_500)
        probe("stack-close", Kind.TRANSITION) { back() }
        settleDown()

        // 5. The menu dragged a third of the way down by its handle, held, and let go: the page
        //    is a third of the way back while the finger holds and settles with the sheet.
        f.tap(menuButton())
        settleUp()
        val handle = waitFor(MENU_HANDLE_LABEL, 4_000)
        if (handle != null) {
            val drop = 0.35f * (height - windowInsets().bottom - handle.top)
            probe("menu-halfdrag", Kind.HELD, HOLD_MS) {
                f.down(handle.exactCenterX(), handle.exactCenterY())
                f.moveBy(0f, drop, 600)
            }
            finding("half drag held ${drop.roundToInt()} px down: --zen-recede ${recedeValue()}")
            probe("menu-halfdrag-release", Kind.TRANSITION, RELEASE_MS) { f.up() }
            SystemClock.sleep(800)
        } else {
            finding("no '$MENU_HANDLE_LABEL' handle: skipping the half drag")
        }
        probe("menu-close-2", Kind.TRANSITION) { back() }
        settleDown()

        // 6. Predictive back over the site-information sheet: a thumb from the left edge, held
        //    a third of the way (the page comes back with it), returned to the edge (both spring
        //    back), then swiped through and let go (the sheet closes with the gesture).
        f.tap(siteIcon())
        settleUp()
        if (awaitSurface(up = true, timeoutMs = 4_000)) {
            probe("back-peek", Kind.HELD, HOLD_MS) { edgeSwipe(0.30f * width) }
            finding("back gesture held: --zen-recede ${recedeValue()}")
            probe("back-cancel", Kind.TRANSITION, RELEASE_MS) { cancelSwipe() }
            SystemClock.sleep(800)
            // The swipe and its hold before the mark: the event is the finger letting go.
            edgeSwipe(0.36f * width)
            probe("back-commit", Kind.TRANSITION) { commitSwipe() }
            settleDown()
        } else {
            finding("no surface up for the back gesture: skipping it")
        }
    }

    // --- the surfaces ----------------------------------------------------------------------------

    private fun Finger.tap(at: PointF) = tap(at.x, at.y)

    private fun menuButton(): PointF =
        waitFor(MENU_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "menu button not in the accessibility tree; tapping the end of the bar")
            PointF(width - 28 * density, pillY)
        }

    /** The site icon at the start of the pill; looked up before the clock starts. */
    private fun siteIcon(): PointF =
        waitFor(SITE_ICON_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "site icon not in the accessibility tree; tapping the start of the pill")
            PointF(pill.left + 22 * density, pillY)
        }

    /** A point on the scrim above any sheet: the middle of the measured band. */
    private fun scrimPoint(): PointF = band().let { PointF(it.exactCenterX(), it.exactCenterY()) }

    private class SecondSheet(val description: String, val script: String) {
        override fun toString() = description
    }

    /**
     * What the page asks for to put a second sheet over the menu: a `tel:` link, which the host
     * holds for the external-protocol confirm when an app on the device answers to it (the
     * dialer), else the location permission, whose prompt is a frame dialog – a sheet on a phone.
     */
    private fun secondSheet(): SecondSheet {
        val tel = Intent(Intent.ACTION_VIEW, Uri.parse("tel:5550100")).addCategory(Intent.CATEGORY_BROWSABLE)
        val dialer = app.packageManager.resolveActivity(tel, PackageManager.MATCH_DEFAULT_ONLY)
        return if (dialer != null) {
            SecondSheet(
                "external-protocol confirm for tel: (${dialer.loadLabel(app.packageManager)})",
                "location.href='tel:5550100'"
            )
        } else {
            SecondSheet(
                "location permission prompt (no app answers to tel:)",
                "navigator.geolocation.getCurrentPosition(function(){},function(){})"
            )
        }
    }

    /** Run `script` in the demo tab's page (its view may be hidden under a sheet; scripts still run). */
    private fun runInPage(script: String) {
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull()
            if (view == null) Log.w(tag, "no tab view to run the page script in")
            else view.evaluateJavascript(script, null)
        }
    }

    /** The chrome's `--zen-recede` as computed on its root: 0 with no sheet, 1 with one fully up. */
    private fun recedeValue(): String {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-recede').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.ifEmpty { "(unset)" } ?: "(unset)"
    }

    /** Poll the host for whether the chrome reports a dismissable surface. */
    private fun awaitSurface(up: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var state = false
            instrumentation.runOnMainSync { state = host.back.chromeSurfaceUp }
            if (state == up) return true
            SystemClock.sleep(150)
        }
        return false
    }

    /** A surface was asked for: wait for the chrome to have it, then for its spring to land. */
    private fun settleUp() {
        if (!awaitSurface(up = true, timeoutMs = 6_000)) Log.w(tag, "no surface came up")
        SystemClock.sleep(1_500)
    }

    /** A surface was dismissed: wait for the chrome to be rid of it, then for the page to be back. */
    private fun settleDown() {
        if (!awaitSurface(up = false, timeoutMs = 8_000)) Log.w(tag, "the surface did not go")
        SystemClock.sleep(2_000)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    // --- the back gesture ------------------------------------------------------------------------

    private var finger: Finger? = null
    private var fingerX = 0f

    /**
     * A thumb from the left screen edge: down in the gesture inset, out to `dx`, and held there.
     * The gesture stays down; follow with [cancelSwipe] or [commitSwipe].
     */
    private fun edgeSwipe(dx: Float) {
        ensureForeground()
        val f = Finger()
        // Below the middle, so the system's arrow does not sit on the sheet's title.
        f.down(EDGE_X, height * 0.6f)
        f.moveBy(dx, 0f, 650)
        f.hold(300)
        finger = f
        fingerX = EDGE_X + dx
    }

    /** Back to the edge and let go: the system cancels the gesture. */
    private fun cancelSwipe() {
        val f = finger ?: return
        finger = null
        f.moveBy(EDGE_X + 4f - fingerX, 0f, 450)
        f.hold(250)
        f.up()
    }

    /** Let go where it is: the system commits the gesture. */
    private fun commitSwipe() {
        val f = finger ?: return
        finger = null
        f.up()
    }

    // --- frames ----------------------------------------------------------------------------------

    private enum class Kind { TRANSITION, HELD }

    private class Metrics(val luminance: Double, val chroma: Double, val edges: Double, val pageLike: Double)

    private class Frame(val at: Long, val band: Metrics)

    /**
     * Screenshot the page just before `action`, run it, then screenshot for `probeMs` as fast as
     * the emulator allows, measuring every frame, and judge the frames. A frame's time is the
     * middle of the call that took it, since the event; the event is marked for the workflow.
     */
    private fun probe(name: String, kind: Kind, probeMs: Long = PROBE_MS, action: () -> Unit) {
        val before = ui.takeScreenshot()
        val reference = before?.let { Frame(0, measure(it, band())) }
        before?.let { save(it, "$name-before") }
        before?.recycle()
        val t0 = SystemClock.uptimeMillis()
        marks.append("${t0 - demoStart} $name ${kind.name.lowercase()}\n")
        action()
        val frames = ArrayList<Frame>()
        while (SystemClock.uptimeMillis() - t0 < probeMs) {
            val started = SystemClock.uptimeMillis()
            val shot = ui.takeScreenshot() ?: continue
            val at = (started + SystemClock.uptimeMillis()) / 2 - t0
            frames += Frame(at, measure(shot, band()))
            save(shot, "$name-${at}ms")
            shot.recycle()
        }
        judge(name, kind, reference, frames)
    }

    /** The content frame: below the status bar and above the bar. */
    private fun pageArea(): Rect {
        val insets = windowInsets()
        val pad = (8 * density).roundToInt()
        return Rect(pad, insets.top + pad, width - pad, pill.top - 2 * pad)
    }

    /**
     * The band measured: the upper part of the page, which a sheet coming from the bottom never
     * reaches, inset enough that the receded frame (97 percent, about its centre) still fills it.
     */
    private fun band(): Rect {
        val page = pageArea()
        val inset = (page.width() * 0.1f).roundToInt()
        return Rect(
            page.left + inset,
            page.top + (page.height() * 0.05f).roundToInt(),
            page.right - inset,
            page.top + (page.height() * 0.30f).roundToInt()
        )
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
     * The band must look like the page in every frame – text edges or grey-white pixels, never
     * the smooth tinted window gradient – and its brightness may only move the way a spring
     * moves it: no jump larger than the sheet spring's fastest rate over the time since the last
     * distinct frame, and for a transition no movement at all after the page had stood still
     * for [PLATEAU_MS] following its first change (a pop after the sheet had settled).
     */
    private fun judge(name: String, kind: Kind, reference: Frame?, frames: List<Frame>) {
        findings.append("$name: ${frames.size} frames\n")
        reference?.let { findings.append(describe(it, "before")) }
        for (frame in frames) findings.append(describe(frame))
        if (frames.isEmpty()) {
            failures += "$name: no frame could be taken"
            return
        }
        for (frame in frames) {
            val b = frame.band
            if (b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3) {
                failures += "$name at ${frame.at} ms: the window gradient where the page was (band chroma %.1f edges %.4f page-like %.2f)".format(b.chroma, b.edges, b.pageLike)
            }
        }
        val series = listOfNotNull(reference) + frames
        val lows = series.minOf { it.band.luminance }
        val highs = series.maxOf { it.band.luminance }
        val amplitude = highs - lows
        if (amplitude < 3 * NOISE) {
            findings.append("  (the page's brightness never moved: did the surface come up?)\n")
            return
        }
        var last = series[0]
        var moved = false
        var worst = 0.0
        for (frame in series.drop(1)) {
            val d = frame.band.luminance - last.band.luminance
            // Within noise of the last distinct frame: the same picture; the interval accumulates.
            if (abs(d) <= NOISE) continue
            val dt = frame.at - last.at
            val share = abs(d) / amplitude
            val allowed = RATE_PER_S * dt / 1000.0 + NOISE / amplitude
            worst = max(worst, share)
            if (share > allowed) {
                failures += "$name at ${frame.at} ms: brightness stepped %.0f%% of the way in %d ms (a spring moves at most %.0f%% in that time)".format(share * 100, dt, min(1.0, allowed) * 100)
            }
            if (kind == Kind.TRANSITION && moved && dt >= PLATEAU_MS) {
                failures += "$name at ${frame.at} ms: the page moved again (%.1f) after standing still for %d ms – a pop after the sheet had settled".format(d, dt)
            }
            moved = true
            last = frame
        }
        findings.append("  brightness %.1f → %.1f (range %.1f), biggest step %.0f%% of the range\n".format(series.first().band.luminance, series.last().band.luminance, amplitude, worst * 100))
    }

    private fun describe(frame: Frame, label: String = "${frame.at} ms"): String =
        "  %10s  lum %5.1f chroma %5.1f edges %.4f page-like %.2f\n".format(
            label, frame.band.luminance, frame.band.chroma, frame.band.edges, frame.band.pageLike
        )

    /** JPEG: a PNG of the window takes the emulator longer than the next frame. */
    private fun save(bitmap: Bitmap, name: String) {
        File(out, "sheets-$name.jpg").outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it) }
    }

    private fun finding(line: String) {
        findings.append(line).append('\n')
        Log.i(tag, line)
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val PORT = 18134
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB_ID = "tab_article"
        private const val SITE_ICON_LABEL = "Site information"
        private const val CHANGE_ICON = "Change Icon…"
        /** The icon picker's heading. */
        private const val PICKER_TITLE = "Change icon"
        /** Inside the system's back-gesture inset on any density. */
        private const val EDGE_X = 2f
        /** Long enough for the slowest capture seen on the emulator (about a second) plus the sheet settling. */
        private const val PROBE_MS = 3_200L
        /** A finger's hold: the frames of the page part of the way back. */
        private const val HOLD_MS = 1_400L
        /** After letting go: the spring back to rest. */
        private const val RELEASE_MS = 2_400L
        /** Brightness (0…255) two frames of the same picture differ by, JPEG and dithering included. */
        private const val NOISE = 2.0
        /**
         * The fastest a sheet spring moves anything driven by it, as a share of the whole way per
         * second: `SPRING_SNAPPY` (420 / 40) peaks at 7.7, `SPRING_GENTLE` (300 / 31) at 6.9; the
         * margin is for a frame's time being the middle of the call that took it.
         */
        private const val RATE_PER_S = 10.0
        /** Standing still this long after a change is the sheet having settled. */
        private const val PLATEAU_MS = 400L
    }
}
