package app.zen.chromium

import android.webkit.WebSettings
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentRulesTest {
    private val rules = ContentRules.fromJson(
        JSONObject(
            """
            {
              "images": { "default": "allow", "sites": { "https://blocked.example": "deny" } },
              "javascript": { "default": "deny", "sites": { "https://scripts.example": "allow", "http://plain.example:8080": "allow" } },
              "sensors": { "default": "allow", "sites": { "https://still.example": "deny", "": "deny", "https://odd.example": "maybe" } },
              "payment-handler": { "default": "deny", "sites": {} },
              "insecure-content": "nonsense"
            }
            """.trimIndent()
        )
    )

    @Test
    fun siteOfIsThePermissionOrigin() {
        assertEquals("https://example.com", ContentRules.siteOf("https://Example.com/a/b?c#d"))
        assertEquals("https://example.com", ContentRules.siteOf("https://example.com:443/"))
        assertEquals("http://example.com", ContentRules.siteOf("HTTP://user:pw@example.com:80/x"))
        assertEquals("http://example.com:8080", ContentRules.siteOf("http://example.com:8080/x"))
        assertEquals("https://[::1]:3000", ContentRules.siteOf("https://[::1]:3000/"))
        assertEquals("https://xn--bcher-kva.example", ContentRules.siteOf("https://bücher.example/"))
        assertEquals("file://", ContentRules.siteOf("file:///sdcard/page.html"))
        assertNull(ContentRules.siteOf("zen://settings"))
        assertNull(ContentRules.siteOf("about:blank"))
        assertNull(ContentRules.siteOf("data:text/html,hi"))
        assertNull(ContentRules.siteOf("https:///nohost"))
        assertNull(ContentRules.siteOf("https://example.com:port/"))
    }

    @Test
    fun allowsAnswersWithTheSiteElseTheDefault() {
        assertFalse(rules.allows(ContentRules.IMAGES, "https://blocked.example/page"))
        assertTrue(rules.allows(ContentRules.IMAGES, "https://other.example/"))
        // Origins, not domain suffixes: a subdomain and the plain scheme are other sites.
        assertTrue(rules.allows(ContentRules.IMAGES, "https://sub.blocked.example/"))
        assertTrue(rules.allows(ContentRules.IMAGES, "http://blocked.example/"))
        assertTrue(rules.allows(ContentRules.JAVASCRIPT, "https://scripts.example/app"))
        assertTrue(rules.allows(ContentRules.JAVASCRIPT, "http://plain.example:8080/"))
        assertFalse(rules.allows(ContentRules.JAVASCRIPT, "http://plain.example/"))
        assertFalse(rules.allows(ContentRules.JAVASCRIPT, "https://other.example/"))
    }

    @Test
    fun aPageWithoutASiteGetsTheDefaultAlone() {
        assertFalse(rules.allows(ContentRules.JAVASCRIPT, "about:blank"))
        assertTrue(rules.allows(ContentRules.IMAGES, "zen://newtab"))
    }

    @Test
    fun missingAndMalformedRowsFallBackToTheCatalogue() {
        // Insecure content is the one row blocked by default; a malformed row reads as absent.
        assertFalse(rules.allows(ContentRules.INSECURE_CONTENT, "https://any.example/"))
        assertTrue(rules.allows(ContentRules.THIRD_PARTY_SIGN_IN, "https://any.example/"))
        assertTrue(ContentRules.NONE.allows(ContentRules.JAVASCRIPT, "https://any.example/"))
        assertFalse(ContentRules.NONE.allows(ContentRules.INSECURE_CONTENT, "https://any.example/"))
        // An empty site key and a decision that is neither answer are dropped.
        assertTrue(rules.allows(ContentRules.SENSORS, "https://odd.example/"))
    }

    @Test
    fun mixedContentModeFollowsTheInsecureContentRowThenTheHttpsOnlySetting() {
        val allowed = ContentRules.fromJson(
            JSONObject("""{ "insecure-content": { "default": "deny", "sites": { "https://legacy.example": "allow" } } }""")
        )
        // The site's Allow: the document runs its plaintext parts, HTTPS-only "always" or not.
        assertEquals(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW, allowed.mixedContentMode("https://legacy.example/app", "off"))
        assertEquals(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW, allowed.mixedContentMode("https://legacy.example/app", "always"))
        // Every other document: the engine's block, or never under HTTPS-only "always".
        assertEquals(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE, allowed.mixedContentMode("https://other.example/", "off"))
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, allowed.mixedContentMode("https://other.example/", "always"))
        assertEquals(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE, ContentRules.NONE.mixedContentMode("https://legacy.example/", "off"))
        // A page without a site never reads the row; no document follows the setting alone.
        assertEquals(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE, allowed.mixedContentMode("about:blank", "off"))
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, allowed.mixedContentMode(null, "always"))
        // An extension's own page fetches plaintext freely, as before.
        assertEquals(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW, allowed.mixedContentMode("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html", "always"))
    }

    @Test
    fun blockedGuardsNamesTheRefusedRows() {
        assertEquals(listOf(ContentRules.SENSORS, ContentRules.PAYMENT_HANDLER), rules.blockedGuards("https://still.example/"))
        assertEquals(listOf(ContentRules.PAYMENT_HANDLER), rules.blockedGuards("https://other.example/"))
        assertEquals(emptyList<String>(), ContentRules.NONE.blockedGuards("https://other.example/"))
    }

    @Test
    fun theCoresAnswerForTheSiteComesBeforeTheDocument() {
        // The core resolved an extension's rule: images allowed where the document's line says
        // deny, sensors refused where its default says allow.
        val resolved = ContentRules.Resolved("https://blocked.example", mapOf(ContentRules.IMAGES to true, ContentRules.SENSORS to false))
        assertTrue(rules.allows(ContentRules.IMAGES, "https://blocked.example/page", resolved))
        assertFalse(rules.allows(ContentRules.SENSORS, "https://blocked.example/page", resolved))
        // A row the answer leaves out reads the document.
        assertFalse(rules.allows(ContentRules.JAVASCRIPT, "https://blocked.example/page", resolved))
        // Another site's answer is not this document's, and a page without a site reads none.
        val other = ContentRules.Resolved("https://other.example", mapOf(ContentRules.IMAGES to true))
        assertFalse(rules.allows(ContentRules.IMAGES, "https://blocked.example/page", other))
        assertTrue(rules.allows(ContentRules.IMAGES, "https://other.example/", resolved))
        assertFalse(rules.allows(ContentRules.JAVASCRIPT, "about:blank", resolved))
        assertEquals(listOf(ContentRules.SENSORS, ContentRules.PAYMENT_HANDLER), rules.blockedGuards("https://blocked.example/", resolved))
        assertEquals(listOf(ContentRules.PAYMENT_HANDLER), rules.blockedGuards("https://blocked.example/"))
        // Insecure content follows the answer too, HTTPS-only "always" or not.
        val insecure = ContentRules.Resolved("https://other.example", mapOf(ContentRules.INSECURE_CONTENT to true))
        assertEquals(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW, rules.mixedContentMode("https://other.example/", "always", insecure))
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, rules.mixedContentMode("https://blocked.example/", "always", insecure))
    }

    @Test
    fun aResolvedAnswerReadsTheCoresBooleansAndWritesItselfForThePageScript() {
        val resolved = ContentRules.Resolved.fromJson(
            "https://a.example",
            JSONObject("""{ "images": false, "javascript": true, "sensors": "no", "pdf": false }""")
        )
        assertEquals(mapOf(ContentRules.IMAGES to false, ContentRules.JAVASCRIPT to true), resolved.allowed)
        val json = resolved.toJson()
        assertEquals("https://a.example", json.getString("site"))
        assertFalse(json.getJSONObject("allowed").getBoolean("images"))
        assertTrue(json.getJSONObject("allowed").getBoolean("javascript"))
        assertFalse(json.getJSONObject("allowed").has("sensors"))
    }

    @Test
    fun resumeRefererFollowsChromesDefaultPolicy() {
        // Same origin: the page's address without its fragment; across origins: the origin alone.
        assertEquals("https://a.example/page?x=1", ContentRules.resumeReferer("https://a.example/page?x=1#frag", "https://a.example/next"))
        assertEquals("https://a.example/", ContentRules.resumeReferer("https://a.example/page?x=1", "https://b.example/"))
        assertEquals("http://a.example/", ContentRules.resumeReferer("http://a.example/page", "https://b.example/"))
        // Nothing from HTTPS down to HTTP, from a page without a web origin, or to a destination without one.
        assertNull(ContentRules.resumeReferer("https://a.example/page", "http://b.example/"))
        assertNull(ContentRules.resumeReferer(null, "https://b.example/"))
        assertNull(ContentRules.resumeReferer("zen://newtab", "https://b.example/"))
        assertNull(ContentRules.resumeReferer("file:///sdcard/page.html", "https://b.example/"))
        assertNull(ContentRules.resumeReferer("https://a.example/", "file:///sdcard/page.html"))
    }

    @Test
    fun resumeRefererFollowsThePagesOwnPolicy() {
        val page = "https://a.example/page?x=1#frag"
        val full = "https://a.example/page?x=1"
        val origin = "https://a.example/"
        val plainPage = "http://a.example/page?x=1#frag"
        val plainFull = "http://a.example/page?x=1"
        val plainOrigin = "http://a.example/"
        // policy -> (same-origin, cross-origin, https->http, http->https)
        val matrix = mapOf(
            "no-referrer" to listOf(null, null, null, null),
            "same-origin" to listOf(full, null, null, null),
            "origin" to listOf(origin, origin, origin, plainOrigin),
            "strict-origin" to listOf(origin, origin, null, plainOrigin),
            "origin-when-cross-origin" to listOf(full, origin, origin, plainOrigin),
            "strict-origin-when-cross-origin" to listOf(full, origin, null, plainOrigin),
            "no-referrer-when-downgrade" to listOf(full, full, null, plainFull),
            "unsafe-url" to listOf(full, full, full, plainFull),
            // Empty and unknown tokens are Chrome's default.
            "" to listOf(full, origin, null, plainOrigin),
            "bogus-token" to listOf(full, origin, null, plainOrigin),
        )
        for ((policy, expected) in matrix) {
            assertEquals("$policy same-origin", expected[0], ContentRules.resumeReferer(page, "https://a.example/next", policy))
            assertEquals("$policy cross-origin", expected[1], ContentRules.resumeReferer(page, "https://b.example/", policy))
            assertEquals("$policy https->http", expected[2], ContentRules.resumeReferer(page, "http://b.example/", policy))
            assertEquals("$policy http->https", expected[3], ContentRules.resumeReferer(plainPage, "https://b.example/", policy))
            // No web origin on either side: nothing under any policy.
            assertNull("$policy from null", ContentRules.resumeReferer(null, "https://b.example/", policy))
            assertNull("$policy from zen://", ContentRules.resumeReferer("zen://newtab", "https://b.example/", policy))
            assertNull("$policy from about:blank", ContentRules.resumeReferer("about:blank", "https://b.example/", policy))
            assertNull("$policy from file", ContentRules.resumeReferer("file:///sdcard/page.html", "https://b.example/", policy))
            assertNull("$policy to file", ContentRules.resumeReferer(page, "file:///sdcard/page.html", policy))
            assertNull("$policy to zen://", ContentRules.resumeReferer(page, "zen://settings", policy))
        }
        // The token is matched ASCII-case-insensitively and trimmed, as the page's script hands it over.
        assertNull(ContentRules.resumeReferer(page, "https://b.example/", " No-Referrer "))
        assertEquals(full, ContentRules.resumeReferer(page, "https://b.example/", "UNSAFE-URL"))
        // "Full" strips the fragment and the credentials, never the query; the origin form is unaffected by a port.
        assertEquals(
            "https://a.example/page?x=1",
            ContentRules.resumeReferer("https://user:pw@a.example/page?x=1#frag", "https://b.example/", "unsafe-url"),
        )
        assertEquals(
            "https://a.example:8443/page",
            ContentRules.resumeReferer("https://a.example:8443/page#f", "https://a.example:8443/next", "same-origin"),
        )
        assertEquals("https://a.example:8443/", ContentRules.resumeReferer("https://a.example:8443/page", "https://b.example/", "origin"))
        // The two-argument form stays the default policy.
        assertEquals(origin, ContentRules.resumeReferer(page, "https://b.example/"))
    }
}
