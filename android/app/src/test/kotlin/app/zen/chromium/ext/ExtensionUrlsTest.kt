package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The two spellings of an extension page's URL; the Kotlin twin of `extensionUrls.test.ts`. */
class ExtensionUrlsTest {
    private val id = "dhdgffkkebhmkfjojejmpbldmpobfkfo"
    private val served = "https://$id.ext.zenium.invalid"

    @Test
    fun mapsChromeExtensionToTheServedOriginAndBack() {
        assertEquals("$served/options.html?tab=1#x", ExtensionUrls.toServed("chrome-extension://$id/options.html?tab=1#x"))
        assertEquals("chrome-extension://$id/options.html?tab=1#x", ExtensionUrls.present("$served/options.html?tab=1#x"))
        assertEquals("$served/", ExtensionUrls.toServed("chrome-extension://$id"))
        assertEquals("$served/?q", ExtensionUrls.toServed("chrome-extension://$id?q"))
        assertEquals("chrome-extension://$id/", ExtensionUrls.present(served))
        assertEquals("chrome-extension://$id/#h", ExtensionUrls.present("$served#h"))
        assertEquals("$served/a/b.js", ExtensionUrls.toServed(ExtensionUrls.present("$served/a/b.js")))
        assertEquals("chrome-extension://$id/p", ExtensionUrls.present("HTTPS://${id.uppercase()}.EXT.ZENIUM.INVALID/p"))
        assertTrue(ExtensionUrls.isExtensionUrl("chrome-extension://$id"))
        assertTrue(ExtensionUrls.isExtensionUrl("$served/x"))
    }

    @Test
    fun leavesEveryOtherUrlAlone() {
        for (other in listOf(
            "https://page.example/x",
            "https://$id.ext.zenium.invalid.evil.example/",
            "https://evil.example/$served/",
            "chrome-extension://not-an-id/x",
            "chrome-extension://${id.dropLast(1)}/x",
            "chrome-extension://${id}q/x",
            "http://$id.ext.zenium.invalid/x",
            "about:blank",
            ""
        )) {
            assertEquals(other, ExtensionUrls.toServed(other))
            assertEquals(other, ExtensionUrls.present(other))
            assertFalse(other, ExtensionUrls.isExtensionUrl(other))
        }
    }

    @Test
    fun readsThePageOriginAliasPathAndNoOther() {
        // `/.zenium-ext/<id>/<path>` under a page's own origin, the path without its leading
        // slash as `Served.webAccessible` matches it; the id in lower case (`pageAliasUrl`'s twin).
        assertEquals(id to "assets/widget.js", ExtensionUrls.pageAlias("/.zenium-ext/$id/assets/widget.js"))
        assertEquals(id to "a/b/c.css", ExtensionUrls.pageAlias("/.ZENIUM-EXT/${id.uppercase()}/a/b/c.css"))
        assertEquals(id to "", ExtensionUrls.pageAlias("/.zenium-ext/$id/"))
        assertEquals(id to "", ExtensionUrls.pageAlias("/.zenium-ext/$id"))
        assertEquals(".zenium-ext", ExtensionUrls.PAGE_ALIAS_SEGMENT)
        for (other in listOf(
            "/",
            "/assets/widget.js",
            "/zenium-ext/$id/a.js",
            "/.zenium-ext/not-an-id/a.js",
            "/.zenium-ext/${id.dropLast(1)}/a.js",
            "/.zenium-ext/${id}q/a.js",
            "/x/.zenium-ext/$id/a.js",
            ""
        )) {
            assertEquals(other, null, ExtensionUrls.pageAlias(other))
        }
    }
}
