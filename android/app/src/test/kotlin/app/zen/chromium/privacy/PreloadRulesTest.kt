package app.zen.chromium.privacy

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The prefetch mark as the request engine reads it under Preload pages `none` (PS-43): the same
 * table as `isPreloadRequest` in `src/core/protection/policy.ts` answers on the desktop.
 */
class PreloadRulesTest {
    @Test
    fun `the prefetch token of Sec-Purpose marks a speculative load`() {
        assertTrue(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prefetch")))
        // The fetch a prerender starts with: both tokens, the first is enough.
        assertTrue(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prefetch;prerender")))
        assertTrue(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prefetch; prerender")))
    }

    @Test
    fun `the legacy Purpose header is read too`() {
        assertTrue(PreloadRules.isPreloadRequest(mapOf("Purpose" to "prefetch")))
    }

    @Test
    fun `header names and the token match in any case`() {
        assertTrue(PreloadRules.isPreloadRequest(mapOf("sec-purpose" to "prefetch", "Accept" to "*/*")))
        assertTrue(PreloadRules.isPreloadRequest(mapOf("purpose" to "Prefetch")))
        assertTrue(PreloadRules.isPreloadRequest(mapOf("SEC-PURPOSE" to "PREFETCH")))
    }

    @Test
    fun `no header marks nothing`() {
        assertFalse(PreloadRules.isPreloadRequest(null))
        assertFalse(PreloadRules.isPreloadRequest(emptyMap()))
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Accept" to "text/html", "User-Agent" to "Mozilla/5.0")))
    }

    @Test
    fun `the token under another header name is not the mark`() {
        // The desktop table's negative: the right value under the wrong name marks nothing.
        assertFalse(PreloadRules.isPreloadRequest(mapOf("X-Purpose" to "prefetch", "Accept" to "prefetch")))
    }

    @Test
    fun `another purpose is not a prefetch`() {
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "other")))
        // A prerender's token alone is not the prefetch mark (Chromium always pairs them).
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prerender")))
    }

    @Test
    fun `a prefetch substring inside another token does not match`() {
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prefetching")))
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "unprefetch;prerender")))
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Purpose" to "no-prefetch")))
        // Whole tokens only: the split is on `;`, not on whitespace or commas.
        assertFalse(PreloadRules.isPreloadRequest(mapOf("Sec-Purpose" to "prefetch prerender")))
    }

    @Test
    fun `a request is refused under none alone, on web addresses alone, with the mark alone`() {
        val none = PrivacyFlags.parse(JSONObject("""{"preloadPages":"none"}"""))
        val standard = PrivacyFlags.parse(JSONObject("""{"preloadPages":"standard"}"""))
        val extended = PrivacyFlags.parse(JSONObject("""{"preloadPages":"extended"}"""))
        val mark = mapOf("Sec-Purpose" to "prefetch")

        assertTrue(PreloadRules.refuses(none, "https://news.example/next", mark))
        assertTrue(PreloadRules.refuses(none, "http://127.0.0.1:18123/prefetched.txt", mark))
        assertTrue(PreloadRules.refuses(none, "https://news.example/next", mapOf("Sec-Purpose" to "prefetch;prerender")))

        // Under the other two levels nothing is refused, mark or no mark.
        assertFalse(PreloadRules.refuses(standard, "https://news.example/next", mark))
        assertFalse(PreloadRules.refuses(extended, "https://news.example/next", mark))
        assertFalse(PreloadRules.refuses(PrivacyFlags.DEFAULT, "https://news.example/next", mark))

        // A page's own requests go, and so does anything off the web.
        assertFalse(PreloadRules.refuses(none, "https://news.example/next", emptyMap()))
        assertFalse(PreloadRules.refuses(none, "https://news.example/next", null))
        assertFalse(PreloadRules.refuses(none, "data:text/plain,x", mark))
        assertFalse(PreloadRules.refuses(none, "chrome-extension://abc/page.html", mark))
        assertFalse(PreloadRules.refuses(none, "zen://newtab", mark))
    }
}
