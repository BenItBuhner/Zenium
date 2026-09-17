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
    private class FakeTab(override val tabId: String = "tab-1", override var documentUrl: String? = "https://news.example/story") : BlockingTab {
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
