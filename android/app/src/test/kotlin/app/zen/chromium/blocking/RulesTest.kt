package app.zen.chromium.blocking

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RulesTest {
    private fun rule(json: String, setPriority: Int = 1): DnrRule =
        DnrRule.parse(JSONObject(json), setPriority) ?: error("rule did not compile: $json")

    private fun req(
        url: String,
        type: ResourceType = ResourceType.SCRIPT,
        doc: String? = "https://news.example/story",
        method: String = "GET",
        tabId: String? = null,
        typeMask: Int = type.bit
    ): Request = Request(url, type, doc, method, tabId = tabId, typeMask = typeMask)

    @Test
    fun effectivePriorityOrdersBySetBandThenRulePriority() {
        assertTrue(DnrRule.effectivePriority(2, 1) > DnrRule.effectivePriority(1, DnrRule.RULE_PRIORITY_MAX.toInt()))
        assertTrue(DnrRule.effectivePriority(1, 2) > DnrRule.effectivePriority(1, 1))
        assertEquals(DnrRule.effectivePriority(1, 1), DnrRule.effectivePriority(1, 0))
        assertEquals(DnrRule.effectivePriority(1, 1), DnrRule.effectivePriority(1, -5))
        assertEquals(DnrRule.effectivePriority(1, DnrRule.RULE_PRIORITY_MAX.toInt()), DnrRule.effectivePriority(1, Int.MAX_VALUE))
        assertEquals(1L, DnrRule.effectivePriority(0, 1))
    }

    @Test
    fun rulesNeedAnActionAndAValidPattern() {
        assertNull(DnrRule.parse(JSONObject("""{"id":1,"condition":{}}"""), 1))
        assertNull(DnrRule.parse(JSONObject("""{"id":1,"action":{"type":"modifyHeaders"},"condition":{}}"""), 1))
        assertNull(DnrRule.parse(JSONObject("""{"id":1,"action":{"type":"block"},"condition":{"regexFilter":"("}}"""), 1))
        // Header-conditioned rules are kept for the headers-received stage: their request stage
        // matches on the URL, their header stage on the response (HeaderStage relays the document).
        val byType = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"x","responseHeaders":[{"header":"content-type","values":["text/*"]}]}}""")
        assertTrue(byType.needsHeaders)
        assertTrue(byType.matches(req("https://a.example/x")))
        assertTrue(byType.matchesHeaders(mapOf("content-type" to listOf("text/css; charset=utf-8"))))
        assertFalse(byType.matchesHeaders(mapOf("content-type" to listOf("application/json"))))
        assertFalse(byType.matchesHeaders(emptyMap()))
        val excluded = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"x","excludedResponseHeaders":[{"header":"x-ads"}]}}""")
        assertTrue(excluded.needsHeaders)
        assertTrue(excluded.matchesHeaders(emptyMap()))
        assertFalse(excluded.matchesHeaders(mapOf("x-ads" to listOf("1"))))
        val emptyConditions = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"x","responseHeaders":[]}}""")
        assertFalse(emptyConditions.needsHeaders)
        assertTrue(emptyConditions.matches(req("https://a.example/x")))
        val any = rule("""{"id":7,"action":{"type":"block"}}""")
        assertEquals(7, any.id)
        assertEquals(RuleAction.BLOCK, any.action)
        assertTrue(any.matches(req("https://anything.example/x")))
    }

    @Test
    fun urlFilterAndResourceTypesSelectRequests() {
        val r = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","resourceTypes":["script","image"]}}""")
        assertTrue(r.matches(req("https://ads.example/a.js")))
        assertTrue(r.matches(req("https://cdn.ads.example/a.gif", ResourceType.IMAGE)))
        assertFalse(r.matches(req("https://ads.example/a.woff", ResourceType.FONT)))
        assertFalse(r.matches(req("https://example/ads.example")))
        // Unknown-type requests may be scripts: the rule applies.
        assertTrue(r.matches(req("https://ads.example/x", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)))

        val excluded = rule("""{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^","excludedResourceTypes":["script"]}}""")
        assertFalse(excluded.matches(req("https://ads.example/a.js")))
        assertTrue(excluded.matches(req("https://ads.example/a.gif", ResourceType.IMAGE)))
        // An unknown type is only excluded when every type it might be is.
        assertTrue(excluded.matches(req("https://ads.example/x", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)))
        val allAmbiguous = rule("""{"id":3,"action":{"type":"block"},"condition":{"excludedResourceTypes":["script","xmlhttprequest","font","media","object","ping","other"]}}""")
        assertFalse(allAmbiguous.matches(req("https://ads.example/x", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)))
        assertTrue(allAmbiguous.matches(req("https://ads.example/x", ResourceType.IMAGE)))
    }

    /** The structured twin of `*$ping,third-party` (what the translator makes of it): see NetworkFilterTest. */
    @Test
    fun anUnscopedResourceTypesRuleTakesAnUnknownRequestForAFetch() {
        val unknownFetch = req("https://api.example/votes?v=1", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)
        val beacons = rule("""{"id":1,"action":{"type":"block"},"condition":{"resourceTypes":["ping"],"domainType":"thirdParty"}}""")
        assertFalse(beacons.matches(unknownFetch))
        assertTrue(beacons.matches(req("https://api.example/collect", ResourceType.PING)))
        assertTrue(rule("""{"id":2,"action":{"type":"block"},"condition":{"resourceTypes":["ping","xmlhttprequest"]}}""").matches(unknownFetch))
        // Scoped by a URL, a request host or a site, an unknown request may be the type named.
        assertTrue(rule("""{"id":3,"action":{"type":"block"},"condition":{"urlFilter":"||api.example^","resourceTypes":["ping"]}}""").matches(unknownFetch))
        assertTrue(rule("""{"id":4,"action":{"type":"block"},"condition":{"requestDomains":["api.example"],"resourceTypes":["ping"]}}""").matches(unknownFetch))
        assertTrue(rule("""{"id":5,"action":{"type":"block"},"condition":{"initiatorDomains":["news.example"],"resourceTypes":["ping"]}}""").matches(unknownFetch))
        // Excluded domains do not scope the rule.
        assertFalse(rule("""{"id":6,"action":{"type":"block"},"condition":{"excludedInitiatorDomains":["other.example"],"resourceTypes":["ping"]}}""").matches(unknownFetch))
        // An unscoped rule that excludes fetches leaves the unknown request alone; one that excludes beacons blocks it.
        assertFalse(rule("""{"id":7,"action":{"type":"block"},"condition":{"excludedResourceTypes":["xmlhttprequest"]}}""").matches(unknownFetch))
        assertTrue(rule("""{"id":8,"action":{"type":"block"},"condition":{"excludedResourceTypes":["ping"]}}""").matches(unknownFetch))
    }

    @Test
    fun caseSensitivityAndRegexFilters() {
        // A slash-delimited urlFilter is a plain substring in declarativeNetRequest, never a regular expression.
        val insensitive = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"/Tracker/"}}""")
        assertTrue(insensitive.matches(req("https://x.example/tracker/a.js")))
        assertFalse(insensitive.matches(req("https://x.example/trackera.js")))
        val sensitive = rule("""{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"/Tracker/","isUrlFilterCaseSensitive":true}}""")
        assertFalse(sensitive.matches(req("https://x.example/tracker/a.js")))
        assertTrue(sensitive.matches(req("https://x.example/Tracker/a.js")))
        val dots = rule("""{"id":4,"action":{"type":"block"},"condition":{"urlFilter":"/a.b/"}}""")
        assertTrue(dots.matches(req("https://x.example/a.b/c")))
        assertFalse(dots.matches(req("https://x.example/axb/c")))
        val re = rule("""{"id":3,"action":{"type":"block"},"condition":{"regexFilter":"^https://[a-z]+\\.tracker\\.net/(collect|pixel)"}}""")
        assertTrue(re.matches(req("https://abc.tracker.net/collect?x=1")))
        assertFalse(re.matches(req("https://abc.tracker.net/other")))
    }

    @Test
    fun domainListsAndDomainType() {
        val thirdParty = rule("""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||tracker.net^","domainType":"thirdParty"}}""")
        assertTrue(thirdParty.matches(req("https://tracker.net/t.js", doc = "https://news.example/")))
        assertFalse(thirdParty.matches(req("https://tracker.net/t.js", doc = "https://www.tracker.net/")))
        val firstParty = rule("""{"id":2,"action":{"type":"block"},"condition":{"urlFilter":"||tracker.net^","domainType":"firstParty"}}""")
        assertFalse(firstParty.matches(req("https://tracker.net/t.js", doc = "https://news.example/")))
        assertTrue(firstParty.matches(req("https://tracker.net/t.js", doc = "https://www.tracker.net/")))

        val initiators = rule("""{"id":3,"action":{"type":"block"},"condition":{"initiatorDomains":["news.example"],"excludedInitiatorDomains":["safe.news.example"]}}""")
        assertTrue(initiators.matches(req("https://cdn.example/a.js", doc = "https://www.news.example/")))
        assertFalse(initiators.matches(req("https://cdn.example/a.js", doc = "https://safe.news.example/")))
        assertFalse(initiators.matches(req("https://cdn.example/a.js", doc = "https://other.example/")))
        // A navigation has no initiator: rules that need one do not apply.
        assertFalse(initiators.matches(req("https://news.example/", ResourceType.MAIN_FRAME, doc = null)))

        val requests = rule("""{"id":4,"action":{"type":"block"},"condition":{"requestDomains":["cdn.example","tracker.net"],"excludedRequestDomains":["static.cdn.example"]}}""")
        assertTrue(requests.matches(req("https://img.cdn.example/a.gif", ResourceType.IMAGE)))
        assertTrue(requests.matches(req("https://tracker.net/a")))
        assertFalse(requests.matches(req("https://static.cdn.example/a.gif", ResourceType.IMAGE)))
        assertFalse(requests.matches(req("https://other.example/a")))
    }

    /** The twin of `engine.test.ts` "matches topDomains against the top-level document". */
    @Test
    fun topDomainsConditionTheTopLevelDocumentsHost() {
        // Privacy Badger's shape: a tracker is blocked everywhere but on its own site.
        val tracker = rule("""{"id":1,"action":{"type":"block"},"condition":{"requestDomains":["tracker.example"],"excludedTopDomains":["tracker.example"]}}""")
        val cdn = "https://cdn.tracker.example/p.js"
        assertTrue(tracker.matches(req(cdn, doc = "https://www.news.example/story")))
        assertFalse(tracker.matches(req(cdn, doc = "https://www.tracker.example/")))
        assertFalse(tracker.matches(req(cdn, doc = "https://TRACKER.example/")))
        // Nothing known about the page: an exclusion list has nothing to exclude.
        assertTrue(tracker.matches(req(cdn, doc = null)))
        // A main-frame navigation's top-level host is its own (Chrome's `top_level_frame_or_initiator_host`),
        // so the tracker's own site is not blocked when the user goes there.
        assertFalse(tracker.matches(req("https://www.tracker.example/", ResourceType.MAIN_FRAME, doc = null)))
        assertTrue(rule("""{"id":2,"action":{"type":"block"},"condition":{"requestDomains":["tracker.example"],"excludedTopDomains":["news.example"]}}""")
            .matches(req("https://www.tracker.example/", ResourceType.MAIN_FRAME, doc = null)))

        val onNews = rule("""{"id":3,"action":{"type":"block"},"condition":{"urlFilter":"/on-news","topDomains":["news.example"],"excludedTopDomains":["safe.news.example"]}}""")
        assertTrue(onNews.matches(req("https://a.example/on-news", doc = "https://news.example/")))
        assertTrue(onNews.matches(req("https://a.example/on-news", doc = "https://m.news.example/")))
        assertFalse(onNews.matches(req("https://a.example/on-news", doc = "https://safe.news.example/")))
        assertFalse(onNews.matches(req("https://a.example/on-news", doc = "https://shop.example/")))
        // A `topDomains` list needs a known top-level host to match at all.
        assertFalse(onNews.matches(req("https://a.example/on-news", doc = null)))
        assertTrue(onNews.matches(req("https://news.example/on-news", ResourceType.MAIN_FRAME, doc = null)))
        assertFalse(onNews.matches(req("https://shop.example/on-news", ResourceType.MAIN_FRAME, doc = null)))
        // Empty lists are no condition.
        assertTrue(rule("""{"id":4,"action":{"type":"block"},"condition":{"urlFilter":"x","topDomains":[],"excludedTopDomains":[]}}""").matches(req("https://a.example/x", doc = null)))
    }

    @Test
    fun excludedNonUniqueHostsLeavesLoopbackPrivateAddressesAndSuffixlessNamesAlone() {
        val r = rule("""{"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"|http://","excludedNonUniqueHosts":true}}""")
        for (url in listOf(
            "http://localhost:3000/", "http://app.localhost/", "http://127.0.0.1/", "http://[::1]:8080/",
            "http://10.1.2.3/", "http://172.16.0.9/", "http://192.168.1.1/admin", "http://169.254.169.254/",
            "http://[fe80::1]/", "http://[fd00::1]/", "http://0.0.0.0/", "http://intranet/",
            "http://printer.local/", "http://nas.home.arpa/"
        )) assertFalse(url, r.matches(req(url, ResourceType.MAIN_FRAME, doc = null)))
        for (url in listOf("http://example.com/", "http://8.8.8.8/", "http://[2606:4700::1111]/"))
            assertTrue(url, r.matches(req(url, ResourceType.MAIN_FRAME, doc = null)))
        // Without the flag (and in the shape the core wrote before it) the same hosts match as any other.
        val plain = rule("""{"id":2,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"|http://"}}""")
        assertTrue(plain.matches(req("http://192.168.1.1/admin", ResourceType.MAIN_FRAME, doc = null)))
    }

    @Test
    fun methodsAndTabIds() {
        val post = rule("""{"id":1,"action":{"type":"block"},"condition":{"requestMethods":["post"]}}""")
        assertTrue(post.matches(req("https://x.example/a", method = "POST")))
        assertFalse(post.matches(req("https://x.example/a", method = "GET")))
        val notGet = rule("""{"id":2,"action":{"type":"block"},"condition":{"excludedRequestMethods":["GET"]}}""")
        assertFalse(notGet.matches(req("https://x.example/a", method = "GET")))
        assertTrue(notGet.matches(req("https://x.example/a", method = "PUT")))

        val tabs = rule("""{"id":3,"action":{"type":"block"},"condition":{"tabIds":[3, 12]}}""")
        assertTrue(tabs.matches(req("https://x.example/a", tabId = "tab-3")))
        assertTrue(tabs.matches(req("https://x.example/a", tabId = "12")))
        assertFalse(tabs.matches(req("https://x.example/a", tabId = "tab-4")))
        assertFalse(tabs.matches(req("https://x.example/a", tabId = null)))
        val notTab = rule("""{"id":4,"action":{"type":"block"},"condition":{"excludedTabIds":[3]}}""")
        assertFalse(notTab.matches(req("https://x.example/a", tabId = "tab-3")))
        assertTrue(notTab.matches(req("https://x.example/a", tabId = "tab-5")))
        assertTrue(notTab.matches(req("https://x.example/a", tabId = null)))
    }

    @Test
    fun redirectAndUpgradeTargets() {
        val upgrade = rule("""{"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"||news.example^"}}""")
        assertEquals("https://news.example/a", upgrade.target("http://news.example/a"))
        assertNull(upgrade.target("https://news.example/a"))

        val fixed = rule("""{"id":2,"action":{"type":"redirect","redirect":{"url":"https://safe.example/"}},"condition":{"urlFilter":"||bad.example^"}}""")
        assertEquals("https://safe.example/", fixed.target("https://bad.example/x"))
        assertNull(fixed.target("https://safe.example/"))

        val substitution = rule(
            """{"id":3,"action":{"type":"redirect","redirect":{"regexSubstitution":"https://\\1.example/\\2"}},"condition":{"regexFilter":"^https://([a-z]+)\\.tracker\\.net/(.*)$"}}"""
        )
        assertEquals("https://abc.example/path?x=1", substitution.target("https://abc.tracker.net/path?x=1"))
        assertNull(substitution.target("https://other.net/"))
        val block = rule("""{"id":4,"action":{"type":"block"}}""")
        assertNull(block.target("http://x.example/"))
    }

    @Test
    fun ruleSetInfoParsesTheIndexEntryAndOrdersRulesByEffectivePriorityThenAction() {
        val info = RuleSetInfo.parse(
            JSONObject(
                """{"id":"user","source":"user","priority":3,"enabled":true,"hasFilterText":true,"file":"user.json",
                   "updatedAt":1700000000000,"filterCount":12,
                   "rules":[
                     {"id":1,"priority":1,"action":{"type":"block"},"condition":{"urlFilter":"||a.example^"}},
                     {"id":2,"priority":5,"action":{"type":"block"},"condition":{"urlFilter":"||b.example^"}},
                     {"id":3,"priority":5,"action":{"type":"allow"},"condition":{"urlFilter":"||b.example^"}},
                     {"id":4,"action":{"type":"modifyHeaders"},"condition":{}}
                   ]}"""
            )
        )
        assertNotNull(info)
        info!!
        assertEquals("user", info.id)
        assertEquals("user", info.source)
        assertEquals(3, info.priority)
        assertTrue(info.enabled)
        assertTrue(info.hasFilterText)
        assertEquals("user.json", info.file)
        assertEquals(1700000000000L, info.updatedAt)
        assertEquals(12, info.filterCount)
        assertEquals("user.json:1700000000000:12", info.textFingerprint)
        assertEquals(listOf(3, 2, 1), info.rules.map { it.id })

        assertNull(RuleSetInfo.parse(JSONObject("""{"id":"x"}""")))
        assertNull(RuleSetInfo.parse(JSONObject("""{"priority":1}""")))
        val bare = RuleSetInfo.parse(JSONObject("""{"id":"bare","priority":1,"hasFilterText":false,"file":"stale.json"}"""))!!
        assertNull(bare.file)
        assertFalse(bare.hasFilterText)
        assertEquals("filter-list", bare.source)
        assertTrue(bare.enabled)
        assertTrue(bare.rules.isEmpty())
    }
}
