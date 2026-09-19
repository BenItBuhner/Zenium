package app.zen.chromium.blocking

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The builtin connectivity-probe exceptions (`src/core/blocking/connectivityProbes.ts`) as this
 * engine reads them from `blocking/index.json` and the set's document under `blocking/sets/`.
 * The fixtures under `src/test/resources/blocking` are the set exactly as the core's store
 * writes it – its summary and, at the name the summary gives, its document; `service.test.ts`
 * on the TypeScript side asserts the two never drift apart.
 */
class ConnectivityProbesTest {
    private fun resource(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/blocking/$name")) {
            "fixture missing: android/app/src/test/resources/blocking/$name"
        }.bufferedReader().readText()

    private val entry: JSONObject = JSONObject(resource("connectivity-probes.json"))
    private val document: JSONObject = JSONObject(resource(entry.getString("document")))
    private val probes: RuleSetInfo =
        checkNotNull(RuleSetInfo.parse(entry, document.getJSONArray("rules"))) { "the fixture did not parse" }

    /** EasyPrivacy's `generate_204` heuristic and a tracker on the sign-in host, as the lists would have them. */
    private val lists = TextEngine.parse(listOf("/generate_204?\$image\n||accounts.google.com/tracker.gif\n"))

    private val signIn = "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com"

    private val probeUrls = listOf(
        "accounts.google.com/generate_204",
        "www.gstatic.com/generate_204",
        "connectivitycheck.gstatic.com/generate_204",
        "clients3.google.com/generate_204",
        "play.googleapis.com/generate_204",
        "www.google.com/generate_204",
        "android.clients.google.com/generate_204",
        "www.msftconnecttest.com/connecttest.txt",
        "captive.apple.com/hotspot-detect.html"
    )

    @Test
    fun theSetIsBuiltinAboveTheListsAndAlwaysOn() {
        assertEquals("builtin:connectivity-probes", probes.id)
        assertEquals("builtin", probes.source)
        assertTrue("priority above the filter lists", probes.priority > EngineSnapshot.FILTER_LIST_PRIORITY)
        assertTrue(probes.enabled)
        assertFalse(probes.hasFilterText)
        assertEquals(probeUrls.size, probes.rules.size)
        assertTrue(probes.rules.all { it.action == RuleAction.ALLOW })
    }

    @Test
    fun aSignInPagesGenerate204IsAllowedWhileATrackerOnTheHostStaysBlocked() {
        val probe = Request("https://accounts.google.com/generate_204?ZxpZxpZx", ResourceType.IMAGE, signIn)
        // Without the set the lists' heuristic blocks the probe – the sign-in page's "1 blocked".
        assertEquals(Decision.Action.BLOCK, EngineSnapshot(emptyList(), lists).decide(probe).action)

        val snap = EngineSnapshot(listOf(probes), lists)
        val allowed = snap.decide(probe)
        assertEquals(Decision.Action.ALLOW, allowed.action)
        assertEquals("builtin:connectivity-probes", allowed.matchedSet)
        assertEquals(1, allowed.matchedRule)

        val tracker = snap.decide(Request("https://accounts.google.com/tracker.gif?u=1", ResourceType.IMAGE, signIn))
        assertEquals(Decision.Action.BLOCK, tracker.action)
        assertEquals(Decision.TEXT_SET_ID, tracker.matchedSet)
        // Only the probe path is excepted: the heuristic still blocks it elsewhere on the host and
        // on other hosts, and a longer path is nobody's business (the default allow, no rule named).
        assertEquals(Decision.Action.BLOCK, snap.decide(Request("https://accounts.google.com/x/generate_204?p", ResourceType.IMAGE, signIn)).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(Request("https://evil.example/generate_204?x", ResourceType.IMAGE, signIn)).action)
        val longer = snap.decide(Request("https://accounts.google.com/generate_204x?p", ResourceType.IMAGE, signIn))
        assertEquals(Decision.Action.ALLOW, longer.action)
        assertEquals(null, longer.matchedSet)
    }

