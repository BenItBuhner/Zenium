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
    fun `the private choice overrides the mode in the private container only, the global block wins`() {
        // The same table as policy.test.ts's: global mode, private choice, blocked in a regular
        // container, blocked in the private one.
        val table = listOf(
            Triple("allow", "default", false to false),
            Triple("allow", "allow", false to false),
            Triple("allow", "block", false to true),
            Triple("block-private", "default", false to true),
            Triple("block-private", "allow", false to false),
            Triple("block-private", "block", false to true),
            Triple("block", "default", true to true),
            Triple("block", "allow", true to true),
            Triple("block", "block", true to true)
        )
        for ((mode, private, expected) in table) {
            val (regular, inPrivate) = expected
            val flags = PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"$mode","thirdPartyCookiesPrivate":"$private"}"""))
            val label = "$mode / $private"
            assertEquals(label, regular, flags.blocksThirdPartyCookiesIn(false))
            assertEquals(label, inPrivate, flags.blocksThirdPartyCookiesIn(true))
            assertEquals(label, !regular, flags.acceptsThirdPartyCookies("default", "https://news.example/"))
            assertEquals(label, !regular, flags.acceptsThirdPartyCookies("work", null))
            assertEquals(label, !inPrivate, flags.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://news.example/"))
            assertEquals(label, !inPrivate, flags.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, null))
        }

        // The related-sites exception spares the top site under the private block as under the mode's.
        val excepted = PrivacyFlags.parse(
            JSONObject("""{"thirdPartyCookies":"allow","thirdPartyCookiesPrivate":"block","thirdPartyCookieExceptions":["shop.example"]}""")
        )
        assertTrue(excepted.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://checkout.shop.example/"))
        assertFalse(excepted.acceptsThirdPartyCookies(PrivacyFlags.PRIVATE_CONTAINER, "https://news.example/"))
        assertTrue(excepted.acceptsThirdPartyCookies("default", "https://news.example/"))
    }

    /**
     * INC-03: the private new tab page's switch, applied to every open tab as the core pushes each
     * new policy, changes the answer of the private tabs' WebViews alone. `TabWebView` sets the
     * per-view switch only when its answer changes, so the regular tabs – whose answer this table
     * shows unmoved across every flip – have `setAcceptThirdPartyCookies` called on them not once.
     */
    @Test
    fun `the private switch moves the private views' answer alone, whatever the regular tabs show`() {
        val views = listOf(
            Triple("regular on a site", "default", "https://news.example/story"),
            Triple("regular new tab", "default", null),
            Triple("a work container's tab", "work", "https://intranet.corp/"),
            Triple("regular on an excepted site", "default", "https://shop.example/cart"),
            Triple("private on a site", PrivacyFlags.PRIVATE_CONTAINER, "https://news.example/"),
            Triple("private new tab", PrivacyFlags.PRIVATE_CONTAINER, null),
            Triple("private on an excepted site", PrivacyFlags.PRIVATE_CONTAINER, "https://checkout.shop.example/")
        )
        fun answers(mode: String, private: String): Map<String, Boolean> {
            val flags = PrivacyFlags.parse(
                JSONObject("""{"thirdPartyCookies":"$mode","thirdPartyCookiesPrivate":"$private","thirdPartyCookieExceptions":["shop.example"]}""")
            )
            return views.associate { (name, container, document) -> name to flags.acceptsThirdPartyCookies(container, document) }
        }
        for (mode in listOf("allow", "block-private")) {
            val before = answers(mode, "default")
            val blocked = answers(mode, "block")
            val allowed = answers(mode, "allow")
            val back = answers(mode, "default")
            // The regular and the work container's views: the same answer at every step, so no call.
            for (name in listOf("regular on a site", "regular new tab", "a work container's tab", "regular on an excepted site")) {
                assertTrue("$mode: $name accepts", before.getValue(name))
                assertEquals("$mode: $name under block", before[name], blocked[name])
                assertEquals("$mode: $name under allow", before[name], allowed[name])
                assertEquals("$mode: $name back to default", before[name], back[name])
            }
            // The private views follow the switch: on blocks, off allows, default follows the mode.
            assertFalse("$mode: private on a site under block", blocked.getValue("private on a site"))
            assertFalse("$mode: private new tab under block", blocked.getValue("private new tab"))
            assertTrue("$mode: private on an excepted site under block (the related-sites exception)", blocked.getValue("private on an excepted site"))
            assertTrue("$mode: private on a site under allow", allowed.getValue("private on a site"))
            assertTrue("$mode: private new tab under allow", allowed.getValue("private new tab"))
            assertEquals("$mode: private under default follows the mode", mode == "allow", back.getValue("private on a site"))
            assertEquals("$mode: the flip back restores the first answers", before, back)
        }
        // The global block leaves every view blocked whatever the switch says: no answer moves.
        assertEquals(answers("block", "default"), answers("block", "block"))
        assertEquals(answers("block", "default"), answers("block", "allow"))
        assertTrue(answers("block", "allow").filterKeys { !it.contains("excepted") }.values.none { it })
    }

    @Test
    fun `the private choice parses tolerantly, defaults to following the mode, and rides the stored copy`() {
        val d = PrivacyFlags.DEFAULT
        assertEquals("default", d.thirdPartyCookiesPrivate)
        // Absent (a core from before the field) or malformed: follow the mode, as today.
        assertEquals("default", PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"allow"}""")).thirdPartyCookiesPrivate)
        for (junk in listOf("\"sometimes\"", "\"block-private\"", "\"Block\"", "\"\"", "7", "null", "{}"))
            assertEquals(junk, "default", PrivacyFlags.parse(JSONObject("""{"thirdPartyCookiesPrivate":$junk}""")).thirdPartyCookiesPrivate)
        for (mode in listOf("default", "allow", "block"))
            assertEquals(mode, PrivacyFlags.parse(JSONObject("""{"thirdPartyCookiesPrivate":"$mode"}""")).thirdPartyCookiesPrivate)

        val pushedPrivate = PrivacyFlags.parse(
            JSONObject("""{"safeBrowsingBypassed":["evil.example"],"thirdPartyCookies":"allow","thirdPartyCookiesPrivate":"block"}""")
        )
        val stored = pushedPrivate.withoutSession()
        assertEquals("block", stored.thirdPartyCookiesPrivate)
        assertEquals("block", stored.toJson().getString("thirdPartyCookiesPrivate"))
        assertEquals("block", PrivacyFlags.parse(JSONObject(stored.toJson().toString())).thirdPartyCookiesPrivate)
        assertEquals("default", PrivacyFlags.parse(JSONObject(d.toJson().toString())).thirdPartyCookiesPrivate)
    }

    @Test
    fun `the per-site cookie policy parses from the document, is empty without one, and rides the stored copy`() {
        val flags = PrivacyFlags.parse(pushed)
        assertSame(SiteDataPolicy.EMPTY, flags.siteData)
        assertSame(SiteDataPolicy.EMPTY, PrivacyFlags.DEFAULT.siteData)
        val withSites = PrivacyFlags.parse(
            JSONObject(
                """{"thirdPartyCookies":"allow","siteData":{"blockAll":false,"allow":["Shop.example"],
                    "clearOnExit":["[*.]news.example"],"block":["tracker.example","https://[*.]ads.example"]}}"""
            )
        )
        assertEquals(listOf("shop.example"), withSites.siteData.allow)
        assertEquals(listOf("[*.]news.example"), withSites.siteData.clearOnExit)
        assertEquals(listOf("tracker.example", "https://[*.]ads.example"), withSites.siteData.block)
        assertFalse(withSites.siteData.blockAll)
        // Malformed: the empty policy, never a crash.
        assertSame(SiteDataPolicy.EMPTY, PrivacyFlags.parse(JSONObject("""{"siteData":"none"}""")).siteData)
        assertSame(SiteDataPolicy.EMPTY, PrivacyFlags.parse(JSONObject("""{"siteData":7}""")).siteData)
        // The lists are settings, not session state: the copy on disk keeps them and reads them back.
        val stored = withSites.withoutSession()
        assertEquals(withSites.siteData, stored.siteData)
        val read = PrivacyFlags.parse(JSONObject(stored.toJson().toString()))
        assertEquals(withSites.siteData, read.siteData)
        assertEquals(true, PrivacyFlags.parse(JSONObject("""{"siteData":{"blockAll":true}}""")).toJson().getJSONObject("siteData").getBoolean("blockAll"))
    }

    @Test
    fun `cookies are withheld for a never-site, never for a listed site, and by the third-party rule for the rest`() {
        val flags = PrivacyFlags.parse(
            JSONObject(
                """{"thirdPartyCookies":"block","thirdPartyCookieExceptions":["shop.example"],
                    "siteData":{"allow":["[*.]ok.example"],"clearOnExit":["s.example"],"block":["[*.]never.example"]}}"""
            )
        )
        // The never list: the document itself, a frame of it, a request from anywhere.
        assertTrue(flags.cookiesWithheld("https://never.example/", null, "default"))
        assertTrue(flags.cookiesWithheld("https://cdn.never.example/frame", "https://news.example/", "default"))
        assertTrue(flags.cookiesWithheld("https://never.example/", null, PrivacyFlags.PRIVATE_CONTAINER))
        // The allow list and the clear-on-exit list are sites that may use cookies, third party or not.
        assertFalse(flags.cookiesWithheld("https://ok.example/", null, "default"))
        assertFalse(flags.cookiesWithheld("https://ok.example/frame", "https://news.example/", "default"))
        assertFalse(flags.cookiesWithheld("https://s.example/frame", "https://news.example/", "default"))
        // Unlisted: the third-party rule – a document's own request is never third party; a
        // cross-site frame under the global block is, unless either site is excepted.
        assertFalse(flags.cookiesWithheld("https://news.example/", null, "default"))
        assertTrue(flags.cookiesWithheld("https://ads.example/frame", "https://news.example/", "default"))
        assertFalse(flags.cookiesWithheld("https://ads.example/frame", "https://shop.example/", "default"))
        assertFalse(flags.cookiesWithheld("https://shop.example/frame", "https://news.example/", "default"))
        assertFalse(flags.cookiesWithheld("https://www.news.example/frame", "https://news.example/", "default"))
        // A never-site's frame: withheld even where the top site is excepted.
        assertTrue(flags.cookiesWithheld("https://never.example/frame", "https://shop.example/", "default"))

        // Third-party cookies allowed: only the never list withholds.
        val allow = PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"allow","siteData":{"block":["never.example"]}}"""))
        assertFalse(allow.cookiesWithheld("https://ads.example/frame", "https://news.example/", "default"))
        assertTrue(allow.cookiesWithheld("https://never.example/frame", "https://news.example/", "default"))
        // `block-private`: the private container's frames only.
        val private = PrivacyFlags.parse(JSONObject("""{"thirdPartyCookies":"block-private"}"""))
        assertFalse(private.cookiesWithheld("https://ads.example/frame", "https://news.example/", "default"))
        assertTrue(private.cookiesWithheld("https://ads.example/frame", "https://news.example/", PrivacyFlags.PRIVATE_CONTAINER))
        assertFalse(private.cookiesWithheld("https://ads.example/", null, PrivacyFlags.PRIVATE_CONTAINER))
        // No policy at all: nothing withheld, fast.
        assertFalse(PrivacyFlags.DEFAULT.cookiesWithheld("https://news.example/", null, "default"))
    }

    @Test
    fun `block all cookies withholds every unlisted site's, the allow and clear-on-exit lists excepted`() {
        val all = PrivacyFlags.parse(
            JSONObject("""{"thirdPartyCookies":"allow","siteData":{"blockAll":true,"allow":["ok.example"],"clearOnExit":["[*.]s.example"]}}""")
        )
        assertTrue(all.cookiesWithheld("https://news.example/", null, "default"))
        assertTrue(all.cookiesWithheld("https://news.example/frame", "https://news.example/", "default"))
        assertTrue(all.cookiesWithheld("https://news.example/", null, PrivacyFlags.PRIVATE_CONTAINER))
        assertFalse(all.cookiesWithheld("https://ok.example/", null, "default"))
        assertFalse(all.cookiesWithheld("https://cart.s.example/", null, "default"))
        // An exact-host allow does not reach the subdomain: blocked with the rest.
        assertTrue(all.cookiesWithheld("https://www.ok.example/", null, "default"))
        // The third-party exception list is about third-party cookies, not about "block all".
        val excepted = PrivacyFlags.parse(
            JSONObject("""{"thirdPartyCookies":"block","thirdPartyCookieExceptions":["news.example"],"siteData":{"blockAll":true}}""")
        )
        assertTrue(excepted.cookiesWithheld("https://news.example/", null, "default"))
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
    fun `plaintext is allowed for non-unique hosts, which the mode never upgrades`() {
        val flags = PrivacyFlags.parse(JSONObject("""{"httpsOnly":"always"}"""))
        for (url in listOf(
            "http://localhost/", "http://dev.localhost:5173/", "http://127.0.0.1:8080/", "http://[::1]/",
            "http://10.0.0.5/", "http://192.168.0.10/status", "http://[fe80::1%25eth0]/", "http://router/",
            "http://printer.local/"
        )) assertTrue(url, flags.plaintextAllowed(url))
        assertFalse(flags.plaintextAllowed("http://example.com/"))
        assertFalse(flags.plaintextAllowed("http://8.8.8.8/"))
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
