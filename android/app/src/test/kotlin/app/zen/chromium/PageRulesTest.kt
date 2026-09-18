package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
