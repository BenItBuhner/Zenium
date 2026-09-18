package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin matcher must agree with the TypeScript reference (`dnr.test.ts`): same fixtures,
 * same expectations, so a rule set that the core translates blocks the same requests here.
 */
class NetRulesTest {
    private fun chromeRule(json: String): JSONObject = JSONObject(json)

    private fun rulesOf(vararg chromeRules: String): NetRules {
        val normalised = JSONArray()
        for (rule in chromeRules) normalised.put(NetRules.fromChromeRule(chromeRule(rule), ORIGIN) ?: error("malformed rule $rule"))
        return NetRules(normalised)
    }

    @Test
    fun `domain anchor matches the host and its subdomains only`() {
        val rules = rulesOf("""{"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example.com^","resourceTypes":["script","image"]}}""")
        assertEquals(NetRules.Decision.Block, rules.decide("https://ads.example.com/a.js", "https://site.test/", "script", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://cdn.ads.example.com/a.js", null, "image", "GET"))
        assertNull(rules.decide("https://notads.example.com/a.js", null, "script", "GET"))
        assertNull(rules.decide("https://example.com/ads.example.com/a.js", null, "script", "GET"))
    }

    @Test
    fun `separator and wildcard follow the urlFilter grammar`() {
        assertEquals("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#]*\\.)?example\\.com(?:[^a-zA-Z0-9_\\-.%]|$)", NetRules.urlFilterToRegex("||example.com^"))
        assertEquals("^https:\\/\\/a\\.test\\/.*\\.js$", NetRules.urlFilterToRegex("|https://a.test/*.js|"))
        assertEquals("example.com", NetRules.longestLiteral("||example.com^"))
        assertEquals("/pixel", NetRules.longestLiteral("*/pixel*"))
        assertNull(NetRules.longestLiteral("*^*"))
    }

    @Test
    fun `regexes compile lazily and a malformed regexFilter only disables its own rule`() {
        val rules = rulesOf(
            """{"id":1,"action":{"type":"block"},"condition":{"regexFilter":"(unclosed","resourceTypes":["script"]}}""",
            """{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"||ads.test^","resourceTypes":["script"]}}"""
        )
        assertEquals(2, rules.rules.size)
        assertNull(rules.rules[0].urlRegex)
        assertEquals(NetRules.Decision.Block, rules.decide("https://ads.test/a.js", null, "script", "GET"))
        assertNull(rules.decide("https://x.test/(unclosed", null, "script", "GET"))
    }

    @Test
    fun `the literal prefilter rejects without touching the regex`() {
        val rules = rulesOf("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.test^","resourceTypes":["script"]}}""")
        assertNull(rules.decide("https://x.test/a.js", null, "script", "GET"))
        assertEquals("ads.test", rules.rules[0].requiredLiteral)
    }

    @Test
    fun `resource types default to everything but main_frame`() {
        val rules = rulesOf("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"tracker"}}""")
        assertEquals(NetRules.Decision.Block, rules.decide("https://x.test/tracker.js", null, "script", "GET"))
        assertNull(rules.decide("https://x.test/tracker", null, "main_frame", "GET"))
        val excluded = rulesOf("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"tracker","excludedResourceTypes":["script"]}}""")
        assertNull(excluded.decide("https://x.test/tracker.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Block, excluded.decide("https://x.test/tracker.png", null, "image", "GET"))
    }

    @Test
    fun `allow beats block at equal priority and higher priority wins`() {
        val rules = rulesOf(
            """{"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||example.com^"}}""",
            """{"id":2,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||example.com/keep"}}""",
            """{"id":3,"priority":2,"action":{"type":"block"},"condition":{"urlFilter":"||example.com/keep/never"}}"""
        )
        assertEquals(NetRules.Decision.Block, rules.decide("https://example.com/x.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Allow, rules.decide("https://example.com/keep/x.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://example.com/keep/never.js", null, "script", "GET"))
    }

    @Test
    fun `initiator domains and domainType consult the initiator`() {
        val rules = rulesOf(
            """{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"pixel","initiatorDomains":["news.test"],"domainType":"thirdParty"}}"""
        )
        assertEquals(NetRules.Decision.Block, rules.decide("https://track.test/pixel.gif", "https://www.news.test/article", "image", "GET"))
        assertNull(rules.decide("https://track.test/pixel.gif", "https://other.test/", "image", "GET"))
        assertNull(rules.decide("https://news.test/pixel.gif", "https://www.news.test/", "image", "GET"))
    }

    @Test
    fun `request domain lists match the host and its parents, excluded ones win, and a list of thousands costs a few lookups`() {
        val many = (0 until 5000).joinToString(",") { "\"site$it.test\"" }
        val rules = rulesOf(
            """{"id":1,"action":{"type":"block"},"condition":{"requestDomains":[$many,"ads.example"],"excludedRequestDomains":["safe.ads.example"],"resourceTypes":["image"]}}"""
        )
        assertEquals(NetRules.Decision.Block, rules.decide("https://ads.example/p.gif", null, "image", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://a.b.ads.example/p.gif", null, "image", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://site4999.test/p.gif", null, "image", "GET"))
        assertNull(rules.decide("https://safe.ads.example/p.gif", null, "image", "GET"))
        assertNull(rules.decide("https://x.safe.ads.example/p.gif", null, "image", "GET"))
        assertNull(rules.decide("https://notads.example/p.gif", null, "image", "GET"))
        assertNull(rules.decide("https://example/p.gif", null, "image", "GET"))
        assertTrue(NetRules.hostIn("a.b.c", setOf("c")))
        assertTrue(!NetRules.hostIn("", setOf("")))
        assertTrue(!NetRules.hostIn("bc", setOf("c")))
    }

    @Test
    fun `a urlFilter is indexed by its complete tokens only, and an edge run that may be part of a URL token is not one`() {
        val hash = { s: String -> NetRules.urlTokens(s).single() }
        assertEquals(listOf(hash("ads"), hash("test")), NetRules.filterTokens("||ads.test^").toList())
        // `js` may be the start of `json`; `oho` sits between `/` and `.`.
        assertEquals(listOf(hash("oho")), NetRules.filterTokens("/oho.js").toList())
        // Runs next to a wildcard or at an unanchored edge are not complete tokens.
        assertEquals(emptyList<Int>(), NetRules.filterTokens("*banner").toList())
        assertEquals(emptyList<Int>(), NetRules.filterTokens(".php").toList())
        // `tag` may be the start of `tagged`; `js` is closed by the end anchor.
        assertEquals(listOf(hash("js")), NetRules.filterTokens("/tag*.js|").toList())
        assertEquals(listOf(hash("https"), hash("a"), hash("test"), hash("x")), NetRules.filterTokens("|https://a.test/x|").toList())
        assertEquals(listOf(hash("ad"), hash("server")), NetRules.filterTokens("/AD-Server/").toList())
        // Distinct tokens: https, x, test, 1.
        assertEquals(4, NetRules.urlTokens("https://x.test/x/x?x=1").size)
    }

    @Test
    fun `the token index finds a rule through any of its tokens and keeps the rules it cannot index in play`() {
        val rules = rulesOf(
            """{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"/ads/ban","resourceTypes":["script"]}}""",
            """{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"*banner","resourceTypes":["image"]}}""",
            """{"id":3,"action":{"type":"block"},"condition":{"requestDomains":["track.test"],"resourceTypes":["image"]}}""",
            """{"id":4,"action":{"type":"allow"},"condition":{"urlFilter":"||track.test/keep.gif|","resourceTypes":["image"]}}"""
        )
        assertEquals(2, rules.looseCount)
        // `/ads/ban` is a prefix of the URL's `banner` run: found through `ads`, matched as a substring.
        assertEquals(NetRules.Decision.Block, rules.decide("https://x.test/ads/banner.js", null, "script", "GET"))
        assertNull(rules.decide("https://x.test/ads-banner.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://x.test/xbanner.png", null, "image", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://track.test/p.gif", null, "image", "GET"))
        assertEquals(NetRules.Decision.Allow, rules.decide("https://track.test/keep.gif", null, "image", "GET"))
        assertNull(rules.decide("https://x.test/nothing.gif", null, "image", "GET"))
    }

    @Test
    fun `a request against tens of thousands of rules tests a few dozen of them`() {
        val chrome = ArrayList<String>()
        for (i in 0 until 20_000) chrome.add("""{"id":${i + 1},"action":{"type":"block"},"condition":{"urlFilter":"||host$i.test/path$i/","resourceTypes":["script"]}}""")
        chrome.add("""{"id":20001,"action":{"type":"block"},"condition":{"urlFilter":"||host7.test/path7/","resourceTypes":["image"]}}""")
        val rules = rulesOf(*chrome.toTypedArray())
        assertEquals(0, rules.looseCount)
        assertEquals(NetRules.Decision.Block, rules.decide("https://host7.test/path7/x.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://host7.test/path7/x.png", null, "image", "GET"))
        assertNull(rules.decide("https://host7.test/path8/x.js", null, "script", "GET"))
        val started = System.nanoTime()
        for (i in 0 until 200) rules.decide("https://cdn.other.test/static/app-$i.js?v=$i", "https://other.test/", "script", "GET")
        val perDecisionMicros = (System.nanoTime() - started) / 1_000 / 200
        assertTrue("a decision took $perDecisionMicros µs", perDecisionMicros < 2_000)
    }

    @Test
    fun `redirect resolves extensionPath against the extension origin`() {
        val rules = rulesOf(
            """{"id":9,"action":{"type":"redirect","redirect":{"extensionPath":"/empty.js"}},"condition":{"urlFilter":"||analytics.test/lib.js","resourceTypes":["script"]}}"""
        )
        val decision = rules.decide("https://analytics.test/lib.js", null, "script", "GET")
        assertTrue(decision is NetRules.Decision.Redirect)
        assertEquals("$ORIGIN/empty.js", (decision as NetRules.Decision.Redirect).url)
    }

    @Test
    fun `upgradeScheme and request methods`() {
        val rules = rulesOf(
            """{"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"||insecure.test^","resourceTypes":["main_frame"]}}""",
            """{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"||api.test/log","requestMethods":["post"]}}"""
        )
        assertEquals(NetRules.Decision.UpgradeScheme, rules.decide("http://insecure.test/", null, "main_frame", "GET"))
        assertEquals(NetRules.Decision.Block, rules.decide("https://api.test/log", null, "xmlhttprequest", "POST"))
        assertNull(rules.decide("https://api.test/log", null, "xmlhttprequest", "GET"))
    }

    @Test
    fun `malformed rules are dropped and modifyHeaders never decides`() {
        assertNull(NetRules.fromChromeRule(chromeRule("""{"id":1,"action":{"type":"nonsense"},"condition":{}}"""), ORIGIN))
        assertNull(NetRules.fromChromeRule(chromeRule("""{"action":{"type":"block"},"condition":{}}"""), ORIGIN))
        val rules = rulesOf("""{"id":1,"action":{"type":"modifyHeaders","responseHeaders":[{"header":"x","operation":"remove"}]},"condition":{"urlFilter":"a"}}""")
        assertEquals(1, rules.rules.size)
        assertNull(rules.decide("https://a.test/a", null, "script", "GET"))
    }

    @Test
    fun `case sensitivity is off by default`() {
        val insensitive = rulesOf("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"/AdServer/"}}""")
        assertEquals(NetRules.Decision.Block, insensitive.decide("https://x.test/adserver/x.js", null, "script", "GET"))
        val sensitive = rulesOf("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"/AdServer/","isUrlFilterCaseSensitive":true}}""")
        assertNull(sensitive.decide("https://x.test/adserver/x.js", null, "script", "GET"))
        assertEquals(NetRules.Decision.Block, sensitive.decide("https://x.test/AdServer/x.js", null, "script", "GET"))
    }

    @Test
    fun `resource type guessed from Accept header then URL`() {
        assertEquals("main_frame", NetRules.guessResourceType("https://a.test/", null, isMainFrame = true, isSubFrame = false))
        assertEquals("sub_frame", NetRules.guessResourceType("https://a.test/frame", "text/html,application/xhtml+xml", false, false))
        assertEquals("script", NetRules.guessResourceType("https://a.test/app.js?v=1", "*/*", false, false))
        assertEquals("stylesheet", NetRules.guessResourceType("https://a.test/site.css", "text/css,*/*;q=0.1", false, false))
        assertEquals("image", NetRules.guessResourceType("https://a.test/pixel.gif", "image/avif,image/webp,*/*", false, false))
        assertEquals("font", NetRules.guessResourceType("https://a.test/f.woff2", null, false, false))
        assertEquals("xmlhttprequest", NetRules.guessResourceType("https://a.test/api", "application/json", false, false))
        assertEquals("other", NetRules.guessResourceType("https://a.test/blob", null, false, false))
    }

    companion object {
        private const val ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ext.zenium.invalid"
    }
}
