package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CookieJarTest {
    private val page = CookieJar.Target.of("https://www.google.com/search?q=zenium#top")!!

    @Test
    fun parsesTheCookieHeaderForm() {
        val cookies = CookieJar.parse("AEC=AVh_V2; NID=511=abc==def; SOCS=CAI; bare;; =empty")
        assertEquals(
            listOf(
                CookieJar.Cookie("AEC", "AVh_V2"),
                // Values keep their own `=` signs (base64 padding is common).
                CookieJar.Cookie("NID", "511=abc==def"),
                CookieJar.Cookie("SOCS", "CAI"),
                CookieJar.Cookie("", "bare"),
                CookieJar.Cookie("", "empty")
            ),
            cookies
        )
        assertTrue(CookieJar.parse(null).isEmpty())
        assertTrue(CookieJar.parse("  ").isEmpty())
    }

    @Test
    fun targetKeepsSchemeHostAndPathOnly() {
        assertEquals("https", page.scheme)
        assertEquals("www.google.com", page.host)
        assertEquals("/search?q=zenium", page.path)
        assertEquals("https://www.google.com/search?q=zenium", page.pageUrl)
        assertEquals("http://www.google.com/search?q=zenium", page.httpUrl)
        assertEquals(listOf("https://google.com/search?q=zenium"), page.parentUrls)
        // Ports and credentials do not scope cookies; a bare host gets the root path.
        val dev = CookieJar.Target.of("http://user@LocalHost:8080")!!
        assertEquals("localhost", dev.host)
        assertEquals("/", dev.path)
        assertNull(CookieJar.Target.of("zen://settings".replace("//", "")))
        assertNull(CookieJar.Target.of("not a url"))
        assertNotNull(CookieJar.Target.of("zen://blank"))
    }

    @Test
    fun hostsWalkUpToTheRegistrableDomain() {
        assertEquals(listOf("www.google.com", "google.com"), CookieJar.hostsOf("www.google.com"))
        assertEquals(listOf("a.b.mail.google.com", "b.mail.google.com", "mail.google.com", "google.com"), CookieJar.hostsOf("a.b.mail.google.com"))
        assertEquals(listOf("google.com"), CookieJar.hostsOf("google.com"))
        // Second-level country suffixes stay whole.
        assertEquals(listOf("www.bbc.co.uk", "bbc.co.uk"), CookieJar.hostsOf("www.bbc.co.uk"))
        assertEquals("bbc.co.uk", CookieJar.registrableDomain("news.bbc.co.uk"))
        assertEquals(listOf("localhost"), CookieJar.hostsOf("localhost"))
        assertEquals(listOf("10.0.2.2"), CookieJar.hostsOf("10.0.2.2"))
        assertTrue(CookieJar.hostsOf("").isEmpty())
    }

    @Test
    fun classifiesSecureAndDomainScopeFromTheRelatedReadings() {
        val jar = mapOf(
            // The page itself: everything it receives.
            "https://www.google.com/search?q=zenium" to "AEC=1; NID=2; SIDCC=3; host_only=4",
            // Over plain http the Secure cookies are missing.
            "http://www.google.com/search?q=zenium" to "NID=2; host_only=4",
            // The parent domain still carries the cookies scoped to `.google.com`.
            "https://google.com/search?q=zenium" to "AEC=1; NID=2; SIDCC=3"
        )
        val classified = CookieJar.classify(page) { url -> CookieJar.parse(jar[url]) }
        assertEquals(
            listOf(
                CookieJar.Classified("AEC", ".google.com", secure = true, size = 4),
                CookieJar.Classified("NID", ".google.com", secure = false, size = 4),
                CookieJar.Classified("SIDCC", ".google.com", secure = true, size = 6),
                CookieJar.Classified("host_only", "www.google.com", secure = false, size = 10)
            ),
            classified
        )
    }

    @Test
    fun classifyPicksTheBroadestParentThatStillCarriesACookie() {
        val deep = CookieJar.Target.of("https://a.mail.google.com/")!!
        val jar = mapOf(
            "https://a.mail.google.com/" to "wide=1; mid=2; narrow=3",
            "http://a.mail.google.com/" to "wide=1; mid=2; narrow=3",
            "https://mail.google.com/" to "wide=1; mid=2",
            "https://google.com/" to "wide=1"
        )
        val domains = CookieJar.classify(deep) { CookieJar.parse(jar[it]) }.associate { it.name to it.domain }
        assertEquals(".google.com", domains["wide"])
        assertEquals(".mail.google.com", domains["mid"])
        assertEquals("a.mail.google.com", domains["narrow"])
    }

    @Test
    fun classifyOnAnHttpPageCannotTellSecure() {
        val plain = CookieJar.Target.of("http://example.com/")!!
        val classified = CookieJar.classify(plain) { url -> if (url == "http://example.com/") CookieJar.parse("a=1") else emptyList() }
        assertEquals(1, classified.size)
        assertNull(classified[0].secure)
        assertEquals("example.com", classified[0].domain)
        assertTrue(CookieJar.classify(plain) { emptyList() }.isEmpty())
    }

    @Test
    fun expiryHeadersCoverEveryDomainAndPathVariant() {
        val headers = CookieJar.expiryHeaders(listOf("NID", "NID"), page)
        // 2 hosts × 2 paths (`/`, `/search`) × host-only + domain variants; duplicates collapse.
        assertEquals(8, headers.size)
        val urls = headers.map { it.first }.toSet()
        assertEquals(setOf("https://www.google.com/", "https://google.com/"), urls)
        for ((_, header) in headers) {
            assertTrue(header, header.startsWith("NID=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path="))
            assertTrue(header, header.contains("; Secure"))
        }
        assertTrue(headers.any { it.second.endsWith("Path=/search; Secure; Domain=google.com") })
        assertTrue(headers.any { it.first == "https://google.com/" && it.second.endsWith("Path=/; Secure") })
    }

    @Test
    fun hostPrefixedCookiesGetTheOneVariantTheyCanHave() {
        val headers = CookieJar.expiryHeaders(listOf("__Host-session"), page)
        assertEquals(listOf("https://www.google.com/" to "__Host-session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; Secure"), headers)
        assertTrue(CookieJar.expiryHeaders(emptyList(), page).isEmpty())
    }

    @Test
    fun pathsAreTheRootAndTheDirectoriesOfThePage() {
        assertEquals(listOf("/"), CookieJar.pathsOf("/"))
        assertEquals(listOf("/"), CookieJar.pathsOf(""))
        assertEquals(listOf("/", "/search"), CookieJar.pathsOf("/search?q=1"))
        assertEquals(listOf("/", "/a", "/a/b", "/a/b/c"), CookieJar.pathsOf("/a/b/c/"))
        // Bounded: deep paths stop after a few prefixes.
        assertEquals(listOf("/", "/a", "/a/b", "/a/b/c"), CookieJar.pathsOf("/a/b/c/d/e/f"))
    }

    @Test
    fun originsBelongToTheirSite() {
        assertTrue(CookieJar.originBelongsTo("https://www.google.com", "google.com"))
        assertTrue(CookieJar.originBelongsTo("https://accounts.google.com", "Google.com"))
        assertTrue(CookieJar.originBelongsTo("http://google.com", "google.com"))
        assertFalse(CookieJar.originBelongsTo("https://notgoogle.com", "google.com"))
        assertFalse(CookieJar.originBelongsTo("https://google.com.evil.example", "google.com"))
        assertFalse(CookieJar.originBelongsTo("https://www.google.com", ""))
        assertFalse(CookieJar.originBelongsTo("garbage", "google.com"))
    }
}
