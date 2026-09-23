package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageMessagesTest {
    private val token = "s3cret"

    private fun message(vararg pairs: Pair<String, Any?>): String =
        json("token" to token, *pairs).toString()

    @Test
    fun messagesWithoutThisSessionsTokenAreIgnored() {
        assertEquals(PageMessageRoute.Ignore, routePageMessage(null, token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("not json", token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("""{"type":"domReady"}""", token))
        assertEquals(PageMessageRoute.Ignore, routePageMessage("""{"token":"other","type":"domReady"}""", token))
    }

    @Test
    fun helloEvalResultAndDomReadyAreTheViewsOwn() {
        assertEquals(PageMessageRoute.Hello, routePageMessage(message("type" to "hello"), token))
        assertEquals(
            PageMessageRoute.EvalResult(7, "\"title\""),
            routePageMessage(message("type" to "evalResult", "id" to 7, "value" to "\"title\""), token)
        )
        assertEquals(
            PageMessageRoute.EvalResult(8, null),
            routePageMessage(message("type" to "evalResult", "id" to 8, "value" to null), token)
        )
        assertEquals(PageMessageRoute.DomReady, routePageMessage(message("type" to "domReady"), token))
    }

    @Test
    fun aFullscreenReportIsTheHostsOwnWithItsVideoSize() {
        assertEquals(
            PageMessageRoute.Fullscreen(true, 1920, 1080, video = true),
            routePageMessage(message("type" to "fullscreen", "active" to true, "video" to true, "videoWidth" to 1920, "videoHeight" to 1080), token)
        )
        // Fullscreen ended, or an element without a video: no size, no video.
        assertEquals(PageMessageRoute.Fullscreen(false, 0, 0, video = false), routePageMessage(message("type" to "fullscreen", "active" to false, "video" to false), token))
        assertEquals(
            PageMessageRoute.Fullscreen(true, 0, 0, video = false),
            routePageMessage(message("type" to "fullscreen", "active" to true, "video" to false, "videoWidth" to 0, "videoHeight" to 0), token)
        )
        // A video whose size is not known yet (MED-03 reads the word, MED-01 waits for the size).
        assertEquals(
            PageMessageRoute.Fullscreen(true, 0, 0, video = true),
            routePageMessage(message("type" to "fullscreen", "active" to true, "video" to true, "videoWidth" to 0, "videoHeight" to 0), token)
        )
        // A size that makes no sense is read as none known; a report without the word has a video where it has a size.
        assertEquals(
            PageMessageRoute.Fullscreen(true, 0, 0, video = false),
            routePageMessage(message("type" to "fullscreen", "active" to true, "videoWidth" to -4, "videoHeight" to "wide"), token)
        )
        assertEquals(
            PageMessageRoute.Fullscreen(true, 1280, 720, video = true),
            routePageMessage(message("type" to "fullscreen", "active" to true, "videoWidth" to 1280, "videoHeight" to 720), token)
        )
    }

    @Test
    fun aFrameIsHeardOnItsOwnFullscreenAlone() {
        // An embed's document (a YouTube iframe) is the one that sees its video go fullscreen,
        // and its size; the main document sees the <iframe>, 0 x 0.
        val fullscreen = routePageMessage(message("type" to "fullscreen", "active" to true, "videoWidth" to 1280, "videoHeight" to 720), token)
        assertTrue(fullscreen.heardFrom(isMainFrame = false))
        assertTrue(fullscreen.heardFrom(isMainFrame = true))
        // A frame's capture report is heard (NOT-13): an embedded meeting holds the microphone as
        // much as the top document does, and the core folds the frames' reports by their ids.
        val capture = routePageMessage(
            message("type" to "capture-state", "capture" to json("id" to "f1", "microphone" to true)),
            token
        )
        assertTrue(capture is PageMessageRoute.Forward)
        assertTrue(capture.heardFrom(isMainFrame = false))
        assertTrue(capture.heardFrom(isMainFrame = true))
        // Everything else a frame says – its hello (the reply channel is the main document's), its
        // DOMContentLoaded, its forwarded messages – is not the page's.
        for (type in listOf("hello", "domReady", "media", "evalResult")) {
            val route = routePageMessage(message("type" to type, "id" to 1), token)
            assertFalse("a frame's '$type' is dropped", route.heardFrom(isMainFrame = false))
            assertTrue("the main document's '$type' is heard", route.heardFrom(isMainFrame = true))
        }
        assertFalse(PageMessageRoute.Ignore.heardFrom(isMainFrame = false))
    }

    @Test
    fun anythingElseGoesToTheCoreWithoutTheToken() {
        val route = routePageMessage(message("type" to "media", "playing" to true), token)
        assertTrue(route is PageMessageRoute.Forward)
        val forwarded = (route as PageMessageRoute.Forward).message
        assertFalse(forwarded.has("token"))
        assertEquals("media", forwarded.getString("type"))
        assertTrue(forwarded.getBoolean("playing"))
    }

    @Test
    fun theGateRaisesDomReadyOnceAtTheScriptsMessageAndNotAgainAtPageFinished() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.scriptReady())
        assertFalse("a second DOMContentLoaded message must not raise it again", gate.scriptReady())
        assertFalse("page finished after the script reported must not raise it again", gate.pageFinished())
    }

    @Test
    fun theGateFallsBackToPageFinishedWhenTheScriptNeverReported() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.pageFinished())
        assertFalse("a late script message after the fallback must not raise it again", gate.scriptReady())
    }

    @Test
    fun aNewDocumentArmsTheGateAgain() {
        val gate = DomReadyGate()
        gate.documentStarted()
        assertTrue(gate.scriptReady())
        gate.documentStarted()
        assertTrue("the next document gets its own domReady", gate.scriptReady())
        assertFalse(gate.pageFinished())
    }

    @Test
    fun aRestoredViewWithNoPageStartedStillRaisesOnce() {
        // A view whose first document never went through onPageStarted (loadDataWithBaseURL of a
        // zen:// page) still gets exactly one domReady at page finished.
        val gate = DomReadyGate()
        assertTrue(gate.pageFinished())
        assertFalse(gate.pageFinished())
    }

    @Test
    fun thePdfViewersReportReachesTheCoreWithTheDocumentsTokenUnderItsOwnName() {
        // The viewer document's report (src/shared/pageScript.ts, installPdfViewerRelay) carries
        // the document's token as `pdfToken`: `token` is this session's, checked here and
        // stripped, and the core takes the report only with the document's (PdfViewerService.onReport).
        val report = JSONObject().put("state", "ready").put("pageCount", 3).put("page", 1)
        val route = routePageMessage(message("type" to "pdf", "pdf" to report, "pdfToken" to "doc-1"), token)
        assertTrue(route is PageMessageRoute.Forward)
        val forwarded = (route as PageMessageRoute.Forward).message
        assertEquals("pdf", forwarded.getString("type"))
        assertEquals("doc-1", forwarded.getString("pdfToken"))
        assertEquals("ready", forwarded.getJSONObject("pdf").getString("state"))
        assertFalse(forwarded.has("token"))
        // A report whose own token took the `token` field (the shape #258 relayed, which the
        // page script's spread let displace the session's) is a forgery to this router: dropped,
        // and the viewer never reported ready (#332's nightly).
        assertEquals(
            PageMessageRoute.Ignore,
            routePageMessage(json("token" to "doc-1", "type" to "pdf", "pdf" to report).toString(), token)
        )
    }

    @Test
    fun forwardedMessagesKeepTheirPayloadIntact() {
        val payload = JSONObject().put("a", 1).put("b", JSONObject().put("c", "d"))
        val route = routePageMessage(message("type" to "custom", "payload" to payload), token)
        val forwarded = (route as PageMessageRoute.Forward).message
        assertEquals(1, forwarded.getJSONObject("payload").getInt("a"))
        assertEquals("d", forwarded.getJSONObject("payload").getJSONObject("b").getString("c"))
    }
}
