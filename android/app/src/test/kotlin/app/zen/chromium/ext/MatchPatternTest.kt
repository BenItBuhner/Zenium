package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin match patterns give host permissions the semantics of `core/extensions/api/matchPattern.ts`. */
class MatchPatternTest {
    private fun matches(pattern: String, url: String): Boolean {
        val compiled = MatchPattern.compile(pattern) ?: throw AssertionError("$pattern must compile")
        return compiled.matches(url)
    }

    @Test
    fun `all_urls covers the web schemes and nothing else`() {
        assertTrue(matches("<all_urls>", "https://example.com/"))
        assertTrue(matches("<all_urls>", "http://example.com/x?y#z"))
        assertTrue(matches("<all_urls>", "file:///tmp/a.txt"))
        assertTrue(matches("<all_urls>", "data:text/plain,hi"))
        assertFalse(matches("<all_urls>", "chrome-extension://abc/x.html"))
        assertFalse(matches("<all_urls>", "about:blank"))
        assertFalse(matches("<all_urls>", "not a url"))
    }

    @Test
    fun `a star scheme is http or https only`() {
        assertTrue(matches("*://example.com/*", "http://example.com/"))
        assertTrue(matches("*://example.com/*", "https://example.com/deep/path"))
        assertFalse(matches("*://example.com/*", "ftp://example.com/"))
        assertFalse(matches("*://example.com/*", "wss://example.com/"))
        assertTrue(matches("https://example.com/*", "HTTPS://EXAMPLE.COM/"))
        assertFalse(matches("https://example.com/*", "http://example.com/"))
    }

    @Test
    fun `a star dot host covers the host itself and its subdomains`() {
        val pattern = "*://*.google.com/*"
        assertTrue(matches(pattern, "https://google.com/"))
        assertTrue(matches(pattern, "https://www.google.com/images/x.png"))
        assertTrue(matches(pattern, "https://deep.sub.google.com/"))
        assertFalse(matches(pattern, "https://notgoogle.com/"))
        assertFalse(matches(pattern, "https://google.com.evil.test/"))
        assertTrue(matches("*://*/*", "https://anything.test/"))
    }

    @Test
    fun `the path is a glob, the fragment ignored, the query part of the path`() {
        assertTrue(matches("https://api.test/v1/*", "https://api.test/v1/users?page=2"))
        assertFalse(matches("https://api.test/v1/*", "https://api.test/v2/users"))
        assertTrue(matches("https://api.test/", "https://api.test/#frag"))
        assertTrue(matches("https://api.test/", "https://api.test"))
        assertFalse(matches("https://api.test/", "https://api.test/x"))
        assertTrue(matches("https://api.test/*.json", "https://api.test/data/all.json"))
        assertFalse(matches("https://api.test/*.json", "https://api.test/data/all.js"))
        // `?` is a literal in a match-pattern path: it starts the query, not a single-character wildcard.
        assertTrue(matches("https://api.test/x?q=*", "https://api.test/x?q=1"))
        assertFalse(matches("https://api.test/x?q=*", "https://api.test/xaq=1"))
        // Regex metacharacters in the path are literal.
        assertTrue(matches("https://api.test/a.b(c)/*", "https://api.test/a.b(c)/d"))
        assertFalse(matches("https://api.test/a.b(c)/*", "https://api.test/aXb(c)/d"))
    }

    @Test
    fun `ports match when the pattern names one`() {
        assertTrue(matches("https://api.test:8443/*", "https://api.test:8443/v1"))
        assertFalse(matches("https://api.test:8443/*", "https://api.test/v1"))
        assertFalse(matches("https://api.test:8443/*", "https://api.test:443/v1"))
        assertTrue(matches("https://api.test:*/*", "https://api.test:8443/v1"))
        assertTrue(matches("https://api.test:*/*", "https://api.test/v1"))
        // A pattern without a port matches whatever port the URL has, as Chrome does.
        assertTrue(matches("http://127.0.0.1/*", "http://127.0.0.1:8080/echo"))
    }

    @Test
    fun `credentials and IPv6 hosts parse`() {
        assertTrue(matches("https://api.test/*", "https://user:pw@api.test/x"))
        val parsed = MatchPattern.parse("http://[::1]:8080/p?q") ?: throw AssertionError("must parse")
        assertEquals("[::1]", parsed.host)
        assertEquals("8080", parsed.port)
        assertEquals("/p?q", parsed.path)
    }

    @Test
    fun `invalid patterns do not compile and match nothing`() {
        assertNull(MatchPattern.compile("example.com"))
        assertNull(MatchPattern.compile("https://example.com"))
        assertNull(MatchPattern.compile("https:///*"))
        assertNull(MatchPattern.compile("https://ex*ample.com/*"))
        assertNull(MatchPattern.compile("file://host/*"))
        assertNotNull(MatchPattern.compile("file:///*"))
        assertEquals(1, MatchPattern.compileAll(listOf("bogus", "*://a.test/*", "")).size)
        assertFalse(MatchPattern.anyMatches(emptyList(), "https://a.test/"))
        assertTrue(MatchPattern.anyMatches(MatchPattern.compileAll(listOf("bogus", "*://a.test/*")), "https://a.test/"))
    }

    @Test
    fun `matchesOrigin takes the scheme, host and port and leaves the path out`() {
        val exact = MatchPattern.compile("https://mail.google.com/")!!
        assertFalse(exact.matches("https://mail.google.com/mail/u/0/feed/atom"))
        assertTrue(exact.matchesOrigin("https://mail.google.com/mail/u/0/feed/atom"))
        assertFalse(exact.matchesOrigin("http://mail.google.com/"))
        assertFalse(exact.matchesOrigin("https://www.google.com/"))
        val sub = MatchPattern.compile("*://*.example.com/v1/*")!!
        assertTrue(sub.matchesOrigin("http://api.example.com/v2/x"))
        assertFalse(sub.matchesOrigin("ftp://api.example.com/v1/x"))
        val port = MatchPattern.compile("http://localhost:8080/*")!!
        assertTrue(port.matchesOrigin("http://localhost:8080/anything"))
        assertFalse(port.matchesOrigin("http://localhost:9090/anything"))
        assertTrue(MatchPattern.compile("<all_urls>")!!.matchesOrigin("https://x.test/y"))
        assertTrue(MatchPattern.anyMatchesOrigin(listOf(exact, port), "http://localhost:8080/"))
        assertFalse(MatchPattern.anyMatchesOrigin(listOf(exact, port), "http://localhost:81/"))
    }
}
