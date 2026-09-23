package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Drives the site-information sheet of the phone chrome so the `android-siteinfo-demo` workflow
 * can record it on an emulator: seeds a profile with two real sites (Google active, Bing next)
 * and a couple of remembered permission decisions, launches the app, lets the page settle, then
 * opens the sheet from the site icon in the address pill, pushes each level – the connection, the
 * cookies (expanded and scrolled, then cleared through the "Clear cookies?" confirmation, a level
 * of the sheet one in from the row: §10.4, the design lead's ruling on W5-17) and the
 * permissions, where the Location grant is reset – pops back with the system back gesture, drags
 * the sheet away by its grabber, and finishes on the tab overview and Settings so the sheet can be
 * compared with its neighbours in the same colour scheme (`-e theme light|dark`). Every press
 * inside the sheet is a real touch; the run asserts what those on the sheet's own rows did (a
 * level pushed in, the cookies cleared through the confirm level – the rule in DemoHarness), and
 * what the chrome does with the rest is what the recording shows. The confirm level's keyboard
 * contract (§9.22 as §10.4 applies it) is driven once with injected key events, the document's
 * focus read through the chrome's bridge, and asserted the same way.
 *
 * Handshake with the workflow (files under the app's `files/siteinfo-demo/`), as in GestureDemo:
 * `record` once the warm-up is done, wait for `recording`, `done` when the sequence is over.
 * Screenshots land next to them as `siteinfo-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class SiteInfoDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "siteinfo-demo")
    private val density = app.resources.displayMetrics.density
    private lateinit var activity: Activity
    private var width = 0
    private var height = 0
    private var bottomInset = 0
    private lateinit var pill: Rect

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
        // Let Google finish loading (and setting its cookies) before anything is recorded.
        SystemClock.sleep(9_000)
        handshake()
        demo()
        Log.i(TAG, "done")
        val faults = touchFaults.map { "touch: $it" } + keyFaults.map { "keyboard: $it" }
        if (faults.isNotEmpty()) {
            throw AssertionError("${touchFaults.size} touch(es) did not take, ${keyFaults.size} key(s) went wrong: ${faults.joinToString("; ")}")
        }
    }

    /** The touches inside the sheet that did not take; [record] fails on them once the recording is done. */
    private val touchFaults = ArrayList<String>()

    private fun touchFault(message: String) {
        Log.e(TAG, "TOUCH FAULT: $message")
        touchFaults += message
    }

    /** The keys of the confirm level's contract the chrome answered wrongly; [record] fails on them too. */
    private val keyFaults = ArrayList<String>()

    private fun keyFault(message: String) {
        Log.e(TAG, "KEY FAULT: $message")
        keyFaults += message
    }

    // --- setup -----------------------------------------------------------------------------------

    /** `-e theme dark` records the same sequence in the dark colour scheme. */
    private val theme: String = InstrumentationRegistry.getArguments().getString("theme") ?: "light"

    private fun seedProfile() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.forEach { it.delete() }
        for ((asset, name) in listOf("siteinfo-demo-state.json" to "state.json", "siteinfo-demo-permissions.json" to "permissions.json")) {
            val text = instrumentation.context.assets.open(asset).use { it.readBytes().toString(Charsets.UTF_8) }
            val seeded = if (name == "state.json") text.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"") else text
            File(zen, name).writeText(seeded)
        }
        out.deleteRecursively()
        out.mkdirs()
    }

    private fun launch() {
        // The launcher entry is an icon alias that hands over to MainActivity and finishes at
        // once; the demo needs the browser's own activity, so it starts that directly.
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent)
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
        var top = 0
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bars = ViewCompat.getRootWindowInsets(root)?.getInsets(WindowInsetsCompat.Type.systemBars())
            width = root.width
            height = root.height
            top = bars?.top ?: 0
            bottomInset = bars?.bottom ?: 0
        }
        if (width == 0 || height == 0) {
            val probe = ui.takeScreenshot() ?: error("could not measure the window")
            width = probe.width
            height = probe.height
            probe.recycle()
        }
        pill = findByLabel(PILL_LABEL)?.takeIf { it.top > height * 0.6 && it.width() > 100 * density } ?: computedPill()
        Log.i(TAG, "window ${width}x${height} density $density insets $top/$bottomInset pill $pill")
    }

    /** Where the pill is when the accessibility tree does not say: below the page, between the buttons. */
    private fun computedPill(): Rect {
        val centerY = height - bottomInset - 28 * density
        return Rect((56 * density).toInt(), (centerY - 22 * density).toInt(), (width - 152 * density).toInt(), (centerY + 22 * density).toInt())
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        Log.i(TAG, if (File(out, "recording").exists()) "recorder rolling" else "recorder never confirmed, going ahead")
        SystemClock.sleep(1_500)
    }

    // --- sequence --------------------------------------------------------------------------------

    private fun demo() {
        val f = Finger()

        // 1. Open the sheet from the site icon at the start of the pill: four rows at content height.
        tapSiteIcon(f)
        awaitSheet()
        SystemClock.sleep(2_000)
        shot("01-sheet")

        // 2. The connection level pushes in; the header's back control pops it.
        if (tapUntil(f, "Connection", BACK_LABEL)) {
            SystemClock.sleep(1_800)
            shot("02-connection")
            tapLabel(f, BACK_LABEL)
            SystemClock.sleep(1_200)
        }

        // 3. Cookies and site data: expand the sheet, scroll the list, then clear the cookies
        //    through the "Clear cookies?" confirmation – a level of the sheet, one in from the row.
        if (tapUntil(f, "Cookies and site data", BACK_LABEL)) {
            SystemClock.sleep(1_800)
            shot("03-cookies")
            expandSheet(f)
            SystemClock.sleep(1_200)
            // Scroll only when the row to reach is below the fold: a level that fits has nothing
            // to scroll, and the pan would drag the sheet instead.
            if (findByLabel("Clear cookies") == null) {
                scrollSheet(f)
                SystemClock.sleep(1_200)
            }
            shot("04-cookies-scrolled")
            if (tapUntil(f, "Clear cookies", "Confirm clear cookies")) {
                SystemClock.sleep(1_200)
                shot("05-clear-cookies-confirm")
                // The level's keyboard contract first, ending with Escape back on the row; then
                // the level again by a real touch, and its verb by another, the result asserted.
                // The level pops first and the cookies level, hidden under it and so out of the
                // tree, comes back with its header: only then does the danger row's absence mean
                // the jar was cleared (it leaves with the last cookie, §9.11, read again through
                // Kotlin, so a wait rather than a fixed time). The row still there means the
                // touch did not take: the cookies were kept.
                confirmKeyboard(f)
                if (tapUntil(f, "Clear cookies", "Confirm clear cookies") && tapLabel(f, "Confirm clear cookies")) {
                    awaitGone("Confirm clear cookies", 10_000)
                    if (!awaitLabel(BACK_LABEL, 6_000)) {
                        touchFault("the cookies level did not come back into the tree after the confirm")
                    } else if (!awaitGone("Clear cookies", 15_000)) {
                        touchFault("the touch on the confirm's 'Confirm clear cookies' left the Clear cookies row: the jar was not cleared")
                    }
                }
                SystemClock.sleep(800)
                shot("06-cookies-cleared")
            }
            awaitRest()
            tapLabel(f, BACK_LABEL)
            SystemClock.sleep(1_200)
        }

        // 4. Permissions: reset the remembered Location grant with the row's control.
        if (tapUntil(f, "Permissions", BACK_LABEL)) {
            SystemClock.sleep(1_800)
            shot("07-permissions")
            if (tapLabel(f, "Reset Location permission")) {
                SystemClock.sleep(3_500)
                shot("08-permission-reset")
            }
            // The system back gesture pops the level before it dismisses the sheet.
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(1_500)
        }

        // 5. Drag the sheet away by its grabber: peek it down, hold, then let it go.
        dragSheetAway(f)
        SystemClock.sleep(3_000)

        // 6. The neighbours, for comparison: the tab overview, then Settings.
        if (tapLabel(f, "Tabs (2)")) {
            SystemClock.sleep(2_500)
            shot("09-overview")
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(2_000)
        }
        if (tapLabel(f, "Menu")) {
            SystemClock.sleep(1_800)
            // Settings sits low in the menu: pull the sheet up to its full detent, then scroll.
            repeat(2) {
                f.down(width / 2f, height * 0.8f)
                f.moveBy(0f, -0.45f * height, 500)
                f.hold(150)
                f.up()
                SystemClock.sleep(1_200)
            }
            // A comparison shot, not asserted: the tree's bounds for a row of the scrolled menu
            // lag on the emulator, so this finger may miss; the sheet under test is the one above.
            if (tapLabel(f, "Settings")) {
                SystemClock.sleep(2_500)
                shot("10-settings")
                ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                SystemClock.sleep(1_500)
            }
        }

        File(out, "done").writeText("done\n")
        SystemClock.sleep(3_000)
    }

    /** The sheet reads the site before it shows; give a slow page time before the first shot. */
    private fun awaitSheet() {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (findByLabel(GRIP_LABEL) == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        Log.i(TAG, if (findByLabel(GRIP_LABEL) != null) "sheet is up" else "sheet never appeared")
    }

    /**
     * The confirm level's keyboard contract (§9.22 as §10.4 applies it to a level; W5-17 seed 55),
     * with the level up from a real touch on the Clear cookies row: the level's container holds
     * the focus on entry and no verb is preselected; Enter from it is inert – the question is
     * destructive, so no default – and the level stands; Tab reaches Cancel, then the danger verb
     * (the shot with the ring on it); Shift+Tab steps back to Cancel; Escape is one hop back to
     * the row that asked, which takes the keyboard again. The keys go in as a hardware keyboard's
     * (`pressKey`); the document's focus is read through the chrome's bridge (`focused`), the
     * tree's labels as everywhere else. Every wrong answer is a key fault the run fails on once
     * the recording is done; a level Escape did not pop is cancelled by touch so the run goes on.
     */
    private fun confirmKeyboard(f: Finger) {
        awaitRest()
        val entry = focused()
        if (entry?.optString("level") != "clear-cookies" || entry.optString("tag") != "SECTION") {
            keyFault("on entry the focus is not the confirm level's container but $entry")
        }
        pressKey(KeyEvent.KEYCODE_ENTER)
        SystemClock.sleep(700)
        if (findByLabel("Confirm clear cookies") == null) {
            keyFault("Enter from the container answered the destructive question: the level went")
        } else if (focused()?.optString("tag") != "SECTION") {
            keyFault("Enter moved the focus off the container to ${focused()}")
        }
        pressKey(KeyEvent.KEYCODE_TAB)
        val first = focused()
        if (first?.optString("action") != "cancel") keyFault("Tab from the container did not reach Cancel but $first")
        pressKey(KeyEvent.KEYCODE_TAB)
        val second = focused()
        if (second?.optString("action") != "confirm") keyFault("Tab from Cancel did not reach the verb but $second")
        SystemClock.sleep(600)
        shot("05b-confirm-verb-focused")
        pressKey(KeyEvent.KEYCODE_TAB, shift = true)
        val back = focused()
        if (back?.optString("action") != "cancel") keyFault("Shift+Tab from the verb did not return to Cancel but $back")
        pressKey(KeyEvent.KEYCODE_ESCAPE)
        if (!awaitGone("Confirm clear cookies", 6_000)) {
            keyFault("Escape did not pop the confirm level")
            tapLabel(f, "Cancel")
            awaitGone("Confirm clear cookies", 6_000)
        } else if (!awaitLabel(BACK_LABEL, 6_000)) {
            keyFault("the cookies level did not come back into the tree after Escape")
        } else {
            val home = focused()
            if (home?.optString("level") != "cookies" || home.optString("text")?.startsWith("Clear cookies") != true) {
                keyFault("Escape did not return the keyboard to the Clear cookies row but to $home")
            }
        }
        awaitRest()
    }

    /**
     * The chrome document's active element: the level it stands in (`data-level` of the nearest
     * pane), its tag, its `data-action` (a confirm level's Cancel or verb), its name and its text;
     * null when nothing has the focus or the chrome did not answer.
     */
    private fun focused(): JSONObject? {
        val raw = chromeJs(
            "(function(){var e=document.activeElement;if(!e||e===document.body)return null;var p=e.closest('[data-level]');" +
                "return JSON.stringify({level:p?p.getAttribute('data-level'):null,tag:e.tagName,action:e.getAttribute('data-action'),role:e.getAttribute('role')," +
                "label:e.getAttribute('aria-label'),text:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)})})()"
        )
        val text = runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    /** Evaluate in the chrome WebView; the raw JSON-encoded result ("" when it never answered). */
    private fun chromeJs(code: String): String {
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

    /** A key as a hardware keyboard sends it, down then up, Shift held round it when asked. */
    private fun pressKey(keyCode: Int, shift: Boolean = false) {
        val meta = if (shift) KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON else 0
        if (shift) injectKey(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT, meta)
        injectKey(KeyEvent.ACTION_DOWN, keyCode, meta)
        injectKey(KeyEvent.ACTION_UP, keyCode, meta)
        if (shift) injectKey(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT, 0)
        SystemClock.sleep(400)
    }

    private fun injectKey(action: Int, keyCode: Int, meta: Int) {
        val now = SystemClock.uptimeMillis()
        val event = KeyEvent(now, now, action, keyCode, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
        if (!ui.injectInputEvent(event, true)) Log.w(TAG, "the ${KeyEvent.keyCodeToString(keyCode)} ${if (action == KeyEvent.ACTION_DOWN) "down" else "up"} was not injected")
        SystemClock.sleep(30)
    }

    /** The site icon sits at the start of the pill; the accessibility tree knows it by its label. */
    private fun tapSiteIcon(f: Finger) {
        val icon = findAllByLabel(SITE_ICON_LABEL).filter { it.top > height * 0.6 }.minByOrNull { it.width() * it.height() }
        if (icon != null) {
            f.tap(icon.exactCenterX(), icon.exactCenterY())
        } else {
            Log.w(TAG, "site icon not in the accessibility tree; tapping the start of the pill")
            f.tap(pill.left + 22 * density, pill.exactCenterY())
        }
    }

    /**
     * Tap `label` and wait for `expected` to appear; a tap the WebView let pass as a scroll or a
     * settling sheet swallowed is tried again, a little higher in the row, up to three times.
     * The sheet's injected touch, its result asserted (the rule in DemoHarness): three touches
     * on the row with `expected` never up is a fault of the run – the sheet did not take the
     * finger – reported once the recording is done. No touch goes in for a row that is not there.
     */
    private fun tapUntil(f: Finger, label: String, expected: String): Boolean {
        var touched = 0
        repeat(3) { attempt ->
            awaitRest()
            val target = findByLabel(label) ?: run {
                Log.w(TAG, "no node labelled '$label'")
                return false
            }
            val y = target.top + target.height() * (0.5f - 0.15f * attempt)
            Log.i(TAG, "tap '$label' (attempt ${attempt + 1}) at ${target.exactCenterX()},$y")
            f.tap(target.exactCenterX(), y)
            touched++
            val deadline = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (findByLabel(expected) != null) return true
                SystemClock.sleep(250)
            }
        }
        touchFault("$touched touch(es) on the sheet's '$label' row brought no '$expected'")
        return false
    }

    /**
     * The chassis catches a touch that lands on a sheet in motion and swallows its click; the
     * emulator's software GPU makes a spring take seconds. Wait until the grabber has held its
     * place for two readings in a row before tapping anything inside the sheet.
     */
    private fun awaitRest() {
        val deadline = SystemClock.uptimeMillis() + 6_000
        var last = grabber()
        var steady = 0
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(250)
            val now = grabber()
            steady = if (now == last) steady + 1 else 0
            if (steady >= 2) return
            last = now
        }
        Log.w(TAG, "sheet still moving after 6 s")
    }

    /** Wait until a node is labelled `label`, up to `timeoutMs`; false when none came. */
    private fun awaitLabel(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) != null) return true
            SystemClock.sleep(300)
        }
        return false
    }

    /** Wait until no node is labelled `label` any more, up to `timeoutMs`; false when it is still there. */
    private fun awaitGone(label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabel(label) == null) return true
            SystemClock.sleep(300)
        }
        Log.w(TAG, "'$label' still there after $timeoutMs ms")
        return false
    }

    private fun tapLabel(f: Finger, label: String): Boolean {
        if (grabber() != null) awaitRest()
        val candidates = findAllByLabel(label)
        val target = candidates.firstOrNull() ?: run {
            Log.w(TAG, "no node labelled '$label'")
            return false
        }
        Log.i(TAG, "tap '$label' at $target of ${candidates.size} candidates $candidates; names ${namesFor(label)}")
        f.tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    /**
     * The sheet's top edge and its grabber: the chassis names the handle `Dismiss`, 8 px inside
     * the sheet's top; the sheet runs from there to the bottom edge of the screen.
     */
    private fun grabber(): Rect? = findByLabel(GRIP_LABEL)

    private fun sheetTop(): Float = grabber()?.let { it.top - 8 * density } ?: (height * 0.45f)

    /** Pull the sheet up to its expanded detent so its body scrolls (the chassis locks it at the peek). */
    private fun expandSheet(f: Finger) {
        val from = sheetTop() + 120 * density
        f.down(width / 2f, from)
        f.moveBy(0f, -0.4f * height, 600)
        f.hold(200)
        f.up()
    }

    private fun dragSheetAway(f: Finger) {
        val grip = grabber()
        Log.i(TAG, "grabber $grip")
        val x = width / 2f
        val y = grip?.exactCenterY() ?: (sheetTop() + 24 * density)
        val travel = height - bottomInset - sheetTop()
        f.down(x, y)
        f.moveBy(0f, 0.18f * travel, 500)
        f.hold(500)
        f.moveBy(0f, 0.12f * travel, 300)
        f.hold(250)
        // Let go with a downward fling: the spring carries it out.
        f.moveBy(0f, 0.25f * travel, 140)
        f.up()
    }

    /** Scroll the open level's list up so its lower groups show. */
    private fun scrollSheet(f: Finger) {
        val top = sheetTop()
        val span = height - bottomInset - top
        val x = width / 2f
        f.down(x, top + 0.7f * span)
        f.moveBy(0f, -0.4f * span, 600)
        f.hold(200)
        f.up()
    }

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "siteinfo-$theme-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    private fun findByLabel(label: String): Rect? = findAllByLabel(label).firstOrNull()

    /** The names of every node that begins with `label`, for the log. */
    private fun namesFor(label: String): List<String> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<String>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            for (name in listOfNotNull(node.contentDescription?.toString(), node.text?.toString())) {
                if (name.trim().startsWith(label)) found += "${node.className}:'${name.trim()}'"
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /**
     * Breadth-first search of the active window for nodes labelled `label` (aria-label or text).
     * A row's name is its label and value together ("Connection Secure"), so a node that merely
     * starts with the label counts when nothing matches it exactly – the smallest such node, so a
     * container whose text happens to begin with a row's label never stands in for the row.
     */
    private fun findAllByLabel(label: String): List<Rect> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val exact = ArrayList<Rect>()
        val prefixed = ArrayList<Pair<Rect, Boolean>>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 8_000) {
            val node = queue.removeFirst()
            visited++
            val names = listOfNotNull(node.contentDescription?.toString(), node.text?.toString())
                .map { it.replace(Regex("\\s+"), " ").trim() }
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            // A row's own name is its label, a comma, its value ("Connection, Secure"); the WebView
            // hands a button's name over as its text, so both fields are read.
            if (names.any { it == label || it.startsWith("$label,") }) {
                exact += bounds
            } else if (names.any { it.startsWith(label) }) {
                // Only when nothing is named exactly: the pill's "Connection is secure" chip also
                // begins with "Connection", and it is smaller than the row it must not stand in for.
                val button = node.className?.toString()?.endsWith("Button") == true
                prefixed += bounds to button
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        if (exact.isNotEmpty()) return exact.sortedBy { it.width() * it.height() }
        return prefixed
            .sortedWith(compareByDescending<Pair<Rect, Boolean>> { it.second }.thenBy { it.first.width() * it.first.height() })
            .map { it.first }
    }

    /** One finger; moves are interpolated and injected in real time (see GestureDemo). */
    private inner class Finger {
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
        private const val TAG = "SiteInfoDemo"
        private const val PILL_LABEL = "Address"
        private const val SITE_ICON_LABEL = "Site information"
        private const val GRIP_LABEL = "Dismiss"
        private const val BACK_LABEL = "Back to site information"
        private const val STEP_MS = 8L
        /** Past the 8 CSS px slop at any plausible density, hardly visible on the track. */
        private const val NUDGE = 30f
        /** Long enough for the emulator's software GPU to snapshot the page before the swipe. */
        private const val STAGE_WAIT = 2_400L
    }
}
