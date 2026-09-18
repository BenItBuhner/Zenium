package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

class ExtensionCookiesTest {
    @Test
    fun `splits the Cookie header form into pairs`() {
        assertEquals(listOf("a=1", "b=2", "c"), ExtensionCookies.splitHeader("a=1; b=2 ;c"))
        assertEquals(emptyList<String>(), ExtensionCookies.splitHeader(null))
        assertEquals(emptyList<String>(), ExtensionCookies.splitHeader("  "))
        assertEquals(listOf("a=x=y"), ExtensionCookies.splitHeader("a=x=y;"))
    }
}
