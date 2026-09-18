package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkFilterTest {
    private fun filter(line: String): NetworkFilter = NetworkFilter.parse(line) ?: error("filter did not parse: $line")

    private fun req(
        url: String,
        type: ResourceType = ResourceType.SCRIPT,
        document: String? = "https://news.example/story",
        method: String = "GET",
        typeMask: Int = type.bit
    ) = Request(url, type, document, method, typeMask = typeMask)

    @Test
    fun commentsHeadersAndCosmeticFiltersAreSkipped() {
        assertNull(NetworkFilter.parse("! a comment"))
        assertNull(NetworkFilter.parse("[Adblock Plus 2.0]"))
        assertNull(NetworkFilter.parse(""))
        assertNull(NetworkFilter.parse("example.com##.ad-banner"))
        assertNull(NetworkFilter.parse("example.com#@#.ad-banner"))
        assertNull(NetworkFilter.parse("example.com#?#div:has(> .sponsored)"))
        assertNull(NetworkFilter.parse("example.com##+js(nowoif)"))
        assertNull(NetworkFilter.parse("example.com#\$#.ad { display: none !important; }"))
        assertTrue(NetworkFilter.isCosmetic("a.com,b.com##.x"))
        // A `#` inside a URL pattern is not a cosmetic marker.
        assertFalse(NetworkFilter.isCosmetic("||example.com/page#ad"))
        assertNotNull(NetworkFilter.parse("||example.com/page#ad"))
    }

    @Test
    fun typeOptionsAndTheDefaultTypeSet() {
        val untyped = filter("||ads.example^")
        assertTrue(untyped.matches(req("https://ads.example/a.js", ResourceType.SCRIPT)))
        assertTrue(untyped.matches(req("https://ads.example/a.png", ResourceType.IMAGE)))
        assertFalse("documents are not blocked by an untyped filter", untyped.matches(req("https://ads.example/", ResourceType.MAIN_FRAME, null)))
        val script = filter("||ads.example^\$script")
        assertTrue(script.matches(req("https://ads.example/a.js", ResourceType.SCRIPT)))
        assertFalse(script.matches(req("https://ads.example/a.png", ResourceType.IMAGE)))
        val notImage = filter("||ads.example^\$~image")
        assertTrue(notImage.matches(req("https://ads.example/a.js", ResourceType.SCRIPT)))
        assertFalse(notImage.matches(req("https://ads.example/a.png", ResourceType.IMAGE)))
        val all = filter("||ads.example^\$all")
        assertTrue(all.matches(req("https://ads.example/", ResourceType.MAIN_FRAME, null)))
        val aliases = filter("||ads.example^\$xhr,frame,css")
        assertTrue(aliases.matches(req("https://ads.example/x", ResourceType.XMLHTTPREQUEST)))
        assertTrue(aliases.matches(req("https://ads.example/x", ResourceType.SUB_FRAME)))
        assertTrue(aliases.matches(req("https://ads.example/x", ResourceType.STYLESHEET)))
        assertFalse(aliases.matches(req("https://ads.example/x", ResourceType.SCRIPT)))
    }

    @Test
    fun anAmbiguousRequestMatchesAnyOfItsCandidateTypes() {
        val script = filter("||ads.example^\$script")
        val unknown = req("https://ads.example/gtag", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)
        assertTrue(script.matches(unknown))
        assertFalse(filter("||ads.example^\$image").matches(unknown))
        assertFalse(filter("||ads.example^\$subdocument").matches(unknown))
    }

    /**
     * EasyPrivacy's `*$ping,third-party`: with no pattern, host or site the type is its only
     * condition, and on any shared bit it would match every third-party request of unknown type
     * – every cross-origin `fetch` on the web. Such a filter is tested against `xmlhttprequest`,
     * the type an unknown request most likely is; scoped by a host or a site, the list's judgement
     * stands and any candidate type matches.
     */
    @Test
    fun anUnscopedTypeOnlyFilterTakesAnUnknownRequestForAFetch() {
        val beacons = filter("*\$ping,third-party")
        val unknownFetch = req("https://api.example/votes?v=1", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)
        assertFalse(beacons.matches(unknownFetch))
        assertTrue(beacons.matches(req("https://api.example/collect", ResourceType.PING)))
        assertTrue(filter("*\$xhr,third-party").matches(unknownFetch))
        assertTrue(filter("*\$ping,xhr,3p").matches(unknownFetch))
        // Scoped to a request host, a site or a URL: an unknown request may be the type named.
        assertTrue(filter("||api.example^\$ping").matches(unknownFetch))
        assertTrue(filter("*\$ping,3p,domain=news.example").matches(unknownFetch))
        assertTrue(filter("*\$ping,3p,to=api.example").matches(unknownFetch))
        assertTrue(filter("/votes?\$ping").matches(unknownFetch))
        // Excluding sites or hosts does not scope the filter: it still names every page.
        assertFalse(filter("*\$ping,3p,domain=~other.example").matches(unknownFetch))
        assertFalse(filter("*\$ping,3p,denyallow=cdn.example").matches(unknownFetch))
        // A first-party unknown request is a fetch as well.
        assertFalse(filter("*\$ping").matches(req("https://news.example/api", ResourceType.XMLHTTPREQUEST, typeMask = ResourceType.AMBIGUOUS_MASK)))
        assertTrue(filter("*\$ping").matches(req("https://news.example/api", ResourceType.PING)))
    }

    @Test
    fun partyOptions() {
        val third = filter("||cdn.example^\$third-party")
        assertTrue(third.matches(req("https://cdn.example/a.js", document = "https://news.example/")))
        assertFalse(third.matches(req("https://cdn.example/a.js", document = "https://www.cdn.example/")))
        val first = filter("||cdn.example^\$~third-party")
        assertFalse(first.matches(req("https://cdn.example/a.js", document = "https://news.example/")))
        assertTrue(first.matches(req("https://cdn.example/a.js", document = "https://www.cdn.example/")))
        assertTrue(filter("||cdn.example^\$3p").matches(req("https://cdn.example/a.js", document = "https://news.example/")))
        assertTrue(filter("||cdn.example^\$1p").matches(req("https://cdn.example/a.js", document = "https://cdn.example/")))
    }

    @Test
    fun domainOptionsUseTheDocument() {
        val onNews = filter("/tracker.js\$domain=news.example|~sports.news.example")
        assertTrue(onNews.matches(req("https://cdn.x/tracker.js", document = "https://www.news.example/a")))
        assertFalse(onNews.matches(req("https://cdn.x/tracker.js", document = "https://sports.news.example/a")))
        assertFalse(onNews.matches(req("https://cdn.x/tracker.js", document = "https://other.example/a")))
        assertFalse("no document, no positive domain match", onNews.matches(req("https://cdn.x/tracker.js", document = null)))
        val notOnShop = filter("/tracker.js\$domain=~shop.example")
        assertTrue(notOnShop.matches(req("https://cdn.x/tracker.js", document = "https://news.example/")))
        assertFalse(notOnShop.matches(req("https://cdn.x/tracker.js", document = "https://shop.example/")))
        assertTrue(notOnShop.matches(req("https://cdn.x/tracker.js", document = null)))
        val to = filter("*\$script,to=ads.example|~safe.ads.example,from=news.example")
        assertTrue(to.matches(req("https://ads.example/a.js")))
        assertFalse(to.matches(req("https://safe.ads.example/a.js")))
        assertFalse(to.matches(req("https://ads.example/a.js", document = "https://shop.example/")))
        val denyallow = filter("*\$script,denyallow=cdn.example,domain=news.example")
        assertTrue(denyallow.matches(req("https://ads.example/a.js")))
        assertFalse(denyallow.matches(req("https://cdn.example/a.js")))
    }

    @Test
    fun methodMatchCaseImportantRedirectAndExceptions() {
        val post = filter("||api.example^\$method=post|~put,xhr")
        assertTrue(post.matches(req("https://api.example/x", ResourceType.XMLHTTPREQUEST, method = "POST")))
        assertFalse(post.matches(req("https://api.example/x", ResourceType.XMLHTTPREQUEST, method = "GET")))
        val caseful = filter("/AdServer/\$match-case")
        assertTrue(caseful.pattern.caseSensitive)
        assertTrue(caseful.matches(req("https://x.example/AdServer/a.js")))
        assertFalse(caseful.matches(req("https://x.example/adserver/a.js")))
        val important = filter("||ads.example^\$important")
        assertTrue(important.isImportant)
        assertFalse(important.isException)
        val redirect = filter("||ads.example/lib.js\$script,redirect=noopjs")
        assertTrue(redirect.isRedirect)
        assertTrue(filter("||ads.example/x.mp4\$media,mp4").isRedirect)
        val exception = filter("@@||ads.example/allowed.js\$script")
        assertTrue(exception.isException)
        assertFalse(exception.whitelistsDocument)
        assertEquals("@@||ads.example/allowed.js", exception.toString())
    }

    @Test
    fun documentExceptionsMatchTheDocumentRequest() {
        val trusted = filter("@@||trusted.example^\$document")
        assertTrue(trusted.whitelistsDocument)
        assertTrue(trusted.matches(req("https://trusted.example/", ResourceType.MAIN_FRAME, null)))
        assertTrue(trusted.matches(req("https://www.trusted.example/x", ResourceType.MAIN_FRAME, null)))
        // The page's own requests are the text engine's business (it matches the document request).
        assertFalse(trusted.matches(req("https://ads.example/a.js", ResourceType.SCRIPT, "https://www.trusted.example/x")))
        assertFalse(trusted.matches(req("https://other.example/", ResourceType.MAIN_FRAME, null)))
        assertFalse(filter("@@||trusted.example^\$script").whitelistsDocument)
        assertTrue(filter("@@||trusted.example^\$all").whitelistsDocument)
        assertFalse(filter("||trusted.example^\$document").whitelistsDocument)
    }

    @Test
    fun unsupportedOptionsAreRejected() {
        assertNull(NetworkFilter.parse("||example.com^\$csp=script-src 'none'"))
        assertNull(NetworkFilter.parse("||example.com^\$removeparam=utm_source"))
        assertNull(NetworkFilter.parse("||example.com^\$popup"))
        assertNull(NetworkFilter.parse("||example.com^\$inline-script"))
        assertNull(NetworkFilter.parse("@@||example.com^\$elemhide"))
        assertNull(NetworkFilter.parse("@@||example.com^\$generichide"))
        assertNull(NetworkFilter.parse("||example.com^\$unknownoption"))
        assertNull(NetworkFilter.parse("||example.com^\$badfilter"))
        // A filter for interceptable types plus a popup keeps the interceptable part.
        assertNotNull(NetworkFilter.parse("||example.com^\$popup,script"))
    }

    @Test
    fun optionsIndexIgnoresDollarSignsInsideRegularExpressions() {
        assertEquals(-1, NetworkFilter.optionsIndex("/\\.example\\.com\\/[a-z]+\\.js$/"))
        assertEquals(29, NetworkFilter.optionsIndex("/\\.example\\.com\\/[a-z]+\\.js$/\$script"))
        assertEquals(13, NetworkFilter.optionsIndex("||example.com\$third-party,script"))
        // As in uBlock Origin, a `$` followed by option-looking text is an option: an unknown one rejects the line.
        assertNull(NetworkFilter.parse("||example.com/path?x=\$y"))
        val re = filter("/\\/ad[0-9]+\\.js$/\$script,domain=news.example")
        assertTrue(re.matches(req("https://cdn.x/ad42.js")))
        assertFalse(re.matches(req("https://cdn.x/ad42.js?x")))
    }

    @Test
    fun badfilterTargetIsTheLineWithoutTheOption() {
        assertEquals("||example.com^\$script", NetworkFilter.badfilterTarget("||example.com^\$script,badfilter"))
        assertEquals("||example.com^", NetworkFilter.badfilterTarget("||example.com^\$badfilter"))
        assertNull(NetworkFilter.badfilterTarget("||example.com^\$script"))
    }
}
