package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives the inline PDF viewer's controls on the phone (CT-02: the bar under the document and
 * its sheets, `components/pdf/`) so the `android-pdf-viewer-demo` workflow can record them on an
 * emulator. The site is the engine demo's ([PdfViewerDemoSite]): a finger on the page's link
 * has the tab open the PDF in the viewer, whose bar comes up under the pages. Then every
 * control under a real finger, the way a reader would press it, and the effect of each touch
 * asserted on the viewer's report (`pdf.state`, the report the bar draws from) – the rule for a
 * sheet flow in [DemoHarness]: a pinch out zooms the pages and the bar's zoom reads the
 * percentage; the zoom menulist opens the zoom sheet and Fit to width in it brings the pages
 * back; the page indicator opens Go to page, a page number typed and Go leads there; Find opens
 * the find bar over the bar, the query typed counts the matches and Next steps on; Contents
 * opens the outline and its last entry leads to the last page; More options opens the overflow,
 * Rotate turns the pages and Open with brings the system chooser; Share on the bar brings the
 * system share sheet. Findings land in `pdf-viewer-ui-findings.txt` next to the screenshots
 * (`services-print-pdf-android-ui-NN-*.png`).
 */
@RunWith(AndroidJUnit4::class)
class PdfViewerUiDemo : DemoHarness("pdf-viewer-demo-state.json", "services-print-pdf-android-ui", "pdf-viewer-demo") {
    override val tag = "PdfViewerUiDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var shots = 0

