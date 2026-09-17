package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors `src/core/blocking/__tests__/domain.test.ts` case for case: both engines must agree. */
class DomainsTest {
    @Test
    fun hostnameOfExtractsLowercasedHostsWithoutPortsCredentialsOrTrailingDots() {
        assertEquals("www.example.com", Domains.hostnameOf("https://WWW.Example.com/path?q=1#h"))
        assertEquals("host.example", Domains.hostnameOf("http://user:pw@host.example:8080/"))
        assertEquals("host.example", Domains.hostnameOf("https://host.example."))
        assertEquals("[::1]", Domains.hostnameOf("https://[::1]:3000/x"))
        assertEquals("socket.example", Domains.hostnameOf("wss://socket.example"))
        assertNull(Domains.hostnameOf("about:blank"))
        assertNull(Domains.hostnameOf("data:text/plain,hi"))
        assertNull(Domains.hostnameOf("not a url"))
    }

    @Test
    fun registrableDomainReturnsEtldPlusOneForCommonAndMultiLabelSuffixes() {
        assertEquals("example.com", Domains.registrableDomain("www.example.com"))
        assertEquals("example.com", Domains.registrableDomain("example.com"))
        assertEquals("example.co.uk", Domains.registrableDomain("a.b.example.co.uk"))
        assertEquals("example.com.au", Domains.registrableDomain("shop.example.com.au"))
        assertEquals("bucket.s3.amazonaws.com", Domains.registrableDomain("bucket.s3.amazonaws.com"))
        assertEquals("app.github.io", Domains.registrableDomain("app.github.io"))
        assertEquals("example.co.xx", Domains.registrableDomain("x.y.example.co.xx"))
    }

    @Test
    fun registrableDomainLeavesIpLiteralsAndSingleLabelsAlone() {
        assertEquals("127.0.0.1", Domains.registrableDomain("127.0.0.1"))
        assertEquals("[::1]", Domains.registrableDomain("[::1]"))
        assertEquals("localhost", Domains.registrableDomain("localhost"))
        assertEquals("example.com", Domains.registrableDomain("Example.COM."))
    }

    @Test
    fun hostMatchesDomainAcceptsTheDomainAndItsSubdomainsOnly() {
        assertTrue(Domains.hostMatchesDomain("example.com", "example.com"))
        assertTrue(Domains.hostMatchesDomain("a.b.example.com", "example.com"))
        assertFalse(Domains.hostMatchesDomain("notexample.com", "example.com"))
        assertFalse(Domains.hostMatchesDomain("example.com", "www.example.com"))
        assertEquals("example.org", Domains.domainOf("https://a.b.example.org/x"))
        assertNull(Domains.domainOf("about:blank"))
    }

    @Test
    fun isThirdPartyComparesRegistrableDomainsAndTreatsMissingInitiatorsAsFirstParty() {
        assertFalse(Domains.isThirdParty("https://cdn.example.com/a.js", "https://www.example.com/"))
        assertTrue(Domains.isThirdParty("https://tracker.example/a.js", "https://www.example.com/"))
        assertFalse(Domains.isThirdParty("https://a.example.co.uk/", "https://b.example.co.uk/"))
        assertFalse(Domains.isThirdParty("https://a.example/", null))
        assertFalse(Domains.isThirdParty("https://a.example/", ""))
        assertTrue(Domains.isThirdParty("https://a.example/", "chrome-extension://abc/page.html"))
        assertTrue(Domains.isThirdParty("https://a.example/", "about:blank"))
    }
}
