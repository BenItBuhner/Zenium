package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The way back from a web-auth flow: any https URL on `<id>.chromiumapp.org`, as the core matches it. */
class IdentityRedirectTest {
    private val id = "abcdefghijklmnopabcdefghijklmnop"
    private val other = "ponmlkjihgfedcbaponmlkjihgfedcba"

    @Test
    fun `the host is Chrome's`() {
        assertEquals("$id.chromiumapp.org", IdentityRedirect.host(id))
    }

    @Test
    fun `matches by origin, whatever the path, query or fragment`() {
        assertTrue(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org/"))
        assertTrue(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org"))
        assertTrue(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org/cb?code=1&state=s"))
        assertTrue(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org#access_token=abc"))
        assertTrue(IdentityRedirect.isRedirectBack(id, "HTTPS://${id.uppercase()}.ChromiumApp.org/x"))
        assertTrue(IdentityRedirect.isRedirectBack(id, "https://user:pw@$id.chromiumapp.org/"))
    }

    @Test
    fun `another extension, scheme, port or a look-alike host is not the way back`() {
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://$other.chromiumapp.org/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "http://$id.chromiumapp.org/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org:8443/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://$id.chromiumapp.org.evil.test/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://evil.test/$id.chromiumapp.org/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://evil.test/?u=https://$id.chromiumapp.org/"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "https://$id.ext.zenium.invalid/_zenium/identity/cb"))
        assertFalse(IdentityRedirect.isRedirectBack(id, "not a url"))
        assertFalse(IdentityRedirect.isRedirectBack(id, ""))
    }
}
