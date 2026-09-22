package app.zen.chromium.privacy

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The per-site cookie policy's resolution; the twin of the model cases in `src/shared/__tests__/siteData.test.ts`. */
class SiteDataPolicyTest {
    private fun policy(
        blockAll: Boolean = false,
        allow: List<String> = emptyList(),
        clearOnExit: List<String> = emptyList(),
        block: List<String> = emptyList()
    ) = SiteDataPolicy(blockAll, allow, clearOnExit, block)

    @Test
    fun `parses the core's document, normalising the patterns and skipping what does not parse`() {
        val parsed = SiteDataPolicy.parse(
            JSONObject(
                """{"blockAll":true,"allow":["Example.com","bad/path",42,"example.com"],
                    "clearOnExit":["[*.]NEWS.example"],"block":["tracker.example","HTTPS://[*.]ads.example"]}"""
            )
        )
        assertTrue(parsed.blockAll)
        assertEquals(listOf("example.com"), parsed.allow)
        assertEquals(listOf("[*.]news.example"), parsed.clearOnExit)
        assertEquals(listOf("tracker.example", "https://[*.]ads.example"), parsed.block)
        assertFalse(parsed.isEmpty)
        // The document travels back the same.
        assertEquals(parsed, SiteDataPolicy.parse(parsed.toJson()))
        assertSame(SiteDataPolicy.EMPTY, SiteDataPolicy.parse(null))
        val sparse = SiteDataPolicy.parse(JSONObject("""{"blockAll":"yes","allow":"x"}"""))
        assertFalse(sparse.blockAll)
        assertTrue(sparse.isEmpty)
        assertEquals(SiteDataPolicy.EMPTY, sparse)
    }

    @Test
    fun `lets the most specific pattern across the lists decide`() {
        val p = policy(allow = listOf("[*.]example.com"), block = listOf("ads.example.com"), clearOnExit = listOf("[*.]shop.example.com"))
        assertEquals(SiteDataPolicy.State.ALLOW, p.resolve("https://www.example.com/"))
        assertEquals(SiteDataPolicy.State.BLOCK, p.resolve("https://ads.example.com/pixel"))
        assertEquals(SiteDataPolicy.State.CLEAR_ON_EXIT, p.resolve("https://cart.shop.example.com/"))
        assertEquals(SiteDataPolicy.State.DEFAULT, p.resolve("https://other.example/"))
        assertEquals(SiteDataPolicy.State.DEFAULT, p.resolve("about:blank"))
        // The same pattern on every list: the stricter word, block, then clear on exit.
        val tie = policy(allow = listOf("a.example"), clearOnExit = listOf("a.example"), block = listOf("a.example"))
        assertEquals(SiteDataPolicy.State.BLOCK, tie.resolve("https://a.example/"))
        assertEquals(SiteDataPolicy.State.CLEAR_ON_EXIT, policy(allow = listOf("a.example"), clearOnExit = listOf("a.example")).resolve("https://a.example/"))
        // Two different patterns are never a tie: a named scheme before a named port, an exact host before a wildcard.
        assertEquals(SiteDataPolicy.State.ALLOW, policy(allow = listOf("https://a.example"), block = listOf("a.example:443")).resolve("https://a.example/"))
        val wider = policy(allow = listOf("a.example"), block = listOf("[*.]a.example"))
        assertEquals(SiteDataPolicy.State.ALLOW, wider.resolve("https://a.example/"))
        assertEquals(SiteDataPolicy.State.BLOCK, wider.resolve("https://www.a.example/"))
    }

    @Test
    fun `blocks a never-site, allows a listed site, defaults the rest, and blocks all when told`() {
        val p = policy(allow = listOf("[*.]ok.example"), block = listOf("[*.]never.example"), clearOnExit = listOf("s.example"))
        assertEquals(SiteDataPolicy.Verdict.BLOCKED, p.verdict("https://cdn.never.example/x"))
        assertEquals(SiteDataPolicy.Verdict.ALLOWED, p.verdict("https://ok.example/"))
        assertEquals(SiteDataPolicy.Verdict.ALLOWED, p.verdict("https://s.example/"))
        assertEquals(SiteDataPolicy.Verdict.DEFAULT, p.verdict("https://other.example/"))

        val all = policy(blockAll = true, allow = listOf("ok.example"), clearOnExit = listOf("s.example"))
        assertEquals(SiteDataPolicy.Verdict.BLOCKED, all.verdict("https://other.example/"))
        assertEquals(SiteDataPolicy.Verdict.ALLOWED, all.verdict("https://ok.example/"))
        assertEquals(SiteDataPolicy.Verdict.ALLOWED, all.verdict("https://s.example/"))
        assertEquals(SiteDataPolicy.Verdict.BLOCKED, all.verdict("https://www.ok.example/"))
        // A URL without a host is nobody's: the default; an empty policy answers fast with the default.
        assertEquals(SiteDataPolicy.Verdict.DEFAULT, all.verdict("about:blank"))
        assertEquals(SiteDataPolicy.Verdict.DEFAULT, SiteDataPolicy.EMPTY.verdict("https://other.example/"))
        assertTrue(policy(blockAll = true).isEmpty.not())
    }
}
