package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class FilterIndexTest {
    private fun filter(line: String): NetworkFilter = NetworkFilter.parse(line) ?: error("did not parse: $line")

    private fun req(
        url: String,
        type: ResourceType = ResourceType.SCRIPT,
        doc: String? = "https://news.example/story",
        typeMask: Int = type.bit
    ): Request = Request(url, type, doc, typeMask = typeMask)

    @Test
    fun hostnameOnlyFiltersAreFoundByWalkingTheHostSuffixes() {
        val ads = filter("||ads.example.com^")
        val tracker = filter("||tracker.net^")
        val index = FilterIndex(listOf(ads, tracker))
        assertEquals(2, index.size)
        assertEquals(0, index.wildcardCount)
        assertSame(ads, index.match(req("https://cdn.ads.example.com/x.js")))
        assertSame(ads, index.match(req("https://ads.example.com/")))
        assertSame(tracker, index.match(req("https://a.b.tracker.net/p?x=1")))
        assertNull(index.match(req("https://example.com/ads.example.com")))
        assertNull(index.match(req("https://nottracker.net/")))
    }

    @Test
    fun hostnameOnlyFiltersForTheSameHostAreAllKept() {
        val image = filter("||cdn.example^\$image")
        val script = filter("||cdn.example^\$script")
        val index = FilterIndex(listOf(image, script))
        assertSame(script, index.match(req("https://cdn.example/a", ResourceType.SCRIPT)))
        assertSame(image, index.match(req("https://cdn.example/a", ResourceType.IMAGE)))
        assertNull(index.match(req("https://cdn.example/a", ResourceType.FONT)))
    }

    @Test
    fun otherFiltersLiveInTheBucketOfTheirRarestToken() {
        val banner = filter("/banner/*.gif")
        val pixel = filter("||stats.example/pixel?")
        val index = FilterIndex(listOf(banner, pixel))
        assertSame(banner, index.match(req("https://site.example/banner/top.gif", ResourceType.IMAGE)))
        assertNull(index.match(req("https://site.example/banners/top.gif", ResourceType.IMAGE)))
        assertSame(pixel, index.match(req("https://stats.example/pixel?u=1", ResourceType.IMAGE)))
        assertNull(index.match(req("https://stats.example/pixels?u=1", ResourceType.IMAGE)))
    }

    @Test
    fun filtersWithoutTokensAreTestedForEveryRequest() {
        val re = filter("/ad[0-9]+\\.js/")
        val star = filter("*")
        val index = FilterIndex(listOf(re, star))
        assertEquals(2, index.wildcardCount)
        assertSame(re, index.match(req("https://cdn.example/ad42.js")))
        assertSame(star, index.match(req("https://cdn.example/app.js")))
    }

    @Test
    fun documentExceptionsSwitchFilteringOffForThePage() {
        val e = engine("||tracker.net^\n||pixel.example^\$important\n@@||news.example^\$document\n@@||shop.example/checkout\$document")
        val onNews = e.match(req("https://tracker.net/t.js", doc = "https://www.news.example/story"))
        assertEquals(TextMatch.Action.ALLOW, onNews?.action)
        assertEquals("@@||news.example^", onNews?.filter.toString())
        // Even `$important` blocks stand down on a whitelisted page.
        assertEquals(TextMatch.Action.ALLOW, e.match(req("https://pixel.example/p", doc = "https://news.example/"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://tracker.net/t.js", doc = "https://other.example/"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://pixel.example/p", doc = "https://other.example/"))?.action)
        // A path-scoped document exception applies only under that path.
        assertEquals(TextMatch.Action.ALLOW, e.match(req("https://tracker.net/t.js", doc = "https://shop.example/checkout/step-2"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://tracker.net/t.js", doc = "https://shop.example/basket"))?.action)
        // The whitelisted page's own navigation is never blocked by a `$document` block either.
        val strict = engine("||news.example^\$document\n@@||news.example^\$document")
        assertEquals(TextMatch.Action.ALLOW, strict.match(req("https://news.example/", ResourceType.MAIN_FRAME, doc = null))?.action)
    }

    @Test
    fun untypedFiltersNeverBlockTheDocumentItself() {
        val e = engine("||malware.example^\n||phish.example^\$all\n||scam.example^\$document")
        assertNull(e.match(req("https://malware.example/landing", ResourceType.MAIN_FRAME, doc = null)))
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://malware.example/a.js", doc = "https://malware.example/"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://phish.example/", ResourceType.MAIN_FRAME, doc = null))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://scam.example/", ResourceType.MAIN_FRAME, doc = null))?.action)
        assertNull(e.match(req("https://scam.example/a.js", doc = "https://news.example/")))
    }

    @Test
    fun ambiguousRequestsMatchFiltersForAnyTypeTheyMightBe() {
        val script = filter("||cdn.example/lib\$script")
        val index = FilterIndex(listOf(script))
        val unknown = req("https://cdn.example/lib", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)
        assertSame(script, index.match(unknown))
        assertNull(index.match(req("https://cdn.example/lib", ResourceType.IMAGE)))
    }

    // --- TextEngine -----------------------------------------------------------------------------

    private fun engine(vararg lists: String): TextEngine = TextEngine.parse(lists.toList())

    @Test
    fun exceptionsBeatBlocksAndImportantBeatsExceptions() {
        val plain = engine("||ads.example.com^\n@@||ads.example.com^\$script")
        assertEquals(TextMatch.Action.ALLOW, plain.match(req("https://ads.example.com/a.js"))?.action)
        assertEquals(TextMatch.Action.BLOCK, plain.match(req("https://ads.example.com/a.gif", ResourceType.IMAGE))?.action)

        val forced = engine("||ads.example.com^\$important", "@@||ads.example.com^")
        val match = forced.match(req("https://ads.example.com/a.js"))
        assertEquals(TextMatch.Action.BLOCK, match?.action)
        assertEquals("||ads.example.com^", match?.filter.toString())

        assertNull(plain.match(req("https://cdn.example/app.js")))
        assertNull(engine().match(req("https://ads.example.com/a.js")))
    }

    @Test
    fun redirectFiltersReportRedirect() {
        val e = engine("||ads.example.com/lib.js\$script,redirect=noopjs")
        assertEquals(TextMatch.Action.REDIRECT, e.match(req("https://ads.example.com/lib.js"))?.action)
    }

    @Test
    fun badfilterLinesCancelTheirTargetAcrossLists() {
        val e = engine("||ads.example.com^\n||tracker.net^\$third-party", "||ads.example.com^\$badfilter")
        assertNull(e.match(req("https://ads.example.com/a.js")))
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://tracker.net/t.js"))?.action)
        assertEquals(1, e.filterCount)
        assertEquals(0, e.rejectedCount)
    }

    @Test
    fun countsSeparateNetworkFiltersFromEverythingElse() {
        val e = engine(
            "[Adblock Plus 2.0]\r\n! Title: Test\r\n||a.example^\r\n\r\n  ||b.example^  \r\n" +
                "example.com##.ad\n##.sponsored\nexample.com#@#.ad\n" +
                "||c.example^\$csp=script-src 'none'\n||d.example^\$removeparam=utm_source\n||e.example^\$unknownthing\n"
        )
        assertEquals(2, e.filterCount)
        assertEquals(3, e.rejectedCount)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://b.example/x"))?.action)
        assertEquals(0, TextEngine.EMPTY.filterCount)
        assertEquals(0, TextEngine.EMPTY.rejectedCount)
    }

    @Test
    fun easyListExcerptBlocksTheUsualSuspects() {
        val e = engine(
            """
            [Adblock Plus 2.0]
            ! Title: EasyList (excerpt)
            &ad_box_
            &adserver=
            -ad-banner.
            ||doubleclick.net^
            ||googlesyndication.com^${'$'}third-party
            ||google-analytics.com^${'$'}third-party
            /adsbygoogle.${'$'}script
            ||googletagmanager.com^${'$'}third-party
            @@||googletagmanager.com/gtag/js${'$'}script,domain=shop.example
            ||facebook.com/tr/${'$'}image,third-party
            ###ad-banner
            example.com##.sponsored
            """.trimIndent()
        )
        assertEquals(10, e.filterCount)
        assertEquals(0, e.rejectedCount)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://www.google-analytics.com/analytics.js"))?.action)
        assertNull(e.match(req("https://www.google-analytics.com/analytics.js", doc = "https://www.google-analytics.com/")))
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://www.facebook.com/tr/?id=1", ResourceType.IMAGE))?.action)
        assertNull(e.match(req("https://www.facebook.com/tr/?id=1", ResourceType.SCRIPT)))
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://cdn.example/a?x=1&adserver=2", ResourceType.XMLHTTPREQUEST))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://cdn.example/static/-ad-banner.png", ResourceType.IMAGE))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req("https://stats.g.doubleclick.net/r/collect", ResourceType.XMLHTTPREQUEST))?.action)
        assertNull(e.match(req("https://cdn.example/js/app.js")))
        // The exception only applies on the page it names.
        val tagManager = "https://www.googletagmanager.com/gtag/js?id=G-1"
        assertEquals(TextMatch.Action.ALLOW, e.match(req(tagManager, doc = "https://shop.example/"))?.action)
        assertEquals(TextMatch.Action.BLOCK, e.match(req(tagManager, doc = "https://news.example/"))?.action)
        assertNotNull(e.match(req(tagManager, ResourceType.IMAGE, doc = "https://shop.example/")))
        assertEquals(TextMatch.Action.BLOCK, e.match(req(tagManager, ResourceType.IMAGE, doc = "https://shop.example/"))?.action)
    }
}
