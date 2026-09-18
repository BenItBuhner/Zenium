package app.zen.chromium.privacy

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The policy the core pushes (`PrivacyFlags` in `src/shared/privacy.ts`), as the host reads and answers it. */
class PrivacyFlagsTest {
    private val pushed = JSONObject(
        """{"safeBrowsing":true,"safeBrowsingBypassed":["evil.example","phish.example"],
            "httpsOnly":"always","httpsOnlyAllowed":["Legacy.example","intranet.corp"],
            "thirdPartyCookies":"block","thirdPartyCookieExceptions":["shop.example"],
            "gpc":true,"dnt":false,"secureDnsMode":"automatic","secureDnsServers":[]}"""
    )

    @Test
    fun `parses the core's document, keeping the defaults for what is missing or malformed`() {
        val flags = PrivacyFlags.parse(pushed)
        assertTrue(flags.safeBrowsing)
        assertEquals(setOf("evil.example", "phish.example"), flags.safeBrowsingBypassed)
        assertEquals("always", flags.httpsOnly)
        assertEquals(listOf("legacy.example", "intranet.corp"), flags.httpsOnlyAllowed)
        assertEquals("block", flags.thirdPartyCookies)
        assertEquals(listOf("shop.example"), flags.thirdPartyCookieExceptions)
        assertTrue(flags.gpc)
        assertFalse(flags.dnt)

        val d = PrivacyFlags.DEFAULT
        assertSame(d, PrivacyFlags.parse(null))
        val sparse = PrivacyFlags.parse(JSONObject("""{"httpsOnly":"sometimes","thirdPartyCookies":7,"httpsOnlyAllowed":"x","gpc":"yes"}"""))
        assertEquals(d.safeBrowsing, sparse.safeBrowsing)
        assertEquals(d.httpsOnly, sparse.httpsOnly)
        assertEquals(d.thirdPartyCookies, sparse.thirdPartyCookies)
        assertTrue(sparse.httpsOnlyAllowed.isEmpty())
        assertTrue(sparse.safeBrowsingBypassed.isEmpty())
        assertEquals(d.gpc, sparse.gpc)
        // The defaults are the settings' defaults (DEFAULT_PRIVACY_SETTINGS).
        assertTrue(d.safeBrowsing)
        assertEquals("ask", d.httpsOnly)
        assertEquals("block-private", d.thirdPartyCookies)
        assertFalse(d.gpc)
        assertFalse(d.dnt)
    }

