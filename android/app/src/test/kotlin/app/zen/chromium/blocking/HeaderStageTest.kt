package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * The headers-received stage: header conditions as Chromium matches them, the two-stage
 * resolution of `EngineSnapshot.decide`, the request engine's relay verdict, and the relay's
 * own decision function over a fetched response. The Kotlin twin of the header cases in
 * `src/core/blocking/__tests__/engine.test.ts` and `headerCondition.test.ts`.
 */
class HeaderStageTest {
    private class FakeTab(override val tabId: String = "tab-1", override var documentUrl: String? = "https://news.example/story", override val containerId: String = "default") : BlockingTab {
        var blocked = 0
        val documentsBlocked = ArrayList<String>()
        val redirects = ArrayList<String>()

        override fun onRequestsBlocked(count: Int) {
            blocked += count
        }

        override fun onDocumentBlocked(url: String) {
            documentsBlocked.add(url)
        }

        override fun onDocumentUnsafe(url: String, hit: SafeBrowsingHit) = error("not expected")

        override fun onDocumentRedirected(url: String) {
            redirects.add(url)
        }

        override fun onDocumentUpgraded(from: String, to: String) = error("not expected")
    }

    private class FakeCookies : HeaderStage.CookieStore {
        var jar: String? = null
        val stored = ArrayList<Triple<String, String, List<String>>>()

        override fun cookieHeader(partition: String, url: String): String? = jar

        override fun store(partition: String, url: String, setCookie: List<String>) {
            stored.add(Triple(partition, url, setCookie))
        }
    }

    private class FakeFetcher(private val response: HeaderStage.Response?) : HeaderStage.Fetcher {
        var url: String? = null
        var method: String? = null
        var headers: Map<String, String>? = null

        override fun fetch(url: String, method: String, headers: Map<String, String>): HeaderStage.Response? {
            this.url = url
            this.method = method
            this.headers = headers
            return response
        }
    }

    private fun set(id: String, priority: Int, rules: String, source: String = "dnr"): RuleSetInfo =
        RuleSetInfo.parse(JSONObject("""{"id":"$id","source":"$source","priority":$priority,"enabled":true,"rules":$rules}"""))
            ?: error("set did not parse: $id")

    /** Stylus's usercss installer, as its background registers it. */
    private val stylusRule = """{"id":1,"priority":1,"action":{"type":"redirect","redirect":{"regexSubstitution":"https://clngdbkpkpeebahjckkjfobafhncgmne.ext.zenium.invalid/install-usercss.html#\\0"}},
        "condition":{"regexFilter":"^.*\\.user\\.(?:css|less|styl)(?:\\?.*)?$","resourceTypes":["main_frame"],
        "responseHeaders":[{"header":"content-type","values":["text/*"],"excludedValues":["text/html*"]}]}}"""

    private val stylus = set("ext:clngdbkpkpeebahjckkjfobafhncgmne:_dynamic", 2999, "[$stylusRule]")

    private fun navigation(url: String, method: String = "GET") =
        Request(url, ResourceType.MAIN_FRAME, null, method, tabId = "tab-1", partition = "default")

    private fun response(status: Int, vararg headers: Pair<String, String>, body: String = "body"): HeaderStage.Response {
        val map = LinkedHashMap<String?, List<String>?>()
        map[null] = listOf("HTTP/1.1 $status")
        for ((name, value) in headers) map[name] = (map[name] ?: emptyList()) + value
        return HeaderStage.Response(status, if (status == 200) "OK" else "", map, ByteArrayInputStream(body.toByteArray()))
    }

    private fun headers(vararg pairs: Pair<String, String>): Map<String, List<String>> =
        HeaderCondition.index(pairs.associate<Pair<String, String>, String?, List<String>?> { it.first to listOf(it.second) })

    // --- HeaderCondition ---------------------------------------------------------------------------

