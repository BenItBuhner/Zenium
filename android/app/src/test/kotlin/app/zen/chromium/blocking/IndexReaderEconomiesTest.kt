package app.zen.chromium.blocking

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.Reader
import java.io.StringReader

/**
 * The three economies of an `IndexReader` read: a disabled set is not compiled until the read
 * that finds it enabled; a set document is streamed from its reader one rule at a time and
 * compiles to what the document parser compiles from the tree; the strings and domain sets of
 * one read are shared across its rules and sets. Each against the engine's decisions.
 */
class IndexReaderEconomiesTest {
    private fun summary(id: String, document: String, tag: String, enabled: Boolean = true, priority: Int = 2999): String =
        """{"id":"$id","source":"dnr","priority":$priority,"enabled":$enabled,"updatedAt":1,"ruleCount":0,"document":"$document","tag":"$tag","hasFilterText":false,"filterCount":0}"""

    private fun index(vararg summaries: String): String = """{"version":2,"sets":[${summaries.joinToString(",")}]}"""

    private fun rule(id: Int, action: String, condition: String, priority: Int = 1): String =
        """{"id":$id,"priority":$priority,"action":{"type":"$action"},"condition":$condition}"""

    private fun document(id: String, vararg rules: String): String = """{"id":"$id","rules":[${rules.joinToString(",")}]}"""

    private fun req(url: String, type: ResourceType = ResourceType.SCRIPT, doc: String? = "https://news.example/story"): Request = Request(url, type, doc)

    private val adsRules = arrayOf(
        rule(1, "block", """{"urlFilter":"||tracker.example^","resourceTypes":["script","image"]}"""),
        rule(2, "allow", """{"urlFilter":"||tracker.example/ok.js","resourceTypes":["script"]}""", priority = 2),
        rule(3, "block", """{"initiatorDomains":["news.example","blog.example"],"requestDomains":["pixel.example"]}""")
    )

    /** `IndexReader.read` over `documents`, counting the documents opened and the readers closed, collecting the lines logged. */
    private class Reading(private val documents: Map<String, String>, private val wrap: (String) -> Reader = { StringReader(it) }) {
        val opened = ArrayList<String>()
        val closed = ArrayList<String>()
        val logged = ArrayList<String>()
        val reader = IndexReader { logged.add(it) }

        fun read(index: String): List<RuleSetInfo> = reader.read(index, IndexReader.Documents { name ->
            opened.add(name)
            documents[name]?.let { text ->
                object : Reader() {
                    private val inner = wrap(text)
                    override fun read(cbuf: CharArray, off: Int, len: Int): Int = inner.read(cbuf, off, len)
                    override fun close() {
                        closed.add(name)
                        inner.close()
                    }
                }
            }
        })
    }

