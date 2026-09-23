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

    // --- The per-site cookie policy: a relay without cookies (PS-23) ---------------------------

    @Test
    fun aWithheldDocumentRelaysWithoutAnyCookieAndKeepsNone() {
        // A never-site's own document is first-party traffic that the jar would ride on; the
        // cookie policy's word (`withCookies` false) is the desktop header stage's strip: the
        // request's own Cookie header goes, the jar is not consulted, Set-Cookie is dropped.
        val store = FakeCookies().apply { this.jar = "session=abc" }
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "tracker=1; Path=/", body = "<p>never</p>"))
        val tab = FakeTab(documentUrl = null)
        val answer = HeaderStage(store, fetcher).relay(
            EngineSnapshot.EMPTY, tab, navigation("https://never.example/"), mapOf("Accept" to "text/html", "Cookie" to "stale=1"), null,
            Decision.ALLOW, withCookies = false
        )
        assertNotNull(answer)
        assertEquals(200, answer!!.status)
        assertEquals("<p>never</p>", answer.data.bufferedReader().readText())
        assertFalse(fetcher.headers!!.keys.any { it.equals("Cookie", ignoreCase = true) })
        assertEquals("text/html", fetcher.headers!!["Accept"])
        assertTrue(store.stored.isEmpty())
        // The same document with cookies: the jar rides and the response's cookies land.
        val withJar = FakeCookies().apply { this.jar = "session=abc" }
        val plain = FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "seen=1; Path=/"))
        assertNotNull(HeaderStage(withJar, plain).relay(EngineSnapshot.EMPTY, tab, navigation("https://never.example/"), emptyMap(), null))
        assertEquals("session=abc", plain.headers!!["Cookie"])
        assertEquals(1, withJar.stored.size)
        // A frame of the never-site inside another page, and a same-site one: withheld either way.
        val frames = FakeCookies().apply { this.jar = "session=abc" }
        val frameFetcher = FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "t=1"))
        val ownFrame = Request("https://never.example/frame", ResourceType.SUB_FRAME, "https://never.example/", thirdParty = false, partition = "default")
        assertNotNull(HeaderStage(frames, frameFetcher).relay(EngineSnapshot.EMPTY, FakeTab(), ownFrame, mapOf("Cookie" to "x=1"), null, Decision.ALLOW, false))
        assertFalse(frameFetcher.headers!!.containsKey("Cookie"))
        assertTrue(frames.stored.isEmpty())
    }

    @Test
    fun theRulesStillDecideAWithheldDocument() {
        // The relay the cookie policy asked for is the same header stage: a header-conditioned
        // block still applies to the response, and the origin's redirect is still mirrored.
        val snap = EngineSnapshot(listOf(adsBlock), null)
        val tab = FakeTab()
        val blocked = HeaderStage(FakeCookies(), FakeFetcher(response(200, "X-Ads" to "1", "Content-Type" to "text/html")))
            .relay(snap, tab, navigation("https://ads.example/"), emptyMap(), null, Decision.ALLOW, withCookies = false)!!
        assertEquals(204, blocked.status)
        assertEquals(listOf("https://ads.example/"), tab.documentsBlocked)
        val moved = FakeCookies().apply { jar = "session=abc" }
        val movedFetcher = FakeFetcher(response(302, "Location" to "https://ads.example/new", "Set-Cookie" to "hop=1"))
        val tab2 = FakeTab()
        assertEquals(204, HeaderStage(moved, movedFetcher).relay(snap, tab2, navigation("https://ads.example/old"), emptyMap(), null, Decision.ALLOW, false)!!.status)
        assertEquals(listOf("https://ads.example/new"), tab2.redirects)
        assertFalse(movedFetcher.headers!!.containsKey("Cookie"))
        assertTrue(moved.stored.isEmpty())
        // What the relay cannot carry it hands back, cookies withheld or not: WebView then loads
        // the document itself (the recorded limit: a POSTed never-site document keeps its cookies).
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(response(200))).relay(snap, tab, navigation("https://ads.example/", "POST"), emptyMap(), null, Decision.ALLOW, false))
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(null)).relay(snap, tab, navigation("https://ads.example/"), emptyMap(), null, Decision.ALLOW, false))
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
        // A header-conditioned allow yields at the header stage in any case and can only cap a
        // request-stage header edit weaker than itself, so without one to cap it does not mark
        // the document `needsHeaders`: no relay is paid for an outcome the request stage already
        // has. Recorded deviation from the desktop engine (`Resolution.relayWorthIt`).
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
        // With a request-stage header edit weaker than the allow, the relay is owed: the allow
        // caps the edit once the response is a text type (the desktop's cap 2), and lets it
        // stand otherwise.
        val weakEdit = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":2,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-A","operation":"set","value":"1"}]},"condition":{"urlFilter":"||fixture.example^"}}]""")
        val capped = EngineSnapshot(listOf(allowOnly, weakEdit), null)
        val early = capped.decide(usercss)
        assertEquals(Decision.Action.MODIFY_HEADERS, early.action)
        assertTrue(early.needsHeaders)
        assertEquals(Decision.Action.ALLOW, capped.decide(usercss, headers("Content-Type" to "text/css")).action)
        assertEquals(Decision.Action.MODIFY_HEADERS, capped.decide(usercss, headers("Content-Type" to "image/png")).action)
        // An edit the allow could not cap (equal or higher priority): no relay owed, the edit stands either way.
        val strongEdit = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":5,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-A","operation":"set","value":"1"}]},"condition":{"urlFilter":"||fixture.example^"}}]""")
        val uncapped = EngineSnapshot(listOf(allowOnly, strongEdit), null)
        assertFalse(uncapped.decide(usercss).needsHeaders)
        assertEquals(Decision.Action.MODIFY_HEADERS, uncapped.decide(usercss, headers("Content-Type" to "text/css")).action)
    }

    // --- modifyHeaders: the resolution (the twin of `engine.test.ts`'s header cases) ------------

    /** User-Agent Switcher's shape: one `modifyHeaders` rule on documents, `set` of the UA. */
    private val uaRule = """{"id":1,"priority":1,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"User-Agent","operation":"set","value":"Zenium-UA-Test/1.0"}]},"condition":{"resourceTypes":["main_frame","sub_frame"]}}"""
    private val uaSwitcher = set("ext:bhchdcejhohfmigjafbampogmaanbfkg:_dynamic", 2999, "[$uaRule]")

    private fun op(header: String, operation: String, value: String? = null) = HeaderOp(header, HeaderOp.Operation.fromDnrName(operation)!!, value)

    @Test
    fun modifyHeadersRidesOnTheAllowThatStands() {
        val snap = EngineSnapshot(listOf(uaSwitcher), null)
        assertEquals(1, snap.ruleCount)
        assertEquals(1, snap.modifyHeadersRuleCount)
        assertEquals(0, snap.headerRuleCount)
        val doc = snap.decide(navigation("https://whatsmyua.example/"))
        assertEquals(Decision.Action.MODIFY_HEADERS, doc.action)
        assertEquals(listOf(op("User-Agent", "set", "Zenium-UA-Test/1.0")), doc.requestHeaderEdits)
        assertTrue(doc.responseHeaderEdits.isEmpty())
        assertEquals("ext:bhchdcejhohfmigjafbampogmaanbfkg:_dynamic", doc.matchedSet)
        assertEquals(1, doc.matchedRule)
        assertFalse(doc.needsHeaders)
        assertTrue(doc.letsThrough)
        assertTrue(doc.editsHeaders)
        // A type the rule does not select: the plain allow.
        val script = snap.decide(Request("https://whatsmyua.example/a.js", ResourceType.SCRIPT, "https://whatsmyua.example/", partition = "default"))
        assertEquals(Decision.Action.ALLOW, script.action)
        assertTrue(script.requestHeaderEdits.isEmpty())
        // The linear reference agrees, edit for edit.
        val linear = snap.decideLinear(navigation("https://whatsmyua.example/"))
        assertEquals(doc.requestHeaderEdits, linear.requestHeaderEdits)
        assertEquals(doc.matchedRule, linear.matchedRule)
    }

    @Test
    fun modifyHeadersNeverWinsTheRequestStageAndYieldsToAnAllowOfEqualOrHigherPriority() {
        val req = navigation("https://whatsmyua.example/")
        // A block of any priority stands: nothing to edit.
        val block = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||whatsmyua.example^"}}]""")
        val blocked = EngineSnapshot(listOf(uaSwitcher, block), null).decide(req)
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertTrue(blocked.requestHeaderEdits.isEmpty())
        // So does a redirect.
        val redirect = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"redirect","redirect":{"url":"https://safe.example/"}},"condition":{"urlFilter":"||whatsmyua.example^"}}]""")
        assertEquals(Decision.Action.REDIRECT, EngineSnapshot(listOf(uaSwitcher, redirect), null).decide(req).action)
        // An allow of equal priority caps the edit (rule 4 of the contract: equal or higher).
        val allowEqual = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||whatsmyua.example^"}}]""")
        val capped = EngineSnapshot(listOf(uaSwitcher, allowEqual), null).decide(req)
        assertEquals(Decision.Action.ALLOW, capped.action)
        assertEquals("ext:b:_dynamic", capped.matchedSet)
        assertTrue(capped.requestHeaderEdits.isEmpty())
        // An allow of lower priority (a lower band here: the user's set) does not.
        val allowLower = set("user", 10, """[{"id":1,"priority":9,"action":{"type":"allow"},"condition":{"urlFilter":"||whatsmyua.example^"}}]""", source = "user")
        val edited = EngineSnapshot(listOf(uaSwitcher, allowLower), null).decide(req)
        assertEquals(Decision.Action.MODIFY_HEADERS, edited.action)
        assertEquals(1, edited.requestHeaderEdits.size)
        // Zenium's own bands sit below the `dnr` band (contract 1.3): a site exception or the
        // switch being off does not cap an extension's edit; a newer extension's allow (the
        // higher slot of the band) does.
        val exception = set("builtin:site-exceptions", 900, """[{"id":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"|https://whatsmyua.example/","resourceTypes":["main_frame","sub_frame"]}}]""", source = "builtin")
        assertEquals(Decision.Action.MODIFY_HEADERS, EngineSnapshot(listOf(uaSwitcher, exception), null).decide(req).action)
        val off = set("builtin:global-off", 1000, """[{"id":1,"action":{"type":"allow"},"condition":{}}]""", source = "builtin")
        assertEquals(Decision.Action.MODIFY_HEADERS, EngineSnapshot(listOf(uaSwitcher, off), null).decide(req).action)
        val newer = set("ext:c:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||whatsmyua.example^"}}]""")
        val older = set("ext:bhchdcejhohfmigjafbampogmaanbfkg:_dynamic", 2998, "[$uaRule]")
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(older, newer), null).decide(req).action)
        // The filter lists' `$document` block stands whatever an extension edits (the lists are
        // weighed against the request stage's best, which a `modifyHeaders` rule never is).
        val lists = TextEngine.parse(listOf("||whatsmyua.example^\$document"))
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(listOf(uaSwitcher), lists).decide(req).action)
    }

    @Test
    fun editsStackHighestPriorityFirstThenInScanOrder() {
        // Two extensions and two rules each; a header-conditioned rule adds its response edit at
        // the header stage and its request edit is dropped (the request is out).
        val a = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"priority":1,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-1","operation":"set","value":"a1"}],"responseHeaders":[{"header":"X-R","operation":"append","value":"a1"}]},"condition":{"urlFilter":"||hdr.example^"}},
                {"id":2,"priority":3,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-2","operation":"set","value":"a2"}]},"condition":{"requestDomains":["hdr.example"]}},
                {"id":3,"priority":2,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-3","operation":"set","value":"late"}],"responseHeaders":[{"header":"X-Frame-Options","operation":"remove"}]},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-frame-options"}]}}]"""
        )
        val b = set(
            "ext:b:_dynamic", 2999,
            """[{"id":1,"priority":3,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-1","operation":"set","value":"b1"}]},"condition":{"regexFilter":"^https://hdr\\.example/"}},
                {"id":2,"priority":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"X-R","operation":"append","value":"b2"}]},"condition":{"urlFilter":"/index"}}]"""
        )
        val snap = EngineSnapshot(listOf(a, b), null)
        val req = navigation("https://hdr.example/index.html")
        val early = snap.decide(req)
        assertEquals(Decision.Action.MODIFY_HEADERS, early.action)
        // Priority 3 first (set a before set b by id at equal priority), then 1: a's rule 2, b's rule 1, a's rule 1, b's rule 2.
        assertEquals(listOf(op("X-2", "set", "a2"), op("X-1", "set", "b1"), op("X-1", "set", "a1")), early.requestHeaderEdits)
        assertEquals(listOf(op("X-R", "append", "a1"), op("X-R", "append", "b2")), early.responseHeaderEdits)
        assertEquals("ext:a:_dynamic", early.matchedSet)
        assertEquals(2, early.matchedRule)
        // The header-conditioned edit asks for the relay; its response edit joins in its place
        // (priority 2, between the 3s and the 1s) once the condition holds, its request edit dropped.
        assertTrue(early.needsHeaders)
        val late = snap.decide(req, headers("X-Frame-Options" to "DENY", "Content-Type" to "text/html"))
        assertEquals(Decision.Action.MODIFY_HEADERS, late.action)
        assertEquals(early.requestHeaderEdits, late.requestHeaderEdits)
        assertEquals(listOf(op("X-Frame-Options", "remove"), op("X-R", "append", "a1"), op("X-R", "append", "b2")), late.responseHeaderEdits)
        assertEquals(2, late.matchedRule)
        assertFalse(late.needsHeaders)
        // Without the header, the request stage's edits alone.
        assertEquals(early.responseHeaderEdits, snap.decide(req, headers("Content-Type" to "text/html")).responseHeaderEdits)
        // The linear reference agrees at both stages.
        for (h in listOf(null, headers("X-Frame-Options" to "DENY"), headers())) {
            val indexed = snap.decide(req, h)
            val linear = snap.decideLinear(req, h)
            assertEquals(linear.requestHeaderEdits, indexed.requestHeaderEdits)
            assertEquals(linear.responseHeaderEdits, indexed.responseHeaderEdits)
            assertEquals(linear.matchedRule, indexed.matchedRule)
            assertEquals(linear.needsHeaders, indexed.needsHeaders)
        }
    }

    @Test
    fun theHeaderStageCapsAndOverturnsEditsAsChromeDoes() {
        val edits = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"priority":2,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-Strong","operation":"set","value":"1"}]},"condition":{"urlFilter":"||hdr.example^"}},
                {"id":2,"priority":1,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-Weak","operation":"set","value":"1"}]},"condition":{"urlFilter":"||hdr.example^"}},
                {"id":3,"priority":2,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"X-Late-Equal","operation":"set","value":"1"}]},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-mark"}]}},
                {"id":4,"priority":3,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"X-Late-Above","operation":"set","value":"1"}]},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-mark"}]}}]"""
        )
        val req = navigation("https://hdr.example/")
        // A header-stage allow of priority 2: request-stage edits of equal or higher priority
        // survive (cap 2, `>=`), header-stage edits need strictly more (cap 3, `>`).
        val lateAllow = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":2,"action":{"type":"allow"},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-mark"}]}}]""")
        val snap = EngineSnapshot(listOf(edits, lateAllow), null)
        val early = snap.decide(req)
        assertEquals(listOf(op("X-Strong", "set", "1"), op("X-Weak", "set", "1")), early.requestHeaderEdits)
        assertTrue(early.needsHeaders)
        val late = snap.decide(req, headers("X-Mark" to "1"))
        assertEquals(Decision.Action.MODIFY_HEADERS, late.action)
        assertEquals(listOf(op("X-Strong", "set", "1")), late.requestHeaderEdits)
        assertEquals(listOf(op("X-Late-Above", "set", "1")), late.responseHeaderEdits)
        // The strongest applicable rule is the match: the header-stage rule 4 at priority 3.
        assertEquals(4, late.matchedRule)
        // Without the marker, the header stage adds nothing and the request stage's edits stand whole.
        val plain = snap.decide(req, headers("Content-Type" to "text/html"))
        assertEquals(early.requestHeaderEdits, plain.requestHeaderEdits)
        assertTrue(plain.responseHeaderEdits.isEmpty())
        assertEquals(1, plain.matchedRule)
        // A header-stage block above the request stage's allow wins over the edits of either stage.
        val lateBlock = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-mark"}]}}]""")
        val blocked = EngineSnapshot(listOf(edits, lateBlock), null).decide(req, headers("x-mark" to "1"))
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertTrue(blocked.requestHeaderEdits.isEmpty())
        // A request-stage allow caps both stages: a header-stage edit of equal priority yields (cap 1, `<=`).
        val allowEqual = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":3,"action":{"type":"allow"},"condition":{"urlFilter":"||hdr.example^"}}]""")
        val capped = EngineSnapshot(listOf(edits, allowEqual), null)
        assertFalse(capped.decide(req).needsHeaders)
        assertEquals(Decision.Action.ALLOW, capped.decide(req, headers("x-mark" to "1")).action)
        val allowBelow = set("ext:b:_dynamic", 2999, """[{"id":1,"priority":2,"action":{"type":"allow"},"condition":{"urlFilter":"||hdr.example^"}}]""")
        val partly = EngineSnapshot(listOf(edits, allowBelow), null)
        val partlyEarly = partly.decide(req)
        assertEquals(Decision.Action.ALLOW, partlyEarly.action)
        assertTrue("the header-stage edit above the allow asks for the relay", partlyEarly.needsHeaders)
        val partlyLate = partly.decide(req, headers("x-mark" to "1"))
        assertEquals(Decision.Action.MODIFY_HEADERS, partlyLate.action)
        assertTrue(partlyLate.requestHeaderEdits.isEmpty())
        assertEquals(listOf(op("X-Late-Above", "set", "1")), partlyLate.responseHeaderEdits)
    }

    // --- modifyHeaders: Blocking.evaluate and the relay's edits ----------------------------------

    @Test
    fun evaluateRelaysAModifyHeadersDocumentAndLetsASubresourceGo() {
        val snap = EngineSnapshot(listOf(uaSwitcher), null)
        val tab = FakeTab()
        val heard = ArrayList<Decision>()
        val observer = DecisionObserver { _, _, decision, _, _ -> heard.add(decision) }
        val document = Blocking.evaluate(snap, tab, "https://whatsmyua.example/", true, "text/html", "GET", observer = observer)
        assertTrue(document is Verdict.HeaderStage)
        assertEquals(Decision.Action.MODIFY_HEADERS, (document as Verdict.HeaderStage).decision.action)
        assertTrue(document.withCookies)
        // The request stage's decision is reported once, as the desktop reports it.
        assertEquals(listOf(Decision.Action.MODIFY_HEADERS), heard.map { it.action })
        val frame = Blocking.evaluate(snap, FakeTab(), "https://ads.example/frame", false, "text/html", "GET")
        assertTrue(frame is Verdict.HeaderStage)
        // The recorded limit: a subresource the rule selects goes out unchanged.
        val wide = set("ext:x:_dynamic", 2999, """[{"id":1,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-A","operation":"set","value":"1"}]},"condition":{"urlFilter":"||whatsmyua.example^"}}]""")
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot(listOf(wide), null), tab, "https://whatsmyua.example/a.js", false, "*/*", "GET"))
        // Listeners see a relayed document as a request that goes out.
        assertTrue(Blocking.evaluate(snap, WebRequestListeners(), tab, "https://whatsmyua.example/", true, mapOf("Accept" to "text/html"), "GET") is Verdict.HeaderStage)
    }

    @Test
    fun theRelaySendsTheRequestHeadersARuleSets() {
        val snap = EngineSnapshot(listOf(uaSwitcher), null)
        val cookies = FakeCookies().apply { jar = "session=abc" }
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/html; charset=utf-8", body = "<p>ua</p>"))
        val tab = FakeTab()
        val req = navigation("https://whatsmyua.example/")
        val early = snap.decide(req)
        val heard = ArrayList<Decision>()
        val webViewHeaders = mapOf("User-Agent" to "Mozilla/5.0 (Linux; Android 13) Chrome/113.0.0.0 Mobile Safari/537.36", "Accept" to "text/html", "Accept-Encoding" to "gzip, deflate, br", "X-Requested-With" to "app.zen.chromium")
        val answer = HeaderStage(cookies, fetcher).relay(snap, tab, req, webViewHeaders, { _, _, decision, _, _ -> heard.add(decision) }, early)
        assertNotNull(answer)
        assertEquals(200, answer!!.status)
        assertEquals("<p>ua</p>", answer.data.bufferedReader().readText())
        // The rule's UA went out in place of WebView's; the rest of the request rode along, the jar too.
        assertEquals("Zenium-UA-Test/1.0", fetcher.headers!!["User-Agent"])
        assertEquals(1, fetcher.headers!!.keys.count { it.equals("User-Agent", ignoreCase = true) })
        assertEquals("text/html", fetcher.headers!!["Accept"])
        assertEquals("app.zen.chromium", fetcher.headers!!["X-Requested-With"])
        assertEquals("session=abc", fetcher.headers!!["Cookie"])
        assertFalse(fetcher.headers!!.containsKey("Accept-Encoding"))
        // The header stage's decision names the same rule: nothing reported twice (contract 5.5).
        assertTrue(heard.isEmpty())
    }

    @Test
    fun theRelayAppliesEveryKindOfRequestEditAndKeepsTheConnectionsHeaders() {
        val edits = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"action":{"type":"modifyHeaders","requestHeaders":[
                    {"header":"user-agent","operation":"set","value":"Zenium-UA-Test/1.0"},
                    {"header":"Accept-Language","operation":"append","value":"fr"},
                    {"header":"X-Requested-With","operation":"remove"},
                    {"header":"X-Client","operation":"append","value":"zenium"},
                    {"header":"Accept-Encoding","operation":"set","value":"br"},
                    {"header":"Host","operation":"set","value":"evil.example"},
                    {"header":"Cookie","operation":"set","value":"forged=1"}]},
                "condition":{"resourceTypes":["main_frame"]}}]"""
        )
        val snap = EngineSnapshot(listOf(edits), null)
        val req = navigation("https://whatsmyua.example/")
        val early = snap.decide(req)
        assertEquals(7, early.requestHeaderEdits.size)
        val webViewHeaders = mapOf("User-Agent" to "WebView", "Accept-Language" to "en-US,en", "X-Requested-With" to "app.zen.chromium", "Accept-Encoding" to "gzip")
        // With cookies: the jar is attached first, so the rule's `set` of Cookie replaces it (the
        // desktop's onBeforeSendHeaders sees the cookies Chromium attached); the connection's
        // framing headers stay the connection's whatever a rule wrote.
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/html"))
        assertNotNull(HeaderStage(FakeCookies().apply { jar = "session=abc" }, fetcher).relay(snap, FakeTab(), req, webViewHeaders, null, early))
        val sent = fetcher.headers!!
        assertEquals("Zenium-UA-Test/1.0", sent["user-agent"])
        assertFalse(sent.containsKey("User-Agent"))
        assertEquals("en-US,en, fr", sent["Accept-Language"])
        assertFalse(sent.containsKey("X-Requested-With"))
        assertEquals("zenium", sent["X-Client"])
        assertEquals("forged=1", sent["Cookie"])
        assertFalse(sent.keys.any { it.equals("Accept-Encoding", ignoreCase = true) })
        assertFalse(sent.keys.any { it.equals("Host", ignoreCase = true) })
        // Cookies withheld by the cookie policy: the policy's strip stays above the rules.
        val withheld = FakeFetcher(response(200, "Content-Type" to "text/html"))
        assertNotNull(HeaderStage(FakeCookies().apply { jar = "session=abc" }, withheld).relay(snap, FakeTab(), req, webViewHeaders, null, early, withCookies = false))
        assertFalse(withheld.headers!!.keys.any { it.equals("Cookie", ignoreCase = true) })
        assertEquals("Zenium-UA-Test/1.0", withheld.headers!!["user-agent"])
        // A cross-site frame goes without the jar; a rule's Cookie is its own doing, as on the desktop.
        val frame = Request("https://whatsmyua.example/frame", ResourceType.SUB_FRAME, "https://news.example/", thirdParty = true, partition = "default")
        val frameSnap = EngineSnapshot(listOf(set("ext:a:_dynamic", 2999, """[{"id":1,"action":{"type":"modifyHeaders","requestHeaders":[{"header":"X-Frame-Mark","operation":"set","value":"1"}]},"condition":{"resourceTypes":["sub_frame"]}}]""")), null)
        val frameFetcher = FakeFetcher(response(200, "Content-Type" to "text/html"))
        assertNotNull(HeaderStage(FakeCookies().apply { jar = "session=abc" }, frameFetcher).relay(frameSnap, FakeTab(), frame, emptyMap(), null, frameSnap.decide(frame)))
        assertEquals("1", frameFetcher.headers!!["X-Frame-Mark"])
        assertFalse(frameFetcher.headers!!.containsKey("Cookie"))
    }

    @Test
    fun theRelayAppliesTheResponseEditsBeforeServing() {
        // A frame-busting document made embeddable, a header set and one appended; the request
        // stage's response edits and a header-conditioned rule's stack together at the header stage.
        val edits = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"priority":2,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"X-Frame-Options","operation":"remove"},{"header":"X-Edited","operation":"set","value":"yes"}]},"condition":{"urlFilter":"||embed.example^","resourceTypes":["main_frame","sub_frame"]}},
                {"id":2,"priority":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"Content-Security-Policy","operation":"append","value":"frame-ancestors *"}]},"condition":{"urlFilter":"||embed.example^","responseHeaders":[{"header":"content-security-policy"}]}}]"""
        )
        val snap = EngineSnapshot(listOf(edits), null)
        val req = navigation("https://embed.example/")
        val early = snap.decide(req)
        assertEquals(Decision.Action.MODIFY_HEADERS, early.action)
        assertTrue(early.needsHeaders)
        val fetcher = FakeFetcher(response(200, "Content-Type" to "text/html; charset=utf-8", "X-Frame-Options" to "DENY", "Content-Security-Policy" to "default-src 'self'", "X-Kept" to "1", body = "<p>framed</p>"))
        val heard = ArrayList<Decision>()
        val answer = HeaderStage(FakeCookies(), fetcher).relay(snap, FakeTab(), req, emptyMap(), { _, _, decision, _, _ -> heard.add(decision) }, early)!!
        assertEquals(200, answer.status)
        assertEquals("text/html", answer.mime)
        assertFalse(answer.headers.keys.any { it.equals("X-Frame-Options", ignoreCase = true) })
        assertEquals("yes", answer.headers["X-Edited"])
        assertEquals("default-src 'self', frame-ancestors *", answer.headers["Content-Security-Policy"])
        assertEquals("1", answer.headers["X-Kept"])
        assertEquals("<p>framed</p>", answer.data.bufferedReader().readText())
        // The header-conditioned rule stacked behind the request stage's match: the same match, not reported again.
        assertTrue(heard.isEmpty())
        // A `Content-Type` a rule sets is what the served response is typed as.
        val retyped = set("ext:a:_dynamic", 2999, """[{"id":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"Content-Type","operation":"set","value":"text/plain; charset=iso-8859-1"}]},"condition":{"resourceTypes":["main_frame"]}}]""")
        val retypedSnap = EngineSnapshot(listOf(retyped), null)
        val plain = HeaderStage(FakeCookies(), FakeFetcher(response(200, "Content-Type" to "text/html"))).relay(retypedSnap, FakeTab(), req, emptyMap(), null, retypedSnap.decide(req))!!
        assertEquals("text/plain", plain.mime)
        assertEquals("iso-8859-1", plain.encoding)
    }

    @Test
    fun theRelayStoresTheCookiesTheRulesLeaveAndNoneWhenWithheld() {
        val edits = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"Set-Cookie","operation":"append","value":"added=1; Path=/"},{"header":"X-Frame-Options","operation":"remove"}]},"condition":{"resourceTypes":["main_frame"]}}]"""
        )
        val snap = EngineSnapshot(listOf(edits), null)
        val req = navigation("https://embed.example/")
        val early = snap.decide(req)
        // First party with cookies: the response's cookies as the rules left them reach the jar
        // (the desktop's Chromium reads the edited Set-Cookie); none is served (WebView drops them).
        val store = FakeCookies().apply { jar = "session=abc" }
        val answer = HeaderStage(store, FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "seen=1; Path=/", "X-Frame-Options" to "DENY"))).relay(snap, FakeTab(), req, emptyMap(), null, early)!!
        assertEquals(listOf(Triple("default", req.url, listOf("seen=1; Path=/", "added=1; Path=/"))), store.stored)
        assertFalse(answer.headers.keys.any { it.equals("Set-Cookie", ignoreCase = true) })
        // A rule that removes Set-Cookie: nothing stored.
        val stripping = set("ext:a:_dynamic", 2999, """[{"id":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"set-cookie","operation":"remove"}]},"condition":{"resourceTypes":["main_frame"]}}]""")
        val strippingSnap = EngineSnapshot(listOf(stripping), null)
        val stripped = FakeCookies()
        assertNotNull(HeaderStage(stripped, FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "seen=1"))).relay(strippingSnap, FakeTab(), req, emptyMap(), null, strippingSnap.decide(req)))
        assertTrue(stripped.stored.isEmpty())
        // Cookies withheld: the policy's strip stays above the rules – a cookie a rule adds is not stored either.
        val withheld = FakeCookies()
        assertNotNull(HeaderStage(withheld, FakeFetcher(response(200, "Content-Type" to "text/html", "Set-Cookie" to "seen=1"))).relay(snap, FakeTab(), req, emptyMap(), null, early, withCookies = false))
        assertTrue(withheld.stored.isEmpty())
    }

    @Test
    fun theRelayReportsAModifyHeadersDecisionAsTheDesktopDoes() {
        // A request-stage allow the header stage turns into edits: another match, reported once;
        // a header-conditioned block above the edits: reported as the block.
        val rules = set(
            "ext:a:_dynamic", 2999,
            """[{"id":1,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||hdr.example^"}},
                {"id":2,"priority":2,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"X-Frame-Options","operation":"remove"}]},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-frame-options"}]}},
                {"id":3,"priority":3,"action":{"type":"block"},"condition":{"urlFilter":"||hdr.example^","responseHeaders":[{"header":"x-ads"}]}}]"""
        )
        val snap = EngineSnapshot(listOf(rules), null)
        val req = navigation("https://hdr.example/")
        val early = snap.decide(req)
        assertEquals(Decision.Action.ALLOW, early.action)
        assertEquals(1, early.matchedRule)
        assertTrue(early.needsHeaders)
        val heard = ArrayList<Decision>()
        val observer = DecisionObserver { _, _, decision, _, _ -> heard.add(decision) }
        val edited = HeaderStage(FakeCookies(), FakeFetcher(response(200, "Content-Type" to "text/html", "X-Frame-Options" to "SAMEORIGIN"))).relay(snap, FakeTab(), req, emptyMap(), observer, early)!!
        assertEquals(200, edited.status)
        assertFalse(edited.headers.containsKey("X-Frame-Options"))
        assertEquals(listOf(Decision.Action.MODIFY_HEADERS), heard.map { it.action })
        assertEquals(2, heard[0].matchedRule)
        heard.clear()
        val tab = FakeTab()
        assertEquals(204, HeaderStage(FakeCookies(), FakeFetcher(response(200, "Content-Type" to "text/html", "X-Frame-Options" to "DENY", "X-Ads" to "1"))).relay(snap, tab, req, emptyMap(), observer, early)!!.status)
        assertEquals(listOf(Decision.Action.BLOCK), heard.map { it.action })
        assertEquals(listOf("https://hdr.example/"), tab.documentsBlocked)
        // A response without either header: the request stage's allow again, nothing reported.
        heard.clear()
        assertNotNull(HeaderStage(FakeCookies(), FakeFetcher(response(200, "Content-Type" to "text/html"))).relay(snap, FakeTab(), req, emptyMap(), observer, early))
        assertTrue(heard.isEmpty())
    }

    @Test
    fun theRelayDeclinesWhatItCannotCarryEditsIncluded() {
        val snap = EngineSnapshot(listOf(uaSwitcher), null)
        val tab = FakeTab()
        val post = Request("https://whatsmyua.example/", ResourceType.MAIN_FRAME, null, "POST", tabId = "tab-1", partition = "default")
        val early = snap.decide(post)
        assertEquals(Decision.Action.MODIFY_HEADERS, early.action)
        // A POSTed document is not relayed: WebView loads it, the edits unapplied (recorded limit).
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(response(200))).relay(snap, tab, post, emptyMap(), null, early))
        // A fetch that fails hands the request back, edits unapplied.
        assertNull(HeaderStage(FakeCookies(), FakeFetcher(null)).relay(snap, tab, navigation("https://whatsmyua.example/"), emptyMap(), null, snap.decide(navigation("https://whatsmyua.example/"))))
        // The origin's redirect is mirrored as for any relayed document; the hop's edits are decided afresh.
        val moved = HeaderStage(FakeCookies(), FakeFetcher(response(302, "Location" to "https://whatsmyua.example/home")))
        val tab2 = FakeTab()
        assertEquals(204, moved.relay(snap, tab2, navigation("https://whatsmyua.example/"), emptyMap(), null, snap.decide(navigation("https://whatsmyua.example/")))!!.status)
        assertEquals(listOf("https://whatsmyua.example/home"), tab2.redirects)
    }
}
