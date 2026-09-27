package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Auth Tab's pure decisions (CCT-13), against Chrome's `AuthTabIntentDataProvider` / `AuthTabVerifier`. */
class AuthTabTest {
    // --- the intent reader ---------------------------------------------------------------------------

    @Test
    fun anOrdinaryCustomTabIsNoAuthTab() {
        // Without EXTRA_LAUNCH_AUTH_TAB the redirect extras mean nothing (Chrome's isAuthTabIntent).
        assertNull(AuthTab.redirect(launch = false, scheme = "myapp", host = null, path = null))
        assertNull(AuthTab.redirect(launch = false, scheme = null, host = "example.com", path = "/cb"))
    }

    @Test
    fun aCustomSchemeIsReadLowerCase() {
        val redirect = AuthTab.redirect(launch = true, scheme = " ZeniumTest ", host = null, path = null)!!
        assertEquals("zeniumtest", redirect.scheme)
        assertFalse(redirect.https)
    }

    @Test
    fun theBrowsersOwnSchemesAreNeverARedirect() {
        // Chrome's SUPPORTED_SCHEMES (UrlUtilities) can never be the custom scheme; nor can Zenium's own pages.
        for (scheme in listOf("https", "http", "javascript", "data", "about", "file", "zen", "zenium", "chrome-extension")) {
            assertNull("$scheme must not be a redirect", AuthTab.redirect(launch = true, scheme = scheme, host = null, path = null))
        }
        assertNull(AuthTab.redirect(launch = true, scheme = "not a scheme", host = null, path = null))
        assertNull(AuthTab.redirect(launch = true, scheme = "", host = null, path = null))
    }

    @Test
    fun anHttpsRedirectIsHostAndExactPath() {
        val redirect = AuthTab.redirect(launch = true, scheme = null, host = "Login.Example.com", path = "/oauth/callback")!!
        assertNull(redirect.scheme)
        assertTrue(redirect.https)
        assertEquals("login.example.com", redirect.host)
        assertEquals("/oauth/callback", redirect.path)
    }

    @Test
    fun anHttpsRedirectWithoutAPathIsTheRoot() {
        // Chrome's GURL("https://" + host + path) gives "/" for an empty path.
        val redirect = AuthTab.redirect(launch = true, scheme = null, host = "example.com", path = null)!!
        assertEquals("/", redirect.path)
        // A path sent without its slash still names the path, not a longer host.
        assertEquals("/cb", AuthTab.redirect(launch = true, scheme = null, host = "example.com", path = "cb")!!.path)
        assertEquals("example.com", AuthTab.redirect(launch = true, scheme = null, host = "example.com", path = "cb")!!.host)
    }

    @Test
    fun aHostThatSmugglesUserinfoOrNothingIsRefused() {
        assertNull(AuthTab.redirect(launch = true, scheme = null, host = "good@evil.com", path = "/cb"))
        assertNull(AuthTab.redirect(launch = true, scheme = null, host = "  ", path = "/cb"))
        // A custom scheme beside a broken host still stands on its own.
        val redirect = AuthTab.redirect(launch = true, scheme = "myapp", host = "not a host", path = "/cb")!!
        assertEquals("myapp", redirect.scheme)
        assertFalse(redirect.https)
    }

    // --- the matcher ----------------------------------------------------------------------------------

    private val scheme = AuthTab.redirect(launch = true, scheme = "zeniumtest", host = null, path = null)!!
    private val https = AuthTab.redirect(launch = true, scheme = null, host = "login.example.com", path = "/oauth/callback")!!

    @Test
    fun theCustomSchemeMatchesByScheme() {
        assertEquals(AuthTab.Match.SCHEME, AuthTab.match(scheme, "zeniumtest://done?code=1"))
        assertEquals(AuthTab.Match.SCHEME, AuthTab.match(scheme, "ZeniumTest:done"))
        assertNull(AuthTab.match(scheme, "zeniumtest2://done"))
        assertNull(AuthTab.match(scheme, "https://zeniumtest/done"))
        assertNull(AuthTab.match(scheme, "https://login.example.com/oauth/callback"))
    }

