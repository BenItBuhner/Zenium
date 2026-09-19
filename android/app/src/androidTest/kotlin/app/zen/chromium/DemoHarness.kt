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
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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
 *  - screenshots land next to them as `<shotPrefix>-<name>.png`.
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
        }
        // Tell the recorder to stop while the app is still on screen: the instrumentation's exit
        // kills the process, and the launcher must not be the last frame.
        File(out, "done").writeText("done\n")
        SystemClock.sleep(4_000)
        Log.i(tag, "done")
        if (touchFaults.isNotEmpty()) {
            throw AssertionError("${touchFaults.size} touch(es) did not take: ${touchFaults.joinToString("; ")}")
        }
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
     */
    protected fun findInWindows(matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val accept = labelled(matches)
        for (window in ui.windows) {
            val root = window.root ?: continue
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

    /**
     * Close the urlbar when it is open (the first run ends in it, with the keyboard up, hiding the
     * page, the bar and the menu button). Back takes the keyboard first, then the field; the bar's
     * address pill coming back is the sign it is gone.
     */
    protected fun closeUrlbar() {
        repeat(3) {
            if (findByLabelPrefix(PILL_LABEL) != null) return
            back()
            SystemClock.sleep(1_200)
        }
        if (findByLabelPrefix(PILL_LABEL) == null) Log.w(tag, "the urlbar stayed open")
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
        private const val STEP_MS = 8L
        /** Two reads of a node's bounds this far apart agreeing count as settled ([steadyBounds]). */
        private const val BOUNDS_SETTLE_MS = 350L
        /** The 3-button navigation bar's window, in dp, whatever inset it reports (see [touchable]). */
        private const val NAV_BAR_WINDOW_DP = 48
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        const val NUDGE = 30f
        const val STAGE_WAIT = 2_400L
        /** The chrome lifts a held card after 380 ms; the emulator's main thread may lag behind. */
        const val LONG_PRESS_WAIT = 900L
    }
}
