package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The header of the auth sheet names the host the user is signing in to. */
class ExtensionAuthSheetTest {
    @Test
    fun `the host of a web URL, without credentials, port or path`() {
        assertEquals("accounts.google.com", ExtensionAuthSheet.hostOf("https://accounts.google.com/o/oauth2/v2/auth?client_id=1"))
        assertEquals("auth.test", ExtensionAuthSheet.hostOf("http://user:pw@auth.test:8443/login#x"))
        assertEquals("auth.test", ExtensionAuthSheet.hostOf("HTTPS://Auth.Test?next=1"))
        assertEquals("[::1]", ExtensionAuthSheet.hostOf("http://[::1]:8080/"))
    }

    @Test
    fun `nothing for a URL without a host`() {
        assertNull(ExtensionAuthSheet.hostOf("about:blank"))
        assertNull(ExtensionAuthSheet.hostOf("data:text/html,hi"))
        assertNull(ExtensionAuthSheet.hostOf(""))
        assertNull(ExtensionAuthSheet.hostOf("https://"))
        assertNull(ExtensionAuthSheet.hostOf("intent://scan/#Intent;scheme=zxing;end"))
    }
}
