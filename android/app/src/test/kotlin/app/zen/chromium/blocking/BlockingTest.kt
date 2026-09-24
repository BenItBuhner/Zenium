package app.zen.chromium.blocking

import app.zen.chromium.ext.ExtensionUrls
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.zip.GZIPInputStream

class BlockingTest {
    private class FakeTab(override val tabId: String = "tab-1", override var documentUrl: String? = "https://news.example/story", override val containerId: String = "default") : BlockingTab {
        var blocked = 0
        val documentsBlocked = ArrayList<String>()
        val redirects = ArrayList<String>()
        val unsafe = ArrayList<Pair<String, SafeBrowsingHit>>()
        val upgrades = ArrayList<Pair<String, String>>()

        override fun onRequestsBlocked(count: Int) {
            blocked += count
        }

        override fun onDocumentBlocked(url: String) {
            documentsBlocked.add(url)
        }

        override fun onDocumentUnsafe(url: String, hit: SafeBrowsingHit) {
            unsafe.add(url to hit)
        }

        override fun onDocumentRedirected(url: String) {
            redirects.add(url)
        }

        override fun onDocumentUpgraded(from: String, to: String) {
            upgrades.add(from to to)
        }
    }

    /** A policy that lists `listed.example` (and its subdomains) and allows `plain.example` over plaintext. */
    private class FakePolicy : RequestPolicy {
        val asked = ArrayList<String>()
        /** The `navigation` mark of each question, in order. */
        val navigations = ArrayList<Boolean>()

        override fun unsafe(url: String, navigation: Boolean): SafeBrowsingHit? {
            asked.add(url)
            navigations.add(navigation)
            val host = Domains.hostnameOf(url) ?: return null
            return if (host == "listed.example" || host.endsWith(".listed.example")) SafeBrowsingHit("urlhaus", "malware", "listed.example") else null
        }

        override fun plaintextAllowed(url: String): Boolean = Domains.hostnameOf(url) == "plain.example"
    }

    private val snapshot = EngineSnapshot(
        listOf(
            RuleSetInfo.parse(
                JSONObject(
                    """{"id":"dnr","source":"dnr","priority":5,"enabled":true,"rules":[
                        {"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"||upgrade.example^"}},
                        {"id":2,"action":{"type":"redirect","redirect":{"url":"https://safe.example/"}},"condition":{"urlFilter":"||moved.example^"}}
                    ]}"""
                )
            )!!
        ),
        TextEngine.parse(listOf("||tracker.net^\$third-party\n||malware.example^\$all\n||cdn.example/lib.js\$script,redirect=noopjs\n||pixel.example/collect\$script"))
    )