    @Test
    fun record() {
        server = DemoServer(PdfViewerDemoSite.PORT, PdfViewerDemoSite.routes()).also { it.start() }
        Log.i(tag, "demo server: ${server.selfCheck()}")
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** The seeded tab points at the loopback page, so nothing in the run depends on the network. */
    override fun patchState(json: String): String = json.replace(PdfViewerDemoSite.PAGE_PLACEHOLDER, "$ORIGIN/")

    override fun warmUp() {
        findings = File(out, "pdf-viewer-ui-findings.txt")
        findings.writeText("PDF viewer demo (UI): ${server.origin}\n")
        if (!awaitTabUrl("$ORIGIN/", 20_000)) Log.w(tag, "the demo page did not become the active tab's address in time")
        if (waitFor(PdfViewerDemoSite.LINK_TEXT, 15_000) == null) Log.w(tag, "no link node on the demo page yet")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        // 1. The page offering the PDF.
        snap("page")
        beat()

        // 2. A finger on the link: the tab opens the file in the viewer, and the bar comes up
        //    under the pages with the page indicator reading 1 / 3.
        val opened = touchTapLabelExpecting(PdfViewerDemoSite.LINK_TEXT, "the tab shows zen://pdf", timeoutMs = 30_000) {
            activeCoreTab()?.optString("url").orEmpty().startsWith("zen://pdf")
        }
        if (!opened) {
            note("viewer: the tab did not open the viewer")
            return
        }
        val tabId = activeCoreTab()!!.getString("id")
        val ready = awaitReport(tabId, 30_000) { it.optString("state") == "ready" }
        if (ready == null) {
            touchFault("the viewer never reported the document ready")
            note("viewer: no ready report")
            return
        }
        val pageCount = ready.optInt("pageCount")
        note("viewer ready: $pageCount pages, title ${ready.optString("title")}, zoom ${ready.optDouble("zoom")}, fit ${ready.optString("fit")}")
        expect(pageCount == PAGES, "the viewer counts $PAGES pages")
        expect(waitFor(pageIndicator(1, pageCount), 15_000) != null, "the bar's page indicator reads 1 / $pageCount")
        expect(waitFor("Zoom, $FIT_WIDTH", 5_000) != null, "the bar's zoom reads $FIT_WIDTH")
        SystemClock.sleep(1_200)
        snap("viewer-bar")
        beat()

        // 3. Two fingers moving apart over the page: the pages zoom about the fingers and the
        //    bar's zoom menulist reads the percentage instead of the fit.
        val before = ready.optDouble("zoom")
        pinch(width * 0.5f, height * 0.4f, 90 * density, 340 * density, 800)
        val zoomed = awaitReport(tabId, 8_000) { it.optDouble("zoom") > before * 1.3 }
        if (zoomed == null) touchFault("a pinch out over the pages did not zoom them (zoom stayed at $before)")
        note("after the pinch: zoom ${zoomed?.optDouble("zoom")}, fit ${zoomed?.optString("fit")}")
        val percent = awaitNode(8_000) { it.startsWith("Zoom, ") && it.endsWith("%") }
        expect(percent != null, "the bar's zoom reads a percentage after a free zoom (${percent?.contentDescription})")
        SystemClock.sleep(1_200)
        snap("pinched")
        beat()

        // 4. The zoom menulist opens the zoom sheet (the two fits, Chrome's presets); a finger on
        //    Fit to width brings the pages back to the width.
        val zoomLabel = percent?.contentDescription?.toString() ?: "Zoom, "
        val zoomSheet = touchTapLabelExpecting(zoomLabel, "the zoom sheet is up", prefix = percent == null) {
            findByLabel(FIT_PAGE) != null
        }
        if (zoomSheet) {
            SystemClock.sleep(1_200)
            snap("zoom-sheet")
            beat()
            val fitted = touchTapLabelExpecting(FIT_WIDTH, "the pages fit the width", timeoutMs = 8_000) {
                report(tabId)?.optString("fit") == "width"
            }
            note("fit to width from the sheet: ${if (fitted) "took" else "did not take"}; zoom ${report(tabId)?.optDouble("zoom")}")
            awaitSurface(false)
            expect(waitFor("Zoom, $FIT_WIDTH", 8_000) != null, "the bar's zoom reads $FIT_WIDTH again")
        }
        SystemClock.sleep(800)

        // 5. The page indicator opens Go to page: a finger in the field, the number typed, and
        //    Go leads to page 2 – the indicator reads 2 / 3.
        val pageNow = report(tabId)?.optInt("page") ?: 1
        val gotoSheet = touchTapLabelExpecting(pageIndicator(pageNow, pageCount), "the Go to page sheet is up") {
            findByLabel("Go") != null
        }
        if (gotoSheet) {
            val field = awaitNode(8_000) { it.startsWith("Page number") }?.let { fieldNear(it) } ?: editText()
            if (field == null) {
                touchFault("no field in the Go to page sheet")
            } else {
                val focused = touchTapPoint(field) != null && awaitChromeFocus("numeric")
                expect(focused, "a touch in the page field focuses it")
                chromeJs("(function(){var e=document.activeElement;if(e&&e.select)e.select()})()")
                SystemClock.sleep(300)
                keys("2")
                expect(awaitChromeValue("2"), "the field holds the typed page number")
                SystemClock.sleep(800)
                snap("go-to-page-sheet")
                beat()
                // The sheet makes room for the keyboard, so Go stays above it; should it not,
                // back takes the keyboard first (the field keeps its text) and the finger follows.
                awaitNode(5_000) { it == "Go" }?.let { go ->
                    val bounds = Rect().also { go.getBoundsInScreen(it) }
                    if (imeShown() && bounds.bottom > height - imeInset()) {
                        note("Go sits under the keyboard ($bounds, keyboard ${imeInset()} px): taking the keyboard down first")
                        back()
                        awaitIme(false)
                        SystemClock.sleep(600)
                    }
                }
                val went = touchTapLabelExpecting("Go", "the viewer is on page 2", timeoutMs = 8_000) {
                    report(tabId)?.optInt("page") == 2
                }
                note("go to page 2: ${if (went) "took" else "did not take"}")
            }
            awaitSurface(false)
            awaitIme(false)
            expect(waitFor(pageIndicator(2, pageCount), 8_000) != null, "the bar's page indicator reads 2 / $pageCount")
            SystemClock.sleep(1_000)
            snap("page-2")
            beat()
        }

        // 6. Find on the bar: the find bar takes the bar's slot, the query typed counts every
        //    match of "tide" (the tally final once every page has been read), Next steps to the
        //    following match, and the bar's own close hands the slot back to the viewer's bar.
        val findBar = touchTapLabelExpecting("Find in page", "the find bar is up") { findByLabel("Close find bar") != null }
        if (findBar) {
            expect(awaitChromeFocus("search", "text"), "the find bar's field takes focus as it opens")
            keys(FIND_QUERY)
            val found = awaitReport(tabId, 12_000) {
                val find = it.optJSONObject("find")
                find != null && find.optString("query") == FIND_QUERY && find.optInt("total") > 0 && !find.optBoolean("searching", true)
            }
            val find = found?.optJSONObject("find")
            val current = find?.optInt("current") ?: 0
            val total = find?.optInt("total") ?: 0
            note("find '$FIND_QUERY': $current of $total on page ${found?.optInt("page")}")
            expect(total >= PdfViewerDemoSite.FIND_MIN_MATCHES, "the find bar counts at least ${PdfViewerDemoSite.FIND_MIN_MATCHES} matches of '$FIND_QUERY'")
            expect(waitFor("$current/$total", 8_000) != null || findNode { it.contains("$current/$total") } != null, "the find bar's counter reads $current/$total")
            SystemClock.sleep(1_200)
            snap("find")
            beat()
            val following = if (current >= total) 1 else current + 1
            val stepped = touchTapLabelExpecting("Next match", "the following match ($following of $total) is current", timeoutMs = 8_000) {
                (report(tabId)?.optJSONObject("find")?.optInt("current") ?: 0) == following
            }
            note("find next: ${if (stepped) "took" else "did not take"}; ${report(tabId)?.optJSONObject("find")}")
            SystemClock.sleep(800)
            val closed = touchTapLabelExpecting("Close find bar", "the search is over and the viewer's bar is back", timeoutMs = 8_000) {
                report(tabId)?.isNull("find") == true && findByLabelPrefix("Zoom") != null
            }
            note("close find bar: ${if (closed) "took" else "did not take"}")
            awaitIme(false)
        }
        SystemClock.sleep(800)

        // 7. Contents: the document's outline as a sheet, one entry per page with its page number
        //    trailing; a finger on the last entry leads to the last page.
        val outline = report(tabId)?.optJSONArray("outline")
        val entries = (0 until (outline?.length() ?: 0)).map { outline!!.getJSONObject(it) }
        note("outline: ${entries.joinToString { "${it.optString("title")} -> ${it.optInt("page")}" }}")
        expect(entries.size == PAGES, "the outline has an entry per page")
        val last = entries.lastOrNull()
        if (last != null) {
            val lastLabel = "${last.optString("title")}, page ${last.optInt("page")}"
            val contents = touchTapLabelExpecting("Contents", "the Contents sheet lists ${last.optString("title")}") {
                findByLabel(lastLabel) != null
            }
            if (contents) {
                SystemClock.sleep(1_200)
                snap("contents-sheet")
                beat()
                val there = touchTapLabelExpecting(lastLabel, "the viewer is on page ${last.optInt("page")}", timeoutMs = 8_000) {
                    report(tabId)?.optInt("page") == last.optInt("page")
                }
                note("outline's last entry: ${if (there) "took" else "did not take"}")
                awaitSurface(false)
                expect(waitFor(pageIndicator(last.optInt("page"), pageCount), 8_000) != null, "the bar's page indicator reads ${last.optInt("page")} / $pageCount")
                SystemClock.sleep(1_000)
                snap("outline-last-page")
                beat()
            }
        }

        // 8. More options: the overflow named by the document; Rotate turns every page a quarter
        //    turn (the first page's box wider than tall), then Open with brings the system's
        //    chooser over the apps that take a PDF (Chrome's way out of the viewer).
        val portrait = pageBox()
        note("page box before rotate: $portrait")
        val more = touchTapLabelExpecting("More options", "the overflow sheet is up") { findByLabel("Rotate") != null }
        if (more) {
            SystemClock.sleep(1_200)
            snap("more-sheet")
            beat()
            val rotated = touchTapLabelExpecting("Rotate", "the pages turned (wider than tall)", timeoutMs = 10_000) {
                pageBox()?.let { it.first > it.second } ?: false
            }
            note("rotate: ${if (rotated) "took" else "did not take"}; page box ${pageBox()}")
            awaitSurface(false)
            SystemClock.sleep(1_500)
            snap("rotated")
            beat()
        }
        val moreAgain = touchTapLabelExpecting("More options", "the overflow sheet is up again") { findByLabel("Open with") != null }
        if (moreAgain) {
            val chooser = touchTapLabelExpecting("Open with", "the system chooser is in front", timeoutMs = 12_000) {
                ui.rootInActiveWindow?.packageName?.toString().let { it != null && it != app.packageName }
            }
            if (chooser) {
                SystemClock.sleep(3_000)
                snap("open-with")
                beat()
                back()
                SystemClock.sleep(1_500)
                ensureForeground()
            }
        }

        // 9. Share on the bar: the system's share sheet with the file (another package's window).
        val shared = touchTapLabelExpecting("Share", "the system share sheet is in front", timeoutMs = 12_000) {
            ui.rootInActiveWindow?.packageName?.toString().let { it != null && it != app.packageName }
        }
        if (shared) {
            SystemClock.sleep(3_000)
            snap("share-sheet")
            beat()
            back()
            SystemClock.sleep(1_500)
            ensureForeground()
        }

        // 10. Back in the viewer, still on its page: the report and the bar stand.
        val after = awaitReport(tabId, 5_000) { it.optString("state") == "ready" }
        note("after the sheets: page ${after?.optInt("page")}, zoom ${after?.optDouble("zoom")}")
        expect(findNode { it.startsWith("Page ") && it.endsWith("Go to page") } != null, "the viewer's bar is back under the pages")
        snap("viewer-after")
    }

    // --- the viewer's word -----------------------------------------------------------------------

    /** The viewer's last report for the tab (`pdf.state`), or null before it made one. */
    private fun report(tabId: String): JSONObject? {
        val raw = coreInvoke("pdf.state", """{"tabId":${JSONObject.quote(tabId)}}""")
        return if (raw == "null" || raw.isEmpty()) null else JSONObject(raw)
    }

    /** Poll the report until `holds` does, up to `timeoutMs`; the report then, or null. */
    private fun awaitReport(tabId: String, timeoutMs: Long, holds: (JSONObject) -> Boolean): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: JSONObject? = null
        while (SystemClock.uptimeMillis() < deadline) {
            last = report(tabId)
            if (last != null && holds(last)) return last
            SystemClock.sleep(200)
        }
        Log.w(tag, "the report did not come to hold in ${timeoutMs}ms; last: $last")
        return null
    }

