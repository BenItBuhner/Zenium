package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Drives the inline PDF viewer (`zen://pdf`, CT-02 on the phone) so the `android-pdf-viewer-demo`
 * workflow can record it on an emulator. A page of the loopback [DemoServer] links to a PDF the
 * server sends as `application/pdf`; a finger on the link has the WebView hand the response to
 * the downloader (the engine draws no PDF), the row completes, and the tab opens the file in the
 * viewer instead of the system chooser. Then the viewer under real fingers and the chrome's
 * commands: a pinch out zooms the pages, Fit width brings them back, a fling scrolls to the
 * next page, find counts the matches of "tide" and marks them, the outline's last entry leads
 * to its page, Share brings the system's share sheet with the file and Open with its chooser.
 *
 * The document is exactly known ([DemoPdf]: three A4 pages, a title, an outline, a link), so
 * every step asserts on what the viewer reports (`pdf.state`, the same report the chrome draws
 * its controls from). The engine PR's run: the viewer's own surfaces come with the UI PR, which
 * presses the same commands from the chrome's controls. Findings land in
 * `pdf-viewer-findings.txt` next to the screenshots (`services-print-pdf-android-NN-*.png`).
 */
@RunWith(AndroidJUnit4::class)
class PdfViewerDemo : DemoHarness("pdf-viewer-demo-state.json", "services-print-pdf-android", "pdf-viewer-demo") {
    override val tag = "PdfViewerDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var shots = 0

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        Log.i(tag, "demo server: ${server.selfCheck()}")
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** The page offering the file, and the file itself as a PDF response without a disposition. */
    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to DemoServer.page(
            PAGE_TITLE,
            "<p>The week's tide tables for the estuary, as a PDF.</p>" +
                "<p><a href=\"/tide-tables.pdf\">$LINK_TEXT</a></p>" +
                "<p>A PDF the tab navigates to opens in Zenium's viewer, as in Chrome.</p>"
        ),
        "/tide-tables.pdf" to ("application/pdf" to DemoPdf.build(PDF_TITLE, PDF_PAGES, "$ORIGIN/"))
    )

    /** The seeded tab points at the loopback page, so nothing in the run depends on the network. */
    override fun patchState(json: String): String = json.replace(PAGE_PLACEHOLDER, "$ORIGIN/")

    override fun warmUp() {
        findings = File(out, "pdf-viewer-findings.txt")
        findings.writeText("PDF viewer demo (engine): ${server.origin}\n")
        if (!awaitTabUrl("$ORIGIN/", 20_000)) Log.w(tag, "the demo page did not become the active tab's address in time")
        // The link's node in the tree: the page is on screen once it is.
        if (waitFor(LINK_TEXT, 15_000) == null) Log.w(tag, "no link node on the demo page yet")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        // 1. The page offering the PDF.
        snap("page")
        beat()

        // 2. A finger on the link: the response is a PDF, so the WebView hands it to the downloader
        //    as a navigation's file; the download completes and the tab shows it in the viewer
        //    (the effect asserted under the touch, the rule in DemoHarness).
        val opened = touchTapLabelExpecting(LINK_TEXT, "the tab shows zen://pdf", timeoutMs = 30_000) {
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
        note("viewer ready: ${ready.optInt("pageCount")} pages, title ${ready.optString("title")}, zoom ${ready.optDouble("zoom")}, fit ${ready.optString("fit")}")
        expect(ready.optInt("pageCount") == PDF_PAGES.size, "the viewer counts ${PDF_PAGES.size} pages")
        expect(ready.optString("title") == PDF_TITLE, "the viewer reads the document's title")
        expect(ready.optString("fit") == "width", "the viewer opens fitted to the width, as Chrome does")
        val download = downloadRow()
        note("download row: ${download?.optString("filename")} ${download?.optString("state")} ${download?.optString("mimeType")}")
        expect(download?.optString("state") == "completed", "the file is a completed row in Downloads")
        SystemClock.sleep(1_500)
        snap("viewer-fit-width")
        beat()

        // 3. Two fingers moving apart over the page: the viewer's own pinch zooms the pages about
        //    the fingers (the WebView's pinch is off for the document), and the report follows.
        val before = ready.optDouble("zoom")
        pinch(width * 0.5f, height * 0.45f, 90 * density, 340 * density, 800)
        val zoomed = awaitReport(tabId, 8_000) { it.optDouble("zoom") > before * 1.3 }
        if (zoomed == null) touchFault("a pinch out over the pages did not zoom them (zoom stayed at $before)")
        note("after the pinch: zoom ${zoomed?.optDouble("zoom")}, fit ${zoomed?.optString("fit")}")
        expect(zoomed?.isNull("fit") ?: false, "a free zoom leaves the fit")
        SystemClock.sleep(1_500)
        snap("pinched")
        beat()

        // 4. Fit width from the chrome's command: back to the page's width.
        command(tabId, """{"kind":"fit","mode":"width"}""")
        val fitted = awaitReport(tabId, 8_000) { it.optString("fit") == "width" }
        expect(fitted != null, "Fit width takes the pages back to the width")
        note("fit width: zoom ${fitted?.optDouble("zoom")}")
        SystemClock.sleep(1_200)

        // 5. A finger flings the pages up: the next page comes into view and the report says so.
        Finger().apply {
            down(width * 0.5f, height * 0.75f)
            moveBy(0f, -height * 0.55f, 220)
            up()
        }
        val second = awaitReport(tabId, 8_000) { it.optInt("page") >= 2 }
        if (second == null) touchFault("a fling up the pages did not reach page 2")
        note("after the fling: page ${second?.optInt("page")}")
        SystemClock.sleep(1_500)
        snap("page-2")
        beat()

        // 6. Find "tide": every match counted and marked on its page, the first one ahead of the
        //    page in view current as soon as it is found (Chrome's find), the tally final once
        //    every page has been read (`searching` false) – the baseline for Next.
        command(tabId, """{"kind":"find","query":"$FIND_QUERY","direction":"new"}""")
        val found = awaitReport(tabId, 10_000) {
            val find = it.optJSONObject("find")
            find != null && find.optInt("total") > 0 && !find.optBoolean("searching", true)
        }
        val find = found?.optJSONObject("find")
        val current = find?.optInt("current") ?: 0
        val total = find?.optInt("total") ?: 0
        note("find '$FIND_QUERY': $current of $total on page ${found?.optInt("page")}")
        expect(total >= FIND_MIN_MATCHES, "find counts at least $FIND_MIN_MATCHES matches of '$FIND_QUERY'")
        expect(current in 1..total, "a match is current once the search has read every page")
        SystemClock.sleep(1_500)
        snap("find")
        beat()
        command(tabId, """{"kind":"find","query":"$FIND_QUERY","direction":"next"}""")
        val following = if (current >= total) 1 else current + 1
        val next = awaitReport(tabId, 8_000) { (it.optJSONObject("find")?.optInt("current") ?: 0) == following }
        expect(next != null, "Next steps to the following match ($following of $total)")
        note("find next: ${next?.optJSONObject("find")?.optInt("current")} of ${next?.optJSONObject("find")?.optInt("total")}")
        command(tabId, """{"kind":"stopFind"}""")
        awaitReport(tabId, 5_000) { it.isNull("find") }

        // 7. The outline: one entry per page; its last leads to the last page.
        val outline = found?.optJSONArray("outline") ?: ready.optJSONArray("outline")
        val entries = (0 until (outline?.length() ?: 0)).map { outline!!.getJSONObject(it) }
        note("outline: ${entries.joinToString { "${it.optString("title")} -> ${it.optInt("page")}" }}")
        expect(entries.size == PDF_PAGES.size, "the outline has an entry per page")
        val last = entries.lastOrNull()
        if (last != null) {
            command(tabId, """{"kind":"goTo","page":${last.optInt("page")}}""")
            val there = awaitReport(tabId, 8_000) { it.optInt("page") == last.optInt("page") }
            expect(there != null, "the outline's last entry leads to page ${last.optInt("page")}")
            SystemClock.sleep(1_500)
            snap("outline-last-page")
            beat()
        }

        // 8. Share: the system's share sheet with the file (another package's window in front).
        coreInvoke("pdf.share", """{"tabId":${JSONObject.quote(tabId)}}""")
        val shared = awaitSystemWindow(12_000)
        expect(shared, "Share brings the system share sheet")
        if (shared) {
            SystemClock.sleep(3_000)
            snap("share-sheet")
            beat()
            back()
            SystemClock.sleep(1_500)
            ensureForeground()
        }

        // 9. Open with: the system's chooser over the apps that take a PDF (the way out of the
        //    viewer; the emulator's image may have none, and the chooser says so).
        coreInvoke("pdf.openWith", """{"tabId":${JSONObject.quote(tabId)}}""")
        val chooser = awaitSystemWindow(12_000)
        expect(chooser, "Open with brings the system chooser")
        if (chooser) {
            SystemClock.sleep(3_000)
            snap("open-with")
            beat()
            back()
            SystemClock.sleep(1_500)
            ensureForeground()
        }

        // 10. Back in the viewer, still on its page: the report stands.
        val after = awaitReport(tabId, 5_000) { it.optString("state") == "ready" }
        note("after the sheets: page ${after?.optInt("page")}, zoom ${after?.optDouble("zoom")}")
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

    /** Drive the viewer as the chrome's controls do (`pdf.command`); the viewer must take it. */
    private fun command(tabId: String, command: String) {
        val taken = coreInvoke("pdf.command", """{"tabId":${JSONObject.quote(tabId)},"command":$command}""")
        if (taken != "true") touchFault("the viewer did not take the command $command ($taken)")
    }

    /** The PDF's row in Downloads per the core's state. */
    private fun downloadRow(): JSONObject? {
        val downloads = coreState().optJSONArray("downloads") ?: return null
        for (i in 0 until downloads.length()) {
            val row = downloads.getJSONObject(i)
            if (row.optString("url").endsWith("/tide-tables.pdf")) return row
        }
        return null
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
        private const val PORT = 18147
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** Stands for the page's address in the seeded profile until the server has started. */
        private const val PAGE_PLACEHOLDER = "http://pdf-viewer-demo.invalid/"
        private const val PAGE_TITLE = "Tide tables"
        private const val LINK_TEXT = "Tide tables for the week (PDF)"
        private const val PDF_TITLE = "Tide tables, week 38"
        private const val FIND_QUERY = "tide"
        /** "tide" in the headings and lines below, case aside (the find is case-insensitive). */
        private const val FIND_MIN_MATCHES = 6
        private val PDF_PAGES = listOf(
            "Tide tables" to listOf(
                "The tide turns twice a day on this coast.",
                "High tide at 06:12 and 18:40; low tide at 12:26.",
                "Springs this week: the tide runs strongest at the narrows."
            ),
            "High water" to listOf(
                "High water follows the moon by about fifty minutes a day.",
                "Each tide is listed with its height in metres above datum."
            ),
            "Low water" to listOf(
                "Low water uncovers the flats for two hours either side.",
                "Check the tide before crossing to the island."
            )
        )
    }
}
