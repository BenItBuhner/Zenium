package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CustomTabMinimizeTest {
    @Test
    fun theCardSaysTheTitleOverTheHost() {
        val card = CustomTabMinimize.card("  Damping - Wikipedia ", "https://www.en.wikipedia.org/wiki/Damping?x=1#y")
        assertEquals("Damping - Wikipedia", card.title)
        assertEquals("en.wikipedia.org", card.host)
    }

    @Test
    fun aPageWithoutATitleIsNamedByItsHost() {
        assertEquals(CustomTabMinimize.Card("example.org", "example.org"), CustomTabMinimize.card(null, "http://example.org:8080/"))
        assertEquals(CustomTabMinimize.Card("example.org", "example.org"), CustomTabMinimize.card("   ", "https://user:pw@example.org/a"))
        assertEquals("about:blank", CustomTabMinimize.host("about:blank"))
    }

    @Test
    fun onlyAChangeOfModeIsAnEvent() {
        assertEquals(CustomTabMinimize.Event.MINIMIZED, CustomTabMinimize.event(wasMinimized = false, isMinimized = true))
        assertEquals(CustomTabMinimize.Event.UNMINIMIZED, CustomTabMinimize.event(wasMinimized = true, isMinimized = false))
        assertNull(CustomTabMinimize.event(wasMinimized = true, isMinimized = true))
        assertNull(CustomTabMinimize.event(wasMinimized = false, isMinimized = false))
    }

    @Test
    fun theToolbarStaysGoneInAppModeAsTheCardComesAndGoes() {
        // A plain custom tab: the toolbar hides behind the card and comes back with the page.
        assertEquals(CustomTabMinimize.Visibility.INVISIBLE, CustomTabMinimize.toolbarVisibility(minimized = true, appMode = false))
        assertEquals(CustomTabMinimize.Visibility.VISIBLE, CustomTabMinimize.toolbarVisibility(minimized = false, appMode = false))
        // A Trusted Web Activity in app mode has no toolbar: a page that committed into the
        // verified scope while minimized lifts the card onto a page laid out without one.
        assertEquals(CustomTabMinimize.Visibility.GONE, CustomTabMinimize.toolbarVisibility(minimized = true, appMode = true))
        assertEquals(CustomTabMinimize.Visibility.GONE, CustomTabMinimize.toolbarVisibility(minimized = false, appMode = true))
    }
}
