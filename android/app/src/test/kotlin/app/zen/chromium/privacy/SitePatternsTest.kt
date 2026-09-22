package app.zen.chromium.privacy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Chrome's content-settings pattern grammar; the twin of `src/shared/__tests__/sitePatterns.test.ts`. */
class SitePatternsTest {
    private fun p(text: String): SitePattern = SitePattern.parse(text) ?: error("did not parse: $text")

    @Test
    fun `reads the grammar and writes the canonical text back`() {
        val exact = p("example.com")
        assertEquals("example.com", exact.text)
        assertNull(exact.scheme)
        assertEquals("example.com", exact.host)
        assertFalse(exact.subdomains)
        assertNull(exact.port)
        assertTrue(p("[*.]example.com").subdomains)
        assertEquals("https", p("https://[*.]example.com").scheme)
        assertEquals(8080, p("http://example.com:8080").port)
        assertEquals("[*.]example.com:8080", p("[*.]example.com:8080").text)
        // Case, whitespace, a trailing dot and the any-scheme / any-port wildcards are forgiven.
        assertEquals("https://example.com", SitePattern.normalize("  HTTPS://Example.COM.  "))
        assertEquals("example.com", SitePattern.normalize("*://example.com:*"))
        assertEquals("[*.]example.com", SitePattern.normalize("[*.]Example.com:*"))
        assertEquals("xn--bcher-kva.example", SitePattern.normalize("xn--bcher-kva.example"))
    }

    @Test
    fun `takes IP literals as one machine each`() {
        assertEquals("192.168.0.1", SitePattern.normalize("192.168.0.1"))
        assertEquals("192.168.0.1:8443", SitePattern.normalize("192.168.0.1:8443"))
        assertEquals("[::1]", SitePattern.normalize("[::1]"))
        assertEquals("[::1]", SitePattern.normalize("::1"))
        assertEquals("https://[2001:db8::1]:8443", SitePattern.normalize("https://[2001:db8::1]:8443"))
        assertNull(SitePattern.parse("[*.]192.168.0.1"))
        assertNull(SitePattern.parse("[*.][::1]"))
        assertNull(SitePattern.parse("999.1.1.1"))
    }

    @Test
    fun `refuses what is not a pattern`() {
        for (bad in listOf(
            "", "   ", "https://", "ftp://example.com", "example.com/path", "https://example.com/",
            "user@example.com", "exam ple.com", "*.example.com", "ex*mple.com", "[*.]", "-bad.example",
            "bad-.example", "example.com:0", "example.com:65536", "example.com:12a",
            "a".repeat(64) + ".example", "a.".repeat(130) + "com"
        )) assertNull(bad, SitePattern.parse(bad))
    }

    @Test
    fun `gives a bare host the subdomain wildcard and leaves an IP literal exact`() {
        assertEquals("[*.]example.com", SitePattern.forHost("Example.com"))
        assertEquals("[*.]www.example.com", SitePattern.forHost("www.example.com"))
        assertEquals("10.0.0.2", SitePattern.forHost("10.0.0.2"))
        assertEquals("[::1]", SitePattern.forHost("[::1]"))
        assertNull(SitePattern.forHost("https://example.com"))
        assertNull(SitePattern.forHost("example.com:8080"))
        assertNull(SitePattern.forHost("not a host"))
    }

    @Test
    fun `reads a URL's scheme, host and port, the scheme's default without one`() {
        val a = SiteAddress.of("https://Example.com/a?b#c")!!
        assertEquals(listOf("https", "example.com", 443), listOf(a.scheme, a.host, a.port))
        assertEquals(8080, SiteAddress.of("http://example.com:8080/")!!.port)
        // WebSocket URLs are looked up as the http scheme they ride on.
        val ws = SiteAddress.of("wss://live.example/socket")!!
        assertEquals(listOf("https", "live.example", 443), listOf(ws.scheme, ws.host, ws.port))
        assertEquals("http", SiteAddress.of("ws://live.example/socket")!!.scheme)
        val v6 = SiteAddress.of("https://[::1]:8443/")!!
        assertEquals(listOf("https", "[::1]", 8443), listOf(v6.scheme, v6.host, v6.port))
        assertEquals("example.com", SiteAddress.of("https://user:pw@example.com/")!!.host)
        assertNull(SiteAddress.of("about:blank"))
        assertNull(SiteAddress.of("not a url"))
    }

    @Test
    fun `covers the host alone without the wildcard and its subdomains with it`() {
        assertTrue(p("example.com").matches("https://example.com/"))
        assertFalse(p("example.com").matches("https://www.example.com/"))
        assertTrue(p("[*.]example.com").matches("https://example.com/"))
        assertTrue(p("[*.]example.com").matches("https://a.b.example.com/"))
        assertFalse(p("[*.]example.com").matches("https://notexample.com/"))
        assertFalse(p("[*.]example.com").matches("https://example.com.evil/"))
        assertTrue(p("[*.]example.com").coversHost("Sub.Example.com."))
        assertFalse(p("example.com").coversHost("sub.example.com"))
    }

    @Test
    fun `narrows to a scheme or a port when the pattern names one`() {
        assertTrue(p("https://example.com").matches("https://example.com/"))
        assertFalse(p("https://example.com").matches("http://example.com/"))
        assertTrue(p("https://example.com").matches("wss://example.com/"))
        assertTrue(p("example.com:8443").matches("https://example.com:8443/"))
        assertFalse(p("example.com:8443").matches("https://example.com/"))
        assertTrue(p("example.com").matches("https://example.com:8443/"))
        assertTrue(p("example.com:443").matches("https://example.com/"))
        assertTrue(p("[::1]").matches("http://[::1]:3000/"))
        assertFalse(p("example.com").matches("about:blank"))
    }

    @Test
    fun `orders from the most specific and picks that one of a list`() {
        val order = listOf(
            "https://www.example.com:8443", "https://www.example.com", "www.example.com:8443", "www.example.com",
            "example.com", "https://[*.]www.example.com", "[*.]www.example.com:8443", "[*.]www.example.com",
            "[*.]example.com"
        )
        assertEquals(order, order.reversed().map { p(it) }.sorted().map { it.text })
        assertTrue(p("a.example") < p("b.example"))
        assertEquals(0, p("a.example").compareTo(p("a.example")))

        val list = listOf("[*.]example.com", "www.example.com", "garbage/", "https://[*.]example.com")
        assertEquals("www.example.com", SitePattern.match(list, "https://www.example.com/")?.text)
        assertEquals("https://[*.]example.com", SitePattern.match(list, "https://cdn.example.com/")?.text)
        assertEquals("[*.]example.com", SitePattern.match(list, "http://cdn.example.com/")?.text)
        assertNull(SitePattern.match(list, "https://other.example/"))
        assertNull(SitePattern.match(list, "about:blank"))
        assertNull(SitePattern.match(emptyList(), "https://example.com/"))
    }
}
