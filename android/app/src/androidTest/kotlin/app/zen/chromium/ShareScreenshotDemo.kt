package app.zen.chromium

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records screenshots to the gallery and the Web Share API on a device (parity rows SH-07, SH-08,
 * SH-14, SH-11) and writes what it measured to `share-screenshot-findings.txt` next to the
 * screenshots (one `PASS` or `FAIL` per check; the test fails at the end when any check did):
 *
 *  - Take Screenshot from the app menu (a real touch): the page FLASHES – a white view over the
 *    tab's frame that goes clear, read by the main thread frame by frame from its addition to
 *    its removal: opaque as it comes, clear as it leaves, nothing about it moves or scales (v2
 *    §9.33, opacity alone) – the preview card takes the toast's slot, and `MediaStore.Images`
 *    has one more row under Pictures/Zenium, the viewport's size;
 *  - a real touch on the card's thumbnail opens the picture in the system's viewer; Share on the
 *    card brings the system sheet with the picture; Delete takes the row out of the gallery and
 *    the card goes;
 *  - Capture more sends the card away, the page is stitched while it is on screen (the chrome
 *    lies under the pages, so the editor waits for the picture: run 35724075218 had the sheet
 *    up first and the host copied white where the hidden page was), and the long-screenshot
 *    editor opens EXPANDED with the whole page (about ten screens of it at most, and INKED, not
 *    white rows) in its frame and two handles; a real drag of the bottom handle shortens the
 *    crop; Save writes the crop – shorter than the first screen – to the gallery and shows the
 *    card again (no Capture more on it); at the run's end the editor once more under the dark
 *    chrome, its picture's ink read again, for the design record's dark still;
 *  - `navigator.share` from a page: without a user gesture it rejects with `NotAllowedError`;
 *    `navigator.canShare` answers for a URL, for nothing, for a file; a real tap on the page's
 *    button brings the system sheet (the promise pending under it) and the back gesture rejects
 *    it with `AbortError`; the same with a FILE the page drew (the sheet with the picture – the
 *    design record's still waits for the chooser to draw the preview it reads through the
 *    FileProvider); a target taken, when the sheet lists one the demo knows, resolves it;
 *  - Share from the selection toolbar carries the link to the highlight (`#:~:text=`): the sheet's
 *    Copy link action puts it on the clipboard (the clipboard read; the `Link copied` toast
 *    before Android 13, the OS's own clipboard chip and no toast of Zenium's from 13 on);
 *  - a link to a highlight opened in the browser scrolls the page to the text and marks it (the
 *    engine's own text fragments, or the page script's fallback where the engine has none).
 *
 * The page comes from a loopback server inside this process ([DemoServer]). See [DemoHarness]
 * for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ShareScreenshotDemo : DemoHarness("share-screenshot-demo-state.json", "share-screenshot", "share-screenshot-demo") {
    override val tag = "ShareScreenshotDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host
    /** The thumbnail of the card last seen, so a new card is told from the one before it. */
    private var lastThumb = ""

    /** A gallery row of Zenium's, as MediaStore lists it. */
    private data class Picture(val id: Long, val name: String, val width: Int, val height: Int, val bytes: Long)

    /**
     * What the main thread saw of the flash ([FlashWatch]): one alpha reading as the overlay
     * came into the tree, one per frame drawn with it there, one as it left; `spanMs` from its
     * addition to its removal (the animator's 120 ms stretched by however long the emulator's
     * frames take), `gone` when it left the tree at all.
     */
    private data class Flash(
        val samples: Int, val first: Float, val last: Float, val spanMs: Long,
        val moved: Boolean, val overTab: Boolean, val gone: Boolean, val rose: Boolean
    ) {
        val seen get() = samples > 0
        /** Opaque as it came, clear as it left, never brighter again in between. */
        val fell get() = samples >= 2 && first >= 0.99f && last <= 0.01f && !rose
        override fun toString() = if (!seen) "no white overlay came over the page" else
            "$samples reading(s) over $spanMs ms from added to removed, alpha ${"%.2f".format(first)} -> ${"%.2f".format(last)}" +
                "${if (rose) " (ROSE in between)" else ""}, ${if (moved) "MOVED OR SCALED" else "no translation, no scale"}, " +
                "${if (overTab) "over the tab's frame" else "NOT the tab's frame"}, ${if (gone) "gone from the tree" else "STILL IN THE TREE"}"
    }

    /**
     * The flash as the main thread draws it. Installed on the tab's parent before the menu's
     * tap: the white view [Screenshots] lays over the tab's frame is noted the moment it is added
     * and the moment it is removed (its alpha read both times: 1 as it comes, 0 as the animator's
     * end action takes it out) and at every traversal in between (`OnPreDrawListener`: one
     * reading per frame actually drawn), with its bounds against the tab's and whether anything
     * about it moved or scaled. Sampling from the test thread through `runOnMainSync` starved
     * behind the emulator's second-long frames in run 35721280791 – one reading, alpha 1, and the
     * overlay was gone before the next; this reads what each frame drew and what the removal left.
     */
    private inner class FlashWatch(private val tab: TabWebView, private val parent: ViewGroup) :
        ViewTreeObserver.OnPreDrawListener, ViewGroup.OnHierarchyChangeListener {
        private val alphas = ArrayList<Float>()
        private var overlay: View? = null
        private var addedAt = 0L
        private var moved = false
        private var overTab = true
        private var laidOut = false
        @Volatile var removedAt = 0L

        fun install() {
            parent.setOnHierarchyChangeListener(this)
            parent.viewTreeObserver.addOnPreDrawListener(this)
        }

        fun remove() {
            parent.setOnHierarchyChangeListener(null)
            parent.viewTreeObserver.removeOnPreDrawListener(this)
        }

        override fun onChildViewAdded(p: View, child: View) {
            if (overlay != null || !isFlash(child)) return
            overlay = child
            addedAt = SystemClock.uptimeMillis()
            alphas += child.alpha
        }

        override fun onChildViewRemoved(p: View, child: View) {
            if (child !== overlay || removedAt != 0L) return
            alphas += child.alpha
            removedAt = SystemClock.uptimeMillis()
        }

        override fun onPreDraw(): Boolean {
            val view = overlay ?: return true
            if (removedAt != 0L || view.parent !== parent) return true
            alphas += view.alpha
            if (view.width > 0) {
                laidOut = true
                if (view.scaleX != 1f || view.scaleY != 1f || view.translationX != 0f || view.translationY != tab.translationY) moved = true
                if (view.left != tab.left || view.top != tab.top || view.width != tab.width || view.height != tab.height) overTab = false
            }
            return true
        }

        private fun isFlash(view: View) = view.javaClass == View::class.java && (view.background as? ColorDrawable)?.color == Color.WHITE

        /** Read on the main thread. */
        fun result(): Flash = Flash(
            alphas.size, alphas.firstOrNull() ?: 0f, alphas.lastOrNull() ?: 0f,
            when {
                removedAt != 0L -> removedAt - addedAt
                addedAt != 0L -> SystemClock.uptimeMillis() - addedAt
                else -> 0L
            },
            moved, overTab && laidOut, removedAt != 0L, alphas.zipWithNext().any { (a, b) -> b > a + 0.001f }
        )
    }

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("share-screenshot-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures share / screenshot check(s) failed; see share-screenshot-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "share-screenshot-findings.txt")
        findings.writeText("Zenium Android screenshots and Web Share checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_000)
        watchToasts()
        calibrateDomBoxes()
        // The first menu pays for layout and compilation: once, off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        finding("gallery at the start: ${gallery().size} picture(s) under Pictures/Zenium (an earlier run's are not this run's)")
    }

    override fun demo() {
        shot("00-page")
        webShareGating()
        takeScreenshot()
        openFromCard()
        shareFromCard()
        deleteFromCard()
        captureMore()
        webShareUrl()
        webShareFile()
        highlightLink()
        followHighlight()
        editorInDark()
        finding("\nend: ${if (failures == 0) "every check PASS" else "$failures FAIL"}")
    }

    // --- SH-07: Take Screenshot --------------------------------------------------------------------

    /** Take Screenshot from the menu: the flash sampled, the card, one more gallery row. */
    private fun takeScreenshot() {
        finding("\nSH-07 Take Screenshot: the flash, the card, the gallery")
        val before = gallery()
        val flash = takeScreenshotFromMenu() ?: return
        finding("  flash: $flash")
        check(
            "the flash ran: a white view over the tab's frame, opaque as it came and clear as it left (opacity alone), gone in its own time",
            flash.seen && flash.fell && flash.gone && !flash.moved && flash.overTab && flash.spanMs >= Screenshots.FLASH_MS - 20
        )
        val card = awaitCard()
        SystemClock.sleep(500)
        shot("01-card")
        check("the preview card is up in the toast's slot", card != null)
        finding("  card: ${card ?: "none"}")
        check("the card offers Capture more, Share and Delete", card?.optBoolean("more") == true && card.optBoolean("share") && card.optBoolean("delete"))
        val added = awaitGalleryGrowth(before)
        check("one more picture under Pictures/Zenium", added.size == 1)
        added.firstOrNull()?.let {
            finding("  gallery row: ${it.name} ${it.width}x${it.height}, ${it.bytes} bytes")
            check("the picture is the viewport's (about the window's width, shorter than the window)", it.width in (width * 9 / 10)..width && it.height in (height / 3)..height)
            check("the card says the picture's size", card?.optString("detail")?.startsWith("${it.width} × ${it.height}") == true)
        }
        dismissCard()
    }

    /** A real touch on the card's thumbnail: the system's viewer for the picture. */
    private fun openFromCard() {
        finding("\nSH-07 the thumbnail: the picture in the system's viewer")
        takeScreenshotFromMenu() ?: return
        awaitCard() ?: run {
            check("a card to touch", false)
            return
        }
        val touched = touchControl("Open the screenshot", "document.querySelector('.zen-screenshot-card .zen-screenshot-thumb')", treeMs = 1_200)
        val viewer = touched && awaitSystemWindow(10_000)
        SystemClock.sleep(3_000)
        shot("02-viewer")
        finding("  in front: ${topPackage()}")
        check("a real touch on the thumbnail brought another app's window (the viewer)", viewer)
        if (!viewer) finding("  (no viewer came: no app on the image handles ACTION_VIEW image/png, or the touch missed)")
        backToZenium()
        dismissCard()
    }

    /** Share on the card: the system sheet with the picture. */
    private fun shareFromCard() {
        finding("\nSH-07 Share on the card: the system sheet")
        takeScreenshotFromMenu() ?: return
        awaitCard() ?: run {
            check("a card to touch", false)
            return
        }
        val touched = touchControl("Share", "document.querySelector('.zen-screenshot-card .zen-screenshot-actions button:first-child')", treeMs = 1_200)
        val sheet = touched && awaitSystemWindow(10_000)
        SystemClock.sleep(3_000)
        shot("03-card-share-sheet")
        check("a real touch on Share brought the system share sheet (${topPackage()})", sheet)
        backToZenium()
        dismissCard()
    }

    /** Delete on the card: the row leaves the gallery, the card leaves the slot. */
    private fun deleteFromCard() {
        finding("\nSH-07 Delete on the card: the row out of the gallery")
        val before = gallery()
        takeScreenshotFromMenu() ?: return
        awaitCard() ?: run {
            check("a card to touch", false)
            return
        }
        val added = awaitGalleryGrowth(before)
        val touched = touchControl("Delete", "document.querySelector('.zen-screenshot-card .zen-screenshot-actions button[data-danger]')", treeMs = 1_200)
        val gone = touched && awaitNoCard(6_000)
        SystemClock.sleep(600)
        shot("04-after-delete")
        check("a real touch on Delete sent the card away", gone)
        val rows = awaitGallery(8_000) { g -> added.none { a -> g.any { it.id == a.id } } }
        check("the picture is out of the gallery (${rows.size} row(s) left, ${before.size} before the capture)", added.isNotEmpty() && added.none { a -> rows.any { it.id == a.id } })
    }

    // --- SH-08: Capture more ------------------------------------------------------------------------

    /** Capture more: the editor with the whole page, a real drag of the bottom handle, Save. */
    private fun captureMore() {
        finding("\nSH-08 Capture more: the long screenshot editor")
        val before = gallery()
        takeScreenshotFromMenu() ?: return
        awaitCard() ?: run {
            check("a card to touch", false)
            return
        }
        val viewportRow = awaitGalleryGrowth(before).firstOrNull()
        val touched = touchControl("Capture more", "document.querySelector('.zen-screenshot-card .zen-screenshot-trailing .zen-message-button')", treeMs = 1_200)
        // The card goes and the page is stitched first – the host copies it out of the window
        // while it is on screen, scrolling through its screens – and the sheet mounts with the
        // picture in hand (the chrome lies under the pages: a sheet up would hide the page).
        val cardGone = touched && awaitChrome("document.querySelector('.zen-screenshot-card')==null", 4_000)
        val sheet = touched && awaitChrome("document.querySelector('.zen-longshot-sheet')!=null", LONG_CAPTURE_WAIT_MS)
        check("a real touch on Capture more sent the card away", cardGone)
        check("a real touch on Capture more opened the Long screenshot sheet (once the page was stitched)", sheet)
        if (!sheet) return
        val editor = awaitChrome("document.querySelector('[data-testid=longshot-editor] img')!=null", 10_000)
        check("the whole page was captured into the editor's frame", editor)
        SystemClock.sleep(1_500)
        shot("05-long-editor")
        // The picture is the page, not white rows: a strip the host could not copy (the page
        // hidden under the sheet, as before this driver caught it) would leave the frame blank.
        val ink = chromeJson(PICTURE_INK_SCRIPT)
        finding("  the editor's picture: ${ink.optInt("w")}×${ink.optInt("h")}, ${ink.optInt("inked")}% of its pixels not white, ${ink.optInt("colours")} distinct colours in a coarse sample")
        check("the editor's picture holds the page (not blank)", ink.optInt("inked") >= 20 && ink.optInt("colours") >= 4)
        val pose = chromeJson(
            "(function(){var s=document.querySelector('.zen-longshot-sheet');var sc=s&&s.querySelector('.zen-sheet-scroll');" +
                "var f=document.querySelector('.zen-longshot-frame');var b=document.querySelector('[aria-label=\"Bottom edge\"]');" +
                "return JSON.stringify({sheetTop:s?s.getBoundingClientRect().top:-1,scrollH:sc?sc.clientHeight:-1," +
                "frameH:f?f.getBoundingClientRect().height:-1,bottom:b?+b.getAttribute('aria-valuenow'):-1,max:b?+b.getAttribute('aria-valuemax'):-1," +
                "caption:(document.querySelector('[data-testid=longshot-size]')||{}).textContent||''})})()"
        )
        finding("  editor: sheet top ${pose.optDouble("sheetTop")} css px (window ${height / density} tall), scroller ${pose.optDouble("scrollH")} tall, frame ${pose.optDouble("frameH")} tall, crop 0..${pose.optInt("bottom")} of ${pose.optInt("max")} rows, caption '${pose.optString("caption")}'")
        check("the sheet opened expanded (its top in the window's upper fifth)", pose.optDouble("sheetTop", -1.0) in 0.0..(height / density / 5.0))
        check("the frame holds more than the first screen (the page is several screens long)", pose.optInt("max") > pose.optInt("bottom") && pose.optInt("bottom") > 0)
        val handle = domBox("document.querySelector('[aria-label=\"Bottom edge\"]')")
        val cropBefore = pose.optInt("bottom")
        if (handle != null) {
            val travel = handle.exactCenterY() - (touchable.top + 0.35f * touchable.height())
            val dy = if (travel > 60 * density) -travel * 0.6f else -0.3f * height
            finding("  bottom handle at ${handle.toShortString()}: a real drag of ${dy.toInt()} px")
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                hold(120)
                moveBy(0f, dy, 600)
                hold(150)
                up()
            }
            SystemClock.sleep(1_200)
        } else {
            finding("  the bottom handle is not in the DOM")
        }
        val cropAfter = chromeJs("(function(){var b=document.querySelector('[aria-label=\"Bottom edge\"]');return b?+b.getAttribute('aria-valuenow'):-1})()").toDoubleOrNull()?.toInt() ?: -1
        shot("06-long-editor-cropped")
        finding("  crop after the drag: 0..$cropAfter rows (was 0..$cropBefore)")
        check("the drag shortened the crop", handle != null && cropAfter in 1 until cropBefore)
        check("the sheet stayed put under the handle's drag", awaitChrome("document.querySelector('[data-testid=longshot-editor]')!=null", 1_000))
        val saved = touchControl("Save", "document.querySelector('[data-testid=longshot-save]')", treeMs = 1_500)
        val left = saved && awaitChrome("document.querySelector('.zen-longshot-sheet')==null", 15_000)
        check("a real touch on Save closed the editor", left)
        val card = awaitCard(12_000)
        SystemClock.sleep(600)
        shot("07-long-card")
        check("the card came back for the crop", card != null)
        check("the crop's card offers no Capture more of its own", card != null && !card.optBoolean("more"))
        val added = awaitGallery(10_000) { g -> g.size >= before.size + 2 }.filter { p -> before.none { it.id == p.id } && p.id != viewportRow?.id }
        check("the crop is one more picture under Pictures/Zenium", added.size == 1)
        added.firstOrNull()?.let {
            finding("  gallery row: ${it.name} ${it.width}x${it.height}, ${it.bytes} bytes (the viewport's: ${viewportRow?.let { v -> "${v.width}x${v.height}" } ?: "?"})")
            check("the crop is the editor's rows (${it.height} of $cropAfter, within a row of scaling)", cropAfter > 0 && Math.abs(it.height - cropAfter) <= 2)
            check("the crop is shorter than the first screen", viewportRow != null && it.height < viewportRow.height)
        }
        dismissCard()
    }

    /**
     * The editor once more under the dark chrome, for the design record's dark still
     * (`editor-inked-dark`): the colour scheme switched as BarStarListenOnDemo switches it (the
     * OS's night mode for the system's own windows, Zenium's `colorScheme` for the chrome and,
     * through the app's night mode, the pages), Take Screenshot, Capture more, the picture's ink
     * read again, the editor left by the system back (its dismissal drops the host's copy) and
     * the scheme put back to light. Last in the run, so the scenes before it stand as the retry's.
     */
    private fun editorInDark() {
        finding("\nSH-08 the editor under the dark chrome")
        ensurePage()
        tabJs("window.scrollTo(0,0)")
        SystemClock.sleep(400)
        check("the chrome took the dark theme (the root's data-theme)", scheme("dark"))
        try {
            takeScreenshotFromMenu() ?: return
            awaitCard() ?: run {
                check("a card to touch", false)
                return
            }
            val touched = touchControl("Capture more", "document.querySelector('.zen-screenshot-card .zen-screenshot-trailing .zen-message-button')", treeMs = 1_200)
            val sheet = touched && awaitChrome("document.querySelector('.zen-longshot-sheet')!=null", LONG_CAPTURE_WAIT_MS)
            check("a real touch on Capture more opened the Long screenshot sheet under the dark chrome", sheet)
            if (!sheet) return
            val editor = awaitChrome("document.querySelector('[data-testid=longshot-editor] img')!=null", 10_000)
            SystemClock.sleep(1_500)
            shot("14-long-editor-dark")
            val ink = chromeJson(PICTURE_INK_SCRIPT)
            val theme = jsonString(chromeJs("document.documentElement.dataset.theme||''"))
            finding("  the editor's picture: ${ink.optInt("w")}×${ink.optInt("h")}, ${ink.optInt("inked")}% of its pixels not white, ${ink.optInt("colours")} distinct colours in a coarse sample; the chrome's theme '$theme'")
            check("the editor's picture holds the page (not blank) under the dark chrome", editor && ink.optInt("inked") >= 20 && ink.optInt("colours") >= 4)
            back()
            check("the system back closed the editor", awaitChrome("document.querySelector('.zen-longshot-sheet')==null", 8_000))
            dismissCard()
        } finally {
            scheme("light")
        }
    }

    /** The colour scheme switched (BarStarListenOnDemo's way); true once the chrome's root carries it. */
    private fun scheme(scheme: String): Boolean {
        shellCommand("cmd uimode night ${if (scheme == "dark") "yes" else "no"}")
        coreInvoke("settings.update", "{\"colorScheme\":\"$scheme\"}")
        val landed = awaitChrome("document.documentElement.dataset.theme==='$scheme'", 8_000)
        SystemClock.sleep(2_500)
        toZenium()
        return landed
    }

    // --- SH-14: the Web Share API -------------------------------------------------------------------

    /** Before any touch on the page: a share without a gesture is refused; canShare's answers. */
    private fun webShareGating() {
        finding("\nSH-14 navigator.share: the gate and canShare")
        val probe = pageJson("JSON.stringify(window.__demoProbe())")
        finding("  page: share ${probe.optString("share")}, canShare ${probe.optString("canShare")}, canShare(url) ${probe.opt("canUrl")}, canShare({}) ${probe.opt("canEmpty")}, canShare(file) ${probe.opt("canFile")}, fragmentDirective ${probe.opt("fragmentDirective")}")
        check("the page has navigator.share and navigator.canShare", probe.optString("share") == "function" && probe.optString("canShare") == "function")
        check("canShare says yes to a URL, no to nothing, yes to a small file", probe.optBoolean("canUrl") && !probe.optBoolean("canEmpty", true) && probe.optBoolean("canFile"))
        // `TabWebView.evaluate` settles a promise the script returns: the rejection's name comes back.
        val noGesture = jsonString(tabJs("window.__demoShareWithoutGesture()"))
        finding("  share() from a script with no gesture: $noGesture")
        check("a share without a user gesture rejects with NotAllowedError", noGesture == "NotAllowedError")
        check("no share sheet came for it", topPackage() == app.packageName)
    }

    /** A real tap on the page's button: the system sheet; the back gesture rejects the promise. */
    private fun webShareUrl() {
        finding("\nSH-14 navigator.share({ title, text, url }) from a real tap")
        ensurePage()
        val p = pagePoint("#share-url") ?: run {
            check("the page's share button is on screen", false)
            return
        }
        Finger().tap(p.x, p.y)
        val sheet = awaitSystemWindow(10_000)
        SystemClock.sleep(2_500)
        shot("08-web-share-url-sheet")
        val pending = pageResult()
        check("the tap brought the system share sheet (${topPackage()})", sheet)
        check("the promise is pending while the sheet is up ('$pending')", pending == "url: pending")
        // A target the demo knows is safe to take resolves the promise: shared. Only when the
        // sheet lists it; a dismissal is the case every sheet has.
        val target = if (sheet) findInWindows { it == BLUETOOTH } else null
        if (target != null && touchTapPoint(target) != null) {
            finding("  a real touch on '$BLUETOOTH' in the sheet")
            SystemClock.sleep(4_000)
            shot("09-web-share-url-target")
            backToZenium()
            val result = awaitPageResult { it != "url: pending" }
            finding("  result: $result")
            check("the promise resolved once a target was taken", result == "url: shared")
        } else {
            finding("  no '$BLUETOOTH' target listed: the sheet is dismissed instead")
            backToZenium()
            val result = awaitPageResult { it != "url: pending" }
            finding("  result: $result")
            check("dismissing the sheet rejects the promise with AbortError", result == "url: AbortError")
        }
    }

    /** A real tap shares a FILE the page drew: the sheet with the picture (the design record's still). */
    private fun webShareFile() {
        finding("\nSH-14 navigator.share({ files }) from a real tap")
        ensurePage()
        val p = pagePoint("#share-file") ?: run {
            check("the page's file share button is on screen", false)
            return
        }
        Finger().tap(p.x, p.y)
        val sheet = awaitSystemWindow(12_000)
        // The chooser draws the picture's preview a while after it comes up (it reads the file
        // through the FileProvider and decodes it; 2-3 s on the emulator): the still waits for
        // the preview's colours to show in the sheet's upper part, so the record shows the file.
        val preview = if (sheet) awaitChooserPreview(8_000) else null
        finding("  the sheet's preview area: ${preview?.let { "${it.first}% of its pixels off the sheet's colour after ${it.second} ms" } ?: "not measured"}")
        SystemClock.sleep(700)
        shot("10-web-share-file-sheet")
        val pending = pageResult()
        check("the tap brought the system share sheet with the file (${topPackage()})", sheet)
        check("canShare said yes to the file and the promise is pending under the sheet ('$pending')", pending == "file (canShare true): pending")
        backToZenium()
        val result = awaitPageResult { !it.endsWith("pending") }
        finding("  result: $result")
        check("dismissing the sheet rejects the file share with AbortError", result == "file (canShare true): AbortError")
    }

    // --- SH-11: the link to the highlight ----------------------------------------------------------------

    /** Share from the toolbar carries the `#:~:text=` link; the sheet's Copy link puts it on the clipboard. */
    private fun highlightLink() {
        finding("\nSH-11 Share from the selection toolbar: the link to the highlight")
        ensurePage()
        val items = longPress("#word") { list -> list.any { it.label == "Share" } }
        val selected = jsonString(tabJs("String(getSelection())"))
        finding("  long press on 'quantum': selection '$selected'; toolbar ${items?.joinToString(" | ") { it.label } ?: "MISSING"}")
        val share = items?.find { it.label == "Share" }
        val point = share?.let { touchTapPoint(it.node) }
        check("Share is in the toolbar and under the finger", point != null)
        val sheet = point != null && awaitSystemWindow(10_000)
        SystemClock.sleep(3_000)
        shot("11-selection-share-sheet")
        check("the system share sheet came for the selection (${topPackage()})", sheet)
        val previewsLink = findInWindows { it.contains(":~:text=") } != null
        finding("  the sheet ${if (previewsLink) "shows" else "does not show"} the highlight link in its preview")
        val copy = if (sheet) findInWindows { it == COPY_LINK } else null
        if (copy != null && touchTapPoint(copy) != null) {
            finding("  a real touch on '$COPY_LINK' in the sheet's action row")
            // From Android 13 the OS shows its own clipboard chip for the copy and Zenium says
            // nothing more (`copyConfirmation`); before it, Zenium's toast is the confirmation.
            val chip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            val toast = if (chip) false else awaitToastSeen("Link copied", 10_000)
            if (chip) SystemClock.sleep(1_500)
            toZenium()
            SystemClock.sleep(800)
            shot("12-link-copied")
            val clip = clipboardText()
            finding("  clipboard: ${clip ?: "(not readable here)"}")
            if (chip) {
                finding("  (API ${Build.VERSION.SDK_INT}: the OS's clipboard chip confirms the copy; Zenium's toast stays away by design)")
                check("no 'Link copied' toast of Zenium's doubles the OS's clipboard chip", !toastSeen("Link copied"))
            } else {
                check("the sheet's Copy link copied it (the 'Link copied' toast)", toast)
            }
            check("the clipboard holds the page's URL with the text directive for 'quantum'", clip == "$ORIGIN/#:~:text=quantum" || (clip == null && (toast || chip)))
            if (clip == null) finding("  (the clipboard could not be read by the test; the ${if (chip) "chip" else "toast"} is the evidence)")
        } else {
            finding("  no '$COPY_LINK' action listed on the sheet (Android 14's action row wants the browser's own link): dismissed")
            check("Copy link on the sheet", false)
            backToZenium()
        }
        clearSelection()
    }

    /** A link to a highlight opened in the browser: the page scrolls to the text and marks it. */
    private fun followHighlight() {
        finding("\nSH-11 following a link to a highlight")
        val url = "$ORIGIN/#:~:text=serendipity"
        openLink(url)
        val deadline = SystemClock.uptimeMillis() + 20_000
        var loaded = false
        while (!loaded && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(400)
            loaded = tabJs("document.readyState==='complete'&&location.href.indexOf('$ORIGIN/')===0") == "true"
        }
        SystemClock.sleep(3_000)
        val state = pageJson(
            "JSON.stringify({scrollY:window.scrollY,native:'fragmentDirective' in document," +
                "fallback:!!(window.CSS&&CSS.highlights&&CSS.highlights.has('zen-text-fragment')),hash:location.hash," +
                "deepTop:document.getElementById('deep').getBoundingClientRect().top,viewport:window.innerHeight})"
        )
        shot("13-highlight-followed")
        finding("  loaded $loaded; scrollY ${state.opt("scrollY")}, the engine's text fragments: ${state.opt("native")}, the fallback highlight: ${state.opt("fallback")}, hash '${state.optString("hash")}', the text's top ${state.opt("deepTop")} of ${state.opt("viewport")}")
        check("the page scrolled to the highlighted text", state.optDouble("scrollY", 0.0) > 0.0)
        check("the text sits in view", state.optDouble("deepTop", -1.0) in 0.0..state.optDouble("viewport", 0.0))
        check("the engine marked the text (its own fragments) or the fallback did", state.optBoolean("native") || state.optBoolean("fallback"))
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * Take Screenshot from the app menu with a real touch, a [FlashWatch] on the tab's parent
     * from before the tap until the overlay has left the tree (or [FLASH_WAIT_MS] passed: the
     * capture runs once the menu has gone, which the emulator's frames put seconds after the
     * tap); null (a FAIL noted) when the menu had no such item.
     */
    private fun takeScreenshotFromMenu(): Flash? {
        toZenium()
        val watch = onMain {
            shownTabView()?.let { tab -> (tab.parent as? ViewGroup)?.let { parent -> FlashWatch(tab, parent).also(FlashWatch::install) } }
        }
        if (!openMenuItem(TAKE_SCREENSHOT)) {
            onMain { watch?.remove() }
            check("Take Screenshot is in the menu", false)
            back()
            return null
        }
        if (watch == null) {
            finding("  no tab shown to watch the flash over")
            return Flash(0, 0f, 0f, 0L, moved = false, overTab = false, gone = false, rose = false)
        }
        val deadline = SystemClock.uptimeMillis() + FLASH_WAIT_MS
        while (watch.removedAt == 0L && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        return onMain { watch.result().also { watch.remove() } }
    }

    /**
     * The card in the slot once it is a new one: what it shows, or null when none came in time.
     * New: the first card up after the slot was seen empty, or one with another picture – two
     * captures of the same unchanged page carry the same thumbnail (run 35721280791 took every
     * card after the first for the first, its thumbnail's tail being the same).
     */
    private fun awaitCard(timeoutMs: Long = 12_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val card = chromeJson(CARD_JS)
            val thumb = card.optString("thumb")
            if (!card.optBoolean("up")) {
                lastThumb = ""
            } else if (thumb.isNotEmpty() && thumb != lastThumb) {
                lastThumb = thumb
                return card
            }
            SystemClock.sleep(150)
        }
        return null
    }

    private fun awaitNoCard(timeoutMs: Long): Boolean = awaitChrome("document.querySelector('.zen-screenshot-card')==null", timeoutMs)

    /** The card's X with a real touch, or its clock; either way the slot is empty after. */
    private fun dismissCard() {
        if (chromeJs("document.querySelector('.zen-screenshot-card')!=null") == "true") {
            touchControl("Dismiss", "document.querySelector('.zen-screenshot-card .zen-message-close')", treeMs = 800)
        }
        if (awaitNoCard(8_000)) lastThumb = ""
        SystemClock.sleep(600)
    }

    /** Zenium's window holds the focus: the main thread's word, not the accessibility tree's. */
    private fun zeniumFocused(): Boolean = onMain { activity.hasWindowFocus() }

    private fun awaitZeniumFocus(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (zeniumFocused()) return true
            SystemClock.sleep(150)
        }
        return zeniumFocused()
    }

    /**
     * Back out of whatever other app's window is in front until Zenium's holds the focus again.
     * A back goes only while another window truly has the focus: run 35721280791's loop went by
     * the accessibility tree, which still named the Bluetooth device picker two seconds after it
     * had closed, and the second back landed on Zenium's own root – the tab went to the New Tab
     * Page and the rest of the demo had no page under it. When backs do not do it, the browser's
     * task is started again through the shell (singleTask: the running task comes to the front).
     */
    private fun backToZenium() {
        var tries = 0
        while (!zeniumFocused() && tries < 4) {
            back()
            awaitZeniumFocus(3_000)
            tries++
        }
        if (!zeniumFocused()) {
            Log.w(tag, "no focus after $tries back(s); bringing the browser's task back")
            shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
            awaitZeniumFocus(5_000)
        }
        awaitTreeOnZenium()
    }

    /**
     * Zenium in front by the main thread's word on the focus (a back out of another window when
     * not), then the accessibility tree given the time to say so too.
     */
    private fun toZenium() {
        if (zeniumFocused()) awaitTreeOnZenium() else backToZenium()
    }

    /**
     * The accessibility tree naming Zenium's window (up to 6 s): the harness's own moves consult
     * the tree first, and one trailing a transition would have them send a back into the browser.
     */
    private fun awaitTreeOnZenium() {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            val top = topPackage()
            if (top == null || top == app.packageName) break
            SystemClock.sleep(200)
        }
        SystemClock.sleep(400)
    }

    /** The demo page in the shown tab (`#share-url` in its DOM); opened again when something took it away. */
    private fun ensurePage() {
        toZenium()
        if (tabJs("!!document.getElementById('share-url')") == "true") return
        finding("  (the demo page was not in the tab: opening it again)")
        openLink("$ORIGIN/")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(1_500)
        toZenium()
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    /**
     * Wait for the system chooser's content preview to show a picture: the share of pixels in
     * the sheet's upper part (under its title row) that are off the sheet's own colour, read
     * from a screenshot every half second, until it is a picture's worth ([PREVIEW_INK_PERCENT])
     * or `timeoutMs` is up. The pair is the last share measured and the time it took; null when
     * no chooser window is on screen. The preview comes late on the emulator: the chooser reads
     * the file through the FileProvider and decodes it after the sheet has come up.
     */
    private fun awaitChooserPreview(timeoutMs: Long): Pair<Int, Long>? {
        val start = SystemClock.uptimeMillis()
        var last = -1
        while (true) {
            val root = ui.rootInActiveWindow?.takeIf { it.packageName?.toString() != app.packageName } ?: return null
            val bounds = Rect().also { root.getBoundsInScreen(it) }
            if (bounds.height() > 0 && bounds.width() > 0) {
                val bitmap = ui.takeScreenshot()
                if (bitmap != null) {
                    val top = (bounds.top + 56 * density).toInt().coerceIn(0, bitmap.height - 1)
                    val bottom = (bounds.top + bounds.height() * 0.4f).toInt().coerceIn(top + 1, bitmap.height)
                    val left = (bounds.left + bounds.width() * 0.08f).toInt().coerceIn(0, bitmap.width - 1)
                    val right = (bounds.right - bounds.width() * 0.08f).toInt().coerceIn(left + 1, bitmap.width)
                    val step = 4
                    val counts = HashMap<Int, Int>()
                    val pixels = ArrayList<Int>()
                    var y = top
                    while (y < bottom) {
                        var x = left
                        while (x < right) {
                            val c = bitmap.getPixel(x, y)
                            pixels += c
                            val key = (((c shr 20) and 0xF) shl 8) or (((c shr 12) and 0xF) shl 4) or ((c shr 4) and 0xF)
                            counts[key] = (counts[key] ?: 0) + 1
                            x += step
                        }
                        y += step
                    }
                    bitmap.recycle()
                    val dominant = counts.maxByOrNull { it.value }?.key ?: 0
                    val dr = (dominant shr 8 and 0xF) shl 4
                    val dg = (dominant shr 4 and 0xF) shl 4
                    val db = (dominant and 0xF) shl 4
                    val off = pixels.count { c ->
                        Math.abs(Color.red(c) - dr) + Math.abs(Color.green(c) - dg) + Math.abs(Color.blue(c) - db) > 72
                    }
                    last = if (pixels.isEmpty()) 0 else 100 * off / pixels.size
                    if (last >= PREVIEW_INK_PERCENT) return last to SystemClock.uptimeMillis() - start
                }
            }
            if (SystemClock.uptimeMillis() - start >= timeoutMs) return last.coerceAtLeast(0) to SystemClock.uptimeMillis() - start
            SystemClock.sleep(500)
        }
    }

    // --- the gallery -----------------------------------------------------------------------------

    /** Zenium's rows in `MediaStore.Images` (the app's own, so no permission is needed to list them). */
    private fun gallery(): List<Picture> {
        val projection = arrayOf(
            MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT, MediaStore.Images.Media.SIZE
        )
        val (selection, args) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?" to arrayOf("%${Screenshots.FOLDER}%")
        } else {
            @Suppress("DEPRECATION")
            "${MediaStore.Images.Media.DATA} LIKE ?" to arrayOf("%/${Screenshots.FOLDER}/%")
        }
        val rows = ArrayList<Picture>()
        runCatching {
            app.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, selection, args, null)?.use { c ->
                while (c.moveToNext()) {
                    rows += Picture(c.getLong(0), c.getString(1) ?: "", c.getInt(2), c.getInt(3), c.getLong(4))
                }
            }
        }.onFailure { Log.w(tag, "gallery query failed", it) }
        return rows
    }

    private fun awaitGallery(timeoutMs: Long, ready: (List<Picture>) -> Boolean): List<Picture> {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var rows = gallery()
        while (!ready(rows) && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            rows = gallery()
        }
        return rows
    }

    /** The rows added since `before`, once there is one (or the wait ran out). */
    private fun awaitGalleryGrowth(before: List<Picture>, timeoutMs: Long = 10_000): List<Picture> =
        awaitGallery(timeoutMs) { it.size > before.size }.filter { p -> before.none { it.id == p.id } }

    // --- the chrome ------------------------------------------------------------------------------------

    private fun awaitChrome(js: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeJs(js) == "true") return true
            SystemClock.sleep(150)
        }
        return chromeJs(js) == "true"
    }

    private fun chromeJson(js: String): JSONObject =
        runCatching { JSONObject(jsonString(chromeJs(js))) }.getOrDefault(JSONObject())

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun pageJson(code: String): JSONObject = runCatching { JSONObject(jsonString(tabJs(code))) }.getOrDefault(JSONObject())

    private fun pageResult(): String = jsonString(tabJs("document.getElementById('result').textContent"))

    private fun awaitPageResult(timeoutMs: Long = 10_000, ready: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var result = pageResult()
        while (!ready(result) && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            result = pageResult()
        }
        return result
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'nearest'});var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /** What the clipboard holds, read on the main thread as the app (null when the system withholds it). */
    private fun clipboardText(): String? = onMain {
        runCatching {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.primaryClip?.getItemAt(0)?.coerceToText(app)?.toString()
        }.getOrNull()
    }

    // --- the selection toolbar (SelectionDemo's reading) ------------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    private fun toolbarItems(): List<ToolbarItem>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val items = ArrayList<ToolbarItem>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isClickable && node.isVisibleToUser) {
                    items += ToolbarItem(label, Rect().also { node.getBoundsInScreen(it) }, node)
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (items.any { it.label == "Copy" }) return items.sortedBy { it.bounds.left }
        }
        return null
    }

    private fun awaitToolbar(timeoutMs: Long = 12_000, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: List<ToolbarItem>? = null
        while (SystemClock.uptimeMillis() < deadline) {
            toolbarItems()?.let { items ->
                last = items
                if (ready(items)) return items
            }
            SystemClock.sleep(250)
        }
        return last
    }

    /** A REAL long press on the middle of the first element `selector` names; the toolbar's items once `ready`. */
    private fun longPress(selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val p = pagePoint(selector) ?: run {
            finding("  no $selector on the page")
            return null
        }
        Finger().apply {
            down(p.x, p.y)
            hold(1_200)
            up()
        }
        return awaitToolbar(ready = ready)
    }

    /** A tap on the line below clears the selection and finishes the mode. */
    private fun clearSelection() {
        toZenium()
        pagePoint("#tail")?.let { Finger().tap(it.x, it.y) }
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (toolbarItems() != null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        SystemClock.sleep(800)
    }

    // --- findings --------------------------------------------------------------------------------

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $what ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18137
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAKE_SCREENSHOT = "Take Screenshot"
        private const val MENU_HANDLE = "Resize menu"
        /**
         * How long the flash's overlay is waited for after the tap on Take Screenshot: the capture
         * runs once the menu has gone, and run 35721280791's menu took five seconds to go on the
         * recipe's software GPU.
         */
        private const val FLASH_WAIT_MS = 20_000L
        /**
         * How long the editor is waited for after the tap on Capture more: the page is stitched
         * first (ten screens, each a frame wait and a window copy; `PageCapture`'s own watchdog
         * gives up at 20 s), the preview encoded, then the sheet mounts and slides up.
         */
        private const val LONG_CAPTURE_WAIT_MS = 40_000L
        /** Android 14's action row on the sheet: the browser's own Copy link (`Share.browserActions`). */
        private const val COPY_LINK = "Copy link"
        /**
         * The share of the chooser's preview area that is off the sheet's colour once a picture
         * is in it (`awaitChooserPreview`): the title row's text alone is a few percent.
         */
        private const val PREVIEW_INK_PERCENT = 10

        /**
         * The editor's picture read back through a canvas (a `data:` image is same-origin): the
         * share of sampled pixels that are not white (or near it) and the distinct colours in a
         * coarse (4 bits a channel) sample. A stitched page of the demo's coloured bands has most
         * of its pixels inked; a capture of white rows has none.
         */
        private const val PICTURE_INK_SCRIPT =
            "(function(){var img=document.querySelector('[data-testid=longshot-editor] img');if(!img||!img.naturalWidth)return JSON.stringify({w:0,h:0,inked:0,colours:0});" +
                "var w=img.naturalWidth,h=img.naturalHeight,c=document.createElement('canvas');var s=Math.max(1,Math.floor(Math.max(w,h)/160));" +
                "c.width=Math.max(1,Math.floor(w/s));c.height=Math.max(1,Math.floor(h/s));var g=c.getContext('2d');g.drawImage(img,0,0,c.width,c.height);" +
                "var d=g.getImageData(0,0,c.width,c.height).data,inked=0,seen={},n=0;for(var i=0;i<d.length;i+=4){n++;var r=d[i],gg=d[i+1],b=d[i+2];" +
                "if(r<240||gg<240||b<240)inked++;seen[(r>>4)+','+(gg>>4)+','+(b>>4)]=1}" +
                "return JSON.stringify({w:w,h:h,inked:Math.round(100*inked/Math.max(1,n)),colours:Object.keys(seen).length})})()"
        /** A share target every Google APIs image lists and that opens nothing but a picker. */
        private const val BLUETOOTH = "Bluetooth"

        /** What the card in the slot shows, as one JSON object; `up` false when there is none. */
        private const val CARD_JS =
            "(function(){var c=document.querySelector('.zen-screenshot-card');if(!c)return JSON.stringify({up:false});" +
                "var img=c.querySelector('.zen-screenshot-thumb img');var buttons=Array.prototype.map.call(c.querySelectorAll('button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()});" +
                "return JSON.stringify({up:true,thumb:img?img.getAttribute('src').slice(-48):'',title:(c.querySelector('.zen-screenshot-title')||{}).textContent||''," +
                "detail:(c.querySelector('.zen-banner-detail')||{}).textContent||'',more:buttons.indexOf('Capture more')>=0,share:buttons.indexOf('Share')>=0," +
                "delete:buttons.indexOf('Delete')>=0,danger:!!c.querySelector('button[data-danger]'),buttons:buttons})})()"
    }
}
