package app.zen.chromium.blocking

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The listener registry over `shouldInterceptRequest`: ordering, details, filters and composition. */
class WebRequestTest {
    private class FakeTab(
        override val tabId: String = "tab-1",
        override var documentUrl: String? = "https://news.example:8443/story?x=1",
        override val containerId: String = "default"
    ) : BlockingTab {
        var blocked = 0
        val documentsBlocked = ArrayList<String>()
        val redirects = ArrayList<String>()

        override fun onRequestsBlocked(count: Int) {
            blocked += count
        }

        override fun onDocumentBlocked(url: String) {
            documentsBlocked.add(url)
        }

        override fun onDocumentRedirected(url: String) {
            redirects.add(url)
        }
    }

    private val snapshot = EngineSnapshot(emptyList(), TextEngine.parse(listOf("||tracker.net^\$third-party")))
    private val headers = mapOf("Accept" to "*/*", "User-Agent" to "Zenium")

    private fun options(registrant: String, priority: Int = 0, blocking: Boolean = true, filter: ListenerFilter? = null) =
        ListenerOptions(registrant, priority, blocking, filter)

    private fun run(
        listeners: WebRequestListeners,
        url: String,
        tab: FakeTab = FakeTab(),
        isMainFrame: Boolean = false,
        requestHeaders: Map<String, String> = headers,
        snap: EngineSnapshot = snapshot
    ): Verdict = Blocking.evaluate(snap, listeners, tab, url, isMainFrame, requestHeaders, "GET")

