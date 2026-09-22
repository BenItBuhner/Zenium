package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.TracingConfig
import android.webkit.TracingController
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Everything a recorded demo of the phone chrome needs besides its own sequence: seeding a
 * profile from an asset, launching the app, measuring the window and the address pill,
 * synthesising touches through UiAutomation as real pointer events (interpolated in real time,
 * so the chrome measures genuine finger velocities), looking elements up in the accessibility
 * tree, and the handshake with the workflow's screen recorder.
 *
 * Handshake (files under the app's `files/<handshakeDir>/`, the workflow's `DEMO_DIR`):
 *  - the driver writes `record` once its warm-up is done and waits for `recording`, which the
 *    workflow creates after starting `screenrecord`;
 *  - it writes `done` when the sequence is over, so the recording stops before the process does;
 *  - screenshots land next to them as `<shotPrefix>-<name>.png`;
 *  - the frame statistics of every scene the driver measured ([measureFrames], [traceFrames])
 *    land there too, as `frames.jsonl` (one JSON line per scene) and `frames.txt` (the tables),
 *    with the raw dumps and the scenes' WebView traces (`trace-<scene>.json.gz`).
 *
 * `stateAsset` is the profile to seed; `null` leaves the profile empty (the first run). A demo
 * that is the second act of another – the process was stopped between them (`am force-stop`
 * from the workflow script: the instrumentation shares the process, so no driver survives that)
 * and this one proves what came back – passes `keepProfile`: the profile and the app's caches
 * are left as the first act's process left them, and only the handshake directory is reset.
 * `uiAutomationFlags` go to [android.app.Instrumentation.getUiAutomation]: by default connecting
 * suspends every other accessibility service for the run, and a demo that wants TalkBack to stay
 * up passes [UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES].
 */
