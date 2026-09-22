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
 *    tab's frame that goes clear, sampled on the main thread: its alpha falls, nothing about it
 *    moves or scales (v2 §9.33, opacity alone) – the preview card takes the toast's slot, and
 *    `MediaStore.Images` has one more row under Pictures/Zenium, the viewport's size;
 *  - a real touch on the card's thumbnail opens the picture in the system's viewer; Share on the
 *    card brings the system sheet with the picture; Delete takes the row out of the gallery and
 *    the card goes;
 *  - Capture more opens the long-screenshot editor EXPANDED with the whole page (about ten
 *    screens of it at most) in its frame and two handles; a real drag of the bottom handle
 *    shortens the crop; Save writes the crop – shorter than the first screen – to the gallery
 *    and shows the card again (no Capture more on it);
 *  - `navigator.share` from a page: without a user gesture it rejects with `NotAllowedError`;
 *    `navigator.canShare` answers for a URL, for nothing, for a file; a real tap on the page's
 *    button brings the system sheet (the promise pending under it) and the back gesture rejects
 *    it with `AbortError`; the same with a FILE the page drew (the sheet with the picture, the
 *    design record's still); a target taken, when the sheet lists one the demo knows, resolves it;
 *  - Share from the selection toolbar carries the link to the highlight (`#:~:text=`): the sheet's
 *    Copy link action puts it on the clipboard (the `Link copied` toast; the clipboard read);
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

    /** What the main-thread sampling saw of the flash. */
    private data class Flash(val samples: Int, val first: Float, val last: Float, val spanMs: Long, val moved: Boolean, val overTab: Boolean) {
        val seen get() = samples > 0
        val fell get() = samples >= 2 && last < first
        override fun toString() = if (!seen) "no white overlay seen over the page" else
            "$samples sample(s) over $spanMs ms, alpha ${"%.2f".format(first)} -> ${"%.2f".format(last)}, " +
                "${if (moved) "MOVED OR SCALED" else "no translation, no scale"}, ${if (overTab) "over the tab's frame" else "NOT the tab's frame"}"
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
        finding("\nend: ${if (failures == 0) "every check PASS" else "$failures FAIL"}")
    }

    // --- SH-07: Take Screenshot --------------------------------------------------------------------

    /** Take Screenshot from the menu: the flash sampled, the card, one more gallery row. */
    private fun takeScreenshot() {
        finding("\nSH-07 Take Screenshot: the flash, the card, the gallery")
        val before = gallery()
        val flash = takeScreenshotFromMenu() ?: return
        finding("  flash: $flash")
        check("the flash ran: a white view over the tab's frame whose alpha fell, opacity alone", flash.seen && flash.fell && !flash.moved && flash.overTab)
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
        val sheet = touched && awaitChrome("document.querySelector('.zen-longshot-sheet')!=null", 8_000)
        check("a real touch on Capture more opened the Long screenshot sheet", sheet)
        if (!sheet) return
        val editor = awaitChrome("document.querySelector('[data-testid=longshot-editor]')!=null", 25_000)
        check("the whole page was captured into the editor's frame", editor)
        SystemClock.sleep(1_500)
        shot("05-long-editor")
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
        ensureForeground()
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
        ensureForeground()
        val p = pagePoint("#share-file") ?: run {
            check("the page's file share button is on screen", false)
            return
        }
        Finger().tap(p.x, p.y)
        val sheet = awaitSystemWindow(12_000)
        SystemClock.sleep(3_000)
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
        ensureForeground()
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
            val toast = awaitToastSeen("Link copied", 10_000)
            ensureForeground()
            SystemClock.sleep(800)
            shot("12-link-copied")
            check("the sheet's Copy link copied it (the 'Link copied' toast)", toast)
            val clip = clipboardText()
            finding("  clipboard: ${clip ?: "(not readable here)"}")
            check("the clipboard holds the page's URL with the text directive for 'quantum'", clip == null || clip == "$ORIGIN/#:~:text=quantum")
            if (clip == null) finding("  (the clipboard could not be read by the test; the toast is the evidence)")
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
     * Take Screenshot from the app menu with a real touch, sampling the flash on the main thread
     * while the capture runs; null (a FAIL noted) when the menu had no such item.
     */
    private fun takeScreenshotFromMenu(): Flash? {
        ensureForeground()
        if (!openMenuItem(TAKE_SCREENSHOT)) {
            check("Take Screenshot is in the menu", false)
            back()
            return null
        }
        return sampleFlash(5_000)
    }

    /**
     * The flash, as the main thread sees it: the white view [Screenshots] lays over the tab's
     * frame, its alpha read every few milliseconds until it has gone (or `ms` passed without
     * one). Records whether it ever moved or scaled and whether it covered the tab's frame.
     */
    private fun sampleFlash(ms: Long): Flash {
        val deadline = SystemClock.uptimeMillis() + ms
        var samples = 0
        var first = 0f
        var last = 0f
        var startedAt = 0L
        var endedAt = 0L
        var moved = false
        var overTab = true
        while (SystemClock.uptimeMillis() < deadline) {
            var alpha = -1f
            instrumentation.runOnMainSync {
                val tab = host.tabs.all().firstOrNull { it.isShown } ?: return@runOnMainSync
                val parent = tab.parent as? android.view.ViewGroup ?: return@runOnMainSync
                for (i in 0 until parent.childCount) {
                    val child = parent.getChildAt(i)
                    if (child.javaClass != View::class.java) continue
                    val color = (child.background as? ColorDrawable)?.color ?: continue
                    if (color != Color.WHITE) continue
                    alpha = child.alpha
                    if (child.scaleX != 1f || child.scaleY != 1f || child.translationX != 0f || child.translationY != tab.translationY) moved = true
                    if (child.left != tab.left || child.top != tab.top || child.width != tab.width || child.height != tab.height) overTab = false
                    break
                }
            }
            val now = SystemClock.uptimeMillis()
            if (alpha >= 0f) {
                if (samples == 0) {
                    first = alpha
                    startedAt = now
                }
                last = alpha
                endedAt = now
                samples++
            } else if (samples > 0) {
                break
            }
            SystemClock.sleep(4)
        }
        return Flash(samples, first, last, endedAt - startedAt, moved, overTab)
    }

    /** The card in the slot once it is a new one: what it shows, or null when none came in time. */
    private fun awaitCard(timeoutMs: Long = 12_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val card = chromeJson(CARD_JS)
            val thumb = card.optString("thumb")
            if (card.optBoolean("up") && thumb.isNotEmpty() && thumb != lastThumb) {
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
        awaitNoCard(8_000)
        SystemClock.sleep(600)
    }

    /** Back out of whatever other app's window is in front until Zenium is. */
    private fun backToZenium() {
        var tries = 0
        while (topPackage() != app.packageName && tries < 4) {
            back()
            SystemClock.sleep(1_500)
            tries++
        }
        ensureForeground()
        SystemClock.sleep(800)
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

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
        ensureForeground()
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
        /** Android 14's action row on the sheet: the browser's own Copy link (`Share.browserActions`). */
        private const val COPY_LINK = "Copy link"
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
