package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.TracingConfig
import android.webkit.TracingController
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.Collections
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
     * inside them; the band is the larger of the `navigationBars` and `tappableElement` insets,
     * the numbers the chrome lays itself out with. (Until the recipe enabled the three-button
     * overlay EXCLUSIVELY, the gestural overlay stayed on beside it and SystemUI reported the
     * gestural bar's insets – 24 dp, tappable 0 – under a 48 dp button window, so a sheet's
     * bottom row ran under the buttons and this band was held to 48 dp by hand. The recipe now
     * gives a 48 dp bar with a 48 dp inset, so the insets alone say where the app ends.)
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
        // The chrome is a WebView booting the browser core: wait for the address pill to show up
        // (by either of its names: a state whose active tab is the new tab page has no address).
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (pillNode() == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        SystemClock.sleep(4_000)
    }

    /**
     * A system dialog (an ANR of some other app, say) on top of the browser would take the
     * touches: a back sends it away. The home screen in front is the browser's task put behind
     * it (the omnibox polish run's dark act: a home key – the window manager's `Close system
     * dialogs` and the launcher's start from uid 0 together are its path – a moment after the
     * warm-up's first pill tap, while the activity was relaunching under a colour scheme switch
     * and the window's height flickered a nav bar's 24 dp: the tap's likeliest landing was the
     * home button), and no back brings a task back: the browser's own activity is started again
     * through the shell instead – `singleTask`, so the running task comes to the front as it is,
     * nothing re-created – as it is for anything a back did not clear. Said in the log either way.
     */
    protected fun ensureForeground() {
        repeat(5) { attempt ->
            val top = ui.rootInActiveWindow?.packageName?.toString()
            if (top == null || top == app.packageName) return
            if (attempt > 0 || top == homePackage) {
                Log.w(tag, "window of $top is in front; bringing the browser's task back")
                shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
                SystemClock.sleep(2_500)
            } else {
                Log.w(tag, "window of $top is in front; sending back")
                ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                SystemClock.sleep(1_000)
            }
        }
    }

    /**
     * Where a finger tapping the address pill goes: the tree's pill when its centre is in the
     * window's touchable band, the measured [pill] when the tree has it in a system bar (a stale
     * tree mid-relaunch put the omnibox polish run's dark warm-up tap on the home button and the
     * browser's task behind the launcher; [ensureForeground] tells the rest). A finger never goes
     * where the system takes the touch. Shared: every driver that taps the pill by its label is
     * open to the same stale tree.
     */
    protected fun pillPoint(): PointF {
        ensureForeground()
        val found = pillRect()
        val target = when {
            found == null -> pill
            touchable.contains(found.centerX(), found.centerY()) -> found
            else -> {
                Log.w(tag, "the tree's pill $found is outside the touchable band $touchable; the measured pill $pill instead")
                pill
            }
        }
        return PointF(target.exactCenterX(), target.exactCenterY())
    }

    /** The device's home screen (the launcher), by the system's own answer; null when it has none. */
    private val homePackage: String? by lazy {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        runCatching { app.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName }.getOrNull()
    }

    private fun measure() {
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        val found = pillRect()?.takeIf { it.top > height * 0.6 && it.width() > 100 * density }
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

    /** [touchable] from the window's insets: the bottom band is the larger of the bar's and the tappable inset (see the field). */
    protected fun touchableBand(insets: Insets): Rect {
        val bottomBand = max(insets.bottom, insets.tappableBottom)
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

    /** [findByLabel] for the first node whose label or text satisfies `matches` (a [groupCard], a [tabCard]). */
    protected fun findByLabel(matches: (String) -> Boolean): Rect? =
        findNode(matches)?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun findNode(label: String): AccessibilityNodeInfo? = findNode { it == label }

    /**
     * The phone bar's pill – the address, its one TalkBack stop since #237 – by EITHER of its
     * names: on a page `Address, <host>[, <state>…]` (`phoneAddressLabel`, pillLabel.ts), on the
     * new tab page the empty field's own words, `Search or enter address` (#51: the NTP's pill
     * carries no address, pillLabel.ts:33), and `Private tab locked, unlock` under the private
     * lock cover (PhoneShell.tsx). The NTP's body draws a field of its own with the same words
     * (the fakebox, NewTabPage.tsx: a button inside the page's "Search" group) and the open URL
     * field's input reads them too (Urlbar.tsx: editable), so the empty name alone is no pill:
     * the pill is the clickable button outside that group, and with more than one left, the one
     * in the BAR's row – the row of a bar button (Menu, the Tabs count: found afresh, the bar may
     * sit at either edge), else of the measured [pill], else the lowest (the bar's default edge).
     * Shared: `navbar`'s nightly run lost the pill for good at its first NTP, every `Address,`
     * read null from there on (six checks, one cascade); a driver that reads the pill goes
     * through here, [pillRect] for its bounds.
     */
    protected fun pillNode(): AccessibilityNodeInfo? {
        findNode { it.startsWith("$PILL_LABEL,") || it == LOCKED_PILL_LABEL }?.let { return it }
        val empty = labelled { it == NTP_PILL_LABEL }
        val inSearchGroup = labelled { it == NTP_FIELD_GROUP_LABEL }
        val candidates = findNodesWhere { node ->
            node.isClickable && node.className?.toString()?.endsWith("EditText") != true && empty(node) &&
                generateSequence(node.parent) { it.parent }.take(4).none(inSearchGroup)
        }.map { node -> node to Rect().also { node.getBoundsInScreen(it) } }.filter { !it.second.isEmpty }
        if (candidates.isEmpty()) return null
        if (candidates.size == 1) return candidates.single().first
        val row = barRow() ?: pillOrNull()
        val inRow = row?.let { r -> candidates.firstOrNull { it.second.top < r.bottom && it.second.bottom > r.top } }
        return (inRow ?: candidates.maxBy { it.second.centerY() }).first
    }

    /** [pillNode]'s bounds on screen; null while the tree lists no pill. */
    protected fun pillRect(): Rect? = pillNode()?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /**
     * The pill's box as the chrome lays it out ([domBox] of the bar's `.zen-phone-pill`, the
     * ghost a carry draws excluded), else the tree's ([pillRect]). The document is read first
     * because the tree trails a bar that has just moved: `navbar`'s carry to the top read the
     * pill's bottom-edge bounds for seconds after the bar had docked at the top (the nightly's
     * proof run, 'the bar docked at the top' called a miss with the bar there on the recording).
     * Null with no bar up (the URL field over it) by either reading.
     */
    protected fun pillBounds(): Rect? = domBox(PILL_JS)?.takeIf { !it.isEmpty } ?: pillRect()

    /**
     * The edge the bar is docked at by the document: `.zen-phone-bar[data-edge]`
     * (PhoneShell.tsx, the `phoneBarPosition` setting's word), "top" or "bottom"; null with no
     * bar in the document or no answer from the chrome.
     */
    protected fun barEdge(): String? =
        chromeJsString("(function(){var b=document.querySelector('.zen-phone-bar');return b?String(b.dataset.edge||''):''})()")
            ?.takeIf { it.isNotEmpty() }

    /**
     * The bar's Tabs button, "Tabs (N)" (PhoneShell.tsx: the count is the space's), by the
     * leading part of its name and never the count, which changes under a driver as its tabs
     * come and go (`layout` read "Tabs (8)" whole and found none at its warm-up, the eighth tab
     * still on its way): the tree's node within `timeoutMs`, else the document's box
     * (`[aria-label^="Tabs ("]`), which the tree can trail by seconds after a bar's move. Null
     * with no bar up by either reading.
     */
    protected fun tabsButton(timeoutMs: Long = 4_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            findByLabelPrefix(TABS_LABEL_PREFIX)?.takeIf { !it.isEmpty }?.let { return it }
            domBox("document.querySelector('.zen-phone-bar [aria-label^=\"$TABS_LABEL_PREFIX\"]')")?.takeIf { !it.isEmpty }?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(200)
        }
    }

    /** The measured [pill] once [measure] has run, null before (a launch's first look). */
    private fun pillOrNull(): Rect? = if (this::pill.isInitialized && !pill.isEmpty) pill else null

    /** The bar's row as one of its always-present buttons reports it, wherever the bar is docked. */
    private fun barRow(): Rect? =
        findNodeWhere { node ->
            node.isClickable && labelled { it == MENU_LABEL || it.startsWith(TABS_LABEL_PREFIX) }(node)
        }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }?.takeIf { !it.isEmpty }

    /**
     * A card of the overview's grid by the leading part of the accessible name the chrome gives
     * it since #237 (overviewLabels.ts) and never by the rest, which moves: a group's card is
     * "NAME, tab group, N tabs" (`groupCardLabel`; the count changes as tabs join and leave the
     * group), a tab's "TITLE, tab N of M[, current][, sleeping]" (`tabCardLabel`; its place, the
     * count and its state change with every card around it). A driver that read the whole name
     * broke the first time it changed under it: three drivers read "Group Research" and every
     * card by its bare title, the names before #237, until #315's run 35711026068 and #327's
     * found none. [groupCard] and [tabCard] make one; it is the predicate for the accessibility
     * tree ([findByLabel], [reveal], [waitFor] and [waitForGone] take it where they take a
     * label) and [selector] the same match for a driver that reads the grid's DOM. The card's
     * close button, "Close TITLE" since the same change, is [closeButtonOf] its cell.
     */
    class Card internal constructor(private val name: String, private val heads: List<String>) : (String) -> Boolean {
        /** Whether an accessible name – the tree's, or a DOM `aria-label` – is this card's. */
        override fun invoke(label: String): Boolean = heads.any(label::startsWith)

        /** The card in the grid's DOM, for a driver that reads it with `document.querySelector`. */
        val selector: String = heads.joinToString(", ") { "[aria-label^=\"$it\"]" }

        override fun toString(): String = name
    }

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
            val row = pillRect() ?: pill
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
     * The text field named `label`: the WebView reports an input's accessible name (its
     * `aria-label`, else its placeholder) as the EditText's hint and its value as the text, so
     * [findByLabel] and [findNode], which read the description and the text, never see a field's
     * name (the history / bookmarks driver's search field found this first). The editable node
     * whose hint, text or description carries `label`; null without one.
     */
    protected fun findField(label: String): AccessibilityNodeInfo? = findNodeWhere { node ->
        node.isEditable &&
            listOfNotNull(node.hintText, node.text, node.contentDescription).any { it.toString().contains(label) }
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

    /** [reveal] for the first node whose label or text satisfies `matches` (a [groupCard], a [tabCard]). */
    protected fun reveal(matches: (String) -> Boolean): Rect? {
        val node = findNode(matches) ?: return null
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findByLabel(matches)
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

    /** [waitFor] for the first node whose label or text satisfies `matches` (a [groupCard], a [tabCard]). */
    protected fun waitFor(matches: (String) -> Boolean, timeoutMs: Long = 5_000): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findByLabel(matches)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    /** [waitForGone] for every node whose label or text satisfies `matches` (a [groupCard], a [tabCard]). */
    protected fun waitForGone(matches: (String) -> Boolean, timeoutMs: Long = 5_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(matches) == null) return true
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
     * and nothing injected, when the node has gone or no part of it is inside [touchable] (one
     * under the navigation bar) or inside what its list shows ([scrollClip]: a row below the
     * list's fold): the caller says so rather than touching a corner.
     */
    protected fun touchTap(node: AccessibilityNodeInfo): Boolean = touchTapPoint(node) != null

    /** [touchTap], answering where the finger landed (screen px) – for a driver's findings – or null when it did not touch. */
    protected fun touchTapPoint(node: AccessibilityNodeInfo): PointF? {
        val bounds = steadyBounds(node) ?: run {
            Log.w(tag, "the node to touch went away")
            return null
        }
        val clip = scrollClip(node)
        val label = node.text ?: node.contentDescription
        val point = touchPoint(bounds, clip) ?: run {
            if (clip != null && touchPoint(bounds) != null) {
                Log.w(tag, "'$label' at $bounds lies under the fold of its list (the list shows $clip): not touched")
                noteLine("  ('$label' lies under the fold of its list: $bounds against the list's $clip; not touched)")
            } else {
                Log.w(tag, "no part of $bounds is inside the touchable window $touchable")
            }
            return null
        }
        Log.i(tag, "touch at ${point.x},${point.y} on '$label' (bounds $bounds, touchable $touchable${clip?.let { ", clip $it" } ?: ""})")
        Finger().tap(point.x, point.y)
        return point
    }

    /**
     * Where a finger touches `bounds`: the middle of their part inside [touchable] – and inside
     * `clip`, when given: the part of the screen the target's scrolling ancestors show
     * ([scrollClip]) – or null when no part is. The tree reports a row's unclipped bounds, so a
     * row scrolled under its list's fold still crosses the touchable band; judged against the
     * band alone, the finger landed on whatever chrome lay there (the nightly's focus-ring run:
     * the address pill, whose long press carried the bar) instead of the refusal [touchTap]
     * promises. Callers with a box of their own (the DOM's rect, a card) pass no clip and run
     * as before.
     */
    protected fun touchPoint(bounds: Rect, clip: Rect? = null): PointF? {
        val reach = Rect(bounds)
        if (bounds.isEmpty || !reach.intersect(touchable)) return null
        if (clip != null && !reach.intersect(clip)) return null
        return PointF(reach.exactCenterX(), reach.exactCenterY())
    }

    /**
     * The part of the screen `node`'s scrolling ancestors show: the intersection of the bounds of
     * every ancestor the tree marks scrollable (Blink marks a box whose content overflows its
     * scrollable axis – the History list's `overflow-y: auto` with rows below its fold), the
     * nearest one's clip within the next's. Null when no ancestor scrolls, and the node is clipped
     * by nothing but the window; an empty rect when the ancestors' boxes do not even overlap. A
     * descendant positioned outside its scroller's box (`position: fixed` under a scroller) would
     * read as under the fold here; the chrome's sheets and panels have none.
     */
    protected fun scrollClip(node: AccessibilityNodeInfo): Rect? {
        var clip: Rect? = null
        for (ancestor in generateSequence(node.parent) { it.parent }) {
            if (!ancestor.isScrollable) continue
            val box = Rect().also { ancestor.getBoundsInScreen(it) }
            if (box.isEmpty) continue
            val so = clip
            if (so == null) clip = box else if (!so.intersect(box)) so.setEmpty()
        }
        return clip
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

    // --- the tree read afresh (API 34), and the DOM's box for a finger the tree keeps waiting ------
    //
    // UiAutomation's view of the chrome WebView trails the screen by seconds after a transition
    // on the emulator's software GPU (#237's run had it 23 s behind a dock switch; the phone fixes
    // driver's first run had it blank on a Settings section 8 s after the drill-in and on the
    // History panel 10 s after it rose, while the DOM had both). A read here drops UiAutomation's
    // cache and asks the chrome document for a frame each round (Blink serialises its tree from
    // the lifecycle, which runs with a frame), and a finger that waits on the tree only waits so
    // long: after that it lands on the box the DOM gives for the same control. Moved here from
    // PhoneFixesDemo (the brief: driver fixes live in the shared harness) so every driver has them.

    /**
     * A line for the driver's findings from a shared helper (how long the tree took to list a
     * control, which aim a finger used): the log by default; a driver that keeps a findings file
     * overrides it to write the line there as well.
     */
    protected open fun noteLine(line: String) {
        Log.i(tag, line.trim())
    }

    /**
     * UiAutomation's accessibility node cache dropped (API 34's `clearCache`), so the next read
     * of the tree goes to the app rather than to what the cache kept of it; false where the
     * platform has no such call or the cache was not cleared.
     */
    protected fun dropTreeCache(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && ui.clearCache()

    /**
     * A frame asked of the chrome document (an animation frame), so Blink runs its lifecycle –
     * and the accessibility step that serialises the tree's changes and sends its location
     * changes – while a read waits on the tree.
     */
    protected fun nudgeFrame() {
        chromeJs("(function(){requestAnimationFrame(function(){});return 1})()")
    }

    /**
     * Every node whose label or text `matches`, read past UiAutomation's cache: the cache dropped,
     * the active window walked, and – when it has no root or nothing matches – every window of
     * the app's.
     */
    protected fun freshNodes(matches: (String) -> Boolean): List<AccessibilityNodeInfo> {
        dropTreeCache()
        val found = findNodes(matches)
        if (found.isNotEmpty()) return found
        return findInWindows(app.packageName, matches)?.let { listOf(it) } ?: emptyList()
    }

    /**
     * Poll for the first node whose label or text `matches`, with bounds on screen, for up to
     * `timeoutMs`: the cache dropped and a frame asked of the chrome document each round. How
     * long the tree took to list `what` is a [noteLine] when it took over a second or never did
     * (with the WebView's accessibility events meanwhile, when [recordA11yEvents] is on).
     */
    protected fun awaitFresh(timeoutMs: Long, what: String, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val start = SystemClock.uptimeMillis()
        val deadline = start + timeoutMs
        while (true) {
            val node = freshNodes(matches).firstOrNull { boundsOnScreen(Rect().also { r -> it.getBoundsInScreen(r) }) }
            if (node != null) {
                val took = SystemClock.uptimeMillis() - start
                if (took > 1_000) noteLine("  (the tree listed $what after $took ms)")
                return node
            }
            if (SystemClock.uptimeMillis() >= deadline) {
                noteLine("  (the tree did not list $what within $timeoutMs ms; WebView events meanwhile: ${eventsSince(start)})")
                return null
            }
            nudgeFrame()
            SystemClock.sleep(250)
        }
    }

    /** Every accessibility event the app's windows sent since [recordA11yEvents]: (uptime ms, type). Null until then. */
    private var a11yEvents: MutableList<Pair<Long, Int>>? = null

    /**
     * Put the accessibility events on record: the events the WebView sends are the tree's only
     * word that it changed (UiAutomation's cache lives on them), so the findings that say how far
     * the tree trailed can say what the WebView sent meanwhile ([eventsSince]). One listener per
     * UiAutomation: a driver with a listener of its own keeps it and leaves this off.
     */
    protected fun recordA11yEvents() {
        val events = Collections.synchronizedList(ArrayList<Pair<Long, Int>>())
        a11yEvents = events
        ui.setOnAccessibilityEventListener { event -> events += SystemClock.uptimeMillis() to event.eventType }
    }

    /** The accessibility events since `markUptime`, counted by type ("WINDOW_CONTENT_CHANGED x3, …"); "none" for none, "not on record" without [recordA11yEvents]. */
    protected fun eventsSince(markUptime: Long): String {
        val events = a11yEvents ?: return "not on record"
        val counts = LinkedHashMap<String, Int>()
        synchronized(events) {
            for ((at, type) in events) {
                if (at < markUptime) continue
                val name = AccessibilityEvent.eventTypeToString(type).removePrefix("TYPE_")
                counts[name] = (counts[name] ?: 0) + 1
            }
        }
        return if (counts.isEmpty()) "none" else counts.entries.joinToString(", ") { "${it.key} x${it.value}" }
    }

    /**
     * An element's box as the chrome lays it out, in screen px: the chrome fills the window from
     * its top-left corner, so its CSS px times the density are screen px (SettingsTouchDemo's
     * reading), shifted by what [calibrateDomBoxes] found the tree's bounds add. `js` is an
     * expression for the element; null when it is none.
     */
    protected fun domBox(js: String): Rect? {
        val text = chromeString(
            "(function(){var e=($js);if(!e)return '';var r=e.getBoundingClientRect();" +
                "return [r.left,r.top,r.right,r.bottom].map(function(v){return Math.round(v*$density)}).join(',')})()"
        )
        val px = text.split(',').map { it.toIntOrNull() ?: return null }
        if (px.size != 4) return null
        return Rect(px[0], px[1], px[2], px[3]).also { it.offset(domShiftX, domShiftY) }
    }

    /** What the tree's bounds add to the DOM's box ([calibrateDomBoxes]); 0 while the two agree. */
    protected var domShiftX = 0
        private set
    protected var domShiftY = 0
        private set

    /**
     * The DOM's box against the tree's for the same control – the bar's Menu button – once, at
     * the warm-up: the chrome fills the window from its corner on this image (the phone fixes
     * driver's runs: the tree's 638–719 for the DOM's 641–718 px), but should the chrome sit
     * under an inset the tree's bounds carry, the difference is taken up so every DOM-aimed
     * finger lands where the screen has the control (ChromeA11yDemo's `calibrate`). A difference
     * under 4 px stays 0; the shift is measured from the DOM's own pixels, so a second call does
     * not compound on the first. The result is a [noteLine].
     */
    protected fun calibrateDomBoxes(timeoutMs: Long = 6_000) {
        val node = awaitFresh(timeoutMs, "the bar's Menu button") { it == MENU_LABEL } ?: return
        val tree = Rect().also { node.getBoundsInScreen(it) }
        val dom = domBox(MENU_BUTTON_JS)?.also { it.offset(-domShiftX, -domShiftY) } ?: return
        val dx = Math.round(tree.exactCenterX() - dom.exactCenterX())
        val dy = Math.round(tree.exactCenterY() - dom.exactCenterY())
        domShiftX = if (Math.abs(dx) >= 4) dx else 0
        domShiftY = if (Math.abs(dy) >= 4) dy else 0
        noteLine("  the Menu button: tree $tree, DOM $dom -> DOM boxes shifted by ${domShiftX}x$domShiftY")
    }

    /**
     * A real touch on the control reading `label` (its prefix with `prefix`): at the tree's node
     * once the tree lists it with bounds on screen (`treeMs`), else at the box the DOM gives for
     * the element `domJs` evaluates to – the tree trails the screen by seconds on the emulator
     * and the finger does not wait on it past that. The aim is a [noteLine]; the touch is the
     * same injected finger either way, and a claim is read off what follows it, never off this.
     * False, nothing injected, when neither the tree nor the DOM has the control inside the
     * touchable window.
     */
    protected fun touchControl(label: String, domJs: String, prefix: Boolean = false, treeMs: Long = 5_000): Boolean {
        val node = awaitFresh(treeMs, "'$label'") { it == label || (prefix && it.startsWith(label)) }
        if (node != null) {
            val point = touchTapPoint(node)
            if (point != null) return true
            noteLine("  (the tree's node for '$label' went away or lies outside the touchable window)")
        }
        val box = domBox(domJs) ?: run {
            noteLine("  '$label' is in neither the tree nor the DOM")
            return false
        }
        val point = touchPoint(box) ?: run {
            noteLine("  the DOM's box for '$label' ($box) lies outside the touchable window $touchable")
            return false
        }
        noteLine("  touch at ${point.x.toInt()},${point.y.toInt()} on '$label' at the DOM's box $box (the tree had not listed it)")
        Finger().tap(point.x, point.y)
        return true
    }

    /**
     * [touchControl], then up to `timeoutMs` for `took` to hold – the claim of the step, named by
     * `effect`. True when it held; a touch that went in and did not take is a [touchFault] (the
     * run fails at its end) and false.
     */
    protected fun touchControlExpecting(
        label: String,
        domJs: String,
        effect: String,
        timeoutMs: Long = 6_000,
        prefix: Boolean = false,
        took: () -> Boolean
    ): Boolean {
        if (!touchControl(label, domJs, prefix)) return false
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

    /** [chromeJs]'s answer as text: the JSON string decoded, "" for null or no answer. */
    private fun chromeString(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    // --- what renders the screen -----------------------------------------------------------------

    /** What renders this run's screen: a GPU, software (the hosted emulator's SwiftShader), or unsaid. */
    protected enum class RendererKind { HARDWARE, SOFTWARE, UNKNOWN }

    /** The renderer and where the word came from; [hardware] is true only for a GPU known to render. */
    protected class Renderer(val kind: RendererKind, val evidence: String) {
        val hardware: Boolean get() = kind == RendererKind.HARDWARE
        override fun toString(): String = "${kind.name.lowercase()} ($evidence)"
    }

    /**
     * The renderer behind the screen, read once, for a claim whose bound only a GPU can meet (the
     * phone fixes driver's flip: two hops of 0.5–1.3 s on the emulator's software UI thread, a
     * frame or two on a device). The `renderer` instrumentation argument when a caller says
     * (`-e renderer hardware` or `software`), else SurfaceFlinger's own word – its dump's `GLES:`
     * line names the GL renderer: SwiftShader (the recipe's `swangle`, ANGLE over SwiftShader
     * Vulkan) or llvmpipe is software; on a device anything else is its GPU; an emulator (`qemu`
     * in the properties) counts as hardware only when the line names a GPU vendor behind its
     * translator (`-gpu host` on a machine with one) – else the EGL vendor property (a GPU's name
     * on a device; `emulation` on every emulator says nothing). Unknown when none of them say,
     * and a bound gated on hardware stays soft then: the safe side for a run's verdict.
     */
    protected val renderer: Renderer by lazy { readRenderer() }

    private fun readRenderer(): Renderer {
        when (InstrumentationRegistry.getArguments().getString(RENDERER_ARGUMENT)?.trim()?.lowercase()) {
            "hardware" -> return Renderer(RendererKind.HARDWARE, "the renderer argument")
            "software" -> return Renderer(RendererKind.SOFTWARE, "the renderer argument")
        }
        val property = { name: String -> runCatching { shellCommand("getprop $name") }.getOrDefault("").trim() }
        val emulator = property("ro.kernel.qemu") == "1" || property("ro.boot.qemu") == "1"
        val gles = runCatching { shellCommand("dumpsys SurfaceFlinger") }.getOrDefault("")
            .lineSequence().map { it.trim() }.firstOrNull { it.startsWith("GLES:") }?.take(200)
        if (gles != null) {
            return when {
                SOFTWARE_RENDERERS.any { gles.contains(it, ignoreCase = true) } -> Renderer(RendererKind.SOFTWARE, gles)
                !emulator -> Renderer(RendererKind.HARDWARE, gles)
                GPU_VENDORS.any { gles.contains(it, ignoreCase = true) } -> Renderer(RendererKind.HARDWARE, "an emulator on the host's GPU: $gles")
                else -> Renderer(RendererKind.UNKNOWN, "an emulator whose GLES line names no GPU: $gles")
            }
        }
        val egl = property("ro.hardware.egl")
        if (!emulator && egl.isNotEmpty() && egl.lowercase() !in EMULATED_EGL) return Renderer(RendererKind.HARDWARE, "ro.hardware.egl $egl")
        return Renderer(RendererKind.UNKNOWN, "no GLES line in SurfaceFlinger's dump; ro.hardware.egl '${egl.ifEmpty { "unset" }}'${if (emulator) ", an emulator" else ""}")
    }

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

    /**
     * One reading of the open URL field, by the FIELD: the chrome's store says the field is open,
     * the field's input (`[data-testid="urlbar-input"]`, Urlbar.tsx) is the document's active
     * element, the header row over the rows (`urlbar-page-header`: the page's title and address)
     * is in the DOM, the field's text, and whether the keyboard is up. [ok] is the store's word
     * and the focus together: the field is open and takes keys. The header row is there on a
     * page and not on the new tab page, and the keyboard is the emulator's own moment (a driver
     * that needs it asks [awaitIme]); both are on record for the finding, neither is the proof.
     */
    protected class OmniboxOpen(val open: Boolean, val focused: Boolean, val header: Boolean, val value: String, val imeUp: Boolean) {
        val ok: Boolean get() = open && focused

        fun describe(): String =
            "store open $open, field focused $focused, header row $header, field '${value.take(40)}', keyboard ${if (imeUp) "up" else "down"}"
    }

    private fun readOmniboxOpen(): OmniboxOpen {
        val raw = chromeJs(
            "(function(){var s=((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true;" +
                "var a=document.activeElement;var f=!!(a&&a.matches&&a.matches('[data-testid=\"urlbar-input\"]'));" +
                "var h=!!document.querySelector('[data-testid=\"urlbar-page-header\"]');" +
                "var v=f?String(a.value||''):String((document.querySelector('[data-testid=\"urlbar-input\"]')||{}).value||'');" +
                "return JSON.stringify({open:s,focused:f,header:h,value:v})})()"
        )
        val json = runCatching { JSONObject(JSONTokener(raw).nextValue().toString()) }.getOrNull()
        return OmniboxOpen(
            open = json?.optBoolean("open") ?: false,
            focused = json?.optBoolean("focused") ?: false,
            header = json?.optBoolean("header") ?: false,
            value = json?.optString("value") ?: "",
            imeUp = imeShown()
        )
    }

    /**
     * The URL field open after a tap on the pill, proven by the field ([OmniboxOpen]): polled for
     * up to `timeoutMs`, the last reading returned either way, said in the log. Shared: the field
     * opens EMPTY on a page since #208 (search-ready, the page in the header row), so its Clear
     * button – there once something is typed, Urlbar.tsx – is no proof of the open, and the
     * accessibility tree's word trails the screen on the emulator; the store and the DOM are the
     * chrome's own state.
     */
    protected fun awaitOmniboxOpen(timeoutMs: Long = 8_000): OmniboxOpen {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var reading = readOmniboxOpen()
        while (!reading.ok && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            reading = readOmniboxOpen()
        }
        if (reading.ok) Log.i(tag, "awaitOmniboxOpen: ${reading.describe()}") else Log.e(tag, "awaitOmniboxOpen: NOT OPEN in $timeoutMs ms: ${reading.describe()}")
        return reading
    }

    // --- the Settings page by the chrome document ------------------------------------------------
    //
    // What the phone Settings page shows is read off the chrome's DOCUMENT first and the
    // accessibility tree second. On the emulator's software GPU this WebView's tree trails the
    // screen by seconds: the nightly's first sweep (runs 35728999647 and 35737412086) had thirteen
    // Settings drivers touch a row at the bounds the tree gave, the section or the sheet up on
    // the recording within a second, and the tree without it for the 5 to 15 s the touch was
    // given (`phone-fixes`: "the tree did not list the Look and Feel section within 15000 ms;
    // WebView events meanwhile: WINDOW_CONTENT_CHANGED x4"), while BarHideDemo passed the very
    // same Look and Feel tap in the same chain reading the document. The document is the
    // chrome's own state and carries the words the tree would: the section
    // (`.zen-settings-phone[data-section]`, SettingsPage.tsx), a row (`.zen-settings-row` with
    // its `.zen-settings-label` and `.zen-settings-description`, rows.tsx / blocks.tsx; the
    // landing's categories, `.zen-settings-category[data-section]`; nothing under an `inert`
    // landing, which stays mounted under a section), a sheet (`[data-sheet-layer] [role=dialog]`,
    // BottomSheet.tsx, named by its title and held at opacity 0 until presented). Every Settings
    // driver reads its section, rows and sheets here; the tree keeps what only it can say –
    // TalkBack's names, roles and states, with a window of its own – and stays the map for a
    // finger where the document has no such row ([touchTapLabel]).

    /** Poll `holds` every 200 ms for up to `timeoutMs`; its last word. */
    protected fun awaitTrue(timeoutMs: Long, holds: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (holds()) return true
            SystemClock.sleep(200)
        }
        return holds()
    }

    /** A string the chrome answered ([chromeJs] hands JSON back), null for anything else. */
    protected fun chromeJsString(code: String): String? =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull() as? String

    /**
     * `.zen-settings-phone[data-section]`: [SETTINGS_LANDING], a section's id ([LOOK_SECTION],
     * "privacy", "languages", "passwords", "security", … – `internalPages.ts`), "" with no
     * Settings page up; null when the chrome did not answer.
     */
    protected fun settingsSection(): String? =
        chromeJsString("(function(){var p=document.querySelector('.zen-settings-phone');return p?String(p.dataset.section||''):''})()")

    /**
     * The Settings page is at `section` by the document; when the chrome does not answer, by the
     * tree's `treeSign` (a label the section alone shows), given one.
     */
    protected fun settingsSectionIs(section: String, treeSign: String? = null): Boolean {
        val shown = settingsSection()
        return if (shown != null) shown == section else treeSign != null && findNode { it.startsWith(treeSign) } != null
    }

    /** Poll up to `timeoutMs` for the Settings page to be at `section` ([settingsSectionIs]). */
    protected fun awaitSettingsSection(section: String, timeoutMs: Long = 8_000, treeSign: String? = null): Boolean =
        awaitTrue(timeoutMs) { settingsSectionIs(section, treeSign) }

    /**
     * The document's script for the Settings control whose label reads `label`: a row's label
     * (a picker's option is a row; a sheet's rows count) or a landing category's, then a group's
     * heading (its `section` the control; the heading's own words, not its aside – a group and
     * its one row can share a name, Clear browsing data), a label reading exactly `label` before
     * one that starts with it; nothing under `[inert]`. `body` runs with `row` (the control's
     * element) and `e` (its label) and its result is the answer.
     */
    private fun settingsControlJs(label: String, body: String): String =
        "(function(l){var sel='.zen-settings-row .zen-settings-label,.zen-settings-category-label,.zen-settings-heading';" +
            "var all=Array.prototype.filter.call(document.querySelectorAll(sel),function(e){return !e.closest('[inert]')});" +
            "var isHead=function(e){return e.classList.contains('zen-settings-heading')};" +
            "var rows=all.filter(function(e){return !isHead(e)}),heads=all.filter(isHead);" +
            "var text=function(e){var c=e.firstChild;return (isHead(e)&&c&&c.nodeType===3?c.nodeValue:(e.textContent||'')).trim()};" +
            "var exact=function(e){return text(e)===l},prefix=function(e){return text(e).indexOf(l)===0};" +
            "var e=rows.find(exact)||heads.find(exact)||rows.find(prefix)||heads.find(prefix);if(!e)return null;" +
            "var row=e.closest('.zen-settings-row,.zen-settings-category,.zen-settings-group')||e;$body})(${JSONObject.quote(label)})"

    /** Whether the document lists a Settings control labelled `label` (a row, an option, a category), scrolled or not. */
    protected fun settingsRowListed(label: String): Boolean =
        chromeJs(settingsControlJs(label, "return true")) == "true"

    /** Poll up to `timeoutMs` for the document to list the Settings control labelled `label`. */
    protected fun awaitSettingsRow(label: String, timeoutMs: Long = 8_000): Boolean =
        awaitTrue(timeoutMs) { settingsRowListed(label) }

    /**
     * Whether the Settings page's panes are at rest: no animation running on the drill-in pane
     * (its 240 ms `zen-settings-enter-*` slide, a compositor transform, main.css) or on a sheet
     * over it. A box read mid-slide is where the row was, not where it will be – the tree kept
     * one such box for a whole section on the nightly (ServicesHardeningDemo's note) – so a
     * finger waits for this.
     */
    protected fun settingsAtRest(): Boolean =
        chromeJs(
            "(function(){var els=document.querySelectorAll('.zen-settings-drill-in,.zen-settings-phone,[data-sheet-layer] [role=\"dialog\"]');" +
                "for(var i=0;i<els.length;i++){var as=els[i].getAnimations({subtree:false});for(var j=0;j<as.length;j++){if(as[j].playState==='running')return false}}return true})()"
        ) != "false"

    /**
     * Where the Settings control labelled `label` is on screen, by the document: the panes at
     * rest first ([settingsAtRest], up to a second), scrolled into view (to the middle: clear
     * of the bar and the sheet's grip), read again once the scroll has landed, the document's
     * CSS px scaled into the chrome view's place on screen. Null when the document has no such
     * control.
     */
    protected fun settingsRowRect(label: String): Rect? {
        val find = settingsControlJs(
            label,
            "row.scrollIntoView({block:'center',behavior:'instant'});var r=row.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].join(',')"
        )
        fun read(): Rect? {
            val edges = chromeJsString(find)?.split(',')?.mapNotNull { it.toDoubleOrNull() } ?: return null
            if (edges.size != 4) return null
            var origin = IntArray(2)
            instrumentation.runOnMainSync { origin = IntArray(2).also((activity as MainActivity).host.chrome::getLocationOnScreen) }
            return Rect(
                (origin[0] + edges[0] * density).roundToInt(),
                (origin[1] + edges[1] * density).roundToInt(),
                (origin[0] + edges[2] * density).roundToInt(),
                (origin[1] + edges[3] * density).roundToInt()
            )
        }
        if (!settingsRowListed(label)) return null
        awaitTrue(1_000) { settingsAtRest() }
        read() ?: return null
        SystemClock.sleep(600)
        return read()
    }

    /**
     * Where the Settings control labelled `label` is on screen: the document's word
     * ([settingsRowRect]) first, the tree's (`ACTION_SHOW_ON_SCREEN` on the node whose text
     * starts with it: a row's label and value run together there) when the document has no such
     * row; null when neither has one.
     */
    protected fun revealSettingsRow(label: String): Rect? {
        settingsRowRect(label)?.let { return it }
        val node = findNode { it.startsWith(label) } ?: return null
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findNode { it.startsWith(label) }?.let { row -> Rect().also { row.getBoundsInScreen(it) } }
    }

    /**
     * What the Settings row labelled `label` reads under its label, by the document: a value
     * row's description is its option's label ("Dark"), a plain row's its description; "" for a
     * row without one, null when the document has no such row.
     */
    protected fun settingsRowValue(label: String): String? =
        chromeJsString(settingsControlJs(label, "var d=row.querySelector('.zen-settings-description');return d?(d.textContent||'').trim():''"))

    /** Whether the Settings row labelled `label` reads `value` in the document ([settingsRowValue]). */
    protected fun settingsRowReads(label: String, value: String): Boolean = settingsRowValue(label) == value

    /**
     * The accessible name the document gives the Settings control labelled `label`: its
     * `aria-label` when it has one (a value row's "label, value", fix 6 of #305), else its text
     * with the whitespace folded; null when the document has no such control.
     */
    protected fun settingsRowName(label: String): String? =
        chromeJsString(settingsControlJs(label, "return row.getAttribute('aria-label')||(row.textContent||'').replace(/\\s+/g,' ').trim()"))

    /**
     * Whether the document exposes the Settings control labelled `label` to assistive
     * technology: not under `[inert]` or `[aria-hidden=true]`, laid out and visible. Null when
     * the document has no such control. What a tree read cannot tell apart – a control the
     * product hides from TalkBack and a tree that has not listed it yet – the document can.
     */
    protected fun settingsRowExposed(label: String): Boolean? =
        chromeJsString(
            settingsControlJs(
                label,
                "if(row.closest('[inert],[aria-hidden=\"true\"]'))return 'false';var s=getComputedStyle(row);" +
                    "return String(s.visibility!=='hidden'&&s.display!=='none'&&row.getClientRects().length>0)"
            )
        )?.toBooleanStrictOrNull()

    /**
     * Ask Blink to serialise the Settings page's subtree again: `aria-hidden` set on the pane
     * (the drill-in, else the page) and taken off two frames on, which marks the subtree dirty
     * both ways. On the nightly this WebView listed the Look and Feel section's rows in the tree
     * only after the Colour scheme picker had come and gone – the sheet's `holdChromeInert`
     * (lib/portals.tsx) puts `inert` on the shell roots and takes it off on release, and that
     * toggle is what brought the rows into the tree; the four WINDOW_CONTENT_CHANGED events of
     * the 15 s before it never had. Nothing of the product's state changes; TalkBack is not
     * running on the emulator to hear the two frames.
     */
    protected fun nudgeSettingsTree(): Boolean =
        chromeJs(
            "(function(){var p=document.querySelector('.zen-settings-drill-in')||document.querySelector('.zen-settings-phone');if(!p)return false;" +
                "if(p.getAttribute('aria-hidden')==='true')return false;p.setAttribute('aria-hidden','true');" +
                "requestAnimationFrame(function(){requestAnimationFrame(function(){p.removeAttribute('aria-hidden')})});return true})()"
        ) == "true"

    /**
     * The tree's node for the Settings control labelled `label` (its text starting with the
     * label: a value row's label and value run together), with bounds on screen, within
     * `timeoutMs` – the window for what only the tree can say (TalkBack's name for a row, one
     * node for it), 15 s by default. Each round the cache is dropped and a frame asked
     * ([awaitFresh]); at 2 s and again at 8 s without the node the subtree is serialised anew
     * ([nudgeSettingsTree]). How long it took, or that it never came, is a [noteLine]. Null past
     * the window.
     */
    protected fun awaitSettingsRowInTree(label: String, timeoutMs: Long = TREE_WINDOW_MS): AccessibilityNodeInfo? {
        val start = SystemClock.uptimeMillis()
        val nudges = ArrayDeque(listOf(2_000L, 8_000L))
        while (true) {
            val node = freshNodes { it.startsWith(label) }.firstOrNull { boundsOnScreen(Rect().also { r -> it.getBoundsInScreen(r) }) }
            val took = SystemClock.uptimeMillis() - start
            if (node != null) {
                if (took > 1_000) noteLine("  (the tree listed '$label' after $took ms)")
                return node
            }
            if (took >= timeoutMs) {
                noteLine("  (the tree did not list '$label' within $timeoutMs ms; WebView events meanwhile: ${eventsSince(start)})")
                return null
            }
            if (nudges.isNotEmpty() && took >= nudges.first()) {
                nudges.removeFirst()
                if (nudgeSettingsTree()) noteLine("  (the tree without '$label' at $took ms: the Settings subtree serialised anew)")
            }
            nudgeFrame()
            SystemClock.sleep(250)
        }
    }

    /**
     * Whether the Settings switch row labelled `label` is on, by the document (`role="switch"`
     * with `aria-checked`, rows.tsx); null when the document has no such switch.
     */
    protected fun settingsSwitchOn(label: String): Boolean? =
        chromeJsString(settingsControlJs(label, "var s=row.matches('[role=\"switch\"]')?row:row.querySelector('[role=\"switch\"]');return s?String(s.getAttribute('aria-checked')==='true'):null"))?.toBooleanStrictOrNull()

    /**
     * The names of the sheets presented over the Settings page (or any page: the chassis is
     * shared), by the document: every `[data-sheet-layer] [role="dialog"]` the chassis has
     * brought up (`opacity` set to 1 on `present`, BottomSheet.tsx), named by its title
     * (`aria-labelledby`) or its `aria-label`, in stacking order.
     */
    protected fun sheetsPresented(): List<String> {
        val raw = chromeJs(
            "(function(){var ds=document.querySelectorAll('[data-sheet-layer] [role=\"dialog\"]');var out=[];" +
                "for(var i=0;i<ds.length;i++){var d=ds[i];if(d.style.opacity!=='1'&&getComputedStyle(d).opacity==='0')continue;" +
                "var n=d.getAttribute('aria-label');if(!n){var id=d.getAttribute('aria-labelledby');var t=id&&document.getElementById(id);n=t?(t.textContent||'').trim():''}" +
                "out.push(n)}return JSON.stringify(out)})()"
        )
        val json = runCatching { JSONArray(JSONTokener(raw).nextValue().toString()) }.getOrNull() ?: return emptyList()
        return (0 until json.length()).map { json.optString(it) }
    }

    /** Whether a sheet named `title` is presented ([sheetsPresented]); with `prefix`, one whose name starts with it. */
    protected fun sheetPresented(title: String, prefix: Boolean = false): Boolean =
        sheetsPresented().any { it == title || (prefix && it.startsWith(title)) }

    /** Poll up to `timeoutMs` for a sheet named `title` to be presented. */
    protected fun awaitSheet(title: String, timeoutMs: Long = 8_000, prefix: Boolean = false): Boolean =
        awaitTrue(timeoutMs) { sheetPresented(title, prefix) }

    /** Poll up to `timeoutMs` for no sheet named `title` to be presented. */
    protected fun awaitSheetGone(title: String, timeoutMs: Long = 8_000, prefix: Boolean = false): Boolean =
        awaitTrue(timeoutMs) { !sheetPresented(title, prefix) }

    /**
     * A real touch on the Settings control labelled `label`: where the document has it
     * ([settingsRowRect]), else on the tree's node ([touchTapLabel], the label a prefix: a
     * value row's text runs its label and value together there). True when a finger went in.
     */
    protected fun touchSettingsRow(label: String): Boolean {
        val rect = settingsRowRect(label) ?: return touchTapLabel(label, prefix = true)
        val point = touchPoint(rect) ?: run {
            Log.w(tag, "no part of '$label' at $rect is inside the touchable window $touchable")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on '$label' (document rect $rect, touchable $touchable)")
        Finger().tap(point.x, point.y)
        return true
    }

    /**
     * [touchSettingsRow], then up to `timeoutMs` for `took` to hold – the step's claim, named by
     * `effect` ([touchTapLabelExpecting]'s shape; `took` reads the document, [settingsSectionIs],
     * [settingsRowListed], [sheetPresented], [settingsRowReads]). False and no touch when
     * nothing reads `label`; a [touchFault] and false when the touch went in and `took` never
     * held.
     */
    protected fun touchSettingsRowExpecting(label: String, effect: String, timeoutMs: Long = 8_000, took: () -> Boolean): Boolean {
        if (!touchSettingsRow(label)) return false
        if (awaitTrue(timeoutMs, took)) {
            Log.i(tag, "the touch on '$label' took: $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /** Click the Settings row whose text starts with `label` through the tree (the nearest clickable ancestor): a way to a state, never the claim. */
    protected fun clickSettingsRow(label: String): Boolean {
        var node = findNode { it.startsWith(label) }
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    /**
     * The Settings tab from the menu sheet, on its landing (since #134 the phone's Settings opens
     * on its categories): the menu's Settings row under a finger, the landing proven by the
     * document. True once the landing is up; false, said in the log, when it never came.
     */
    protected fun openSettingsLanding(timeoutMs: Long = 8_000): Boolean {
        ensureForeground()
        if (settingsSectionIs(SETTINGS_LANDING)) return true
        tapMenuButton()
        SystemClock.sleep(2_500)
        reveal("Settings")
        val landing = { settingsSectionIs(SETTINGS_LANDING, treeSign = LOOK_AND_FEEL_LABEL) }
        if (touchTapLabelExpecting("Settings", "the Settings tab is up on its landing", timeoutMs = timeoutMs, took = landing)) return true
        if (landing()) return true
        if (clickByLabel("Settings") && awaitTrue(timeoutMs, landing)) return true
        Log.w(tag, "the Settings landing never came up (section '${settingsSection()}')")
        return false
    }

    /**
     * A Settings section from the landing: its category row ([SETTINGS_SECTIONS] gives the row's
     * label for a section id) under a finger, the section proven by the document
     * (`data-section`), the tree's click as the way there when the finger's touch never took
     * (the fault is on record either way). [openSettingsLanding] first when the landing is not up.
     * True once the section is up.
     */
    protected fun openSettingsSection(section: String, timeoutMs: Long = 8_000): Boolean {
        val label = SETTINGS_SECTIONS[section] ?: error("no Settings section '$section' on record")
        if (settingsSectionIs(section)) return true
        if (!settingsSectionIs(SETTINGS_LANDING) && !openSettingsLanding(timeoutMs)) return false
        SystemClock.sleep(1_000)
        val up = { settingsSectionIs(section) }
        if (touchSettingsRowExpecting(label, "the $label section is up", timeoutMs, up)) return true
        if (up()) return true
        if (clickSettingsRow(label) && awaitTrue(timeoutMs, up)) return true
        Log.w(tag, "the $label section never came up (section '${settingsSection()}')")
        return false
    }

    /**
     * Leave the Settings tab: a back pops a section to the landing, a back at the landing closes
     * the tab to its opener; each proven by the document.
     */
    protected fun leaveSettingsTab() {
        val shown = settingsSection() ?: return
        if (shown.isEmpty()) return
        if (shown != SETTINGS_LANDING) {
            back()
            awaitTrue(4_000) { settingsSectionIs(SETTINGS_LANDING) }
            SystemClock.sleep(1_000)
        }
        back()
        awaitTrue(4_000) { settingsSection() == "" }
        SystemClock.sleep(1_000)
    }

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
                    // The move was decided on a reading that can be a second old when the main
                    // thread posts frames of a second (three reads, each a hop to it): on the
                    // nightly's proof run the omnibox's Share step read the field open, the field
                    // closed on its own meanwhile (the chrome closes it after a share) and the back
                    // decided on went to the tab at its root, which cost the page. So the host is
                    // asked once more, the instant before the key, and the key goes only while it
                    // still hands the back to the chrome; else the field is read afresh.
                    if (!chromeSurfaceUp()) {
                        Log.i(tag, "closeUrlField: the host no longer hands a back to the chrome; the key is kept and the field read again")
                        field = readUrlField()
                        continue@loop
                    }
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

    /**
     * A finger on the bar's Menu button, at [menuButtonPoint]. The tap is READ BACK before it is
     * taken as one: a stationary press the bar keeps 400 ms is the editor's entry point
     * (`useBarHold`, #52), and on the recipe's software GPU a 60 ms tap can reach the chrome as
     * a hold – the down dispatched, a long frame, the up behind the hold's timer – so the
     * Navigation Bar editor stands where the menu should (private-lock in the repairs' second
     * proof run: eleven checks lost to one such tap under the lock's cover). The editor (or the
     * Tabs button's quick menu, the same recogniser) is dismissed with a back and the finger goes
     * in again. A tap that brought NEITHER within [MENU_OPEN_MS] goes in again too, the button
     * read afresh (the repairs' fourth proof run lost two to such taps on one shard: touchfix's
     * went in 1.5 s after the back that sent the Downloads panel away, while the panel was still
     * leaving – 2.9 s to leave behind the software GPU – and took nothing but its scrim; ptr's
     * went in 2 s after a drag had brought the hidden bar back, and nothing came of it either,
     * the tree's Menu button the likeliest to have stood where the hide had it, under the
     * navigation bar) – a surface still on its way out is given [MENU_SURFACE_WAIT_MS] to leave
     * first. [MENU_TAP_TRIES] taps in all. True once the menu's sheet (its `Resize menu` handle)
     * is in the chrome's document; false when nothing came of any of them – the caller's own
     * wait for the handle in the tree says what that means for its claim, as before.
     */
    protected fun tapMenuButton(): Boolean {
        ensureForeground()
        repeat(MENU_TAP_TRIES) { attempt ->
            val button = menuButtonPoint()
            Finger().tap(button.x, button.y)
            val deadline = SystemClock.uptimeMillis() + MENU_OPEN_MS
            var read = ""
            while (SystemClock.uptimeMillis() < deadline) {
                read = menuTapRead()
                if (read == "menu") return true
                if (read == "held") break
                SystemClock.sleep(150)
            }
            val last = attempt == MENU_TAP_TRIES - 1
            if (read == "held") {
                Log.w(tag, "the tap on Menu was read as a hold (the bar's editor opened instead); dismissing it${if (last) "" else " and trying again"} (${attempt + 1}/$MENU_TAP_TRIES)")
                back()
                awaitTrue(4_000) { menuTapRead() != "held" }
                SystemClock.sleep(800)
            } else if (!last) {
                val surface = chromeSurfaceUp()
                Log.w(tag, "nothing came of the tap on Menu at $button within $MENU_OPEN_MS ms (a chrome surface up: $surface); the button read again and the finger in again (${attempt + 1}/$MENU_TAP_TRIES)")
                if (surface && !awaitSurface(false, MENU_SURFACE_WAIT_MS)) Log.w(tag, "the surface is still up after $MENU_SURFACE_WAIT_MS ms; the finger goes in regardless")
            }
        }
        return false
    }

    /**
     * Where a finger tapping the Menu button goes: the tree's button when its centre is in the
     * window's touchable band, the bar's resting place ([computedMenuButton]: rightmost, on the
     * pill's line) when the tree has none or has it in a system bar – the tree trails the bar's
     * return from hidden by seconds on the emulator, and a finger never goes where the system
     * takes the touch (the pill's [pillPoint] guards the same way).
     */
    private fun menuButtonPoint(): PointF {
        val found = findByLabel(MENU_LABEL)
        val target = when {
            found == null -> computedMenuButton()
            touchable.contains(found.centerX(), found.centerY()) -> found
            else -> {
                Log.w(tag, "the tree's Menu button $found is outside the touchable band $touchable; the bar's resting place ${computedMenuButton()} instead")
                computedMenuButton()
            }
        }
        return PointF(target.exactCenterX(), target.exactCenterY())
    }

    /**
     * What the chrome shows for a tap on Menu: "menu" (the menu's sheet, by its handle), "held"
     * (the bar editor or a quick menu: the hold recogniser fired), "" (nothing yet, or no answer).
     */
    private fun menuTapRead(): String =
        chromeJsString(
            "(function(){if(document.querySelector('.zen-sheet [aria-label=\"$MENU_HANDLE_LABEL\"]'))return 'menu';" +
                "if(document.querySelector('.zen-bar-editor, .zen-quick-menu'))return 'held';return ''})()"
        ) ?: ""

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
        /** The pill on the new tab page: the empty field's words (pillLabel.ts, #51), no address. */
        const val NTP_PILL_LABEL = "Search or enter address"
        /** The new tab page's own field sits in a group of this name (NewTabPage.tsx); the pill does not. */
        const val NTP_FIELD_GROUP_LABEL = "Search"
        /** The pill under the private lock cover (PhoneShell.tsx, INC-05). */
        const val LOCKED_PILL_LABEL = "Private tab locked, unlock"
        /** The bar's Tabs button's name up to its count: "Tabs (N)" ([tabsButton]). */
        const val TABS_LABEL_PREFIX = "Tabs ("
        /** The bar's three-dot button, and the grabber of the menu sheet it opens. */
        const val MENU_LABEL = "Menu"
        const val MENU_HANDLE_LABEL = "Resize menu"
        /**
         * [tapMenuButton]: how long the menu's sheet gets to reach the document, how many taps
         * are tried when one is read as a hold or as nothing, and how long a chrome surface still
         * leaving gets before the next tap goes in.
         */
        const val MENU_OPEN_MS = 6_000L
        const val MENU_TAP_TRIES = 3
        const val MENU_SURFACE_WAIT_MS = 4_000L

        /** The phone Settings page's `data-section` on its landing (SettingsPage.tsx). */
        const val SETTINGS_LANDING = "landing"
        /** The Look and Feel section's id (`internalPages.ts`), the landing's first row. */
        const val LOOK_SECTION = "look"
        const val LOOK_AND_FEEL_LABEL = "Look and Feel"
        /** Other section ids the drivers navigate to (`internalPages.ts`: `SETTINGS_SECTIONS`). */
        const val SEARCH_SECTION = "search"
        const val LANGUAGES_SECTION = "languages"
        const val PRIVACY_SECTION = "privacy"
        const val PASSWORDS_SECTION = "passwords"
        const val SECURITY_SECTION = "security"
        /**
         * The window a claim on what only the accessibility tree can say (TalkBack's name for a
         * row, one node for it) gives the tree to list a Settings control on the emulator, whose
         * tree trails the screen by seconds ([awaitSettingsRowInTree]); the document's word is
         * read at once.
         */
        const val TREE_WINDOW_MS = 15_000L
        /** Settings section ids to the labels of their landing rows (`internalPages.ts`), for [openSettingsSection]. */
        val SETTINGS_SECTIONS: Map<String, String> = mapOf(
            LOOK_SECTION to LOOK_AND_FEEL_LABEL,
            "compact" to "Compact Mode",
            "newtab" to "New Tab",
            "tabs" to "Tab Management",
            "downloads" to "Downloads",
            "resources" to "Resources",
            "search" to "Search",
            "autofill" to "Autofill",
            "languages" to "Languages",
            "privacy" to "Privacy and Security",
            "spaces" to "Space Routing",
            "containers" to "Containers",
            "boosts" to "Boosts",
            "mods" to "Mods",
            "extensions" to "Extensions",
            "agents" to "AI Agents",
            "passwords" to "Passwords",
            "security" to "Security",
            "sync" to "Sync",
            "import" to "Import",
            "accessibility" to "Accessibility",
            "shortcuts" to "Keyboard Shortcuts",
            "default-browser" to "Default Browser",
            "updates" to "Updates",
            "about" to "About"
        )

        /** The overview's card for the tab group named `name` ("Research, tab group, …"), matched without its count: [Card]. */
        fun groupCard(name: String): Card =
            Card("${name.trim()} group card", listOf(name.trim().let { if (it.isEmpty()) "Tab group," else "$it, tab group," }))

        /**
         * The overview's card for the tab titled one of `titles` ("Tea - Wikipedia, tab 4 of 7, …"),
         * matched without its place, the count or its state: [Card]. Several titles for a tab whose
         * title changes once its page loads (the seeded one, then the page's own).
         */
        fun tabCard(vararg titles: String): Card =
            Card("${titles.joinToString(" / ")} card", titles.map { "$it, tab " })

        /**
         * The close button of the overview card in `cell` (a driver's `[data-tab-id="…"]`
         * selector), for a driver that reads the grid's DOM: the card's own child – the button
         * sits beside the card's button in its cell (OverviewCard.tsx) – named "Close TITLE"
         * since #237 (`closeTabLabel`) and matched by its element and the leading word alone, the
         * title being the cell's business already (`button`: the card itself is a `div` whose
         * name a page titled "Close …" would start the same way). Four drivers read
         * `[aria-label="Close tab"]`, the name before #237, and had no X to touch.
         */
        fun closeButtonOf(cell: String): String = "$cell button[aria-label^=\"Close \"]"
        /** The instrumentation argument the gate is read from (`-e jankGate hard`). */
        const val JANK_GATE_ARGUMENT = "jankGate"
        /**
         * The instrumentation argument that holds the core's startup sweeps for the run
         * (`-e holdBackgroundWork true`): the launch intent carries [BackgroundWorkHold.EXTRA_HOLD],
         * and [releaseBackgroundWork] ends the hold once the sequence is over.
         */
        const val HOLD_BACKGROUND_WORK_ARGUMENT = "holdBackgroundWork"
        /** The instrumentation argument a caller names the renderer with (`-e renderer hardware`), see [renderer]. */
        const val RENDERER_ARGUMENT = "renderer"
        /** GL renderer names that draw in software (SurfaceFlinger's `GLES:` line). */
        private val SOFTWARE_RENDERERS = listOf("SwiftShader", "swangle", "llvmpipe", "softpipe", "Software Rasterizer")
        /** GPU vendors and families a GLES line names when an emulator's translator sits on a real GPU. */
        private val GPU_VENDORS = listOf("NVIDIA", "GeForce", "Quadro", "AMD", "Radeon", "Intel", "Iris", "Apple", "Mali", "Adreno", "PowerVR", "Xclipse", "Tegra")
        /** EGL vendor properties that say nothing about a GPU (an emulator's translator, a software stack). */
        private val EMULATED_EGL = setOf("emulation", "swiftshader", "angle", "mesa")
        /** The bar's Menu button in the DOM (`BarButton.tsx`'s `data-bar-item`), for [calibrateDomBoxes]. */
        private const val MENU_BUTTON_JS = "document.querySelector('[data-bar-item=\"menu\"]')"
        /** The bar's pill in the DOM (`PhoneShell.tsx`'s `.zen-phone-pill`, not the carry's ghost), for [pillBounds]. */
        private const val PILL_JS = "document.querySelector('.zen-phone-bar:not([aria-hidden]) .zen-phone-pill:not(.zen-pill-ghost)')"
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
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        const val NUDGE = 30f
        const val STAGE_WAIT = 2_400L
        /** The chrome lifts a held card after 380 ms; the emulator's main thread may lag behind. */
        const val LONG_PRESS_WAIT = 900L
    }
}
