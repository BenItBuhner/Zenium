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
 * The judgement is made frame by frame, with no clock in it, because the emulator that records
 * this paints two to five frames a second: any spring sampled that sparsely shows big steps
 * between frames, so a step's size over time says nothing. What does is that the page and the
 * sheet are driven by one value. Before the sequence starts the driver puts a small swatch into
 * the chrome (test-only, `#zen-demo-recede`), a bar in the status-bar area – which no page view
 * ever covers – whose width is `--zen-recede` times a known length, so every frame carries the
 * progress value the chassis is painting from. A frame is then read for two numbers: the
 * sheet's progress `p` from the swatch, and how far the page has gone dark, from the brightness
 * of a band across its upper part, which no sheet reaches, against the same band with no sheet
 * and under one fully up. Two things fail the run: a frame in which that band is the window
 * gradient rather than the page or its picture (the swap was seen), and a frame in which the
 * page's darkness and the sheet's progress disagree by more than [TOLERANCE] of the way – the
 * page still dark after the sheet has gone (the old close: the scrim went with the sheet, then
 * the page popped bright when its picture did), or dark in one step while the sheet is not yet
 * up (the old open), or lagging its own sheet by a frame. The second sheet of a stack is fine by
 * the rule: the page holds its recede and the stack's one scrim while it comes and goes.
 *
 * `marks.txt` lists when each event happened, relative to the start of the sequence (`<ms>
 * <name> <transition|held>`), and `geometry.txt` the band and the swatch in display pixels, so
 * the workflow can cut and read the recording at its own, finer frame rate with the same two
 * rules (android-sheet-recede-frames.mjs). `sheets-findings.txt` carries every screenshot's
 * numbers.
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
    /** Where the swatch is on the screen, once it has been put in; empty until then. */
    private var swatch = Rect()
    /** The band's brightness with no sheet up (the live page) and under one fully up, from the warm-up. */
    private var bright = Double.NaN
    private var dark = Double.NaN

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
        assertTrue("frames that showed the swap or a page out of step with its sheet:\n" + failures.joinToString("\n"), failures.isEmpty())
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
     * Let the page load, put the swatch in, then open and close the menu and the site-information
     * sheet once off camera: the first sheet pays for layout and script compilation, which is
     * not what is being measured. The menu fully up and the page with no sheet give the two
     * brightnesses every frame is read against.
     */
    override fun warmUp() {
        finding("Zenium Android sheet recede (${theme}, ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_500)
        placeSwatch()
        val f = Finger()
        f.tap(menuButton())
        settleUp()
        SystemClock.sleep(1_000)
        ui.takeScreenshot()?.let {
            dark = measure(it, band()).luminance
            finding("menu up: --zen-recede ${recedeValue()}, swatch p %.3f, band %.1f".format(progress(it), dark))
            save(it, "warmup-menu-up")
            it.recycle()
        }
        back()
        settleDown()
        f.tap(siteIcon())
        settleUp()
        SystemClock.sleep(1_000)
        ui.takeScreenshot()?.let {
            finding("site information up: --zen-recede ${recedeValue()}, swatch p %.3f, band %.1f".format(progress(it), measure(it, band()).luminance))
            it.recycle()
        }
        back()
        settleDown()
        SystemClock.sleep(1_500)
        ui.takeScreenshot()?.let {
            bright = measure(it, band()).luminance
            finding("no sheet: --zen-recede ${recedeValue()}, swatch p %.3f, band %.1f".format(progress(it), bright))
            save(it, "warmup-no-sheet")
            it.recycle()
        }
        val page = pageArea()
        val band = band()
        File(out, "geometry.txt").writeText(
            "size $width $height\npage ${page.left} ${page.top} ${page.right} ${page.bottom}\n" +
                "band ${band.left} ${band.top} ${band.right} ${band.bottom}\n" +
                "swatch ${swatch.left} ${swatch.top} ${swatch.width()} ${swatch.height()} ${swatchColour()}\n"
        )
        finding("page $page, band $band, swatch $swatch (${swatchColour()}), band %.1f bright / %.1f dark".format(bright, dark))
        if (bright.isNaN() || dark.isNaN() || bright - dark < 6 * NOISE) {
            failures += "the band's brightness with the menu up (%.1f) and without a sheet (%.1f) do not tell the page dark from bright".format(dark, bright)
        }
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
            settleUp()
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
        settleUp()
        finding("stack: sheet on top titled '${findNode { it.startsWith("Open in") || it.startsWith("Allow") }?.let { it.text ?: it.contentDescription } ?: "?"}', --zen-recede ${recedeValue()}")
        probe("stack-close-top", Kind.TRANSITION) { back() }
        settleUp()
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
            settleUp()
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
            settleUp()
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

    /** [recedeValue] as a number: 0 when unset. */
    private fun recedeNumber(): Double = recedeValue().toDoubleOrNull() ?: 0.0

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

    /**
     * Poll `--zen-recede` until `settled` accepts it, or `timeoutMs` has passed; true when it
     * did. The value is what the chassis paints from, so it says when a spring has landed
     * better than any wait would on an emulator whose pace changes from frame to frame.
     */
    private fun awaitRecede(timeoutMs: Long, settled: (Double) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled(recedeNumber())) return true
            SystemClock.sleep(120)
        }
        return false
    }

    /** A surface was asked for: wait for the chrome to have it, then for its spring to land at the top. */
    private fun settleUp() {
        if (!awaitSurface(up = true, timeoutMs = 8_000)) Log.w(tag, "no surface came up")
        if (!awaitRecede(SETTLE_MS) { it >= 0.995 }) Log.w(tag, "the recede did not reach 1: ${recedeValue()}")
        // The value lands a frame before the last paint reaches the screen.
        SystemClock.sleep(400)
    }

    /**
     * A surface was dismissed: wait for the chrome to be rid of it, for the recede to be back at
     * zero, then for the live page to have been drawn again and its picture taken away.
     */
    private fun settleDown() {
        if (!awaitSurface(up = false, timeoutMs = 10_000)) Log.w(tag, "the surface did not go")
        if (!awaitRecede(SETTLE_MS) { it <= 0.005 }) Log.w(tag, "the recede did not return to 0: ${recedeValue()}")
        SystemClock.sleep(1_200)
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

    // --- the swatch ------------------------------------------------------------------------------

    /**
     * Put the progress swatch into the chrome: a fixed bar in the status-bar area, below the
     * clock and the icons, from about a fifth of the way across to about three quarters, whose
     * width is `--zen-recede` times [SWATCH_LENGTH_SHARE] of the screen. It reads the root's
     * variable through `var()`, so it moves in the very style pass that moves the page and the
     * sheet: a frame shows all three as they were together. Black on the light scheme, white on
     * the dark, above everything and taking no input. Test-only; the product has no such thing.
     */
    private fun placeSwatch() {
        val insets = windowInsets()
        val left = (width * SWATCH_START_SHARE).roundToInt()
        val length = (width * SWATCH_LENGTH_SHARE).roundToInt()
        val h = (SWATCH_HEIGHT_DP * density).roundToInt()
        // Below the status bar's icon row, above the page's frame: the bar's lower part.
        val top = insets.top - h - (3 * density).roundToInt()
        swatch = Rect(left, top, left + length, top + h)
        val css = "position:fixed;left:${left / density}px;top:${top / density}px;height:${h / density}px;" +
            "width:calc(var(--zen-recede,0)*${length / density}px);background:${if (theme == "dark") "#fff" else "#000"};" +
            "z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;border-radius:0"
        val result = chromeJs(
            "(function(){var el=document.getElementById('zen-demo-recede');" +
                "if(!el){el=document.createElement('div');el.id='zen-demo-recede';document.body.appendChild(el);}" +
                "el.style.cssText=${jsString(css)};return el.getBoundingClientRect().height;})()"
        )
        finding("swatch placed at $swatch (${swatchColour()}); the chrome says its height is $result")
    }

    private fun swatchColour() = if (theme == "dark") "white" else "black"

    private fun jsString(s: String): String = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    /**
     * The sheet's progress a screenshot shows: the swatch's width as a share of its full length,
     * read along its middle rows as the count of columns that are the swatch's colour in at
     * least two of three rows (the bar is one piece from its start, and the count does not care
     * whether the chrome snapped its edge a pixel either way). NaN before the swatch is in place.
     */
    private fun progress(bitmap: Bitmap): Double {
        if (swatch.isEmpty) return Double.NaN
        val r = Rect(swatch)
        r.intersect(0, 0, bitmap.width, bitmap.height)
        if (r.isEmpty || r.height() < 3) return Double.NaN
        val rows = intArrayOf(r.top + r.height() / 2 - 1, r.top + r.height() / 2, r.top + r.height() / 2 + 1)
        val line = IntArray(r.width())
        val hits = IntArray(r.width())
        for (y in rows) {
            bitmap.getPixels(line, 0, r.width(), r.left, y, r.width(), 1)
            for (x in line.indices) if (isSwatch(luminance(line[x]))) hits[x]++
        }
        return hits.count { it >= 2 }.toDouble() / swatch.width()
    }

    private fun isSwatch(l: Double) = if (theme == "dark") l > 175 else l < 90

    private fun luminance(p: Int): Double =
        0.299 * ((p shr 16) and 0xff) + 0.587 * ((p shr 8) and 0xff) + 0.114 * (p and 0xff)

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

    private class Frame(val at: Long, val band: Metrics, val progress: Double)

    /**
     * Screenshot the page just before `action`, run it, then screenshot for `probeMs` as fast as
     * the emulator allows, reading every frame, and judge the frames. A frame's time is the
     * middle of the call that took it, since the event; the event is marked for the workflow.
     */
    private fun probe(name: String, kind: Kind, probeMs: Long = PROBE_MS, action: () -> Unit) {
        val before = ui.takeScreenshot()
        val reference = before?.let { Frame(0, measure(it, band()), progress(it)) }
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
            frames += Frame(at, measure(shot, band()), progress(shot))
            save(shot, "$name-${at}ms")
            shot.recycle()
        }
        judge(name, reference, frames)
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

    /** How far the band has gone dark, 0 (the page with no sheet) to 1 (under a sheet fully up). */
    private fun darkness(luminance: Double): Double =
        if (bright.isNaN() || dark.isNaN() || bright - dark <= 0) Double.NaN else (bright - luminance) / (bright - dark)

    /**
     * The band must look like the page in every frame – text edges or grey-white pixels, never
     * the smooth tinted window gradient – and its darkness must agree with the sheet's progress
     * the swatch shows in the same frame, within [TOLERANCE] of the way (plus the noise's share):
     * they are one value in the chassis, so a frame in which they differ is the page popping,
     * stalling or lagging on its own.
     */
    private fun judge(name: String, reference: Frame?, frames: List<Frame>) {
        findings.append("$name: ${frames.size} frames\n")
        reference?.let { findings.append(describe(it, "before")) }
        for (frame in frames) findings.append(describe(frame))
        if (frames.isEmpty()) {
            failures += "$name: no frame could be taken"
            return
        }
        val series = listOfNotNull(reference) + frames
        var worst = 0.0
        for (frame in series) {
            val b = frame.band
            if (b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3) {
                failures += "$name at ${frame.at} ms: the window gradient where the page was (band chroma %.1f edges %.4f page-like %.2f)".format(b.chroma, b.edges, b.pageLike)
                continue
            }
            val d = darkness(b.luminance)
            if (d.isNaN() || frame.progress.isNaN()) continue
            val gap = abs(d - frame.progress)
            worst = max(worst, gap)
            if (gap > TOLERANCE + NOISE / (bright - dark)) {
                failures += "$name at ${frame.at} ms: the page is %.0f%% of the way dark while the sheet's progress is %.0f%%".format(d * 100, frame.progress * 100)
            }
        }
        findings.append(
            "  progress %.2f → %.2f, darkness %.2f → %.2f, largest disagreement %.0f%% of the way\n".format(
                series.first().progress, series.last().progress,
                darkness(series.first().band.luminance), darkness(series.last().band.luminance), worst * 100
            )
        )
    }

    private fun describe(frame: Frame, label: String = "${frame.at} ms"): String =
        "  %10s  p %.3f dark %.3f  lum %5.1f chroma %5.1f edges %.4f page-like %.2f\n".format(
            label, frame.progress, darkness(frame.band.luminance),
            frame.band.luminance, frame.band.chroma, frame.band.edges, frame.band.pageLike
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
        /**
         * Long enough for the whole of a transition on the recording emulator, whose two to five
         * frames a second stretch a half-second spring to about three, after a wait of up to
         * three for the page's picture before a sheet comes up.
         */
        private const val PROBE_MS = 6_500L
        /** A finger's hold: the frames of the page part of the way back. */
        private const val HOLD_MS = 1_400L
        /** After letting go: the spring back to rest. */
        private const val RELEASE_MS = 4_000L
        /** The longest a spring is given to land, on that emulator. */
        private const val SETTLE_MS = 8_000L
        /** Brightness (0…255) two frames of the same picture differ by, JPEG and dithering included. */
        private const val NOISE = 2.0
        /**
         * How far apart, as a share of the whole way, the page's darkness and the sheet's progress
         * may be in one frame: the picture's brightness differs from the live page's by under a
         * hundredth of the way, the receded frame's content shifts by less, and the recorder adds
         * its noise; the old close and open were half the way or more apart.
         */
        private const val TOLERANCE = 0.08
        /** The swatch starts this far across the screen and runs this share of it at full progress. */
        private const val SWATCH_START_SHARE = 0.21f
        private const val SWATCH_LENGTH_SHARE = 0.55f
        private const val SWATCH_HEIGHT_DP = 9f
    }
}
