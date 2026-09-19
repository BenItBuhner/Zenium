package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * The indexed lookup of structured rules against the linear scan it replaced, the partition
 * scope of a set, and the hostname lookups of `requestDomains`.
 */
class RuleIndexTest {
    private fun set(id: String, priority: Int, rules: String, partitions: String? = null, source: String = "dnr"): RuleSetInfo =
        RuleSetInfo.parse(
            JSONObject(
                """{"id":"$id","source":"$source","priority":$priority,"enabled":true,"rules":$rules""" +
                    (if (partitions != null) ""","partitions":$partitions""" else "") + "}"
            )
        ) ?: error("set did not parse: $id")

    private fun req(
        url: String,
        type: ResourceType = ResourceType.SCRIPT,
        doc: String? = "https://news.example/story",
        partition: String? = "default"
    ): Request = Request(url, type, doc, tabId = "tab-7", partition = partition)

    private fun rule(id: Int, action: String, condition: String, priority: Int = 1, extra: String = ""): String =
        """{"id":$id,"priority":$priority,"action":{"type":"$action"$extra},"condition":$condition}"""

    // ---------------------------------------------------------------------------------------------
    // Partition scope

    @Test
    fun aScopedSetTakesPartOnlyInRequestsOfItsPartitions() {
        val scoped = set("ext:abc:static:ads", 2999, "[${rule(1, "block", """{"urlFilter":"||ads.example^"}""")}]", partitions = """["default","work"]""")
        val snap = EngineSnapshot(listOf(scoped), null)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://ads.example/a.js")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://ads.example/a.js", partition = "work")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/a.js", partition = "private")).action)
        // A request of no partition meets unscoped sets only, as `appliesToPartition` in engine.ts.
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/a.js", partition = null)).action)
        assertTrue(scoped.appliesTo("work"))
        assertFalse(scoped.appliesTo("private"))
        assertFalse(scoped.appliesTo(null))
    }

    @Test
    fun anUnscopedSetAppliesEverywhereAndAnEmptyScopeNowhere() {
        val everywhere = set("builtin:x", 10, "[${rule(1, "block", """{"urlFilter":"||ads.example^"}""")}]")
        assertTrue(everywhere.appliesTo("private"))
        assertTrue(everywhere.appliesTo(null))
        assertNull(everywhere.partitions)
        // An extension loaded into no session yet: its sets sit in the engine but decide nothing.
        val nowhere = set("ext:abc:_dynamic", 2999, "[${rule(1, "block", """{"urlFilter":"||ads.example^"}""")}]", partitions = "[]")
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(nowhere), null).decide(req("https://ads.example/a.js")).action)
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(listOf(everywhere), null).decide(req("https://ads.example/a.js", partition = "private")).action)
    }

    @Test
    fun aPrivateTabMeetsOnlySetsScopedToPrivate() {
        val notAllowed = set("ext:aaa:static:r", 2999, "[${rule(1, "block", """{"urlFilter":"||ads.example^"}""")}]", partitions = """["default"]""")
        val allowed = set("ext:bbb:static:r", 2998, "[${rule(1, "block", """{"urlFilter":"||tracker.example^"}""")}]", partitions = """["default","private"]""")
        val snap = EngineSnapshot(listOf(notAllowed, allowed), null)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/a.js", partition = "private")).action)
        val hit = snap.decide(req("https://tracker.example/t.js", partition = "private"))
        assertEquals(Decision.Action.BLOCK, hit.action)
        assertEquals("ext:bbb:static:r", hit.matchedSet)
    }

    // ---------------------------------------------------------------------------------------------
    // Hostname lookups

    @Test
    fun requestDomainsMatchTheHostAndItsSubdomainsThroughTheHashSet() {
        val domains = HashSet<String>()
        for (i in 0 until 30_000) domains.add("host$i.example")
        domains.add("ads.example")
        assertTrue(DnrRule.hasDomainOf("ads.example", domains))
        assertTrue(DnrRule.hasDomainOf("cdn.static.ads.example", domains))
        assertTrue(DnrRule.hasDomainOf("host29999.example", domains))
        assertFalse(DnrRule.hasDomainOf("notads.example", domains))
        assertFalse(DnrRule.hasDomainOf("example", domains))
        assertFalse(DnrRule.hasDomainOf("", domains))
        // The same answer as the one-by-one comparison it stands in for.
        for (host in listOf("ads.example", "x.ads.example", "xads.example", "ads.example.evil", "host5.example", "host5.example.net")) {
            assertEquals(host, domains.any { Domains.hostMatchesDomain(host, it) }, DnrRule.hasDomainOf(host, domains))
        }
    }

    @Test
    fun rulesWithoutAUrlFilterAreFoundUnderTheirRequestDomains() {
        val many = JSONArray().also { arr -> for (i in 0 until 5_000) arr.put("h$i.example"); arr.put("ads.example") }
        val set = set(
            "ext:abc:static:hosts", 2999,
            "[${rule(1, "block", """{"requestDomains":$many,"resourceTypes":["script","image"]}""")}," +
                "${rule(2, "allow", """{"requestDomains":["ads.example"],"resourceTypes":["image"]}""")}]"
        )
        assertEquals(5_001, set.index.hostCount)
        assertEquals(0, set.index.wildcardCount)
        val snap = EngineSnapshot(listOf(set), null)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://h4999.example/a.js")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://sub.ads.example/a.js")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/a.png", ResourceType.IMAGE)).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://h4999.example/a.css", ResourceType.STYLESHEET)).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://other.example/a.js")).action)
    }

    @Test
    fun rulesAreIndexedByHostnameTokenOrNotAtAll() {
        val set = set(
            "ext:abc:static:mix", 2999,
            "[${rule(1, "block", """{"urlFilter":"||ads.example^"}""")}," +
                "${rule(2, "block", """{"urlFilter":"/pixel/track?"}""")}," +
                "${rule(3, "block", """{"regexFilter":"^https://[a-z]+\\.tracker\\.example/"}""")}," +
                "${rule(4, "block", """{"resourceTypes":["ping"]}""")}," +
                "${rule(5, "allowAllRequests", """{"urlFilter":"||trusted.example^","resourceTypes":["main_frame"]}""")}," +
                "${rule(6, "block", """{"urlFilter":"*","initiatorDomains":["news.example"],"resourceTypes":["media"]}""")}," +
                "${rule(7, "redirect", """{"regexFilter":"^[^:]+://([^:/]+\\.)?scam\\..*","resourceTypes":["main_frame"]}""", extra = ""","redirect":{"url":"https://safe.example/warn"}""")}]"
        )
        assertEquals(1, set.index.hostCount)
        assertEquals(1, set.index.initiatorCount) // `*` with initiator domains sits under news.example
        assertEquals(2, set.index.tokenIndexedCount) // `/pixel/track?` and the regex whose `tracker` is a whole token
        assertEquals(2, set.index.wildcardCount) // the type-only rule and the regex with `scam` after an optional group
        assertEquals(1, set.index.allowAll.size)
        val snap = EngineSnapshot(listOf(set), null)
        assertEquals(1, snap.decide(req("https://x.ads.example/a.js")).matchedRule)
        assertEquals(2, snap.decide(req("https://cdn.example/pixel/track?id=1", ResourceType.IMAGE)).matchedRule)
        assertEquals(3, snap.decide(req("https://abc.tracker.example/t.js")).matchedRule)
        assertEquals(4, snap.decide(req("https://anything.example/p", ResourceType.PING)).matchedRule)
        assertEquals(6, snap.decide(req("https://media.example/v.mp4", ResourceType.MEDIA)).matchedRule)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://media.example/v.mp4", ResourceType.MEDIA, doc = "https://other.example/")).action)
        // The frame rule allows everything under the trusted document.
        val underTrusted = snap.decide(req("https://x.ads.example/a.js", doc = "https://trusted.example/page"))
        assertEquals(Decision.Action.ALLOW, underTrusted.action)
        assertEquals(5, underTrusted.matchedRule)
        // The main-frame-only regex meets navigations and nothing else.
        val nav = snap.decide(req("https://www.scam.example/login", ResourceType.MAIN_FRAME, doc = null))
        assertEquals(Decision.Action.REDIRECT, nav.action)
        assertEquals(7, nav.matchedRule)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://www.scam.example/a.js", ResourceType.SCRIPT)).action)
    }

    @Test
    fun wildcardRulesAreVisitedOnlyForRequestsOfTheirTypes() {
        val rules = JSONArray()
        for (i in 1..300) {
            rules.put(JSONObject(rule(i, "redirect", """{"regexFilter":"^[^:]+://([^:/]+\\.)?bad$i\\..*","resourceTypes":["main_frame"]}""", extra = ""","redirect":{"url":"https://safe.example/"}""")))
        }
        rules.put(JSONObject(rule(1000, "block", """{"regexFilter":"/[0-9a-f]{12}\\.js$","resourceTypes":["script"]}""")))
        rules.put(JSONObject(rule(1001, "block", """{"regexFilter":"/beac.n\\?","excludedResourceTypes":["main_frame"]}""")))
        val set = set("ext:abc:_session", 2999, rules.toString())
        assertEquals(302, set.index.wildcardCount) // none of these regexes vouches for a whole token
        assertEquals(0, set.index.tokenIndexedCount)
        fun visited(r: Request): List<Int> {
            val out = ArrayList<Int>()
            set.index.forEachCandidate(r) { out.add(it.id) }
            return out
        }
        // An image meets the untyped rule alone; a script the untyped one and the script one; a navigation the 300 and the untyped one.
        assertEquals(listOf(1001), visited(req("https://x.example/a.png", ResourceType.IMAGE)))
        assertEquals(listOf(1000, 1001), visited(req("https://x.example/a.js", ResourceType.SCRIPT)))
        assertEquals(301, visited(req("https://x.example/", ResourceType.MAIN_FRAME, doc = null)).size)
        // A request of unknown type may be a script: the script rule is visited, the main-frame ones are not.
        val unknown = Request("https://x.example/thing", ResourceType.XMLHTTPREQUEST, "https://news.example/", typeMask = ResourceType.AMBIGUOUS_MASK, partition = "default")
        assertEquals(listOf(1000, 1001), visited(unknown))
        val snap = EngineSnapshot(listOf(set), null)
        assertEquals(7, snap.decide(req("https://www.bad7.example/", ResourceType.MAIN_FRAME, doc = null)).matchedRule)
        assertEquals(1000, snap.decide(req("https://cdn.example/0123456789ab.js", ResourceType.SCRIPT)).matchedRule)
        assertEquals(1001, snap.decide(req("https://cdn.example/beacon?x", ResourceType.IMAGE)).matchedRule)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://cdn.example/beacon?x", ResourceType.MAIN_FRAME, doc = null)).action)
    }

    // ---------------------------------------------------------------------------------------------
    // Index vs linear

    @Test
    fun theIndexedResolutionEqualsTheLinearOneOnARandomCorpus() {
        val random = Random(20260918)
        val hosts = (0 until 60).map { "h$it.example" } + listOf("ads.example", "cdn.ads.example", "tracker.net", "news.example", "trusted.example")
        val words = listOf("pixel", "track", "ad", "banner", "js", "img", "api", "beacon", "lib", "main")
        val types = listOf("script", "image", "xmlhttprequest", "stylesheet", "sub_frame", "media", "ping", "font")
        val actions = listOf("block", "block", "block", "allow", "redirect", "upgradeScheme", "allowAllRequests")
        fun pick(list: List<String>) = list[random.nextInt(list.size)]
        val rules = JSONArray()
        var id = 1
        repeat(1_500) {
            val action = pick(actions)
            val condition = JSONObject()
            when (random.nextInt(9)) {
                0 -> condition.put("urlFilter", "||${pick(hosts)}^")
                1 -> condition.put("urlFilter", "/${pick(words)}/${pick(words)}")
                2 -> condition.put("urlFilter", "*${pick(words)}*")
                3 -> condition.put("requestDomains", JSONArray(listOf(pick(hosts), pick(hosts))))
                4 -> condition.put("urlFilter", "||${pick(hosts)}/${pick(words)}")
                5 -> { // a strict-block rule: a main-frame-only regular expression
                    condition.put("regexFilter", "^[^:]+://([^:/]+\\.)?${pick(hosts).replace(".", "\\.")}/.*")
                    condition.put("resourceTypes", JSONArray(listOf("main_frame")))
                }
                6 -> condition.put("initiatorDomains", JSONArray(listOf(pick(hosts), pick(hosts)))) // sites alone
                7 -> condition.put("regexFilter", "/${pick(words)}/[a-z]+\\.${pick(words)}\\?x=[0-8]$") // a regex the token index takes
                else -> Unit // type conditions alone
            }
            if (!condition.has("resourceTypes") && random.nextInt(3) == 0) condition.put("resourceTypes", JSONArray(listOf(pick(types), pick(types))))
            if (random.nextInt(5) == 0) condition.put("excludedRequestDomains", JSONArray(listOf(pick(hosts))))
            if (random.nextInt(5) == 0) condition.put("initiatorDomains", JSONArray(listOf(pick(hosts))))
            if (random.nextInt(6) == 0) condition.put("domainType", if (random.nextBoolean()) "thirdParty" else "firstParty")
            if (action == "allowAllRequests") condition.put("resourceTypes", JSONArray(listOf("main_frame", "sub_frame")))
            val actionObj = JSONObject().put("type", action)
            if (action == "redirect") actionObj.put("redirect", JSONObject().put("url", "https://safe.example/${pick(words)}"))
            rules.put(JSONObject().put("id", id++).put("priority", 1 + random.nextInt(4)).put("action", actionObj).put("condition", condition))
        }
        val half = rules.length() / 2
        val a = JSONArray().also { for (i in 0 until half) it.put(rules.get(i)) }
        val b = JSONArray().also { for (i in half until rules.length()) it.put(rules.get(i)) }
        val snap = EngineSnapshot(
            listOf(set("ext:aaa:static:a", 2999, a.toString()), set("ext:bbb:static:b", 2998, b.toString(), partitions = """["default"]""")),
            TextEngine.parse(listOf("||tracker.net^\$third-party\n@@||news.example/allowed.js"))
        )
        var decided = 0
        var navigations = 0
        repeat(4_000) {
            val navigation = random.nextInt(6) == 0
            val type = if (navigation) ResourceType.MAIN_FRAME else ResourceType.fromDnrName(pick(types)) ?: ResourceType.SCRIPT
            val url = "http${if (random.nextBoolean()) "s" else ""}://${pick(hosts)}/${pick(words)}/${pick(words)}.${pick(words)}?x=${random.nextInt(9)}"
            val doc = if (navigation || random.nextInt(4) == 0) null else "https://${pick(hosts)}/${pick(words)}"
            val request = req(url, type, doc, partition = if (random.nextInt(5) == 0) "private" else "default")
            if (navigation && snap.decide(request).matchedSet != null) navigations++
            val indexed = snap.decide(request)
            val linear = snap.decideLinear(request)
            // Two rules of equal effective priority and action may both match; the first in the
            // set's order wins in both, so the credited rule and a redirect's target agree too.
            assertEquals("$url as $type from $doc", linear.action, indexed.action)
            assertEquals("$url as $type from $doc", linear.matchedSet, indexed.matchedSet)
            assertEquals("$url as $type from $doc", linear.matchedRule, indexed.matchedRule)
            assertEquals("$url as $type from $doc", linear.redirectUrl, indexed.redirectUrl)
            if (indexed.matchedSet != null) decided++
        }
        assertTrue("the corpus decided something", decided > 100)
        assertTrue("navigations were decided too", navigations > 10)
    }

    @Test
    fun aSetKnowsItsRuleCountAndTheSnapshotSumsIt() {
        val a = set("ext:aaa:static:a", 2999, "[${rule(1, "block", """{"urlFilter":"||a.example^"}""")},${rule(2, "block", """{"urlFilter":"||b.example^"}""")}]")
        val b = set("ext:bbb:_session", 2998, "[${rule(1, "block", """{"urlFilter":"||c.example^"}""")}]")
        val snap = EngineSnapshot(listOf(a, b), null)
        assertEquals(3, snap.ruleCount)
        assertEquals(listOf("ext:aaa:static:a", "ext:bbb:_session"), snap.ruleSets.map { it.id })
    }
}