    @Test
    fun requestsOutsideHttpAndEmptySnapshotsPass() {
        val tab = FakeTab()
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "data:text/plain,hi", false, null, "GET"))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "about:blank", true, null, "GET"))
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://tracker.net/t.js", false, null, "GET"))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://cdn.example/app.js", false, null, "GET"))
        assertEquals(0, tab.blocked)
        assertTrue(tab.documentsBlocked.isEmpty())
    }

    @Test
    fun blockedSubresourcesAreEmptyForbiddenResponsesAndCounted() {
        val tab = FakeTab()
        val verdict = Blocking.evaluate(snapshot, tab, "https://tracker.net/t.js", false, "*/*", "GET")
        assertTrue(verdict is Verdict.Empty)
        assertEquals(403, (verdict as Verdict.Empty).status)
        assertEquals(1, tab.blocked)
        // Requests of unknown type still match typed filters.
        val unknown = Blocking.evaluate(snapshot, tab, "https://pixel.example/collect?e=1", false, "*/*", "POST")
        assertTrue(unknown is Verdict.Empty)
        assertEquals(2, tab.blocked)
        // First-party requests to the tracker host are not third party.
        tab.documentUrl = "https://www.tracker.net/"
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://tracker.net/t.js", false, "*/*", "GET"))
        assertEquals(2, tab.blocked)
        assertTrue(tab.documentsBlocked.isEmpty())
    }

    @Test
    fun blockedNavigationsAreDroppedAndReportedToTheTab() {
        val tab = FakeTab()
        val verdict = Blocking.evaluate(snapshot, tab, "https://malware.example/landing", true, "text/html", "GET")
        assertTrue(verdict is Verdict.Empty)
        assertEquals(204, (verdict as Verdict.Empty).status)
        assertEquals(listOf("https://malware.example/landing"), tab.documentsBlocked)
        assertEquals(0, tab.blocked)
        assertEquals(Decision.Action.BLOCK, Blocking.decideNavigation(snapshot, tab, "https://malware.example/").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(snapshot, tab, "https://news.example/").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(snapshot, tab, "about:blank").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(EngineSnapshot.EMPTY, tab, "https://malware.example/").action)
    }

    @Test
    fun redirectFiltersGetNeuteredResourcesAndCount() {
        val tab = FakeTab()
        val verdict = Blocking.evaluate(snapshot, tab, "https://cdn.example/lib.js", false, "*/*", "GET")
        assertTrue(verdict is Verdict.Neutered)
        assertEquals(ResourceType.SCRIPT, (verdict as Verdict.Neutered).type)
        assertEquals(1, tab.blocked)
    }

    @Test
    fun structuredRedirectsAndUpgradesMoveNavigationsOnly() {
        val tab = FakeTab()
        val upgraded = Blocking.evaluate(snapshot, tab, "http://upgrade.example/page", true, "text/html", "GET")
        assertTrue(upgraded is Verdict.Empty)
        assertEquals(listOf("https://upgrade.example/page"), tab.redirects)
        val moved = Blocking.evaluate(snapshot, tab, "https://moved.example/x", true, "text/html", "GET")
        assertTrue(moved is Verdict.Empty)
        assertEquals(listOf("https://upgrade.example/page", "https://safe.example/"), tab.redirects)
        // Subresources cannot be redirected from shouldInterceptRequest: the verdict names the
        // target for the redirect executor (`Extensions.redirect()`), which substitutes it.
        val sub = Blocking.evaluate(snapshot, tab, "https://moved.example/a.js", false, null, "GET")
        assertTrue(sub is Verdict.Redirect)
        assertEquals("https://safe.example/", (sub as Verdict.Redirect).url)
        assertEquals(ResourceType.SCRIPT, sub.type)
        val up = Blocking.evaluate(snapshot, tab, "http://upgrade.example/a.js", false, null, "GET")
        assertEquals("https://upgrade.example/a.js", (up as Verdict.Redirect).url)
        assertEquals(0, tab.blocked)
        val nav = Blocking.decideNavigation(snapshot, tab, "http://upgrade.example/")
        assertEquals(Decision.Action.UPGRADE, nav.action)
        assertEquals("https://upgrade.example/", nav.redirectUrl)
    }

    @Test
    fun `HTTPS-only mode's subresource upgrades stay the page's mixed-content business`() {
        val httpsOnly = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"${Blocking.HTTPS_ONLY_SET}","source":"builtin","priority":100,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"http://*"}}
                        ]}"""
                    )
                )!!
            ),
            null
        )
        val tab = FakeTab()
        assertSame(Verdict.Pass, Blocking.evaluate(httpsOnly, tab, "http://plain.example/a.js", false, null, "GET"))
        val nav = Blocking.evaluate(httpsOnly, tab, "http://plain.example/", true, "text/html", "GET")
        assertTrue(nav is Verdict.Empty)
        assertEquals(listOf("http://plain.example/" to "https://plain.example/"), tab.upgrades)
    }

    @Test
    fun `the observer hears every decision with the matcher's latency, the partition is the tab's`() {
        val heard = ArrayList<Triple<String, Decision, Long>>()
        val cpu = ArrayList<Long>()
        val observer = DecisionObserver { _, request, decision, nanos, cpuNanos ->
            heard.add(Triple("${request.partition}:${request.url}", decision, nanos))
            cpu.add(cpuNanos)
        }
        val tab = FakeTab(containerId = "work")
        Blocking.evaluate(snapshot, tab, "https://tracker.net/t.js", false, "*/*", "GET", observer = observer)
        Blocking.evaluate(snapshot, tab, "https://cdn.example/app.js", false, null, "GET", observer = observer)
        Blocking.evaluate(snapshot, tab, "data:text/plain,hi", false, null, "GET", observer = observer)
        assertEquals(2, heard.size)
        assertEquals("work:https://tracker.net/t.js", heard[0].first)
        assertEquals(Decision.Action.BLOCK, heard[0].second.action)
        assertEquals(Decision.TEXT_SET_ID, heard[0].second.matchedSet)
        assertEquals("work:https://cdn.example/app.js", heard[1].first)
        assertEquals(Decision.Action.ALLOW, heard[1].second.action)
        assertNull(heard[1].second.matchedSet)
        assertTrue(heard.all { it.third >= 0 })
        // On the JVM `android.os.Debug` is a stub: the CPU figure is the "cannot tell" one, never a garbage number.
        assertTrue(cpu.all { it == -1L })
        // With an observer even the empty snapshot reports (the allow the request got), so the
        // observational webRequest events of the extension platform see every request.
        Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://tracker.net/t.js", false, null, "GET", observer = observer)
        assertEquals(3, heard.size)
        assertEquals(Decision.Action.ALLOW, heard[2].second.action)
    }

    @Test
    fun `a main-frame request opens the tab's next document generation, its subresources carry it`() {
        val generations = ArrayList<Pair<String, Long>>()
        val observer = DecisionObserver { _, request, _, _, _ -> generations.add(request.url to request.documentGeneration) }
        val tab = object : BlockingTab by FakeTab() {
            var generation = 4L
            override fun documentGeneration(newDocument: Boolean): Long = if (newDocument) ++generation else generation
        }
        Blocking.evaluate(snapshot, tab, "https://cdn.example/old.js", false, null, "GET", observer = observer)
        Blocking.evaluate(snapshot, tab, "https://news.example/next", true, "text/html", "GET", observer = observer)
        Blocking.evaluate(snapshot, tab, "https://cdn.example/new.js", false, null, "GET", observer = observer)
        // A non-http request is no document and no decision.
        Blocking.evaluate(snapshot, tab, "about:blank", true, "text/html", "GET", observer = observer)
        assertEquals(
            listOf("https://cdn.example/old.js" to 4L, "https://news.example/next" to 5L, "https://cdn.example/new.js" to 5L),
            generations
        )
        // A tab that keeps no count stamps 0.
        generations.clear()
        Blocking.evaluate(snapshot, FakeTab(), "https://news.example/next", true, "text/html", "GET", observer = observer)
        assertEquals(listOf("https://news.example/next" to 0L), generations)
    }

    @Test
    fun `an extension's scoped set decides nothing in a private tab`() {
        val scoped = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"ext:abc:static:ads","source":"dnr","priority":2999,"enabled":true,"partitions":["default","work"],"rules":[
                            {"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^"}}
                        ]}"""
                    )
                )!!
            ),
            null
        )
        val private = FakeTab(containerId = "private")
        assertSame(Verdict.Pass, Blocking.evaluate(scoped, private, "https://ads.example/a.js", false, null, "GET"))
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(scoped, private, "https://ads.example/").action)
        val work = FakeTab(containerId = "work")
        assertTrue(Blocking.evaluate(scoped, work, "https://ads.example/a.js", false, null, "GET") is Verdict.Empty)
        assertEquals(Decision.Action.BLOCK, Blocking.decideNavigation(scoped, FakeTab(), "https://ads.example/").action)
    }

    @Test
    fun `an extension's own page passes before any rule, in either spelling, and the policy is never asked (contract note 1_11)`() {
        // A snapshot that blocks everything it is asked about: a user rule with no condition, and a
        // filter-list line for the served origin's very words.
        val everything = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject("""{"id":"user","source":"user","priority":10,"enabled":true,"rules":[{"id":1,"action":{"type":"block"}}]}""")
                )!!
            ),
            TextEngine.parse(listOf("||ext.zenium.invalid^\$all"))
        )
        val tab = FakeTab()
        val policy = FakePolicy()
        val id = "b".repeat(32)
        val chrome = "chrome-extension://$id/options.html?tab=2#top"
        val served = "https://$id.ext.zenium.invalid/options.html?tab=2#top"
        for (url in listOf(chrome, served)) {
            assertSame(url, Verdict.Pass, Blocking.evaluate(everything, tab, url, true, "text/html", "GET", policy))
            assertSame(url, Verdict.Pass, Blocking.evaluate(everything, tab, url, false, "text/html", "GET", policy))
            assertSame(url, Verdict.Pass, Blocking.evaluate(everything, tab, url, false, "*/*", "GET", policy))
            assertEquals(url, Decision.Action.ALLOW, Blocking.decideNavigation(everything, tab, url).action)
        }
        assertEquals(0, tab.blocked)
        assertTrue(tab.documentsBlocked.isEmpty())
        assertTrue(policy.asked.isEmpty())
        // The same snapshot still blocks the web – a request an extension page makes included: only
        // the request's URL is read...
        tab.documentUrl = chrome
        assertTrue(Blocking.evaluate(everything, tab, "https://api.example/data.json", false, "*/*", "GET", policy) is Verdict.Empty)
        tab.documentUrl = served
        assertTrue(Blocking.evaluate(everything, tab, "https://api.example/data.json", false, "*/*", "GET", policy) is Verdict.Empty)
        assertEquals(2, tab.blocked)
        // ...and a look-alike host is a web host: the id grammar, not the suffix's words, names the origin.
        for (url in listOf(
            "https://ext.zenium.invalid/options.html",
            "https://abc.ext.zenium.invalid/options.html",
            "https://${"z".repeat(32)}.ext.zenium.invalid/options.html",
            "https://$id.ext.zenium.invalid.attacker.example/options.html",
            "https://evil.example/$id.ext.zenium.invalid/options.html"
        )) {
            assertEquals(url, Decision.Action.BLOCK, Blocking.decideNavigation(everything, tab, url).action)
        }
        // The listed document's question is asked of a web host, never of the served origin.
        assertTrue(Blocking.evaluate(everything, tab, "https://listed.example/landing", true, "text/html", "GET", policy) is Verdict.Empty)
        assertEquals(listOf("https://listed.example/landing"), policy.asked)
    }

    @Test
    fun `a redirect whose target is an extension page still fires - the target is not what is exempt`() {
        val id = "c".repeat(32)
        val installer = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"ext:stylus:static:usercss","source":"dnr","priority":2999,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"redirect","redirect":{"url":"chrome-extension://$id/install.html"}},"condition":{"urlFilter":"||install.example^","resourceTypes":["main_frame"]}}
                        ]}"""
                    )
                )!!
            ),
            null
        )
        val tab = FakeTab()
        val moved = Blocking.evaluate(installer, tab, "https://install.example/theme.user.css", true, "text/html", "GET")
        assertTrue(moved is Verdict.Empty)
        assertEquals(listOf("chrome-extension://$id/install.html"), tab.redirects)
        assertEquals(Decision.Action.REDIRECT, Blocking.decideNavigation(installer, tab, "https://install.example/theme.user.css").action)
        // The page the tab then loads – in the spelling the WebView can load – is the exempt one.
        assertSame(Verdict.Pass, Blocking.evaluate(installer, tab, ExtensionUrls.toServed(tab.redirects[0]), true, "text/html", "GET"))
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(installer, tab, ExtensionUrls.toServed(tab.redirects[0])).action)
    }

    @Test
    fun `the policy's Safe Browsing word comes first, on documents and frames only`() {
        val tab = FakeTab()
        val policy = FakePolicy()
        // A listed document: dropped, and the tab hears why (the warning page), not "blocked".
        val document = Blocking.evaluate(snapshot, tab, "https://listed.example/landing", true, "text/html", "GET", policy)
        assertTrue(document is Verdict.Empty)
        assertEquals(204, (document as Verdict.Empty).status)
        assertEquals(1, tab.unsafe.size)
        assertEquals("https://listed.example/landing", tab.unsafe[0].first)
        assertEquals("urlhaus", tab.unsafe[0].second.feedId)
        assertEquals("malware", tab.unsafe[0].second.threat)
        assertTrue(tab.documentsBlocked.isEmpty())
        assertEquals(0, tab.blocked)
        // A listed frame: an empty 403, counted like a blocked subresource.
        val frame = Blocking.evaluate(snapshot, tab, "https://ads.listed.example/frame", false, "text/html", "GET", policy)
        assertTrue(frame is Verdict.Empty)
        assertEquals(403, (frame as Verdict.Empty).status)
        assertEquals(1, tab.blocked)
        assertEquals(1, tab.unsafe.size)
        // Other subresources of a listed host are not the guard's business (the document never loaded).
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://listed.example/a.js", false, "*/*", "GET", policy))
        assertEquals(2, policy.asked.size)
        // The document's question is marked as the navigation it is (the process's first may wait
        // for the tables); the frame's is not.
        assertEquals(listOf(true, false), policy.navigations)
        // The guard runs even without rule sets, and ahead of them: an unlisted host is the engine's as before.
        assertTrue(Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://listed.example/", true, "text/html", "GET", policy) is Verdict.Empty)
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://news.example/", true, "text/html", "GET", policy))
        assertTrue(Blocking.evaluate(snapshot, tab, "https://malware.example/landing", true, "text/html", "GET", policy) is Verdict.Empty)
        assertEquals(listOf("https://malware.example/landing"), tab.documentsBlocked)
        // Not http(s): never asked.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "about:blank", true, null, "GET", policy))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "data:text/html,<p>hi", true, null, "GET", policy))
        assertEquals(5, policy.asked.size)
        // The JSON the core receives names the feed, the threat and the expression.
        val json = tab.unsafe[0].second.toJson()
        assertEquals("urlhaus", json.getString("feedId"))
        assertEquals("malware", json.getString("threat"))
        assertEquals("listed.example", json.getString("expression"))
        assertEquals(false, json.getBoolean("remote"))
    }

    /** A cookie policy that withholds `never.example`'s cookies (and its subdomains'), the way [app.zen.chromium.privacy.PrivacyFlags.cookiesWithheld] answers for the never list. */
    private class NeverSitePolicy : RequestPolicy {
        val asked = ArrayList<Triple<String, String?, String>>()

        override fun unsafe(url: String, navigation: Boolean): SafeBrowsingHit? = null

        override fun plaintextAllowed(url: String): Boolean = false

        override fun cookiesWithheld(url: String, documentUrl: String?, containerId: String): Boolean {
            asked.add(Triple(url, documentUrl, containerId))
            val host = Domains.hostnameOf(url) ?: return false
            return host == "never.example" || host.endsWith(".never.example")
        }
    }

    @Test
    fun `the cookie policy's word sends a withheld document through the header stage, and only a document`() {
        val policy = NeverSitePolicy()
        val tab = FakeTab(documentUrl = "https://news.example/story", containerId = "work")
        // A never-site's navigation: relayed without cookies, whatever the rule sets say – the
        // empty snapshot included, which otherwise passes everything.
        val document = Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://never.example/", true, "text/html", "GET", policy)
        assertTrue(document is Verdict.HeaderStage)
        val relay = document as Verdict.HeaderStage
        assertEquals(false, relay.withCookies)
        assertEquals(ResourceType.MAIN_FRAME, relay.request.type)
        assertEquals("https://never.example/", relay.request.url)
        assertEquals(Decision.Action.ALLOW, relay.decision.action)
        // The question carried the document's own request (no document URL) and the tab's container.
        assertEquals(Triple("https://never.example/", null, "work"), policy.asked.last())
        // A frame of the never-site inside another page: relayed too, the page named as its document.
        val frame = Blocking.evaluate(snapshot, tab, "https://cdn.never.example/frame", false, "text/html", "GET", policy)
        assertTrue(frame is Verdict.HeaderStage)
        assertEquals(false, (frame as Verdict.HeaderStage).withCookies)
        assertEquals(ResourceType.SUB_FRAME, frame.request.type)
        assertEquals(Triple("https://cdn.never.example/frame", "https://news.example/story", "work"), policy.asked.last())
        // A subresource is never relayed: WebView loads it; the never-site's cookies are gone from
        // the jar instead (the recorded limit). The policy is not even asked.
        val before = policy.asked.size
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://never.example/t.js", false, "*/*", "GET", policy))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://never.example/pixel.png", false, "image/*", "GET", policy))
        assertEquals(before, policy.asked.size)
        // A document the policy does not withhold keeps the plain pass, and a relay a header rule
        // asked for keeps its cookies.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://news.example/", true, "text/html", "GET", policy))
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://news.example/", true, "text/html", "GET", policy))
        val stylus = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"ext:s:_dynamic","source":"dnr","priority":2999,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||fixture.example^","resourceTypes":["main_frame"],"responseHeaders":[{"header":"x-ads"}]}}
                        ]}"""
                    )
                )!!
            ),
            null
        )
        val byRule = Blocking.evaluate(stylus, tab, "https://fixture.example/", true, "text/html", "GET", policy)
        assertTrue(byRule is Verdict.HeaderStage)
        assertEquals(true, (byRule as Verdict.HeaderStage).withCookies)
        assertTrue(byRule.decision.needsHeaders)
        // Both at once: the rule's relay goes without cookies.
        val both = Blocking.evaluate(stylus, FakeTab(), "https://never.example/", true, "text/html", "GET", policy)
        assertEquals(false, (both as Verdict.HeaderStage).withCookies)
        // A request-stage block or redirect stands ahead of the relay: nothing to strip from a
        // document that never loads.
        val blocked = Blocking.evaluate(snapshot, tab, "https://malware.example/never", true, "text/html", "GET", policy)
        assertTrue(blocked is Verdict.Empty)
        // Without a policy the empty snapshot passes as before.
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://never.example/", true, "text/html", "GET"))
        // The listeners see the relay as a request that goes out, cookies or not.
        val listeners = WebRequestListeners()
        val heard = Blocking.evaluate(EngineSnapshot.EMPTY, listeners, tab, "https://never.example/", true, mapOf("Accept" to "text/html"), "GET", policy)
        assertTrue(heard is Verdict.HeaderStage)
        assertEquals(false, (heard as Verdict.HeaderStage).withCookies)
    }

    @Test
    fun `HTTPS-only mode's upgrade is reported as one, and skipped for a site the user allowed over plaintext`() {
        val httpsOnly = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"${Blocking.HTTPS_ONLY_SET}","source":"builtin","priority":1500,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"upgradeScheme"},"condition":{"regexFilter":"^http://[^/?#]*\\.[^/?#]*","resourceTypes":["main_frame"],"excludedRequestDomains":["localhost","127.0.0.1"]}}
                        ]}"""
                    )
                )!!
            ),
            TextEngine.parse(emptyList())
        )
        val tab = FakeTab()
        val policy = FakePolicy()
        // The upgrade: the tab remembers the plaintext URL (for the fallback) rather than following a redirect.
        val upgraded = Blocking.evaluate(httpsOnly, tab, "http://legacy.example/page?x=1", true, "text/html", "GET", policy)
        assertTrue(upgraded is Verdict.Empty)
        assertEquals(listOf("http://legacy.example/page?x=1" to "https://legacy.example/page?x=1"), tab.upgrades)
        assertTrue(tab.redirects.isEmpty())
        // The site the user allowed over plaintext, before the engine reloaded the rule without it: left alone.
        assertSame(Verdict.Pass, Blocking.evaluate(httpsOnly, tab, "http://plain.example/", true, "text/html", "GET", policy))
        assertEquals(1, tab.upgrades.size)
        // The same through the navigation path (shouldOverrideUrlLoading).
        val nav = Blocking.decideNavigation(httpsOnly, tab, "http://legacy.example/")
        assertEquals(Decision.Action.UPGRADE, nav.action)
        assertTrue(Blocking.applyUpgrade(policy, tab, "http://legacy.example/", nav))
        assertEquals("http://legacy.example/" to "https://legacy.example/", tab.upgrades.last())
        val allowed = Blocking.decideNavigation(httpsOnly, tab, "http://plain.example/")
        assertEquals(Decision.Action.UPGRADE, allowed.action)
        assertEquals(false, Blocking.applyUpgrade(policy, tab, "http://plain.example/", allowed))
        // Without a policy every upgrade of the mode's set is reported; other sets' upgrades stay plain redirects.
        assertTrue(Blocking.applyUpgrade(null, tab, "http://plain.example/", allowed))
        assertEquals("http://plain.example/" to "https://plain.example/", tab.upgrades.last())
        val other = Blocking.decideNavigation(snapshot, tab, "http://upgrade.example/")
        assertTrue(Blocking.applyUpgrade(policy, tab, "http://upgrade.example/", other))
        assertEquals(listOf("https://upgrade.example/"), tab.redirects)
        // Hosts without a dot and the excluded ones are not upgraded by the rule itself.
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(httpsOnly, tab, "http://intranet/").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(httpsOnly, tab, "http://localhost:3000/").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(httpsOnly, tab, "http://127.0.0.1/").action)
        assertEquals(Decision.Action.ALLOW, Blocking.decideNavigation(httpsOnly, tab, "https://legacy.example/").action)
    }

    @Test
    fun `HTTPS-only mode leaves non-unique hosts alone - the rule the core writes, and the policy ahead of a stale one`() {
        // The rule as `httpsOnlyRule` in `src/core/protection/service.ts` writes it.
        val httpsOnly = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"${Blocking.HTTPS_ONLY_SET}","source":"builtin","priority":1500,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"|http://","excludedRequestDomains":[],"excludedNonUniqueHosts":true,"resourceTypes":["main_frame"]}}
                        ]}"""
                    )
                )!!
            ),
            TextEngine.parse(emptyList())
        )
        val tab = FakeTab()
        val exempt = listOf(
            "http://localhost:3000/", "http://dev.localhost:5173/", "http://127.0.0.1:8080/", "http://[::1]/",
            "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.0.10/status", "http://169.254.1.1/",
            "http://[fe80::1]/", "http://[fd12::1]/", "http://0.0.0.0:8000/", "http://router/", "http://printer.local/"
        )
        for (url in exempt) {
            assertEquals(url, Decision.Action.ALLOW, Blocking.decideNavigation(httpsOnly, tab, url).action)
            assertSame(url, Verdict.Pass, Blocking.evaluate(httpsOnly, tab, url, true, "text/html", "GET", null))
        }
        assertTrue(tab.upgrades.isEmpty())
        assertEquals(Decision.Action.UPGRADE, Blocking.decideNavigation(httpsOnly, tab, "http://legacy.example/").action)
        assertEquals(Decision.Action.UPGRADE, Blocking.decideNavigation(httpsOnly, tab, "http://8.8.8.8/").action)

        // A rule set written before the flag existed still upgrades them; the policy the core
        // pushes (PrivacyFlags.plaintextAllowed) skips the upgrade on the way to the tab.
        val stale = EngineSnapshot(
            listOf(
                RuleSetInfo.parse(
                    JSONObject(
                        """{"id":"${Blocking.HTTPS_ONLY_SET}","source":"builtin","priority":1500,"enabled":true,"rules":[
                            {"id":1,"action":{"type":"upgradeScheme"},"condition":{"regexFilter":"^http://[^/?#]*\\.[^/?#]*","resourceTypes":["main_frame"]}}
                        ]}"""
                    )
                )!!
            ),
            TextEngine.parse(emptyList())
        )
        val flags = app.zen.chromium.privacy.PrivacyFlags.parse(JSONObject("""{"httpsOnly":"ask"}"""))
        val policy = object : RequestPolicy {
            override fun unsafe(url: String, navigation: Boolean): SafeBrowsingHit? = null
            override fun plaintextAllowed(url: String): Boolean = flags.plaintextAllowed(url)
        }
        val decision = Blocking.decideNavigation(stale, tab, "http://192.168.0.10/status")
        assertEquals(Decision.Action.UPGRADE, decision.action)
        assertEquals(false, Blocking.applyUpgrade(policy, tab, "http://192.168.0.10/status", decision))
        assertSame(Verdict.Pass, Blocking.evaluate(stale, tab, "http://[::1]:8080/", true, "text/html", "GET", policy))
        assertTrue(tab.upgrades.isEmpty())
        assertTrue(Blocking.applyUpgrade(policy, tab, "http://legacy.example/", Blocking.decideNavigation(stale, tab, "http://legacy.example/")))
        assertEquals("http://legacy.example/" to "https://legacy.example/", tab.upgrades.last())
    }

    // --- The response stage for media requests (contract 7.2, services pass 2) -----------------

    @Test
    fun `a media element's Range GET is relayed for its response only while the response stage is observed`() {
        val heard = ArrayList<Request>()
        val observer = DecisionObserver { _, request, _, _, _ -> heard.add(request) }
        val tab = FakeTab()
        // A typed media request, allowed, ranged, the switch on: relayed; the verdict carries the
        // very request the observer heard, so the response is reported under its id.
        val clip = Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true)
        assertTrue(clip is Verdict.MediaRelay)
        assertEquals(ResourceType.MEDIA, (clip as Verdict.MediaRelay).request.type)
        assertEquals(true, clip.withCookies)
        assertSame(heard.last(), clip.request)
        // The ambiguous request nothing tells from a media element's (Accept */*, no telling extension): relayed too.
        val stream = Blocking.evaluate(snapshot, tab, "https://api.example/stream?clip=2", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true)
        assertTrue(stream is Verdict.MediaRelay)
        assertEquals(ResourceType.XMLHTTPREQUEST, (stream as Verdict.MediaRelay).request.type)
        assertEquals(ResourceType.AMBIGUOUS_MASK, stream.request.typeMask)
        // The switch off, or no Range: the plain pass, exactly as before.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = false, ranged = true))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = false))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://api.example/data.json", false, "*/*", "GET", observer = observer, observeResponses = true))
        // `Origin` on the request: a cors-mode fetch / XHR (round 14, Table 1) – the page script's, never relayed,
        // the media type notwithstanding (a fetch of clip.mp4 reads as media by its extension).
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true, hasOrigin = true))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://api.example/stream?clip=2", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true, hasOrigin = true))
        // No type in the selection (7.10): a Range GET without Origin typed image, script, style or font by its
        // Accept or extension is relayed like the ambiguous request – the runtime's twin has no type to read.
        assertTrue(Blocking.evaluate(snapshot, tab, "https://cdn.example/pixel.png", false, "image/avif,*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.MediaRelay)
        assertTrue(Blocking.evaluate(snapshot, tab, "https://cdn.example/app.js", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.MediaRelay)
        assertTrue(Blocking.evaluate(snapshot, tab, "https://cdn.example/site.css", false, "text/css,*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.MediaRelay)
        assertTrue(Blocking.evaluate(snapshot, tab, "https://cdn.example/font.woff2", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.MediaRelay)
        // Not a GET: not relayed.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "POST", observer = observer, observeResponses = true, ranged = true))
        // Documents never: a main frame and a frame keep their own path (no header rule here: the pass).
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://news.example/next", true, "text/html", "GET", observer = observer, observeResponses = true, ranged = true))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://news.example/frame", false, "text/html", "GET", observer = observer, observeResponses = true, ranged = true))
        // A block still blocks, a filter's redirect still substitutes: the relay is for an allow only.
        val blocked = Blocking.evaluate(snapshot, tab, "https://tracker.net/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true)
        assertTrue(blocked is Verdict.Empty)
        assertEquals(403, (blocked as Verdict.Empty).status)
        assertTrue(Blocking.evaluate(snapshot, tab, "https://cdn.example/lib.js", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.Neutered)
        // The empty snapshot with an observer: the allow it reports is relayed like any other.
        assertTrue(Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = true, ranged = true) is Verdict.MediaRelay)
        assertSame(Verdict.Pass, Blocking.evaluate(EngineSnapshot.EMPTY, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", observer = observer, observeResponses = false, ranged = true))
        // The cookie policy's word rides on the relay: a never-site's clip goes without cookies.
        val policy = NeverSitePolicy()
        val withheld = Blocking.evaluate(snapshot, tab, "https://never.example/clip.mp4", false, "*/*", "GET", policy, observer, observeResponses = true, ranged = true)
        assertTrue(withheld is Verdict.MediaRelay)
        assertEquals(false, (withheld as Verdict.MediaRelay).withCookies)
        assertEquals(Triple("https://never.example/clip.mp4", "https://news.example/story", "default"), policy.asked.last())
        val allowed = Blocking.evaluate(snapshot, tab, "https://cdn.example/clip.mp4", false, "*/*", "GET", policy, observer, observeResponses = true, ranged = true)
        assertEquals(true, (allowed as Verdict.MediaRelay).withCookies)
        // The policy is not asked for a request that is not relayed.
        val asked = policy.asked.size
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://never.example/clip.mp4", false, "*/*", "GET", policy, observer, observeResponses = false, ranged = true))
        assertEquals(asked, policy.asked.size)
        // The block and the neutered stand-in above were counted as before; the relays were not.
        assertEquals(2, tab.blocked)
    }

    /**
     * One row of the relay selection's truth table (contract 7.10): the five facts and the answer,
     * with a request that carries them for `Blocking.evaluate` to be asked the same question.
     */
    private class RelayRow(val name: String, val allowed: Boolean, val mainFrame: Boolean, val method: String, val hasRange: Boolean, val hasOrigin: Boolean, val relayed: Boolean, val url: String, val accept: String)

    /** The table, pinned here and in `src/android/__tests__/relaySelection.test.ts` – the same rows, the same answers. */
    private val relayTable = listOf(
        RelayRow("element same-origin", true, false, "GET", true, false, true, "https://news.example/clip.mp4", "*/*"),
        RelayRow("element cross-origin no-cors", true, false, "GET", true, false, true, "https://cdn.example/clip.mp4", "*/*"),
        RelayRow("element crossorigin (the recorded gap: Origin goes with it)", true, false, "GET", true, true, false, "https://cdn.example/clip.mp4", "*/*"),
        RelayRow("fetch same-origin, no Range", true, false, "GET", false, false, false, "https://news.example/data.json", "*/*"),
        RelayRow("fetch same-origin with Range (a range-reading script: the recorded overlap)", true, false, "GET", true, false, true, "https://news.example/data.json", "*/*"),
        RelayRow("fetch cross-origin with Range", true, false, "GET", true, true, false, "https://api.example/data.json", "*/*"),
        RelayRow("XHR cross-origin", true, false, "GET", false, true, false, "https://api.example/data.json", "*/*"),
        RelayRow("main frame", true, true, "GET", true, false, false, "https://news.example/next", "text/html"),
        RelayRow("a blocked request", false, false, "GET", true, false, false, "https://tracker.net/clip.mp4", "*/*"),
        RelayRow("a POST with Range", true, false, "POST", true, false, false, "https://cdn.example/clip.mp4", "*/*"),
        RelayRow("a HEAD with Range", true, false, "HEAD", true, false, false, "https://cdn.example/clip.mp4", "*/*")
    )

    @Test
    fun `the relay selection's truth table holds for the predicate and for the engine alike`() {
        val tab = FakeTab()
        val listeners = WebRequestListeners()
        for (row in relayTable) {
            assertEquals(row.name, row.relayed, RelaySelection.selects(row.allowed, row.mainFrame, row.method, row.hasRange, row.hasOrigin))
            val headers = HashMap<String, String>()
            headers["Accept"] = row.accept
            if (row.hasRange) headers["Range"] = "bytes=0-"
            if (row.hasOrigin) headers["Origin"] = "https://news.example"
            val verdict = Blocking.evaluate(snapshot, listeners, tab, row.url, row.mainFrame, headers, row.method, null, null, observeResponses = true)
            assertEquals(row.name, row.relayed, verdict is Verdict.MediaRelay)
            // The switch off: never, whatever the row says.
            assertTrue(row.name, Blocking.evaluate(snapshot, listeners, tab, row.url, row.mainFrame, headers, row.method, null, null) !is Verdict.MediaRelay)
        }
        // The blocked row still blocks – once with the switch on, once with it off; the main frame's pass is the document path's own.
        assertEquals(2, tab.blocked)
        // The header is found whatever its case, and in any spelling of the name.
        assertTrue(RelaySelection.hasHeader(mapOf("origin" to "https://news.example"), "Origin"))
        assertTrue(RelaySelection.hasHeader(mapOf("RANGE" to "bytes=0-"), "Range"))
        assertEquals(false, RelaySelection.hasHeader(mapOf("Accept" to "*/*"), "Origin"))
    }

    @Test
    fun `the listener registry sees a media relay as a request that goes out, and its own answer comes first`() {
        val tab = FakeTab()
        val listeners = WebRequestListeners()
        val sent = ArrayList<String>()
        listeners.addListener(WebRequestEvent.ON_SEND_HEADERS, { sent.add(it.url); null }, ListenerOptions("ext-a"))
        // The Range header is found whatever its case; the relay is reported to onSendHeaders as a request that goes out.
        val relayed = Blocking.evaluate(snapshot, listeners, tab, "https://cdn.example/clip.mp4", false, mapOf("Accept" to "*/*", "range" to "bytes=0-"), "GET", null, null, observeResponses = true)
        assertTrue(relayed is Verdict.MediaRelay)
        assertEquals(listOf("https://cdn.example/clip.mp4"), sent)
        // Without the header, with Origin beside it (a cors fetch of the clip), or with the switch off: the pass, also a request that goes out.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, listeners, tab, "https://cdn.example/clip.mp4", false, mapOf("Accept" to "*/*"), "GET", null, null, observeResponses = true))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, listeners, tab, "https://cdn.example/clip.mp4", false, mapOf("Accept" to "*/*", "Range" to "bytes=0-", "origin" to "https://news.example"), "GET", null, null, observeResponses = true))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, listeners, tab, "https://cdn.example/clip.mp4", false, mapOf("Accept" to "*/*", "Range" to "bytes=0-"), "GET", null, null))
        assertEquals(4, sent.size)
        // A blocking listener's cancel stands ahead of the relay: the request never goes out.
        listeners.addListener(WebRequestEvent.ON_BEFORE_REQUEST, { BlockingResponse(cancel = true) }, ListenerOptions("ext-b", blocking = true))
        val cancelled = Blocking.evaluate(snapshot, listeners, tab, "https://cdn.example/clip.mp4", false, mapOf("Accept" to "*/*", "Range" to "bytes=0-"), "GET", null, null, observeResponses = true)
        assertTrue(cancelled is Verdict.Empty)
        assertEquals(4, sent.size)
    }

    @Test
    fun extractFilterTextReadsTheStringLiteralWithoutParsingTheDocument() {
        assertEquals("||a.example^\n||b.example^", Blocking.extractFilterText("""{"id":"x","filterText":"||a.example^\n||b.example^","rules":[]}"""))
        assertEquals("tab\there \"quoted\" back\\slash \u00e9", Blocking.extractFilterText("""{"filterText": "tab\there \"quoted\" back\\slash \u00e9"}"""))
        assertEquals("", Blocking.extractFilterText("""{"filterText":""}"""))
        assertNull(Blocking.extractFilterText("""{"id":"x"}"""))
        assertNull(Blocking.extractFilterText("""{"filterText":null}"""))
        assertNull(Blocking.extractFilterText("""{"filterText":"never closes"""))
        // A key-looking substring inside another value does not fool the scanner.
        assertEquals("real", Blocking.extractFilterText("""{"name":"has \"filterText\": inside","filterText":"real"}"""))
    }

    /**
     * The bundled snapshot of the default lists (`resources/blocking`), parsed and matched as the
     * device does it. Numbers are printed for the report; the assertions only guard the order of
     * magnitude so CI never flakes on a slow runner.
     */
    @Test
    fun bundledDefaultListsMatchInMicroseconds() {
        val dir = bundledSnapshotDir()
        assumeTrue("bundled snapshot not found next to the checkout", dir != null)
        val manifest = JSONObject(File(dir!!, "manifest.json").readText())
        val lists = manifest.getJSONArray("lists")
        val texts = ArrayList<String>()
        for (i in 0 until lists.length()) {
            val file = File(dir, lists.getJSONObject(i).getString("file"))
            texts.add(GZIPInputStream(file.inputStream()).bufferedReader().readText())
        }
        val parseStart = System.nanoTime()
        val engine = TextEngine.parse(texts)
        val parseMs = (System.nanoTime() - parseStart) / 1_000_000
        assertTrue("expected the default lists to yield tens of thousands of network filters, got ${engine.filterCount}", engine.filterCount > 50_000)

        val requests = listOf(
            Request("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", ResourceType.SCRIPT, "https://news.example/"),
            Request("https://www.google-analytics.com/analytics.js", ResourceType.SCRIPT, "https://news.example/"),
            Request("https://connect.facebook.net/en_US/fbevents.js", ResourceType.SCRIPT, "https://news.example/"),
            Request("https://securepubads.g.doubleclick.net/tag/js/gpt.js", ResourceType.SCRIPT, "https://news.example/"),
            Request("https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js", ResourceType.SCRIPT, "https://news.example/"),
            Request("https://news.example/static/css/site.css", ResourceType.STYLESHEET, "https://news.example/"),
            Request("https://images.news.example/photos/2026/09/lead.jpg?w=1200", ResourceType.IMAGE, "https://news.example/"),
            Request("https://api.news.example/v2/articles?page=2", ResourceType.XMLHTTPREQUEST, "https://news.example/", typeMask = ResourceType.AMBIGUOUS_MASK),
            Request("https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2", ResourceType.FONT, "https://news.example/"),
            Request("https://www.youtube.com/embed/dQw4w9WgXcQ", ResourceType.SUB_FRAME, "https://news.example/")
        )
        var hits = 0
        for (r in requests) if (engine.match(r)?.action == TextMatch.Action.BLOCK) hits++
        assertTrue("the well-known ad and tracker URLs should be blocked, got $hits of 4", hits >= 4)

        // Warm up, then time.
        for (round in 0 until 200) for (r in requests) engine.match(r)
        val rounds = 2000
        val start = System.nanoTime()
        for (round in 0 until rounds) for (r in requests) engine.match(r)
        val perRequestUs = (System.nanoTime() - start) / 1000.0 / (rounds * requests.size)
        println(
            "blocking benchmark: ${engine.filterCount} network filters from ${lists.length()} lists " +
                "(${engine.rejectedCount} rejected lines, ${engine.wildcardCount} unindexed), parsed in ${parseMs} ms; " +
                "match: ${"%.2f".format(perRequestUs)} us per request over ${requests.size} URLs"
        )
        assertTrue("expected sub-millisecond matching, got $perRequestUs us", perRequestUs < 1000.0)
    }

    @Test
    fun `a bundled list is read by the name the asset merger leaves it under, or as the gzip it was`() {
        val text = "! Title: EasyList\n||ads.example^\n"
        val gzipped = java.io.ByteArrayOutputStream().also { out ->
            java.util.zip.GZIPOutputStream(out).use { it.write(text.toByteArray()) }
        }.toByteArray()

        // The Android Gradle plugin inflated the asset and dropped `.gz`.
        val inflated = mapOf("blocking/easylist.txt" to text.toByteArray())
        assertEquals(text, Blocking.readBundledText("easylist.txt.gz") { name -> inflated[name]?.inputStream() })

        // The resources packaged verbatim.
        val verbatim = mapOf("blocking/easylist.txt.gz" to gzipped)
        assertEquals(text, Blocking.readBundledText("easylist.txt.gz") { name -> verbatim[name]?.inputStream() })

        // A list that was never gzipped, and one that is not there at all.
        assertEquals(text, Blocking.readBundledText("peter-lowe.txt") { name -> if (name == "blocking/peter-lowe.txt") text.byteInputStream() else null })
        assertNull(Blocking.readBundledText("missing.txt.gz") { null })
    }

    private fun bundledSnapshotDir(): File? {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "resources/blocking")
            if (File(candidate, "manifest.json").isFile) return candidate
            dir = dir.parentFile
        }
        return null
    }
}
