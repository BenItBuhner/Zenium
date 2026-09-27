package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The served new tab page's icons at the head of `TabWebView.shouldInterceptRequest` (NTP-35):
 * the branch answers on the served view alone – the view's flag follows the document it loads –
 * and, there, for the page's `zen://favicon/<hash>` requests alone; every other request goes on
 * down the chain untouched.
 */
class NewTabPageTest {
    @Test
    fun theViewServesThePageForTheServedDocumentAloneEveryOtherLoadClearsIt() {
        // `loadHtml` / `onPageStarted` set the flag from the document: the served page, with a
        // path or a query under it as well.
        assertTrue(NewTabPage.isDocument("zen://newtab"))
        assertTrue(NewTabPage.isDocument("zen://newtab/"))
        assertTrue(NewTabPage.isDocument("zen://newtab?private=1"))
        // Any other document – the blank page, a site, the core's error page, a lookalike – clears it.
        assertFalse(NewTabPage.isDocument(null))
        assertFalse(NewTabPage.isDocument(""))
        assertFalse(NewTabPage.isDocument("zen://blank"))
        assertFalse(NewTabPage.isDocument("zen://newtabs"))
        assertFalse(NewTabPage.isDocument("zen://error?url=https%3A%2F%2Fexample.org%2F"))
        assertFalse(NewTabPage.isDocument("https://example.org/"))
        assertFalse(NewTabPage.isDocument("https://newtab.example/zen://newtab"))
        assertFalse(NewTabPage.isDocument("data:text/html,zen://newtab"))
        // The hold that is the page's own (`LinkHits`) reads the same rule.
        assertTrue(LinkHits.holdIsThePages("zen://newtab"))
        assertFalse(LinkHits.holdIsThePages("zen://blank"))
    }

    @Test
    fun onTheServedViewTheIconRequestsNameTheirHashAndEveryOtherRequestPassesThroughUntouched() {
        val hash = "0123456789abcdef0123456789abcdef"
        assertEquals(hash, NewTabPage.faviconHash("zen://favicon/$hash"))
        // The page's other requests – its own document, the tiles' sites, the engine's favicon
        // over https, a data: image – are not the branch's: null, and the chain answers them.
        for (url in listOf(
            "zen://newtab",
            "zen://blank",
            "zen://favicon",
            "zen://favicons/$hash",
            "https://example.org/",
            "https://example.org/favicon.ico",
            "https://example.org/zen://favicon/$hash",
            "data:image/png;base64,iVBORw0KGgo=",
            "about:blank",
            ""
        )) assertNull(url, NewTabPage.faviconHash(url))
        // A favicon address with no hash or a malformed one is the page's own request for an icon
        // that cannot exist: named, and refused 404 by the store's own check on the name
        // (`BootHandoffTest`: "a favicon that is not there, not a hash, or not an image is 404").
        assertEquals("", NewTabPage.faviconHash("zen://favicon/"))
        assertEquals("../secrets", NewTabPage.faviconHash("zen://favicon/../secrets"))
    }
}