    @Test
    fun theHttpsRedirectMatchesHostAndExactPathWithAnyQuery() {
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com/oauth/callback"))
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com/oauth/callback?code=abc&state=1#frag"))
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "HTTPS://LOGIN.EXAMPLE.COM/oauth/callback"))
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com:443/oauth/callback"))
        // Dot segments resolve before the compare, as a canonical URL has them.
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com/oauth/x/../callback"))
        // A query with the characters a canonical URL leaves bare (an identity provider's `state`)
        // is still the redirect: only the scheme, the host and the path are read.
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com/oauth/callback?state=a|b{c}[d]^e&code=1"))
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://login.example.com/oauth/callback#a|b"))
    }

    @Test
    fun aPathPrefixOrAnotherPathIsNotTheRedirect() {
        // Chrome compares the path whole (TextUtils.equals), never as a prefix.
        assertNull(AuthTab.match(https, "https://login.example.com/oauth/callback/extra"))
        assertNull(AuthTab.match(https, "https://login.example.com/oauth/callback2"))
        assertNull(AuthTab.match(https, "https://login.example.com/oauth"))
        assertNull(AuthTab.match(https, "https://login.example.com/"))
        // The path's case counts.
        assertNull(AuthTab.match(https, "https://login.example.com/OAuth/callback"))
    }

    @Test
    fun aLookalikeHostOrHttpIsNotTheRedirect() {
        assertNull(AuthTab.match(https, "https://login.example.com.evil.net/oauth/callback"))
        assertNull(AuthTab.match(https, "https://evil-login.example.com/oauth/callback"))
        assertNull(AuthTab.match(https, "https://xn--login.example.com/oauth/callback"))
        assertNull(AuthTab.match(https, "http://login.example.com/oauth/callback"))
        assertNull(AuthTab.match(https, "zeniumtest://login.example.com/oauth/callback"))
    }

    @Test
    fun theUserinfoTrickIsNotTheRedirect() {
        // `https://login.example.com@evil.net/…` is evil.net's page: the host is what follows the @.
        assertNull(AuthTab.match(https, "https://login.example.com@evil.net/oauth/callback"))
        assertNull(AuthTab.match(https, "https://login.example.com:x@evil.net/oauth/callback"))
        assertNull(AuthTab.match(https, "https://login.example.com\\@evil.net/oauth/callback"))
        // The other way round it is the redirect host's own page, as Chrome's GURL reads it.
        assertEquals(AuthTab.Match.HTTPS, AuthTab.match(https, "https://evil.net@login.example.com/oauth/callback"))
    }

    @Test
    fun nothingMatchesWhatIsNotAUrl() {
        assertNull(AuthTab.match(https, ""))
        assertNull(AuthTab.match(https, "login.example.com/oauth/callback"))
        assertNull(AuthTab.match(scheme, "://zeniumtest"))
    }

    // --- the result -----------------------------------------------------------------------------------

    @Test
    fun aCustomSchemeReturnsOkAtOnce() {
        for (v in AuthTab.Verification.values()) assertEquals(AuthTab.RESULT_OK, AuthTab.resultCode(AuthTab.Match.SCHEME, v))
    }

    @Test
    fun anHttpsRedirectReturnsTheVerificationsOutcome() {
        assertEquals(AuthTab.RESULT_OK, AuthTab.resultCode(AuthTab.Match.HTTPS, AuthTab.Verification.VERIFIED))
        assertEquals(AuthTab.RESULT_VERIFICATION_FAILED, AuthTab.resultCode(AuthTab.Match.HTTPS, AuthTab.Verification.FAILED))
        assertEquals(AuthTab.RESULT_VERIFICATION_TIMED_OUT, AuthTab.resultCode(AuthTab.Match.HTTPS, AuthTab.Verification.TIMED_OUT))
        // The androidx codes, as the client's AuthTabIntent names them.
        assertEquals(-1, AuthTab.RESULT_OK)
        assertEquals(0, AuthTab.RESULT_CANCELED)
        assertEquals(2, AuthTab.RESULT_VERIFICATION_FAILED)
        assertEquals(3, AuthTab.RESULT_VERIFICATION_TIMED_OUT)
        assertEquals(10_000L, AuthTab.VERIFICATION_TIMEOUT_MS)
    }

    // --- the asset links statement ---------------------------------------------------------------------

    private val fingerprint = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
    private val statement = """
        [{
          "relation": ["delegate_permission/common.handle_all_urls"],
          "target": {
            "namespace": "android_app",
            "package_name": "com.example.client",
            "sha256_cert_fingerprints": ["$fingerprint"]
          }
        }]
    """.trimIndent()

    @Test
    fun theCallersStatementGrantsTheRelation() {
        assertTrue(AuthTab.statementGrants(statement, "com.example.client", listOf(fingerprint)))
        // Any case, colons or not, on either side.
        assertTrue(AuthTab.statementGrants(statement, "com.example.client", listOf(fingerprint.lowercase().replace(":", ""))))
    }

    @Test
    fun anotherPackageCertificateOrRelationGrantsNothing() {
        assertFalse(AuthTab.statementGrants(statement, "com.example.other", listOf(fingerprint)))
        assertFalse(AuthTab.statementGrants(statement, "com.example.client", listOf("AA:BB:CC")))
        assertFalse(AuthTab.statementGrants(statement, "com.example.client", emptyList()))
        val otherRelation = statement.replace("delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds")
        assertFalse(AuthTab.statementGrants(otherRelation, "com.example.client", listOf(fingerprint)))
        val web = statement.replace("android_app", "web")
        assertFalse(AuthTab.statementGrants(web, "com.example.client", listOf(fingerprint)))
    }

    @Test
    fun malformedStatementsGrantNothing() {
        assertFalse(AuthTab.statementGrants("", "com.example.client", listOf(fingerprint)))
        assertFalse(AuthTab.statementGrants("{}", "com.example.client", listOf(fingerprint)))
        assertFalse(AuthTab.statementGrants("[1, \"x\", null]", "com.example.client", listOf(fingerprint)))
        assertFalse(AuthTab.statementGrants("<html>", "com.example.client", listOf(fingerprint)))
    }

    @Test
    fun theFingerprintIsTheCertificatesSha256() {
        // SHA-256 of the empty input, as DAL files spell a fingerprint.
        assertEquals(
            "E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55",
            AuthTab.fingerprintOf(ByteArray(0))
        )
        assertEquals("https://login.example.com/.well-known/assetlinks.json", AuthTab.assetLinksUrl("login.example.com"))
    }
}