    @Test
    fun headerConditionsMatchLikeChromium() {
        val css = HeaderCondition.parse(JSONArray("""[{"header":"Content-Type","values":["text/*"],"excludedValues":["text/html*"]}]"""))!!
        assertEquals("content-type", css[0].header)
        assertTrue(HeaderCondition.anyMatches(headers("Content-Type" to "text/css; charset=utf-8"), css))
        assertTrue(HeaderCondition.anyMatches(headers("content-type" to "TEXT/PLAIN"), css))
        assertFalse(HeaderCondition.anyMatches(headers("Content-Type" to "text/html; charset=utf-8"), css))
        assertFalse(HeaderCondition.anyMatches(headers("Content-Type" to "application/json"), css))
        assertFalse(HeaderCondition.anyMatches(headers("X-Other" to "text/css"), css))
        // Presence alone.
        val present = HeaderCondition.parse(JSONArray("""[{"header":"x-ads"}]"""))!!
        assertTrue(HeaderCondition.anyMatches(headers("X-Ads" to ""), present))
        assertFalse(HeaderCondition.anyMatches(headers(), present))
        // Only excluded values: the header must be present and none of them may match.
        val notHtml = HeaderCondition.parse(JSONArray("""[{"header":"content-type","excludedValues":["text/html*"]}]"""))!!
        assertTrue(HeaderCondition.anyMatches(headers("content-type" to "text/css"), notHtml))
        assertFalse(HeaderCondition.anyMatches(headers("content-type" to "text/html"), notHtml))
        assertFalse(HeaderCondition.anyMatches(headers(), notHtml))
        // Multi-valued headers: any line may satisfy the values.
        val cache = HeaderCondition.parse(JSONArray("""[{"header":"cache-control","values":["no-store"]}]"""))!!
        assertTrue(HeaderCondition.anyMatches(headers("Cache-Control" to "max-age=0", "cache-control" to "no-store"), cache))
        // Empty arrays and nameless entries are no conditions.
        assertNull(HeaderCondition.parse(JSONArray("[]")))
        assertNull(HeaderCondition.parse(JSONArray("""[{"values":["x"]}]""")))
        assertNull(HeaderCondition.parse(null))
    }

    @Test
    fun globsFollowBaseMatchPattern() {
        assertTrue(HeaderCondition.glob("text/*").matches("text/css"))
        assertTrue(HeaderCondition.glob("text/*").matches("text/"))
        assertFalse(HeaderCondition.glob("text/*").matches("application/text"))
        assertTrue(HeaderCondition.glob("a?c").matches("abc"))
        assertTrue(HeaderCondition.glob("a?c").matches("ac"))
        assertFalse(HeaderCondition.glob("a?c").matches("abbc"))
        assertTrue(HeaderCondition.glob("a\\*c").matches("a*c"))
        assertFalse(HeaderCondition.glob("a\\*c").matches("abc"))
        assertTrue(HeaderCondition.glob("no-store").matches("NO-STORE"))
        assertTrue(HeaderCondition.glob("a.c").matches("a.c"))
        assertFalse(HeaderCondition.glob("a.c").matches("abc"))
    }

    @Test
    fun stageMatchingChecksExclusionsFirst() {
        val wanted = HeaderCondition.parse(JSONArray("""[{"header":"content-type","values":["text/*"]}]"""))
        val unwanted = HeaderCondition.parse(JSONArray("""[{"header":"x-skip"}]"""))
        assertTrue(HeaderCondition.matchesStage(headers("content-type" to "text/css"), wanted, unwanted))
        assertFalse(HeaderCondition.matchesStage(headers("content-type" to "text/css", "x-skip" to "1"), wanted, unwanted))
        assertFalse(HeaderCondition.matchesStage(headers("content-type" to "image/png"), wanted, unwanted))
        assertTrue(HeaderCondition.matchesStage(headers("content-type" to "image/png"), null, unwanted))
        // A rule without conditions passes any response.
        assertTrue(HeaderCondition.matchesStage(headers(), null, null))
    }