    /** What the document parser (the tree) compiles from the same summaries and documents. */
    private fun parsed(index: String, documents: Map<String, String>): List<RuleSetInfo> {
        val arr = JSONObject(index).getJSONArray("sets")
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.getJSONObject(i)
            RuleSetInfo.parse(o, documents[o.optString("document")]?.let { JSONObject(it).getJSONArray("rules") })
        }
    }

    private fun decisions(sets: List<RuleSetInfo>, requests: List<Request>): List<String> {
        val snapshot = EngineSnapshot(sets, null)
        return requests.map { snapshot.decide(it).let { d -> "${d.action}:${d.matchedSet}:${d.matchedRule}" } }
    }

    // ---- (a) disabled sets -------------------------------------------------------------------

    @Test
    fun aDisabledSetIsNotCompiledUntilTheReadThatFindsItEnabled() {
        val documents = mapOf("sets/ads.json" to document("ext:a:static:ads", *adsRules))
        val reading = Reading(documents)
        val requests = listOf(req("https://tracker.example/t.js"), req("https://tracker.example/ok.js"), req("https://pixel.example/p", ResourceType.IMAGE))

        // Disabled: the summary is read, the document stays closed, no rule is built, nothing is decided by it.
        val off = reading.read(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1", enabled = false)))
        assertEquals(listOf("ext:a:static:ads"), off.map { it.id })
        assertEquals(false, off[0].enabled)
        assertTrue(off[0].rules.isEmpty())
        assertEquals(emptyList<String>(), reading.opened)
        assertEquals(listOf("ALLOW:null:0", "ALLOW:null:0", "ALLOW:null:0"), decisions(off, requests))

        // The read that finds it enabled (the same tag) compiles it: the decisions are the document parser's.
        val on = reading.read(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1")))
        assertEquals(listOf("sets/ads.json"), reading.opened)
        assertEquals(3, on[0].rules.size)
        val expected = decisions(parsed(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1")), documents), requests)
        assertEquals(listOf("BLOCK:ext:a:static:ads:1", "ALLOW:ext:a:static:ads:2", "BLOCK:ext:a:static:ads:3"), expected)
        assertEquals(expected, decisions(on, requests))

        // Unchanged and enabled: shared, not opened. Flipped off: dropped, not opened. On again: compiled anew.
        val again = reading.read(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1")))
        assertSame(on[0].compiled, again[0].compiled)
        val offAgain = reading.read(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1", enabled = false)))
        assertTrue(offAgain[0].rules.isEmpty())
        assertEquals(1, reading.opened.size)
        val onAgain = reading.read(index(summary("ext:a:static:ads", "sets/ads.json", "t1-1")))
        assertEquals(2, reading.opened.size)
        assertNotSame(on[0].compiled, onAgain[0].compiled)
        assertEquals(expected, decisions(onAgain, requests))
        assertEquals(emptyList<String>(), reading.logged)

        // A version-1 entry with its rules inline: a disabled set's are stepped over, whichever side of `enabled` they are written on.
        val inline = """{"version":1,"sets":[""" +
            """{"id":"ext:v1:a","source":"dnr","priority":2999,"enabled":false,"updatedAt":5,"rules":[${adsRules[0]}]},""" +
            """{"id":"ext:v1:b","source":"dnr","priority":2999,"rules":[${adsRules[0]}],"enabled":false,"updatedAt":6},""" +
            """{"id":"ext:v1:c","source":"dnr","priority":2999,"enabled":true,"updatedAt":7,"rules":[${adsRules[0]}]}]}"""
        val v1 = IndexReader().read(inline)
        assertEquals(listOf(0, 0, 1), v1.map { it.rules.size })
    }

    // ---- (b) streaming -----------------------------------------------------------------------

    /** A reader that yields one character per call: every position of the document is a window boundary. */
    private class Trickle(text: String) : Reader() {
        private val inner = StringReader(text)
        override fun read(cbuf: CharArray, off: Int, len: Int): Int = inner.read(cbuf, off, if (len > 0) 1 else 0)
        override fun close() = inner.close()
    }

    @Test
    fun aDocumentIsStreamedOneRuleAtATimeAndCompilesAsTheTreeDoes() {
        // A real-shaped set larger than the cursor's window, with escapes, regular expressions and domain lists throughout,
        // and one rule far longer than the window (a hosts file folded into `requestDomains`).
        val rules = SyntheticRuleSet.rules(600, seed = 3).toMutableList()
        val hosts = (0 until 4000).joinToString(",") { "\"h$it.folded-\\u00e9.example\"" }
        rules.add(rule(9001, "block", """{"requestDomains":[$hosts],"resourceTypes":["image"]}""", priority = 9)) // above the synthetic rules' priorities
        rules.add(rule(9002, "block", """{"urlFilter":"||esc\u0061ped.ex\u0041mple^","initiatorDomains":["tab\tbed.example","quo\"te.example"]}"""))
        val text = document("ext:s:static:big", *rules.toTypedArray())
        assertTrue(text.length > 64 * 1024)
        val documents = mapOf("sets/big.json" to text, "sets/ads.json" to document("ext:a:static:ads", *adsRules))
        val idx = index(summary("ext:s:static:big", "sets/big.json", "t2-1"), summary("ext:a:static:ads", "sets/ads.json", "t1-1", priority = 2998))
        val requests = listOf(
            req("https://h3999.folded-\u00e9.example/i.png", ResourceType.IMAGE),
            req("https://tracker.example/t.js"),
            req("https://adtrk1.com/x.js"),
            req("https://cdn.pixstat77.net/ad/ad77.png", ResourceType.IMAGE),
            req("https://sub.servebid5.org/ads12/abcd.js")
        )
        val expected = parsed(idx, documents)

        for ((label, wrap) in listOf<Pair<String, (String) -> Reader>>("whole" to { StringReader(it) }, "trickle" to { Trickle(it) })) {
            val reading = Reading(documents, wrap)
            val sets = reading.read(idx)
            assertEquals(label, listOf("sets/big.json", "sets/ads.json"), reading.opened)
            assertEquals(label, reading.opened, reading.closed)
            assertEquals(label, emptyList<String>(), reading.logged)
            assertEquals(label, expected.map { it.rules.map { r -> r.id } }, sets.map { it.rules.map { r -> r.id } })
            assertEquals(label, expected.map { it.rules.map { r -> r.effective } }, sets.map { it.rules.map { r -> r.effective } })
            assertEquals(label, expected[0].index.hostCount, sets[0].index.hostCount)
            assertEquals(label, expected[0].index.tokenIndexedCount, sets[0].index.tokenIndexedCount)
            assertEquals(label, expected[0].index.wildcardCount, sets[0].index.wildcardCount)
            assertEquals(label, decisions(expected, requests), decisions(sets, requests))
            assertEquals(label, "BLOCK:ext:s:static:big:9001", decisions(sets, requests)[0])
            val escaped = sets[0].rules.first { it.id == 9002 }
            assertEquals(label, setOf("tab\tbed.example", "quo\"te.example"), escaped.initiatorDomains)
            assertEquals(label, "escaped.example", escaped.pattern!!.hostname)
        }

        // A document cut short mid-stream is left out with a line, the other set read; the reader is closed all the same.
        val cut = Reading(mapOf("sets/big.json" to text.substring(0, text.length - 40), "sets/ads.json" to documents.getValue("sets/ads.json")))
        val sets = cut.read(idx)
        assertEquals(listOf("ext:a:static:ads"), sets.map { it.id })
        assertEquals(listOf("sets/big.json", "sets/ads.json"), cut.closed)
        assertEquals(1, cut.logged.size)
        assertTrue(cut.logged[0], cut.logged[0].startsWith("blocking set ext:s:static:big left out: blocking set document sets/big.json: expected"))
    }

    // ---- (c) interning -----------------------------------------------------------------------

    @Test
    fun theStringsAndDomainSetsOfOneReadAreSharedAcrossItsRulesAndSets() {
        val a = document(
            "ext:a:static:ads",
            rule(1, "block", """{"urlFilter":"||ads.example^","initiatorDomains":["news.example","blog.example"]}"""),
            rule(2, "block", """{"urlFilter":"||ads.example/pixel/*","initiatorDomains":["blog.example","news.example"]}"""),
            rule(3, "block", """{"requestDomains":["news.example"]}"""),
            rule(4, "block", """{"urlFilter":"/track/","initiatorDomains":["NEWS.example"]}""")
        )
        val b = document(
            "ext:b:static:ads",
            rule(1, "block", """{"urlFilter":"||ads.example^","initiatorDomains":["news.example","blog.example"],"resourceTypes":["image"]}"""),
            rule(2, "allow", """{"requestDomains":["news.example"]}""")
        )
        val documents = mapOf("sets/a.json" to a, "sets/b.json" to b)
        val idx = index(summary("ext:a:static:ads", "sets/a.json", "ta-1"), summary("ext:b:static:ads", "sets/b.json", "tb-1", priority = 2998))
        val sets = Reading(documents).read(idx)
        val ra = sets[0].rules.associateBy { it.id }
        val rb = sets[1].rules.associateBy { it.id }

        // One list instance per content, whatever the order or case it was written in, across rules and across sets.
        assertSame(ra.getValue(1).initiatorDomains, ra.getValue(2).initiatorDomains)
        assertSame(ra.getValue(1).initiatorDomains, rb.getValue(1).initiatorDomains)
        assertSame(ra.getValue(3).requestDomains, ra.getValue(4).initiatorDomains)
        assertSame(ra.getValue(3).requestDomains, rb.getValue(2).requestDomains)
        assertEquals(setOf("news.example"), ra.getValue(4).initiatorDomains)
        // One string instance per domain and per hostname.
        val news = ra.getValue(3).requestDomains!!.first()
        assertSame(news, ra.getValue(1).initiatorDomains!!.first { it == "news.example" })
        assertSame(ra.getValue(1).pattern!!.hostname, ra.getValue(2).pattern!!.hostname)
        assertSame(ra.getValue(1).pattern!!.hostname, rb.getValue(1).pattern!!.hostname)

        // The decisions are the document parser's.
        val requests = listOf(
            req("https://ads.example/a.js", doc = "https://news.example/"),
            req("https://ads.example/pixel/p.gif", ResourceType.IMAGE, doc = "https://blog.example/"),
            req("https://news.example/x.js", doc = "https://other.example/"),
            req("https://cdn.example/track/1", doc = "https://news.example/"),
            req("https://ads.example/a.js", doc = "https://other.example/")
        )
        assertEquals(decisions(parsed(idx, documents), requests), decisions(sets, requests))
        assertEquals("BLOCK:ext:a:static:ads:1", decisions(sets, requests)[0])
        assertEquals("ALLOW:null:0", decisions(sets, requests)[4])

        // A second read does not share with the first: the table is the read's.
        val other = Reading(documents).read(idx)
        assertNotSame(ra.getValue(1).initiatorDomains, other[0].rules.first { it.id == 1 }.initiatorDomains)
    }
}
