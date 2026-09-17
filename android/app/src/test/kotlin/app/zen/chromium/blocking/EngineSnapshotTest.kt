package app.zen.chromium.blocking

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Kotlin twin of the resolution cases in `src/core/blocking/__tests__/engine.test.ts`. */
class EngineSnapshotTest {
    private fun set(id: String, priority: Int, rules: String, enabled: Boolean = true, source: String = "builtin"): RuleSetInfo =
        RuleSetInfo.parse(
            JSONObject("""{"id":"$id","source":"$source","priority":$priority,"enabled":$enabled,"rules":$rules}""")
        ) ?: error("set did not parse: $id")

    private fun req(
        url: String,
        type: ResourceType = ResourceType.SCRIPT,
        doc: String? = "https://news.example/story",
        typeMask: Int = type.bit
    ): Request = Request(url, type, doc, typeMask = typeMask)

    private val text = TextEngine.parse(
        listOf("||tracker.net^\$third-party\n||ads.example^\n@@||ads.example/allowed.js\$script\n||cdn.example/lib.js\$script,redirect=noopjs")
    )

    private fun block(id: Int, urlFilter: String, priority: Int = 1): String =
        """{"id":$id,"priority":$priority,"action":{"type":"block"},"condition":{"urlFilter":"$urlFilter"}}"""

    @Test
    fun theEmptySnapshotAllowsEverything() {
        assertEquals(Decision.Action.ALLOW, EngineSnapshot.EMPTY.decide(req("https://tracker.net/t.js")).action)
        assertEquals(0, EngineSnapshot.EMPTY.setCount)
        assertEquals(0, EngineSnapshot.EMPTY.filterCount)
    }

    @Test
    fun filterListMatchesBlockAtTheFilterListBand() {
        val snap = EngineSnapshot(emptyList(), text)
        val blocked = snap.decide(req("https://tracker.net/t.js"))
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertEquals(Decision.TEXT_SET_ID, blocked.matchedSet)
        assertEquals("||tracker.net^", blocked.matchedFilter)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://tracker.net/t.js", doc = "https://www.tracker.net/")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/allowed.js")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://ads.example/allowed.js", ResourceType.IMAGE)).action)
        // A list's `$redirect` is a redirect decision the host answers with a neutered resource.
        val redirected = snap.decide(req("https://cdn.example/lib.js"))
        assertEquals(Decision.Action.REDIRECT, redirected.action)
        assertNull(redirected.redirectUrl)
        assertEquals(Decision.TEXT_SET_ID, redirected.matchedSet)
        assertEquals(4, snap.filterCount)
    }

    @Test
    fun higherPriorityWinsAndAllowBeatsBlockWithinAPriority() {
        val lists = set("lists", 1, "[${block(1, "||x.example^")}]")
        val user = set("user", 10, """[{"id":1,"action":{"type":"allow"},"condition":{"urlFilter":"||x.example^"}}]""", source = "user")
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(listOf(lists), null).decide(req("https://x.example/a.js")).action)
        val allowed = EngineSnapshot(listOf(lists, user), null).decide(req("https://x.example/a.js"))
        assertEquals(Decision.Action.ALLOW, allowed.action)
        assertEquals("user", allowed.matchedSet)
        assertEquals(1, allowed.matchedRule)

