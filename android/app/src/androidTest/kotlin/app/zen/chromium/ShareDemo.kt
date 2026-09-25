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
 * On Android 14 and later the system sheet stands (SH-02): Share from the app menu (the system
 * chooser with the page's title and preview, and Zenium's own row in it – Copy link, QR code,
 * Long screenshot, Print, read off the chooser's tree in that order, the panel's chips below 14 –
 * whose Long screenshot under a finger closes the sheet and opens the chrome's long-screenshot
 * editor over the page, as the panel's chip does) and from a link's long-press menu, a `mailto:`, a
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
 * Copy link, QR code, Long screenshot, Print in the Android 14 action row's order (§9.38; one
 * order for one object on both paths) and each does its thing (the clipboard holds the URL, the
 * code dialog, the screenshot editor, the print dialog), the chips row stands above the hairline
 * and the apps row under it nearest the thumb, the apps row lists the fixture share target of
 * the instrumentation APK (ShareTargetActivity, "Nimbus Notes") and a tap sends it the intent
 * direct – its window reads the URL back – and is recorded, so that after a second share it
 * leads the row; More opens the system chooser; back dismisses the panel; a selection's share
 * (the toolbar's Share as the host sends it: the selected text leads the preview on two lines,
 * the page's link beneath with the highlight's `#:~:text=` directive left off the displayed line
 * – the share keeps it, as the fixture reads back – Copy text and Long screenshot the chips) and
 * an image's (a planted picture's long-press menu → Share Image…: the picture itself in the
 * preview, Copy image the one chip); the three panels in dark; and a private tab's share, whose
 * panel draws every chip, QR code with them, and which records nothing (where the image's
 * WebView supports private tabs). Findings land in `share-findings.txt`
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
        // The first menu pays for layout and compilation: open it once off camera. Its leave can
        // take seconds behind that first layout and the blocking engine's boot-time snapshot (3 s
        // on the first proof run's API 34 emulator), and the page's view is not on screen until
        // it has left: the host's word on the surface is waited for, not a fixed pause.
        openMenu()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
            if (!awaitSurface(false, 15_000)) Log.w(tag, "the warm-up menu is still up after 15 s")
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
        awaitPanelRest()
        shot("02-share-panel-light")
        val title = panelString(TITLE_JS)
        val url = panelString(URL_JS)
        finding("  preview: title '$title', url '$url'")
        expect("the preview shows the page's title", title == PAGE_TITLE)
        expect("the preview shows the page's URL", url == PAGE_URL)
        val chips = panelList(CHIP_KINDS_JS)
        val chipLabels = panelList(CHIP_LABELS_JS)
        finding("  chips: $chips, reading $chipLabels")
        expect("the chips are Copy link, QR code, Long screenshot, Print, in the Android 14 action row's order", chips == PAGE_CHIPS)
        expect("the chips read Copy link, QR code, Long screenshot, Print", chipLabels == ROW_LABELS)
        expectRowsFromTheSubjectDown("")
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

        // 4. Long screenshot: the editor with the page's picture, left by back. The capture waits
        // for the page view to be back on the screen under the sheet's cover, then the host
        // stitches the page out of the window (a software GPU's frames): the editor gets the
        // stitch's own budget. The editor is read off the chrome's DOM, as ShareScreenshotDemo
        // reads its Capture more (the sheet, then its picture); the edge handles, which the
        // chassis draws once it has measured the sheet's rest, go on record in the DOM and the
        // tree without being the check (SH-08's, not the panel's). A miss records what came
        // instead – the chrome's toast and whether a page view is shown at all.
        if (reopen("Long screenshot")) {
            expect("Long screenshot dismisses the panel", tapCell(SCREENSHOT_LABEL))
            val asked = SystemClock.uptimeMillis()
            val editor = awaitTrue(LONG_CAPTURE_WAIT_MS) { chromeJs(EDITOR_SHEET_JS) == "true" }
            if (editor) {
                val came = SystemClock.uptimeMillis() - asked
                val picture = awaitTrue(10_000) { chromeJs(EDITOR_PICTURE_JS) == "true" }
                val handles = awaitTrue(5_000) { chromeJs(EDITOR_HANDLES_JS) == "true" }
                val edge = handles && waitFor(EDGE_LABEL, 5_000) != null
                finding(
                    "  the editor came $came ms after the touch; its picture is ${if (picture) "in" else "not in"}; " +
                        "its handles are ${if (handles) "in the DOM" else "not in the DOM (the chassis has not published the sheet's rest)"}" +
                        if (handles) ", and the tree ${if (edge) "reads" else "does not read"} '$EDGE_LABEL'" else ""
                )
            } else {
                val toast = chromeJsString("(document.querySelector('.zen-toast')||{}).textContent||''")
                val page = if (pageWebView() != null) "a page view is shown" else "no page view is shown"
                finding("  no editor after $LONG_CAPTURE_WAIT_MS ms; the chrome's toast reads '${toast ?: ""}'; $page")
            }
            SystemClock.sleep(1_200)
            shot("05-long-screenshot")
            expect("Long screenshot opens the screenshot editor", editor)
            if (editor) {
                back()
                awaitTrue(6_000) { chromeJs(EDITOR_SHEET_JS) != "true" }
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

        // 10. A selection's share: the panel for the selected text, its link to the highlight
        //     beneath; then an image's: the panel for the picture. Light here, dark below.
        selectionScene("light")
        imageScene("light")

        // 11. Dark: the same three panels on the dark scheme, the page's open on record too.
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(2_000)
        val dark = openPanel(frames = "dark")
        expect("the panel opens on the dark scheme", dark)
        if (dark) {
            awaitPanelRest()
            shot("10-share-panel-dark")
            expectRowsFromTheSubjectDown(" (dark)")
            back()
            awaitTrue(6_000) { !panelUp() }
        }
        selectionScene("dark")
        imageScene("dark")
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        SystemClock.sleep(1_500)

        // 12. A private tab's share: the same panel, every chip drawn, and nothing recorded.
        privateScene(fixture)
    }

    /**
     * The sheet reads from its subject down (§9.38): the preview, then the chips row, then the
     * hairline, then the ranked apps row nearest the thumb – in the DOM and on the screen, the
     * chips row's bottom above the apps row's top.
     */
    private fun expectRowsFromTheSubjectDown(suffix: String) {
        val rows = runCatching { JSONArray(panelString(ROWS_JS)) }.getOrNull()
        val names = rows?.let { r -> (0 until r.length()).map { r.optJSONObject(it)?.optString("row").orEmpty() } }.orEmpty()
        val tops = rows?.let { r -> (0 until r.length()).map { r.optJSONObject(it)?.optDouble("top") ?: Double.NaN } }.orEmpty()
        val bottoms = rows?.let { r -> (0 until r.length()).map { r.optJSONObject(it)?.optDouble("bottom") ?: Double.NaN } }.orEmpty()
        finding("  rows from the subject down: $names, tops $tops")
        expect("the rows are the preview, the chips, the hairline, the apps, in that order$suffix", names == listOf("preview", "chips", "sep", "apps"))
        expect(
            "the chips row stands above the hairline and the apps row under it, nearest the thumb$suffix",
            names.size == 4 && bottoms[0] <= tops[1] + 1 && bottoms[1] <= tops[2] + 1 && bottoms[2] <= tops[3] + 1
        )
    }

    /**
     * A selection's share through the panel (SH-11's text and highlight link, SH-03's sheet): the
     * page's first paragraph selected through the tab's WebView, then the floating toolbar's Share
     * as the host sends it – the `selection.action` event `TabWebView` sends for a touch on that
     * item (`SelectionToolbar.action`; SelectionDemo drives the system's toolbar itself, SH-10) –
     * so the core's `shareSelection` reads the selection back for the link to its highlight and
     * shares the text with it, and the host puts the panel up for the two. The preview leads with
     * the text, on two lines at most, the page's link beneath with the highlight's `#:~:text=`
     * directive left off the displayed line (§9.38; `displayedLink`), and no favicon; the chips
     * are Copy text and Long screenshot. Light: Copy text puts the selection on the clipboard.
     * Dark: the share to the fixture, whose window reads the text back with the whole highlight
     * link under it – what is shared keeps the directive the line leaves off.
     */
    private fun selectionScene(scheme: String) {
        finding("== a selection's share ($scheme)")
        val selected = openSelectionPanel()
        expect("a selection's share opens the panel ($scheme)", selected != null && panelUp())
        if (selected == null || !panelUp()) return
        awaitPanelRest()
        shot("12-selection-panel-$scheme")
        val title = panelString(TITLE_JS)
        val url = panelString(URL_JS)
        val lines = panelString(TITLE_LINES_JS)
        finding("  preview: first line '${title.take(80)}${if (title.length > 80) "…" else ""}' (${title.length} characters), second line '$url'; the first line's box: $lines")
        expect("the preview leads with the selected text ($scheme)", title == selected.trim())
        expect("the page's link is the line beneath, the highlight's #:~:text= left off it ($scheme)", url == PAGE_URL)
        expect("a selection's preview has no favicon ($scheme)", chromeJs(FAVICON_JS) == "false")
        val box = runCatching { JSONObject(lines) }.getOrNull()
        if (box != null) {
            val height = box.optDouble("h")
            val lineHeight = box.optDouble("lh")
            val full = box.optDouble("full")
            // The clamp is the rule's (`-webkit-line-clamp: 2`) and the box at most two lines; whether
            // the text needs cutting is the page's and the panel's width – example.com's paragraph
            // fills two lines exactly on this phone – so the unclamped run is a finding, not a check.
            if (lineHeight > 0) finding("  unclamped the text runs ${(full / lineHeight).roundToInt()} line(s) of ${lineHeight.roundToInt()} px; the box is ${height.roundToInt()} px")
            expect(
                "the text is clamped to two lines ($scheme)",
                box.optString("clamp") == "2" && lineHeight > 0 && height <= 2 * lineHeight + 1 && height >= minOf(full, 2 * lineHeight) - 1
            )
        } else {
            expect("the first line's box could be read ($scheme)", false)
        }
        val chips = panelList(CHIP_KINDS_JS)
        val chipLabels = panelList(CHIP_LABELS_JS)
        finding("  chips: $chips, reading $chipLabels; apps row: ${panelList(APPS_JS)}")
        expect("a selection's chips are Copy text and Long screenshot ($scheme)", chips == listOf("copy", "screenshot") && chipLabels == listOf("Copy text", "Long screenshot"))
        if (scheme == "light") {
            val copiedAt = SystemClock.uptimeMillis()
            expect("Copy text dismisses the panel", tapCell(COPY_TEXT_LABEL))
            val clip = awaitClipboard(selected.trim())
            finding("  clipboard after Copy text: '${clip?.take(80)}'")
            expect("Copy text puts the selected text on the clipboard", clip == selected.trim())
            awaitClipboardOverlayGone(copiedAt)
        } else {
            // The displayed line leaves the directive off; the share keeps it. The fixture's window
            // reads the intent's text back: the selection, and under it the link to its highlight.
            expect("the selection's share to the app dismisses the panel", tapTarget(fixtureComponent()))
            val received = awaitFixture()
            finding("  the app received: '${received?.take(120)}${if ((received?.length ?: 0) > 120) "…" else ""}'")
            expect("the app received the selected text", received?.contains(selected.trim()) == true)
            expect("the shared link keeps the highlight's #:~:text= directive", received?.contains("$PAGE_URL#:~:text=") == true)
            finishFixture()
        }
        SystemClock.sleep(800)
    }

    /**
     * An image's share through the panel: a picture planted over the page through the tab's
     * WebView (a canvas landscape as a `data:` PNG – the page has none of its own), a long press
     * on it for the chrome's image menu and a touch on Share Image… – the core's `app.share`
     * with the image's address, which the host fetches into its cache and puts on the panel with
     * a small copy of itself as the preview. The preview is the picture and "Image" (the core
     * sends no title for one), nothing beneath; the one chip is Copy image – the chips are the
     * subject's, and the subject is the picture, not the page it sits on (§9.38).
     */
    private fun imageScene(scheme: String) {
        finding("== an image's share ($scheme)")
        val up = openImagePanel()
        expect("Share Image… opens the panel for the image ($scheme)", up)
        if (!up) return
        awaitPanelRest()
        shot("13-image-panel-$scheme")
        val title = panelString(TITLE_JS)
        val url = panelString(URL_JS)
        val thumbnail = chromeJs(THUMBNAIL_JS)
        finding("  preview: first line '$title', second line '$url', the picture ${if (thumbnail == "true") "drawn" else "not drawn"}")
        expect("the preview names the picture Image ($scheme)", title == "Image")
        expect("an image's preview has nothing beneath ($scheme)", url.isEmpty())
        expect("the preview shows the picture itself ($scheme)", thumbnail == "true")
        val chips = panelList(CHIP_KINDS_JS)
        val chipLabels = panelList(CHIP_LABELS_JS)
        val apps = panelList(APPS_JS)
        finding("  chips: $chips, reading $chipLabels; apps row: $apps")
        expect("an image's one chip is Copy image ($scheme)", chips == listOf("copy") && chipLabels == listOf("Copy image"))
        expect("More ends the image's apps row ($scheme)", apps.lastOrNull() == MORE_KIND)
        back()
        awaitTrue(6_000) { !panelUp() }
        SystemClock.sleep(800)
    }

    /**
     * The page's first paragraph selected and shared the toolbar's way ([selectionScene]): the
     * selected text when the panel came up for it, null when it did not (the finding says why).
     */
    private fun openSelectionPanel(): String? {
        ensureForeground()
        if (panelUp()) {
            back()
            awaitTrue(6_000) { !panelUp() }
            SystemClock.sleep(600)
        }
        val tabId = activeCoreTab()?.optString("id").orEmpty()
        if (tabId.isEmpty()) {
            finding("  no active tab to select in")
            return null
        }
        val web = awaitPageWebView(10_000) ?: run {
            finding("  no tab WebView on screen to select in")
            return null
        }
        val selected = evalJs(web, SELECT_PARAGRAPH_JS).orEmpty()
        finding("  selected in the page: '${selected.take(60)}${if (selected.length > 60) "…" else ""}' (${selected.length} characters)")
        if (selected.isBlank()) return null
        SystemClock.sleep(600)
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.hostEvent(
                "selection.action",
                SelectionToolbar.action(tabId, SelectionToolbar.SHARE_ID, selected, 0.5, 0.4)
            )
        }
        val up = awaitTrue(12_000) { panelUp() }
        if (!up) finding("  no panel came up for the selection within 12 s")
        return if (up) selected else null
    }

    /** A picture planted over the page, long-pressed for its menu, Share Image… touched ([imageScene]): true when the panel is up. */
    private fun openImagePanel(): Boolean {
        ensureForeground()
        if (panelUp()) {
            back()
            awaitTrue(6_000) { !panelUp() }
            SystemClock.sleep(600)
        }
        val web = awaitPageWebView(10_000) ?: run {
            finding("  no tab WebView on screen to plant the picture in")
            return false
        }
        val point = plantImage(web) ?: run {
            finding("  the picture could not be planted")
            return false
        }
        SystemClock.sleep(800)
        Finger().apply {
            press(point.x, point.y)
            up()
        }
        if (waitFor(SHARE_IMAGE_LABEL, 8_000) == null) {
            finding("  no $SHARE_IMAGE_LABEL in the picture's menu after a long press at ${point.x.toInt()},${point.y.toInt()}")
            shot("13-image-menu-missing")
            back()
            SystemClock.sleep(1_000)
            return false
        }
        SystemClock.sleep(800)
        if (!touchTapLabel(SHARE_IMAGE_LABEL) && !clickByLabel(SHARE_IMAGE_LABEL)) {
            finding("  $SHARE_IMAGE_LABEL could not be touched")
            back()
            return false
        }
        // The host fetches the picture into its cache and draws the preview off the main thread first.
        val up = awaitTrue(15_000) { panelUp() }
        if (!up) finding("  no panel came up for the picture within 15 s")
        return up
    }

    /** The demo picture in the page (planted once; found again after) and its centre on the screen. */
    private fun plantImage(web: TabWebView): PointF? {
        val text = evalJs(web, PLANT_IMAGE_JS) ?: return null
        val point = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val origin = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(origin) }
        return PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
    }

    /**
     * A private tab on the page, its share to the fixture: the panel is the public tab's panel –
     * every chip, QR code with them; private governs what is recorded, not what is shown (§9.38)
     * – and the share leaves no record. N/A where the image's WebView has no private tabs.
     */
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
            awaitPanelRest()
            val chips = panelList(CHIP_KINDS_JS)
            finding("  private panel chips: $chips")
            expect("the private tab's panel draws every chip, QR code with them", chips == PAGE_CHIPS)
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
        if (waitFor(MENU_HANDLE_LABEL, 8_000) == null) {
            finding("  the app menu did not open")
            return false
        }
        SystemClock.sleep(if (menuShot != null) 1_500 else 700)
        if (menuShot != null) shot(menuShot)
        // The menu opens at its peek detent with Share… some twenty rows below the fold, where a
        // row's bounds are off screen and no finger goes: the sheet pulled up the harness's way
        // (`openMenuItem` does the same before it drills), then the row scrolled into view.
        pullMenuUp()
        if (reveal(SHARE_LABEL) == null) {
            finding("  no $SHARE_LABEL in the app menu")
            back()
            return false
        }
        val node = awaitNode(8_000) { it == SHARE_LABEL } ?: run {
            finding("  $SHARE_LABEL is in the app menu but never came on screen")
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

    /**
     * The panel's sheet at rest: its top the same over two readings 300 ms apart, then a beat for
     * the frame. The sheet is mounted off screen and springs up from there – on the software GPU
     * well over a second – so a still taken on the mount catches it rising, its chips below the
     * fold (run 5's selection and image stills). At most `timeoutMs`; the still is taken regardless.
     */
    private fun awaitPanelRest(timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = chromeJs(PANEL_TOP_JS)
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            val top = chromeJs(PANEL_TOP_JS)
            if (top == last && top != "null") {
                SystemClock.sleep(400)
                return true
            }
            last = top
        }
        return false
    }

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
            """(function(){if(window.__zenShare)return;var P=window.__zenShare={long:[],marks:[],from:0};
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.long.push({t:e.startTime,d:e.duration})})}).observe({type:'longtask'})}catch(_){}
function isPanel(n){return n.matches('.zen-share-panel')||!!n.querySelector('.zen-share-panel')}
function isSheet(n){return n.matches('.zen-sheet')||!!n.querySelector('.zen-sheet')}
try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var a=ms[i].addedNodes;for(var j=0;j<a.length;j++){var n=a[j];if(n.nodeType===1&&isPanel(n))P.marks.push({t:performance.now(),n:'panel-mounted'})}
var r=ms[i].removedNodes;for(var k=0;k<r.length;k++){var m=r[k];if(m.nodeType===1&&isSheet(m)&&!isPanel(m))P.marks.push({t:performance.now(),n:'menu-gone'})}}}).observe(document.body,{childList:true,subtree:true})}catch(_){}
document.addEventListener('pointerup',function(){P.marks.push({t:performance.now(),n:'pointerup'})},{capture:true,passive:true});
P.begin=function(){P.long=[];P.marks=[];P.from=performance.now()};
P.end=function(){var ms=P.marks.slice();try{performance.getEntriesByType('mark').forEach(function(e){if(e.startTime>=P.from&&(e.name==='share.panel'||e.name==='share.panel.set'))ms.push({t:e.startTime,n:e.name})})}catch(_){}
ms.sort(function(a,b){return a.t-b.t});return JSON.stringify({long:P.long,marks:ms})}})()"""
        )
    }

    /**
     * The open's numbers into the findings: the wall time, and on the chrome's clock from the
     * tap's pointerup the marks on the way – the menu sheet's leave done (its DOM gone), the
     * host's request in (`share.panel`, `openSharePanel`), the sheet asked for once the page's
     * cover is captured (`share.panel.set`), the panel's DOM mounted – with the long tasks from
     * the tap and those within the panel's own open (the request in to the mount), which is the
     * panel's number: what comes before it is the menu's leave, the core's and the host's.
     */
    private fun noteOpen(scene: String, wallMs: Long, up: Boolean) {
        val raw = panelString("window.__zenShare?window.__zenShare.end():''")
        val json = runCatching { JSONObject(raw) }.getOrNull()
        if (json == null) {
            finding("  open ($scene): ${if (up) "$wallMs ms from the touch to the panel (wall)" else "no panel within $wallMs ms"}; no probe record")
            return
        }
        val first = HashMap<String, Double>()
        val marks = json.optJSONArray("marks") ?: JSONArray()
        for (i in 0 until marks.length()) {
            val mark = marks.getJSONObject(i)
            val name = mark.optString("n")
            if (!first.containsKey(name)) first[name] = mark.optDouble("t")
        }
        val tap = first["pointerup"]
        val menuGone = first["menu-gone"]
        val request = first["share.panel"]
        val asked = first["share.panel.set"]
        val mounted = first["panel-mounted"]
        val long = json.optJSONArray("long") ?: JSONArray()
        var count = 0
        var longest = 0.0
        var total = 0.0
        var ownCount = 0
        var ownLongest = 0.0
        var ownTotal = 0.0
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
            // The tasks within the panel's own open (one that runs into it counts).
            if (request != null && mounted != null && at + duration >= request && at <= mounted) {
                ownCount++
                ownTotal += duration
                ownLongest = max(ownLongest, duration)
            }
        }
        val since = { at: Double? -> if (tap != null && at != null) "+${(at - tap).roundToInt()} ms" else "no mark" }
        val own = if (request != null && mounted != null) "${(mounted - request).roundToInt()} ms" else "no reading"
        finding(
            "  open ($scene): ${if (up) "$wallMs ms from the touch to the panel (wall)" else "no panel within $wallMs ms"}; " +
                "on the chrome's clock from the tap's pointerup: the menu sheet gone at ${since(menuGone)}, the host's request in at ${since(request)}, " +
                "the sheet asked for at ${since(asked)}, the panel mounted at ${since(mounted)}; " +
                "the panel's own open (request to mount): $own, long tasks in it: $ownCount (longest ${ownLongest.roundToInt()} ms, together ${ownTotal.roundToInt()} ms); " +
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
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            shot("01-app-menu")
            // The menu opens at its peek detent with Share… below the fold: the sheet pulled up
            // (the harness's `pullMenuUp`) and the row scrolled into view first, then the menu
            // flow's injected touch (the rule in DemoHarness): the system's chooser, another
            // package's window, must come in front on it.
            pullMenuUp()
            reveal("Share…")
            if (touchTapLabelExpecting("Share…", "the system chooser is in front", timeoutMs = 8_000) {
                    ui.rootInActiveWindow?.packageName?.toString().let { it != null && it != app.packageName }
                }
            ) {
                // The panel is for Android below 14: here the system sheet stands as it did.
                expect("the app menu's Share… opens the system sheet, no panel in the chrome (SH-02)", !panelUp())
                SystemClock.sleep(4_000)
                shot("02-share-chooser")
                systemSheetRow()
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

    /**
     * Zenium's own row in the chooser (SH-02, `Share.browserRow`), with the chooser in front: the
     * four buttons read off its tree, left to right – Copy link, QR code, Long screenshot, Print,
     * the panel's chips below 14 in the panel's order (§9.38) and no "Screenshot" of the viewport
     * among them – then Long screenshot under a finger: the sheet closes, the host relays the tap
     * once it has (`Share.onBrowserAction`), and the chrome's long-screenshot editor (SH-08) opens
     * over the page, as the panel's chip opens it; back leaves it. The editor is read off the
     * chrome's DOM as the panel's scene reads it; a miss records what came instead. Leaves the
     * chooser closed either way (the caller's [dismiss] finds nothing of it left).
     */
    private fun systemSheetRow() {
        val chooser = ui.rootInActiveWindow?.packageName?.toString()
        val row: List<Pair<String, Rect>> = ROW_LABELS.mapNotNull { label -> findByLabel(label)?.let { label to it } }
        val labels = row.map { it.first }
        val lefts = row.map { it.second.left }
        val viewportShot = findByLabel(VIEWPORT_SHOT_LABEL) != null
        finding(
            "  the chooser ($chooser) reads $labels at x=$lefts" +
                "; '$VIEWPORT_SHOT_LABEL' ${if (viewportShot) "is" else "is not"} in the row"
        )
        expect(
            "the sheet's row reads Copy link, QR code, Long screenshot, Print, left to right (SH-02)",
            labels == ROW_LABELS && lefts.zipWithNext().all { (a, b) -> a < b }
        )
        expect(
            "the row's third action is Long screenshot, the panel's chip, not the viewport's Screenshot",
            labels.getOrNull(2) == SCREENSHOT_LABEL && !viewportShot
        )

        // The tap: a real touch on the chooser's button. The sheet closing is the touch's mark;
        // the accessibility click stands in when the touch does not take (the run fails on it
        // regardless, the recording goes on).
        val asked = SystemClock.uptimeMillis()
        val closed = touchTapLabelExpecting(SCREENSHOT_LABEL, "the sheet has closed", timeoutMs = 8_000) {
            ui.rootInActiveWindow?.packageName?.toString() == app.packageName
        }
        if (!closed) {
            Log.w(tag, "the row's Long screenshot under a finger did not close the sheet; an accessibility click")
            clickByLabel(SCREENSHOT_LABEL)
        }
        val editor = awaitTrue(LONG_CAPTURE_WAIT_MS) { chromeJs(EDITOR_SHEET_JS) == "true" }
        if (editor) {
            val came = SystemClock.uptimeMillis() - asked
            val picture = awaitTrue(10_000) { chromeJs(EDITOR_PICTURE_JS) == "true" }
            val handles = awaitTrue(5_000) { chromeJs(EDITOR_HANDLES_JS) == "true" }
            finding(
                "  the editor came $came ms after the touch on the row; its picture is ${if (picture) "in" else "not in"}; " +
                    "its handles are ${if (handles) "in the DOM" else "not in the DOM"}"
            )
        } else {
            val toast = chromeJsString("(document.querySelector('.zen-toast')||{}).textContent||''")
            val page = if (pageWebView() != null) "a page view is shown" else "no page view is shown"
            val top = ui.rootInActiveWindow?.packageName?.toString()
            finding("  no editor after $LONG_CAPTURE_WAIT_MS ms; the chrome's toast reads '${toast ?: ""}'; $page; the active window is $top's")
        }
        SystemClock.sleep(1_200)
        shot("02-long-screenshot-editor")
        expect("the row's Long screenshot opens the long-screenshot editor over the page (SH-02)", editor)
        if (editor) {
            back()
            awaitTrue(6_000) { chromeJs(EDITOR_SHEET_JS) != "true" }
            SystemClock.sleep(800)
        }
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * A finger on the bar's Menu button, read back and tried again when nothing came of it or
     * the bar took it as a hold (the harness's [tapMenuButton]); the callers wait for the handle.
     */
    private fun openMenu() {
        tapMenuButton()
    }

    /** Take down whatever a step left up: another app's window (the chooser), then an open menu. */
    private fun dismiss() {
        val top = ui.rootInActiveWindow?.packageName?.toString()
        if (top != null && top != app.packageName) {
            back()
            SystemClock.sleep(2_000)
        }
        if (findByLabel(MENU_HANDLE_LABEL) != null) {
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

    /** [pageWebView] polled for up to `timeoutMs`; null when no tab view is shown in that time. */
    private fun awaitPageWebView(timeoutMs: Long): TabWebView? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            pageWebView()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(250)
        }
    }

    /** Add the demo links to the page (once it is there) and return where they are on screen. */
    private fun plantLinks(): List<PointF> {
        // The view is back on screen only once the warm-up's menu has left (its leave can trail
        // the host's word on the surface by a frame or two): up to ten seconds for it.
        val web = awaitPageWebView(10_000) ?: run {
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
        private const val DECLINE_LABEL = "Not now"
        private const val OPEN_LABEL = "Open"
        private const val ALWAYS_LABEL = "Always allow"
        private const val SHARE_LABEL = "Share…"

        /** The seeded profile's active tab, as the panel's preview shows it. */
        private const val PAGE_TITLE = "Example Domain"
        private const val PAGE_URL = "https://example.com/"

        // The panel's cells read their captions (`SharePanelSheet`), the code dialog and the
        // editor their own labels (`Share.showQrCode`, `LongScreenshotSheet`); the image menu's
        // row is the core's (`Menus.imageGroup`).
        private const val COPY_LABEL = "Copy link"
        private const val COPY_TEXT_LABEL = "Copy text"
        private const val SHARE_IMAGE_LABEL = "Share Image…"
        private const val SCREENSHOT_LABEL = "Long screenshot"
        private const val PRINT_LABEL = "Print"
        private const val QR_LABEL = "QR code"
        /** The core's viewport shot's word (SH-07), which the sheet's row no longer offers. */
        private const val VIEWPORT_SHOT_LABEL = "Screenshot"
        /**
         * The one row on both paths (§9.38): Zenium's buttons in Android 14's share sheet
         * (`Share.browserRow`) and the share panel's chips below 14 (`sharePanelChips`), in order.
         */
        private val ROW_LABELS = listOf(COPY_LABEL, QR_LABEL, SCREENSHOT_LABEL, PRINT_LABEL)
        private const val MORE_LABEL = "More"
        private const val MORE_KIND = "more"
        private const val QR_TITLE = "Scan to open"
        private const val QR_CLOSE = "Close"
        private const val EDGE_LABEL = "Top edge"
        /** The stitched capture's budget on a software GPU (`ShareScreenshotDemo` allows its Capture more 40 s). */
        private const val LONG_CAPTURE_WAIT_MS = 30_000L

        /** The fixture share target of the instrumentation APK (ShareTargetActivity.java, its manifest entry). */
        private const val FIXTURE_CLASS = "app.zen.chromium.ShareTargetActivity"
        private const val FIXTURE_LABEL = "Nimbus Notes"
        private const val FIXTURE_DONE = "Done"
        private const val RECEIVED_PREFIX = "Received:"

        // What the panel shows, read off the chrome's DOM (the sheet is `.zen-share-panel`).
        private const val TITLE_JS = "(function(){var e=document.querySelector('.zen-share-panel .zen-menu-link-title');return e?e.textContent:''})()"
        private const val URL_JS = "(function(){var e=document.querySelector('.zen-share-panel .zen-menu-link-url');return e?e.textContent:''})()"
        /** The first line's box, for the two-line clamp of a selection's text: the clamp, its height, its line height, its content's height. */
        private const val TITLE_LINES_JS =
            "(function(){var t=document.querySelector('.zen-share-panel .zen-menu-link-title');if(!t)return '';var cs=getComputedStyle(t);" +
                "var w=t.getBoundingClientRect().width;var c=t.cloneNode(true);" +
                "c.style.cssText='position:absolute;visibility:hidden;display:block;-webkit-line-clamp:unset;width:'+w+'px';" +
                "t.parentNode.appendChild(c);var full=c.getBoundingClientRect().height;c.remove();" +
                "return JSON.stringify({clamp:cs.getPropertyValue('-webkit-line-clamp'),h:t.getBoundingClientRect().height,lh:parseFloat(cs.lineHeight),full:full})})()"
        /** The panel sheet's top on the chrome's viewport, rounded – null without a panel or while it is still below the viewport (mounted, not yet risen): the same twice over means the spring has settled. */
        private const val PANEL_TOP_JS =
            "(function(){var s=document.querySelector('.zen-share-panel');if(!s)return null;var t=s.getBoundingClientRect().top;return t<innerHeight?Math.round(t):null})()"
        /** Whether the preview draws a favicon slot (a page's does; a selection's does not). */
        private const val FAVICON_JS = "!!document.querySelector('.zen-share-panel .zen-menu-link-favicon')"
        /** Whether the preview draws the shared picture itself (an image's). */
        private const val THUMBNAIL_JS =
            "(function(){var i=document.querySelector('.zen-share-panel .zen-menu-link-thumbnail');return !!(i&&i.complete&&i.naturalWidth>0)})()"
        /** The page's first paragraph selected, as a finger's drag would leave it; its text back. */
        private const val SELECT_PARAGRAPH_JS =
            "(function(){var p=document.querySelector('p');if(!p)return '';var s=getSelection();s.removeAllRanges();" +
                "var r=document.createRange();r.selectNodeContents(p);s.addRange(r);return String(s)})()"
        /** The sheet's parts in document order with their boxes: the preview, the chips row, the hairline (`sep`), the apps row (§9.38's order, from the subject down). */
        private const val ROWS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel .zen-share-panel-preview,.zen-share-panel [data-row],.zen-share-panel .zen-sheet-sep'),function(e){" +
                "var r=e.getBoundingClientRect();return {row:e.dataset.row||(e.classList.contains('zen-sheet-sep')?'sep':'preview'),top:Math.round(r.top),bottom:Math.round(r.bottom)}}))"
        /** A page's chips by kind, in the Android 14 action row's order ([ROW_LABELS]; `Share.browserRow`, `sharePanelChips`). */
        private val PAGE_CHIPS = listOf("copy", "qr", "screenshot", "print")
        private const val CHIP_KINDS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"chips\"] [data-kind]'),function(b){return b.dataset.kind}))"
        private const val CHIP_LABELS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"chips\"] .zen-share-panel-caption'),function(c){return c.textContent}))"
        /** The apps row: each app's component, and `more` for the cell at its end. */
        private const val APPS_JS =
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-share-panel [data-row=\"apps\"] [data-kind]'),function(b){return b.dataset.kind==='target'?b.dataset.component:b.dataset.kind}))"
        // The long-screenshot editor as `LongScreenshotSheet.tsx` renders it (the selectors ShareScreenshotDemo reads too).
        private const val EDITOR_SHEET_JS = "document.querySelector('.zen-longshot-sheet')!=null"
        private const val EDITOR_PICTURE_JS =
            "(function(){var i=document.querySelector('[data-testid=longshot-editor] img');return !!(i&&i.complete&&i.naturalWidth>0)})()"
        private const val EDITOR_HANDLES_JS = "document.querySelector('[data-testid=longshot-handle-top]')!=null"

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
         * A picture over the page for the image's share – a canvas landscape as a `data:` PNG,
         * planted once and found again after – and its centre in device pixels relative to the
         * WebView (CSS px through the visual viewport and the pixel ratio, as PLANT_LINKS_JS).
         */
        private val PLANT_IMAGE_JS = """
            (function () {
              var img = document.getElementById('zen-demo-image');
              if (!img) {
                var c = document.createElement('canvas');
                c.width = 160;
                c.height = 100;
                var g = c.getContext('2d');
                g.fillStyle = '#8ab4f8';
                g.fillRect(0, 0, 160, 100);
                g.fillStyle = '#fde293';
                g.beginPath();
                g.arc(120, 28, 14, 0, Math.PI * 2);
                g.fill();
                g.fillStyle = '#137333';
                g.beginPath();
                g.moveTo(0, 100);
                g.lineTo(56, 50);
                g.lineTo(88, 78);
                g.lineTo(112, 62);
                g.lineTo(160, 100);
                g.closePath();
                g.fill();
                img = document.createElement('img');
                img.id = 'zen-demo-image';
                img.src = c.toDataURL('image/png');
                img.style.cssText = 'position:fixed;left:50%;top:34%;width:240px;height:150px;margin-left:-120px;' +
                  'z-index:2147483647;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.2)';
                document.body.appendChild(img);
              }
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var dx = vv ? vv.offsetLeft : 0;
              var dy = vv ? vv.offsetTop : 0;
              var r = img.getBoundingClientRect();
              return JSON.stringify({ x: (r.left + r.width / 2 - dx) * scale, y: (r.top + r.height / 2 - dy) * scale });
            })()
        """.trimIndent()

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
