package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLinksTest {
    private val page = "https://news.example.com/story"

    @Test
    fun aTapOnAnotherSiteIsProbed() {
        assertTrue(AppLinks.shouldProbe(page, "https://twitter.com/zenium", mainFrame = true, redirect = false, gesture = true))
        assertTrue(AppLinks.shouldProbe(page, "http://maps.google.com/?q=paris", mainFrame = true, redirect = false, gesture = true))
    }

    @Test
    fun theSameSiteIsNeverProbed() {
        assertFalse(AppLinks.shouldProbe(page, "https://news.example.com/other", mainFrame = true, redirect = false, gesture = true))
        assertFalse(AppLinks.shouldProbe(page, "https://example.com/", mainFrame = true, redirect = false, gesture = true))
        assertFalse(AppLinks.shouldProbe(page, "https://www.example.com/", mainFrame = true, redirect = false, gesture = true))
        assertFalse(AppLinks.shouldProbe("https://www.example.com/", "https://example.com/", mainFrame = true, redirect = false, gesture = true))
    }

    @Test
    fun redirectsScriptsAndSubframesStayInTheTab() {
        assertFalse(AppLinks.shouldProbe(page, "https://twitter.com/zenium", mainFrame = true, redirect = true, gesture = true))
        assertFalse(AppLinks.shouldProbe(page, "https://twitter.com/zenium", mainFrame = true, redirect = false, gesture = false))
        assertFalse(AppLinks.shouldProbe(page, "https://twitter.com/zenium", mainFrame = false, redirect = false, gesture = true))
    }

    @Test
    fun onlyWebAddressesAreAppLinks() {
        assertFalse(AppLinks.shouldProbe(page, "mailto:hi@example.com", mainFrame = true, redirect = false, gesture = true))
        assertFalse(AppLinks.shouldProbe(page, "intent://scan/#Intent;scheme=zxing;end", mainFrame = true, redirect = false, gesture = true))
        assertFalse(AppLinks.shouldProbe(page, "about:blank", mainFrame = true, redirect = false, gesture = true))
    }

    @Test
    fun aTapFromAPageThatIsNoSiteIsProbed() {
        assertTrue(AppLinks.shouldProbe(null, "https://twitter.com/zenium", mainFrame = true, redirect = false, gesture = true))
        assertTrue(AppLinks.shouldProbe("about:blank", "https://twitter.com/zenium", mainFrame = true, redirect = false, gesture = true))
        assertTrue(AppLinks.shouldProbe("zen://newtab", "https://twitter.com/zenium", mainFrame = true, redirect = false, gesture = true))
    }

    @Test
    fun sameSiteComparesRegistrableDomains() {
        assertTrue(AppLinks.sameSite("https://news.bbc.co.uk/x", "https://www.bbc.co.uk/"))
        assertTrue(AppLinks.sameSite("https://m.abc.net.au/", "https://abc.net.au/"))
        assertTrue(AppLinks.sameSite("HTTPS://EXAMPLE.COM/A", "https://example.com/b"))
        assertTrue(AppLinks.sameSite("https://example.com./", "https://example.com/"))
        assertFalse(AppLinks.sameSite("https://bbc.co.uk/", "https://itv.co.uk/"))
        assertFalse(AppLinks.sameSite("https://example.com/", "https://example.org/"))
        assertFalse(AppLinks.sameSite("https://10.0.0.1/", "https://10.0.0.2/"))
        assertTrue(AppLinks.sameSite("http://10.0.0.1/a", "https://10.0.0.1:8443/b"))
        assertTrue(AppLinks.sameSite("http://localhost:3000/", "http://localhost/"))
    }

    @Test
    fun nothingIsTheSameSiteAsNoSite() {
        assertFalse(AppLinks.sameSite(null, "https://example.com/"))
        assertFalse(AppLinks.sameSite("zen://newtab", "https://example.com/"))
        assertFalse(AppLinks.sameSite("about:blank", "about:blank"))
        assertFalse(AppLinks.sameSite("not a url", "https://example.com/"))
    }

    @Test
    fun registrableDomainKeepsTwoLabelsOrThreeUnderShortCountryCodeSuffixes() {
        assertEquals("example.com", AppLinks.registrableDomain("www.example.com"))
        assertEquals("example.com", AppLinks.registrableDomain("a.b.c.example.com"))
        assertEquals("bbc.co.uk", AppLinks.registrableDomain("news.bbc.co.uk"))
        assertEquals("example.de", AppLinks.registrableDomain("shop.example.de"))
        assertEquals("localhost", AppLinks.registrableDomain("localhost"))
        assertEquals("192.168.1.20", AppLinks.registrableDomain("192.168.1.20"))
    }

    @Test
    fun hostOfReadsWebAddressesOnly() {
        assertEquals("example.com", AppLinks.hostOf("https://Example.com:8080/path?q#f"))
        assertNull(AppLinks.hostOf("mailto:hi@example.com"))
        assertNull(AppLinks.hostOf("zen://settings"))
        assertNull(AppLinks.hostOf("https://"))
        assertNull(AppLinks.hostOf(null))
    }
}
