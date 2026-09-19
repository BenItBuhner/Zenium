package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPatternTest {
    private fun matches(pattern: String, url: String, caseSensitive: Boolean = false): Boolean {
        val p = UrlPattern.parse(pattern, caseSensitive) ?: error("pattern did not parse: $pattern")
        val req = Request(url, ResourceType.SCRIPT, null)
        return p.matches(req.url, req.urlLower, req.host, req.hostStart)
    }

    @Test
    fun hostAnchorMatchesTheDomainAndItsSubdomains() {
        assertTrue(matches("||ads.example.com^", "https://ads.example.com/a.js"))
        assertTrue(matches("||example.com^", "https://ads.example.com/a.js"))
        assertTrue(matches("||example.com^", "http://example.com"))
        assertTrue(matches("||example.com^", "https://example.com:8080/x"))
        assertFalse(matches("||example.com^", "https://notexample.com/"))
        assertFalse(matches("||example.com^", "https://example.com.evil.net/"))
        assertFalse(matches("||example.com^", "https://site.net/?ref=example.com"))
    }

    @Test
    fun hostAnchorWithPathIsNotHostnameOnly() {
        val hostOnly = UrlPattern.parse("||example.com^")!!
        assertTrue(hostOnly.isHostnameOnly)
        assertEquals("example.com", hostOnly.hostname)
        val withPath = UrlPattern.parse("||example.com/ads/")!!
        assertFalse(withPath.isHostnameOnly)
        assertTrue(matches("||example.com/ads/", "https://www.example.com/ads/banner.gif"))
        assertFalse(matches("||example.com/ads/", "https://www.example.com/adsx/banner.gif"))
        assertTrue(matches("||example.com/*/track^", "https://cdn.example.com/v2/track?x=1"))
    }

    @Test
    fun separatorMatchesPunctuationAndTheEndOfTheUrl() {
        assertTrue(matches("/ad^", "https://x.com/ad?x"))
        assertTrue(matches("/ad^", "https://x.com/ad"))
        assertTrue(matches("/ad^", "https://x.com/ad/"))
        assertFalse(matches("/ad^", "https://x.com/adx"))
        assertFalse(matches("/ad^", "https://x.com/ad_1"))
        assertFalse(matches("/ad^", "https://x.com/ad-1"))
        assertFalse(matches("/ad^", "https://x.com/ad.js"))
        assertFalse(matches("/ad^", "https://x.com/ad%20"))
    }

    @Test
    fun wildcardsAndAnchors() {
        assertTrue(matches("/banner*.gif", "https://x.com/banner-120x60.gif"))
        assertTrue(matches("*/tracker/*", "https://x.com/js/tracker/a.js"))
        assertTrue(matches("|https://x.com/", "https://x.com/anything"))
        assertFalse(matches("|https://x.com/", "https://proxy.net/?https://x.com/"))
        assertTrue(matches("swf|", "https://x.com/movie.swf"))
        assertFalse(matches("swf|", "https://x.com/movie.swf?x"))
        assertTrue(matches("|http://*.gif|", "http://x.com/a/b.gif"))
        assertTrue(matches("||x.com/a|", "https://x.com/a"))
        assertFalse(matches("||x.com/a|", "https://x.com/ab"))
    }

    @Test
    fun plainPatternsMatchAnywhereCaseInsensitively() {
        assertTrue(matches("/pixel.gif", "https://x.com/track/PIXEL.GIF"))
        assertFalse(matches("/pixel.gif", "https://x.com/track/PIXEL.GIF", caseSensitive = true))
        assertTrue(matches("/PIXEL.GIF", "https://x.com/track/PIXEL.GIF", caseSensitive = true))
        assertTrue(matches("", "https://anything.example/"))
        assertTrue(matches("*", "https://anything.example/"))
    }

    @Test
    fun regularExpressions() {
        assertTrue(matches("/\\/ad(s|v)?\\d+\\.js/", "https://x.com/ads12.js"))
        assertFalse(matches("/\\/ad(s|v)?\\d+\\.js/", "https://x.com/ads.js"))
        assertNull(UrlPattern.parse("/([a-z/"))
        val p = UrlPattern.parse("/^https:\\/\\/x\\.com\\/(\\d+)\\/(.*)$/")!!
        assertTrue(p.isRegex)
        assertEquals("https://y.com/42/rest", p.substitute("https://x.com/42/rest", "https://y.com/\\1/\\2"))
        assertNull(p.substitute("https://z.com/42/rest", "https://y.com/\\1/\\2"))
    }

    @Test
    fun requiredLiteralOfARegexIsATopLevelRun() {
        assertEquals("tracker", UrlPattern.requiredLiteralOf("^https?://[a-z]+\\.tracker\\.net/"))
        assertNull(UrlPattern.requiredLiteralOf("/(ads|banners)/"))
        assertNull(UrlPattern.requiredLiteralOf("ad|banner"))
        // A quantifier shortens the run it follows; the literal must still be certain.
        assertEquals("pixe", UrlPattern.requiredLiteralOf("pixel?\\.gif"))
        // The digits of a `{n,m}` count are not text of the URL.
        assertNull(UrlPattern.requiredLiteralOf("^[a-z]{100,200}/"))
        assertEquals("tracker", UrlPattern.requiredLiteralOf("/tracker[a-z]{100,200}\\.js"))
    }

    @Test
    fun requiredTokensOfARegexAreItsRunsBoundedByAnchorsOrLiteralSeparators() {
        // `https` is followed by an optional character: not a complete token. `chatgpt`, `com`, `ces` are.
        assertEquals(listOf("chatgpt", "com", "ces"), UrlPattern.requiredTokensOf("^https?:\\/\\/chatgpt\\.com\\/ces\\/v1\\/[a-z]$"))
        assertEquals(listOf("https", "tracker", "example"), UrlPattern.requiredTokensOf("^https://[a-z]+\\.tracker\\.example/"))
        // Anchors bound a run; the end of the expression without one does not.
        assertEquals(listOf("pixel"), UrlPattern.requiredTokensOf("^pixel$"))
        assertNull(UrlPattern.requiredTokensOf("pixel"))
        assertNull(UrlPattern.requiredTokensOf("^pixel"))
        assertEquals(listOf("pixel"), UrlPattern.requiredTokensOf("/pixel/tr"))
        // A group or class next to a run may put more letters against it; a `.` matches anything.
        assertNull(UrlPattern.requiredTokensOf("^[^:]+://([^:/]+\\.)?scam\\..*"))
        assertNull(UrlPattern.requiredTokensOf("/beac.n\\?"))
        assertNull(UrlPattern.requiredTokensOf("\\d+abc\\."))
        assertNull(UrlPattern.requiredTokensOf("/abc[a-z]/"))
        // Escaped metacharacters are literal separators; `-` and `_` count as separators like the tokenizer says.
        assertEquals(listOf("abc", "def"), UrlPattern.requiredTokensOf("\\.abc-def\\?"))
        assertEquals(listOf("abc"), UrlPattern.requiredTokensOf("\\(abc\\)"))
        // A class may end in a separator but is not looked into.
        assertNull(UrlPattern.requiredTokensOf("[x\\-]def\\."))
        // Lowercased for the index over the lowercased URL, and nothing from a top-level alternation.
        assertEquals(listOf("track"), UrlPattern.requiredTokensOf("/Track/"))
        assertNull(UrlPattern.requiredTokensOf("/track/|/pixel/"))
        // The tokens reach the pattern's index tokens.
        val p = UrlPattern.regex("^https://[a-z]+\\.tracker\\.example/", caseSensitive = false)!!
        assertEquals(Tokens.tokenize("https tracker example").toList(), p.tokens().toList())
        assertEquals(0, UrlPattern.regex("/[0-9a-f]{12}\\.js$", caseSensitive = false)!!.tokens().size)
    }

    @Test
    fun tokensAreTheRunsBoundedInsideThePattern() {
        val p = UrlPattern.parse("||example.com/ad-server/*.js")!!
        assertNotNull(p)
        // `js` follows the wildcard's neighbourhood and is not bounded on the right: a URL may continue it.
        assertEquals(Tokens.tokenize("example.com/ad-server/").toList(), p.tokens().toList())
        assertEquals(Tokens.tokenize("tracker.net").toList(), UrlPattern.parse("||tracker.net^")!!.tokens().toList())
        // An unanchored plain pattern: the first and last runs may be partial.
        assertEquals(Tokens.tokenize("pixel").toList(), UrlPattern.parse("ad/pixel/tr")!!.tokens().toList())
        assertEquals(0, UrlPattern.parse("*")!!.tokens().size)
        assertEquals(0, UrlPattern.parse("/ads?/")!!.tokens().size)
    }
}