    @Test
    fun listenersRunByPriorityThenRegistrantThenRegistrationOrder() {
        val registry = WebRequestListeners()
        val calls = ArrayList<String>()
        fun add(registrant: String, priority: Int, tag: String) {
            registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { calls.add(tag); null }, options(registrant, priority, blocking = false))
        }
        add("ext-b", 0, "b1")
        add("ext-a", 0, "a1")
        add("ext-c", 5, "c1")
        add("ext-b", 0, "b2")
        add("ext-a", 0, "a2")
        assertEquals(
            listOf("ext-c" to false, "ext-a" to false, "ext-a" to false, "ext-b" to false, "ext-b" to false),
            registry.listenerOrder(WebRequestEvent.ON_BEFORE_REQUEST)
        )
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js"))
        assertEquals(listOf("c1", "a1", "a2", "b1", "b2"), calls)
    }

    @Test
    fun blockingListenersOnlyOnEventsWithABlockingVariant() {
        val registry = WebRequestListeners()
        val refused = runCatching {
            registry.addListener(WebRequestEvent.ON_SEND_HEADERS, { null }, options("ext", blocking = true))
        }.exceptionOrNull()
        assertTrue(refused is IllegalArgumentException)
        // The desktop's blocking events accept blocking listeners here too, even the ones WebView never fires.
        registry.addListener(WebRequestEvent.ON_HEADERS_RECEIVED, { null }, options("ext", blocking = true))
        registry.addListener(WebRequestEvent.ON_BEFORE_SEND_HEADERS, { null }, options("ext", blocking = true))
        assertTrue(registry.hasListeners(WebRequestEvent.ON_HEADERS_RECEIVED))
        assertFalse(WebRequestEvent.ON_HEADERS_RECEIVED.fires)
        assertFalse(WebRequestEvent.ON_BEFORE_SEND_HEADERS.fires)
        assertEquals(
            listOf("onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"),
            WebRequestEvent.entries.map { it.wireName }
        )
        assertEquals(WebRequestEvent.ON_COMPLETED, WebRequestEvent.fromWireName("onCompleted"))
        assertEquals(setOf(WebRequestEvent.ON_BEFORE_REQUEST, WebRequestEvent.ON_SEND_HEADERS, WebRequestEvent.ON_ERROR_OCCURRED), WebRequestEvent.entries.filter { it.fires }.toSet())
    }

    @Test
    fun detailsAreShapedLikeChromiums() {
        val registry = WebRequestListeners()
        val seen = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { seen.add(it); null }, options("ext", blocking = false))
        val before = System.currentTimeMillis()
        val tab = FakeTab(tabId = "tab-9", containerId = "work")
        run(registry, "https://cdn.example/pixel.png", tab, requestHeaders = mapOf("Accept" to "image/avif,image/webp,*/*"))
        run(registry, "https://news.example/next", tab, isMainFrame = true, requestHeaders = mapOf("Accept" to "text/html"))
        assertEquals(2, seen.size)
        val sub = seen[0]
        assertEquals(WebRequestEvent.ON_BEFORE_REQUEST, sub.event)
        assertEquals("https://cdn.example/pixel.png", sub.url)
        assertEquals("GET", sub.method)
        assertEquals(ResourceType.IMAGE, sub.resourceType)
        assertEquals(-1, sub.frameId)
        assertEquals(-1, sub.parentFrameId)
        assertEquals("tab-9", sub.tabId)
        assertEquals("work", sub.partition)
        assertEquals("https://news.example:8443", sub.initiator)
        assertEquals("https://news.example:8443/story?x=1", sub.documentUrl)
        assertTrue(sub.timestamp >= before)
        assertNull(sub.requestHeaders)
        assertNull(sub.responseHeaders)
        val main = seen[1]
        assertEquals(ResourceType.MAIN_FRAME, main.resourceType)
        assertEquals(0, main.frameId)
        assertEquals(-1, main.parentFrameId)
        assertNull(main.initiator)
        assertNull(main.documentUrl)
        assertNotEquals(sub.requestId, main.requestId)
    }

    @Test
    fun filtersSelectByTypeTabPartitionAndUrl() {
        val registry = WebRequestListeners()
        val seen = HashMap<String, ArrayList<String>>()
        fun add(tag: String, filter: ListenerFilter) {
            registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { seen.getOrPut(tag) { ArrayList() }.add(it.url); null }, options(tag, blocking = false, filter = filter))
        }
        add("scripts", ListenerFilter(types = setOf(ResourceType.SCRIPT)))
        add("images", ListenerFilter(types = setOf(ResourceType.IMAGE)))
        add("tab-2", ListenerFilter(tabId = "tab-2"))
        add("private", ListenerFilter(partition = "private"))
        add("cdn", ListenerFilter(url = { it.startsWith("https://cdn.example/") }))
        run(registry, "https://cdn.example/a.js", FakeTab(), requestHeaders = mapOf("Accept" to "*/*"))
        run(registry, "https://img.example/b.png", FakeTab(tabId = "tab-2"), requestHeaders = mapOf("Accept" to "image/*"))
        run(registry, "https://api.example/c", FakeTab(containerId = "private"), requestHeaders = mapOf("Accept" to "*/*"))
        // A request of unknown kind may be a script: the script filter sees it, the image filter does not.
        assertEquals(listOf("https://cdn.example/a.js", "https://api.example/c"), seen["scripts"])
        assertEquals(listOf("https://img.example/b.png"), seen["images"])
        assertEquals(listOf("https://img.example/b.png"), seen["tab-2"])
        assertEquals(listOf("https://api.example/c"), seen["private"])
        assertEquals(listOf("https://cdn.example/a.js"), seen["cdn"])
    }

    @Test
    fun theEngineDecidesFirstAndBlockedRequestsAreReportedAsErrors() {
        val registry = WebRequestListeners()
        var offered = 0
        val errors = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { offered++; BlockingResponse(redirectUrl = "https://elsewhere.example/") }, options("ext"))
        registry.addListener(WebRequestEvent.ON_ERROR_OCCURRED, { errors.add(it); null }, options("ext", blocking = false))
        val tab = FakeTab()
        val verdict = run(registry, "https://tracker.net/t.js", tab)
        assertTrue(verdict is Verdict.Empty)
        assertEquals(403, (verdict as Verdict.Empty).status)
        assertEquals(0, offered)
        assertEquals(1, tab.blocked)
        assertEquals(1, errors.size)
        assertEquals(WebRequestEvent.ON_ERROR_OCCURRED, errors[0].event)
        assertEquals("net::ERR_BLOCKED_BY_CLIENT", errors[0].error)
        assertEquals("https://tracker.net/t.js", errors[0].url)
    }

    @Test
    fun anyCancelWinsAndACancelledRequestIsReportedBlocked() {
        val registry = WebRequestListeners()
        val errors = ArrayList<WebRequestDetails>()
        val sent = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "https://a.example/") }, options("ext-a", priority = 9))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(cancel = true) }, options("ext-b"))
        registry.addListener(WebRequestEvent.ON_ERROR_OCCURRED, { errors.add(it); null }, options("ext-a", blocking = false))
        registry.addListener(WebRequestEvent.ON_SEND_HEADERS, { sent.add(it); null }, options("ext-a", blocking = false))
        val tab = FakeTab()
        val sub = run(registry, "https://cdn.example/app.js", tab)
        assertTrue(sub is Verdict.Empty)
        assertEquals(403, (sub as Verdict.Empty).status)
        // The tab's counter is the engine's: an extension's cancel is not an ad blocked.
        assertEquals(0, tab.blocked)
        val main = run(registry, "https://news.example/next", tab, isMainFrame = true, requestHeaders = mapOf("Accept" to "text/html"))
        assertTrue(main is Verdict.Empty)
        assertEquals(204, (main as Verdict.Empty).status)
        assertEquals(listOf("https://news.example/next"), tab.documentsBlocked)
        assertEquals(listOf("net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_CLIENT"), errors.map { it.error })
        assertTrue(sent.isEmpty())
        assertTrue(registry.conflicts.isEmpty())
    }

    @Test
    fun cancelStyleRedirectsBeatOthersAndBecomeBodies() {
        val registry = WebRequestListeners()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "https://cdn.example/other.js") }, options("ext-a", priority = 9))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "data:application/javascript,void%200%3B") }, options("ext-b"))
        val verdict = run(registry, "https://cdn.example/app.js")
        assertTrue(verdict is Verdict.Body)
        val body = verdict as Verdict.Body
        assertEquals("application/javascript", body.mimeType)
        assertNull(body.charset)
        assertEquals("void 0;", String(body.bytes, Charsets.UTF_8))
        assertTrue(registry.conflicts.isEmpty())
        assertTrue(registry.unsupported.isEmpty())
    }

    @Test
    fun aboutBlankIsAnEmptyHtmlBody() {
        val registry = WebRequestListeners()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "about:blank") }, options("ext"))
        val verdict = run(registry, "https://ads.example/frame", requestHeaders = mapOf("Accept" to "text/html"))
        assertTrue(verdict is Verdict.Body)
        assertEquals("text/html", (verdict as Verdict.Body).mimeType)
        assertEquals(0, verdict.bytes.size)
    }

    @Test
    fun differingRedirectsAreConflictsAndOnlyANavigationCanFollowOne() {
        val registry = WebRequestListeners()
        val sent = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "https://b.example/") }, options("ext-b"))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "https://a.example/") }, options("ext-a", priority = 1))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(redirectUrl = "https://a.example/") }, options("ext-c"))
        registry.addListener(WebRequestEvent.ON_SEND_HEADERS, { sent.add(it); null }, options("ext-a", blocking = false))
        val tab = FakeTab()
        // A subresource: WebView cannot redirect it, so the request goes out as it was.
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js", tab))
        assertEquals(listOf("ext-b"), registry.conflicts.map { it.registrant })
        assertEquals(listOf("ext-a" to "redirectUrl"), registry.unsupported.map { it.registrant to it.what })
        assertEquals(1, sent.size)
        assertEquals(headers, sent[0].requestHeaders)
        // A navigation: the tab loads the winning target.
        val main = run(registry, "https://news.example/next", tab, isMainFrame = true, requestHeaders = mapOf("Accept" to "text/html"))
        assertTrue(main is Verdict.Empty)
        assertEquals(204, (main as Verdict.Empty).status)
        assertEquals(listOf("https://a.example/"), tab.redirects)
        assertEquals(1, sent.size)
    }

    @Test
    fun aRedirectToTheRequestItselfIsNoRedirect() {
        val answers = listOf(
            Answer("ext-a", BlockingResponse(redirectUrl = "https://cdn.example/app.js")),
            Answer("ext-b", BlockingResponse(redirectUrl = "https://b.example/"))
        )
        val conflicts = ArrayList<String>()
        assertEquals("https://b.example/", WebRequestListeners.mergeRedirect("https://cdn.example/app.js", answers) { conflicts.add(it) })
        assertTrue(conflicts.isEmpty())
        assertNull(WebRequestListeners.mergeRedirect("https://cdn.example/app.js", answers.take(1)))
        val composed = WebRequestListeners.composeBeforeRequest("https://cdn.example/app.js", answers)
        assertFalse(composed.cancel)
        assertEquals("https://b.example/", composed.redirectUrl)
        assertEquals("ext-b", composed.redirectedBy)
        assertTrue(WebRequestListeners.composeBeforeRequest("https://x/", listOf(Answer("e", BlockingResponse(cancel = true)))).cancel)
    }

    @Test
    fun observingListenersCannotAffectTheRequestAndSeeTheHeadersSent() {
        val registry = WebRequestListeners()
        val seen = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(cancel = true) }, options("ext", blocking = false))
        registry.addListener(WebRequestEvent.ON_SEND_HEADERS, { seen.add(it); BlockingResponse(cancel = true) }, options("ext", blocking = false))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { seen.add(it); null }, options("ext", blocking = false))
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js"))
        assertEquals(listOf(WebRequestEvent.ON_BEFORE_REQUEST, WebRequestEvent.ON_SEND_HEADERS), seen.map { it.event })
        assertEquals(seen[0].requestId, seen[1].requestId)
        assertEquals(headers, seen[1].requestHeaders)
        assertNull(seen[0].requestHeaders)
    }

    @Test
    fun headerEditsAreRecordedAsUnsupported() {
        val registry = WebRequestListeners()
        registry.addListener(
            WebRequestEvent.ON_BEFORE_REQUEST,
            { BlockingResponse(requestHeaders = mapOf("X-Test" to "1"), responseHeaders = mapOf("Set-Cookie" to listOf("a=1"))) },
            options("ext")
        )
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js"))
        assertEquals(listOf("requestHeaders", "responseHeaders"), registry.unsupported.map { it.what })
    }

    @Test
    fun webViewErrorsMapToNetErrorNamesAndCorrelateWithTheRequest() {
        val registry = WebRequestListeners()
        val seen = ArrayList<WebRequestDetails>()
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { seen.add(it); null }, options("ext", blocking = false))
        registry.addListener(WebRequestEvent.ON_ERROR_OCCURRED, { seen.add(it); null }, options("ext", blocking = false))
        val tab = FakeTab()
        assertSame(Verdict.Pass, run(registry, "https://down.example/app.js", tab))
        val record = registry.recordFor(tab, "https://down.example/app.js", "GET", false, ResourceType.SCRIPT)
        registry.errorOccurred(record, WebRequestListeners.netErrorName(-2))
        assertEquals(2, seen.size)
        assertEquals(seen[0].requestId, seen[1].requestId)
        assertEquals("net::ERR_NAME_NOT_RESOLVED", seen[1].error)
        // Once reported, the request is forgotten: a later error mints a new id.
        val fresh = registry.recordFor(tab, "https://down.example/app.js", "GET", false, ResourceType.SCRIPT)
        assertNotEquals(record.base.requestId, fresh.base.requestId)
        assertEquals("net::ERR_CONNECTION_REFUSED", WebRequestListeners.netErrorName(-6))
        assertEquals("net::ERR_CONNECTION_TIMED_OUT", WebRequestListeners.netErrorName(-8))
        assertEquals("net::ERR_TOO_MANY_REDIRECTS", WebRequestListeners.netErrorName(-9))
        assertEquals("net::ERR_BLOCKED_BY_CLIENT", WebRequestListeners.netErrorName(-16))
        assertEquals("net::ERR_FAILED", WebRequestListeners.netErrorName(-1))
        assertEquals("net::ERR_FAILED", WebRequestListeners.netErrorName(-99))
    }

    @Test
    fun aThrowingListenerIsSkippedAndTheOthersStillRun() {
        val registry = WebRequestListeners()
        val failures = ArrayList<String>()
        registry.onListenerFailure = { registrant, _ -> failures.add(registrant) }
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { throw IllegalStateException("boom") }, options("ext-a", priority = 1))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(cancel = true) }, options("ext-b"))
        val verdict = run(registry, "https://cdn.example/app.js")
        assertTrue(verdict is Verdict.Empty)
        assertEquals(listOf("ext-a"), failures)
    }

    @Test
    fun listenersCanBeRemovedOneByOneOrPerRegistrant() {
        val registry = WebRequestListeners()
        val remove = registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { null }, options("ext-a"))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { null }, options("ext-a"))
        registry.addListener(WebRequestEvent.ON_ERROR_OCCURRED, { null }, options("ext-a", blocking = false))
        registry.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { null }, options("ext-b"))
        remove()
        assertEquals(listOf("ext-a" to true, "ext-b" to true), registry.listenerOrder(WebRequestEvent.ON_BEFORE_REQUEST))
        registry.removeListenersOf("ext-a")
        assertEquals(listOf("ext-b" to true), registry.listenerOrder(WebRequestEvent.ON_BEFORE_REQUEST))
        assertFalse(registry.hasListeners(WebRequestEvent.ON_ERROR_OCCURRED))
        registry.removeListenersOf("ext-b")
        assertTrue(registry.isEmpty)
    }

    @Test
    fun eventsWebViewCannotSupplyAcceptRegistrationsButNeverFire() {
        val registry = WebRequestListeners()
        var fired = 0
        for (event in WebRequestEvent.entries.filter { !it.fires }) {
            registry.addListener(event, { fired++; null }, options("ext", blocking = event.blockable))
        }
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js"))
        assertEquals(0, fired)
    }

    @Test
    fun noListenersMeansNoBookkeeping() {
        val registry = WebRequestListeners()
        val tab = FakeTab()
        assertSame(Verdict.Pass, run(registry, "https://cdn.example/app.js", tab))
        assertTrue(registry.isEmpty)
        // The engine still blocks and counts with nobody listening.
        assertTrue(run(registry, "https://tracker.net/t.js", tab) is Verdict.Empty)
        assertEquals(1, tab.blocked)
    }

    @Test
    fun dataUrlsAreTakenApart() {
        val plain = DataUrl.parse("data:,Hello%2C%20World%21")!!
        assertEquals("text/plain", plain.mimeType)
        assertEquals("US-ASCII", plain.charset)
        assertEquals("Hello, World!", String(plain.bytes, Charsets.UTF_8))
        val base64 = DataUrl.parse("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")!!
        assertEquals("image/gif", base64.mimeType)
        assertNull(base64.charset)
        assertArrayEquals(byteArrayOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), base64.bytes.copyOfRange(0, 6))
        val typed = DataUrl.parse("data:text/javascript;charset=utf-8,(function(){})()")!!
        assertEquals("text/javascript", typed.mimeType)
        assertEquals("utf-8", typed.charset)
        assertEquals("(function(){})()", String(typed.bytes, Charsets.UTF_8))
        assertNotNull(DataUrl.parse("DATA:text/html,%3Chtml%3E"))
        assertNull(DataUrl.parse("https://example.com/"))
        assertNull(DataUrl.parse("data:text/plain"))
        assertNull(DataUrl.parse("data:text/plain;base64,A"))
        assertNull(DataUrl.parse("data:text/plain,%ZZ"))
    }
}