    // --- EngineSnapshot.decide in two stages -----------------------------------------------------

    @Test
    fun theRequestStageMarksAnAllowAHeaderRuleCouldOverturn() {
        val snap = EngineSnapshot(listOf(stylus), null)
        assertEquals(1, snap.headerRuleCount)
        val pending = snap.decide(navigation("https://fixture.example/hello.user.css"))
        assertEquals(Decision.Action.ALLOW, pending.action)
        assertTrue(pending.needsHeaders)
        // A URL the rule's other conditions do not select: a plain allow, no relay.
        val plain = snap.decide(navigation("https://fixture.example/index.html"))
        assertEquals(Decision.Action.ALLOW, plain.action)
        assertFalse(plain.needsHeaders)
        // The type condition is the request stage's too.
        val script = snap.decide(Request("https://fixture.example/hello.user.css", ResourceType.SCRIPT, "https://news.example/", partition = "default"))
        assertFalse(script.needsHeaders)
    }

    @Test
    fun theHeaderStageDecidesAgainstTheResponse() {
        val snap = EngineSnapshot(listOf(stylus), null)
        val req = navigation("https://fixture.example/hello.user.css")
        val redirected = snap.decide(req, headers("Content-Type" to "text/css; charset=utf-8"))
        assertEquals(Decision.Action.REDIRECT, redirected.action)
        assertEquals("https://clngdbkpkpeebahjckkjfobafhncgmne.ext.zenium.invalid/install-usercss.html#https://fixture.example/hello.user.css", redirected.redirectUrl)
        assertEquals("ext:clngdbkpkpeebahjckkjfobafhncgmne:_dynamic", redirected.matchedSet)
        assertEquals(1, redirected.matchedRule)
        assertFalse(redirected.needsHeaders)
        val html = snap.decide(req, headers("Content-Type" to "text/html"))
        assertEquals(Decision.Action.ALLOW, html.action)
        assertFalse(html.needsHeaders)
        assertEquals(Decision.Action.ALLOW, snap.decide(req, headers()).action)
    }

