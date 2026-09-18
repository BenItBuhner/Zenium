package app.zen.chromium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinksTest {
    @Test
    fun webLinksAndZeniumPagesComeIn() {
        assertTrue(DeepLinks.accepts("https://example.com/"))
        assertTrue(DeepLinks.accepts("http://localhost:5173/"))
        assertTrue(DeepLinks.accepts("HTTPS://EXAMPLE.COM"))
        assertTrue(DeepLinks.accepts("zenium://settings"))
        assertTrue(DeepLinks.accepts("zenium://settings/privacy"))
        assertTrue(DeepLinks.accepts("Zenium://Settings/Look"))
    }

    @Test
    fun otherSchemesAndJunkStayOut() {
        assertFalse(DeepLinks.accepts(null))
        assertFalse(DeepLinks.accepts(""))
        assertFalse(DeepLinks.accepts("   "))
        assertFalse(DeepLinks.accepts("zenium:"))
        assertFalse(DeepLinks.accepts("zen://settings"))
        assertFalse(DeepLinks.accepts("file:///sdcard/Download/page.html"))
        assertFalse(DeepLinks.accepts("content://media/external/images/1"))
        assertFalse(DeepLinks.accepts("javascript:alert(1)"))
        assertFalse(DeepLinks.accepts("settings/privacy"))
        assertFalse(DeepLinks.accepts(":nothing"))
    }
}
