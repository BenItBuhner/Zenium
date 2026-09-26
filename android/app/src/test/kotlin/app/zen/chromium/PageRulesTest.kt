package app.zen.chromium

import app.zen.chromium.blocking.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageRulesTest {
    private val rules = PageRules(
        desktopDefault = false,
        desktopSites = mapOf("wikipedia.org" to true, "example.co.uk" to true, "m.example.co.uk" to false),
        darkenDefault = true,
        darkenSites = mapOf("github.com" to false),
        zoomDefault = 1.0,
        zoomSites = mapOf("news.ycombinator.com" to 1.5, "ycombinator.com" to 1.25),
        zoomScale = 1.3,
        forceZoom = true
    )

    @Test
    fun hostOfKeepsOnlyTheHost() {
        assertEquals("en.wikipedia.org", PageRules.hostOf("https://en.wikipedia.org/wiki/Zen"))
        assertEquals("example.com", PageRules.hostOf("HTTP://user:pw@Example.COM:8080/x?y#z"))
        assertEquals("example.com", PageRules.hostOf("https://example.com."))
        assertEquals("::1", PageRules.hostOf("http://[::1]:3000/"))
        assertNull(PageRules.hostOf("zen://settings"))
        assertNull(PageRules.hostOf("about:blank"))
        assertNull(PageRules.hostOf("https:///nohost"))
    }

    @Test
    fun siteOfIsTheOriginWithTheDefaultPortLeftOut() {
        assertEquals("https://en.wikipedia.org", PageRules.siteOf("https://en.wikipedia.org/wiki/Zen"))
        assertEquals("https://example.com", PageRules.siteOf("HTTPS://user:pw@Example.COM:443/x?y#z"))
        assertEquals("https://example.com:8443", PageRules.siteOf("https://example.com:8443/"))
        assertEquals("http://example.com", PageRules.siteOf("http://example.com:80/"))
        assertEquals("http://example.com:8080", PageRules.siteOf("http://example.com:8080"))
        assertEquals("http://[::1]:3000", PageRules.siteOf("http://[::1]:3000/"))
        assertEquals("http://[::1]", PageRules.siteOf("http://[::1]/"))
        // The scheme and the port are the origin's: the same host is another site under either.
        assertNotEquals(PageRules.siteOf("http://example.com/"), PageRules.siteOf("https://example.com/"))
        assertNotEquals(PageRules.siteOf("https://example.com/"), PageRules.siteOf("https://example.com:444/"))
        assertNull(PageRules.siteOf("zen://settings"))
        assertNull(PageRules.siteOf("about:blank"))
        assertNull(PageRules.siteOf("data:text/html,hi"))
        assertNull(PageRules.siteOf("https:///nohost"))
        assertNull(PageRules.siteOf("https://example.com:port/"))
    }

    @Test
    fun isPrerenderReadsThePrerenderTokenOfSecPurpose() {
        // What Chromium marks a speculation-rules prerender's navigation with.
        assertTrue(PageRules.isPrerender(mapOf("Sec-Purpose" to "prefetch;prerender")))
        assertTrue(PageRules.isPrerender(mapOf("sec-purpose" to "prefetch; prerender", "Accept" to "text/html")))
        assertTrue(PageRules.isPrerender(mapOf("SEC-PURPOSE" to "Prerender")))
        // A prefetch alone is not a prerender (and never a navigation).
        assertFalse(PageRules.isPrerender(mapOf("Sec-Purpose" to "prefetch")))
        // The token, not a substring.
        assertFalse(PageRules.isPrerender(mapOf("Sec-Purpose" to "prerendering")))
        assertFalse(PageRules.isPrerender(mapOf("Purpose" to "prerender")))
        assertFalse(PageRules.isPrerender(emptyMap()))
        assertFalse(PageRules.isPrerender(null))
    }

    @Test
    fun aNavigationWithoutTheMarkIsNotAPrerender() {
        // A tap's request as WebView hands it to the hook: untouched by the prerender branch.
        val tap = mapOf("Accept" to "text/html", "User-Agent" to "Mozilla/5.0", "Sec-Fetch-Dest" to "document", "Sec-Fetch-Mode" to "navigate")
        assertFalse(PageRules.isPrerender(tap))
    }

    @Test
    fun prerenderVetoRefusesEachReasonAlone() {
        val site = "https://example.com"
        // Safe Browsing names the address.
        assertTrue(PageRules.prerenderVeto(guardHit = true, Decision.Action.ALLOW, site, site, desktopDiffers = false))
        // The rule sets decide anything but allow.
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.BLOCK, site, site, false))
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.REDIRECT, site, site, false))
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.UPGRADE, site, site, false))
        // Another site than the document's: host, scheme or port.
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, "https://other.example", site, false))
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, "http://example.com", site, false))
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, "https://example.com:8443", site, false))
        // No site to run under: no document yet, or a target with no web origin.
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, site, null, false))
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, null, site, false))
        // The other desktop-site setting.
        assertTrue(PageRules.prerenderVeto(false, Decision.Action.ALLOW, site, site, desktopDiffers = true))
    }

    @Test
    fun prerenderVetoLetsTheCleanSameSiteCaseGo() {
        val site = "https://example.com"
        assertFalse(PageRules.prerenderVeto(false, Decision.Action.ALLOW, site, site, false))
        // A modifyHeaders document goes too: its edits are the relay's, met in shouldInterceptRequest.
        assertFalse(PageRules.prerenderVeto(false, Decision.Action.MODIFY_HEADERS, site, site, false))
    }

    @Test
    fun sitesMatchBySuffixWithTheLongestDomainWinning() {
        assertTrue(rules.desktop("https://en.wikipedia.org/wiki/Zen"))
        assertTrue(rules.desktop("https://wikipedia.org/"))
        assertTrue(rules.desktop("https://www.example.co.uk/"))
        // The more specific exception beats the site-wide one.
        assertFalse(rules.desktop("https://m.example.co.uk/"))
        // A suffix that is not a label boundary is not the same site.
        assertFalse(rules.desktop("https://notwikipedia.org/"))
        assertFalse(rules.desktop("https://example.com/"))
    }

    @Test
    fun internalPagesGetNoControls() {
        val always = rules.copyWith(desktopDefault = true)
        assertFalse(always.desktop("zen://settings"))
        assertFalse(always.darken("about:blank"))
        assertEquals(1.0, always.zoom("zen://newtab"), 0.0)
        assertEquals(PageRules.Controls(false, false, 1.0, true), always.controls("zen://settings"))
    }

    @Test
    fun darkeningIsTheDefaultMinusItsExceptions() {
        assertTrue(rules.darken("https://example.com/"))
        assertFalse(rules.darken("https://github.com/BenItBuhner/Zenium"))
        assertFalse(rules.darken("https://gist.github.com/"))
    }

    @Test
    fun zoomMultipliesTheSystemFontScaleIntoTheSiteFactor() {
        assertEquals(1.3, rules.zoom("https://example.com/"), 0.0)
        assertEquals(1.95, rules.zoom("https://news.ycombinator.com/"), 0.0)
        assertEquals(1.625, rules.zoom("https://ycombinator.com/"), 0.0)
        // Zoom is per host, as Chrome keeps it: a subdomain does not inherit the apex's factor.
        assertEquals(1.3, rules.zoom("https://www.ycombinator.com/"), 0.0)
        assertEquals(1.0, PageRules.NONE.zoom("https://example.com/"), 0.0)
    }

    @Test
    fun controlsCarryEveryDecisionForAPage() {
        assertEquals(
            PageRules.Controls(desktop = true, darken = true, zoom = 1.3, forceZoom = true),
            rules.controls("https://de.wikipedia.org/")
        )
    }

    private fun PageRules.copyWith(desktopDefault: Boolean) = PageRules(
        desktopDefault, desktopSites, darkenDefault, darkenSites, zoomDefault, zoomSites, zoomScale, forceZoom
    )
}
