package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** `IndexReader` against the document parser (`RuleSetInfo.parse`) and across reads. */
class IndexReaderTest {
    private fun req(url: String, type: ResourceType = ResourceType.SCRIPT, doc: String? = "https://news.example/story", partition: String? = null): Request =
        Request(url, type, doc, partition = partition)

    private fun rule(id: Int, action: String, condition: String, priority: Int = 1): String =
        """{"id":$id,"priority":$priority,"action":{"type":"$action"},"condition":$condition}"""

    /** An index in the key order `RuleSetStore` writes (`store.ts`): the fingerprint's fields before `rules`, `file` after. */
    private fun dnrEntry(
        id: String = "ext:abc:static:ads",
        priority: Int = 2999,
        updatedAt: Long = 1700000000000L,
        partitions: String? = """["default","work"]""",
        rules: String = defaultRules,
        enabled: Boolean = true
    ): String = buildString {
        append("""{"id":"$id","source":"dnr","priority":$priority,"enabled":$enabled,"hasFilterText":false,"filterCount":0,""")
        append(""""version":"1.2.3","updatedAt":$updatedAt,"attribution":{"name":"Ads \"quoted\" \\ list","url":"https://x.example/a.json","licence":""},""")
        if (partitions != null) append(""""partitions":$partitions,""")
        append(""""rules":$rules}""")
    }

    private val defaultRules = "[" + listOf(
        rule(1, "block", """{"urlFilter":"||tracker.example^","resourceTypes":["script","image"]}"""),
        rule(2, "allow", """{"urlFilter":"||tracker.example/ok.js","resourceTypes":["script"]}""", priority = 2),
        rule(3, "redirect", """{"regexFilter":"^https://cdn\\.example/([a-z]{2})/lib\\.js$","requestDomains":["cdn.example"]}""")
            .replace(""""action":{"type":"redirect"}""", """"action":{"type":"redirect","redirect":{"url":"https://safe.example/noop.js"}}"""),
        rule(4, "block", """{"initiatorDomains":["news.example"],"requestDomains":["pixel.example"],"excludedRequestDomains":["ok.pixel.example"]}""")
    ).joinToString(",") + "]"

    private val builtinEntry =
        """{"id":"builtin:site-exceptions","source":"builtin","priority":9000,"enabled":true,"hasFilterText":false,"filterCount":0,"rules":[""" +
            """{"id":1,"action":{"type":"allowAllRequests"},"condition":{"urlFilter":"|https://trusted.example/","resourceTypes":["main_frame","sub_frame"]}}]}"""

    private val listEntry =
        """{"id":"easylist","source":"filter-list","priority":1000,"enabled":true,"hasFilterText":true,"filterCount":123,"version":"2024","updatedAt":1690000000000,""" +
            """"attribution":{"name":"EasyList","url":"https://easylist.to/","licence":"GPL"},"file":"easylist.json"}"""

    private val disabledEntry =
        """{"id":"ext:abc:_session","source":"dnr","priority":2999,"enabled":false,"hasFilterText":false,"filterCount":0,"updatedAt":1700000000001,"rules":[${rule(9, "block", """{"urlFilter":"||gone.example^"}""")}]}"""

    private fun index(vararg entries: String, version: Int = 1): String = """{"version":$version,"sets":[${entries.joinToString(",")}]}"""

    private fun sameAsDocumentParser(text: String, sets: List<RuleSetInfo>) {
        val arr = JSONObject(text).getJSONArray("sets")
        val expected = (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { RuleSetInfo.parse(it) } }
        assertEquals(expected.map { it.id }, sets.map { it.id })
        for ((e, s) in expected.zip(sets)) {
            assertEquals(e.id, e.source, s.source)
            assertEquals(e.id, e.priority, s.priority)
            assertEquals(e.id, e.enabled, s.enabled)
            assertEquals(e.id, e.hasFilterText, s.hasFilterText)
            assertEquals(e.id, e.file, s.file)
            assertEquals(e.id, e.updatedAt, s.updatedAt)
            assertEquals(e.id, e.filterCount, s.filterCount)
            assertEquals(e.id, e.partitions, s.partitions)
            assertEquals(e.id, e.rules.map { it.id }, s.rules.map { it.id })
            assertEquals(e.id, e.rules.map { it.effective }, s.rules.map { it.effective })
            assertEquals(e.id, e.textFingerprint, s.textFingerprint)
        }
    }