    @Test
    fun theStagesMergeAsChromeMerges() {
        val block = set("ext:a:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"x-ads"}]}}]""")
        val allow = set("ext:a:_session", 2999, """[{"id":2,"priority":5,"action":{"type":"allow"},"condition":{"urlFilter":"||ads.example^"}}]""")
        val req = navigation("https://ads.example/")
        // A request-stage allow of higher priority caps the header stage: nothing to relay for.
        val capped = EngineSnapshot(listOf(block, allow), null).decide(req)
        assertEquals(Decision.Action.ALLOW, capped.action)
        assertFalse(capped.needsHeaders)
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(block, allow), null).decide(req, headers("x-ads" to "1")).action)
        // A weaker request-stage allow yields to the header rule.
        val weak = set("ext:a:_session", 2999, """[{"id":2,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||ads.example^"}}]""")
        val pending = EngineSnapshot(listOf(block, weak), null).decide(req)
        assertEquals(Decision.Action.ALLOW, pending.action)
        assertFalse("equal priority: allow wins the tie, no relay", pending.needsHeaders)
        val stronger = set("ext:a:_dynamic", 2999, """[{"id":1,"priority":2,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"x-ads"}]}}]""")
        val pending2 = EngineSnapshot(listOf(stronger, weak), null).decide(req)
        assertTrue(pending2.needsHeaders)
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(listOf(stronger, weak), null).decide(req, headers("X-Ads" to "yes")).action)
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(stronger, weak), null).decide(req, headers()).action)
        // A request-stage block stands whatever the headers say.
        val hardBlock = set("ext:b:_dynamic", 2999, """[{"id":3,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^"}}]""")
        val blocked = EngineSnapshot(listOf(stronger, hardBlock), null).decide(req)
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertFalse(blocked.needsHeaders)
        // The linear reference agrees, stage for stage.
        val snap = EngineSnapshot(listOf(stronger, weak), null)
        assertEquals(snap.decide(req).needsHeaders, snap.decideLinear(req).needsHeaders)
        assertEquals(snap.decide(req, headers("x-ads" to "1")).action, snap.decideLinear(req, headers("x-ads" to "1")).action)
    }

    @Test
    fun aHeaderConditionedAllowAllRequestsOnlyMatchesTheFrameItself() {
        val allowAll = set("ext:a:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"||news.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"x-safe"}]}}]""")
        val block = set("lists", 1, """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||tracker.example^"}}]""", source = "builtin")
        val snap = EngineSnapshot(listOf(allowAll, block), null)
        // A subresource of the document: the document's headers are not at hand, the block stands.
        val sub = snap.decide(Request("https://tracker.example/t.js", ResourceType.SCRIPT, "https://news.example/story", partition = "default"))
        assertEquals(Decision.Action.BLOCK, sub.action)
        assertFalse(sub.needsHeaders)
        // The frame request itself is the only request the rule could be relayed for, and on its
        // own it is not worth the relay: a header-stage allow (of either kind) yields, so the
        // request stage's allow is the outcome with or without the headers (services review of
        // #219, recommendation 3; `aHeaderConditionedAllowAloneDoesNotAskForTheRelay`).
        val frame = snap.decide(navigation("https://news.example/story"))
        assertEquals(Decision.Action.ALLOW, frame.action)
        assertFalse(frame.needsHeaders)
    }

    // --- Blocking.evaluate's relay verdict --------------------------------------------------------

    @Test
    fun evaluateRelaysOnlyDocumentsAHeaderRuleSelected() {
        val snap = EngineSnapshot(listOf(stylus), null)
        val tab = FakeTab()
        val relayed = Blocking.evaluate(snap, tab, "https://fixture.example/hello.user.css", true, "text/html", "GET")
        assertTrue(relayed is Verdict.HeaderStage)
        assertEquals(ResourceType.MAIN_FRAME, (relayed as Verdict.HeaderStage).request.type)
        assertSame(Verdict.Pass, Blocking.evaluate(snap, tab, "https://fixture.example/page.html", true, "text/html", "GET"))
        // A subresource that a header rule would select is not relayed: the request stage's allow stands.
        val subresource = set("ext:a:_dynamic", 2999, """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||cdn.example^","resourceTypes":["script"],"responseHeaders":[{"header":"x-ads"}]}}]""")
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot(listOf(subresource), null), tab, "https://cdn.example/a.js", false, "*/*", "GET"))
        // Listeners see a relayed request as one that goes out.
        val listeners = WebRequestListeners()
        assertTrue(Blocking.evaluate(snap, listeners, tab, "https://fixture.example/hello.user.css", true, mapOf("Accept" to "text/html"), "GET") is Verdict.HeaderStage)
    }

    private fun assertSame(expected: Any, actual: Any?) = assertTrue("expected $expected, was $actual", expected === actual)

    // --- HeaderStage.outcome and relay ------------------------------------------------------------

    @Test
    fun outcomesFollowTheDecisionThenTheOriginsRedirect() {
        val url = "https://fixture.example/hello.user.css"
        val serve = HeaderStage.outcome(Decision.ALLOW, response(200, "Content-Type" to "text/css"), url)
        assertTrue(serve is HeaderStage.Outcome.Serve)
        assertTrue(HeaderStage.outcome(Decision(Decision.Action.BLOCK, matchedSet = "ext:a"), response(200), url) is HeaderStage.Outcome.Block)
        val redirect = HeaderStage.outcome(Decision(Decision.Action.REDIRECT, "https://x.example/install", "ext:a", 1), response(200), url)
        assertTrue(redirect is HeaderStage.Outcome.Redirect)
        assertEquals("https://x.example/install", (redirect as HeaderStage.Outcome.Redirect).url)
        assertTrue(redirect.byRule)
        // The origin's own redirect is mirrored, resolved against the request.
        val moved = HeaderStage.outcome(Decision.ALLOW, response(302, "Location" to "/moved.user.css"), url)
        assertTrue(moved is HeaderStage.Outcome.Redirect)
        assertEquals("https://fixture.example/moved.user.css", (moved as HeaderStage.Outcome.Redirect).url)
        assertFalse(moved.byRule)
        // A 3xx without a Location, or a status WebView cannot carry, hands the request back.
        assertTrue(HeaderStage.outcome(Decision.ALLOW, response(304), url) is HeaderStage.Outcome.PassThrough)
        assertTrue(HeaderStage.outcome(Decision.ALLOW, response(101), url) is HeaderStage.Outcome.PassThrough)
        // Error documents are served as they are.
        assertTrue(HeaderStage.outcome(Decision.ALLOW, response(404, "Content-Type" to "text/html"), url) is HeaderStage.Outcome.Serve)
        // A filter list's `$redirect` has no target here: the response stands.
        assertTrue(HeaderStage.outcome(Decision(Decision.Action.REDIRECT, matchedSet = Decision.TEXT_SET_ID, matchedFilter = "x"), response(200), url) is HeaderStage.Outcome.Serve)
    }

    @Test
    fun theRelayRedirectsAUsercssDocumentToTheInstaller() {
        val snap = EngineSnapshot(listOf(stylus), null)
        val cookies = FakeCookies().apply { jar = "session=abc" }
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/css; charset=utf-8", "Set-Cookie" to "seen=1; Path=/"))
        val tab = FakeTab()
        val decisions = ArrayList<Decision>()
        val stage = HeaderStage(cookies, fetcher)
        val req = navigation("https://fixture.example/hello.user.css")
        val answer = stage.relay(snap, tab, req, mapOf("Accept" to "text/html", "Accept-Encoding" to "gzip", "If-None-Match" to "\"e\"", "User-Agent" to "ZeniumTest"), { _, _, decision, _, _ -> decisions.add(decision) })
        assertNotNull(answer)
        assertEquals(204, answer!!.status)
        assertEquals(listOf("https://clngdbkpkpeebahjckkjfobafhncgmne.ext.zenium.invalid/install-usercss.html#https://fixture.example/hello.user.css"), tab.redirects)
        // The fetch carried the request's headers, the profile's cookies, and none of the framing / conditional ones.
        assertEquals("GET", fetcher.method)
        assertEquals(req.url, fetcher.url)
        assertEquals("session=abc", fetcher.headers!!["Cookie"])
        assertEquals("ZeniumTest", fetcher.headers!!["User-Agent"])
        assertFalse(fetcher.headers!!.containsKey("Accept-Encoding"))
        assertFalse(fetcher.headers!!.containsKey("If-None-Match"))
        // The response's cookies reached the jar, the observer heard the header stage's decision.
        assertEquals(listOf(Triple("default", req.url, listOf("seen=1; Path=/"))), cookies.stored)
        assertEquals(1, decisions.size)
        assertEquals(Decision.Action.REDIRECT, decisions[0].action)
    }

    @Test
    fun theRelayServesADocumentTheRulesLetThrough() {
        val snap = EngineSnapshot(listOf(stylus), null)
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/html; charset=utf-8", "Content-Length" to "999", "Content-Encoding" to "gzip", "X-Custom" to "kept", body = "<p>hi</p>"))
        val tab = FakeTab()
        val answer = HeaderStage(FakeCookies(), fetcher).relay(snap, tab, navigation("https://fixture.example/hello.user.css"), emptyMap(), null)
        assertNotNull(answer)
        assertEquals(200, answer!!.status)
        assertEquals("text/html", answer.mime)
        assertEquals("utf-8", answer.encoding)
        assertEquals("kept", answer.headers["X-Custom"])
        assertFalse(answer.headers.containsKey("Content-Length"))
        assertFalse(answer.headers.containsKey("Content-Encoding"))
        assertEquals("<p>hi</p>", answer.data.bufferedReader().readText())
        assertTrue(tab.redirects.isEmpty())
    }

    @Test
    fun theRelayBlocksAndMirrorsRedirectsPerFrameType() {
        val block = set("ext:a:_dynamic", 2999, """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame","sub_frame"],"responseHeaders":[{"header":"x-ads"}]}}]""")
        val snap = EngineSnapshot(listOf(block), null)
        val tab = FakeTab()
        val stage = HeaderStage(FakeCookies(), FakeFetcher(response(200, "X-Ads" to "1", "Content-Type" to "text/html")))
        val document = stage.relay(snap, tab, navigation("https://ads.example/"), emptyMap(), null)!!
        assertEquals(204, document.status)
        assertEquals(listOf("https://ads.example/"), tab.documentsBlocked)
        val frame = stage.relay(snap, tab, Request("https://ads.example/frame", ResourceType.SUB_FRAME, "https://news.example/", partition = "default"), emptyMap(), null)!!
        assertEquals(403, frame.status)
        assertEquals(1, tab.blocked)
        // The origin's redirect: the tab loads the target, a frame replaces itself.
        val moved = HeaderStage(FakeCookies(), FakeFetcher(response(301, "Location" to "https://ads.example/new")))
        val tab2 = FakeTab()
        assertEquals(204, moved.relay(snap, tab2, navigation("https://ads.example/old"), emptyMap(), null)!!.status)
        assertEquals(listOf("https://ads.example/new"), tab2.redirects)
        val frameMoved = moved.relay(snap, tab2, Request("https://ads.example/frame", ResourceType.SUB_FRAME, "https://news.example/", partition = "default"), emptyMap(), null)!!
        assertEquals("text/html", frameMoved.mime)
        assertTrue(frameMoved.data.bufferedReader().readText().contains("location.replace(\"https://ads.example/new\")"))
    }

    @Test
    fun theRelayStandsAsideWhenItCannot() {
        val snap = EngineSnapshot(listOf(stylus), null)
        val tab = FakeTab()
        // A POST has a body the intercept cannot see: the request-stage allow stands.
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(response(200))).relay(snap, tab, navigation("https://fixture.example/hello.user.css", "POST"), emptyMap(), null))
        // A fetch that fails hands the request back to WebView.
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(null)).relay(snap, tab, navigation("https://fixture.example/hello.user.css"), emptyMap(), null))
        assertTrue(tab.redirects.isEmpty())
    }

    // --- The services review of #219: cookies of a cross-site frame, one report per match ------

    private val adsBlock = set(
        "ext:a:_dynamic", 2999,
        """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame","sub_frame"],"responseHeaders":[{"header":"x-ads"}]}}]"""
    )

    @Test
    fun aCrossSiteFrameRelaysWithoutTheJar() {
        val snap = EngineSnapshot(listOf(adsBlock), null)
        // A third-party frame: WebView would apply the third-party cookie policy and SameSite at the
        // network layer; the relay sends no cookies and keeps none of the response's.
        val crossSite = FakeCookies().apply { jar = "session=abc" }
        val crossFetcher = FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "tracker=1; Path=/"))
        val frame = Request("https://ads.example/frame", ResourceType.SUB_FRAME, "https://news.example/", thirdParty = true, partition = "default")
        assertNotNull(HeaderStage(crossSite, crossFetcher).relay(snap, FakeTab(), frame, mapOf("Accept" to "text/html"), null))
        assertFalse(crossFetcher.headers!!.keys.any { it.equals("Cookie", ignoreCase = true) })
        assertTrue(crossSite.stored.isEmpty())
        // A same-site frame is first-party traffic: the jar rides and the response's cookies land.
        val sameSite = FakeCookies().apply { jar = "session=abc" }
        val sameFetcher = FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "seen=1; Path=/"))
        val ownFrame = Request("https://ads.example/frame", ResourceType.SUB_FRAME, "https://ads.example/", thirdParty = false, partition = "default")
        assertNotNull(HeaderStage(sameSite, sameFetcher).relay(snap, FakeTab(), ownFrame, emptyMap(), null))
        assertEquals("session=abc", sameFetcher.headers!!["Cookie"])
        assertEquals(listOf(Triple("default", ownFrame.url, listOf("seen=1; Path=/"))), sameSite.stored)
    }

    @Test
    fun theHeaderStageReportsOnlyAnotherMatch() {
        // An allow the request stage matched, with a header-conditioned block above it.
        val allowThenBlock = set(
            "ext:a:_dynamic", 2999,
            """[{"id":7,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame"]}},
                {"id":1,"priority":2,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"x-ads"}]}}]"""
        )
        val snap = EngineSnapshot(listOf(allowThenBlock), null)
        val req = navigation("https://ads.example/")
        val requestStage = snap.decide(req)
        assertEquals(Decision.Action.ALLOW, requestStage.action)
        assertEquals(7, requestStage.matchedRule)
        assertTrue(requestStage.needsHeaders)
        // The response meets no header condition: the same allow decides again, and the observer,
        // which already heard it at the request stage, hears nothing (contract 5.5 `sameMatch`).
        val heard = ArrayList<Decision>()
        val observer = DecisionObserver { _, _, decision, _, _ -> heard.add(decision) }
        val quiet = HeaderStage(FakeCookies(), FakeFetcher(response(200, "Content-Type" to "text/html")))
        assertNotNull(quiet.relay(snap, FakeTab(), req, emptyMap(), observer, requestStage))
        assertTrue(heard.isEmpty())
        // The response meets the block's condition: another rule decided, reported once.
        val tab = FakeTab()
        val loud = HeaderStage(FakeCookies(), FakeFetcher(response(200, "X-Ads" to "1", "Content-Type" to "text/html")))
        assertEquals(204, loud.relay(snap, tab, req, emptyMap(), observer, requestStage)!!.status)
        assertEquals(1, heard.size)
        assertEquals(Decision.Action.BLOCK, heard[0].action)
        assertEquals(1, heard[0].matchedRule)
        assertEquals(listOf("https://ads.example/"), tab.documentsBlocked)
        // Without a request-stage decision to compare against, any match is news.
        assertTrue(HeaderStage.sameMatch(requestStage, requestStage))
        assertFalse(HeaderStage.sameMatch(requestStage, heard[0]))
    }

    @Test
    fun aHeaderConditionedAllowAloneDoesNotAskForTheRelay() {
        // A header-conditioned allow yields at the header stage in any case (no header edits to
        // cap here), so on its own it does not mark the document `needsHeaders`: no relay is paid
        // for an outcome the request stage already has. Recorded deviation from the desktop engine.
        val allowOnly = set(
            "ext:a:_dynamic", 2999,
            """[{"id":3,"priority":5,"action":{"type":"allow"},"condition":{"urlFilter":"||fixture.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"content-type","values":["text/*"]}]}}]"""
        )
        val alone = EngineSnapshot(listOf(allowOnly), null).decide(navigation("https://fixture.example/hello.user.css"))
        assertEquals(Decision.Action.ALLOW, alone.action)
        assertFalse(alone.needsHeaders)
        // Beside a header-conditioned block the relay is still owed, and the allow still wins it
        // once the headers are in: the outcomes match the desktop engine's.
        val both = EngineSnapshot(listOf(allowOnly, adsBlock), null)
        val pending = both.decide(navigation("https://ads.example/"))
        assertTrue(pending.needsHeaders)
        val stylusAndAllow = EngineSnapshot(listOf(allowOnly, stylus), null)
        val usercss = navigation("https://fixture.example/hello.user.css")
        assertTrue(stylusAndAllow.decide(usercss).needsHeaders)
        val late = stylusAndAllow.decide(usercss, headers("Content-Type" to "text/css"))
        assertEquals(Decision.Action.ALLOW, late.action)
    }
}