    /** The bar's page indicator, as it names itself for the reader. */
    private fun pageIndicator(page: Int, pageCount: Int): String = "Page $page of $pageCount. Go to page"

    /** The first page's box in the viewer document (CSS px), width to height; null without one. */
    private fun pageBox(): Pair<Int, Int>? {
        val raw = tabJs("(function(){var p=document.querySelector('.zen-pdf-page');return p?p.clientWidth+'x'+p.clientHeight:''})()")
        val parts = raw.split('x')
        if (parts.size != 2) return null
        val w = parts[0].toIntOrNull() ?: return null
        val h = parts[1].toIntOrNull() ?: return null
        return w to h
    }

    /** Evaluate in the active tab's WebView (the viewer document, not the chrome); the value as text. */
    private fun tabJs(code: String): String {
        val tabId = activeCoreTab()?.optString("id") ?: return ""
        val host = (activity as MainActivity).host
        val tab = host.tabs.get(tabId) ?: return ""
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return runCatching { (JSONTokener(result).nextValue() as? String) ?: result }.getOrDefault(result)
    }

    /** Wait for the active tab to be at `url` (the seeded page loaded and committed). */
    private fun awaitTabUrl(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optString("url") == url) return true
            SystemClock.sleep(500)
        }
        return false
    }

    // --- the chrome's fields ---------------------------------------------------------------------

    /**
     * The field a label names: the tree lists a label's text and its field as siblings under the
     * form's row, so the field is the first editable node after the label in the same parent
     * (else the first editable node on screen).
     */
    private fun fieldNear(label: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val parent = label.parent ?: return editText()
        var seen = false
        for (i in 0 until parent.childCount) {
            val child = parent.getChild(i) ?: continue
            if (child == label) {
                seen = true
                continue
            }
            if (seen && child.isEditable) return child
            for (j in 0 until child.childCount) child.getChild(j)?.takeIf { it.isEditable }?.let { return it }
        }
        return editText()
    }

    /** The first editable node on screen (a sheet's one field). */
    private fun editText(): AccessibilityNodeInfo? = findNodeWhere { it.isEditable }

    /** Whether the chrome's focused element is a field of one of `modes` (its inputmode, else its type), within the time. */
    private fun awaitChromeFocus(vararg modes: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chromeJs("(function(){var e=document.activeElement;return e&&e.tagName==='INPUT'?(e.inputMode||e.type||''):''})()")
            val kind = runCatching { (JSONTokener(raw).nextValue() as? String) ?: "" }.getOrDefault("")
            if (kind in modes) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** Whether the chrome's focused field holds `value` once the keys have landed. */
    private fun awaitChromeValue(value: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chromeJs("(function(){var e=document.activeElement;return e&&'value' in e?e.value:''})()")
            val held = runCatching { (JSONTokener(raw).nextValue() as? String) ?: "" }.getOrDefault("")
            if (held == value) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** Type into the focused field, one character's events at a time (each stamped as it goes). */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                val now = SystemClock.uptimeMillis()
                val stamped = KeyEvent(
                    now, now, event.action, event.keyCode, event.repeatCount, event.metaState,
                    KeyCharacterMap.VIRTUAL_KEYBOARD, event.scanCode, event.flags, InputDevice.SOURCE_KEYBOARD
                )
                ui.injectInputEvent(stamped, true)
                SystemClock.sleep(25)
            }
        }
        SystemClock.sleep(200)
    }

    // --- evidence --------------------------------------------------------------------------------

    /** A numbered screenshot: `NN-name`, counting up through the demo. */
    private fun snap(name: String) = shot("%02d-%s".format(++shots, name))

    private fun note(line: String) {
        Log.i(tag, line)
        findings.appendText("$line\n")
    }

    /** A claim of a step: noted, and a [touchFault] when it does not hold (the run fails at the end). */
    private fun expect(holds: Boolean, claim: String) {
        note((if (holds) "ok: " else "FAILED: ") + claim)
        if (!holds) touchFault(claim)
    }

    companion object {
        private const val ORIGIN = PdfViewerDemoSite.ORIGIN
        private const val FIND_QUERY = PdfViewerDemoSite.FIND_QUERY
        private val PAGES = PdfViewerDemoSite.PDF_PAGES.size
        /** The zoom sheet's fits, as `PDF_FIT_LABELS` names them. */
        private const val FIT_WIDTH = "Fit to width"
        private const val FIT_PAGE = "Fit to page"
    }
}