    @Test
    fun readsWhatTheStoreWritesAsTheDocumentParserDoes() {
        val text = index(dnrEntry(), builtinEntry, listEntry, disabledEntry)
        val sets = IndexReader().read(text)
        assertEquals(listOf("ext:abc:static:ads", "builtin:site-exceptions", "easylist", "ext:abc:_session"), sets.map { it.id })
        sameAsDocumentParser(text, sets)

        val snap = EngineSnapshot(sets, null)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://tracker.example/t.js", partition = "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://tracker.example/ok.js", partition = "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://tracker.example/t.js", partition = "private")).action)
        val redirected = snap.decide(req("https://cdn.example/en/lib.js", partition = "work"))
        assertEquals(Decision.Action.REDIRECT, redirected.action)
        assertEquals("https://safe.example/noop.js", redirected.redirectUrl)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://a.pixel.example/p", ResourceType.IMAGE, partition = "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ok.pixel.example/p", ResourceType.IMAGE, partition = "default")).action)
        // The disabled set's rule is read but takes no part; the list's entry has no rules of its own.
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://gone.example/x.js", partition = "default")).action)
        assertEquals(1, sets[3].rules.size)
        assertTrue(sets[2].rules.isEmpty())
        assertEquals("easylist.json", sets[2].file)
    }

    @Test
    fun anUnchangedExtensionSetKeepsItsCompiledRulesAcrossReads() {
        val reader = IndexReader()
        val first = reader.read(index(dnrEntry(), builtinEntry))
        val again = reader.read(index(dnrEntry(), builtinEntry))
        assertSame("the extension set did not change: its compiled rules are shared", first[0].compiled, again[0].compiled)
        assertNotSame("a built-in set carries no stamp and is compiled at every read", first[1].compiled, again[1].compiled)
        assertEquals("2999:1700000000000", first[0].compiled.fingerprint)
        assertNull(first[1].compiled.fingerprint)

        // A re-scope (`sessionsChanged`) rewrites the partitions and nothing else: the rules stay, the scope is the new one.
        val rescoped = reader.read(index(dnrEntry(partitions = """["default","work","private"]"""), builtinEntry))
        assertSame(first[0].compiled, rescoped[0].compiled)
        assertEquals(setOf("default", "work", "private"), rescoped[0].partitions)
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(rescoped, null).decide(req("https://tracker.example/t.js", partition = "private")).action)

        // A new stamp (the translator emitted the set again) or another priority band recompiles.
        val restamped = reader.read(index(dnrEntry(updatedAt = 1700000000001L), builtinEntry))
        assertNotSame(first[0].compiled, restamped[0].compiled)
        val rebanded = reader.read(index(dnrEntry(updatedAt = 1700000000001L, priority = 2998), builtinEntry))
        assertNotSame(restamped[0].compiled, rebanded[0].compiled)
        assertEquals(DnrRule.effectivePriority(2998, 2), rebanded[0].rules.first().effective)

