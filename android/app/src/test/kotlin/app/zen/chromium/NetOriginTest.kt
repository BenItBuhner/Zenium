package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetOriginTest {
    @Test
    fun `without an override the request goes where the core sent it`() {
        for (override in listOf(null, "", "  ")) {
            val r = NetOrigin.redirect("https://api.pwnedpasswords.com/range/21BD1", override)
            assertEquals("https://api.pwnedpasswords.com/range/21BD1", r.url)
            assertNull(r.origin)
        }
    }

    @Test
    fun `the override takes the path and the query, and the meant origin rides in the header`() {
        val r = NetOrigin.redirect("https://api.pwnedpasswords.com/range/21BD1", "http://127.0.0.1:18141")
        assertEquals("http://127.0.0.1:18141/range/21BD1", r.url)
        assertEquals("https://api.pwnedpasswords.com", r.origin)

        val q = NetOrigin.redirect("https://suggest.example/complete/search?q=zen%20browser&client=x", "http://10.0.2.2:8787/")
        assertEquals("http://10.0.2.2:8787/complete/search?q=zen%20browser&client=x", q.url)
        assertEquals("https://suggest.example", q.origin)

        // A URL of the origin alone keeps a path of "/" so the override's server sees a request line.
        assertEquals("http://127.0.0.1:18141/", NetOrigin.redirect("https://example.com", "http://127.0.0.1:18141").url)
        // The core's port, when it names one, is part of the origin it meant.
        assertEquals("https://example.com:8443", NetOrigin.redirect("https://example.com:8443/x", "http://127.0.0.1:1").origin)
    }

    @Test
    fun `a URL or an override that does not parse leaves the request alone`() {
        for (url in listOf("not a url", "mailto:x@example.com", "file:///etc/hosts", "http://", "")) {
            val r = NetOrigin.redirect(url, "http://127.0.0.1:18141")
            assertEquals(url, r.url)
            assertNull(r.origin)
        }
        for (override in listOf("127.0.0.1:18141", "ftp://127.0.0.1", "http://", "nonsense")) {
            val r = NetOrigin.redirect("https://api.pwnedpasswords.com/range/21BD1", override)
            assertEquals("https://api.pwnedpasswords.com/range/21BD1", r.url)
            assertNull(r.origin)
        }
    }
}
