package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateSessionTest {
    private fun regular(showing: Boolean) = PrivateSession.Page(private = false, showing = showing)
    private fun private(showing: Boolean) = PrivateSession.Page(private = true, showing = showing)

    @Test
    fun aPrivatePageOnScreenSecuresTheWindow() {
        assertTrue(PrivateSession.onScreen(listOf(private(showing = true))))
        assertTrue(PrivateSession.onScreen(listOf(regular(showing = false), private(showing = true))))
        // Two pages showing at once (a glance, a transition): the private one still counts.
        assertTrue(PrivateSession.onScreen(listOf(regular(showing = true), private(showing = true))))
    }

    @Test
    fun aRegularPageInFrontOfPrivateTabsDoesNot() {
        assertFalse(PrivateSession.onScreen(listOf(regular(showing = true), private(showing = false))))
        assertFalse(PrivateSession.onScreen(listOf(private(showing = false), regular(showing = true), private(showing = false))))
    }

    @Test
    fun theChromeOverPrivateTabsDoes() {
        // No page showing – the tab overview with private cards, the private new tab page – while a
        // private tab exists: what is on the screen is private browsing's.
        assertTrue(PrivateSession.onScreen(listOf(regular(showing = false), private(showing = false))))
        assertTrue(PrivateSession.onScreen(listOf(private(showing = false))))
    }

    @Test
    fun noPrivateTabMeansNothingToSecure() {
        assertFalse(PrivateSession.onScreen(emptyList()))
        assertFalse(PrivateSession.onScreen(listOf(regular(showing = true))))
        assertFalse(PrivateSession.onScreen(listOf(regular(showing = false), regular(showing = false))))
    }

    @Test
    fun theCardsIdentityIsChromes() {
        assertEquals("Close all private tabs", PrivateSession.TITLE)
        assertEquals("zenium.private", PrivateSession.CHANNEL_ID)
        assertEquals("app.zen.chromium.PRIVATE_CLOSE_ALL", PrivateSession.ACTION_CLOSE_ALL)
    }
}