    @Test
    fun everyProbeIsAllowedAsAnyTypeWithOrWithoutAQuery() {
        val snap = EngineSnapshot(listOf(probes), lists)
        probeUrls.forEachIndexed { index, path ->
            for (url in listOf("https://$path", "http://$path?$index", "https://$path?a=1&b=2")) {
                for (type in listOf(ResourceType.IMAGE, ResourceType.MAIN_FRAME, ResourceType.XMLHTTPREQUEST, ResourceType.OTHER)) {
                    val doc = if (type == ResourceType.MAIN_FRAME) null else signIn
                    val decision = snap.decide(Request(url, type, doc))
                    assertEquals("$type $url", Decision.Action.ALLOW, decision.action)
                    assertEquals("$type $url", "builtin:connectivity-probes", decision.matchedSet)
                    assertEquals("$type $url", index + 1, decision.matchedRule)
                }
                // WebView told us nothing about the type: still the probe.
                val ambiguous = snap.decide(Request(url, ResourceType.OTHER, signIn, typeMask = ResourceType.AMBIGUOUS_MASK))
                assertEquals(url, "builtin:connectivity-probes", ambiguous.matchedSet)
            }
        }
        // Subdomains of a probe host are covered (`||`).
        val sub = snap.decide(Request("https://www.accounts.google.com/generate_204", ResourceType.IMAGE, signIn))
        assertEquals("builtin:connectivity-probes", sub.matchedSet)
        assertNotNull(sub.matchedSet)
    }

    @Test
    fun theSummaryNamesTheDocumentThatCarriesTheRulesForThisEngine() {
        // What `Blocking.readIndex` needs: a summary naming the set's document and its tag, the
        // structured rules in that document under the set's own id, no text file to look up.
        assertFalse(entry.has("rules"))
        assertEquals(probeUrls.size, entry.getInt("ruleCount"))
        assertTrue(entry.getString("document").startsWith("sets/builtin_connectivity-probes-"))
        assertTrue(entry.getString("tag").isNotEmpty())
        assertFalse(entry.optBoolean("hasFilterText", true))
        assertEquals("builtin:connectivity-probes", document.getString("id"))
        val rules = document.getJSONArray("rules")
        assertEquals(probeUrls.size, rules.length())
        for (i in probeUrls.indices) {
            val rule = rules.getJSONObject(i)
            assertEquals(i + 1, rule.getInt("id"))
            assertEquals("allow", rule.getJSONObject("action").getString("type"))
            assertEquals("||${probeUrls[i]}^", rule.getJSONObject("condition").getString("urlFilter"))
        }
    }

    @Test
    fun theEngineReadsTheFixtureThroughTheIndexReaderAsItReadsTheProfile() {
        val index = """{"version":2,"sets":[${entry}]}"""
        val opened = ArrayList<String>()
        val reader = IndexReader { fail("no set left out: $it") }
        val sets = reader.read(index) { name -> opened.add(name); resource(name) }
        assertEquals(listOf(entry.getString("document")), opened)
        val read = sets.single()
        assertEquals(probes.id, read.id)
        assertEquals(probes.priority, read.priority)
        assertEquals(probes.rules.map { it.id }, read.rules.map { it.id })
        assertEquals("${probes.priority}:${entry.getString("tag")}", read.compiled.fingerprint)
        val snap = EngineSnapshot(sets, lists)
        val allowed = snap.decide(Request("https://accounts.google.com/generate_204?x", ResourceType.IMAGE, signIn))
        assertEquals(Decision.Action.ALLOW, allowed.action)
        assertEquals("builtin:connectivity-probes", allowed.matchedSet)
        // Read again from the same summary: the document stays closed, the compiled rules are shared.
        val again = reader.read(index) { name -> opened.add(name); resource(name) }
        assertEquals(1, opened.size)
        assertSame(read.compiled, again.single().compiled)
    }
}
