package app.zen.chromium.blocking

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

        override fun unsafe(url: String): SafeBrowsingHit? {
            asked.add(url)
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
        // Subresources cannot be redirected from shouldInterceptRequest: they pass.
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "https://moved.example/a.js", false, null, "GET"))
        assertSame(Verdict.Pass, Blocking.evaluate(snapshot, tab, "http://upgrade.example/a.js", false, null, "GET"))
        assertEquals(0, tab.blocked)
        val nav = Blocking.decideNavigation(snapshot, tab, "http://upgrade.example/")
        assertEquals(Decision.Action.UPGRADE, nav.action)
        assertEquals("https://upgrade.example/", nav.redirectUrl)
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
    fun `HTTPS-only mode leaves non-unique hosts alone: the rule the core writes, and the policy ahead of a stale one`() {
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
            override fun unsafe(url: String): SafeBrowsingHit? = null
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