        val tie = set(
            "tie", 5,
            """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||x.example^"}},
                {"id":2,"action":{"type":"allow"},"condition":{"urlFilter":"||x.example^"}}]"""
        )
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(tie), null).decide(req("https://x.example/a.js")).action)
        val rulePriority = set("rp", 5, """[${block(1, "||x.example^", 3)},{"id":2,"priority":1,"action":{"type":"allow"},"condition":{"urlFilter":"||x.example^"}}]""")
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(listOf(rulePriority), null).decide(req("https://x.example/a.js")).action)
    }

    @Test
    fun disabledSetsAndSetsWithoutRulesAreIgnored() {
        val off = set("lists", 1, "[${block(1, "||x.example^")}]", enabled = false)
        val snap = EngineSnapshot(listOf(off, set("empty", 50, "[]")), null)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://x.example/a.js")).action)
        assertEquals(2, snap.setCount)
    }

    @Test
    fun structuredRulesOutrankFilterTextOnlyFromAHigherBand() {
        // A user rule (band 10) allows what the lists block.
        val user = set("user", 10, """[{"id":1,"action":{"type":"allow"},"condition":{"urlFilter":"||tracker.net^"}}]""", source = "user")
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(user), text).decide(req("https://tracker.net/t.js")).action)
        // A user block wins over a list exception.
        val userBlock = set("user", 10, "[${block(1, "||ads.example^")}]", source = "user")
        assertEquals("user", EngineSnapshot(listOf(userBlock), text).decide(req("https://ads.example/allowed.js")).matchedSet)
        // In the filter-list band itself the text engine's own resolution stands: the list exception allows.
        val sameBand = set("dnr-ish", 1, "[${block(1, "||ads.example^")}]")
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(sameBand), text).decide(req("https://ads.example/allowed.js")).action)
        // A filter-list-band rule with a higher rule priority beats the text match.
        val stronger = set("dnr-ish", 1, "[${block(1, "||ads.example^", 2)}]")
        assertEquals("dnr-ish", EngineSnapshot(listOf(stronger), text).decide(req("https://ads.example/allowed.js")).matchedSet)
    }

    @Test
    fun allowAllRequestsOnADocumentAllowsEverythingItLoads() {
        val exceptions = set(
            "builtin:site-exceptions", 900,
            """[{"id":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"||news.example^","resourceTypes":["main_frame","sub_frame"]}}]"""
        )
        val snap = EngineSnapshot(listOf(exceptions), text)
        val onExcepted = snap.decide(req("https://tracker.net/t.js", doc = "https://www.news.example/story"))
        assertEquals(Decision.Action.ALLOW, onExcepted.action)
        assertEquals("builtin:site-exceptions", onExcepted.matchedSet)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://tracker.net/t.js", doc = "https://other.example/")).action)
        // The excepted document's own navigation and its frames are allowed too.
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://news.example/", ResourceType.MAIN_FRAME, doc = null)).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ads.example/frame.html", ResourceType.SUB_FRAME, doc = "https://news.example/")).action)
        // A navigation to a blocked site is still blocked elsewhere.
        val blockedNav = EngineSnapshot(listOf(set("lists", 1, "[${block(1, "||malware.example^")}]")), text)
        assertEquals(Decision.Action.BLOCK, blockedNav.decide(req("https://malware.example/", ResourceType.MAIN_FRAME, doc = null)).action)
    }

    /** The exact rule `BlockingService.siteExceptionRule` writes for an `ads` permission of an origin. */
    @Test
    fun perSiteExceptionsFromThePermissionStoreAreOriginExact() {
        val exceptions = set(
            "builtin:site-exceptions", 900,
            """[{"id":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"|https://www.news.example/","resourceTypes":["main_frame","sub_frame"]}}]"""
        )
        val snap = EngineSnapshot(listOf(exceptions), text)
        val tracker = "https://tracker.net/t.js"
        val onExcepted = snap.decide(req(tracker, doc = "https://www.news.example/story?x=1"))
        assertEquals(Decision.Action.ALLOW, onExcepted.action)
        assertEquals("builtin:site-exceptions", onExcepted.matchedSet)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://www.news.example/", ResourceType.MAIN_FRAME, doc = null)).action)
        // Another host, scheme or port of the site is a different origin and stays filtered.
        for (other in listOf(
            "https://news.example/story",
            "https://www.news.example.evil/",
            "http://www.news.example/story",
            "https://www.news.example:8443/story"
        )) {
            assertEquals(other, Decision.Action.BLOCK, snap.decide(req(tracker, doc = other)).action)
        }
    }

    @Test
    fun theGlobalOffSwitchIsAnAllowOnEverything() {
        val off = set("builtin:global-off", 1000, """[{"id":1,"action":{"type":"allow"},"condition":{}}]""")
        val lists = set("lists", 1, "[${block(1, "||x.example^")}]")
        val snap = EngineSnapshot(listOf(lists, off), text)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://x.example/a.js")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://tracker.net/t.js")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://cdn.example/lib.js")).action)
    }

    @Test
    fun extensionsDnrSetsOutrankTheSwitchAndTheSiteExceptions() {
        val off = set("builtin:global-off", 1000, """[{"id":1,"action":{"type":"allow"},"condition":{}}]""")
        val exceptions = set(
            "builtin:site-exceptions", 900,
            """[{"id":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"|https://news.example/","resourceTypes":["main_frame"]}}]"""
        )
        val lists = set("lists", 1, "[${block(1, "||ads.example^")}]")
        val older = set("dnr:older", 2001, "[${block(1, "||ads.example^")}]", source = "dnr")
        val newer = set(
            "dnr:newer", 2002,
            """[{"id":1,"action":{"type":"allow"},"condition":{"urlFilter":"||ads.example^"}}]""", source = "dnr"
        )
        val request = req("https://ads.example/x.js")
        assertEquals(Decision.Action.ALLOW, EngineSnapshot(listOf(lists, exceptions, off), text).decide(request).action)
        val blocked = EngineSnapshot(listOf(lists, exceptions, off, older), text).decide(request)
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertEquals("dnr:older", blocked.matchedSet)
        val allowed = EngineSnapshot(listOf(lists, exceptions, off, older, newer), text).decide(request)
        assertEquals(Decision.Action.ALLOW, allowed.action)
        assertEquals("dnr:newer", allowed.matchedSet)
    }

    @Test
    fun redirectAndUpgradeRulesCarryTheirTarget() {
        val sets = listOf(
            set("dnr", 5, """[{"id":1,"action":{"type":"upgradeScheme"},"condition":{"urlFilter":"||news.example^","resourceTypes":["main_frame"]}},
                {"id":2,"action":{"type":"redirect","redirect":{"url":"https://safe.example/"}},"condition":{"urlFilter":"||bad.example^","resourceTypes":["main_frame"]}}]""")
        )
        val snap = EngineSnapshot(sets, null)
        val upgraded = snap.decide(req("http://news.example/a", ResourceType.MAIN_FRAME, doc = null))
        assertEquals(Decision.Action.UPGRADE, upgraded.action)
        assertEquals("https://news.example/a", upgraded.redirectUrl)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://news.example/a", ResourceType.MAIN_FRAME, doc = null)).action)
        val redirected = snap.decide(req("https://bad.example/x", ResourceType.MAIN_FRAME, doc = null))
        assertEquals(Decision.Action.REDIRECT, redirected.action)
        assertEquals("https://safe.example/", redirected.redirectUrl)
        assertEquals(2, redirected.matchedRule)
    }

    @Test
    fun ambiguousSubresourcesMatchTypedRules() {
        val lists = set("lists", 1, """[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||pixel.example^","resourceTypes":["ping","xmlhttprequest"]}}]""")
        val snap = EngineSnapshot(listOf(lists), null)
        val unknown = req("https://pixel.example/collect", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)
        assertEquals(Decision.Action.BLOCK, snap.decide(unknown).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://pixel.example/p.gif", ResourceType.IMAGE)).action)
    }
}
