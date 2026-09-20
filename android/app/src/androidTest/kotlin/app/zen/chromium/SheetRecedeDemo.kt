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
import kotlin.math.sqrt

/**
 * Records the phone sheets on the recede chassis over one page and measures the page while each
 * comes and goes: the app menu (open, closed by system back), the site-information sheet (open,
 * closed by a press on its scrim), a picker (the tab's context menu, then the icon picker it
 * opens), a stack of two (the external-protocol confirm – or, with no app for `tel:` on the
 * device, the location prompt – over the open menu, taken down one at a time), the menu dragged
 * a third of the way down by its handle, held and let go, the predictive back gesture over the
 * site-information sheet: peeked and cancelled, then committed; then the bookmark editor (a
 * `PhoneSheet` form) with its Address field tapped, so the keyboard comes up under a focused
 * field and the sheet grows to keep it above the keys; and the menu once more with the bar
 * docked at the top edge, where nothing covers the bar and it does not fade: it stands at 1
 * under the scrim like the page (§11.1, ruled 23:50 – the fade is the bottom-docked bar's).
 *
 * Besides the page, three things are read from the chrome as they go: where the focus is once
 * a sheet is up (§9.22: inside it – the review of #168 found the bookmark editor and the
 * clear-history prompt keeping it on their opener), the frame-dialog host's slot while the
 * picker rises and leaves (its slide's offset against the whole of its height, the 22:49
 * ruling), and the bar's computed opacity at either edge (0 at p = 1 at the bottom, 1 at the
 * top). The bar at the top edge is also measured in every frame: the texture left in its band,
 * against the bar at rest, must be `1 − a·p` – the bar at 1 under the scrim at `a·p` – and
 * `1 − a` at p = 1.
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
 * <name> <transition|held|record>`), and `geometry.txt` the band and the swatch in display
 * pixels, so the workflow can cut and read the recording at its own, finer frame rate with the
 * same two rules (android-sheet-recede-frames.mjs); a `record` event's frames are cut but not
 * judged by the band (the keyboard grows a sheet up towards it, and the top-docked bar moves
 * the page under it), the driver judges those by the step's own rule. `sheets-findings.txt`
 * carries every screenshot's numbers.
 *
 * Driven by the `android-sheet-recede-demo` workflow; see [DemoHarness] for the plumbing. The
 * page comes from a loopback server in this process ([DemoServer]). The `theme` instrumentation
 * argument (`light`, the default, or `dark`) picks the colour scheme.
 *
 * The jank record ([traceFrames], `frames.jsonl`): before the probed steps the menu is opened
 * and closed once with no camera on it, the `menu-sheet-open` and `menu-sheet-close` scenes
 * (`open`), each with the chrome WebView's trace around it (the renderer main thread's layouts,
 * paints and time per frame while the sheet mounts and springs), whose numbers the budget's gate
 * (`jankGate`, soft unless the workflow says hard) reports or fails. The cycle is unmarked, so the
 * recording's judgement begins at step 1.
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
            dark = measureBand(it, band()).luminance
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
            finding("site information up: --zen-recede ${recedeValue()}, swatch p %.3f, band %.1f".format(progress(it), measureBand(it, band()).luminance))
            it.recycle()
        }
        back()
        settleDown()
        SystemClock.sleep(1_500)
        ui.takeScreenshot()?.let {
            bright = measureBand(it, band()).luminance
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

        // 0. The app menu up and down once with nothing else running: the jank record's two `open`
        //    scenes (DemoHarness.traceFrames). The probes below screenshot as fast as the emulator
        //    gives frames while a sheet moves, which the app's own frames would pay for, so the
        //    frames are read here, on the cycle before them; the menu button is found before the
        //    block (a read of the tree is the app's main thread's work). The block waits [MOTION_MS]
        //    for the spring: a frame nothing moves in is no frame, so a wait past the landing costs
        //    the reading nothing.
        val menu = menuButton()
        traceFrames("menu-sheet-open", JankBudget.Kind.OPEN) {
            f.tap(menu)
            SystemClock.sleep(MOTION_MS)
        }
        settleUp()
        traceFrames("menu-sheet-close", JankBudget.Kind.OPEN) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        settleDown()

        // 1. The app menu, closed by system back.
        probe("menu-open", Kind.TRANSITION) { f.tap(menuButton()) }
        settleUp()
        focusReport("menu")
        finding("bar (bottom edge) with the menu up: --zen-recede ${recedeValue()}, computed opacity ${barOpacity()}")
        probe("menu-close", Kind.TRANSITION) { back() }
        settleDown()
        finding("bar (bottom edge) with no sheet: computed opacity ${barOpacity()}")

        // 2. Site information, closed by a press on its scrim.
        probe("siteinfo-open", Kind.TRANSITION) { f.tap(siteIcon()) }
        settleUp()
        focusReport("site information")
        probe("siteinfo-close", Kind.TRANSITION) { f.tap(scrimPoint()) }
        settleDown()

        // 3. A picker: the tab's context menu, then the icon picker its "Change Icon…" row opens
        //    (the menu slides away as the picker rises in the frame dialog host). The row sits
        //    below the menu's peek and is clicked through the accessibility tree, so the menu
        //    stays at its peek, under the band: pulled to its full height it would cover it.
        probe("context-open", Kind.TRANSITION) { coreInvoke("tab.contextMenu", "{\"tabId\":\"$TAB_ID\"}") }
        settleUp()
        var pickerUp = false
        // The frame-dialog host's slot as the picker rises and leaves: the whole of its height
        // slides in across the frame's bottom edge (the 22:49 ruling), sampled with every frame.
        val slide = ArrayList<String>()
        if (findNode { it == CHANGE_ICON } != null) {
            // Kept on the tree's click (the rule in DemoHarness names the exception): the row sits
            // below the menu's peek, where no finger reaches it, and the menu must stay at the
            // peek for the band that is measured; this driver's injected touch on a sheet is the
            // editor's field below.
            probe("picker-open", Kind.TRANSITION, sample = { slotPose().also { slide += it } }) {
                if (!clickByLabel(CHANGE_ICON)) Log.w(tag, "'$CHANGE_ICON' took no click through the tree")
            }
            settleUp()
            pickerUp = waitFor(PICKER_TITLE, 2_000) != null
            finding(
                if (pickerUp) "picker: '$PICKER_TITLE' is up, --zen-recede ${recedeValue()}, slot ${slotPose()}"
                else "picker: '$PICKER_TITLE' never came up"
            )
        } else {
            finding("no '$CHANGE_ICON' row in the context menu")
        }
        if (pickerUp) {
            judgeSlide("picker-open", slide, arriving = true)
            slide.clear()
            // System back when the chrome holds a surface for it (the chassis registers one for
            // the picker); a press on the scrim when it does not, as a back would leave the app.
            if (awaitSurface(up = true, timeoutMs = 1_000)) {
                finding("picker: closed by system back")
                probe("picker-close", Kind.TRANSITION, sample = { slotPose().also { slide += it } }) { back() }
            } else {
                finding("picker: no back surface for it; closed by a press on the scrim")
                probe("picker-close", Kind.TRANSITION, sample = { slotPose().also { slide += it } }) { f.tap(scrimPoint()) }
            }
            judgeSlide("picker-close", slide, arriving = false)
        } else if (awaitSurface(up = true, timeoutMs = 500)) {
            finding("closing the context menu instead")
            probe("context-close", Kind.TRANSITION) { back() }
        }
        settleDown()
        if (pickerUp) {
            // Idle again: the host is not promoted (§9.33), and its slot takes no input.
            val idle = slotPose()
            finding("frame dialog host idle: $idle")
            if (idle.contains("\"willChange\":\"") && !idle.contains("\"willChange\":\"auto\"")) {
                failures += "the frame dialog host stays promoted while idle: $idle"
            }
        }

        // 4. A stack: the menu, then a second sheet over it, taken down one at a time. The
        //    second sheet is asked for by the page's script while the menu is up.
        f.tap(menuButton())
        settleUp()
        val second = secondSheet()
        finding("stacked sheet: $second")
        probe("stack-open", Kind.TRANSITION) { runInPage(second.script) }
        settleUp()
        finding("stack: sheet on top titled '${findNode { it.startsWith("Open in") || it.startsWith("Allow") }?.let { it.text ?: it.contentDescription } ?: "?"}', --zen-recede ${recedeValue()}")
        focusReport("stacked sheet")
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

        // 7. A sheet with a focused field over the keyboard: the star saves the page and its
        //    toast offers Edit, which opens the bookmark editor (a PhoneSheet form in the frame
        //    dialog host; focus lands on the dialog, §9.22). Its Address field tapped, the
        //    keyboard comes up under the focused field and the sheet grows to keep the field
        //    above the keys (the 18:24 detents rule); back takes the keyboard down, then the sheet.
        coreInvoke("bookmark.star", "{\"tabId\":\"$TAB_ID\"}")
        if (waitFor(EDIT_LABEL, 5_000) != null) {
            probe("editor-open", Kind.TRANSITION) {
                if (!clickByLabel(EDIT_LABEL)) Log.w(tag, "'$EDIT_LABEL' took no click through the tree")
            }
            settleUp()
            if (!focusReport("bookmark editor")) failures += "bookmark editor: the focus did not move into the sheet on open (§9.22)"
            val field = addressField()
            if (field != null) {
                finding("editor before the keyboard: ${editorPose()}, keyboard inset ${imeInset()} px")
                probe("editor-keyboard", Kind.RECORD, KEYBOARD_MS, sample = { editorPose() }) {
                    f.tap(field.exactCenterX(), field.exactCenterY())
                }
                // The editor sheet's injected touch (the rule in DemoHarness): the field takes the
                // finger and the keyboard comes up for it.
                if (!awaitIme(shown = true)) touchFault("the touch on the bookmark editor's Address field at $field raised no keyboard")
                SystemClock.sleep(800)
                judgeKeyboard(editorPose())
                ui.takeScreenshot()?.let { save(it, "editor-keyboard-up"); it.recycle() }
                back()
                awaitIme(shown = false)
                SystemClock.sleep(1_200)
                finding("editor after the keyboard: ${editorPose()}, keyboard inset ${imeInset()} px")
            } else {
                finding("no address field in the editor: the keyboard is not measured")
            }
            probe("editor-close", Kind.TRANSITION) { back() }
            settleDown()
        } else {
            finding("the star's toast offered no '$EDIT_LABEL': the editor is not measured")
        }

        // 8. The bar docked at the top edge: the menu up and down once more. A top-docked bar is
        //    not in the sheet's path and does NOT fade (§11.1, ruled 23:50): it stays at opacity
        //    1, inert, and the scrim dims it like the page. Nothing else covers the bar there,
        //    so the scrim's work is in every frame: the texture left in its band against the bar
        //    at rest must be the bar at 1 under the scrim at a·p – `1 − a·p`, and `1 − a` at
        //    p = 1, never 0 (the fade is the bottom-docked bar's, step 1). The move itself is a
        //    recorded event, so the page band – laid out for the bottom bar, and under the bar
        //    from here on – is judged by no window past this point.
        probe("bar-dock-top", Kind.RECORD, 2_500) { coreInvoke("settings.update", "{\"phoneBarPosition\":\"top\"}") }
        SystemClock.sleep(1_000)
        val bar = barRect()
        if (bar != null) {
            ui.takeScreenshot()?.let {
                barRest = measureBand(it, bar).spread
                save(it, "bar-top-rest")
                it.recycle()
            }
            finding("bar docked top: $bar, texture at rest %.2f, computed opacity ${barOpacity()}".format(barRest))
            val frames = ArrayList<Frame>()
            frames += probe("bar-top-menu-open", Kind.RECORD, extra = bar) { f.tap(menuButton()) }
            settleUp()
            ui.takeScreenshot()?.let {
                val share = measureBand(it, bar).spread / barRest
                val a = scrimAlpha()
                val opacity = barOpacity()
                finding("bar (top edge) with the menu up: --zen-recede ${recedeValue()}, texture %.3f of the bar at rest (spec 1 − a = %.2f), computed opacity $opacity (spec 1)".format(share, 1 - a))
                if (opacity.toDoubleOrNull() != 1.0) failures += "bar-top: the bar's computed opacity is $opacity at p = 1 (spec 1: a top-docked bar does not fade)"
                if (abs(share - (1 - a)) > BAR_TOLERANCE) failures += "bar-top: the bar shows %.3f of its texture at p = 1 (spec 1 − a = %.2f: at 1 under the scrim alone)".format(share, 1 - a)
                save(it, "bar-top-menu-up")
                it.recycle()
            }
            frames += probe("bar-top-menu-close", Kind.RECORD, extra = bar) { back() }
            settleDown()
            judgeBar("bar-top", frames)
        } else {
            finding("no bar to measure at the top edge")
        }
        coreInvoke("settings.update", "{\"phoneBarPosition\":\"bottom\"}")
        SystemClock.sleep(1_500)
    }

    // --- the chrome, read as it goes -------------------------------------------------------------

    /**
     * Where the focus is with a sheet up (§9.22): the active element and whether it is inside a
     * sheet (the dialog, a row, a control; the review of #168 found it left on the opener). True
     * when it is inside.
     */
    private fun focusReport(label: String): Boolean {
        val raw = chromeJs(
            "(function(){var a=document.activeElement;if(!a||a===document.body)return 'nothing (body)';" +
                "var d=a.closest('.zen-sheet,[role=dialog]');" +
                "var name=a.getAttribute('aria-label')||a.getAttribute('placeholder')||(a.textContent||'').trim().slice(0,40);" +
                "return a.tagName.toLowerCase()+(a.getAttribute('role')?'[role='+a.getAttribute('role')+']':'')+" +
                "(name?' \"'+name+'\"':'')+(d?' inside the sheet':' OUTSIDE any sheet');})()"
        )
        val where = (JSONTokener(raw).nextValue() as? String) ?: raw
        finding("$label: focus on $where")
        return where.endsWith("inside the sheet")
    }

    /** The bar's computed opacity: main.css's `1 − recede` at rest, whatever the shell writes over it. */
    private fun barOpacity(): String {
        val raw = chromeJs("(function(){var b=document.querySelector('.zen-phone-bar');return b?getComputedStyle(b).opacity:'no bar';})()")
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /** The scrim token's alpha (`--zen-scrim-alpha`): .4 light, .55 dark. */
    private fun scrimAlpha(): Double {
        val raw = chromeJs("getComputedStyle(document.documentElement).getPropertyValue('--zen-scrim-alpha').trim()")
        return (JSONTokener(raw).nextValue() as? String)?.toDoubleOrNull() ?: 0.4
    }

    /**
     * The frame-dialog host's slot as the chassis last painted it, as JSON: the root's
     * `--zen-recede`, the slide's offset `ty` (CSS px, from the inline transform), its `travel`
     * (the slot's height above the highest panel's top edge: the whole of the sheet), the slot's
     * height and the panel's top, its opacity, `will-change`, and whether the host is up.
     */
    private fun slotPose(): String {
        val raw = chromeJs(
            "(function(){var s=document.querySelector('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot');" +
                "if(!s)return 'no slot';var m=/translate3d\\(0(?:px)?, ?(-?[\\d.]+)px/.exec(s.style.transform||'');" +
                "var top=Infinity;for(var i=0;i<s.children.length;i++){var c=s.children[i];if(c.hasAttribute('data-sheet-layer'))continue;top=Math.min(top,c.offsetTop);}" +
                "var cs=getComputedStyle(s);return JSON.stringify({p:+getComputedStyle(document.documentElement).getPropertyValue('--zen-recede')||0," +
                "ty:m?+m[1]:null,travel:top===Infinity?null:s.clientHeight-top,slot:s.clientHeight,top:top===Infinity?null:top," +
                "opacity:+cs.opacity,willChange:cs.willChange,up:s.parentElement.hasAttribute('data-sheet-up')});})()"
        )
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /**
     * The slide, from the poses sampled while the picker came (`arriving`) or went: the travel is
     * the sheet's whole height (hundreds of px, not the desktop dialog's 24), every offset lies on
     * that track (a hair past its ends for the spring's overshoot), the offsets run one way but
     * for the spring's return from its overshoot, and the slot is opaque wherever it is up. The
     * root's `--zen-recede` is logged with each pose but not judged against it: while the picker
     * rises the context menu is still leaving, and the root carries the larger of the two
     * presences. A dialog that unmounts its panel the moment it closes (the picker does) leaves
     * the slot to run back empty: the travel is then the last measure's, and the way back is
     * described, not judged.
     */
    private fun judgeSlide(name: String, poses: List<String>, arriving: Boolean) {
        val all = poses.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }.filter { !it.isNull("ty") }
        val samples = all.filter { !it.isNull("travel") }
        findings.append("$name slide: ${all.size} poses of ${poses.size} samples, ${samples.size} with a panel in the slot\n")
        for (s in all) {
            findings.append(
                "  p %.3f ty %7.2f of travel %s (slot %.0f, panel top %s) opacity %.2f will-change %s%s\n".format(
                    s.getDouble("p"), s.getDouble("ty"),
                    if (s.isNull("travel")) "-" else "%.0f".format(s.getDouble("travel")), s.getDouble("slot"),
                    if (s.isNull("top")) "-" else "%.0f".format(s.getDouble("top")),
                    s.getDouble("opacity"), s.getString("willChange"), if (s.getBoolean("up")) " up" else ""
                )
            )
        }
        // Judged while the host is up: before that (the wait for the page's cover) the slot's
        // transform is whatever the last dialog left it at.
        val moving = samples.filter { it.getBoolean("up") }
        if (moving.size < 2) {
            if (arriving) failures += "$name: the frame dialog host's slot could not be read while the picker moved (${poses.size} samples, ${moving.size} up)"
            else finding("$name: the panel left with its dialog; the slot's way back ran empty (${all.size} poses)")
            return
        }
        val travel = moving.last().getDouble("travel")
        if (travel < MIN_TRAVEL_CSS_PX) failures += "$name: the slide's travel is %.0f px, not the sheet's height".format(travel)
        val slack = SLIDE_OVERSHOOT * travel + 1
        var previous = Double.NaN
        for (s in moving) {
            val ty = s.getDouble("ty")
            if (ty < -slack || ty > travel + slack) failures += "$name: the slot is at %.1f px, off its %.0f px track".format(ty, travel)
            if (s.getBoolean("up") && s.getDouble("opacity") < 0.999) failures += "$name: the slot is up but at opacity %.2f".format(s.getDouble("opacity"))
            if (!previous.isNaN()) {
                val step = ty - previous
                // Past its end the spring turns round: only a reversal short of the end counts.
                if (arriving && step > 1 && previous > slack) failures += "$name: the slide turned back up by %.1f px at %.1f".format(step, previous)
                if (!arriving && step < -1 && previous < travel - slack) failures += "$name: the slide turned back down by %.1f px at %.1f".format(-step, previous)
            }
            previous = ty
        }
        val last = moving.last().getDouble("ty")
        if (arriving && abs(last) > slack) failures += "$name: the slot came to rest at %.1f px, not in place".format(last)
        findings.append("  travel %.0f px, offsets %.1f → %.1f over ${moving.size} poses up\n".format(travel, moving.first().getDouble("ty"), last))
    }

    /** The bookmark editor's Address field in the accessibility tree: the EditText holding the page's address. */
    private fun addressField(): Rect? =
        findNodeWhere { node ->
            node.className == "android.widget.EditText" &&
                listOfNotNull(node.text, node.hintText).any { it.toString().startsWith("http") }
        }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /**
     * The editor and its focused field as JSON: the root's `--zen-recede`, the active element,
     * the field's bottom edge (CSS px, when a field has the focus), the sheet's top and height,
     * and the chrome's viewport height.
     */
    private fun editorPose(): String {
        val raw = chromeJs(
            "(function(){var a=document.activeElement;var s=document.querySelector('.zen-sheet');" +
                "var r=a?a.getBoundingClientRect():null;var sr=s?s.getBoundingClientRect():null;" +
                "return JSON.stringify({p:+getComputedStyle(document.documentElement).getPropertyValue('--zen-recede')||0," +
                "active:a?a.tagName.toLowerCase():null,field:a&&a.tagName==='INPUT'?Math.round(r.bottom):null," +
                "sheetTop:sr?Math.round(sr.top):null,sheetHeight:sr?Math.round(sr.height):null,vh:innerHeight});})()"
        )
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /**
     * With the keyboard up under the editor's focused field: the field's bottom edge stands above
     * the keys (the sheet grew to a detent that keeps it in view, the body scrolled the rest),
     * by the 8 px the chassis leaves. A keyboard that never came up is noted, not failed: the
     * emulator's, not the chassis's.
     */
    private fun judgeKeyboard(pose: String) {
        val ime = imeInset()
        val s = runCatching { JSONObject(pose) }.getOrNull()
        if (s == null) {
            failures += "editor-keyboard: the editor could not be read: $pose"
            return
        }
        val vh = s.getDouble("vh")
        val keysTop = min(vh, ((height - ime) / density).toDouble())
        val field = if (s.isNull("field")) Double.NaN else s.getDouble("field")
        finding(
            "editor with the keyboard: inset $ime px, keys from %.0f css px (viewport %.0f), focused %s, field bottom %s, sheet top %s height %s, --zen-recede %.3f".format(
                keysTop, vh, s.optString("active", "nothing"),
                if (field.isNaN()) "-" else "%.0f".format(field), s.opt("sheetTop"), s.opt("sheetHeight"), s.getDouble("p")
            )
        )
        when {
            ime <= 0 -> finding("editor-keyboard: the keyboard never came up; the field's place above it is not measured")
            field.isNaN() -> failures += "editor-keyboard: no field holds the focus with the keyboard up (${s.optString("active")})"
            field > keysTop - FIELD_CLEARANCE_CSS_PX + 1 -> failures += "editor-keyboard: the focused field's bottom (%.0f) is under the keys (from %.0f)".format(field, keysTop)
        }
    }

    /** The bar's box on the screen (display px), below the status bar; null with no bar. */
    private fun barRect(): Rect? {
        val raw = chromeJs(
            "(function(){var b=document.querySelector('.zen-phone-bar');if(!b)return null;var r=b.getBoundingClientRect();" +
                "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom});})()"
        )
        val s = runCatching { JSONObject((JSONTokener(raw).nextValue() as? String) ?: return null) }.getOrNull() ?: return null
        val rect = Rect(
            (s.getDouble("l") * density).roundToInt(), (s.getDouble("t") * density).roundToInt(),
            (s.getDouble("r") * density).roundToInt(), (s.getDouble("b") * density).roundToInt()
        )
        // Not the status bar, where the swatch is.
        rect.top = max(rect.top, windowInsets().top + 2)
        return if (rect.isEmpty || rect.height() < 8) null else rect
    }

    /**
     * The top-docked bar, frame by frame: it does not fade (§11.1, ruled 23:50), so the texture
     * left in its band (the spread of its brightness against the bar at rest) is the scrim's
     * remainder alone, `1 − a·p` with `p` the sheet's progress the swatch shows in the same
     * frame – the bar at 1 under the same scrim as the page.
     */
    private fun judgeBar(name: String, frames: List<Frame>) {
        val a = scrimAlpha()
        var worst = 0.0
        var judged = 0
        for (frame in frames) {
            val bar = frame.extra ?: continue
            if (frame.progress.isNaN() || barRest.isNaN() || barRest <= 0) continue
            val share = bar.spread / barRest
            val expected = 1 - a * frame.progress
            val gap = abs(share - expected)
            worst = max(worst, gap)
            judged++
            if (gap > BAR_TOLERANCE) {
                failures += "$name at ${frame.at} ms: the bar shows %.0f%% of its texture while the scrim at the sheet's progress %.2f leaves %.0f%%".format(share * 100, frame.progress, expected * 100)
            }
        }
        findings.append("$name: $judged frames of the bar judged against 1 − %.2f p (the bar at 1 under the scrim), largest disagreement %.0f%%\n".format(a, worst * 100))
        if (judged == 0) failures += "$name: no frame of the top-docked bar could be judged"
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

    /**
     * How an event's frames are judged: a `TRANSITION` or a `HELD` finger by the band's rules
     * (here and in the recording); a `RECORD` event's frames are cut and described only, and the
     * step judges them by a rule of its own (the bar's fade, the field above the keyboard).
     */
    private enum class Kind { TRANSITION, HELD, RECORD }

    /** [spread] is the standard deviation of the luminance: the texture left in a region. */
    private class Metrics(val luminance: Double, val chroma: Double, val edges: Double, val pageLike: Double, val spread: Double)

    /** [extra] measures a second region (the top-docked bar) and [note] carries a sample read from the chrome. */
    private class Frame(val at: Long, val band: Metrics, val progress: Double, val extra: Metrics? = null, val note: String? = null)

    /** The top-docked bar's texture with no sheet up, from the step that measures it. */
    private var barRest = Double.NaN

    /**
     * Screenshot the page just before `action`, run it, then screenshot for `probeMs` as fast as
     * the emulator allows, reading every frame – the band, `extra` if given, and `sample` from
     * the chrome – and judge the frames. A frame's time is the middle of the call that took it,
     * since the event; the event is marked for the workflow. The frames are returned for a
     * judgement of the step's own.
     */
    private fun probe(
        name: String,
        kind: Kind,
        probeMs: Long = PROBE_MS,
        extra: Rect? = null,
        sample: (() -> String)? = null,
        action: () -> Unit
    ): List<Frame> {
        val before = ui.takeScreenshot()
        val reference = before?.let { shot ->
            Frame(0, measureBand(shot, band()), progress(shot), extra?.let { r -> measureBand(shot, r) })
        }
        before?.let { save(it, "$name-before") }
        before?.recycle()
        val t0 = SystemClock.uptimeMillis()
        marks.append("${t0 - demoStart} $name ${kind.name.lowercase()}\n")
        action()
        val frames = ArrayList<Frame>()
        while (SystemClock.uptimeMillis() - t0 < probeMs) {
            val started = SystemClock.uptimeMillis()
            val shot = ui.takeScreenshot() ?: continue
            val note = sample?.invoke()
            val at = (started + SystemClock.uptimeMillis()) / 2 - t0
            frames += Frame(at, measureBand(shot, band()), progress(shot), extra?.let { measureBand(shot, it) }, note)
            save(shot, "$name-${at}ms")
            shot.recycle()
        }
        if (kind == Kind.RECORD) describeOnly(name, reference, frames) else judge(name, reference, frames)
        return frames
    }

    /** A `RECORD` event: every frame's numbers, no verdict by the band. */
    private fun describeOnly(name: String, reference: Frame?, frames: List<Frame>) {
        findings.append("$name: ${frames.size} frames (recorded; judged by the step's rule)\n")
        reference?.let { findings.append(describe(it, "before")) }
        for (frame in frames) findings.append(describe(frame))
        if (frames.isEmpty()) failures += "$name: no frame could be taken"
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
     * whose right neighbour differs by more than 40 in luminance), the share of page-like
     * pixels (bright and grey) and the spread of the luminance over `rect`, sampled every
     * third pixel.
     */
    private fun measureBand(bitmap: Bitmap, rect: Rect): Metrics {
        val r = Rect(rect)
        r.intersect(0, 0, bitmap.width, bitmap.height)
        if (r.isEmpty) return Metrics(0.0, 0.0, 0.0, 0.0, 0.0)
        val row = IntArray(r.width())
        var n = 0L
        var lum = 0.0
        var lumSquares = 0.0
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
                lumSquares += l * l
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
        val mean = lum / n
        return Metrics(mean, chroma / n, edges.toDouble() / n, pageLike.toDouble() / n, sqrt(max(0.0, lumSquares / n - mean * mean)))
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

    private fun describe(frame: Frame, label: String = "${frame.at} ms"): String {
        val line = StringBuilder(
            "  %10s  p %.3f dark %.3f  lum %5.1f chroma %5.1f edges %.4f page-like %.2f".format(
                label, frame.progress, darkness(frame.band.luminance),
                frame.band.luminance, frame.band.chroma, frame.band.edges, frame.band.pageLike
            )
        )
        frame.extra?.let {
            line.append("  bar lum %5.1f spread %5.2f".format(it.luminance, it.spread))
            if (!barRest.isNaN() && barRest > 0) line.append(" (%.3f of rest)".format(it.spread / barRest))
        }
        frame.note?.let { line.append("  ").append(it) }
        return line.append('\n').toString()
    }

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
        /** The star's toast action, which opens the bookmark editor. */
        private const val EDIT_LABEL = "Edit"
        /** The keyboard's rise and the sheet's growth under a focused field, recorded. */
        private const val KEYBOARD_MS = 4_000L
        /** The chassis keeps a focused field this far (CSS px) above the keys. */
        private const val FIELD_CLEARANCE_CSS_PX = 8.0
        /** A frame-dialog slide is the sheet's whole height: at least this (CSS px), not a 24 px pop. */
        private const val MIN_TRAVEL_CSS_PX = 120.0
        /** How far past its track's ends the slot may stand for the spring's overshoot, as a share of the travel. */
        private const val SLIDE_OVERSHOOT = 0.04
        /**
         * How far the top-docked bar's texture may stand from `1 − a·p` in one frame (the bar at 1
         * under the scrim): the spread of a composite is linear in the scrim's remainder over a
         * flat ground, the emulator's dithering and the pill's own state (a pressed Menu button)
         * add a little.
         */
        private const val BAR_TOLERANCE = 0.18
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
        /**
         * What the measured menu cycle ([measureFrames]' `menu-sheet-open` / `menu-sheet-close`)
         * gives the sheet's spring with no camera on it: the half-second spring at the emulator's
         * pace, with room; the frames after its landing are not rendered and cost nothing.
         */
        private const val MOTION_MS = 3_000L
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
