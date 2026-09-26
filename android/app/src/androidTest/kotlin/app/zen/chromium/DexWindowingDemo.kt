package app.zen.chromium

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.ActivityOptions
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PointerIcon
import android.view.View
import android.view.Window
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the browser in a DESKTOP WINDOW (OS-12: desktop windowing and Samsung DeX) on the
 * `pixel_tablet` AVD laid out at 1600 x 1000 dp, one px per dp (`DEMO_DISPLAY=1600x1000@160`),
 * with the emulator's freeform windowing on (`enable_freeform_support`,
 * `force_resizable_activities`; the window manager reads both live) and the activity started
 * into a FREEFORM task through its launch options ([launchOptions]: the windowing mode and the
 * window's bounds). A mouse is injected as the system's own would arrive ([DemoHarness.Mouse]),
 * the keyboard as key events with Ctrl in their meta state, and every claim is read off the
 * chrome's DOM, its stores, the core's state, the page's own document or the window manager:
 *
 *  1. THE WINDOW: the task is freeform and smaller than the display; the chrome lays the
 *     1100 x 760 window out as the tablet (the sidebar docked) and pads nothing – no system
 *     bar reaches the window and the caption is the decor's own band above the content; the
 *     window is then dragged narrower in eight steps (`am task resize`, the shell's resize of a
 *     freeform task) under the frames record, and the chrome follows LIVE: a probe on the
 *     chrome's `requestAnimationFrame` reads the root's box against the viewport every frame –
 *     never a frame with a stale box – and the phone chrome (the bar) takes over the moment the
 *     window's short side drops under 600 px, with MainActivity kept (the manifest's
 *     `configChanges`: the chrome document that launched is the one still there); back out to
 *     1100 the tablet chrome returns;
 *  2. HOVER on the tablet chrome: before a mouse the root carries `data-hover="none"` (the
 *     WebView answers the `hover` media query for the touch screen, so the stylesheets gate
 *     their hover rules on the live pointer instead – `lib/livePointer.ts`); the pointer's first
 *     move over the chrome flips it to `hover`, a sidebar row under it takes the window's hover
 *     fill (`--v2-window-fill-hover`) and reveals its close, a toolbar button takes the same
 *     fill; a FINGER on a row flips the root back to `none` and no hover fill follows the tap
 *     (Chromium's sticky `:hover` after a touch, which used to light the row); the mouse back
 *     brings the fill back. Cursor shapes as the WebView sets them on its view
 *     (`View.getPointerIcon`): the hand over the page's link, the text beam in the URL field.
 *     The hover acts run with the harness's UiAutomation DISCONNECTED
 *     ([DemoHarness.withoutAccessibility]): UiAutomation is an accessibility service, and while
 *     one is enabled the WebView hands every mouse hover to accessibility exploration –
 *     `WebContentsViewAndroid::OnMouseEvent` → `WebContentsAccessibilityImpl.onHoverEvent`
 *     (true while `AccessibilityManager.isEnabled()`) – and Blink never sees a mousemove (runs
 *     1 and 2 of #494); a pass under the connection first records that as findings (the
 *     tree's HOVER_ENTER / EXIT for the row, the document hearing nothing), then the claims
 *     run the way the app runs under DeX, with no service on the device. Stills inside that
 *     phase are the window's own pixels (PixelCopy), not the display's;
 *  3. RIGHT-CLICK menus: the mouse's secondary button on a sidebar row opens the tab's menu
 *     (`tab.contextMenu`, the row's own `contextmenu` handler – `TabItem.tsx`, shared with the
 *     desktop unchanged), a menu row under the pointer takes the menu's hover fill (inside the
 *     same detached phase); on the page the button reaches the document as a `contextmenu`
 *     event with `button` 2 (the page's own menus are the page's); on the URL field the
 *     system's floating toolbar with the chrome's "Paste and go" beside Paste, a link on the
 *     clipboard (`FieldActionMode`). A left click on the address pill – the toolbar's middle,
 *     over the page view's x range – is the act Android 14's `dispatchGenericPointerEvent`
 *     (hit-testing at (x, x)) sent to the page in runs 1 and 2; `MouseRouting` routes it right,
 *     and the click is its proof on device. No bookmark row is on the tablet chrome to
 *     right-click: `TabletShell` mounts no bookmarks bar;
 *  4. CTRL+WHEEL over the page: one notch away zooms the page a step along the core's ladder
 *     (1 → 1.1 → 1.25; back down 1.1 → 1 → 0.9), read off the core (`tab.zoom`) and off the
 *     page's own layout viewport, which narrows by the factor; Ctrl+0 resets; the plain wheel
 *     scrolls the page and leaves the zoom; Ctrl+wheel over the chrome zooms nothing; the
 *     engine's own scale is the one the viewport rewrite implies and nothing on top – the page's
 *     `innerWidth` times its `visualViewport.scale` stays the view's width (no double zoom:
 *     `TabWebView.onGenericMotionEvent` takes the Ctrl+scroll ahead of the engine, `WheelZoom.kt`);
 *  5. THE KEYBOARD under DeX: Ctrl+T asks for a new tab (on Android the URL bar opens in
 *     new-tab mode for it, `openNewTab`; a tab is added where the new tab page is on), Ctrl+W
 *     closes the tab and not the window, Ctrl+L focuses the address bar, Ctrl+Tab moves to the
 *     next tab (`Keys.kt`, the core's shortcut table);
 *  6. A DENSITY change (160 → 128 dpi, DeX's own is 160): the chrome's device pixel ratio
 *     follows with the document intact – no relaunch (`configChanges` carries `density`).
 *
 * Findings in `dex-windowing-findings.txt`, stills `dex-NN-<state>.png`; run under the `theme`
 * argument on both schemes by `android-dex-windowing-demo.yml`. See [GroupsDemoBase] (the seeded
 * Work space: Home, the group Research with Alpha and Beta, Gamma, Delta) and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class DexWindowingDemo : GroupsDemoBase("dex", "dex-windowing-demo") {
    override val tag = "DexWindowingDemo"
    override val findingsFile = "dex-windowing-findings.txt"
    override val title = "Zenium Android in a desktop window (OS-12): the freeform window's live resize, the mouse's hover and right click, Ctrl+wheel, the keyboard"

    private val main get() = activity as MainActivity
    private val host get() = main.host
    private val mouse by lazy { Mouse() }
    private var taskId = -1
    /** The window (the decor) and its content area (below the caption) on the display, screen px. */
    private var window = Rect()
    private var content = Rect()
    private var freeform = false
    /** A mark on the chrome document that launched: a relaunch would lose it. */
    private val runMark = "dex-${SystemClock.uptimeMillis()}"

    /**
     * No accessibility service held open for this run: the hover acts detach UiAutomation so that
     * `AccessibilityManager.isEnabled()` reads false (the WebView hands a hover to accessibility
     * exploration while any service is enabled – `WebContentsAccessibilityImpl.onHoverEvent`
     * behind `web_contents_view_android.cc`'s hover path – and Blink never sees a mousemove), and
     * the harness's own service ([DemoHarness.runDemo]'s hold) would count as one. The recipe's
     * API 34 image carries WebView 113, which sends its events without the hold anyway.
     */
    @Test
    fun record() {
        try {
            recordDemo(holdEvents = false)
        } finally {
            // After the recording: the two global settings as the device had them (the nightly's
            // reset between drivers covers the display, not these).
            for ((name, before) in windowingSettingsBefore) {
                if (before == null) shellCommand("settings delete global $name") else shellCommand("settings put global $name $before")
            }
        }
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    private val windowingSettingsBefore = LinkedHashMap<String, String?>()

    /** Freeform windowing on the display, and every activity resizable: the window manager reads both settings live. */
    override fun beforeLaunch() {
        for (name in listOf("enable_freeform_support", "force_resizable_activities")) {
            windowingSettingsBefore[name] = shellCommand("settings get global $name").trim().takeUnless { it.isEmpty() || it == "null" }
            shellCommand("settings put global $name 1")
        }
        Log.i(
            tag,
            "enable_freeform_support ${shellCommand("settings get global enable_freeform_support").trim()}, " +
                "force_resizable_activities ${shellCommand("settings get global force_resizable_activities").trim()} " +
                "(before: $windowingSettingsBefore)"
        )
        // The window manager reads both settings through an observer: a moment for them to land before the launch.
        SystemClock.sleep(1_000)
    }

    /** The activity into a freeform task at the tablet pose: the options bundle's own key for the windowing mode, plus the bounds. */
    override fun launchOptions(): Bundle =
        ActivityOptions.makeBasic().setLaunchBounds(TABLET_BOUNDS).toBundle().apply {
            putInt(KEY_LAUNCH_WINDOWING_MODE, WINDOWING_MODE_FREEFORM)
        }

    override fun warmUp() {
        ensureForeground()
        head()
        taskId = activity.taskId
        readWindow()
        if (!freeform) {
            // The options did not take (a platform that wants the shell's word): the shell's own
            // start of the running singleTask activity with the windowing mode.
            finding("  (the launch options gave a ${windowingMode()} task; asking the shell for a freeform one)")
            shellCommand("am start -n ${app.packageName}/${MainActivity::class.java.name} --windowingMode $WINDOWING_MODE_FREEFORM")
            awaitUntil(10_000) {
                readWindow()
                freeform
            }
            ensureForeground()
        }
        val display = displaySize()
        finding(
            "display $display; task $taskId in ${windowingMode()} mode (multi-window ${activity.isInMultiWindowMode}); " +
                "window $window, content $content (caption ${content.top - window.top} px), " +
                "sw${activity.resources.configuration.smallestScreenWidthDp}dp, large screen per the host ${main.largeScreen()}"
        )
        // A finger's reach is the window's content, not the display the harness measured against.
        touchable = Rect(content)
        check(
            "the app runs in a freeform window smaller than the display",
            freeform && window.width() < display.width() && window.height() < display.height(),
            "${windowingMode()} $window on $display"
        )
        check(
            "the chrome laid the 1100 x 760 window out as the tablet",
            awaitJs("$FORM_FACTOR==='tablet'", true, 10_000),
            "form factor ${jsText(FORM_FACTOR)}, viewport ${jsNumber("window.innerWidth").roundToInt()} x ${jsNumber("window.innerHeight").roundToInt()} CSS px at dpr ${jsNumber("window.devicePixelRatio")}"
        )
        check(
            "the sidebar is docked expanded",
            awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000),
            "data-sidebar '${attrOf(CHROME_ROOT, "data-sidebar")}'"
        )
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        chromeJs("window.__dexRun=${JSONObject.quote(runMark)}")
        // Alpha in front: the page the wheel, the right click and the keys work on.
        coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == ALPHA && pageCenter(ALPHA) != null }
        awaitLoaded(ALPHA, ALPHA_URL)
        // Pay for the popover menu's first layout off camera (the emulator lays it out slowly the first time).
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(600)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(800)
    }

    override fun demo() {
        section("1. The freeform window: the tablet pose, the drag to the phone pose and back")
        windowSection()
        section("2. Hover on the tablet chrome: a mouse, then a finger, then the mouse again")
        hoverSection()
        section("3. Right-click menus: a sidebar row, the page, the URL field")
        rightClickSection()
        section("4. Ctrl+wheel over the page, Ctrl+0, the plain wheel, Ctrl+wheel over the chrome")
        wheelSection()
        section("5. The keyboard: Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+Tab")
        keyboardSection()
        section("6. A density change under the window")
        densitySection()
        check(
            "every mouse event the demo injected was accepted by the input dispatcher",
            mouse.refused.isEmpty(),
            mouse.refused.joinToString("; ")
        )
        tail()
    }

    // --- 1. the window ---------------------------------------------------------------------------

    private fun windowSection() {
        readWindow()
        still("freeform-tablet")
        insetClaims("the tablet pose")
        val swBefore = activity.resources.configuration.smallestScreenWidthDp
        chromeJs(FRAME_PROBE_START)
        // No still inside the measured drag: the screenshot service answers null while the window
        // is mid-resize (run 2 asked three times for one), and the asking stretched the scene's
        // frame record. The mid-drag frames are read off the run's recording instead.
        val shrink = measureFrames("freeform-resize-tablet-to-phone") {
            resizeTo(PHONE_BOUNDS)
            awaitUntil(6_000) { jsText(FORM_FACTOR) == "phone" }
            SystemClock.sleep(600)
        }
        val frames = jsArray(FRAME_PROBE_READ)
        readWindow()
        val dpr = jsNumber("window.devicePixelRatio")
        finding(
            "  after the drag: window $window, content $content, sw${activity.resources.configuration.smallestScreenWidthDp}dp (was $swBefore), " +
                "large screen per the host ${main.largeScreen()}, viewport ${jsNumber("window.innerWidth").roundToInt()} x ${jsNumber("window.innerHeight").roundToInt()} CSS px; " +
                "${shrink.summary?.frames ?: 0} frames in ${shrink.durationMs} ms, ${shrink.summary?.janky ?: 0} janky, p95 ${shrink.summary?.p95Ms ?: 0} ms"
        )
        check(
            "the window is the phone pose the shell asked for (500 x 760)",
            window.width() == PHONE_BOUNDS.width() && window.height() == PHONE_BOUNDS.height(),
            "window ${window.width()} x ${window.height()}"
        )
        check(
            "the chrome swapped to the phone layout as the window's short side dropped under 600 px",
            jsText(FORM_FACTOR) == "phone",
            "form factor ${jsText(FORM_FACTOR)}"
        )
        check(
            "the phone bar is up and the tablet sidebar is gone",
            inDom(PHONE_BAR) && !inDom(SIDEBAR),
            "bar ${inDom(PHONE_BAR)}, sidebar ${inDom(SIDEBAR)}"
        )
        check(
            "MainActivity was not recreated by the resize: the chrome document that launched is the one still there",
            jsText("window.__dexRun") == runMark && !activity.isDestroyed && !activity.isFinishing,
            "mark '${jsText("window.__dexRun")}', destroyed ${activity.isDestroyed}"
        )
        check(
            "the chrome's viewport is the window's content, to the pixel",
            abs(jsNumber("window.innerWidth") * dpr - content.width()) <= 2 && abs(jsNumber("window.innerHeight") * dpr - content.height()) <= 2,
            "viewport ${jsNumber("window.innerWidth")} x ${jsNumber("window.innerHeight")} at dpr $dpr, content ${content.width()} x ${content.height()}"
        )
        frameProbeClaims(frames, "the shrink")
        still("freeform-phone")
        insetClaims("the phone pose")

        chromeJs(FRAME_PROBE_START)
        val grow = measureFrames("freeform-resize-phone-to-tablet") {
            resizeTo(TABLET_BOUNDS)
            awaitUntil(6_000) { jsText(FORM_FACTOR) == "tablet" }
            SystemClock.sleep(600)
        }
        val growFrames = jsArray(FRAME_PROBE_READ)
        readWindow()
        finding("  back out: window $window; ${grow.summary?.frames ?: 0} frames in ${grow.durationMs} ms, ${grow.summary?.janky ?: 0} janky, p95 ${grow.summary?.p95Ms ?: 0} ms")
        check(
            "the tablet chrome returns as the window widens past 600 px, the sidebar docked again",
            jsText(FORM_FACTOR) == "tablet" && awaitDom(SIDEBAR, 4_000) && !inDom(PHONE_BAR),
            "form factor ${jsText(FORM_FACTOR)}, sidebar ${inDom(SIDEBAR)}, bar ${inDom(PHONE_BAR)}"
        )
        check(
            "still the one chrome document after the second resize",
            jsText("window.__dexRun") == runMark && !activity.isDestroyed,
            "mark '${jsText("window.__dexRun")}'"
        )
        frameProbeClaims(growFrames, "the grow")
        awaitLoaded(ALPHA, ALPHA_URL)
        calibrated = false
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        still("freeform-tablet-back")
        steppedShrinkStills()
    }

    /**
     * The drag's eight widths one at a time, each held until the chrome has laid out at it and
     * the display has shown that frame, with a still of each: what the tablet chrome looks like
     * as it compresses (1025 to 650) and where the phone chrome takes over (575 and 500) – the
     * frames-resize strip. The recipe's emulator draws a frame in seconds (its software GL), so
     * the recording of the measured drag shows the window manager's crop of the last presented
     * buffer at every step and the relaid chrome seconds after the drag ends (run 3: 4.4 s); the
     * chrome's own frame probe is the measured drag's word on the frames, this pass the display's.
     * Not measured; the window ends back at the tablet pose.
     */
    private fun steppedShrinkStills() {
        readWindow()
        val from = Rect(window)
        val dpr = jsNumber("window.devicePixelRatio")
        for (step in 1..RESIZE_STEPS) {
            val t = step.toFloat() / RESIZE_STEPS
            val r = Rect(lerp(from.left, PHONE_BOUNDS.left, t), lerp(from.top, PHONE_BOUNDS.top, t), lerp(from.right, PHONE_BOUNDS.right, t), lerp(from.bottom, PHONE_BOUNDS.bottom, t))
            shellCommand("am task resize $taskId ${r.left} ${r.top} ${r.right} ${r.bottom}")
            val width = r.width()
            val relaid = awaitUntil(STEP_SETTLE_MS) { abs(jsNumber("window.innerWidth") * dpr - width) <= 1.0 }
            // The chrome's frame, then the display's: the emulator presents it a few frames later.
            SystemClock.sleep(2_000)
            finding("  held at $width px: chrome viewport ${jsNumber("window.innerWidth").roundToInt()} CSS px (laid out at the width $relaid), form factor ${jsText(FORM_FACTOR)}")
            still("resize-step-$width")
        }
        shellCommand("am task resize $taskId ${TABLET_BOUNDS.left} ${TABLET_BOUNDS.top} ${TABLET_BOUNDS.right} ${TABLET_BOUNDS.bottom}")
        awaitUntil(STEP_SETTLE_MS) { jsText(FORM_FACTOR) == "tablet" && abs(jsNumber("window.innerWidth") * dpr - TABLET_BOUNDS.width()) <= 1.0 }
        awaitLoaded(ALPHA, ALPHA_URL)
        readWindow()
        calibrated = false
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        SystemClock.sleep(1_000)
    }

    /**
     * What the chrome's own frames said while the window changed: the root's box against the
     * viewport in every frame, and the form factor's one-way change.
     */
    private fun frameProbeClaims(frames: JSONArray, drag: String) {
        var stale = 0
        var flips = 0
        var last = ""
        val widths = LinkedHashSet<Int>()
        for (i in 0 until frames.length()) {
            val f = frames.getJSONArray(i)
            val innerWidth = f.getInt(1)
            val innerHeight = f.getInt(2)
            val formFactor = f.getString(3)
            val rootWidth = f.getInt(4)
            val rootHeight = f.getInt(5)
            widths += innerWidth
            if (rootWidth < 0 || abs(rootWidth - innerWidth) > 1 || abs(rootHeight - innerHeight) > 1) stale++
            if (last.isNotEmpty() && formFactor != last) flips++
            last = formFactor
        }
        finding("  $drag: ${frames.length()} chrome frames over ${widths.size} viewport widths (${widths.joinToString(" ")}), $flips layout swap(s), $stale frame(s) with a stale root box")
        check("$drag: the chrome drew a frame at each of the window's widths", frames.length() > 0 && widths.size >= 4, "${widths.size} widths seen")
        check("$drag: every frame drew the chrome's root at the viewport's size (no stale box, no blank band)", stale == 0, "$stale of ${frames.length()} frames")
        check("$drag: the layout swapped once and never back", flips == 1, "$flips swap(s), ending as '$last'")
    }

    /** The system's insets and the caption against the chrome's own padding, in the pose named. */
    private fun insetClaims(pose: String) {
        readWindow()
        val insets = windowInsets()
        val chromeAt = onMain { IntArray(2).also { host.chrome.getLocationOnScreen(it) } }
        val insetTop = jsText("getComputedStyle(document.documentElement).getPropertyValue('--zen-inset-top').trim()")
        val insetBottom = jsText("getComputedStyle(document.documentElement).getPropertyValue('--zen-inset-bottom').trim()")
        val caption = content.top - window.top
        val dpr = jsNumber("window.devicePixelRatio")
        val chromeTopPx = (insetTop.removeSuffix("px").toDoubleOrNull() ?: Double.NaN) * dpr
        finding(
            "  $pose: window $window, content $content, caption $caption px; system bar insets top ${insets.top} bottom ${insets.bottom}; " +
                "chrome at ${chromeAt[0]},${chromeAt[1]}; --zen-inset-top '$insetTop', --zen-inset-bottom '$insetBottom'"
        )
        check(
            "$pose: the chrome starts at the content's top, below the caption – nothing of it under the decor's band",
            chromeAt[1] >= content.top && chromeAt[1] >= window.top + caption && chromeAt[1] < content.top + 2,
            "chrome top ${chromeAt[1]}, content top ${content.top}, window top ${window.top} + caption $caption"
        )
        check(
            "$pose: the chrome's top inset is the system's (none reaches a freeform window)",
            chromeTopPx.isFinite() && abs(chromeTopPx - insets.top) <= 1,
            "--zen-inset-top $insetTop at dpr $dpr against ${insets.top} px"
        )
    }

    /** The window from (`window` as it stands) to `target` in [RESIZE_STEPS] steps of the shell's resize. */
    private fun resizeTo(target: Rect) {
        val from = Rect(window)
        for (step in 1..RESIZE_STEPS) {
            val t = step.toFloat() / RESIZE_STEPS
            val r = Rect(lerp(from.left, target.left, t), lerp(from.top, target.top, t), lerp(from.right, target.right, t), lerp(from.bottom, target.bottom, t))
            val said = shellCommand("am task resize $taskId ${r.left} ${r.top} ${r.right} ${r.bottom}").trim()
            if (said.isNotEmpty()) finding("  (am task resize $r: $said)")
            SystemClock.sleep(RESIZE_STEP_MS)
        }
    }

    private fun lerp(a: Int, b: Int, t: Float): Int = (a + (b - a) * t).roundToInt()

    private fun readWindow() {
        instrumentation.runOnMainSync {
            val decor = activity.window.decorView
            val at = IntArray(2)
            decor.getLocationOnScreen(at)
            window = Rect(at[0], at[1], at[0] + decor.width, at[1] + decor.height)
            val view = activity.findViewById<View>(android.R.id.content)
            val ct = IntArray(2)
            view.getLocationOnScreen(ct)
            content = Rect(ct[0], ct[1], ct[0] + view.width, ct[1] + view.height)
            freeform = activity.isInMultiWindowMode && windowingMode() == "freeform"
        }
    }

    /** The task's windowing mode as the activity's configuration prints it (`mWindowingMode=freeform`). */
    private fun windowingMode(): String =
        WINDOWING_MODE.find(activity.resources.configuration.toString())?.groupValues?.get(1) ?: "unknown"

    /** The display's logical size per `wm size` (the override the recipe set, else the physical). */
    private fun displaySize(): Rect {
        val said = shellCommand("wm size")
        val sizes = WM_SIZE.findAll(said).map { it.groupValues[1].toInt() to it.groupValues[2].toInt() }.toList()
        val (w, h) = sizes.lastOrNull() ?: (0 to 0)
        return Rect(0, 0, w, h)
    }

    // --- 2. hover --------------------------------------------------------------------------------

    private fun hoverSection() {
        val hoverFill = probeColor("--v2-window-fill-hover", SIDEBAR)
        val activeFill = probeColor("--v2-window-fill", SIDEBAR)
        finding("  the window's hover fill $hoverFill, its active fill $activeFill; data-hover before the mouse '${jsText(DATA_HOVER)}'")
        check(
            "before a mouse the root carries data-hover 'none' (the WebView's hover media query answers for the touch screen)",
            jsText(DATA_HOVER) == "none" && !jsBoolean("window.matchMedia('(hover: hover)').matches"),
            "data-hover '${jsText(DATA_HOVER)}', (hover: hover) ${jsBoolean("window.matchMedia('(hover: hover)').matches")}"
        )
        val page = pageCenter(ALPHA)
        val gamma = at(row(GAMMA))
        if (page == null || gamma == null) {
            check("the page and the Gamma row are on screen for the mouse", false, "page $page, Gamma $gamma")
            return
        }
        val trace = HoverTrace()
        trace.install(pageView(ALPHA))
        try {
            hoverUnderTheHarness(page, gamma, trace)
            withoutAccessibility {
                val off = awaitUntil(6_000) { !accessibilityEnabled() }
                accessibilityState("UiAutomation disconnected")
                check(
                    "with UiAutomation disconnected the app sees accessibility off – no service on the device, as under DeX",
                    accessibilityDetached && off,
                    "detached $accessibilityDetached, AccessibilityManager.isEnabled ${accessibilityEnabled()}"
                )
                SystemClock.sleep(400)
                hoverActs(page, gamma, hoverFill, activeFill, trace)
            }
        } finally {
            trace.remove()
        }
        val on = awaitUntil(6_000) { accessibilityEnabled() }
        finding("  UiAutomation back: accessibility enabled again $on; ${accessibilityState("the reconnect")}")
        coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == ALPHA && pageCenter(ALPHA) != null }
    }

    /**
     * The diagnosis of runs 1 and 2, kept as findings: under the harness's own accessibility
     * connection a mouse's hover over the chrome is taken by the WebView for accessibility
     * exploration – `WebContentsViewAndroid::OnMouseEvent` hands HOVER_MOVE to
     * `WebContentsAccessibilityImpl.onHoverEvent`, which returns true whenever
     * `AccessibilityManager.isEnabled()`, and the hit test that follows announces the node under
     * the pointer as TYPE_VIEW_HOVER_ENTER / EXIT instead of a mousemove to Blink. The
     * announcements are read off UiAutomation's own event stream while the pointer crosses onto
     * the Gamma row; the document's probe and the root's `data-hover` say what Blink heard.
     */
    private fun hoverUnderTheHarness(page: PointF, gamma: PointF, trace: HoverTrace) {
        finding("  ${accessibilityState("the harness's connection")}")
        val announced = Collections.synchronizedList(ArrayList<String>())
        ui.setOnAccessibilityEventListener { event ->
            if (event.eventType == AccessibilityEvent.TYPE_VIEW_HOVER_ENTER || event.eventType == AccessibilityEvent.TYPE_VIEW_HOVER_EXIT) {
                val text = event.text.joinToString("/").take(28)
                announced += "${AccessibilityEvent.eventTypeToString(event.eventType).removePrefix("TYPE_VIEW_")}:${event.className?.toString()?.substringAfterLast('.') ?: "?"}${if (text.isEmpty()) "" else ":$text"}"
            }
        }
        chromeJs(POINTER_PROBE_START)
        trace.reset()
        mouse.moveTo(page.x, page.y)
        SystemClock.sleep(300)
        mouse.moveTo(gamma.x, gamma.y, 400)
        val flipped = awaitJs("$DATA_HOVER==='hover'", true, 2_500)
        SystemClock.sleep(400)
        ui.setOnAccessibilityEventListener(null)
        val events = synchronized(announced) { announced.toList() }
        finding(
            "  under the harness's connection: data-hover '${jsText(DATA_HOVER)}' (flipped $flipped), Gamma :hover ${gammaHover()}; " +
                "the chrome document heard ${jsText(POINTER_PROBE_COUNTS)}; ${trace.report()}; " +
                "accessibility announced ${events.size} hover event(s): ${events.take(8).joinToString(", ")}"
        )
        // The pointer back over the page: the acts start from the same place, the row left alone.
        mouse.moveTo(page.x, page.y, 300)
        SystemClock.sleep(300)
    }

    private fun accessibilityManager(): AccessibilityManager = app.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager

    /** What the WebView keys its hover handling on: the app's own `AccessibilityManager.isEnabled()`. */
    private fun accessibilityEnabled(): Boolean = accessibilityManager().isEnabled

    /** The accessibility state as the app sees it under `state`, one line. */
    private fun accessibilityState(state: String): String {
        val manager = accessibilityManager()
        val services = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).map { it.id.substringAfterLast('/') }
        val setting = Settings.Secure.getInt(app.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, -1)
        return "accessibility under $state: enabled ${manager.isEnabled}, touch exploration ${manager.isTouchExplorationEnabled}, " +
            "enabled services ${services.size}${if (services.isEmpty()) "" else " [${services.joinToString(", ")}]"}, accessibility_enabled setting $setting, harness detached $accessibilityDetached"
    }

    private fun hoverActs(page: PointF, gamma: PointF, hoverFill: String, activeFill: String, trace: HoverTrace) {
        // The pointer appears over the page, then crosses onto the sidebar's Gamma row.
        chromeJs(POINTER_PROBE_START)
        trace.reset()
        mouse.moveTo(page.x, page.y)
        SystemClock.sleep(300)
        finding("  cursor over the page's text: ${cursorOf(pageView(ALPHA))}")
        mouse.moveTo(gamma.x, gamma.y, 400)
        val flipped = awaitJs("$DATA_HOVER==='hover'", true, 3_000)
        finding("  hover trace after the first moves: ${trace.report()}; chrome document ${jsText(POINTER_PROBE_COUNTS)}, last ${jsText(POINTER_PROBE_LAST)}")
        check(
            "the mouse's first move over the chrome flips the root to data-hover 'hover'",
            flipped,
            "data-hover '${jsText(DATA_HOVER)}'"
        )
        check(
            "the Gamma row is :hover under the pointer",
            awaitJs("(function(){var e=document.querySelector('${row(GAMMA)}');return !!e&&e.matches(':hover')})()", true, 2_000),
            ""
        )
        check(
            "the hovered row takes the window's hover fill",
            awaitUntil(2_500) { backgroundOf(row(GAMMA)) == hoverFill },
            "background ${backgroundOf(row(GAMMA))}, hover fill $hoverFill"
        )
        check(
            "the hovered row reveals its close (opacity 1)",
            awaitUntil(2_000) { opacityOf("${row(GAMMA)} .zen-tab-close") == 1.0 },
            "close opacity ${opacityOf("${row(GAMMA)} .zen-tab-close")}"
        )
        SystemClock.sleep(900)
        finding("  cursor over the row: ${cursorOf(host.chrome)}; hover card store: ${jsText("JSON.stringify(window.__zenStores.ui.get().hoverCard)")} (the desktop's card; TabletShell mounts none)")
        still("hover-strip")

        val toggle = at(SIDEBAR_TOGGLE)
        if (toggle != null) {
            mouse.moveTo(toggle.x, toggle.y, 300)
            check(
                "a toolbar button under the pointer takes the window's hover fill",
                awaitUntil(2_500) { backgroundOf(SIDEBAR_TOGGLE) == hoverFill },
                "background ${backgroundOf(SIDEBAR_TOGGLE)}"
            )
            check(
                "the row the pointer left lost its fill",
                awaitUntil(2_000) { backgroundOf(row(GAMMA)) != hoverFill },
                "Gamma background ${backgroundOf(row(GAMMA))}"
            )
            SystemClock.sleep(400)
            finding("  cursor over the toolbar button: ${cursorOf(host.chrome)}")
            still("hover-toolbar")
        } else {
            check("the sidebar toggle is on screen", false, SIDEBAR_TOGGLE)
        }

        // A finger on Delta: the live pointer is a finger now, and the tap's sticky :hover lights nothing.
        val tapped = touch(domRect(row(DELTA)), "the Delta row (a finger)")
        check("the finger's tap activates Delta", tapped != null && awaitUntil(5_000) { activeTabId() == DELTA }, "active ${activeTabId()}")
        check(
            "the finger flips the root to data-hover 'none'",
            awaitJs("$DATA_HOVER==='none'", true, 3_000),
            "data-hover '${jsText(DATA_HOVER)}'"
        )
        SystemClock.sleep(500)
        val deltaHover = jsBoolean("(function(){var e=document.querySelector('${row(DELTA)}');return !!e&&e.matches(':hover')})()")
        val deltaBackground = backgroundOf(row(DELTA))
        finding("  after the tap: Delta :hover per Chromium $deltaHover (the sticky hover a touch leaves), background $deltaBackground")
        check(
            "no hover fill after the tap: the active row wears the active fill alone, the hover fill on no row",
            deltaBackground == activeFill && rowsWith(hoverFill).isEmpty(),
            "Delta $deltaBackground, rows with the hover fill: ${rowsWith(hoverFill)}"
        )
        still("touch-after-hover")

        // The mouse again: hover is back at once.
        mouse.moveTo(gamma.x, gamma.y, 300)
        check(
            "the mouse's return flips the root back to 'hover' and the row under it takes the fill again",
            awaitJs("$DATA_HOVER==='hover'", true, 3_000) && awaitUntil(2_500) { backgroundOf(row(GAMMA)) == hoverFill },
            "data-hover '${jsText(DATA_HOVER)}', Gamma ${backgroundOf(row(GAMMA))}"
        )
        // Cursor shapes: the hand over the page's link, the beam in the URL field. Alpha (the
        // page with the link) back in front first: the finger put Delta there. The swap waits on
        // the chrome's frames, and the recipe's emulator draws them slowly under this window
        // (run 3: six seconds from the activation to the page view shown, past a 5 s wait).
        coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
        val shown = awaitUntil(PAGE_SWAP_MS) { activeTabId() == ALPHA && pageCenter(ALPHA) != null }
        SystemClock.sleep(400)
        var link = linkOnScreen(ALPHA)
        if (link == null && awaitUntil(PAGE_SWAP_MS) { linkOnScreen(ALPHA) != null }) link = linkOnScreen(ALPHA)
        if (!shown || link == null) finding("  (Alpha's page after the activation: shown within ${PAGE_SWAP_MS / 1000} s $shown, its link on screen ${link != null})")
        if (link != null) {
            mouse.moveTo(link.x, link.y, 300)
            SystemClock.sleep(500)
            val cursor = cursorOf(pageView(ALPHA))
            check("the cursor over the page's link is the hand", cursor == "hand", cursor)
        } else {
            check("the page's link is on screen for the cursor's read", false, "active ${activeTabId()}, page shown ${pageCenter(ALPHA) != null}")
        }
        val pill = at(ADDRESS_PILL)
        if (pill != null) {
            mouse.moveTo(pill.x, pill.y, 300)
            SystemClock.sleep(400)
            finding("  cursor over the address pill: ${cursorOf(host.chrome)}")
            chromeJs("window.__dexPtr=[];'ok'")
            trace.reset()
            mouse.click()
            var opened = awaitUntil(6_000) { urlbarOpen() }
            finding(
                "  the click on the pill's centre (window x ${(pill.x - content.left).roundToInt()}, over the page view's x range – Android 14's (x, x) hit test would send it to the page): " +
                    "urlbar open $opened; the chrome document's events ${jsText(POINTER_PROBE_LAST)}; ${trace.report()}"
            )
            check(
                "a left click on the address pill opens the URL field (MouseRouting: the button events reach the chrome, not the page under (x, x))",
                opened,
                "urlbar open ${urlbarOpen()}, focus ${focusName()}, page view heard ${trace.pageButtons()} button event(s)"
            )
            if (!opened) {
                // The cursor read below still wants the field: a finger opens it, and the finding says the mouse did not.
                touch(domRect(ADDRESS_PILL), "the address pill (a finger, the mouse's click having missed)")
                opened = awaitUntil(6_000) { urlbarOpen() }
            }
            if (opened && awaitDom(FIELD, 4_000)) {
                val field = at(FIELD)
                if (field != null) {
                    mouse.moveTo(field.x, field.y, 200)
                    SystemClock.sleep(500)
                    val cursor = cursorOf(host.chrome)
                    check("the cursor over the URL field is the text beam", cursor == "text", cursor)
                }
                key(KeyEvent.KEYCODE_ESCAPE)
                if (!awaitUntil(3_000) { !urlbarOpen() }) key(KeyEvent.KEYCODE_BACK)
                awaitUntil(3_000) { !urlbarOpen() }
            }
        }
        if (!flipped) {
            // The claims above stand as the injected mouse left them; now the diagnosis, with the
            // pointer put back over the row through the real path first.
            mouse.moveTo(gamma.x, gamma.y, 300)
            SystemClock.sleep(300)
            hoverLadder(gamma, trace)
        }
    }

    /**
     * The injected hover flipped nothing: where along the way it stopped, as findings (not
     * claims) – the input dispatcher's own state with the pointer over the Gamma row (`dumpsys
     * input`: the hovering pointer's window, the recent queue, the app's windows and connection),
     * then the same hover handed in BELOW the dispatcher, at the window's decor and straight at
     * the chrome view, each read off the trace, the chrome document's pointer probe, the root's
     * `data-hover` and the row's `:hover`. Whichever rung first reaches the document names the
     * hop the injected stream is lost at.
     */
    private fun hoverLadder(gamma: PointF, trace: HoverTrace) {
        if (accessibilityDetached) {
            // The shell is UiAutomation's, and it is disconnected here: the rungs alone.
            finding("  (no dumpsys input while UiAutomation is disconnected); the trace so far: ${trace.report()}")
        } else {
            val dump = shellCommand("dumpsys input")
            File(out, "dumpsys-input-hover.txt").writeText(dump)
            finding("  dumpsys input with the pointer over the Gamma row (${dump.length} chars, in dumpsys-input-hover.txt); the trace so far: ${trace.report()}")
            for (marker in listOf("TouchStatesByDisplay", "RecentQueue")) {
                excerpt(dump, marker, 12).forEach { finding("    | $it") }
            }
            dump.lineSequence().filter { it.contains(app.packageName) }.take(14).forEach { finding("    | ${it.trim().take(240)}") }
        }
        val decor = activity.window.decorView
        val decorAt = onMain { IntArray(2).also { decor.getLocationOnScreen(it) } }
        val chromeAt = onMain { IntArray(2).also { host.chrome.getLocationOnScreen(it) } }
        rung("the window's decor, below the dispatcher", decor, gamma.x - decorAt[0], gamma.y - decorAt[1], trace)
        rung("the chrome view itself", host.chrome, gamma.x - chromeAt[0], gamma.y - chromeAt[1], trace)
    }

    /** One rung: a mouse's HOVER_ENTER, a HOVER_MOVE and a second move a step on, dispatched at `view` in its own coordinates; what followed. */
    private fun rung(name: String, view: View, x: Float, y: Float, trace: HoverTrace) {
        trace.reset()
        chromeJs(POINTER_PROBE_START)
        val hoverBefore = jsText(DATA_HOVER)
        val said = onMain {
            listOf(
                dispatchHover(view, MotionEvent.ACTION_HOVER_ENTER, x, y),
                dispatchHover(view, MotionEvent.ACTION_HOVER_MOVE, x, y)
            )
        }
        SystemClock.sleep(120)
        val moved = onMain { dispatchHover(view, MotionEvent.ACTION_HOVER_MOVE, x + 2, y + 1) }
        val reached = awaitUntil(1_500) { jsText(POINTER_PROBE_COUNTS) != "{}" }
        SystemClock.sleep(200)
        finding(
            "  rung – $name at ${x.roundToInt()},${y.roundToInt()}: the view said enter ${said[0]}, move ${said[1]}, second move $moved; " +
                "the document ${if (reached) "heard it" else "heard nothing"}: ${jsText(POINTER_PROBE_COUNTS)}, last ${jsText(POINTER_PROBE_LAST)}; " +
                "data-hover '$hoverBefore' -> '${jsText(DATA_HOVER)}', Gamma :hover ${gammaHover()}; ${trace.report()}"
        )
    }

    private fun dispatchHover(view: View, action: Int, x: Float, y: Float): Boolean {
        val properties = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_MOUSE
        }
        val coords = MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            size = 1f
        }
        val now = SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(now, now, action, 1, arrayOf(properties), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0)
        return try {
            view.dispatchGenericMotionEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun gammaHover(): Boolean =
        jsBoolean("(function(){var e=document.querySelector('${row(GAMMA)}');return !!e&&e.matches(':hover')})()")

    /** The line `marker` first appears on and the `lines` after it, trimmed. */
    private fun excerpt(text: String, marker: String, lines: Int): List<String> {
        val all = text.lines()
        val at = all.indexOfFirst { it.contains(marker) }
        if (at < 0) return listOf("($marker: not in the dump)")
        return all.subList(at, minOf(all.size, at + lines + 1)).map { it.trimEnd().take(240) }
    }

    // --- 3. right click --------------------------------------------------------------------------

    private fun rightClickSection() {
        val alpha = at(row(ALPHA))
        if (alpha == null) {
            check("the Alpha row is on screen for the right click", false, "")
            return
        }
        // The row's menu and the hover on its rows: with no accessibility service, as the hover acts.
        withoutAccessibility {
            awaitUntil(6_000) { !accessibilityEnabled() }
            mouse.rightClick(alpha.x, alpha.y)
            val opened = awaitJs(MENU_OPEN, true, 5_000)
            awaitDom("$MENU [role=\"menuitem\"]", 3_000)
            val items = textsOf("$MENU [role=\"menuitem\"]")
            check("a right click on a sidebar row opens the tab's menu", opened && items.isNotEmpty(), "menu open $opened, rows: ${items.joinToString(" | ")}")
            val menuFill = probeColor("--v2-fill", MENU)
            val second = domRect("$MENU [role=\"menuitem\"]:nth-of-type(2)") ?: domRect("$MENU [role=\"menuitem\"]")
            val target = screen(second)
            if (target != null) {
                mouse.moveTo(target.exactCenterX(), target.exactCenterY(), 300)
                check(
                    "a menu row under the pointer takes the menu's hover fill",
                    awaitUntil(2_500) { menuRowsWith(menuFill) > 0 },
                    "rows with $menuFill: ${menuRowsWith(menuFill)}"
                )
            }
            SystemClock.sleep(400)
            still("tab-menu")
            key(KeyEvent.KEYCODE_ESCAPE)
            if (!awaitJs(MENU_OPEN, false, 3_000)) {
                key(KeyEvent.KEYCODE_BACK)
                awaitJs(MENU_OPEN, false, 3_000)
            }
            check("Escape closes the menu", !jsBoolean(MENU_OPEN), "")
        }
        awaitUntil(6_000) { accessibilityEnabled() }

        // The page: the button reaches the document as a contextmenu event.
        pageJs(ALPHA, "window.__ctx=0;window.__ctxButton=-1;document.addEventListener('contextmenu',function(e){window.__ctx++;window.__ctxButton=e.button},true);'ok'")
        val link = linkOnScreen(ALPHA)
        if (link != null) {
            mouse.rightClick(link.x, link.y)
            val reached = awaitUntil(4_000) { (pageJs(ALPHA, "window.__ctx").toIntOrNull() ?: 0) > 0 }
            val button = pageJs(ALPHA, "window.__ctxButton")
            check("the mouse's secondary button reaches the page as a contextmenu event with button 2", reached && button == "2", "contextmenu ${pageJs(ALPHA, "window.__ctx")}, button $button")
            SystemClock.sleep(1_500)
            val chromeMenu = jsBoolean(MENU_OPEN)
            val nativeMenu = findInWindows { it == "Open in new tab" || it == "Copy link" || it == "Copy link address" }
            finding("  after the right click on the link: the chrome's menu store ${if (chromeMenu) "open" else "closed"}, a link menu in the windows ${nativeMenu != null}")
            still("page-link-right-click")
            if (chromeMenu || nativeMenu != null) {
                key(KeyEvent.KEYCODE_ESCAPE)
                if (!awaitJs(MENU_OPEN, false, 2_000)) back()
                awaitJs(MENU_OPEN, false, 3_000)
            }
        } else {
            finding("  (the page's link is not on screen for the right click)")
        }

        // The URL field: a link on the clipboard, the field open, the secondary button on it.
        setClipboard("https://example.com/paste-and-go")
        val pill = at(ADDRESS_PILL)
        if (pill != null) {
            mouse.click(pill.x, pill.y)
            var opened = awaitUntil(6_000) { urlbarOpen() }
            if (!opened) {
                finding("  (the mouse's click on the pill opened nothing this time; a finger opens the field for the right click)")
                touch(domRect(ADDRESS_PILL), "the address pill (a finger)")
                opened = awaitUntil(6_000) { urlbarOpen() }
            }
            if (opened && awaitDom(FIELD, 4_000)) {
                val field = at(FIELD)
                if (field != null) {
                    mouse.rightClick(field.x, field.y)
                    val pasteAndGo = awaitUntil(5_000) { findInWindows { it == PASTE_AND_GO } != null }
                    val paste = findInWindows { it == "Paste" || it == app.getString(android.R.string.paste) } != null
                    finding("  the field's right click at window x ${(field.x - content.left).roundToInt()}: '$PASTE_AND_GO' in the windows $pasteAndGo, Paste $paste")
                    check("a right click on the URL field offers Paste and go beside the system's Paste", pasteAndGo, "Paste and go $pasteAndGo, Paste $paste")
                    still("omnibox-right-click")
                }
                key(KeyEvent.KEYCODE_ESCAPE)
                if (!awaitUntil(3_000) { !urlbarOpen() }) back()
                awaitUntil(3_000) { !urlbarOpen() }
                awaitUntil(3_000) { findInWindows { it == PASTE_AND_GO } == null }
            } else {
                check("the click on the pill opens the URL field", false, "urlbar open ${urlbarOpen()}")
            }
        }
        coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == ALPHA && pageCenter(ALPHA) != null }
    }

    // --- 4. the wheel ----------------------------------------------------------------------------

    private fun wheelSection() {
        val page = pageCenter(ALPHA)
        if (page == null) {
            check("the page is on screen for the wheel", false, "")
            return
        }
        mouse.moveTo(page.x, page.y, 300)
        SystemClock.sleep(300)
        val width0 = pageWidth(ALPHA)
        val zoom0 = zoomOf(ALPHA)
        // The view's width in the page's CSS px at scale 1: what innerWidth × the engine's scale must
        // stay. One main-thread hop: pageView() is its own, and runOnMainSync does not nest (run 2).
        val viewCss = onMain { (host.tabs.get(ALPHA)?.width ?: 0) / activity.resources.displayMetrics.density }.toDouble()
        finding("  before the wheel: zoom $zoom0, the page's innerWidth $width0, visual scale ${pageScale(ALPHA)}, the view ${viewCss.roundToInt()} CSS px wide")
        mouse.wheel(1, ctrl = true)
        check("one Ctrl+notch away zooms the page a step, 1 -> 1.1 (the core's ladder)", awaitUntil(5_000) { near(zoomOf(ALPHA), 1.1) }, "zoom ${zoomOf(ALPHA)}")
        val width1 = pageWidth(ALPHA)
        check(
            "the page's layout viewport narrowed by the factor",
            awaitUntil(3_000) { near(pageWidth(ALPHA), width0 / 1.1, 2.0) },
            "innerWidth $width0 -> ${pageWidth(ALPHA)} (expected ${(width0 / 1.1).roundToInt()}); first read $width1"
        )
        check(
            "no double zoom at 1.1: the engine's scale is the viewport rewrite's own – innerWidth × visualViewport.scale is still the view's width",
            awaitUntil(3_000) { near(pageWidth(ALPHA) * pageScale(ALPHA), viewCss, 3.0) },
            "innerWidth ${pageWidth(ALPHA)} × scale ${pageScale(ALPHA)} = ${(pageWidth(ALPHA) * pageScale(ALPHA)).roundToInt()} against the view's $viewCss"
        )
        mouse.wheel(1, ctrl = true)
        check("a second notch: 1.25", awaitUntil(5_000) { near(zoomOf(ALPHA), 1.25) }, "zoom ${zoomOf(ALPHA)}")
        check(
            "no double zoom at 1.25",
            awaitUntil(3_000) { near(pageWidth(ALPHA) * pageScale(ALPHA), viewCss, 3.0) && near(pageWidth(ALPHA), width0 / 1.25, 2.0) },
            "innerWidth ${pageWidth(ALPHA)} × scale ${pageScale(ALPHA)} against the view's $viewCss"
        )
        SystemClock.sleep(600)
        still("zoom-125")
        mouse.wheel(-3, ctrl = true, gapMs = 500)
        check("three notches towards the user: 1.1, 1, 0.9", awaitUntil(6_000) { near(zoomOf(ALPHA), 0.9) }, "zoom ${zoomOf(ALPHA)}")
        finding("  the zoom bubble store: ${jsText("JSON.stringify(window.__zenStores.ui.get().zoomBubble)")} (the bubble is the desktop's; the page-controls host announces the level instead)")
        key(KeyEvent.KEYCODE_0, ctrl = true)
        check("Ctrl+0 resets the zoom to 1", awaitUntil(5_000) { near(zoomOf(ALPHA), 1.0) }, "zoom ${zoomOf(ALPHA)}")
        check(
            "the page's viewport is back to its width",
            awaitUntil(3_000) { near(pageWidth(ALPHA), width0, 2.0) },
            "innerWidth ${pageWidth(ALPHA)} against $width0"
        )
        check(
            "at zoom 1 the engine's scale is 1 again (nothing of its own left over)",
            awaitUntil(2_000) { near(pageScale(ALPHA), 1.0, 0.01) },
            "scale ${pageScale(ALPHA)}"
        )
        still("zoom-reset")

        // The plain wheel scrolls.
        pageJs(ALPHA, "document.body.style.minHeight='4000px';window.scrollTo(0,0);'ok'")
        SystemClock.sleep(300)
        mouse.wheel(-3, gapMs = 150)
        check(
            "a plain wheel towards the user scrolls the page down and leaves the zoom",
            awaitUntil(4_000) { pageScrollY(ALPHA) > 0 } && near(zoomOf(ALPHA), 1.0),
            "scrollY ${pageScrollY(ALPHA)}, zoom ${zoomOf(ALPHA)}"
        )
        pageJs(ALPHA, "window.scrollTo(0,0);document.body.style.minHeight='';'ok'")

        // Ctrl+wheel over the chrome: nothing.
        val gamma = at(row(GAMMA))
        if (gamma != null) {
            val dpr0 = jsNumber("window.devicePixelRatio")
            mouse.moveTo(gamma.x, gamma.y, 300)
            mouse.wheel(2, ctrl = true)
            SystemClock.sleep(1_500)
            check(
                "Ctrl+wheel over the chrome zooms neither the page nor the chrome",
                near(zoomOf(ALPHA), 1.0) && near(jsNumber("window.devicePixelRatio"), dpr0, 0.001) && near(pageWidth(ALPHA), width0, 2.0),
                "zoom ${zoomOf(ALPHA)}, chrome dpr ${jsNumber("window.devicePixelRatio")} (was $dpr0), page innerWidth ${pageWidth(ALPHA)}"
            )
        }
    }

    // --- 5. the keyboard -------------------------------------------------------------------------

    private fun keyboardSection() {
        val page = pageCenter(ALPHA)
        if (page != null) {
            // The page has the keyboard: a click on its blank lower half.
            mouse.click(page.x, page.y + (content.height() / 4f))
            SystemClock.sleep(400)
        }
        finding("  focus: ${focusName()}")
        val count0 = tabCount()
        val active0 = activeTabId()
        key(KeyEvent.KEYCODE_T, ctrl = true)
        // Android's new tab: the URL bar in new-tab mode over the page (`openNewTab`, the new tab
        // page turned off); with the page on, a tab is added instead.
        val answered = awaitUntil(6_000) { tabCount() == count0 + 1 || urlbarOpen() }
        val mode = jsText("((window.__zenStores.ui.get().urlbar)||{}).mode")
        finding("  after Ctrl+T: tabs $count0 -> ${tabCount()}, active $active0 -> ${activeTabId()}, urlbar open ${urlbarOpen()} in mode '$mode', focus ${focusName()}")
        check(
            "Ctrl+T asks for a new tab: the URL bar opens in new-tab mode for it (Android's new tab), or a tab is added",
            answered && (tabCount() == count0 + 1 || (urlbarOpen() && mode == "new-tab")),
            "tabs ${tabCount()}, urlbar open ${urlbarOpen()} in mode '$mode'"
        )
        SystemClock.sleep(800)
        still("keys-new-tab")
        if (urlbarOpen()) {
            key(KeyEvent.KEYCODE_ESCAPE)
            if (!awaitUntil(3_000) { !urlbarOpen() }) back()
            awaitUntil(3_000) { !urlbarOpen() }
        }
        // Ctrl+W on a plain tab (Delta), the page focused: the tab goes, the window stays.
        coreInvoke("tab.activate", JSONObject().put("tabId", DELTA).toString())
        awaitUntil(5_000) { activeTabId() == DELTA && pageCenter(DELTA) != null }
        pageCenter(DELTA)?.let { delta ->
            mouse.click(delta.x, delta.y + (content.height() / 4f))
            SystemClock.sleep(400)
        }
        val count1 = tabCount()
        key(KeyEvent.KEYCODE_W, ctrl = true)
        val closed = awaitUntil(6_000) { tabCount() == count1 - 1 }
        check(
            "Ctrl+W closes the tab and not the window",
            closed && activeTabId() != DELTA && !activity.isFinishing && !activity.isDestroyed && onMain { activity.window.decorView.isShown },
            "tabs $count1 -> ${tabCount()}, active ${activeTabId()}, finishing ${activity.isFinishing}, destroyed ${activity.isDestroyed}"
        )
        if (activeTabId() != ALPHA) {
            coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
            awaitUntil(5_000) { activeTabId() == ALPHA }
        }
        key(KeyEvent.KEYCODE_L, ctrl = true)
        check("Ctrl+L opens the address bar", awaitUntil(6_000) { urlbarOpen() }, "urlbar open ${urlbarOpen()}, focus ${focusName()}")
        SystemClock.sleep(600)
        still("keys-ctrl-l")
        key(KeyEvent.KEYCODE_ESCAPE)
        if (!awaitUntil(3_000) { !urlbarOpen() }) back()
        awaitUntil(3_000) { !urlbarOpen() }
        if (page != null) {
            mouse.click(page.x, page.y + (content.height() / 4f))
            SystemClock.sleep(400)
        }
        val before = activeTabId()
        key(KeyEvent.KEYCODE_TAB, ctrl = true)
        check("Ctrl+Tab moves to the next tab", awaitUntil(6_000) { activeTabId() != before && activeTabId() != null }, "$before -> ${activeTabId()}")
        coreInvoke("tab.activate", JSONObject().put("tabId", ALPHA).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == ALPHA && pageCenter(ALPHA) != null }
    }

    // --- 6. density ------------------------------------------------------------------------------

    private fun densitySection() {
        val dpr0 = jsNumber("window.devicePixelRatio")
        val width0 = jsNumber("window.innerWidth")
        val density0 = onMain { activity.resources.displayMetrics.densityDpi }
        shellCommand("wm density 128")
        val followed = awaitUntil(12_000) { near(jsNumber("window.devicePixelRatio"), 0.8, 0.01) }
        SystemClock.sleep(1_500)
        readWindow()
        finding(
            "  wm density 128: chrome dpr $dpr0 -> ${jsNumber("window.devicePixelRatio")}, viewport ${width0.roundToInt()} -> ${jsNumber("window.innerWidth").roundToInt()} CSS px, " +
                "activity density $density0 -> ${onMain { activity.resources.displayMetrics.densityDpi }} dpi, window $window, form factor ${jsText(FORM_FACTOR)}, " +
                "sw${activity.resources.configuration.smallestScreenWidthDp}dp"
        )
        check(
            "a density change (160 -> 128 dpi) reaches the chrome live: devicePixelRatio 1 -> 0.8 with the document intact, no relaunch",
            followed && jsText("window.__dexRun") == runMark && !activity.isDestroyed,
            "dpr ${jsNumber("window.devicePixelRatio")}, mark '${jsText("window.__dexRun")}', destroyed ${activity.isDestroyed}"
        )
        still("density-128")
        shellCommand("wm density 160")
        val restored = awaitUntil(12_000) { near(jsNumber("window.devicePixelRatio"), 1.0, 0.01) }
        SystemClock.sleep(1_000)
        finding("  wm density 160: dpr ${jsNumber("window.devicePixelRatio")} (${if (restored) "back" else "NOT back"}), viewport ${jsNumber("window.innerWidth").roundToInt()} CSS px")
        check("back at 160 dpi the chrome is at dpr 1 again, still the one document", restored && jsText("window.__dexRun") == runMark, "")
    }

    // --- reads -----------------------------------------------------------------------------------

    /** The centre of the first element `selector` matches, screen px; null (and a note) when none. */
    private fun at(selector: String): PointF? {
        val box = screen(domRect(selector)) ?: run {
            finding("  ($selector is not on screen)")
            return null
        }
        return PointF(box.exactCenterX(), box.exactCenterY())
    }

    /** The tab's page WebView, read on the main thread. */
    private fun pageView(tabId: String): View? = onMain { host.tabs.get(tabId) }

    /** The centre of the tab's page WebView on the screen; null when it is not shown. */
    private fun pageCenter(tabId: String): PointF? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) {
            null
        } else {
            val at = IntArray(2)
            view.getLocationOnScreen(at)
            PointF(at[0] + view.width / 2f, at[1] + view.height / 2f)
        }
    }

    /** A token's computed colour, as `rgb(...)` / `rgba(...)`, off a probe element appended inside `within` (the scope the token is set for; the body when it is not on screen). */
    private fun probeColor(token: String, within: String): String =
        jsString(
            "(function(){var h=document.querySelector(${JSONObject.quote(within)})||document.body;var p=document.createElement('div');" +
                "p.style.background='var($token)';h.appendChild(p);var c=getComputedStyle(p).backgroundColor;p.remove();return c})()"
        )

    private fun backgroundOf(selector: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?getComputedStyle(e).backgroundColor:'none'})()")

    private fun opacityOf(selector: String): Double =
        jsNumber("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?getComputedStyle(e).opacity:-1})()")

    /** The sidebar rows whose computed background is `color`, by tab id. */
    private fun rowsWith(color: String): List<String> =
        jsArray(
            "Array.prototype.filter.call(document.querySelectorAll('$SIDEBAR [data-tab-id]'),function(e){return getComputedStyle(e).backgroundColor===${JSONObject.quote(color)}})" +
                ".map(function(e){return e.getAttribute('data-tab-id')})"
        ).strings()

    private fun menuRowsWith(color: String): Int =
        jsNumber("Array.prototype.filter.call(document.querySelectorAll('$MENU [role=\"menuitem\"]'),function(e){return getComputedStyle(e).backgroundColor===${JSONObject.quote(color)}}).length").toInt()

    /**
     * The pointer icon the WebView set on its view (Chromium's `onCursorChanged`, the shape the
     * system draws for the mouse over it), named: `hand`, `text`, `arrow`, `none`, or `default`
     * when none was set yet.
     */
    private fun cursorOf(view: View?): String = onMain {
        val icon = view?.pointerIcon
        when {
            view == null -> "no view"
            icon == null -> "default (none set)"
            icon == PointerIcon.getSystemIcon(activity, PointerIcon.TYPE_HAND) -> "hand"
            icon == PointerIcon.getSystemIcon(activity, PointerIcon.TYPE_TEXT) -> "text"
            icon == PointerIcon.getSystemIcon(activity, PointerIcon.TYPE_ARROW) -> "arrow"
            icon == PointerIcon.getSystemIcon(activity, PointerIcon.TYPE_NULL) -> "none"
            else -> "other ($icon)"
        }
    }

    private fun zoomOf(tabId: String): Double =
        coreState().getJSONObject("tabs").optJSONObject(tabId)?.optDouble("zoom", Double.NaN) ?: Double.NaN

    private fun pageWidth(tabId: String): Double = pageJs(tabId, "window.innerWidth").toDoubleOrNull() ?: Double.NaN

    /** The engine's own scale of the page: its visual viewport against the layout viewport. */
    private fun pageScale(tabId: String): Double = pageJs(tabId, "window.visualViewport.scale").toDoubleOrNull() ?: Double.NaN

    private fun pageScrollY(tabId: String): Double = pageJs(tabId, "window.scrollY").toDoubleOrNull() ?: Double.NaN

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun focusName(): String = onMain { activity.currentFocus?.javaClass?.simpleName ?: "none" }

    private fun near(value: Double, expected: Double, tolerance: Double = 0.001): Boolean =
        value.isFinite() && abs(value - expected) <= tolerance

    /** A key press (down and up) with Ctrl held when `ctrl`, through the input dispatcher (the instrumentation's own injection while UiAutomation is disconnected). */
    private fun key(keyCode: Int, ctrl: Boolean = false) {
        val meta = if (ctrl) KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON else 0
        val down = SystemClock.uptimeMillis()
        injectInput(KeyEvent(down, down, KeyEvent.ACTION_DOWN, keyCode, 0, meta), true)
        SystemClock.sleep(40)
        injectInput(KeyEvent(down, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0, meta), true)
    }

    private fun setClipboard(text: String) {
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText("dex windowing demo", text))
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /**
     * Where a mouse event gets to inside the app, for the hover diagnosis: every motion event
     * from a mouse source at the WINDOW (the window's callback, the first thing the view root
     * hands an event to – before the decor and the view tree), at the ROOT the chrome and the
     * pages sit in (its generic-motion listener: a hover no child took), at the CHROME view and
     * at Alpha's PAGE view (their hover and generic-motion listeners, ahead of the WebView's own
     * handling and leaving it in place). The chrome document's side is [POINTER_PROBE_START].
     * Tallied by action with the first and last point, plus the source, tool type and device id
     * of the first event seen (what Chromium keys its mouse handling on).
     */
    private inner class HoverTrace {
        private val window = ArrayList<String>()
        private val root = ArrayList<String>()
        private val chrome = ArrayList<String>()
        private val page = ArrayList<String>()
        private var original: Window.Callback? = null
        private var rootView: View? = null
        private var pageView: View? = null

        fun install(page: View?) {
            pageView = page
            onMain {
                val callback = activity.window.callback
                if (callback != null) {
                    original = callback
                    activity.window.callback = object : Window.Callback by callback {
                        override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
                            note(window, event)
                            return callback.dispatchGenericMotionEvent(event)
                        }

                        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                            note(window, event)
                            return callback.dispatchTouchEvent(event)
                        }
                    }
                }
                rootView = host.chrome.parent as? View
                rootView?.setOnGenericMotionListener { _, e ->
                    note(root, e)
                    false
                }
                host.chrome.setOnHoverListener { _, e ->
                    note(chrome, e)
                    false
                }
                host.chrome.setOnGenericMotionListener { _, e ->
                    note(chrome, e)
                    false
                }
                page?.setOnHoverListener { _, e ->
                    note(this.page, e)
                    false
                }
                page?.setOnGenericMotionListener { _, e ->
                    note(this.page, e)
                    false
                }
            }
            chromeJs(POINTER_PROBE_START)
        }

        fun remove() {
            onMain {
                original?.let { activity.window.callback = it }
                original = null
                rootView?.setOnGenericMotionListener(null)
                host.chrome.setOnHoverListener(null)
                host.chrome.setOnGenericMotionListener(null)
                pageView?.setOnHoverListener(null)
                pageView?.setOnGenericMotionListener(null)
            }
            chromeJs("if(window.__dexPtrOff)window.__dexPtrOff();'ok'")
        }

        fun reset() {
            for (list in listOf(window, root, chrome, page)) synchronized(list) { list.clear() }
        }

        fun report(): String =
            "window [${tally(window)}], root unhandled [${tally(root)}], chrome view [${tally(chrome)}], page view [${tally(page)}]"

        /** The button presses and releases the PAGE view saw since the last [reset]: a click meant for the chrome that got there is Android 14's (x, x) routing. */
        fun pageButtons(): Int = synchronized(page) {
            page.count { it.startsWith("ACTION_BUTTON_PRESS@") || it.startsWith("ACTION_BUTTON_RELEASE@") }
        }

        private fun note(into: ArrayList<String>, event: MotionEvent) {
            if (!event.isFromSource(InputDevice.SOURCE_MOUSE)) return
            synchronized(into) {
                if (into.isEmpty()) {
                    into += "@src 0x${Integer.toHexString(event.source)} tool ${event.getToolType(0)} dev ${event.deviceId} btn ${event.buttonState}"
                }
                if (into.size < 600) into += "${MotionEvent.actionToString(event.actionMasked)}@${event.x.roundToInt()},${event.y.roundToInt()}"
            }
        }

        private fun tally(events: List<String>): String {
            val list = synchronized(events) { events.toList() }
            if (list.isEmpty()) return "nothing"
            val meta = list.first().removePrefix("@")
            val hits = list.drop(1).groupBy { it.substringBefore('@') }
            return hits.entries.joinToString(", ") { (action, at) ->
                "$action x${at.size} (${at.first().substringAfter('@')} -> ${at.last().substringAfter('@')})"
            } + "; $meta"
        }
    }

    companion object {
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /** `ActivityOptions.KEY_LAUNCH_WINDOWING_MODE` and `WindowConfiguration.WINDOWING_MODE_FREEFORM`: the options bundle's own key and value, not in the SDK. */
        private const val KEY_LAUNCH_WINDOWING_MODE = "android.activity.windowingMode"
        private const val WINDOWING_MODE_FREEFORM = 5
        private val WINDOWING_MODE = Regex("mWindowingMode=(\\w+)")
        private val WM_SIZE = Regex("(\\d+)x(\\d+)")
        /**
         * The poses, display px on the 1600 x 1000 @ 160 display the workflow lays out (one px a dp,
         * the chrome at dpr 1): 1100 x 760 is the tablet's, 500 x 760 the phone's – the layout turns
         * on the window's short side against `PHONE_MAX_WIDTH` (600), so the width alone crosses it.
         */
        private val TABLET_BOUNDS = Rect(100, 100, 1200, 860)
        private val PHONE_BOUNDS = Rect(100, 100, 600, 860)
        /** Eight steps of 75 px: the seventh (575 wide) is the first under the threshold. */
        private const val RESIZE_STEPS = 8
        private const val RESIZE_STEP_MS = 260L
        /** A tab activation's page swap on the recipe's emulator: its frames run to seconds under this window. */
        private const val PAGE_SWAP_MS = 15_000L
        /** A held width's relayout on the same emulator, for the stepped stills (unmeasured). */
        private const val STEP_SETTLE_MS = 10_000L

        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val PHONE_BAR = ".zen-phone-bar"
        private const val TOOLBAR = ".zen-tablet-toolbar"
        private const val ADDRESS_PILL = "$TOOLBAR [data-address-pill]"
        private const val SIDEBAR_TOGGLE = "$TOOLBAR [data-tablet-sidebar-toggle]"
        private const val MENU_BUTTON = "$TOOLBAR [data-zen-app-menu-button]"
        private const val MENU = ".zen-v2-menu"
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val FORM_FACTOR = "document.documentElement.dataset.formFactor"
        private const val DATA_HOVER = "document.documentElement.dataset.hover"
        private const val PASTE_AND_GO = "Paste and go"
        private fun row(tabId: String) = "$SIDEBAR [data-tab-id=\"$tabId\"]"

        /**
         * The chrome's own frames while the window changes: per `requestAnimationFrame`, the time,
         * the viewport, the form factor and the root's box (`.zen-window`, the shell's root on either
         * layout), read back as one array once the drag is over.
         */
        private const val FRAME_PROBE_START =
            "window.__dexFrames=[];window.__dexProbe=true;(function f(){if(!window.__dexProbe)return;" +
                "var r=document.querySelector('.zen-window');var b=r?r.getBoundingClientRect():null;" +
                "window.__dexFrames.push([Math.round(performance.now()),window.innerWidth,window.innerHeight," +
                "document.documentElement.dataset.formFactor||'',b?Math.round(b.width):-1,b?Math.round(b.height):-1]);" +
                "requestAnimationFrame(f)})();'ok'"
        private const val FRAME_PROBE_READ = "(function(){window.__dexProbe=false;return window.__dexFrames||[]})()"

        /**
         * The chrome document's side of the hover trace: every pointer and mouse event that
         * reaches the window (capture phase, so a handler that stops one still counts), tallied
         * by type, and the last twelve as `type:pointerType:x,y[:bN]:target` – the target's tag,
         * `[pill]` inside the address pill, `[tab <id>]` inside a tab row. Installing again
         * replaces the last probe.
         */
        private const val POINTER_PROBE_START =
            "(function(){if(window.__dexPtrOff)window.__dexPtrOff();window.__dexPtr=[];window.__dexPtrCount={};" +
                "var types=['pointerover','pointermove','pointerdown','pointerup','mousemove','mouseover','mousedown','mouseup','click','contextmenu'];" +
                "var buttoned={pointerdown:1,pointerup:1,mousedown:1,mouseup:1,click:1,contextmenu:1};" +
                "function name(t){if(!t||!t.tagName)return String((t&&t.nodeName)||'?');var n=t.tagName.toLowerCase();" +
                "if(t.closest('[data-address-pill]'))n+='[pill]';var r=t.closest('[data-tab-id]');if(r)n+='[tab '+r.getAttribute('data-tab-id')+']';return n}" +
                "function on(e){window.__dexPtrCount[e.type]=(window.__dexPtrCount[e.type]||0)+1;" +
                "window.__dexPtr.push(e.type+':'+(e.pointerType||'-')+':'+Math.round(e.clientX)+','+Math.round(e.clientY)+(buttoned[e.type]?':b'+e.button:'')+':'+name(e.target));" +
                "if(window.__dexPtr.length>400)window.__dexPtr.shift()}" +
                "types.forEach(function(t){window.addEventListener(t,on,true)});" +
                "window.__dexPtrOff=function(){types.forEach(function(t){window.removeEventListener(t,on,true)});window.__dexPtrOff=null};return 'ok'})()"
        private const val POINTER_PROBE_COUNTS = "JSON.stringify(window.__dexPtrCount||{})"
        private const val POINTER_PROBE_LAST = "JSON.stringify((window.__dexPtr||[]).slice(-12))"
    }
}