abstract class DemoHarness(
    private val stateAsset: String?,
    private val shotPrefix: String,
    handshakeDir: String,
    uiAutomationFlags: Int = 0,
    private val keepProfile: Boolean = false
) {
    protected val instrumentation = InstrumentationRegistry.getInstrumentation()
    protected val ui: UiAutomation = instrumentation.getUiAutomation(uiAutomationFlags)
    protected val app: Context = instrumentation.targetContext
    protected val out = File(app.filesDir, handshakeDir)
    protected val density = app.resources.displayMetrics.density
    protected lateinit var activity: Activity
    protected var width = 0
    protected var height = 0
    protected lateinit var pill: Rect
    protected var pillY = 0f
    protected var pillCenterX = 0f
    /** When [launch] last started the app (uptime ms): the clock the core's startup schedule runs on. */
    protected var appLaunchedAt = 0L
    /**
     * The part of the window a finger's touch reaches the app in: below the status bar and above
     * the navigation bar's window. The system bars are windows of their own and take every touch
     * inside them, and the 3-button navigation bar's window is 48 dp tall whatever inset it
     * reports (the API 34 emulator reports 24 dp and the chrome lays its bar out to that, so a
     * sheet's bottom row may run under the buttons: a touch there goes to SystemUI, not the app).
     */
    protected lateinit var touchable: Rect
    /** Finger travel (px) that opens the overview completely, mirroring `overviewTravel()`. */
    protected var overviewTravel = 0f

    protected abstract val tag: String

    /** Warm the cards up (visit tabs so they have thumbnails); runs before the recorder rolls. */
    protected abstract fun warmUp()

    /** The recorded sequence. */
    protected abstract fun demo()

    /** A chance to edit the seeded profile's JSON (a colour scheme from the `theme` argument, say). */
    protected open fun patchState(json: String): String = json

    /** A chance to prepare the device once the profile is seeded and before the app starts. */
    protected open fun beforeLaunch() {}

    /**
     * Seed, launch, warm up, hand over to the recorder, run the sequence. Fails once the
     * recording is done when a touch a step injected did not take ([touchFault]). The stills
     * are flushed whether the sequence ran through or threw, so a failed run keeps the
     * evidence it took on the way ([awaitShots]).
     */
    protected fun runDemo() {
        val info = ui.serviceInfo
        info.flags = info.flags or
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            // Popups (the text selection's floating toolbar) are windows of their own: findInWindows.
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        ui.serviceInfo = info

        seedProfile()
        beforeLaunch()
        launch()
        measure()
        warmUp()
        handshake()
        try {
            demo()
        } finally {
            // A sequence that threw (a driver's `error(...)`) still lands its stills before the
            // instrumentation's exit takes the process, and with them the frames of the failure.
            awaitShots()
            // The frames record settled with every scene known (a baseline measured after the
            // scene that names it); a failure here never hides the driver's own.
            try {
                settleFrames()
            } catch (e: RuntimeException) {
                Log.e(tag, "the frames record could not be settled", e)
            }
            // The scenes are measured: the sweeps this run held may go.
            releaseBackgroundWork()
        }
        // Tell the recorder to stop while the app is still on screen: the instrumentation's exit
        // kills the process, and the launcher must not be the last frame.
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
        Log.i(tag, "done")
        val faults = ArrayList<String>()
        if (touchFaults.isNotEmpty()) {
            faults += "${touchFaults.size} touch(es) did not take: ${touchFaults.joinToString("; ")}"
        }
        if (jankFaults.isNotEmpty()) {
            faults += "${jankFaults.size} scene(s) over the jank budget under a hard gate:\n" + jankFaults.joinToString("\n")
        }
        if (faults.isNotEmpty()) throw AssertionError(faults.joinToString("\n"))
    }

    // --- setup -----------------------------------------------------------------------------------

    private fun seedProfile() {
        if (!keepProfile) {
            val zen = File(app.filesDir, "zen").apply { mkdirs() }
            zen.listFiles()?.forEach { it.delete() }
            if (stateAsset != null) {
                File(zen, "state.json").writeText(patchState(readAsset(stateAsset)))
                seedMore(zen)
            }
        }
        out.deleteRecursively()
        out.mkdirs()
    }

    /** Write what the profile needs besides `state.json` (history.json, downloads.json, …) into `zen`. */
    protected open fun seedMore(zen: File) {}

    protected fun readAsset(name: String): String =
        instrumentation.context.assets.open(name).use { it.bufferedReader().readText() }

    /**
     * Start the app (again: a fresh activity, so the chrome and the core boot into a new session).
     * The launcher entry is an icon alias that hands over to MainActivity and finishes at once;
     * the demo needs the browser's own activity, so it starts that directly.
     */
    protected fun launch() {
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (holdBackgroundWork) intent.putExtra(BackgroundWorkHold.EXTRA_HOLD, true)
        appLaunchedAt = SystemClock.uptimeMillis()
        activity = instrumentation.startActivitySync(intent)
        // The chrome is a WebView booting the browser core: wait for the address pill to show up.
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (findByLabelPrefix(PILL_LABEL) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    /** A system dialog (an ANR of some other app, say) on top of the browser would take the touches. */
    protected fun ensureForeground() {
        repeat(5) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            Log.w(tag, "window of $top is in front; sending back")
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(1_000)
        }
    }

    private fun measure() {
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        val found = findByLabelPrefix(PILL_LABEL)?.takeIf { it.top > height * 0.6 && it.width() > 100 * density }
        pill = found ?: computedPill(insets.bottom)
        pillY = pill.exactCenterY()
        pillCenterX = pill.exactCenterX()
        touchable = touchableBand(insets)
        overviewTravel = max(220 * density, 0.42f * (height - insets.top - insets.bottom - 64 * density))
        Log.i(
            tag,
            "window ${width}x${height} density $density insets ${insets.top}/${insets.bottom} " +
                "(tappable ${insets.tappableBottom} below) touchable $touchable pill $pill " +
                "(${if (found != null) "from accessibility" else "computed"}) overview travel $overviewTravel"
        )
    }

    /**
     * `tappableBottom` is the `tappableElement` inset: how far up from the bottom the system says
     * a touch cannot reach the app (0 under a gesture bar, the bar's height under buttons).
     */
    protected class Insets(val windowWidth: Int, val windowHeight: Int, val top: Int, val bottom: Int, val tappableBottom: Int = bottom)

    /** The window and its system bar insets – the same numbers the chrome lays itself out with. */
    protected fun windowInsets(): Insets {
        var result = Insets(0, 0, 0, 0)
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val all = ViewCompat.getRootWindowInsets(root)
            val bars = all?.getInsets(WindowInsetsCompat.Type.systemBars())
            val tappable = all?.getInsets(WindowInsetsCompat.Type.tappableElement())
            result = Insets(root.width, root.height, bars?.top ?: 0, bars?.bottom ?: 0, tappable?.bottom ?: (bars?.bottom ?: 0))
        }
        if (result.windowWidth == 0 || result.windowHeight == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            result = Insets(probe.width, probe.height, result.top, result.bottom, result.tappableBottom)
            probe.recycle()
        }
        return result
    }

    /** [touchable] from the window's insets: see the field for why the bottom band is at least [NAV_BAR_WINDOW_DP]. */
    protected fun touchableBand(insets: Insets): Rect {
        val bottomBand = max(max(insets.bottom, insets.tappableBottom), (NAV_BAR_WINDOW_DP * density).roundToInt())
        return Rect(0, insets.top, insets.windowWidth, insets.windowHeight - bottomBand)
    }

    /** Where the pill is when the accessibility tree does not say: below the page, between the buttons. */
    private fun computedPill(bottomInset: Int): Rect {
        val centerY = height - bottomInset - 28 * density
        return Rect(
            (56 * density).roundToInt(),
            (centerY - 22 * density).roundToInt(),
            (width - 152 * density).roundToInt(),
            (centerY + 22 * density).roundToInt()
        )
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(tag, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(1_500)
    }

    // --- shared moves ----------------------------------------------------------------------------

    protected fun beat() = SystemClock.sleep(1_500)

    /**
     * Cross the slop (so the axis is locked and no long press can start) and wait for the stage.
     * The first touch on the pill snapshots the live page before the cards can replace it; on
     * hardware that takes a frame, on the emulator's software GPU the better part of a second.
     */
    protected fun Finger.settleIn(dx: Float, dy: Float) {
        moveBy(dx, dy, 60)
        hold(STAGE_WAIT)
    }

    /** A quick fling from the right end of the pill: next tab. */
    protected fun flingLeft() {
        val f = Finger()
        f.down(pill.right - 10f, pillY)
        f.moveBy(-0.40f * width, 0f, 120)
        f.up()
    }

    /** A quick fling from the left end of the pill: previous tab. */
    protected fun flingRight() {
        val f = Finger()
        f.down(pill.left + 10f, pillY)
        f.moveBy(0.40f * width, 0f, 120)
        f.up()
    }

    /**
     * A touch that captures the page (the chrome snapshots the active tab on pointer down) but
     * neither taps nor swipes: it moves away from the middle of the screen, which the pill ignores.
     */
    protected fun touchWithoutGesture() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.moveBy(0f, 40f, 150)
        f.hold(150)
        f.up()
    }

    /**
     * Snapshot, spring, tab activation and the first paint of a page that was never loaded. Long
     * enough that the next touch starts a fresh gesture (and snapshot) instead of catching this one.
     */
    protected fun settle() = SystemClock.sleep(4_500)

    /**
     * A still of the screen as it is now. The frame is taken here (the compositor's, some
     * 100 ms); its PNG encode, a second or two of the emulator's CPU for a 720x1600 frame, runs
     * on one background thread in the order the stills were taken, so a driver racing a clock
     * (a toast's five seconds) does not spend it here. [runDemo] waits for the encodes. Until
     * #207 the encode ran here, an implicit one-to-two-second pause after every still: a step
     * that reads the chrome right after a still and needs the screen to have moved on since
     * must wait for that itself (poll for the change, or [settle]), not lean on the still.
     */
    protected fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        val file = File(out, "$shotPrefix-$name.png")
        shotEncoder.execute {
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    private val shotEncoder = Executors.newSingleThreadExecutor()

    /** Every still taken so far is on disk. */
    protected fun awaitShots() {
        shotEncoder.submit {}.get(2, TimeUnit.MINUTES)
    }

    /** Breadth-first search of the active window for a node labelled `label` (aria-label or text). */
    protected fun findByLabel(label: String): Rect? =
        findNode { it == label }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /** Like [findByLabel] for labels that carry a changing suffix (`Address, example.com`). */
    protected fun findByLabelPrefix(prefix: String): Rect? =
        findNode { it == prefix || it.startsWith("$prefix,") }?.let { node ->
            Rect().also { node.getBoundsInScreen(it) }
        }

    private fun findNode(label: String): AccessibilityNodeInfo? = findNode { it == label }

    /**
     * A control of the phone bar's pill by its label – the site-information glyph, the lock, a
     * chip – as the CLICKABLE node reading `label` whose bounds lie in the pill's row, polled for
     * up to `timeoutMs`; null when none shows. [findByLabel] walks the whole window breadth first,
     * the pages' WebViews included, and answers the shallowest match: a page that carries the
     * same words answers before the pill once the pill's stops sit deeper in the chrome's tree
     * than the page's text (#237 made the pill one TalkBack stop, #260 keeps its three stops in
     * the pill's run). The recede demo's page has a table cell reading "Site information" a row
     * under its fold; its bounds, clipped to the page's edge, put the finger on the pill's
     * top-left corner – the address stop – and the URL field opened where the site-information
     * sheet was expected (PERF-4's main-tip runs). A page's cell is neither clickable nor in the
     * pill's row. The row is the pill's as it stands now (the `Address` stop, found afresh: the
     * bar may have changed edges since [measure]), else the pill measured at the start.
     */
    protected fun pillControl(label: String, timeoutMs: Long = 4_000): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        val reads = labelled { it == label }
        while (true) {
            val row = findByLabelPrefix(PILL_LABEL) ?: pill
            val node = findNodeWhere { node ->
                node.isClickable && reads(node) &&
                    Rect().also { node.getBoundsInScreen(it) }.let { !it.isEmpty && it.top < row.bottom && it.bottom > row.top }
            }
            if (node != null) return node
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(200)
        }
    }

    /** A node's class, label, bounds and clickability, for a driver's log of what a finger was aimed at. */
    protected fun describeNode(node: AccessibilityNodeInfo?): String =
        node?.let {
            "${it.className} '${it.text ?: it.contentDescription}' ${Rect().also { r -> it.getBoundsInScreen(r) }} clickable=${it.isClickable}"
        } ?: "nothing"

    /** The first node (breadth-first) whose label or text satisfies `matches`, with its state. */
    protected fun findNode(matches: (String) -> Boolean): AccessibilityNodeInfo? =
        findNodes(matches).firstOrNull()

    /** Every node in the active window labelled `label`, breadth first (a panel's per-row controls). */
    protected fun findNodes(label: String): List<AccessibilityNodeInfo> = findNodes { it == label }

    /** Every node in the active window whose label or text satisfies `matches`, breadth first (per-row controls named after their row). */
    protected fun findNodes(matches: (String) -> Boolean): List<AccessibilityNodeInfo> =
        findNodesWhere(accept = labelled(matches))

    /** Accepts a node whose content description or text satisfies `matches`. */
    private fun labelled(matches: (String) -> Boolean): (AccessibilityNodeInfo) -> Boolean = { node ->
        val description = node.contentDescription?.toString()
        val text = node.text?.toString()
        (description != null && matches(description)) || (text != null && matches(text))
    }

    /**
     * The first node (breadth-first) that `accept`s, with its state: a row's label and the switch
     * labelled after it both answer to the label, only one of them is checkable.
     */
    protected fun findNodeWhere(accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? =
        findNodesWhere(firstOnly = true, accept = accept).firstOrNull()

    /**
     * The first labelled node in any window on screen, not just the active one: a popup such as
     * the text selection's floating toolbar (Copy, Share, Select all) is a window of its own.
     * With `packageName`, only that package's windows are walked: every node read is a binder
     * round trip, and the app's own WebView tree runs to thousands, so a look for something of
     * the system's (the picture-in-picture menu, which hides itself after a few seconds) must
     * not walk the app's tree first.
     */
    protected fun findInWindows(matches: (String) -> Boolean): AccessibilityNodeInfo? = findInWindows(null, matches)

    protected fun findInWindows(packageName: String?, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val accept = labelled(matches)
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (packageName != null && root.packageName?.toString() != packageName) continue
            findNodesWhere(root, firstOnly = true, accept).firstOrNull()?.let { return it }
        }
        return null
    }

    /** Every node under `root` (the active window's by default) that `accept`s, breadth first (just the first with `firstOnly`). */
    private fun findNodesWhere(
        root: AccessibilityNodeInfo? = ui.rootInActiveWindow,
        firstOnly: Boolean = false,
        accept: (AccessibilityNodeInfo) -> Boolean
    ): List<AccessibilityNodeInfo> {
        if (root == null) return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (accept(node)) {
                found += node
                if (firstOnly) return found
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /** The first of several labels that is on screen (a tab's title changes once its page loads). */
    protected fun findAny(vararg labels: String): Rect? = labels.firstNotNullOfOrNull { findByLabel(it) }

    /**
     * Scroll the first of these labels fully into view (the chrome scrolls its grid the least it
     * has to) and return where it is then; null when none exists.
     */
    protected fun reveal(vararg labels: String): Rect? {
        val label = labels.firstOrNull { findNode(it) != null } ?: return null
        findNode(label)?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findByLabel(label)
    }

    /**
     * Click the nearest clickable ancestor of a labelled node through the accessibility tree – the
     * bounds it reports for content inside a scrolled list lag behind on the emulator, so a touch
     * at them would miss. Every node carrying the label is tried (a heading and a row can share
     * one). False when none of them has a clickable ancestor. `enabledOnly` skips disabled matches
     * (the bar's own button of the same name under a sheet).
     */
    protected fun clickByLabel(label: String, enabledOnly: Boolean = false): Boolean {
        for (match in findNodes(label)) {
            if (enabledOnly && !match.isEnabled) continue
            var node: AccessibilityNodeInfo? = match
            while (node != null && !node.isClickable) node = node.parent
            if (node != null) return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        return false
    }

    /** Poll for a label for up to `timeoutMs`. */
    protected fun waitFor(label: String, timeoutMs: Long = 5_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findByLabel(label)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /** Poll until nothing on screen reads `label`, for up to `timeoutMs`; false when it is still there. */
    protected fun waitForGone(label: String, timeoutMs: Long = 5_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) == null) return true
            SystemClock.sleep(200)
        }
        return false
    }

    // --- pressing a control: a finger, or the accessibility tree ---------------------------------
    //
    // Two ways to press, for two different claims. [touchTap] and [touchTapLabel] inject a REAL
    // touch – ACTION_DOWN and ACTION_UP through UiAutomation inside the node's bounds, the path
    // `adb shell input tap` takes – so the WebView hit-tests it as it would a finger: the
    // chrome's layers, scrims and `pointer-events` cuts all have their say. A step whose claim is
    // "the user can tap this" uses one of them ([tapLabel] and [Finger.tap] are the same touch
    // with a caller-owned finger) and reads the outcome afterwards, through the tree or the
    // core's state (the row's new value, an option's checked state), never off the return value.
    // [clickByLabel] performs ACTION_CLICK on the accessibility node: no hit test, so it lands on
    // a control a finger cannot reach, and on bounds that trail a scrolled list. It is for getting
    // to a state (set-up off camera, a row deep in a list the tree has not caught up with), never
    // for the claim that a tap works: from v0.3.42 to v0.3.45 no phone Settings sheet took a real
    // touch (#192: the tap fell through the sheet to the host's scrim), and every driver that
    // pressed the sheets' rows through the tree passed.
    //
    // Where the finger lands: the WebView's tree reports a row that has just moved (a sheet's
    // rows while it rises) where it was a few frames ago, so a touch waits for the node's bounds
    // to settle ([steadyBounds]); and it aims at the middle of the bounds' part inside
    // [touchable], not of the bounds themselves, since a sheet's bottom row runs under the
    // navigation bar's window and a touch there never reaches the app ([touchPoint]).
    //
    // The rule for a driver (the audit after #194): a sheet flow must include at least one
    // injected touch, and the result of that touch is asserted. A sheet flow is every sequence
    // that presses a control inside a sheet – the app menu and its submenus, a picker, a prompt,
    // the site-information sheet, an editor, a panel on the phone, a native sheet of the app's –
    // and the touch is a finger on a control inside it ([touchTapLabelExpecting] is the shape of
    // such a step; a driver with a finger of its own reports the miss with [touchFault]). The
    // result is what that control does – the row's new value, the next level's control, the
    // window that came up, the core's state – never "the sheet went away", which a touch that
    // fell through to the scrim does too. A flow that keeps [clickByLabel] for one of its steps
    // says why at the step: a row the tree still reports where it was before a scroll, a control
    // under the soft keyboard, a row that must stay below the fold for what is measured.

    /**
     * A real touch on the node reading `label` ([touchTapLabel]), then up to `timeoutMs` for
     * `took` to hold – the claim of the step, named by `effect` ("the row reads Dark"). True when
     * it held. When nothing on screen reads `label` within `findTimeoutMs` no touch goes in: false
     * and a warning, and the caller may reach the state another way. When the touch went in and
     * `took` never held, the sheet did not take the touch: a [touchFault], and false; the caller
     * may still reach the state another way so the recording goes on, the run fails regardless.
     */
    protected fun touchTapLabelExpecting(
        label: String,
        effect: String,
        timeoutMs: Long = 5_000,
        prefix: Boolean = false,
        findTimeoutMs: Long = 8_000,
        took: () -> Boolean
    ): Boolean {
        if (!touchTapLabel(label, prefix, findTimeoutMs)) return false
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                Log.i(tag, "the touch on '$label' took: $effect")
                return true
            }
            SystemClock.sleep(150)
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * Whether a Settings row labelled `label` reads `value`: the tree runs a row's label and value
     * together ("Colour scheme Dark"), so the row is the node whose text starts with the one and
     * ends with the other. What a picker's touch is checked against once the picker has closed.
     */
    protected fun rowReads(label: String, value: String): Boolean =
        findNode { it.startsWith(label) && it.endsWith(value) } != null

    /** The touches that did not take, in the order they were reported; [runDemo] fails on them at the end. */
    private val touchFaults = ArrayList<String>()

    /**
     * Report that a touch a step injected did not do what the step claims. The run goes on so the
     * recording covers the rest, and fails once it is done ([runDemo]).
     */
    protected fun touchFault(message: String) {
        Log.e(tag, "TOUCH FAULT: $message")
        touchFaults += message
    }

    /**
     * A real touch inside `node`'s bounds, where a finger's would land (see [touchPoint]). False,
     * and nothing injected, when the node has gone or no part of it is inside [touchable] (a row
     * below the fold, one under the navigation bar): the caller says so rather than touching a
     * corner.
     */
    protected fun touchTap(node: AccessibilityNodeInfo): Boolean = touchTapPoint(node) != null

    /** [touchTap], answering where the finger landed (screen px) – for a driver's findings – or null when it did not touch. */
    protected fun touchTapPoint(node: AccessibilityNodeInfo): PointF? {
        val bounds = steadyBounds(node) ?: run {
            Log.w(tag, "the node to touch went away")
            return null
        }
        val point = touchPoint(bounds) ?: run {
            Log.w(tag, "no part of $bounds is inside the touchable window $touchable")
            return null
        }
        Log.i(tag, "touch at ${point.x},${point.y} on '${node.text ?: node.contentDescription}' (bounds $bounds, touchable $touchable)")
        Finger().tap(point.x, point.y)
        return point
    }

    /** Where a finger touches `bounds`: the middle of their part inside [touchable]; null when no part is. */
    protected fun touchPoint(bounds: Rect): PointF? {
        val reach = Rect(bounds)
        if (bounds.isEmpty || !reach.intersect(touchable)) return null
        return PointF(reach.exactCenterX(), reach.exactCenterY())
    }

    /**
     * `node`'s bounds on screen once two reads [BOUNDS_SETTLE_MS] apart agree, or the last read
     * when they never do within `timeoutMs` (logged); null when the node has gone from the tree.
     */
    protected fun steadyBounds(node: AccessibilityNodeInfo, timeoutMs: Long = 3_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var bounds = Rect().also { node.getBoundsInScreen(it) }
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(BOUNDS_SETTLE_MS)
            if (!node.refresh()) return null
            val again = Rect().also { node.getBoundsInScreen(it) }
            if (again == bounds) return bounds
            bounds = again
        }
        Log.w(tag, "bounds still moving after $timeoutMs ms: $bounds")
        return bounds
    }

    /**
     * A real touch on the first node whose label or text is `label` – exactly, or with `prefix`
     * one whose text starts with it (a Settings row reads its label and value as one text) –
     * waiting up to `timeoutMs` for it to show with bounds on screen; false when none does.
     */
    protected fun touchTapLabel(label: String, prefix: Boolean = false, timeoutMs: Long = 8_000): Boolean {
        val node = awaitNode(timeoutMs) { it == label || (prefix && it.startsWith(label)) } ?: run {
            Log.w(tag, "nothing on screen reads '$label'")
            return false
        }
        return touchTap(node)
    }

    /**
     * A real touch on the first node whose label or text `matches`, found again right before the
     * finger lands. A node held across a wait, a screenshot or a script can be gone from the
     * WebView's tree by the time it is touched (Blink rebuilds the nodes under a list that
     * re-renders, as the suggestions do while their requests answer), and [touchTap] on a stale
     * node touches nothing. Up to three fresh finds within `timeoutMs`; false when none is on
     * screen in time or none stays put for the touch.
     *
     * Opt-in, like [awaitClipboardOverlayGone]: nothing in the harness calls either, and
     * [touchTap], [touchTapLabel] and [awaitNode] are as they were, so a driver that does not
     * call them runs exactly as before. A driver whose list re-renders under its finger calls
     * this in place of an `awaitNode` + `touchTap` pair (OmniboxDemo; its fallback to the DOM's
     * rect when the tree has lost the node is the driver's own, not the harness's).
     */
    protected fun touchTapFresh(timeoutMs: Long = 8_000, matches: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        repeat(3) { attempt ->
            val left = deadline - SystemClock.uptimeMillis()
            if (left <= 0) return false
            val node = awaitNode(left, matches) ?: return false
            if (touchTap(node)) return true
            Log.w(tag, "the node went stale before the touch (attempt ${attempt + 1}); finding it again")
            SystemClock.sleep(300)
        }
        return false
    }

    /**
     * Wait for the system's clipboard overlay (Android 13+, SystemUI's "ClipboardOverlay" window:
     * the copied text's preview chip with its actions – share, send to a nearby device – along the
     * bottom of the screen over the phone bar, up for some six seconds after every copy) to go, so
     * the next touch near the bottom lands in the app and not on one of the chips (a touch on the
     * nearby-device chip sent the clip to Nearby Share, whose set-up sheet paused the app).
     * `copiedAt` is [SystemClock.uptimeMillis] at the copy; `target` is where the finger will land
     * (the pill by default).
     *
     * The overlay is a full-screen TYPE_SCREENSHOT window, and the accessibility tree gives it
     * neither a title (only panels and accessibility overlays carry their WindowManager title over)
     * nor a type it names, so a wait on the title saw nothing and returned at once. It is told by
     * its place instead: a window of another package than the app's and the keyboard's (or one the
     * tree has no root for) whose bounds reach over the part of `target` inside [touchable]. The
     * clipping matters: the system bars' windows lie outside the touchable band by construction,
     * but the pill's rect from the tree reaches into the navigation bar's window (run 4: the bar's
     * `Rect(0, 1516 - 720, 1600)` over a pill ending at 1550 held the wait to its timeout, though
     * the touch itself lands inside the band). As the belt, the wait also runs the overlay's own
     * clock out – it never returns before [CLIPBOARD_OVERLAY_MS] have passed since the copy – so a
     * window the tree never reports is waited out all the same. True once nothing foreign is over
     * the target with the clock run out, within `timeoutMs`; false with it still there (logged),
     * for the caller to say so and go on.
     *
     * Opt-in: no touch helper waits for the overlay on its own, so a driver that copies nothing,
     * or touches nowhere near the bottom after a copy, is unaffected; a driver that copies and then
     * touches there calls this between the two (OmniboxDemo, between the link menu's copy and the
     * pill).
     */
    protected fun awaitClipboardOverlayGone(copiedAt: Long, target: Rect = pill, timeoutMs: Long = 15_000): Boolean {
        val clock = copiedAt + CLIPBOARD_OVERLAY_MS
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var seen: String? = null
        while (true) {
            val now = SystemClock.uptimeMillis()
            val over = foreignWindowsOver(target)
            if (over.isNotEmpty()) seen = over.joinToString()
            if (over.isEmpty() && now >= clock) {
                Log.i(
                    tag,
                    if (seen == null) "nothing over $target since the copy (${now - copiedAt} ms)"
                    else "the window over $target is gone (was $seen; ${now - copiedAt} ms after the copy)"
                )
                return true
            }
            if (now >= deadline) {
                Log.w(tag, "still a window over $target $timeoutMs ms on: $seen")
                return false
            }
            SystemClock.sleep(250)
        }
    }

    /**
     * The windows a touch on `target` could land in instead of the app's: every window the tree
     * lists whose bounds reach over the part of `target` inside [touchable] (a finger only lands
     * there; the system bars' windows sit outside the band), except the app's own and the
     * keyboard's. Each as "package bounds" ("?" for a window the tree has no root, so no package,
     * for). Empty for a target wholly outside the band.
     */
    private fun foreignWindowsOver(target: Rect): List<String> {
        val band = Rect(target)
        if (!band.intersect(touchable)) return emptyList()
        val found = ArrayList<String>()
        for (window in ui.windows) {
            if (window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue
            val pkg = window.root?.packageName?.toString()
            if (pkg == app.packageName) continue
            val bounds = Rect().also { window.getBoundsInScreen(it) }
            if (Rect.intersects(bounds, band)) found += "${pkg ?: "?"} $bounds"
        }
        return found
    }

    /** Poll up to `timeoutMs` for the first node whose label or text `matches`, with bounds on screen. */
    protected fun awaitNode(timeoutMs: Long = 8_000, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findNode(matches)?.let { node ->
                if (boundsOnScreen(Rect().also { node.getBoundsInScreen(it) })) return node
            }
            SystemClock.sleep(200)
        }
        return null
    }

    /** Non-empty bounds whose middle is inside the window. */
    protected fun boundsOnScreen(bounds: Rect): Boolean =
        !bounds.isEmpty && bounds.centerX() in 0 until width && bounds.centerY() in 0 until height

    // Shared by the drivers (moved here from the first-run driver): the API 34 emulator renders
    // in software and the WebView's accessibility tree trails a transition by seconds, so touches
    // wait generously for their label and window changes are polled for, not slept for.

    /**
     * A real touch on the middle of the node labelled `label`, waiting for it to show. The wait
     * is generous because the tree trails the screen by seconds after a transition on the
     * software-rendered emulator, and it only runs its course when the label never comes.
     */
    protected fun tapLabel(f: Finger, label: String, timeoutMs: Long = 8_000): Boolean {
        val target = waitFor(label, timeoutMs) ?: run {
            Log.w(tag, "no node labelled '$label'")
            return false
        }
        f.tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    /** The system's back action (what the gesture ends in), through UiAutomation. */
    protected fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /**
     * The host's own word on whether the chrome has a surface a back would dismiss (a menu, a
     * sheet, a panel, a Settings section over its landing): what `back.update` last told
     * [PredictiveBack]. The accessibility tree trails a transition by seconds on the emulator's
     * software GPU; this does not.
     */
    protected fun chromeSurfaceUp(): Boolean {
        var up = false
        instrumentation.runOnMainSync { up = (activity as? MainActivity)?.host?.back?.chromeSurfaceUp ?: false }
        return up
    }

    /** Poll the host until the chrome reports a surface up or not (`up`); false when it does not in time. */
    protected fun awaitSurface(up: Boolean, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeSurfaceUp() == up) return true
            SystemClock.sleep(150)
        }
        return chromeSurfaceUp() == up
    }

    /** Another app's window (a system dialog) is in front; false when none comes within the time. */
    protected fun awaitSystemWindow(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top != null && top != app.packageName) {
                Log.i(tag, "window of $top is in front")
                return true
            }
            SystemClock.sleep(200)
        }
        return false
    }

    /** A link handed to the browser by another app: MainActivity is singleTask and opens it in a tab. */
    protected fun openLink(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setClass(app, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
    }

    // --- the URL field ---------------------------------------------------------------------------

    /** The URL field is open in the chrome (`uiStore.urlbar.open`), off the chrome's own store, never the tree. */
    protected fun urlbarOpen(): Boolean =
        chromeJs("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true") == "true"

    /** One reading of the field for [closeUrlField]: the store first, then the host's route for a back, then the keyboard. */
    private fun readUrlField(): UrlFieldClose.Field =
        UrlFieldClose.Field(open = urlbarOpen(), chromeHandlesBack = chromeSurfaceUp(), imeUp = imeShown())

    /** The page the driver is on, for [closeUrlField]'s before-and-after: the core's active tab and the host's view for it. */
    protected fun currentPage(): UrlFieldClose.Page {
        val tab = activeCoreTab()
        val tabId = tab?.optString("id")?.takeIf { it.isNotEmpty() }
        var view: TabWebView? = null
        if (tabId != null) instrumentation.runOnMainSync { view = (activity as? MainActivity)?.host?.tabs?.get(tabId) }
        var index = -1
        view?.let { v -> instrumentation.runOnMainSync { index = v.copyBackForwardList().currentIndex } }
        return UrlFieldClose.Page(tabId, tab?.optString("url"), viewUp = view != null, historyIndex = index)
    }

    /**
     * Close the URL field when it is open (the first run ends in it, with the keyboard up, hiding
     * the page, the bar and the menu button), by the chrome's state: a back goes in only while the
     * chrome's store says the field is open AND the host says it would hand that back to the
     * chrome, one per such reading, each given [UrlFieldClose.BACK_WAIT_MS] to take (the keyboard
     * goes first when it is up, then the field). Never a second back blind: the old close read
     * the address pill off the accessibility tree, which trailed a frame on the fifth bar-hide
     * run's retry (#200), and its second back went to the page's tab at its first page and put a
     * new tab page in the demo tab's place. The page the driver was on is read before and after
     * ([currentPage]); the [UrlFieldClose.Outcome] says whether the field closed and whether the
     * page is still there, by name, for the driver's claim – a lost page fails a claim, it does
     * not derail the run. The decisions are [UrlFieldClose]'s (HarnessLogic.kt), tested on the JVM.
     */
    protected fun closeUrlField(): UrlFieldClose.Outcome {
        var field = readUrlField()
        if (!field.open) return UrlFieldClose.NOT_OPEN
        val before = currentPage()
        var backs = 0
        var hostWaitedMs = 0L
        var gaveUp: String? = null
        loop@ while (true) {
            when (val move = UrlFieldClose.nextMove(field, backs, hostWaitedMs)) {
                UrlFieldClose.Move.Done -> break@loop
                is UrlFieldClose.Move.GiveUp -> {
                    gaveUp = move.reason
                    break@loop
                }
                UrlFieldClose.Move.AwaitHost -> {
                    SystemClock.sleep(150)
                    hostWaitedMs += 150
                    field = readUrlField()
                }
                is UrlFieldClose.Move.PressBack -> {
                    val pressed = field
                    back()
                    backs++
                    Log.i(tag, "closeUrlField: back $backs, for ${if (move.keyboard) "the keyboard" else "the field"}")
                    val deadline = SystemClock.uptimeMillis() + UrlFieldClose.BACK_WAIT_MS
                    do {
                        SystemClock.sleep(150)
                        field = readUrlField()
                    } while (!UrlFieldClose.backTook(pressed, field) && SystemClock.uptimeMillis() < deadline)
                    hostWaitedMs = 0
                }
            }
        }
        val outcome = UrlFieldClose.outcome(before, currentPage(), field, backs, gaveUp)
        if (outcome.ok) Log.i(tag, "closeUrlField: ${outcome.describe()}") else Log.e(tag, "closeUrlField: ${outcome.describe()}")
        return outcome
    }

    /**
     * The old name, for a driver branch in flight that still calls it; gone next release. Every
     * driver in this tree calls [closeUrlField] and reads its outcome.
     */
    @Deprecated("Blind backs closed a tab under tree lag (#200): use closeUrlField(), which closes by the chrome's state and reports the page.", ReplaceWith("closeUrlField()"))
    protected fun closeUrlbar() {
        closeUrlField()
    }

    // --- the keyboard ----------------------------------------------------------------------------

    /** The keyboard's inset in px per the window's insets (what the chrome lays itself out with); 0 while it is down. */
    protected fun imeInset(): Int {
        var inset = 0
        instrumentation.runOnMainSync {
            val insets = ViewCompat.getRootWindowInsets(activity.window.decorView) ?: return@runOnMainSync
            if (insets.isVisible(WindowInsetsCompat.Type.ime())) inset = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        }
        return inset
    }

    protected fun imeShown(): Boolean = imeInset() > 0

    /** Poll for the keyboard to be up (or down); it takes the emulator a moment either way. */
    protected fun awaitIme(shown: Boolean, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (imeShown() == shown) return true
            SystemClock.sleep(200)
        }
        return imeShown() == shown
    }

    // --- the menu --------------------------------------------------------------------------------

    /** A finger on the bar's Menu button: by label, else where the default bar has it (rightmost, on the pill's line). */
    protected fun tapMenuButton() {
        ensureForeground()
        val button = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
    }

    private fun computedMenuButton(): Rect {
        val half = 22 * density
        val centerX = width - 30 * density
        return Rect((centerX - half).roundToInt(), (pillY - half).roundToInt(), (centerX + half).roundToInt(), (pillY + half).roundToInt())
    }

    /**
     * Open the menu, pull it to its full height so every item is in reach, and tap the item
     * labelled by `path` with a finger – every label but the last drills into a submenu first
     * (`"Bookmarks", "Show Bookmarks"`). False when the menu never opened or has no such item; the
     * menu is left as it is then (a `back()` closes it).
     */
    protected fun openMenuItem(vararg path: String): Boolean {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            Log.w(tag, "the menu never opened")
            return false
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        for ((index, item) in path.withIndex()) {
            if (reveal(item) == null) {
                Log.w(tag, "no $item in the menu")
                return false
            }
            // The finger goes in once the row's bounds hold still (the tree lags the menu's pull
            // and scroll on the emulator) and inside the touchable window ([touchTapLabel]).
            if (!touchTapLabel(item)) {
                Log.w(tag, "no bounds on screen to touch for $item")
                return false
            }
            // A submenu slides in; give it a moment before looking for its items.
            if (index < path.lastIndex) SystemClock.sleep(1_200)
        }
        return true
    }

    // --- frames: the jank budget gate ------------------------------------------------------------
    //
    // The performance program's rule (perf-program.md): no phone gesture or spring regresses
    // silently again. Every driver measures its scenes through [measureFrames] or [traceFrames],
    // the one helper, so the numbers of every run are read the same way and land in the same two
    // places: the run's findings (`frames.jsonl`, one JSON object per scene, and `frames.txt`, the
    // same as tables) and the driver's log (the table, `FRAMES` lines). The shared workflow renders
    // the record into the job summary and hands it on as its `jank-report` output; the release
    // dry-run shows main's latest table.
    //
    // TWO INSTRUMENTS, one gated. (1) HWUI's own frame statistics for the app's process, as
    // `dumpsys gfxinfo <package> framestats` reports them – `dumpsys gfxinfo <package> reset`
    // before the scene, the scene's real-touch gesture inside the block, the dump after it – read
    // by [FrameStats] (sharedTest, tested on the JVM): the frames rendered and the janky ones by
    // HWUI's rule, the 50th / 90th / 95th / 99th percentile frame times, and from the CSV of the
    // last frames each stage's time (input, animation, layout, draw, sync, the render thread's
    // draw commands, the swap, the GPU) so the long stage of every long frame is named and the
    // stage most often long is the scene's `dominant`. These are the ANDROID UI THREAD's and the
    // RENDER THREAD's numbers, and on the recipe's software GPU (`-gpu swangle`: ANGLE over
    // SwiftShader composites every 720x1600 frame on the CPU, 100 ms and more) every frame misses
    // its deadline whatever the chrome does: REPORTED, never gated. (2) The chrome WebView's own
    // Chromium trace (`android.webkit.TracingController`, [traceFrames]), read by [BlinkTrace]
    // (sharedTest): the renderer MAIN THREAD's work in the scene – Blink's layouts, paints and
    // style recalculations per frame, the main-thread time per frame, the long tasks – which is
    // where a stutter of the chrome is made and what `gfxinfo` cannot see. These the software GPU
    // does not dominate: GATED. And a scene may name a same-run BASELINE scene (the same motion
    // with the chrome's part removed: the bar-hide scroll's baseline is the same drag with the
    // setting off), against which its p95 and janky share are read as RATIOS: recipe-independent,
    // GATED. The `<package>` is the app's applicationId (`io.github.benitbuhner.zenium.debug` for
    // the debug build the drivers run against; the Kotlin package `app.zen.chromium` names no
    // process), read off the context.
    //
    // The budget: [JankBudget], one place for the numbers, a budget per scene kind (`gesture`,
    // `spring`, `open`): the ratios a scene may reach against its baseline and the trace columns
    // it may reach per frame. The gate is [jankGate]: SOFT (the default: every scene is reported,
    // nothing fails) or HARD (`-e jankGate hard`, from the driver script's `JANK_GATE` environment
    // and the workflows' `jank-gate` input): a scene over its budget is then a jank fault, and
    // like a touch fault it fails the run once the recording is done ([runDemo]) with the scene's
    // table in the message – the scene is the claim that failed, the rest of the sequence still
    // runs. The verdicts are SETTLED at the end of the run ([settleFrames]), when every baseline
    // is known; `frames.jsonl` is written as the scenes are measured and rewritten settled.
    //
    // The emulator caveat, for every reading of the HWUI numbers: a janky share of 100 percent
    // and a p50 of 300 to 500 ms here are the recipe, not the chrome. Frame times compare on ONE
    // recipe alone and are never quoted as device performance; the trace's main-thread time per
    // frame and layout / paint counts per frame are the numbers that carry over to a phone.
    //
    // The STARTUP SWEEP caveat, for the trace's long tasks (#306's recede run: `menu-sheet-open`
    // counted 10 long tasks in a soft row): the core's Safe Browsing and blocking services each
    // schedule a sweep of their feeds STARTUP_SWEEP_DELAY_MS = 20 s after they are ready
    // (`src/core/safebrowsing/service.ts`, `src/core/blocking/service.ts`), fetching every feed
    // that is stale or still the bundled snapshot – on a seeded profile, all of them – and
    // hashing the hosts (`PrefixTable.fromHostsChunked`: SHA-256 prefixes, in `setTimeout(0)`
    // chunks) on the chrome's main thread, the thread the trace reads. The sweep's window opens
    // about 20 s after the launch and runs as long as the fetches and the hashing take (tens of
    // seconds on the recipe's network), which is where most demos' scenes are:
    // a scene measured then carries long tasks that are the sweep's, not the motion's, and the
    // trace half of the budget (`longTasks`) reads over for work the user did not ask for. This
    // instrument does not distinguish them; it says so in the findings ([sweepNote]: a line
    // under the scene's table naming the time since the launch when the scene began inside the
    // window) so a reader of a soft row knows what else was on the thread. THE HARD GATE NEEDS
    // THE SWEEP HELD during a demo: the proposal is an instrumentation argument the driver script
    // passes through (`-e holdStartupSweep true`), read by the host into the seeded profile or a
    // debug-build system property the core reads at start, that defers the two services' startup
    // sweeps (the 30-minute interval sweeps too) for the session; the bundled snapshot still
    // answers navigations, so the Safe Browsing scenes keep their evidence. Not built here: the
    // flag is the services program's (relayed through the coordinator).
    //
    // One line of `frames.jsonl` (schema `v` 2; keys in this order; ms are HWUI's whole ms for the
    // percentiles, decimals for the stages and the trace):
    //   {"v":2,"scene":"bar-hide-scroll-bottom","kind":"gesture","gate":"soft",
    //    "at":"2026-09-20T21:00:00Z","durationMs":2400,"baseline":"bar-hide-scroll-setting-off",
    //    "frames":5,"janky":5,"jankyShare":1,"jankyLegacy":5,"p50":250,"p90":700,"p95":700,"p99":700,
    //    "reasons":{"Missed Vsync":3,"High input latency":0,"Slow UI thread":1,"Slow bitmap uploads":0,
    //               "Slow issue draw commands":4,"Frame deadline missed":5,"Frame deadline missed (legacy)":5},
    //    "sampled":5,"skipped":1,"long":5,
    //    "stageMs":{"delay":{"mean":1.2,"max":9.8,"long":0},"input":{...},"animation":{...},"layout":{...},
    //               "draw":{...},"sync":{...},"commands":{...},"swap":{...},"gpu":{...}},
    //    "dominant":"sync",
    //    "ratio":{"p95":1.17,"sharePoints":0},
    //    "trace":{"found":true,"thread":"5656:5692","frames":12,"mainThreadMs":{"mean":8.1,"max":41.2,"p95":30.5},
    //             "busyMs":512.3,"busyPerFrameMs":42.7,"scriptMs":120.1,"layoutCount":11,"paintCount":10,
    //             "styleRecalcCount":12,"layerChurn":38,"longTasks":1,"longestTaskMs":72.4,
    //             "perFrame":{"layout":0.917,"paint":0.833,"styleRecalc":1,"layerChurn":3.167},
    //             "events":8123,"threads":31,"windowMs":2410.5,"whole":false},
    //    "traceMissing":null,
    //    "budget":{"p95Ratio":2,"sharePoints":0.1,"layoutsPerFrame":2,"paintsPerFrame":2,"mainThreadP95Ms":120,
    //              "longTasks":3,"provisional":true},
    //    "gated":["ratio","trace"],"verdict":"within","breaches":[],"notes":[],"enforced":false}
    // `frames`, `janky` and the percentiles are the summary's (every frame since the reset);
    // `sampled`, `skipped`, `long`, `stageMs` and `dominant` are read off the CSV's last frames
    // (about 120); `jankyLegacy` is -1 before Android 12; `dominant` is null with no long frame.
    // `ratio` is null without a baseline (or one the run did not measure); `trace` is null when
    // the scene took no trace, `traceMissing` says why when it asked for one. In `trace`, the
    // counts (`layoutCount`, `paintCount`, `styleRecalcCount`, `layerChurn`, `longTasks`) are PER
    // SCENE, `perFrame` divides them by the main-thread frames (`ProxyMain::BeginMainFrame`), and
    // `mainThreadMs` is PER FRAME: mean, max and 95th percentile of the frames' main-thread time;
    // `busyMs` and `scriptMs` are the scene's totals. `gated` lists the halves of the budget that
    // applied (`ratio`, `trace`; empty = reported only), `verdict` is `within` or `over`, `breaches`
    // names what was over, `notes` what did not apply, `enforced` says the gate made it a fault.

    /**
     * The gate this run measures under: the `jankGate` instrumentation argument (`soft` or
     * `hard`), soft when absent or unreadable. The driver script passes `JANK_GATE` through.
     */
    protected val jankGate: JankBudget.Gate =
        JankBudget.Gate.parse(InstrumentationRegistry.getArguments().getString(JANK_GATE_ARGUMENT))

    /**
     * Whether this run holds the core's startup sweeps – the filter lists' and the Safe Browsing
     * feeds' refreshes, 20 s and 35 s after boot, whose downloads and file writes would land in
     * the measured scenes – until the sequence is over: the `holdBackgroundWork` instrumentation
     * argument (`DEMO_ARGS="-e holdBackgroundWork true"`), off when absent. [launch] puts the
     * extra on the intent and [runDemo] releases the hold after the frames are settled.
     */
    protected val holdBackgroundWork: Boolean =
        InstrumentationRegistry.getArguments().getString(HOLD_BACKGROUND_WORK_ARGUMENT) == "true"

    /** End the hold on the core's startup sweeps ([Host.releaseBackgroundWork]); nothing without one. */
    protected fun releaseBackgroundWork() {
        if (!holdBackgroundWork) return
        instrumentation.runOnMainSync { (activity as? MainActivity)?.host?.releaseBackgroundWork() }
        Log.i(tag, "background work released")
    }

    /**
     * Every scene measured so far, in order, with the verdicts as they stand (settled at the end
     * of the run); for a driver that wants to write them down itself. (Named for the frames:
     * `scenes` alone is a driver's own word for which of ITS scenes run, ChromeA11yDemo's `scenes`
     * argument among them.)
     */
    protected val frameScenes: List<FrameStats.Scene> get() = measuredScenes
    private val measuredScenes = ArrayList<FrameStats.Scene>()

    /** The scenes over budget under a hard gate, each with its table; [runDemo] fails on them at the end. */
    private val jankFaults = ArrayList<String>()

    /**
     * Measure the frames of one scene: reset HWUI's statistics for the app, run `block` – the
     * scene's gesture by real touch, with whatever wait the scene's motion needs to land (a
     * release's spring is frames too; a block that lifts the finger and returns at once measures
     * the drag alone) – and read the statistics after it. `scene` names the scene in the record
     * (`<what>-<where>`, stable across runs, since the summary and the release table key on it);
     * `kind` picks the budget ([JankBudget.Kind]: a finger-driven `GESTURE`, the default; a
     * release's `SPRING`; a surface's `OPEN`); `baseline` names the same-run scene the ratios are
     * read against (measured before or after this one: the verdict settles at the end of the
     * run); `trace` records the chrome WebView's Chromium trace around the block and reads the
     * renderer main thread's work out of it ([traceFrames] is this with `trace = true`). The
     * [FrameStats.Scene] is written down (one line of `frames.jsonl`, its table in `frames.txt`
     * and the log) and returned for the driver's own claims; under a hard gate a scene over its
     * budget is a jank fault. A block that throws measures nothing: the exception is the driver's.
     *
     * Nothing else should run in the block: a screenshot ([shot]) or a read of the chrome
     * ([chromeJs]) inside it is work the app did not do for the user and shows in the frames.
     * Take the still before or after, and read the chrome's value after.
     */
    protected fun measureFrames(
        scene: String,
        kind: JankBudget.Kind = JankBudget.Kind.GESTURE,
        baseline: String? = null,
        trace: Boolean = false,
        block: () -> Unit
    ): FrameStats.Scene {
        val pkg = app.packageName
        var tracing: String? = null
        if (trace) {
            tracing = startTrace()
            // The renderer picks the configuration up a moment after the controller says it is on.
            if (tracing == null) SystemClock.sleep(TRACE_WARM_UP_MS)
        }
        shellCommand("dumpsys gfxinfo $pkg reset")
        val startedAt = System.currentTimeMillis()
        val t0 = SystemClock.uptimeMillis()
        val fromUs = System.nanoTime() / 1_000
        block()
        val toUs = System.nanoTime() / 1_000
        val durationMs = SystemClock.uptimeMillis() - t0
        var text = shellCommand("dumpsys gfxinfo $pkg framestats")
        // The dump is served on the app's main thread with a deadline; a main thread still busy
        // with the scene's last frames misses it ("Failure while dumping the app", no frames),
        // and the statistics since the reset are still there for a second ask.
        for (attempt in 1..3) {
            if (!text.contains("Failure while dumping")) break
            Log.w(tag, "scene $scene: gfxinfo dump attempt $attempt failed (the app did not answer in time); asking again")
            SystemClock.sleep(1_000)
            text = shellCommand("dumpsys gfxinfo $pkg framestats")
        }
        var reading: BlinkTrace.Reading? = null
        if (trace && tracing == null) {
            val file = File(out, "trace-$scene.json.gz")
            tracing = stopTrace(file)
            if (tracing == null) {
                try {
                    reading = BlinkTrace.parse({ GZIPInputStream(FileInputStream(file)).bufferedReader() }, BlinkTrace.Window(fromUs, toUs))
                    if (reading.whole) Log.w(tag, "scene $scene: the trace's window ${fromUs}..${toUs} µs held no main-thread event; the whole trace was read")
                } catch (e: Exception) {
                    tracing = "the trace could not be read: ${e.javaClass.simpleName} ${e.message}"
                    Log.e(tag, "scene $scene: $tracing", e)
                }
            }
        }
        val dump = FrameStats.parse(text)
        if (dump.summary == null) Log.w(tag, "no HWUI summary for $pkg in the dump of scene $scene (${text.length} chars)")
        val result = FrameStats.scene(
            scene, kind, jankGate, startedAt, durationMs, dump,
            baseline = baseline, trace = reading, traceMissing = if (trace) tracing else null, measured = measuredScenes
        )
        measuredScenes += result
        val note = sweepNote(scene, t0 - appLaunchedAt, durationMs, reading)
        File(out, FRAMES_RECORD).appendText(result.toJson() + "\n")
        File(out, FRAMES_TABLES).appendText(result.table() + (note?.let { "\n$it" } ?: "") + "\n\n")
        // The raw dump beside the reading, for a second opinion (the parser is fed such a dump on the JVM).
        File(out, "framestats-$scene.txt").writeText(text)
        for (line in result.table().lines()) Log.i(tag, "FRAMES $line")
        note?.let { Log.w(tag, "FRAMES $it") }
        return result
    }

    /**
     * The startup-sweep caveat for one scene's findings (see the instruments' note above), or
     * null when it does not apply: the scene began `sinceLaunchMs` after [launch] and lasted
     * `durationMs`; when that window overlaps the sweep's – from [STARTUP_SWEEP_DELAY_MS] after
     * the launch for [STARTUP_SWEEP_ALLOWANCE_MS] – and the trace counted long tasks, the line
     * says how long after the launch the scene began, so the long tasks are read with the sweep
     * in mind. A scene without a trace has no long-task count to caveat.
     */
    private fun sweepNote(scene: String, sinceLaunchMs: Long, durationMs: Long, trace: BlinkTrace.Reading?): String? {
        if (trace == null || trace.longTasks == 0) return null
        val sweepFrom = STARTUP_SWEEP_DELAY_MS
        val sweepTo = STARTUP_SWEEP_DELAY_MS + STARTUP_SWEEP_ALLOWANCE_MS
        if (sinceLaunchMs + durationMs < sweepFrom || sinceLaunchMs > sweepTo) return null
        return "note: scene $scene began %.1f s after the launch, inside the window of the core's Safe Browsing / blocking startup sweep (from %d s; feeds fetched and hashed in main-thread chunks); its %d long task(s) may be the sweep's, not the motion's – the hard gate needs the sweep held during demos".format(
            sinceLaunchMs / 1000.0, sweepFrom / 1000, trace.longTasks
        )
    }

    /**
     * [measureFrames] with the chrome WebView's Chromium trace around the block: the renderer main
     * thread's layouts, paints and style recalculations per frame, its time per frame and its long
     * tasks go into the record's `trace` ([BlinkTrace]), and the trace itself into the findings as
     * `trace-<scene>.json.gz` (Trace Event JSON, gzipped: what `chrome://tracing`, Perfetto's UI and
     * PERF-1's / PERF-2's readers open). Tracing costs the renderer a little on every frame, so a
     * traced scene's HWUI numbers are read against traced baselines. A driver that traces the whole
     * run itself (its `TracingController` already on) gets no second trace here: the scene is
     * measured without one, the record says why, and the driver cuts its own trace per scene with
     * `BlinkTrace.parse(open, BlinkTrace.Window(fromUs, toUs))` – `System.nanoTime() / 1000` at the
     * block's bounds is the trace's clock.
     */
    protected fun traceFrames(
        scene: String,
        kind: JankBudget.Kind = JankBudget.Kind.GESTURE,
        baseline: String? = null,
        block: () -> Unit
    ): FrameStats.Scene = measureFrames(scene, kind, baseline, trace = true, block)

    /**
     * A measured scene out of the record: the driver found the measurement spoiled by something
     * that was not the scene (a tab an extension opened over the page mid-scroll, a dialog, a
     * dump that came back empty) and measures the scene again under its name. `frames.jsonl`
     * and `frames.txt` are rewritten without it; `why` goes to the log. The raw dump stays in
     * `framestats-<scene>.txt` until the second measurement overwrites it.
     */
    protected fun discardScene(scene: FrameStats.Scene, why: String) {
        val at = measuredScenes.indexOfFirst { it === scene }
        if (at < 0) return
        measuredScenes.removeAt(at)
        Log.w(tag, "scene ${scene.name} discarded (${scene.summary?.frames ?: 0} frames): $why")
        File(out, FRAMES_RECORD).writeText(measuredScenes.joinToString("") { it.toJson() + "\n" })
        File(out, FRAMES_TABLES).writeText(measuredScenes.joinToString("") { it.table() + "\n\n" })
    }

    private val traceWriter = Executors.newSingleThreadExecutor()

    /** Start the WebViews' Chromium trace ([BlinkTrace.CATEGORIES]); null when on, else why not. */
    private fun startTrace(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "WebView tracing needs Android 9 (API ${Build.VERSION.SDK_INT})"
        var problem: String? = null
        instrumentation.runOnMainSync {
            val controller = TracingController.getInstance()
            if (controller.isTracing) {
                problem = "WebView tracing was already on (a driver tracing the whole run reads its scenes with BlinkTrace.parse)"
                return@runOnMainSync
            }
            controller.start(
                TracingConfig.Builder()
                    .addCategories(*BlinkTrace.CATEGORIES.toTypedArray())
                    .setTracingMode(TracingConfig.RECORD_CONTINUOUSLY)
                    .build()
            )
            if (!controller.isTracing) problem = "WebView tracing did not start"
        }
        problem?.let { Log.w(tag, it) }
        return problem
    }

    /**
     * Stop the trace and write it, gzipped, to `file`; waits for Chromium to close the stream (the
     * write is asynchronous). Null when written, else why not.
     */
    private fun stopTrace(file: File): String? {
        val closed = CountDownLatch(1)
        val stream: OutputStream = object : GZIPOutputStream(FileOutputStream(file), 1 shl 16) {
            override fun close() {
                try {
                    super.close()
                } finally {
                    closed.countDown()
                }
            }
        }
        var stopped = false
        instrumentation.runOnMainSync {
            val controller = TracingController.getInstance()
            stopped = controller.isTracing && controller.stop(stream, traceWriter)
        }
        if (!stopped) {
            stream.close()
            return "WebView tracing was not on at the end of the scene"
        }
        if (!closed.await(TRACE_WRITE_TIMEOUT_S, TimeUnit.SECONDS)) return "the trace was still being written after $TRACE_WRITE_TIMEOUT_S s"
        Log.i(tag, "trace ${file.name}: ${file.length()} bytes")
        return null
    }

    /**
     * The frames record settled with every scene known: the verdicts read again (a baseline
     * measured after the scene that names it counts now), `frames.jsonl` and `frames.txt`
     * rewritten, and the scenes over budget under a hard gate made jank faults. Once, at the
     * end of the run ([runDemo]).
     */
    private fun settleFrames() {
        if (measuredScenes.isEmpty()) return
        val settled = FrameStats.resolve(measuredScenes)
        val before = ArrayList(measuredScenes)
        measuredScenes.clear()
        measuredScenes += settled
        File(out, FRAMES_RECORD).writeText(settled.joinToString("") { it.toJson() + "\n" })
        File(out, FRAMES_TABLES).writeText(settled.joinToString("\n\n") { it.table() } + "\n")
        for ((i, scene) in settled.withIndex()) {
            if (scene.verdict != before[i].verdict || scene.ratio != before[i].ratio) {
                for (line in scene.table().lines()) Log.i(tag, "FRAMES (settled) $line")
            }
            if (scene.enforced) {
                Log.e(tag, "JANK FAULT: scene ${scene.name} is over its budget under a hard gate")
                jankFaults += scene.table()
            }
        }
    }

    /** Run a shell command with the instrumentation's shell permissions; its whole output. */
    protected fun shellCommand(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(command)).use { it.bufferedReader().readText() }

    // --- the chrome's bridge ---------------------------------------------------------------------

    /** Evaluate in the chrome WebView; the raw JSON-encoded result ("" when it never answered). */
    protected fun chromeJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val chrome = (activity as? MainActivity)?.host?.chrome
            if (chrome == null) {
                latch.countDown()
            } else {
                chrome.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /**
     * Put the chrome's toasts on record: a MutationObserver in the chrome notes the text of every
     * toast card (`ToastCard`'s `.zen-message-toast`) into `window.__demoToasts` as it appears,
     * so [toastSeen] answers for a toast that lived shorter than a poll or left before the tree
     * listed it. A plain toast lives 2.8 s (`TOAST_DURATION`), and on the emulator's software GPU
     * the accessibility tree trails the screen by more than that, so a toast the recording shows
     * can be gone before the tree ever lists it (the QR demo's first-refusal toast, second run).
     * Call it before the step whose toast is checked; each call clears the record. The tree
     * stays the way to TOUCH a toast's action.
     */
    protected fun watchToasts() {
        chromeJs(
            "(function(){window.__demoToasts=[];if(window.__demoToastWatch)return;" +
                "var note=function(){document.querySelectorAll('.zen-message-toast .zen-message-text')" +
                ".forEach(function(e){var t=e.textContent.trim();" +
                "if(window.__demoToasts.indexOf(t)<0)window.__demoToasts.push(t)})};" +
                "window.__demoToastWatch=new MutationObserver(note);" +
                "window.__demoToastWatch.observe(document.body,{childList:true,subtree:true,characterData:true});" +
                "note()})()"
        )
    }

    /** Whether a toast reading `text` is up now or has been on record since [watchToasts]. */
    protected fun toastSeen(text: String): Boolean =
        chromeJs(
            "(function(){var t=${JSONObject.quote(text)};" +
                "if(window.__demoToasts&&window.__demoToasts.indexOf(t)>=0)return true;" +
                "return Array.prototype.some.call(" +
                "document.querySelectorAll('.zen-message-toast .zen-message-text')," +
                "function(e){return e.textContent.trim()===t})})()"
        ) == "true"

    /**
     * Poll [toastSeen] for `text` up to `timeoutMs`; false when no such toast came. (Named for the
     * record it reads: `TabCloseDemo` has an `awaitToast` of its own that reads the live DOM.)
     */
    protected fun awaitToastSeen(text: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (toastSeen(text)) return true
            SystemClock.sleep(150)
        }
        return toastSeen(text)
    }

    /** Run a core command through `window.zen.invoke` and wait for its promise; the result as JSON text. */
    protected fun coreInvoke(name: String, args: String = "null"): String {
        chromeJs(
            "window.__demo=undefined;window.zen.invoke(${JSONObject.quote(name)},$args)" +
                ".then(r=>{window.__demo=JSON.stringify(r===undefined?null:r)},e=>{window.__demo='ERR:'+(e&&e.message||e)})"
        )
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chromeJs("window.__demo===undefined?'':window.__demo")
            // "" is a chrome that did not answer the poll (its renderer busy or blocked): not an answer yet.
            if (raw.isEmpty()) {
                SystemClock.sleep(100)
                continue
            }
            val value = (JSONTokener(raw).nextValue() as? String).orEmpty()
            if (value.startsWith("ERR:")) error("$name failed: ${value.removePrefix("ERR:")}")
            if (value.isNotEmpty()) return value
            SystemClock.sleep(100)
        }
        error("$name timed out")
    }

    /** The core's UI state (`app.getState`): tabs, spaces, settings, window. */
    protected fun coreState(): JSONObject = JSONObject(coreInvoke("app.getState"))

    /** The active tab of the active space per the core, null when there is none. */
    protected fun activeCoreTab(state: JSONObject = coreState()): JSONObject? {
        val spaces = state.getJSONArray("spaces")
        val activeSpace = state.getString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") != activeSpace) continue
            val tabId = space.optString("activeTabId", "")
            return state.getJSONObject("tabs").optJSONObject(tabId)
        }
        return null
    }

    /**
     * Two fingers on a horizontal line through (`cx`, `cy`), `fromSpan` px apart, moving to
     * `toSpan` apart over `durationMs` in real time: a pinch out when the span grows, in when it
     * shrinks. Injected as one multi-pointer gesture, so the page sees a genuine two-touch
     * sequence (touchstart with two touches, touchmove, the fingers lifting one after the other).
     */
    protected fun pinch(cx: Float, cy: Float, fromSpan: Float, toSpan: Float, durationMs: Long) {
        val downTime = SystemClock.uptimeMillis()
        fun inject(action: Int, count: Int, span: Float) {
            val half = span / 2
            val properties = Array(count) { i ->
                MotionEvent.PointerProperties().apply {
                    id = i
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
            }
            val coords = Array(count) { i ->
                MotionEvent.PointerCoords().apply {
                    x = if (i == 0) cx - half else cx + half
                    y = cy
                    pressure = 1f
                    size = 1f
                }
            }
            val event = MotionEvent.obtain(
                downTime, SystemClock.uptimeMillis(), action, count, properties, coords,
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0
            )
            try {
                ui.injectInputEvent(event, false)
            } finally {
                event.recycle()
            }
        }
        val second = 1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT
        inject(MotionEvent.ACTION_DOWN, 1, fromSpan)
        SystemClock.sleep(30)
        inject(MotionEvent.ACTION_POINTER_DOWN or second, 2, fromSpan)
        val steps = max(1L, durationMs / STEP_MS)
        val start = SystemClock.uptimeMillis()
        for (i in 1..steps) {
            val due = start + (durationMs * i) / steps
            val now = SystemClock.uptimeMillis()
            if (due > now) SystemClock.sleep(due - now)
            inject(MotionEvent.ACTION_MOVE, 2, fromSpan + (toSpan - fromSpan) * i / steps)
        }
        SystemClock.sleep(40)
        inject(MotionEvent.ACTION_POINTER_UP or second, 2, toSpan)
        SystemClock.sleep(20)
        inject(MotionEvent.ACTION_UP, 1, toSpan)
    }

    /**
     * One finger. Moves are interpolated and injected in real time (asynchronously, with their own
     * timestamps), so the velocity the chrome measures is the one asked for even when the WebView
     * is busy painting.
     */
    protected inner class Finger {
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

        /** The system takes the touch away (a palm, a notification shade): the WebView sees a pointercancel. */
        fun cancel() = inject(MotionEvent.ACTION_CANCEL, SystemClock.uptimeMillis())

        fun tap(x: Float, y: Float) {
            down(x, y)
            hold(60)
            up()
        }

        /** Press and hold long enough for the chrome's long press (380 ms) to fire, finger still down. */
        fun press(x: Float, y: Float) {
            down(x, y)
            hold(LONG_PRESS_WAIT)
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
        /** The pill's label carries the address after a comma (`Address, example.com`). */
        const val PILL_LABEL = "Address"
        /** The bar's three-dot button, and the grabber of the menu sheet it opens. */
        const val MENU_LABEL = "Menu"
        const val MENU_HANDLE_LABEL = "Resize menu"
        /** The instrumentation argument the gate is read from (`-e jankGate hard`). */
        const val JANK_GATE_ARGUMENT = "jankGate"
        /**
         * The instrumentation argument that holds the core's startup sweeps for the run
         * (`-e holdBackgroundWork true`): the launch intent carries [BackgroundWorkHold.EXTRA_HOLD],
         * and [releaseBackgroundWork] ends the hold once the sequence is over.
         */
        const val HOLD_BACKGROUND_WORK_ARGUMENT = "holdBackgroundWork"
        /** The frames record in the run's findings: one JSON line per measured scene, and the tables. */
        const val FRAMES_RECORD = "frames.jsonl"
        const val FRAMES_TABLES = "frames.txt"
        /** After `TracingController.start`, before the scene: the renderer's time to take the configuration up. */
        private const val TRACE_WARM_UP_MS = 600L
        /** How long the trace's asynchronous write may take before the scene goes on without it. */
        private const val TRACE_WRITE_TIMEOUT_S = 120L
        /**
         * The core's `STARTUP_SWEEP_DELAY_MS` (`src/core/safebrowsing/service.ts`, `src/core/blocking/service.ts`):
         * how long after the services are ready their startup sweep of the feeds begins (see the
         * instruments' startup-sweep note), counted here from [launch].
         */
        private const val STARTUP_SWEEP_DELAY_MS = 20_000L
        /**
         * How long after it begins the sweep is assumed to be able to run – the fetches and the
         * main-thread hashing of every feed, one after another, on the recipe's network. A guess
         * made wide on purpose: the caveat is a note, not a verdict, and a scene it does not
         * apply to costs a line.
         */
        private const val STARTUP_SWEEP_ALLOWANCE_MS = 90_000L
        private const val STEP_MS = 8L
        /** Two reads of a node's bounds this far apart agreeing count as settled ([steadyBounds]). */
        private const val BOUNDS_SETTLE_MS = 350L
        /**
         * How long SystemUI keeps the clipboard overlay up after a copy (`ClipboardOverlayController`'s
         * six seconds), with a margin for its exit animation.
         */
        private const val CLIPBOARD_OVERLAY_MS = 7_000L
        /** The 3-button navigation bar's window, in dp, whatever inset it reports (see [touchable]). */
        private const val NAV_BAR_WINDOW_DP = 48
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        const val NUDGE = 30f
        const val STAGE_WAIT = 2_400L
        /** The chrome lifts a held card after 380 ms; the emulator's main thread may lag behind. */
        const val LONG_PRESS_WAIT = 900L
    }
}