    @Test
    fun `third-party cookies follow the mode, the container and the top site's exception`() {
        val block = PrivacyFlags.parse(pushed)
        assertFalse(block.acceptsThirdPartyCookies("default", "https://news.example/story"))
        assertFalse(block.acceptsThirdPartyCookies("default", null))
        // The exception names the site the user is on, subdomains included.
        assertTrue(block.acceptsThirdPartyCookies("default", "https://shop.example/cart"))
        assertTrue(block.acceptsThirdPartyCookies("default", "https://checkout.shop.example/"))
        assertFalse(block.acceptsThirdPartyCookies("default", "https://notshop.example/"))
        assertTrue(block.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://shop.example/"))

        val private = PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"block-private"}"""))
        assertTrue(private.acceptsThirdPartyCookies("default", "https://news.example/"))
        assertTrue(private.acceptsThirdPartyCookies("work", null))
        assertFalse(private.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://news.example/"))
        assertFalse(private.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, null))

        val allow = PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"allow"}"""))
        assertTrue(allow.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://news.example/"))
    }

    @Test
    fun `plaintext is allowed when the mode is off or the site was allowed, subdomains included`() {
        val flags = PrivacyFlags.parse(pushed)
        assertTrue(flags.plaintextAllowed("http://legacy.example/"))
        assertTrue(flags.plaintextAllowed("http://www.legacy.example/page"))
        assertTrue(flags.plaintextAllowed("http://INTRANET.corp:8080/"))
        assertFalse(flags.plaintextAllowed("http://notlegacy.example/"))
        assertFalse(flags.plaintextAllowed("http://news.example/"))
        assertFalse(flags.plaintextAllowed("not a url"))
        val off = PrivacyFlags.parse(JSONObject("""{"httpsOnly":"off"}"""))
        assertTrue(off.plaintextAllowed("http://news.example/"))
        val ask = PrivacyFlags.parse(JSONObject("""{"httpsOnly":"ask","httpsOnlyAllowed":["news.example"]}"""))
        assertTrue(ask.plaintextAllowed("http://news.example/"))
        assertFalse(ask.plaintextAllowed("http://other.example/"))
    }

    @Test
    fun `Safe Browsing bypasses are keyed on the host, as the core keys them`() {
        val flags = PrivacyFlags.parse(pushed)
        assertTrue(flags.isBypassed("https://evil.example/landing?x=1"))
        assertTrue(flags.isBypassed("https://EVIL.example:443/other"))
        // Scheme and port do not matter (HTTPS-only mode's upgrade of a bypassed page must pass too).
        assertTrue(flags.isBypassed("http://evil.example/"))
        assertTrue(flags.isBypassed("http://phish.example:8080/login"))
        // A subdomain is another host.
        assertFalse(flags.isBypassed("https://sub.evil.example/"))
        assertFalse(flags.isBypassed("zen://error"))
        assertFalse(flags.isBypassed("zen://evil.example"))
        assertFalse(PrivacyFlags.DEFAULT.isBypassed("https://evil.example/"))
    }

    @Test
    fun `the signals become request headers and a navigator script, or nothing at all`() {
        assertEquals(mapOf("Sec-GPC" to "1"), PrivacyFlags.parse(pushed).signalHeaders())
        assertEquals(
            mapOf("Sec-GPC" to "1", "DNT" to "1"),
            PrivacyFlags.parse(JSONObject("""{"gpc":true,"dnt":true}""")).signalHeaders()
        )
        assertTrue(PrivacyFlags.DEFAULT.signalHeaders().isEmpty())
        assertNull(PrivacyFlags.DEFAULT.navigatorScript())

        val both = PrivacyFlags.parse(JSONObject("""{"gpc":true,"dnt":true}""")).navigatorScript()!!
        assertTrue(both.contains("d('globalPrivacyControl',true)"))
        assertTrue(both.contains("d('doNotTrack','1')"))
        assertTrue(both.contains("Object.defineProperty(Navigator.prototype"))
        val dntOnly = PrivacyFlags.parse(JSONObject("""{"dnt":true}""")).navigatorScript()!!
        assertFalse(dntOnly.contains("globalPrivacyControl"))
        assertTrue(dntOnly.contains("doNotTrack"))
    }

    @Test
    fun `the copy kept on disk leaves the session's bypasses out and reads back the same`() {
        val flags = PrivacyFlags.parse(pushed)
        val stored = flags.withoutSession()
        assertTrue(stored.safeBrowsingBypassed.isEmpty())
        assertEquals(flags.httpsOnlyAllowed, stored.httpsOnlyAllowed)
        assertEquals(flags.thirdPartyCookies, stored.thirdPartyCookies)
        val json = stored.toJson()
        assertEquals(0, json.getJSONArray("safeBrowsingBypassed").length())
        val read = PrivacyFlags.parse(JSONObject(json.toString()))
        assertEquals(stored.httpsOnly, read.httpsOnly)
        assertEquals(stored.httpsOnlyAllowed, read.httpsOnlyAllowed)
        assertEquals(stored.thirdPartyCookieExceptions, read.thirdPartyCookieExceptions)
        assertEquals(stored.gpc, read.gpc)
        assertEquals(stored.dnt, read.dnt)
        assertSame(PrivacyFlags.DEFAULT, PrivacyFlags.DEFAULT.withoutSession())
        // The full document keeps the bypasses, sorted.
        assertEquals("evil.example", flags.toJson().getJSONArray("safeBrowsingBypassed").getString(0))
    }
}