        // A set gone from the index is forgotten: back with the same stamp, it is compiled anew.
        val without = reader.read(index(builtinEntry))
        assertEquals(listOf("builtin:site-exceptions"), without.map { it.id })
        val back = reader.read(index(dnrEntry(updatedAt = 1700000000001L, priority = 2998), builtinEntry))
        assertNotSame(rebanded[0].compiled, back[0].compiled)
        assertSame(back[0].compiled, reader.read(index(dnrEntry(updatedAt = 1700000000001L, priority = 2998), builtinEntry))[0].compiled)
    }

    @Test
    fun aSkippedRulesArrayIsSteppedOverStringAware() {
        // Brackets, braces, quotes and escapes inside the rules' strings must not end the skip early.
        val tricky = "[" + rule(1, "block", """{"regexFilter":"^https://[a-z]{2}\\.x\\.example/\\]\\}\"\\[\\{\\(","urlFilter":"}]\"","requestDomains":["x.example","a\"b.example"]}""") + "]"
        val reader = IndexReader()
        val first = reader.read(index(dnrEntry(rules = tricky), builtinEntry))
        val second = reader.read(index(dnrEntry(rules = tricky), builtinEntry))
        assertSame(first[0].compiled, second[0].compiled)
        assertEquals(listOf("ext:abc:static:ads", "builtin:site-exceptions"), second.map { it.id })
        assertEquals(1, first[0].rules.size)
        assertEquals(1, second[1].rules.size)
        // The rule read the first time is the one the document parser reads: the regex survived both decodings.
        val snap = EngineSnapshot(first, null)
        assertEquals(Decision.Action.BLOCK, snap.decide(req("https://ab.x.example/]}\"[{(", partition = "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(req("https://ab.x.example/other", partition = "default")).action)
        sameAsDocumentParser(index(dnrEntry(rules = tricky), builtinEntry), first)
    }

    @Test
    fun rulesAheadOfThePriorityAreCompiledOnceTheEntryIsReadWhole() {
        val entry = """{"id":"ext:abc:_dynamic","rules":[${rule(7, "block", """{"urlFilter":"||late.example^"}""", priority = 3)}],"source":"dnr","priority":2999,"enabled":true,"updatedAt":5}"""
        val sets = IndexReader().read(index(entry))
        assertEquals(1, sets.size)
        assertEquals(DnrRule.effectivePriority(2999, 3), sets[0].rules.single().effective)
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(sets, null).decide(req("https://late.example/x.js")).action)
        sameAsDocumentParser(index(entry), sets)
    }

    @Test
    fun stringsAreDecodedAsJsonHasThem() {
        val entry = """{"id":"ext:\u00e9\"q\\uote\/s\n","source":"dnr","priority":1,"enabled":true,"updatedAt":1,"partitions":["caf\u00e9",""," tab\tbed"],"rules":[]}"""
        val sets = IndexReader().read(index(entry))
        assertEquals("ext:é\"q\\uote/s\n", sets[0].id)
        assertEquals(setOf("café", " tab\tbed"), sets[0].partitions)
        sameAsDocumentParser(index(entry), sets)
        // Entries the parser refuses (no id, no priority, not an object) are left out by both.
        val mixed = index("""{"priority":1}""", """{"id":"x"}""", "null", "7", dnrEntry())
        assertEquals(listOf("ext:abc:static:ads"), IndexReader().read(mixed).map { it.id })
        sameAsDocumentParser(mixed, IndexReader().read(mixed))
    }

    @Test
    fun anotherVersionIsEmptyAndMalformedTextThrows() {
        assertTrue(IndexReader().read(index(dnrEntry(), version = 2)).isEmpty())
        assertTrue(IndexReader().read("""{"sets":[${dnrEntry()}]}""").isEmpty())
        assertTrue(IndexReader().read("""  {"version":1,"sets":[]}  """).isEmpty())
        for (bad in listOf("", "not json", """{"version":1,"sets":[""", """{"version":1,"sets":[{"id":"x","priority":1,"rules":[{]}]}""", """{"version":1} trailing""", """{"version":1,"sets":[{"id":"\u12"}]}""")) {
            try {
                IndexReader().read(bad)
                fail("read $bad")
            } catch (expected: JSONException) {
                assertTrue(expected.message, expected.message!!.startsWith("blocking index:"))
            }
        }
    }

    @Test
    fun theDocumentParserAndTheReaderAgreeOnARandomIndex() {
        val random = java.util.Random(7)
        val actions = listOf("block", "allow", "redirect", "upgradeScheme", "allowAllRequests")
        val hosts = listOf("a.example", "b.example", "c.test", "d.example")
        val types = listOf("script", "image", "main_frame", "sub_frame", "xmlhttprequest")
        repeat(20) {
            val sets = JSONArray()
            repeat(1 + random.nextInt(4)) { n ->
                val rules = JSONArray()
                repeat(random.nextInt(12)) { i ->
                    val condition = JSONObject()
                    if (random.nextBoolean()) condition.put("urlFilter", "||${hosts[random.nextInt(hosts.size)]}^")
                    if (random.nextBoolean()) condition.put("requestDomains", JSONArray(listOf(hosts[random.nextInt(hosts.size)])))
                    if (random.nextBoolean()) condition.put("resourceTypes", JSONArray(listOf(types[random.nextInt(types.size)])))
                    val action = JSONObject().put("type", actions[random.nextInt(actions.size)])
                    if (action.getString("type") == "redirect") action.put("redirect", JSONObject().put("url", "https://r.example/$i"))
                    rules.put(JSONObject().put("id", i + 1).put("priority", 1 + random.nextInt(3)).put("action", action).put("condition", condition))
                }
                val set = JSONObject()
                    .put("id", "set-$n").put("source", if (random.nextBoolean()) "dnr" else "builtin")
                    .put("priority", 1 + random.nextInt(5000)).put("enabled", random.nextInt(4) != 0)
                    .put("hasFilterText", false).put("filterCount", 0)
                if (random.nextBoolean()) set.put("updatedAt", 1L + random.nextInt(1000))
                if (random.nextBoolean()) set.put("partitions", JSONArray(listOf("default", "p$n")))
                set.put("rules", rules)
                sets.put(set)
            }
            val text = JSONObject().put("version", 1).put("sets", sets).toString()
            sameAsDocumentParser(text, IndexReader().read(text))
        }
    }
}
