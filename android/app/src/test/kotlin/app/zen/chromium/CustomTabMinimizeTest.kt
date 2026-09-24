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
}
