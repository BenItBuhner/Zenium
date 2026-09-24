package app.zen.chromium

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Drives sharing out of and into the phone chrome so the `android-share-demo` workflow can record
 * it on an emulator. The browser's own share forks on the Android version (SH-02, SH-03):
 *
 * On Android 14 and later the system sheet stands (SH-02): Share from the app menu and from a
 * link's long-press menu (the system chooser with the page's title and preview), a `mailto:`, a
 * `tel:` and an `intent://` link held behind the confirm sheet (the intent's web fallback loads
 * when nothing can open it), then the share target: a text carrying a URL, a plain text and an
 * `ACTION_WEB_SEARCH`, each sent through `am start` the way `adb shell` does, with DuckDuckGo as
 * the profile's engine so the two searches prove the routing goes through the core. The seeded
 * profile shows example.com; the test runs in the app's process, so it adds its four demo links
 * (a web page, an email address, a phone number, a scanner app's `intent://`) to that page
 * through the tab's WebView and taps them where the page says they are.
 *
 * Below Android 14 the browser's share panel stands in for the system sheet (SH-03, Chrome 152's
 * sharing hub): the app menu's Share… opens the panel (its open recorded frame by frame, its
 * long tasks on the chrome's clock), the preview reads the page's title and URL, the chips are
 * Copy link, Long screenshot, Print and QR code in Chrome's order and each does its thing (the
 * clipboard holds the URL, the code dialog, the screenshot editor, the print dialog), the apps
 * row lists the fixture share target of the instrumentation APK (ShareTargetActivity, "Nimbus
 * Notes") and a tap sends it the intent direct – its window reads the URL back – and is
 * recorded, so that after a second share it leads the row; More opens the system chooser; back
 * dismisses the panel; the panel in dark; and a private tab's share, which records nothing
 * (where the image's WebView supports private tabs). Findings land in `share-findings.txt`
 * (one PASS or FAIL per claim), the frame sheets in `share-frames-open-{light,dark}.png`; a
 * failed check fails the run. On both branches the recording and the stills (`share-*.png`) are
 * the evidence for the eye.
 */
@RunWith(AndroidJUnit4::class)
class ShareDemo : DemoHarness("share-demo-state.json", "share", "share-demo") {
    override val tag = "ShareDemo"

    /** Screen positions (px) of the planted links, in `LINKS` order. */
    private var links: List<PointF> = emptyList()

    private lateinit var findings: File
    private var failures = 0

    /** Below Android 14 the browser's own share is the panel (`Share.panelStandsIn`). */
    private val panelStandsIn = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    @Test
    fun record() {
        runDemo()
        if (failures > 0) error("$failures check(s) failed; see share-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "share-findings.txt")
        findings.writeText(
            "Zenium Android share checks (API ${Build.VERSION.SDK_INT}, WebView ${webViewVersion()}, ${width}x$height, density $density)\n" +
                "the browser's own share: " +
                (if (panelStandsIn) "the share panel stands in for the system sheet below Android 14 (SH-03)" else "the system sheet (SH-02)") +
                "\n\n"
        )
        // The workflow disables Gmail to keep the emulator quiet; it is what lets the mailto: sheet
        // name the app that would open the address (and gives the panel's row a real app).
        shell("pm enable --user 0 com.google.android.gm")
        // The first menu pays for layout and compilation: open it once off camera.
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        if (panelStandsIn) {
            installProbe()
        } else {
            links = plantLinks()
            Log.i(tag, "demo links at $links")
        }
    }

    override fun demo() {
        if (panelStandsIn) panelScenes() else systemSheetScenes()
        finding("\n" + if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the share panel (below Android 14) --------------------------------------------------------

    private fun panelScenes() {
        val fixture = fixtureComponent()
        finding("== the share panel (SH-03); fixture share target $fixture")

        // 1. App menu -> Share…: the panel in the chrome, its open on record frame by frame; the
        //    preview, the chips and the apps row read off the chrome's DOM.
        val opened = openPanel(frames = "light", menuShot = "01-app-menu")
        expect("the app menu's Share… opens the share panel in the chrome", opened)
        if (!opened) {
            finding("  no panel came up: the panel's checks cannot run")
            return
        }
        SystemClock.sleep(1_200)
        shot("02-share-panel-light")
        val title = panelString(TITLE_JS)
        val url = panelString(URL_JS)
        finding("  preview: title '$title', url '$url'")
        expect("the preview shows the page's title", title == PAGE_TITLE)
        expect("the preview shows the page's URL", url == PAGE_URL)
        val chips = panelList(CHIP_KINDS_JS)
        val chipLabels = panelList(CHIP_LABELS_JS)
        finding("  chips: $chips, reading $chipLabels")
        expect("the chips are Copy link, Long screenshot, Print, QR code, in Chrome's order", chips == listOf("copy", "screenshot", "print", "qr"))
        expect("the chips read Copy link, Long screenshot, Print, QR code", chipLabels == listOf("Copy link", "Long screenshot", "Print", "QR code"))
        var apps = panelList(APPS_JS)
        finding("  apps row: $apps")
        expect("the apps row lists the fixture share target", apps.any { it == fixture })
        expect("More ends the apps row", apps.lastOrNull() == MORE_KIND)

        // 2. Copy link: the panel leaves and the clipboard holds the page's URL.
        val copiedAt = SystemClock.uptimeMillis()
        expect("Copy link dismisses the panel", tapCell(COPY_LABEL))
        val clip = awaitClipboard(PAGE_URL)
        finding("  clipboard after Copy link: '$clip'")
        expect("Copy link puts the page's URL on the clipboard", clip == PAGE_URL)
        SystemClock.sleep(800)
        shot("03-copy-link")
        // Android 13's own clipboard chip stands over the bar for a while and takes fingers.
        awaitClipboardOverlayGone(copiedAt)

        // 3. QR code: the code dialog ("Scan to open"), closed.
        if (reopen("QR code")) {
            expect("QR code dismisses the panel", tapCell(QR_LABEL))
            val dialog = waitFor(QR_TITLE, 10_000) != null
            expect("QR code opens the code dialog", dialog)
            if (dialog) {
                SystemClock.sleep(1_000)
                shot("04-qr-code")
                clickByLabel(QR_CLOSE)
                awaitTrue(5_000) { findByLabel(QR_TITLE) == null }
            }
        }

        // 4. Long screenshot: the editor with its edge handles, left by back.
        if (reopen("Long screenshot")) {
            expect("Long screenshot dismisses the panel", tapCell(SCREENSHOT_LABEL))
            val editor = waitFor(EDGE_LABEL, 15_000) != null
            expect("Long screenshot opens the screenshot editor", editor)
            if (editor) {
                SystemClock.sleep(1_200)
                shot("05-long-screenshot")
                back()
                awaitTrue(6_000) { findByLabel(EDGE_LABEL) == null }
                SystemClock.sleep(800)
            }
        }

        // 5. Print: the system's print dialog (another package's window), dismissed.
        if (reopen("Print")) {
            expect("Print dismisses the panel", tapCell(PRINT_LABEL))
            val dialog = awaitSystemWindow(15_000)
            finding("  after Print the window in front is ${ui.rootInActiveWindow?.packageName}")
            expect("Print opens the print dialog", dialog)
            if (dialog) {
                SystemClock.sleep(2_500)
                shot("06-print-dialog")
                leaveForeignWindow()
            }
        }

        // 6. An app of the row: the same intent goes direct to the fixture, whose window reads the
        //    URL back; Zenium records the choice.
        val before = historyRecord()
        if (reopen("the fixture share target")) {
            expect("a tap on the app dismisses the panel", tapTarget(fixture))
            val received = awaitFixture()
            finding("  the fixture received: '$received'")
            expect("the app received the page's URL as the share's text", received?.contains(PAGE_URL) == true)
            if (received != null) {
                SystemClock.sleep(1_000)
                shot("07-target-received")
            }
            finishFixture()
            val recorded = awaitTrue(4_000) { historyRecord() != before }
            finding("  share history after the share: ${historyRecord()}")
            expect("the share to the app is recorded in Zenium's own history", recorded)
        }

        // 7. Ranking: a second share to the fixture, then it leads the row.
        if (reopen("the ranking's second share")) {
            expect("the second share dismisses the panel", tapTarget(fixture))
            expect("the app received the second share", awaitFixture() != null)
            finishFixture()
        }
        if (reopen("the ranking")) {
            SystemClock.sleep(800)
            apps = panelList(APPS_JS)
            finding("  apps row after two shares: $apps")
            expect("the app shared to twice leads the row", apps.firstOrNull() == fixture)
            shot("08-ranking")

            // 8. More: the system chooser, another package's window.
            expect("More dismisses the panel", tapCell(MORE_LABEL))
            val chooser = awaitSystemWindow(15_000)
            val top = ui.rootInActiveWindow
            finding("  after More the window in front is ${top?.packageName} (${top?.className})")
            expect("More opens the system chooser", chooser)
            if (chooser) {
                SystemClock.sleep(3_000)
                shot("09-more-chooser")
                leaveForeignWindow()
            }
        }

        // 9. Back dismisses the panel (the predictive back's commit), and the share is let go.
        if (reopen("the back check")) {
            SystemClock.sleep(600)
            back()
            expect("back dismisses the panel", awaitTrue(6_000) { !panelUp() })
            SystemClock.sleep(800)
        }

        // 10. Dark: the same panel on the dark scheme, its open on record too.
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_000)
        val dark = openPanel(frames = "dark")
        expect("the panel opens on the dark scheme", dark)
        if (dark) {
            SystemClock.sleep(1_200)
            shot("10-share-panel-dark")
            back()
            awaitTrue(6_000) { !panelUp() }
        }
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        SystemClock.sleep(1_500)

        // 11. A private tab's share: the same panel without QR code, and nothing recorded.
        privateScene(fixture)
    }

    /** A private tab on the page, its share to the fixture; N/A where the image's WebView has no private tabs. */
    private fun privateScene(fixture: String) {
        val tabId = coreInvoke("tab.newPrivate", "{\"url\":${JSONObject.quote(PAGE_URL)}}")
        if (tabId == "null") {
            finding("  private tabs: not supported by this image's WebView (${webViewVersion()}); the private tab's share is not on this run's record (N/A)")
            return
        }
        val active = awaitTrue(15_000) {
            val tab = activeCoreTab()
            tab != null && tab.optString("containerId") == Profiles.PRIVATE_CONTAINER && tab.optString("url") == PAGE_URL
        }
        expect("a private tab opens on the page", active)
        SystemClock.sleep(3_000)
        val before = historyRecord()
        if (openPanel()) {
            SystemClock.sleep(1_200)
            val chips = panelList(CHIP_KINDS_JS)
            finding("  private panel chips: $chips")
            expect("the private tab's panel has no QR code chip", chips == listOf("copy", "screenshot", "print"))
            shot("11-private-panel")
            expect("the private tab's share dismisses the panel", tapTarget(fixture))
            expect("the app received the private tab's share", awaitFixture()?.contains(PAGE_URL) == true)
            finishFixture()
            SystemClock.sleep(2_000)
            finding("  share history after the private share: ${historyRecord()}")
            expect("a private tab's share is not recorded", historyRecord() == before)
        } else {
            expect("the private tab's Share… opens the panel", false)
        }
        coreInvoke("tab.closePrivate")
        SystemClock.sleep(1_500)
    }

    /**
     * App menu -> Share…, and the panel up: true when its sheet is in the chrome's DOM. With
     * `frames` the open goes on a frame sheet (`share-frames-open-<frames>.png`) and the probe's
     * numbers go to the findings; `menuShot` takes a still of the open menu first.
     */
    private fun openPanel(frames: String? = null, menuShot: String? = null): Boolean {
        ensureForeground()
        // A panel a failed step left up would take the menu button's touch as its scrim's.
        if (panelUp()) {
            back()
            awaitTrue(6_000) { !panelUp() }
            SystemClock.sleep(600)
        }
        openMenu()
        if (waitFor(HANDLE_LABEL, 8_000) == null) {
            finding("  the app menu did not open")
            return false
        }
        SystemClock.sleep(if (menuShot != null) 1_500 else 700)
        if (menuShot != null) shot(menuShot)
        val node = awaitNode(8_000) { it == SHARE_LABEL } ?: run {
            finding("  no $SHARE_LABEL in the app menu")
            back()
            return false
        }
        val burst = if (frames != null) FrameBurst().also { it.start() } else null
        chromeJs("window.__zenShare&&window.__zenShare.begin()")
        val touchAt = SystemClock.uptimeMillis()
        if (!touchTap(node)) {
            burst?.halt(touchAt)
            finding("  the touch on $SHARE_LABEL did not go in")
            return false
        }
        val up = awaitTrue(10_000) { panelUp() }
        val wall = SystemClock.uptimeMillis() - touchAt
        if (frames != null && burst != null) {
            SystemClock.sleep(700)
            frameSheet(frames, burst.halt(touchAt), "Share… → the share panel ($frames), API ${Build.VERSION.SDK_INT}, ${width}x$height")
        }
        noteOpen(frames ?: "again", wall, up)
        return up
    }

    /** [openPanel] for a step, with the finding when it could not. */
    private fun reopen(forStep: String): Boolean {
        val up = openPanel()
        if (!up) expect("the panel opens again for $forStep", false)
        return up
    }

    /** A real touch on the cell reading `label`; true when the panel then left. */
    private fun tapCell(label: String): Boolean =
        touchTapLabelExpecting(label, "the panel left", timeoutMs = 8_000) { !panelUp() }

    /** The row scrolled to the app's cell, then a touch on it; true when the panel then left. */
    private fun tapTarget(component: String): Boolean {
        chromeJs(
            "(function(){var c=document.querySelector('.zen-share-panel [data-component=' + JSON.stringify(${JSONObject.quote(component)}) + ']');" +
                "if(c)c.scrollIntoView({inline:'center',block:'nearest'});return !!c})()"
        )
        SystemClock.sleep(500)
        return tapCell(FIXTURE_LABEL)
    }

    private fun panelUp(): Boolean = chromeJs("!!document.querySelector('.zen-share-panel')") == "true"

    /** A string a script evaluates to in the chrome, "" when it did not answer. */
    private fun panelString(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() as? String }.getOrNull().orEmpty()

    /** A JSON array of strings a script evaluates to in the chrome. */
    private fun panelList(code: String): List<String> {
        val raw = panelString(code)
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.optString(it) }
    }

    /** The clipboard's text, polled until it reads `expected` or the time is up. */
    private fun awaitClipboard(expected: String, timeoutMs: Long = 6_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var text = clipboardText()
        while (text != expected && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            text = clipboardText()
        }
        return text
    }

    private fun clipboardText(): String? {
        var text: String? = null
        instrumentation.runOnMainSync {
            val clip = app.getSystemService(ClipboardManager::class.java)?.primaryClip
            text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
        }
        return text
    }

    /** Zenium's own share history as stored (`share-history` prefs), null when nothing was recorded. */
    private fun historyRecord(): String? =
        app.getSharedPreferences(Share.PANEL_PREFS, Context.MODE_PRIVATE).getString(Share.PANEL_PREFS_KEY, null)

    // --- the fixture share target ------------------------------------------------------------------

    /** The instrumentation APK's package: the fixture's process and window. */
    private val testPackage: String get() = instrumentation.context.packageName

    private fun fixtureComponent(): String = "$testPackage/$FIXTURE_CLASS"

    /** The fixture window's "Received: …" line, or null while it is not up. */
    private fun fixtureText(): String? =
        findInWindows(testPackage) { it.startsWith(RECEIVED_PREFIX) }?.let { (it.text ?: it.contentDescription)?.toString() }

    private fun awaitFixture(timeoutMs: Long = 12_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            fixtureText()?.let { return it }
            SystemClock.sleep(200)
        }
        return fixtureText()
    }

    /** The fixture's Done (back when its window is not there), then Zenium in front again. */
    private fun finishFixture() {
        val done = findInWindows(testPackage) { it == FIXTURE_DONE }
        if (done != null) done.performAction(AccessibilityNodeInfo.ACTION_CLICK) else back()
        SystemClock.sleep(1_500)
        ensureForeground()
        SystemClock.sleep(800)
    }

    /** Back out of another package's window (a dialog, the chooser), then Zenium in front. */
    private fun leaveForeignWindow() {
        var tries = 0
        while (tries++ < 3 && ui.rootInActiveWindow?.packageName?.toString().let { it != null && it != app.packageName }) {
            back()
            SystemClock.sleep(1_500)
        }
        ensureForeground()
        SystemClock.sleep(800)
    }

    // --- the open's record -------------------------------------------------------------------------

    /**
     * The probe in the chrome (test-only): long tasks (`PerformanceObserver`, 50 ms and over), the
     * tap's `pointerup` and the moment the panel's sheet is mounted (a MutationObserver on the
     * body), all on the chrome's clock. Reads nothing that forces a style pass; nothing is
     * written into the product.
     */
    private fun installProbe() {
        chromeJs(
            """(function(){if(window.__zenShare)return;var P=window.__zenShare={long:[],marks:[]};
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.long.push({t:e.startTime,d:e.duration})})}).observe({type:'longtask'})}catch(_){}
function isPanel(n){return n.matches('.zen-share-panel')||!!n.querySelector('.zen-share-panel')}
try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var a=ms[i].addedNodes;for(var j=0;j<a.length;j++){var n=a[j];if(n.nodeType===1&&isPanel(n))P.marks.push({t:performance.now(),n:'panel-mounted'})}}}).observe(document.body,{childList:true,subtree:true})}catch(_){}
document.addEventListener('pointerup',function(){P.marks.push({t:performance.now(),n:'pointerup'})},{capture:true,passive:true});
P.begin=function(){P.long=[];P.marks=[]};
P.end=function(){return JSON.stringify({long:P.long,marks:P.marks})}})()"""
        )
    }

    /** The open's numbers into the findings: wall time, the chrome's clock from the tap to the mount, the long tasks on the way. */
    private fun noteOpen(scene: String, wallMs: Long, up: Boolean) {
        val raw = panelString("window.__zenShare?window.__zenShare.end():''")
        val json = runCatching { JSONObject(raw) }.getOrNull()
        if (json == null) {
            finding("  open ($scene): ${if (up) "$wallMs ms from the touch to the panel (wall)" else "no panel within $wallMs ms"}; no probe record")
            return
        }
        var tap: Double? = null
        var mounted: Double? = null
        val marks = json.optJSONArray("marks") ?: JSONArray()
        for (i in 0 until marks.length()) {
            val mark = marks.getJSONObject(i)
            when (mark.optString("n")) {
                "pointerup" -> if (tap == null) tap = mark.optDouble("t")
                "panel-mounted" -> if (mounted == null) mounted = mark.optDouble("t")
            }
        }
        val long = json.optJSONArray("long") ?: JSONArray()
        var count = 0
        var longest = 0.0
        var total = 0.0
        for (i in 0 until long.length()) {
            val entry = long.getJSONObject(i)
            val at = entry.optDouble("t")
            val duration = entry.optDouble("d")
            // The tasks from the tap on (a task the tap landed in counts).
            if (tap == null || at + duration >= tap) {
                count++
                total += duration
                longest = max(longest, duration)
            }
        }
        val chromeClock = if (tap != null && mounted != null) "${(mounted - tap).roundToInt()} ms from the tap's pointerup to the sheet's mount on the chrome's clock" else "no mount mark on the chrome's clock"
        finding(
            "  open ($scene): ${if (up) "$wallMs ms from the touch to the panel (wall)" else "no panel within $wallMs ms"}; $chromeClock; " +
                "long tasks from the tap: $count (longest ${longest.roundToInt()} ms, together ${total.roundToInt()} ms)"
        )
    }

    /**
     * Screenshots as fast as the emulator hands them out, from [start] until [halt]: the open of
     * the panel frame by frame for the sheet ([frameSheet]), each stamped with its time since the
     * touch (a frame before it reads negative).
     */
    private inner class FrameBurst : Thread("share-frame-burst") {
        private val frames = ArrayList<Pair<Long, Bitmap>>()
        @Volatile private var running = true
        private var t0 = 0L

        override fun start() {
            t0 = SystemClock.uptimeMillis()
            super.start()
        }

        override fun run() {
            while (running && frames.size < MAX_FRAMES) {
                val began = SystemClock.uptimeMillis()
                val grab = runCatching { ui.takeScreenshot() }.getOrNull()
                if (grab != null) {
                    val at = SystemClock.uptimeMillis() - t0
                    val thumb = Bitmap.createScaledBitmap(grab, max(1, grab.width / THUMB_SCALE), max(1, grab.height / THUMB_SCALE), true)
                    if (thumb !== grab) grab.recycle()
                    synchronized(frames) { frames += at to thumb }
                }
                val spent = SystemClock.uptimeMillis() - began
                if (spent < FRAME_PERIOD_MS) SystemClock.sleep(FRAME_PERIOD_MS - spent)
            }
        }

        /** Stop, and the frames with their times relative to `touchAt`. */
        fun halt(touchAt: Long): List<Pair<Long, Bitmap>> {
            running = false
            join(8_000)
            val shift = touchAt - t0
            return synchronized(frames) { frames.map { (it.first - shift) to it.second } }
        }
    }

    /** `share-frames-open-<scene>.png`: the burst's thumbnails in rows, each captioned with its time since the touch. */
    private fun frameSheet(scene: String, frames: List<Pair<Long, Bitmap>>, caption: String) {
        if (frames.isEmpty()) {
            finding("  no frames were grabbed for $scene")
            return
        }
        val thumbWidth = frames.first().second.width
        val thumbHeight = frames.first().second.height
        val columns = minOf(SHEET_COLUMNS, frames.size)
        val rows = (frames.size + columns - 1) / columns
        val pad = 10
        val label = 28
        val header = 44
        val sheet = Bitmap.createBitmap(
            max(pad + columns * (thumbWidth + pad), 900),
            header + pad + rows * (thumbHeight + label + pad),
            Bitmap.Config.ARGB_8888
        )
        val canvas = Canvas(sheet)
        canvas.drawColor(0xFF15141A.toInt())
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 22f }
        val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB8B7C0.toInt(); textSize = 16f }
        canvas.drawText("$caption · ${frames.size} frames", pad.toFloat(), 30f, text)
        frames.forEachIndexed { i, (at, thumb) ->
            val x = pad + (i % columns) * (thumbWidth + pad)
            val y = header + pad + (i / columns) * (thumbHeight + label + pad)
            canvas.drawBitmap(thumb, x.toFloat(), y.toFloat(), null)
            canvas.drawText("${if (at >= 0) "+" else ""}$at ms", x.toFloat(), (y + thumbHeight + 20).toFloat(), small)
        }
        File(out, "share-frames-open-$scene.png").outputStream().use { sheet.compress(Bitmap.CompressFormat.PNG, 100, it) }
        sheet.recycle()
        for (frame in frames) frame.second.recycle()
        finding("  frames of the open ($scene): ${frames.size} on share-frames-open-$scene.png, ${frames.first().first}..${frames.last().first} ms")
    }

    private fun webViewVersion(): String = runCatching { WebView.getCurrentWebViewPackage()?.versionName }.getOrNull() ?: "?"

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the system sheet (Android 14 and later) ---------------------------------------------------

    private fun systemSheetScenes() {
        val f = Finger()
        finding("== the system sheet (SH-02)")

        // 1. App menu -> Share…: the system chooser, titled with the page and previewing it.
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            shot("01-app-menu")
            // The menu flow's injected touch (the rule in DemoHarness): the system's chooser,
            // another package's window, must come in front on it.
            if (touchTapLabelExpecting("Share…", "the system chooser is in front", timeoutMs = 8_000) {
                    ui.rootInActiveWindow?.packageName?.toString().let { it != null && it != app.packageName }
                }
            ) {
                // The panel is for Android below 14: here the system sheet stands as it did.
                expect("the app menu's Share… opens the system sheet, no panel in the chrome (SH-02)", !panelUp())
                SystemClock.sleep(4_000)
                shot("02-share-chooser")
            } else {
                Log.w(tag, "no chooser for Share… under a finger")
                expect("the app menu's Share… opens the system sheet (SH-02)", false)
            }
            dismiss()
        }

        // 2. A link's long-press menu -> Share Link…: the chooser again, for the link.
        link(LINK_WEB)?.let { p ->
            f.press(p.x, p.y)
            f.up()
            SystemClock.sleep(2_500)
            shot("03-link-menu")
            if (clickByLabel("Share Link…")) {
                SystemClock.sleep(5_000)
                shot("04-share-link-chooser")
            } else {
                Log.w(tag, "no Share Link… in the link menu")
            }
            dismiss()
        }

        // 3. mailto: -> "Open in Gmail?" with Always allow; declined, nothing is remembered.
        link(LINK_MAIL)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("05-mailto-sheet")
                // The prompt sheet's injected touch: the Always allow switch under a finger must
                // read checked afterwards (a touch through to the scrim closes the sheet instead).
                if (!touchTapLabelExpecting(ALWAYS_LABEL, "the $ALWAYS_LABEL switch is on") { findNode { it == ALWAYS_LABEL }?.isChecked == true }) {
                    clickByLabel(ALWAYS_LABEL)
                }
                SystemClock.sleep(1_200)
                shot("06-mailto-always")
                clickByLabel(DECLINE_LABEL)
            } else {
                Log.w(tag, "no confirm sheet for mailto:")
                shot("05-mailto-no-sheet")
            }
            SystemClock.sleep(2_000)
        }

        // 4. tel: -> "Open in Phone?", declined.
        link(LINK_TEL)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("07-tel-sheet")
                clickByLabel(DECLINE_LABEL)
            } else {
                Log.w(tag, "no confirm sheet for tel:")
                shot("07-tel-no-sheet")
            }
            SystemClock.sleep(2_000)
        }

        // 5. intent:// for an app that is not installed -> "Open in another app?"; opening finds
        //    nothing, so the link's browser_fallback_url loads in the tab.
        link(LINK_INTENT)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("08-intent-sheet")
                clickByLabel(OPEN_LABEL)
                SystemClock.sleep(5_000)
                shot("09-intent-fallback")
            } else {
                Log.w(tag, "no confirm sheet for intent://")
                SystemClock.sleep(4_000)
                shot("08-intent-no-sheet")
            }
        }

        // 6. Share target, as another app would send it: a URL inside text opens as a tab; plain
        //    text and a web search go to the profile's engine (DuckDuckGo, not the hard-coded one).
        send("Worth a read: https://en.wikipedia.org/wiki/Damping")
        SystemClock.sleep(7_000)
        shot("10-send-url")
        send("hyper text coffee pot control protocol")
        SystemClock.sleep(7_000)
        shot("11-send-text-duckduckgo")
        webSearch("zenium browser share target")
        SystemClock.sleep(7_000)
        shot("12-web-search-duckduckgo")
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        ensureForeground()
        val button = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
    }

    /** Where the menu button is when the accessibility tree does not say: rightmost in the bar. */
    private fun computedMenuButton() = Rect(
        (width - 52 * density).toInt(), (pill.centerY() - 22 * density).toInt(),
        (width - 8 * density).toInt(), (pill.centerY() + 22 * density).toInt()
    )

    /** Take down whatever a step left up: another app's window (the chooser), then an open menu. */
    private fun dismiss() {
        val top = ui.rootInActiveWindow?.packageName?.toString()
        if (top != null && top != app.packageName) {
            back()
            SystemClock.sleep(2_000)
        }
        if (findByLabel(HANDLE_LABEL) != null) {
            back()
            SystemClock.sleep(1_500)
        }
        SystemClock.sleep(500)
    }

    private fun link(index: Int): PointF? = links.getOrNull(index).also {
        if (it == null) Log.w(tag, "demo link $index was not planted")
    }

    /** `am start` of the share intent another app would send, through the shell like adb does. */
    private fun send(text: String) {
        val out = shell(
            "am start -a android.intent.action.SEND -t text/plain " +
                "--es android.intent.extra.TEXT ${quote(text)} -p ${app.packageName}"
        )
        Log.i(tag, "am start SEND: ${out.trim()}")
    }

    private fun webSearch(query: String) {
        val out = shell("am start -a android.intent.action.WEB_SEARCH --es query ${quote(query)} -p ${app.packageName}")
        Log.i(tag, "am start WEB_SEARCH: ${out.trim()}")
    }

    // --- the page --------------------------------------------------------------------------------

    /** The tab's WebView that is on screen (the test shares the app's process and its views). */
    private fun pageWebView(): TabWebView? {
        var found: TabWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is TabWebView && view.isShown) {
                    found = view
                    return
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /** Add the demo links to the page (once it is there) and return where they are on screen. */
    private fun plantLinks(): List<PointF> {
        val web = pageWebView() ?: run {
            Log.w(tag, "no tab WebView on screen")
            return emptyList()
        }
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (evalJs(web, PAGE_STATE_JS) != "example.com:complete" && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        val origin = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(origin) }
        val text = evalJs(web, PLANT_LINKS_JS) ?: run {
            Log.w(tag, "planting the links returned nothing")
            return emptyList()
        }
        val array = JSONArray(text)
        return (0 until array.length()).map { i ->
            val point = array.getJSONObject(i)
            PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
        }
    }

    /** The string a script evaluates to in the page, or null when it did not answer in time. */
    private fun evalJs(web: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        // evaluateJavascript hands the value back as a JSON literal: a quoted string here.
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    private fun quote(text: String) = "'" + text.replace("'", "'\\''") + "'"

    companion object {
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"
        private const val DECLINE_LABEL = "Not now"
        private const val OPEN_LABEL = "Open"
        private const val ALWAYS_LABEL = "Always allow"
        private const val SHARE_LABEL = "Share…"

        /** The seeded profile's active tab, as the panel's preview shows it. */
        private const val PAGE_TITLE = "Example Domain"
        private const val PAGE_URL = "https://example.com/"

        // The panel's cells read their captions (`SharePanelSheet`), the code dialog and the
        // editor their own labels (`Share.showQrCode`, `LongScreenshotSheet`).
        private const val COPY_LABEL = "Copy link"
        private const val SCREENSHOT_LABEL = "Long screenshot"
        private const val PRINT_LABEL = "Print"
        private const val QR_LABEL = "QR code"
        private const val MORE_LABEL = "More"
        private const val MORE_KIND = "more"
        private const val QR_TITLE = "Scan to open"
        private const val QR_CLOSE = "Close"
        private const val EDGE_LABEL = "Top edge"

        /** The fixture share target of the instrumentation APK (ShareTargetActivity.java, its manifest entry). */
        private const val FIXTURE_CLASS = "app.zen.chromium.ShareTargetActivity"
        private const val FIXTURE_LABEL = "Nimbus Notes"
        private const val FIXTURE_DONE = "Done"
        private const val RECEIVED_PREFIX = "Received:"

        // What the panel shows, read off the chrome's DOM (the sheet is `.zen-share-panel`).
        private const val TITLE_JS = "(function(){var e=document.querySelector('.zen-share-panel .zen-menu-link-title');return e?e.textContent:''})()"
        private const val URL_JS = "(function(){var e=document.querySelector('.zen-share-panel .zen-menu-link-url');return e?e.textContent:''})()"
        private const val CHIP_KINDS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"chips\"] [data-kind]'),function(b){return b.dataset.kind}))"
        private const val CHIP_LABELS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"chips\"] .zen-share-panel-caption'),function(c){return c.textContent}))"
        /** The apps row: each app's component, and `more` for the cell at its end. */
        private const val APPS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"apps\"] [data-kind]'),function(b){return b.dataset.kind==='target'?b.dataset.component:b.dataset.kind}))"

        // The frame bursts: a screenshot as often as the emulator gives one, at most this many, a fifth the size, eight to a row.
        private const val MAX_FRAMES = 24
        private const val FRAME_PERIOD_MS = 60L
        private const val THUMB_SCALE = 5
        private const val SHEET_COLUMNS = 8

        private const val LINK_WEB = 0
        private const val LINK_MAIL = 1
        private const val LINK_TEL = 2
        private const val LINK_INTENT = 3

        /** Which page is showing and whether it has finished loading. */
        private const val PAGE_STATE_JS = "location.host + ':' + document.readyState"

        /**
         * Four tall links over the page, in `LINK_*` order; returns their centres in device
         * pixels relative to the WebView (CSS px through the visual viewport and the pixel ratio).
         */
        private val PLANT_LINKS_JS = """
            (function () {
              var box = document.createElement('div');
              box.style.cssText = 'position:fixed;left:16px;right:16px;top:34%;display:flex;flex-direction:column;gap:12px;' +
                'z-index:2147483647;font:600 18px/1.3 system-ui,sans-serif';
              var specs = [
                ['https://en.wikipedia.org/wiki/Damping', 'Damping on Wikipedia'],
                ['mailto:hello@example.com?subject=Zenium', 'Email hello@example.com'],
                ['tel:+15550100', 'Call +1 555 0100'],
                ['intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;' +
                  'S.browser_fallback_url=https%3A%2F%2Fexample.org%2F;end', 'Scan a code in the scanner app']
              ];
              specs.forEach(function (spec) {
                var a = document.createElement('a');
                a.href = spec[0];
                a.textContent = spec[1];
                a.style.cssText = 'display:block;padding:20px 18px;border-radius:14px;background:#fff;color:#1d1d2c;' +
                  'text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.14)';
                box.appendChild(a);
              });
              document.body.appendChild(box);
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var dx = vv ? vv.offsetLeft : 0;
              var dy = vv ? vv.offsetTop : 0;
              return JSON.stringify(Array.prototype.map.call(box.children, function (a) {
                var r = a.getBoundingClientRect();
                return { x: (r.left + r.width / 2 - dx) * scale, y: (r.top + r.height / 2 - dy) * scale };
              }));
            })()
        """.trimIndent()
    }
}
