package app.zen.chromium

import org.junit.Assert.assertEquals
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

    @Test
    fun internalAddressesAreKnownUnderEitherScheme() {
        assertTrue(DeepLinks.namesInternal("zen://settings"))
        assertTrue(DeepLinks.namesInternal("zen://blank"))
        assertTrue(DeepLinks.namesInternal("zenium://settings/privacy"))
        assertTrue(DeepLinks.namesInternal("ZENIUM://Settings"))
        assertFalse(DeepLinks.namesInternal("https://example.com/zen://settings"))
        assertFalse(DeepLinks.namesInternal("about:blank"))
        assertFalse(DeepLinks.namesInternal("chrome://settings"))
        assertFalse(DeepLinks.namesInternal(null))
        assertFalse(DeepLinks.namesInternal(""))
    }

    /** Chrome's rule for chrome://: web content cannot navigate to the browser's own pages. */
    @Test
    fun aWebPageMayNotNavigateToAnInternalPage() {
        assertTrue(DeepLinks.refusedFromDocument("https://example.com/", "zenium://settings/privacy"))
        assertTrue(DeepLinks.refusedFromDocument("https://example.com/", "zen://settings"))
        assertTrue(DeepLinks.refusedFromDocument("http://localhost:5173/page", "ZENIUM://settings"))
        assertTrue(DeepLinks.refusedFromDocument("https://example.com/", "zen://blank"))
        // A document with no address of its own has no more right to it.
        assertTrue(DeepLinks.refusedFromDocument("about:blank", "zenium://settings"))
        assertTrue(DeepLinks.refusedFromDocument("data:text/html,<a href=zenium://settings>", "zenium://settings"))
        assertTrue(DeepLinks.refusedFromDocument(null, "zenium://settings"))
        assertTrue(DeepLinks.refusedFromDocument("", "zenium://settings"))
    }

    @Test
    fun theBrowsersOwnDocumentsMayLinkToItsPages() {
        assertFalse(DeepLinks.refusedFromDocument("zen://blank", "zenium://settings"))
        assertFalse(DeepLinks.refusedFromDocument("zen://error?code=-105&url=https%3A%2F%2Fa.test", "zen://settings/privacy"))
        assertFalse(DeepLinks.refusedFromDocument("ZEN://blank", "zenium://settings"))
    }

    @Test
    fun theAliasIsWhatAnIntentCarries() {
        assertEquals("zenium://settings/look", DeepLinks.aliasOf("zen://settings/look"))
        assertEquals("zenium://settings", DeepLinks.aliasOf("zenium://settings"))
        assertEquals("https://example.com/", DeepLinks.aliasOf("https://example.com/"))
        assertTrue(DeepLinks.accepts(DeepLinks.aliasOf("zen://settings/privacy")))
    }

    @Test
    fun navigationsElsewhereAreNotTheRefusalsConcern() {
        assertFalse(DeepLinks.refusedFromDocument("https://example.com/", "https://example.org/"))
        assertFalse(DeepLinks.refusedFromDocument("https://example.com/", "mailto:a@b.c"))
        assertFalse(DeepLinks.refusedFromDocument("https://example.com/", "about:blank"))
        assertFalse(DeepLinks.refusedFromDocument(null, "https://example.org/"))
        assertFalse(DeepLinks.refusedFromDocument("https://example.com/", null))
        assertFalse(DeepLinks.refusedFromDocument("https://example.com/", ""))
    }
}
